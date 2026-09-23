/**
 * THE journal_lines TENANT POLICY — SHAPE, FOUNDATION AND EQUIVALENCE
 * (P2-S8 RLS performance directive §7, §8, §9).
 *
 * P2-S8 measured the `tenant_membership` policy on `journal_lines` costing
 * 34× the same read without it, because PostgreSQL plans its
 * `EXISTS (SELECT 1 FROM businesses …)` as a correlated subplan evaluated
 * once per journal line. `0052` replaces that lookup with a direct predicate
 * on `journal_lines.tenant_id`.
 *
 * THE WHOLE POINT OF THIS FILE IS THAT "FASTER" MUST NOT MEAN "LOOSER". A
 * performance change to a security boundary is only acceptable if the
 * boundary is provably the same one, so this file asserts three separate
 * things and keeps them separate:
 *
 *   1. THE FOUNDATION (§8). The new predicate is equivalent ONLY because
 *      `journal_lines_tenant_business_fk` guarantees that a line's
 *      `(tenant_id, business_id)` pair is a real `businesses` row, and
 *      because `businesses.id` is a PRIMARY KEY, so that pair is the only
 *      one for that business. If a future migration ever drops, disables or
 *      invalidates that FK, the optimisation loses its justification — and
 *      these tests fail loudly rather than the isolation quietly weakening.
 *
 *   2. THE SHAPE (§9). Asked of the LIVE CATALOGUE, not of the file: the
 *      effective policy must carry no dependency on `businesses` at all.
 *      `pg_depend` is the authority here rather than a regular expression
 *      over `pg_get_expr`, because a whitespace-sensitive pattern would be
 *      a test of formatting, and because a dependency is what PostgreSQL
 *      itself records when an expression reads a table.
 *
 *   3. THE BOUNDARY (§7). Eleven cases, A … K, each seeding its own rows and
 *      asking a real connection as a real role what it can actually see. A
 *      count of zero from an empty database proves nothing, so nothing here
 *      is asked of an empty database.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { appDbUrl, ensurePostgres, ownerPool, platformDbUrl, reconcilerDbUrl, resetData, workerDbUrl } from '../helpers/test-app';
import { assertionFor, must, postAs, simpleCommand, todayIn } from '../helpers/accounting-posting';

/** tenant A owns two businesses; tenant B owns one. Every case needs both. */
let tenantA = '';
let tenantB = '';
let businessA1 = '';
let businessA2 = '';
let businessB1 = '';
let userA = '';
let userB = '';
let linesA1 = 0;
let linesA2 = 0;
let linesB1 = 0;

async function as<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Open a transaction carrying exactly the GUCs a case wants to present. */
async function scoped(c: Client, gucs: Record<string, string>): Promise<void> {
  await c.query('BEGIN');
  for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
}

async function visibleLines(url: string, gucs: Record<string, string>, businessId?: string): Promise<number> {
  return as(url, async (c) => {
    await scoped(c, gucs);
    try {
      const { rows } =
        businessId === undefined
          ? await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines`)
          : await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines WHERE business_id = $1`, [businessId]);
      return must(rows[0]).n;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}

/** Post `count` balanced two-line entries into the given business. */
async function fill(tenantId: string, businessId: string, userId: string, count: number): Promise<number> {
  const today = await todayIn(ownerPool(), 'Asia/Hebron');
  for (let i = 0; i < count; i += 1) {
    const command = simpleCommand({ tenantId, businessId, userId } as never, randomUUID(), today, BigInt(1000 + i));
    await postAs(assertionFor(command, userId), command);
  }
  return count * 2;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await ownerPool().query<{ id: string }>(sql, params)).rows[0]).id;
  const stamp = Date.now();

  tenantA = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  tenantB = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  businessA1 = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'Policy A1', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantA, `rls-policy-a1-${stamp}`],
  );
  businessA2 = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'Policy A2', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantA, `rls-policy-a2-${stamp}`],
  );
  businessB1 = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'Policy B1', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantB, `rls-policy-b1-${stamp}`],
  );
  userA = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'A') RETURNING id`, [`rls-a-${stamp}@test.daftar.local`]);
  userB = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'B') RETURNING id`, [`rls-b-${stamp}@test.daftar.local`]);

  linesA1 = await fill(tenantA, businessA1, userA, 3);
  linesA2 = await fill(tenantA, businessA2, userA, 2);
  linesB1 = await fill(tenantB, businessB1, userB, 2);
}, 180_000);

