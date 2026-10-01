/**
 * FORWARD EVOLUTION — an accepted gate never forbids the next migration, and an
 * accepted suite never makes a claim about the phase that follows it
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-60, P4-AL-61, P4-AL-62, P4-AL-88;
 * docs/PHASE_4_EXECUTION_PLAN.md §5, §6 and P4-S1 action 4).
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`. Until P3-S1 the Phase 2
 * release gate asserted "no migration may exist after 0052" — a true sentence
 * about one closure slice, written as a permanent property of the tree. The
 * first authorized successor migration made every later tree fail, and a
 * predecessor's gate ended up forbidding forward evolution. This suite is the
 * permanent proof that it cannot happen again, and it is owned by
 * `gate:phase4:s1` and composed by every later Phase 4 gate, so the property is
 * re-proved on every push for the rest of the project's life.
 *
 * It proves four things, in the two forms a property like this can be proved:
 *
 *   1. BEHAVIOURALLY. A copy of the tree gains a synthetic successor migration,
 *      numbered one past the CURRENT head — never a hard-coded `0074` — with its
 *      manifest entry and an advanced `frozenThrough`. Every accepted permanent
 *      gate must still PASS over that copy in `--structural-only` mode. The red
 *      proof plants, in the copy, a fixture gate that does assert "nothing after
 *      N" and requires this suite to name it and no other.
 *   2. By SHAPE. Three shapes cannot be written correctly and are refused
 *      wherever they appear in the Phase 4 estate and the permanent prefix
 *      modules: a `.sql` count compared with a literal, a `frozenThrough`
 *      equality, and a literal migration name numbered past the current head —
 *      a gate that names a file which does not exist is a gate bounding the
 *      future. The detector's own red proof runs it over a fixture carrying all
 *      three.
 *   3. By CLAIM. The accepted permanent Phase 3 suites must make their claims
 *      about the Phase 3 PREFIX, not about the database a later phase also
 *      populates (P4-AL-88). Four claim shapes are future claims: an absolute
 *      `to_regclass … toBeNull` for a Phase 4 relation; a "no relation whatever
 *      matches" catalogue query; a 404 expectation for a Phase 4 route; and an
 *      exact-equality assertion over a catalogue set selected by a Phase 4
 *      vocabulary filter. This suite asserts the PROPERTY, over every suite in
 *      the permanent estate, discovered from disk. It does not name, and does
 *      not depend on, how any one file is written: the re-expression of
 *      `tests/security/settlement-s6-no-customer-payments.test.ts` is the
 *      authority owner's work in P4-S1, and this suite is what tells them when
 *      it is done.
 *   4. By TENSE. The one closure rule Phase 4 is allowed — the candidate-tense
 *      migration boundary of the slice currently open (P4-AL-61) — is fenced
 *      inside that slice's gate, and the fence is what the acceptance commit
 *      deletes. That gate is deliberately EXCLUDED from (1): asserting
 *      `frozenThrough` exactly at the previous head is its job while the slice
 *      is a candidate, and it is the only file in the estate allowed to do it.
 *
 * Nothing here is skipped, and nothing is asserted by reading prose.
 *
 * The tampering is done in a HARD-LINKED COPY of the tree, the
 * `tests/security/p3c-corrective-gate-tamper.test.ts` idiom: a file is unlinked
 * before it is written, so nothing reaches back into this checkout.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deliveredFiles } from '../helpers/delivered-files';
import { PHASE4_INHERITED_PREFIX_END, checkPhase4Prefix } from '../../scripts/phase4-prefix';
import { closureRuleProblems } from '../../scripts/phase4-s1-gate';

const REPO = join(__dirname, '../..');
/** This suite's own path: the detector is excluded from the estate it polices. */
const SELF = 'tests/security/phase4-forward-evolution.test.ts';
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';

/**
 * The permanent gates that support `--root` (and `--structural-only` where they
 * have a runtime half), which is what lets them be pointed at a copy. A gate
 * without that pair cannot be proved forward-safe by this suite and is covered
 * by the shape rules instead.
 */
