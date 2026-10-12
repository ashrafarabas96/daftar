/**
 * P15 — EVIDENCE RUN LOG: every instrument, its command, its run id, its EXIT CODE
 * ============================================================================
 *
 * Mission V3 §9 adds a requirement to every handoff that the earlier rounds did
 * not meet: «أوامر التشغيل وسجلاتها وrun IDs وexit codes». The Phase 15 pack
 * carried commands and results; it did not carry exit codes, and the reason that
 * matters is in V3's own P9 example — a raw log that ends in passing cases and
 * then fails to close the process is NOT a passing run, and only the exit code
 * distinguishes the two. A log that ends in green text proves that green text
 * was printed, not that the run finished.
 *
 * So this runner executes each instrument, captures its output to a file, and
 * records:
 *
 *   · the exact command, as a reader would type it
 *   · the run id — the source SHA plus whether the tree was clean, plus a
 *     per-run nonce, so two runs of the same command are never confused
 *   · the EXIT CODE, as the process actually returned it
 *   · the log's path and its SHA256, so the log a verdict rests on is nameable
 *   · the wall duration, because a run that was killed looks like a run that
 *     finished when only the text is kept
 *
 * It asserts NOTHING about what a good exit code is. Two of these instruments
 * exit non-zero BY DESIGN when something is unmeasured, and flattening that
 * into "failure" would be as wrong as flattening it into "pass". The exit code
 * is recorded as evidence and interpreted by the reader.
 *
 * What this is NOT:
 *   · not a gate. It does not pass or fail the phase, and its own exit code
 *     reports only whether every instrument RAN, not whether any of them was
 *     happy.
 *   · not release evidence. §79 / V3 §22.3: the final evidence runs on the
 *     FINAL EXACT SHA on a clean tree, and this runner prints its own source
 *     identity precisely so a run from a dirty tree cannot be mistaken for it.
 *   · not a substitute for the instruments' own output. The logs are kept.
 *
 * Usage:
 *   npm run verify:evidence-log              # every instrument that needs no argument
 *   npm run verify:evidence-log -- --quick   # only the ones that start no cluster
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Counts, outcomeClass, scrape } from './outcome-class';

const ROOT = resolve(__dirname, '../..');
const LOG_DIR = process.env.P15_EVIDENCE_LOG_DIR ?? '/tmp/daftar-p15-evidence';

interface Instrument {
  readonly script: string;
  readonly what: string;
  /** true when the instrument starts a real PostgreSQL cluster (minutes, not seconds). */
  readonly cluster: boolean;
  /** what a non-zero exit means FOR THIS INSTRUMENT — recorded, never assumed. */
  readonly nonZeroMeans: string;
  /** the ids of the preconditions this instrument needs; see PRECONDITIONS. */
  readonly requires?: readonly string[];
}

/**
 * THE PRECONDITIONS, DECLARED AND MEASURED — B-21
 * ---------------------------------------------------------------------------
 * The independent challenger's F-08: three preconditions were undeclared and
 * unchecked, and the worst consequence was not the omission. `npm run build`
 * is one of them: without it `verify:gap-list:static` dies with
 * MODULE_NOT_FOUND — because its import chain reaches `@daftar/accounting`,
 * which resolves to `packages/accounting/dist` — and exits **1**. The same
 * instrument exits **1** when it ran perfectly and found one item UNMEASURED.
 * So a run that never began and a run that completed and reported a gap were
 * indistinguishable in the record, and §8b's only non-zero entry is in exactly
 * that class.
 *
 * Two things follow, and the runner can do both:
 *
 *   1. Each precondition is DECLARED here with the measurement that settles
 *      it, and is measured before anything runs. An instrument whose
 *      precondition is unmet is NOT RUN, and the record says so instead of
 *      carrying an exit code that would be read as a verdict.
 *   2. A non-zero exit is CLASSIFIED (see `outcomeClass`) by whether the
 *      instrument reached its own summary line. A crash before measuring and
 *      a measured-but-adverse run are different facts and now print
 *      differently, with distinct runner exit codes.
 *
 * What this does NOT claim to fix: the instruments' own exit codes still
 * collide. Giving `verify:gap-list:static` a distinct code for "crashed" is
 * its own change, and one this runner must not make on its behalf. What is
 * fixed is the RECORD — the thing B-21 says a handoff has to carry.
 *
 * `kind` matters. An `environment` precondition ought to hold and its absence
 * is a defect in the run: it makes this runner exit 2. A `caller-supplied`
 * one cannot hold without a caller naming a subject — a database URL, a load
 * profile — and an instrument that refuses to invent one is behaving
 * correctly; it is recorded as NOT RUN, DECLARED, and does not fail the
 * runner. Flattening those two would either hide a missing build or
 * manufacture a failure out of a question nobody asked.
 */
interface Precondition {
  readonly id: string;
  readonly kind: 'environment' | 'caller-supplied';
  readonly what: string;
  readonly how: string;
  readonly measure: () => { readonly met: boolean; readonly detail: string };
}

