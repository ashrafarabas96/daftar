/**
 * PLANTED DISCREPANCIES (P2-S8 §23).
 *
 * The companion suite runs the nine checks against books the product wrote
 * and finds nothing, which proves they do not cry wolf. It cannot prove they
 * would notice, and a reconciliation pass whose detection was never
 * demonstrated is a green light nobody earned.
 *
 * Every anomaly the checks look for is one the frozen constraints make
 * impossible through ordinary SQL — that is the point of the constraints. So
 * each case here plants the corruption with the triggers and foreign keys
 * suspended for the duration of ONE transaction, runs the real check SQL, and
 * ROLLS THE TRANSACTION BACK. Nothing is dropped, nothing is altered, nothing
 * survives the case. `session_replication_role` is set LOCAL, so it ends with
 * the transaction and never reaches another connection.
 *
 * WHAT IS UNDER TEST IS THE PRODUCTION SQL. Each case calls
 * `runReconciliationCheck`, the same function the reconciler process calls,
 * rather than a re-implementation — a test that re-implements the thing under
 * test proves only that the test agrees with itself.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { RECONCILIATION_CHECK_IDS, type ReconciliationCheckId, type ReconciliationFinding } from '@daftar/accounting';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { runReconciliationCheck } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';

/** The identifiers one planted scenario works with. */
interface Plot {
  tenantId: string;
  businessId: string;
  otherBusinessId: string;
  userId: string;
  cashId: string;
  equityId: string;
  foreignAccountId: string;
  entryId: string;
  today: string;
}

type Findings = Record<ReconciliationCheckId, ReconciliationFinding>;

beforeAll(async () => {
  await ensurePostgres();
}, 300_000);

/**
 * Seed a clean, self-consistent business, let the case corrupt it, then run
 * all nine checks — and roll everything back.
 */
