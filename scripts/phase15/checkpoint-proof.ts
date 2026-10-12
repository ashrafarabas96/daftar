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
  /**
   * When set, the case is about the GENERATOR rather than the check: the copy
   * is written with this extra environment, and `expect` is matched against
   * the WRITTEN DOCUMENT, with `refuse` naming text that must NOT appear in it.
   */
  readonly writeEnv?: Record<string, string>;
  readonly refuse?: RegExp;
  /**
   * When set, the generator case is about a REFUSAL: the write must exit
   * non-zero, the document on disk must be byte-identical afterwards, and
   * `expect` is matched against the generator's OUTPUT instead of the document.
   * A refusal that still wrote something is not a refusal, so the bytes are
   * compared rather than assumed.
   */
  readonly mustRefuseToWrite?: boolean;
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
    id: 'C6',
    what:
      'coordinator F-5 / challenger round 6: with the base ref ABSENT, `git rev-parse` exits 128 having echoed ' +
      'the REF NAME to stdout, and the generator wrote the literal string "origin/main" into a shared project ' +
      'file as the last known-good release SHA — and exited 0. The migrations fact was worse: a `git diff` that ' +
      'exited 128 filtered to nothing and the file recorded "the frozen set is untouched"',
    writeEnv: { P15_BASE_REF: 'refs/p15-proof/does-not-exist' },
    mustRefuseToWrite: true,
    plant: () => {
      /* nothing to plant: the defect is in what the GENERATOR does */
    },
    // ROUND 6, H-03 — THE LAW GOT STRICTER, SO THIS CASE DID.
    //
    // The first fix made the four base facts say UNMEASURED instead of echoing
    // the ref name, and this case checked the written document for that text.
    // The challenger's round-6 measurement went one step further and was right:
    // `--write` still exited 0 and PERSISTED a document whose base, merge-base,
    // commits-ahead and migration diff all read "could not look". A checkpoint
    // is a position to resume from; that document is not one, and exit 0 told
    // the next reader it was. So the law is now a REFUSAL, and what this case
    // measures is the refusal: non-zero, every unmeasured base fact named, and
    // the document on disk byte-identical afterwards.
    expect: /NOTHING WAS WRITTEN[\s\S]*last known good SHA on the base/,
    // Anchored to the AFFIRMATIVE claim. A first version of this pattern was
    // just "the frozen set is untouched", and it matched the fix's own
    // disclaimer — "This is NOT a statement that the frozen set is untouched" —
    // so a correct document failed its own proof. A refusal pattern has to
    // name the sentence it refuses, not a phrase inside it.
    refuse: /NONE — the frozen set is untouched/,
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
    const before = c.writeEnv === undefined ? '' : readFileSync(join(dir, 'P15-RESUME-CHECKPOINT.md'), 'utf8');
    if (c.writeEnv !== undefined) {
      // A GENERATOR case: rewrite the copy with the extra environment, then
      // read the DOCUMENT rather than the check's verdict, because the defect
      // is a false value written into a file.
      const w = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/resume-checkpoint.ts'), '--write'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, P15_PACK_DIR: dir, ...c.writeEnv },
      });
      const doc = readFileSync(join(dir, 'P15-RESUME-CHECKPOINT.md'), 'utf8');
      if (c.mustRefuseToWrite === true) {
        const out = `${w.stdout ?? ''}${w.stderr ?? ''}`;
        const refusedToRun = w.status !== null && w.status !== 0;
        const unchanged = doc === before;
        const saidWhy = c.expect.test(out);
        const noFalseClaim = c.refuse === undefined ? true : !c.refuse.test(out);
        const ok = refusedToRun && unchanged && saidWhy && noFalseClaim;
        if (!ok) failures += 1;
        console.log(`${c.id} ${ok ? 'REFUSED AS REQUIRED' : 'DID NOT PROVE ITS LAW'}  generator exit ${String(w.status)}`);
        console.log(`   planted : ${c.what}`);
        console.log(`   required: non-zero exit, the document byte-identical, and each unmeasured base fact named`);
        console.log(`   measured: exit ${String(w.status)}, document ${unchanged ? 'UNCHANGED' : 'REWRITTEN'}, reason ${saidWhy ? 'named' : 'NOT named'}`);
        if (!ok)
          console.log(
            `   PROBLEM : ${!refusedToRun ? 'it exited 0, so a position nobody can resume from was published as one' : !unchanged ? 'it refused and wrote anyway, which is not a refusal' : 'it refused without naming which positions it could not measure'}`,
          );
        rmSync(dir, { recursive: true, force: true });
        console.log('');
        continue;
      }
      const named = c.expect.test(doc);
      const refused = c.refuse === undefined ? true : !c.refuse.test(doc);
      console.log(`${c.id} ${named && refused ? 'PROVED' : 'DID NOT PROVE ITS LAW'}  generator exit ${String(w.status)}`);
      console.log(`   planted : ${c.what}`);
      console.log(`   expected: the document says it could not measure — /${c.expect.source}/`);
      console.log(`   and NOT : /${c.refuse?.source ?? '(nothing)'}/`);
      if (named && refused) {
        const line = doc.split('\n').find((l) => c.expect.test(l));
        console.log(`   said    : ${(line ?? '').trim().slice(0, 150)}`);
      } else {
        failures += 1;
        console.log(`   PROBLEM : ${named ? 'it also wrote text it must refuse to write' : 'the document does not say the value was unmeasured'}`);
      }
      rmSync(dir, { recursive: true, force: true });
      console.log('');
      continue;
    }
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
  // Not all of them redden a CHECK any more: one of them requires the GENERATOR
  // to refuse to write at all, which is a different law and says so. A closing
  // line that totalled them under the wrong verb would be the same small
  // untruth this pack keeps finding in its own prose.
  console.log(
    `ALL ${CASES.length} CASES BEHAVED: ${CASES.filter((c) => c.mustRefuseToWrite !== true).length} turned the currency check RED naming their own defect, and ${CASES.filter((c) => c.mustRefuseToWrite === true).length} made the generator REFUSE to write, leaving the document byte-identical.`,
  );
  console.log('  So "CURRENT" is a measurement over the pack and not only over the head: absence,');
  console.log('  drift, an unrecorded document and an empty table each change the verdict.');
  return 0;
}

process.exitCode = main();
