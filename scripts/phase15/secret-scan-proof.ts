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
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
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
}

function sh(cwd: string, cmd: string, args: readonly string[]): { status: number | null; out: string } {
  const r = spawnSync(cmd, [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
    refuse: /\[source-binding\]/,
  },
  {
    id: 'S6',
    what:
      'the other half of the same law: a tree far too small to be a release. The inventory is non-empty, so the ' +
      '0-file arm cannot be what speaks, and the floor must',
    plant: (clone) => {
      const keep = new Set(['package.json', 'tsconfig.json', 'README.md']);
      const all = sh(clone, 'git', ['ls-files']).out.trim().split('\n').filter((f) => f.length > 0);
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
    refuse: /\[source-binding\]/,
  },
];

function freshClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-scan-proof-'));
  const clone = join(dir, 'daftar');
  // --no-hardlinks on purpose: a sandbox that shares an inode with the
  // original is not a sandbox, and this pack's rules say so explicitly.
  const r = sh(dir, 'git', ['clone', '--no-hardlinks', '--quiet', ROOT, clone]);
  if (r.status !== 0) throw new Error(`clone failed: ${r.out.slice(0, 300)}`);
  return clone;
}

function runScan(clone: string): { status: number | null; out: string } {
  return sh(ROOT, 'npx', ['tsx', join(ROOT, 'scripts/phase15/release-secret-scan.ts'), `--root=${clone}`]);
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
    const got = runScan(clone);
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
  console.log('  (S3, S4) and independent non-vacuity (S5, S6). The last of those is the one the scan\u2019s own');
  console.log('  header calls its only defence against reading nothing and printing a clean nothing, and it');
  console.log('  was the one with no proof behind it until round 7 asked — a guard nobody can delete by');
  console.log('  accident is a guard with a case protecting it, not a guard with a comment.');
  console.log('  So the source-binding count is a comparison that can fail, not an N-of-N, AND a scan');
  console.log('  pointed at an empty or implausibly small tree is a failure rather than a clean result.');
  return 0;
}

process.exitCode = main();
