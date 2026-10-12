/**
 * Positive and negative control for `verify:role-attributes`, on a disposable
 * cluster. PART 10 requires both: a control proving the clean case reads clean,
 * and a control proving a planted attribute is actually caught.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { prepareClusterDir, startCluster, stopCluster, PG_SUPERPASS, type ClusterSpec } from './pg-cluster';

/**
 * The repository root, DERIVED from this file's own location.
 *
 * It was `cwd: '/home/user/daftar'`, hard-coded. The independent challenger
 * showed what that costs: in any other checkout the three spawned controls died
 * with `ERR_MODULE_NOT_FOUND` and the proof printed `3 CONTROL(S) FAILED` and
 * exit 1 — indistinguishable from three controls that genuinely failed. That is
 * the PART 18 law this round quotes elsewhere in its own words: "I could not
 * look" and "I looked and it is clean" must never print the same way, and the
 * inverse holds too — a proof that could not run must not print as a proof that
 * failed. It also meant the proof could not run on the final exact SHA anywhere
 * but one box, which is exactly where §79 requires it to run.
 */
const ROOT = resolve(__dirname, '../..');

/**
 * PER-RUN fixture credentials — coordinator F-13.
 *
 * These were four hard-coded literals (`p15app`, `p15rec`, `p15mig`,
 * `p15read`) while the handoff claimed "per-run fixture credentials" without
 * qualification, and the DR proof's fixture really is per-run. A password in
 * source is a password that outlives its run, gets copied into a second
 * script, and is eventually the one somebody reuses outside a disposable
 * cluster. The claim is the right one; the code was the half that was wrong,
 * so the code changed rather than the sentence.
 */
const pw = (label: string): string => `p15_${label}_${randomBytes(12).toString('hex')}`;
const PW = { app: pw('app'), rec: pw('rec'), mig: pw('mig'), read: pw('read') } as const;

const DIR = '/tmp/daftar-p15-roleread';
const PORT = 55487;
const spec: ClusterSpec = { dir: DIR, port: PORT, label: 'roleread' };

