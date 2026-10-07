/**
 * Phase 4 returns domain — credit notes, refunds and the structural half of
 * `TL-P4-S5-R1` (P4-S5, maturity level A).
 *
 * What this file is, and deliberately is not:
 *
 * - it is the refund's SOURCE ALGEBRA, the closed
 *   refusal vocabulary, the operation-code and source-type spellings, the lock
 *   order and the idempotency intent shape. Every export is a pure function of
 *   its arguments, reads no clock and touches no database;
 * - it computes **no carrying base, no realized FX and no rounded quantity.**
 *   Those are the four accepted primitives of `@daftar/inventory`
 *   (`convertToBase`, `apRelease`, `creditRemainingCarrying`, `creditRelease`)
 *   and the chain verifiers beside them. `@daftar/domain-core` is below
 *   `@daftar/inventory` in the dependency order and must not import it, so the
 *   S5 plan layer that calls those primitives lives at the API module
 *   (`apps/api/src/modules/returns/returns-settlement.ts`) exactly as S4's did
 *   before its reconciliation, and NOTHING here re-implements any of them.
 *   P4-AL-07: a second body of a financial truth "disagrees only under the
 *   numbers nobody tested";
 * - it stores no cap and derives none from an average. The refund cap is the
 *   source document's own `remaining_amount_minor`, whose agreement with
 *   `original − Σ(exact stored consumer rows)` is established by the COMMIT-time
 *   chain verifier in the database and by the one TypeScript twin of it. There
 *   is deliberately **no `refundedAmountMinor` anywhere in this slice** — see
 *   `FORBIDDEN_REFUND_FIELD_NAMES`;
 * - tax is **structurally zero**: `OD-03` is OPEN and the owner's alone. A
 *   credit note carries no rate, no jurisdiction and no tax path. Where it
 *   mirrors `invoices.tax_minor` at all it mirrors it as a structural zero,
 *   through the existing `isStructuralZeroTax` of `./invoice`.
 *
 * ## The one financial law this file makes structural
 *
 * `TL-P4-S5-R1`: **a refund is not an invoice-outstanding reducer.** The
 * ORDER OF EFFECTS is
 *
 * ```
 *   invoice  →  the credit-note / return effect reduces AR  ONCE
 *            →  the refund consumes the credit note's or the customer
 *               credit's remaining
 *            →  AR UNCHANGED
 *            →  cash / bank moves
 * ```
 *
 * The slice does not obey that by remembering to. It obeys it because a refund
 * has nowhere to put an AR reduction: it names no invoice
 * (`REFUND_NAMES_NO_INVOICE`), its entry's account set excludes
 * `accounts_receivable` by a closed list (`REFUND_ENTRY_ACCOUNTS`), and the
 * field names that would carry either are refused by name
 * (`FORBIDDEN_REFUND_FIELD_NAMES`). Each of those three is proved able to FAIL
 * by its own red proof; a guard never shown able to go red is not a guard.
 */
import { isStructuralZeroTax } from './invoice';

// ── 1. There is NO lifecycle, and that is the correction ─────────────────

/**
 * **`credit_notes` HAS NO `status` COLUMN AND S5 HAS NO VOID COMMAND.** An
 * earlier draft of this module shipped `CREDIT_NOTE_LIFECYCLE_STATES =
 * ['draft','issued','void']`, a three-row transition table,
 * `isCreditNoteLifecycleTransitionAllowed`, `creditNoteVoidRefusal`, a
 * `setLifecycle` port, a `customer.void_credit_note` operation code and the
 * refusal codes `credit_note.lifecycle_invalid` and
 * `credit_note.already_consumed`. Every one of them is deleted, and this comment
 * is what stands in their place.
 *
 * Three reasons, each decisive on its own.
 *
 * 1. **It was unimplementable.** The DDL specification's `credit_notes_guard`
 *    permits exactly one `UPDATE` — the remaining PAIR moving down by one
 *    backed consumption — which is `customer_credit_guard`'s accepted shape and
 *    is right. Setting a lifecycle is an `UPDATE` of `status`, so the void
 *    command's only action was forbidden by the guard protecting the relation it
 *    acted on. So were `draft → issued` and therefore issuing a note at all.
 * 2. **`P4-AL-46` already answers the question.** A commercial mistake is
 *    corrected by a NEW document, never by editing the old one. A credit note
 *    issued in error is superseded by another note; it is not amended into
 *    nonexistence.
 * 3. **A void of an ISSUED note is a REVERSAL, and reversals are S6's.** The
 *    issue command has already posted `Dr sales_returns (4100) / Cr
 *    customer_refund_liability (2200)` for the whole total and the `1200/5000`
 *    COGS reversal. Unwinding those is the `reversal` source type and the
 *    `accounting_reversals` mechanism, which the coordinator ruled S5 may not
 *    design. A void that posted nothing would leave 2200 carrying a refundable
 *    liability for a document that no longer exists, and 4100/1200/5000 standing
 *    for a return that was retracted — which is strictly worse than having no
 *    void at all.
 *
 * `draft` was unproduceable in any case: S5's command set creates a note and
 * posts its entry in one transaction, and nothing in the slice ever wrote a
 * draft. A state no command can reach and a code no command can raise are
 * contracts nobody can meet — the same rule that kept `payments.reverse` out of
 * this slice.
 *
 * **What is owed, and to whom.** Voiding or reversing an issued credit note is
 * recorded as a predecessor assumption on S6 (`A-23` in the contract pack). S5
 * needs nothing from it to be complete: a note issued in error is superseded by
 * a new note, and the liability it raised is either discharged by a refund or
 * left standing, both of which are representable today.
 */
export const CREDIT_NOTE_HAS_NO_LIFECYCLE =
  'a credit note is born issued and is thereafter only consumed; voiding an issued note is a reversal, and reversals are S6';

// ── 2. The refund's source algebra — `credit_note` XOR `customer_credit` ──

/**
 * The two — and only two — kinds of source a refund may draw on.
 *
 * `TL-P4-S5-R1`: **exactly one of `credit_note` XOR `customer_credit`.** There
 * is no `payment` source, because refunding a payment is the AR reduction the
 * ruling forbids wearing a different name: a payment already released the
 * invoice's carrying base, so consuming it again would release it twice.
 *
 * Both kinds are *consumable sources* in the P4-AL-22 sense: each carries a
 * remaining PAIR (amount and carrying base) and each is decremented only by a
 * backed consumption. That is why one refund shape serves both and there is no
 * second refund model.
 */
export const REFUND_SOURCE_KINDS = ['credit_note', 'customer_credit'] as const;
export type RefundSourceKind = (typeof REFUND_SOURCE_KINDS)[number];

/**
 * A refund's stated source, as it arrives from a caller or is read off a row:
 * two optional ids, never a kind discriminator.
 *
 * **There is no `sourceType` / `sourceKind` field, and its absence is the
 * design.** A stored discriminator beside two nullable ids is a second truth
 * about which id is set, and in the database it is exactly the shape GOLD-74
 * refuses on the financial core (`scripts/phase4-s1-gate.ts:1565-1577`: a
 * `*_id` beside a `*_type`/`*_kind` with no foreign key). The kind is DERIVED
 * from which id is present, by `resolveRefundSource`, in one place.
 */
