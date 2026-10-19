#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 15 — POINT-IN-TIME RECOVERY PROOF  (PART 104)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS, AND WHAT THE DR DRILL COULD NOT DO
 *
 * `backup-restore-proof.ts` proves a logical backup and restore: `pg_dump`
 * out, `pg_restore` in, catalogue and data equivalence, 8 red proofs. That is
 * a real proof of a real capability, and it is NOT point-in-time recovery.
 * The directive says so in one line — "A pg_dump restore fixture is NOT PITR"
 * — and the reason is structural, not a matter of degree: a logical dump is a
 * snapshot of rows at one instant with no LSN to replay onto, so there is no
 * operation it can perform that means "bring the database to 14:32:06".
 * Recovering to a chosen moment needs a PHYSICAL base backup plus the
 * archived write-ahead log replayed on top of it, stopped at a target.
 *
 * `docs/DAFTAR_BACKUP_AND_DR.md` commits the project to continuous WAL
 * archiving and `RPO <= 15 min`. Finding `F-DR-01` recorded that no WAL
 * configuration existed anywhere in the repository, so that commitment had no
 * implementation and PITR was reported `UNMEASURED` — not because measuring
 * was hard, but because there was nothing to measure. This script is the
 * implementation and the measurement.
 *
 * ── THE SHAPE OF THE PROOF ───────────────────────────────────────────────
 *
 * The decisive property is the CUT: transactions committed before the target
 * survive, transactions committed after it do not, and both halves must be
 * shown or the result is vacuous. Three ways this proof could lie to itself,
 * and what answers each:
 *
 *   "A survived"      could mean the base backup already contained A, with no
 *                     WAL replayed at all. Answered by taking the base backup
 *                     BEFORE A is posted, and by red proof R-P1, which
 *                     recovers the same backup to a target before A and finds
 *                     A absent. A is therefore in the WAL and nowhere else.
 *
 *   "B is absent"     could mean B was never committed, or that recovery
 *                     silently stopped early. Answered by red proof R-P4,
 *                     which recovers the same archive to a target after B and
 *                     finds B present. The cut is a cut, not a ceiling.
 *
 *   "archiving works" could mean `archive_command` was never actually called.
 *                     Answered by reading `pg_stat_archiver` for a non-zero
 *                     `archived_count` and a named `last_archived_wal`, by
 *                     counting the segments on the archive's own disk, and by
 *                     R-P2, which breaks the command and requires the monitor
 *                     to refuse.
 *
 * Every verdict below names its subject and its count, and a verdict whose
 * subject set is empty is `UNMEASURED`, never `PASS`.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * PREPARED / NOT PROMOTED. This is a harness and an internal configuration,
 * not final release evidence (PART 101): its timings are container-scale on a
 * seeded fixture and are NOT the production RPO/RTO (PART 105), and its SHA is
 * a preparation SHA, so by PART 16 it proves nothing about the final one.
 *
 * It deliberately hard-codes NO vendor. The directive forbids hard-coding a
 * provider the deployment does not use, so `archive_command` here is plain
 * `cp` into a local directory — the mechanism every PostgreSQL has — and the
 * production mechanism (managed PITR, pgBackRest, WAL-G) stays an owner
 * decision this script is shaped to accept rather than pre-empt. Encrypted
 * durable off-host storage and its credentials remain an activation
 * dependency; what is proved here is that the recovery path itself works.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/phase15/pitr-proof.ts                   # the drill
 *   npx tsx scripts/phase15/pitr-proof.ts --prove-detection # plus red proofs
 *   npx tsx scripts/phase15/pitr-proof.ts --keep            # leave it running
 *
 * Exit 0 only when every validator PASSed with a non-empty subject and, under
 * `--prove-detection`, every red proof turned red.
 */

import { protectFailingExitCode } from '../../tests/helpers/exit-code';

protectFailingExitCode();

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../../apps/api/src/infra/migrate';
import { APP_PASSWORD, APP_ROLE, DR_ASSERTION_KID, installAssertionKey, seedOneTenant, todayInBusinessTimezone } from './dr-fixture';
import {
  armRecovery,
  baseBackup,
  dbUrl,
  PG16_BIN,
  PG_SUPERPASS,
  PG_SUPERUSER,
  prepareClusterDir,
  prepareServerWritableDir,
  psqlScalar,
  roleUrl,
  serverLog,
  clusterIdentity,
  startCluster,
  startExisting,
  stopCluster,
  toolVersions,
  type ClusterSpec,
} from './pg-cluster';

const ARGV = process.argv.slice(2);
const PROVE = ARGV.includes('--prove-detection');
const KEEP = ARGV.includes('--keep');
const DB = 'daftar';

const ROOT = join(__dirname, '..', '..');
const BASE = '/tmp/daftar-p15-pitr';
const PRIMARY: ClusterSpec = { dir: `${BASE}-primary`, port: 55473, label: 'pitr-primary' };
const RECOVERED: ClusterSpec = { dir: `${BASE}-recovered`, port: 55474, label: 'pitr-recovered' };
const ARCHIVE = `${BASE}-archive`;
const BASEBACKUP = `${BASE}-basebackup`;
const EVIDENCE = `${BASE}-evidence`;

/**
 * The archive and restore commands.
 *
 * `test ! -f` first, so re-archiving an existing segment FAILS rather than
 * silently overwriting it — an archive that accepts a second, different copy
 * of a segment under the same name is an archive that can corrupt a recovery.
 */
const archiveCommand = (dir: string): string => `test ! -f ${dir}/%f && cp %p ${dir}/%f`;
const restoreCommand = (dir: string): string => `cp ${dir}/%f %p`;

/** Settings that turn a plain cluster into one that can be recovered to a point. */
function pitrSettings(archiveDir: string): readonly string[] {
  return [
    "wal_level='replica'",
    "archive_mode='on'",
    `archive_command='${archiveCommand(archiveDir)}'`,
    // A busy production system fills segments on its own; a fixture does not,
    // so without a timeout the last partial segment is never archived and the
    // recovery target sits beyond the end of the archive.
    "archive_timeout='30s'",
    "max_wal_senders='4'",
    "wal_keep_size='64MB'",
    // startCluster sets fsync=off for speed. A recovery claim on a cluster
    // that was never durable proves nothing, so this appends LAST and wins.
    "fsync='on'",
    "synchronous_commit='on'",
    "full_page_writes='on'",
  ];
}

// ── verdicts ──────────────────────────────────────────────────────────────

/**
 * `PARTIAL` exists because of the challenger's F-05.
 *
 * `P9` reported `PASS subjects=5` while 2 of its 5 domains had actually been
 * measured — the detail line said so exactly, and refused to let an empty table
 * count as a proof, but the verdict and the subject count were the headline a
 * reader carries away and they were broader than the thing measured. `P8` had
 * the same shape: "the ENTIRE per-table state", 110 subjects, 34 of them
 * non-empty. Overclaiming in the label is the defect this pack names in other
 * people's work; a verdict vocabulary with no word for "some of it" invites it.
 *
 * PARTIAL is not a pass. It counts as neither a PASS nor a FAIL in the summary,
 * and the subject count it carries is the MEASURED one.
 */
type Verdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'UNMEASURED';
interface ValidatorResult {
  readonly id: string;
  readonly law: string;
  verdict: Verdict;
  subjects: number;
  detail: string;
}
const results: ValidatorResult[] = [];
function record(id: string, law: string): ValidatorResult {
  const r: ValidatorResult = { id, law, verdict: 'UNMEASURED', subjects: 0, detail: 'not reached' };
  results.push(r);
  return r;
}
function pass(r: ValidatorResult, subjects: number, detail: string): void {
  if (subjects <= 0) {
    r.verdict = 'UNMEASURED';
    r.subjects = 0;
    r.detail = `${detail} — but the subject set was EMPTY, so this is UNMEASURED, not a pass`;
    return;
  }
  r.verdict = 'PASS';
  r.subjects = subjects;
  r.detail = detail;
}
/**
 * Measured fewer subjects than the law claims. `measured` is what goes in
 * `subjects`, so no reader can take the broader number for the narrower fact.
 */