function psqlRun(sql: string): void {
  const r = spawnSync('/usr/lib/postgresql/16/bin/psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PG_SUPERPASS },
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr?.slice(0, 300) ?? ''}`);
}

function readAttributes(url: string): { status: number | null; out: string; spawned: boolean } {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/role-attribute-read.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P15_ROLE_READ_URL: url },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // A module that cannot be loaded is not a verdict about role attributes. The
  // check's own exit codes are 0 (clean), 1 (an unauthorised attribute) and 2
  // (not measured); anything else, or a loader error in the output, means the
  // control never ran and must be reported as such rather than as a failure.
  const spawned = r.error === undefined && r.status !== null && !/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION/.test(out);
  return { status: r.status, out, spawned };
}

function main(): number {
  prepareClusterDir(DIR);
  startCluster(spec);
  let failures = 0;
  let notRun = 0;
  try {
    psqlRun(`CREATE ROLE daftar_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${PW.app}'`);
    psqlRun(`CREATE ROLE daftar_reconciler LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${PW.rec}'`);
    psqlRun(`CREATE ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${PW.mig}'`);
    psqlRun(`CREATE ROLE p15_reader LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW.read}'`);
    const readerUrl = `postgresql://p15_reader:${PW.read}@127.0.0.1:${PORT}/postgres`;

    console.log('='.repeat(78));
    console.log('CONTROL 1 (POSITIVE) — clean roles, read by a NON-SUPERUSER: expect exit 0');
    const c1 = readAttributes(readerUrl);
    console.log(c1.out);
    const c1ok = c1.status === 0 && c1.out.includes('no UNAUTHORISED elevated attribute') && c1.out.includes('is_superuser=off') && c1.out.includes('daftar_reconciler holds BYPASSRLS');
    if (!c1.spawned) {
      console.log(`CONTROL 1: NOT MEASURED — the check could not be started (exit ${String(c1.status)}). This is NOT a failed control.`);
      notRun += 1;
    } else {
      console.log(`CONTROL 1: ${c1ok ? 'PASS' : 'FAIL'} (exit ${String(c1.status)})`);
      if (!c1ok) failures += 1;
    }

    console.log('='.repeat(78));
    console.log('CONTROL 2 (NEGATIVE) — plant BYPASSRLS on daftar_app: expect exit 1 naming it');
    psqlRun('ALTER ROLE daftar_app BYPASSRLS');
    const c2 = readAttributes(readerUrl);
    console.log(c2.out);
    const c2ok = c2.status === 1 && c2.out.includes('daftar_app holds BYPASSRLS') && c2.out.includes('IMMEDIATE BLOCKER');
    if (!c2.spawned) {
      console.log(`CONTROL 2: NOT MEASURED — the check could not be started (exit ${String(c2.status)}). This is NOT a failed control.`);
      notRun += 1;
    } else {
      console.log(`CONTROL 2: ${c2ok ? 'PASS' : 'FAIL'} (exit ${String(c2.status)})`);
      if (!c2ok) failures += 1;
    }

    console.log('='.repeat(78));
    console.log('CONTROL 3 (NEGATIVE) — plant CREATEROLE on the RECONCILER, whose BYPASSRLS is');
    console.log('authorised: the allow-list is per ATTRIBUTE, so this must still be caught.');
    psqlRun('ALTER ROLE daftar_app NOBYPASSRLS');
    psqlRun('ALTER ROLE daftar_reconciler CREATEROLE');
    const c3 = readAttributes(readerUrl);
    console.log(c3.out);
    const c3ok = c3.status === 1 && c3.out.includes('daftar_reconciler holds CREATEROLE') && c3.out.includes('daftar_reconciler holds BYPASSRLS');
    if (!c3.spawned) {
      console.log(`CONTROL 3: NOT MEASURED — the check could not be started (exit ${String(c3.status)}). This is NOT a failed control.`);
      notRun += 1;
    } else {
      console.log(`CONTROL 3: ${c3ok ? 'PASS' : 'FAIL'} (exit ${String(c3.status)})`);
      if (!c3ok) failures += 1;
    }

    console.log('='.repeat(78));
    console.log('CONTROL 4 — the read is genuinely READ ONLY: a write attempt under the same');
    console.log('connection settings must be refused BY THE SERVER, not by this code.');
    console.log('');
    console.log('  The first attempt at this control was WRONG and is kept here as the reason the');
    console.log('  control is shaped this way. It tried to CREATE TABLE in schema public, and the');
    console.log('  server refused with "permission denied for schema public" — a PRIVILEGE refusal,');
    console.log('  not a read-only refusal. It would have passed a looser assertion while proving');
    console.log('  nothing about read-only: when a different constraint stops the statement before');
    console.log('  the intended one, the test does not establish the intended law (PART 12). So the');
    console.log('  reader is first given a schema IT OWNS, where privilege cannot be the refuser,');
    console.log('  and only the read-only setting can refuse.');
    psqlRun('CREATE SCHEMA p15_reader_owned AUTHORIZATION p15_reader');
    // Positive half: with writes allowed, the statement must SUCCEED — otherwise
    // the negative half below would prove nothing.
    const allowed = spawnSync('/usr/lib/postgresql/16/bin/psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'p15_reader', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE p15_reader_owned.allowed_probe(x int)'], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: PW.read },
    });
    const canWriteWhenAllowed = allowed.status === 0;
    console.log(`  with writes allowed, the same role CAN create there: ${canWriteWhenAllowed ? 'yes' : 'NO — this control is invalid'}`);
    const w = spawnSync('/usr/lib/postgresql/16/bin/psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'p15_reader', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE p15_reader_owned.must_not_exist(x int)'], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: PW.read, PGOPTIONS: '-c default_transaction_read_only=on' },
    });
    const refusal = (w.stderr ?? '').trim().split('\n')[0] ?? '(nothing)';
    const refused = w.status !== 0 && /read-only transaction/i.test(`${w.stderr ?? ''}`);
    console.log(`  under default_transaction_read_only=on, the server said: ${refusal}`);
    const ok4 = canWriteWhenAllowed && refused;
    console.log(`CONTROL 4: ${ok4 ? 'PASS' : 'FAIL'} — the refusal must name a read-only transaction, not a privilege`);
    if (!ok4) failures += 1;
  } finally {
    stopCluster(spec);
  }
  console.log('='.repeat(78));
  // A FAILURE OUTRANKS AN UNMEASURED CONTROL — coordinator F-8.
  //
  // This returned 2 as soon as any control could not START, before it looked
  // at whether another control had FAILED. So a genuine failure travelled
  // under a "not measured" exit code, and the louder fact was the weaker one.
  // Both are now reported; the exit code carries the failure when there is
  // one, because a control that failed is a measurement and an exit 2 would
  // describe it as an absence of measurement.
  if (failures > 0 && notRun > 0) {
    console.log(`EXIT 1 — ${failures} CONTROL(S) FAILED, and separately ${notRun} control(s) could not be started.`);
    console.log('  The failure decides the exit code: it is a measurement, and reporting it as NOT');
    console.log('  MEASURED would hide a real defect behind an absence. The unstarted controls are');
    console.log('  named above and remain unmeasured — neither fact is folded into the other.');
    return 1;
  }
  if (notRun > 0) {
    console.log(`EXIT 2 — NOT MEASURED: ${notRun} control(s) could not be started, so this proof says nothing`);
    console.log('  about whether the check works. An unrunnable proof and a failing proof are');
    console.log('  different facts, and conflating them is what let a hard-coded path look like');
    console.log('  three real failures.');
    return 2;
  }
  console.log(failures === 0 ? 'ALL FOUR CONTROLS PASSED' : `${failures} CONTROL(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
