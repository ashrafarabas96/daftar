import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNTING_AUTHORITY_TABLES, findAuthoritativeBalanceColumns, isAuthoritativeBalanceColumn } from '../../scripts/guards/no-authoritative-balance';

const ROOT = join(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'infrastructure/database/migrations');
const MESSAGES = join(ROOT, 'apps/web/src/messages');

const SYSTEM_KEYS = [
  'cash',
  'bank',
  'card_clearing',
  'wallet_clearing',
  'cheque_clearing',
  'accounts_receivable',
  'supplier_receivable',
  'inventory',
  'accounts_payable',
  'tax_payable',
  'customer_refund_liability',
  'customer_credit_liability',
  'opening_equity',
  'sales_revenue',
  'sales_returns',
  'discounts',
  'fx_gain',
  'cogs',
  'rounding',
  'purchase_price_variance',
  'fx_loss',
] as const;

/**
 * Guard G-3 (directive §16): a permanent regression test for the GUARD, not
 * just for today's schema. A guard nobody tests is a guard that quietly stops
 * matching the day someone edits its regex.
 */
describe('guard G-3 — no authoritative balance column', () => {
  it('rejects the obvious storage-authority columns on a declared accounting table', () => {
    for (const column of ['balance', 'current_balance', 'available_balance', 'cached_balance', 'debit_total', 'credit_total', 'stock']) {
      const sql = `CREATE TABLE accounts (business_id UUID NOT NULL, id UUID NOT NULL, ${column} BIGINT NOT NULL DEFAULT 0);`;
      expect(findAuthoritativeBalanceColumns(sql)).toEqual([{ table: 'accounts', column }]);
    }
  });

  it('rejects a balance column added later by ALTER TABLE', () => {
    expect(findAuthoritativeBalanceColumns(`ALTER TABLE accounts ADD COLUMN current_balance BIGINT NOT NULL DEFAULT 0;`)).toEqual([
      { table: 'accounts', column: 'current_balance' },
    ]);
    expect(findAuthoritativeBalanceColumns(`ALTER TABLE ONLY accounts ADD balance_minor BIGINT;`)).toEqual([{ table: 'accounts', column: 'balance_minor' }]);
  });

  it('is about storage authority, not vocabulary — read models and other tables are untouched', () => {
    // A report table that is not declared a source of truth.
    expect(findAuthoritativeBalanceColumns(`CREATE TABLE customer_statement_view (balance BIGINT);`)).toEqual([]);
    // Legitimate accounts columns.
    expect(findAuthoritativeBalanceColumns(`CREATE TABLE accounts (code TEXT, name TEXT, type TEXT, is_active BOOLEAN, sort_order INT);`)).toEqual([]);
    // A comment that NAMES the anti-pattern, as 0040 does.
    expect(findAuthoritativeBalanceColumns(`-- NO balance column, by design\nCREATE TABLE accounts (code TEXT);`)).toEqual([]);
    // A function body or a literal mentioning it.
    expect(
      findAuthoritativeBalanceColumns(
        `CREATE TABLE accounts (code TEXT);\nCREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE 'balance'; END $$ LANGUAGE plpgsql;`,
      ),
    ).toEqual([]);
    // Table constraints are never mistaken for columns.
    expect(findAuthoritativeBalanceColumns(`CREATE TABLE accounts (code TEXT, CONSTRAINT balance_check CHECK (true));`)).toEqual([]);
  });

  it('the column-name rule itself is stable', () => {
    for (const yes of ['balance', 'opening_balance', 'balance_minor', 'debit_total', 'credit_sum', 'stock', 'stock_qty']) {
      expect(isAuthoritativeBalanceColumn(yes)).toBe(true);
    }
    for (const no of ['code', 'name', 'type', 'is_active', 'sort_order', 'balanced_at', 'unbalancedish', 'stockholm']) {
      expect(isAuthoritativeBalanceColumn(no)).toBe(false);
    }
  });

  it('the real migration tree is clean and the guard is actually watching a table that exists', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    for (const f of files) expect(findAuthoritativeBalanceColumns(readFileSync(join(MIGRATIONS, f), 'utf8'))).toEqual([]);
    const schema = files.map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');
    for (const table of ACCOUNTING_AUTHORITY_TABLES) {
      expect(schema).toMatch(new RegExp(`CREATE\\s+TABLE\\s+${table}\\b`, 'i'));
    }
  });
});