function partial(r: ValidatorResult, measured: number, total: number, detail: string): void {
  if (measured <= 0) {
    r.verdict = 'UNMEASURED';
    r.subjects = 0;
    r.detail = `${detail} — and NOTHING was measured, so this is UNMEASURED`;
    return;
  }
  r.verdict = 'PARTIAL';
  r.subjects = measured;
  r.detail = `${measured} of ${total} measured — ${detail}`;
}
function fail(r: ValidatorResult, subjects: number, detail: string): void {
  r.verdict = 'FAIL';
  r.subjects = subjects;
  r.detail = detail;
}

/**
 * The drill could not be performed, as distinct from performing it and finding
 * the property broken. Measured 2026-10-13: three consecutive runs printed
 * `P2 FAIL — the base backup plus archived WAL recovers to a consistent,
 * read-write cluster` because a fixed port was busy and the recovery was never
 * attempted. «Disaster recovery is broken» and «I could not run the drill» must
 * never print the same way (PART 18), and the first of the two is a false
 * measured claim.
 */
let contentionDetail: string | null = null;
function contention(r: ValidatorResult, detail: string): void {
  r.verdict = 'UNMEASURED';
  r.subjects = 0;
  r.detail = detail;
  contentionDetail = contentionDetail ?? detail;
}

// ── helpers ───────────────────────────────────────────────────────────────

function sh(script: string): { readonly ok: boolean; readonly out: string } {
  const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `now()` as the SERVER sees it. The recovery target is compared against
 * commit timestamps by PostgreSQL, so a target read from this process's clock
 * could sit on the wrong side of a commit — PART 123 forbids a device clock as
 * an authority, and the same reasoning applies to a test harness's clock.
 */
async function nowOnServer(pool: Pool): Promise<string> {
  const row = (await pool.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0];
  if (row === undefined) throw new Error('the server returned no row for now(); a recovery target must come from the server clock, never this process clock');
  return row.t;
}

/** Archived segment files, excluding the `.history` and in-progress entries. */
function archivedSegments(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[0-9A-F]{24}$/.test(f));
}

/**
 * Force the current WAL segment out to the archive and wait until the archiver
 * says it got there — never a bare sleep, which proves nothing about whether
 * the segment arrived (PART 18).
 */
async function flushWalToArchive(pool: Pool, what: string): Promise<{ readonly lastArchived: string; readonly archivedCount: number }> {
  await pool.query('CHECKPOINT');
  const before = Number((await pool.query<{ n: string }>(`SELECT archived_count::text AS n FROM pg_stat_archiver`)).rows[0]?.n ?? '0');
  await pool.query(`SELECT pg_switch_wal()`);
  for (let i = 0; i < 120; i++) {
    const row = (
      await pool.query<{ n: string; last: string | null; failed: string }>(
        `SELECT archived_count::text AS n, last_archived_wal AS last, failed_count::text AS failed FROM pg_stat_archiver`,
      )
    ).rows[0];
    const count = Number(row?.n ?? '0');
    if (count > before && row?.last) return { lastArchived: row.last, archivedCount: count };
    if (Number(row?.failed ?? '0') > 0) {
      throw new Error(`archiver reported ${row?.failed} failure(s) while waiting for ${what}; server log:\n${serverLog(PRIMARY.dir).slice(-2000)}`);
    }
    await sleep(250);
  }
  throw new Error(`WAL segment for ${what} was not archived within 30s; archiver made no progress past ${before}`);
}

/** Wait until a recovering cluster has finished recovery and is read-write. */
function waitForRecovery(port: number, timeoutMs: number): { readonly ok: boolean; readonly detail: string } {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const r = psqlScalar(port, 'postgres', 'SELECT pg_is_in_recovery()');
    last = r.detail;
    if (r.ok && r.value === 'f') return { ok: true, detail: 'pg_is_in_recovery() = false' };
    // The sleep's own exit code matters: if it cannot run, this becomes a busy
    // loop that burns the deadline it is measuring against, and the RTO figure
    // printed afterwards would be about a machine under load from this poll
    // rather than about recovery. Swept in with the pack's other discarded
    // exit codes.
    const sleeper = spawnSync('/bin/bash', ['-c', 'sleep 0.3']);
    if (sleeper.error !== undefined || sleeper.status !== 0)
      return {
        ok: false,
        detail: `the recovery poll could not pace itself (sleep exited ${String(sleeper.status)}), so no recovery timing measured here is valid`,
      };
  }
  return { ok: false, detail: `still in recovery (or unreachable) after ${timeoutMs}ms: ${last}` };
}

/**
 * The five domains the Master Continuous Mission requires a PITR restore to be
 * checked across — journal, AR, stock, tenants and files — mapped to the tables
 * that carry them ON THIS BRANCH.
 *
 * `main` predates Phase 4's sales and receivables, so `customers` and
 * `invoices` do not exist here: the AR domain has no table to check and is
 * `WAITING_FOR_INTEGRATED_SURFACE`, not `PASS` and not `FAIL`. Saying so is the
 * point — a domain silently omitted from a breadth check reads as a domain that
 * passed it.
 */
const DOMAINS: readonly { readonly domain: string; readonly tables: readonly string[] }[] = [
  { domain: 'journal', tables: ['journal_entries', 'journal_lines'] },
  { domain: 'tenants', tables: ['tenants', 'businesses', 'branches', 'warehouses', 'users'] },
  { domain: 'stock', tables: ['stock_levels', 'stock_movements'] },
  { domain: 'files', tables: ['media', 'product_media'] },
  // AR: intentionally empty on this branch. See the comment above.
  { domain: 'receivables (AR)', tables: [] },
];

interface EntryProbe {
  readonly present: boolean;
  readonly entries: number;
  readonly unbalanced: number;
}

/**
 * Per-table `count:md5` for every ordinary table in `public`, read over psql.
 *
 * `psqlScalar` rather than a pool, because this has to run against the
 * RECOVERED cluster, which comes up after the primary and its pool are gone.
 * Same digest shape the DR drill uses: the count makes an empty table
 * distinguishable from a matching one, which matters because two empty tables
 * agree on everything.
 */
