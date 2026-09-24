/**
 * THE RECONCILER'S AUTHORITY, ASKED OF THE DATABASE (P2-S8 §5, §12-§14, §27, §28).
 *
 * `0051` ends with assertions of its own, and those run inside the migration
 * that grants the privileges. That is worth having and is not enough: a
 * migration asserting its own effect is one program agreeing with itself, and
 * it says nothing about a deployment where a later change, a manual grant or
 * a restored dump moved the privileges afterwards.
 *
 * So this file asks the LIVE catalogues, from outside the migration, and
 * compares them against a model that is written down in a file a reviewer can
 * read — `infrastructure/database/reconciler-privilege-model.json` — in BOTH
 * directions. A privilege the model claims and the database does not grant is
 * a broken deployment. A privilege the database grants and the model does not
 * claim is an unreviewed widening, and it fails here even if nothing uses it.
 *
 * §28 is the last section: the stolen-credential question. It is answered
 * honestly rather than reassuringly. This role IS intentionally capable of
 * read-only accounting inspection across every business, and an attacker
 * holding it can read what the nine checks read. What it cannot do is written
 * down as assertions below.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ensurePostgres, ownerPool, reconcilerDbUrl } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

interface PrivilegeModel {
  role: string;
  attributes: Record<string, boolean>;
  memberOf: string[];
  temporary: boolean;
  createOnSchemaPublic: boolean;
  owns: { tables: number; routines: number; schemas: number };
  selectColumns: Record<string, string[]>;
  writePrivileges: string[];
  executableRoutines: string[];
  mustNotRead: string[];
}

const model: PrivilegeModel = JSON.parse(
  readFileSync(join(__dirname, '../../infrastructure/database/reconciler-privilege-model.json'), 'utf8'),
) as PrivilegeModel;

beforeAll(async () => {
  await ensurePostgres();
}, 300_000);

describe('the model and the database agree, in both directions (§27)', () => {
  it('grants exactly the columns the model claims, and no column it does not', async () => {
    const { rows } = await ownerPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.column_privileges
        WHERE grantee = $1 AND privilege_type = 'SELECT' AND table_schema = 'public'
        UNION
       SELECT c.relname, a.attname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND has_table_privilege($1, c.oid, 'SELECT')`,
      [model.role],
    );
    const live: Record<string, string[]> = {};
    for (const r of rows) (live[r.table_name] ??= []).push(r.column_name);
    for (const columns of Object.values(live)) columns.sort();
    const expected: Record<string, string[]> = {};
    for (const [table, columns] of Object.entries(model.selectColumns)) expected[table] = [...columns].sort();
    expect(live).toEqual(expected);
  });

  it('holds no write privilege on any table in the database', async () => {
    const { rows } = await ownerPool().query<{ relname: string; privilege: string }>(
      `SELECT c.relname, p.privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (has_table_privilege($1, c.oid, p.privilege)
               OR (p.privilege IN ('INSERT', 'UPDATE') AND has_any_column_privilege($1, c.oid, p.privilege)))`,
      [model.role],
    );
    expect(rows.map((r) => `${r.privilege} ${r.relname}`).sort()).toEqual(model.writePrivileges);
  });

  it('may execute exactly the routines the model names (§14)', async () => {
    const { rows } = await ownerPool().query<{ signature: string }>(
      `SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS signature
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND has_function_privilege($1, p.oid, 'EXECUTE')
          -- A routine PUBLIC may already run is not a privilege this role was
          -- given. PUBLIC is not a role, so its EXECUTE is read from the ACL:
          -- a NULL proacl is the default, which grants EXECUTE to PUBLIC.
          AND p.proacl IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        ORDER BY 1`,
      [model.role],
    );
    expect(rows.map((r) => r.signature)).toEqual(model.executableRoutines);
  });

  it('has exactly the role attributes the model claims, and belongs to no other role (§5)', async () => {
    const { rows } = await ownerPool().query<Record<string, boolean>>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_roles WHERE rolname = $1`,
      [model.role],
    );
    expect(must(rows[0])).toEqual(model.attributes);

    const { rows: memberships } = await ownerPool().query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r
        WHERE r.rolname <> $1 AND pg_has_role($1, r.oid, 'MEMBER')
          AND r.rolname NOT LIKE 'pg\\_%'
        ORDER BY 1`,
      [model.role],
    );
    expect(memberships.map((m) => m.rolname)).toEqual(model.memberOf);
  });

  it('owns nothing and may create nothing (§5)', async () => {
    const { rows } = await ownerPool().query<{ tables: string; routines: string; schemas: string; temp: boolean; create_public: boolean }>(
      `SELECT (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::text AS tables,
              (SELECT count(*) FROM pg_proc p WHERE p.proowner = r.oid)::text AS routines,
              (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = r.oid)::text AS schemas,
              has_database_privilege(r.rolname, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege(r.rolname, 'public', 'CREATE') AS create_public
         FROM pg_roles r WHERE r.rolname = $1`,
      [model.role],
    );
    const row = must(rows[0]);
    expect({ tables: Number(row.tables), routines: Number(row.routines), schemas: Number(row.schemas) }).toEqual(model.owns);
    expect(row.temp).toBe(model.temporary);
    expect(row.create_public).toBe(model.createOnSchemaPublic);
  });
});

describe('no PII, no credential, no key (§13)', () => {
  it('cannot read a single column of any identity, credential, key or customer table', async () => {
    const { rows } = await ownerPool().query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($2::text[])
          AND (has_table_privilege($1, c.oid, 'SELECT') OR has_any_column_privilege($1, c.oid, 'SELECT'))`,
      [model.role, model.mustNotRead],
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  /**
   * The list above is only meaningful if its names are real. A misspelling
   * would make the assertion pass by asking about a table that does not
   * exist, which is the quietest way a security test can stop testing.
   */
  it('names only tables that exist', async () => {
    const { rows } = await ownerPool().query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [model.mustNotRead],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...model.mustNotRead].sort());
  });
});

