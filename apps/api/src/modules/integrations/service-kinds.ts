/**
 * The closed set of service kinds an adapter may claim.
 *
 * Transcribed from the ADR draft 3.1 (`ADR_PROVIDER_ADAPTERS_AR.md`), which
 * states that the set is closed and that adding a kind is a documented
 * decision. Nothing here invents a kind, and the owning phase of each one is
 * recorded beside it so that a later phase cannot quietly adopt another's.
 */
export const SERVICE_KINDS = [
  'notification.whatsapp', // P8
  'notification.sms', // P8
  'notification.email', // P8 (and P1 for credentials, which stays separate)
  'payment.platform_billing', // P5
  'payment.merchant_checkout', // P6
  'fx.rates', // P14, and an accounting decision
  'webhook.inbound', // P14 owns the framework, each phase its provider
] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === 'string' && (SERVICE_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds whose events bear on money, and therefore may never ride a
 * signature scheme that does not bind a timestamp (the owner's decision of
 * 2026-11-08).
 *
 * A SET against the closed list, not a `payment.` prefix. The finance review
 * asked for this and the reason is not style: a prefix is a convention about
 * naming, so a future kind called `billing.*` or `payments.*` would fall
 * outside the law in silence, and every other check in this layer tests
 * membership of the frozen array instead.
 *
 * `fx.rates` is in the set, and it is the one a prefix missed. A rate is not a
 * posting, but the ledger recomputes `base_amount_minor` from the rate it is
 * given, and the design makes foreign exchange a duty the ledger imposes
 * (8.3.2) with `NC-M8` forbidding any posting at a rate of one. A replayed or
 * stale rate therefore moves the amount on every line posted against it, which
 * is a money effect whatever the route.
 */
export const MONEY_BEARING_SERVICE_KINDS = ['payment.platform_billing', 'payment.merchant_checkout', 'fx.rates'] as const satisfies readonly ServiceKind[];

/**
 * The rest, named explicitly rather than left as "everything else", so that
 * adding a kind to `SERVICE_KINDS` without deciding which side it falls on
 * fails a test instead of quietly joining the exempt majority.
 */
export const NON_MONEY_BEARING_SERVICE_KINDS = [
  'notification.whatsapp',
  'notification.sms',
  'notification.email',
  'webhook.inbound',
] as const satisfies readonly ServiceKind[];

export function isMoneyBearingServiceKind(kind: ServiceKind): boolean {
  return (MONEY_BEARING_SERVICE_KINDS as readonly string[]).includes(kind);
}
