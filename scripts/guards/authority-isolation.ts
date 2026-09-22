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
 * `daftar_accounting_internal`, which is NOLOGIN, passwordless and unelevated,
 * so its authority exists only inside the routines it owns, and those are
 * reachable only from the `businesses` trigger and the migration itself.
 *
 * Tech Lead review, P2-S1 MANAGED-POSTGRESQL CORRECTION: the earlier form of
 * this rule said the internal principal is "granted to nobody". That is too
 * strict to be true. PostgreSQL will not let a non-superuser hand a function to
 * a new owner it cannot SET ROLE to, so "granted to nobody" silently meant
 * "DAFTAR requires a superuser to migrate", which is not a contract a managed
 * PostgreSQL can meet. The boundary that actually matters is narrower and is
 * what this guard now enforces:
 *
 *   NO RUNTIME PRINCIPAL MAY ASSUME daftar_accounting_internal.
 *
 * Exactly one membership is permitted — the deployment migrator, WITH INHERIT
 * FALSE so the membership is not authority in itself. Runtime authority and
 * deployment authority are two different trust boundaries.
 *
 * This reads migration and bootstrap TEXT, so a violation is caught before any
 * database is started. tests/security/accounting-boundary.test.ts proves the
 * same contract against a live server, and
 * tests/integration/migration-portability.test.ts proves the migration itself
 * runs without a superuser.
 */

import { stripComments } from './sql-schema';

/** The six roles an application runtime authenticates as. None may touch the chart. */
export const LOGIN_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_provisioner'] as const;

/** The internal, unreachable principal that owns chart-writing authority. */
export const INTERNAL_ROLE = 'daftar_accounting_internal';

/**
 * The deployment migration principal — a LOGIN role, but not a runtime: no
 * service loads its credential. It is the ONLY permitted member of
 * INTERNAL_ROLE, and only because PostgreSQL ownership semantics require it.
 */
export const MIGRATION_ROLE = 'daftar_migrator';

/** Tables whose write authority this rule isolates. */
export const CHART_TABLES = ['accounts', 'accounting_system_account_keys'] as const;

/**
 * The ledger tables. The rule for these is as strict as for the chart: the
 * only principal that may write them is the unreachable internal one, and only
 * by INSERT. No grant in any migration may hand a LOGIN role or PUBLIC any
 * journal DML, and no grant may give even the internal principal UPDATE,
 * DELETE or TRUNCATE — posted truth is never rewritten by grant.
 */
export const JOURNAL_TABLES = [
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_source_types',
  'accounting_system_actors',
] as const;

/** The closed reference registries among them: reference data, never ledger truth. */
export const JOURNAL_REGISTRY_TABLES = ['accounting_source_types', 'accounting_system_actors'] as const;

/** The two SECURITY DEFINER routines whose OWNER is the authority itself. */
export const SEEDING_ROUTINES = ['accounting_seed_chart(uuid)', 'accounting_seed_chart_trg()'] as const;

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

export interface TableGrant {
  readonly privileges: readonly string[];
  readonly tables: readonly string[];
  readonly grantees: readonly string[];
}

/**
 * Every `GRANT ... ON <table list> TO <roles>` in a block of SQL.
 *
 * Comments are stripped first and no capture may span a `;`. Both matter: a
 * migration that documents the grant it forbids, or that contains a PL/pgSQL
 * body mentioning `role_table_grants`, would otherwise let one enormous match
 * swallow the statements after it — and a guard that silently stops seeing
 * grants is worse than no guard, because it stays green.
 */
