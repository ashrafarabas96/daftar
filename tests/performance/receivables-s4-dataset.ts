/**
 * `D-SALES`, THE FAT-TAIL ARM — the dataset P4-D and P4-F are measured on.
 *
 * ── WHAT THE LOCK ASKS FOR, AND WHAT THIS BUILDS ──────────────────────────
 *
 * `P4-AL-73` specifies `D-SALES` at acceptance scale: 20 000 customers,
 * 200 000 invoices over 730 days, 300 000 payments, 500 000 allocations,
 * 15 000 customer credits, 20 000 installment plans, ≈1 000 000 AR/revenue
 * journal lines — **and**, inside that, «a **fat-tail customer** with 2 000
 * invoices and 4 000 allocations, because a statement budget measured on an
 * average customer measures nothing».
 *
 * THIS MODULE BUILDS THE FAT-TAIL ARM AND SAYS SO. The whole of `D-SALES` is
 * `P4-AL-76`'s Tier-1/Tier-2 generator inside `gate:phase4:s8`, and P4-S8 owns
 * it; installment plans have no writer on this head at all. What P4-D and P4-F
 * measure is **one customer's** receivable read and **one** allocation
 * command, and neither is a function of how many OTHER customers exist:
 * `customer_ar_outstanding(business, customer)` filters on
 * `(business_id, customer_id, status)` and `customer_collect_payment` touches
 * the invoices the request names. The populations that DO move those numbers
 * are built here in full, at the lock's stated figures:
 *
 *   — the fat-tail customer: `FAT_TAIL.invoices` open credit invoices and
 *     `FAT_TAIL.allocations` payment allocations across them, two per invoice,
 *     every invoice left with a non-zero outstanding so it stays in the AR sum
 *     (an invoice settled to zero drops out of `customer_ar_outstanding`'s
 *     `HAVING`, and a dataset of closed invoices would measure nothing);
 *   — a MEDIAN population, because `P4-AL-72`'s ratio for this budget is
 *     `p95(fat-tail) ≤ 3 × p95(median)` and a ratio needs a denominator that
 *     is a real customer rather than an empty one;
 *   — customer CREDITS and credit APPLICATIONS, because `invoice_outstanding`
 *     (`0081:1334`) sums over `payment_allocations` UNION ALL
 *     `customer_credit_applications`, and a dataset with an empty second arm
 *     measures half the reader of record;
 *   — a FOREIGN-CURRENCY payment share, so the FX snapshot path is measured
 *     rather than bypassed.
 *
 * The scope gap is declared rather than hidden, and the suite asserts the
 * volume it actually realized before taking any timing (`P4-AL-73`).
 *
 * ── THE CURRENCY MIX, AND WHY IT IS ON THE PAYMENT SIDE ───────────────────
 *
 * The lock asks for «an 85/10/5 currency mix so the FX paths are measured
 * rather than bypassed». On this head **no invoice can be in a currency other
 * than the base**: a product's `price_currency` is pinned to the business base
 * currency, which `tests/golden-regression/phase4-s4/10-settlement-cross-currency.golden.test.ts`
 * records in its own header as the reason its foreign currency is the
 * PAYMENT's. So the mix is realized where the estate permits one — a stated
 * share of the fat customer's payments arrive in `FOREIGN_CURRENCY` against
 * base-currency invoices, through a rate entered by the real
 * `accounting_fx_rate_enter` command. That exercises the three snapshots the
 * FX code actually reads (the invoice's `source_to_base_rate`, the payment's
 * `payment_to_base_rate`, the AR dust and the realized FX) and it is NOT the
 * single-currency case under a label. An invoice-side mix is owed by the slice
 * that unpins `price_currency`, and is recorded as owed.
 *
 * ── BUILT BY THE REAL COMMANDS, AND NOTHING ELSE ──────────────────────────
 *
 * Every invoice arrives through `POST /v1/sales`; every allocation and every
 * credit through `POST /v1/customer-payments`; every credit application
 * through `POST /v1/customer-credits/:creditId/applications`; every rate
 * through `accounting_fx_rate_enter`. Nothing here inserts a `payments`,
 * `payment_allocations`, `customer_credits` or `customer_credit_applications`
 * row by hand.
 *
 * That is a deliberate departure from the P3-S7/P4-A catalogue precedent,
 * which bulk-seeds as the schema owner because what those budgets measure is
 * five index ranges over four relations whose SHAPE a suite can assert row by
 * row. A receivable is not like that: `invoice_outstanding` is a `plpgsql`
 * reader over the settlement chain, and a chain built by hand is a chain no
 * trigger, no verifier and no `UNIQUE` ever judged — so the number measured
 * over it would be a number about the fixture. The cost of the honest route is
 * about 45 ms per invoice on a quiet 4-CPU box, which is why the tier knob
 * exists.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { PG_DIR, PG_PORT, ownerPool } from '../helpers/test-app';
import { reauthenticate } from '../helpers/inventory-commands';
import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  stateFxRate,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import {
  R10,
  allocationFigures,
  applyCredit,
  collectPayment,
  invoiceRelease,
  rateToR10,
  type AllocationInput,
  type PaymentInput,
} from '../golden-regression/phase4-s4/settlement-path';

/**
 * `P4_PERF_SCALE`, the one tier knob, with the accepted meaning: 1 is the
 * acceptance volume and `0.1` is Tier 1 — THE SAME CEILINGS on less data, a
 * deliberately weaker claim, never a reduced dataset to make a number pass
 * (`P4-AL-73`). The same spelling and the same validation as
 * `tests/performance/pos-s3-budgets.test.ts`, so one environment variable
 * means one thing across the phase.
 */
