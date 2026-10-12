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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const LOG_DIR = process.env.P15_EVIDENCE_LOG_DIR ?? '/tmp/daftar-p15-evidence';

interface Instrument {
  readonly script: string;
  readonly what: string;
  /** true when the instrument starts a real PostgreSQL cluster (minutes, not seconds). */
  readonly cluster: boolean;
  /** what a non-zero exit means FOR THIS INSTRUMENT — recorded, never assumed. */
  readonly nonZeroMeans: string;
}

const INSTRUMENTS: readonly Instrument[] = [
  {
    script: 'verify:gap-list:static',
    what: 'the four historical gap items that need no cluster',
    cluster: false,
    nonZeroMeans: 'at least one item is UNMEASURED — not that an item failed',
  },
  {
    script: 'verify:alert-signals',
    what: 'every alert rule against the signals the tree emits, plus the §22.2 table',
    cluster: false,
    nonZeroMeans: 'a rule claim and the tree disagree',
  },
  {
    script: 'verify:handoff-manifest',
    what: "this pack's digests, both directions",
    cluster: false,
    nonZeroMeans: 'a digest is stale or an artifact is unlisted',
  },
  {
    script: 'verify:gap-list',
    what: 'all five historical gap items; G4 starts its own cluster',
    cluster: true,
    nonZeroMeans: 'at least one item is UNMEASURED',
  },
  {
    script: 'verify:pg-matrix',
    what: 'the three measured contexts and the candidate train',
    cluster: true,
    nonZeroMeans: '1 = a probe was not measured; 2 = a divergence the tree does not account for',
  },
  {
    script: 'verify:role-convergence',
    what: '§10.0 on the candidate blobs',
    cluster: true,
    nonZeroMeans: 'a case could not be measured, which is not a clean bill',
  },
];

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
interface Counts {
  readonly measured: number | null;
  readonly unmeasured: number | null;
  readonly findings: number | null;
  readonly skips: number | null;
  readonly dirtyTreeDeclared: boolean;
  /** the exact line the numbers were read from, so they can be checked. */
  readonly readFrom: string | null;
}

/**
 * The summary shapes the instruments in this pack actually print. Each is
 * start-anchored so an item id (`G4`, `V1`) can never be read as a count.
 */
const SUMMARY_LINE = /^(?:measured\s+\d+\s+of\s+\d+:|\d+\s+probes?:|\d+\s+(?:case|check|rule|item)s?:)/i;

function scrape(out: string): Counts {
  const full = out;
  const line = out.split('\n').map((l) => l.trim()).find((l) => SUMMARY_LINE.test(l));

  if (line === undefined) {
    return { measured: null, unmeasured: null, findings: null, skips: null, dirtyTreeDeclared: /PLUS UNCOMMITTED CHANGES|THE TREE IS NOT CLEAN/.test(full), readFrom: null };
  }

  const num = (re: RegExp): number | null => {
    const m = re.exec(line);
    return m?.[1] === undefined ? null : Number(m[1]);
  };
  return {
    // `measured N of M` and `N probes: N MEASURED` are the two shapes in use.
    measured: num(/^measured\s+(\d+)\s+of\s+\d+/i) ?? num(/(\d+)\s+MEASURED/),
    unmeasured: num(/(\d+)\s+UNMEASURED/),
    findings: num(/(\d+)\s+FINDING/),
    // A skip is the one count whose ABSENCE is the good news, so it is scraped
    // from an explicit statement only. PART 12: a PASS that contains mandatory
    // skips is not a PASS, and silence about skips is not a statement of none.
    skips: num(/(\d+)\s+skip/i),
    dirtyTreeDeclared: /PLUS UNCOMMITTED CHANGES|THE TREE IS NOT CLEAN/.test(full),
    readFrom: line,
  };
}

