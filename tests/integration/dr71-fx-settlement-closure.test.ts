/**
 * DR-71 §5 — THE C1.2 / C1.4 EXPERIMENT: CAN `txn = 0` MEET `base <> 0`?
 *
 * ── THE QUESTION ──────────────────────────────────────────────────────────
 *
 * `invoice_outstanding` (candidate `0084:593`) derives its two figures from
 * TWO INDEPENDENT SUMS over the same reducer set:
 *
 *     txn  = total_txn_minor  − Σ invoice_amount_applied_minor
 *     base = total_base_minor − Σ invoice_carrying_base_released_minor
 *
 * Nothing in that SELECT ties one sum to the other. The routine's own COMMENT
 * states the intent — «the paid base the sum of the carrying released so the
 * base closes to zero exactly when the last reducer closes the invoice» — and
 * an intent stated in a comment is not a law. If the two sums can disagree,
 * then an invoice can report NOTHING OUTSTANDING in the money the merchant
 * invoiced and STILL carry base value nobody can collect, which is a
 * receivable that has left the books by arithmetic rather than by payment.
 *
 * This file is the experiment, and it is a MEASUREMENT before it is an
 * assertion: every figure below is read back from the stored rows and from the
 * reader of record after each transition, and the hunt for `txn = 0 ∧
 * base <> 0` is stated as its own law over the whole recorded walk.
 *
 * ── WHAT THE RELEASE ACTUALLY IS ──────────────────────────────────────────
 *
 *     rel(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)
 *
 * — `supplier_ap_release` (`0067:683`), a DIFFERENCE OF CUMULATIVE roundings
 * of the invoice's stored originals and never a function of a previous step's
 * already-rounded release (P4-AL-25). Over a chain whose positions obey
 *
 *     X₀ = 0        and        Xᵢ₊₁ = Xᵢ + aᵢ
 *
 * the intermediate terms CANCEL, so `Σ rel = HALF_EVEN(B·Σa, T)` — and when
 * `Σa = T` that is `HALF_EVEN(B) = B` exactly. The closure is therefore a
 * property of the TELESCOPE, which means it is a property of the CHAIN, which
 * means it holds only while the chain recurrence does. §4 measures both halves
 * of that: the telescope over B ≠ T, and what a one-unit GAP does to it.
 *
 * ── WHAT THIS HEAD CAN AND CANNOT REACH, MEASURED ─────────────────────────
 *
 * The experiment DR-71 §5 asks for names «an invoice in a foreign currency».
 * On this head that document is NOT REACHABLE through any merchant write path,
 * and §1 measures that rather than asserting it: a sale takes its currency
 * from the product's `price_currency` (`sale-commit.service.ts:623`), and the
 * catalogue refuses a `price_currency` that is not the business base currency
 * (`catalog.service.ts:246-250`). So every invoice has `source_to_base_rate`
 * exactly 1 and `total_base_minor = total_txn_minor`, and with `B = T` the
 * release degenerates to `rel = a` — the release side CANNOT round at all.
 *
 * That is why this file has two halves and says so:
 *
 *   §2–§3  the walk that IS reachable — a BASE-currency invoice settled by
 *          partial payments in a FOREIGN currency, which is where the only
 *          rounding on this head lives, in TWO different orderings;
 *   §4     the arithmetic of `B ≠ T` against the LIVE routine, which is the
 *          case the day a foreign-currency invoice becomes representable, and
 *          which no walk on this head can exercise.
 *
 * A file that measured only §2–§3 would report «no such case» about a fixture
 * whose rounding was switched off, and that is the vacuous success this header
 * exists to refuse.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import {
  chainBreaks,
  chainTotals,
  derivedRead,
  inRolledBackTx,
  invoiceChain,
  must,
  plantSettlementRow,
  raised,
  type ChainStep,
  type DerivedRead,
} from '../golden-regression/phase4-s4/harness';
import { collectPayment, invoiceRelease, R10, rateToR10, toBase, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stateFxRate,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

/** The one claim every case here makes: without the settlement slice none of it is true or false. */
const SUBJECT = 'the DR-71 §5 closure experiment: an invoice settled by partial payments reports txn and base that agree';

