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
   * no horizon: a STANDING manual grant (`correctsId === null`), an earn that
   * carries no horizon, and the part of a restoration that is attributable
   * because its target drew on this pool rather than on a lot. It is DRAWN
   * DOWN by consumption like any other store, after the lots, because a grant
   * has no horizon and so survives last.
   *
   * A positive row that corrects another row is NOT counted here in full: only
   * the part its target drew from this pool is, and the lot-backed part is
   * reported in `unattributablePoints`. (This sentence replaces one that said
   * such a row is "refused, not counted here" — that was true of an earlier
   * commit and `F-17` of a challenge round found it surviving on the interface
   * a caller reads.)
   *
   * It is reported separately because it used to be invisible. It was summed
   * into `spendablePoints` and nowhere else, so a caller could not tell a
   * point that will expire from a point that never will, and neither could a
   * reviewer. Anything that compares this fold against the remainder relation
   * must read this field: a lot-backed figure and an un-horizoned one are not
   * the same quantity even when they add to the same total.
   */
  readonly unhorizonedPoints: bigint;
  /**
   * The part of the balance that is positive, backed by no lot, and NOT a
   * standing grant — today, a restoration that names the row it corrects. It
   * is WITHHELD: it is counted in `balancePoints`, excluded from
   * `spendablePoints`, and subtracted by `eligiblePoints`, so no caller can
   * spend it.
   *
   * It is a separate figure from `unhorizonedPoints` because the two are
   * opposite answers to the same question. An un-horizoned grant is a quantity
   * the fold KNOWS never expires; an un-attributable restoration is a quantity
   * the fold CANNOT place in any lot, so it may not be offered — and the
   * remedy for it is the DDL item in `P13-MIGRATION-PATCH-REQUEST.md` §A.3c.1,
   * not arithmetic here.
   *
   * It replaced a refusal, and `F-13` in `P13-S0-ARCHITECTURE-LOCK.md` §19 is
   * why: refusing the fold refused the whole customer, so one lawful return
   * disabled redemption for every point on that ledger, permanently.
   */
  readonly unattributablePoints: bigint;
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

  // THE FOLD IS A SEQUENTIAL REPLAY, and a fifth challenge round is why.
  //
  // It used to be two passes: sum every negative into one `draw`, then apply
  // that total to the lots and discard whatever the lots could not absorb. Two
  // defects lived in that shape and neither was visible from the totals.
  //
  // `F-14` (P1): an un-horizoned standing grant was never drawn down, and the
  // overflow was discarded, so a lawful spend that SPANNED a grant and a lot
  // was recorded against the lot alone. Reversing it then withheld the whole
  // restored quantity, and `eligiblePoints` subtracted it from the whole
  // balance — so the part the lots never backed came out of the grant.
  // Measured through this package's own writers: a grant of 30, an earn of 10,
  // a lawful spend of 40 and its lawful full return gave eligible **0** at
  // 2026-06-01, 2027-06-01 and 2040-01-01, with `spendablePoints` reporting 30
  // the whole time. That is `F-13`'s harm at `F-13`'s site, one layer in, and
  // SILENT where `F-13` at least threw: the till reads `available: '0'`.
  // `F-15` (P2): the same discarded overflow made `spendablePoints` report 30
  // against a balance of 20, and 50 against a balance of 15.
  // `F-16` (P2): a NEGATIVE `manual_adjustment` naming the restoring row — the
  // lawful way to record that a return was itself cancelled — went into the
  // same total, so it drew a lot that never funded the restoration while the
  // withheld quantity was never discharged. Two errors of 40 that CANCELLED
  // inside the conservation identity, which is why asserting that identity
  // proves nothing about attribution.
  //
  // So the rows are replayed IN `pointSeq` ORDER against three stores, and a
  // CORRECTION IS ATTRIBUTED THROUGH THE ROW IT CORRECTS, in both signs:
  //
  //   `lots`     dated earns, drawn oldest-horizon-first (`§4.3`'s forced order)
  //   `pool`     un-horizoned standing grants, drawn after the lots because a
  //              grant has no horizon and therefore survives last
  //   `withheld` positive corrections whose lot attribution is unknown
  //
  // A restoration restores what its target actually drew: the part that drew on
  // a LOT is un-attributable and is withheld (`F-01`, remedied properly only by
  // `§A.3c.1`), and the part that drew on the POOL is perfectly attributable,
  // because a grant has no horizon to recover — giving it back restores it
  // exactly. A restoration of a row that is not a draw at all (an `earn`, say)
  // is withheld in full, which is the conservative answer and the one `F-01`'s
  // own fixture gets.
  interface LotState {
    readonly movementId: string;
    readonly pointSeq: bigint;
    readonly expiresOn: CivilDate;
    readonly earned: bigint;
    remaining: bigint;
  }
  /** What a negative row actually drew, so a correction of it can be attributed. */
  interface DrawSplit {
    fromLots: bigint;
    fromPool: bigint;
    fromWithheld: bigint;
    /** Drawn against capacity that did not exist yet — see `pending`. */
    unfunded: bigint;
  }
  /** What a positive row put where, so a negative correction of it discharges the same store. */
  interface CreditSplit {
    toPool: bigint;
    toWithheld: bigint;
  }

  const lots: LotState[] = [];
  let pool = 0n;
  let withheld = 0n;
  const draws = new Map<string, DrawSplit>();
  const credits = new Map<string, CreditSplit>();
  // A draw against capacity that does not exist yet. The two-pass fold allowed
  // it — it summed every negative before building the lots — and a ledger whose
  // spend precedes its earn must not change answer because the fold now reads in
  // order. The claim is queued and settled FIFO when capacity appears, and the
  // row's own split is corrected then, so an attribution read later is still
  // right.
  const pending: { readonly id: string; amount: bigint }[] = [];

  const oldestLot = (): LotState | undefined => {
    let best: LotState | undefined;
    for (const lot of lots) {
      if (lot.remaining <= 0n) continue;
      if (
        best === undefined ||
        lot.expiresOn < best.expiresOn ||
        (lot.expiresOn === best.expiresOn && lot.pointSeq < best.pointSeq)
      ) {
        best = lot;
      }
    }
    return best;
  };

  const takeFromLots = (amount: bigint): bigint => {
    let left = amount;
    for (let lot = oldestLot(); lot !== undefined && left > 0n; lot = oldestLot()) {
      const take = lot.remaining < left ? lot.remaining : left;
      lot.remaining -= take;
      left -= take;
    }
    return amount - left;
  };

  const takeFromPool = (amount: bigint): bigint => {
    const take = pool < amount ? pool : amount;
    pool -= take;
    return take;
  };

  const takeFromWithheld = (amount: bigint): bigint => {
    const take = withheld < amount ? withheld : amount;
    withheld -= take;
    return take;
  };

  /** Capacity has appeared; settle the oldest unfunded claims against it.
   *
   *  WHAT IN HERE IS REACHED, AND WHAT IS NOT. A challenge round observed that
   *  much of this machinery is unreachable through this package's own writers —
   *  `buildSaleConsumptionMovement` will not write a draw its ledger cannot
   *  fund — and that a line which would silently stop settling deserves a case
   *  rather than a reader's confidence. So the suite now reaches the
   *  PARTIAL-SETTLE `break` by hand: a claim of 50, a lot of 20 that settles 20
   *  and stops, then a grant of 40 that settles the remaining 30.
   *
   *  Two lines here are DEFENSIVE and nothing reaches them: the `undefined`
   *  guard on the head of the queue (`pending.length > 0` already decided it)
   *  and the `undefined` guard on the claim's own split (every queued claim is
   *  registered in `draws` on the same row that queues it). They stay because
   *  `noUncheckedIndexedAccess` is on and the repository forbids the non-null
   *  assertion, so the alternative is not fewer lines but a weaker type. They
   *  are stated here rather than left for a reader to wonder about. */
  const settlePending = (): void => {
    while (pending.length > 0) {
      const claim = pending[0];
      if (claim === undefined) break;
      const split = draws.get(claim.id);
      const fromLots = takeFromLots(claim.amount);
      const fromPool = takeFromPool(claim.amount - fromLots);
      const settled = fromLots + fromPool;
      if (settled === 0n) break;
      claim.amount -= settled;
      if (split !== undefined) {
        split.fromLots += fromLots;
        split.fromPool += fromPool;
        split.unfunded -= settled;
      }
      if (claim.amount === 0n) pending.shift();
      else break;
    }
  };

  for (const m of rows) {
    if (m.movementKind === 'earn') {
      if (m.expiresOn !== null) {
        lots.push({
          movementId: m.id,
          pointSeq: m.pointSeq,
          expiresOn: m.expiresOn,
          earned: m.pointsDelta,
          remaining: m.pointsDelta,
        });
        settlePending();
      } else {
        // An earn with no horizon is not a lot and never expires. `horizon_ck`
        // does not require one, so this is reachable and it belongs in the pool.
        pool += m.pointsDelta;
        credits.set(m.id, { toPool: m.pointsDelta, toWithheld: 0n });
        settlePending();
      }
      continue;
    }

    if (m.pointsDelta < 0n) {
      let left = -m.pointsDelta;
      const split: DrawSplit = { fromLots: 0n, fromPool: 0n, fromWithheld: 0n, unfunded: 0n };
      // `F-16`: a negative correction discharges the stores its TARGET credited,
      // before anything else. Without this it draws a lot that never funded the
      // row it corrects, and the withheld quantity is never released.
      if (m.correctsId !== null) {
        const credit = credits.get(m.correctsId);
        if (credit !== undefined) {
          const fromWithheld = takeFromWithheld(credit.toWithheld < left ? credit.toWithheld : left);
          credit.toWithheld -= fromWithheld;
          split.fromWithheld += fromWithheld;
          left -= fromWithheld;
          const fromPool = takeFromPool(credit.toPool < left ? credit.toPool : left);
          credit.toPool -= fromPool;
          split.fromPool += fromPool;
          left -= fromPool;
        }
      }
      const fromLots = takeFromLots(left);
      split.fromLots += fromLots;
      left -= fromLots;
      const fromPool = takeFromPool(left);
      split.fromPool += fromPool;
      left -= fromPool;
      const fromWithheld = takeFromWithheld(left);
      split.fromWithheld += fromWithheld;
      left -= fromWithheld;
      if (left > 0n) {
        split.unfunded += left;
        pending.push({ id: m.id, amount: left });
      }
      draws.set(m.id, split);
      continue;
    }

    // A POSITIVE NON-EARN ROW.
    //
    // A source other than `manual_adjustment` still REFUSES, and this arm is
    // deliberately not a withholding. `SOURCE_KIND_PAIRS` registers no other
    // positive non-earn pair, so no lawful writer can produce one: its presence
    // means the ledger was assembled past `validateDraft`, and there is no sound
    // answer of any kind over a ledger that cannot exist. A challenge round
    // measured this arm and agreed; withholding a quantity here would be
    // inventing an attribution rather than declining to guess one.
    if (m.sourceType !== 'manual_adjustment') {
      refuseLoyalty(
        'loyalty.unattributable_positive_movement',
        'a positive movement that is not a manual grant reached the expiry fold, and no lawful writer can produce one',
        {
          movementId: m.id,
          sourceType: m.sourceType,
          movementKind: m.movementKind,
          points: String(m.pointsDelta),
          correctsId: m.correctsId ?? '(none)',
        },
      );
    }

    if (m.correctsId === null) {
      // A STANDING grant. `§1.4` makes `correctsId` the marker of every
      // correction, and a grant corrects nothing: the merchant's goodwill
      // remedy under `A-16`, deliberately without a horizon.
      pool += m.pointsDelta;
      credits.set(m.id, { toPool: m.pointsDelta, toWithheld: 0n });
      settlePending();
      continue;
    }

    const target = draws.get(m.correctsId);
    let toWithheld = m.pointsDelta;
    let toPool = 0n;
    if (target !== undefined) {
      // Restore what the target actually drew. The lot-backed part — including a
      // part that was never funded, which cannot be attributed either — is
      // withheld; the pool-backed part goes straight back to the pool.
      const lotBacked = target.fromLots + target.unfunded;
      const lotPart = lotBacked < m.pointsDelta ? lotBacked : m.pointsDelta;
      const rest = m.pointsDelta - lotPart;
      const poolPart = target.fromPool < rest ? target.fromPool : rest;
      // Claimed quantities are struck off the target so a second restoration of
      // the same row cannot claim them again.
      const fromLots = target.fromLots < lotPart ? target.fromLots : lotPart;
      target.fromLots -= fromLots;
      target.unfunded -= lotPart - fromLots;
      target.fromPool -= poolPart;
      toPool = poolPart;
      // Anything beyond what the target drew is a quantity no draw accounts for,
      // so it is withheld rather than offered.
      toWithheld = m.pointsDelta - poolPart;
    }
    withheld += toWithheld;
    pool += toPool;
    credits.set(m.id, { toPool, toWithheld });
    if (toPool > 0n) settlePending();
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
    spendablePoints: spendableFromLots + pool,
    unhorizonedPoints: pool,
    unattributablePoints: withheld,
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
  // `F-13`: the un-attributable quantity is subtracted here and not refused in
  // the fold. It is part of the balance and it is not offerable, so the only
  // sound answer is the balance less what the next sweep will take and less
  // what no lot can account for.
  //
  // THE BALANCE AND THE STORES AGREE, and this is why no second bound is taken
  // here. The replay puts every positive point in exactly one store, and every
  // negative either takes from a store or is queued as an unfunded claim, so
  // `balance <= lots + pool + withheld` always, with equality on any ledger
  // whose draws were funded. A bound of `min(this, spendablePoints)` was
  // written here first and then removed: it could never bind, and a guard that
  // cannot fire is the defect `F-17` was about — a comment promising a
  // protection the code does not provide. Where the two differ, the balance is
  // the SMALLER figure (an unfunded draw lowers it and leaves the stores
  // alone), so deriving the answer from it is the conservative direction. The
  // suite asserts `eligible <= spendablePoints` over 2 000 generated ledgers at
  // three dates rather than asserting it here where it cannot fail.
  const eligible = fold.balancePoints - fold.expiringPoints - fold.unattributablePoints;
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
  // `F-26` — THE TARGET IS FOUND BY THE DECLARED KEY, NOT BY `id` ALONE.
  //
  // `§1.3` keys the relation `(business_id, id)` and there is no global unique
  // on `id`, so two businesses may hold one movement id — which is exactly what
  // RLS case 9 exists to exercise. This lookup read `id` alone, and an eighth
  // challenge round measured what that costs: with a sibling business's row
  // earlier in the ledger, a business's LAWFUL correction of its OWN row was
  // refused `loyalty.corrects_unknown_movement`, because the other party's row
  // was found first and then failed the party check that used to sit here. And
  // with that check passing, the bound's own filter was unkeyed too, so another
  // business's corrections tightened this one's bound. Both arms failed CLOSED,
  // which is why it was a residual and not a blocker — and it is still one
  // party's writes deciding another's refusals. `validateDraft` in this same
  // file already spells the key correctly.
  //
  // The party check is GONE rather than kept: with the lookup keyed, a target
  // belonging to another party is simply not found, so the check could never
  // fire, and a guard that cannot fire is a comment (`P13-AL-21`). The refusal
  // a cross-party target gets is the same one, by name, and the suite asserts
  // it for another business and for another customer.
  const sameParty = (m: LoyaltyMovement): boolean =>
    m.businessId === request.businessId && m.customerId === request.customerId;
  const byDeclaredKey = (id: string): LoyaltyMovement | undefined =>
    ledger.movements.find((m) => m.id === id && sameParty(m));

  const corrected = byDeclaredKey(request.correctsId);
  if (corrected === undefined) {
    refuseLoyalty('loyalty.corrects_unknown_movement', 'a reversal must name a movement this ledger holds for this party', {
      correctsId: request.correctsId,
      businessId: request.businessId,
      customerId: request.customerId,
    });
  }

  // `F-22` — A CORRECTION MAY NOT PRECEDE THE ROW IT CORRECTS.
  //
  // Nothing required this before, and a sixth challenge round measured what it
  // costs: visibility is by `effectiveOn` while the replay is by `pointSeq`, so
  // a correction dated before its target is VISIBLE at an `asOf` where the
  // target is not, the attribution falls through to "target unknown", and the
  // fold reports a balance of 140 for a customer who has earned 100. It heals
  // when the target becomes visible, so it is a reporting and attribution
  // defect rather than an over-offer — and it has no lawful reason to exist.
  // The database counterpart needs a deferred trigger (a CHECK cannot read
  // another row) and is raised with the Migration Owner in §A.3c.3.
  if (asOf < corrected.effectiveOn) {
    refuseLoyalty('loyalty.corrects_out_of_order', 'a correction may not be dated before the movement it corrects', {
      correctsId: request.correctsId,
      correctedEffectiveOn: corrected.effectiveOn,
      asOf,
    });
  }

  // `F-21` — AND IT MAY NOT GIVE BACK MORE THAN THAT ROW EVER TOOK.
  //
  // This writer compared the quantity with nothing, and the fold absorbed the
  // excess into the withheld store, so redemption stayed safe while
  // `balancePoints` did not: a 1,000,000-point "reversal" of a 40-point
  // consumption reported a balance of 1,000,060 for that customer. That figure
  // is the pack's whole-ledger balance and what a customer screen and a CRM
  // read show, so one hand correction could set it to any value. Round 1 of the
  // challenge had listed over-restoration among the laws it could not break;
  // under the replay it was absorbed, and the change had not been recorded.
  //
  // The bound is the row's own magnitude, less whatever earlier corrections of
  // it have already moved — see `F-23` below for why "the row's own magnitude"
  // and not "what a negative row took", which is what this first fix compared. It is NOT a partial-return rule: `§5.7.4`
  // leaves the quantity of a partial return to configuration, and this refuses
  // only a quantity larger than the movement it names. A `grant_over_restored`
  // guard exists in the patch request for the remainder relation, not for the
  // ledger, so the ledger-level counterpart is raised in §A.3c.3 too.
  // `F-23` — AND THE BOUND IS ON THE MAGNITUDE, NOT ON THE TARGET'S SIGN.
  //
  // The bound above was written inside `if (corrected.pointsDelta < 0n)`, so it
  // only ever compared a correction of a DRAW. `§1.4` lets `correctsId` name any
  // movement the ledger holds, and `validateDraft` admits it, so a correction
  // naming a POSITIVE row walked straight past the comparison and restored the
  // defect the bound was added for. A seventh challenge round measured it
  // through this very function, and both figures are reproduced in the suite:
  // naming the `earn` of a 100-earn / 40-consume ledger, 1 000 000 points were
  // ACCEPTED and the fold reported `balancePoints` **1 000 060** — byte for byte
  // the figure `F-21` was raised for; naming a standing grant of 10, 999 999
  // were accepted and the balance read **1 000 009**.
  //
  // The shape is not contrived: a merchant who UNDER-awarded on a sale has an
  // obvious reason to book a positive correction naming that earn. One further
  // fact that belongs with it, because no caller could discover it here: such a
  // correction is WITHHELD by the fold — an earn is in no draw, so there is
  // nothing to attribute it through — and it therefore credits the customer
  // nothing spendable. The route that works for an under-award is `§2.3`'s
  // standing grant, a positive `manual_adjustment` with `correctsId === null`,
  // which this writer deliberately does not build.
  //
  // `F-25` — AND THE BOUND IS OVER THE WHOLE CHAIN, NOT OVER ONE LINK.
  //
  // Both fixes above bound ONE link, and an eighth challenge round measured
  // that a chain of links had no bound at all. `§1.4` lets `correctsId` name
  // any movement the ledger holds and `validateDraft` admits a correction of an
  // `adjust`, so each link can name the PREVIOUS link — and for a freshly
  // appended correction nothing has moved that row yet, so every link passed
  // its own comparison and nothing bounded the sum. Measured through this
  // function alone, and reproduced in the suite (`balance / spendable /
  // withheld / eligible`):
  //
  //   20 links on a 100-point earn          2100 / 100 / 2000 / 100
  //   10 000 links on a 100-point earn   1000100 / 100 / 1000000 / 100
  //   2 links on a 1 000 000-point earn  3000000 / 1000000 / 2000000 / 1000000
  //
  // A balance of 2100 for a customer who has earned 100 — and TWO desk
  // corrections are enough, so the harm `F-21` was raised for ("one hand
  // correction could set it to any value") was closed for one hand and left
  // open for two. Redemption was never over-offered: the eligible figure is the
  // truth at every length, so this is an over-report, which is the class
  // `F-21` was accepted as a blocker on.
  //
  // THE CONDITION ACTUALLY TESTED, stated so no handoff sentence can be wider
  // than the code (`P13-AL-24`), and with NO branch around it:
  //
  //   let R be the ROOT of the chain the named row belongs to — follow
  //   `correctsId` upward, by the declared key, to the row that corrects
  //   nothing; let CHAIN be every movement of this party whose `correctsId`
  //   leads back to R; then this request is REFUSED when
  //
  //       | (sum of CHAIN's deltas) + this request's points |  >  | R's delta |
  //
  // So what a chain may move is the ROOT's own magnitude, net, however many
  // hands it passes through. The 20-link chain is refused at its second link; a
  // chain that alternates sign becomes lawful again once its net falls back
  // inside the root, which matters because `A-16`'s "the cancel was itself
  // wrong" is a real desk sequence and refusing a correction of a correction
  // outright would have refused it; and a root that moved nothing admits no
  // correction at all. It is still NOT a partial-return rule: `§5.7.4` leaves
  // the quantity of a partial return to configuration.
  //
  // TWO READS THAT COULD FAIL OPEN, AND BOTH ARE NAMED REFUSALS INSTEAD. The
  // upward walk is a read, and a read can be blinded: a chain whose next row is
  // not in this ledger for this party — hidden by RLS, filtered by a caller, or
  // simply absent — is refused `loyalty.corrects_chain_unreadable` rather than
  // treated as a root, because a root this function cannot see is not a bound.
  // And a cycle of corrections naming each other is buildable in the
  // `LoyaltyLedger` type (no writer here can build one, and `foldExpiry`
  // terminates on one because it never takes a second hop): the walk carries a
  // visited set and refuses `loyalty.corrects_cycle` rather than looping,
  // because a guard that hangs the till is worse than the report it fixes. The
  // downward collection cannot meet a cycle at all — it grows from a root, and
  // a root has no incoming correction.
  //
  // What this does NOT bind is a chain written past this writer, which `A-16`'s
  // desk correction can still do; the suite measures that figure rather than
  // claiming the shape is impossible, and §A.3c.3 asks the Migration Owner for
  // the half that can bind it, beside the direction and ordering items. A
  // `CHECK` cannot express any of the three.
  let root: LoyaltyMovement = corrected;
  const walked = new Set<string>([corrected.id]);
  while (root.correctsId !== null) {
    const next = byDeclaredKey(root.correctsId);
    if (next === undefined) {
      refuseLoyalty('loyalty.corrects_chain_unreadable', 'the chain this correction would join cannot be read to its root in this ledger', {
        correctsId: request.correctsId,
        missing: root.correctsId,
        readSoFar: String(walked.size),
      });
    }
    if (walked.has(next.id)) {
      refuseLoyalty('loyalty.corrects_cycle', 'the corrections this one would join form a cycle', {
        correctsId: request.correctsId,
        atRow: next.id,
      });
    }
    walked.add(next.id);
    root = next;
  }

  const chain = new Set<string>([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of ledger.movements) {
      if (!sameParty(m) || m.correctsId === null || chain.has(m.id)) continue;
      if (chain.has(m.correctsId)) {
        chain.add(m.id);
        grew = true;
      }
    }
  }

  const rootMagnitude = root.pointsDelta < 0n ? -root.pointsDelta : root.pointsDelta;
  const movedByChain = ledger.movements
    .filter((m) => sameParty(m) && m.correctsId !== null && chain.has(m.id))
    .reduce((acc, m) => acc + m.pointsDelta, 0n);
  const net = movedByChain + request.points;
  const netMagnitude = net < 0n ? -net : net;
  if (netMagnitude > rootMagnitude) {
    refuseLoyalty('loyalty.corrects_more_than_target', 'the corrections of one movement may not move more than that movement did', {
      correctsId: request.correctsId,
      rootId: root.id,
      rootPointsDelta: String(root.pointsDelta),
      rootMagnitude: String(rootMagnitude),
      movedByChain: String(movedByChain),
      requested: String(request.points),
      wouldBe: String(net),
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
