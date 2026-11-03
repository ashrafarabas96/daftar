/**
 * THE SCHEMA CONTRACT OF THE POS TILL SESSION (P4-S3; lock `P4-AL-40`,
 * `P4-AL-86`; `OD-P4-09` OPTION A — **one session, one authenticated user**).
 *
 * ## What this file is, now that `0079` exists
 *
 * It was first written BEFORE the migration, as a set of requirements on it.
 * It is now the opposite direction: **the migration is the truth, and this
 * file is its TypeScript mirror.** Where the two disagreed, every name here
 * changed and nothing in `0079` did — `opened_by`, the warehouse, the terminal
 * code, the currency and the two counted cash figures all arrived that way.
 *
 * It still earns its place rather than being a copy, for two reasons:
 *
 *   - every statement the till-session service issues is built from these
 *     identifiers, so reconciling a name with the migration is ONE edit in
 *     ONE file rather than a search through SQL strings;
 *   - `scripts/guards/pos-session-law.ts` reads this contract and requires the
 *     migration tree to satisfy it, so a later migration that renames a
 *     column out from under the service is a NAMED finding rather than a
 *     run-time syntax error. The checking half is the guard, not this file; a
 *     declared contract nothing checks would be a promise, and a promise is
 *     not a protection.
 *
 * ## The laws the contract encodes, and WHERE each one actually lives
 *
 * The thing worth being precise about is the mechanism, because this file's
 * first version guessed it and guessed wrong. `OD-P4-09` is not enforced by a
 * trigger that reads the actor GUC. It is enforced by **referential
 * integrity**, which is stronger:
 *
 * **L1 — the session has ONE owning authenticated user, `NOT NULL`.** A
 * nullable owner is a shared till with the owner omitted, which is the refused
 * OPTION B spelled as an absence.
 *
 * **L2 — the owner is IMMUTABLE.** `pos_till_session_guard()` refuses an
 * `UPDATE` that changes `opened_by` with its own named code, and
 * `pos_cart_lines_session_actor_fk` is `ON UPDATE RESTRICT`, so while a basket
 * exists the session's user cannot be swapped out from under it either.
 *
 * **L3 — a basket line CANNOT belong to another user.**
 * `pos_cart_lines (business_id, till_session_id, added_by)` references
 * `pos_till_sessions (business_id, id, opened_by)`. A line added by any user
 * but the session's own has no parent row to point at. No wrapper performs
 * this check, which is the point: `daftar_inventory_internal` — the trusted
 * generic principal every till command runs as — cannot write the row either,
 * and neither can anything reaching `Database.withTransaction`.
 *
 * **L4 — the till is bound to a branch and to a warehouse** (`P4-AL-40`), both
 * `NOT NULL` with composite edges. `0079` §9.1 records that its own policies
 * cannot reach `member_branch_scopes`, so the branch-scope half is enforced at
 * the MINTING side (`OPERATION_AUTHORITY`'s `scope: 'warehouses'` row for each
 * till command) and the database verifies the signed result of that decision.
 *
 * ## Why the trusted generic primitive still has to be named here
 *
 * `Database.withTransaction` / `Database.scoped` open one transaction on the
 * `daftar_app` pool and run whatever SQL a caller hands them. That is how
 * every read in the estate works and nothing about it is wrong — but it means
 * a rule expressed as an `if` in one service is not inherited by the next
 * writer in the process. `daftar_app` holds `SELECT` only on both POS
 * relations, so the primitive cannot write a till at all; and the one
 * principal that can, `daftar_inventory_internal`, is bound by L2 and L3
 * because those are constraints and not code.
 *
 * ## What this contract deliberately does NOT contain
 *
 * No expected-cash figure, no variance, no over/short, no drawer balance and
 * no cash total. Every one is a FUNCTION of the two counted figures and the
 * shift's cash payments, and a stored copy could disagree with the function
 * (`P4-AL-06`). P4-S3 creates no accounting object at all: counting the drawer
 * is not posting it.
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
 * The columns of `pos_till_sessions`.
 *
 * ## It is `opened_by`, not `opened_by_user_id`
 *
 * This contract first declared `opened_by_user_id`, which appears ZERO times
 * in `0079`. The coordinator ruled the migration's name authoritative, and the
 * ruling is right on the merits as well as by precedence: `opened_by` is woven
 * through `pos_till_sessions_actor_uq`, `pos_cart_lines_session_actor_fk`,
 * `pos_till_session_guard()` and six end-state assertions, so renaming it to
 * suit the TypeScript would ripple through six constraints and change nothing
 * about behaviour.
 *
 * It is still not `actor_user_id`, and that distinction survives the rename:
 * `actor_*` is the vocabulary of a PER-EVENT actor, which is the refused
 * `OD-P4-09` OPTION B. `opened_by` says what the ruling says — the user who
 * opened the session owns it for its whole life — and matches the accepted
 * `paid_by` / `registered_by` shape the estate already uses for the person of
 * record on a document (`TL-P4-S1-C11`: a fact of the document, never a
 * derivation).
 */
