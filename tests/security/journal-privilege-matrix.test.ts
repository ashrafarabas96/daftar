import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTING_REGISTRY_TABLES,
  ACCOUNTING_ROUTINES,
  FORBIDDEN_P2_S3_SURFACES,
  INTENDED_TABLE_GRANTS,
  JOURNAL_TABLES,
  RUNTIME_ROLES,
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

const ALL_TABLES = [...JOURNAL_TABLES, ...ACCOUNTING_REGISTRY_TABLES];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
});

afterAll(async () => {
  await resetData();
});

describe('G-1 — the live grant catalogue equals the intended model', () => {
  it('information_schema.role_table_grants matches the intended P2-S2 matrix exactly', async () => {
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

  it('the model itself says what P2-S2 promised: read for three runtimes, write for nobody', () => {
    for (const table of JOURNAL_TABLES) {
      expect(Object.keys(INTENDED_TABLE_GRANTS[table] ?? {}).sort()).toEqual(['daftar_accounting_internal', 'daftar_app', 'daftar_platform', 'daftar_worker']);
      for (const privileges of Object.values(INTENDED_TABLE_GRANTS[table] ?? {})) expect(privileges).toEqual(['SELECT']);
    }
    for (const table of ACCOUNTING_REGISTRY_TABLES) expect(INTENDED_TABLE_GRANTS[table]).toEqual({});
  });

  it('G-1 detects a grant that no hand-written negative test would have covered', () => {
    // The whole point of the guard, exercised: a future migration hands the
    // worker INSERT on the journal, and nobody remembers to add a test.
    const tampered: LiveTableGrant[] = [
      ...JOURNAL_TABLES.flatMap((table) =>
        ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_accounting_internal'].map((grantee) => ({ table, grantee, privilege: 'SELECT' })),
      ),
      { table: 'journal_lines', grantee: 'daftar_worker', privilege: 'INSERT' },
    ];
    const violations = compareTableGrants(tampered);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/daftar_worker holds INSERT on journal_lines .*NO writer/);
  });

  it('G-1 also detects a read that quietly went missing', () => {
    const narrowed: LiveTableGrant[] = JOURNAL_TABLES.flatMap((table) =>
      ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_accounting_internal']
        .filter((grantee) => !(table === 'journal_entries' && grantee === 'daftar_worker'))
        .map((grantee) => ({ table, grantee, privilege: 'SELECT' })),
    );
    expect(compareTableGrants(narrowed)).toEqual([
      'the intended grant "daftar_worker SELECT ON journal_entries" is missing — the ledger is less readable than P2-S2 specifies',
    ]);
  });

  it('G-1 detects a reference registry that was opened up', () => {
    const opened: LiveTableGrant[] = [
      ...JOURNAL_TABLES.flatMap((table) =>
        ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_accounting_internal'].map((grantee) => ({ table, grantee, privilege: 'SELECT' })),
      ),
      { table: 'accounting_source_types', grantee: 'PUBLIC', privilege: 'SELECT' },
    ];
    expect(compareTableGrants(opened)).toEqual(['PUBLIC holds SELECT on accounting_source_types, which the intended P2-S2 grant model does not include']);
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

describe('§40 — P2-S2 contains no writer and no assertion machinery', () => {
  it('no routine P2-S2 added is callable by a runtime role or by PUBLIC', async () => {
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

  it('the P2-S3 surfaces do not exist yet', async () => {
    const { rows } = await ownerPool().query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
       UNION ALL
       SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [FORBIDDEN_P2_S3_SURFACES],
    );
    expect(rows).toEqual([]);
  });

  it('no generic ledger write routine slipped in under another name', async () => {
    // Anything that both names the journal and writes to it would be a writer
    // whatever it is called. Read from pg_proc's own source text.
    const { rows } = await ownerPool().query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosrc ~* '(insert|update|delete)[[:space:]]+(into[[:space:]]+)?(journal_entries|journal_lines|accounting_source_bindings)'`,
    );
    expect(rows).toEqual([]);
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
    expect(rows).toHaveLength(3);
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
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ILS','ILS',$8,1,'base',now())`;
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
