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
 * The future claims a suite may not make. Each rule returns the problems of one
 * file; `window` is used where the claim and its subject sit on nearby lines.
 */
export function futureClaimProblems(rel: string, source: string): string[] {
  const problems: string[] = [];
  const lines = source.split('\n');
  const window = (i: number): string => lines.slice(Math.max(0, i - 8), i + 9).join('\n');

  if (/to_regclass/.test(source) && /toBeNull/.test(source))
    for (const relation of PHASE4_RELATIONS)
      if (new RegExp(`['"\`](?:public\\.)?${relation}['"\`]`).test(source))
        problems.push(
          `${rel}: it asks the live catalogue whether "${relation}" exists and requires NULL — that is a claim about the phase that creates it, not about the Phase 3 prefix (P4-AL-88)`,
        );

  lines.forEach((line, i) => {
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
    expect(headNumber).toBe(Number(PHASE4_INHERITED_PREFIX_END.slice(0, 4)));
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
});

describe('P4-AL-61: the candidate tense is confined to the slice currently open', () => {
  it('the candidate tense is fenced inside the open slice gate', () => {
    expect(closureRuleProblems(REPO)).toEqual([]);
    const root = copyTree('fence');
    const gate = readFileSync(join(REPO, OPEN_SLICE_GATE), 'utf8');
    const markers = gate.match(/CANDIDATE-TENSE \(P4-AL-61\)/g) ?? [];
    expect(markers.length, `${OPEN_SLICE_GATE} must fence its candidate tense between two markers`).toBeGreaterThanOrEqual(2);
    rewrite(root, OPEN_SLICE_GATE, gate.replace(/CANDIDATE-TENSE \(P4-AL-61\)/g, 'candidate tense'));
    const problems = closureRuleProblems(root);
    expect(problems.join('\n')).toContain('fenced');
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