export const SCALE = ((): number => {
  const raw = process.env['P4_PERF_SCALE'];
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`P4_PERF_SCALE must be in (0, 1], got ${raw}`);
  return n;
})();

export const scaled = (n: number): number => Math.max(1, Math.round(n * SCALE));

/**
 * ── THE PRODUCT'S OWN RATE LIMIT, RESPECTED RATHER THAN RAISED ────────────
 *
 * MEASURED, not assumed: the first run of this fixture at `P4_PERF_SCALE=0.1`
 * failed with `{"error":{"code":"RATE_LIMITED"}}` and HTTP 429 on the 300-odd
 * sale of the seed. `apps/api/src/app/runtime.ts:116` configures
 * `{ ttl: 60_000, limit: 300 }` and keys it on the CLIENT — every request in a
 * test arrives from `127.0.0.1`, so one route handler gets 300 requests per
 * minute for the whole suite.
 *
 * That has two consequences, and both are recorded rather than engineered
 * away:
 *
 *   1. A SEED built by the real commands (`P4-AL-73`) cannot issue 4 000-odd
 *      sales faster than the product will accept them, and
 *   2. a 200-iteration HTTP budget (the accepted practice,
 *      `accounting-budgets.test.ts:93`) cannot be taken twice against the same
 *      handler inside one minute.
 *
 * So the fixture PACES itself against the product's own limit. What is NOT
 * done, in either direction: the limit is not raised, the guard is not
 * disabled, `TRUST_PROXY` is not turned on so the fixture could present itself
 * as many clients, no 429 is retried into a sample, and no sample is
 * discarded. `pace()` is always called BEFORE a timing starts, so a wait is
 * never inside a measured span, and the total waited is reported beside the
 * figures so a reader can see what the run cost and why.
 */
export const THROTTLE = {
  /** `apps/api/src/app/runtime.ts:116`, read from the product and not chosen here. */
  limit: 300,
  windowMs: 60_000,
  /**
   * The margin left unused. A suite that paced itself to exactly 300 would be
   * one concurrent background request away from a 429, and a 429 inside a
   * measured iteration is a sample about the limiter.
   */
  headroom: 12,
} as const;

/** The route handlers this fixture drives. One key per handler, because the limiter counts per handler. */
export const ROUTE = {
  sale: 'POST /v1/sales',
  payment: 'POST /v1/customer-payments',
  creditApplication: 'POST /v1/customer-credits/:creditId/applications',
  adjustment: 'POST /v1/inventory/adjustments',
  receivable: 'GET /v1/customers/:customerId/receivable',
  aging: 'GET /v1/customers/:customerId/receivable/aging',
  openInvoices: 'GET /v1/customers/:customerId/open-invoices',
} as const;

interface PaceState {
  /** Every request's instant, in order, trimmed to the trailing window. */
  readonly at: number[];
  requests: number;
  waitedMs: number;
}

const paceStates = new Map<string, PaceState>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait, if needed, so the NEXT request on `routeKey` is one the product's
 * limiter will accept. Returns the milliseconds waited (0 almost always).
 *
 * A fixed window of 60 s is what `@nestjs/throttler` enforces, so a trailing
 * window is the conservative reading of it: the fixture waits for the oldest
 * request in its own trailing minute to age out, which can only ever be at
 * least as long as the product requires.
 */
/**
 * ── THE BEARER, KEPT FRESH ACROSS A SEED LONGER THAN THE TOKEN'S LIFE ─────
 *
 * MEASURED, not assumed: the first acceptance-scale run of this fixture ran
 * for 902 seconds and then died in its `beforeAll` with
 * `{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}`
 * on a sale — HTTP 401 against an assertion that wanted < 300. 902 s is the
 * 900 s of `TokenService.accessTtlSeconds`
 * (`apps/api/src/modules/auth/tokens.ts:60`) plus the request that met it.
 *
 * The cause is not the pacing and not the product. `asMember` builds a static
 * `Authorization: Bearer …` from the token minted at registration, and a seed
 * paced against the product's own 300-per-60-s throttle necessarily runs well
 * past fifteen minutes. So the token expires MID-SEED, and the suite reported
 * one failed hook, seventeen skipped tests and — through a piped wrapper —
 * an exit code of 0.
 *
 * What is done about it, and what is NOT. The fixture RE-AUTHENTICATES
 * through the product's own `POST /v1/auth/login`, which
 * `tests/helpers/inventory-commands.ts` `reauthenticate` drives with the
 * password `registerActor` registered. The TTL is read from the login
 * response's own `expiresInSeconds` rather than copied from the product's
 * source, and the re-mint happens when `MARGIN_FRACTION` of that lifetime is
 * left — a margin, not a race with the expiry. NOT done: the TTL is not
 * raised, the auth guard is not disabled, no token is signed outside the
 * product's own route, the throttle is not bypassed, and no 401 is retried
 * into a sample.
 *
 * WHERE IT HAPPENS MATTERS AS MUCH AS THAT IT HAPPENS. The check is the first
 * thing `pace()` does, and `pace()` is called before EVERY request this
 * fixture makes and never inside a measured span (`measure`'s `before`, and
 * `allocate` before its spy and its clock). So a re-authentication can no
 * more reach a millisecond figure than a pacing wait can, and no call site can
 * forget it: a request that is not paced is a request that will meet the
 * limiter long before it meets the TTL.
 */
