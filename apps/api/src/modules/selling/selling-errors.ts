import { AccountingError, parseDatabaseAccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { TransactionSeamError } from '../../infra/database';
import { inventoryRefusal, parseDatabaseInventoryCode } from '../inventory/inventory-errors';

/**
 * The stable refusal vocabulary of the Phase 4 customer and invoice surface
 * (P4-S1), as the merchant API reports it.
 *
 * Classified by an explicit table, never by the shape of a name — the accepted
 * `payment-method-errors.ts:18-34` model. A code that is not in the table is
 * not a selling refusal, and a caller that meets one has met a defect, never a
 * guessed status.
 *
 * Three project laws are visible in the table itself:
 *
 * - **P4-AL-54**: a refusal is a stable machine code plus a localized
 *   merchant-safe message. No message here carries a journal entry id, an
 *   account code, a journal line, a routine name, a GUC, a constraint name, an
 *   amount or the database's text after the colon;
 * - **P4-AL-44 / OD-03**: `sale.tax_policy_absent` is the whole of the tax
 *   vocabulary. There is no rate refusal, no exemption refusal and no
 *   registration refusal, because none of those concepts exists while sales tax
 *   is structurally zero;
 * - **OD-P4-05 OPTION A**: there is no `sale.oversell_*` and no
 *   `sale.stock_override_*`. The no-oversell refusal already exists as
 *   `inventory.insufficient_stock`, raised by the ONE stock writer under the
 *   level row's own `FOR UPDATE` (`0060:383`), and P4-S2 forwards it through
 *   `purchasingInventoryRefusal`'s sibling rather than inventing a second code
 *   for the same fact. A non-stock-tracked product never decrements a level
 *   and is simply sellable, which is the `(c)` clarification the ruling
 *   records — not an option and not a refusal;
 * - **OD-P4-02 / OD-P4-03**: there is no `customer.credit_limit_exceeded` and
 *   no `invoice.price_override_refused`, because neither a limit nor an
 *   override is representable. A refusal for a thing that cannot be asked for
 *   is a hint that it could be.
 *
 * Every code below needs `error.<code>` in `apps/web/src/messages/{ar,en,tr}.json`
 * before a merchant screen renders it; those catalogues are owned by the
 * localization owner of this slice, and `npm run check:localization` is what
 * proves all three exist.
 */
const SELLING_STATUS = {
  // ── Customers ───────────────────────────────────────────────────────────
  'customer.not_found': 404,
  'customer.idempotency_conflict': 409,
  'customer.revision_changed': 409,
  'customer.state_invalid': 409,
  /** A trigger refusal: no route deletes a customer (the `supplier.not_deletable` precedent). */
  'customer.not_deletable': 409,
  'customer.name_invalid': 400,
  'customer.phone_invalid': 400,
  'customer.email_invalid': 400,
  'customer.notes_invalid': 400,
  'customer.contacts_too_many': 400,
  'customer.contact_id_invalid': 400,
  'customer.contact_id_duplicate': 400,
  'customer.contact_name_invalid': 400,
  'customer.contact_phone_invalid': 400,
  'customer.contact_email_invalid': 400,
  'customer.contact_notes_invalid': 400,
  'customer.contact_reachability_missing': 400,
  'customer.contact_primary_ambiguous': 400,
  /** An aging or open-invoice read whose supplied as-of date is not a usable horizon. */
  'customer.as_of_invalid': 400,
  'customer.aging_buckets_invalid': 400,
  /** A read that sums across branches, asked by an actor limited to some of them. */
  'customer.business_wide_scope_required': 403,

  // ── Invoices ────────────────────────────────────────────────────────────
  'invoice.not_found': 404,
  /** A guard refusal no route can reach: an invoice is never edited (P4-AL-46). */
  'invoice.immutable': 500,
  /** A direct `UPDATE invoices SET status = …` refused by the transition trigger (P4-AL-24). */
  'invoice.status_not_writable': 409,
  'invoice.state_invalid': 409,
  /**
   * The document series named by a read does not exist for this business.
   *
   * Practically unreachable on the WRITE path since TL-P4-S2-R4: `sale_commit`
   * creates the series row on first use, so no sale is refused for the want of
   * one. The code is KEPT rather than deleted: it is the registered rendering
   * for a read that names a series by hand, and removing a registered code
   * would change an accepted HTTP contract to tidy a comment.
   */
  'invoice.sequence_not_found': 404,
  'invoice.document_kind_unknown': 400,

  // ── The atomic sale commit (P4-S2) ──────────────────────────────────────
  //
  // Every code here is a refusal of a WHOLE sale: P4-AL-16 is one transaction
  // or no sale, so there is no partial outcome for a code to describe. There
  // is deliberately no `sale.partially_committed`, no `sale.stock_pending` and
  // no `sale.posting_deferred`, because a code for a state the law forbids is
  // a hint that the state exists.
  'sale.not_found': 404,
  /** The replay proof disagreed: this sale id already carries a DIFFERENT command (P4-AL-30). */
  'sale.idempotency_conflict': 409,
  'sale.state_invalid': 409,
  /** A trigger refusal no route can reach: a confirmed sale is corrected by a new document (P4-AL-46). */
  'sale.immutable': 500,
  'sale.lines_required': 400,
  'sale.lines_too_many': 400,
  'sale.duplicate_line': 400,
  'sale.quantity_invalid': 400,
  'sale.discount_invalid': 400,
  /** A discount was requested by an actor without `sales.discount`. Refused, never silently zeroed. */
  'sale.discount_not_permitted': 403,
  /** A credit sale asked by an actor without `receivables.view` — the second half of a credit sale (P4-AL-35). */
  'sale.credit_not_permitted': 403,
  'sale.notes_invalid': 400,
  'sale.document_date_in_future': 422,
  'sale.due_date_invalid': 400,
  'sale.customer_not_found': 404,
  'sale.customer_inactive': 409,
  /** A credit sale with no customer: a receivable owed by nobody, refused by the schema, the row CHECK and `invoices_walkin_no_ar`. */
  'sale.credit_requires_customer': 400,
  /** A due date behind a null customer or a cash sale — the `invoices_walkin_terms_ck` mirror (`0075:316`). */
  'sale.walkin_terms_forbidden': 400,
  'sale.warehouse_not_found': 404,
  'sale.product_not_found': 404,
  'sale.product_not_priced': 422,
  /** The whole sale was discounted to nothing: an invoice total of zero is not representable (`0075:260`). */
  'sale.total_zero': 422,
  'sale.currency_unknown': 422,
  //
  // There is deliberately NO code for a sale of zero-VALUED stock. Such a
  // sale is legitimate and COMMITS with one entry: `journal_lines_money_cap_ck`
  // (`0042:225`) refuses a zero amount, `0060:388-390` gives the emptying
  // movement exactly `-valuation_base_minor`, and `GL Inventory (1200) =
  // Σ value_delta_base_minor` still holds at 0. It is handled by
  // `postings.cogs === null`, the conditional seam arm and the deferred
  // `sales_cogs_owed` trigger — a legitimate sale that cannot commit is a
  // worse outcome than any refusal code suggests.
  //
  // And there is no code for a sale that moved NO stock at all. Every line
  // produces exactly one movement, so a sale with no movements is a sale with
  // no lines — `sale.lines_required` above — and the accounting module's own
  // `accounting.payload_invalid` ("a sale moves stock: a commit with no
  // movements is not a sale") is a CALLER DEFECT reported as one, never a
  // merchant outcome dressed as a 422.
  'sale.fx_rate_missing': 422,
  /** The catalogue, the customer, the rate or the stock moved under the command's locks. Retryable BY THE CLIENT; there is no server retry. */
  'sale.state_changed': 409,

  // ── The tax boundary (P4-AL-44). The whole of it. ────────────────────────
  'sale.tax_policy_absent': 422,

  // ── The POS till session (P4-S3, `OD-P4-09` OPTION A) ───────────────────
  //
  // `pos.*` is MERCHANT vocabulary, so it belongs in THIS table and not in
  // the internal `selling.*` registry below: every code here is something a
  // cashier can cause and a POS screen must render. The prefix joins
  // `DATABASE_CODE_RE` for the same reason — a `pos.*` refusal raised by a
  // trigger is a merchant outcome with a registered status, exactly as
  // `customer.not_deletable` is. The internal vocabulary is NOT widened into
  // that recognizer (TL-P4-S2-R5): `selling.*` keeps its own recognizer and
  // its own 500 rendering.
  //
  // `OD-P4-09` OPTION A — ONE TILL SESSION = ONE AUTHENTICATED USER — is the
  // reason for the first two codes, and the reason they are two rather than
  // one. They answer different questions and must not be collapsed:
  //
  //   - `pos.session_not_found` is the ISOLATION answer. Another tenant's or
  //     another business's session is INVISIBLE, because the RLS policies
  //     filter it out of the actor's own transaction; the service cannot tell
  //     such a session from one that was never opened, and must not be able
  //     to. A 403 here would confirm the existence of a row in a business the
  //     caller has no membership in, which is the cross-tenant enumeration
  //     `tests/guards/phase4-cross-tenant-enumeration-guard.test.ts` exists
  //     to refuse;
  //   - `pos.session_not_owned` is the OD-P4-09 answer. The session IS
  //     visible — same tenant, same business, a colleague's till — and the
  //     acting user is still refused, because a shift change is a new session
  //     and not a second actor on an existing one. 403, not 409: the command
  //     is well formed and the till's state allows it; what forbids it is WHO
  //     is asking.
  'pos.session_not_found': 404,
  'pos.session_not_owned': 403,
  /** The till is closed. A closed session is never reopened — a shift change opens a new one. */
  'pos.session_not_open': 409,
  /** This user already holds an open till in this business. One user, one open session. */
  'pos.session_already_open': 409,
  /** The replay proof disagreed: this session id already carries a DIFFERENT open command (the P4-AL-30 model). */
  'pos.session_idempotency_conflict': 409,
  /**
   * A trigger refusal NO ROUTE CAN REACH, and the whole point of putting the
   * rule in the schema: a session's owning user is immutable, so
   * `UPDATE pos_till_sessions SET opened_by = …` is refused even when
   * it arrives through the trusted generic primitive
   * (`Database.withTransaction`) rather than through this module. Reaching it
   * means a server-side writer tried to re-own a till, which is a DEFECT in
   * that writer and not a merchant outcome — hence 500 with no details, the
   * `sale.immutable` / `invoice.immutable` precedent.
   */
  'pos.session_owner_immutable': 500,
  'pos.session_state_invalid': 409,
  /** The till names a branch that is not visible to this actor's branch scope (P4-AL-40 — the policy refuses it, not a predicate here). */
  'pos.branch_not_found': 404,
  'pos.opening_float_invalid': 400,
  'pos.closing_count_invalid': 400,
  /** A till does not close over an unfinished basket: the cart is cleared or committed first. */
  'pos.session_cart_not_empty': 409,

  // ── P4-S3, the five `0079` refusals with no twin above ──────────────────
  //
  // `0079` RAISEs fifteen `pos.*` codes. Nine of them are the vocabulary
  // above (six after the migration owner's rename to these spellings, three
  // already matching); three are migration-time end-state assertions that no
  // request can reach and that must NEVER be registered — see
  // `scripts/guards/pos-session-law.ts` POS-LAW-6b, which refuses their
  // presence here structurally rather than by name; and these five are
  // genuinely new.
  //
  // Each status is read from WHAT THE REFUSAL IS, and the two 500s are a
  // DEPARTURE from the coordinator's own reading, recorded here with the
  // argument because a silent deviation would be worse than a wrong status.
  //
  /**
   * One physical till already holds an open session
   * (`pos_till_sessions_one_open_per_terminal_uq`). Reachable by a cashier
   * choosing a drawer a colleague is already on: the command is well formed
   * and the till's state forbids it, which is what 409 says — the same
   * reading as `pos.session_already_open` beside it.
   */
  'pos.terminal_already_open': 409,
  /**
   * A cart line id already names a different line, or the ordinal is taken by
   * a live line. A conflict over truth that already exists, not a malformed
   * request: `sale.idempotency_conflict`'s reading.
   */
  'pos.cart_line_conflict': 409,
  /**
   * A tombstoned cart line is final; the till adds a NEW line at that
   * ordinal. Reachable from `pos_cart_set_line`, so it is a merchant outcome
   * about state — 409.
   */
  'pos.cart_line_removed': 409,
  /**
   * **500, NOT a 4xx, and this is the departure.** The coordinator read
   * `pos.till_session_immutable` as "a client trying to change an opening
   * fact of a session that is final". No client can: it is raised ONLY by
   * `pos_till_session_guard()`, a row trigger, on a DELETE or on an UPDATE
   * that changes an identity or opening column — and no route can issue
   * either. `daftar_app` holds `SELECT` and nothing else on
   * `pos_till_sessions` (`0079:605`); the only principal with DML is
   * `daftar_inventory_internal`, whose UPDATE grant covers `status`,
   * `closed_at`, `close_intent_sha256`, `closing_count_minor` and
   * `business_transaction_id` (`0079:607`) — not one of the columns this arm
   * guards; and `pos_till_session_close` issues that UPDATE only on an `open`
   * session, so even the "a closed session is final" arm is unreachable
   * through it.
   *
   * So reaching this code means a SERVER-SIDE writer attempted what the
   * schema forbids, which is a defect in that writer. The registered
   * precedents are `sale.immutable` and `invoice.immutable`, both 500 for
   * exactly this shape — "a guard refusal no route can reach" — and a 409
   * here would tell a cashier their shift is in a state they can fix.
   *
   * If a later slice grants a runtime principal DML on `pos_till_sessions`,
   * this becomes reachable and the status is a one-line change. POS-LAW-6a
   * will not catch that, because the code is registered either way; it is
   * recorded here so the next reader knows what the 500 is resting on.
   */
  'pos.till_session_immutable': 500,
  /**
   * **500, for the same reason and with the same evidence.** Raised only by
   * `pos_cart_line_guard()` on a DELETE, or on an UPDATE that changes a cart
   * line's identity, product, actor or instant. `daftar_app` holds `SELECT`
   * only; `daftar_inventory_internal`'s cart UPDATE grant is `quantity`,
   * `removed_at` and `requested_discount_minor` (`0079:608`) — none of the
   * columns this arm guards — and nothing deletes a cart line at all,
   * because the removal is a tombstone. A route cannot reach it; a writer
   * that does is broken.
   *
   * Note what this is NOT: `pos.cart_line_removed` above is the REACHABLE
   * sibling, and it is 409. The two are deliberately different codes with
   * different statuses, because "you tapped a line you already voided" and "a
   * server statement tried to rewrite a basket's history" are not the same
   * event.
   */
  'pos.cart_line_immutable': 500,

  // ── The POS READS (P4-S3): the till's own scope refusal ─────────────────
  //
  // ONE code, not the two this block first carried. The POS type-ahead no
  // longer lets the client name a warehouse — it names its SESSION and the
  // server derives the warehouse (RULING 2) — which changed what is reachable:
  //
  //   - `pos.warehouse_out_of_scope` (403) SURVIVES, and it is not a leftover.
  //     A session's `warehouse_id` is frozen for the session's whole life by
  //     `pos_till_session_guard()`, while the member's branch assignments are
  //     editable at any moment. Reassign an assigned-scope cashier away from
  //     the branch, or merely DEACTIVATE that branch, and they own an open
  //     session whose warehouse they no longer reach. This is the only check
  //     standing between a stale till and a standing read on a branch the
  //     member was deliberately moved off, so it is a security refusal and not
  //     a validation nicety. It is the P3-S7
  //     `inventory.warehouse_out_of_scope` rule in POS vocabulary, and it is
  //     REFUSED rather than answered with an empty page: a type-ahead that
  //     returned no rows would read as "the shop is empty", and a cashier
  //     acting on it refuses a sale of stock that is on the shelf.
  //
  //   - `pos.warehouse_not_found` (404) is DELETED, because Ruling 2 made it
  //     unreachable. `pos_till_sessions.warehouse_id` is `NOT NULL` and
  //     carries a composite foreign key into `warehouses (business_id, id)`,
  //     so a derived warehouse always exists and always belongs to this same
  //     business; the database will not store a session that says otherwise.
  //     A code nothing can raise is worse than no code: it implies a case the
  //     system cannot reach and invites a handler for it.
  //
  // The session's own four refusals are NOT duplicated here. They are already
  // in this table from the till-session lifecycle, and the read raises those
  // same ones rather than minting read-flavoured twins.
  'pos.warehouse_out_of_scope': 403,
} as const satisfies Readonly<Record<`${'customer' | 'invoice' | 'pos' | 'sale'}.${string}`, 400 | 403 | 404 | 409 | 422 | 500>>;

/** A classified selling refusal code. */
export type SellingCode = keyof typeof SELLING_STATUS;

/** True iff `code` is a classified selling code. */
export function isSellingCode(code: string): code is SellingCode {
  return Object.hasOwn(SELLING_STATUS, code);
}

/**
 * Every classified selling code, in table order — the list a localization test
 * enumerates so that a code added here without its three catalogue entries
 * fails rather than ships.
 */
export const SELLING_CODES: readonly SellingCode[] = Object.keys(SELLING_STATUS).filter(isSellingCode);

/**
 * The PUBLIC merchant prefixes, and only those. `pos` joined the set with
 * P4-S3's till session; `selling` deliberately did NOT, and never may:
 * widening this recognizer to carry the internal invariant vocabulary is
 * exactly how `selling.sale_cogs_owed` came to be rendered as a 403
 * authorization denial (TL-P4-S2-R5). The internal half has its own
 * recognizer, `INTERNAL_DATABASE_CODE_RE`, and its own 500 rendering.
 */
const DATABASE_CODE_RE = /^((?:customer|invoice|pos|sale)\.[a-z_]+)\b/;

/**
 * ── THE INTERNAL PHASE 4 INVARIANTS (`selling.*`) ─────────────────────────
 *
 * `SELLING_STATUS` above is the MERCHANT vocabulary: `customer.*`,
 * `invoice.*`, `sale.*`. The `selling.*` prefix is a different thing
 * altogether and is deliberately not in that table. It is the prefix `0075` /
 * `0077` / `0078` raise their OWN structural laws under — the ones that say
 * the slice's shape is intact — and a merchant has no vocabulary for "a
 * committed sale owes a COGS entry".
 *
 * An internal invariant failure is NOT an authorization denial (TL-P4-S2-R5).
 * Rendering `selling.sale_cogs_owed` as `403 FORBIDDEN / Access denied` told
 * sixteen suites the sale was refused while the log said the invariant had
 * broken, which is the single most expensive kind of wrong answer: it reads
 * as a merchant outcome, so nobody looks at the server. A violated invariant
 * is a DEFECT, and 500 is the only status that says so.
 *
 * The registry is EXPLICIT and closed, never a `selling.*` wildcard. Two
 * thirds of the `selling.*` strings in the tree are migration-time END-STATE
 * assertions inside `DO` blocks: they fire while the migration runs, in a
 * transaction no request is attached to, and a wildcard would be a standing
 * claim that they could reach a response. A code enters this set only when a
 * FUNCTION BODY raises it — a routine the commit calls, or a trigger that
 * fires on a request's own transaction.
 *
 * Reachability was read from the raises themselves, not from the names:
 *
 * INCLUDED — raised from a function body, so a request can reach it:
 *
 *   - `selling.sale_cogs_owed` — `sales_cogs_owed()` (`0077:1537`), a
 *     DEFERRED constraint trigger on `sales`. It fires at COMMIT of the
 *     sale's own transaction, which is exactly the request's. The headline
 *     case of the ruling;
 *   - `selling.walkin_receivable_forbidden` — `sales_walkin_no_ar()`
 *     (`0077:1606`), the other deferred constraint trigger, fired at the same
 *     COMMIT;
 *   - `selling.source_document_immutable` — `sale_header_guard()`
 *     (`0077:667`), a row trigger on every `sales` INSERT / UPDATE / DELETE.
 *     No runtime principal holds DML on `sales` (P4-AL-38), so only the
 *     commit routine's own statements can trip it, and a routine that trips
 *     it is a defect in the routine;
 *   - `selling.sequence_format_invalid` — `sale_document_number()`
 *     (`0078:291`), called by `sale_commit` at `0078:868` to render the
 *     invoice number. No route writes `invoice_sequences.number_format`, so a
 *     format the renderer refuses is server-side state, never a payload;
 *   - `selling.payload_invalid` — the same renderer's argument guard
 *     (`0078:298`). Its "payload" is the ROUTINE's argument list, not the
 *     merchant's body: reaching it means `sale_commit` passed a null format,
 *     a null period or an ordinal below one.
 *
 * EXCLUDED — raised only from migration `DO` blocks, so no request can reach
 * one and an entry here would be a claim nobody can falsify:
 *
 *   - `selling.migration_end_state_invalid` (94 raises) — every one is a
 *     precondition or end-state proof: `0075:151-174` and `0075:880-1071`,
 *     `0077:139-188`, `0078:127-171` and `0078:1043-1277`. All of them sit
 *     outside every `CREATE FUNCTION` in their file;
 *   - `selling.authority_leak` (15 raises) — the ACL and grant proofs
 *     (`0075:181`, `0075:943-1062`, `0077:204`, `0077:1783-2154`). A grant
 *     is wrong at migration time or not at all;
 *   - `selling.derived_truth_stored` (`0075:895`, `0077:1766`) — the
 *     P4-AL-06 column-vocabulary proof, read from `pg_attribute` in an
 *     end-state block. A stored derived column is a schema fact;
 *   - `selling.cross_business_binding_expressible` (`0075:968`) — the
 *     end-state proof that every Phase 4 foreign key carries `business_id`
 *     on both sides and is validated. Also a schema fact.
 *
 * If a later slice raises one of the excluded codes from a routine, it joins
 * this set in the same commit. That is the edit the explicitness exists to
 * force.
 */
const INTERNAL_DATABASE_CODE_RE = /^(selling\.[a-z_]+)\b/;

const SELLING_INTERNAL_INVARIANTS: ReadonlySet<string> = new Set([
  'selling.sale_cogs_owed',
  'selling.walkin_receivable_forbidden',
  'selling.source_document_immutable',
  'selling.sequence_format_invalid',
  'selling.payload_invalid',
]);

/** The internal invariant codes, in registry order — the list a contract test enumerates. */
export const SELLING_INTERNAL_INVARIANT_CODES: readonly string[] = [...SELLING_INTERNAL_INVARIANTS];

/**
 * A RECOGNIZED internal `selling.*` invariant code — never a prefix test. A
 * `selling.*` string this registry does not hold is not treated as an
 * invariant at all: it keeps the unaudited historical `P0001` rendering,
 * because inventing a contract for a raise nobody has located is the mistake
 * this module is fixing.
 */
export function isSellingInternalInvariant(code: string): boolean {
  return SELLING_INTERNAL_INVARIANTS.has(code);
}

/**
 * The `selling.*` code a database refusal carries, or null.
 *
 * Its own recognizer, because `DATABASE_CODE_RE` matches the merchant
 * prefixes alone and widening it would pull the internal vocabulary into
 * `rethrowSellingRefusal`'s merchant path — which is where a 403 for a broken
 * invariant came from. The code is all that is taken: the routine's text
 * after the colon names the assertion, and an assertion body is written for
 * an engineer reading a log.
 */
export function parseDatabaseSellingInternalCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return INTERNAL_DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * The selling code a database refusal carries, or null. Only the code is taken:
 * the routine's message after the colon is never forwarded, because it is
 * written for an engineer reading a log and not for a merchant reading a screen.
 */
export function parseDatabaseSellingCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (message === null) return null;
  return DATABASE_CODE_RE.exec(message)?.[1] ?? null;
}