const PRECONDITIONS: readonly Precondition[] = [
  {
    id: 'build-accounting',
    kind: 'environment',
    what: 'packages/accounting is built — the dist `verify:gap-list` reaches through apps/api/src/config',
    how: "packages/accounting/package.json main, checked for existence on disk; plus a non-blocking survey of every workspace package",
    measure: () => {
      // NARROW ON PURPOSE. The first version of this precondition required
      // EVERY workspace package to be built, and it immediately blocked
      // `verify:gap-list:static` because `packages/design-system/dist` is
      // absent in this container — a package that instrument does not import.
      // Reporting NOT RUN for an instrument that would have run and measured
      // is the same class of error as the one B-21 is about, pointing the
      // other way: it manufactures an absence of evidence. So the BLOCKING
      // criterion is the dist actually in the import chain
      // (config.ts imports @daftar/accounting), and the survey of the rest is
      // information printed beside it.
      const survey: string[] = [];
      try {
        for (const name of readdirSync(join(ROOT, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
          const pkgPath = join(ROOT, 'packages', name, 'package.json');
          if (!existsSync(pkgPath)) continue;
          let main: unknown;
          try {
            main = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: unknown }).main;
          } catch {
            survey.push(`${name}: package.json unreadable`);
            continue;
          }
          if (typeof main !== 'string') continue;
          survey.push(`${name}${existsSync(join(ROOT, 'packages', name, main)) ? '' : ' NOT BUILT'}`);
        }
      } catch {
        return { met: false, detail: 'packages/ could not be read, so the build state is UNKNOWN — which is not the same as built' };
      }
      const acc = join(ROOT, 'packages/accounting');
      let accMain = 'dist/index.js';
      try {
        const m = (JSON.parse(readFileSync(join(acc, 'package.json'), 'utf8')) as { main?: unknown }).main;
        if (typeof m === 'string') accMain = m;
      } catch {
        return { met: false, detail: 'packages/accounting/package.json is unreadable, so the dist it declares is UNKNOWN' };
      }
      const built = existsSync(join(acc, accMain));
      const surveyLine = `survey of every workspace package: ${survey.join(', ')} (only accounting blocks, the rest is information)`;
      return built
        ? { met: true, detail: `packages/accounting → ${accMain} exists. ${surveyLine}` }
        : {
            met: false,
            detail:
              `packages/accounting → ${accMain} is MISSING. Run \`npm run build\`. Without it the gap-list instruments die with ` +
              `MODULE_NOT_FOUND and exit 1, which reads in a log exactly like a measured finding. ${surveyLine}`,
          };
    },
  },
  {
    id: 'phase4-ref',
    kind: 'environment',
    what: 'the Phase 4 candidate ref is present in THIS clone',
    how: "git rev-parse --verify on 969b8605, then origin/phase/4-sales-pos-customers-receivables",
    measure: () => {
      for (const ref of ['969b8605', 'origin/phase/4-sales-pos-customers-receivables']) {
        const r = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, encoding: 'utf8' });
        if (r.status === 0) return { met: true, detail: `${ref} resolves to ${(r.stdout ?? '').trim()}` };
      }
      return {
        met: false,
        detail:
          'neither 969b8605 nor origin/phase/4-sales-pos-customers-receivables resolves here. The candidate-train probes have no subject, so what they report is about this clone’s absence, not about the candidate.',
      };
    },
  },
  {
    id: 'locale',
    kind: 'environment',
    what: 'the OS carries an en_US.utf8 locale, which TL-P4-S3-R4 makes the deploy collation',
    how: 'locale -a, matched case-insensitively against en_US.utf8 / en_US.UTF-8',
    measure: () => {
      const r = spawnSync('locale', ['-a'], { encoding: 'utf8' });
      if (r.status !== 0) return { met: false, detail: '`locale -a` did not run, so the available collations are UNKNOWN' };
      const hit = (r.stdout ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^en_US\.utf-?8$/i.test(l));
      return hit.length > 0
        ? { met: true, detail: `locale -a lists ${hit.join(', ')}` }
        : {
            met: false,
            detail:
              'no en_US.utf8 in `locale -a`. A cluster initialised without it is not the settled deploy collation, so a result measured on it is off-target (localedef can generate it).',
          };
    },
  },
  {
    id: 'role-read-url',
    kind: 'caller-supplied',
    what: 'P15_ROLE_READ_URL names a database whose role attributes are to be read',
    how: 'process.env.P15_ROLE_READ_URL',
    measure: () => {
      const url = process.env['P15_ROLE_READ_URL'];
      return url === undefined || url === ''
        ? {
            met: false,
            detail:
              'P15_ROLE_READ_URL is unset. The instrument reads pg_roles on a database the CALLER names; it refuses to pick one, which is right — a role report attributed to a database nobody asked about is worse than no report.',
          }
        : { met: true, detail: 'P15_ROLE_READ_URL is set (its value is a credential and is not printed)' };
    },
  },
  {
    id: 'rc-archive',
    kind: 'caller-supplied',
    what: 'a release-candidate archive or extracted tree is named for the identity check to verify',
    how: '--archive=<zip> or --dir=<tree>, which `npm run verify:rc-identity` alone does not supply',
    measure: () => ({
      met: false,
      detail:
        'no archive or directory is named. The instrument prints UNMEASURED and exits 1, so recording that 1 as its exit code in a handoff would present a refusal to guess as a measurement that failed.',
    }),
  },
  {
    id: 'load-profile',
    kind: 'caller-supplied',
    what: 'a load profile id is named on the command line',
    how: '--profile <id>, which `npm run load:harness` alone does not supply',
    measure: () => ({
      met: false,
      detail:
        'no profile is named. `load:harness` refuses with NO-PROFILE-NAMED rather than choosing one, so running it bare would record a refusal as though it were a load measurement. `npm run load:profiles` lists the declared ids.',
    }),
  },
];

const preconditionState = new Map<string, { readonly met: boolean; readonly detail: string }>();

