/**
 * P4-S4 — A FOREIGN-CURRENCY INVOICE IS REACHABLE, AND IT CLOSES TO ZERO ON
 * BOTH SIDES WITH THE REALIZED DIFFERENCE IN ITS OWN COLUMN.
 * (DR-79 item 2; `0081_phase4_customer_payments_credits.sql:320`, `:336`,
 *  `:691`, `:1276`, `:1282`, `:1291`; `0082`; P4-AL-25.)
 *
 * ── THE CLAIM THIS SUITE ATTACKS, AND WHERE IT IS WRITTEN ─────────────────
 *
 * Three places in this estate say, in as many words, that no invoice can be
 * in a currency other than the business base currency:
 *
 *   — `tests/golden-regression/phase4-s4/settlement-path.ts`, above `arDust`:
 *     "on THIS head no invoice of this estate can produce a non-zero one: a
 *     product's `price_currency` is pinned to the business base currency by
 *     the catalogue authority … so every invoice has `source_to_base_rate = 1`
 *     and `B = T`";
 *   — `tests/golden-regression/phase4-s4/10-settlement-cross-currency.golden.test.ts`,
 *     under "ONE THING THIS HEAD CANNOT REACH": "a fixture that forced a
 *     foreign-currency product in by hand would be proving a law about a
 *     state §36–37 forbids";
 *   — and the coordinator's own tracked prose, with the same justification.
 *
 * The justification in all three is the same two lines of the catalogue
 * authority: `catalog.service.ts:247` refuses a `priceCurrency` that is not
 * the base at CREATE, and `:321` refuses any change to a product's price
 * currency at UPDATE.
 *
 * ── WHY THAT JUSTIFICATION DOES NOT SUPPORT THAT CONCLUSION ───────────────
 *
 * Both lines compare a product's price currency to the base currency AT THE
 * MOMENT THE PRODUCT IS WRITTEN. Neither of them, nor anything else, re-reads
 * a product when the BASE moves. And the base is designed to move:
 * `tenancy.service.ts:444` (`POST /v1/businesses/current/base-currency`,
 * §55) changes it, refusing only once `businesses.financial_started_at` is
 * non-null — a column `accounting_post_entry` arms at the first posted
 * journal entry (`0045:817`).
 *
 * So the window is "BEFORE THE FIRST POSTING", not "never", and the state is
 * reached by two ordinary API calls in an ordinary order:
 *
 *   1. a product priced in the base of the moment  (`POST /v1/catalog/products`
 *      — here the fixture's seeded `piece`, priced ILS, which is what the
 *      catalogue authority would also have produced);
 *   2. the base currency changed, while that is still permitted
 *      (`POST /v1/businesses/current/base-currency`);
 *   3. a credit sale of that product — whose currency `sale_commit` takes from
 *      the product (`0078:740`: `WHERE p.price_currency IS DISTINCT FROM
 *      p_currency` is a REFUSAL that the sale's currency be anything else),
 *      and whose base figure the service converts through the registry's rate
 *      (`sale-commit.service.ts:349`, `:707-733`).
 *
 * NOTHING HERE IS FORCED IN BY HAND. No product, invoice, payment, allocation
 * or journal row is written by this file. The FX branch of the sale path that
 * the cross-currency golden calls a "dead FX branch it strands" is the branch
 * this suite drives, and it is not dead.
 *
 * ── WHAT IS THEN MEASURED, WHICH IS THE POINT OF REACHING IT ──────────────
 *
 * With `B ≠ T` and three payments at three DIFFERENT stored rates, every
 * figure the single-currency suites cannot distinguish becomes distinguishable:
 *
 *   — the closure, on BOTH sides: `outstanding_txn_minor = 0` AND
 *     `outstanding_base_minor = 0`. The second is the one that has teeth only
 *     here: when `B = T` every release is the applied amount and the base side
 *     closes for free;
 *   — the TELESCOPING identity that makes it so. `rel_k = R(X_k + a_k) − R(X_k)`
 *     with `R(X) = HALF_EVEN(B·X, T)` and `X_1 = 0`, `X_{k+1} = X_k + a_k`, so
 *     `Σ rel = R(T) − R(0) = B` exactly, however the individual legs round
 *     (`0081:38`, `:777`, `:1330`; P4-AL-25). Stated as an ABSOLUTE value
 *     against the invoice's stored `total_base_minor`, not as an identity
 *     between two sums computed the same way;
 *   — and that the exchange difference is in `realized_fx_gain_loss_minor` and
 *     NOWHERE else: it is `payment_base_amount_minor − invoice_carrying_base_released_minor`
 *     by the row CHECK `payment_allocations_realized_ck` (`0081:336`), it nets
 *     to the ledger's `fx_gain`/`fx_loss` movement and to nothing else, and it
 *     did not leak into the carrying base — which is exactly what
 *     `Σ rel = B` EXACTLY says.
 *
 * Both signs are exercised: two legs convert to more base than they release
 * and one to less, so `fx_gain` and `fx_loss` both move and an implementation
 * that always took one side could not pass.
 *
 * ── THE FIXTURE IS THE REAL PATH, AND THE SUBJECT IS CHECKED ──────────────
 *
 * The business, branches, warehouses and catalogue arrive through
 * `onboardS3Business`; priced stock through `POST /v1/inventory/adjustments`;
 * the invoice through `POST /v1/sales` and nothing else; the rates through the
 * real `accounting_fx_rate_enter` with a real control assertion as
 * `daftar_app`; the payments through `POST /v1/customer-payments`. The only
 * owner-inserted rows are the CUSTOMER and the invoice SEQUENCE, for the
 * reason the accepted P4-S2 and P4-S4 fixtures give: P4-S1 ships no merchant
 * writer for them.
 *
 * Every arithmetic expectation is recomputed with the estate's OWN primitives
 * (`invoiceRelease` = `apRelease`, `toBase` = `convertToBase`) from the
 * snapshots the DOCUMENTS store — read back, never typed — so no second body
 * of the financial truth appears here.
 *
 * Not named `p4-*`, `phase4-*`, `p4sN-` or `customer-s4-*`: those basenames
 * belong to the slice rosters (`scripts/phase4-s1-gate.ts:946`, `:982`) and a
 * suite that took one without a roster row would make the record and the
 * derived roster drift apart.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { today } from '../helpers/inventory-commands';
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
import { allocationFigures, collectPayment, invoiceRelease, rateToR10, SYSTEM_KEYS, toBase } from '../golden-regression/phase4-s4/settlement-path';
import { derivedRead, ledgerBalance, must, paymentSnapshot } from '../golden-regression/phase4-s4/harness';

const CLAIM =
  'an invoice in a currency other than the base is REACHABLE through the API, and closes to zero on both sides with the realized difference in its own column';

/** The product's currency, which is the fixture catalogue's and the base at onboarding. */
const INVOICE_CCY = 'ILS';
/** The currency the base is moved TO, before any posting. 2 minor digits, like ILS (`0001:9`). */
const NEW_BASE_CCY = 'USD';

