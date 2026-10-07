/**
 * THE WAITING-STATUS LAW (P4-S8 + P4-S9).
 *
 * S8's framework and S9's release tooling were built BEFORE S5, S6 and S7
 * exist, and before any release has been performed. The one thing that makes
 * that safe rather than dishonest is this:
 *
 *   A CHECK WHOSE SUBJECT IS NOT REAL REPORTS `WAITING_FOR_INTEGRATED_SURFACE`
 *   AND NEVER `PASS`.
 *
 * A checker that is green because its subject does not exist is worse than no
 * checker: it converts an unbuilt invariant into recorded evidence that the
 * invariant holds, and nobody re-reads a green.
 *
 * This suite is the proof of that law, in three parts:
 *
 *   1. STRUCTURAL — `evaluate` is not called AT ALL while a subject is absent.
 *      Proved with a check whose `evaluate` throws: if the law held only by
 *      convention, the throw would escape.
 *   2. PER CHECK — every check that is WAITING on the live tree is asserted to
 *      be WAITING, by id, and asserted NOT to be PASS. Each `it(` title below
 *      is the `redProof` string that check carries, so the claim and its proof
 *      are findable from either end.
 *   3. THE COUNTERFACTUAL — a check whose subjects are made real stops waiting
 *      and produces a real verdict. `[[daftar-a-check-only-asked-where-it-passes]]`:
 *      a law demonstrated only in the direction it already holds tells you
 *      nothing, so the opposite direction is demonstrated too.
 *
 * It lives under `tests/guards/` because that directory is executed by
 * `npm run test:integration`, a required step of the `backend` CI job. A proof
 * in a suite the gate does not run is a document.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { S8_CHECKS, runS8 } from '../../scripts/phase4-s8/index';
import { probeSubject } from '../../scripts/phase4-s8/tree';
import { type FrameworkCheck, evaluateCheck, runVerdict, tally } from '../../scripts/phase4-s8/verdict';
import { S9_CHECKS, runS9 } from '../../scripts/phase4-s9/index';

const ROOT = join(__dirname, '..', '..');

const S8_OUTCOMES = runS8(ROOT);
const S9_OUTCOMES = runS9(ROOT);

const outcome = (id: string) => {
  const found = [...S8_OUTCOMES, ...S9_OUTCOMES].find((o) => o.id === id);
  if (found === undefined) throw new Error(`no check with id ${id} — the law's subject must be a real registry entry, not a name`);
  return found;
};

/** Asserts the law for one id: WAITING, with at least one named missing subject, and never PASS. */
function expectWaiting(id: string): void {
  const o = outcome(id);
  expect(o.verdict, `${id} must report WAITING_FOR_INTEGRATED_SURFACE, not ${o.verdict}`).toBe('WAITING_FOR_INTEGRATED_SURFACE');
  expect(o.verdict).not.toBe('PASS');
  // An empty missing-subject list on a WAITING row would mean the status was
  // asserted rather than derived. `[[daftar-an-empty-collection-is-never-a-refusal]]`.
  expect(o.missingSubjects.length, `${id} reports WAITING but names no missing subject`).toBeGreaterThan(0);
  for (const subject of o.missingSubjects) {
    expect(subject.owedBy, `${id}: a missing subject must name the slice that owes it`).toMatch(/^P4-S[0-9]$/);
    expect(subject.why.length, `${id}: a missing subject must say why the check cannot be evaluated without it`).toBeGreaterThan(20);
    expect(probeSubject(ROOT, subject), `${id}: ${subject.kind} ${subject.name} was reported missing but the probe finds it`).toBe(false);
  }
}

describe('the waiting-status law, structurally', () => {
  it('does not call evaluate at all while a subject is absent', () => {
    const exploding: FrameworkCheck = {
      id: 'exploding',
      title: 'a check whose evaluation must never run',
      ok: 'unreachable',
      subjects: [
        {
          kind: 'relation',
          name: 'a_relation_that_does_not_exist_anywhere',
          owedBy: 'P4-S9',
          why: 'it is deliberately absent, so the evaluation must not be reached at all',
        },
      ],
      evaluate: () => {
        throw new Error('evaluate was called over an absent subject');
      },
      redProof: 'tests/guards/p4s89-waiting-status-law.test.ts::does not call evaluate at all while a subject is absent',
    };
    const result = evaluateCheck(ROOT, exploding, probeSubject);
    expect(result.verdict).toBe('WAITING_FOR_INTEGRATED_SURFACE');
    expect(result.problems).toEqual([]);
  });

  it('refuses a subject-less check rather than evaluating it unconditionally', () => {
    const subjectless: FrameworkCheck = {
      id: 'subjectless',
      title: 'a check about nothing',
      ok: 'unreachable',
      subjects: [],
      evaluate: () => [],
      redProof: 'tests/guards/p4s89-waiting-status-law.test.ts::refuses a subject-less check rather than evaluating it unconditionally',
    };
    const result = evaluateCheck(ROOT, subjectless, probeSubject);
    // Note which way this falls: FAIL, not PASS. A check with no subject would
    // otherwise be evaluated over any tree and pass vacuously, which is the
    // exact shape this framework exists to prevent.
    expect(result.verdict).toBe('FAIL');
    expect(result.problems.join(' ')).toContain('empty subject set is never a refusal');
  });

  it('never reports the word PASS in a run verdict while any check is waiting', () => {
    for (const outcomes of [S8_OUTCOMES, S9_OUTCOMES]) {
      const t = tally(outcomes);
      expect(t.waiting, 'this suite asserts a property of a run that HAS waiting checks; with none, it would be vacuous').toBeGreaterThan(0);
      const verdict = runVerdict({ ...t, fail: 0 });
      expect(verdict).toContain('NOT A PASS OF THE INVARIANTS');
      expect(verdict.startsWith('PASS')).toBe(false);
    }
  });
});