const INSTRUMENTS: readonly Instrument[] = [
  {
    script: 'verify:gap-list:static',
    what: 'the four historical gap items that need no cluster',
    cluster: false,
    nonZeroMeans: 'at least one item is UNMEASURED — not that an item failed',
    requires: ['build-accounting'],
  },
  {
    script: 'verify:alert-signals',
    what: 'every alert rule against the signals the tree emits, plus the §22.2 table',
    cluster: false,
    nonZeroMeans: 'a rule claim and the tree disagree',
  },
  {
    script: 'verify:alert-signals:prove',
    // The COUNT is not written here. It was "nine" while the harness carried
    // ten, and a number in one file about another file's contents goes stale
    // the first time the other file grows (coordinator F-12). The instrument's
    // own output states its count; this says what it measures.
    what: 'every planted defect the alert check must redden on — the count is the harness\u2019s to state, not this inventory\u2019s',
    cluster: false,
    nonZeroMeans: 'a planted defect did NOT redden the check, so the check’s laws are unproved',
  },
  {
    script: 'verify:exit-codes:phase15',
    what: 'every command the pack runs, and whether its exit code is read at all',
    cluster: false,
    nonZeroMeans: 'a tool in the pack can read the empty output of a command that did not run as an answer',
  },
  {
    script: 'verify:exit-codes:phase15:prove',
    what: 'the planted defects the sweep must redden on, its wrapper exemptions among them',
    cluster: false,
    nonZeroMeans: 'the sweep did not notice a reintroduced discarded exit code, so its green verdict is worthless',
  },
  {
    script: 'verify:handoff-manifest',
    what: "this pack's digests, both directions, and whether its header is current",
    cluster: false,
    nonZeroMeans: 'a digest is stale, an artifact is unlisted, or a header claim no longer matches the branch',
  },
  {
    script: 'verify:outcome-class:prove',
    what: "what a non-zero exit code means, measured from real process output — a crash before measuring, a crash after the totals print, and the two controls",
    cluster: false,
    nonZeroMeans: "the record cannot tell a crash from a verdict, so every outcome class in this log is a label rather than a reading",
  },
  {
    script: 'verify:handoff-manifest:prove',
    what: "the ways the manifest's prose and the challenge reports on disk can disagree, and the one way they only appear to",
    cluster: false,
    nonZeroMeans: "direction 4 did not redden on a planted contradiction, or it failed a correction for quoting the claim it retracts",
  },
  {
    script: 'checkpoint:phase15',
    what: 'the PART 22 resumable checkpoint, re-checked (read-only: this runner never regenerates it)',
    cluster: false,
    nonZeroMeans: 'the checkpoint on disk does not match what this head would generate',
  },
  {
    script: 'checkpoint:phase15:prove',
    what: 'every planted defect the checkpoint currency check must redden on, the deleted pack among them',
    cluster: false,
    nonZeroMeans: '1 = a planted defect did not redden the check; 2 = the proof could not be set up, which is not a failure',
  },
  {
    script: 'audit:deps:phase15',
    what: 'the dependency advisories at the declared severity floor',
    cluster: false,
    nonZeroMeans: 'advisories at or above the floor exist — a substantive finding, not an unmeasured one',
  },
  {
    script: 'scan:secrets:release',
    what: 'the whole shipped tree for secrets, with every file bound to its index blob OID',
    cluster: false,
    nonZeroMeans: '1 = a finding OR an UNMEASURED scan (the tool could not be obtained); the summary line says which',
  },
  {
    script: 'scan:secrets:release:prove',
    what: 'the ways the release scan can miss a subject — an unmerged path, a dirty tracked file, a nested ignore file',
    cluster: false,
    nonZeroMeans: 'the scan did not notice a planted hole in its own coverage, so its 0 findings are a statement about what it looked at, not about the tree',
  },
  {
    script: 'verify:rc-identity',
    what: 'the release-candidate identity claims, over an archive the CALLER names',
    cluster: false,
    nonZeroMeans: '1 = an identity claim and the tree disagree, OR no archive was named and nothing was checked',
    requires: ['rc-archive'],
  },
  {
    script: 'verify:role-attributes',
    what: 'elevated attributes on daftar_% roles, read from pg_roles on a database the CALLER names',
    cluster: false,
    nonZeroMeans: '1 = an unauthorised attribute; 2 = NOT MEASURED',
    requires: ['role-read-url'],
  },
  {
    script: 'verify:role-attributes:prove',
    what: 'four controls on a disposable cluster proving the attribute read catches what it claims to',
    cluster: true,
    nonZeroMeans: '1 = a control failed; 2 = a control could not be STARTED, which is not a failure',
    requires: ['locale'],
  },
  {
    script: 'verify:gap-list',
    what: 'all five historical gap items; G4 starts its own cluster',
    cluster: true,
    nonZeroMeans: 'at least one item is UNMEASURED',
    requires: ['build-accounting', 'locale'],
  },
  {
    script: 'verify:pg-matrix',
    what: 'the three measured contexts and the candidate train',
    cluster: true,
    nonZeroMeans: '1 = a probe was not measured; 2 = a divergence the tree does not account for',
    requires: ['locale', 'phase4-ref'],
  },
  {
    script: 'verify:role-convergence',
    what: '§10.0 on the candidate blobs',
    cluster: true,
    nonZeroMeans: 'a case could not be measured, which is not a clean bill',
    requires: ['locale'],
  },
  {
    script: 'dr:proof',
    what: 'the nine backup/restore validators on a real cluster',
    cluster: true,
    nonZeroMeans: 'a validator failed or could not be measured; the report names which',
    requires: ['locale'],
  },
  {
    script: 'dr:proof:prove',
    what: 'the planted defects every DR validator must redden on',
    cluster: true,
    nonZeroMeans: 'a validator did not redden on its own planted defect',
    requires: ['locale'],
  },
  {
    script: 'pitr:proof',
    what: 'the PITR validators, with PARTIAL coverage reported where it is partial',
    cluster: true,
    nonZeroMeans: 'a validator failed or could not be measured',
    requires: ['locale'],
  },
  {
    script: 'pitr:proof:prove',
    what: 'the planted defects the PITR validators must redden on',
    cluster: true,
    nonZeroMeans: 'a validator did not redden on its own planted defect',
    requires: ['locale'],
  },
  {
    script: 'test:phase15:load-harness',
    what: 'the load harness’s own laws, as unit cases',
    cluster: false,
    nonZeroMeans: 'a case failed',
  },
  {
    script: 'load:harness',
    what: 'a named load profile against a database — the measurement itself, not its laws',
    cluster: true,
    nonZeroMeans: 'the harness refused (no profile named) or the run was invalid',
    requires: ['load-profile'],
  },
];

