/**
 * THE DECLARED SCHEMA CONTRACT OF THE POS TILL SESSION (P4-S3; lock
 * `P4-AL-40`, `P4-AL-86`; `OD-P4-09` OPTION A — **one session, one
 * authenticated user**).
 *
 * ## Why this file exists at all
 *
 * The migration that creates `pos_till_sessions` and `pos_cart_lines` is
 * `0079`, and it belongs to the migration owner of this slice — nobody else
 * may create or edit a migration, and nobody may invent its number. The
 * product path, the refusal vocabulary and the law that proves the rule
 * cannot be bypassed are this module's, and they were written BEFORE `0079`
 * landed.
 *
 * That order of work has exactly one hazard: a service that spells a column
 * name differently from the migration is a service that fails at run time
 * with a syntax error rather than a refusal, and a guard that spells it
 * differently is a guard that is green because it has no subject. So the
 * names are written down ONCE, here, and used twice:
 *
 *   - every statement the till-session service issues is built from these
 *     identifiers, so reconciling a name with the migration owner is ONE edit
 *     in ONE file rather than a search through SQL strings;
 *   - `tests/guards/pos-s3-session-law.test.ts` reads this contract and
 *     requires the migration tree to satisfy it — so this is not a guess
 *     about `0079`, it is a REQUIREMENT ON `0079`, enforced the moment `0079`
 *     exists and silent (NOT-YET-APPLICABLE, which is not a pass: the guard
 *     says so by name) while it does not.
 *
 * A declared contract that nothing checks would be a promise, and a promise
 * is not a protection. The checking half is the guard suite, not this file.
 *
 * ## The four laws the contract encodes
 *
 * **L1 — the session has ONE owning authenticated user, and it is NOT NULL.**
 * `OD-P4-09` OPTION A. A nullable owner is a shared till with the owner
 * omitted, which is OPTION B spelled as an absence.
 *
 * **L2 — the owner is IMMUTABLE at the database.** This is the load-bearing
 * one, and the reason the rule may not live in the service alone.
 * `Database.withTransaction` / `Database.scoped` (`infra/database.ts`) are the
 * TRUSTED GENERIC PRIMITIVE: any code in the merchant process can open a
 * scoped transaction as `daftar_app` and issue arbitrary SQL under the
 * caller's own tenant and business GUCs. Nothing about that primitive is
 * wrong — it is how every read in the estate works — but it means a rule
 * enforced by an `if` in this module is a rule the next writer in this process
 * does not inherit. `UPDATE pos_till_sessions SET <owner> = $1` must therefore
 * be refused BY THE SCHEMA, so the refusal is a property of the data and not
 * of the call site.
 *
 * **L3 — OPTION B is UNREPRESENTABLE, not merely unused.** The refused option
 * was "a shared till session with a per-sale actor". A per-row actor column on
 * a POS relation is that option, available to the next writer, and a column
 * for a state the ruling forbids is a hint that the state exists — the same
 * reason `selling-errors.ts` carries no `sale.partially_committed`. So no POS
 * relation other than the session itself carries an actor column at all: the
 * session's owner is the only actor of record, which is precisely what makes
 * the audit row's actor and the session's owner the same person and gives a
 * cash-drawer discrepancy a single owner.
 *
 * **L4 — the till is bound to a branch** (`P4-AL-40`): a POS session carries
 * the branch, and a user whose `member_branch_scopes` do not include it is
 * refused by the policy rather than by a predicate a controller writes.
 *
 * ## What this contract deliberately does NOT contain
 *
 * No money column of a non-integer type, and no derived total: the opening
 * float and the closing count are integer minor units, and the till's
 * *expected* cash is a computation over the session's sales and payments, not
 * a stored column (`P4-AL-06`: no stored authoritative derived truth). P4-S3
 * creates no accounting object at all, so nothing here posts.
 */

/** The relation that holds one cashier's till session. */
export const POS_TILL_SESSIONS = 'pos_till_sessions';

/** The relation that holds the server-side basket of one till session. */
export const POS_CART_LINES = 'pos_cart_lines';