const ACCEPTED_GATES: readonly { readonly script: string; readonly args: (root: string) => readonly string[] }[] = [
  { script: 'scripts/phase2-prefix.ts', args: (root) => [`--root=${root}`] },
  { script: 'scripts/phase3-prefix.ts', args: (root) => [`--root=${root}`] },
  { script: 'scripts/phase4-prefix.ts', args: (root) => [`--root=${root}`] },
  { script: 'scripts/phase2-s8-gate.ts', args: (root) => ['--root', root, '--structural-only'] },
  { script: 'scripts/phase3-s8-gate.ts', args: (root) => ['--root', root, '--structural-only'] },
  { script: 'scripts/phase3-corrective-gate.ts', args: (root) => ['--root', root, '--structural-only'] },
  { script: 'scripts/phase3-release-gate.ts', args: (root) => ['--root', root, '--structural-only'] },
];

/**
 * The gate of the slice currently open. P4-AL-61 authorises its candidate-tense
 * boundary and requires its acceptance commit to delete it, so it is the one
 * gate that legitimately refuses a foreign successor migration.
 */
const OPEN_SLICE_GATE = 'scripts/phase4-s1-gate.ts';

/** The files the shape rules police: the Phase 4 estate and the permanent prefix modules. */
const SHAPE_SCOPE: readonly string[] = ['scripts/phase2-prefix.ts', 'scripts/phase3-prefix.ts', 'scripts/phase4-prefix.ts'];

/** The permanent suite estate: everything the composed gates run, discovered from disk rather than listed. */
const SUITE_DIRECTORIES = ['tests/integration', 'tests/security', 'tests/performance', 'tests/golden-regression/phase1', 'tests/golden-regression/phase2'];

/** The relations Phase 4 creates (lock §5, §19). An absolute-absence claim about one of these is a claim about the future. */
const PHASE4_RELATIONS: readonly string[] = [
  'customers',
  'customer_contacts',
  'invoices',
  'invoice_items',
  'invoice_sequences',
  'sales',
  'sale_items',
  'payments',
  'payment_allocations',
  'payment_reversals',
  'allocation_reversals',
  'refunds',
  'credit_notes',
  'credit_note_items',
  'customer_credits',
  'customer_credit_applications',
  'installments',
  'installment_plans',
  'customer_payments',
  'customer_refunds',
  'pos_till_sessions',
  'pos_cart_lines',
];

/** The routes Phase 4 serves. A 404 expectation for one of these is a claim about the future. */
const PHASE4_ROUTES: readonly string[] = [
  '/v1/pos',
  '/v1/customers',
  '/v1/sales',
  '/v1/invoices',
  '/v1/payments',
  '/v1/refunds',
  '/v1/credit-notes',
  '/v1/customer-credits',
  '/v1/installments',
  '/v1/installment-plans',
  '/v1/debts',
  '/v1/statements',
];

/** The vocabulary a Phase 4 relation, source type, operation kind or route is named with. */
const PHASE4_VOCABULARY: readonly string[] = [
  'payment',
  'payments',
  'refund',
  'refunds',
  'sale',
  'sales',
  'invoice',
  'invoices',
  'customer',
  'customers',
  'credit_note',
  'credit',
];

// ─────────────────────────────────────────────────────────────────────────
// The scratch tree
// ─────────────────────────────────────────────────────────────────────────

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A hard-linked copy of the delivered tree, with the module directories symlinked. */
function copyTree(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `p4-forward-${label}-`));
  temporaries.push(root);
  for (const rel of deliveredFiles(REPO)) {
    const source = join(REPO, rel);
    if (!existsSync(source)) continue; // tracked, deleted in the worktree
    if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) continue; // symlinked below
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(source, target);
  }
  for (const modules of ['node_modules', 'apps/web/node_modules', 'apps/admin/node_modules'])
    if (existsSync(join(REPO, modules))) symlinkSync(join(REPO, modules), join(root, modules), 'dir');
  return root;
}