/**
 * A classified selling code → its HTTP contract; the code travels in
 * `details.sellingCode`, and the generic sentence is a safe fallback the client
 * replaces with the localized message for that code. A 500-class code is a
 * defect reported with its typed code, never rendered as a business outcome.
 */
export function sellingRefusal(code: SellingCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  const details = { ...extra, sellingCode: code };
  const status = SELLING_STATUS[code];
  switch (status) {
    case 404:
      return new AppError('NOT_FOUND', 'Resource not found', 404, details);
    case 403:
      return new AppError('FORBIDDEN', 'This operation is not permitted', 403, details);
    case 409:
      return new AppError('CONFLICT', 'The current state does not allow this change', 409, details);
    case 422:
      return new AppError('VALIDATION_FAILED', 'The command cannot be processed', 422, details);
    case 400:
      return new AppError('VALIDATION_FAILED', 'Validation failed', 400, details);
    case 500:
      return new AppError('INTERNAL_ERROR', 'Internal error', 500, details);
  }
}

/** The `customer.*` code for one statement problem — the domain vocabulary mapped onto the API's. */
export function customerStatementRefusal(problem: string): AppError {
  const code = `customer.${problem}`;
  return sellingRefusal(isSellingCode(code) ? code : 'customer.name_invalid');
}

