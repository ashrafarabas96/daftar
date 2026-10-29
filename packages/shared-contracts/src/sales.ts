/**
 * The sale commit primitive — P4-S2 (lock P4-AL-16, P4-AL-18, P4-AL-25,
 * P4-AL-29, P4-AL-30, P4-AL-33, P4-AL-35, P4-AL-44, P4-AL-54; `OD-P4-02`
 * OPTION A; `OD-P4-05` OPTION A; `TL-P4-S1-R1`).
 *
 * **There is exactly one command here, and it is atomic.** `POST /v1/sales`
 * performs, in ONE database transaction (P4-AL-16): the `sales` row and its
 * items; the stock movements through `inventory_apply_stock_movements`, which
 * is NOT changed; the `stock_levels` update that routine performs; the
 * `stock_source_bridge_sale` rows; the COGS journal entry; the `invoices` row
 * and its items; the invoice number allocation; and the revenue/AR entry.
 * There is no `POST /v1/sales/:id/confirm`, no `POST /v1/invoices` and no
 * draft-then-post pair, because each of those IS the intermediate state the
 * law forbids, offered over HTTP.
 *
 * Conventions this file keeps, each for a stated reason:
 *
 * - **every money value is an integer count of minor units carried as a
 *   STRING.** `…TxnMinor` is the sale's own currency; `…BaseMinor` is the
 *   business's base currency. A JSON number is an IEEE double and cannot hold
 *   an LBP total exactly;
 * - **quantities are decimal strings** (`NUMERIC(18,4)`), exact at the
 *   product's unit precision, never JSON numbers;
 * - **the client states identities, quantities and a discount REQUEST, and
 *   nothing else** (P4-AL-18). There is no unit price, no line total, no
 *   subtotal, no total, no tax amount, no COGS figure, no currency, no FX
 *   rate, no branch and no stock figure on the request. Those are not
 *   validated against the server's — they are absent, because "validation
 *   implies the client's number could be adopted". `SALE_FORBIDDEN_REQUEST_FIELDS`
 *   in `@daftar/domain-core` is the enumerated list, and the request schema is
 *   `.strict()`, so one of them is an unknown-key refusal before any service
 *   runs;
 * - **no cost column, anywhere, at any grain.** The lock's §4 matrix names
 *   `sale_items.cogs_minor` as the forbidden second truth for COGS, whose
 *   source of truth is `journal_lines` on `5000` bound to the `sale` source and
 *   whose input is `stock_movements.value_delta_base_minor`. So no DTO here
 *   reports a per-line cost, and the response's COGS figure is the posted
 *   entry's, read back from the ledger — not a number the service remembered;
 * - **idempotency is the caller-supplied `saleId` plus the stored
 *   `intent_sha256`** (P4-AL-30). There is no `idempotencyKey` field and no
 *   `Idempotency-Key` header on this route: "a bare key proves a request was
 *   seen before and says nothing about WHICH request it was";
 * - **every date is a REQUIRED input.** No field here has a default and no
 *   layer behind it reads the clock —
 *   `[[daftar-a-command-must-not-read-the-clock]]`: the same retry sent either
 *   side of local midnight must be the same command forever, in the DTO, the
 *   schema, the service, the engine AND the trusted database command;
 * - **tax is structurally zero** (P4-AL-44, OD-03 OPEN). `taxMinor` is a
 *   required, signed input whose only admitted value is `"0"`; a non-zero value
 *   is refused with `sale.tax_policy_absent`. No rate, no exemption, no
 *   threshold, no registration number, no inclusive/exclusive rule, and no
 *   jurisdiction's law;
 * - **no response carries** a journal entry id, an account code, a journal
 *   line, a routine name, a GUC, a constraint name or the database's text after
 *   the colon (P4-AL-54).
 */

import type { AllocatedDocumentNumber, SaleSettlementMode, SaleState } from '@daftar/domain-core';

// ── The command ──────────────────────────────────────────────────────────