export const AUTH = {
  /**
   * Re-mint once this fraction of the stated lifetime remains. A third of 900 s
   * is a 300-second margin and a re-mint about every ten minutes — far enough
   * from the expiry that a slow request cannot straddle it.
   */
  marginFraction: 1 / 3,
  /**
   * A FLOOR on the interval between two re-authentications, so a defect in the
   * arithmetic above can never become a tight login loop against
   * `LOGIN_IP_MAX_ATTEMPTS = 30` per `LOGIN_WINDOW_SECONDS = 300`
   * (`apps/api/src/modules/auth/auth.service.ts`). A few re-authentications
   * over half an hour is fine; a loop is not, and this fixture fails loudly
   * rather than discovering the login limiter the way it discovered the route
   * limiter.
   */
  minIntervalMs: 60_000,
} as const;

interface AuthKeeper {
  readonly world: SettlementWorld;
  /** The product's own stated lifetime of the live token, in seconds. */
  ttlSeconds: number;
  mintedAtMs: number;
  reauthentications: number;
  /** Every re-mint's offset from the keeper's install, in seconds: the audit trail. */
  readonly atSeconds: number[];
}

let keeper: AuthKeeper | null = null;
let installedAtMs = 0;

/**
 * Take over `w`'s authentication for the life of the fixture.
 *
 * The FIRST login happens here, so the mint instant and the lifetime are both
 * known facts rather than a guess about when `registerActor` ran.
 */
export async function installAuthKeeper(w: SettlementWorld): Promise<void> {
  const { expiresInSeconds } = await reauthenticate(w.t, w.owner, w.headers);
  installedAtMs = Date.now();
  keeper = { world: w, ttlSeconds: expiresInSeconds, mintedAtMs: installedAtMs, reauthentications: 0, atSeconds: [] };
}

/**
 * Re-mint if the live bearer is inside its margin. Returns whether it did.
 *
 * Called by `pace()` and therefore outside every measured span. A fixture with
 * no keeper installed is left alone: the short suites that share these helpers
 * finish inside the TTL and have no business logging in again.
 */
export async function ensureFreshAuth(): Promise<boolean> {
  const k = keeper;
  if (k === null) return false;
  const now = Date.now();
  const marginMs = k.ttlSeconds * 1000 * AUTH.marginFraction;
  if (now - k.mintedAtMs < k.ttlSeconds * 1000 - marginMs) return false;
  const sinceLast = now - k.mintedAtMs;
  if (sinceLast < AUTH.minIntervalMs)
    throw new Error(
      `the fixture tried to re-authenticate ${sinceLast} ms after the last mint, under the ${AUTH.minIntervalMs} ms floor — ` +
        `that is a login loop against LOGIN_IP_MAX_ATTEMPTS, not a refresh, and the arithmetic in AUTH is wrong`,
    );
  const { expiresInSeconds } = await reauthenticate(k.world.t, k.world.owner, k.world.headers);
  k.ttlSeconds = expiresInSeconds;
  k.mintedAtMs = Date.now();
  k.reauthentications += 1;
  k.atSeconds.push(Number(((k.mintedAtMs - installedAtMs) / 1000).toFixed(1)));
  return true;
}

/**
 * The re-authentication count and when each happened: part of the load
 * context every figure is reported with (`P4-AL-76`), because a reader has to
 * be able to see that the run outlived its token and that the re-mints
 * happened where they could not reach a number.
 */
export function authReport(): {
  readonly installed: boolean;
  readonly accessTtlSeconds: number;
  readonly marginSeconds: number;
  readonly reauthentications: number;
  readonly atSeconds: readonly number[];
  readonly route: string;
  readonly note: string;
} {
  const k = keeper;
  return {
    installed: k !== null,
    accessTtlSeconds: k?.ttlSeconds ?? 0,
    marginSeconds: Math.round((k?.ttlSeconds ?? 0) * AUTH.marginFraction),
    reauthentications: k?.reauthentications ?? 0,
    atSeconds: k === null ? [] : [...k.atSeconds],
    route: "POST /v1/auth/login (the product's own route; the TTL is read from its response, never raised)",
    note: 'every re-authentication happens inside pace(), which is never inside a measured span',
  };
}

