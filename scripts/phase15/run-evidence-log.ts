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
    id: 'build-inventory',
    kind: 'environment',
    what: '@daftar/inventory is built — the load-harness cases import it, and an unbuilt package makes vitest find no test files',
    how: 'packages/inventory/package.json main, checked for existence on disk',
    measure: () => {
      const pkgPath = join(ROOT, 'packages/inventory/package.json');
      if (!existsSync(pkgPath)) return { met: false, detail: 'packages/inventory/package.json is absent' };
      let main: unknown;
      try {
        main = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: unknown }).main;
      } catch {
        return { met: false, detail: 'packages/inventory/package.json is unreadable' };
      }
      if (typeof main !== 'string') return { met: false, detail: 'packages/inventory/package.json declares no main' };
      const dist = join(ROOT, 'packages/inventory', main);
      return existsSync(dist)
        ? { met: true, detail: `packages/inventory → ${main} exists` }
        : {
            met: false,
            detail: `packages/inventory → ${main} is absent, so the cases cannot import it. Build it and re-run; a vitest run that finds no test files is not a measurement of the harness`,
          };
    },
  },
  {
    id: 'build-accounting',
    kind: 'environment',
    what: 'packages/accounting is built — the dist `verify:gap-list` reaches through apps/api/src/config',
    how: 'packages/accounting/package.json main, checked for existence on disk; plus a non-blocking survey of every workspace package',
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
        for (const name of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)) {
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
    how: 'git rev-parse --verify on 969b8605, then origin/phase/4-sales-pos-customers-receivables',
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
    script: 'pitr:proof:contention',
    what: 'whether the PITR drill tells a busy port from a broken restore: the same drill with its recovered port held, and a copy with that classification blinded',
    cluster: true,
    nonZeroMeans:
      'either a busy port still reads as a failed disaster-recovery drill, or the classification that separates the two is not what produces the difference',
  },
  {
    script: 'verify:exit-codes:phase15:guard',
    what: "the guard-deletion half of the sweep's provenance rule: the same plant against the real sweep and against a copy with that one line removed",
    cluster: false,
    nonZeroMeans:
      'either the sweep no longer catches a helper that invents its exit code, or it still catches it with the provenance requirement deleted — in which case the red proof credits the catch to the wrong rule',
  },
  {
    script: 'verify:handoff-manifest',
    what: "this pack's digests, both directions, and whether its header is current",
    cluster: false,
    nonZeroMeans: 'a digest is stale, an artifact is unlisted, or a header claim no longer matches the branch',
  },
  {
    script: 'verify:outcome-class:prove',
    what: 'what a non-zero exit code means, measured from real process output — a crash before measuring, a crash after the totals print, and the two controls',
    cluster: false,
    nonZeroMeans: 'the record cannot tell a crash from a verdict, so every outcome class in this log is a label rather than a reading',
  },
  {
    script: 'verify:outcome-class:guard',
    what: "whether the HEADLINE preference is what classifies a contention run, measured by deleting it and re-running the whole arm set (round 14's F-R14-01)",
    cluster: false,
    nonZeroMeans:
      'the classifier reads a contention transcript correctly for some other reason than the rule credited with it, or the arm set no longer reddens when that rule is removed',
  },
  {
    script: 'verify:handoff-manifest:prove',
    what: "the ways the manifest's prose and the challenge reports on disk can disagree, and the one way they only appear to",
    cluster: false,
    nonZeroMeans: 'direction 4 did not redden on a planted contradiction, or it failed a correction for quoting the claim it retracts',
  },
  {
    script: 'verify:handoff-manifest:env',
    what: "whether the caller's environment can choose which repository the handoff gate measures OR which git reads it, and whether a failed git read is refused by name rather than counted as zero",
    cluster: false,
    nonZeroMeans:
      "GIT_DIR, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY or a `git` planted in PATH changed what the gate measured, or a read that failed became a figure — either of which makes the gate's VERIFIED a statement about a repository, or an instrument, the caller chose",
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
    what: 'the ways the release scan can miss a subject: an unmerged path, a dirty tracked file, a tree-level and a nested ignore/config file, an empty inventory, a tree below the release floor, gitleaks pointed at an empty directory, and the positive control not requested at all',
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
    // `cluster: true`, and the coordinator's round-7 B4 is why. This entry said
    // "starts no cluster" and declared no preconditions, while the vitest
    // globalSetup starts the shared embedded PostgreSQL on a FIXED port and the
    // cases import `@daftar/inventory`. Both omissions were measured in one
    // run: at 60458ec the port was still held by the instrument before it, the
    // fixture never started, and vitest reported "No test files found" — a
    // setup failure wearing a filter failure's words. An instrument that starts
    // a server and says it does not is also missing from its own PART 19
    // record, where the database version belongs.
    script: 'test:phase15:load-harness',
    what: 'the load harness’s own laws, as unit cases — its globalSetup starts the shared embedded PostgreSQL on a fixed port',
    cluster: true,
    nonZeroMeans:
      'a case failed, OR its fixture could not start — vitest reports an unstartable fixture as "No test files found", so read the log, not the code',
    requires: ['build-inventory'],
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
    return r.status === 0 ? ((r.stdout ?? '').trim().split('\n')[0] ?? 'unknown') : 'not present';
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
    const target = cmd === null ? null : (/(?:^|\s)(scripts\/phase15\/[A-Za-z0-9_.-]+\.ts)/.exec(cmd)?.[1] ?? null);
    if (target === null) {
      console.log(
        `  ! P15_PROVE_CRASH names ${inst.script}, but its command is not a single scripts/phase15 entry point, so it cannot be poisoned in its own process. NOT POISONED.`,
      );
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

/**
 * §8b OF THE HANDOFF MANIFEST, GENERATED.
 *
 * The manifest's §8b said of itself that it is «generated from the runner's own
 * PART 19 records rather than typed here, because a hand-copied exit-code table
 * is one more count nobody measured» — and it was hand-copied. The sentence was
 * true about where the numbers came from and false about how they got into the
 * file, which is the same class of defect as every finding this pack has been
 * answering: a claim slightly wider than the mechanism behind it.
 *
 * So the section is now written. `--emit-section=<path>` is off by default,
 * because this pack's directory has several writers and no bare command of its
 * own writes shared state; the caller names the path, and the manifest's digest
 * table covers the file like any other artifact.
 */
function emitSection(
  path: string,
  results: readonly Result[],
  src: ReturnType<typeof sourceIdentity>,
  rt: ReturnType<typeof runtimeIdentity>,
  coverage: { readonly total: number; readonly missing: readonly string[]; readonly readFailed: boolean },
  preconditionState: ReadonlyMap<string, { readonly met: boolean; readonly detail: string }>,
): void {
  const L: string[] = [];
  const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  L.push('<!-- GENERATED by `npm run verify:evidence-log -- --emit-section=<path>`. Do not hand-edit:');
  L.push('     the next run overwrites it, and a hand-corrected number here would be a count nobody');
  L.push('     measured, which is the defect this file exists to stop. -->');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| exact SHA | \`${src.sha}\` |`);
  L.push(`| base SHA | ${src.base} |`);
  L.push(`| tree | **${src.clean ? 'clean tree' : 'TREE NOT CLEAN — preparation measurement only'}** |`);
  L.push(`| runtime | node ${rt.node}, npm ${rt.npm}, ${rt.psql}, embedded initdb ${rt.embedded} |`);
  // The verdict goes in the TABLE, not only in the runtime string: a reader
  // who takes "runner exit 0" from a summary never reaches a version number.
  const eng = engineVerdict();
  L.push(
    `| authoritative | **${eng.satisfied && src.clean ? 'YES' : 'NO'}** — ${eng.running} against engines.node ${eng.declared ?? 'UNDECLARED'}${eng.satisfied ? '' : ', so this is a DIAGNOSTIC run'}${src.clean ? '' : ', and the tree was not clean'} |`,
  );
  L.push(`| collation | cluster instruments default to \`${SETTLED_COLLATION}\`, the settled deployment line; each proof prints the collation it got |`);
  L.push(`| os | ${rt.os} |`);
  L.push(
    `| coverage | **${results.length} instrument(s) driven** against ${coverage.total} Phase 15 script key(s) in \`package.json\`; **${coverage.readFailed ? 'COVERAGE UNMEASURED — package.json could not be read' : `${coverage.missing.length} omission(s)`}**, measured rather than declared |`,
  );
  L.push('');
  L.push('**The preconditions, measured before anything ran:**');
  L.push('');
  L.push('| precondition | kind | state |');
  L.push('|---|---|---|');
  for (const pre of PRECONDITIONS) {
    const st = preconditionState.get(pre.id);
    L.push(`| \`${pre.id}\` | ${pre.kind} | ${st === undefined ? '**NOT MEASURED**' : st.met ? '**MET**' : `**NOT MET** — ${cell(st.detail)}`} |`);
  }
  L.push('');
  L.push('| command | exit | run id | outcome class | validity |');
  L.push('|---|---|---|---|---|');
  for (const r of results) {
    const exit = r.notRunReason !== null ? '**—**' : r.exitCode === null ? `**KILLED (${String(r.signal)})**` : `**${String(r.exitCode)}**`;
    L.push(
      `| \`npm run ${r.instrument.script}\` | ${exit} | ${r.notRunReason === null ? r.runId : 'not run'} | ${cell(outcomeClass(r))} | ${cell(validity(r, src))} |`,
    );
  }
  L.push('');
  L.push('**What a non-zero exit means, per instrument** — recorded because it differs, and flattening');
  L.push('it into "failure" would be as wrong as flattening it into "pass".');
  L.push('');
  for (const r of results) L.push(`- \`${r.instrument.script}\`: ${r.instrument.nonZeroMeans}`);
  L.push('');
  writeFileSync(path, `${L.join('\n')}\n`);
  console.log(`  §8b written to ${path} — ${results.length} run(s). The manifest references this file; nothing is transcribed by hand.`);
}

/**
 * THE PINNED ENGINE, AND WHY A RUN CAN REFUSE TO BE CALLED AUTHORITATIVE.
 *
 * `package.json` declares `engines.node >= 24 < 25`. Every authoritative run in
 * this pack through round 8 was produced on Node v22.22.0, and the record said
 * so honestly in each proof's runtime line — which is why the coordinator
 * called it a NAMED residual rather than a false claim. But an honest line
 * inside 1,000 lines of record is not a gate: a reader takes "runner exit 0,
 * 25 instruments" from the summary and never reaches it.
 *
 * So the engine is now a VERDICT the run prints about itself, and
 * `--authoritative` makes it a refusal: off the pinned engine, nothing runs and
 * nothing is claimed. Without the flag the run still happens — a diagnostic run
 * on whatever engine the box has is useful — but the banner and the emitted
 * section both carry `AUTHORITATIVE: NO`, so the record cannot be mistaken for
 * the handoff run.
 *
 * Node 24 is not in this container's image. Fetching it is a step, not a round:
 * about 30 MB, digest checked against the published SHASUMS256.txt every time,
 * never trusted from a cache.
 */
function engineVerdict(): { readonly declared: string | null; readonly running: string; readonly satisfied: boolean } {
  const running = process.version;
  let declared: string | null = null;
  try {
    declared = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node ?? null;
  } catch {
    declared = null;
  }
  if (declared === null) return { declared, running, satisfied: false };
  // The declared range in this repo is a `>=A <B` pair on MAJORS, which is all
  // this needs to read. Anything it cannot parse is NOT satisfied: an
  // unreadable range must never be a pass (PART 18).
  const major = Number(/^v(\d+)/.exec(running)?.[1] ?? 'NaN');
  const lo = Number(/>=\s*(\d+)/.exec(declared)?.[1] ?? 'NaN');
  const hi = Number(/<\s*(\d+)/.exec(declared)?.[1] ?? 'NaN');
  if (!Number.isFinite(major) || !Number.isFinite(lo) || !Number.isFinite(hi)) return { declared, running, satisfied: false };
  return { declared, running, satisfied: major >= lo && major < hi };
}

/** The collation the deployment line runs at (`TL-P4-S3-R4`). */
const SETTLED_COLLATION = 'en_US.utf8';

/**
 * THE NON-ZERO EXIT CODES THIS RUNNER TOLERATES — NAMED, WITH THEIR REASONS
 *
 * The coordinator's round-8 R2, ruled blocking: this runner returned 0 whatever
 * its instruments returned, while «runner rc 0 across 25 instruments» was being
 * cited in the handoff as evidence about the SUBJECT. Both halves were true of
 * the run and false of the subject, and an aggregate that cannot go red is not
 * a verdict.
 *
 * So a measured non-zero now makes this runner exit 5, unless the instrument is
 * named here with the reason its non-zero is not a defect in Phase 15's own
 * code. The list is short, printed with the verdict, and it is NOT a severity
 * floor or an allowlist of findings: each entry names a specific instrument
 * whose exit 1 carries a fact the record states elsewhere, and the instrument
 * still prints everything it found.
 *
 * A consequence worth stating, because it changes how a handoff run is made:
 * the two INDEX instruments are deliberately absent from this list. They are
 * regenerated AFTER a run — an index is stale while its own regeneration is
 * pending — so a pre-regeneration run exits 5 by design, and the run whose rc
 * is quotable is the confirmation run made after the documents are rewritten.
 */
/**
 * EVERY EXCUSE BINDS A SCRIPT, THE CODES IT COVERS, AND THE REASON
 *
 * Round 10's R-9B-d. An entry used to excuse a script for ANY non-zero code
 * under a reason written for particular ones: `verify:gap-list`'s reason
 * explains exit 1 and exit 2, and an exit 7 — the cluster-teardown failure
 * `pg-cluster.ts` now reports — was tolerated by the same row, silently, under
 * a sentence that does not describe it. A reason that does not name the code it
 * excuses is not a reason, so the codes are part of the entry and a code
 * outside the list is UNEXCUSED and reaches this runner's exit 5.
 */
const TOLERATED_NONZERO: readonly { readonly script: string; readonly codes: readonly number[]; readonly reason: string }[] = [
  {
    script: 'verify:gap-list:static',
    codes: [1, 2],
    reason:
      'the static mode measures what it can read and reports the rest as UNMEASURED; its exit 2 says "something here could not be measured at all" and its exit 1 "everything was measured and a gap was found" (round-8 R3), neither of which is a failure of the pack\u2019s own code. Its FINDINGs are carried as named open items (G5 is the owner-decided scanner block)',
  },
  {
    script: 'verify:gap-list',
    codes: [1, 2],
    reason:
      "the same instrument against a live cluster. From round-8 R3 a measured FINDING reaches its exit code, which is the point of that fix: G5 — the production malware-scanner fail-open the owner ruled a promotion blocker on 2026-10-12 — used to be printed over an exit 0. The findings are named open items in §9, and a gap in another phase's code is not a defect in this pack",
  },
  {
    script: 'audit:deps:phase15',
    codes: [1],
    reason:
      "a FAILURE inherited from main's lockfile a8fecd0, with HIGH advisories this branch neither authored nor changes. It blocks PROMOTION and is recorded as §6.3; the floor stays at moderate and nothing is allowlisted",
  },
];

/**
 * THE REPOSITORY'S OWN GATES, RUN AND RECORDED BESIDE THE INSTRUMENTS
 *
 * The coordinator's round-8 addition (c), and the reason for it is the worst
 * finding of the round: `npm run format` — the repository's own gate, run by
 * `ci.yml` — had been RED on committed Phase 15 files since `2c0abec`, and
 * nothing in this record ran it. Three reviews and eight challenge rounds read
 * a pack whose own repo gate was failing, because the record only ever carried
 * THIS phase's instruments. A head that turns a repo gate red carries no
 * signature (`P4 r20`), so the gates belong in the same table as everything
 * else, with the engine printed by the same command that runs them.
 *
 * A gate is TOLERATED only when its red is inherited from `main` and named
 * here with that reason — the same rule as `TOLERATED_NONZERO`, and no wider.
 * Phase-owned lint is deliberately NOT tolerated: `scripts/phase15` and the
 * one shared file this phase edits are this phase's to keep green.
 */
/**
 * TWO NUMBERS, NOT ONE, FOR EVERY BUILD-DEPENDENT GATE
 *
 * The coordinator's rule of 2026-10-13, after P14's single-number table claimed
 * the opposite of the truth: lint, typecheck and build each have a COLD figure
 * (a fresh clone with `npm ci` only) and an AFTER-BUILD figure, and one number
 * without the order is uninterpretable. On `main` the coordinator measured
 * typecheck 2 cold / 0 after build, and lint 1 cold / 0 after build.
 *
 * This runner cannot produce the cold figure, and says so rather than letting
 * its own number stand for both: its `build-inventory` and `build-accounting`
 * preconditions REQUIRE the workspace packages to be built before any
 * instrument runs, so by the time a gate runs here the tree is never cold. So
 * each gate below declares `treeState`, every printed row carries it, and the
 * cold figures live in the handoff's own gate table, measured in a fresh clone
 * at the named SHA. `prettier --check` has no build dependency and keeps one
 * number.
 */
const REPO_GATES: readonly { readonly name: string; readonly command: string; readonly tolerated: string | null; readonly buildDependent: boolean }[] = [
  { name: 'format (prettier --check .)', command: 'npm run format', tolerated: null, buildDependent: false },
  {
    name: 'lint, phase-owned (eslint scripts/phase15 + the one shared file)',
    command: 'npx eslint scripts/phase15 scripts/phase3-secret-scan.ts --max-warnings 0',
    tolerated: null,
    buildDependent: true,
  },
  { name: 'typecheck, root tsconfig (tsc --noEmit)', command: 'npx tsc -p tsconfig.json --noEmit', tolerated: null, buildDependent: true },
  {
    name: 'lint, whole repo (eslint .)',
    command: 'npm run lint',
    tolerated:
      "inherited from main and not this phase's: every error is in apps/ and packages/ and is the cold-tree shape (`a type that cannot be resolved`), which needs the workspace packages built. None is in scripts/phase15 — that is the gate above, and it is not tolerated",
    buildDependent: true,
  },
  {
    name: 'typecheck, workspaces then root (npm run typecheck)',
    command: 'npm run typecheck',
    tolerated:
      'inherited from main and tracked as G6 in the CI-owner queue: the root script builds nothing first, so workspace packages resolve to their sources. The root tsconfig alone is the gate above, and it is not tolerated',
    buildDependent: true,
  },
];

interface GateResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number | null;
  /** Decided where the command ran, not inferred from the record later. */
  readonly ok: boolean;
  readonly engine: string;
  readonly tolerated: string | null;
  /** Which tree this number is about: never a cold one, here. */
  readonly treeState: string;
  readonly tail: string;
}

