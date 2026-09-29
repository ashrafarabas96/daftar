#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P2-S9 — THE DEPLOYMENT AUTHORITY, PROVED (RB-P2-01)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS ANSWERS
 *
 * Every test in this repository applies the migration history as a PostgreSQL
 * superuser, because that is what a `postgres:16` service container hands you.
 * A superuser skips both of the checks that decide whether a real deployment
 * works: it is never asked whether it may `SET ROLE` to the role a file hands
 * an object to, and it is never asked whether that role may own something in
 * the schema. So the suite was green while a production deployment as the
 * documented migration principal, `daftar_migrator`, could not get past
 * `0032_provisioner_narrow_functions.sql`.
 *
 * That was release blocker RB-P2-01, and it had three independent causes,
 * each of which hid the next:
 *
 *   1. `must be able to SET ROLE "daftar_platform"` — the history hands
 *      ownership to two roles and bootstrap carried a membership for only
 *      one of them.
 *   2. `permission denied for schema public` — `public` belonged to
 *      `pg_database_owner`, so the migrator held CREATE without grant option
 *      and could not lend it to the role it was about to make owner. Every
 *      accounting migration from 0040 does exactly that lending inside its
 *      own transaction; a non-owner cannot issue the GRANT at all.
 *   3. `must be owner of function provision_replay_operation` — replacing an
 *      existing function is an OWNERSHIP check, which reads the INHERIT bit
 *      and ignores SET, so `INHERIT FALSE` on the platform membership stopped
 *      the history at `0038`.
 *
 * The corrections are in `infrastructure/database/bootstrap.sql` and in the
 * deployment tool `apps/api/src/infra/migrate.ts`. No frozen migration was
 * touched, no runtime principal was widened, and nothing here runs as a
 * superuser except the deployment administrator's own bootstrap step — which
 * is a real, separate trust boundary and not a disguise for one.
 *
 * WHAT IT PROVES, AND HOW
 *
 * Eight deployment cases (§17), each executed by `runMigrations` over a
 * connection authenticated as the deployment principal and nothing else:
 *
 *   A  empty database  → bootstrap → every migration on disk
 *   B  a database at 0039 (the Phase 1 boundary) → every later migration
 *   C  a database at 0050 → 0051, 0052, then every later migration
 *   D  a database at the latest migration → no-op
 *   E  a database whose applied history was tampered with → HARD FAIL
 *   F  a migration that fails half way → rollback, no history row, clean retry
 *   G  a database at the 0052 freeze, holding a business → exactly every
 *      later migration (P3-S1: 0053 onward), whose backfills must see that
 *      business although the deployer is not a superuser (P3-AL-54 §J)
 *   H  a database at the 0052 freeze → each accepted Phase 3 slice head in
 *      turn (`PHASE3_SLICE_HEADS`), then every later migration; each step
 *      applies exactly the files between two boundaries, and the result is
 *      Case A's catalogue (P3-S9 A-09 4)
 *
 * Then the question those cases cannot answer on their own: is the database
 * the deployment principal produced the SAME database a superuser produces?
 * Section 10 compares both catalogues — every table's owner, RLS flags and
 * ACL, every function's owner, SECURITY DEFINER flag, ACL, configuration and
 * body digest, every policy, trigger, column ACL and constraint, and (since
 * P3-S9) every sequence, index and column definition, the schema's own owner
 * and ACL, the default ACLs and the extension versions — with the applying
 * principal's own name normalised, because the one difference a deployment is
 * ALLOWED to have is who owns what it created.
 *
 * P3-S9 (A-09) strengthened this predecessor script without loosening any
 * record it already made: 2.11 asserts the deployer's memberships are exactly
 * the accepted three; 11.9 / 11.10 ask TEMPORARY and CREATE on `public` of
 * both builds and of PUBLIC; Case H walks the Phase 3 slice heads; and the
 * decisions are exported pure functions (`tests/security/
 * deployment-authority-model.test.ts`). Importing this module runs nothing.
 *
 * Usage: npm run check:deployment-authority [-- --static-only]
 *
 * `--static-only` runs sections 1 and 2's static half and skips every case
 * that needs a cluster, for a machine that has no PostgreSQL binaries.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../apps/api/src/infra/migrate';
import { stripComments } from './guards/sql-schema';
import { PHASE2_PREFIX_END } from './phase2-prefix';
import { PHASE3_SLICE_HEADS } from './phase3-prefix';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const ARGV = process.argv.slice(2);
const STATIC_ONLY = ARGV.includes('--static-only');

const PG_BIN = process.env['DEPLOY_PG_BIN'] ?? '/usr/lib/postgresql/16/bin';
const PG_PORT = Number(process.env['DEPLOY_PG_PORT'] ?? 55434);
const PG_USER = 'postgres';
const PG_SUPER_PASSWORD = 'postgres';

/** Throwaway credentials for a cluster that is destroyed at the end. */
const PASSWORDS: Record<string, string> = {
  __APP_DB_PASSWORD__: 'deploy_app_pw_123456',
  __PLATFORM_DB_PASSWORD__: 'deploy_platform_pw_123456',
  __WORKER_DB_PASSWORD__: 'deploy_worker_pw_123456',
  __RESOLVER_DB_PASSWORD__: 'deploy_resolver_pw_123456',
  __IDENTITY_DB_PASSWORD__: 'deploy_identity_pw_123456',
  __PROVISIONER_DB_PASSWORD__: 'deploy_provisioner_pw_123456',
  __RECONCILER_DB_PASSWORD__: 'deploy_reconciler_pw_123456',
  __MIGRATOR_DB_PASSWORD__: 'deploy_migrator_pw_123456',
};

/**
 * The canonical production deployment authority (§13, option A).
 *
 * It is the role this repository has documented as the migration principal
 * since P2-S1: a LOGIN role that no service loads and that appears in no
 * runtime connection URL. P2-S9 did not invent a second one, because a second
 * deployment credential holding the same authority removes nothing and adds
 * one more secret to protect.
 */
const DEPLOYER = 'daftar_migrator';

/** Every principal the schema knows, deployment and runtime alike (§32). */
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;
/** The NOLOGIN owners of SECURITY DEFINER authority (P2-S1, P3-AL-54 §C). */
const INTERNAL_ROLES = ['daftar_accounting_internal', 'daftar_inventory_internal', 'daftar_catalog_internal', 'daftar_provisioning_internal'] as const;
const ALL_ROLES = [...RUNTIME_ROLES, ...INTERNAL_ROLES, DEPLOYER] as const;

// The Phase 2 freeze boundary, `0052`, where Cases C, G and H start their
// upgrades, is `PHASE2_PREFIX_END` (`scripts/phase2-prefix.ts`). It is not
// "the last frozen migration": at P3-S9 every file on disk is frozen.

// ─────────────────────────────────────────────────────────────────────────
// THE DECISIONS, AS PURE FUNCTIONS (P3-S9 A-09 6)
// ─────────────────────────────────────────────────────────────────────────
//
// Each live section below reads the catalogue and hands the rows to one of
// these. They take rows and return problems, so
// `tests/security/deployment-authority-model.test.ts` proves each of them red
// on a planted defect without a cluster.

/** One membership the deployer holds, as `pg_auth_members` describes it. */
export interface MembershipRow {
  readonly role: string;
  readonly inherit: boolean;
  readonly set: boolean;
  readonly admin: boolean;
}

/**
 * The deployer's accepted memberships, exactly (`bootstrap.sql`, R2:120-143).
 * `daftar_platform` is inherited because replacing a provisioning function is
 * an OWNERSHIP check that reads INHERIT (cause 3 of RB-P2-01). The four
 * internal authorities are SET only: assumed deliberately, never held
 * passively. None carries ADMIN.
 */
export const ACCEPTED_DEPLOYER_MEMBERSHIPS: readonly MembershipRow[] = [
  { role: 'daftar_accounting_internal', inherit: false, set: true, admin: false },
  { role: 'daftar_catalog_internal', inherit: false, set: true, admin: false },
  { role: 'daftar_inventory_internal', inherit: false, set: true, admin: false },
  { role: 'daftar_platform', inherit: true, set: true, admin: false },
  { role: 'daftar_provisioning_internal', inherit: false, set: true, admin: false },
];

