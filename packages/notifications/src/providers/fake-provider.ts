/**
 * The fake provider. Not a stub for tests only — it is the adapter DAFTAR runs
 * until the WhatsApp Business credentials exist (master directive Part 66:
 * finish adapters and fakes, record the external blocker, continue).
 *
 * It is deterministic, it enforces idempotency the way a real provider is
 * expected to, and it can be told to fail with any provider error class so the
 * retry and dead-letter paths are exercised against real behaviour.
 */
import type { NotificationProvider, OutgoingMessage, ProviderSendResult } from '../provider';
import type { ProviderErrorCode } from '../redaction';
import type { Channel } from '../types';

export interface FakeProviderOptions {
  readonly channels?: readonly Channel[];
  readonly requiresApprovedTemplate?: boolean;
  /** Fail the next sends with these classes, in order, before succeeding. */
  readonly failWith?: readonly ProviderErrorCode[];
  /** Throw instead of returning a result, to exercise classification. */
  readonly throwOn?: readonly unknown[];
}

export class FakeNotificationProvider implements NotificationProvider {
  readonly name = 'fake';
  readonly channels: readonly Channel[];
  readonly requiresApprovedTemplate: boolean;

  private readonly sent = new Map<string, OutgoingMessage>();
  private readonly order: string[] = [];
  private readonly failures: ProviderErrorCode[];
  private readonly throws: unknown[];
  private sequence = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.channels = options.channels ?? ['whatsapp', 'sms', 'email', 'inapp'];
    this.requiresApprovedTemplate = options.requiresApprovedTemplate ?? false;
    this.failures = [...(options.failWith ?? [])];
    this.throws = [...(options.throwOn ?? [])];
  }

  send(message: OutgoingMessage): Promise<ProviderSendResult> {
    if (this.throws.length > 0) {
      const err = this.throws.shift();
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.resolve({ accepted: false, code: failure });

    const existing = this.sent.get(message.idempotencyKey);
    if (existing) {
      // A repeat of a key already accepted returns the SAME provider id and
      // does not record a second send: at-least-once delivery, once-only effect.
      return Promise.resolve({ accepted: true, providerMessageId: `fake-${this.indexOfKey(message.idempotencyKey)}` });
    }
    this.sequence += 1;
    this.sent.set(message.idempotencyKey, message);
    this.order.push(message.idempotencyKey);
    return Promise.resolve({ accepted: true, providerMessageId: `fake-${this.sequence}` });
  }

  private indexOfKey(key: string): number {
    return this.order.indexOf(key) + 1;
  }

  /** Everything accepted, in send order. Tests assert on this, not on logs. */
  deliveries(): readonly OutgoingMessage[] {
    return this.order.flatMap((key) => {
      const m = this.sent.get(key);
      return m ? [m] : [];
    });
  }

  deliveryCount(): number {
    return this.order.length;
  }
}
