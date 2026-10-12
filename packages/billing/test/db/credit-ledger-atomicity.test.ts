/**
 * ROUND 5 — Master Continuous Mission V2 §12.
 *
 * V2 adds exactly two engineering asks to Phase 5, and this file is both:
 *
 *   «رتّب grant locks حتميًا؛ reverse-order deadlock المسجل يحتاج
 *    التحقق من النسخة المصححة»
 *     Order the grant locks deterministically, and verify the CORRECTED
 *     version of the recorded reverse-order deadlock. Round 4 proved that
 *     deadlock is real — case 12 of the concurrency file — and stopped
 *     there. Proving a hazard and fixing it are different deliverables,
 *     and round 4 only did the first.
 *
 *   «لا يثبت هذا ربط إقفال subscription_invoices الحقيقي بالمنح
 *    والاستهلاك في المعاملة نفسها»
 *     Nothing yet ties the invoice finalization to the grant and the
 *     consumption in the same transaction.
 *
 * On the second, V2 is explicit that the proof it wants is "at
 * integration, on the official schema and command", which does not exist
 * and is not this thread's to build. What IS this thread's: the design in
 * §11c of the migration patch request, realized and attacked, in the same
 * deliberately weaker class as everything else in `test/db/` —
 * `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`. The
 * integrated claim stays `WAITING_FOR_INTEGRATED_SURFACE` and is not made
 * anywhere.
 *
 * Adding the tie changed round 4's own suite, which is the clearest
 * evidence that the gap V2 named was real: the FK from a consumption to
 * its invoice made EIGHT of round 4's twenty cases fail at once, because
 * round 4's helper wrote consumption rows naming an invoice that did not
 * exist and nothing noticed. They were right to fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { appUrl, connect, isBlocked, ownerUrl, pidOf, sqlstate, uuid, waitUntilBlocked } from './helpers/cluster';
import {
  consumedMinor,
  createDraftInvoice,
  finalizeInvoice,
  insertConsumption,
  insertGrant,
  remainderOf,
  type Scope,
} from './helpers/finalize';

const TENANT = '7f1a0000-0000-4000-8000-000000000002';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

let owner: Client;
let observer: Client;

async function freshScope(currency = 'USD'): Promise<Scope> {
  const businessId = uuid();
  await owner.query(`INSERT INTO p5scratch.businesses (tenant_id, id) VALUES ($1, $2)`, [TENANT, businessId]);
  return { tenantId: TENANT, businessId, currency };
}

async function invoiceRow(c: Client, id: string): Promise<{ state: string; credit: bigint; payable: bigint } | null> {
  const r = await c.query<{ state: string; credit_minor: string; total_minor: string }>(
    `SELECT state, credit_minor::text, total_minor::text FROM p5scratch.subscription_invoices WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  return row === undefined
    ? null
    : { state: row.state, credit: BigInt(row.credit_minor), payable: BigInt(row.total_minor) };
}

beforeAll(async () => {
  owner = await connect(ownerUrl());
  observer = await connect(ownerUrl());
});

afterAll(async () => {
  await owner.end();
  await observer.end();
});

describe('the deterministic grant lock order', () => {
  it('locks the remainder rows in the ledger order, and the PLAN of the FUNCTION\'s own body says so', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 100n, T0, 'grant-older');
    await insertGrant(owner, 'p5scratch', s, 100n, T1, 'grant-newer');

    // The locking order only holds if LockRows sits ABOVE the sort. A plan
    // that locked rows as the scan found them and sorted afterwards would
    // return the same rows in the same order while taking the locks in
    // whatever order the index walk produced — which is the
    // non-determinism this function exists to remove.
    //
    // The query explained below is EXTRACTED FROM `pg_proc`, not copied
    // here by hand. The first version of this case explained a hand-copied
    // query, and the mutation that removed the ORDER BY from the function
    // left it GREEN: the case was asserting a property of its own fixture
    // and reporting it as a property of the function. That is the same
    // defect shape this project has hit repeatedly — a law that names its
    // premise and does not read it — and it is why this reads the
    // definition instead.
    const src = await owner.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'lock_grants_in_order'`,
    );
    const body = src.rows[0]?.prosrc;
    expect(typeof body).toBe('string');
    const withAt = (body ?? '').indexOf('WITH ordered AS');
    expect(withAt).toBeGreaterThanOrEqual(0);
    const extracted = (body ?? '')
      .slice(withAt)
      .replace(/;[\s\S]*$/, '')
      .replace(/p_tenant/g, '$1')
      .replace(/p_business/g, '$2')
      .replace(/p_currency/g, '$3')
      .replace(/::integer INTO locked/, '::integer');
    // Non-vacuity: the extraction must still be the locking query.
    expect(extracted).toMatch(/FOR UPDATE OF r/);

    await owner.query('BEGIN');
    const plan = await owner.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${extracted}`, [
      s.tenantId,
      s.businessId,
      s.currency,
    ]);
    await owner.query('ROLLBACK');

    const lines = plan.rows.map((r) => r['QUERY PLAN']);
    const lockRows = lines.findIndex((l) => l.includes('LockRows'));
    const sort = lines.findIndex((l) => l.includes('Sort'));
    expect(lockRows).toBeGreaterThanOrEqual(0);
    expect(sort).toBeGreaterThanOrEqual(0);
    // EXPLAIN prints parents before children, so a smaller index is higher
    // in the tree.
    expect(lockRows).toBeLessThan(sort);
  });

  it('CORRECTS the reverse-order deadlock: with the grant locks taken up front, the opposite write order cannot deadlock', async () => {
    const s = await freshScope();
    const older = await insertGrant(owner, 'p5scratch', s, 1000n, T0, 'grant-older');
    const newer = await insertGrant(owner, 'p5scratch', s, 1000n, T1, 'grant-newer');
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 200n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 200n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);

      // Both writers take EVERY remainder row for this business and
      // currency, up front, in `(created_at, id)` order.
      await a.query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [s.tenantId, s.businessId, s.currency]);
      const bLock = b
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [s.tenantId, s.businessId, s.currency])
        .then(() => '', (e: unknown) => sqlstate(e));

      // B cannot get past the first row A holds, so it never holds one row
      // while reaching for another — which is the cycle round 4 produced.
      await waitUntilBlocked(observer, bPid, 'B on the ordered grant locks');

      // A now writes in the order the ruling pins. B will write in the
      // OPPOSITE order — the exact thing that deadlocked in round 4.
      await insertConsumption(a, 'p5scratch', s, older, 100n, invA, 'inv-A', T2);
      await insertConsumption(a, 'p5scratch', s, newer, 100n, invA, 'inv-A', T2);
      await a.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=200, total_minor=0 WHERE id=$1`,
        [invA, T2],
      );
      await a.query('COMMIT');

      expect(await bLock).toBe('');
      await insertConsumption(b, 'p5scratch', s, newer, 100n, invB, 'inv-B', T2);
      await insertConsumption(b, 'p5scratch', s, older, 100n, invB, 'inv-B', T2);
      await b.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=200, total_minor=0 WHERE id=$1`,
        [invB, T2],
      );
      const bCommit = await b.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e));

      // The whole claim: no 40P01 anywhere, and both invoices are paid out
      // of credit correctly despite one of them writing backwards.
      expect(bCommit).toBe('');
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(400n);
    expect(await remainderOf(owner, older)).toBe(800n);
    expect(await remainderOf(owner, newer)).toBe(800n);
  });

  it('and the per-business advisory lock closes the same deadlock on its own, which is why it is the FIRST line', async () => {
    const s = await freshScope();
    const older = await insertGrant(owner, 'p5scratch', s, 1000n, T0, 'grant-older');
    const newer = await insertGrant(owner, 'p5scratch', s, 1000n, T1, 'grant-newer');
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 200n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 200n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);
      await a.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`p5scratch:${s.businessId}`]);
      const bLock = b
        .query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`p5scratch:${s.businessId}`])
        .then(() => '', (e: unknown) => sqlstate(e));
      await waitUntilBlocked(observer, bPid, 'B on the business advisory lock');

      await insertConsumption(a, 'p5scratch', s, older, 100n, invA, 'inv-A', T2);
      await insertConsumption(a, 'p5scratch', s, newer, 100n, invA, 'inv-A', T2);
      await a.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=200, total_minor=0 WHERE id=$1`,
        [invA, T2],
      );
      await a.query('COMMIT');
      expect(await bLock).toBe('');

      // Reverse order again, and again no cycle: B could not start until A
      // had finished, so there was never a moment when both held a row.
      await insertConsumption(b, 'p5scratch', s, newer, 100n, invB, 'inv-B', T2);
      await insertConsumption(b, 'p5scratch', s, older, 100n, invB, 'inv-B', T2);
      await b.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=200, total_minor=0 WHERE id=$1`,
        [invB, T2],
      );
      expect(await b.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('');
    } finally {
      await a.end();
      await b.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(400n);
  });

  it('the ordered locks are per business and currency, so they do not serialise the platform', async () => {
    const one = await freshScope();
    const two = await freshScope();
    await insertGrant(owner, 'p5scratch', one, 100n, T0);
    await insertGrant(owner, 'p5scratch', two, 100n, T0);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [one.tenantId, one.businessId, 'USD']);
      const bPid = await pidOf(b);
      await b.query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [two.tenantId, two.businessId, 'USD']);
      expect(await isBlocked(observer, bPid)).toBe(false);
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('the invoice and the ledger commit together, or not at all', () => {
  it('a second connection sees NEITHER the finalized invoice nor the consumption rows until commit, then sees both', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await finalizeInvoice(a, 'p5scratch', s, invoiceId, 500n, 'inv-A', T1, { withLock: true, withGrantLocks: true });

      // Inside the transaction, A sees its own work.
      expect((await invoiceRow(a, invoiceId))?.state).toBe('open');

      // Outside it, nothing of either half is visible. This is the
      // atomicity claim, OBSERVED from another backend rather than
      // inferred from the fact that both statements were sent.
      expect(await invoiceRow(observer, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 500n });
      expect(await consumedMinor(observer, 'p5scratch', s)).toBe(0n);

      await a.query('COMMIT');
    } finally {
      await a.end();
    }

    expect(await invoiceRow(observer, invoiceId)).toEqual({ state: 'open', credit: 500n, payable: 0n });
    expect(await consumedMinor(observer, 'p5scratch', s)).toBe(500n);
  });

  it('an invoice claiming credit with no consumption rows is refused AT COMMIT, not at the statement', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      // The UPDATE itself SUCCEEDS. That is what DEFERRED means, and it is
      // why the constraint is a statement about the transaction: the
      // command may write the invoice first and the rows second.
      const upd = await a
        .query(
          `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                  credit_minor=500, total_minor=0 WHERE id=$1`,
          [invoiceId, T1],
        )
        .then(() => '', (e: unknown) => sqlstate(e));
      expect(upd).toBe('');

      const commit = await a.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e));
      expect(commit).toBe('23000');
    } finally {
      await a.end();
    }

    // Nothing survived: no credit claimed, no rows.
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 500n });
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
  });

  it('PARTIAL consumption cannot commit: an invoice claiming 500 with 300 of rows is refused', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await insertConsumption(a, 'p5scratch', s, grant, 300n, invoiceId, 'inv-A', T1);
      await a.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=500, total_minor=0 WHERE id=$1`,
        [invoiceId, T1],
      );
      expect(await a.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('23000');
    } finally {
      await a.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
    expect(await remainderOf(owner, grant)).toBe(500n);
  });

  it('consumption rows with no invoice at all cannot commit either', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 500n, T0);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      // A plausible invoice identity that was never written. The FK is
      // DEFERRABLE, so the INSERT succeeds and the COMMIT does not.
      await insertConsumption(a, 'p5scratch', s, grant, 300n, uuid(), 'inv-ghost', T1);
      expect(await a.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('23503');
    } finally {
      await a.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
  });

  it('the two halves may be written in EITHER order inside the transaction', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 400n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      // Rows FIRST, invoice second — the opposite of what `finalizeInvoice`
      // does. If the constraint were per-statement rather than deferred,
      // one of these two orders would fail, and a command would be forced
      // into a write order the database had no business dictating.
      await insertConsumption(a, 'p5scratch', s, grant, 400n, invoiceId, 'inv-A', T1);
      await a.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2,
                credit_minor=400, total_minor=0 WHERE id=$1`,
        [invoiceId, T1],
      );
      expect(await a.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('');
    } finally {
      await a.end();
    }
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(400n);
    expect(await remainderOf(owner, grant)).toBe(100n);
  });

  it('a finalization that is NOT wrapped in a transaction cannot complete at all', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);

    const a = await connect(ownerUrl());
    try {
      // No BEGIN: every statement is its own transaction, so the deferred
      // constraints fire at the end of EACH one. The invoice UPDATE
      // commits alone, finds no consumption rows, and is refused.
      //
      // This case was not written on purpose — it is how the suite behaved
      // the first time the tie was added, and it is kept because it is the
      // cheapest possible proof that "in the same transaction" is enforced
      // rather than merely intended.
      const code = await finalizeInvoice(a, 'p5scratch', s, invoiceId, 500n, 'inv-A', T1, {
        withLock: false,
      }).then(() => '', (e: unknown) => sqlstate(e));
      expect(code).toBe('23000');
    } finally {
      await a.end();
    }
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 500n });
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
  });

  it('a rolled-back finalization leaves the invoice a draft and the remainder whole', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 500n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 500n);

    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await finalizeInvoice(a, 'p5scratch', s, invoiceId, 500n, 'inv-A', T1, { withLock: true, withGrantLocks: true });
      await a.query('ROLLBACK');
    } finally {
      await a.end();
    }
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 500n });
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
    expect(await remainderOf(owner, grant)).toBe(500n);
  });

  it('the payable arithmetic belongs to the database, not to the command', async () => {
    const s = await freshScope();
    const bad = await owner
      .query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,300,800,'draft')`,
        [uuid(), s.tenantId, s.businessId],
      )
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(bad).toBe('23514');

    const negative = await owner
      .query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,1500,-500,'draft')`,
        [uuid(), s.tenantId, s.businessId],
      )
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(negative).toBe('23514');
  });

  it('a draft invoice may not claim applied credit', async () => {
    const s = await freshScope();
    const a = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await a.query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,400,600,'draft')`,
        [uuid(), s.tenantId, s.businessId],
      );
      expect(await a.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('23000');
    } finally {
      await a.end();
    }
  });

  it('two concurrent finalizations of DIFFERENT invoices, with the whole stack, each agree with their own rows', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 300n, T0, 'grant-older');
    await insertGrant(owner, 'p5scratch', s, 300n, T1, 'grant-newer');
    const invA = await createDraftInvoice(owner, 'p5scratch', s, 400n);
    const invB = await createDraftInvoice(owner, 'p5scratch', s, 400n);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);
      const planA = await finalizeInvoice(a, 'p5scratch', s, invA, 400n, 'inv-A', T2, {
        withLock: true,
        withGrantLocks: true,
      });
      const bRun = finalizeInvoice(b, 'p5scratch', s, invB, 400n, 'inv-B', T2, {
        withLock: true,
        withGrantLocks: true,
      });
      await waitUntilBlocked(observer, bPid, 'B on the full finalization stack');
      await a.query('COMMIT');

      const planB = await bRun;
      await b.query('COMMIT');

      // A drew the whole 600; B found 200 left and applied exactly that.
      expect(planA.application.appliedMinor).toBe(400n);
      expect(planB.application.appliedMinor).toBe(200n);
      expect(planB.application.payableMinor).toBe(200n);
    } finally {
      await a.end();
      await b.end();
    }

    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(600n);
    expect(await invoiceRow(owner, invA)).toEqual({ state: 'open', credit: 400n, payable: 0n });
    expect(await invoiceRow(owner, invB)).toEqual({ state: 'open', credit: 200n, payable: 200n });
  });

  it('the application role can neither read nor finalize another business invoice', async () => {
    const mine = await freshScope();
    const theirs = await freshScope();
    const theirInvoice = await createDraftInvoice(owner, 'p5scratch', theirs, 100n);
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [mine.businessId]);
      const seen = await app.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM p5scratch.subscription_invoices WHERE id = $1`,
        [theirInvoice],
      );
      expect(seen.rows[0]?.n).toBe('0');

      // The role HOLDS the UPDATE privilege, so this is RLS refusing and
      // not a missing grant: the statement succeeds and touches no row.
      const upd = await app.query(
        `UPDATE p5scratch.subscription_invoices SET state='open', issued_at=$2 WHERE id = $1`,
        [theirInvoice, T2],
      );
      expect(upd.rowCount).toBe(0);
      expect((await invoiceRow(owner, theirInvoice))?.state).toBe('draft');
    } finally {
      await app.end();
    }
  });

  it('and CAN finalize its own, so the UPDATE policy is not simply a deny', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 200n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 200n);
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      await finalizeInvoice(app, 'p5scratch', s, invoiceId, 200n, 'inv-own', T1, {
        withLock: true,
        withGrantLocks: true,
      });
      expect(await app.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e))).toBe('');
    } finally {
      await app.end();
    }
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'open', credit: 200n, payable: 0n });
    expect(await remainderOf(owner, grant)).toBe(0n);
  });
});

describe('the agreement invariant cannot be hidden from, round 8', () => {
  /**
   * The independent challenger's F-01, a P1, as this suite's own regression.
   *
   * `assert_invoice_credit_agrees` used to run with the CALLER's rights, so
   * both of its reads were filtered by the row-level security policy keyed to
   * `current_setting('app.business_id', true)`. The triggers that call it are
   * DEFERRABLE INITIALLY DEFERRED, so they run at COMMIT — by which time a
   * pooled worker processing tenants in a loop may have legitimately moved
   * that setting on. With the invoice invisible, the function read NULL,
   * concluded "the invoice is gone" and returned, and a transaction claiming
   * 500 of platform credit against 300 of consumption rows COMMITTED. The
   * ledger is append-only, so that state can never be repaired.
   *
   * Why no case caught it: every writer in this file connects as the schema
   * owner, and the owner was the cluster's bootstrap superuser, which always
   * sees every row. The principal is what concealed the defect, so this pair
   * is written as the application role — `NOSUPERUSER NOBYPASSRLS` — and the
   * two halves differ by one `set_config` and nothing else.
   */
  const OTHER_BUSINESS = '7f1c0d9e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';

  async function underfundedFinalization(c: Client, s: Scope, invoiceId: string, grant: string, moveContextTo?: string): Promise<string> {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
    // 300 of consumption rows against an invoice that will claim 500.
    await insertConsumption(c, 'p5scratch', s, grant, 300n, invoiceId, 'inv-underfunded', T1);
    await c.query(
      `UPDATE p5scratch.subscription_invoices
          SET state = 'open', credit_minor = 500, total_minor = charge_minor - 500, issued_at = $2
        WHERE id = $1`,
      [invoiceId, T1],
    );
    if (moveContextTo !== undefined) {
      // The attack, and the whole of it: the session's business context moves
      // on before COMMIT. No privilege is needed that the role does not hold.
      await c.query(`SELECT set_config('app.business_id', $1, false)`, [moveContextTo]);
    }
    const code = await c.query('COMMIT').then(() => '', (e: unknown) => sqlstate(e));
    await c.query('ROLLBACK').catch(() => undefined);
    return code;
  }

  it('refuses an invoice that claims more credit than its consumption rows hold', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const app = await connect(appUrl());
    try {
      // The CONTROL. 23000 is the agreement trigger's own refusal.
      expect(await underfundedFinalization(app, s, invoiceId, grant)).toBe('23000');
    } finally {
      await app.end();
    }
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 1000n });
  });

  it('refuses it just the same when the session has moved to another business before COMMIT', async () => {
    const s = await freshScope();
    const grant = await insertGrant(owner, 'p5scratch', s, 1000n, T0);
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const app = await connect(appUrl());
    try {
      // The ATTACK. Before round 8 this COMMITTED and left the invoice
      // claiming 500 against 300.
      const code = await underfundedFinalization(app, s, invoiceId, grant, OTHER_BUSINESS);
      expect(code, 'an invoice claiming unbacked platform credit was committed').toBe('23000');
    } finally {
      await app.end();
    }
    // Read back as the owner, which the attack's RLS context cannot affect:
    // the invoice is untouched and no consumption row survived.
    expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 1000n });
    expect(await consumedMinor(owner, 'p5scratch', s)).toBe(0n);
  });

  it('the application role can create a draft invoice, not only finalize one', async () => {
    // The challenger's F-08. `createDraftInvoice` takes its period index from
    // a sequence the grant set never gave the role USAGE on, so the invoice
    // CREATION path had never been executed as the application role at all —
    // and §7's grant set, promoted as written, would have failed in
    // production at the first draft invoice with `42501`.
    const s = await freshScope();
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      const invoiceId = await createDraftInvoice(app, 'p5scratch', s, 400n);
      expect(await invoiceRow(owner, invoiceId)).toEqual({ state: 'draft', credit: 0n, payable: 400n });
    } finally {
      await app.end();
    }
  });
});