/** The payment currency. Must differ from the base, or every rate is 1 and there is no FX to realize. */
const PAY_CURRENCY = 'USD';
/**
 * A rate with all ten fraction digits in use. A rate like `3.67` would leave
 * `conv(p) = HALF_EVEN(p·3.67)` exact for many `p`, and a walk that happened
 * to realize no FX would be the single-currency case wearing a USD label.
 */
const PAY_RATE = '3.6712345679';

/** One recorded transition: what the walk did, and what the reader of record said afterwards. */
interface Transition {
  readonly label: string;
  readonly appliedMinor: bigint;
  readonly paymentAmountMinor: bigint;
  /** The leg's own stored figures, read back from `payment_allocations`. */
  readonly storedReleasedBaseMinor: bigint;
  readonly storedRealizedFxMinor: bigint;
  readonly storedDustBaseMinor: bigint;
  readonly read: DerivedRead;
  readonly chain: readonly ChainStep[];
}

interface Walk {
  readonly invoice: OpenInvoice;
  readonly order: readonly bigint[];
  readonly transitions: readonly Transition[];
}

let w: SettlementWorld;
let missing: readonly string[] = [];
let base = '';
let forward: Walk | undefined;
let reverse: Walk | undefined;
/** The measured premise of §1: the invoice this head can issue. */
let invoiceRateIsOne: boolean | undefined;
let invoiceBaseEqualsTxn: boolean | undefined;

/**
 * A payment amount `p` in `PAY_CURRENCY` whose conversion at `PAY_RATE` does
 * NOT equal the base the leg releases, searched over a small deterministic
 * window around `a / Rp`.
 *
 * Finding nothing THROWS: a leg that realized zero FX would make the
 * «carrying value kept separate from the FX difference» half of DR-71 §5 a
 * comparison of zero with zero.
 */
function pickPaymentAmount(relBaseMinor: bigint, appliedMinor: bigint, rateR10: bigint): bigint {
  const start = (appliedMinor * R10) / rateR10;
  for (let d = 0n; d <= 60n; d += 1n)
    for (const p of [start + d, start - d]) {
      if (p <= 0n) continue;
      if (toBase(p, rateR10) !== relBaseMinor) return p;
    }
  throw new Error(
    `NO SUBJECT — no payment amount within 60 minor units of ${start} converts at ${rateR10} to anything other than the ${relBaseMinor} ` +
      `base the leg releases, so this leg realizes no FX and the carrying/FX separation has nothing to be true of`,
  );
}

/** Split `total` into three parts that are each at least `1` and are NOT all equal. */
function threeParts(total: bigint): readonly [bigint, bigint, bigint] {
  const third = total / 3n;
  const a1 = third;
  const a2 = third + 1n;
  const a3 = total - a1 - a2;
  if (a1 < 1n || a2 < 1n || a3 < 1n)
    throw new Error(`NO SUBJECT — an invoice totalling ${total} minor units cannot be split into three partial payments, so there is no partial walk`);
  return [a1, a2, a3];
}

