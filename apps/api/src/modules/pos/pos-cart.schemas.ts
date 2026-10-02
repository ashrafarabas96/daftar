import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { MAX_CART_LINES } from './pos-cart-pricing';
import { posRefusal } from './pos-errors';
import { assertNoClientPriceAuthority, POS_CART_COMMAND_FIELDS, type PosCartCommand } from './pos-price-authority';

/**
 * The four cart commands of P4-S3, as request schemas — and the pipe that puts
 * the trust boundary IN FRONT of them.
 *
 * Every schema is `.strict()`, exactly as the accepted P4-S1/P4-S2 schemas are
 * (`selling.schemas.ts:17-21`). But `.strict()` is the SECOND line of defence
 * here and not the first: `CartCommandPipe` runs
 * `assertNoClientPriceAuthority` before `schema.parse`, so a forged total
 * leaves with `pos.cart_price_authority_refused` and its own 400 rather than a
 * generic `unrecognized_keys` issue that reads the same as a typo.
 *
 * Keeping both is deliberate. The scan is the law and the schema is the shape,
 * and if either were removed the other would still refuse the forged field —
 * which is what makes the boundary two independent statements of one rule
 * instead of one mechanism with a single point of failure. The guard suite
 * asserts both halves separately, so neither can be quietly deleted on the
 * grounds that the other covers it.
 *
 * Ids are canonical LOWERCASE uuids and are never lower-cased into
 * acceptance. Quantities and minor units are decimal STRINGS, never JSON
 * numbers, which are IEEE doubles.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/**
 * A positive quantity, exact at the SHAPE `NUMERIC(18,4)` admits. The
 * product's own `unit_decimals` is a read, so the exact-at-this-unit test
 * belongs in the service, under the product's lock — not here.
 */
const cartQuantity = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/, 'a quantity is a decimal with at most four fraction digits')
  .refine((v) => /[1-9]/.test(v), 'a cart quantity is positive');

/** Integer minor units, non-negative. No sign, no decimal point, no leading zero. */
const minorUnits = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, 'an amount is a non-negative integer count of minor units');

/**
 * `POST /v1/pos/till-sessions/:tillSessionId/cart-lines` — add a line.
 *
 * Three fields: a product, its MERCHANT variant (or null for a product that
 * has none — the hidden base variant never leaves the server, P3-AL-52), and a
 * quantity. No price, no total, no tax, no currency, no branch. The server
 * resolves every one of those.
 */
export const CartAddLineSchema = z.object({ productId: uuid, variantId: uuid.nullable(), quantity: cartQuantity }).strict();

/** `PATCH .../cart-lines/:cartLineId` — change a quantity. ONE field. */
export const CartChangeQuantitySchema = z.object({ quantity: cartQuantity }).strict();

/**
 * `DELETE .../cart-lines/:cartLineId` — remove a line. NO body at all.
 *
 * `.strict()` on an empty object, so a removal that smuggles a figure in its
 * body is refused like any other. A removal is the one cart command with
 * nothing to state, and a request that states something anyway is making a
 * claim nobody asked it for.
 */
export const CartRemoveLineSchema = z.object({}).strict();

/**
 * `POST .../cart-lines/:cartLineId/discount` — REQUEST a discount.
 *
 * `OD-P4-02` is RULED OPTION A: a discount is the ONLY thing a client may say
 * about price, it is an integer count of minor units, and it is a REQUEST —
 * the server decides whether this actor may make it (`sales.discount`,
 * SENSITIVE, P4-AL-35) and whether it fits inside the line's DERIVED gross.
 *
 * It is minor units and not a percentage on purpose: a percentage would make
 * the server round a figure the client chose, which is a second rounding grain
 * wearing a discount's clothes.
 */
export const CartRequestDiscountSchema = z.object({ discountMinor: minorUnits }).strict();

export type CartAddLineRequest = z.infer<typeof CartAddLineSchema>;
export type CartChangeQuantityRequest = z.infer<typeof CartChangeQuantitySchema>;
export type CartRemoveLineRequest = z.infer<typeof CartRemoveLineSchema>;
export type CartRequestDiscountRequest = z.infer<typeof CartRequestDiscountSchema>;

