/**
 * P15 — POSTGRESQL VERSION COMPATIBILITY MATRIX
 * ==============================================
 *
 * The Master Continuous Mission says, verbatim: "A PG16 fixture does not prove
 * a PG18 estate without a compatibility matrix." This script is that matrix,
 * and it is built by EXECUTION on both lines rather than by reading release
 * notes, because the divergences this repository actually depends on are not
 * the ones a release note would highlight.
 *
 * ── Why this question is already live, not theoretical ─────────────────────
 *
 * Two of the divergences are already documented in this tree, each found the
 * hard way:
 *
 *   · `ON DELETE RESTRICT` reports its violation as SQLSTATE 23001 on
 *     PostgreSQL 18 and 23503 on 16 and 17. P3-AL-20 names it and T-14.4
 *     derives the expected code from `server_version_num` at run time
 *     (docs/PHASE_3_S2_CONTRACT.md:209, :1243).
 *
 *   · The planner chooses differently on the two lines. P2-S7 records the
 *     same code and the same data producing a green run and a red one with
 *     nothing changed in between, because CI runs 16 and the embedded test
 *     server runs 18 (docs/PHASE_2_S7_ACCEPTANCE.md:188).
 *
 * So the repository is ALREADY a two-line estate, and has been since Phase 2.
 * The question is not whether to support two lines but which line the evidence
 * is produced on and which line production runs — and those are not the same
 * answer today.
 *
 * ── What this script decides and what it does not ──────────────────────────
 *
 * It decides nothing about production. Which PostgreSQL line the estate runs
 * is an OWNER decision, and inventing one would be exactly the fabrication
 * the directive forbids. What this script produces is the evidence that
 * decision needs:
 *
 *   V1  the versions actually in play, each read from its own source
 *   V2  the version-conditional surface already in the tree
 *   V3  the frozen migration train, applied on BOTH lines from zero
 *   V4  the documented behavioural divergences, re-measured on both lines
 *   V5  the numeric claims the documents measured on 16 only, measured on both
 *
 * V3 is the one that settles "supported DB line" for the schema: a migration
 * train that applies on both lines is a schema that both lines accept. It is
 * not a claim that the APPLICATION behaves identically on both — V4 and V5
 * exist precisely because it does not.
 *
 * Exit 0 when every probe was measured on both lines and the migration train
 * applied on both. Exit 1 when a probe could not be measured, and exit 2 when
 * a divergence was measured that the tree does not already account for —
 * because that is a divergence nothing in the repository is ready for.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { runMigrations, MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';

const ROOT = resolve(__dirname, '../..');
const SERVER_OS_USER = 'postgres';
const SUPERPASS = `p15_matrix_${randomBytes(18).toString('base64url')}`;

/** The two lines this box can run, each with the binaries that can run it. */
interface Line {
  readonly name: string;
  readonly bin: string;
  readonly dir: string;
  readonly port: number;
  /** Set once the cluster is up and its version read FROM THE SERVER. */
  version?: string;
  versionNum?: number;
}

const LINES: Line[] = [
  { name: 'host tooling', bin: '/usr/lib/postgresql/16/bin', dir: '/tmp/daftar-p15-matrix-16', port: 55481 },
  { name: 'embedded test server', bin: join(ROOT, 'node_modules/@embedded-postgres/linux-x64/native/bin'), dir: '/tmp/daftar-p15-matrix-18', port: 55482 },
];

/* ── cluster plumbing (the server account cannot be root) ─────────────────── */

