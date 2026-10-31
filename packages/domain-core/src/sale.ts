/**
 * Phase 4 sale domain types and pure rules (P4-S2; lock P4-AL-16, P4-AL-18,
 * P4-AL-25, P4-AL-28, P4-AL-29, P4-AL-33, P4-AL-41, P4-AL-44, `OD-P4-05`
 * OPTION A).
 *
 * What this file is, and deliberately is not:
 *
 * - it is the SALE's lifecycle, its refusal vocabulary's domain half, the
 *   declared lock order the commit takes, and the pure bounds a request is
 *   judged against. **Nothing here computes money, a price, a discount, a
 *   total, a COGS figure or a quantity**;
 * - it holds **no cost of any kind**. The lock's §4 matrix makes COGS
 *   `journal_lines` on `5000` bound to the `sale` source, and names
 *   `sale_items.cogs_minor` as the forbidden second truth: the COGS input is
 *   `stock_movements.value_delta_base_minor`, written by the stock writer, and
 *   "a per-line cost needed before the movement is written is a transient in
 *   the routine, not a column". So no type here carries one;
 * - it holds **no stored total of anything derived**: no balance, no paid, no
 *   outstanding, no on-hand, no available and no reserved quantity
 *   (P4-AL-06);
 * - tax is **structurally zero** (P4-AL-44, OD-03 OPEN). There is no rate, no
 *   exemption, no registration number and no inclusive/exclusive rule here,
 *   and this file researches no jurisdiction's law. A non-zero tax is refused
 *   under one stable code, and the refusal is the whole of the vocabulary;
 * - there is **no oversell switch**. `OD-P4-05` is RULED OPTION A — no
 *   oversell for stock-tracked products, refused atomically, and the stock
 *   writer is not changed. There is no flag type here for a business to set,
 *   because a type for an unrepresentable setting is a hint that it could be
 *   set.
 */

// ── Lifecycle (P4-AL-33) ─────────────────────────────────────────────────

/**
 * `sales.status`. The lock's §10 table: `draft → confirmed → (returned_partial
 * | returned_full)`, and `confirmed → void`.
 *
 * `returned_partial`, `returned_full` and `void` are reachable only by the
 * return and void commands of P4-S5 and P4-S6. P4-S2 writes exactly one of
 * these values — `confirmed` — and the enumeration exists here so the later
 * slices are checked against a table rather than against a memory, and so the
 * absence of a transition is assertable.
 */
export const SALE_STATES = ['draft', 'confirmed', 'void', 'returned_partial', 'returned_full'] as const;
export type SaleState = (typeof SALE_STATES)[number];

/**
 * The enumerated transitions the database enforces. Two absences are as
 * load-bearing as the five presences:
 *
 * - **there is no path back to `draft`**, because P4-AL-46 corrects a
 *   commercial mistake with a new document and never by editing the old one;
 * - **there is no `confirmed → confirmed`**, because a second confirmation is
 *   either a replay (answered from the stored row by its `intent_sha256`,
 *   P4-AL-30) or a different command, and never a re-run.
 */
export const SALE_TRANSITIONS: readonly { readonly from: SaleState; readonly to: SaleState }[] = Object.freeze([
  Object.freeze({ from: 'draft' as const, to: 'confirmed' as const }),
  Object.freeze({ from: 'confirmed' as const, to: 'void' as const }),
  Object.freeze({ from: 'confirmed' as const, to: 'returned_partial' as const }),
  Object.freeze({ from: 'confirmed' as const, to: 'returned_full' as const }),
  Object.freeze({ from: 'returned_partial' as const, to: 'returned_full' as const }),
]);

