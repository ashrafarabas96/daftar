/**
 * GOLDEN REGRESSION — G-04 / GOLD-26: THE PAYMENT CURRENCY IS NOT THE INVOICE
 * CURRENCY.
 * (Implementation map §1.1, §1.3, §9 G-04; `docs/PHASE_4_ARCHITECTURE_LOCK.md`
 *  :1263, P4-AL-18, P4-AL-25; `packages/inventory/src/supplier-settlement.ts:155,
 *  185, 224-225, 259-287, 326, 329`; `0067:1041`.)
 *
 * This is the case the settlement arithmetic exists for. Every other suite of
 * this slice settles in one currency at rate 1, where `rel` collapses to `a`,
 * both dusts collapse to zero and the realized FX collapses to zero — so none
 * of them can tell a correct implementation from one that simply copies `a`
 * into every column. This file can.
 *
 * ── THE THREE SNAPSHOTS ───────────────────────────────────────────────────
 *
 * Three documents, three rates, and each figure computed at the rate of the
 * document that owns it:
 *
 *   — `R`  the INVOICE's stored `source_to_base_rate`. `conv_R(a)` and
 *          therefore the AR dust `rel − conv_R(a)` are computed at it.
 *   — `Rp` the PAYMENT's own `payment_to_base_rate`. `conv_Rp(p)` and
 *          therefore the realized FX `conv_Rp(p) − rel` are computed at it.
 *   — `Rn` the CREDIT's own `credit_to_base_rate`, frozen at the credit's
 *          birth. `conv_Rn(c)` and the credit dust `cr_rel − conv_Rn(c)` are
 *          computed at it.
 *
 * Using one snapshot where another belongs is the defect this file is built to
 * catch, and it catches it twice over: the live rate is MOVED between the
 * credit's birth and its application, so an implementation that looks a rate up
 * again instead of reading the credit's stored one produces different figures
 * and is refused. "Every consumer reads it and never looks a rate up again" —
 * `supplier-settlement.ts:155`.
 *
 * Every rate is a `NUMERIC(20,10)` read back out of the stored row and carried
 * as R10 (`10^10`) integer arithmetic. `rateToR10` parses the database's own
 * decimal text; no float touches a rate, and no rate is typed into an
 * assertion — the figures are recomputed from the SNAPSHOTS THE DOCUMENTS
 * STORE, with `apRelease`, `convertToBase` and `creditRelease` from
 * `@daftar/inventory` and no second body of the arithmetic.
 *
 * ── WHERE THE MONEY LANDS ─────────────────────────────────────────────────
 *
 * Each dust is a SECOND LINE ON ITS OWN PRINCIPAL ACCOUNT, never a write-off:
 * the credit dust on `customer_credit_liability` (2210) and the AR dust on
 * `accounts_receivable` — the coordinator's second correction, and the mirror
 * of `apLines`/`creditLines` (`supplier-settlement.ts:259-287`). The realized
 * FX goes to `fx_gain` / `fx_loss` and nowhere else, and this file exercises
 * BOTH by choosing one payment that converts to more base than it releases and
 * one that converts to less.
 *
 * `rounding` (6100), `purchase_price_variance` (6200) and every tax account are
 * asserted UNMOVED. `SettlementAccount`'s closed set already makes a 6100 line
 * unrepresentable in the builder (`supplier-settlement.ts:224-225`); this
 * asserts it of the LEDGER, so the day someone widens that set the law still
 * speaks. Every account is found by `system_key` out of
 * `journal_lines ⋈ accounts` — never by a typed code, because a code typed into
 * a test is a second copy of the chart.
 *
 * ── THE CLOSURE CORRECTION HAS TEETH ONLY HERE ────────────────────────────
 *
 * The closure is `Σ payment_amount_minor + credit created = amount_minor`, in
 * the PAYMENT's currency, with the base identity alongside. In a
 * single-currency fixture `payment_amount_minor = invoice_amount_applied_minor`
 * by `payment_allocations_same_currency_ck`, so the corrected law and the
 *原 wrong one are indistinguishable there. Here they are not, and this file
 * asserts BOTH that the corrected law holds AND that the figures genuinely
 * distinguish it — a golden that could not tell the two apart would be
 * reporting a coincidence.
 *
 * ── ONE THING THIS HEAD CANNOT REACH, STATED AND NOT FAKED ────────────────
 *
 * The AR dust is `rel − conv_R(a)`, and it is non-zero only when the INVOICE
 * is in a currency other than the base. On this head no invoice can be: a
 * product's `price_currency` is pinned to the business base currency by the
 * catalogue authority (`apps/api/src/modules/catalog/catalog.service.ts:247-252`
 * — "price currency = the BUSINESS BASE CURRENCY, always", §36–37), so every
 * invoice carries `rate_source = 'base'` and `source_to_base_rate = 1`, `B = T`,
 * and `rel` and `conv_R(a)` are both exactly `a`.
 *
 * So this file does NOT assert that an AR dust line is present: that is an
 * assertion nobody can make true, and a fixture that forced a foreign-currency
 * product in by hand would be proving a law about a state §36–37 forbids. It
 * instead (a) MEASURES the pin and reports it as the disclosure, naming the
 * dead FX branch it strands (`sale-commit.service.ts:641-660`), and (b) proves
 * the AR-dust law can be non-zero, and on which account it would land, as a
 * red proof over synthetic `(B, T, R)`. The day a non-base price currency is
 * admitted, the disclosure case is the one that changes and the live assertion
 * replaces the synthetic one. It does NOT assert the gap is correct.
 *
 * ── THIS FILE IS RED UNTIL `0081` LANDS, AND THAT IS CORRECT ──────────────
 *
 * Every `it` begins by requiring its subject. No `.skip`, no `.todo`, no
 * `.only`, no conditional that turns an absent subject into a pass; every
 * count carries a `business_id` predicate; and nothing here asserts
 * monotonicity over a relation a wall-clock prune may take from.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../../helpers/test-app';
import { requireSubject } from '../phase4-s2/harness';
import {
  closureResidue,
  closureResidueBase,
  creditSnapshot,
  derivedRead,
  entryLines,
  entryOfSource,
  invoiceChain,
  ledgerBalance,
  must,
  paymentClosure,
  paymentSnapshot,
} from './harness';
import {
  allocationFigures,
  applyCredit,
  arDust,
  collectPayment,
  CREDIT_SOURCE_TYPE,
  creditDust,
  invoiceRelease,
  R10,
  rateToR10,
  S4_SOURCE_TYPES,
  SYSTEM_KEYS,
  toBase,
  type AllocationInput,
} from './settlement-path';
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
} from './settlement-world';

const CLAIM =
  'a payment in one currency settles an invoice in another: three distinct snapshots, each dust on its own principal account, realized FX on the gain and loss accounts, and the rounding and tax accounts unmoved';

/** The payment currency. Deliberately not the base, and asserted so before anything else runs. */
const PAY_CURRENCY = 'USD';
/** `Rn` — the rate in force when the credit is born. */
const RATE_AT_BIRTH = '3.6700000000';
/** The rate the registry is MOVED to before the credit is applied. A re-lookup would find this one. */
const RATE_AT_APPLICATION = '3.9100000000';