/** Replace a file in the copy; the unlink is what protects the original. */
function rewrite(root: string, rel: string, contents: string): void {
  const target = join(root, rel);
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const migrationsOf = (root: string): string[] =>
  readdirSync(join(root, MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** The head of a tree: its last migration by name. Read, never assumed. */
const headOf = (root: string): string => migrationsOf(root).slice(-1)[0] ?? '';

interface Manifest {
  frozenThrough: string;
  policy?: string;
  migrations: { name: string; sha256: string }[];
}

/**
 * Add the next migration to a copy: numbered one past the CURRENT head,
 * recorded in the manifest, with `frozenThrough` advanced onto it. This is what
 * the next authorized migration looks like, whatever its number turns out to be.
 */
function addSuccessorMigration(root: string, name?: string): string {
  const head = headOf(root);
  const next = String(Number(head.slice(0, 4)) + 1).padStart(4, '0');
  const file = name ?? `${next}_forward_evolution_probe.sql`;
  const body = `-- A synthetic successor migration, written by ${__filename.split('/').slice(-1)[0] ?? ''}.\nSELECT 1;\n`;
  writeFileSync(join(root, MIGRATIONS, file), body);
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest;
  manifest.migrations.push({ name: file, sha256: createHash('sha256').update(body).digest('hex') });
  manifest.frozenThrough = file;
  rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

interface GateResult {
  readonly script: string;
  readonly status: number | null;
  readonly output: string;
}

/** Run one gate from THIS checkout against `root`: the real gate, pointed at the copy. */
function runGate(root: string, gate: { script: string; args: (root: string) => readonly string[] }): GateResult {
  const res = spawnSync('npx', ['tsx', gate.script, ...gate.args(root)], { cwd: REPO, encoding: 'utf8', env: process.env });
  return { script: gate.script, status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const gatesThatRefuse = (root: string, gates: readonly { script: string; args: (root: string) => readonly string[] }[]): GateResult[] =>
  gates.map((g) => runGate(root, g)).filter((r) => r.status !== 0);

// ─────────────────────────────────────────────────────────────────────────
// The shape rules
// ─────────────────────────────────────────────────────────────────────────

const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/**
 * The three shapes a forward-safe gate cannot contain. `headNumber` is the
 * number of the current last migration, so rule 3 needs no literal.
 */
export function forbiddenShapeProblems(rel: string, source: string, headNumber: number): string[] {
  const code = stripTsProse(source);
  const problems: string[] = [];
  if (/\.sql['"`]\s*\)?\s*\)?\s*\.length\s*[=!<>]==?\s*\d+/.test(code))
    problems.push(`${rel}: a count of .sql files compared with a literal — the number of migrations is not an invariant`);
  if (/frozenThrough\s*[=!]==/.test(code)) problems.push(`${rel}: a frozenThrough equality — frozenThrough is a floor, and a floor is compared with >=`);
  for (const m of code.matchAll(/['"`](\d{4})_[a-z0-9_]+\.sql['"`]/g)) {
    const n = Number(m[1]);
    if (n > headNumber) problems.push(`${rel}: it names the migration ${m[0]}, which does not exist — a gate that names a future file bounds the future`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────
// The claim rules (P4-AL-88)
// ─────────────────────────────────────────────────────────────────────────

/** An exact-equality assertion; `toEqual(expect.arrayContaining(…))` is a scoped claim and is not one. */
const EXACT_EQUALITY = /toEqual\(\s*(?!expect\.)/;

/**
 * `.not.toBeNull()` asserts that a relation EXISTS. That is the OPPOSITE of a
 * future claim — it is a present-tense statement about what the current prefix
 * built — so the negated form is rewritten out of the way before the
 * absolute-absence rule looks for a positive `toBeNull`.
 *
 * This is what made the rule wrong in both directions when it was scoped to
 * the FILE: `tests/security/settlement-s6-no-customer-payments.test.ts` asserts
 * `.not.toBeNull()` over the seven SUPPLIER settlement relations at §B1, and
 * the rule saw the token `toBeNull` somewhere, the token `to_regclass`
 * somewhere, and then attributed a finding to every Phase 4 relation named in
 * any quoted string anywhere in the file — ten findings, none of them a claim
 * the file actually makes. Scoping the rule to the ASSERTION and teaching it
 * the negation makes it strictly sharper: it still catches a genuine
 * `toBeNull` (the red proof below plants one), and it no longer invents a
 * claim out of two tokens that never met.
 *
 * It is applied to the WHOLE source rather than to one line, because a
 * formatter may put `.not` at the end of one line and `.toBeNull()` at the
 * start of the next, and a line-by-line strip would then read the second line
 * as a positive assertion. Every whitespace run is captured and written back,
 * so the rewrite never changes a line number: the positions the rule reports
 * are the positions in the file the reader opens.
 */
const withoutNegatedNullAssertions = (s: string): string => s.replace(/\.not(\s*)\.(\s*)toBeNull(\s*)\(/g, '.not$1.$2toBeNonNull$3(');

/** A POSITIVE `toBeNull` assertion, the negated form having been rewritten away. */
const ASSERTS_NULL = /\.toBeNull\s*\(/;

/**
 * The future claims a suite may not make. Each rule returns the problems of one
 * file; `window` is used where the claim and its subject sit on nearby lines.
 */
export function futureClaimProblems(rel: string, source: string): string[] {
  const problems: string[] = [];
  const lines = source.split('\n');
  const window = (i: number): string => lines.slice(Math.max(0, i - 8), i + 9).join('\n');
  // The same lines with every NEGATED null assertion rewritten away, line
  // numbering preserved. Only the absolute-absence rule reads these.
  const positiveLines = withoutNegatedNullAssertions(source).split('\n');

  lines.forEach((line, i) => {
    // ABSOLUTE ABSENCE, scoped to the ASSERTION rather than to the file: a
    // POSITIVE `toBeNull` whose `to_regclass` lookup and whose Phase 4
    // relation name are both within reach of it. `.not.toBeNull()` is the
    // opposite claim and is excluded by `withoutNegatedNullAssertions`.
    if (ASSERTS_NULL.test(positiveLines[i] ?? '') && /to_regclass/.test(window(i))) {
      // The subjects: the Phase 4 relations named within reach of the
      // assertion. A loop over a table list declared far above names none of
      // them nearby, so when the window names none the rule falls back to the
      // whole FILE rather than miss the claim. The thing this rule now
      // discriminates on is the NEGATION, never the distance — so it is
      // strictly sharper than the file-scoped version it replaces and never
      // less catching.
      const named = (haystack: string, relation: string): boolean => new RegExp(`['"\`](?:public\\.)?${relation}['"\`]`).test(haystack);
      const near = PHASE4_RELATIONS.filter((relation) => named(window(i), relation));
      const subjects = near.length > 0 ? near : PHASE4_RELATIONS.filter((relation) => named(source, relation));
      for (const relation of subjects)
        problems.push(
          `${rel}:${i + 1}: it asks the live catalogue whether "${relation}" exists and requires NULL — that is a claim about the phase that creates it, not about the Phase 3 prefix (P4-AL-88)`,
        );
    }
    if (/relname\s*~/.test(line) && /\((?:[a-z_|]*\|)+[a-z_]*\)/.test(line) && EXACT_EQUALITY.test(window(i)))
      problems.push(
        `${rel}:${i + 1}: a "no relation whatever matches" catalogue claim — a Phase 4 relation makes it red, and it says nothing about what Phase 3 built (P4-AL-88)`,
      );
    for (const route of PHASE4_ROUTES)
      if (line.includes(`'${route}`) && /\b404\b/.test(window(i)))
        problems.push(`${rel}:${i + 1}: it requires 404 from ${route} — the Phase 4 slice that builds that route makes it red (P4-AL-88)`);
    for (const m of line.matchAll(/[('/`]\(?([a-z_|]*\|[a-z_|]*)\)?[)'/`]/g)) {
      const alternatives = (m[1] ?? '').split('|').filter((a) => a !== '');
      if (alternatives.filter((a) => PHASE4_VOCABULARY.includes(a)).length < 2) continue;
      if (EXACT_EQUALITY.test(window(i)))
        problems.push(
          `${rel}:${i + 1}: an exact-equality assertion over a set selected by the Phase 4 vocabulary (${alternatives.join('|')}) — the first Phase 4 source type, operation kind or relation makes it red. Keep every supplier name and drop the absolute equality (P4-AL-88)`,
        );
    }
  });
  return [...new Set(problems)];
}

const permanentSuites = (root: string): string[] =>
  SUITE_DIRECTORIES.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .sort()
      .map((f) => `${dir}/${f}`),
  );

// ─────────────────────────────────────────────────────────────────────────

describe('P4-AL-62: an accepted gate survives the next migration', () => {
  it('every accepted permanent gate passes over a tree whose head is one migration further on', () => {
    const baseline = copyTree('baseline');
    const before = gatesThatRefuse(baseline, ACCEPTED_GATES);
    expect(before.map((r) => `${r.script}\n${r.output.slice(-1500)}`)).toEqual([]);

    const successor = copyTree('successor');
    const added = addSuccessorMigration(successor);
    expect(added).not.toBe(headOf(REPO));
    const after = gatesThatRefuse(successor, ACCEPTED_GATES);
    expect(after.map((r) => `${r.script} refuses the successor ${added}\n${r.output.slice(-1500)}`)).toEqual([]);
  }, 300_000);

  it('a gate that forbids a successor migration is named', () => {
    const root = copyTree('closure-rule');
    const head = headOf(root);
    const fixture = 'scripts/fixture-closure-rule-gate.ts';
    // The P2-S9 defect, reconstructed: a gate that asserts "nothing after N".
    rewrite(
      root,
      fixture,
      [
        `import { readdirSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `const root = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? '.';`,
        `const files = readdirSync(join(root, '${MIGRATIONS}')).filter((f) => f.endsWith('.sql')).sort();`,
        `const after = files.filter((f) => f > '${head}');`,
        `if (after.length > 0) { console.error('FAIL no migration may exist after ${head}: ' + after.join(', ')); process.exit(1); }`,
        `console.log('PASS');`,
        '',
      ].join('\n'),
    );
    const fixtureGate = { script: fixture, args: (r: string) => [`--root=${r}`] };
    // The fixture accepts the untampered tree and refuses the successor: the
    // difference is the successor migration, exactly as it was in P2-S9.
    const clean = copyTree('closure-rule-clean');
    expect(gatesThatRefuse(clean, [{ ...fixtureGate, script: join(root, fixture) }])).toEqual([]);

    const added = addSuccessorMigration(root);
    const refusing = gatesThatRefuse(root, [...ACCEPTED_GATES, { ...fixtureGate, script: join(root, fixture) }]);
    expect(refusing.map((r) => r.script)).toEqual([join(root, fixture)]);
    expect(refusing[0]?.output ?? '').toContain(added);
  }, 300_000);

  it('a retreating frozenThrough is refused', () => {
    const root = copyTree('floor');
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest;
    const dir = join(root, MIGRATIONS);
    const path = join(root, MANIFEST);

    // Ahead of the accepted history: a floor is satisfied from above.
    addSuccessorMigration(root);
    expect(checkPhase4Prefix(dir, path)).toEqual([]);

    // Behind it: refused, and the message names the floor.
    manifest.frozenThrough = manifest.migrations[0]?.name ?? '';
    rewrite(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    const problems = checkPhase4Prefix(dir, path);
    expect(problems.join('\n')).toContain(PHASE4_INHERITED_PREFIX_END);
    expect(problems.some((p) => /frozenThrough is .* must stay frozen through at least/.test(p))).toBe(true);
  }, 120_000);
});

describe('P4-AL-60: the forbidden shapes', () => {
  it('the forbidden shapes are absent from every permanent gate', () => {
    const headNumber = Number(headOf(REPO).slice(0, 4));
    // A FLOOR, not an equality. This was the tenth breakage of the shape this
    // very suite exists to refuse, and it was in the suite itself: requiring
    // the head migration to BE the last inherited one is the claim "no Phase 4
    // migration exists", which `0074` made false the moment action 1 landed.
    // What the check below actually needs of `headNumber` is a number at or
    // above the inherited prefix, so that a literal equal to the CURRENT count
    // is recognised as a forbidden shape (P4-AL-88).
    expect(headNumber).toBeGreaterThanOrEqual(Number(PHASE4_INHERITED_PREFIX_END.slice(0, 4)));
    const problems = SHAPE_SCOPE.flatMap((rel) => forbiddenShapeProblems(rel, readFileSync(join(REPO, rel), 'utf8'), headNumber));
    expect(problems).toEqual([]);
  });

  it('the forbidden-shape detector finds each shape in a fixture', () => {
    const headNumber = Number(headOf(REPO).slice(0, 4));
    const next = String(headNumber + 1).padStart(4, '0');
    const fixture = [
      `const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).length === 74;`,
      `if (manifest.frozenThrough !== END) fail();`,
      `const forbidden = '${next}_something.sql';`,
    ].join('\n');
    const problems = forbiddenShapeProblems('fixture.ts', fixture, headNumber);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('compared with a literal');
    expect(problems.join('\n')).toContain('frozenThrough is a floor');
    expect(problems.join('\n')).toContain(`${next}_something.sql`);
  });
});

describe('P4-AL-88: the permanent Phase 3 suites claim the prefix, not the future', () => {
  it('no permanent suite makes a claim about a relation, a route or a registry that Phase 4 creates', () => {
    // This file is the DETECTOR, not a claim: it carries the Phase 4 vocabulary
    // as data and the four shapes as fixtures, so it is the one file excluded.
    const problems = permanentSuites(REPO)
      .filter((rel) => rel !== SELF)
      .flatMap((rel) => futureClaimProblems(rel, readFileSync(join(REPO, rel), 'utf8')));
    expect(problems).toEqual([]);
  }, 60_000);

  it('a Phase 3 suite that claims the future is named', () => {
    // Each of the four claim shapes, planted in a fixture the detector has
    // never seen: absolute absence, no-relation-whatever, a Phase 4 route 404,
    // and an exact equality over a vocabulary-filtered set.
    const absence = `const r = await pool.query('SELECT to_regclass($1)', ['public.invoices']);\nexpect(r.rows[0]?.oid ?? null).toBeNull();`;
    const whatever = `const q = await pool.query("SELECT relname FROM pg_class WHERE relname ~ '(customer|sale|invoice)'");\nexpect(q.rows).toEqual([]);`;
    const route = `const res = await request(app).get('/v1/invoices');\nexpect(res.status).toBe(404);`;
    const registry = `const kinds = await pool.query("SELECT source_type FROM accounting_source_types WHERE source_type ~ '(payment|refund|sale)'");\nexpect(kinds.rows.map((r) => r.source_type)).toEqual(['supplier_payment']);`;
    for (const [what, fixture] of [
      ['absolute absence', absence],
      ['no relation whatever', whatever],
      ['a Phase 4 route 404', route],
      ['an exact-equality over a filtered set', registry],
    ] as const) {
      const problems = futureClaimProblems('fixture.test.ts', fixture);
      expect(problems.length, `${what} was not detected`).toBeGreaterThan(0);
    }
    // And a scoped claim of the same subject is NOT a future claim: the
    // re-expression must be able to keep every supplier name it carries.
    const scoped = `const rows = await pool.query("SELECT source_type FROM accounting_source_types WHERE source_type ~ '(payment|refund)'");\nexpect(rows.rows.map((r) => r.source_type)).toEqual(expect.arrayContaining(['supplier_payment', 'supplier_refund']));`;
    expect(futureClaimProblems('fixture.test.ts', scoped)).toEqual([]);
  });

  it('the absolute-absence rule reads the assertion, not the file: a positive toBeNull is caught and a negated one is not', () => {
    // BOTH directions, because a precision change that only proves one of them
    // is a claim and not a proof. The rule used to fire on the co-occurrence of
    // `to_regclass` and `toBeNull` ANYWHERE in a file, which made it wrong both
    // ways: it invented ten findings out of §B1's `.not.toBeNull()` existence
    // check, and it would equally have credited a file for a genuine absence
    // claim sitting next to any unrelated `.not.toBeNull()`.

    // (1) STILL CAUGHT. A genuine absence claim about a Phase 4 relation.
    const claimsAbsent = `const r = await pool.query('SELECT to_regclass($1)::text AS oid', ['public.customers']);\nexpect(r.rows[0]?.oid ?? null).toBeNull();`;
    const caught = futureClaimProblems('fixture.test.ts', claimsAbsent);
    expect(caught.join('\n')).toContain('whether "customers" exists and requires NULL');

    // (2) NOT A FINDING. The same relation, the same `to_regclass`, the
    // opposite assertion: that it EXISTS. This is §B1's shape, and it is a
    // present-tense claim about what the current prefix built.
    const claimsPresent = `const r = await pool.query('SELECT to_regclass($1)::text AS oid', ['public.customers']);\nexpect(r.rows[0]?.oid ?? null).not.toBeNull();`;
    expect(futureClaimProblems('fixture.test.ts', claimsPresent)).toEqual([]);

    // (3) The two together in one file: the negated one must not launder the
    // positive one away, and the positive one must not contaminate it. Exactly
    // one finding, and it names the line the real claim is on.
    const both = `${claimsPresent}\n${'\n'.repeat(20)}${claimsAbsent}`;
    const mixed = futureClaimProblems('fixture.test.ts', both);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toContain(`fixture.test.ts:${both.split('\n').findIndex((l) => /(?<!not)\.toBeNull/.test(l)) + 1}:`);

    // (4) STILL CAUGHT, and the reason the rule keeps a file-scoped fallback:
    // a LOOP whose table list is declared far above the assertion names no
    // relation within reach of it. The old file-scoped rule caught this; the
    // new one must too, or the precision fix would have been a narrowing.
    const loopClaim = [
      `const PHASE4_TABLES = ['payments', 'refunds'] as const;`,
      ...Array.from({ length: 30 }, () => ''),
      `for (const name of PHASE4_TABLES) {`,
      `  const r = await pool.query('SELECT to_regclass($1)::text AS oid', [\`public.\${name}\`]);`,
      `  expect(r.rows[0]?.oid ?? null).toBeNull();`,
      `}`,
    ].join('\n');
    const loopCaught = futureClaimProblems('fixture.test.ts', loopClaim);
    expect(loopCaught.join('\n')).toContain('whether "payments" exists and requires NULL');
    expect(loopCaught.join('\n')).toContain('whether "refunds" exists and requires NULL');

    // (5) And the negated form of that same loop — §B1's actual shape, a list
    // of names far above an EXISTENCE check — is still not a finding.
    const loopPresent = loopClaim.replace('.toBeNull()', '.not.toBeNull()');
    expect(futureClaimProblems('fixture.test.ts', loopPresent)).toEqual([]);

    // (6) And the file-scoped mistake itself, reconstructed: a `to_regclass`
    // existence check with the Phase 4 relation names appearing only as data
    // far away from it — which is precisely §B1 plus this suite's own table
    // lists — is no longer a finding at all.
    const fileScopedTrap = `const TABLES = ['payments', 'refunds', 'credit_notes', 'customer_credits'] as const;\n${'\n'.repeat(30)}${claimsPresent}`;
    expect(futureClaimProblems('fixture.test.ts', fileScopedTrap)).toEqual([]);

    // (7) And the negation is recognised ACROSS A LINE BREAK, the shape a
    // formatter produces on a long expectation. A line-by-line strip would
    // read the second line as a positive assertion and invent a finding; and
    // the rewrite must not shift the line numbers it reports either, which the
    // positive case below pins.
    const wrapped = `const r = await pool.query('SELECT to_regclass($1)::text AS oid', ['public.customers']);\nexpect(r.rows[0]?.oid ?? null)\n  .not\n  .toBeNull();`;
    expect(futureClaimProblems('fixture.test.ts', wrapped)).toEqual([]);
    const wrappedPositive = `const r = await pool.query('SELECT to_regclass($1)::text AS oid', ['public.customers']);\nexpect(r.rows[0]?.oid ?? null)\n  .toBeNull();`;
    const wrappedCaught = futureClaimProblems('fixture.test.ts', wrappedPositive);
    expect(wrappedCaught).toHaveLength(1);
    expect(wrappedCaught[0]).toContain('fixture.test.ts:3:');
  });
});

describe('P4-AL-61: the candidate tense is confined to the slice currently open', () => {
  /**
   * The law has TWO tenses and both are asserted, because P4-AL-61 is a claim
   * about the transition, not about one side of it: while a slice is open its
   * candidate tense must be fenced between a PAIR of markers, so the acceptance
   * commit can find what to delete; once the slice is accepted the fence must be
   * GONE, so the closure rule cannot be left behind in a permanent gate.
   *
   * Which arm runs is read from the tree, never written down here, and the arm
   * that is dormant today becomes live the moment the next slice opens its own
   * gate. Each arm carries its own red proof: the open arm unfences the block
   * and watches the rule refuse it, the accepted arm PLANTS a fence comment in a
   * gate that should carry none and watches the same rule refuse that.
   */
  it('the candidate tense is fenced while a slice is open, and gone once it is accepted', () => {
    expect(closureRuleProblems(REPO)).toEqual([]);
    const root = copyTree('fence');
    const gate = readFileSync(join(REPO, OPEN_SLICE_GATE), 'utf8');
    const FENCE = /^\s*\/\/\s*[─-]+\s*(?:end\s+)?CANDIDATE-TENSE \(P4-AL-61\)/;
    const fences = gate.split('\n').filter((l) => FENCE.test(l)).length;

    if (fences > 0) {
      // The open tense. A lone marker is not a fence: the deletion needs both ends.
      expect(fences, `${OPEN_SLICE_GATE} must fence its candidate tense between two markers`).toBeGreaterThanOrEqual(2);
      rewrite(root, OPEN_SLICE_GATE, gate.replace(/CANDIDATE-TENSE \(P4-AL-61\)/g, 'candidate tense'));
      expect(closureRuleProblems(root).join('\n')).toContain('fenced');
    } else {
      // The accepted tense. The gate of an accepted slice carries no candidate
      // tense at all, and a planted fence is refused even though it is "only" a
      // comment, because the block it would fence is what P4-AL-61 forbids.
      const planted = gate.replace(
        /^(export function closureRuleProblems)/m,
        '// ───── CANDIDATE-TENSE (P4-AL-61) ─────\n// ───── end CANDIDATE-TENSE (P4-AL-61) ─────\n$1',
      );
      expect(planted, 'the planted fence really was inserted').not.toBe(gate);
      rewrite(root, OPEN_SLICE_GATE, planted);
      expect(closureRuleProblems(root).join('\n')).toContain('still here');
    }
  }, 120_000);

  it('the open slice gate is the only file in the Phase 4 estate that asserts a tense', () => {
    const headNumber = Number(headOf(REPO).slice(0, 4));
    const estate = readdirSync(join(REPO, 'scripts'))
      .filter((f) => /^phase4-.*\.ts$/.test(f))
      .map((f) => `scripts/${f}`)
      .filter((rel) => rel !== OPEN_SLICE_GATE);
    const problems = estate.flatMap((rel) => forbiddenShapeProblems(rel, readFileSync(join(REPO, rel), 'utf8'), headNumber));
    expect(problems).toEqual([]);
  });
});
