/**
 * ROUND 28 — every invocation of the four pack tools that anyone is SHOWN
 * carries `-I`.
 *
 * This file exists because of F-50, which the coordinator's diff review rated
 * P1 and blocking after the challenger had filed it P3.
 *
 * The four tools under `tools/` refuse to run unless `sys.flags.isolated` is
 * set. Their own docstrings printed the un-isolated form of the command. That
 * is not cosmetic. Measured on a byte copy of the pack, with a
 * `sitecustomize.py` on `PYTHONPATH` — the B-9 threat model, which `site`
 * imports at interpreter startup before line 1 of the tool:
 *
 *   $ PYTHONPATH=evil python3 tools/manifest-digests.py --dir b --check
 *   44 files, 44 rows, 0 problems
 *   rc=0                            # over a pack with a DRIFTED document
 *
 *   $ PYTHONPATH=evil python3 -I tools/manifest-digests.py --dir b --check
 *   DRIFTED: P5-CHECKPOINT.md
 *   rc=1
 *
 * A forged green at rc 0, reached by running the command the tool's own file
 * printed. The code cannot close that vector: `sitecustomize` and
 * `usercustomize` run before any line of the script, so the only control is
 * that every invocation anyone copies carries `-I`.
 *
 * AND THE GUARD CANNOT BE READ AS ESTABLISHING ISOLATION. `sys.flags` is an
 * ordinary writable attribute of an ordinary module, so a startup plant can
 * hand the check a `flags` whose `isolated` is 1; measured, an un-isolated run
 * then printed no refusal and exited 0. The absence of the refusal is not
 * evidence. Hence a law over the text, which is a thing a reader can check
 * without trusting any run: if an un-isolated command is written down
 * anywhere in this repository, this test reds.
 *
 * ROUND 35, A NOTE ON THE MATCHER'S GREED. A flag's optional value is matched
 * LAZILY. Greedily, `python3 -I tools/arms/pinned-now-arm.py
 * tools/seal-check-run.py` — an arm invoked on a file, isolated and correct —
 * had its flag segment read as `-I tools/arms/pinned-now-arm.py`, so the
 * strict execution grammar saw a script path and reported a FALSE offence on a
 * correct command. Lazily the segment is `-I`, the tool is the arm, and
 * `-X utf8 <tool>` still backtracks into taking `utf8` as the value.
 *
 * ROUND 34 — TWO THINGS A READER OF THIS FILE MUST KNOW UP FRONT.
 *
 * (1) THE VERDICT IS MEASURED, AND WHAT IT MEASURES IS THE INTERPRETER THIS
 * RUN HAS. Isolation is no longer modelled; it is obtained by running the
 * interpreter a document names with exactly its flags and reading
 * `sys.flags.isolated`. So this law's verdicts are relative to the CPython of
 * the machine it runs on, and the version is PRINTED BY THE RUN rather than
 * written here — see `CPYTHON_HERE` below, which the arms report. Judged on
 * another interpreter the same documents could read differently. That is the
 * price of execution over a model, taken deliberately after four rounds in
 * which a hand-written model of CPython's command line was wrong in some
 * production (F-56, F-58, F-59, F-60).
 *
 * (2) ONE GATE HERE IS CHOSEN, NOT MEASURED. A flag segment containing `-c`,
 * `-m` or `--` is NEVER EXECUTED, and the refusal counts as an offence. Those
 * load code and end option processing, and the documents this law reads
 * include reviewers' reports that this author does not control: a law that
 * reads other people's documents must not become a way to run them. The gate
 * fails closed — it can produce a false RED and can never hide a hole — but it
 * is a judgement, not a measurement, and it is written here so nobody has to
 * infer that from the code.
 *
 * The law reads RAW source on purpose, unlike `db-refusals-name-their-defence`
 * — a command inside a comment or a docstring is exactly what F-50 was, so
 * stripping comments would strip the defect.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..');
const PACK = process.env.P5_PACK_DIR ?? '/mnt/project-files/phase5';
const REVIEWER_REPORTS_FILE = join(__dirname, '..', 'tools', 'reviewer-reports.json');

/**
 * The reviewer-owned pack documents, by EXACT name, read from the ONE file
 * `manifest-digests.py` reads.
 *
 * ROUND 28, THE CHALLENGER'S B-10 (P1, blocking). This was
 * `/^P5-(CHALLENGE|COORD-DIFF-REVIEW)-[0-9a-f]{7}\.md$/` — a name PATTERN,
 * thirty lines below a commit message of mine arguing that an exemption must
 * never be keyed on shape. It failed both ways at once, measured on identical
 * bytes one name apart: an AUTHOR document called `P5-CHALLENGE-1234567.md`
 * was exempt from this law, and three reviewer names `manifest-digests.py`
 * accepts — eight hex (round 23's F-42, exactly), a `-R2` suffix, uppercase —
 * were scanned and blamed on the author, which would have demanded correcting
 * a reviewer's frozen report.
 *
 * A set described twice is two sets, so neither instrument describes it any
 * more: both read the list. It FAILS CLOSED — a missing or malformed file
 * throws here rather than falling back to a pattern, because the fallback is
 * the hole.
 */
const reviewerOwned = (): ReadonlySet<string> => {
  const raw: unknown = JSON.parse(readFileSync(REVIEWER_REPORTS_FILE, 'utf8'));
  const names = (raw as { reviewer_reports?: unknown }).reviewer_reports;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string' && n.length > 0)) {
    throw new Error(`${REVIEWER_REPORTS_FILE} has no non-empty list of reviewer report names`);
  }
  return new Set(names as string[]);
};

/**
 * The name SHAPE of a reviewer report, read from the same shared file.
 *
 * ROUND 30, THE CHALLENGER'S F-53 (P2). This pattern decides WORDING, never an
 * exemption — keying an exemption on shape is B-10 itself, and
 * `reviewerOwned()` above remains the only thing that exempts. The defect it
 * fixes: an unenumerated reviewer-shaped report was reported as "an
 * author-owned pack document", which is false about ownership and routes the
 * reader to the one repair the pack forbids, editing a reviewer's frozen bytes.
 * The other instrument already had the true sentence; this borrows it rather
 * than inventing a second one, and the pattern is shared so the two messages
 * cannot drift apart.
 */
const looksLikeReviewer = (): RegExp => {
  const raw: unknown = JSON.parse(readFileSync(REVIEWER_REPORTS_FILE, 'utf8'));
  const pattern = (raw as { looks_like_reviewer?: unknown }).looks_like_reviewer;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(`${REVIEWER_REPORTS_FILE} has no 'looks_like_reviewer' pattern`);
  }
  return new RegExp(pattern);
};

/**
 * ROUND 31, THE CHALLENGER'S B-12 (P1, blocking), which rejected `bc81b17` and
 * cost it its own `bcf8084` signature.
 *
 * The B-10 remedy moved the hole from SHAPE to TIME. An enumerated list cannot
 * name a report that does not exist yet, and a reviewer's report lands in the
 * pack without any commit: measured on byte copies of the live pack at
 * `b2e723c`, one file apart, 49 files each —
 *
 *   control  (the report as its reviewer delivered it)   -> 6 passed, rc 0
 *   mutation (one plain ```text block added to the SAME
 *             report, which is what an attack transcript
 *             looks like when the reviewer does not know
 *             this law's fence tag)                      -> 1 failed, rc 1
 *
 * — so a reviewer writing a report reds `packages/billing`, and the only
 * clearance is the author amending the list afterwards. A gate over bytes
 * nobody committed is not this package's gate.
 *
 * The coordinator ruled: derive the set from the manifest's reviewer-owned
 * marker row instead, "which exists the moment the file lands". Measured, it
 * does not — the marker is written BY the same list, and the seal refuses
 * while a reviewer-shaped name is unenumerated:
 *
 *   $ python3 -I tools/manifest-digests.py --dir <live pack> --check
 *   UNENUMERATED reviewer report: P5-CHALLENGE-bc81b17.md — add it to
 *     REVIEWER_REPORTS by its exact name; it is not exempt by looking like one
 *   ABSENT from the table: P5-CHALLENGE-bc81b17.md
 *   49 files, 48 rows, 2 problems
 *   rc=1
 *
 * So the remedy is not a second source for the same fact. It is that the
 * OBLIGATION MOVES rather than disappears: a reviewer-shaped document the list
 * does not classify is not scanned as the author's — its content is none of
 * this law's business, and the author must not edit a reviewer's frozen bytes
 * — and instead this law requires the AUTHOR'S OWN SEAL to refuse it by its
 * exact name. The red then means "the seal failed to refuse", which is an
 * author's defect, and never "a reviewer wrote a transcript".
 *
 * Shape still exempts nothing. It routes the document to the instrument that
 * fails closed BY EXACT NAME, and that instrument's refusal is asserted here,
 * read from its MESSAGE. Published residual: enrolling a name in the shared
 * list is the author's claim, in the diff, and no instrument here can read a
 * document's authorship out of its bytes — an author document named in
 * reviewer shape AND enumerated is outside both scans.
 */
