import { z } from 'zod';
import {
  CUSTOMER_TEXT_BOUNDS,
  MAX_AGING_BUCKETS,
  MAX_AGING_BUCKET_DAY,
  MAX_CUSTOMER_CONTACTS,
  MAX_SALE_LINES,
  NUMBERED_DOCUMENT_KINDS,
  SALE_SETTLEMENT_MODES,
  SALE_STRUCTURAL_ZERO_TAX_MINOR,
  SALE_TEXT_BOUNDS,
} from '@daftar/domain-core';

/**
 * The Phase 4 customer and invoice requests (P4-S1).
 *
 * Every schema is `.strict()`, exactly as the accepted P3-S4 schemas are
 * (`purchasing.schemas.ts:8-12`): a tenant, a business, an actor, a trace id, a
 * revision the server owns, a stored amount, a rate, a status, a balance or any
 * authority flag is refused as an unknown key. There is no `force`, no `skip*`
 * and no `bypass*` field anywhere.
 *
 * What is REFUSED HERE rather than later, because a field's mere presence is the
 * defect:
 *
 * - any money field on a customer request. A customer carries no balance, no
 *   amount due and no credit limit (P4-AL-06, `OD-P4-03` OPTION A), so
 *   `balanceMinor`, `amountDueMinor`, `creditLimitMinor` and their friends are
 *   unknown keys and the request is refused before the service is reached;
 * - any price-override field. `OD-P4-02` is RULED OPTION A, so `unitPrice`,
 *   `priceOverride` and `overridePriceMinor` are unknown keys on every schema
 *   in this file;
 * - any tax field. While sales tax is structurally zero (P4-AL-44, OD-03 open)
 *   there is no rate, no exemption, no threshold and no registration number to
 *   state, so a `taxRate` or `taxExempt` key is refused as unknown rather than
 *   validated to zero;
 * - any `idempotencyKey`. P4-AL-30: idempotency is the caller-supplied document
 *   UUID plus the stored `intent_sha256`, and `idempotency_key` "exists nowhere
 *   in the commercial schema".
 *
 * Ids are canonical LOWERCASE uuids, refused otherwise and never lower-cased
 * into acceptance: the intent digest binds the exact spelling.
 *
 * Every date is a REQUIRED input. No schema here has a default date and no
 * service behind one resolves a date from the server's clock
 * (`[[daftar-a-command-must-not-read-the-clock]]`, P4-AL-30): the same retry
 * sent either side of local midnight must be the same command forever.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** The largest revision a command may name: the `INTEGER` column's range. */
const MAX_REVISION = 2_147_483_647;
const revision = z.number().int().min(1).max(MAX_REVISION);

/**
 * `min..max` characters after trimming, counted in code points as the routine
 * counts them (`char_length`). The text is passed on as sent; the service trims
 * it once, and the digest binds the trimmed text.
 */
const text = (bounds: { readonly min: number; readonly max: number }) =>
  z.string().refine((v) => {
    const length = [...v.trim()].length;
    return length >= bounds.min && length <= bounds.max;
  }, `must be ${bounds.min}..${bounds.max} characters`);

const optionalText = (bounds: { readonly min: number; readonly max: number }) => text(bounds).nullish();

/** Address-shaped, judged as the accepted supplier email is (`purchasing.schemas.ts:100`). */
const email = text(CUSTOMER_TEXT_BOUNDS.email).refine((v) => /^[^\s@]+@[^\s@]+$/.test(v.trim()), 'must look like an email address');

/** `YYYY-MM-DD`, a real calendar date. Required wherever it appears. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

const limit = z
  .string()
  .regex(/^\d{1,2}$/, 'a limit is 1..50')
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(50));

/** 1..100 characters after trimming, holding no NUL (the P3-S7 `searchQueryParam` rule, L-2). */
const search = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(100)
      .refine((s) => !s.includes('\u0000'), 'a search holds no NUL character'),
  );

// ── Customers: commands ──────────────────────────────────────────────────

/** One contact of a customer. No role, no permission and no notification policy (Phase 4). */
const customerContact = z
  .object({
    contactId: uuid,
    name: text(CUSTOMER_TEXT_BOUNDS.contactName),
    phone: optionalText(CUSTOMER_TEXT_BOUNDS.phone),
    email: email.nullish(),
    notes: optionalText(CUSTOMER_TEXT_BOUNDS.contactNotes),
    isPrimary: z.boolean().optional(),
  })
  .strict();

/**
 * The editable customer fields. An update states the WHOLE customer: an omitted
 * optional field is cleared and a contact the statement does not name is
 * removed. Reachability (`phone` or `email` on each contact) and the
 * single-primary rule are the domain's judgement
 * (`validateCustomerStatement`), so their typed `customer.contact_*` codes
 * reach the client rather than a generic validation failure.
 */
