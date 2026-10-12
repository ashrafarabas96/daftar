/**
 * P15 — RED PROOF FOR THE ALERT-SIGNAL CHECK
 * ==========================================
 *
 * The independent challenger rejected this pack for two claims that were
 * printed as measurements and were not measurements: `RECEIVER` came from
 * `const receiver = 'UNDECIDED'`, and the `RESOLUTION` verdict came from a
 * fixed string that was never compared to the field — so it kept printing
 * "resolution is not modelled at all" for hours after every rule had gained a
 * resolution object, and exited 0 while doing it.
 *
 * Both are now derived. That is necessary and not sufficient: a derived claim
 * is only worth what its ability to go RED is worth, and the whole reason the
 * old claims survived is that nobody could tell the difference between a check
 * that passed and a check that could not fail. «لا تعتبر الأخضر دليلًا إن لم
 * يُثبَت أنه قادر على أن يصير أحمر.»
 *
 * So this plants a defect of each class in a COPY of the rule set and requires
 * `verify:alert-signals` to exit non-zero and to NAME it:
 *
 *   R1  a routing key appears on a rule        → the receiver claim is stale
 *   R2  a destination-shaped value appears     → likewise, by value not key
 *   R3  a rule loses its `resolution`          → a rule carries no resolution
 *   R4  a resolution class contradicts its own
 *       expression                             → class disagrees
 *   R5  a `closure_requirement` is emptied     → empty closure_requirement
 *
 * R1 and R2 are the challenger's F-01 made falsifiable: the column now goes red
 * when routing appears, which is exactly what the constant could never do.
 *
 * WHAT THIS DOES NOT TOUCH
 *
 * The shared document is never written. Every mutation is applied to a copy
 * under this process's own scratch directory, the check is pointed at the copy
 * through `P15_ALERT_RULES`, and the copy is deleted at the end. The baseline
 * run (R0) proves the copy is accepted BEFORE anything is planted, so a red
 * result later is attributable to the mutation and not to the copying.
 *
 * A red proof that cannot say WHICH check it reddened is the defect this pack
 * recorded in Phase 6 («قيد يُطلَق أولًا يحجب القيد الذي تختبره»), so each case
 * asserts on the text of its own finding, not merely on a non-zero exit.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const DEFAULT_RULES = '/mnt/project-files/phase15/P15-ALERT-RULES.json';

interface Case {
  readonly id: string;
  readonly what: string;
  /** mutate the parsed rule set in place. */
  readonly plant: (doc: { rules: Record<string, unknown>[] }) => void;
  /** the finding text the check must produce. */
  readonly expect: RegExp;
}

const CASES: readonly Case[] = [
  {
    id: 'R1',
    what: 'a routing KEY appears on one rule (the exact change the old constant could not notice)',
    plant: (doc) => {
      const r = doc.rules[0];
      if (r !== undefined) r['receiver'] = 'oncall-placeholder';
    },
    expect: /receiver claim is STALE/i,
  },
  {
    id: 'R2',
    what: 'a differently-named routing key appears (`notification_channel`), to prove the match is not a hard-coded key list of one',
    plant: (doc) => {
      const r = doc.rules[3];
      if (r !== undefined) r['notification_channel'] = 'ops-room';
    },
    expect: /receiver claim is STALE/i,
  },
  {
    id: 'R3',
    what: 'one rule loses its `resolution` object entirely',
    plant: (doc) => {
      const r = doc.rules[5];
      if (r !== undefined) delete r['resolution'];
    },
    expect: /carry no resolution/i,
  },
  {
    id: 'R4',
    what: 'a resolution class is changed to one its own expression contradicts',
    plant: (doc) => {
      for (const r of doc.rules) {
        const res = r['resolution'] as Record<string, unknown> | undefined;
        if (res !== undefined && res['class'] === 'self_clearing_window') {
          res['class'] = 'state_based';
          return;
        }
      }
      throw new Error('no self_clearing_window rule to mutate: the proof cannot be run as written');
    },
    expect: /class disagrees with the expression/i,
  },
  {
    id: 'R5',
    what: 'a `closure_requirement` is emptied, which would let a rule clear with nothing recorded',
    plant: (doc) => {
      for (const r of doc.rules) {
        const res = r['resolution'] as Record<string, unknown> | undefined;
        if (res !== undefined) {
          res['closure_requirement'] = '   ';
          return;
        }
      }
      throw new Error('no resolution object to mutate: the proof cannot be run as written');
    },
    expect: /empty closure_requirement/i,
  },
];

