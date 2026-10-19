/**
 * PHASE 15 — GUARD-DELETION PROOF FOR THE OUTCOME CLASSIFIER'S HEADLINE RULE
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS IS ITS OWN INSTRUMENT
 *   `outcome-class-proof.ts` imports the classifier directly, so it cannot run
 *   a MODIFIED copy of it without importing `spawnSync` into the classifier's
 *   own arms. The child-process half therefore lives here, exactly as it does
 *   for the exit-code sweep's provenance rule.
 *
 * WHAT IT MEASURES (round 14, F-R14-01)
 *   Round 13 moved the contention test off the whole transcript and onto «the
 *   verdict line the run reached». The line it reached was `P15_PITR_PROOF: {…}`
 *   — the machine record `pitr-proof.ts` prints BEFORE its headline — so the
 *   test was never applied to the headline it was written for, and a real
 *   exit-3 contention transcript went back to reading «MEASURED, THEN EXITED
 *   NON-ZERO … so the code is its verdict». The fix prefers the HEADLINE and
 *   falls back to the record's own `result`.
 *
 *   A red arm (O3b, now planting the record the drill really prints) shows the
 *   classifier CAN get this right. It cannot show that the headline preference
 *   is what gets it right. So this instrument runs the whole arm set twice:
 *     1. against the real classifier                 → every arm must classify
 *     2. against a copy with the preference removed  → O3b must FAIL
 *   If the stripped copy still classifies O3b correctly, the preference is not
 *   what earns the green and the credit belongs elsewhere.
 *
 *   Everything happens in a throwaway copy of the pack; this repository is read
 *   and never written.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CLASSIFIER = join(ROOT, 'scripts/phase15/outcome-class.ts');

/** The headline preference, as two exact pieces of this repository's source. */
const PREFER_HEADLINE = `  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));
  if (headline !== undefined) return headline.slice(0, 110);
  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));
  return machine === undefined ? null : machine.slice(0, 110);`;
/** What it replaced: the round-13 form, which took the first line of either kind. */
const FIRST_OF_EITHER = `  const line = lines.find((l) => VERDICT_LINE.test(l));
  return line === undefined ? null : line.slice(0, 110);`;

const PREFER_DECLARED = '  const declared = verdictLine !== null && VERDICT_HEADLINE.test(verdictLine) ? verdictLine : machineResult(r.output);';
const DECLARED_AS_WAS = '  const declared = verdictLine;';

/** The arm whose colour is the whole question. */
const ARM = 'O3b';

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

/** How one arm came out, read from the proof's own per-arm line. */
function armVerdict(out: string, id: string): string | null {
  const line = out.split('\n').find((l) => l.trim().startsWith(`${id} `));
  return line === undefined
    ? null
    : (line
        .trim()
        .split(/\s{2,}/)[0]
        ?.trim() ?? line.trim());
}

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — GUARD-DELETION PROOF: IS THE HEADLINE PREFERENCE WHAT CLASSIFIES CONTENTION?   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  const source = readFileSync(CLASSIFIER, 'utf8');
  const missing = [
    source.includes(PREFER_HEADLINE) ? null : 'the headline-first body of reachedVerdict()',
    source.includes(PREFER_DECLARED) ? null : 'the headline-over-record choice in outcomeClass()',
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    for (const m of missing) console.log(`  NOT FOUND in scripts/phase15/outcome-class.ts: ${m}`);
    console.log('  The guard this proof deletes is no longer written in the shape it deletes, so');
    console.log('  nothing here was measured. It must be re-anchored before it is read again.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A guard-deletion proof that cannot find the guard proves nothing.');
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'p15-outcome-guard-'));
  try {
    const pack = join(tmp, 'phase15');
    cpSync(join(ROOT, 'scripts/phase15'), pack, { recursive: true });
    // The copied classifier loses the preference; the copied proof keeps every
    // arm and is pointed back at the real repository root, so the two runs
    // differ in exactly one thing.
    writeFileSync(join(pack, 'outcome-class.ts'), source.replace(PREFER_HEADLINE, FIRST_OF_EITHER).replace(PREFER_DECLARED, DECLARED_AS_WAS));
    const copiedProof = join(pack, 'outcome-class-proof.ts');
    const proofSrc = readFileSync(copiedProof, 'utf8');
    const rooted = proofSrc.replace("resolve(__dirname, '../..')", JSON.stringify(ROOT));
    if (rooted === proofSrc) {
      console.log('  the proof no longer computes its root as resolve(__dirname, "../.."), so a copy of it');
      console.log('  would read a different repository and the comparison would not be like for like.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    writeFileSync(copiedProof, rooted);

    const real = runProof(join(ROOT, 'scripts/phase15/outcome-class-proof.ts'));
    const without = runProof(copiedProof);

    const problems: string[] = [];
    // 0 and 1 are the proof's own codes; 2 is its own UNMEASURED refusal and is
    // not a comparison either. Anything else is this runner failing to start it.
    const ownCode = (c: number | null): boolean => c === 0 || c === 1;
    if (!ownCode(real.status)) problems.push(`the real arm set did not run (exit ${String(real.status)}), so its green says nothing`);
    else if (real.status !== 0)
      problems.push(`the real arm set FAILED (exit ${String(real.status)}): the classifier does not get ${ARM} right even with the preference in place`);
    if (!ownCode(without.status))
      problems.push(`the arm set against the stripped classifier did not run (exit ${String(without.status)}), so the deletion arm is UNMEASURED`);
    else if (without.status === 0)
      problems.push(
        `with the headline preference REMOVED every arm still classified correctly, so the preference is not what catches ${ARM} and the red proof credits it to the wrong code`,
      );
    else {
      const verdict = armVerdict(without.out, ARM);
      if (verdict === null || !/FAILED/.test(verdict))
        problems.push(
          `the stripped classifier failed, but not at ${ARM} (${String(verdict)}): the deletion must be measured on the arm it is about, not on whatever else moved`,
        );
    }

    console.log(`  with the headline preferred   exit ${String(real.status)}  ${armVerdict(real.out, ARM) ?? 'no per-arm line'}`);
    console.log(`  with it removed               exit ${String(without.status)}  ${armVerdict(without.out, ARM) ?? 'no per-arm line'}`);
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s). A rule that can be deleted without the proof noticing was never doing the work.`);
      return 1;
    }
    console.log(`The headline preference is load-bearing: removing it puts ${ARM} back where round 14 found it,`);
    console.log('  and restoring it classifies a real contention transcript as the run it was. Both runs');
    console.log('  happen against a throwaway copy of the pack; this repository is read and never written.');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