let w: SettlementWorld;
let missing: readonly string[] = [];
let base = '';

interface Settled {
  readonly res: Response;
  readonly paymentId: string;
  readonly invoice: OpenInvoice;
  /** `p`, in the payment's currency. */
  readonly paymentAmountMinor: bigint;
  /** What the figures the request carried said, so the ledger can be compared against them. */
  readonly figures: ReturnType<typeof allocationFigures>;
}

/** The two allocations, chosen so one realizes FX of each sign. */
let overBase: Settled | undefined;
let underBase: Settled | undefined;
/** The credit scenario. */
let creditCase:
  | {
      readonly bornRes: Response;
      readonly appliedRes: Response;
      readonly paymentId: string;
      readonly creditId: string;
      readonly applicationId: string;
      readonly invoice: OpenInvoice;
      readonly surplusMinor: bigint;
      readonly consumedMinor: bigint;
    }
  | undefined;

/**
 * A payment amount `p` whose conversion at `Rp` lands on the wanted side of
 * the base amount the invoice leg releases.
 *
 * Searched over a small DETERMINISTIC window around `a / Rp` rather than
 * hand-tuned into the file: a hand-tuned constant is a figure somebody has to
 * re-derive the day a rate changes, and a figure nobody can re-derive is a
 * figure nobody checks. Finding nothing THROWS — a scenario that could not
 * realize FX of the wanted sign has no subject, and a golden that quietly
 * settled for zero FX would be the single-currency case wearing a USD label.
 */
function pickPaymentAmount(invoice: OpenInvoice, appliedMinor: bigint, rateR10: bigint, want: 'more' | 'less'): bigint {
  const rel = invoiceRelease(BigInt(invoice.totalBaseMinor), BigInt(invoice.totalTxnMinor), 0n, appliedMinor);
  const start = (appliedMinor * R10) / rateR10;
  for (let d = 0n; d <= 40n; d += 1n)
    for (const p of [start + d, start - d]) {
      if (p <= 0n) continue;
      const realized = toBase(p, rateR10) - rel;
      if (want === 'more' && realized > 0n) return p;
      if (want === 'less' && realized < 0n) return p;
    }
  throw new Error(
    `NO SUBJECT — no payment amount within 40 minor units of ${start} converts at ${rateR10} to ${want} base than the ${rel} the leg ` +
      `releases, so this scenario cannot realize FX of that sign and would be the single-currency case under another name`,
  );
}

/**
 * A `(surplus, consumed)` pair whose CREDIT DUST is non-zero at `Rn`.
 *
 * Same discipline, same reason. The pair is only a FIXTURE CHOICE: every
 * assertion below recomputes the expected dust from the credit's STORED
 * `(OA, OB, Rn)` after the command has run, and separately requires the
 * measured dust to be non-zero — so if this search's assumption about how the
 * command derives `OB` is wrong, the suite says so loudly instead of passing
 * over a zero.
 */
function pickDustBearingCredit(rateR10: bigint): { readonly surplusMinor: bigint; readonly consumedMinor: bigint } {
  for (let surplus = 701n; surplus <= 820n; surplus += 1n) {
    const ob = toBase(surplus, rateR10);
    for (let consumed = 1n; consumed < surplus; consumed += 1n)
      if (creditDust(surplus, ob, surplus, consumed, rateR10) !== 0n) return { surplusMinor: surplus, consumedMinor: consumed };
  }
  throw new Error(
    `NO SUBJECT — no surplus in [701, 820] at rate ${rateR10} produces a non-zero credit dust, so the credit-dust law has nothing to be ` +
      `true of in this fixture`,
  );
}

