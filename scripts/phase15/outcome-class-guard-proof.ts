/**
 * PHASE 15 — GUARD-DELETION PROOF FOR THE OUTCOME CLASSIFIER
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS IS ITS OWN INSTRUMENT
 *   `outcome-class-proof.ts` imports the classifier directly, so it cannot run
 *   a MODIFIED copy of it without importing `spawnSync` into the classifier's
 *   own arms. The child-process half therefore lives here, exactly as it does
 *   for the exit-code sweep's provenance rule.
 *
 * WHAT IT MEASURES
 *   A red arm shows the classifier CAN get a case right. It cannot show WHICH
 *   rule gets it right. So each rule below is deleted ON ITS OWN, the whole arm
 *   set is run against that copy, and the arm named beside it must FAIL there.
 *
 *   ROUND 15's F-R15-04 is why this is a table and not one comparison. Round 14
 *   deleted two lines together and named one arm, and the arm it did not name
 *   (O3g) turned out to be vacuous: deleting the rule it was supposed to cover
 *   reddened nothing, because O3g planted a FAIL where the question was about
 *   INVALID MEASUREMENT. A guard-deletion that removes two rules at once cannot
 *   tell which of them the arm was measuring — and an arm no deletion reddens
 *   is measuring nothing at all. Both are checked here: every deletion must
 *   redden its own arm, AND no deletion may redden an arm it is not about.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CLASSIFIER = join(ROOT, 'scripts/phase15/outcome-class.ts');

interface Deletion {
  readonly id: string;
  /** The rule, as exact source of this repository. */
  readonly guard: string;
  /** What it is replaced by: the shape the defect had before the fix. */
  readonly without: string;
  /** A second rule removed in the same copy, where one arm needs both gone. */
  readonly second?: { readonly guard: string; readonly without: string };
  /** The arms that must FAIL once it is gone. */
  readonly arms: readonly string[];
  /** Whether reddening anything ELSE is a finding. A deletion that removes one
   *  rule must move one arm; a deletion that deliberately removes two to show
   *  a redundancy cannot be held to that, and says so. */
  readonly exact: boolean;
  readonly what: string;
}

