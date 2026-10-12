/**
 * Phase 10 — WHEN stock leaves, WHO may move it, and the proof it happens
 * ONCE. PREPARED / NOT PROMOTED. High-Velocity V1 PART 7.7, PART 8, PART 11.
 *
 * PART 7.7's law for this phase is one sentence:
 *
 *   "every real consumption must happen through the official authority,
 *    exactly once."
 *
 * Three words in it are three separate obligations, and this module exists
 * because the pack already satisfied the easy one and nothing enforced the
 * other two.
 *
 *   "real"      — §46 already decides WHAT a line consumes (direct, service,
 *                 composed) and `stock-effect.ts` already proves the movement
 *                 SET is exactly right.
 *   "authority" — nothing stopped a restaurant-side writer from emitting a
 *                 movement itself, or from attaching a valuation to it. PART 8
 *                 gives inventory and its valuation to ONE owner; a second
 *                 writer is a parallel truth even when its arithmetic agrees.
 *   "once"      — nothing related an order line's SEPARATE occasions to each
 *                 other. A dish has two mutually exclusive ways to take stock,
 *                 and no code said they were exclusive.
 *
 * THE TWO OCCASIONS, AND WHY THEY MUST EXCLUDE EACH OTHER
 *
 * LAW 3 (`preparation-state.ts`) says a kitchen transition moves no stock: the
 * ingredients of a dish the guest receives leave at SALE COMMIT, with the sale.
 * The dish the guest never receives has no sale to carry it, so a cancellation
 * after the cook has started owes a WASTE movement instead
 * (`cancellationWastesStock`).
 *
 * Those are the only two. They are alternatives, not stages: the same physical
 * ingredients cannot both be sold and be wasted. Written as two independent
 * features — which is how they were written — nothing prevents a line from
 * being cancelled for waste and then committed on a sale anyway, and the second
 * movement decrements stock a second time for food that left the shelf once.
 * No later reconciliation can tell that pair of movements apart from two
 * honest ones, because both are well-formed and both name the right recipe.
 *
 * So the exclusivity is the invariant, and this module is where it lives: one
 * order line, at most one consumption occasion, ever.
 *
 * REPLAY IS NOT A SECOND CONSUMPTION
 *
 * A command that times out after the movement landed will be retried, and the
 * retry must not take the stock again. The discriminator is the COMMAND, not
 * the occasion: re-presenting the same `commandId` for the same line is the
 * same event arriving twice and is accepted as a replay; a DIFFERENT command
 * for a line that already consumed is the defect this module refuses. A ledger
 * keyed on the occasion alone would reject the honest retry and accept nothing
 * useful in its place.
 */

import { cancellationWastesStock, type PreparationState } from './preparation-state';
import type { StockEffectMode } from './stock-effect';

/**
 * The single writer allowed to move stock, per PART 8. The restaurant pack
 * names it; it does not implement it. Any other value in a record is a second
 * inventory writer announcing itself.
 */
export const INVENTORY_AUTHORITY = 'inventory.stock_writer' as const;

export const CONSUMPTION_OCCASIONS = ['sale_commit', 'cancellation_waste'] as const;
export type ConsumptionOccasion = (typeof CONSUMPTION_OCCASIONS)[number];

/**
 * The ONLY keys a consumption record may carry.
 *
 * This was a deny-list of six valuation spellings, and the second independent
 * challenge showed why that could not work: the law is categorical — *the
 * restaurant pack states quantities, and the inventory authority states what
 * they are worth* — and a list of names cannot enforce a categorical law. A
 * record carrying `costBaseMinor` passed it intact, and that spelling is not
 * hypothetical: `inventory_sale_cost_base_minor` is the live SQL authority's
 * own name for the quantity, so it is what a real bridge is most likely to
 * send. `unitPriceMinor`, `valuationMinor`, `cost_minor` and
 * `weightedAverageCostMinor` passed too. Worse, deleting an entry from the
 * list broke no test: an incomplete list that nothing would notice shrinking.
 *
 * Inverted, the law is enforceable and cannot be outgrown by a spelling nobody
 * has thought of. A record has five fields; anything else is refused.
 */
export const CONSUMPTION_RECORD_KEYS: readonly string[] = Object.freeze(['orderLineId', 'occasion', 'commandId', 'authority', 'movementCount']);

/**
 * Spellings that make an unexpected key recognisably a VALUATION.
 *
 * This is not what decides admission — {@link CONSUMPTION_RECORD_KEYS} does,
 * and it decides it categorically. This only decides which refusal NAMES the
 * problem more usefully, so a bridge sending a cost is told it sent a cost
 * rather than told it sent an unknown field. A pattern that misses is a worse
 * message, never an admitted record.
 */
const VALUATION_SPELLING = /cost|price|valuation|value|worth|amount|cogs|margin/i;

