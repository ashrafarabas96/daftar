import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNTING_AUTHORITY_TABLES, findAuthoritativeBalanceColumns, isAuthoritativeBalanceColumn } from '../../scripts/guards/no-authoritative-balance';
import { LOGIN_ROLES, findAuthorityViolations, parseTableGrants } from '../../scripts/guards/authority-isolation';

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