/**
 * One line of a sale commit. An identity, a quantity, and a discount REQUEST.
 *
 * `lineId` is the CLIENT's: it is the `source_line_id` of the stock movement,
 * the `id` of the `sale_items` row and the `source_line_id` of the bridge row,
 * so it is part of the signed intent and a replay carrying different line ids
 * is a different command. The server never mints it, because a server-minted
 * line id would make two identical requests two different commands.
 *
 * The identity is `productId` plus, ONLY for a product that has merchant
 * variants, `variantId` — the accepted P3 convention (`PurchaseLineDto`,
 * `shared-contracts/src/purchasing.ts:19-22`). The hidden base variant never
 * leaves the server (P3-AL-52), so a simple product's line states
 * `variantId: null` and the server resolves the stock key through
 * `resolveVariants`. A client-supplied base variant id is therefore
 * impossible, which is why the RESOLVED variant is outside the signed intent:
 * the intent must be computable from the request alone, before the catalogue
 * is read.
 *
 * `discountMinor` is a REQUEST, in the sale's currency, and it is granted only
 * under `sales.discount` (P4-AL-35, sensitive). A discount requested without
 * that permission is refused — never silently dropped to zero, because a
 * silently-zeroed discount charges the customer more than the cashier told
 * them. `OD-P4-02` is RULED OPTION A, so there is no price override: the
 * catalogue price is the price and a reduction is a discount.
 */
export interface SaleCommitLineDto {
  /** Canonical lowercase UUID, the client's. */
  lineId: string;
  /** Canonical lowercase UUID of the product. */
  productId: string;
  /** The merchant variant, or `null` for a product that has none. Never the base variant. */
  variantId: string | null;
  /** A positive decimal string, exact at the product's unit precision, e.g. `"2"` or `"1.5"`. */
  quantity: string;
  /** Integer minor units of the sale's currency, `>= 0`. `"0"` means no discount. */
  discountMinor: string;
}

/**
 * `POST /v1/sales` — the atomic sale commit.
 *
 * Requires `sales.create`, plus `receivables.view` for a credit sale
 * (P4-AL-35) and `sales.discount` when any line carries a non-zero discount.
 * The branch is the warehouse's home branch, resolved by the server; a member
 * without scope over it never reaches the service (P4-AL-40: the policy, not
 * the controller).
 */
export interface SaleCommitDto {
  /**
   * The sale's identity AND its idempotency key (P4-AL-30). A canonical
   * lowercase UUID the caller mints. A second request with this id and the
   * same `intent_sha256` is answered from the stored rows; with a DIFFERENT
   * intent it is refused `sale.idempotency_conflict` — and the proof is
   * consulted BEFORE any state is read (`[[daftar-registry-before-state]]`),
   * because a stale request replayed after a later transition whose handler
   * reads state first performs a second real change.
   */
  saleId: string;
  /**
   * How the sale is settled at the moment of commit — a fact the MERCHANT
   * STATES, stored on the header and part of the signed intent. `credit`
   * debits `accounts_receivable`; `cash` debits the `cash` system account
   * directly and writes no payment document, because `payments` and
   * `payment_allocations` are P4-S4's relations (`SALE_SETTLEMENT_MODES` in
   * `@daftar/domain-core` carries the whole reasoning, and the `cash` arm is
   * RECOMMENDED-PENDING the Tech Lead's word).
   *
   * It is not a settlement STATE: `invoices.status` stays lifecycle-only
   * (P4-AL-24) and whether an invoice is paid is derived through
   * `invoice_settlement_state(...)`, never read from this field.
   */
  settlementMode: SaleSettlementMode;
  /**
   * The customer. `null` is a WALK-IN, and it is admissible only for a `cash`
   * sale: a `credit` sale with no customer is a receivable owed by nobody, and
   * `0075`'s deferred `invoices_walkin_no_ar` trigger refuses a receivable
   * line behind a null `customer_id` physically (`0075:660-693`).
   */
  customerId: string | null;
  /** The warehouse the stock leaves. Its home branch is the sale's branch, resolved by the server. */
  warehouseId: string;
  /**
   * `YYYY-MM-DD`, the civil date of the sale in the business's timezone.
   * REQUIRED, and it is the `entry_date` of BOTH journal entries and the
   * invoice's `issue_date`. Never in the future (the `0058` rule). Never
   * defaulted from a clock, at any layer.
   */
  documentDate: string;
  /**
   * `YYYY-MM-DD`, when the receivable falls due; on or after `documentDate`.
   * `null` means no credit term. It is a commercial term the merchant states,
   * so the server invents none — and it is `nullable` rather than `optional`,
   * so "no term" is stated rather than inferred from an absent field.
   *
   * A non-null due date requires a `credit` sale with a customer, mirroring
   * `invoices_walkin_terms_ck CHECK (customer_id IS NOT NULL OR due_date IS
   * NULL)` (`0075:316`): a due date with nobody to owe it "is what a
   * receivable behind a null customer looks like on the way in".
   */
  dueDate: string | null;
  /**
   * Integer minor units. The only admitted value is `"0"` while P4-AL-44
   * holds. Required and signed rather than defaulted, so the day tax is
   * enabled the fingerprint position already exists.
   */
  taxMinor: string;
  /** 1..1000 characters after trimming, or null. */
  notes: string | null;
  /** 1..`MAX_SALE_LINES` lines, one per variant, in the order the merchant entered them. */
  lines: SaleCommitLineDto[];
}

