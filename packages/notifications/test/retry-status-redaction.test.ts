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

  // CORRECTED after the independent challenge at `01e85f7`. This case used to
  // assert that NOTHING leaves `failed`, including `delivered` and `read`.
  // That half of "failed is terminal" was unsafe: a delivery left in `failed`
  // is released to the next channel by `blocksAnotherChannel`, so refusing a
  // later arrival meant a second message to someone already holding the first.
  // What is terminal is the ARRIVAL. See `test/challenge-01e85f7.test.ts` F-1.
  it('keeps failed terminal in the direction that matters: nothing goes BACKWARD from it', () => {
    for (const next of ['queued', 'sent'] as const) {
      expect(applyStatus('failed', next)).toEqual({ applied: false, reason: 'notification.status_regression' });
    }
  });

  it('but an ARRIVAL after a reported failure is applied, because it is evidence the message landed', () => {
    expect(applyStatus('failed', 'delivered')).toEqual({ applied: true, status: 'delivered' });
    expect(applyStatus('failed', 'read')).toEqual({ applied: true, status: 'read' });
  });

  it('refuses a status the provider invented', () => {
    expect(applyStatus('sent', 'bounced')).toEqual({ applied: false, reason: 'notification.status_unknown' });
    expect(isKnownStatus('bounced')).toBe(false);
    // A prototype key is not a status either.
    expect(isKnownStatus('toString')).toBe(false);
    expect(applyStatus('sent', '__proto__')).toEqual({ applied: false, reason: 'notification.status_unknown' });
  });

  // CORRECTED after the independent challenge. This case used to include
  // `delivered` and `read` in the list of states a `failed` may be accepted
  // from — it was ASSERTING the defect, which is why the suite stayed green
  // while a customer could be messaged twice. Third time an assertion in this
  // package has encoded a defect rather than caught it; each time it was a
  // case written to describe the code instead of the requirement.
  it('accepts failure only BEFORE an arrival', () => {
    for (const from of ['queued', 'sent'] as DeliveryStatus[]) {
      expect(applyStatus(from, 'failed')).toEqual({ applied: true, status: 'failed' });
    }
  });

  it('refuses a failure AFTER an arrival, in either arrival state', () => {
    for (const from of ['delivered', 'read'] as DeliveryStatus[]) {
      expect(applyStatus(from, 'failed')).toEqual({ applied: false, reason: 'notification.status_regression' });
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