describe('a STOLEN reconciler credential (§28)', () => {
  let stolen: Client;

  beforeAll(async () => {
    stolen = new Client({ connectionString: reconcilerDbUrl });
    await stolen.connect();
  });

  /**
   * The two cases below need at least one business to exist, and they must
   * not borrow one from whatever else ran first. Asserting on ambient data
   * makes a security test answer "the credential can read across businesses"
   * when what it actually observed was that some other suite had left rows
   * behind — and answer nothing at all, loudly, on a database another file
   * had just reset. Each case seeds its own.
   */
  const seedBusiness = async (slug: string): Promise<void> => {
    const tenantId = must((await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    await ownerPool().query(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Reconciler Fixture', $2, 'PS', 'ILS', 'Asia/Hebron')`,
      [tenantId, `${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`],
    );
  };

  const refused = async (sql: string, params: unknown[] = []): Promise<string> => {
    try {
      await stolen.query(sql, params);
      return 'ACCEPTED';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  /**
   * SAID PLAINLY, because §28 asks for honesty rather than for comfort: an
   * attacker holding this credential CAN read the ledger of every business.
   * That is what the role is for, and no amount of scoping inside the
   * application changes it. The value of the separation is everything below.
   */
  it('can, by design, read accounting data across businesses — this is stated, not hidden', async () => {
    await seedBusiness('stolen-reads');
    const { rows } = await stolen.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounting_reconcile_businesses(NULL, NULL, 1000)`);
    expect(Number(must(rows[0]).n)).toBeGreaterThan(0);
  });

  it('cannot write a single financial row', async () => {
    expect(await refused(`INSERT INTO journal_entries (id) VALUES (gen_random_uuid())`)).toMatch(/permission denied/i);
    expect(await refused(`UPDATE journal_lines SET debit_minor = 0`)).toMatch(/permission denied/i);
    expect(await refused(`DELETE FROM journal_entries`)).toMatch(/permission denied/i);
    expect(await refused(`TRUNCATE journal_lines`)).toMatch(/permission denied|must be owner/i);
    expect(await refused(`UPDATE accounts SET type = 'asset'`)).toMatch(/permission denied/i);
    expect(await refused(`UPDATE accounting_periods SET status = 'open'`)).toMatch(/permission denied/i);
  });

  it('cannot post, reverse, adjust, close a period or enter a rate', async () => {
    for (const call of [
      `SELECT accounting_post_entry(current_date, 'x', NULL, '[]'::jsonb)`,
      `SELECT accounting_post_manual_adjustment(current_date, 'x', 'y', NULL, '[]'::jsonb)`,
      `SELECT accounting_post_reversal(gen_random_uuid(), current_date, 'x', NULL)`,
      `SELECT accounting_period_close(gen_random_uuid())`,
      `SELECT accounting_fx_rate_enter('USD', 'ILS', current_date, 1, 'manual')`,
      `SELECT accounting_assertion_key_install('k', '\\x00'::bytea)`,
    ]) {
      expect(await refused(call), call).toMatch(/permission denied|does not exist/i);
    }
  });

  it('cannot read identity, credentials or key material', async () => {
    for (const table of ['users', 'sessions', 'password_reset_tokens', 'credential_deliveries', 'accounting_assertion_keys', 'provisioning_assertion_keys']) {
      expect(await refused(`SELECT * FROM ${table} LIMIT 1`), table).toMatch(/permission denied/i);
    }
  });

  it('cannot read the columns of businesses that identify the merchant', async () => {
    // The four columns it holds are structural. Everything that makes a
    // business a recognisable party — its name, its slug, its contact — is
    // refused at the column, not filtered in the application.
    expect(await refused(`SELECT name FROM businesses`)).toMatch(/permission denied/i);
    expect(await refused(`SELECT * FROM businesses`)).toMatch(/permission denied/i);
    const { rows } = await stolen.query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses`);
    // And with no tenant context, row level security answers nothing at all:
    // the grant is not the whole gate.
    expect(must(rows[0]).n).toBe('0');
  });

  it('cannot buy an exemption with a GUC, a role change or a temp table', async () => {
    await stolen.query(`SELECT set_config('app.bypass_rls', 'true', false)`);
    const { rows } = await stolen.query<{ bypass: boolean; n: string }>(`SELECT app_bypass() AS bypass, (SELECT count(*)::text FROM businesses) AS n`);
    expect(must(rows[0]).bypass).toBe(false);
    expect(must(rows[0]).n).toBe('0');
    expect(await refused(`SET ROLE daftar_platform`)).toMatch(/permission denied|must be (a )?member/i);
    expect(await refused(`SET ROLE daftar_accounting_internal`)).toMatch(/permission denied|must be (a )?member/i);
    expect(await refused(`CREATE TEMP TABLE t (x int)`)).toMatch(/permission denied/i);
    expect(await refused(`CREATE TABLE public.t (x int)`)).toMatch(/permission denied/i);
  });

  it('cannot turn the enumerator into a query tunnel', async () => {
    // It takes a cursor and a limit. There is no predicate, no expression and
    // no table name to supply, so there is nothing to bend.
    const { rows } = await ownerPool().query<{ args: string }>(
      `SELECT oidvectortypes(p.proargtypes) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'accounting_reconcile_businesses'`,
    );
    expect(must(rows[0]).args).toBe('uuid, uuid, integer');
    await seedBusiness('stolen-tunnel');
    const bounded = await stolen.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounting_reconcile_businesses(NULL, NULL, 100000)`);
    const all = await stolen.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounting_reconcile_businesses(NULL, NULL, NULL)`);
    // A caller-supplied limit cannot exceed the routine's own ceiling, so an
    // enormous ask is not a way to make the database do unbounded work.
    expect(Number(must(bounded.rows[0]).n)).toBeLessThanOrEqual(1000);
    expect(Number(must(all.rows[0]).n)).toBeGreaterThan(0);
  });
});