const customerFields = {
  name: text(CUSTOMER_TEXT_BOUNDS.name),
  phone: optionalText(CUSTOMER_TEXT_BOUNDS.phone),
  email: email.nullish(),
  notes: optionalText(CUSTOMER_TEXT_BOUNDS.notes),
  contacts: z.array(customerContact).max(MAX_CUSTOMER_CONTACTS).optional(),
};

/** `POST /v1/customers`. The customer id is the client's idempotency key (P4-AL-30). */
export const CustomerCreateSchema = z
  .object({
    customerId: uuid,
    ...customerFields,
  })
  .strict();

/** `PUT /v1/customers/:customerId`. */
export const CustomerUpdateSchema = z
  .object({
    expectedRevision: revision,
    ...customerFields,
  })
  .strict();

/** `POST /v1/customers/:customerId/archive` and `/reactivate`. */
export const CustomerLifecycleSchema = z
  .object({
    expectedRevision: revision,
  })
  .strict();

export type CustomerCreateRequest = z.infer<typeof CustomerCreateSchema>;
export type CustomerUpdateRequest = z.infer<typeof CustomerUpdateSchema>;
export type CustomerLifecycleRequest = z.infer<typeof CustomerLifecycleSchema>;

// ── Customers: reads ─────────────────────────────────────────────────────

/** `GET /v1/customers`. Keyset only: there is no `offset` key, so a caller cannot ask for one. */
export const CustomerListQuerySchema = z
  .object({
    status: z.enum(['active', 'inactive']).optional(),
    search: search.optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict();

/**
 * The supplied aging boundaries: `"30,60,90"`. Ascending, 1..6 of them, each
 * 1..3650 days.
 *
 * They are a REQUIRED input because the lock decides no bucket policy
 * (`OD-P4-03` OPTION A says the aging is shown; it does not say in what
 * buckets), and the server may not invent a commercial policy nobody stated.
 * They are never stored: a materialised aging table is forbidden by the lock's
 * §4 matrix.
 */
const bucketDays = z
  .string()
  .regex(/^\d{1,4}(,\d{1,4}){0,5}$/, 'ascending day boundaries, e.g. 30,60,90')
  .transform((s) => s.split(',').map((d) => Number.parseInt(d, 10)))
  .pipe(
    z
      .array(z.number().int().min(1).max(MAX_AGING_BUCKET_DAY))
      .min(1)
      .max(MAX_AGING_BUCKETS)
      .refine((days) => days.every((d, i) => i === 0 || d > (days[i - 1] as number)), 'day boundaries are strictly ascending'),
  );

/** `GET /v1/customers/:customerId/receivable/aging`. Both inputs are required. */
export const CustomerAgingQuerySchema = z
  .object({
    asOf: civilDate,
    bucketDays,
  })
  .strict();

/** `GET /v1/customers/:customerId/open-invoices`. */
export const CustomerOpenInvoicesQuerySchema = z
  .object({
    asOf: civilDate,
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict();

export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;
export type CustomerAgingQuery = z.infer<typeof CustomerAgingQuerySchema>;
export type CustomerOpenInvoicesQuery = z.infer<typeof CustomerOpenInvoicesQuerySchema>;

// ── Invoices: reads ──────────────────────────────────────────────────────

/**
 * `GET /v1/invoices`. `status` is the LIFECYCLE filter (P4-AL-24): there is no
 * `paid` value to filter on, because settlement is derived and never a status.
 * A caller that wants unpaid invoices asks a customer's open-invoice read.
 */
export const InvoiceListQuerySchema = z
  .object({
    customerId: uuid.optional(),
    status: z.enum(['draft', 'open', 'void']).optional(),
    documentKind: z.enum(NUMBERED_DOCUMENT_KINDS).optional(),
    /** Inclusive `issueDate` range; both supplied or neither. */
    from: civilDate.optional(),
    to: civilDate.optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict()
  .refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'from and to come together', path: ['to'] })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: 'from is on or before to', path: ['from'] });

/** `GET /v1/document-sequences`. */
export const DocumentSequenceQuerySchema = z
  .object({
    documentKind: z.enum(NUMBERED_DOCUMENT_KINDS).optional(),
  })
  .strict();

export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>;
export type DocumentSequenceQuery = z.infer<typeof DocumentSequenceQuerySchema>;

// ── Sales: the atomic commit (P4-S2) ─────────────────────────────────────

/**
 * A positive quantity, exact at the product's unit precision, as a decimal
 * STRING — never a JSON number, which is an IEEE double.
 *
 * The precision itself is NOT judged here: it depends on the product's
 * `unit_decimals`, which is a read. What is judged is the SHAPE — at most four
 * fraction digits, because `NUMERIC(18,4)` is the ledger's quantity type and a
 * fifth digit could only ever be silently truncated. The exact-at-this-unit
 * test is `assertQuantityRepresentable` in the service, and the stock writer
 * re-checks it under the product's lock (`0060:257`).
 */
const saleQuantity = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/, 'a quantity is a decimal with at most four fraction digits')
  .refine((v) => Number.parseFloat(v) > 0, 'a sale quantity is positive');

/** Integer minor units, non-negative, as a decimal STRING. No sign, no decimal point, no leading zero. */
const minorUnits = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, 'an amount is a non-negative integer count of minor units');