export const TILL_SESSION_COLUMNS = Object.freeze({
  tenant: 'tenant_id',
  business: 'business_id',
  id: 'id',
  branch: 'branch_id',
  /**
   * The warehouse the till sells out of, `NOT NULL` with a composite
   * `(business_id, warehouse_id)` edge. Every later read derives the warehouse
   * from the SESSION rather than taking it from the client, and the minting
   * side has exactly one warehouse to branch-scope check.
   */
  warehouse: 'warehouse_id',
  /** The physical till, held to the `invpl/1` `code` grammar by its own named CHECK so the argument is signable. */
  terminalCode: 'terminal_code',
  /** The denomination of every minor-unit figure beneath the session; a cart line carries none of its own. */
  currency: 'currency_code',
  /** L1 / L2: the one authenticated user the session belongs to. `NOT NULL`, immutable. */
  owner: 'opened_by',
  status: 'status',
  openedAt: 'opened_at',
  closedAt: 'closed_at',
  /**
   * The two COUNTED CASH figures, integer minor units of `currency_code`.
   *
   * The coordinator ruled them in, and the line they sit on is counted versus
   * derived: a human holding the notes is the only source of either, so
   * neither is a second writer of a truth something else owns — the same
   * species of fact as a counted stocktake quantity or an opening. What WOULD
   * be derived is absent from the relation and from this list: see the class
   * comment.
   */
  openingFloatMinor: 'opening_float_minor',
  /** NULL until the till is closed and counted; tied to the closed status by `pos_till_sessions_state_ck`. */
  closingCountMinor: 'closing_count_minor',
  /**
   * The `P4-AL-30` replay proofs — one per command, and NOT a digest this
   * process computes.
   *
   * Each is the `invctl/1` assertion's OWN payload digest, which the routine
   * takes from the token it has just verified. The replay key is therefore a
   * SIGNED value: a replay is answered only to a caller who presented an
   * assertion over the identical payload, and this service has no way to write
   * a digest of its own choosing into either column. The first version of this
   * contract computed its own `openIntentDigest`, which would have agreed with
   * the stored value never.
   */
  intentDigest: 'open_intent_sha256',
  closeIntentDigest: 'close_intent_sha256',
  businessTransactionId: 'business_transaction_id',
} as const);

/** The two states a till session has. A closed session is never reopened; a shift change opens a new one. */
export const TILL_SESSION_STATES = Object.freeze({ open: 'open', closed: 'closed' } as const);

export type TillSessionState = (typeof TILL_SESSION_STATES)[keyof typeof TILL_SESSION_STATES];

/**
 * The columns of `pos_cart_lines` the actor law reads. The cart's own columns
 * — the ordinal, the quantity, the discount request, the tombstone — belong to
 * the cart owner; what is here is the identity the `OD-P4-09` edge is built
 * from.
 */
export const CART_LINE_COLUMNS = Object.freeze({
  tenant: 'tenant_id',
  business: 'business_id',
  id: 'id',
  session: 'till_session_id',
  /** The per-row actor the composite edge forbids from disagreeing with the session's owner. */
  addedBy: 'added_by',
} as const);

/**
 * The column-name vocabulary that would express the REFUSED `OD-P4-09`
 * OPTION B — a per-row actor on a POS relation that nothing forbids from
 * disagreeing with the session's owner.
 *
 * ## The word this pattern missed, and why that is the lesson
 *
 * It was `/(^|_)(actor|cashier|sold_by|served_by|operator|user)(_|$)/`, and
 * `0079` ships `pos_cart_lines.added_by`, which it does not match. The law's
 * own comment said the defect is the CONCEPT, and that a guard naming
 * `actor_user_id` alone would pass on `sold_by_user_id` — and then the real
 * column walked straight through the pattern written to say so. A curated word
 * list is a list however it is phrased, so the pattern now reaches the
 * `<something>_by` SHAPE generally (`added_by`, `opened_by`, `closed_by`,
 * `rung_by`, `voided_by`) instead of three hand-picked verbs.
 */
export const PER_ROW_ACTOR_VOCABULARY = /(^|_)(actor|cashier|operator|user)(_|$)|(^|_)[a-z]+_by($|_)/;

/**
 * One exempt (relation, column) pair, and the facts its exemption is
 * conditional on.
 *
 * `null` means the fact does not apply to this pair, never that it is waived.
 */
export interface ActorColumnExemption {
  readonly relation: string;
  readonly column: string;
  /** The composite edge that forbids the copy from disagreeing: child columns in order → parent relation and its columns in order. */
  readonly edge: {
    readonly childColumns: readonly string[];
    readonly parentRelation: string;
    readonly parentColumns: readonly string[];
  } | null;
  /** The candidate key the edge points at. Without it the edge is not expressible at all. */
  readonly uniqueTarget: readonly string[] | null;
  /** True when the column must NOT appear in this relation's `UPDATE` column grant. */
  readonly excludedFromUpdateGrant: boolean;
}

