/**
 * MATRIX 12 — THE THREE POLICY HELPERS, AND WHY THEY MAY CARRY NO SET CLAUSE
 * (P2-S8, Tech Lead directive of 2026-09-24, condition 9).
 *
 * `app_bypass()`, `app_tenant()` and `app_business()` are named by every
 * row-level security policy in DAFTAR, so they are evaluated more often than
 * any other code in the database. 0052 replaced all three, for a reason that
 * was measured rather than reasoned about:
 *
 *   * they carried `SET search_path = …`, and `inline_function()` in the
 *     PostgreSQL planner refuses OUTRIGHT to inline any function with a SET
 *     clause. So each one stayed a real function call, once per row, per
 *     mention, per policy. On 104,478 journal lines, as a superuser so that
 *     the clause under test was the only difference between two readings:
 *     `tenant_id::text = current_setting('app.tenant_id', true)` took 45.8 ms
 *     and `tenant_id::text = app_tenant()` — THE SAME CALL, wrapped — took
 *     215.3 ms;
 *   * and they were PARALLEL UNSAFE by default, which makes every plan that
 *     touches an RLS-protected table parallel-unsafe, whatever the query.
 *
 * ── WHAT THIS FILE IS FOR ────────────────────────────────────────────────
 *
 * Dropping a `search_path` is normally a security regression, and guard G-5
 * and `search-path-shadowing.test.ts` exist to refuse exactly that. These
 * three are allowed to have none for ONE reason: their bodies are written in
 * the SQL-standard form, which PostgreSQL parses and RESOLVES WHEN THE
 * FUNCTION IS CREATED, storing a parse tree in `pg_proc.prosqlbody`. There is
 * no name left to resolve when they run, so there is nothing a caller's path
 * could reach. A string body (`AS $$ … $$`) is the opposite: kept as text and
 * parsed at CALL time, which is precisely when `search_path` decides what
 * each name means.
 *
 * So this file is the standing proof of that exemption, and it is written to
 * FAIL if any of it stops being true — if a helper regains a SET clause, if
 * it goes back to a string body, if it stops being PARALLEL SAFE, if it
 * becomes SECURITY DEFINER, if its owner or its privileges move, or if some
 * OTHER routine quietly joins the exempt set without meeting the same bar.
 *
 * The last case is the one that matters most. The exclusion in
 * `search-path-shadowing.test.ts` is written as `prosqlbody IS NULL`, which
 * is a property any future migration could give a routine. The set is pinned
 * here, by name.
 */
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, ensurePostgres, ownerPool, platformDbUrl, workerDbUrl } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

/** The exempt set, by name. Nothing else may be in it. */
const HELPERS = ['app_business', 'app_bypass', 'app_tenant'] as const;

/**
 * Credentials a service actually connects with. None of them may own one of
 * these functions, because an owner can `CREATE OR REPLACE` it — and
 * replacing `app_bypass()` is replacing the isolation boundary itself.
 */
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;

interface Routine {
  readonly proname: string;
  readonly owner: string;
  readonly acl: string | null;
  readonly prosecdef: boolean;
  readonly provolatile: string;
  readonly proparallel: string;
  readonly proisstrict: boolean;
  readonly proleakproof: boolean;
  readonly pronargs: number;
  readonly ret: string;
  readonly cfg: string | null;
  readonly sqlbody: boolean;
  readonly body: string | null;
}

let routines: Routine[] = [];