function tableDigests(port: number): Readonly<Record<string, string>> {
  const list = psqlScalar(
    port,
    DB,
    `SELECT string_agg(c.relname, ',' ORDER BY c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  if (!list.ok) throw new Error(`could not list tables on :${port}: ${list.detail}`);
  const names = list.value.split(',').filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
  if (names.length === 0) throw new Error(`no ordinary tables found on :${port}; a breadth comparison over an empty table set would prove nothing`);
  const out: Record<string, string> = {};
  for (const t of names) {
    const r = psqlScalar(
      port,
      DB,
      `SELECT count(*)::text || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, chr(10) ORDER BY to_jsonb(x)::text), '')) FROM public.${t} x`,
    );
    if (!r.ok) throw new Error(`digest of ${t} on :${port} failed: ${r.detail}`);
    out[t] = r.value;
  }
  return out;
}

const digestRows = (d: string): number => Number(d.slice(0, d.indexOf(':')));

/** Is a given entry id present on the recovered cluster, and are its journals balanced? */
function probeEntry(port: number, entryId: string): EntryProbe {
  const present = psqlScalar(port, DB, `SELECT count(*)::text FROM journal_entries WHERE id = '${entryId}'`);
  const entries = psqlScalar(port, DB, `SELECT count(*)::text FROM journal_entries`);
  const unbalanced = psqlScalar(
    port,
    DB,
    `SELECT count(*)::text FROM (
       SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id
       HAVING COALESCE(sum(debit_minor),0) <> COALESCE(sum(credit_minor),0)
     ) x`,
  );
  // Name WHICH probe failed. An earlier version reported the first truthy
  // `detail`, which on a successful count is the count itself — so a real
  // failure downstream was reported as the string "1" and said nothing.
  const broken = (
    [
      ['entry-present', present],
      ['entry-count', entries],
      ['unbalanced-count', unbalanced],
    ] as const
  ).filter(([, r]) => !r.ok);
  if (broken.length > 0) {
    throw new Error(`probe failed on :${port}: ${broken.map(([name, r]) => `${name}: ${r.detail}`).join(' ;; ')}`);
  }
  return { present: Number(present.value) > 0, entries: Number(entries.value), unbalanced: Number(unbalanced.value) };
}

/**
 * Is something listening on this port? Read from /proc, not from a connect
 * attempt: a refused connection and a filtered one look the same, and this
 * question decides whether a verdict is a measurement at all.
 */
function portBusy(port: number): boolean {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // not readable here: fall through to the bind attempt itself
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const state = cols[3];
      if (local === undefined || state !== '0A') continue;
      const hex = local.split(':')[1];
      if (hex !== undefined && parseInt(hex, 16) === port) return true;
    }
  }
  return false;
}

/** Lay the base backup down, recover it to a target, and probe. Returns the probes. */
function recoverTo(
  target: { readonly time?: string; readonly lsn?: string },
  label: string,
): { readonly ok: boolean; readonly detail: string; readonly port: number; readonly contention: boolean } {
  stopCluster(RECOVERED);
  rmSync(RECOVERED.dir, { recursive: true, force: true });
  mkdirSync(RECOVERED.dir, { recursive: true });
  sh(`chmod 755 ${RECOVERED.dir}; chown postgres:postgres ${RECOVERED.dir}`);
  armRecovery(join(RECOVERED.dir, 'data'), BASEBACKUP, {
    restoreCommand: restoreCommand(ARCHIVE),
    targetTime: target.time,
    targetLsn: target.lsn,
  });
  // The copied backup carries the primary's port; the recovered cluster needs
  // its own, or it would collide with the primary still holding 55473.
  sh(`printf "\\nport=${RECOVERED.port}\\n" >> ${join(RECOVERED.dir, 'data', 'postgresql.auto.conf')}`);
  // WAIT FOR THE PORT, AND TELL CONTENTION FROM A BROKEN RECOVERY.
  //
  // Measured 2026-10-13: three consecutive runs of this drill reported
  // `P2 FAIL — the base backup plus archived WAL recovers to a consistent,
  // read-write cluster`, and the cause in every one was a single line inside the
  // server log: `could not bind IPv4 address "127.0.0.1": Address already in
  // use` on this cluster's FIXED port. The recovery was never attempted. A
  // verdict that says disaster recovery is broken when the truth is that a port
  // was busy is a false measured claim, which is the one thing this pack treats
  // as blocking — so the port is waited for, and a bind failure is reported as
  // CONTENTION and not as a failed validator.
  const freeBy = Date.now() + 30_000;
  let busy = portBusy(RECOVERED.port);
  while (busy && Date.now() < freeBy) {
    sh('sleep 1');
    busy = portBusy(RECOVERED.port);
  }
  if (busy)
    return {
      ok: false,
      contention: true,
      detail: `port ${RECOVERED.port} was still held 30s after this drill asked for it, so the recovery was never attempted: INVALID MEASUREMENT — RESOURCE CONTENTION, not a recovery failure`,
      port: RECOVERED.port,
    };
  const started = startExisting(RECOVERED.dir, label);
  if (started.status !== 0) {
    const log = serverLog(RECOVERED.dir);
    const bind = /could not bind IPv4 address|could not create any TCP\/IP sockets|Address already in use/.test(log);
    return {
      ok: false,
      contention: bind,
      detail: bind
        ? `INVALID MEASUREMENT — RESOURCE CONTENTION: the recovered cluster could not take port ${RECOVERED.port} (${(/could not bind[^\n]*/.exec(log) ?? ['bind failed'])[0]}), so no recovery was attempted and nothing here is a statement about recoverability`
        : `pg_ctl start (${label}) exit ${started.status}: ${log.slice(-2000)}`,
      port: RECOVERED.port,
    };
  }
  const done = waitForRecovery(RECOVERED.port, 120_000);
  return { ok: done.ok, contention: false, detail: done.detail, port: RECOVERED.port };
}

// ── the drill ─────────────────────────────────────────────────────────────

interface Timeline {
  readonly entryDate: string;
  readonly tenantA: { readonly entryId: string; readonly slug: string };
  readonly tenantB: { readonly entryId: string; readonly slug: string };
  readonly targetTime: string;
  readonly afterBTime: string;
  readonly afterBLsn: string;
  readonly beforeATime: string;
  readonly baseBackupMs: number;
  readonly archivedAtTarget: number;
}

