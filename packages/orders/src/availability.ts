/**
 * The ADVISORY availability read — Phase 6 (`PREPARED / NOT PROMOTED`).
 *
 * ## This is advice, and the type says so
 *
 * There is no stock reservation in Phase 6 and this module creates none. The
 * master directive's PART 26 is explicit — "No second stock reservation ledger
 * without explicit architecture" — and the ONLY authority on whether stock
 * suffices is the atomic sale commit, which reads `stock_levels` and refuses
 * `inventory.insufficient_stock` inside the same transaction that would have
 * moved the quantity. Anything computed before that transaction is stale the
 * instant it is computed, so the result type is named `advisory` and carries
 * the flag rather than letting a caller mistake it for a guarantee.
 *
 * What it is FOR: telling a shopper, before they spend five minutes on a
 * checkout form, that six of something are not going to be there. That is
 * worth doing and is not worth a ledger.
 *
 * ## The two defects this fold is shaped to refuse
 *
 * 1. **Per-line checks are not a basket check.** Ten on hand, two lines of six
 *    each: both lines pass alone and the basket cannot be served. So the
 *    comparison is against the SUMMED position per stock key, never against a
 *    line, and the input is `BasketPosition[]` — the merged shape — rather than
 *    `CartLine[]`, so a caller cannot ask the wrong question.
 *
 * 2. **An untracked product is not out of stock.** A gift card has no stock
 *    row; `0` would read as "out of stock" and refuse a sale that is perfectly
 *    fine. So `onHand` is `null` for an untracked key and the verdict is
 *    `not_tracked`, exactly as `PosProductHitDto.onHand` is nullable for the
 *    same reason. A tracked key with no figure, or an untracked key WITH one,
 *    is a contradiction in the input and is refused loudly
 *    (`order.availability_tracking_inconsistent`) — never folded past with a
 *    silent `continue`, which is how a financial read loses a row.
 *
 * The subject set is exhaustive and pairwise disjoint: every basket position
 * gets exactly one verdict, an on-hand row for a key the basket does not name
 * is `order.availability_subject_unknown`, and a basket key with no row is
 * `order.availability_subject_missing`.
 */
import { formatQuantity, parseQuantity } from '@daftar/inventory';
import type { BasketPosition } from './cart';
import { OrderError } from './errors';

/** One stock key's on-hand figure, as the Phase 3 inventory read reports it. */
export interface StockOnHand {
  /** As produced by `stockKeyOf`. */
  stockKey: string;
  trackInventory: boolean;
  /** A decimal string for a tracked key, `null` for an untracked one. NEVER `"0"` to mean "untracked". */
  onHand: string | null;
}

/** `not_tracked` is neither sufficient nor insufficient: the question does not apply. */
export type AvailabilityVerdict = 'sufficient' | 'insufficient' | 'not_tracked';

/** What the advice says about one merged position. */
export interface PositionAvailabilityAdvice {
  stockKey: string;
  /** The SUMMED quantity the basket asks for. */
  requestedQuantity: string;
  onHand: string | null;
  verdict: AvailabilityVerdict;
  /** How much is missing, as a positive decimal string; `null` unless the verdict is `insufficient`. */
  shortfallQuantity: string | null;
}

/**
 * The whole basket's advice.
 *
 * `advisory` is a literal `true` rather than a comment, so a caller that
 * destructures this value carries the caveat into its own code and a reviewer
 * can grep for the places that consume it.
 */
export interface BasketAvailabilityAdvice {
  readonly advisory: true;
  items: readonly PositionAvailabilityAdvice[];
  /** `true` when at least one position is `insufficient`. Advice, not a refusal. */
  anyInsufficient: boolean;
}

export function adviseBasketAvailability(positions: readonly BasketPosition[], onHandRows: readonly StockOnHand[]): BasketAvailabilityAdvice {
  const byKey = new Map<string, StockOnHand>();
  for (const row of onHandRows) {
    if (byKey.has(row.stockKey)) {
      throw new OrderError('order.availability_tracking_inconsistent', 'two on-hand rows name one stock key', { stockKey: row.stockKey });
    }
    byKey.set(row.stockKey, row);
  }

  const requested = new Set(positions.map((p) => p.stockKey));
  for (const key of byKey.keys()) {
    if (!requested.has(key)) {
      throw new OrderError('order.availability_subject_unknown', 'an on-hand row was supplied for a stock key the basket does not name', { stockKey: key });
    }
  }

  const items: PositionAvailabilityAdvice[] = [];
  for (const position of positions) {
    const row = byKey.get(position.stockKey);
    if (row === undefined) {
      throw new OrderError('order.availability_subject_missing', 'no on-hand row was supplied for a stock key the basket names', {
        stockKey: position.stockKey,
      });
    }

    if (!row.trackInventory) {
      if (row.onHand !== null) {
        throw new OrderError('order.availability_tracking_inconsistent', 'an untracked stock key reported an on-hand figure', { stockKey: position.stockKey });
      }
      items.push({
        stockKey: position.stockKey,
        requestedQuantity: position.totalQuantity,
        onHand: null,
        verdict: 'not_tracked',
        shortfallQuantity: null,
      });
      continue;
    }

    if (row.onHand === null) {
      throw new OrderError('order.availability_tracking_inconsistent', 'a tracked stock key reported no on-hand figure', { stockKey: position.stockKey });
    }

    let onHandQ4: bigint;
    try {
      onHandQ4 = parseQuantity(row.onHand);
    } catch {
      throw new OrderError('order.availability_tracking_inconsistent', 'an on-hand figure is not an exact decimal at the supported scale', {
        stockKey: position.stockKey,
      });
    }

    const shortfall = position.totalQuantityQ4 - onHandQ4;
    items.push({
      stockKey: position.stockKey,
      requestedQuantity: position.totalQuantity,
      onHand: formatQuantity(onHandQ4),
      verdict: shortfall > 0n ? 'insufficient' : 'sufficient',
      shortfallQuantity: shortfall > 0n ? formatQuantity(shortfall) : null,
    });
  }

  return {
    advisory: true,
    items: Object.freeze(items),
    anyInsufficient: items.some((i) => i.verdict === 'insufficient'),
  };
}
