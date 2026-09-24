/**
 * THE DATABASE CREDENTIAL MATRIX (P2-S8 §13, §14, §17).
 *
 * Every earlier accounting suite asks "does the product refuse this?". This
 * one asks a different question, from a different seat: given a caller who
 * already holds one of DAFTAR's six runtime database credentials, knows the
 * schema exactly, and is not going through the application at all — what can
 * they actually do?
 *
 * TWO DOMAINS, KEPT APART (§14). A refusal can come from two very different
 * places, and calling one the other is how a system ends up believing it has
 * an invariant it does not have:
 *
 *   AUTHORIZATION — "permission denied for table journal_lines". The caller
 *                   was never allowed to try. That is what this file proves.
 *   INVARIANT     — the caller WAS allowed to try and the database refused
 *                   the FACT. That is tests/security/accounting-raw-sql-
 *                   invariants.test.ts, and it runs under a credential that
 *                   can actually reach the tables, because a permission
 *                   denial proves nothing about a constraint.
 *
 * NOTHING HERE IS A LIST TO MAINTAIN. The roles are the six the bootstrap
 * creates, the tables and functions are DISCOVERED from the live schema, and
 * a migration that adds an accounting table or a SECURITY DEFINER routine is
 * covered by this file the day it lands — not the day someone remembers to
 * add a line.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

/** The six runtime credentials. Deployment/test authority is NOT one of them. */
const RUNTIME_ROLES: readonly [string, string][] = [
  ['daftar_app', appDbUrl],
  ['daftar_platform', platformDbUrl],
  ['daftar_worker', workerDbUrl],
  ['daftar_identity', identityDbUrl],
  ['daftar_resolver', resolverDbUrl],
  ['daftar_provisioner', provisionerDbUrl],
];

/** Every table the accounting slices own, read from the live catalogue. */
let ACCOUNTING_TABLES: string[] = [];
/** Every SECURITY DEFINER routine reachable in the final schema. */
let DEFINER_FUNCTIONS: { name: string; owner: string; config: string[] | null }[] = [];