/**
 * An `inventory.*` code met on the sale commit path → its HTTP contract,
 * through `inventoryRefusal`, the accepted P3-S3 mapping. The sale path meets
 * them because the stock identity resolution and the ONE stock writer are the
 * inventory module's, and a code keeps ONE HTTP contract wherever it is
 * raised: `inventory.insufficient_stock` is a 409 on a sale exactly as it is
 * on a transfer.
 *
 * **This is the whole of the no-oversell vocabulary** (OD-P4-05, ruled NO
 * OVERSELL). `inventory_apply_stock_movements` already raises
 * `inventory.insufficient_stock` for any outbound movement larger than the
 * level's `on_hand`, under that level row's own `FOR UPDATE` (`0060:383`),
 * which is also the last-item race mechanism. The sale invents no second code
 * for the same fact, adds no business flag and does not weaken the writer.
 */
export function sellingInventoryRefusal(code: string, extra: Readonly<Record<string, unknown>> = {}): AppError {
  return inventoryRefusal(code, extra);
}

/** A refusal of `@daftar/inventory` (the sale payload builder, the quantity precision check) as its API error. */
export function sellingPackageRefusal(error: InventoryError): AppError {
  if (isSellingCode(error.code)) return sellingRefusal(error.code, error.details ?? {});
  return inventoryRefusal(error.code, error.details ?? {});
}

