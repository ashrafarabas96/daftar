import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { purchasingRefusal } from './purchasing-errors';

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

export type SupplierCreateRequest = z.infer<typeof SupplierCreateSchema>;
export type SupplierUpdateRequest = z.infer<typeof SupplierUpdateSchema>;
export type SupplierLifecycleRequest = z.infer<typeof SupplierLifecycleSchema>;
export type PurchaseDraftRequest = z.infer<typeof PurchaseDraftSchema>;
export type PurchaseTransitionRequest = z.infer<typeof PurchaseTransitionSchema>;
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>;
export type PurchaseListQuery = z.infer<typeof PurchaseListQuerySchema>;
