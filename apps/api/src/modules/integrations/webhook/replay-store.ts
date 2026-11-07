/**
 * The inbound webhook request, as bytes.
 *
 * `rawBody` is the body AS IT ARRIVED. It is a `Buffer` and not a string on
 * purpose: the signature is computed over these bytes, and a string that has
 * been parsed and re-serialized is a different sequence of bytes with the same
 * meaning — which either breaks a valid signature or, far worse, validates
 * something the provider never signed.
 *
 * NOTE WHAT IS NOT IN HERE: the external event id, and the provider's account
 * reference. Both are read out of the verified bytes instead (see
 * `./identity`), because a field passed ALONGSIDE the body is not covered by
 * the signature. `eventSource` is not here either — it is the resolved
 * adapter's own key, so it cannot disagree with the rule used to read the
 * payload.
 *
 * What remains is `businessId`, this platform's own tenant id, which no
 * provider knows, and `expectedAccountRef`, the provider-side account the
 * caller resolved that tenant FROM. The gate refuses unless the signed bytes
 * name that same account, which is what authenticates the tenant.
 */
export interface RawWebhookRequest {
  readonly businessId: string;
  readonly expectedAccountRef: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
}

/**
 * The store of events already seen.
 *
 * This is a PORT, and the only implementation in this slice is the in-memory
 * one below, which is for tests. The durable one is a table with
 * `UNIQUE(business_id, event_source, external_event_id)`, and its number is
 * RESERVED but its file is not written: `0087`, reserved by the owner's order
 * of 2026-11-08 in `.local-context/LANES.md`, and owned by the finance lane
 * because the design loads that same table with columns that bind an event to
 * the ledger. Its `event_source` column takes the composite of
 * `eventSourceOf`, by the same decision.
 *
 * THREE OBLIGATIONS ON ANY DURABLE IMPLEMENTATION, none of them expressible in
 * this signature — two from review and one from the owner:
 *
 *  1. `remember` is the WRITE-AHEAD row, and it must be in the SAME database
 *     transaction as the queue insert that follows it. As written, the gate
 *     claims the key and returns; a process that dies between the claim and
 *     the enqueue has lost the event for good, because the next delivery sees
 *     `replay` and the caller has nothing queued. One transaction, or the
 *     at-least-once queue cannot save it.
 *  2. The `UNIQUE(business_id, event_source, external_event_id)` constraint
 *     STAYS, ALWAYS. By the owner's decision of 2026-11-08 it is never
 *     exempted from any retention prune and never dropped, because where the
 *     provider does not sign a timestamp it is the only defence against an
 *     unbounded replay of a genuinely signed body. A prune that drops old rows
 *     does not merely lose history: it makes every pruned event replayable.
 *  3. It must be `INSERT … ON CONFLICT DO NOTHING` and report whether a row
 *     was written — never `SELECT` then `INSERT`. Two legitimate concurrent
 *     deliveries of the same event would both read "absent" and both proceed.
 */
export interface ReplayStore {
  /** Records the key. Returns false when it was ALREADY there (a replay). */
  remember(key: string): Promise<boolean>;
  /** True for a store that must never run in production. */
  readonly isTestDouble: boolean;
}

/**
 * For tests only, and it says so in a field the gate reads.
 *
 * Replay prevention is mandatory under EVERY signature scheme, and this store
 * does not provide it: it forgets on restart and is not shared between
 * instances, so the same delivery arriving at a second process is a first
 * delivery. The gate refuses it in production for that reason alone, and
 * refuses it outside production too whenever the signature does not bind a
 * timestamp, because the store is then the only defence left standing.
 */
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