function leg(inv: OpenInvoice, appliedMinor: bigint, paymentAmountMinor: bigint, paymentRateR10: bigint): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
    paymentAmountMinor: paymentAmountMinor.toString(),
    // The invoice's OWN snapshot, read back from the stored row — never 1 by
    // assumption. On this head it IS 1, and the disclosure case measures that
    // rather than this one assuming it.
    invoiceToBaseRateR10: rateToR10(inv.sourceToBaseRate),
    paymentToBaseRateR10: paymentRateR10,
  };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4fx');
  missing = await settlementMissing(w);
  base = await baseCurrency(w);
  // The premise of the whole file, checked before any scenario: a payment
  // currency equal to the base would make every rate 1 and every figure below
  // a restatement of the single-currency suites.
  expect(PAY_CURRENCY, `NO SUBJECT — the payment currency must differ from the business base currency ${base}`).not.toBe(base);
  if (missing.length > 0) return;

  const rp = rateToR10(RATE_AT_BIRTH);
  await stateFxRate(w, PAY_CURRENCY, base, RATE_AT_BIRTH, `${w.day}T00:00:01Z`);

  await stockUp(w, '200', '11');
  const customer = await newCustomer(w);

  // ── scenario 1: the payment converts to MORE base than the leg releases ─
  const i1 = await sellOnCredit(w, customer, '3');
  const a1 = BigInt(i1.totalTxnMinor);
  const p1 = pickPaymentAmount(i1, a1, rp, 'more');
  const l1 = leg(i1, a1, p1, rp);
  const pay1 = randomUUID();
  const res1 = await collectPayment(w.t, w.headers, {
    paymentId: pay1,
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    currencyCode: PAY_CURRENCY,
    amountMinor: p1.toString(),
    allocations: [l1],
  });
  overBase = { res: res1, paymentId: pay1, invoice: i1, paymentAmountMinor: p1, figures: allocationFigures(l1) };

  // ── scenario 2: the payment converts to LESS base than the leg releases ─
  const i2 = await sellOnCredit(w, customer, '4');
  const a2 = BigInt(i2.totalTxnMinor);
  const p2 = pickPaymentAmount(i2, a2, rp, 'less');
  const l2 = leg(i2, a2, p2, rp);
  const pay2 = randomUUID();
  const res2 = await collectPayment(w.t, w.headers, {
    paymentId: pay2,
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    currencyCode: PAY_CURRENCY,
    amountMinor: p2.toString(),
    allocations: [l2],
  });
  underBase = { res: res2, paymentId: pay2, invoice: i2, paymentAmountMinor: p2, figures: allocationFigures(l2) };

  // ── scenario 3: a credit born at `Rn`, applied after the rate MOVES ────
  const { surplusMinor, consumedMinor } = pickDustBearingCredit(rp);
  const i3 = await sellOnCredit(w, customer, '2');
  const a3 = BigInt(i3.totalTxnMinor);
  const p3 = pickPaymentAmount(i3, a3, rp, 'more');
  const creditId = randomUUID();
  const pay3 = randomUUID();
  const bornRes = await collectPayment(w.t, w.headers, {
    paymentId: pay3,
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    currencyCode: PAY_CURRENCY,
    amountMinor: (p3 + surplusMinor).toString(),
    creditId,
    allocations: [leg(i3, a3, p3, rp)],
  });

  // THE RATE MOVES. Entered AFTER the credit exists and BEFORE it is applied,
  // on the same document date, so a lookup made at application time returns
  // this rate and the credit's own stored snapshot returns the other. An
  // implementation that re-looks-up cannot agree with both.
  await stateFxRate(w, PAY_CURRENCY, base, RATE_AT_APPLICATION, `${w.day}T12:00:00Z`);

  const i4 = await sellOnCredit(w, customer, '2');
  const applicationId = randomUUID();
  const stored = bornRes.status < 300 ? await creditSnapshot(ownerPool(), w.shop.businessId, creditId) : null;
  const appliedRes =
    stored === null
      ? bornRes
      : await applyCredit(w.t, w.headers, {
          applicationId,
          creditId,
          customerId: customer,
          invoiceId: i4.invoiceId,
          applicationDate: w.day,
          consumedMinor: consumedMinor.toString(),
          remainingBeforeMinor: stored.remainingAmountMinor,
          creditOriginalMinor: stored.originalAmountMinor,
          creditOriginalCarryingMinor: stored.originalCarryingBaseAmountMinor,
          // The CREDIT's own snapshot, read back off the credit row — not the
          // rate the registry now holds.
          creditToBaseRateR10: rateToR10(stored.creditToBaseRate),
          leg: leg(i4, consumedMinor, consumedMinor, rateToR10(stored.creditToBaseRate)),
        });
  creditCase = { bornRes, appliedRes, paymentId: pay3, creditId, applicationId, invoice: i4, surplusMinor, consumedMinor };
}, 480_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

/** Every line of every settlement entry of this business, by system key. */
async function settlementLines(): Promise<
  readonly { readonly entry: string; readonly sourceType: string; readonly key: string | null; readonly signed: bigint }[]
> {
  const r = await ownerPool().query<{ entry: string; source_type: string; key: string | null; signed: string }>(
    `SELECT e.id::text AS entry, e.source_type, a.system_key::text AS key, (l.debit_minor - l.credit_minor)::text AS signed
       FROM journal_entries e
       JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE e.business_id = $1 AND e.source_type = ANY ($2)`,
    [w.shop.businessId, [...S4_SOURCE_TYPES]],
  );
  return r.rows.map((x) => ({ entry: x.entry, sourceType: x.source_type, key: x.key, signed: BigInt(x.signed) }));
}