const SEAL = join(__dirname, '..', 'tools', 'manifest-digests.py');

/** The seal's own output over a pack, as a subprocess — never imported. */
const sealOutput = (pack: string): string => {
  const r = spawnSync('python3', ['-I', SEAL, '--dir', pack, '--check'], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

/** Does that output refuse THIS name as an unenumerated reviewer report? */
const sealRefusesByName = (out: string, name: string): boolean => out.split('\n').some((l) => l.includes('UNENUMERATED reviewer report') && l.includes(name));

const TOOLS_DIR = join(__dirname, '..', 'tools');
/** This file, by its exact path from the repository root. */
const SELF = 'packages/billing/test/tool-commands-are-isolated.test.ts';

/**
 * Scripts that must not be invoked un-isolated, DERIVED rather than listed:
 * every `*.py` under `tools/`, recursively.
 *
 * ROUND 28, THE COORDINATOR'S B-11 RULING, which is this project's standing
 * class ruling — a subject set is derived from the tree, with exceptions in a
 * named map that goes red when an exception stops being true. The first
 * version named the four tools, so the fifth script, including the arm this
 * round added, was outside its own law on the day it was written.
 */
const EXEMPT_SCRIPTS: ReadonlyMap<string, string> = new Map();

/** Every `*.py` under `tools/`, as a path relative to `tools/`. */
const pythonScripts = (dir: string, prefix = ''): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__pycache__') continue;
    const p = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(p).isDirectory()) out.push(...pythonScripts(p, rel));
    else if (entry.endsWith('.py')) out.push(rel);
  }
  return out;
};

const SCRIPTS = pythonScripts(TOOLS_DIR);

/** The basenames the invocation regex looks for. */
const TOOLS = SCRIPTS.map((s) => s.split('/').pop() ?? s);

/**
 * Any written invocation of one of the four, isolated or not. `python`,
 * `python3`, a VERSIONED interpreter (`python3.13`), and an absolute or
 * relative path to either the interpreter or the tool all count, because what
 * matters is what a reader can copy.
 *
 * ROUND 28, THE CHALLENGER'S F-52 (P2). The first version read `python3?`, so
 * `python3.13 tools/manifest-digests.py` and `/usr/bin/python3.13 …` were
 * GREEN — a net naming shapes and missing variants of the shapes it names,
 * which is B-6's lesson from round 24 applied to this law. This pack's own
 * environment notes pin exact interpreter versions, so writing `python3.13` is
 * a natural thing for one of these documents to do.
 *
 * ROUND 32, THE COORDINATOR'S F-56 (P1, a fail-open, and it predates round
 * 31). The flag run was `(?:-\S+\s+)*`, so a flag that takes a SEPARATE
 * argument broke the match outright and the law went green on the command.
 * Measured by me on the old pattern before changing it:
 *
 *   python3 -X utf8 tools/manifest-digests.py --dir pack --check  -> 0 matches
 *   python3 -W ignore tools/status-block.py --dir d               -> 0 matches
 *   python3 -X dev tools/seal-check-run.py --dir p --tests t      -> 0 matches
 *
 * Those are exactly the commands a reader copies, and `-X utf8` does nothing
 * to stop a `sitecustomize` plant, so this law's own header sentence -- that
 * it reds on any un-isolated invocation written anywhere -- was FALSE as
 * measured. Each flag may now carry one non-flag argument, and backtracking
 * still lets the tool name win when a flag has none. The property is that NO
 * flag form stops the match, and the differential arm below is its deletion
 * test.
 */
const INVOCATION = new RegExp(
  String.raw`((?:[A-Za-z0-9_.\-]*/)*python(?:3(?:\.\d+)*)?)((?:\s+-\S+(?:\s+[^-\s]\S*)??)*)\s+(?:\S*/)?(${TOOLS.join('|').replace(/\./g, '\\.')})`,
  'g',
);

/**
 * The flag run the OLD pattern accepted: flags only, none taking a separate
 * argument. Kept for ONE purpose — F-56's guard deletion, which is this
 * pattern itself. It must MISS a form the current one catches, or the fix is
 * not a fix.
 */
const INVOCATION_BEFORE_F56 = new RegExp(String.raw`python(?:3(?:\.\d+)*)?\s+((?:-\S+\s+)*)(?:\S*/)?(${TOOLS.join('|').replace(/\./g, '\\.')})`, 'g');

/**
 * The interpreter flags of one matched invocation, as FLAG and VALUE rather
 * than as words.
 *
 * ROUND 33, THE CHALLENGER'S F-58 (P2, a fail-open, and round 32 introduced
 * it). F-56 taught the MATCHER that a flag can take a separate value; this
 * function still re-split the captured text on whitespace, so a VALUE spelled
 * `-I` was read as the isolation flag:
 *
 *   python3 -X -I tools/manifest-digests.py   -> matched, READ AS ISOLATED
 *   python3 -W -I tools/status-block.py       -> matched, READ AS ISOLATED
 *
 * Both are working commands that run UN-isolated, measured here:
 *
 *   python3 -X -I -c "import sys; print(sys.flags.isolated)"  -> 0, rc 0
 *   python3 -W -I -c "import sys; print(sys.flags.isolated)"  -> 0, rc 0
 *   python3 -I    -c "import sys; print(sys.flags.isolated)"  -> 1, rc 0
 *
 * A false green on a working command is F-50's own shape, so the verdict is
 * computed from the same structure the matcher uses. It fails CLOSED: only
 * flags known to take no argument are read as flags on their own; anything
 * else consumes the next token as its value, so an unfamiliar flag swallows a
 * following `-I` and the command reads as NOT isolated.
 */
const NO_ARG_FLAGS: ReadonlySet<string> = new Set([
  '-B',
  '-b',
  '-d',
  '-E',
  '-h',
  '-i',
  '-I',
  '-O',
  '-P',
  '-q',
  // F-60, round 34: `-R` is argument-free in CPython and was missing. It now
  // matters only for TOKENISATION — it decides whether the next token is this
  // flag's value — because the isolation VERDICT no longer comes from a list.
  '-R',
  '-?',
  '-s',
  '-S',
  '-u',
  '-v',
  '-V',
  '-x',
  '--help',
  '--version',
]);

const interpreterFlags = (captured: string): { flag: string; value?: string }[] => {
  const tokens = captured
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const out: { flag: string; value?: string }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (!t.startsWith('-')) continue;
    const short = /^-[A-Za-z]+$/.test(t);
    const takesNoArgument = NO_ARG_FLAGS.has(t) || (short && [...t.slice(1)].every((c) => NO_ARG_FLAGS.has(`-${c}`))) || t.includes('=');
    if (takesNoArgument) {
      out.push({ flag: t });
      continue;
    }
    out.push({ flag: t, value: tokens[i + 1] });
    i += 1;
  }
  return out;
};

/**
 * Is the invocation ISOLATED? ASKED OF CPYTHON, never of a model of it.
 *
 * ROUND 34, THE COORDINATOR'S CLASS RULING after the challenger's F-59 (P1).
 * Four rounds running, a hand-written model of CPython's command line was
 * wrong in some production: F-56 (a flag with a separate value broke the
 * match), F-58 (a VALUE spelled `-I` read as the flag), F-59 (`-XI`, a cluster
 * CARRYING a value, read as the flag — measured un-isolated, 0 at rc 0, and
 * cleared by this law end to end at 14 passed rc 0), F-60 (`-R` missing, a
 * false red). The ruling is Phase 7's: derive the verdict from EXECUTION.
 *
 * The tokeniser's job is now only to FIND an invocation and split its flag
 * segment. The verdict runs the interpreter the document names, with exactly
 * those flags, then `-c "import sys; print(sys.flags.isolated)"`, in an
 * environment holding nothing but PATH — needed to resolve a bare `python3` —
 * with a timeout, and caches the answer per distinct interpreter-and-flags
 * pair. ISOLATED means it printed `1` and exited 0. **Everything else is an
 * OFFENCE**: rc not 0, a timeout, a missing interpreter, any other output. So
 * it fails closed, and a wrong model can now only produce a false RED.
 *
 * TWO FORMS ARE REFUSED WITHOUT BEING RUN, and refusing counts as an offence:
 * `-c` and `-m` load code and end option processing, `--` ends it, so running
 * a segment carrying them would execute whatever a document names. A law that
 * reads other people's documents must not become a way to run them. That is a
 * safety gate, not a verdict: it can only produce a false red.
 */
