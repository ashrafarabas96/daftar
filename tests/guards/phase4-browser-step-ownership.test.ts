/**
 * P4-S1 red proofs — PHASE OWNERSHIP OF THE BROWSER STEPS (P4-AL-63, P4-AL-68).
 *
 * `scripts/phase3-corrective-gate.ts` ran the real-browser matrix with no
 * `--steps`, so it walked every step `tests/browser/flows.ts` declared. While
 * every step was Phase 3's that was invisible; the moment one is not, a defect
 * on a Phase 4 screen turns an already-ACCEPTED Phase 3 gate red — a
 * predecessor's gate failing on its successor's work. Nothing about the
 * accepted matrix is relaxed to fix that: the Phase 3 gate still performs all
 * nine ar/en/tr x 360/768/1280 runs and its equality across them (OD-P4-11
 * OPTION A) is untouched. What changed is WHICH steps it walks — the steps
 * Phase 3 owns.
 *
 * Ownership is only worth something if it is exhaustive, so `PHASE3_STEPS` and
 * `PHASE4_STEPS` are a PARTITION of the declared steps rather than two loose
 * lists. Every way of breaking that partition is planted below and asserted to
 * be named:
 *
 *   — a step declared twice (the evidence of one run would overwrite another);
 *   — a Phase 4 step declared and listed by neither phase (walked by no gate);
 *   — a listed step no longer declared (a list that has drifted from the tree);
 *   — a Phase 4 step smuggled into `PHASE3_STEPS` (accepted Phase 3 coverage
 *     silently redefined);
 *   — a Phase 4 step name with no `p4-` prefix, which can collide with the
 *     step this file has called `return` since flows.ts:275.
 *
 * And the point of the whole exercise, asserted over the composed plan: a
 * Phase 4 step is NOT in the step list the Phase 3 corrective gate walks, so a
 * Phase 4 screen defect cannot turn `gate:phase3:corrective` red, while the
 * nine runs and their equality survive intact.
 *
 * `PHASE4_STEPS` was empty while no Phase 4 screen existed; P4-S3's POS steps
 * opened it. The emptiness is not loosened away — it is replaced by the
 * assertions it was standing in for, which bite on every entry the list will
 * ever hold: `p4-`-prefixed, disjoint from Phase 3, declared in flows.ts, and
 * walked by no Phase 3 gate. The moment a `run.step` name appears that neither
 * list owns, this file goes red.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { correctivePlan } from '../../scripts/phase3-corrective-gate';
import { PHASE3_STEP_COUNT, PHASE4_STEP_PREFIX as GATE_PHASE4_STEP_PREFIX, browserStepProblems } from '../../scripts/phase4-s1-gate';
import { ALL_BROWSER_STEPS, PHASE3_STEPS, PHASE4_STEPS, PHASE4_STEP_PREFIX, stepOwnershipProblems } from '../browser/flows';

const REPO = join(__dirname, '../..');
const FLOWS = 'tests/browser/flows.ts';
const PHASE3_GATE = 'scripts/phase3-corrective-gate.ts';

/** The step names `runFlows` declares, in declaration order, read from the source the gate reads. */
function declaredSteps(source: string): string[] {
  return [...source.matchAll(/run\.step\(\s*'([^']+)'/g)].map((m) => m[1] ?? '');
}

const FLOWS_SOURCE = readFileSync(join(REPO, FLOWS), 'utf8');
const DECLARED = declaredSteps(FLOWS_SOURCE);
/** The declared steps that are not Phase 4's — what PHASE3_STEPS must be, in declaration order. */
const DECLARED_PHASE3 = DECLARED.filter((step) => !step.startsWith(PHASE4_STEP_PREFIX));

/**
 * The PHASE4_STEPS line as the tree carries it, read from the source rather
 * than copied, so the plants below cannot drift from it.
 */
const PHASE4_LIST_LINE = (/^export const PHASE4_STEPS: readonly string\[\] = .*$/m.exec(FLOWS_SOURCE) ?? [''])[0];

const temps: string[] = [];

/**
 * A two-file tree the P4-S1 gate's `browserStepProblems` can be pointed at:
 * the real sources, with `flows.ts` transformed by `plant`. Only these two
 * files are read by that check, so a tampered copy needs no more.
 */
function treeWith(plant: (source: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-step-ownership-'));
  temps.push(root);
  for (const [rel, text] of [
    [FLOWS, plant(FLOWS_SOURCE)],
    [PHASE3_GATE, readFileSync(join(REPO, PHASE3_GATE), 'utf8')],
  ] as const) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** Replace exactly one occurrence; a fixture that no longer matches is a broken test, not a pass. */
function once(text: string, from: string, to: string): string {
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`the fixture expects exactly one occurrence of ${from}, found ${hits}`);
  return text.replace(from, to);
}

afterAll(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

describe('green: the steps are partitioned by phase, exhaustively, over the tree as delivered', () => {
  it('every declared step is owned by exactly one phase, and every owned step is declared', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(stepOwnershipProblems(DECLARED)).toEqual([]);
    expect([...ALL_BROWSER_STEPS].sort()).toEqual([...DECLARED].sort());
  });

  it('PHASE3_STEPS is exactly the accepted Phase 3 matrix, enumerated, and nothing was dropped to make room', () => {
    expect(PHASE3_STEPS).toHaveLength(PHASE3_STEP_COUNT);
    expect(new Set(PHASE3_STEPS).size).toBe(PHASE3_STEPS.length);
    // The step P4-AL-68 warns about: it is Phase 3's, and it keeps its name.
    expect(PHASE3_STEPS).toContain('return');
    expect(PHASE3_STEPS).toEqual(DECLARED_PHASE3);
  });

  it('PHASE4_STEPS holds the Phase 4 steps the tree declares, every one prefixed and owned by Phase 4 alone', () => {
    expect(PHASE4_STEPS.length).toBeGreaterThan(0);
    expect(new Set(PHASE4_STEPS).size).toBe(PHASE4_STEPS.length);
    for (const step of PHASE4_STEPS) expect(step.startsWith(PHASE4_STEP_PREFIX)).toBe(true);
    expect(PHASE3_STEPS.filter((s) => PHASE4_STEPS.includes(s))).toEqual([]);
    // Exhaustive in both directions: the list is the p4- steps flows.ts runs, no more and no fewer.
    expect([...PHASE4_STEPS].sort()).toEqual(DECLARED.filter((step) => step.startsWith(PHASE4_STEP_PREFIX)).sort());
  });

  it('the Phase 4 list and the declared Phase 3 steps together are every step, once each', () => {
    expect([...DECLARED_PHASE3, ...PHASE4_STEPS].sort()).toEqual([...DECLARED].sort());
  });

  it('the Phase 4 step prefix is one literal: flows.ts and the P4-S1 gate cannot drift apart', () => {
    expect(PHASE4_STEP_PREFIX).toBe(GATE_PHASE4_STEP_PREFIX);
  });

  it('the P4-S1 gate reports no browser-coupling problem against the delivered tree', () => {
    expect(browserStepProblems(REPO)).toEqual([]);
  });
});

describe('green: the Phase 3 corrective gate walks the steps Phase 3 owns, and still makes all nine runs', () => {
  const browserSteps = (): readonly string[] => {
    const steps = correctivePlan(REPO).filter((s) => s.kind === 'command' && s.area === 'browser' && s.args.includes('--out=release/browser'));
    expect(steps).toHaveLength(1);
    const step = steps[0];
    return step !== undefined && step.kind === 'command' ? step.args : [];
  };

  it('the full-matrix browser run is pinned to PHASE3_STEPS', () => {
    expect(browserSteps()).toContain(`--steps=${PHASE3_STEPS.join(',')}`);
  });

  it('the nine runs and the locales and viewports behind the equality assertion are unchanged', () => {
    const args = browserSteps();
    expect(args).toContain('--locales=ar,en,tr');
    expect(args).toContain('--viewports=phone,tablet,desktop');
  });

  it('a Phase 4 step is not in what the Phase 3 gate walks, so a Phase 4 screen defect cannot turn it red', () => {
    const walked = (browserSteps().find((a) => a.startsWith('--steps=')) ?? '').slice('--steps='.length).split(',');
    expect(walked).toEqual([...PHASE3_STEPS]);
    for (const step of walked) expect(step.startsWith(PHASE4_STEP_PREFIX)).toBe(false);
    // Every Phase 4 step that now exists: none of them is walked by the Phase 3 gate.
    for (const step of PHASE4_STEPS) expect(walked).not.toContain(step);
    expect(walked).not.toContain(`${PHASE4_STEP_PREFIX}invoice`);
  });
});

describe('red: a step that belongs to neither list, or to both, is refused', () => {
  it('red: a Phase 4 step declared and listed by neither phase is named as owned by no phase', () => {
    const problems = stepOwnershipProblems([...DECLARED, `${PHASE4_STEP_PREFIX}invoice`]);
    expect(problems).toContainEqual(expect.stringContaining(`the step "${PHASE4_STEP_PREFIX}invoice" is declared in ${FLOWS} but is owned by neither`));
  });

  it('red: the same defect seen by the P4-S1 gate over the source — a declared step neither list names', () => {
    const root = treeWith((s) => once(s, "await run.step('states'", "await run.step('p4-invoice', async () => {});\n  await run.step('states'"));
    expect(browserStepProblems(root)).toContainEqual(expect.stringContaining('runs the step "p4-invoice" that neither exported list names'));
  });

  it('red: a step declared twice is named — the second run would overwrite the first one’s evidence', () => {
    expect(stepOwnershipProblems([...DECLARED, 'return'])).toContainEqual(expect.stringContaining('the step "return" is declared 2 times'));
  });

  it('red: the same duplicate seen by the P4-S1 gate over the source', () => {
    const root = treeWith((s) => once(s, "await run.step('states'", "await run.step('return', async () => {});\n  await run.step('states'"));
    expect(browserStepProblems(root)).toContainEqual(expect.stringContaining('declares the step "return" 2 times'));
  });

  it('red: a listed step the tree no longer declares is named, so a list cannot drift from the tree', () => {
    expect(stepOwnershipProblems(DECLARED.filter((s) => s !== 'states'))).toContainEqual(
      expect.stringContaining('the step "states" is owned by a phase list but'),
    );
  });

  it('red: a Phase 4 step smuggled into PHASE3_STEPS redefines accepted Phase 3 coverage and is refused', () => {
    const root = treeWith((s) => once(s, "  'starting-stock',\n];", "  'starting-stock',\n  'p4-invoice',\n];"));
    expect(browserStepProblems(root)).toContainEqual(
      expect.stringContaining(`PHASE3_STEPS holds 16 names; the accepted Phase 3 matrix is exactly ${PHASE3_STEP_COUNT} steps`),
    );
  });

  it('red: one step owned by both lists is named a collision', () => {
    const root = treeWith((s) => once(s, PHASE4_LIST_LINE, "export const PHASE4_STEPS: readonly string[] = ['return'];"));
    expect(browserStepProblems(root)).toContainEqual(expect.stringContaining('PHASE3_STEPS and PHASE4_STEPS share return'));
  });

  it('red: a Phase 4 step with no p4- prefix is refused, because flows.ts already has a step named "return"', () => {
    const root = treeWith((s) => once(s, PHASE4_LIST_LINE, "export const PHASE4_STEPS: readonly string[] = ['invoice'];"));
    expect(browserStepProblems(root)).toContainEqual(expect.stringContaining(`the Phase 4 browser step "invoice" is not ${PHASE4_STEP_PREFIX}-prefixed`));
  });

  it('red: dropping either list altogether is the original P4-AL-63 coupling, and is named as such', () => {
    const noP3 = treeWith((s) => once(s, 'export const PHASE3_STEPS: readonly string[] = [', 'const PHASE3_STEPS: readonly string[] = ['));
    expect(browserStepProblems(noP3)).toContainEqual(expect.stringContaining('exports no PHASE3_STEPS'));
    const noP4 = treeWith((s) => once(s, PHASE4_LIST_LINE, PHASE4_LIST_LINE.replace('export ', '')));
    expect(browserStepProblems(noP4)).toContainEqual(expect.stringContaining('exports no PHASE4_STEPS'));
  });

  it('red: a Phase 3 gate that walks every step with no --steps is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'p4-step-ownership-nosteps-'));
    temps.push(root);
    for (const rel of [FLOWS, PHASE3_GATE]) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(join(REPO, rel), 'utf8').split('--steps=').join('--walk-everything='));
    }
    expect(browserStepProblems(root)).toContainEqual(expect.stringContaining('still runs the browser matrix with no --steps'));
  });
});
