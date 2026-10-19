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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const GATE = join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts');
const SCRUB = "  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;";
const UNSCRUBBED = '  for (const [k, v] of Object.entries(process.env)) env[k] = v;';
/** The round-14 half: WHICH git, not what it is told (F-R14-03). */
const PINNED = `  env.PATH = SAFE_PATH;
  const binary = gitBinary();`;
/** What it replaced: the binary taken from whatever PATH the caller supplied. */
const FROM_PATH = "  const binary: string | null = 'git';";
/** Round 15's F-R15-03: the two halves of that guard, deleted ONE AT A TIME. */
const PIN_BINARY = '  const binary = gitBinary();';
const PIN_BINARY_WITHOUT = "  const binary: string | null = 'git';";
const PIN_PATH = '  env.PATH = SAFE_PATH;';
const PIN_PATH_WITHOUT = "  // the caller's PATH is left in place, which is the round-14 shape";

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
  // A package.json too, so the decoy answers every question the gate asks and
  // the forged reading is a complete one rather than a half-refusal.
  writeFileSync(join(dir, 'package.json'), readFileSync(join(ROOT, 'package.json'), 'utf8'));
  git('add', 'package.json');
  git('commit', '-q', '-m', 'the decoy head');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

/**
 * A `git` planted earlier in PATH, which answers every question against the
 * decoy repository by rewriting the `-C <root>` the gate passes. It is not a
 * GIT_* name, so the scrub never sees it.
 */
