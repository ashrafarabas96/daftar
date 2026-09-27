/**
 * The supplier-return arithmetic (PHASE_3_S5_CONTRACT A-10, A-12; TL-3,
 * TL-10, TL-11, TL-12).
 *
 * A return takes goods out of ONE warehouse at that key's current average
 * (L:907) and gives back to the supplier the purchase's ORIGINAL carrying
 * value of what is returned. The two differ; the difference is purchase
 * price variance (6200). Everything here is exact integer arithmetic:
 * quantities are Q4, money is integer minor units (`*Txn*` in the purchase
 * currency, the rest in base), and every division is one HALF_EVEN
 * (`roundHalfEven`, the twin of `inventory_half_even`). Nothing here reads a
 * clock, a rate registry or the database.
 *
 * With the purchase's `T` (total txn), `B` (total base) and a line's
 * `t_i = net_i + landed_i` (TL-11), `qty_i`, and `Q_i` already returned:
 *
 * - (a) `carryingTxn`: `HALF_EVEN(t_i·(Q_i+q_i), qty_i) − HALF_EVEN(t_i·Q_i, qty_i)`
 *   — cumulative, so it is never negative and the returns of a whole line
 *   add up to exactly `t_i`. The naive `HALF_EVEN(t_i·q_i/qty_i)` plus a
 *   last-return flush can go negative after upward roundings; this cannot.
 * - (b) `C = Σ carrying_txn_i`.
 * - (c) `apSplit`: AP first, at purchase level (TL-10): `ap = min(C, O)`,
 *   `credit = C − ap`, where `O` is `purchase_ap_outstanding` (A-16).
 * - (d) `apBaseRelease`: the cumulative proportional release of `B` (DM
 *   §7ج), exact at clearing. `convert` is the 0043 law and belongs to
 *   `@daftar/accounting` (`convertToBaseMinor`), so it is an INPUT here; the
 *   dust line carries `ap_base − convert(ap)` (TL-3).
 * - (e) `I`: the stored `supplier_return` movement values, each at the
 *   return key's current average, or its exact flush at depletion
 *   (`outboundValue`, the primitive's rule).
 * - (f) `ppv = ap_base + credit_base − I`.
 * - (g) the five-line entry, each line present only when non-zero, balanced
 *   by construction.
 */
import { InventoryError, type InventoryErrorCode } from './errors';
import { QTY_LIMIT_Q4, VALUE_LIMIT_MINOR } from './fixed-point';
import { MAX_DOCUMENT_LINES } from './movement-payloads';
import { roundHalfEven } from './rounding';
import { applyMovement, outboundValue, type StockState } from './valuation';

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

function assertMinor(v: unknown, what: string, min: bigint): asserts v is bigint {
  if (typeof v !== 'bigint' || v < min || v > VALUE_LIMIT_MINOR) refuse('inventory.arithmetic_invalid', `${what} must be an integer amount within range`);
}

function assertQ4(v: unknown, what: string, min: bigint): asserts v is bigint {
  if (typeof v !== 'bigint' || v < min || v >= QTY_LIMIT_Q4) refuse('inventory.quantity_invalid', `${what} must be a quantity within range`);
}

/**
 * A-10(a): the carrying value, in txn minor units, of returning `returnQ4`
 * of a purchase line of `purchasedQ4` whose `t_i` is `lineTotalTxnMinor`,
 * after `returnedBeforeQ4` has already been returned. A cumulative quantity
 * above the purchased one is `supplier_return.quantity_exceeds_purchased`
 * (Must-prove 1).
 */
export function carryingTxn(lineTotalTxnMinor: bigint, purchasedQ4: bigint, returnedBeforeQ4: bigint, returnQ4: bigint): bigint {
  assertMinor(lineTotalTxnMinor, 'a line total', 0n);
  assertQ4(purchasedQ4, 'a purchased quantity', 1n);
  assertQ4(returnedBeforeQ4, 'a returned quantity', 0n);
  assertQ4(returnQ4, 'a return quantity', 1n);
  if (returnedBeforeQ4 + returnQ4 > purchasedQ4) {
    refuse('supplier_return.quantity_exceeds_purchased', 'the returned quantity would exceed the purchased quantity of the line');
  }
  return roundHalfEven(lineTotalTxnMinor * (returnedBeforeQ4 + returnQ4), purchasedQ4) - roundHalfEven(lineTotalTxnMinor * returnedBeforeQ4, purchasedQ4);
}

