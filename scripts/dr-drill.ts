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
 *   DR_DRILL_EMPTY_SECTIONS  census sections established to be empty in
 *                          this schema, named exactly, so their empty
 *                          comparison is acknowledged and not read as proof
 *   DR_DRILL_RTO_SECONDS   the RTO to compare the measured restore against
 *                          (default: 14400 — the four hours of
 *                          docs/DAFTAR_BACKUP_AND_DR.md:15)
 *   DR_DRILL_ALLOW_NONEMPTY_TARGET   permits dropping a target that holds rows,
 *                          and must name the measured row count itself
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
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
  'routineGrants',
  'columnGrants',
  'defaultAcls',
  'owners',
  'views',
] as const;

const DB_NAME_RULE = /^[a-z_][a-z0-9_]{0,62}$/;
const TARGET_NAME_RULE = /_(restore|drill_target)$/;

const steps: Step[] = [];
let failed = false;
let incomplete = false;

/** Every secret this run holds, so the scrubber can remove it even when it
 *  appears alone, with no `password=` or URL around it. */
const SECRETS: string[] = [];
const artifactsToRemove: string[] = [];
let keepSecrets = false;

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
  // The passwords taken out of the two URLs, which is what goes into the
  // children's environment: a message may carry one of them with no `password=`
  // and no URL around it.
  for (const secret of SECRETS) {
    if (secret.length > 0) out = out.split(secret).join('<scrubbed>');
  }
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
    die(
      `${which} is not a connection string this drill can parse. It is read as a URL whose scheme is postgres or postgresql, of the form scheme + :// + user@host:port/dbname, with host, port, user and dbname also accepted as query parameters. Nothing of its content is printed here.`,
    );
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

/**
 * The last non-empty lines of a tool's message. Slicing the raw split picks up
 * the empty tail after the trailing newline, which is how a real error
 * ("role daftar_migrator does not exist") printed as nothing at all and a
 * failure arrived without its reason.
 */
function lastLines(text: string, count: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return '(the tool said nothing)';
  // The reason is on the ERROR line; psql and pg_dump then add DETAIL, HINT or
  // "Query was: …". Taking the tail alone kept the hint and lost the cause, so
  // the cause comes first and the tail follows it.
  const cause = lines.filter((line) => /^(?:pg_\w+: )?error[: ]/i.test(line) || /^ERROR:/.test(line));
  if (cause.length === 0) return lines.slice(-count).join(' ');
  const tail = lines.slice(-count).filter((line) => !cause.includes(line));
  return [...cause.slice(0, count), ...tail].slice(0, count + 1).join(' ');
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): { out: string; code: number; err: string } {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env ?? process.env });
    return { out, code: 0, err: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    const raw = e.stderr ?? e.message ?? '';
    const text = raw.trim() === '' ? `(the tool wrote nothing to stderr; its last output was: ${lastLines(e.stdout ?? '', 2)})` : raw;
    return { out: e.stdout ?? '', code: e.status ?? 1, err: scrub(text) };
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
    record(`query:${what}`, 'FAIL', `psql exited ${result.code}: ${lastLines(result.err, 2)}`);
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

const SQL = {
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
  // Read from relacl, not from information_schema.role_table_grants: that view
  // shows only grants to roles the caller belongs to and DROPS everything
  // granted to PUBLIC. This schema's security is built on taking PUBLIC away
  // (REVOKE ALL ... FROM PUBLIC in 0042 and 0046), so a restore that handed
  // PUBLIC its default privileges back would have read as identical.
  // A NULL relacl means "the owner's default", which is itself a fact.
  grants: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner), 'acl', coalesce(c.relacl::text, '(owner default)')) ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')`,
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
  // The whole definition, not the name: a trigger that comes back AFTER
  // instead of BEFORE, or without its WHEN, carries the same name.
  triggers: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'trigger', t.tgname, 'enabled', t.tgenabled, 'type', t.tgtype, 'definition', pg_get_triggerdef(t.oid, true)) ORDER BY c.relname, t.tgname), '[]'::json)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND NOT t.tgisinternal`,
  constraints: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'constraint', con.conname, 'type', con.contype, 'deferrable', con.condeferrable, 'deferred', con.condeferred, 'definition', pg_get_constraintdef(con.oid)) ORDER BY c.relname, con.conname), '[]'::json)
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'`,
  indexes: `
    SELECT coalesce(json_agg(json_build_object('table', tablename, 'index', indexname, 'definition', indexdef) ORDER BY tablename, indexname), '[]'::json)
    FROM pg_indexes WHERE schemaname = 'public'`,
  // The body is compared by digest, and proconfig with it: a SECURITY DEFINER
  // routine that comes back without its pinned search_path is the hole DR-60
  // closes, and it would otherwise read as identical.
  routines: `
    SELECT coalesce(json_agg(json_build_object('routine', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'owner', pg_get_userbyid(p.proowner), 'definer', p.prosecdef, 'volatility', p.provolatile, 'config', coalesce(p.proconfig::text, ''), 'bodySha', md5(coalesce(p.prosrc, ''))) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::json)
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'`,
  // Privileges that role_table_grants does not carry: EXECUTE on a routine,
  // a privilege granted on one column, and what a future object will inherit.
  // proacl, for the same reason: EXECUTE on a function is granted to PUBLIC by
  // default, and a SECURITY DEFINER routine that comes back without its REVOKE
  // is exactly the hole DR-60 closes.
  routineGrants: `
    SELECT coalesce(json_agg(json_build_object('routine', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'acl', coalesce(p.proacl::text, '(public execute by default)')) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::json)
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'`,
  columnGrants: `
    SELECT coalesce(json_agg(json_build_object('table', c.relname, 'column', a.attname, 'acl', a.attacl::text) ORDER BY c.relname, a.attname), '[]'::json)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`,
  defaultAcls: `
    SELECT coalesce(json_agg(json_build_object('owner', pg_get_userbyid(d.defaclrole), 'objectType', d.defaclobjtype, 'acl', d.defaclacl::text) ORDER BY pg_get_userbyid(d.defaclrole), d.defaclobjtype, d.defaclacl::text), '[]'::json)
    FROM pg_default_acl d JOIN pg_namespace ns ON ns.oid = d.defaclnamespace WHERE ns.nspname = 'public'`,
  owners: `
    SELECT coalesce(json_agg(json_build_object('object', c.relname, 'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner)) ORDER BY c.relname, c.relkind), '[]'::json)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')`,
  // A view's body, not only its name: a view that comes back selecting
  // something else keeps both.
  views: `
    SELECT coalesce(json_agg(json_build_object('view', c.relname, 'kind', c.relkind, 'definition', pg_get_viewdef(c.oid, true)) ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('v', 'm')`,
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
  // Which cluster, and which database inside it, as the server says it — not
  // as the connection string spells it. "localhost", "127.0.0.1" and a local
  // socket are three spellings of one cluster.
  identity: `SELECT json_build_object('cluster', (SELECT system_identifier::text FROM pg_control_system()), 'database', current_catalog)`,
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
 * A check constraint is deparsed from the stored tree on both sides, so when
 * the two texts differ the two trees differ. Dump and restore flatten a nested
 * chain of one boolean operator — `((A AND B) AND C)` comes back as
 * `(A AND B AND C)` — which is the same constraint because AND is associative.
 *
 * Stripping every parenthesis would also equate `(A - B) * C` with
 * `A - B * C`, and `(P AND Q) OR R` with `P AND (Q OR R)` — the second of
 * which would let a line be both a debit and a credit. So the canonical form
 * below removes a parenthesis ONLY where a group and its child are chains of
 * the very same associative boolean operator, and leaves everything else as it
 * is. The control at the end of this file is what proves it still tells those
 * pairs apart, and it runs on every drill.
 */
