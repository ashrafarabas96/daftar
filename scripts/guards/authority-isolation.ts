/**
 * P2-S1 authority isolation — the chart's write authority may not be reachable
 * from any credential.
 *
 * Tech Lead review, P2-S1 FINAL SECURITY CORRECTION: `daftar_platform` is a
 * LOGIN runtime role. Granting it INSERT on `accounts`, and owning the
 * SECURITY DEFINER seeding routines with it, meant a stolen platform password
 * could mint account rows by hand, outside the one routine that is allowed to
 * create a chart. A green test proving an over-broad grant is not a security
 * success, so the rule is now mechanical.
 *
 * The rule, in one sentence: the only principal that can write the chart is
 * `daftar_accounting_internal`, which is NOLOGIN, passwordless, unelevated and
 * granted to nobody — so its authority exists only inside the routines it
 * owns, and those are reachable only from the `businesses` trigger and the
 * migration itself.
 *
 * This reads migration and bootstrap TEXT, so a violation is caught before any
 * database is started. tests/security/accounting-boundary.test.ts proves the
 * same contract against a live server.
 */

/** The six roles a credential can exist for. None may touch the chart. */
export const LOGIN_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_provisioner'] as const;

/** The internal, unreachable principal that owns chart-writing authority. */
export const INTERNAL_ROLE = 'daftar_accounting_internal';

/** Tables whose write authority this rule isolates. */
export const CHART_TABLES = ['accounts', 'accounting_system_account_keys'] as const;

/** The two SECURITY DEFINER routines whose OWNER is the authority itself. */
export const SEEDING_ROUTINES = ['accounting_seed_chart(uuid)', 'accounting_seed_chart_trg()'] as const;

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

export interface TableGrant {
  readonly privileges: readonly string[];
  readonly tables: readonly string[];
  readonly grantees: readonly string[];
}

/** Every `GRANT ... ON <table list> TO <roles>` in a block of SQL. */
export function parseTableGrants(sql: string): TableGrant[] {
  const out: TableGrant[] = [];
  for (const m of sql.matchAll(/\bGRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\s+([^;]+);/gi)) {
    const [, privText = '', objText = '', granteeText = ''] = m;
    // Only TABLE grants are chart DML; FUNCTION/SCHEMA/DATABASE grants are
    // asserted separately.
    if (/^\s*(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|SEQUENCE|ALL\s+(TABLES|SEQUENCES|FUNCTIONS))\b/i.test(objText)) continue;
    out.push({
      privileges: privText
        .split(',')
        .map((x) =>
          x
            .trim()
            .replace(/\s*\([^)]*\)\s*$/, '')
            .toUpperCase(),
        )
        .filter(Boolean),
      tables: objText
        .replace(/^\s*TABLE\s+/i, '')
        .split(',')
        .map((x) => x.trim().replace(/^public\./i, ''))
        .filter(Boolean),
      grantees: granteeText
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    });
  }
  return out;
}

const isWrite = (p: string): boolean => p.startsWith('ALL') || (WRITE_PRIVILEGES as readonly string[]).includes(p);
const escapeFn = (fn: string): string => fn.replace(/[()]/g, '\\$&');

export interface AuthoritySources {
  /** Every migration, concatenated. */
  readonly schema: string;
  /** 0040_accounting_chart.sql on its own. */
  readonly chartSql: string;
  /** infrastructure/database/bootstrap.sql. */
  readonly bootstrap: string;
}

/**
 * Returns one human-readable violation per broken rule. Empty means the chart's
 * write authority is unreachable from every credential in the system.
 */
