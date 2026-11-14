/**
 * The identity of an inbound webhook event, read OUT of the bytes the provider
 * signed — never from beside them.
 *
 * Both fields are needed, and the second one is the harder lesson. An earlier
 * version carried only the event id, and the finance review showed that a
 * tenant id taken from the route is unauthenticated: under a secret SHARED
 * across tenants — which is Meta's model, the model the body-only signature
 * scheme exists to accommodate — "the secret resolved for this business" is
 * the same bytes for every business, so the signature cannot tell them apart.
 * One genuine signed delivery, replayed at another tenant's route, verified.
 *
 * Downstream that is `business_id`, the FIRST column of the ledger's identity:
 * `UNIQUE (business_id, source_type, source_id)`
 * (`0042_accounting_journal.sql:148`) is satisfied once per business, each
 * takes its own advisory lock (`0045_accounting_post_entry.sql:720-721`), each
 * finds no existing entry (`:724-728`), and one signed delivery becomes one
 * posting in every tenant's ledger.
 *
 * So the payload's own account reference is extracted too, and the gate
 * refuses unless it equals the one the caller resolved the tenant from. The
 * invariant is no longer "the secret was resolved for this business" — which
 * is vacuous under a shared secret — but "the signed bytes name the same
 * account the caller resolved".
 */
export interface WebhookIdentity {
  /**
   * The provider's own account reference inside the signed payload — a Meta
   * WhatsApp Business Account id, a Stripe `account`, whatever that provider
   * calls the tenant. It is NOT this platform's business id, and the mapping
   * between them is a row this layer never reads.
   */
  readonly accountRef: string;
  readonly externalEventId: string;
  /**
   * The instant the PROVIDER signed inside the payload, in epoch
   * milliseconds, where the provider carries one.
   *
   * By the owner's decision of 2026-11-08 this is the economic truth of the
   * event, and the platform's arrival instant is recorded separately. It comes
   * out of the verified bytes like the rest of the identity, so it cannot be
   * supplied beside them; where the provider signs no instant the gate falls
   * back to arrival and says so in the verdict.
   */
  readonly signedInstantMs?: number;
}

/**
 * The longest external event id or account reference this boundary carries.
 * Providers' ids are short (Meta's `wamid.…` is well under a hundred
 * characters); a cap exists because both end up inside a key, and an uncapped
 * field an outside party controls is an uncapped row and an uncapped log line.
 */
export const MAX_IDENTITY_FIELD_LENGTH = 200;

/**
 * Printable ASCII with no space and no control character. The newline is the
 * point: the key is written to logs, and a field carrying `\n` forges a log
 * line. A value outside this shape is refused rather than sanitized, because
 * sanitizing would map two different ids onto one.
 *
 * This will refuse a legitimate non-ASCII provider id. The direction of that
 * error is a named refusal rather than a silent skip, which is the safe one,
 * and it is written here so the choice is visible rather than discovered.
 */
export const IDENTITY_FIELD_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${MAX_IDENTITY_FIELD_LENGTH}}$`);

export function isAcceptableIdentityField(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_FIELD_PATTERN.test(value);
}

/**
 * The replay identity: `(business_id, event_source, external_event_id)`.
 *
 * The same triple as the P8 contract (`docs/DAFTAR_WHATSAPP_ARCHITECTURE.md`
 * section 5: inbound webhook events are matched on it and a duplicate is
 * safely ignored), so this is agreement with an existing contract rather than
 * a new invention.
 *
 * It is derived from IDENTITY ALONE. Nothing about the attempt enters it — not
 * the time, not a retry counter, not the signature. A key that moved with the
 * attempt would make every redelivery a new event, which is how a payment
 * gets taken twice.
 *
 * The parts are length-prefixed rather than joined with a separator, so no
 * character a provider can put inside a field can make two different triples
 * collide.
 *
 * THIS IS NOT THE LEDGER'S `sourceId`, and must not be hashed into one. It is
 * a replay key for this boundary. The ledger's identity has its own
 * deterministic derivation, its own codomain (`source_id UUID NOT NULL`,
 * `0042_accounting_journal.sql:136`) and its own injectivity requirement, and
 * it is the money lane's to write.
 */
export function replayKeyOf(parts: {
  readonly businessId: string;
  readonly kind: string;
  readonly adapterKey: string;
  readonly externalEventId: string;
}): string {
  return [parts.businessId, parts.kind, parts.adapterKey, parts.externalEventId].map((p) => `${p.length}:${p}`).join('|');
}

/**
 * The canonical `event_source` string: `kind/adapterKey`.
 *
 * It is the composite and not the bare adapter key, because one provider is
 * registered under more than one service kind — the closed set carries both
 * `payment.platform_billing` and `payment.merchant_checkout` — and a bare key
 * puts two independent events in one replay namespace, where the second is
 * reported as a duplicate and a money event disappears behind a success.
 *
 * It is written here, in one place, because the string crosses a lane
 * boundary: the durable replay table's `event_source` column and the ledger's
 * `sourceId = f(event_source, external_event_id)` derivation must use THIS
 * definition. If one side composes and the other uses the bare key, the two
 * payment kinds separate at the boundary and collapse again at the ledger —
 * the same defect one layer down, and invisible, because each side is
 * internally consistent.
 *
 * Note what this function does NOT carry: the key built by `replayKeyOf` above
 * length-prefixes `kind` and `adapterKey` SEPARATELY rather than joining them
 * with this `/`. That is deliberate. The injectivity of this composite rests
 * on charsets validated elsewhere (the service-kind set, and an adapter key
 * pattern that excludes `/`), and the replay key must not depend on a check in
 * another file. So the readable composite is for the column and the contract;
 * the key is prefix-encoded and injective on its own terms.
 */
export function eventSourceOf(kind: string, adapterKey: string): string {
  return `${kind}/${adapterKey}`;
}
