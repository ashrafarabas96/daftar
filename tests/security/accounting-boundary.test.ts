import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  appDbUrl,
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
 * P2-S1 — accounting privilege boundary (directive §22).
 *
 * Executed with raw connections as each runtime role. A denial proven here is
 * a denial in production: none of these paths goes through the API. Default
 * deny is the claim, and the claim is tested, not assumed.
 */
describe('accounting chart privilege boundary', () => {
  let tenantId = '';
  let businessA = '';
  let businessB = '';

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    const t = (await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
    if (!t) throw new Error('tenant fixture insert failed');
    tenantId = t.id;
    const { rows } = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Acc A', 'acc-sec-a', 'PS', 'ILS', 'Asia/Hebron'), ($1, 'Acc B', 'acc-sec-b', 'PS', 'ILS', 'Asia/Hebron')
       RETURNING id`,
      [tenantId],
    );
    const a = rows[0];
    const b = rows[1];
    if (!a || !b) throw new Error('business fixture insert failed');
    businessA = a.id;
    businessB = b.id;
  });

  async function as(url: string, fn: (c: Client) => Promise<void>): Promise<void> {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  }

  // The six — and only six — roles a credential can exist for.
  const LOGIN_ROLES: ReadonlyArray<readonly [string, string]> = [
    ['daftar_app', appDbUrl],
    ['daftar_platform', platformDbUrl],
    ['daftar_worker', workerDbUrl],
    ['daftar_resolver', resolverDbUrl],
    ['daftar_identity', identityDbUrl],
    ['daftar_provisioner', provisionerDbUrl],
  ];

  const scoped = async (c: Client, businessId: string): Promise<void> => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessId]);
  };

  it('daftar_app scoped to business A cannot see business B accounts', async () => {
    await as(appDbUrl, async (c) => {
      await scoped(c, businessA);
      const mine = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
      expect(mine.rows[0]?.n).toBe(21);
      const theirs = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [businessB]);
      expect(theirs.rows[0]?.n).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('daftar_app with NO business scope sees zero accounts (default deny)', async () => {
    await as(appDbUrl, async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
      expect(rows[0]?.n).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('daftar_app cannot INSERT, UPDATE or DELETE accounts — P2-S1 exposes no chart mutation', async () => {
    await as(appDbUrl, async (c) => {
      for (const sql of [
        `INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ('${tenantId}', '${businessA}', 'X1', 'x', 'asset')`,
        `UPDATE accounts SET name = 'pwned'`,
        `DELETE FROM accounts`,
      ]) {
        await scoped(c, businessA);
        await expect(c.query(sql)).rejects.toThrow(/permission denied/i);
        await c.query('ROLLBACK');
      }
    });
  });

  it('daftar_app cannot write the system account key registry', async () => {
    await as(appDbUrl, async (c) => {
      const read = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_system_account_keys`);
      expect(read.rows[0]?.n).toBe(21);
      for (const sql of [
        `INSERT INTO accounting_system_account_keys (system_key, account_type, default_code, seed_name, sort_order) VALUES ('pwned','asset','9999','x',99)`,
        `UPDATE accounting_system_account_keys SET account_type = 'liability'`,
        `DELETE FROM accounting_system_account_keys`,
      ]) {
        await expect(c.query(sql)).rejects.toThrow(/permission denied/i);
      }
    });
  });

  it('daftar_app cannot execute the chart seeding routine', async () => {
    await as(appDbUrl, async (c) => {
      await expect(c.query(`SELECT accounting_seed_chart($1)`, [businessA])).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity, resolver, provisioner and worker have NO access to accounting data at all', async () => {
    for (const url of [identityDbUrl, resolverDbUrl, provisionerDbUrl, workerDbUrl]) {
      await as(url, async (c) => {
        for (const sql of [
          `SELECT count(*) FROM accounts`,
          `INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ('${tenantId}', '${businessA}', 'X2', 'x', 'asset')`,
          `UPDATE accounts SET name = 'pwned'`,
          `DELETE FROM accounts`,
        ]) {
          await c.query('BEGIN');
          await expect(c.query(sql)).rejects.toThrow(/permission denied/i);
          await c.query('ROLLBACK');
        }
        await expect(c.query(`SELECT accounting_seed_chart($1)`, [businessA])).rejects.toThrow(/permission denied/i);
      });
    }
  });

  it('the chart grant shape gives NO login role any DML — INSERT lives on the internal principal', async () => {
    const { rows } = await ownerPool().query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'accounts' AND grantee LIKE 'daftar_%'
       ORDER BY grantee, privilege_type`,
    );
    const shape: Record<string, string[]> = {};
    for (const r of rows) (shape[r.grantee] ??= []).push(r.privilege_type);
    // The whole authority contract in one assertion: the two login roles that
    // can see the chart can ONLY see it. The single INSERT in the system
    // belongs to daftar_accounting_internal, which is NOLOGIN — so that
    // privilege is reachable only from inside the routine that role owns.
    // Nobody, internal principal included, holds UPDATE or DELETE.
    expect(shape).toEqual({
      daftar_accounting_internal: ['INSERT', 'SELECT'],
      daftar_app: ['SELECT'],
      daftar_platform: ['SELECT'],
    });

    const { rows: registry } = await ownerPool().query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'accounting_system_account_keys' AND grantee LIKE 'daftar_%'
       ORDER BY grantee, privilege_type`,
    );
    expect(registry.map((r) => `${r.grantee}:${r.privilege_type}`)).toEqual([
      'daftar_accounting_internal:SELECT',
      'daftar_app:SELECT',
      'daftar_platform:SELECT',
    ]);
  });

  it('every one of the six login roles is denied INSERT, UPDATE and DELETE on the chart', async () => {
    for (const [name, url] of LOGIN_ROLES) {
      await as(url, async (c) => {
        for (const sql of [
          `INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ('${tenantId}', '${businessA}', 'X9', 'x', 'asset')`,
          `UPDATE accounts SET name = 'pwned'`,
          `DELETE FROM accounts`,
        ]) {
          await c.query('BEGIN');
          await expect(c.query(sql), `${name} must be denied: ${sql}`).rejects.toThrow(/permission denied/i);
          await c.query('ROLLBACK');
        }
      });
    }
  });

  it('every one of the six login roles is denied EXECUTE on both seeding routines', async () => {
    for (const [name, url] of LOGIN_ROLES) {
      await as(url, async (c) => {
        await expect(c.query(`SELECT accounting_seed_chart($1)`, [businessA]), `${name} must not seed`).rejects.toThrow(/permission denied/i);
        await expect(c.query(`SELECT accounting_seed_chart_trg()`), `${name} must not call the trigger routine`).rejects.toThrow(/permission denied/i);
      });
    }
  });

  it('both seeding routines are owned by the internal principal, and PUBLIC holds no EXECUTE', async () => {
    const { rows } = await ownerPool().query<{ proname: string; owner: string; owner_can_login: boolean; acl: string | null }>(
      `SELECT p.proname, r.rolname AS owner, r.rolcanlogin AS owner_can_login, array_to_string(p.proacl, ',') AS acl
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('accounting_seed_chart', 'accounting_seed_chart_trg')
        ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['accounting_seed_chart', 'accounting_seed_chart_trg']);
    for (const r of rows) {
      expect(r.owner).toBe('daftar_accounting_internal');
      // The owner of a SECURITY DEFINER function IS its authority. If that
      // owner could log in, the authority would have a credential.
      expect(r.owner_can_login).toBe(false);
      // REVOKE ALL FROM PUBLIC leaves an explicit ACL with no `=X/` entry.
      expect(r.acl ?? '').not.toMatch(/(^|,)=[^/]*X/);
      for (const [login] of LOGIN_ROLES) {
        expect(r.acl ?? '', `${login} must hold no EXECUTE on ${r.proname}`).not.toContain(`${login}=`);
      }
    }
  });

  it('daftar_accounting_internal is an unreachable principal, not a seventh runtime login', async () => {
    const { rows } = await ownerPool().query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      has_password: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit,
              (rolpassword IS NOT NULL) AS has_password
         FROM pg_authid WHERE rolname = 'daftar_accounting_internal'`,
    );
    // Inspected through the catalogues. We never connect as this role, because
    // connecting as it is exactly what must be impossible.
    expect(rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: false,
      has_password: false,
    });

    // Its ONLY member is the deployment migrator, and that membership does not
    // inherit: it has to be assumed deliberately, which no runtime can do
    // because no runtime holds that credential. PostgreSQL will not let a
    // non-superuser hand a function to an owner it cannot SET ROLE to, so this
    // one membership is what keeps DAFTAR migratable without a superuser.
    const { rows: members } = await ownerPool().query<{ member: string; inherit_option: boolean; set_option: boolean; admin_option: boolean }>(
      `SELECT m.rolname AS member, a.inherit_option, a.set_option, a.admin_option
         FROM pg_auth_members a
         JOIN pg_roles g ON g.oid = a.roleid
         JOIN pg_roles m ON m.oid = a.member
        WHERE g.rolname = 'daftar_accounting_internal' ORDER BY m.rolname`,
    );
    expect(members).toEqual([{ member: 'daftar_migrator', inherit_option: false, set_option: true, admin_option: false }]);
    for (const [login] of LOGIN_ROLES) expect(members.map((m) => m.member)).not.toContain(login);

    // The CREATE that migration 0040 needs for the ownership transfer was
    // handed back in the same file. A lingering CREATE is not a temporary one.
    const { rows: create } = await ownerPool().query<{ can_create: boolean }>(
      `SELECT has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') AS can_create`,
    );
    expect(create[0]?.can_create).toBe(false);

    // It was never granted CONNECT either. (PostgreSQL still hands CONNECT to
    // PUBLIC by default, so that is not the barrier — NOLOGIN above is; this
    // asserts we did not go on to name it alongside the six runtime logins.)
    const { rows: acl } = await ownerPool().query<{ datacl: string | null }>(
      `SELECT array_to_string(datacl, ',') AS datacl FROM pg_database WHERE datname = current_database()`,
    );
    expect(acl[0]?.datacl ?? '').not.toContain('daftar_accounting_internal=');
  });

  it('no login role gained a bypass: app_bypass() is untouched and BYPASSRLS is held by nobody', async () => {
    const { rows } = await ownerPool().query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'daftar_%' AND rolbypassrls ORDER BY rolname`,
    );
    expect(rows).toEqual([]);

    // The seeder policies admit ONE identity. A login role that reaches them
    // would be a business-isolation hole, so assert the literal.
    const { rows: pol } = await ownerPool().query<{ polname: string; qual: string | null }>(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy
        WHERE polname IN ('accounting_seeder', 'accounting_seeder_read') ORDER BY polname`,
    );
    expect(pol.map((p) => p.polname)).toEqual(['accounting_seeder', 'accounting_seeder_read']);
    for (const p of pol) {
      expect(p.qual ?? '').toContain(`'daftar_accounting_internal'`);
      for (const [login] of LOGIN_ROLES) expect(p.qual ?? '').not.toContain(login);
    }
  });

  it('the platform role is a reader of the chart, nothing more', async () => {
    await as(platformDbUrl, async (c) => {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`);
      expect(rows[0]?.n).toBe(42);
      await expect(
        c.query(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1, $2, 'X3', 'x', 'asset')`, [tenantId, businessA]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('even the platform role cannot rewrite or delete a system account', async () => {
    await as(platformDbUrl, async (c) => {
      await expect(c.query(`UPDATE accounts SET name = 'pwned' WHERE system_key = 'cash'`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`DELETE FROM accounts WHERE system_key = 'cash'`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('RLS on accounts is enabled AND forced', async () => {
    const { rows } = await ownerPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'accounts'`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('daftar_app cannot disable RLS or drop the isolation policy on accounts', async () => {
    await as(appDbUrl, async (c) => {
      await expect(c.query('ALTER TABLE accounts DISABLE ROW LEVEL SECURITY')).rejects.toThrow();
      await expect(c.query('ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY')).rejects.toThrow();
      await expect(c.query('DROP POLICY business_isolation ON accounts')).rejects.toThrow();
      await expect(c.query('CREATE POLICY pwned ON accounts USING (true)')).rejects.toThrow();
    });
  });

  /**
   * P2-S1 is frozen, so this claim is now about what the CHART slice shipped,
   * not about what the repository contains. P2-S2 legitimately creates the
   * journal; asserting its absence here would make an accepted slice's
   * regression gate block every slice that follows it (freeze directive §7).
   *
   * What stays true forever, and is what the chart slice actually promised:
   * `0040` and `0041` created no journal surface and no posting primitive of
   * their own. The same reasoning applies a second time now that P2-S3 has
   * shipped `accounting_post_entry` and `accounting_actor`: asking the LIVE
   * database whether a posting primitive exists made this permanent gate fail
   * the moment an authorized later slice created one, which is precisely the
   * failure mode the paragraph above exists to prevent. The question is about
   * two frozen files, so it is asked of their text.
   */
  it('the accepted P2-S1 migrations shipped no journal surface and no posting primitive', () => {
    const s1Sql = ['0040_accounting_chart.sql', '0041_accounting_permissions.sql']
      .map((f) => readFileSync(join(__dirname, '../../infrastructure/database/migrations', f), 'utf8'))
      .join('\n');
    for (const surface of ['journal_entries', 'journal_lines', 'accounting_source_bindings', 'accounting_source_types', 'accounting_system_actors']) {
      expect(s1Sql, surface).not.toMatch(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i'));
    }
    for (const routine of ['accounting_post_entry', 'accounting_actor', 'accounting_canonical_line', 'accounting_fingerprint']) {
      expect(s1Sql, routine).not.toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${routine}\\b`, 'i'));
    }
  });
});