async function scenario(corrupt: (c: PoolClient, plot: Plot) => Promise<void>): Promise<Findings> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    // Test authority over a transaction that is about to be discarded. The
    // product never does this: no runtime role may set it, and no code path
    // in apps/ or packages/ mentions it.
    await c.query(`SET LOCAL session_replication_role = replica`);

    const one = async (sql: string, params: unknown[] = []): Promise<string> => {
      const { rows } = await c.query<{ id: string }>(sql, params);
      const row = rows[0];
      if (!row) throw new Error('seed statement returned no row');
      return row.id;
    };
    const suffix = randomUUID().slice(0, 8);
    const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone, financial_started_at)
       VALUES ($1, 'Planted', $2, 'PS', 'ILS', 'Asia/Hebron', current_date) RETURNING id`,
      [tenantId, `planted-${suffix}`],
    );
    const otherBusinessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Planted Other', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId, `planted-other-${suffix}`],
    );
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Planter') RETURNING id`, [
      `planted-${suffix}@test.daftar.local`,
    ]);
    const account = (code: string, name: string, type: string, business = businessId): Promise<string> =>
      one(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [tenantId, business, code, name, type]);
    const cashId = await account('1000', 'Cash', 'asset');
    const equityId = await account('3000', 'Equity', 'equity');
    const foreignAccountId = await account('1000', 'Foreign Cash', 'asset', otherBusinessId);

    const { rows: dateRows } = await c.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`);
    const today = dateRows[0]?.d ?? '2026-01-01';

    const entryId = randomUUID();
    const plot: Plot = { tenantId, businessId, otherBusinessId, userId, cashId, equityId, foreignAccountId, entryId, today };
    await postRaw(c, plot, entryId, 5000);

    await corrupt(c, plot);

    const findings = {} as Findings;
    for (const id of RECONCILIATION_CHECK_IDS) {
      findings[id] = await runReconciliationCheck(c, businessId, id);
    }
    return findings;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** One balanced, bound, well-formed entry — the shape everything starts from. */
async function postRaw(c: PoolClient, plot: Plot, entryId: string, amount: number, entryDate = plot.today, sourceType = 'manual_adjustment'): Promise<string> {
  const sourceId = randomUUID();
  await c.query(`INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id) VALUES ($1, $2, $3, $4, $5)`, [
    plot.tenantId,
    plot.businessId,
    sourceType,
    sourceId,
    entryId,
  ]);
  await c.query(
    `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                  actor_kind, actor_user_id, request_id, posting_fingerprint)
     VALUES ($1, $2, $3, $4::date, $5, $6, 'planted', 'user', $7, 'planted', repeat('b', 64))`,
    [plot.tenantId, plot.businessId, entryId, entryDate, sourceType, sourceId, plot.userId],
  );
  for (const [lineNo, accountId, debit, credit] of [
    [1, plot.cashId, amount, 0],
    [2, plot.equityId, 0, amount],
  ] as const) {
    await c.query(
      `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                                  debit_minor, credit_minor, base_amount_minor, base_currency,
                                  txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
       VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, 'ILS', $9, 'ILS', 1, 'base', date_trunc('second', now()))`,
      [plot.tenantId, plot.businessId, entryId, lineNo, accountId, debit, credit, Math.max(debit, credit), Math.max(debit, credit)],
    );
  }
  return sourceId;
}

/** The entry every scenario starts from, as the checks report it. */
const plotEntryOf = (findings: Findings): string => {
  const id = findings['R-ACC-01'].offendingIds[0];
  if (!id) throw new Error('R-ACC-01 reported no offending entry');
  return id;
};

const clean = (findings: Findings): string[] => RECONCILIATION_CHECK_IDS.filter((id) => findings[id].offendingCount > 0n || findings[id].offendingCount > 0);

describe('the control: a clean business trips nothing (§23)', () => {
  it('reports zero offenders on all nine checks', async () => {
    const findings = await scenario(async () => undefined);
    expect(clean(findings)).toEqual([]);
  });
});

describe('each planted discrepancy is DETECTED by its own check (§23)', () => {
  it('R-ACC-01 — an entry whose debits and credits differ', async () => {
    const findings = await scenario(async (c, plot) => {
      // Every ROW-level check still holds while the transaction runs — only
      // the deferred entry-level validators are suspended — so the plant has
      // to move debit, base and txn together and leave a row that is
      // internally well-formed. That is what makes it a good plant: this is
      // what silent corruption would actually look like.
      await c.query(
        `UPDATE journal_lines
            SET debit_minor = debit_minor + 1, base_amount_minor = base_amount_minor + 1, txn_amount_minor = txn_amount_minor + 1
          WHERE journal_entry_id = $1 AND line_no = 1`,
        [plot.entryId],
      );
    });
    expect(findings['R-ACC-01'].offendingCount).toBeGreaterThan(0);
    expect(findings['R-ACC-01'].offendingIds).toContain(plotEntryOf(findings));
  });

  it('R-ACC-01 — an entry with a single line', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1 AND line_no = 2`, [plot.entryId]);
    });
    expect(findings['R-ACC-01'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-02 — the business total is out even though every entry balances', async () => {
    const findings = await scenario(async (c, plot) => {
      // A second entry that balances WITHIN itself is not enough: this one is
      // planted as two rows that each look ordinary and together do not sum.
      const orphanEntry = randomUUID();
      await postRaw(c, plot, orphanEntry, 700);
      await c.query(
        `UPDATE journal_lines
            SET debit_minor = debit_minor + 250, base_amount_minor = base_amount_minor + 250, txn_amount_minor = txn_amount_minor + 250
          WHERE journal_entry_id = $1 AND line_no = 1`,
        [orphanEntry],
      );
    });
    expect(findings['R-ACC-02'].offendingCount).toBeGreaterThan(0);
  });

  /**
   * A NOTE ON WHAT R-ACC-03 CAN AND CANNOT SEE, because a test that asserts
   * the wrong thing here would be worse than no test.
   *
   * Re-labelling an account's TYPE does not break this identity, and it
   * should not: with equity re-labelled as an asset, the same entry's two
   * lines simply move to the same side of the equation and cancel, and the
   * books remain internally consistent under the identity. The plant that
   * genuinely breaks it is a line whose account has gone missing, because
   * the join drops that line and only one side of the identity loses it.
   *
   * That corruption is structural, so R-ACC-04 sees it too. They are not
   * redundant: R-ACC-04 reports the missing reference and R-ACC-03 reports
   * that the totals no longer add up, and on a real incident an operator
   * needs both facts.
   */
  it('R-ACC-03 — the trial-balance identity, broken by an account that is gone', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`DELETE FROM accounts WHERE id = $1 AND business_id = $2`, [plot.equityId, plot.businessId]);
    });
    expect(findings['R-ACC-03'].offendingCount).toBeGreaterThan(0);
    expect(findings['R-ACC-04'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-03 — a pure re-label of an account type does NOT trip it, and that is correct', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE accounts SET type = 'asset' WHERE id = $1 AND business_id = $2`, [plot.equityId, plot.businessId]);
    });
    expect(findings['R-ACC-03'].offendingCount).toBe(0);
  });

  it('R-ACC-04 — a line naming an account of ANOTHER business', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE journal_lines SET account_id = $1 WHERE journal_entry_id = $2 AND line_no = 1`, [plot.foreignAccountId, plot.entryId]);
    });
    expect(findings['R-ACC-04'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-04 — a line whose entry does not exist', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE journal_lines SET journal_entry_id = gen_random_uuid() WHERE journal_entry_id = $1 AND line_no = 1`, [plot.entryId]);
    });
    expect(findings['R-ACC-04'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-05 — an entry dated inside a period that is closed RIGHT NOW', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(
        `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id, closed_by_user_id, closed_at)
         VALUES ($1, $2, gen_random_uuid(), $3::date - 5, $3::date + 5, 'closed', $4, $4, now())`,
        [plot.tenantId, plot.businessId, plot.today, plot.userId],
      );
      // The entry was posted BEFORE the close, which is legitimate. What is
      // not legitimate is an entry created AFTER it, so the plant moves the
      // entry's creation forward rather than inventing a date.
      await c.query(`UPDATE journal_entries SET created_at = now() + interval '1 hour' WHERE id = $1`, [plot.entryId]);
    });
    expect(findings['R-ACC-05'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-06 — an entry whose source_type is not a registered source type', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE journal_entries SET source_type = 'invented_source' WHERE id = $1`, [plot.entryId]);
    });
    expect(findings['R-ACC-06'].offendingCount).toBeGreaterThan(0);
  });

  /**
   * `journal_lines_fx_shape_ck` already refuses a malformed snapshot ROW by
   * row, and it is a CHECK, so it holds even here. What it cannot see is the
   * snapshot going stale against the BUSINESS — a base currency changed
   * after the journal was written leaves every historical line denominated in
   * a currency the business no longer uses, and every row still passes its
   * own constraint. That is the gap R-ACC-07 exists for, so that is what is
   * planted.
   */
  it('R-ACC-07 — lines whose base currency no longer matches the business', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE businesses SET base_currency = 'USD' WHERE id = $1`, [plot.businessId]);
    });
    expect(findings['R-ACC-07'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-08 — an entry with no binding, and a binding naming no entry', async () => {
    const missingBinding = await scenario(async (c, plot) => {
      await c.query(`DELETE FROM accounting_source_bindings WHERE journal_entry_id = $1`, [plot.entryId]);
    });
    expect(missingBinding['R-ACC-08'].offendingCount).toBeGreaterThan(0);

    const danglingBinding = await scenario(async (c, plot) => {
      await c.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1, $2, 'manual_adjustment', gen_random_uuid(), gen_random_uuid())`,
        [plot.tenantId, plot.businessId],
      );
    });
    expect(danglingBinding['R-ACC-08'].offendingCount).toBeGreaterThan(0);
  });

  it('R-ACC-09 — journal history with no financial_started_at', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(`UPDATE businesses SET financial_started_at = NULL WHERE id = $1`, [plot.businessId]);
    });
    expect(findings['R-ACC-09'].offendingCount).toBeGreaterThan(0);
  });
});

describe('detection reports the anomaly, never the money (§22)', () => {
  it('names the offending objects and no amount', async () => {
    const findings = await scenario(async (c, plot) => {
      await c.query(
        `UPDATE journal_lines SET debit_minor = 999777, base_amount_minor = 999777, txn_amount_minor = 999777
          WHERE journal_entry_id = $1 AND line_no = 1`,
        [plot.entryId],
      );
    });
    const rendered = JSON.stringify(findings, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(rendered).not.toContain('999777');
    expect(findings['R-ACC-01'].offendingIds.length).toBeGreaterThan(0);
    for (const id of findings['R-ACC-01'].offendingIds) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });
});