/**
 * The rates, one per document date, each with a different value so that every
 * leg's `payment_to_base_rate` differs from the invoice's `R` AND from the
 * other legs'. The fractions are deliberately not round: `conv` must genuinely
 * round, or a leg could not tell `HALF_EVEN` from truncation.
 *
 * THE FIGURES ARE CHOSEN, AND WHAT THEY ARE CHOSEN FOR. At `T = 3000`,
 * `R = 0.2404` and `B = 721`, two of the three legs have `rel ≠ conv_R(a)` —
 * `+1` on the second and `−1` on the third. That is the whole point: where the
 * AR dust is zero on every leg, `apRelease` and a per-leg `convertToBase`
 * agree, and a suite could not tell the TELESCOPING release (`R(X+a) − R(X)`,
 * R-61) from the single rounding P4-AL-25 forbids. Here it can, and case 5
 * asserts it. A first draft of this file ran green on figures whose dust was
 * zero throughout, and would have passed that substitution.
 */
const RATE_SALE = '0.2404000000';
const RATE_PAY = ['0.2650000000', '0.2750000000', '0.2350000000'] as const;

/** Three pieces at the fixture's 1000 minor units: `T = 3000`, and `B = 721` at the sale rate. */
const QUANTITY = '3';
/** The three legs, in the invoice's currency, summing to the whole of `T`. */
const APPLIED = ['400', '1200', '1400'] as const;

interface Leg {
  readonly paymentId: string;
  readonly date: string;
  readonly rate: string;
  readonly appliedMinor: string;
  /** `payment_to_base_rate` as the PAYMENT row stores it, read back. */
  readonly storedRate: string;
}

