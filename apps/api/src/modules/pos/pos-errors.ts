import type { AppError } from '@daftar/domain-core';
import { isSellingCode, parseDatabaseSellingCode, rethrowSellingRefusal, sellingRefusal, SELLING_CODES, type SellingCode } from '../selling/selling-errors';

/**
 * THE POS TILL-SESSION REFUSAL SURFACE (P4-S3).
 *
 * **This module registers nothing.** There is exactly ONE Phase 4 refusal
 * registry — `SELLING_STATUS` in `apps/api/src/modules/selling/selling-errors.ts`
 * — and the `pos.*` codes are in it, beside `sale.*` and `invoice.*`, with
 * their statuses. A second status table here would be a second answer to
 * "what HTTP status does `pos.session_not_owned` have", and the error filter
 * reads the first one. The filter therefore needed no edit at all: it already
 * recognizes a `P0001` whose message carries a registered public selling code
 * and renders it through `sellingRefusal`, and `pos` joined that recognizer's
 * PUBLIC prefix set in the same commit that registered the codes.
 *
 * What this module adds is the NARROWING. `SellingCode` is the whole Phase 4
 * merchant vocabulary; `PosCode` is the `pos.`-prefixed part of it, extracted
 * from the registry rather than written out, so:
 *
 *   - a POS service names a POS code and cannot reach for `sale.total_zero`
 *     by accident — the compiler refuses it;
 *   - `POS_CODES` is derived, so a code added to the registry is covered by
 *     this module by existing, and a code removed from the registry stops
 *     compiling here rather than becoming a string nobody renders;
 *   - the three things the law must check — every registered `pos.*` code has
 *     a status, every `pos.*` code the DDL raises is registered, and the
 *     INTERNAL `selling.*` vocabulary is still absent from the public
 *     recognizer — all read the same derived list.
 *
 * `OD-P4-09`'s refusal is `pos.session_not_owned` (403) and it is **not**
 * `pos.session_not_found` (404). The distinction is recorded at the registry
 * entries themselves: 404 is the isolation answer about a session in another
 * tenant or another business, which must be indistinguishable from a session
 * that was never opened; 403 is the ruling's answer about a colleague's till
 * in the caller's own business, which is visible and still refused.
 */
export type PosCode = Extract<SellingCode, `pos.${string}`>;

/** True iff `code` is a registered POS refusal code. */
export function isPosCode(code: string): code is PosCode {
  return isSellingCode(code) && code.startsWith('pos.');
}

/**
 * Every registered POS code, in registry order — DERIVED from the canonical
 * registry, never listed, so this module cannot disagree with it.
 */
export const POS_CODES: readonly PosCode[] = SELLING_CODES.filter(isPosCode);

/**
 * A POS refusal as its API error, through `sellingRefusal` — the one selling
 * mapping. There is no second `switch` on status here: a code whose
 * registered status is wrong is fixed in the registry, which is the single
 * place a reviewer has to read.
 */
export function posRefusal(code: PosCode, extra: Readonly<Record<string, unknown>> = {}): AppError {
  return sellingRefusal(code, extra);
}

/**
 * The `pos.*` code a database refusal carries, or null.
 *
 * It is `parseDatabaseSellingCode` narrowed, not a second regex: the
 * recognizer that the error filter uses and the recognizer a service uses
 * must be the same one, or a trigger refusal renders one way through the
 * service and another way through the filter.
 */
export function parseDatabasePosCode(error: unknown): PosCode | null {
  const code = parseDatabaseSellingCode(error);
  return code !== null && isPosCode(code) ? code : null;
}

/**
 * The catch of every till-session command. It is `rethrowSellingRefusal`
 * itself, re-exported under this module's name rather than reimplemented,
 * because the chain it walks is the one the slice is held to: a package
 * refusal, an `AppError`, an `AccountingError`, a `TransactionSeamError`, a
 * `customer.*` / `invoice.*` / `pos.*` / `sale.*` database refusal, an
 * `inventory.*` one, an `accounting.*` one raised at COMMIT — and anything
 * else re-thrown UNTOUCHED, because a failure answered as a business refusal
 * is a till the cashier thinks did not open.
 *
 * In particular it does **not** translate `selling.*`. An internal invariant
 * is not a merchant refusal and not an authorization denial: it falls through
 * to the filter's own internal half, which logs the invariant's name beside
 * the request id and answers 500 with no details.
 */
export const rethrowPosRefusal: (error: unknown) => never = rethrowSellingRefusal;
