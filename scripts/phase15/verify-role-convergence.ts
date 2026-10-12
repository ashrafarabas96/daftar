/**
 * §10.0 — RUNTIME-ROLE ATTRIBUTE CONVERGENCE, ON THE CANDIDATE
 * =============================================================
 *
 * Mission V2 §10.0 takes a Phase 15 observation — `daftar_app` keeps BYPASSRLS
 * after a `bootstrap.sql` run while `daftar_reconciler` loses it — and says
 * that IF it is confirmed on the candidate runtime it is a security blocker
 * for the S4 seal now, and that if it came only from an old fixture that must
 * be recorded and no defect attached to production. This script is the
 * confirmation, and it is deliberately built to be able to come back smaller
 * than the claim it is testing.
 *
 * ── What "on the candidate" is made to mean here ───────────────────────────
 *
 * Not "a file that looks like the candidate's". The subject is read OUT OF GIT
 * by blob id, from the Phase 4 candidate ref, into a scratch directory. The
 * Phase 4 branch, its worktree and its working tree are never touched, never
 * checked out and never written: this process only reads blobs
 * (`git cat-file`) and applies them to a disposable cluster of its own. That is
 * the non-interruption law, and it is also the only way a Phase 15 container
 * may say anything about a Phase 4 tree at all.
 *
 * The run reports the blob ids it used, so a reader can confirm the subject
 * rather than trust this prose.
 *
 * ── The three cases, because the first one already narrows the claim ───────
 *
 * Reading the candidate's own migrations before running anything showed
 * something the original finding did not account for: TWO migrations REFUSE
 * to apply while any `daftar\_%` role holds BYPASSRLS, with named refusals —
 * `0050_accounting_report_indexes.sql` (`accounting.report_index_invalid: a
 * DAFTAR role holds SUPERUSER or BYPASSRLS`) and
 * `0052_accounting_journal_lines_rls_performance.sql`
 * (`accounting.journal_lines_rls_invalid: a DAFTAR role holds BYPASSRLS`).
 * So the train is not indifferent to the drift, and the honest question splits
 * into three:
 *
 *   C1  drift BEFORE a fresh migration run — does the train refuse?
 *       If it does, a clean deployment cannot be built on a drifted cluster,
 *       and that is a defence the original finding did not credit.
 *
 *   C2  drift AFTER migration, then re-run `bootstrap.sql` — is it stripped?
 *       This is the convergence question proper: is re-running the
 *       deployment's own bootstrap a way to put a drifted cluster right?
 *
 *   C3  drift AFTER migration, then re-run the migration train — is it caught?
 *       The train is idempotent, so an already-applied migration's DO block
 *       does not execute again. If C3 does not catch it, the guards in C1
 *       protect a FRESH install and nothing re-checks a LIVE one.
 *
 * C1 passing and C2/C3 failing is a materially smaller finding than "a DAFTAR
 * role can hold BYPASSRLS unnoticed", and it is the finding this script
 * expects. Reporting the larger version when the smaller one is true is the
 * failure this thread has been corrected for before (`TL-P4-COORD-R39`), so
 * the verdict below is computed from the three cases rather than asserted.
 *
 * Exit 0 when all three cases were measured, whatever they found; 1 when any
 * could not be. The verdict is in the text, never in the exit code: this is a
 * report for the bootstrap owner and the Security Authority, not a gate.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startCluster, stopCluster, prepareClusterDir, psqlScalar, createEmptyDatabase, dbUrl, PG_SUPERPASS, PG16_BIN, type ClusterSpec } from './pg-cluster';
// The candidate runtime is built by the APPLICATION'S OWN migrator, not by a
// loop of `psql -f`.
//
// This is not a convenience. The first version of this script applied each
// file with `psql -f` and 0052 failed on `current_setting('daftar.s8_pre_…')`
// — because that file sets the GUC in one DO block and reads it in another,
// and `runMigrations` wraps each file in a single BEGIN/COMMIT while `psql -f`
// gives every statement its own implicit transaction. The migration was right
// and the harness was wrong. A harness that applies migrations differently
// from the deployment measures the harness.
import { runMigrations } from '../../apps/api/src/infra/migrate';

const ROOT = resolve(__dirname, '../..');
const DIR = '/tmp/daftar-p15-roleconv';
const PORT = 55483;
const DB = 'daftar';
/**
 * The migrations directory holds ONLY migrations.
 *
 * `runMigrations` applies every `.sql` in the directory it is given, so the
 * first version of this script — which staged bootstrap.sql beside them —
 * applied 88 files where the candidate has 87, and bootstrap.sql was recorded
 * in `schema_migrations` as though it were a migration. The count check caught
 * it; the directories are separate now so it cannot recur.
 */