interface AllocationRow {
  readonly line: number;
  readonly paymentId: string;
  readonly paymentCurrency: string;
  readonly paymentAmountMinor: bigint;
  readonly paymentToBaseRate: string;
  readonly paymentBaseAmountMinor: bigint;
  readonly invoiceCurrency: string;
  readonly invoiceAmountAppliedMinor: bigint;
  readonly invoiceHistoricalToBaseRate: string;
  readonly arReleasedBeforeTxnMinor: bigint;
  readonly invoiceCarryingBaseReleasedMinor: bigint;
  readonly arDustBaseMinor: bigint;
  readonly realizedFxGainLossMinor: bigint;
}

let w: SettlementWorld;
let missing: readonly string[] = ['the world was never built'];
/** Measured BEFORE the base currency moves, so case 1 reports the gate it passed through. */
let financialStartedBefore: Date | null = null;
let baseBefore = '';
let priceCurrencyBefore = '';
let baseAfter = '';
let priceCurrencyAfter = '';
let changeStatus = -1;
let changeBody: unknown = null;
/** The refusal a SECOND change gets once a posting has armed the lock — the true reason, measured. */
let relockStatus = -1;
let relockBody: unknown = null;
let invoice: OpenInvoice | null = null;
let legs: Leg[] = [];
let allocations: readonly AllocationRow[] = [];
/** The ledger before the payments, so each FX assertion is a DELTA and not a figure a fixture also moved. */
let before = { fxGain: 0n, fxLoss: 0n, rounding: 0n, ar: 0n };
let after = { fxGain: 0n, fxLoss: 0n, rounding: 0n, ar: 0n };
/** The first step that refused, if any, by name — a refusal is a result, not a failure. */
let refusedAt: string | null = null;
/**
 * The step the driver is on, so a THROWN refusal — an `expect` inside a
 * fixture helper, or the database raising — names its step too and is
 * reported by a NAMED case instead of failing the hook and leaving every
 * case below reported as "skipped", which reads as absence rather than as
 * refusal.
 */
let step = 'step 0 — the world';