/**
 * The catch of the atomic sale commit. Every refusal leaves with its stable
 * code and nothing is swallowed:
 *
 * - a package refusal (`InventoryError` from `saleCommitPayload` or the
 *   quantity precision check) → its `sale.*` code when the selling table
 *   classifies it, its inventory code otherwise;
 * - an `AccountingError`, an `AppError` or a `TransactionSeamError` → unchanged;
 * - a `sale.*` / `customer.*` / `invoice.*` database refusal → its selling code;
 * - an `inventory.*` database refusal (the stock writer's, raised inside the
 *   routine) → its inventory code;
 * - an `accounting.*` refusal raised at COMMIT, after the posting port
 *   returned — the deferred completeness triggers and the deferred binding FKs
 *   that ARE P4-AL-16's all-or-nothing mechanism → the same `AccountingError`
 *   the port would have raised. There is no second mapping;
 * - anything else — an infrastructure failure, a seam defect — is re-thrown
 *   untouched, because a failure answered as a business refusal is a sale the
 *   merchant thinks did not happen.
 */
export function rethrowSellingRefusal(error: unknown): never {
  if (error instanceof InventoryError) throw sellingPackageRefusal(error);
  if (error instanceof AccountingError || error instanceof AppError || error instanceof TransactionSeamError) throw error;
  const sellingCode = parseDatabaseSellingCode(error);
  if (sellingCode !== null && isSellingCode(sellingCode)) throw sellingRefusal(sellingCode);
  const inventoryCode = parseDatabaseInventoryCode(error);
  if (inventoryCode !== null) throw inventoryRefusal(inventoryCode);
  const accountingCode = error instanceof Error ? parseDatabaseAccountingError(error.message) : null;
  if (accountingCode !== null) throw new AccountingError(accountingCode, 'the posting was refused by the accounting authority');
  throw error;
}
