/**
 * P15 — RED PROOF: CAN THE RESUME CHECKPOINT'S CURRENCY CHECK GO RED?
 * ===========================================================================
 *
 * The independent challenger's round-4 finding: the checkpoint reported
 * CURRENT after all fourteen pack documents had been DELETED. The check
 * compared the recorded head to HEAD and nothing else, and deleting a file
 * moves no SHA, so absence was invisible to a check whose whole purpose is to
 * tell a resuming session whether the documents it is about to trust are
 * still there.
 *
 * That defect could exist because the currency check had no red proof. A check
 * nobody has ever seen fail is a check whose failure path is untested, and the
 * pack has already recorded that lesson twice under other names. So each law
 * the check now states gets a planted defect here, and the check must go red
 * naming it.
 *
 * DISCIPLINE
 *   · The shared pack at /mnt/project-files/phase15 is COPIED, never written.
 *     Every plant happens in the copy, and the checkpoint is pointed at it
 *     with P15_PACK_DIR, which makes it print `! NOT THE DEFAULT PACK`.
 *   · A BASELINE runs first. If the untouched copy is not already green, every
 *     plant below it is invalid, because a later red cannot then be attributed
 *     to the plant.
 *   · Each case declares the TEXT the check must produce. A red for the wrong
 *     reason is not a proof, so the output is matched, not just the exit code.
 *
 * Usage: npm run checkpoint:phase15:prove
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SOURCE_PACK = '/mnt/project-files/phase15';

interface Case {
  readonly id: string;
  readonly what: string;
  /** mutate the COPY in place. */
  readonly plant: (dir: string) => void;
  readonly expect: RegExp;
}