// ── 1. THE FOUNDATION (§8) ────────────────────────────────────────────────

describe('the FK the optimised policy stands on (§8)', () => {
  it('journal_lines_tenant_business_fk exists, is a foreign key, and is VALIDATED', async () => {
    const { rows } = await ownerPool().query<{ contype: string; convalidated: boolean; refrel: string; cols: string; refcols: string }>(
      `SELECT c.contype::text,
              c.convalidated,
              c.confrelid::regclass::text AS refrel,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(att, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att) AS cols,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(att, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.att) AS refcols
         FROM pg_constraint c
        WHERE c.conrelid = 'journal_lines'::regclass AND c.conname = 'journal_lines_tenant_business_fk'`,
    );
    expect(rows).toHaveLength(1);
    expect(must(rows[0])).toEqual({
      contype: 'f',
      convalidated: true,
      refrel: 'businesses',
      cols: 'tenant_id,business_id',
      refcols: 'tenant_id,id',
    });
  });

  it('businesses.id is a single-column PRIMARY KEY, so one business_id names one tenant', async () => {
    // This is the second half of the equivalence. The FK says the pair is
    // real; the PK says there is no OTHER businesses row with that id under
    // a different tenant, which is what makes "does a business with this id
    // belong to my tenant" and "is this line's tenant mine" the same question.
    const { rows } = await ownerPool().query<{ cols: string }>(
      `SELECT (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(att, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att) AS cols
         FROM pg_constraint c
        WHERE c.conrelid = 'businesses'::regclass AND c.contype = 'p'`,
    );
    expect(must(rows[0]).cols).toBe('id');
  });

  it('a line whose tenant_id and business_id disagree is refused by the FK, independently of RLS', async () => {
    // Asked as the schema owner, which is not subject to a permission
    // denial and can reach the table directly: the refusal proved here is
    // the CONSTRAINT's, never a policy's.
    const entryId = must((await ownerPool().query<{ id: string }>(`SELECT id FROM journal_entries WHERE business_id = $1 LIMIT 1`, [businessA1])).rows[0]).id;
    const accountId = must((await ownerPool().query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 LIMIT 1`, [businessA1])).rows[0]).id;
    await expect(
      ownerPool().query(
        `INSERT INTO journal_lines (tenant_id, business_id, journal_entry_id, line_no, account_id,
                                    debit_minor, credit_minor, base_amount_minor, base_currency,
                                    txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
         VALUES ($1, $2, $3, 99, $4, 100, 0, 100, 'ILS', 100, 'ILS', 1, 'base', date_trunc('second', now()))`,
        // Tenant B's id against Business A1: no businesses row pairs them.
        [tenantB, businessA1, entryId, accountId],
      ),
    ).rejects.toThrow(/journal_lines_tenant_business_fk|violates foreign key/i);
  });
});

// ── 2. THE SHAPE (§9) ─────────────────────────────────────────────────────

async function policyDependsOnBusinesses(table: string, policy: string): Promise<number> {
  const { rows } = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_depend d
       JOIN pg_policy p ON p.oid = d.objid
      WHERE d.classid = 'pg_policy'::regclass
        AND p.polrelid = $1::regclass
        AND p.polname = $2
        AND d.refclassid = 'pg_class'::regclass
        AND d.refobjid = 'businesses'::regclass`,
    [table, policy],
  );
  return must(rows[0]).n;
}

describe('the effective policy shape, read from the live catalogue (§9)', () => {
  it('journal_lines.tenant_membership carries NO dependency on businesses', async () => {
    expect(await policyDependsOnBusinesses('journal_lines', 'tenant_membership')).toBe(0);
  });

  it('it derives tenant isolation from journal_lines.tenant_id itself', async () => {
    const { rows } = await ownerPool().query<{ permissive: string; cmd: string; qual: string; withcheck: string; depends_on_tenant_id: number }>(
      `SELECT CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
              p.polcmd::text AS cmd,
              pg_get_expr(p.polqual, p.polrelid)       AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid)  AS withcheck,
              (SELECT count(*)::int
                 FROM pg_depend d
                 JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                WHERE d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                  AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'journal_lines'::regclass
                  AND a.attname = 'tenant_id') AS depends_on_tenant_id
         FROM pg_policy p
        WHERE p.polrelid = 'journal_lines'::regclass AND p.polname = 'tenant_membership'`,
    );
    const row = must(rows[0]);
    expect(row.permissive).toBe('PERMISSIVE');
    expect(row.cmd).toBe('*');
    expect(row.depends_on_tenant_id).toBeGreaterThan(0);
    // A second, weaker source: the rendered expression names the column and
    // no longer names the table. The dependency check above is the primary.
    expect(row.qual).toMatch(/tenant_id/);
    expect(row.qual).not.toMatch(/\bbusinesses\b/);
    expect(row.withcheck).not.toMatch(/\bbusinesses\b/);
  });

  it('a plan for an ordinary tenant-scoped read contains no businesses subplan', async () => {
    const plan = await as(appDbUrl, async (c) => {
      await scoped(c, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 });
      try {
        const { rows } = await c.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON, COSTS false) SELECT count(*) FROM journal_lines`);
        return JSON.stringify(must(rows[0])['QUERY PLAN']);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
    expect(plan).not.toMatch(/businesses/);
    expect(plan).not.toMatch(/SubPlan/);
  });

  it('journal_lines keeps RLS enabled AND forced, and keeps its RESTRICTIVE business_isolation', async () => {
    const { rows } = await ownerPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'journal_lines'::regclass`,
    );
    expect(must(rows[0])).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const { rows: policies } = await ownerPool().query<{ polname: string; permissive: string; cmd: string }>(
      `SELECT polname, CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive, polcmd::text AS cmd
         FROM pg_policy WHERE polrelid = 'journal_lines'::regclass ORDER BY polname`,
    );
    expect(policies).toEqual([
      { polname: 'accounting_validator', permissive: 'PERMISSIVE', cmd: 'r' },
      { polname: 'accounting_writer', permissive: 'PERMISSIVE', cmd: 'a' },
      { polname: 'business_isolation', permissive: 'RESTRICTIVE', cmd: '*' },
      { polname: 'tenant_membership', permissive: 'PERMISSIVE', cmd: '*' },
    ]);
  });

  it('nothing else was optimised for consistency — the other tables keep the shape they had (§5)', async () => {
    // The measured blocker was journal_lines and only journal_lines. A
    // migration that "tidied up" the rest would have changed six security
    // boundaries on the strength of one measurement.
    for (const table of ['journal_entries', 'accounting_source_bindings', 'accounts', 'branches', 'memberships']) {
      expect(await policyDependsOnBusinesses(table, 'tenant_membership'), table).toBeGreaterThan(0);
    }
  });

  it('app_bypass() still exempts daftar_platform alone', async () => {
    const { rows } = await ownerPool().query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'app_bypass'`);
    expect(rows).toHaveLength(1);
    expect(must(rows[0]).src.replace(/\s+/g, ' ').trim()).toBe("SELECT current_user = 'daftar_platform'");
  });
});

// ── 3. THE BOUNDARY — CASES A … K (§7) ────────────────────────────────────

describe('the isolation matrix, against seeded rows (§7)', () => {
  it('CASE A — correct tenant, correct business: the business’s own lines are visible', async () => {
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 })).toBe(linesA1);
  });

  it('CASE B — wrong tenant, correct business id: ZERO rows', async () => {
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessA1 })).toBe(0);
  });

  it('CASE C — correct tenant, wrong business: ZERO rows', async () => {
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessB1 })).toBe(0);
  });

  it('CASE D — missing tenant context: ZERO rows', async () => {
    expect(await visibleLines(appDbUrl, { 'app.business_id': businessA1 })).toBe(0);
  });

  it('CASE E — missing business context: ZERO rows', async () => {
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA })).toBe(0);
  });

  it('CASE F — a foreign tenant and its own foreign business sees NOTHING of tenant A', async () => {
    // Read as: a caller legitimately scoped to tenant B sees tenant B, and
    // none of tenant A's two businesses — not one row, under either id.
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessB1 }, businessA1)).toBe(0);
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessB1 }, businessA2)).toBe(0);
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessB1 })).toBe(linesB1);
  });

  it('CASE G — two businesses under one tenant: only the scoped one is visible', async () => {
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 }, businessA2)).toBe(0);
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA2 })).toBe(linesA2);
  });

  it('CASE H — the reconciler, correctly scoped, sees ONLY the intended business', async () => {
    expect(await visibleLines(reconcilerDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 })).toBe(linesA1);
    expect(await visibleLines(reconcilerDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 }, businessA2)).toBe(0);
  });

  it('CASE I — a stolen reconciler credential still sees one scoped business at a time, and cannot write', async () => {
    // Re-scoping is what the reconciliation pass itself does per business, so
    // the trust model was never "it cannot change the GUCs" — it is that the
    // credential can read six columns of six tables, one business at a time,
    // and can write nothing anywhere. 0052 changes neither half.
    expect(await visibleLines(reconcilerDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessB1 })).toBe(linesB1);
    expect(await visibleLines(reconcilerDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessB1 }, businessA1)).toBe(0);
    // Mismatched pair: the tenant of one, the business of another.
    expect(await visibleLines(reconcilerDbUrl, { 'app.tenant_id': tenantB, 'app.business_id': businessA1 })).toBe(0);

    await as(reconcilerDbUrl, async (c) => {
      await scoped(c, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 });
      await expect(c.query(`DELETE FROM journal_lines`)).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK').catch(() => undefined);
    });
    const { rows } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges
        WHERE grantee = 'daftar_reconciler' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`,
    );
    expect(must(rows[0]).n).toBe(0);
  });

  it('CASE J — the validator/writer authority is untouched: its policy stands and posting still works', async () => {
    const { rows } = await ownerPool().query<{ qual: string }>(
      `SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy
        WHERE polrelid = 'journal_lines'::regclass AND polname = 'accounting_validator'`,
    );
    expect(must(rows[0]).qual.replace(/\s+/g, ' ')).toMatch(/daftar_accounting_internal/);
    const before = await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 });
    const added = await fill(tenantA, businessA1, userA, 1);
    expect(await visibleLines(appDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 })).toBe(before + added);
    linesA1 += added;
  });

  it('CASE K — daftar_platform still bypasses, and daftar_worker still does not', async () => {
    // app_bypass() is `current_user = daftar_platform`, so the bypass needs
    // no GUC and no scope: every line, every business, exactly as before.
    const all = linesA1 + linesA2 + linesB1;
    expect(await visibleLines(platformDbUrl, {})).toBe(all);
    expect(await visibleLines(workerDbUrl, { 'app.tenant_id': tenantA, 'app.business_id': businessA1 })).toBe(linesA1);
    expect(await visibleLines(workerDbUrl, {})).toBe(0);
  });
});
