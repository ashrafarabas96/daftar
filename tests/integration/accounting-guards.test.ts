import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_AUTHORITY_TABLES,
  discoverAccountingTables,
  findAuthoritativeBalanceColumns,
  isAuthoritativeBalanceColumn,
  isForbiddenBalanceTable,
} from '../../scripts/guards/no-authoritative-balance';
import { findReadSurfaceViolations, readSurfaceFiles } from '../../scripts/guards/read-surface';
import { LOGIN_ROLES, findAuthorityViolations, parseTableGrants } from '../../scripts/guards/authority-isolation';
import { REQUIRED_RATE_SCALE, findFloatRateColumns, isRateAuthorityTable, isRateColumn } from '../../scripts/guards/no-float-rate';
import { stripComments } from '../../scripts/guards/sql-schema';
import {
  ACCOUNTING_REGISTRY_TABLES,
  P2_S2_EXCLUDED_SURFACES,
  INTENDED_TABLE_GRANTS,
  INTERNAL_ROLE,
  JOURNAL_TABLES,
  RUNTIME_ROLES,
  WRITE_PRIVILEGES,
  compareTableGrants,
} from '../../scripts/guards/journal-privilege-model';

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

/**
 * P2-S7 §60 — G-3 stopped being a list.
 *
 * The four names it started with were honest while four tables held
 * accounting state. The table that breaks AL-15 is by definition the one
 * nobody added to the list, so the watched set is now read out of the schema.
 */
describe('guard G-3 — the watched set is discovered, not listed (§60)', () => {
  it('finds every accounting-owned table the schema creates', () => {
    const sql = `
      CREATE TABLE accounts (code TEXT);
      CREATE TABLE journal_lines (id UUID);
      CREATE TABLE accounting_periods (id UUID);
      CREATE TABLE products (id UUID);
      CREATE TABLE branches (id UUID);
    `;
    expect(discoverAccountingTables(sql)).toEqual(['accounting_periods', 'accounts', 'journal_lines']);
  });

  it('covers a table nobody declared, the day it is written', () => {
    const sql = `CREATE TABLE accounting_report_rollup (business_id UUID, cached_balance BIGINT);`;
    const watched = discoverAccountingTables(sql);
    expect(watched).toContain('accounting_report_rollup');
    expect(findAuthoritativeBalanceColumns(sql, watched)).toEqual([{ table: 'accounting_report_rollup', column: 'cached_balance' }]);
    // …and the list version of the rule would have seen nothing at all.
    expect(findAuthoritativeBalanceColumns(sql, ACCOUNTING_AUTHORITY_TABLES)).toEqual([]);
  });

  /**
   * The other shape AL-15 forbids: the balance is the whole table, and its
   * columns are innocently named `amount` or `value`.
   */
  it('refuses a table whose NAME is the stored balance', () => {
    for (const table of ['accounting_balances', 'account_balances', 'running_balances', 'trial_balance_cache', 'ledger_cache', 'balance_snapshots']) {
      expect(isForbiddenBalanceTable(table)).toBe(true);
    }
  });

  /**
   * An opening balance is a source document: what the merchant declared
   * their position to be, posted through the journal like any other fact.
   * Nothing recomputes it, so nothing can drift from it.
   */
  it('does not mistake AL-13 source documents for stored balances', () => {
    for (const table of ['accounting_opening_balances', 'accounting_opening_balance_lines', 'accounts', 'journal_lines', 'accounting_periods']) {
      expect(isForbiddenBalanceTable(table)).toBe(false);
    }
    expect(isAuthoritativeBalanceColumn('opening_balance_id')).toBe(false);
    expect(isAuthoritativeBalanceColumn('opening_balance_minor')).toBe(true);
  });

  it('the real migration tree declares no stored accounting balance under the wider rule', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const schema = files.map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');
    const watched = discoverAccountingTables(schema);
    expect(watched.length).toBeGreaterThan(ACCOUNTING_AUTHORITY_TABLES.length);
    for (const table of watched) expect(isForbiddenBalanceTable(table)).toBe(false);
    for (const f of files) expect(findAuthoritativeBalanceColumns(readFileSync(join(MIGRATIONS, f), 'utf8'), watched)).toEqual([]);
  });
});

/**
 * P2-S7 §61 — the read surface is read-only, and reads the journal.
 *
 * Each rule below is checked twice: against a module that breaks it, so the
 * guard is known to fire, and against the shipped reporting modules, so the
 * product is known to pass. A guard only ever asserted to pass is a guard
 * nobody has seen work.
 */