type ExprNode = string | ExprNode[];

/** Splits an expression on its parentheses, keeping quoted text atomic. */
function parseExpr(text: string): ExprNode[] {
  const root: ExprNode[] = [];
  const stack: ExprNode[][] = [root];
  let buffer = '';
  let i = 0;
  const flush = (): void => {
    const top = stack[stack.length - 1];
    if (buffer.trim() !== '' && top !== undefined) top.push(buffer.trim());
    buffer = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buffer += quote;
      i += 1;
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) {
          buffer += quote + quote;
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          buffer += quote;
          i += 1;
          break;
        }
        buffer += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      flush();
      const group: ExprNode[] = [];
      stack[stack.length - 1]?.push(group);
      stack.push(group);
      i += 1;
      continue;
    }
    if (ch === ')') {
      flush();
      if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return root;
}

/** The boolean operators that join this group's own operands. */
function topOperators(group: ExprNode[]): Set<string> {
  const ops = new Set<string>();
  for (const child of group) {
    if (typeof child !== 'string') continue;
    for (const match of child.toUpperCase().matchAll(/\b(AND|OR)\b/g)) {
      const op = match[1];
      if (op !== undefined) ops.add(op);
    }
  }
  return ops;
}

function canonicalExpr(node: ExprNode): string {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ').trim();
  const ops = topOperators(node);
  // A NOT anywhere in this group stops the flattening: `NOT (a AND b) AND c`
  // and `NOT a AND b AND c` are different constraints, and dropping that
  // parenthesis would equate them — measured, not supposed.
  const negated = node.some((child) => typeof child === 'string' && /\bNOT\b/i.test(child));
  const chain = ops.size === 1 && !negated ? [...ops][0] : '';
  const parts = node.map((child) => {
    if (typeof child === 'string') return canonicalExpr(child);
    const inner = canonicalExpr(child);
    const childOps = topOperators(child);
    const sameChain = chain !== '' && childOps.size === 1 && [...childOps][0] === chain;
    return sameChain ? inner : `(${inner})`;
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function canonicalConstraint(definition: string): string {
  return canonicalExpr(parseExpr(definition));
}

/** The pairs below differ in meaning. If the canonical form ever equates one
 *  of them, every "identical" this script prints about constraints is void, so
 *  this is measured on every run and not trusted once. */
const CANONICAL_CONTROL: Array<[string, string, boolean]> = [
  // Same constraint, re-parenthesised by the parser: must compare equal.
  [
    'CHECK (((a IS NULL) OR (((length(a) >= 3) AND (length(a) <= 254)) AND (a = btrim(a)))))',
    'CHECK (((a IS NULL) OR ((length(a) >= 3) AND (length(a) <= 254) AND (a = btrim(a)))))',
    true,
  ],
  // Arithmetic grouping: must stay different.
  ['CHECK ((total_minor = ((unit_price_minor - discount_minor) * qty)))', 'CHECK ((total_minor = (unit_price_minor - discount_minor * qty)))', false],
  // AND inside OR versus OR inside AND: the second admits a line that is both
  // a debit and a credit. Must stay different.
  [
    'CHECK ((((debit_minor > 0) AND (credit_minor = 0)) OR (base_amount_minor = 0)))',
    'CHECK (((debit_minor > 0) AND ((credit_minor = 0) OR (base_amount_minor = 0))))',
    false,
  ],
  // A negated chain: with debit=false, credit=false and base=true the first is
  // true and the second is false. An earlier version of this canonical form
  // equated them, which is why the pair is here and not in a comment.
  [
    'CHECK ((NOT ((debit_minor > 0) AND (credit_minor > 0)) AND (base_amount_minor = 0)))',
    'CHECK ((NOT (debit_minor > 0) AND (credit_minor > 0) AND (base_amount_minor = 0)))',
    false,
  ],
  // A string literal carrying the word AND must not be read as an operator.
  ["CHECK (((note = 'cash AND credit') AND ((a > 0) AND (b > 0))))", "CHECK (((note = 'cash AND credit') AND (a > 0) AND (b > 0)))", true],
];

function canonicalControl(): string[] {
  const wrong: string[] = [];
  for (const [left, right, shouldMatch] of CANONICAL_CONTROL) {
    const equal = canonicalConstraint(left) === canonicalConstraint(right);
    if (equal !== shouldMatch) {
      wrong.push(
        shouldMatch
          ? `a pair that differs only in parenthesisation was read as different: ${left}`
          : `a pair that differs in meaning was read as the same: ${left} versus ${right}`,
      );
    }
  }
  return wrong;
}

/**
 * An ACL that grants everything to the owner and nothing to anybody else says
 * the same thing as no ACL at all: PostgreSQL stores NULL for that state and
 * writes it out explicitly once a grant has been made and taken back. The
 * restored copy therefore comes back with `(owner default)` where the source
 * held `{owner=arwdDxt/owner}` — the same privileges, a different spelling.
 *
 * Only that one shape is folded. An ACL that names anybody else, or that gives
 * the owner less than the full set, is left exactly as it is: those are the
 * differences this section exists to catch, and `REVOKE ... FROM PUBLIC` is
 * how this schema's security is written.
 */
const FULL_PRIVILEGES: Record<string, string> = {
  r: 'arwdDxt', // table
  v: 'arwdDxt', // view
  m: 'arwdDxt', // materialised view
  S: 'rwU', // sequence
};

function canonicalAcl(aclText: string, owner: string, kind: string): string {
  const marker = '(owner default)';
  if (aclText === marker || aclText === '') return marker;
  const inner = aclText.replace(/^\{/, '').replace(/\}$/, '').trim();
  if (inner === '') return marker;
  const entries = inner.split(',').map((entry) => entry.trim().replace(/^"|"$/g, ''));
  if (entries.length !== 1) return aclText;
  const match = /^([^=]*)=([a-zA-Z*]*)\/(.*)$/.exec(entries[0] ?? '');
  if (match === null) return aclText;
  const [, grantee, privileges, grantor] = match;
  if (grantee !== owner || grantor !== owner) return aclText;
  const full = FULL_PRIVILEGES[kind];
  if (full === undefined) return aclText;
  const held = new Set((privileges ?? '').replace(/\*/g, '').split(''));
  const wanted = new Set(full.split(''));
  if (held.size !== wanted.size) return aclText;
  for (const privilege of wanted) if (!held.has(privilege)) return aclText;
  return marker;
}

/** Pairs that must stay apart, measured on every run for the same reason as
 *  the constraint control: a fold that cannot tell them apart is not a fold. */
const ACL_CONTROL: Array<[string, string, string, boolean]> = [
  // Owner holds everything, nobody else is named: the same as no ACL.
  ['{drill=arwdDxt/drill}', 'drill', 'r', true],
  // PUBLIC gets SELECT: this is the difference the section exists for.
  ['{drill=arwdDxt/drill,=r/drill}', 'drill', 'r', false],
  // Another role gets INSERT.
  ['{drill=arwdDxt/drill,daftar_app=a/drill}', 'drill', 'r', false],
  // The owner has been reduced to SELECT: a real restriction, not a default.
  ['{drill=r/drill}', 'drill', 'r', false],
];

function aclControl(): string[] {
  const wrong: string[] = [];
  for (const [acl, owner, kind, foldsToDefault] of ACL_CONTROL) {
    const folded = canonicalAcl(acl, owner, kind) === '(owner default)';
    if (folded !== foldsToDefault) {
      wrong.push(
        foldsToDefault
          ? `an owner-only ACL was not read as the owner default: ${acl}`
          : `an ACL that grants to somebody else, or less than everything to the owner, was folded into the owner default: ${acl}`,
      );
    }
  }
  return wrong;
}

/**
 * Replaces each constraint definition with its canonical form, so the
 * comparison is blind to the parser's re-parenthesisation of a boolean chain
 * and to nothing else.
 */
function normalizeCensus(c: Census): Census {
  const out: Census = { ...c };
  if (Array.isArray(c.constraints)) {
    out.constraints = (c.constraints as Array<Record<string, Json>>).map((row) => ({
      ...row,
      definition: typeof row.definition === 'string' ? canonicalConstraint(row.definition) : row.definition,
    }));
  }
  if (Array.isArray(c.grants)) {
    out.grants = (c.grants as Array<Record<string, Json>>).map((row) => ({
      ...row,
      acl: typeof row.acl === 'string' && typeof row.owner === 'string' ? canonicalAcl(row.acl, row.owner, String(row.kind ?? 'r')) : row.acl,
    }));
  }
  return out;
}

/** Constraints whose text changed while their canonical form did not: the
 *  parser's own rendering, counted and named rather than hidden. */
function renderingOnlyDiffs(before: Census, after: Census): string[] {
  if (!Array.isArray(before.constraints) || !Array.isArray(after.constraints)) return [];
  const key = (row: Record<string, Json>): string => `${String(row.table)}.${String(row.constraint)}`;
  const left = new Map((before.constraints as Array<Record<string, Json>>).map((r) => [key(r), String(r.definition)]));
  const changed: string[] = [];
  for (const row of after.constraints as Array<Record<string, Json>>) {
    const was = left.get(key(row));
    if (was === undefined) continue;
    const now = String(row.definition);
    if (was !== now && canonicalConstraint(was) === canonicalConstraint(now)) changed.push(key(row));
  }
  return changed;
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
    record(
      `recreate:${label}`,
      'FAIL',
      'the target database name is not a plain identifier, and this drill will not interpolate anything else into a DROP statement',
    );
    return false;
  }
  const admin = pgEnv(dsn, 'postgres');
  const drop = run('psql', [...PSQL_FLAGS, '--command', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], admin);
  if (drop.code !== 0) {
    record(`recreate:${label}`, 'FAIL', `DROP DATABASE exited ${drop.code}: ${lastLines(drop.err, 1)}`);
    return false;
  }
  const create = run('psql', [...PSQL_FLAGS, '--command', `CREATE DATABASE "${name}"`], admin);
  if (create.code !== 0) {
    record(`recreate:${label}`, 'FAIL', `CREATE DATABASE exited ${create.code}: ${lastLines(create.err, 1)}`);
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
  // Decided here, not at the end: a run that stops early must keep what it
  // was told to keep, and delete what it was not.
  keepSecrets = keepDump;

  const sourceRaw = process.env.DR_DRILL_SOURCE_URL;
  const targetRaw = process.env.DR_DRILL_TARGET_URL;
  if (sourceRaw === undefined || sourceRaw.trim() === '')
    die(
      'DR_DRILL_SOURCE_URL is not set. Both connection strings come from the environment; neither is read from the command line nor from any file in this repository.',
    );
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
  SECRETS.push(source.password, target.password);
  let guarded = true;
  if (!DB_NAME_RULE.test(target.database) || !TARGET_NAME_RULE.test(target.database)) {
    record(
      'guard:target-name',
      'FAIL',
      'the target database is dropped and recreated, so its name must be a plain identifier ending in _restore or _drill_target',
    );
    guarded = false;
  } else {
    record('guard:target-name', 'PASS', `the target is "${target.database}"`);
  }
  if (process.env.DR_DRILL_CONFIRM_DROP !== target.database) {
    record(
      'guard:drop-confirmed',
      'FAIL',
      'DR_DRILL_CONFIRM_DROP must hold the exact name of the target database. The drop destroys whatever is in it, so it is not taken from the URL alone',
    );
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
  const who = psqlJson(sourceEnv, SQL.principal, 'source.principal') as {
    user: string;
    super: boolean;
    bypassrls: boolean;
    forcedRlsTables: number;
    serverVersion: string;
  } | null;
  if (who === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const canSeePastRls = who.super === true || who.bypassrls === true;
  record(
    'source:principal',
    canSeePastRls || who.forcedRlsTables === 0 ? 'PASS' : 'FAIL',
    `server ${who.serverVersion}, measured as "${who.user}" (super=${who.super}, bypassrls=${who.bypassrls}) against ${who.forcedRlsTables} tables under FORCE RLS` +
      (canSeePastRls || who.forcedRlsTables === 0 ? '' : ' — this principal reads those tables as empty, so neither the census nor the dump can be trusted'),
  );
  if (failed) return finish(artifactDir, rtoSeconds, null, source, target);

  // 2b. Which cluster each side is in, asked of the servers themselves. Three
  //     spellings of one host are one cluster, and a target that turns out to
  //     be the source under another spelling must not be dropped.
  const sourceIdentity = psqlJson(sourceEnv, SQL.identity, 'source.identity') as { cluster: string; database: string } | null;
  if (sourceIdentity === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const targetProbe = psql(targetEnv, SQL.identity);
  let targetIdentity: { cluster: string; database: string } | null = null;
  if (targetProbe.code === 0 && targetProbe.out.trim() !== '') {
    targetIdentity = JSON.parse(targetProbe.out.trim()) as { cluster: string; database: string };
  } else if (!/does not exist/i.test(targetProbe.err)) {
    record(
      'guard:not-the-source',
      'FAIL',
      `the target server could not be asked who it is (psql exited ${targetProbe.code}), and a drop is not issued against an unidentified database`,
    );
    return finish(artifactDir, rtoSeconds, null, source, target);
  }
  if (targetIdentity !== null && targetIdentity.cluster === sourceIdentity.cluster && targetIdentity.database === sourceIdentity.database) {
    record(
      'guard:not-the-source',
      'FAIL',
      `the target is the source: both answered with cluster ${sourceIdentity.cluster} and database "${sourceIdentity.database}". The two connection strings spell it differently, and the drop would have destroyed the source`,
    );
    return finish(artifactDir, rtoSeconds, null, source, target);
  }
  // Decided from the servers alone. When the target does not exist yet there is
  // nothing to ask, so the question is asked again once it has been created —
  // never answered by comparing how the two URLs spell the host.
  let sameCluster: boolean | null = targetIdentity === null ? null : targetIdentity.cluster === sourceIdentity.cluster;
  record(
    'guard:not-the-source',
    'PASS',
    targetIdentity === null
      ? `the source is database "${sourceIdentity.database}" of cluster ${sourceIdentity.cluster}; the target does not exist yet, so it is not the source`
      : `the source is "${sourceIdentity.database}" of cluster ${sourceIdentity.cluster} and the target is "${targetIdentity.database}" of cluster ${targetIdentity.cluster}, asked of the servers and not read off the URLs`,
  );

  // 3. What the source holds, before anything is touched. An empty source
  //    proves nothing, so it is a failure.
  const before = census(sourceEnv, 'source');
  if (before === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const tables = Array.isArray(before.tables) ? (before.tables as Array<{ table: string; rows: number }>) : [];
  const rowTotal = tables.reduce((a, t) => a + Number(t.rows), 0);
  record(
    'census:source',
    tables.length > 0 && rowTotal > 0 ? 'PASS' : 'FAIL',
    `${tables.length} tables, ${rowTotal} rows, ` +
      `${(before.policies as Json[] | undefined)?.length ?? 0} RLS policies, ` +
      `${(before.grants as Json[] | undefined)?.length ?? 0} grants, ` +
      `${(before.triggers as Json[] | undefined)?.length ?? 0} triggers, ` +
      `${(before.constraints as Json[] | undefined)?.length ?? 0} constraints, ` +
      `${(before.indexes as Json[] | undefined)?.length ?? 0} indexes, ` +
      `${(before.routines as Json[] | undefined)?.length ?? 0} routines, ` +
      `${(before.routineGrants as Json[] | undefined)?.length ?? 0} routine grants, ` +
      `${(before.columnGrants as Json[] | undefined)?.length ?? 0} column grants` +
      (tables.length === 0 || rowTotal === 0 ? ' — a source with no rows cannot show that a restore keeps anything' : ''),
  );
  if (failed) return finish(artifactDir, rtoSeconds, null, source, target);

  // 4. The dump. Custom format: pg_restore can read its table of contents, and
  //    a truncated file is detectable.
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const dumpPath = join(artifactDir, `dump-${source.database}.pgc`);
  const globalsPath = join(artifactDir, 'globals.sql');
  // Registered before the tool runs: a pg_dump or pg_dumpall that fails after
  // writing part of its output still leaves a file to delete.
  artifactsToRemove.push(dumpPath, globalsPath);
  let t0 = Date.now();
  const dump = run('pg_dump', ['--format=custom', '--no-password', `--file=${dumpPath}`], sourceEnv);
  const dumpSeconds = (Date.now() - t0) / 1000;
  if (dump.code !== 0) {
    record('backup:dump', 'FAIL', `pg_dump exited ${dump.code}: ${lastLines(dump.err, 1)}`, dumpSeconds);
    return finish(artifactDir, rtoSeconds, null, source, target);
  }
  chmodSync(dumpPath, 0o600);
  const bytes = statSync(dumpPath).size;
  const sha = sha256OfFile(dumpPath);
  record(
    'backup:dump',
    bytes > 0 ? 'PASS' : 'FAIL',
    `${bytes} bytes, sha256 ${sha.slice(0, 16)}…, mode ${(statSync(dumpPath).mode & 0o777).toString(8)}`,
    dumpSeconds,
  );

  // The source must not have changed while it was being dumped, or a later
  // difference cannot be told apart from a restore fault.
  const duringDump = census(sourceEnv, 'source-after-dump');
  if (duringDump === null) return finish(artifactDir, rtoSeconds, null, source, target);
  const moved = compare(before, duringDump);
  if (moved.length > 0) {
    // Nothing is dropped after this: the measurement is void, and the drill
    // stops rather than carrying on with a comparison it cannot read.
    record(
      'source:quiescent',
      'FAIL',
      `the source changed while it was dumped, so no later comparison can separate that from a restore fault, and nothing was dropped: ${lastLines(moved[0] ?? '', 1).slice(0, 160)}`,
    );
    return finish(artifactDir, rtoSeconds, null, source, target);
  }
  record(
    'source:quiescent',
    'PASS',
    'the source read the same before and after the dump. This is a check on the two ends, not a shared snapshot: pg_dump --snapshot inside an exported REPEATABLE READ transaction would be the stronger form, and this drill does not do it',
  );

  // Roles and their privileges live in the cluster, not in the database: a
  // database restored without them carries grants naming roles that do not
  // exist. The file holds password hashes, so it is 0600 and is removed with
  // the dump unless it is explicitly kept.
  t0 = Date.now();
  const globals = run('pg_dumpall', ['--globals-only', '--no-password', `--file=${globalsPath}`], pgEnv(source, 'postgres'));
  if (globals.code === 0) {
    // pg_dumpall writes through the umask, so the mode is set here and then
    // read back: the claim is the measured mode, not the intended one.
    chmodSync(globalsPath, 0o600);
    const mode = (statSync(globalsPath).mode & 0o777).toString(8);
    const roleLines = run('grep', ['-c', '^CREATE ROLE', globalsPath]);
    record(
      'backup:globals',
      mode === '600' ? 'PASS' : 'FAIL',
      `the cluster's roles and privileges were written separately (${statSync(globalsPath).size} bytes, ${roleLines.out.trim() || '0'} CREATE ROLE statements, mode ${mode} as read back from disk). This file carries the roles' password hashes, is not part of the database dump, and is removed on every exit path unless --keep-dump`,
      (Date.now() - t0) / 1000,
    );
  } else {
    record('backup:globals', 'FAIL', `pg_dumpall exited ${globals.code}: ${lastLines(globals.err, 1)}`, (Date.now() - t0) / 1000);
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
      record(
        'guard:target-empty',
        'FAIL',
        `the target could not be read before the drop (psql exited ${probe.code}), and a drop is not issued against a database whose contents are unknown: ${lastLines(probe.err, 1)}`,
      );
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
  } else {
    existingRows = Number(probe.out.trim());
    if (!Number.isFinite(existingRows)) {
      record(
        'guard:target-empty',
        'FAIL',
        'the row count of the target did not read as a number, and a drop is not issued against a database whose contents are unknown',
      );
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
    const allowance = process.env.DR_DRILL_ALLOW_NONEMPTY_TARGET;
    if (existingRows > 0 && allowance !== String(existingRows)) {
      record(
        'guard:target-empty',
        'FAIL',
        `the target holds ${existingRows} rows. Dropping it destroys them, so it is refused unless DR_DRILL_ALLOW_NONEMPTY_TARGET names that very number — ${existingRows} — which is how an allowance stays tied to what was actually measured instead of standing open`,
      );
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
    record(
      'guard:target-empty',
      'PASS',
      existingRows === 0
        ? 'the target exists and holds no rows'
        : `the target holds ${existingRows} rows, and DR_DRILL_ALLOW_NONEMPTY_TARGET named that same number, so the drop was allowed`,
    );
  }

  // 6. The restore, measured. This number is the one compared against the RTO.
  if (!recreate(target, 'restore-target')) return finish(artifactDir, rtoSeconds, null, source, target);
  if (sameCluster === null) {
    const freshIdentity = psqlJson(targetEnv, SQL.identity, 'target.identity') as { cluster: string; database: string } | null;
    if (freshIdentity === null) return finish(artifactDir, rtoSeconds, null, source, target);
    sameCluster = freshIdentity.cluster === sourceIdentity.cluster;
    if (sameCluster && freshIdentity.database === sourceIdentity.database) {
      record('guard:not-the-source', 'FAIL', 'the freshly created target turned out to be the source; nothing further was done to it');
      return finish(artifactDir, rtoSeconds, null, source, target);
    }
  }
  t0 = Date.now();
  const restore = run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', `--dbname=${target.database}`, dumpPath], targetEnv);
  const restoreSeconds = (Date.now() - t0) / 1000;
  if (restore.code !== 0) {
    record('restore', 'FAIL', `pg_restore exited ${restore.code}: ${lastLines(restore.err, 2)}`, restoreSeconds);
    return finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
  }
  record('restore', 'PASS', 'pg_restore completed in one transaction', restoreSeconds);

  // 7. The comparison.
  const after = census(targetEnv, 'restored');
  if (after === null) return finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
  // The canonical form is only allowed to blur the parser's own
  // re-parenthesisation, and that is measured here, on this run, against pairs
  // that differ in meaning.
  const controlFailures = [...canonicalControl(), ...aclControl()];
  record(
    'control:constraint-canonicalisation',
    controlFailures.length === 0 ? 'PASS' : 'FAIL',
    controlFailures.length === 0
      ? `the canonical forms kept ${CANONICAL_CONTROL.filter(([, , same]) => !same).length} meaning-changing pairs apart — among them (A AND B) OR C against A AND (B OR C), and NOT (A AND B) AND C against NOT A AND B AND C — and equated ${CANONICAL_CONTROL.filter(([, , same]) => same).length} pairs that differ only in the parser's parenthesisation; and the ACL fold kept ${ACL_CONTROL.filter(([, , , folds]) => !folds).length} ACLs apart — PUBLIC with SELECT, another role with INSERT, and an owner cut down to SELECT — while folding an owner-only ACL into the owner default`
      : controlFailures.join(' | '),
  );

  const rendering = renderingOnlyDiffs(before, after);
  const diffs = compare(normalizeCensus(before), normalizeCensus(after));
  record(
    'note:constraint-rendering',
    'PASS',
    rendering.length === 0
      ? 'no constraint came back with a different rendering'
      : `${rendering.length} check constraints came back with a different text whose canonical form is unchanged — the parser flattening a chain of one boolean operator: ${rendering.slice(0, 4).join(', ')}${rendering.length > 4 ? ', …' : ''}`,
  );
  record('compare:census', diffs.length === 0 ? 'PASS' : 'FAIL', diffs.length === 0 ? `identical across ${CENSUS_SECTIONS.join(', ')}` : diffs.join(' | '));

  // A section that read nothing on both sides compared equal without measuring
  // anything. It is named and the verdict becomes INCOMPLETE.
  const empty = CENSUS_SECTIONS.filter((section) => {
    const a = before[section];
    const b = after[section];
    return Array.isArray(a) && Array.isArray(b) && a.length === 0 && b.length === 0;
  });
  const notArrays = CENSUS_SECTIONS.filter((section) => !Array.isArray(before[section]));
  // Two different things, kept apart: a section that is an empty list on both
  // sides (the schema may simply have none of that object), and a section that
  // is not a list at all because the thing it reads is absent — the migration
  // ledger, which this schema does not create. Only the first can be
  // acknowledged; the second is never a pass, because nothing was read.
  const emptyLists = empty.slice().sort();
  const unread = notArrays.slice().sort();
  const acknowledged = (process.env.DR_DRILL_EMPTY_SECTIONS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .sort();
  const measured = CENSUS_SECTIONS.length - emptyLists.length - unread.length;
  if (unread.length > 0) {
    record(
      'scope:sections-that-measured-something',
      'SKIPPED',
      `${measured} of ${CENSUS_SECTIONS.length} sections compared a measurement. These read nothing at all, so their "identical" is not a comparison and cannot be acknowledged away: ${unread.join(', ')}` +
        (emptyLists.length > 0 ? `. And these were empty lists on both sides: ${emptyLists.join(', ')}` : ''),
    );
  } else if (emptyLists.length === 0) {
    record(
      'scope:sections-that-measured-something',
      'PASS',
      `all ${CENSUS_SECTIONS.length} sections held something on both sides, so each of them compared a measurement`,
    );
  } else if (acknowledged.length > 0 && JSON.stringify(acknowledged) === JSON.stringify(emptyLists)) {
    record(
      'scope:sections-that-measured-something',
      'PASS',
      `${measured} of ${CENSUS_SECTIONS.length} sections compared a measurement; these were empty lists on both sides and DR_DRILL_EMPTY_SECTIONS names exactly them, so their emptiness is acknowledged rather than read as proof: ${emptyLists.join(', ')}`,
    );
  } else {
    record(
      'scope:sections-that-measured-something',
      'SKIPPED',
      `these were empty lists on both sides, so their "identical" measured nothing: ${emptyLists.join(', ')}` +
        (acknowledged.length === 0
          ? '. Set DR_DRILL_EMPTY_SECTIONS to exactly that list once it is established that this schema has none of them'
          : `. DR_DRILL_EMPTY_SECTIONS names ${acknowledged.join(', ')}, which is not that list`),
    );
  }

  // Role identity is a property of the cluster, not of the database. When one
  // cluster holds both, those sections cannot fail, and the owner's condition
  // on roles and privileges is therefore NOT measured by this run.
  if (sameCluster) {
    record(
      'scope:roles-across-clusters',
      'SKIPPED',
      'the source and the target are in one cluster (same system identifier), so "owners" and the role names inside "grants" and "policies" refer to the same cluster-level roles on both sides and cannot differ. Losing a grant or a policy would still be caught, but a restore that lands where the roles do not exist is not tested here: that needs a second cluster and the separate globals file, which this drill writes and does not restore',
    );
  } else {
    record(
      'scope:roles-across-clusters',
      'PASS',
      'the source and the target are in different clusters, so the role-bearing sections compared something that could have differed',
    );
  }

  // 8. The financial invariants, on the restored copy, each only where its
  //    table exists and holds rows.
  for (const inv of INVARIANTS) {
    const rows = psqlJson(
      targetEnv,
      `SELECT CASE WHEN to_regclass('public.${inv.table}') IS NULL THEN '-1'::json
      ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', '${inv.table}'), false, true, '')))[1]::text::json END`,
      `restored.rows.${inv.table}`,
    );
    const n = rows === null ? -1 : Number(rows);
    if (n < 0) {
      record(`invariant:${inv.id}`, 'SKIPPED', `public.${inv.table} is not in the restored database`);
      continue;
    }
    if (n === 0) {
      record(
        `invariant:${inv.id}`,
        'SKIPPED',
        `public.${inv.table} is empty in the restored database, and zero violations in an empty table is not a measurement`,
      );
      continue;
    }
    const bad = psql(targetEnv, inv.sql);
    if (bad.code !== 0) {
      record(`invariant:${inv.id}`, 'FAIL', `the check itself did not run (psql exited ${bad.code})`);
      continue;
    }
    const violations = bad.out.trim();
    record(
      `invariant:${inv.id}`,
      violations === '0' ? 'PASS' : 'FAIL',
      violations === '0' ? `zero violating rows out of ${n}` : `${violations} violating rows out of ${n}`,
    );
  }

  // 9. The control on the comparison itself: a comparison that cannot fail is
  //    not a comparison (RULE-11). Tested on its own arithmetic, and then on
  //    this very database.
  const perturbed = JSON.parse(JSON.stringify(before)) as Census;
  const perturbedTables = perturbed.tables as Array<{ table: string; rows: number }>;
  const firstTable = perturbedTables[0];
  if (firstTable === undefined) {
    record('control:comparison-arithmetic', 'FAIL', 'the source census carried no table, so the comparison was never tested against a difference');
    return finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
  }
  firstTable.rows = Number(firstTable.rows) + 1;
  const arithmetic = compare(before, perturbed);
  record(
    'control:comparison-arithmetic',
    arithmetic.length > 0 ? 'PASS' : 'FAIL',
    arithmetic.length > 0
      ? `moving the row count of ${firstTable.table} by one was reported`
      : 'moving a row count by one went unreported — every comparison above is worthless',
  );

  if (withComparatorProof) {
    const listed = psql(
      targetEnv,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r'
         AND (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint > 0
       ORDER BY c.relname`,
    );
    if (listed.code !== 0) {
      record('control:comparison-on-database', 'FAIL', `the non-empty tables of the restored copy could not be listed (psql exited ${listed.code})`);
    } else {
      const candidates = listed.out
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => DB_NAME_RULE.test(x));
      let mutatedTable = '';
      const refused: Array<{ table: string; reason: string }> = [];
      for (const table of candidates) {
        // Through format(%I) server-side, so the name is quoted by the server.
        const del = psql(
          targetEnv,
          `DO $$ BEGIN EXECUTE format('DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I LIMIT 1)', '${table}', '${table}'); END $$`,
        );
        if (del.code === 0) {
          mutatedTable = table;
          break;
        }
        refused.push({ table, reason: del.err.match(/ERROR:\s*([^\n]{0,80})/)?.[1] ?? 'unknown' });
      }
      if (mutatedTable === '') {
        record(
          'control:comparison-on-database',
          'FAIL',
          `no row could be deleted from the restored copy (${candidates.length} non-empty tables; the first refusals were ${JSON.stringify(refused.slice(0, 3))}), so the census was never tested against a real difference`,
        );
      } else {
        const mutatedCensus = census(targetEnv, 'mutated');
        const seen = mutatedCensus === null ? ['the mutated copy could not be read'] : compare(normalizeCensus(before), normalizeCensus(mutatedCensus));
        record(
          'control:comparison-on-database',
          seen.length > 0 ? 'PASS' : 'FAIL',
          seen.length > 0
            ? `one row deleted from public.${mutatedTable} was detected. ${refused.length} earlier tables refused the delete, each with its reason: ${JSON.stringify(refused.slice(0, 3))}`
            : `one row deleted from public.${mutatedTable} went unnoticed — every comparison above is worthless`,
        );
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
    record(
      'negative-control:truncated-dump',
      recreated && attempt.code !== 0 ? 'PASS' : 'FAIL',
      !recreated
        ? 'the control database could not be recreated, so a broken dump was never offered to pg_restore'
        : attempt.code !== 0
          ? `a dump truncated to 60% was refused (pg_restore exited ${attempt.code}; its table of contents ${toc.code === 0 ? 'still listed' : 'failed to list'})`
          : 'a truncated dump restored without error — this drill cannot tell a whole backup from a broken one',
    );
    const brokenSha = sha256OfFile(brokenPath);
    record(
      'negative-control:checksum',
      brokenSha !== sha ? 'PASS' : 'FAIL',
      brokenSha !== sha
        ? 'the altered file does not match the recorded sha256'
        : 'the altered file matched the recorded sha256, so the checksum proves nothing',
    );
    unlinkSync(brokenPath);
  } else {
    record('negative-control:truncated-dump', 'SKIPPED', '--no-negative-control was passed, so a broken dump was never offered to pg_restore');
  }

  if (keepDump) {
    record(
      'cleanup:artifacts',
      'PASS',
      `--keep-dump was passed, so the dump and ${globalsPath} remain on disk, mode 0600. The globals file carries the cluster's password hashes: it belongs in a secret store or nowhere`,
    );
  }

  // 11. The target is scratch, and by now it also holds the one row the control
  //      deleted, so it is dropped unless it is wanted for inspection. This is
  //      also what lets the next run start without being asked to allow a drop.
  if (keepTarget) {
    record(
      'cleanup:target',
      'PASS',
      `--keep-target was passed, so "${target.database}" is left as it is — with the one row the comparison control deleted still missing, which is why it is not a copy to trust`,
    );
  } else {
    const name = target.database;
    const drop = run('psql', [...PSQL_FLAGS, '--command', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], pgEnv(target, 'postgres'));
    record(
      'cleanup:target',
      drop.code === 0 ? 'PASS' : 'FAIL',
      drop.code === 0
        ? `the restored copy was dropped: it is scratch, and the comparison control deleted a row from it`
        : `the restored copy could not be dropped (psql exited ${drop.code}), so the next run will refuse it as a non-empty target: ${lastLines(drop.err, 1)}`,
    );
  }

  finish(artifactDir, rtoSeconds, restoreSeconds, source, target);
}

function finish(artifactDir: string, rtoSeconds: number, restoreSeconds: number | null, source: Dsn, target: Dsn): void {
  // Every exit path comes through here, including the ones that failed before
  // the restore: the globals file carries password hashes, and a drill that
  // stopped early must not leave it behind.
  const removed: string[] = [];
  for (const path of keepSecrets ? [] : artifactsToRemove) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        removed.push(path);
      }
    } catch (error) {
      record('cleanup:secrets', 'FAIL', `${path} could not be deleted and it may carry a password hash: ${scrub(String(error))}`);
    }
  }
  if (removed.length > 0) {
    record('cleanup:secrets', 'PASS', `deleted on the way out: ${removed.join(', ')}`);
  }

  if (restoreSeconds === null) {
    record('rto', 'FAIL', 'no restore was measured, so nothing can be compared against the RTO');
  } else {
    record(
      'rto',
      restoreSeconds <= rtoSeconds ? 'PASS' : 'FAIL',
      `the restore took ${restoreSeconds.toFixed(3)}s against an RTO of ${rtoSeconds}s — the time of this database on this machine, which is not the production time and is not an estimate of it`,
    );
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
  process.stdout.write(
    `verdict ${failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS'} — ${counts.PASS ?? 0} passed, ${counts.FAIL ?? 0} failed, ${counts.SKIPPED ?? 0} skipped\n`,
  );
  process.exit(failed ? 1 : incomplete ? 3 : 0);
}

if (!existsSync('package.json')) die('run this from the repository root');

// finish() calls process.exit, so the normal paths never reach the catch. What
// does reach it is a throw from anywhere else — a JSON body that is not JSON, a
// file that cannot be read — and that path must still delete the dump and the
// globals file, which carry data and password hashes.
try {
  main();
} catch (error) {
  process.stderr.write(`the drill stopped on an unexpected error: ${scrub(String(error))}\n`);
  for (const path of keepSecrets ? [] : artifactsToRemove) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        process.stderr.write(`deleted on the way out: ${path}\n`);
      }
    } catch {
      process.stderr.write(`could not delete ${path}, which may carry a password hash\n`);
    }
  }
  process.exit(1);
}