const CASES: readonly Case[] = [
  {
    id: 'C1',
    what:
      'the challenger’s own plant: every pack document deleted, head untouched. The check reported CURRENT, ' +
      'because deleting a file moves no SHA',
    plant: (dir) => {
      let removed = 0;
      for (const f of readdirSync(dir)) {
        if (/^P15-.*\.(md|json)$/.test(f) && f !== 'P15-RESUME-CHECKPOINT.md') {
          rmSync(join(dir, f));
          removed += 1;
        }
      }
      if (removed === 0) throw new Error('nothing was deleted, so this proof would prove nothing');
    },
    expect: /THE HEAD MATCHES BUT THE PACK DOES NOT/,
  },
  {
    id: 'C2',
    what: 'ONE document deleted — the single-file case, because a check can catch a wholesale deletion and miss one file',
    plant: (dir) => {
      rmSync(join(dir, 'P15-DR-RUNBOOK.md'));
    },
    expect: /MISSING {2}P15-DR-RUNBOOK\.md/,
  },
  {
    id: 'C3',
    what: 'a document EDITED rather than removed: content drift against the recorded digest',
    plant: (dir) => {
      const f = join(dir, 'P15-THREAT-MODEL.md');
      writeFileSync(f, `${readFileSync(f, 'utf8')}\n\nAn edit nobody recorded.\n`);
    },
    expect: /DRIFTED {2}P15-THREAT-MODEL\.md/,
  },
  {
    id: 'C4',
    what: 'a NEW document appearing that the checkpoint never recorded — the index is incomplete, which is its own staleness',
    plant: (dir) => {
      writeFileSync(join(dir, 'P15-NOT-IN-THE-TABLE.md'), 'A document written after the checkpoint was generated.\n');
    },
    expect: /UNRECORDED P15-NOT-IN-THE-TABLE\.md/,
  },
  {
    id: 'C5',
    what: 'the checkpoint’s own digest table emptied while its head stays right: it indexes nothing, so it vouches for nothing',
    plant: (dir) => {
      const f = join(dir, 'P15-RESUME-CHECKPOINT.md');
      const kept = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\|\s*`P15-[^`]+`\s*\|/.test(l))
        .join('\n');
      writeFileSync(f, kept);
    },
    expect: /RECORDS NO DOCUMENT AT ALL/,
  },
];

function runCheck(dir: string): { readonly status: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/resume-checkpoint.ts'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P15_PACK_DIR: dir },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-ckpt-proof-'));
  cpSync(SOURCE_PACK, dir, { recursive: true });
  return dir;
}

function main(): number {
  console.log('P15 — RED PROOF: CAN THE RESUME CHECKPOINT CURRENCY CHECK GO RED?');
  console.log('='.repeat(78));
  console.log(`source pack : ${SOURCE_PACK} — READ and never written`);
  console.log('');

  // The checkpoint must be regenerated in the copy first, so the baseline is a
  // checkpoint that describes THIS head. Without that, C1..C5 would all be red
  // for staleness and prove nothing about absence.
  const baseDir = freshCopy();
  const written = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/resume-checkpoint.ts'), '--write'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P15_PACK_DIR: baseDir },
  });
  if (written.status !== 0) {
    console.log(`SETUP FAILED — could not generate a checkpoint in the copy (exit ${String(written.status)}).`);
    console.log(`${written.stdout ?? ''}${written.stderr ?? ''}`.slice(0, 600));
    console.log('Nothing below ran, so nothing is claimed.');
    return 2;
  }
  const base = runCheck(baseDir);
  const baseOk = base.status === 0;
  console.log(`C0 BASELINE   the untouched copy is CURRENT: ${baseOk ? 'PASS' : 'FAIL'} (exit ${String(base.status)})`);
  if (!baseOk) {
    console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a');
    console.log('  later red to a planted defect. First lines of the run:');
    for (const l of base.out.split('\n').slice(0, 14)) console.log(`    ${l}`);
    rmSync(baseDir, { recursive: true, force: true });
    return 1;
  }
  console.log('');

  let failures = 0;
  for (const c of CASES) {
    // Each case starts from its OWN regenerated copy, so one plant can never
    // be the reason the next one reds.
    const dir = freshCopy();
    const gen = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/resume-checkpoint.ts'), '--write'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, P15_PACK_DIR: dir },
    });
    if (gen.status !== 0) {
      console.log(`${c.id} NOT MEASURED — the copy's checkpoint could not be generated (exit ${String(gen.status)})`);
      failures += 1;
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    c.plant(dir);
    const got = runCheck(dir);
    const red = got.status !== 0;
    const named = c.expect.test(got.out);
    console.log(`${c.id} ${red && named ? 'RED AS REQUIRED' : 'DID NOT PROVE ITS LAW'}  exit ${String(got.status)}`);
    console.log(`   planted : ${c.what}`);
    console.log(`   expected: the check names it — /${c.expect.source}/`);
    if (red && named) {
      const line = got.out.split('\n').find((l) => c.expect.test(l));
      console.log(`   said    : ${(line ?? '').trim()}`);
    } else {
      failures += 1;
      console.log(`   PROBLEM : ${red ? 'it went red but never named the defect, so the red is unattributed' : 'it stayed GREEN with the defect planted'}`);
      for (const l of got.out.split('\n').slice(0, 20)) console.log(`     ${l}`);
    }
    rmSync(dir, { recursive: true, force: true });
    console.log('');
  }
  rmSync(baseDir, { recursive: true, force: true });

  console.log('='.repeat(78));
  if (failures > 0) {
    console.log(`${failures} OF ${CASES.length} LAWS ARE UNPROVED. A currency check whose failure path is untested is`);
    console.log('how a checkpoint came to print CURRENT with every document deleted.');
    return 1;
  }
  console.log(`ALL ${CASES.length} RED PROOFS TURNED THE CURRENCY CHECK RED, EACH NAMING ITS OWN DEFECT.`);
  console.log('  So "CURRENT" is a measurement over the pack and not only over the head: absence,');
  console.log('  drift, an unrecorded document and an empty table each change the verdict.');
  return 0;
}

process.exitCode = main();
