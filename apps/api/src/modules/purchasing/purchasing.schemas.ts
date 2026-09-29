import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { classifiedRefusal, purchasingRefusal } from './purchasing-errors';

/**
 * The P3-S4 supplier and purchase requests (PHASE_3_S4_CONTRACT A-11, A-12, A-19).
 *
 * Every schema is `.strict()`, as in P3-S3 (`inventory-movements.schemas.ts`):
 * tenant, business, actor, a trace id, a revision the server owns, a stored
 * amount, a rate, a status or any authority flag is refused as an unknown key
 * (mass-assignment defence, §94). There is no `force`/`skip*` field.
 *
 * Quantities, prices and money are exact decimal STRINGS, never JSON numbers,
 * and nothing is rounded or rescaled here: text that does not fit is refused,
 * and the service parses the exact digits. Prices and money are MAJOR units of
 * the purchase currency. Whether an amount is exact at that currency's minor
 * units depends on the currency registry, so it is judged by the service
 * (`purchase.amount_precision_invalid`), not here: the grammar below admits up
 * to ten fraction digits precisely so that the typed code, not a generic
 * validation failure, reaches the client.
 *
 * Ids are canonical LOWERCASE UUIDs, refused otherwise and never lower-cased
 * into acceptance: the `invpl/1` payload signs the exact spelling.
 *
 * What is deliberately NOT judged here, so its typed code reaches the client
 * from the service or the routine: a registered currency
 * (`purchase.currency_unknown`), a repeated variant (`purchase.duplicate_variant`,
 * known only after variant resolution), a discount above the line gross
 * (`purchase.discount_invalid`), a manual allocation that names a line the
 * request does not have or leaves one out (`purchase.landed_cost_invalid`) or
 * that does not add up (`purchase.landed_cost_allocation_mismatch`), a zero
 * total (`purchase.total_zero`), and every state refusal.
 *
 * The one refusal that IS typed here is the tax boundary (A-12, BLOCKED BY
 * OD-03): `PurchaseDraftValidationPipe` refuses a non-zero `taxAmount` with
 * `purchase.tax_policy_absent` before the service — and so the minter — is
 * ever reached.
 */

/** Lines per purchase (A-19, S3 TL-8). */
export const MAX_PURCHASE_LINES = 200;
/** Landed costs per purchase (A-19). */
export const MAX_LANDED_COSTS = 10;
/** The largest revision a command may name: the `INTEGER` column's range. */
const MAX_REVISION = 2_147_483_647;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** At least one non-zero digit: the text is not a spelling of zero. */
const NON_ZERO_RE = /[1-9]/;

/** `NUMERIC(18,4)`: up to 14 integer digits and 4 fraction digits. */
const QUANTITY_RE = /^\d{1,14}(\.\d{1,4})?$/;
/** A unit price in major units, stored as `NUMERIC(28,10)` minor units: up to 18 integer digits and 10 fraction digits (A-19). */
const UNIT_PRICE_RE = /^\d{1,18}(\.\d{1,10})?$/;
/**
 * A money amount in major units. Fifteen integer digits keep every amount
 * inside `BIGINT` minor units for any registered currency (at most three minor
 * units); exactness at the currency's minor units is the service's judgement.
 */
const MONEY_RE = /^\d{1,15}(\.\d{1,10})?$/;

/** A purchased quantity: `> 0`. */
const positiveQuantity = z.string().regex(QUANTITY_RE, 'a quantity is a decimal string').regex(NON_ZERO_RE, 'a quantity must be greater than zero');
/** A unit price: `>= 0`. A zero price is a merchant statement; a zero total is refused later (`purchase.total_zero`). */
const unitPrice = z.string().regex(UNIT_PRICE_RE, 'a unit price is a decimal string');
/** A money amount: `>= 0`. */
const money = z.string().regex(MONEY_RE, 'an amount is a decimal string');
/** A money amount: `> 0`. */
const positiveMoney = money.regex(NON_ZERO_RE, 'an amount must be greater than zero');

/** A document revision named by the client. 0 means "create" where a command allows it. */
const revision = (min: 0 | 1) => z.number().int().min(min).max(MAX_REVISION);

/** `YYYY-MM-DD`, a real calendar date. Required: an entry date is never a server default. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

/** ISO 4217 in upper case (A-19). Whether it is registered is the service's judgement. */
const currency = z.string().regex(/^[A-Z]{3}$/, 'a currency is an upper-case ISO 4217 code');

