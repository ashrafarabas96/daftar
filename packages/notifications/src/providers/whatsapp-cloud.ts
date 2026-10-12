/**
 * The OFFICIAL WhatsApp provider: Meta's WhatsApp Cloud API, and nothing else.
 *
 * Part 28 of the master directive: "Use official provider only when credentials
 * available. No unofficial WhatsApp automation." This adapter enforces both:
 *  - it REFUSES to be constructed without credentials, so there is no silent
 *    fallback that looks configured and sends nothing;
 *  - it REFUSES any base URL that is not Meta's official Graph host, so an
 *    unofficial bridge/web-automation gateway cannot be configured in by
 *    editing an environment variable.
 *
 * It sends TEMPLATE messages only. Outside the 24-hour service window the Cloud
 * API accepts nothing else, and a notification engine cannot know from here
 * whether a window is open — so the safe shape is the only shape.
 *
 * PART 42 (a HIGH finding against the earlier version of this file): the custom
 * request header below is NOT a Meta server-side idempotency mechanism. Meta
 * does not interpret it. The earlier code passed an ATTEMPT key in it and the
 * engine then treated an ambiguous timeout as retryable, which is a duplicate
 * customer message. So this adapter now declares `serverSideIdempotency =
 * false`, carries the STABLE logical delivery key for correlation only, and
 * never reports an acceptance it cannot evidence.
 *
 * Status (§36, stated narrowly): WHATSAPP ADAPTER CORE PREPARED / TESTED IN
 * ISOLATION. Phase 8 is NOT engineering-complete, and this adapter is not
 * either in any sense beyond its own unit tests: no credentials exist in this
 * project, nothing here has ever spoken to Meta, and the DB, RLS, API
 * composition, outbox integration, concurrency, webhook security, CI and
 * signatures all remain owed.
 */
import { refuse } from '../errors';
import { classifyTransportThrow, type NotificationProvider, type OutgoingMessage, type ProviderSendResult } from '../provider';
import { classifyProviderError, isTransient } from '../redaction';
import type { Channel } from '../types';

/** The only hosts Meta serves the Cloud API from. */
const OFFICIAL_HOSTS: readonly string[] = ['graph.facebook.com'];

export interface WhatsAppCredentials {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  /** e.g. 'v21.0'. */
  readonly apiVersion: string;
  /** Defaults to https://graph.facebook.com. Any other host is refused. */
  readonly baseUrl?: string;
}

/** Minimal HTTP port: no fetch, no axios, no network inside this package. */
export interface HttpPort {
  postJson(url: string, headers: Readonly<Record<string, string>>, body: unknown): Promise<{ readonly status: number; readonly body: unknown }>;
}

export class WhatsAppCloudProvider implements NotificationProvider {
  readonly name = 'whatsapp_cloud';
  readonly channels: readonly Channel[] = ['whatsapp'];
  readonly requiresApprovedTemplate = true;
  /**
   * PART 42. Meta's Cloud API offers no idempotency key the server honours, so
   * an ambiguous result here may NEVER be auto-resent. Declaring this false is
   * what makes `mayAutoRetry` refuse; a `true` here would be a lie that costs a
   * customer a second message.
   */
  readonly serverSideIdempotency = false;

  private readonly endpoint: string;
  private readonly token: string;

  constructor(
    credentials: WhatsAppCredentials | undefined,
    private readonly http: HttpPort,
  ) {
    if (!credentials || credentials.phoneNumberId === '' || credentials.accessToken === '' || credentials.apiVersion === '') {
      refuse('notification.provider_not_configured', 'whatsapp_cloud');
    }
    const base = credentials.baseUrl ?? 'https://graph.facebook.com';
    let host: string;
    let protocol: string;
    try {
      const url = new URL(base);
      host = url.host;
      protocol = url.protocol;
    } catch {
      refuse('notification.provider_not_configured', 'whatsapp_cloud: baseUrl');
    }
    // No unofficial gateway, and no plaintext transport for an access token.
    if (protocol !== 'https:' || !OFFICIAL_HOSTS.includes(host)) {
      refuse('notification.provider_not_configured', `whatsapp_cloud: unofficial host ${host}`);
    }
    this.endpoint = `${base.replace(/\/+$/, '')}/${credentials.apiVersion}/${credentials.phoneNumberId}/messages`;
    this.token = credentials.accessToken;
  }

  async send(message: OutgoingMessage): Promise<ProviderSendResult> {
    const template = message.rendered.providerTemplate;
    if (template === undefined) refuse('notification.provider_template_required', 'whatsapp_cloud');
    const to = message.to.phoneE164;
    if (to === undefined) refuse('notification.address_missing', 'whatsapp');

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.locale },
        components: [
          {
            type: 'body',
            parameters: template.parameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };

    try {
      const response = await this.http.postJson(
        this.endpoint,
        {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          // CORRELATION ONLY (PART 42). Meta does not interpret this header, so
          // it confers no idempotency. It carries the STABLE logical delivery
          // key — not an attempt key — so that a support trace of a retried
          // send groups under one value instead of looking like two sends.
          'x-daftar-delivery-key': message.deliveryKey,
        },
        payload,
      );
      if (response.status >= 200 && response.status < 300) {
        const id = readMessageId(response.body);
        // PART 45: a 2xx without a valid non-empty provider message id is NOT
        // a delivery. It is not a failure either — the message may well have
        // been sent. Returning `unknown` is the only honest answer, and it is
        // what stops both a fabricated success and a blind resend.
        if (id === '') return { outcome: 'unknown', code: 'DELIVERY_FAILED', reason: 'invalid_success_response' };
        return { outcome: 'accepted', providerMessageId: id };
      }
      // A non-2xx from Meta is an answer: the message was definitively not
      // accepted. Only the transient classes may be attempted again.
      const code = classifyProviderError({ status: response.status, message: readErrorMessage(response.body) });
      return { outcome: 'rejected', code, retryable: isTransient(code) };
    } catch (err) {
      return classifyTransportThrow(err);
    }
  }
}

/** { messages: [ { id } ] } — read defensively; never trust the shape. */
function readMessageId(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'messages' in body) {
    const messages = (body as { messages: unknown }).messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const first: unknown = messages[0];
      if (typeof first === 'object' && first !== null && 'id' in first) {
        const id = (first as { id: unknown }).id;
        if (typeof id === 'string' && id.trim() !== '') return id;
      }
    }
  }
  return '';
}

/** Meta's error envelope, reduced to a short string for CLASSIFICATION only.
 *  The text is never persisted or returned — only the resulting safe code is. */
function readErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === 'string') return message.slice(0, 200);
    }
  }
  return '';
}
