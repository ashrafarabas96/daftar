/**
 * The inbound webhook request, as bytes.
 *
 * `rawBody` is the body AS IT ARRIVED. It is a `Buffer` and not a string on
 * purpose: the signature is computed over these bytes, and a string that has
 * been parsed and re-serialized is a different sequence of bytes with the same
 * meaning — which either breaks a valid signature or, far worse, validates
 * something the provider never signed.
 *
 * NOTE WHAT IS NOT IN HERE: the external event id. An earlier version of this
 * type carried it as a field, and the finance review showed why that is a
 * money defect rather than an awkward shape. The signature covers
 * `timestamp . rawBody` and nothing else, so an id passed ALONGSIDE the body
 * is unauthenticated: one genuine, validly signed delivery replayed with a
 * mutated id verifies, keys to a different identity, and is accepted as a NEW
 * event. Downstream, the ledger's own identity is a deterministic function of
 * `(event_source, external_event_id)`, so distinct ids become distinct
 * `(business_id, source_type, source_id)` triples; each one satisfies
 * `UNIQUE (business_id, source_type, source_id)`
 * (`0042_accounting_journal.sql:148`), takes its own advisory lock
 * (`0045_accounting_post_entry.sql:720-721`), finds no existing entry
 * (`:724-728`) and posts a second balanced entry the ledger cannot see as a
 * duplicate. The id must therefore come OUT of the verified bytes, which is
 * what the gate's extractor does, after the signature has passed.
 *
 * `businessId` and `eventSource` remain inputs, and they are route and adapter
 * facts, not payload: `eventSource` is the adapter's own key in code, and
 * `businessId` is the one the CALLER resolved the secret for. That last point
 * is a precondition this type cannot enforce: hand the gate business A's id
 * with business B's secret and the key will say A. The caller must read both
 * from the same resolution.
 */
export interface RawWebhookRequest {
  readonly businessId: string;
  readonly eventSource: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
}

/**
 * The longest external event id this boundary will carry. Providers' ids are
 * short (Meta's `wamid.…` is well under a hundred characters); a cap exists
 * because the id ends up inside a key, and an uncapped field an outside party
 * controls is an uncapped row and an uncapped log line.
 */
export const MAX_EXTERNAL_EVENT_ID_LENGTH = 200;

/**
 * Printable ASCII with no space and no control character. The newline is the
 * point: the key is written to logs, and an id carrying `\n` forges a log
 * line. A provider id outside this shape is refused rather than sanitized,
 * because sanitizing would map two different ids onto one.
 */
export const EXTERNAL_EVENT_ID_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${MAX_EXTERNAL_EVENT_ID_LENGTH}}$`);

export function isAcceptableExternalEventId(value: unknown): value is string {
  return typeof value === 'string' && EXTERNAL_EVENT_ID_PATTERN.test(value);
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
 * attempt would make every redelivery a new event, which is precisely how a
 * payment gets taken twice.
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
export function replayKeyOf(parts: { readonly businessId: string; readonly eventSource: string; readonly externalEventId: string }): string {
  return [parts.businessId, parts.eventSource, parts.externalEventId].map((p) => `${p.length}:${p}`).join('|');
}

/**
 * The store of events already seen.
 *
 * This is a PORT, and the only implementation in this slice is the in-memory
 * one below, which is for tests. The durable one is a table with
 * `UNIQUE(business_id, event_source, external_event_id)` whose migration is
 * neither written nor numbered here: the design loads that same table with
 * columns that bind an event to the ledger, which makes it a money migration
 * owned by the finance lane, and its number must be reserved before the file
 * is written.
 *
 * TWO OBLIGATIONS ON ANY DURABLE IMPLEMENTATION, both from the review and
 * neither expressible in this signature:
 *
 *  1. `remember` is the WRITE-AHEAD row, and it must be in the SAME database
 *     transaction as the queue insert that follows it. As written, the gate
 *     claims the key and returns; a process that dies between the claim and
 *     the enqueue has lost the event for good, because the next delivery sees
 *     `replay` and the caller has nothing queued. One transaction, or the
 *     at-least-once queue cannot save it.
 *  2. It must be `INSERT … ON CONFLICT DO NOTHING` and report whether a row
 *     was written — never `SELECT` then `INSERT`. Two legitimate concurrent
 *     deliveries of the same event would both read "absent" and both proceed.
 */
export interface ReplayStore {
  /** Records the key. Returns false when it was ALREADY there (a replay). */
  remember(key: string): Promise<boolean>;
  /** True for a store that must never run in production. */
  readonly isTestDouble: boolean;
}

export class InMemoryReplayStore implements ReplayStore {
  readonly isTestDouble = true;

  private readonly seen = new Set<string>();

  async remember(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}
