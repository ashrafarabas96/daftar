import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEDGER_TABLES,
  POSTING_CALLER,
  POSTING_PRIMITIVE,
  REQUIRED_PROTECTIONS,
  findPostingSurfaceViolations,
  postingPrimitiveGrantees,
} from '../../scripts/guards/posting-surface';

/**
 * GUARD G-4 — the writer may not exist without its protections (§67).
 *
 * The guard is tested the way a guard has to be: not by confirming that
 * today's tree passes, which proves only that nothing is broken right now,
 * but by taking each protection away in turn and requiring the guard to
 * notice. If a future edit made one of these checks vacuous — a regex that no
 * longer matches, a rule accidentally commented out — exactly one case here
 * would go green while the tree stayed broken, and that is the signal.
 */

const MIGRATIONS = join(__dirname, '../../infrastructure/database/migrations');

const schema = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

const clean = { appFiles: {} as Record<string, string> };

describe('G-4 — the tree as it stands', () => {
  it('accepts the real migrations: the writer exists and every protection is present', () => {
    expect(findPostingSurfaceViolations({ schema: schema(), ...clean })).toEqual([]);
  });

  it('grants the primitive to the merchant runtime and to nobody else', () => {
    expect(postingPrimitiveGrantees(schema())).toEqual([POSTING_CALLER]);
  });

  it('is watching something: the writer it exists for is really in the tree', () => {
    expect(schema()).toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${POSTING_PRIMITIVE}\\b`, 'i'));
    expect(REQUIRED_PROTECTIONS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('G-4 — every protection, taken away in turn', () => {
  // Each case is the removal as it would actually be written: a line deleted
  // to fix a test, a grant widened to unblock a job, a check removed because
  // "a later phase will add it back".
  const removals: ReadonlyArray<readonly [string, (s: string) => string, RegExp]> = [
    [
      'the assertion key registry',
      (s) => s.replace(/CREATE TABLE accounting_assertion_keys/g, 'CREATE TABLE something_else_keys'),
      /without its assertion key registry/,
    ],
    ['the replay registry', (s) => s.replace(/CREATE TABLE accounting_assertion_uses/g, 'CREATE TABLE something_else_uses'), /without its replay registry/],
    [
      'the verifier',
      (s) => s.replace(/CREATE OR REPLACE FUNCTION accounting_actor/g, 'CREATE OR REPLACE FUNCTION not_the_verifier'),
      /without its assertion verifier/,
    ],
    ['the HMAC check', (s) => s.replace(/hmac\(/g, 'digest('), /without its HMAC verification/],
    ['the canonical fingerprint', (s) => s.replace(/accounting_fingerprint\(/g, 'some_other_digest('), /without its canonical fingerprint recomputation/],
    ['the mismatch refusal', (s) => s.replace(/accounting\.assertion_payload_mismatch/g, 'accounting.something_else'), /without its payload mismatch refusal/],
    [
      'the source binding write',
      (s) => s.replace(/INSERT INTO accounting_source_bindings/g, 'SELECT FROM accounting_source_bindings'),
      /without its source binding insert/,
    ],
    ['the audit write', (s) => s.replace(/INSERT INTO audit_events/g, 'SELECT FROM audit_events'), /without its audit insert/],
    ['the outbox write', (s) => s.replace(/INSERT INTO outbox_events/g, 'SELECT FROM outbox_events'), /without its outbox insert/],
    ['the idempotency lock', (s) => s.replace(/pg_advisory_xact_lock\(/g, 'pg_sleep(0) -- ('), /without its idempotency lock/],
    [
      'the unreachable owner',
      (s) =>
        s.replace(
          new RegExp(`ALTER FUNCTION ${POSTING_PRIMITIVE}\\(DATE, TEXT, TEXT, JSONB\\) OWNER TO daftar_accounting_internal`, 'g'),
          `ALTER FUNCTION ${POSTING_PRIMITIVE}(DATE, TEXT, TEXT, JSONB) OWNER TO daftar_platform`,
        ),
      /without its security definer, owned by the unreachable principal/,
    ],
    [
      'the PUBLIC revoke',
      (s) => s.replace(new RegExp(`REVOKE ALL ON FUNCTION ${POSTING_PRIMITIVE}\\(DATE, TEXT, TEXT, JSONB\\) FROM PUBLIC;`, 'g'), ''),
      /without its EXECUTE revoked from PUBLIC/,
    ],
  ];

  for (const [what, remove, expected] of removals) {
    it(`notices ${what} going missing`, () => {
      const damaged = remove(schema());
      expect(damaged, `the removal did not change the schema — this case proves nothing`).not.toBe(schema());
      expect(findPostingSurfaceViolations({ schema: damaged, ...clean }).join('\n')).toMatch(expected);
    });
  }
});

describe('G-4 — who may reach the writer', () => {
  it('refuses the primitive being granted to the platform credential', () => {
    const widened = `${schema()}\nGRANT EXECUTE ON FUNCTION ${POSTING_PRIMITIVE}(DATE, TEXT, TEXT, JSONB) TO daftar_platform;`;
    expect(findPostingSurfaceViolations({ schema: widened, ...clean }).join('\n')).toMatch(
      /granted EXECUTE to daftar_platform .*platform administration is not financial authority/,
    );
  });

  it('refuses the primitive being granted to PUBLIC', () => {
    const widened = `${schema()}\nGRANT EXECUTE ON FUNCTION ${POSTING_PRIMITIVE}(DATE, TEXT, TEXT, JSONB) TO PUBLIC;`;
    expect(findPostingSurfaceViolations({ schema: widened, ...clean }).join('\n')).toMatch(/granted EXECUTE to PUBLIC/);
  });

  it('refuses a writer nobody can call — dead code or a lost grant, and either is wrong', () => {
    const orphaned = schema().replace(new RegExp(`GRANT EXECUTE ON FUNCTION ${POSTING_PRIMITIVE}[^;]*;`, 'g'), '');
    expect(findPostingSurfaceViolations({ schema: orphaned, ...clean }).join('\n')).toMatch(/granted to nobody/);
  });

  it('refuses a migration handing a runtime role direct ledger DML', () => {
    for (const role of ['daftar_app', 'daftar_worker', 'daftar_platform']) {
      const widened = `${schema()}\nGRANT INSERT ON journal_lines TO ${role};`;
      expect(findPostingSurfaceViolations({ schema: widened, ...clean }).join('\n'), role).toMatch(new RegExp(`grants ${role} direct DML on the ledger`));
    }
  });
});

describe('G-4 — application code may CALL the writer and never replace it', () => {
  for (const table of LEDGER_TABLES) {
    it(`refuses application code that inserts into ${table}`, () => {
      const appFiles = { 'apps/api/src/modules/whatever/some.service.ts': `await c.query(\`INSERT INTO ${table} (id) VALUES ($1)\`);` };
      expect(findPostingSurfaceViolations({ schema: schema(), appFiles }).join('\n')).toMatch(new RegExp(`some\\.service\\.ts issues .INSERT INTO ${table}`));
    });

    it(`refuses application code that updates or deletes ${table}`, () => {
      for (const sql of [`UPDATE ${table} SET x = 1`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        const appFiles = { 'apps/api/src/x.ts': `await c.query(\`${sql}\`);` };
        expect(findPostingSurfaceViolations({ schema: schema(), appFiles }).join('\n'), sql).toMatch(/may only CALL accounting_post_entry/);
      }
    });
  }

  it('accepts the real transport adapter, which only calls the primitive', () => {
    const adapter = readFileSync(join(__dirname, '../../apps/api/src/modules/accounting/accounting-posting.adapter.ts'), 'utf8');
    expect(adapter).toMatch(new RegExp(POSTING_PRIMITIVE));
    expect(findPostingSurfaceViolations({ schema: schema(), appFiles: { adapter } })).toEqual([]);
  });
});

describe('G-4 — the implication, not a blanket rule', () => {
  it('says nothing about a tree that has no writer at all', () => {
    // P2-S1 and P2-S2 had no posting primitive and must not be retroactively
    // failed by a rule about one. The guard is an implication on purpose.
    const beforeTheWriter = schema()
      .replace(new RegExp(`CREATE OR REPLACE FUNCTION ${POSTING_PRIMITIVE}`, 'g'), 'CREATE OR REPLACE FUNCTION nothing_of_the_sort')
      .replace(new RegExp(`GRANT EXECUTE ON FUNCTION ${POSTING_PRIMITIVE}[^;]*;`, 'g'), '');
    expect(findPostingSurfaceViolations({ schema: beforeTheWriter, ...clean })).toEqual([]);
  });
});
