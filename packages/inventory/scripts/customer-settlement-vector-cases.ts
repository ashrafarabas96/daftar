/**
 * The P4-S4 customer-settlement vectors, as pure functions — the receivable
 * mirror of `s6-vector-cases.ts`' supplier half (§4.1, map §8.7).
 *
 * `scripts/generate-customer-settlement-vectors.ts` writes
 * `vectors/customer-settlement-vectors.json`: the AR settlement arithmetic of
 * `src/customer-settlement.ts` end to end — invoices and customer credits,
 * then a SEQUENCE of settlements, each starting from what the previous
 * accepted one stored, with every primitive call the steps made.
 *
 * The recorded primitive names are the SQL ones —
 * `supplier_convert_base`, `supplier_ap_release` and
 * `supplier_credit_remaining_carrying` (`0067:671/683/696`) — because those
 * are the functions this arithmetic CALLS. The `supplier_` in the names is
 * historical: the bodies are plain `BIGINT` half-even arithmetic over
 * `(total, carrying, level, amount)` and are declared `IMMUTABLE` over
 * scalars. Recording them under their real names is what lets the SQL side be
 * held to these very numbers, exactly as the supplier vectors do, and is the
 * file-level proof that there is no second body of the arithmetic.
 *
 * Every number in the file is COMPUTED by the package; nothing is copied by
 * hand. Where a case exists to show a property — exact clearing, a dust line
 * of each sign, the MIN1 floor, the residue law, the closure law, a stable
 * refusal — the generator holds the computation to that LITERAL through
 * `check()` and refuses to write a file in which they disagree.
 *
 * Every integer is decimal TEXT, because a value may exceed 2^53.
 */
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  CUSTOMER_PAYMENT_MAX_ALLOCATIONS,
  ReceivableArithmeticError,
  planCustomerCreditApplication,
  planCustomerCreditCreation,
  planCustomerPayment,
  planCustomerPaymentAllocation,
  type CustomerCreditState,
  type InvoiceArState,
  type ReceivableConversion,
  type ReceivableEntryLine,
} from '../src/customer-settlement';
import { InventoryError } from '../src/errors';
import { formatMinor } from '../src/fixed-point';
import { apRelease, convertToBase, creditRemainingCarrying } from '../src/supplier-settlement';

// ── Common helpers (the `s6-vector-cases.ts` shapes) ─────────────────────

function jsonable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  return value;
}

async function renderJson(value: unknown, file: string): Promise<string> {
  const options = (await resolveConfig(join(__dirname, '..', 'vectors', file))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, parser: 'json' });
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`vector spec disagreement: ${message}`);
}

/** The code a refusal carries, or 'accepted'. Both error types: the primitives raise `InventoryError`. */
function attempt<R>(fn: () => R): { readonly outcome: string; readonly value: R | null } {
  try {
    return { outcome: 'accepted', value: fn() };
  } catch (e) {
    if (e instanceof ReceivableArithmeticError || e instanceof InventoryError) return { outcome: e.code, value: null };
    throw e;
  }
}

/** R10 of a ten-decimal rate text, exactly. */
function r10(rate: string): bigint {
  const m = /^(\d+)\.(\d{10})$/.exec(rate);
  if (m === null) throw new Error(`a vector rate must have ten fraction digits: ${rate}`);
  return BigInt(`${m[1] ?? ''}${m[2] ?? ''}`);
}

// ── The spec of a case ───────────────────────────────────────────────────

interface CurrencySpec {
  readonly code: string;
  readonly exponent: number;
}

interface InvoiceSpec {
  readonly currency: CurrencySpec;
  /** Ten-decimal text: the invoice's own stored `source_to_base_rate`. */
  readonly rate: string;
  readonly totalTxnMinor: bigint;
  /**
   * AR a prior reducer released before the case's steps: `O` starts at
   * `T − this`, its carrying base released by `apRelease(B, T, 0, this)`. The
   * mirror of `PurchaseSpec.returnedApTxnMinor`.
   */
  readonly releasedArTxnMinor?: bigint;
}

interface CreditSpec {
  readonly currency: CurrencySpec;
  readonly rate: string;
  readonly originalMinor: bigint;
}

type StepSpec =
  | {
      readonly kind: 'payment_allocation';
      readonly invoice: string;
      readonly currency: CurrencySpec;
      readonly rate: string;
      readonly paymentAmountMinor: bigint;
      readonly appliedMinor: bigint;
    }
  | { readonly kind: 'credit_application'; readonly invoice: string; readonly credit: string; readonly consumedMinor: bigint; readonly appliedMinor: bigint }
  | { readonly kind: 'credit_creation'; readonly currency: CurrencySpec; readonly rate: string; readonly surplusMinor: bigint }
  | {
      readonly kind: 'payment';
      readonly currency: CurrencySpec;
      readonly rate: string;
      readonly amountMinor: bigint;
      readonly legs: readonly { readonly invoice: string; readonly paymentAmountMinor: bigint; readonly appliedMinor: bigint }[];
    };

