/**
 * T-18 — THE PREMORTEM MATRIX IS COMPLETE AND RESOLVES TO REAL TESTS
 * (docs/PHASE_3_S8_CONTRACT.md A-14, §6.2).
 *
 * `tests/premortem/phase3-premortem-matrix.json` names, for every failure mode
 * PM-01 … PM-46, the tests that prove its invariant holds and the labelled
 * negative control that removes the invariant and shows the attack then
 * succeeds. This suite asserts, statically, that
 *   — the ids are exactly PM-01 … PM-46;
 *   — every referenced file exists;
 *   — every referenced title prefix starts an `it(` title in that file;
 *   — every row has at least one positive test and one negative control.
 *
 * The checker is the S8 gate's own (`premortemMatrixProblems`), imported
 * rather than re-implemented, so the gate's premortem step and this suite
 * cannot disagree. The cases after the first prove the checker can refuse:
 * each breaks the real matrix in exactly one way, in memory, and names the
 * refusal it expects.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREMORTEM_IDS, PREMORTEM_MATRIX, premortemMatrixProblems, testTitles } from '../../scripts/phase3-s8-gate';

const REPO = join(__dirname, '../..');

interface Row {
  invariant: string;
  positive: string[];
  negativeControl: string[];
  s8: string[];
}
interface Matrix {
  rows: Record<string, Row>;
}

const real = (): Matrix => JSON.parse(readFileSync(join(REPO, PREMORTEM_MATRIX), 'utf8')) as Matrix;
/**
 * What breaking the matrix ADDS to the real matrix's problems. Each refusal
 * case is measured against the tree as it is, so a case proves exactly its
 * own refusal whether or not every S8 suite has landed yet.
 */
const baseline = premortemMatrixProblems(REPO);
const added = (m: Matrix): string[] => premortemMatrixProblems(REPO, m).filter((p) => !baseline.includes(p));

const row = (m: Matrix, id: string): Row => {
  const r = m.rows[id];
  if (r === undefined) throw new Error(`${id} is not in the real matrix`);
  return r;
};

describe('T-18: the premortem matrix (A-14)', () => {
  it('PM-01 … PM-46, every file present, every title real, a positive test and a negative control in every row', () => {
    expect(Object.keys(real().rows).sort()).toEqual([...PREMORTEM_IDS]);
    expect(premortemMatrixProblems(REPO)).toEqual([]);
  });

  it('refuses a matrix with a row removed', () => {
    const m = real();
    delete m.rows['PM-07'];
    expect(added(m)).toEqual(['PM-07 is missing from the matrix']);
  });

  it('refuses an id outside PM-01 … PM-46', () => {
    const m = real();
    m.rows['PM-47'] = row(m, 'PM-01');
    expect(added(m)).toEqual(['PM-47 is not a premortem id (PM-01 … PM-46)']);
  });

  it('refuses a row without a negative control, and one without a positive test', () => {
    const m = real();
    row(m, 'PM-06').negativeControl = [];
    row(m, 'PM-07').positive = [];
    expect(added(m)).toEqual(['PM-06 has no negativeControl test', 'PM-07 has no positive test']);
  });

  it('refuses a reference to a file that does not exist', () => {
    const m = real();
    row(m, 'PM-06').positive = ['tests/integration/no-such-suite.test.ts::anything'];
    expect(added(m)).toEqual(['PM-06 positive: tests/integration/no-such-suite.test.ts does not exist']);
  });

  it('refuses a title prefix that starts no it( title in the file', () => {
    const m = real();
    row(m, 'PM-06').negativeControl = ['tests/integration/stock-ledger-primitive.test.ts::T-08.Z (never written):'];
    expect(added(m)).toEqual(['PM-06 negativeControl: no it( title in tests/integration/stock-ledger-primitive.test.ts starts with "T-08.Z (never written):"']);
  });

  it('refuses a reference with no title, and an s8 suite that does not exist', () => {
    const m = real();
    row(m, 'PM-06').positive = ['tests/integration/stock-ledger-primitive.test.ts::'];
    row(m, 'PM-06').s8 = ['tests/integration/phase3-s8-never-written.test.ts'];
    expect(added(m)).toEqual([
      'PM-06 positive: tests/integration/stock-ledger-primitive.test.ts names no title',
      'PM-06 s8: tests/integration/phase3-s8-never-written.test.ts does not exist',
    ]);
  });

  it('reads titles across lines, through .each, and never from skipped or focused tests', () => {
    const source = [
      "it('single quoted', () => {});",
      'it(\n  "double quoted over a line break",\n  () => {},\n);',
      'it.each([1, 2])(`template ${n}`, () => {});',
      "test.concurrent('concurrent', () => {});",
      "it.skip('skipped is not proof', () => {});",
      "it.only('focused is not proof', () => {});",
      "describe('a describe is not a test', () => {});",
      "it('an escaped \\' quote', () => {});",
    ].join('\n');
    expect(testTitles(source)).toEqual(['single quoted', 'double quoted over a line break', 'template ${n}', 'concurrent', "an escaped ' quote"]);
  });
});