const SQL_DIR = join(DIR, 'sql');
const BOOT_DIR = join(DIR, 'boot');
/** The candidate's migration basenames, in apply order. */
let FILE_NAMES: readonly string[] = [];
/** The candidate ref §10.0 names, and the branch it sits on. */
const CANDIDATE_REFS = ['969b8605', 'origin/phase/4-sales-pos-customers-receivables'] as const;
const SUBJECT = 'daftar_app';
const CONTROL = 'daftar_reconciler';

const git = (args: readonly string[]): { ok: boolean; out: string; err: string } => {
  const r = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
};

/** Resolve the first reachable candidate ref, or null. */
function candidateRef(): string | null {
  for (const r of CANDIDATE_REFS) if (git(['cat-file', '-e', `${r}^{commit}`]).ok) return r;
  return null;
}

/** `psql -f`, so a multi-statement file is not wrapped in one transaction. */
function psqlFile(path: string, db: string): { ok: boolean; detail: string; firstError: string } {
  const r = spawnSync(`${PG16_BIN}/psql`, ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-f', path], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PG_SUPERPASS },
    maxBuffer: 64 * 1024 * 1024,
  });
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return {
    ok: r.status === 0,
    detail: all.trim(),
    firstError: all.split('\n').find((l) => /ERROR|FATAL/.test(l))?.trim() ?? '',
  };
}

const bypassrls = (role: string): string => psqlScalar(PORT, DB, `SELECT rolbypassrls FROM pg_roles WHERE rolname='${role}'`).value;

interface Case {
  readonly id: string;
  readonly question: string;
  answer: string;
  measured: boolean;
  readonly notes: string[];
}
const cases: Case[] = [];
const newCase = (id: string, question: string): Case => {
  const c: Case = { id, question, answer: 'NOT MEASURED', measured: false, notes: [] };
  cases.push(c);
  return c;
};