interface CaseSpec {
  readonly id: string;
  readonly why: string;
  readonly base: CurrencySpec;
  readonly invoices: Readonly<Record<string, InvoiceSpec>>;
  readonly credits: Readonly<Record<string, CreditSpec>>;
  readonly steps: readonly StepSpec[];
  /** Literals the computation must reproduce, checked after the case runs. */
  readonly expect: (r: CaseResult) => void;
}

/** One primitive call a step made, as the SQL function takes it. */
export interface PrimitiveCall {
  readonly fn: 'supplier_convert_base' | 'supplier_ap_release' | 'supplier_credit_remaining_carrying';
  readonly args: readonly (string | number)[];
  readonly result: string;
}

export interface StepResult {
  readonly step: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly plan: Readonly<Record<string, unknown>> | null;
  readonly entry: readonly ReceivableEntryLine[] | null;
  readonly primitives: readonly PrimitiveCall[];
  readonly after: Readonly<Record<string, unknown>>;
}

interface CaseResult {
  readonly steps: readonly StepResult[];
  readonly invoices: ReadonlyMap<string, { outstanding: bigint; releasedBase: bigint; totalBase: bigint }>;
  readonly credits: ReadonlyMap<string, { remaining: bigint; remainingCarrying: bigint; original: bigint; originalCarrying: bigint }>;
}

export interface CustomerSettlementVectorCase {
  readonly id: string;
  readonly why: string;
  readonly base: CurrencySpec;
  readonly invoices: Readonly<Record<string, unknown>>;
  readonly credits: Readonly<Record<string, unknown>>;
  readonly steps: readonly StepResult[];
}

export interface CustomerSettlementVectors {
  readonly version: string;
  readonly note: string;
  readonly cases: readonly CustomerSettlementVectorCase[];
}

const ILS: CurrencySpec = { code: 'ILS', exponent: 2 };
const USD: CurrencySpec = { code: 'USD', exponent: 2 };
const EUR: CurrencySpec = { code: 'EUR', exponent: 2 };
const JOD: CurrencySpec = { code: 'JOD', exponent: 3 };
const LBP: CurrencySpec = { code: 'LBP', exponent: 2 };

function conversionOf(currency: CurrencySpec, rate: string, base: CurrencySpec): ReceivableConversion {
  return { rateR10: r10(rate), txnExponent: currency.exponent, baseExponent: base.exponent };
}

// ── The driver ───────────────────────────────────────────────────────────