/** A-10(c): AP first. `apTxnMinor = min(C, O)`, the rest a supplier credit. */
export function apSplit(carryingTxnMinor: bigint, outstandingTxnMinor: bigint): { readonly apTxnMinor: bigint; readonly creditTxnMinor: bigint } {
  assertMinor(carryingTxnMinor, 'a carrying value', 0n);
  assertMinor(outstandingTxnMinor, 'an outstanding AP', 0n);
  const apTxnMinor = carryingTxnMinor < outstandingTxnMinor ? carryingTxnMinor : outstandingTxnMinor;
  return { apTxnMinor, creditTxnMinor: carryingTxnMinor - apTxnMinor };
}

/**
 * A-10(d): the base AP a release of `apTxnMinor` takes off a purchase of
 * totals `T`/`B` whose outstanding txn AP is `O`:
 * `HALF_EVEN(B·(T−O+ap), T) − HALF_EVEN(B·(T−O), T)`. Releasing the whole
 * remaining txn AP (`ap = O`) releases exactly the whole remaining base AP.
 */
export function apBaseRelease(totalBaseMinor: bigint, totalTxnMinor: bigint, outstandingTxnMinor: bigint, apTxnMinor: bigint): bigint {
  assertMinor(totalBaseMinor, 'a purchase base total', 1n);
  assertMinor(totalTxnMinor, 'a purchase txn total', 1n);
  assertMinor(outstandingTxnMinor, 'an outstanding AP', 0n);
  assertMinor(apTxnMinor, 'an AP release', 0n);
  if (outstandingTxnMinor > totalTxnMinor) refuse('inventory.arithmetic_invalid', 'the outstanding AP exceeds the purchase total');
  if (apTxnMinor > outstandingTxnMinor) refuse('inventory.arithmetic_invalid', 'an AP release exceeds the outstanding AP');
  const released = totalTxnMinor - outstandingTxnMinor;
  return roundHalfEven(totalBaseMinor * (released + apTxnMinor), totalTxnMinor) - roundHalfEven(totalBaseMinor * released, totalTxnMinor);
}

/** A-10(f): `ap_base + credit_base − I`. Positive credits 6200, negative debits it. */
export function ppv(apBaseMinor: bigint, creditBaseMinor: bigint, inventoryValueMinor: bigint): bigint {
  assertMinor(apBaseMinor, 'a base AP release', 0n);
  assertMinor(creditBaseMinor, 'a credit base', 0n);
  assertMinor(inventoryValueMinor, 'an inventory value', 0n);
  return apBaseMinor + creditBaseMinor - inventoryValueMinor;
}

// ── The whole return ─────────────────────────────────────────────────────

/**
 * The 0043 conversion of a POSITIVE txn amount to base minor units at the
 * purchase's snapshot rate — `convertToBaseMinor` of `@daftar/accounting`,
 * bound to the purchase currency, the base currency and the stored rate. The
 * plan never calls it with zero.
 */
export type ConvertTxnToBase = (txnMinor: bigint) => bigint;

export interface SupplierReturnLineInput {
  /** `t_i = net_txn_minor + landed_cost_txn_minor` of the purchase line (TL-11). */
  readonly lineTotalTxnMinor: bigint;
  readonly purchasedQ4: bigint;
  /** `Q_i`: the quantity of the line earlier returns took. */
  readonly returnedBeforeQ4: bigint;
  /** `q_i` > 0. */
  readonly returnQ4: bigint;
  /**
   * The return warehouse's key for the line's variant, as locked before the
   * movement (an absent key is `EMPTY_STOCK_STATE`). A purchase has one line
   * per variant and a return one warehouse (TL-6), so every line is its own key.
   */
  readonly stock: StockState;
}

export interface SupplierReturnPlanInput {
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  /** `O = purchase_ap_outstanding(business, purchase)` (A-16). */
  readonly outstandingTxnMinor: bigint;
  readonly convert: ConvertTxnToBase;
  /** In `line_no` order. */
  readonly lines: readonly SupplierReturnLineInput[];
}

/** The amounts a return binds into its `purchase.return` payload and stores on its header (A-17, §2.2). */
export interface SupplierReturnAmounts {
  readonly carryingTxnMinor: bigint;
  readonly apTxnMinor: bigint;
  readonly apBaseMinor: bigint;
  readonly creditTxnMinor: bigint;
  readonly creditBaseMinor: bigint;
  readonly inventoryValueMinor: bigint;
  /** Signed. */
  readonly ppvMinor: bigint;
}

