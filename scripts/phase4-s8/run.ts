#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK RUNNER — `npx tsx scripts/phase4-s8/run.ts`
 *
 * Prints every S8 check with its verdict. The exit status is 0 when nothing
 * FAILS, and the one-line verdict says `FRAMEWORK_READY (NOT A PASS OF THE
 * INVARIANTS)` whenever any check is WAITING — so a green exit here can never
 * be read, or quoted, as the invariants holding.
 *
 * This is NOT `gate:phase4:s8` and deliberately carries no npm script alias:
 * the gate is wired by a patch request once S5, S6 and S7 seal.
 *
 * Flags: `--list` prints the plan without evaluating; `--root=<dir>` points the
 * whole framework at a copy of the tree, which is how every red proof plants
 * its defect; `--json` emits machine-readable evidence.
 */
import { join } from 'node:path';
import { S8_CHECKS, runS8 } from './index';
import { runVerdict, tally } from './verdict';

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg === undefined ? join(__dirname, '..', '..') : rootArg.slice('--root='.length);

  if (args.includes('--list')) {
    console.log(`P4-S8 FRAMEWORK — ${S8_CHECKS.length.toString()} check(s)`);
    for (const check of S8_CHECKS) {
      console.log(`\n${check.id} — ${check.title}`);
      console.log(`  ok:       ${check.ok}`);
      console.log(`  redProof: ${check.redProof}`);
      for (const subject of check.subjects) console.log(`  subject:  ${subject.kind} ${subject.name} (owed by ${subject.owedBy}) — ${subject.why}`);
    }
    process.exit(0);
  }

  const outcomes = runS8(root);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ root, outcomes, tally: tally(outcomes) }, null, 2));
    process.exit(tally(outcomes).fail === 0 ? 0 : 1);
  }

  for (const outcome of outcomes) {
    if (outcome.verdict === 'PASS') console.log(`PASS    ${outcome.id} — ${outcome.title}: ${S8_CHECKS.find((c) => c.id === outcome.id)?.ok ?? ''}`);
    else if (outcome.verdict === 'FAIL') console.error(`FAIL    ${outcome.id} — ${outcome.title}\n  ${outcome.problems.join('\n  ')}`);
    else {
      console.log(`WAITING_FOR_INTEGRATED_SURFACE  ${outcome.id} — ${outcome.title}`);
      for (const subject of outcome.missingSubjects) console.log(`  not yet real: ${subject.kind} ${subject.name} — owed by ${subject.owedBy}; ${subject.why}`);
      if (outcome.presentSubjects.length > 0) console.log(`  already real: ${outcome.presentSubjects.map((s) => `${s.kind} ${s.name}`).join(', ')}`);
    }
    // The measured numbers on EVERY verdict, WAITING included: a check that
    // reports its tally only when it is happy is a check nobody can audit.
    if (outcome.note !== null) console.log(`        ${outcome.id} measured: ${outcome.note}`);
    console.log(`        ${outcome.id} red proof: ${outcome.redProof}`);
  }

  const t = tally(outcomes);
  console.log(`\n${runVerdict(t)}`);
  process.exit(t.fail === 0 ? 0 : 1);
}