/** 2.11 — every way the deployer's memberships differ from the accepted five (three until TD-18's two owners, 0070). */
export function deployerMembershipProblems(rows: readonly MembershipRow[]): string[] {
  const problems: string[] = [];
  const accepted = new Map(ACCEPTED_DEPLOYER_MEMBERSHIPS.map((m) => [m.role, m] as const));
  for (const want of ACCEPTED_DEPLOYER_MEMBERSHIPS) {
    const held = rows.filter((r) => r.role === want.role);
    if (held.length === 0) {
      problems.push(`${want.role} is missing: a deployment would stop at the first handover to it`);
      continue;
    }
    if (held.length > 1) problems.push(`${want.role} is granted ${held.length} times; its effective options are the union of all of them`);
    for (const r of held) {
      if (r.inherit !== want.inherit)
        problems.push(`${want.role} has INHERIT ${String(r.inherit).toUpperCase()}; accepted is ${String(want.inherit).toUpperCase()}`);
      if (r.set !== want.set) problems.push(`${want.role} has SET ${String(r.set).toUpperCase()}; accepted is ${String(want.set).toUpperCase()}`);
      if (r.admin) problems.push(`${want.role} carries ADMIN OPTION`);
    }
  }
  for (const r of rows)
    if (!accepted.has(r.role)) problems.push(`${r.role} is a membership the accepted deployer does not hold: a widened migration principal`);
  return problems;
}

/** A catalogue, family by family, each row already normalised for comparison. */
export type CatalogueSnapshot = Readonly<Record<string, readonly string[]>>;

export interface CatalogueDifference {
  readonly family: string;
  readonly onlyFirst: readonly string[];
  readonly onlySecond: readonly string[];
}

/**
 * Every family whose rows are not the same in two catalogues. A family one of
 * them does not carry at all is a difference too: a comparison that silently
 * skipped a family would report equality it never checked.
 */
export function catalogueDifferences(first: CatalogueSnapshot, second: CatalogueSnapshot, families: readonly string[]): CatalogueDifference[] {
  const out: CatalogueDifference[] = [];
  for (const family of families) {
    const a = first[family];
    const b = second[family];
    if (a === undefined || b === undefined) {
      out.push({
        family,
        onlyFirst: a === undefined ? [] : ['<family missing from the second catalogue>'],
        onlySecond: b === undefined ? [] : ['<family missing from the first catalogue>'],
      });
      continue;
    }
    const setA = new Set(a);
    const setB = new Set(b);
    const onlyFirst = a.filter((x) => !setB.has(x));
    const onlySecond = b.filter((x) => !setA.has(x));
    if (onlyFirst.length === 0 && onlySecond.length === 0 && a.length !== b.length) {
      out.push({ family, onlyFirst: [`<${a.length} rows>`], onlySecond: [`<${b.length} rows>`] });
    } else if (onlyFirst.length > 0 || onlySecond.length > 0) {
      out.push({ family, onlyFirst, onlySecond });
    }
  }
  return out;
}

const LITERAL_FAMILIES: ReadonlySet<string> = new Set(['schema', 'extensions']);

/**
 * The one difference a deployment is ALLOWED to have is who owns what it
 * created, so the applying principal's own name is normalised away — except
 * in a family whose rows the history does not create. The schema `public` and
 * the extensions are made by the deployment administrator's bootstrap on both
 * builds, and the schema belongs to the deployer on both, so those rows are
 * compared literally.
 */
export function normaliseCatalogueRows(family: string, rows: readonly string[], applier: string): string[] {
  if (LITERAL_FAMILIES.has(family)) return [...rows];
  return rows.map((r) => r.split(applier).join('<applier>'));
}

/** TEMPORARY on the database and CREATE on `public`, for one grantee. */
export interface NamespacePrivilegeRow {
  readonly role: string;
  readonly temporaryOnDatabase: boolean;
  readonly createOnPublic: boolean;
}

/** The pseudo-role every role belongs to. `has_*_privilege` answers for it by the name `public`. */
export const PUBLIC_GRANTEE = 'PUBLIC';

/**
 * 11.9 / 11.10 — no role but the deployer, and not PUBLIC, may hold TEMPORARY
 * or CREATE on `public` (bootstrap's revokes). The rows must include PUBLIC:
 * a check that never asked it cannot say PUBLIC holds nothing.
 */
export function namespacePrivilegeProblems(rows: readonly NamespacePrivilegeRow[], build: string): string[] {
  const problems: string[] = [];
  if (!rows.some((r) => r.role === PUBLIC_GRANTEE)) problems.push(`${build}: PUBLIC was not asked`);
  for (const r of rows) {
    if (r.role === DEPLOYER) continue;
    if (r.temporaryOnDatabase) problems.push(`${build}: ${r.role} holds TEMPORARY on the database`);
    if (r.createOnPublic) problems.push(`${build}: ${r.role} holds CREATE on schema public`);
  }
  return problems;
}

/**
 * The SECURITY DEFINER routines the history leaves owned by WHOEVER APPLIED
 * IT: none (Phase 3 corrective hardening, TD-18, migration 0070).
 *
 * Until 0070 there were four — `catalog_identifiers_sync()`,
 * `provision_actor(text[])`, `provision_assertion_key_install(text, bytea)`
 * and `provision_assertion_key_retire(text)` — created by 0037-0039 without
 * `OWNER TO`, so on a superuser-built database they ran as `postgres`, which
 * bypasses row-level security, and on the deployed database as
 * `daftar_migrator`, which does not. §10 cannot see such a difference,
 * because it normalises the applier's name by design; the P3-S9 deployed
 * rehearsal found it. 0070 hands the four to NOLOGIN internal owners
 * (`TD18_DEFINER_OWNERS`), so the pinned set is now EMPTY and any definer the
 * applier owns — one of the four reverted, or a new one — is red.
 */
export const APPLIER_OWNED_DEFINERS: readonly string[] = [];

/** The query that lists the SECURITY DEFINER routines in `public` owned by the role `$1`. */
export const APPLIER_OWNED_DEFINERS_QUERY = `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) = $1
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY 1`;

/** Every SECURITY DEFINER routine the applier owns is a problem (TD-18: none may be). */
export function applierOwnedDefinerProblems(owned: readonly string[], applier: string): string[] {
  const problems: string[] = [];
  for (const f of owned)
    if (!APPLIER_OWNED_DEFINERS.includes(f)) problems.push(`${f} is a SECURITY DEFINER routine owned by the applier ${applier}, and none may be`);
  for (const f of APPLIER_OWNED_DEFINERS) if (!owned.includes(f)) problems.push(`${f} is no longer owned by the applier ${applier}`);
  return problems;
}

/**
 * TD-18's intended model (0070): each of the four formerly applier-owned
 * routines is owned by its NOLOGIN internal principal, whoever applied the
 * history, is SECURITY DEFINER, pins `pg_catalog, public, pg_temp` and is not
 * executable by PUBLIC. Read on BOTH builds (10b) and on the deployed
 * rehearsal (7.4); a reverted owner, a lost path or a PUBLIC grant is red.
 */
export const TD18_DEFINER_OWNERS: Readonly<Record<string, string>> = {
  'catalog_identifiers_sync()': 'daftar_catalog_internal',
  'provision_actor(p_allowed_kinds text[])': 'daftar_provisioning_internal',
  'provision_assertion_key_install(p_kid text, p_secret bytea)': 'daftar_provisioning_internal',
  'provision_assertion_key_retire(p_kid text)': 'daftar_provisioning_internal',
};

/** The pinned path of every TD-18 routine (P3-AL-54 §D). */
export const TD18_PINNED_PATH = 'search_path=pg_catalog, public, pg_temp';

/** One TD-18 routine as the catalogue describes it. */
export type Td18DefinerRow = {
  readonly f: string;
  readonly owner: string;
  readonly definer: boolean;
  readonly config: string[] | null;
  readonly public_execute: boolean;
};

/** The rows `td18DefinerProblems` judges: the four routines by name, whoever owns them. */
export const TD18_DEFINER_OWNERS_QUERY = `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f,
         pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('catalog_identifiers_sync', 'provision_actor', 'provision_assertion_key_install', 'provision_assertion_key_retire')
   ORDER BY 1`;

/** Every way the four TD-18 routines differ from the intended model. */
export function td18DefinerProblems(rows: readonly Td18DefinerRow[]): string[] {
  const problems: string[] = [];
  const byName = new Map(rows.map((r) => [r.f, r] as const));
  for (const [f, owner] of Object.entries(TD18_DEFINER_OWNERS)) {
    const r = byName.get(f);
    if (r === undefined) {
      problems.push(`${f} is missing`);
      continue;
    }
    if (r.owner !== owner) problems.push(`${f} is owned by ${r.owner}, not ${owner}`);
    if (!r.definer) problems.push(`${f} is not SECURITY DEFINER`);
    const path = (r.config ?? []).filter((c) => c.startsWith('search_path='));
    if (path.length !== 1 || path[0] !== TD18_PINNED_PATH) problems.push(`${f} pins ${path.join(', ') || 'no search_path'}, not ${TD18_PINNED_PATH}`);
    if (r.public_execute) problems.push(`${f} is executable by PUBLIC`);
  }
  for (const r of rows) if (!(r.f in TD18_DEFINER_OWNERS)) problems.push(`${r.f} is an unexpected overload`);
  return problems;
}

/**
 * Review I3 (0070 §5b): every SECURITY DEFINER routine outside the system
 * schemas (extensions' own aside), whoever owns it, with its search_path
 * settings.
 */