export function parseTableGrants(rawSql: string): TableGrant[] {
  const sql = stripComments(rawSql);
  const out: TableGrant[] = [];
  for (const m of sql.matchAll(/\bGRANT\s+([^;]+?)\s+ON\s+([^;]+?)\s+TO\s+([^;]+);/gi)) {
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

  // 5. Membership. Exactly one is permitted, and it is not a runtime.
  for (const m of `${src.bootstrap}\n${src.schema}`.matchAll(new RegExp(`GRANT\\s+${INTERNAL_ROLE}\\s+TO\\s+([^;]+);`, 'gi'))) {
    const clause = m[1] ?? '';
    const [granteeText = ''] = clause.split(/\bWITH\b/i);
    const grantees = granteeText
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const grantee of grantees) {
      if ((LOGIN_ROLES as readonly string[]).includes(grantee)) {
        v.push(`${INTERNAL_ROLE} is granted to the runtime role ${grantee} — no runtime principal may assume chart-writing authority`);
      } else if (grantee.toUpperCase() === 'PUBLIC') {
        v.push(`${INTERNAL_ROLE} is granted to PUBLIC — every principal would inherit chart-writing authority`);
      } else if (grantee !== MIGRATION_ROLE) {
        v.push(`${INTERNAL_ROLE} is granted to ${grantee}; only the deployment principal ${MIGRATION_ROLE} may be a member`);
      } else {
        // The one permitted membership has to stay a capability that must be
        // assumed deliberately, not privileges the migrator simply carries.
        if (!/\bINHERIT\s+FALSE\b/i.test(clause)) {
          v.push(`${MIGRATION_ROLE}'s membership in ${INTERNAL_ROLE} is not WITH INHERIT FALSE — it would carry accounting authority implicitly`);
        }
        if (/\bADMIN\s+TRUE\b/i.test(clause)) {
          v.push(`${MIGRATION_ROLE} is granted ${INTERNAL_ROLE} WITH ADMIN TRUE — it could then hand that authority to a runtime role`);
        }
      }
    }
  }

  // 6. The deployment principal is deployment authority, not a seventh runtime
  //    and never a superuser.
  const migratorStatements = [...src.bootstrap.matchAll(new RegExp(`\\b(?:CREATE|ALTER)\\s+ROLE\\s+${MIGRATION_ROLE}\\b([^;]*);`, 'gi'))].map((m) =>
    (m[1] ?? '').toUpperCase(),
  );
  if (migratorStatements.length === 0) {
    v.push(`${MIGRATION_ROLE} is not created by bootstrap.sql — a managed deployment would have no non-superuser way to run 0040`);
  }
  for (const body of migratorStatements) {
    for (const attr of ['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB', 'REPLICATION']) {
      if (new RegExp(`(?<!NO)\\b${attr}\\b`).test(body)) {
        v.push(`${MIGRATION_ROLE} is declared ${attr} — DAFTAR must never require, or quietly hold, that much authority to migrate`);
      }
    }
    for (const required of ['NOSUPERUSER', 'NOBYPASSRLS']) {
      if (!new RegExp(`\\b${required}\\b`).test(body)) {
        v.push(`${MIGRATION_ROLE} does not assert ${required} — the portability claim depends on it`);
      }
    }
  }
  // It must not be handed runtime data authority in a migration either.
  for (const grant of grants) {
    if (grant.grantees.includes(MIGRATION_ROLE)) {
      v.push(`${MIGRATION_ROLE} is granted table privileges by a migration — deployment authority comes from ownership, never from runtime grants`);
    }
  }

  // 7. The temporary CREATE that ownership transfer needs must be given back.
  const takesCreate = new RegExp(`GRANT\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+TO\\s+[^;]*\\b${INTERNAL_ROLE}\\b`, 'i').test(src.chartSql);
  const givesCreateBack = new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+FROM\\s+[^;]*\\b${INTERNAL_ROLE}\\b`, 'i').test(src.chartSql);
  if (takesCreate && !givesCreateBack) {
    v.push(`0040 grants ${INTERNAL_ROLE} CREATE on schema public and never revokes it — a lingering CREATE privilege is not a temporary one`);
  }
  if (new RegExp(`GRANT\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+TO\\s+[^;]*\\b${INTERNAL_ROLE}\\b`, 'i').test(src.bootstrap)) {
    v.push(
      `bootstrap.sql grants ${INTERNAL_ROLE} CREATE on schema public — that privilege belongs to one migration statement, not to the permanent role shape`,
    );
  }

  // 9. The journal's write authority is unreachable from every credential
  //    (AL-18 / directive §32, §69). This reads every migration, so a GRANT
  //    added by a later slice is caught the moment it lands rather than when
  //    someone re-reads the file.
  //
  //    P2-S3 gave the ledger a writer, so the rule is no longer "nobody".
  //    It is the rule that always mattered: no LOGIN role and no PUBLIC may
  //    hold journal DML; the unreachable internal principal may hold INSERT
  //    and nothing more, so even the writer cannot rewrite what it wrote; and
  //    the closed reference registries stay write-free for everyone.
  for (const grant of grants) {
    const journal = grant.tables.filter((t) => (JOURNAL_TABLES as readonly string[]).includes(t));
    if (journal.length === 0) continue;
    const write = grant.privileges.filter(isWrite);
    if (write.length === 0) continue;
    const registries = journal.filter((t) => (JOURNAL_REGISTRY_TABLES as readonly string[]).includes(t));
    for (const grantee of grant.grantees) {
      if ((LOGIN_ROLES as readonly string[]).includes(grantee) || grantee.toUpperCase() === 'PUBLIC') {
        v.push(`${grantee} is granted ${write.join('/')} on ${journal.join(', ')} — a credential-reachable principal must never hold journal DML`);
        continue;
      }
      if (grantee === INTERNAL_ROLE) {
        const beyond = write.filter((p) => p !== 'INSERT');
        if (beyond.length > 0) {
          v.push(
            `${INTERNAL_ROLE} is granted ${beyond.join('/')} on ${journal.join(', ')} — the posting authority may INSERT and must never rewrite or remove posted truth`,
          );
        }
        if (registries.length > 0) {
          v.push(`${INTERNAL_ROLE} is granted ${write.join('/')} on ${registries.join(', ')} — the closed registries are reference data, not ledger truth`);
        }
        continue;
      }
      v.push(`${grantee} is granted ${write.join('/')} on ${journal.join(', ')} — only ${INTERNAL_ROLE} may write the ledger, and only by INSERT`);
    }
  }

  // 8. Isolation is not bought by weakening the global bypass.
  if (/FUNCTION\s+app_bypass\s*\(/i.test(src.chartSql)) {
    v.push('0040 redefines app_bypass() — authority isolation must not be bought by weakening the global bypass');
  }
  if (/\bBYPASSRLS\b/i.test(src.chartSql)) v.push('0040 mentions BYPASSRLS — RLS stays real for the seeder');

  return v;
}