const DELETIONS: readonly Deletion[] = [
  {
    id: 'D1',
    guard:
      '  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));\n  if (headline !== undefined) return headline.slice(0, 110);\n  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));\n  return machine === undefined ? null : machine.slice(0, 110);',
    without: '  const line = lines.find((l) => VERDICT_LINE.test(l));\n  return line === undefined ? null : line.slice(0, 110);',
    arms: ['O3f', 'O7'],
    exact: true,
    // MEASURED, not assumed: this leaves O3b green, because the record
    // fallback reads the same contention out of the JSON. The arms that
    // isolate the PREFERENCE are the two where record and headline differ.
    what: 'the HEADLINE is preferred over the machine record printed above it (round 14, F-R14-01)',
  },
  {
    id: 'D2',
    guard: 'export const CONTENTION_VERDICT = new RegExp(`^${OPENERS}?INVALID MEASUREMENT\\\\b`);',
    without: 'export const CONTENTION_VERDICT = /^(?:PHASE\\s+15\\s+[A-Z0-9 /-]+:\\s*)?INVALID MEASUREMENT\\b/;',
    arms: ['O3g'],
    exact: true,
    // MEASURED, not assumed. The first run of this table found O3e and O3i
    // still green without the rule, and they were: round 16 added
    // DID_NOT_MEASURE, which reads INVALID MEASUREMENT too, so both arms
    // reached «DID NOT MEASURE» down the generic branch and an arm that
    // asserted only that prefix could not tell the two branches apart. The
    // branches do not say the same thing — the contention one tells the
    // reader to re-run the instrument alone, which is an action — so the four
    // contention arms now assert the CONTENTION sentence. That leaves O3g as
    // the arm this rule carries: a BARE «INVALID MEASUREMENT» in a record
    // still matches the narrow pattern's optional prefix, and only the load
    // harness's «P15 LOAD <profile>:» headline needs the shared speaker.
    what: 'the contention pattern and the headline pattern name the SAME speaker (round 15, F-R15-01)',
  },
  {
    id: 'D3',
    guard: "    const declared = [record.result, record.verdict].filter((v): v is string => typeof v === 'string');",
    without: "    const declared = [record.result].filter((v): v is string => typeof v === 'string');",
    arms: ['O3i', 'O3k'],
    exact: true,
    // MEASURED: O3k dies here too, and honestly. Its plant declares the
    // adverse outcome under `verdict`, so a fallback that cannot see that key
    // cannot see the disagreement either. A second arm moving is a finding
    // only when the rule is not what the arm rests on; here it is.
    what: "the record fallback reads BOTH keys this pack's instruments declare an outcome under (round 15, F-R15-01)",
  },
  {
    id: 'D5',
    guard: 'export const DID_NOT_MEASURE = new RegExp(`^${OPENERS}?(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED|NO VERDICT)\\\\b`);',
    without: 'export const DID_NOT_MEASURE = /(?!)/;',
    arms: ['O6', 'O3j', 'O6b', 'O3k', 'O6c', 'O10'],
    exact: true,
    // MEASURED at round 17: O6c dies here too, and honestly — the fourth
    // spelling lives in this same pattern, so neutralising the pattern takes
    // it with the other three. D11 is the deletion that isolates it.
    // MEASURED at round 18: O10 joins them for the same reason. The
    // speaker-less headline D13 isolates is still READ through this pattern,
    // so a deletion that neutralises the pattern takes the new arm with it;
    // the table says so rather than my expectation saying otherwise.
    what: "\u00abI could not measure\u00bb in the pack's other spellings \u2014 UNMEASURED and NOT MEASURED (round 16, F-R16-04)",
  },
  {
    id: 'D6',
    guard:
      'export const LOADER_MARKERS =\n  /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|SyntaxError:|ERR_INVALID_ARG|MODULE_NOT_FOUND/;',
    without: 'export const LOADER_MARKERS = /(?!)/;',
    arms: ['O2b'],
    exact: true,
    // Round 16 replaced this with a pattern matching nothing and every arm
    // stayed green: O2 reaches the same class through its stack trace, so
    // the loader half was measured by no arm at all (F-R16-07).
    what: 'the LOADER markers, for a crash that prints no stack trace at all',
  },
  {
    id: 'D7',
    guard: "export const VERDICT_HEADLINE = new RegExp(`^(?:EXIT\\\\s+\\\\d+\\\\s*[\u2014:-]|(?:${SPEAKER}|VERDICT):\\\\s*(?:${VERDICTS}))`, 'm');",
    without: "export const VERDICT_HEADLINE = new RegExp(`^(?:EXIT\\\\s+\\\\d+\\\\s+[\u2014-]|${SPEAKER}:\\\\s*(?:${VERDICTS}))`, 'm');",
    arms: ['O7', 'O8', 'O6b'],
    exact: true,
    // MEASURED: O6b dies here as well. Its line is `EXIT 2: NOT MEASURED`,
    // which must first be READ as a headline before the opener list below can
    // place the verdict in it, so it rests on both rules. D8 separates them —
    // it reddens O6b alone.
    what: 'the openers a HEADLINE may use: `EXIT n:` with a colon, and `VERDICT:` with no speaker (round 16, F-R16-05)',
  },
  {
    id: 'D8',
    guard: 'const OPENERS = `(?:EXIT\\\\s+\\\\d+\\\\s*[\u2014:-]\\\\s*|(?:${SPEAKER}|VERDICT):\\\\s*)`;',
    without: 'const OPENERS = `(?:EXIT\\\\s+\\\\d+\\\\s+\u2014\\\\s*|${SPEAKER}:\\\\s*)`;',
    arms: ['O6b'],
    exact: true,
    what: 'the same openers where a NOT-MEASURED verdict may sit',
  },
  {
    id: 'D9',
    guard: '    return declared.find((v) => DID_NOT_MEASURE.test(v)) ?? declared[0] ?? null;',
    without: '    return declared[0] ?? null;',
    arms: ['O3k'],
    exact: true,
    what: 'where two record keys disagree, the one saying it did not measure wins (round 16, F-R16-08)',
  },
  {
    id: 'D10',
    guard: 'export const SUMMARY_LINE = /^(?:measured\\s+\\d+\\s+of\\s+\\d+:|\\d+\\s+probes?:|\\d+\\s+(?:case|check|rule|item)s?:)/i;',
    without: 'export const SUMMARY_LINE = /(?!)/;',
    arms: ['O9', 'O1'],
    exact: true,
    // MEASURED at round 17: O1 dies here too. Its subject is a real instrument
    // that prints its totals and then throws, so without the scrape it reads
    // «CRASHED BEFORE MEASURING» as well — which is the misclassification this
    // rule prevents, in the arm that was supposed to be about the throw.
    // Round 17's F-R17-03: this rule could be replaced by a pattern matching
    // nothing and all twenty arms stayed green, while it decides two branches
    // of the classifier. The same shape as F-R16-07, one rule along.
    what: 'the SUMMARY LINE scrape, which is how a run says it reached its own totals',
  },
  {
    id: 'D11',
    guard: 'export const DID_NOT_MEASURE = new RegExp(`^${OPENERS}?(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED|NO VERDICT)\\\\b`);',
    without: 'export const DID_NOT_MEASURE = new RegExp(`^${OPENERS}?(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED)\\\\b`);',
    arms: ['O6c'],
    exact: true,
    what: '«NO VERDICT», the fourth spelling of «I could not measure» (round 17, F-R17-04)',
  },
  {
    id: 'D13',
    guard: "export const BARE_REFUSAL = new RegExp('^(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED|NO VERDICT)\\\\s*[:\u2014-]');",
    without: 'export const BARE_REFUSAL = /(?!)/;',
    arms: ['O10'],
    exact: true,
    // Round 18's F-R18-09. O10b is the control and must stay green without
    // this rule: a bare refusal is read only where nothing else spoke for the
    // run, so deleting it cannot change a run that printed a headline.
    what: 'the SPEAKER-LESS refusal headline, the shape verify-role-convergence prints',
  },
  {
    id: 'D12',
    guard:
      'export const RUNTIME_MARKERS =\n  /(?:^|\\n)\\s*(?:Uncaught )?(?:TypeError|RangeError|ReferenceError|AssertionError|Error):|\\n\\s+at [^\\n]*\\(?[^\\n]*:\\d+:\\d+\\)?|UnhandledPromiseRejection|FATAL ERROR:|Segmentation fault/;',
    without: 'export const RUNTIME_MARKERS = /(?!)/;',
    arms: ['O1', 'O5', 'O9'],
    exact: true,
    // Round 17's F-R17-06: load-bearing and absent from this table, which is
    // the half of «a rule no arm measures» that was never checked for rules
    // that ARE measured. O9 joins O1 and O5 because its own crash is a throw.
    what: 'the RUNTIME markers, for a crash that prints a stack trace',
  },
  {
    id: 'D4',
    guard:
      '  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));\n  if (headline !== undefined) return headline.slice(0, 110);\n  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));\n  return machine === undefined ? null : machine.slice(0, 110);',
    without: '  const line = lines.find((l) => VERDICT_LINE.test(l));\n  return line === undefined ? null : line.slice(0, 110);',
    second: {
      guard: "    const declared = [record.result, record.verdict].filter((v): v is string => typeof v === 'string');",
      without: '    const declared: readonly string[] = [];',
    },
    arms: ['O3b'],
    exact: false,
    // Two rules at once, deliberately: O3b reproduces round 14's defect
    // transcript and TWO independent rules classify it correctly, so no
    // single deletion can redden it. An arm no deletion reaches is
    // measuring nothing, so the deletion that covers it removes both
    // routes and is not held to `exact`.
    what: 'BOTH routes to a contention verdict \u2014 the headline preference and the record fallback',
  },
];