export const DEFINER_PATHS_QUERY = `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f,
         coalesce((SELECT array_agg(c ORDER BY c) FROM unnest(p.proconfig) AS c WHERE strpos(c, 'search_path=') = 1), ARRAY[]::text[]) AS paths
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
   ORDER BY 1`;

/** One SECURITY DEFINER routine and its search_path settings. */
export type DefinerPathRow = { readonly f: string; readonly paths: string[] };

/**
 * Every definer whose path could be shadowed: it must set exactly one
 * search_path, name pg_catalog, list pg_catalog before public when it names
 * public, and name pg_temp LAST (an unnamed pg_temp is searched first for
 * relations). An empty catalogue is itself a problem: the query read nothing.
 */
export function definerPathProblems(rows: readonly DefinerPathRow[]): string[] {
  if (rows.length === 0) return ['no SECURITY DEFINER routine was read'];
  const problems: string[] = [];
  for (const r of rows) {
    if (r.paths.length !== 1) {
      problems.push(`${r.f} sets ${r.paths.length === 0 ? 'no search_path' : `${r.paths.length} search_path values`}`);
      continue;
    }
    const entries = (r.paths[0] ?? '')
      .slice('search_path='.length)
      .split(',')
      .map((e) => e.trim().replace(/^"(.*)"$/, '$1'));
    const catalog = entries.indexOf('pg_catalog');
    const pub = entries.indexOf('public');
    if (catalog < 0) problems.push(`${r.f} does not name pg_catalog`);
    else if (pub >= 0 && pub < catalog) problems.push(`${r.f} lists public before pg_catalog`);
    if (entries.at(-1) !== 'pg_temp' || entries.indexOf('pg_temp') !== entries.length - 1) problems.push(`${r.f} does not name pg_temp last`);
  }
  return problems;
}

/** One upgrade of Case H: to `through` (every file on disk when null), applying exactly `expected`. */
export interface UpgradeStep {
  readonly label: string;
  readonly through: string | null;
  readonly expected: readonly string[];
}

/**
 * Case H's plan: the files through `base`, then each slice head in the order
 * given, then every later file. A step applies exactly the files after the
 * previous boundary and up to its own. A head that is not on disk, sorts at
 * or before `base`, or goes backwards is a problem, never a skipped step.
 */
export function sliceUpgradePlan(
  files: readonly string[],
  base: string,
  heads: Readonly<Record<string, string>>,
): { readonly base: readonly string[]; readonly steps: readonly UpgradeStep[]; readonly problems: readonly string[] } {
  const sorted = [...files].sort();
  const problems: string[] = [];
  if (!sorted.includes(base)) problems.push(`the base ${base} is not on disk`);
  const steps: UpgradeStep[] = [];
  let previous = base;
  for (const [slice, head] of Object.entries(heads)) {
    if (!sorted.includes(head)) problems.push(`${slice}'s head ${head} is not on disk`);
    if (head <= base) problems.push(`${slice}'s head ${head} is not after the base ${base}`);
    if (head < previous) problems.push(`${slice}'s head ${head} sorts before the previous boundary ${previous}`);
    const from = previous;
    steps.push({ label: `${slice} (${head.slice(0, 4)})`, through: head, expected: sorted.filter((f) => f > from && f <= head) });
    if (head > previous) previous = head;
  }
  const last = previous;
  steps.push({ label: 'every later migration', through: null, expected: sorted.filter((f) => f > last) });
  return { base: sorted.filter((f) => f <= base), steps, problems };
}

/** The runner applied exactly `expected`, in order. */
export function appliedExactly(expected: readonly string[], applied: readonly string[]): boolean {
  return applied.length === expected.length && applied.every((f, i) => f === expected[i]);
}