/** Walk one invoice down to zero in the given order of applied amounts, recording every transition. */
async function walkInvoice(invoice: OpenInvoice, order: readonly bigint[], label: string): Promise<Walk> {
  const B = BigInt(invoice.totalBaseMinor);
  const T = BigInt(invoice.totalTxnMinor);
  const rateR10 = rateToR10(PAY_RATE);
  const transitions: Transition[] = [];
  let position = 0n;

  for (const [i, applied] of order.entries()) {
    const rel = invoiceRelease(B, T, position, applied);
    const p = pickPaymentAmount(rel, applied, rateR10);
    const paymentId = randomUUID();
    const leg: AllocationInput = {
      invoiceId: invoice.invoiceId,
      appliedMinor: applied.toString(),
      paymentAmountMinor: p.toString(),
      releasedBeforeMinor: position.toString(),
      invoiceTotalTxnMinor: invoice.totalTxnMinor,
      invoiceTotalBaseMinor: invoice.totalBaseMinor,
      invoiceToBaseRateR10: rateToR10(invoice.sourceToBaseRate),
      paymentToBaseRateR10: rateR10,
    };
    const res = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId: must(invoice.customerId, `the invoice's customer`),
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      currencyCode: PAY_CURRENCY,
      amountMinor: p.toString(),
      allocations: [leg],
    });
    expect(res.status, `${label} step ${i + 1} (apply ${applied} at position ${position}) is accepted: ${JSON.stringify(res.body)}`).toBeLessThan(300);

    // Read the leg's own stored figures back. The carrying value and the FX
    // difference are SEPARATE COLUMNS and are read separately, which is the
    // half of DR-71 §5 that a single «base» number would hide.
    const stored = await ownerPool().query<{ rel: string; fx: string; dust: string }>(
      `SELECT a.invoice_carrying_base_released_minor::text AS rel, a.realized_fx_gain_loss_minor::text AS fx,
              a.ar_dust_base_minor::text AS dust
         FROM payment_allocations a
        WHERE a.business_id = $1 AND a.payment_id = $2 AND a.invoice_id = $3`,
      [w.shop.businessId, paymentId, invoice.invoiceId],
    );
    const row = must(stored.rows[0], `${label} step ${i + 1}: the stored allocation`);
    transitions.push({
      label: `${label} step ${i + 1}`,
      appliedMinor: applied,
      paymentAmountMinor: p,
      storedReleasedBaseMinor: BigInt(row.rel),
      storedRealizedFxMinor: BigInt(row.fx),
      storedDustBaseMinor: BigInt(row.dust),
      read: await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId),
      chain: await invoiceChain(ownerPool(), w.shop.businessId, invoice.invoiceId),
    });
    position += applied;
  }
  return { invoice, order, transitions };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('dr71fx');
  missing = await settlementMissing(w);
  base = await baseCurrency(w);
  expect(PAY_CURRENCY, `NO SUBJECT — the payment currency must differ from the business base currency ${base}`).not.toBe(base);
  if (missing.length > 0) return;

  await stateFxRate(w, PAY_CURRENCY, base, PAY_RATE, `${w.day}T00:00:01Z`);
  await stockUp(w, '400', '11');
  const customer = await newCustomer(w);

  // Two invoices with IDENTICAL totals, so the two orderings differ in nothing
  // but the order. A comparison across two different totals would be a
  // comparison of two different documents.
  const i1 = await sellOnCredit(w, customer, '3');
  const i2 = await sellOnCredit(w, customer, '3');
  expect(i2.totalTxnMinor, 'the two invoices of the ordering comparison total the same, or the comparison is about their totals').toBe(i1.totalTxnMinor);
  expect(i2.totalBaseMinor, 'and the same in base minor units').toBe(i1.totalBaseMinor);

  // §1's measurement, taken from the stored row and not from the request.
  invoiceRateIsOne = BigInt(rateToR10(i1.sourceToBaseRate)) === R10;
  invoiceBaseEqualsTxn = BigInt(i1.totalBaseMinor) === BigInt(i1.totalTxnMinor);

  const [a1, a2, a3] = threeParts(BigInt(i1.totalTxnMinor));
  forward = await walkInvoice(i1, [a1, a2, a3], 'forward');
  reverse = await walkInvoice(i2, [a3, a2, a1], 'reverse');
}, 240_000);

afterAll(async () => {
  await ownerPool().query('SELECT 1');
});

