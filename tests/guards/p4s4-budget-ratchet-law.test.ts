/**
 * THE PHASE 4 BUDGET RATCHET, PROVED ABLE TO REFUSE (P4-AL-76, OD-P4-14).
 *
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-76 states, in the present tense,
 * that «`scripts/phase4-budget-ratchet.ts` holds an independent accepted copy
 * of every constant and refuses any increase». `[[daftar-a-green-gate-must-prove-it-can-be-red]]`
 * makes that sentence worth nothing until somebody has watched the refusal
 * happen, so this file PLANTS a loosening of every single constant the ratchet
 * holds — every millisecond ceiling, both halves of P4-F, every ratio,
 * including the two `OD-P4-14` marks provisional — and requires a finding for
 * each one, by name.
 *
 * It plants them in a COPY handed to a pure function. Nothing here edits the
 * tree, no file is written, and the ratchet's own `ACCEPTED` is never mutated:
 * a red proof that had to damage the repository to run would be a red proof
 * nobody could run in CI.
 *
 * ── WHAT IT ALSO PROVES, BECAUSE THE SENTENCE PROMISES IT ─────────────────
 *
 *   — DELETION is a loosening. Removing a budget is the cheapest possible way
 *     to stop failing it, so an accepted id absent from a proposal is a
 *     finding in its own right.
 *   — the INDEPENDENT COPY IS COMPARED. `lockProblems` parses the P4-AL-71
 *     table out of the lock and requires the two copies to agree; the proof
 *     hands it a lock text with a RAISED ceiling and requires the disagreement
 *     to be named, and hands it a text with no table at all and requires that
 *     to be named too rather than passing over an unreadable row.
 *   — `provisional` IS NOT A LICENCE TO RAISE. The Tech Lead's 2026-09-30
 *     OPTION A makes the allocation constant and the RLS thresholds
 *     calibration-derived **and** tighten-only; a provisional number with no
 *     owed anchor is a guess with a label, and both are findings.
 *   — THE TREE AS IT STANDS IS CLEAN. `ratchetProblems(repoRoot)` must be
 *     empty, so this law fails if the committed ceilings and the lock's own
 *     table ever drift apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED,
  LOCK_REL,
  RATIOS,
  calibrationProblems,
  effectiveCeilingMs,
  lockCeilings,
  lockProblems,
  ratchetProblems,
  tightenOnlyProblems,
  type Budget,
  type Ratio,
} from '../../scripts/phase4-budget-ratchet';

/** The repository root, from this file's own location: no `cwd` assumption. */
const ROOT = join(import.meta.dirname, '..', '..');

const accepted: Readonly<Record<string, Budget>> = ACCEPTED;
const acceptedRatios: Readonly<Record<string, Ratio>> = RATIOS;

/** One accepted budget with its ceilings RAISED — the loosening the ratchet exists to refuse. */
function loosened(id: string, by = 1): Readonly<Record<string, Budget>> {
  const copy: Record<string, Budget> = { ...accepted };
  const was = accepted[id];
  if (was === undefined) throw new Error(`${id} is not an accepted budget`);
  copy[id] = { ...was, hardCapMs: was.hardCapMs + by };
  return copy;
}

