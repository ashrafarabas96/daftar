/**
 * T-02 — OD-03 AND "NO ROLE CHANGE", OVER THE FROZEN PHASE 3 FILES
 * (docs/PHASE_3_S9_CONTRACT.md A-06, §7 T-02). BLOCKED BY OD-03.
 *
 * Once the Phase 3 prefix is pinned by digest, any property of those 21 files
 * (the slices' 0053–0069 and the corrective hardening's 0070–0073)
 * is fixed forever. It is therefore proved once, here, by a permanent test
 * over exactly `PHASE3_PREFIX`, rather than by a gate step that would restate
 * the S4–S6 gates or forbid a later, authorized tax migration:
 *
 *   - no `tax_payable`, and no tax rate / percentage / inclusive column (the
 *     S4 gate's form, `scripts/phase3-s4-gate.ts`);
 *   - `purchases_tax_policy_absent_ck CHECK (tax_minor = 0)` is present in 0063;
 *   - no `CREATE ROLE`, `ALTER ROLE`, `GRANT daftar_<x> TO` or
 *     `ALTER DEFAULT PRIVILEGES`: roles and memberships belong to bootstrap.
 *
 * Comments are stripped first. A bare `BYPASSRLS` token is deliberately NOT a
 * predicate: 0069 legitimately names it inside a RAISE message.
 *
 * Runtime proof of OD-03 is elsewhere and composed: the S4 and S6 tax suites
 * and the web OD-03 test. Tax rates, inclusive/exclusive rules and tax posting
 * stay BLOCKED BY OD-03.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../scripts/guards/sql-schema';
import { PHASE3_PREFIX } from '../../scripts/phase3-prefix';

const REPO = join(__dirname, '../..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const TAX_CHECK_FILE = '0063_purchases_suppliers_sources.sql';

/** Each predicate answers the findings it makes in one comment-stripped file. */
const PREDICATES: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['names tax_payable (purchase tax posting is BLOCKED BY OD-03)', /\btax_payable\b/i],
  ['defines a tax rate, percentage or inclusive column (BLOCKED BY OD-03)', /^\s*\w*(tax_rate|tax_percent\w*|\w*inclusive\w*)\s+[A-Z]/im],
  ['creates a role', /\bCREATE\s+ROLE\b/i],
  ['alters a role', /\bALTER\s+ROLE\b/i],
  ['grants a role membership', /\bGRANT\s+daftar_\w+(\s*,\s*daftar_\w+)*\s+TO\b/i],
  ['alters default privileges', /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i],
];

const ZERO_TAX_CHECK = /CONSTRAINT\s+purchases_tax_policy_absent_ck\s+CHECK\s*\(\s*tax_minor\s*=\s*0\s*\)/i;

function scopeFindings(sql: string): string[] {
  const text = stripComments(sql);
  return PREDICATES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

const read = (name: string): Buffer => readFileSync(join(MIGRATIONS, name));

describe('the scanned files are exactly the accepted Phase 3 prefix', () => {
  it('each file is read at its accepted digest', () => {
    for (const [name, digest] of PHASE3_PREFIX) expect(createHash('sha256').update(read(name)).digest('hex'), name).toBe(digest);
  });
});

describe('OD-03 and no role change hold over every Phase 3 file', () => {
  for (const [name] of PHASE3_PREFIX) {
    it(name, () => {
      expect(scopeFindings(read(name).toString('utf8'))).toEqual([]);
    });
  }

  it(`${TAX_CHECK_FILE} bounds purchase tax to zero with purchases_tax_policy_absent_ck`, () => {
    expect(stripComments(read(TAX_CHECK_FILE).toString('utf8'))).toMatch(ZERO_TAX_CHECK);
  });
});

describe('red: every predicate fires on a planted statement, and only there', () => {
  const planted: readonly (readonly [string, string])[] = [
    ['names tax_payable (purchase tax posting is BLOCKED BY OD-03)', "INSERT INTO accounts (system_key) VALUES ('tax_payable');"],
    ['defines a tax rate, percentage or inclusive column (BLOCKED BY OD-03)', 'CREATE TABLE t (\n  id UUID,\n  tax_rate NUMERIC NOT NULL\n);'],
    ['defines a tax rate, percentage or inclusive column (BLOCKED BY OD-03)', 'CREATE TABLE t (\n  tax_percentage INTEGER\n);'],
    ['defines a tax rate, percentage or inclusive column (BLOCKED BY OD-03)', 'ALTER TABLE t ADD COLUMN\n  price_is_tax_inclusive BOOLEAN;'],
    ['creates a role', 'CREATE ROLE daftar_extra NOLOGIN;'],
    ['alters a role', 'ALTER ROLE daftar_migrator BYPASSRLS;'],
    ['grants a role membership', 'GRANT daftar_inventory_internal TO daftar_app;'],
    ['grants a role membership', 'GRANT daftar_platform, daftar_inventory_internal TO daftar_app;'],
    ['alters default privileges', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO daftar_app;'],
  ];
  for (const [label, sql] of planted) {
    it(`${label}: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`, () => {
      expect(scopeFindings(sql)).toContain(label);
    });
  }

  it('a RAISE message naming BYPASSRLS is not a finding', () => {
    expect(scopeFindings("RAISE EXCEPTION 'inventory.reconciler_shape_invalid: daftar_reconciler must not hold BYPASSRLS';")).toEqual([]);
  });

  it('a comment naming a forbidden statement is not a finding', () => {
    expect(scopeFindings('-- no CREATE ROLE, no tax_payable, no GRANT daftar_x TO y here\n/* ALTER DEFAULT PRIVILEGES */\nSELECT 1;')).toEqual([]);
  });

  it('an ordinary privilege grant to a role is not a membership grant', () => {
    expect(scopeFindings('GRANT SELECT ON stock_movements TO daftar_reconciler;')).toEqual([]);
  });

  it('a missing zero-tax CHECK is noticed', () => {
    const without = read(TAX_CHECK_FILE)
      .toString('utf8')
      .replace(/CONSTRAINT\s+purchases_tax_policy_absent_ck\s+CHECK\s*\(\s*tax_minor\s*=\s*0\s*\)/, 'CHECK (tax_minor >= 0)');
    expect(stripComments(without)).not.toMatch(ZERO_TAX_CHECK);
  });
});