export async function pace(routeKey: string): Promise<number> {
  // The bearer first, THEN the window. Both are things that must happen before
  // a request and must never happen inside a measured span; `pace()` is the
  // one place this fixture guarantees both of those properties at once.
  await ensureFreshAuth();
  const state = paceStates.get(routeKey) ?? { at: [], requests: 0, waitedMs: 0 };
  paceStates.set(routeKey, state);
  const ceiling = THROTTLE.limit - THROTTLE.headroom;
  let waited = 0;
  for (;;) {
    const now = Date.now();
    while (state.at.length > 0 && now - (state.at[0] as number) >= THROTTLE.windowMs) state.at.shift();
    if (state.at.length < ceiling) break;
    const oldest = state.at[0] as number;
    const restMs = Math.max(25, oldest + THROTTLE.windowMs - now + 50);
    await sleep(restMs);
    waited += restMs;
  }
  // AND AGAIN AFTER THE WAIT. A pacing wait can be most of a minute, and the
  // margin is a margin rather than a race precisely because nothing between
  // the check and the request is allowed to eat it. Re-minting here costs a
  // timestamp comparison on every request and a login on none but the few
  // that need one — and the login is a different route handler, so it does
  // not spend this handler's window.
  await ensureFreshAuth();
  state.at.push(Date.now());
  state.requests += 1;
  state.waitedMs += waited;
  return waited;
}

/** What the pacing cost, per route handler: printed with every figure (P4-AL-76's load context). */
export function pacingReport(): Record<string, { requests: number; waitedMs: number }> {
  const out: Record<string, { requests: number; waitedMs: number }> = {};
  for (const [key, state] of paceStates) out[key] = { requests: state.requests, waitedMs: Math.round(state.waitedMs) };
  return out;
}

/** How many of one payment's legs go in one request. A document fact of the fixture, not a product limit. */
export const LEGS_PER_PAYMENT = 25;

/**
 * `P4-AL-73`'s fat-tail customer, verbatim: 2 000 invoices and 4 000
 * allocations.
 *
 * `allocations` is DERIVED as `2 × invoices` and then required to equal the
 * lock's figure at scale 1, rather than being a second constant that could
 * drift from the first. Two allocations per invoice is also what makes the
 * chain real: the second leg sits at a non-zero chain position, so
 * `invoice_carrying_base_released_minor` is summed over a chain somebody
 * walked rather than over one row.
 */
export const FAT_TAIL = { invoices: scaled(2_000), allocations: scaled(2_000) * 2 } as const;

/** The denominator of `P4-AL-72`'s `p95(fat-tail) ≤ 3 × p95(median)`: an ordinary customer. */
export const MEDIAN = { customers: scaled(60), invoicesEach: 3 } as const;

/**
 * Customer credits, and the half of them that is consumed.
 *
 * `P4-AL-73` asks for «15 000 customer credits, half partially consumed».
 * Scaled to the fat-tail arm, and born from payments with ZERO allocations —
 * money on account, which contract OQ-4 makes lawful and which
 * `tests/integration/p4s4-payment-closure.test.ts` proves — so creating them
 * cannot disturb the allocation count the lock fixes above.
 */
export const CREDITS = { born: scaled(40), applied: scaled(20) } as const;

/** What one credit application consumes. Small on purpose: the invoice must keep a non-zero outstanding. */
export const CREDIT_CONSUMED_MINOR = 100n;

/** The foreign currency of the payment-side mix, and its stated share of the fat customer's payments. */
export const FOREIGN_CURRENCY = 'USD';
export const FOREIGN_RATE = '3.6700000000';
/** ≈15 %, the non-base share of `P4-AL-73`'s 85/10/5 mix, realized where the estate permits one. */
export const FOREIGN_PAYMENT_SHARE = 0.15;

/** Every invoice is sold at this quantity, so every total is the same and the fixture is deterministic. */
const QUANTITY = '1';
/** Priced stock, once, for every sale the arm makes. */
const STOCK_UNIT_COST = '5';

export interface FatTailDataset {
  readonly fatCustomerId: string;
  /** The median customers, in creation order. The FIRST is the ratio's denominator. */
  readonly medianCustomerIds: readonly string[];
  /** The fat customer's invoices, in creation order. */
  readonly fatInvoices: readonly OpenInvoice[];
  /** The median customers' invoices, keyed by customer. */
  readonly medianInvoices: ReadonlyMap<string, readonly OpenInvoice[]>;
  /** Every payment id the seed created against the fat customer. */
  readonly fatPaymentIds: readonly string[];
  /** How many of those were in `FOREIGN_CURRENCY`. */
  readonly foreignPaymentCount: number;
  readonly creditIds: readonly string[];
  readonly appliedCreditIds: readonly string[];
  readonly baseCurrencyCode: string;
  /** Wall-clock seconds the seed took, printed with the evidence so a reader knows what it cost. */
  readonly seedSeconds: number;
}

/** One leg of a base-currency allocation: `a` applied at chain position `X`. */
function baseLeg(invoice: OpenInvoice, appliedMinor: bigint, releasedBeforeMinor: bigint): AllocationInput {
  return {
    invoiceId: invoice.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBeforeMinor.toString(),
    invoiceTotalTxnMinor: invoice.totalTxnMinor,
    invoiceTotalBaseMinor: invoice.totalBaseMinor,
  };
}

/**
 * One leg of a FOREIGN-currency allocation: `p` in the payment's currency
 * against `a` in the invoice's.
 *
 * `p = ⌊a · 10^10 / Rp⌋` — the payment amount whose conversion at the
 * payment's own snapshot lands on the invoice's applied amount, computed from
 * the rate rather than typed in, so the figure survives a rate change. The
 * realized FX is then whatever the estate's own primitives say it is; this
 * fixture does not choose its sign, because P4-F measures the COST of the
 * command and not the direction of a gain.
 */