/**
 * `min..max` characters after trimming, counted in code points as the routine
 * counts them (`char_length`). The text is passed on as sent; the service
 * trims it once, and the digest binds the trimmed text (A-09).
 */
const text = (min: number, max: number) =>
  z.string().refine((v) => {
    const length = [...v.trim()].length;
    return length >= min && length <= max;
  }, `must be ${min}..${max} characters`);

/** An optional text field: omitted and null both mean "none"; a string must satisfy `text`. */
const optionalText = (min: number, max: number) => text(min, max).nullish();

/** 3..254 characters after trimming and shaped like an address (A-11). */
const email = text(3, 254).refine((v) => /^[^\s@]+@[^\s@]+$/.test(v.trim()), 'must look like an email address');

// ── Suppliers ────────────────────────────────────────────────────────────

/** The editable supplier fields (A-11). Update is a full statement: an omitted optional field is cleared. */
const supplierFields = {
  name: text(1, 200),
  phone: optionalText(1, 40),
  email: email.nullish(),
  taxIdentifier: optionalText(1, 64),
  notes: optionalText(1, 1000),
};

/** `POST /v1/suppliers`. The supplier id is the client's idempotency key (A-10(a)). */
export const SupplierCreateSchema = z
  .object({
    supplierId: uuid,
    ...supplierFields,
  })
  .strict();

/** `PUT /v1/suppliers/:supplierId`. */
export const SupplierUpdateSchema = z
  .object({
    expectedRevision: revision(1),
    ...supplierFields,
  })
  .strict();

/** `POST /v1/suppliers/:supplierId/archive` and `/reactivate`. */
export const SupplierLifecycleSchema = z
  .object({
    expectedRevision: revision(1),
  })
  .strict();

// ── Purchases ────────────────────────────────────────────────────────────

/** A purchase line (A-19, A-23): the stock identity, a quantity, a price and a per-line discount (TL-9). */
const purchaseLine = z
  .object({
    lineId: uuid,
    productId: uuid,
    variantId: uuid.nullish(),
    quantity: positiveQuantity,
    unitPrice,
    discount: money.nullish(),
  })
  .strict();

/** A landed cost (A-13 step 3). No tax or duty kind exists (BLOCKED BY OD-03). */
const landedCostCommon = {
  landedCostId: uuid,
  amount: positiveMoney,
  description: optionalText(1, 200),
};

const landedCost = z.discriminatedUnion('mode', [
  // Spread over the lines by net value; the server computes every share.
  z.object({ ...landedCostCommon, mode: z.literal('by_value') }).strict(),
  // Every share named by the merchant, each >= 0, adding up to `amount` exactly.
  z
    .object({
      ...landedCostCommon,
      mode: z.literal('manual'),
      allocations: z
        .array(z.object({ lineId: uuid, amount: money }).strict())
        .min(1)
        .max(MAX_PURCHASE_LINES),
    })
    .strict(),
]);

/**
 * `PUT /v1/purchases/:purchaseId`: create (`expectedRevision: 0`) or replace a
 * draft in full. `taxAmount` is bound so the day OD-03 closes it is already a
 * signed input; until then only a spelling of zero passes the pipe below.
 */
export const PurchaseDraftSchema = z
  .object({
    expectedRevision: revision(0),
    supplierId: uuid,
    warehouseId: uuid,
    currency,
    documentDate: civilDate,
    supplierReference: optionalText(1, 200),
    notes: optionalText(1, 1000),
    taxAmount: money.default('0'),
    lines: z.array(purchaseLine).min(1).max(MAX_PURCHASE_LINES),
    landedCosts: z.array(landedCost).max(MAX_LANDED_COSTS).default([]),
  })
  .strict();

/** `POST /v1/purchases/:purchaseId/receive` and `/cancel`: the draft revision the client read. */
export const PurchaseTransitionSchema = z
  .object({
    draftRevision: revision(1),
  })
  .strict();

/**
 * The draft's body pipe: the strict schema, then the tax boundary (A-12).
 *
 * A non-zero `taxAmount` is refused with the typed `purchase.tax_policy_absent`
 * here, at the DTO, so no payload is built and no assertion is minted for it.
 * The routine and the column CHECK refuse it again behind this.
 */
@Injectable()
export class PurchaseDraftValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const draft = PurchaseDraftSchema.parse(value);
    if (NON_ZERO_RE.test(draft.taxAmount)) throw purchasingRefusal('purchase.tax_policy_absent');
    return draft;
  }
}

