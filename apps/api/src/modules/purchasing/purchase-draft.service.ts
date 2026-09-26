import { Inject, Injectable } from '@nestjs/common';
import { isSupportedCurrency, minorUnitsOf } from '@daftar/domain-core';
import {
  formatQuantity,
  formatUnitCost,
  normalizeDocumentText,
  purchaseCancelPayload,
  purchaseDraftPayload,
  type MovementPayload,
  type PurchaseDraftLandedCost,
  type PurchaseDraftLine,
} from '@daftar/inventory';
import type { PurchaseCommandResultDto } from '@daftar/shared-contracts';
import { Database, type TransactionSql } from '../../infra/database';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import { assertMovableVariant, readWarehouses, resolveVariants, type ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findPurchaseHeader, findSupplier, readPurchase } from './purchasing-reads';
import type { PurchaseDraftRequest, PurchaseTransitionRequest } from './purchasing.schemas';

// ── Exact request amounts (A-19) ─────────────────────────────────────────

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Decimal text as `units × 10^scale` for a fixed `scale`, or null when it carries a non-zero digit beyond it. */
function scaled(text: string, scale: number): bigint | null {
  const m = DECIMAL_RE.exec(text);
  if (m === null) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null;
  return BigInt(`${m[1] ?? '0'}${fraction.slice(0, scale).padEnd(scale, '0')}`);
}

/** A money amount in MAJOR units as txn minor units; not exact at the currency's minor units → `purchase.amount_precision_invalid`. */
export function moneyMinor(text: string, minorUnits: number): bigint {
  const v = scaled(text, minorUnits);
  if (v === null) throw purchasingRefusal('purchase.amount_precision_invalid');
  return v;
}

/** A unit price in MAJOR units as C10 of a txn MINOR unit (A-09): `price × 10^(e + 10)`, always exact for ≤ 10 fraction digits. */
export function unitPriceC10(text: string, minorUnits: number): bigint {
  const v = scaled(text, minorUnits + 10);
  if (v === null) throw purchasingRefusal('purchase.amount_precision_invalid');
  return v;
}

/** A quantity as Q4; the grammar already bounds it to four fraction digits. */
function quantityQ4(text: string): bigint {
  const v = scaled(text, 4);
  if (v === null) throw purchasingRefusal('purchase.amount_precision_invalid');
  return v;
}

/**
 * A manual landed cost's allocations in LINE order (A-13 step 3). Every line
 * of the request must be named exactly once and no other line may be:
 * a missing, repeated or foreign line is `purchase.landed_cost_invalid`.
 */
function allocationsInLineOrder(allocations: readonly { lineId: string; amount: string }[], lineIds: readonly string[], minorUnits: number): bigint[] {
  const byLine = new Map<string, bigint>();
  for (const a of allocations) {
    if (byLine.has(a.lineId) || !lineIds.includes(a.lineId)) throw purchasingRefusal('purchase.landed_cost_invalid');
    byLine.set(a.lineId, moneyMinor(a.amount, minorUnits));
  }
  return lineIds.map((id) => {
    const v = byLine.get(id);
    if (v === undefined) throw purchasingRefusal('purchase.landed_cost_invalid');
    return v;
  });
}

/**
 * `PUT /v1/purchases/:purchaseId` and `POST …/cancel` (PHASE_3_S4_CONTRACT
 * A-03, A-04, A-08 – A-13).
 *
 * A draft moves no stock and posts nothing (L:737), so both commands run on
 * seam 1. The flow is A-10(c):
 *
 * 1. the stored header — a document read, needed because the scope check
 *    covers the draft's warehouse and, when a replace moves the draft, its
 *    previous one;
 * 2. the permission and that warehouse scope;
 * 3. identity (variant resolution) and the exact amounts;
 * 4. the payload and its intent digest, then the idempotency proof against
 *    the stored revision and intent — BEFORE any state read;
 * 5. current state (supplier active, warehouse active, variants movable);
 * 6. the `invctl/1` assertion over the payload, the routine, and the answer
 *    read back from stored rows.
 *
 * A-13 steps 1–5 run in `@daftar/inventory` while the payload is built, so a
 * draft the routine would refuse (a discount above the gross, a landed-cost
 * denominator of zero, a manual split off by one minor unit, a zero total) is
 * refused here with the same code, before anything is signed.
 */