/**
 * PART 19 also requires the DATABASE VERSION AND COLLATION, the EXECUTION ROLE
 * and the FIXTURE IDENTITY of each proof. Those are facts about what the
 * instrument did, so they are read from what the instrument SAID, never
 * declared here on its behalf: this runner does not know another script's
 * subject, and a runner that invents one is manufacturing the provenance the
 * record exists to carry.
 *
 * Where an instrument states nothing, the field prints
 * `NOT STATED BY THE INSTRUMENT` rather than blank. That is the honest reading
 * and it is also useful: a cluster instrument that never names its server or
 * its principal has a gap in its own record, and the gap should be visible in
 * the handoff instead of being quietly filled in by the runner.
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
  const re = /((?:\d+\.\d+[^,\n]*?))(?:\s*\(server_version_num\s*(\d+)\))?,\s*collate\s+([A-Za-z0-9_.\-]+)/g;
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
  const r = spawnSync('npm', ['run', '-s', inst.script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

  const chosen = INSTRUMENTS.filter((i) => !quick || !i.cluster);
  const results: Result[] = [];
  for (const [i, inst] of chosen.entries()) {
    console.log(`→ npm run ${inst.script}  (${inst.cluster ? 'starts a cluster' : 'no cluster'})`);
    const res = run(inst, src, i);
    console.log(
      `  exit ${res.exitCode === null ? `KILLED (${String(res.signal)})` : String(res.exitCode)}  ${(res.ms / 1000).toFixed(1)}s  log ${res.logBytes} bytes`,
    );
    results.push(res);
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log('COMMAND                          EXIT   DURATION   RUN ID');
  for (const r of results) {
    const exit = r.exitCode === null ? `KILL` : String(r.exitCode);
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
    console.log(`     utc      : ${r.startedUtc} \u2192 ${r.endedUtc}  (${(r.ms / 1000).toFixed(1)}s)`);
    console.log(`     exit     : ${r.exitCode === null ? `KILLED by ${String(r.signal)}` : String(r.exitCode)}`);
    console.log(`     database : ${r.subject.servers.length === 0 ? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT \u2014 and it starts a cluster, so this is a gap in its record' : 'none \u2014 this instrument reads the tree and starts no cluster') : r.subject.servers.join('; ')}`);
    console.log(`     role     : ${r.subject.principal ?? (r.instrument.cluster ? 'NOT STATED BY THE INSTRUMENT' : 'none \u2014 no SQL is executed')}`);
    console.log(`     fixture  : ${r.subject.declaresFixture ? 'the instrument declares its subject a FIXTURE, not a real database' : 'no fixture declared in the output'}`);
    console.log(`     counts   : measured ${stated(r.counts.measured)}, unmeasured ${stated(r.counts.unmeasured)}, findings ${stated(r.counts.findings)}, skips ${stated(r.counts.skips)}`);
    console.log(`     read from: ${r.counts.readFrom === null ? 'no summary line this runner recognises \u2014 so NO count is reported, rather than one scavenged from the body' : `\u201c${r.counts.readFrom}\u201d`}`);
    console.log(`     log      : ${r.logPath}`);
    console.log(`                sha256 ${r.logSha}  (${r.logBytes} bytes)`);
    console.log(`     validity : ${validity(r, src)}`);
  }
  console.log('');

  const notRun = results.filter((r) => !r.ran);
  if (notRun.length > 0) {
    console.log(`EXIT 1: ${notRun.length} instrument(s) did not return an exit code of their own:`);
    for (const r of notRun) console.log(`  ${r.instrument.script} — ${r.signal === null ? 'failed to spawn' : `killed by ${r.signal}`}`);
    console.log('  A killed run is NOT a result, whatever its log says before the kill.');
    return 1;
  }
  console.log('EVERY INSTRUMENT RAN AND RETURNED ITS OWN EXIT CODE.');
  console.log('  This runner asserts nothing beyond that. The exit codes above are the evidence');
  console.log('  V3 §9 asks a handoff to carry; what each one means is the reader’s to weigh.');
  return 0;
}

process.exitCode = main();
