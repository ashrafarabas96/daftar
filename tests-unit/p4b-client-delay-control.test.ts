/**
 * THE CONTROL OVER P4-B'S "MUST NOT FAIL ON A CLIENT-SIDE DELAY" STEP.
 *
 * `scripts/check-p4b-client-delay-log.ts` is the positive half of an absence
 * claim. A guard that can only say yes is no guard, so each way the control
 * can be fooled is planted here and must be refused, and the one honest log is
 * accepted — that last case is the control for all the others: it proves the
 * checker is not simply answering "problem" to everything.
 *
 * The planted lines use the exact format `pos-s3-budgets.test.ts` prints.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLANTED_DELAY_MS, verify } from '../scripts/check-p4b-client-delay-log';

const line = (over: Partial<Record<'wallP50' | 'inDbP95' | 'budgetMs', string>> = {}): string => {
  const v = { wallP50: '203.412', inDbP95: '3.068', budgetMs: '60', ...over };
  return (
    `P4-B-TWO-CLOCKS judgedOn=inDatabaseExecMs budgetMs=${v.budgetMs} iterations=200 ` +
    `wallP50=${v.wallP50} wallP95=213.921 wallP99=230.100 wallMax=240.000 ` +
    `inDbP50=2.900 inDbP95=${v.inDbP95} inDbP99=3.500 inDbMax=4.000 inDbMin=2.926 calibratedMs=50.084 ` +
    `wallAboveCeiling=200 inDbAboveCeiling=0`
  );
};

describe('the P4-B client-delay control', () => {
  it('accepts the one honest log: the delay reached the wall clock and PostgreSQL stayed under the ceiling', () => {
    expect(verify(`stdout | some test\n${line()}\n`)).toEqual([]);
  });

  it('refuses a log in which P4-B printed nothing — an absence of failure proves nothing', () => {
    const problems = verify('RUN v4.1.12\n ✓ some other test\n');
    expect(problems.join('\n')).toContain('no P4-B-TWO-CLOCKS line');
  });

  it('refuses a delay that never reached the wall clock', () => {
    const problems = verify(line({ wallP50: '9.100' }));
    expect(problems.join('\n')).toContain(`under the planted ${PLANTED_DELAY_MS} ms`);
  });

  it('refuses an in-database p95 over the ceiling the line itself reports', () => {
    const problems = verify(line({ inDbP95: '61.000' }));
    expect(problems.join('\n')).toContain('over the 60 ms ceiling');
  });

  it('reads the ceiling from the line, so a changed ceiling moves the control with it', () => {
    expect(verify(line({ inDbP95: '61.000', budgetMs: '75' }))).toEqual([]);
    expect(verify(line({ inDbP95: '61.000', budgetMs: '50' })).join('\n')).toContain('over the 50 ms ceiling');
  });

  it('refuses a log in which the instrument itself spoke', () => {
    const problems = verify(`${line()}\nPERF01-INSTRUMENT-BLIND a statement that sleeps 49 ms was accounted as 0.000 ms\n`);
    expect(problems.join('\n')).toContain('the instrument itself refused');
  });

  it('refuses a log in which P4-B failed on its own assertion', () => {
    const problems = verify(`${line()}\nAssertionError: PERF01-BUDGET-P4B {"judgedOn":"inDatabaseExecMs"}\n`);
    expect(problems.join('\n')).toContain('a CLIENT-SIDE delay failed PERF01-BUDGET-P4B');
  });

  it('refuses a line that lost a field the control reads, instead of reading it as zero', () => {
    const broken = line().replace(/ wallP50=\S+/, '');
    const problems = verify(broken);
    expect(problems.join('\n')).toContain('missing a field this control reads');
    expect(problems.join('\n')).toContain('wallP50=undefined');
  });

  it('does not read wallP95 as wallP50 or the reverse', () => {
    // wallP50 is under the delay, wallP95 is far over it: only wallP50 counts.
    const confused = line({ wallP50: '9.100' }).replace('wallP95=213.921', 'wallP95=900.000');
    expect(verify(confused).join('\n')).toContain(`under the planted ${PLANTED_DELAY_MS} ms`);
  });

  it('reads a number a reporter wrapped in colour codes, and still refuses a bad one', () => {
    const esc = String.fromCharCode(27);
    const coloured = line().replace('wallP50=203.412', `wallP50=${esc}[32m203.412${esc}[39m`);
    expect(verify(coloured)).toEqual([]);
    const badColoured = line({ wallP50: '9.100' }).replace('wallP50=9.100', `wallP50=${esc}[32m9.100${esc}[39m`);
    expect(verify(badColoured).join(' | ')).toContain('under the planted');
  });

  it('judges the LAST line when P4-B printed more than once', () => {
    const first = line({ wallP50: '9.100' });
    expect(verify(`${first}\n${line()}\n`)).toEqual([]);
    expect(verify(`${line()}\n${first}\n`).join('\n')).toContain('under the planted');
  });
});

describe('the control is wired to what the suite really prints and to ci.yml', () => {
  const root = join(__dirname, '..');

  it('the suite prints every field the control reads, under the same names', () => {
    const suite = readFileSync(join(root, 'tests', 'performance', 'pos-s3-budgets.test.ts'), 'utf8');
    expect(suite, 'the probe is not reading the P4-B suite').toContain('P4-B-TWO-CLOCKS judgedOn=');
    for (const name of ['wallP50=', 'inDbP95=', 'budgetMs=']) {
      expect(suite, `the suite no longer prints ${name} — the control would fail closed on a green run`).toContain(name);
    }
  });

  it('the planted delay in ci.yml is the delay the control requires the wall clock to show', () => {
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci, 'the probe is not reading ci.yml').toContain('P4-B must NOT fail on a client-side delay');
    expect(ci, 'the step no longer runs the checker, so the absence is back to being unproven').toContain('check-p4b-client-delay-log');
    expect(ci).toMatch(new RegExp(`POS_PERF_NEGATIVE_CONTROL_MS: '${PLANTED_DELAY_MS}'`));
  });
});
