/**
 * Guard G-1 — the journal privilege matrix, as DATA rather than as a list of
 * tests someone remembered to write.
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
 * ── Three principals, three different rules (P2-S3, §69) ─────────────────
 *
 * P2-S2 could say "nobody writes" because it shipped no writer. P2-S3 ships
 * one, so the model now distinguishes the three classes explicitly rather
 * than letting a true-but-obsolete sentence fail a slice it was never about:
 *
 *   RUNTIME       the credentials services authenticate as. ZERO journal DML,
 *                 now and permanently. This is AL-03: a stolen runtime
 *                 credential must not be able to write the ledger.
 *   INTERNAL      `daftar_accounting_internal`, NOLOGIN, no password, no
 *                 CONNECT. It holds the MINIMUM the posting primitive needs —
 *                 INSERT, never UPDATE, DELETE or TRUNCATE — and is reachable
 *                 only by executing that primitive.
 *   DEPLOYMENT    whoever runs the migrations owns these tables, and
 *                 PostgreSQL gives an owner rights that cannot be revoked.
 *                 That credential is loaded by no service; it is a deployment
 *                 trust boundary, not a runtime one, and it is deliberately
 *                 outside this model. The immutability triggers in `0042`
 *                 refuse the owner as well.
 */

/** The three business-scoped ledger tables. */
export const JOURNAL_TABLES = ['journal_entries', 'journal_lines', 'accounting_source_bindings'] as const;

/** The two closed reference registries. */
export const ACCOUNTING_REGISTRY_TABLES = ['accounting_source_types', 'accounting_system_actors'] as const;

/** The P2-S3 assertion key domain. No runtime role may touch either (§15, §58). */
export const ASSERTION_TABLES = ['accounting_assertion_keys', 'accounting_assertion_uses'] as const;

/** Every role an application runtime authenticates as. */
export const RUNTIME_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_provisioner'] as const;

/** The unreachable principal the validators and the posting primitive run as. */
export const INTERNAL_ROLE = 'daftar_accounting_internal';

/** Privileges that would make a principal a writer. */
export const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

/** Privileges that would let a principal rewrite or destroy posted truth. */
export const MUTATING_PRIVILEGES = ['UPDATE', 'DELETE', 'TRUNCATE'] as const;

/**
 * The intended end state after P2-S3, exactly.
 *
 * `daftar_app`, `daftar_platform` and `daftar_worker` read the ledger.
 * `daftar_identity`, `daftar_resolver` and `daftar_provisioner` have no
 * journal access at all. No runtime role writes anything, anywhere in this
 * table — that is the invariant the whole slice exists to keep.
 *
 * `daftar_accounting_internal` reads (0043's validators must see a whole entry
 * regardless of the writing session's row-level visibility) and now INSERTs,
 * because 0045 gave it the one writer. It holds no UPDATE, DELETE or TRUNCATE
 * on journal truth, so even the writer cannot rewrite what it wrote. On the
 * key registry it may read (to verify) and insert/update (so the platform's
 * install and retire commands can run as it); it deliberately holds no DELETE,
 * so it cannot destroy key material.
 */
export const INTENDED_TABLE_GRANTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  journal_entries: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  journal_lines: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  accounting_source_bindings: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  // The date policy the primitive reads is data in this registry (§44).
  accounting_source_types: { [INTERNAL_ROLE]: ['SELECT'] },
  accounting_system_actors: {},
  accounting_assertion_keys: { [INTERNAL_ROLE]: ['INSERT', 'SELECT', 'UPDATE'] },
  accounting_assertion_uses: { [INTERNAL_ROLE]: ['DELETE', 'INSERT', 'SELECT'] },
};

/**
 * Routines that must be callable by NO runtime role and no PUBLIC.
 *
 * `accounting_post_entry` is deliberately absent: it is the one surface a
 * runtime role may execute, and its ACL is modelled separately below so that
 * "callable by nobody" never has to be softened into "callable by nobody
 * except…" — a sentence that rots.
 */