describe('guard G-6 — the financial read surface (§61)', () => {
  const file = 'apps/api/src/modules/accounting/accounting-reports.reader.ts';
  const check = (source: string): string[] => findReadSurfaceViolations({ [file]: source }).map((v) => v.rule);

  it('fires on a write to an accounting table inside a report', () => {
    expect(check(`const sql = \`UPDATE journal_lines SET memo = $1\`;`)).toContain('no write to an accounting table');
    expect(check(`const sql = \`INSERT INTO accounting_periods (id) VALUES ($1)\`;`)).toContain('no write to an accounting table');
  });

  it('fires on OFFSET pagination', () => {
    expect(check(`const sql = \`SELECT 1 FROM journal_lines ORDER BY id LIMIT $1 OFFSET $2\`;`)).toContain('no OFFSET pagination');
  });

  it('fires on a current exchange-rate lookup', () => {
    expect(check(`const sql = \`SELECT accounting_fx_rate_lookup($1, $2, now())\`;`)).toContain('no current exchange-rate lookup');
  });

  it('fires on a historical query filtered by is_active, and not on one that merely reports it', () => {
    expect(check(`const sql = \`SELECT a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.is_active\`;`)).toContain(
      'no historical filter on accounts.is_active',
    );
    // Selecting it is how the report TELLS the merchant the account is closed.
    expect(check(`const sql = \`SELECT a.code, a.is_active FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.business_id = $1\`;`)).toEqual(
      [],
    );
    // And the chart list, which reads no journal, may filter on it freely.
    expect(check(`const sql = \`SELECT a.code FROM accounts a WHERE a.business_id = $1 AND a.is_active\`;`)).toEqual([]);
  });

  it('fires on an amount turned into a double, and not on a page size', () => {
    expect(check(`const total = Number(row.debitMinor);`)).toContain('no floating-point parse of an amount');
    expect(check(`const total = parseFloat(row.balance);`)).toContain('no floating-point parse of an amount');
    expect(check(`const size = Number(limitText);`)).toEqual([]);
    expect(check(`const lineNo = Number(lineNoText);`)).toEqual([]);
  });

  it('fires on a persisted or materialized balance source', () => {
    expect(check(`const sql = \`SELECT amount FROM accounting_balances WHERE business_id = $1\`;`)).toContain('no persisted or materialized balance source');
    expect(check(`const sql = \`CREATE MATERIALIZED VIEW ledger_rollup AS SELECT 1\`;`)).toContain('no persisted or materialized balance source');
  });

  it('does not trip on a comment that names the thing it forbids', () => {
    expect(check(`/** Never write \`OFFSET\`, never call accounting_fx_rate_lookup, never Number(amount). */\nexport const x = 1;`)).toEqual([]);
  });

  it('the shipped reporting modules pass every rule, and there are some to check', () => {
    const modules: Record<string, string> = {};
    for (const path of [
      'apps/api/src/modules/accounting/accounting-reports.reader.ts',
      'apps/api/src/modules/accounting/accounting-reports.service.ts',
      'packages/accounting/src/reports.ts',
    ]) {
      modules[path] = readFileSync(join(ROOT, path), 'utf8');
    }
    expect(readSurfaceFiles(modules).length).toBe(3);
    expect(findReadSurfaceViolations(modules)).toEqual([]);
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

/**
 * Directive §3 / §21-D, superseded by the P2-S1 FREEZE directive §6–§7.
 *
 * Until Tech Lead acceptance these tests asserted the opposite of what they now
 * assert: that 0040/0041 were NOT frozen, because freezing them early would
 * have made a review correction impossible. P2-S1 is accepted at
 * 18d2d1c0d38a726c503ce4b6cafe833de28a1bf6, so the freeze is now the invariant,
 * pinned to the accepted hashes rather than to whatever is on disk.
 */
describe('P2-S1 migration freeze', () => {
  /** The bytes the Tech Lead accepted. Never recomputed from disk. */
  const ACCEPTED = {
    '0040_accounting_chart.sql': '535c8182a922a8363df2c791759c3e1eff2790757e402e6e28a41a5d113651db',
    '0041_accounting_permissions.sql': '3aea7eedfd6ccb9d8fd93ed827d84abaa9923ccd3b01497960237098c19b1f77',
  } as const;
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  it('D: every frozen hash in the manifest is unchanged', () => {
    // The count is a floor, not an equality. P2-S1's permanent regression must
    // not refuse an authorized later freeze: it was 42 at P2-S1, 44 after the
    // P2-S2 freeze and 46 after P2-S3's. What P2-S1 actually guarantees is that
    // nothing already frozen drifted, and that its own two migrations are still
    // in the list — both asserted here and in the test below.
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(44);
    for (const entry of manifest.migrations) {
      const sha = createHash('sha256')
        .update(readFileSync(join(MIGRATIONS, entry.name)))
        .digest('hex');
      expect(sha, entry.name).toBe(entry.sha256);
    }
  });

  it('0040 and 0041 are frozen at the accepted hashes, on disk and in the manifest (freeze §6)', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
    for (const [name, sha256] of Object.entries(ACCEPTED)) {
      expect(files, name).toContain(name);
      // On disk AND in the manifest, both against the accepted literal — so a
      // commit that edits the migration and its manifest entry together still
      // fails here.
      expect(
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS, name)))
          .digest('hex'),
        `${name} on disk`,
      ).toBe(sha256);
      expect(frozen.get(name), `${name} in manifest`).toBe(sha256);
    }
    // P2-S1 is frozen: frozenThrough must be at or past 0041. It has since moved
    // to 0043 (P2-S2 freeze), which still includes P2-S1.
    expect(manifest.frozenThrough >= '0041_accounting_permissions.sql').toBe(true);
  });

  it('the manifest lists 0000→N in canonical order with no hole, P2-S1 included', () => {
    const names = manifest.migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^0000_/);
    expect(names).toContain('0040_accounting_chart.sql');
    expect(names).toContain('0041_accounting_permissions.sql');
    for (const [i, name] of names.entries()) {
      expect(name.slice(0, 4), name).toBe(String(i).padStart(4, '0'));
    }
  });

  it('the P2-S1 gate carries the accepted hashes as its own second source', () => {
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s1-gate.ts'), 'utf8');
    for (const [name, sha256] of Object.entries(ACCEPTED)) {
      expect(gate, name).toContain(name);
      expect(gate, `${name} hash`).toContain(sha256);
    }
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

  /**
   * Freeze directive §7. This test used to assert that no 0042 existed. That
   * rule was correct only while P2-S1 was under review; as a permanent gate it
   * would block every authorized slice that follows. The rule it is replaced
   * by is the one that stays true forever: the P2-S1 gate must not refuse a
   * tree merely because a later migration is present.
   */
  it('the P2-S1 gate does not block later authorized migrations (§7)', () => {
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s1-gate.ts'), 'utf8');
    expect(gate).not.toMatch(/fail\('no-0042'/);
    expect(gate).toMatch(/must never be the reason an authorized later slice cannot land/);
  });
});

/**
 * Authority isolation (Tech Lead P2-S1 FINAL SECURITY CORRECTION §16).
 *
 * The blocker was a LOGIN runtime role holding INSERT on the chart. This tests
 * the GUARD, not just today's tree: each case below is the mistake as it would
 * actually be written, and the guard has to say no to every one of them.
 */
describe('authority isolation guard', () => {
  const REAL = {
    schema: readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n'),
    chartSql: readFileSync(join(MIGRATIONS, '0040_accounting_chart.sql'), 'utf8'),
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
  };

  it('accepts the tree as it stands — the chart has no credential-reachable writer', () => {
    expect(findAuthorityViolations(REAL)).toEqual([]);
  });

  it('rejects the exact regression it was written for: platform INSERT on accounts', () => {
    const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT SELECT, INSERT ON accounts TO daftar_platform;` });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/daftar_platform is granted INSERT on accounts/);
  });

  it('rejects chart DML granted to any one of the six login roles', () => {
    for (const role of LOGIN_ROLES) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'ALL']) {
        const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT ${priv} ON accounts TO ${role};` });
        expect(v.join(' '), `${role} must not hold ${priv}`).toContain(role);
      }
    }
  });

  it('rejects chart DML granted to PUBLIC', () => {
    const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT INSERT ON accounts TO PUBLIC;` });
    expect(v.join(' ')).toMatch(/PUBLIC is granted INSERT/);
  });

  it('still sees a grant appended after a migration full of prose about grants', () => {
    // The regression this catches for real: `[\s\S]+?` across the whole
    // concatenated schema let one match swallow every statement after a
    // PL/pgSQL body that mentions `role_table_grants`, and the guard went
    // quietly blind while staying green.
    const noisy = `${REAL.schema}\n-- GRANT INSERT ON journal_lines TO daftar_worker is what this forbids\nDO $$ BEGIN\n  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.grantee = 'x') THEN\n    RAISE EXCEPTION 'no';\n  END IF;\nEND $$;\nGRANT INSERT ON accounts TO daftar_app;`;
    expect(findAuthorityViolations({ ...REAL, schema: noisy }).join(' ')).toMatch(/daftar_app is granted INSERT on accounts/);
  });

  it('accepts the posting authority holding INSERT on the journal, and only INSERT (§69)', () => {
    const withWriter = `${REAL.schema}\nGRANT INSERT ON journal_entries TO daftar_accounting_internal;`;
    expect(findAuthorityViolations({ ...REAL, schema: withWriter })).toEqual([]);
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const rewriting = `${REAL.schema}\nGRANT ${priv} ON journal_entries TO daftar_accounting_internal;`;
      expect(findAuthorityViolations({ ...REAL, schema: rewriting }).join(' '), priv).toMatch(/must never rewrite or remove posted truth/);
    }
  });

  it('never accepts journal DML for a credential, writer or no writer', () => {
    for (const role of [...LOGIN_ROLES, 'PUBLIC']) {
      const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT INSERT ON journal_lines TO ${role};` });
      expect(v.join(' '), role).toMatch(/must never hold journal DML/);
    }
  });

  it('keeps the closed registries write-free even for the posting authority', () => {
    const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT INSERT ON accounting_source_types TO daftar_accounting_internal;` });
    expect(v.join(' ')).toMatch(/reference data, not ledger truth/);
  });

  it('rejects UPDATE or DELETE on accounts even for the internal principal', () => {
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const v = findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT ${priv} ON accounts TO daftar_accounting_internal;` });
      expect(v.join(' '), `nobody may hold ${priv}`).toMatch(new RegExp(`accounts grants ${priv}`));
    }
  });

  it('rejects a seeding routine owned by a login role', () => {
    const tampered = REAL.chartSql.replace(
      /ALTER FUNCTION accounting_seed_chart\(uuid\) OWNER TO [a-z_]+/,
      'ALTER FUNCTION accounting_seed_chart(uuid) OWNER TO daftar_platform',
    );
    expect(tampered).not.toBe(REAL.chartSql);
    const v = findAuthorityViolations({ ...REAL, chartSql: tampered });
    expect(v.join(' ')).toMatch(/owned by the LOGIN role daftar_platform/);
  });

  it('rejects a seeding routine that leaves EXECUTE with PUBLIC', () => {
    const tampered = REAL.chartSql.replace('REVOKE ALL ON FUNCTION accounting_seed_chart(uuid) FROM PUBLIC;', '');
    expect(tampered).not.toBe(REAL.chartSql);
    expect(findAuthorityViolations({ ...REAL, chartSql: tampered }).join(' ')).toMatch(/does not revoke EXECUTE from PUBLIC/);
  });

  it('rejects EXECUTE handed to a login role', () => {
    const tampered = `${REAL.chartSql}\nGRANT EXECUTE ON FUNCTION accounting_seed_chart(uuid) TO daftar_app;`;
    expect(findAuthorityViolations({ ...REAL, chartSql: tampered }).join(' ')).toMatch(/daftar_app is granted EXECUTE/);
  });

  it('rejects the internal principal becoming reachable', () => {
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ["CREATE ROLE daftar_accounting_internal LOGIN PASSWORD 'x';", /declared LOGIN|given a password/],
      ['CREATE ROLE daftar_accounting_internal NOLOGIN BYPASSRLS;', /declared BYPASSRLS/],
      ['CREATE ROLE daftar_accounting_internal NOLOGIN SUPERUSER;', /declared SUPERUSER/],
      ['CREATE ROLE daftar_accounting_internal NOLOGIN CREATEROLE;', /declared CREATEROLE/],
      ['CREATE ROLE daftar_accounting_internal NOLOGIN CREATEDB;', /declared CREATEDB/],
      ['CREATE ROLE daftar_accounting_internal NOLOGIN NOINHERIT;\nGRANT CONNECT ON DATABASE daftar TO daftar_accounting_internal;', /granted CONNECT/],
    ];
    for (const [bootstrap, expected] of cases) {
      expect(findAuthorityViolations({ ...REAL, bootstrap }).join(' '), bootstrap).toMatch(expected);
    }
  });

  it('permits the ONE deployment membership and rejects every other one', () => {
    const base = `CREATE ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'x';`;

    // The permitted case: a deployment principal that must assume the role.
    expect(
      findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;` }),
    ).toEqual([]);

    // Every runtime role is refused, whatever the options say.
    for (const role of LOGIN_ROLES) {
      const v = findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO ${role} WITH INHERIT FALSE, SET TRUE;` });
      expect(v.join(' '), `${role} must not be a member`).toMatch(new RegExp(`granted to the runtime role ${role}`));
    }
    expect(findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO PUBLIC;` }).join(' ')).toMatch(/granted to PUBLIC/);
    expect(findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO some_other_role;` }).join(' ')).toMatch(
      /only the deployment principal daftar_migrator may be a member/,
    );

    // The permitted membership still has to be a capability, not a privilege.
    expect(findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO daftar_migrator WITH SET TRUE;` }).join(' ')).toMatch(
      /not WITH INHERIT FALSE/,
    );
    expect(
      findAuthorityViolations({ ...REAL, bootstrap: `${base}\nGRANT daftar_accounting_internal TO daftar_migrator WITH INHERIT FALSE, ADMIN TRUE;` }).join(' '),
    ).toMatch(/WITH ADMIN TRUE/);
  });

  it('rejects a migration principal that is itself the problem', () => {
    const internal = `CREATE ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`;
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ["CREATE ROLE daftar_migrator LOGIN SUPERUSER NOBYPASSRLS PASSWORD 'x';", /declared SUPERUSER/],
      ["CREATE ROLE daftar_migrator LOGIN NOSUPERUSER BYPASSRLS PASSWORD 'x';", /declared BYPASSRLS/],
      ["CREATE ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD 'x';", /declared CREATEROLE/],
      ["CREATE ROLE daftar_migrator LOGIN PASSWORD 'x';", /does not assert NOSUPERUSER/],
    ];
    for (const [migrator, expected] of cases) {
      expect(findAuthorityViolations({ ...REAL, bootstrap: `${internal}\n${migrator}` }).join(' '), migrator).toMatch(expected);
    }
    expect(findAuthorityViolations({ ...REAL, bootstrap: internal }).join(' ')).toMatch(/daftar_migrator is not created by bootstrap\.sql/);

    // Deployment authority comes from owning the schema, never from a grant.
    expect(findAuthorityViolations({ ...REAL, schema: `${REAL.schema}\nGRANT INSERT ON accounts TO daftar_migrator;` }).join(' ')).toMatch(
      /granted table privileges by a migration/,
    );
  });

  it('rejects a temporary CREATE privilege that is never given back', () => {
    // 0040 needs CREATE on public for the ownership transfer to be legal for a
    // non-superuser. Taking it is fine; keeping it is not.
    const kept = REAL.chartSql.replace(/REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;/, '');
    expect(kept).not.toBe(REAL.chartSql);
    expect(findAuthorityViolations({ ...REAL, chartSql: kept }).join(' ')).toMatch(/never revokes it/);

    // And it is a migration-scoped privilege, not part of the role's shape.
    const permanent = `${REAL.bootstrap}\nGRANT CREATE ON SCHEMA public TO daftar_accounting_internal;`;
    expect(findAuthorityViolations({ ...REAL, bootstrap: permanent }).join(' ')).toMatch(/not to the permanent role shape/);
  });

  it('rejects a slice that never creates the internal principal at all', () => {
    expect(findAuthorityViolations({ ...REAL, bootstrap: '-- no roles here' }).join(' ')).toMatch(/is not created by bootstrap\.sql/);
  });

  it('rejects buying isolation by weakening the global bypass', () => {
    const widened = `${REAL.chartSql}\nCREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT true $$;`;
    expect(findAuthorityViolations({ ...REAL, chartSql: widened }).join(' ')).toMatch(/redefines app_bypass\(\)/);
    const bypassrls = `${REAL.chartSql}\nALTER ROLE daftar_accounting_internal BYPASSRLS;`;
    expect(findAuthorityViolations({ ...REAL, chartSql: bypassrls }).join(' ')).toMatch(/BYPASSRLS/);
  });

  it('reads grants the way PostgreSQL does, not the way a regex hopes to', () => {
    const grants = parseTableGrants(
      `GRANT SELECT, INSERT ON public.accounts TO daftar_accounting_internal;
       GRANT USAGE ON SCHEMA public TO daftar_app;
       GRANT EXECUTE ON FUNCTION accounting_seed_chart(uuid) TO daftar_app;
       GRANT SELECT ON TABLE accounts, businesses TO daftar_platform;`,
    );
    // Schema and function grants are not table grants and must not be read as
    // chart DML; `public.` and `TABLE` are noise, not different tables.
    expect(grants).toEqual([
      { privileges: ['SELECT', 'INSERT'], tables: ['accounts'], grantees: ['daftar_accounting_internal'] },
      { privileges: ['SELECT'], tables: ['accounts', 'businesses'], grantees: ['daftar_platform'] },
    ]);
  });
});

/**
 * Guard G-2 (directive §35): a permanent regression test for the GUARD.
 *
 * The directive asks for two opposite proofs, and both matter. The guard must
 * detect tampered SQL — a `fx_rate DOUBLE PRECISION` slipped into a future
 * migration — and it must NOT be so broad that a legitimate percentage
 * elsewhere in the product can no longer be declared. A guard that fails the
 * second test gets disabled within a month, which is the same as not having it.
 */
describe('guard G-2 — no floating-point financial rate', () => {
  const journalTable = (rateDecl: string): string =>
    `CREATE TABLE journal_lines (
       business_id UUID NOT NULL,
       id UUID NOT NULL,
       txn_amount_minor BIGINT,
       ${rateDecl}
     );`;

  it('detects every floating-point spelling of a tampered rate column', () => {
    for (const type of ['REAL', 'FLOAT', 'FLOAT(24)', 'FLOAT4', 'FLOAT8', 'DOUBLE PRECISION', 'double precision']) {
      const findings = findFloatRateColumns(journalTable(`fx_rate ${type} NOT NULL`));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ table: 'journal_lines', column: 'fx_rate' });
      expect(findings[0]?.detail).toMatch(/floating-point/);
    }
  });

  it('detects a rate quietly rounded by an under-scaled or scale-less NUMERIC', () => {
    expect(findFloatRateColumns(journalTable('fx_rate NUMERIC NOT NULL'))[0]?.detail).toMatch(/without an explicit scale/);
    expect(findFloatRateColumns(journalTable('fx_rate NUMERIC(20,4) NOT NULL'))[0]?.detail).toMatch(/scale 4/);
    expect(findFloatRateColumns(journalTable(`fx_rate NUMERIC(20,${REQUIRED_RATE_SCALE - 1}) NOT NULL`))).toHaveLength(1);
  });

  it('accepts the declaration AL-09 actually mandates', () => {
    expect(findFloatRateColumns(journalTable(`fx_rate NUMERIC(20,${REQUIRED_RATE_SCALE}) NOT NULL`))).toEqual([]);
    expect(findFloatRateColumns(journalTable('fx_rate NUMERIC(24,12) NOT NULL'))).toEqual([]);
  });

  it('detects a tampered rate added later by ALTER TABLE, not only at CREATE', () => {
    const findings = findFloatRateColumns('ALTER TABLE journal_lines ADD COLUMN settlement_rate DOUBLE PRECISION;');
    expect(findings).toEqual([{ table: 'journal_lines', column: 'settlement_rate', detail: expect.stringMatching(/floating-point/) }]);
  });

  it('watches a future accounting_* table the day it is created, not the day someone lists it', () => {
    expect(findFloatRateColumns('CREATE TABLE accounting_fx_snapshots (business_id UUID, rate REAL);')).toHaveLength(1);
    expect(isRateAuthorityTable('accounting_anything_at_all')).toBe(true);
  });

  it('is scoped: a percentage outside accounting authority stays declarable', () => {
    // A marketing funnel, a tax percentage on a product, a delivery surcharge.
    // None of these is a ledger rate, and banning them would make the guard
    // something a contributor works around rather than with.
    expect(findFloatRateColumns('CREATE TABLE campaigns (conversion_rate DOUBLE PRECISION);')).toEqual([]);
    expect(findFloatRateColumns('CREATE TABLE products (tax_rate REAL, price_minor BIGINT);')).toEqual([]);
    expect(isRateAuthorityTable('campaigns')).toBe(false);
  });

  it('reads the column NAME the way a human would, not by substring', () => {
    // `rate` as a whole token is a rate; `aggregate` and `rating` are not.
    expect(isRateColumn('fx_rate')).toBe(true);
    expect(isRateColumn('payment_to_base_rate')).toBe(true);
    expect(isRateColumn('fx_rate_source')).toBe(true);
    expect(isRateColumn('aggregate')).toBe(false);
    expect(isRateColumn('rating')).toBe(false);
    expect(isRateColumn('generated')).toBe(false);
    expect(findFloatRateColumns('CREATE TABLE journal_lines (aggregate DOUBLE PRECISION, rating REAL);')).toEqual([]);
  });

  it('the real migration tree is clean and the guard is watching a rate column that exists', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    for (const file of files) expect(findFloatRateColumns(readFileSync(join(MIGRATIONS, file), 'utf8'))).toEqual([]);
    // If the journal ever stops declaring a rate, this guard would pass
    // vacuously; it must be proven to have a live subject.
    const journal = readFileSync(join(MIGRATIONS, '0042_accounting_journal.sql'), 'utf8');
    expect(journal).toMatch(/fx_rate\s+NUMERIC\(20,\s*10\)/i);
  });

  it('is wired into static-guards.ts, not merely available to be imported', () => {
    const guards = readFileSync(join(ROOT, 'scripts/static-guards.ts'), 'utf8');
    expect(guards).toMatch(/findFloatRateColumns/);
  });
});

/**
 * Guard G-1 (directive §34), tested as a MODEL. The live-catalogue comparison
 * is in tests/security/journal-privilege-matrix.test.ts, where a real database
 * exists; here the question is whether the model itself still says what P2-S2
 * decided, and whether the comparator actually reports a difference.
 */
describe('guard G-1 — the intended journal privilege model', () => {
  const live = (table: string, grantee: string, privilege: string) => ({ table, grantee, privilege });
  const intended = (): { table: string; grantee: string; privilege: string }[] =>
    Object.entries(INTENDED_TABLE_GRANTS).flatMap(([table, grants]) =>
      Object.entries(grants).flatMap(([grantee, privileges]) => privileges.map((privilege) => live(table, grantee, privilege))),
    );

  it('grants no RUNTIME credential a write privilege, on any accounting table', () => {
    // The permanent invariant. P2-S3 added a writer, so "nobody writes" is no
    // longer the rule; "no credential a service authenticates as writes" is,
    // and always was the one that mattered (§69).
    for (const [table, grants] of Object.entries(INTENDED_TABLE_GRANTS)) {
      for (const [grantee, privileges] of Object.entries(grants)) {
        if (!(RUNTIME_ROLES as readonly string[]).includes(grantee)) continue;
        for (const privilege of privileges) {
          expect(WRITE_PRIVILEGES, `${grantee} would write ${table}`).not.toContain(privilege);
        }
      }
    }
  });

  it('lets the posting authority INSERT and never rewrite or destroy posted truth', () => {
    for (const table of JOURNAL_TABLES) {
      expect(INTENDED_TABLE_GRANTS[table]?.[INTERNAL_ROLE], table).toEqual(['INSERT', 'SELECT']);
    }
    // And it cannot destroy key material either.
    expect(INTENDED_TABLE_GRANTS['accounting_assertion_keys']?.[INTERNAL_ROLE]).not.toContain('DELETE');
  });

  it('keeps the closed registries at default deny for every runtime role', () => {
    for (const registry of ACCOUNTING_REGISTRY_TABLES) {
      const grantees = Object.keys(INTENDED_TABLE_GRANTS[registry] ?? {});
      expect(
        grantees.filter((g) => g !== INTERNAL_ROLE),
        registry,
      ).toEqual([]);
    }
  });

  it('accepts a catalogue that matches the model exactly', () => {
    expect(compareTableGrants(intended())).toEqual([]);
  });

  it('detects the GRANT nobody remembered to write a negative test for', () => {
    const tampered = [...intended(), live('journal_lines', 'daftar_worker', 'INSERT')];
    expect(compareTableGrants(tampered).join(' ')).toMatch(/daftar_worker holds INSERT on journal_lines/);
    expect(compareTableGrants(tampered).join(' ')).toMatch(/RUNTIME principal must never hold journal DML/);
  });

  it('detects a read grant to a role that should have none, not only a write grant', () => {
    expect(compareTableGrants([...intended(), live('journal_entries', 'daftar_identity', 'SELECT')]).join(' ')).toMatch(
      /daftar_identity holds SELECT on journal_entries/,
    );
    expect(compareTableGrants([...intended(), live('accounting_source_types', 'daftar_app', 'SELECT')]).join(' ')).toMatch(/does not include/);
  });

  it('detects PUBLIC being handed the ledger', () => {
    expect(compareTableGrants([...intended(), live('journal_lines', 'PUBLIC', 'SELECT')]).join(' ')).toMatch(/PUBLIC holds SELECT on journal_lines/);
  });

  it('detects a grant silently disappearing, so the validators cannot see a whole entry', () => {
    const missing = intended().filter((g) => !(g.table === 'journal_lines' && g.grantee === 'daftar_accounting_internal'));
    expect(compareTableGrants(missing).join(' ')).toMatch(/is missing/);
  });

  it('ignores tables outside the journal, so an unrelated grant is not a false alarm', () => {
    expect(compareTableGrants([...intended(), live('products', 'daftar_app', 'INSERT')])).toEqual([]);
  });
});

/**
 * P2-S2 structural regressions (directive §42). These read the migration text
 * rather than a database: they are the checks the gate performs, held here as
 * tests so that a change which removes one fails loudly in the normal suite
 * and not only when someone runs the gate.
 */
describe('P2-S2 migration boundary', () => {
  const files = (): string[] =>
    readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  const journal = (): string => readFileSync(join(MIGRATIONS, '0042_accounting_journal.sql'), 'utf8');
  const invariants = (): string => readFileSync(join(MIGRATIONS, '0043_accounting_invariants.sql'), 'utf8');

  it('P2-S2 shipped 0042 and 0043 (later authorized migrations are allowed)', () => {
    expect(files()).toContain('0042_accounting_journal.sql');
    expect(files()).toContain('0043_accounting_invariants.sql');
    // Deliberately NOT asserting "nothing after 0043": P2-S2 is frozen and its
    // gate must never block P2-S3's authorized 0044/0045 (freeze §6).
  });

  it('0042 and 0043 are FROZEN at their accepted hashes (P2-S2 freeze §5)', () => {
    const accepted = {
      '0042_accounting_journal.sql': '78c852cd1f5888013a02244327a1eb606e3f0fd9582fbbed2018b9382cb92e33',
      '0043_accounting_invariants.sql': '9744da043d3c8b3fe68af30b135e5f5f36207ec5b457d115a3f5a465d268e70f',
    } as const;
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
    for (const [name, sha256] of Object.entries(accepted)) {
      // On disk and in the manifest, both against the accepted literal.
      expect(
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS, name)))
          .digest('hex'),
        `${name} on disk`,
      ).toBe(sha256);
      expect(frozen.get(name), `${name} in manifest`).toBe(sha256);
    }
    expect(manifest.frozenThrough >= '0043_accounting_invariants.sql').toBe(true);
    // The P2-S2 gate carries the same hashes as an independent second source.
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s2-gate.ts'), 'utf8');
    for (const [name, sha256] of Object.entries(accepted)) expect(gate, `${name} in gate`).toContain(sha256);
  });

  it('0044 and 0045 are FROZEN at their accepted hashes (P2-S3 freeze §4)', () => {
    // Digest and file name on separate lines, for the reason the P2-S3 gate
    // explains: a 64-hex literal beside the word "keys" reads as a credential
    // to gitleaks, and a migration digest must not look like a secret.
    const digests: Readonly<Record<string, string>> = {
      '0044': 'cf49b196598e5dc829b56e656bc7883a2fed3a54f6631cf0bdf112c4521a0902',
      '0045': '84fa101e1c25e880b7850a96abd05a5efabd068cec56397c3b465ca11847cb2e',
    };
    const accepted: Readonly<Record<string, string>> = {
      '0044_accounting_assertion_keys.sql': digests['0044'] ?? '',
      '0045_accounting_post_entry.sql': digests['0045'] ?? '',
    };
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
    for (const [name, sha256] of Object.entries(accepted)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS, name)))
          .digest('hex'),
        `${name} on disk`,
      ).toBe(sha256);
      expect(frozen.get(name), `${name} in manifest`).toBe(sha256);
    }
    expect(manifest.frozenThrough >= '0045_accounting_post_entry.sql').toBe(true);
    // A FLOOR, not an exact count. This case asserted exactly 46 until P2-S4
    // was accepted and its two migrations were frozen — which is precisely
    // the shape of failure a permanent predecessor check must not have: what
    // P2-S3 guarantees is that its own history is intact, never that nobody
    // was authorized to add to it.
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(46);
    // The P2-S3 gate carries the same hashes as an independent second source,
    // so one commit cannot move a migration and its recorded hash together.
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s3-gate.ts'), 'utf8');
    for (const [name, sha256] of Object.entries(accepted)) expect(gate, `${name} in gate`).toContain(sha256);
  });

  it('0046 and 0047 are FROZEN at their accepted hashes (P2-S4 freeze §5)', () => {
    // Digest and file name on separate lines, as the P2-S3 case above explains.
    const digests: Readonly<Record<string, string>> = {
      '0046': '6e4500dcc639149ac25d3e0736bbce77ff372aa06736c1211fe40725e7d196e6',
      '0047': '0938d513c0bb844c5f36cbdb170612a08f9f52f828660ca88e2db00aeea1cabc',
    };
    const accepted: Readonly<Record<string, string>> = {
      '0046_accounting_sources.sql': digests['0046'] ?? '',
      '0047_accounting_opening_balances.sql': digests['0047'] ?? '',
    };
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
    for (const [name, sha256] of Object.entries(accepted)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS, name)))
          .digest('hex'),
        `${name} on disk`,
      ).toBe(sha256);
      expect(frozen.get(name), `${name} in manifest`).toBe(sha256);
    }
    expect(manifest.frozenThrough >= '0047_accounting_opening_balances.sql').toBe(true);
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(48);
    // The P2-S4 gate carries the same hashes as an independent second source.
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s4-gate.ts'), 'utf8');
    for (const [name, sha256] of Object.entries(accepted)) expect(gate, `${name} in gate`).toContain(sha256);
    // Deliberately NOT asserting "nothing after 0047": P2-S4 is frozen and its
    // gate must never block an authorized successor.
  });

  it('0048 is FROZEN at its accepted hash (P2-S5 freeze §4)', () => {
    // Digest and file name on separate lines, as the P2-S3 case above explains.
    const digests: Readonly<Record<string, string>> = {
      '0048': '5438538a9f335c918b231db3faa94dd4eac7b71a1a688d1c62b5cda9f8ee4cc1',
    };
    const accepted: Readonly<Record<string, string>> = {
      '0048_accounting_fx_rates.sql': digests['0048'] ?? '',
    };
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
    for (const [name, sha256] of Object.entries(accepted)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS, name)))
          .digest('hex'),
        `${name} on disk`,
      ).toBe(sha256);
      expect(frozen.get(name), `${name} in manifest`).toBe(sha256);
    }
    expect(manifest.frozenThrough >= '0048_accounting_fx_rates.sql').toBe(true);
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(49);
    // The P2-S5 gate carries the same hash as an independent second source.
    const gate = readFileSync(join(ROOT, 'scripts/phase2-s5-gate.ts'), 'utf8');
    for (const [name, sha256] of Object.entries(accepted)) expect(gate, `${name} in gate`).toContain(sha256);
    // As above: no assertion that nothing follows 0048.
  });

  it('every business-scoped journal table carries both tenant_id and business_id (§14)', () => {
    const sql = journal();
    for (const table of ['journal_entries', 'journal_lines', 'accounting_source_bindings']) {
      const body = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql)?.[1] ?? '';
      expect(body, table).toMatch(/\btenant_id\s+UUID\s+NOT NULL/i);
      expect(body, table).toMatch(/\bbusiness_id\s+UUID\s+NOT NULL/i);
    }
  });

  it('both commit-time validators exist and both are deferred (§28)', () => {
    const sql = invariants();
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER journal_entry_validate[\s\S]{0,400}?ON journal_entries[\s\S]{0,200}?DEFERRABLE INITIALLY DEFERRED/i);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER journal_line_validate[\s\S]{0,400}?ON journal_lines[\s\S]{0,200}?DEFERRABLE INITIALLY DEFERRED/i);
  });

  it('the source binding keeps both deferred foreign-key directions (§19)', () => {
    const sql = journal();
    expect(sql).toMatch(/CONSTRAINT\s+accounting_source_bindings_entry_fk\s+FOREIGN KEY[\s\S]{0,300}?DEFERRABLE INITIALLY DEFERRED/i);
    expect(sql).toMatch(/CONSTRAINT\s+journal_entries_binding_fk\s+FOREIGN KEY[\s\S]{0,300}?DEFERRABLE INITIALLY DEFERRED/i);
  });

  it('immutability is unconditional — no identity is exempt (§27)', () => {
    const sql = journal();
    for (const table of ['journal_entries', 'journal_lines', 'accounting_source_bindings']) {
      expect(sql, table).toMatch(new RegExp(`CREATE\\s+TRIGGER\\s+\\w+\\s+BEFORE\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${table}\\b`, 'i'));
    }
    const bodies = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w*immutable\w*)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi)].map((m) => m[2] ?? '');
    expect(bodies.length).toBeGreaterThan(0);
    // An identity test inside the refusal would be exactly the hidden "admin"
    // bypass §27 forbids: platform, support and the migration credential are
    // all refused the same way an application would be.
    for (const body of bodies) expect(body).not.toMatch(/current_user|session_user|current_setting\(/i);
  });

  it('the accepted 0042/0043 shipped no writer or assertion surface (§40)', () => {
    // Scoped to P2-S2's own two migrations: a permanent gate must not forbid
    // P2-S3's authorized 0044/0045 surfaces (freeze §6).
    const schema = stripComments([journal(), invariants()].join('\n'));
    for (const surface of P2_S2_EXCLUDED_SURFACES) {
      expect(schema, surface).not.toMatch(new RegExp(`CREATE\\s+(?:TABLE|VIEW|OR REPLACE FUNCTION|FUNCTION|PROCEDURE)\\s+${surface}\\b`, 'i'));
    }
    expect(schema).not.toMatch(/session_replication_role/i);
  });

  it('the base-amount expectation is derived, never ROUND()ed, and sums are NUMERIC (§22, §24)', () => {
    const sql = stripComments(invariants());
    expect(sql).not.toMatch(/\bROUND\s*\(/i);
    expect(sql).toMatch(/accounting_pow10/);
    // Every SUM over a minor-unit column casts first: four lines at the money
    // cap would overflow a BIGINT sum before the balance check could run.
    for (const match of sql.matchAll(/SUM\s*\(([^)]*)\)/gi)) {
      if (/amount_minor/i.test(match[1] ?? '')) expect(match[1], match[0]).toMatch(/::\s*numeric/i);
    }
  });
});
