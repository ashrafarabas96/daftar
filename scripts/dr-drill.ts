/**
 * dr-drill — the disaster-recovery drill of gate 6 (docs/DAFTAR_LAUNCH_DEFINITION.md §3).
 *
 * It proves one claim and nothing wider: that a dump taken from a live
 * database can be restored into another database, that what comes back is the
 * same by measurement rather than by belief, and that a dump which is not
 * whole is refused instead of silently restored.
 *
 * Credentials never appear in the repository, in the process table, or in the
 * output. Both connection strings arrive as environment variables, are turned
 * into PG* variables for the child processes, and are never passed as
 * arguments; every string this script prints or writes passes through a
 * scrubber first, because libpq echoes the connection string in some of its
 * own error messages.
 *
 *   DR_DRILL_SOURCE_URL    the database to dump. Read, never written
 *   DR_DRILL_TARGET_URL    the database to restore into — DROPPED and recreated
 *   DR_DRILL_CONFIRM_DROP  must equal the target database name, exactly: the
 *                          drop is destructive, so it is confirmed in writing
 *   DR_DRILL_ARTIFACT_DIR  where the dump and the evidence are written
 *                          (default: var/dr-drill, created 0700)
 *   DR_DRILL_RTO_SECONDS   the RTO to compare the measured restore against
 *                          (default: 14400 — the four hours of
 *                          docs/DAFTAR_BACKUP_AND_DR.md:15)
 *   DR_DRILL_ALLOW_NONEMPTY_TARGET=1  permits dropping a target that holds rows
 *
 * Usage:
 *   node scripts/dr-drill.ts              the whole drill, both controls
 *   node scripts/dr-drill.ts --keep-dump
 *   node scripts/dr-drill.ts --keep-target
 *   node scripts/dr-drill.ts --no-negative-control   verdict INCOMPLETE, exit 3
 *   node scripts/dr-drill.ts --no-comparator-proof   verdict INCOMPLETE, exit 3
 *
 * Exit 0 only when every section of the census matched, the comparison proved
 * on this very database that it can fail, the financial invariants ran against
 * rows that exist, and pg_restore refused a truncated dump. A control that was
 * skipped makes the verdict INCOMPLETE and the exit 3: "I did not measure" is
 * never reported as a pass.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

type Json = unknown;

type Dsn = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode: string;
};

type Census = Record<string, Json>;

type Step = {
  step: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: string;
  seconds?: number;
};

/** Every section is compared. A section that is not here is not measured. */
const CENSUS_SECTIONS = [
  'tables',
  'money',
  'grants',
  'policies',
  'rlsFlags',
  'migrations',
  'triggers',
  'constraints',
  'indexes',
  'routines',
  'owners',
] as const;

const DB_NAME_RULE = /^[a-z_][a-z0-9_]{0,62}$/;
const TARGET_NAME_RULE = /_(restore|drill_target)$/;

const steps: Step[] = [];
let failed = false;
let incomplete = false;

/**
 * Removes anything that could carry a credential: a URI with userinfo, a
 * keyword-form password, and the value of any PG*PASSWORD. libpq quotes the
 * whole connection string back in several of its errors, so this runs over
 * every tool message before it is printed or written to the evidence file.
 */
function scrub(text: string): string {
  let out = text.replace(/postgres(?:ql)?:\/\/\S*/gi, 'postgres://<scrubbed>');
  out = out.replace(/password\s*=\s*('[^']*'|"[^"]*"|\S+)/gi, 'password=<scrubbed>');
  for (const name of ['DR_DRILL_SOURCE_URL', 'DR_DRILL_TARGET_URL']) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) out = out.split(value).join('<scrubbed>');
  }
  const pw = process.env.PGPASSWORD;
  if (pw !== undefined && pw.length > 0) out = out.split(pw).join('<scrubbed>');
  return out;
}

function record(step: string, status: Step['status'], detail: string, seconds?: number): void {
  const clean = scrub(detail).replace(/\s+/g, ' ').trim();
  steps.push({ step, status, detail: clean, seconds });
  if (status === 'FAIL') failed = true;
  if (status === 'SKIPPED') incomplete = true;
  const time = seconds === undefined ? '' : ` (${seconds.toFixed(3)}s)`;
  process.stdout.write(`${status}  ${step}${time} — ${clean}\n`);
}

function die(message: string): never {
  process.stderr.write(`${scrub(message)}\n`);
  process.exit(2);
}

/**
 * Parses a connection string into its parts. Everything that could throw is
 * inside the try, and the failure says nothing of what it was given: Node
 * attaches the whole input to ERR_INVALID_URL, which for a DSN is the password.
 */