/**
 * COVERAGE — B-20
 * ---------------------------------------------------------------------------
 * The challenger's F-06: this runner drove SIX of the pack's instruments, so
 * the handoff's exit-code table omitted thirteen — including
 * `audit:deps:phase15`, the only one failing for a substantive reason. The
 * list above is now every Phase 15 script key in `package.json` except this
 * runner itself, which cannot run itself.
 *
 * The count is not taken on trust either: `checkCoverage` below reads the
 * script keys out of `package.json` and reports any Phase 15 instrument this
 * list does not name. A coverage claim that cannot notice a new instrument is
 * the same defect as a count nobody measured.
 */
function checkCoverage(): { readonly total: number; readonly missing: readonly string[]; readonly readFailed: boolean } {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    // TWO families, counted separately, because counting one of them was how
    // "drives all 19" came to sit beside "20 instruments" in the handoff
    // (coordinator F-3). A Phase 15 instrument is a script that RUNS
    // scripts/phase15/, or a vitest suite over this phase's own tests; the
    // runner itself cannot run itself, and `load:profiles` is a listing.
    const phase15 = Object.keys(scripts).filter((k) => {
      const cmd = scripts[k] ?? '';
      if (k === 'verify:evidence-log' || k === 'load:profiles') return false;
      return /scripts\/phase15\//.test(cmd) || /tests\/.*p15-/.test(cmd);
    });
    return { total: phase15.length, missing: phase15.filter((k) => !INSTRUMENTS.some((i) => i.script === k)), readFailed: false };
  } catch (e) {
    // A coverage figure this function could not compute is not a coverage
    // figure. It used to return -1 and a prose line, which the exit code then
    // ignored — so an unreadable package.json read as full coverage.
    return { total: -1, missing: [`package.json could not be read (${e instanceof Error ? e.message : String(e)}), so COVERAGE IS UNKNOWN`], readFailed: true };
  }
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function sourceIdentity(): { sha: string; base: string; clean: boolean; runNonce: string } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  // PART 19 wants the BASE SHA as well as the subject: a result is about a diff
  // from somewhere, and "measured at X" alone does not say from what.
  const mb = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' });
  return {
    sha: head.status === 0 ? head.stdout.trim() : 'UNKNOWN',
    base: mb.status === 0 ? `${mb.stdout.trim()} (merge-base with origin/main)` : 'UNKNOWN — origin/main not reachable from here',
    clean: st.status === 0 && (st.stdout ?? '').trim() === '',
    runNonce: randomBytes(6).toString('hex'),
  };
}

interface Result {
  readonly instrument: Instrument;
  readonly runId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly ms: number;
  readonly startedUtc: string;
  readonly endedUtc: string;
  readonly logPath: string;
  readonly logSha: string;
  readonly logBytes: number;
  readonly ran: boolean;
  /** set when a declared precondition was unmet, so the instrument was NOT executed. */
  readonly notRunReason: string | null;
  /** the instrument's own stdout+stderr, kept so the crash/measured split has evidence. */
  readonly output: string;
  /** PART 19: counts read FROM THE OUTPUT, never asserted. */
  readonly counts: Counts;
  /** PART 19: database version/collation, execution role and fixture identity. */
  readonly subject: Subject;
}

/**
 * PART 19 requires test counts, skips and measurement validity in the record.
 * These are SCRAPED from each instrument's own output, so they are reports of
 * what the instrument said rather than claims of this runner's own. When a
 * pattern does not match, the field is `null` — absent, not zero. A zero would
 * read as "no skips", and "not stated" is a different fact.
 *
 * WHY THIS READS ONE SUMMARY LINE AND NOT THE WHOLE OUTPUT
 *
 * The first version of this scraper searched the entire output for
 * `(\d+)\s+UNMEASURED`, and it produced two WRONG numbers that both looked
 * entirely plausible:
 *
 *   · `G4  UNMEASURED Platform LOGIN role blast radius…` — the item's own id was
 *     read as a count, so a list with ONE unmeasured item reported FOUR.
 *   · `V1  MEASURED  Which PostgreSQL versions…` — likewise, an 8-probe run
 *     reported ONE measured.
 *
 * Neither was detectable from the number alone, which is the whole hazard: this
 * pack has already recorded one count error that came from measuring the wrong
 * thing (counting diff lines instead of comparing `package.json` keys), and the
 * alert contract forbids «changing the EXPECTED value to match the actual one»
 * for the same reason. A number that cannot say where it came from should not be
 * in a handoff.
 *
 * So the scrape is now deliberately narrow: it reads counts ONLY from a line
 * that is a SUMMARY line — start-anchored, of a shape an instrument uses to
 * total itself — and it records that line verbatim in `readFrom`, which the
 * report prints beside the numbers. A reader can therefore check every count
 * against the sentence it was taken from without opening the log, and an
 * instrument whose summary this does not recognise reports NOT STATED rather
 * than a number scavenged from its body.
 */


/**
 * The summary shapes the instruments in this pack actually print. Each is
 * start-anchored so an item id (`G4`, `V1`) can never be read as a count.
 */


interface Subject {
  /** every distinct "<version>, collate <x>" the output names, in order of appearance. */
  readonly servers: readonly string[];
  /** the principal the instrument says it ran SQL as. */
  readonly principal: string | null;
  /** whether the instrument itself declares its subject a fixture. */
  readonly declaresFixture: boolean;
}

