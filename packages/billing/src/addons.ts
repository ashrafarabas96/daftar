/**
 * Add-on pricing — what an add-on costs for one billing period.
 *
 * An add-on is a paid extension of a subscription: extra users, extra
 * branches, a metered bundle. It is NOT an entitlement of its own. Phase 1
 * already decided where capability lives: `plan_entitlements` for features
 * and `plan_limits` for limits, resolved through `entitlement_overrides` by
 * `EntitlementService`. An add-on that granted capability directly would be a
 * second entitlement truth, and Part 25 forbids one. So an add-on's effect on
 * what a merchant may DO is expressed as an override row at promotion, and
 * this module prices it and nothing more.
 *
 * ── Two kinds, and why there is no third ────────────────────────────────
 *
 * `flat` is a fixed amount per period and its quantity is exactly one. A flat
 * add-on with quantity 3 is three separate decisions pretending to be one
 * line, and the merchant cannot read what they bought.
 *
 * `per_unit` multiplies a unit price by an integer quantity. The quantity is
 * integer because every add-on the plan catalogue describes counts things —
 * users, branches, devices. A fractional quantity would need a fixed-scale
 * Quantity model, which Phase 1's money law explicitly defers rather than
 * letting `Money.times(fraction)` exist.
 *
 * A tiered or graduated price is a real commercial shape and is absent on
 * purpose: tiers are a POLICY (where the breaks are, whether a tier applies
 * to all units or only the ones inside it) and nobody has set it. Guessing it
 * would be guessing revenue.
 *
 * ── §21: an add-on may not sell a meter the system does not measure ─────
 *
 * The owner's ruling: "DO NOT SELL OR ENFORCE A METERED ADD-ON WHOSE USAGE
 * METER IS NOT REAL. No customer can be charged for a meter the system does
 * not measure." This is not a hypothetical in this codebase. `getUsage` in
 * `apps/api/src/modules/entitlements/entitlements.service.ts` measures three
 * keys — `MAX_USERS`, `MAX_BRANCHES`, `MAX_PRODUCTS` — and returns `0` from
 * its `default` branch for every other key, while `limit_definitions`
 * registers `MAX_STORAGE`, `MAX_AI_USAGE` and `MAX_WHATSAPP_USAGE`. A quota
 * check against a usage of zero always passes, so such a limit is sold,
 * invoiced, and never enforced — which from the merchant's side is identical
 * to a limit that works.
 *
 * So `priceAddOn` takes the set of keys that are ACTUALLY measured as a
 * REQUIRED argument and refuses any add-on granting a key outside it. The
 * argument is required rather than optional on purpose: an optional registry
 * is a bypass seam, and the one call site that forgot it would price exactly
 * the add-on this rule exists to stop. Passing an empty set refuses every
 * limit-granting add-on, so the failure direction of a caller that does not
 * know its meters is "nothing is sold", never "everything is".
 *
 * This module does not decide WHICH keys are measured. It is handed them, and
 * `test/addon-meters.test.ts` extracts the measured set from the live engine
 * so a fourth measured key there, or a regression that stops measuring one,
 * reds this package.
 */
import { proratedAmountMinor } from './proration';
import { refuse } from './errors';
import { MAX_ADDON_QUANTITY, MAX_BILLING_MINOR, type BillingPeriod, type Price } from './types';

export const ADDON_KINDS = ['flat', 'per_unit'] as const;
export type AddOnKind = (typeof ADDON_KINDS)[number];

export interface AddOnCharge {
  /** The catalogue key. An identifier; this module never interprets it. */
  readonly key: string;
  readonly kind: AddOnKind;
  /** For `flat`, the whole-period amount. For `per_unit`, the price of one unit. */
  readonly unitPrice: Price;
  /** Exactly 1 for `flat`. A non-negative integer for `per_unit`. */
  readonly quantity: number;
  /**
   * When the add-on starts inside the period, if it is not there for the whole
   * of it. Omitted means the whole period. Supplied as an instant, never
   * inferred from a clock.
   */
  readonly startsAt?: string;
  /**
   * The limit key this add-on raises, when it raises one. Omitted means the
   * add-on grants no limit (a feature add-on, or a pure service line), and
   * then §21 has nothing to say about it. When present it is checked against
   * the measured set and must be a key the system really meters.
   */
  readonly grantsLimitKey?: string;
}