@Injectable()
export class PurchaseDraftService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  async saveDraft(m: MembershipContext, purchaseId: string, input: PurchaseDraftRequest, btx: BusinessTransactionId): Promise<PurchaseCommandResultDto> {
    try {
      // 1–2. The stored header, then authority over every affected warehouse.
      const existing = await findPurchaseHeader(this.db, m, purchaseId);
      const previousWarehouseId =
        existing !== null && existing.status === 'draft' && existing.warehouse_id !== input.warehouseId ? existing.warehouse_id : null;
      const authority = await this.authorization.authorize(
        m,
        'purchase.draft',
        btx,
        previousWarehouseId === null ? [input.warehouseId] : [input.warehouseId, previousWarehouseId],
      );

      // 3. Currency, identity and the exact amounts.
      if (!isSupportedCurrency(input.currency)) throw purchasingRefusal('purchase.currency_unknown');
      const minorUnits = minorUnitsOf(input.currency);
      const taxMinor = moneyMinor(input.taxAmount, minorUnits);
      // BLOCKED BY OD-03 (A-12): the pipe refused this already; it is refused
      // again here so no path can sign a non-zero tax.
      if (taxMinor !== 0n) throw purchasingRefusal('purchase.tax_policy_absent');
      const variants = await resolveVariants(this.db, m, input.lines);
      if (new Set(variants.map((v) => v.variantId)).size !== variants.length) throw purchasingRefusal('purchase.duplicate_variant');
      const lineIds = input.lines.map((l) => l.lineId);
      const lines: PurchaseDraftLine[] = input.lines.map((l, i) => ({
        lineId: l.lineId,
        variantId: variants[i]?.variantId ?? '',
        qtyQ4: quantityQ4(l.quantity),
        unitPriceC10: unitPriceC10(l.unitPrice, minorUnits),
        discountMinor: moneyMinor(l.discount ?? '0', minorUnits),
      }));
      const landedCosts: PurchaseDraftLandedCost[] = input.landedCosts.map((c) => ({
        landedCostId: c.landedCostId,
        mode: c.mode,
        amountMinor: moneyMinor(c.amount, minorUnits),
        description: normalizeDocumentText(c.description),
        allocations: c.mode === 'manual' ? allocationsInLineOrder(c.allocations, lineIds, minorUnits) : null,
      }));
      const supplierReference = normalizeDocumentText(input.supplierReference);
      const notes = normalizeDocumentText(input.notes);

      // 4. The payload (A-13 steps 1–5 inside), then the idempotency proof.
      const built = purchaseDraftPayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        purchaseId,
        expectedRevision: input.expectedRevision,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        previousWarehouseId,
        currency: input.currency,
        documentDate: input.documentDate,
        supplierReference,
        notes,
        taxMinor,
        lines,
        landedCosts,
      });
      if (existing !== null) {
        if (existing.revision === input.expectedRevision + 1 && existing.draft_intent_sha256 === built.intentSha256) {
          return await this.answer(m, purchaseId, true);
        }
        if (existing.status !== 'draft') throw purchasingRefusal('purchase.state_invalid');
        if (input.expectedRevision === 0) throw purchasingRefusal('purchase.idempotency_conflict');
        if (existing.revision !== input.expectedRevision) throw purchasingRefusal('purchase.draft_changed');
      } else if (input.expectedRevision !== 0) {
        throw purchasingRefusal('purchase.not_found');
      }

      // 5. Current state, only after the proof.
      const supplier = await findSupplier(this.db, m, input.supplierId);
      if (supplier === null) throw purchasingRefusal('supplier.not_found');
      if (supplier.status !== 'active') throw purchasingRefusal('purchase.supplier_inactive');
      await readWarehouses(this.db, m, [input.warehouseId], [input.warehouseId]);
      variants.forEach((v, i) => assertMovableVariant(v, lines[i]?.qtyQ4 ?? null, true));

      // 6. Mint, the routine on seam 1, the stored answer.
      return await this.execute(authority, built, purchaseId, (sql) =>
        sql.query<{ replayed: boolean }>(
          `SELECT replayed FROM purchase_save_draft(
             $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid, $6::char(3), $7::date, $8::text, $9::text, $10::bigint,
             $11::uuid[], $12::uuid[], $13::numeric[], $14::numeric[], $15::bigint[],
             $16::uuid[], $17::text[], $18::bigint[], $19::text[], $20::bigint[])`,
          [
            purchaseId,
            input.expectedRevision,
            input.supplierId,
            input.warehouseId,
            previousWarehouseId,
            input.currency,
            input.documentDate,
            supplierReference,
            notes,
            taxMinor.toString(10),
            lines.map((l) => l.lineId),
            lines.map((l) => l.variantId),
            lines.map((l) => formatQuantity(l.qtyQ4)),
            lines.map((l) => formatUnitCost(l.unitPriceC10)),
            lines.map((l) => l.discountMinor.toString(10)),
            landedCosts.map((c) => c.landedCostId),
            landedCosts.map((c) => c.mode),
            landedCosts.map((c) => c.amountMinor.toString(10)),
            landedCosts.map((c) => c.description),
            // landed_count × line_count, row-major; a by_value cost's row is NULLs (§2.4).
            landedCosts.flatMap((c) => (c.allocations === null ? lines.map(() => null) : c.allocations.map((a) => a.toString(10)))),
          ],
        ),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  async cancel(m: MembershipContext, purchaseId: string, input: PurchaseTransitionRequest, btx: BusinessTransactionId): Promise<PurchaseCommandResultDto> {
    try {
      const existing = await findPurchaseHeader(this.db, m, purchaseId);
      if (existing === null) throw purchasingRefusal('purchase.not_found');
      const authority = await this.authorization.authorize(m, 'purchase.cancel', btx, [existing.warehouse_id]);
      const built = purchaseCancelPayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        purchaseId,
        warehouseId: existing.warehouse_id,
        draftRevision: input.draftRevision,
      });
      if (existing.status === 'cancelled' && existing.cancel_intent_sha256 === built.intentSha256) return await this.answer(m, purchaseId, true);
      if (existing.status !== 'draft') throw purchasingRefusal('purchase.state_invalid');
      if (existing.revision !== input.draftRevision) throw purchasingRefusal('purchase.draft_changed');

      return await this.execute(authority, built, purchaseId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM purchase_cancel($1::uuid, $2::uuid, $3::integer)`, [
          purchaseId,
          existing.warehouse_id,
          input.draftRevision,
        ]),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async execute(
    authority: InventoryCommandAuthority,
    built: MovementPayload,
    purchaseId: string,
    call: (sql: TransactionSql) => Promise<{ readonly rows: readonly { replayed: boolean }[] }>,
  ): Promise<PurchaseCommandResultDto> {
    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const [row] = (await call(tx)).rows;
      if (row === undefined) throw new Error('a purchase routine returned no row');
      return row.replayed;
    });
    return this.answer(authority.scope, purchaseId, replayed);
  }

  private async answer(scope: ReadScope, purchaseId: string, replayed: boolean): Promise<PurchaseCommandResultDto> {
    const stored = await readPurchase(this.db, scope, purchaseId);
    if (stored === null) throw new Error('a purchase the routine wrote is not readable');
    return { ...stored.dto, replayed, businessTransactionId: stored.header.business_transaction_id };
  }
}
