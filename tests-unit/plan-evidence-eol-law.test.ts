/**
 * THE PLAN-CLAIM DISCOVERY RULE DOES NOT DEPEND ON LINE ENDINGS.
 *
 * MEASURED DEFECT (TD24-q-7), on this tree at a191d9da with no change but the
 * bytes between lines:
 *
 *     LF checkout     429 hits / 119 plan gates
 *     CRLF checkout    416 hits / 106 plan gates
 *
 * Thirteen plan gates silently absent. All thirteen — eight in
 * `tests/performance/accounting-rls-equivalence.test.ts`, four in
 * `tests/performance/receivables-ar-setbased-equivalence.test.ts`, one in
 * `tests/performance/receivables-s4-budgets.test.ts` — were reached through
 * the generator's ASSIGNMENT seed, and the cause was one regex:
 *
 *     ASSIGN = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(.*)$/
 *
 * `.` does not match `\r` and `$` without `m` anchors at the absolute end of
 * the string, so `before = await capture(scope)\r` does not match at all,
 * `before` is never seeded as plan-derived, and
 * `expect(before.subplanRelations…)` reads as an ordinary assertion. Probed
 * line by line: on the CRLF form ASSIGN returns null while DECL and every
 * SIGNAL still match — exactly one matcher moved, and it moved silently.
 *
 * That is the worst failure a discovery tool can have. It does not go red; it
 * reports a smaller world, and the gate nobody can see is the gate nobody
 * runs — which is the P4-S3 defect this generator was built to end.
 *
 * SO THIS LAW HAS BOTH CONTROLS, and neither is optional:
 *
 *   POSITIVE — the same fixture in CRLF and in LF must yield the SAME hits,
 *   and that set must be NON-EMPTY and must contain the assignment-seeded
 *   plan gate by name. "The two runs agree" is satisfied by two empty runs,
 *   which is what an anaesthetised check looks like, so agreement alone is
 *   never read as a pass here.
 *
 *   NEGATIVE — a fixture with the plan evidence genuinely removed must report
 *   NO plan gate, in LF and in CRLF alike. A rule that answers "gate" to
 *   everything says nothing, and a cure that reached that state would pass the
 *   positive control perfectly.
 *
 *   MECHANISM — the naive `.split('\n')` reading is kept here as an executable
 *   statement of the defect: on the CRLF fixture it must STILL lose the taint,
 *   while `toLines` must keep it. That pins the cause rather than the symptom,
 *   so a later "simplification" of `toLines` back to a bare split fails by
 *   name instead of quietly costing thirteen gates again.
 *
 * No database, no network, no writes to the repository tree: every fixture is
 * built in a fresh temp directory and driven through the generator's own
 * `DELIVERY_MANIFEST.json` branch, which is how the release gate reads an
 * extracted archive. Hence the unit lane (`npm run test:unit`), which runs on
 * a Windows host — the host the defect only ever appeared on.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { discover, planDerivedIdentifiers, toLines, type Hit } from '../scripts/plan-evidence/discover-plan-claims';

const ROOT = join(__dirname, '..');

/**
 * The exact shape of the thirteen: a helper that runs the plan query, a
 * variable DECLARED with only a type annotation, ASSIGNED from that helper far
 * below, and asserted on through a property that carries no plan word of its
 * own. The assertion line is deliberately signal-free, so it can only be
 * classified as a plan gate through the taint path the defect broke.
 */
const GATE_FIXTURE: readonly string[] = [
  "import { describe, it, expect } from 'vitest';",
  '',
  'interface Capture {',
  '  readonly rowCount: number;',
  '  readonly subplanRelations: Record<string, string[]>;',
  '}',
  '',
  'async function capture(scope: string): Promise<Capture> {',
  '  const client = await connect(scope);',
  '  const res = await client.query(',
  "    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM journal_line WHERE tenant_id = $1',",
  '  );',
  '  return shape(res);',
  '}',
  '',
  "describe('the set-based rewrite keeps the plan shape', () => {",
  '  let before: Capture;',
  // This declaration is not decoration. It BOUNDS the span of `let before`,
  // which is why the assignment below is the only way `before` can become
  // plan-derived — exactly the arrangement of the files that lost gates,
  // where the `let` sits at the top of a describe and the assignment runs
  // hundreds of lines down. Without a bounding declaration the span reaches
  // end-of-file, the call-propagation pass taints `before` anyway, and this
  // fixture would pass whether the assignment seed worked or not. Measured:
  // the first draft of this fixture did exactly that, and the mechanism test
  // below is what caught it.
  "  const ONE = 'tenant-1';",
  '',
  "  it('is equivalent', async () => {",
  '    before = await capture(ONE);',
  '    expect(before.rowCount).toBeGreaterThan(0);',
  '  });',
  '});',
];