// ── What it returns ──────────────────────────────────────────────────────

/**
 * One committed sale line, as the server computed it. Every money figure here
 * is the SERVER's; none of them was sent.
 *
 * There is no `cogsMinor` and no `unitCostMinor`: a per-line cost would be "a
 * second stored integer for the same money with a second writer and no
 * constraint tying them" (lock §4). The sale's COGS is one figure, on the
 * entry, reported once on the header below.
 */
export interface SaleLineDto {
  lineId: string;
  lineNo: number;
  productId: string;
  /** The merchant variant the line named, or null for a simple product (P3-AL-52). */
  variantId: string | null;
  /** The product name as it stood when the sale committed. A later rename does not rewrite history. */
  nameSnapshot: string;
  quantity: string;
  /** The catalogue price the SERVER resolved, in minor units of the sale's currency. */
  unitPriceTxnMinor: string;
  grossTxnMinor: string;
  discountTxnMinor: string;
  netTxnMinor: string;
  /** Always `"0"` while P4-AL-44 holds. */
  taxMinor: string;
  /** This line's exact integer share of the base total (`0043`'s per-line law). */
  baseShareMinor: string;
}

/**
 * What `POST /v1/sales` returns: the sale, the invoice it issued, and the two
 * facts that prove the atomic law held.
 *
 * `replayed` distinguishes new truth from an idempotent replay answered from
 * the stored rows. `false` means this call committed the sale.
 */
export interface SaleDto {
  saleId: string;
  status: SaleState;
  settlementMode: SaleSettlementMode;
  customerId: string | null;
  branchId: string;
  warehouseId: string;
  documentDate: string;
  /** ISO code of the sale's currency, resolved by the server from the catalogue and the business. */
  currencyCode: string;
  subtotalTxnMinor: string;
  discountTxnMinor: string;
  /** Always `"0"` while P4-AL-44 holds. */
  taxMinor: string;
  totalTxnMinor: string;
  totalBaseMinor: string;
  /**
   * The FX snapshot the sale is bound to, immutable from this moment
   * (P4-AL-10): a rate entered tomorrow never changes these figures, and no
   * reader recomputes them.
   */
  sourceToBaseRate: string;
  rateSource: 'base' | 'manual' | 'provider';
  /** RFC3339 UTC at second precision. */
  rateTimestamp: string;
  lines: SaleLineDto[];
  invoice: SaleInvoiceRefDto;
  /**
   * The COGS the sale posted, in base minor units: the SUM of the stored
   * `stock_movements.value_delta_base_minor` integers of this sale's
   * movements, read back from the ledger (P4-AL-25). It is NOT
   * `quantity x average_cost`: average cost is a derived rounded quotient and
   * re-multiplying it reintroduces the drift the stored delta already resolved
   * — `[[daftar-a-rounded-quotient-is-never-an-input]]`.
   *
   * `"0"` is a legitimate value: stock whose average cost is zero leaves the
   * shelf at no value, and no COGS entry is posted for it.
   */
  cogsBaseMinor: string;
  replayed: boolean;
}

/**
 * The invoice the sale issued, as a reference. The full invoice is read through
 * the P4-S1 invoice surface; this is what the POS needs to print a receipt
 * without a second round trip.
 *
 * It reports no `paid`, no `outstanding` and no settlement state: those are
 * derived through `invoice_outstanding(...)` and `invoice_settlement_state(...)`
 * at read time (P4-AL-24, P4-AL-26), and a freshly committed invoice's
 * settlement is a question for the invoice surface, not an answer the commit
 * caches.
 */
export interface SaleInvoiceRefDto {
  invoiceId: string;
  number: AllocatedDocumentNumber;
  issueDate: string;
  dueDate: string | null;
  status: 'open';
  totalTxnMinor: string;
  totalBaseMinor: string;
}
