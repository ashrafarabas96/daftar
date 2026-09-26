import { Inject, Injectable } from '@nestjs/common';
import {
  allocateOpening,
  assertOpeningMatchesPosition,
  formatQuantity,
  formatUnitCost,
  openingIntentSha256,
  openingPayload,
  toC10,
  toQ4,
} from '@daftar/inventory';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { BusinessTransactionId } from './business-transaction';
import { InventoryAuthorizationService } from './inventory-authorization';
import { inventoryRefusal, rethrowMovementRefusal } from './inventory-errors';
import { assertStoredValues, executeMovement, openingPostingCommand, planPosting } from './inventory-posting';
import {
  assertMovableVariant,
  findOpening,
  postedOpeningExists,
  readBaseCurrency,
  readOpeningPosition,
  readStoredResult,
  readWarehouses,
  resolveVariants,
  stockKey,
  type MovementDocumentResult,
  type OpeningHeader,
  type ReadScope,
  type VariantReference,
} from './inventory-stock-read';

/** An opening request (A-13, A-21): one document over every warehouse it names. */
export interface OpeningInput {
  readonly openingId: string;
  /** `YYYY-MM-DD`, required. */
  readonly occurredOn: string;
  /** 1..200 lines; `(warehouse, variant)` unique; `quantity` positive, `unitCost` non-negative decimal strings. */
  readonly lines: readonly (VariantReference & { readonly warehouseId: string; readonly quantity: string; readonly unitCost: string })[];
}

/** The opening's answer: its movements, and how it met the ledger (A-21). */
export interface OpeningResult extends MovementDocumentResult {
  readonly case: OpeningHeader['caseKind'];
  /** Case B only: the posted opening balance the stock decomposes. */
  readonly openingBalanceId: string | null;
  /** Case B only: the position matched, equal to the stock total. */
  readonly matchedAmountMinor: string | null;
}

interface OpeningRow {
  document_id: string;
  replayed: boolean;
  case_kind: string;
  total_value_base_minor: string;
  line_id: string;
  warehouse_id: string;
  variant_id: string;
  value_delta_base_minor: string;
}

/**
 * `POST /v1/inventory/openings` (PHASE_3_S3_CONTRACT A-05, A-07, A-08, A-10,
 * A-13).
 *
 * The document total is `T = HALF_EVEN(Σ qty × cost)` and each line's value is
 * its largest-remainder share of T, computed here with the package allocator
 * (the TypeScript twin of `inventory_largest_remainder`). The case is decided
 * by the posted opening balance's inventory position, read after the
 * idempotency proof and BOUND into the payload:
 *
 * - Case A (no position): `Dr inventory` per warehouse / `Cr opening_equity`
 *   on seam 2 when T > 0; seam 1 and no entry when T = 0;
 * - Case B (a position P): T must equal P, else
 *   `inventory.opening_valuation_mismatch` (the code alone, no amount); the
 *   stock decomposes P and no entry is written (seam 1).
 *
 * Only a business-wide actor may record an opening (review F4): it posts to
 * opening equity and reveals the accounting position, so `authorize` refuses
 * an assigned-scope actor (`inventory.business_wide_scope_required`) before
 * anything is read, and `matchedAmountMinor` is only ever returned to one.
 *
 * The routine re-reads the position under the shared advisory lock and
 * refuses a difference (`inventory.opening_case_changed`, retryable).
 */