const PROBE = 'import sys; print(sys.flags.isolated)';

/**
 * The interpreter this run measures, printed BY the run. Never a literal: a
 * version written by hand is the kind of claim this round removed.
 */
/**
 * THE ONE INTERPRETER THIS LAW RUNS, by absolute path, resolved once.
 *
 * ROUND 35, THE CHALLENGER'S F-61 (P0). Round 34's verdict spawned the
 * interpreter SPELLING the document wrote, and a relative spelling resolves
 * against the suite's working directory. Measured end to end: with an
 * executable `shimdir/python3` that writes a marker, prints `1` and exits 0,
 * one line in a repository file reading
 * `shimdir/python3 tools/manifest-digests.py --dir d --check` left the suite
 * at 17 passed rc 0 — SILENT — and the shim had run. A document that names the
 * program chooses the answer.
 *
 * So a document's interpreter spelling is DATA TO CLASSIFY, never a program to
 * run. This is the program, and it is `sys.executable` of the harness's own
 * `python3`, asked for once with `-I`.
 */
const HARNESS_PYTHON = ((): string => {
  const r = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const path = r.status === 0 ? (r.stdout ?? '').trim() : '';
  return path.startsWith('/') ? path : '';
})();

/** The version this run measures, printed BY the run — never a literal. */
const CPYTHON_HERE = ((): string => {
  if (HARNESS_PYTHON === '') return 'NO CPYTHON HERE';
  const r = spawnSync(HARNESS_PYTHON, ['-I', '-c', 'import sys; print(sys.version.split()[0])'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: '/usr/bin:/bin' },
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : 'NO CPYTHON HERE';
})();

/**
 * Is the spelling a document wrote one this law can CLASSIFY, without running
 * it, as denoting THIS CPython?
 *
 * F-61, instance B. A bare `python`, `python3` or `python3.<this minor>` is
 * known. An absolute path is known only when `realpath` — which reads the
 * filesystem and executes nothing — lands on the same binary as the harness's
 * own interpreter. **Everything else is REFUSED BY NAME**: a relative path
 * (which names whatever sits beside whoever runs the suite, and was instance
 * B), an absolute path to some other binary, a version this machine does not
 * have, any other spelling. Refuse what you cannot classify.
 */
const KNOWN_SPELLINGS = ((): ReadonlySet<string> => {
  const minor = /^(\d+\.\d+)\./.exec(CPYTHON_HERE)?.[1];
  return new Set(['python', 'python3', ...(minor === undefined ? [] : [`python${minor}`])]);
})();

const sameBinaryAsHarness = (absolute: string): boolean => {
  if (HARNESS_PYTHON === '') return false;
  try {
    return realpathSync(absolute) === realpathSync(HARNESS_PYTHON);
  } catch {
    return false;
  }
};

const classifiableInterpreter = (spelling: string): boolean => {
  if (spelling.startsWith('/')) return sameBinaryAsHarness(spelling);
  if (spelling.includes('/')) return false;
  return KNOWN_SPELLINGS.has(spelling);
};

/**
 * The argv this law is willing to hand to CPython, or a REFUSAL NAME.
 *
 * F-61, instance A, and the inversion both reviewers asked for. Round 34
 * refused `-c`, `-m` and `--` by EXACT token and handed everything else to the
 * interpreter; CPython accepts an ATTACHED argument, so `-cprint(7)` was not
 * `-c` and ran. Measured: `python3 -cprint(7)` prints 7 at rc 0, and one line
 * in a repository file made `npm test` write a marker file —
 * `executed-by-the-gate` — while the suite reported a failure for the probe's
 * OUTPUT, so the red was not a defence: the code had already run.
 *
 * The rule is now an ALLOW-LIST, the only direction that covers a spelling
 * nobody has thought of:
 *
 *   - a cluster `-[A-Za-z]+` whose every letter is argument-free and is
 *     neither `c` nor `m` (a cluster containing either turns the rest into
 *     attached code: `-Ic` is `-I -c ''`);
 *   - `-X` or `-W` with one value of plain characters;
 *   - nothing else, ever.
 *
 * Refusal counts as an OFFENCE, so this can only produce a false RED.
 */
const EXECUTABLE_LETTERS = new Set('BbdEhiIOPqRsSuVvx?'.split(''));
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-X', '-W']);
const PLAIN_VALUE = /^[A-Za-z0-9_.:=,+-]+$/;

const REFUSED_TOKEN = 'REFUSED-UNEXECUTABLE-TOKEN';
const REFUSED_INTERPRETER = 'REFUSED-UNCLASSIFIABLE-INTERPRETER';
const REFUSED_NO_PYTHON = 'REFUSED-NO-CPYTHON-HERE';

const executableArgv = (flags: string): { argv: string[] } | { refusal: string; token: string } => {
  // Tokenised HERE, strictly, rather than through `interpreterFlags`: that
  // function exists to describe what the matcher found, and it SKIPS a bare
  // token. A skipped token is a token nobody classified, which is how a script
  // path reached the interpreter. This loop classifies every token or refuses.
  const tokens = flags
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const argv: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (VALUE_FLAGS.has(t)) {
      const value = tokens[i + 1];
      if (value === undefined || !PLAIN_VALUE.test(value)) return { refusal: REFUSED_TOKEN, token: `${t} ${value ?? '(nothing)'}` };
      argv.push(t, value);
      i += 1;
      continue;
    }
    if (!/^-[A-Za-z]+$/.test(t) || ![...t.slice(1)].every((c) => EXECUTABLE_LETTERS.has(c))) {
      return { refusal: REFUSED_TOKEN, token: t };
    }
    argv.push(t);
  }
  return { argv };
};

const verdicts = new Map<string, { isolated: boolean; refusal?: string }>();

/**
 * ISOLATED, or a named refusal. Nothing that reaches `spawnSync` comes from
 * the document: the program is `HARNESS_PYTHON` by absolute path, and the
 * flags are the allow-listed tokens this law has just enumerated.
 */
const verdictFor = (interpreter: string, flags: string): { isolated: boolean; refusal?: string } => {
  const key = `${interpreter}\u0000${flags}`;
  const cached = verdicts.get(key);
  if (cached !== undefined) return cached;
  let out: { isolated: boolean; refusal?: string };
  const parsed = executableArgv(flags);
  if ('refusal' in parsed) {
    out = { isolated: false, refusal: `${parsed.refusal} ${parsed.token}` };
  } else if (HARNESS_PYTHON === '') {
    out = { isolated: false, refusal: REFUSED_NO_PYTHON };
  } else if (!classifiableInterpreter(interpreter)) {
    out = { isolated: false, refusal: `${REFUSED_INTERPRETER} ${interpreter}` };
  } else {
    const r = spawnSync(HARNESS_PYTHON, [...parsed.argv, '-c', PROBE], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    out = { isolated: r.status === 0 && (r.stdout ?? '').trim() === '1' };
  }
  verdicts.set(key, out);
  return out;
};

const isolatedByExecution = (interpreter: string, flags: string): boolean => verdictFor(interpreter, flags).isolated;

/** The spelling-only cluster test, kept for F-59's deletion arm. */
const isolatedByModel = (flags: string): boolean =>
  interpreterFlags(flags).some(({ flag }) => flag === '-I' || (/^-[A-Za-z]+$/.test(flag) && flag.includes('I')));

/** The whitespace split F-58 is about, kept only for its deletion arm. */
const isolatedBeforeF58 = (flags: string): boolean => flags.split(/\s+/).some((f) => f === '-I' || (/^-[A-Za-z]+$/.test(f) && f.includes('I')));

/** Every file of the repository, excluding what is not ours to read. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist' || entry === '.next') {
      continue;
    }
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/**
 * The text as LOGICAL lines, joining shell continuations, each keeping the
 * 1-based number of the line it started on.
 *
 * F-52's second half: a command split with a trailing `\` was invisible to a
 * scan reading one line at a time, and splitting a long command is exactly
 * what these documents do.
 */
const logicalLines = (text: string): { n: number; line: string }[] => {
  const out: { n: number; line: string }[] = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const start = i;
    let line = raw[i] ?? '';
    while (/\\\s*$/.test(line) && i + 1 < raw.length) {
      i += 1;
      line = `${line.replace(/\\\s*$/, ' ')}${(raw[i] ?? '').trim()}`;
    }
    out.push({ n: start + 1, line });
  }
  return out;
};