describe('DR-71 §5 — §1 what this head can issue, measured', () => {
  it('the subject exists: the settlement relations, the commands, the verifiers and the routes', () => {
    requireSubject(missing, SUBJECT);
    expect(missing, `the slice's own subject must be present, or every figure below is about nothing: ${missing.join('; ')}`).toEqual([]);
  });

  it('every invoice this head can issue is in the BASE currency, so the release cannot round — the premise of §4', () => {
    requireSubject(missing, SUBJECT);
    // Measured off the stored invoice, not read out of `catalog.service.ts`.
    // The source says a product's price currency must equal the base; this
    // says what the sale COMMITTED, which is the thing §4 depends on.
    expect(
      invoiceRateIsOne,
      `the invoice's stored source_to_base_rate must be exactly 1 on this head. If this has become false, a foreign-currency invoice is now ` +
        `representable, B <> T is reachable through the merchant path, and §4's arithmetic has stopped being latent — the walk in §2 must be ` +
        `re-cut over that document before anybody reads §3 as covering it.`,
    ).toBe(true);
    expect(invoiceBaseEqualsTxn, `and therefore total_base_minor = total_txn_minor, which makes rel(B, T, X, a) = a exactly`).toBe(true);
  });

  it('and no product on this head is priced outside the base currency, which is WHY', async () => {
    requireSubject(missing, SUBJECT);
    const r = await ownerPool().query<{ offending: string; total: string }>(
      `SELECT count(*) FILTER (WHERE p.price_currency <> b.base_currency)::text AS offending, count(*)::text AS total
         FROM products p JOIN businesses b ON b.id = p.business_id
        WHERE p.business_id = $1`,
      [w.shop.businessId],
    );
    const row = must(r.rows[0], 'the catalogue currency census');
    // Non-vacuity first: a census over zero products would report `0` offending
    // and prove nothing at all.
    expect(BigInt(row.total) > 0n, `NO SUBJECT — this business has no products, so the currency census is a count over nothing`).toBe(true);
    expect(row.offending, `a product priced outside the base currency would make a foreign-currency invoice reachable (catalog.service.ts:246-250)`).toBe('0');
  });
});

describe('DR-71 §5 — §2 the reachable walk: partial payments in a FOREIGN currency', () => {
  it('both walks really happened, in three partial steps each, and the two orderings are genuinely different', () => {
    requireSubject(missing, SUBJECT);
    const f = must(forward, 'the forward walk');
    const r = must(reverse, 'the reverse walk');
    expect(f.transitions.length, 'the forward walk has three recorded transitions').toBe(3);
    expect(r.transitions.length, 'the reverse walk has three recorded transitions').toBe(3);
    // The orderings must DIFFER, or «two different orderings» is one ordering
    // run twice and the ordering-independence law below is a tautology.
    expect(r.order.map(String), `the two walks must apply the same amounts in a DIFFERENT order, or §3's ordering law compares a walk with itself`).not.toEqual(
      f.order.map(String),
    );
    expect([...r.order].sort().map(String), 'and they are the same multiset of amounts').toEqual([...f.order].sort().map(String));
  });

  it('the foreign currency is doing work: at least one leg realizes a NON-ZERO FX difference', () => {
    requireSubject(missing, SUBJECT);
    const all = [...must(forward, 'forward').transitions, ...must(reverse, 'reverse').transitions];
    const realized = all.filter((t) => t.storedRealizedFxMinor !== 0n);
    expect(
      realized.length > 0,
      `NO SUBJECT — every leg of both walks realized exactly zero FX, so the payment currency converted exactly and this file measured the ` +
        `single-currency case under a USD label: ${all.map((t) => `${t.label}=${t.storedRealizedFxMinor}`).join(', ')}`,
    ).toBe(true);
  });

  it('the carrying value and the FX difference are SEPARATE: rel is the chain release, FX is conv(payment) − rel', () => {
    requireSubject(missing, SUBJECT);
    const rateR10 = rateToR10(PAY_RATE);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const B = BigInt(walk.invoice.totalBaseMinor);
      const T = BigInt(walk.invoice.totalTxnMinor);
      let position = 0n;
      for (const t of walk.transitions) {
        const rel = invoiceRelease(B, T, position, t.appliedMinor);
        expect(t.storedReleasedBaseMinor, `${t.label}: the stored carrying release is rel(B, T, ${position}, ${t.appliedMinor})`).toBe(rel);
        expect(
          t.storedRealizedFxMinor,
          `${t.label}: the stored realized FX is conv_Rp(${t.paymentAmountMinor}) − ${rel}. A release that absorbed the FX would make the ` +
            `receivable move by the payment's rate rather than the invoice's.`,
        ).toBe(toBase(t.paymentAmountMinor, rateR10) - rel);
        position += t.appliedMinor;
      }
    }
  });

  it('paid + outstanding = total after EVERY transition, in the invoice currency and again in base', () => {
    requireSubject(missing, SUBJECT);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const B = BigInt(walk.invoice.totalBaseMinor);
      const T = BigInt(walk.invoice.totalTxnMinor);
      for (const t of walk.transitions) {
        expect(t.read.paidTxnMinor + t.read.outstandingTxnMinor, `${t.label}: paid + outstanding = ${T} in the invoice currency`).toBe(T);
        expect(t.read.paidBaseMinor + t.read.outstandingBaseMinor, `${t.label}: paid + outstanding = ${B} in base minor units`).toBe(B);
      }
    }
  });

  it('and every transition actually moved the document: outstanding falls strictly, so the intermediate states are real', () => {
    requireSubject(missing, SUBJECT);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const T = BigInt(walk.invoice.totalTxnMinor);
      let previous = T;
      for (const t of walk.transitions) {
        expect(
          t.read.outstandingTxnMinor < previous,
          `${t.label}: outstanding must fall strictly (was ${previous}, now ${t.read.outstandingTxnMinor}). A walk whose middle steps moved ` +
            `nothing would reach zero in one hop and the per-transition hunt below would have only the closure to look at.`,
        ).toBe(true);
        previous = t.read.outstandingTxnMinor;
      }
      // The middle states are INTERMEDIATE, not already closed.
      const middle = walk.transitions.slice(0, -1);
      for (const t of middle) expect(t.read.outstandingTxnMinor > 0n, `${t.label}: a middle transition leaves the invoice open`).toBe(true);
    }
  });
});

