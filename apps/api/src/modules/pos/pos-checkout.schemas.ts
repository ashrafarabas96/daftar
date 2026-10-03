import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { SALE_SETTLEMENT_MODES, SALE_STRUCTURAL_ZERO_TAX_MINOR, SALE_TEXT_BOUNDS } from '@daftar/domain-core';
import { isPriceAuthorityField } from './pos-price-authority';
import { posRefusal } from './pos-errors';

/**
 * `POST /v1/pos/till-sessions/:sessionId/checkout` — THE REQUEST, AND WHAT IT
 * REFUSES TO BE ABLE TO SAY (TL-P4-S3-R1 CART SNAPSHOT LAW; P4-AL-18).
 *
 * The accepted keys are seven, and SIX of them are the sale's HEADER intent:
 * the document identity, the settlement mode, the customer, the two dates, the
 * structural zero tax and the note. The seventh thing the request says — WHICH
 * BASKET — is in the path, as a till session id.
 *
 * What is therefore INEXPRESSIBLE, not merely validated away:
 *
 *   - `lines`. A body carrying a basket is the client-side cart P4-AL-18
 *     forbids — "the forged-totals attack of §12 with no attacker required".
 *     The server reads `pos_cart_lines` under the checkout's own transaction;
 *   - `warehouseId`, `branchId`, `currency`. All three are the SESSION's, read
 *     from `pos_till_sessions`. A client-stated warehouse would be a client
 *     choosing which shelf the stock leaves;
 *   - every price, total, subtotal, discount, tax amount, cost and rate. There
 *     is no field for any of them and the scan below refuses one by NAME.
 *
 * ## Two layers, and they refuse different things
 *
 * `assertNoClientCheckoutAuthority` runs FIRST and judges the raw body: a key
 * the schema would merely call "unrecognized" is reported as what it IS when
 * it is a figure the server derives — `pos.checkout_price_authority_refused`,
 * carrying the NAME and the PATH and never the value, because a `details`
 * echoing the client's figure beside the server's is a calibration oracle.
 * Then `.strict()` refuses everything else.
 *
 * The order matters: `.strict()` alone would answer a forged `cartTotalMinor`
 * with a generic shape complaint, and the till's cashier (and the next author)
 * would read it as a typo rather than as the law doing its job.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** `YYYY-MM-DD`, a real calendar date. Required: a command must not read the clock. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

const notes = z.string().refine((v) => {
  const length = [...v.trim()].length;
  return length >= SALE_TEXT_BOUNDS.notes.min && length <= SALE_TEXT_BOUNDS.notes.max;
}, `must be ${SALE_TEXT_BOUNDS.notes.min}..${SALE_TEXT_BOUNDS.notes.max} characters`);

/** The accepted keys, as DATA — so the guard below and the schema cannot disagree about what a checkout may state. */
export const POS_CHECKOUT_FIELDS: readonly string[] = Object.freeze(['saleId', 'settlementMode', 'customerId', 'documentDate', 'dueDate', 'taxMinor', 'notes']);

export const PosCheckoutSchema = z
  .object({
    saleId: uuid,
    settlementMode: z.enum(SALE_SETTLEMENT_MODES),
    customerId: uuid.nullable(),
    documentDate: civilDate,
    dueDate: civilDate.nullable(),
    taxMinor: z.literal(SALE_STRUCTURAL_ZERO_TAX_MINOR),
    notes: notes.nullable(),
  })
  .strict()
  // `invoices_walkin_no_ar` (`0075:660`) makes a receivable behind a null
  // customer unpostable, so a walk-in credit sale is refused on the way in and
  // the cashier reads one sentence instead of a 500.
  .refine((v) => v.settlementMode === 'cash' || v.customerId !== null, {
    message: 'a credit sale names the customer who owes it',
    path: ['customerId'],
  })
  .refine((v) => v.dueDate === null || (v.settlementMode === 'credit' && v.customerId !== null), {
    message: 'a due date belongs to a credit sale with a named customer',
    path: ['dueDate'],
  })
  .refine((v) => v.dueDate === null || v.dueDate >= v.documentDate, { message: 'a due date is on or after the document date', path: ['dueDate'] });

export type PosCheckoutRequest = z.infer<typeof PosCheckoutSchema>;

/** A body deeper than any checkout request has is not a checkout request. */
const MAX_BODY_DEPTH = 3;

/**
 * THE TRUST BOUNDARY OF THE CHECKOUT, run before the schema.
 *
 * Every key that is not one of `POS_CHECKOUT_FIELDS` at the top level, and
 * EVERY key at any depth below it, is refused — as
 * `pos.checkout_price_authority_refused` when the name is a figure the server
 * derives (`isPriceAuthorityField`, the cart's own structural test: `total`,
 * `price`, `subtotal`, `amount`, `cost`, `rate`, `tax`, …) and as
 * `pos.cart_field_unknown` otherwise.
 *
 * `lines` is caught by the first arm through the pattern table, which is the
 * point of judging by name: a basket posted to the checkout is a price claim
 * even when it carries no number, because every number would then be derived
 * from a line set the client chose.
 */
export function assertNoClientCheckoutAuthority(body: unknown): void {
  walk(body, 0, []);
}

function walk(node: unknown, depth: number, path: readonly string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (depth > MAX_BODY_DEPTH) throw posRefusal('pos.cart_field_unknown', { path: path.join('.') });
  if (Array.isArray(node)) {
    // An ARRAY anywhere in a checkout body is a basket by another name: no
    // accepted field is a list.
    throw posRefusal('pos.checkout_price_authority_refused', { field: path[path.length - 1] ?? '', path: path.join('.') });
  }
  for (const key of Object.keys(node)) {
    const where = [...path, key].join('.');
    if (!(depth === 0 && POS_CHECKOUT_FIELDS.includes(key))) {
      throw isPriceAuthorityField(key) || key === 'lines' || key === 'cart' || key === 'cartLines'
        ? posRefusal('pos.checkout_price_authority_refused', { field: key, path: where })
        : posRefusal('pos.cart_field_unknown', { field: key, path: where });
    }
    walk((node as Record<string, unknown>)[key], depth + 1, [...path, key]);
  }
}

/**
 * The boundary pipe: the authority scan, THEN the schema, as ONE object —
 * the `CartCommandPipe` shape, for the reason that file records. A handler
 * that lost the scan to a later tidy-up would answer a forged total `200`
 * with nothing changed and nothing said, which the slice's law is explicit is
 * as wrong as obeying it.
 */
export class PosCheckoutPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const body = value === undefined || value === null ? {} : value;
    // FIRST: the trust boundary. A forged total never reaches the schema, the
    // service or the database.
    assertNoClientCheckoutAuthority(body);
    // SECOND: the shape.
    return PosCheckoutSchema.parse(body);
  }
}
