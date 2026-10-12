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
    console.log(`${c.id} ${red && named ? 'RED AS REQUIRED' : 'DID NOT PROVE ITS LAW'}  exit ${String(got.status)}`);
    console.log(`   planted : ${c.what}`);
    console.log(`   expected: the scan names it — /${c.expect.source}/`);
    if (red && named) {
      const line = got.out.split('\n').find((l) => c.expect.test(l));
      console.log(`   said    : ${(line ?? '').trim().slice(0, 160)}`);
    } else {
      failures += 1;
      console.log(`   PROBLEM : ${red ? 'red, but it never named the defect, so the red is unattributed' : 'it stayed GREEN with the defect planted'}`);
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
  console.log('  So the source-binding count is a comparison that can fail, not an N-of-N.');
  return 0;
}

process.exitCode = main();
