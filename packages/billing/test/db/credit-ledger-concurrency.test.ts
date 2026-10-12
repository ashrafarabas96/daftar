/**
 * THE EXECUTED CONCURRENCY PROOF — Master Continuous Mission §12.
 *
 * The mission's words for Phase 5 are that the allocation function in the
 * prepared core does not prove atomicity, and that the transaction, the
 * lock, the constraint, the detection of a credit spent twice at
 * CONCURRENT invoice finalizations, rollback and retry, and
 * identical-source invoices must be EXECUTED. Round 3 of this prep
 * classified all of that `WAITING_FOR_INTEGRATED_SURFACE` on the ground
 * that `packages/billing` is pure and has no database. That ground was
 * only half true: the package has no database, but this container has
 * PostgreSQL 16, and the DDL the MIGRATION PATCH REQUEST asks for can be
 * created on a scratch cluster and attacked. So it is.
 *
 * ── What is proven, and what is NOT ────────────────────────────────────
 *
 * PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER):
 * that §11's design closes the double-spend, that the hazard is REAL
 * without it, and which single mechanism closes which case.
 *
 * NOT proven, and not claimed anywhere: anything about the promoted
 * schema, which does not exist; anything about the integrated
 * finalization command, which has no surface in this package; and any
 * timing or performance figure, which this container may not produce.
 * `test/db/sql/credit-ledger-scratch.sql` carries the same statement at
 * the top of the DDL itself.
 *
 * ── Why two schemas ───────────────────────────────────────────────────
 *
 * `p5naive` is the same ledger with invariant (4) and the
 * identical-source key removed. Case 1 runs the attack against it and
 * the money duplicates; cases 2 and 3 run the same attack against
 * `p5scratch` and it does not. Without `p5naive` these would be tests
 * that pass, with no evidence that they would ever fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { foldCreditBalance } from '../../src/credit';
import { BillingError } from '../../src/errors';
import { appUrl, connect, isBlocked, ownerUrl, pidOf, refusedBy, uuid, waitUntilBlocked } from './helpers/cluster';
import {
  consumedMinor,
  createDraftInvoice,
  finalizeInvoice,
  insertConsumption,
  insertGrant,
  readLedger,
  remainderOf,
  type Scope,
} from './helpers/finalize';

const TENANT = '7f1a0000-0000-4000-8000-000000000001';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

let owner: Client;
let observer: Client;

async function freshScope(schema: string, currency = 'USD'): Promise<Scope> {
  const businessId = uuid();
  await owner.query(`INSERT INTO ${schema}.businesses (tenant_id, id) VALUES ($1, $2)`, [TENANT, businessId]);
  return { tenantId: TENANT, businessId, currency };
}

beforeAll(async () => {
  owner = await connect(ownerUrl());
  observer = await connect(ownerUrl());
});

afterAll(async () => {
  await owner.end();
  await observer.end();
});

describe('the barrier itself', () => {
  /**
   * Every blocking claim in this file rests on `waitUntilBlocked`, so the
   * barrier is tested before it is trusted. An idle backend is not blocked,
   * and the helper must SAY SO by throwing rather than returning — a barrier
   * that returned on an idle backend would make every "it blocks" case below
   * vacuous, and no mutation of the schema would reveal it.
   */
  it('fails, rather than passing, when the backend it watches never blocks', async () => {
    const idle = await connect(ownerUrl());
    try {
      const pid = await pidOf(idle);
      expect(await isBlocked(observer, pid)).toBe(false);
      await expect(waitUntilBlocked(observer, pid, 'an idle backend')).rejects.toThrow(/never waited on a lock/);
    } finally {
      await idle.end();
    }
  }, 30_000);
});