export type ConsumptionRefusalCode =
  /** A second, different command took stock for a line that already consumed. */
  | 'restaurant.consumption.occasion_repeated'
  /** The line's fate owes no movement at all, and one was recorded. */
  | 'restaurant.consumption.occasion_not_owed'
  /** A movement was recorded on the wrong occasion for this line's fate. */
  | 'restaurant.consumption.occasion_mismatch'
  /** Someone other than the inventory authority moved the stock. */
  | 'restaurant.consumption.authority_not_canonical'
  /** The record carried a cost or a value; valuation is not this pack's. */
  | 'restaurant.consumption.valuation_present'
  /** The record carried a field this contract does not define at all. */
  | 'restaurant.consumption.record_field_unknown'
  /** A refund of a composed line asked to put cooked food back on the shelf. */
  | 'restaurant.consumption.refund_restocks_composed'
  /** A cancellation record did not say what state the line was cancelled in. */
  | 'restaurant.consumption.cancellation_state_absent';

export class ConsumptionRefusal extends Error {
  constructor(
    readonly code: ConsumptionRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConsumptionRefusal';
  }
}

export type LineOutcome = 'sold' | 'cancelled' | 'voided_before_placement';

/** What actually became of one order line. The occasion follows from this. */
export interface OrderLineFate {
  readonly orderLineId: string;
  readonly mode: StockEffectMode;
  readonly outcome: LineOutcome;
  /** Required when `outcome` is `cancelled`; the boundary is `preparing`. */
  readonly stateAtCancellation: PreparationState | null;
}

/**
 * Which occasion, if any, owes this line's movements.
 *
 * `null` is a first-class answer and the common one: a service consumes
 * nothing, a line cancelled while still queued was never started, and a line
 * voided before it reached the kitchen never existed for stock.
 */
export function occasionOwedBy(fate: OrderLineFate): ConsumptionOccasion | null {
  if (fate.mode === 'service') return null;
  switch (fate.outcome) {
    case 'sold':
      return 'sale_commit';
    case 'voided_before_placement':
      return null;
    case 'cancelled': {
      const state = fate.stateAtCancellation;
      if (state === null) {
        throw new ConsumptionRefusal(
          'restaurant.consumption.cancellation_state_absent',
          `Line ${fate.orderLineId} was cancelled but names no preparation state, and whether ingredients had left stock cannot be guessed`,
          { orderLineId: fate.orderLineId },
        );
      }
      return cancellationWastesStock(state) ? 'cancellation_waste' : null;
    }
    default: {
      const unreachable: never = fate.outcome;
      throw new ConsumptionRefusal('restaurant.consumption.occasion_not_owed', `No occasion rule is defined for outcome ${String(unreachable)}`, {
        outcome: String(unreachable),
      });
    }
  }
}

/** One consumption, as the bridge presents it for recording. */
export interface ConsumptionRecord {
  readonly orderLineId: string;
  readonly occasion: ConsumptionOccasion;
  /** The command that caused it. Re-presenting the same one is a replay. */
  readonly commandId: string;
  /** Who moved the stock. Must be {@link INVENTORY_AUTHORITY}. */
  readonly authority: string;
  /**
   * Informational only. Whether the SET of movements is the right one is
   * `assertMovementSetComplete`'s question and is answered against the
   * authorities; a count cannot tell a complete set from a plausible one (§48),
   * so the ledger does not pretend to check it.
   */
  readonly movementCount: number;
}

export type RecordOutcome = 'recorded' | 'replay';

interface LedgerEntry {
  readonly occasion: ConsumptionOccasion;
  readonly commandId: string;
  readonly movementCount: number;
}

/**
 * At most one consumption occasion per order line, for the life of the order.
 *
 * The ledger is the restaurant pack's own record of what it ASKED the inventory
 * authority to do; it is not a stock balance and holds no quantity it could be
 * mistaken for one. Its single question is "has this line already taken its
 * stock, and under which command".
 */