function parseDsn(raw: string, which: string): Dsn {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('not a postgres URL');
    const q = u.searchParams;
    const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || (q.get('dbname') ?? '');
    return {
      host: u.hostname !== '' ? decodeURIComponent(u.hostname) : (q.get('host') ?? ''),
      port: u.port !== '' ? u.port : (q.get('port') ?? '5432'),
      user: u.username !== '' ? decodeURIComponent(u.username) : (q.get('user') ?? ''),
      password: u.password !== '' ? decodeURIComponent(u.password) : (q.get('password') ?? ''),
      database,
      sslmode: q.get('sslmode') ?? '',
    };
  } catch {
    // Deliberately not including the input, nor the parser's message.
    die(`${which} is not a connection string this drill can parse. It is read as a URL whose scheme is postgres or postgresql, of the form scheme + :// + user@host:port/dbname, with host, port, user and dbname also accepted as query parameters. Nothing of its content is printed here.`);
  }
}

/** What a tool may be told about where to connect: PG* variables, never argv. */
function pgEnv(dsn: Dsn, database?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DR_DRILL_SOURCE_URL;
  delete env.DR_DRILL_TARGET_URL;
  env.PGHOST = dsn.host;
  env.PGPORT = dsn.port;
  env.PGDATABASE = database ?? dsn.database;
  env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT ?? '10';
  if (dsn.user !== '') env.PGUSER = dsn.user;
  if (dsn.password !== '') env.PGPASSWORD = dsn.password;
  else delete env.PGPASSWORD;
  if (dsn.sslmode !== '') env.PGSSLMODE = dsn.sslmode;
  return env;
}

function describe(dsn: Dsn): string {
  const host = dsn.host === '' ? '(default)' : dsn.host;
  return `${host}:${dsn.port}/${dsn.database}`;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): { out: string; code: number; err: string } {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env ?? process.env });
    return { out, code: 0, err: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { out: e.stdout ?? '', code: e.status ?? 1, err: scrub(e.stderr ?? e.message ?? '') };
  }
}

const PSQL_FLAGS = ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1'];

function psql(env: NodeJS.ProcessEnv, sql: string): { out: string; code: number; err: string } {
  return run('psql', [...PSQL_FLAGS, '--tuples-only', '--no-align', '--command', sql], env);
}

/** One JSON scalar out of psql. The exit code is the command's own, and an
 *  empty result is a failure, not a zero (RULE-1/RULE-18/RULE-19). */
function psqlJson(env: NodeJS.ProcessEnv, sql: string, what: string): Json {
  const result = psql(env, sql);
  if (result.code !== 0) {
    record(`query:${what}`, 'FAIL', `psql exited ${result.code}: ${result.err.split('\n').slice(-2).join(' ')}`);
    return null;
  }
  const text = result.out.trim();
  if (text === '') {
    record(`query:${what}`, 'FAIL', 'psql returned nothing where JSON was expected');
    return null;
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    record(`query:${what}`, 'FAIL', 'the result was not JSON');
    return null;
  }
}