async function withScope<T>(url: string, gucs: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

beforeAll(async () => {
  await ensurePostgres();
  const { rows } = await ownerPool().query<Routine>(
    `SELECT p.proname,
            p.proowner::regrole::text          AS owner,
            p.proacl::text                     AS acl,
            p.prosecdef,
            p.provolatile,
            p.proparallel,
            p.proisstrict,
            p.proleakproof,
            p.pronargs,
            p.prorettype::regtype::text        AS ret,
            p.proconfig::text                  AS cfg,
            (p.prosqlbody IS NOT NULL)         AS sqlbody,
            pg_get_function_sqlbody(p.oid)     AS body
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
      ORDER BY p.proname`,
    [[...HELPERS]],
  );
  routines = rows;
});

describe('the exempt set is exactly these three (§9.1)', () => {
  it('all three exist, once each, with no arguments', () => {
    expect(routines.map((r) => r.proname)).toEqual([...HELPERS]);
    for (const r of routines) expect(r.pronargs, r.proname).toBe(0);
    expect(routines.find((r) => r.proname === 'app_bypass')?.ret).toBe('boolean');
    expect(routines.find((r) => r.proname === 'app_tenant')?.ret).toBe('text');
    expect(routines.find((r) => r.proname === 'app_business')?.ret).toBe('text');
  });

  it('NO other routine in public claims the SQL-standard-body exemption', async () => {
    const { rows } = await ownerPool().query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosqlbody IS NOT NULL
          AND NOT (p.proname = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [[...HELPERS]],
    );
    // A new one is not forbidden. It is forbidden to appear WITHOUT being
    // added here, because `search-path-shadowing.test.ts` stops asking a
    // routine for a pinned path the moment it has a parse-tree body.
    expect(
      rows.map((r) => r.sig),
      'a routine gained a SQL-standard body and so left the search_path rule, without being listed in this file',
    ).toEqual([]);
  });
});

describe('the properties that make a missing search_path safe (§9.2)', () => {
  it('each body is a resolved parse tree, not text parsed at call time', () => {
    for (const r of routines) {
      expect(r.sqlbody, `${r.proname} is not a SQL-standard body`).toBe(true);
      expect(r.cfg, `${r.proname} carries a SET clause again, so it can no longer be inlined`).toBeNull();
    }
  });

  it('none of them runs as its definer', () => {
    for (const r of routines) expect(r.prosecdef, `${r.proname} became SECURITY DEFINER`).toBe(false);
  });

  it('each names only what it is supposed to read', () => {
    const body = (name: string): string => (routines.find((r) => r.proname === name)?.body ?? '').replace(/\s+/g, ' ').trim();
    expect(body('app_tenant')).toMatch(/current_setting\('app\.tenant_id'::text, true\)/);
    expect(body('app_business')).toMatch(/current_setting\('app\.business_id'::text, true\)/);
    // The bypass reads the authenticated role, never a setting: a GUC is
    // something a caller can set, and 0013 replaced exactly that shape.
    expect(body('app_bypass')).toMatch(/CURRENT_USER = 'daftar_platform'::name/);
    expect(body('app_bypass')).not.toMatch(/current_setting/i);
    for (const name of ['app_tenant', 'app_business'] as const) {
      expect(body(name), `${name} reads more than its own setting`).not.toMatch(/daftar_/);
    }
  });
});

describe('the properties that make them cheap (§9.3)', () => {
  it('all three are STABLE and PARALLEL SAFE', () => {
    for (const r of routines) {
      expect(r.provolatile, `${r.proname} is no longer STABLE`).toBe('s');
      expect(r.proparallel, `${r.proname} is not PARALLEL SAFE`).toBe('s');
    }
  });

  it('PARALLEL SAFE is a statement of fact: a worker sees the same scope as its leader', async () => {
    // Both a session GUC and the authenticated role are copied into every
    // parallel worker, which is why SAFE is correct here and not a relaxation.
    // Asserted rather than asserted-about: the value read inside a forced
    // parallel plan must equal the value read outside one.
    const scope = '11111111-2222-3333-4444-555555555555';
    const seen = await withScope(appDbUrl, { 'app.tenant_id': scope }, async (c) => {
      await c.query(`SET LOCAL parallel_setup_cost = 0`);
      await c.query(`SET LOCAL parallel_tuple_cost = 0`);
      await c.query(`SET LOCAL min_parallel_table_scan_size = 0`);
      // The knob that forces a worker was renamed in PostgreSQL 16, and
      // setting a parameter the server does not know is an ERROR that aborts
      // the transaction — a `.catch()` on the client hides the rejection and
      // leaves every later statement in this block failing. So each attempt
      // gets a savepoint, and the first name that exists wins.
      for (const guc of ['debug_parallel_query', 'force_parallel_mode']) {
        await c.query(`SAVEPOINT parallel_knob`);
        try {
          await c.query(`SET LOCAL ${guc} = on`);
          await c.query(`RELEASE SAVEPOINT parallel_knob`);
          break;
        } catch {
          await c.query(`ROLLBACK TO SAVEPOINT parallel_knob`);
        }
      }
      const { rows } = await c.query<{ t: string | null; b: boolean }>(`SELECT app_tenant() AS t, app_bypass() AS b`);
      return must(rows[0]);
    });
    expect(seen.t).toBe(scope);
    expect(seen.b).toBe(false);
  });

  it('the planner actually inlines them — the filter names the body, not the function', async () => {
    const { rows } = await ownerPool().query<{ line: string }>(
      `EXPLAIN (VERBOSE, COSTS OFF) SELECT id FROM businesses WHERE tenant_id = nullif(app_tenant(), '')::uuid`,
    );
    const plan = rows.map((r) => (r as unknown as Record<string, string>)['QUERY PLAN']).join('\n');
    // This is the whole point of the migration, and it is the one assertion
    // here that would still pass if PostgreSQL changed its mind about SET
    // clauses — so it is asked of the plan and not of the catalogue.
    expect(plan, 'app_tenant() is still a per-row function call in the plan').not.toMatch(/app_tenant\(\)/);
    expect(plan).toMatch(/current_setting/);
  });
});

describe('nothing about their authority moved (§9.4)', () => {
  it('all three share one owner, and it is not a credential any service connects with', () => {
    const owners = [...new Set(routines.map((r) => r.owner))];
    expect(owners, 'the three helpers no longer share an owner').toHaveLength(1);
    expect(RUNTIME_ROLES as readonly string[]).not.toContain(must(owners[0]));
  });

  it('none of them carries an explicit grant — the default, exactly as 0006 left it', () => {
    // A NULL ACL is "no GRANT was ever issued", which for a function means the
    // built-in default of EXECUTE to PUBLIC. Anything else would mean 0052
    // issued or revoked a privilege, and 0052 asserts at apply time that it
    // did not.
    for (const r of routines) expect(r.acl, `${r.proname} acquired an explicit ACL`).toBeNull();
  });

  it('no DAFTAR role can redefine them', async () => {
    const { rows } = await ownerPool().query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'daftar_%' AND (rolsuper OR rolbypassrls) ORDER BY 1`,
    );
    expect(
      rows.map((r) => r.rolname),
      'a DAFTAR role holds SUPERUSER or BYPASSRLS, so the policy boundary is not the boundary',
    ).toEqual([]);
  });

  it('app_bypass() still answers true for exactly one principal', async () => {
    const asRole = async (url: string): Promise<boolean> =>
      withScope(url, {}, async (c) => must((await c.query<{ b: boolean }>(`SELECT app_bypass() AS b`)).rows[0]).b);
    expect(await asRole(platformDbUrl)).toBe(true);
    expect(await asRole(appDbUrl)).toBe(false);
    expect(await asRole(workerDbUrl)).toBe(false);
  });

  it('the scope helpers still answer NULL when nothing is set, and the value when it is', async () => {
    const unset = await withScope(appDbUrl, {}, async (c) =>
      must((await c.query<{ t: string | null; b: string | null }>(`SELECT app_tenant() AS t, app_business() AS b`)).rows[0]),
    );
    expect(unset.t).toBeNull();
    expect(unset.b).toBeNull();

    const set = await withScope(appDbUrl, { 'app.tenant_id': 'T', 'app.business_id': 'B' }, async (c) =>
      must((await c.query<{ t: string | null; b: string | null }>(`SELECT app_tenant() AS t, app_business() AS b`)).rows[0]),
    );
    expect(set).toEqual({ t: 'T', b: 'B' });
  });
});