function foreignLeg(invoice: OpenInvoice, appliedMinor: bigint, releasedBeforeMinor: bigint, rateR10: bigint): AllocationInput {
  const paymentAmountMinor = (appliedMinor * R10) / rateR10;
  if (paymentAmountMinor <= 0n) throw new Error(`a foreign leg of ${appliedMinor} at ${rateR10} converts to nothing`);
  return { ...baseLeg(invoice, appliedMinor, releasedBeforeMinor), paymentAmountMinor: paymentAmountMinor.toString(), paymentToBaseRateR10: rateR10 };
}

/** The applied amount of one leg: a QUARTER of the invoice, so two legs leave half of it outstanding. */
export function quarterOf(invoice: OpenInvoice): bigint {
  const q = BigInt(invoice.totalTxnMinor) / 4n;
  if (q <= 0n) throw new Error(`the invoice totals ${invoice.totalTxnMinor} minor units, which cannot carry a four-part chain`);
  return q;
}

/**
 * Collect one payment over `legs` and REQUIRE it to commit.
 *
 * A seed that tolerated a refusal would build a smaller dataset and then
 * measure it, which is the reduced-dataset failure `P4-AL-73` forbids in the
 * other direction. So the status is asserted with the body in the message: a
 * refusal here is a RED naming what the command said, never a quieter run.
 */
async function pay(w: SettlementWorld, input: PaymentInput): Promise<void> {
  await pace(ROUTE.payment);
  const res = await collectPayment(w.t, w.headers, input);
  expect(res.status, `the seed's collection of ${input.amountMinor} over ${input.allocations.length} leg(s) commits: ${JSON.stringify(res.body)}`).toBeLessThan(
    300,
  );
}

/**
 * One credit sale, paced against the product's own limiter.
 *
 * Every `sellOnCredit` in this module goes through here. `sellOnCredit` itself
 * belongs to the accepted P4-S4 settlement world and is not this suite's to
 * change, so the pacing sits at the CALL SITE rather than inside a helper two
 * other suites depend on.
 */
async function sell(w: SettlementWorld, customerId: string, quantity: string): Promise<OpenInvoice> {
  // `pace()` keeps the bearer fresh as well as the rate lawful: the seed runs
  // for longer than the product's access token lives, and `ensureFreshAuth`
  // re-mints inside it, outside every measured span. There is ONE keeper, and
  // it reads the lifetime off the product rather than keeping a copy of it.
  await pace(ROUTE.sale);
  return sellOnCredit(w, customerId, quantity);
}

/** Priced stock in, paced: one request, but it shares the adjustment handler's allowance with nothing else here. */
export async function pacedStockUp(w: SettlementWorld, quantity: string, unitCost: string): Promise<void> {
  await pace(ROUTE.adjustment);
  await stockUp(w, quantity, unitCost);
}

/** One paced credit sale, for the invoice pools the budget suite builds itself. */
export async function pacedSellOnCredit(w: SettlementWorld, customerId: string, quantity: string): Promise<OpenInvoice> {
  return sell(w, customerId, quantity);
}

/** The world's credential, kept fresh outside every measured span — re-exported so the budget suite can call it where it paces. */

/**
 * THE SEED.
 *
 * Deterministic in everything but the document UUIDs: the same quantities, the
 * same quarter chain, the same credit amounts and the same currency share on
 * every run, so two runs' numbers are comparable.
 */
