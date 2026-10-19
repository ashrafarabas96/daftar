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
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

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

/**
 * ROUND 43 (ROUND 41'S REVIEW), THE CHALLENGER'S F-72 (P1, A FAIL-OPEN), AND
 * THE COORDINATOR'S RULING -- OPTION (a).
 *
 * `INVOCATION` is anchored on an INTERPRETER TOKEN, so a command line with no
 * `python` written on it matched nothing however runnable it was. And these
 * tools are runnable without one: all five carried `#!/usr/bin/env python3`
 * and `manifest-digests.py` was mode 755, so a reader who copied
 * `./tools/manifest-digests.py --check` ran the tool with `PYTHONPATH` and the
 * user site directory on `sys.path` -- F-50's own harm, and the thing `-I` is
 * here to force. Measured on the pattern as it stood before this round:
 *
 *   ./tools/manifest-digests.py --dir . --check                  -> 0 matches
 *   tools/manifest-digests.py --check                            -> 0 matches
 *   /abs/.../packages/billing/tools/manifest-digests.py --check  -> 0 matches
 *   python3 tools/manifest-digests.py --dir . --check             -> 1 match
 *
 * The ruling offered two fixes and preferred (a), because it makes the bare
 * form ISOLATED rather than forbidden: every tool's shebang is now
 * `#!/usr/bin/env -S python3 -I`, and this law verifies that claim BY
 * EXECUTION. `shebangIsolation` copies the tool's own shebang line verbatim to
 * the top of a scratch script that prints `sys.flags.isolated`, marks it
 * executable and RUNS it by path. There is no model here of how `env` splits
 * an `-S` line -- which is the same ruling that settled F-67 (`-X` names) and
 * F-69 (fences): derive from execution, never from a pattern that stands in
 * for another program.
 *
 * The subject set is DERIVED, per B-11: every file under `tools/` that a
 * reader can run -- an executable bit, or a shebang, since the other four were
 * one `chmod` from `manifest-digests.py`'s shape. Not a list of names.
 */
const REFUSED_LINES_NOT_ALL_TESTED = 'REFUSED-LINES-NOT-ALL-TESTED';
const REFUSED_CONTENT_NOT_ALL_READ = 'REFUSED-CONTENT-NOT-ALL-READ';
const REFUSED_DOCUMENTS_NOT_ALL_SCANNED = 'REFUSED-DOCUMENTS-NOT-ALL-SCANNED';
const REFUSED_FILE_NOT_READABLE = 'REFUSED-FILE-NOT-READABLE';
const REFUSED_TEXT_NOT_FROM_DISK = 'REFUSED-TEXT-NOT-FROM-DISK';
const REFUSED_SHEBANG_NOT_ISOLATED = 'REFUSED-SHEBANG-NOT-ISOLATED';
const REFUSED_SHEBANG_WOULD_NOT_RUN = 'REFUSED-SHEBANG-WOULD-NOT-RUN';
const REFUSED_RUNNABLE_WITHOUT_SHEBANG = 'REFUSED-RUNNABLE-WITHOUT-SHEBANG';

/**
 * Every file under `dir` that a reader can RUN, as a path relative to `dir`:
 * one with an executable bit, or one carrying a shebang (which is one `chmod`
 * away from the same thing, and a `chmod` is not a diff this law would see).
 */
const runnableFiles = (dir: string, prefix = ''): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__pycache__') continue;
    const p = join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...runnableFiles(p, rel));
      continue;
    }
    const executable = (st.mode & 0o111) !== 0;
    if (executable || readFileSync(p, 'latin1').startsWith('#!')) out.push(rel);
  }
  return out;
};

/** A file's shebang line, CR stripped, or '' when it has none. */
const shebangOf = (p: string): string => {
  const first = (readFileSync(p, 'utf8').split('\n')[0] ?? '').replace(/\r$/, '');
  return first.startsWith('#!') ? first : '';
};

const REFUSED_SHEBANG_NOT_CPYTHON = 'REFUSED-SHEBANG-DID-NOT-ANSWER-AS-CPYTHON';

const shebangVerdicts = new Map<string, { isolated: boolean; refusal?: string; executable?: string }>();

/**
 * Does this shebang line start an ISOLATED interpreter? MEASURED, never
 * modelled: the line is written verbatim above `print(sys.flags.isolated)`,
 * the script is marked executable, and the script is RUN by its own path in a
 * directory this law owns.
 *
 * F-61 holds: nothing a DOCUMENT supplies reaches `spawnSync`. The only input
 * is a shebang line read from a file in this repository -- the very claim
 * under test -- and the single program argument is the scratch path this law
 * has just written.
 */
const shebangIsolation = (shebang: string): { isolated: boolean; refusal?: string; executable?: string } => {
  const cached = shebangVerdicts.get(shebang);
  if (cached !== undefined) return cached;
  let out: { isolated: boolean; refusal?: string; executable?: string };
  if (shebang === '') {
    out = { isolated: false, refusal: REFUSED_RUNNABLE_WITHOUT_SHEBANG };
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'p5shebang-'));
    try {
      const script = join(dir, 'shebang-probe.py');
      // ROUND 44, R42-02 (P3), THE CHALLENGER'S: the probe used to print one
      // digit, so `#!/usr/bin/env -S sh -c "echo 1" --` was cleared as an
      // isolated CPython. The answer now has to come FROM PYTHON: the
      // implementation name, the version as three integers, and the resolved
      // interpreter path. What this closes is a shebang that does not start
      // CPython at all -- R42-02's class, a mistake. It does not close an
      // author who writes a shebang that echoes a convincing line on purpose;
      // the refusal name says what was measured, and a deceptive shebang is a
      // diff a reviewer reads, not a quantity this law can bound.
      // THE NONCE, AND WHAT IT IS NOT. ROUND 46, THE CHALLENGER'S R43-01 (P2):
      // I wrote that only an interpreter which EXECUTES THE BODY can print the
      // nonce. That was FALSE and it is retracted. The shebang's own command is
      // handed this file's PATH, so anything that can read the file can lift
      // the nonce out of it and echo it; the challenger measured exactly that
      // against this function -- `#!/usr/bin/env -S sh <path>/fake.sh`, two
      // lines of `sed` and `echo`, returned
      // `{"isolated":true,"executable":"/usr/bin/python3"}`. No challenge
      // written INTO the probe can separate "python ran the body" from
      // "something else read the challenge and answered it", because the same
      // program can read either channel.
      //
      // So the DECLARED LIMIT, in the same voice as R42-01 below: this law
      // verifies that a shebang STARTS AN ISOLATED CPYTHON, and it does not
      // defend against a shebang written to deceive it. The nonce stays
      // because it defeats the careless and the accidental -- a shell that
      // echoes a convincing line, which is R42-02's own case and still reds --
      // and it claims nothing more. A deliberately deceptive shebang is a diff
      // a reviewer reads, not a quantity this law can bound.
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
      writeFileSync(
        script,
        `${shebang}\nimport sys\nprint(sys.flags.isolated, sys.implementation.name, '.'.join(str(v) for v in sys.version_info[:3]), sys.executable, ${JSON.stringify(nonce)})\n`,
        'utf8',
      );
      chmodSync(script, 0o755);
      // ROUND 44, R42-01 (P3), THE CHALLENGER'S, DECLARED HERE BECAUSE IT IS A
      // SCOPE LIMIT AND NOT A BUG: `env -S` resolves `python3` through PATH,
      // and this probe runs under a PINNED `PATH=/usr/bin:/bin`. So a green
      // verdict is a statement about the `python3` THIS PATH resolves -- the
      // resolved path is carried out in `executable` and recorded -- and not
      // about whatever a reader's own PATH finds. The challenger measured a
      // shim first on PATH taking the `-I` and being able to drop it. It is
      // P3 because `-S python3 -I` is a complete fix for the harm this law
      // names and because someone who controls a reader's PATH controls
      // everything that reader runs; it is worth this sentence because a
      // WRITTEN `shimdir/python3` is refused by name here, so interpreter
      // identity is already a hazard this law takes seriously.
      const r = spawnSync(script, [], { encoding: 'utf8', timeout: 10_000, cwd: dir, env: { PATH: '/usr/bin:/bin', TMPDIR: dir } });
      const fields = (r.stdout ?? '').trim().split(/\s+/);
      const [isolated, implementation, version, executable, echoed] = fields;
      if (r.status !== 0 || fields.length !== 5 || (isolated !== '0' && isolated !== '1')) {
        // Refused, not skipped: a shebang this law cannot RUN is a shebang it
        // cannot clear, and an unreadable answer is not a green one.
        out = { isolated: false, refusal: `${REFUSED_SHEBANG_WOULD_NOT_RUN} ${shebang}` };
      } else if (
        echoed !== nonce ||
        implementation !== 'cpython' ||
        !/^3\.\d+\.\d+$/.test(version ?? '') ||
        executable === undefined ||
        !existsSync(executable)
      ) {
        out = { isolated: false, refusal: `${REFUSED_SHEBANG_NOT_CPYTHON} ${shebang} -> ${(r.stdout ?? '').trim().slice(0, 80)}` };
      } else {
        out = isolated === '1' ? { isolated: true, executable } : { isolated: false, refusal: `${REFUSED_SHEBANG_NOT_ISOLATED} ${shebang}`, executable };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  shebangVerdicts.set(shebang, out);
  return out;
};

/**
 * Runnable files under `dir` whose shebang does not start an isolated
 * interpreter, each named with the refusal that says why.
 *
 * A FUNCTION of the directory, so the arms can run the law itself over a
 * scratch tree -- a tool mode 755 with a shebang carrying no `-I`, a runnable
 * file with no shebang at all -- without touching the tools this pack ships.
 */
const shebangOffences = (dir: string): string[] => {
  const found: string[] = [];
  for (const rel of runnableFiles(dir)) {
    const v = shebangIsolation(shebangOf(join(dir, rel)));
    if (!v.isolated) found.push(`${rel}: ${v.refusal ?? REFUSED_SHEBANG_NOT_ISOLATED}`);
  }
  return found;
};

/**
 * One of the tools invoked DIRECTLY by path, with no interpreter token on the
 * line: `./tools/x.py`, `tools/x.py`, an absolute path.
 *
 * COMMAND POSITION only: the start of the logical line (after any
 * indentation, and after a `$`, `>` or `#` prompt), or after a `&&`, a `;` or
 * a pipe. A path written as an INTERPRETER'S ARGUMENT is therefore not matched
 * here -- `python3 -I tools/x.py` is `INVOCATION`'s business -- so the two
 * patterns do not count the same command twice. Armed both ways below.
 *
 * DECLARED SIMPLIFICATIONS, both in the false-RED direction or inert:
 *   - at least one `/` is required, so a bare `manifest-digests.py --check`
 *     is not matched. On a POSIX shell that spelling does not run the tool in
 *     the current directory at all; the day a document writes it, this comment
 *     is what has to change.
 *   - the tool is recognised by BASENAME, so a path into some other tree is
 *     judged by the shebang of the copy that ships here.
 */
const BARE_PATH = new RegExp(String.raw`(?:^|&&|\||;)\s*(?:[$>#]\s+)?((?:[A-Za-z0-9_.\-]*/)+(${TOOLS.join('|').replace(/\./g, '\\.')}))`, 'g');

/**
 * ROUND 44, THE CHALLENGER'S F-73 (P1, A FAIL-OPEN), AND THE COORDINATOR'S
 * RULING.
 *
 * Round 43's conservation law counted the lines the loop REACHED, and both of
 * those words were load-bearing in the wrong direction. The challenger found
 * two single edits on the live path, each leaving the whole suite green while
 * hiding an un-isolated command in an author-owned document that the same line
 * without its token reds on:
 *
 *   (A) blank the CONTENT, keep the count:
 *       `const probeLine = /f-51-quote/.test(line) ? '' : line;` and match on
 *       `probeLine`. `tested += 1` still runs, so tested === total.
 *   (B) drop the line INSIDE `logicalLines`, which is where `total` came
 *       from, so both sides of the comparison moved together.
 *
 * I reproduced both before changing anything: the planted line reds normally
 * (1 failed), and under each edit the suite is 23 passed with the offence
 * invisible. (B) is P7 R11's lesson in my own file -- a subject set derived
 * from a representation the subject can alter -- and my sentence "any skip
 * added to the live path reds it, whatever it is called and however it is
 * spelled" was FALSE for both spellings, which blocks on its own.
 *
 * So the invariant is now over the CONTENT the matchers actually read, and the
 * expectation is read from the RAW TEXT, never from `logicalLines`:
 *
 *   - `rawExpectation` splits the text itself and derives, with no help from
 *     `logicalLines`, how many logical lines it must produce and EXACTLY which
 *     characters those lines must carry, in order, WHITESPACE INCLUDED. It
 *     normalises only what the join rule itself defines, and the three things
 *     it defines are written out at the function: a trailing CR is dropped
 *     from each raw line, a trailing continuation backslash and the whitespace
 *     after it become one space, and a line carried into the one above it is
 *     trimmed at both ends. Nothing else is touched. All of it is measured
 *     AGAINST `logicalLines` over every shape that makes the joiner do
 *     something, so the derivation cannot drift from the function it predicts.
 *   - `matchesOf` is the only way a matcher is applied, and it records the
 *     very string it matches, character for character -- one argument, so
 *     there is no recording one string and matching another without editing
 *     this function, which is a visible change to the instrument and not a
 *     skip.
 *
 * ROUND 45, THE COORDINATOR'S CD-44-01 (P1, A FAIL-OPEN), is why the
 * comparison is by IDENTITY and not by count: round 44 compared how MANY
 * characters were read, so a substitution of the same length -- measured, in
 * the matcher's input and inside `logicalLines` alike -- left every number
 * equal and hid the offence. A blanked line, a dropped line, a substituted
 * line and a matcher that went missing are all differences now; a matcher
 * nobody declared is a surplus, because the test is equality.
 *
 * ROUND 47, THE COORDINATOR'S CD-46-01 (P1, A FAIL-OPEN), is why that identity
 * is over EVERY character and not over a projection of them. Round 45 recorded
 * and expected `nonSpaceOf(...)`, the non-whitespace characters alone, while
 * `INVOCATION` depends on the whitespace between the interpreter and the tool.
 * So `matchesOf(/f-51-quote/.test(line) ? line.replace(/\s+/g, '') : line,
 * INVOCATION)` on the live path changed the MATCH OUTCOME while leaving the
 * RECORDED string identical: the planted un-isolated command went unreported
 * at 23 passed. I reproduced it before changing anything. CD-44-01 said a
 * quantity is not an identity; CD-46-01 is the same sentence one step further
 * -- a PROJECTION is not an identity either, and any projection is defeated by
 * a change confined to its complement. There is no projection here now, which
 * is why `nonSpaceOf` survives only inside the arm that proves the old one
 * would have cleared these attacks.
 */
/**
 * The non-whitespace characters of a string, in order.
 *
 * THIS IS NOT PART OF THE LAW, and it must not go back into it. Round 45
 * recorded and expected this projection, and the coordinator's CD-46-01 (P1, a
 * fail-open) defeated it with an edit confined to the projection's complement:
 * collapsing the whitespace of the planted line changed what `INVOCATION`
 * matched and left this value identical, so the offence went unreported at 23
 * passed. It survives for exactly one purpose: the arm below hands the
 * collapsed and the whitespace-inserted spellings to `invariantOffences` and
 * shows BOTH that they red now and that their projections are equal to the
 * expectation's -- which is the measurement that the round-45 law cleared
 * them. Using it in `matchesOf` or `rawExpectation` reopens CD-46-01.
 */
const nonSpaceOf = (s: string): string => s.replace(/\s+/g, '');

/** How many matchers every line is read by. Equality, so a third one reds. */
const MATCHERS = 2;

/**
 * Does this line END IN A CONTINUATION?
 *
 * ROUND 48, THE COORDINATOR'S CD-47-02 (P2, A MEASURED-FALSE CLAIM): the test
 * used to be `/\\\s*$/` -- ANY trailing backslash -- and I had written that
 * the join rule does "three things and no others" and that the derivation
 * "cannot drift". Both sentences were FALSE, and the coordinator measured it:
 * a line ending in TWO backslashes followed by a blank line made the joiner
 * consume one backslash, leave `\\ ` behind, and RE-CHAIN on the residue, so
 * `logicalLines` collapsed three honest lines into one while the derivation
 * predicted two. `REFUSED-LINES-NOT-ALL-TESTED 2/3` and
 * `REFUSED-CONTENT-NOT-ALL-READ 12/13` ON AN HONEST DOCUMENT. It fails closed,
 * so it is a false RED and not a hole -- and a false RED on a real document is
 * still a defect, because the next author to meet it learns to distrust the
 * law.
 *
 * A trailing `\\` is an ESCAPED BACKSLASH, not a continuation. So a line
 * continues exactly when its trailing backslash run is ODD, which is what the
 * shell does and what the joiner's own one-backslash substitution assumes. The
 * ROUND 49, F-79, the challenger's: `rawExpectation` used to CALL this
 * predicate, so a one-line edit here moved the joiner and its own expectation
 * together and passed every pinned example. It counts the run itself now, and
 * an edit here is caught as a DISAGREEMENT between the two. I reproduced the
 * original drift and then ran a 300,000-case fuzz over pieces built from backslash runs of
 * one, two and three, blank lines, tabs, runs of spaces and bare CRs: 197
 * mismatches before, 0 after, and the fuzz is kept as an arm.
 */
const continuesLine = (s: string): boolean => {
  const run = /(\\+)\s*$/.exec(s);
  return run !== null && (run[1] ?? '').length % 2 === 1;
};

/**
 * What `logicalLines` must produce for this text, derived from the RAW TEXT
 * alone: the number of logical lines, and EXACTLY the characters they must
 * carry between them, in order, whitespace included.
 *
 * ROUND 49, F-80, the challenger's, and it is the second time this derivation
 * was WRONG rather than merely weak. It read each raw line's OWN ending and
 * decided from that whether the next line was swallowed. The joiner does not
 * work that way: it re-tests the LINE IT HAS BUILT, and a join can leave a
 * backslash at the end of it. A backslash, a space, a backslash and two
 * newlines joins TWICE and yields ONE logical line holding one space, where
 * this derivation predicted two lines carrying the backslash. Exactly three
 * strings of length five diverge, measured -- the same shape with a space, a
 * TAB and a CR in the middle -- and the previous round's "exhaustive" arm
 * stopped at length FOUR, so the bound I stated was true and the agreement a
 * reader would take from it was not. The arm below runs to length SEVEN now,
 * 335,923 strings, and the bound it states is the bound it ran.
 *
 * So this is a CHARACTER MACHINE over the whole text, and it is deliberately a
 * different implementation from the joiner it predicts: no split on newline,
 * no array of raw lines, its own parity count, and -- F-79 -- no call to
 * `continuesLine`. A predictor that called the same predicate moved with it.
 * The RULE is shared, because a predictor of some other rule would prove
 * nothing; the CODE is not.
 *
 * The rule, which is the joiner's and nothing besides --
 *
 *   1. a trailing CR is dropped where a raw line ends (and only a TRAILING
 *      one: a CR inside a line is content, and `logicalLines` keeps it);
 *   2. the line BUILT SO FAR continues when its trailing backslash run,
 *      looking past whitespace, is ODD -- a doubled backslash is an escaped
 *      backslash and not a continuation (CD-47-02) -- and that last backslash,
 *      with the whitespace after it, becomes exactly ONE SPACE;
 *   3. a raw line carried into the one above it arrives trimmed at both ends;
 *   4. and rule 2 is then applied AGAIN to the result, which is F-80.
 *
 * Every other character, space and tab included, is reproduced as it stands.
 * Anything beyond those four would be a projection, and a projection is what
 * CD-46-01 walked through.
 *
 * "Four things and no others" is a claim about a function, so it is tested as
 * one: the exhaustive arm compares this derivation against `logicalLines` on
 * every string of length 0 to 7 over the six characters that matter, and the
 * seeded fuzz adds longer documents with its corpus coverage counted. It was
 * 197 mismatches in 300,000 before CD-47-02, 0 after, and 3 in 9,331 at length
 * five before F-80.
 */
const rawExpectation = (text: string): { lines: number; content: string } => {
  // A trailing CR goes exactly where a raw line ends: before a newline, or at
  // the end of the text. Nothing else about a CR is touched.
  const s = text.replace(/\r(?=\n)/g, '').replace(/\r$/, '');
  const built: string[] = [];
  let current = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (ch !== '\n') {
      current += ch;
      i += 1;
      continue;
    }
    // At a newline, count the backslash run ending the line BUILT SO FAR,
    // looking past whitespace, by hand rather than through the predicate the
    // joiner uses (F-79).
    let end = current.length;
    while (end > 0 && /\s/.test(current[end - 1] ?? '')) end -= 1;
    let run = 0;
    while (end - run > 0 && current[end - run - 1] === '\\') run += 1;
    if (run % 2 === 1) {
      // An odd run: this newline is swallowed. The backslash and the
      // whitespace after it become one space, the next raw line arrives
      // trimmed, and the loop tests the RESULT again (F-80).
      let next = i + 1;
      while (next < s.length && s[next] !== '\n') next += 1;
      current = `${current.slice(0, end - 1)} ${s.slice(i + 1, next).trim()}`;
      i = next;
    } else {
      built.push(current);
      current = '';
      i += 1;
    }
  }
  built.push(current);
  return { lines: built.length, content: built.join('') };
};

