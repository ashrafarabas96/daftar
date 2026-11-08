import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyProviderCallback,
  reconcileFromCallback,
  HmacSha256WebhookVerifier,
  RefuseAllWebhooks,
  type ProviderCallback,
  type RawWebhookRequest,
} from '../src/webhook';

const SECRET = 'app-secret-for-tests-only';
const verifier = new HmacSha256WebhookVerifier(SECRET);

const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.A', status: 'delivered' }] } }] }] });

function signed(raw = body, secret = SECRET): RawWebhookRequest {
  return { rawBody: raw, signatureHeader: `sha256=${createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')}` };
}

const callback = (over: Partial<ProviderCallback> = {}): ProviderCallback => ({
  providerMessageId: 'wamid.A',
  status: 'delivered',
  ...over,
});

describe('PART 48 — the verdict is computed here, never asserted by the caller', () => {
  it('the callback type carries no verification flag at all', () => {
    // A boolean a caller can set is a boolean an attacker can set. The only
    // route to `applied` is a verifier that recomputed the digest.
    expect(Object.keys(callback())).not.toContain('signatureVerified');
  });

  it('applies a verified, fresh, forward transition', () => {
    expect(applyProviderCallback(callback(), signed(), verifier, { current: 'sent' })).toEqual({ action: 'applied', status: 'delivered' });
  });

  it('records and moves nothing when the signature is absent', () => {
    expect(applyProviderCallback(callback(), { rawBody: body, signatureHeader: undefined }, verifier, { current: 'sent' })).toEqual({
      action: 'recorded_only',
      reason: 'signature_unverified',
      verificationReason: 'signature_missing',
    });
  });

  it('records and moves nothing when the signature is for a DIFFERENT body', () => {
    const tampered: RawWebhookRequest = { rawBody: body.replace('delivered', 'failed'), signatureHeader: signed().signatureHeader };
    expect(applyProviderCallback(callback({ status: 'failed' }), tampered, verifier, { current: 'queued' })).toEqual({
      action: 'recorded_only',
      reason: 'signature_unverified',
      verificationReason: 'signature_mismatch',
    });
  });

  it('records and moves nothing when the signature was made with another secret', () => {
    expect(applyProviderCallback(callback(), signed(body, 'someone-elses-secret'), verifier, { current: 'sent' })).toMatchObject({
      action: 'recorded_only',
      verificationReason: 'signature_mismatch',
    });
  });

  it('an unconfigured secret verifies NOTHING — it never falls back to trusting the caller', () => {
    const unconfigured = new HmacSha256WebhookVerifier(undefined);
    expect(applyProviderCallback(callback(), signed(), unconfigured, { current: 'sent' })).toEqual({
      action: 'recorded_only',
      reason: 'signature_unverified',
      verificationReason: 'secret_not_configured',
    });
    expect(new HmacSha256WebhookVerifier('').verify(signed())).toEqual({ verified: false, reason: 'secret_not_configured' });
  });

  it('refuses a malformed header rather than guessing at it', () => {
    expect(verifier.verify({ rawBody: body, signatureHeader: 'deadbeef' })).toEqual({ verified: false, reason: 'signature_malformed' });
    expect(verifier.verify({ rawBody: body, signatureHeader: 'sha256=not-hex!' })).toEqual({ verified: false, reason: 'signature_malformed' });
    expect(verifier.verify({ rawBody: body, signatureHeader: 'sha256=' })).toEqual({ verified: false, reason: 'signature_malformed' });
  });

  it('a short or long digest is rejected, not thrown on (timingSafeEqual throws on a length mismatch)', () => {
    expect(() => verifier.verify({ rawBody: body, signatureHeader: 'sha256=abcd' })).not.toThrow();
    expect(verifier.verify({ rawBody: body, signatureHeader: 'sha256=abcd' })).toEqual({ verified: false, reason: 'signature_mismatch' });
  });

  it('verifies the RAW bytes: a Uint8Array body and the identical string body both verify', () => {
    const raw = signed();
    expect(verifier.verify({ rawBody: new TextEncoder().encode(body), signatureHeader: raw.signatureHeader })).toEqual({ verified: true });
  });

  it('is case-insensitive about the hex the provider sends', () => {
    const upper = `sha256=${(signed().signatureHeader ?? '').slice('sha256='.length).toUpperCase()}`;
    expect(verifier.verify({ rawBody: body, signatureHeader: upper })).toEqual({ verified: true });
  });

  it('the shipped default refuses every callback', () => {
    expect(new RefuseAllWebhooks().verify()).toEqual({ verified: false, reason: 'secret_not_configured' });
  });
});