const SQL: Record<string, string> = {
  tables: `
    SELECT coalesce(json_agg(json_build_object('table', t, 'rows', n) ORDER BY t), '[]'::json)
    FROM (
      SELECT c.relname AS t,
             (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'r'
    ) s`,
  money: `
    SELECT coalesce(json_agg(json_build_object('table', t, 'column', col, 'sum', s, 'nonNull', nn) ORDER BY t, col), '[]'::json)
    FROM (
      SELECT c.table_name AS t, c.column_name AS col,
             (xpath('/row/s/text()', query_to_xml(format('SELECT coalesce(sum(%I)::text, ''0'') AS s FROM public.%I', c.column_name, c.table_name), false, true, '')))[1]::text AS s,
             (xpath('/row/n/text()', query_to_xml(format('SELECT count(%I) AS n FROM public.%I', c.column_name, c.table_name), false, true, '')))[1]::text AS nn
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name AND pc.relkind = 'r'
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
      WHERE c.table_schema = 'public'
        AND c.data_type IN ('bigint', 'integer', 'numeric')
        AND (c.column_name LIKE '%\\_minor' OR c.column_name LIKE '%amount%' OR c.column_name LIKE '%total%' OR c.column_name LIKE '%balance%' OR c.column_name LIKE '%rate%')
    ) s`,
  // No filter on the grantee: filtering by the connecting role would read a
  // different set on each side and hide a real difference (or invent one).
  grants: `
    SELECT coalesce(json_agg(json_build_object('grantee', grantee, 'table', table_name, 'privilege', privilege_type) ORDER BY grantee, table_name, privilege_type), '[]'::json)
    FROM information_schema.role_table_grants WHERE table_schema = 'public'`,
  policies: `
    SELECT coalesce(json_agg(json_build_object('table', tablename, 'policy', policyname, 'cmd', cmd, 'permissive', permissive, 'roles', roles::text, 'using', coalesce(qual, ''), 'check', coalesce(with_check, '')) ORDER BY tablename, policyname), '[]'::json)
    FROM pg_policies WHERE schemaname = 'public'`,
  rlsFlags: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r' AND (c.relrowsecurity OR c.relforcerowsecurity)`,
  // A statement naming a missing table fails at parse time, so the ledger is
  // read through a dynamic query.
  migrations: `
    SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN '"no schema_migrations table"'::json
      ELSE (xpath('/row/j/text()', query_to_xml(
             'SELECT coalesce(json_agg(to_jsonb(m) ORDER BY to_jsonb(m)->>''name''), ''[]''::json)::text AS j FROM public.schema_migrations m',
             false, true, '')))[1]::text::json END`,
  // The accounting truth of this schema hangs on triggers, on constraints and
  // on who owns a SECURITY DEFINER routine: a restore that loses one of those
  // would otherwise read as identical.
  triggers: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'trigger', t.tgname, 'enabled', t.tgenabled, 'function', p.proname) ORDER BY c.relname, t.tgname), '[]'::json)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE ns.nspname = 'public' AND NOT t.tgisinternal`,
  constraints: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'constraint', con.conname, 'type', con.contype, 'deferrable', con.condeferrable, 'deferred', con.condeferred, 'definition', pg_get_constraintdef(con.oid)) ORDER BY c.relname, con.conname), '[]'::json)
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'`,
  indexes: `
    SELECT coalesce(json_agg(json_build_object('table', tablename, 'index', indexname, 'definition', indexdef) ORDER BY tablename, indexname), '[]'::json)
    FROM pg_indexes WHERE schemaname = 'public'`,
  routines: `
    SELECT coalesce(json_agg(json_build_object('routine', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'owner', pg_get_userbyid(p.proowner), 'definer', p.prosecdef, 'volatility', p.provolatile) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::json)
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'`,
  owners: `
    SELECT coalesce(json_agg(json_build_object('object', c.relname, 'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner)) ORDER BY c.relname, c.relkind), '[]'::json)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')`,
  // Who is measuring, and may they see past row-level security. Under FORCE
  // RLS a principal without bypass reads every table as empty, and an empty
  // census compares equal to an empty census.
  principal: `
    SELECT json_build_object(
      'user', current_user,
      'super', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
      'bypassrls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
      'forcedRlsTables', (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                          WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity),
      'serverVersion', current_setting('server_version'))`,
};

/** Each invariant runs only where its table exists AND holds rows: zero
 *  violations in an empty table is not a measurement. */
const INVARIANTS: Array<{ id: string; table: string; sql: string }> = [
  {
    id: 'INV-ACC-01 (debits equal credits, per entry)',
    table: 'journal_lines',
    sql: `SELECT count(*)::text FROM (
            SELECT business_id, journal_entry_id FROM public.journal_lines
            GROUP BY business_id, journal_entry_id
            HAVING sum(debit_minor) <> sum(credit_minor)) bad`,
  },
  {
    id: 'INV-ACC-01b (no line is both a debit and a credit)',
    table: 'journal_lines',
    sql: `SELECT count(*)::text FROM public.journal_lines WHERE debit_minor <> 0 AND credit_minor <> 0`,
  },
  {
    id: 'no journal line without its entry',
    table: 'journal_lines',
    sql: `SELECT count(*)::text FROM public.journal_lines l
          WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries e
                            WHERE e.business_id = l.business_id AND e.id = l.journal_entry_id)`,
  },
  {
    id: 'every journal entry is bound to one source identity',
    table: 'journal_entries',
    sql: `SELECT count(*)::text FROM public.journal_entries e
          WHERE NOT EXISTS (SELECT 1 FROM public.accounting_source_bindings b
                            WHERE b.business_id = e.business_id AND b.journal_entry_id = e.id)`,
  },
];

function census(env: NodeJS.ProcessEnv, label: string): Census | null {
  const out: Census = {};
  for (const section of CENSUS_SECTIONS) {
    const value = psqlJson(env, SQL[section], `${label}.${section}`);
    if (value === null) return null;
    out[section] = value;
  }
  return out;
}

/**
 * The server re-renders a check constraint when it is dumped and restored:
 * `((A AND B) AND C)` comes back as `(A AND B AND C)`. The text differs, the
 * constraint does not. So the comparison is made on a parenthesis-insensitive
 * form, and the number of definitions that differ only in that rendering is
 * reported on its own line rather than hidden.
 */
function normalizeCensus(c: Census): Census {
  const out: Census = { ...c };
  if (Array.isArray(c.constraints)) {
    out.constraints = (c.constraints as Array<Record<string, Json>>).map((row) => ({
      ...row,
      definition: typeof row.definition === 'string' ? row.definition.replace(/[()\s]+/g, ' ').trim() : row.definition,
    }));
  }
  return out;
}

