/**
 * GOLDEN REGRESSION — P4-S4 C-1: TWO CONCURRENT SETTLEMENTS OF THE LAST
 * REMAINING AMOUNT OF ONE INVOICE.
 * (P4-S4 BUILD CONTRACT OQ-1 and OQ-3; implementation map §8.8 "caps under the
 *  lock" and §9 C-1; `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-32, P4-AL-41,
 *  P4-AL-42, P4-AL-67; `0068:741-745, 761-765`.)
 *
 * The same law `tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts`
 * proves of the final UNIT, asserted of the final AMOUNT: one minor unit of an
 * invoice left to settle, two concurrent collections of exactly that amount,
 * exactly one commit, exactly one stable business refusal, nothing
 * over-allocated, no gap and no overlap on the chain, one entry per allocation
 * and no orphan of either.
 *
 * ── THE INTERLEAVING IS FORCED, AND NOTHING HERE SLEEPS ───────────────────
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. A third connection
 * PARKS the one row lock the settlement command must take — the invoice row
 * `FOR UPDATE`, which is step 6 of the declared lock order of map §8.8 and the
 * CAP LOCK: the outstanding is re-read AFTER that lock and compared against
 * the caller's figure, and a stale figure is `settlement_changed`
 * (`0068:761-765`). The two attempts are enqueued behind the park ONE AT A
 * TIME and each one's arrival in the queue is OBSERVED through
 * `pg_blocking_pids` before the next is launched, so the service order is
 * chosen by this file and not by the host's speed.
 *
 * The mechanism is the accepted P4-S2 one — `parkRow`, `forcedRace`,
 * `waitUntilQueued`, `expectNoDeadlock` — imported and not re-written, because
 * a mechanism described twice drifts. The polls are bounded there and the
 * expiry of a bound is always a FAILURE and never a pass: an attempt that
 * never parked did not contend, and whatever it returned is not a race result.
 *
 * A deadlock is a LOCK-ORDER FINDING. `40P01` has its own outcome kind,
 * nothing retries, nothing touches `deadlock_timeout`
 * (`[[daftar-lock-order-not-retry]]`, P4-AL-41).
 *
 * ── TWO INDEPENDENT MECHANISMS, AND THE GOLDEN NAMES BOTH ─────────────────
 *
 * The loser is refused twice over, and that is deliberate (map §8.8): the
 * command re-reads the outstanding under the invoice lock and refuses the
 * stale figure, AND the level uniqueness `UNIQUE (business_id, invoice_id,
 * ar_released_before_txn_minor)` makes two rows computed from the same chain
 * position a database-level unique violation. The golden asserts the OUTCOME —
 * exactly one commit — and the chain law, which is what both mechanisms exist
 * to produce; the level UNIQUE is proved able to refuse on its own, by direct
 * SQL, in `tests/integration/p4s4-invoice-settlement-chain.test.ts`.
 *
 * ── THIS FILE IS RED UNTIL `0081` LANDS, AND THAT IS CORRECT ──────────────
 *
 * Every `it` begins by requiring its subject. While the four relations, their
 * columns, the two commands, the two verifiers, the registry rows, the
 * reader-of-record seam and the two routes do not exist, the claim "exactly
 * one of two concurrent settlements of the last amount commits" is neither
 * true nor false — it has no subject — and the canary makes that a RED with
 * the missing names in the message.
 *
 * It is NOT skipped, marked `todo` or guarded by an `if`. A conditional pass is
 * a `.skip` the gate's SKIP regex cannot see.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../../helpers/test-app';
import { ownerClient } from '../../helpers/stock-ledger';
import {
  census,
  censusDelta,
  censusKinds,
  discoveredRegistryPrunes,
  expectNoDeadlock,
  forcedRace,
  lostBeyondExpiry,
  parkRow,
  registryExpiry,
  requireSubject,
  type Census,
  type Outcome,
  type RegistryExpiry,
  type RegistryPrune,
} from '../phase4-s2/harness';
import { chainBreaks, chainTotals, derivedRead, invoiceChain, must } from './harness';
import { collectPayment, type AllocationInput } from './settlement-path';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type OpenInvoice, type SettlementWorld } from './settlement-world';

const CLAIM = 'two concurrent settlements of the last remaining amount of one invoice: exactly one commits';

let w: SettlementWorld;
let missing: readonly string[] = [];
let invoice: OpenInvoice;
/** The one minor unit left on the invoice when the race runs, and the chain position it sits at. */
let lastAmount = 0n;
let lastPosition = 0n;
let outcomes: readonly Outcome<Response>[] = [];