/** Civil-date arithmetic on the business's own today, with no clock read here. */
function minusDays(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map((s) => Number(s));
  const t = Date.UTC(must(y, 'year'), must(m, 'month') - 1, must(d, 'day')) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The R-17 instant of a document date IN THE BUSINESS'S TIMEZONE, computed by
 * the same SQL expression the sale and the payment use
 * (`sale-commit.service.ts:719`, `customer-payment.service.ts:722`), so a rate
 * entered at it is a rate those lookups find and this file does not carry a
 * second copy of the rule.
 */
async function instantOf(businessId: string, civil: string): Promise<string> {
  const r = await ownerPool().query<{ at: Date }>(
    `SELECT ((($2::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second') AS at FROM businesses b WHERE b.id = $1`,
    [businessId, civil],
  );
  return must(r.rows[0], `the R-17 instant of ${civil}`).at.toISOString();
}

async function readAllocations(businessId: string, invoiceId: string): Promise<readonly AllocationRow[]> {
  const r = await ownerPool().query<Record<string, string>>(
    `SELECT line_no::text AS ln, payment_id::text AS pid, payment_currency::text AS pccy,
            payment_amount_minor::text AS pam, payment_to_base_rate::text AS ptbr, payment_base_amount_minor::text AS pbam,
            invoice_currency::text AS iccy, invoice_amount_applied_minor::text AS iaam,
            invoice_historical_to_base_rate::text AS ihtbr, ar_released_before_txn_minor::text AS arb,
            invoice_carrying_base_released_minor::text AS icbr, ar_dust_base_minor::text AS dust,
            realized_fx_gain_loss_minor::text AS fx
       FROM payment_allocations
      WHERE business_id = $1 AND invoice_id = $2
      ORDER BY ar_released_before_txn_minor`,
    [businessId, invoiceId],
  );
  return r.rows.map((x) => ({
    line: Number(must(x['ln'], 'line_no')),
    paymentId: must(x['pid'], 'payment_id'),
    paymentCurrency: must(x['pccy'], 'payment_currency'),
    paymentAmountMinor: BigInt(must(x['pam'], 'payment_amount_minor')),
    paymentToBaseRate: must(x['ptbr'], 'payment_to_base_rate'),
    paymentBaseAmountMinor: BigInt(must(x['pbam'], 'payment_base_amount_minor')),
    invoiceCurrency: must(x['iccy'], 'invoice_currency'),
    invoiceAmountAppliedMinor: BigInt(must(x['iaam'], 'invoice_amount_applied_minor')),
    invoiceHistoricalToBaseRate: must(x['ihtbr'], 'invoice_historical_to_base_rate'),
    arReleasedBeforeTxnMinor: BigInt(must(x['arb'], 'ar_released_before_txn_minor')),
    invoiceCarryingBaseReleasedMinor: BigInt(must(x['icbr'], 'invoice_carrying_base_released_minor')),
    arDustBaseMinor: BigInt(must(x['dust'], 'ar_dust_base_minor')),
    realizedFxGainLossMinor: BigInt(must(x['fx'], 'realized_fx_gain_loss_minor')),
  }));
}

async function ledgerSnapshot(businessId: string): Promise<{ fxGain: bigint; fxLoss: bigint; rounding: bigint; ar: bigint }> {
  return {
    fxGain: (await ledgerBalance(ownerPool(), businessId, SYSTEM_KEYS.fxGain)).minor,
    fxLoss: (await ledgerBalance(ownerPool(), businessId, SYSTEM_KEYS.fxLoss)).minor,
    rounding: (await ledgerBalance(ownerPool(), businessId, SYSTEM_KEYS.rounding)).minor,
    ar: (await ledgerBalance(ownerPool(), businessId, SYSTEM_KEYS.accountsReceivable)).minor,
  };
}

async function drive(): Promise<void> {
  step = 'step 0 — ensurePostgres, resetData and the settlement world';
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('c1fx');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  const businessId = w.shop.businessId;
  const base = await today();
  // Four distinct civil dates, all in the PAST or today: the rate lookup is at
  // the last second of a document's date, so two documents on one date would
  // necessarily snapshot one rate and the three legs could not differ.
  const dSale = minusDays(base, 3);
  const dPay = [minusDays(base, 2), minusDays(base, 1), base] as const;

  // ── step 1: the state BEFORE anything moves, measured and not assumed ──
  const b0 = await ownerPool().query<{ fsa: Date | null; ccy: string }>(
    `SELECT financial_started_at AS fsa, base_currency::text AS ccy FROM businesses WHERE id = $1`,
    [businessId],
  );
  financialStartedBefore = must(b0.rows[0], 'the business row').fsa;
  baseBefore = must(b0.rows[0], 'the business row').ccy;
  const p0 = await ownerPool().query<{ ccy: string }>(`SELECT price_currency::text AS ccy FROM products WHERE business_id = $1 AND id = $2`, [
    businessId,
    w.shop.piece.productId,
  ]);
  priceCurrencyBefore = must(p0.rows[0], 'the fixture product row').ccy;

  // ── step 2: the base currency moved, through its own route ─────────────
  step = 'step 2 — POST /v1/businesses/current/base-currency';
  const change = await w.t.request.post('/v1/businesses/current/base-currency').set(w.headers).send({ currency: NEW_BASE_CCY });
  changeStatus = change.status;
  changeBody = change.body;
  if (change.status >= 300) {
    refusedAt = `step 2 — POST /v1/businesses/current/base-currency refused ${change.status}: ${JSON.stringify(change.body)} (tenancy.service.ts:444)`;
    return;
  }
  baseAfter = await baseCurrency(w);
  priceCurrencyAfter = must(
    (
      await ownerPool().query<{ ccy: string }>(`SELECT price_currency::text AS ccy FROM products WHERE business_id = $1 AND id = $2`, [
        businessId,
        w.shop.piece.productId,
      ])
    ).rows[0],
    'the fixture product row',
  ).ccy;

  // The four rates, each at its own document's R-17 instant, through the real
  // control boundary. The sale's goes in first and lowest so that a lookup on
  // a LATER date cannot accidentally return it.
  step = 'step 2b — accounting_fx_rate_enter for the four document dates';
  await stateFxRate(w, INVOICE_CCY, NEW_BASE_CCY, RATE_SALE, await instantOf(businessId, dSale));
  for (let i = 0; i < RATE_PAY.length; i += 1) {
    await stateFxRate(w, INVOICE_CCY, NEW_BASE_CCY, must(RATE_PAY[i], `rate ${i}`), await instantOf(businessId, must(dPay[i], `payment date ${i}`)));
  }

  // ── step 3: priced stock and the credit sale, on the sale's own date ───
  const onSale: SettlementWorld = { ...w, day: dSale };
  step = 'step 3a — POST /v1/inventory/adjustments, priced stock on the sale date';
  await stockUp(onSale, '100', '50');
  // The posting the stock adjustment makes is what arms the lock; a second
  // change must now be refused, and that refusal is the TRUE reason the state
  // looked unreachable. Measured here, asserted in case 1.
  const relock = await w.t.request.post('/v1/businesses/current/base-currency').set(w.headers).send({ currency: INVOICE_CCY });
  relockStatus = relock.status;
  relockBody = relock.body;

  step = 'step 3b — POST /v1/sales, the credit sale of a product priced in a non-base currency';
  const customerId = await newCustomer(onSale);
  invoice = await sellOnCredit(onSale, customerId, QUANTITY);

  // ── steps 4 and 5: two payments at two rates, then the closing one ─────
  before = await ledgerSnapshot(businessId);
  legs = [];
  const inv = must(invoice, 'the invoice');
  // The chain position this file PREDICTS for each leg. The server derives it
  // under its own lock; `releasedBeforeMinor` is the prediction, and case 5
  // asserts the server's agrees.
  let predictedX = 0n;
  for (let i = 0; i < APPLIED.length; i += 1) {
    const paymentId = randomUUID();
    const date = must(dPay[i], `payment date ${i}`);
    const appliedMinor = must(APPLIED[i], `applied ${i}`);
    step = `step ${i < APPLIED.length - 1 ? 4 : 5} — POST /v1/customer-payments leg ${i + 1} of ${APPLIED.length} on ${date}`;
    const res = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: date,
      // Stated, not defaulted to the base: the payment is in the INVOICE's
      // currency, so `payment_allocations_same_currency_ck` (`0081:338`) binds
      // `payment_amount_minor = invoice_amount_applied_minor` and the only
      // thing that can make the realized difference non-zero is the RATE.
      currencyCode: INVOICE_CCY,
      amountMinor: appliedMinor,
      // `creditId` is OMITTED, not null: every leg is fully allocated so there
      // is no surplus, and `collectPayment` serialises the absent field as the
      // `null` the schema requires of a fully-allocated payment.
      // Only the four request keys are serialised (`allocationRequestBody`);
      // the rest of `AllocationInput` is this file's expectation half and
      // never reaches the wire.
      allocations: [
        {
          invoiceId: inv.invoiceId,
          appliedMinor,
          releasedBeforeMinor: predictedX.toString(),
          invoiceTotalTxnMinor: inv.totalTxnMinor,
          invoiceTotalBaseMinor: inv.totalBaseMinor,
          invoiceToBaseRateR10: rateToR10(inv.sourceToBaseRate),
          paymentToBaseRateR10: rateToR10(must(RATE_PAY[i], `rate ${i}`)),
        },
      ],
    });
    if (res.status >= 300) {
      refusedAt = `step ${i < APPLIED.length - 1 ? 4 : 5} — POST /v1/customer-payments leg ${i + 1} refused ${res.status}: ${JSON.stringify(res.body)}`;
      return;
    }
    const snap = await paymentSnapshot(ownerPool(), businessId, paymentId);
    legs.push({ paymentId, date, rate: must(RATE_PAY[i], `rate ${i}`), appliedMinor, storedRate: snap.paymentToBaseRate });
    predictedX += BigInt(appliedMinor);
  }
  allocations = await readAllocations(businessId, must(invoice, 'the invoice').invoiceId);
  after = await ledgerSnapshot(businessId);
}