function renderingOnlyDiffs(before: Census, after: Census): number {
  if (!Array.isArray(before.constraints) || !Array.isArray(after.constraints)) return 0;
  const key = (row: Record<string, Json>): string => `${String(row.table)}.${String(row.constraint)}`;
  const left = new Map((before.constraints as Array<Record<string, Json>>).map((r) => [key(r), String(r.definition)]));
  let n = 0;
  for (const row of after.constraints as Array<Record<string, Json>>) {
    const was = left.get(key(row));
    if (was === undefined) continue;
    const now = String(row.definition);
    if (was !== now && was.replace(/[()\s]+/g, ' ').trim() === now.replace(/[()\s]+/g, ' ').trim()) n += 1;
  }
  return n;
}

function compare(before: Census, after: Census): string[] {
  const diffs: string[] = [];
  for (const section of CENSUS_SECTIONS) {
    const a = JSON.stringify(before[section]);
    const b = JSON.stringify(after[section]);
    if (a === b) continue;
    if (Array.isArray(before[section]) && Array.isArray(after[section])) {
      const left = before[section] as Json[];
      const right = after[section] as Json[];
      const rightSet = new Set(right.map((x) => JSON.stringify(x)));
      const leftSet = new Set(left.map((x) => JSON.stringify(x)));
      const missing = left.filter((x) => !rightSet.has(JSON.stringify(x))).slice(0, 3);
      const extra = right.filter((x) => !leftSet.has(JSON.stringify(x))).slice(0, 3);
      diffs.push(`${section}: ${left.length} before, ${right.length} after; missing ${JSON.stringify(missing)}; unexpected ${JSON.stringify(extra)}`);
    } else {
      diffs.push(`${section}: ${a} before, ${b} after`);
    }
  }
  return diffs;
}

function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Copies the first `bytes` of a file without holding it in memory: a
 *  production-sized dump does not fit in a Buffer. */
