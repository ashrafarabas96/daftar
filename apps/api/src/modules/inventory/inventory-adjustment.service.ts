import { Inject, Injectable } from '@nestjs/common';
import {
  adjustIntentSha256,
  adjustPayload,
  damageIntentSha256,
  damagePayload,
  formatQuantity,
  formatUnitCost,
  simulateMovement,
  toC10,
  toQ4,
  type MovementPayload,
  type StockState,
} from '@daftar/inventory';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { BusinessTransactionId } from './business-transaction';
import { InventoryAuthorizationService } from './inventory-authorization';
import { inventoryRefusal, rethrowMovementRefusal } from './inventory-errors';
import { adjustmentPostingCommand, assertStoredValues, executeMovement, planPosting } from './inventory-posting';
import {
  adjustmentSourceIdTaken,
  assertMovableVariant,
  findAdjustment,
  readBaseCurrency,
  readStockStates,
  readStoredResult,
  readWarehouses,
  resolveVariants,
  stockKey,
  type MovementDocumentResult,
  type ReadScope,
  type ResolvedVariant,
} from './inventory-stock-read';

/** An adjustment request (A-12, A-21). A gain names its unit cost; a loss does not. */
export interface AdjustmentInput {
  readonly adjustmentId: string;
  readonly warehouseId: string;
  /** `YYYY-MM-DD`, required: the entry date is never a server default. */
  readonly occurredOn: string;
  /** 1..500 characters after trimming; copied to every movement. */
  readonly reason: string;
  /** `quantity` is a SIGNED, non-zero decimal string: positive is a gain, negative a loss. */
  readonly lines: readonly { readonly productId: string; readonly variantId?: string | null; readonly quantity: string; readonly unitCost?: string | null }[];
}

/** A damage request (A-12): each line states the positive magnitude written off. */
export interface DamageInput {
  readonly adjustmentId: string;
  readonly warehouseId: string;
  readonly occurredOn: string;
  readonly reason: string;
  readonly lines: readonly { readonly productId: string; readonly variantId?: string | null; readonly quantity: string }[];
}

/** The rows `inventory_adjust_stock` / `inventory_record_damage` return. */
interface AdjustRow {
  document_id: string;
  replayed: boolean;
  total_value_base_minor: string;
  line_id: string;
  variant_id: string;
  value_delta_base_minor: string;
}

/** One line after parsing: the resolved stock variant, the signed quantity delta and the cost of a gain. */
interface PlannedLine {
  readonly variant: ResolvedVariant;
  readonly qtyDeltaQ4: bigint;
  readonly unitCostC10: bigint | null;
}

/**
 * `POST /v1/inventory/adjustments` and `POST /v1/inventory/damages`
 * (PHASE_3_S3_CONTRACT A-05, A-07, A-08, A-10, A-12).
 *
 * Both are documents of `inventory_adjustments` under the one accounting
 * source `inventory_adjustment`. The flow is A-10(c): authority over the
 * warehouse → variant resolution → the idempotency proof (the stored intent
 * digest, BEFORE any stock read) → current state → the expected value of
 * every line, computed from the current stock with the package's twin of the
 * primitive's arithmetic and BOUND into the payload (A-07) → the posting of
 * the net value V, minted over exactly those values → seam 2 when V ≠ 0,
 * seam 1 when V = 0 → the routine → the posting → commit.
 *
 * The service writes nothing itself. If another command changes a key between
 * the read and the routine's lock, the routine refuses
 * `inventory.valuation_changed` (409) and nothing commits; the client may
 * resubmit the same document id. There is no server retry (TL-5).
 */