export interface SupplierReturnLinePlan {
  readonly carryingTxnMinor: bigint;
  /** `−` the stored movement value: ≥ 0. */
  readonly valueOutMinor: bigint;
  /** The average the movement is valued at (`supplier_return_lines.unit_cost_base_minor`), C10. */
  readonly unitCostSnapshotC10: bigint;
  readonly stockAfter: StockState;
}

/** The system accounts an S5 return entry may touch; never 6100, revenue or tax (A-05, A-14). */
export type SupplierReturnAccount = 'accounts_payable' | 'supplier_receivable' | 'inventory' | 'purchase_price_variance';

/**
 * One line of the A-10(g) entry.
 *
 * - `currency: 'purchase'`: txn in the purchase currency at the purchase's
 *   snapshot rate, source and instant (lines 1 and 3); `'base'`: the base
 *   currency at rate 1 (lines 2, 4 and 5).
 * - `dimension: 'purchase'`: the purchase warehouse's home branch and no
 *   warehouse (AP and 1150); `'return'`: the return warehouse and its home
 *   branch (inventory and PPV).
 */
export interface SupplierReturnEntryLine {
  readonly systemKey: SupplierReturnAccount;
  readonly side: 'D' | 'C';
  readonly currency: 'purchase' | 'base';
  readonly txnAmountMinor: bigint;
  readonly baseAmountMinor: bigint;
  readonly dimension: 'purchase' | 'return';
}

export interface SupplierReturnPlan extends SupplierReturnAmounts {
  /** `convert(ap_txn)`, the base amount of entry line 1; 0 when `ap_txn = 0`. */
  readonly apConvertedMinor: bigint;
  /** `ap_base − convert(ap_txn)`, signed; 0 for a domestic purchase (TL-3). */
  readonly apDustBaseMinor: bigint;
  /** A credit note is issued iff `credit_txn > 0` (A-11(a)). */
  readonly creditNote: boolean;
  readonly lines: readonly SupplierReturnLinePlan[];
  readonly entryLines: readonly SupplierReturnEntryLine[];
}

function convertPositive(convert: ConvertTxnToBase, txnMinor: bigint): bigint {
  if (txnMinor === 0n) return 0n;
  const base = convert(txnMinor);
  if (typeof base !== 'bigint' || base < 0n || base > VALUE_LIMIT_MINOR)
    refuse('inventory.arithmetic_invalid', 'a conversion must yield a base amount within range');
  if (base === 0n) refuse('supplier_return.amount_below_base_unit', 'a returned amount converts to less than one base minor unit');
  return base;
}

/**
 * A-10(g): the entry lines of a return, in order, each only when its amount
 * is non-zero. Balanced by construction: `convert(ap) + dust + credit_base −
 * I − ppv = 0`, and asserted.
 */