export interface RefundSourceRef {
  readonly creditNoteId?: string | null;
  readonly customerCreditId?: string | null;
}

/** Why a stated source is not one lawful source. */
export type RefundSourceProblem = 'source_absent' | 'source_ambiguous';

/**
 * The resolved kind and id, or the problem.
 *
 * Both-set is `source_ambiguous` and neither-set is `source_absent`, and the
 * two are deliberately DIFFERENT problems: "you named two sources" and "you
 * named none" are different merchant mistakes and a single code would make the
 * client guess which. This is the TypeScript twin of the row's
 * `CHECK (num_nonnulls(credit_note_id, customer_credit_id) = 1)`.
 */
export function resolveRefundSource(
  ref: RefundSourceRef,
): { readonly ok: true; readonly kind: RefundSourceKind; readonly sourceId: string } | { readonly ok: false; readonly problem: RefundSourceProblem } {
  const note = ref.creditNoteId ?? null;
  const credit = ref.customerCreditId ?? null;
  if (note !== null && credit !== null) return Object.freeze({ ok: false as const, problem: 'source_ambiguous' as const });
  if (note !== null) return Object.freeze({ ok: true as const, kind: 'credit_note' as const, sourceId: note });
  if (credit !== null) return Object.freeze({ ok: true as const, kind: 'customer_credit' as const, sourceId: credit });
  return Object.freeze({ ok: false as const, problem: 'source_absent' as const });
}

/**
 * `TL-P4-S5-R1`, as a predicate over a shape rather than a sentence in a
 * document: a refund NAMES NO INVOICE.
 *
 * Given the field names a refund request or row carries, this is true only when
 * none of them could identify an invoice. An `invoiceId` on a refund is the
 * second AR reduction the ruling forbids, expressed as a column — and so is an
 * `invoiceIds`, an `invoiceNumber` or an `againstInvoice`.
 */
const INVOICE_NAMING_FIELD = /(^|_)invoice(s)?($|_)|^invoice|invoice(Id|Ids|No|Number)$/i;

/** The subset of `fields` that would let a refund name an invoice. Empty is a pass. */
export function refundInvoiceNamingFields(fields: readonly string[]): readonly string[] {
  return Object.freeze(fields.filter((f) => INVOICE_NAMING_FIELD.test(f)));
}

/** True when nothing in `fields` could name an invoice. */
export function REFUND_NAMES_NO_INVOICE(fields: readonly string[]): boolean {
  return refundInvoiceNamingFields(fields).length === 0;
}

/**
 * Field names a refund request, DTO or row may NEVER carry, each with the law
 * that refuses it. A closed table, so a reader can check it against the laws
 * instead of trusting a regular expression's mood.
 *
 * - a payment source — `TL-P4-S5-R1`, "it carries no `payment_id`", and the
 *   execution plan's "no column that could name a payment";
 * - a stored consumption total — the cap is derived from the exact stored rows,
 *   and `refunded_amount_minor` is also an authoritative-balance COLUMN to G-3
 *   (`AP_BALANCE_COLUMN`, `scripts/guards/no-authoritative-balance.ts:314`), so
 *   it is refused twice over by two different laws;
 * - a stored discriminator beside two nullable foreign keys — GOLD-74, §2
 *   above.
 */
export const FORBIDDEN_REFUND_FIELD_NAMES: readonly { readonly pattern: RegExp; readonly reason: string }[] = Object.freeze([
  Object.freeze({ pattern: /(^|_)payment(s)?($|_)|^payment(Id|Ids)$/i, reason: 'TL-P4-S5-R1: a refund has no payment source' }),
  Object.freeze({ pattern: /(^|_)refunded($|_)|refundedAmount/i, reason: 'G-3 / law 3: the cap is derived, never stored' }),
  Object.freeze({
    pattern: /(^|_)(source|refund)_(type|kind)($|_)|^(source|refund)(Type|Kind)$/i,
    reason: 'GOLD-74: no discriminator beside two nullable FKs',
  }),
  Object.freeze({ pattern: /(^|_)(outstanding|collected|allocated|settled)($|_)/i, reason: 'G-3: no stored derived settlement figure' }),
]);

/** Every `(field, reason)` pair a shape's field list violates. Empty is a pass. */
export function forbiddenRefundFields(fields: readonly string[]): readonly { readonly field: string; readonly reason: string }[] {
  const out: { readonly field: string; readonly reason: string }[] = [];
  for (const field of fields) {
    for (const rule of FORBIDDEN_REFUND_FIELD_NAMES) {
      if (rule.pattern.test(field)) out.push(Object.freeze({ field, reason: rule.reason }));
    }
  }
  return Object.freeze(out);
}

// ── 3. The refund entry's account set (law 1, made structural) ───────────

/**
 * **THE ONE CANONICAL ACCOUNT-ID SOURCE of the S5 slice.**
 *
 * `TL-P4-S5-R2` §13, as the project owner ruled it: *"do not fix this by making
 * all three literals equal — REMOVE DUPLICATE AUTHORITY."* Every S5 account
 * identifier is spelled HERE, once, and nowhere else in the slice. The two
 * closed entry-account lists below, `refundLiabilityAccount`, and every line
 * builder, mapper and validator in `apps/api/src/modules/returns/` all DERIVE
 * their strings from these nine members.
 *
 * ## Why a role is not a duplicate, and why these are keys rather than roles
 *
 * Three S5 laws name 2200 today, and they are three laws, not one restated:
 * the credit-note entry RAISES the liability, the application DISCHARGES it,
 * and a refund discharges whichever of 2200/2210 its source kind carries. Those
 * three ROLES stay three distinct, separately named decisions — collapsing them
 * would be the opposite error, and `refundLiabilityAccount` is exactly one such
 * role. What they may not each own is the STRING. A role selects a member of
 * this table; it does not re-spell one.
 *
 * ## What this buys that equal literals did not
 *
 * The identifiers are not ours. They are the chart keys
 * `0040_accounting_chart.sql:45-66` registers, with the registry CLOSED at 21
 * by the `DO $$` count at `0040:70-78`, plus `posting_account`, which is a
 * placeholder and not a chart key at all (see `REFUND_ENTRY_ACCOUNTS`). When
 * `PATCH-REQ-S5-008` moves the application's liability, or the chart renames a
 * key, exactly one line of this estate changes and every planner follows it.
 * With three equal literals, two of them would have stayed behind, compiled,
 * and refused every lawful command at runtime — the M2 mechanism.
 *
 * The property NAMES are keys, not a second authority: a rename upstream makes
 * `S5_ACCOUNT.CUSTOMER_REFUND_LIABILITY` a type error at the one site that
 * declares it, not a silent `undefined` at twenty.
 *
 * No member is dead. Each of the nine is reachable on a live path, and
 * `tests/guards/p4s5-account-authority-mutation.test.ts` asserts that
 * reachability member by member against the planners' own output rather than
 * against this docstring — because `customer.aging_buckets_invalid` is what a
 * registry member nothing reaches looks like, and a comment is how its absence
 * went unnoticed.
 */