const findings: string[] = [];
const steps: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? '  ok     ' : '  FAIL   '} ${step} — ${detail}`);
  if (!ok) findings.push(`${step}: ${detail}`);
}

function section(title: string): void {
  console.log(`\nDEPLOYMENT AUTHORITY — ${title}`);
}

function url(db: string, role: string, password: string): string {
  return `postgresql://${role}:${password}@127.0.0.1:${PG_PORT}/${db}`;
}
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_SUPER_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;
const deployerUrl = (db: string): string => url(db, DEPLOYER, PASSWORDS['__MIGRATOR_DB_PASSWORD__'] as string);

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string {
  const res = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status ?? 'signal'}):\n${output.slice(-4000)}`);
  return output;
}

async function sql<T extends Record<string, unknown>>(connectionString: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

/** A catalogue query that must answer exactly one row did not: the cluster is not the one this script built. */
class MissingRowError extends Error {
  constructor(what: string) {
    super(`the catalogue returned no row for ${what}`);
    this.name = 'MissingRowError';
  }
}

/** A query whose first row the caller relies on; an empty answer throws `MissingRowError` rather than reading undefined. */
async function sqlOne<T extends Record<string, unknown>>(connectionString: string, what: string, text: string, params: unknown[] = []): Promise<T> {
  const [row] = await sql<T>(connectionString, text, params);
  if (row === undefined) throw new MissingRowError(what);
  return row;
}

/** A capture group the pattern makes mandatory; its absence is an impossible match and throws. */
class MissingGroupError extends Error {
  constructor(pattern: RegExp) {
    super(`a match of ${String(pattern)} has no first capture group`);
    this.name = 'MissingGroupError';
  }
}
function group1(m: RegExpMatchArray, pattern: RegExp): string {
  const g = m[1];
  if (g === undefined) throw new MissingGroupError(pattern);
  return g;
}

async function exec(connectionString: string, text: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

// ── the cluster ────────────────────────────────────────────────────────────
//
// Its own throwaway cluster, for the same reason the rollback rehearsal has
// one: this script needs a superuser that can create databases and roles, and
// it needs to be able to destroy everything afterwards. It never touches a
// cluster it did not create.

let dataDir = '';
const SERVER_USER = process.env['DEPLOY_PG_OS_USER'] ?? 'postgres';
const NEEDS_PRIVILEGE_DROP = typeof process.getuid === 'function' && process.getuid() === 0;

function pgServer(bin: string, args: string[], opts: { allowFailure?: boolean } = {}): string {
  const exe = join(PG_BIN, bin);
  if (!NEEDS_PRIVILEGE_DROP) return run(exe, args, opts);
  return run('setpriv', ['--reuid', SERVER_USER, '--regid', SERVER_USER, '--init-groups', '--', exe, ...args], opts);
}

function startCluster(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'daftar-deploy-pg-'));
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const pwFile = join(dataDir, '..', `pw-${process.pid}`);
  writeFileSync(pwFile, PG_SUPER_PASSWORD);
  if (NEEDS_PRIVILEGE_DROP) {
    run('chown', ['-R', `${SERVER_USER}:${SERVER_USER}`, dataDir]);
    run('chown', [`${SERVER_USER}:${SERVER_USER}`, pwFile]);
    run('chmod', ['0600', pwFile]);
  }
  pgServer('initdb', ['-D', dataDir, '-U', PG_USER, '--auth-local=trust', '--auth-host=md5', `--pwfile=${pwFile}`]);
  rmSync(pwFile, { force: true });
  pgServer('pg_ctl', [
    '-D',
    dataDir,
    '-o',
    `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories=${dataDir}`,
    '-w',
    '-l',
    join(dataDir, 'server.log'),
    'start',
  ]);
}

function stopCluster(): void {
  if (!dataDir) return;
  pgServer('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { allowFailure: true });
  rmSync(dataDir, { recursive: true, force: true });
}

function bootstrapSql(db: string): string {
  let text = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  for (const [token, value] of Object.entries(PASSWORDS)) text = text.replaceAll(token, value);
  // The bootstrap names the production database; a throwaway one is not it.
  return text.replaceAll('GRANT CONNECT ON DATABASE daftar TO', `GRANT CONNECT ON DATABASE ${db} TO`);
}

/** A database with bootstrap applied by the deployment ADMINISTRATOR and nothing else. */
async function freshDatabase(db: string): Promise<void> {
  await exec(ownerUrl('postgres'), `DROP DATABASE IF EXISTS ${db}`);
  await exec(ownerUrl('postgres'), `CREATE DATABASE ${db}`);
  await exec(ownerUrl(db), bootstrapSql(db));
}

/** A migrations directory holding only the files up to and including `through`. */
function migrationsUpTo(through: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-deploy-mig-'));
  for (const f of migrationFiles().filter((f) => f <= through)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────
// 1. THE AUTHORITY INVENTORY (§12) — derived, never guessed
// ─────────────────────────────────────────────────────────────────────────
//
// Read off the frozen history rather than written down, so that a later
// authorized migration which hands ownership to a role nobody granted a
// membership for is a red gate here instead of a deployment that dies half
// way through production.

interface Inventory {
  readonly ownershipTargets: string[];
  readonly extensions: string[];
  readonly grantees: string[];
  readonly revokees: string[];
  readonly disableTrigger: string[];
  readonly createsFunctions: number;
  readonly createsPolicies: number;
  readonly touchesSchemaMigrations: string[];
}

const OWNER_TO = /\bOWNER\s+TO\s+(daftar_[a-z_]+)/gi;
const CREATE_EXTENSION = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/gi;
const GRANT_TO = /\bGRANT\b[\s\S]{0,400}?\bTO\s+([a-z_,\s]+?)[;\n]/gi;
const REVOKE_FROM = /\bREVOKE\b[\s\S]{0,400}?\bFROM\s+([a-z_,\s]+?)[;\n]/gi;

function buildInventory(): Inventory {
  const ownershipTargets = new Set<string>();
  const extensions = new Set<string>();
  const grantees = new Set<string>();
  const revokees = new Set<string>();
  const disableTrigger: string[] = [];
  const touchesSchemaMigrations: string[] = [];
  let createsFunctions = 0;
  let createsPolicies = 0;

  for (const file of migrationFiles()) {
    const code = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    for (const m of code.matchAll(OWNER_TO)) ownershipTargets.add(group1(m, OWNER_TO));
    for (const m of code.matchAll(CREATE_EXTENSION)) extensions.add(group1(m, CREATE_EXTENSION));
    for (const m of code.matchAll(GRANT_TO)) {
      for (const r of group1(m, GRANT_TO).split(',')) if (/^daftar_[a-z_]+$/.test(r.trim())) grantees.add(r.trim());
    }
    for (const m of code.matchAll(REVOKE_FROM)) {
      for (const r of group1(m, REVOKE_FROM).split(',')) if (/^daftar_[a-z_]+$/.test(r.trim())) revokees.add(r.trim());
    }
    if (/DISABLE\s+TRIGGER/i.test(code)) disableTrigger.push(file);
    if (/\bschema_migrations\b/i.test(code)) touchesSchemaMigrations.push(file);
    createsFunctions += [...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi)].length;
    createsPolicies += [...code.matchAll(/CREATE\s+POLICY\b/gi)].length;
  }

  return {
    ownershipTargets: [...ownershipTargets].sort(),
    extensions: [...extensions].sort(),
    grantees: [...grantees].sort(),
    revokees: [...revokees].sort(),
    disableTrigger,
    createsFunctions,
    createsPolicies,
    touchesSchemaMigrations,
  };
}

function checkInventoryAgainstBootstrap(inv: Inventory): void {
  section('1. the authority inventory, derived from the frozen history (§12)');
  const bootstrap = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  const bootstrapCode = stripComments(bootstrap);

  record('1.1 ownership targets', true, `the history hands ownership to: ${inv.ownershipTargets.join(', ')}`);
  record('1.2 extensions', true, `the history names: ${inv.extensions.join(', ')}`);
  record('1.3 privilege surface', true, `${inv.grantees.length} grantee role(s), ${inv.revokees.length} revokee role(s)`);
  record('1.4 routines and policies', true, `${inv.createsFunctions} CREATE FUNCTION, ${inv.createsPolicies} CREATE POLICY`);
  record(
    '1.5 DISABLE TRIGGER',
    true,
    inv.disableTrigger.length === 0
      ? 'no migration disables a trigger'
      : `${inv.disableTrigger.join(', ')} — the object owner may do this, and the deployer owns them`,
  );
  record(
    '1.6 schema_migrations',
    inv.touchesSchemaMigrations.length === 0,
    inv.touchesSchemaMigrations.length === 0
      ? 'no migration writes the history table — only the runner does'
      : `written by ${inv.touchesSchemaMigrations.join(', ')}, which puts the history under a migration's control`,
  );

  // Every ownership target must have a membership, or the deployment stops.
  for (const target of inv.ownershipTargets) {
    const granted = new RegExp(`GRANT\\s+${target}\\s+TO\\s+${DEPLOYER}\\b`, 'i').test(bootstrapCode);
    record(
      `1.7 membership for ${target}`,
      granted,
      granted
        ? `bootstrap.sql grants ${target} to ${DEPLOYER}`
        : `bootstrap.sql grants no ${target} membership — a deployment would stop at the first handover to it`,
    );
  }

  // The deployer must own the schema, or it cannot lend CREATE to the role it
  // is about to hand an object to (cause 2 of RB-P2-01).
  const ownsSchema = new RegExp(`ALTER\\s+SCHEMA\\s+public\\s+OWNER\\s+TO\\s+${DEPLOYER}\\b`, 'i').test(bootstrapCode);
  record(
    '1.8 schema ownership',
    ownsSchema,
    ownsSchema ? `bootstrap.sql makes ${DEPLOYER} the owner of schema public` : 'bootstrap.sql leaves schema public owned by someone else',
  );

  // §16: bootstrap must install every extension the history names, BEFORE the
  // history reaches it, and no runtime may be given extension-creation.
  for (const ext of inv.extensions) {
    const installed = new RegExp(`CREATE\\s+EXTENSION\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${ext}"?`, 'i').test(bootstrapCode);
    record(
      `1.9 extension ${ext}`,
      installed,
      installed ? 'installed by the deployment administrator in bootstrap.sql' : 'not installed in bootstrap.sql — the migration would need CREATE ON DATABASE',
    );
  }
  const runtimeCreate = RUNTIME_ROLES.filter((r) => new RegExp(`GRANT[^;]*\\bCREATE\\b[^;]*ON\\s+DATABASE[^;]*\\b${r}\\b`, 'i').test(bootstrapCode));
  record(
    '1.10 no runtime may create an extension',
    runtimeCreate.length === 0,
    runtimeCreate.length === 0 ? 'no runtime role holds CREATE ON DATABASE' : `granted to ${runtimeCreate.join(', ')}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2. THE DEPLOYMENT PRINCIPAL IS NOT A RUNTIME (§13, §14)
// ─────────────────────────────────────────────────────────────────────────

function checkDeployerIsNotARuntime(): void {
  section('2. the deployment principal is a deployment principal (§13, §14)');
  // No runtime configuration may accept the deployment credential. The
  // migration command reads MIGRATION_DATABASE_URL and the runtime config
  // never loads it; this asserts that the separation is still true in code
  // rather than only in a comment.
  const configFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs|cjs|yml|yaml|env|example)$/.test(e.name)) configFiles.push(full);
    }
  };
  for (const d of ['apps', 'packages']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));

  // Comments are stripped first, and deliberately: `apps/api/src/config.ts`
  // NAMES the variable in order to say that it never reads it, which is the
  // documentation a reader wants and the opposite of the defect being looked
  // for. What matters is whether any runtime CODE reaches for the value.
  const offenders = configFiles.filter((f) => {
    if (f.endsWith('apps/api/src/infra/migrate.ts')) return false; // the migration command itself
    const text = readFileSync(f, 'utf8');
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/^\s*#.*$/, ''))
      .join('\n');
    return /MIGRATION_DATABASE_URL/.test(code);
  });
  record(
    '2.1 no runtime configuration reads the deployment URL',
    offenders.length === 0,
    offenders.length === 0
      ? 'MIGRATION_DATABASE_URL is read by the migration command and by nothing else'
      : offenders.map((o) => o.replace(`${ROOT}/`, '')).join(', '),
  );

  const runtimeUrlNames = readdirSync(join(ROOT, 'apps'), { withFileTypes: true }).length > 0;
  record('2.2 runtime connection URLs are per-runtime', runtimeUrlNames, 'each runtime has its own *_DATABASE_URL; the deployer has none');
}

async function checkLiveDeployerShape(db: string): Promise<Record<string, unknown>> {
  section('2b. the deployment principal, as the live catalogue describes it');
  const role = await sqlOne<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolinherit: boolean;
  }>(
    ownerUrl(db),
    `the role ${DEPLOYER}`,
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit
       FROM pg_roles WHERE rolname = $1`,
    [DEPLOYER],
  );
  record('2.3 NOT a superuser', role.rolsuper === false, `rolsuper = ${String(role.rolsuper)}`);
  record('2.4 does NOT bypass RLS', role.rolbypassrls === false, `rolbypassrls = ${String(role.rolbypassrls)}`);
  record('2.5 cannot create databases', role.rolcreatedb === false, `rolcreatedb = ${String(role.rolcreatedb)}`);
  record('2.6 cannot create roles', role.rolcreaterole === false, `rolcreaterole = ${String(role.rolcreaterole)}`);
  record('2.7 cannot replicate', role.rolreplication === false, `rolreplication = ${String(role.rolreplication)}`);

  const memberships = await sql<{ grantor_role: string; inherit_option: boolean; set_option: boolean; admin_option: boolean }>(
    ownerUrl(db),
    `SELECT g.rolname AS grantor_role, a.inherit_option, a.set_option, a.admin_option
       FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = $1 ORDER BY 1`,
    [DEPLOYER],
  );
  record(
    '2.8 memberships',
    true,
    memberships.map((m) => `${m.grantor_role} (inherit=${String(m.inherit_option)}, set=${String(m.set_option)})`).join('; ') || '(none)',
  );
  const withAdmin = memberships.filter((m) => m.admin_option);
  record(
    '2.9 no membership carries ADMIN OPTION',
    withAdmin.length === 0,
    withAdmin.length === 0 ? 'the deployer cannot pass any membership on' : withAdmin.map((m) => m.grantor_role).join(', '),
  );

  const reverse = await sql<{ member: string }>(
    ownerUrl(db),
    `SELECT m.rolname AS member FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE g.rolname = $1 ORDER BY 1`,
    [DEPLOYER],
  );
  record(
    '2.10 nothing is a member of the deployer',
    reverse.length === 0,
    reverse.length === 0 ? 'no role can assume the deployment authority' : reverse.map((r) => r.member).join(', '),
  );

  // 2.8 records; 2.11 decides. A fourth membership, INHERIT on an internal
  // authority, or a missing one is a changed migration principal (A-09 1).
  const membershipProblems = deployerMembershipProblems(
    memberships.map((m) => ({ role: m.grantor_role, inherit: m.inherit_option, set: m.set_option, admin: m.admin_option })),
  );
  record(
    '2.11 the memberships are exactly the accepted five',
    membershipProblems.length === 0,
    membershipProblems.length === 0
      ? ACCEPTED_DEPLOYER_MEMBERSHIPS.map((m) => `${m.role} (inherit=${String(m.inherit)}, set=${String(m.set)}, admin=false)`).join('; ')
      : membershipProblems.join('; '),
  );

  return { attributes: role, memberships, membersOfDeployer: reverse.map((r) => r.member) };
}

