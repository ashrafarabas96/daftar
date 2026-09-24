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

/**
 * The P2-S4 source tables. Every runtime role that can read the journal can
 * read these — a reversal and an opening balance are meant to be visible —
 * and none of them may write one.
 */
export const SOURCE_TABLES = [
  'accounting_manual_adjustments',
  'accounting_reversals',
  'accounting_opening_balances',
  'accounting_opening_balance_lines',
] as const;

/**
 * The P2-S5 FX rate registry. ONE runtime reader — the merchant runtime,
 * which shows a business its own rates — and no runtime writer anywhere.
 * §44 is explicit that a role with no current requirement gets nothing,
 * so the platform and worker credentials are absent by decision.
 */
export const FX_TABLES = ['accounting_fx_rates'] as const;

/**
 * The P2-S6 period tables. The merchant runtime READS the periods — knowing
 * which months are closed is an ordinary answer a business needs — and reads
 * nothing of the operation registry, which is command bookkeeping rather than
 * merchant truth. No runtime role writes either, and nobody holds DELETE on
 * either: a period is never deleted, and the registry is append-only.
 */
export const PERIOD_TABLES = ['accounting_periods', 'accounting_period_operations'] as const;

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
  // P2-S4. The two append-only detail tables carry the same shape as the
  // journal: the writer inserts and can never rewrite what it wrote.
  accounting_manual_adjustments: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  accounting_reversals: { daftar_app: ['SELECT'], daftar_platform: ['SELECT'], daftar_worker: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  // The opening balance is the ONE place the internal authority holds UPDATE
  // and DELETE, and the reason is stated in 0047 section 6: a draft is a
  // workflow record nobody has relied on, its financial content freezes the
  // moment a journal entry exists for it, and the state triggers then admit
  // exactly one status change and nothing else. No runtime role holds either
  // privilege in any state, which is the invariant that matters.
  accounting_opening_balances: {
    daftar_app: ['SELECT'],
    daftar_platform: ['SELECT'],
    daftar_worker: ['SELECT'],
    [INTERNAL_ROLE]: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  },
  accounting_opening_balance_lines: {
    daftar_app: ['SELECT'],
    daftar_platform: ['SELECT'],
    daftar_worker: ['SELECT'],
    [INTERNAL_ROLE]: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  },
  // Reference data: which signed operation kind may create which source.
  // Readable by the writer, writable by nobody at runtime.
  accounting_operation_kinds: { [INTERNAL_ROLE]: ['SELECT'] },
  // P2-S5. Append-only history: the writer inserts and can never rewrite
  // what it wrote, and the merchant runtime reads under row level security.
  accounting_fx_rates: { daftar_app: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
  // P2-S6. The period is the ONE accounting table the internal authority
  // holds UPDATE on, and the reason is narrow: a close and a reopen change
  // `status` and its metadata in place, and 0049's transition trigger admits
  // exactly those two moves and refuses every other field, including the
  // boundaries and the identity. DELETE is held by NOBODY in any state — a
  // period that could be deleted is a period that could be un-closed without
  // a trace.
  accounting_periods: { daftar_app: ['SELECT'], [INTERNAL_ROLE]: ['INSERT', 'SELECT', 'UPDATE'] },
  accounting_period_operations: { [INTERNAL_ROLE]: ['INSERT', 'SELECT'] },
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
  // P2-S4 internals. `accounting_post_reversal` is deliberately absent for the
  // same reason `accounting_post_entry` is: it is a surface the merchant
  // runtime may execute, and it is modelled below.
  'accounting_reversal_entry_complete',
  'accounting_manual_adjustments_immutable',
  'accounting_reversals_immutable',
  'accounting_opening_balance_entry_complete',
  'accounting_opening_balances_state',
  'accounting_opening_balance_lines_state',
  'accounting_opening_balance_check_payload',
  'accounting_opening_balance_authority',
  // Retiring an opening position is only ever correct as part of posting its
  // replacement, so it is a step of `accounting_open_balance_post` and not a
  // verb anyone can reach on its own.
  'accounting_open_balance_supersede',
  // P2-S5 internals. `accounting_fx_rate_enter` and `accounting_fx_rate_lookup`
  // are deliberately absent for the same reason `accounting_post_entry` is:
  // they are surfaces the merchant runtime may execute, and they are modelled
  // below. Everything else the FX slice adds is reachable only from inside
  // the elevated command.
  'accounting_control_actor',
  'accounting_fx_rate_canonical',
  'accounting_fx_rate_fingerprint',
  'accounting_fx_rate_lock_key',
  'accounting_fx_rate_identity_lock_key',
  'accounting_fx_rates_immutable',
  // P2-S6 internals. The three period commands are deliberately absent for
  // the same reason the posting primitive is: they are surfaces the merchant
  // runtime may execute, and they are modelled below. Everything else the
  // period slice adds is reachable only from inside an elevated command or
  // from a trigger.
  'accounting_period_reason_digest',
  'accounting_period_canonical',
  'accounting_period_fingerprint',
  'accounting_period_topology_lock_key',
  'accounting_periods_no_delete',
  'accounting_periods_transition',
  'accounting_period_operations_immutable',
  'accounting_period_guard_posting',
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
  // P2-S4: the four merchant commands and the draft lifecycle. Each one is
  // assertion-gated, each one narrows to exactly one source identity, and the
  // platform credential reaches none of them — platform administration is not
  // financial authority.
  accounting_post_manual_adjustment: ['daftar_app'],
  accounting_post_reversal: ['daftar_app'],
  accounting_open_balance_draft: ['daftar_app'],
  accounting_open_balance_edit: ['daftar_app'],
  accounting_open_balance_discard: ['daftar_app'],
  accounting_open_balance_post: ['daftar_app'],
  // P2-S5: entering a rate is financial CONFIGURATION, and reading one is a
  // deterministic read. Both belong to the merchant runtime alone — platform
  // administration is not financial authority here either.
  accounting_fx_rate_enter: ['daftar_app'],
  accounting_fx_rate_lookup: ['daftar_app'],
  // P2-S6: creating, closing and reopening a period. Three narrow commands
  // belonging to the merchant runtime alone — the authority behind each one
  // is a signed acctctl/1 assertion, not the connection's identity, so this
  // grant is the ability to ASK and never the ability to decide.
  accounting_period_create: ['daftar_app'],
  accounting_period_close: ['daftar_app'],
  accounting_period_reopen: ['daftar_app'],
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
export const WATCHED_TABLES = [
  ...JOURNAL_TABLES,
  ...ACCOUNTING_REGISTRY_TABLES,
  ...ASSERTION_TABLES,
  ...SOURCE_TABLES,
  ...FX_TABLES,
  ...PERIOD_TABLES,
  'accounting_operation_kinds',
] as const;

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
