import { z } from 'zod';

/**
 * The P3-S3 movement commands' requests (PHASE_3_S3_CONTRACT A-21, A-23, A-24).
 *
 * Every schema is `.strict()`: tenant, business, actor, a trace id, a stored
 * value or any authority flag is refused as an unknown key (mass-assignment
 * defence, §94), and there is no `force`/`skip*` field.
 *
 * Quantities and costs are exact decimal STRINGS, never JSON numbers: the
 * boundary is where a number would become a double, and it never gets the
 * chance (the reasoning of `accounting-posting.adapter.ts:24-27`). The shapes
 * are the storage domains — a quantity is `NUMERIC(18,4)`, a cost
 * `NUMERIC(28,10)` — and nothing is ever rounded or rescaled here: text that
 * does not fit is refused, and the service parses the exact digits.
 *
 * Ids are canonical LOWERCASE UUIDs. They are refused otherwise, never
 * lower-cased into acceptance: the `invpl/1` payload signs the exact
 * spelling (P3-AL-55 §F).
 *
 * What is deliberately NOT judged here, so its typed `inventory.*` code
 * reaches the client from the service or the routine: a line naming no
 * `variantId` for a product that has merchant variants
 * (`inventory.variant_required`), a repeated line (`inventory.duplicate_line`,
 * known only after variant resolution), the same warehouse on both ends of a
 * transfer (`inventory.transfer_same_warehouse`), and every state refusal.
 */

/** Lines per document and counted lines per count request (A-24, TL-8). */
export const MAX_DOCUMENT_LINES = 200;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** At least one non-zero digit: the text is not a spelling of zero. */
const NON_ZERO_RE = /[1-9]/;

/** `NUMERIC(18,4)`: up to 14 integer digits and 4 fraction digits (A-21). */
const QUANTITY_RE = /^\d{1,14}(\.\d{1,4})?$/;
const SIGNED_QUANTITY_RE = /^-?\d{1,14}(\.\d{1,4})?$/;
/** `NUMERIC(28,10)` below 10^18: up to 18 integer digits and 10 fraction digits (A-21). */
const UNIT_COST_RE = /^\d{1,18}(\.\d{1,10})?$/;

/** A quantity that moves stock in the direction the command names: `> 0`. */
const positiveQuantity = z.string().regex(QUANTITY_RE, 'a quantity is a decimal string').regex(NON_ZERO_RE, 'a quantity must be greater than zero');
/** A counted quantity: `>= 0`. Counting nothing on a shelf is a count. */
const countedQuantity = z.string().regex(QUANTITY_RE, 'a quantity is a decimal string');
/** An adjustment's signed delta: a gain is positive, a loss negative, and zero is no adjustment. */
const signedQuantity = z.string().regex(SIGNED_QUANTITY_RE, 'a quantity is a signed decimal string').regex(NON_ZERO_RE, 'a quantity must not be zero');
/** A unit cost in base currency: `>= 0`; an explicit zero is a merchant statement (A-11). */
const unitCost = z.string().regex(UNIT_COST_RE, 'a unit cost is a decimal string');

/** `YYYY-MM-DD`, a real calendar date. Required on every posting command: an entry date is never a server default. */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

/**
 * 1..500 characters after trimming, counted in code points as the routine
 * counts them (`char_length`). The text is passed on as sent; the service
 * trims it once, and the digest binds the trimmed text (TL-4).
 */
const reason = z.string().refine((v) => {
  const length = [...v.trim()].length;
  return length >= 1 && length <= 500;
}, 'a reason is 1..500 characters');

/** A line's stock identity (A-23): the product, and a merchant variant only when the product has them. */
const identity = {
  productId: uuid,
  variantId: uuid.nullish(),
};

const lines = <T extends z.ZodTypeAny>(line: T) => z.array(line).min(1).max(MAX_DOCUMENT_LINES);

/** `POST /v1/inventory/transfers`. A transfer posts no journal, so it carries no date. */
export const TransferSchema = z
  .object({
    transferId: uuid,
    sourceWarehouseId: uuid,
    destinationWarehouseId: uuid,
    lines: lines(z.object({ ...identity, quantity: positiveQuantity }).strict()),
  })
  .strict();

/**
 * `POST /v1/inventory/adjustments` (A-12). `quantity` is SIGNED: a gain names
 * its `unitCost` (the service refuses a gain without one,
 * `inventory.unit_cost_required`); a loss is valued at the average.
 */
export const AdjustmentSchema = z
  .object({
    adjustmentId: uuid,
    warehouseId: uuid,
    occurredOn: civilDate,
    reason,
    lines: lines(z.object({ ...identity, quantity: signedQuantity, unitCost: unitCost.nullish() }).strict()),
  })
  .strict();

/** `POST /v1/inventory/damages` (A-12): each line states the POSITIVE magnitude written off, and never a cost. */
export const DamageSchema = z
  .object({
    adjustmentId: uuid,
    warehouseId: uuid,
    occurredOn: civilDate,
    reason,
    lines: lines(z.object({ ...identity, quantity: positiveQuantity }).strict()),
  })
  .strict();

/** `POST /v1/inventory/stocktakes`: opens a draft; the stocktake id is the idempotency key (A-10(g)). */
export const StocktakeOpenSchema = z
  .object({
    stocktakeId: uuid,
    warehouseId: uuid,
  })
  .strict();

/** `PUT /v1/inventory/stocktakes/:stocktakeId/counts`: an idempotent upsert of counted quantities (A-11). */
export const StocktakeCountSchema = z
  .object({
    lines: lines(z.object({ ...identity, quantity: countedQuantity }).strict()),
  })
  .strict();

/**
 * `POST /v1/inventory/stocktakes/:stocktakeId/finalize`. `unitCosts` states a
 * cost only for a positive variance on a key that never held valued stock
 * (A-11); whether a cost applies is current state, judged by the service.
 */
export const StocktakeFinalizeSchema = z
  .object({
    occurredOn: civilDate,
    unitCosts: z
      .array(z.object({ ...identity, unitCost }).strict())
      .max(MAX_DOCUMENT_LINES)
      .nullish(),
  })
  .strict();

/** `POST /v1/inventory/stocktakes/:stocktakeId/cancel` takes no fields; a body, if sent, must be empty. */
export const StocktakeCancelSchema = z.object({}).strict().optional();

/** `POST /v1/inventory/openings` (A-13): one document over every warehouse it names. */
export const OpeningSchema = z
  .object({
    openingId: uuid,
    occurredOn: civilDate,
    lines: lines(z.object({ ...identity, warehouseId: uuid, quantity: positiveQuantity, unitCost }).strict()),
  })
  .strict();

export type TransferRequest = z.infer<typeof TransferSchema>;
export type AdjustmentRequest = z.infer<typeof AdjustmentSchema>;
export type DamageRequest = z.infer<typeof DamageSchema>;
export type StocktakeOpenRequest = z.infer<typeof StocktakeOpenSchema>;
export type StocktakeCountRequest = z.infer<typeof StocktakeCountSchema>;
export type StocktakeFinalizeRequest = z.infer<typeof StocktakeFinalizeSchema>;
export type OpeningRequest = z.infer<typeof OpeningSchema>;