describe('PART 48 — replay, monotonicity and what is kept', () => {
  it('applies a provider event id once — a redelivery changes nothing', () => {
    const cb = callback({ providerEventId: 'evt-77', status: 'read' });
    expect(applyProviderCallback(cb, signed(), verifier, { current: 'delivered' })).toEqual({ action: 'applied', status: 'read' });
    expect(applyProviderCallback(cb, signed(), verifier, { current: 'delivered', appliedEventIds: new Set(['evt-77']) })).toEqual({
      action: 'recorded_only',
      reason: 'duplicate_event',
    });
  });

  it('treats an empty provider event id as absent rather than as a key', () => {
    expect(applyProviderCallback(callback({ providerEventId: '' }), signed(), verifier, { current: 'sent', appliedEventIds: new Set(['']) })).toEqual({
      action: 'applied',
      status: 'delivered',
    });
  });

  it('stays monotonic for a verified, fresh callback', () => {
    expect(applyProviderCallback(callback({ status: 'sent' }), signed(), verifier, { current: 'read' })).toEqual({
      action: 'recorded_only',
      reason: 'status_regression',
    });
  });

  it('names a repeated status a duplicate, not a regression', () => {
    expect(applyProviderCallback(callback({ status: 'delivered' }), signed(), verifier, { current: 'delivered' })).toEqual({
      action: 'recorded_only',
      reason: 'duplicate_status',
    });
  });

  it('refuses a status the provider invented', () => {
    expect(applyProviderCallback(callback({ status: 'bounced' }), signed(), verifier, { current: 'sent' })).toEqual({
      action: 'recorded_only',
      reason: 'status_unknown',
    });
  });

  it('keeps nothing of the provider body or the recipient: only a status and safe tokens', () => {
    const verdict = applyProviderCallback(callback({ status: 'failed' }), signed(), verifier, { current: 'sent' });
    expect(JSON.stringify(verdict)).not.toMatch(/wamid|\+972|app-secret/);
  });
});

describe('PART 44 — a VERIFIED callback is what resolves an ambiguous delivery', () => {
  // The fourth argument is the delivery this reconciliation is ABOUT. See
  // `test/challenge-01e85f7.test.ts` F-2 for why it is required: without it, a
  // verified callback about ANOTHER message discharged this delivery.
  const about = { expectedProviderMessageId: 'wamid.A' };

  it('a verified callback with a MATCHING provider message id proves the provider has it', () => {
    expect(reconcileFromCallback(callback(), signed(), verifier, about)).toEqual({ found: true, providerMessageId: 'wamid.A' });
  });

  it('an UNVERIFIED callback resolves nothing — it cannot silence a real notification', () => {
    expect(reconcileFromCallback(callback(), { rawBody: body, signatureHeader: 'sha256=00' }, verifier, about)).toEqual({
      inconclusive: true,
      reason: 'signature_unverified',
    });
  });

  it('a verified callback with no provider message id is still inconclusive', () => {
    expect(reconcileFromCallback(callback({ providerMessageId: '  ' }), signed(), verifier, about)).toEqual({
      inconclusive: true,
      reason: 'provider_message_id_mismatch',
    });
  });
});
