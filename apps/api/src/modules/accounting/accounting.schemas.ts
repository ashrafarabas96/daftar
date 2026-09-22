import { z } from 'zod';

/**
 * The merchant-facing accounting payloads (§36).
 *
 * Every schema is `.strict()`: an unexpected field is refused rather than
 * ignored, so a client that believed it was setting something is told it was
 * not. Money and rates are strings with explicit shapes — the boundary is
 * where a JSON number would become a double, and it never gets the chance.
 */
const uuid = z.string().uuid();
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');
const minorAmount = z.string().regex(/^[1-9][0-9]{0,18}$/, 'minor units must be a positive integer string');
const currency = z.string().regex(/^[A-Z]{3}$/);
const rate = z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,10})?$/, 'a rate has at most ten fraction digits');
/** Second precision, UTC, ending Z. Sub-second is refused, never truncated (§24). */
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const memo = z.string().min(1).max(500).nullish();
const reason = z.string().trim().min(1).max(500);

const accountRef = z.union([
  z.object({ kind: z.literal('system'), systemKey: z.string().regex(/^[a-z0-9_]{1,64}$/) }).strict(),
  z.object({ kind: z.literal('code'), code: z.string().min(1).max(64) }).strict(),
]);

export const AccountingLineSchema = z
  .object({
    account: accountRef,
    side: z.enum(['D', 'C']),
    baseAmountMinor: minorAmount,
    baseCurrency: currency,
    txnAmountMinor: minorAmount,
    txnCurrency: currency,
    fxRate: rate,
    fxRateSource: z.enum(['base', 'manual', 'provider']),
    fxRateAt: instant,
    branchId: uuid.nullish(),
    warehouseId: uuid.nullish(),
    memo,
  })
  .strict();

export const AccountingAdjustmentCreateSchema = z
  .object({
    entryDate: civilDate,
    description: z.string().min(1).max(500).nullish(),
    reason,
    // Double-entry is not a formatting rule: an entry with fewer than two
    // lines is not a small entry, it is not an entry (AL-02).
    lines: z.array(AccountingLineSchema).min(2).max(500),
  })
  .strict();

// `civilDate`, not `civilDate.nullish()`: an omitted or null date is refused
// at the edge rather than resolved from the clock. See the note on
// AccountingReversalCreateDto — this is what makes the retry deterministic.
export const AccountingReversalCreateSchema = z
  .object({
    entryDate: civilDate,
    reason,
  })
  .strict();

export const AccountingOpeningPositionSchema = z
  .object({
    account: accountRef,
    side: z.enum(['D', 'C']),
    baseAmountMinor: minorAmount,
    baseCurrency: currency,
    txnAmountMinor: minorAmount,
    txnCurrency: currency,
    fxRate: rate,
    // No `provider`: there is no rate provider for a date that predates the
    // merchant's arrival, and pretending otherwise would put a fabricated
    // provenance on the most historical number in the system (§22).
    fxRateSource: z.enum(['base', 'manual']),
    fxRateAt: instant,
    memo,
  })
  .strict();

export const AccountingOpeningBalanceCreateSchema = z
  .object({
    asOfDate: civilDate,
    description: z.string().min(1).max(500).nullish(),
    positions: z.array(AccountingOpeningPositionSchema).min(1).max(500),
  })
  .strict();