export const S5_ACCOUNT = Object.freeze({
  /** 4100, contra-revenue. The credit note's revenue reversal. */
  SALES_RETURNS: 'sales_returns',
  /** 1100. The credit-note APPLICATION is the one place AR falls. */
  ACCOUNTS_RECEIVABLE: 'accounts_receivable',
  /** 2200. Raised by the credit note, discharged by its application or by a refund on it. */
  CUSTOMER_REFUND_LIABILITY: 'customer_refund_liability',
  /** 2210. Discharged by a refund drawn on a CUSTOMER CREDIT, never by the credit-note path. */
  CUSTOMER_CREDIT_LIABILITY: 'customer_credit_liability',
  /** The COGS reversal's pair. */
  INVENTORY: 'inventory',
  COGS: 'cogs',
  /** 4900 and 6900. The two sides of ONE signed realized difference, never two computations. */
  FX_GAIN: 'fx_gain',
  FX_LOSS: 'fx_loss',
  /** NOT a chart key: a placeholder resolved at posting time from `payment_methods.posting_account_id`. */
  POSTING_ACCOUNT: 'posting_account',
} as const);

/**
 * The system account keys a refund entry may name, and NOTHING else.
 *
 * **FOUR of the five are registered system keys; `posting_account` is not, and
 * saying otherwise was wrong.** `customer_refund_liability` is 2200,
 * `customer_credit_liability` is 2210 (and `0081:1594` already DEBITS it when a
 * credit is consumed, so a refund drawn on a customer credit is the same debit
 * through a different consumer), `fx_gain` is 4900 and `fx_loss` is 6900 — each
 * one of the twenty-one keys `0040_accounting_chart.sql:45-66` registers, with
 * the registry CLOSED at 21 by the `DO $$` count at `0040:70-78`.
 *
 * `posting_account` is a PLACEHOLDER for a per-method account resolved at
 * posting time from `payment_methods.posting_account_id`, which is a row
 * reference and not a system key at all. It is in this list because the entry
 * needs somewhere to name the cash side, and it is named here rather than
 * silently so that nobody later reads this union as a list of chart keys and
 * goes looking for `posting_account` in `0040`. S5 registers no account and
 * invents no code either way.
 *
 * **`accounts_receivable` (1100) is absent, and that absence IS `TL-P4-S5-R1`.**
 * A refund entry has no place to put an AR movement, so it cannot make one. The
 * rounding account 6100 and the tax account 2100 are absent for the reasons
 * P4-AL-19 and OD-03 give: no rounding account is invented to make arithmetic
 * balance, and there is no tax line in this slice.
 */
export const REFUND_ENTRY_ACCOUNTS = [
  S5_ACCOUNT.CUSTOMER_REFUND_LIABILITY,
  S5_ACCOUNT.CUSTOMER_CREDIT_LIABILITY,
  S5_ACCOUNT.FX_GAIN,
  S5_ACCOUNT.FX_LOSS,
  S5_ACCOUNT.POSTING_ACCOUNT,
] as const;
export type RefundEntryAccount = (typeof REFUND_ENTRY_ACCOUNTS)[number];

/** True only for one of the five. A test may plant `accounts_receivable` and watch this refuse it. */
export function isRefundEntryAccount(key: string): key is RefundEntryAccount {
  return (REFUND_ENTRY_ACCOUNTS as readonly string[]).includes(key);
}

/**
 * The liability a refund discharges, per source kind. One function, so the two
 * kinds cannot drift apart, and no branch anywhere else in the slice decides
 * it.
 */
export function refundLiabilityAccount(kind: RefundSourceKind): Extract<RefundEntryAccount, 'customer_refund_liability' | 'customer_credit_liability'> {
  // The ROLE is decided here; the STRING comes from `S5_ACCOUNT`. The two are
  // separate on purpose: this function is the one authority over WHICH
  // liability a source kind discharges, and `S5_ACCOUNT` is the one authority
  // over how that account is spelled.
  return kind === 'credit_note' ? S5_ACCOUNT.CUSTOMER_REFUND_LIABILITY : S5_ACCOUNT.CUSTOMER_CREDIT_LIABILITY;
}

/**
 * The system account keys a CREDIT NOTE entry may name.
 *
 * `sales_returns` is 4100 — already registered, and
 * `packages/accounting/src/sale-posting.ts:31` records in its own words that
 * "4100 is the RETURN account and belongs to P4-S5". So the revenue reversal is
 * a debit of 4100 and never a negative credit of 4000: a contra-revenue account
 * exists precisely so that returns are visible rather than netted away.
 *
 * `accounts_receivable` IS here, and must be: the credit-note effect is the one
 * place AR falls, and it falls exactly once. `inventory` and `cogs` are the COGS
 * reversal's pair.
 */
export const CREDIT_NOTE_ENTRY_ACCOUNTS = [
  S5_ACCOUNT.SALES_RETURNS,
  S5_ACCOUNT.ACCOUNTS_RECEIVABLE,
  S5_ACCOUNT.CUSTOMER_REFUND_LIABILITY,
  S5_ACCOUNT.INVENTORY,
  S5_ACCOUNT.COGS,
  S5_ACCOUNT.FX_GAIN,
  S5_ACCOUNT.FX_LOSS,
] as const;
export type CreditNoteEntryAccount = (typeof CREDIT_NOTE_ENTRY_ACCOUNTS)[number];

/** True only for one of the seven. */
export function isCreditNoteEntryAccount(key: string): key is CreditNoteEntryAccount {
  return (CREDIT_NOTE_ENTRY_ACCOUNTS as readonly string[]).includes(key);
}

// ── 4. The operation codes and the accounting source types ───────────────

/**
 * The `invctl/1` operation codes S5 needs.
 *
 * The spelling is forced, not chosen: `inventory_operation_kinds.op_code` is
 * `CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')` frozen inside
 * `inventory_payload_digest` (`0054:229`, probed at `0074:62-70`), so the FIRST
 * SEGMENT may hold no underscore and `customer_refund.create` is
 * unrepresentable. Hence `customer.*`, the same namespace as S4's
 * `customer.collect_payment` and `customer.apply_credit`.
 *
 * **These are a REQUEST, not a registration.** The union they belong to lives in
 * `packages/inventory/src/payload.ts`, which is the inventory primitives and not
 * S5's to edit; `PATCH-REQ-S5-001` asks for them there. Until that lands, this
 * list is what the plan layer and the tests name, and nothing reads it as a
 * registry.
 */
export const S5_OPERATION_CODES = ['customer.issue_credit_note', 'customer.refund'] as const;
export type S5OperationCode = (typeof S5_OPERATION_CODES)[number];

/** The frozen `0054:229` shape, so a proposed op code can be judged before anybody writes a migration. */
export const OPERATION_CODE_SHAPE = /^[a-z]+(\.[a-z_]+)+$/;