export class ConsumptionLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * Record one consumption against a line's fate, or refuse.
   *
   * The order of the checks is deliberate. The authority and the valuation are
   * checked FIRST, before anything is entered: a record from the wrong writer
   * must not occupy the line's one slot, because doing so would make the
   * authority's own later, correct movement look like the duplicate.
   */
  record(fate: OrderLineFate, record: ConsumptionRecord): RecordOutcome {
    if (record.authority !== INVENTORY_AUTHORITY) {
      throw new ConsumptionRefusal(
        'restaurant.consumption.authority_not_canonical',
        `Line ${record.orderLineId} moved stock through ${record.authority}; only ${INVENTORY_AUTHORITY} moves stock`,
        { orderLineId: record.orderLineId, authority: record.authority, expected: INVENTORY_AUTHORITY },
      );
    }
    assertNoLocalValuation(record);

    const owed = occasionOwedBy(fate);
    if (owed === null) {
      throw new ConsumptionRefusal(
        'restaurant.consumption.occasion_not_owed',
        `Line ${fate.orderLineId} (${fate.mode}, ${fate.outcome}) owes no stock movement, but a ${record.occasion} consumption was recorded`,
        { orderLineId: fate.orderLineId, mode: fate.mode, outcome: fate.outcome, recordedOccasion: record.occasion },
      );
    }
    if (owed !== record.occasion) {
      throw new ConsumptionRefusal(
        'restaurant.consumption.occasion_mismatch',
        `Line ${fate.orderLineId} owes its movements at ${owed}, but a ${record.occasion} consumption was recorded`,
        { orderLineId: fate.orderLineId, owedOccasion: owed, recordedOccasion: record.occasion },
      );
    }

    const existing = this.entries.get(record.orderLineId);
    if (existing !== undefined) {
      if (existing.commandId === record.commandId && existing.occasion === record.occasion) {
        // The same command arriving twice: one timeout, one retry, one
        // consumption. Nothing is entered and nothing is moved again.
        return 'replay';
      }
      throw new ConsumptionRefusal(
        'restaurant.consumption.occasion_repeated',
        `Line ${record.orderLineId} already consumed at ${existing.occasion} under command ${existing.commandId}; command ${record.commandId} would take its stock a second time`,
        {
          orderLineId: record.orderLineId,
          recordedOccasion: existing.occasion,
          recordedCommandId: existing.commandId,
          attemptedOccasion: record.occasion,
          attemptedCommandId: record.commandId,
        },
      );
    }

    this.entries.set(record.orderLineId, Object.freeze({ occasion: record.occasion, commandId: record.commandId, movementCount: record.movementCount }));
    return 'recorded';
  }

  /** The occasion this line consumed at, or null if it has not consumed. */
  occasionOf(orderLineId: string): ConsumptionOccasion | null {
    return this.entries.get(orderLineId)?.occasion ?? null;
  }

  hasConsumed(orderLineId: string): boolean {
    return this.entries.has(orderLineId);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Refuse a record that carries a cost or a value.
 *
 * Exported separately from the ledger because the same law binds anything the
 * pack hands the inventory authority, not only what it remembers afterwards.
 */
export function assertNoLocalValuation(record: ConsumptionRecord): void {
  const unexpected = Object.keys(record).filter((k) => !CONSUMPTION_RECORD_KEYS.includes(k));
  if (unexpected.length === 0) return;
  const valuation = unexpected.filter((k) => VALUATION_SPELLING.test(k));
  if (valuation.length > 0) {
    throw new ConsumptionRefusal(
      'restaurant.consumption.valuation_present',
      `Line ${record.orderLineId} carried ${valuation.join(', ')}; the restaurant pack states quantities, and the inventory authority states what they are worth`,
      { orderLineId: record.orderLineId, carriedKeys: valuation },
    );
  }
  throw new ConsumptionRefusal(
    'restaurant.consumption.record_field_unknown',
    `Line ${record.orderLineId} carried ${unexpected.join(', ')}, which this contract does not define; an unrecognised field is refused rather than ignored, because what it would have meant is unknown`,
    { orderLineId: record.orderLineId, carriedKeys: unexpected },
  );
}

/**
 * A refund of a COMPOSED line puts nothing back on the shelf.
 *
 * The dish was cooked: its ingredients are gone whether or not the guest paid
 * for it, and a return movement would restore stock that does not physically
 * exist. Refunding the MONEY is the Phase 4 returns and credit-note authority's
 * business and happens whatever this function says; what it refuses is the
 * INVENTORY half.
 *
 * A DIRECT line — a sealed bottle handed back unopened — genuinely can return
 * to stock, and that is the returns authority's existing rule, not a restaurant
 * rule. This pack neither restates nor overrides it, so a direct line is passed
 * through untouched rather than silently approved here.
 *
 * A merchant who does want a cooked dish's components back on the shelf records
 * a stock adjustment through the inventory authority, where it is a visible,
 * attributed decision rather than an automatic consequence of a refund.
 */
export function assertRefundRestocksNothing(fate: OrderLineFate, requestedReturnMovementCount: number): void {
  if (fate.mode !== 'composed') return;
  if (requestedReturnMovementCount > 0) {
    throw new ConsumptionRefusal(
      'restaurant.consumption.refund_restocks_composed',
      `A refund of composed line ${fate.orderLineId} requested ${requestedReturnMovementCount} return movement(s); a cooked dish's ingredients do not go back on the shelf`,
      { orderLineId: fate.orderLineId, requestedReturnMovementCount },
    );
  }
}
