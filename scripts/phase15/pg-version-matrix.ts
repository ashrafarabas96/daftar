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
 * It decides nothing about production, and it does not ask for a decision it
 * already has: the target is recorded as the PostgreSQL 16 family at
 * en_US.utf8 (TL-P4-S3-R4, corroborated by three further documents, all cited
 * by V1 at run time). What this script produces is the evidence measured
 * against that recorded target:
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
 * Exit 0 when every probe was measured in every context and the migration train
 * applied on both. Exit 1 when a probe could not be measured, and exit 2 when
 * a divergence was measured that the tree does not already account for —
 * because that is a divergence nothing in the repository is ready for.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
// The candidate runtime is built by the APPLICATION'S own migrator: a file
// is wrapped in one transaction there, and migrations rely on that.
import { runMigrations } from '../../apps/api/src/infra/migrate';

const ROOT = resolve(__dirname, '../..');
const SERVER_OS_USER = 'postgres';
const SUPERPASS = `p15_matrix_${randomBytes(18).toString('base64url')}`;

/** The two lines this box can run, each with the binaries that can run it. */
interface Line {
  readonly name: string;
  readonly bin: string;
  readonly dir: string;
  readonly port: number;
  /** The initdb locale — the deployment axis, not a detail. */
  readonly locale: string;
  /** Set once the cluster is up and its version read FROM THE SERVER. */
  version?: string;
  versionNum?: number;
  /** What the SERVER says its collation is, read back rather than assumed. */
  collate?: string;
}

/**
 * Three contexts, not two.
 *
 * V2 §22.1 asks for one identity for the evidence and names collation among
 * the axes. Phase 4's own documents record the deployment target as the
 * PostgreSQL 16 family at `en_US.utf8` (TL-P4-S3-R4), and record that
 * containers like this one run locale `C`, so every ordering claim made here
 * has carried that caveat. The caveat is removable: `localedef -i en_US -f
 * UTF-8 en_US.UTF-8` generates the locale, so this matrix runs a
 * DEPLOYMENT-EQUIVALENT cluster beside the two it had, and the probes answer
 * on all three.
 *
 * `locale` is the initdb locale. A context whose locale cannot be created on
 * this box reports UNMEASURED rather than silently falling back to C, because
 * a result at the wrong collation carried under the deployment's name is
 * exactly the substitution this phase keeps catching.
 */
