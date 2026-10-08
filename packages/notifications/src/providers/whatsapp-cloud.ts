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
 * Status (§36, stated narrowly): WHATSAPP ADAPTER CORE PREPARED / TESTED IN
 * ISOLATION. Phase 8 is NOT engineering-complete, and this adapter is not
 * either in any sense beyond its own unit tests: no credentials exist in this
 * project, nothing here has ever spoken to Meta, and the DB, RLS, API
 * composition, outbox integration, concurrency, webhook security, CI and
 * signatures all remain owed.
 */
import { refuse } from '../errors';
import type { NotificationProvider, OutgoingMessage, ProviderSendResult } from '../provider';
import { classifyProviderError } from '../redaction';
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
          // Meta does not offer a server-side idempotency key; the key travels
          // for correlation and the engine's own dedupe is authoritative.
          'x-daftar-idempotency-key': message.idempotencyKey,
        },
        payload,
      );
      if (response.status >= 200 && response.status < 300) {
        return { accepted: true, providerMessageId: readMessageId(response.body) };
      }
      return { accepted: false, code: classifyProviderError({ status: response.status, message: readErrorMessage(response.body) }) };
    } catch (err) {
      return { accepted: false, code: classifyProviderError(err) };
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
        if (typeof id === 'string' && id !== '') return id;
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