export function findAuthorityViolations(src: AuthoritySources): string[] {
  const v: string[] = [];
  const grants = parseTableGrants(src.schema);

  // 1. No LOGIN role — and not PUBLIC — may hold write authority on the chart.
  for (const grant of grants) {
    const chart = grant.tables.filter((t) => (CHART_TABLES as readonly string[]).includes(t));
    if (chart.length === 0) continue;
    const write = grant.privileges.filter(isWrite);
    if (write.length === 0) continue;
    for (const grantee of grant.grantees) {
      if ((LOGIN_ROLES as readonly string[]).includes(grantee) || grantee.toUpperCase() === 'PUBLIC') {
        v.push(`${grantee} is granted ${write.join('/')} on ${chart.join(', ')} — a LOGIN role must never hold chart DML`);
      }
    }
  }

  // 2. Nobody at all, internal principal included, may rewrite or remove a
  //    chart by grant. Seeding is INSERT and nothing else.
  for (const grant of grants) {
    if (!grant.tables.includes('accounts')) continue;
    for (const p of grant.privileges) {
      if (p === 'UPDATE' || p === 'DELETE' || p === 'TRUNCATE' || p.startsWith('ALL')) {
        v.push(`accounts grants ${p} to ${grant.grantees.join(', ')} — a seeded chart is never rewritten or removed by grant`);
      }
    }
  }

  // 3. A SECURITY DEFINER routine's OWNER is its authority. If that owner can
  //    log in, the authority has a credential.
  for (const fn of SEEDING_ROUTINES) {
    const owner = new RegExp(`ALTER\\s+FUNCTION\\s+${escapeFn(fn)}\\s+OWNER\\s+TO\\s+([a-z_]+)`, 'i').exec(src.chartSql)?.[1];
    if (!owner) v.push(`${fn} has no explicit OWNER TO — its authority is undefined`);
    else if ((LOGIN_ROLES as readonly string[]).includes(owner)) v.push(`${fn} is owned by the LOGIN role ${owner} — its authority would have a credential`);
    else if (owner !== INTERNAL_ROLE) v.push(`${fn} is owned by ${owner}, expected ${INTERNAL_ROLE}`);
    if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${escapeFn(fn)}\\s+FROM\\s+PUBLIC`, 'i').test(src.chartSql)) {
      v.push(`${fn} does not revoke EXECUTE from PUBLIC`);
    }
    for (const role of LOGIN_ROLES) {
      if (new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${escapeFn(fn)}[^;]*\\b${role}\\b`, 'i').test(src.chartSql)) {
        v.push(`${role} is granted EXECUTE on ${fn} — the routine must be unreachable from any credential`);
      }
    }
  }

  // 4. The internal principal must stay unreachable, and must never become a
  //    seventh runtime login.
  const statements = [...src.bootstrap.matchAll(new RegExp(`\\b(?:CREATE|ALTER)\\s+ROLE\\s+${INTERNAL_ROLE}\\b([^;]*);`, 'gi'))].map((m) =>
    (m[1] ?? '').toUpperCase(),
  );
  if (statements.length === 0) {
    v.push(`${INTERNAL_ROLE} is not created by bootstrap.sql — chart seeding would have no owner`);
  }
  for (const body of statements) {
    for (const attr of ['BYPASSRLS', 'SUPERUSER', 'CREATEROLE', 'CREATEDB', 'REPLICATION', 'LOGIN']) {
      // NOLOGIN / NOSUPERUSER / ... are the safe spellings. The bare attribute
      // is the violation; `\b` alone would not see inside NOBYPASSRLS anyway.
      if (new RegExp(`(?<!NO)\\b${attr}\\b`).test(body)) {
        v.push(`${INTERNAL_ROLE} is declared ${attr} — it must be NOLOGIN and hold no elevated attribute`);
      }
    }
    if (!/\bNOLOGIN\b/.test(body)) v.push(`${INTERNAL_ROLE} is not declared NOLOGIN`);
    if (/\bPASSWORD\b(?!\s+NULL)/.test(body)) v.push(`${INTERNAL_ROLE} is given a password — it must never have a credential`);
  }
  if (new RegExp(`GRANT\\s+CONNECT[^;]*\\b${INTERNAL_ROLE}\\b`, 'i').test(src.bootstrap)) {
    v.push(`${INTERNAL_ROLE} is granted CONNECT — it is NOLOGIN and must not be listed with the runtime logins`);
  }
  if (new RegExp(`GRANT\\s+${INTERNAL_ROLE}\\s+TO\\b`, 'i').test(`${src.bootstrap}\n${src.schema}`)) {
    v.push(`${INTERNAL_ROLE} is granted to another role — no runtime role may assume it`);
  }

  // 5. Isolation is not bought by weakening the global bypass.
  if (/FUNCTION\s+app_bypass\s*\(/i.test(src.chartSql)) {
    v.push('0040 redefines app_bypass() — authority isolation must not be bought by weakening the global bypass');
  }
  if (/BYPASSRLS/i.test(src.chartSql)) v.push('0040 mentions BYPASSRLS — RLS stays real for the seeder');

  return v;
}