let before: Census;
let after: Census;
let registries: readonly string[] = [];
let prunes: readonly RegistryPrune[] = [];
let registryBefore: Readonly<Record<string, RegistryExpiry>> = {};
let registryAfter: Readonly<Record<string, RegistryExpiry>> = {};

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4race');
  missing = await settlementMissing(w);

  // Both discovered, so neither is a list anyone maintains. Read before the
  // subject gate so the two claims at the end of this file can still say
  // "NO SUBJECT" rather than "undefined".
  registries = (await censusKinds(ownerPool())).registries;
  prunes = await discoveredRegistryPrunes(ownerPool());
  if (missing.length > 0) return;

  await stockUp(w, '100', '9');
  const customer = await newCustomer(w);
  invoice = await sellOnCredit(w, customer, '3');
  const total = BigInt(invoice.totalTxnMinor);
  expect(total > 1n, 'the invoice totals more than one minor unit, or there is no "all but the last amount" to settle first').toBe(true);

  // Settle all but ONE minor unit, so the race is for the LAST amount and both
  // attempts are computed from the SAME chain position. An invoice settled by
  // halves would let both attempts succeed and the race would prove nothing.
  lastAmount = 1n;
  lastPosition = total - lastAmount;
  const leg = (appliedMinor: bigint, releasedBefore: bigint): AllocationInput => ({
    invoiceId: invoice.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: invoice.totalTxnMinor,
    invoiceTotalBaseMinor: invoice.totalBaseMinor,
  });
  const warmUp = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: lastPosition.toString(),
    allocations: [leg(lastPosition, 0n)],
  });
  expect(warmUp.status, `all but the last minor unit is settled first: ${JSON.stringify(warmUp.body)}`).toBeLessThan(300);

  before = await census(ownerPool(), w.shop.businessId);
  registryBefore = await registryExpiry(ownerPool(), prunes);

  const attempt = (): Promise<Response> =>
    collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: lastAmount.toString(),
      allocations: [leg(lastAmount, lastPosition)],
    });

  // The park is on the INVOICE row, which is the cap lock of the declared
  // order. A park on an absent row holds nothing and every attempt would sail
  // past, so `parkRow` throws unless it locked exactly one row.
  const park = await parkRow(
    () => ownerClient(),
    `SELECT 1 FROM invoices WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [w.shop.businessId, invoice.invoiceId],
    `parkInvoice: no invoices row for ${invoice.invoiceId}`,
  );
  outcomes = await forcedRace(park, [attempt, attempt], 'C-1 two concurrent settlements of the last remaining amount');

  after = await census(ownerPool(), w.shop.businessId);
  registryAfter = await registryExpiry(ownerPool(), prunes);
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 C-1 two concurrent settlements of the last remaining amount', () => {
  it('the subject exists: the settlement primitive, its relations and its registrations are in the tree', () => {
    requireSubject(missing, CLAIM);
    expect(outcomes.length, 'NO SUBJECT — the race ran no attempts').toBe(2);
  });

  it('no attempt deadlocked: 40P01 is a lock-order defect, never an outcome and never retried', () => {
    requireSubject(missing, CLAIM);
    expectNoDeadlock(outcomes, 'C-1 two concurrent settlements of the last remaining amount');
  });

  it('exactly one settlement commits', () => {
    requireSubject(missing, CLAIM);
    const accepted = outcomes.filter((o) => o.kind === 'ok' && o.value.status >= 200 && o.value.status < 300);
    expect(
      accepted.length,
      `exactly one of two concurrent collections of the last ${lastAmount} minor unit(s) of invoice ${invoice.invoiceId} is accepted. Two ` +
        `would be an over-allocation: the same amount of one invoice released twice. Measured statuses: ` +
        `${JSON.stringify(outcomes.map((o) => (o.kind === 'ok' ? o.value.status : o.kind)))}`,
    ).toBe(1);
  });

  it('exactly one attempt is refused, and the refusal is a stable business refusal', () => {
    requireSubject(missing, CLAIM);
    const refused = outcomes.filter((o) => o.kind === 'ok' && !(o.value.status >= 200 && o.value.status < 300));
    expect(refused.length, 'exactly one of the two concurrent collections is refused').toBe(1);
    const res = (must(refused[0], 'the refusal') as { value: Response }).value;
    expect(
      res.status,
      `the loser is refused with a conflict, not a 500: losing a race for the last amount of an invoice is a BUSINESS outcome. Measured: ` +
        `${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(409);
    expect(res.body?.error?.code, 'the refusal carries the envelope’s stable code').toBe('CONFLICT');
  });

  it('no attempt failed outside the HTTP contract', () => {
    requireSubject(missing, CLAIM);
    expect(
      outcomes.filter((o) => o.kind === 'error').map((o) => String((o as { error: unknown }).error)),
      'neither attempt threw',
    ).toEqual([]);
  });

  it('the invoice is settled EXACTLY once over, with no gap and no overlap on its chain', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(chain.length, 'NO SUBJECT — the invoice carries no settlement row, so the race settled nothing').toBeGreaterThan(1);
    const shown = JSON.stringify(chain.map((s) => ({ rel: s.relation, X: s.positionMinor.toString(), a: s.appliedMinor.toString() })));
    expect(chainBreaks(chain), `the chain of invoice ${invoice.invoiceId} after the forced race: ${shown}`).toEqual([]);
    expect(
      chain.filter((s) => s.positionMinor === lastPosition).length,
      `exactly one row of this business’s chain was computed from position ${lastPosition}, which is where both attempts aimed: ${shown}`,
    ).toBe(1);
    const totals = chainTotals(chain);
    expect(totals.applied.toString(), `and the chain applied exactly the invoice's total ${invoice.totalTxnMinor}, never more: ${shown}`).toBe(
      invoice.totalTxnMinor,
    );
  });

  it('and the reader of record reports nothing outstanding and nothing over-settled', async () => {
    requireSubject(missing, CLAIM);
    const read = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(
      {
        paid_txn: read.paidTxnMinor.toString(),
        outstanding_txn: read.outstandingTxnMinor.toString(),
        outstanding_base: read.outstandingBaseMinor.toString(),
        state: read.state,
      },
      `after the race the invoice is settled once over: an outstanding BELOW zero would be the over-allocation stated as a number`,
    ).toEqual({ paid_txn: invoice.totalTxnMinor, outstanding_txn: '0', outstanding_base: '0', state: 'paid' });
  });

  it('exactly one payment row, one allocation row and no orphan of either direction of the binding', async () => {
    requireSubject(missing, CLAIM);
    const d = censusDelta(before, after);
    expect(d['payments'] ?? 0, 'one payments row — the loser left none').toBe(1);
    expect(d['payment_allocations'] ?? 0, 'one allocation row — no phantom leg from the loser').toBe(1);
    expect(d['customer_credits'] ?? 0, 'the race created no credit: both attempts were fully allocated').toBe(0);
    const entries = d['journal_entries'] ?? 0;
    expect(entries, 'the winner posted its settlement entry').toBeGreaterThanOrEqual(1);
    expect(d['accounting_source_bindings'] ?? 0, 'one accounting source binding per entry — no entry without a source and no source without an entry').toBe(
      entries,
    );
  });

  it('nothing of the whole business is outside the census the loser could have survived in', () => {
    requireSubject(missing, CLAIM);
    // The census is DISCOVERED from `pg_class` — every table carrying
    // `business_id`, plus every table carrying `jti` — so this is a claim
    // about every business-scoped relation that exists rather than about a
    // list someone maintained.
    //
    // The relations deliberately NOT constrained here are the record-keeping
    // ones: `audit_events` and `outbox_events` are append-only, so a row from
    // either racer is the record working rather than a count this law owes
    // anything about.
    //
    // This comment used to say they are written for a REFUSED command too, in
    // the refused command's own transaction. MEASURED, that is false: all 33
    // refusals in `customer_collect_payment` are `RAISE EXCEPTION`, and the
    // audit and outbox inserts are the routine's LAST step, after every one of
    // them — a refused command writes neither row, and a `RAISE` would roll
    // back an earlier one anyway. P4-AL-48 nonetheless requires a refusal to
    // be audited as heavily as a success, so the lock and the accepted
    // transaction model are in contradiction for refusals; it is recorded as
    // an open contract item and is NOT discharged by this suite. The law
    // below never depended on the false half: these two tables are outside
    // `exempt`, so they face only the monotonicity claim, which an append-only
    // table satisfies either way. A false CLAIM, never a false GREEN — but a
    // reviewer who read it concluded P4-AL-48 was satisfied, which is how the
    // gap survived.
    //
    // THE JTI REGISTRIES ARE NOT UNDER THIS LAW EITHER, and that is a finding
    // the P4-S2 estate already paid for. `census()` counts them with NO
    // `business_id` predicate, so their number is a count over the whole
    // cluster and belongs to nobody's race; and the posting path prunes
    // expired jtis on a WALL CLOCK inside the very transaction the race
    // drives, so once a job has been running longer than the prune's interval
    // the count legitimately goes down. A law that calls a garbage collection
    // a defect is a law that will be overridden the first time it fires.
    //
    // What they owe instead is the claim below, which is the one the race is
    // actually about.
    const d = censusDelta(before, after);
    const exempt = new RegExp(`^(payments|payment_allocations|${registries.join('|')})$`);
    const unexpected = Object.entries(d).filter(([table]) => exempt.test(table) === false);
    expect(unexpected.length, `every counted relation is exempt, so this law asserts nothing: ${JSON.stringify(d)}`).toBeGreaterThan(0);
    expect(
      unexpected.every(([, n]) => n >= 0),
      `no count may go DOWN across a race: ${JSON.stringify(d)}`,
    ).toBe(true);
  });

  it('a jti registry may only ever lose rows that had already expired', () => {
    requireSubject(missing, CLAIM);
    // The compensating claim for the exemption above, and it is STRONGER than
    // monotonicity where monotonicity was false: the prune may take expired
    // rows and nothing else, so an unexpired jti can never vanish across the
    // race.
    expect(
      prunes.map((pr) => pr.table),
      'NO SUBJECT — no wall-clock prune was discovered in the live catalogue, so this claim has nothing to be about',
    ).not.toEqual([]);
    for (const pr of prunes) {
      const was = must(registryBefore[pr.table], `${pr.table} before the race`);
      const now = must(registryAfter[pr.table], `${pr.table} after the race`);
      expect(
        lostBeyondExpiry(was, now),
        `${pr.table}: ${was.total} rows before the race of which ${was.expired} were already past ${pr.interval}, and ${now.total} after — ` +
          `a decrease beyond the expired ones is an unexpired jti vanishing, which no prune may do`,
      ).toBe(0);
    }
  });

  it('that law can say no: a vanished UNEXPIRED jti is refused', () => {
    // The red proof for the claim above, on synthetic captures, because an
    // inequality that has only ever been handed a real measurement is an
    // inequality nobody has watched refuse anything.
    expect(lostBeyondExpiry({ total: 4, expired: 1 }, { total: 3 }), 'the expired row may go').toBe(0);
    expect(lostBeyondExpiry({ total: 4, expired: 1 }, { total: 2 }), 'an unexpired row may not').toBe(1);
    expect(lostBeyondExpiry({ total: 4, expired: 0 }, { total: 3 }), 'with nothing expired, any loss is a defect').toBe(1);
    expect(lostBeyondExpiry({ total: 4, expired: 4 }, { total: 0 }), 'an all-expired registry may be emptied').toBe(0);
    expect(lostBeyondExpiry({ total: 2, expired: 0 }, { total: 9 }), 'growth is not a loss').toBe(0);
  });
});