describe('the hazard is real — the naive ledger double-spends', () => {
  it('two concurrent finalizations each spend the whole credit, and both commit', async () => {
    const s = await freshScope('p5naive');
    await insertGrant(owner, 'p5naive', s, 1000n, T0);

    // Each finalization has its own invoice, drafted before either
    // transaction starts — two renewal jobs, not one retried.
    const invA = await createDraftInvoice(owner, 'p5naive', s, 1000n);
    const invB = await createDraftInvoice(owner, 'p5naive', s, 1000n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // Both read before either writes. This is not a contrived
      // interleaving: it is what two renewal jobs, or a renewal and a
      // manual finalization, do when nothing serialises them.
      const planA = await finalizeInvoice(a, 'p5naive', s, invA, 1000n, 'inv-A', T1, { withLock: false });
      const planB = await finalizeInvoice(b, 'p5naive', s, invB, 1000n, 'inv-B', T1, { withLock: false });

      expect(planA.application.appliedMinor).toBe(1000n);
      expect(planB.application.appliedMinor).toBe(1000n);

      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }

    // 2000 consumed against a grant of 1000. Money the platform does not
    // owe has been credited to two invoices, and nothing refused it.
    expect(await consumedMinor(owner, 'p5naive', s)).toBe(2000n);

    // And the fold the pure core would do on that ledger now REFUSES it:
    // the authority rejects what the schema accepted, which is precisely
    // the failure mode a pure guard cannot prevent.
    const ledger = await readLedger(owner, 'p5naive', s);
    const folded = (() => {
      try {
        foldCreditBalance(ledger, { businessId: s.businessId, currency: 'USD' });
        return '';
      } catch (e) {
        return e instanceof BillingError ? e.code : 'not-a-BillingError';
      }
    })();
    expect(folded).toBe('billing.credit_grant_overdrawn');
  });

  it('and the same ledger lets the SAME invoice be finalized twice', async () => {
    const s = await freshScope('p5naive');
    await insertGrant(owner, 'p5naive', s, 1000n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5naive', s, 400n);
    await finalizeInvoice(owner, 'p5naive', s, invoiceId, 400n, 'inv-X', T1, { withLock: false });
    await finalizeInvoice(owner, 'p5naive', s, invoiceId, 400n, 'inv-X', T1, { withLock: false });
    expect(await consumedMinor(owner, 'p5naive', s)).toBe(800n);
  });
});

describe('the constraint — the requested ledger cannot be overdrawn, even with no lock', () => {
  it('the second finalization BLOCKS on the grant remainder and is then refused', async () => {
    const s = await freshScope('p5scratch');
    const grant = await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 1000n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);

      await finalizeInvoice(a, 'p5scratch', s, invA, 1000n, 'inv-A', T1, { withLock: false });

      // B's INSERT must not return while A holds the remainder row. The
      // barrier is an OBSERVED lock wait, not a delay: if B never blocks,
      // `waitUntilBlocked` throws and the case fails.
      const bInsert = finalizeInvoice(b, 'p5scratch', s, invB, 1000n, 'inv-B', T1, { withLock: false });
      await waitUntilBlocked(observer, bPid, 'second finalization on the grant remainder');

      await a.query('COMMIT');

      // Now B wakes, re-evaluates its UPDATE against the committed world,
      // and the CHECK refuses the overdraw. 23514 is `check_violation` —
      // asserted as a SQLSTATE, never as a message substring.
      const refusal = await bInsert.then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, code: refusedBy(e) }),
      );
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.code).toBe('23514/pcgr_never_overdrawn');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(1000n);
    expect(await remainderOf(owner, grant)).toBe(0n);
  });

  it('a direct INSERT cannot overdraw a grant either — the constraint is not a code path', async () => {
    const s = await freshScope('p5scratch');
    const grant = await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const attempt = await owner
      .query(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
            applies_to_grant_id, invoice_id)
         VALUES ($1,$2,$3,'consumption',501,'USD',$4,'inv-raw','hand-written',$5,$6)`,
        [uuid(), s.tenantId, s.businessId, T1, grant, uuid()],
      )
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(attempt).toBe('23514/pcgr_never_overdrawn');
  });
});

describe('the lock — §11b asks for behaviour, not an error', () => {
  it('with the advisory lock the second finalization waits, then applies what is actually left', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 1000n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);

      await finalizeInvoice(a, 'p5scratch', s, invA, 1000n, 'inv-A', T1, { withLock: true });

      // B blocks at the LOCK, which is before it reads anything — so it
      // never forms a plan from a stale balance in the first place. That
      // is the difference between the lock and the constraint: the
      // constraint refuses a wrong plan, the lock prevents one.
      const bRun = finalizeInvoice(b, 'p5scratch', s, invB, 1000n, 'inv-B', T1, { withLock: true });
      await waitUntilBlocked(observer, bPid, 'second finalization on the business advisory lock');

      await a.query('COMMIT');

      const planB = await bRun;
      expect(planB.application.appliedMinor).toBe(0n);
      expect(planB.application.payableMinor).toBe(1000n);
      expect(planB.application.consumptions).toHaveLength(0);
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }

    // Exactly the credit that existed was spent, once, with no error
    // reaching the merchant.
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(1000n);
  });

  it('two finalizations for DIFFERENT businesses do not block each other', async () => {
    const one = await freshScope('p5scratch');
    const two = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', one, 300n, T0);
    await insertGrant(owner, 'p5scratch', two, 300n, T0);
    const invOne = await createDraftInvoice(owner, 'p5scratch', one, 300n);
    const invTwo = await createDraftInvoice(owner, 'p5scratch', two, 300n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await finalizeInvoice(a, 'p5scratch', one, invOne, 300n, 'inv-1', T1, { withLock: true });
      const bPid = await pidOf(b);
      await finalizeInvoice(b, 'p5scratch', two, invTwo, 300n, 'inv-2', T1, { withLock: true });
      // A point observation: B got through while A held its own lock, so
      // the lock is per business and not a platform-wide serialisation.
      expect(await isBlocked(observer, bPid)).toBe(false);
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', one)).toBe(300n);
    expect(await consumedMinor(owner, 'p5scratch', two)).toBe(300n);
  });
});

describe('rollback and retry', () => {
  it('a rolled-back finalization leaves no row and no spent remainder, and the retry applies exactly once', async () => {
    const s = await freshScope('p5scratch');
    const grant = await insertGrant(owner, 'p5scratch', s, 700n, T0);
    const invFirst = await createDraftInvoice(owner, 'p5scratch', s, 700n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await finalizeInvoice(a, 'p5scratch', s, invFirst, 700n, 'inv-A', T1, { withLock: true });
      // Inside the transaction the remainder is already 0 — the decrement
      // is not deferred to commit.
      await a.query('ROLLBACK');
    } finally {
      await a.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
    expect(await remainderOf(owner, grant)).toBe(700n);

    // The retry is a NEW invoice identity; it draws the full credit once.
    await owner.query('BEGIN');
    const invRetry = await createDraftInvoice(owner, 'p5scratch', s, 700n);
    const retry = await finalizeInvoice(owner, 'p5scratch', s, invRetry, 700n, 'inv-A-retry', T2, { withLock: true });
    await owner.query('COMMIT');
    expect(retry.application.appliedMinor).toBe(700n);
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(700n);
    expect(await remainderOf(owner, grant)).toBe(0n);
  });

  it('a retry that re-uses the SAME invoice identity is refused, not applied twice', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 900n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 300n);

    // Each finalization is its own TRANSACTION, because a finalization
    // run statement by statement cannot commit at all — the case below
    // proves that separately, and it is the whole point of the deferred
    // agreement constraint.
    await owner.query('BEGIN');
    await finalizeInvoice(owner, 'p5scratch', s, invoiceId, 300n, 'inv-X', T1, { withLock: true });
    await owner.query('COMMIT');

    await owner.query('BEGIN');
    const second = await finalizeInvoice(owner, 'p5scratch', s, invoiceId, 300n, 'inv-X', T1, { withLock: true }).then(
      () => '',
      (e: unknown) => refusedBy(e),
    );
    await owner.query('ROLLBACK');
    // ROUND 6: this used to be 23505, the partial unique index on
    // (business, invoice, grant). It is now 23000: the settled contract's
    // immutability trigger refuses `open -> open` at the invoice UPDATE,
    // which happens one statement EARLIER than the first consumption
    // insert. The refusal moved, the guarantee did not — and the index is
    // still proved, on its own, by the case below. Idempotency belongs to
    // the schema either way, because a retry is exactly the case where the
    // application's own bookkeeping is the thing that failed.
    expect(second).toBe('23000/si_transition_allowed');
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(300n);
  });

  it('two CONCURRENT finalizations of the same invoice: one commits, the other is refused', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 900n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 200n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);
      await finalizeInvoice(a, 'p5scratch', s, invoiceId, 200n, 'inv-X', T1, { withLock: false });
      const bRun = finalizeInvoice(b, 'p5scratch', s, invoiceId, 200n, 'inv-X', T1, { withLock: false }).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      // B blocks on the invoice ROW LOCK now, not on the ledger: its
      // UPDATE of a row A has already updated cannot proceed until A
      // commits. Then it reads the committed state and the contract
      // refuses the transition.
      await waitUntilBlocked(observer, bPid, 'duplicate invoice finalization');
      await a.query('COMMIT');
      expect(await bRun).toBe('23000/si_transition_allowed');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(200n);
  });

  it('the identical-source key refuses a duplicate consumption on its own, with no state machine involved', async () => {
    // ROUND 6, and it is here because of a mistake that was nearly made:
    // when the immutability trigger started refusing a re-finalization one
    // statement earlier, the two cases above stopped reaching the unique
    // index they were written for — and would have gone on passing while
    // proving something else. A defence that is only ever observed BEHIND
    // another defence is not observed at all.
    const s = await freshScope('p5scratch');
    const grant = await insertGrant(owner, 'p5scratch', s, 900n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 300n);

    await owner.query('BEGIN');
    await insertConsumption(owner, 'p5scratch', s, grant, 100n, invoiceId, 'inv-dup', T1);
    const again = await insertConsumption(owner, 'p5scratch', s, grant, 100n, invoiceId, 'inv-dup', T1).then(
      () => '',
      (e: unknown) => refusedBy(e),
    );
    await owner.query('ROLLBACK');
    expect(again, 'one grant may be consumed once per invoice, and the index is what says so').toBe('23505/pca_one_consumption_per_grant_per_invoice');
  });
});

describe('FIFO is also the deadlock avoidance', () => {
  it('two finalizations drawing across the same two grants in FIFO order do not deadlock', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T0, 'grant-older');
    await insertGrant(owner, 'p5scratch', s, 100n, T1, 'grant-newer');
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 150n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 150n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // Each invoice is 150, so each must draw the older grant in full and
      // part of the newer one: both touch both remainder rows.
      await finalizeInvoice(a, 'p5scratch', s, invA, 150n, 'inv-A', T2, { withLock: false });
      const bPid = await pidOf(b);
      const bRun = finalizeInvoice(b, 'p5scratch', s, invB, 150n, 'inv-B', T2, { withLock: false }).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      await waitUntilBlocked(observer, bPid, 'second finalization on the older grant');
      await a.query('COMMIT');
      // B is refused by the CHECK (there is only 200 of credit for 300 of
      // invoice) — but 40P01, a deadlock, is what must NOT happen.
      const code = await bRun;
      expect(code).not.toBe('40P01');
      expect(code).toBe('23514/pcgr_never_overdrawn');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
  });

  /**
   * ROUND 8. This case used to assert `40P01` (`deadlock_detected`), and it
   * was right to: two writers drawing the same two grants in opposite order
   * formed a cycle, and PostgreSQL killed one of them, so a merchant invoice
   * failed for no reason but the order its rows were written in. That is
   * still the hazard PART 25's "ordered deterministically" exists to prevent,
   * and the proof of it is in `P5-RED-PROOF-RECORD.md` for rounds 4 to 7.
   *
   * It is no longer REACHABLE. Round 8's fix for the challenger's F-03 takes
   * the per-business advisory lock inside `pca_chronology()`, so the lock is
   * held from the first ledger INSERT of either writer, and the second one
   * waits instead of acquiring a row lock the first will reach for. The case
   * now asserts what the schema actually does — serialize — and asserts the
   * ABSENCE of the deadlock, which is the stronger statement.
   *
   * LIMIT, stated because it is the cost of that fix: `lock_grants_in_order`
   * was built as a SECOND line, protecting a future path that forgets the
   * advisory lock. No path can forget it any more, so the suite can no longer
   * observe the FIFO row ordering independently of the advisory lock — a
   * defence observed only behind another defence is not observed. It is now
   * measurable only by mutation, and the mutation that removes the `PERFORM
   * pg_advisory_xact_lock` line from `pca_chronology()` restores the `40P01`
   * this case used to assert. That mutation is recorded as a round-8 red
   * proof; it is the only thing keeping this law honest.
   */
  it('an allocator that writes the same rows in the OPPOSITE order is serialized, not deadlocked', async () => {
    const s = await freshScope('p5scratch');
    const older = await insertGrant(owner, 'p5scratch', s, 1000n, T0, 'grant-older');
    const newer = await insertGrant(owner, 'p5scratch', s, 1000n, T1, 'grant-newer');

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const aPid = await pidOf(a);
      const bPid = await pidOf(b);
      const invA = await createDraftInvoice(owner, 'p5scratch', s, 200n);
      const invB = await createDraftInvoice(owner, 'p5scratch', s, 200n);

      // Row by row, and in a fixed order, so the outcome is not a race the
      // suite happens to win. A draws the OLDER grant first, as PART 25
      // requires. B draws the NEWER one first — the same amounts, the same
      // grants, only the write order reversed.
      await insertConsumption(a, 'p5scratch', s, older, 100n, invA, 'inv-A', T2);
      const bFirst = insertConsumption(b, 'p5scratch', s, newer, 100n, invB, 'inv-B', T2).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );

      // B's first insert is already waiting: A took the business's advisory
      // lock inside the chronology trigger and holds it to commit. Observed
      // on B's own pid, not assumed, and the bound is a FAILURE.
      await waitUntilBlocked(observer, bPid, 'B reaching for the advisory lock A holds');

      // A can still finish its own allocation: it holds the lock, so its
      // second row meets no other writer at all. This is the reach that used
      // to block on B's row lock and close the cycle.
      const aSecond = a
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
              applies_to_grant_id, invoice_id)
           VALUES ($1,$2,$3,'consumption',100,'USD',$4,'inv-A','row-by-row allocation',$5,$6)`,
          [uuid(), s.tenantId, s.businessId, T2, newer, invA],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(await aSecond, 'A could not finish its own allocation while holding the lock').toBe('');
      expect(aPid).toBeGreaterThan(0);

      // Only now, with A committed, does B proceed — and it proceeds in the
      // order it chose, against a committed world.
      await a.query('COMMIT');
      expect(await bFirst, 'B was refused once A had committed').toBe('');
      const bSecond = b
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
              applies_to_grant_id, invoice_id)
           VALUES ($1,$2,$3,'consumption',100,'USD',$4,'inv-B','row-by-row allocation',$5,$6)`,
          [uuid(), s.tenantId, s.businessId, T2, older, invB],
        )
        .then(() => '', (e: unknown) => refusedBy(e));

      // 40P01 is `deadlock_detected`, and its ABSENCE is the assertion. B
      // wrote the same two grants in the reverse of the pinned order and was
      // made to wait rather than killed, so no merchant invoice fails for the
      // order its rows were written in.
      expect(await bSecond, 'the reverse-order writer was deadlocked after all').not.toBe('40P01');
      await b.query('COMMIT').catch(() => undefined);
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('the pure core and the requested DDL agree', () => {
  it('the rows the allocator computes are exactly the rows the schema accepts, and the remainders match the fold', async () => {
    const s = await freshScope('p5scratch');
    const older = await insertGrant(owner, 'p5scratch', s, 400n, T0, 'grant-older');
    const newer = await insertGrant(owner, 'p5scratch', s, 400n, T1, 'grant-newer');

    await owner.query('BEGIN');
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);
    const plan = await finalizeInvoice(owner, 'p5scratch', s, invoiceId, 500n, 'inv-A', T2, { withLock: true });
    await owner.query('COMMIT');

    // FIFO: the older grant is exhausted, the newer one part-drawn.
    expect(plan.application.appliedMinor).toBe(500n);
    expect(plan.application.consumptions.map((c) => c.appliesToGrantId)).toEqual([older, newer]);
    expect(await remainderOf(owner, older)).toBe(0n);
    expect(await remainderOf(owner, newer)).toBe(300n);

    // The database's remainder rows and the pure fold's per-grant
    // remainders are two independent computations of the same number, one
    // maintained incrementally by a trigger and one folded from scratch.
    const after = foldCreditBalance(await readLedger(owner, 'p5scratch', s), {
      businessId: s.businessId,
      currency: 'USD',
    });
    expect(after.balanceMinor).toBe(300n);
    for (const g of after.grants) {
      expect(await remainderOf(owner, g.grantId)).toBe(g.remainingMinor);
    }
  });
});

describe('one lock order for every path', () => {
  /**
   * ROUND 9, the independent challenger's F-10, a P2 found on round 8's own
   * fix. Round 8 closed the chronology race (F-03) by taking the
   * per-business advisory lock INSIDE the `AFTER INSERT` trigger. That is
   * after any row lock the calling transaction already holds — and
   * `lock_grants_in_order` exists, in its own comment, precisely to serve a
   * path that does NOT take the advisory lock first. So on that one path the
   * order inverts and two writers can form a cycle:
   *
   *   T1  lock_grants_in_order  → holds remainder ROW locks, no advisory
   *   T2  INSERT a consumption  → trigger takes the ADVISORY, then wants
   *                               T1's remainder row lock → blocks
   *   T1  INSERT a consumption  → trigger wants the advisory T2 holds → cycle
   *
   * Round 8's own comment claimed "no path in this slice does that". That was
   * wrong: `finalizeInvoice({ withLock: false, withGrantLocks: true })` is
   * supported and is exactly that path. None of the other cases covers it,
   * because every concurrent case in this lane takes the advisory lock first.
   *
   * The fix is one statement: `lock_grants_in_order` takes the SAME key
   * before any row lock, so every path in the schema orders advisory then
   * rows. This case reds without it, with `40P01`.
   */
  it('the grant-lock path and the trigger path cannot deadlock each other', async () => {
    const s = await freshScope('p5scratch');
    const older = await insertGrant(owner, 'p5scratch', s, 1000n, T0, 'fifo-older');
    await insertGrant(owner, 'p5scratch', s, 1000n, T1, 'fifo-newer');

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);
      const invA = await createDraftInvoice(owner, 'p5scratch', s, 200n);
      const invB = await createDraftInvoice(owner, 'p5scratch', s, 200n);

      // T1 takes the remainder ROW locks and NOT the advisory lock — the
      // path `lock_grants_in_order` was written for.
      await a.query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [s.tenantId, s.businessId, s.currency]);

      // T2 writes a row. Its chronology trigger fires before its remainder
      // trigger (AFTER triggers fire in name order, and
      // `pca_chronology_trg` sorts before `pca_maintain_remainder_trg`), so
      // T2 holds the advisory and then wants a row lock T1 holds.
      const bRun = insertConsumption(b, 'p5scratch', s, older, 100n, invB, 'inv-B', T2).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      await waitUntilBlocked(observer, bPid, 'T2 reaching for the remainder row lock T1 holds');

      // T1 now writes, and its trigger reaches for the advisory T2 holds.
      // Without the fix this closes the cycle and PostgreSQL kills one of
      // them; with it, T1 already holds the key and there is no cycle.
      const aRun = await insertConsumption(a, 'p5scratch', s, older, 100n, invA, 'inv-A', T2).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );

      expect(aRun, 'the grant-lock path deadlocked against the trigger path').not.toBe('40P01');
      await a.query('ROLLBACK').catch(() => undefined);
      expect(await bRun, 'the trigger path was deadlocked by the grant-lock path').not.toBe('40P01');
      await b.query('ROLLBACK').catch(() => undefined);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('the ordering conflict, resolved at the write', () => {
  /**
   * ROUND 8, the independent challenger's F-03, a P2. The case below was
   * sequential, and the guard it proved was a SNAPSHOT read: two concurrent
   * writers could not see each other's uncommitted row, so BOTH passed, and
   * the committed ledger was non-monotonic in `(created_at, id)` — the
   * allocation key. Because the ledger is append-only by trigger, the row
   * could never be amended; because `foldCreditBalance` is the single
   * credit-balance authority and refuses a non-monotonic ledger, that
   * business's balance in that currency became permanently unreadable. A
   * writer that promises what it cannot enforce, and a reader that bricks on
   * the result, is worse than no guard.
   *
   * The concurrent case is the one that matters, so it is written first.
   */
  it('two CONCURRENT grants in reverse order: the later writer is refused, not admitted', async () => {
    const s = await freshScope('p5scratch');
    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);

      // A writes the LATER instant and takes the earlier `created_at`.
      await insertGrant(a, 'p5scratch', s, 100n, T1, 'concurrent-newer');

      // B writes the EARLIER instant. Before round 8 its trigger read a
      // snapshot without A's row and admitted it. Now the chronology trigger
      // takes the business's advisory lock, which A holds to commit, so B
      // waits — observed on B's own pid, and the bound is a FAILURE.
      const bRun = insertGrant(b, 'p5scratch', s, 100n, T0, 'concurrent-backdated').then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      await waitUntilBlocked(observer, bPid, 'B waiting for the chronology lock A holds');
      await a.query('COMMIT');

      // B now reads a committed world and sees what it could not see before.
      expect(await bRun, 'a concurrent backdated grant was admitted into the ledger').toBe('23000/pca_chronology_monotonic');
      await b.query('ROLLBACK').catch(() => undefined);
    } finally {
      await a.end();
      await b.end();
    }
    // And the ledger is monotonic, which is the property the guard exists for
    // — asserted on the rows, not on the refusal.
    const rows = await owner.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM p5scratch.platform_credit_adjustments
        WHERE tenant_id = $1 AND business_id = $2 AND currency = $3 ORDER BY created_at, id`,
      [s.tenantId, s.businessId, s.currency],
    );
    const instants = rows.rows.map((r) => r.occurred_at.getTime());
    expect([...instants].sort((x, y) => x - y)).toStrictEqual(instants);
  });

  it('a row whose occurred_at would make the ledger non-monotonic in allocation order is refused', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T1);
    const backdated = await insertGrant(owner, 'p5scratch', s, 100n, T0, 'backdated-grant').then(
      () => '',
      (e: unknown) => refusedBy(e),
    );
    expect(backdated).toBe('23000/pca_chronology_monotonic');
  });

  it('so the ledger the database returns can never be one the balance authority refuses for order', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T0);
    await insertGrant(owner, 'p5scratch', s, 100n, T1);
    await insertGrant(owner, 'p5scratch', s, 100n, T1); // equal instants are allowed
    const ledger = await readLedger(owner, 'p5scratch', s);
    expect(() => foldCreditBalance(ledger, { businessId: s.businessId, currency: 'USD' })).not.toThrow();
  });
});

