import { Inject, Injectable } from '@nestjs/common';
import {
  compareUuid,
  formatQuantity,
  formatUnitCost,
  simulateMovement,
  stocktakeCountPayload,
  stocktakeFinalizeIntentSha256,
  stocktakeFinalizePayload,
  stocktakeOpenPayload,
  toC10,
  toQ4,
  type StocktakeFinalizeLine,
  type StocktakeOutcome,
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
  draftStocktakeExists,
  findStocktake,
  readBaseCurrency,
  readStockStates,
  readStocktakeLines,
  readStoredResult,
  readWarehouses,
  resolveVariants,
  stockKey,
  type MovementDocumentResult,
  type ReadScope,
  type StocktakeHeader,
  type StocktakeLineRow,
  type VariantReference,
} from './inventory-stock-read';

export interface StocktakeOpenInput {
  /** The client-chosen stocktake id: the idempotency key of the open. */
  readonly stocktakeId: string;
  readonly warehouseId: string;
}

export interface StocktakeOpenResult {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: StocktakeHeader['status'];
  readonly replayed: boolean;
  /** The trace id of THIS request: a stocktake header stores none (§2.2). */
  readonly businessTransactionId: string;
}

export interface StocktakeCountInput {
  /** 1..200 lines; `quantity` is the non-negative counted decimal string. */
  readonly lines: readonly (VariantReference & { readonly quantity: string })[];
}

/** One captured line (A-11): the count, and the stock it was measured against. Quantities are strings. */
export interface StocktakeCountLine {
  readonly lineId: string;
  readonly productId: string;
  /** The merchant variant, or null for a simple product (P3-AL-52). */
  readonly variantId: string | null;
  readonly expectedQtyAtCapture: string;
  readonly capturedAtStockSeq: string;
  readonly countedQty: string;
  readonly varianceQty: string;
  /** False when the same counted quantity was recorded again and the capture was left untouched (A-10(g)). */
  readonly changed: boolean;
}

export interface StocktakeCountResult {
  readonly id: string;
  readonly businessTransactionId: string;
  readonly lines: readonly StocktakeCountLine[];
}

export interface StocktakeFinalizeInput {
  /** `YYYY-MM-DD`, required: the entry date is never a server default. */
  readonly occurredOn: string;
  /** Explicit costs, only for positive variances on keys with no average (A-11). */
  readonly unitCosts?: readonly (VariantReference & { readonly unitCost: string })[] | null;
}

/** A finalized or cancelled stocktake: its movements (none when cancelled) and its entry. */
export interface StocktakeCloseResult extends MovementDocumentResult {
  readonly status: 'finalized' | 'cancelled';
}

interface OpenRow {
  stocktake_id: string;
  replayed: boolean;
}

interface CountRow {
  line_id: string;
  variant_id: string;
  expected_qty_at_capture: string;
  captured_at_stock_seq: string;
  counted_qty: string;
  variance_qty: string;
  changed: boolean;
}

interface FinalizeRow {
  stocktake_id: string;
  replayed: boolean;
  status: string;
  total_value_base_minor: string | null;
  line_id: string | null;
  variant_id: string | null;
  value_delta_base_minor: string | null;
}

/**
 * The stocktake commands (PHASE_3_S3_CONTRACT A-04, A-10(g), A-11, A-21):
 * open a draft, capture counts, then close it — finalized (the variances post
 * as `stocktake` movements and one `inventory_adjustment` entry for their net
 * value) or cancelled (nothing moves). Cancel is the `cancelled` outcome of
 * `inventory.stocktake_finalize` (TL-3), so it takes the same authority and
 * an assertion for one outcome cannot perform the other.
 *
 * Every command follows A-10(c): authority over the stocktake's warehouse →
 * resolution → the idempotency proof → current state → mint → seam → routine
 * → post → commit. The service writes nothing itself.
 */