beforeAll(async () => {
  try {
    await drive();
  } catch (e) {
    // A REFUSAL IS A RESULT. Whatever refused — a route status, an `expect`
    // inside a sanctioned fixture helper, or the database raising from a
    // deferred constraint trigger — is recorded against the step it stopped at
    // and asserted by the named case below. Nothing is worked around and
    // nothing is weakened to get past it.
    refusedAt = `${step}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
});

afterAll(async () => {
  await w?.t.close();
  await resetData();
});

describe(CLAIM, () => {
  it('HAS A SUBJECT — the settlement relations, routines, registry rows and both routes are present, and both currencies exist', async () => {
    expect(missing, `NO SUBJECT — ${missing.join('; ')}`).toEqual([]);
    const ccy = await ownerPool().query<{ code: string }>(`SELECT code::text FROM currencies WHERE code = ANY($1::text[]) ORDER BY code`, [
      [INVOICE_CCY, NEW_BASE_CCY],
    ]);
    expect(ccy.rows.map((r) => r.code).sort(), `NO SUBJECT — a currency this suite moves the base between is not in the registry (0001:9)`).toEqual(
      [INVOICE_CCY, NEW_BASE_CCY].sort(),
    );
  });

  it('the path was not refused at any of the five steps', () => {
    expect(refusedAt, `THE PATH WAS REFUSED, which is a result and not a failure: ${refusedAt}`).toBeNull();
  });

  it('1. the state the impossibility claim calls unreachable is reached by TWO ORDINARY API CALLS, and the lock is what closes the window', () => {
    expect(refusedAt).toBeNull();
    expect(
      financialStartedBefore,
      `the window §55 opens is "before the first posting": with financial_started_at = ${String(financialStartedBefore)} the change below would have been refused`,
    ).toBeNull();
    expect(baseBefore, 'the base currency at onboarding').toBe(INVOICE_CCY);
    expect(priceCurrencyBefore, `the fixture product is priced in the base OF THE MOMENT, which is what catalog.service.ts:247 would also have produced`).toBe(
      INVOICE_CCY,
    );
    expect(changeStatus, `POST /v1/businesses/current/base-currency: ${JSON.stringify(changeBody)}`).toBeLessThan(300);
    expect(baseAfter, 'the base currency after the change').toBe(NEW_BASE_CCY);
    // The whole claim rests on these two lines being equal. They are not, and
    // nothing re-read the product when the base moved.
    expect(
      priceCurrencyAfter,
      `the product's price currency is UNCHANGED by the base moving — catalog.service.ts:247 and :321 compare the two only when a PRODUCT is written, never when the BASE is`,
    ).toBe(INVOICE_CCY);
    expect(
      priceCurrencyAfter === baseAfter,
      `a product priced in ${priceCurrencyAfter} now exists under a ${baseAfter} base, and no row was written by hand to make it so`,
    ).toBe(false);
    // And the TRUE reason the state looked unreachable: the lock, which arms
    // at the first posting and not before.
    expect(relockStatus, `a SECOND change, after the stock posting, must be refused: ${JSON.stringify(relockBody)}`).toBeGreaterThanOrEqual(400);
    expect(
      JSON.stringify(relockBody),
      `and refused by the LOCK (BASE_CURRENCY_LOCKED, tenancy.service.ts:450), which is what makes the window "before the first posting" rather than "never"`,
    ).toContain('BASE_CURRENCY_LOCKED');
  });

  it('2. the committed invoice is in a NON-BASE currency with a manual rate snapshot, so B ≠ T', () => {
    expect(refusedAt).toBeNull();
    const i = must(invoice, 'the committed invoice');
    expect(i.currencyCode, `the sale's currency is the PRODUCT's (0078:740), not the base`).toBe(INVOICE_CCY);
    expect(baseAfter, 'and the base is the other one').toBe(NEW_BASE_CCY);
    expect(
      i.rateSource,
      `the invoice snapshotted a REGISTRY rate, so the FX branch of sale-commit.service.ts:707-733 — the one the cross-currency golden calls "the dead FX branch it strands" — executed`,
    ).toBe('manual');
    expect(i.sourceToBaseRate, 'and it is the rate stated for the sale date').toBe(RATE_SALE);
    const T = BigInt(i.totalTxnMinor);
    const B = BigInt(i.totalBaseMinor);
    expect(T > 0n, `NO SUBJECT — the invoice totals ${T} minor units`).toBe(true);
    expect(B !== T, `B = ${B} and T = ${T} must differ, or every figure below collapses to the single-currency case this suite exists to escape`).toBe(true);
    expect(B, `and B is HALF_EVEN(T · R) through the estate's own primitive`).toBe(toBase(T, rateToR10(RATE_SALE)));
  });

  it("3. the three legs carry THREE DIFFERENT stored rates, none of them the invoice's", () => {
    expect(refusedAt).toBeNull();
    const i = must(invoice, 'the committed invoice');
    expect(legs.length, 'three payments were collected').toBe(APPLIED.length);
    for (const leg of legs) {
      expect(leg.storedRate, `payment ${leg.paymentId} on ${leg.date} froze the rate in force at its OWN date`).toBe(leg.rate);
      expect(
        leg.storedRate !== i.sourceToBaseRate,
        `and it differs from the invoice's ${i.sourceToBaseRate}, or the realized difference could not be non-zero`,
      ).toBe(true);
    }
    expect(new Set(legs.map((l) => l.storedRate)).size, 'and the three differ from each other').toBe(APPLIED.length);
  });

  it('4. CLOSURE — outstanding_txn_minor = 0 AND outstanding_base_minor = 0', async () => {
    expect(refusedAt).toBeNull();
    const i = must(invoice, 'the committed invoice');
    const read = await derivedRead(ownerPool(), w.shop.businessId, i.invoiceId);
    expect(read.outstandingTxnMinor, `the transaction side closes: paid ${read.paidTxnMinor} of T = ${i.totalTxnMinor}`).toBe(0n);
    expect(
      read.outstandingBaseMinor,
      `AND THE BASE SIDE CLOSES EXACTLY: paid_base ${read.paidBaseMinor} of B = ${i.totalBaseMinor}. This is the figure that has teeth only when B ≠ T`,
    ).toBe(0n);
    expect(read.paidTxnMinor, 'paid, transaction side').toBe(BigInt(i.totalTxnMinor));
    expect(read.paidBaseMinor, 'paid, base side').toBe(BigInt(i.totalBaseMinor));
    expect(read.state, 'and the derived state agrees').toBe('paid');
  });

  it("5. the TELESCOPING identity is why: Σ rel = B exactly, as an absolute value, and each leg is apRelease of the invoice's stored originals", () => {
    expect(refusedAt).toBeNull();
    const i = must(invoice, 'the committed invoice');
    const T = BigInt(i.totalTxnMinor);
    const B = BigInt(i.totalBaseMinor);
    expect(allocations.length, 'one allocation per leg, found by the invoice').toBe(APPLIED.length);
    let x = 0n;
    let sumRel = 0n;
    let sumApplied = 0n;
    for (const a of allocations) {
      expect(a.arReleasedBeforeTxnMinor, `the chain position of line ${a.line} telescopes: X must be the sum of everything applied before it`).toBe(x);
      expect(
        a.invoiceCarryingBaseReleasedMinor,
        `rel = R(X + a) − R(X) at X = ${x}, a = ${a.invoiceAmountAppliedMinor}, recomputed by apRelease from the invoice's STORED (B, T) = (${B}, ${T})`,
      ).toBe(invoiceRelease(B, T, x, a.invoiceAmountAppliedMinor));
      expect(a.invoiceHistoricalToBaseRate, `and the leg carries the INVOICE's historical rate, not a fresh lookup`).toBe(i.sourceToBaseRate);
      x += a.invoiceAmountAppliedMinor;
      sumRel += a.invoiceCarryingBaseReleasedMinor;
      sumApplied += a.invoiceAmountAppliedMinor;
    }
    expect(sumApplied, `Σ a = T`).toBe(T);
    // THE RELEASE IS THE TELESCOPING DIFFERENCE AND NOT A PER-LEG CONVERSION.
    // `R(X + a) − R(X)` and `conv_R(a)` agree whenever the AR dust is zero, so
    // on a fixture whose dust is zero throughout this file could not tell
    // `apRelease` from the single rounding P4-AL-25 forbids. These figures put
    // the two apart on two of the three legs, and this is the assertion that
    // notices.
    const differing = allocations.filter((a) => a.invoiceCarryingBaseReleasedMinor !== toBase(a.invoiceAmountAppliedMinor, rateToR10(i.sourceToBaseRate)));
    expect(
      differing.length,
      `at least one leg must have rel ≠ conv_R(a), or a per-leg conversion would be indistinguishable from the telescoping release: ` +
        allocations
          .map(
            (a) =>
              `X=${a.arReleasedBeforeTxnMinor} rel=${a.invoiceCarryingBaseReleasedMinor} conv=${toBase(a.invoiceAmountAppliedMinor, rateToR10(i.sourceToBaseRate))}`,
          )
          .join('; '),
    ).toBeGreaterThan(0);
    // The absolute value, against the invoice's own stored total — not an
    // identity between two sums this file computed the same way.
    expect(sumRel, `Σ rel must equal the invoice's STORED total_base_minor ${B} EXACTLY, however the individual legs rounded (0081:1330)`).toBe(B);
  });

  it('6. the exchange difference is in realized_fx_gain_loss_minor, is non-zero with BOTH signs, and leaked nowhere', () => {
    expect(refusedAt).toBeNull();
    const i = must(invoice, 'the committed invoice');
    const B = BigInt(i.totalBaseMinor);
    let sumFx = 0n;
    let sumPaymentBase = 0n;
    let sumDust = 0n;
    let sumConvInvoice = 0n;
    for (const a of allocations) {
      // The row CHECK, recomputed rather than trusted: the realized figure is
      // DEFINITIONALLY the residual, so it cannot be anything else without the
      // row being refused (`payment_allocations_realized_ck`, 0081:336).
      expect(
        a.realizedFxGainLossMinor,
        `line ${a.line}: realized = payment_base ${a.paymentBaseAmountMinor} − carrying_released ${a.invoiceCarryingBaseReleasedMinor}`,
      ).toBe(a.paymentBaseAmountMinor - a.invoiceCarryingBaseReleasedMinor);
      // And each figure at the rate of the document that owns it: the payment
      // base at the PAYMENT's rate, which is the whole point of two snapshots.
      const figures = allocationFigures({
        invoiceId: i.invoiceId,
        appliedMinor: a.invoiceAmountAppliedMinor.toString(),
        releasedBeforeMinor: a.arReleasedBeforeTxnMinor.toString(),
        invoiceTotalTxnMinor: i.totalTxnMinor,
        invoiceTotalBaseMinor: i.totalBaseMinor,
        invoiceToBaseRateR10: rateToR10(a.invoiceHistoricalToBaseRate),
        paymentToBaseRateR10: rateToR10(a.paymentToBaseRate),
      });
      expect(a.paymentBaseAmountMinor, `line ${a.line}: conv at the PAYMENT's rate ${a.paymentToBaseRate}`).toBe(BigInt(figures.paymentBaseAmountMinor));
      expect(a.realizedFxGainLossMinor, `line ${a.line}: and the realized figure the estate's own primitives give`).toBe(BigInt(figures.realizedFxMinor));
      expect(a.arDustBaseMinor, `line ${a.line}: the AR dust is rel − conv at the INVOICE's rate`).toBe(BigInt(figures.arDustBaseMinor));
      sumFx += a.realizedFxGainLossMinor;
      sumPaymentBase += a.paymentBaseAmountMinor;
      sumDust += a.arDustBaseMinor;
      sumConvInvoice += toBase(a.invoiceAmountAppliedMinor, rateToR10(a.invoiceHistoricalToBaseRate));
    }
    expect(sumFx !== 0n, `Σ realized = ${sumFx} must be non-zero, or this suite is reporting the single-currency coincidence`).toBe(true);
    expect(
      allocations.some((a) => a.realizedFxGainLossMinor > 0n),
      `at least one leg converts to MORE base than it releases (a gain)`,
    ).toBe(true);
    expect(
      allocations.some((a) => a.realizedFxGainLossMinor < 0n),
      `and at least one to LESS (a loss), so an implementation that always took one side fails`,
    ).toBe(true);
    // Where it is, stated as the residual of the whole settlement.
    expect(sumFx, `Σ realized = Σ payment_base ${sumPaymentBase} − B ${B}: the difference is the residual of the closure and nothing else`).toBe(
      sumPaymentBase - B,
    );
    // And where it is NOT. `Σ rel = B` exactly (case 5) already says it did
    // not leak into the carrying base; these say it did not land anywhere else
    // in the ledger either.
    const fxDelta = after.fxGain - before.fxGain + (after.fxLoss - before.fxLoss);
    expect(
      fxDelta,
      `the ledger's fx_gain + fx_loss moved by −Σ realized (a gain is a CREDIT and a loss a DEBIT, 0081:1508-1513): gain ${before.fxGain}→${after.fxGain}, loss ${before.fxLoss}→${after.fxLoss}`,
    ).toBe(-sumFx);
    expect(after.rounding - before.rounding, `and the rounding account (6100) did not move: ${before.rounding}→${after.rounding}`).toBe(0n);
    expect(after.ar - before.ar, `and the receivable was relieved by exactly B: ${before.ar}→${after.ar}`).toBe(-B);
    // THE AR DUST, LIVE. `settlement-path.ts` says above `arDust` that "an
    // assertion that the dust line is PRESENT would … be an assertion nobody
    // can make true", and the cross-currency golden proves the dust law over
    // synthetic `(B, T, R)` for that reason. On a real invoice in a non-base
    // currency it is true: these figures carry a `+1` and a `−1`.
    expect(
      allocations.filter((a) => a.arDustBaseMinor !== 0n).length,
      `at least one leg carries a NON-ZERO AR dust — the assertion settlement-path.ts calls one nobody can make true: ` +
        allocations.map((a) => `X=${a.arReleasedBeforeTxnMinor} dust=${a.arDustBaseMinor}`).join('; '),
    ).toBeGreaterThan(0);
    // Where it sums to is not an accident, and follows from `Σ rel = B`.
    expect(sumDust, `Σ AR dust must be B ${B} − Σ conv_R(a) ${sumConvInvoice}; measured ${sumDust}`).toBe(B - sumConvInvoice);
  });
});