/**
 * The conservation refusals, as FUNCTIONS of the counts, so an arm can run
 * them over their whole domain instead of trusting one call site: equal is the
 * only clean answer either way round, and anything else refuses by name. A
 * count stated as a law is tested as a function --
 * [[daftar-a-count-stated-as-a-law-is-tested-as-a-function]].
 */
const conservationRefusal = (label: string, tested: number, total: number): string | undefined =>
  tested === total ? undefined : `${label}: ${REFUSED_LINES_NOT_ALL_TESTED} ${tested}/${total}`;

/**
 * The content refusal, comparing the exact characters a matcher was handed with
 * the exact characters the raw text says it must see. CD-44-01: equality of
 * strings, not of counts, so a substitution that preserves the count is a
 * difference here. The message carries the two lengths and the index of the
 * FIRST divergence rather than the text itself, because a refusal that pastes
 * a document into a test log is unreadable and may itself carry a command.
 */
const contentRefusal = (label: string, read: string, expected: string): string | undefined => {
  if (read === expected) return undefined;
  let at = 0;
  while (at < read.length && at < expected.length && read[at] === expected[at]) at += 1;
  return `${label}: ${REFUSED_CONTENT_NOT_ALL_READ} ${read.length}/${expected.length} chars, first divergence at ${at}`;
};

/**
 * Both invariants of one scanned document, as ONE function returning what the
 * scan must report.
 *
 * ROUND 45, THE COORDINATOR'S CD-44-02 (P3): in round 44 each refusal was
 * pushed at its own site and DELETING EITHER PUSH left the committed suite
 * green -- a guard whose removal nothing notices. There is one push now, its
 * site is counted in this file by an arm, and this function is armed over its
 * own domain, so the guard cannot be removed silently.
 */
const invariantOffences = (label: string, tested: number, read: readonly string[], expected: { lines: number; content: string }): string[] => {
  const out: string[] = [];
  const lines = conservationRefusal(label, tested, expected.lines);
  if (lines !== undefined) out.push(lines);
  // Every matcher must have been handed the whole document, so a matcher that
  // went missing is a shortfall and a matcher nobody counted is a surplus.
  if (read.length !== MATCHERS) out.push(`${label}: ${REFUSED_CONTENT_NOT_ALL_READ} ${read.length} of ${MATCHERS} matchers read this document`);
  for (const seen of read) {
    const content = contentRefusal(label, seen, expected.content);
    if (content !== undefined) out.push(content);
  }
  return out;
};

const scriptIndexes = new Map<string, ReadonlyMap<string, string>>();

/** Basename -> path relative to `dir`, for every `*.py` under `dir`. */
const scriptsByName = (dir: string): ReadonlyMap<string, string> => {
  const cached = scriptIndexes.get(dir);
  if (cached !== undefined) return cached;
  const index = new Map<string, string>(pythonScripts(dir).map((s) => [s.split('/').pop() ?? s, s]));
  scriptIndexes.set(dir, index);
  return index;
};

/**
 * The verdict on a bare-path invocation of the tool named `name`: the shebang
 * of that tool, measured.
 *
 * The tool is resolved by BASENAME inside the tools directory this scan is
 * given. A document that writes a path into some other copy of the pack is
 * judged by the shebang of the copy that ships here, which is the one a
 * reviewer can read -- declared, because it is an assumption and not a
 * measurement.
 */
const bareVerdict = (name: string, toolsDir: string): { isolated: boolean; refusal?: string } => {
  const rel = scriptsByName(toolsDir).get(name);
  if (rel === undefined) return { isolated: false, refusal: `${REFUSED_RUNNABLE_WITHOUT_SHEBANG} ${name}` };
  return shebangIsolation(shebangOf(join(toolsDir, rel)));
};

/**
 * The directory names this law does not read, as ONE list, used by both the
 * walk and the independent enumeration below.
 *
 * A shared list moves both sides of a comparison together, which is exactly
 * the F-73 (B) shape -- so the list is itself a CLAIM, pinned to a literal by
 * an arm. Widening it reds rather than quietly exempting a subtree.
 */
const UNREAD_DIRS: readonly string[] = ['.git', 'node_modules', 'dist', '.next'];

/** Every file of the repository, excluding what is not ours to read. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (UNREAD_DIRS.includes(entry)) {
      continue;
    }
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/**
 * The repository's files, enumerated INDEPENDENTLY of `walk`.
 *
 * ROUND 47, F-76 (P1, A FAIL-OPEN), THE CHALLENGER'S: every invariant in this
 * law was PER DOCUMENT. Nothing bounded WHICH documents were read. The
 * repository half asserted only `scanned > 50` over a tree of some 1327 files,
 * and the counter incremented ABOVE the skip below it -- so a `continue` on a
 * path, placed after the counter, hid a real planted offence at 23 passed with
 * every character-identity invariant intact, and a filter inside `walk` hid it
 * too, moving the counter by one against a floor of 50.
 *
 * That is F-73 and F-74 one level up, and the same two lessons apply. P7 R11:
 * **an anchor must BOUND LOSS -- a literal total, a count equality -- not
 * witness survival**, and 50 out of 1327 is witness survival. F-67/F-69: a
 * derived set must not be derived from a representation the subject can alter,
 * so the expectation cannot come from the same `walk` call the loop consumes,
 * or a filter inside `walk` moves both sides at once.
 *
 * So this is a SECOND traversal, written differently on purpose -- an explicit
 * stack instead of recursion, `readdirSync` with file types instead of
 * `statSync` -- reading the same filesystem. A skip in either one is a
 * difference against the other, and MEASURED: a filter inside `walk` reds as a
 * document unread, a filter inside `treeFiles` reds as a document scanned but
 * never enumerated, and a `continue` on the path in the loop reds as a
 * document unread, each naming the path.
 *
 * THE DECLARED LIMIT, in R42-01's voice, because it cannot be bounded from
 * inside this file: the SAME filter written into BOTH traversals moves both
 * sides of the equality together and passes. I measured that too -- 23 passed.
 * It is two edits in two functions that share no line, in a diff a reviewer
 * reads, which is the bar this law holds everywhere else and not a claim that
 * no such edit exists. Nothing here claims the document set cannot be
 * narrowed; it claims that narrowing it in one place reds, by name, with the
 * path.
 */
const treeFiles = (root: string): string[] => {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() ?? root;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (UNREAD_DIRS.includes(entry.name)) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
};

/**
 * The document-set refusal: the labels actually handed to `scanLines` against
 * the labels the independent enumeration says must be handed to it, as a
 * FUNCTION of the two sets so an arm can run it over its own domain.
 *
 * Equality both ways. A document MISSING is the fail-open F-76 names; a
 * document SURPLUS means the two traversals disagree, which is a drift between
 * the instrument and its expectation and must be read, not ignored. The
 * refusal carries the counts and the first few names, so the reader is told
 * WHICH documents went unread rather than that some number moved.
 */