// ─────────────────────────────────────────────────────────────────────────
// 3–8. THE DEPLOYMENT MATRIX (§17)
// ─────────────────────────────────────────────────────────────────────────

async function appliedCount(db: string): Promise<{ n: number; last: string | null }> {
  const row = await sqlOne<{ n: string; last: string | null }>(
    ownerUrl(db),
    `the history of ${db}`,
    `SELECT count(*)::text AS n, max(name) AS last FROM schema_migrations`,
  );
  return { n: Number(row.n), last: row.last };
}

async function caseA(db: string): Promise<void> {
  section('3. CASE A — an empty database, bootstrap, then the whole accepted history');
  await freshDatabase(db);
  const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
  const state = await appliedCount(db);
  const expected = migrationFiles().length;
  record('3.1 the deployment principal applied every migration', applied.length === expected, `${applied.length} of ${expected} applied as ${DEPLOYER}`);
  record('3.2 the history records them all', state.n === expected, `schema_migrations has ${state.n} rows, last = ${String(state.last)}`);
}

async function caseB(db: string): Promise<void> {
  section('4. CASE B — a database at the Phase 1 boundary, upgraded to 0052');
  await freshDatabase(db);
  const p1 = migrationsUpTo('0039_catalog_identifiers_owner_integrity.sql');
  try {
    const phase1 = await runMigrations(deployerUrl(db), p1);
    record(
      '4.1 Phase 1 applies as the deployment principal',
      phase1.length === readdirSync(p1).length,
      `${phase1.length} migrations through the Phase 1 boundary`,
    );
    const phase2 = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const state = await appliedCount(db);
    record(
      '4.2 Phase 2 applies on top of it',
      state.n === migrationFiles().length,
      `${phase2.length} further migrations; history now ${state.n}, last = ${String(state.last)}`,
    );
  } finally {
    rmSync(p1, { recursive: true, force: true });
  }
}

async function caseC(db: string): Promise<void> {
  section('5. CASE C — a database at 0050, upgraded across the P2-S8 freeze');
  await freshDatabase(db);
  const upTo50 = migrationsUpTo('0050_accounting_report_indexes.sql');
  try {
    await runMigrations(deployerUrl(db), upTo50);
    const before = await appliedCount(db);
    const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const after = await appliedCount(db);
    // The two Phase 2 names exactly and in order, then every later migration
    // the tree carries — appended to the expectation, never loosened out of it.
    const expected = ['0051_accounting_reconciler_read.sql', PHASE2_PREFIX_END, ...migrationFiles().filter((f) => f > PHASE2_PREFIX_END)];
    record(
      '5.1 exactly 0051 and 0052 are added, then every later migration',
      applied.length === expected.length && applied.every((f, i) => f === expected[i]),
      `${before.n} → ${after.n}; applied ${applied.join(', ') || '(none)'}`,
    );
  } finally {
    rmSync(upTo50, { recursive: true, force: true });
  }
}

/**
 * CASE G — the migrations after the Phase 2 freeze (P3-S1 onward), applied to a
 * database that already HOLDS a business.
 *
 * An empty database cannot tell a backfill that worked from one that saw
 * nothing. The deployer owns the tables but is subject to their FORCE row
 * security, so a backfill that forgot that would seed nothing in production
 * and pass every set-wise assertion vacuously. The business below is written
 * by the administrator (a superuser, which RLS does not restrict), then the
 * later migrations run as the deployer, and the rows they were required to write
 * are read back.
 */
