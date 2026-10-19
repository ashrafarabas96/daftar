/**
 * PHASE 15 — RED PROOF: WHAT A NON-ZERO EXIT CODE MEANS
 * (PREPARED / NOT PROMOTED)
 *
 * Challenge round 6, H-04. The classifier's law is that a crash and a
 * measured-but-adverse run must never print the same way. Half of it had a real
 * proof: a module error injected into an instrument's own process, which dies
 * before its first line and is recorded as CRASHED BEFORE MEASURING with the
 * runner exiting 3. The other half — a crash AFTER the summary line — had only a
 * `beforeExit` hook behind it, and the shape the challenger planted was
 * different: a synchronous `throw` at the end of the instrument's own module
 * evaluation, with its totals already on stdout.
 *
 * That shape cannot be run from inside the runner without editing an instrument
 * in the tree, so this proof copies a real instrument into a scratch directory,
 * appends a real throw, RUNS IT, and classifies what actually came out of the
 * process. Nothing here is a hand-written record: every case is a real exit code
 * and real stdout and stderr.
 *
 * The third and fourth cases are the controls that make the first two mean
 * something: an instrument that finishes adversely must still read as a verdict,
 * and one that finishes cleanly must read as exit 0. A classifier that called
 * everything a crash would pass the first two cases and be useless.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { outcomeClass, scrape } from './outcome-class';

const ROOT = resolve(__dirname, '../..');

/** Run a .ts entry point for real and classify what came out of the process. */
function runAndClassify(
  entry: string,
  env: Readonly<Record<string, string>> = {},
): { readonly code: number | null; readonly cls: string; readonly out: string } {
  const r = spawnSync('npx', ['tsx', entry], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const cls = outcomeClass({ output: out, exitCode: r.status, ran: r.status !== null || r.error === undefined, notRunReason: null, counts: scrape(out) });
  return { code: r.status, cls, out };
}

interface Case {
  readonly id: string;
  readonly what: string;
  /** build the entry point to run, inside `dir`; return its path. */
  readonly build: (dir: string) => string;
  readonly env?: Readonly<Record<string, string>>;
  readonly expect: RegExp;
  readonly why: string;
}

/**
 * The subject is `verify:alert-signals`: it prints a recognised summary, exits 0
 * on the real rule set, and starts no cluster, so a copy of it is cheap to run.
 */
const SUBJECT = 'scripts/phase15/verify-alert-signals.ts';

/**
 * THE SHAPE `pitr:proof` ACTUALLY PRINTS (round 14, F-R14-01).
 *
 * O3b was hand-written as «the shape `pitr:proof` prints it» and left out the
 * machine record the drill prints IMMEDIATELY BEFORE its headline. The
 * classifier took that record for the verdict line, so the arm passed while a
 * real exit-3 transcript was being misclassified. A plant that claims to be a
 * real shape is now ANCHORED in the instrument it claims to copy: these two
 * lines must be present in `pitr-proof.ts`, in this order, or nothing here is
 * measured.
 */
const PITR = 'scripts/phase15/pitr-proof.ts';
const PITR_MACHINE_LINE = 'console.log(`\\nP15_PITR_PROOF: ${JSON.stringify(summary)}`);';
const PITR_HEADLINE_LINE = 'console.log(`PHASE 15 PITR PROOF: ${summary.result}`);';

/**
 * The same obligation for the load harness, which round 15 found still
 * misclassified: O3g planted its shape with a FAIL in it and was therefore
 * green on a classifier that could not read its INVALID MEASUREMENT at all.
 */
const LOAD = 'scripts/phase15/load-harness.ts';
const LOAD_MACHINE_LINE = '`P15_LOAD: ${JSON.stringify({';
const LOAD_HEADLINE_LINE = 'console.log(`P15 LOAD ${profile.id}: ${verdict} — ${because}`);';
const LOAD_CONTENTION_VERDICT = "'INVALID MEASUREMENT': 3,";
/** The KEY the record declares its outcome under — not merely the line that
 *  prints it. Round 16: renaming it left O3i and D3 green over a plant that
 *  no longer matched the instrument (F-R16-03). */
const LOAD_RECORD_KEY = '        verdict,';

/** The two further instruments round 16 found uncovered (F-R16-04, F-R16-05). */
const ROLE = 'scripts/phase15/role-attribute-read.ts';
const ROLE_HEADLINE_LINE = "console.log('EXIT 2 — NOT MEASURED, which is NOT a clean result.');";
const DR = 'scripts/phase15/backup-restore-proof.ts';
const DR_HEADLINE_LINE = 'console.log(`VERDICT: FAIL — ${failed.length} validator(s) failed,';

/** The record `load-harness.ts` prints, with the verdict this case needs in it. */
const loadMachine = (verdict: string): string => `P15_LOAD: {"profile":"P15-LOAD-001","metric":"p95","samples":200,"verdict":"${verdict}"}`;

/** The record `pitr-proof.ts` prints, with the verdict this case needs in it. */
const pitrMachine = (result: string): string => `P15_PITR_PROOF: {"status":"PREPARED / NOT PROMOTED","part":104,"sha":"45cc461","result":"${result}"}`;

function copySubject(dir: string, append: string): string {
  const entry = join(dir, 'subject.ts');
  const src = readFileSync(join(ROOT, SUBJECT), 'utf8');
  // The copy keeps the original's imports working by living beside it in a
  // directory that re-exports nothing: it is run by absolute path with tsx, and
  // its relative imports are rewritten to absolute ones so the copy behaves
  // exactly like the original up to the appended line.
  const fixed = src
    .replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (_m, f: string) => `from '${join(ROOT, 'scripts/phase15', f)}'`)
    .replace(/resolve\(__dirname, '\.\.\/\.\.'\)/g, `'${ROOT}'`);
  writeFileSync(entry, `${fixed}${append}`);
  return entry;
}

