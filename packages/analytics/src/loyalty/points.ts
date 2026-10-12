/**
 * P13-S6 — THE LOYALTY POINT FOLDS.
 *
 * Pure integer folds over an append-only point ledger. This file holds no
 * clock, no database handle, no rate, and no money constant. Everything it
 * needs that a merchant could choose is an argument.
 *
 * WHAT THIS FILE IS AND IS NOT
 * ----------------------------
 * `P13-LOYALTY-DESIGN §1.5` puts the ONE definition of a point balance in SQL,
 * as `loyalty_points_as_of/3`, and gives the reason: *a figure with two
 * implementations has two answers*. This file is therefore NOT a second
 * definition of the balance and must never be presented as one. It is the
 * **fold these rows obey**, written here so that the fold's laws — the sign
 * law, the idempotency law, the oldest-horizon-first expiry order, the
 * at-most-the-balance expiry bound — are executable and testable with no
 * cluster. A read model that shows a balance still calls the SQL definition
 * and still owes the conservation test `§1.5` requires of it.
 *
 * THE TWO LAWS THIS FILE MAKES STRUCTURAL
 * ---------------------------------------
 * 1. **Points are not money.** A point has no currency, so no exponent, so
 *    "minor units" is not a question that can be asked of it (`§1.1`). There
 *    is no currency field, no exponent field and no rate field on a movement,
 *    and the absence of the field is the guarantee — a naming convention is
 *    not one. Points never post to a ledger: this file exposes no posting
 *    path, and `§2.2(a)` records that no loyalty source type exists for one
 *    to be bound to.
 *
 * 2. **Earning and consumption sit on OPPOSITE sides of the sale's
 *    transaction boundary** (`§2.2(d)`, `§5.5`), and that is expressed in the
 *    TYPES rather than in a comment:
 *
 *    - an EARN can only be built from a {@link SaleCommittedEvent}, whose
 *      `phase` is the literal `'after_sale_commit'`. The builder for it,
 *      {@link tryBuildPostSaleEarnMovement}, **has no throwing expression**:
 *      it returns a result either way, so there is no mechanism by which an
 *      earning defect could propagate into a caller's transaction. The sale
 *      has already committed (`§2.3`: *the sale stands*).
 *
 *    - a CONSUMPTION can only be built from a {@link SaleCommitInProgress},
 *      whose `phase` is the literal `'inside_sale_transaction'`. Its builder,
 *      {@link buildSaleConsumptionMovement}, **refuses by throwing**, because
 *      `§5.5.4` F-3 rules that under the atomic law a consumption that cannot
 *      be written must abort the sale: the customer is being granted a
 *      discount for those points.
 *
 *    The two phase markers are disjoint string literals, so `tsc` refuses an
 *    earn built from an in-flight sale and a consumption built from a
 *    committed one. Neither function can be reached from the other's side of
 *    the boundary.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * - It writes no migration, allocates no number, and names no relation into
 *   existence. `§5.5.2` Request 2 is the Migration Owner's, and the
 *   consumption movement kind arrives *with its writer or not at all*.
 * - It holds no default rate, no default horizon and no default rounding
 *   mode. `§5.6` / PART 124: a business with no configured conversion has no
 *   redemption capability and the refusal says so; a default rate is a
 *   hard-coded conversion with a longer code path.
 */

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ *
 * These codes belong in `src/errors.ts` beside `ANALYTICS_REFUSALS`, which is
 * not this slice's file to extend. They are declared here, in the slice that
 * raises them, and folding them into the package catalogue is a one-line
 * patch request to that file's owner. Every one is a REFUSAL and never a
 * degraded answer: there is no code here that returns a number with a caveat.
 */

import { AnalyticsRefusal, refuse, type AnalyticsRefusalCode } from '../errors';

/**
 * The loyalty refusals are NOT a catalogue of their own.
 *
 * They were, briefly: this module declared its own `LOYALTY_REFUSALS` map and
 * its own error class, because `src/errors.ts` carried no loyalty code. Two
 * refusal registries in one package is the same defect as two definitions of
 * one figure — a caller cannot tell which registry a code came from, and
 * nothing decides which status wins the day a code appears in both. The codes
 * now live in the single `ANALYTICS_REFUSALS` set and what follows are
 * narrowings of it, so the names this module's callers and tests already use
 * keep working while there is only one source of truth.
 */
export type LoyaltyRefusalCode = Extract<AnalyticsRefusalCode, `loyalty.${string}`>;

/** The one refusal class, under the name this module reads by. */
export const LoyaltyRefusal = AnalyticsRefusal;
export type LoyaltyRefusal = AnalyticsRefusal;

/** Refuse with a loyalty code. Narrowed so a non-loyalty code is a type error here. */
export function refuseLoyalty(
  code: LoyaltyRefusalCode,
  message: string,
  context?: Readonly<Record<string, string>>,
): never {
  refuse(code, message, context);
}

/* ------------------------------------------------------------------ *
 * The registries, as closed sets (§1.2)
 * ------------------------------------------------------------------ */

/**
 * The movement kinds.
 *
 * `§1.2` specifies a THREE-row `loyalty_movement_kinds` registry — `earn`,
 * `expire`, `adjust` — and `§5.1` records that a consumption kind is
 * deliberately absent from it, because `TL-P4-S1-R1` forbids a registry
 * concept without its writer.
 *
 * DISAGREEMENT RECORDED, NOT RESOLVED: this union carries a fourth member,
 * `'consume'`, because `§5.5.3` states the consumption idempotency key as
 * `(business_id, 'sale', <sale id>, <the consumption kind>)` and that key is
 * not expressible without naming the kind. A member of a TypeScript union is
 * not a registry row and not a migration: Phase 13 still writes neither, and
 * the kind becomes INSERTABLE only when the Migration Owner applies Request 2
 * of `§5.5.2` — the registry rows and the writer in one change. Until then
 * this member exists so that the fold can READ a ledger containing such rows
 * and so that the idempotency law can be proved. See {@link REGISTERED_KINDS}.
 */
export type LoyaltyMovementKind = 'earn' | 'expire' | 'adjust' | 'consume';

/**
 * The kinds whose registry rows exist in the specified shape of `§1.2`.
 *
 * This is the TypeScript face of `T2-LOY-PART`'s row-count alarm: when the
 * Migration Owner applies the consumption kind, `'consume'` joins this set in
 * the same change, and until then anything that would INSERT a `'consume'`
 * row is refused here rather than at a constraint that does not exist yet.
 */