/** Whether the enumerated table permits this transition. */
export function isSaleTransitionAllowed(from: SaleState, to: SaleState): boolean {
  return SALE_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * The state P4-S2's commit writes, and the only one it writes.
 *
 * A sale is INSERTED `confirmed`. It is not inserted `draft` and then updated:
 * the atomic sale law (P4-AL-16) is one transaction or no sale, so there is no
 * instant at which a `draft` sale exists for anything to observe or for a
 * second request to advance. The server-side POS basket that a merchant edits
 * before committing is `pos_cart_lines`, which is P4-S3's and is not a sale.
 */
export const SALE_COMMITTED_STATE: SaleState = 'confirmed';

// ── Settlement mode (a stored INPUT, not a derived truth) ────────────────

/**
 * How the sale's invoice is settled at the moment of commit. It is a fact the
 * MERCHANT STATES — the cashier knows whether the customer paid or is being
 * invoiced — so it is a stored input on the `sales` header and is part of the
 * signed intent. It is **not** a derived truth and it is **not** a settlement
 * state: `invoices.status` stays lifecycle-only (P4-AL-24) and
 * `invoice_settlement_state(...)` remains the only answer to "is it paid",
 * derived from the allocations and applied credit notes.
 *
 * - `credit` — the invoice is owed. The revenue entry is
 *   `Dr accounts_receivable / Cr sales_revenue`, and the sale REQUIRES a
 *   customer, because `0075`'s deferred `invoices_walkin_no_ar` constraint
 *   trigger refuses a receivable line behind a null `customer_id`
 *   (`0075:660-693`) — a physical refusal, not a convention.
 * - `cash` — the customer has paid. The revenue entry debits the **`cash`
 *   system account directly** and writes **no payment document**, because
 *   `payments`, `payment_allocations` and the settlement entry are P4-S4's and
 *   `P4-AL-86` forbids creating a later slice's relation here. A `cash` sale
 *   may be a walk-in, with a null customer and no credit term.
 *
 * **The `cash` arm is RECOMMENDED-PENDING the Tech Lead's word**
 * (docs/PHASE_4_S2_CONTRACT.md D-01). Its one honest cost is recorded there
 * rather than hidden: a cash sale's entry carries no allocation, so
 * `accounting_reversals.id = original_entry_id` gives it exactly one
 * whole-entry reversal — which is correct for a sale that is voided as a whole
 * and is the reason P4-AL-17 insists on one entry per ALLOCATION once
 * allocations exist. A P4-S4 cash sale that allocates a real payment is a
 * different journal shape, so this arm must not be reused for one.
 */
export const SALE_SETTLEMENT_MODES = ['credit', 'cash'] as const;
export type SaleSettlementMode = (typeof SALE_SETTLEMENT_MODES)[number];

/**
 * Whether this pair of stated facts is representable at all.
 *
 * A `credit` sale with no customer is not a sale with a missing field: it is a
 * receivable owed by nobody. The database refuses it twice — the
 * `sales_credit_customer_ck` row CHECK and `invoices_walkin_no_ar`'s deferred
 * trigger — and the request schema refuses it a third time, so the merchant
 * sees one sentence instead of a 500.
 */
export function isSaleSettlementRepresentable(mode: SaleSettlementMode, customerId: string | null): boolean {
  return mode === 'cash' || customerId !== null;
}

// ── Bounds a request is judged against ───────────────────────────────────

/**
 * Free-text bounds, in code points after trimming, as the database counts them
 * with `char_length`. They match the accepted `invoice_items.name_snapshot` and
 * `invoices.notes` bounds of `0075:344,256` exactly, because a sale line's
 * snapshot becomes the invoice line's snapshot in the same transaction and a
 * bound that differed by one would refuse at the second insert.
 */
export const SALE_TEXT_BOUNDS = Object.freeze({
  notes: Object.freeze({ min: 1, max: 1000 }),
  nameSnapshot: Object.freeze({ min: 1, max: 200 }),
});

/**
 * The most lines one sale may carry.
 *
 * It is the inventory package's `MAX_DOCUMENT_LINES`, not a new number: the
 * commit's `invctl/1` payload carries one repeat per line and the assertion's
 * preimage is built by the same bound on both sides, so a sale the payload
 * builder accepts and the routine's digest rejects is not expressible.
 */
export const MAX_SALE_LINES = 200;

/**
 * The money range every minor-unit column of the sale estate is held to:
 * `0 .. 10^18`, the accepted `invoices`/`invoice_items` range of `0075`.
 * Integer minor units throughout — never a Float, never a Double, never a
 * decimal string that arithmetic is done on.
 */
export const SALE_MINOR_LIMIT = 1_000_000_000_000_000_000n;

// ── The declared lock order (P4-AL-41) ───────────────────────────────────

/**
 * The domain rows a sale commit acquires, in the order it acquires them — the
 * sale's slice of the lock's §12 list, with the positions a sale does not
 * touch omitted rather than renumbered.
 *
 * `accounting_post_entry` is deliberately **absent**: it takes its own locks in
 * its own fixed internal order at each call, and a sale calls it twice (the
 * COGS entry, then the revenue/AR entry), so a linear order that named
 * `journal_entries` once could not describe the sale at all. The routine's own
 * order is asserted separately, once, against its body.
 *
 * `stock_levels` is acquired **inside** `inventory_apply_stock_movements`,
 * ascending by `(warehouse_id, variant_id)` whatever the payload order
 * (`0060:289-299`) — which is both position 5 of the declared order and the
 * mechanism that refuses the last-item race. The sale command does not lock a
 * level row itself; doing so would be a second lock on the writer's own key and
 * a second place for the order to be wrong.
 */
export const SALE_COMMIT_LOCK_ORDER: readonly string[] = Object.freeze([
  'businesses', // 1 — the scope row, shared
  'customers', // 2 — the customer whose receivable is affected
  'stock_levels', // 5 — ascending by (warehouse_id, variant_id), inside the stock writer
  'invoice_sequences', // 7 — last of the domain locks (P4-AL-32)
]);

// ── The tax boundary (P4-AL-44, OD-03 OPEN) ──────────────────────────────

/**
 * A sale's tax, as the request states it: integer minor units text, and the
 * only admitted value is an exact `'0'`.
 *
 * This is the whole of P4-S2's tax surface. It is a REQUIRED, signed input
 * rather than a default, for the reason P4-AL-30 gives about the clock: a value
 * the fingerprint covers and the server resolves is not idempotent. The day a
 * Country Pack enables non-zero tax, the field, the column, the journal line's
 * place and the fingerprint position already exist, and nothing is re-modelled.
 *
 * **No jurisdiction's tax law is researched, guessed or encoded here**
 * (P4-AL-45). Not the rate, not the inclusive/exclusive rule, not the
 * registration threshold, not an exemption, not recoverability and not the
 * legal invoice fields. OD-03 stays open.
 */
export const SALE_STRUCTURAL_ZERO_TAX_MINOR = '0' as const;

/** True only for the exact spelling of zero. `'0.00'`, `'-0'`, `'00'` and `''` are not integer minor units. */
export function isSaleTaxStructurallyZero(taxMinor: string): boolean {
  return taxMinor === SALE_STRUCTURAL_ZERO_TAX_MINOR;
}

// ── What the client may state, and what it may not (P4-AL-18) ────────────

/**
 * The fields a sale commit request carries, as NAMES, in request order.
 *
 * It exists as data so that two things can be asserted rather than reviewed:
 * that the request schema admits exactly these keys, and that none of the
 * forbidden names below is among them. P4-AL-18 is explicit that a
 * client-supplied total "is **ignored**, not validated — validation implies the
 * client's number could be adopted".
 */
export const SALE_COMMIT_REQUEST_FIELDS: readonly string[] = Object.freeze([
  'saleId',
  'settlementMode',
  'customerId',
  'warehouseId',
  'documentDate',
  'dueDate',
  'taxMinor',
  'notes',
  'lines',
]);

/** The per-line fields. A line states an identity, a quantity and a discount REQUEST. Nothing else. */
export const SALE_COMMIT_LINE_FIELDS: readonly string[] = Object.freeze(['lineId', 'productId', 'variantId', 'quantity', 'discountMinor']);

/**
 * Names that must never appear on a sale request, each because its presence —
 * not its value — is the defect. The server resolves every one of these.
 *
 * A caller that sends one meets an unknown-key refusal from the `.strict()`
 * schema before any service is reached, which is the only treatment P4-AL-18
 * permits: "a total, a unit price, a line total, a tax amount or a COGS figure
 * arriving from the client is ignored, not validated".
 */
export const SALE_FORBIDDEN_REQUEST_FIELDS: readonly string[] = Object.freeze([
  // Server-recomputed money (P4-AL-18).
  'unitPrice',
  'unitPriceMinor',
  'priceOverride',
  'overridePriceMinor',
  'grossMinor',
  'netMinor',
  'subtotalMinor',
  'totalMinor',
  'totalTxnMinor',
  'totalBaseMinor',
  'baseShareMinor',
  // Server-resolved cost and value (P4-AL-25): never an input, never a column.
  'cogsMinor',
  'unitCostMinor',
  'valueDeltaMinor',
  'averageCost',
  // Server-resolved FX (P4-AL-19, A-17): the snapshot is read from the registry.
  'currency',
  'currencyCode',
  'fxRate',
  'rate',
  'rateId',
  'rateSource',
  'rateTimestamp',
  // Server-resolved scope and authority (P4-AL-35, P4-AL-40).
  'branchId',
  'tenantId',
  'businessId',
  'actorUserId',
  'permission',
  // Server-resolved stock truth (P4-AL-05): there is no available or reserved quantity anywhere.
  'onHand',
  'availableQuantity',
  'reservedQuantity',
  // The idempotency anti-pattern (P4-AL-30): the document's own UUID is the key.
  'idempotencyKey',
  // Oversell (`OD-P4-05` OPTION A): unrepresentable, not refused.
  'allowOversell',
  'allowNegativeStock',
  'force',
  // The clock (`[[daftar-a-command-must-not-read-the-clock]]`): a date is supplied, never defaulted.
  'now',
  'timestamp',
  'issuedAt',
  // Derived settlement truth (P4-AL-06, P4-AL-24, P4-AL-26). `settlementMode`
  // is a STATED fact and is permitted; a settlement STATE, a paid total or an
  // outstanding total is derived and may not be stated, stored or sent.
  'paidMinor',
  'outstandingMinor',
  'settlementState',
  'invoiceStatus',
  'paymentId',
  'allocationId',
]);