/** Offending lines in one text, as `path:line: text`. */
const offencesIn = (label: string, text: string): string[] => {
  const found: string[] = [];
  for (const { n, line } of logicalLines(text)) {
    for (const m of line.matchAll(INVOCATION)) {
      const v = verdictFor(m[1] ?? 'python3', m[2] ?? '');
      if (!v.isolated) found.push(`${label}:${n}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
    }
  }
  return found;
};

/**
 * How many invocations the scan SEES in one text, isolated or not.
 *
 * F-56's lesson in one function: every fixture below asserts a match count as
 * well as an offence count, because a fixture that stops matching reads
 * exactly like a fixture that passes.
 */
const matchCount = (text: string, re: RegExp = INVOCATION): number => {
  let n = 0;
  for (const { line } of logicalLines(text)) n += [...line.matchAll(re)].length;
  return n;
};

/**
 * The same scan over a Markdown document, with one exemption: a fenced block
 * whose opening fence declares `f-50-quote`.
 *
 * Found immediately after this law first ran against the published pack. These
 * documents have to QUOTE the defect — §3.1 of the checkpoint and §21.2 of the
 * response show the forged green beside the isolated run, which is the whole
 * evidence for F-50 — and a law that forbids writing the defect down forbids
 * reporting it. The exemption is therefore a sentence someone writes on the
 * fence, visible in the diff, never inferred from what the line looks like: a
 * rule that exempted `PYTHONPATH=…` lines by shape would exempt exactly the
 * command an attacker wants a reader to copy. The marker does not appear in
 * the copied text, and `quoted` below reds if the exemption ever stops being
 * used, so it cannot outlive its reason.
 */
const offencesOutsideQuotedBlocks = (label: string, text: string): [string[], number] => {
  const found: string[] = [];
  let exemptBlocks = 0;
  let inFence = false;
  let exempt = false;
  for (const { n, line } of logicalLines(text)) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        inFence = false;
        exempt = false;
      } else {
        inFence = true;
        exempt = /f-50-quote/.test(line);
        if (exempt) exemptBlocks += 1;
      }
      continue;
    }
    if (inFence && exempt) continue;
    for (const m of line.matchAll(INVOCATION)) {
      const v = verdictFor(m[1] ?? 'python3', m[2] ?? '');
      if (!v.isolated) found.push(`${label}:${n}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
    }
  }
  return [found, exemptBlocks];
};

/**
 * Files that may contain a NUL byte and still not be read by this law, by
 * EXACT repository-relative path (pack documents by bare name).
 *
 * ROUND 32, THE COORDINATOR'S F-57 (P2, a fail-open). `readable` used to
 * return null for any file containing a NUL byte, with the sentence "a binary
 * file is not a document and its bytes are not commands" — so ONE NUL byte
 * anywhere in a file exempted it from the law, in the pack half and in the
 * repository half alike. Measured before the fix: the repository walk and the
 * pack hold NO file with a NUL byte, so refusing instead of skipping costs
 * nothing today and the exemption was paying for nothing.
 *
 * A real binary therefore has to be NAMED here, as a claim in the diff, the
 * way B-11's ruling requires — and each entry reds when the file it names
 * stops existing, so the map cannot outlive its reason.
 */
const EXEMPT_BINARIES: ReadonlyMap<string, string> = new Map();

/**
 * One file's text, or `BINARY` when it holds a NUL byte, or null when it
 * cannot be read at all. The caller must REFUSE a `BINARY` by name rather
 * than skip it.
 */
const BINARY = Symbol('binary');

const readable = (p: string): string | typeof BINARY | null => {
  try {
    const t = readFileSync(p, 'utf8');
    return t.includes('\u0000') ? BINARY : t;
  } catch {
    return null;
  }
};

describe('every written invocation of the pack tools is isolated', () => {
  it('finds no un-isolated invocation anywhere in the repository', () => {
    const offences: string[] = [];
    const binaries: string[] = [];
    let scanned = 0;
    let seen = 0;
    for (const p of walk(REPO)) {
      const text = readable(p);
      if (text === null) continue;
      const label = relative(REPO, p);
      // F-57. A NUL byte is REFUSED by name, never skipped: one NUL used to
      // exempt a whole file from this law.
      if (text === BINARY) {
        if (!EXEMPT_BINARIES.has(label)) binaries.push(label);
        continue;
      }
      scanned += 1;
      // Not this file: it quotes the defect on purpose, four lines above.
      //
      // By its EXACT repository path. Found while building B-10's before arm:
      // an `endsWith` skip is the same shape-keyed exemption B-10 is about,
      // and it skipped a copy of this file named
      // `__b10_before.test.ts`... wholesale. One hole of a class is enough.
      if (label === SELF) {
        continue;
      }
      // Through `logicalLines`, like the other two scans. ROUND 30: F-52's
      // continuation fix went into the pack scans and NOT into this one, which
      // reads the repository -- the half of the law that runs in CI. The
      // challenger measured F-52 on pack documents, so the gap survived its
      // round; a fix applied to two of three call sites is not applied.
      for (const { line } of logicalLines(text)) {
        for (const m of line.matchAll(INVOCATION)) {
          seen += 1;
          const v = verdictFor(m[1] ?? 'python3', m[2] ?? '');
          if (!v.isolated) offences.push(`${label}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
        }
      }
    }
    expect(
      binaries,
      'a file in this repository holds a NUL byte, so this law cannot read it: name it in EXEMPT_BINARIES with the reason, which is a claim in the diff — do not widen the skip',
    ).toStrictEqual([]);
    for (const [name] of EXEMPT_BINARIES) {
      expect(existsSync(join(REPO, name)), `${name} is exempted as a binary but is no longer in the repository`).toBe(true);
    }
    expect(scanned, 'the walk read no files, so this law measured nothing').toBeGreaterThan(50);
    expect(seen, 'no invocation of the four tools was found anywhere, so this law is vacuous — the tools or their names moved').toBeGreaterThan(0);
    expect(
      offences,
      'an un-isolated invocation is written down: a reader who copies it runs the tool with PYTHONPATH and the user site directory on sys.path, which is F-50',
    ).toStrictEqual([]);
  });

  it('proves the scan can see an un-isolated invocation at all', () => {
    // The law above is a prohibition, so it needs a non-vacuity witness: a
    // prohibition over a scan that matches nothing passes forever.
    expect(offencesIn('fixture', '    python3 tools/manifest-digests.py --dir <dir> --check')).toStrictEqual([
      'fixture:1: python3 tools/manifest-digests.py --dir <dir> --check',
    ]);
    expect(offencesIn('fixture', '$ python3 ./tools/seal-check-run.py --dir p --tests t')).toHaveLength(1);
    expect(offencesIn('fixture', 'python3 -E -s tools/status-block.py --dir d')).toHaveLength(1);
    // F-52, the two forms the first version missed, and the line number of a
    // continuation must be the line the command STARTS on.
    expect(offencesIn('fixture', 'python3.13 tools/manifest-digests.py --check')).toHaveLength(1);
    expect(offencesIn('fixture', '/usr/bin/python3.13 tools/manifest-digests.py --check')).toHaveLength(1);
    expect(offencesIn('fixture', 'python3 \\\n    tools/manifest-digests.py --check')).toStrictEqual(['fixture:1: python3  tools/manifest-digests.py --check']);
    expect(offencesIn('fixture', 'python3.13 -I tools/manifest-digests.py --check')).toStrictEqual([]);
    expect(offencesIn('fixture', 'python3 -I \\\n    tools/manifest-digests.py --check')).toStrictEqual([]);
    // And it must NOT red on the forms that are correct, or the law would be
    // unsatisfiable and someone would delete it.
    expect(offencesIn('fixture', '    python3 -I tools/context-sites.py --dir d --tests t')).toStrictEqual([]);
    expect(offencesIn('fixture', 'python3 -I -X faulthandler tools/manifest-digests.py')).toStrictEqual([]);
    expect(offencesIn('fixture', '[sys.executable, "-I", str(tools / "status-block.py")]')).toStrictEqual([]);
  });

  it('derives its subject set from the tree, and every script in it carries the guard', () => {
    // B-11. The set is what is under `tools/`, not what someone remembered to
    // list, and each exception is a sentence that reds when it stops being
    // true.
    expect(SCRIPTS.length, 'no Python script was derived from tools/, so every law here is vacuous').toBeGreaterThan(4);
    for (const [name, reason] of EXEMPT_SCRIPTS) {
      expect(SCRIPTS, `${name} is exempted (${reason}) but is no longer under tools/`).toContain(name);
    }
    const unguarded = SCRIPTS.filter((rel) => {
      if (EXEMPT_SCRIPTS.has(rel)) return false;
      const src = readFileSync(join(TOOLS_DIR, rel), 'utf8');
      return !/if not sys\.flags\.isolated:/.test(src);
    });
    expect(unguarded, 'a script under tools/ does not refuse an un-isolated run, and is not a named exception').toStrictEqual([]);
  });

  it('shares ONE enumerated list with manifest-digests.py, and neither describes it', () => {
    // B-10's remedy, asserted rather than asserted-in-prose: a set described
    // twice is two sets, so the arm is that NEITHER instrument carries its own
    // copy. If someone pastes the names back into either file, this reds.
    const tool = readFileSync(join(__dirname, '..', 'tools', 'manifest-digests.py'), 'utf8');
    expect(tool, 'manifest-digests.py no longer reads the shared list').toContain('reviewer-reports.json');
    const literalNames = tool.match(/"P5-(?:CHALLENGE|COORD-DIFF-REVIEW)-[^"]*"/g) ?? [];
    expect(literalNames, 'manifest-digests.py carries its own copy of the names again').toStrictEqual([]);
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    // This file may NAME the shapes while explaining B-10; it may not key an
    // exemption on them. The test for that is that the only place a name
    // reaches `exempt` is the shared file.
    expect(here, 'this law reads the shared list').toContain('reviewer-reports.json');
    expect(reviewerOwned().size, 'the shared list is empty, so every reviewer report would be scanned').toBeGreaterThan(5);

    // The four names from the challenger's B-10 table, each resolved the ONLY
    // way left: membership of the shared list. A name absent from it is the
    // author's, whatever it looks like -- which is the fail-open half -- and a
    // name present in it is exempt in both instruments, which is the
    // fail-closed half that was misattributing reviewer reports to me.
    const list = reviewerOwned();
    expect(list.has('P5-CHALLENGE-1234567.md'), 'a reviewer-SHAPED name nobody enumerated is exempt again').toBe(false);
    expect(list.has('P5-CHALLENGE-12345678.md'), 'F-42 width, exempt by shape again').toBe(false);
    expect(list.has('P5-CHALLENGE-9BD33BD.md'), 'uppercase shape exempt again').toBe(false);
    expect(list.has('P5-CHALLENGE-9bd33bd.md'), 'a real reviewer report fell out of the shared list').toBe(true);

    // F-53's half of the sharing: the SHAPE lives in that one file too, so the
    // two instruments cannot say different things about the same file. It
    // decides wording only; `list` above is still the only exemption.
    expect(tool, 'manifest-digests.py no longer reads the shared shape').toContain('looks_like_reviewer');
    const shaped = looksLikeReviewer();
    expect(shaped.test('P5-CHALLENGE-12345678.md'), 'the shared shape no longer recognises a reviewer name').toBe(true);
    expect(shaped.test('P5-NOTE-FOR-READERS.md'), 'the shared shape now matches an author document').toBe(false);
    const literalShape = tool.match(/\^P5-\(CHALLENGE\|COORD-DIFF-REVIEW\)/g) ?? [];
    expect(literalShape, 'manifest-digests.py carries its own copy of the shape again').toStrictEqual([]);
  });

  it('exempts a DECLARED quotation block, and nothing else', () => {
    const quoted = ['```text f-50-quote', '$ python3 tools/manifest-digests.py --check', '```'].join('\n');
    const undeclared = ['```text', '$ python3 tools/manifest-digests.py --check', '```'].join('\n');
    const after = ['```text f-50-quote', '$ python3 tools/manifest-digests.py --check', '```', '', 'Run it with `python3 tools/status-block.py --dir d`.'].join(
      '\n',
    );

    expect(offencesOutsideQuotedBlocks('doc', quoted)).toStrictEqual([[], 1]);
    // Without the declaration the very same line is an offence, which is what
    // makes the exemption a sentence someone wrote rather than a shape.
    expect(offencesOutsideQuotedBlocks('doc', undeclared)[0]).toHaveLength(1);
    // And the exemption ends with its block: prose after the fence is covered.
    expect(offencesOutsideQuotedBlocks('doc', after)[0]).toHaveLength(1);
  });

  it('holds over the pack documents this author owns, when the pack is present', () => {
    // The pack lives outside the repository, so this arm is measured HERE and
    // not in CI; that limit is written into the handoff rather than left for a
    // reader to discover. Reviewer-owned reports are exempt BY EXACT NAME:
    // they are frozen bytes quoting the old text, and correcting a reviewer's
    // report would be worse than the defect.
    if (!existsSync(PACK)) {
      expect(existsSync(PACK), `no pack at ${PACK}: this arm is UNMEASURED here, by absence`).toBe(false);
      return;
    }
    const exempt = reviewerOwned();
    const shaped = looksLikeReviewer();
    const offences: string[] = [];
    const unclassified: string[] = [];
    const packBinaries: string[] = [];
    let quoted = 0;
    let mine = 0;
    for (const name of readdirSync(PACK)) {
      if (exempt.has(name)) continue;
      // B-12. A reviewer-shaped name the list does not classify is NOT read
      // here. F-53 had made the sentence true -- "unenumerated", not
      // "author-owned" -- while leaving the red itself on the author's
      // package, over bytes the author may not edit. Shape exempts nothing: it
      // routes this name to the seal, whose refusal is asserted below.
      if (shaped.test(name)) {
        unclassified.push(name);
        continue;
      }
      const text = readable(join(PACK, name));
      if (text === null) continue;
      // F-57, the same refusal on this side.
      if (text === BINARY) {
        if (!EXEMPT_BINARIES.has(name)) packBinaries.push(name);
        continue;
      }
      mine += 1;
      const [found, exempted] = offencesOutsideQuotedBlocks(name, text);
      offences.push(...found);
      quoted += exempted;
    }
    // The obligation MOVES, it does not disappear: for every document this law
    // declines to read, the author's own seal must refuse it by exact name.
    if (unclassified.length > 0) {
      const out = sealOutput(PACK);
      const unrefused = unclassified.filter((n) => !sealRefusesByName(out, n));
      expect(
        unrefused,
        'a reviewer-shaped pack document is in neither the shared list nor the seal refusals, so NOTHING classifies it: enrol it in tools/reviewer-reports.json by its EXACT name, and do NOT edit a reviewer frozen report',
      ).toStrictEqual([]);
    }
    expect(packBinaries, 'a pack document holds a NUL byte, so this law cannot read it: name it in EXEMPT_BINARIES with the reason').toStrictEqual([]);
    expect(mine, 'no author-owned document was read from the pack').toBeGreaterThan(0);
    expect(
      quoted,
      'no declared `f-50-quote` block was found: the documents stopped quoting the defect, so that exemption is dead and should be deleted rather than left standing',
    ).toBeGreaterThan(0);
    expect(offences, 'an author-owned pack document prints an un-isolated command, which is the half of F-50 that routes the reader').toStrictEqual([]);
  });
  it('reads the seal refusal by NAME, and a silent seal classifies nothing', () => {
    // B-12's reader, armed sequentially rather than through a race: both of
    // the tool's branches exit 1, so the exit code cannot be the arm -- the
    // MESSAGE is, which is round 30's F-51 lesson applied to a new reader.
    const real =
      'UNENUMERATED reviewer report: P5-CHALLENGE-bc81b17.md \u2014 add it to REVIEWER_REPORTS by its exact name; it is not exempt by looking like one\nABSENT from the table: P5-CHALLENGE-bc81b17.md\n49 files, 48 rows, 2 problems';
    expect(sealRefusesByName(real, 'P5-CHALLENGE-bc81b17.md')).toBe(true);
    // By NAME: the phrase alone must not clear a different document, or one
    // refusal would classify every unenumerated report at once.
    expect(sealRefusesByName(real, 'P5-CHALLENGE-deadbee.md')).toBe(false);
    // A seal that says nothing has classified nothing. This is the fail-open
    // the arm exists for: if it returned true here, a pack document in neither
    // the list nor the refusals would pass unread by anything.
    expect(sealRefusesByName('', 'P5-CHALLENGE-bc81b17.md')).toBe(false);
    expect(sealRefusesByName('48 files, 48 rows, 0 problems', 'P5-CHALLENGE-bc81b17.md')).toBe(false);
    // And the name alone, without the refusal, is not a refusal.
    expect(sealRefusesByName('ABSENT from the table: P5-CHALLENGE-bc81b17.md', 'P5-CHALLENGE-bc81b17.md')).toBe(false);
    // The instrument this law delegates to must exist, as a file, where the
    // delegation says it is -- a moved tool would make the delegation vacuous.
    expect(existsSync(SEAL), `the seal this law delegates to is not at ${SEAL}`).toBe(true);
  });
  it('sees an invocation whatever flag form it carries — F-56', () => {
    // Each of these was 0 matches under the old pattern, which is the
    // fail-open: a flag taking a separate argument broke the match, so the
    // command went unread and the law printed nothing.
    const forms = [
      'python3 -X utf8 tools/manifest-digests.py --dir pack --check',
      'python3 -W ignore tools/status-block.py --dir d',
      'python3 -X dev tools/seal-check-run.py --dir p --tests t',
      'python3 -X utf8 -W ignore tools/context-sites.py --dir d --tests t',
      '/usr/bin/python3.13 -X dev tools/manifest-digests.py --check',
    ];
    for (const form of forms) {
      expect(matchCount(form), `the scan does not SEE this form at all: ${form}`).toBe(1);
      expect(offencesIn('fixture', form), `seen but not reported: ${form}`).toHaveLength(1);
    }
    // And the isolated versions of the same forms must stay green, or the law
    // is unsatisfiable and someone deletes it.
    for (const form of ['python3 -I -X utf8 tools/manifest-digests.py --check', 'python3 -X utf8 -I tools/status-block.py --dir d']) {
      expect(matchCount(form), `the scan does not see ${form}`).toBe(1);
      expect(offencesIn('fixture', form), `a correctly isolated command is reported: ${form}`).toStrictEqual([]);
    }
  });

  it('F-56 guard deletion: the old flag run MISSES what the new one catches', () => {
    // ONE deletion, one property. Restoring the old pattern must lose at least
    // one form the current pattern reports -- otherwise the change above is
    // decoration and this arm says so.
    const form = 'python3 -X utf8 tools/manifest-digests.py --dir pack --check';
    expect(matchCount(form, INVOCATION_BEFORE_F56), 'the OLD pattern now matches this form, so this arm proves nothing').toBe(0);
    expect(matchCount(form, INVOCATION), 'the CURRENT pattern misses the form F-56 is about').toBe(1);
  });

  it('F-57 guard deletion: a NUL byte is reported, not skipped', () => {
    // The fail-open was `readable` returning null for a NUL-containing file,
    // which both scans treat as "continue". So the deletion test is that
    // `readable` does NOT return null here.
    const dir = mkdtempSync(join(tmpdir(), 'f57-'));
    const file = join(dir, 'doc.md');
    writeFileSync(file, `\u0000python3 tools/manifest-digests.py --check\n`);
    const text = readable(file);
    expect(text, 'a NUL-containing file is skipped again, which exempts it from this law').not.toBe(null);
    expect(text).toBe(BINARY);
    // A readable file still comes back as text, or the refusal would swallow
    // every document.
    const plain = join(dir, 'plain.md');
    writeFileSync(plain, 'python3 -I tools/manifest-digests.py --check\n');
    expect(typeof readable(plain)).toBe('string');
    rmSync(dir, { recursive: true, force: true });
    // Nothing is exempt today: measured, neither the repository walk nor the
    // pack holds a NUL byte, so an entry here would be paying for nothing.
    expect(EXEMPT_BINARIES.size, 'a binary exemption exists: it must be named with a reason and justified in the round that adds it').toBe(0);
  });
  it('F-54: one pattern string, two engines, one verdict', () => {
    // The shape is shared as TEXT and compiled by two engines, so "shared"
    // was true of the string and false of the predicate. Measured on the live
    // pattern: `P5-CHALLENGE-9bd33bd.md` + a newline was True in Python's
    // re.match and false in JS RegExp.test, because Python's `$` also matches
    // before a final newline -- so one name was routed to the seal by one
    // instrument and read as the author's by the other, which is exactly the
    // drift the sharing exists to prevent.
    const shaped = looksLikeReviewer();
    const cases = ['P5-CHALLENGE-9bd33bd.md', 'P5-CHALLENGE-9bd33bd.md\n', 'P5-NOTE-FOR-READERS.md', 'P5-CHALLENGE-9bd33bd.md.bak', 'P5-CHALLENGE-12345678.md'];
    const here = cases.map((n) => shaped.test(n));
    // The OTHER engine's verdicts, read from the seal's own compiled pattern
    // as a subprocess -- never imported, and never re-implemented here.
    const probe = [
      'import io,json,re,sys',
      'raw=json.load(io.open(sys.argv[1],encoding="utf-8"))',
      'pat=re.compile(raw["looks_like_reviewer"])',
      'print("".join("1" if pat.fullmatch(n) else "0" for n in sys.argv[2:]))',
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', probe, REVIEWER_REPORTS_FILE, ...cases], { encoding: 'utf8' });
    expect(r.status, `the cross-engine probe did not run: ${r.stderr ?? ''}`).toBe(0);
    const there = (r.stdout ?? '').trim();
    expect(there, 'the probe printed no verdicts').toHaveLength(cases.length);
    expect(
      here.map((b) => (b ? '1' : '0')).join(''),
      `the two engines disagree about ${cases.join(', ')}: one of them routes a name to the seal while the other reads it as the author's`,
    ).toBe(there);

    // The probe is only the other engine if it does what the SEAL does, so
    // the seal's own call is asserted. Reverting it to `match` must not leave
    // this arm green.
    const seal = readFileSync(SEAL, 'utf8');
    expect(seal, 'the seal no longer reads the shared shape with fullmatch semantics, so the two engines can drift again').toContain(
      'LOOKS_LIKE_REVIEWER.fullmatch(',
    );
    expect(/LOOKS_LIKE_REVIEWER\.match\(/.test(seal), 'the seal reads the shared shape with `match` again, which accepts a trailing newline JS rejects').toBe(
      false,
    );

    // F-54's guard deletion: with `match` the SAME probe disagrees, which is
    // what makes the line above load-bearing rather than decorative.
    const before = probe.replace('pat.fullmatch(n)', 'pat.match(n)');
    const r2 = spawnSync('python3', ['-I', '-c', before, REVIEWER_REPORTS_FILE, ...cases], { encoding: 'utf8' });
    expect(r2.status).toBe(0);
    expect((r2.stdout ?? '').trim(), 'the old Python call now agrees with JS, so F-54 does not reproduce and this arm proves nothing').not.toBe(there);
  });
  it('F-58: a flag VALUE spelled -I is not the isolation flag', () => {
    // Measured in this container: `python3 -X -I -c "…sys.flags.isolated"`
    // prints 0 and exits 0, so these are working, UN-isolated commands.
    for (const form of [
      'python3 -X -I tools/manifest-digests.py --check',
      'python3 -W -I tools/status-block.py --dir d',
      'python3 -X -I -W ignore tools/seal-check-run.py --dir p --tests t',
    ]) {
      expect(matchCount(form), `the scan does not see ${form}`).toBe(1);
      expect(offencesIn('fixture', form), `read as isolated although -I is a flag's VALUE: ${form}`).toHaveLength(1);
    }
    // The real thing still passes, including when a value-taking flag follows.
    for (const form of [
      'python3 -I -X utf8 tools/manifest-digests.py --check',
      'python3 -X utf8 -I tools/status-block.py --dir d',
      'python3 -I tools/context-sites.py --dir d --tests t',
    ]) {
      expect(offencesIn('fixture', form), `a genuinely isolated command is reported: ${form}`).toStrictEqual([]);
    }
    // Fails closed on a flag nobody here has enumerated: it consumes the next
    // token, so an unknown flag cannot launder a following -I.
    expect(offencesIn('fixture', 'python3 --some-new-option -I tools/manifest-digests.py --check')).toHaveLength(1);
  });

  it('F-58 guard deletion: the whitespace split reads the value as the flag', () => {
    // ONE deletion, one property. The old function must say ISOLATED where the
    // new one says otherwise, or the change above is decoration.
    expect(isolatedBeforeF58(' -X -I'), 'the old split no longer reads the value as a flag, so this arm proves nothing').toBe(true);
    expect(isolatedByExecution('python3', ' -X -I'), 'the new verdict still reads a value as the isolation flag').toBe(false);
    // And it must agree with the old one everywhere the old one was right.
    for (const flags of [' -I', ' -I -X utf8', ' -X utf8 -I', ' -E -s', ' -X utf8', '']) {
      expect(isolatedByExecution('python3', flags), `the two verdicts differ on ${JSON.stringify(flags)}, which F-58 is not about`).toBe(
        isolatedBeforeF58(flags),
      );
    }
  });
  it('enumerates the flag grammar it claims to cover, and tests every production', () => {
    // The coordinator's ruling on F-58: state the grammar, then test every
    // production of it rather than the plant that produced the finding. The
    // grammar this law claims is
    //
    //   INVOCATION := INTERPRETER FLAG* TOOLPATH ARGS?
    //   INTERPRETER := python | python3 | python3.N | PATH/python3[.N]
    //   FLAG        := NOARG | COMBINED | ATTACHED | VALUED
    //   NOARG       := -I | -E | -s | …            (takes nothing)
    //   COMBINED    := -Es | -Iu | …               (short flags, all NOARG)
    //   ATTACHED    := -X utf8=1 | --opt=value     (value carries its own '=')
    //   VALUED      := -X utf8 | -W ignore | -m trace | --unknown v
    //   TOOLPATH    := name | tools/name | ./tools/name | /abs/tools/name
    //
    // and the verdict is ISOLATED only when `-I` appears as a FLAG.
    const interpreters = ['python', 'python3', 'python3.13', '/usr/bin/python3', '/usr/bin/python3.13'];
    const flagForms: { text: string; isolated: boolean; production: string }[] = [
      { text: '', isolated: false, production: 'no flags' },
      { text: '-I ', isolated: true, production: 'NOARG, the real thing' },
      { text: '-E ', isolated: false, production: 'NOARG, not -I' },
      { text: '-E -s ', isolated: false, production: 'NOARG twice' },
      { text: '-Iu ', isolated: true, production: 'COMBINED containing I' },
      { text: '-Es ', isolated: false, production: 'COMBINED without I' },
      { text: '-X utf8 ', isolated: false, production: 'VALUED, separate value' },
      { text: '-W ignore ', isolated: false, production: 'VALUED, separate value' },
      { text: '-m trace ', isolated: false, production: 'VALUED, module' },
      { text: '-X utf8=1 ', isolated: false, production: 'ATTACHED value' },
      { text: '-X -I ', isolated: false, production: 'VALUED whose VALUE is spelled -I — F-58' },
      { text: '-W -I ', isolated: false, production: 'VALUED whose VALUE is spelled -I — F-58' },
      { text: '--some-new-option -I ', isolated: false, production: 'unknown flag consumes the next token: fails closed' },
      { text: '-I -X utf8 ', isolated: true, production: 'NOARG then VALUED' },
      { text: '-X utf8 -I ', isolated: true, production: 'VALUED then NOARG' },
      { text: '-X utf8 -W ignore -I ', isolated: true, production: 'two VALUED then NOARG' },
      { text: '-XI ', isolated: false, production: 'CLUSTER carrying a value: -X with option I — F-59, measured 0' },
      { text: '-WI ', isolated: false, production: 'CLUSTER carrying a value — F-59, measured 0' },
      { text: '-XIdev ', isolated: false, production: 'CLUSTER, value-taking letter then a tail — F-59, measured 0' },
      { text: '-RI ', isolated: true, production: 'CLUSTER all argument-free, -R included — F-60, measured 1' },
      { text: '-R -I ', isolated: true, production: 'argument-free -R then -I — F-60, measured 1' },
      { text: '-sI ', isolated: true, production: 'CLUSTER all argument-free — the ruling asks for this one' },
      { text: '-IsE ', isolated: true, production: 'CLUSTER all argument-free, -I first' },
      { text: '-R ', isolated: false, production: 'argument-free -R alone isolates nothing' },
      { text: '-m trace ', isolated: false, production: 'REFUSED unrun: -m loads code' },
    ];
    const toolPaths = ['manifest-digests.py', 'tools/manifest-digests.py', './tools/manifest-digests.py', '/home/u/p/tools/manifest-digests.py'];
    let productions = 0;
    for (const interp of interpreters) {
      for (const { text, isolated: want, production } of flagForms) {
        for (const tool of toolPaths) {
          const form = `${interp} ${text}${tool} --check`;
          productions += 1;
          expect(matchCount(form), `the scan does not SEE this production (${production}): ${form}`).toBe(1);
          expect(offencesIn('fixture', form), `${production}: expected ${want ? 'no offence' : 'an offence'} — ${form}`).toHaveLength(want ? 0 : 1);
        }
      }
      // Whitespace is part of the grammar too: extra spaces and a shell
      // continuation must not change the verdict.
      expect(offencesIn('fixture', `${interp}   -X   -I    tools/manifest-digests.py`), 'extra whitespace changes the verdict').toHaveLength(1);
      expect(offencesIn('fixture', `${interp} -X -I \\\n    tools/manifest-digests.py`), 'a continuation changes the verdict').toHaveLength(1);
      productions += 2;
    }
    expect(productions, 'the grammar table collapsed, so this arm measures almost nothing').toBe(
      interpreters.length * (flagForms.length * toolPaths.length + 2),
    );
  });
  it('the verdict comes from CPython, and everything else is an offence', () => {
    // The coordinator's red proofs, each one asked of the interpreter rather
    // than of a model: `python3 -XI -c "…isolated"` prints 0, so it is an
    // offence however the letters are spelled.
    for (const flags of [' -XI', ' -WI', ' -XIdev', ' -X -I', ' -W -I']) {
      expect(isolatedByExecution('python3', flags), `${flags} is read as isolated, but CPython ${CPYTHON_HERE} does not isolate it`).toBe(false);
    }
    for (const flags of [' -I', ' -RI', ' -sI', ' -IsE']) {
      expect(isolatedByExecution('python3', flags), `${flags} IS isolated in CPython ${CPYTHON_HERE} and this law reds on it`).toBe(true);
    }
    // Fails closed on anything that is not a clean `1` at rc 0.
    expect(isolatedByExecution('python3.99', ' -I'), 'a missing interpreter is read as isolated, which is a fail-open').toBe(false);
    expect(isolatedByExecution('/nonexistent/python3', ' -I'), 'an unresolvable interpreter path is read as isolated').toBe(false);
    expect(isolatedByExecution('python3', ' --no-such-option -I'), 'a usage error is read as isolated').toBe(false);
    // And the two forms that are refused rather than run, because executing
    // them would run code a document names.
    expect(isolatedByExecution('python3', ' -I -m trace'), 'a segment carrying -m was executed or cleared').toBe(false);
    expect(isolatedByExecution('python3', ' -I -c pass'), 'a segment carrying -c was executed or cleared').toBe(false);
    // The whole law is over documents, so the live scan must still see the
    // real commands as isolated -- otherwise this round reds the repository.
    expect(isolatedByExecution('python3', ' -I')).toBe(true);
    expect(isolatedByExecution('/usr/bin/python3', ' -I')).toBe(true);
    // The bound this round creates, asserted rather than described: the law
    // can name the interpreter it measured. If the probe cannot run, every
    // verdict above is an offence by construction and this says so first.
    expect(CPYTHON_HERE, 'no CPython here, so this law measures nothing and every verdict is a refusal').toMatch(/^3\.\d+\.\d+$/);
  });

  it('F-59 guard deletion: the model clears -XI where CPython does not', () => {
    // ONE deletion, one property: restoring the cluster heuristic turns `-XI`
    // green, which is what made F-59 a fail-open.
    expect(isolatedByModel(' -XI'), 'the model no longer clears -XI, so this arm proves nothing').toBe(true);
    expect(isolatedByExecution('python3', ' -XI'), 'the verdict still clears a cluster that carries a value').toBe(false);
    expect(offencesIn('fixture', 'python3 -XI tools/manifest-digests.py --check'), 'the scan does not report -XI').toHaveLength(1);
    // F-60 travels with it: with the cluster rule and without `-R` in the
    // tokeniser's list, `-RI` and `-R -I` would have become false reds.
    expect(NO_ARG_FLAGS.has('-R'), 'F-60 regressed: -R is argument-free in CPython').toBe(true);
    expect(offencesIn('fixture', 'python3 -RI tools/manifest-digests.py --check'), '-RI is isolated in CPython and this law reds on it').toStrictEqual([]);
    expect(offencesIn('fixture', 'python3 -R -I tools/manifest-digests.py --check'), '-R -I is isolated in CPython and this law reds on it').toStrictEqual([]);
  });
  it("F-53: no message in this law claims a reviewer-shaped document is the author's", () => {
    // F-53 (P2) was that the refusal called an unenumerated reviewer-shaped
    // report "an author-owned pack document", which is false about ownership
    // and routes the reader to the one repair the pack forbids — editing a
    // reviewer's frozen bytes. Round 30 fixed the SENTENCE; round 31's B-12
    // remedy closed it BY CONSTRUCTION, because such a document is no longer
    // read by this law at all. This arm is what makes that structural rather
    // than incidental: the only sentence a reader can reach for such a name
    // routes them to the shared list, and the ownership sentence is reachable
    // only for a document the list does not shape-match.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    expect(here, 'the unclassified branch no longer tells the reader to enrol the name').toContain('enrol it in tools/reviewer-reports.json by its EXACT name');
    expect(here, "the unclassified branch no longer warns against editing a reviewer's report").toContain('do NOT edit a reviewer');
    // The ownership sentence exists exactly once, on the author-owned bucket.
    // The needle is ASSEMBLED, not written, or this arm's own copy of the
    // sentence would be the second occurrence it complains about -- the
    // self-counting shape B-10's before arm taught us to watch for.
    const needle = ['an author-owned pack', 'document prints an', 'un-isolated command'].join(' ');
    const ownership = here.split(needle).length - 1;
    expect(ownership, 'the ownership sentence is written more than once, so one of them can drift').toBe(1);
    // And the shaped name never reaches that bucket: the routing is asserted
    // by the pack arm above, this is its message half.
    const shaped = looksLikeReviewer();
    expect(shaped.test('P5-CHALLENGE-12345678.md'), 'the name from the F-53 report is no longer reviewer-shaped').toBe(true);
  });
  it('F-61: the law never runs what a document supplies — side-effect arms', () => {
    // ROUND 35, THE CHALLENGER'S F-61 (P0), adopted by the coordinator. These
    // arms pass only if the refusal is NAMED and the marker file is ABSENT:
    // a red that arrives after the payload ran is not a defence.
    const dir = mkdtempSync(join(tmpdir(), 'f61-'));
    const suiteMarker = join(dir, 'MARKER-SUITE');
    const shimMarker = join(dir, 'MARKER-SHIM');
    const shimDir = join(dir, 'shimdir');
    mkdirSync(shimDir);
    const shim = join(shimDir, 'python3');
    writeFileSync(shim, `#!/bin/sh\nprintf executed-by-the-interpreter-path > ${shimMarker}\necho 1\n`);
    chmodSync(shim, 0o755);

    // INSTANCE A, planted verbatim: one token, no whitespace, so the attached
    // form survives tokenisation.
    const payload = `-c__import__("pathlib").Path("${suiteMarker}").write_text("executed-by-the-gate")`;
    const lineA = `Example: \`python3 ${payload} tools/manifest-digests.py --check\``;
    const foundA = offencesIn('fixture', lineA);
    expect(foundA, 'instance A is not reported at all').toHaveLength(1);
    expect(foundA[0], 'instance A is reported without naming the refusal').toContain('REFUSED-UNEXECUTABLE-TOKEN');
    expect(existsSync(suiteMarker), 'THE LAW EXECUTED A DOCUMENT PAYLOAD: the marker file exists').toBe(false);

    // INSTANCE B, planted verbatim: a RELATIVE interpreter spelling.
    const lineB = 'Example: `shimdir/python3 tools/manifest-digests.py --dir d --check`';
    const foundB = offencesIn('fixture', lineB);
    expect(foundB, 'instance B is not reported at all').toHaveLength(1);
    expect(foundB[0], 'instance B is reported without naming the refusal').toContain('REFUSED-UNCLASSIFIABLE-INTERPRETER');
    expect(existsSync(shimMarker), 'THE LAW RAN A PROGRAM THE DOCUMENT NAMED: the shim marker exists').toBe(false);
    // An ABSOLUTE path to another binary is refused too, by the same name.
    const absolute = verdictFor(shim, ' ');
    expect(absolute.isolated).toBe(false);
    expect(absolute.refusal, 'an absolute path to another binary is not refused by name').toContain('REFUSED-UNCLASSIFIABLE-INTERPRETER');
    expect(existsSync(shimMarker), 'the shim ran when its absolute path was classified').toBe(false);

    // GUARD DELETION, one per copy. Each payload must be LIVE: if neither
    // would do anything when run, these arms prove nothing.
    const liveA = spawnSync('python3', [payload, 'tools/manifest-digests.py'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(liveA.status, 'the instance A payload no longer runs, so the token guard guards nothing').toBe(0);
    expect(existsSync(suiteMarker), 'the instance A payload wrote no marker, so it is not a live payload').toBe(true);
    rmSync(suiteMarker);

    const liveB = spawnSync(shim, ['tools/manifest-digests.py'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    expect(liveB.status, 'the shim does not run, so the interpreter guard guards nothing').toBe(0);
    expect((liveB.stdout ?? '').trim(), 'the shim does not print the 1 that would forge an isolated verdict').toBe('1');
    expect(existsSync(shimMarker), 'the shim wrote no marker, so it is not a live payload').toBe(true);
    rmSync(shimMarker);

    // And with both payloads proven live, the law's verdicts are refusals and
    // the markers stay absent -- which is the whole claim of this round.
    verdicts.clear();
    expect(verdictFor('python3', ` ${payload}`).refusal).toContain('REFUSED-UNEXECUTABLE-TOKEN');
    expect(verdictFor('shimdir/python3', ' ').refusal).toContain('REFUSED-UNCLASSIFIABLE-INTERPRETER');
    expect(existsSync(suiteMarker), 'a refusal still executed the payload').toBe(false);
    expect(existsSync(shimMarker), 'a refusal still ran the shim').toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('F-61: the allow-list refuses every form either reviewer named, by name', () => {
    // The coordinator's list, each refused WITHOUT being run.
    for (const flags of [' -c__import__("os")', ' -cprint(7)', ' -mthis', ' -c', ' -m', ' --', ' -Ic', ' -Im', ' tools/x.py', ' -X', ' -W']) {
      const v = verdictFor('python3', flags);
      expect(v.isolated, `${flags} is cleared`).toBe(false);
      expect(v.refusal, `${flags} is not refused by name`).toContain('REFUSED-UNEXECUTABLE-TOKEN');
    }
    // And the real forms still measure, so the law stays satisfiable.
    for (const flags of [' -I', ' -RI', ' -sI', ' -IsE', ' -I -X utf8', ' -X utf8 -I']) {
      expect(verdictFor('python3', flags).isolated, `${flags} is no longer measured as isolated`).toBe(true);
    }
    for (const flags of [' -X utf8', ' -W ignore', ' -E -s', '']) {
      const v = verdictFor('python3', flags);
      expect(v.isolated, `${flags} is cleared`).toBe(false);
      expect(v.refusal, `${flags} was refused rather than MEASURED, so the law stopped measuring`).toBeUndefined();
    }
  });
});