/** The index of the one line that must be classified a plan gate. */
const GATE_LINE = GATE_FIXTURE.indexOf('    expect(before.rowCount).toBeGreaterThan(0);') + 1;

/**
 * The same fixture with the plan evidence genuinely gone: `capture` runs a
 * plain SELECT, so nothing in the file is plan-derived and the assertion is
 * an ordinary assertion. This is the planted defect of the negative control —
 * if the rule still calls this a plan gate, it is calling everything a plan
 * gate.
 */
const NO_GATE_FIXTURE: readonly string[] = GATE_FIXTURE.map((line) =>
  line.includes('FORMAT JSON') ? "    'SELECT * FROM journal_line WHERE tenant_id = $1'," : line,
);

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fixture tree with no repository, read through `DELIVERY_MANIFEST.json`,
 * with every file written in the requested line ending. `newline: ''` on the
 * write is not available here, so the bytes are composed explicitly: a test
 * about line endings must not let the platform choose them.
 */
function fixtureRoot(files: Record<string, readonly string[]>, eol: '\n' | '\r\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-evidence-eol-'));
  temps.push(root);
  for (const [rel, lines] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, lines.join(eol) + eol, { encoding: 'utf8' });
  }
  writeFileSync(join(root, 'DELIVERY_MANIFEST.json'), JSON.stringify({ inventory: Object.keys(files).map((path) => ({ path })) }));
  // Without this the generator takes its `git ls-files` branch instead, and
  // the fixture would silently measure the repository rather than itself.
  expect(existsSync(join(root, '.git')), 'the fixture root must hold no repository, or this proves nothing').toBe(false);
  return root;
}

/** Hits as comparable strings: everything the inventory reports about a hit. */
const shape = (hits: readonly Hit[]): string[] =>
  hits.map((h) => [h.file, h.line, h.kind, h.phase, h.signals.join('+'), (h.via ?? []).join('+'), h.text].join(' @ ')).sort();

const gatesOf = (hits: readonly Hit[]): Hit[] => hits.filter((h) => h.kind === 'plan-gate');

