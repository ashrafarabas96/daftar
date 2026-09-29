import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AccountingError, convertToBaseMinor, mintDomainPostingAssertion, parseDatabaseAccountingError, type PostingCommand } from '@daftar/accounting';
import {
  assertQuantityRepresentable,
  baseShares,
  DOMESTIC_RATE_R10,
  formatQuantity,
  InventoryError,
  lineTotals,
  parseDecimal,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  planCoverage,
  purchaseReceiveIntentSha256,
  purchaseReceivePayload,
  type DeficitLayer,
  type LandedCostInput,
  type MovementPayload,
  type StockState,
} from '@daftar/inventory';
import type { PurchaseReceiptDto } from '@daftar/shared-contracts';
import { Database, presentInventoryAssertion, type AccountingAssertions, type BusinessInventoryAccountingTransaction } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import { readWarehouses, type ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { catchUpPostingCommand, purchasePostingCommand, type ReceiptFx } from './purchase-posting';
import { purchasingInventoryRefusal, purchasingPackageRefusal, purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findPurchaseHeader, findSupplier, readLandedCosts, readPurchaseLines, readReceipt, scopedRows, type PurchaseLineRow } from './purchasing-reads';
import type { PurchaseTransitionRequest } from './purchasing.schemas';

/** `NUMERIC(20,10)` text of a rate of exactly 1: the domestic snapshot (A-17). */
const DOMESTIC_RATE_TEXT = '1.0000000000';

/** The FX snapshot the receipt binds (A-17), in both the payload's and the posting's forms. */
export interface BoundFx extends ReceiptFx {
  readonly rateId: string | null;
  readonly rateR10: bigint;
}

/** One `stock_levels` row of the coverage read, numerics as text (A-16). */
interface CoverageLevelRow {
  variant_id: string;
  on_hand: string;
  valuation: string;
  avg: string | null;
  last_stock_seq: string;
}

/** One open deficit layer of the coverage read, numerics as text (A-16(b)). */
interface CoverageLayerRow {
  id: string;
  variant_id: string;
  deficit_seq: string;
  uncovered_qty: string;
  provisional: string;
}

/** A signed `NUMERIC(28,10)` average cost as C10 (the `stock_levels` reading of `inventory-stock-read`). */
function parseSignedC10(text: string): bigint {
  const d = parseDecimal(text);
  if (d.scale > 10) throw new Error('an average cost carries more than ten decimals');
  return d.units * 10n ** BigInt(10 - d.scale);
}

/** The facts of a stored line's variant that a receipt re-checks (A-19 archive rules). */
interface VariantFacts {
  variant_id: string;
  product_status: string;
  variant_status: string;
  track_inventory: boolean;
  unit_decimals: number | null;
}

/**
 * A receipt with every value the database will store computed and bound, and
 * its commands built — everything `execute` needs, before anything is minted
 * (PHASE_3_S6_CONTRACT A-19: the combined receive-and-pay binds the payment
 * half's `T`, `B` and `R` from this without a second read).
 */
export interface ReceiptPlan {
  readonly authority: InventoryCommandAuthority;
  readonly purchaseId: string;
  readonly warehouseId: string;
  /** The warehouse's branch: the dimension of the receipt's lines. */
  readonly branchId: string | null;
  readonly supplierId: string;
  readonly documentDate: string;
  /** The purchase currency, as stored on the draft. */
  readonly currency: string;
  readonly baseCurrency: string;
  readonly fx: BoundFx;
  /** `T`. */
  readonly totalTxnMinor: bigint;
  /** `B = convertToBaseMinor(T)`. */
  readonly totalBaseMinor: bigint;
  readonly built: MovementPayload;
  readonly purchaseCommand: PostingCommand;
  /** The catch-up entry iff the bound N ≠ 0. */
  readonly catchUpCommand: PostingCommand | null;
  /** The `purchase_receive` arguments, in its signature's order. */
  readonly params: readonly unknown[];
}

/**
 * What `plan` found: a received purchase whose receive intent equals this
 * request's (the idempotent replay, answered from stored rows), or a draft's
 * bound receipt.
 */
export type ReceiptPlanOutcome =
  | {
      readonly kind: 'replay';
      readonly authority: InventoryCommandAuthority;
      readonly warehouseId: string;
      readonly supplierId: string;
      readonly documentDate: string;
      readonly currency: string;
    }
  | { readonly kind: 'plan'; readonly plan: ReceiptPlan };

const PURCHASE_RECEIVE_SQL = `SELECT replayed FROM purchase_receive(
   $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::integer, $6::date, $7::char(3), $8::uuid, $9::numeric, $10::text,
   $11::timestamptz, $12::bigint, $13::bigint, $14::uuid, $15::uuid[], $16::uuid[], $17::numeric[], $18::bigint[],
   $19::numeric[], $20::bigint[])`;

/**
 * `POST /v1/purchases/:purchaseId/receive` (PHASE_3_S4_CONTRACT A-05 – A-10,
 * A-13, A-16, A-17; R-B1).
 *
 * The flow is A-10(c) with the A-07 binding:
 *
 * 1. the stored header (a document read: its warehouse is the scope);
 * 2. the permission and the warehouse's scope;
 * 3. the receive intent digest (`purchase_id`, `warehouse_id`,
 *    `draft_revision` only) and the idempotency proof — a received purchase
 *    with the same intent answers its stored receipt, BEFORE any state read;
 * 4. current state: the draft's lines and landed costs, the supplier, the
 *    business's base currency, timezone and today, the warehouse, the
 *    variants, the FX snapshot (A-17), the stock levels and the open deficit
 *    layers of the receipt's keys;
 * 5. every amount the database will store, computed and BOUND: A-13 from the
 *    stored draft, `B = convertToBaseMinor(T)` (the 0043 law, here and not in
 *    the package), the base shares, and the coverage plan (A-16) — a fresh
 *    coverage header id is minted here iff anything is covered;
 * 6. the `invctl/1` assertion over the receipt payload and one accounting
 *    assertion per posting: `purchase` always (T > 0), the catch-up iff the
 *    bound N ≠ 0 — all minted BEFORE seam 2 opens;
 * 7. seam 2 with the ordered assertions: the routine, then — unless the
 *    routine answered a replay — the `purchase` entry and the catch-up entry,
 *    each presented its own assertion, then COMMIT.
 *
 * The receipt is optimistic: if the draft, the supplier, the rate, the stock
 * or a deficit layer moved between the reads and the routine's locks, the
 * routine refuses with its typed 409 and nothing commits. There is no server
 * retry (S3 TL-5).
 *
 * Steps 1–5 are `plan` and step 7's routine and postings are `execute`
 * (PHASE_3_S6_CONTRACT A-19), so the combined receive-and-pay reuses both
 * unchanged; `receive` is exactly `plan` → mint → seam → `execute`.
 */
@Injectable()
export class PurchaseReceiptService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async receive(m: MembershipContext, purchaseId: string, input: PurchaseTransitionRequest, btx: BusinessTransactionId): Promise<PurchaseReceiptDto> {
    try {
      return await this.run(m, purchaseId, input, btx);
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  private async run(m: MembershipContext, purchaseId: string, input: PurchaseTransitionRequest, btx: BusinessTransactionId): Promise<PurchaseReceiptDto> {
    const outcome = await this.plan(m, purchaseId, input, btx);
    if (outcome.kind === 'replay') return readReceipt(this.db, m, purchaseId, true);
    const plan = outcome.plan;

    // 6. Mint everything before the seam opens (A-07, A-08).
    const inventoryAssertion = this.authorization.mint(plan.authority, plan.built.payload);
    const purchaseAssertion = mintDomainPostingAssertion(this.accountingMinter, plan.purchaseCommand, m.userId);
    const accountingAssertions: AccountingAssertions =
      plan.catchUpCommand === null
        ? [purchaseAssertion]
        : [purchaseAssertion, mintDomainPostingAssertion(this.accountingMinter, plan.catchUpCommand, m.userId)];

    // 7. One transaction: the routine, the purchase entry, the catch-up entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(plan.authority.scope, inventoryAssertion, accountingAssertions, (tx) =>
      this.execute(tx, plan),
    );
    return readReceipt(this.db, m, purchaseId, replayed);
  }

  /**
   * Steps 1–5: the document, authority over its warehouse, the idempotency
   * proof, current state, and every amount bound, with the commands built.
   * It opens no transaction and mints nothing.
   */
  async plan(m: MembershipContext, purchaseId: string, input: PurchaseTransitionRequest, btx: BusinessTransactionId): Promise<ReceiptPlanOutcome> {
    // 1–2. The document, then authority over its warehouse.
    const header = await findPurchaseHeader(this.db, m, purchaseId);
    if (header === null) throw purchasingRefusal('purchase.not_found');
    const warehouseId = header.warehouse_id;
    const authority = await this.authorization.authorize(m, 'purchase.receive', btx, [warehouseId]);

    // 3. The idempotency proof, before any state read.
    const intentSha256 = purchaseReceiveIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      purchaseId,
      warehouseId,
      draftRevision: input.draftRevision,
    });
    if (header.status === 'received') {
      if (header.receive_intent_sha256 === intentSha256) {
        return { kind: 'replay', authority, warehouseId, supplierId: header.supplier_id, documentDate: header.document_date, currency: header.currency_code };
      }
      throw purchasingRefusal('purchase.state_invalid');
    }
    if (header.status !== 'draft') throw purchasingRefusal('purchase.state_invalid');
    if (header.revision !== input.draftRevision) throw purchasingRefusal('purchase.draft_changed');

    // 4. Current state.
    const lines = await readPurchaseLines(this.db, m, purchaseId);
    if (lines.length === 0) throw purchasingRefusal('purchase.lines_required');
    const landed = await readLandedCosts(this.db, m, purchaseId, lines);
    const supplier = await findSupplier(this.db, m, header.supplier_id);
    if (supplier === null) throw new Error("a draft's supplier is not readable");
    if (supplier.status !== 'active') throw purchasingRefusal('purchase.supplier_inactive');
    const business = await this.readBusiness(m, header.document_date);
    if (business.documentDateInFuture) throw purchasingRefusal('purchase.document_date_in_future');
    const warehouse = (await readWarehouses(this.db, m, [warehouseId], [warehouseId])).get(warehouseId);
    if (warehouse === undefined) throw new Error('the warehouse was not read');
    await this.assertReceivable(m, lines);

    // 5. A-13 from the stored draft, then the one conversion and the shares.
    const qtys = lines.map((l) => parseQuantity(l.qty));
    const totals = lineTotals(
      lines.map((l, i) => ({ qtyQ4: qtys[i] ?? 0n, unitPriceC10: parseUnitCost(l.unit_price_txn_minor), discountMinor: parseMinor(l.discount_txn_minor) })),
      landed.map(
        (c): LandedCostInput => ({
          mode: c.mode,
          amountMinor: parseMinor(c.amount_txn_minor),
          allocations: c.mode === 'manual' ? c.allocations.map(parseMinor) : null,
        }),
      ),
      parseMinor(header.tax_minor),
    );
    if (
      totals.totalMinor.toString(10) !== header.total_txn_minor ||
      totals.lines.some((t, i) => t.netMinor.toString(10) !== lines[i]?.net_txn_minor || t.landedMinor.toString(10) !== lines[i]?.landed_cost_txn_minor)
    ) {
      throw new Error('a stored draft does not satisfy its own purchase arithmetic');
    }
    const fx = await this.readFx(m, header.currency_code, business.baseCurrency, header.document_date);
    const totalBaseMinor =
      fx.source === 'base'
        ? totals.totalMinor
        : convertToBaseMinor({ txnAmountMinor: totals.totalMinor, txnCurrency: header.currency_code, baseCurrency: business.baseCurrency, fxRate: fx.rate });
    const shares = baseShares(
      totalBaseMinor,
      totals.lines.map((t) => t.totalMinor),
    );

    // The coverage plan over the stock levels and the open layers, read in ONE
    // statement so both come from one snapshot (A-16; review L3).
    const coverageState = await this.readCoverageState(m, warehouseId, lines);
    const plan = planCoverage(
      coverageState.layers,
      coverageState.keyStates,
      lines.map((l, i) => ({ lineId: l.id, variantId: l.variant_id, qtyQ4: qtys[i] ?? 0n, baseShareMinor: shares[i] ?? 0n })),
    );
    const coverageAdjustmentId = plan.coveredQ4 > 0n ? randomUUID() : null;

    const built = purchaseReceivePayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      purchaseId,
      warehouseId,
      draftRevision: input.draftRevision,
      supplierId: supplier.id,
      supplierRevision: supplier.revision,
      documentDate: header.document_date,
      currency: header.currency_code,
      rate: { rateId: fx.rateId, rateR10: fx.rateR10, source: fx.source, rateAtEpochSeconds: BigInt(fx.at.getTime() / 1000) },
      totalTxnMinor: totals.totalMinor,
      totalBaseMinor,
      coverageAdjustmentId,
      lines: plan.lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId,
        qtyQ4: l.qtyQ4,
        baseShareMinor: l.baseShareMinor,
        coveredQ4: l.coveredQ4,
        catchUpMinor: l.catchUpMinor,
      })),
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound receipt payload does not carry the proven intent');

    const postingBase = { tenantId: m.tenantId, businessId: m.businessId, documentDate: header.document_date, businessTransactionId: btx };
    const purchaseCommand = purchasePostingCommand({
      ...postingBase,
      purchaseId,
      currency: header.currency_code,
      baseCurrency: business.baseCurrency,
      totalTxnMinor: totals.totalMinor,
      totalBaseMinor,
      fx,
      warehouseId,
      branchId: warehouse.branchId,
    });
    const catchUpCommand =
      coverageAdjustmentId === null
        ? null
        : catchUpPostingCommand({
            ...postingBase,
            adjustmentId: coverageAdjustmentId,
            baseCurrency: business.baseCurrency,
            warehouseId,
            branchId: warehouse.branchId,
            netValueMinor: plan.totalValueMinor,
          });
    const params: unknown[] = [
      purchaseId,
      warehouseId,
      input.draftRevision,
      supplier.id,
      supplier.revision,
      header.document_date,
      header.currency_code,
      fx.rateId,
      fx.rate,
      fx.source,
      `${fx.at.toISOString().slice(0, 19)}Z`,
      totals.totalMinor.toString(10),
      totalBaseMinor.toString(10),
      coverageAdjustmentId,
      plan.lines.map((l) => l.lineId),
      plan.lines.map((l) => l.variantId),
      plan.lines.map((l) => formatQuantity(l.qtyQ4)),
      plan.lines.map((l) => l.baseShareMinor.toString(10)),
      plan.lines.map((l) => formatQuantity(l.coveredQ4)),
      plan.lines.map((l) => l.catchUpMinor.toString(10)),
    ];
    return {
      kind: 'plan',
      plan: {
        authority,
        purchaseId,
        warehouseId,
        branchId: warehouse.branchId,
        supplierId: supplier.id,
        documentDate: header.document_date,
        currency: header.currency_code,
        baseCurrency: business.baseCurrency,
        fx,
        totalTxnMinor: totals.totalMinor,
        totalBaseMinor,
        built,
        purchaseCommand,
        catchUpCommand,
        params,
      },
    };
  }

  /**
   * Step 7 on an open seam-2 transaction: present the `purchase.receive`
   * assertion (a no-op check on the single-assertion seam, the next element
   * of a sequence otherwise), run `purchase_receive`, and — unless the
   * routine answered a replay — post the `purchase` entry and the catch-up
   * entry, each presented its own accounting assertion by the adapter.
   * Returns whether the routine answered a replay.
   */
  async execute(tx: BusinessInventoryAccountingTransaction, plan: ReceiptPlan): Promise<boolean> {
    await presentInventoryAssertion(tx, 'purchase.receive');
    const r = await tx.query<{ replayed: boolean }>(PURCHASE_RECEIVE_SQL, [...plan.params]);
    const [first] = r.rows;
    if (first === undefined) throw new Error('purchase_receive returned no row');
    // A replay inside the routine (a concurrent identical receipt won the
    // key) commits no entry; its minted assertions expire unused (A-08).
    if (first.replayed) return true;
    await this.posting.postEntryInTransaction(tx.accounting, { command: plan.purchaseCommand });
    if (plan.catchUpCommand !== null) await this.posting.postEntryInTransaction(tx.accounting, { command: plan.catchUpCommand });
    return false;
  }

  /** The business's base currency, and whether the document date is after today in its timezone (0058 rule, early). */
  private async readBusiness(scope: ReadScope, documentDate: string): Promise<{ readonly baseCurrency: string; readonly documentDateInFuture: boolean }> {
    const [row] = await scopedRows<{ base_currency: string; future: boolean }>(
      this.db,
      scope,
      `SELECT b.base_currency, ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future FROM businesses b WHERE b.id = $1`,
      [scope.businessId, documentDate],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return { baseCurrency: row.base_currency, documentDateInFuture: row.future };
  }

  /**
   * The FX snapshot (A-17). Domestic: `(NULL, 1, 'base', <date>T00:00:00Z)`,
   * and the registry is never consulted. Foreign: the registry row
   * `accounting_fx_rate_lookup` returns for `(currency → base)` at the last
   * second of the document date in the business's timezone — computed in SQL
   * from the date alone, no `now()`, so the routine derives the same instant.
   */
  private async readFx(scope: ReadScope, currency: string, baseCurrency: string, documentDate: string): Promise<BoundFx> {
    if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
      return { rateId: null, rate: DOMESTIC_RATE_TEXT, rateR10: DOMESTIC_RATE_R10, source: 'base', at: new Date(`${documentDate}T00:00:00Z`) };
    }
    let row: { rate_id: string; rate: string; source: string; effective_at: Date } | undefined;
    try {
      [row] = await scopedRows<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
        this.db,
        scope,
        `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
           FROM businesses b
          CROSS JOIN LATERAL accounting_fx_rate_lookup(
                  b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
          WHERE b.id = $1`,
        [scope.businessId, currency, documentDate],
      );
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === 'accounting.fx_rate_missing') throw purchasingRefusal('purchase.fx_rate_missing');
      if (code === 'accounting.fx_currency_unknown') throw purchasingRefusal('purchase.currency_unknown');
      if (code !== null) throw new AccountingError(code, 'the accounting authority refused this rate lookup', { businessId: scope.businessId });
      throw e;
    }
    if (row === undefined) throw new Error('the FX rate lookup returned no row');
    if (row.source !== 'manual' && row.source !== 'base') throw new Error('a registry rate has a source a purchase cannot snapshot');
    if (row.effective_at.getTime() % 1000 !== 0) throw new Error('a registry rate instant is not at second precision');
    return { rateId: row.rate_id, rate: row.rate, rateR10: parseUnitCost(row.rate), source: row.source, at: row.effective_at };
  }

  /**
   * The A-19 re-checks of stock coming IN, on the stored lines: the product is
   * tracked, neither it nor the variant is archived, and the quantity is exact
   * at the unit's precision. The routine re-checks all of it under its locks.
   */
  private async assertReceivable(scope: ReadScope, lines: readonly PurchaseLineRow[]): Promise<void> {
    const facts = await scopedRows<VariantFacts>(
      this.db,
      scope,
      `SELECT v.id AS variant_id, p.status AS product_status, v.status AS variant_status, p.track_inventory, p.unit_decimals
         FROM product_variants v
         JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
        WHERE v.business_id = $1 AND v.id = ANY($2::uuid[])`,
      [scope.businessId, lines.map((l) => l.variant_id)],
    );
    const byVariant = new Map(facts.map((f) => [f.variant_id, f]));
    for (const l of lines) {
      const f = byVariant.get(l.variant_id);
      if (f === undefined) throw purchasingInventoryRefusal('inventory.variant_not_found');
      if (!f.track_inventory || f.unit_decimals === null) throw purchasingInventoryRefusal('inventory.product_not_tracked');
      if (f.product_status !== 'active') throw purchasingInventoryRefusal('inventory.product_archived');
      if (f.variant_status !== 'active') throw purchasingInventoryRefusal('inventory.variant_archived');
      try {
        assertQuantityRepresentable(parseQuantity(l.qty), f.unit_decimals);
      } catch (e) {
        if (e instanceof InventoryError) throw purchasingPackageRefusal(e);
        throw e;
      }
    }
  }

  /**
   * The `stock_levels` state and the open and partially covered deficit layers
   * of the receipt's keys (A-16(b), read by `daftar_app`, A-18), in ONE
   * statement: under READ COMMITTED a statement reads one snapshot, so the
   * plan's `Σ uncovered = max(0, −on_hand)` precondition sees the levels and
   * the layers of the same committed state. Two reads could straddle another
   * receipt's COMMIT and turn a legitimate race into the defect code
   * `inventory.deficit_state_invalid` (review L3). A change after this read is
   * the routine's to refuse, under its locks, as `inventory.valuation_changed`
   * — retryable by the client; there is no server retry (TL-5).
   *
   * A key with no `stock_levels` row is the empty state, as `planCoverage`
   * reads a missing entry.
   */
  private async readCoverageState(
    scope: ReadScope,
    warehouseId: string,
    lines: readonly PurchaseLineRow[],
  ): Promise<{ readonly keyStates: ReadonlyMap<string, StockState>; readonly layers: readonly DeficitLayer[] }> {
    const [row] = await scopedRows<{ levels: CoverageLevelRow[]; layers: CoverageLayerRow[] }>(
      this.db,
      scope,
      `SELECT
         (SELECT coalesce(json_agg(json_build_object(
                   'variant_id', s.variant_id, 'on_hand', s.on_hand::text, 'valuation', s.valuation_base_minor::text,
                   'avg', s.avg_unit_cost_base_minor::text, 'last_stock_seq', s.last_stock_seq::text)), '[]'::json)
            FROM stock_levels s
           WHERE s.business_id = $1 AND s.warehouse_id = $2 AND s.variant_id = ANY($3::uuid[])) AS levels,
         (SELECT coalesce(json_agg(json_build_object(
                   'id', d.id, 'variant_id', d.variant_id, 'deficit_seq', d.deficit_seq::text,
                   'uncovered_qty', d.uncovered_qty::text, 'provisional', d.provisional_unit_cost_base_minor::text)), '[]'::json)
            FROM negative_inventory_deficits d
           WHERE d.business_id = $1 AND d.warehouse_id = $2 AND d.variant_id = ANY($3::uuid[]) AND d.status <> 'closed') AS layers`,
      [scope.businessId, warehouseId, lines.map((l) => l.variant_id)],
    );
    if (row === undefined) throw new Error('the coverage state read returned no row');
    const keyStates = new Map<string, StockState>();
    for (const r of row.levels) {
      keyStates.set(r.variant_id, {
        onHand: parseQuantity(r.on_hand),
        valuation: parseMinor(r.valuation),
        avg: r.avg === null ? null : parseSignedC10(r.avg),
        lastStockSeq: BigInt(r.last_stock_seq),
      });
    }
    const layers = row.layers.map(
      (r): DeficitLayer => ({
        deficitId: r.id,
        variantId: r.variant_id,
        deficitSeq: BigInt(r.deficit_seq),
        uncoveredQ4: parseQuantity(r.uncovered_qty),
        provisionalC10: parseUnitCost(r.provisional),
      }),
    );
    return { keyStates, layers };
  }
}