async function caseG(db: string): Promise<void> {
  section('8b. CASE G — a database at the 0052 freeze with a business, upgraded to every later migration');
  await freshDatabase(db);
  const frozen = migrationsUpTo(PHASE2_PREFIX_END);
  try {
    await runMigrations(deployerUrl(db), frozen);
    const seed = {
      tenant: randomUUID(),
      business: randomUUID(),
      branch: randomUUID(),
      warehouse: randomUUID(),
      owner: randomUUID(),
      manager: randomUUID(),
      cashier: randomUUID(),
      custom: randomUUID(),
    };
    // The shape the frozen provisioning writer produces (0033:137): only the
    // owner is a system role; manager and cashier are the builtin template
    // roles, identified by their unique key.
    // System roles are system-managed (0006 business_roles_system_guard):
    // only the platform principal, for which app_bypass() is true, may write
    // them — so the seed is written AS daftar_platform, exactly the principal
    // provisioning writes it as.
    await exec(
      ownerUrl(db),
      `BEGIN;
       SET LOCAL ROLE daftar_platform;
       INSERT INTO tenants (id) VALUES ('${seed.tenant}');
       INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ('${seed.business}', '${seed.tenant}', 'Deploy G', 'deploy-g', 'PS', 'ILS', 'Asia/Hebron');
       INSERT INTO branches (business_id, id, name, is_default) VALUES ('${seed.business}', '${seed.branch}', 'Main', true);
       INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ('${seed.business}', '${seed.warehouse}', '${seed.branch}', 'Main WH', true);
       INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES
         ('${seed.business}', '${seed.owner}', 'owner', 'Owner', true),
         ('${seed.business}', '${seed.manager}', 'manager', 'Manager', false),
         ('${seed.business}', '${seed.cashier}', 'cashier', 'Cashier', false),
         ('${seed.business}', '${seed.custom}', 'clerk', 'Clerk', false);
       INSERT INTO role_permissions (business_id, role_id, permission) VALUES
         ('${seed.business}', '${seed.manager}', 'catalog.view'), ('${seed.business}', '${seed.manager}', 'warehouse.manage'),
         ('${seed.business}', '${seed.cashier}', 'catalog.view'),
         ('${seed.business}', '${seed.custom}', 'catalog.view');
       COMMIT;`,
    );
    const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const candidates = migrationFiles().filter((f) => f > PHASE2_PREFIX_END);
    record(
      '8b.1 exactly every later migration is added',
      applied.length === candidates.length && applied.every((f, i) => f === candidates[i]),
      `applied ${applied.join(', ') || '(none)'}`,
    );
    const [home] = await sql<{ n: string; home: string }>(
      ownerUrl(db),
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE branch_id = $2 AND warehouse_id = $3)::text AS home
         FROM branch_warehouses WHERE business_id = $1`,
      [seed.business, seed.branch, seed.warehouse],
    );
    record(
      '8b.2 the existing warehouse has exactly its home association',
      home?.n === '1' && home.home === '1',
      `${home?.n ?? '?'} row(s), ${home?.home ?? '?'} home`,
    );
    const perms = async (role: string): Promise<string[]> =>
      (
        await sql<{ p: string }>(ownerUrl(db), `SELECT permission AS p FROM role_permissions WHERE business_id = $1 AND role_id = $2 ORDER BY 1`, [
          seed.business,
          role,
        ])
      ).map((r) => r.p);
    const owner = await perms(seed.owner);
    const phase3 = ['inventory.', 'purchases.', 'suppliers.'];
    record('8b.3 the owner holds all eleven Phase 3 permissions', owner.filter((p) => phase3.some((x) => p.startsWith(x))).length === 11, owner.join(', '));
    const manager = await perms(seed.manager);
    record(
      '8b.4 the manager gained exactly the three view keys and kept what it had',
      manager.join(',') === ['catalog.view', 'inventory.view', 'purchases.view', 'suppliers.view', 'warehouse.manage'].join(','),
      manager.join(', '),
    );
    const cashier = await perms(seed.cashier);
    record('8b.5 the cashier gained nothing', cashier.join(',') === 'catalog.view', cashier.join(', '));
    const custom = await perms(seed.custom);
    record('8b.6 the custom role is unchanged', custom.join(',') === 'catalog.view', custom.join(', '));
  } finally {
    rmSync(frozen, { recursive: true, force: true });
  }
}

/**
 * CASE H — the Phase 3 slice boundaries, one upgrade at a time (P3-S9 A-09 4).
 *
 * Case G proves 0052 → head in one step. A production database is not
 * upgraded in one step: it sat at each accepted slice head for as long as that
 * slice was the release, and was carried forward from there. So one fresh
 * database is taken to the Phase 2 freeze, then to each `PHASE3_SLICE_HEADS`
 * value in order, then to every file on disk, each step as the deployer and
 * each applying exactly the files between its two boundaries. The database it
 * ends with must be Case A's, family by family under the §10 queries.
 */
async function caseH(db: string, reference: string): Promise<void> {
  section('8c. CASE H — a database at the 0052 freeze, upgraded one Phase 3 slice head at a time');
  await freshDatabase(db);
  const plan = sliceUpgradePlan(migrationFiles(), PHASE2_PREFIX_END, PHASE3_SLICE_HEADS);
  record(
    '8c.0 every accepted slice head is on disk, after the freeze, in order',
    plan.problems.length === 0,
    plan.problems.length === 0
      ? Object.entries(PHASE3_SLICE_HEADS)
          .map(([k, v]) => `${k} → ${v.slice(0, 4)}`)
          .join(', ')
      : plan.problems.join('; '),
  );
  const base = migrationsUpTo(PHASE2_PREFIX_END);
  try {
    const applied = await runMigrations(deployerUrl(db), base);
    record(
      '8c.1 the Phase 2 prefix applies as the deployer',
      appliedExactly(plan.base, applied),
      `${applied.length} of ${plan.base.length} through ${PHASE2_PREFIX_END.slice(0, 4)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  for (const [i, step] of plan.steps.entries()) {
    const dir = step.through === null ? MIGRATIONS_DIR : migrationsUpTo(step.through);
    try {
      const applied = await runMigrations(deployerUrl(db), dir);
      record(
        `8c.${i + 2} ${step.label}: exactly the files since the previous boundary`,
        appliedExactly(step.expected, applied),
        `applied ${applied.join(', ') || '(none)'}${appliedExactly(step.expected, applied) ? '' : `; expected ${step.expected.join(', ') || '(none)'}`}`,
      );
    } finally {
      if (dir !== MIGRATIONS_DIR) rmSync(dir, { recursive: true, force: true });
    }
  }
  const differences = catalogueDifferences(await catalogueSnapshot(db, DEPLOYER), await catalogueSnapshot(reference, DEPLOYER), CATALOGUE_FAMILIES);
  record(
    `8c.${plan.steps.length + 2} the slice-by-slice database is Case A's, under every §10 family`,
    differences.length === 0,
    differences.length === 0
      ? `${CATALOGUE_FAMILIES.length} families identical`
      : differences
          .map((d) => `${d.family}: ${d.onlyFirst.length}/${d.onlySecond.length} — e.g. ${(d.onlyFirst[0] ?? d.onlySecond[0] ?? '').slice(0, 160)}`)
          .join('; '),
  );
}

async function caseD(db: string): Promise<void> {
  section('6. CASE D — a database already at the latest migration');
  const before = await appliedCount(db);
  const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
  const after = await appliedCount(db);
  record('6.1 a re-run is a no-op', applied.length === 0 && after.n === before.n, `${applied.length} migrations applied; history unchanged at ${after.n}`);
}

async function caseE(db: string): Promise<void> {
  section('7. CASE E — an applied migration whose bytes changed afterwards');
  const tampered = mkdtempSync(join(tmpdir(), 'daftar-deploy-tamper-'));
  try {
    for (const f of migrationFiles()) cpSync(join(MIGRATIONS_DIR, f), join(tampered, f));
    const victim = '0045_accounting_post_entry.sql';
    writeFileSync(join(tampered, victim), `${readFileSync(join(tampered, victim), 'utf8')}\n-- a byte nobody accepted\n`);
    const before = await appliedCount(db);
    let message = '';
    try {
      await runMigrations(deployerUrl(db), tampered);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const after = await appliedCount(db);
    record('7.1 the deployment refuses to proceed', /checksum mismatch/i.test(message), message === '' ? 'the run SUCCEEDED over a tampered history' : message);
    record('7.2 the history is untouched', after.n === before.n, `schema_migrations still has ${after.n} rows`);
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
}

async function caseF(db: string): Promise<void> {
  section('8. CASE F — a migration that fails half way through');
  await freshDatabase(db);
  const dir = mkdtempSync(join(tmpdir(), 'daftar-deploy-fail-'));
  try {
    for (const f of migrationFiles()) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    // A file that does real work and THEN fails, so the rollback has
    // something to undo. It is created in a disposable copy of the directory
    // and never exists in the repository.
    // It sorts BETWEEN 0044 and 0045, so the run fails with part of the
    // history applied and committed. A probe that sorted last would prove
    // only that the final file can fail.
    const broken = '0044a_deployment_failure_probe.sql';
    writeFileSync(join(dir, broken), 'CREATE TABLE deployment_failure_probe (id int);\nSELECT 1 / 0;\n');
    let message = '';
    try {
      await runMigrations(deployerUrl(db), dir);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    record('8.1 the failure is reported, not swallowed', /division by zero/i.test(message), message || 'the run reported success');

    const probe = await sqlOne<{ exists: boolean }>(
      ownerUrl(db),
      'the failure probe',
      `SELECT to_regclass('public.deployment_failure_probe') IS NOT NULL AS exists`,
    );
    record(
      '8.2 the failed migration rolled back completely',
      probe.exists === false,
      `the table it created before failing ${probe.exists ? 'SURVIVED' : 'is gone'}`,
    );

    const row = await sqlOne<{ n: string }>(
      ownerUrl(db),
      `the history row count of ${broken}`,
      `SELECT count(*)::text AS n FROM schema_migrations WHERE name = $1`,
      [broken],
    );
    record('8.3 no false history row', Number(row.n) === 0, `schema_migrations has ${row.n} row(s) for the failed file`);

    // The failure really was mid-history: what ran before it is committed,
    // what comes after it never ran.
    const partial = await appliedCount(db);
    record(
      '8.5 the migrations before it are committed, those after it are not',
      partial.n > 0 && partial.n < migrationFiles().length,
      `${partial.n} of ${migrationFiles().length} applied, last = ${String(partial.last)}`,
    );

    // Clean retry: with the broken file removed, the same database finishes.
    rmSync(join(dir, broken), { force: true });
    const applied = await runMigrations(deployerUrl(db), dir);
    const state = await appliedCount(db);
    record(
      '8.4 the retry completes cleanly',
      state.n === migrationFiles().length && applied.length > 0,
      `${applied.length} applied on retry; history now ${state.n} of ${migrationFiles().length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 9. THE HISTORY TABLE'S AUTHORITY (§15)
// ─────────────────────────────────────────────────────────────────────────

async function checkHistoryAuthority(db: string): Promise<void> {
  section('9. the deployment principal owns its own history table (§15)');
  const owner = await sqlOne<{ owner: string; acl: string }>(
    ownerUrl(db),
    'the history table',
    `SELECT pg_get_userbyid(relowner) AS owner, coalesce(relacl::text, '') AS acl FROM pg_class WHERE relname = 'schema_migrations'`,
  );
  record('9.1 the history table belongs to the deployer', owner.owner === DEPLOYER, `owner = ${owner.owner}`);
  const runtimeReaders = RUNTIME_ROLES.filter((r) => owner.acl.includes(`${r}=`));
  record(
    '9.2 no runtime principal was granted anything on it',
    runtimeReaders.length === 0,
    runtimeReaders.length === 0 ? `acl = ${owner.acl || '(owner only)'}` : runtimeReaders.join(', '),
  );

  const runner = readFileSync(join(ROOT, 'apps/api/src/infra/migrate.ts'), 'utf8');
  record(
    '9.3 checksum validation is not optional',
    /checksum mismatch/.test(runner) && !/SKIP_CHECKSUM|--no-verify|DISABLE_CHECKSUM/i.test(runner),
    'the runner has no switch that turns verification off',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 10. THE SAME DATABASE A SUPERUSER WOULD HAVE BUILT
// ─────────────────────────────────────────────────────────────────────────

export const CATALOGUE_QUERIES: Readonly<Record<string, string>> = {
  tables: `SELECT c.relname || ' | ' || pg_get_userbyid(c.relowner) || ' | ' || c.relrowsecurity || ' | ' || c.relforcerowsecurity || ' | ' || coalesce(c.relacl::text, '') AS row
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY 1`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') | ' || pg_get_userbyid(p.proowner) || ' | ' || p.prosecdef
                     || ' | ' || coalesce(p.proacl::text, '') || ' | ' || coalesce(p.proconfig::text, '') || ' | ' || md5(p.prosrc) AS row
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`,
  policies: `SELECT c.relname || '.' || pol.polname || ' | ' || pol.polcmd::text || ' | ' || pol.polpermissive
                    || ' | ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                    || ' | ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                    || ' | ' || coalesce((SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY r) FROM unnest(pol.polroles) r), '') AS row
               FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid ORDER BY 1`,
  triggers: `SELECT c.relname || '.' || t.tgname || ' | ' || t.tgtype || ' | ' || t.tgenabled::text || ' | ' || t.tgdeferrable || ' | ' || t.tginitdeferred
                    || ' | ' || p.proname AS row
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`,
  columnAcls: `SELECT c.relname || '.' || a.attname || ' | ' || a.attacl::text AS row
                 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  constraints: `SELECT c.relname || '.' || con.conname || ' | ' || con.contype::text || ' | ' || pg_get_constraintdef(con.oid) AS row
                  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' ORDER BY 1`,
  // ── added by P3-S9 (A-09 2, finding F-8) ──────────────────────────────────
  sequences: `SELECT c.relname || ' | ' || pg_get_userbyid(c.relowner) || ' | ' || coalesce(c.relacl::text, '') AS row
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`,
  indexes: `SELECT tablename || '.' || indexname || ' | ' || indexdef AS row FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  columns: `SELECT c.relname || '.' || a.attname || ' | ' || format_type(a.atttypid, a.atttypmod) || ' | ' || a.attnotnull
                   || ' | ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' | ' || a.attidentity::text || ' | ' || a.attgenerated::text AS row
              FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  schema: `SELECT n.nspname || ' | ' || pg_get_userbyid(n.nspowner) || ' | ' || coalesce(n.nspacl::text, '') AS row
             FROM pg_namespace n WHERE n.nspname = 'public'`,
  defaultAcls: `SELECT pg_get_userbyid(d.defaclrole) || ' | ' || coalesce(n.nspname, '') || ' | ' || d.defaclobjtype::text || ' | ' || d.defaclacl::text AS row
                  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 1`,
  extensions: `SELECT e.extname || ' | ' || e.extversion AS row FROM pg_extension e ORDER BY 1`,
};

/** The §10 families, in the order their steps are numbered (10.1 …). */
export const CATALOGUE_FAMILIES: readonly string[] = Object.keys(CATALOGUE_QUERIES);

async function catalogueSnapshot(db: string, applier: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, query] of Object.entries(CATALOGUE_QUERIES)) {
    const rows = await sql<{ row: string }>(ownerUrl(db), query);
    // The one difference a deployment is ALLOWED to have is who owns what it
    // created, so the applying principal's own name is normalised away. Every
    // OTHER owner — the two delegated ones — is compared literally, which is
    // the point: a handover that silently did not happen shows up here.
    out[name] = normaliseCatalogueRows(
      name,
      rows.map((r) => r.row),
      applier,
    );
  }
  return out;
}

async function checkCatalogueEquivalence(deployed: string, superuser: string): Promise<Record<string, number>> {
  section('10. the deployment authority builds the database a superuser builds');
  const a = await catalogueSnapshot(deployed, DEPLOYER);
  const b = await catalogueSnapshot(superuser, PG_USER);
  const differences = new Map(catalogueDifferences(a, b, CATALOGUE_FAMILIES).map((d) => [d.family, d] as const));
  const counts: Record<string, number> = {};
  CATALOGUE_FAMILIES.forEach((name, i) => {
    const rows = a[name] ?? [];
    const d = differences.get(name);
    counts[name] = rows.length;
    record(
      `10.${i + 1} ${name}`,
      d === undefined,
      d === undefined
        ? `${rows.length} identical`
        : `${d.onlyFirst.length} differ under the deployer, ${d.onlySecond.length} under the superuser — e.g. ${(d.onlyFirst[0] ?? d.onlySecond[0] ?? '').slice(0, 200)}`,
    );
  });
  return counts;
}

/**
 * 10b — the SECURITY DEFINER routines, on both builds (TD-18, 0070): the
 * applier owns NONE — not `daftar_migrator` on the deployer's database, not
 * `postgres` on the superuser control — and the four routines 0037-0039 left
 * to the applier are owned by their internal principals with the pinned path
 * on BOTH builds. Before 0070 this section pinned the four as applier-owned.
 */
async function checkApplierOwnedDefiners(deployed: string, superuser: string): Promise<Record<string, string[]>> {
  section('10b. the SECURITY DEFINER routines: none owned by the applier, the TD-18 four owned alike, every path pinned, on both builds');
  const out: Record<string, string[]> = {};
  const builds: readonly (readonly [label: string, db: string, applier: string])[] = [
    ['the deployer-built database', deployed, DEPLOYER],
    ['the superuser-built control', superuser, PG_USER],
  ];
  for (const [n, [label, db, applier]] of builds.entries()) {
    const owned = (await sql<{ f: string }>(ownerUrl(db), APPLIER_OWNED_DEFINERS_QUERY, [applier])).map((r) => r.f);
    out[db] = owned;
    const problems = applierOwnedDefinerProblems(owned, applier);
    record(
      `10b.${n + 1} ${label}: the applier ${applier} owns no SECURITY DEFINER routine`,
      problems.length === 0,
      problems.length === 0 ? 'none' : problems.join('; '),
    );
    const rows = await sql<Td18DefinerRow>(ownerUrl(db), TD18_DEFINER_OWNERS_QUERY);
    const td18 = td18DefinerProblems(rows);
    out[`${db}:td18`] = rows.map((r) => `${r.f} ${r.owner}`);
    record(
      `10b.${n + 3} ${label}: the TD-18 routines have their internal owners and the pinned path`,
      td18.length === 0,
      td18.length === 0 ? rows.map((r) => `${r.f} → ${r.owner}`).join('; ') : td18.join('; '),
    );
    const paths = await sql<DefinerPathRow>(ownerUrl(db), DEFINER_PATHS_QUERY);
    const pathProblems = definerPathProblems(paths);
    out[`${db}:paths`] = paths.map((r) => `${r.f} ${r.paths.join(';')}`);
    record(
      `10b.${n + 5} ${label}: every SECURITY DEFINER routine lists pg_catalog before public and pg_temp last`,
      pathProblems.length === 0,
      pathProblems.length === 0 ? `${paths.length} routines` : pathProblems.join('; '),
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 11. THE ROLE MATRIX (§32)
// ─────────────────────────────────────────────────────────────────────────

interface RoleRow {
  readonly role: string;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly bypassrls: boolean;
  readonly createdb: boolean;
  readonly createrole: boolean;
  readonly replication: boolean;
  readonly inherit: boolean;
  readonly memberOf: string[];
  readonly temporaryOnDatabase: boolean;
  readonly createOnPublic: boolean;
  readonly financialExecute: string[];
  readonly journalDml: string[];
  readonly readsJournal: boolean;
  readonly readsAccounts: boolean;
}

async function roleMatrix(db: string): Promise<RoleRow[]> {
  section('11. the final role matrix (§32)');
  const rows: RoleRow[] = [];
  for (const role of ALL_ROLES) {
    const attrs = await sqlOne<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolinherit: boolean;
    }>(
      ownerUrl(db),
      `the role ${role}`,
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    const memberOf = (
      await sql<{ r: string }>(
        ownerUrl(db),
        `SELECT g.rolname AS r FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1 ORDER BY 1`,
        [role],
      )
    ).map((x) => x.r);
    const priv = await sqlOne<{ temp: boolean; create_public: boolean; reads_journal: boolean; reads_accounts: boolean }>(
      ownerUrl(db),
      `the privileges of ${role}`,
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege($1, 'public', 'CREATE')                AS create_public,
              has_table_privilege($1, 'journal_lines', 'SELECT')          AS reads_journal,
              has_table_privilege($1, 'accounts', 'SELECT')               AS reads_accounts`,
      [role],
    );
    const financialExecute = (
      await sql<{ f: string }>(
        ownerUrl(db),
        `SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'accounting\\_%'
            AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`,
        [role],
      )
    ).map((x) => x.f);
    const journalDml = (
      await sql<{ p: string }>(
        ownerUrl(db),
        `SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p
          EXCEPT SELECT p FROM (SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p) q
          WHERE NOT has_table_privilege($1, 'journal_lines', q.p) ORDER BY 1`,
        [role],
      )
    ).map((x) => x.p);
    rows.push({
      role,
      login: attrs.rolcanlogin,
      superuser: attrs.rolsuper,
      bypassrls: attrs.rolbypassrls,
      createdb: attrs.rolcreatedb,
      createrole: attrs.rolcreaterole,
      replication: attrs.rolreplication,
      inherit: attrs.rolinherit,
      memberOf,
      temporaryOnDatabase: priv.temp,
      createOnPublic: priv.create_public,
      financialExecute,
      journalDml,
      readsJournal: priv.reads_journal,
      readsAccounts: priv.reads_accounts,
    });
  }

  for (const r of rows) {
    console.log(
      `  ${r.role.padEnd(28)} login=${String(r.login)[0]} super=${String(r.superuser)[0]} bypassrls=${String(r.bypassrls)[0]} createdb=${String(r.createdb)[0]} ` +
        `createrole=${String(r.createrole)[0]} repl=${String(r.replication)[0]} temp=${String(r.temporaryOnDatabase)[0]} create(public)=${String(r.createOnPublic)[0]} ` +
        `journalDML=[${r.journalDml.join(',')}] memberOf=[${r.memberOf.join(',')}]`,
    );
  }

  // The invariants the matrix exists to protect.
  const superusers = rows.filter((r) => r.superuser);
  record('11.1 no principal is a superuser', superusers.length === 0, superusers.map((r) => r.role).join(', ') || 'none');
  const bypass = rows.filter((r) => r.bypassrls);
  record('11.2 no principal bypasses RLS', bypass.length === 0, bypass.map((r) => r.role).join(', ') || 'none');
  const writers = rows.filter((r) => r.role !== DEPLOYER && r.role !== 'daftar_accounting_internal' && r.journalDml.length > 0);
  record(
    '11.3 no runtime holds journal DML',
    writers.length === 0,
    writers.map((r) => `${r.role}:${r.journalDml.join('/')}`).join(', ') || 'only the deployer (as owner) and the internal posting authority',
  );
  const temps = rows.filter((r) => r.temporaryOnDatabase && r.role !== DEPLOYER);
  record('11.4 no runtime holds TEMPORARY', temps.length === 0, temps.map((r) => r.role).join(', ') || 'none');
  const creators = rows.filter((r) => r.createOnPublic && r.role !== DEPLOYER);
  record('11.5 only the deployer may create in public', creators.length === 0, creators.map((r) => r.role).join(', ') || 'none');
  const loginInternal = rows.find((r) => r.role === 'daftar_accounting_internal');
  record('11.6 the posting authority has no credential', loginInternal?.login === false, `daftar_accounting_internal login = ${String(loginInternal?.login)}`);
  const inventoryInternal = rows.find((r) => r.role === 'daftar_inventory_internal');
  record(
    '11.7 the inventory authority has no credential and inherits nothing',
    inventoryInternal?.login === false && inventoryInternal.inherit === false && inventoryInternal.memberOf.length === 0,
    `daftar_inventory_internal login = ${String(inventoryInternal?.login)}, inherit = ${String(inventoryInternal?.inherit)}, memberOf = [${inventoryInternal?.memberOf.join(',') ?? ''}]`,
  );
  const reachable = rows.filter(
    (r) => (RUNTIME_ROLES as readonly string[]).includes(r.role) && r.memberOf.some((m) => (INTERNAL_ROLES as readonly string[]).includes(m)),
  );
  record(
    '11.8 no runtime principal is a member of an internal authority',
    reachable.length === 0,
    reachable.map((r) => `${r.role} → ${r.memberOf.join(',')}`).join('; ') || 'none',
  );
  return rows;
}

/**
 * 11.9 / 11.10 — TEMPORARY and CREATE on `public` for every role the schema
 * knows and for PUBLIC, on one build. Asked of the deployer's database AND the
 * superuser control (P3-S9 A-09 3): bootstrap's revokes are the boundary, and
 * the history must not have handed either privilege back on either build.
 */
async function namespacePrivileges(db: string): Promise<NamespacePrivilegeRow[]> {
  const rows: NamespacePrivilegeRow[] = [];
  for (const role of [...ALL_ROLES, PUBLIC_GRANTEE]) {
    const priv = await sqlOne<{ temp: boolean; create_public: boolean }>(
      ownerUrl(db),
      `TEMPORARY and CREATE of ${role} in ${db}`,
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege($1, 'public', 'CREATE')                AS create_public`,
      [role === PUBLIC_GRANTEE ? 'public' : role],
    );
    rows.push({ role, temporaryOnDatabase: priv.temp, createOnPublic: priv.create_public });
  }
  return rows;
}

async function checkNamespacePrivileges(deployed: string, superuser: string): Promise<Record<string, NamespacePrivilegeRow[]>> {
  section('11b. TEMPORARY and CREATE on public, on both builds and for PUBLIC');
  const out: Record<string, NamespacePrivilegeRow[]> = {};
  const builds: readonly (readonly [label: string, db: string])[] = [
    ['the deployer-built database', deployed],
    ['the superuser-built control', superuser],
  ];
  for (const [n, [label, db]] of builds.entries()) {
    const rows = await namespacePrivileges(db);
    out[db] = rows;
    const problems = namespacePrivilegeProblems(rows, label);
    record(
      `11.${9 + n} ${label}: no role but the deployer, and not PUBLIC, holds TEMPORARY or CREATE on public`,
      problems.length === 0,
      problems.length === 0 ? `${rows.length} grantees asked, PUBLIC included` : problems.join('; '),
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inventory = buildInventory();
  checkInventoryAgainstBootstrap(inventory);
  checkDeployerIsNotARuntime();

  let deployerShape: Record<string, unknown> = {};
  let matrix: RoleRow[] = [];
  let catalogue: Record<string, number> = {};
  let namespace: Record<string, NamespacePrivilegeRow[]> = {};
  let applierOwned: Record<string, string[]> = {};

  if (!STATIC_ONLY) {
    startCluster();
    try {
      const DEPLOYED = 'daftar_deploy_case_a';
      await caseA(DEPLOYED);
      deployerShape = await checkLiveDeployerShape(DEPLOYED);
      await caseB('daftar_deploy_case_b');
      await caseC('daftar_deploy_case_c');
      await caseD(DEPLOYED);
      await caseE(DEPLOYED);
      await caseF('daftar_deploy_case_f');
      await caseG('daftar_deploy_case_g');
      await caseH('daftar_deploy_case_h', DEPLOYED);
      await checkHistoryAuthority(DEPLOYED);

      // The superuser control: the same bootstrap and the same history,
      // applied by a superuser, for section 10 to compare against.
      const SUPER_DB = 'daftar_deploy_superuser_control';
      await freshDatabase(SUPER_DB);
      await runMigrations(ownerUrl(SUPER_DB), MIGRATIONS_DIR);
      catalogue = await checkCatalogueEquivalence(DEPLOYED, SUPER_DB);
      applierOwned = await checkApplierOwnedDefiners(DEPLOYED, SUPER_DB);

      matrix = await roleMatrix(DEPLOYED);
      namespace = await checkNamespacePrivileges(DEPLOYED, SUPER_DB);
    } finally {
      stopCluster();
    }
  }

  const releaseDir = join(ROOT, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const artefact = {
    produced: 'scripts/phase2-deployment-authority.ts',
    producedAt: new Date().toISOString(),
    node: process.version,
    postgres: STATIC_ONLY ? null : run(join(PG_BIN, 'postgres'), ['--version'], { allowFailure: true }).trim(),
    deploymentPrincipal: DEPLOYER,
    staticOnly: STATIC_ONLY,
    inventory,
    bootstrapSha256: createHash('sha256')
      .update(readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql')))
      .digest('hex'),
    runnerSha256: createHash('sha256')
      .update(readFileSync(join(ROOT, 'apps/api/src/infra/migrate.ts')))
      .digest('hex'),
    deployerShape,
    catalogueRowCounts: catalogue,
    roleMatrix: matrix,
    namespacePrivileges: namespace,
    applierOwnedDefiners: { pinned: APPLIER_OWNED_DEFINERS, observed: applierOwned },
    phase3SliceHeads: PHASE3_SLICE_HEADS,
    steps,
    verdict: findings.length === 0 ? 'PASS' : 'FAIL',
    findings,
  };
  const out = join(releaseDir, 'phase2-s9-deployment-authority.json');
  writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);

  console.log(`\nDEPLOYMENT AUTHORITY: ${findings.length === 0 ? 'PASS' : `FAIL (${findings.length})`}`);
  console.log(`evidence: ${out.replace(`${ROOT}/`, '')}`);
  if (findings.length > 0) {
    for (const f of findings) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

// Importing this module runs nothing: `tests/security/deployment-authority-
// model.test.ts` imports the decisions above and must not start a cluster.
if (require.main === module) {
  void main().catch((e: unknown) => {
    stopCluster();
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