function scrapeSubject(out: string): Subject {
  const servers: string[] = [];
  const re = /((?:\d+\.\d+[^,\n]*?))(?:\s*\(server_version_num\s*(\d+)\))?,\s*collate\s+([A-Za-z0-9_.-]+)/g;
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const label = `PostgreSQL ${m[1]?.trim() ?? '?'}${m[2] === undefined ? '' : ` (num ${m[2]})`} @ collate ${m[3] ?? '?'}`;
    if (!servers.includes(label)) servers.push(label);
  }
  // The principal is scraped from the instrument's own PRINCIPAL sentence,
  // which V3 §7 requires it to print. Matching on the word the ruling uses
  // keeps this runner from guessing when the sentence is absent.
  // The sentence wraps in a console report, so this must cross newlines; it is
  // bounded to a few hundred characters so it cannot reach into an unrelated
  // paragraph and attribute a principal the instrument never claimed.
  const prin = /PRINCIPAL[\s\S]{0,400}?\b(SUPERUSER|superuser|daftar_migrator|daftar_app|daftar_reconciler)\b/.exec(out);
  // A `CLUSTER:` identity line states the principal as a measured fact —
  // `read as <role> (is_superuser=<on|off>)` straight from `current_user` —
  // which is better evidence than a prose PRINCIPAL sentence, so it is
  // preferred when present. The prose sentence remains the fallback, because
  // an instrument that explains its principal in words is still stating it.
  const measuredRole = /read as\s+([A-Za-z0-9_]+)\s+\(is_superuser=(on|off)\)/.exec(out);
  return {
    servers,
    principal:
      measuredRole !== null
        ? `${measuredRole[1] ?? '?'} (is_superuser=${measuredRole[2] ?? '?'}, measured by current_user)`
        : prin?.[1] === undefined
          ? null
          : prin[1].toLowerCase() === 'superuser'
            ? 'SUPERUSER (the disposable cluster\u2019s own, as the instrument states it in prose)'
            : prin[1],
    declaresFixture: /\bfixture\b/i.test(out),
  };
}

/** PART 19: the runtime the evidence was produced on, measured not remembered. */
function runtimeIdentity(): { readonly node: string; readonly npm: string; readonly psql: string; readonly embedded: string; readonly os: string } {
  const v = (cmd: string, args: readonly string[]): string => {
    const r = spawnSync(cmd, [...args], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout ?? '').trim().split('\n')[0] ?? 'unknown' : 'not present';
  };
  return {
    node: process.version,
    npm: v('npm', ['--version']),
    psql: v('/usr/lib/postgresql/16/bin/psql', ['--version']),
    embedded: v(join(ROOT, 'node_modules/@embedded-postgres/linux-x64/native/bin/initdb'), ['--version']),
    os: v('uname', ['-sr']),
  };
}

