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
 * that connection is vacuous by construction. The cases that carry weight
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

import { appUrl, borrowedSchema, connect, connectWithoutContext, ownerUrl, refusedBy, setRequestContext, uuid } from './helpers/cluster';
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

  it('keeps FORCE ROW LEVEL SECURITY on, so the owner is subject to policy too', async () => {
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
      await setRequestContext(outsider, { tenantId: OTHER_TENANT, businessId: s.businessId });
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
      await setRequestContext(app, mine);
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

describe('the context is transaction-local, as the frozen discipline requires', () => {
  it('loses the context at COMMIT, so a pooled connection cannot carry a stale one', async () => {
    const s = await freshScope();
    await insertGrant(owner, 'p5scratch', s, 1000n, T1);
    const pooled = await connectWithoutContext(appUrl());
    try {
      await pooled.query('BEGIN');
      await setRequestContext(pooled, s, true);
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
