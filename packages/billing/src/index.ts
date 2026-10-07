/**
 * `@daftar/billing` — Phase 5 (SaaS Billing, Plans, Limits, Add-ons,
 * Merchant Billing Portal), PREPARED / NOT PROMOTED.
 *
 * ── What this package is ────────────────────────────────────────────────
 *
 * The pure arithmetic and the ports of platform subscription billing: the
 * billing calendar, proration, add-on pricing, subscription-invoice
 * composition, the dunning schedule, and the payment-provider port with its
 * deterministic fake. Every function is total and deterministic, takes the
 * instant it is asked about, and returns a value or refuses with a typed
 * `BillingError`.
 *
 * ── What this package is NOT, and will not become ──────────────────────
 *
 * - It does not own entitlement. Phase 1 does, in `plan_entitlements`,
 *   `plan_limits`, `entitlement_overrides` and `EntitlementService`. Nothing
 *   here answers "may this merchant do X".
 * - It does not own subscription state. `business_entitlements.state` does.
 *   `types.ts` restates the value set and a test pins it to the live CHECK.
 * - It holds no SQL, allocates no migration number and describes no schema.
 *   What it needs from the database is a MIGRATION PATCH REQUEST, filed for
 *   the single Migration Owner, and no row of it is reserved.
 * - It posts nothing. Platform subscription revenue is the platform's own
 *   accounting and belongs to the one financial authority, not to a prepared
 *   slice.
 * - It reads no clock, opens no connection, and imports no framework.
 */
export * from './errors';
export * from './types';
export * from './period';
export * from './proration';
export * from './addons';
export * from './invoice';
export * from './dunning';
export * from './ports';
export * from './fake-provider';