export const REGISTERED_KINDS: readonly LoyaltyMovementKind[] = ['earn', 'expire', 'adjust'];

/** `loyalty_movement_kinds.points_sign`, as the closed registry states it (§1.2). */
export const KIND_SIGN: Readonly<Record<LoyaltyMovementKind, 'positive' | 'negative' | 'either'>> = {
  earn: 'positive',
  expire: 'negative',
  adjust: 'either',
  consume: 'negative',
};

/** `loyalty_movement_kinds.requires_reason` (§1.2). An `adjust` must say why. */
export const KIND_REQUIRES_REASON: Readonly<Record<LoyaltyMovementKind, boolean>> = {
  earn: false,
  expire: false,
  adjust: true,
  consume: false,
};

/** `loyalty_source_types` (§1.2). */
export type LoyaltySourceType = 'sale' | 'expiry_sweep' | 'manual_adjustment';

/**
 * `loyalty_source_movement_kinds` — the LEAST-AUTHORITY PAIR of `§1.2`.
 * Authority is carried by the (source type, kind) pair and deliberately not by
 * either alone: a `sale` may both earn and consume, while no other source may
 * consume, and an `expiry_sweep` may never earn.
 */
export const SOURCE_KIND_PAIRS: readonly `${LoyaltySourceType}:${LoyaltyMovementKind}`[] = [
  'sale:earn',
  'sale:consume',
  'expiry_sweep:expire',
  'manual_adjustment:adjust',
];

/**
 * `loyalty_point_movements_delta_range_ck` (§1.2), in the house manner of the
 * settlement tables. A point count above this is refused rather than wrapped,
 * and `§5.2` records that this bound is load-bearing for the wire type: it
 * sits below `Number.MAX_SAFE_INTEGER`, which is the only reason a point count
 * may travel as a JSON number while no money figure in this estate may.
 */
export const POINTS_DELTA_MAX = 1000000000000000n;
export const POINTS_DELTA_MIN = -1000000000000000n;

/* ------------------------------------------------------------------ *
 * Civil dates — supplied, never resolved from a clock (§4.1)
 * ------------------------------------------------------------------ */

/** A civil date, `YYYY-MM-DD`. ISO-ordered, so string comparison IS date comparison. */
export type CivilDate = string;

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a civil date and refuses anything else.
 *
 * There is no `?? today()` anywhere in this file — the same discipline
 * `sale-payloads.ts:20-27` states for the sale builder at `93084f8`, and the
 * reason `§4.1` gives for loyalty specifically: an expiry sweep that reads the
 * machine clock cannot be tested at a ten-year horizon at all.
 */
export function assertCivilDate(value: string, what: string): CivilDate {
  if (typeof value !== 'string' || !CIVIL_DATE_RE.test(value)) {
    refuseLoyalty('loyalty.date_not_civil', `${what} must be a civil YYYY-MM-DD date`, { what, value: String(value) });
  }
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10)) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) {
    refuseLoyalty('loyalty.date_not_civil', `${what} is not a real calendar date`, { what, value });
  }
  return value;
}

/**
 * `DATE` arithmetic in whole days, which is what `§4.2`'s `T2-EXP-LEAP` case
 * pins: the horizon is day arithmetic and not month arithmetic with an
 * implicit clamp. No money passes through here, so integer millisecond
 * arithmetic over `Date.UTC` is exact and sufficient; nothing in this file
 * does arithmetic on a point or an amount with a `number`.
 */
