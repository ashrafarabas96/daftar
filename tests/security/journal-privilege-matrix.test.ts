import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTING_REGISTRY_TABLES,
  ACCOUNTING_ROUTINES,
  INTENDED_TABLE_GRANTS,
  INTERNAL_ROLE,
  JOURNAL_TABLES,
  REQUIRED_P2_S3_SURFACES,
  RUNTIME_CALLABLE_ROUTINES,
  RUNTIME_ROLES,
  WATCHED_TABLES,
  compareTableGrants,
  type LiveTableGrant,
} from '../../scripts/guards/journal-privilege-model';
import {
  appDbUrl,
  dbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';

/**
 * MATRIX 1 — PRIVILEGE BOUNDARY, and guard G-1.
 *
 * Two different things are proved here, and neither replaces the other.
 *
 * G-1 reads the LIVE PostgreSQL grant catalogue and compares it, as a set,
 * against the intended model in `scripts/guards/journal-privilege-model.ts`.
 * That is what catches the grant nobody wrote a test for: a migration adding
 * `GRANT INSERT ON journal_lines TO daftar_worker` next year would sail past
 * every hand-written negative case below, and fail here.
 *
 * Matrix 1 then attempts the writes for real, as each runtime credential, so
 * the grant shape is proved to be ENFORCED and not merely recorded.
 *
 * `information_schema.role_table_grants` is read because the directive names
 * it; `pg_class.relacl` through `aclexplode()` is read alongside it because
 * that view is filtered to grants involving an enabled role, and a privilege
 * check that another session's role membership can narrow is not a check.
 * The two must agree.
 */

const ROLE_URLS: Readonly<Record<string, string>> = {
  daftar_app: appDbUrl,
  daftar_platform: platformDbUrl,
  daftar_worker: workerDbUrl,
  daftar_identity: identityDbUrl,
  daftar_resolver: resolverDbUrl,
  daftar_provisioner: provisionerDbUrl,
};

const ALL_TABLES = [...WATCHED_TABLES];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
});

afterAll(async () => {
  await resetData();
});