// ── Supplier returns and purchase reversal (P3-S5) ───────────────────────
//
// PHASE_3_S5_CONTRACT A-19. The same rules as above: strict objects, exact
// decimal strings, canonical lowercase ids, dates the client states (never a
// server default: "no clock in a fingerprinted command"). Neither request has
// an amount, a rate or a tax field: every stored amount is the server's (A-07,
// A-10), and a tax element is BLOCKED BY OD-03 (A-14), so `taxAmount` is
// refused as an unknown key like any other.
//
// Judged by the service or the routine, not here, so their typed codes reach
// the client: a date before the purchase or in the business's future (both
// need the business timezone), a purchase line of another purchase, the
// purchased and the stock bounds, and every state refusal.

/** A reason: at most 500 characters after trimming, counted as the routine counts them (`char_length`). */
const reasonText = z.string().refine((v) => [...v.trim()].length <= 500, 'a reason is at most 500 characters');

/** One return line: one purchase line and the quantity of it that leaves (A-12). */
const supplierReturnLine = z
  .object({
    lineId: uuid,
    purchaseLineId: uuid,
    quantity: positiveQuantity,
  })
  .strict();

/**
 * `POST /v1/purchases/:purchaseId/returns` (A-19). The return id is the
 * idempotency key (A-17); the warehouse is the one the goods leave, and the
 * only scope target (TL-5). The reason is optional.
 */
export const SupplierReturnSchema = z
  .object({
    returnId: uuid,
    warehouseId: uuid,
    documentDate: civilDate,
    reason: optionalText(1, 500),
    lines: z.array(supplierReturnLine).min(1).max(MAX_PURCHASE_LINES),
  })
  .strict();

/**
 * `POST /v1/purchases/:purchaseId/reversal` (A-19). The reason is REQUIRED
 * (`accounting_post_reversal` needs one); its absence is typed by the pipe
 * below, so it is admitted here as nullable text only to reach that check.
 */
const PurchaseReversalBodySchema = z
  .object({
    reversalDate: civilDate,
    reason: reasonText.nullish(),
  })
  .strict();

/** The reversal request after its pipe: the reason is present and not blank. */
export interface PurchaseReversalRequest {
  readonly reversalDate: string;
  readonly reason: string;
}

/**
 * The return's body pipe: the strict schema, then the one line rule the
 * request alone decides. A return line id, or a purchase line, named twice is
 * refused with `supplier_return.lines_invalid` (A-12: one line per purchase
 * line per return) before the service — and so the minter — is reached.
 */
@Injectable()
export class SupplierReturnValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const request = SupplierReturnSchema.parse(value);
    const lineIds = new Set(request.lines.map((l) => l.lineId));
    const purchaseLineIds = new Set(request.lines.map((l) => l.purchaseLineId));
    if (lineIds.size !== request.lines.length || purchaseLineIds.size !== request.lines.length) {
      throw classifiedRefusal('supplier_return.lines_invalid');
    }
    return request;
  }
}

/**
 * The reversal's body pipe: the strict schema, then the mandatory reason. An
 * omitted, null or blank reason is refused with the typed
 * `purchase_reversal.reason_required` (§3: 422) here, at the DTO, so no
 * payload is built and no assertion is minted for it. The routine refuses it
 * again behind this.
 */
@Injectable()
export class PurchaseReversalValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const body = PurchaseReversalBodySchema.parse(value);
    const reason = body.reason ?? '';
    if (reason.trim().length === 0) throw classifiedRefusal('purchase_reversal.reason_required');
    const request: PurchaseReversalRequest = { reversalDate: body.reversalDate, reason };
    return request;
  }
}

// ── Supplier settlement (P3-S6) ──────────────────────────────────────────
//
// PHASE_3_S6_CONTRACT A-07, A-10, A-18, A-19. The same rules as above, with
// one difference: every settlement amount is an integer string of MINOR
// units (`"12500"`), never major units and never a JSON number — the payload
// signs the minor units exactly, and the service parses them exactly. No
// request states a rate, a base amount, a release or FX: every one of them is
// the server's, bound before minting (A-15), so a stated one is an unknown key.
//
// Judged by the service or the routine, not here, so their typed codes reach
// the client: the dates against the purchase or the note and the business's
// "today", the outstanding AP and the remaining credit, a registered currency,
// the method's reference rule and every state refusal.

/** The value bound of every S6 amount (`BIGINT` 1..10^18, §0). */
const MAX_AMOUNT_MINOR = 10n ** 18n;