const documentRefusal = (expected: readonly string[], scanned: readonly string[]): string[] => {
  const got = new Set(scanned);
  const want = new Set(expected);
  const missing = expected.filter((l) => !got.has(l));
  const surplus = scanned.filter((l) => !want.has(l));
  const out: string[] = [];
  if (missing.length > 0) {
    out.push(`${REFUSED_DOCUMENTS_NOT_ALL_SCANNED} ${scanned.length}/${expected.length} documents, unread: ${missing.slice(0, 5).join(', ')}`);
  }
  if (surplus.length > 0) {
    out.push(
      `${REFUSED_DOCUMENTS_NOT_ALL_SCANNED} ${scanned.length}/${expected.length} documents, scanned but not enumerated: ${surplus.slice(0, 5).join(', ')}`,
    );
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
  // ROUND 42, R40-01 (P3), the challenger's: a CR at end of line defeated a
  // line test that anchored on `[ \t]*$`, so a CLOSED fence was reported as
  // unterminated and a reader would have added a closing fence that was
  // already there. The fence machine is gone with the exemption, but the
  // normalisation belongs here anyway, once, before any line is tested --
  // rather than in each test that might or might not tolerate a CR.
  const raw = text.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = 0; i < raw.length; i += 1) {
    const start = i;
    let line = raw[i] ?? '';
    while (continuesLine(line) && i + 1 < raw.length) {
      i += 1;
      line = `${line.replace(/\\\s*$/, ' ')}${(raw[i] ?? '').trim()}`;
    }
    out.push({ n: start + 1, line });
  }
  return out;
};

/** Offending lines in one text, as `path:line: text`. */
const offencesIn = (label: string, text: string, toolsDir: string = TOOLS_DIR): string[] => auditedScan(label, text, text, toolsDir).found;

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
 * ROUND 42, THE COORDINATOR'S CLASS RULING: THE DECLARED-QUOTATION EXEMPTION
 * IS GONE.
 *
 * Four fail-opens in a row (C-01, F-66, F-69 and the challenger's F-70, the
 * HTML-block one) all sat in the same place: the `f-50-quote` exemption, which
 * forced this law to decide which lines a READER sees as quoted — that is, to
 * MODEL a renderer it does not consult. CommonMark has more ways to swallow a
 * line than a reader of this file can hold in their head (§4.5 fences, §4.6
 * HTML blocks, container indentation), so each fix closed one subsection and
 * left the next open, in the same direction every time: green over a command
 * the reader can copy.
 *
 * So the exemption is DELETED. **This law now scans every line of every
 * author-owned document.** An author who needs to quote an attack line has two
 * ways to do it, both of which this file arms:
 *
 *   (a) NEUTRALISE it, by wrapping the interpreter token in angle brackets:
 *       `<python3> tools/manifest-digests.py --check`. That spelling is not an
 *       invocation to this law's own matcher — the arm below proves the
 *       neutralised form stays green and the raw form in the same position
 *       reds — and it is not a command a reader can copy and run either, which
 *       is the point of F-50.
 *   (b) CITE the reviewer-owned report by name and digest instead of copying
 *       the line. Reviewer files are already routed to the seal.
 *
 * What follows: the fence machine, the fence census and the renderer
 * differential are no longer enforcement, so they are deleted rather than left
 * standing as something a reader might mistake for a guard. The only fence
 * code left is the HISTORICAL reader below, `/^\s*```/` with joining before
 * recognition, reachable ONLY from `scanLines`'s `honourExemption` arm —
 * it exists so the deletion control can put the exemption back and show every
 * historical fixture going green-wrong. With no exemption in the live scan,
 * C-01, F-66, F-69 and F-70 are unconstructible.
 */
const FENCE = /^\s*```/;

/**
 * One document's un-isolated invocations.
 *
 * `honourExemption` is the DELETION CONTROL and nothing else: true restores the
 * historical exemption exactly as it stood before this round — the loose fence
 * reader, recognised on lines a continuation joiner has already rewritten —
 * so an arm can show that the exemption, not the scan, is what hid each
 * historical fixture. The live scan passes false and exempts nothing.
 */
/**
 * The ONLY way a matcher is applied to a line, and the thing that records what
 * was read: one argument, so the string recorded IS the string matched.
 * F-73 (A) -- feeding the matcher a blanked copy of the line while the line
 * counter still ran -- is not expressible through this function without
 * editing the function.
 *
 * CD-46-01: `s` is recorded VERBATIM. Recording any function of it, however
 * innocent -- and `nonSpaceOf` was the innocent one -- makes every edit inside
 * that function's kernel invisible here while the matcher, which reads the
 * whole string, behaves differently. The recorded string must be the matched
 * string, not a summary of it.
 */
let reads = new Map<RegExp, string[]>();
const matchesOf = (s: string, re: RegExp): RegExpMatchArray[] => {
  const seen = reads.get(re);
  if (seen === undefined) reads.set(re, [s]);
  else seen.push(s);
  return [...s.matchAll(re)];
};

/**
 * ROUND 43, R41-02 (P3), THE CHALLENGER'S: this is now the ONLY loop over
 * `matchAll`. There used to be three -- `offencesIn`, `scanDocument` and the
 * repository walk's own inline copy -- and with the exemption gone the first
 * two were the same function written twice. The third destructured `{ line }`
 * alone and reported `label:` with NO LINE NUMBER, which is the half that runs
 * in CI. Three bodies is three chances for a fix to land in two of them, which
 * is exactly how F-52 survived its round.
 *
 * ROUND 43, R41-01 (P2), THE CHALLENGER'S: `tested` is the CONSERVATION
 * COUNTER. The regression guard used to be a list of seven identifiers that
 * must not appear, and the challenger defeated it twice over -- a second
 * reader keyed on `f-51-quote` rather than `f-50-quote`, and the same
 * identifier declared as a function rather than as a `const` binding -- the
 * needle this arm looks for is the `const` form, so the other spelling of the
 * same name walked past it.
 * A name list cannot name what has not been written yet, which is
 * [[daftar-an-enumerated-exemption-moves-the-hole-from-shape-to-time]] again.
 * So the law is a conservation law instead. ROUND 45 REWRITES WHAT IT CLAIMS,
 * because the challenger's F-75 found the old sentence still standing here in
 * the present tense after I had retracted it 237 lines away, describing a
 * mechanism this file no longer has (`tested === logicalLines(text).length`) --
 * which is P4 R32 in my own file: moving a guard needs two sweeps, one for
 * sentences about its OUTCOME and one for sentences about its DISCIPLINE, and
 * they share no words. A reader who opened `scanLines` looking for skips was
 * told there were none to find.
 *
 * WHAT THIS LAW MEASURES, exactly:
 *   - `tested` against `rawExpectation(text).lines`: every logical line the
 *     RAW TEXT implies is reached by the matchers.
 *   - EVERY character each matcher was handed, whitespace included, compared
 *     for IDENTITY with the characters the raw text says it must see, in
 *     order, with no projection of either side.
 *   - the number of matchers that read the document.
 * So content WITHHELD from a matcher is caught, and so is content DISGUISED on
 * the way to it -- a reversal or a same-length substitution moves the sequence
 * even though it moves no count (F-74/CD-44-01, why this is an identity and
 * not a quantity), and collapsing or inserting whitespace moves the sequence
 * even though it moves no non-whitespace character (CD-46-01, why the identity
 * is over every character and not over the non-whitespace ones). What makes
 * that second sentence a measurement and not a hope is the arm that hands both
 * whitespace spellings to `invariantOffences` and asserts that their
 * non-whitespace projections are EQUAL to the expectation's: the attack that
 * walked through round 45 reds here, and it is the attack and not a cousin.
 *
 * WHAT IT DOES NOT MEASURE, and this is the whole of the list: a skip whose
 * predicate NO scanned line satisfies, which hides nothing until a document
 * carries such a line and refuses the moment one does. Nothing here claims
 * that every skip reds -- that sentence was measured false twice, and the two
 * counterexamples are named in the round histories above.
 */
