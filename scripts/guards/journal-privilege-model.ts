/**
 * Guard G-1 (Architecture Lock, slice P2-S2) — the journal privilege matrix,
 * as DATA rather than as a list of tests someone remembered to write.
 *
 * The failure this exists to catch is not today's grants; it is next year's.
 * A hand-written negative test proves only the case its author thought of, so
 * a migration that adds `GRANT INSERT ON journal_lines TO daftar_worker`
 * would sail past six passing "role X cannot write" tests. This module states
 * the INTENDED end state exactly, and the live PostgreSQL grant catalogue is
 * compared against it: anything present that is not intended is a violation,
 * and anything intended that is missing is a violation too.
 *
 * Adversarial DML tests stay — they prove the grant is actually enforced at
 * the boundary rather than merely recorded. Both halves are required; neither
 * substitutes for the other.
 *
 * The table OWNER is deliberately outside this model. Whoever runs the
 * migrations owns these tables and PostgreSQL gives an owner rights that
 * cannot be revoked, which is why that credential is a deployment credential
 * loaded by no service — and why the immutability triggers in `0042` refuse
 * the owner as well.
 */

/** The three business-scoped ledger tables. */
export const JOURNAL_TABLES = ['journal_entries', 'journal_lines', 'accounting_source_bindings'] as const;

/** The two closed reference registries. Default deny: nobody reads them. */
export const ACCOUNTING_REGISTRY_TABLES = ['accounting_source_types', 'accounting_system_actors'] as const;

/** Every role an application runtime authenticates as. */
export const RUNTIME_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_provisioner'] as const;

/** The unreachable principal the commit-time validators run as. */
export const INTERNAL_ROLE = 'daftar_accounting_internal';

/** Privileges that would make a principal a writer. */
export const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

/**
 * The intended end state of P2-S2, exactly.
 *
 * `daftar_app`, `daftar_platform` and `daftar_worker` read the ledger.
 * `daftar_identity`, `daftar_resolver` and `daftar_provisioner` have no
 * journal access at all. `daftar_accounting_internal` reads — and only reads
 * — because 0043's validators must see a whole entry regardless of the
 * writing session's row-level visibility. Nobody writes: there is no writer
 * in this slice, and `GRANT EXECUTE` on a posting primitive is P2-S3.
 */
export const INTENDED_TABLE_GRANTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  journal_entries: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['SELECT'] },
  journal_lines: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['SELECT'] },
  accounting_source_bindings: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['SELECT'] },
  accounting_source_types: {},
  accounting_system_actors: {},
};

/** Routines P2-S2 adds. None may be callable by any runtime role or PUBLIC. */
export const ACCOUNTING_ROUTINES = [
  'accounting_pow10',
  'accounting_assert_entry_valid',
  'accounting_validate_entry',
  'accounting_validate_entry_of_line',
  'businesses_base_currency_lock',
] as const;

/** Surfaces that belong to P2-S3 and must not exist after P2-S2 (§40). */
export const FORBIDDEN_P2_S3_SURFACES = ['accounting_post_entry', 'accounting_actor', 'accounting_assertion_keys', 'accounting_assertion_uses'] as const;

/** One row of the live grant catalogue, with the table owner already excluded. */
export interface LiveTableGrant {
  readonly table: string;
  /** Role name, or `PUBLIC`. */
  readonly grantee: string;
  readonly privilege: string;
}

const key = (g: LiveTableGrant): string => `${g.grantee} ${g.privilege} ON ${g.table}`;

/**
 * Compare a live catalogue snapshot against the intended model. Returns one
 * human-readable violation per difference; an empty array means the live
 * database matches the intended matrix exactly.
 */
export function compareTableGrants(live: readonly LiveTableGrant[]): string[] {
  const watched = new Set<string>([...JOURNAL_TABLES, ...ACCOUNTING_REGISTRY_TABLES]);
  const expected = new Set<string>();
  for (const [table, grants] of Object.entries(INTENDED_TABLE_GRANTS)) {
    for (const [grantee, privileges] of Object.entries(grants)) {
      for (const privilege of privileges) expected.add(key({ table, grantee, privilege }));
    }
  }

  const violations: string[] = [];
  const seen = new Set<string>();
  for (const grant of live) {
    if (!watched.has(grant.table)) continue;
    const k = key(grant);
    seen.add(k);
    if (expected.has(k)) continue;
    const write = (WRITE_PRIVILEGES as readonly string[]).includes(grant.privilege);
    violations.push(
      write
        ? `${grant.grantee} holds ${grant.privilege} on ${grant.table} — P2-S2 has NO writer; a journal write privilege is a breach of AL-03/AL-18`
        : `${grant.grantee} holds ${grant.privilege} on ${grant.table}, which the intended P2-S2 grant model does not include`,
    );
  }
  for (const k of expected) {
    if (!seen.has(k)) violations.push(`the intended grant "${k}" is missing — the ledger is less readable than P2-S2 specifies`);
  }
  return violations.sort();
}