/** Each command's schema, beside its accepted-key row. The guard asserts the two agree. */
export const POS_CART_SCHEMAS: Readonly<Record<PosCartCommand, z.ZodType>> = Object.freeze({
  'cart.add_line': CartAddLineSchema,
  'cart.change_quantity': CartChangeQuantitySchema,
  'cart.remove_line': CartRemoveLineSchema,
  'cart.request_discount': CartRequestDiscountSchema,
});

/**
 * The boundary pipe: the authority scan, THEN the schema. One object, so the
 * ordering cannot be reconfigured wrongly at a decorator, and one `command`, so
 * the scan judges the body against the right accepted-key row.
 *
 * Like the accepted `ZodValidationPipe` it acts only on the request BODY and
 * passes every other handler parameter through untouched, so a custom
 * decorator such as `@Membership()` is not validated as if it were a payload.
 *
 * A body of `undefined` (a `DELETE` with no payload at all) is normalized to
 * `{}` so the empty-object schema judges it rather than erroring on a shape
 * Express never produced.
 */
@Injectable()
export class CartCommandPipe implements PipeTransform {
  constructor(private readonly command: PosCartCommand) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const body = value === undefined || value === null ? {} : value;
    // FIRST: the trust boundary. A forged total never reaches the schema, the
    // service or the database, so the refusal is the law's own and the value
    // is never parsed.
    assertNoClientPriceAuthority(this.command, body);
    // SECOND: the shape.
    return POS_CART_SCHEMAS[this.command].parse(body);
  }
}

/**
 * A removal states NOTHING, asserted in the handler as well as in the pipe.
 *
 * ## Why this exists, and it is not belt-and-braces
 *
 * The first run of `tests/security/pos-s3-trust-boundary.test.ts` found a REAL
 * hole here. `@UsePipes` runs per handler PARAMETER, so a handler with no
 * `@Body()` parameter never presents a body to the pipe at all — and the
 * `DELETE` route had none, because a removal has nothing to read. A forged
 * `cartTotalMinor` sent to it was therefore SILENTLY IGNORED: 200, nothing
 * changed, nothing said. «A field silently ignored is as wrong as a field
 * obeyed», and the fix is two halves:
 *
 *   1. the route DECLARES a body. `POS_CART_ROUTE_AUTHORITY`
 *      (`pos-cart-routes.ts`) carries `body: true` on every row, including
 *      the removal, and the guard suite asserts it — so the mount the
 *      coordinator performs cannot omit the `@Body()` parameter and still
 *      match the handed-over table;
 *   2. the handler calls this function, so the claim survives somebody
 *      removing the parameter's decorator in a later tidy-up — the body is
 *      judged by code and not only by a decorator's presence.
 */
export function assertRemovalStatesNothing(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object') throw posRefusal('pos.cart_field_unknown');
  const stated = Object.keys(body);
  if (stated.length > 0) {
    // The scan in the pipe has already classified a forged name and refused it
    // with the authority code; anything reaching here is a body on a command
    // that accepts none.
    assertNoClientPriceAuthority('cart.remove_line', body);
    throw posRefusal('pos.cart_field_unknown', { field: stated[0] });
  }
}

/**
 * A path parameter, judged as strictly as a body field.
 *
 * A uuid that is not canonical lowercase is REFUSED and never normalized: the
 * cart's identifiers are compared as text in several places, and a path that
 * is accepted in two spellings is a line that can be addressed in two ways.
 *
 * Each refusal is the SAME code the identifier's own absence produces, so a
 * malformed id and an id nothing answers to are indistinguishable: a session
 * path that answered differently for "not a uuid" than for "not yours" would
 * be an oracle for which session ids exist. `pos.session_not_found` is the
 * till-session surface's registered isolation answer and this module reuses
 * it rather than inventing a second code for a session fact.
 */
export function cartUuidParam(value: string, field: 'sessionId' | 'cartLineId'): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) {
    throw posRefusal(field === 'sessionId' ? 'pos.session_not_found' : 'pos.cart_line_not_found', { field });
  }
  return parsed.data;
}

/** The cap a cart command is held to, re-exported so the schema module and the pricing module state one number. */
export const CART_LINE_CAP = MAX_CART_LINES;

/** The accepted-key rows, re-exported beside the schemas so one import serves the guard suite. */
export { POS_CART_COMMAND_FIELDS };