@Injectable()
export class InventoryAdjustmentService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async adjust(m: MembershipContext, input: AdjustmentInput, businessTransactionId: BusinessTransactionId): Promise<MovementDocumentResult> {
    try {
      return await this.run(m, 'adjustment', input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  async damage(m: MembershipContext, input: DamageInput, businessTransactionId: BusinessTransactionId): Promise<MovementDocumentResult> {
    try {
      return await this.run(m, 'damage', input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  private async run(
    m: MembershipContext,
    kind: 'adjustment' | 'damage',
    input: AdjustmentInput | DamageInput,
    businessTransactionId: BusinessTransactionId,
  ): Promise<MovementDocumentResult> {
    const opCode = kind === 'adjustment' ? 'inventory.adjust' : 'inventory.damage';
    // 1–4. Permission and the warehouse's scope.
    const authority = await this.authorization.authorize(m, opCode, businessTransactionId, [input.warehouseId]);
    const scope: ReadScope = { tenantId: m.tenantId, businessId: m.businessId };
    const reason = input.reason.trim();

    // 5. Validation and variant resolution.
    const variants = await resolveVariants(this.db, scope, input.lines);
    const lines: PlannedLine[] = input.lines.map((l, i) => {
      const variant = variants[i];
      if (variant === undefined) throw new Error('a line was not resolved');
      if (kind === 'damage') return { variant, qtyDeltaQ4: -toQ4(l.quantity), unitCostC10: null };
      const unitCost = 'unitCost' in l ? l.unitCost : null;
      return { variant, qtyDeltaQ4: toQ4(l.quantity), unitCostC10: unitCost === null || unitCost === undefined ? null : toC10(unitCost) };
    });
    const header = {
      tenantId: m.tenantId,
      businessId: m.businessId,
      adjustmentId: input.adjustmentId,
      warehouseId: input.warehouseId,
      occurredOn: input.occurredOn,
      reason,
    };
    const intentSha256 =
      kind === 'adjustment'
        ? adjustIntentSha256({ ...header, lines: lines.map((l) => ({ variantId: l.variant.variantId, qtyDeltaQ4: l.qtyDeltaQ4, unitCostC10: l.unitCostC10 })) })
        : damageIntentSha256({ ...header, lines: lines.map((l) => ({ variantId: l.variant.variantId, qtyQ4: -l.qtyDeltaQ4 })) });

    // 6. The idempotency proof, before any current-state read.
    const existing = await findAdjustment(this.db, scope, input.adjustmentId);
    if (existing !== null) {
      if (existing.kind !== kind || existing.intentSha256 !== intentSha256) throw inventoryRefusal('inventory.idempotency_conflict');
      return readStoredResult(this.db, scope, 'inventory_adjustment', input.adjustmentId, true, existing.businessTransactionId);
    }
    if (await adjustmentSourceIdTaken(this.db, scope, input.adjustmentId, 'stocktakes')) throw inventoryRefusal('inventory.document_id_conflict');

    // 7. Current state, then the bound expected values (A-07).
    const warehouses = await readWarehouses(this.db, scope, [input.warehouseId], lines.some((l) => l.qtyDeltaQ4 > 0n) ? [input.warehouseId] : []);
    const warehouse = warehouses.get(input.warehouseId);
    if (warehouse === undefined) throw new Error('the warehouse was not read');
    lines.forEach((l) => assertMovableVariant(l.variant, l.qtyDeltaQ4, l.qtyDeltaQ4 > 0n));
    const states = await readStockStates(
      this.db,
      scope,
      lines.map((l) => ({ warehouseId: input.warehouseId, variantId: l.variant.variantId })),
    );
    const expected = lines.map((l) => expectedValue(kind, states.get(stockKey(input.warehouseId, l.variant.variantId)), l));
    const netValueMinor = expected.reduce((a, v) => a + v, 0n);

    const built: MovementPayload =
      kind === 'adjustment'
        ? adjustPayload({
            ...header,
            lines: lines.map((l, i) => ({
              variantId: l.variant.variantId,
              qtyDeltaQ4: l.qtyDeltaQ4,
              unitCostC10: l.unitCostC10,
              expectedValue: expected[i] ?? 0n,
            })),
          })
        : damagePayload({
            ...header,
            lines: lines.map((l, i) => ({ variantId: l.variant.variantId, qtyQ4: -l.qtyDeltaQ4, expectedValue: expected[i] ?? 0n })),
          });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound payload does not carry the proven intent');

    // 8. Mint: the inventory assertion over the payload, and the accounting
    // assertion over the posting V implies — only when V ≠ 0 (A-08).
    const command = adjustmentPostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      sourceId: input.adjustmentId,
      occurredOn: input.occurredOn,
      baseCurrency: await readBaseCurrency(this.db, scope),
      businessTransactionId,
      warehouseId: input.warehouseId,
      branchId: warehouse.branchId,
      netValueMinor,
    });
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const plan = planPosting(this.accountingMinter, command, m.userId);

    // 9–12. One transaction: the routine, then the posting, then COMMIT.
    const { result } = await executeMovement(this.db, this.posting, authority.scope, inventoryAssertion, plan, async (tx) => {
      const r =
        kind === 'adjustment'
          ? await tx.query<AdjustRow>(
              `SELECT document_id, replayed, total_value_base_minor::text AS total_value_base_minor, line_id, variant_id,
                      value_delta_base_minor::text AS value_delta_base_minor
                 FROM inventory_adjust_stock($1::uuid, $2::uuid, $3::date, $4::text, $5::uuid[], $6::numeric[], $7::numeric[], $8::bigint[])`,
              [
                input.adjustmentId,
                input.warehouseId,
                input.occurredOn,
                reason,
                lines.map((l) => l.variant.variantId),
                lines.map((l) => formatQuantity(l.qtyDeltaQ4)),
                lines.map((l) => (l.unitCostC10 === null ? null : formatUnitCost(l.unitCostC10))),
                expected.map((v) => v.toString(10)),
              ],
            )
          : await tx.query<AdjustRow>(
              `SELECT document_id, replayed, total_value_base_minor::text AS total_value_base_minor, line_id, variant_id,
                      value_delta_base_minor::text AS value_delta_base_minor
                 FROM inventory_record_damage($1::uuid, $2::uuid, $3::date, $4::text, $5::uuid[], $6::numeric[], $7::bigint[])`,
              [
                input.adjustmentId,
                input.warehouseId,
                input.occurredOn,
                reason,
                lines.map((l) => l.variant.variantId),
                lines.map((l) => formatQuantity(-l.qtyDeltaQ4)),
                expected.map((v) => v.toString(10)),
              ],
            );
      const first = r.rows[0];
      if (first === undefined) throw new Error('the adjustment routine returned no row');
      if (!first.replayed) {
        const byVariant = new Map(r.rows.map((row) => [row.variant_id, row.value_delta_base_minor]));
        assertStoredValues(
          expected,
          lines.map((l) => byVariant.get(l.variant.variantId) ?? ''),
        );
      }
      return { replayed: first.replayed };
    });

    const trace = result.replayed
      ? ((await findAdjustment(this.db, scope, input.adjustmentId))?.businessTransactionId ?? businessTransactionId)
      : businessTransactionId;
    return readStoredResult(this.db, scope, 'inventory_adjustment', input.adjustmentId, result.replayed, trace);
  }
}

/**
 * A line's value, exactly as the primitive will compute it (A-07, A-12):
 * a loss or a write-off at the current average (HALF_EVEN, or the flush when
 * it empties the key; `inventory.insufficient_stock` beyond on-hand), a gain
 * at its explicit cost. `simulateMovement` is the TypeScript twin proven
 * against the SQL by the shared `invval/1` vectors.
 */
function expectedValue(kind: 'adjustment' | 'damage', state: StockState | undefined, line: PlannedLine): bigint {
  if (state === undefined) throw new Error('a stock state was not read');
  return simulateMovement(state, {
    kind,
    qtyQ4: line.qtyDeltaQ4,
    costC10: line.qtyDeltaQ4 > 0n ? line.unitCostC10 : null,
    value: null,
  }).value;
}
