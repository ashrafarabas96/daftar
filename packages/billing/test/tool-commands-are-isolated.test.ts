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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

const REPO = join(__dirname, '..', '..', '..');
// R52-03 (P3, the coordinator's): `??` let an EMPTY STRING through, so
// `P5_PACK_DIR=''` made this half measure nothing while the gate's own half
// measured the default pack -- two halves of one `npm test` on different
// subjects. An empty or blank value reads as UNSET here, exactly as it does in
// `tools/law-ran.py`, which forwards the variable only when it is non-empty.
// The SHARED pack: the directory sibling sessions enrol documents into by
// design. It is named here as well as reached through `PACK`, because the
// reporter the challenger's R56-S1 asks for is about THIS directory even when
// the gate has handed down a private copy as the subject.
const SHARED_PACK = '/mnt/project-files/phase5';
const PACK = (process.env.P5_PACK_DIR ?? '').trim() || SHARED_PACK;
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
const REFUSED_ENROLLED_BYTES_MOVED = 'REFUSED-ENROLLED-BYTES-MOVED';

/**
 * ROUND 50, THE CHALLENGER'S R48-F3 (P1), and the reason this reader is strict
 * about a file it used to read loosely.
 *
 * Enrolment was a LIST OF NAMES, so ONE routine-looking line exempted any
 * document from this law -- measured, with a plant enrolled: 303 passed. The
 * line looks like the bookkeeping this round does three times, so it is
 * CAMOUFLAGED rather than licensed, which is the opposite of the byte pin's
 * property that an edit must be deliberate and visible.
 *
 * Three teeth, and the third is the one that holds. (1) It is a MAP from EXACT
 * NAME to sha256, and an entry is accepted only when the name is
 * REVIEWER-SHAPED and the value is 64 hex characters -- so enrolling an
 * author-owned document is REFUSED BY NAME here instead of exempting it, and
 * shape is used to REFUSE rather than to exempt, which is B-10's rule and not
 * its violation. (2) The bytes are verified against the recorded digest
 * wherever the pack is present, which also closes the one case the seal's
 * name-set comparison was the only net for: an enrolled report rewritten
 * between the passes. (3) This file is pinned in `tools/law-bytes.json`, so
 * every enrolment moves a digest there too and is refused unless that pin
 * moves in the SAME commit.
 *
 * DECLARED LIMIT: a plant renamed into reviewer shape, enrolled WITH its true
 * digest, with the pin updated in the same commit, passes. That is the two-file
 * limit again, and in the diff it is a new reviewer name beside two new
 * digests -- which is what review reads.
 */
const enrolment = (): ReadonlyMap<string, string> => {
  const raw: unknown = JSON.parse(readFileSync(REVIEWER_REPORTS_FILE, 'utf8'));
  const table = (raw as { reviewer_reports?: unknown }).reviewer_reports;
  if (table === null || typeof table !== 'object' || Array.isArray(table) || Object.keys(table).length === 0) {
    throw new Error(`${REVIEWER_REPORTS_FILE} has no non-empty MAP of reviewer report name to sha256`);
  }
  const shape = looksLikeReviewer();
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    if (name.length === 0 || name.includes('/')) throw new Error(`${REVIEWER_REPORTS_FILE}: every key must be a bare file name`);
    if (!shape.test(name)) {
      throw new Error(
        `${REVIEWER_REPORTS_FILE}: ${name} is enrolled as reviewer-owned but is not a reviewer-shaped name, so this enrolment would exempt an author-owned document from this law`,
      );
    }
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${REVIEWER_REPORTS_FILE}: ${name} carries ${JSON.stringify(value)} rather than a sha256 of its bytes`);
    }
    out.set(name, value);
  }
  return out;
};

const reviewerOwned = (): ReadonlySet<string> => new Set(enrolment().keys());

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
/**
 * ROUND 50, THE CHALLENGER'S R48-F2 (P2). The pack arm's subject set was a
 * LIVE SHARED DIRECTORY, so a REPO GATE's verdict was not a property of the
 * commit: any writer in the pack could turn it red or green after it was
 * measured — it did, at 16:23Z — and `P5_PACK_DIR` could be pointed at an
 * empty directory with no file edit at all. The author-owned set is now PINNED
 * IN THE REPOSITORY, in `tools/pack-set.json`, and this is the name it refuses
 * by. Reviewer-owned reports are deliberately not pinned: they arrive
 * mid-review, they are already enrolled by exact name, and a reviewer dropping
 * a report must not red the author's suite.
 */
const REFUSED_PACK_NOT_PINNED = 'REFUSED-PACK-NOT-THE-PINNED-SET';

/**
 * ROUND 55, THE CHALLENGER'S R53-F1 (P1 ground: "a gate whose subject set is a
 * live shared directory measures no commit"). `npm test` reads this pack TWICE
 * -- once in the suite npm starts, and again inside the run `tools/law-ran.py`
 * starts for its figures -- and other sessions write to that directory. The
 * challenger reproduced the consequence deliberately, adding one document 16
 * seconds in: the suite printed `Tests 304 passed (304)` with no assertion
 * anywhere in its output, and the gate refused with failing figures belonging
 * to a run that printed nothing. A clean green and an rc 1 about two different
 * instants. Against a FROZEN pack it measured 10/10 rc 0, so the suite is not
 * flaky -- its SUBJECT MOVES.
 *
 * The fix is this phase's own rule applied to the instrument rather than the
 * dispatch: pin the subject by digest, and have both halves assert the SAME
 * digest. This arm measures the digest before it reads anything and again
 * after, so a pack that moves UNDER the measurement is a refusal BY NAME
 * instead of a confusing red; and when the gate hands a digest down in
 * `P5_PACK_DIGEST`, the run it started must be looking at exactly that pack.
 */
const REFUSED_PACK_MOVED = 'REFUSED-PACK-MOVED-DURING-MEASUREMENT';
const REFUSED_PACK_COPY_IMPOSSIBLE = 'REFUSED-PACK-COPY-NOT-POSSIBLE';
const REFUSED_PACK_NAME_NOT_UTF8 = 'REFUSED-PACK-NAME-NOT-UTF8';
const REFUSED_PACK_ENTRY_NOT_A_FILE = 'REFUSED-PACK-ENTRY-NOT-A-FILE';
// R56-S2: a digest handed down names the gate's own private copy, and when
// the directory it names is NOT one, the contract this run was started under
// is broken -- so it is a refusal of its own rather than a movement refusal
// whose sentence would be untrue.
const REFUSED_PACK_NOT_PRIVATE = 'REFUSED-PACK-HANDED-DOWN-DIRECTORY-NOT-PRIVATE';
// ROUND 61, THE COORDINATOR'S ITEM 2 (third part). Provenance above admits any
// DESCENDANT of a gate run -- including a descendant of a gate run that is not
// this one, and including a run whose environment was captured from an earlier
// one. The gate therefore writes a fresh random value for each run into a
// mode-600 file of its own and hands both the value and the path down; this
// run must be able to READ that file and find exactly the value it was given.
// What this buys, stated honestly: a replayed or stale environment no longer
// satisfies the claim, because the value is new every run and the file it is
// read from is only readable by this uid. What it does NOT buy: a forger who
// builds the whole set at once -- the directory, the file and both variables --
// supplies a value it chose, and the census and the content scan remain what
// stop such a run from producing a false GREEN.
const REFUSED_NONCE_NOT_AS_SPECIFIED = 'REFUSED-NONCE-NOT-AS-SPECIFIED';
// ROUND 62, the challenger's F-1: a run that descends from the gate and was
// handed no digest has had its environment edited between the two, and that is
// a refusal of its own rather than the shared-pack path.
const REFUSED_GATE_HANDED_DOWN_NOTHING = 'REFUSED-GATE-HANDED-DOWN-NOTHING';
// ROUND 62b, THE COORDINATOR'S R61-C-03 (P3). Two of the eleven settings are
// absent from the worker's resolved config, so for those two the arm reads the
// FILE -- and `vitest run --dangerously-ignore-unhandled-errors` is rc 0 over a
// planted rejection with no refusal name. The gate closes them by FORCING both
// on its own argv, which defends `npm test` and nothing else. The run's own
// command line is readable from /proc, the kernel reports it and no JavaScript
// module can rewrite it, so the positive form of either flag is refused by name
// wherever the run came from.
const REFUSED_RUNNER_ARGV_OVERRIDES_THE_FILE = 'REFUSED-RUNNER-ARGV-OVERRIDES-THE-FILE';
const UNDEFENDED_FLAGS = ['--dangerously-ignore-unhandled-errors', '--file-parallelism'] as const;

/**
 * ROUND 63, THE CHALLENGER'S R59 F-1. Its shim stripped the four P5_* keys out
 * of the environment it passed on AND double-forked, so the ancestry walk no
 * longer reached the gate -- and `REFUSED-GATE-HANDED-DOWN-NOTHING` was armed
 * by the walk SUCCEEDING, so breaking the chain switched the refusal off.
 *
 * The chain is one input. The gate's own COMMAND LINE is another, and it does
 * not depend on the parent chain being intact: the gate always starts the
 * runner with `--outputFile=<dir>/report.json` where `<dir>` is its own
 * `mkdtemp(prefix='law-ran-')`. That word is on the runner's argv, which this
 * run can read out of /proc for whichever ancestor IS the runner, re-parented
 * or not. So a run carrying the gate's marker must also carry what the gate
 * hands down beside it, and a run that carries the marker with the environment
 * missing is refused by name instead of falling through to the shared-pack
 * path.
 *
 * WHAT THIS IS WORTH, narrowed on the challenger's R63 reply and against my own
 * earlier sentence, which claimed more: the marker is a word on the RUNNER's
 * command line, and whatever runs the suite holds that command line exactly as
 * it holds the environment. So an intermediary that rewrites `--outputFile=` to
 * a path of its own, runs the real vitest and copies the report back where the
 * gate expects it makes the marker ABSENT, and this arm then reads "not started
 * by the gate". It is therefore NOT a layer independent of the actor the runner
 * pin exists to exclude. What it does close is a real and different class: an
 * actor that edits the ENVIRONMENT but not the command line -- an env filter, a
 * wrapper that scrubs P5_* and execs through, a sanitised CI runner. The door
 * against the rewriting intermediary is held by the gate's runner pin, and that
 * is a COST and not a wall (this run is root; the pinned prefixes are writable
 * by it). The challenger predicted the rewrite and will measure it on the
 * pushed head; the sentence above is written before that measurement, not after.
 *
 * Returns true when the marker is there, false when it is not, and a reason
 * when it cannot say.
 */
const startedOnTheGatesCommandLine = (procRoot = '/proc', startPid = process.pid): boolean | string => {
  if (!existsSync(join(procRoot, String(startPid), 'status'))) {
    return `this platform has no readable ${procRoot}, so the command line this run was started with cannot be read`;
  }
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let argv: string[] = [];
    try {
      argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((word) => word.length > 0);
    } catch {
      // Keep walking.
    }
    if (argv.some((word) => word.endsWith('vitest.mjs') || basename(word) === 'vitest')) {
      return argv.some((word) => {
        if (!word.startsWith('--outputFile=')) return false;
        const where = word.slice('--outputFile='.length);
        return basename(dirname(where)).startsWith('law-ran-');
      });
    }
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch (error) {
      return `the parent chain stopped at pid ${pid}, which cannot be read (${String(error)})`;
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent, so the chain cannot be followed`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return 'no ancestor of this process names the runner, so the command line this run was started with cannot be read';
};

/**
 * The flags the RUN was started with, read from the nearest ancestor whose argv
 * names the runner. Returns the offending flags, or '' for "none", or a reason
 * it cannot say -- and the caller refuses on a reason, because a run that
 * cannot say what it was started with is the same shape as a run that cannot
 * say who started it.
 */
const undefendedFlagsOfThisRun = (procRoot = '/proc', startPid = process.pid): string[] | string => {
  if (!existsSync(join(procRoot, String(startPid), 'status'))) {
    return `this platform has no readable ${procRoot}, so the command line this run was started with cannot be read`;
  }
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let argv: string[] = [];
    try {
      argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((word) => word.length > 0);
    } catch {
      // Keep walking: the ancestor that names the runner is what matters.
    }
    if (argv.some((word) => word.endsWith('vitest.mjs') || basename(word) === 'vitest')) {
      // The gate passes the NEGATIVE form of both, which is the defence, so
      // only the positive form is an offence -- and a later positive form
      // would win, so the LAST occurrence of each decides.
      return UNDEFENDED_FLAGS.filter((flag) => {
        // `findLastIndex` needs a newer lib target than this package pins, so
        // the last index is computed by hand: the same answer, and no tsconfig
        // change riding on an unrelated commit.
        let lastValued = -1;
        argv.forEach((word, at) => {
          if (word.startsWith(`${flag}=`)) lastValued = at;
        });
        const last = Math.max(argv.lastIndexOf(flag), lastValued);
        const lastNegative = argv.lastIndexOf(flag.replace('--', '--no-'));
        return last > lastNegative;
      });
    }
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch (error) {
      return `the parent chain stopped at pid ${pid}, which cannot be read (${String(error)})`;
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent, so the chain cannot be followed`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return 'no ancestor of this process names the runner, so the command line this run was started with cannot be read';
};
const GATE_NONCE_PREFIX = 'law-ran-nonce-';

/**
 * The pack's identity: every name beside its sha256, sorted, hashed. The gate
 * computes the same value from the same definition, which is deliberate --
 * here agreement between the two IS the thing being bound, because what is
 * being established is that two readers looked at one instant.
 */
const packDigest = (dir: string): string => {
  const rows = readdirSync(dir)
    // ROUND 56, THE CHALLENGER'S R54-S1 (P2, latent): `.sort()` orders by
    // UTF-16 code unit and Python's `sorted` by code point, and the two differ
    // the moment one name holds a character above the BMP and another one
    // above U+D7FF. The challenger measured it with these two functions over
    // one directory holding `z\uFFFD` and `z\u{1F600}`: one instant, two
    // digests. The consequence is worse than a missed attack -- the gate would
    // hand down a digest the law could never match, so REFUSED-PACK-MOVED
    // would fire on every run SAYING the pack moved when it had not: a
    // refusal whose own words are untrue. Both sides order by the name's
    // BYTES now, and the arm below measures that the two implementations agree
    // over an adversarial name set rather than trusting that they do.
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .map((name) => {
      const full = join(dir, name);
      let digest = '<unreadable>';
      try {
        digest = statSync(full).isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : '<not-a-file>';
      } catch {
        digest = '<unreadable>';
      }
      return `${name}\u0000${digest}`;
    });
  return createHash('sha256').update(rows.join('\n')).digest('hex');
};

/**
 * ROUND 60, THE CHALLENGER'S R56-S1 (P3). Two windows, and only one of them was
 * reported. A write to the SHARED pack during the plain `vitest run` that
 * `npm test` starts FIRST was refused by nobody (correctly, since every figure
 * is a statement about a private snapshot) and REPORTED by nobody: the gate is
 * a LATER process, so its own `source_before` is taken after that run has
 * finished, and the law's attempt to say it from inside a passing case was
 * dropped because a `console.log` there did not reach this runner's output.
 *
 * So the law reads the shared pack when this FILE IS COLLECTED and compares at
 * the end of the pack arm, from `onTestFinished`, which does reach the output --
 * measured, by holding a sibling write across the arm. The window covered is
 * therefore collection-to-end-of-that-arm, which is most of the file's run and
 * is not the whole of it: a write in the seconds before collection or after
 * that arm is still reported by nobody, and that is the bound, stated.
 *
 * It is a NOTE and not a refusal, for the reason `tools/law-ran.py` gives in
 * writing: refusing on a shared pack moving after the copy is a false red about
 * figures that are true of a real instant of the pack (R55-S1).
 */
const sharedPackAtCollection = existsSync(SHARED_PACK) ? packDigest(SHARED_PACK) : '';
const reportSharedPackMovement = (): void => {
  if (sharedPackAtCollection === '') return;
  const now = existsSync(SHARED_PACK) ? packDigest(SHARED_PACK) : '<absent>';
  if (now === sharedPackAtCollection) return;
  console.log(
    `note: the shared pack at ${SHARED_PACK} moved while this suite ran (${sharedPackAtCollection} -> ${now}). ` +
      'Nothing in this run is false: every figure describes the private snapshot it names, which is a real instant ' +
      'of the pack. But a green run of this suite may not be read as "the pack held still" (R56-S1)',
  );
};

/**
 * ROUND 60, THE CHALLENGER'S R56-S2 (P3). The pivot that decided whether a
 * movement is an INTRUSION used to be `handedDown !== ''` -- the presence of a
 * value the caller supplies. The challenger set `P5_PACK_DIGEST` to the correct
 * digest of a SHARED directory, wrote into it during the pass, and got R55-S1's
 * false red back, under a refusal that called a shared directory "the private
 * pack directory the gate handed this run". Nothing in that test established
 * that the directory was private.
 *
 * Privacy is established from the properties only the gate's own
 * `tempfile.mkdtemp(prefix='law-ran-pack-')` produces: that name, inside the
 * resolved temporary directory, a directory, mode 700, owned by this uid.
 * Returns '' when the directory has them, and otherwise the reason it does not,
 * because a refusal that cannot say WHY sends the reader nowhere.
 */
const GATE_COPY_PREFIX = 'law-ran-pack-';
const notTheGatesPrivateCopy = (dir: string): string => {
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch (error) {
    return `it cannot be resolved at all (${String(error)})`;
  }
  if (!basename(resolved).startsWith(GATE_COPY_PREFIX)) {
    return `its name is ${JSON.stringify(basename(resolved))}, which does not start with the ${JSON.stringify(
      GATE_COPY_PREFIX,
    )} that the gate's mkdtemp gives its private copy`;
  }
  let temp = tmpdir();
  try {
    temp = realpathSync(temp);
  } catch {
    // An unresolvable tmpdir is not a reason to call a directory private: the
    // comparison below then fails and the caller refuses, which is the safe way
    // round.
  }
  if (dirname(resolved) !== temp) {
    return `it sits in ${dirname(resolved)}, not in the temporary directory ${temp} where the gate creates it`;
  }
  let st;
  try {
    st = statSync(resolved);
  } catch (error) {
    return `it cannot be stat'ed (${String(error)})`;
  }
  if (!st.isDirectory()) return 'it is not a directory';
  const mode = st.mode & 0o777;
  if (mode !== 0o700) return `its permissions are ${mode.toString(8)}, not the 700 that mkdtemp creates`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) return `it is owned by uid ${st.uid}, not by this run's uid ${uid}`;
  return '';
};

/**
 * ROUND 61 -- the per-run half of the same question. Returns '' when this run
 * was handed a nonce it can read back in full, and otherwise the reason it
 * cannot say so. Every branch is a REFUSAL, including an unreadable file and a
 * missing variable: a run handed a pack digest is a run the gate started, and
 * the gate always writes the nonce before it starts the suite, so an absent or
 * unreadable nonce is a run whose environment did not come from this gate run.
 */