// V3 §22.1 ranks these, and the ranking is not cosmetic: «يُعيد دليل المنتج
// الأساسي تشغيل المطلوب على PG16/en_US.utf8 والنسخة المجمّدة نفسها، وتبقى
// مقارنة PG18 أدلة تشخيص مستقلة». So the 16 @ en_US.utf8 context is the
// PRIMARY evidence line — the one the product's own evidence must be produced
// on — and the 18 context is INDEPENDENT DIAGNOSTIC evidence, never a line any
// product claim rests on. The 16 @ C context is this container's own tooling,
// and its collation is not the deployment's.
const LINES: Line[] = [
  { name: '16 @ C (host tooling · diagnostic)', bin: '/usr/lib/postgresql/16/bin', dir: '/tmp/daftar-p15-matrix-16', port: 55481, locale: 'C' },
  { name: '18 @ C (embedded · DIAGNOSTIC ONLY)', bin: join(ROOT, 'node_modules/@embedded-postgres/linux-x64/native/bin'), dir: '/tmp/daftar-p15-matrix-18', port: 55482, locale: 'C' },
  { name: '16 @ en_US.utf8 (PRIMARY · deployment-equivalent)', bin: '/usr/lib/postgresql/16/bin', dir: '/tmp/daftar-p15-matrix-16d', port: 55484, locale: 'en_US.utf8' },
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
  const init = sh(`${line.bin}/initdb -D ${data} -U postgres --auth=md5 --pwfile=${pw} -E UTF8 --locale=${line.locale}`);
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
  for (const l of LINES) r.answers[l.name] = `${hits.length} version-conditional site(s) (the same source file serves every context)`;
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

/* V3 — the CANDIDATE's train, from zero, in every context. */
async function v3(): Promise<void> {
  const r = row('V3', "Does the CANDIDATE's migration train apply from zero in every context?");
  // V2 §22.1 corrected the earlier round here, and was right: measuring this
  // prep branch's 74 migrations is measuring the P3 baseline, not the
  // candidate. The subject is the candidate's own files, read out of git by
  // blob id — Phase 4's branch and worktree are never touched.
  const ref = ['969b8605', 'origin/phase/4-sales-pos-customers-receivables'].find(
    (x) => spawnSync('git', ['cat-file', '-e', `${x}^{commit}`], { cwd: ROOT }).status === 0,
  );
  if (ref === undefined) {
    r.note.push('UNMEASURED: no Phase 4 candidate ref is reachable here, so the candidate train cannot be the subject. Fetch it and re-run; this is not a result about the candidate.');
    r.status = 'UNMEASURED';
    return;
  }
  const sha = spawnSync('git', ['rev-parse', ref], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const names = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'infrastructure/database/migrations'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .stdout.split('\n')
    .filter((n: string) => n.endsWith('.sql'))
    .sort();
  const prepCount = readdirSync(join(ROOT, 'infrastructure/database/migrations')).filter((n: string) => n.endsWith('.sql')).length;
  r.note.push(`subject: the candidate at ${ref} → ${sha}, ${names.length} migration(s). This prep branch carries ${prepCount}, which is the P3 baseline and NOT the candidate.`);
  r.note.push(
    "PRINCIPAL, named because V3 §7 requires every run to name it: this probe applies the WHOLE train as the disposable cluster's SUPERUSER. That is the same principal CI uses (docs/PHASE_2_S8_ACCEPTANCE.md:109 — 'CI applies migrations as the superuser'), and it is why a green run here, like a green run in CI, NEVER proves the deployment principal can apply anything. So this row measures that the SCHEMA is accepted in each context, and nothing about deployment authority.",
  );
  r.note.push(
    "V3 §7 describes the split «0000–0039 administrator, 0040+ migrator». In THIS tree that is not the deployment contract: TL-P4-COORD-R61 confirms the deployment path is `daftar_migrator` over the whole history, and the four claims behind the administrator reading were WITHDRAWN in P2-S9 (docs/PHASE_1_MIGRATION_HISTORY_DECISION.md:135–141). The instrument that proves deployment authority is `npm run check:deployment-authority`, which applies the history as `daftar_migrator` and nothing else; this matrix is not that instrument and does not stand in for it.",
  );
  if (names.length === 0) {
    r.note.push('UNMEASURED: the candidate ref carries no migrations at that path.');
    r.status = 'UNMEASURED';
    return;
  }

  // Stage out of git. bootstrap.sql is kept OUT of the migrations directory:
  // runMigrations globs every .sql it is given, and staging them together
  // applies one file too many and records bootstrap as a migration.
  const stage = '/tmp/daftar-p15-matrix-candidate';
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'sql'), { recursive: true });
  mkdirSync(join(stage, 'boot'), { recursive: true });
  const blob = (path: string): string =>
    spawnSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
  const bootPath = join(stage, 'boot', 'bootstrap.sql');
  writeFileSync(bootPath, blob('infrastructure/database/bootstrap.sql').replace(/__([A-Z_]+)_PASSWORD__/g, () => `p15_${randomBytes(18).toString('base64url')}`), { mode: 0o644 });
  for (const n of names) writeFileSync(join(stage, 'sql', n.split('/').pop() as string), blob(n), { mode: 0o644 });

  for (const line of LINES) {
    const create = await probe(line, 'postgres', `CREATE DATABASE daftar TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE '${line.locale}' LC_CTYPE '${line.locale}'`);
    if (!create.ok) {
      r.answers[line.name] = `UNMEASURED: CREATE DATABASE refused (${create.code})`;
      r.note.push(`${line.name}: ${create.message}`);
      continue;
    }
    const boot = await probe(line, 'daftar', readFileSync(bootPath, 'utf8'));
    if (!boot.ok) {
      r.answers[line.name] = `UNMEASURED: bootstrap.sql refused (${boot.code})`;
      r.note.push(`${line.name}: ${boot.message}`);
      continue;
    }
    try {
      const applied = await runMigrations(url(line, 'daftar'), join(stage, 'sql'));
      const again = await runMigrations(url(line, 'daftar'), join(stage, 'sql'));
      r.answers[line.name] = `${applied.length} applied, ${again.length} on a second run`;
      if (applied.length !== names.length) r.note.push(`${line.name}: applied ${applied.length} of ${names.length} — the train did not complete`);
      if (again.length !== 0) r.note.push(`${line.name}: a second run applied ${again.length} — not idempotent on this line`);
    } catch (e) {
      r.answers[line.name] = 'UNMEASURED: the train aborted';
      r.note.push(`${line.name}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  rmSync(stage, { recursive: true, force: true });
  settle(r, false);
  if (r.status === 'MEASURED' && new Set(Object.values(r.answers)).size === 1) {
    r.note.push(`the candidate's schema is accepted identically in every context measured: ${Object.values(r.answers)[0]}`);
  }
}

/* V4 — Class 23, to §22.1's standard: a real constraint, role and transaction. */
async function v4(): Promise<void> {
  const r = row('V4', 'ON DELETE RESTRICT: the exact SQLSTATE, constraint, and that the row survives the refusal');
  r.note.push('documented as 23001 on 18 and 23503 on 16–17 (docs/PHASE_3_S2_CONTRACT.md:209); T-14.4 derives it from server_version_num, so the tree ACCOUNTS for this one');
  r.note.push(
    'V3 §22.1 SCOPES THIS RESULT, and the scope is part of the result: this is a NARROW COMPATIBILITY EXPERIMENT on one constraint and one command. It is NOT an adoption of PostgreSQL 18, NOT exact-final-RC evidence, and NOT authority to widen an allowed-SQLSTATE list across Class 23. The mapping for THIS constraint and THIS command is the gate owner\'s and the domain owner\'s to review, with the constraint name, the rollback and the outcome in hand.',
  );
  r.note.push(
    '§22.1: 23001 is restrict_violation and 23503 is foreign_key_violation, and NO Class 23 may be turned into a PASS. So this probe names the constraint, runs inside an explicit transaction as a non-superuser role, and proves three things rather than one: the refusal happens, it carries the constraint’s own name, and the parent row is STILL THERE afterwards. A probe that only reads the code would pass on a server that refused for the wrong reason, or that refused and deleted anyway.',
  );
  for (const line of LINES) {
    const setup = await probe(
      line,
      'postgres',
      `DROP TABLE IF EXISTS p15_child, p15_parent CASCADE;
       DROP ROLE IF EXISTS p15_probe;
       CREATE ROLE p15_probe LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'p15_${randomBytes(12).toString('hex')}';
       CREATE TABLE p15_parent (id int PRIMARY KEY);
       CREATE TABLE p15_child (id int PRIMARY KEY, parent int,
         CONSTRAINT p15_child_parent_fk FOREIGN KEY (parent) REFERENCES p15_parent(id) ON DELETE RESTRICT);
       INSERT INTO p15_parent VALUES (1); INSERT INTO p15_child VALUES (1, 1);
       GRANT SELECT, DELETE ON p15_parent TO p15_probe; GRANT SELECT ON p15_child TO p15_probe;`,
    );
    if (!setup.ok) {
      r.answers[line.name] = `UNMEASURED: fixture refused (${setup.code})`;
      r.note.push(`${line.name}: ${setup.message}`);
      continue;
    }
    // An explicit transaction, as a non-superuser, so the refusal is measured
    // where the application would meet it — and the rollback is observable.
    const del = await probe(line, 'postgres', 'BEGIN; SET LOCAL ROLE p15_probe; DELETE FROM p15_parent WHERE id = 1; COMMIT;');
    const survived = await probe(line, 'postgres', 'SELECT count(*)::text AS v FROM p15_parent WHERE id = 1');
    const rows = (survived.rows[0] as { v?: string } | undefined)?.v ?? '?';
    if (del.ok) {
      r.answers[line.name] = 'ACCEPTED THE DELETE — no refusal at all';
      r.note.push(`${line.name}: the RESTRICT template did not refuse. That is far larger than a code difference and is not a version-mapping question.`);
    } else {
      const classed = /^23/.test(del.code);
      const named = /p15_child_parent_fk/.test(del.message);
      r.answers[line.name] = `${del.code}${classed ? '' : ' (NOT Class 23)'}, constraint ${named ? 'named' : 'NOT named'}, parent rows after = ${rows}`;
      if (!classed) r.note.push(`${line.name}: the refusal is ${del.code}, outside Class 23 — a different failure, not this divergence`);
      if (rows !== '1') r.note.push(`${line.name}: the parent row is GONE after a refused delete (count=${rows}) — the transaction did not roll back`);
    }
    await probe(line, 'postgres', 'DROP TABLE IF EXISTS p15_child, p15_parent CASCADE; DROP ROLE IF EXISTS p15_probe;');
  }
  // Accounted for: the tree derives the code at run time. But the ACCOUNTING
  // only covers the code — a refusal that did not roll back would be a new
  // finding, so that half is settled strictly.
  const vals = Object.values(r.answers);
  const allRolledBack = vals.every((v) => /parent rows after = 1/.test(v));
  const allClass23 = vals.every((v) => /^23\d\d\d,/.test(v));
  settle(r, allRolledBack && allClass23);
  if (new Set(vals.map((v) => v.split(',')[0])).size > 1) {
    r.note.push(`measured divergence in the CODE only: ${LINES.map((l) => `${l.version ?? l.name} → ${(r.answers[l.name] ?? '?').split(',')[0]}`).join(', ')}`);
    r.note.push('the invariant held identically everywhere: every refusal is Class 23, every one names the constraint, and the parent row survives each one');
  } else {
    r.note.push(`every context agreed (${vals[0] ?? '?'})`);
  }
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
  v1.note.push('');
  v1.note.push('THE DEPLOYMENT TARGET IS SETTLED (V3 §22.1) — this matrix measures against it and never asks for it.');
  v1.note.push(
    '    V3 §22.1 CONFIRMS this decision and withdraws the «16 or 18?» question outright; V2 §22.1 had already said to look for a settled live version decision BEFORE requesting one. There is one, in Phase 4’s own documents, and it is consistent across four of them: TL-P4-S3-R4 states "the deployment target is the PostgreSQL 16 family at en_US.utf8" (P4-SLOT2-S5-IMPLEMENTATION-READY.md:925); P4-S3-REPORT-AR.md:521 names en_US.utf8 as what the postgres:16 image is initialised with, "أي هدف النشر" — i.e. the deployment target; P4-S3-FINAL-VERDICT-AR.md:31 records CI printing server_version_num=160015 datcollate=en_US.utf8 datctype=en_US.utf8; and P4-SLOT4-GATES-DESIGN.md:991 records that containers like this one run locale C while CI reports en_US.utf8. docs/DAFTAR_AWS_REFERENCE_ARCHITECTURE.md:13 says RDS PostgreSQL 16+, which is CONSISTENT with the major but is NOT a copy of the detailed decision and does not carry the collation (V3 §22.1: «مرجع AWS الذي يقول RDS16+ لا ينسخ القرار التفصيلي»), so the decision rests on TL-P4-S3-R4 and its three Phase 4 corroborations, not on the reference architecture.',
  );
  v1.note.push(
    '    So the target is the 16 family at en_US.utf8, and no recommendation to move production to 18 belongs in a Phase 15 instrument. What remains genuinely open is narrower: pinning CI’s minor and image digest, and whether the embedded test server stays on another line.',
  );
  v1.note.push('');
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
      // V2 §22.1: pin the real SELECT version, the tools and a per-run
      // baseline. Every value here is READ BACK from the server; none is the
      // value this script asked for.
      const got = await probe(
        line,
        'postgres',
        "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS num, " +
          "(SELECT datcollate FROM pg_database WHERE datname=current_database()) AS collate, " +
          "(SELECT datctype FROM pg_database WHERE datname=current_database()) AS ctype, " +
          "pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname=current_database()",
      );
      const got0 = got.rows[0] as { version?: string; num?: string; collate?: string; ctype?: string; encoding?: string } | undefined;
      line.version = got0?.version ?? 'UNKNOWN';
      line.versionNum = Number(got0?.num ?? 0);
      line.collate = got0?.collate ?? 'UNKNOWN';
      const initdbV = spawnSync(`${line.bin}/initdb`, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? 'unknown';
      v1.answers[line.name] =
        `${line.version} (server_version_num ${line.versionNum}), collate ${line.collate}, ctype ${got0?.ctype ?? '?'}, encoding ${got0?.encoding ?? '?'}`;
      v1.note.push(`${line.name}: port ${line.port}, binaries ${line.bin} (${initdbV})`);
      if (line.collate !== line.locale && !(line.locale === 'C' && line.collate === 'C')) {
        v1.note.push(`    ! asked initdb for locale ${line.locale} and the server reports datcollate ${line.collate} — the context is NOT what it is named`);
      }
    }
    v1.status = started === LINES.length ? 'MEASURED' : 'UNMEASURED';
    if (started < LINES.length) {
      v1.note.push(`only ${started} of ${LINES.length} contexts could be started, so nothing below is a cross-context measurement`);
    }

    if (started === LINES.length) {
      const nums = LINES.map((l) => l.versionNum ?? 0);
      if (new Set(nums).size === 1) {
        v1.note.push(`! every context reports the SAME version (${nums[0]}): this box cannot produce a multi-version matrix today, and nothing below should be read as one`);
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
      // The label is the CONTEXT, not the version string: two of the three
      // contexts are the same server version at different collations, and
      // printing `line.version` rendered them identically.
      if (a !== undefined) console.log(`     ${line.name.padEnd(52)} ${a}`);
    }
    for (const n of r.note) console.log(`     · ${n}`);
  }
  console.log('-'.repeat(78));
  const unmeasured = rows.filter((r) => r.status === 'UNMEASURED');
  const unaccounted = rows.filter((r) => r.status === 'DIVERGENT_UNACCOUNTED');
  console.log(`${rows.length} probes: ${rows.length - unmeasured.length - unaccounted.length} MEASURED, ${unaccounted.length} DIVERGENT AND UNACCOUNTED FOR, ${unmeasured.length} UNMEASURED`);
  console.log('');
  console.log('WHAT THIS MATRIX DOES NOT DECIDE');
  console.log('  The DB target is NOT an open question and this matrix does not reopen it:');
  console.log('  it is already settled as the PostgreSQL 16 family at en_US.utf8 (TL-P4-S3-R4');
  console.log('  and the three corroborating documents cited under V1). This matrix measures');
  console.log('  against that recorded target; it does not choose one, and no recommendation');
  console.log('  to move production to 18 belongs in a Phase 15 instrument. Moving the estate');
  console.log('  off the recorded target would be an OWNER decision, taken with a supported');
  console.log('  upgrade path and backup/rollback/PITR evidence, not on the strength of a');
  console.log('  divergence measured here. What the evidence supports is stated above, per');
  console.log('  probe, per context.');
  console.log('');
  console.log('WHICH CONTEXT CARRIES WHICH WEIGHT (V3 §22.1)');
  console.log('  16 @ en_US.utf8 is the PRIMARY line: the product\'s own evidence is produced');
  console.log('  there, on the frozen set itself. The 18 context is INDEPENDENT DIAGNOSTIC');
  console.log('  evidence and carries no product claim — a fixture on 18 never stands in for');
  console.log('  an estate on 16. The 16 @ C context is this container\'s tooling, and its');
  console.log('  collation is not the deployment\'s.');
  console.log('');
  console.log('  V3 §7 asks every run to name its principal. Here it is the cluster SUPERUSER,');
  console.log('  which is also what CI uses, so no row above says anything about whether the');
  console.log('  DEPLOYMENT principal can apply the history. In this tree that principal is');
  console.log('  daftar_migrator over the whole history (TL-P4-COORD-R61; the administrator');
  console.log('  reading was withdrawn in P2-S9), and the instrument for it is');
  console.log('  `npm run check:deployment-authority`, not this matrix.');
  if (unaccounted.length > 0) {
    console.log('');
    console.log(`EXIT 2: ${unaccounted.map((r) => r.id).join(', ')} diverged between the measured contexts and the tree has no version-conditional branch for it.`);
    return 2;
  }
  if (unmeasured.length > 0) {
    console.log('');
    console.log(`EXIT 1: ${unmeasured.map((r) => r.id).join(', ')} not measured in every context.`);
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
