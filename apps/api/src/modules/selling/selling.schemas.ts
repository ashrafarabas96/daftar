import { z } from 'zod';
import { CUSTOMER_TEXT_BOUNDS, MAX_AGING_BUCKETS, MAX_AGING_BUCKET_DAY, MAX_CUSTOMER_CONTACTS, NUMBERED_DOCUMENT_KINDS } from '@daftar/domain-core';

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