const nonceNotAsSpecified = (writerPid: number | undefined): string => {
  const value = (process.env.P5_PACK_NONCE ?? '').trim();
  const where = (process.env.P5_PACK_NONCE_FILE ?? '').trim();
  if (value === '') return 'P5_PACK_NONCE is empty or unset, and the gate sets it beside every pack digest it hands down';
  if (where === '') return 'P5_PACK_NONCE_FILE is empty or unset, so there is nothing to read the value back from';
  // The shape is the gate's own: 16 bytes of `secrets.token_hex`. A value of
  // any other shape was not written by the program this claim names.
  if (!/^[0-9a-f]{32}$/.test(value)) return `P5_PACK_NONCE is ${JSON.stringify(value)}, which is not the 32 hex characters tools/law-ran.py writes`;
  let resolved: string;
  try {
    resolved = realpathSync(where);
  } catch (error) {
    return `the nonce file ${where} cannot be resolved (${String(error)})`;
  }
  if (basename(resolved) !== 'nonce') return `the nonce file resolves to ${resolved}, whose name is not the ${JSON.stringify('nonce')} the gate writes`;
  const dir = dirname(resolved);
  if (!basename(dir).startsWith(GATE_NONCE_PREFIX)) {
    return `the nonce file sits in ${dir}, whose name does not start with the ${JSON.stringify(GATE_NONCE_PREFIX)} that the gate's mkdtemp gives it`;
  }
  let temp = tmpdir();
  try {
    temp = realpathSync(temp);
  } catch {
    // As above: an unresolvable tmpdir makes the comparison below fail, which
    // refuses, which is the safe way round.
  }
  if (dirname(dir) !== temp) return `the nonce file's directory sits in ${dirname(dir)}, not in the temporary directory ${temp} where the gate creates it`;
  let st;
  try {
    st = statSync(resolved);
  } catch (error) {
    return `the nonce file cannot be stat'ed (${String(error)})`;
  }
  if (!st.isFile()) return 'the path P5_PACK_NONCE_FILE names is not a regular file';
  const mode = st.mode & 0o777;
  if (mode !== 0o600) return `the nonce file's permissions are ${mode.toString(8)}, not the 600 the gate sets`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) return `the nonce file is owned by uid ${st.uid}, not by this run's uid ${uid}`;
  let written: string;
  try {
    written = readFileSync(resolved, 'utf8');
  } catch (error) {
    return `the nonce file cannot be read (${String(error)})`;
  }
  // ROUND 62, THE CHALLENGER'S F-2 (P1). The file holds `<pid> <value>`, and
  // the pid must be the ancestor this run's own /proc walk found. A VALUE ON
  // DISK CANNOT TELL A LIVE RUN FROM A DEAD ONE: the challenger killed the
  // gate with SIGTERM, the nonce file survived at mode 600 holding its value,
  // and replaying that environment under a forged ancestor passed privacy,
  // ancestry, the nonce and the digest check, to be caught four gates later by
  // the census. Bound to the living ancestor, a leaked file is a refusal here.
  const [writtenPid, writtenValue] = written.split(' ');
  if (writtenValue === undefined) {
    return `the nonce file holds ${JSON.stringify(written)}, which is not the \`<pid> <value>\` the gate writes`;
  }
  if (writtenValue !== value) {
    return `the nonce file holds the value ${JSON.stringify(writtenValue)} and P5_PACK_NONCE is ${JSON.stringify(value)}, so the value this run was handed is not the value the gate wrote for it`;
  }
  if (writerPid === undefined) {
    return "this run found no gate ancestor to compare the nonce file's writer with, so the nonce cannot be bound to a live run";
  }
  if (writtenPid !== String(writerPid)) {
    return `the nonce file was written by pid ${writtenPid} and the gate ancestor of THIS run is pid ${writerPid}, so the file belongs to another run of the gate -- a leaked one, which a signal leaves behind, is exactly this`;
  }
  return '';
};

/**
 * ROUND 60, AND IT IS THE HALF OF R56-S2 THAT PROPERTIES ALONE CANNOT REACH.
 * The predicate above measures what `mkdtemp(prefix='law-ran-pack-')` PRODUCES
 * -- that name, in the temporary directory, mode 700, this uid -- and anyone
 * who can export an environment variable can also `mkdir -m 700` a directory
 * with all four. Properties are not provenance.
 *
 * Provenance is readable, though, and not by anything the forger supplies: a
 * run the gate started is a DESCENDANT of the gate, so this walks its own
 * parent chain in `/proc` and looks for `tools/law-ran.py` in a cmdline. A
 * wrapper script that exports `P5_PACK_DIGEST` is not that program, which is
 * exactly the family the challenger's attack came from.
 *
 * Returns '' when an ancestor is the gate, and otherwise the reason it cannot
 * say so -- including "no /proc", which is a declared limit rather than a pass:
 * the caller refuses on any non-empty answer, so a platform without `/proc`
 * reds instead of waving the claim through. This container is Linux and the
 * suite's own cases read `/proc` elsewhere.
 */
/**
 * ROUND 60e, THE COMPLEMENT OF READING THIS CASE'S OWN SETTINGS. `it.concurrent`
 * and `describe.concurrent` mark ONE case or ONE suite, with the config and the
 * command line untouched, so a case that reads only its own `task` sees nothing
 * and the serial order this file's arms assume is gone for its neighbours. Every
 * task in THIS FILE is read instead, from `task.file` downward.
 *
 * `mode` is deliberately NOT read here: a filtered run (`-t`) leaves the other
 * cases `skip`, and refusing on that would red the way every reviewer debugs.
 * `concurrent` and `retry` are unaffected by filtering, and they are the two
 * that change what a pass MEANS.
 */
const concurrencyOffences = (node: Record<string, unknown>, into: string[]): void => {
  for (const task of (node.tasks as Array<Record<string, unknown>> | undefined) ?? []) {
    const kind = String(task.type ?? '');
    const name = String(task.name ?? '<unnamed>');
    if (task.concurrent === true) into.push(`${kind} ${JSON.stringify(name)} is concurrent`);
    if (Number(task.retry ?? 0) > 0) into.push(`${kind} ${JSON.stringify(name)} retries ${String(task.retry)} times`);
    concurrencyOffences(task, into);
  }
};

const GATE_PROGRAM = 'tools/law-ran.py';
// ROUND 61, THE COORDINATOR'S R60-C-03. The identity test below is `(dev,
// ino)` against THIS package's own gate, so it reads that file -- and when
// the file is not there the read THREW, which reaches a reader as a stack
// trace and not as a verdict. An absent gate is a real state (a checkout
// that dropped it, a run from a tree where it was deleted), and the rule for
// it is the rule for everything here: refuse BY NAME on ABSENCE.
const REFUSED_GATE_PROGRAM_ABSENT = 'REFUSED-GATE-PROGRAM-ABSENT';
const notStartedByTheGate = (
  procRoot = '/proc',
  startPid = process.pid,
  gatePath = join(__dirname, '..', GATE_PROGRAM),
  // ROUND 62: the ancestor's own pid, written out for the caller. The nonce
  // below must belong to THAT process and not merely to some run of the gate,
  // which is what the challenger's leaked-file replay turned on.
  found: { pid?: number } = {},
): string => {
  // THE COORDINATOR'S ADDITION TO R58: this is a claim about a PROCESS, so it
  // needs an arm that reds when the check is ABSENT or CANNOT RUN -- not only
  // when it fails. A claim about an instrument is verified by running it, so
  // the two things it reads are arguments: the /proc root and the pid to start
  // from. The arm below builds trees where each failure mode is the only thing
  // wrong, and reads which sentence comes back. Production passes neither
  // argument.
  if (!existsSync(join(procRoot, 'self', 'status')) && !existsSync(join(procRoot, String(startPid), 'status'))) {
    return `this platform has no readable ${procRoot}, so a run cannot be shown to descend from the gate at all`;
  }
  const seen: string[] = [];
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch (error) {
      return `the parent chain stopped at pid ${pid}, which cannot be read (${String(error)})`;
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent, so the chain cannot be followed`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
    let argv: string[] = [];
    try {
      argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((word) => word.length > 0);
    } catch {
      // A process that exited between the two reads leaves no cmdline. The walk
      // continues: an unreadable link in the chain is reported by the sentence
      // below if no gate is found above it, and never read as a pass.
    }
    seen.push(`${pid}: ${argv.join(' ').slice(0, 100)}`);
    // THE FIRST VERSION OF THIS LINE SAID `cmdline.includes(GATE_PROGRAM)`, AND
    // IT PASSED THE ATTACK IT WAS WRITTEN TO CATCH. Measured: the shell that
    // launched the forged run had the string `tools/law-ran.py` in its own
    // command line -- it computed the digest with a `python3 -c` program that
    // names the gate -- so an ANCESTOR matched and the arm called a hand-built
    // directory the gate's private copy. A substring over a whole command line
    // is a claim about text; being the gate is a claim about ARGV. So: argv[0]
    // is a python interpreter, and one of its arguments IS the gate's path.
    const program = argv[0] ?? '';
    // AND THE SECOND VERSION OF THIS LINE WAS A SUFFIX MATCH, WHICH IS A CLAIM
    // ABOUT A PATH AND NOT ABOUT A FILE: any `tools/law-ran.py` anywhere on the
    // filesystem satisfied it, so a copy of the gate under a directory of
    // someone's own choosing counted as the gate this law is part of. The
    // argument is RESOLVED and compared with the one gate in this package. A
    // word that does not resolve is simply not a match, and not an error
    // either: the walk continues and the sentence below reports the chain.
    // ROUND 60e: compared as a FILE, by device and inode, not as a resolved
    // PATH. `realpathSync` follows symlinks, so a symlinked gate already
    // matched, but a HARD LINK and a bind mount give the real file a second
    // path that resolves to itself -- and a path comparison would have refused
    // the real gate reached that way, which is a false red of the same shape as
    // the clock. The identity of a file is its (dev, ino).
    let ourGateStat;
    try {
      ourGateStat = statSync(gatePath);
    } catch (error) {
      return `${REFUSED_GATE_PROGRAM_ABSENT}: ${GATE_PROGRAM} cannot be read in this package (${String(
        error,
      )}), so no ancestor can be compared with it and descent from the gate cannot be decided either way`;
    }
    const sameFile = (candidate: string): boolean => {
      const st = statSync(candidate);
      return st.dev === ourGateStat.dev && st.ino === ourGateStat.ino;
    };
    // A RELATIVE argument resolves against the ANCESTOR's working directory,
    // not against this process's: `npm test` runs the gate as
    // `python3 -I tools/law-ran.py` with the package as its cwd, and resolving
    // that word here would have failed and produced a FALSE RED on the one path
    // this check exists to let through. The cwd is read from the same /proc
    // entry the chain is walked with.
    let ancestorCwd = '';
    try {
      ancestorCwd = realpathSync(join(procRoot, String(pid), 'cwd'));
    } catch {
      // Unreadable cwd leaves only the absolute form below, which is the safe
      // way round: a word that cannot be resolved is not a match.
    }
    const runsTheGate = argv.slice(1).some((word) => {
      for (const candidate of ancestorCwd === '' ? [word] : [word, join(ancestorCwd, word)]) {
        try {
          if (sameFile(candidate)) return true;
        } catch {
          // Not this word.
        }
      }
      return false;
    });
    if (basename(program).startsWith('python') && runsTheGate) {
      found.pid = pid;
      return '';
    }
  }
  return `no ancestor of this process is ${GATE_PROGRAM}; the chain is ${JSON.stringify(seen.slice(0, 8))}`;
};

/**
 * ROUND 57, THE CHALLENGER'S R54-S2 (P2), which it measured on the window I had
 * left open and timestamped: a document added one second into a run and removed
 * two seconds later sat in the pack for two of the run's twenty seconds, and
 * every digest check agreed, because comparing two endpoints keeps no journal of
 * what happened between them. Its own scoping is exact and worth keeping: that
 * is NOT a false green about the set at the instant the law looked — anything
 * present when the law reads the directory is caught — what it defeats is the
 * refusal's own wording, since a green implies the pack did not change while the
 * arm was reading, and there it had.
 *
 * Its remedy is the one taken here, because it REMOVES the window instead of
 * policing it: read a private SNAPSHOT, so the subject cannot move at all.
 * Journalling with inotify or mtimes would add a reader that can itself be
 * blinded.
 *
 * What is left, stated narrowly: the copy is not atomic, so a change landing
 * DURING it would make a mixed snapshot — which is why the source's digest is
 * taken BEFORE the copy and compared with the snapshot's, and the source is read
 * again at the end of the pass. The irreducible residue is a change that happens
 * and reverts entirely between two consecutive reads of the source; closing that
 * needs a filesystem snapshot, which is not this package's to arrange.
 */
const snapshotPack = (dir: string): string => {
  const into = mkdtempSync(join(tmpdir(), 'p5-pack-snapshot-'));
  // The challenger's asymmetry note on round 57c: the gate refuses a private
  // copy that lands inside a tree it measures, and this helper had no twin of
  // it. `tmpdir()` reads TMPDIR, TMP and TEMP and falls back to /tmp, so the
  // destination is operator-steerable, and a copy of 87 documents written
  // inside the repository is a directory this law's own census then walks --
  // which is how a hardening turns into a false red somewhere else entirely.
  // Refused here by the same name the gate uses, before anything is copied.
  const landed = realpathSync(into);
  for (const tree of [realpathSync(REPO), realpathSync(join(__dirname, '..'))]) {
    if (landed === tree || landed.startsWith(tree + sep)) {
      rmSync(into, { recursive: true, force: true });
      throw new Error(
        `${REFUSED_PACK_COPY_IMPOSSIBLE}: this arm's private copy of the pack landed at ${landed}, inside ${tree}, which is a tree this law measures. Point TMPDIR at a directory outside the repository`,
      );
    }
  }
  // The coordinator's R57-C-03 and R57-C-04, the law's half of both. Names are
  // listed as BUFFERS and round-tripped through UTF-8: a filename that is not
  // valid UTF-8 reaches a JavaScript string as replacement characters, so this
  // reader and `tools/law-ran.py` could never be reading one set of names, and
  // it is refused by name rather than quietly renamed by the decoder. And an
  // entry that is not a regular file is REFUSED, not skipped -- the signed
  // `29cef86` refused it through its digest (`<not-a-file>`), and a copier that
  // skips what it cannot classify drops it out of the measured set in silence.
  for (const raw of readdirSync(dir, { encoding: 'buffer' })) {
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw)) {
      rmSync(into, { recursive: true, force: true });
      throw new Error(
        `${REFUSED_PACK_NAME_NOT_UTF8}: ${dir} holds a filename that is not valid UTF-8 (${JSON.stringify(raw.toString('latin1'))}), so this law and tools/law-ran.py could not be reading one set of names. Rename it, or say in review why a name like that belongs here`,
      );
    }
    const from = join(dir, name);
    let isFile = false;
    try {
      isFile = statSync(from).isFile();
    } catch (error) {
      rmSync(into, { recursive: true, force: true });
      throw new Error(
        `${REFUSED_FILE_NOT_READABLE}: ${from} is in the pack and could not be read at all (${String(error)}), so this law would be measuring a set it never saw whole`,
      );
    }
    if (!isFile) {
      rmSync(into, { recursive: true, force: true });
      throw new Error(
        `${REFUSED_PACK_ENTRY_NOT_A_FILE}: ${from} is in the pack and is not a regular file, so it cannot be copied into the private directory this law measures and would drop out of the measured set in silence. The pack is a flat set of documents`,
      );
    }
    writeFileSync(join(into, name), readFileSync(from));
  }
  return into;
};

/**
 * ROUND 51, THE COORDINATOR'S CD-50-01 (P1). A gate that is only OFFERED as
 * its own script is a gate nobody runs: `npm test` could be made to collect
 * neither law file and still exit 0. This is the name the arm below refuses by
 * when the law gate is no longer chained into the command people run.
 */
const REFUSED_TEST_WITHOUT_LAW_GATE = 'REFUSED-TEST-DOES-NOT-RUN-THE-LAW';

/**
 * ROUND 52, THE COORDINATOR'S CD-51-01 (P1). Round 51's arm REGEX-MATCHED the
 * `test` script for the gate's command, which a single edit to the same file
 * satisfies while throwing the gate's verdict away:
 * `vitest run --exclude=<the law files>; python3 -I tools/law-ran.py; true`
 * printed 277 passed, then `LAW-NOT-RUN` from the gate -- which DID catch it --
 * and `npm test` exited 0 WITH A PLANT PRESENT, because `;` and `|| true`
 * discard an exit code. A regex says the command APPEARS; only byte equality
 * says the command is the whole of what runs. So the script is pinned as a
 * LITERAL, here and in the gate itself.
 */
const PINNED_TEST_SCRIPT = 'vitest run && python3 -I tools/law-ran.py && python3 -I tools/arms/pinned-now-arm.py tools/seal-check-run.py';

/**
 * The coordinator's R55-C-06 and the challenger's R55-S4 are the same file seen
 * from two sides. The arm program's BYTES were pinned a round ago and nothing
 * CALLED it: not `test`, not `gate:law`, no case, no CI. A pin bounds content;
 * only PLACEMENT bounds reach. So the arm is chained into the command people
 * run, with `&&` so a red arm stops the command, and its invocation is part of
 * the byte-equal pin above -- which is what arms the placement itself.
 */

/**
 * ROUND 53, THE COORDINATOR'S CD-52-01 (P1, a committed one-file fail-open).
 * Pinning the `test` script's bytes pins the COMMAND; it says nothing about the
 * SHELL that command is handed to. One committed file — `packages/billing/.npmrc`
 * holding `script-shell=/bin/true` — makes npm hand every script to a program
 * that runs nothing, so `npm test` and `npm run gate:law` both exit 0 with a
 * plant present and NOTHING runs at all. Measured before this fix. It also
 * defeats the CI closure named in the residual below, which is why
 * PATCH-REQ-P5-001 now asks for a CI step that runs `python3 -I
 * tools/law-ran.py` DIRECTLY rather than through npm.
 *
 * Nothing read that file, so the refusal is its ABSENCE being required: an
 * `.npmrc` beside this package, or at the repository root, is refused BY NAME.
 * If one is ever legitimately needed, it is a reviewed change and this sentence
 * changes with it.
 */
const REFUSED_NPM_CONFIG = 'REFUSED-NPM-CONFIG-PRESENT';

/**
 * ROUND 67, R65-F-1. The npm ancestor's own program, or a reason. npm rewrites
 * its process title, so `/proc/<pid>/cmdline` holds ONE entry ("npm test ...")
 * rather than argv as it was spelled -- measured, and the reason the first
 * version of this walk found no npm ancestor under `npm test`. The first
 * whitespace-separated word of the first entry is what names the program.
 */
const REFUSED_NPM_NODE_IS_NOT_THIS_ONE = 'REFUSED-NPM-RUNS-ON-ANOTHER-NODE';

