import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';

/**
 * P2-S1 — chart of accounts: seeding, completeness, system-account integrity
 * and new-business atomicity (directive §21, AL-05/06/07/08).
 *
 * Every assertion here is about what PostgreSQL itself refuses. A rule that
 * only the service layer enforces is not an accounting invariant — a raw SQL
 * connection is exactly what these tests use.
 */

const REQUIRED = 21;

/** The registry as the directive states it, written out rather than read back
 *  from the table it is meant to verify. */
const EXPECTED_REGISTRY: readonly (readonly [string, string, string])[] = [
  ['cash', '1000', 'asset'],
  ['bank', '1010', 'asset'],
  ['card_clearing', '1020', 'asset'],
  ['wallet_clearing', '1030', 'asset'],
  ['cheque_clearing', '1040', 'asset'],
  ['accounts_receivable', '1100', 'asset'],
  ['supplier_receivable', '1150', 'asset'],
  ['inventory', '1200', 'asset'],
  ['accounts_payable', '2000', 'liability'],
  ['tax_payable', '2100', 'liability'],
  ['customer_refund_liability', '2200', 'liability'],
  ['customer_credit_liability', '2210', 'liability'],
  ['opening_equity', '3000', 'equity'],
  ['sales_revenue', '4000', 'revenue'],
  ['sales_returns', '4100', 'revenue'],
  ['discounts', '4200', 'revenue'],
  ['fx_gain', '4900', 'revenue'],
  ['cogs', '5000', 'expense'],
  ['rounding', '6100', 'expense'],
  ['purchase_price_variance', '6200', 'expense'],
  ['fx_loss', '6900', 'expense'],
];

