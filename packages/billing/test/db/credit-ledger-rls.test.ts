/**
 * ROUND 12 — the isolation pattern, copied from the house and proved as the
 * house states it.
 *
 * The independent challenger's F-13 (P2) read `0006_rls.sql` and found three
 * divergences in this lane's RLS, all of them making it incomparable with
 * the deployed schema rather than merely different:
 *
 *   1. the frozen pattern for a business-scoped table is TWO policies — a
 *      PERMISSIVE tenant-membership policy and a RESTRICTIVE business-scoping
 *      policy, which together are default-deny ("without app.business_id set,
 *      the app role sees ZERO rows", in the migration's own comment). This
 *      schema had the permissive half alone, so its isolation was one layer
 *      where the house has two;
 *   2. every frozen policy honours `app_bypass()`; these had no equivalent,
 *      neither honoured nor consciously refused;
 *   3. the frozen discipline sets context per TRANSACTION with
 *      `set_config(..., true)`, so a pooled connection cannot carry a stale
 *      context; this lane set it per session at ten sites.
 *
 * All three are adopted. This file is the proof, and it is a NEW file rather
 * than cases bolted onto the others because what it proves is the pattern
 * itself, not any single invariant.
 *
 * ONE OF THE THREE PREMISES IS CORRECTED HERE, and the correction is owed
 * back to the challenger and to every phase reading `0006_rls.sql` as the
 * live pattern. 0006 defines `app_bypass()` over the GUC `app.bypass_rls`;
 * that text is FIVE redefinitions stale — 0010 (the GUC and a role
 * exclusion), 0013 (a pure role test, `current_user = 'daftar_platform'`),
 * 0030 (widened to the provisioner), 0032 (narrowed back) and 0052 (the
 * same predicate hardened with `OPERATOR(pg_catalog.=)` and a
 * schema-qualified `name` cast). This file first said THREE; the
 * independent challenger counted the chain and the count is its own claim,
 * so it was re-grepped here before being adopted. The live
 * bodies were read out of `pg_proc` on a cluster carrying the real history,
 * and the policies here are the live SHAPE read out of `pg_policies` on
 * `journal_lines`, not the migration's prose: a permissive tenant clause
 * comparing `tenant_id` to `NULLIF(app_tenant(), '')::uuid` directly, and a
 * restrictive business clause that admits the internal principal BY NAME. A
 * bypass a session can set for itself is not a bypass, and a lane that
 * copies 0006's text gets one.
 *
 * One consequence worth naming: under the house pattern a session that sets
 * only `app.business_id` satisfies the restrictive half and FAILS the
 * permissive one, so it can do nothing at all. The lane's own cases were
 * doing exactly that until this round. The context is now set as a pair.
 *
 * WHICH CONNECTION CARRIES AN ISOLATION CLAIM, and it is not the owner's.
 * The challenger's round-11 observation, adopted: in the real-schema lane
 * the schema owner IS `daftar_platform`, for whom `app_bypass()` is TRUE, so
 * every policy's first disjunct is satisfied and ANY isolation claim made on
 * that connection is vacuous by construction.
 *
 * ROUND 17, THE OPEN HALF OF THE COORDINATOR'S R-8: this paragraph scoped
 * the vacuity to "the real-schema lane", and it is true of BOTH lanes. The
 * fixture lane's `app_bypass()` names `p5owner`, which is that lane's owner
 * connection, so the first disjunct is satisfied there too. The two lanes
 * differ in WHICH role the bypass names, not in whether the owner has it.
 * `P5-CHECKPOINT.md` was corrected to "both lanes" at round 14 and this file
 * was not, which is exactly the drift that made N-5 a finding. The cases that carry weight
 * are the `p5_app` ones — exactly the six that go red when the three
 * `*_business_isolation` policies are dropped. The owner connection is used
 * here for catalogue reads, for fixtures, and for ONE case that asserts the
 * bypass itself; it is never the subject of a default-deny claim. It also
 * narrows what gap 1's separate verification principal would be FOR.
 *
 * Class: `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`.
 * The policies are copies of the frozen pattern; nothing here is a claim
 * about the frozen tables themselves, and nothing here transfers to a role
 * that holds `BYPASSRLS` — which the deploy role does (`TL-P4-COORD-R58`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { appUrl, bootstrapUrl, borrowedSchema, connect, connectWithoutContext, ownerUrl, refusedBy, setRequestContext, strangerUrl, uuid } from './helpers/cluster';
import { createBusiness, createDraftInvoice, insertGrant, type Scope } from './helpers/finalize';

const TENANT = '7f1a0000-0000-4000-8000-000000000007';
const OTHER_TENANT = '7f1a0000-0000-4000-8000-00000000000a';
const T1 = '2026-02-01T00:00:00.000Z';

const SCOPED_TABLES = [
  'platform_credit_adjustments',
  'subscription_invoices',
  'subscription_charge_attempts',
] as const;

let owner: Client;

async function freshScope(tenantId = TENANT): Promise<Scope> {
  const businessId = uuid();
  await createBusiness(owner, borrowedSchema(), tenantId, businessId, 'USD');
  return { tenantId, businessId, currency: 'USD' };
}

beforeAll(async () => {
  owner = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
});

describe('the policies are the house pattern, read from the catalogue', () => {
  it('gives every business-scoped relation one permissive and one restrictive policy', async () => {
    const r = await owner.query<{ tablename: string; policyname: string; permissive: string; cmd: string }>(
      `SELECT tablename, policyname, permissive, cmd
         FROM pg_policies
        WHERE schemaname = 'p5scratch' AND tablename = ANY($1)
        ORDER BY tablename, policyname`,
      [[...SCOPED_TABLES]],
    );
    for (const table of SCOPED_TABLES) {
      const mine = r.rows.filter((row) => row.tablename === table);
      const restrictive = mine.filter((row) => row.permissive === 'RESTRICTIVE');
      const permissive = mine.filter((row) => row.permissive === 'PERMISSIVE');
      expect(restrictive.map((row) => row.policyname), `${table} has no RESTRICTIVE policy, so it is not default-deny`).toStrictEqual([
        `${table.startsWith('platform_credit') ? 'pca' : table.startsWith('subscription_invoices') ? 'si' : 'sca'}_business_isolation`,
      ]);
      expect(permissive.length, `${table} has no PERMISSIVE policy, so a RESTRICTIVE one would deny everything`).toBeGreaterThanOrEqual(1);
      expect(restrictive[0]?.cmd, `${table}'s restrictive policy must cover every command`).toBe('ALL');
    }
  });

  it('reads the request context through the three house functions, and honours the bypass', async () => {
    const r = await owner.query<{ policyname: string; qual: string; withcheck: string | null }>(
      `SELECT policyname, qual, with_check AS withcheck
         FROM pg_policies
        WHERE schemaname = 'p5scratch' AND tablename = ANY($1)
          AND policyname LIKE '%_tenant_membership' OR policyname LIKE '%_business_isolation'
        ORDER BY policyname`,
      [[...SCOPED_TABLES]],
    );
    expect(r.rows.length, 'the house policies were not found at all').toBe(6);
    for (const row of r.rows) {
      expect(row.qual, `${row.policyname} does not honour app_bypass()`).toContain('app_bypass()');
      expect(row.withcheck, `${row.policyname} has no WITH CHECK side`).toBeTruthy();
      const reads = row.policyname.endsWith('_tenant_membership') ? 'app_tenant()' : 'app_business()';
      expect(row.qual, `${row.policyname} does not read ${reads}`).toContain(reads);
      // And NOT the raw setting: a policy that reads current_setting
      // directly cannot be compared with the frozen ones, which is how the
      // divergence hid.
      expect(row.qual, `${row.policyname} still reads current_setting directly`).not.toContain('current_setting');
    }
  });

  // ROUND 17, R-8's other half: the name used to end "so the owner is
  // subject to policy too", which overstates what the case reads. FORCE RLS
  // is a CATALOGUE fact here (`relforcerowsecurity`), and in both lanes the
  // owner is the bypass principal, so no case in this file demonstrates the
  // owner being refused anything. What FORCE RLS buys is that the owner is
  // subject to POLICY rather than exempt from RLS — and the policy it is
  // subject to admits it. The name now says what is read.
  it('keeps FORCE ROW LEVEL SECURITY on for every requested relation, read from the catalogue', async () => {
    const r = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'p5scratch' AND c.relname = ANY($1)`,
      [[...SCOPED_TABLES]],
    );
    expect(r.rows.length).toBe(SCOPED_TABLES.length);
    expect(r.rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity).map((row) => row.relname)).toStrictEqual([]);
  });
});

describe('default-deny: no context, no rows', () => {
  it('shows the application role zero rows when nothing is set', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 1000n, T1);
    await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const blind = await connectWithoutContext(appUrl());
    try {
      for (const table of ['platform_credit_adjustments', 'subscription_invoices'] as const) {
        const r = await blind.query<{ n: number }>(`SELECT count(*)::int AS n FROM p5scratch.${table}`);
        expect(r.rows[0]?.n, `${table} leaked rows to a session with no context`).toBe(0);
      }
    } finally {
      await blind.end();
    }
  });

  it('refuses a write from a session with no context', async () => {
    const s = await freshScope();
    const blind = await connectWithoutContext(appUrl());
    try {
      const code = await blind
        .query(
          `INSERT INTO p5scratch.platform_credit_adjustments
             (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
           VALUES ($1,$2,$3,'grant',100,'USD',$4,'rls','a write with no context')`,
          [uuid(), s.tenantId, s.businessId, T1],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(code, 'a session with no request context wrote a row').toBe('42501');
    } finally {
      await blind.end();
    }
  });

  it('refuses a session that sets the business but not the tenant — the pattern is a PAIR', async () => {
    const s = await freshScope();
    const half = await connectWithoutContext(appUrl());
    try {
      // The restrictive half is satisfied and the permissive half is not,
      // so there is no grant for the write at all. This is exactly what
      // every case in this lane was doing before round 12.
      await half.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      const code = await half
        .query(
          `INSERT INTO p5scratch.subscription_invoices
             (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
           VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',100,0,100,'draft')`,
          [uuid(), s.tenantId, s.businessId],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(code, 'half a context was enough to write').toBe('42501');
    } finally {
      await half.end();
    }
  });

  it("refuses a session whose tenant does not own the business it names", async () => {
    const s = await freshScope();
    const outsider = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(outsider, { tenantId: OTHER_TENANT, businessId: s.businessId }, 'session');
      const code = await outsider
        .query(
          `INSERT INTO p5scratch.subscription_invoices
             (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
           VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',100,0,100,'draft')`,
          [uuid(), s.tenantId, s.businessId],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(code, 'a session wrote into a business its tenant does not own').toBe('42501');
    } finally {
      await outsider.end();
    }
  });

  it('hides a SIBLING business inside the same tenant, which is what the restrictive layer buys', async () => {
    // THE CASE THAT MAKES F-13's FIRST FINDING MEASURABLE, and it was owed:
    // every other case here crosses a TENANT boundary, which the permissive
    // half alone already refuses. Drop the restrictive policy and all of
    // them stay green. Two businesses under ONE tenant is the only shape
    // that separates the two layers, and asserting the catalogue shape is
    // not a substitute: a check over a shape is not a test of membership.
    const mine = await freshScope();
    const sibling = await freshScope();
    expect(sibling.tenantId, 'the sibling is not in the same tenant, so this case proves the permissive half again').toBe(mine.tenantId);
    await insertGrant(owner, 'p5scratch', sibling, 900n, T1);
    await insertGrant(owner, 'p5scratch', mine, 100n, T1);
    const app = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(app, mine, 'session');
      const seen = await app.query<{ business: string }>(
        `SELECT DISTINCT business_id AS business FROM p5scratch.platform_credit_adjustments`,
      );
      expect(seen.rows.map((r) => r.business), 'the session read a sibling business inside its own tenant').toStrictEqual([
        mine.businessId,
      ]);
      // And the write side of the same layer: the tenant is honest, the
      // business is the sibling's.
      const code = await app
        .query(
          `INSERT INTO p5scratch.subscription_invoices
             (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
           VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',100,0,100,'draft')`,
          [uuid(), sibling.tenantId, sibling.businessId],
        )
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(code, 'a session wrote into a sibling business of its own tenant').toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('shows the PLATFORM principal every row with no context, because the bypass is a ROLE test', async () => {
    // ROUND 12, AND A CORRECTION OF MY OWN FIRST ADOPTION. This case used to
    // assert that the owner saw zero rows and then bought its visibility
    // back with `set_config('app.bypass_rls', 'true')`. Both halves were
    // wrong, and the reason is worth more than the case: `0006_rls.sql`'s
    // text defines `app_bypass()` over the GUC `app.bypass_rls`, but that
    // text is FIVE REDEFINITIONS STALE (0010, 0013, 0030, 0032, 0052 —
    // the chain is in this file's header). I read the live bodies out of
    // `pg_proc` on a cluster carrying the real history, not out of 0006.
    //
    // So in the house pattern the bypass is a ROLE, and the only principal
    // that holds it is the platform role — here `p5owner`, which this lane
    // substitutes for `daftar_platform`. FORCE RLS does bind the owner; the
    // first disjunct of every policy is what lets it through.
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 1000n, T1);
    const bare = await connectWithoutContext(ownerUrl());
    try {
      const r = await bare.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`,
        [s.businessId],
      );
      expect(r.rows[0]?.n, 'the platform principal cannot read without a context, so no platform path exists').toBe(1);
      const forced = await bare.query<{ forced: boolean }>(
        `SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'p5scratch.platform_credit_adjustments'::regclass`,
      );
      expect(forced.rows[0]?.forced, 'FORCE RLS is off, so this row was not reached through a policy at all').toBe(true);
      const bypass = await bare.query<{ b: boolean }>(`SELECT ${borrowedSchema()}.app_bypass() AS b`);
      expect(bypass.rows[0]?.b, 'the platform principal does not satisfy app_bypass()').toBe(true);
    } finally {
      await bare.end();
    }
  });

  it('gives a non-platform role NOTHING for setting app.bypass_rls, which is the stale pattern', async () => {
    // The red proof for the correction above, and the one case that would
    // have caught my first fixture: if `app_bypass()` were the GUC test
    // 0006's text describes, this connection would read every tenant's rows.
    // Against the LIVE definition it reads none, before and after.
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 1000n, T1);
    const app = await connectWithoutContext(appUrl());
    try {
      const before = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments`);
      expect(before.rows[0]?.n, 'default-deny failed before the GUC was touched at all').toBe(0);
      await app.query(`SELECT set_config('app.bypass_rls', 'true', false)`);
      const after = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments`);
      expect(after.rows[0]?.n, 'a GUC bought a cross-tenant read, so the bypass is not a role test').toBe(0);
      const bypass = await app.query<{ b: boolean }>(`SELECT ${borrowedSchema()}.app_bypass() AS b`);
      expect(bypass.rows[0]?.b, 'the application role satisfies app_bypass(), which no GUC may grant').toBe(false);
    } finally {
      await app.end();
    }
  });
});

describe('a definer routine trusts the context, not its caller', () => {
  // ROUND 14, THE COORDINATOR'S DIFF-REVIEW R-1. `lock_grants_in_order` is
  // `SECURITY DEFINER`, runs as a principal every policy admits, and took
  // its tenant and business ids FROM ITS CALLER with no check against the
  // transaction context, while `EXECUTE` was granted to the application
  // role. An application session could therefore name another tenant's
  // business, hold that business's grant-row locks for the length of its own
  // transaction, and read back how many grant rows it has. The remedy is a
  // fail-closed context check, and these are the cases that make it
  // load-bearing rather than present.

  it('refuses, BY NAME, a call naming a business the session has no context for', async () => {
    const mine = await freshScope();
    const victim = await freshScope(OTHER_TENANT);
    await insertGrant(owner, 'p5scratch', victim, 5000n, T1);
    const app = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(app, mine, 'session');
      const refusal = await app
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [victim.tenantId, victim.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(refusal, "a session locked and counted another tenant's grant rows through a definer routine").toBe(
        '23000/lgo_scope_is_the_callers_own',
      );
    } finally {
      await app.end();
    }
  });

  it('refuses a call naming a SIBLING business of the session own tenant', async () => {
    // The tenant matches and the business does not, which is the half a
    // tenant-only check would let through — the same shape as the sibling
    // case for the restrictive policy layer.
    const mine = await freshScope();
    const sibling = await freshScope();
    await insertGrant(owner, 'p5scratch', sibling, 700n, T1);
    const app = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(app, mine, 'session');
      const refusal = await app
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [sibling.tenantId, sibling.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(refusal, 'a session reached a sibling business through the definer routine').toBe(
        '23000/lgo_scope_is_the_callers_own',
      );
    } finally {
      await app.end();
    }
  });

  it('refuses a call from a session with NO context at all, rather than treating absent as permitted', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 300n, T1);
    const blind = await connectWithoutContext(appUrl());
    try {
      const refusal = await blind
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [s.tenantId, s.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(refusal, 'a context-less session called the definer routine successfully').toBe(
        '23000/lgo_scope_is_the_callers_own',
      );
    } finally {
      await blind.end();
    }
  });

  it('still serves the session its OWN scope, and the platform principal with no context', async () => {
    // The check is a refusal, not a wall: the legitimate caller is unaffected
    // and the bypass principal keeps the context-free path the policies
    // already grant it. Without this case the three above could be passed by
    // a routine that refuses everything.
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 100n, T1);
    await insertGrant(owner, 'p5scratch', s, 200n, T1);
    const app = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(app, s, 'session');
      const r = await app.query<{ locked: number }>(`SELECT p5scratch.lock_grants_in_order($1, $2, $3) AS locked`, [
        s.tenantId,
        s.businessId,
        'USD',
      ]);
      expect(r.rows[0]?.locked, 'the legitimate caller was refused its own scope').toBe(2);
    } finally {
      await app.end();
    }
    const asPlatform = await connectWithoutContext(ownerUrl());
    try {
      const r = await asPlatform.query<{ locked: number }>(
        `SELECT p5scratch.lock_grants_in_order($1, $2, $3) AS locked`,
        [s.tenantId, s.businessId, 'USD'],
      );
      expect(r.rows[0]?.locked, 'the platform principal lost its context-free path').toBe(2);
    } finally {
      await asPlatform.end();
    }
  });

  it('refuses a USAGE-ONLY stranger the definer routine, by privilege', async () => {
    // ROUND 15, the independent challenger's F-14 SECOND LEG, which it
    // measured and I had only asserted from the catalogue: a role holding
    // USAGE on the schema and nothing else read another tenant's grant
    // count through the PUBLIC EXECUTE default on this routine. The revoke
    // landed at round 14; this is the behavioural proof, and it is a
    // different claim from the `proacl` law below — one says what the grant
    // table holds, this says what a stranger can do.
    const victim = await freshScope();
    await insertGrant(owner, 'p5scratch', victim, 4200n, T1);
    const stranger = await connectWithoutContext(strangerUrl());
    try {
      const refusal = await stranger
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [victim.tenantId, victim.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      // 42501 and not the named scope refusal: the privilege check happens
      // before the body runs, which is the stronger of the two defences and
      // the one PUBLIC had been bypassing.
      expect(refusal, 'a role with nothing but schema USAGE executed the definer routine').toBe('42501');
      // And the stranger really does hold USAGE, so the refusal above is
      // about EXECUTE and not about the schema — a case that cannot tell
      // which refusal it got is the defect F-11 closed.
      const usage = await stranger.query<{ ok: boolean }>(
        `SELECT has_schema_privilege(current_user, 'p5scratch', 'USAGE') AS ok`,
      );
      expect(usage.rows[0]?.ok, 'the stranger has no USAGE, so the refusal above was the wrong one').toBe(true);
    } finally {
      await stranger.end();
    }
  });

  it('refuses BEFORE it takes the lock, measured against a session that already holds it', async () => {
    // ROUND 16, THE COORDINATOR'S N-1, AND IT IS THE BEST FINDING OF THE
    // ROUND BECAUSE IT IS ABOUT MY EVIDENCE RATHER THAN MY CODE.
    //
    // Round 14's pack argued that "0 advisory locks held after the refusal"
    // proves the guard precedes the lock, and the independent challenger
    // re-measured the same thing with a SAVEPOINT and agreed. BOTH OF US WERE
    // WRONG ABOUT WHAT THAT EVIDENCE CAN SHOW: PostgreSQL releases locks when
    // the transaction ABORTS, not when ROLLBACK is issued, so a guard placed
    // AFTER `pg_advisory_xact_lock` reads 0 locks after its refusal too. The
    // coordinator planted exactly that and the whole RLS file stayed GREEN,
    // 16 of 16 — so until this case, no case in this lane pinned the ordering,
    // and the pack's claim that it did was the kind of sentence this phase
    // keeps learning to distrust.
    //
    // THE DISCRIMINATOR IS A LOCK SOMEBODY ELSE ALREADY HOLDS. A second
    // session takes the victim business's advisory key and keeps it. Then the
    // cross-tenant call runs under a `lock_timeout`:
    //
    //   guard BEFORE the lock  -> 23000/lgo_scope_is_the_callers_own
    //   guard AFTER  the lock  -> 55P03, lock_not_available
    //
    // Two different SQLSTATEs, which is why this case asserts a code and
    // claims nothing about how long anything took. A timing figure from this
    // container would not be evidence about anything.
    const victim = await freshScope(OTHER_TENANT);
    await insertGrant(owner, 'p5scratch', victim, 500n, T1);
    const mine = await freshScope();
    // The holder takes the SAME key the routine takes:
    // `hashtext('p5scratch:' || business_id)`, held to the end of its
    // transaction, which is what `pg_advisory_xact_lock` means.
    const holder = await connectWithoutContext(ownerUrl());
    const attacker = await connectWithoutContext(appUrl());
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('p5scratch:' || $1::text))`, [victim.businessId]);
      // The holder really does hold it, read from `pg_locks` rather than
      // assumed from the statement having returned.
      const held = await holder.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      );
      expect(held.rows[0]?.n, 'the holder does not hold the lock, so this case discriminates nothing').toBe(1);

      await attacker.query('BEGIN');
      await setRequestContext(attacker, mine, 'transaction');
      await attacker.query(`SET LOCAL lock_timeout = '2s'`);
      const refusal = await attacker
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [victim.tenantId, victim.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      // `55P03` here would mean the routine reached the lock before it
      // checked the caller — the cross-tenant denial of service the guard is
      // supposed to have closed, surviving behind a refusal that looks right.
      expect(refusal, 'the routine waited on the victim\'s lock before checking the caller').toBe(
        '23000/lgo_scope_is_the_callers_own',
      );
      await attacker.query('ROLLBACK');
      await holder.query('ROLLBACK');
    } finally {
      await attacker.end();
      await holder.end();
    }
  });

  it('is NOT exempted by a session that authenticated as the owner and then SET ROLE', async () => {
    // ROUND 16, THE INDEPENDENT CHALLENGER'S F-16. `SESSION_USER = CURRENT_USER`
    // is false exactly when the session LOGGED IN as the routine's owner, and
    // `SET ROLE` does not touch `session_user` any more than `SECURITY DEFINER`
    // does. So "authenticate as the admin role, drop to the application role
    // per request" — a mainstream pooling pattern — was EXEMPT from the scope
    // check while acting as the application role.
    //
    // The membership it needs does not exist in the project's bootstrap, and
    // only a role administrator can create one, which is why the challenger
    // rated it P3 and planted the membership by hand to measure the
    // consequence. This case plants it and removes it again, so the finding is
    // reproducible by a run rather than by a transcript, and the cluster is
    // left as it was found. The guard now also requires the `role` GUC to be
    // `none`, which is session state a definer cannot overwrite either.
    const victim = await freshScope();
    await insertGrant(owner, 'p5scratch', victim, 4200n, T1);
    const mine = await freshScope();
    const su = await connectWithoutContext(bootstrapUrl());
    const ownerName = (
      await su.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'p5scratch'`,
      )
    ).rows[0]?.owner;
    expect(ownerName, 'the schema has no owner, so this case cannot plant anything').toBeTruthy();
    // A role name cannot be a bind parameter in GRANT, so it is checked
    // against the shape an unquoted identifier may have before it is
    // interpolated. Both lanes' principals (`p5owner`, `daftar_platform`)
    // satisfy it, and a name that does not stops the case instead of being
    // pasted into DDL.
    expect(ownerName ?? '', 'the schema owner is not a plain identifier; this case will not interpolate it').toMatch(
      /^[a-z_][a-z0-9_]{0,62}$/,
    );
    const pooled = await connectWithoutContext(ownerUrl());
    try {
      await su.query(`GRANT p5_app TO ${ownerName}`);
      // The route, exactly as the challenger measured it.
      await pooled.query('BEGIN');
      await setRequestContext(pooled, mine, 'transaction');
      await pooled.query('SET LOCAL ROLE p5_app');
      const who = await pooled.query<{ s: string; c: string; role: string }>(
        `SELECT session_user AS s, current_user AS c, current_setting('role') AS role`,
      );
      expect(who.rows[0]?.s, 'this case proves nothing unless the session AUTHENTICATED as the owner').toBe(ownerName);
      expect(who.rows[0]?.role, 'this case proves nothing unless the session is ACTING AS another role').toBe('p5_app');
      const refusal = await pooled
        .query(`SELECT p5scratch.lock_grants_in_order($1, $2, $3)`, [victim.tenantId, victim.businessId, 'USD'])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(refusal, 'an admin login acting as the application role reached another business').toBe(
        '23000/lgo_scope_is_the_callers_own',
      );
      await pooled.query('ROLLBACK');
      // The CONTROL, and it is what makes the refusal above attributable: the
      // same connection, the same foreign ids, no SET ROLE. The platform
      // principal's context-free path is exempt and still works, so the
      // refusal came from the `role` GUC and not from the scope comparison.
      const allowed = await pooled.query<{ locked: number }>(
        `SELECT p5scratch.lock_grants_in_order($1, $2, $3) AS locked`,
        [victim.tenantId, victim.businessId, 'USD'],
      );
      expect(allowed.rows[0]?.locked, 'the exempt admin path was refused, so the control proves nothing').toBe(1);
    } finally {
      await su.query(`REVOKE p5_app FROM ${ownerName}`);
      const left = await su.query<{ ok: boolean }>(`SELECT pg_has_role($1, 'p5_app', 'USAGE') AS ok`, [ownerName]);
      await su.end();
      await pooled.end();
      expect(left.rows[0]?.ok, 'the planted membership outlived the case that planted it').toBe(false);
    }
  });

  it('tells a foreign invoice and a non-existent one apart for NOBODY but the owner', async () => {
    // ROUND 16, THE INDEPENDENT CHALLENGER'S F-17, the same class as F-14:
    // `assert_invoice_credit_agrees` is the other definer that takes a
    // row-selecting argument. It is owned by `p5_invariants`, which sees every
    // tenant, and the application role holds EXECUTE on it by the round-14
    // compensating grant. With no scope check it answered "does this invoice
    // id exist in some other tenant" where every other route answers no rows.
    //
    // The close is deliberately NOT a new named refusal: a second name would
    // have left the oracle intact under a different spelling. An invoice the
    // caller's context does not own is treated exactly as an unreadable one,
    // so the two answers became the same answer — which is what this case
    // asserts, by comparing them to each other and not only to a literal.
    const mine = await freshScope();
    const foreign = await freshScope(OTHER_TENANT);
    const foreignInvoice = await createDraftInvoice(owner, 'p5scratch', foreign, 1000n);
    const absent = uuid();
    const app = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(app, mine, 'session');
      const onForeign = await app
        .query(`SELECT p5scratch.assert_invoice_credit_agrees($1)`, [foreignInvoice])
        .then(() => '', (e: unknown) => refusedBy(e));
      const onAbsent = await app
        .query(`SELECT p5scratch.assert_invoice_credit_agrees($1)`, [absent])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(onForeign, "another tenant's invoice was accepted by the invariant").toBe('23000/si_invoice_unreadable');
      expect(onAbsent, 'a non-existent invoice was accepted by the invariant').toBe('23000/si_invoice_unreadable');
      expect(onForeign, 'the two answers differ, so the existence oracle is still open').toBe(onAbsent);
    } finally {
      await app.end();
    }
    // And the distinction is not LOST, only withheld: the exempt principal
    // still sees the real reason, which is where the lane asserts it. A draft
    // carries no credit, so the invariant returns for one it may read.
    await owner.query(`SELECT p5scratch.assert_invoice_credit_agrees($1)`, [foreignInvoice]);
    const ownerOnAbsent = await owner
      .query(`SELECT p5scratch.assert_invoice_credit_agrees($1)`, [absent])
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(ownerOnAbsent, 'the owner lost the fail-closed branch as well, which is more than F-17 asked for').toBe(
      '23000/si_invoice_unreadable',
    );
  });

  it('grants EXECUTE on no definer routine to PUBLIC', async () => {
    // R-3: the requested DDL carried three `SECURITY DEFINER` routines and
    // ZERO `REVOKE` statements, so all three were executable by PUBLIC — the
    // default on a new function. Read from the catalogue, not from the file,
    // because the file is applied in two lanes and a grant can also come
    // from elsewhere.
    const r = await owner.query<{ proname: string; acl: string | null }>(
      `SELECT p.proname, array_to_string(p.proacl, ' ') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'p5scratch' AND p.prosecdef
        ORDER BY p.proname`,
    );
    expect(r.rows.length, 'no SECURITY DEFINER routine was found at all, so this law is vacuous').toBeGreaterThanOrEqual(3);
    for (const row of r.rows) {
      // An ACL entry whose grantee is empty (`=X/owner`) is PUBLIC.
      const toPublic = (row.acl ?? '').split(' ').filter((entry) => entry.startsWith('='));
      expect(toPublic, `${row.proname} is EXECUTE-able by PUBLIC`).toStrictEqual([]);
      expect(row.acl, `${row.proname} has a NULL ACL, which means the default grant to PUBLIC`).toBeTruthy();
    }
  });
});

describe('what a SESSION-scoped context does to the next request on the same connection', () => {
  // ROUND 15, the independent challenger's F-15, measured rather than
  // argued, and kept as cases because round 14 removed the DEFAULT but not
  // the hazard: as measured by the pure-lane law at this head, 22 sites
  // still choose session scope (18 through the helper, 4 as literal
  // `set_config(…, false)`), and what that choice costs now has a name and
  // a test instead of a sentence in a checkpoint.

  it('lets the NEXT request on the same backend continue as the previous tenant, and WRITE as it', async () => {
    const first = await freshScope();
    const pooled = await connectWithoutContext(appUrl());
    try {
      const before = await pooled.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`);
      await setRequestContext(pooled, first, 'session');
      await pooled.query('BEGIN');
      await pooled.query('COMMIT');
      // A new "request" on the same pooled connection, setting nothing.
      const after = await pooled.query<{ pid: number; tenant: string; business: string }>(
        `SELECT pg_backend_pid()::int AS pid,
                coalesce(current_setting('app.tenant_id', true), '') AS tenant,
                coalesce(current_setting('app.business_id', true), '') AS business`,
      );
      expect(after.rows[0]?.pid, 'this case proves nothing unless it is the same backend').toBe(before.rows[0]?.pid);
      expect(after.rows[0]?.tenant, 'the session-scoped context did not survive, so this hazard is gone').toBe(first.tenantId);
      expect(after.rows[0]?.business).toBe(first.businessId);
      // The half that matters: it can WRITE, attributed to the stale tenant.
      const id = uuid();
      await pooled.query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',100,0,100,'draft')`,
        [id, first.tenantId, first.businessId],
      );
      const row = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM p5scratch.subscription_invoices WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]?.n, 'the stale-context write did not land, so the hazard is not what it looks like').toBe(1);
    } finally {
      await pooled.end();
    }
  });

  it('cannot be promoted into another TENANT by half a context: that intersects empty', async () => {
    // The challenger's own qualification of F-15, re-measured here: a
    // request that sets only `app.business_id` over a stale tenant
    // satisfies the restrictive policy and fails the permissive one, so
    // across a TENANT boundary the two intersect empty and the path fails
    // closed.
    const stale = await freshScope();
    const foreign = await freshScope(OTHER_TENANT);
    await insertGrant(owner, 'p5scratch', foreign, 900n, T1);
    const pooled = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(pooled, stale, 'session');
      await pooled.query(`SELECT set_config('app.business_id', $1, false)`, [foreign.businessId]);
      const seen = await pooled.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments`,
      );
      expect(seen.rows[0]?.n, "half a context reached another tenant's rows").toBe(0);
    } finally {
      await pooled.end();
    }
  });

  it('CAN be moved to a SIBLING business of the stale tenant by half a context — the qualification has a boundary', async () => {
    // AND THIS IS A REFINEMENT OF THE CHALLENGER'S QUALIFICATION, measured
    // because the first version of the case above was written with both
    // scopes in ONE tenant and came back with a row where I expected zero.
    //
    // "Half a context fails closed" is true across tenants and FALSE across
    // businesses of the same tenant: the permissive policy is satisfied by
    // the stale tenant, which is genuinely the session's own, and the
    // restrictive one by the business just set. So a stale session can be
    // steered to a sibling business with one `set_config`. That is the same
    // boundary the sibling-business case draws for the policy layers, and
    // it is the reason the request context is a PAIR and the frozen
    // discipline is per transaction: an incomplete context is not a safe
    // context, it is a context half inherited from whoever used the
    // connection last.
    const stale = await freshScope();
    const sibling = await freshScope();
    expect(sibling.tenantId, 'the sibling is in another tenant, so this case is the one above').toBe(stale.tenantId);
    await insertGrant(owner, 'p5scratch', sibling, 900n, T1);
    const pooled = await connectWithoutContext(appUrl());
    try {
      await setRequestContext(pooled, stale, 'session');
      await pooled.query(`SELECT set_config('app.business_id', $1, false)`, [sibling.businessId]);
      const seen = await pooled.query<{ n: number; business: string }>(
        `SELECT count(*)::int AS n, coalesce(max(business_id::text), '') AS business
           FROM p5scratch.platform_credit_adjustments`,
      );
      expect(seen.rows[0]?.n, 'the sibling move no longer reaches the rows — then this hazard is closed and the comment above is stale').toBe(1);
      expect(seen.rows[0]?.business).toBe(sibling.businessId);
    } finally {
      await pooled.end();
    }
  });
});

describe('the context is transaction-local, as the frozen discipline requires', () => {
  it('loses the context at COMMIT, so a pooled connection cannot carry a stale one', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 1000n, T1);
    const pooled = await connectWithoutContext(appUrl());
    try {
      await pooled.query('BEGIN');
      await setRequestContext(pooled, s, 'transaction');
      const inside = await pooled.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments WHERE business_id = $1`,
        [s.businessId],
      );
      expect(inside.rows[0]?.n, 'the transaction-local context did not take effect').toBe(1);
      await pooled.query('COMMIT');
      // The next transaction on the SAME connection starts blind.
      const after = await pooled.query<{ n: number }>(`SELECT count(*)::int AS n FROM p5scratch.platform_credit_adjustments`);
      expect(after.rows[0]?.n, 'the context survived its transaction, so a pooled connection carries it').toBe(0);
      const ctx = await pooled.query<{ business: string }>(`SELECT coalesce(current_setting('app.business_id', true), '') AS business`);
      expect(ctx.rows[0]?.business, 'app.business_id outlived its transaction').toBe('');
    } finally {
      await pooled.end();
    }
  });
});