function sh(script: string): { status: number | null; stdout: string; stderr: string } {
  const r =
    userInfo().username === SERVER_OS_USER
      ? spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      : spawnSync('su', [SERVER_OS_USER, '-s', '/bin/bash', '-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function chownToServer(path: string): void {
  if (userInfo().username === SERVER_OS_USER) return;
  const uid = Number(spawnSync('id', ['-u', SERVER_OS_USER], { encoding: 'utf8' }).stdout.trim());
  const gid = Number(spawnSync('id', ['-g', SERVER_OS_USER], { encoding: 'utf8' }).stdout.trim());
  chownSync(path, uid, gid);
}

function start(line: Line): void {
  rmSync(line.dir, { recursive: true, force: true });
  mkdirSync(line.dir, { recursive: true });
  chmodSync(line.dir, 0o755);
  chownToServer(line.dir);
  const data = join(line.dir, 'data');
  const pw = join(line.dir, 'superuser.pw');
  writeFileSync(pw, `${SUPERPASS}\n`, { mode: 0o600 });
  chownToServer(pw);
  const init = sh(`${line.bin}/initdb -D ${data} -U postgres --auth=md5 --pwfile=${pw} -E UTF8 --locale=C`);
  if (init.status !== 0) throw new Error(`initdb (${line.name}): ${init.stderr.slice(0, 400)}`);
  // fsync off: these clusters are disposable and no durability claim is made
  // from them. The matrix measures BEHAVIOUR, never timing — a timing claim
  // from an fsync-off cluster would be worthless and none is made here.
  writeFileSync(join(line.dir, 'extra.conf'), [`port = ${line.port}`, "listen_addresses = '127.0.0.1'", 'fsync = off', 'full_page_writes = off', ''].join('\n'));
  const appended = sh(`cat ${join(line.dir, 'extra.conf')} >> ${join(data, 'postgresql.conf')}`);
  if (appended.status !== 0) throw new Error(`conf (${line.name}): ${appended.stderr.slice(0, 300)}`);
  const up = sh(`${line.bin}/pg_ctl -D ${data} -l ${join(line.dir, 'server.log')} -w start`);
  if (up.status !== 0) {
    const log = existsSync(join(line.dir, 'server.log')) ? readFileSync(join(line.dir, 'server.log'), 'utf8').slice(-800) : '(no log)';
    throw new Error(`pg_ctl start (${line.name}): ${up.stderr.slice(0, 300)}\n${log}`);
  }
}

function stop(line: Line): void {
  const data = join(line.dir, 'data');
  if (existsSync(join(data, 'PG_VERSION'))) sh(`${line.bin}/pg_ctl -D ${data} -m immediate -w stop`);
  rmSync(line.dir, { recursive: true, force: true });
}

const url = (line: Line, db = 'postgres'): string => `postgresql://postgres:${SUPERPASS}@127.0.0.1:${line.port}/${db}`;

/** One query on one line. Returns the rows, or the SQLSTATE of the refusal. */
async function probe(line: Line, db: string, sql: string): Promise<{ readonly ok: boolean; readonly rows: unknown[]; readonly code: string; readonly message: string }> {
  const c = new Client({ connectionString: url(line, db) });
  try {
    await c.connect();
    const r = await c.query(sql);
    return { ok: true, rows: Array.isArray(r) ? [] : r.rows, code: '', message: '' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, rows: [], code: err.code ?? '(none)', message: (err.message ?? '').slice(0, 220) };
  } finally {
    await c.end().catch(() => undefined);
  }
}

/* ── the matrix ───────────────────────────────────────────────────────────── */

type Status = 'MEASURED' | 'DIVERGENT_UNACCOUNTED' | 'UNMEASURED';

interface Row {
  readonly id: string;
  readonly question: string;
  /** line name → what that line answered */
  readonly answers: Record<string, string>;
  status: Status;
  readonly note: string[];
}

const rows: Row[] = [];
const row = (id: string, question: string): Row => {
  const r: Row = { id, question, answers: {}, status: 'UNMEASURED', note: [] };
  rows.push(r);
  return r;
};

/** A probe whose two answers must agree; disagreement is the finding. */
function settle(r: Row, accountedFor: boolean): void {
  const values = Object.values(r.answers);
  if (values.length < LINES.length || values.some((v) => v.startsWith('UNMEASURED'))) {
    r.status = 'UNMEASURED';
    return;
  }
  const agree = new Set(values).size === 1;
  r.status = agree || accountedFor ? 'MEASURED' : 'DIVERGENT_UNACCOUNTED';
}

/* V2 — the version-conditional surface, read from the tree, not guessed. */
function v2(): void {
  const r = row('V2', 'What in this tree already branches on the server version?');
  const hits: string[] = [];
  const walk = (rel: string): void => {
    const full = join(ROOT, rel);
    if (!existsSync(full)) return;
    const out = spawnSync('grep', ['-rn', '--include=*.ts', '--include=*.sql', 'server_version_num', full], { encoding: 'utf8' });
    for (const line of (out.stdout ?? '').split('\n')) {
      if (line.trim().length === 0) continue;
      const rel2 = line.replace(`${ROOT}/`, '');
      // THIS FILE is excluded. A probe that counts its own prose among its
      // subjects is not measuring the tree, it is measuring itself — and the
      // first run of this probe reported 9 sites, 6 of which were these
      // comments. The subject of V2 is the tree's version-conditional code.
      if (rel2.startsWith('scripts/phase15/pg-version-matrix.ts')) continue;
      hits.push(rel2.slice(0, 170));
    }
  };
  for (const d of ['apps', 'packages', 'tests', 'scripts', 'infrastructure']) walk(d);
  if (hits.length === 0) {
    r.note.push('NOT MEASURED: grep returned nothing, which for a tree that documents two such divergences is a failure of this probe, not an absence of them');
    r.status = 'UNMEASURED';
    return;
  }
  for (const h of hits) r.note.push(h);
  for (const l of LINES) r.answers[l.name] = `${hits.length} version-conditional site(s) (the same source file serves both lines)`;
  r.note.push('a version-conditional branch is the tree ACCOUNTING for a divergence; the divergences below are checked against this list');
  const inApp = hits.filter((h) => h.startsWith('apps/') || h.startsWith('packages/'));
  if (inApp.length === 0) {
    r.note.push(
      'every one of these sites is in a TEST. The application and the schema carry no version branch at all, so whatever version-dependent behaviour they rely on is relied on implicitly: the tests know the two lines differ and the code they test does not. That is the right place for the knowledge when the difference is only in which refusal code a test expects, and the wrong place if a difference ever reaches a decision the application makes.',
    );
  } else {
    r.note.push(`${inApp.length} of these sites are in application code, not tests: ${inApp.join(' | ').slice(0, 300)}`);
  }
  r.status = 'MEASURED';
}

/* V3 — the frozen migration train, from zero, on both lines. */
async function v3(): Promise<void> {
  const r = row('V3', 'Does the frozen migration train apply from zero on both lines?');
  const expected = Number(spawnSync('bash', ['-c', `ls ${join(ROOT, 'infrastructure/database/migrations')}/*.sql | wc -l`], { encoding: 'utf8' }).stdout.trim());
  r.note.push(`${expected} migration files on disk; bootstrap.sql then the application's own runMigrations, not a hand-rolled loop`);
  for (const line of LINES) {
    const create = await probe(line, 'postgres', "CREATE DATABASE daftar TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");
    if (!create.ok) {
      r.answers[line.name] = `UNMEASURED: CREATE DATABASE refused (${create.code})`;
      r.note.push(`${line.name}: ${create.message}`);
      continue;
    }
    // The train grants to the roles bootstrap.sql creates, so bootstrap runs
    // first. PART 103: every fixture credential is minted per run, so no
    // secret-like literal enters the tree to be scanned or allowlisted.
    const boot = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8').replace(/__([A-Z_]+)_PASSWORD__/g, () => `p15_${randomBytes(18).toString('base64url')}`);
    const bootApplied = await probe(line, 'daftar', boot);
    if (!bootApplied.ok) {
      r.answers[line.name] = `UNMEASURED: bootstrap.sql refused (${bootApplied.code})`;
      r.note.push(`${line.name}: ${bootApplied.message}`);
      continue;
    }
    try {
      const applied = await runMigrations(url(line, 'daftar'), MIGRATIONS_DIR);
      // Idempotence on the same line: a second run must apply nothing.
      const again = await runMigrations(url(line, 'daftar'), MIGRATIONS_DIR);
      r.answers[line.name] = `${applied.length} applied, ${again.length} on a second run`;
      if (applied.length !== expected) r.note.push(`${line.name}: applied ${applied.length} of ${expected} files — the train did not complete`);
      if (again.length !== 0) r.note.push(`${line.name}: a second run applied ${again.length} migration(s) — the train is not idempotent on this line`);
    } catch (e) {
      r.answers[line.name] = `UNMEASURED: the train aborted`;
      r.note.push(`${line.name}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  settle(r, false);
  if (r.status === 'MEASURED' && new Set(Object.values(r.answers)).size === 1) {
    r.note.push(`the schema is accepted by both lines: identical outcome, ${Object.values(r.answers)[0]}`);
  }
}

/* V4 — the divergences the tree documents, re-measured rather than quoted. */
async function v4(): Promise<void> {
  const r = row('V4', 'ON DELETE RESTRICT: which SQLSTATE does each line report?');
  r.note.push('documented as 23001 on 18 and 23503 on 16–17 (docs/PHASE_3_S2_CONTRACT.md:209); T-14.4 derives it from server_version_num, so the tree ACCOUNTS for this one');
  for (const line of LINES) {
    const setup = await probe(
      line,
      'postgres',
      `DROP TABLE IF EXISTS p15_child, p15_parent CASCADE;
       CREATE TABLE p15_parent (id int PRIMARY KEY);
       CREATE TABLE p15_child (id int PRIMARY KEY, parent int REFERENCES p15_parent(id) ON DELETE RESTRICT);
       INSERT INTO p15_parent VALUES (1); INSERT INTO p15_child VALUES (1, 1);`,
    );
    if (!setup.ok) {
      r.answers[line.name] = `UNMEASURED: fixture refused (${setup.code})`;
      continue;
    }
    const del = await probe(line, 'postgres', 'DELETE FROM p15_parent WHERE id = 1');
    r.answers[line.name] = del.ok ? 'ACCEPTED THE DELETE (no refusal at all)' : del.code;
    if (del.ok) r.note.push(`${line.name}: the RESTRICT template did not refuse — that is a far larger problem than a code difference`);
  }
  // Accounted for: the tree derives the code at run time.
  settle(r, true);
  const v = Object.values(r.answers);
  if (new Set(v).size > 1) r.note.push(`measured divergence confirmed: ${LINES.map((l) => `${l.version ?? l.name} → ${r.answers[l.name] ?? '?'}`).join(', ')}`);
  else r.note.push(`the two lines AGREED (${v[0] ?? '?'}) — the run-time derivation is still correct, but on these two servers it selects the same answer`);
}

/* V5 — the numeric claims the documents measured on PostgreSQL 16 only. */
async function v5(): Promise<void> {
  const cases: readonly { readonly id: string; readonly question: string; readonly sql: string; readonly documented: string }[] = [
    {
      id: 'V5a',
      question: 'NUMERIC(18,4) fills every value to four places, so scale() is 4 for 1 as for 0.5',
      sql: "SELECT (SELECT scale(1::numeric(18,4)))::text || '/' || (SELECT scale(0.5::numeric(18,4)))::text AS v",
      documented: '4/4 (docs/DAFTAR_INVENTORY_RULES.md:19, measured on 16)',
    },
    {
      id: 'V5b',
      question: 'The average is a rounded quotient: 3 × (1/3 at NUMERIC(28,10)) is not 1',
      sql: "SELECT (round(1::numeric / 3, 10))::text || '/' || (3 * round(1::numeric / 3, 10))::text AS v",
      documented: '0.3333333333/0.9999999999 (docs/PHASE_3_ARCHITECTURE_LOCK.md:166, measured on 16)',
    },
    {
      id: 'V5c',
      question: 'Rounding is not additive: two operations of 0.6 give 2 while rounding their sum gives 1',
      sql: "SELECT (round(0.6) + round(0.6))::text || '/' || (round(0.6 + 0.6))::text AS v",
      documented: '2/1 (docs/PHASE_3_PREMORTEM.md:437, measured on 16)',
    },
    {
      id: 'V5d',
      question: 'Integer minor units: a bigint sum of minor units never acquires a fraction',
      sql: "SELECT (sum(x)::text) AS v FROM (VALUES (1::bigint), (2), (-3), (9223372036854775000)) t(x)",
      documented: 'an exact integer on any line (the directive’s INTEGER MINOR UNITS ONLY law)',
    },
  ];
  for (const c of cases) {
    const r = row(c.id, c.question);
    r.note.push(`documented: ${c.documented}`);
    for (const line of LINES) {
      const got = await probe(line, 'postgres', c.sql);
      r.answers[line.name] = got.ok ? String((got.rows[0] as { v?: string } | undefined)?.v ?? '(no row)') : `UNMEASURED: ${got.code}`;
    }
    // These are claims the documents state WITHOUT a version qualifier, so a
    // divergence here is one the tree does NOT account for.
    settle(r, false);
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */

async function main(): Promise<number> {
  console.log('P15 — POSTGRESQL VERSION COMPATIBILITY MATRIX');
  console.log('='.repeat(78));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const clean = dirty.status === 0 && (dirty.stdout ?? '').trim() === '';
  console.log(`measured at: ${head.status === 0 ? head.stdout.trim() : 'UNKNOWN'}${clean ? '' : ' PLUS UNCOMMITTED CHANGES (this matrix names no commit)'}`);
  console.log('');

  /* V1 — the versions in play, each from its own source. */
  const v1 = row('V1', 'Which PostgreSQL versions is this project actually using?');
  const declared = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }) ?? {};
  const emb = declared.devDependencies?.['embedded-postgres'] ?? declared.dependencies?.['embedded-postgres'] ?? '(not declared)';
  v1.note.push(`package.json declares embedded-postgres ${emb}`);
  const ciImage = /image:\s*(postgres:[^\s]+)/.exec(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'))?.[1];
  v1.note.push(`CI's database service image: ${ciImage ?? '(not found in .github/workflows/ci.yml)'}`);
  if (ciImage && !/postgres:\d+\.\d+/.test(ciImage)) {
    v1.note.push(
      `    ! ${ciImage} is a FLOATING tag: it resolves to whatever the latest in that line is at pull time, so the server version behind every CI verdict is chosen by the registry and not by this repository. This tree already documents that a server-version change flips an SQLSTATE (P3-AL-20) and flips a planner choice between a green run and a red one (P2-S7), so the version is load-bearing for CI's own evidence. Pinning it to a patch version, or asserting server_version_num in the job, would make the DB version part of the evidence instead of part of the weather.`,
    );
  }

  let started = 0;
  try {
    for (const line of LINES) {
      if (!existsSync(join(line.bin, 'initdb'))) {
        v1.note.push(`${line.name}: no initdb at ${line.bin} — this line cannot be measured on this box`);
        continue;
      }
      start(line);
      started += 1;
      const got = await probe(line, 'postgres', "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS num");
      const got0 = got.rows[0] as { version?: string; num?: string } | undefined;
      line.version = got0?.version ?? 'UNKNOWN';
      line.versionNum = Number(got0?.num ?? 0);
      v1.answers[line.name] = `${line.version} (server_version_num ${line.versionNum}), binaries ${line.bin}`;
      v1.note.push(`${line.name}: running, port ${line.port}, version read FROM THE SERVER`);
    }
    v1.status = started === LINES.length ? 'MEASURED' : 'UNMEASURED';
    if (started < LINES.length) {
      v1.note.push(`only ${started} of ${LINES.length} lines could be started, so nothing below is a two-line measurement`);
    }

    if (started === LINES.length) {
      const nums = LINES.map((l) => l.versionNum ?? 0);
      if (new Set(nums).size === 1) {
        v1.note.push(`! both lines report the SAME version (${nums[0]}): this box cannot produce a two-line matrix today, and nothing below should be read as one`);
        v1.status = 'UNMEASURED';
      }
      v2();
      await v3();
      await v4();
      await v5();
    }
  } finally {
    for (const line of LINES) {
      try {
        stop(line);
      } catch {
        /* a disposable cluster that will not die is not a verdict */
      }
    }
  }

  for (const r of rows) {
    console.log('-'.repeat(78));
    console.log(`${r.id}  ${r.status.padEnd(22)} ${r.question}`);
    for (const line of LINES) {
      const a = r.answers[line.name];
      if (a !== undefined) console.log(`     ${(line.version ?? line.name).padEnd(22)} ${a}`);
    }
    for (const n of r.note) console.log(`     · ${n}`);
  }
  console.log('-'.repeat(78));
  const unmeasured = rows.filter((r) => r.status === 'UNMEASURED');
  const unaccounted = rows.filter((r) => r.status === 'DIVERGENT_UNACCOUNTED');
  console.log(`${rows.length} probes: ${rows.length - unmeasured.length - unaccounted.length} MEASURED, ${unaccounted.length} DIVERGENT AND UNACCOUNTED FOR, ${unmeasured.length} UNMEASURED`);
  console.log('');
  console.log('WHAT THIS MATRIX DOES NOT DECIDE');
  console.log('  Which PostgreSQL line the production estate runs is an OWNER decision.');
  console.log('  This matrix is the evidence for it, not the answer to it: inventing a');
  console.log('  supported line here would be the fabrication the directive forbids.');
  console.log('  What the evidence supports is stated above, per probe, per line.');
  if (unaccounted.length > 0) {
    console.log('');
    console.log(`EXIT 2: ${unaccounted.map((r) => r.id).join(', ')} diverged between the two lines and the tree has no version-conditional branch for it.`);
    return 2;
  }
  if (unmeasured.length > 0) {
    console.log('');
    console.log(`EXIT 1: ${unmeasured.map((r) => r.id).join(', ')} not measured on both lines.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`the matrix could not be produced: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