describe('toLines strips the terminator and nothing else', () => {
  it('normalises CRLF and a lone CR, and leaves LF alone', () => {
    expect(toLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
    expect(toLines('a\rb\r')).toEqual(['a', 'b', '']);
    // The positive control on the normaliser itself: LF input is untouched,
    // so the fix cannot be passing by flattening every input to one line.
    expect(toLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(toLines('a\nb')).toEqual(['a', 'b']);
    expect(toLines('no terminator at all')).toEqual(['no terminator at all']);
  });

  it('removes no character that is not a terminator', () => {
    const body = "const q = 'EXPLAIN (ANALYZE) SELECT 1';";
    expect(toLines(`${body}\r\n`)[0]).toBe(body);
  });
});

describe('the discovery rule is identical on CRLF and on LF', () => {
  const files = { 'tests/performance/plan-shape-fixture.test.ts': GATE_FIXTURE };
  const lf = discover(fixtureRoot(files, '\n'));
  const crlf = discover(fixtureRoot(files, '\r\n'));

  it('finds the assignment-seeded plan gate at all — the positive control', () => {
    // Non-empty FIRST: an empty set satisfies every equality below it, and a
    // probe that reports nothing is how an anaesthetised check looks.
    expect(lf.length, 'the LF fixture produced no hits at all, so this file measures nothing').toBeGreaterThan(0);
    const gates = gatesOf(lf);
    expect(
      gates.map((g) => g.line),
      'the fixture must hold exactly the one assignment-seeded gate',
    ).toEqual([GATE_LINE]);
    expect(gates[0]?.via, 'the gate must be reached through the assignment-seeded identifier, not a signal on its own line').toContain('before');
    expect(gates[0]?.signals, 'the gate line carries no plan word of its own, or the taint path is not what is under test').toEqual([]);
  });

  it('finds the SAME gate on the CRLF fixture', () => {
    const gates = gatesOf(crlf);
    expect(
      gates.map((g) => g.line),
      'the CRLF fixture lost the plan gate: TD24-q-7 has come back',
    ).toEqual([GATE_LINE]);
    expect(gates[0]?.via).toContain('before');
  });

  it('reports hit-for-hit the same inventory, not merely the same count', () => {
    expect(shape(crlf)).toEqual(shape(lf));
  });

  it('plants a real defect and the gate MUST disappear — the negative control', () => {
    const planted = { 'tests/performance/plan-shape-fixture.test.ts': NO_GATE_FIXTURE };
    // Proof the plant applied, before its result is read (DR-55): the fixture
    // genuinely differs from the one that produces a gate.
    expect(NO_GATE_FIXTURE.join('\n')).not.toBe(GATE_FIXTURE.join('\n'));
    expect(NO_GATE_FIXTURE.some((l) => l.includes('FORMAT JSON'))).toBe(false);
    for (const eol of ['\n', '\r\n'] as const) {
      const hits = discover(fixtureRoot(planted, eol));
      expect(
        gatesOf(hits).map((g) => `${g.file}:${g.line}`),
        `a fixture with no plan evidence reported a plan gate on ${JSON.stringify(eol)}`,
      ).toEqual([]);
    }
  });
});

describe('the cause is pinned, not just the symptom', () => {
  const text = GATE_FIXTURE.join('\r\n') + '\r\n';

  it('the naive split still loses the taint, and toLines keeps it', () => {
    // The defect, executable. If this ever stops being true the mechanism has
    // changed and the paragraph at the top of this file is no longer the
    // measurement it claims to be.
    expect(planDerivedIdentifiers(text.split('\n')), 'the naive reading no longer reproduces TD24-q-7 — re-measure before trusting this law').not.toContain(
      'before',
    );
    expect(planDerivedIdentifiers(toLines(text)), 'toLines failed to recover the assignment seed').toContain('before');
    // And the control that keeps the line above from being a trick of the
    // fixture: on LF, both readings agree.
    const lfText = GATE_FIXTURE.join('\n') + '\n';
    expect(planDerivedIdentifiers(lfText.split('\n'))).toContain('before');
    expect(planDerivedIdentifiers(toLines(lfText))).toContain('before');
  });
});

/**
 * THE REAL FILE, NOT ONLY A FIXTURE.
 *
 * `tests/performance/accounting-rls-equivalence.test.ts` held eight of the
 * thirteen lost gates, measured at a191d9da. A fixture can be written to fit
 * the cure; the file the defect actually hid in cannot. It is READ here and
 * never written, and the repository tree is never modified: the CRLF copy
 * lives in the temp fixture.
 *
 * The floor is eight rather than an equality, so that editing that suite does
 * not fail this law for an unrelated reason — but a DROP still does, which is
 * the direction the defect moves in.
 */
describe('seeding CRLF into the performance file that held the defect drops no gate', () => {
  const rel = 'tests/performance/accounting-rls-equivalence.test.ts';
  const lines = toLines(readFileSync(join(ROOT, rel), 'utf8'));

  it('reports the same gates from the CRLF copy as from the LF copy', () => {
    const files = { [rel]: lines };
    const lf = gatesOf(discover(fixtureRoot(files, '\n')));
    const crlf = gatesOf(discover(fixtureRoot(files, '\r\n')));
    expect(lf.length, 'the real performance file produced no plan gate, so the comparison below proves nothing').toBeGreaterThanOrEqual(8);
    expect(shape(crlf), 'CRLF changed the gates discovered in the file the defect hid in').toEqual(shape(lf));
  });
});