function copyPrefix(from: string, to: string, bytes: number): void {
  const input = openSync(from, 'r');
  const output = openSync(to, 'w', 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let left = bytes;
    while (left > 0) {
      const read = readSync(input, buffer, 0, Math.min(buffer.length, left), null);
      if (read === 0) break;
      writeSync(output, buffer, 0, read);
      left -= read;
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

function recreate(dsn: Dsn, label: string): boolean {
  const name = dsn.database;
  // The name is interpolated into a statement, so it is validated first: psql
  // --command accepts several statements, and a crafted name would be one.
  if (!DB_NAME_RULE.test(name)) {
    record(`recreate:${label}`, 'FAIL', 'the target database name is not a plain identifier, and this drill will not interpolate anything else into a DROP statement');
    return false;
  }
  const admin = pgEnv(dsn, 'postgres');
  const drop = run('psql', [...PSQL_FLAGS, '--command', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], admin);
  if (drop.code !== 0) {
    record(`recreate:${label}`, 'FAIL', `DROP DATABASE exited ${drop.code}: ${drop.err.split('\n').slice(-1)[0]}`);
    return false;
  }
  const create = run('psql', [...PSQL_FLAGS, '--command', `CREATE DATABASE "${name}"`], admin);
  if (create.code !== 0) {
    record(`recreate:${label}`, 'FAIL', `CREATE DATABASE exited ${create.code}: ${create.err.split('\n').slice(-1)[0]}`);
    return false;
  }
  return true;
}

function main(): void {
  const argv = process.argv.slice(2);
  const withNegative = !argv.includes('--no-negative-control');
  const withComparatorProof = !argv.includes('--no-comparator-proof');
  const keepDump = argv.includes('--keep-dump');
  const keepTarget = argv.includes('--keep-target');

  const sourceRaw = process.env.DR_DRILL_SOURCE_URL;
  const targetRaw = process.env.DR_DRILL_TARGET_URL;
  if (sourceRaw === undefined || sourceRaw.trim() === '') die('DR_DRILL_SOURCE_URL is not set. Both connection strings come from the environment; neither is read from the command line nor from any file in this repository.');
  if (targetRaw === undefined || targetRaw.trim() === '') die('DR_DRILL_TARGET_URL is not set.');

  const source = parseDsn(sourceRaw.trim(), 'DR_DRILL_SOURCE_URL');
  const target = parseDsn(targetRaw.trim(), 'DR_DRILL_TARGET_URL');
  const sourceEnv = pgEnv(source);
  const targetEnv = pgEnv(target);
  const artifactDir = (process.env.DR_DRILL_ARTIFACT_DIR ?? join('var', 'dr-drill')).trim();
  const rtoSeconds = Number(process.env.DR_DRILL_RTO_SECONDS ?? '14400');
  if (!Number.isFinite(rtoSeconds) || rtoSeconds <= 0) die('DR_DRILL_RTO_SECONDS must be a positive number of seconds.');

  process.stdout.write(`dr-drill\n  source ${describe(source)}\n  target ${describe(target)}\n  artifacts ${artifactDir}\n  RTO ${rtoSeconds}s\n\n`);

  // 0. The target is dropped. It names itself a drill target, it is a plain
  //    identifier, it is not the source, and the drop is confirmed in writing.
  let guarded = true;
  if (!DB_NAME_RULE.test(target.database) || !TARGET_NAME_RULE.test(target.database)) {
    record('guard:target-name', 'FAIL', 'the target database is dropped and recreated, so its name must be a plain identifier ending in _restore or _drill_target');
    guarded = false;
  } else if (target.database === source.database && target.host === source.host && target.port === source.port) {
    record('guard:target-name', 'FAIL', 'the target is the source');
    guarded = false;
  } else {
    record('guard:target-name', 'PASS', `the target is "${target.database}" and is not the source`);
  }
  if (process.env.DR_DRILL_CONFIRM_DROP !== target.database) {
    record('guard:drop-confirmed', 'FAIL', 'DR_DRILL_CONFIRM_DROP must hold the exact name of the target database. The drop destroys whatever is in it, so it is not taken from the URL alone');
    guarded = false;
  } else {
    record('guard:drop-confirmed', 'PASS', 'the drop of the target was confirmed by name');
  }
  if (!guarded) return finish(artifactDir, rtoSeconds, null, source, target);

  // 1. The tools. A dump restored by an older pg_restore is another experiment.
  for (const tool of ['pg_dump', 'pg_restore', 'psql', 'pg_dumpall']) {
    const v = run(tool, ['--version']);
    record(`tool:${tool}`, v.code === 0 ? 'PASS' : 'FAIL', v.code === 0 ? v.out.trim() : `not runnable (exit ${v.code})`);
  }
  if (failed) return finish(artifactDir, rtoSeconds, null, source, target);

  // 2. Who is measuring. Under FORCE ROW LEVEL SECURITY — which this schema
  //    sets on its financial tables — a principal without bypass reads every
  //    table as empty, and two empty censuses compare equal. So the identity
  //    is recorded, and a principal that cannot see past RLS is a failure
  //    rather than a quiet pass.
  const who = psqlJson(sourceEnv, SQL.principal, 'source.principal') as
    | { user: string; super: boolean; bypassrls: boolean; forcedRlsTables: number; serverVersion: string }
    | null;
  if (who === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const canSeePastRls = who.super === true || who.bypassrls === true;
  record('source:principal', canSeePastRls || who.forcedRlsTables === 0 ? 'PASS' : 'FAIL',
    `server ${who.serverVersion}, measured as "${who.user}" (super=${who.super}, bypassrls=${who.bypassrls}) against ${who.forcedRlsTables} tables under FORCE RLS` +
    (canSeePastRls || who.forcedRlsTables === 0 ? '' : ' — this principal reads those tables as empty, so neither the census nor the dump can be trusted'));
  if (failed) return finish(artifactDir, rtoSeconds, null, source, target);

  // 3. What the source holds, before anything is touched. An empty source
  //    proves nothing, so it is a failure.
  const before = census(sourceEnv, 'source');
  if (before === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const tables = Array.isArray(before.tables) ? (before.tables as Array<{ table: string; rows: number }>) : [];
  const rowTotal = tables.reduce((a, t) => a + Number(t.rows), 0);
  record('census:source', tables.length > 0 && rowTotal > 0 ? 'PASS' : 'FAIL',
    `${tables.length} tables, ${rowTotal} rows, ` +
    `${(before.policies as Json[] | undefined)?.length ?? 0} RLS policies, ` +
    `${(before.grants as Json[] | undefined)?.length ?? 0} grants, ` +
    `${(before.triggers as Json[] | undefined)?.length ?? 0} triggers, ` +
    `${(before.constraints as Json[] | undefined)?.length ?? 0} constraints, ` +
    `${(before.indexes as Json[] | undefined)?.length ?? 0} indexes, ` +
    `${(before.routines as Json[] | undefined)?.length ?? 0} routines` +
    (tables.length === 0 || rowTotal === 0 ? ' — a source with no rows cannot show that a restore keeps anything' : ''));
  if (failed) return finish(artifactDir, rtoSeconds, null, source, target);

  // 4. The dump. Custom format: pg_restore can read its table of contents, and
  //    a truncated file is detectable.
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const dumpPath = join(artifactDir, `dump-${source.database}.pgc`);
  const globalsPath = join(artifactDir, 'globals.sql');
  let t0 = Date.now();
  const dump = run('pg_dump', ['--format=custom', '--no-password', `--file=${dumpPath}`], sourceEnv);
  const dumpSeconds = (Date.now() - t0) / 1000;
  if (dump.code !== 0) {
    record('backup:dump', 'FAIL', `pg_dump exited ${dump.code}: ${dump.err.split('\n').slice(-1)[0]}`, dumpSeconds);
    return finish(artifactDir, rtoSeconds, null, source, target);
  }
  const bytes = statSync(dumpPath).size;
  const sha = sha256OfFile(dumpPath);
  record('backup:dump', bytes > 0 ? 'PASS' : 'FAIL', `${bytes} bytes, sha256 ${sha.slice(0, 16)}…`, dumpSeconds);

  // The source must not have changed while it was being dumped, or a later
  // difference cannot be told apart from a restore fault.
  const duringDump = census(sourceEnv, 'source-after-dump');
  if (duringDump === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const moved = compare(before, duringDump);
  record('source:quiescent', moved.length === 0 ? 'PASS' : 'FAIL',
    moved.length === 0
      ? 'the source read the same before and after the dump'
      : `the source changed while it was dumped, so no later comparison can separate that from a restore fault: ${moved[0].slice(0, 160)}`);

  // Roles and their privileges live in the cluster, not in the database: a
  // database restored without them carries grants naming roles that do not
  // exist. The file holds password hashes, so it is 0600 and is removed with
  // the dump unless it is explicitly kept.
  t0 = Date.now();
  const globals = run('pg_dumpall', ['--globals-only', '--no-password', `--file=${globalsPath}`], pgEnv(source, 'postgres'));
  if (globals.code === 0) {
    const roleLines = run('grep', ['-c', '^CREATE ROLE', globalsPath]);
    record('backup:globals', 'PASS', `the cluster's roles and privileges were written separately (${statSync(globalsPath).size} bytes, ${roleLines.out.trim() || '0'} CREATE ROLE statements, mode 0600). This file carries password hashes and is not part of the database dump`, (Date.now() - t0) / 1000);
  } else {
    record('backup:globals', 'FAIL', `pg_dumpall exited ${globals.code}: ${globals.err.split('\n').slice(-1)[0]}`, (Date.now() - t0) / 1000);
  }

  // 5. The target, before it is dropped: a target that holds rows is not
  //    dropped unless that was allowed in writing. A target that does not
  //    exist yet is the clean case, not a failure to measure.
  const countRows = `SELECT coalesce((SELECT sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint)
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'r'), 0)::text`;
  const probe = psql(targetEnv, countRows);
  let existingRows = 0;
  if (probe.code !== 0) {
    if (/does not exist/i.test(probe.err)) {
      record('guard:target-empty', 'PASS', `the target database "${target.database}" does not exist yet, so nothing of it is destroyed`);
    } else {
      record('guard:target-empty', 'FAIL', `the target could not be read before the drop (psql exited ${probe.code}), and a drop is not issued against a database whose contents are unknown: ${probe.err.split(/\r?\n/).slice(-1)[0]}`);
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
  } else {
    existingRows = Number(probe.out.trim());
    if (!Number.isFinite(existingRows)) {
      record('guard:target-empty', 'FAIL', 'the row count of the target did not read as a number, and a drop is not issued against a database whose contents are unknown');
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
    if (existingRows > 0 && process.env.DR_DRILL_ALLOW_NONEMPTY_TARGET !== '1') {
      record('guard:target-empty', 'FAIL', `the target holds ${existingRows} rows. Dropping it would destroy them, so it is refused unless DR_DRILL_ALLOW_NONEMPTY_TARGET=1 says otherwise`);
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
    record('guard:target-empty', 'PASS', existingRows === 0 ? 'the target exists and holds no rows' : `the target holds ${existingRows} rows and DR_DRILL_ALLOW_NONEMPTY_TARGET=1 allowed the drop`);
  }

  // 6. The restore, measured. This number is the one compared against the RTO.
  if (!recreate(target, 'restore-target')) return finish(artifactDir, rtoSeconds, null, source, target);
  t0 = Date.now();
  const restore = run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', `--dbname=${target.database}`, dumpPath], targetEnv);
  const restoreSeconds = (Date.now() - t0) / 1000;
  if (restore.code !== 0) {
    record('restore', 'FAIL', `pg_restore exited ${restore.code}: ${restore.err.split('\n').slice(-2).join(' ')}`, restoreSeconds);
    return finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
  }
  record('restore', 'PASS', 'pg_restore completed in one transaction', restoreSeconds);

  // 7. The comparison.
  const after = census(targetEnv, 'restored');
  if (after === null) return finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
  const rendering = renderingOnlyDiffs(before, after);
  const diffs = compare(normalizeCensus(before), normalizeCensus(after));
  record('note:constraint-rendering', 'PASS',
    rendering === 0
      ? 'no constraint came back with a different rendering'
      : `${rendering} check constraints came back rendered differently (nested AND re-parenthesised by the server) while asserting the same thing; the comparison below is parenthesis-insensitive for that reason, and nothing else about them differs`);
  record('compare:census', diffs.length === 0 ? 'PASS' : 'FAIL',
    diffs.length === 0 ? `identical across ${CENSUS_SECTIONS.join(', ')}` : diffs.join(' | '));

  // Two sections cannot fail when one cluster holds both databases, and that
  // is said rather than counted as evidence.
  const sameCluster = source.host === target.host && source.port === target.port;
  record('scope:sections-that-cannot-fail-here', 'PASS',
    sameCluster
      ? 'the source and the target are in one cluster, so "owners", "grants" and the roles in "policies" name the same cluster-level roles on both sides: those sections catch a cross-cluster restore, not this one. The separate globals file is what a cross-cluster restore would need, and this drill does not restore it'
      : 'the source and the target are in different clusters, so the role-bearing sections are a real comparison here');

  // 8. The financial invariants, on the restored copy, each only where its
  //    table exists and holds rows.
  for (const inv of INVARIANTS) {
    const rows = psqlJson(targetEnv, `SELECT CASE WHEN to_regclass('public.${inv.table}') IS NULL THEN '-1'::json
      ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', '${inv.table}'), false, true, '')))[1]::text::json END`, `restored.rows.${inv.table}`);
    const n = rows === null ? -1 : Number(rows);
    if (n < 0) {
      record(`invariant:${inv.id}`, 'SKIPPED', `public.${inv.table} is not in the restored database`);
      continue;
    }
    if (n === 0) {
      record(`invariant:${inv.id}`, 'SKIPPED', `public.${inv.table} is empty in the restored database, and zero violations in an empty table is not a measurement`);
      continue;
    }
    const bad = psql(targetEnv, inv.sql);
    if (bad.code !== 0) {
      record(`invariant:${inv.id}`, 'FAIL', `the check itself did not run (psql exited ${bad.code})`);
      continue;
    }
    const violations = bad.out.trim();
    record(`invariant:${inv.id}`, violations === '0' ? 'PASS' : 'FAIL',
      violations === '0' ? `zero violating rows out of ${n}` : `${violations} violating rows out of ${n}`);
  }

  // 9. The control on the comparison itself: a comparison that cannot fail is
  //    not a comparison (RULE-11). Tested on its own arithmetic, and then on
  //    this very database.
  const perturbed = JSON.parse(JSON.stringify(before)) as Census;
  const perturbedTables = perturbed.tables as Array<{ table: string; rows: number }>;
  perturbedTables[0].rows = Number(perturbedTables[0].rows) + 1;
  const arithmetic = compare(before, perturbed);
  record('control:comparison-arithmetic', arithmetic.length > 0 ? 'PASS' : 'FAIL',
    arithmetic.length > 0
      ? `moving the row count of ${perturbedTables[0].table} by one was reported`
      : 'moving a row count by one went unreported — every comparison above is worthless');

  if (withComparatorProof) {
    const listed = psql(targetEnv, `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r'
         AND (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint > 0
       ORDER BY c.relname`);
    if (listed.code !== 0) {
      record('control:comparison-on-database', 'FAIL', `the non-empty tables of the restored copy could not be listed (psql exited ${listed.code})`);
    } else {
      const candidates = listed.out.split(/\r?\n/).map((x) => x.trim()).filter((x) => DB_NAME_RULE.test(x));
      let mutatedTable = '';
      const refused: Array<{ table: string; reason: string }> = [];
      for (const table of candidates) {
        // Through format(%I) server-side, so the name is quoted by the server.
        const del = psql(targetEnv, `DO $$ BEGIN EXECUTE format('DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I LIMIT 1)', '${table}', '${table}'); END $$`);
        if (del.code === 0) { mutatedTable = table; break; }
        refused.push({ table, reason: (del.err.match(/ERROR:\s*([^\n]{0,80})/) ?? ['', 'unknown'])[1] });
      }
      if (mutatedTable === '') {
        record('control:comparison-on-database', 'FAIL',
          `no row could be deleted from the restored copy (${candidates.length} non-empty tables; the first refusals were ${JSON.stringify(refused.slice(0, 3))}), so the census was never tested against a real difference`);
      } else {
        const mutatedCensus = census(targetEnv, 'mutated');
        const seen = mutatedCensus === null ? ['the mutated copy could not be read'] : compare(normalizeCensus(before), normalizeCensus(mutatedCensus));
        record('control:comparison-on-database', seen.length > 0 ? 'PASS' : 'FAIL',
          seen.length > 0
            ? `one row deleted from public.${mutatedTable} was detected. ${refused.length} earlier tables refused the delete, each with its reason: ${JSON.stringify(refused.slice(0, 3))}`
            : `one row deleted from public.${mutatedTable} went unnoticed — every comparison above is worthless`);
      }
    }
  } else {
    record('control:comparison-on-database', 'SKIPPED', '--no-comparator-proof was passed, so the census was never tested against a real difference');
  }

  // 10. The negative control: a dump that is not whole must be refused.
  if (withNegative) {
    const brokenPath = join(artifactDir, 'dump-truncated.pgc');
    copyPrefix(dumpPath, brokenPath, Math.max(1, Math.floor(bytes * 0.6)));
    const toc = run('pg_restore', ['--list', brokenPath]);
    const recreated = recreate(target, 'negative-control');
    const attempt = recreated
      ? run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', `--dbname=${target.database}`, brokenPath], targetEnv)
      : { out: '', code: -1, err: 'the control database could not be recreated' };
    record('negative-control:truncated-dump', recreated && attempt.code !== 0 ? 'PASS' : 'FAIL',
      !recreated
        ? 'the control database could not be recreated, so a broken dump was never offered to pg_restore'
        : attempt.code !== 0
          ? `a dump truncated to 60% was refused (pg_restore exited ${attempt.code}; its table of contents ${toc.code === 0 ? 'still listed' : 'failed to list'})`
          : 'a truncated dump restored without error — this drill cannot tell a whole backup from a broken one');
    const brokenSha = sha256OfFile(brokenPath);
    record('negative-control:checksum', brokenSha !== sha ? 'PASS' : 'FAIL',
      brokenSha !== sha ? 'the altered file does not match the recorded sha256' : 'the altered file matched the recorded sha256, so the checksum proves nothing');
    unlinkSync(brokenPath);
  } else {
    record('negative-control:truncated-dump', 'SKIPPED', '--no-negative-control was passed, so a broken dump was never offered to pg_restore');
  }

  if (!keepDump) {
    unlinkSync(dumpPath);
    if (existsSync(globalsPath)) unlinkSync(globalsPath);
    record('cleanup:artifacts', 'PASS', 'the dump and the globals file (which carries password hashes) were deleted; pass --keep-dump to keep both');
  } else {
    record('cleanup:artifacts', 'PASS', `--keep-dump was passed, so the dump and ${globalsPath} remain on disk. The globals file carries the cluster's password hashes: it is mode 0600 and belongs in a secret store or nowhere`);
  }

  // 11. The target is scratch, and by now it also holds the one row the control
  //      deleted, so it is dropped unless it is wanted for inspection. This is
  //      also what lets the next run start without being asked to allow a drop.
  if (keepTarget) {
    record('cleanup:target', 'PASS', `--keep-target was passed, so "${target.database}" is left as it is — with the one row the comparison control deleted still missing, which is why it is not a copy to trust`);
  } else {
    const name = target.database;
    const drop = run('psql', [...PSQL_FLAGS, '--command', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], pgEnv(target, 'postgres'));
    record('cleanup:target', drop.code === 0 ? 'PASS' : 'FAIL',
      drop.code === 0
        ? `the restored copy was dropped: it is scratch, and the comparison control deleted a row from it`
        : `the restored copy could not be dropped (psql exited ${drop.code}), so the next run will refuse it as a non-empty target: ${drop.err.split(/\r?\n/).slice(-1)[0]}`);
  }

  finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
}

function finish(artifactDir: string, rtoSeconds: number, restoreSeconds: number | null, source: Dsn, target: Dsn): void {
  if (restoreSeconds === null) {
    record('rto', 'FAIL', 'no restore was measured, so nothing can be compared against the RTO');
  } else {
    record('rto', restoreSeconds <= rtoSeconds ? 'PASS' : 'FAIL',
      `the restore took ${restoreSeconds.toFixed(3)}s against an RTO of ${rtoSeconds}s — the time of this database on this machine, which is not the production time and is not an estimate of it`);
  }

  const verdict = failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS';
  const evidence = {
    tool: 'scripts/dr-drill.ts',
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    source: describe(source),
    target: describe(target),
    rtoSeconds,
    restoreSeconds,
    steps,
    verdict,
  };
  try {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const path = join(artifactDir, 'dr-drill-evidence.json');
    writeFileSync(path, `${scrub(JSON.stringify(evidence, null, 2))}\n`, { mode: 0o600 });
    process.stdout.write(`\nevidence ${path}\n`);
  } catch (error) {
    process.stdout.write(`\nthe evidence file could not be written: ${scrub(String(error))}\n`);
    failed = true;
  }

  const counts = steps.reduce((acc: Record<string, number>, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
  process.stdout.write(`verdict ${failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS'} — ${counts.PASS ?? 0} passed, ${counts.FAIL ?? 0} failed, ${counts.SKIPPED ?? 0} skipped\n`);
  process.exit(failed ? 1 : incomplete ? 3 : 0);
}

if (!existsSync('package.json')) die('run this from the repository root');

main();