describe('G-04 the payment currency is not the invoice currency', () => {
  it('the subject exists: the settlement relations, the commands, the verifiers, the seam and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('both cross-currency collections are accepted', () => {
    requireSubject(missing, CLAIM);
    for (const s of [must(overBase, 'scenario 1'), must(underBase, 'scenario 2')])
      expect(s.res.status, `the ${PAY_CURRENCY} collection against the ${s.invoice.currencyCode} invoice commits: ${JSON.stringify(s.res.body)}`).toBeLessThan(
        300,
      );
  });

  // ── the three snapshots ───────────────────────────────────────────────

  it('the payment stores its OWN rate snapshot, and it is the rate that was in force — not 1 and not the base arm', async () => {
    requireSubject(missing, CLAIM);
    const s = must(overBase, 'scenario 1');
    const snap = await paymentSnapshot(ownerPool(), w.shop.businessId, s.paymentId);
    expect(snap.currencyCode, `the payment is in ${PAY_CURRENCY}`).toBe(PAY_CURRENCY);
    expect(
      rateToR10(snap.paymentToBaseRate).toString(),
      `the payment's stored payment_to_base_rate must be the ${RATE_AT_BIRTH} that was in force on ${w.day}, measured ` +
        `${snap.paymentToBaseRate}. The client states no rate (P4-AL-18); the server resolves it from the registry and PINS it on the row.`,
    ).toBe(rateToR10(RATE_AT_BIRTH).toString());
    expect(
      snap.rateSource,
      `and the rate is the 'manual' arm, measured ${snap.rateSource}. A payment's rate_source admits exactly two values: ` +
        `'base', which payments_rate_ck makes equivalent to (fx_rate_id IS NULL AND rate = 1) and which a cross-currency ` +
        `payment therefore cannot claim, and 'manual', which is the only one a registry row can supply because ` +
        `accounting_fx_rates.source is CHECK-pinned to exactly 'manual' (0048:88). There is no 'provider' arm on this ` +
        `relation to fall into — three values are an INVOICE's vocabulary (0075:265), not a payment's.`,
    ).toBe('manual');
    expect(snap.fxRateId, 'and it names the registry row it was taken from, so the figure is auditable to a stated rate').not.toBeNull();
  });

  it('the invoice’s own snapshot is a DIFFERENT snapshot, and the leg’s release is computed at it', async () => {
    requireSubject(missing, CLAIM);
    const s = must(overBase, 'scenario 1');
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, s.invoice.invoiceId);
    expect(chain.length, 'NO SUBJECT — the invoice carries no settlement row').toBe(1);
    const step = must(chain[0], 'the one chain step');
    // `rel` comes from the INVOICE's stored (B, T) through `apRelease` and from
    // nothing else. Compared against what the primitive says, not against `a`:
    // asserting `rel === a` would be asserting the collapse rather than the law.
    expect(
      step.releasedBaseMinor.toString(),
      `the leg released ${step.releasedBaseMinor} base minor units; apRelease over the invoice's stored ` +
        `(B = ${s.invoice.totalBaseMinor}, T = ${s.invoice.totalTxnMinor}, X = 0, a = ${step.appliedMinor}) says ` +
        `${s.figures.carryingReleasedMinor}. A release computed at the PAYMENT's rate instead of the invoice's would differ.`,
    ).toBe(s.figures.carryingReleasedMinor);
    expect(step.appliedMinor.toString(), `and the invoice-side amount is in the INVOICE's currency (${s.invoice.currencyCode}), not the payment's`).toBe(
      s.invoice.totalTxnMinor,
    );
  });

  it('the credit stores a THIRD snapshot, frozen at its birth, and the live rate moved after it', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    expect(c.bornRes.status, `the credit-bearing overpayment commits: ${JSON.stringify(c.bornRes.body)}`).toBeLessThan(300);
    const snap = await creditSnapshot(ownerPool(), w.shop.businessId, c.creditId);
    expect(snap.currencyCode, `the credit is in the currency the money arrived in, ${PAY_CURRENCY}`).toBe(PAY_CURRENCY);
    expect(
      rateToR10(snap.creditToBaseRate).toString(),
      `the credit's credit_to_base_rate is the ${RATE_AT_BIRTH} in force at its BIRTH, measured ${snap.creditToBaseRate}, and the registry ` +
        `was moved to ${RATE_AT_APPLICATION} before it was applied. A credit that carried the later rate would have been re-valued by the ` +
        `passage of time, which is the opposite of a snapshot.`,
    ).toBe(rateToR10(RATE_AT_BIRTH).toString());
    expect(
      rateToR10(snap.creditToBaseRate).toString(),
      `and the three snapshots are genuinely three: invoice ${must(overBase, 'scenario 1').invoice.sourceToBaseRate}, payment ` +
        `${RATE_AT_BIRTH}, credit ${snap.creditToBaseRate} — with the registry now at ${RATE_AT_APPLICATION}`,
    ).not.toBe(rateToR10(RATE_AT_APPLICATION).toString());
  });

  it('the credit APPLICATION used the credit’s stored rate and not the rate the registry now holds', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    expect(c.appliedRes.status, `the credit application commits: ${JSON.stringify(c.appliedRes.body)}`).toBeLessThan(300);
    const snap = await creditSnapshot(ownerPool(), w.shop.businessId, c.creditId);
    const rn = rateToR10(snap.creditToBaseRate);
    const r = must(
      (
        await ownerPool().query<{ released: string; dust: string; rate: string; consumed: string; rb: string }>(
          `SELECT credit_carrying_base_released_minor::text AS released, credit_dust_base_minor::text AS dust,
                  credit_to_base_rate::text AS rate, credit_amount_consumed_minor::text AS consumed,
                  credit_remaining_before_minor::text AS rb
             FROM customer_credit_applications WHERE business_id = $1 AND id = $2`,
          [w.shop.businessId, c.applicationId],
        )
      ).rows[0],
      `the credit application ${c.applicationId}`,
    );
    expect(rateToR10(r.rate).toString(), `the application copied the credit's rate ${snap.creditToBaseRate}, measured ${r.rate}`).toBe(rn.toString());
    // `cr_rel = g(OA, OB, rb) − g(OA, OB, rb − c)`, recomputed from the
    // credit's ORIGINAL pair and the CURRENT remaining — never from a stored
    // remaining carrying of a previous step
    // (`[[daftar-a-rounded-quotient-is-never-an-input]]`).
    const expectedDust = creditDust(BigInt(snap.originalAmountMinor), BigInt(snap.originalCarryingBaseAmountMinor), BigInt(r.rb), BigInt(r.consumed), rn);
    expect(
      r.dust,
      `the stored credit dust must be cr_rel − conv_Rn(c) computed at the credit's own rate ${snap.creditToBaseRate} over its original pair ` +
        `(OA = ${snap.originalAmountMinor}, OB = ${snap.originalCarryingBaseAmountMinor}), which is ${expectedDust}. Measured ${r.dust}. ` +
        `Computed at the registry's current ${RATE_AT_APPLICATION} it would be a different number.`,
    ).toBe(expectedDust.toString());
  });

  it('and the credit dust is NOT zero — a zero would make the dust law a law about nothing', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    const r = must(
      (
        await ownerPool().query<{ dust: string }>(
          `SELECT credit_dust_base_minor::text AS dust FROM customer_credit_applications WHERE business_id = $1 AND id = $2`,
          [w.shop.businessId, c.applicationId],
        )
      ).rows[0],
      `the credit application ${c.applicationId}`,
    );
    expect(
      BigInt(r.dust) === 0n,
      `NO SUBJECT — the fixture was chosen (surplus ${c.surplusMinor}, consumed ${c.consumedMinor}) precisely so that ` +
        `cr_rel − conv_Rn(c) is non-zero, and the stored dust is ${r.dust}. Either the command derives the credit's original carrying pair ` +
        `differently from conv_Rn(OA), or the dust is being discarded — and in both cases every dust assertion in this file is vacuous.`,
    ).toBe(false);
  });

  // ── where the money lands ─────────────────────────────────────────────

  it('the credit dust rides on `customer_credit_liability`, its own principal account', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    const entry = await entryOfSource(ownerPool(), w.shop.businessId, 'customer_credit_application', c.applicationId);
    expect(entry, `the credit application ${c.applicationId} is addressable through its binding`).not.toBeNull();
    const lines = await entryLines(ownerPool(), w.shop.businessId, must(entry, 'the bound entry'));
    const shown = JSON.stringify(lines.map((l) => ({ key: l.systemKey, d: l.debitMinor.toString(), c: l.creditMinor.toString() })));
    expect(lines.length, `NO SUBJECT — the credit application's entry has no line: ${shown}`).toBeGreaterThan(1);
    const onLiability = lines.filter((l) => l.systemKey === SYSTEM_KEYS.customerCreditLiability);
    expect(
      onLiability.length,
      `the credit's principal line AND its dust line both sit on ${SYSTEM_KEYS.customerCreditLiability} (2210), so a non-zero dust means TWO ` +
        `lines on that account and never a write-off elsewhere (supplier-settlement.ts:274-287). Measured: ${shown}`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      lines.filter((l) => l.systemKey === SYSTEM_KEYS.accountsReceivable).length,
      `and the invoice side of the same entry sits on ${SYSTEM_KEYS.accountsReceivable}: the AR dust has its own principal account and the ` +
        `two dusts never share one. Measured: ${shown}`,
    ).toBeGreaterThanOrEqual(1);
    const balance = lines.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0n);
    expect(balance.toString(), `and the entry balances in base minor units: ${shown}`).toBe('0');
  });

  it('the credit’s BIRTH has its own entry, bound to the credit, with the surplus carried at the credit’s own rate', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    const snap = await creditSnapshot(ownerPool(), w.shop.businessId, c.creditId);
    // The third source type. With the surplus arriving in a currency that is
    // not the base, its base carrying amount is conv_Rn(surplus) at the
    // credit's own rate — which is the figure the base half of the closure
    // depends on, and the figure a zero-allocation collection would have no
    // other entry to carry.
    expect(
      snap.originalCarryingBaseAmountMinor,
      `the credit's original carrying base amount is conv_Rn(${snap.originalAmountMinor}) at its own rate ${snap.creditToBaseRate}, which is ` +
        `${toBase(BigInt(snap.originalAmountMinor), rateToR10(snap.creditToBaseRate))}. Measured ${snap.originalCarryingBaseAmountMinor}.`,
    ).toBe(toBase(BigInt(snap.originalAmountMinor), rateToR10(snap.creditToBaseRate)).toString());

    const entry = await entryOfSource(ownerPool(), w.shop.businessId, CREDIT_SOURCE_TYPE, c.creditId);
    expect(entry, `the credit ${c.creditId} is bound to an entry of source type ${CREDIT_SOURCE_TYPE}`).not.toBeNull();
    const r = await ownerPool().query<{ account_id: string; system_key: string | null; code: string; signed: string }>(
      `SELECT l.account_id::text AS account_id, a.system_key::text AS system_key, a.code, (l.debit_minor - l.credit_minor)::text AS signed
         FROM journal_lines l
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND l.journal_entry_id = $2`,
      [w.shop.businessId, must(entry, 'the credit entry')],
    );
    const shown = JSON.stringify(r.rows.map((x) => ({ key: x.system_key ?? x.code, signed: x.signed })));
    expect(r.rows.length, `NO SUBJECT — the credit's entry has no line: ${shown}`).toBeGreaterThan(1);
    const stray = r.rows.filter((x) => x.account_id !== w.postingAccountId && x.system_key !== SYSTEM_KEYS.customerCreditLiability);
    expect(
      stray.map((x) => `${x.system_key ?? x.code} for ${x.signed}`),
      `the surplus leg debits the method's posting account and credits ${SYSTEM_KEYS.customerCreditLiability}, and that is the whole entry ` +
        `— no receivable, no revenue, no FX: at birth the credit's rate IS the payment's rate, so there is no difference to realize. ` +
        `Measured: ${shown}`,
    ).toEqual([]);
    expect(r.rows.reduce((acc, x) => acc + BigInt(x.signed), 0n).toString(), `and it balances in base minor units: ${shown}`).toBe('0');
  });

  it('realized FX lands on `fx_gain` and on `fx_loss`, one of each across the two scenarios, and never two in one entry', async () => {
    requireSubject(missing, CLAIM);
    const lines = await settlementLines();
    expect(lines.length, 'NO SUBJECT — this business holds no settlement journal line').toBeGreaterThan(0);
    const fx = lines.filter((l) => l.key === SYSTEM_KEYS.fxGain || l.key === SYSTEM_KEYS.fxLoss);
    const shown = JSON.stringify(fx.map((l) => ({ entry: l.entry, key: l.key, signed: l.signed.toString() })));
    // Both accounts are exercised. Which SIGN maps to which account is the
    // implementation's convention and not this file's to dictate — what the
    // golden owes is that both arms are reachable and that the realized
    // difference is never swept anywhere else.
    expect(
      new Set(fx.map((l) => l.key)),
      `the two scenarios were chosen so one payment converts to MORE base than its leg releases (${must(overBase, 's1').figures.realizedFxMinor}) and ` +
        `one to LESS (${must(underBase, 's2').figures.realizedFxMinor}), so BOTH ${SYSTEM_KEYS.fxGain} and ${SYSTEM_KEYS.fxLoss} must carry a ` +
        `line. Measured: ${shown}`,
    ).toEqual(new Set([SYSTEM_KEYS.fxGain, SYSTEM_KEYS.fxLoss]));
    for (const entry of new Set(fx.map((l) => l.entry))) {
      const keys = new Set(fx.filter((l) => l.entry === entry).map((l) => l.key));
      expect(keys.size, `one entry realizes a difference of ONE sign, so it touches one of the two FX accounts and not both. Entry ${entry}: ${shown}`).toBe(1);
    }
  });

  it('the realized FX figure each allocation stored is `conv_Rp(p) − rel`, at the PAYMENT’s snapshot', async () => {
    requireSubject(missing, CLAIM);
    for (const s of [must(overBase, 'scenario 1'), must(underBase, 'scenario 2')]) {
      const r = must(
        (
          await ownerPool().query<{ realized: string; base: string; released: string; pay: string }>(
            `SELECT realized_fx_gain_loss_minor::text AS realized, payment_base_amount_minor::text AS base,
                    invoice_carrying_base_released_minor::text AS released, payment_amount_minor::text AS pay
               FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`,
            [w.shop.businessId, s.paymentId],
          )
        ).rows[0],
        `the allocation of payment ${s.paymentId}`,
      );
      expect(
        r.pay,
        `the allocation consumed ${s.paymentAmountMinor} of the PAYMENT's ${PAY_CURRENCY}, which is a different unit from the ` +
          `${s.invoice.totalTxnMinor} of ${s.invoice.currencyCode} it applied`,
      ).toBe(s.paymentAmountMinor.toString());
      expect(r.base, `and its base amount is conv_Rp(p) = ${s.figures.paymentBaseAmountMinor}`).toBe(s.figures.paymentBaseAmountMinor);
      expect(
        r.realized,
        `the realized FX is conv_Rp(p) − rel = ${s.figures.paymentBaseAmountMinor} − ${s.figures.carryingReleasedMinor} = ` +
          `${s.figures.realizedFxMinor}, measured ${r.realized}. payment_allocations_realized_ck asserts the same identity as a row CHECK, ` +
          `so a disagreement here is also a database refusal.`,
      ).toBe(s.figures.realizedFxMinor);
      expect(BigInt(r.realized) === 0n, `and it is not zero, or this scenario realized nothing and proved nothing`).toBe(false);
    }
  });

  it('`rounding` (6100), `purchase_price_variance` (6200) and every tax account are UNMOVED by the settlement', async () => {
    requireSubject(missing, CLAIM);
    const lines = await settlementLines();
    expect(lines.length, 'NO SUBJECT — no settlement line to judge').toBeGreaterThan(0);
    const forbidden = lines.filter((l) => l.key === SYSTEM_KEYS.rounding || l.key === 'purchase_price_variance' || l.key === 'tax_payable');
    expect(
      forbidden.map((l) => `${l.sourceType} entry ${l.entry} on ${l.key ?? '(custom)'} for ${l.signed}`),
      `the dust is kept on the receivable and on the credit liability, and the remaining imbalance is REALIZED FX. Nothing is written off: ` +
        `SettlementAccount's closed set (supplier-settlement.ts:224-225) says "never 6100 (rounding), 6200 or tax", and this asserts it of ` +
        `the ledger rather than of the builder.`,
    ).toEqual([]);
    // And the account-level balances, which catch a line on a CUSTOM account
    // of the same purpose. Read by system key, with a business predicate.
    for (const key of [SYSTEM_KEYS.rounding, 'tax_payable'] as const) {
      const bal = await ledgerBalance(ownerPool(), w.shop.businessId, key);
      expect(bal.minor.toString(), `${key} carries nothing of this business at all after a cross-currency settlement`).toBe('0');
    }
  });

  // ── the closure, where it finally has teeth ───────────────────────────

  it('the closure holds in the PAYMENT’s currency and in base — and the figures genuinely distinguish it from the invoice-side sum', async () => {
    requireSubject(missing, CLAIM);
    const c = must(creditCase, 'the credit scenario');
    const closure = await paymentClosure(ownerPool(), w.shop.businessId, c.paymentId);
    expect(closure.amountMinor > 0n, 'NO SUBJECT — a payment of zero satisfies every identity at 0 = 0').toBe(true);
    expect(
      closureResidue(closure).toString(),
      `the closure in the payment's own currency (0067:950-955): ${closure.amountMinor} ${PAY_CURRENCY} minor units received, ` +
        `${closure.consumedMinor} consumed by the allocation and ${closure.creditCreatedMinor} turned into credit`,
    ).toBe('0');
    expect(
      closureResidueBase(closure).toString(),
      `and in base: ${closure.baseAmountMinor} received, ${closure.consumedBaseMinor} consumed, ${closure.creditCreatedBaseMinor} carried ` +
        `into the credit — the surplus credit's original_carrying_base_amount_minor is what makes this side close`,
    ).toBe('0');
    // THE NON-VACUITY OF THE CORRECTION ITSELF. In a single-currency fixture
    // `payment_amount_minor = invoice_amount_applied_minor` by
    // `payment_allocations_same_currency_ck`, so the corrected law and the
    // contract's original `Σ invoice_amount_applied` wording are
    // indistinguishable. If they were indistinguishable HERE too, this golden
    // would be reporting a coincidence rather than the law.
    const wrong = closure.amountMinor - closure.appliedInvoiceMinor - closure.creditCreatedMinor;
    expect(
      wrong === 0n,
      `NO SUBJECT FOR THE CORRECTION — summing the INVOICE-side amounts (${closure.appliedInvoiceMinor} ${must(overBase, 's1').invoice.currencyCode}) ` +
        `against a payment of ${closure.amountMinor} ${PAY_CURRENCY} happens to close too, so this scenario cannot tell the corrected law ` +
        `from the wrong one. The two currencies must make the two sums differ, or the correction is untested.`,
    ).toBe(false);
  });

  it('`paid + outstanding = total` in the INVOICE’s own currency, at every step', async () => {
    requireSubject(missing, CLAIM);
    const invoices = [must(overBase, 's1').invoice, must(underBase, 's2').invoice, must(creditCase, 's3').invoice];
    for (const inv of invoices) {
      const read = await derivedRead(ownerPool(), w.shop.businessId, inv.invoiceId);
      expect(
        (read.paidTxnMinor + read.outstandingTxnMinor).toString(),
        `invoice ${inv.invoiceId} totals ${inv.totalTxnMinor} ${inv.currencyCode}; the reader of record reports paid ` +
          `${read.paidTxnMinor} + outstanding ${read.outstandingTxnMinor}. Both figures are in the INVOICE's currency, never the ` +
          `payment's — a reader that mixed the two would report a figure in no currency at all.`,
      ).toBe(inv.totalTxnMinor);
      expect(
        (read.paidBaseMinor + read.outstandingBaseMinor).toString(),
        `and the base side sums to the invoice's stored base total ${inv.totalBaseMinor}`,
      ).toBe(inv.totalBaseMinor);
    }
  });

  // ── the disclosure, and the law that has no live subject ──────────────

  it('EVERY invoice of this estate is in the business base currency, so the AR dust is structurally zero — the disclosure', async () => {
    requireSubject(missing, CLAIM);
    // THE DISCLOSURE, AS A TEST. `apps/api/src/modules/catalog/catalog.service.ts:247-252`
    // pins a product's price_currency to the business base currency ("always",
    // §36–37) and `sale-commit.service.ts:540-561` takes the sale's currency
    // from the product's. So every invoice has rate_source = 'base' and
    // source_to_base_rate = 1, hence B = T, hence rel = conv_R(a) = a and the
    // AR dust is zero for every settlement this estate can produce.
    //
    // Two consequences, both stated rather than worked around:
    //   — the AR dust LINE cannot be asserted present by any fixture, so the
    //     law is proved on synthetic figures in the next case instead;
    //   — `sale-commit.service.ts:641-660`'s `currency !== baseCurrency` FX
    //     branch is unreachable through the merchant path.
    //
    // The day a non-base price currency is admitted, THIS case is the one that
    // changes and the synthetic proof is replaced by a live one. It does NOT
    // assert the pin is correct.
    const r = await ownerPool().query<{ id: string; currency: string; rate: string; src: string }>(
      `SELECT id::text AS id, currency_code::text AS currency, source_to_base_rate::text AS rate, rate_source AS src
         FROM invoices WHERE business_id = $1 ORDER BY created_at`,
      [w.shop.businessId],
    );
    expect(r.rows.length, 'NO SUBJECT — this business holds no invoice, so there is no pin to measure').toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(
        row.currency,
        `invoice ${row.id} is in the business base currency ${base}: the catalogue authority pins a product's price currency to it ` +
          `(catalog.service.ts:247-252), and the sale takes its currency from the product (sale-commit.service.ts:540-561)`,
      ).toBe(base);
      expect(row.src, `so its rate_source is the 'base' arm`).toBe('base');
      expect(rateToR10(row.rate).toString(), `and its stored rate is exactly 1`).toBe(R10.toString());
    }
    const dusts = await ownerPool().query<{ nonzero: number; total: number }>(
      `SELECT count(*) FILTER (WHERE ar_dust_base_minor <> 0)::int AS nonzero, count(*)::int AS total
         FROM payment_allocations WHERE business_id = $1`,
      [w.shop.businessId],
    );
    const d = must(dusts.rows[0], 'the AR dust census');
    expect(d.total, 'NO SUBJECT — no allocation of this business to measure an AR dust on').toBeGreaterThan(0);
    expect(
      d.nonzero,
      `and therefore every one of the ${d.total} allocation(s) of this business carries an AR dust of exactly zero. This is NOT the dust ` +
        `being discarded: with B = T and R = 1, rel and conv_R(a) are both a and their difference is genuinely nothing. The law that the ` +
        `dust, when it exists, rides on accounts_receivable is proved on synthetic figures in the next case.`,
    ).toBe(0);
  });

  it('that law can say no: the AR dust is non-zero on a foreign-currency invoice, and the credit dust on a foreign-currency credit', () => {
    // The red proofs for the two dust laws, on synthetic figures, because an
    // arithmetic law that has only ever been handed a rate of 1 is a law
    // nobody has watched produce anything. No subject is required: these are
    // claims about the arithmetic, not about the estate.
    //
    // SEARCHED, not hand-picked. A `(T, a)` pair written into the file as a
    // constant is a figure nobody can re-derive the day the rate changes, and
    // a figure nobody can re-derive is a figure nobody checks. The window is
    // stated, the first hit is reported in the message, and finding nothing is
    // a FAILURE — which would mean the dust the second line on
    // `accounts_receivable` exists to carry can never arise, and the law has
    // no subject even in arithmetic.
    const rate = rateToR10('3.6700000000');
    const hit = ((): { readonly T: bigint; readonly B: bigint; readonly a: bigint; readonly dust: bigint } | null => {
      for (let T = 1000n; T <= 1200n; T += 1n) {
        // The invoice's base total is its txn total converted at its OWN rate,
        // which is what makes `(B, T)` a well-formed invoice rather than an
        // arbitrary pair.
        const B = toBase(T, rate);
        for (let a = 1n; a < T; a += 1n) {
          const dust = arDust(B, T, 0n, a, rate);
          if (dust !== 0n) return { T, B, a, dust };
        }
      }
      return null;
    })();
    expect(
      hit,
      `NO SUBJECT — no invoice with T in [1000, 1200] at rate 3.67 can produce a non-zero rel − conv_R(a) on its first partial settlement, ` +
        `so the AR dust line would have nothing to carry in any currency`,
    ).not.toBeNull();
    const h = must(hit, 'the dust-bearing invoice');
    expect(
      h.dust === 0n,
      `a ${h.T}-minor-unit invoice at 3.67 carries B = ${h.B}; settling ${h.a} of it from chain position 0 releases a base amount that ` +
        `differs from conv_R(${h.a}) by ${h.dust}. THAT difference is the AR dust, and it rides as a second line on ` +
        `${SYSTEM_KEYS.accountsReceivable} — the same account as the principal, never a write-off and never 6100 ` +
        `(supplier-settlement.ts:185, 259-272; 0067:1041).`,
    ).toBe(false);

    // And the cumulative-release property at that same NON-UNIT rate, which is
    // why the dust is a redistribution and not a leak: a chain that consumes
    // the whole of T releases exactly B, however the per-step roundings fall,
    // so nothing is stranded (P4-AL-25, R-77/R-78).
    const third = h.T / 3n;
    const steps: readonly (readonly [bigint, bigint])[] = [
      [0n, third],
      [third, third],
      [third * 2n, h.T - third * 2n],
    ];
    expect(
      steps.reduce((acc, [x, a]) => acc + invoiceRelease(h.B, h.T, x, a), 0n).toString(),
      `Σ rel over a three-step chain that consumes the whole of T = ${h.T} must be exactly B = ${h.B}. A per-step conv_R(aᵢ) would not ` +
        `reach it, and the shortfall is what a naive implementation strands on an invoice nobody can settle again.`,
    ).toBe(h.B.toString());

    // The credit side: `cr_rel − conv_Rn(c)` at a non-unit rate, over the
    // credit's original pair, must be able to be non-zero too — that is what
    // the second line on `customer_credit_liability` is for.
    const creditHit = ((): { readonly oa: bigint; readonly ob: bigint; readonly c: bigint; readonly dust: bigint } | null => {
      for (let oa = 701n; oa <= 820n; oa += 1n) {
        const ob = toBase(oa, rate);
        for (let c = 1n; c < oa; c += 1n) {
          const dust = creditDust(oa, ob, oa, c, rate);
          if (dust !== 0n) return { oa, ob, c, dust };
        }
      }
      return null;
    })();
    expect(
      creditHit,
      `NO SUBJECT — no credit with an original amount in [701, 820] at rate 3.67 can produce a non-zero cr_rel − conv_Rn(c), so the credit ` +
        `dust line would have nothing to carry`,
    ).not.toBeNull();
    const ch = must(creditHit, 'the dust-bearing credit');
    expect(
      ch.dust === 0n,
      `a credit of ${ch.oa} at 3.67 carries OB = ${ch.ob}; consuming ${ch.c} of it releases a carrying amount that differs from ` +
        `conv_Rn(${ch.c}) by ${ch.dust}, and THAT rides as a second line on ${SYSTEM_KEYS.customerCreditLiability} — its own principal ` +
        `account, never the receivable's and never a write-off.`,
    ).toBe(false);
  });
});