/** The grammar of an amount of minor units: a positive integer of at most 19 digits. */
const AMOUNT_MINOR_RE = /^[1-9]\d{0,18}$/;

/**
 * A positive integer amount of minor units, at most 10^18. The bound is
 * judged only on text the grammar admits: zod runs a refinement even after
 * the regex failed, and `BigInt` of a decimal such as `"0.01"` throws, which
 * answered 500 for a malformed amount (found by the corrective TD-16 suite).
 */
const amountMinor = z
  .string()
  .regex(AMOUNT_MINOR_RE, 'an amount is a positive integer of minor units')
  .refine((v) => !AMOUNT_MINOR_RE.test(v) || BigInt(v) <= MAX_AMOUNT_MINOR, 'an amount is at most 10^18 minor units');

/** A settlement reference: 1..100 characters after trimming, or none. */
const reference = optionalText(1, 100);

/** Allocations admitted by the grammar before the typed count rule (1..50) below: bounded so no body is unbounded. */
const MAX_ALLOCATIONS_PARSED = 100;
/** Allocations per payment (A-07). */
export const MAX_SUPPLIER_PAYMENT_ALLOCATIONS = 50;

const paymentAllocation = z
  .object({
    allocationId: uuid,
    purchaseId: uuid,
    paymentAmountMinor: amountMinor,
    purchaseAmountAppliedMinor: amountMinor,
  })
  .strict();

/** `POST /v1/supplier-payments` (A-07, A-18). The payment id is the idempotency key (A-16). */
export const SupplierPaymentSchema = z
  .object({
    paymentId: uuid,
    supplierId: uuid,
    paymentMethodId: uuid,
    currencyCode: currency,
    amountMinor,
    paymentDate: civilDate,
    reference,
    allocations: z.array(paymentAllocation).max(MAX_ALLOCATIONS_PARSED),
  })
  .strict();

/**
 * The payment's body pipe: the strict schema, then the allocation rules the
 * request alone decides (§2.6 step 5) — 1..50 allocations, distinct
 * allocation and purchase ids, and `Σ paymentAmountMinor = amountMinor`
 * (fully allocated, TL-3) — refused with `supplier_payment.allocations_invalid`
 * before the service, and so the minter, is reached.
 */
@Injectable()
export class SupplierPaymentValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const request = SupplierPaymentSchema.parse(value);
    const n = request.allocations.length;
    const sum = request.allocations.reduce((a, l) => a + BigInt(l.paymentAmountMinor), 0n);
    if (
      n === 0 ||
      n > MAX_SUPPLIER_PAYMENT_ALLOCATIONS ||
      new Set(request.allocations.map((l) => l.allocationId)).size !== n ||
      new Set(request.allocations.map((l) => l.purchaseId)).size !== n ||
      sum !== BigInt(request.amountMinor)
    ) {
      throw classifiedRefusal('supplier_payment.allocations_invalid');
    }
    return request;
  }
}

/** `POST /v1/supplier-credit-allocations` (A-10, A-18). The allocation id is the idempotency key. */
export const SupplierCreditAllocationSchema = z
  .object({
    allocationId: uuid,
    creditNoteId: uuid,
    purchaseId: uuid,
    allocationDate: civilDate,
    creditAmountMinor: amountMinor,
    purchaseAmountAppliedMinor: amountMinor,
  })
  .strict();

/** `POST /v1/supplier-refunds` (A-10, A-18). The refund id is the idempotency key. */
export const SupplierRefundSchema = z
  .object({
    refundId: uuid,
    creditNoteId: uuid,
    paymentMethodId: uuid,
    refundDate: civilDate,
    creditAmountMinor: amountMinor,
    receiptCurrencyCode: currency,
    receiptAmountMinor: amountMinor,
    reference,
  })
  .strict();

/**
 * `POST /v1/purchases/:purchaseId/receive-and-pay` (A-19): the S4 receive
 * body plus the payment half. There is no payment date: it is the purchase's
 * document date. An omitted applied amount equals `amountMinor`.
 */
export const ReceiveAndPaySchema = z
  .object({
    draftRevision: revision(1),
    payment: z
      .object({
        paymentId: uuid,
        allocationId: uuid,
        paymentMethodId: uuid,
        currencyCode: currency,
        amountMinor,
        purchaseAmountAppliedMinor: amountMinor.nullish(),
        reference,
      })
      .strict(),
  })
  .strict();