async function main(): Promise<number> {
  console.log('§10.0 — RUNTIME-ROLE ATTRIBUTE CONVERGENCE, ON THE CANDIDATE');
  console.log('='.repeat(78));

  const ref = candidateRef();
  if (ref === null) {
    console.log(`UNMEASURED: none of ${CANDIDATE_REFS.join(', ')} is reachable in this repository.`);
    console.log('  Fetch the Phase 4 ref and re-run. Nothing is claimed about a tree this box cannot read.');
    return 1;
  }
  const sha = git(['rev-parse', ref]).out.trim();
  console.log(`candidate ref:   ${ref}  →  ${sha}`);

  // The subject, by BLOB id, so "the candidate's bootstrap" is a fact and not
  // a resemblance. Phase 4's tree is read, never checked out or written.
  const bootBlob = git(['rev-parse', `${ref}:infrastructure/database/bootstrap.sql`]).out.trim();
  const myBootBlob = git(['rev-parse', 'HEAD:infrastructure/database/bootstrap.sql']).out.trim();
  console.log(`bootstrap.sql:   blob ${bootBlob} on the candidate`);
  console.log(`                 blob ${myBootBlob} on this prep branch`);
  console.log(
    bootBlob === myBootBlob
      ? '                 IDENTICAL — the earlier Phase 15 measurement was made on the candidate’s exact bytes, by blob identity, not by resemblance'
      : '                 DIFFERENT — the earlier Phase 15 measurement was NOT of this file; everything below re-measures the candidate’s copy',
  );

  const migNames = git(['ls-tree', '-r', '--name-only', ref, '--', 'infrastructure/database/migrations'])
    .out.split('\n')
    .filter((n) => n.endsWith('.sql'))
    .sort();
  console.log(`migrations:      ${migNames.length} on the candidate (this prep branch carries ${readdirSync(join(ROOT, 'infrastructure/database/migrations')).filter((n) => n.endsWith('.sql')).length})`);
  if (migNames.length === 0) {
    console.log('UNMEASURED: the candidate ref carries no migrations at that path.');
    return 1;
  }

  // Stage the candidate's bytes in a scratch directory of this run's own.
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(SQL_DIR, { recursive: true });
  mkdirSync(BOOT_DIR, { recursive: true });
  const boot = git(['cat-file', 'blob', bootBlob]).out.replace(/__([A-Z_]+)_PASSWORD__/g, () => `p15_${randomBytes(18).toString('base64url')}`);
  const bootPath = join(BOOT_DIR, 'bootstrap.sql');
  writeFileSync(bootPath, boot, { mode: 0o644 });
  const migPaths: string[] = [];
  for (const name of migNames) {
    const blob = git(['rev-parse', `${ref}:${name}`]).out.trim();
    const body = git(['cat-file', 'blob', blob]).out;
    const p = join(SQL_DIR, name.split('/').pop() as string);
    writeFileSync(p, body, { mode: 0o644 });
    migPaths.push(p);
  }
  FILE_NAMES = migNames.map((n) => n.split('/').pop() as string);
  console.log(`staged:          ${migPaths.length} migration(s) + bootstrap.sql read out of git into a scratch dir (Phase 4’s tree untouched)`);
  console.log('');

  const spec: ClusterSpec = { dir: DIR, port: PORT, label: 'roleconv' };
  try {
    prepareClusterDir(spec.dir);
    // The scratch SQL lives under the cluster dir, which prepareClusterDir
    // wipes, so it is staged again afterwards.
    mkdirSync(SQL_DIR, { recursive: true });
    mkdirSync(BOOT_DIR, { recursive: true });
    writeFileSync(bootPath, boot, { mode: 0o644 });
    for (let i = 0; i < migNames.length; i += 1) {
      const name = migNames[i] as string;
      const blob = git(['rev-parse', `${ref}:${name}`]).out.trim();
      writeFileSync(migPaths[i] as string, git(['cat-file', 'blob', blob]).out, { mode: 0o644 });
    }
    startCluster(spec, ["fsync='off'", "full_page_writes='off'"]);
    createEmptyDatabase(spec.port, DB);

    /* ── the candidate runtime: bootstrap, then the whole train ──────────── */
    const b0 = psqlFile(bootPath, DB);
    if (!b0.ok) {
      console.log(`UNMEASURED: the candidate's bootstrap.sql did not apply: ${b0.firstError.slice(0, 300)}`);
      return 1;
    }
    let applied = 0;
    try {
      applied = (await runMigrations(dbUrl(spec.port, DB), SQL_DIR)).length;
    } catch (e) {
      console.log(`UNMEASURED: the candidate's train did not apply on a clean cluster: ${(e as Error).message.slice(0, 300)}`);
      console.log('  That is a problem with this harness or with the candidate, not an answer to §10.0.');
      return 1;
    }
    if (applied !== migNames.length) {
      console.log(`UNMEASURED: ${applied} of ${migNames.length} migrations applied on a clean cluster.`);
      return 1;
    }
    console.log(`candidate runtime built: bootstrap + ${applied} migration(s) applied clean`);
    console.log(`  baseline: ${SUBJECT}.rolbypassrls=${bypassrls(SUBJECT)}, ${CONTROL}.rolbypassrls=${bypassrls(CONTROL)}`);
    console.log('');

    /* ── C1 — drift BEFORE a fresh migration run ─────────────────────────── */
    {
      const c = newCase('C1', 'Does the migration train REFUSE to apply while a DAFTAR role holds BYPASSRLS?');
      // A second, clean database so the train runs from zero against the drift.
      const DB2 = 'daftar_c1';
      createEmptyDatabase(spec.port, DB2);
      const b = psqlFile(bootPath, DB2);
      if (!b.ok) {
        c.notes.push(`bootstrap on ${DB2} failed: ${b.firstError.slice(0, 200)}`);
      } else {
        const drift = psqlScalar(spec.port, DB2, `ALTER ROLE ${SUBJECT} BYPASSRLS; SELECT 1`);
        const got = psqlScalar(spec.port, DB2, `SELECT rolbypassrls FROM pg_roles WHERE rolname='${SUBJECT}'`).value;
        if (!drift.ok || got !== 't') {
          c.notes.push(`the premise failed: could not give ${SUBJECT} BYPASSRLS (rolbypassrls=${got})`);
        } else {
          c.notes.push(`premise: ${SUBJECT}.rolbypassrls=t before the train runs`);
          let refusedBy = '';
          let refusal = '';
          let n = 0;
          try {
            n = (await runMigrations(dbUrl(spec.port, DB2), SQL_DIR)).length;
          } catch (e) {
            refusal = (e as Error).message;
            // runMigrations does not name the file in its rejection, so the
            // refuser is read from the database: the migrations that COMMITTED
            // are recorded, and the next file in order is the one that refused.
            n = Number(psqlScalar(spec.port, DB2, 'SELECT count(*) FROM schema_migrations').value || '0');
            refusedBy = (FILE_NAMES[n] ?? '(the file after the last recorded one)').toString();
          }
          c.measured = true;
          if (refusedBy === '') {
            c.answer = `NO — the whole train of ${n} migration(s) applied with ${SUBJECT} holding BYPASSRLS`;
            c.notes.push('so a fresh deployment CAN be built on a drifted cluster, and the finding is the larger one');
          } else {
            c.answer = `YES — refused at ${refusedBy} after ${n} migration(s)`;
            c.notes.push(`named refusal: ${refusal.slice(0, 220)}`);
            c.notes.push('so a FRESH install cannot be completed on a drifted cluster: the drift is caught, by name, by the candidate’s own migrations');
          }
          // Put the control back so the drift does not leak into C2/C3's reading.
          psqlScalar(spec.port, DB2, `ALTER ROLE ${SUBJECT} NOBYPASSRLS; SELECT 1`);
        }
      }
    }

    /* ── C2 — drift AFTER migration, then re-run bootstrap ───────────────── */
    {
      const c = newCase('C2', 'On an already-migrated database, does re-running bootstrap.sql STRIP the drift?');
      const d1 = psqlScalar(spec.port, DB, `ALTER ROLE ${SUBJECT} BYPASSRLS; ALTER ROLE ${CONTROL} BYPASSRLS; SELECT 1`);
      const before = { subject: bypassrls(SUBJECT), control: bypassrls(CONTROL) };
      if (!d1.ok || before.subject !== 't' || before.control !== 't') {
        c.notes.push(`the premise failed: ${SUBJECT}=${before.subject}, ${CONTROL}=${before.control}`);
      } else {
        c.notes.push(`premise: both ${SUBJECT} and ${CONTROL} hold BYPASSRLS on the migrated database`);
        const again = psqlFile(bootPath, DB);
        const after = { subject: bypassrls(SUBJECT), control: bypassrls(CONTROL) };
        c.measured = true;
        c.notes.push(`bootstrap.sql re-run ${again.ok ? 'applied clean' : `exited non-zero: ${again.firstError.slice(0, 180)}`}`);
        c.answer =
          after.subject === 'f' && after.control === 'f'
            ? 'YES — both roles converged'
            : `NO — ${SUBJECT} t → ${after.subject}, ${CONTROL} t → ${after.control}`;
        if (after.subject === 't' && after.control === 'f') {
          c.notes.push(
            `the asymmetry is the whole finding, measured on the candidate's own file: ${CONTROL}'s ALTER branch re-asserts NOBYPASSRLS and ${SUBJECT}'s names only LOGIN and PASSWORD, so re-running the deployment's own bootstrap is NOT a way to put a drifted ${SUBJECT} right`,
          );
        }
      }
    }

    /* ── C3 — drift AFTER migration, then re-run the train ───────────────── */
    {
      const c = newCase('C3', 'On an already-migrated database, does re-running the migration train CATCH the drift?');
      const got = bypassrls(SUBJECT);
      if (got !== 't') {
        // C2 may have stripped it; re-establish the premise explicitly.
        psqlScalar(spec.port, DB, `ALTER ROLE ${SUBJECT} BYPASSRLS; SELECT 1`);
      }
      const premise = bypassrls(SUBJECT);
      if (premise !== 't') {
        c.notes.push(`the premise failed: ${SUBJECT}.rolbypassrls=${premise}`);
      } else {
        c.notes.push(`premise: ${SUBJECT}.rolbypassrls=t on the migrated database`);
        // The train as a deployment re-runs it: each file applied again. An
        // already-applied migration is expected to be a no-op.
        let caughtBy = '';
        let refusal = '';
        let reapplied = -1;
        try {
          reapplied = (await runMigrations(dbUrl(spec.port, DB), SQL_DIR)).length;
        } catch (e) {
          refusal = (e as Error).message;
          const done = Number(psqlScalar(spec.port, DB, 'SELECT count(*) FROM schema_migrations').value || '0');
          caughtBy = (FILE_NAMES[done] ?? '(the file after the last recorded one)').toString();
        }
        if (caughtBy === '') c.notes.push(`the re-run applied ${reapplied} new migration(s) — an already-recorded file is skipped by checksum, so its DO-block guards do not execute again`);
        c.measured = true;
        if (caughtBy === '') {
          c.answer = 'NO — the train re-ran to completion with the drift in place';
          c.notes.push(
            'so the guards C1 found protect a FRESH install and nothing re-checks a LIVE one: an already-migrated database that drifts is caught by neither bootstrap (C2) nor the train (C3)',
          );
        } else {
          c.answer = `YES — caught at ${caughtBy}`;
          c.notes.push(`named refusal: ${refusal.slice(0, 220)}`);
        }
      }
    }
  } catch (e) {
    console.log(`UNMEASURED: ${(e as Error).message.slice(0, 400)}`);
    return 1;
  } finally {
    try {
      stopCluster(spec);
      rmSync(DIR, { recursive: true, force: true });
    } catch {
      /* a disposable cluster that will not die is not a verdict */
    }
  }

  console.log('-'.repeat(78));
  for (const c of cases) {
    console.log(`${c.id}  ${c.measured ? '' : 'NOT MEASURED — '}${c.question}`);
    console.log(`     ${c.answer}`);
    for (const n of c.notes) console.log(`     · ${n}`);
  }
  console.log('-'.repeat(78));

  const by = (id: string): Case | undefined => cases.find((c) => c.id === id);
  const c1 = by('C1');
  const c2 = by('C2');
  const c3 = by('C3');
  const allMeasured = cases.every((c) => c.measured);
  console.log('§10.0 — WHAT THIS CONFIRMS, AND WHAT IT NARROWS');
  if (!allMeasured) {
    console.log('  Not every case was measured, so no verdict is offered. An unmeasured case is not a clean bill.');
    return 1;
  }
  const freshProtected = c1?.answer.startsWith('YES') === true;
  const bootstrapConverges = c2?.answer.startsWith('YES') === true;
  const trainRechecks = c3?.answer.startsWith('YES') === true;

  console.log(`  CONFIRMED on the candidate's own bootstrap.sql${bootBlob === myBootBlob ? ' (byte-identical to the file Phase 15 measured)' : ''}:`);
  console.log(`    re-running bootstrap ${bootstrapConverges ? 'DOES' : 'does NOT'} converge a drifted ${SUBJECT}, while it ${bootstrapConverges ? 'also does' : 'DOES'} converge ${CONTROL}.`);
  console.log('');
  if (freshProtected && !bootstrapConverges && !trainRechecks) {
    console.log('  NARROWED, and this is the part §10.0 does not yet account for:');
    console.log(`    A FRESH install is PROTECTED — the candidate's own migrations refuse by name while`);
    console.log(`    any daftar_% role holds BYPASSRLS, so a drifted cluster cannot be migrated from zero.`);
    console.log('    What is NOT protected is an ALREADY-MIGRATED database: the train is idempotent, so its');
    console.log('    guards do not execute again, and bootstrap does not converge. A role that drifts AFTER');
    console.log('    deployment is caught by neither.');
    console.log('');
    console.log('  So the accurate statement is a CONVERGENCE AND RE-CHECK gap on a live database, not an');
    console.log('  unguarded one. Setting the attribute still takes a superuser, who can do worse directly.');
    console.log('  Whether that is an S4 seal blocker is the Security Authority’s and the bootstrap owner’s');
    console.log('  call, not this container’s — but it should be decided against the narrower claim.');
    console.log('  V3 §10.0 has since made that call: MEDIUM, and not an automatic S4 blocker on fixture');
    console.log('  evidence alone. See the R58 block below.');
  } else if (!freshProtected) {
    console.log('  NOT narrowed: the train applied with the drift in place, so a fresh deployment can be');
    console.log('  built on a drifted cluster and the larger reading of the finding stands.');
  }
  console.log('');
  console.log('WHERE THIS SITS UNDER MISSION V3 §10.0 / TL-P4-COORD-R58 — WHICH SUPERSEDES THIS SCRIPT');
  console.log('  R58 settled the classification, and it is BROADER than this script measures and');
  console.log('  LOWER than this script could have implied:');
  console.log('    · R58 proved, on PG16.13 in a fixture with the 87 migrations, that bootstrap.sql');
  console.log('      creates clean roles on a FRESH install and re-runs with no difference, but does');
  console.log('      not strip FIVE elevated attributes planted on SIX pre-existing LOGIN roles:');
  console.log('      SUPERUSER / BYPASSRLS / CREATEDB / CREATEROLE / REPLICATION.');
  console.log('    · This script measures ONE of those five (BYPASSRLS) on TWO roles. It is a');
  console.log('      narrower instance of R58’s finding, not a separate one.');
  console.log('    · R58 rates it a convergence/deployment defect of severity MEDIUM, and rules that');
  console.log('      a defect proved in a FIXTURE ALONE is NOT an automatic blocker for the S4 seal.');
  console.log('      This run is a fixture too: a disposable cluster built from the candidate’s blobs.');
  console.log('    · The REAL Phase 4, staging and production role attributes were NOT measured, here');
  console.log('      or by R58, so the dangerous attribute is NOT attributed to any of them.');
  console.log('    · The escalation path is the Security Authority’s READ-ONLY `pg_roles` query on the');
  console.log('      candidate’s actual runtime, within authorised access. An unauthorised elevated');
  console.log('      attribute on a REAL role is an immediate blocker; absence is recorded with the');
  console.log('      environment’s identity, and the convergence fix stays with its owner.');
  console.log('    · R58 also records a second defect this script does not test: the S1 CORE-DEPLOY');
  console.log('      gate builds a clean database and so cannot by itself detect drift in an existing');
  console.log('      one.');
  console.log('    · The P15 §7.1 proposal and the Phase 4 annex are ONE consistent request, not two');
  console.log('      competing implementations. Any result that depends on a patch not yet applied is');
  console.log('      CONDITIONAL: the edited-bootstrap model was proved in an independent scratch copy');
  console.log('      WITHOUT replaying the 87 migrations over it.');
  console.log('    · bootstrap.sql carries HARD LINKS in this container. Copy or safely unlink before');
  console.log('      editing any shared inode; this script edits nothing.');
  console.log('');
  console.log('  PRINCIPAL (V3 §7): this run applies the whole train as the cluster SUPERUSER. The');
  console.log('  documented install contract is a SPLIT — 0000-0039 administrator, 0040+ migrator —');
  console.log('  and a single-principal run of all 87 is NOT the project’s real install path. So C1’s');
  console.log('  refusal is measured on the schema, not on the install contract.');
  console.log('');
  console.log('  A finding from a prep container is a LEAD, never a verdict about another tree');
  console.log('  (TL-P4-COORD-R39). Phase 4’s branch, worktree and working tree were not touched: this run');
  console.log('  read blobs out of git and applied them to a disposable cluster of its own.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`UNMEASURED: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