@Injectable()
export class InventoryStocktakeService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async open(m: MembershipContext, input: StocktakeOpenInput, businessTransactionId: BusinessTransactionId): Promise<StocktakeOpenResult> {
    try {
      return await this.runOpen(m, input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  async count(
    m: MembershipContext,
    stocktakeId: string,
    input: StocktakeCountInput,
    businessTransactionId: BusinessTransactionId,
  ): Promise<StocktakeCountResult> {
    try {
      return await this.runCount(m, stocktakeId, input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  async finalize(
    m: MembershipContext,
    stocktakeId: string,
    input: StocktakeFinalizeInput,
    businessTransactionId: BusinessTransactionId,
  ): Promise<StocktakeCloseResult> {
    try {
      return await this.runClose(m, stocktakeId, 'finalized', input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  async cancel(m: MembershipContext, stocktakeId: string, businessTransactionId: BusinessTransactionId): Promise<StocktakeCloseResult> {
    try {
      return await this.runClose(m, stocktakeId, 'cancelled', null, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  private async runOpen(m: MembershipContext, input: StocktakeOpenInput, businessTransactionId: BusinessTransactionId): Promise<StocktakeOpenResult> {
    const authority = await this.authorization.authorize(m, 'inventory.stocktake_open', businessTransactionId, [input.warehouseId]);
    const scope: ReadScope = { tenantId: m.tenantId, businessId: m.businessId };
    const built = stocktakeOpenPayload({ tenantId: m.tenantId, businessId: m.businessId, stocktakeId: input.stocktakeId, warehouseId: input.warehouseId });

    // The idempotency proof, keyed by the stocktake id (A-10(g)).
    const existing = await findStocktake(this.db, scope, input.stocktakeId);
    if (existing !== null) {
      if (existing.intentSha256 !== built.intentSha256) throw inventoryRefusal('inventory.idempotency_conflict');
      return { id: existing.id, warehouseId: existing.warehouseId, status: existing.status, replayed: true, businessTransactionId };
    }
    if (await adjustmentSourceIdTaken(this.db, scope, input.stocktakeId, 'inventory_adjustments')) throw inventoryRefusal('inventory.document_id_conflict');

    // Current state: the warehouse is active and has no other draft.
    await readWarehouses(this.db, scope, [input.warehouseId], [input.warehouseId]);
    if (await draftStocktakeExists(this.db, scope, input.warehouseId)) throw inventoryRefusal('inventory.stocktake_already_open');

    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const r = await tx.query<OpenRow>('SELECT stocktake_id, replayed FROM inventory_stocktake_open($1::uuid, $2::uuid)', [
        input.stocktakeId,
        input.warehouseId,
      ]);
      const first = r.rows[0];
      if (first === undefined) throw new Error('inventory_stocktake_open returned no row');
      return first.replayed;
    });
    const stored = await findStocktake(this.db, scope, input.stocktakeId);
    if (stored === null) throw new Error('the opened stocktake is not readable');
    return { id: stored.id, warehouseId: stored.warehouseId, status: stored.status, replayed, businessTransactionId };
  }

  private async runCount(
    m: MembershipContext,
    stocktakeId: string,
    input: StocktakeCountInput,
    businessTransactionId: BusinessTransactionId,
  ): Promise<StocktakeCountResult> {
    const scope: ReadScope = { tenantId: m.tenantId, businessId: m.businessId };
    // The stocktake's warehouse is an immutable fact of the document: it names the scope to check.
    const header = await this.header(scope, stocktakeId);
    const authority = await this.authorization.authorize(m, 'inventory.stocktake_count', businessTransactionId, [header.warehouseId]);

    const resolved = await resolveVariants(this.db, scope, input.lines);
    const lines = input.lines
      .map((l, i) => {
        const variant = resolved[i];
        if (variant === undefined) throw new Error('a line was not resolved');
        return { variant, countedQ4: toQ4(l.quantity) };
      })
      .sort((a, b) => compareUuid(a.variant.variantId, b.variant.variantId));
    const built = stocktakeCountPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      stocktakeId,
      warehouseId: header.warehouseId,
      lines: lines.map((l) => ({ variantId: l.variant.variantId, countedQ4: l.countedQ4 })),
    });

    // A count is an idempotent upsert (A-10(g)): the routine leaves an equal
    // recount untouched. Current state: the draft, and every counted variant.
    if (header.status !== 'draft') throw inventoryRefusal('inventory.stocktake_state_invalid');
    await readWarehouses(this.db, scope, [header.warehouseId], [header.warehouseId]);
    lines.forEach((l) => assertMovableVariant(l.variant, l.countedQ4, true));

    const assertion = this.authorization.mint(authority, built.payload);
    const counted = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const r = await tx.query<CountRow>(
        `SELECT line_id, variant_id, expected_qty_at_capture::text AS expected_qty_at_capture, captured_at_stock_seq::text AS captured_at_stock_seq,
                counted_qty::text AS counted_qty, variance_qty::text AS variance_qty, changed
           FROM inventory_stocktake_count($1::uuid, $2::uuid, $3::uuid[], $4::numeric[])`,
        [stocktakeId, header.warehouseId, lines.map((l) => l.variant.variantId), lines.map((l) => formatQuantity(l.countedQ4))],
      );
      if (r.rows.length !== lines.length) throw new Error('inventory_stocktake_count did not answer every line');
      return r.rows;
    });
    const byVariant = new Map(lines.map((l) => [l.variant.variantId, l.variant]));
    return {
      id: stocktakeId,
      businessTransactionId,
      lines: counted.map((row) => {
        const variant = byVariant.get(row.variant_id);
        if (variant === undefined) throw new Error('inventory_stocktake_count answered a variant it was not given');
        return {
          lineId: row.line_id,
          productId: variant.productId,
          variantId: variant.merchantVariantId,
          expectedQtyAtCapture: row.expected_qty_at_capture,
          capturedAtStockSeq: row.captured_at_stock_seq,
          countedQty: row.counted_qty,
          varianceQty: row.variance_qty,
          changed: row.changed,
        };
      }),
    };
  }

  private async runClose(
    m: MembershipContext,
    stocktakeId: string,
    outcome: StocktakeOutcome,
    input: StocktakeFinalizeInput | null,
    businessTransactionId: BusinessTransactionId,
  ): Promise<StocktakeCloseResult> {
    const scope: ReadScope = { tenantId: m.tenantId, businessId: m.businessId };
    const header = await this.header(scope, stocktakeId);
    const authority = await this.authorization.authorize(m, 'inventory.stocktake_finalize', businessTransactionId, [header.warehouseId]);
    const occurredOn = outcome === 'finalized' ? (input?.occurredOn ?? null) : null;

    // Resolution: every stored line (the document's own identity, frozen once
    // closed), with the explicit costs the request states against them.
    const stored = outcome === 'finalized' ? await readStocktakeLines(this.db, scope, stocktakeId) : [];
    const costs = await this.explicitCosts(scope, stored, input?.unitCosts ?? []);
    const base = { tenantId: m.tenantId, businessId: m.businessId, stocktakeId, warehouseId: header.warehouseId, outcome, occurredOn };
    const intentSha256 = stocktakeFinalizeIntentSha256({
      ...base,
      lines: stored.map((l) => ({ variantId: l.variantId, unitCostC10: costs.get(l.variantId) ?? null })),
    });

    // The idempotency proof (A-10(g)): an equal close answers its stored
    // result; any other close of a closed stocktake is a state refusal.
    if (header.finalizeIntentSha256 !== null) {
      if (header.finalizeIntentSha256 !== intentSha256 || header.status === 'draft') throw inventoryRefusal('inventory.stocktake_state_invalid');
      return this.closed(scope, stocktakeId, header.status, true, businessTransactionId);
    }
    if (header.status !== 'draft') throw inventoryRefusal('inventory.stocktake_state_invalid');
    if (outcome === 'finalized' && stored.length === 0) throw inventoryRefusal('inventory.stocktake_empty');

    // Current state and the bound values (A-07, A-11).
    const warehouses = await readWarehouses(this.db, scope, [header.warehouseId]);
    const warehouse = warehouses.get(header.warehouseId);
    if (warehouse === undefined) throw new Error('the warehouse was not read');
    const moving = stored.filter((l) => toQ4(l.varianceQty) !== 0n);
    const states = await readStockStates(
      this.db,
      scope,
      moving.map((l) => ({ warehouseId: header.warehouseId, variantId: l.variantId })),
    );
    const lines = finalizeLines(stored, costs, (variantId) => states.get(stockKey(header.warehouseId, variantId)));
    const built = stocktakeFinalizePayload({ ...base, lines });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound payload does not carry the proven intent');

    const netValueMinor = lines.reduce((a, l) => a + l.expectedValue, 0n);
    const command =
      occurredOn === null
        ? null
        : adjustmentPostingCommand({
            tenantId: m.tenantId,
            businessId: m.businessId,
            sourceId: stocktakeId,
            occurredOn,
            baseCurrency: await readBaseCurrency(this.db, scope),
            businessTransactionId,
            warehouseId: header.warehouseId,
            branchId: warehouse.branchId,
            netValueMinor,
          });
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const plan = planPosting(this.accountingMinter, command, m.userId);

    const { result } = await executeMovement(this.db, this.posting, authority.scope, inventoryAssertion, plan, async (tx) => {
      const r = await tx.query<FinalizeRow>(
        `SELECT stocktake_id, replayed, status, total_value_base_minor::text AS total_value_base_minor, line_id, variant_id,
                value_delta_base_minor::text AS value_delta_base_minor
           FROM inventory_stocktake_finalize($1::uuid, $2::uuid, $3::text, $4::date, $5::uuid[], $6::numeric[], $7::numeric[], $8::bigint[])`,
        [
          stocktakeId,
          header.warehouseId,
          outcome,
          occurredOn,
          lines.map((l) => l.variantId),
          lines.map((l) => formatQuantity(l.varianceQ4)),
          lines.map((l) => (l.unitCostC10 === null ? null : formatUnitCost(l.unitCostC10))),
          lines.map((l) => l.expectedValue.toString(10)),
        ],
      );
      const first = r.rows[0];
      if (first === undefined) throw new Error('inventory_stocktake_finalize returned no row');
      if (!first.replayed) {
        const byVariant = new Map(r.rows.map((row) => [row.variant_id, row.value_delta_base_minor]));
        const applied = lines.filter((l) => l.varianceQ4 !== 0n);
        assertStoredValues(
          applied.map((l) => l.expectedValue),
          applied.map((l) => byVariant.get(l.variantId) ?? ''),
        );
      }
      return { replayed: first.replayed };
    });
    return this.closed(scope, stocktakeId, outcome, result.replayed, businessTransactionId);
  }

  /** The stocktake header, or `inventory.stocktake_not_found` (a row of another business is invisible under RLS). */
  private async header(scope: ReadScope, stocktakeId: string): Promise<StocktakeHeader> {
    const header = await findStocktake(this.db, scope, stocktakeId);
    if (header === null) throw inventoryRefusal('inventory.stocktake_not_found');
    return header;
  }

  /**
   * The explicit costs of a finalize, by stock variant. Each must name a line
   * of the stocktake, once; whether a cost is applicable is current state
   * (it depends on the key's average) and is judged after the proof.
   */
  private async explicitCosts(
    scope: ReadScope,
    stored: readonly StocktakeLineRow[],
    unitCosts: readonly (VariantReference & { readonly unitCost: string })[],
  ): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (unitCosts.length === 0) return out;
    const resolved = await resolveVariants(this.db, scope, unitCosts);
    const lineVariants = new Set(stored.map((l) => l.variantId));
    unitCosts.forEach((c, i) => {
      const variantId = resolved[i]?.variantId;
      if (variantId === undefined || !lineVariants.has(variantId)) throw inventoryRefusal('inventory.payload_invalid');
      if (out.has(variantId)) throw inventoryRefusal('inventory.duplicate_line');
      out.set(variantId, toC10(c.unitCost));
    });
    return out;
  }

  private async closed(
    scope: ReadScope,
    stocktakeId: string,
    status: StocktakeHeader['status'],
    replayed: boolean,
    businessTransactionId: string,
  ): Promise<StocktakeCloseResult> {
    if (status === 'draft') throw new Error('a closed stocktake reads as a draft');
    const result = await readStoredResult(this.db, scope, 'stocktake', stocktakeId, replayed, businessTransactionId);
    return { ...result, status };
  }
}

/**
 * Every line's bound variance, explicit cost and expected value (A-11 step 6),
 * computed from the stock read with the package's twin of the primitive:
 * - zero variance: value 0, no cost;
 * - negative: outbound at the current average (`inventory.insufficient_stock` beyond on-hand);
 * - positive on a key with an average: inbound at that average — a stated cost
 *   is `inventory.unit_cost_not_applicable`;
 * - positive on a key with none: the stated cost is required, else
 *   `inventory.unit_cost_required` listing every such line.
 */
function finalizeLines(
  stored: readonly StocktakeLineRow[],
  costs: ReadonlyMap<string, bigint>,
  stateOf: (variantId: string) => StockState | undefined,
): StocktakeFinalizeLine[] {
  const missing: { productId: string; variantId: string | null }[] = [];
  const lines = stored.map((l): StocktakeFinalizeLine => {
    const varianceQ4 = toQ4(l.varianceQty);
    const explicit = costs.get(l.variantId) ?? null;
    if (varianceQ4 === 0n) {
      if (explicit !== null) throw inventoryRefusal('inventory.unit_cost_not_applicable');
      return { variantId: l.variantId, varianceQ4, unitCostC10: null, expectedValue: 0n };
    }
    const state = stateOf(l.variantId);
    if (state === undefined) throw new Error('a stock state was not read');
    if (varianceQ4 < 0n) {
      if (explicit !== null) throw inventoryRefusal('inventory.unit_cost_not_applicable');
      const { value } = simulateMovement(state, { kind: 'stocktake', qtyQ4: varianceQ4, costC10: null, value: null });
      return { variantId: l.variantId, varianceQ4, unitCostC10: null, expectedValue: value };
    }
    if (state.avg !== null) {
      if (explicit !== null) throw inventoryRefusal('inventory.unit_cost_not_applicable');
      const { value } = simulateMovement(state, { kind: 'stocktake', qtyQ4: varianceQ4, costC10: state.avg, value: null });
      return { variantId: l.variantId, varianceQ4, unitCostC10: null, expectedValue: value };
    }
    if (explicit === null) {
      missing.push({ productId: l.productId, variantId: l.isBase ? null : l.variantId });
      return { variantId: l.variantId, varianceQ4, unitCostC10: null, expectedValue: 0n };
    }
    const { value } = simulateMovement(state, { kind: 'stocktake', qtyQ4: varianceQ4, costC10: explicit, value: null });
    return { variantId: l.variantId, varianceQ4, unitCostC10: explicit, expectedValue: value };
  });
  if (missing.length > 0) throw inventoryRefusal('inventory.unit_cost_required', { lines: missing });
  return lines;
}
