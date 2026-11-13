/**
 * THE POSITIVE HALF OF "P4-B MUST NOT FAIL ON A CLIENT-SIDE DELAY".
 *
 * `ci.yml` plants 200 ms in the CLIENT and requires the P4-B budget to stay
 * green, because P4-B is judged on the time PostgreSQL spent EXECUTING (DR-98).
 * The first version of that step only checked that `PERF01-BUDGET-P4B` does
 * not appear in the log. An absence proves nothing by itself: the log is also
 * free of that tag when the instrument refused (`PERF01-INSTRUMENT-*`), when
 * P4-B never reached its verdict, or when the delay never reached the wall
 * clock at all — and the suite is red in that step by design (the ratio gate
 * and P4-A are meant to fail), so one more red from P4-B is not visible.
 *
 * So the step now requires the three facts that make the absence mean
 * something, the same way the neighbouring PERF01 control does:
 *
 *   1. P4-B printed its `P4-B-TWO-CLOCKS` line, so it reached a verdict;
 *   2. the WALL clock saw the planted delay (`wallP50 >= 200`), so the delay
 *      really sat between the two clock reads;
 *   3. the IN-DATABASE p95 stayed at or under the ceiling that same line
 *      reports (`budgetMs`), so the verdict listened to PostgreSQL and not to
 *      the client — the ceiling is read from the line, never copied here;
 *
 * and it refuses a log in which the instrument itself spoke or P4-B failed.
 *
 * `verify` is pure so a test can feed it planted logs; the CLI wrapper at the
 * bottom is what `ci.yml` runs.
 */
import { readFileSync } from 'node:fs';

/** The delay `ci.yml` plants, in milliseconds. A control has to exceed what it is testing. */
export const PLANTED_DELAY_MS = 200;

const LINE = /P4-B-TWO-CLOCKS[^\n]*/g;

function field(line: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=([0-9]+(?:\\.[0-9]+)?)(?=\\s|$)`).exec(line);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Colour codes a CI reporter may wrap around a number would hide it from the field reader. */
const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Problems with the log, empty when the control proved what it claims. */
export function verify(raw: string): string[] {
  const log = stripAnsi(raw);
  const problems: string[] = [];
  if (log.includes('PERF01-INSTRUMENT-')) problems.push('the instrument itself refused in this run (PERF01-INSTRUMENT-*), so a green P4-B here says nothing');
  if (log.includes('PERF01-BUDGET-P4B'))
    problems.push('a CLIENT-SIDE delay failed PERF01-BUDGET-P4B — its verdict still listens to something outside PostgreSQL');

  const lines = log.match(LINE) ?? [];
  const line = lines[lines.length - 1];
  if (line === undefined) {
    problems.push('no P4-B-TWO-CLOCKS line in the log — P4-B did not reach its verdict, so "it did not fail" proves nothing');
    return problems;
  }
  const wallP50 = field(line, 'wallP50');
  const inDbP95 = field(line, 'inDbP95');
  const budgetMs = field(line, 'budgetMs');
  if (wallP50 === undefined || inDbP95 === undefined || budgetMs === undefined) {
    problems.push(`the P4-B-TWO-CLOCKS line is missing a field this control reads (wallP50=${wallP50}, inDbP95=${inDbP95}, budgetMs=${budgetMs})`);
    return problems;
  }
  if (wallP50 < PLANTED_DELAY_MS) {
    problems.push(
      `wallP50 ${wallP50} ms is under the planted ${PLANTED_DELAY_MS} ms — the delay never reached the wall clock, so the control did not plant what it claims`,
    );
  }
  if (inDbP95 > budgetMs) {
    problems.push(`in-database p95 ${inDbP95} ms is over the ${budgetMs} ms ceiling — the verdict is not judged on PostgreSQL's own time`);
  }
  return problems;
}

if (process.argv[1] !== undefined && /check-p4b-client-delay-log\.[cm]?[tj]s$/.test(process.argv[1])) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: tsx scripts/check-p4b-client-delay-log.ts <log file>');
    process.exit(64);
  }
  const text = stripAnsi(readFileSync(path, 'utf8'));
  const problems = verify(text);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`P4-B CLIENT-DELAY CONTROL FAIL — ${problem}`);
    process.exit(1);
  }
  const line = (text.match(LINE) ?? []).pop() ?? '';
  console.log(
    `P4-B CLIENT-DELAY CONTROL OK — wallP50=${field(line, 'wallP50')} (>= ${PLANTED_DELAY_MS}), inDbP95=${field(line, 'inDbP95')} (<= ${field(line, 'budgetMs')})`,
  );
}