describe('DR-71 §5 — §3 THE HUNT: txn = 0 with base <> 0', () => {
  it('no transition of either walk reports NOTHING OUTSTANDING in the invoice currency while still carrying base value', () => {
    requireSubject(missing, SUBJECT);
    const offenders: string[] = [];
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')])
      for (const t of walk.transitions)
        if (t.read.outstandingTxnMinor === 0n && t.read.outstandingBaseMinor !== 0n) offenders.push(`${t.label}: txn=0 base=${t.read.outstandingBaseMinor}`);
    expect(
      offenders,
      `an invoice reporting txn = 0 while base <> 0 is a receivable that left the books by arithmetic and not by payment — the base value is ` +
        `uncollectable because the money figure says there is nothing to collect: ${offenders.join('; ')}`,
    ).toEqual([]);
  });

  it('the closure is EXACT in both figures at once, and the hunt therefore had a zero to find', () => {
    requireSubject(missing, SUBJECT);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const last = must(walk.transitions[walk.transitions.length - 1], `${walk.invoice.invoiceId}: the closing transition`);
      // Both zero. The `txn = 0` half is what makes the hunt above non-vacuous:
      // a walk that never reached `txn = 0` could not have found `txn = 0 ∧
      // base <> 0` however broken the base sum was.
      expect(last.read.outstandingTxnMinor, `the closing transition leaves nothing outstanding in the invoice currency`).toBe(0n);
      expect(
        last.read.outstandingBaseMinor,
        `and nothing in base minor units. This is the pair the two independent sums of invoice_outstanding have to agree on.`,
      ).toBe(0n);
    }
  });

  it('Σ rel over the chain equals the invoice base EXACTLY at closure, in both orderings', () => {
    requireSubject(missing, SUBJECT);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const last = must(walk.transitions[walk.transitions.length - 1], 'the closing transition');
      const totals = chainTotals(last.chain);
      expect(totals.applied, `Σ applied over the closed chain is the invoice total`).toBe(BigInt(walk.invoice.totalTxnMinor));
      expect(
        totals.released,
        `Σ rel over the closed chain is the invoice base. Σ rel short of B strands carrying value on a closed invoice; Σ rel beyond B releases ` +
          `base the invoice never carried.`,
      ).toBe(BigInt(walk.invoice.totalBaseMinor));
    }
  });

  it('and the chain each walk built has no gap and no overlap — the condition the closure rests on', () => {
    requireSubject(missing, SUBJECT);
    for (const walk of [must(forward, 'forward'), must(reverse, 'reverse')]) {
      const last = must(walk.transitions[walk.transitions.length - 1], 'the closing transition');
      expect(last.chain.length, `the closed chain has one step per partial payment`).toBe(walk.order.length);
      expect(
        chainBreaks(last.chain),
        `a break in the chain is exactly what §4 measures breaking the closure, so a walk with a break would make §3 a measurement of a defect ` +
          `rather than of its absence`,
      ).toEqual([]);
    }
  });

  it('the two orderings reach the SAME closure, while their individual legs differ', () => {
    requireSubject(missing, SUBJECT);
    const f = must(forward, 'forward');
    const r = must(reverse, 'reverse');
    const fLast = must(f.transitions[f.transitions.length - 1], 'forward closure');
    const rLast = must(r.transitions[r.transitions.length - 1], 'reverse closure');
    expect(chainTotals(fLast.chain).released, 'both orderings release the same total carrying value').toBe(chainTotals(rLast.chain).released);
    expect([fLast.read.outstandingTxnMinor, fLast.read.outstandingBaseMinor], 'and both close to the same pair').toEqual([
      rLast.read.outstandingTxnMinor,
      rLast.read.outstandingBaseMinor,
    ]);
    // Non-vacuity: the per-leg figures must actually differ between the two
    // orderings, or «order-independent» is a claim about two identical walks.
    const fLegs = f.transitions.map((t) => t.appliedMinor.toString()).join(',');
    const rLegs = r.transitions.map((t) => t.appliedMinor.toString()).join(',');
    expect(rLegs, `the two walks applied their amounts in a different order`).not.toBe(fLegs);
  });
});

