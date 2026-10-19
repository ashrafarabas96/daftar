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

import { describe, expect, it, onTestFinished } from 'vitest';

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
 * segment. ISOLATED means CPython printed `1` and exited 0. **Everything else
 * is an OFFENCE**: rc not 0, a timeout, no CPython here, any other output. So
 * it fails closed, and a wrong model can now only produce a false RED.
 *
 * ROUND 35 CHANGED THE DISCIPLINE, NOT THE OUTCOME. Round 34 ran the
 * interpreter SPELLING the document wrote, with that document's flag segment
 * as argv; F-61 (P0) measured both halves of that as a way to run a document.
 * The sentences above are about the OUTCOME and still hold. WHEN AND WHAT THIS
 * LAW RUNS is now stated by `HARNESS_PYTHON`, `classifiableInterpreter` and
 * `executableArgv` below, and nowhere else: one interpreter, resolved here by
 * absolute path, with argv this law classified token by token. A document's
 * interpreter spelling and flags are DATA, and an unclassifiable one is
 * refused by name instead of run.
 *
 * TWO FORMS ARE REFUSED WITHOUT BEING RUN, and refusing counts as an offence:
 * `-c` and `-m` load code and end option processing, `--` ends it, so running
 * a segment carrying them would execute whatever a document names. A law that
 * reads other people's documents must not become a way to run them. That is a
 * safety gate, not a verdict: it can only produce a false red.
 */
const PROBE = 'import sys; print(sys.flags.isolated)';

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
/**
 * ROUND 36, THE CHALLENGER'S F-63 (P3). `?` sat in this set and nothing could
 * ever reach it: the only path in is `-[A-Za-z]+`, which `-?` cannot match, so
 * the letter was a claim no arm could exercise. By this project's rule such a
 * claim goes red or goes away. It goes away, and `-?` is therefore refused by
 * name like any other token this list does not know -- which is the safe
 * direction and is armed below.
 */
const EXECUTABLE_LETTERS = new Set('BbdEhiIOPqRsSuVvx'.split(''));
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-X', '-W']);
const PLAIN_VALUE = /^[A-Za-z0-9_.:=,+-]+$/;

/**
 * ROUND 36, THE COORDINATOR'S F-62 (P2, worse than reported) AND F-64 (P3).
 * The value is the last free text a document still controls, and two of its
 * uses reach outside the probe:
 *
 *   - `-X pycache_prefix=..` passes `PLAIN_VALUE` because it needs no slash,
 *     and writes a bytecode tree ABOVE the current directory. Measured: from
 *     `<scratch>/inner` it wrote `<scratch>/usr/lib/python3.13/...`, so a
 *     disposable cwd alone does not contain it -- `..` simply leaves. In the
 *     repository it reached `packages/usr/`, with the planting run GREEN.
 *   - `-W ignore::this.X` names a DOTTED warning category, and CPython
 *     resolves one by IMPORTING its module: `this` ran its top-level code
 *     inside the probe. A module the document plants in the cwd is not
 *     importable (the env carries no PYTHONPATH and `-I` is not required for
 *     that here), but any stdlib module is.
 *
 * So the value is allow-listed per flag, not merely per character class.
 * `-W` takes an action with at most a category `builtins` actually has; `-X`
 * takes an option name THIS INTERPRETER lists, minus the writers. Everything
 * else is refused by name, so this stays a false-RED direction.
 *
 * ROUND 36 WROTE THAT SENTENCE WHILE THE `-X` ARM WAS A DENY-LIST OF TWO
 * NAMES, which made it measured-FALSE about the class: `-X perf_jit` passed,
 * and the probe wrote `/tmp/jit-<pid>.dump`. F-67 below is where the names
 * come from now. The sentence is kept, in its true form, next to the
 * instrument that makes it true -- the previous wording is the reason the
 * discipline sweep exists.
 */
const DOT_SEGMENT = (value: string): boolean => value.split(/[=,:]/).some((part) => part === '.' || part === '..');
const W_VALUE = /^[A-Za-z]+(::[A-Za-z]+)?$/;

/**
 * The warning categories THIS interpreter has in `builtins`, asked of it.
 *
 * ROUND 37, R36-02 (P3, the challenger's, and cheap on the coordinator's
 * ruling): `-W ignore::this` is dotless, so F-64's fix cleared it, and nothing
 * is imported -- but CPython itself rejects the category at the first filtered
 * warning, so the gate cleared a command the interpreter would not honour. The
 * names come from `builtins` rather than a list written here, for F-67's
 * reason: a list of another program's names, written by hand, is a claim that
 * ages.
 */