describe('append-only and tenant isolation, as a non-superuser', () => {
  it('the application role may INSERT but not UPDATE or DELETE', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T0);
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      const upd = await app
        .query(`UPDATE p5scratch.platform_credit_adjustments SET reason = 'x' WHERE business_id = $1`, [s.businessId])
        .then(() => '', (e: unknown) => refusedBy(e));
      const del = await app
        .query(`DELETE FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`, [s.businessId])
        .then(() => '', (e: unknown) => refusedBy(e));
      // 42501 is insufficient_privilege: the role has no UPDATE or DELETE
      // at all, so the append-only trigger is the SECOND line and not the
      // only one.
      expect(upd).toBe('42501');
      expect(del).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('the append-only trigger refuses the owner too, so a privilege grant alone cannot reopen history', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T0);
    const upd = await owner
      .query(`UPDATE p5scratch.platform_credit_adjustments SET reason = 'x' WHERE business_id = $1`, [s.businessId])
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(upd).toBe('23000/pca_append_only');
  });

  it('the application role cannot read another business ledger, nor write one', async () => {
    const mine = await freshScope('p5scratch');
    const theirs = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', mine, 100n, T0);
    await insertGrant(owner, 'p5scratch', theirs, 100n, T0);

    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [mine.businessId]);
      const seen = await app.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`,
        [theirs.businessId],
      );
      expect(seen.rows[0]?.n).toBe('0');

      const wrote = await app
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
           VALUES ($1,$2,$3,'grant',50,'USD',$4,'cross','cross-business write')`,
          [uuid(), theirs.tenantId, theirs.businessId, T2],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      // 42501 — the RLS WITH CHECK refuses it. The role is NOBYPASSRLS
      // and not a superuser, so this is a real refusal and not a
      // tautology.
      expect(wrote).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('the application role has no privilege at all on the grant remainders', async () => {
    const app = await connect(appUrl());
    try {
      const read = await app
        .query(`SELECT 1 FROM p5scratch.platform_credit_grant_remainders LIMIT 1`)
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(read).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('a consumption cannot name a grant of another business or another currency', async () => {
    const mine = await freshScope('p5scratch');
    const theirs = await freshScope('p5scratch');
    const theirGrant = await insertGrant(owner, 'p5scratch', theirs, 100n, T0);
    const cross = await owner
      .query(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
            applies_to_grant_id, invoice_id)
         VALUES ($1,$2,$3,'consumption',50,'USD',$4,'inv','draws another business grant',$5,$6)`,
        [uuid(), mine.tenantId, mine.businessId, T1, theirGrant, uuid()],
      )
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(cross).toBe('23503/pca_grant_same_owner_currency_kind');

    const myGrant = await insertGrant(owner, 'p5scratch', mine, 100n, T0);
    const otherCurrency = await owner
      .query(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
            applies_to_grant_id, invoice_id)
         VALUES ($1,$2,$3,'consumption',50,'EUR',$4,'inv','draws a USD grant in EUR',$5,$6)`,
        [uuid(), mine.tenantId, mine.businessId, T1, myGrant, uuid()],
      )
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(otherCurrency).toBe('23503/pca_grant_same_owner_currency_kind');
  });
});
