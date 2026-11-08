import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * DR-100 ITEM 2 — MIGRATION `0088` IS THE ACCEPTED TEST DDL, AND NOTHING ELSE.
 *
 * DR-100 says the Phase 5 billing DDL under `packages/billing/test/db/sql/` is
 * FOR THE TEST LANE ONLY, and that the production billing tables come from a
 * sequentially numbered migration. The number `0088` is reserved for it in
 * `.local-context/LANES.md`.
 *
 * This law is the tie between the two files. It does not assert that the DDL is
 * correct — `packages/billing/test/db/run-db-proof-real-schema.sh` is what
 * executed it against the real schema, on Linux, after applying the whole
 * migration history with the project's own runner. What this law asserts is
 * that the migration carries THAT text and not a retyped approximation of it:
 * a production money schema that drifted from the DDL the proof ran against
 * would make every figure in that proof a statement about a different schema.
 *
 * ── LINE ENDINGS: THE NORMALIZATION IS APPLIED, AND IT IS APPLIED FIRST ──
 * Both files are read as bytes and `\r\n` is collapsed to `\n` BEFORE any
 * comparison, because this repository is also checked out on Windows with
 * `core.autocrlf=true`, where a check that reads a text file from disk is not
 * measurable otherwise (RULE-23: `prettier --check` and the review-index check
 * were both marked red by line endings and not by content). Every assertion
 * below therefore speaks about content. A case also asserts that no `\r`
 * survives the normalization, so the normalization is measured rather than
 * assumed.
 *
 * ── THE DECLARED SUBSTITUTIONS: TWO, NAMED, AND NOTHING ELSE ──
 * The DDL is written for its own schema and its own lane roles. Exactly two
 * substitutions turn it into production text, they are listed in
 * `DECLARED_SUBSTITUTIONS` below, they are the same two named in the
 * migration's own header, and this law recomputes the migration from the DDL
 * with those two applied and with nothing else changed.
 *
 * ── THE SINGLE DECLARED EXCEPTION ──
 * `CREATE SEQUENCE … scratch_period_seq` is a fixture convenience: `nextval`
 * on it is called only from `packages/billing/test/db/*.test.ts` and
 * `test/db/helpers/finalize.ts`, and no constraint, default or index in the
 * DDL refers to it. It is the ONE object the migration drops, and it is
 * measured in both directions — present in the DDL, absent from the migration
 * — so the exception is a fact and not a silent hole.
 */

const ROOT = join(__dirname, '..');
const DDL_PATH = join(ROOT, 'packages', 'billing', 'test', 'db', 'sql', 'credit-ledger-scratch.sql');
const MIGRATION_PATH = join(ROOT, 'infrastructure', 'database', 'migrations', '0088_p5_billing_platform_credit_ledger.sql');
const MANIFEST_PATH = join(ROOT, 'infrastructure', 'database', 'MIGRATION_MANIFEST.json');

/**
 * The whole transformation, as data. `from` is a lane name, `to` is the
 * production name, and the reason is the one written in the migration header.
 */
const DECLARED_SUBSTITUTIONS: readonly { readonly from: string; readonly to: string }[] = [
  // The schema. The real-schema lane resolves the borrowed relations through
  // `search_path` with `P5_BORROWED_SCHEMA=public`; production IS `public`.
  { from: 'p5scratch', to: 'public' },
  // The invariant principal admitted by the RESTRICTIVE policies. `p5_invariants`
  // is a lane role created by `test/db/sql/credit-ledger-bootstrap.sql` and does
  // not exist in `infrastructure/database/bootstrap.sql`; the house analogue the
  // DDL's own comment names is `journal_lines.business_isolation` admitting
  // `daftar_accounting_internal`. THIS ONE IS AN OWNER DECISION, not a
  // mechanical rename, and the migration header says so by name.
  { from: 'p5_invariants', to: 'daftar_accounting_internal' },
];

/** The parity region begins after this line. */
const PARITY_MARKER = '-- ===== PARITY REGION BEGIN — byte-for-byte the accepted DDL under the two declared substitutions =====';