export interface AddOnChargeResult {
  readonly key: string;
  readonly currency: string;
  /** The whole-period amount before any proration. */
  readonly fullAmountMinor: bigint;
  /** What is actually owed for this period. Equals `fullAmountMinor` when not prorated. */
  readonly amountMinor: bigint;
  readonly prorated: boolean;
  /**
   * The limit key this priced add-on raises, echoed back. Present only when
   * the add-on granted one AND that key is measured, because the refusal
   * below is the only other way out — so a caller reading this field is
   * reading a key whose meter is real.
   */
  readonly grantsLimitKey?: string;
}

/**
 * Price one add-on for one period.
 *
 * A quantity of zero is ALLOWED and yields zero. It is a real state — an
 * add-on a merchant has reduced to nothing but not yet removed — and
 * refusing it would push callers into deleting catalogue rows to express it.
 * `composeSubscriptionInvoice` is the layer that refuses a zero LINE, which
 * is the right place for that rule: a zero add-on simply contributes no line.
 */
export function priceAddOn(
  charge: AddOnCharge,
  period: BillingPeriod,
  /**
   * The limit keys the system actually measures. Required; see §21 above.
   */
  measuredLimitKeys: readonly string[],
): AddOnChargeResult {
  if (!charge || typeof charge.key !== 'string' || charge.key.trim().length === 0) {
    refuse('billing.payload_invalid', 'an add-on charge must name its catalogue key');
  }
  // Typed before it is validated: `Array.isArray` widens its argument to
  // `any[]` (see the note in `invoice.ts`).
  const measured: readonly string[] = measuredLimitKeys ?? [];
  if (!Array.isArray(measuredLimitKeys)) {
    refuse('billing.payload_invalid', 'pricing an add-on requires the set of limit keys the system measures', { addOnKey: charge.key });
  }
  if (charge.grantsLimitKey !== undefined) {
    if (typeof charge.grantsLimitKey !== 'string' || charge.grantsLimitKey.trim().length === 0) {
      refuse('billing.payload_invalid', 'a granted limit key must be a key, or absent', { addOnKey: charge.key });
    }
    if (!measured.includes(charge.grantsLimitKey)) {
      // §21. The refusal names the add-on and the key, and no amount: the
      // point is that this add-on may not be sold at all, not that a price
      // was wrong.
      refuse('billing.addon_meter_unmeasured', 'this add-on grants a limit whose usage the system does not measure', {
        addOnKey: charge.key,
        limitKey: charge.grantsLimitKey,
      });
    }
  }
  if (!(ADDON_KINDS as readonly string[]).includes(charge.kind)) {
    refuse('billing.addon_kind_unsupported', 'an add-on must be one of the priced kinds this slice implements', { addOnKey: charge.key });
  }
  const price = charge.unitPrice;
  if (!price || typeof price.amountMinor !== 'bigint' || price.amountMinor < 0n || price.amountMinor > MAX_BILLING_MINOR) {
    refuse('billing.price_invalid', "an add-on's unit price must be a non-negative exact integer within the money cap", { addOnKey: charge.key });
  }
  if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) {
    refuse('billing.price_invalid', "an add-on's unit price must carry a three-letter currency code", { addOnKey: charge.key });
  }
  if (!Number.isInteger(charge.quantity) || charge.quantity < 0 || charge.quantity > MAX_ADDON_QUANTITY) {
    refuse('billing.addon_quantity_invalid', 'an add-on quantity must be an integer within the per-line cap', { addOnKey: charge.key });
  }
  if (charge.kind === 'flat' && charge.quantity !== 1) {
    refuse('billing.addon_quantity_invalid', 'a flat add-on is one thing bought once; it has no quantity', { addOnKey: charge.key });
  }

  const fullAmountMinor = price.amountMinor * BigInt(charge.quantity);
  if (fullAmountMinor > MAX_BILLING_MINOR) {
    refuse('billing.price_invalid', "an add-on's whole-period amount exceeds the money cap", { addOnKey: charge.key, currency: price.currency });
  }

  const granted = charge.grantsLimitKey === undefined ? {} : { grantsLimitKey: charge.grantsLimitKey };

  if (charge.startsAt === undefined) {
    return { key: charge.key, currency: price.currency, fullAmountMinor, amountMinor: fullAmountMinor, prorated: false, ...granted };
  }
  const amountMinor = proratedAmountMinor({ amountMinor: fullAmountMinor, currency: price.currency }, period, charge.startsAt);
  return { key: charge.key, currency: price.currency, fullAmountMinor, amountMinor, prorated: true, ...granted };
}
