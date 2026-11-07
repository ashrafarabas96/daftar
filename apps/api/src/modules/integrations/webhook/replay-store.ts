/**
 * The inbound webhook request, as bytes.
 *
 * `rawBody` is the body AS IT ARRIVED. It is a `Buffer` and not a string on
 * purpose: the signature is computed over these bytes, and a string that has
 * been parsed and re-serialized is a different sequence of bytes with the same
 * meaning — which either breaks a valid signature or, far worse, validates
 * something the provider never signed.
 */
export interface RawWebhookRequest {
  readonly businessId: string;
  readonly eventSource: string;
  readonly externalEventId: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
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
 * payment gets taken twice (`TH-04`).
 *
 * The parts are length-prefixed rather than joined with a separator, so no
 * character a provider can put inside a field can make two different triples
 * collide.
 */
export function replayKeyOf(r: Pick<RawWebhookRequest, 'businessId' | 'eventSource' | 'externalEventId'>): string {
  return [r.businessId, r.eventSource, r.externalEventId].map((p) => `${p.length}:${p}`).join('|');
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
 */
export interface ReplayStore {
  /** Records the key. Returns false when it was ALREADY there (a replay). */
  remember(key: string): Promise<boolean>;
}

export class InMemoryReplayStore implements ReplayStore {
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
