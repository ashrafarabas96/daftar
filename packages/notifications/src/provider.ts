/**
 * The provider port. Everything that leaves the building goes through here, so
 * every adapter is replaceable and every test is deterministic.
 *
 * `idempotencyKey` is mandatory, not optional: the outbox is at-least-once by
 * design (publisher.ts says so in its own comment), so a provider adapter MUST
 * be able to recognise a repeat and not send a customer two receipts.
 */
import { refuse } from './errors';
import { classifyProviderError, type ProviderErrorCode } from './redaction';
import type { Channel, RenderedMessage } from './types';

export interface OutgoingMessage {
  readonly idempotencyKey: string;
  readonly channel: Channel;
  readonly to: { readonly phoneE164?: string; readonly email?: string };
  readonly rendered: RenderedMessage;
}

export type ProviderSendResult =
  | { readonly accepted: true; readonly providerMessageId: string }
  | { readonly accepted: false; readonly code: ProviderErrorCode };

export interface NotificationProvider {
  readonly name: string;
  readonly channels: readonly Channel[];
  /** True when the channel will only accept a pre-approved template (WhatsApp). */
  readonly requiresApprovedTemplate: boolean;
  send(message: OutgoingMessage): Promise<ProviderSendResult>;
}

/** E.164: '+' then 8–15 digits, first digit non-zero. No spaces, no dashes. */
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function assertAddressable(message: OutgoingMessage): void {
  if (message.channel === 'inapp') return;
  if (message.channel === 'email') {
    const email = message.to.email;
    if (email === undefined || email === '') refuse('notification.address_missing', 'email');
    if (!EMAIL.test(email)) refuse('notification.address_invalid', 'email');
    return;
  }
  const phone = message.to.phoneE164;
  if (phone === undefined || phone === '') refuse('notification.address_missing', message.channel);
  if (!E164.test(phone)) refuse('notification.address_invalid', message.channel);
}

/**
 * The single send path: validate the channel, the address and the template
 * requirement, then call the adapter and classify any throw into a SAFE code.
 * An adapter exception never escapes with its message — it may quote the
 * recipient's number or the token that failed.
 */
export async function sendThroughProvider(provider: NotificationProvider, message: OutgoingMessage): Promise<ProviderSendResult> {
  if (!provider.channels.includes(message.channel)) refuse('notification.provider_channel_unsupported', `${provider.name}/${message.channel}`);
  assertAddressable(message);
  if (provider.requiresApprovedTemplate && message.rendered.providerTemplate === undefined) {
    refuse('notification.provider_template_required', `${provider.name}/${message.channel}`);
  }
  try {
    return await provider.send(message);
  } catch (err) {
    return { accepted: false, code: classifyProviderError(err) };
  }
}

export type { ProviderErrorCode };