/** True when `code` is representable at all under the frozen digest's CHECK. */
export function isRepresentableOperationCode(code: string): boolean {
  return OPERATION_CODE_SHAPE.test(code);
}

/**
 * The accounting source types S5 needs.
 *
 * The naming convention is the LIVE REGISTRY's, not `P4-AL-20`'s enumeration:
 * the live rows are `customer_payment_allocation`, `customer_credit_application`
 * and `customer_credit` (`0077:1702-1703`, `0081:2468-2472`), and the S4 gate
 * pins those spellings as RULED (`scripts/phase4-s4-gate.ts:577`). The lock's
 * bare `credit_note` / `refund` is stale on exactly the point the registry
 * decides, and the preparation page records it (§3.3). So S5's types are
 * `customer_`-prefixed, singular, in the row's own domain.
 *
 * ## Measured: no row exists for any of these three, and the registry is closed
 *
 * `accounting_source_types` is created closed by `0042:65-68` (three natives) and
 * widened only by an explicit `INSERT`. Every such `INSERT` in the tree was read
 * at `6587460`; the live registry holds SEVENTEEN types and **none of them is a
 * credit note, a return of a customer's goods, or a refund to a customer**:
 *
 * ```
 * 0042  opening_balance, manual_adjustment, reversal                      (1-3)
 * 0061  inventory_adjustment, inventory_opening
 * 0063  purchase, negative_inventory_cost_adjustment
 * 0065  supplier_return
 * 0067  supplier_payment, supplier_credit_allocation, supplier_refund
 * 0072  purchase_residue_write_off
 * 0077  sale (13), invoice (14)
 * 0081  customer_payment_allocation (15), customer_credit_application (16),
 *       customer_credit (17)
 * ```
 *
 * So binding to an existing identity is NOT available for the customer return or
 * the customer refund: there is nothing to bind to. Minting is forced, and S5's
 * three take `sort_order` 18, 19 and 20.
 *
 * ## The naming follows `0065`'s precedent: the EVENT, not the row
 *
 * `supplier_credit_notes.accounting_source_type` is
 * `GENERATED ALWAYS AS ('supplier_return') STORED` (`0065:199`) — the supplier
 * credit note binds to the `supplier_return` type and **no `supplier_credit_note`
 * type was ever minted**, because the credit note is the accounting FACE of the
 * return rather than a second event. `purchase_reversals` does the same thing one
 * step further out, binding to the native `reversal` (`0065:310`).
 *
 * S5 therefore names the first type **`customer_return`** and not
 * `customer_credit_note`: the event is the customer returning goods, and
 * `credit_notes` is its document. That is the exact mirror of the supplier side,
 * and it means the registry gains one identity for the whole return rather than
 * one per relation.
 *
 * ## Why the application and the refund are still separate types
 *
 * `customer_credit_note_application` is the type of the entry that reduces AR and
 * `customer_refund` the type of the entry that moves cash. They are three types
 * and not one because they are three entries at three grains with three different
 * expected journal shapes, and **one type with a branch inside its completeness
 * validator is how a shape nobody checks arrives** — `TL-P4-S1-R1`'s whole
 * substance. The supplier side reached the same answer: `supplier_return`,
 * `supplier_credit_allocation` and `supplier_refund` are three types, not one.
 *
 * ## S5 mints NO reversal type and ships NO reversal relation
 *
 * `payment_reversals` and `allocation_reversals` belong to P4-S6, with
 * `void_invoice`. Measured: there is no `allocation_reversal` row in the live
 * registry at all, and nothing in this slice names, specifies or needs one. A
 * refund is not a reversal — it lawfully discharges a liability that was
 * correctly recorded — so the refund path has no dependency on S6 whatever.
 */
export const S5_ACCOUNTING_SOURCE_TYPES = ['customer_return', 'customer_credit_note_application', 'customer_refund'] as const;
export type S5AccountingSourceType = (typeof S5_ACCOUNTING_SOURCE_TYPES)[number];

/**
 * The `accounting_reversals_20_domain_source_guard()` obligation, as data.
 *
 * `0081:1405-1412` lists thirteen source types and `P4-AL-47` / seam `S-P4-02`
 * require a registration and that list to move TOGETHER. The moment these three
 * types are registered, that routine must be replaced to name them or
 * `daftar_app` can reverse an S5 entry through the generic path. It is a
 * `CREATE OR REPLACE` in a NEW migration — never an edit of the frozen file —
 * and `PATCH-REQ-S5-002` is the request for it.
 */
export const S5_SOURCE_TYPES_OWED_TO_REVERSAL_GUARD: readonly S5AccountingSourceType[] = Object.freeze([...S5_ACCOUNTING_SOURCE_TYPES]);

// ── 5. The closed refusal vocabulary ────────────────────────────────────

/**
 * Every refusal the S5 surface can raise, as a closed literal union.
 *
 * Written out per domain rather than templated, for the reason
 * `packages/inventory/src/customer-settlement.ts:116-145` records at length: a
 * templated union is symmetric by construction and hides the one defect the
 * list exists to prevent — a live raise site whose code no status table
 * classifies, which turns a merchant's input error into a 500 blaming our
 * arithmetic. The API's `returns-errors.ts` holds this union to its status
 * table at COMPILE TIME, so a code added here without a status is a type error
 * rather than a review find.
 *
 * The asymmetry is deliberate. Only a refund has a `cap_exceeded` and a
 * `source_*`; only a credit note has a `cogs_not_exact` and a
 * `tax_policy_absent`. Both have a `date_invalid`, because both judge a date.
 *
 * `credit_note.already_consumed` and `credit_note.lifecycle_invalid` were here
 * and are gone: see `CREDIT_NOTE_HAS_NO_LIFECYCLE` above. No command can raise
 * either, and a code no command can raise is a contract nobody can meet.
 */
export type ReturnsRefusalCode =
  // ── The credit note ──────────────────────────────────────────────
  | 'credit_note.idempotency_conflict'
  | 'credit_note.items_invalid'
  | 'credit_note.quantity_exceeds_sold'
  | 'credit_note.amount_invalid'
  | 'credit_note.amount_below_base_unit'
  | 'credit_note.residue_below_base_unit'
  | 'credit_note.amount_mismatch'
  | 'credit_note.amount_exceeds_outstanding'
  | 'credit_note.amount_exceeds_note'
  | 'credit_note.note_exhausted'
  | 'credit_note.customer_mismatch'
  | 'credit_note.invoice_state_invalid'
  | 'credit_note.invoice_walkin'
  | 'credit_note.settlement_changed'
  | 'credit_note.date_before_invoice'
  | 'credit_note.date_in_future'
  | 'credit_note.date_invalid'
  | 'credit_note.cogs_not_exact'
  | 'credit_note.posting_incomplete'
  | 'credit_note.tax_policy_absent'
  | 'credit_note.not_found'
  // ── The refund ───────────────────────────────────────────────────
  | 'customer_refund.idempotency_conflict'
  | 'customer_refund.source_absent'
  | 'customer_refund.source_ambiguous'
  | 'customer_refund.source_exhausted'
  | 'customer_refund.amount_invalid'
  | 'customer_refund.amount_exceeds_source'
  | 'customer_refund.amount_below_base_unit'
  | 'customer_refund.residue_below_base_unit'
  | 'customer_refund.amount_mismatch'
  | 'customer_refund.customer_mismatch'
  | 'customer_refund.source_changed'
  | 'customer_refund.fx_rate_changed'
  | 'customer_refund.date_before_source'
  | 'customer_refund.date_in_future'
  | 'customer_refund.date_invalid'
  | 'customer_refund.reference_required'
  | 'customer_refund.not_found'
  // ── Ours, never theirs ───────────────────────────────────────────
  | 'customer_refund.arithmetic_invalid'
  | 'customer_refund.registry_incomplete'
  | 'credit_note.consumption_inconsistent';