interface Run {
  readonly status: number | null;
  readonly out: string;
}

function runProof(script: string): Run {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined) return { status: null, out: `${out}\n[harness] the proof could not start: ${r.error.message}` };
  return { status: r.status, out };
}

/** Every arm the proof reported as FAILED, read from its own per-arm lines. */
function failedArms(out: string): readonly string[] {
  const ids: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*([A-Za-z0-9]+) FAILED\b/.exec(line);
    if (m?.[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — GUARD-DELETION PROOF: WHICH RULE CLASSIFIES WHICH RUN?   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  // A TABLE THAT NEEDS A CHECKOUT MUST SAY SO (round 18, F-R18-12).
  //
  // Arm O1 copies `verify-alert-signals.ts`, whose summary line exists only
  // when it can search a git tree. Run from an export rather than a clone,
  // that arm stopped reaching its totals and D10 reported a FINDING against
  // its own table — a false defect, reported with the same words a real one
  // would use. The precondition is now named and the proof REFUSES, because a
  // table that quietly means something different in two directories is worse
  // than one that will not run in the second.
  const inCheckout = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (inCheckout.status !== 0) {
    console.log(`  ${ROOT} is not a git checkout, and arm O1's subject reads its totals from one.`);
    console.log('  Every deletion here would be measured against arms that cannot reach their own');
    console.log('  summary line, so the table would report findings about the environment.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED.');
    return 2;
  }
  const source = readFileSync(CLASSIFIER, 'utf8');
  const missing = DELETIONS.filter((d) => !source.includes(d.guard) || (d.second !== undefined && !source.includes(d.second.guard)));
  if (missing.length > 0) {
    for (const d of missing) {
      console.log(`  NOT FOUND in scripts/phase15/outcome-class.ts: ${d.id} — ${d.what}`);
      console.log(`    expected: ${d.guard.split('\n')[0] ?? ''}`);
    }
    console.log('  A guard this proof deletes is no longer written in the shape it deletes, so nothing');
    console.log('  here was measured. It must be re-anchored before it is read again.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A guard-deletion proof that cannot find the guard proves nothing.');
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'p15-outcome-guard-'));
  try {
    const problems: string[] = [];
    const real = runProof(join(ROOT, 'scripts/phase15/outcome-class-proof.ts'));
    // 0 and 1 are the proof's own codes; 2 is its own UNMEASURED refusal, which
    // is not a comparison either. Anything else is this runner failing to start it.
    if (real.status !== 0 && real.status !== 1) problems.push(`the untouched arm set did not run (exit ${String(real.status)}), so its green says nothing`);
    else if (real.status !== 0)
      problems.push(`the untouched arm set FAILED (exit ${String(real.status)}): ${failedArms(real.out).join(', ') || 'no arm named'}`);
    console.log(`  untouched   exit ${String(real.status)}  ${failedArms(real.out).join(', ') || 'every arm classified as required'}`);
    console.log('');

    for (const d of DELETIONS) {
      const pack = join(tmp, `pack-${d.id}`);
      cpSync(join(ROOT, 'scripts/phase15'), pack, { recursive: true });
      const stripped = source.replace(d.guard, d.without);
      writeFileSync(join(pack, 'outcome-class.ts'), d.second === undefined ? stripped : stripped.replace(d.second.guard, d.second.without));
      const copiedProof = join(pack, 'outcome-class-proof.ts');
      const proofSrc = readFileSync(copiedProof, 'utf8');
      const rooted = proofSrc.replace("resolve(__dirname, '../..')", JSON.stringify(ROOT));
      if (rooted === proofSrc) {
        console.log('  the proof no longer computes its root as resolve(__dirname, "../.."), so a copy of it');
        console.log('  would read a different repository and no comparison below is like for like.');
        console.log('');
        console.log('EXIT 2 — UNMEASURED.');
        return 2;
      }
      writeFileSync(copiedProof, rooted);
      const without = runProof(copiedProof);
      const failed = failedArms(without.out);
      console.log(`  ${d.id} removed  exit ${String(without.status)}  ${failed.join(', ') || 'every arm still classified as required'}`);
      console.log(`     the rule : ${d.what}`);
      console.log(
        `     its arm  : ${d.arms.join(', ')} must fail without it${d.exact ? ', and nothing else may' : ' (other arms may move too: it removes two rules on purpose)'}`,
      );
      // The code is compared HERE, on the binding, rather than handed to a
      // helper: this pack's own sweep credits a comparison, not a mention, and
      // it is right not to guess what a helper of our own shape decides.
      if (without.status !== 0 && without.status !== 1) {
        problems.push(`${d.id}: the arm set did not run with the rule removed (exit ${String(without.status)}), so this deletion is UNMEASURED`);
        continue;
      }
      const owed = d.arms.filter((a) => !failed.includes(a));
      if (owed.length > 0)
        problems.push(
          `${d.id}: with «${d.what}» REMOVED, ${owed.join(', ')} still classified as required — that rule is not what the arm measures, and the arm credits the behaviour to the wrong code`,
        );
      const others = d.exact ? failed.filter((a) => !d.arms.includes(a)) : [];
      if (others.length > 0)
        problems.push(
          `${d.id}: removing one rule also reddened ${others.join(', ')} — a deletion that moves more than its own arm cannot say which rule either arm measures`,
        );
    }

    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s). A rule that can be deleted without the proof noticing was never doing the work.`);
      return 1;
    }
    console.log(`Each of the ${String(DELETIONS.length)} deletions reddens the arm named beside it and, where it removes one rule,`);
    console.log('  nothing else. Restoring it classifies that run as the run it was. Every copy and every');
    console.log('  run happens in a throwaway directory; this repository is read and never written.');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