async function asRole<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Ask the database itself, rather than asserting against a remembered list. */
async function privilege(c: Client, table: string, privilegeName: string): Promise<boolean> {
  const { rows } = await c.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, $1, $2) AS ok`, [table, privilegeName]);
  return must(rows[0]).ok;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  ACCOUNTING_TABLES = (
    await ownerPool().query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (c.relname LIKE 'accounting%' OR c.relname IN ('accounts', 'journal_entries', 'journal_lines'))
        ORDER BY c.relname`,
    )
  ).rows.map((r) => r.name);
  DEFINER_FUNCTIONS = (
    await ownerPool().query<{ name: string; owner: string; config: string[] | null }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY p.proname`,
    )
  ).rows;
  expect(ACCOUNTING_TABLES.length).toBeGreaterThan(8);
  expect(DEFINER_FUNCTIONS.length).toBeGreaterThan(5);
}, 300_000);

describe('AUTHORIZATION — what each runtime credential may touch (§14)', () => {
  /**
   * The rule the whole accounting design rests on, and the one an attacker
   * would most like to be wrong: the journal has NO writer. Not the merchant
   * runtime, not the platform administrator, not the worker. The only thing
   * that writes a journal row is a SECURITY DEFINER command running as a
   * principal nobody can log in as.
   */
  it('NO runtime credential holds INSERT, UPDATE, DELETE or TRUNCATE on ANY accounting table', async () => {
    const violations: string[] = [];
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        for (const table of ACCOUNTING_TABLES) {
          for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
            if (await privilege(c, table, p)) violations.push(`${role} holds ${p} on ${table}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  }, 300_000);

  it('the assertion key ring is unreadable by every runtime credential', async () => {
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        for (const table of ['accounting_assertion_keys', 'provisioning_assertion_keys']) {
          const { rows } = await c.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [table]);
          if (!must(rows[0]).exists) continue;
          expect(await privilege(c, table, 'SELECT'), `${role} must not read ${table}`).toBe(false);
        }
      });
    }
  }, 300_000);

  /**
   * A caller who can create a table in `public` can shadow a name a trusted
   * routine resolves. A caller who can create a TEMP table can do the same
   * thing if `pg_temp` is searched first. Both doors are checked for every
   * credential, because §17's search-path hardening is only as good as the
   * absence of a place to put the decoy.
   */
  it('no runtime credential may CREATE in the public schema', async () => {
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        const { rows } = await c.query<{ ok: boolean }>(`SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok`);
        expect(must(rows[0]).ok, `${role} must not CREATE in public`).toBe(false);
        await expect(c.query(`CREATE TABLE public.shadow_probe (x int)`)).rejects.toThrow(/permission denied|must be owner/i);
      });
    }
  }, 300_000);

  /**
   * The temp-shadowing class, closed at the privilege rather than at the path.
   *
   * PostgreSQL searches the session temporary schema FIRST for relation and
   * type names whenever `pg_temp` is not named explicitly, and it grants
   * TEMPORARY on a database to PUBLIC by default. Together those would let
   * any login role create `pg_temp.accounting_assertion_keys` and have an
   * elevated routine read the attacker's table instead of the registry.
   *
   * Guard G-5 governs what may be WRITTEN — every new routine names pg_temp
   * last. This asserts the half that closes the class for the routines whose
   * bytes are frozen and can no longer be edited: there is nowhere to put the
   * decoy, because no runtime credential may create a session relation.
   */
  it('no runtime credential may create a session relation, so pg_temp cannot be populated', async () => {
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        const { rows } = await c.query<{ ok: boolean; db: string }>(
          `SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS ok, current_database() AS db`,
        );
        expect(must(rows[0]).ok, `${role} must not hold TEMPORARY`).toBe(false);
        await expect(c.query(`CREATE TEMP TABLE shadow_probe (x int)`)).rejects.toThrow(/permission denied/i);
      });
    }
  }, 300_000);
});