describe('P2-S1 chart of accounts', () => {
  let tenantId = '';
  let businessA = '';
  let businessB = '';

  async function newBusiness(slug: string, tenant = tenantId): Promise<string> {
    const { rows } = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenant, slug, slug],
    );
    const row = rows[0];
    if (!row) throw new Error('business fixture insert failed');
    return row.id;
  }

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    const { rows } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const t = rows[0];
    if (!t) throw new Error('tenant fixture insert failed');
    tenantId = t.id;
    businessA = await newBusiness('chart-a');
    businessB = await newBusiness('chart-b');
  });

  // ── The registry itself ──────────────────────────────────────────────────

  it('the system account key registry holds exactly the 21 Phase 2 identities', async () => {
    const { rows } = await ownerPool().query<{ system_key: string; default_code: string; account_type: string }>(
      `SELECT system_key, default_code, account_type FROM accounting_system_account_keys ORDER BY sort_order`,
    );
    expect(rows.map((r) => [r.system_key, r.default_code, r.account_type])).toEqual(EXPECTED_REGISTRY.map((r) => [...r]));
    expect(rows).toHaveLength(REQUIRED);
  });

  // ── E / F — completeness and correct typing per business ─────────────────

  it('E: every business has exactly 21 required system accounts', async () => {
    const { rows } = await ownerPool().query<{ business_id: string; n: number }>(
      `SELECT b.id AS business_id,
              (SELECT count(*)::int FROM accounts a
               JOIN accounting_system_account_keys k ON k.system_key = a.system_key
               WHERE a.business_id = b.id AND a.is_active) AS n
       FROM businesses b`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.n).toBe(REQUIRED);
  });

  it('F: every required system_key carries the correct account type and default code', async () => {
    const { rows } = await ownerPool().query<{ system_key: string; code: string; type: string }>(
      `SELECT system_key, code, type FROM accounts a
       JOIN accounting_system_account_keys k USING (system_key)
       WHERE a.business_id = $1 ORDER BY k.sort_order`,
      [businessA],
    );
    expect(rows.map((r) => [r.system_key, r.code, r.type])).toEqual(EXPECTED_REGISTRY.map((r) => [...r]));
  });

  it('the seeded chart carries no balance-like column at all (AL-15 / guard G-3)', async () => {
    const { rows } = await ownerPool().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts'`);
    const names = rows.map((r) => r.column_name);
    for (const forbidden of ['balance', 'current_balance', 'available_balance', 'debit_total', 'credit_total', 'cached_balance', 'stock']) {
      expect(names).not.toContain(forbidden);
    }
  });

  // ── G / H / I — uniqueness and ownership ─────────────────────────────────

  it('G: a duplicate (business, system_key) is refused', async () => {
    await expect(
      ownerPool().query(
        `INSERT INTO accounts (tenant_id, business_id, code, name, type, system_key)
         VALUES ($1, $2, '9001', 'Second cash', 'asset', 'cash')`,
        [tenantId, businessA],
      ),
    ).rejects.toThrow(/duplicate key|accounts_business_system_key_uq/i);
  });

  it('H: a duplicate (business, code) is refused', async () => {
    await expect(
      ownerPool().query(
        `INSERT INTO accounts (tenant_id, business_id, code, name, type)
         VALUES ($1, $2, '1000', 'Another 1000', 'asset')`,
        [tenantId, businessA],
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('I: an account claiming tenant A while owned by a business of tenant B is refused', async () => {
    const { rows } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const otherTenant = rows[0]?.id;
    await expect(
      ownerPool().query(
        `INSERT INTO accounts (tenant_id, business_id, code, name, type)
         VALUES ($1, $2, '7001', 'Wrong tenant', 'asset')`,
        [otherTenant, businessA],
      ),
    ).rejects.toThrow(/accounts_tenant_business_fk|violates foreign key/i);
  });

  it('a system_key may never be attached to the wrong account type (composite FK)', async () => {
    // Every key is already seeded, so clear one inside a throw-away
    // transaction first — otherwise the uniqueness index answers before the
    // composite FK gets a chance to, and the FK would go untested.
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`DELETE FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessB]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await expect(
        c.query(
          `INSERT INTO accounts (tenant_id, business_id, code, name, type, system_key)
           VALUES ($1, $2, '7002', 'Cash as a liability', 'liability', 'cash')`,
          [tenantId, businessB],
        ),
      ).rejects.toThrow(/accounts_system_key_type_fk|violates foreign key/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('a custom account (system_key NULL) may take any valid type', async () => {
    await ownerPool().query(
      `INSERT INTO accounts (tenant_id, business_id, code, name, type)
       VALUES ($1, $2, 'CUST-1', 'Petty custom', 'expense')`,
      [tenantId, businessB],
    );
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1 AND system_key IS NULL`, [
      businessB,
    ]);
    expect(rows[0]?.n).toBe(1);
  });

  // ── J … P — system account immutability ──────────────────────────────────

  it('J: deleting a system account fails', async () => {
    await expect(ownerPool().query(`DELETE FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('K: mutating system_key fails', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET system_key = 'bank' WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('L: clearing system_key fails', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET system_key = NULL WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('M: changing a system account code fails', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET code = '1001' WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('N: changing a system account type fails', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET type = 'expense' WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('O: deactivating a system account fails', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND system_key = 'cash'`, [businessA])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  it('P: renaming a system account succeeds — the name is presentation, system_key is identity', async () => {
    await ownerPool().query(`UPDATE accounts SET name = 'الصندوق' WHERE business_id = $1 AND system_key = 'cash'`, [businessA]);
    const { rows } = await ownerPool().query<{ name: string; system_key: string }>(
      `SELECT name, system_key FROM accounts WHERE business_id = $1 AND system_key = 'cash'`,
      [businessA],
    );
    expect(rows[0]).toMatchObject({ name: 'الصندوق', system_key: 'cash' });
  });

  it('a custom account cannot be promoted into an engine identity', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET system_key = 'bank' WHERE business_id = $1 AND code = 'CUST-1'`, [businessB])).rejects.toThrow(
      /system_account_immutable/i,
    );
  });

  // ── Q — a chart is not a financial transaction ───────────────────────────

  it('Q: financial_started_at stays NULL after chart creation and re-seeding', async () => {
    await ownerPool().query(`SELECT accounting_seed_chart($1)`, [businessA]);
    const { rows } = await ownerPool().query<{ financial_started_at: string | null }>(`SELECT financial_started_at FROM businesses`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.financial_started_at).toBeNull();
  });

  // ── R — idempotency without silent repair ────────────────────────────────

  it('R: seeding twice creates no duplicate accounts and never overwrites a rename', async () => {
    const before = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [businessA]);
    await ownerPool().query(`SELECT accounting_seed_chart($1)`, [businessA]);
    await ownerPool().query(`SELECT accounting_seed_chart($1)`, [businessA]);
    const after = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [businessA]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // The rename from test P must survive an idempotent re-run.
    const { rows } = await ownerPool().query<{ name: string }>(`SELECT name FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessA]);
    expect(rows[0]?.name).toBe('الصندوق');
  });

  it('seeding an unknown business fails loudly instead of inventing a chart', async () => {
    await expect(ownerPool().query(`SELECT accounting_seed_chart(gen_random_uuid())`)).rejects.toThrow(/chart_seed_invalid_business/i);
  });

  it('a required code already owned by a custom account fails loudly — no silent repair (§32)', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      const biz = (
        await c.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Conflict', 'chart-conflict', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId],
        )
      ).rows[0];
      // Remove one identity's row the only way possible — by clearing it as a
      // whole custom row is impossible — so simulate the conflict shape:
      // a NEW business whose 'cash' row is missing while 1000 is taken.
      await c.query(`SET LOCAL session_replication_role = replica`); // detach row triggers for this fixture only
      await c.query(`DELETE FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [biz?.id]);
      await c.query(`UPDATE accounts SET code = '1000' WHERE business_id = $1 AND system_key = 'bank'`, [biz?.id]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await expect(c.query(`SELECT accounting_seed_chart($1)`, [biz?.id])).rejects.toThrow(/chart_conflict/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('an inactive required system account fails loudly instead of being reactivated (§32)', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      const biz = (
        await c.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Inactive', 'chart-inactive', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId],
        )
      ).rows[0];
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND system_key = 'inventory'`, [biz?.id]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await expect(c.query(`SELECT accounting_seed_chart($1)`, [biz?.id])).rejects.toThrow(/chart_conflict/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  // ── S / T — new-business atomicity ───────────────────────────────────────

  it('S: the new-business trigger creates the chart inside the SAME transaction', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      const biz = (
        await c.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Atomic', 'chart-atomic', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId],
        )
      ).rows[0];
      // Same transaction, before COMMIT: the chart is already complete.
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM accounts a
         JOIN accounting_system_account_keys k USING (system_key)
         WHERE a.business_id = $1 AND a.is_active`,
        [biz?.id],
      );
      expect(rows[0]?.n).toBe(REQUIRED);
      await c.query('ROLLBACK');
      // And rolling back takes the chart with it — one unit of truth.
      const after = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [biz?.id]);
      expect(after.rows[0]?.n).toBe(0);
    } finally {
      c.release();
    }
  });

  it('T: a forced chart-seed failure rolls back the ENTIRE business creation', async () => {
    const slug = 'chart-rollback';
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      // Failure injection lives in this transaction only — the DDL is rolled
      // back with it. Production carries no test-only switch.
      await c.query(`CREATE FUNCTION accounting_force_seed_failure() RETURNS trigger LANGUAGE plpgsql AS
        $fn$ BEGIN RAISE EXCEPTION 'injected: account insert refused'; END $fn$`);
      await c.query(`CREATE TRIGGER accounting_force_seed_failure BEFORE INSERT ON accounts
        FOR EACH ROW EXECUTE FUNCTION accounting_force_seed_failure()`);
      await expect(
        c.query(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Rollback', $2, 'PS', 'ILS', 'Asia/Hebron')`,
          [tenantId, slug],
        ),
      ).rejects.toThrow(/injected: account insert refused/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    // The business row does not survive: no business rather than a chart-less business.
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM businesses WHERE store_slug = $1`, [slug]);
    expect(rows[0]?.n).toBe(0);
    // And the injected trigger is gone with the transaction.
    const { rows: trg } = await ownerPool().query(`SELECT 1 FROM pg_trigger WHERE tgname = 'accounting_force_seed_failure'`);
    expect(trg).toEqual([]);
  });
});
