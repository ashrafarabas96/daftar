import { describe, expect, it } from 'vitest';
import { backoffSeconds, MAX_ATTEMPTS, nextStepAfterFailure } from '../src/retry';
import { applyStatus, isKnownStatus, type DeliveryStatus } from '../src/status';
import { classifyProviderError, isTransient, maskEmail, maskPhone, type ProviderErrorCode } from '../src/redaction';

describe('retry policy', () => {
  it('backs off exponentially and caps at one hour', () => {
    expect(backoffSeconds(0)).toBe(5);
    expect(backoffSeconds(1)).toBe(10);
    expect(backoffSeconds(5)).toBe(160);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('refuses a negative or fractional attempt count', () => {
    expect(() => backoffSeconds(-1)).toThrow();
    expect(() => backoffSeconds(1.5)).toThrow();
  });

  it('retries a transient class and dead-letters at the limit', () => {
    expect(nextStepAfterFailure(0, 'PROVIDER_TIMEOUT')).toEqual({ step: 'retry', attempts: 1, afterSeconds: 10 });
    expect(nextStepAfterFailure(MAX_ATTEMPTS - 1, 'PROVIDER_RATE_LIMITED')).toEqual({ step: 'dead', attempts: MAX_ATTEMPTS, reason: 'PROVIDER_RATE_LIMITED' });
  });

  it('dead-letters a terminal class on the first failure — no rate-limit burning', () => {
    for (const code of ['PROVIDER_AUTH_FAILED', 'RECIPIENT_REJECTED', 'TEMPLATE_REJECTED', 'PROVIDER_NOT_CONFIGURED'] as const) {
      expect(nextStepAfterFailure(0, code)).toEqual({ step: 'dead', attempts: 1, reason: code });
      expect(isTransient(code)).toBe(false);
    }
  });
});

describe('delivery status', () => {
  it('moves forward only', () => {
    expect(applyStatus('queued', 'sent')).toEqual({ applied: true, status: 'sent' });
    expect(applyStatus('sent', 'delivered')).toEqual({ applied: true, status: 'delivered' });
    expect(applyStatus('delivered', 'read')).toEqual({ applied: true, status: 'read' });
  });

  it('refuses the late out-of-order webhook that would un-read a read message', () => {
    expect(applyStatus('read', 'sent')).toEqual({ applied: false, reason: 'notification.status_regression' });
    expect(applyStatus('delivered', 'queued')).toEqual({ applied: false, reason: 'notification.status_regression' });
  });

  it('names a duplicate as a duplicate, not a regression', () => {
    expect(applyStatus('delivered', 'delivered')).toEqual({ applied: false, reason: 'duplicate' });
  });

  it('keeps failed terminal', () => {
    for (const next of ['queued', 'sent', 'delivered', 'read'] as const) {
      expect(applyStatus('failed', next)).toEqual({ applied: false, reason: 'notification.status_regression' });
    }
  });

  it('refuses a status the provider invented', () => {
    expect(applyStatus('sent', 'bounced')).toEqual({ applied: false, reason: 'notification.status_unknown' });
    expect(isKnownStatus('bounced')).toBe(false);
    // A prototype key is not a status either.
    expect(isKnownStatus('toString')).toBe(false);
    expect(applyStatus('sent', '__proto__')).toEqual({ applied: false, reason: 'notification.status_unknown' });
  });

  it('accepts failure from any non-terminal state', () => {
    for (const from of ['queued', 'sent', 'delivered', 'read'] as DeliveryStatus[]) {
      expect(applyStatus(from, 'failed')).toEqual({ applied: true, status: 'failed' });
    }
  });
});

describe('redaction', () => {
  it('masks a phone number but keeps country and last three', () => {
    expect(maskPhone('+972591234567')).toBe('+9725****567');
    expect(maskPhone('+9725')).toBe('***');
  });

  it('masks an email local part', () => {
    expect(maskEmail('ashraf@example.com')).toBe('a***f@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('classifies provider failures into safe codes', () => {
    const cases: readonly [unknown, ProviderErrorCode][] = [
      [{ status: 401 }, 'PROVIDER_AUTH_FAILED'],
      [{ status: 403, message: 'forbidden' }, 'PROVIDER_AUTH_FAILED'],
      [{ status: 429 }, 'PROVIDER_RATE_LIMITED'],
      [{ code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
      [{ status: 503 }, 'PROVIDER_UNAVAILABLE'],
      [{ code: 'ECONNRESET' }, 'PROVIDER_UNAVAILABLE'],
      [{ status: 400, message: 'template name does not exist' }, 'TEMPLATE_REJECTED'],
      [{ status: 400, message: 'not a valid whatsapp user' }, 'RECIPIENT_REJECTED'],
      [new Error('something else'), 'DELIVERY_FAILED'],
      [undefined, 'DELIVERY_FAILED'],
    ];
    for (const [input, expected] of cases) expect(classifyProviderError(input), JSON.stringify(input)).toBe(expected);
  });

  it('never returns the raw provider text — only a code', () => {
    const leaky = { status: 400, message: 'Bearer EAAG-secret-token failed for +972591234567' };
    const code = classifyProviderError(leaky);
    expect(code).not.toContain('972');
    expect(code).not.toContain('EAAG');
  });
});
