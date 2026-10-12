/**
 * P15 — RED PROOF: CAN THE RELEASE SECRET SCAN'S OWN LAWS GO RED?
 * ===========================================================================
 *
 * The scan's gitleaks half has always been able to fail — a planted secret
 * reds it. Its SOURCE-BINDING half could not, and that is what the challenger
 * (G-02) and the coordinator (F-4) found: the inventory was derived from the
 * OID map, so "N files, N bound" held for every repository state and the arm
 * for a path with no OID was unreachable. A law with no reachable failure is
 * not a law, and the only way to know is to plant the condition.
 *
 * Round 7 (F-01) then asked the same question of the third law and found the
 * same answer in a different place: INDEPENDENT NON-VACUITY, which the scan's
 * own header calls "the only defence" against a run that read nothing and
 * printed "0 findings", had a live guard and no case protecting it. S5 and S6
 * are that case. The harness's printed list of cases is what made the gap
 * visible — which is an argument for printing the list.
 *
 * DISCIPLINE
 *   · Every case runs in a CLONE made with `--no-hardlinks`, so nothing here
 *     can write through to this repository's objects, index or working tree.
 *     The pack's own rule is that a scratch sandbox must not share an inode
 *     with the original.
 *   · A BASELINE runs first. A plant that reds on an already-red clone proves
 *     nothing.
 *   · Each case declares the TEXT the scan must produce, because a red for the
 *     wrong reason is as useless as a green.
 *   · No case lowers a threshold, narrows a pattern or touches the allowlist.
 *
 * Usage: npm run scan:secrets:release:prove
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

interface Case {
  readonly id: string;
  readonly what: string;
  readonly plant: (clone: string) => void;
  readonly expect: RegExp;
  /**
   * Text that must NOT appear. A plant for one law that also trips another
   * produces a red nobody can attribute: the challenger's own first attempt at
   * the non-vacuity case dirtied the tree and fired the binding arm instead,
   * and it reported the run as confounded rather than as evidence.
   */
  readonly refuse?: RegExp;
  /**
   * Run the CLONE's copy of the scanner rather than this tree's. A case that
   * mutates the scanner itself has to: running this tree's copy would measure
   * the unmutated code and report the plant as "did not redden".
   */
  readonly viaClone?: boolean;
}

/** Commit whatever a plant changed, so the tree stays clean and only ONE law can speak. */
function commitInClone(clone: string, message: string): void {
  sh(clone, 'git', ['config', 'user.email', 'proof@localhost']);
  sh(clone, 'git', ['config', 'user.name', 'p15 proof']);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-q', '-m', message]);
  const dirty = sh(clone, 'git', ['status', '--porcelain']);
  if (dirty.out.trim().length !== 0)
    throw new Error(`the clone is still dirty after the commit, so the binding law would speak instead: ${dirty.out.slice(0, 200)}`);
}

/**
 * A command in the clone, which DECIDES on its own exit code.
 *
 * Round-8 N1: this helper used to hand `{ status, out }` outward, and twelve of
 * its call sites dropped the status on the floor — `sh(clone, 'git', ['add',
 * '-f', …])` whose failure would leave the plant unplanted, and
 * `sh(clone, 'git', ['ls-files']).out` whose failure would read as "the index
 * is empty". The old exit-code sweep credited the whole family with a
 * comparison made on an unrelated `r` in another function, so nothing here was
 * ever measured. A proof harness is the worst place for that: a plant that
 * silently did not happen makes a red proof go green.
 *
 * So the helper refuses instead of reporting: a non-zero exit, or a process
 * that never started, throws with the command and its output. The returned
 * `status` is therefore always 0, and the callers that still compare it are
 * comparing a value this function has already decided upon.
 */