function run(inst: Instrument, src: ReturnType<typeof sourceIdentity>, i: number): Result {
  const runId = `${src.sha.slice(0, 12)}${src.clean ? '' : '+dirty'}-${src.runNonce}-${String(i).padStart(2, '0')}`;
  const logPath = join(LOG_DIR, `${inst.script.replace(/[:]/g, '_')}.${runId}.log`);
  const startedAt = new Date();
  const started = Date.now();
  // P15_PROVE_CRASH names ONE instrument to be run with a poisoned loader, so
  // the CRASHED-BEFORE-MEASURING arm can be proved with a real module error
  // rather than a hand-written Result. The law B-21 is about — a crash and a
  // measured-but-adverse run must not print the same way — is otherwise a
  // claim about a code path nobody has seen taken. The variable only ever adds
  // a NODE_OPTIONS that cannot resolve; it changes no instrument's arguments
  // and is printed below when it is in effect.
  // P15_PROVE_CRASH=<script>[:loader|:late] makes the classifier's crash arms
  // provable with a REAL failure instead of a hand-written Result. B-21's law
  // is that a crash and a measured-but-adverse run must not print the same way,
  // and until this existed that law was a claim about a path nobody had taken.
  //
  // The coordinator's F-6 was right about the first version: a poisoned
  // NODE_OPTIONS crashes NPM, not the instrument, so what it proved was the
  // spawn arm wearing the crash arm's label. The poison is now delivered to the
  // INSTRUMENT'S OWN node process, by running the command `package.json`
  // records for it with an injected `--import`:
  //
  //   :loader  a module that throws on import — the instrument dies before its
  //            own first line, which is the MODULE_NOT_FOUND case B-21 names.
  //   :late    a module that lets the instrument run to completion and then
  //            throws from a `beforeExit` hook — so its totals print and the
  //            process still dies. That is the MEASURED-THEN-THREW arm, which
  //            F-6 showed was being classified as a verdict.
  //
  // Both are recorded like any other run: same run id, same log, same digest.
  const poisonSpec = process.env['P15_PROVE_CRASH'] ?? '';
  // Parsed from the END, because every instrument name in this pack contains
  // colons (`verify:alert-signals`) and a leading split shredded it — the
  // poison then matched nothing and both arms printed as ordinary runs, which
  // is exactly the kind of silently-vacuous proof this file keeps catching.
  const poisonMode = /:(loader|late)$/.exec(poisonSpec)?.[1] ?? 'loader';
  const poisonScript = poisonSpec.replace(/:(loader|late)$/, '');
  const poison = poisonSpec !== '' && poisonScript === inst.script;
  let argv: readonly string[] = ['run', '-s', inst.script];
  let bin = 'npm';
  if (poison) {
    const cmd = ((): string | null => {
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        return pkg.scripts?.[inst.script] ?? null;
      } catch {
        return null;
      }
    })();
    const target = cmd === null ? null : /(?:^|\s)(scripts\/phase15\/[A-Za-z0-9_.-]+\.ts)/.exec(cmd)?.[1] ?? null;
    if (target === null) {
      console.log(`  ! P15_PROVE_CRASH names ${inst.script}, but its command is not a single scripts/phase15 entry point, so it cannot be poisoned in its own process. NOT POISONED.`);
    } else {
      const hook = join(LOG_DIR, poisonMode === 'late' ? 'p15-poison-late.mjs' : 'p15-poison-loader.mjs');
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        hook,
        poisonMode === 'late'
          ? "process.on('beforeExit', () => { throw new TypeError('P15_PROVE_CRASH: an uncaught runtime error AFTER the summary line'); });\n"
          : "throw new Error('P15_PROVE_CRASH: Cannot find module — the instrument dies before its own first line');\n",
      );
      bin = 'npx';
      argv = ['tsx', `--import=${hook}`, join(ROOT, target)];
      console.log(`  ! P15_PROVE_CRASH (${poisonMode}) is injected into THIS INSTRUMENT'S own process, on purpose: ${target}`);
    }
  }
  const r = spawnSync(bin, [...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const endedAt = new Date();
  // The log is the stdout and stderr as the process produced them, plus a header
  // naming what produced it. A log that cannot say what it is is not evidence.
  const rt = runtimeIdentity();
  const body =
    `# P15 EVIDENCE LOG\n# command  : npm run ${inst.script}\n# run id   : ${runId}\n` +
    `# source   : ${src.sha}${src.clean ? ' (clean tree)' : ' PLUS UNCOMMITTED CHANGES'}\n` +
    `# base     : ${src.base}\n` +
    `# exit     : ${r.status === null ? `KILLED by signal ${String(r.signal)}` : String(r.status)}\n` +
    `# utc      : ${startedAt.toISOString()} → ${endedAt.toISOString()} (${ms} ms)\n` +
    `# runtime  : node ${rt.node}, npm ${rt.npm}, ${rt.psql}, embedded ${rt.embedded}\n` +
    `# os       : ${rt.os}\n# ---\n${r.stdout ?? ''}${(r.stderr ?? '').length > 0 ? `\n# --- stderr ---\n${r.stderr}` : ''}`;
  writeFileSync(logPath, body);
  return {
    instrument: inst,
    runId,
    notRunReason: null,
    output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    startedUtc: startedAt.toISOString(),
    endedUtc: endedAt.toISOString(),
    counts: scrape(`${r.stdout ?? ''}${r.stderr ?? ''}`),
    subject: scrapeSubject(`${r.stdout ?? ''}${r.stderr ?? ''}`),
    exitCode: r.status,
    signal: r.signal === null ? null : String(r.signal),
    ms,
    logPath,
    logSha: sha256(readFileSync(logPath)),
    logBytes: Buffer.byteLength(body),
    // `ran` is about the RUNNER, not the verdict: did the process start and
    // return a code of its own, or did it die on a signal / fail to spawn?
    ran: r.error === undefined && r.status !== null,
  };
}

/**
 * An instrument that was NOT executed, recorded as such. It carries no exit
 * code, no duration and no log, because inventing any of those is exactly the
 * fabrication the evidence rules forbid: "I could not look" and "I looked and
 * it is clean" must never print the same way.
 */
function notRun(inst: Instrument, reason: string): Result {
  // NO TIMESTAMPS. The first version stamped `new Date()` on both ends, which
  // put a UTC window in the record for a run that never happened, and the
  // printed exit then read "KILLED by null" because the fields it formats were
  // empty (coordinator F-10). A record of a non-run carries no window, no
  // signal and no log, and says so in each field.
  return {
    instrument: inst,
    runId: 'NOT RUN',
    notRunReason: reason,
    output: '',
    startedUtc: 'none — nothing started',
    endedUtc: 'none — nothing ran',
    counts: { measured: null, unmeasured: null, findings: null, skips: null, dirtyTreeDeclared: false, readFrom: null },
    subject: { servers: [], principal: null, declaresFixture: false },
    exitCode: null,
    signal: null,
    ms: 0,
    logPath: 'none — nothing ran, so there is no log',
    logSha: 'none',
    logBytes: 0,
    ran: false,
  };
}

/**
 * WAS THIS EXIT CODE A VERDICT AT ALL? — B-21
 *
 * `verify:gap-list:static` exits 1 when it ran and found an item UNMEASURED,
 * and exits 1 when it never ran because `@daftar/accounting` was not built.
 * The number cannot tell those apart, but the OUTPUT can: an instrument that
 * reached its own summary line measured something, and one that died in the
 * module loader did not. So the classification is made from evidence in the
 * log rather than from the code, and it is a statement about the RUN — the
 * same charter `validity` has — not a re-grading of the instrument's verdict.
 *
 * A fourth case is kept distinct deliberately: non-zero, no crash marker, and
 * no summary line this runner recognises. Calling that "measured" would be a
 * guess, so it is named as unclassified and the log is the only recourse.
 */
/** A loader or parse failure: the instrument never began its own work. */

/**
 * An UNCAUGHT RUNTIME failure, which can happen at any point — including
 * after the summary line has already printed.
 *
 * The coordinator's F-6: the classifier recognised loader errors only, so a
 * `TypeError` thrown after an instrument printed its totals was classified
 * "MEASURED, THEN EXITED NON-ZERO — the code is its verdict". It is not a
 * verdict: the process died, and whatever it had printed describes an
 * incomplete run. A crash that happens LATE is still a crash, and the record
 * has to be able to say "it measured, and then it threw", which is a third
 * thing.
 */

/**
 * An instrument's own closing VERDICT line, which is evidence that it reached
 * its end — separate from the count scrape, which stays deliberately narrow
 * because it feeds numbers into a handoff.
 *
 * The first version of this classification had only the count scrape to work
 * with, so five instruments that had plainly finished — each printing its own
 * `PHASE 15 …: FAIL` or `EXIT 1 — THE CHECKPOINT IS STALE` — were reported as
 * UNCLASSIFIED NON-ZERO. Honest, but useless: the record said "only the log
 * settles it" about five runs whose logs settle it in one line. The patterns
 * below are measured from what those instruments actually print, and anything
 * they do not match still falls through to UNCLASSIFIED rather than being
 * assumed to have finished.
 */





/**
 * PART 19's last field: MEASUREMENT VALIDITY. This is the one judgement the
 * runner is entitled to make, because it is a judgement about the RUN and not
 * about the subject: did the process return a code of its own, and was the tree
 * it ran on the final one? It deliberately does NOT say whether the instrument's
 * verdict is right — that is the reader's, and a runner that graded its own
 * children would be the self-signature PART 15 forbids.
 */
function validity(r: Result, src: ReturnType<typeof sourceIdentity>): string {
  if (!r.ran) {
    return r.signal === null
      ? 'INVALID \u2014 the process never started, so there is no measurement here at all'
      : `INVALID \u2014 killed by ${r.signal}; a killed run is not a result, whatever its log holds before the kill`;
  }
  if (!src.clean) {
    return 'VALID AS A PREPARATION MEASUREMENT ONLY \u2014 the tree carries uncommitted changes, so under \u00a779 / V3 \u00a722.3 this is not the final-SHA evidence and the run id says so';
  }
  return 'VALID \u2014 the instrument ran to completion on a clean tree and returned its own exit code';
}

function main(): number {
  const quick = process.argv.includes('--quick');
  const src = sourceIdentity();
  mkdirSync(LOG_DIR, { recursive: true });

  console.log('P15 — EVIDENCE RUN LOG (Mission V3 §9: commands, run IDs, EXIT CODES)');
  console.log('='.repeat(78));
  console.log(`source   : ${src.sha}${src.clean ? ' (clean tree)' : ' PLUS UNCOMMITTED CHANGES'}`);
  console.log(`logs     : ${LOG_DIR}`);
  console.log(`selection: ${quick ? 'cluster-free instruments only (--quick)' : 'every instrument'}`);
  if (!src.clean) {
    console.log('');
    console.log('! THE TREE IS NOT CLEAN. Under §79 / V3 §22.3 the final evidence runs on the FINAL');
    console.log('  EXACT SHA with a clean tree, so this run is a preparation measurement and the run');
    console.log('  ids below carry +dirty so it can never be read as the final one.');
  }
  console.log('');

  // ── coverage, measured from package.json rather than claimed ──────────
  const coverage = checkCoverage();
  console.log('COVERAGE (B-20) — measured against package.json, not declared');
  console.log(`  ${INSTRUMENTS.length} instrument(s) in this runner's inventory; ${coverage.total} Phase 15 script key(s) in package.json`);
  if (coverage.missing.length > 0) {
    console.log(`  ! ${coverage.missing.length} instrument(s) this runner does NOT drive: ${coverage.missing.join(', ')}`);
    console.log('    An instrument outside the inventory carries no exit code in this record, which is');
    console.log('    the gap B-20 named. It is printed rather than left to a reader to notice.');
  } else {
    console.log('  every Phase 15 instrument is in the inventory (verify:evidence-log cannot run itself;');
    console.log('  load:profiles is a listing, not a measurement).');
  }
  console.log('');

  // ── preconditions, declared above and measured now ────────────────────
  console.log('PRECONDITIONS (B-21) — declared, measured, and named before anything runs');
  for (const pre of PRECONDITIONS) {
    const m = pre.measure();
    preconditionState.set(pre.id, m);
    console.log(`  ${m.met ? 'MET    ' : 'NOT MET'}  ${pre.id} (${pre.kind})  — ${pre.what}`);
    console.log(`            how: ${pre.how}`);
    console.log(`            ${m.detail}`);
  }
  console.log('');

  const unmetBlocking = (inst: Instrument): { readonly reason: string; readonly kind: Precondition['kind'] } | null => {
    for (const id of inst.requires ?? []) {
      const pre = PRECONDITIONS.find((x) => x.id === id);
      const state = preconditionState.get(id);
      if (pre === undefined || state === undefined) return { reason: `precondition "${id}" is referenced but not declared`, kind: 'environment' };
      if (!state.met) return { reason: `precondition "${id}" is NOT MET — ${state.detail}`, kind: pre.kind };
    }
    return null;
  };

  const chosen = INSTRUMENTS.filter((i) => !quick || !i.cluster);
  const results: Result[] = [];
  let blockedByEnvironment = 0;
  for (const [i, inst] of chosen.entries()) {
    const blocked = unmetBlocking(inst);
    if (blocked !== null) {
      console.log(`→ npm run ${inst.script}  NOT RUN (${blocked.kind} precondition)`);
      console.log(`  ${blocked.reason}`);
      if (blocked.kind === 'environment') blockedByEnvironment += 1;
      results.push(notRun(inst, blocked.reason));
      continue;
    }
    console.log(`→ npm run ${inst.script}  (${inst.cluster ? 'starts a cluster' : 'no cluster'})`);
    const res = run(inst, src, i);
    console.log(
      `  exit ${res.exitCode === null ? `KILLED (${String(res.signal)})` : String(res.exitCode)}  ${(res.ms / 1000).toFixed(1)}s  log ${res.logBytes} bytes  ${outcomeClass(res)}`,
    );
    results.push(res);
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log('COMMAND                          EXIT   DURATION   RUN ID');
  for (const r of results) {
    const exit = r.notRunReason !== null ? '—' : r.exitCode === null ? `KILL` : String(r.exitCode);
    console.log(`${`npm run ${r.instrument.script}`.padEnd(32)} ${exit.padEnd(6)} ${`${(r.ms / 1000).toFixed(1)}s`.padEnd(10)} ${r.runId}`);
  }
  console.log('-'.repeat(78));
  console.log('');
  console.log('WHAT A NON-ZERO EXIT MEANS, PER INSTRUMENT');
  console.log('  Recorded because it differs, and flattening it into "failure" would be as wrong');
  console.log('  as flattening it into "pass".');
  for (const r of results) {
    console.log(`  ${r.instrument.script}: ${r.instrument.nonZeroMeans}`);
  }
  console.log('');
  console.log('THE PART 19 RECORD, PER PROOF');
  console.log('  HIGH-VELOCITY PART 19 asks each proof to carry its command, exact SHA, base SHA,');
  console.log('  tree status, runtime versions, database version and collation, execution role,');
  console.log('  fixture identity, UTC start and end, exit code, test counts, skips, its logs,');
  console.log('  artifact hashes and its measurement validity. Every line below is measured or');
  console.log('  read from the instrument\u2019s own output; NOT STATED means the instrument did not');
  console.log('  say, which is recorded rather than filled in.');
  const rt = runtimeIdentity();
  console.log('');
  console.log(`  runtime (shared by every run): node ${rt.node}, npm ${rt.npm}, ${rt.psql}, embedded initdb ${rt.embedded}`);
  console.log(`  os      (shared by every run): ${rt.os}`);
  console.log(`  source  : ${src.sha}  (${src.clean ? 'clean tree' : 'TREE NOT CLEAN \u2014 preparation measurement'})`);
  console.log(`  base    : ${src.base}`);
  const stated = (n: number | null): string => (n === null ? 'NOT STATED' : String(n));
  for (const r of results) {
    console.log('');
    console.log(`  \u2500\u2500 npm run ${r.instrument.script}`);
    console.log(`     measures : ${r.instrument.what}`);
    console.log(`     run id   : ${r.runId}`);
    console.log(`     utc      : ${r.notRunReason !== null ? 'none — no run, so no window' : `${r.startedUtc} \u2192 ${r.endedUtc}  (${(r.ms / 1000).toFixed(1)}s)`}`);
    console.log(`     exit     : ${r.notRunReason !== null ? 'none — this instrument was not run' : r.exitCode === null ? `KILLED by ${String(r.signal)}` : String(r.exitCode)}`);
    console.log(`     database : ${r.subject.servers.length === 0 ? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT \u2014 and it starts a cluster, so this is a gap in its record' : 'none \u2014 this instrument reads the tree and starts no cluster') : r.subject.servers.join('; ')}`);
    console.log(`     role     : ${r.subject.principal ?? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT' : 'none \u2014 no SQL is executed')}`);
    console.log(`     fixture  : ${r.subject.declaresFixture ? 'the instrument declares its subject a FIXTURE, not a real database' : 'no fixture declared in the output'}`);
    console.log(`     counts   : measured ${stated(r.counts.measured)}, unmeasured ${stated(r.counts.unmeasured)}, findings ${stated(r.counts.findings)}, skips ${stated(r.counts.skips)}`);
    console.log(`     read from: ${r.counts.readFrom === null ? 'no summary line this runner recognises \u2014 so NO count is reported, rather than one scavenged from the body' : `\u201c${r.counts.readFrom}\u201d`}`);
    console.log(`     log      : ${r.logPath}`);
    console.log(`                sha256 ${r.logSha}  (${r.logBytes} bytes)`);
    console.log(`     outcome  : ${outcomeClass(r)}`);
    console.log(`     validity : ${validity(r, src)}`);
  }
  console.log('');

  // ── this runner's own exit code ───────────────────────────────────────
  // Distinct codes, because B-21 is precisely about a single code carrying
  // several different facts. Worst first.
  //   1 = an instrument that was run returned no exit code of its own
  //   3 = an instrument crashed BEFORE measuring, so its code is not a verdict
  //   4 = the coverage claim is incomplete or could not be computed
  //   2 = an environment precondition was unmet, so an instrument was not run
  //   0 = every instrument either ran and returned its own code, or was not
  //       run for a caller-supplied precondition it correctly refused to invent
  const noResult = results.filter((r) => r.notRunReason === null && !r.ran);
  const crashed = results.filter((r) => {
    const c = outcomeClass(r);
    return c.startsWith('CRASHED BEFORE MEASURING') || c.startsWith('MEASURED, THEN THREW');
  });
  const skipped = results.filter((r) => r.notRunReason !== null);

  if (skipped.length > 0) {
    console.log(`${skipped.length} instrument(s) were NOT RUN, and carry no exit code here:`);
    for (const r of skipped) console.log(`  ${r.instrument.script} — ${r.notRunReason ?? ''}`);
    console.log('');
  }
  if (noResult.length > 0) {
    console.log(`EXIT 1: ${noResult.length} instrument(s) did not return an exit code of their own:`);
    for (const r of noResult) console.log(`  ${r.instrument.script} — ${r.signal === null ? 'failed to spawn' : `killed by ${r.signal}`}`);
    console.log('  A killed run is NOT a result, whatever its log says before the kill.');
    return 1;
  }
  if (crashed.length > 0) {
    console.log(`EXIT 3: ${crashed.length} instrument(s) died rather than returned a verdict:`);
    for (const r of crashed) console.log(`  ${r.instrument.script} — exit ${String(r.exitCode)}: ${outcomeClass(r)}`);
    console.log('  This is the collision B-21 named: the same exit 1 means "I measured and found a gap"');
    console.log('  and "I never started". A record that cannot tell them apart is not evidence.');
    return 3;
  }
  if (coverage.missing.length > 0) {
    console.log(`EXIT 4: the coverage claim is INCOMPLETE — ${coverage.missing.length} item(s):`);
    for (const m of coverage.missing) console.log(`  ${m}`);
    console.log('  V3 §9 makes the EXIT CODE the thing a handoff carries, and a handoff reader does not');
    console.log('  have this body. So an omission printed over an exit 0 is an omission the handoff loses:');
    console.log('  it recorded B-20 as closed while the gap was open in the record (coordinator F-3). A');
    console.log('  coverage figure this runner could not compute reaches the exit code the same way.');
    return 4;
  }
  if (blockedByEnvironment > 0) {
    console.log(`EXIT 2: ${blockedByEnvironment} instrument(s) were not run because an ENVIRONMENT precondition was unmet.`);
    console.log('  Nothing is claimed about them. This is a defect in the RUN, not in the subject, and');
    console.log('  it is a different fact from any instrument’s own exit code.');
    return 2;
  }
  console.log('EVERY INSTRUMENT RAN AND RETURNED ITS OWN EXIT CODE, OR WAS NOT RUN FOR A');
  console.log('CALLER-SUPPLIED PRECONDITION IT CORRECTLY REFUSED TO INVENT.');
  console.log('  This runner asserts nothing beyond that. The exit codes above are the evidence');
  console.log('  V3 §9 asks a handoff to carry; what each one means is the reader’s to weigh.');
  return 0;
}

process.exitCode = main();
