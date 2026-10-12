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
import { appUrl, connect, isBlocked, ownerUrl, pidOf, sqlstate, uuid, waitUntilBlocked } from './helpers/cluster';
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
        (e: unknown) => ({ ok: false as const, code: sqlstate(e) }),
      );
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.code).toBe('23514');
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
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(attempt).toBe('23514');
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
      (e: unknown) => sqlstate(e),
    );
    await owner.query('ROLLBACK');
    // 23505 is `unique_violation`: the partial unique index on
    // (business, invoice, grant) for consumptions. Idempotency belongs to
    // the schema because a retry is exactly the case where the
    // application's own bookkeeping is the thing that failed.
    expect(second).toBe('23505');
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
        (e: unknown) => sqlstate(e),
      );
      await waitUntilBlocked(observer, bPid, 'duplicate invoice finalization');
      await a.query('COMMIT');
      expect(await bRun).toBe('23505');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(200n);
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
        (e: unknown) => sqlstate(e),
      );
      await waitUntilBlocked(observer, bPid, 'second finalization on the older grant');
      await a.query('COMMIT');
      // B is refused by the CHECK (there is only 200 of credit for 300 of
      // invoice) — but 40P01, a deadlock, is what must NOT happen.
      const code = await bRun;
      expect(code).not.toBe('40P01');
      expect(code).toBe('23514');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('an allocator that wrote the same rows in the OPPOSITE order deadlocks — which is why the order is pinned', async () => {
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
      await insertConsumption(b, 'p5scratch', s, newer, 100n, invB, 'inv-B', T2);

      // Each now reaches for the row the other holds. The first reach
      // blocks (observed, not assumed); the second closes the cycle.
      const aSecond = a
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
              applies_to_grant_id, invoice_id)
           VALUES ($1,$2,$3,'consumption',100,'USD',$4,'inv-A','row-by-row allocation',$5,$6)`,
          [uuid(), s.tenantId, s.businessId, T2, newer, invA],
        )
        .then(() => '', (e: unknown) => sqlstate(e));
      await waitUntilBlocked(observer, aPid, 'A reaching for the newer grant B holds');

      const bSecond = b
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
              applies_to_grant_id, invoice_id)
           VALUES ($1,$2,$3,'consumption',100,'USD',$4,'inv-B','row-by-row allocation',$5,$6)`,
          [uuid(), s.tenantId, s.businessId, T2, older, invB],
        )
        .then(() => '', (e: unknown) => sqlstate(e));

      // 40P01 is `deadlock_detected`. One of the two transactions is killed
      // by PostgreSQL, which means a merchant invoice fails for no reason
      // other than the order its rows were written in. This is the
      // mechanical consequence of a non-deterministic allocation order, and
      // the reason PART 25's "ordered deterministically" is a correctness
      // requirement and not a tidiness preference.
      const codes = await Promise.all([aSecond, bSecond]);
      expect(codes).toContain('40P01');
      expect(bPid).toBeGreaterThan(0);
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

describe('the ordering conflict, resolved at the write', () => {
  it('a row whose occurred_at would make the ledger non-monotonic in allocation order is refused', async () => {
    const s = await freshScope('p5scratch');
    await insertGrant(owner, 'p5scratch', s, 100n, T1);
    const backdated = await insertGrant(owner, 'p5scratch', s, 100n, T0, 'backdated-grant').then(
      () => '',
      (e: unknown) => sqlstate(e),
    );
    expect(backdated).toBe('23000');
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
        .then(() => '', (e: unknown) => sqlstate(e));
      const del = await app
        .query(`DELETE FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`, [s.businessId])
        .then(() => '', (e: unknown) => sqlstate(e));
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
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(upd).toBe('23000');
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
        .then(() => '', (e: unknown) => sqlstate(e));
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
        .then(() => '', (e: unknown) => sqlstate(e));
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
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(cross).toBe('23503');

    const myGrant = await insertGrant(owner, 'p5scratch', mine, 100n, T0);
    const otherCurrency = await owner
      .query(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
            applies_to_grant_id, invoice_id)
         VALUES ($1,$2,$3,'consumption',50,'EUR',$4,'inv','draws a USD grant in EUR',$5,$6)`,
        [uuid(), mine.tenantId, mine.businessId, T1, myGrant, uuid()],
      )
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(otherCurrency).toBe('23503');
  });
});