export function supplierReturnEntryLines(
  a: Pick<
    SupplierReturnPlan,
    'apTxnMinor' | 'apConvertedMinor' | 'apDustBaseMinor' | 'creditTxnMinor' | 'creditBaseMinor' | 'inventoryValueMinor' | 'ppvMinor'
  >,
): SupplierReturnEntryLine[] {
  const out: SupplierReturnEntryLine[] = [];
  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  if (a.apTxnMinor !== 0n) {
    out.push({
      systemKey: 'accounts_payable',
      side: 'D',
      currency: 'purchase',
      txnAmountMinor: a.apTxnMinor,
      baseAmountMinor: a.apConvertedMinor,
      dimension: 'purchase',
    });
  }
  if (a.apDustBaseMinor !== 0n) {
    const dust = abs(a.apDustBaseMinor);
    out.push({
      systemKey: 'accounts_payable',
      side: a.apDustBaseMinor > 0n ? 'D' : 'C',
      currency: 'base',
      txnAmountMinor: dust,
      baseAmountMinor: dust,
      dimension: 'purchase',
    });
  }
  if (a.creditTxnMinor !== 0n) {
    out.push({
      systemKey: 'supplier_receivable',
      side: 'D',
      currency: 'purchase',
      txnAmountMinor: a.creditTxnMinor,
      baseAmountMinor: a.creditBaseMinor,
      dimension: 'purchase',
    });
  }
  if (a.inventoryValueMinor !== 0n) {
    out.push({
      systemKey: 'inventory',
      side: 'C',
      currency: 'base',
      txnAmountMinor: a.inventoryValueMinor,
      baseAmountMinor: a.inventoryValueMinor,
      dimension: 'return',
    });
  }
  if (a.ppvMinor !== 0n) {
    const v = abs(a.ppvMinor);
    out.push({
      systemKey: 'purchase_price_variance',
      side: a.ppvMinor > 0n ? 'C' : 'D',
      currency: 'base',
      txnAmountMinor: v,
      baseAmountMinor: v,
      dimension: 'return',
    });
  }
  let balance = 0n;
  for (const l of out) {
    if (l.baseAmountMinor <= 0n) refuse('inventory.arithmetic_invalid', 'an entry line carries a positive base amount');
    balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  if (balance !== 0n || !out.some((l) => l.side === 'D')) refuse('inventory.arithmetic_invalid', 'a supplier return entry must balance with a debit');
  return out;
}

/**
 * The whole A-10 computation of one return, in the routine's order (§2.5
 * steps 9–13): the cumulative quantity bound and the carrying values, AP
 * first, the base release and conversions (TL-3), the stock bound and the
 * movement values at the return key's average, then the zero refusal
 * (TL-12) and PPV. Returns every amount the service binds and the routine
 * stores, and the entry lines they imply.
 */
export function planSupplierReturn(input: SupplierReturnPlanInput): SupplierReturnPlan {
  if (input.lines.length === 0) refuse('inventory.lines_required', 'a return needs at least one line');
  if (input.lines.length > MAX_DOCUMENT_LINES) refuse('inventory.payload_invalid', `a return has at most ${MAX_DOCUMENT_LINES} lines`);
  if (typeof input.convert !== 'function') refuse('inventory.arithmetic_invalid', 'a return needs the purchase conversion');

  // (a), (b): the quantity bound first, for every line.
  const carrying = input.lines.map((l) => carryingTxn(l.lineTotalTxnMinor, l.purchasedQ4, l.returnedBeforeQ4, l.returnQ4));
  const carryingTxnMinor = carrying.reduce((a, b) => a + b, 0n);
  assertMinor(carryingTxnMinor, 'a return carrying value', 0n);

  // (c), (d): AP first, the base release, the conversions and the dust.
  const { apTxnMinor, creditTxnMinor } = apSplit(carryingTxnMinor, input.outstandingTxnMinor);
  const apBaseMinor = apBaseRelease(input.totalBaseMinor, input.totalTxnMinor, input.outstandingTxnMinor, apTxnMinor);
  const apConvertedMinor = convertPositive(input.convert, apTxnMinor);
  const creditBaseMinor = convertPositive(input.convert, creditTxnMinor);
  const apDustBaseMinor = apBaseMinor - apConvertedMinor;

  // (e): each line leaves its own key at that key's average (or flushes it).
  const lines = input.lines.map((l, i): SupplierReturnLinePlan => {
    const { value, unitCostSnapshot } = outboundValue(l.stock, -l.returnQ4);
    return {
      carryingTxnMinor: carrying[i] ?? 0n,
      valueOutMinor: -value,
      unitCostSnapshotC10: unitCostSnapshot,
      stockAfter: applyMovement(l.stock, -l.returnQ4, value),
    };
  });
  const inventoryValueMinor = lines.reduce((a, l) => a + l.valueOutMinor, 0n);
  assertMinor(inventoryValueMinor, 'a return inventory value', 0n);

  // TL-12: an entry needs a positive debit.
  if (carryingTxnMinor === 0n && inventoryValueMinor === 0n)
    refuse('supplier_return.value_zero', 'a return with no carrying value and no inventory value posts nothing');

  // (f), (g).
  const ppvMinor = ppv(apBaseMinor, creditBaseMinor, inventoryValueMinor);
  const amounts = { apTxnMinor, apConvertedMinor, apDustBaseMinor, creditTxnMinor, creditBaseMinor, inventoryValueMinor, ppvMinor };
  return {
    carryingTxnMinor,
    apTxnMinor,
    apBaseMinor,
    apConvertedMinor,
    apDustBaseMinor,
    creditTxnMinor,
    creditBaseMinor,
    inventoryValueMinor,
    ppvMinor,
    creditNote: creditTxnMinor > 0n,
    lines,
    entryLines: supplierReturnEntryLines(amounts),
  };
}
