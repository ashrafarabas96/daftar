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
import { appUrl, borrowedSchema, connect, isBlocked, ownerUrl, pidOf, refusedBy, setRequestContext, uuid, waitUntilBlocked } from './helpers/cluster';
import {
  consumedMinor,
  createBusiness,
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
  if (schema === 'p5scratch') {
    // ROUND 11: the fixture now carries the real table's NOT NULL columns.
    await createBusiness(owner, borrowedSchema(), TENANT, businessId, currency);
  } else {
    // `p5naive` is the DELIBERATELY WRONG design, kept as the control that
    // shows the hazard exists at all. Its stub stays a stub: making it
    // faithful would say something about the control's realism that is not
    // being claimed.
    await owner.query(`INSERT INTO ${schema}.businesses (tenant_id, id) VALUES ($1, $2)`, [TENANT, businessId]);
  }
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
      .then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
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
        .then(
          () => '',
          (e: unknown) => refusedBy(e),
        );
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
        .then(
          () => '',
          (e: unknown) => refusedBy(e),
        );

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
      await setRequestContext(app, s, 'session');
      const upd = await app.query(`UPDATE p5scratch.platform_credit_adjustments SET reason = 'x' WHERE business_id = $1`, [s.businessId]).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      const del = await app.query(`DELETE FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`, [s.businessId]).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
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
    const upd = await owner.query(`UPDATE p5scratch.platform_credit_adjustments SET reason = 'x' WHERE business_id = $1`, [s.businessId]).then(
      () => '',
      (e: unknown) => refusedBy(e),
    );
    expect(upd).toBe('23000/pca_append_only');
  });

  it('the application role cannot read another business ledger, nor write one', async () => {
    const mine = await freshScope('p5scratch');
    const theirs = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', mine, 100n, T0);
    await insertGrant(owner, 'p5scratch', theirs, 100n, T0);

    const app = await connect(appUrl());
    try {
      await setRequestContext(app, mine, 'session');
      const seen = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`, [
        theirs.businessId,
      ]);
      expect(seen.rows[0]?.n).toBe('0');

      const wrote = await app
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
           VALUES ($1,$2,$3,'grant',50,'USD',$4,'cross','cross-business write')`,
          [uuid(), theirs.tenantId, theirs.businessId, T2],
        )
        .then(
          () => '',
          (e: unknown) => refusedBy(e),
        );
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
      const read = await app.query(`SELECT 1 FROM p5scratch.platform_credit_grant_remainders LIMIT 1`).then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
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
      .then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
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
      .then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
    expect(otherCurrency).toBe('23503/pca_grant_same_owner_currency_kind');
  });
});