describe('the waiting-status law, per S8 check', () => {
  it('rsal-in-product-reconciler reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('rsal-in-product-reconciler');
  });
  it('deadlock-matrix-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('deadlock-matrix-execution');
  });
  it('idempotency-provider-reference reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('idempotency-provider-reference');
  });
  it('lifecycle-scenario-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('lifecycle-scenario-execution');
  });
  it('isolation-scenario-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('isolation-scenario-execution');
  });
});

describe('the waiting-status law, per S9 check', () => {
  it('secret-scan-phase4-alias reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('secret-scan-phase4-alias');
  });
  it('rc-archive-builder reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('rc-archive-builder');
  });
  it('release-gate-composed reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('release-gate-composed');
  });
  it('ci-exact-sha-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('ci-exact-sha-evidence');
  });
  it('archive-gate-rerun reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('archive-gate-rerun');
  });
  it('upgrade-rehearsal-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('upgrade-rehearsal-evidence');
  });
  it('tier2-budget-evidence reports WAITING_FOR_INTEGRATED_SURFACE and never PASS', () => {
    expectWaiting('tier2-budget-evidence');
  });
});

describe('the counterfactual: a check that stops waiting', () => {
  /**
   * `[[daftar-a-check-only-asked-where-it-passes]]`.
   *
   * Everything above shows the law in the direction it already holds. This
   * shows the other direction: make the subject REAL in a copy of the tree,
   * and the check leaves WAITING and produces a verdict about the subject.
   * Without this, a framework that simply hard-coded WAITING everywhere would
   * pass every test above.
   */
  it('leaves WAITING once its subject becomes real, and then says something about it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4s9-waiting-counterfactual-'));
    try {
      // `rc-archive-builder` waits on the npm script `export:release:phase4`.
      // A minimal tree carrying that script is enough to make the subject
      // real, and the check then evaluates the ARCHIVE — which is absent, so
      // the honest answer is FAIL, not PASS. That is the point: the check
      // became able to say something.
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      pkg.scripts = { ...(pkg.scripts ?? {}), 'export:release:phase4': 'tsx scripts/export-release.ts --phase=4' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      // The tree probe reads more than package.json; the directories it walks
      // are created empty so the probe answers "absent" rather than throwing.
      for (const sub of ['infrastructure/database/migrations', 'packages', 'apps', 'tests', 'scripts', '.github/workflows'])
        mkdirSync(join(dir, sub), { recursive: true });
      const check = S9_CHECKS.find((c) => c.id === 'rc-archive-builder');
      expect(check).toBeDefined();
      if (check === undefined) return;

      const before = evaluateCheck(ROOT, check, probeSubject);
      expect(before.verdict).toBe('WAITING_FOR_INTEGRATED_SURFACE');

      const after = evaluateCheck(dir, check, probeSubject);
      expect(after.verdict, 'with its subject real, the check must produce a verdict about the subject').not.toBe('WAITING_FOR_INTEGRATED_SURFACE');
      expect(after.verdict).toBe('FAIL');
      expect(after.problems.join(' ')).toContain('DAFTAR_PHASE_4_RC.zip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('every registry entry names a red proof that exists', () => {
  it('names a suite file that is present in this tree for every S8 and S9 check', () => {
    const missing: string[] = [];
    for (const check of [...S8_CHECKS, ...S9_CHECKS]) {
      const [file, title] = check.redProof.split('::');
      if (file === undefined || title === undefined || title.trim() === '') {
        missing.push(`${check.id}: malformed redProof ${JSON.stringify(check.redProof)}`);
        continue;
      }
      try {
        readFileSync(join(ROOT, file), 'utf8');
      } catch {
        missing.push(`${check.id}: redProof names ${file}, which does not exist`);
        continue;
      }
      // And the title must really be in that file. A red proof that names a
      // suite but no `it(` in it is a claim with a filename attached.
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (!text.includes(title)) missing.push(`${check.id}: ${file} contains no test titled ${JSON.stringify(title)}`);
      expect(dirname(join(ROOT, file))).toContain('tests');
    }
    expect(missing).toEqual([]);
  });
});
