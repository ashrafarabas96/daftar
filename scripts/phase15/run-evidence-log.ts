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

function sourceIdentity(): { sha: string; clean: boolean; runNonce: string } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return {
    sha: head.status === 0 ? head.stdout.trim() : 'UNKNOWN',
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
  readonly logPath: string;
  readonly logSha: string;
  readonly logBytes: number;
  readonly ran: boolean;
}

function run(inst: Instrument, src: ReturnType<typeof sourceIdentity>, i: number): Result {
  const runId = `${src.sha.slice(0, 12)}${src.clean ? '' : '+dirty'}-${src.runNonce}-${String(i).padStart(2, '0')}`;
  const logPath = join(LOG_DIR, `${inst.script.replace(/[:]/g, '_')}.${runId}.log`);
  const started = Date.now();
  const r = spawnSync('npm', ['run', '-s', inst.script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - started;
  // The log is the stdout and stderr as the process produced them, plus a header
  // naming what produced it. A log that cannot say what it is is not evidence.
  const body =
    `# P15 EVIDENCE LOG\n# command : npm run ${inst.script}\n# run id  : ${runId}\n` +
    `# source  : ${src.sha}${src.clean ? ' (clean tree)' : ' PLUS UNCOMMITTED CHANGES'}\n` +
    `# exit    : ${r.status === null ? `KILLED by signal ${String(r.signal)}` : String(r.status)}\n` +
    `# ms      : ${ms}\n# ---\n${r.stdout ?? ''}${(r.stderr ?? '').length > 0 ? `\n# --- stderr ---\n${r.stderr}` : ''}`;
  writeFileSync(logPath, body);
  return {
    instrument: inst,
    runId,
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
  console.log('LOGS, WITH THEIR OWN DIGESTS');
  for (const r of results) {
    console.log(`  ${r.logPath}`);
    console.log(`      sha256 ${r.logSha}  (${r.logBytes} bytes)`);
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