const CASES: readonly Case[] = [
  {
    id: 'O1',
    what: "the challenger's shape: a synchronous TypeError at the end of module evaluation, with the summary already printed",
    build: (dir) => copySubject(dir, '\nthrow new TypeError("O1: a crash AFTER the summary line");\n'),
    expect: /MEASURED, THEN THREW/,
    why: 'its totals are on stdout and the process died, so the exit code is not a verdict and the totals describe an incomplete run',
  },
  {
    id: 'O2',
    what: 'a crash BEFORE any measurement — an unresolvable import at the top of the file',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, "import './a-module-that-does-not-exist';\nconsole.log('never printed');\n");
      return entry;
    },
    expect: /CRASHED BEFORE MEASURING/,
    why: 'no summary line was printed at all, so this exit code says nothing about the subject',
  },
  {
    id: 'O3',
    what: 'CONTROL — an instrument that finishes and exits non-zero for its own reason',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, "console.log('23 rules: 23 measured, 0 unmeasured');\nconsole.log('EXIT 1 — A CONTROL, NOT A CRASH');\nprocess.exitCode = 1;\n");
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'a classifier that called every non-zero a crash would pass O1 and O2 and be worthless; an adverse verdict must still read as a verdict',
  },
  {
    id: 'O3b',
    what: 'round 12 — an instrument that declares it could not measure at all, in the shape `pitr:proof` prints it',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('VALIDATORS');",
          "console.log('LIMITATIONS — printed on PASS as well as on FAIL');",
          // The machine record the drill prints BEFORE its headline. Omitting
          // it is what made this arm green over a misclassified transcript.
          `console.log(${JSON.stringify(pitrMachine('INVALID MEASUREMENT — RESOURCE CONTENTION'))});`,
          "console.log('PHASE 15 PITR PROOF: INVALID MEASUREMENT — RESOURCE CONTENTION');",
          "console.log('  port 55474 was still held 30s after this drill asked for it');",
          'process.exitCode = 3;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE — the instrument declared INVALID MEASUREMENT/,
    why: '«the drill did not run» read as «the code is its verdict» — the same confusion the distinct exit code was added to end, one layer out in the record that quotes it. A reader of this table would have taken a held port for a failed disaster-recovery drill',
  },
  {
    id: 'O3c',
    what: 'CONTROL — the same drill, with a validator that DID fail before the contention',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('VALIDATORS');",
          "console.log('  P1 FAIL — archiving never started');",
          "console.log('PHASE 15 PITR PROOF: FAIL');",
          // The contention sentence the real drill prints beside a FAIL. Round
          // 16: this arm's `why` claimed to test «contention in the body» over
          // a transcript that contained none of it, so restoring the whole-
          // transcript defect left it green (F-R16-06).
          "console.log('  INVALID MEASUREMENT — RESOURCE CONTENTION: port 55474 was still held 30s after this drill asked for it');",
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'contention in the body must NOT downgrade a run that reached a verdict: a measured failure is a fact the busy port cannot undo, and a classifier keyed on the mere presence of the word would lose it',
  },
  {
    id: 'O3d',
    what: "round 13's F-R13-05 — a MEASURED failure whose transcript also carries the contention headline at column 0",
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('VALIDATORS');",
          "console.log('  P1 FAIL — archiving never started');",
          "console.log('PHASE 15 PITR PROOF: FAIL');",
          '// Unindented, which is the whole point: O3c passed only because the',
          '// real drill happens to print this line with two leading spaces, so',
          '// the classification rested on whitespace rather than on the verdict.',
          "console.log('INVALID MEASUREMENT — RESOURCE CONTENTION: the recovered cluster could not take port 55474');",
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'the headline was matched anywhere in the transcript and before the verdict was read, so a run that reached FAIL was downgraded to «did not measure» by a later line of its own output. Only the verdict line speaks for the run',
  },
  {
    id: 'O3e',
    what: 'round 14 — an instrument that prints its MACHINE RECORD and no headline at all, declaring contention in it',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [`console.log(${JSON.stringify(pitrMachine('INVALID MEASUREMENT — RESOURCE CONTENTION'))});`, 'process.exitCode = 3;', ''].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE — the instrument declared INVALID MEASUREMENT/,
    why: 'the fallback must read the record\u2019s own `result` rather than treat the blob as a verdict it cannot parse: an instrument that prints only a record still said what it did',
  },
  {
    id: 'O3f',
    what: 'CONTROL — the headline outranks the record: a machine record saying contention under a headline saying FAIL',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('  P1 FAIL — archiving never started');",
          `console.log(${JSON.stringify(pitrMachine('INVALID MEASUREMENT — RESOURCE CONTENTION'))});`,
          "console.log('PHASE 15 PITR PROOF: FAIL');",
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'a synthetic precedence control: the two cannot disagree in `pitr-proof.ts`, and a classifier that preferred the record would lose a measured failure the moment they could. The line the instrument SPEAKS is the headline',
  },
  {
    id: 'O3g',
    what: 'round 15 — the LOAD HARNESS declaring INVALID MEASUREMENT, in the shape it really prints it',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          `console.log(${JSON.stringify(loadMachine('INVALID MEASUREMENT'))});`,
          "console.log('P15 LOAD P15-LOAD-001: INVALID MEASUREMENT — rule 2 fired: the host was contended during the window');",
          'process.exitCode = 3;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE — the instrument declared INVALID MEASUREMENT/,
    why: 'round 14 widened the headline pattern to reach this instrument and left the contention pattern narrow, so its «I could not measure» was filed as «the code is its verdict» for a second round. The old O3g planted a FAIL here and was green over exactly that',
  },
  {
    id: 'O3h',
    what: 'CONTROL — the same load harness shape with a MEASURED failure in it',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          `console.log(${JSON.stringify(loadMachine('FAIL'))});`,
          "console.log('P15 LOAD P15-LOAD-001: FAIL — p95 41.2ms over a 15ms bound');",
          'process.exitCode = 2;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'the headline must still be recognised for the verdicts that ARE verdicts: a fix for the contention case that swallowed a measured failure would be the F-R12-03 defect arriving from the other side',
  },
  {
    id: 'O3i',
    what: 'round 15 — a LOAD record with no headline, declaring contention under the other key name',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, [`console.log(${JSON.stringify(loadMachine('INVALID MEASUREMENT'))});`, 'process.exitCode = 3;', ''].join('\n'));
      return entry;
    },
    expect: /DID NOT MEASURE — the instrument declared INVALID MEASUREMENT/,
    why: 'the record fallback must read the key the instrument actually writes: `pitr-proof.ts` declares its outcome under `result` and `load-harness.ts` under `verdict`, and a fallback that knows one of the two is a fallback for one instrument',
  },
  {
    id: 'O6',
    what: "round 16 — the pack's OTHER spelling of «I could not measure»: `verify:role-attributes` on a real exit 2",
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('  reading pg_roles on the database the caller named');",
          "console.log('EXIT 2 — NOT MEASURED, which is NOT a clean result.');",
          'process.exitCode = 2;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE/,
    why: 'contention is one way an instrument says it did not measure; UNMEASURED and NOT MEASURED are the others, and a record that knows only the first files the rest as verdicts about a subject nobody measured',
  },
  {
    id: 'O7',
    what: 'CONTROL — `backup-restore-proof.ts`\u2019s headline, which opens with VERDICT: and no speaker',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          `console.log(${JSON.stringify('P15_DR_PROOF: {"status":"PREPARED / NOT PROMOTED","pitr":true}')});`,
          "console.log('VERDICT: FAIL — 2 validator(s) failed, 0 UNMEASURED, 0 red proof(s) did not behave.');",
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO — it printed its own verdict line \(“VERDICT: FAIL/,
    why: 'its headline matched no pattern and its record declares its outcome under neither key, so the classifier quoted the JSON blob as the line the run reached — the F-R14-01 shape, in a third instrument',
  },
  {
    id: 'O8',
    what: 'CONTROL — the `EXIT n:` headline, with a colon, which three instruments in this pack print',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        ["console.log('EXIT 1: 3 item(s) carry a FINDING — a named, reproducible gap in this tree.');", 'process.exitCode = 1;', ''].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'the opener was `EXIT n —` with a dash only, so a headline punctuated with a colon was no headline at all',
  },
  {
    id: 'O2b',
    what: 'a LOADER error with no stack trace and no summary — the half only the loader markers can see',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        ["process.stderr.write('node:internal/modules/esm/resolve ERR_MODULE_NOT_FOUND while loading the instrument\\n');", 'process.exitCode = 1;', ''].join(
          '\n',
        ),
      );
      return entry;
    },
    expect: /CRASHED BEFORE MEASURING/,
    why: 'round 16 measured LOADER_MARKERS replaceable by a pattern matching nothing with every arm still green: O2 reaches the same class through its stack trace, so no arm was measuring the loader half at all',
  },
  {
    id: 'O3j',
    what: 'round 16 — a machine record whose own `result` is the bare word UNMEASURED, which `pitr-proof.ts` can print',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, [`console.log(${JSON.stringify(pitrMachine('UNMEASURED'))});`, 'process.exitCode = 1;', ''].join('\n'));
      return entry;
    },
    expect: /DID NOT MEASURE/,
    why: 'a record declares a BARE verdict with no opener in front of it, so a rule that only recognises «did not measure» after an opener reads the pack\u2019s own UNMEASURED result as a verdict about a subject',
  },
  {
    id: 'O3k',
    what: 'round 16 — a record whose two outcome keys DISAGREE, one of them saying it did not measure',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [`console.log(${JSON.stringify('P15_X: {"result":"PASS","verdict":"INVALID MEASUREMENT"}')});`, 'process.exitCode = 3;', ''].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE/,
    why: 'the first key read used to win, so a PASS under one name silently shadowed «I could not measure» under the other — the F-R13-05 shape with the two lines swapped',
  },
  {
    id: 'O6b',
    what: 'round 16 — «I could not measure» behind the OTHER opener punctuation, a colon',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, ["console.log('EXIT 2: NOT MEASURED — the caller named no database.');", 'process.exitCode = 2;', ''].join('\n'));
      return entry;
    },
    expect: /DID NOT MEASURE/,
    why: 'three instruments in this pack punctuate that headline with a colon, and an opener list written for one of them speaks for none of the others',
  },
  {
    id: 'O6c',
    what: "round 17 — the pack's FOURTH spelling of «I could not measure»: `load-harness.ts`'s refusal line",
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          `console.log(${JSON.stringify('P15_LOAD_REFUSAL: PROFILE-NOT-FOUND — no profile with id "does-not-exist" in load-profiles.json')});`,
          "console.log('P15 LOAD: NO VERDICT — a refusal is not a FAIL and is never a PASS.');",
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE/,
    why: 'round 16 named four spellings in its own remedy and shipped three. A real refusal of a real instrument was filed as «no verdict line this runner recognises» — honest, but the instrument had said it did not measure, in a sentence this record could not hear',
  },
  {
    id: 'O9',
    what: 'round 17 — a run that reaches its SUMMARY LINE, prints no verdict line at all, and then throws',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('23 rules: 23 measured, 0 unmeasured, 0 findings');",
          '// No headline and no machine record, so `reachedVerdict` cannot stand',
          '// in for the summary scrape: this arm rests on SUMMARY_LINE alone.',
          "throw new TypeError('O9: a crash after the totals, with nothing but the totals to show for it');",
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN THREW/,
    why: 'round 17 measured `SUMMARY_LINE` replaceable by a pattern matching nothing with all twenty arms still green, while the rule decides two branches of the classifier: without it this run reads «CRASHED BEFORE MEASURING», which discards a measurement that happened',
  },
  {
    id: 'O10',
    what: "round 18's F-R18-09 — a refusal headline with NO speaker and no `EXIT n`, the shape `verify-role-convergence.ts` actually prints",
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('UNMEASURED: none of 969b8605, origin/phase/4-sales-pos-customers-receivables is reachable in this repository.');",
          "console.log('  Fetch the Phase 4 ref and re-run. Nothing is claimed about a tree this box cannot read.');",
          '// No `EXIT n —`, no `SPEAKER:`, no machine record. This is a real',
          '// transcript from a real run, and it was filed UNCLASSIFIED while the',
          '// rule that classifies it was in the file and never handed the line.',
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /DID NOT MEASURE — the instrument declared that it did not measure/,
    why: 'a refusal that names no speaker is still a refusal; filing it UNCLASSIFIED sends the reader to the log for a line the classifier already understands',
  },
  {
    id: 'O10b',
    what: 'THE CONTROL for O10 — a run that refuses ONE subject and then reaches a verdict has reached a verdict',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(
        entry,
        [
          "console.log('UNMEASURED: one subject was skipped.');",
          "console.log('EXIT 1 — FAIL: two checks failed.');",
          '// The bare refusal must NOT outrank a verdict headline, or widening',
          '// the headline rule would downgrade a measured FAIL to «did not',
          '// measure» — the wrong direction to be wrong in.',
          'process.exitCode = 1;',
          '',
        ].join('\n'),
      );
      return entry;
    },
    expect: /MEASURED, THEN EXITED NON-ZERO/,
    why: 'the round-18 widening is read only where nothing else spoke for the run; without this control it could silently downgrade every verdict preceded by a skipped subject',
  },
  {
    id: 'O4',
    what: 'CONTROL — a clean run',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, "console.log('23 rules: 23 measured, 0 unmeasured');\n");
      return entry;
    },
    expect: /COMPLETED, exit 0/,
    why: 'the zero case must be untouched by all of the above',
  },
  {
    id: 'O5',
    what: 'a stack trace with NO summary and NO verdict line, on a non-zero exit',
    build: (dir) => {
      const entry = join(dir, 'subject.ts');
      writeFileSync(entry, "console.log('some progress output nobody can total');\nthrow new RangeError('O5');\n");
      return entry;
    },
    expect: /CRASHED BEFORE MEASURING/,
    why: 'output that cannot be totalled is not a measurement, however much of it there is',
  },
];

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — RED PROOF: THE OUTCOME CLASSIFIER   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  console.log(`  subject   ${SUBJECT}, copied per case. The tree is READ and never written.`);
  console.log('  Every case below is a REAL process: a real exit code, real stdout, real stderr.');
  const pitr = readFileSync(join(ROOT, PITR), 'utf8');
  const machineAt = pitr.indexOf(PITR_MACHINE_LINE);
  const headlineAt = pitr.indexOf(PITR_HEADLINE_LINE);
  if (machineAt < 0 || headlineAt < 0 || machineAt > headlineAt) {
    console.log('');
    console.log(`  O3b and O3f claim to copy what ${PITR} prints, and this is no longer what it prints:`);
    console.log(`    machine record line  ${machineAt < 0 ? 'NOT FOUND' : `at offset ${String(machineAt)}`}`);
    console.log(`    headline line        ${headlineAt < 0 ? 'NOT FOUND' : `at offset ${String(headlineAt)}`}`);
    console.log('    required order       the record BEFORE the headline, which is what defeated the classifier');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A plant that claims a real shape and cannot find it measures nothing.');
    return 2;
  }
  const load = readFileSync(join(ROOT, LOAD), 'utf8');
  const loadMachineAt = load.indexOf(LOAD_MACHINE_LINE);
  const loadHeadlineAt = load.indexOf(LOAD_HEADLINE_LINE);
  if (loadMachineAt < 0 || loadHeadlineAt < 0 || loadMachineAt > loadHeadlineAt || !load.includes(LOAD_CONTENTION_VERDICT)) {
    console.log('');
    console.log(`  O3g and O3h claim to copy what ${LOAD} prints, and this is no longer what it prints:`);
    console.log(`    machine record line  ${loadMachineAt < 0 ? 'NOT FOUND' : `at offset ${String(loadMachineAt)}`}`);
    console.log(`    headline line        ${loadHeadlineAt < 0 ? 'NOT FOUND' : `at offset ${String(loadHeadlineAt)}`}`);
    console.log(`    the verdict planted  ${load.includes(LOAD_CONTENTION_VERDICT) ? 'is still one of its own' : 'is NOT one of its own any more'}`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A plant that claims a real shape and cannot find it measures nothing.');
    return 2;
  }
  console.log(`  anchored  ${PITR} still prints its machine record before its headline, which is the shape O3b plants.`);
  if (!load.includes(LOAD_RECORD_KEY)) {
    console.log('');
    console.log(`  O3i plants a record whose outcome key is \`verdict\`, and ${LOAD} no longer declares it under that key.`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A plant that claims a real shape and cannot find it measures nothing.');
    return 2;
  }
  const role = readFileSync(join(ROOT, ROLE), 'utf8');
  const dr = readFileSync(join(ROOT, DR), 'utf8');
  if (!role.includes(ROLE_HEADLINE_LINE) || !dr.includes(DR_HEADLINE_LINE)) {
    console.log('');
    console.log(`  O6 and O7 claim to copy what ${ROLE} and ${DR} print, and that is no longer what they print:`);
    console.log(`    ${ROLE}  ${role.includes(ROLE_HEADLINE_LINE) ? 'still prints its NOT MEASURED headline' : 'NOT FOUND'}`);
    console.log(`    ${DR}  ${dr.includes(DR_HEADLINE_LINE) ? 'still opens its headline with VERDICT:' : 'NOT FOUND'}`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A plant that claims a real shape and cannot find it measures nothing.');
    return 2;
  }
  console.log(`  anchored  ${LOAD} prints the same way, declares INVALID MEASUREMENT and still names its outcome \`verdict\`.`);
  console.log(`  anchored  ${ROLE} still prints «EXIT 2 — NOT MEASURED», and ${DR} still opens with «VERDICT:».`);
  console.log('');

  let failures = 0;
  for (const c of CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'p15-outcome-'));
    try {
      const entry = c.build(dir);
      const got = runAndClassify(entry, c.env ?? {});
      const ok = c.expect.test(got.cls);
      if (!ok) failures += 1;
      console.log(`  ${c.id} ${ok ? 'CLASSIFIED AS REQUIRED' : 'FAILED'}   exit ${String(got.code)}`);
      console.log(`     ran      : ${c.what}`);
      console.log(`     expected : /${c.expect.source}/ — ${c.why}`);
      console.log(`     got      : ${got.cls.slice(0, 150)}`);
      if (!ok) {
        const tail = got.out
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .slice(-4);
        for (const l of tail) console.log(`       | ${l.slice(0, 140)}`);
      }
      console.log('');
    } catch (e) {
      failures += 1;
      console.log(`  ${c.id} FAILED    ${c.what}`);
      console.log(`     the case could not be built or run, so this arm is UNPROVED here: ${(e as Error).message}`);
      console.log('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures > 0) {
    console.log(`EXIT 1 — ${failures} of ${CASES.length} arm(s) classified wrongly. The evidence log's outcome column`);
    console.log('  is then a label rather than a reading, and B-21 is not established.');
    return 1;
  }
  console.log(`All ${CASES.length} arms classify as required, from real process output.`);
  console.log('  What this does NOT show: that any instrument is correct. Only that the record can');
  console.log('  tell a crash from a verdict — including a crash that happens after the totals print,');
  console.log('  which is the half a reader assumes is covered.');
  return 0;
}

process.exitCode = main();