const BUILTIN_WARNINGS = ((): ReadonlySet<string> => {
  if (HARNESS_PYTHON === '') return new Set();
  const r = spawnSync(HARNESS_PYTHON, ['-I', '-c', "import builtins; print(' '.join(n for n in dir(builtins) if n.endswith('Warning')))"], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (r.status !== 0) return new Set();
  return new Set(
    (r.stdout ?? '')
      .trim()
      .split(/\s+/)
      .filter((n) => n !== ''),
  );
})();

const REFUSED_W_CATEGORY = 'REFUSED-UNKNOWN-WARNING-CATEGORY';
const REFUSED_INTERPRETER_REJECTED = 'REFUSED-INTERPRETER-REJECTED-THE-OPTION';
/**
 * Options whose PURPOSE is to write a file. `pycache_prefix` writes a bytecode
 * tree under its value; `perf` and `perf_jit` write `/tmp/perf-<pid>.map` and
 * `/tmp/jit-<pid>.dump`, and those paths are FIXED literals in CPython --
 * measured here: with TMPDIR pointed at a scratch directory both still landed
 * in /tmp. So a disposable directory cannot contain this class and the options
 * are refused by name.
 */
const X_WRITES_FILES = new Set(['pycache_prefix', 'perf', 'perf_jit']);

/**
 * The `-X` option names THIS interpreter has, asked of it rather than listed.
 *
 * ROUND 37, THE CHALLENGER'S F-67 (P1). Round 36 called the value
 * "allow-listed per flag" and the `-X` arm was a DENY-LIST of two literal
 * names. Measured: `--help-xoptions` has 14 options in CPython 3.13.16 and
 * exactly two of them write files, `perf` and `perf_jit`. I had named one, so
 * `python3 -I -X perf_jit <tool>` passed the live scan at rc 0 while the
 * gate's own probe wrote `/tmp/jit-<pid>.dump` -- outside the owned cwd AND
 * outside the TMPDIR, because that path is the same fixed literal. The leak
 * alone is small; the fail-open is that a deny-list cannot name an option
 * CPython has not shipped yet, and that my sentence about it measured FALSE.
 *
 * So the names come from the interpreter, the way round 34 moved the isolation
 * verdict to execution. If the list cannot be read, every `-X` is refused:
 * fail closed, and a future CPython option is a false RED rather than a silent
 * pass.
 */
const X_OPTION_NAMES = ((): ReadonlySet<string> => {
  if (HARNESS_PYTHON === '') return new Set();
  const r = spawnSync(HARNESS_PYTHON, ['-I', '--help-xoptions'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
  if (r.status !== 0) return new Set();
  const names = [...(r.stdout ?? '').matchAll(/^\s*-X ([a-z_0-9]+)/gm)].map((m) => m[1] ?? '');
  return new Set(names.filter((n) => n !== '' && !X_WRITES_FILES.has(n)));
})();

const REFUSED_X_OPTION = 'REFUSED-UNLISTED-X-OPTION';
const REFUSED_X_WRITER = 'REFUSED-FILE-WRITING-X-OPTION';
const REFUSED_NO_X_LIST = 'REFUSED-NO-X-OPTION-LIST';

const valueRefusal = (flag: string, value: string): string | undefined => {
  if (!PLAIN_VALUE.test(value) || DOT_SEGMENT(value)) return REFUSED_TOKEN;
  if (flag === '-W') {
    if (!W_VALUE.test(value)) return REFUSED_TOKEN;
    const category = value.split('::')[1];
    if (category === undefined) return undefined;
    if (BUILTIN_WARNINGS.size === 0) return REFUSED_W_CATEGORY;
    return BUILTIN_WARNINGS.has(category) ? undefined : REFUSED_W_CATEGORY;
  }
  const name = value.split('=')[0] ?? value;
  if (X_WRITES_FILES.has(name)) return REFUSED_X_WRITER;
  if (X_OPTION_NAMES.size === 0) return REFUSED_NO_X_LIST;
  // An `-X` option is accepted only if the INTERPRETER lists it and it is not
  // one of the writers. Everything else is refused BY ITS OWN NAME, including
  // an option a later CPython adds.
  return X_OPTION_NAMES.has(name) ? undefined : REFUSED_X_OPTION;
};

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
      if (value === undefined) return { refusal: REFUSED_TOKEN, token: `${t} (nothing)` };
      const why = valueRefusal(t, value);
      if (why !== undefined) return { refusal: why, token: `${t} ${value}` };
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

/**
 * Runs the probe, in a DIRECTORY THIS LAW OWNS.
 *
 * ROUND 36, THE CHALLENGER'S F-62 (P2). An allow-listed value can still have a
 * side effect in the current directory, and the probe inherited the suite's:
 * `-X pycache_prefix=<name>` needs no path separator, so it passed the value
 * filter, and CPython wrote its startup bytecode under
 * `packages/billing/<name>/usr/lib/python3.13/...` -- 7 `.pyc` files, measured
 * here, one of them `sitecustomize.cpython-313.pyc`, the very mechanism this
 * law exists to defend against. One document line dirtied the working tree,
 * and the NEXT run reddened on files the gate itself had created, naming them
 * as unreadable binaries, with the line that caused it already gone from the
 * inputs. It denies the gate rather than hiding a defect, which is why it is
 * P2 -- and the repair is not to refuse `pycache_prefix=` by name, which
 * closes one instance, but to give the run a disposable cwd, which closes the
 * class: whatever an allow-listed value writes, it writes somewhere nobody
 * keeps.
 *
 * `ownCwd` is how the arm DELETES this guard: with it false the probe inherits
 * the suite's directory again, and the same line must leave files behind.
 */
const probeIsolated = (argv: readonly string[], ownCwd: boolean): { isolated: boolean; rejected?: boolean; rejection?: string } => {
  const scratch = ownCwd ? mkdtempSync(join(tmpdir(), 'p5probe-')) : undefined;
  try {
    const r = spawnSync(HARNESS_PYTHON, [...argv, '-c', PROBE], {
      encoding: 'utf8',
      timeout: 10_000,
      // TMPDIR too, for anything that honours it. `-X perf` does NOT -- its
      // path is a fixed `/tmp` literal, measured -- which is why that option
      // is refused by name rather than contained here.
      env: scratch === undefined ? { PATH: '/usr/bin:/bin' } : { PATH: '/usr/bin:/bin', TMPDIR: scratch },
      ...(scratch === undefined ? {} : { cwd: scratch }),
    });
    // ROUND 38, R37-01 (P3). The `-W` ACTION field was unvalidated, so
    // `-W bogus::UserWarning` was cleared green: CPython prints
    // `Invalid -W option ignored: invalid action: 'bogus'` and carries on at
    // rc 0. Rather than writing the six actions down -- F-67's lesson about
    // lists of another program's names -- the gate now reads the
    // INTERPRETER'S OWN REJECTION off stderr. It covers `-X` the same way,
    // and any spelling a later CPython rejects.
    // ROUND 40, R38-03 (P3): the refusal used to be the bare name, so an
    // offence line carrying two value flags did not say WHICH of them CPython
    // refused. The stderr line that proves the refusal names it, so it is
    // carried out with the refusal.
    const rejection = /^Invalid -[XW] option ignored.*$/m.exec(r.stderr ?? '');
    if (rejection !== null) return { isolated: false, rejected: true, rejection: (rejection[0] ?? '').trim().slice(0, 120) };
    return { isolated: r.status === 0 && (r.stdout ?? '').trim() === '1' };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
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
    // The live verdict always owns its directory; `false` exists for the
    // deletion arm alone, and that arm counts its own call sites.
    const run = probeIsolated(parsed.argv, true);
    out = run.rejected === true ? { isolated: false, refusal: `${REFUSED_INTERPRETER_REJECTED} ${run.rejection ?? ''}`.trim() } : { isolated: run.isolated };
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
const REFUSED_OPEN_QUOTE = 'REFUSED-UNTERMINATED-QUOTE-BLOCK';

/**
 * ROUND 37, THE CHALLENGER'S F-66 (P1). The exemption was released only by the
 * NEXT fence line, so a declared opener that is never closed left
 * `inFence && exempt` true to end of input and every later invocation was
 * skipped IN SILENCE. Measured by the challenger on a pack copy: an offence
 * after an UNTERMINATED declared block gives rc 0, 22 passed, hidden, while
 * the same offence after a CLOSED declared block reds, and after an
 * unterminated NON-declared block reds -- so the hole belongs to the
 * declaration, not to the fence. 0 of 56 live pack documents have an odd fence
 * count, so there is no live instance: the shape arrives from a forgotten
 * closing fence, or from a quoted transcript whose own fences leave the
 * declared opener unmatched.
 *
 * `refuseUnterminated` is how the arm deletes this check: with it false, the
 * tail is silently exempt again and fixture (d) goes green.
 */
const FENCE = /^\s*```/;

/**
 * The fence lines of a document, counted off its RAW lines.
 *
 * ROUND 39, THE COORDINATOR'S C-01. One reader, used by the scan AND by the
 * fence census, so the two cannot disagree about where a block ends -- the
 * census was blind to C-01 for exactly that reason.
 */
const fenceLineCount = (text: string): number => text.split('\n').filter((l) => FENCE.test(l)).length;

/**
 * Join continuation lines WITHIN one region, never across a fence.
 *
 * `logicalLines` joins over the whole document, which is what C-01 exploited:
 * a backslash on the last quoted line swallowed the closing fence. Structure
 * first, joining second.
 */
const joinWithin = (records: { n: number; raw: string }[]): { n: number; line: string }[] => {
  const out: { n: number; line: string }[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const start = records[i]?.n ?? 0;
    let line = records[i]?.raw ?? '';
    while (/\\\s*$/.test(line) && i + 1 < records.length) {
      i += 1;
      line = `${line.replace(/\\\s*$/, ' ')}${(records[i]?.raw ?? '').trim()}`;
    }
    out.push({ n: start, line });
  }
  return out;
};

const scanDocument = (
  label: string,
  text: string,
  honourDeclaration: boolean,
  refuseUnterminated: boolean,
  fencesFromRawLines: boolean,
): [string[], number] => {
  const found: string[] = [];
  let exemptBlocks = 0;
  let inFence = false;
  let exempt = false;

  // ROUND 39, C-01 (P1, a FAIL-OPEN): fences are recognised on RAW lines,
  // BEFORE any continuation joining, and continuations are then joined only
  // within a region. Reading fences off joined lines let a trailing backslash
  // on the last quoted line swallow the closing fence, so the exemption ran
  // on into prose the reader sees as copyable -- green over an un-isolated
  // command. `fencesFromRawLines` is how the arm deletes this, and with it
  // false the fixture goes green-wrong, which is the control.
  //
  // THE CLASS, in one line: never recognise structure on text something else
  // has already rewritten.
  const lines = fencesFromRawLines ? text.split('\n').map((raw, i) => ({ n: i + 1, raw })) : logicalLines(text).map(({ n, line }) => ({ n, raw: line }));

  let region: { n: number; raw: string }[] = [];
  const flush = (): void => {
    if (region.length === 0) return;
    const joinable = fencesFromRawLines ? joinWithin(region) : region.map(({ n, raw }) => ({ n, line: raw }));
    for (const { n, line } of joinable) {
      for (const m of line.matchAll(INVOCATION)) {
        const v = verdictFor(m[1] ?? 'python3', m[2] ?? '');
        if (!v.isolated) found.push(`${label}:${n}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
      }
    }
    region = [];
  };

  for (const { n, raw } of lines) {
    if (FENCE.test(raw)) {
      flush();
      if (inFence) {
        inFence = false;
        exempt = false;
      } else {
        inFence = true;
        // ROUND 35, THE COORDINATOR: a declared quotation block IS an
        // exemption, so it owes a deletion arm like every other one. The
        // recognition lives HERE and nowhere else, and `honourDeclaration`
        // is how an arm deletes it -- one implementation, so no copy can
        // drift from the live scan the way a hand-kept twin would.
        exempt = honourDeclaration && /f-50-quote/.test(raw);
        if (exempt) exemptBlocks += 1;
      }
      continue;
    }
    if (inFence && exempt) continue;
    region.push({ n, raw });
  }
  flush();

  if (refuseUnterminated && inFence && exempt) {
    found.push(`${label}: ${REFUSED_OPEN_QUOTE}: a declared quotation block is never closed, so the rest of this document was NOT scanned`);
  }
  return [found, exemptBlocks];
};

/** The live scan: fences off raw lines, the declaration honoured, an open one refused. The ONLY caller of all three. */
const offencesOutsideQuotedBlocks = (label: string, text: string): [string[], number] => scanDocument(label, text, true, true, true);

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

  it('F-62/F-64: a value may not choose a program, a directory, or a module', () => {
    // ROUND 36. The challenger's F-62 (P2) and the coordinator's measurement
    // of it, which was worse: `-X pycache_prefix=..` passes PLAIN_VALUE, needs
    // no slash, and writes ABOVE the current directory -- in the repository it
    // reached `packages/usr/`, with the planting run GREEN. Plus its F-64
    // (P3): a DOTTED `-W` category is resolved by IMPORTING its module, so
    // `-W ignore::this.X` ran stdlib `this` inside the probe.
    //
    // Four guards, because each closes a different door: an option that
    // WRITES FILES is refused by name (`pycache_prefix`, `perf`, `perf_jit`,
    // the last of them F-67's), every other `-X` name must be one THIS
    // INTERPRETER lists, any value carrying a `.` or `..` SEGMENT is refused
    // (that is what escapes a directory), a `-W` category must be one
    // `builtins` has -- and the probe still runs in a directory this law owns,
    // now
    // as TMPDIR as well, which is what contains everything else.
    const refusals: [string, string, string][] = [
      ['-X pycache_prefix=p5pyc', REFUSED_X_WRITER, 'the option whose purpose is writing files'],
      ['-X pycache_prefix=..', REFUSED_TOKEN, 'the escape the coordinator measured into packages/usr/'],
      ['-X pycache_prefix=../..', REFUSED_TOKEN, 'two levels of it'],
      ['-X somewhere=..', REFUSED_TOKEN, 'a dot segment under any other option name'],
      ['-W ignore::this.X', REFUSED_TOKEN, 'a dotted warning category, which CPython imports'],
      ['-W ignore::evilmod.Boom', REFUSED_TOKEN, "the challenger's planted module"],
      // ROUND 37: F-67's own instance, and the names that were never listed.
      ['-X perf_jit', REFUSED_X_WRITER, 'the writer I had not named, which wrote /tmp/jit-<pid>.dump'],
      ['-X perf_jit=1', REFUSED_X_WRITER, 'the same hole with a value'],
      ['-X perf', REFUSED_X_WRITER, 'the writer the coordinator named'],
      ['-X presite=evilmod', REFUSED_X_OPTION, 'R36-01: an import-before-site vector this build ignores and a debug build does not'],
      ['-X no_such_option_here', REFUSED_X_OPTION, 'an option this interpreter does not list'],
      ['-W ignore::this', REFUSED_W_CATEGORY, 'R36-02: dotless, imports nothing, and CPython itself rejects the category'],
    ];
    for (const [flags, name, why] of refusals) {
      const parsed = executableArgv(` ${flags}`);
      expect('refusal' in parsed, `${flags} reaches CPython: ${why}`).toBe(true);
      const v = verdictFor('python3', ` -I ${flags}`);
      expect(v.isolated, `${flags} was cleared as isolated`).toBe(false);
      expect(v.refusal, `${flags} is refused, but not by the name that says why`).toContain(name);
    }

    // F-67's leak, measured by SIDE EFFECT and not by the refusal: no dump
    // appears in /tmp, which is where that option writes whatever TMPDIR says.
    const dumpsBefore = new Set(readdirSync('/tmp').filter((n) => n.startsWith('jit-')));
    for (const flags of [' -I -X perf_jit', ' -I -X perf_jit=1']) {
      verdicts.clear();
      verdictFor('python3', flags);
    }
    expect(
      readdirSync('/tmp').filter((n) => n.startsWith('jit-') && !dumpsBefore.has(n)),
      'THE GATE RAN A FILE-WRITING OPTION: a jit dump landed in /tmp',
    ).toStrictEqual([]);

    // The `-X` names are DERIVED, not written: the set must come from this
    // interpreter's own help, and the writers must not be in it.
    expect(X_OPTION_NAMES.size, 'the -X option names were not read from the interpreter, so the allow-list is a literal again').toBeGreaterThan(5);
    for (const writer of X_WRITES_FILES) {
      expect(X_OPTION_NAMES.has(writer), `${writer} is in the derived allow-list, so a writer is accepted`).toBe(false);
    }
    expect(BUILTIN_WARNINGS.has('DeprecationWarning'), 'the warning categories were not read from builtins').toBe(true);

    // ROUND 38, R37-01 (P3): the `-W` ACTION field. CPython prints
    // `Invalid -W option ignored` and carries on at rc 0, so a bogus action
    // was cleared green. The gate now reads that rejection off stderr instead
    // of carrying a list of the six actions.
    // Measured, both sides: `-W bogus::UserWarning` prints the rejection and
    // is now refused by name. On the `-X` side this check has NO reachable
    // instance today, because an unknown option name is refused before
    // anything is spawned and a bad VALUE is fatal rather than ignored
    // (`-X int_max_str_digits=nonsense` -> "Fatal Python error", no `1` on
    // stdout, already an offence). So for `-X` it is a net held open for a
    // spelling a later CPython decides to ignore: UNMEASURED there, not dead.
    const rejected = verdictFor('python3', ' -I -W bogus::UserWarning');
    expect(rejected.isolated, 'a bogus -W action is cleared although CPython itself rejects it').toBe(false);
    expect(rejected.refusal, 'the interpreter rejection is not named').toContain(REFUSED_INTERPRETER_REJECTED);
    // ROUND 40, R38-03 (P3): and it says WHICH option CPython refused, so an
    // offence line carrying two value flags is actionable.
    expect(rejected.refusal, 'the refusal does not say which option the interpreter refused').toContain('-W');
    expect(rejected.refusal, "the refusal does not carry the interpreter's own words about the option").toContain('bogus');
    expect(verdictFor('python3', ' -I -X int_max_str_digits=nonsense').isolated, 'a fatal -X value is read as isolated').toBe(false);
    for (const flags of [' -I -W ignore', ' -I -W error::DeprecationWarning', ' -I -W once::UserWarning']) {
      expect(verdictFor('python3', flags).isolated, `${flags} is a real action and this law reds on it`).toBe(true);
    }

    // ROUND 38, R37-02 (P3), the bound MEASURED each run instead of trusted:
    // "writes a file" cannot be derived from help text, so the writer set is
    // hand-classified as a subtraction. So every name the filter now ACCEPTS
    // is run and must write nothing -- in the owned cwd, in its TMPDIR, or in
    // /tmp. A future CPython option that writes to a fixed path would be
    // listed, unsubtracted and accepted, and THIS arm is what catches it.
    //
    // ROUND 40, R38-01 (P3): the /tmp delta used to be snapshotted ONCE around
    // the whole loop, so any entry another process created inside that window
    // -- measured at roughly 0.3 s, and this package's own `addon-meters`
    // scratch prefix is a real candidate, since neither config disables
    // `fileParallelism` -- was attributed to an `-X` option, with a message
    // sending the reader hunting an option that wrote nothing. The window is
    // now ONE SPAWN, and a stray entry is not blamed on an option until a
    // SECOND run of that same option strays too: the project's own rule for
    // telling a bystander from a defect. The direction stays a false RED, and
    // a real writer writes on both runs.
    const strayFor = (name: string): string[] => {
      const probe = mkdtempSync(join(tmpdir(), 'r3702-'));
      try {
        const before = new Set(readdirSync('/tmp'));
        const r = spawnSync(HARNESS_PYTHON, ['-I', '-X', name, '-c', PROBE], {
          encoding: 'utf8',
          timeout: 10_000,
          cwd: probe,
          env: { PATH: '/usr/bin:/bin', TMPDIR: probe },
        });
        const stray = readdirSync('/tmp').filter((e) => !before.has(e) && !e.startsWith('r3702-'));
        expect(readdirSync(probe), `-X ${name} is accepted by this filter and WRITES a file: it belongs in X_WRITES_FILES`).toStrictEqual([]);
        expect(r.status === 0 || r.status === 1, `-X ${name} neither ran nor failed cleanly`).toBe(true);
        return stray;
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    };
    // The blame rule itself, as a function this arm can RUN rather than a
    // comment: nothing is blamed on an option unless a second run strays too.
    const blame = (first: readonly string[], second: readonly string[]): readonly string[] => (first.length === 0 ? [] : second);
    for (const name of X_OPTION_NAMES) {
      const first = strayFor(name);
      const second = first.length === 0 ? [] : strayFor(name);
      expect(
        blame(first, second),
        `-X ${name} is accepted by this filter and wrote into /tmp on TWO consecutive runs, where no cwd or TMPDIR can contain it (the first run left ${first.join(', ')}): it belongs in X_WRITES_FILES`,
      ).toStrictEqual([]);
    }
    // Armed on the rule, both directions: a bystander entry seen once is not
    // blamed, and an option that strays on both runs still is.
    expect(blame(['p5-limit-registry-JI2U8U'], []), 'a /tmp entry another process created inside the window is blamed on an -X option again').toStrictEqual([]);
    expect(blame(['jit-1836.dump'], ['jit-2145.dump']), 'an option that writes into /tmp on both runs is no longer blamed').toStrictEqual(['jit-2145.dump']);

    // And the forms that have no side effect outside the probe still pass, or
    // this is a gate rather than a filter.
    for (const flags of [' -I -X dev', ' -I -X importtime', ' -I -X frozen_modules=off', ' -I -W error::DeprecationWarning', ' -I -W ignore']) {
      expect(verdictFor('python3', flags).isolated, `${flags} is isolated in CPython ${CPYTHON_HERE} and this law reds on it`).toBe(true);
    }

    // THE CLASS GUARD, measured DIRECTLY on the mechanism rather than through
    // the allow-list. Both options that write are now refused by name, so no
    // document-reachable value exercises the owned directory today: it is
    // defence in depth, and that is a bound, not a dead guard. So the arm
    // hands `probeIsolated` the refused argv itself -- the layer below the
    // allow-list -- and measures the directory.
    const argv = ['-I', '-X', 'pycache_prefix=p5pyc'];
    expect(probeIsolated(argv, true).isolated, 'the probe no longer reports this isolated command as isolated').toBe(true);
    expect(existsSync(join(process.cwd(), 'p5pyc')), 'THE PROBE WROTE INTO THE WORKING TREE: a directory the gate created is sitting beside the suite').toBe(
      false,
    );

    // GUARD DELETION, one deletion, run inside a directory the arm owns so
    // that proving the hole cannot dirty the repository.
    const owned = mkdtempSync(join(tmpdir(), 'f62-'));
    onTestFinished(() => rmSync(owned, { recursive: true, force: true }));
    const previous = process.cwd();
    try {
      process.chdir(owned);
      expect(probeIsolated(argv, false).isolated, 'the deletion changed the verdict, so it is not a pure deletion').toBe(true);
      expect(readdirSync(owned), 'with the guard deleted the value wrote nothing, so the guard guards nothing').toStrictEqual(['p5pyc']);
    } finally {
      process.chdir(previous);
    }

    // And `false` is reachable from this arm only.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    const deleting = (here.match(/probeIsolated\((?:[^()]|\([^()]*\))*false\)/g) ?? []).length;
    const owning = (here.match(/probeIsolated\((?:[^()]|\([^()]*\))*true\)/g) ?? []).length;
    expect(deleting, 'a second caller deletes the owned directory: it must be an arm, counted here').toBe(1);
    expect(owning, 'the callers that own their directory are no longer the live verdict plus this arm').toBe(2);
  });

  it('F-63: `-?` is refused by name, and no letter sits in the set unreachable', () => {
    // ROUND 36, THE CHALLENGER'S F-63 (P3). `?` was in EXECUTABLE_LETTERS and
    // nothing could reach it, because the only path in is `-[A-Za-z]+`. A
    // claim nothing can exercise goes red or goes away; it went away, and the
    // token is refused like any other the list does not know.
    const refused = executableArgv(' -?');
    expect('refusal' in refused, '`-?` is no longer refused, so an unknown token reaches CPython').toBe(true);
    expect('refusal' in refused ? refused.refusal : '', '`-?` is refused without naming the refusal').toBe(REFUSED_TOKEN);
    const v = verdictFor('python3', ' -I -?');
    expect(v.isolated, 'a segment carrying `-?` was executed or cleared').toBe(false);
    expect(v.refusal, '`-?` is refused without a name in the verdict').toContain(REFUSED_TOKEN);

    // Every letter in the set must be REACHABLE through the one path in, or it
    // is F-63 again under another letter. Measured as a function of the set,
    // not asserted as a count.
    const unreachable = [...EXECUTABLE_LETTERS].filter((c) => !/^-[A-Za-z]+$/.test(`-${c}`));
    expect(unreachable, 'a letter in EXECUTABLE_LETTERS cannot be reached by any token this law accepts').toStrictEqual([]);
    // And each one is still argument-free in THIS CPython, asked rather than
    // assumed: `-<c> -c <probe>` must print 1 when isolation is also asked.
    for (const c of EXECUTABLE_LETTERS) {
      if (c === 'h' || c === 'V' || c === 'i') continue; // print-and-exit or interactive: not a verdict
      expect(verdictFor('python3', ` -I -${c}`).isolated, `-${c} is listed as argument-free but CPython ${CPYTHON_HERE} does not isolate \`-I -${c}\``).toBe(
        true,
      );
    }
  });

  it('C-01: a trailing backslash does not carry a declared block past its fence', () => {
    // ROUND 39, THE COORDINATOR'S C-01 (P1, a FAIL-OPEN it measured itself,
    // present since before the signed head). `logicalLines` joins any line
    // ending in a backslash to the next RAW line, so when the last line
    // INSIDE a declared block ends in a backslash -- an ordinary quoted
    // multi-line shell command -- the closing fence is swallowed into it and
    // never seen as a fence. The exemption then stays open; a later ordinary
    // block "closes" it, so neither the end-of-input refusal nor the fence
    // census fires, and the raw fence count is even. In CommonMark the
    // backslash is literal inside a fence and the fence closes, so the reader
    // sees the offence as copyable PROSE.
    const offence = 'shimdir/python3 tools/manifest-digests.py --check';
    const bs = ['```text f-50-quote', '$ echo quoted \\', '```', '', offence, '', '```text', '```'].join('\n');

    const found = offencesOutsideQuotedBlocks('BS', bs);
    expect(found[0], 'the offence after a backslash-ended quoted line is HIDDEN: the exemption ran past its fence').toHaveLength(1);
    expect(found[0][0], 'the offence is reported without naming the refusal').toContain(REFUSED_INTERPRETER);
    expect(found[1], 'the declared block was not counted exactly once').toBe(1);

    // The same bytes with the backslash removed must behave identically, or
    // the fix is about the backslash rather than about the fence.
    const plain = bs.replace('$ echo quoted \\', '$ echo quoted');
    expect(offencesOutsideQuotedBlocks('PLAIN', plain)[0], 'the backslash-free form disagrees with the backslash form').toHaveLength(1);

    // ROUND 40, THE CHALLENGER'S FIXTURE (d): TWO trailing backslashes
    // continue as well, because the joining loop replaces one backslash per
    // pass and re-tests. A fix keyed on one trailing character would leave
    // this open; this one reads fences before any pass at all.
    const twoBs = bs.replace('$ echo quoted \\', '$ echo quoted \\\\');
    expect(twoBs, 'fixture (d) does not actually carry two trailing backslashes').toContain('quoted \\\\');
    const foundTwo = offencesOutsideQuotedBlocks('BS2', twoBs);
    expect(foundTwo[0], 'the double-backslash form hides the offence: the shape is wider than one backslash').toHaveLength(1);
    expect(scanDocument('BS2', twoBs, true, true, false)[0], 'reading fences off joined lines no longer hides the double-backslash form').toStrictEqual([]);

    // ROUND 40, THE CHALLENGER'S FIXTURE (b), as a CONTROL on the COUPLING:
    // with NO later ordinary block, the same bytes are never green. Under the
    // joined-lines reader the swallowed fence leaves the block open to
    // end-of-input, and F-66's refusal catches it by name; under the raw-line
    // reader the fence closes and the offence is reported by name. So C-01 is
    // not a hole in the F-66 fix -- it is a hole that DEFEATS it, and it needs
    // the later block to do so, which is why the two must be read together.
    const noLater = ['```text f-50-quote', '$ echo quoted \\', '```', '', offence, ''].join('\n');
    const bFixed = offencesOutsideQuotedBlocks('B', noLater);
    expect(bFixed[0], 'fixture (b) is not reported at all under the raw-line reader').toHaveLength(1);
    expect(bFixed[0][0], "fixture (b)'s offence is reported without naming the refusal").toContain(REFUSED_INTERPRETER);
    const bJoined = scanDocument('B', noLater, true, true, false);
    expect(bJoined[0].join('\n'), 'with no later block the joined-lines reader goes green too, so F-66 is not what caught the uncoupled form').toContain(
      REFUSED_OPEN_QUOTE,
    );

    // GUARD DELETION: with fences read off JOINED lines again, the offence
    // goes green-wrong -- the fail-open the coordinator measured.
    const joined = scanDocument('BS', bs, true, true, false);
    expect(joined[0], 'reading fences off joined lines no longer hides the offence, so the raw-line reader is not what found it').toStrictEqual([]);

    // THE SWEEP the coordinator asked for, as a claim this file can check:
    // every fence recognition must be applied to a RAW line. Needles
    // assembled, or each counts its own literal.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    const call = ['FENCE', '.test('].join('');
    // The needle is assembled, so it does not appear literally in this file
    // and cannot count itself -- B-10's shape, watched for every time.
    const allFenceTests = here.split(call).length - 1;
    const onRaw = here.split(`${call}raw)`).length - 1;
    const onSplitLines = here.split(`${call}l)`).length - 1;
    expect(onRaw + onSplitLines, 'a fence is recognised on something other than a raw line, which is C-01 again').toBe(allFenceTests);
    // The other two scans recognise NO structure, so joining cannot hide
    // anything there: they read every line. Measured as the absence of a
    // fence test outside the two sites above.
    expect(allFenceTests, 'the fence reader grew a third site: it owes this arm a case').toBe(2);
    // And the raw-line reader is deleted from one arm only, counted by shape.
    const rawDeleting = (here.match(/scanDocument\((?:[^()]|\([^()]*\))*true,\s*true,\s*false\)/g) ?? []).length;
    // Three arms delete the raw-line reader: this fixture, the challenger's
    // double-backslash form, and its fixture (b) coupling control. A fourth
    // caller would be a live one, which is C-01 back.
    expect(rawDeleting, 'a caller reads fences off joined lines outside the three arms here: it must be an arm, counted here').toBe(3);

    // And a continuation INSIDE ordinary prose must still be joined, or the
    // raw-line fence reader has broken F-52's continuation handling.
    expect(offencesIn('fixture', 'python3 \\\n    tools/manifest-digests.py --check')).toHaveLength(1);
    expect(offencesOutsideQuotedBlocks('CONT', 'python3 -I \\\n    tools/manifest-digests.py --check')[0]).toStrictEqual([]);
  });

  it('F-66: a declared quotation block left OPEN refuses, instead of hiding the tail', () => {
    // ROUND 37, THE CHALLENGER'S F-66 (P1). The exemption was released only by
    // the next fence line, so a declared opener that is never closed hid every
    // later invocation in silence. Its four fixtures, rebuilt here with a
    // genuine offence -- an unclassifiable interpreter spelling -- so each one
    // reds for a reason this law names.
    const attack = 'Example: `shimdir/python3 tools/manifest-digests.py --dir d --check`';
    const a = attack;
    const c = ['```text f-50-quote', '$ shimdir/python3 tools/manifest-digests.py --check', '```', '', attack].join('\n');
    const d = ['```text f-50-quote', '$ shimdir/python3 tools/manifest-digests.py --check', '', attack].join('\n');
    const e = ['```text', '$ echo not declared', '', attack].join('\n');

    // (a) an offence outside any block reds by name.
    expect(offencesOutsideQuotedBlocks('A', a)[0], '(a) a bare offence is not reported').toHaveLength(1);
    expect(offencesOutsideQuotedBlocks('A', a)[0][0]).toContain(REFUSED_INTERPRETER);
    // (c) a CLOSED declared block exempts itself and the offence after it reds.
    const closed = offencesOutsideQuotedBlocks('C', c);
    expect(closed[1], '(c) the declared block was not counted as exempt').toBe(1);
    expect(closed[0], '(c) the offence after a closed block is not reported').toHaveLength(1);
    expect(closed[0][0]).toContain(REFUSED_INTERPRETER);
    // (d) an UNTERMINATED declared block refuses BY NAME and says the tail was
    // not scanned. Before this round it was SILENT: rc 0, nothing reported.
    const open = offencesOutsideQuotedBlocks('D', d);
    expect(open[0].length, '(d) an unterminated declared block reports nothing, so the tail is hidden').toBeGreaterThan(0);
    expect(open[0].join('\n'), '(d) the unterminated block is not refused by name').toContain(REFUSED_OPEN_QUOTE);
    expect(open[0].join('\n'), '(d) the refusal does not say the tail went unscanned').toContain('NOT scanned');
    // (e) an unterminated NON-declared block still reds on the offence, so the
    // hole belonged to the DECLARATION and not to the fence.
    const undeclaredOpen = offencesOutsideQuotedBlocks('E', e);
    expect(undeclaredOpen[1], '(e) a non-declared block was counted as exempt').toBe(0);
    expect(undeclaredOpen[0], '(e) the offence inside an undeclared block is not reported').toHaveLength(1);

    // GUARD DELETION, one deletion: without the end-of-input refusal, (d) goes
    // green again -- the control -- while (c) stays red.
    const withoutCheck = scanDocument('D', d, true, false, true);
    expect(withoutCheck[0], 'with the end-of-input refusal deleted (d) still reports, so the check is not what reports it').toStrictEqual([]);
    expect(scanDocument('C', c, true, false, true)[0], 'the deletion also changed (c), so it is not a pure deletion').toHaveLength(1);

    // Reachability, measured rather than assumed: no pack entry THIS LAW SCANS
    // has an odd fence count today, so the shape has no live instance -- it
    // arrives from a forgotten closing fence or a quoted transcript.
    //
    // ROUND 38, THE CHALLENGER'S F-68 (P2). The first version of this census
    // walked every `.md` in the pack with NO ownership routing, so a reviewer
    // report quoting ONE fence line reddened THIS package over bytes the
    // author may not edit -- the F-53/B-12 shape the scan arm below forbids in
    // its own words. And the sentence was FALSE for that class: a
    // reviewer-owned name is never scanned, so an odd fence count implies
    // nothing about it. Reproduced here on a pack COPY: the same bytes red
    // under `P5-CHALLENGE-deadbee.md` and under an author name alike. The
    // census now reads the names the SCAN reads, routed by the one shared
    // list, and says what the reader can do about it.
    if (existsSync(PACK)) {
      const exemptNames = reviewerOwned();
      const reviewerShaped = looksLikeReviewer();
      const odd: string[] = [];
      // ROUND 40, R38-02 (P3): the census counted only `.md` while the scan
      // below reads EVERY pack entry, so the subject was narrower than the
      // sentence. It now reads what the scan reads; a directory or an
      // unreadable entry falls out through `readable`, as it does there.
      for (const name of readdirSync(PACK)) {
        if (exemptNames.has(name) || reviewerShaped.test(name)) continue;
        const text = readable(join(PACK, name));
        // A binary is not a document; the law refuses one elsewhere, and this
        // census only counts fences.
        if (typeof text !== 'string') continue;
        // ROUND 39: the ONE raw-line fence reader, shared with the scan, so
        // the census cannot disagree with it about where a block ends.
        if (fenceLineCount(text) % 2 === 1) odd.push(name);
      }
      expect(
        odd,
        'an AUTHOR-OWNED pack document has an odd number of fence lines: close the fence in that document, or, if the odd line is inside a quotation, balance it — the end-of-input refusal above reports the same document by name when the scan runs',
      ).toStrictEqual([]);
    }

    // And the routing is armed, on a COPY, because the bytes it must not
    // touch are a reviewer's: the same odd-fence document is skipped under a
    // reviewer-shaped name and counted under an author name.
    const copy = mkdtempSync(join(tmpdir(), 'f68-'));
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    const oddBytes = ['line one', '```text f-50-quote', '$ echo quoted'].join('\n');
    const census = (names: string[]): string[] => {
      const exemptNames = reviewerOwned();
      const reviewerShaped = looksLikeReviewer();
      return names.filter((n) => !exemptNames.has(n) && !reviewerShaped.test(n));
    };
    writeFileSync(join(copy, 'P5-CHALLENGE-deadbee.md'), oddBytes);
    writeFileSync(join(copy, 'P5-NOTE-V.md'), oddBytes);
    // ROUND 40, R38-02: a non-`.md` author-owned entry, which the old census
    // could not see and the scan always could.
    writeFileSync(join(copy, 'P5-NOTE-V.txt'), oddBytes);
    const considered = census(readdirSync(copy));
    expect(considered.sort(), "the census reds over a reviewer's frozen bytes, which the author may not edit").toStrictEqual(['P5-NOTE-V.md', 'P5-NOTE-V.txt']);
    expect(
      census(readdirSync(copy)).filter((x) => x.endsWith('.txt')),
      'the census is narrower than the scan again: a non-.md author-owned entry is invisible to it',
    ).toStrictEqual(['P5-NOTE-V.txt']);

    // And the two knobs are each reachable from one arm only.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    const openDeleting = (here.match(/scanDocument\((?:[^()]|\([^()]*\))*true,\s*false,\s*true\)/g) ?? []).length;
    expect(openDeleting, 'a second caller deletes the end-of-input refusal: it must be an arm, counted here').toBe(2);
    // ROUND 40, R38-02: and no walk of the pack narrows its own subject by
    // file name, so the census and the scan read the same entries. The needle
    // is assembled, or it would count itself.
    const narrowing = ['readdirSync(PACK)', '.filter('].join('');
    expect(here.split(narrowing).length - 1, 'a pack walk filters the pack listing by name again: the census was narrower than the scan, which is R38-02').toBe(
      0,
    );
  });

  it('the declared quotation block is an exemption, and is armed like one', () => {
    // ROUND 35, THE COORDINATOR, after this law reddened on the round-35
    // records themselves and the fix was to declare the block: an exemption
    // owes three things, and a quotation block had none of them.
    const dir = mkdtempSync(join(tmpdir(), 'f61q-'));
    // Registered at creation, not at the end: a FAILING arm used to leak
    // its scratch directory, and for `f61-` that meant a live shim sitting
    // in /tmp until someone removed it by hand.
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'MARKER-QUOTED');
    const shim = join(dir, 'python3');
    writeFileSync(shim, `#!/bin/sh\nprintf executed-from-inside-a-quote > ${marker}\necho 1\n`);
    chmodSync(shim, 0o755);
    const attack = `${shim} tools/manifest-digests.py --dir d --check`;

    // ONE: the same attack line OUTSIDE a block reds, BY NAME. The exemption
    // has to be the declaration and nothing else about the line.
    const outside = offencesOutsideQuotedBlocks('doc', `Example: \`${attack}\``);
    expect(outside[0], 'the attack line outside a quotation block is not reported').toHaveLength(1);
    expect(outside[0][0], 'the attack line outside a block is reported without naming the refusal').toContain('REFUSED-UNCLASSIFIABLE-INTERPRETER');
    expect(existsSync(marker), 'the shim RAN while being reported outside a block').toBe(false);

    // TWO: the payload inside a declared block is not executed. The block is
    // exempt from the SCAN, and the scan is the only thing that spawns, so
    // the proof is the marker's absence and not the empty offence list.
    const quotedLive = ['```text f-50-quote', `$ ${attack}`, '```'].join('\n');
    expect(offencesOutsideQuotedBlocks('doc', quotedLive)).toStrictEqual([[], 1]);
    expect(existsSync(marker), 'THE LAW RAN A PAYLOAD IT HAD EXEMPTED: the marker file exists').toBe(false);

    // THREE: delete the recognition and the very same block reds, by name.
    // One deletion, in the one place the recognition lives.
    verdicts.clear();
    const deleted = scanDocument('doc', quotedLive, false, true, true);
    expect(deleted[1], 'the deletion still counted an exempt block').toBe(0);
    expect(deleted[0], 'with the declaration no longer recognised the block is still exempt, so the exemption is not what makes it exempt').toHaveLength(1);
    expect(deleted[0][0], 'the deletion reds without naming the refusal').toContain('REFUSED-UNCLASSIFIABLE-INTERPRETER');
    // Even redding, nothing ran: the refusal is a classification, not a spawn.
    expect(existsSync(marker), 'the deletion arm ran the payload it was scanning').toBe(false);

    // The payload must be LIVE, or all three arms above prove nothing.
    const live = spawnSync(shim, ['tools/manifest-digests.py'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    expect(live.status, 'the quoted payload does not run, so it is not a payload').toBe(0);
    expect(existsSync(marker), 'the quoted payload wrote no marker, so it is not live').toBe(true);

    // And `honourDeclaration` is false in the arms only: a live scan that
    // stopped honouring the declaration would red the pack, not pass quietly,
    // but the count is pinned so the parameter cannot grow a second meaning.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    // The needles are ASSEMBLED, or each one counts its own literal and the
    // arm reports one caller too many -- B-10's self-counting shape, for the
    // third time in this file.
    const honourNeedle = ['scanDocument(label,', 'text,', 'true,', 'true,', 'true)'].join(' ');
    const honouring = here.split(honourNeedle).length - 1;
    // Counted by SHAPE rather than by one spelling, so a differently written
    // deleting caller is counted too: any `scanDocument(...)` whose last
    // argument is `false`.
    const deleting = (here.match(/scanDocument\((?:[^()]|\([^()]*\))*false,\s*true,\s*true\)/g) ?? []).length;
    expect(honouring, 'the live wrapper that honours the declaration is no longer the only one').toBe(1);
    expect(deleting, 'a second caller deletes the declaration recognition: it must be an arm, counted here').toBe(1);
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
    // Registered at creation, not at the end: a FAILING arm used to leak
    // its scratch directory, and for `f61-` that meant a live shim sitting
    // in /tmp until someone removed it by hand.
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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
    // Registered at creation, not at the end: a FAILING arm used to leak
    // its scratch directory, and for `f61-` that meant a live shim sitting
    // in /tmp until someone removed it by hand.
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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