const npmAncestorProgram = (procRoot = '/proc', startPid = process.pid): { exe: string; pid: number } | string => {
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let words: string[] = [];
    try {
      words = readFileSync(join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((word) => word.length > 0);
    } catch {
      // Keep walking; the link above may still be npm.
    }
    const head = basename((words[0] ?? '').split(/\s+/)[0] ?? '');
    if (head === 'npm' || words.some((word) => basename(word) === 'npm-cli.js')) {
      try {
        return { exe: realpathSync(join(procRoot, String(pid), 'exe')), pid };
      } catch (error) {
        return `pid ${pid} is npm and its program cannot be resolved (${String(error)})`;
      }
    }
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch (error) {
      return `the parent chain stopped at pid ${pid} (${String(error)})`;
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return 'no ancestor of this process is npm, so this run has one anchor';
};

/**
 * ROUND 51, THE COORDINATOR'S P3. An arm that read a pack document with no
 * guard failed with ENOENT when the pack was absent -- a stack trace, not a
 * verdict, and indistinguishable from a broken test. Absence is named.
 */
/**
 * ROUND 64, THE COORDINATOR'S R62-C-01 (P4). `NODE_OPTIONS` runs a module of
 * someone else's choosing inside the node that runs this suite, once per
 * process, before this file is reached -- and until this arm nothing read it.
 * The gate's closed environment dict stops it reaching the GATE's child, which
 * is why the finding is bounded to invocations that are not the gate's,
 * `npm test`'s first leg among them. Measured by the coordinator at `82e810c`:
 * `NODE_OPTIONS=--import=...` on a bare run of the law file ran the module, rc
 * 0, no refusal.
 */
const REFUSED_NODE_OPTIONS_LOADS_CODE = 'REFUSED-NODE-OPTIONS-LOADS-CODE';

/**
 * ROUND 65, THE CHALLENGER'S R60-F-1 (P1, a fail-open -- and a fail-open in the
 * fix for one). The round-64 arm read `NODE_OPTIONS` from `process.env`, and
 * its own refusal message says why that is the wrong place: the module runs
 * FIRST. Two loaders identical but for one line, measured by the challenger and
 * re-measured here:
 *
 *     globalThis.__LOADER_RAN__ = true;                      ->  refused
 *     globalThis.__LOADER_RAN__ = true;
 *     delete process.env.NODE_OPTIONS;                       ->  28/28 GREEN
 *
 * A reader inside what it measures reads a value its subject can delete. This
 * is the same class as round 62's `setupFiles` and the lesson written after it,
 * arriving in my own fix, which is the honest reason it is a P1 and not a nit.
 *
 * `/proc/self/environ` is the environment this process was EXEC'd with. It is a
 * snapshot of the initial stack region, so `delete process.env.X` and `setenv`
 * do not change it -- measured below in this container, not assumed. Absence is
 * refused BY NAME rather than falling back to `process.env`: falling back to
 * the channel the attacker controls is the fail-open itself, and this suite's
 * declared platform is Linux. A platform without `/proc` is a reviewed change
 * and this arm changes with it.
 */
/**
 * ROUND 65, R64-C-01. Flags this phase has established load NOTHING: they size
 * a heap, choose a warning, name a resolution order, or set a title. Anything
 * else in `NODE_OPTIONS`, or on the runner's own command line, is refused --
 * a flag that did not exist when this list was written included, which is the
 * whole point of inverting the direction.
 *
 * The list is small on purpose and it is a REVIEWED list: a flag added to it is
 * a flag somebody argued loads no code, in the commit that adds it. The four
 * code-loading forms are kept beside it, by name, because they are still what
 * the weaker half of the ancestry scan refuses and because naming them is how a
 * reader knows what this arm was built against.
 */
const KNOWN_CODE_LOADING_FORMS = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval', '-p', '--print'];
const LOADS_NOTHING = [
  '--max-old-space-size',
  '--max-semi-space-size',
  '--stack-size',
  '--max-http-header-size',
  '--unhandled-rejections',
  '--enable-source-maps',
  '--no-warnings',
  '--trace-warnings',
  '--disable-warning',
  '--no-deprecation',
  '--trace-deprecation',
  '--throw-deprecation',
  '--trace-exit',
  '--trace-uncaught',
  '--dns-result-order',
  '--use-openssl-ca',
  '--use-bundled-ca',
  '--experimental-import-meta-resolve',
  '--experimental-vm-modules',
];
/**
 * ROUND 66, FOUND WHILE MEASURING R61-S-3's SIBLING AND REMOVED FOR A REASON OF
 * ITS OWN. `--title` was in the list because it loads no code -- true, and
 * beside the point: it rewrites `/proc/<pid>/cmdline`, which is the EVIDENCE
 * this scan reads. Measured: `node --title probe <vitest.mjs> run <file>` makes
 * the runner's command line stop naming the script, so the flag region cannot
 * be bounded and that link falls to the unbounded half of this scan (round 68:
 * the same allow-list over everything that looks like a flag, which is where
 * the weaker form-list used to be). The `--import` beside
 * it was still refused (by the argv-pin arm, under
 * REFUSED-RUNNER-ARGV-OVERRIDES-THE-FILE), so nothing passed -- but an admitted
 * flag that edits the instrument has no business in a list of flags admitted
 * BECAUSE they change nothing this law reads.
 */
/**
 * ROUND 66, THE CHALLENGER'S R61-S-3. `--conditions` was in the list above on
 * the argument that it "names a resolution order". It is out: a condition can
 * redirect a package's `exports` to a DIFFERENT FILE, so it changes which code
 * runs, even though it cannot introduce a file the tree does not already hold.
 * Not measured as exploitable, and removed anyway, because the list is declared
 * to be a reviewed one and this is the review. The cost is real and stated: an
 * honest `NODE_OPTIONS=--conditions dev` on a bare run now reds, and a reader
 * who wants it back argues for it in the commit that puts it back. vitest's own
 * worker passes `--conditions` twice and is unaffected, because the scan reads
 * this process's ANCESTORS and not this process.
 */
const nodeTokenLoadsNothing = (token: string): boolean => LOADS_NOTHING.includes(token.split('=', 1)[0] ?? token);

/**
 * ROUND 66, R61-S-2, and the rule lives HERE rather than inside one reader
 * because the first fix for it reached only the `/proc` half and left the live
 * `process.env` half refusing `ipv4first`: one rule in two places is two rules.
 * Tokens of a flag region, judged. A token is refused unless it is admitted,
 * OR it is the VALUE of the admitted flag immediately before it (written
 * without `=`). A bare token standing on its own is still refused.
 */
const valueOfAnAdmittedFlag = (token: string, previous: string, allowed: (token: string) => boolean): boolean =>
  !token.startsWith('-') && previous.startsWith('-') && !previous.includes('=') && allowed(previous);

const tokensNotAdmitted = (tokens: readonly string[], allowed: (token: string) => boolean): string[] => {
  const out: string[] = [];
  let previous = '';
  for (const token of tokens) {
    if (!valueOfAnAdmittedFlag(token, previous, allowed) && !allowed(token)) out.push(token);
    previous = token;
  }
  return out;
};

/**
 * THE FLAG REGION OF A NODE COMMAND LINE, derived rather than recognised.
 *
 * ROUND 68, THE CHALLENGER'S R67-01 (P1), MEASURED BEFORE IT WAS REPORTED AS A
 * RESULT. Where the region could not be bounded, round 66 fell back to a LIST
 * OF FORMS, and `-e` and `--print` were not in it -- they need no module path
 * at all, they ARE the code:
 *
 *   node -e 'require("child_process").execSync("npx vitest run <the law>")'
 *     -> rc 0 on `ed0ce1c`, 31/31 green, arbitrary code in the parent of the
 *        runner, nothing refused.
 *
 * ROUND 68, THE CHALLENGER'S R62-F-1 (P1) in the same breath, and it is the
 * reason there is now ONE rule here and not two. The bounded half found the
 * script BY NAME (`endsWith('vitest.mjs')`), and the name is a string the
 * attacker writes too: a loader called `vitest.mjs` matched FIRST, the region
 * became `argv.slice(1, 1)`, and the whole command line went unscanned at
 * 31/31 green with the loader running.
 *
 * So neither half survives. The region is derived from node's own parsing:
 * walk the tokens after the program; a token that looks like a flag is judged
 * by the allow-list; a token that does not is the VALUE of the admitted flag
 * before it, or else it is the script -- whatever it is named -- and the
 * region ends there. No name is matched, so no name can end the region early,
 * and a flag nobody has heard of is refused with the rest rather than being
 * absent from a list.
 *
 * The one ambiguity node's own parsing has is a flag this list does not admit
 * whose value is a SEPARATE token: `--conditions dev --import=<loader>` ends
 * the region at `dev`. It is not a hole, because `--conditions` is itself
 * refused on the line above and the run reds there; an attacker gains nothing
 * by hiding a loader behind a flag that already refuses.
 *
 * DECLARED, and measured as the reason the region must end at all: tokens
 * AFTER the script are the SCRIPT's arguments, and the gate's own runner is
 * spawned with `--no-file-parallelism` among them. Judging those would red
 * every honest run. What runs inside the process because of them is covered
 * by the config shape pin and by the runner-program pin, not by this scan.
 */
const interpreterFlagRegion = (argv: readonly string[], allowed: (token: string) => boolean): string[] => {
  const region: string[] = [];
  let previous = '';
  for (const token of argv.slice(1)) {
    if (!token.startsWith('-') && !valueOfAnAdmittedFlag(token, previous, allowed)) break;
    if (token.startsWith('-')) region.push(token);
    previous = token;
  }
  return region;
};

const REFUSED_EXEC_ENVIRONMENT_UNREADABLE = 'REFUSED-EXEC-ENVIRONMENT-NOT-READABLE';
const REFUSED_HANDED_DOWN_ENV_EDITED = 'REFUSED-HANDED-DOWN-ENVIRONMENT-EDITED';

/**
 * The environment at exec time, keyed as it was handed to this process, or a
 * reason it cannot be read. NUL-separated, first `=` splits; a key with no `=`
 * is kept with an empty value so nothing is dropped in silence.
 */
/**
 * ROUND 65, SECOND ATTEMPT, AND THE FIRST ONE'S MEASUREMENT IS WHY. Reading
 * `/proc/self/environ` was not enough, and the self-hiding loader showed it in
 * one run: the loader executes in the RUNNER process first, deletes
 * `NODE_OPTIONS` from that process's `process.env`, and the worker is then
 * forked with an environment that never had it. Measured: the loader ran ONCE
 * (the runner), not three times, and `/proc/self/environ` in the worker carried
 * nothing to find -- so a reader looking only at itself sees an honest
 * environment while somebody else's module runs the program that collects the
 * results and writes the report.
 *
 * So the subject is not this process. It is this process AND every ancestor up
 * to the runner: each one's exec-time environment is read out of
 * `/proc/<pid>/environ`, which the process it belongs to cannot edit. A chain
 * link that EXISTS and whose environment cannot be read is refused by name
 * rather than skipped -- never skip what you cannot classify -- and a platform
 * with no readable `/proc` is refused by name too, because falling back to
 * `process.env` is the fail-open itself.
 */
/**
 * ROUND 65. The keys the gate hands down, compared between the environment this
 * process was EXEC'd with and the environment it has NOW. A process cannot edit
 * its own `/proc/<pid>/environ`, so a key present at exec and missing or changed
 * now was changed from INSIDE the run. Pure, and exercised by its own two cases
 * below with a clean pair and an edited pair, because an arm with no reachable
 * positive control is an arm nobody has run: every route into this process that
 * could do the editing (a setup file, a loaded module, a test file of one's own)
 * is refused EARLIER by another arm, which is the good news and the reason this
 * comparison cannot be provoked end to end today. It is a fourth rung under the
 * three of round 62, placed in the real path and measured as a function.
 */
/**
 * ROUND 65, THE COORDINATOR'S R64-C-03 (P4). The gate pins WHERE the runner is;
 * nothing compared WHICH interpreter it is, and a printed identity nobody
 * compares is a figure nobody measures. This derives it from THIS run's own
 * ancestry -- the real path behind `/proc/<runner>/exe` and that binary's own
 * `--version` -- and writes it into the receipt, where the gate compares it with
 * its OWN resolution. Two derivations of one identity, compared outside the file
 * either one could edit.
 *
 * A reason string is returned rather than a guess when it cannot be read, and
 * the gate refuses on a reason exactly as it refuses on a mismatch: an identity
 * this law cannot derive is not an identity that agrees.
 *
 * ROUND 67, THE COORDINATOR'S R65-C-02 (P3), the same narrowing from its other
 * side: this identity is a PATH plus a SELF-REPORTED version string, never
 * CONTENT. A binary placed at the resolved path satisfies both derivations,
 * because both describe the same path and `--version` is what that binary says
 * about itself. Nothing here hashes the runner, and nothing here would notice a
 * patched node sitting where the honest one sat.
 *
 * ROUND 66, THE CHALLENGER'S R61-S-1, narrowing what the pair is worth. A
 * DISAGREEMENT is refused; an AGREEMENT is worth exactly what the receipt is
 * worth. Measured by the challenger with three shims inside a pinned prefix:
 * a transparent wrapper that only execs the real node is caught (rc 1, the two
 * paths named), while a shim that lets the law run honestly and then patches
 * the two identity fields, and one that never starts node at all and rebuilds
 * the receipt from this run's handed-down values, are both rc 0. So this closes
 * the WRAPPER class and does not bound the actor who runs the suite -- that
 * actor owns the receipt this comparison reads. Same bound as the nonce and the
 * receipt itself, and the same narrowing the marker's claim took in round 64.
 */
const REFUSED_RUNNER_PROGRAM_UNPINNED = 'REFUSED-RUNNER-PROGRAM-NOT-PINNED';
const REFUSED_RUNNER_PACKAGE_NOT_LOCKED = 'REFUSED-RUNNER-PACKAGE-NOT-THE-LOCKED-ONE';

/**
 * THE PROGRAM THE RUNNER IS RUNNING, derived from the chain rather than from a
 * name this file chose. Walks the ancestors, takes the first link whose
 * program is a node binary, and returns the first token after its flag region
 * -- which is the script, by the same construction `interpreterFlagRegion`
 * uses and for the same reason: a name is a string the attacker writes too.
 */
const scriptOfTheRunner = (allowed: (token: string) => boolean, procRoot = '/proc', startPid = process.pid): { script: string; pid: number } | string => {
  if (!existsSync(join(procRoot, String(startPid), 'status'))) return `this platform has no readable ${procRoot}`;
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch {
      return `the chain ends at pid ${pid}, which is gone, so the runner's own program cannot be read`;
    }
    if (pid !== startPid) {
      let argv: string[] = [];
      try {
        argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
          .toString('utf8')
          .split('\0')
          .filter((word) => word.length > 0);
      } catch {
        return `pid ${pid} exists and its command line cannot be read, so the runner's own program cannot be read`;
      }
      const program = basename(argv[0] ?? '');
      if (program === 'node' || /^node[0-9.]*$/.test(program)) {
        let previous = '';
        for (const token of argv.slice(1)) {
          if (!token.startsWith('-') && !valueOfAnAdmittedFlag(token, previous, allowed)) return { script: token, pid };
          previous = token;
        }
        return `pid ${pid} runs node with no script of its own, so this run has no runner program to pin`;
      }
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent, so the chain cannot be followed to the runner`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return 'no ancestor of this process runs a node program, so the runner cannot be identified';
};

/**
 * A directory read as bytes: every file under it, by path relative to it, with
 * a symbolic link recorded as its TARGET rather than followed. Arrivals and
 * departures are both visible to the caller, because a census that only
 * checks the names it already knows fails open on the next file to appear.
 */
const bytesUnder = (root: string, repoRoot: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // A symbolic link is recorded as what it RESOLVES TO and never followed
      // as a file: the pinned package holds none today, and one that appears
      // is an ARRIVAL the comparison refuses rather than a file it hashes.
      //
      // ROUND 69, THE CHALLENGER'S R63-S-1 (P4, latent and closed before it
      // cost a round), in the THREE zones its second message asked for. An
      // ABSOLUTE target is a property of the CHECKOUT and not of the package,
      // so the first link to appear would make one pin true here and false in
      // CI. Two zones were not enough: a link inside the package pointing out
      // of the package but still inside the REPOSITORY has an absolute target
      // under the checkout root, which differs between any two clones and is
      // not a difference. So:
      //
      //   * a target inside the pinned package -> relative to the package;
      //   * a target elsewhere in the repository -> `repo:` and relative to
      //     the repository root;
      //   * a target outside the repository -> absolute, because a link into
      //     /opt or /usr IS a different tree in any sense that matters.
      if (entry.isSymbolicLink()) {
        const target = realpathSync(full);
        const zone = target.startsWith(`${root}${sep}`)
          ? relative(root, target)
          : target.startsWith(`${repoRoot}${sep}`)
            ? `repo:${relative(repoRoot, target)}`
            : target;
        out[rel] = `SYMLINK:${zone}`;
      } else if (entry.isDirectory()) walk(full, rel);
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(root, '');
  return out;
};

const runnerIdentity = (procRoot = '/proc', startPid = process.pid): { path: string; version: string } | string => {
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let argv: string[] = [];
    try {
      argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((word) => word.length > 0);
    } catch {
      // Keep walking: the link above may still be the runner.
    }
    if (argv.some((word) => word.endsWith('vitest.mjs') || basename(word) === 'vitest')) {
      let real: string;
      try {
        real = realpathSync(join(procRoot, String(pid), 'exe'));
      } catch (error) {
        return `the runner is pid ${pid} and its program cannot be resolved (${String(error)})`;
      }
      const asked = spawnSync(real, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      const said = (asked.stdout ?? '').trim();
      if (asked.status !== 0 || !said.startsWith('v')) {
        return `the runner at ${real} answered --version with status ${String(asked.status)} and ${JSON.stringify(said)}`;
      }
      return { path: real, version: said };
    }
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch (error) {
      return `the parent chain stopped at pid ${pid} (${String(error)})`;
    }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) return `pid ${pid} reports no parent`;
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return 'no ancestor of this process names the runner';
};

const HANDED_DOWN_KEYS = ['P5_PACK_DIGEST', 'P5_PACK_DIR', 'P5_PACK_NONCE', 'P5_PACK_NONCE_FILE', 'P5_LAW_RECEIPT'] as const;

const environmentEditedAfterExec = (
  atExec: Map<string, string> | string,
  live: Record<string, string | undefined>,
  keys: readonly string[] = HANDED_DOWN_KEYS,
): string[] =>
  // ROUND 67, THE COORDINATOR'S R65-C-03 (P4, a bound it asked me to state and
  // I would rather close). The predicate was `keys.filter(key =>
  // atExec.has(key))`, so a key that ARRIVED after exec was never compared --
  // departures and changes refused, arrivals not. A census pins its SET, both
  // directions, and this phase has ruled that twice. An arrival is now named
  // too. It cannot false-red an honest run: under the gate all five keys are
  // present at exec, and a run the gate did not start is handed none of them
  // and sets none of them from inside.
  atExec instanceof Map
    ? keys
        .filter((key) => atExec.has(key) || (live[key] ?? '') !== '')
        .filter((key) => (live[key] ?? '') !== (atExec.get(key) ?? ''))
        .map(
          (key) =>
            `${key} (exec: ${JSON.stringify(atExec.get(key) ?? null)}, now: ${JSON.stringify(live[key] ?? null)})${atExec.has(key) ? '' : ' -- an ARRIVAL: nothing handed this key down and something inside the run set it'}`,
        )
    : [];

const codeLoadingAncestry = (
  // ROUND 65, THE COORDINATOR'S R64-C-01 (P4). Round 64 refused a LIST of
  // code-loading forms, and a list of forms moves the hole from shape to TIME:
  // a flag node adds tomorrow is unrefused until somebody writes it in, exactly
  // as an enumerated exemption does. So the direction is inverted. The caller
  // hands in a predicate that says whether a token is KNOWN TO LOAD NOTHING,
  // and every other token is refused -- including one nobody has heard of.
  // Same lesson as the config's shape pin one rung out: pin the shape, not the
  // values you thought of.
  allowed: (token: string) => boolean,
  procRoot = '/proc',
  startPid = process.pid,
): { found: string[]; unreadable: string[]; platform: string } => {
  const found: string[] = [];
  const unreadable: string[] = [];
  if (!existsSync(join(procRoot, String(startPid), 'status'))) {
    return { found, unreadable, platform: `this platform has no readable ${procRoot}` };
  }
  // ROUND 66, THE CHALLENGER'S R61-S-2 (a false red of my own making). The
  // first version tested every whitespace-separated token against the list
  // independently, so the VALUE of an admitted flag was read as a flag:
  // `NODE_OPTIONS="--dns-result-order ipv4first"` refused `ipv4first`. A value
  // is not a flag. It is skipped only when the token before it is an admitted
  // flag written WITHOUT `=`, so a bare token standing on its own is still
  // refused rather than waved through: the skip is a rule about pairs, not a
  // hole for anything that lacks a dash.
  const scan = (tokens: string[], pid: number, where: string): void => {
    for (const token of tokensNotAdmitted(tokens, allowed)) found.push(`pid ${pid}${where}: ${token}`);
  };
  const offending = (value: string, pid: number): void => {
    scan(
      value.split(/\s+/).filter((word) => word.length > 0),
      pid,
      '',
    );
  };
  let pid = startPid;
  for (let hop = 0; hop < 32; hop += 1) {
    let status: string;
    try {
      status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    } catch {
      // The process is gone: it cannot be the live runner of this run, and the
      // link below it was already read.
      break;
    }
    try {
      const env = readFileSync(join(procRoot, String(pid), 'environ')).toString('utf8');
      for (const entry of env.split('\0')) {
        if (entry.startsWith('NODE_OPTIONS=')) offending(entry.slice('NODE_OPTIONS='.length), pid);
      }
    } catch (error) {
      unreadable.push(`pid ${pid} exists and its exec-time environment cannot be read (${String(error)})`);
    }
    // THE DOOR BESIDE IT, measured before this was written: the same module
    // loads from the RUNNER's own command line, with no variable at all --
    // `node --import=<module> node_modules/vitest/vitest.mjs run <file>` ran the
    // module in the runner and the suite was 28/28 GREEN. So the interpreter's
    // OWN flags are read too: a token is counted only when argv[0] is a node
    // binary and the token stands BEFORE the script, which is the only position
    // node treats as its own. A shell whose command line merely MENTIONS
    // `--import=` is not an interpreter loading a module, and counting it would
    // be a false red.
    //
    // AND THE FIRST VERSION OF THIS SCAN CAUSED ONE, which is why this line is
    // here: it read the command line of THIS process too, and vitest spawns its
    // own worker as
    // `node --experimental-import-meta-resolve --require <vitest>/suppress-warnings.cjs ...`.
    // A bare honest run went red on vitest's own flag. So the scan skips the
    // starting process and reads its ANCESTORS, which is where a human sets
    // flags; the worker's own argv is built by vitest FROM THE CONFIG, whose
    // SHAPE this law pins at both levels, so `poolOptions` with an `execArgv`
    // of someone's choosing refuses by name as an unlisted key. DECLARED: that
    // is the bound of this half -- the worker's flags are covered by the shape
    // pin, not by this scan.
    if (pid !== startPid)
      try {
        const argv = readFileSync(join(procRoot, String(pid), 'cmdline'))
          .toString('utf8')
          .split('\0')
          .filter((word) => word.length > 0);
        const program = basename(argv[0] ?? '');
        if (program === 'node' || /^node[0-9.]*$/.test(program)) {
          // ROUND 66, THE CHALLENGER'S R61-F-1, and ROUND 68, the challenger's
          // R62-F-1 and R67-01: three defects in two fixes, all of them in the
          // BOUNDARY of this region rather than in the judgement of its
          // tokens. The boundary is no longer recognised by name and the
          // judgement no longer has a weaker half for links the boundary could
          // not be found on -- `interpreterFlagRegion` derives it, and every
          // link, runner or ancestor, is judged by the one allow-list.
          //
          // Which flags a human may honestly write here is the allow-list's
          // declared cost and not this line's business: an unlisted flag reds,
          // and the commit that wants it back argues for it.
          scan(interpreterFlagRegion(argv, allowed), pid, ' (interpreter flag)');
        }
      } catch {
        // A cmdline that cannot be read is reported by the environ branch above
        // for the same pid, or the process is gone and the loop ends below.
      }
    const parent = /^PPid:\s*([0-9]+)$/m.exec(status);
    if (parent === null) {
      unreadable.push(`pid ${pid} reports no parent, so the chain cannot be followed`);
      break;
    }
    pid = Number(parent[1]);
    if (pid <= 1) break;
  }
  return { found, unreadable, platform: '' };
};

const executionEnvironment = (procRoot = '/proc'): Map<string, string> | string => {
  const where = join(procRoot, 'self', 'environ');
  let raw: Buffer;
  try {
    raw = readFileSync(where);
  } catch (error) {
    return `${where} cannot be read (${String(error)})`;
  }
  const out = new Map<string, string>();
  for (const entry of raw.toString('utf8').split('\0')) {
    if (entry.length === 0) continue;
    const cut = entry.indexOf('=');
    if (cut === -1) out.set(entry, '');
    else out.set(entry.slice(0, cut), entry.slice(cut + 1));
  }
  return out;
};

const REFUSED_REPO_HEAD_NOT_READABLE = 'REFUSED-REPO-HEAD-NOT-READABLE';

/**
 * ROUND 54, THE COORDINATOR'S CD-53-01 (P1, a fail-open of the named terminus).
 * The gate resolved its runner at `node_modules/vitest/vitest.mjs` under the
 * package FIRST, and `node_modules` is gitignored -- but ignored is not
 * untrackable. One `git add -f` of a nine-line stub that writes a fabricated
 * report made `python3 -I tools/law-ran.py` print `26 law cases ran inside 303
 * total, 0 skipped, 0 failed` and exit 0 with a plant present, and root
 * `npm ci` does NOT remove it, because this package is not a workspace. So the
 * committed file sat OUTSIDE the declared "node_modules is bounded by npm ci"
 * limit, and it defeated the one check this phase nominates for CI.
 *
 * What is required is that Git tracks NOTHING under either `node_modules`: an
 * installed tree is never committed, so an empty `git ls-files` there is the
 * honest invariant, and anything in it is a file someone forced into history.
 * Git being unreadable is refused by name too -- fail on ABSENCE.
 */
const REFUSED_TRACKED_NODE_MODULES = 'REFUSED-TRACKED-NODE-MODULES';
const REFUSED_GIT_NOT_READABLE = 'REFUSED-GIT-NOT-READABLE';

/** The pinned author-owned set, read from the repository and not from the pack. */
const pinnedPackSet = (): string[] => {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'pack-set.json'), 'utf8')) as { names?: unknown };
  const names = raw.names;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string' && n.length > 0)) {
    throw new Error(`${REFUSED_PACK_NOT_PINNED}: tools/pack-set.json has no non-empty list of names, so nothing names the set this gate measures`);
  }
  return [...(names as string[])].sort();
};

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

  it('F-73: the live scan READS every character of every logical line, and the expectation is not its own', async (ctx) => {
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
    ).toStrictEqual([
      'package.json',
      'test/law-bytes-are-pinned.test.ts',
      'test/tool-commands-are-isolated.test.ts',
      'tools/arms/pinned-now-arm.py',
      'tools/context-sites.py',
      'tools/law-ran.py',
      'tools/manifest-digests.py',
      'tools/pack-set.json',
      'tools/reviewer-reports.json',
      'tools/runner-bytes.json',
      'tools/seal-check-run.py',
      'tools/status-block.py',
      'tsconfig.build.json',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
    expect(
      existsSync(join(__dirname, 'law-bytes-are-pinned.test.ts')),
      `LAW-BYTES-MOVED: the separate reader that pins this law's bytes is gone, so an edit anywhere in this file would no longer be refused by name (CD-49-02: this refusal carries the name a deletion arm reads)`,
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

    // ROUND 50, CD-49-01's other half. The pin covers the files that decide
    // collection, but a pin cannot say that the step which checks EXECUTION is
    // still wired up. `tools/law-ran.py` runs outside this suite, as its own
    // npm script, and refuses by name (LAW-NOT-RUN) when the law's cases did
    // not run; this is what reds when that step is taken out of package.json.
    // Together: the law not running is caught there, that step being removed
    // is caught here, and both edited together with the pin updated is the
    // declared limit.
    //
    // CD-50-01 (P1), THE COORDINATOR'S, AND IT IS THE SAME HOLE ONE STEP OUT.
    // A gate in its own script is a gate NOBODY RUNS. The coordinator measured
    // it: with `exclude: ['test/db/**'].concat('test/l*-pinned.test.ts',
    // 'test/tool-c*.test.ts')` in the vitest config, `npm test` printed 277
    // passed and exited 0 WITH THE PLANT PRESENT, because the pin check lives
    // in an excluded file and nothing called `gate:law` -- not `test`, not CI
    // (there is none for this package), not a hook. Pinning the config's bytes
    // does not help: the pin check is in a file the config just excluded.
    // So the law gate is now chained into THE COMMAND PEOPLE ACTUALLY RUN.
    // `npm test` is `vitest run && python3 -I tools/law-ran.py`, and
    // `law-ran.py` starts its own run and refuses LAW-NOT-RUN unless both law
    // files were collected and ran their literal case counts -- so the
    // exclusion above now reds `npm test` itself. This arm is what reds when
    // the chaining is taken back out, and it reads the SCRIPT NAMES, not a
    // count: a gate present under some other name is not a gate `npm test`
    // reaches.
    const scripts = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    const runsTheGate = new RegExp(['python3', '-I', 'tools/law-ran\\.py'].join('\\s+'));
    const lawRan = Object.entries(scripts)
      .filter(([, command]) => runsTheGate.test(command))
      .map(([name]) => name)
      .sort();
    expect(
      lawRan,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: \`npm test\` no longer runs \`python3 -I tools/law-ran.py\`, so the command people actually run can be made to collect neither law file and still exit 0 (CD-50-01). The gate must be chained into \`test\` itself, not only offered as \`gate:law\``,
    ).toStrictEqual(['gate:law', 'test']);
    // CD-52-01: and no npm configuration stands between that command and a
    // shell that runs it. `script-shell` is the one that silences everything
    // here, but any `.npmrc` can set it, so the file's presence is what is
    // refused rather than a key inside it -- a whitelist of keys is a list of
    // the ones thought of (B-10), and this is a file that need not exist.
    for (const where of [join(__dirname, '..'), REPO]) {
      expect(
        existsSync(join(where, '.npmrc')),
        `${REFUSED_NPM_CONFIG}: ${join(where, '.npmrc')} exists. npm configuration can replace the shell every script is handed to -- \`script-shell=/bin/true\` makes \`npm test\` and \`npm run gate:law\` exit 0 with nothing run at all -- so this law requires that no such file exists. If one is legitimately needed, that is a reviewed change and this arm changes with it`,
      ).toBe(false);
    }

    // CD-51-01: and the script is the pinned LITERAL, byte for byte. A regex
    // match says the gate's command appears somewhere in the script; equality
    // says it is the whole of what runs, so `;` or `|| true` after it, or a
    // `--exclude` before it, is a changed literal rather than a passing regex.
    expect(
      scripts['test'],
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: the \`test\` script is not the pinned command. It must be exactly \`${PINNED_TEST_SCRIPT}\` -- \`&&\` so a red first leg stops the second, and nothing after the gate to discard its exit code. If this command must change, change it HERE in the same commit and say why in the message`,
    ).toBe(PINNED_TEST_SCRIPT);
    // ROUND 59: the runner's per-case clock is part of what decides whether
    // this law RUNS to a verdict. At vitest's 5000ms default, a container under
    // load turned the heaviest case into `Test timed out in 5000ms` -- rc 1,
    // one failed case, and no refusal name anywhere -- which is the root cause
    // of the red this pack recorded at 21:11:05 rather than calling it a flake,
    // reproduced deliberately with twelve busy loops on four CPUs. The value
    // lives in `vitest.config.ts`, whose bytes are pinned; it is READ here so
    // that it is not merely pinned, because a number nobody reads can drift
    // back to a false-red default in a diff that looks like a cleanup.
    // ROUND 60d, AND IT IS A FAIL-OPEN OF EVERYTHING BELOW THIS LINE. Reading
    // the settings out of `vitest.config.ts` -- even reading them by value, even
    // with the file's bytes pinned -- says what the FILE asks for and not what
    // the RUN does, because vitest takes the same settings on the command line:
    // `--testTimeout=5000` and `--sequence.concurrent` restore the two
    // dangerous defaults with the config, its pin and the floor below all
    // green. Measured, from the run's own task object:
    //
    //   plain                                       timeout 120000, concurrent undefined
    //   --testTimeout=5000 --sequence.concurrent    timeout 5000,   concurrent true
    //
    // It is the same rung as `.npmrc` setting `script-shell` while the
    // command's TEXT was pinned: the shell is part of the command, and the
    // command line is part of the runner. So the EFFECTIVE values are read
    // first, out of the run this case is executing in, and the file is read
    // after that -- the file reader stays because it catches a config edited to
    // drop a setting, which the run reader cannot distinguish from a default
    // that happens to be right.
    const task = (ctx as unknown as { task?: Record<string, unknown> }).task;
    expect(
      typeof task,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this runner gave the case no task object, so this arm cannot read the settings the RUN is actually using and would be left reading the config file alone, which a command-line flag overrides`,
    ).toBe('object');
    const effective = task ?? {};
    expect(
      Number(effective.timeout ?? 0),
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: the per-case timeout this RUN is using is ${String(effective.timeout)}ms, under the 60000ms floor, whatever vitest.config.ts says -- so machine load alone can red this law without naming a refusal. A --testTimeout flag or a VITEST_ environment key reaches this value without touching the config or its pin`,
    ).toBeGreaterThanOrEqual(60_000);
    expect(
      effective.concurrent === true,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this RUN is executing the law's cases CONCURRENTLY, whatever vitest.config.ts says, so the pack arm's snapshot races the arms that write temporary directories and the serial order these cases assume does not hold`,
    ).toBe(false);
    expect(
      Number(effective.retry ?? 0),
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this RUN retries a failed case ${String(effective.retry)} times, whatever vitest.config.ts says, and a red case retried green reports as passed in the JSON the gate reads with the case count unchanged`,
    ).toBe(0);
    expect(
      effective.shuffle === true,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this RUN is shuffling case order, whatever vitest.config.ts says, so an order-dependent pass or failure here is not reproducible`,
    ).toBe(false);
    expect(
      String(effective.mode),
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this case's mode in this RUN is ${String(effective.mode)}, not 'run' -- a skipped or todo case asserts nothing, and the gate's count would not see the difference if the mode were applied to others`,
    ).toBe('run');
    const fileNode = effective.file as Record<string, unknown> | undefined;
    expect(
      typeof fileNode,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this runner gave the case no handle on its own FILE, so this arm can read its own settings and nothing about its neighbours -- and one it.concurrent beside it would not be visible`,
    ).toBe('object');
    const siblings: string[] = [];
    if (fileNode !== undefined) concurrencyOffences(fileNode, siblings);
    expect(
      siblings,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: a case or suite in this very file runs concurrently or retries, which no config setting and no command-line flag has to show: it.concurrent and describe.concurrent mark one case at a time. The arms in this file write temporary directories, spawn processes and read a private snapshot of the pack, and they assume they are the only one doing so`,
    ).toStrictEqual([]);
    // ROUND 61, THE CHALLENGER'S F-2 (P1 FAIL-OPEN) AND THE COORDINATOR'S SAME
    // RULING. Every per-key read here was a REGEX over the config's text, and a
    // regex takes the FIRST occurrence of a key while JavaScript takes the
    // LAST. Measured by the challenger: one appended
    // `dangerouslyIgnoreUnhandledErrors: true`, the byte pin moved with it, and
    // a planted unhandled rejection -- the runner exited 0 with 307 passed and
    // the gate exited 0, where without the duplicate the same plant reds.
    // esbuild prints a duplicate-key WARNING and nothing here read it.
    //
    // A regex over a source file was the wrong instrument twice over, and this
    // is the same lesson as the comments that fooled the first version of this
    // arm: a text match says what the file CONTAINS, not what the program
    // MEANS. So the settings are read as VALUES from two resolved objects:
    //
    //   the RUNNER's own resolved config, out of the worker vitest is running
    //   this case in -- the authority for what this run uses, flags included;
    //   the CONFIG MODULE, imported, so duplicate keys resolve the way the
    //   runner's own loader resolves them, for the settings the worker's
    //   resolved config does not carry (fileParallelism and
    //   dangerouslyIgnoreUnhandledErrors are absent from it here, measured).
    //
    // And every key present in both must AGREE, so a divergence between what
    // the file says and what the run uses refuses by name instead of being
    // split between two readers.
    const workerConfig = (globalThis as unknown as { __vitest_worker__?: { config?: Record<string, unknown> } }).__vitest_worker__?.config;
    expect(
      typeof workerConfig,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this runner exposes no resolved config to the worker, so this arm would be left matching the config file's TEXT -- which is the fail-open the challenger measured at round 57 (a duplicate key reads as its FIRST occurrence here and as its LAST in JavaScript)`,
    ).toBe('object');
    const resolved = workerConfig ?? {};
    const moduleConfig = ((await import('../vitest.config')) as { default?: { test?: Record<string, unknown> } }).default?.test;
    expect(
      typeof moduleConfig,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts does not import as a config with a \`test\` section, so the settings the worker's resolved config omits could not be read as values at all`,
    ).toBe('object');
    const fromModule = moduleConfig ?? {};
    const sequence = (resolved.sequence ?? {}) as Record<string, unknown>;
    const moduleSequence = (fromModule.sequence ?? {}) as Record<string, unknown>;
    // ROUND 61, THE COORDINATOR'S R60-C-04 AND R60-C-05. These were thirteen
    // separate assertions, and thirteen separate assertions answer thirteen
    // separate questions: each one says a value is what it should be, and none
    // of them says the SET is the set. A key that disappears from the resolved
    // config between vitest versions reads as `undefined` against its wanted
    // value and reds, which is correct; a key that ARRIVES, or one this arm
    // forgets to list, is not a question anyone asked. So the eleven settings
    // the RUN decides are built into one object and compared with one
    // `toStrictEqual`, which answers "are these exactly these" in a single
    // reading, and prints the whole disagreement at once when it is not.
    //
    // The authority for each setting is named by which object it comes from:
    // `run` is the runner's resolved config -- the eleven below -- and `file`
    // is the imported module, for the two the worker's resolved config does
    // not carry at all (measured, even when the flags are passed). Why each
    // one can decide a verdict is written in `vitest.config.ts` beside the
    // setting itself.
    const settingsOfThisRun = {
      testTimeout: resolved.testTimeout,
      hookTimeout: resolved.hookTimeout,
      retry: resolved.retry,
      bail: resolved.bail,
      allowOnly: resolved.allowOnly,
      passWithNoTests: resolved.passWithNoTests,
      isolate: resolved.isolate,
      maxConcurrency: resolved.maxConcurrency,
      pool: resolved.pool,
      'sequence.shuffle': sequence.shuffle,
      'sequence.concurrent': sequence.concurrent,
    };
    expect(
      settingsOfThisRun,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: the settings THIS RUN is using are not the eleven this law's verdict depends on. A default is not a decision, a value read from the config file's TEXT is not the value the run uses, and a command-line flag moves the run without moving the file: today \`--pool=threads\` and \`--retry=1\` are both reachable from the shell. Read the object printed beside this sentence against the one it was compared with`,
    ).toStrictEqual({
      testTimeout: 120_000,
      hookTimeout: 120_000,
      retry: 0,
      bail: 0,
      allowOnly: false,
      passWithNoTests: false,
      isolate: true,
      maxConcurrency: 1,
      pool: 'forks',
      'sequence.shuffle': false,
      'sequence.concurrent': false,
    });
    // The two the resolved config does not carry, read from the imported
    // module -- and the gate forces both on the command line as well, so the
    // run cannot be using a value this file never states.
    expect(
      { fileParallelism: fromModule.fileParallelism, dangerouslyIgnoreUnhandledErrors: fromModule.dangerouslyIgnoreUnhandledErrors },
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts does not ask for fileParallelism: false and dangerouslyIgnoreUnhandledErrors: false. The second one decides whether an unhandled rejection is rc 1 or rc 0, which is the whole of round 60c`,
    ).toStrictEqual({ fileParallelism: false, dangerouslyIgnoreUnhandledErrors: false });
    // ROUND 62, THE CHALLENGER'S F-1 (P1), THE CLASS AND NOT THE INSTANCE.
    // Thirteen settings were pinned BY VALUE and every one of their NAMES was
    // checked for a duplicate, and the attack used none of them: it added a
    // key this law had never heard of. `setupFiles: ['./test-neuter.ts']`,
    // with a setup file deleting P5_PACK_DIGEST, P5_PACK_NONCE and
    // P5_PACK_NONCE_FILE, ran at gate rc 0 with all 306 cases green.
    //
    // A pin on the VALUES of the keys you thought of is not a pin on the
    // config. The SHAPE is pinned here: the test section holds exactly these
    // keys, so a key nobody listed is a refusal by name rather than a silent
    // new instrument. Adding a setting to this config is a one-line change to
    // the list below, in the same commit, with its reason -- which is the
    // point, because that line is what a reviewer reads.
    expect(
      Object.keys(fromModule).sort(),
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts's \`test\` section does not hold exactly the keys this law pins. A key this law has never heard of is a runner instrument nobody reviewed: at round 58 one added \`setupFiles\` whose setup file deleted P5_PACK_DIGEST, P5_PACK_NONCE and P5_PACK_NONCE_FILE, which switched off privacy, ancestry, the nonce and the movement check in one line at rc 0`,
    ).toStrictEqual([
      'allowOnly',
      'bail',
      'dangerouslyIgnoreUnhandledErrors',
      'exclude',
      'fileParallelism',
      'hookTimeout',
      'include',
      'isolate',
      'maxConcurrency',
      'passWithNoTests',
      'pool',
      'retry',
      'sequence',
      'testTimeout',
    ]);
    // ROUND 62b, THE COORDINATOR'S §1 CLOSING NOTE: "the next round should
    // enumerate the class rather than close one member of it, because an
    // enumerated exemption moves the hole from shape to time". The six settings
    // it named are `setupFiles`, `globalSetup`, `environment`, `alias`,
    // `define` and `plugins`, and they do not all live in the same place:
    // `define` and `plugins` are VITE settings, outside `test` entirely, so a
    // shape pinned on the test section alone would have let two of the six
    // through. The config's TOP LEVEL is pinned too, at one key.
    const wholeModule = ((await import('../vitest.config')) as { default?: Record<string, unknown> }).default ?? {};
    expect(
      Object.keys(wholeModule).sort(),
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts's default export does not hold exactly the keys this law pins. \`define\` and \`plugins\` are vite settings that live HERE and not under \`test\`, and either one can run code or rewrite what the subject reads -- so a shape pinned only on the test section would admit two of the six settings the coordinator's round-61 review named`,
    ).toStrictEqual(['test']);
    expect(
      { include: fromModule.include, exclude: fromModule.exclude, sequence: Object.keys(moduleSequence).sort() },
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: the config's two collection settings and the shape of its \`sequence\` are not what this law pins. \`include\` and \`exclude\` decide which files are collected at all, which is the rung above every value pinned here`,
    ).toStrictEqual({ include: ['test/**/*.test.ts'], exclude: ['test/db/**'], sequence: ['concurrent', 'shuffle'] });
    // And the same key as the RUN sees it, which is not the same claim this
    // comment used to make. IT SAID the shape pin "closes the same key coming
    // in on the command line instead", and the challenger measured that
    // vacuous for this key: vitest 4.1.11 answers ``CACError: Unknown option
    // `--setupFiles` ``, so there is no command-line route to close. Corrected
    // rather than softened. What the read below IS worth: `setupFiles` is
    // absent from the pinned shape above, and this is the RUN's own resolved
    // value, so any route that does reach the run -- a route neither the
    // challenger nor this author has enumerated -- refuses here.
    // And the two the resolved config does not carry, read from the COMMAND
    // LINE rather than from the file -- the coordinator's R61-C-03.
    const flagsOfThisRun = undefendedFlagsOfThisRun();
    expect(
      flagsOfThisRun,
      `${REFUSED_RUNNER_ARGV_OVERRIDES_THE_FILE}: this run's own command line carries a setting the config file cannot see. \`--dangerously-ignore-unhandled-errors\` turns an unhandled rejection from rc 1 into rc 0, and \`--file-parallelism\` runs this file's arms beside their neighbours; neither appears in the worker's resolved config, so until this read they were pinned only in a FILE the command line overrides. The gate forces the negative form of both, which defends \`npm test\` and nothing else`,
    ).toStrictEqual([]);
    expect(
      (resolved.setupFiles ?? []) as unknown[],
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: this RUN has setup files, which the pinned config shape does not allow. A setup file runs before every test file and can edit the environment this law reads`,
    ).toStrictEqual([]);
    // The two readers must not disagree where both can see. A flag, an
    // environment key or a duplicate that moves one and not the other is a run
    // whose settings nobody can state, and that is refused rather than averaged.
    for (const key of ['testTimeout', 'hookTimeout', 'retry', 'bail', 'allowOnly', 'passWithNoTests', 'isolate', 'maxConcurrency', 'pool'] as const) {
      if (fromModule[key] === undefined) continue;
      expect(
        resolved[key],
        `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts asks for ${key} = ${JSON.stringify(fromModule[key])} and this RUN is using ${JSON.stringify(resolved[key])}, so the file and the run are two different instruments and no sentence about this law's settings is true of both`,
      ).toStrictEqual(fromModule[key]);
    }
    for (const key of ['shuffle', 'concurrent'] as const) {
      if (moduleSequence[key] === undefined) continue;
      expect(
        sequence[key],
        `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts asks for sequence.${key} = ${JSON.stringify(moduleSequence[key])} and this RUN is using ${JSON.stringify(sequence[key])}`,
      ).toStrictEqual(moduleSequence[key]);
    }
    // A DUPLICATE KEY is refused on its own, by name, even though both readers
    // above now resolve it the way the runner does. It is what F-2 was built
    // on, the runner's own bundler only WARNS about it, and a config with one
    // key written twice cannot be reviewed by reading it: whoever reviews the
    // diff reads the first one.
    const runnerConfigText = readFileSync(join(__dirname, '..', 'vitest.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const duplicated = (
      [
        'testTimeout',
        'hookTimeout',
        'retry',
        'bail',
        'allowOnly',
        'passWithNoTests',
        'isolate',
        'pool',
        'fileParallelism',
        'maxConcurrency',
        'sequence',
        'dangerouslyIgnoreUnhandledErrors',
        'shuffle',
        'concurrent',
      ] as const
    )
      // ROUND 62, THE CHALLENGER'S S-1. The pattern was `\bkey:`, which reads
      // the bare form only: `'isolate': false` and `"isolate": false` are the
      // same key to JavaScript and were invisible here, so a duplicate written
      // in quotes left the count at 1. All three spellings are counted now.
      // What remains OUT of reach is a COMPUTED key (`['iso' + 'late']: false`),
      // which no regex over the text can resolve -- and the pinned SHAPE above
      // is what catches that one, because a computed key still appears in
      // `Object.keys` of the imported module.
      .filter((key) => (runnerConfigText.match(new RegExp(`(\\b|['"])${key}['"]?:`, 'g')) ?? []).length > 1);
    expect(
      duplicated,
      `${REFUSED_TEST_WITHOUT_LAW_GATE}: vitest.config.ts writes a setting TWICE. JavaScript takes the last occurrence and a reader takes the first, which is exactly how a duplicate dangerouslyIgnoreUnhandledErrors passed this arm at round 57. Write each setting once, where its reason is`,
    ).toStrictEqual([]);
    //
    // THE RESIDUAL THIS ARM DOES NOT CLOSE, STATED AS MEASURED -- AND THE
    // PREVIOUS WORDING OF THIS PARAGRAPH WAS FALSE, which R51-F1 measured and
    // which is corrected here rather than softened. It said the attack "must
    // change bytes two programs declare, so it appears in the diff beside a
    // digest line". It does not. With
    // `vitest run --exclude=<both law files>; python3 -I tools/law-ran.py; true`
    // in `scripts.test`, the whole working tree is ` M packages/billing/
    // package.json` -- `tools/law-bytes.json` UNTOUCHED, no digest line at all
    // -- because the file that reads the pin is excluded from collection by the
    // same edit. The second false clause: that paragraph sent a reader OUTWARD
    // for the discarding caller, while the caller is `scripts.test` itself,
    // INSIDE this package and inside the set this pin covers.
    //
    // What is true. An exit code DISCARDED by the command that ran this suite
    // cannot be recovered by anything this suite does: `; true` and `|| true`
    // throw away vitest's verdict and the gate's alike. The residual is
    // therefore ONE EDIT TO ONE FILE, `package.json`, visible in the diff as
    // that file alone and nothing else. What this arm and the gate's twin of it
    // buy is not a bound on the diff but a VOICE: `tools/law-ran.py` is never
    // excluded by a vitest filter, it reads `scripts.test` itself, and under
    // that attack it refuses by name -- "the `test` script is '…; true', not
    // the pinned …" -- at rc 1 of its own, printed into the output npm then
    // discards. The terminus is
    // a check that does not pass through this package's own files at all: a CI
    // step that runs `python3 -I tools/law-ran.py` DIRECTLY and reads its exit
    // code -- not `npm test` and not `npm run gate:law`, because npm
    // CONFIGURATION is part of what an author controls here. CD-52-01 is the
    // proof: one committed `.npmrc` with `script-shell=/bin/true` makes npm and
    // npx alike run nothing and exit 0, so a CI step phrased as an npm script
    // would have been silenced by that same single file. This package has no CI
    // and is not in the root workspaces; that is PATCH-REQ-P5-001, with the
    // Repo/CI owner, and it is the closure of this regress rather than
    // hygiene.

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

  it('CD-53-01/R53-03: Git tracks nothing under node_modules, and no npm shell override reaches this run', () => {
    // The runner the gate starts is resolved by PATH under the package, which
    // bounds WHICH program runs and says nothing about WHO WROTE IT. A
    // force-committed `packages/billing/node_modules/vitest/vitest.mjs` is
    // immune to `npm ci` here (this package is not a workspace), survives a
    // fresh clone, and fabricates the gate's own figures. This arm refuses the
    // only honest invariant: an installed tree is not committed.
    //
    // F-61 holds: every argument reaching `spawnSync` is a literal or a path
    // this file computed. Nothing a document supplies is passed. The git
    // invocation is the pinned one -- absolute program, `/usr/bin` PATH only,
    // replace objects disabled, and no inherited `GIT_*` reaching it, because
    // `GIT_DIR` would beat any directory given.
    for (const where of [join(__dirname, '..'), REPO]) {
      const probe = spawnSync('/usr/bin/git', ['--no-replace-objects', 'ls-files', '-z', '--', 'node_modules'], {
        cwd: where,
        encoding: 'utf8',
        env: { PATH: '/usr/bin', GIT_NO_REPLACE_OBJECTS: '1' },
        timeout: 60_000,
      });
      expect(
        probe.status,
        `${REFUSED_GIT_NOT_READABLE}: \`git ls-files -- node_modules\` in ${where} did not answer (status ${String(probe.status)}), so this arm cannot say whether a runner was committed: ${JSON.stringify((probe.stderr ?? '').trim().slice(0, 200))}`,
      ).toBe(0);
      const tracked = (probe.stdout ?? '').split('\0').filter((entry) => entry.length > 0);
      expect(
        tracked,
        `${REFUSED_TRACKED_NODE_MODULES}: Git tracks ${tracked.length} path(s) under ${join(where, 'node_modules')}. An installed tree is never committed, and a committed file there can BE the runner this phase's gate starts: one such stub fabricates the gate's figures at rc 0 and no \`npm ci\` removes it (CD-53-01). If a path there must be tracked, that is a reviewed change and this arm changes with it`,
      ).toStrictEqual([]);
    }

    // R53-03: the env half of CD-52-01 had a single reader, `tools/law-ran.py`.
    // This is its twin, so neither is the only reader -- and it is matched
    // case-INSENSITIVELY, because npm honours `NPM_CONFIG_SCRIPT_SHELL` as
    // well as the lower-case spelling (R53-02). npm's own per-script variables
    // are not refused, only the two that replace the shell.
    //
    // R52-S1, said here rather than elsewhere: set through `npm test`, that
    // variable stops this suite from being run at all, so this arm can only
    // ever refuse an invocation where no npm stands between the command and
    // the run -- which is where the variable is already harmless. What bounds
    // the npm path is a CI step that calls the gate directly
    // (PATCH-REQ-P5-001), not this arm.
    //
    // R52-S2: `npm_config_userconfig` and `npm_config_globalconfig` carry the
    // same override from a file elsewhere, and npm sets BOTH itself on every
    // script run, so their presence cannot be refused. Their VALUE is checked
    // instead -- the file they name may not set `script-shell` -- which is the
    // same shape as the `.npmrc` arm above and refuses none of npm's defaults.
    //
    // ROUND 65, the sweep R60-F-1 forces: every OTHER quantity this case reads
    // from the environment is read from the same deletable channel, and a module
    // that can delete `NODE_OPTIONS` can delete these. So the keys below are
    // taken from the EXEC-TIME environment and from `process.env` together --
    // the union, so neither a deletion nor a late addition hides one.
    const atExec = executionEnvironment();
    expect(
      typeof atExec === 'string' ? atExec : '',
      `${REFUSED_EXEC_ENVIRONMENT_UNREADABLE}: this case reads the environment this process was EXEC'd with, because a module loaded through NODE_OPTIONS runs before this file and can edit process.env. ${typeof atExec === 'string' ? atExec : ''}`,
    ).toBe('');
    const environmentKeys = [...new Set([...(atExec instanceof Map ? atExec.keys() : []), ...Object.keys(process.env)])];
    const environmentValue = (key: string): string => ((atExec instanceof Map ? atExec.get(key) : undefined) ?? process.env[key] ?? '').trim();
    const shellOverrides = environmentKeys.filter((key) => ['npm_config_script_shell', 'npm_config_shell'].includes(key.toLowerCase().replace(/-/g, '_')));
    expect(
      shellOverrides,
      `${REFUSED_NPM_CONFIG}: ${shellOverrides.join(', ')} is set in this run's environment. That replaces the shell npm hands every script to, exactly as \`script-shell\` in an .npmrc does, so the pinned command would be handed to a program of someone else's choosing`,
    ).toStrictEqual([]);

    const namedConfigs = environmentKeys
      .filter((key) => ['npm_config_userconfig', 'npm_config_globalconfig'].includes(key.toLowerCase().replace(/-/g, '_')))
      .map((key) => ({ key, file: environmentValue(key) }))
      .filter(({ file }) => file.length > 0 && existsSync(file));
    for (const { key, file } of namedConfigs) {
      const sets = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => (line.split('=', 1)[0] ?? '').trim().toLowerCase().replace(/_/g, '-'))
        .filter((name) => name === 'script-shell' || name === 'shell');
      expect(
        sets,
        `${REFUSED_NPM_CONFIG}: ${key} names ${file}, which sets ${sets.join(', ')}. That replaces the shell npm hands every script to, from a file outside the two this law checks`,
      ).toStrictEqual([]);
    }

    // The coordinator's R55-C-04: npm reads its DEFAULT user config
    // (`~/.npmrc`) and its default global config (beside the node that runs
    // it) whether or not a variable names either one, and `tools/law-ran.py`
    // checks both. Until this arm, the gate was their ONLY reader, which is
    // the single-reader shape R53-03 closed for the env half: run the suite
    // without the gate and a default config setting `script-shell` went
    // unread. The twin lives here, reading the same two paths by the same
    // rule, and neither file is required to exist.
    //
    // ROUND 68, THE CHALLENGER'S R62-S-1 (P2), which asked what these FILE
    // readers catch that the ENVIRONMENT reader does not, since in the
    // `npm test` path npm exports every config it reads as `npm_config_*` and
    // the environment arm speaks first. Measured here rather than argued: with
    // an `.npmrc` beside this package and the suite started WITHOUT npm
    // (`npx vitest run <this file>`), the run reds at
    // REFUSED-NPM-CONFIG-PRESENT naming the file, and the environment holds
    // three `npm_config_*` keys, none of them a shell. A run npm did not start
    // exports nothing about a config file that is nonetheless sitting there
    // for the next npm the suite itself spawns, so the file readers' reach is
    // their own and this is the measurement that says so.
    //
    // ROUND 68, THE COORDINATOR'S R67-C-01 (P2), correcting something I wrote.
    // (ROUND 69, THE CHALLENGER'S POINT OF RECORD: an earlier draft of this
    // comment said the challenger had repeated the claim. It did not -- it
    // searched its own frozen reports and the sentence is in none of them, and
    // neither is it in any message of its I hold. The error was mine twice:
    // the explanation, and then the attribution.) I explained the
    // non-reproduction by saying
    // npm puts its own node's directory at the front of the script's PATH. It
    // does not: on npm 10.9.4 and 11.6.2 it prepends the `node_modules/.bin`
    // chain and `@npmcli/run-script`'s node-gyp-bin, and nothing else. What
    // keeps the two anchors together is npm's own launcher, whose first line
    // is `#!/usr/bin/env node` -- so the node that runs `npm-cli.js` is
    // resolved from PATH too, and invoking npm by an absolute path does not
    // pin it. Measured by the coordinator with a shim fronting PATH: the npm
    // ancestor's own /proc/<pid>/exe WAS the shim, and
    // `npm config get globalconfig` moved with it.
    //
    // ROUND 67, THE COORDINATOR'S R65-F-1 (P1, a fail-open). Both readers of
    // npm's DEFAULT global config -- this one and the gate's -- derived the
    // file from the node THEY resolved. The file npm honours is the one beside
    // the node running NPM, which need not be the same binary.
    //
    // ROUND 68, THE COORDINATOR'S R67-F-1 (P1, A FALSE MEASURED CLAIM OF MINE,
    // on its own withdrawal of the exploit that produced it). What stood here
    // said that one PATH entry made an effective `script-shell` go unread at
    // rc 0, with twelve invocations through an attacker's shell. It is not
    // reproducible, and its first clause is false: a bare PATH entry moves
    // npm's anchor as well, so the two stay together and this law reads the
    // file npm reads. What IS measured, and what this arm is for:
    //
    //   * the divergence is real and reachable when npm's node is pinned
    //     INDEPENDENTLY of PATH (`node <abs>/npm-cli.js test`, or a launcher
    //     with an absolute shebang) -- the coordinator's K1, refused by name;
    //   * a bare PATH entry does NOT reach it (H1: rc 0, 309 passed, one
    //     anchor), and a symlinked directory does not either (H2);
    //   * and the HARM such a plant carries is refused independently of this
    //     arm, through the environment: npm exports every config it honours as
    //     `npm_config_*`, so an effective `script-shell` is in this run's own
    //     environment and the arm above refuses it by name. The coordinator's
    //     K2 -- anchors genuinely divergent, plant genuinely effective -- reds
    //     on the PREVIOUS head for exactly that reason.
    //
    // So this arm is a SECOND READER closing an anchor gap (R67-C-02), not the
    // thing standing between this phase and an effective shell, and there was
    // no fail-open on `1fcd9c3`.
    //
    // So the anchor comes from where npm IS: the npm ancestor's own program,
    // read out of /proc/<pid>/exe, which npm cannot choose for itself. Both
    // files are checked, and the two anchors disagreeing is refused by name --
    // in an honest run there is one node, so a disagreement is the attack. A
    // run with no npm ancestor has one anchor and this arm says nothing about
    // a second.
    const npmNode = npmAncestorProgram();
    const defaults = [
      { what: "npm's default user config", file: join(homedir(), '.npmrc') },
      { what: "npm's default global config, anchored on this run's node", file: join(dirname(dirname(process.execPath)), 'etc', 'npmrc') },
      ...(typeof npmNode === 'string'
        ? []
        : [{ what: "npm's default global config, anchored on the node running npm", file: join(dirname(dirname(npmNode.exe)), 'etc', 'npmrc') }]),
    ].filter(({ file }) => existsSync(file));
    if (typeof npmNode !== 'string') {
      const mine = realpathSync(process.execPath);
      expect(
        npmNode.exe === mine ? '' : `npm is running on ${npmNode.exe} (pid ${npmNode.pid}) and this run is on ${mine}`,
        `${REFUSED_NPM_NODE_IS_NOT_THIS_ONE}: npm reads the config beside ITS OWN node, so two different binaries mean the file this law checked is not the file npm honours -- which is reachable when npm's node is pinned independently of PATH (a bare PATH entry is not enough: it moves npm's anchor too). This arm is the SECOND reader of that gap -- an effective script-shell is also exported as npm_config_script_shell and refused by the environment arm above. In an honest run there is one node`,
      ).toBe('');
    }
    for (const { what, file } of defaults) {
      const sets = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => (line.split('=', 1)[0] ?? '').trim().toLowerCase().replace(/_/g, '-'))
        .filter((name) => name === 'script-shell' || name === 'shell');
      expect(
        sets,
        `${REFUSED_NPM_CONFIG}: ${what} at ${file} sets ${sets.join(', ')}. npm reads that file with no variable naming it, so the pinned command would be handed to a program of someone else's choosing on every run`,
      ).toStrictEqual([]);
    }
    // The coordinator's R62-C-01. The VARIABLE is not refused: CI legitimately
    // sets `--max-old-space-size`, and a hardening that causes a false red is
    // not hardening. Its code-loading FORMS are, in every spelling node accepts
    // them -- measured on node v24.12.0 in this container, each running a
    // module before `main`: `-r`, `--require`, `--import`, `--loader`,
    // `--experimental-loader`, taken with a space or with `=`. (`-r./file`,
    // concatenated, node rejects outright.)
    //
    // ROUND 67, THE COORDINATOR'S R65-C-04 (P2): THAT PARAGRAPH IS NO LONGER
    // TRUE OF THE ARM BELOW IT, so it is replaced rather than left to mislead.
    // It said: "DECLARED LIMIT, so no later round reads this as default-deny:
    // it is a list of FORMS, not an allowlist of everything else. A
    // code-loading flag node adds after today is unrefused until it is written
    // here." Round 65 inverted the direction (R64-C-01), so the arm below is
    // an ALLOW-LIST and a flag node adds after today is REFUSED, not admitted.
    // The true declaration is the opposite one, and it is a cost rather than a
    // hole: measured on node v24.12.0 in this container with
    // `process.allowedNodeEnvironmentFlags`, 268 flags are accepted in
    // NODE_OPTIONS, this list admits 18 of them and refuses 250, of which 85
    // are `--no-` negations (2 admitted). So an honest CI job that sets
    // `--cpu-prof` or `--inspect-port` reds, and that is this bound and not a
    // new defect. What still does not depend on the list is the gate's own
    // leg, where the variable never reaches the child at all -- two
    // mechanisms, neither the other's only reader.
    //
    // ROUND 65, the challenger's R60-F-1: the value is read from the EXEC-TIME
    // environment, because a module loaded by this very variable runs before
    // this file and `process.env` is writable -- `delete process.env.NODE_OPTIONS`
    // in the loader made the round-64 arm pass 28/28 with the loader executed.
    // Both sources are read and the union is refused, so a value ADDED after
    // exec is refused too; and an unreadable exec environment is refused by
    // name rather than falling back to the channel the attacker controls.
    const ancestry = codeLoadingAncestry(nodeTokenLoadsNothing);
    expect(
      ancestry.platform,
      `${REFUSED_EXEC_ENVIRONMENT_UNREADABLE}: this arm reads the exec-time environment of this process and of every ancestor up to the runner, because a module loaded through NODE_OPTIONS runs in the RUNNER first and can delete the variable before this process is even forked. ${ancestry.platform}. This suite's declared platform is Linux; a platform without /proc is a reviewed change and this arm changes with it`,
    ).toBe('');
    expect(
      ancestry.unreadable,
      `${REFUSED_EXEC_ENVIRONMENT_UNREADABLE}: ${ancestry.unreadable.join('; ')}. An ancestor whose environment cannot be read is not an ancestor shown to be clean, and this arm does not skip what it cannot classify`,
    ).toStrictEqual([]);
    const loaders = [
      ...new Set([
        ...ancestry.found,
        ...tokensNotAdmitted(
          (process.env.NODE_OPTIONS ?? '').split(/\s+/).filter((token) => token.length > 0),
          nodeTokenLoadsNothing,
        ).map((token) => `this run's live environment: ${token}`),
      ]),
    ];
    expect(
      loaders,
      `${REFUSED_NODE_OPTIONS_LOADS_CODE}: ${loaders.join(', ')} -- read from the exec-time environment of this process and its ancestors, from the runner's own command line, and from process.env. This arm is an ALLOW-LIST: a token is admitted only when this phase has established that it loads no code (${LOADS_NOTHING.length} flags in LOADS_NOTHING), and everything else is refused, a flag newer than this list included. The forms it was built against are ${KNOWN_CODE_LOADING_FORMS.join(', ')}. The variable itself is allowed`,
    ).toStrictEqual([]);
  });

  it('R67-01: a node link the scan cannot bound by the script is judged by the allow-list, so `-e` and a flag nobody has heard of refuse, and an honest link does not', () => {
    // ROUND 68, THE CHALLENGER'S R67-01, and the reason it is a CASE and not
    // just a fix: the hole lived on a path the real chain never takes. Under
    // `npm test` this container's links are the vitest worker (skipped), `node
    // node_modules/.bin/vitest run <file>` (bounded by the script), a `sh -c`
    // and npm with its title rewritten -- measured by walking /proc during a
    // run. Nothing honest here reaches the unbounded half, so an arm that only
    // ran in the real path would never have exercised it. An arm with no
    // reachable positive control is an arm nobody has run, so the function is
    // handed /proc trees this case builds, one shape at a time.
    //
    // The defect it closes was measured on `ed0ce1c` as a whole run:
    // `node -e 'require("child_process").execSync("npx vitest run <the law>")'`
    // was rc 0 with 31/31 green and arbitrary code in the parent of the runner.
    const root = mkdtempSync(join(tmpdir(), 'r68-proc-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const tree = (name: string, chain: { pid: number; ppid: number; argv: string[] }[]): string => {
      const procRoot = join(root, name);
      mkdirSync(procRoot);
      for (const node of chain) {
        const dir = join(procRoot, String(node.pid));
        mkdirSync(dir);
        writeFileSync(join(dir, 'status'), `Name:\tx\nPPid:\t${node.ppid}\n`);
        writeFileSync(join(dir, 'cmdline'), `${node.argv.join('\0')}\0`);
        writeFileSync(join(dir, 'environ'), '');
      }
      return procRoot;
    };
    const worker = { pid: 10, ppid: 20, argv: ['node', '--require', 'suppress-warnings.cjs', 'worker'] };
    for (const [label, chain, expected] of [
      [
        'arbitrary code inline on an unbounded link',
        [worker, { pid: 20, ppid: 1, argv: ['node', '-e', 'require("child_process").execSync("npx vitest run x")'] }],
        ['pid 20 (interpreter flag): -e'],
      ],
      [
        '`--print`, which the round-66 form-list also missed',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--print', 'process.exit(0)'] }],
        ['pid 20 (interpreter flag): --print'],
      ],
      [
        'a flag newer than this phase, which a list of FORMS could never hold',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--experimental-whatever-comes-next', 'x.js'] }],
        ['pid 20 (interpreter flag): --experimental-whatever-comes-next'],
      ],
      [
        'a module loaded after an unadmitted flag, which reds on the flag itself rather than on the module',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--conditions', 'dev', '--import=/tmp/loader.mjs', '/n/vitest.mjs', 'run'] }],
        ['pid 20 (interpreter flag): --conditions'],
      ],
      [
        'R62-F-1: a loader NAMED like the script, which used to empty the region and hide the whole line',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--import=/tmp/d/vitest.mjs', '/n/vitest.mjs', 'run', 'x.test.ts'] }],
        ['pid 20 (interpreter flag): --import=/tmp/d/vitest.mjs'],
      ],
      [
        'R62-F-1 again, with the decoy standing where the script would: the name decides nothing now',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--import=/tmp/d2/vitest', '--enable-source-maps', '/n/vitest.mjs', 'run'] }],
        ['pid 20 (interpreter flag): --import=/tmp/d2/vitest'],
      ],
      [
        "the gate's own runner, whose SCRIPT arguments include flags that are none of node's business",
        [worker, { pid: 20, ppid: 1, argv: ['node', '/n/vitest.mjs', 'run', 'test/x.test.ts', '--no-file-parallelism'] }],
        [],
      ],
      [
        'the honest shape this container actually runs: npm reached through its own script path',
        [worker, { pid: 20, ppid: 1, argv: ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'test'] }],
        [],
      ],
      [
        'an admitted flag with its value as a separate token, which must not be read as a flag',
        [worker, { pid: 20, ppid: 1, argv: ['node', '--dns-result-order', 'ipv4first', '/n/vitest.mjs', 'run'] }],
        [],
      ],
      ['a link whose program is not node at all, where these flags mean nothing', [worker, { pid: 20, ppid: 1, argv: ['sh', '-c', 'node -e "x"'] }], []],
    ] as [string, { pid: number; ppid: number; argv: string[] }[], string[]][]) {
      const walked = codeLoadingAncestry(nodeTokenLoadsNothing, tree(label.slice(0, 24).replace(/[^a-z]+/gi, '-'), chain), 10);
      expect(
        walked.unreadable,
        `${REFUSED_EXEC_ENVIRONMENT_UNREADABLE}: the fixture for "${label}" is unreadable to the walk, so the case below would measure the wrong thing`,
      ).toStrictEqual([]);
      expect(
        walked.found,
        `${REFUSED_NODE_OPTIONS_LOADS_CODE}: the ancestry walk over "${label}" answered ${JSON.stringify(walked.found)}. A link the scan cannot bound by the script is judged by the SAME allow-list as a bounded one, and the two cases that expect nothing are what keeps that from redding an honest run`,
      ).toStrictEqual(expected);
    }
  });

  it('R62-F-2: the program the runner RUNS is pinned by its bytes, and the pin is the one the lockfile names', () => {
    // ROUND 68, THE CHALLENGER'S R62-F-2 (P1). Every arm in this family
    // defends one thing -- that no code of somebody else's choosing runs
    // inside this process -- and every one of them reads FLAGS: the
    // environment, the runner's argv, the ancestors', the npm config. None of
    // them read the runner's own PROGRAM, and `law-bytes.json` pins fourteen
    // files, none under `node_modules`. The challenger inserted ONE import
    // into `node_modules/vitest/vitest.mjs` and measured it on `ed0ce1c`:
    //
    //   bare suite, patched runner        rc 0, 31/31 green
    //   tools/law-ran.py, patched runner  rc 0, full census printed, and the
    //                                     attacker's module ran INSIDE the run
    //                                     the gate was certifying
    //
    // No flag, no variable, no config key, so nothing in the family saw it.
    // This arm reads the bytes instead, and so does the gate, independently.
    //
    // WHAT IT DOES NOT COVER, measured and not assumed (see the port in the
    // commit message): the pin is over the RUNNER'S OWN PACKAGE. vitest loads
    // vite, tinypool and the rest of the installed tree, and the same patch in
    // one of those is NOT caught here. The attacker this narrows is "anyone
    // who can write under node_modules"; what is left is "anyone who can write
    // under node_modules outside this one package", which is most of it.
    // Measured, both legs restored and re-hashed afterwards: an import added
    // to `node_modules/vite/dist/node/index.js` ran TWICE inside the run and
    // the suite was 33/33 green at rc 0, while the same import in the pinned
    // package reds here and reds the gate at exit code 1. The same sentence
    // stands in tools/runner-bytes.json, and goes into the pack with this
    // commit's entry.
    const repo = join(__dirname, '..', '..', '..');
    const pinFile = join(__dirname, '..', 'tools', 'runner-bytes.json');
    expect(
      existsSync(pinFile),
      `${REFUSED_RUNNER_PROGRAM_UNPINNED}: ${pinFile} is absent, and a pin that is not there cannot be the thing that says the runner is honest`,
    ).toBe(true);
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as {
      package: string;
      version: string;
      lockfile_key: string;
      lockfile_integrity: string;
      root: string;
      files: Record<string, string>;
    };

    // The pin moves in the commit that moves the lockfile, and this is what
    // makes that true rather than hoped: an upgrade that re-pins the bytes but
    // leaves the recorded version or integrity behind refuses by name, and so
    // does the reverse.
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const locked = lock.packages[pin.lockfile_key];
    expect(
      [locked?.version, locked?.integrity],
      `${REFUSED_RUNNER_PACKAGE_NOT_LOCKED}: package-lock.json holds ${JSON.stringify(locked)} for ${pin.lockfile_key}, and tools/runner-bytes.json was pinned against ${pin.version} / ${pin.lockfile_integrity}. A pin against a package the lockfile no longer names is a pin against nothing`,
    ).toStrictEqual([pin.version, pin.lockfile_integrity]);

    // The program is taken from the CHAIN, not from a path this file writes:
    // whatever the runner is running is what gets hashed.
    const runner = scriptOfTheRunner(nodeTokenLoadsNothing);
    expect(
      typeof runner,
      `${REFUSED_RUNNER_PROGRAM_UNPINNED}: ${typeof runner === 'string' ? runner : ''}. A run whose own runner cannot be identified is not a run shown to be honest, and this arm does not skip what it cannot classify`,
    ).toBe('object');
    const script = realpathSync((runner as { script: string; pid: number }).script);
    const packageRoot = realpathSync(join(repo, pin.root));
    expect(
      script.startsWith(`${packageRoot}${sep}`),
      `${REFUSED_RUNNER_PROGRAM_UNPINNED}: this run's runner is executing ${script}, which is not inside the pinned package ${packageRoot}. The pin covers one package, and a runner from somewhere else is outside it -- which is a refusal here and not a pass`,
    ).toBe(true);
    expect(
      Object.keys(pin.files),
      `${REFUSED_RUNNER_PROGRAM_UNPINNED}: the runner's own entry ${relative(packageRoot, script)} is not one of the pinned files`,
    ).toContain(relative(packageRoot, script));

    // ROUND 69, THE CHALLENGER'S R63-S-1, measured on a tree this case builds
    // rather than by planting a symlink in the shared install (an arrival
    // there would red every other thread's run, and a hardening measured by
    // breaking somebody else's run is not one). `bytesUnder` is a pure
    // function of a directory, so it is handed one: a file, a link INSIDE the
    // root, and a link pointing OUT of it.
    const scratch = mkdtempSync(join(tmpdir(), 'r69-bytes-'));
    onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
    mkdirSync(join(scratch, 'inner'));
    writeFileSync(join(scratch, 'inner', 'real.js'), 'x\n');
    symlinkSync(join(scratch, 'inner', 'real.js'), join(scratch, 'link-inside'));
    const outside = join(tmpdir(), `r69-outside-${process.pid}`);
    writeFileSync(outside, 'y\n');
    onTestFinished(() => rmSync(outside, { force: true }));
    symlinkSync(outside, join(scratch, 'link-outside'));
    symlinkSync(join(realpathSync(repo), 'package.json'), join(scratch, 'link-in-the-repo'));
    const rows = bytesUnder(realpathSync(scratch), realpathSync(repo));
    expect(
      rows['link-inside'],
      'a link INSIDE the pinned root must be recorded by its path relative to that root, or the pin is a property of the checkout and not of the package',
    ).toBe(`SYMLINK:${join('inner', 'real.js')}`);
    expect(
      rows['link-in-the-repo'],
      'a link into the REPOSITORY but outside the pinned package must be recorded relative to the repository root: its absolute target differs between any two clones, and that is not a difference',
    ).toBe('SYMLINK:repo:package.json');
    expect(
      rows['link-outside'],
      'a link pointing out of the REPOSITORY keeps its absolute target, because a link into /opt or /usr is a different tree in any sense that matters',
    ).toBe(`SYMLINK:${realpathSync(outside)}`);

    // The census refuses ARRIVALS as well as departures and edits: a file that
    // appears under the package is a file nobody reviewed, and vitest loads
    // what its own code points at.
    expect(
      bytesUnder(packageRoot, realpathSync(repo)),
      `${REFUSED_RUNNER_PROGRAM_UNPINNED}: the installed bytes of ${pin.package}@${pin.version} are not the pinned ones. If the change is intended it moves with package-lock.json, in the same commit, with the reason in the message`,
    ).toStrictEqual(pin.files);
  });

  it("R54-S1/R55-S3: the two digest readers agree over the pack's own names and over names built to break them", () => {
    // The pack digest is computed TWICE, once here and once in
    // `tools/law-ran.py`, and the gate hands its value to the run this suite
    // is part of. Two implementations of one definition is the point -- it is
    // what establishes that two readers saw one instant -- but it is also a
    // place where they can silently part company, which is what the
    // challenger measured: `.sort()` by UTF-16 code unit against `sorted` by
    // code point, disagreeing on `z\uFFFD` beside `z\u{1F600}`.
    //
    // So this arm does not assert that the orderings are the same by reading
    // the two sources. It RUNS BOTH over a directory built to break them and
    // compares the values, because a claim about an instrument is verified
    // only by running it. The names are the challenger's pair plus the
    // boundary either side of U+D7FF, which is where the two orders diverge.
    //
    // R55-S3 (the challenger's P3): five names this arm WRITES are five names
    // somebody thought of, and its sentence claimed an adversarial set. The
    // challenger made the two readers disagree in a way those five cannot
    // expose -- Python ordering with hyphens stripped -- and the probe passed
    // while the real pack then refused, saying the pack had moved when it had
    // not, which is the exact failure this arm exists to prevent. So the names
    // are DERIVED FROM THE SUBJECT as well: every name the pack actually
    // carries, which is where hyphens, digits, dots and case live, plus the
    // constructed boundary cases below. A disagreement over any character the
    // real pack uses is now exposed by the real pack's own names.
    //
    // F-61 holds: every argument reaching `spawnSync` is a literal or a path
    // this arm made, and the Python it runs is `-I` with a literal program.
    const dir = mkdtempSync(join(tmpdir(), 'r56-digest-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const constructed = [
      ['z\uFFFD.md', 'replacement character'],
      ['z\u{1F600}.md', 'above the BMP'],
      ['z\uD7FF.md', 'the last code point below the surrogates'],
      ['z\uE000.md', 'the first code point above them'],
      ['plain.md', 'ascii'],
    ] as const;
    for (const [name, body] of constructed) {
      writeFileSync(join(dir, name), body);
    }
    // ROUND 60, AND THIS IS THE ARM THAT SHOULD HAVE CAUGHT R56-S3 A ROUND
    // EARLIER. The two readers can part company over an entry's KIND as well as
    // over its name, and they did: `statSync(full).isFile()` RAISES on a
    // dangling symlink, so this reader labelled it `<unreadable>`, while
    // `Path.is_file()` answers false and raises nothing, so the gate labelled it
    // `<not-a-file>` -- one directory, one instant, two digests, and
    // REFUSED-PACK-MOVED would have fired saying the pack had moved when it had
    // not. Measured by adding these two entries, which red this arm before the
    // gate's digest was changed to classify from ONE `stat`.
    mkdirSync(join(dir, 'a-subdirectory-in-the-pack'));
    symlinkSync(join(dir, 'no-such-target-ever'), join(dir, 'dangling-symlink.md'));
    // ROUND 60e, the entries with MORE THAN TWO answers, because an entry's
    // kind is where these two implementations parted company once already. A
    // symlink to a directory resolves but is not a file; a symlink LOOP raises
    // ELOOP rather than ENOENT, which is a different errno through a different
    // branch of each reader; a FIFO stats cleanly and is not a regular file.
    // Each must land in the SAME label on both sides or the two digests differ
    // for one directory at one instant.
    symlinkSync(join(dir, 'a-subdirectory-in-the-pack'), join(dir, 'symlink-to-a-directory.md'));
    symlinkSync(join(dir, 'loop-b.md'), join(dir, 'loop-a.md'));
    symlinkSync(join(dir, 'loop-a.md'), join(dir, 'loop-b.md'));
    const fifo = spawnSync(HARNESS_PYTHON, ['-I', '-B', '-c', 'import os, sys; os.mkfifo(sys.argv[1])', join(dir, 'a-fifo.md')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(
      fifo.status,
      `${REFUSED_PACK_MOVED}: this arm could not create a FIFO to compare the two readers over, so one kind of entry stays untested here: ${JSON.stringify((fifo.stderr ?? '').trim().slice(0, 200))}`,
    ).toBe(0);
    // THE COORDINATOR'S R58-C-08 (P3): this derivation was the third reader of
    // the pack and the only one still SKIPPING what it could not classify --
    // `catch { return false }` -- which is the shape R57-C-04 closed in the
    // gate's copier and in `snapshotPack`. Not a hole here, because this arm's
    // subject is NAMES and a skipped entry only shrinks the alphabet it tests;
    // but one package may not hold two doctrines about one event, and the same
    // reader also decoded names as JavaScript strings, so a non-UTF-8 name
    // reached it as replacement characters and it would have written a name the
    // pack does not carry. Names are read as BUFFERS and every entry is
    // classified, by the same single `stat` the other two readers use.
    const fromSubject: string[] = [];
    if (existsSync(PACK)) {
      for (const raw of readdirSync(PACK, { encoding: 'buffer' })) {
        const name = raw.toString('utf8');
        expect(
          Buffer.from(name, 'utf8').equals(raw),
          `${REFUSED_PACK_NAME_NOT_UTF8}: ${PACK} holds a filename that is not valid UTF-8 (${JSON.stringify(raw.toString('latin1'))}), so this arm would derive a name the pack does not carry and compare the two readers over it`,
        ).toBe(true);
        let mode: number;
        try {
          mode = statSync(join(PACK, name)).mode;
        } catch (error) {
          expect(
            String(error),
            `${REFUSED_FILE_NOT_READABLE}: ${join(PACK, name)} is in the pack and could not be read at all, so this arm cannot say whether its name belongs in the set it derives`,
          ).toBe('<unreachable: this entry cannot be classified>');
          continue;
        }
        expect(
          (mode & 0o170000) === 0o100000,
          `${REFUSED_PACK_ENTRY_NOT_A_FILE}: ${join(PACK, name)} is in the pack and is not a regular file. The pack is a flat set of documents, and this arm refuses what it cannot classify rather than dropping it out of the derived alphabet in silence`,
        ).toBe(true);
        fromSubject.push(name);
      }
    }
    for (const name of fromSubject) {
      // The NAME is the subject here, not the bytes, so each is written with a
      // body of its own name: nothing of the pack's content is copied and the
      // two readers still hash the same bytes under the same name.
      writeFileSync(join(dir, name), `name derived from the pack: ${name}`);
    }
    expect(
      fromSubject.length,
      `${REFUSED_PACK_MOVED}: this arm found no names in the pack at ${PACK} to derive from, so it would be testing only the five names it invented (R55-S3)`,
    ).toBeGreaterThan(0);
    const mine = packDigest(dir);
    // The probe must not LITTER: importing by file path compiles the module,
    // and a `__pycache__` written into `tools/` is an untracked binary file
    // that this law's own repository arm then refuses. `-B` and
    // `sys.dont_write_bytecode` both say so, at the call site and inside the
    // program, because the flag is the control and the assignment is the proof
    // that nothing depended on inheriting it.
    const probe = [
      'import importlib.util, sys',
      'sys.dont_write_bytecode = True',
      `spec = importlib.util.spec_from_file_location('lawran', ${JSON.stringify(join(TOOLS_DIR, 'law-ran.py'))})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'from pathlib import Path',
      `print(module.pack_digest(Path(${JSON.stringify(dir)})))`,
    ].join('\n');
    const r = spawnSync(HARNESS_PYTHON, ['-I', '-B', '-c', probe], { encoding: 'utf8', timeout: 60_000, env: { PATH: '/usr/bin:/bin' } });
    expect(
      r.status,
      `${REFUSED_PACK_MOVED}: the gate's own digest function could not be run from here, so this arm cannot say the two readers agree: ${JSON.stringify(
        (r.stderr ?? '').trim().slice(0, 300),
      )}`,
    ).toBe(0);
    expect(
      (r.stdout ?? '').trim(),
      `${REFUSED_PACK_MOVED}: this law and tools/law-ran.py compute DIFFERENT digests for one directory at one instant, so the value the gate hands down could never match what this suite reads and the refusal would say the pack moved when it had not (R54-S1). Both must order names by their BYTES`,
    ).toBe(mine);
  });

  it("R58: the provenance check refuses when it cannot show provenance, and admits only this package's own gate", () => {
    // THE COORDINATOR'S ADDITION TO R58. `notStartedByTheGate` is what makes
    // REFUSED-PACK-HANDED-DOWN-DIRECTORY-NOT-PRIVATE mean anything, and until
    // this arm existed it was measured only in the two states a whole run can
    // reach: the real `npm test` (admitted) and a forged one (refused). A claim
    // about a PROCESS also has to be measured where the check is ABSENT or
    // CANNOT RUN -- no /proc, a cmdline that is empty by construction, a chain
    // that reports no parent -- because every one of those is a route to
    // "cannot say", and a "cannot say" that returned '' would admit anything.
    //
    // So the function is RUN here over /proc trees this arm builds, one failure
    // mode at a time, and the SENTENCE it returns is read. Every path below is
    // one this arm made; nothing is executed.
    const root = mkdtempSync(join(tmpdir(), 'r58-proc-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const gate = join(__dirname, '..', 'tools', 'law-ran.py');
    const pkg = join(__dirname, '..');
    type Node = { pid: number; ppid: number; argv?: string[]; cwd?: string; noParent?: boolean };
    const tree = (name: string, chain: Node[]): string => {
      const procRoot = join(root, name);
      mkdirSync(procRoot);
      for (const node of chain) {
        const dir = join(procRoot, String(node.pid));
        mkdirSync(dir);
        writeFileSync(join(dir, 'status'), node.noParent === true ? 'Name:\tx\n' : `Name:\tx\nPPid:\t${node.ppid}\n`);
        if (node.argv !== undefined) writeFileSync(join(dir, 'cmdline'), `${node.argv.join('\0')}\0`);
        if (node.cwd !== undefined) symlinkSync(node.cwd, join(dir, 'cwd'));
      }
      return procRoot;
    };
    // A copy of the gate: same bytes, same name, different inode.
    //
    // ROUND 62, THE CHALLENGER'S S-2. This fixture read the REAL gate, so in
    // the one state this arm's last mode is about -- the gate genuinely absent
    // -- the arm died with a bare ENOENT from this line and printed no refusal
    // name at all. An arm that measures a refusal must not be the thing that
    // throws instead of it. The read is guarded, the copy falls back to a
    // stand-in with the same name and a different inode (which is all the
    // `a-copy` mode needs), and the absence is REPORTED here rather than
    // crashing the case.
    const copyDir = join(root, 'a-copy-of-the-gate', 'tools');
    mkdirSync(copyDir, { recursive: true });
    let gateBytes: Buffer | undefined;
    try {
      gateBytes = readFileSync(gate);
    } catch {
      // Measured below as its own mode; nothing here depends on the contents.
    }
    writeFileSync(join(copyDir, 'law-ran.py'), gateBytes ?? Buffer.from('# the real gate is absent from this package\n'));
    if (gateBytes === undefined) {
      expect(
        notStartedByTheGate(
          tree('the-gate-is-absent', [
            { pid: 10, ppid: 20 },
            { pid: 20, ppid: 1, argv: ['python3', '-I', 'tools/law-ran.py'], cwd: pkg },
          ]),
          10,
          gate,
        ),
        `${REFUSED_GATE_PROGRAM_ABSENT}: the gate is genuinely absent from this package, which is the one state this arm's last mode is about, and the check must still answer with a NAME rather than throwing`,
      ).toContain(REFUSED_GATE_PROGRAM_ABSENT);
    }

    const admitted = tree('admits-the-real-gate', [
      { pid: 10, ppid: 20 },
      { pid: 20, ppid: 1, argv: ['python3', '-I', 'tools/law-ran.py'], cwd: pkg },
    ]);
    expect(
      notStartedByTheGate(admitted, 10),
      'the provenance check does not admit the one invocation `npm test` actually makes, a relative gate path resolved against the ancestor cwd — which would make every honest run refuse',
    ).toBe('');
    const absolute = tree('admits-an-absolute-path', [
      { pid: 10, ppid: 20 },
      { pid: 20, ppid: 1, argv: ['/usr/bin/python3', '-I', gate] },
    ]);
    expect(
      notStartedByTheGate(absolute, 10),
      'the provenance check needs a cwd link to admit an ABSOLUTE gate path, so an unreadable cwd would refuse an honest run',
    ).toBe('');

    for (const [label, procRoot, startPid, expected, gateFile] of [
      ['no /proc at all', join(root, 'there-is-no-such-tree'), 10, 'no readable'],
      [
        'a cmdline that is empty by construction',
        tree('empty-cmdline', [
          { pid: 10, ppid: 20 },
          { pid: 20, ppid: 1, argv: [], cwd: pkg },
        ]),
        10,
        'no ancestor of this process',
      ],
      [
        'no cmdline file at all, which is what a process that exits mid-walk leaves',
        tree('no-cmdline', [
          { pid: 10, ppid: 20 },
          { pid: 20, ppid: 1, cwd: pkg },
        ]),
        10,
        'no ancestor of this process',
      ],
      ['a chain whose status carries no PPid', tree('no-ppid', [{ pid: 10, ppid: 0, noParent: true }]), 10, 'reports no parent'],
      ['a parent that cannot be read', tree('unreadable-parent', [{ pid: 10, ppid: 777 }]), 10, 'the parent chain stopped at pid 777'],
      [
        'a COPY of the gate: same bytes, same name, different inode',
        tree('a-copy', [
          { pid: 10, ppid: 20 },
          { pid: 20, ppid: 1, argv: ['python3', '-I', join(copyDir, 'law-ran.py')] },
        ]),
        10,
        'no ancestor of this process',
      ],
      [
        'the real gate run by something that is not a python interpreter',
        tree('not-python', [
          { pid: 10, ppid: 20 },
          { pid: 20, ppid: 1, argv: ['bash', gate], cwd: pkg },
        ]),
        10,
        'no ancestor of this process',
      ],
      [
        'a chain that is its own parent, so the walk never reaches pid 1',
        tree('a-loop', [{ pid: 10, ppid: 10, argv: ['python3', '-I', 'nothing.py'], cwd: pkg }]),
        10,
        'no ancestor of this process',
      ],
      // ROUND 61, THE COORDINATOR'S R60-C-03. The check compares an ancestor's
      // argument with THIS package's gate by (dev, ino), so it reads that file
      // -- and when the file is not there the read used to THROW, which
      // reaches an operator as a stack trace from inside a helper and not as a
      // verdict. The gate's path is an argument for exactly this measurement;
      // production passes none of the three.
      [
        'the gate program itself absent from this package',
        tree('gate-absent', [
          { pid: 10, ppid: 20 },
          { pid: 20, ppid: 1, argv: ['python3', '-I', 'tools/law-ran.py'], cwd: pkg },
        ]),
        10,
        REFUSED_GATE_PROGRAM_ABSENT,
        join(root, 'no-gate-here', 'tools', 'law-ran.py'),
      ],
    ] as const) {
      const said = notStartedByTheGate(procRoot as string, startPid as number, (gateFile as string | undefined) ?? gate);
      expect(
        said === '' ? '<admitted>' : said,
        `the provenance check ADMITTED a run it cannot show provenance for (${label}): a "cannot say" that returns the empty string makes REFUSED-PACK-HANDED-DOWN-DIRECTORY-NOT-PRIVATE unreachable and the privacy claim worthless`,
      ).not.toBe('<admitted>');
      expect(said, `the provenance check refuses ${label} with a sentence that does not say why: an operator reads the sentence, not the code`).toContain(
        expected as string,
      );
    }
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
    // R56-S1: the shared pack's own window gets a reader, and it is registered
    // as the FIRST statement of this arm. THE FIRST VERSION OF THIS LINE SAT AT
    // THE END OF THE ARM, where the comparison belongs, and the measurement of
    // it printed NOTHING: the arm had already refused, so `onTestFinished` was
    // never reached and the callback was never registered. A reporter that only
    // speaks when nothing else went wrong is a reporter that is silent exactly
    // when a reader needs it. Registered here, it runs whether this arm passes,
    // fails or returns early.
    onTestFinished(reportSharedPackMovement);
    // The pack lives outside the repository, so this arm is measured HERE and
    // not in CI; that limit is written into the handoff rather than left for a
    // reader to discover. Reviewer-owned reports are exempt BY EXACT NAME:
    // they are frozen bytes quoting the old text, and correcting a reviewer's
    // report would be worse than the defect.
    if (!existsSync(PACK)) {
      // DECLARED LIMIT, R48-F2: a pack that is absent ALTOGETHER is reported
      // UNMEASURED rather than refused, because the pack lives outside the
      // repository and nothing mounts it in CI. An existing directory that is
      // not the pack DOES refuse, by name, against the pinned set below —
      // which is the half of the attack a gate can see. This branch is quoted
      // in every dispatch so a reader is never told this arm measured the pack
      // when it did not.
      //
      // R49-S2 (P3), THE CHALLENGER'S AND THE COORDINATOR'S, AND THIS
      // SENTENCE WAS FALSE WHEN THEY READ IT. Until round 51 an absent pack
      // did not reach this branch's verdict at all: the status-head arm below
      // read `P5-STATUS.json` out of the pack with no guard, so a directory
      // that does not exist failed with a raw `ENOENT`, not with the
      // UNMEASURED-by-absence this comment claimed. Safer than a silent pass,
      // and still a false sentence that changes what a reader does: someone
      // wiring this package into CI would conclude no pack mount is needed.
      // The remedy is the behaviour, not the sentence — that arm is a literal
      // base now and reads its head from the repository — and the sentence is
      // true as measured at this head: an absent pack dir is 303 passed with
      // this branch's notice and no exception, an empty one reds
      // REFUSED-PACK-NOT-THE-PINNED-SET.
      //
      // THE COORDINATOR ASKED FOR A NAMED REFUSAL ON ABSENCE, and this is the
      // line where a refusal is right and where it would be a FALSE RED. A
      // pack nobody named is a pack nobody promised: the default path is not
      // mounted in a cold clone or in any CI this package might one day reach,
      // and refusing there would red a gate for a subject the environment
      // never had. A pack SOMEONE NAMED is different — `P5_PACK_DIR` set to a
      // directory that is not there is an operator error, and silence about it
      // would be the skip this whole file is about. So: named and absent
      // REFUSES BY NAME; the default simply not being mounted is the declared
      // limit, reported. MEASURED: named and absent reds by the name below;
      // the default-absent branch is UNMEASURED AT RUNTIME here, because the
      // pack IS mounted in this container and nothing can unmount it from
      // inside a test.
      const namedByOperator = (process.env.P5_PACK_DIR ?? '').trim().length > 0;
      expect(
        namedByOperator,
        `${REFUSED_PACK_NOT_PINNED}: P5_PACK_DIR names ${PACK} and there is no such directory, so the pack this gate was pointed at does not exist and ${pinnedPackSet().length} pinned author-owned names went unchecked. Unset P5_PACK_DIR to measure the default pack, or point it at a real one`,
      ).toBe(false);
      expect(
        existsSync(PACK),
        `no pack at ${PACK}: this arm is UNMEASURED here, by absence; ${pinnedPackSet().length} pinned author-owned names went unchecked`,
      ).toBe(false);
      return;
    }
    // R53-F1 and R54-S2: the instant this arm is about, and it reads a SNAPSHOT
    // of it so that instant cannot move underneath the pass.
    const sourceAtEntry = packDigest(PACK);
    const pack = snapshotPack(PACK);
    onTestFinished(() => rmSync(pack, { recursive: true, force: true }));
    const digestAtEntry = packDigest(pack);
    // R55-S2 (the challenger's P3): `digestAtEntry !== sourceAtEntry` has TWO
    // causes and the old message asserted one of them. It said the pack had
    // changed while the copy ran, and the challenger produced that sentence by
    // mutating the SNAPSHOT with the pack untouched. So the source is read
    // AGAIN at the mismatch, and the message names which of the two moved
    // rather than guessing -- a refusal that misnames its cause sends the
    // reader to the wrong directory.
    const whichMoved =
      digestAtEntry === sourceAtEntry
        ? ''
        : packDigest(PACK) === sourceAtEntry
          ? `the SOURCE at ${PACK} is unchanged (${sourceAtEntry}), so it is the SNAPSHOT at ${pack} that differs: something wrote into this arm's own private copy`
          : `the SOURCE at ${PACK} moved while this arm was COPYING it (it was ${sourceAtEntry} before the copy and is ${packDigest(PACK)} now), so the snapshot holds part of one state and part of another`;
    expect(
      digestAtEntry,
      `${REFUSED_PACK_MOVED}: the snapshot and the source disagree and no figure from the snapshot belongs to a single instant. ${whichMoved}`,
    ).toBe(sourceAtEntry);
    // ROUND 65, the sweep R60-F-1 forces on the HANDED-DOWN keys. Round 62
    // closed "the environment was stripped" on three rungs (unconditional
    // /proc ancestry, the command-line marker, the gate's receipt). This is a
    // fourth and cheaper one, and it is a COMPARISON rather than a read: the
    // environment this process was EXEC'd with cannot be edited from inside the
    // process, so a key present at exec and missing or changed now is an edit
    // made after exec -- by a setup file, a loaded module, anything running in
    // this run. It refuses by name instead of taking the fall-through path.
    // Where the keys agree it says nothing, so it cannot red an honest run, and
    // it says nothing about a run that never had them.
    // ROUND 66, THE CHALLENGER'S R61-F-2 (P1, a false sentence standing over a
    // fail-open). `executionEnvironment()` returns a REASON STRING when it
    // cannot read `/proc/self/environ`, and the comparison returns `[]` for
    // that shape -- so an unreadable exec-time environment passed this rung in
    // silence while the case below said in its own words that the caller
    // refuses on the reason. It did not. One package must not hold two
    // doctrines about one event: the sibling arm in the npm-config case
    // refuses this condition by name, and so does this one now.
    const atExecForRung = executionEnvironment();
    expect(
      typeof atExecForRung === 'string' ? atExecForRung : '',
      `${REFUSED_EXEC_ENVIRONMENT_UNREADABLE}: the fourth rung compares the keys this run was HANDED at exec with the ones it holds now, and the exec-time environment cannot be read, so the comparison would return an empty list of edits -- which is exactly what a clean run returns. ${typeof atExecForRung === 'string' ? atExecForRung : ''}`,
    ).toBe('');
    const editedAfterExec = environmentEditedAfterExec(atExecForRung, process.env);
    expect(
      editedAfterExec,
      `${REFUSED_HANDED_DOWN_ENV_EDITED}: ${editedAfterExec.join('; ')}. These keys arrived with this process at exec and something inside the run changed them before this case read them, which is the shape of the round-62 fail-open seen from the other side`,
    ).toStrictEqual([]);
    const handedDown = (process.env.P5_PACK_DIGEST ?? '').trim();
    // R56-S2 (the challenger's P3 on `45be4ad`): a digest handed down is a claim
    // that the directory named with it is the gate's own private copy, and that
    // claim is CHECKED here rather than believed. The challenger exported the
    // correct digest of a SHARED directory and got a refusal that called it "the
    // private pack directory the gate handed this run" -- a true red with a
    // false sentence in it, and R55-S1's false red reachable again through an
    // environment variable. Privacy now comes from what only the gate's
    // `mkdtemp` produces, so the wrong thing to export is refused BY ITS OWN
    // NAME and the movement refusal below is only ever said about a directory
    // that really is private.
    // ROUND 62, THE CHALLENGER'S F-1 (P1, A FAIL-OPEN), AND IT TURNED THE WHOLE
    // OF ROUND 61 OFF WITHOUT A WORD. Everything below used to hang on
    // `handedDown !== ''` -- a value the ENVIRONMENT carries -- so a config
    // with `setupFiles: ['./test-neuter.ts']` deleting P5_PACK_DIGEST,
    // P5_PACK_NONCE and P5_PACK_NONCE_FILE left `handedDown` empty, skipped
    // privacy, ancestry, the nonce and the movement check together, and the
    // gate exited 0 printing its usual figures. Nothing said a check had been
    // skipped, which is the signature of a fail-open.
    //
    // The fix does not live in the environment, because the environment is
    // what the attack edits. Provenance is read UNCONDITIONALLY now, from
    // /proc, and a run that DESCENDS FROM THE GATE and was handed NO digest is
    // refused by name: the gate always hands one down when the pack exists, so
    // the absence is the edit itself. A run nobody started from the gate still
    // takes the shared-pack path, which is what a reviewer running `npx vitest`
    // by hand needs.
    const gateAncestor: { pid?: number } = {};
    // ROUND 63: the gate's MARKER, which does not depend on the parent chain
    // reaching the gate. A run started on the gate's command line and handed
    // nothing is a run whose environment was edited in between -- the
    // challenger's R59 shim exactly -- and it refuses here rather than falling
    // through to the shared-pack path.
    const marker = startedOnTheGatesCommandLine();
    const markerSays = marker === true ? 'the gate started this run' : marker === false ? 'no marker' : marker;
    const notDescended = notStartedByTheGate('/proc', process.pid, undefined, gateAncestor);
    expect(
      marker === true && handedDown === '',
      `${REFUSED_GATE_HANDED_DOWN_NOTHING}: this run was started on the gate's own command line -- its runner's argv carries \`--outputFile=\` inside a \`law-ran-\` directory, which only tools/law-ran.py creates -- and yet no P5_PACK_DIGEST reached this case. So something between the gate and here removed it: a shim on PATH, a wrapper, an environment filter. This arm does NOT depend on the parent chain reaching the gate, which is what the challenger's round-59 shim broke by double-forking (${markerSays})`,
    ).toBe(false);
    expect(
      handedDown === '' && notDescended === '',
      `${REFUSED_GATE_HANDED_DOWN_NOTHING}: an ancestor of this run IS tools/law-ran.py and yet no P5_PACK_DIGEST reached this case, so something between the gate and here removed it -- a setupFile, a wrapper, an environment filter. The gate hands a digest down whenever the pack exists, and the checks that digest switches on are privacy, ancestry, the per-run nonce and REFUSED-PACK-MOVED-DURING-MEASUREMENT. All four were silently skipped when this read the environment alone`,
    ).toBe(false);
    if (handedDown !== '') {
      const why = notTheGatesPrivateCopy(PACK);
      expect(
        why,
        `${REFUSED_PACK_NOT_PRIVATE}: this run was handed a pack digest in P5_PACK_DIGEST, which only tools/law-ran.py sets and only for the private copy it made, but ${PACK} is not such a directory: ${why}. Run this suite through \`npm test\`, or unset P5_PACK_DIGEST to measure a shared pack as a shared pack`,
      ).toBe('');
      // Properties are not provenance: the four above can be built by hand, so
      // the claim is also checked against something the caller cannot supply.
      // The walk is the one above, run once, with its ancestor pid kept.
      expect(
        notDescended,
        `${REFUSED_PACK_NOT_PRIVATE}: this run was handed a pack digest in P5_PACK_DIGEST, so it claims to have been started by tools/law-ran.py, and ${notDescended}. What this says is that no ancestor PRESENTS ITSELF as a python interpreter running this exact file: argv is self-reported, so a program that only spawns the suite while naming the gate in its own argv passes this check (measured by the challenger at round 57). What stops a forged run from producing a false GREEN is the census and the content scan, which refuse a planted document and a planted invocation`,
      ).toBe('');
      // And provenance down to THIS run rather than to any run of the gate:
      // the value is fresh for every run and the file it is read back from is
      // the gate's own, mode 600, in its own temporary directory.
      const nonceWhy = nonceNotAsSpecified(gateAncestor.pid);
      expect(
        nonceWhy,
        `${REFUSED_NONCE_NOT_AS_SPECIFIED}: this run was handed a pack digest in P5_PACK_DIGEST, so tools/law-ran.py started it and wrote a per-run nonce for it to read, and ${nonceWhy}. An environment captured from ANOTHER gate run satisfies the ancestry check above and fails here, whichever way that run ended: one that reached its own cleanup left no file to point at, one that was killed left a file whose writer is not this run's ancestor (the coordinator's R61-C-01, measured), and a live one's file belongs to a pid that is not this run's ancestor either. What this does NOT reach is a DESCENDANT of THIS run, which inherits this very environment by definition -- the coordinator's R61-C-02, open and carried forward here so no later round reads the nonce as closing it; the census and the content scan are what stop a descendant producing a false green`,
      ).toBe('');
    }
    expect(
      handedDown === '' || handedDown === digestAtEntry,
      `${REFUSED_PACK_MOVED}: the gate that started this run measured the pack at ${handedDown} and this run reads ${digestAtEntry}, so the figures this run produces and the set the gate checked are two different instants`,
    ).toBe(true);
    // ROUND 62b, AND IT CLOSES A HOLE THIS AUTHOR DECLARED RATHER THAN ONE A
    // REVIEWER FOUND. Round 62 reads provenance from /proc instead of from the
    // environment, which refuses a stripped environment -- ON A PLATFORM THAT
    // HAS /proc. Where /proc cannot be read the walk can only say "cannot
    // say", so a stripped environment there took the shared-pack path and
    // nothing refused. A verdict this run throws away cannot be recovered
    // inside it: the regress ends OUTSIDE, in the program that started the run.
    //
    // So the four checks above write a RECEIPT, and `tools/law-ran.py` refuses
    // by name when it does not arrive or does not describe that run. The names
    // are written HERE, at the point each check has passed, which is why the
    // list is a literal and not a loop over a list of names: a name produced by
    // the same data that produces the check proves nothing.
    //
    // What this does NOT buy, and it is the same bound as the nonce's: code
    // executing inside the run -- a setup file is exactly that -- has this same
    // environment and can write a receipt of its own. A forger who runs code
    // still forges it. What moves is ABSENCE: it now reds on every platform.
    //
    // The coordinator's R62-C-02: the bound is stated at the width of "if code
    // runs inside the run", and the routes TO that position were each measured
    // and each refuses through the gate -- `setupFiles`, `globalSetup`,
    // `environment`, `alias`, `define`, `plugins`, `--config` naming a setup
    // file, a workspace file (never read), a test file of one's own
    // (`REFUSED-TEST-FILE-SET-MOVED`), and now `NODE_OPTIONS`' code-loading
    // forms. A sibling test file cannot do it either: each file runs in its own
    // process, so it cannot strip this one's environment. So the bound errs
    // wide on purpose; it is not a door anybody has had to keep shut.
    const receiptPath = (process.env.P5_LAW_RECEIPT ?? '').trim();
    if (handedDown !== '') {
      expect(
        receiptPath,
        `${REFUSED_GATE_HANDED_DOWN_NOTHING}: this run was handed a pack digest and NO receipt path, and tools/law-ran.py hands both down together or neither. One arriving without the other is an environment somebody edited between the gate and here`,
      ).not.toBe('');
      // R64-C-03: the runner's identity, derived here from the run's own
      // ancestry. A reason string goes in unchanged when it cannot be derived,
      // so the gate refuses on it instead of reading silence as agreement.
      const identity = runnerIdentity();
      writeFileSync(
        receiptPath,
        JSON.stringify({
          digest: handedDown,
          nonce: (process.env.P5_PACK_NONCE ?? '').trim(),
          gate_pid: gateAncestor.pid,
          runner_real_path: typeof identity === 'string' ? identity : identity.path,
          runner_version: typeof identity === 'string' ? identity : identity.version,
          checks: ['pack-privacy', 'gate-ancestry', 'per-run-nonce', 'pack-not-moved'],
        }),
      );
    }
    const exempt = reviewerOwned();
    const shaped = looksLikeReviewer();
    const offences: string[] = [];
    const unclassified: string[] = [];
    const packBinaries: string[] = [];
    const packUnreadable: string[] = [];
    // CD-48-01: this half reads the auditor's record too, so it resets it.
    resetAuditRecord();
    const mineNames: string[] = [];
    const recorded = enrolment();
    const movedBytes: string[] = [];
    for (const name of readdirSync(pack)) {
      if (exempt.has(name)) {
        // R48-F3: a reviewer's report is not READ by this law -- its bytes are
        // frozen and the author may not edit them -- but it is now WEIGHED.
        // The digest beside the name is the reviewer's own announced sha256,
        // so a frozen report rewritten after enrolment is refused by name.
        const bytes = diskText(join(pack, name));
        const actual =
          bytes === null
            ? null
            : createHash('sha256')
                .update(readFileSync(join(pack, name)))
                .digest('hex');
        if (actual !== recorded.get(name)) movedBytes.push(`${name}: ${actual ?? '<unreadable>'} is not the enrolled ${recorded.get(name) ?? '<no row>'}`);
        continue;
      }
      // B-12. A reviewer-shaped name the list does not classify is NOT read
      // here. F-53 had made the sentence true -- "unenumerated", not
      // "author-owned" -- while leaving the red itself on the author's
      // package, over bytes the author may not edit. Shape exempts nothing: it
      // routes this name to the seal, whose refusal is asserted below.
      if (shaped.test(name)) {
        unclassified.push(name);
        continue;
      }
      const text = readable(join(pack, name));
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
      mineNames.push(name);
      // CD-47-01: the second reader here too, so the pack half is bounded
      // against disk exactly as the repository half is.
      const onDisk = diskText(join(pack, name));
      offences.push(...auditedScan(name, text, onDisk ?? text, TOOLS_DIR).found);
      const drifted = diskRefusal(name, text, onDisk);
      if (drifted !== undefined) offences.push(drifted);
    }
    // The obligation MOVES, it does not disappear: for every document this law
    // declines to read, the author's own seal must refuse it by exact name.
    if (unclassified.length > 0) {
      const out = sealOutput(pack);
      const unrefused = unclassified.filter((n) => !sealRefusesByName(out, n));
      expect(
        unrefused,
        'a reviewer-shaped pack document is in neither the shared list nor the seal refusals, so NOTHING classifies it: enrol it in tools/reviewer-reports.json by its EXACT name, and do NOT edit a reviewer frozen report',
      ).toStrictEqual([]);
    }
    expect(
      movedBytes,
      `${REFUSED_ENROLLED_BYTES_MOVED}: an enrolled reviewer report's bytes are not the ones enrolled beside its name. A reviewer may re-issue a report, and then the digest in tools/reviewer-reports.json moves in the SAME commit that says so; the author does NOT edit a reviewer's file`,
    ).toStrictEqual([]);
    expect(packBinaries, 'a pack document holds a NUL byte, so this law cannot read it: name it in EXEMPT_BINARIES with the reason').toStrictEqual([]);
    expect(
      packUnreadable,
      `a pack document cannot be read at all, so this law never saw it: ${REFUSED_FILE_NOT_READABLE} — name why, and do not restore the silent skip`,
    ).toStrictEqual([]);
    expect(mineNames.length, `${REFUSED_PACK_NOT_PINNED}: no author-owned document was read from the pack at ${PACK} at all`).toBeGreaterThan(0);
    // R48-F2: and the set it read is the set the REPOSITORY names, so this
    // gate's verdict belongs to the commit. A directory that is not the pack —
    // an empty one, a copy with documents missing, a plant added — refuses by
    // name here, with the identity of what differs rather than a count.
    const pinnedNames = pinnedPackSet();
    const missing = pinnedNames.filter((n) => !mineNames.includes(n));
    const extra = [...mineNames].sort().filter((n) => !pinnedNames.includes(n));
    expect(
      { missing, extra },
      `${REFUSED_PACK_NOT_PINNED}: the author-owned documents read from ${PACK} are not the set tools/pack-set.json names. If the pack legitimately gained or lost an author-owned document, update that pin in the SAME commit and say why in the message`,
    ).toStrictEqual({ missing: [], extra: [] });
    // ROUND 42: no `quoted` counter any more. There is no exemption to keep
    // alive, and nothing in a document is skipped: an attack line that must
    // appear is NEUTRALISED (`<python3> …`), which the arm below pins.
    expect(offences, 'an author-owned pack document prints an un-isolated command, which is the half of F-50 that routes the reader').toStrictEqual([]);
    // R53-F1, second half: and nothing moved while this arm was reading. A
    // document added or removed mid-pass makes every figure above a statement
    // about no single instant, so it is refused BY NAME rather than left to
    // surface as a red somewhere else.
    // The snapshot is private, so it moving at all would mean something reached
    // into this arm's own temporary directory.
    expect(
      packDigest(pack),
      `${REFUSED_PACK_MOVED}: this arm's own private snapshot at ${pack} changed while it was being read, which means something outside this run is writing into it`,
    ).toBe(digestAtEntry);
    // R55-S1 (the challenger's P2, and the consequential finding of its round
    // 55): this arm used to REFUSE when the live pack moved after the copy,
    // while `tools/law-ran.py` says in writing that refusing on exactly that
    // "would be a false red about figures that are true of a real instant of
    // the pack". One diff, two doctrines about one event, and the refusal's own
    // words conceded it. Worse in practice: the default pack is a directory
    // sibling sessions write to BY DESIGN, so an ordinary `npm test` went red
    // whenever anyone enrolled a document during the twenty seconds the suite
    // reads -- the challenger's round-55 measurement, reported as
    // `1 failed | 304 passed (305)` -- and a red gate carries no signature.
    //
    // THE COORDINATOR'S R58-C-10 (P4): those figures are NOT a diagnostic, and
    // crediting them to an enrolment is a citation this comment cannot support.
    // The same shape -- one failed case, 304 passed, rc 1 -- is produced by a
    // per-case TIMEOUT under machine load, which carries no refusal name at
    // all, and that is what the unexplained 21:11:05 red turned out to be
    // (round 59, reproduced 3/3 by the coordinator under load). Two causes, one
    // shape. The discriminator is the refusal NAME in the output:
    // REFUSED-PACK-MOVED-DURING-MEASUREMENT for the enrolment, nothing at all
    // for the clock. The mechanism below is real and was measured; the figures
    // are not what proves it.
    //
    // So the law agrees with the gate now, and the distinction is WHOSE
    // directory moved. A movement in a copy the GATE handed down (it hands its
    // own private directory, and `P5_PACK_DIGEST` is how this run knows) is an
    // intrusion into a path only two programs can name, and that still refuses
    // by name above and here. A movement in a SHARED pack nobody promised to
    // hold still is reported beside the figures, not refused: every figure in
    // this arm is a statement about the snapshot it names, which is a real
    // instant of the pack.
    const sourceAtExit = packDigest(PACK);
    if (handedDown !== '') {
      expect(
        sourceAtExit,
        `${REFUSED_PACK_MOVED}: the private pack directory the gate handed this run at ${PACK} changed while this arm was reading a snapshot of it (it was ${sourceAtEntry} before the copy), which means something outside the gate and this run is writing into a path only those two can name`,
      ).toBe(sourceAtEntry);
    }
    // When nobody handed a directory down, the pack is the SHARED one, and this
    // arm makes NO claim about it after the copy: every figure above is a
    // statement about the snapshot it names, which is a real instant of the
    // pack. `sourceAtExit` is read so that a reader of this file sees the value
    // was looked at and deliberately not asserted on.
    //
    // R56-S1 (the challenger's P3), AND THE PREVIOUS WORDING HERE WAS THE FALSE
    // SENTENCE IT NAMED. It said the reader who can say something about a shared
    // pack is the gate. The gate can say it only about ITS OWN window: it is a
    // later process in `npm test`, so a write during the plain `vitest run` that
    // runs FIRST is invisible to it, and this arm had stopped reporting that
    // write because a `console.log` inside a passing case did not reach this
    // runner's output. One event, reported by nobody, under a sentence claiming
    // otherwise. The remedy is above: `reportSharedPackMovement` compares the
    // shared pack at this FILE's collection with the shared pack now, and says
    // so from `onTestFinished`, which does reach the output -- measured by
    // holding a sibling write across this arm and reading the note in the run's
    // own stdout.
    expect(typeof sourceAtExit).toBe('string');
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
    // ROUND 51, THE COORDINATOR'S P3. This base used to be read from the
    // pack's own `P5-STATUS.json`, which made the arm fail with ENOENT -- a
    // stack trace in a test name, not a verdict -- whenever `P5_PACK_DIR`
    // named a directory that is not there. Worse, it tied a REPO GATE to a
    // live shared directory again, which is exactly R48-F2. The base is a
    // literal here and the head is read from the repository this law lives in,
    // so the arm measures the TOOL and nothing else, and absence is refused BY
    // NAME rather than thrown.
    const headProbe = spawnSync('/usr/bin/git', ['--no-replace-objects', 'rev-parse', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: '/usr/bin', GIT_NO_REPLACE_OBJECTS: '1' },
      timeout: 60_000,
    });
    const headFull = (headProbe.stdout ?? '').trim();
    expect(
      /^[0-9a-f]{40}$/.test(headFull),
      `${REFUSED_REPO_HEAD_NOT_READABLE}: \`git rev-parse HEAD\` in ${REPO} did not answer with a resolved 40-character sha, so this arm cannot build a status block whose head is real: ${JSON.stringify(
        (headProbe.stderr ?? '').trim().slice(0, 200),
      )}`,
    ).toBe(true);
    const real: Record<string, unknown> = {
      ladder: 'PREPARED / NOT PROMOTED',
      ready_to_promote: 'NO',
      head: headFull.slice(0, 7),
      head_full: headFull,
      head_pushed: true,
      run_id: 'P5-SCRATCH-ARM',
      challenger_verdict: 'scratch',
      challenger_covers: 'scratch',
      coordinator_review: 'scratch',
      head_covered: 'NO',
      self_signature: 'none',
      next_owed: 'scratch',
      note: 'a scratch status block built by this arm; it is never written into the pack',
      documents: ['P5-SCRATCH.md'],
    };
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

  // ROUND 65. The fourth rung of round 62's closure is a COMPARISON between the
  // environment this process was exec'd with and the environment it has now.
  // In the real path it can only ever say nothing, because every route that
  // could edit the environment inside this process is refused by an earlier arm
  // -- so these two cases are how it is RUN at all, with the pair handed in.
  // A claim about an instrument is verified by running it.
  it('R60-65: a handed-down key changed after exec is named, and an untouched one is not', () => {
    const exec = new Map([
      ['P5_PACK_DIGEST', 'abc'],
      ['P5_PACK_NONCE', 'n1'],
      ['UNRELATED', 'x'],
    ]);
    expect(environmentEditedAfterExec(exec, { P5_PACK_DIGEST: 'abc', P5_PACK_NONCE: 'n1', UNRELATED: 'y' })).toStrictEqual([]);
    expect(environmentEditedAfterExec(exec, { P5_PACK_NONCE: 'n1' })).toStrictEqual(['P5_PACK_DIGEST (exec: "abc", now: null)']);
    expect(environmentEditedAfterExec(exec, { P5_PACK_DIGEST: 'different', P5_PACK_NONCE: 'n1' })).toStrictEqual([
      'P5_PACK_DIGEST (exec: "abc", now: "different")',
    ]);
    // A key nobody handed down and nobody set says nothing: this arm is about
    // an EDIT, and a run that was handed nothing is the business of the three
    // rungs above it.
    expect(environmentEditedAfterExec(new Map([['UNRELATED', 'x']]), {})).toStrictEqual([]);
    // R65-C-03: an ARRIVAL is an edit too, and it is named as one.
    expect(environmentEditedAfterExec(new Map([['UNRELATED', 'x']]), { P5_PACK_DIGEST: 'appeared' })).toStrictEqual([
      'P5_PACK_DIGEST (exec: null, now: "appeared") -- an ARRIVAL: nothing handed this key down and something inside the run set it',
    ]);
    // An empty string arriving is not an arrival: it is the absence this law
    // reads everywhere else as absence.
    expect(environmentEditedAfterExec(new Map([['UNRELATED', 'x']]), { P5_PACK_DIGEST: '' })).toStrictEqual([]);
  });

  it('R61-66: a value is not a flag, and a flag after a value is still read', () => {
    // The two halves of R61-F-1 and R61-S-2 are one rule, so it is run here
    // once rather than inferred from two readers. The challenger's own four
    // command lines are the first four rows.
    const judged = (line: string): string[] =>
      tokensNotAdmitted(
        line.split(' ').filter((t) => t.length > 0),
        nodeTokenLoadsNothing,
      );
    expect(judged('--dns-result-order ipv4first --import=/x/loader.mjs')).toStrictEqual(['--import=/x/loader.mjs']);
    expect(judged('--unhandled-rejections warn --import=/x/loader.mjs')).toStrictEqual(['--import=/x/loader.mjs']);
    expect(judged('--disable-warning DEP0040 --import=/x/loader.mjs')).toStrictEqual(['--import=/x/loader.mjs']);
    // `--title` is no longer admitted (it rewrites the cmdline this scan
    // reads), so it reds with its value behind it, and the loader beside it is
    // named too.
    expect(judged('--title probe -r /x/loader.cjs')).toStrictEqual(['--title', 'probe', '-r', '/x/loader.cjs']);
    // Honest lines, which must not red: a value of an admitted flag is skipped
    // whether it is written with a space or with `=`.
    expect(judged('--dns-result-order ipv4first')).toStrictEqual([]);
    expect(judged('--max-old-space-size=3072 --enable-source-maps')).toStrictEqual([]);
    expect(judged('')).toStrictEqual([]);
    // A bare token on its own is NOT waved through, and neither is the value of
    // a flag that is not admitted -- the skip is a rule about pairs.
    expect(judged('ipv4first')).toStrictEqual(['ipv4first']);
    expect(judged('--import /x/loader.mjs')).toStrictEqual(['--import', '/x/loader.mjs']);
    // R61-S-3: --conditions left the list, so it reds with its value behind it.
    expect(judged('--conditions dev')).toStrictEqual(['--conditions', 'dev']);
  });

  it('R60-65: an unreadable exec-time environment is not read as a clean one', () => {
    // The string form is the "cannot be read" case, and the comparison returns
    // an empty list for it -- which is what a CLEAN run returns, so the empty
    // list is not a verdict here. The caller refuses on the reason by name
    // before calling this at all (R61-F-2: until round 66 it did not, and this
    // comment claimed it did). What this case pins is the division of labour:
    // the comparison answers about EDITS only, and the shape that means
    // "cannot say" is the string, which the caller must read.
    expect(environmentEditedAfterExec('/proc/self/environ cannot be read', { P5_PACK_DIGEST: 'abc' })).toStrictEqual([]);
    const reason = executionEnvironment('/definitely-not-proc-65');
    expect(typeof reason).toBe('string');
    expect(String(reason)).toContain('cannot be read');
    const real = executionEnvironment();
    expect(real instanceof Map).toBe(true);
    // The mechanism the whole round rests on, measured rather than assumed: a
    // deletion from process.env does not change the exec-time environment.
    process.env.P5_R65_PROBE = 'present';
    const before = executionEnvironment();
    delete process.env.P5_R65_PROBE;
    const after = executionEnvironment();
    expect(before instanceof Map && after instanceof Map && before.get('PATH') === after.get('PATH')).toBe(true);
    expect(before instanceof Map && before.has('P5_R65_PROBE')).toBe(false);
  });
});