export const ACCOUNTING_ROUTINES = [
  'accounting_pow10',
  'accounting_assert_entry_valid',
  'accounting_validate_entry',
  'accounting_validate_entry_of_line',
  'businesses_base_currency_lock',
  'accounting_actor',
  'accounting_canonical_line',
  'accounting_fingerprint',
  'accounts_used_identity_immutable',
  'businesses_financial_start_guard',
  // The P2-S3 correction's account-stabilization pair. The lock key is not
  // secret, but §68's runtime surface is three routines and a helper does not
  // get to make it four; the trigger function reaches the key as the internal
  // principal instead.
  'accounting_account_lock_key',
  'accounts_posting_stability',
] as const;

/**
 * The exact runtime EXECUTE surface of the accounting domain (§68).
 *
 * Every routine named here, and no other, may be executed by the roles listed
 * against it. `accounting_post_entry` belongs to the merchant runtime alone —
 * not to the platform credential, because platform administration is not
 * financial authority and a stolen platform password must not be able to post.
 * The key commands belong to the platform credential alone, which can install
 * and retire key material and cannot read it back.
 */
export const RUNTIME_CALLABLE_ROUTINES: Readonly<Record<string, readonly string[]>> = {
  accounting_post_entry: ['daftar_app'],
  accounting_assertion_key_install: ['daftar_platform'],
  accounting_assertion_key_retire: ['daftar_platform'],
};

/**
 * Surfaces the ACCEPTED P2-S2 migrations (0042/0043) must not create.
 *
 * This is a statement about two frozen files, not about the database: P2-S3
 * legitimately creates every one of these in 0044/0045, and the permanent
 * P2-S2 regression gate must never be the reason an authorized later slice
 * cannot land. Callers therefore scope this to the text of 0042 and 0043.
 */
export const P2_S2_EXCLUDED_SURFACES = ['accounting_post_entry', 'accounting_actor', 'accounting_assertion_keys', 'accounting_assertion_uses'] as const;

/** Surfaces P2-S3 adds, which must now EXIST (they were excluded from P2-S2). */
export const REQUIRED_P2_S3_SURFACES = [
  'accounting_post_entry',
  'accounting_actor',
  'accounting_assertion_keys',
  'accounting_assertion_uses',
  'accounting_canonical_line',
  'accounting_fingerprint',
] as const;

/** One row of the live grant catalogue, with the table owner already excluded. */
export interface LiveTableGrant {
  readonly table: string;
  /** Role name, or `PUBLIC`. */
  readonly grantee: string;
  readonly privilege: string;
}

const key = (g: LiveTableGrant): string => `${g.grantee} ${g.privilege} ON ${g.table}`;

/** The tables this model governs. */
export const WATCHED_TABLES = [...JOURNAL_TABLES, ...ACCOUNTING_REGISTRY_TABLES, ...ASSERTION_TABLES] as const;

/**
 * Compare a live catalogue snapshot against the intended model. Returns one
 * human-readable violation per difference; an empty array means the live
 * database matches the intended matrix exactly.
 *
 * The message names WHICH rule was broken, because the three principal classes
 * fail for different reasons and a reader fixing a CI failure needs to know
 * whether they have widened a runtime credential (never allowed) or given the
 * internal authority more than the writer needs (allowed only by changing the
 * model deliberately, here, in a reviewed diff).
 */
export function compareTableGrants(live: readonly LiveTableGrant[]): string[] {
  const watched = new Set<string>(WATCHED_TABLES);
  const runtime = new Set<string>(RUNTIME_ROLES);
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
    const isWrite = (WRITE_PRIVILEGES as readonly string[]).includes(grant.privilege);
    const isMutating = (MUTATING_PRIVILEGES as readonly string[]).includes(grant.privilege);
    if (isWrite && (runtime.has(grant.grantee) || grant.grantee === 'PUBLIC')) {
      violations.push(
        `${grant.grantee} holds ${grant.privilege} on ${grant.table} — a RUNTIME principal must never hold journal DML; the only writer is the posting primitive (AL-03/AL-18)`,
      );
    } else if (isMutating && grant.grantee === INTERNAL_ROLE) {
      violations.push(
        `${grant.grantee} holds ${grant.privilege} on ${grant.table} — the internal posting authority may INSERT and must never be able to rewrite or destroy posted truth`,
      );
    } else {
      violations.push(`${grant.grantee} holds ${grant.privilege} on ${grant.table}, which the intended accounting grant model does not include`);
    }
  }
  for (const k of expected) {
    if (!seen.has(k)) violations.push(`the intended grant "${k}" is missing — the accounting grant model and the live database disagree`);
  }
  return violations.sort();
}
