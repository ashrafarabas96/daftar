#!/usr/bin/env -S npx tsx
/**
 * PHASE 15 — RED PROOF: CAN THE CALLER'S ENVIRONMENT CHOOSE THIS GATE'S REPOSITORY?
 * (PREPARED / NOT PROMOTED)
 *
 * WHY
 *   Round 13's F-R13-06, and the most serious finding the handoff gate has
 *   taken: `verify-handoff-manifest.ts` disabled replace objects and grafts,
 *   and then handed git `{ ...process.env }`. `GIT_DIR` and `GIT_WORK_TREE`
 *   therefore pointed it at a DIFFERENT repository, and with a doctored
 *   `origin/main` in that one, a manifest asserting 0 commits, 0 new files and
 *   0 new script keys printed «VERIFIED … header current». A lock on the door
 *   of a wall that is not there.
 *
 *   `GIT_OBJECT_DIRECTORY` was the same hole by another route: every read
 *   failed, the gate's helper turned a failure into '', and it stated figures
 *   nobody measured — "88 script key(s) added" out of an empty string.
 *
 * WHAT IS MEASURED
 *   1. With GIT_DIR and GIT_WORK_TREE aimed at a planted repository, the gate's
 *      DIRECTION 3 must read THIS repository's head and counts, unchanged.
 *   2. With GIT_OBJECT_DIRECTORY aimed at nothing, the gate must REFUSE by name
 *      — "UNMEASURED, not zero" — and never state a count.
 *   3. THE GUARD-DELETION HALF: a copy of the gate with the scrub replaced by
 *      the old `{ ...process.env, … }` must go back to reading the planted
 *      repository. Without this arm, 1 and 2 pass on any build that happens to
 *      be green for another reason.
 *
 *   Nothing outside a throwaway directory is written, and the real pack is read
 *   only through the gate the way any reader runs it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const GATE = join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts');
const SCRUB = "  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;";
const UNSCRUBBED = '  for (const [k, v] of Object.entries(process.env)) env[k] = v;';

interface Run {
  /** Named `status` so this pack's own exit-code sweep can see it read. */
  readonly status: number | null;
  readonly out: string;
}

function runGate(script: string, env: NodeJS.ProcessEnv): Run {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined) return { status: null, out: `${out}\n[harness] the gate could not start: ${r.error.message}` };
  return { status: r.status, out };
}

/** The DIRECTION 3 measurement line, which is the sentence under attack. */
function measured(out: string): string | null {
  const line = out.split('\n').find((l) => l.trim().startsWith('measured:'));
  return line === undefined ? null : line.trim();
}

function plantRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-env-repo-'));
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not plant the decoy repository: git ${args.join(' ')} exited ${String(r.status)}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'plant@example.invalid');
  git('config', 'user.name', 'plant');
  git('commit', '-q', '--allow-empty', '-m', 'the decoy head');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

function main(): number {
  console.log('━'.repeat(78));
  console.log("PHASE 15 — RED PROOF: THE CALLER'S ENVIRONMENT MUST NOT CHOOSE THE REPOSITORY   (PREPARED / NOT PROMOTED)");
  console.log('━'.repeat(78));
  const source = readFileSync(GATE, 'utf8');
  if (!source.includes(SCRUB)) {
    console.log('  the gate no longer scrubs its git environment in the shape this proof reads, so');
    console.log('  nothing here was measured.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A proof that cannot find what it is proving proves nothing.');
    return 2;
  }
  const decoy = plantRepo();
  const stripped = join(ROOT, 'scripts/phase15', `.verify-handoff-manifest-unscrubbed-${String(process.pid)}.tmp.ts`);
  const sweep = (): void => {
    rmSync(stripped, { force: true });
    rmSync(decoy, { recursive: true, force: true });
  };
  process.on('exit', sweep);
  try {
    const clean = runGate(GATE, {});
    const truth = measured(clean.out);
    const aimed = runGate(GATE, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });
    const blinded = runGate(GATE, { GIT_OBJECT_DIRECTORY: join(decoy, 'no-such-objects') });
    writeFileSync(stripped, source.replace(SCRUB, UNSCRUBBED));
    const unscrubbed = runGate(stripped, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });

    const problems: string[] = [];
    // The gate's own codes are 0 and 1. Anything else is the runner failing to
    // start it, and a run that did not happen must never read as a clean
    // comparison — the fail-open this whole file is about.
    // Each run's code is read HERE, on the binding, which is what this pack's
    // own sweep requires: a helper taking a shape of our own is not a wrapper
    // it can recognise, and it is right not to guess. The gate's own codes are
    // 0 and 1; anything else is the runner failing to start it, and a run that
    // did not happen must never read as a clean comparison.
    const bad = (what: string, code: number | null): void => {
      problems.push(`${what} exited ${String(code)}, which is not one of this gate's own codes, so its reading is UNMEASURED rather than equal to anything`);
    };
    if (clean.status !== 0 && clean.status !== 1) bad('the untouched run', clean.status);
    if (aimed.status !== 0 && aimed.status !== 1) bad('the GIT_DIR run', aimed.status);
    if (blinded.status !== 0 && blinded.status !== 1) bad('the GIT_OBJECT_DIRECTORY run', blinded.status);
    if (unscrubbed.status !== 0 && unscrubbed.status !== 1) bad('the unscrubbed guard-deletion copy', unscrubbed.status);
    if (truth === null)
      problems.push('the gate printed no DIRECTION 3 measurement on an untouched run, so there is no baseline and nothing below was measured');
    else {
      if (measured(aimed.out) !== truth)
        problems.push(
          `GIT_DIR changed what this gate measured: «${String(measured(aimed.out))}» against «${truth}» — the caller chose the repository the evidence came from`,
        );
      const refused = /UNMEASURED, not zero/.test(blinded.out);
      const stated = measured(blinded.out);
      if (!refused && stated !== truth)
        problems.push(`with its object store taken away the gate stated «${String(stated)}» instead of refusing by name: a failed read became a figure`);
    }
    const forged = measured(unscrubbed.out);
    if (truth !== null && forged === truth)
      problems.push(
        'with the scrub removed the gate STILL read this repository, so the scrub is not what makes arms 1 and 2 pass and they credit the behaviour to the wrong code',
      );

    console.log(`  untouched                  ${String(truth)}`);
    console.log(`  GIT_DIR at a decoy repo    ${String(measured(aimed.out))}`);
    console.log(
      `  GIT_OBJECT_DIRECTORY gone  ${/UNMEASURED, not zero/.test(blinded.out) ? 'refused by name: UNMEASURED, not zero' : String(measured(blinded.out))}`,
    );
    console.log(`  the scrub removed          ${String(forged)}  ${truth !== null && forged !== truth ? '← the forged reading, as the defect did' : ''}`);
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s).`);
      return 1;
    }
    console.log("The caller's environment cannot choose this gate's repository, a read that failed is");
    console.log('  refused by name rather than counted as zero, and the scrub is load-bearing: removing');
    console.log('  it brings the forged reading back. Nothing outside a throwaway directory was written.');
    return 0;
  } finally {
    sweep();
  }
}

process.exitCode = main();