describe('AUTHORIZATION — SECURITY DEFINER effective state (§17)', () => {
  /**
   * Every definer routine in the FINAL schema, not only the ones a recent
   * migration added. A frozen migration is not exempt from this: the
   * effective database is what an attacker meets.
   */
  /**
   * The paths themselves, read from the live catalogue rather than from the
   * migration text — the effective database is what an attacker meets, and a
   * routine whose migration is frozen may still have been corrected by a
   * later `ALTER FUNCTION`.
   *
   * The rule is about ORDER, not presence. `pg_temp` named LAST is the
   * hardened form; `pg_temp` named first, or a caller-writable schema ahead
   * of a trusted one, is exactly as broken as omitting it. A routine that
   * omits it entirely is covered by the privilege half above.
   */
  it('no SECURITY DEFINER routine searches a caller-writable schema before a trusted one', () => {
    const offenders: string[] = [];
    for (const f of DEFINER_FUNCTIONS) {
      const setting = (f.config ?? []).find((c) => c.toLowerCase().startsWith('search_path='));
      if (!setting) {
        offenders.push(`${f.name} pins no search_path at all`);
        continue;
      }
      const schemas = setting
        .slice('search_path='.length)
        .split(',')
        .map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase())
        .filter((x) => x.length > 0);
      const tempAt = schemas.indexOf('pg_temp');
      if (tempAt !== -1 && tempAt !== schemas.length - 1) {
        offenders.push(`${f.name} searches pg_temp at position ${tempAt + 1} of ${schemas.length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * MEMBERSHIP, not ownership.
   *
   * That a definer routine runs as its owner is the whole mechanism; what
   * must never be true is that a runtime credential can BECOME that owner and
   * do everything the owner can, rather than only the narrow command the
   * owner exposes. `SET ROLE` is the difference between "may post an entry"
   * and "may rewrite the journal".
   *
   * `daftar_platform` owning the Phase 1 provisioning commands is accepted
   * design — `daftar_provisioner` executes them and gains exactly those
   * commands, never the role. So the assertion excludes a credential from
   * being measured against itself and asserts everything else.
   */
  it('no runtime credential can BECOME the owner of a SECURITY DEFINER routine', async () => {
    const owners = [...new Set(DEFINER_FUNCTIONS.map((f) => f.owner))];
    const violations: string[] = [];
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        for (const owner of owners.filter((o) => o !== role)) {
          const { rows } = await c.query<{ member: boolean }>(`SELECT pg_has_role(current_user, $1, 'USAGE') AS member`, [owner]);
          if (must(rows[0]).member) violations.push(`${role} can act as ${owner}`);
        }
      });
    }
    expect(violations).toEqual([]);
  }, 300_000);

  /**
   * The accounting principal specifically. Every journal write in DAFTAR runs
   * as `daftar_accounting_internal`; if that role could log in, the entire
   * "no writer anywhere" property would be a formality.
   */
  it('the accounting principal cannot log in, and owns the whole accounting command surface', async () => {
    const accountingOwned = DEFINER_FUNCTIONS.filter((f) => /^accounting[_]/.test(f.name));
    expect(accountingOwned.length).toBeGreaterThan(10);
    expect([...new Set(accountingOwned.map((f) => f.owner))]).toEqual(['daftar_accounting_internal']);
    const { rows } = await ownerPool().query<{ rolcanlogin: boolean }>(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'daftar_accounting_internal'`);
    expect(must(rows[0]).rolcanlogin).toBe(false);
  });

  it('no runtime credential holds BYPASSRLS or superuser', async () => {
    const { rows } = await ownerPool().query<{ rolname: string; bad: boolean }>(
      `SELECT rolname, (rolsuper OR rolbypassrls) AS bad FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [RUNTIME_ROLES.map(([r]) => r)],
    );
    expect(rows.length).toBe(RUNTIME_ROLES.length);
    expect(rows.filter((r) => r.bad).map((r) => r.rolname)).toEqual([]);
  });

  /**
   * The one global bypass in the system, named rather than discovered by
   * accident. `0032` narrowed `app_bypass()` from "anyone who sets the GUC"
   * to "the platform administrator", and that is a property worth pinning:
   * if a later migration widened it back, every RESTRICTIVE policy in the
   * database would loosen at once.
   */
  it('app_bypass() exempts exactly one principal, and a GUC cannot buy it', async () => {
    for (const [role, url] of RUNTIME_ROLES) {
      await asRole(url, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
        const { rows } = await c.query<{ ok: boolean }>(`SELECT app_bypass() AS ok`);
        expect(must(rows[0]).ok, `${role} bypass via GUC`).toBe(role === 'daftar_platform');
        await c.query('ROLLBACK');
      });
    }
  }, 300_000);
});

describe('AUTHORIZATION — the accounting commands (§14)', () => {
  /**
   * EXECUTE on the posting and control commands belongs to `daftar_app` and
   * to nobody else. A worker or platform credential that could call them
   * would be a second posting authority, and the assertion it would need is
   * one it cannot mint — but authority should not depend on that alone.
   */
  it('only daftar_app may EXECUTE the accounting command surface', async () => {
    const commands = DEFINER_FUNCTIONS.map((f) => f.name).filter((n) => /^accounting_(post|period|fx|open)/.test(n));
    expect(commands.length).toBeGreaterThan(3);
    const violations: string[] = [];
    for (const [role, url] of RUNTIME_ROLES) {
      if (role === 'daftar_app') continue;
      await asRole(url, async (c) => {
        for (const name of commands) {
          const { rows } = await c.query<{ ok: boolean }>(
            `SELECT bool_or(has_function_privilege(current_user, p.oid, 'EXECUTE')) AS ok
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = $1`,
            [name],
          );
          if (rows[0]?.ok) violations.push(`${role} may execute ${name}`);
        }
      });
    }
    expect(violations).toEqual([]);
  }, 300_000);
});