function plantGitOnPath(decoy: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-env-path-'));
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `exec ${JSON.stringify(process.execPath)} -e '`,
      'const { spawnSync } = require("child_process");',
      `const decoy = ${JSON.stringify(JSON.stringify(decoy))};`,
      'const args = process.argv.slice(1);',
      'for (let i = 0; i < args.length; i += 1) if (args[i] === "-C" && i + 1 < args.length) args[i + 1] = JSON.parse(decoy);',
      'const r = spawnSync("/usr/bin/git", args, { stdio: "inherit" });',
      'process.exit(r.status === null ? 1 : r.status);',
      `' -- "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return dir;
}

function main(): number {
  console.log('━'.repeat(78));
  console.log("PHASE 15 — RED PROOF: THE CALLER'S ENVIRONMENT MUST NOT CHOOSE THE REPOSITORY   (PREPARED / NOT PROMOTED)");
  console.log('━'.repeat(78));
  const source = readFileSync(GATE, 'utf8');
  const absent = [source.includes(SCRUB) ? null : 'the GIT_* scrub', source.includes(PINNED) ? null : 'the pinned git binary and PATH'].filter(
    (m): m is string => m !== null,
  );
  if (absent.length > 0) {
    for (const m of absent) console.log(`  NOT FOUND in the gate, in the shape this proof removes: ${m}`);
    console.log('  Nothing here was measured; the anchors must be restored before this is read again.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A proof that cannot find what it is proving proves nothing.');
    return 2;
  }
  const decoy = plantRepo();
  const shimDir = plantGitOnPath(decoy);
  const stripped = join(ROOT, 'scripts/phase15', `.verify-handoff-manifest-unscrubbed-${String(process.pid)}.tmp.ts`);
  const unpinned = join(ROOT, 'scripts/phase15', `.verify-handoff-manifest-unpinned-${String(process.pid)}.tmp.ts`);
  const binaryOnly = join(ROOT, 'scripts/phase15', `.verify-handoff-manifest-binary-only-${String(process.pid)}.tmp.ts`);
  const pathOnly = join(ROOT, 'scripts/phase15', `.verify-handoff-manifest-path-only-${String(process.pid)}.tmp.ts`);
  const sweep = (): void => {
    rmSync(stripped, { force: true });
    rmSync(unpinned, { force: true });
    rmSync(binaryOnly, { force: true });
    rmSync(pathOnly, { force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  };
  process.on('exit', sweep);
  try {
    const clean = runGate(GATE, {});
    const truth = measured(clean.out);
    const aimed = runGate(GATE, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });
    const blinded = runGate(GATE, { GIT_OBJECT_DIRECTORY: join(decoy, 'no-such-objects') });
    const hijackedPath = `${shimDir}:${process.env.PATH ?? ''}`;
    const onPath = runGate(GATE, { PATH: hijackedPath });
    writeFileSync(stripped, source.replace(SCRUB, UNSCRUBBED));
    const unscrubbed = runGate(stripped, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });
    writeFileSync(unpinned, source.replace(PINNED, FROM_PATH));
    const unpinnedRun = runGate(unpinned, { PATH: hijackedPath });
    // EACH HALF ON ITS OWN (round 15, F-R15-03). The deletion above removes
    // two lines together, which cannot say what either one does. These two say
    // it: the claim being measured is not that each half is load-bearing — it
    // is that the two are REDUNDANT, so either one alone still refuses the
    // planted git. If one of them does not, that claim is false and this goes
    // red rather than printing defence in depth it does not have.
    writeFileSync(binaryOnly, source.replace(PIN_BINARY, PIN_BINARY_WITHOUT));
    const binaryOnlyRun = runGate(binaryOnly, { PATH: hijackedPath });
    writeFileSync(pathOnly, source.replace(PIN_PATH, PIN_PATH_WITHOUT));
    const pathOnlyRun = runGate(pathOnly, { PATH: hijackedPath });

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
    if (onPath.status !== 0 && onPath.status !== 1) bad('the run with a git planted in PATH', onPath.status);
    if (unpinnedRun.status !== 0 && unpinnedRun.status !== 1) bad('the unpinned guard-deletion copy', unpinnedRun.status);
    if (binaryOnlyRun.status !== 0 && binaryOnlyRun.status !== 1) bad('the copy with only the pinned binary removed', binaryOnlyRun.status);
    if (pathOnlyRun.status !== 0 && pathOnlyRun.status !== 1) bad('the copy with only the replaced PATH removed', pathOnlyRun.status);
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
      if (measured(onPath.out) !== truth)
        problems.push(
          `a git planted in PATH changed what this gate measured: «${String(measured(onPath.out))}» against «${truth}» — the caller supplied the instrument, which the GIT_* scrub does not cover`,
        );
    }
    // A GUARD DELETION THAT MEASURED NOTHING PROVES NOTHING (round 14, P2).
    //
    // These read `forged === truth` alone, so a stripped copy that printed NO
    // measurement at all — because it crashed, or because the strip did not
    // compile — passed as «the forged reading, as the defect did», printed
    // over `null`. An absent reading is UNMEASURED, and it is said so here.
    const deletion = (what: string, got: string | null): void => {
      if (truth === null) return;
      if (got === null) problems.push(`${what} printed no measurement at all, so the deletion is UNMEASURED: it shows nothing about what the guard does`);
      else if (got === truth)
        problems.push(
          `${what} STILL read this repository, so that guard is not what makes the arms above pass and they credit the behaviour to the wrong code`,
        );
    };
    /** A half that is claimed to hold on its own must still read this repository. */
    const holds = (what: string, got: string | null): void => {
      if (truth === null) return;
      if (got === null) problems.push(`${what} printed no measurement at all, so this half is UNMEASURED, not holding`);
      else if (got !== truth)
        problems.push(
          `${what} read «${got}» against «${truth}»: the two halves of this guard are not redundant, and one of them alone lets the caller supply the instrument`,
        );
    };
    const forged = measured(unscrubbed.out);
    const forgedPath = measured(unpinnedRun.out);
    holds('with ONLY the pinned binary removed the gate', measured(binaryOnlyRun.out));
    holds('with ONLY the replaced PATH removed the gate', measured(pathOnlyRun.out));
    deletion('with the scrub removed the gate', forged);
    deletion('with the binary taken from PATH the gate', forgedPath);

    console.log(`  untouched                  ${String(truth)}`);
    console.log(`  GIT_DIR at a decoy repo    ${String(measured(aimed.out))}`);
    console.log(
      `  GIT_OBJECT_DIRECTORY gone  ${/UNMEASURED, not zero/.test(blinded.out) ? 'refused by name: UNMEASURED, not zero' : String(measured(blinded.out))}`,
    );
    console.log(`  git planted in PATH        ${String(measured(onPath.out))}`);
    console.log(
      `  the scrub removed          ${String(forged)}  ${truth !== null && forged !== null && forged !== truth ? '← the forged reading, as the defect did' : ''}`,
    );
    console.log(
      `  the binary taken from PATH ${String(forgedPath)}  ${truth !== null && forgedPath !== null && forgedPath !== truth ? '← the forged reading, as round 14 measured it' : ''}`,
    );
    console.log(`  only the pin removed       ${String(measured(binaryOnlyRun.out))}  ← the replaced PATH alone still refuses the planted git`);
    console.log(`  only the PATH removed      ${String(measured(pathOnlyRun.out))}  ← the pinned binary alone still refuses it`);
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s).`);
      return 1;
    }
    console.log("The caller's environment can choose neither this gate's repository nor the git that");
    console.log('  reads it, and a read that failed is refused by name rather than counted as zero. The');
    console.log('  scrub and the pinning are each load-bearing: removing either brings a forged reading');
    console.log('  back. Inside the pinning the two lines are REDUNDANT, and that is measured here rather');
    console.log('  than claimed — either one alone still refuses the planted git. A deletion that measured');
    console.log('  nothing is reported as UNMEASURED rather than counted as proof.');
    console.log('  Nothing outside a throwaway directory was written.');
    return 0;
  } finally {
    sweep();
  }
}

process.exitCode = main();