/** The same union as a runtime list, for a suite that drives every code rather than trusting the type. */
export const RETURNS_REFUSAL_CODES: readonly ReturnsRefusalCode[] = Object.freeze([
  'credit_note.idempotency_conflict',
  'credit_note.items_invalid',
  'credit_note.quantity_exceeds_sold',
  'credit_note.amount_invalid',
  'credit_note.amount_below_base_unit',
  'credit_note.residue_below_base_unit',
  'credit_note.amount_mismatch',
  'credit_note.amount_exceeds_outstanding',
  'credit_note.amount_exceeds_note',
  'credit_note.note_exhausted',
  'credit_note.customer_mismatch',
  'credit_note.invoice_state_invalid',
  'credit_note.invoice_walkin',
  'credit_note.settlement_changed',
  'credit_note.date_before_invoice',
  'credit_note.date_in_future',
  'credit_note.date_invalid',
  'credit_note.cogs_not_exact',
  'credit_note.posting_incomplete',
  'credit_note.tax_policy_absent',
  'credit_note.not_found',
  'customer_refund.idempotency_conflict',
  'customer_refund.source_absent',
  'customer_refund.source_ambiguous',
  'customer_refund.source_exhausted',
  'customer_refund.amount_invalid',
  'customer_refund.amount_exceeds_source',
  'customer_refund.amount_below_base_unit',
  'customer_refund.residue_below_base_unit',
  'customer_refund.amount_mismatch',
  'customer_refund.customer_mismatch',
  'customer_refund.source_changed',
  'customer_refund.fx_rate_changed',
  'customer_refund.date_before_source',
  'customer_refund.date_in_future',
  'customer_refund.date_invalid',
  'customer_refund.reference_required',
  'customer_refund.not_found',
  'customer_refund.arithmetic_invalid',
  'customer_refund.registry_incomplete',
  'credit_note.consumption_inconsistent',
]);