/**
 * Each gate runs with `node --version` in the SAME command, so the engine in
 * the record is the engine the gate ran on rather than the one this process
 * happens to be using.
 */
function runRepoGates(): readonly GateResult[] {
  const out: GateResult[] = [];
  for (const g of REPO_GATES) {
    // `sh -c`, NOT `sh -lc`: a login shell re-sources the profile and puts the
    // image's own Node back at the front of PATH, so the first run of this
    // table reported every gate as passing on v22.22.0 while the runner itself
    // was on v24.12.0. A gate measured on an engine the record does not name is
    // a gate measured somewhere else.
    const r = spawnSync('sh', ['-c', `node --version && ${g.command}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
    // DECIDED HERE, where the command ran: the exit code is compared in the
    // same function that produced it rather than stored for a later `!== 0`
    // three functions away. The exit-code sweep reported this file for exactly
    // that on its first draft, which is the instrument working.
    const code = r.status;
    const ok = code === 0;
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const engine = /^(v\d+\.\d+\.\d+)/m.exec(text)?.[1] ?? 'UNREADABLE — the command printed no node version';
    out.push({
      name: g.name,
      command: g.command,
      exitCode: code,
      ok,
      engine,
      tolerated: g.tolerated,
      treeState: g.buildDependent
        ? 'in THIS tree, with the workspace packages BUILT (the preconditions require it) — the cold figure is in the handoff gate table, from a fresh clone'
        : 'no build dependency, so one number is the whole fact',
      tail: text.trim().split('\n').slice(-3).join(' | ').slice(0, 300),
    });
  }
  return out;
}

function main(): number {
  const quick = process.argv.includes('--quick');
  const authoritative = process.argv.includes('--authoritative');
  const engine = engineVerdict();
  const src = sourceIdentity();
  mkdirSync(LOG_DIR, { recursive: true });

  console.log('P15 — EVIDENCE RUN LOG (Mission V3 §9: commands, run IDs, EXIT CODES)');
  console.log('='.repeat(78));
  console.log(`source   : ${src.sha}${src.clean ? ' (clean tree)' : ' PLUS UNCOMMITTED CHANGES'}`);
  console.log(`logs     : ${LOG_DIR}`);
  console.log(`selection: ${quick ? 'cluster-free instruments only (--quick)' : 'every instrument'}`);
  console.log(
    `engine   : ${engine.running} against engines.node ${engine.declared ?? 'UNDECLARED'} — ${engine.satisfied ? 'ON THE PINNED ENGINE' : 'OFF THE PINNED ENGINE'}`,
  );
  console.log(`collation: cluster instruments default to ${SETTLED_COLLATION}, the settled deployment line; each proof prints the collation it got`);
  console.log(
    `AUTHORITATIVE: ${engine.satisfied && src.clean ? (authoritative ? 'YES — requested and granted' : 'ELIGIBLE — pass --authoritative to assert it') : 'NO'}`,
  );
  if (!engine.satisfied) {
    console.log('');
    console.log('! THIS RUN IS NOT ON THE PINNED ENGINE. Every figure below is a diagnostic');
    console.log('  measurement on this box\u2019s Node, not evidence on the engine the package declares.');
    console.log('  A handoff run is `npm run verify:evidence-log -- --authoritative`, which REFUSES');
    console.log('  rather than producing a record someone has to read a runtime line to discount.');
  }
  if (authoritative && (!engine.satisfied || !src.clean)) {
    console.log('');
    console.log('REFUSED — nothing was run and nothing is claimed.');
    if (!engine.satisfied) console.log(`  the engine is ${engine.running}, and the package declares ${engine.declared ?? 'no range this runner can read'}.`);
    if (!src.clean) console.log('  the tree is not clean, and an authoritative run is made at an exact SHA.');
    console.log('  Fetch the pinned engine (digest checked against the published SHASUMS256.txt, not');
    console.log('  from a cache), commit, and run this again. A refusal is the only honest output');
    console.log('  here: the alternative is a full record whose one disqualifying fact is on line 8.');
    return 3;
  }
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
    console.log(
      `     utc      : ${r.notRunReason !== null ? 'none — no run, so no window' : `${r.startedUtc} \u2192 ${r.endedUtc}  (${(r.ms / 1000).toFixed(1)}s)`}`,
    );
    console.log(
      `     exit     : ${r.notRunReason !== null ? 'none — this instrument was not run' : r.exitCode === null ? `KILLED by ${String(r.signal)}` : String(r.exitCode)}`,
    );
    console.log(
      `     database : ${r.subject.servers.length === 0 ? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT \u2014 and it starts a cluster, so this is a gap in its record' : 'none \u2014 this instrument reads the tree and starts no cluster') : r.subject.servers.join('; ')}`,
    );
    console.log(`     role     : ${r.subject.principal ?? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT' : 'none \u2014 no SQL is executed')}`);
    console.log(
      `     fixture  : ${r.subject.declaresFixture ? 'the instrument declares its subject a FIXTURE, not a real database' : 'no fixture declared in the output'}`,
    );
    console.log(
      `     counts   : measured ${stated(r.counts.measured)}, unmeasured ${stated(r.counts.unmeasured)}, findings ${stated(r.counts.findings)}, skips ${stated(r.counts.skips)}`,
    );
    console.log(
      `     read from: ${r.counts.readFrom === null ? 'no summary line this runner recognises \u2014 so NO count is reported, rather than one scavenged from the body' : `\u201c${r.counts.readFrom}\u201d`}`,
    );
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
  //   6 = one of the REPOSITORY's own gates is red at this head
  //   5 = an instrument measured and returned a non-zero code that no named
  //       exclusion accounts for (round-8 R2)
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
  const emit = process.argv.find((a) => a.startsWith('--emit-section='));
  if (emit !== undefined) {
    const path = emit.slice('--emit-section='.length);
    if (path.trim().length === 0) {
      console.log('  ! --emit-section was given with no path, so nothing was written. Name the file.');
    } else {
      emitSection(path, results, src, runtimeIdentity(), coverage, preconditionState);
    }
  }

  // ── the repository's own gates, beside the instruments ────────────────
  const gates = runRepoGates();
  console.log("THE REPOSITORY'S OWN GATES at this head, with the engine each one ran on");
  for (const g of gates)
    console.log(
      `  exit ${String(g.exitCode)}  ${g.engine}  ${g.name}${g.ok ? '' : g.tolerated === null ? '  — NOT TOLERATED' : '  — tolerated: inherited from main'}\n            ${g.treeState}`,
    );
  // A gate that ran on a different engine from this run is not this run's gate,
  // whatever it returned — so an engine mismatch is red and cannot be tolerated.
  const engineMismatch = gates.filter((g) => g.engine !== runtimeIdentity().node);
  for (const g of engineMismatch)
    console.log(`  ! ${g.name} ran on ${g.engine} while this run is on ${runtimeIdentity().node} — the gate was measured on another engine`);
  const gatesRed = gates.filter((g) => (!g.ok && g.tolerated === null) || engineMismatch.includes(g));
  const gatesInherited = gates.filter((g) => !g.ok && g.tolerated !== null);
  for (const g of gatesInherited) console.log(`  ${g.name} — ${g.tolerated ?? ''}`);
  console.log('');

  // R2 — a measured non-zero that nothing in this list accounts for.
  // The excuse is looked up by (script, code), never by script alone: see
  // R-9B-d above the list.
  const excuseFor = (script: string, code: number | null): string | null => {
    if (code === null) return null;
    const row = TOLERATED_NONZERO.find((t) => t.script === script && t.codes.includes(code));
    return row === undefined ? null : row.reason;
  };
  const redInstruments = results.filter((r) => r.ran && r.exitCode !== 0 && r.exitCode !== null);
  const excused = redInstruments.filter((r) => excuseFor(r.instrument.script, r.exitCode) !== null);
  const unexcused = redInstruments.filter((r) => excuseFor(r.instrument.script, r.exitCode) === null);
  // A RUN THAT DID NOT MEASURE IS NEITHER A RED NOR A GREEN (round 20, F-R20-05).
  //
  // `test:phase15:load-harness` exited 1 in the ed26e00 confirmation run because
  // port 55432 was still held by the previous instrument's postmaster. The
  // classifier now reads that from the server's own log, and this is what the
  // runner's exit code does with it: such a run is reported SEPARATELY, under a
  // code of its own, because calling it «measured and returned a non-zero exit
  // code» (EXIT 5) says the instrument weighed its subject, and it never started.
  // It is NOT excused into silence either: the code stays non-zero, so a
  // confirmation run with contention in it can never be quoted as rc 0. The
  // instrument must be re-run alone and the result stated for that run.
  const didNotMeasure = unexcused.filter((r) => /^DID NOT MEASURE/.test(outcomeClass(r)));
  const measuredRed = unexcused.filter((r) => !/^DID NOT MEASURE/.test(outcomeClass(r)));
  if (excused.length > 0) {
    console.log(`${excused.length} instrument(s) returned a non-zero code this runner TOLERATES, each named in its source with a reason for THAT code:`);
    for (const r of excused) console.log(`  ${r.instrument.script} exit ${String(r.exitCode)} — ${excuseFor(r.instrument.script, r.exitCode) ?? ''}`);
    console.log('');
  }
  if (gatesRed.length > 0) {
    console.log(`EXIT 6: ${gatesRed.length} of the repository's own gates are RED at this head:`);
    for (const g of gatesRed) console.log(`  ${g.command} exit ${String(g.exitCode)} on ${g.engine} — ${g.tail}`);
    console.log('  A head that turns a repo gate red carries no signature, and a record that does not run');
    console.log('  the gate cannot notice: `npm run format` was red on committed files for six rounds.');
    return 6;
  }
  if (measuredRed.length > 0) {
    console.log(`EXIT 5: ${measuredRed.length} instrument(s) measured and returned a non-zero exit code that nothing here accounts for:`);
    for (const r of measuredRed) {
      const sameScript = TOLERATED_NONZERO.find((t) => t.script === r.instrument.script);
      console.log(
        `  ${r.instrument.script} exit ${String(r.exitCode)} — ${outcomeClass(r)}${
          sameScript === undefined ? '' : ` (this script is excused for exit ${sameScript.codes.join(' and ')} only, and this code is not one of them)`
        }`,
      );
    }
    console.log("  This runner's own code is now a verdict about its instruments, not only about whether they ran");
    console.log('  (coordinator round-8 R2). An index instrument red BEFORE its regeneration is the expected');
    console.log('  case: regenerate the documents, then make the confirmation run whose rc can be quoted.');
    return 5;
  }

  if (didNotMeasure.length > 0) {
    console.log(`EXIT 8: ${didNotMeasure.length} instrument(s) DID NOT MEASURE — a resource they needed was held, so neither a red nor a green:`);
    for (const r of didNotMeasure) console.log(`  ${r.instrument.script} exit ${String(r.exitCode)} — ${outcomeClass(r)}`);
    console.log('  Re-run each one ALONE and state the result for THAT run. This code is deliberately');
    console.log('  non-zero: a confirmation run carrying contention is not a run whose rc can be quoted.');
    return 8;
  }

  if (!engine.satisfied) {
    console.log(`AUTHORITATIVE: NO — ${engine.running} against engines.node ${engine.declared ?? 'UNDECLARED'}.`);
    console.log('  The instruments ran and returned their own codes; this run is not the handoff run.');
    console.log('');
  }
  console.log('EVERY INSTRUMENT RAN AND RETURNED ITS OWN EXIT CODE, OR WAS NOT RUN FOR A');
  console.log('CALLER-SUPPLIED PRECONDITION IT CORRECTLY REFUSED TO INVENT.');
  console.log('  This runner asserts nothing beyond that. The exit codes above are the evidence');
  console.log('  V3 §9 asks a handoff to carry; what each one means is the reader’s to weigh.');
  return 0;
}

process.exitCode = main();