export async function seedFatTailArm(w: SettlementWorld): Promise<FatTailDataset> {
  const startedAt = process.hrtime.bigint();
  const baseCurrencyCode = await baseCurrency(w);
  expect(FOREIGN_CURRENCY, `NO SUBJECT — the foreign payment share must not be the base currency ${baseCurrencyCode}`).not.toBe(baseCurrencyCode);
  const rateR10 = rateToR10(FOREIGN_RATE);
  await stateFxRate(w, FOREIGN_CURRENCY, baseCurrencyCode, FOREIGN_RATE, `${w.day}T00:00:01Z`);

  // Enough priced stock for every sale the arm makes, in one adjustment: the
  // goods carry value, so no invoice below is zero-valued.
  const units = FAT_TAIL.invoices + MEDIAN.customers * MEDIAN.invoicesEach + 16;
  await pacedStockUp(w, String(units), STOCK_UNIT_COST);

  // ── 1. the fat-tail customer's invoices ────────────────────────────────
  const fatCustomerId = await newCustomer(w);
  const fatInvoices: OpenInvoice[] = [];
  for (let i = 0; i < FAT_TAIL.invoices; i += 1) fatInvoices.push(await sell(w, fatCustomerId, QUANTITY));

  // ── 2. two allocations per invoice, in two passes over the same chain ──
  //
  // Two passes and not two legs of one payment: a payment naming the same
  // invoice twice is one document settling one position twice, and the chain
  // position of the second leg is only real if a FIRST payment has already
  // committed. Pass A writes every invoice's leg at X = 0; pass B writes every
  // invoice's leg at X = the release pass A made.
  const fatPaymentIds: string[] = [];
  let foreignPaymentCount = 0;
  const batches = Math.ceil(fatInvoices.length / LEGS_PER_PAYMENT);
  for (const pass of [0, 1] as const) {
    for (let b = 0; b < batches; b += 1) {
      const slice = fatInvoices.slice(b * LEGS_PER_PAYMENT, (b + 1) * LEGS_PER_PAYMENT);
      if (slice.length === 0) continue;
      // The stated non-base share, taken deterministically from the batch
      // index so the mix is the same on every run and at every scale.
      const foreign = (b + pass * batches) % Math.max(1, Math.round(1 / FOREIGN_PAYMENT_SHARE)) === 0;
      const legs = slice.map((invoice) => {
        const a = quarterOf(invoice);
        const x = pass === 0 ? 0n : invoiceRelease(BigInt(invoice.totalBaseMinor), BigInt(invoice.totalTxnMinor), 0n, a);
        return foreign ? foreignLeg(invoice, a, x, rateR10) : baseLeg(invoice, a, x);
      });
      const amountMinor = legs.reduce((acc, leg) => acc + BigInt(allocationFigures(leg).paymentAmountMinor), 0n);
      const paymentId = randomUUID();
      await pay(w, {
        paymentId,
        customerId: fatCustomerId,
        paymentMethodId: w.paymentMethodId,
        paymentDate: w.day,
        ...(foreign ? { currencyCode: FOREIGN_CURRENCY } : {}),
        amountMinor: amountMinor.toString(),
        allocations: legs,
      });
      fatPaymentIds.push(paymentId);
      if (foreign) foreignPaymentCount += 1;
    }
  }

  // ── 3. customer credits, born on account, half of them consumed ────────
  //
  // Zero allocations: the whole amount becomes a credit (contract OQ-4), so
  // the credit population cannot move the allocation count the lock fixes.
  const creditIds: string[] = [];
  for (let i = 0; i < CREDITS.born; i += 1) {
    const creditId = randomUUID();
    const paymentId = randomUUID();
    await pay(w, {
      paymentId,
      customerId: fatCustomerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '5000',
      creditId,
      allocations: [],
    });
    fatPaymentIds.push(paymentId);
    creditIds.push(creditId);
  }

  const appliedCreditIds: string[] = [];
  for (let i = 0; i < Math.min(CREDITS.applied, creditIds.length, fatInvoices.length); i += 1) {
    const creditId = creditIds[i];
    const invoice = fatInvoices[i];
    if (creditId === undefined || invoice === undefined) continue;
    await pace(ROUTE.creditApplication);
    const res = await applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId: fatCustomerId,
      invoiceId: invoice.invoiceId,
      applicationDate: w.day,
      consumedMinor: CREDIT_CONSUMED_MINOR.toString(),
      remainingBeforeMinor: '5000',
      creditOriginalMinor: '5000',
      creditOriginalCarryingMinor: '5000',
      leg: baseLeg(invoice, CREDIT_CONSUMED_MINOR, 2n * quarterOf(invoice)),
    });
    expect(res.status, `the seed's credit application commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    appliedCreditIds.push(creditId);
  }

  // ── 4. the median population ───────────────────────────────────────────
  const medianCustomerIds: string[] = [];
  const medianInvoices = new Map<string, readonly OpenInvoice[]>();
  for (let c = 0; c < MEDIAN.customers; c += 1) {
    const customerId = await newCustomer(w);
    medianCustomerIds.push(customerId);
    const mine: OpenInvoice[] = [];
    for (let i = 0; i < MEDIAN.invoicesEach; i += 1) mine.push(await sell(w, customerId, QUANTITY));
    medianInvoices.set(customerId, mine);
    // One allocation each, so a median customer's read walks a settled chain
    // too and the ratio compares like with like.
    const legs = mine.map((invoice) => baseLeg(invoice, quarterOf(invoice), 0n));
    await pay(w, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: legs.reduce((acc, leg) => acc + BigInt(leg.appliedMinor), 0n).toString(),
      allocations: legs,
    });
  }

  return {
    fatCustomerId,
    medianCustomerIds,
    fatInvoices,
    medianInvoices,
    fatPaymentIds,
    foreignPaymentCount,
    creditIds,
    appliedCreditIds,
    baseCurrencyCode,
    seedSeconds: Number((Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(1)),
  };
}

/** What the dataset actually HOLDS, counted in the database rather than assumed from the loop above. */
export interface RealizedVolume {
  readonly fatOpenInvoices: number;
  readonly fatOutstandingInvoices: number;
  readonly fatAllocations: number;
  readonly fatCreditApplications: number;
  readonly fatCredits: number;
  readonly fatPayments: number;
  readonly fatForeignPayments: number;
  readonly medianCustomers: number;
  readonly medianOpenInvoicesEach: readonly number[];
  readonly businessInvoices: number;
  readonly businessAllocations: number;
}

export async function realizedVolume(businessId: string, d: FatTailDataset): Promise<RealizedVolume> {
  const pool = ownerPool();
  const one = async (sql: string, params: readonly unknown[]): Promise<number> => {
    const r = await pool.query<{ n: string }>(sql, [...params]);
    return Number.parseInt(r.rows[0]?.n ?? '0', 10);
  };
  const medianEach: number[] = [];
  for (const customerId of d.medianCustomerIds) {
    medianEach.push(
      await one(`SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND customer_id = $2 AND status = 'open'`, [businessId, customerId]),
    );
  }
  return {
    fatOpenInvoices: await one(`SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND customer_id = $2 AND status = 'open'`, [
      businessId,
      d.fatCustomerId,
    ]),
    // The invoices the reader of record actually SUMS: `customer_ar_outstanding`
    // drops a chain settled to zero through its `HAVING`, so a dataset of
    // closed invoices would be a dataset the budget never reads.
    fatOutstandingInvoices: await one(
      `SELECT count(*)::text AS n FROM invoices i JOIN LATERAL invoice_outstanding(i.business_id, i.id) o ON TRUE
        WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open' AND o.outstanding_txn_minor <> 0`,
      [businessId, d.fatCustomerId],
    ),
    fatAllocations: await one(
      `SELECT count(*)::text AS n FROM payment_allocations a JOIN invoices i ON i.business_id = a.business_id AND i.id = a.invoice_id
        WHERE a.business_id = $1 AND i.customer_id = $2`,
      [businessId, d.fatCustomerId],
    ),
    fatCreditApplications: await one(`SELECT count(*)::text AS n FROM customer_credit_applications c WHERE c.business_id = $1 AND c.customer_id = $2`, [
      businessId,
      d.fatCustomerId,
    ]),
    fatCredits: await one(`SELECT count(*)::text AS n FROM customer_credits WHERE business_id = $1 AND customer_id = $2`, [businessId, d.fatCustomerId]),
    fatPayments: await one(`SELECT count(*)::text AS n FROM payments WHERE business_id = $1 AND customer_id = $2`, [businessId, d.fatCustomerId]),
    fatForeignPayments: await one(`SELECT count(*)::text AS n FROM payments WHERE business_id = $1 AND customer_id = $2 AND currency_code <> $3`, [
      businessId,
      d.fatCustomerId,
      d.baseCurrencyCode,
    ]),
    medianCustomers: d.medianCustomerIds.length,
    medianOpenInvoicesEach: medianEach,
    businessInvoices: await one(`SELECT count(*)::text AS n FROM invoices WHERE business_id = $1`, [businessId]),
    businessAllocations: await one(`SELECT count(*)::text AS n FROM payment_allocations WHERE business_id = $1`, [businessId]),
  };
}