describe('DR-71 §5 — §4 the LATENT case: B <> T against the live routine', () => {
  /**
   * The arithmetic no walk on this head can reach, measured where it lives.
   *
   * `supplier_ap_release` is called in the DATABASE, not reimplemented here: a
   * TypeScript re-derivation would prove the two implementations agree with
   * each other, which is not the question. The sweep is bounded and
   * deterministic — `generate_series`, no randomness — so a failure names a
   * case somebody can re-run.
   */
  it('over 30k chains with B <> T, Σ rel = B exactly whenever Σ a = T — in both orderings, and the rounding is real', async () => {
    requireSubject(missing, SUBJECT);
    const r = await ownerPool().query<{
      cases: string;
      fwd_bad: string;
      rev_bad: string;
      legs_differ: string;
      rounding_occurred: string;
    }>(
      `WITH cases AS (
         SELECT b AS "B", t AS "T", a1, a2, t - a1 - a2 AS a3
           FROM generate_series(3, 20) t, generate_series(7, 400, 13) b,
                generate_series(1, 19) a1, generate_series(1, 19) a2
          WHERE b % t <> 0 AND a1 < t AND a2 < t AND t - a1 - a2 >= 1),
       walked AS (
         SELECT "B",
                supplier_ap_release("B", "T", 0, a1)         AS f1,
                supplier_ap_release("B", "T", a1, a2)        AS f2,
                supplier_ap_release("B", "T", a1 + a2, a3)   AS f3,
                supplier_ap_release("B", "T", 0, a3)         AS r1,
                supplier_ap_release("B", "T", a3, a2)        AS r2,
                supplier_ap_release("B", "T", a3 + a2, a1)   AS r3,
                a1, a2
           FROM cases)
       SELECT count(*)::text                                                       AS cases,
              count(*) FILTER (WHERE f1 + f2 + f3 <> "B")::text                    AS fwd_bad,
              count(*) FILTER (WHERE r1 + r2 + r3 <> "B")::text                    AS rev_bad,
              count(*) FILTER (WHERE (f1, f2, f3) <> (r1, r2, r3))::text           AS legs_differ,
              count(*) FILTER (WHERE f1 <> a1 OR f2 <> a2)::text                   AS rounding_occurred
         FROM walked`,
    );
    const m = must(r.rows[0], 'the B <> T sweep');

    // Non-vacuity, stated BEFORE the law: a sweep over no cases, or over cases
    // where the release happened not to round, would report zero violations
    // while measuring nothing.
    expect(BigInt(m.cases) > 10_000n, `NO SUBJECT — the sweep measured only ${m.cases} chains`).toBe(true);
    expect(
      BigInt(m.rounding_occurred) > 0n,
      `NO SUBJECT — in none of the ${m.cases} chains did the release differ from the applied amount, so every case had B = T in disguise and ` +
        `the telescope was never asked to cancel a rounding`,
    ).toBe(true);
    expect(
      BigInt(m.legs_differ) > 0n,
      `NO SUBJECT — the two orderings produced identical per-leg releases in every case, so «both orderings» measured one ordering twice`,
    ).toBe(true);

    expect(m.fwd_bad, `Σ rel <> B in ${m.fwd_bad} of ${m.cases} forward chains that consumed the whole of T`).toBe('0');
    expect(m.rev_bad, `Σ rel <> B in ${m.rev_bad} of ${m.cases} reverse chains that consumed the whole of T`).toBe('0');
  });

  it('but that closure is CONDITIONAL on the chain: a one-unit gap breaks Σ rel = B in most cases', async () => {
    requireSubject(missing, SUBJECT);
    // The reason §3's chain-integrity law is not decoration. `Σ a` is still
    // exactly `T` here — only the POSITIONS lie — and the base sum parts
    // company with `B` anyway. That is the `txn = 0 ∧ base <> 0` state,
    // reachable in the arithmetic and refused by the estate (next test).
    const r = await ownerPool().query<{ cases: string; broken: string }>(
      `WITH cases AS (
         SELECT b AS "B", t AS "T", a1, a2, t - a1 - a2 AS a3
           FROM generate_series(3, 20) t, generate_series(7, 400, 13) b,
                generate_series(1, 19) a1, generate_series(1, 19) a2
          WHERE b % t <> 0 AND a1 < t AND a2 < t AND t - a1 - a2 >= 2),
       gapped AS (
         SELECT "B",
                supplier_ap_release("B", "T", 0, a1)              AS g1,
                supplier_ap_release("B", "T", a1 + 1, a2)         AS g2,
                supplier_ap_release("B", "T", a1 + a2 + 1, a3 - 1) AS g3
           FROM cases)
       SELECT count(*)::text AS cases, count(*) FILTER (WHERE g1 + g2 + g3 <> "B")::text AS broken FROM gapped`,
    );
    const m = must(r.rows[0], 'the gapped sweep');
    expect(BigInt(m.cases) > 10_000n, `NO SUBJECT — the gapped sweep measured only ${m.cases} chains`).toBe(true);
    expect(
      BigInt(m.broken) > 0n,
      `the gapped sweep found NO broken closure in ${m.cases} chains. If a gap can no longer break Σ rel = B, the telescope is no longer what ` +
        `makes the base close and §3's chain-integrity law is guarding something else — re-derive before trusting either.`,
    ).toBe(true);
  });

  it('and the estate REFUSES the gapped chain: a planted allocation above the recurrence cannot commit', async () => {
    requireSubject(missing, SUBJECT);
    const walk = must(forward, 'the forward walk');
    const last = must(walk.transitions[walk.transitions.length - 1], 'the closing transition');
    const step = must(
      last.chain.find((s) => s.relation === 'payment_allocations' && s.positionMinor > 0n),
      'an accepted allocation to clone',
    );

    // The gap, not the overlap. An overlap — the SAME position twice — is
    // already a database unique violation on
    // `(business_id, invoice_id, ar_released_before_txn_minor)` and is proved
    // elsewhere; it would pre-empt this guard and leave the chain verifier
    // unexercised. A HIGHER position escapes that index, and because `B = T`
    // on this head `rel = a` for ANY position, so the row-level release
    // trigger is satisfied too. Only the COMMIT-time chain verifier is left to
    // speak, which is exactly the one under test.
    //
    // `SET CONSTRAINTS <that one trigger> IMMEDIATE` is what makes this proof a proof.
    // `payment_allocations_value_complete` is DEFERRABLE INITIALLY DEFERRED
    // (measured: `pg_trigger.tginitdeferred`), so it fires at COMMIT — and a
    // plant inside a transaction that only ever ROLLS BACK never reaches that
    // point. Without this line the INSERT returns cleanly, `raised()` answers
    // `null`, and the test reads «accepted» for a chain the estate would in
    // fact have refused. That is a FALSE DEFECT, and it is the reason this
    // line is not an incidental tidy-up: it moves the check inside the
    // transaction, so the refusal is measured and the rollback still leaves
    // the shared database exactly as it was.
    //
    // And it names THAT ONE constraint rather than `ALL`, because `ALL` was
    // measured to refuse for the wrong reason: the planted row's
    // `binding_source_id` has no journal binding yet, so forcing every
    // deferred constraint fired `23503 payment_allocations_binding_fk` FIRST
    // and the chain verifier never ran. A refusal is only evidence of the law
    // it names.
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        return raised(async () => {
          await plantSettlementRow(c, 'payment_allocations', w.shop.businessId, step.id, {
            id: newId,
            binding_source_id: newId,
            ar_released_before_txn_minor: (step.positionMinor + 1n).toString(),
          });
          await c.query('SET CONSTRAINTS payment_allocations_value_complete IMMEDIATE');
        });
      },
    );
    expect(
      outcome,
      `an allocation of invoice ${walk.invoice.invoiceId} sitting one minor unit ABOVE the chain recurrence must be impossible. It was accepted, ` +
        `which means an amount of the invoice nothing accounts for can be released, and §4 has just measured that such a chain makes ` +
        `Σ rel <> B — the txn = 0 ∧ base <> 0 state.`,
    ).not.toBeNull();
    const err = must(outcome, 'the refusal');
    expect(
      err.message,
      `and the refusal is the invoice settlement chain verifier, not an incidental constraint that happened to fire first: ${err.code} ${err.message}`,
    ).toContain('invoice_settlement.settlement_inconsistent');
  });
});