function runCase(c: CaseSpec): { vector: CustomerSettlementVectorCase; result: CaseResult } {
  const invoices = new Map<string, { spec: InvoiceSpec; totalBase: bigint; outstanding: bigint; releasedBase: bigint }>();
  const invoiceOut: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(c.invoices)) {
    const totalBase = convertToBase(v.totalTxnMinor, r10(v.rate), v.currency.exponent, c.base.exponent);
    const released = v.releasedArTxnMinor ?? 0n;
    invoices.set(name, { spec: v, totalBase, outstanding: v.totalTxnMinor - released, releasedBase: apRelease(totalBase, v.totalTxnMinor, 0n, released) });
    invoiceOut[name] = {
      currency: v.currency,
      rate: v.rate,
      totalTxnMinor: v.totalTxnMinor,
      totalBaseMinor: totalBase,
      ...(v.releasedArTxnMinor === undefined ? {} : { releasedArTxnMinor: v.releasedArTxnMinor }),
    };
  }
  const credits = new Map<string, { spec: CreditSpec; originalCarrying: bigint; remaining: bigint; remainingCarrying: bigint }>();
  const creditOut: Record<string, unknown> = {};
  for (const [name, n] of Object.entries(c.credits)) {
    const originalCarrying = convertToBase(n.originalMinor, r10(n.rate), n.currency.exponent, c.base.exponent);
    credits.set(name, { spec: n, originalCarrying, remaining: n.originalMinor, remainingCarrying: originalCarrying });
    creditOut[name] = { currency: n.currency, rate: n.rate, originalMinor: n.originalMinor, originalCarryingMinor: originalCarrying };
  }
  const get = <V>(m: Map<string, V>, k: string): V => {
    const v = m.get(k);
    if (v === undefined) throw new Error(`${c.id}: unknown ${k}`);
    return v;
  };
  const arState = (name: string): InvoiceArState => {
    const v = get(invoices, name);
    return {
      totalTxnMinor: v.spec.totalTxnMinor,
      totalBaseMinor: v.totalBase,
      outstandingTxnMinor: v.outstanding,
      conversion: conversionOf(v.spec.currency, v.spec.rate, c.base),
    };
  };
  const creditState = (name: string): CustomerCreditState => {
    const n = get(credits, name);
    return {
      originalMinor: n.spec.originalMinor,
      originalCarryingMinor: n.originalCarrying,
      remainingMinor: n.remaining,
      conversion: conversionOf(n.spec.currency, n.spec.rate, c.base),
    };
  };

  // Each helper records ONE call into the SQL primitive the arithmetic calls.
  const conv = (x: bigint, cur: CurrencySpec, rate: string): PrimitiveCall => ({
    fn: 'supplier_convert_base',
    args: [formatMinor(x), rate, cur.exponent, c.base.exponent],
    result: formatMinor(convertToBase(x, r10(rate), cur.exponent, c.base.exponent)),
  });
  const rel = (name: string, applied: bigint): PrimitiveCall => {
    const v = get(invoices, name);
    const x = v.spec.totalTxnMinor - v.outstanding;
    return {
      fn: 'supplier_ap_release',
      args: [formatMinor(v.totalBase), formatMinor(v.spec.totalTxnMinor), formatMinor(x), formatMinor(applied)],
      result: formatMinor(apRelease(v.totalBase, v.spec.totalTxnMinor, x, applied)),
    };
  };
  const g = (name: string, r: bigint): PrimitiveCall => {
    const n = get(credits, name);
    return {
      fn: 'supplier_credit_remaining_carrying',
      args: [formatMinor(n.spec.originalMinor), formatMinor(n.originalCarrying), formatMinor(r)],
      result: formatMinor(creditRemainingCarrying(n.spec.originalMinor, n.originalCarrying, r)),
    };
  };

  const steps: StepResult[] = [];
  for (const s of c.steps) {
    if (s.kind === 'payment_allocation') {
      const v = get(invoices, s.invoice);
      const primitives: PrimitiveCall[] = [conv(s.appliedMinor, v.spec.currency, v.spec.rate), conv(s.paymentAmountMinor, s.currency, s.rate)];
      if (s.appliedMinor <= v.outstanding) primitives.unshift(rel(s.invoice, s.appliedMinor));
      const r = attempt(() =>
        planCustomerPaymentAllocation({
          invoice: arState(s.invoice),
          sameCurrency: s.currency.code === v.spec.currency.code,
          paymentAmountMinor: s.paymentAmountMinor,
          payment: conversionOf(s.currency, s.rate, c.base),
          appliedMinor: s.appliedMinor,
        }),
      );
      const p = r.value;
      if (p !== null) {
        v.outstanding -= p.invoiceAmountAppliedMinor;
        v.releasedBase += p.invoiceCarryingReleasedMinor;
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          p === null
            ? null
            : {
                paymentAmountMinor: p.paymentAmountMinor,
                paymentBaseMinor: p.paymentBaseMinor,
                invoiceAmountAppliedMinor: p.invoiceAmountAppliedMinor,
                arReleasedBeforeMinor: p.arReleasedBeforeMinor,
                invoiceCarryingReleasedMinor: p.invoiceCarryingReleasedMinor,
                arConvertedMinor: p.arConvertedMinor,
                arDustBaseMinor: p.arDustBaseMinor,
                realizedFxMinor: p.realizedFxMinor,
              },
        entry: p?.entryLines ?? null,
        primitives,
        after: { invoice: s.invoice, outstandingTxnMinor: v.outstanding, remainingBaseMinor: v.totalBase - v.releasedBase },
      });
    } else if (s.kind === 'credit_application') {
      const v = get(invoices, s.invoice);
      const n = get(credits, s.credit);
      const primitives: PrimitiveCall[] = [conv(s.appliedMinor, v.spec.currency, v.spec.rate), conv(s.consumedMinor, n.spec.currency, n.spec.rate)];
      if (s.appliedMinor <= v.outstanding) primitives.unshift(rel(s.invoice, s.appliedMinor));
      if (s.consumedMinor <= n.remaining) primitives.push(g(s.credit, n.remaining), g(s.credit, n.remaining - s.consumedMinor));
      const r = attempt(() =>
        planCustomerCreditApplication({
          invoice: arState(s.invoice),
          credit: creditState(s.credit),
          sameCurrency: n.spec.currency.code === v.spec.currency.code,
          consumedMinor: s.consumedMinor,
          appliedMinor: s.appliedMinor,
        }),
      );
      const p = r.value;
      if (p !== null) {
        v.outstanding -= p.invoiceAmountAppliedMinor;
        v.releasedBase += p.invoiceCarryingReleasedMinor;
        n.remaining = p.remainingAfterMinor;
        n.remainingCarrying = p.remainingCarryingAfterMinor;
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          p === null
            ? null
            : {
                creditAmountConsumedMinor: p.creditAmountConsumedMinor,
                creditRemainingBeforeMinor: p.creditRemainingBeforeMinor,
                creditCarryingReleasedMinor: p.creditCarryingReleasedMinor,
                creditConvertedMinor: p.creditConvertedMinor,
                creditDustBaseMinor: p.creditDustBaseMinor,
                invoiceAmountAppliedMinor: p.invoiceAmountAppliedMinor,
                arReleasedBeforeMinor: p.arReleasedBeforeMinor,
                invoiceCarryingReleasedMinor: p.invoiceCarryingReleasedMinor,
                arConvertedMinor: p.arConvertedMinor,
                arDustBaseMinor: p.arDustBaseMinor,
                realizedFxMinor: p.realizedFxMinor,
              },
        entry: p?.entryLines ?? null,
        primitives,
        after: {
          invoice: s.invoice,
          outstandingTxnMinor: v.outstanding,
          remainingBaseMinor: v.totalBase - v.releasedBase,
          credit: s.credit,
          remainingMinor: n.remaining,
          remainingCarryingMinor: n.remainingCarrying,
        },
      });
    } else if (s.kind === 'credit_creation') {
      const primitives: PrimitiveCall[] = [conv(s.surplusMinor, s.currency, s.rate)];
      const r = attempt(() => planCustomerCreditCreation({ surplusMinor: s.surplusMinor, payment: conversionOf(s.currency, s.rate, c.base) }));
      const p = r.value;
      // `g(OA) = OB` at birth: the identity the module asserts rather than assumes.
      if (p !== null) {
        primitives.push({
          fn: 'supplier_credit_remaining_carrying',
          args: [formatMinor(p.originalAmountMinor), formatMinor(p.originalCarryingBaseMinor), formatMinor(p.originalAmountMinor)],
          result: formatMinor(creditRemainingCarrying(p.originalAmountMinor, p.originalCarryingBaseMinor, p.originalAmountMinor)),
        });
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan: p === null ? null : { originalAmountMinor: p.originalAmountMinor, originalCarryingBaseMinor: p.originalCarryingBaseMinor },
        entry: p?.entryLines ?? null,
        primitives,
        after: {},
      });
    } else {
      const primitives: PrimitiveCall[] = [];
      for (const leg of s.legs) {
        const v = get(invoices, leg.invoice);
        if (leg.appliedMinor <= v.outstanding) primitives.push(rel(leg.invoice, leg.appliedMinor));
        primitives.push(conv(leg.appliedMinor, v.spec.currency, v.spec.rate), conv(leg.paymentAmountMinor, s.currency, s.rate));
      }
      const allocated = s.legs.reduce((sum, l) => sum + l.paymentAmountMinor, 0n);
      if (s.amountMinor - allocated > 0n) primitives.push(conv(s.amountMinor - allocated, s.currency, s.rate));
      const r = attempt(() =>
        planCustomerPayment({
          amountMinor: s.amountMinor,
          payment: conversionOf(s.currency, s.rate, c.base),
          legs: s.legs.map((leg) => ({
            invoice: arState(leg.invoice),
            sameCurrency: s.currency.code === get(invoices, leg.invoice).spec.currency.code,
            paymentAmountMinor: leg.paymentAmountMinor,
            appliedMinor: leg.appliedMinor,
          })),
        }),
      );
      const p = r.value;
      if (p !== null) {
        for (const [i, leg] of s.legs.entries()) {
          const v = get(invoices, leg.invoice);
          const a = p.allocations[i];
          if (a === undefined) throw new Error(`${c.id}: leg ${i} planned no allocation`);
          v.outstanding -= a.invoiceAmountAppliedMinor;
          v.releasedBase += a.invoiceCarryingReleasedMinor;
        }
      }
      steps.push({
        step: s,
        outcome: r.outcome,
        plan:
          p === null
            ? null
            : {
                allocationCount: p.allocations.length,
                allocationPaymentAmountsMinor: p.allocations.map((a) => a.paymentAmountMinor),
                allocationPaymentBaseMinor: p.allocations.map((a) => a.paymentBaseMinor),
                surplusMinor: p.surplusMinor,
                creditOriginalAmountMinor: p.credit?.originalAmountMinor ?? null,
                creditOriginalCarryingBaseMinor: p.credit?.originalCarryingBaseMinor ?? null,
                baseAmountMinor: p.baseAmountMinor,
              },
        entry: p?.credit?.entryLines ?? null,
        primitives,
        after: Object.fromEntries(s.legs.map((leg) => [leg.invoice, { outstandingTxnMinor: get(invoices, leg.invoice).outstanding }])),
      });
    }
  }
  const result: CaseResult = {
    steps,
    invoices: new Map([...invoices].map(([k, v]) => [k, { outstanding: v.outstanding, releasedBase: v.releasedBase, totalBase: v.totalBase }])),
    credits: new Map(
      [...credits].map(([k, n]) => [
        k,
        { remaining: n.remaining, remainingCarrying: n.remainingCarrying, original: n.spec.originalMinor, originalCarrying: n.originalCarrying },
      ]),
    ),
  };
  c.expect(result);
  return {
    vector: jsonable({ id: c.id, why: c.why, base: c.base, invoices: invoiceOut, credits: creditOut, steps }) as CustomerSettlementVectorCase,
    result,
  };
}