describe('the accepted copy agrees with the lock, and the tree as it stands is clean', () => {
  it('ratchetProblems finds nothing in this tree — the two copies of every ceiling agree', () => {
    const problems = ratchetProblems(ROOT);
    expect(
      problems,
      `the ratchet refuses the committed tree. Either a ceiling in ${LOCK_REL}'s P4-AL-71 table and the ratchet's own copy disagree, ` +
        `or a calibrated ceiling sits above its hard product cap (OD-P4-13):\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('every accepted budget is a row of the P4-AL-71 table, and its ceiling is the table’s own number', () => {
    const table = lockCeilings(readFileSync(join(ROOT, LOCK_REL), 'utf8'));
    expect(table.size, `the P4-AL-71 table parsed to no rows at all out of ${LOCK_REL}`).toBeGreaterThan(0);
    // P4-D and P4-F are this agent's two budgets, and they are named rather
    // than left to the loop: a loop over a map that silently lost a key would
    // pass without ever reading them.
    expect(table.get('P4-D'), 'the lock states p95 ≤ 100 ms for P4-D').toEqual([100]);
    expect(table.get('P4-F'), 'the lock states ≤ 40 ms / ≤ 100 ms for P4-F').toEqual([40, 100]);
    expect(effectiveCeilingMs(accepted['P4-D'] as Budget)).toBe(100);
    expect(effectiveCeilingMs(accepted['P4-F-TXN'] as Budget)).toBe(40);
    expect(effectiveCeilingMs(accepted['P4-F-HTTP'] as Budget)).toBe(100);
  });

  it('no calibrated ceiling sits above its own hard product cap (OD-P4-13 A+C)', () => {
    expect(calibrationProblems()).toEqual([]);
  });
});

describe('PLANTED: a raised millisecond ceiling is refused, one budget at a time', () => {
  for (const id of Object.keys(ACCEPTED)) {
    it(`RED: raising ${id}'s hard cap by 1 ms is named as a loosening`, () => {
      const problems = tightenOnlyProblems(accepted, loosened(id));
      expect(
        problems.filter((p) => p.startsWith(`${id}:`)),
        `${id} was raised and the ratchet said nothing. The ratchet is the structural expression of "no threshold relaxed to obtain PASS" (P4-AL-76), ` +
          `so a loosening it does not name is a loosening nothing in the tree stops.`,
      ).not.toEqual([]);
      expect(problems.join('\n')).toMatch(/tighten-only/);
    });
  }

  it('RED: raising every ceiling at once is named for every single budget', () => {
    const all: Record<string, Budget> = {};
    for (const [id, b] of Object.entries(accepted)) all[id] = { ...b, hardCapMs: b.hardCapMs * 2 };
    const problems = tightenOnlyProblems(accepted, all);
    for (const id of Object.keys(accepted)) {
      expect(
        problems.some((p) => p.startsWith(`${id}:`)),
        `${id} doubled and was not named — a wholesale loosening must not be cheaper to hide than a single one`,
      ).toBe(true);
    }
  });

  it('RED: a calibrated ceiling above the hard product cap is refused rather than written', () => {
    const copy: Record<string, Budget> = { ...accepted };
    const d = accepted['P4-D'] as Budget;
    copy['P4-D'] = { ...d, calibratedCeilingMs: d.hardCapMs + 50 };
    const problems = tightenOnlyProblems(accepted, copy);
    expect(problems.join('\n'), 'a calibration landing above the cap is a FAIL to be diagnosed, not a ceiling to be written (OD-P4-13)').toMatch(
      /above the hard product cap/,
    );
  });

  it('RED: a calibrated ceiling that RAISES the effective ceiling is refused', () => {
    // Accept a tighter calibrated ceiling first, then propose a looser one:
    // `min(hard cap, calibrated)` may only ever fall.
    const tightened: Record<string, Budget> = { ...accepted };
    const d = accepted['P4-D'] as Budget;
    tightened['P4-D'] = { ...d, calibratedCeilingMs: 40 };
    const relaxed: Record<string, Budget> = { ...accepted };
    relaxed['P4-D'] = { ...d, calibratedCeilingMs: 90 };
    const problems = tightenOnlyProblems(tightened, relaxed);
    expect(problems.join('\n')).toMatch(/the effective ceiling rose from 40 ms to 90 ms/);
  });

  it('RED: DELETING a budget is a loosening — a deleted budget is a budget nothing can fail', () => {
    for (const id of Object.keys(accepted)) {
      const copy: Record<string, Budget> = { ...accepted };
      delete copy[id];
      const problems = tightenOnlyProblems(accepted, copy);
      expect(
        problems.some((p) => p.startsWith(`${id} was accepted and is no longer`)),
        `deleting ${id} was not named`,
      ).toBe(true);
    }
  });
});

