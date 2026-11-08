/**
 * The fake provider. Not a stub for tests only — it is the adapter DAFTAR runs
 * until the WhatsApp Business credentials exist (master directive Part 66:
 * finish adapters and fakes, record the external blocker, continue).
 *
 * It is deterministic, and it is programmable in all three of the outcomes a
 * real provider can produce (PART 44/45), including the ambiguous one:
 *
 *   failWith    → `rejected` with a given class, proven not sent.
 *   unknownWith → `unknown`, while STILL RECORDING the delivery. That models
 *                 the dangerous case exactly: the provider took the message and
 *                 the caller never learnt it. A resend therefore shows up in
 *                 `deliveryCount()`, so a duplicate cannot pass a test quietly.
 *   throwOn     → a transport throw, to exercise classification.
 *
 * Dedupe is keyed on the LOGICAL DELIVERY key (TL-P8-R2 (2)), never the attempt
 * key, and only when `serverSideIdempotency` is on — a provider that does not
 * offer the guarantee must not appear to in a test.
 */
import type { NotificationProvider, OutgoingMessage, ProviderSendResult, UnknownReason } from '../provider';
import type { ProviderErrorCode } from '../redaction';
import { isTransient } from '../redaction';
import type { Channel } from '../types';

export interface FakeProviderOptions {
  readonly channels?: readonly Channel[];
  readonly requiresApprovedTemplate?: boolean;
  /** Default true. Set false to model WhatsApp Cloud's real guarantee: none. */
  readonly serverSideIdempotency?: boolean;
  /** Reject the next sends with these classes, in order, before succeeding. */
  readonly failWith?: readonly ProviderErrorCode[];
  /** Return `unknown` for the next sends, in order, while still recording them. */
  readonly unknownWith?: readonly UnknownReason[];
  /** Throw instead of returning a result, to exercise classification. */
  readonly throwOn?: readonly unknown[];
}

export class FakeNotificationProvider implements NotificationProvider {
  readonly name = 'fake';
  readonly channels: readonly Channel[];
  readonly requiresApprovedTemplate: boolean;
  readonly serverSideIdempotency: boolean;

  private readonly sent = new Map<string, OutgoingMessage>();
  private readonly order: string[] = [];
  /** Every message the provider actually took, retries included. */
  private readonly accepted: OutgoingMessage[] = [];
  private readonly failures: ProviderErrorCode[];
  private readonly unknowns: UnknownReason[];
  private readonly throws: unknown[];
  private sequence = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.channels = options.channels ?? ['whatsapp', 'sms', 'email', 'inapp'];
    this.requiresApprovedTemplate = options.requiresApprovedTemplate ?? false;
    this.serverSideIdempotency = options.serverSideIdempotency ?? true;
    this.failures = [...(options.failWith ?? [])];
    this.unknowns = [...(options.unknownWith ?? [])];
    this.throws = [...(options.throwOn ?? [])];
  }

  send(message: OutgoingMessage): Promise<ProviderSendResult> {
    if (this.throws.length > 0) {
      const err = this.throws.shift();
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      // Rejected means NOT SENT: nothing is recorded, so a retry is a first send.
      return Promise.resolve({ outcome: 'rejected', code: failure, retryable: isTransient(failure) });
    }

    const key = message.deliveryKey;
    if (this.serverSideIdempotency) {
      const existing = this.sent.get(key);
      if (existing) {
        // A repeat of a logical delivery already taken returns the SAME id and
        // records no second send: at-least-once delivery, once-only effect.
        return Promise.resolve({ outcome: 'accepted', providerMessageId: `fake-${this.indexOfKey(key)}` });
      }
    }

    this.sequence += 1;
    if (!this.sent.has(key)) {
      this.sent.set(key, message);
      this.order.push(key);
    }
    this.accepted.push(message);

    const reason = this.unknowns.shift();
    if (reason !== undefined) {
      // The provider HAS the message. The caller does not know it. This is the
      // whole of PART 44 in two lines.
      return Promise.resolve({ outcome: 'unknown', code: 'DELIVERY_FAILED', reason });
    }
    return Promise.resolve({ outcome: 'accepted', providerMessageId: `fake-${this.sequence}` });
  }

  private indexOfKey(key: string): number {
    return this.order.indexOf(key) + 1;
  }

  /** Distinct logical deliveries taken, in order. */
  deliveries(): readonly OutgoingMessage[] {
    return this.order.flatMap((key) => {
      const m = this.sent.get(key);
      return m ? [m] : [];
    });
  }

  deliveryCount(): number {
    return this.order.length;
  }

  /**
   * Every message the provider took, retries NOT collapsed. A duplicate
   * customer message shows up here and nowhere else, so this is what a
   * no-duplicate law must assert on.
   */
  acceptedMessages(): readonly OutgoingMessage[] {
    return this.accepted;
  }

  acceptedCount(): number {
    return this.accepted.length;
  }
}