function runCheck(subject: string): { readonly code: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/phase15/verify-alert-signals.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P15_ALERT_RULES: subject },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): number {
  console.log('P15 — RED PROOF: CAN THE ALERT-SIGNAL CHECK GO RED?');
  console.log('='.repeat(78));

  const dir = mkdtempSync(join(tmpdir(), 'p15-alert-proof-'));
  const subject = join(dir, 'P15-ALERT-RULES.json');
  let failures = 0;

  try {
    const pristine = readFileSync(DEFAULT_RULES, 'utf8');
    writeFileSync(subject, pristine);
    console.log(`subject copy : ${subject}`);
    console.log(`the shared document at ${DEFAULT_RULES} is READ and never written.`);
    console.log('');

    // R0: the copy must be ACCEPTED before anything is planted. Without this,
    // a red result below could be an artefact of copying rather than of the
    // defect, and the proof would prove nothing.
    const base = runCheck(subject);
    const baseOk = base.code === 0;
    console.log(`R0 BASELINE   the untouched copy is accepted: ${baseOk ? 'PASS' : 'FAIL'} (exit ${String(base.code)})`);
    if (!baseOk) {
      console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a');
      console.log('  later red to a planted defect. First lines of the run:');
      for (const l of base.out.split('\n').slice(-12)) console.log(`    ${l}`);
      return 1;
    }
    console.log('');

    for (const c of CASES) {
      const doc = JSON.parse(pristine) as { rules: Record<string, unknown>[] };
      c.plant(doc);
      writeFileSync(subject, JSON.stringify(doc, null, 2));
      const got = runCheck(subject);
      const red = got.code !== 0;
      const named = c.expect.test(got.out);
      const ok = red && named;
      console.log(`${c.id} ${ok ? 'RED AS REQUIRED' : 'FAILED'}  exit ${String(got.code)}`);
      console.log(`   planted : ${c.what}`);
      console.log(`   expected: the check names it — /${c.expect.source}/`);
      if (!ok) {
        failures += 1;
        console.log(`   ! ${red ? 'it went red but did NOT name this defect, so it may have reddened on something else' : 'IT STAYED GREEN — the check cannot detect this class at all'}`);
        const tail = got.out.split('\n').filter((l) => /EXIT 1|·/.test(l)).slice(0, 6);
        for (const l of tail) console.log(`     ${l}`);
      } else {
        const line = got.out.split('\n').find((l) => c.expect.test(l));
        if (line !== undefined) console.log(`   it said : ${line.trim().slice(0, 150)}`);
      }
      console.log('');
    }

    // The copy is restored and re-checked, so the proof ends by showing the
    // subject green again: a mutation left behind would make every later run a
    // measurement of this proof's leftovers.
    writeFileSync(subject, pristine);
    const after = runCheck(subject);
    const restored = after.code === 0;
    console.log(`RESTORE       the copy is accepted again after every mutation: ${restored ? 'PASS' : 'FAIL'} (exit ${String(after.code)})`);
    if (!restored) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('='.repeat(78));
  if (failures === 0) {
    console.log(`ALL ${CASES.length} RED PROOFS TURNED THE CHECK RED, EACH NAMING ITS OWN DEFECT.`);
    console.log('  So the receiver and resolution claims are measurements: they can fail, and what');
    console.log('  makes them fail is known. UNDECIDED is now a conclusion from the rule set’s key');
    console.log('  set — if a receiver is ever recorded, R1 and R2 are what will notice.');
    return 0;
  }
  console.log(`${failures} RED PROOF(S) DID NOT REDDEN THE CHECK. The check is weaker than it claims.`);
  return 1;
}

process.exitCode = main();