/** Directive §24 — localization parity for the 21 system account keys. */
describe('accounting localization (AL-06)', () => {
  const catalogs = Object.fromEntries(
    (['ar', 'en', 'tr'] as const).map((l) => [l, JSON.parse(readFileSync(join(MESSAGES, `${l}.json`), 'utf8')) as Record<string, string>]),
  );

  it('every system account key has a real value in ar, en and tr', () => {
    for (const key of SYSTEM_KEYS) {
      for (const locale of ['ar', 'en', 'tr'] as const) {
        const value = catalogs[locale]?.[`accounting.account.${key}`];
        expect(value, `${locale}: accounting.account.${key}`).toBeTruthy();
        expect(value).not.toBe(`accounting.account.${key}`);
      }
    }
  });

  it('the Arabic values are Arabic, not transliterated English', () => {
    for (const key of SYSTEM_KEYS) {
      const value = catalogs['ar']?.[`accounting.account.${key}`] ?? '';
      expect(value, `ar: ${key}`).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('no account_translations table exists — AL-06 deliberately did not create one', () => {
    const schema = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(schema).not.toMatch(/CREATE\s+TABLE\s+account_translations\b/i);
  });
});

/** Directive §3 / §21-D — the Phase 1 migration history is untouched. */
describe('P2-S1 migration boundary', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  it('D: every frozen 0000–0039 hash is unchanged', () => {
    expect(manifest.migrations).toHaveLength(40);
    for (const entry of manifest.migrations) {
      const sha = createHash('sha256')
        .update(readFileSync(join(MIGRATIONS, entry.name)))
        .digest('hex');
      expect(sha, entry.name).toBe(entry.sha256);
    }
  });

  it('0040 and 0041 exist and are NOT yet frozen — Tech Lead approval is the freeze boundary (§3, §30)', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toContain('0040_accounting_chart.sql');
    expect(files).toContain('0041_accounting_permissions.sql');
    expect(manifest.frozenThrough).toBe('0039_catalog_identifiers_owner_integrity.sql');
    const frozen = new Set(manifest.migrations.map((m) => m.name));
    expect(frozen.has('0040_accounting_chart.sql')).toBe(false);
    expect(frozen.has('0041_accounting_permissions.sql')).toBe(false);
  });

  /**
   * `scripts/db-from-zero.ts` used to refuse ANY migration past `frozenThrough`,
   * which made a candidate migration impossible mid-phase even though the
   * manifest's own policy allows one. The rule now belongs to RELEASE mode, and
   * the release gate must keep passing `--release` — otherwise an unfrozen
   * migration could ship.
   */
  it('the release gate still demands a fully frozen manifest (db-from-zero --release)', () => {
    const releaseGate = readFileSync(join(ROOT, 'scripts/phase1-release-gate.ts'), 'utf8');
    expect(releaseGate).toMatch(/check:db-from-zero'[^)]*'--release'/);
    const fromZero = readFileSync(join(ROOT, 'scripts/db-from-zero.ts'), 'utf8');
    expect(fromZero).toMatch(/RELEASE_MODE/);
    // A candidate is still proven applied and hash-matched against disk.
    expect(fromZero).toMatch(/candidate migration \$\{f\} history hash does not match the file on disk/);
  });

  it('no 0042 or later migration exists — P2-S2 is unauthorized (§34)', () => {
    const beyond = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f.slice(0, 4) > '0041');
    expect(beyond).toEqual([]);
  });
});