/**
 * Every POS relation this slice introduces. The guard discovers the real set
 * from the migration tree by the `pos_` prefix rule `P4-AL-86` fixed and
 * requires the two to agree, so a third `pos_` relation cannot arrive
 * unnoticed by this contract.
 */
export const POS_RELATIONS: readonly string[] = Object.freeze([POS_TILL_SESSIONS, POS_CART_LINES]);

/**
 * The columns of `pos_till_sessions` this module's statements name, and the
 * columns the guard requires `0079` to declare.
 *
 * `owner` is the `OD-P4-09` column. It is named `opened_by_user_id` rather
 * than `actor_user_id` on purpose: `actor_user_id` is the vocabulary of a
 * PER-EVENT actor, which is the refused OPTION B, and `opened_by` says what
 * the ruling says — the user who opened the session owns it for its whole
 * life. It also matches the accepted `paid_by` / `registered_by` shape the
 * estate already uses for "the person of record on this document", which
 * `TL-P4-S1-C11` confirms is a FACT of the document and not a derivation.
 */
export const TILL_SESSION_COLUMNS = Object.freeze({
  tenant: 'tenant_id',
  business: 'business_id',
  id: 'id',
  branch: 'branch_id',
  /** L1/L2: the one authenticated user the session belongs to. NOT NULL, immutable. */
  owner: 'opened_by_user_id',
  status: 'status',
  openedAt: 'opened_at',
  closedAt: 'closed_at',
  /** Integer minor units (no Float/Double money anywhere). */
  openingFloatMinor: 'opening_float_minor',
  /** Integer minor units; NULL until the till is closed and counted. */
  closingCountMinor: 'closing_count_minor',
  /** The P4-AL-30 replay proof: the digest of the command that opened this id. */
  intentDigest: 'open_intent_sha256',
} as const);

/** The two states a till session has. A closed session is never reopened; a shift change opens a new one. */
export const TILL_SESSION_STATES = Object.freeze({ open: 'open', closed: 'closed' } as const);

export type TillSessionState = (typeof TILL_SESSION_STATES)[keyof typeof TILL_SESSION_STATES];

/**
 * The columns of `pos_cart_lines` the actor-binding law reads.
 *
 * `session` is the only identity a cart line carries about WHO is selling,
 * which is L3: the line's actor is the session's owner, derivable and never
 * stored a second time.
 */
export const CART_LINE_COLUMNS = Object.freeze({
  tenant: 'tenant_id',
  business: 'business_id',
  id: 'id',
  session: 'till_session_id',
} as const);

/**
 * The column-name vocabulary that would express the REFUSED `OD-P4-09`
 * OPTION B — a per-row actor on a POS relation other than the session itself.
 *
 * It is a pattern and not a list of three names, because the defect is the
 * CONCEPT and a guard that named `actor_user_id` alone would pass on
 * `sold_by_user_id`. `opened_by_user_id` on the session relation is the one
 * accepted carrier and the guard exempts exactly that pair, by relation and
 * column together, rather than by column name — a relation-blind exemption
 * would let a cart line carry an `opened_by_user_id` of its own and call it
 * compliant.
 */
export const PER_ROW_ACTOR_VOCABULARY = /(^|_)(actor|cashier|sold_by|served_by|operator|user)(_|$)/;

/**
 * The stable code the database rule of L2 raises when a writer tries to
 * re-own a session, and the code the actor-binding rule raises when a
 * different authenticated user writes into someone else's till.
 *
 * Both are registered in the canonical selling registry
 * (`apps/api/src/modules/selling/selling-errors.ts`), which is what gives
 * each one its HTTP status and makes a trigger-raised refusal render through
 * `GlobalExceptionFilter`'s one selling mapping with no edit to the filter.
 * The guard requires every `pos.*` code the Phase 4 DDL raises to be in that
 * registry, so a migration cannot introduce an unrendered refusal.
 */
export const POS_DATABASE_REFUSALS: readonly string[] = Object.freeze(['pos.session_not_owned', 'pos.session_owner_immutable']);