export function addDays(date: CivilDate, days: number): CivilDate {
  assertCivilDate(date, 'date');
  if (!Number.isInteger(days)) {
    refuseLoyalty('loyalty.date_not_civil', 'a horizon is a whole number of days', { days: String(days) });
  }
  const [y, m, d] = date.split('-').map((p) => Number.parseInt(p, 10)) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  const yy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/* ------------------------------------------------------------------ *
 * Rounding — an explicit, required policy (§5.6)
 * ------------------------------------------------------------------ */

/**
 * A fractional point is not a representable fact (`§1.1`), so any rate that is
 * not a whole number of points per unit forces a rounding decision. `§5.6`
 * records that PART 83 did NOT rule the rounding mode and that *PART 8's "one
 * unexplained minor unit = DEFECT" means this cannot be left to an
 * implementer's instinct*.
 *
 * Consequently **every function in this file that divides takes the mode as a
 * required argument and this module exports no default.** A default here would
 * be this slice ruling a policy it was told it does not own.
 */
export type RoundingMode = 'floor' | 'ceil' | 'toward_zero' | 'half_up' | 'half_even';

/** Exact integer division under an explicit mode. `bigint` throughout; no float, ever. */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) {
    refuseLoyalty('loyalty.rate_not_positive', 'a rate denominator must be positive', {
      denominator: denominator.toString(),
    });
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  const twiceAbsRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  switch (mode) {
    case 'toward_zero':
      return quotient;
    case 'floor':
      return sign < 0n ? quotient - 1n : quotient;
    case 'ceil':
      return sign > 0n ? quotient + 1n : quotient;
    case 'half_up':
      // Half away from zero, on the magnitude — the commercial reading.
      return twiceAbsRemainder >= denominator ? quotient + sign : quotient;
    case 'half_even':
      if (twiceAbsRemainder > denominator) return quotient + sign;
      if (twiceAbsRemainder < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + sign;
  }
}

/* ------------------------------------------------------------------ *
 * Configuration — supplied, never constant (§5.6)
 * ------------------------------------------------------------------ */

/**
 * A rate as an exact rational. Not a float and not a scaled integer with an
 * implied exponent: both of those hide a rounding that `§5.6` requires to be
 * explicit and separately chosen.
 */
export interface LoyaltyRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * The earning configuration. Merchant configuration, held server-side, with
 * **no constant in this file** — PART 83 and PART 26: *tests may use fixtures;
 * production values are explicit platform configuration*.
 */
export interface LoyaltyEarningConfig {
  /** Points awarded per one minor unit of the eligible base, as an exact rational. */
  readonly pointsPerMinorUnit: LoyaltyRate;
  /** The horizon stored on the earn row (`§4.2`), in whole days, never recomputed at read time. */
  readonly horizonDays: number;
}

/**
 * The points → discount-value configuration.
 *
 * TENSION RECORDED, NOT RESOLVED. `§5.6` states that whoever turns points into
 * minor units *reads the configuration inside the sale's own commit*, and that
 * Phase 13 *does not need to read it at all*. This shape and
 * {@link convertPointsToValueMinor} are therefore the **shape of that
 * conversion and not a Phase 13 product path**: the rate is an argument so
 * that no rate exists in this package, and nothing here posts, computes a sale
 * total, or returns an authoritative figure. A Phase 13 surface must not call
 * it to show a customer a money amount; `§5.2`'s quote is money-free and stays
 * money-free.
 */
export interface LoyaltyConversionConfig {
  /** Minor units of discount per one point, as an exact rational. */
  readonly valueMinorPerPoint: LoyaltyRate;
}

function requireRate(rate: LoyaltyRate | null | undefined, what: string): LoyaltyRate {
  // PART 124, fail closed when policy unknown. An absent, empty or zero rate
  // is refused and never defaulted: a default rate is a hard-coded conversion
  // with a longer code path (§5.6).
  if (rate === null || rate === undefined) {
    refuseLoyalty('loyalty.unconfigured', `${what} is not configured for this business`, { what });
  }
  if (typeof rate.numerator !== 'bigint' || typeof rate.denominator !== 'bigint') {
    refuseLoyalty('loyalty.unconfigured', `${what} must be an exact bigint rational`, { what });
  }
  if (rate.denominator <= 0n || rate.numerator <= 0n) {
    refuseLoyalty('loyalty.rate_not_positive', `${what} must be a positive rational`, {
      what,
      numerator: rate.numerator.toString(),
      denominator: rate.denominator.toString(),
    });
  }
  return rate;
}

/**
 * The earning computation: an eligible money base in, a whole point count out.
 *
 * `§2.2(c)`: *the points rule consumes money and emits a count, and that
 * direction is one-way.* Nothing in the result can be read back as money,
 * because the result carries no currency, no exponent and no rate.
 *
 * `rounding` is required and positional. There is no default and no overload
 * without it.
 */
export function computeEarnedPoints(
  eligibleBaseMinor: bigint,
  config: LoyaltyEarningConfig | null | undefined,
  rounding: RoundingMode,
): bigint {
  if (config === null || config === undefined) {
    refuseLoyalty('loyalty.unconfigured', 'this business has no loyalty earning configuration');
  }
  const rate = requireRate(config.pointsPerMinorUnit, 'the earning rate');
  if (typeof eligibleBaseMinor !== 'bigint') {
    refuseLoyalty('loyalty.allocation_value_invalid', 'an eligible base is integer minor units as a bigint');
  }
  if (eligibleBaseMinor < 0n) {
    refuseLoyalty('loyalty.allocation_value_invalid', 'an eligible base must not be negative', {
      eligibleBaseMinor: eligibleBaseMinor.toString(),
    });
  }
  const points = divideRounded(eligibleBaseMinor * rate.numerator, rate.denominator, rounding);
  return assertInPointsRange(points, 'an award');
}

/**
 * Points → a discount VALUE in minor units. See
 * {@link LoyaltyConversionConfig} for why this is a shape and not a Phase 13
 * product path. `rounding` is required; `§5.6` item 1 is the open policy.
 */
export function convertPointsToValueMinor(
  points: bigint,
  config: LoyaltyConversionConfig | null | undefined,
  rounding: RoundingMode,
): bigint {
  if (config === null || config === undefined) {
    refuseLoyalty('loyalty.unconfigured', 'this business has no configured points conversion, so it has no redemption capability');
  }
  const rate = requireRate(config.valueMinorPerPoint, 'the points conversion rate');
  if (typeof points !== 'bigint') {
    refuseLoyalty('loyalty.allocation_value_invalid', 'a point quantity is a bigint count');
  }
  if (points <= 0n) {
    refuseLoyalty('loyalty.movement_would_be_zero', 'a redemption of no points has no value to convert', {
      points: points.toString(),
    });
  }
  return divideRounded(points * rate.numerator, rate.denominator, rounding);
}

function assertInPointsRange(points: bigint, what: string): bigint {
  if (points > POINTS_DELTA_MAX || points < POINTS_DELTA_MIN) {
    refuseLoyalty('loyalty.points_out_of_range', `${what} is outside the ledger's range`, {
      what,
      points: points.toString(),
    });
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * The ledger (§1.2) — append-only, no mutable column
 * ------------------------------------------------------------------ */

/**
 * One movement. There is no `reversed` boolean and no status column (`§1.4`):
 * a correction is a new `adjust` row whose `correctsId` names what it corrects.
 * There is no currency, exponent or rate field (`§1.1`).
 */
export interface LoyaltyMovement {
  readonly id: string;
  readonly businessId: string;
  readonly customerId: string;
  /** The per-customer order, and the ONLY order anything reads this ledger in (§1.2, §4.3). */
  readonly pointSeq: bigint;
  readonly movementKind: LoyaltyMovementKind;
  readonly sourceType: LoyaltySourceType;
  readonly sourceId: string;
  readonly pointsDelta: bigint;
  /** The earn row's own stored horizon; `null` on every other kind (`horizon_ck`, §4.2). */
  readonly expiresOn: CivilDate | null;
  /** The civil date the movement is MEASURED to, supplied by the caller, never a clock (§4.1). */
  readonly effectiveOn: CivilDate;
  readonly reason: string | null;
  readonly correctsId: string | null;
}

/** A movement before the ledger assigns its per-customer sequence. */
export type LoyaltyMovementDraft = Omit<LoyaltyMovement, 'pointSeq'>;

/**
 * The ledger as a value. `movements` is readonly and every operation returns a
 * new ledger: there is no `UPDATE` path and no `DELETE` path, which is `§1.2`'s
 * third absence held as a type rather than as an ACL this package cannot see.
 */
export interface LoyaltyLedger {
  readonly movements: readonly LoyaltyMovement[];
}

export function emptyLedger(): LoyaltyLedger {
  return { movements: [] };
}

/* ------------------------------------------------------------------ *
 * Idempotency (§3.1, §5.5.3)
 * ------------------------------------------------------------------ */

/**
 * The identity `loyalty_point_movements_identity_uq` enforces:
 * `(business_id, source_type, source_id, movement_kind)`.
 */
export interface LoyaltyMovementIdentity {
  readonly businessId: string;
  readonly sourceType: LoyaltySourceType;
  readonly sourceId: string;
  readonly movementKind: LoyaltyMovementKind;
}

export function identityKey(identity: LoyaltyMovementIdentity): string {
  return [identity.businessId, identity.sourceType, identity.sourceId, identity.movementKind].join('\u0000');
}

/**
 * `§5.5.3`, stated once: **the idempotency key of a point consumption is the
 * canonical sale's own identity.** No caller-supplied key exists or is wanted;
 * the identity is derived from the sale, which is the domain-native identity.
 * The earn row for the same sale is a different `movementKind`, so the two
 * coexist and neither blocks the other.
 */
export function saleConsumptionIdentity(
  businessId: string,
  saleId: string,
  movementKind: LoyaltyMovementKind = 'consume',
): LoyaltyMovementIdentity {
  return { businessId, sourceType: 'sale', sourceId: saleId, movementKind };
}

/** The earn row's identity for the same sale (§2.3). */
export function saleEarnIdentity(businessId: string, saleId: string): LoyaltyMovementIdentity {
  return { businessId, sourceType: 'sale', sourceId: saleId, movementKind: 'earn' };
}

export type AppendOutcome = 'appended' | 'already_present';

export interface AppendResult {
  readonly ledger: LoyaltyLedger;
  readonly outcome: AppendOutcome;
  /** The row that is now in the ledger under this identity — the new one, or the one already there. */
  readonly movement: LoyaltyMovement;
}

/**
 * Appends one movement, assigning its per-customer `pointSeq`.
 *
 * **This is where the idempotency law lives.** `§3.1`: the invariant is a
 * `UNIQUE` constraint and not a check, and a replay is *refused by the index
 * rather than by a code path*. The fold's faithful image of that is: an append
 * whose identity is already present returns the ledger **unchanged** and
 * reports `'already_present'`, which is `§4.4`'s `T2-EXP-IDEM` reading of
 * `23505` — *treated as already-done; exactly one row exists*. The balance
 * therefore cannot move on a replay, and that is a property of this function
 * rather than of its callers' discipline.
 *
 * `pointSeq` is assigned here and is not an argument, so a caller cannot
 * invent one and cannot collide with `loyalty_point_movements_seq_uq`.
 */
export function appendMovement(ledger: LoyaltyLedger, draft: LoyaltyMovementDraft): AppendResult {
  validateDraft(ledger, draft);
  const key = identityKey(draft);
  const existing = ledger.movements.find((m) => identityKey(m) === key);
  if (existing !== undefined) {
    return { ledger, outcome: 'already_present', movement: existing };
  }
  let maxSeq = 0n;
  for (const m of ledger.movements) {
    if (m.businessId === draft.businessId && m.customerId === draft.customerId && m.pointSeq > maxSeq) {
      maxSeq = m.pointSeq;
    }
  }
  const movement: LoyaltyMovement = { ...draft, pointSeq: maxSeq + 1n };
  return { ledger: { movements: [...ledger.movements, movement] }, outcome: 'appended', movement };
}

/**
 * Every shape rule of `§1.2` that a row must satisfy, checked as the database
 * would check it. The point of restating them here is `§5.5.4` F-3's
 * mitigation: *the failure modes available to F-3 are all SHAPE failures that
 * Phase 13's own validation can exclude before the request is made*, which is
 * the second reason PART 83 has Phase 13 validate and not merely compute.
 */
export function validateDraft(ledger: LoyaltyLedger, draft: LoyaltyMovementDraft): void {
  assertCivilDate(draft.effectiveOn, 'effectiveOn');
  assertInPointsRange(draft.pointsDelta, 'a points delta');

  // `loyalty_point_movements_delta_nonzero_ck`: a zero-delta movement records
  // no fact and is indistinguishable from an accidental double submit with the
  // amount lost (§1.1).
  if (draft.pointsDelta === 0n) {
    refuseLoyalty('loyalty.movement_would_be_zero', 'a movement of zero points records no fact');
  }

  const pair = `${draft.sourceType}:${draft.movementKind}` as `${LoyaltySourceType}:${LoyaltyMovementKind}`;
  if (!SOURCE_KIND_PAIRS.includes(pair)) {
    refuseLoyalty('loyalty.source_kind_pair_unregistered', 'this source may not produce this movement kind', { pair });
  }

  const sign = KIND_SIGN[draft.movementKind];
  if (sign === 'positive' && draft.pointsDelta < 0n) {
    refuseLoyalty('loyalty.sign_violates_kind', `a ${draft.movementKind} movement is positive`, { pair });
  }
  if (sign === 'negative' && draft.pointsDelta > 0n) {
    refuseLoyalty('loyalty.sign_violates_kind', `a ${draft.movementKind} movement is negative`, { pair });
  }

  if (KIND_REQUIRES_REASON[draft.movementKind] && (draft.reason === null || draft.reason.trim() === '')) {
    refuseLoyalty('loyalty.reason_required', `a ${draft.movementKind} movement must carry a reason`, { pair });
  }

  // `horizon_ck`: an earn carries a horizon and nothing else does, so there is
  // never a second place a horizon could be read from (§1.2).
  if ((draft.movementKind === 'earn') !== (draft.expiresOn !== null)) {
    refuseLoyalty('loyalty.horizon_shape_invalid', 'an earn carries a horizon and no other kind does', { pair });
  }
  if (draft.expiresOn !== null) {
    assertCivilDate(draft.expiresOn, 'expiresOn');
    // `horizon_order_ck`: a point that expires on or before the day it was
    // earned is the shape of a horizon-of-zero bug (§4.2).
    if (draft.expiresOn <= draft.effectiveOn) {
      refuseLoyalty('loyalty.horizon_not_after_effective', 'a horizon must be after the day earned', {
        effectiveOn: draft.effectiveOn,
        expiresOn: draft.expiresOn,
      });
    }
  }

  // `corrects_ck` / `corrects_fk` / `corrects_not_self_ck` (§1.4).
  if (draft.correctsId !== null) {
    if (draft.movementKind !== 'adjust') {
      refuseLoyalty('loyalty.horizon_shape_invalid', 'only an adjust may be a correction', { pair });
    }
    if (draft.correctsId === draft.id) {
      refuseLoyalty('loyalty.correction_target_unknown', 'a movement may not correct itself', { id: draft.id });
    }
    const target = ledger.movements.find((m) => m.businessId === draft.businessId && m.id === draft.correctsId);
    if (target === undefined) {
      refuseLoyalty('loyalty.correction_target_unknown', 'a correction must name a movement in the ledger', {
        correctsId: draft.correctsId,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * The balance fold (§1.5)
 * ------------------------------------------------------------------ */

/**
 * The fold's answer, shaped exactly as `loyalty_points_as_of/3` returns it.
 *
 * `balancePoints` is the whole sum with **no predicate** — no `WHERE NOT
 * reversed`, no `WHERE status = 'active'`, nothing to forget. The component
 * figures are `FILTER`ed partitions returned *beside* the total and not inputs
 * a caller adds up: a caller that adds them has written a second definition,
 * and a caller given the total has nothing to add (`§1.5`).
 *
 * `movementCount` is a POSITIVE count and never a boolean, because under RLS
 * absent and invisible are one answer and `TL-P4-COORD-R22` forbids the
 * absence-shaped predicate (`§1.3`).
 */
export interface LoyaltyBalance {
  readonly earnedPoints: bigint;
  readonly expiredPoints: bigint;
  readonly adjustedPoints: bigint;
  readonly consumedPoints: bigint;
  readonly balancePoints: bigint;
  readonly movementCount: number;
}

/** Rows of one customer, in `point_seq` order, at or before `asOf`. */
function visibleMovements(ledger: LoyaltyLedger, businessId: string, customerId: string, asOf: CivilDate): LoyaltyMovement[] {
  assertCivilDate(asOf, 'asOf');
  return ledger.movements
    .filter((m) => m.businessId === businessId && m.customerId === customerId && m.effectiveOn <= asOf)
    .slice()
    .sort((a, b) => (a.pointSeq < b.pointSeq ? -1 : a.pointSeq > b.pointSeq ? 1 : 0));
}

export function foldBalance(
  ledger: LoyaltyLedger,
  businessId: string,
  customerId: string,
  asOf: CivilDate,
): LoyaltyBalance {
  const rows = visibleMovements(ledger, businessId, customerId, asOf);
  let earned = 0n;
  let expired = 0n;
  let adjusted = 0n;
  let consumed = 0n;
  let total = 0n;
  for (const m of rows) {
    total += m.pointsDelta;
    switch (m.movementKind) {
      case 'earn':
        earned += m.pointsDelta;
        break;
      case 'expire':
        expired += m.pointsDelta;
        break;
      case 'adjust':
        adjusted += m.pointsDelta;
        break;
      case 'consume':
        consumed += m.pointsDelta;
        break;
    }
  }
  return {
    earnedPoints: earned,
    expiredPoints: expired,
    adjustedPoints: adjusted,
    consumedPoints: consumed,
    balancePoints: total,
    movementCount: rows.length,
  };
}

/* ------------------------------------------------------------------ *
 * The expiry fold (§4)
 * ------------------------------------------------------------------ */

/** One earn lot and what is left of it after everything that drew on it. */
export interface LoyaltyLot {
  readonly movementId: string;
  readonly pointSeq: bigint;
  readonly expiresOn: CivilDate;
  readonly earnedPoints: bigint;
  readonly remainingPoints: bigint;
}

export interface LoyaltyExpiryFold {
  /** The lots in `(expiresOn, pointSeq)` order — a TOTAL order, so this is deterministic (§4.3). */
  readonly lots: readonly LoyaltyLot[];
  /** Points whose own horizon has passed at `asOf` and which have not yet been drawn down. */
  readonly expiringPoints: bigint;
  /** Points still spendable at `asOf`: `asOf < expiresOn`, plus `unhorizonedPoints`. */
  readonly spendablePoints: bigint;
  /**
   * The part of `spendablePoints` that is backed by NO lot and therefore has
   * no horizon — a STANDING manual grant (`correctsId === null`), and nothing
   * else. A positive row that corrects another row is refused, not counted
   * here: see the loop in `foldExpiry`.
   *
   * It is reported separately because it used to be invisible. It was summed
   * into `spendablePoints` and nowhere else, so a caller could not tell a
   * point that will expire from a point that never will, and neither could a
   * reviewer. Anything that compares this fold against the remainder relation
   * must read this field: a lot-backed figure and an un-horizoned one are not
   * the same quantity even when they add to the same total.
   */
  readonly unhorizonedPoints: bigint;
  /** The whole-ledger balance at `asOf`, for the bound below. */
  readonly balancePoints: bigint;
}

/**
 * The expiry fold.
 *
 * **Oldest-earn-first, ordered by `(expiresOn, pointSeq)`** — `§4.3` shows the
 * order is FORCED and not chosen: it is the only order under which the
 * quantity the sweep must expire is always at most the balance, because the
 * points surviving consumption are always the ones with the latest horizons.
 * Under LIFO the sweep would have to write an `expire` row that drives the
 * balance negative, and there is no lawful row for that.
 *
 * `pointSeq` and not `created_at` is the tiebreak: two earns written in one
 * transaction share an indistinguishable `now()`, so a `created_at` tiebreak
 * is non-deterministic — the same ledger and the same `asOf` giving two
 * answers. This fold never reads a timestamp at all.
 *
 * **The boundary convention** (`§4.2`): a point is spendable while
 * `asOf < expiresOn` and expired once `asOf >= expiresOn`.
 */
export function foldExpiry(
  ledger: LoyaltyLedger,
  businessId: string,
  customerId: string,
  asOf: CivilDate,
): LoyaltyExpiryFold {
  const rows = visibleMovements(ledger, businessId, customerId, asOf);

  const lots = rows
    .filter((m): m is LoyaltyMovement & { expiresOn: CivilDate } => m.movementKind === 'earn' && m.expiresOn !== null)
    .map((m) => ({ movementId: m.id, pointSeq: m.pointSeq, expiresOn: m.expiresOn, earned: m.pointsDelta, remaining: m.pointsDelta }))
    .sort((a, b) =>
      a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : a.pointSeq < b.pointSeq ? -1 : a.pointSeq > b.pointSeq ? 1 : 0,
    );

  // Everything that draws the balance down — an `expire` already written, a
  // `consume` inside a sale, a negative `adjust` — draws on the OLDEST lot
  // first.
  //
  // A POSITIVE non-earn row is the subtle case, and TWO rounds of independent
  // challenge were needed to get it right. `horizon_ck` makes it impossible
  // for any kind but an `earn` to carry a horizon, so such a row joins no lot.
  // The loop originally added every one of them to an `unhorizoned` total that
  // was spendable at every `asOf` FOREVER. For the one shape that is MEANT to
  // work that way — a standing manual grant, the merchant's goodwill remedy,
  // which corrects nothing and deliberately has no horizon — that is correct.
  // For a RESTORATION it is a defect with the merchant's money on the far
  // side: `§5.7.3` restores a consumed point by appending `+c`, the
  // consumption's `-c` stays in `draw` so the original lot remains drawn down,
  // and the restored points come back with no horizon at all. Measured on the
  // challenge's fixture: 100 points with a horizon of 2026-06-01, 40 consumed
  // and reversed, gave `expiringPoints = 60` and `spendablePoints = 40` on the
  // horizon day, and after the sweep took its 60 those 40 were still eligible
  // at `asOf = 2036-01-01` with nothing left to expire them.
  //
  // THE DISCRIMINATOR IS `correctsId`, NOT `sourceType`. The first fix keyed on
  // the source and exempted `manual_adjustment`, and the re-challenge showed
  // why that was wrong twice over: the pack specifies the restoration AS a
  // positive `manual_adjustment` `adjust` naming its target (`§1.4`, `§2.3`,
  // `A-16`), so the exemption covered the exact row it was written to stop and
  // the fixture reproduced byte-identically; and enumerating
  // `SOURCE_KIND_PAIRS` against `KIND_SIGN` shows `manual_adjustment:adjust` is
  // the ONLY positive non-earn row a lawful writer can produce at all, so the
  // refusal was unreachable except by building a ledger by hand. A guard that
  // can only fire on a row no writer can write is not a guard.
  //
  // `§1.4` makes `correctsId` the marker of every correction, and a standing
  // grant corrects nothing. So a positive non-earn row REFUSES when it names a
  // row it corrects — or when it is not a manual adjustment at all, which keeps
  // the guard closed over a restoring source `§5.7.2` has yet to register.
  //
  // THE EXACT EXTENT OF THAT CLOSURE, because a later challenge measured it and
  // the first statement of it here was too broad: this fails closed on a
  // reversal THAT NAMES ITS TARGET. `corrects_ck` constrains `corrects_id` only
  // when it is non-null, so the same reversal with the field omitted passes
  // `validateDraft` and is admitted as a grant — immortal again, measured. No
  // code in this package can close that: a nullable field cannot be made
  // mandatory for writers that do not come through this package.
  // `buildReversalMovement` takes `correctsId` as a REQUIRED field so no caller
  // of it can omit one, and §A.3c.1 asks the Migration Owner for the
  // distinction on a column the writer cannot omit — a restoring kind of its
  // own, or `corrects_id NOT NULL` for that kind.
  //
  // Failing closed is forced rather than chosen: the migration patch request
  // demotes this fold to a cross-check that may only REFUSE and never permit,
  // and an un-horizoned total silently PERMITS a spend the remainder relation —
  // whose lot is drawn down and expired — must refuse.
  //
  // ONE ARM THIS DOES NOT CLOSE, stated rather than papered over: a `§2.3`
  // adjustment that supplies an earn the outbox never wrote has
  // `correctsId === null` and SHOULD carry that sale's horizon, which
  // `horizon_ck` forbids. It is admitted here as a grant, and the horizon it
  // deserves needs the DDL item already raised in
  // `P13-MIGRATION-PATCH-REQUEST.md` §A.3c.1.
  let unhorizoned = 0n;
  let draw = 0n;
  for (const m of rows) {
    if (m.movementKind === 'earn') continue;
    if (m.pointsDelta < 0n) {
      draw += -m.pointsDelta;
      continue;
    }
    if (m.correctsId !== null || m.sourceType !== 'manual_adjustment') {
      refuseLoyalty(
        'loyalty.unattributable_positive_movement',
        m.correctsId !== null
          ? 'a positive movement that corrects another row reached the expiry fold, and the horizon of the points it restores cannot be attributed to any lot'
          : 'a positive movement that is not a manual grant reached the expiry fold, and its horizon cannot be attributed to any lot',
        {
          movementId: m.id,
          sourceType: m.sourceType,
          movementKind: m.movementKind,
          points: String(m.pointsDelta),
          correctsId: m.correctsId ?? '(none)',
        },
      );
    }
    unhorizoned += m.pointsDelta;
  }
  for (const lot of lots) {
    if (draw === 0n) break;
    const take = lot.remaining < draw ? lot.remaining : draw;
    lot.remaining -= take;
    draw -= take;
  }

  let expiring = 0n;
  let spendableFromLots = 0n;
  for (const lot of lots) {
    if (lot.expiresOn <= asOf) expiring += lot.remaining;
    else spendableFromLots += lot.remaining;
  }

  const balance = foldBalance(ledger, businessId, customerId, asOf).balancePoints;

  // `§4.3`'s representability requirement, held as an assertion rather than as
  // a hope: the sweep must never be asked to write a row that drives the
  // balance negative. `T2-EXP-ADJUSTED` is the case this bound exists for.
  const bounded = expiring > balance ? (balance > 0n ? balance : 0n) : expiring;

  return {
    lots: lots.map((l) => ({
      movementId: l.movementId,
      pointSeq: l.pointSeq,
      expiresOn: l.expiresOn,
      earnedPoints: l.earned,
      remainingPoints: l.remaining,
    })),
    expiringPoints: bounded,
    spendablePoints: spendableFromLots + unhorizoned,
    unhorizonedPoints: unhorizoned,
    balancePoints: balance,
  };
}

/**
 * The eligible quantity of `§5.2`: the balance less anything whose own horizon
 * has already passed but whose sweep has not yet run. A quote that offered
 * those would offer points the next sweep is about to take, which is `A-18`'s
 * window with the merchant's money in it.
 *
 * This is a COUNT. It carries no currency, no amount and no rate, because a
 * field that could hold money here would eventually hold money (`§5.2`).
 */
export function eligiblePoints(
  ledger: LoyaltyLedger,
  businessId: string,
  customerId: string,
  asOf: CivilDate,
): bigint {
  const fold = foldExpiry(ledger, businessId, customerId, asOf);
  const eligible = fold.balancePoints - fold.expiringPoints;
  return eligible > 0n ? eligible : 0n;
}

/* ------------------------------------------------------------------ *
 * EARNING — after the sale, and structurally unable to fail it (§2)
 * ------------------------------------------------------------------ */

/**
 * The `sale.committed.v1` outbox row, as the earn path sees it.
 *
 * `phase` is the literal `'after_sale_commit'` and that literal is the
 * structural half of `§2.2(d)`: this type cannot be produced by anything
 * inside the sale's transaction, so the earn builder cannot be reached from
 * there. `§2.1`: *points are earned by a consumer of the `sale.committed.v1`
 * outbox row, in its own transaction, after the sale's transaction has
 * committed.*
 */
export interface SaleCommittedEvent {
  readonly phase: 'after_sale_commit';
  readonly businessId: string;
  readonly customerId: string;
  readonly saleId: string;
  readonly businessTransactionId: string;
  /** The sale's committed total as the sales authority reports it — read, never recomputed (§2.2(c)). */
  readonly eligibleBaseMinor: bigint;
  /** Supplied, never a clock (§4.1). Becomes the row's `effectiveOn`. */
  readonly effectiveOn: CivilDate;
  /** The movement's own id, minted by the earn transaction. */
  readonly movementId: string;
}

/**
 * The result of an earn attempt. A discriminated union and not an exception,
 * and that is the whole point of this function's existence.
 */
export type EarnAttempt =
  | { readonly ok: true; readonly draft: LoyaltyMovementDraft }
  | { readonly ok: false; readonly refusal: LoyaltyRefusal };

/**
 * Builds the post-sale earn row, and **never throws**.
 *
 * `§2.2(b)`: *earning cannot fail the sale.* `§2.3`: *the sale stands.* Those
 * are claims about a transaction boundary, and the code's share of them is
 * this: the function has no throwing expression on any input. Every refusal
 * the shape rules can raise is caught and returned as a value, so there is no
 * mechanism — not an exception, not a rejected promise — by which an earning
 * defect could reach a caller that is holding a transaction open. An
 * instruction that cannot be built is the outbox relay's retry and eventually
 * its `'dead'` terminal state (`§2.3`), settled by a `manual_adjustment`
 * `adjust` naming the sale, exactly as any other correction is (`§1.4`).
 *
 * A retry is safe because of `§3` and only because of `§3`: the retry
 * re-presents the identical `(businessId, 'sale', saleId, 'earn')` identity and
 * {@link appendMovement} makes the second one a no-op.
 */
export function tryBuildPostSaleEarnMovement(
  event: SaleCommittedEvent,
  config: LoyaltyEarningConfig | null | undefined,
  rounding: RoundingMode,
): EarnAttempt {
  try {
    if (event.phase !== 'after_sale_commit') {
      refuseLoyalty('loyalty.source_kind_pair_unregistered', 'an earn is built only from a committed sale event');
    }
    const points = computeEarnedPoints(event.eligibleBaseMinor, config, rounding);
    if (points === 0n) {
      // A rate that awards nothing for this sale is not an error of the sale's
      // and not a row: `delta_nonzero_ck` has no row for it (§1.1).
      refuseLoyalty('loyalty.movement_would_be_zero', 'this sale earns no whole point under the configured rate', {
        eligibleBaseMinor: event.eligibleBaseMinor.toString(),
      });
    }
    const effectiveOn = assertCivilDate(event.effectiveOn, 'effectiveOn');
    const horizonDays = config?.horizonDays;
    if (!Number.isInteger(horizonDays) || (horizonDays as number) <= 0) {
      // A horizon of zero or less would be refused by `horizon_order_ck`
      // anyway; refusing it here is the shape-failure exclusion of §5.5.4.
      refuseLoyalty('loyalty.horizon_not_after_effective', 'a loyalty horizon is a positive whole number of days', {
        horizonDays: String(horizonDays),
      });
    }
    const draft: LoyaltyMovementDraft = {
      id: event.movementId,
      businessId: event.businessId,
      customerId: event.customerId,
      movementKind: 'earn',
      sourceType: 'sale',
      sourceId: event.saleId,
      pointsDelta: points,
      // THE HORIZON IS STORED, never recomputed from the business's current
      // policy. A merchant who shortens the horizon must not retroactively
      // expire points that were already spendable (§4.2).
      expiresOn: addDays(effectiveOn, horizonDays as number),
      effectiveOn,
      reason: null,
      correctsId: null,
    };
    validateDraft(emptyLedger(), draft);
    return { ok: true, draft };
  } catch (error) {
    if (error instanceof LoyaltyRefusal) return { ok: false, refusal: error };
    return {
      ok: false,
      refusal: new LoyaltyRefusal('loyalty.unconfigured', 'the earning configuration could not be read', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

/* ------------------------------------------------------------------ *
 * CONSUMPTION — inside the sale's transaction, and able to refuse it (§5.5)
 * ------------------------------------------------------------------ */

/**
 * The sale's commit, in flight.
 *
 * `phase` is the literal `'inside_sale_transaction'`, the other half of
 * `§2.2(d)`'s structural separation. `§5.5.1` proves no two-transaction
 * arrangement can satisfy PART 83's biconditional — *a biconditional across
 * two transactions is not a biconditional* — so the consumption row is written
 * inside the canonical sale's own transaction, by the authority that owns it.
 *
 * Phase 13 does not own that transaction. `§5.5.5`: the APPLY path is
 * **BLOCKED** on the Phase 4 sales authority accepting the seam of `§5.5.2`,
 * on `P4-S4`/`P4-S5` sealing, and on the Migration Owner applying Request 2.
 * This type is therefore the shape of the instruction the seam would carry —
 * the content of `LoyaltyRedemptionHandover` (`§5.3`) and nothing more: a
 * customer, an integer point quantity, and a business transaction id. **No
 * amount, no currency, no rate.**
 */
export interface SaleCommitInProgress {
  readonly phase: 'inside_sale_transaction';
  readonly businessId: string;
  readonly customerId: string;
  readonly saleId: string;
  readonly businessTransactionId: string;
  /** The quantity, re-read from the ledger under the primitive's own locks (§5.5.2 item 6). */
  readonly points: bigint;
  readonly asOf: CivilDate;
  readonly movementId: string;
}

/**
 * Builds the point-consumption row, and **refuses by throwing**.
 *
 * The asymmetry with {@link tryBuildPostSaleEarnMovement} is the law, not a
 * style difference. `§5.5.4` F-3: *under the atomic law, a loyalty defect CAN
 * refuse a sale* — for a redemption the customer is being given a discount for
 * those points, so a sale that cannot consume them must not grant it. A
 * `Result` here would let a caller inside the sale's transaction ignore the
 * refusal and commit the discount anyway, which is exactly the violating row
 * of `§5.5.1`'s table.
 *
 * It also re-checks eligibility against the ledger as supplied (`§5.5.2` item
 * 6, `§5.5.4` F-4): a quote is advisory, holds no lock and is not a
 * reservation, and the ledger at commit time is the authority of record.
 */
export function buildSaleConsumptionMovement(
  ledger: LoyaltyLedger,
  sale: SaleCommitInProgress,
  movementKind: LoyaltyMovementKind = 'consume',
): LoyaltyMovementDraft {
  if (sale.phase !== 'inside_sale_transaction') {
    refuseLoyalty('loyalty.source_kind_pair_unregistered', 'a consumption is written only inside the sale transaction');
  }
  const asOf = assertCivilDate(sale.asOf, 'asOf');
  if (typeof sale.points !== 'bigint' || sale.points <= 0n) {
    refuseLoyalty('loyalty.movement_would_be_zero', 'a consumption of no points is not a movement', {
      points: String(sale.points),
    });
  }
  const available = eligiblePoints(ledger, sale.businessId, sale.customerId, asOf);
  if (available < sale.points) {
    refuseLoyalty('loyalty.insufficient_eligible_points', 'the quantity is no longer available at commit time', {
      requested: sale.points.toString(),
      available: available.toString(),
    });
  }
  const draft: LoyaltyMovementDraft = {
    id: sale.movementId,
    businessId: sale.businessId,
    customerId: sale.customerId,
    movementKind,
    sourceType: 'sale',
    sourceId: sale.saleId,
    pointsDelta: -sale.points,
    expiresOn: null,
    effectiveOn: asOf,
    reason: null,
    correctsId: null,
  };
  validateDraft(ledger, draft);
  return draft;
}

/** Everything a reversal needs, with the corrected movement as a REQUIRED field. */
export interface ReversalRequest {
  readonly businessId: string;
  readonly customerId: string;
  /** The sale or return document the reversal belongs to. */
  readonly sourceId: string;
  /** The movement being reversed. There is no overload of this without it. */
  readonly correctsId: string;
  readonly points: bigint;
  readonly asOf: CivilDate;
  readonly movementId: string;
  readonly reason: string;
}

/**
 * The only writer in this package for a restoring movement.
 *
 * WHY IT EXISTS. `foldExpiry` refuses a positive movement that names a row it
 * corrects, because the points it restores belong to a lot whose horizon the
 * row cannot carry (`horizon_ck`). A challenge then measured the obvious next
 * question: the SAME reversal with `correctsId` omitted passes `validateDraft`
 * — `corrects_ck` constrains the field only when it is non-null — and is
 * admitted as a standing grant, immortal again. So the fold's closure depends
 * on the caller choosing to name its target, and caller discipline is exactly
 * what `appendMovement`'s own contract disclaims.
 *
 * WHAT IT CAN AND CANNOT FIX. `correctsId` here is a required field of a
 * required argument, so no caller of THIS function can omit it: the omission
 * stops being a choice and becomes a type error. What it cannot do is bind a
 * writer that does not come through it — a hand-written draft, or any writer
 * outside this package — and no code in this package can. Only the database
 * can force it, which is why `P13-MIGRATION-PATCH-REQUEST.md` §A.3c.1 asks for
 * the distinction on a column the writer cannot omit (a restoring KIND of its
 * own, or `corrects_id NOT NULL` for that kind) rather than on a nullable
 * field. Until that lands, the honest statement of this arm is: **the fold
 * fails closed on a reversal that names its target**, and a reversal that does
 * not name one is indistinguishable from a grant to anything downstream.
 *
 * It is deliberately NOT registered as a new source or kind: it writes the
 * `manual_adjustment` `adjust` the pack already specifies for a correction
 * (`§1.4`, `§2.3`, `A-16`), so it adds a writer and invents no registry row.
 */
export function buildReversalMovement(ledger: LoyaltyLedger, request: ReversalRequest): LoyaltyMovementDraft {
  const asOf = assertCivilDate(request.asOf, 'asOf');
  if (typeof request.points !== 'bigint' || request.points <= 0n) {
    refuseLoyalty('loyalty.movement_would_be_zero', 'a reversal of no points is not a movement', {
      points: String(request.points),
    });
  }
  if (request.correctsId === request.movementId) {
    refuseLoyalty('loyalty.corrects_self', 'a movement cannot correct itself', { movementId: request.movementId });
  }
  const corrected = ledger.movements.find((m) => m.id === request.correctsId);
  if (corrected === undefined) {
    refuseLoyalty('loyalty.corrects_unknown_movement', 'a reversal must name a movement this ledger holds', {
      correctsId: request.correctsId,
    });
  }
  if (corrected.businessId !== request.businessId || corrected.customerId !== request.customerId) {
    refuseLoyalty('loyalty.corrects_unknown_movement', 'a reversal and the movement it corrects belong to one party', {
      correctsId: request.correctsId,
    });
  }
  const draft: LoyaltyMovementDraft = {
    id: request.movementId,
    businessId: request.businessId,
    customerId: request.customerId,
    movementKind: 'adjust',
    sourceType: 'manual_adjustment',
    sourceId: request.sourceId,
    pointsDelta: request.points,
    expiresOn: null,
    effectiveOn: asOf,
    reason: request.reason,
    correctsId: request.correctsId,
  };
  validateDraft(ledger, draft);
  return draft;
}

/**
 * True when the consumption kind has its registry row and its writer. `§5.1`
 * and `§5.5.2`: the kind arrives with its writer or it does not arrive, and
 * until the Migration Owner applies Request 2 an INSERT of one has no lawful
 * target. A caller on the apply path checks this and receives `false`, which
 * is `§5.5.5`'s `BLOCKED` expressed as a value rather than as prose.
 */
export function consumptionKindIsRegistered(movementKind: LoyaltyMovementKind = 'consume'): boolean {
  return REGISTERED_KINDS.includes(movementKind);
}
