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
function runAndClassify(entry: string, env: Readonly<Record<string, string>> = {}): { readonly code: number | null; readonly cls: string; readonly out: string } {
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

function copySubject(dir: string, append: string): string {
  const entry = join(dir, 'subject.ts');
  const src = readFileSync(join(ROOT, SUBJECT), 'utf8');
  // The copy keeps the original's imports working by living beside it in a
  // directory that re-exports nothing: it is run by absolute path with tsx, and
  // its relative imports are rewritten to absolute ones so the copy behaves
  // exactly like the original up to the appended line.
  const fixed = src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (_m, f: string) => `from '${join(ROOT, 'scripts/phase15', f)}'`).replace(
    /resolve\(__dirname, '\.\.\/\.\.'\)/g,
    `'${ROOT}'`,
  );
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
        const tail = got.out.split('\n').filter((l) => l.trim().length > 0).slice(-4);
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