const scanLines = (
  label: string,
  text: string,
  honourExemption: boolean,
  toolsDir: string = TOOLS_DIR,
): { found: string[]; tested: number; seen: number; read: string[] } => {
  const found: string[] = [];
  let inFence = false;
  let exempt = false;
  let tested = 0;
  let seen = 0;
  // The recorder is per scan, and `scanLines` is not reentrant: every caller in
  // this file scans one document at a time, which is what lets the reads of
  // this document be compared with this document's expectation.
  reads = new Map<RegExp, string[]>();
  for (const { n, line } of logicalLines(text)) {
    if (honourExemption) {
      if (FENCE.test(line)) {
        if (inFence) {
          inFence = false;
          exempt = false;
        } else {
          inFence = true;
          exempt = /f-50-quote/.test(line);
        }
        continue;
      }
      if (inFence && exempt) continue;
    }
    for (const m of matchesOf(line, INVOCATION)) {
      seen += 1;
      const v = verdictFor(m[1] ?? 'python3', m[2] ?? '');
      if (!v.isolated) found.push(`${label}:${n}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
    }
    // F-72: the same line, read for a tool invoked by its own path with no
    // interpreter token on it. The verdict is the tool's shebang, measured.
    for (const m of matchesOf(line, BARE_PATH)) {
      seen += 1;
      const v = bareVerdict(m[2] ?? '', toolsDir);
      if (!v.isolated) found.push(`${label}:${n}:${v.refusal === undefined ? '' : ` ${v.refusal}:`} ${line.trim()}`);
    }
    // The conservation counter increments LAST, after both matchers have read
    // the line -- so a `continue` placed anywhere in this body, before the
    // matchers or between them, takes the count below the total. Counting on
    // entry would have left a one-line gap: a skip written after the
    // increment would hide the line and keep the count whole.
    tested += 1;
  }
  // THE CONSERVATION LAW IS PART OF THE SCAN, not only of an arm. Every live
  // scan in this file -- the pack documents, the repository walk, every
  // fixture -- refuses by name when the loop above did not reach the matchers
  // with every logical line of the text it was given, or handed any matcher
  // characters other than the ones the raw text implies. So it is measured on
  // the real documents and not only on the shape fixture, and it catches a
  // skip ANYWHERE IN THIS BODY whose predicate some scanned line satisfies --
  // which is what it measures, and not the stronger thing the sentence here
  // used to claim (F-75).
  //
  // DECLARED LIMIT, and it is the honest one: a skip whose predicate NO
  // scanned line satisfies hides nothing today, so nothing can red on it. It
  // is UNMEASURED at runtime rather than a live hole, and the day a document
  // carries a line the skip matches, this refusal fires on that document. The
  // arm below measures exactly that pair.
  // ROUND 48, THE CHALLENGER'S ROUND-46 FINDING, as the coordinator ruled it:
  // THE AUDIT IS NO LONGER PERFORMED HERE. It used to be -- this function
  // computed its own conservation and content refusals and pushed them into
  // its own return value -- and an EARLY RETURN at the top of this body
  // therefore produced no offences AND no refusal about producing none, while
  // the caller recorded the label as scanned. All green. A function cannot
  // audit itself, because the edit that stops it scanning also stops it
  // auditing.
  //
  // So this function now only REPORTS what it did: the offences it found, how
  // many logical lines it reached, how many invocations it saw, and the exact
  // characters each matcher was handed. `auditedScan` below compares that
  // record with an expectation derived independently of this function, and an
  // early return here is a record that cannot match one.
  return { found, tested, seen, read: [...reads.values()].map((parts) => parts.join('')) };
};

/**
 * The audited scan, and the record of what it audited, SEALED IN ONE SCOPE.
 *
 * ROUND 49, THE COORDINATOR'S CD-48-01 (P1, a one-path fail-open). The caller
 * used to keep the record, and a caller can record a label it never scanned:
 * `if (text.includes(...)) { push(label); continue; }` gave 23 passed with a
 * planted document, because the document-set law was satisfied by a push the
 * caller made on its own authority.
 *
 * MY FIRST FIX WAS NOT ENOUGH AND I MEASURED IT FAILING. Moving the record to
 * a module-level binding and pushing to it inside the auditor left it writable
 * by every line in this file, so the same edit -- with the new name -- passed
 * again as soon as the external byte pin was updated alongside it. The comment
 * I had written there, that nothing a caller does can put a label in the
 * record, was FALSE. A false sentence about a guard is worse than the gap it
 * describes, so it is gone and this is what replaced it.
 *
 * The record is CLOSED OVER. `record` exists only inside this scope; the only
 * thing that pushes to it is the auditor itself; the outside world gets a
 * reset and a COPY. A label in the record was put there by the function that
 * audits, and that is enforced by SCOPE rather than by convention -- an edit
 * that fabricates an entry has to be written inside the auditor, which is
 * where the audit is and where the external byte pin sees it.
 *
 * The three independent readings a document gets, and why each is separate:
 *   - `scanLines` applies the matchers and REPORTS what it reached and read.
 *   - `rawExpectation` says what the matchers must have been handed, derived
 *     from the raw text with no help from `logicalLines`.
 *   - `expectationSource` is, for a caller holding a file, the bytes a SECOND
 *     reader found on disk (CD-47-01), so the expectation does not come from
 *     the string the scanner was handed. An in-memory fixture has no disk to
 *     disagree with, so it defaults to the text itself.
 *
 * An early return, a `continue`, a blanked line, a filtered path or a
 * projection in one of those paths is a disagreement between two of them, and
 * a disagreement is a refusal by name. What remains -- a caller that DISCARDS
 * what the auditor returned -- is not closable by another audit, and is caught
 * by the external byte pin instead.
 */
const { auditedScan, resetAuditRecord, auditedLabels } = (() => {
  const record: string[] = [];
  return {
    auditedScan: (
      label: string,
      text: string,
      expectationSource: string = text,
      toolsDir: string = TOOLS_DIR,
    ): { found: string[]; seen: number; tested: number } => {
      const scan = scanLines(label, text, false, toolsDir);
      const found = [...scan.found, ...invariantOffences(label, scan.tested, scan.read, rawExpectation(expectationSource))];
      // Recorded by the AUDITOR, after the audit has run.
      record.push(label);
      return { found, seen: scan.seen, tested: scan.tested };
    },
    resetAuditRecord: (): void => {
      record.length = 0;
    },
    /** A COPY: a caller may read what was audited and may not add to it. */
    auditedLabels: (): string[] => [...record],
  };
})();

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

/**
 * The bytes on disk, decoded -- read by a SECOND reader that shares NO HELPER
 * with `readable`.
 *
 * ROUND 48, THE COORDINATOR'S CD-47-01 (P1, A FAIL-OPEN): every invariant in
 * this law was over the text it was HANDED. Nothing bounded that text against
 * what is on disk. So ONE edit to the shared helper `readable` --
 * `t.includes('f-51-quote') ? '' : t` -- hid a planted offence at 23 passed
 * with every other law satisfied: the label was still recorded, so the
 * document-set law was content; `rawExpectation` derived from the SAME blanked
 * text, so the content identity was content; and neither traversal reads
 * content at all. I reproduced it before changing anything. It is not the
 * declared limit -- that is one edit in two independent paths; this was one
 * edit in one path that both sides happened to share.
 *
 * This reader opens the file itself, takes the bytes rather than asking for a
 * string, and decodes them here. It shares no line, no helper and no
 * try/catch with `readable`. The expectation is derived from THIS text, and
 * the text the law consumed is compared with it for equality, refusing by
 * name -- so blanking either one reds, and blanking the same way in both is
 * the general limit written down at the law.
 */
const diskText = (p: string): string | null => {
  try {
    return readFileSync(p).toString('utf8');
  } catch {
    return null;
  }
};

/**
 * The disk refusal: the text the law CONSUMED against the bytes a second
 * reader found on disk, as a function of the two so an arm can run it over its
 * domain. The message carries both lengths and the first divergence, never the
 * text, for the reason the content refusal does: a refusal that pastes a
 * document into a log is unreadable and may itself carry a command.
 */
const diskRefusal = (label: string, consumed: string, onDisk: string | null): string | undefined => {
  if (onDisk === null) {
    return `${label}: ${REFUSED_TEXT_NOT_FROM_DISK} the second reader could not read this file at all`;
  }
  if (consumed === onDisk) return undefined;
  let at = 0;
  while (at < consumed.length && at < onDisk.length && consumed[at] === onDisk[at]) at += 1;
  return `${label}: ${REFUSED_TEXT_NOT_FROM_DISK} ${consumed.length}/${onDisk.length} chars, first divergence at ${at}`;
};

describe('every written invocation of the pack tools is isolated', () => {
  it('finds no un-isolated invocation anywhere in the repository', () => {
    const offences: string[] = [];
    const binaries: string[] = [];
    const unreadable: string[] = [];
    // CD-48-01: the record belongs to the auditor. This loop resets it and
    // reads it; it does not write to it.
    resetAuditRecord();
    // F-76: the labels this loop ACTUALLY handed to `scanLines`, recorded so
    // the set can be compared with one derived independently of this loop and
    // of the walk that feeds it. A count cannot do this job: the honest `SELF`
    // skip already made the old counter count one file more than the law read,
    // which is why that counter could not be turned into a conservation law
    // where it stood.
    let seen = 0;
    for (const p of walk(REPO)) {
      const text = readable(p);
      const label = relative(REPO, p);
      // F-76: a file this law cannot read is REFUSED BY NAME, not skipped.
      // This used to be a bare `continue`, which is the one silent skip left
      // in this half -- and a silent skip is what every finding in this file
      // has been about.
      if (text === null) {
        unreadable.push(label);
        continue;
      }
      // F-57. A NUL byte is REFUSED by name, never skipped: one NUL used to
      // exempt a whole file from this law.
      if (text === BINARY) {
        if (!EXEMPT_BINARIES.has(label)) binaries.push(label);
        continue;
      }
      // Not this file: it quotes the defect on purpose, four lines above.
      //
      // By its EXACT repository path. Found while building B-10's before arm:
      // an `endsWith` skip is the same shape-keyed exemption B-10 is about,
      // and it skipped a copy of this file named
      // `__b10_before.test.ts`... wholesale. One hole of a class is enough.
      if (label === SELF) {
        continue;
      }
      // ROUND 43, R41-02 (P3), THE CHALLENGER'S: this walk used to carry its
      // own copy of the loop, destructuring `{ line }` alone and reporting
      // `label:` with NO LINE NUMBER -- and this is the half of the law that
      // runs in CI. ROUND 30's F-52 is the same shape: the continuation fix
      // went into the pack scans and not into this one, so a fix applied to
      // two of three call sites was not applied. One loop now, so the
      // repository half cannot drift from the pack half again, and an offence
      // here names `label:n:` like every other.
      // CD-47-01: the SECOND reader, before the scan, so the expectation the
      // scan checks itself against comes from disk and not from the string
      // `readable` chose to hand over.
      const onDisk = diskText(p);
      const scan = auditedScan(label, text, onDisk ?? text, TOOLS_DIR);
      seen += scan.seen;
      offences.push(...scan.found);
      // And the text the law consumed, against those same bytes, by name. One
      // edit to `readable` now reds twice: here, and through the content
      // identity whose expectation no longer shares a reader with it.
      const drifted = diskRefusal(label, text, onDisk);
      if (drifted !== undefined) offences.push(drifted);
    }
    expect(
      binaries,
      'a file in this repository holds a NUL byte, so this law cannot read it: name it in EXEMPT_BINARIES with the reason, which is a claim in the diff — do not widen the skip',
    ).toStrictEqual([]);
    for (const [name] of EXEMPT_BINARIES) {
      expect(existsSync(join(REPO, name)), `${name} is exempted as a binary but is no longer in the repository`).toBe(true);
    }
    expect(
      unreadable,
      `a file in this repository cannot be read at all, so this law never saw it: ${REFUSED_FILE_NOT_READABLE} — name why, which is a claim in the diff, and do not restore the silent skip`,
    ).toStrictEqual([]);
    // ROUND 47, F-76 (P1, a fail-open), THE CHALLENGER'S: the document SET is
    // now a conservation law, not a floor. The expectation comes from
    // `treeFiles`, a traversal written separately from `walk`, minus the two
    // exemptions this law NAMES -- `SELF`, and whatever `EXEMPT_BINARIES`
    // holds, which another arm pins at zero. Nothing discovered BY the loop is
    // subtracted, because an expectation the loop can edit is not an
    // expectation: a binary or an unreadable file reds above AND reds here.
    const expectedLabels = treeFiles(REPO)
      .map((p) => relative(REPO, p))
      .filter((l) => l !== SELF && !EXEMPT_BINARIES.has(l));
    // The vacuity bound belongs on the INDEPENDENT enumeration, where it
    // bounds the enumerator being empty, and it is no longer the law: the law
    // is the equality below. 50 out of a tree in the high hundreds was witness
    // survival, which P7 R11 says an anchor may not be.
    expect(expectedLabels.length, 'the independent enumeration found almost nothing, so the comparison below would be vacuous').toBeGreaterThan(50);
    expect(
      documentRefusal(expectedLabels, auditedLabels()),
      'the law did not read every document the repository holds: a skip on the PATH, or a filter inside the walk, is hiding a file from this law — the refusal above names which',
    ).toStrictEqual([]);
    expect(seen, 'no invocation of the four tools was found anywhere, so this law is vacuous — the tools or their names moved').toBeGreaterThan(0);
    expect(
      offences,
      'an un-isolated invocation is written down: a reader who copies it runs the tool with PYTHONPATH and the user site directory on sys.path, which is F-50',
    ).toStrictEqual([]);
    // ROUND 44: an EXPLICIT timeout, not a weakened assertion. This test reads
    // every file of the repository, and since round 45 it compares the exact
    // characters each matcher was handed with the characters the raw text
    // implies -- which is string building, and it costs. Measured on THIS
    // container, three runs each and a figure about nothing else: about 4.1 s
    // with the round-44 counter, about 2.5 s once that counter was
    // allocation-free, about 3.5-6.3 s now that the comparison is by identity.
    // Against vitest's 5 s default that timed out roughly once in four
    // full-suite runs -- a red that said nothing about the code under test.
    //
    // I kept string equality rather than a rolling digest on purpose: a law
    // under adversarial review has to be auditable by reading it, a digest
    // would have traded that for speed this test does not need, and the
    // refusal can say WHERE the content first diverged. Nothing is skipped:
    // every assertion above still has to pass, and the budget is for the
    // parallel load of a full run.
  }, 60_000);

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

  it('the declared-quotation exemption is GONE, so every hole it allowed is unconstructible', () => {
    // ROUND 42, THE COORDINATOR'S CLASS RULING, after the challenger's F-70.
    // Four fail-opens in a row sat in the `f-50-quote` exemption, because an
    // exemption over "what the reader sees as quoted" makes this law a MODEL
    // of a renderer it does not consult: C-01 (a backslash joined the closing
    // fence away), F-66 (an unterminated declared block), F-69 (four columns of
    // indentation, which CommonMark renders as content), F-70 (an HTML block,
    // §4.6, which swallows the lines after it: inside `<div>`, `<pre>`,
    // `<textarea>` or `<table>` the renderer emits the declaration and the
    // command as visible copyable text and opens no fenced block at all).
    //
    // The exemption is deleted. Every fixture below is now reported BY NAME,
    // and the deletion control puts the exemption back and shows each one
    // going green-wrong -- which is also the measurement of the fail-open each
    // of them was.
    const offence = 'shimdir/python3 tools/manifest-digests.py --check';
    const fixtures: [string, string][] = [
      // F-70, the challenger's four shapes, measured green at `59de9e5`.
      ['f70-div', ['<div>', '```text f-50-quote', offence, '```', '</div>'].join('\n')],
      ['f70-pre', ['<pre>', '', '```text f-50-quote', '', offence, '', '```', '', '</pre>'].join('\n')],
      ['f70-textarea', ['<textarea>', '', '```text f-50-quote', '', offence, '', '```', '', '</textarea>'].join('\n')],
      ['f70-table', ['<table>', '```text f-50-quote', offence, '```', '</table>'].join('\n')],
      // F-69: four columns, and a tab, which CommonMark expands to a
      // four-column tab stop.
      ['f69-four-spaces', ['Intro.', '', '    ```text f-50-quote', '', offence, '', '    ```', '', 'Outro.'].join('\n')],
      ['f69-tab', ['Intro.', '', '\t```text f-50-quote', '', offence, '', '\t```', '', 'Outro.'].join('\n')],
      // C-01: a trailing backslash on the last quoted line, and the double
      // backslash the challenger added, since the joiner replaced one per pass.
      ['c01-backslash', ['```text f-50-quote', '$ echo quoted \\', '```', '', offence, '', '```text', '```'].join('\n')],
      ['c01-two-backslashes', ['```text f-50-quote', '$ echo quoted \\\\', '```', '', offence, '', '```text', '```'].join('\n')],
      // ROUND 48, CD-47-02: a backslash RUN before the fence, written ODD so
      // it is still a continuation under the corrected parity rule. The
      // two-backslash spelling above is kept as a LIVE fixture -- the offence
      // reds there too -- but it is no longer a C-01 control, and the arm
      // below pins exactly why.
      ['c01-three-backslashes', ['```text f-50-quote', '$ echo quoted \\\\\\', '```', '', offence, '', '```text', '```'].join('\n')],
      // F-66: a declared block that is never closed.
      ['f66-unterminated', ['Intro.', '', '```text f-50-quote', '$ echo quoted', '', offence].join('\n')],
      // And the plainest shape of all, which the exemption was written for:
      // the offence INSIDE a well-formed declared block. It reds too now.
      ['inside-a-declared-block', ['```text f-50-quote', offence, '```'].join('\n')],
    ];
    for (const [label, text] of fixtures) {
      const found = offencesIn(label, text);
      expect(found, `${label}: the offence is not reported, so something still exempts it`).toHaveLength(1);
      expect(found[0], `${label}: the offence is reported without naming the refusal`).toContain(REFUSED_INTERPRETER);
    }

    // THE DELETION CONTROL: put the exemption back -- the historical reader,
    // loose fence and joining before recognition -- and every fixture that
    // the exemption used to hide goes GREEN-WRONG. That is each fail-open
    // executed rather than described. `inside-a-declared-block` is the
    // baseline the exemption was built for, and the F-70 shapes are the ones
    // the ruling names.
    for (const label of [
      'f70-div',
      'f70-pre',
      'f70-textarea',
      'f70-table',
      'f69-four-spaces',
      'f69-tab',
      'c01-backslash',
      'c01-three-backslashes',
      'f66-unterminated',
      'inside-a-declared-block',
    ]) {
      const text = fixtures.find(([l]) => l === label)?.[1] ?? '';
      expect(
        scanLines(label, text, true).found,
        `${label}: restoring the exemption no longer hides the offence, so the exemption is not what hid it`,
      ).toStrictEqual([]);
    }

    // AND THE ONE CONTROL THE PARITY FIX TOOK AWAY, pinned rather than
    // quietly dropped. `c01-two-backslashes` used to go green-wrong under the
    // restored exemption: the old joiner treated a trailing `\\` as a
    // continuation, swallowed the fence-closing line into the quoted one, and
    // left the block OPEN so the offence below it sat inside an exempt region.
    // CD-47-02 corrected the parity -- a trailing `\\` is an escaped
    // backslash, not a continuation -- so that spelling no longer joins, the
    // fence closes, and the exemption CANNOT hide it. The C-01 class is still
    // controlled by `c01-backslash` and `c01-three-backslashes`, both odd
    // runs. This assertion is the opposite direction from the loop above, and
    // it exists so that a reader who comes looking for the two-backslash
    // control finds out what happened to it instead of finding nothing.
    expect(
      scanLines('c01-two-backslashes', fixtures.find(([l]) => l === 'c01-two-backslashes')?.[1] ?? '', true).found,
      'the restored exemption hides the two-backslash shape again, which means the continuation parity has regressed to the pre-CD-47-02 rule',
    ).toHaveLength(1);

    // NEUTRALISATION, option (a) of the ruling, pinned in both directions: the
    // documented spelling wraps the interpreter token in angle brackets, which
    // this law's own matcher does not read as an invocation, and the RAW
    // spelling in the SAME position reds. So an author can still show the
    // attack without routing a reader to a runnable command.
    const neutralised = '<shimdir/python3> tools/manifest-digests.py --check';
    expect(offencesIn('neutral', neutralised), 'the neutralised spelling is read as an invocation, so there is no way to quote an attack line').toStrictEqual(
      [],
    );
    expect(offencesIn('raw', offence), 'the raw spelling in the same position does not red, so the neutralisation arm proves nothing').toHaveLength(1);
    expect(offencesIn('neutral-plain', '<python3> tools/status-block.py --dir d'), 'the plain neutralised spelling is read as an invocation').toStrictEqual([]);
    expect(offencesIn('raw-plain', 'python3 tools/status-block.py --dir d'), 'the plain raw spelling does not red').toHaveLength(1);

    // R40-01 (P3), the challenger's: a CRLF document used to red for a cause
    // that was not true -- the closer test required `[ \t]*$`, which `\r`
    // defeats, so a CLOSED fence was reported as unterminated and a reader
    // would add a closing fence that was already there. With the fence machine
    // gone the structural read is only the continuation joiner, and `\r` is
    // stripped before any line test. Armed both ways.
    expect(offencesIn('crlf', `Intro.\r\n\r\n${offence}\r\n`), 'a CRLF document hides the offence').toHaveLength(1);
    expect(
      offencesIn('crlf-continuation', 'python3 \\\r\n    tools/manifest-digests.py --check'),
      'a CRLF continuation is no longer joined, so the offence split across two lines is invisible',
    ).toHaveLength(1);
    expect(
      offencesIn('crlf-isolated', 'python3 -I \\\r\n    tools/manifest-digests.py --check'),
      'a CRLF continuation of an ISOLATED command reds, so the join is not reading the halves separately',
    ).toStrictEqual([]);

    // And the in-file counts: the exemption is reachable from ARMS ONLY. Two
    // live callers pass false -- the wrapper every pack scan goes through, and
    // the repository walk, which needs the match count as well as the
    // offences -- and one arm passes true.
    //
    // ROUND 43, R41-01, THE CHALLENGER'S CORRECTION OF MY OWN SENTENCE. This
    // comment used to say "needles assembled, or each counts its own literal".
    // That was FALSE of the seven-name list below: `liveNeedle` and
    // `fenceTests` are assembled, the seven names are plain literals in an
    // array, and the reason the arm does not self-count is that the needle
    // carries a `const ` prefix which the literals do not. Outcome right,
    // mechanism wrongly stated, which is the kind of sentence that costs a
    // reader their round when they audit B-10 compliance against it.
    //
    // These counts are KEPT, but they are no longer the regression guard: a
    // list of names cannot name a reader that has not been written, and the
    // challenger walked straight past this one twice (a second exemption keyed
    // on `f-51-quote`, and a deleted name re-declared as a function rather
    // than as a `const` binding, which is the only form these needles read).
    // The guard is the CONSERVATION LAW in the test below, which is derived
    // from execution. CD-46-02 (P3): this sentence used to end "and reds on
    // any skip under any name", which the law's own statement had already
    // recorded as MEASURED FALSE -- a skip whose predicate no scanned line
    // satisfies hides nothing but reds nothing either. What the law measures,
    // and the one thing it does not, is written out where it is defined.
    const here = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    // ROUND 48: there is exactly ONE unexempted call to the scanner now, and
    // it is inside `auditedScan` -- the wrapper that performs the audit the
    // scanner is no longer allowed to perform on itself. A second one would be
    // a document scanned without being audited, which is the shape of the
    // challenger's round-46 finding.
    const liveNeedle = ['scanLines(label,', 'text,', 'false,'].join(' ');
    expect(
      here.split(liveNeedle).length - 1,
      'the unexempted scanner call is not the single one counted here: a document is being scanned outside the wrapper that audits it',
    ).toBe(1);
    // And every caller that reads a document goes through that wrapper. Three
    // sites, each named: `offencesIn`, which the fixtures and the pack scan's
    // own assertions use; the repository walk, which passes the bytes a second
    // reader found on disk; and the pack scan, which passes the same. A fourth
    // would be a document read by a path this count does not know about.
    const auditedSite = new RegExp(['auditedScan\\(', '(?:label|name),'].join('\\s*'), 'g');
    expect(
      (here.match(auditedSite) ?? []).length,
      'the live document callers are not the three counted here: a document is being read by a path this count does not know about',
    ).toBe(3);
    const exempting = (here.match(/scanLines\((?:[^()]|\([^()]*\))*,\s*true\)/g) ?? []).length;
    // Three arms pass true, all in this file and all named: this test's
    // deletion control, the conservation law's control -- which needs the one
    // path that skips lines, in order to show its counter can fall -- and the
    // arm showing that same control is not itself refused for testing fewer
    // lines, which would make it useless as a control.
    expect(exempting, 'a further caller honours the exemption: it must be an arm, counted here').toBe(3);
    const fenceTests = ['FENCE', '.test('].join('');
    expect(
      here.split(fenceTests).length - 1,
      'the fence reader is asked somewhere other than the exemption path: there is no fence logic left in this law',
    ).toBe(1);
    // The fence census, the CommonMark fence rules and the renderer
    // differential are DELETED, not demoted: nothing here may look like a
    // guard when the exemption it guarded is gone. Form-keyed, as the
    // challenger showed -- it is the conservation law that closes the class.
    for (const gone of ['fenceDelimiterLines', 'fencedBodyLines', 'rendererFencedBodyLines', 'rendererLexer', 'fenceOpener', 'fenceCloser', 'indentColumns']) {
      expect(here.includes(`const ${gone} =`), `${gone} is back: the fence model was deleted with the exemption it served`).toBe(false);
    }
  });

  it('F-72: a tool run by its own path runs ISOLATED, and the bare form is visible to this law', () => {
    // ROUND 43, THE CHALLENGER'S F-72 (P1, a fail-open), under the
    // coordinator's ruling, option (a): make the bare form isolated rather
    // than forbidden, and verify the shebang BY EXECUTION.
    //
    // THE LIVE LAW. Every runnable file under `tools/` -- derived from the
    // tree, not listed -- starts an isolated interpreter.
    expect(
      shebangOffences(TOOLS_DIR),
      'a tool a reader can run does not start an isolated interpreter: a copied `./tools/x.py` would run with PYTHONPATH and the user site directory on sys.path, which is F-50',
    ).toStrictEqual([]);
    // Non-vacuity, twice: the derivation finds files at all, and it finds
    // every `*.py` this pack ships -- so the law cannot pass by looking at an
    // empty set, and `runnableFiles` cannot narrow to the one tool that
    // happens to carry an executable bit.
    expect(runnableFiles(TOOLS_DIR).length, 'the derivation found no runnable file, so this law measured nothing').toBe(SCRIPTS.length);
    expect(SCRIPTS.length, 'there are no tools to measure').toBeGreaterThan(3);

    // THE INSTRUMENT, armed both ways on the two shebangs that matter. This is
    // execution, not a reading of how `env -S` splits a line.
    expect(shebangIsolation('#!/usr/bin/env -S python3 -I').isolated, 'the shebang this round installs does NOT isolate, measured').toBe(true);
    const old = shebangIsolation('#!/usr/bin/env python3');
    expect(old.isolated, 'the shebang every tool carried before this round is cleared as isolated').toBe(false);
    expect(old.refusal, 'the old shebang is refused without naming why').toContain(REFUSED_SHEBANG_NOT_ISOLATED);
    // A shebang that cannot run is REFUSED by its own name, never skipped.
    const broken = shebangIsolation('#!/nonexistent/interpreter');
    expect(broken.isolated, 'a shebang that cannot run was cleared').toBe(false);
    expect(broken.refusal, 'an unrunnable shebang is not refused by name').toContain(REFUSED_SHEBANG_WOULD_NOT_RUN);

    // ROUND 44, R42-02 (P3), THE CHALLENGER'S: the probe used to accept any
    // process that printed `1`, so a shebang that starts a SHELL was cleared
    // as an isolated CPython. The answer has to come from python now.
    for (const [shebang, why] of [
      ['#!/usr/bin/env -S sh -c "echo 1" --', "the challenger's own: a shell that prints the digit and never runs the tool"],
      ['#!/usr/bin/env -S sh -c "echo 1 cpython 3.13.16 /usr/bin/python3" --', 'the same shell, imitating the whole answer'],
    ] as [string, string][]) {
      const v = shebangIsolation(shebang);
      expect(v.isolated, `cleared as an isolated CPython: ${why}`).toBe(false);
      expect(v.refusal, `refused without naming why: ${why}`).toBeDefined();
    }
    // The second of those is a DELIBERATELY DECEPTIVE shebang rather than a
    // mistake, and it was CLEARED when I first armed it -- echoing a whole
    // convincing answer line was enough. The nonce refuses THAT shebang,
    // because it cannot guess a value written microseconds ago. It does not
    // refuse a shebang that READS the probe file it is handed and lifts the
    // nonce out, which the challenger measured against this very function
    // (R43-01), and the limit is declared at the probe rather than claimed
    // away here. What is measured is the careless case; the deceptive one is
    // bounded by review, not by this law.

    // ROUND 44, R42-01 (P3): a green verdict is a statement about the
    // `python3` that THIS pinned PATH resolves, and the law now carries that
    // path out so a record can name it rather than implying universality.
    const resolved = shebangIsolation('#!/usr/bin/env -S python3 -I');
    expect(resolved.executable, 'the verdict does not say which interpreter answered').toBeDefined();
    expect(existsSync(resolved.executable ?? ''), 'the interpreter the probe reports does not exist').toBe(true);
    expect(resolved.executable ?? '', 'the reported interpreter is not an absolute path').toMatch(/^\//);

    // THE BARE FORM IS SEEN, in the three spellings the challenger measured as
    // invisible -- and each is GREEN now only because the shebang isolates.
    for (const form of [
      './tools/manifest-digests.py --dir . --check',
      'tools/manifest-digests.py --check',
      `${join(TOOLS_DIR, 'manifest-digests.py')} --check`,
      '    ./tools/status-block.py --dir d',
      '$ ./tools/seal-check-run.py --dir p --tests t',
      'cd somewhere && ./tools/context-sites.py --dir d --tests t',
    ]) {
      expect(scanLines('fixture', form, false).seen, `the bare-path form is still invisible: ${form}`).toBe(1);
      expect(offencesIn('fixture', form), `a bare-path invocation of an isolating tool is reported: ${form}`).toStrictEqual([]);
      // THE DELETION CONTROL ON THE MATCHER: F-72 itself. The interpreter
      // pattern alone -- the whole of this law's reach before this round --
      // MISSES every one of these forms.
      expect(matchCount(form, INVOCATION), `the interpreter pattern already matched this form, so this arm proves nothing: ${form}`).toBe(0);
    }
    // And the two patterns do not count one command twice: a path written as
    // an interpreter's argument belongs to `INVOCATION` alone.
    expect(scanLines('fixture', 'python3 -I tools/manifest-digests.py --check', false).seen, 'an interpreter invocation is counted twice').toBe(1);
    expect(scanLines('fixture', '$ python3 tools/manifest-digests.py --check', false).seen, 'a prompted interpreter invocation is counted twice').toBe(1);
    expect(offencesIn('fixture', 'see tools/manifest-digests.py for the digest table'), 'a tool named in prose, not in command position, reds').toStrictEqual(
      [],
    );

    // THE OFFENCE DIRECTION, on a scratch tools tree this law owns: the tools
    // as they stood before this round -- the old shebang, and mode 755 on the
    // one the challenger measured. `shebangOffences` names each, and a
    // document line invoking one by bare path REDS.
    const scratch = mkdtempSync(join(tmpdir(), 'f72-'));
    try {
      for (const rel of SCRIPTS) {
        const dest = join(scratch, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, `#!/usr/bin/env python3\nimport sys\nprint(sys.flags.isolated)\n`, 'utf8');
      }
      chmodSync(join(scratch, 'manifest-digests.py'), 0o755);
      const offences = shebangOffences(scratch);
      expect(offences.length, 'the pre-round tools pass the shebang law, so it is not measuring the shebang').toBe(SCRIPTS.length);
      for (const o of offences) expect(o, 'an offending tool is reported without the refusal that says why').toContain(REFUSED_SHEBANG_NOT_ISOLATED);
      expect(
        offences.some((o) => o.startsWith('manifest-digests.py:')),
        'the mode-755 tool the challenger measured is not among the offences',
      ).toBe(true);
      // The document line, scanned against that tree: the bare path reds, by
      // name, and says which line.
      const found = scanLines('P5-NOTE-X.md', ['Intro.', '', './tools/manifest-digests.py --dir . --check'].join('\n'), false, scratch).found;
      expect(found, 'a bare-path invocation of a tool whose shebang does not isolate is not reported').toHaveLength(1);
      expect(found[0], 'the offence does not name the refusal').toContain(REFUSED_SHEBANG_NOT_ISOLATED);
      expect(found[0], 'the offence does not say which line').toContain('P5-NOTE-X.md:3:');

      // A runnable file with NO shebang is refused by its own name, not
      // skipped: an executable bit with nothing to interpret it is still
      // something a reader can try to run.
      const bare = join(scratch, 'no-shebang');
      writeFileSync(bare, 'echo nothing\n', 'utf8');
      chmodSync(bare, 0o755);
      expect(runnableFiles(scratch), 'a file with an executable bit and no shebang is not in the derived set').toContain('no-shebang');
      expect(
        shebangOffences(scratch).some((o) => o.startsWith('no-shebang:') && o.includes(REFUSED_RUNNABLE_WITHOUT_SHEBANG)),
        'a runnable file with no shebang is skipped instead of refused by name',
      ).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('F-73: the live scan READS every character of every logical line, and the expectation is not its own', () => {
    // ROUND 43, R41-01 (P2), THE CHALLENGER'S. The regression guard was a
    // list of seven identifiers, and it was keyed to one INSTANCE and one
    // SPELLING: the challenger added a second declared-quotation reader to the
    // live branch keyed on `f-51-quote`, left the control path untouched, and
    // got 298 passed with eslint rc 0 -- while `f-51-quote` hid an offence
    // that `f-50-quote` in the same document reported. The absence arm was
    // form-keyed too: the `const` form of a deleted name reds and the
    // `function` form of the very same name
    // passes.
    //
    // ROUND 44, F-73 (P1, a fail-open), THE CHALLENGER'S: that law counted the
    // lines the loop REACHED, against a total it read from `logicalLines`, and
    // both halves were exploitable in one edit -- blank the content and keep
    // the count, or drop the line inside `logicalLines` so both sides move
    // together. My sentence here used to say "any skip added to the live path
    // reds it, whatever it is called and however it is spelled". That was
    // MEASURED FALSE for two spellings, and a reader sent to it stops auditing
    // the live path, so it is replaced by what the law now actually measures:
    //
    //   - every logical line the RAW TEXT implies is reached by the matchers
    //     (`tested` against `rawExpectation(text).lines`), and
    //   - each of the `MATCHERS` matchers was handed EXACTLY the characters
    //     those lines carry, whitespace included, in order -- the strings
    //     recorded verbatim inside `matchesOf`, which is the only way a
    //     matcher is applied, compared for identity with
    //     `rawExpectation(text).content`. CD-46-01: it was the non-whitespace
    //     characters here until round 47, and a whitespace-only disguise
    //     walked through the gap.
    //
    // What that leaves UNMEASURED is stated below and unchanged: a skip whose
    // predicate no scanned line satisfies.
    //
    // The fixture carries every structural shape I can name that has ever been
    // used to hide a line from this law, so the law is measured where the
    // holes were: fences open and closed, a declared quotation block, the four
    // F-70 HTML blocks, four-column and tab indentation, a continuation, a
    // table, a list, a block quote, a heading and a bare URL.
    const shapes = [
      '# Heading',
      '',
      '```text f-50-quote',
      'quoted body',
      '```',
      '',
      '    four columns of indentation',
      '\ta tab',
      '',
      '<div>',
      'raw html body',
      '</div>',
      '<pre>',
      'pre body',
      '</pre>',
      '<textarea>',
      'textarea body',
      '</textarea>',
      '<table>',
      '<tr><td>cell</td></tr>',
      '</table>',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '- a list item',
      '  - nested',
      '',
      '> a block quote',
      '',
      'a continuation \\',
      '    of one logical line',
      '',
      'https://example.invalid/not-a-command',
      '',
    ].join('\n');
    const total = logicalLines(shapes).length;
    expect(total, 'the fixture collapsed to nothing, so this arm would pass over an empty document').toBeGreaterThan(30);
    expect(
      scanLines('conservation', shapes, false).tested,
      'the live scan did not test every logical line: something on the live path is skipping lines, and this arm does not care what it is called',
    ).toBe(total);

    // THE DELETION CONTROL for the counter itself: the one path that DOES skip
    // lines -- the historical exemption, behind its arm flag -- must take the
    // count below the total. A counter that cannot fall is not a measurement.
    expect(
      scanLines('conservation', shapes, true).tested,
      'restoring the exemption does not reduce the tested count, so `tested` is not measuring what the live path reaches',
    ).toBeLessThan(total);

    // And the same fixture through the live scan reports nothing, so the
    // conservation count above is not being bought with a false RED.
    expect(offencesIn('conservation', shapes), 'the shape fixture itself reports an offence').toStrictEqual([]);

    // THE REFUSAL ITSELF, as a function over its whole domain rather than at
    // one call site: equal is the only clean answer, short refuses by name,
    // and the refusal carries both counts so a reader knows how many lines
    // went missing. N and N-1 for several N, and the degenerate N = 0.
    for (const n of [0, 1, 2, 17]) {
      expect(conservationRefusal('doc', n, n), `${n} of ${n} lines tested is refused`).toBeUndefined();
      const short = conservationRefusal('doc', n, n + 1);
      expect(short, `${n} of ${n + 1} lines tested is cleared`).toBeDefined();
      expect(short, 'the refusal does not name itself').toContain(REFUSED_LINES_NOT_ALL_TESTED);
      expect(short, 'the refusal does not say how many lines were tested').toContain(`${n}/${n + 1}`);
    }
    // It is the LIVE scan that consults it: the refusal reaches the offence
    // list of a document, which is what the pack scan and the repository walk
    // read. Measured by the deletion control above, where the exemption path
    // tests fewer lines than the document has.
    expect(
      scanLines('control', shapes, true).found.some((o) => o.includes(REFUSED_LINES_NOT_ALL_TESTED)),
      'the exemption arm is itself refused for testing fewer lines, so the control cannot show what the exemption hid',
    ).toBe(false);

    // F-73's expectation is only worth anything if it PREDICTS `logicalLines`
    // without consulting it. Measured on every shape that makes the joiner do
    // something, including the degenerate ones: if the prediction and the
    // function ever disagree, the live refusal fires on a real document, so
    // this arm is what keeps a raw-derived total honest rather than merely
    // independent.
    for (const [why, text] of [
      ['the shape fixture', shapes],
      ['an empty document', ''],
      ['one line, no newline', 'python3 -I tools/status-block.py --dir d'],
      ['a trailing backslash at end of input', 'a \\'],
      ['a chain of continuations', 'a \\\nb \\\nc'],
      ['a continuation onto a blank line', 'a \\\n\nb'],
      ['CRLF throughout', 'a\r\nb \\\r\n    c\r\n'],
      ['two backslashes', 'a \\\\\nb'],
      ['nothing but newlines', '\n\n\n'],
      // CD-46-01's shapes: now that the expectation carries whitespace, every
      // place the joiner touches whitespace has to be predicted exactly, and
      // every place it does not has to be left alone exactly.
      ['leading and trailing spaces, no join', '   a   \n  b  '],
      ['tabs and runs of spaces', '\ta  \t b\t\n   \t'],
      ['whitespace after the continuation backslash', 'a \\   \n   b   '],
      ['a continuation with nothing before the backslash', '\\\nb'],
      ['a CR in the MIDDLE of a line, which is content', 'a\rb\nc'],
      ['a line that is only whitespace', 'a\n   \t  \nb'],
      ['a chain whose carried lines are indented', 'a \\\n    b \\\n\t\tc'],
    ] as [string, string][]) {
      const lines = logicalLines(text);
      const predicted = rawExpectation(text);
      expect(predicted.lines, `${why}: the raw-derived line count does not predict logicalLines`).toBe(lines.length);
      expect(predicted.content, `${why}: the raw-derived characters do not predict what logicalLines carries, in order`).toBe(
        lines.map((l) => l.line).join(''),
      );
    }

    // ROUND 48, THE COORDINATOR'S CD-47-02 (P2, A MEASURED-FALSE CLAIM): the
    // nine named shapes above were not enough, and the sentence they were
    // meant to support -- that the join rule does "three things and no others"
    // and that this derivation "cannot drift" -- was FALSE. A line ending in
    // TWO backslashes followed by a blank line made the old joiner consume one
    // backslash, leave `\\ ` behind and RE-CHAIN on the residue, collapsing
    // three honest lines into one while the derivation predicted two:
    // REFUSED-LINES-NOT-ALL-TESTED 2/3 on an HONEST document. It failed closed,
    // and a false RED on a real document is still a defect, because the next
    // author to meet one learns to distrust the law.
    //
    // A claim about a function is tested as a function, over a domain big
    // enough to find what hand-named shapes miss. So: a DETERMINISTIC fuzz --
    // a fixed seed and a fixed generator, so it can never flake and a failure
    // can always be replayed -- over pieces chosen for exactly the dimensions
    // that have ever mattered here: backslash runs of one, two and three,
    // blank lines, tabs, runs of spaces, and bare CRs. The coordinator
    // measured 197 mismatches in 300,000 cases before the parity fix; this arm
    // requires 0, and it is the thing that would catch a fourth normalisation
    // added to the joiner and not to the derivation.
    let seed = 20261019;
    const nextRandom = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const fuzzPieces = ['a', 'b ', ' c', '\\', '\\\\', '\\\\\\', '', '  ', '\t', 'x\\', 'y \\', 'z\\\\', '\r', 'q\r'];
    const mismatches: string[] = [];
    let fuzzCases = 0;
    const coverage = { backslash: 0, cr: 0, evenRun: 0, joined: 0 };
    for (let k = 0; k < 20000; k += 1) {
      const pick: string[] = [];
      const howMany = 1 + Math.floor(nextRandom() * 5);
      for (let j = 0; j < howMany; j += 1) pick.push(fuzzPieces[Math.floor(nextRandom() * fuzzPieces.length)] ?? '');
      const text = pick.join('\n');
      fuzzCases += 1;
      const actual = logicalLines(text);
      const predicted = rawExpectation(text);
      if (text.includes('\\')) coverage.backslash += 1;
      if (text.includes('\r')) coverage.cr += 1;
      if (text.split('\n').some((l) => /(^|[^\\])(\\\\)+\s*$/.test(l))) coverage.evenRun += 1;
      if (actual.length < text.split('\n').length) coverage.joined += 1;
      if (predicted.lines !== actual.length || predicted.content !== actual.map((l) => l.line).join('')) {
        if (mismatches.length < 3) mismatches.push(JSON.stringify(text));
      }
    }
    expect(fuzzCases, 'the fuzz generated no cases, so it measured nothing').toBe(20000);
    // AND THE GENERATOR IS MEASURED, NOT TRUSTED -- the challenger's own
    // disclosure on F-78, which is this finding reached independently: its
    // first fuzz used a degenerate LCG whose low-order bits barely varied, so
    // it produced ZERO CR cases and 177 backslash cases out of 20,000 and
    // returned no failures. It nearly reported that as a pass. Mine is an LCG
    // too, so the same doubt applies to it and the answer is the standing rule
    // -- a claim about an instrument is verified only by RUNNING the
    // instrument. So the corpus's own coverage is counted and asserted: a 0
    // over a domain that never contained the shape is a 0 about nothing.
    expect(coverage.backslash, 'the fuzz corpus barely contains a backslash, so its 0 mismatches is a 0 over the wrong domain').toBeGreaterThan(5000);
    expect(coverage.cr, 'the fuzz corpus barely contains a CR, so the CR normalisation is untested by it').toBeGreaterThan(2000);
    expect(coverage.evenRun, 'the fuzz corpus barely contains an EVEN backslash run, which is the shape CD-47-02/F-78 was about').toBeGreaterThan(2000);
    expect(coverage.joined, 'the fuzz corpus barely makes the joiner do anything, so it is not testing the join rule').toBeGreaterThan(2000);

    // AND AN EXHAUSTIVE SEARCH, which is what a fuzz cannot be: every string
    // of length 0 to 7 over the alphabet that matters. 335,923 cases, no
    // generator, no seed, no sampling -- so no generator bias is possible and
    // the result BOUNDS LOSS over that domain instead of surviving a witness.
    // The challenger's exhaustive search of exactly this shape found the one
    // divergence class in a single member, `\\` + two newlines, which is how
    // F-78 and CD-47-02 are the same finding. ROUND 49, F-80: it stopped at
    // length FOUR and three strings of length FIVE diverged, so the number
    // below is the length actually run and not the length that was cheap.
    const alphabet = ['a', ' ', '\t', '\\', '\r', '\n'];
    const exhaustive: string[] = [];
    let exhaustiveCases = 0;
    const walkStrings = (prefix: string, depth: number): void => {
      exhaustiveCases += 1;
      const actual = logicalLines(prefix);
      const predicted = rawExpectation(prefix);
      if (predicted.lines !== actual.length || predicted.content !== actual.map((l) => l.line).join('')) {
        if (exhaustive.length < 5) exhaustive.push(JSON.stringify(prefix));
      }
      if (depth === 0) return;
      for (const ch of alphabet) walkStrings(prefix + ch, depth - 1);
    };
    walkStrings('', 7);
    expect(exhaustiveCases, 'the exhaustive search did not cover the domain it claims: every string of length 0 to 7 over six characters').toBe(335923);
    expect(
      exhaustive,
      'the derivation and logicalLines disagree on a string of seven characters or fewer, so the pair is not in agreement over its domain',
    ).toStrictEqual([]);
    expect(mismatches, 'the raw-derived expectation does not predict logicalLines on these documents, so the law can false-RED on an honest one').toStrictEqual(
      [],
    );
    // The generator must actually produce the shape that defeated round 47, or
    // the 0 above is a 0 over the wrong domain -- which is the mistake CD-47-02
    // was about in the first place.
    expect(fuzzPieces, 'the fuzz generator no longer produces an EVEN backslash run, which is the shape CD-47-02 was about').toContain('\\\\');
    expect(continuesLine('echo a \\\\'), 'an EVEN trailing backslash run is read as a continuation again: CD-47-02 has regressed').toBe(false);
    expect(continuesLine('echo a \\'), 'an ODD trailing backslash run is no longer read as a continuation, which would stop the joiner working at all').toBe(
      true,
    );
    expect(continuesLine('echo a \\\\\\'), 'a three-backslash run is not read as a continuation').toBe(true);
    expect(continuesLine('echo a \\   '), 'a continuation followed by trailing whitespace is not read as one').toBe(true);
    expect(continuesLine('echo a'), 'a line with no trailing backslash is read as a continuation').toBe(false);

    // CD-44-01: the content refusal compares CHARACTERS, not how many of them.
    // Armed over its domain, including the case that defeated round 44 -- a
    // substitution of the same length.
    for (const seq of ['', 'a', 'python3-Itools/status-block.py', 'x'.repeat(97)]) {
      expect(contentRefusal('doc', seq, seq), `identical content is refused: ${seq.slice(0, 20)}`).toBeUndefined();
    }
    for (const [read, expected, why] of [
      ['axc', 'abc', 'ONE character substituted, same length -- CD-44-01 itself'],
      ['xxx', 'abc', 'every character substituted, same length'],
      ['ab', 'abc', 'a character missing'],
      ['abcd', 'abc', 'a character too many'],
      ['', 'abc', 'nothing read at all'],
      ['abc', '', 'read where nothing was expected'],
    ] as [string, string, string][]) {
      const bad = contentRefusal('doc', read, expected);
      expect(bad, `cleared although the content differs: ${why}`).toBeDefined();
      expect(bad, 'the content refusal does not name itself').toContain(REFUSED_CONTENT_NOT_ALL_READ);
      expect(bad, 'the content refusal does not carry both lengths').toContain(`${read.length}/${expected.length}`);
    }
    expect(contentRefusal('doc', 'axc', 'abc'), 'the refusal does not say where the content first diverged').toContain('divergence at 1');

    // CD-44-02: both invariants go through ONE function, and that function is
    // armed over its domain -- clean, a matcher missing, a short line count,
    // substituted content, and a matcher nobody declared.
    const expectation = { lines: 2, content: 'abc' };
    expect(invariantOffences('doc', 2, ['abc', 'abc'], expectation), 'a clean document is refused').toStrictEqual([]);
    expect(invariantOffences('doc', 2, ['abc'], expectation), 'a document only one matcher read is cleared').toHaveLength(1);
    expect(invariantOffences('doc', 1, ['abc', 'abc'], expectation), 'a short line count is cleared').toHaveLength(1);
    expect(invariantOffences('doc', 2, ['abc', 'axc'], expectation), 'one matcher reading substituted content is cleared').toHaveLength(1);
    expect(invariantOffences('doc', 2, ['axc', 'axc'], expectation), 'both matchers reading substituted content is cleared').toHaveLength(2);
    expect(invariantOffences('doc', 2, ['abc', 'abc', 'abc'], expectation), 'a third matcher nobody declared is cleared').toHaveLength(1);

    // CD-46-01 (P1, A FAIL-OPEN), THE COORDINATOR'S: round 45 recorded and
    // expected the NON-WHITESPACE characters, and `INVOCATION` depends on the
    // whitespace between the interpreter and the tool -- so an edit confined
    // to the whitespace changed what matched while leaving the record
    // identical, and the planted un-isolated command went unreported at 23
    // passed. Reproduced in this container before anything changed.
    //
    // Armed as the two spellings of that attack, in both directions: COLLAPSE
    // the whitespace away, and INSERT whitespace that was never there. Each
    // must red by name AND must have the same non-whitespace projection as the
    // expectation -- that second assertion is what makes this arm a
    // measurement rather than a hope, because it shows the round-45 law
    // CLEARED these exact strings. If a projection is ever put back into
    // `matchesOf` or `rawExpectation`, these two go green and say so.
    const wsText = 'python3 -I tools/status-block.py --dir d\n  two  spaces\there\t\n';
    const wsExpected = rawExpectation(wsText);
    expect(wsExpected.content, 'the whitespace fixture carries no whitespace, so this arm measures nothing').toMatch(/\s/);
    for (const [why, read] of [
      ['whitespace collapsed away', nonSpaceOf(wsExpected.content)],
      ['whitespace inserted where there was none', wsExpected.content.replace(/python3/g, 'python3 ')],
    ] as [string, string][]) {
      expect(read, `${why}: the attack did not change the string at all`).not.toBe(wsExpected.content);
      expect(nonSpaceOf(read), `${why}: the attack is visible to the round-45 projection, so it is not the attack that defeated it`).toBe(
        nonSpaceOf(wsExpected.content),
      );
      const offences = invariantOffences('doc', wsExpected.lines, [read, wsExpected.content], wsExpected);
      expect(offences, `${why}: cleared, so the whitespace of the string a matcher read is not measured -- CD-46-01 is open again`).toHaveLength(1);
      expect(offences[0], `${why}: the refusal does not name itself`).toContain(REFUSED_CONTENT_NOT_ALL_READ);
    }
    // And its ONE call site in the live scan, counted with an assembled needle:
    // delete or rename the push and this arm reds.
    // Needle assembled, and whitespace-insensitive because Prettier decides how
    // this call wraps: the first version of this arm matched a one-line
    // spelling and went to 0 the moment the formatter broke the call across
    // lines, which is a false RED but the same lesson as B-10 -- an in-file
    // needle must survive the formatter that owns the file.
    const pushSite = new RegExp(['\\.\\.\\.invariantOffences\\(', 'label,', 'scan\\.tested,', 'scan\\.read,'].join('\\s*'), 'g');
    const self = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    expect(
      (self.match(pushSite) ?? []).length,
      'the audited wrapper no longer compares the scanner record against the independent expectation: the guard was deleted or renamed',
    ).toBe(1);
    // Each line is read by every matcher, so a matcher that goes missing is a
    // refusal rather than a smaller expectation.
    expect(MATCHERS, 'the matcher count changed without this expectation changing with it').toBe(2);

    // ROUND 47, F-76 (P1, A FAIL-OPEN), THE CHALLENGER'S: the same class one
    // level up -- every invariant was per DOCUMENT, and nothing bounded WHICH
    // documents were read. Both of its attacks were reproduced here before
    // anything changed, with a planted file in the repository clone carrying
    // an un-isolated command: a `continue` on the path placed after the old
    // counter, 23 passed; a filter inside `walk`, 23 passed. The control, law
    // unmodified, reported the plant by name.
    //
    // The refusal is armed over its domain, in BOTH directions. A document
    // missing is the fail-open; a document scanned but never enumerated means
    // the two traversals disagree, which is a drift that must be read rather
    // than ignored.
    const docs = ['a.md', 'b.md', 'c.md'];
    expect(documentRefusal(docs, docs), 'a complete scan is refused').toStrictEqual([]);
    expect(documentRefusal(docs, []), 'a scan that read NOTHING is cleared').toHaveLength(1);
    expect(documentRefusal(docs, ['a.md', 'b.md']), 'a scan that skipped one document is cleared').toHaveLength(1);
    expect(documentRefusal(docs, [...docs, 'd.md']), 'a document scanned but never enumerated is cleared').toHaveLength(1);
    expect(documentRefusal(docs, ['a.md', 'b.md', 'd.md']), 'one skipped and one surplus is cleared').toHaveLength(2);
    expect(documentRefusal([], []), 'two empty sets are refused, which would make the live comparison vacuous').toStrictEqual([]);
    const docRefusal = documentRefusal(docs, ['a.md', 'b.md'])[0] ?? '';
    expect(docRefusal, 'the document refusal does not name itself').toContain(REFUSED_DOCUMENTS_NOT_ALL_SCANNED);
    expect(docRefusal, 'the document refusal does not carry both counts').toContain('2/3');
    expect(docRefusal, 'the document refusal does not say WHICH document went unread').toContain('c.md');

    // The two traversals must agree on the live tree, or the equality above is
    // bought with a false RED rather than measured. Measured here, so a drift
    // between `walk` and `treeFiles` is named by this arm and not by the law.
    expect(
      new Set(treeFiles(REPO).map((p) => relative(REPO, p))),
      'the two traversals disagree on this repository: one of them is skipping something the other reads',
    ).toStrictEqual(new Set(walk(REPO).map((p) => relative(REPO, p))));

    // CD-47-03 (P3): this comment was CUT IN HALF when I inserted the needle
    // arm below it last round -- "Four names, each of them" ran straight into
    // the needle's own paragraph, and the tail landed under the needle check
    // where it read as a sentence about `UNREAD_DIRS` that began nowhere. A
    // comment spliced by an insertion is the prose equivalent of the in-file
    // needle Prettier broke in round 45: the edit succeeded and the artefact
    // it produced was wrong. Both halves are restored to their own paragraph.
    //
    // The document refusal's ONE live call site, counted with an assembled
    // whitespace-insensitive needle, for the same reason the content guard has
    // one: a guard whose removal nothing notices is not a guard. Deleting or
    // renaming the call in the repository walk reds here.
    const docSite = new RegExp(['documentRefusal\\(', 'expectedLabels,', 'auditedLabels\\(\\)\\)'].join('\\s*'), 'g');
    const here47 = readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts'), 'utf8');
    expect(
      (here47.match(docSite) ?? []).length,
      'the repository walk no longer compares the documents it read with the documents the tree holds: the guard was deleted or renamed',
    ).toBe(1);

    // ROUND 48, THE COORDINATOR'S CD-47-01 (P1, A FAIL-OPEN): every invariant
    // was over the text the law was HANDED, and nothing bounded that text
    // against disk -- so ONE edit to the shared helper `readable` blanked the
    // planted line and left the document-set law content (the label was still
    // recorded) and the content identity content (the expectation derived from
    // the same blanked text). 23 passed. Reproduced before anything changed.
    //
    // The refusal is armed over its domain in both directions, because this
    // guard has two failure modes that look alike and are not: the law reading
    // LESS than disk holds, and the second reader reading less than the law
    // consumed.
    for (const [why, consumed, onDisk, expected] of [
      ['identical text', 'abc', 'abc', false],
      ['the law was handed nothing', '', 'abc', true],
      ['the law was handed a blanked copy', '', 'a longer document', true],
      ['the second reader found nothing', 'abc', '', true],
      ['one character substituted, same length', 'axc', 'abc', true],
      ['a trailing newline only on disk', 'abc', 'abc\n', true],
    ] as [string, string, string, boolean][]) {
      const refusal = diskRefusal('doc', consumed, onDisk);
      expect(refusal === undefined, `${why}: the disk refusal answered the wrong way`).toBe(!expected);
      if (expected) {
        expect(refusal, `${why}: the disk refusal does not name itself`).toContain(REFUSED_TEXT_NOT_FROM_DISK);
        expect(refusal, `${why}: the disk refusal does not carry both lengths`).toContain(`${consumed.length}/${onDisk.length}`);
      }
    }
    // A file the second reader cannot read AT ALL is its own refusal, not a
    // silent pass: `null` is the one value that is neither equal nor unequal.
    expect(diskRefusal('doc', 'abc', null), 'a file the second reader could not read is cleared').toContain(REFUSED_TEXT_NOT_FROM_DISK);

    // And the two readers are INDEPENDENT on a real file, measured rather than
    // asserted: both read this very file and agree, so the equality the live
    // law checks is not bought with a reader that cannot disagree.
    const selfPath = join(__dirname, 'tool-commands-are-isolated.test.ts');
    expect(
      diskRefusal(SELF, readable(selfPath) as string, diskText(selfPath)),
      'the two readers disagree on this file, so one of them is not reading it',
    ).toBeUndefined();

    // The disk refusal's TWO live sites, counted -- because no file in this
    // repository or in the pack disagrees with its own bytes, so deleting
    // either push changes nothing at runtime and the suite stays green. I
    // measured that: both deletions pass. A guard with no live instance is
    // UNMEASURED AT RUNTIME, not dead -- and the remedy for an unmeasured
    // guard whose absence nothing notices is the same one `documentRefusal`
    // got: count its sites, so removing one reds here even though no document
    // can red on it.
    const diskSite = new RegExp(['diskRefusal\\(', '(?:label|name),', 'text,', 'onDisk\\)'].join('\\s*'), 'g');
    expect(
      (here47.match(diskSite) ?? []).length,
      'the text the law consumed is no longer compared with the bytes on disk in both halves: one of the two guards was deleted or renamed',
    ).toBe(2);

    // ROUND 49, THE COORDINATOR'S CD-48-01 (P1, A ONE-PATH FAIL-OPEN), AND
    // THE RULING THAT ENDS THIS CLASS: stop adding audits around audits.
    //
    // The caller decided whether the audit ran at all. Measured, each a single
    // edit to the caller loop with a planted document, each 23 passed: record
    // the label and `continue` before the scan; a `try`/`catch` that swallows
    // a throw; a filter over the scan's own offences before pushing them. The
    // first two are closed structurally -- `auditedScan` records the label
    // itself now, so a label nobody audited is a label nobody recorded. THE
    // THIRD IS NOT, and no further audit can close it: whoever calls an audit
    // can discard what it returns, and an audit written to catch that would
    // itself be called by someone. That is the regress, and it does not
    // terminate inside this file.
    //
    // So it terminates OUTSIDE it, in the bytes. `tools/law-bytes.json` pins a
    // sha256 for each file the law is written in, and `law-bytes-are-pinned`
    // checks it with its own reader, its own `createHash` and no code shared
    // with anything here -- because a shared helper would move subject and
    // instrument together, which is F-73 (B) and CD-47-01 over again. Any edit
    // to the law, in any path, whether it skips, swallows, filters or
    // rewrites, changes those bytes and is refused BY NAME. The edit does not
    // have to be anticipated or classified; it only has to exist.
    //
    // THIS ARM IS THE OTHER HALF OF THE MUTUAL PIN. The two files pin each
    // other through the same JSON: deleting the separate reader reds here,
    // editing this file reds there, and dropping a row from the pin reds in
    // both, because each checks the pinned SET as well as the digests.
    const lawPin = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'law-bytes.json'), 'utf8')) as {
      pinned?: Record<string, string>;
    };
    expect(
      Object.keys(lawPin.pinned ?? {}).sort(),
      'the external pin no longer names exactly the files the law is written in, so one of them is unpinned or a row checks nothing',
    ).toStrictEqual(['test/law-bytes-are-pinned.test.ts', 'test/tool-commands-are-isolated.test.ts']);
    expect(
      existsSync(join(__dirname, 'law-bytes-are-pinned.test.ts')),
      "the separate reader that pins this law's bytes is gone, so an edit anywhere in this file would no longer be refused by name",
    ).toBe(true);
    // And the pin's own digest for THIS file is re-derived here, independently
    // of that reader, so the mutual pin is measured from both sides rather
    // than asserted from one.
    const selfDigest = createHash('sha256')
      .update(readFileSync(join(__dirname, 'tool-commands-are-isolated.test.ts')))
      .digest('hex');
    expect(
      selfDigest,
      'this file does not match its external pin: if the change is intended, update tools/law-bytes.json in the SAME commit and say why in the message',
    ).toBe((lawPin.pinned ?? {})['test/tool-commands-are-isolated.test.ts']);

    // CD-48-02 (P3), THE COORDINATOR'S: replacing the expectation source with
    // the handed text left the suite green, because no file in this repository
    // or the pack disagrees with its own bytes -- so that argument is
    // UNMEASURED AT RUNTIME and its removal was noticed by nothing. The same
    // remedy the other unmeasured guards got: count the two sites where the
    // expectation is derived from the SECOND reader rather than from the
    // string the scanner was handed. `diskRefusal` still catches CD-47-01 on
    // its own; this is what keeps the expectation's own source honest.
    const sourceSite = new RegExp(['auditedScan\\(', '(?:label|name),', 'text,', 'onDisk \\?\\? text,'].join('\\s*'), 'g');
    expect(
      (here47.match(sourceSite) ?? []).length,
      'the expectation is no longer derived from the bytes the second reader found in both halves: one of the two sites now derives it from the text the scanner was handed',
    ).toBe(2);

    // THE GENERAL LIMIT, written down ONCE and MEASURED, in R42-01's voice.
    // This law is a self-check: it reads its own subject through its own
    // helpers. An edit that changes the SAME behaviour in BOTH independent
    // paths -- blanking a line in `readable` AND in `diskText`, or filtering a
    // path in `walk` AND in `treeFiles` -- moves both sides of every equality
    // together and PASSES. I measured both of those: 23 passed. No self-check
    // can see such an edit, because there is nothing left inside the system to
    // disagree with it; it is bounded by REVIEW of the diff, where it appears
    // as two edits in two functions that share no line. Nothing in this file
    // claims otherwise, and this is the sentence that says so.
    //
    // CD-47-04 (P3): `REFUSED_FILE_NOT_READABLE` names the refusal for a file
    // this law cannot read. No such file exists in this repository or in the
    // pack, so the LIVE push is UNMEASURED AT RUNTIME -- not dead, and not
    // claimed as armed. What is measured is the reader's own answer on an
    // unreadable path, which is the half a test can execute: a directory is
    // not a file, so `readable` must return `null` for it rather than throwing
    // past the caller or returning text.
    expect(readable(REPO), 'a directory read as a file did not come back as unreadable, so the null branch is not the branch this law thinks it is').toBe(null);
    expect(diskText(REPO), 'the second reader did not come back as unreadable on a directory either').toBe(null);
    expect(REFUSED_FILE_NOT_READABLE, 'the unreadable refusal name changed without the two assertions that read it changing with it').toBe(
      'REFUSED-FILE-NOT-READABLE',
    );

    // And the shared exclusion list is a CLAIM, pinned to its literal: it is
    // the one thing both traversals read, so widening it would move both sides
    // of the equality together -- the F-73 (B) shape. Four names, each of them
    // a directory this law has no business reading.
    expect(
      [...UNREAD_DIRS],
      'the list of directories this law does not read has changed: a subtree has been exempted, which is a claim in the diff',
    ).toStrictEqual(['.git', 'node_modules', 'dist', '.next']);
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
    //
    // ROUND 41, R39-01 (P3): "strayed on both runs" is a CONFIRMED double
    // observation, not an ATTRIBUTION -- a recurrent bystander satisfies it,
    // and the challenger measured exactly that (two different
    // `p5-limit-registry-*` directories blamed on `-X warn_default_encoding`
    // under 50 ms churn). So the comparison is now TREATMENT versus CONTROL
    // with digits normalised, the form it measured both ways: a `-I` spawn
    // with no `-X` at all strays under the same churn, while `-X perf_jit`
    // leaves `jit-N.dump` on both treatment runs and nothing on the control.
    // A plain set intersection would not do: a real writer's name carries its
    // pid, so it differs per run and the intersection is empty for the genuine
    // case too -- which is why the digits are normalised and a control run is
    // what separates them.
    const normalise = (entries: readonly string[]): string[] => entries.map((e) => e.replace(/\d+/g, 'N')).sort();
    const strayFor = (name: string | null): string[] => {
      const probe = mkdtempSync(join(tmpdir(), 'r3702-'));
      try {
        const before = new Set(readdirSync('/tmp'));
        const argv = name === null ? ['-I', '-c', PROBE] : ['-I', '-X', name, '-c', PROBE];
        const r = spawnSync(HARNESS_PYTHON, argv, {
          encoding: 'utf8',
          timeout: 10_000,
          cwd: probe,
          env: { PATH: '/usr/bin:/bin', TMPDIR: probe },
        });
        const stray = readdirSync('/tmp').filter((e) => !before.has(e) && !e.startsWith('r3702-'));
        expect(readdirSync(probe), `-X ${name ?? '(control)'} is accepted by this filter and WRITES a file: it belongs in X_WRITES_FILES`).toStrictEqual([]);
        expect(r.status === 0 || r.status === 1, `-X ${name ?? '(control)'} neither ran nor failed cleanly`).toBe(true);
        return stray;
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    };
    // The attribution rule itself, as a function the arms RUN rather than a
    // comment. ROUND 42, THE CHALLENGER'S F-71 (P2): the control term was
    // UNARMED -- it could be deleted outright, or replaced lint-invisibly with
    // `!c.includes(`never-${e}`)`, and all three arms still passed, because
    // arms 1 and 3 passed an empty control and arm 2's three churn names do
    // not collapse to one another under digit normalisation. So my sentence
    // "recurrent churn present in the control is not blamed" was false about
    // its own arm. And the control term could exonerate a REAL writer:
    // `blame(['jit-1836.dump'], ['jit-2145.dump'], ['jit-77.dump'])` was [].
    //
    // The rule now takes TWO control runs, and each of its four terms has an
    // arm below that reds if that term alone is removed:
    //   1. the entry must appear in BOTH treatment runs    (a one-off is not
    //      an option's doing);
    //   2. with DIGITS NORMALISED                          (a real writer's
    //      name carries its pid, so it differs per run);
    //   3. and must be absent from the control runs        (whatever happens
    //      without the option is not the option's doing);
    //   4. confirmed by BOTH controls                      (one stray control
    //      entry may not exonerate a real writer).
    const blame = (first: readonly string[], second: readonly string[], control1: readonly string[], control2: readonly string[]): readonly string[] => {
      const t2 = normalise(second);
      const environmental = normalise(control1).filter((e) => normalise(control2).includes(e));
      return normalise(first).filter((e) => t2.includes(e) && !environmental.includes(e));
    };
    for (const name of X_OPTION_NAMES) {
      const first = strayFor(name);
      if (first.length === 0) continue;
      const second = strayFor(name);
      const control1 = strayFor(null);
      const control2 = strayFor(null);
      expect(
        blame(first, second, control1, control2),
        `-X ${name} is accepted by this filter and wrote into /tmp on both of two runs while neither of two no-option control runs did, where no cwd or TMPDIR can contain it (first run left ${first.join(', ')}): it belongs in X_WRITES_FILES`,
      ).toStrictEqual([]);
    }
    // ONE ARM PER TERM, each red if that term alone is deleted.
    // Term 1, both treatment runs: a single stray is not blamed.
    expect(blame(['p5-limit-registry-JI2U8U'], [], [], []), 'TERM 1: a /tmp entry seen in ONE run is blamed on an -X option again').toStrictEqual([]);
    // Term 2, digit normalisation: a real writer's per-pid name still matches
    // itself across runs, so it IS blamed.
    expect(
      blame(['jit-1836.dump'], ['jit-2145.dump'], [], []),
      'TERM 2: without digit normalisation a per-pid writer escapes, so this must be blamed',
    ).toStrictEqual(['jit-N.dump']);
    // Term 3, the control: something that happens WITHOUT the option is not
    // the option's doing. A stable-named recurrent bystander, present in both
    // treatments and both controls, is not blamed. This is the arm F-71 was
    // about: delete the control term, or weaken it to `never-${e}`, and this
    // one reds.
    expect(
      blame(['sshd-cache', 'jit-1836.dump'], ['sshd-cache', 'jit-2145.dump'], ['sshd-cache'], ['sshd-cache']),
      'TERM 3: an entry present in both no-option control runs is still attributed to the option',
    ).toStrictEqual(['jit-N.dump']);
    // Term 4, BOTH controls: one stray control entry may not exonerate a real
    // writer -- the case the coordinator named.
    expect(
      blame(['jit-1836.dump'], ['jit-2145.dump'], ['jit-77.dump'], []),
      'TERM 4: a single control-run entry exonerates a real writer again, which is the case the ruling named',
    ).toStrictEqual(['jit-N.dump']);

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
    const packUnreadable: string[] = [];
    // CD-48-01: this half reads the auditor's record too, so it resets it.
    resetAuditRecord();
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
      // CD-47-01/CD-47-04, the same two corrections on this side: a file this
      // law cannot read is REFUSED BY NAME rather than skipped silently.
      if (text === null) {
        packUnreadable.push(name);
        continue;
      }
      // F-57, the same refusal on this side.
      if (text === BINARY) {
        if (!EXEMPT_BINARIES.has(name)) packBinaries.push(name);
        continue;
      }
      mine += 1;
      // CD-47-01: the second reader here too, so the pack half is bounded
      // against disk exactly as the repository half is.
      const onDisk = diskText(join(PACK, name));
      offences.push(...auditedScan(name, text, onDisk ?? text, TOOLS_DIR).found);
      const drifted = diskRefusal(name, text, onDisk);
      if (drifted !== undefined) offences.push(drifted);
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
    expect(
      packUnreadable,
      `a pack document cannot be read at all, so this law never saw it: ${REFUSED_FILE_NOT_READABLE} — name why, and do not restore the silent skip`,
    ).toStrictEqual([]);
    expect(mine, 'no author-owned document was read from the pack').toBeGreaterThan(0);
    // ROUND 42: no `quoted` counter any more. There is no exemption to keep
    // alive, and nothing in a document is skipped: an attack line that must
    // appear is NEUTRALISED (`<python3> …`), which the arm below pins.
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

  it("ROUND 49, the coordinator's addendum (d): the status block refuses a head that does not resolve, by name", () => {
    // A SHA THAT APPEARS ANYWHERE IS NOT THE SHA A DOCUMENT DECLARES -- P15's
    // lesson, and `status-block.py` renders a head into five documents. It
    // never asked whether that head exists, so a typo, a stale abbreviation or
    // a sha from another branch rendered cleanly into all five and the pack
    // then SAID it five times. It now refuses by name, and ABSENCE refuses
    // too: this arm runs the tool over a scratch pack, one defect at a time,
    // and reads the refusal NAME out of its output rather than its exit code.
    //
    // F-61 holds: every argument that reaches `spawnSync` here is a literal or
    // a path this test made. Nothing a document supplies is passed.
    const dir = mkdtempSync(join(tmpdir(), 'r49-status-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const tool = join(TOOLS_DIR, 'status-block.py');
    const real = JSON.parse(readFileSync(join(PACK, 'P5-STATUS.json'), 'utf8')) as Record<string, unknown>;
    // One document, carrying the sentinel pair, so the tool gets as far as the
    // head check in every case below.
    // The sentinel pair verbatim: a malformed pair exits inside the tool
    // before the head is ever looked at, which would make this arm pass for
    // the wrong reason.
    const begin = '<!-- P5-STATUS:BEGIN \u2014 generated by tools/status-block.py; edit P5-STATUS.json -->';
    writeFileSync(join(dir, 'P5-SCRATCH.md'), `# scratch\n\n${begin}\n<!-- P5-STATUS:END -->\n`);
    const run = (status: Record<string, unknown>, repo: string): string => {
      writeFileSync(join(dir, 'P5-STATUS.json'), JSON.stringify({ ...real, ...status, documents: ['P5-SCRATCH.md'] }));
      const r = spawnSync('python3', ['-I', tool, '--dir', dir, '--repo', repo, '--check'], { encoding: 'utf8', timeout: 60_000 });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    };
    const absent = '0000000000000000000000000000000000000000';
    expect(run({ head: '33522c3', head_full: undefined }, REPO), 'a missing full sha was accepted').toContain('REFUSED-STATUS-SHA-SHAPE');
    expect(run({ head: '33522c3', head_full: '33522c3' }, REPO), 'an abbreviation standing in for the full sha was accepted').toContain(
      'REFUSED-STATUS-SHA-SHAPE',
    );
    expect(run({ head: 'deadbee', head_full: real['head_full'] }, REPO), 'a head that is not a prefix of the full sha was accepted').toContain(
      'REFUSED-STATUS-SHA-SHAPE',
    );
    expect(run({ head: '0000000', head_full: absent }, REPO), 'a well-formed sha that is in no repository was accepted').toContain(
      'REFUSED-STATUS-SHA-NOT-RESOLVED',
    );
    // ABSENCE: a repository that is not one refuses rather than skipping.
    expect(run({}, dir), 'a missing repository was treated as a pass').toContain('REFUSED-STATUS-SHA-NOT-RESOLVED');
    // And the law stays satisfiable: the pack's own head passes.
    expect(run({}, REPO), "the pack's own declared head does not resolve, so this arm is refusing everything").not.toContain('REFUSED-STATUS-SHA');
  });

  it("F-79: the continuation rule is bounded by its own ARITHMETIC, not by the other derivation's agreement", () => {
    // F-79, THE COORDINATOR'S ADDENDUM, and it is the difference between
    // AGREEMENT and TRUTH. The exhaustive arm above compares the two
    // derivations with each other; before this round they shared this
    // predicate, so they agreed on any parity rule, right or wrong, and the
    // rule's correctness rested on the five examples below. The rule is
    // closed-form, so it is asserted as a LAW over its own domain instead:
    // a line continues exactly when the backslash run that ends it, looking
    // past trailing whitespace, is ODD. Nine run lengths by eight endings by
    // four heads, 288 cases, every one checked against the arithmetic and not
    // against the other derivation -- so the challenger's own edit (a
    // continuation followed by a TAB is not one) is refused here even if
    // something made both derivations read it the same way. The five examples
    // are kept below, inside this domain, for the regressions they NAME.
    const runEndings = ['', ' ', '  ', '\t', ' \t', '\t ', '\r', ' \r\t'];
    const runHeads = ['', 'echo a', 'echo a ', 'x\\y'];
    const parityFailures: string[] = [];
    let parityCases = 0;
    for (let n = 0; n <= 8; n += 1) {
      for (const tail of runEndings) {
        for (const head of runHeads) {
          parityCases += 1;
          const subject = `${head}${'\\'.repeat(n)}${tail}`;
          const truth = n % 2 === 1;
          if (continuesLine(subject) !== truth) parityFailures.push(`${JSON.stringify(subject)}: run ${n} should be ${truth ? 'a continuation' : 'none'}`);
        }
      }
    }
    expect(parityCases, 'the parity law did not run over the domain it claims: 9 run lengths by 8 endings by 4 heads').toBe(288);
    expect(
      parityFailures.slice(0, 5),
      'continuesLine does not implement the odd-run rule over its own domain, so the two derivations may agree on a rule that is WRONG',
    ).toStrictEqual([]);
  });
});