const planOf = (r: CaseResult, i: number): Readonly<Record<string, unknown>> => {
  const p = r.steps[i]?.plan;
  if (p === null || p === undefined) throw new Error(`step ${i + 1} was refused`);
  return p;
};
const outcomes = (r: CaseResult): string[] => r.steps.map((s) => s.outcome);
const accountsOf = (r: CaseResult, i: number): string[] => (r.steps[i]?.entry ?? []).map((l) => `${l.side} ${l.account} ${l.baseAmountMinor}`);

// ── The cases ────────────────────────────────────────────────────────────

const CASES: readonly CaseSpec[] = [
  {
    id: 'AR-THIRDS-EXACT-CLEARING',
    why: 'a 1.00 USD invoice carried at 3.65 ILS, collected in USD thirds at 3.70: the cumulative releases 120, 121, 124 sum to the whole 365, nothing is stranded and nothing is invented',
    base: ILS,
    invoices: { I1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 100n } },
    credits: {},
    steps: [
      { kind: 'payment_allocation', invoice: 'I1', currency: EUR, rate: '3.7000000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment_allocation', invoice: 'I1', currency: EUR, rate: '3.7000000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment_allocation', invoice: 'I1', currency: EUR, rate: '3.7000000000', paymentAmountMinor: 34n, appliedMinor: 34n },
    ],
    expect: (r) => {
      check(
        outcomes(r).every((o) => o === 'accepted'),
        'all three thirds are accepted',
      );
      check(planOf(r, 0)['invoiceCarryingReleasedMinor'] === 120n, 'the first third releases 120');
      check(planOf(r, 1)['invoiceCarryingReleasedMinor'] === 121n, 'the second third releases 121');
      check(planOf(r, 2)['invoiceCarryingReleasedMinor'] === 124n, 'the final third releases 124');
      check(planOf(r, 1)['arDustBaseMinor'] === 1n, 'the second third carries one minor unit of dust');
      const i = r.invoices.get('I1');
      check(i?.outstanding === 0n, 'the invoice is cleared');
      check(i?.releasedBase === 365n && i.releasedBase === i.totalBase, 'the releases are exactly B');
    },
  },
  {
    id: 'FOREIGN-AR-DUST',
    why: 'a 0.03 USD invoice carried at 11 ILS: the middle reducer releases 3 against a conversion of 4, so the dust is NEGATIVE and takes the opposite side on the same account; the three releases still sum to 11',
    base: ILS,
    invoices: { I1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 3n } },
    credits: {},
    steps: [
      { kind: 'payment_allocation', invoice: 'I1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
      { kind: 'payment_allocation', invoice: 'I1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
      { kind: 'payment_allocation', invoice: 'I1', currency: ILS, rate: '1.0000000000', paymentAmountMinor: 4n, appliedMinor: 1n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['arDustBaseMinor'] === 0n, 'the first reducer has no dust');
      check(planOf(r, 1)['arDustBaseMinor'] === -1n, 'the second reducer carries a NEGATIVE dust');
      check(planOf(r, 1)['invoiceCarryingReleasedMinor'] === 3n && planOf(r, 1)['arConvertedMinor'] === 4n, 'rel 3 against conv 4');
      check(accountsOf(r, 1).includes('D accounts_receivable 1'), 'a negative dust DEBITS the same account');
      check(accountsOf(r, 0).includes('C accounts_receivable 4'), 'the principal CREDITS the receivable');
      const i = r.invoices.get('I1');
      check(i?.releasedBase === 11n, 'the three releases sum to the whole 11');
    },
  },
  {
    id: 'SAME-RATE-SUBUNIT-FX',
    why: 'collected at the invoice’s OWN rate, the sub-unit difference is still dust plus realized FX and never a rounding line (TL-8): a release is not a conversion',
    base: ILS,
    invoices: { I1: { currency: USD, rate: '3.6500000000', totalTxnMinor: 100n } },
    credits: {},
    steps: [
      { kind: 'payment_allocation', invoice: 'I1', currency: USD, rate: '3.6500000000', paymentAmountMinor: 33n, appliedMinor: 33n },
      { kind: 'payment_allocation', invoice: 'I1', currency: USD, rate: '3.6500000000', paymentAmountMinor: 33n, appliedMinor: 33n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['arDustBaseMinor'] === 0n && planOf(r, 0)['realizedFxMinor'] === 0n, 'the first collection is exact');
      check(planOf(r, 1)['arDustBaseMinor'] === 1n, 'the second carries one minor unit of dust');
      check(planOf(r, 1)['realizedFxMinor'] === -1n, 'and realizes a LOSS of one minor unit');
      check(accountsOf(r, 1).includes('D fx_loss 1'), 'the loss is a 6900 debit');
      check(!accountsOf(r, 1).some((l) => l.includes('rounding')), 'no 6100 line is expressible');
    },
  },
  {
    id: 'GOLD-84-PARTIAL-FINAL',
    why: 'a 100 USD customer credit carried at 360.00 ILS: consuming 60 USD releases the cumulative proportional 216.00, 40 USD remain carried at 144.00, and the final 40 USD release the entire 144.00 residue; a consumption past the end is refused',
    base: ILS,
    invoices: {
      I1: { currency: USD, rate: '3.6000000000', totalTxnMinor: 6000n },
      I2: { currency: USD, rate: '3.7000000000', totalTxnMinor: 4000n },
    },
    credits: { C1: { currency: USD, rate: '3.6000000000', originalMinor: 10000n } },
    steps: [
      { kind: 'credit_application', invoice: 'I1', credit: 'C1', consumedMinor: 6000n, appliedMinor: 6000n },
      { kind: 'credit_application', invoice: 'I2', credit: 'C1', consumedMinor: 4000n, appliedMinor: 4000n },
      { kind: 'credit_application', invoice: 'I2', credit: 'C1', consumedMinor: 1n, appliedMinor: 1n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['creditCarryingReleasedMinor'] === 21600n, 'GOLD-84: 60 USD release 216.00');
      check(r.steps[0]?.after['remainingCarryingMinor'] === 14400n, 'GOLD-84: 144.00 remains carried');
      check(planOf(r, 1)['creditCarryingReleasedMinor'] === 14400n, 'GOLD-84: the final 40 USD release the whole 144.00');
      check(planOf(r, 1)['invoiceCarryingReleasedMinor'] === 14800n, 'the invoice released 148.00 at its own 3.70');
      check(planOf(r, 1)['realizedFxMinor'] === -400n, 'a credit carried cheaper than the invoice is a LOSS of 4.00');
      check(accountsOf(r, 1).includes('D fx_loss 400'), 'the loss is a 6900 debit');
      check(r.steps[2]?.outcome === 'customer_credit_application.credit_exhausted', 'an exhausted credit refuses');
      const n = r.credits.get('C1');
      check(n?.remaining === 0n && n.remainingCarrying === 0n, 'the stored pair reaches 0/0 together');
    },
  },
  {
    id: 'CREDIT-ALLOC-FX-SIGN',
    why: 'the realized sign is the mirror of the payable side and is deliberately inverted: a credit carried DEARER than the invoice it settles is a GAIN (Cr 4900), carried cheaper a LOSS (Dr 6900)',
    base: ILS,
    invoices: {
      I1: { currency: USD, rate: '3.7000000000', totalTxnMinor: 5000n },
      I2: { currency: USD, rate: '3.5000000000', totalTxnMinor: 5000n },
    },
    credits: { C1: { currency: USD, rate: '3.6000000000', originalMinor: 10000n } },
    steps: [
      { kind: 'credit_application', invoice: 'I1', credit: 'C1', consumedMinor: 5000n, appliedMinor: 5000n },
      { kind: 'credit_application', invoice: 'I2', credit: 'C1', consumedMinor: 5000n, appliedMinor: 5000n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['realizedFxMinor'] === -500n, 'carried cheaper than the invoice: a loss of 5.00');
      check(accountsOf(r, 0).includes('D fx_loss 500'), 'the loss is a 6900 debit');
      check(planOf(r, 1)['realizedFxMinor'] === 500n, 'carried dearer than the invoice: a gain of 5.00');
      check(accountsOf(r, 1).includes('C fx_gain 500'), 'the gain is a 4900 credit');
      check(accountsOf(r, 0).includes('D customer_credit_liability 18000'), 'consuming a customer credit DEBITS 2210');
      const n = r.credits.get('C1');
      check(n?.remaining === 0n && n.remainingCarrying === 0n, 'the credit is fully consumed');
    },
  },
  {
    id: 'STRONG-BASE-MIN1',
    why: 'a JOD-base business and a 1000.00 LBP invoice and credit carrying 2 fils: g never falls below one minor unit while anything remains, and the two releases are still exactly OB',
    base: JOD,
    invoices: {
      I1: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n },
      I2: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n, releasedArTxnMinor: 79000n },
    },
    credits: { C1: { currency: LBP, rate: '0.0000024900', originalMinor: 100000n } },
    steps: [
      { kind: 'credit_application', invoice: 'I1', credit: 'C1', consumedMinor: 79000n, appliedMinor: 79000n },
      { kind: 'credit_application', invoice: 'I2', credit: 'C1', consumedMinor: 21000n, appliedMinor: 21000n },
    ],
    expect: (r) => {
      check(planOf(r, 0)['creditCarryingReleasedMinor'] === 1n, 'the first consumption releases one fils');
      check(r.steps[0]?.after['remainingCarryingMinor'] === 1n, 'the MIN1 floor keeps one fils carried while 21000 remain');
      check(planOf(r, 1)['creditCarryingReleasedMinor'] === 1n, 'the final consumption releases the remaining fils');
      check(r.steps[1]?.after['remainingCarryingMinor'] === 0n, 'and the pair reaches 0/0');
      const n = r.credits.get('C1');
      check(n?.originalCarrying === 2n, 'OB is two fils');
      check(planOf(r, 0)['creditDustBaseMinor'] === -1n, 'a release of 1 against a conversion of 2 is a negative dust');
    },
  },
  {
    id: 'BELOW-BASE-UNIT',
    why: 'a positive amount converting to less than one base minor unit is a STABLE refusal, never a journal line of base 0, and it is named BEFORE the residue law even when both are broken at once',
    base: JOD,
    invoices: { I1: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n, releasedArTxnMinor: 99990n } },
    credits: { C1: { currency: LBP, rate: '0.0000024900', originalMinor: 100000n } },
    steps: [
      { kind: 'payment_allocation', invoice: 'I1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 1n, appliedMinor: 5n },
      { kind: 'payment_allocation', invoice: 'I1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 1n, appliedMinor: 5n },
      { kind: 'credit_application', invoice: 'I1', credit: 'C1', consumedMinor: 5n, appliedMinor: 5n },
    ],
    expect: (r) => {
      check(
        outcomes(r)[0] === 'customer_payment.amount_below_base_unit',
        'the applied 0.05 LBP converts to nothing: the AMOUNT is named, not the residue it would leave',
      );
      check(outcomes(r)[1] === outcomes(r)[0], 'and the refusal is STABLE across attempts: nothing was consumed');
      check(outcomes(r)[2] === 'customer_credit_application.amount_below_base_unit', 'the same law on the credit side, in its own domain');
      const i = r.invoices.get('I1');
      check(i?.outstanding === 10n, 'the invoice still carries its whole residue');
    },
  },
  {
    id: 'RESIDUE-BELOW-BASE-UNIT',
    why: 'R-77 / R-78: no settlement may leave the invoice an outstanding amount, or the credit a remainder, that is > 0 and converts to 0; the same invoice is accepted when what remains still converts to a base minor unit',
    base: JOD,
    invoices: {
      I1: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n },
      I2: { currency: LBP, rate: '0.0000024900', totalTxnMinor: 100000n },
    },
    credits: { C1: { currency: LBP, rate: '0.0000024900', originalMinor: 100000n } },
    steps: [
      { kind: 'payment_allocation', invoice: 'I1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 2n, appliedMinor: 99990n },
      { kind: 'payment_allocation', invoice: 'I1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 2n, appliedMinor: 79000n },
      { kind: 'credit_application', invoice: 'I2', credit: 'C1', consumedMinor: 99990n, appliedMinor: 99990n },
      { kind: 'payment_allocation', invoice: 'I1', currency: JOD, rate: '1.0000000000', paymentAmountMinor: 1n, appliedMinor: 21000n },
    ],
    expect: (r) => {
      check(outcomes(r)[0] === 'customer_payment.residue_below_base_unit', 'leaving 10 LBP that convert to 0 is refused');
      check(outcomes(r)[1] === 'accepted', 'leaving 21000 LBP, which convert to a fils, is accepted');
      check(outcomes(r)[2] === 'customer_credit_application.residue_below_base_unit', 'the same law over the CREDIT remainder');
      check(outcomes(r)[3] === 'accepted', 'and clearing the invoice to exactly zero is lawful');
      const i = r.invoices.get('I1');
      check(i?.outstanding === 0n, 'the accepted pair cleared the invoice');
      check(i?.releasedBase === i?.totalBase, 'and released its whole carrying base');
    },
  },
  {
    id: 'ON-ACCOUNT-SURPLUS-CREDIT',
    why: 'the closure law (OQ-4) in the PAYMENT currency: a pure on-account collection allocates nothing and becomes a credit for the whole amount; a partly allocated one carries the surplus; a fully allocated one creates none. The header base is a SUM OF PER-LEG CONVERSIONS, never one conversion of a sum (P4-AL-25)',
    base: ILS,
    invoices: {
      I1: { currency: ILS, rate: '1.0000000000', totalTxnMinor: 30000n },
      I2: { currency: USD, rate: '3.6500000000', totalTxnMinor: 33n },
    },
    credits: {},
    steps: [
      { kind: 'payment', currency: ILS, rate: '1.0000000000', amountMinor: 50000n, legs: [] },
      {
        kind: 'payment',
        currency: ILS,
        rate: '1.0000000000',
        amountMinor: 50000n,
        legs: [{ invoice: 'I1', paymentAmountMinor: 30000n, appliedMinor: 30000n }],
      },
      { kind: 'payment', currency: USD, rate: '3.6500000000', amountMinor: 66n, legs: [{ invoice: 'I2', paymentAmountMinor: 33n, appliedMinor: 33n }] },
    ],
    expect: (r) => {
      const onAccount = planOf(r, 0);
      check(onAccount['allocationCount'] === 0, 'a pure on-account collection plans no allocation');
      check(onAccount['surplusMinor'] === 50000n && onAccount['creditOriginalAmountMinor'] === 50000n, 'the whole amount becomes a credit');
      check(onAccount['baseAmountMinor'] === 50000n, 'and the header base is the credit’s carrying base, not zero');
      check(accountsOf(r, 0).join(' | ') === 'D posting_account 50000 | C customer_credit_liability 50000', 'G-15: the surplus leg touches no revenue account');
      const partial = planOf(r, 1);
      check(partial['surplusMinor'] === 20000n && partial['creditOriginalCarryingBaseMinor'] === 20000n, 'the surplus of a partly allocated payment');
      check(partial['baseAmountMinor'] === 50000n, 'the header base is the legs plus the credit');
      const foreign = planOf(r, 2);
      // conv(33) + conv(33) = 120 + 120 = 240, while conv(66) would be 241.
      check(foreign['baseAmountMinor'] === 240n, 'the header base is a sum of single roundings: 240');
      check(convertToBase(66n, r10('3.6500000000'), 2, 2) === 241n, 'one rounding of the sum would be 241 — and is NOT what the document stores');
      check(foreign['surplusMinor'] === 33n, 'the unallocated half becomes the credit');
    },
  },
  {
    id: 'SURPLUS-CREDIT-BIRTH-IDENTITY',
    why: 'a surplus credit is born satisfying g(OA) = OB, the verifier’s stored-pair identity, the instant it is written; and a surplus converting to less than one base minor unit is not a representable credit',
    base: ILS,
    invoices: {},
    credits: {},
    steps: [
      { kind: 'credit_creation', currency: USD, rate: '3.6000000000', surplusMinor: 10000n },
      { kind: 'credit_creation', currency: LBP, rate: '0.0000024900', surplusMinor: 5n },
    ],
    expect: (r) => {
      const born = planOf(r, 0);
      check(born['originalAmountMinor'] === 10000n, 'OA is the surplus');
      check(born['originalCarryingBaseMinor'] === 36000n, 'OB = conv_Rp(s)');
      const identity = r.steps[0]?.primitives.at(-1);
      check(identity?.fn === 'supplier_credit_remaining_carrying' && identity.result === '36000', 'g(OA) = OB holds at birth, by the primitive');
      check(accountsOf(r, 0).join(' | ') === 'D posting_account 36000 | C customer_credit_liability 36000', 'the money lands on the liability');
      check(outcomes(r)[1] === 'customer_payment.credit_below_base_unit', 'a surplus converting to nothing is refused');
    },
  },
];

export function buildCustomerSettlementVectors(): CustomerSettlementVectors {
  return {
    version: 'invcusset/1',
    note: [
      'Generated by packages/inventory/scripts/generate-customer-settlement-vectors.ts and verified by packages/inventory/test/customer-settlement.test.ts (P4-S4, map 8.7).',
      'The AR mirror of vectors/supplier-settlement-vectors.json. conv(x, rate, e_t, e_b) = HALF_EVEN(x x rate x 10^max(0, e_b - e_t) / 10^max(0, e_t - e_b));',
      'an invoice: B = conv(T); a credit: OB = conv(OA). Per step, in order, each starting from what the previous accepted one stored:',
      'X = T - O; rel = HALF_EVEN(B x (X + a), T) - HALF_EVEN(B x X, T); ar_dust = rel - conv(a); g(r) = 0 if r = 0 else max(1, OB - HALF_EVEN(OB x (OA - r), OA));',
      'cr_rel = g(rb) - g(rb - c); cr_dust = cr_rel - conv(c). A payment allocation realizes pb - rel and a credit application cr_rel - rel; on the RECEIVABLE side',
      '> 0 is Cr fx_gain and < 0 Dr fx_loss, the deliberate inverse of the payable side, because cash is debited and the asset credited.',
      'The dust stays on the SAME account as its principal (accounts_receivable for the AR leg, customer_credit_liability for the credit leg): there is no 6100 line, no 6200 line and no tax line on this path.',
      'The closure law of a payment is Sum(payment_amount_minor) + credit created = amount_minor, all three in the PAYMENT currency, with allocation_count >= 0 so a pure on-account collection is representable (OQ-4);',
      'baseAmountMinor is Sum(per-leg conversions) + the credit carrying base, never conv(Sum) (P4-AL-25).',
      'Refusals: amount_invalid, allocations_invalid, amount_exceeds_outstanding, amount_exceeds_credit, credit_exhausted, amount_mismatch (same currency, different amounts),',
      'amount_below_base_unit (a positive amount converting to 0), residue_below_base_unit (an invoice outstanding O - a or a credit remaining rb - c that is > 0 and converts to 0: R-77, R-78, judged AFTER every amount_below_base_unit),',
      'credit_below_base_unit (a surplus converting to 0), arithmetic_invalid (a defect, never merchant input).',
      'The releasedArTxnMinor of an invoice is AR a prior reducer released before the steps: O starts at T - it, its base released by the release formula at X = 0.',
      'entry: the lines in the order the plan returns them, each only when non-zero (currency invoice | credit | payment | base). A receivables entry carries ONE branch, supplied per entry by the caller, so no line carries a dimension or a warehouse.',
      'primitives: every SQL primitive call the step made, with its result. The fn names are the SQL ones (0067:671/683/696) because those are the functions this arithmetic CALLS; the supplier_ prefix is historical and the bodies are general.',
    ].join(' '),
    cases: CASES.map((c) => runCase(c).vector),
  };
}

export function renderCustomerSettlementVectors(): Promise<string> {
  return renderJson(buildCustomerSettlementVectors(), 'customer-settlement-vectors.json');
}

/** The cap the plan layer enforces, re-exported so the suite can drive the boundary without a second literal. */
export { CUSTOMER_PAYMENT_MAX_ALLOCATIONS };