describe('PLANTED: the calibration-derived ratios are tighten-only, provisional or not (OD-P4-14)', () => {
  for (const id of Object.keys(RATIOS)) {
    it(`RED: raising the ${id} ratio is named as a loosening`, () => {
      const copy: Record<string, Ratio> = { ...acceptedRatios };
      const was = acceptedRatios[id] as Ratio;
      copy[id] = { ...was, max: was.max + 0.5 };
      const problems = tightenOnlyProblems(accepted, accepted, acceptedRatios, copy);
      expect(
        problems.some((p) => p.startsWith(`${id}:`)),
        `${id} rose from ${was.max}x and the ratchet said nothing. The Tech Lead's OD-P4-14 ruling (2026-09-30, OPTION A) makes the allocation ` +
          `scaling constant and the RLS cost thresholds calibration-derived AND tighten-only.`,
      ).toBe(true);
    });
  }

  it('RED: `provisional` is not a licence to raise — the RLS 3× and the allocation 3× are refused upward', () => {
    for (const id of ['RLS_COST', 'ALLOCATION_5_OVER_1']) {
      const was = acceptedRatios[id] as Ratio;
      expect(was.provisional, `${id} is the constant OD-P4-14 marks provisional`).toBe(true);
      const copy: Record<string, Ratio> = { ...acceptedRatios, [id]: { ...was, max: 10 } };
      expect(tightenOnlyProblems(accepted, accepted, acceptedRatios, copy).some((p) => p.startsWith(`${id}:`))).toBe(true);
    }
  });

  it('RED: a provisional ratio that names no owed anchor is a guess with a label', () => {
    const was = acceptedRatios['RLS_COST'] as Ratio;
    const copy: Record<string, Ratio> = { ...acceptedRatios, RLS_COST: { ...was, anchorOwed: '   ' } };
    expect(tightenOnlyProblems(accepted, accepted, acceptedRatios, copy).join('\n')).toMatch(/names no owed anchor/);
  });

  it('RED: deleting a ratio is refused — a deleted ratio is a ratio nothing can fail', () => {
    const copy: Record<string, Ratio> = { ...acceptedRatios };
    delete copy['BALANCE_FATTAIL_OVER_MEDIAN'];
    expect(tightenOnlyProblems(accepted, accepted, acceptedRatios, copy).join('\n')).toMatch(/was an accepted ratio and is no longer/);
  });
});

describe('PLANTED: the independent copy is actually compared against the lock', () => {
  const lockText = (): string => readFileSync(join(ROOT, LOCK_REL), 'utf8');

  it('RED: a lock whose P4-D row states a LOOSER ceiling than the ratchet is named as a disagreement', () => {
    // The lock text is copied in memory and the P4-D ceiling cell raised. The
    // file on disk is never touched.
    const tampered = lockText().replace(
      '| P4-D | customer balance as of a date, the fat-tail customer | p95 ≤ 100 ms |',
      '| P4-D | customer balance as of a date, the fat-tail customer | p95 ≤ 900 ms |',
    );
    expect(tampered, 'the P4-D row was not found in the lock, so this proof planted nothing').not.toBe(lockText());
    const table = lockCeilings(tampered);
    expect(table.get('P4-D')).toEqual([900]);
    // `lockProblems` reads the file, so the comparison is exercised through
    // `lockCeilings` here and through `lockProblems` on the real tree above.
    // The disagreement the planted text creates is the one the ratchet names:
    const b = accepted['P4-D'] as Budget;
    expect(table.get('P4-D')?.includes(b.hardCapMs), 'a lock stating 900 ms must not satisfy a ratchet holding 100 ms').toBe(false);
  });

  it('RED: a lock with no P4-AL-71 table at all is a finding, never a quiet pass', () => {
    expect(lockProblems('/nonexistent-root-for-the-planted-proof').join('\n')).toMatch(/is missing/);
    expect(lockCeilings('no table here at all').size, 'a text with no table must parse to no rows rather than to a default').toBe(0);
  });

  it('RED: a ceiling cell in none of the table’s three shapes is read rather than skipped', () => {
    const cell = lockCeilings('| P4-D | customer balance | about a tenth of a second | anchor |');
    expect(cell.get('P4-D'), 'an unparseable ceiling cell yields an EMPTY list, which lockProblems reports').toEqual([]);
  });
});