describe('GAP 1 — the same races, run by the APPLICATION role instead of the platform principal', () => {
  // ROUND 18, AND THIS GAP HAS BEEN OWED SINCE ROUND 8. Every interleaving
  // case above opens its two writers on `ownerUrl()`, and the owner IS the
  // bypass principal in both lanes — `app_bypass()` names `p5owner` in the
  // fixture lane and `daftar_platform` in the real one. So every concurrency
  // claim in this file was measured with RLS satisfied at the first disjunct
  // of every policy, by a role that production does not use for this work.
  //
  // That is not a defect in the races: a lock is a lock whoever takes it, and
  // the constraint that refuses an overdraw does not read a policy. What was
  // missing is the CONJUNCTION — the claim that these races still hold when
  // the writers are subject to the policies, hold only the grants §7 asks
  // for, and set a request context per transaction the way the frozen
  // discipline requires. A guard that refuses under one role and a race that
  // is safe under another are two measurements, not one.
  //
  // The independent challenger named this gap 1 and has declined to cover it
  // at four successive heads, correctly, because nothing measured it. These
  // cases measure it.
  //
  // WHAT STAYS OWNER-ONLY, and why it is not a hole in this block: the GRANT
  // path. Invariant (3) gives the application role SELECT and INSERT on the
  // adjustments relation and nothing on the remainders, and a grant is an
  // administrative act in this design — §7 asks for no application-role path
  // that creates one. So the fixtures below are still written by the owner,
  // and what the application role does is exactly what it does in
  // production: finalize.

  it('the overdraw race is refused by the same named constraint under RLS', async () => {
    const s = await freshScope('p5scratch');
    const grant = await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 1000n);

    const a = await connect(appUrl());
    const b = await connect(appUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // The context is set INSIDE each transaction and dies with it, which is
      // the frozen discipline and not this lane's session-level divergence.
      await setRequestContext(a, s, 'transaction');
      await setRequestContext(b, s, 'transaction');
      const bPid = await pidOf(b);

      await finalizeInvoice(a, 'p5scratch', s, invA, 1000n, 'inv-A-app', T1, { withLock: false });

      // B's outcome is captured the moment it settles, so that a B which
      // FAILED instead of blocking reports its own refusal rather than the
      // barrier's "never waited on a lock" — which says nothing about why.
      let bSettled: string | null = null;
      const bInsert = finalizeInvoice(b, 'p5scratch', s, invB, 1000n, 'inv-B-app', T1, { withLock: false }).then(
        (v) => {
          bSettled = '';
          return v;
        },
        (e: unknown) => {
          bSettled = refusedBy(e) || String(e);
          throw e;
        },
      );
      bInsert.catch(() => undefined);
      // The barrier is an OBSERVED lock wait on a named backend. If B never
      // blocks this throws, so the case cannot pass by B having been let
      // through for want of a privilege.
      try {
        await waitUntilBlocked(observer, bPid, 'second finalization, as the application role');
      } catch (barrier) {
        throw new Error(bSettled === null ? `${String(barrier)}; and B had not settled either` : `B did not block, it settled first with: ${bSettled}`);
      }

      await a.query('COMMIT');

      const refusal = await bInsert.then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, code: refusedBy(e) }),
      );
      expect(refusal.ok, 'the overdraw was admitted when the writers were the application role').toBe(false);
      // The SAME named defence as the owner-run case above, not merely "some
      // refusal": under RLS a `42501` here would also be a failure, and a
      // case asserting only that something was refused could not tell them
      // apart. That is F-11's law applied to the thing F-11 did not cover.
      if (!refusal.ok) expect(refusal.code).toBe('23514/pcgr_never_overdrawn');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(1000n);
    expect(await remainderOf(owner, grant)).toBe(0n);
  });

  it('two application-role finalizations of the SAME invoice: one commits, the other is refused', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 400n);

    const a = await connect(appUrl());
    const b = await connect(appUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await setRequestContext(a, s, 'transaction');
      await setRequestContext(b, s, 'transaction');
      const bPid = await pidOf(b);

      await finalizeInvoice(a, 'p5scratch', s, invoiceId, 400n, 'inv-dup-app', T1, { withLock: false });
      let bSettled: string | null = null;
      const bAttempt = finalizeInvoice(b, 'p5scratch', s, invoiceId, 400n, 'inv-dup-app-2', T1, {
        withLock: false,
      }).then(
        (v) => {
          bSettled = '';
          return v;
        },
        (e: unknown) => {
          bSettled = refusedBy(e) || String(e);
          throw e;
        },
      );
      bAttempt.catch(() => undefined);
      try {
        await waitUntilBlocked(observer, bPid, 'duplicate finalization, as the application role');
      } catch (barrier) {
        throw new Error(bSettled === null ? `${String(barrier)}; and B had not settled either` : `B did not block, it settled first with: ${bSettled}`);
      }

      await a.query('COMMIT');

      const second = await bAttempt.then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      // By NAME, not by "some error happened": the pure law bans the bare
      // form and it caught this line on the first run of this round. The
      // owner-lane case for the same race (line 407) names the same index,
      // and the point of this one is that the APPLICATION role meets the
      // same defence and not a policy refusal that happens to arrive first.
      // MEASURED, not predicted. I first wrote the index's name here —
      // `23505/pca_one_consumption_per_grant_per_invoice`, which is what the
      // owner-lane case at line 407 gets — and the run answered
      // `23000/si_transition_allowed`. The two writers are serialised on the
      // invoice row, so by the time B resumes, A's COMMIT has already moved
      // the invoice out of `draft`, and the STATE MACHINE refuses before any
      // grant is consumed. That is the earlier of the two defences and the
      // better answer.
      //
      // ROUND 20, AND THE FALLBACK IS NOT THE ONE I NAMED. I asked the
      // challenger to plant the obvious single-guard test — replace
      // `si_transition_allowed`'s `RAISE` with `RETURN NEW`, so the state
      // machine admits every transition — expecting this case to go green
      // and prove it rests on one defence. It did not go green. It failed
      // with `23505/pca_one_consumption_per_grant_per_invoice`, the PARTIAL
      // UNIQUE INDEX on `(business_id, invoice_id, applies_to_grant_id)
      // WHERE kind = 'consumption'`: two finalizations of one invoice write
      // the same consumption row, and the index refuses the second.
      //
      // So the fallback is on the CONSUMPTION side, not the invoice side,
      // and this case is backed by two independent defences rather than one.
      // The order is worth stating because the pack named only the outer
      // one: `si_transition_allowed` answers first on the shipped path,
      // and the index refuses the same duplicate if the state machine ever
      // admits it. That is a masking pair in the F-11 sense — two defences
      // for one scenario — though not an invisible one, since the
      // one-at-a-time plant above exposed the inner one immediately.
      expect(second, 'the same invoice was finalized twice by two application sessions').toBe('23000/si_transition_allowed');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }

    // Exactly once applied, read back by the principal whose view no policy
    // narrows, so the assertion is about the stored rows and not about what
    // either writer could see.
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(400n);
  });

  it('two application-role allocators over the same two grants are serialised, and the ordering defence is MASKED by the advisory lock', async () => {
    // ROUND 19, THE CHALLENGER'S BLOCKER ON ROUND 18, AND IT WAS RIGHT.
    // The leg that stood here was not a race at all: A committed before B
    // took any lock, so `40P01` was unreachable whatever the lock order
    // was, and it passed `withLock: true`, which serialises two
    // finalizations before either reaches a grant row. The challenger then
    // measured the consequence — it made `lock_grants_in_order`'s order
    // session-dependent and the whole file stayed 26/26 green — and proved
    // the hazard is real by taking the same two remainder rows in opposite
    // orders from two hand-written sessions: `A 40P01 | B ok`.
    //
    // This leg is the race the old one claimed to be: `withLock: false`,
    // both sessions genuinely in flight, the same barrier and settle-first
    // detection the other two legs use.
    //
    // AND IT MEASURES SOMETHING DIFFERENT FROM WHAT THE REVIEW ASKED FOR,
    // which is the point of running it rather than adopting the sentence.
    // `withLock: false, withGrantLocks: true` does NOT leave the grant
    // order as "the only thing preventing a cycle", because
    // `lock_grants_in_order` takes the per-business ADVISORY lock itself
    // before it takes any row lock — that is round 9's F-10 fix and the
    // schema-wide invariant stated at that `PERFORM`. So on every path this
    // slice has, two allocators are serialised on the advisory key BEFORE
    // the ordering can matter, and the deterministic order is a SECOND line
    // of defence that nothing reaching it can exercise.
    //
    // That is why the challenger's one-at-a-time plant stayed green, and it
    // is this phase's own round-9 lesson (P5 R9): a one-at-a-time mutation
    // sweep cannot see two defences that mask each other. The pair-drop is
    // in `P5-CHECKPOINT.md` §3 as M63/M64/M65 — order inverted alone:
    // green; advisory removed with the order correct: green; BOTH: `40P01`,
    // which reds this leg. So the order's contribution is measured, by the
    // only plant that can see it.
    //
    // What this case therefore asserts, and says so in its name: the two
    // allocators are serialised, B waits on the ADVISORY key and not on a
    // remainder row (read from `pg_locks`, so the claim is about the lock
    // that actually held it), and neither session deadlocks.
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 300n, T0);
    await insertGrant(owner, 'p5scratch', s, 300n, T1);
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 400n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 200n);

    const a = await connect(appUrl());
    const b = await connect(appUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await setRequestContext(a, s, 'transaction');
      await setRequestContext(b, s, 'transaction');
      const bPid = await pidOf(b);

      // A draws across both grants and STAYS OPEN.
      await finalizeInvoice(a, 'p5scratch', s, invA, 400n, 'inv-fifo-a', T2, {
        withLock: false,
        withGrantLocks: true,
      });

      // B is in flight while A holds everything. Its outcome is captured the
      // moment it settles, so a B that deadlocked or was refused reports
      // that instead of the barrier's silence.
      let bSettled: string | null = null;
      const bRun = finalizeInvoice(b, 'p5scratch', s, invB, 200n, 'inv-fifo-b', T2, {
        withLock: false,
        withGrantLocks: true,
      }).then(
        (v) => {
          bSettled = '';
          return v;
        },
        (e: unknown) => {
          bSettled = refusedBy(e) || String(e);
          throw e;
        },
      );
      bRun.catch(() => undefined);
      try {
        await waitUntilBlocked(observer, bPid, 'second allocator, as the application role');
      } catch (barrier) {
        throw new Error(bSettled === null ? `${String(barrier)}; and B had not settled either` : `B did not block, it settled first with: ${bSettled}`);
      }

      // WHICH lock held B. `advisory` is the lock the F-10 invariant says
      // comes first; if a future change removed that `PERFORM`, B would be
      // held by a remainder TUPLE lock instead and this assertion would
      // fail, which is how the case notices that the thing it is describing
      // has changed underneath it.
      const held = await observer.query<{ locktype: string }>(`SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted`, [bPid]);
      expect(
        held.rows.map((r) => r.locktype),
        'B was not waiting on the per-business advisory key, so the F-10 invariant no longer holds on this path',
      ).toStrictEqual(['advisory']);

      await a.query('COMMIT');

      // No deadlock, and B is not refused: it allocates what A left.
      const bOutcome = await bRun.then(
        () => '',
        (e: unknown) => refusedBy(e),
      );
      expect(bOutcome, 'the second application-role allocator deadlocked or was refused').toBe('');
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(600n);
  });
});