// ── The residue write-off (Phase 3 corrective, 0072 R-96) ────────────────

/**
 * `POST /v1/purchases/:purchaseId/residue-write-off`: the date, the residue
 * the client saw (the purchase's outstanding amount, integer minor units of
 * the purchase currency) and a REQUIRED reason. No base, rate or chain point
 * is stated: each is the server's. An absent reason is typed by the pipe
 * below, so it is admitted here as nullable text only to reach that check.
 */
const PurchaseResidueWriteOffBodySchema = z
  .object({
    writeOffDate: civilDate,
    residueAmountMinor: amountMinor,
    reason: reasonText.nullish(),
  })
  .strict();

/** The write-off request after its pipe: the reason is present and not blank. */
export interface PurchaseResidueWriteOffRequest {
  readonly writeOffDate: string;
  readonly residueAmountMinor: string;
  readonly reason: string;
}

/**
 * The write-off's body pipe: the strict schema, then the mandatory reason —
 * an omitted, null or blank reason is `purchase_residue.reason_required`
 * (422) here, before any payload is built or assertion minted. The routine
 * refuses it again behind this.
 */
@Injectable()
export class PurchaseResidueWriteOffValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const body = PurchaseResidueWriteOffBodySchema.parse(value);
    const reason = body.reason ?? '';
    if (reason.trim().length === 0) throw classifiedRefusal('purchase_residue.reason_required');
    const request: PurchaseResidueWriteOffRequest = { writeOffDate: body.writeOffDate, residueAmountMinor: body.residueAmountMinor, reason };
    return request;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────

/** `limit` 1..100 (default chosen by the read), as query text. */
const limit = z
  .string()
  .regex(/^\d{1,3}$/, 'a limit is 1..100')
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));
/** The opaque cursor a previous page returned. */
const cursor = z.string().min(1).max(512);

/** `GET /v1/suppliers`. */
export const SupplierListQuerySchema = z
  .object({
    limit: limit.optional(),
    cursor: cursor.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

/** `GET /v1/purchases`. An assigned-scope actor sees purchases of in-scope warehouses only (A-19). */
export const PurchaseListQuerySchema = z
  .object({
    limit: limit.optional(),
    cursor: cursor.optional(),
    status: z.enum(['draft', 'received', 'cancelled']).optional(),
    supplierId: uuid.optional(),
    warehouseId: uuid.optional(),
  })
  .strict();

/** `GET /v1/purchases/:purchaseId/returns`: the purchase's returns, newest first. */
export const SupplierReturnListQuerySchema = z
  .object({
    limit: limit.optional(),
    cursor: cursor.optional(),
  })
  .strict();

/** `GET /v1/suppliers/:supplierId/payments`: the supplier's payments, newest first (P3-S6 A-18). */
export const SupplierPaymentListQuerySchema = z
  .object({
    limit: limit.optional(),
    cursor: cursor.optional(),
  })
  .strict();

/** `GET /v1/suppliers/:supplierId/credit-notes`: the supplier's credit notes, newest first. */
export const SupplierCreditNoteListQuerySchema = z
  .object({
    limit: limit.optional(),
    cursor: cursor.optional(),
  })
  .strict();

export type SupplierCreateRequest = z.infer<typeof SupplierCreateSchema>;
export type SupplierUpdateRequest = z.infer<typeof SupplierUpdateSchema>;
export type SupplierLifecycleRequest = z.infer<typeof SupplierLifecycleSchema>;
export type PurchaseDraftRequest = z.infer<typeof PurchaseDraftSchema>;
export type PurchaseTransitionRequest = z.infer<typeof PurchaseTransitionSchema>;
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>;
export type PurchaseListQuery = z.infer<typeof PurchaseListQuerySchema>;
export type SupplierReturnRequest = z.infer<typeof SupplierReturnSchema>;
export type SupplierReturnListQuery = z.infer<typeof SupplierReturnListQuerySchema>;
export type SupplierCreditNoteListQuery = z.infer<typeof SupplierCreditNoteListQuerySchema>;
export type SupplierPaymentRequest = z.infer<typeof SupplierPaymentSchema>;
export type SupplierCreditAllocationRequest = z.infer<typeof SupplierCreditAllocationSchema>;
export type SupplierRefundRequest = z.infer<typeof SupplierRefundSchema>;
export type ReceiveAndPayRequest = z.infer<typeof ReceiveAndPaySchema>;
export type SupplierPaymentListQuery = z.infer<typeof SupplierPaymentListQuerySchema>;