/**
 * ── THE SECOND DECLARED CATEGORY: THE HARDENING SECTION ─────────────────
 *
 * The parity region ENDS at this line, and everything after it is a separate,
 * declared category: `ALTER`/`REVOKE`/`GRANT` statements on objects the parity
 * region already created, each required by a STANDING SECURITY LAW of this
 * estate, because the accepted DDL was proved on a lane that applies it as
 * `daftar_platform` while `npm run migrate` applies it as `daftar_migrator` —
 * so the OWNER, the `search_path` and PostgreSQL's default `EXECUTE` for
 * PUBLIC all come out different here.
 *
 * Splitting the file into two declared categories is what keeps (a) and (b)
 * independent claims rather than one loose one:
 *
 *   (a) the parity region is STILL byte-for-byte the accepted DDL under the
 *       two declared substitutions — unchanged, and not weakened by one
 *       character to make room for the hardening;
 *   (b) the hardening section is EXACTLY `HARDENING_STATEMENTS`, in order,
 *       every statement carrying at least one `-- LAW:` reference that
 *       resolves to literal text really present in the file it names.
 *
 * So a hardening statement nobody can name a law for cannot be here, and a
 * statement removed from here cannot pass either: (b) is an equality, in both
 * directions, over the statement stream AND over the law references.
 */
const HARDENING_MARKER = '-- ===== PARITY REGION END — everything below is the DECLARED HARDENING SECTION =====';

/**
 * Every statement the hardening section may carry, in order. The list is the
 * law's left-hand side: it is not read from the file, so a statement added to
 * the file and not to this list is reported, and one removed from the file is
 * reported too. The law each one satisfies is NOT duplicated here — it is
 * written in the migration beside the statement, where a reviewer reads it,
 * and this law only asserts that it is there and that it resolves.
 */
const HARDENING_STATEMENTS: readonly string[] = [
  // (1) The four new relations, revoked from PUBLIC (phase4-s4-gate's text law).
  'REVOKE ALL ON TABLE public.platform_credit_adjustments FROM PUBLIC;',
  'REVOKE ALL ON TABLE public.platform_credit_grant_remainders FROM PUBLIC;',
  'REVOKE ALL ON TABLE public.subscription_invoices FROM PUBLIC;',
  'REVOKE ALL ON TABLE public.subscription_charge_attempts FROM PUBLIC;',
  // (2) The seven trigger functions the DDL left on PostgreSQL's PUBLIC default.
  'REVOKE ALL ON FUNCTION public.pca_append_only() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.pca_chronology() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.si_immutable() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.si_credit_agrees() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.pca_credit_agrees() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.sca_no_attempt_while_unresolved() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.sca_append_only_except_reconciliation() FROM PUBLIC;',
  // (3) The two DEFERRABLE INITIALLY DEFERRED guards, elevated. Nothing else is.
  'ALTER FUNCTION public.si_credit_agrees() SECURITY DEFINER;',
  'ALTER FUNCTION public.pca_credit_agrees() SECURITY DEFINER;',
  // (4) The pinned path, on all ten routines this file creates.
  'ALTER FUNCTION public.pca_maintain_remainder() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.lock_grants_in_order(uuid, uuid, text) SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.assert_invoice_credit_agrees(uuid) SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.pca_append_only() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.pca_chronology() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.si_immutable() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.si_credit_agrees() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.pca_credit_agrees() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.sca_no_attempt_while_unresolved() SET search_path = pg_catalog, public, pg_temp;',
  'ALTER FUNCTION public.sca_append_only_except_reconciliation() SET search_path = pg_catalog, public, pg_temp;',
  // (5) The hand-over of the five SECURITY DEFINER routines, inside the CREATE
  //     bracket PostgreSQL requires of the new owner, closed in this same file.
  'GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;',
  'ALTER FUNCTION public.pca_maintain_remainder() OWNER TO daftar_accounting_internal;',
  'ALTER FUNCTION public.lock_grants_in_order(uuid, uuid, text) OWNER TO daftar_accounting_internal;',
  'ALTER FUNCTION public.assert_invoice_credit_agrees(uuid) OWNER TO daftar_accounting_internal;',
  'ALTER FUNCTION public.si_credit_agrees() OWNER TO daftar_accounting_internal;',
  'ALTER FUNCTION public.pca_credit_agrees() OWNER TO daftar_accounting_internal;',
  'REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;',
];