describe("B-2 — the advisory key is the writer's own, and the caller cannot defer it away", () => {
  // ROUND 21, THE INDEPENDENT CHALLENGER'S B-2, A FAIL-OPEN. Round 19 of this
  // pack concluded that the deterministic grant order was "unmeasurable
  // without changing the schema" because "no path exists here" that reaches
  // remainder rows without the per-business advisory key. That was false, and
  // the path needs no DDL change and no privilege:
  //
  //   SET CONSTRAINTS p5scratch.pca_chronology_trg DEFERRED;
  //
  // `pca_chronology()` held the only key on that path; `pca_maintain_remainder()`
  // held none of its own and ran second only because PostgreSQL fires
  // same-event triggers in NAME order. Both were DEFERRABLE INITIALLY
  // IMMEDIATE, so one unprivileged statement removed the key and left the
  // remainder decrement unserialised. I reproduced it as `p5_app` in four
  // arms before changing anything (PG 16.15):
  //
  //   deferred + inverted grant order      -> 40P01 deadlock, adv = 0
  //   deferred + FIFO order                -> no deadlock,    adv = 0
  //   shipped  + inverted order            -> no deadlock,    adv = 1
  //   deferred + via lock_grants_in_order  -> no deadlock,    adv = 1
  //
  // The fourth arm is the one that keeps round 19's narrower claim true: the
  // key inside `lock_grants_in_order` is a direct `PERFORM`, not a trigger,
  // so `SET CONSTRAINTS` cannot touch it. What was false was the jump from
  // "that path always holds the key" to "no path reaches the rows without
  // it".
  //
  // The remedy is structural and is in the DDL: the writer takes the key
  // itself (re-entrant, so a caller holding it pays nothing), and both
  // defence triggers are NOT DEFERRABLE. These cases hold both halves.
  it('refuses the deferral BY NAME, for each defence trigger, to the application role', async () => {
    const s = await freshScope('p5scratch');
    const c = await connect(appUrl());
    try {
      await c.query('BEGIN');
      await setRequestContext(c, s, 'transaction');
      for (const trg of ['pca_chronology_trg', 'pca_maintain_remainder_trg']) {
        // Each attempt in its own savepoint: the refusal aborts the
        // subtransaction, and the next attempt needs a live one.
        await c.query('SAVEPOINT attempt');
        const refusal = await c.query(`SET CONSTRAINTS p5scratch.${trg} DEFERRED`).then(
          () => ({ code: '', message: '' }),
          (e: unknown) => ({
            code: typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '',
            message: typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : '',
          }),
        );
        await c.query('ROLLBACK TO SAVEPOINT attempt');
        // 42809 is `wrong_object_type`, which is what PostgreSQL answers for
        // a non-deferrable constraint, and the message names the trigger —
        // so the refusal identifies the defence, as this slice's law
        // requires everywhere else.
        expect({ trg, code: refusal.code }, `${trg} can still be deferred by the application role`).toStrictEqual({
          trg,
          code: '42809',
        });
        expect(refusal.message).toContain(trg);
        expect(refusal.message).toContain('not deferrable');
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('holds the key inside the writer, so two application sessions taking two grants in OPPOSITE order do not deadlock', async () => {
    const s = await freshScope('p5scratch');
    const g1 = await insertGrant(owner, 'p5scratch', s, 300n, T0);
    const g2 = await insertGrant(owner, 'p5scratch', s, 300n, T1);
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 1000n);

    const claim = async (c: Client, invoiceId: string): Promise<void> => {
      await c.query(
        `UPDATE p5scratch.subscription_invoices
            SET state = 'open', issued_at = $2, credit_minor = $3, total_minor = $4
          WHERE id = $1`,
        [invoiceId, T2, '200', '800'],
      );
    };
    const advisoryHeld = async (c: Client): Promise<number> => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`);
      return r.rows[0]?.n ?? 0;
    };
    const tryDefer = async (c: Client): Promise<string> => {
      await c.query('SAVEPOINT defer_attempt');
      const outcome = await c.query('SET CONSTRAINTS p5scratch.pca_chronology_trg DEFERRED').then(
        () => 'granted',
        (e: unknown) => (typeof e === 'object' && e !== null && 'code' in e ? `refused:${String(e.code)}` : 'refused'),
      );
      if (outcome !== 'granted') await c.query('ROLLBACK TO SAVEPOINT defer_attempt');
      return outcome;
    };

    const a = await connect(appUrl());
    const b = await connect(appUrl());
    try {
      for (const c of [a, b] as const) {
        await c.query('BEGIN');
        await setRequestContext(c, s, 'transaction');
        // Both sessions ATTEMPT the attack and carry on either way: refused
        // on the fixed schema (`42809`), granted on a weakened one. The
        // assertions are then about what the schema does, not about what the
        // caller was allowed to ask for.
        await tryDefer(c);
      }
      await claim(a, invA);
      await claim(b, invB);

      // THE INTERLEAVING IS THE CASE. A takes g1 and stops; B then takes g2
      // and reaches for g1; A reaches for g2. With no key held that is a
      // cycle and PostgreSQL kills one side with `40P01` — which is exactly
      // what I measured by hand before the fix. With the key held by the
      // writer itself, B cannot even start while A is open, so no cycle can
      // form. My first version of this case let A finish both grants before
      // B began, which is the non-race the challenger rejected one round ago;
      // this one holds A between its two grants.
      await insertConsumption(a, 'p5scratch', s, g1, 100n, invA, 'inv-order-a1', T2);
      const advA = await advisoryHeld(a);

      const bPid = await pidOf(b);
      let bSettled: string | null = null;
      const bRun = (async () => {
        await insertConsumption(b, 'p5scratch', s, g2, 100n, invB, 'inv-order-b1', T2);
        await insertConsumption(b, 'p5scratch', s, g1, 100n, invB, 'inv-order-b2', T2);
      })().then(
        () => {
          bSettled = '';
        },
        (e: unknown) => {
          bSettled = refusedBy(e) || String(e);
          throw e;
        },
      );
      bRun.catch(() => undefined);
      try {
        await waitUntilBlocked(observer, bPid, 'the inverted-order writer, as the application role');
      } catch (barrier) {
        throw new Error(bSettled === null ? `${String(barrier)}; and B had not settled either` : `B did not block, it settled first with: ${bSettled}`);
      }

      // A's second grant, while B is parked. On a weakened schema B holds g2
      // and wants g1, so this is the half of the cycle that closes it.
      const aSecond = await insertConsumption(a, 'p5scratch', s, g2, 100n, invA, 'inv-order-a2', T2).then(
        () => '',
        (e: unknown) => refusedBy(e) || String(e),
      );
      expect(aSecond, 'the first writer was refused or deadlocked while taking its second grant').toBe('');
      await a.query('COMMIT');

      const bOutcome = await bRun.then(
        () => '',
        (e: unknown) => refusedBy(e) || String(e),
      );
      expect(bOutcome, 'the inverted-order writer deadlocked or was refused').toBe('');
      expect({ advA, advB: await advisoryHeld(b) }, 'a writer ran without the per-business advisory key').toStrictEqual({
        advA: 1,
        advB: 1,
      });
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(400n);
  });

  it('reads both properties out of the live catalogue, not out of the file', async () => {
    // The DDL text is not the live definition, and the alphabet is not a
    // guarantee: this law is what stops the key drifting back out of the
    // writer, or either trigger becoming deferrable again.
    const triggers = await owner.query<{ tgname: string; deferrable: boolean }>(
      `SELECT tgname, tgdeferrable AS deferrable
         FROM pg_trigger
        WHERE tgrelid = 'p5scratch.platform_credit_adjustments'::regclass
          AND NOT tgisinternal AND tgname IN ('pca_chronology_trg', 'pca_maintain_remainder_trg')
        ORDER BY tgname`,
    );
    expect(triggers.rows, 'a defence trigger is deferrable, so the caller can switch it off').toStrictEqual([
      { tgname: 'pca_chronology_trg', deferrable: false },
      { tgname: 'pca_maintain_remainder_trg', deferrable: false },
    ]);

    const writer = await owner.query<{ takes_key: boolean }>(
      `SELECT prosrc LIKE '%pg_advisory_xact_lock%' AS takes_key
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'p5scratch' AND p.proname = 'pca_maintain_remainder'`,
    );
    expect(writer.rows, 'the remainder writer no longer takes the advisory key itself, so it depends on a sibling trigger again').toStrictEqual([
      { takes_key: true },
    ]);
  });
});