/**
 * One line of a sale commit.
 *
 * `.strict()`, so every field of `SALE_FORBIDDEN_REQUEST_FIELDS` is an
 * unknown-key refusal before the service is reached. A client-supplied
 * `unitPrice`, `netMinor`, `cogsMinor` or `unitCostMinor` is not validated
 * against the server's figure: P4-AL-18 is explicit that validating one
 * "implies the client's number could be adopted".
 */
const saleCommitLine = z
  .object({
    lineId: uuid,
    productId: uuid,
    // The MERCHANT variant, or null for a product that has none. The hidden
    // base variant never leaves the server (P3-AL-52), so the stock key is
    // resolved from the product and is not a field a client can state.
    variantId: uuid.nullable(),
    quantity: saleQuantity,
    discountMinor: minorUnits,
  })
  .strict();

/**
 * `POST /v1/sales` — the atomic sale commit (P4-AL-16).
 *
 * Four properties of this schema are the contract, not decoration:
 *
 * 1. **`saleId` is the idempotency key** (P4-AL-30). There is no
 *    `idempotencyKey` field and no `Idempotency-Key` header on this route,
 *    because "a bare key proves a request was seen before and says nothing
 *    about WHICH request it was". The caller-supplied document UUID plus the
 *    stored `intent_sha256` is the mechanism, and the proof is read BEFORE any
 *    state (`[[daftar-registry-before-state]]`).
 * 2. **Both dates are REQUIRED and neither has a default.**
 *    `[[daftar-a-command-must-not-read-the-clock]]`: a financial command whose
 *    fingerprint covers a server-resolved date is not idempotent, so the same
 *    retry sent either side of local midnight must be the same command
 *    forever. `dueDate` is `.nullable()` and NOT `.optional()`: the caller
 *    states "no credit term" explicitly, so an omitted field can never be read
 *    as a term the server chose.
 * 3. **`taxMinor` is required and must be exactly `"0"`** (P4-AL-44, OD-03
 *    OPEN). It is a signed input rather than a default so that the day a
 *    Country Pack enables non-zero tax the fingerprint position already
 *    exists. No rate, no exemption, no threshold, no registration number and
 *    no jurisdiction's law appears here.
 * 4. **`settlementMode` is a STATED fact and a settlement STATE is not.**
 *    `credit` or `cash`, stored on the header and part of the signed intent,
 *    because the cashier knows which one happened. It is not
 *    `invoices.status` (lifecycle only, P4-AL-24) and it is not a paid or
 *    outstanding total (P4-AL-06): those stay derived.
 * 5. **There is no `branchId`, no `currency`, no total and no cost.** The
 *    server resolves the branch from the warehouse, the currency and the FX
 *    snapshot from the business and the registry, every price from the
 *    catalogue, every total from those, and the COGS from the stock writer's
 *    own stored integers.
 */
export const SaleCommitSchema = z
  .object({
    saleId: uuid,
    settlementMode: z.enum(SALE_SETTLEMENT_MODES),
    customerId: uuid.nullable(),
    warehouseId: uuid,
    documentDate: civilDate,
    dueDate: civilDate.nullable(),
    taxMinor: z.literal(SALE_STRUCTURAL_ZERO_TAX_MINOR),
    notes: text(SALE_TEXT_BOUNDS.notes).nullable(),
    lines: z.array(saleCommitLine).min(1).max(MAX_SALE_LINES),
  })
  .strict()
  // A receivable owed by nobody is not a sale with a missing field: `0075`'s
  // deferred `invoices_walkin_no_ar` trigger refuses a receivable line behind
  // a null customer physically, so the request is refused here and the
  // merchant sees one sentence rather than a 500.
  .refine((v) => v.settlementMode === 'cash' || v.customerId !== null, {
    message: 'a credit sale names the customer who owes it',
    path: ['customerId'],
  })
  // The `invoices_walkin_terms_ck` mirror (`0075:316`): a due date with nobody
  // to owe it is what a receivable behind a null customer looks like on the
  // way in.
  .refine((v) => v.dueDate === null || (v.settlementMode === 'credit' && v.customerId !== null), {
    message: 'a due date belongs to a credit sale with a named customer',
    path: ['dueDate'],
  })
  .refine((v) => v.dueDate === null || v.dueDate >= v.documentDate, { message: 'a due date is on or after the document date', path: ['dueDate'] })
  .refine((v) => new Set(v.lines.map((l) => l.lineId)).size === v.lines.length, { message: 'each line carries its own id', path: ['lines'] })
  .refine((v) => new Set(v.lines.map((l) => `${l.productId}:${l.variantId ?? ''}`)).size === v.lines.length, {
    message: 'a sale has one line per variant',
    path: ['lines'],
  });

export type SaleCommitRequest = z.infer<typeof SaleCommitSchema>;
