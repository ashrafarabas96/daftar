import { describe, expect, it } from 'vitest';
import { WhatsAppCloudProvider, type HttpPort, type WhatsAppCredentials } from '../src/providers/whatsapp-cloud';
import { NotificationRefusal } from '../src/errors';
import { sendThroughProvider, type OutgoingMessage } from '../src/provider';
import { renderNotification } from '../src/render';
import { dateFormatter, moneyFormatter } from './helpers';

const credentials: WhatsAppCredentials = { phoneNumberId: '1234567890', accessToken: 'EAAG-test-token', apiVersion: 'v21.0' };

class RecordingHttp implements HttpPort {
  readonly calls: { url: string; headers: Readonly<Record<string, string>>; body: unknown }[] = [];
  constructor(private readonly response: { status: number; body: unknown } | Error) {}
  postJson(url: string, headers: Readonly<Record<string, string>>, body: unknown): Promise<{ status: number; body: unknown }> {
    this.calls.push({ url, headers, body });
    if (this.response instanceof Error) return Promise.reject(this.response);
    return Promise.resolve(this.response);
  }
}

function message(): OutgoingMessage {
  const rendered = renderNotification({
    kind: 'invoice_issued',
    locale: 'ar',
    channel: 'whatsapp',
    vars: {
      customerName: { kind: 'text', text: 'أشرف' },
      invoiceNumber: { kind: 'text', text: 'INV-2026-000041' },
      invoiceTotal: { kind: 'money', money: { minor: '125000', currency: 'ILS' } },
    },
    moneyFormatter,
    dateFormatter,
  });
  return {
    deliveryKey: 'event:ev-1|invoice_issued|customer:c-1::whatsapp@daftar_invoice_issued',
    attemptKey: 'event:ev-1|invoice_issued|customer:c-1::whatsapp@daftar_invoice_issued#1',
    channel: 'whatsapp',
    to: { phoneE164: '+972591234567' },
    rendered,
  };
}

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof NotificationRefusal) return e.code;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('the official WhatsApp Cloud adapter', () => {
  const http = new RecordingHttp({ status: 200, body: { messages: [{ id: 'wamid.TEST' }] } });

  it('refuses to exist without credentials — no silent no-op provider', () => {
    expect(refusalOf(() => new WhatsAppCloudProvider(undefined, http))).toBe('notification.provider_not_configured');
    expect(refusalOf(() => new WhatsAppCloudProvider({ ...credentials, accessToken: '' }, http))).toBe('notification.provider_not_configured');
    expect(refusalOf(() => new WhatsAppCloudProvider({ ...credentials, phoneNumberId: '' }, http))).toBe('notification.provider_not_configured');
    expect(refusalOf(() => new WhatsAppCloudProvider({ ...credentials, apiVersion: '' }, http))).toBe('notification.provider_not_configured');
  });

  it('refuses an unofficial gateway host — no unofficial WhatsApp automation', () => {
    for (const baseUrl of ['https://wa-bridge.example.com', 'https://api.whatsapp-unofficial.io', 'https://localhost:3000']) {
      expect(
        refusalOf(() => new WhatsAppCloudProvider({ ...credentials, baseUrl }, http)),
        baseUrl,
      ).toBe('notification.provider_not_configured');
    }
  });

  it('refuses plaintext transport for a bearer token', () => {
    expect(refusalOf(() => new WhatsAppCloudProvider({ ...credentials, baseUrl: 'http://graph.facebook.com' }, http))).toBe(
      'notification.provider_not_configured',
    );
  });

  it('refuses a malformed base URL', () => {
    expect(refusalOf(() => new WhatsAppCloudProvider({ ...credentials, baseUrl: 'not a url' }, http))).toBe('notification.provider_not_configured');
  });

  it('accepts the official Graph host and builds the documented endpoint', async () => {
    const recorder = new RecordingHttp({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } });
    const provider = new WhatsAppCloudProvider(credentials, recorder);
    const result = await provider.send(message());
    expect(result).toEqual({ outcome: 'accepted', providerMessageId: 'wamid.ABC' });
    expect(recorder.calls[0]?.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(recorder.calls[0]?.headers['authorization']).toBe('Bearer EAAG-test-token');
  });

  it('sends an APPROVED TEMPLATE and never free prose', async () => {
    const recorder = new RecordingHttp({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } });
    await new WhatsAppCloudProvider(credentials, recorder).send(message());
    const body = recorder.calls[0]?.body as Record<string, unknown>;
    expect(body['type']).toBe('template');
    expect(body['text']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"body":"مرحبًا');
    expect(body['template']).toEqual({
      name: 'daftar_invoice_issued',
      language: { code: 'ar' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'أشرف' },
            { type: 'text', text: 'INV-2026-000041' },
            { type: 'text', text: '[ar]125000ILS' },
          ],
        },
      ],
    });
  });

  it('refuses to send a message with no provider template at all', async () => {
    const provider = new WhatsAppCloudProvider(credentials, http);
    const bare = message();
    const withoutTemplate: OutgoingMessage = { ...bare, rendered: { channel: 'whatsapp', locale: 'ar', subject: '', body: 'free prose' } };
    await expect(provider.send(withoutTemplate)).rejects.toBeInstanceOf(NotificationRefusal);
    // The same refusal arrives through the shared send path, before the adapter.
    await expect(sendThroughProvider(provider, withoutTemplate)).rejects.toMatchObject({ code: 'notification.provider_template_required' });
  });

  it('PART 42 — declares NO server-side idempotency, and the custom header is correlation only', async () => {
    const recorder = new RecordingHttp({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } });
    const provider = new WhatsAppCloudProvider(credentials, recorder);
    // Meta honours no idempotency key. Declaring `true` here would authorise an
    // automatic resend of an ambiguous send, which is a duplicate message.
    expect(provider.serverSideIdempotency).toBe(false);

    const m = message();
    await provider.send(m);
    const headers = recorder.calls[0]?.headers ?? {};
    // The header carries the STABLE logical delivery key, never the attempt key.
    expect(headers['x-daftar-delivery-key']).toBe(m.deliveryKey);
    expect(Object.values(headers)).not.toContain(m.attemptKey);
    // And no header pretends to be an idempotency key.
    expect(Object.keys(headers).join(',')).not.toMatch(/idempotency/i);
  });

  it('PART 45 — a definite 4xx/5xx is REJECTED, with retryability from the class and never from the text', async () => {
    const cases: readonly [number, unknown, string, boolean][] = [
      [401, { error: { message: 'Invalid OAuth access token' } }, 'PROVIDER_AUTH_FAILED', false],
      [429, { error: { message: 'rate limit hit' } }, 'PROVIDER_RATE_LIMITED', true],
      [503, { error: { message: 'service unavailable' } }, 'PROVIDER_UNAVAILABLE', true],
      [400, { error: { message: 'template name does not exist' } }, 'TEMPLATE_REJECTED', false],
      [400, { error: { message: 'not a valid whatsapp user' } }, 'RECIPIENT_REJECTED', false],
    ];
    for (const [status, body, expected, retryable] of cases) {
      const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp({ status, body }));
      const result = await provider.send(message());
      expect(result, `${status}`).toEqual({ outcome: 'rejected', code: expected, retryable });
    }
  });

  it('PART 45 — a definite retryable PRE-ACCEPT transport failure is rejected, not ambiguous', async () => {
    // A connection that was never established cannot have delivered anything.
    const refused = Object.assign(new Error('connect ECONNREFUSED 31.13.64.35:443'), { code: 'ECONNREFUSED' });
    const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp(refused));
    expect(await provider.send(message())).toEqual({ outcome: 'rejected', code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('PART 45 — a TIMEOUT AFTER SEND is ambiguous, and leaks nothing from its message', async () => {
    const leaky = Object.assign(new Error('connect ETIMEDOUT to +972591234567'), { code: 'ETIMEDOUT' });
    const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp(leaky));
    const result = await provider.send(message());
    expect(result).toEqual({ outcome: 'unknown', code: 'PROVIDER_TIMEOUT', reason: 'timeout_after_send' });
    expect(JSON.stringify(result)).not.toContain('972');
  });

  it('PART 45 — a 2xx WITHOUT a usable provider message id is UNKNOWN, never an acceptance', async () => {
    const malformed: readonly [string, unknown][] = [
      ['an empty messages array', { messages: [] }],
      ['an empty id', { messages: [{ id: '' }] }],
      ['a blank id', { messages: [{ id: '   ' }] }],
      ['a non-string id', { messages: [{ id: 12345 }] }],
      ['a message object with no id at all', { messages: [{}] }],
      ['messages that is not an array', { messages: { id: 'wamid.X' } }],
      ['no messages key', { success: true }],
      ['a body that is not an object', 'OK'],
      ['a null body', null],
    ];
    for (const [label, body] of malformed) {
      const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp({ status: 200, body }));
      const result = await provider.send(message());
      expect(result, label).toEqual({ outcome: 'unknown', code: 'DELIVERY_FAILED', reason: 'invalid_success_response' });
      // Specifically: never an empty provider id filed as a delivery.
      expect(JSON.stringify(result), label).not.toContain('providerMessageId');
    }
  });

  it('PART 45 — the shared send path refuses an empty id even if an adapter claimed acceptance', async () => {
    // A careless adapter cannot route around the guard: it exists in both places.
    const careless = {
      name: 'careless',
      channels: ['whatsapp'] as const,
      requiresApprovedTemplate: true,
      serverSideIdempotency: false,
      send: () => Promise.resolve({ outcome: 'accepted' as const, providerMessageId: '' }),
    };
    expect(await sendThroughProvider(careless, message())).toEqual({ outcome: 'unknown', code: 'DELIVERY_FAILED', reason: 'invalid_success_response' });
  });
});