@Injectable()
export class InventoryOpeningService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async record(m: MembershipContext, input: OpeningInput, businessTransactionId: BusinessTransactionId): Promise<OpeningResult> {
    try {
      return await this.run(m, input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  private async run(m: MembershipContext, input: OpeningInput, businessTransactionId: BusinessTransactionId): Promise<OpeningResult> {
    // 1–4. Permission and business-wide scope (review F4); the warehouses are
    // still recorded on the authority the assertion is minted from.
    const warehouseIds = [...new Set(input.lines.map((l) => l.warehouseId))];
    const authority = await this.authorization.authorize(m, 'inventory.opening', businessTransactionId, warehouseIds);
    const scope: ReadScope = { tenantId: m.tenantId, businessId: m.businessId };

    // 5. Resolution.
    const variants = await resolveVariants(this.db, scope, input.lines);
    const lines = input.lines.map((l, i) => {
      const variant = variants[i];
      if (variant === undefined) throw new Error('a line was not resolved');
      return { warehouseId: l.warehouseId, variant, qtyQ4: toQ4(l.quantity), unitCostC10: toC10(l.unitCost) };
    });
    const header = {
      tenantId: m.tenantId,
      businessId: m.businessId,
      openingId: input.openingId,
      occurredOn: input.occurredOn,
      lines: lines.map((l) => ({ warehouseId: l.warehouseId, variantId: l.variant.variantId, qtyQ4: l.qtyQ4, unitCostC10: l.unitCostC10 })),
    };
    const intentSha256 = openingIntentSha256(header);

    // 6. The idempotency proof.
    const existing = await findOpening(this.db, scope, input.openingId);
    if (existing !== null) {
      if (existing.intentSha256 !== intentSha256) throw inventoryRefusal('inventory.idempotency_conflict');
      return this.stored(scope, input.openingId, true, existing);
    }

    // 7. Current state: one posted opening per business; every warehouse and
    // variant can receive stock; the valuation; the opening position.
    if (await postedOpeningExists(this.db, scope)) throw inventoryRefusal('inventory.opening_already_posted');
    const warehouses = await readWarehouses(this.db, scope, warehouseIds, warehouseIds);
    lines.forEach((l) => assertMovableVariant(l.variant, l.qtyQ4, true));
    const { total, shares } = allocateOpening(lines.map((l) => ({ qtyQ4: l.qtyQ4, costC10: l.unitCostC10 })));
    const position = await readOpeningPosition(this.db, scope);
    if (position !== null) assertOpeningMatchesPosition(total, position.positionMinor);

    const built = openingPayload({ ...header, openingBalanceId: position?.openingBalanceId ?? null, positionMinor: position?.positionMinor ?? null });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound payload does not carry the proven intent');

    // 8. Mint. Case A posts the per-warehouse shares; Case B never posts.
    const command =
      position !== null
        ? null
        : openingPostingCommand({
            tenantId: m.tenantId,
            businessId: m.businessId,
            sourceId: input.openingId,
            occurredOn: input.occurredOn,
            baseCurrency: await readBaseCurrency(this.db, scope),
            businessTransactionId,
            perWarehouse: warehouseIds.map((warehouseId) => {
              const w = warehouses.get(warehouseId);
              if (w === undefined) throw new Error('a warehouse was not read');
              const valueMinor = lines.reduce((a, l, i) => (l.warehouseId === warehouseId ? a + (shares[i] ?? 0n) : a), 0n);
              return { warehouseId, branchId: w.branchId, valueMinor };
            }),
          });
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const plan = planPosting(this.accountingMinter, command, m.userId);

    // 9–12. One transaction.
    const { result } = await executeMovement(this.db, this.posting, authority.scope, inventoryAssertion, plan, async (tx) => {
      const r = await tx.query<OpeningRow>(
        `SELECT document_id, replayed, case_kind, total_value_base_minor::text AS total_value_base_minor, line_id, warehouse_id, variant_id,
                value_delta_base_minor::text AS value_delta_base_minor
           FROM inventory_record_opening($1::uuid, $2::date, $3::uuid, $4::bigint, $5::uuid[], $6::uuid[], $7::numeric[], $8::numeric[])`,
        [
          input.openingId,
          input.occurredOn,
          position?.openingBalanceId ?? null,
          position === null ? null : position.positionMinor.toString(10),
          lines.map((l) => l.warehouseId),
          lines.map((l) => l.variant.variantId),
          lines.map((l) => formatQuantity(l.qtyQ4)),
          lines.map((l) => formatUnitCost(l.unitCostC10)),
        ],
      );
      const first = r.rows[0];
      if (first === undefined) throw new Error('inventory_record_opening returned no row');
      if (!first.replayed) {
        const byKey = new Map(r.rows.map((row) => [stockKey(row.warehouse_id, row.variant_id), row.value_delta_base_minor]));
        assertStoredValues(
          [...shares],
          lines.map((l) => byKey.get(stockKey(l.warehouseId, l.variant.variantId)) ?? ''),
        );
        if (first.total_value_base_minor !== total.toString(10)) throw new Error('inventory_record_opening stored a total other than the bound one');
      }
      return { replayed: first.replayed };
    });

    const stored = await findOpening(this.db, scope, input.openingId);
    if (stored === null) throw new Error('the recorded opening is not readable');
    return this.stored(scope, input.openingId, result.replayed, stored);
  }

  private async stored(scope: ReadScope, id: string, replayed: boolean, header: OpeningHeader): Promise<OpeningResult> {
    const result = await readStoredResult(this.db, scope, 'inventory_opening', id, replayed, header.businessTransactionId);
    return { ...result, case: header.caseKind, openingBalanceId: header.openingBalanceId, matchedAmountMinor: header.matchedAmountMinor };
  }
}