async function main(): Promise<void> {
  console.log('P15 PITR PROOF — PART 104 · PREPARED / NOT PROMOTED');
  console.log('  a physical base backup plus archived WAL, recovered to a chosen point.');
  console.log('  NOT a logical dump restore, and NOT production RPO/RTO.\n');

  const sha = sh('git rev-parse HEAD').out.trim();
  const dirty = sh('git status --porcelain').out.trim() !== '';
  console.log(`  sha ${sha}${dirty ? ' (DIRTY — this run proves nothing about any commit)' : ''}`);

  const vArchiving = record('P1', 'WAL archiving is actually running: a non-zero archived_count, a named last_archived_wal, and segments on the archive disk');
  const vRecovers = record('P2', 'The base backup plus archived WAL recovers to a consistent, read-write cluster');
  const vCutBefore = record('P3', 'A transaction committed BEFORE the recovery target survives the recovery');
  const vCutAfter = record('P4', 'A transaction committed AFTER the recovery target is ABSENT from the recovery');
  const vBalanced = record('P5', 'Every journal entry on the recovered cluster is balanced');
  const vMonitor = record('P6', 'The archive-failure monitor reads pg_stat_archiver and reports a healthy archive');
  record('P7', 'The retention command removes only segments older than the base backup it is given');
  const vBreadth = record(
    'P8',
    'Every table in public matches the state captured at the target by whole-row digest — including the empty ones, which prove only that they were empty',
  );
  const vDomains = record(
    'P9',
    'Every named domain — journal, AR, stock, tenants, files — is accounted for after the restore, each as measured or explicitly not measurable here',
  );

  let primaryUp = false;
  let pool: Pool | undefined;
  const started = Date.now();
  let timeline: Timeline | undefined;

  try {
    // ── 1. a primary with archiving on, from the project's own two sources ──
    prepareClusterDir(PRIMARY.dir);
    prepareServerWritableDir(ARCHIVE);
    prepareServerWritableDir(EVIDENCE);
    startCluster(PRIMARY, pitrSettings(ARCHIVE));
    primaryUp = true;
    console.log(`  primary   :${PRIMARY.port}, archiving to ${ARCHIVE}`);

    // F-10, raised by the independent challenger: this proof's output IS release
    // evidence, and it ran at collation `C` while the settled deployment target
    // is the PostgreSQL 16 family at `en_US.utf8` (TL-P4-S3-R4) -- and said so
    // nowhere. Seven limitations were printed and none of them was this one.
    // The identity below is read back from the server, so the collation is now
    // part of the evidence instead of part of the weather.
    console.log(`CLUSTER: ${clusterIdentity(PRIMARY.port, 'postgres')}`);

    const admin = new Pool({ connectionString: dbUrl(PRIMARY.port, 'postgres'), max: 2 });
    admin.on('error', () => undefined);
    await admin.query(`CREATE DATABASE ${DB} TEMPLATE template0`);
    await admin.end();

    pool = new Pool({ connectionString: dbUrl(PRIMARY.port, DB), max: 4 });
    pool.on('error', () => undefined);

    let bootstrap = sh(`cat ${join(ROOT, 'infrastructure/database/bootstrap.sql')}`).out;
    for (const placeholder of [
      '__APP_DB_PASSWORD__',
      '__PLATFORM_DB_PASSWORD__',
      '__WORKER_DB_PASSWORD__',
      '__RESOLVER_DB_PASSWORD__',
      '__IDENTITY_DB_PASSWORD__',
      '__PROVISIONER_DB_PASSWORD__',
      '__RECONCILER_DB_PASSWORD__',
      '__MIGRATOR_DB_PASSWORD__',
    ]) {
      // PART 103: the app role's password is the fixture's per-run value; the
      // rest get their own per-run values. No committed credential anywhere.
      bootstrap = bootstrap.replaceAll(placeholder, placeholder === '__APP_DB_PASSWORD__' ? APP_PASSWORD : `${APP_PASSWORD}_${placeholder.length}`);
    }
    await pool.query(bootstrap);
    const migrations = (await runMigrations(dbUrl(PRIMARY.port, DB))).length;
    await installAssertionKey(dbUrl(PRIMARY.port, DB));
    console.log(`  schema    bootstrap.sql applied, ${migrations} migrations, assertion key ${DR_ASSERTION_KID} installed`);

    const entryDate = await todayInBusinessTimezone(pool);
    const appUrl = roleUrl(PRIMARY.port, APP_ROLE, APP_PASSWORD, DB);
    const stamp = Date.now();

    // ── 2. the base backup comes FIRST, before any entry exists ────────────
    //
    // This ordering is the point. If the backup were taken after A, "A
    // survived" would be satisfied by the backup alone and would say nothing
    // about WAL replay. Taken here, the backup contains the schema and no
    // journal entries at all, so every entry that appears after recovery
    // arrived by replaying the archive.
    const beforeATime = await nowOnServer(pool);
    const bbStart = Date.now();
    baseBackup(PRIMARY.port, BASEBACKUP);
    const baseBackupMs = Date.now() - bbStart;
    const entriesInBackup = Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries`)).rows[0]?.n ?? '0');
    console.log(`  backup    pg_basebackup -Fp -X stream in ${baseBackupMs}ms, taken with ${entriesInBackup} journal entries in the database`);
    if (entriesInBackup !== 0) {
      throw new Error(
        `the base backup was taken with ${entriesInBackup} entries already present; this proof requires it to precede every entry, or "A survived" would not prove WAL replay`,
      );
    }

    // ── 3. entry A, then the target, then entry B ─────────────────────────
    const tenantA = await seedOneTenant(pool, appUrl, { label: 'PITR A', slug: `p15pitr-a-${stamp}`, amountMinor: 150000n, entryDate });
    await flushWalToArchive(pool, 'entry A');

    // The expected state AT THE TARGET, captured here rather than reconstructed
    // later: the target falls after A and before B, so the database as it
    // stands right now IS what a correct recovery must reproduce. Captured
    // before B exists, because afterwards the primary can no longer show it —
    // and the primary is about to be destroyed either way.
    const expectedAtTarget = tableDigests(PRIMARY.port);
    // A distinct second, so `recovery_target_time` can fall strictly between
    // A and B. PostgreSQL resolves a target time against commit timestamps, so
    // two commits inside the same second cannot be separated by one.
    await sleep(1200);
    const targetTime = await nowOnServer(pool);
    await sleep(1200);

    const tenantB = await seedOneTenant(pool, appUrl, { label: 'PITR B', slug: `p15pitr-b-${stamp}`, amountMinor: 275500n, entryDate });
    const afterBTime = await nowOnServer(pool);
    // B's commit LSN, read immediately after its commit.
    //
    // R-P4 recovers to this LSN rather than to `afterBTime`, and the reason is
    // measured: a TIME target later than the last record in the archive is
    // never reached, so PostgreSQL ends recovery with "recovery ended before
    // configured recovery target was reached" and exits — correct behaviour
    // that made the proof INCONCLUSIVE rather than red or green. Since nothing
    // commits after B, EVERY timestamp after B's commit is such a target. An
    // LSN at B's commit is reachable by construction, and it exercises the LSN
    // target path that a time target does not.
    const afterBLsnRow = (await pool.query<{ l: string }>(`SELECT pg_current_wal_insert_lsn()::text AS l`)).rows[0];
    if (afterBLsnRow === undefined) throw new Error('the server returned no current WAL insert LSN after entry B; a recovery target must come from the server');
    const afterBLsn = afterBLsnRow.l;
    const flushed = await flushWalToArchive(pool, 'entry B');
    console.log(`  timeline  A ${tenantA.entryId.slice(0, 8)} < target ${targetTime} < B ${tenantB.entryId.slice(0, 8)}`);

    // ── 4. P1 — archiving is actually running ─────────────────────────────
    const archiverRow = (
      await pool.query<{ archived: string; failed: string; last: string | null }>(
        `SELECT archived_count::text AS archived, failed_count::text AS failed, last_archived_wal AS last FROM pg_stat_archiver`,
      )
    ).rows[0];
    if (archiverRow === undefined)
      throw new Error('pg_stat_archiver returned no row; the archiver view is the only evidence that archiving ran, so this cannot be inferred');
    const archiver = archiverRow;
    const segments = archivedSegments(ARCHIVE);
    if (Number(archiver.archived) > 0 && archiver.last && Number(archiver.failed) === 0 && segments.length > 0) {
      pass(
        vArchiving,
        segments.length,
        `archived_count=${archiver.archived}, failed_count=${archiver.failed}, last_archived_wal=${archiver.last}, ${segments.length} segment(s) on disk in ${ARCHIVE}`,
      );
    } else {
      fail(
        vArchiving,
        segments.length,
        `archived_count=${archiver.archived}, failed_count=${archiver.failed}, last=${archiver.last ?? 'none'}, segments=${segments.length}`,
      );
    }

    // ── 5. P6 — the archive-failure monitor ───────────────────────────────
    const monitor = archiveMonitor(pool);
    const health = await monitor;
    if (health.healthy) pass(vMonitor, 1, health.detail);
    else fail(vMonitor, 1, health.detail);

    timeline = {
      entryDate,
      tenantA: { entryId: tenantA.entryId, slug: tenantA.slug },
      tenantB: { entryId: tenantB.entryId, slug: tenantB.slug },
      targetTime,
      afterBTime,
      afterBLsn,
      beforeATime,
      baseBackupMs,
      archivedAtTarget: flushed.archivedCount,
    };

    // ── 6. the disaster: the primary is destroyed, not shut down politely ──
    await pool.end();
    pool = undefined;
    stopCluster(PRIMARY);
    rmSync(join(PRIMARY.dir, 'data'), { recursive: true, force: true });
    primaryUp = false;
    console.log(`  disaster  primary data directory destroyed; only ${BASEBACKUP} and ${ARCHIVE} remain`);

    // ── 7. recover to the target between A and B ──────────────────────────
    const rtoStart = Date.now();
    const recovered = recoverTo({ time: targetTime }, 'recover-to-target');
    const rtoMs = Date.now() - rtoStart;
    if (!recovered.ok && recovered.contention) {
      contention(vRecovers, recovered.detail);
      contention(vCutBefore, 'the recovery was never attempted, so there is no cut to read: INVALID MEASUREMENT — RESOURCE CONTENTION');
      contention(vCutAfter, 'the recovery was never attempted, so there is no cut to read: INVALID MEASUREMENT — RESOURCE CONTENTION');
    } else if (!recovered.ok) {
      fail(vRecovers, 1, recovered.detail);
      fail(vCutBefore, 0, 'recovery did not complete, so no cut could be read');
      fail(vCutAfter, 0, 'recovery did not complete, so no cut could be read');
    } else {
      pass(vRecovers, 1, `recovered to ${targetTime} and promoted to read-write in ${rtoMs}ms (container-scale, NOT production RTO)`);
      const a = probeEntry(recovered.port, timeline.tenantA.entryId);
      const b = probeEntry(recovered.port, timeline.tenantB.entryId);
      if (a.present)
        pass(
          vCutBefore,
          a.entries,
          `entry A ${timeline.tenantA.entryId} is present; ${a.entries} entries on the recovered cluster, which the base backup contained 0 of — so it was replayed from the WAL archive`,
        );
      else fail(vCutBefore, a.entries, `entry A ${timeline.tenantA.entryId} is MISSING after recovery to a target after its commit`);
      if (!b.present) pass(vCutAfter, a.entries, `entry B ${timeline.tenantB.entryId} is absent, as a target before its commit requires`);
      else
        fail(
          vCutAfter,
          a.entries,
          `entry B ${timeline.tenantB.entryId} is PRESENT after recovery to a target BEFORE its commit — the point-in-time cut did not cut`,
        );
      if (a.unbalanced === 0) pass(vBalanced, a.entries, `0 unbalanced entries among ${a.entries} on the recovered cluster`);
      else fail(vBalanced, a.entries, `${a.unbalanced} unbalanced entries survived recovery`);

      // ── P8 — the WHOLE database, not just the journal ──────────────────
      //
      // "entry A is present" is a claim about two tables. A recovery that got
      // the journal right and silently lost a branch, a warehouse or a unit of
      // reference data would satisfy every validator above it.
      const recoveredState = tableDigests(recovered.port);
      const expectedTables = Object.keys(expectedAtTarget).sort();
      const recoveredTables = Object.keys(recoveredState).sort();
      const onlyExpected = expectedTables.filter((t) => !recoveredTables.includes(t));
      const onlyRecovered = recoveredTables.filter((t) => !expectedTables.includes(t));
      const drifted = expectedTables.filter((t) => recoveredTables.includes(t) && expectedAtTarget[t] !== recoveredState[t]);
      const withRows = expectedTables.filter((t) => digestRows(expectedAtTarget[t] ?? '0:') > 0);
      if (onlyExpected.length === 0 && onlyRecovered.length === 0 && drifted.length === 0) {
        // F-05: the subject count is now the NON-EMPTY count, because an empty
        // table matching an empty table is a true comparison that proves
        // nothing about recovery. The full table count stays in the detail, so
        // nothing is hidden — but the headline number is the one with evidence
        // behind it, and the law above no longer says "ENTIRE".
        partial(
          vBreadth,
          withRows.length,
          expectedTables.length,
          `all ${expectedTables.length} tables in public match the state captured at the target byte-for-byte by whole-row digest; ${withRows.length} of them held rows, and the other ${expectedTables.length - withRows.length} prove only that they were empty at the target`,
        );
      } else {
        fail(
          vBreadth,
          expectedTables.length,
          `${drifted.length} table(s) drifted (${drifted.slice(0, 8).join(', ')}${drifted.length > 8 ? ', …' : ''}), ${onlyExpected.length} missing after recovery, ${onlyRecovered.length} unexpected`,
        );
      }

      // ── P9 — each named domain accounted for, by name ──────────────────
      const lines: string[] = [];
      let measuredDomains = 0;
      let brokenDomains = 0;
      for (const { domain, tables } of DOMAINS) {
        if (tables.length === 0) {
          lines.push(
            `${domain}: WAITING_FOR_INTEGRATED_SURFACE — no table carries it on this branch (it arrives with Phase 4), so it is NOT claimed as checked`,
          );
          continue;
        }
        const present = tables.filter((t) => expectedTables.includes(t));
        const absent = tables.filter((t) => !expectedTables.includes(t));
        const rows = present.reduce((n, t) => n + digestRows(expectedAtTarget[t] ?? '0:'), 0);
        const bad = present.filter((t) => expectedAtTarget[t] !== recoveredState[t]);
        if (bad.length > 0) {
          brokenDomains++;
          lines.push(`${domain}: FAIL — ${bad.join(', ')} differ after recovery`);
        } else if (rows > 0) {
          measuredDomains++;
          lines.push(
            `${domain}: MEASURED — ${rows} row(s) across ${present.length} table(s), all matching${absent.length > 0 ? ` (absent here: ${absent.join(', ')})` : ''}`,
          );
        } else {
          lines.push(`${domain}: UNMEASURED — ${present.length} table(s) exist but hold 0 rows at the target, so a match proves nothing about this domain`);
        }
      }
      if (brokenDomains > 0) fail(vDomains, DOMAINS.length, lines.join(' | '));
      else if (measuredDomains === 0) fail(vDomains, 0, `no domain had any row to compare: ${lines.join(' | ')}`);
      else if (measuredDomains < DOMAINS.length)
        partial(
          vDomains,
          measuredDomains,
          DOMAINS.length,
          `0 broken, but ${DOMAINS.length - measuredDomains} domain(s) could not be measured — ${lines.join(' | ')}`,
        );
      else pass(vDomains, DOMAINS.length, `all ${DOMAINS.length} domain(s) measured, 0 broken — ${lines.join(' | ')}`);
    }

    // ── 8. P7 — retention ─────────────────────────────────────────────────
    pass(...retentionProof());

    // ── 9. the red proofs ─────────────────────────────────────────────────
    if (PROVE) await redProofs(timeline);
  } finally {
    if (!KEEP) {
      stopCluster(RECOVERED);
      if (primaryUp) stopCluster(PRIMARY);
    } else {
      console.log(`\n(--keep) clusters left running where they are; superuser ${PG_SUPERUSER} / ${PG_SUPERPASS} — minted for this run only, recorded nowhere`);
    }
    await pool?.end().catch(() => undefined);
  }

  report(sha, dirty, timeline, Date.now() - started);
}

/**
 * The archive-failure monitor PART 104 asks for, as a function rather than a
 * document: a production deployment runs this on a schedule and pages on a
 * false. It reads `pg_stat_archiver` rather than inferring health from the
 * absence of complaints.
 */
async function archiveMonitor(pool: Pool): Promise<{ readonly healthy: boolean; readonly detail: string }> {
  const r = (
    await pool.query<{ archived: string; failed: string; last: string | null; lastFailed: string | null; lastFailTime: string | null; age: string | null }>(
      `SELECT archived_count::text AS archived,
              failed_count::text   AS failed,
              last_archived_wal    AS last,
              last_failed_wal      AS "lastFailed",
              last_failed_time::text AS "lastFailTime",
              EXTRACT(EPOCH FROM (now() - last_archived_time))::text AS age
         FROM pg_stat_archiver`,
    )
  ).rows[0];
  if (r === undefined)
    return { healthy: false, detail: 'pg_stat_archiver returned no row, so archive health is UNKNOWN; an unknown archive is not a healthy one' };
  const failed = Number(r.failed);
  const archived = Number(r.archived);
  if (archived === 0) return { healthy: false, detail: 'archived_count is 0: archiving has never succeeded, so the archive cannot be recovered from' };
  if (failed > 0) {
    return {
      healthy: false,
      detail: `failed_count=${failed}, last_failed_wal=${r.lastFailed ?? 'none'} at ${r.lastFailTime ?? 'unknown'} — a failing archive silently widens RPO until it is unbounded`,
    };
  }
  return {
    healthy: true,
    detail: `archived_count=${archived}, failed_count=0, last_archived_wal=${r.last}, last archived ${Number(r.age ?? '0').toFixed(1)}s ago`,
  };
}

/**
 * Retention, via PostgreSQL's own `pg_archivecleanup`, proved on a copy.
 *
 * Proved rather than described: the archive is copied, cleanup is run against
 * the oldest segment the base backup needs, and the result must have removed
 * strictly older segments and kept that one and everything after it. Deleting
 * a segment a base backup still needs destroys the ability to recover from it,
 * so "retention ran" is not the property worth checking — "retention kept what
 * recovery needs" is.
 */
function retentionProof(): [ValidatorResult, number, string] {
  const r = results.find((x) => x.id === 'P7');
  if (r === undefined) throw new Error('validator P7 was not registered before the retention proof ran');
  const copy = `${EVIDENCE}/retention-copy`;
  const segments = archivedSegments(ARCHIVE).sort();
  if (segments.length < 2) {
    r.verdict = 'UNMEASURED';
    r.detail = `only ${segments.length} archived segment(s); retention needs at least two to show it removed one and kept another`;
    return [r, 0, r.detail];
  }
  sh(`rm -rf ${copy}; mkdir -p ${copy}; cp ${ARCHIVE}/* ${copy}/ 2>/dev/null`);
  const keepFrom = segments[segments.length - 1];
  if (keepFrom === undefined) throw new Error('no archived segment to retain from, although at least two were counted a line earlier');
  const before = archivedSegments(copy).length;
  const cleanup = sh(`${PG16_BIN}/pg_archivecleanup ${copy} ${keepFrom}`);
  if (!cleanup.ok) {
    r.verdict = 'FAIL';
    r.detail = `pg_archivecleanup failed: ${cleanup.out}`;
    return [r, before, r.detail];
  }
  const after = archivedSegments(copy).sort();
  const removed = before - after.length;
  if (removed > 0 && after.includes(keepFrom)) {
    return [
      r,
      before,
      `pg_archivecleanup removed ${removed} of ${before} segment(s) older than ${keepFrom}, and kept ${keepFrom} itself — the segment a recovery from that point needs`,
    ];
  }
  r.verdict = 'FAIL';
  r.detail = `cleanup removed ${removed} segment(s) and ${after.includes(keepFrom) ? 'kept' : 'DELETED'} the needed segment ${keepFrom}`;
  return [r, before, r.detail];
}

// ── red proofs ────────────────────────────────────────────────────────────

interface RedProof {
  readonly id: string;
  readonly what: string;
  readonly expect: string;
  outcome: string;
}
const reds: RedProof[] = [];

async function redProofs(t: Timeline): Promise<void> {
  console.log('\nRED PROOFS — each must fail in a NAMED way, or the validator above it proves nothing');

  // R-P1: the backup did not contain A. Recover to a target BEFORE A.
  {
    const p: RedProof = {
      id: 'R-P1',
      what: `recover the same base backup to ${t.beforeATime}, before entry A was committed`,
      expect: 'entry A ABSENT — which proves A was never in the base backup and reached the earlier recovery only by WAL replay',
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const rec = recoverTo({ time: t.beforeATime }, 'red-before-A');
    if (!rec.ok) p.outcome = `INCONCLUSIVE — recovery did not complete: ${rec.detail}`;
    else {
      const a = probeEntry(rec.port, t.tenantA.entryId);
      p.outcome = a.present
        ? `GREEN — WRONG: entry A is present at a target before its own commit, so "A survived" above proves nothing about WAL replay (entries=${a.entries})`
        : `RED AS REQUIRED — entry A absent, ${a.entries} entries at that target; the base backup carried no entries, so the earlier A came from the archive`;
    }
  }

  // R-P4: B is genuinely recoverable. Recover to a target AFTER B.
  {
    const p: RedProof = {
      id: 'R-P4',
      what: `recover the same archive to LSN ${t.afterBLsn}, entry B's own commit position`,
      expect: 'entry B PRESENT — which proves its earlier absence was the target cutting, not B being lost or never written',
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const rec = recoverTo({ lsn: t.afterBLsn }, 'red-after-B');
    if (!rec.ok) p.outcome = `INCONCLUSIVE — recovery did not complete: ${rec.detail}`;
    else {
      const b = probeEntry(rec.port, t.tenantB.entryId);
      p.outcome = b.present
        ? `RED AS REQUIRED — entry B present at a target after its commit (${b.entries} entries); the cut is a cut, not a ceiling`
        : `GREEN — WRONG: entry B is absent even at a target AFTER its commit, so "B absent" above measured a lost transaction, not a point-in-time cut`;
    }
  }

  // R-P2: break archiving, and require the monitor to refuse.
  {
    const p: RedProof = {
      id: 'R-P2',
      what: 'point archive_command at an unwritable path on a fresh cluster and archive a segment',
      expect: 'failed_count > 0 AND the archive monitor reports unhealthy, naming the failing segment',
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const spec: ClusterSpec = { dir: `${BASE}-redarchive`, port: 55475, label: 'red-archive' };
    let brokenPool: Pool | undefined;
    try {
      prepareClusterDir(spec.dir);
      startCluster(spec, [
        "wal_level='replica'",
        "archive_mode='on'",
        "archive_command='cp %p /p15-nonexistent-archive-dir/%f'",
        "archive_timeout='5s'",
        "fsync='on'",
      ]);
      brokenPool = new Pool({ connectionString: dbUrl(spec.port, 'postgres'), max: 1 });
      brokenPool.on('error', () => undefined);
      await brokenPool.query(`SELECT pg_switch_wal()`);
      let failedCount = 0;
      for (let i = 0; i < 60; i++) {
        failedCount = Number((await brokenPool.query<{ n: string }>(`SELECT failed_count::text AS n FROM pg_stat_archiver`)).rows[0]?.n ?? '0');
        if (failedCount > 0) break;
        await sleep(500);
      }
      const health = await archiveMonitor(brokenPool);
      p.outcome =
        failedCount > 0 && !health.healthy
          ? `RED AS REQUIRED — failed_count=${failedCount} and the monitor refused: ${health.detail}`
          : `GREEN — WRONG: failed_count=${failedCount}, monitor healthy=${health.healthy} (${health.detail}); a broken archive was not detected`;
    } catch (e) {
      p.outcome = `INCONCLUSIVE — ${String(e)}`;
    } finally {
      await brokenPool?.end().catch(() => undefined);
      stopCluster(spec);
      rmSync(spec.dir, { recursive: true, force: true });
    }
  }

  // R-P3: remove an archived segment, and require recovery to refuse rather
  // than quietly serve a database short of its target.
  {
    const p: RedProof = {
      id: 'R-P3',
      what: 'delete the last archived WAL segment, then recover to the target that needs it',
      expect:
        'recovery does NOT silently reach its target: it refuses to start, fails to promote, or at minimum names the missing segment in the log — never serves a database that is quietly not the point in time that was asked for',
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const copy = `${EVIDENCE}/archive-with-a-hole`;
    const segments = archivedSegments(ARCHIVE).sort();
    // The LAST archived segment, not an arbitrary one.
    //
    // An earlier version deleted `segments[1]` while describing itself as
    // deleting the last, and went GREEN. The reason is worth keeping:
    // `pg_basebackup -X stream` ships the WAL the backup needs for its own
    // consistency inside the backup's `pg_wal/`, and entry A sat in a later
    // segment, so the segment removed was one recovery never asked
    // `restore_command` for. A hole only bites where recovery actually reads —
    // the WAL written AFTER the backup — and the segment holding the target is
    // the one it cannot do without.
    const holed = segments[segments.length - 1];
    if (segments.length < 2 || holed === undefined)
      p.outcome = `INCONCLUSIVE — only ${segments.length} archived segment(s); removing one leaves nothing to recover from`;
    else {
      sh(`rm -rf ${copy}; mkdir -p ${copy}; cp ${ARCHIVE}/* ${copy}/ 2>/dev/null; chown -R postgres:postgres ${copy}; rm -f ${copy}/${holed}`);
      stopCluster(RECOVERED);
      rmSync(RECOVERED.dir, { recursive: true, force: true });
      mkdirSync(RECOVERED.dir, { recursive: true });
      sh(`chmod 755 ${RECOVERED.dir}; chown postgres:postgres ${RECOVERED.dir}`);
      armRecovery(join(RECOVERED.dir, 'data'), BASEBACKUP, { restoreCommand: `cp ${copy}/%f %p`, targetTime: t.targetTime });
      sh(`printf "\\nport=${RECOVERED.port}\\n" >> ${join(RECOVERED.dir, 'data', 'postgresql.auto.conf')}`);
      const started = startExisting(RECOVERED.dir, 'red-hole');
      if (started.status !== 0) {
        p.outcome = `RED AS REQUIRED — the cluster refused to start with segment ${holed} missing: ${serverLog(RECOVERED.dir)
          .split('\n')
          .filter((l) => /FATAL|could not|requested|recovery/i.test(l))
          .slice(-3)
          .join(' | ')}`;
      } else {
        const done = waitForRecovery(RECOVERED.port, 45_000);
        if (!done.ok) {
          p.outcome = `RED AS REQUIRED — recovery never reached the target and never promoted: ${done.detail}`;
        } else {
          // Promoted despite the hole. With the TARGET's own segment missing
          // it cannot have reached that target, so what matters is whether it
          // SAID so: a promotion that names the hole leaves the operator able
          // to tell, while a silent one hands them a database that is not the
          // point in time they asked for.
          const a = probeEntry(RECOVERED.port, t.tenantA.entryId);
          const log = serverLog(RECOVERED.dir);
          const named = /recovery ended before configured recovery target|could not restore file|requested WAL segment|redo done/i.test(log);
          p.outcome = named
            ? `RED AS REQUIRED — promoted, but the log NAMES the hole instead of hiding it, so the operator is not told a target was met when it was not (segment ${holed} missing, entries=${a.entries})`
            : `GREEN — WRONG: recovery promoted with segment ${holed} deleted and said nothing about it; a hole in the archive is invisible and the database served is silently not the requested point in time (entries=${a.entries})`;
        }
      }
      stopCluster(RECOVERED);
    }
  }

  /* ── F-04: the validators that had never been shown to fail ─────────────
     The independent challenger's highest-risk finding was that red proofs
     reached P1-P4 only, while P5-P9 had none — and that on a commerce and
     bookkeeping platform the recovered ledger's integrity is among the most
     valuable things this proof claims. These three plant a defect on a
     RECOVERED cluster and re-run the very probe the validator uses, so a
     passing validator is shown to be capable of failing rather than assumed
     to be. */

  // R-P5: an unbalanced entry on the recovered cluster must be seen by the
  // same probe P5 reads.
  {
    const p: RedProof = {
      id: 'R-P5',
      what: 'recover to the target, then unbalance one journal entry on the RECOVERED cluster',
      expect: "the unbalanced count P5 reads goes above zero — P5's green is not vacuous",
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const rec = recoverTo({ time: t.targetTime }, 'red-p5-unbalanced');
    if (!rec.ok) p.outcome = `INCONCLUSIVE — recovery did not complete: ${rec.detail}`;
    else {
      const before = probeEntry(rec.port, t.tenantA.entryId);
      // Three columns move together: 0042 ties base_amount_minor to
      // GREATEST(debit, credit) and fx_shape ties txn_amount_minor to it for
      // same-currency rows, so a single-column edit is refused by a constraint
      // that fires before the one under test. `session_replication_role` is
      // what gets past the immutability trigger: the subject is a ledger that
      // came back wrong, not a user edit.
      const mutated = psqlScalar(
        rec.port,
        DB,
        `SET session_replication_role = replica;
         UPDATE journal_lines SET debit_minor = debit_minor + 1, base_amount_minor = debit_minor + 1, txn_amount_minor = debit_minor + 1
          WHERE id = (SELECT id FROM journal_lines WHERE debit_minor > 0 ORDER BY 1 LIMIT 1);
         SET session_replication_role = origin;
         SELECT 1`,
      );
      if (!mutated.ok) p.outcome = `INCONCLUSIVE — the mutation itself was refused, so nothing was planted: ${mutated.detail.slice(0, 200)}`;
      else {
        const after = probeEntry(rec.port, t.tenantA.entryId);
        p.outcome =
          after.unbalanced > 0
            ? `RED AS REQUIRED — the probe P5 reads reports ${after.unbalanced} unbalanced entry/entries where it reported ${before.unbalanced} before the edit, so P5 can go red`
            : `GREEN — WRONG: one entry was deliberately unbalanced and the probe still reports ${after.unbalanced}; P5's pass measures nothing`;
      }
    }
  }

  // R-P8: a single table altered on the recovered cluster must break the
  // whole-row digest comparison P8 performs.
  {
    const p: RedProof = {
      id: 'R-P8',
      what: 'alter one row on the recovered cluster and re-digest every table, as P8 does',
      expect: "the digest of exactly that table changes — P8's byte-for-byte claim is a real comparison",
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const rec = recoverTo({ time: t.targetTime }, 'red-p8-drift');
    if (!rec.ok) p.outcome = `INCONCLUSIVE — recovery did not complete: ${rec.detail}`;
    else {
      const before = tableDigests(rec.port);
      // `businesses`, not `tenants`: the first attempt edited `tenants.name`
      // and the server refused it with `column "name" does not exist` —
      // `tenants` carries only `id` and `created_at` (0003), and the `name`
      // column belongs to `businesses`. The proof reported INCONCLUSIVE rather
      // than claiming anything, which is the behaviour wanted; the lesson is
      // that a red proof must be checked against the real schema, not a
      // remembered one.
      const edit = psqlScalar(
        rec.port,
        DB,
        `SET session_replication_role = replica; UPDATE businesses SET name = left(name, 140) || '-p15-r-p8' WHERE id = (SELECT id FROM businesses ORDER BY 1 LIMIT 1); SET session_replication_role = origin; SELECT 1`,
      );
      if (!edit.ok) p.outcome = `INCONCLUSIVE — the mutation was refused, so nothing was planted: ${edit.detail.replace(/\n/g, ' | ').slice(0, 400)}`;
      else {
        const after = tableDigests(rec.port);
        const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
        p.outcome =
          changed.length === 1 && changed[0] === 'businesses'
            ? `RED AS REQUIRED — exactly one table's digest changed, and it is the one edited (${changed[0]}); P8 compares content, and it localises the drift`
            : changed.length === 0
              ? "GREEN — WRONG: a row was edited and NO table digest changed, so P8's byte-for-byte comparison compares nothing"
              : `RED, BUT IMPRECISE — ${changed.length} table digests changed (${changed.slice(0, 6).join(', ')}) for one edited row; P8 detects the drift but does not localise it`;
      }
    }
  }

  // R-P9: a domain that is MEASURED must be reported broken when it breaks.
  // This is the proof that P9's domain accounting is a comparison and not a
  // list: the `tenants` domain has rows at the target, so it is one of the two
  // P9 actually measures.
  {
    const p: RedProof = {
      id: 'R-P9',
      what: 'break the `tenants` domain on the recovered cluster — one of the two domains P9 reports as MEASURED',
      expect: 'the domain comparison reports a mismatch rather than counting the domain as accounted for',
      outcome: 'NOT RUN',
    };
    reds.push(p);
    const rec = recoverTo({ time: t.targetTime }, 'red-p9-domain');
    if (!rec.ok) p.outcome = `INCONCLUSIVE — recovery did not complete: ${rec.detail}`;
    else {
      const digestsBefore = tableDigests(rec.port);
      const del = psqlScalar(
        rec.port,
        DB,
        `SET session_replication_role = replica; DELETE FROM tenants WHERE id = (SELECT id FROM tenants ORDER BY 1 DESC LIMIT 1); SET session_replication_role = origin; SELECT count(*)::text FROM tenants`,
      );
      if (!del.ok) p.outcome = `INCONCLUSIVE — the deletion was refused, so nothing was planted: ${del.detail.slice(0, 200)}`;
      else {
        const digestsAfter = tableDigests(rec.port);
        const tenantsDiffer = digestsBefore['tenants'] !== digestsAfter['tenants'];
        p.outcome = tenantsDiffer
          ? `RED AS REQUIRED — the tenants domain's digest no longer matches the state captured at the target (${digestsBefore['tenants'] ?? '?'} \u2192 ${digestsAfter['tenants'] ?? '?'}), which is what P9 compares per domain; ${del.value} tenant row(s) remain`
          : "GREEN — WRONG: a tenant row was deleted and the domain digest is unchanged, so P9's per-domain accounting compares nothing";
      }
    }
  }

  // P6 and P7 are deliberately NOT given new red proofs here, and saying so is
  // the point rather than leaving a reader to count. P6 (the archive-failure
  // monitor) is already reddened by R-P2, which points archive_command at an
  // unwritable path and requires the monitor to refuse — that is P6's own
  // mechanism and attributing it to P6 is accurate. P7 (retention removes only
  // what is older than the base backup it is given) carries NO red proof: it
  // operates on a COPY of the archive and its assertion is that
  // pg_archivecleanup kept the needed segment, so planting a defect means
  // mutating pg_archivecleanup's own behaviour, which this proof cannot do
  // honestly. That gap is recorded rather than papered over.
  console.log('');
  console.log('  RED-PROOF COVERAGE, PER VALIDATOR — stated so nobody has to count:');
  console.log('    P1 R-P1 · P2 R-P2 · P3 R-P3 · P4 R-P4 · P5 R-P5 · P6 R-P2 (its own mechanism) · P8 R-P8 · P9 R-P9');
  console.log('    P7 has NO red proof: its subject is pg_archivecleanup\u2019s behaviour on a copy of the');
  console.log('    archive, and this proof cannot plant a defect in that honestly. Treat P7 as a');
  console.log('    measurement that has never been shown able to fail.');

  for (const p of reds)
    console.log(`  ${p.id} ${p.outcome.startsWith('RED') ? 'RED' : p.outcome.startsWith('INCONCLUSIVE') ? '???' : 'GREEN'} — ${p.what}\n       ${p.outcome}`);
}

// ── report ────────────────────────────────────────────────────────────────

function report(sha: string, dirty: boolean, t: Timeline | undefined, ms: number): void {
  console.log('\nVALIDATORS');
  for (const r of results) console.log(`  ${r.id} ${r.verdict.padEnd(10)} subjects=${r.subjects}  ${r.law}\n       ${r.detail}`);

  const failed = results.filter((r) => r.verdict === 'FAIL');
  const unmeasured = results.filter((r) => r.verdict === 'UNMEASURED');
  const partialResults = results.filter((r) => r.verdict === 'PARTIAL');
  const redsNotRed = reds.filter((p) => !p.outcome.startsWith('RED AS REQUIRED'));
  const ok = failed.length === 0 && unmeasured.length === 0 && (!PROVE || redsNotRed.length === 0);
  // A PARTIAL is not a failure, so it does not turn the exit code red: the
  // property held everywhere it could be measured. But it must not disappear
  // into a plain PASS either, which is precisely the defect being fixed — the
  // headline has to carry the narrower fact, because the headline is what a
  // reader quotes.
  if (partialResults.length > 0) {
    console.log('');
    console.log(`PARTIAL COVERAGE — ${partialResults.length} validator(s) held on every subject they could measure, but not on all of them:`);
    for (const r of partialResults) console.log(`  ${r.id} subjects=${r.subjects}  ${r.detail}`);
    console.log('  This is reported rather than rounded up. An empty table matching an empty table');
    console.log('  is a true comparison that proves nothing, and a domain with no rows at the target');
    console.log('  settles nothing about that domain.');
  }

  const summary = {
    status: 'PREPARED / NOT PROMOTED',
    part: 104,
    sha,
    dirty,
    mechanism: 'plain PostgreSQL WAL archiving (cp to a local directory) — NO vendor hard-coded',
    validators: results.map((r) => ({ id: r.id, verdict: r.verdict, subjects: r.subjects })),
    redProofs: reds.map((p) => ({ id: p.id, outcome: p.outcome.split(' —')[0] })),
    timeline: t
      ? {
          targetTime: t.targetTime,
          entryA: t.tenantA.entryId,
          entryB: t.tenantB.entryId,
          baseBackupMs: t.baseBackupMs,
          archivedSegments: archivedSegments(ARCHIVE).length,
        }
      : null,
    elapsedMs: ms,
    rpo: 'BOUNDED BY archive_timeout=30s IN THIS FIXTURE — not the documented 15-minute production RPO, which stays UNMEASURED',
    rto: 'container-scale on a seeded fixture — NOT production RTO (PART 105)',
    result: ok
      ? partialResults.length > 0
        ? 'PASS WITH PARTIAL COVERAGE'
        : 'PASS'
      : // A MEASURED FAILURE OUTRANKS CONTENTION (round 12, F-R12-03).
        //
        // This read contention FIRST, and that made the busy-port fix a way to
        // lose a real finding: a validator that decided BEFORE `recoverTo` and
        // failed, in a drill that then could not take its port, printed
        // «INVALID MEASUREMENT — RESOURCE CONTENTION» and exited 3 — "the drill
        // did not run" — with its failure nowhere in the verdict. Contention
        // says some things were NOT measured. It says nothing about the things
        // that WERE, and a failure among those is a fact the port cannot undo.
        failed.length > 0 || (PROVE && redsNotRed.length > 0)
        ? 'FAIL'
        : contentionDetail !== null
          ? 'INVALID MEASUREMENT — RESOURCE CONTENTION'
          : unmeasured.length > 0
            ? 'UNMEASURED'
            : 'FAIL',
    partialCoverage: partialResults.map((r) => ({ id: r.id, measuredSubjects: r.subjects })),
  };

  console.log('\nLIMITATIONS — printed on PASS as well as on FAIL');
  console.log('  · This is PART 101 tooling, not release evidence. Final PITR proof must run on the FINAL EXACT SHA.');
  console.log('  · The archive is a local directory. Encrypted, durable, off-host storage and its credentials are an activation dependency (PART 104).');
  console.log(
    '  · No production mechanism is chosen here. Managed PITR / pgBackRest / WAL-G is an OWNER DECISION; this harness deliberately hard-codes no vendor.',
  );
  console.log(
    '  · RPO/RTO above are fixture numbers on a container. PART 105 requires production-like dataset, storage, network and topology for the real ones.',
  );
  console.log('  · The recovery target is a TIME. Recovery to an LSN or a named restore point is supported by the same path and is not exercised here.');
  // The count is GONE rather than corrected, which is the round-8 N3 remedy
  // applied to code: this line said "the four red proofs" while seven were
  // declared below it, and in the branch that prints it none of them has run,
  // so there is nothing here to count from. A figure no run produced is a
  // figure that drifts the next time one is added.
  if (!PROVE) console.log('  · --prove-detection was NOT passed, so the red proofs did not run and these validators are unproved.');

  writeFileSync(join(EVIDENCE, 'pitr-run-identity.json'), `${JSON.stringify({ ...summary, tools: toolVersions(), loadavg: loadavg() }, null, 2)}\n`);
  console.log(`\nP15_PITR_PROOF: ${JSON.stringify(summary)}`);
  console.log(`PHASE 15 PITR PROOF: ${summary.result}`);
  // A DISTINCT CODE FOR "THE DRILL DID NOT RUN".
  //
  // Exit 1 is this instrument's verdict that a validator failed. Contention is
  // not a verdict about recoverability at all, and a reader of exit codes alone
  // — which is what V3 §9 makes the handoff carry — would otherwise read a busy
  // port as a failed disaster-recovery drill. Exit 3 says: re-run it alone.
  // The note is printed whenever contention happened, because it is true of the
  // validators that never ran either way. The CODE follows the verdict: exit 3
  // only when nothing was measured as failing, so that "the drill did not run"
  // can never swallow a drill that ran and failed (F-R12-03).
  if (contentionDetail !== null) {
    console.log(`  ${contentionDetail}`);
    console.log('  Re-run this instrument ALONE. The fixed ports it and `pitr:proof:prove` share are a');
    console.log('  named residual, not a result: nothing here is evidence about recovery either way.');
    if (failed.length > 0)
      console.log(
        `  ${failed.length} validator(s) FAILED BEFORE the contention, and that is a measurement: the verdict above is FAIL and the exit code is 1, not 3.`,
      );
    if (PROVE && redsNotRed.length > 0)
      console.log(
        `  ${redsNotRed.length} red proof(s) did NOT redden, and that is a measurement too: the verdict above is FAIL and the exit code is 1, not 3.`,
      );
  }
  // A RED PROOF THAT DID NOT REDDEN IS A MEASURED RESULT TOO (round 13, F-R13-04).
  //
  // The first ordering fix ranked `failed` above contention and stopped there,
  // so the OTHER measured adverse outcome — a planted defect the validators
  // did not catch — was still swallowed: `R-P2` contains no `recoverTo`, so it
  // runs to a verdict in exactly the window where the port can be busy, and a
  // silent red proof printed «the drill did not run» and exited 3. Every
  // adverse thing this instrument actually MEASURED outranks contention, not
  // just the first list of them.
  if (failed.length > 0 || (PROVE && redsNotRed.length > 0)) process.exitCode = 1;
  else if (contentionDetail !== null) process.exitCode = 3;
  else if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nPHASE 15 PITR PROOF: FAIL — ${String(e instanceof Error ? e.stack : e)}`);
  process.exitCode = 1;
});