const EXCEPTION_OBJECT = 'scratch_period_seq';
const EXCEPTION_STATEMENT = 'CREATE SEQUENCE public.scratch_period_seq;';
const EXCEPTION_MARKER =
  '-- OMITTED — THE SINGLE DECLARED EXCEPTION: `CREATE SEQUENCE scratch_period_seq` is a test-lane fixture convenience (nextval is called only from packages/billing/test/db/**), and no constraint, default or index in this schema refers to it.';

/** The lane role names that may survive in prose and never in executable text. */
const LANE_ONLY_TOKENS = ['p5scratch', 'p5_invariants', 'p5owner', 'p5ownerpw', 'p5_app', 'p5_stranger'] as const;

const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

const readNormalized = (path: string): string => normalizeEol(readFileSync(path, 'utf8'));

/**
 * Split SQL into statements on top-level `;`, aware of `$tag$` dollar quoting,
 * `'…'` strings with `''` escapes, and `--` line comments. A naive split on
 * `;` would cut every `plpgsql` body in this file in half.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      i = close === -1 ? sql.length : close + tag.length;
      continue;
    }
    if (sql[i] === ';') {
      const chunk = sql.slice(start, i + 1).trim();
      if (chunk.length > 0) out.push(chunk);
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Remove `--` comments from a statement, so executable text can be measured alone. */
function executableText(statement: string): string {
  return statement
    .split('\n')
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") {
          inString = !inString;
          continue;
        }
        if (!inString && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** The object a statement is about, for a failure message that names it. */
function objectOf(statement: string): string {
  const code = executableText(statement).replace(/\s+/g, ' ').trim();
  const named =
    /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:CONSTRAINT\s+)?(TABLE|INDEX|FUNCTION|POLICY|TRIGGER|SEQUENCE|SCHEMA|VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z0-9_."]+)/i.exec(
      code,
    );
  if (named) return `${(named[1] ?? '').toUpperCase()} ${named[2] ?? ''}`;
  const revoke = /\b(REVOKE|GRANT)\b[\s\S]{0,80}?\bON\s+(?:FUNCTION\s+)?([A-Za-z0-9_."]+)/i.exec(code);
  if (revoke) return `${(revoke[1] ?? '').toUpperCase()} ON ${revoke[2] ?? ''}`;
  return code.slice(0, 80);
}

/**
 * The parity region alone: from the parity marker to the hardening marker. A
 * missing hardening marker is NOT treated as "no hardening" — it would silently
 * put the hardening statements inside the parity comparison, so it throws.
 */
function parityRegion(migration: string): string {
  const start = migration.indexOf(PARITY_MARKER);
  if (start === -1) throw new Error('the parity marker is missing from the migration');
  const end = migration.indexOf(HARDENING_MARKER);
  if (end === -1) throw new Error('the hardening marker is missing from the migration, so the parity region has no end');
  if (end < start) throw new Error('the hardening marker precedes the parity marker');
  return migration.slice(start + PARITY_MARKER.length, end).replace(/^\n/, '');
}

/** One hardening statement with the law references written above it. */
interface HardeningEntry {
  readonly statement: string;
  readonly laws: readonly { readonly file: string; readonly needle: string }[];
}

/**
 * The hardening section, parsed as (law references, statement) pairs. Every
 * statement must be a SINGLE line ending in `;` — asserted, not assumed, so
 * that a statement wrapped over two lines is reported rather than mis-parsed —
 * and the `-- LAW:` lines that precede it, since the last statement, are its
 * references.
 */
function parseHardening(migration: string): { readonly entries: HardeningEntry[]; readonly malformed: string[] } {
  const at = migration.indexOf(HARDENING_MARKER);
  if (at === -1) throw new Error('the hardening marker is missing from the migration');
  const lines = migration.slice(at + HARDENING_MARKER.length).split('\n');
  const entries: HardeningEntry[] = [];
  const malformed: string[] = [];
  let laws: { file: string; needle: string }[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const law = /^--\s*LAW:\s*(\S+)\s*::\s*(.+)$/.exec(line);
    if (law !== null) {
      laws.push({ file: law[1] ?? '', needle: (law[2] ?? '').trim() });
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('--')) continue;
    if (!line.endsWith(';')) {
      malformed.push(`a hardening statement is not one line ending in ";": ${line.slice(0, 90)}`);
      laws = [];
      continue;
    }
    entries.push({ statement: line.trim(), laws });
    laws = [];
  }
  if (laws.length > 0) malformed.push(`${laws.length} trailing -- LAW: reference(s) belong to no statement`);
  return { entries, malformed };
}

function applySubstitutions(sql: string): string {
  let out = sql;
  for (const { from, to } of DECLARED_SUBSTITUTIONS) {
    out = out.split(from).join(to);
  }
  return out;
}

describe('DR-100 item 2 — migration 0088 carries the accepted billing DDL', () => {
  it('both files are present, and the CRLF normalization is applied and measured', () => {
    expect(existsSync(DDL_PATH), `the accepted DDL is missing: ${DDL_PATH}`).toBe(true);
    expect(
      existsSync(MIGRATION_PATH),
      `migration 0088 is missing: ${MIGRATION_PATH} — DR-100 item 2 reserves this exact filename in .local-context/LANES.md`,
    ).toBe(true);
    const ddl = readNormalized(DDL_PATH);
    const migration = readNormalized(MIGRATION_PATH);
    expect(ddl.includes('\r'), 'a CR survived normalization of the DDL').toBe(false);
    expect(migration.includes('\r'), 'a CR survived normalization of the migration').toBe(false);
    expect(ddl.length).toBeGreaterThan(0);
    expect(migration.length).toBeGreaterThan(0);
  });

  it('the migration declares the parity region, and its header names the two substitutions', () => {
    const migration = readNormalized(MIGRATION_PATH);
    expect(migration.split('\n').filter((l) => l === PARITY_MARKER)).toHaveLength(1);
    const header = migration.slice(0, migration.indexOf(PARITY_MARKER));
    for (const { from, to } of DECLARED_SUBSTITUTIONS) {
      expect(header, `the header does not name the substitution ${from} -> ${to}`).toContain(`${from}` + ' -> ' + `${to}`);
    }
  });

  it('the parity region is byte-for-byte the DDL under the two declared substitutions', () => {
    const ddl = readNormalized(DDL_PATH);
    const migration = readNormalized(MIGRATION_PATH);
    const substituted = applySubstitutions(ddl);
    const occurrences = substituted.split(EXCEPTION_STATEMENT).length - 1;
    expect(occurrences, `the declared exception statement must occur exactly once in the substituted DDL`).toBe(1);
    const expected = substituted.replace(EXCEPTION_STATEMENT, EXCEPTION_MARKER);
    const actual = parityRegion(migration);
    expect(actual).toBe(expected);
  });

  it('statement by statement, and a difference is reported by the object it is about', () => {
    const ddl = readNormalized(DDL_PATH);
    const migration = readNormalized(MIGRATION_PATH);
    const expected = splitStatements(applySubstitutions(ddl)).filter((s) => executableText(s).trim() !== '' && !s.includes(EXCEPTION_STATEMENT));
    const actual = splitStatements(parityRegion(migration)).filter((s) => executableText(s).trim() !== '');
    expect(expected.length, 'the accepted DDL produced no statements, so this comparison would be vacuous').toBeGreaterThan(20);
    const differing: string[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const e = expected[i];
      const a = actual[i];
      if (e === undefined) differing.push(`+ only in the migration: ${objectOf(a as string)}`);
      else if (a === undefined) differing.push(`- missing from the migration: ${objectOf(e)}`);
      else if (executableText(e).replace(/\s+/g, ' ').trim() !== executableText(a).replace(/\s+/g, ' ').trim())
        differing.push(`~ differs at statement ${i + 1}: DDL has ${objectOf(e)}, the migration has ${objectOf(a)}`);
    }
    expect(differing, `the migration's statement stream is not the accepted DDL's:\n${differing.join('\n')}`).toEqual([]);
    expect(actual).toHaveLength(expected.length);
  });

  it('the single declared exception is measured in both directions', () => {
    const ddl = readNormalized(DDL_PATH);
    const migration = readNormalized(MIGRATION_PATH);
    // Positive control: the probe finds the object where it IS, so its absence
    // below is a measurement and not an empty grep.
    expect(ddl.split(EXCEPTION_OBJECT).length - 1, `${EXCEPTION_OBJECT} must be in the accepted DDL`).toBeGreaterThan(0);
    // In the migration the name survives ONLY where the omission is declared:
    // zero occurrences in executable SQL, and the marker present exactly once.
    const inCode = splitStatements(migration)
      .map((s) => executableText(s))
      .join('\n');
    expect(inCode.split(EXCEPTION_OBJECT).length - 1, `${EXCEPTION_OBJECT} must not reach production as executable SQL`).toBe(0);
    expect(migration.split(EXCEPTION_MARKER).length - 1, 'the omission must be named in the migration').toBe(1);
    // Positive control for the same probe: it finds the object in the DDL's
    // executable text, so the zero above is a measurement and not an empty grep.
    const inDdlCode = splitStatements(ddl)
      .map((s) => executableText(s))
      .join('\n');
    expect(inDdlCode.split(EXCEPTION_OBJECT).length - 1, 'the probe found nothing in the DDL either').toBe(1);
  });

  it('no lane-only name survives in executable text, in either substituted direction', () => {
    const migration = readNormalized(MIGRATION_PATH);
    const offending: string[] = [];
    for (const statement of splitStatements(migration)) {
      const code = executableText(statement);
      for (const token of LANE_ONLY_TOKENS) {
        if (code.includes(token)) offending.push(`${token} in ${objectOf(statement)}`);
      }
    }
    expect(offending, `test-lane names in executable SQL: ${offending.join(', ')}`).toEqual([]);
    // Positive control for the same probe: the DDL, which HAS them.
    const inDdl = splitStatements(readNormalized(DDL_PATH)).filter((s) => LANE_ONLY_TOKENS.some((t) => executableText(s).includes(t)));
    expect(inDdl.length, 'the probe found no lane name in the DDL either, so its zero above proves nothing').toBeGreaterThan(0);
  });

  it('0088 is above the frozen set and moves nothing that is frozen', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    expect(manifest.frozenThrough).toBe('0079_phase4_pos_till_sessions_cart.sql');
    expect(manifest.migrations).toHaveLength(80);
    const names = manifest.migrations.map((m) => m.name);
    expect(names).not.toContain('0088_p5_billing_platform_credit_ledger.sql');
    expect(Number('0088')).toBeGreaterThan(Number(manifest.frozenThrough.slice(0, 4)));
  });

  it('the declared gap is written in the header and referred to the owner', () => {
    const migration = readNormalized(MIGRATION_PATH);
    const header = migration.slice(0, migration.indexOf(PARITY_MARKER));
    expect(header).toContain('period_starts_at');
    expect(header).toContain('period_ends_at');
    expect(header).toContain('invoice LINES');
    expect(header.toUpperCase()).toContain('OWNER');
  });
});

/**
 * DR-100 ITEM 2, SECOND CATEGORY — THE HARDENING SECTION, COUNTED AND LAWFUL.
 *
 * The parity law above says what the migration may NOT change. This one says
 * what it may ADD, and bounds it: a fixed, ordered list of
 * `ALTER`/`REVOKE`/`GRANT` statements on objects the parity region created,
 * each carrying at least one law reference that resolves to literal text in
 * the file it names.
 *
 * It is an equality in both directions, so it is red for a planted statement
 * AND for a deleted one, and the failure names the statement either way. The
 * law-reference half is a POSITIVE control on the naming: a fabricated
 * reference fails because the text is not in the file it claims, which is what
 * stops `-- LAW:` from becoming decoration.
 */
describe('DR-100 item 2 — the hardening section is exactly the law-commanded statements', () => {
  it('the two categories are disjoint and ordered: one parity marker, one hardening marker, in that order', () => {
    const migration = readNormalized(MIGRATION_PATH);
    expect(migration.split('\n').filter((l) => l === HARDENING_MARKER)).toHaveLength(1);
    expect(migration.indexOf(HARDENING_MARKER)).toBeGreaterThan(migration.indexOf(PARITY_MARKER));
    // The parity region carries no law reference: every one of them is in the
    // hardening section, so the two categories cannot blur into each other.
    expect(parityRegion(migration).includes('-- LAW:')).toBe(false);
    // And the section is not empty, so the equality below is not vacuous.
    expect(HARDENING_STATEMENTS.length).toBeGreaterThan(20);
  });

  it('every statement in the hardening section is one of the counted ones, in order, and none is missing', () => {
    const migration = readNormalized(MIGRATION_PATH);
    const { entries, malformed } = parseHardening(migration);
    expect(malformed, `the hardening section is not parseable statement by statement:\n${malformed.join('\n')}`).toEqual([]);
    const actual = entries.map((e) => e.statement);
    const differing: string[] = [];
    for (let i = 0; i < Math.max(actual.length, HARDENING_STATEMENTS.length); i++) {
      const e = HARDENING_STATEMENTS[i];
      const a = actual[i];
      if (e === undefined) differing.push(`+ a hardening statement no law counts: ${a ?? ''}`);
      else if (a === undefined) differing.push(`- a counted hardening statement is missing: ${e}`);
      else if (e !== a) differing.push(`~ at position ${i + 1} the counted statement is "${e}" and the file has "${a}"`);
    }
    expect(differing, `the hardening section is not the counted statement list:\n${differing.join('\n')}`).toEqual([]);
    expect(actual).toHaveLength(HARDENING_STATEMENTS.length);
  });

  it('every hardening statement names at least one law, and every law reference resolves to text in the file it names', () => {
    const migration = readNormalized(MIGRATION_PATH);
    const { entries } = parseHardening(migration);
    const problems: string[] = [];
    let resolved = 0;
    for (const entry of entries) {
      if (entry.laws.length === 0) {
        problems.push(`no law is named for: ${entry.statement}`);
        continue;
      }
      for (const law of entry.laws) {
        const path = join(ROOT, law.file);
        if (!existsSync(path)) {
          problems.push(`${entry.statement} names ${law.file}, which does not exist`);
          continue;
        }
        if (!normalizeEol(readFileSync(path, 'utf8')).includes(law.needle)) {
          problems.push(`${entry.statement} names ${law.file} :: ${law.needle}, and that text is not in that file`);
          continue;
        }
        resolved += 1;
      }
    }
    expect(problems, `the law references of the hardening section do not hold:\n${problems.join('\n')}`).toEqual([]);
    // Positive control for the same probe: it RESOLVED references, so the
    // empty problem list above is a measurement and not an empty loop.
    expect(resolved, 'no law reference was resolved at all, so the check above proves nothing').toBeGreaterThanOrEqual(entries.length);
    // And the probe can fail: a needle that is not in the file it names is
    // reported, measured here rather than asserted of the real references.
    const guardFile = 'tests/security/phase3-s8-definer-law.test.ts';
    expect(existsSync(join(ROOT, guardFile))).toBe(true);
    expect(normalizeEol(readFileSync(join(ROOT, guardFile), 'utf8')).includes('c3: pick((x) => x.public_exec)')).toBe(true);
    expect(normalizeEol(readFileSync(join(ROOT, guardFile), 'utf8')).includes('c9: pick((x) => x.no_such_clause)')).toBe(false);
  });

  it('the hardening section adds no relation, column, policy, trigger or routine', () => {
    const migration = readNormalized(MIGRATION_PATH);
    const { entries } = parseHardening(migration);
    const forbidden = /\b(CREATE\s+(TABLE|INDEX|POLICY|TRIGGER|FUNCTION|SEQUENCE|VIEW|SCHEMA)|DROP|INSERT|UPDATE|DELETE|TRUNCATE|ADD\s+COLUMN)\b/i;
    const offending = entries.filter((e) => forbidden.test(e.statement)).map((e) => e.statement);
    expect(offending, `the hardening section may only ALTER/REVOKE/GRANT: ${offending.join(', ')}`).toEqual([]);
    // Positive control: the forbidden recogniser does fire on a real DDL statement.
    expect(forbidden.test('CREATE TABLE public.x (id uuid);')).toBe(true);
    for (const e of entries) expect(/^(ALTER|REVOKE|GRANT)\b/.test(e.statement), e.statement).toBe(true);
  });
});
