import { describe, expect, it } from 'vitest';
import { applyProviderCallback, type ProviderCallback } from '../src/webhook';

const verified = (over: Partial<ProviderCallback> = {}): ProviderCallback => ({
  providerMessageId: 'wamid.A',
  status: 'delivered',
  signatureVerified: true,
  ...over,
});

describe('§42 — webhook safety', () => {
  it('applies a verified, fresh, forward transition', () => {
    expect(applyProviderCallback(verified(), { current: 'sent' })).toEqual({ action: 'applied', status: 'delivered' });
  });

  it('records an unverified callback and moves nothing — even a valid-looking one', () => {
    expect(applyProviderCallback(verified({ signatureVerified: false }), { current: 'sent' })).toEqual({
      action: 'recorded_only',
      reason: 'signature_unverified',
    });
  });

  it('verifies BEFORE the state machine: an unverified failure cannot terminate a delivery', () => {
    expect(applyProviderCallback(verified({ status: 'failed', signatureVerified: false }), { current: 'queued' })).toEqual({
      action: 'recorded_only',
      reason: 'signature_unverified',
    });
  });

  it('applies a provider event id once — a redelivery changes nothing', () => {
    const callback = verified({ providerEventId: 'evt-77', status: 'read' });
    expect(applyProviderCallback(callback, { current: 'delivered' })).toEqual({ action: 'applied', status: 'read' });
    expect(applyProviderCallback(callback, { current: 'delivered', appliedEventIds: new Set(['evt-77']) })).toEqual({
      action: 'recorded_only',
      reason: 'duplicate_event',
    });
  });

  it('treats an empty provider event id as absent rather than as a key', () => {
    expect(applyProviderCallback(verified({ providerEventId: '' }), { current: 'sent', appliedEventIds: new Set(['']) })).toEqual({
      action: 'applied',
      status: 'delivered',
    });
  });

  it('stays monotonic for a verified, fresh callback', () => {
    expect(applyProviderCallback(verified({ status: 'sent' }), { current: 'read' })).toEqual({ action: 'recorded_only', reason: 'status_regression' });
  });

  it('names a repeated status a duplicate, not a regression', () => {
    expect(applyProviderCallback(verified({ status: 'delivered' }), { current: 'delivered' })).toEqual({ action: 'recorded_only', reason: 'duplicate_status' });
  });

  it('refuses a status the provider invented', () => {
    expect(applyProviderCallback(verified({ status: 'bounced' }), { current: 'sent' })).toEqual({ action: 'recorded_only', reason: 'status_unknown' });
  });

  it('keeps nothing of the provider body: the verdict carries only a status and a reason', () => {
    const verdict = applyProviderCallback(verified({ status: 'failed' }), { current: 'sent' });
    expect(JSON.stringify(verdict)).not.toMatch(/wamid|\+972/);
  });
});
