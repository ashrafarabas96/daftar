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

  it('the platform grant shape matches the documented intent exactly', async () => {
    const { rows } = await ownerPool().query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'accounts' AND grantee LIKE 'daftar_%'
       ORDER BY grantee, privilege_type`,
    );
    const shape: Record<string, string[]> = {};
    for (const r of rows) (shape[r.grantee] ??= []).push(r.privilege_type);
    // daftar_app reads only; daftar_platform reads and may INSERT, which is
    // what the SECURITY DEFINER seeding routine runs as. No role anywhere
    // holds UPDATE or DELETE on the chart.
    expect(shape).toEqual({ daftar_app: ['SELECT'], daftar_platform: ['INSERT', 'SELECT'] });

    const { rows: registry } = await ownerPool().query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'accounting_system_account_keys' AND grantee LIKE 'daftar_%'
       ORDER BY grantee, privilege_type`,
    );
    expect(registry.map((r) => `${r.grantee}:${r.privilege_type}`)).toEqual(['daftar_app:SELECT', 'daftar_platform:SELECT']);
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

  it('P2-S1 has shipped no journal, no bindings and no posting primitive', async () => {
    const { rows: tables } = await ownerPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('journal_entries','journal_lines','accounting_source_bindings','accounting_source_types')`,
    );
    expect(tables).toEqual([]);
    const { rows: fns } = await ownerPool().query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proname = 'accounting_post_entry'`);
    expect(fns).toEqual([]);
  });
});
