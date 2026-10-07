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
  return { idempotencyKey: 'ev-1:invoice_issued:whatsapp', channel: 'whatsapp', to: { phoneE164: '+972591234567' }, rendered };
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
    expect(result).toEqual({ accepted: true, providerMessageId: 'wamid.ABC' });
    expect(recorder.calls[0]?.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(recorder.calls[0]?.headers['authorization']).toBe('Bearer EAAG-test-token');
    expect(recorder.calls[0]?.headers['x-daftar-idempotency-key']).toBe('ev-1:invoice_issued:whatsapp');
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

  it('classifies Meta HTTP failures into safe codes', async () => {
    const cases: readonly [number, unknown, string][] = [
      [401, { error: { message: 'Invalid OAuth access token' } }, 'PROVIDER_AUTH_FAILED'],
      [429, { error: { message: 'rate limit hit' } }, 'PROVIDER_RATE_LIMITED'],
      [503, { error: { message: 'service unavailable' } }, 'PROVIDER_UNAVAILABLE'],
      [400, { error: { message: 'template name does not exist' } }, 'TEMPLATE_REJECTED'],
      [400, { error: { message: 'not a valid whatsapp user' } }, 'RECIPIENT_REJECTED'],
    ];
    for (const [status, body, expected] of cases) {
      const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp({ status, body }));
      const result = await provider.send(message());
      expect(result, `${status}`).toEqual({ accepted: false, code: expected });
    }
  });

  it('classifies a transport throw and leaks nothing from its message', async () => {
    const leaky = Object.assign(new Error('connect ETIMEDOUT to +972591234567'), { code: 'ETIMEDOUT' });
    const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp(leaky));
    const result = await provider.send(message());
    expect(result).toEqual({ accepted: false, code: 'PROVIDER_TIMEOUT' });
    expect(JSON.stringify(result)).not.toContain('972');
  });

  it('returns an empty provider id rather than inventing one when Meta omits it', async () => {
    const provider = new WhatsAppCloudProvider(credentials, new RecordingHttp({ status: 200, body: { messages: [] } }));
    expect(await provider.send(message())).toEqual({ accepted: true, providerMessageId: '' });
  });
});
