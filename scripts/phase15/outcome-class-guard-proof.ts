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
    guard: `  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));
  if (headline !== undefined) return headline.slice(0, 110);
  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));
  return machine === undefined ? null : machine.slice(0, 110);`,
    without: `  const line = lines.find((l) => VERDICT_LINE.test(l));
  return line === undefined ? null : line.slice(0, 110);`,
    arms: ['O3f'],
    exact: true,
    // MEASURED, not assumed: removing this alone leaves O3b GREEN, because the
    // record fallback added in round 15 reads the same contention out of the
    // JSON blob. The arm that isolates the PREFERENCE is O3f, where the two
    // disagree. D4 below removes both routes and is where O3b is covered.
    what: 'the HEADLINE is preferred over the machine record printed above it (round 14, F-R14-01)',
  },
  {
    id: 'D2',
    guard: 'export const CONTENTION_VERDICT = new RegExp(`^(?:${SPEAKER}:\\\\s*)?INVALID MEASUREMENT\\\\b`);',
    without: 'export const CONTENTION_VERDICT = /^(?:PHASE\\s+15\\s+[A-Z0-9 /-]+:\\s*)?INVALID MEASUREMENT\\b/;',
    arms: ['O3g'],
    exact: true,
    what: 'the contention pattern and the headline pattern name the SAME speaker (round 15, F-R15-01)',
  },
  {
    id: 'D3',
    guard: "    for (const value of [record.result, record.verdict]) if (typeof value === 'string') return value;",
    without: "    for (const value of [record.result]) if (typeof value === 'string') return value;",
    arms: ['O3i'],
    exact: true,
    what: "the record fallback reads BOTH keys this pack's instruments declare an outcome under (round 15, F-R15-01)",
  },
  {
    id: 'D4',
    guard: `  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));
  if (headline !== undefined) return headline.slice(0, 110);
  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));
  return machine === undefined ? null : machine.slice(0, 110);`,
    without: `  const line = lines.find((l) => VERDICT_LINE.test(l));
  return line === undefined ? null : line.slice(0, 110);`,
    second: {
      guard: "    for (const value of [record.result, record.verdict]) if (typeof value === 'string') return value;",
      without: '    return null;',
    },
    arms: ['O3b'],
    // Two rules at once, deliberately: O3b is the arm that reproduces round
    // 14's defect transcript, and at this head TWO independent rules classify
    // it correctly. Removing either alone leaves it green, which is redundancy
    // rather than vacuity — but an arm no deletion can redden is measuring
    // nothing, so the deletion that covers it removes both routes. It reddens
    // other arms too, by construction, and is not held to `exact`.
    exact: false,
    what: 'BOTH routes to a contention verdict — the headline preference and the record fallback',
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