function sh(cwd: string, cmd: string, args: readonly string[]): { status: number; out: string } {
  const r = spawnSync(cmd, [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined) throw new Error(`${cmd} ${args.join(' ')} could not start in ${cwd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${String(r.status)} in ${cwd}: ${out.slice(0, 300).trim()}`);
  return { status: 0, out };
}

const CASES: readonly Case[] = [
  {
    id: 'S1',
    what:
      'an UNMERGED path: stages 1/2/3 and no stage 0, which is what a conflicted tree looks like. The path is ' +
      'tracked and on disk, so it is in the inventory, but nothing binds the bytes the scan read to a commit. ' +
      'This is the arm that was unreachable code while the inventory was derived from the OID map',
    plant: (clone) => {
      const oid = sh(clone, 'git', ['rev-parse', 'HEAD:package.json']).out.trim();
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error('could not read a blob OID to build the unmerged entry with');
      // Remove the stage-0 entry and add the three conflict stages in its place.
      sh(clone, 'git', ['rm', '--cached', '-q', 'package.json']);
      const info = [1, 2, 3].map((st) => `100644 ${oid} ${st}\tpackage.json`).join('\n');
      const r = spawnSync('git', ['update-index', '--index-info'], { cwd: clone, input: `${info}\n`, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`could not create an unmerged index entry: ${r.stderr ?? ''}`);
    },
    expect: /no stage-0 blob OID in the index/,
  },
  {
    id: 'S2',
    what: 'a tracked file whose WORKING-TREE bytes differ from the committed blob: the scan read content no commit holds',
    plant: (clone) => {
      // The subject is VERIFIED TRACKED before the plant. The first version of
      // this case appended to `README.md`, which this repository does not have,
      // so it created an UNTRACKED file — which the scan ignores, correctly —
      // and the case stayed green while the law it was testing was fine. A
      // plant whose subject is not what it assumes proves nothing, quietly.
      const target = 'package.json';
      const tracked = sh(clone, 'git', ['ls-files', '--error-unmatch', target]);
      if (tracked.status !== 0) throw new Error(`${target} is not tracked in the clone, so this plant would create an untracked file and prove nothing`);
      appendFileSync(join(clone, target), '\n');
    },
    expect: /differs from the blob the index records for it/,
  },
  {
    id: 'S3',
    what: 'a `.gitleaks.toml` inside the shipped tree: a tree that carries a config is a tree that can narrow the rules it is judged by',
    plant: (clone) => {
      writeFileSync(join(clone, '.gitleaks.toml'), "title = 'nothing to see here'\n");
      sh(clone, 'git', ['add', '-f', '.gitleaks.toml']);
    },
    expect: /is a gitleaks configuration inside the shipped tree/,
  },
  {
    id: 'S4',
    what: 'a nested `.gitleaksignore`, which gitleaks reads from the directory it scans and which would suppress findings in its own subtree',
    plant: (clone) => {
      writeFileSync(join(clone, 'scripts/.gitleaksignore'), 'deadbeef\n');
      sh(clone, 'git', ['add', '-f', 'scripts/.gitleaksignore']);
    },
    expect: /is a \.gitleaksignore below the root/,
  },
  {
    id: 'S5',
    what:
      'challenge round 7, F-01: the scan reads NOTHING and reports no findings. The scan\u2019s own header calls ' +
      'independent non-vacuity "the only defence" against exactly that, and it was the one law of the three with ' +
      'no red proof behind it. Every tracked file is removed AND COMMITTED inside the clone, so the inventory is ' +
      'empty while the tree stays clean',
    plant: (clone) => {
      // COMMITTED, and that is the whole design of this case. The challenger's
      // first attempt mutated the scan's SOURCE to disable the guard, which
      // dirties the tree and trips the law-2 dirty-tree finding — so the red it
      // produced was not attributable to the vacuity arm, and it said so. A
      // plant for one law must not trip another, or the exit code stops being
      // evidence about either. Committing the removal leaves `git status`
      // clean, so nothing but non-vacuity can speak.
      const rm = sh(clone, 'git', ['rm', '-r', '-q', '--ignore-unmatch', '.']);
      if (rm.status !== 0) throw new Error(`could not empty the clone's tree: ${rm.out.slice(0, 200)}`);
      sh(clone, 'git', ['config', 'user.email', 'proof@localhost']);
      sh(clone, 'git', ['config', 'user.name', 'p15 proof']);
      const ci = sh(clone, 'git', ['commit', '-q', '-m', 'empty the tree, so the inventory is empty and the tree is clean']);
      if (ci.status !== 0) throw new Error(`could not commit the emptied tree: ${ci.out.slice(0, 200)}`);
      const left = sh(clone, 'git', ['ls-files']).out.trim();
      if (left.length !== 0) throw new Error(`the clone still tracks ${left.split('\n').length} file(s), so this plant is not the empty-inventory case`);
    },
    expect: /lists 0 files/,
    // The challenger's round-7 note, and it is the `refuse` idea one level
    // DOWN: 0 is also below the floor of 200, so if both arms could speak this
    // red would not attribute to the arm S5 exists to prove. The arms are
    // `if`/`else if` and therefore exclusive — but that is read from the
    // source, and this line MEASURES it.
    refuse: /\[source-binding\]|below the MIN_RELEASE_FILES floor/,
  },
  {
    id: 'S6',
    what:
      'the other half of the same law: a tree far too small to be a release. The inventory is non-empty, so the ' +
      '0-file arm cannot be what speaks, and the floor must',
    plant: (clone) => {
      const keep = new Set(['package.json', 'tsconfig.json', 'README.md']);
      const all = sh(clone, 'git', ['ls-files'])
        .out.trim()
        .split('\n')
        .filter((f) => f.length > 0);
      const drop = all.filter((f) => !keep.has(f));
      if (all.length - drop.length === 0) throw new Error('nothing would be left, so this would be the S5 case rather than the floor case');
      // argv has a length limit, so the removal goes in through stdin.
      const r = spawnSync('git', ['rm', '-r', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: clone,
        input: `${drop.join('\0')}\0`,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`could not shrink the clone's tree: ${(r.stderr ?? '').slice(0, 200)}`);
      sh(clone, 'git', ['config', 'user.email', 'proof@localhost']);
      sh(clone, 'git', ['config', 'user.name', 'p15 proof']);
      const ci = sh(clone, 'git', ['commit', '-q', '-m', 'shrink the tree below any plausible release size']);
      if (ci.status !== 0) throw new Error(`could not commit the shrunken tree: ${ci.out.slice(0, 200)}`);
    },
    expect: /below the MIN_RELEASE_FILES floor/,
    // The same assertion from the other side: the empty-inventory arm must be
    // silent here, or the floor is not what this case proves.
    refuse: /\[source-binding\]|lists 0 files/,
  },
  {
    id: 'S9',
    viaClone: true,
    what:
      'round-8 N2, as a case: a real token in a TRACKED file of a class gitleaks\u2019 default allowlist skips ' +
      '(`package-lock.json`). The canary is reported either way, the file count is unchanged, and before the ' +
      'coverage law this run came back PASS \u2014 the scan said "no findings" about a file it had never read',
    plant: (clone) => {
      const f = join(clone, 'package-lock.json');
      const s = readFileSync(f, 'utf8');
      // A fake token of the shape the DEFAULT rule set detects, placed in a
      // value so the file stays valid JSON: the case is about the path class,
      // not about a parse error.
      const token = `ghp_${'a1b2c3d4e5'.repeat(4).slice(0, 36)}`;
      const broken = s.replace('{\n', `{\n  "daftarProofToken": "${token}",\n`);
      if (broken === s) throw new Error('could not plant a token in package-lock.json: the file does not start with an object');
      writeFileSync(f, broken);
      commitInClone(clone, 'plant a token in a tracked file of an allowlisted class');
    },
    expect: /package-lock\.json/,
    // The dirty-tree and inventory laws must stay silent: this red is about
    // coverage of an allowlisted path, or it attributes to nothing.
    refuse: /\[source-binding\]|lists 0 files|below the MIN_RELEASE_FILES floor/,
  },
  {
    id: 'S10',
    viaClone: true,
    what:
      'the coverage law\u2019s own apparatus: the second pass stops copying the files it is meant to read. Every ' +
      'allowlisted file is then UNSCANNED while the first pass and both counts look exactly as they do on a good ' +
      'run \u2014 so the allowlisted-class control is what has to speak',
    plant: (clone) => {
      const f = join(clone, 'scripts/phase3-secret-scan.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace('          copyFileSync(join(copy, pth), join(twins, name));', '          void name;');
      if (broken === s) throw new Error('could not break the twin pass: it no longer copies each skipped file in the shape this plant edits');
      writeFileSync(f, broken);
      commitInClone(clone, 'stop the second pass from copying what it scans');
    },
    expect: /NOT reported through its twin|not reported through its twin/,
    refuse: /lists 0 files|below the MIN_RELEASE_FILES floor/,
  },
  {
    id: 'S7',
    viaClone: true,
    what:
      'the coordinator\u2019s round-7 B1, as a case: gitleaks is pointed at an EMPTY directory while the tree still ' +
      'holds its files. Both halves of the old law survived this untouched \u2014 the inventory count and the scan\u2019s ' +
      'own count are the same computation, so the scan printed "1051 files scanned" and PASS over a tree it had ' +
      'not read. Only the positive control can speak here',
    plant: (clone) => {
      const f = join(clone, 'scripts/phase3-secret-scan.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace(
        "{ cwd: copy, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },",
        // The throwaway directory removes ITSELF at exit (round-8 R8): the
        // earlier form left a `p15-blind-*` directory in /tmp behind every run
        // of this proof, which is a proof harness littering the box it shares
        // with the authoritative runs.
        "{ cwd: ((): string => { const d = mkdtempSync(join(tmpdir(), 'p15-blind-')); process.on('exit', () => rmSync(d, { recursive: true, force: true })); return d; })(), encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },",
      );
      if (broken === s) throw new Error('could not blind gitleaks: the scan no longer runs it with `cwd: copy` in the shape this plant edits');
      writeFileSync(f, broken);
      commitInClone(clone, 'point gitleaks at an empty directory');
    },
    expect: /positive control planted in the scanned copy/,
    refuse: /\[source-binding\]/,
  },
  {
    id: 'S8',
    viaClone: true,
    what:
      'the control is not REQUESTED at all. A canary that was never planted must fail exactly as an unreported ' +
      'one does: `null` is "I did not look", and the whole round is about those two never printing the same way',
    plant: (clone) => {
      const f = join(clone, 'scripts/phase15/release-secret-scan.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace('scanTree({ root, gitleaks, canary: true, coverage: true })', 'scanTree({ root, gitleaks, coverage: true })');
      if (broken === s) throw new Error('could not remove the canary request: the release scan no longer asks for it in the shape this plant edits');
      writeFileSync(f, broken);
      commitInClone(clone, 'stop asking for a positive control');
    },
    expect: /no positive control was planted in the scanned copy/,
    refuse: /\[source-binding\]/,
  },
];

function freshClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-scan-proof-'));
  const clone = join(dir, 'daftar');
  // --no-hardlinks on purpose: a sandbox that shares an inode with the
  // original is not a sandbox, and this pack's rules say so explicitly.
  sh(dir, 'git', ['clone', '--no-hardlinks', '--quiet', ROOT, clone]);
  return clone;
}

/**
 * The scan under test, whose non-zero exit is the MEASUREMENT this harness
 * makes — so it cannot go through `sh()`, which refuses one.
 *
 * The distinction is the point of round-8 N1 rather than a way around it: for
 * every setup command a non-zero exit means the plant did not happen and the
 * case is void, which is why `sh()` throws; for THIS command the exit code is
 * the observation, and every caller below compares it.
 */
function runScan(clone: string, viaClone = false): { status: number | null; out: string } {
  const script = join(viaClone ? clone : ROOT, 'scripts/phase15/release-secret-scan.ts');
  const r = spawnSync('npx', ['tsx', script, `--root=${clone}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`the scan under test could not start: ${r.error.message}`);
  if (r.status === null) throw new Error(`the scan under test was killed by ${r.signal ?? 'an unknown signal'}, so there is no measurement here`);
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): number {
  console.log('P15 — RED PROOF: THE RELEASE SECRET SCAN’S SOURCE-BINDING AND RULE-INTEGRITY LAWS');
  console.log('='.repeat(78));
  console.log(`subject: clones of ${ROOT}, made with --no-hardlinks; this repository is never written`);
  console.log('');

  let base: string;
  try {
    base = freshClone();
  } catch (e) {
    console.log(`SETUP FAILED — ${e instanceof Error ? e.message : String(e)}`);
    console.log('Nothing below ran, so nothing is claimed.');
    return 2;
  }
  const b = runScan(base);
  const baseOk = b.status === 0;
  console.log(`S0 BASELINE   an untouched clone scans clean: ${baseOk ? 'PASS' : 'FAIL'} (exit ${String(b.status)})`);
  if (!baseOk) {
    console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a later');
    console.log('  red to a planted defect. Last lines of the run:');
    for (const l of b.out.trim().split('\n').slice(-12)) console.log(`    ${l}`);
    rmSync(join(base, '..'), { recursive: true, force: true });
    return 1;
  }
  rmSync(join(base, '..'), { recursive: true, force: true });
  console.log('');

  let failures = 0;
  for (const c of CASES) {
    let clone: string;
    try {
      clone = freshClone();
      c.plant(clone);
    } catch (e) {
      console.log(`${c.id} NOT MEASURED — the plant could not be set up: ${e instanceof Error ? e.message : String(e)}`);
      failures += 1;
      continue;
    }
    const got = runScan(clone, c.viaClone === true);
    const red = got.status !== 0;
    const named = c.expect.test(got.out);
    const unconfounded = c.refuse === undefined ? true : !c.refuse.test(got.out);
    console.log(`${c.id} ${red && named && unconfounded ? 'RED AS REQUIRED' : 'DID NOT PROVE ITS LAW'}  exit ${String(got.status)}`);
    console.log(`   planted : ${c.what}`);
    console.log(`   expected: the scan names it — /${c.expect.source}/`);
    if (c.refuse !== undefined) console.log(`   and NOT : /${c.refuse.source}/ — another law speaking here would make this red unattributable`);
    if (red && named && unconfounded) {
      const line = got.out.split('\n').find((l) => c.expect.test(l));
      console.log(`   said    : ${(line ?? '').trim().slice(0, 160)}`);
    } else {
      failures += 1;
      console.log(
        `   PROBLEM : ${!red ? 'it stayed GREEN with the defect planted' : !named ? 'red, but it never named the defect, so the red is unattributed' : 'red and named, but ANOTHER law also fired, so this run is confounded and proves neither'}`,
      );
      for (const l of got.out.trim().split('\n').slice(-14)) console.log(`     ${l}`);
    }
    rmSync(join(clone, '..'), { recursive: true, force: true });
    console.log('');
  }

  console.log('='.repeat(78));
  if (failures > 0) {
    console.log(`${failures} OF ${CASES.length} LAWS ARE UNPROVED. An unreachable fail arm is not a law, which is exactly`);
    console.log('how "N files, N bound" came to print as coverage while being a tautology.');
    return 1;
  }
  console.log(`ALL ${CASES.length} RED PROOFS TURNED THE SCAN RED, EACH NAMING ITS OWN DEFECT.`);
  console.log('  All THREE of the laws the scan declares now have one: binding (S1, S2), rule integrity');
  console.log('  (S3, S4) and independent non-vacuity (S5, S6 for the subject set, S7 and S8 for the');
  console.log('  positive control, which is the half that shows the files were READ). The last of those is the one the scan\u2019s own');
  console.log('  header calls its only defence against reading nothing and printing a clean nothing, and it');
  console.log('  was the one with no proof behind it until round 7 asked — a guard nobody can delete by');
  console.log('  accident is a guard with a case protecting it, not a guard with a comment.');
  console.log('  So the source-binding count is a comparison that can fail, not an N-of-N, AND a scan');
  console.log('  pointed at an empty or implausibly small tree is a failure rather than a clean result.');
  return 0;
}

process.exitCode = main();