/** True for an exact member of the closed vocabulary. */
export function isReturnsRefusalCode(code: string): code is ReturnsRefusalCode {
  return (RETURNS_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The localization key a refusal renders through: `error.<code>`, the accepted S4 shape. */
export function returnsRefusalMessageKey(code: ReturnsRefusalCode): string {
  return `error.${code}`;
}

/** The source problem of §2, mapped onto the refusal vocabulary. One mapping, in one place. */
export function refundSourceRefusal(problem: RefundSourceProblem): Extract<ReturnsRefusalCode, `customer_refund.source_${'absent' | 'ambiguous'}`> {
  return problem === 'source_absent' ? 'customer_refund.source_absent' : 'customer_refund.source_ambiguous';
}

// ── 6. The lock order and the transaction boundary ──────────────────────

/**
 * The order in which an S5 command takes its row locks, named once.
 *
 * A deadlock between two S5 commands is not prevented by care; it is prevented
 * by every command taking the same locks in the same order. The order is the
 * data-flow order and it is also the order S4's commands already use for the
 * rows they share, so an S5 command and an S4 command interleaving cannot
 * invert a pair:
 *
 * 1. `customers` — the identity pin, taken first because every later lock is
 *    scoped by it;
 * 2. `invoices` — only the credit-note command takes this, and only for the
 *    invoice its application names. A refund NEVER takes it (`TL-P4-S5-R1`);
 * 3. `credit_notes` / `customer_credits` — the SOURCE, `FOR UPDATE`. **This is
 *    where the cap is checked**, inside the source, after the lock and never
 *    before it;
 *
 * **Why step 3 is ONE rank over two relations, and not two ranks.** A rank
 * exists to order a PAIR of locks a single command might take. No S5 command
 * can take both of these: a refund's source is `credit_note` XOR
 * `customer_credit` by ruling, enforced by
 * `CHECK (num_nonnulls(credit_note_id, customer_credit_id) = 1)` on the row and
 * by `resolveRefundSource` in the command; the credit-note application touches
 * `credit_notes` and never `customer_credits`; and the void command touches
 * only its own note. So there is no pair to invert, and splitting the rank
 * would assert an order between two locks that are never held together — which
 * is not a stronger law, it is a law about nothing. `returnsLockTraceOneSource`
 * below is what makes the premise checkable instead of remembered, and its red
 * proof plants a trace holding both.
 *
 * 4. `payment_methods` — the posting account, last, because it is a
 *    configuration read and nothing downstream of it takes a lock.
 *
 * `invoice_sequences` is taken by the document-numbering primitive inside step
 * 1's scope and is listed as part of it rather than as a fifth step, because a
 * number is allocated before any financial row exists.
 */
export const RETURNS_LOCK_ORDER = ['customers', 'invoices', 'credit_notes|customer_credits', 'payment_methods'] as const;

/** The position of a relation in the lock order, or `-1`. A test can assert monotonicity over a trace. */
export function returnsLockRank(relation: string): number {
  return RETURNS_LOCK_ORDER.findIndex((step) => step.split('|').includes(relation));
}

/** The two relations that share rank 3 — the two source kinds, which no command holds together. */
export const RETURNS_SOURCE_RELATIONS = ['credit_notes', 'customer_credits'] as const;

/**
 * The PREMISE of rank 3 being one rank: a single command's lock trace names at
 * most ONE of the two source relations.
 *
 * Returns the offending pair when a trace holds both, and `null` otherwise. It
 * is a function rather than a sentence in the comment above because the comment
 * argues that no pair can be inverted, and an argument from a premise is worth
 * only as much as the premise is checked.
 */
export function returnsLockTraceOneSource(trace: readonly string[]): readonly string[] | null {
  const held = RETURNS_SOURCE_RELATIONS.filter((r) => trace.includes(r));
  return held.length > 1 ? Object.freeze([...held]) : null;
}

/**
 * Whether a trace of lock acquisitions respects the order. Equal ranks are
 * allowed (two invoices of one credit note), a decrease is not.
 *
 * A relation outside the order is a DEFECT, not a pass: an S5 command that
 * locks something the order does not name is a command whose deadlock
 * behaviour nobody has reasoned about.
 */
export function isLawfulLockTrace(trace: readonly string[]): boolean {
  let last = -1;
  for (const relation of trace) {
    const rank = returnsLockRank(relation);
    if (rank < 0 || rank < last) return false;
    last = rank;
  }
  return true;
}

/**
 * The transaction boundary of each S5 command: ONE transaction, and what must
 * be inside it.
 *
 * A refund that disbursed cash in one transaction and decremented its source in
 * another is a refund that can pay twice. A credit note whose revenue reversal
 * committed without its COGS reversal is a credit note that moved revenue and
 * not cost.
 */
export const RETURNS_TRANSACTION_BOUNDARY: readonly {
  readonly command: S5OperationCode;
  readonly inOneTransaction: readonly string[];
}[] = Object.freeze([
  Object.freeze({
    command: 'customer.issue_credit_note' as const,
    inOneTransaction: Object.freeze([
      'allocate the credit-note number under the sequence row lock',
      'insert credit_notes and credit_note_items',
      'insert credit_note_applications for the AR reduction (at most one per invoice, at the invoice level)',
      'request the return stock movements from the one stock-movement authority',
      'post the revenue-reversal entry (4100) and the COGS-reversal entry (1200/5000)',
      'verify the invoice settlement chain and the credit-note consumption chain at COMMIT',
    ]),
  }),
  Object.freeze({
    command: 'customer.refund' as const,
    inOneTransaction: Object.freeze([
      'lock the single source FOR UPDATE',
      'check the cap against the locked remaining',
      'insert refunds at the locked level',
      'decrement the source remaining pair through its ONE writer',
      'post the refund entry (liability / posting account, no AR line)',
      'verify the source consumption chain at COMMIT',
    ]),
  }),
]);

// ── 7. Idempotency: the same identity, the same intent ──────────────────

/**
 * The fields that make up a refund's intent hash — a CLOSED list, in a fixed
 * order, because the hash is a claim about WHICH economic command a key stands
 * for.
 *
 * Law 8: a key must preserve the same identity and the same intent hash, replay
 * exactly, and CONFLICT on a changed intent. "An idempotency key is not
 * permission": a replay must prove which command it is replaying before it
 * answers success, so every field that could change where the money goes, how
 * much of it goes, or which source pays is in this list.
 *
 * The level (`remainingBeforeMinor`) is deliberately NOT in it. The level is
 * where the row landed, not what the caller asked for; including it would make
 * an honest retry after a concurrent consumption look like a different command
 * and turn a `source_changed` into an `idempotency_conflict`.
 */
/**
 * The ONE absence encoding of this slice, and the ONE field separator.
 *
 * `\u0000` for an absent value and `\n` between fields. Both halves matter and
 * the first is the one that silently differs between two implementations: `null`
 * and `''` must not collide, or a refund with no reference and a refund whose
 * reference is the empty string share a pre-image and therefore a hash, and a
 * replay of one answers success for the other.
 *
 * It is a function rather than a convention repeated twice because there are now
 * TWO commands with an intent — the refund and the credit note — and two copies
 * of an encoding are two encodings as soon as one of them is edited.
 */
function intentPreimage(fields: readonly string[], intent: Readonly<Record<string, string | null>>): string {
  return fields.map((f) => intent[f] ?? '\u0000').join('\n');
}

export const REFUND_INTENT_FIELDS = [
  'refundId',
  'customerId',
  'creditNoteId',
  'customerCreditId',
  'paymentMethodId',
  'refundDate',
  'sourceCurrency',
  'sourceAmountConsumedMinor',
  'disbursementCurrency',
  'disbursementAmountMinor',
  'reference',
] as const;
export type RefundIntentField = (typeof REFUND_INTENT_FIELDS)[number];

/** A refund's intent, as the canonical pre-image is built from it. Every value is text; a number never enters a hash pre-image. */
export type RefundIntent = { readonly [K in RefundIntentField]: string | null };

/**
 * The canonical pre-image of a refund's intent: the closed field list, in
 * order, newline-separated, `\u0000` for an absent value.
 *
 * This file does NOT hash it. `accounting_fingerprint` (`0045:120-133`) and
 * `packages/accounting/src/fingerprint.ts` are the one hashing authority in
 * this estate and a second `sha256` here would be a second fingerprint free to
 * drift. What this function fixes is the ORDER and the ABSENCE ENCODING, which
 * is the half that silently differs between two implementations: `null` and
 * `""` must not collide, or a refund with no reference and a refund whose
 * reference is the empty string share a hash.
 */
export function refundIntentPreimage(intent: RefundIntent): string {
  return intentPreimage(REFUND_INTENT_FIELDS, intent);
}

/** Whether two intents are the SAME economic command. Pre-image equality, never a field-by-field eyeball. */
export function isSameRefundIntent(a: RefundIntent, b: RefundIntent): boolean {
  return refundIntentPreimage(a) === refundIntentPreimage(b);
}

/**
 * What a replay of `refundId` must answer.
 *
 * `replay` when the stored intent is the same command — the stored result,
 * written nothing, 200 and `replayed: true`. `conflict` when it is a different
 * one — 409 `customer_refund.idempotency_conflict`, and never an acceptance. No
 * third answer exists: a key whose intent cannot be compared is a conflict, not
 * a fresh command.
 */
export function refundReplayVerdict(stored: RefundIntent | null, incoming: RefundIntent): 'fresh' | 'replay' | 'conflict' {
  if (stored === null) return 'fresh';
  return isSameRefundIntent(stored, incoming) ? 'replay' : 'conflict';
}

// ── 7a. The credit note has an intent too, and it is not the refund's ────

/**
 * The fields that make up a CREDIT NOTE's intent hash.
 *
 * The credit note is a command under an idempotency key exactly as the refund
 * is — `credit_note.idempotency_conflict` has existed in the refusal vocabulary
 * since the first draft of this slice — and a command with a conflict code but
 * no intent to compare has a code it can never lawfully raise. Law 8 is not
 * "the refund replays exactly"; it is "a key replays the same economic command
 * or conflicts", and it binds every command of the slice.
 *
 * Its own field list, and deliberately NOT the refund's: the two commands do not
 * share a single field whose meaning is the same. A credit note names an invoice
 * and a set of returned LINES; a refund names a source and a disbursement. The
 * one structural thing they share is the absence encoding, which is
 * `intentPreimage`, and that is shared as a function.
 *
 * `items` is in the list because it is the economic content: the same
 * `creditNoteId` re-sent with one more line is a DIFFERENT command, and a
 * replay that ignored the lines would accept it and return the first note's
 * result while the caller believes the extra line was returned.
 *
 * `creditNoteNumber` is NOT in the list. The number is ALLOCATED by the
 * command, not supplied to it (`allocateNumber`, G-07), so including it would
 * make an intent uncomputable before the command runs — which is the one moment
 * a replay has to compute it.
 */
export const CREDIT_NOTE_INTENT_FIELDS = [
  'creditNoteId',
  'customerId',
  'invoiceId',
  'creditNoteDate',
  'currencyCode',
  'totalMinor',
  'taxMinor',
  'reference',
  'items',
] as const;
export type CreditNoteIntentField = (typeof CREDIT_NOTE_INTENT_FIELDS)[number];

/** A credit note's intent, as the canonical pre-image is built from it. Every value is text; a number never enters a hash pre-image. */
export type CreditNoteIntent = { readonly [K in CreditNoteIntentField]: string | null };

/** One returned line, as the intent reads it. Its own value fields and nothing derived. */
export interface CreditNoteIntentItem {
  readonly lineNo: number;
  readonly productId: string;
  readonly quantity: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
}

/**
 * The returned lines, rendered into the ONE `items` field, in `lineNo` order.
 *
 * The separators are `\u001f` between a line's fields and `\u001e` between
 * lines — the ASCII unit and record separators — and NEITHER is `\n`. That is
 * the point rather than a flourish: if the lines were joined with the top-level
 * separator, a set of lines could be rendered into a byte sequence that a
 * DIFFERENT set of lines plus a different top-level field also renders into, and
 * two distinct commands would share a pre-image. A nested encoding that reuses
 * its parent's delimiter is not injective.
 *
 * The order is imposed here, by `lineNo`, so the same lines submitted in a
 * different order are the same command. A caller's array order is not an
 * economic fact.
 */
export function creditNoteIntentItems(items: readonly CreditNoteIntentItem[]): string {
  return [...items]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((i) => [String(i.lineNo), i.productId, i.quantity, i.unitPriceMinor, i.netMinor].join('\u001f'))
    .join('\u001e');
}

/**
 * The canonical pre-image of a credit note's intent: the closed field list, in
 * order, through the SAME absence encoding the refund uses.
 *
 * This file does not hash it, for the reason `refundIntentPreimage` gives:
 * `accounting_fingerprint` (`0045:120-133`) and
 * `packages/accounting/src/fingerprint.ts` are the one hashing authority in this
 * estate.
 */
export function creditNoteIntentPreimage(intent: CreditNoteIntent): string {
  return intentPreimage(CREDIT_NOTE_INTENT_FIELDS, intent);
}

/** Whether two credit-note intents are the SAME economic command. Pre-image equality, never a field-by-field eyeball. */
export function isSameCreditNoteIntent(a: CreditNoteIntent, b: CreditNoteIntent): boolean {
  return creditNoteIntentPreimage(a) === creditNoteIntentPreimage(b);
}

/**
 * What a replay of `creditNoteId` must answer — the refund's verdict, for the
 * other command.
 *
 * `replay` is the stored result, 200, `replayed: true`, nothing written.
 * `conflict` is 409 `credit_note.idempotency_conflict` and never an acceptance.
 * There is no third answer: a key whose intent cannot be compared is a conflict,
 * not a fresh command. "An idempotency key is not permission."
 */
export function creditNoteReplayVerdict(stored: CreditNoteIntent | null, incoming: CreditNoteIntent): 'fresh' | 'replay' | 'conflict' {
  if (stored === null) return 'fresh';
  return isSameCreditNoteIntent(stored, incoming) ? 'replay' : 'conflict';
}

// ── 7b. The dates, and the instant they are compared against ───────────

/**
 * WHAT INSTANT `date_in_future` IS MEASURED AGAINST, stated once so no caller
 * has to guess and no implementation gets to decide.
 *
 * It is **the business's own current date in its own time zone**, supplied by
 * the caller as a `YYYY-MM-DD` string. It is NOT `new Date()` in this function,
 * NOT the database's `now()` read inside the command, and NOT UTC midnight.
 *
 * `[[daftar-a-command-must-not-read-the-clock]]`, and the reason is not purity:
 * a merchant in Amman posting at 01:00 local is at the PREVIOUS UTC day, so a
 * command that compared against UTC "today" would refuse a credit note dated
 * today as being in the future, for two hours every night. And a command that
 * reads the clock cannot be replayed: the same idempotency key, re-sent after
 * midnight, would answer differently from the same stored intent — which is law
 * 8 broken by a function nobody thought of as financial.
 *
 * So the instant is a PARAMETER. The request boundary resolves it once, from the
 * business's stored time zone, and every date comparison in the command uses
 * that one value. This is also why `refundIntentPreimage` carries `refundDate`
 * and not a timestamp: the intent is a claim about a DAY the caller named.
 */
export const RETURNS_DATE_COMPARISON_INSTANT = "the business's own current date in its own time zone, resolved once at the request boundary and passed in";

/** A `YYYY-MM-DD` SHAPE, which is necessary and NOT sufficient — see `isCalendarDate`. */
const CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** Days per month, January first. February's 28 is corrected for leap years below. */
const MONTH_LENGTHS: readonly number[] = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * A REAL calendar date in `YYYY-MM-DD`, not merely a string of the right shape.
 *
 * The shape test alone was the whole check until a suite was executed for the
 * first time and caught it: `/^\d{4}-\d{2}-\d{2}$/` accepts `2026-13-45`, and
 * the comment on `returnsDateRefusal` cited that exact string as the input
 * `date_invalid` exists to catch. It did not catch it. Month 13 sorted after
 * every real month, so the nonsense date compared as a FUTURE date and the
 * merchant was told `date_in_future` — a refusal pointing at the wrong problem,
 * which is the defect the comment claimed had been fixed.
 *
 * So the range is checked, and then the month's own length, with February
 * corrected for the Gregorian leap rule. **No `Date` object**: the function
 * above promises there is none anywhere on this path, and a `Date` would
 * reintroduce a time zone into a comparison that is deliberately about a DAY.
 */
function isCalendarDate(d: unknown): d is string {
  if (typeof d !== 'string' || !CALENDAR_DATE.test(d)) return false;
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = month === 2 && leap ? 29 : (MONTH_LENGTHS[month - 1] as number);
  return day <= length;
}

/**
 * The two date laws of one S5 document, judged against a caller-supplied today.
 *
 * - a document dated after the business's today is refused (`date_in_future`);
 * - a document dated before the thing it derives from — the invoice for a credit
 *   note, the source for a refund — is refused (`date_before_invoice` /
 *   `date_before_source`).
 *
 * String comparison is exact for `YYYY-MM-DD` and introduces no time zone of its
 * own, which is the point: there is no `Date` object anywhere in this function,
 * so there is nothing to interpret.
 */
export function returnsDateRefusal(
  domain: 'credit_note' | 'customer_refund',
  documentDate: string,
  originDate: string,
  businessToday: string,
):
  | 'credit_note.date_in_future'
  | 'credit_note.date_before_invoice'
  | 'customer_refund.date_in_future'
  | 'customer_refund.date_before_source'
  | 'credit_note.date_invalid'
  | 'customer_refund.date_invalid'
  | null {
  for (const d of [documentDate, originDate, businessToday]) {
    // A malformed date is not a date comparison at all, and it is not an AMOUNT
    // problem either: an earlier draft returned `${domain}.amount_invalid`, so a
    // merchant who typed `2026-13-45` was told the amount was wrong and sent to
    // look at a field that was correct. The vocabulary now carries
    // `date_invalid` for exactly this, in both domains.
    //
    // `2026-13-45` is the comment's own example and it is now genuinely
    // refused, which it was not while this check was a SHAPE test: month 13
    // passed `\d{2}` and then sorted after every real month, so the nonsense
    // date was reported as `date_in_future`. `isCalendarDate` checks the range
    // and the month's length, so the example in this comment is a case the code
    // actually handles rather than one it was believed to handle.
    if (!isCalendarDate(d)) return `${domain}.date_invalid` as const;
  }
  if (documentDate > businessToday) return `${domain}.date_in_future` as const;
  if (documentDate < originDate) {
    return domain === 'credit_note' ? 'credit_note.date_before_invoice' : 'customer_refund.date_before_source';
  }
  return null;
}

// ── 8. The cap, derived — and never stored ──────────────────────────────

/**
 * A consumable source, as the cap question reads it. Both kinds have exactly
 * this shape, which is why one refund model serves both.
 *
 * `remainingMinor` is the source document's own stored remaining, read under
 * `FOR UPDATE`. It is NOT a second truth: it is the row's half of the P4-AL-14
 * remaining PAIR, the one thing `remaining_*` is explicitly permitted for
 * (`scripts/guards/no-authoritative-balance.ts`'s own note: "a credit note's
 * remaining pair is part of the source document, and it is what P4-AL-14 is
 * built on"), and its agreement with `original − Σ(exact stored consumer rows)`
 * is established at COMMIT by the chain verifier — not here, and not twice.
 */
export interface ConsumableSourceCap {
  readonly kind: RefundSourceKind;
  readonly originalMinor: bigint;
  /** The stored remaining, read under `FOR UPDATE` in the SAME transaction that will consume it. */
  readonly remainingMinor: bigint;
}

/**
 * The cap on a refund drawn on this source: its locked remaining, and nothing
 * else.
 *
 * There is no `refundedAmountMinor`, no `availableMinor` and no running total
 * anywhere in this slice. Those names are refused by `FORBIDDEN_REFUND_FIELD_NAMES`
 * and by G-3's `AP_BALANCE_COLUMN`, and the reason is the one P4-AL-22 gives:
 * "a direct SQL attacker simply declares a different level", so a cap that is a
 * stored number is a cap an attacker can rewrite, while a cap that is the
 * source's own remaining is a cap the source's own guard and COMMIT-time
 * verifier both defend.
 */
export function refundCapMinor(source: ConsumableSourceCap): bigint {
  return source.remainingMinor;
}

/**
 * The cap verdict for a requested consumption. Pure, and it takes the LOCKED
 * remaining as an argument so a caller cannot ask this question without having
 * taken the lock.
 *
 * `source_exhausted` and `amount_exceeds_source` are different codes because
 * they are different merchant situations: nothing is left at all, versus less is
 * left than you asked for. `amount_invalid` covers zero and negative — a refund
 * of nothing is not a refund.
 */
export function refundCapRefusal(
  source: ConsumableSourceCap,
  requestedMinor: bigint,
): Extract<ReturnsRefusalCode, 'customer_refund.amount_invalid' | 'customer_refund.source_exhausted' | 'customer_refund.amount_exceeds_source'> | null {
  if (requestedMinor <= 0n) return 'customer_refund.amount_invalid';
  if (source.remainingMinor <= 0n) return 'customer_refund.source_exhausted';
  if (requestedMinor > refundCapMinor(source)) return 'customer_refund.amount_exceeds_source';
  return null;
}

// ── 9. The structural zero, mirrored ────────────────────────────────────

/**
 * A credit note's tax element, judged.
 *
 * `OD-03` is OPEN and the owner's alone: S5 researches no rate, infers no
 * jurisdiction and closes no decision. What it owes is the STRUCTURAL ZERO,
 * because `od03Problems` (`tests/security/phase3-s8-grant-matrix.test.ts:174`)
 * reads every column matching `(^|_)tax(_|$)` on every relation in `public` and
 * there is no allowlist — "nothing is permitted by being named, only by being
 * structurally zero".
 *
 * So there are exactly two lawful designs and this function is the first of
 * them: if a credit note mirrors `invoices.tax_minor` at all it mirrors it as a
 * structural zero, through the SAME predicate the invoice uses. There is no
 * second spelling of zero.
 */
export function creditNoteTaxRefusal(taxMinor: string): Extract<ReturnsRefusalCode, 'credit_note.tax_policy_absent'> | null {
  return isStructuralZeroTax(taxMinor) ? null : 'credit_note.tax_policy_absent';
}

// ── 10. The COGS reversal's input must be EXACT ─────────────────────────

/**
 * The COGS a credit note reverses, as the only lawful input: the SUM OF THE
 * EXACT STORED INTEGERS the stock-movement authority wrote.
 *
 * `packages/accounting/src/sale-posting.ts:66-78` states the law this mirrors:
 * the one official identity is
 * `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`, never
 * `Σ(qty × avg)`, because an average cost is itself a rounded quotient
 * (`[[daftar-a-rounded-quotient-is-never-an-input]]`) and because recomputing
 * cannot reproduce the branch where a movement empties a stock key and takes its
 * stored valuation EXACTLY with no rounding at all.
 *
 * There is therefore deliberately NO `quantity` and NO `unitCost` argument
 * here. The shape makes the wrong computation unexpressible rather than
 * forbidden: a caller that has only a quantity and an average has nothing to
 * pass.
 */
export interface ReturnedMovementValue {
  readonly movementId: string;
  /** The movement's own stored `value_delta_base_minor`, exactly as the stock writer wrote it. */
  readonly valueDeltaBaseMinor: bigint;
}

/**
 * The COGS reversal amount, or the refusal.
 *
 * An inbound return movement has a POSITIVE `value_delta_base_minor` (stock came
 * back in), so the reversal debits `inventory` and credits `cogs` by their sum.
 * A zero or negative sum, or an empty list, is `cogs_not_exact`: it means the
 * caller did not supply the movements, and a COGS reversal computed from
 * nothing is the second truth this whole section exists to refuse.
 *
 * A repeated `movementId` is also `cogs_not_exact`. Summing one movement twice
 * is exactly how a plausible-looking double reversal arrives.
 */
export function creditNoteCogsReversalBaseMinor(
  movements: readonly ReturnedMovementValue[],
): { readonly ok: true; readonly baseMinor: bigint } | { readonly ok: false; readonly code: Extract<ReturnsRefusalCode, 'credit_note.cogs_not_exact'> } {
  if (movements.length === 0) return Object.freeze({ ok: false as const, code: 'credit_note.cogs_not_exact' as const });
  const seen = new Set<string>();
  let sum = 0n;
  for (const m of movements) {
    if (seen.has(m.movementId)) return Object.freeze({ ok: false as const, code: 'credit_note.cogs_not_exact' as const });
    seen.add(m.movementId);
    if (typeof m.valueDeltaBaseMinor !== 'bigint' || m.valueDeltaBaseMinor <= 0n) {
      return Object.freeze({ ok: false as const, code: 'credit_note.cogs_not_exact' as const });
    }
    sum += m.valueDeltaBaseMinor;
  }
  return Object.freeze({ ok: true as const, baseMinor: sum });
}