/**
 * ── WHICH SERVER THE FIGURES WERE TAKEN ON, MEASURED AND NOT ASSUMED ──────
 *
 * `tests/helpers/plan-evidence-env.ts` already reads every fact ABOUT the
 * server out of the connection that is about to be EXPLAINed — version,
 * `datcollate`, `datctype`, locale provider, ICU locale, encoding — and
 * `classifyPlanEvidence` already decides from those whether the run may be
 * called authoritative. None of that is duplicated here and none of it is
 * inferred.
 *
 * What that module cannot know is the one fact that is a property of the
 * HARNESS rather than of the server: whether this run started its own
 * embedded PostgreSQL or reused one that was already listening.
 * `startOrReuse` pings first and returns the moment a usable server answers,
 * so the same code path serves both, and a record that said "PG_DIR=…"
 * beside a figure taken on somebody else's server would be a lie by
 * implication.
 *
 * So the provenance is DERIVED BY A STATED RULE from two measurements a
 * reader can repeat: the embedded distribution keeps its major in
 * `PG_DIR/PG_VERSION`, and the connected server reports its own. The run is
 * EMBEDDED only when that data directory exists and its major is the major
 * that answered. Anything else — no data directory, or a different major on
 * the wire — is an external server, and the rule is recorded with the verdict
 * so the derivation is auditable rather than trusted.
 */
export interface ServerProvenance {
  readonly kind: 'external' | 'embedded';
  readonly why: string;
  readonly port: number;
  /** `PG_DIR` exactly as the environment gave it, or null when none was passed. */
  readonly pgDirEnv: string | null;
  /** The embedded data directory the harness would have used, and what it holds. */
  readonly embeddedDataDirectory: string;
  readonly embeddedDataDirectoryMajor: number | null;
  readonly connectedMajor: number;
}

export function serverProvenance(connectedMajor: number): ServerProvenance {
  const versionFile = join(PG_DIR, 'PG_VERSION');
  let embeddedMajor: number | null = null;
  if (existsSync(versionFile)) {
    const raw = Number.parseInt(readFileSync(versionFile, 'utf8').trim(), 10);
    embeddedMajor = Number.isInteger(raw) ? raw : null;
  }
  const embedded = embeddedMajor !== null && embeddedMajor === connectedMajor;
  return {
    kind: embedded ? 'embedded' : 'external',
    why: embedded
      ? `the embedded data directory ${PG_DIR} holds major ${embeddedMajor as number}, which is the major that answered on port ${PG_PORT}`
      : embeddedMajor === null
        ? `no embedded data directory exists at ${PG_DIR}, so nothing this harness starts could have answered on port ${PG_PORT}: the server on it is external`
        : `the embedded data directory ${PG_DIR} holds major ${embeddedMajor}, but major ${connectedMajor} answered on port ${PG_PORT}: the server measured is external`,
    port: PG_PORT,
    pgDirEnv: process.env['PG_DIR'] ?? null,
    embeddedDataDirectory: PG_DIR,
    embeddedDataDirectoryMajor: embeddedMajor,
    connectedMajor,
  };
}