describe('DR-71 §5 — §5 what a refund and a reversal are on this head', () => {
  it('a NEGATIVE allocation is unrepresentable: invoice_amount_applied_minor is constrained to 1 or more', async () => {
    requireSubject(missing, SUBJECT);
    // DR-71 §5 asks the walk to continue «then a refund, then a reversal».
    // Neither is a transition this head can make, and this states why in the
    // schema rather than in prose: a refund as a negative reducer cannot be
    // written at all, so there is no post-closure transition for the hunt in
    // §3 to look at.
    const r = await ownerPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'public.payment_allocations'::regclass
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%invoice_amount_applied_minor%'`,
    );
    expect(r.rows.length > 0, `NO SUBJECT — no CHECK constraint on payment_allocations mentions invoice_amount_applied_minor`).toBe(true);
    const defs = r.rows.map((x) => x.def).join(' | ');
    expect(defs, `the applied amount is floored at 1, so a refund cannot be recorded as a negative allocation: ${defs}`).toContain(
      'invoice_amount_applied_minor >= 1',
    );
  });

  it('and no customer-side refund or reversal command exists to be walked', async () => {
    requireSubject(missing, SUBJECT);
    const r = await ownerPool().query<{ name: string }>(
      `SELECT p.proname::text AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.proname LIKE 'customer%refund%' OR p.proname LIKE 'customer%revers%'
               OR p.proname LIKE '%payment%refund%' OR p.proname LIKE '%payment%revers%')`,
    );
    // Non-vacuity for a probe that asserts an ABSENCE: the same catalogue query
    // shape must find the customer commands that DO exist, or an empty result
    // means the query is looking in the wrong place.
    const control = await ownerPool().query<{ name: string }>(
      `SELECT p.proname::text AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('customer_collect_payment', 'customer_apply_credit')`,
    );
    expect(
      control.rows.map((x) => x.name).sort(),
      `NO SUBJECT — the catalogue probe cannot even find the commands that exist, so its empty refund result proves nothing`,
    ).toEqual(['customer_apply_credit', 'customer_collect_payment']);
    expect(
      r.rows.map((x) => x.name),
      `a customer refund or payment reversal routine exists, so DR-71 §5's post-closure transitions ARE reachable and this file's walk stops ` +
        `short of them: ${r.rows.map((x) => x.name).join(', ')}`,
    ).toEqual([]);
  });
});
