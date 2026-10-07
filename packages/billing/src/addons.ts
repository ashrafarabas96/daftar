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
}

export interface AddOnChargeResult {
  readonly key: string;
  readonly currency: string;
  /** The whole-period amount before any proration. */
  readonly fullAmountMinor: bigint;
  /** What is actually owed for this period. Equals `fullAmountMinor` when not prorated. */
  readonly amountMinor: bigint;
  readonly prorated: boolean;
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
export function priceAddOn(charge: AddOnCharge, period: BillingPeriod): AddOnChargeResult {
  if (!charge || typeof charge.key !== 'string' || charge.key.trim().length === 0) {
    refuse('billing.payload_invalid', 'an add-on charge must name its catalogue key');
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

  if (charge.startsAt === undefined) {
    return { key: charge.key, currency: price.currency, fullAmountMinor, amountMinor: fullAmountMinor, prorated: false };
  }
  const amountMinor = proratedAmountMinor({ amountMinor: fullAmountMinor, currency: price.currency }, period, charge.startsAt);
  return { key: charge.key, currency: price.currency, fullAmountMinor, amountMinor, prorated: true };
}