/**
 * THE EXEMPT PAIRS.
 *
 * An exemption by COLUMN NAME would be worthless: another relation could carry
 * an `added_by` of its own and call itself compliant. So each exemption is the
 * PAIR — and the cart's is further conditional on the three facts the
 * coordinator ratified it on, each of which the law checks. If any one stops
 * being true the exemption goes red, because that is exactly the moment the
 * column really becomes the refused OPTION B:
 *
 *   1. **the composite edge.** `pos_cart_lines_session_actor_fk` binds
 *      `(business_id, till_session_id, added_by)` to
 *      `pos_till_sessions (business_id, id, opened_by)`, both lists in order.
 *      A line added by any user but the session's own then has NO PARENT ROW
 *      to point at, so the refusal is the referential integrity of the
 *      database rather than a check inside a wrapper — and
 *      `daftar_inventory_internal`, the trusted principal every till command
 *      runs as, cannot write the row either;
 *   2. **the unique target.** `pos_till_sessions_actor_uq UNIQUE (business_id,
 *      id, opened_by)` is what the edge references. Drop the candidate key and
 *      the edge is not expressible, and the whole argument collapses with it;
 *   3. **the grant.** `added_by` is absent from the cart's `UPDATE` column
 *      grant, so the copy cannot be revised away from its parent after the
 *      insert.
 *
 * Together those make it a per-row copy a composite key forbids from
 * disagreeing, which is STRONGER than this contract's first position
 * ("derivable, never stored") — because that one rested on application code
 * remembering to derive it.
 */
export const ACTOR_COLUMN_EXEMPTIONS: readonly ActorColumnExemption[] = Object.freeze([
  // The session's own owner. It IS the single source, so there is no parent
  // edge to keep it honest and none is required; its immutability is
  // `pos_till_session_guard()`'s, which the law checks on its own.
  Object.freeze({
    relation: POS_TILL_SESSIONS,
    column: 'opened_by',
    edge: null,
    uniqueTarget: null,
    excludedFromUpdateGrant: true,
  }),
  // The cart line's copy, exempt on the three ratified facts and nothing else.
  Object.freeze({
    relation: POS_CART_LINES,
    column: 'added_by',
    edge: Object.freeze({
      childColumns: Object.freeze(['business_id', 'till_session_id', 'added_by']),
      parentRelation: POS_TILL_SESSIONS,
      parentColumns: Object.freeze(['business_id', 'id', 'opened_by']),
    }),
    uniqueTarget: Object.freeze(['business_id', 'id', 'opened_by']),
    excludedFromUpdateGrant: true,
  }),
]);

/**
 * Every refusal a REACHABLE `0079` routine raises — the twelve a request can
 * actually meet, in the vocabulary the migration now speaks.
 *
 * ## This list is a convenience, and the guard is the check
 *
 * Nothing is enforced from here, deliberately. `POS-LAW-6` in
 * `scripts/guards/pos-session-law.ts` DERIVES the reachable set from the
 * migration text — a code raised inside a routine some role holds
 * `GRANT EXECUTE` on, or that a `CREATE TRIGGER` fires — and requires the
 * canonical selling registry to classify each one. A hard-coded list checked
 * against itself would prove nothing; this one exists so a reader can see the
 * surface without running the guard, and it goes stale loudly rather than
 * silently because the guard reads the SQL and not this array.
 *
 * ## Why the names moved, twice
 *
 * The first version of this file INVENTED `pos.session_not_owned` and
 * `pos.session_owner_immutable`, and `0079` raised neither — it spoke an
 * entirely separate `pos.till_session_*` vocabulary, so every refusal it could
 * raise rendered as an anonymous `P0001`. The coordinator ruled the REGISTRY's
 * spelling authoritative, because the registry is what the error filter maps,
 * what `DATABASE_CODE_RE` recognizes and what the locale catalogues key off;
 * the migration then renamed six RAISE strings to these. So the names here are
 * read from the routine bodies and are also the registry's — the two agree now
 * by a ruling, not by coincidence.
 *
 * ## What is NOT here, and must never be
 *
 * `pos.authority_leak`, `pos.derived_truth_stored` and
 * `pos.migration_end_state_invalid`. Each is raised only in a `DO` block, so
 * it fires while the migration applies and no request can reach it.
 * Registering one would demand merchant text for a build-time assertion, and
 * whoever supplied that text would put an end-state sentence on a cashier's
 * screen. `POS-LAW-6b` goes red if one is ever registered, and `POS-LAW-6a`
 * starts demanding it the moment it moves into a reachable routine.
 */
export const POS_DATABASE_REFUSALS: readonly string[] = Object.freeze([
  'pos.cart_line_conflict',
  'pos.cart_line_immutable',
  'pos.cart_line_removed',
  'pos.session_already_open',
  'pos.session_idempotency_conflict',
  'pos.session_not_found',
  'pos.session_not_open',
  'pos.session_not_owned',
  'pos.session_owner_immutable',
  'pos.session_state_invalid',
  'pos.terminal_already_open',
  'pos.till_session_immutable',
]);