describe('G-1 — the live grant catalogue equals the intended model', () => {
  it('information_schema.role_table_grants matches the intended accounting grant matrix exactly', async () => {
    const { rows } = await ownerPool().query<LiveTableGrant>(
      `SELECT g.table_name AS table, g.grantee AS grantee, g.privilege_type AS privilege
         FROM information_schema.role_table_grants g
         JOIN pg_tables t ON t.schemaname = g.table_schema AND t.tablename = g.table_name
        WHERE g.table_schema = 'public'
          AND g.table_name = ANY($1::text[])
          AND g.grantee <> t.tableowner`,
      [ALL_TABLES],
    );
    expect(compareTableGrants(rows)).toEqual([]);
  });

  it('pg_class.relacl agrees — the unfiltered catalogue holds no grant the view hides', async () => {
    const { rows } = await ownerPool().query<LiveTableGrant>(
      `SELECT c.relname AS table, coalesce(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND a.grantee <> c.relowner`,
      [ALL_TABLES],
    );
    expect(compareTableGrants(rows)).toEqual([]);
  });

  it('the model says what the slices promised: read for three runtimes, INSERT for one unreachable writer', () => {
    for (const table of JOURNAL_TABLES) {
      expect(Object.keys(INTENDED_TABLE_GRANTS[table] ?? {}).sort()).toEqual(['daftar_accounting_internal', 'daftar_app', 'daftar_platform', 'daftar_worker']);
      for (const [grantee, privileges] of Object.entries(INTENDED_TABLE_GRANTS[table] ?? {})) {
        expect(privileges, grantee).toEqual(grantee === INTERNAL_ROLE ? ['INSERT', 'SELECT'] : ['SELECT']);
      }
    }
    // The registries stay closed to every runtime; the primitive reads the
    // date policy out of one of them, so the writer alone may SELECT it.
    for (const table of ACCOUNTING_REGISTRY_TABLES) {
      expect(
        Object.keys(INTENDED_TABLE_GRANTS[table] ?? {}).filter((g) => g !== INTERNAL_ROLE),
        table,
      ).toEqual([]);
    }
  });

  // The tamper fixtures start from the model itself, so adding a legitimate
  // grant next slice does not turn every negative case red for the wrong
  // reason — what each case proves is the DIFFERENCE it introduces.
  const modelled = (): LiveTableGrant[] =>
    Object.entries(INTENDED_TABLE_GRANTS).flatMap(([table, grants]) =>
      Object.entries(grants).flatMap(([grantee, privileges]) => privileges.map((privilege) => ({ table, grantee, privilege }))),
    );

  it('G-1 detects a grant that no hand-written negative test would have covered', () => {
    // The whole point of the guard, exercised: a future migration hands the
    // worker INSERT on the journal, and nobody remembers to add a test.
    const violations = compareTableGrants([...modelled(), { table: 'journal_lines', grantee: 'daftar_worker', privilege: 'INSERT' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/daftar_worker holds INSERT on journal_lines .*RUNTIME principal must never hold journal DML/);
  });

  it('G-1 detects the posting authority being handed more than INSERT', () => {
    const violations = compareTableGrants([...modelled(), { table: 'journal_entries', grantee: INTERNAL_ROLE, privilege: 'UPDATE' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/may INSERT and must never be able to rewrite or destroy posted truth/);
  });

  it('G-1 also detects a read that quietly went missing', () => {
    const narrowed = modelled().filter((g) => !(g.table === 'journal_entries' && g.grantee === 'daftar_worker'));
    expect(compareTableGrants(narrowed)).toEqual([
      'the intended grant "daftar_worker SELECT ON journal_entries" is missing — the accounting grant model and the live database disagree',
    ]);
  });

  it('G-1 detects a reference registry that was opened up', () => {
    expect(compareTableGrants([...modelled(), { table: 'accounting_source_types', grantee: 'PUBLIC', privilege: 'SELECT' }])).toEqual([
      'PUBLIC holds SELECT on accounting_source_types, which the intended accounting grant model does not include',
    ]);
  });

  it('G-1 watches the assertion key domain too — no runtime role may read a secret', () => {
    expect(compareTableGrants([...modelled(), { table: 'accounting_assertion_keys', grantee: 'daftar_app', privilege: 'SELECT' }]).join(' ')).toMatch(
      /daftar_app holds SELECT on accounting_assertion_keys/,
    );
  });
});

describe('Matrix 1 — every runtime role, attempted for real', () => {
  const WRITES = [
    { verb: 'INSERT', sql: (t: string) => `INSERT INTO ${t} DEFAULT VALUES` },
    { verb: 'UPDATE', sql: (t: string) => `UPDATE ${t} SET tenant_id = tenant_id` },
    { verb: 'DELETE', sql: (t: string) => `DELETE FROM ${t}` },
  ] as const;

  for (const role of RUNTIME_ROLES) {
    for (const table of JOURNAL_TABLES) {
      for (const write of WRITES) {
        it(`${role} cannot ${write.verb} ${table}`, async () => {
          const client = new Client({ connectionString: ROLE_URLS[role] });
          await client.connect();
          try {
            await expect(client.query(write.sql(table))).rejects.toThrow(/permission denied for table/);
          } finally {
            await client.end();
          }
        });
      }
    }
  }

  const READERS = ['daftar_app', 'daftar_platform', 'daftar_worker'] as const;
  const NON_READERS = ['daftar_identity', 'daftar_resolver', 'daftar_provisioner'] as const;

  for (const role of READERS) {
    it(`${role} CAN read the journal — the intended visibility, proved rather than assumed`, async () => {
      const client = new Client({ connectionString: ROLE_URLS[role] });
      await client.connect();
      try {
        for (const table of JOURNAL_TABLES) await expect(client.query(`SELECT count(*) FROM ${table}`)).resolves.toBeTruthy();
      } finally {
        await client.end();
      }
    });
  }

  for (const role of NON_READERS) {
    it(`${role} has no journal access at all`, async () => {
      const client = new Client({ connectionString: ROLE_URLS[role] });
      await client.connect();
      try {
        for (const table of JOURNAL_TABLES) await expect(client.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(/permission denied for table/);
      } finally {
        await client.end();
      }
    });
  }

  it('no runtime role can read either reference registry — default deny', async () => {
    for (const role of RUNTIME_ROLES) {
      const client = new Client({ connectionString: ROLE_URLS[role] });
      await client.connect();
      try {
        for (const table of ACCOUNTING_REGISTRY_TABLES) {
          await expect(client.query(`SELECT count(*) FROM ${table}`), `${role} on ${table}`).rejects.toThrow(/permission denied for table/);
        }
      } finally {
        await client.end();
      }
    }
  });

  it('no runtime role can TRUNCATE the journal', async () => {
    const { rows } = await ownerPool().query<{ role: string; table: string; t: boolean }>(
      `SELECT r.rolname AS role, t.tablename AS table, has_table_privilege(r.rolname, t.tablename, 'TRUNCATE') AS t
         FROM unnest($1::text[]) AS r(rolname) CROSS JOIN unnest($2::text[]) AS t(tablename)`,
      [RUNTIME_ROLES, JOURNAL_TABLES],
    );
    expect(rows.filter((r) => r.t)).toEqual([]);
  });
});

describe('the accounting routine surface — exactly one runtime entry point (§68)', () => {
  it('no internal accounting routine is callable by a runtime role or by PUBLIC', async () => {
    const { rows } = await ownerPool().query<{ proname: string; grantee: string }>(
      `SELECT p.proname, coalesce(r.rolname, 'PUBLIC') AS grantee
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) AND a.grantee <> p.proowner`,
      [ACCOUNTING_ROUTINES],
    );
    expect(rows).toEqual([]);
  });

  it('every CALLABLE accounting routine a runtime role can execute is one the model names, and no other', async () => {
    // Trigger functions are excluded, and deliberately so rather than by
    // oversight: PostgreSQL refuses to invoke a `RETURNS trigger` routine
    // outside a trigger ("trigger functions can only be called as triggers"),
    // so EXECUTE on one confers nothing. What this asserts is the surface a
    // credential can actually call — which must be the posting primitive for
    // the merchant runtime, the two key commands for the platform, and
    // nothing else at all.
    const { rows } = await ownerPool().query<{ proname: string; grantee: string }>(
      `SELECT p.proname, r.rolname AS grantee
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN unnest($1::text[]) AS r(rolname)
        WHERE n.nspname = 'public'
          AND p.proname LIKE 'accounting%'
          AND p.prorettype <> 'trigger'::regtype
          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
        ORDER BY p.proname, r.rolname`,
      [RUNTIME_ROLES],
    );
    const actual = new Map<string, string[]>();
    for (const row of rows) actual.set(row.proname, [...(actual.get(row.proname) ?? []), row.grantee]);
    expect(Object.fromEntries([...actual].map(([k, v]) => [k, v.sort()]))).toEqual(RUNTIME_CALLABLE_ROUTINES);
  });

  it('the P2-S3 surfaces all exist — the writer is not half-installed', async () => {
    const { rows } = await ownerPool().query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       UNION
       SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [REQUIRED_P2_S3_SURFACES],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...REQUIRED_P2_S3_SURFACES].sort());
  });

  it('no ledger write routine slipped in under another name', async () => {
    // Anything that both names the journal and writes to it is a writer,
    // whatever it is called. The list is asserted EXACTLY, from pg_proc's own
    // source text, so a third writer added by a future slice fails here on the
    // day it is written.
    //
    // P2-S4 added the second one deliberately: a reversal must succeed against
    // an account that has since been deactivated, and the frozen primitive
    // refuses one. Guard G-4 was widened in the same slice, from "protect
    // accounting_post_entry" to "protect every routine capable of a journal
    // write", so this list growing is not the protection weakening.
    const { rows } = await ownerPool().query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosrc ~* '(insert|update|delete)[[:space:]]+(into[[:space:]]+)?(journal_entries|journal_lines|accounting_source_bindings)'
        ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['accounting_post_entry', 'accounting_post_reversal']);
  });
});

describe('RLS is real on the ledger', () => {
  it('all three business-scoped tables ENABLE and FORCE row level security', async () => {
    const { rows } = await ownerPool().query<{ relname: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [JOURNAL_TABLES],
    );
    expect(rows).toEqual([
      { relname: 'accounting_source_bindings', enabled: true, forced: true },
      { relname: 'journal_entries', enabled: true, forced: true },
      { relname: 'journal_lines', enabled: true, forced: true },
    ]);
  });

  it('the validator policy admits ONE identity, it is not a login role, and it is read-only', async () => {
    const { rows } = await ownerPool().query<{ tablename: string; cmd: string; qual: string; withcheck: string | null }>(
      `SELECT tablename, cmd, qual, with_check AS withcheck FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'accounting_validator' ORDER BY tablename`,
    );
    // Three journal tables plus the two P2-S4 detail tables. The count is
    // asserted so a policy appearing on a table nobody reviewed fails here.
    expect(rows.map((r) => r.tablename)).toEqual([
      'accounting_manual_adjustments',
      'accounting_reversals',
      'accounting_source_bindings',
      'journal_entries',
      'journal_lines',
    ]);
    for (const row of rows) {
      expect(row.cmd).toBe('SELECT');
      expect(row.qual).toMatch(/daftar_accounting_internal/);
      expect(row.withcheck).toBeNull();
    }
    const { rows: role } = await ownerPool().query<{ login: boolean; bypass: boolean }>(
      `SELECT rolcanlogin AS login, rolbypassrls AS bypass FROM pg_roles WHERE rolname = 'daftar_accounting_internal'`,
    );
    expect(role[0]).toEqual({ login: false, bypass: false });
  });

  it('app_bypass() is still only the platform principal — P2-S2 did not widen it', async () => {
    const { rows } = await ownerPool().query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'app_bypass'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.src).toMatch(/daftar_platform/);
    expect(rows[0]?.src).not.toMatch(/daftar_accounting_internal|daftar_app|daftar_worker/);
  });

  it('a tenant-scoped session sees only its own business, and nothing at all without a scope', async () => {
    const pool = ownerPool();
    const made: { tenant: string; business: string }[] = [];
    for (const slug of ['rls-journal-one', 'rls-journal-two']) {
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const business = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1,$2,$2,'PS','ILS','Asia/Hebron') RETURNING id`,
          [tenant?.id, slug],
        )
      ).rows[0];
      made.push({ tenant: tenant?.id ?? '', business: business?.id ?? '' });
    }
    const user = (
      await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ('rls-journal@test.dev','x','RLS') RETURNING id`)
    ).rows[0];

    // Two entries, one per business, written by the schema owner.
    const owner = new Client({ connectionString: dbUrl });
    await owner.connect();
    try {
      for (const m of made) {
        await owner.query('BEGIN');
        const entry = (
          await owner.query<{ id: string }>(
            `INSERT INTO journal_entries (tenant_id, business_id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
             VALUES ($1,$2,'2026-09-05','manual_adjustment',gen_random_uuid(),'user',$3,$4) RETURNING id, source_id`,
            [m.tenant, m.business, user?.id, 'b'.repeat(64)],
          )
        ).rows[0];
        const accounts = (
          await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 AND system_key IN ('cash','sales_revenue') ORDER BY system_key`, [
            m.business,
          ])
        ).rows;
        const insertLine = `INSERT INTO journal_lines
          (tenant_id, business_id, journal_entry_id, line_no, account_id, debit_minor, credit_minor, base_amount_minor,
           base_currency, txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ILS','ILS',$8,1,'base',date_trunc('second', now()))`;
        await owner.query(insertLine, [m.tenant, m.business, entry?.id, 1, accounts[0]?.id, 1000, 0, 1000]);
        await owner.query(insertLine, [m.tenant, m.business, entry?.id, 2, accounts[1]?.id, 0, 1000, 1000]);
        await owner.query(
          // Scoped by (business_id, id): an entry's identity is the pair, and
          // the UUID alone may legitimately belong to another business (§9).
          `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
           SELECT tenant_id, business_id, source_type, source_id, id FROM journal_entries WHERE business_id = $1 AND id = $2`,
          [m.business, entry?.id],
        );
        await owner.query('COMMIT');
      }
    } finally {
      await owner.end();
    }

    const app = new Client({ connectionString: appDbUrl });
    await app.connect();
    try {
      // No scope set: RLS shows nothing, even though SELECT is granted.
      expect((await app.query<{ n: string }>(`SELECT count(*) AS n FROM journal_entries`)).rows[0]?.n).toBe('0');

      const first = made[0];
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [first?.tenant, first?.business]);
      const visible = (await app.query<{ business_id: string }>(`SELECT business_id FROM journal_entries`)).rows;
      expect(visible).toHaveLength(1);
      expect(visible[0]?.business_id).toBe(first?.business);
      await app.query('COMMIT');
    } finally {
      await app.end();
    }
  });
});