/**
 * HOW MUCH ROOM THE RUN HAD, on the filesystem that actually holds the data.
 *
 * The server's own `data_directory` is asked of the server rather than guessed
 * from `PG_DIR`, which is wrong by construction for an external one. A
 * non-superuser connection cannot read that setting, so the field degrades to
 * null and says so; the process's own temporary filesystem is recorded either
 * way, because that is where the harness writes.
 */
export interface FreeDisk {
  readonly dataDirectory: string | null;
  readonly dataDirectoryFreeBytes: number | null;
  readonly tmpFreeBytes: number;
  readonly note: string;
}

export async function freeDisk(): Promise<FreeDisk> {
  const freeOf = (path: string): number | null => {
    try {
      const fs = statfsSync(path);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return null;
    }
  };
  let dataDirectory: string | null = null;
  try {
    const r = await ownerPool().query<{ dir: string }>(`SELECT current_setting('data_directory') AS dir`);
    dataDirectory = r.rows[0]?.dir ?? null;
  } catch {
    dataDirectory = null;
  }
  return {
    dataDirectory,
    dataDirectoryFreeBytes: dataDirectory === null ? null : freeOf(dataDirectory),
    tmpFreeBytes: freeOf('/tmp') ?? 0,
    note:
      dataDirectory === null
        ? 'the connection may not read data_directory, so only the harness filesystem is recorded'
        : 'bavail x bsize on the filesystem holding the server data directory, read before the measurement',
  };
}

/**
 * THE DEPLOYMENT TARGET'S COLLATION SPELLING, RECORDED BESIDE THE RUN'S.
 *
 * `TARGET_PLAN_EVIDENCE_CONTRACT` gates on the PROPERTY — "not byte order" —
 * and not on a literal, for the reason `plan-evidence-env.ts` sets out at
 * length: PostgreSQL stores `datcollate` exactly as given and normalises
 * nothing, so a contract that string-matched one spelling would reject the
 * very environment it describes. A run can therefore be authoritative on a
 * collation spelled differently from CI's, and that is correct rather than a
 * loophole.
 *
 * It is also the kind of thing a reader should never have to infer from two
 * strings in different parts of a document. So the spelling CI's service
 * reports is recorded next to this run's, with the property that is actually
 * load-bearing, and whether the two spellings are identical is stated rather
 * than left to be noticed.
 */
export const CI_SERVICE_COLLATION = {
  spelling: 'en_US.utf8',
  reference: 'image: postgres:16 with LANG=en_US.utf8, .github/workflows/ci.yml',
  byteOrder: false,
} as const;

/**
 * EVERY RELATION THE MEASURED READS TOUCH, WITH WHEN ITS STATISTICS WERE
 * GATHERED (`P4-AL-74`).
 *
 * `[[daftar-a-benchmark-measures-what-the-planner-saw]]`. A null `analyzed`
 * FAILS the suite rather than being measured around: budget C cost 2.9 s on a
 * runner and 122 ms after one `ANALYZE`, with no query and no migration change.
 */
export const MEASURED_RELATIONS = [
  'invoices',
  'sales',
  'payments',
  'payment_allocations',
  'customer_credits',
  'customer_credit_applications',
  'customers',
  'businesses',
  'payment_methods',
  'accounting_fx_rates',
] as const;

export async function planningStatistics(): Promise<Record<string, { rows: number; analyzed: string | null }>> {
  const r = await ownerPool().query<{ relname: string; n_live_tup: string; last_analyze: Date | null; last_autoanalyze: Date | null }>(
    `SELECT relname, n_live_tup::text, last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = ANY($1::text[])`,
    [[...MEASURED_RELATIONS]],
  );
  const out: Record<string, { rows: number; analyzed: string | null }> = {};
  for (const row of r.rows) {
    const when = row.last_analyze ?? row.last_autoanalyze;
    out[row.relname] = { rows: Number.parseInt(row.n_live_tup, 10), analyzed: when === null ? null : when.toISOString() };
  }
  return out;
}

/**
 * HOW BIG THE DATASET IS ON DISK, beside the row counts.
 *
 * `TL-P4-S3-R4` requires an authoritative run to record the server version,
 * both collation spellings, the locale provider, the dataset tier and the
 * `ANALYZE` state. The first three are read by the accepted
 * `tests/helpers/plan-evidence-env.ts`, which also computes whether the run
 * may be CALLED authoritative; this is the one field that module does not
 * carry, and a size is what tells a reader whether the figure was taken on a
 * dataset that fits in shared buffers.
 */
export async function datasetSizeBytes(): Promise<number> {
  const r = await ownerPool().query<{ size: string }>(`SELECT pg_database_size(current_database())::text AS size`);
  return Number.parseInt(r.rows[0]?.size ?? '0', 10);
}

/** Relation-level sizes, so a reader can see WHICH relation the dataset is. */
export async function relationSizes(): Promise<Record<string, number>> {
  const r = await ownerPool().query<{ relname: string; bytes: string }>(
    `SELECT relname, pg_total_relation_size(c.oid)::text AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [[...MEASURED_RELATIONS]],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.relname] = Number.parseInt(row.bytes, 10);
  return out;
}
