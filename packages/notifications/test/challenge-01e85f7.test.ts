/**
 * The independent challenger's findings at `01e85f7`, as executable laws.
 *
 * Every case here RED on `01e85f7` and green after the fix, which is the only
 * form in which a finding is answered rather than acknowledged. The challenger
 * ran its own probes outside this tree; these are this package's own laws, so
 * the defects cannot come back without a red suite.
 */
import { describe, expect, it } from 'vitest';
import { applyStatus, arrivalWasRecorded, type DeliveryStatus } from '../src/status';
import { blocksAnotherChannel, resolveUnknown } from '../src/delivery';
import { applyProviderCallback, reconcileFromCallback, type ProviderCallback } from '../src/webhook';
import { assertWithinLimits, DefaultChannelLimits } from '../src/limits';
import { classifyTransportThrow } from '../src/provider';
import { obligationKey } from '../src/identity';
import { NotificationRefusal } from '../src/errors';

const signed = { rawBody: '{}', headers: { 'x-hub-signature-256': 'ok' } } as never;
const alwaysVerifies = { verify: () => ({ verified: true as const }) } as never;

describe('F-1 — an arrival is terminal: a late `failed` may not demote a delivered or read message', () => {
  // The defect: RANK put `failed` highest, so `read -> failed` was "strictly
  // forward", and `blocksAnotherChannel` then released the obligation for a
  // closed+failed+verified delivery. Composed, a customer who READ the invoice
  // message got a second one by SMS.
  it('a late failed is refused after delivered and after read', () => {
    expect(applyStatus('read', 'failed')).toEqual({ applied: false, reason: 'notification.status_regression' });
    expect(applyStatus('delivered', 'failed')).toEqual({ applied: false, reason: 'notification.status_regression' });
  });

  it('a failure BEFORE any arrival still applies: it is the pre-delivery failure V3 split `closed` for', () => {
    expect(applyStatus('queued', 'failed')).toEqual({ applied: true, status: 'failed' });
    expect(applyStatus('sent', 'failed')).toEqual({ applied: true, status: 'failed' });
  });

  it('an arrival AFTER a failure applies, because the message demonstrably arrived', () => {
    // This is the half that `current === 'failed' -> regression` got wrong. If
    // the status stayed `failed`, the release below would fire for a message
    // the customer is holding.
    expect(applyStatus('failed', 'delivered')).toEqual({ applied: true, status: 'delivered' });
    expect(applyStatus('failed', 'read')).toEqual({ applied: true, status: 'read' });
  });

  it('nothing demotes an arrival, in any order the provider sends', () => {
    expect(applyStatus('delivered', 'sent')).toEqual({ applied: false, reason: 'notification.status_regression' });
    expect(applyStatus('read', 'delivered')).toEqual({ applied: false, reason: 'notification.status_regression' });
    expect(applyStatus('failed', 'sent')).toEqual({ applied: false, reason: 'notification.status_regression' });
    expect(applyStatus('failed', 'queued')).toEqual({ applied: false, reason: 'notification.status_regression' });
  });

  it('the release in delivery.ts names this ordering as its premise, and reads it', () => {
    // `blocksAnotherChannel` releases a closed+failed+verified delivery. That
    // is only safe because a `failed` status is UNREACHABLE after an arrival.
    // The law reads the premise instead of restating it in a comment.
    for (const arrived of ['delivered', 'read'] as DeliveryStatus[]) {
      expect(arrivalWasRecorded(arrived)).toBe(true);
      expect(applyStatus(arrived, 'failed').applied).toBe(false);
    }
    expect(arrivalWasRecorded('failed')).toBe(false);
    expect(blocksAnotherChannel({ state: 'closed', finalStatus: 'failed', finalStatusVerified: true })).toBe(false);
  });

  it('the composed three-step sequence the challenger proved now ends with the obligation still held', () => {
    let status: DeliveryStatus = 'queued';
    for (const incoming of ['delivered', 'read']) {
      const t = applyStatus(status, incoming);
      expect(t.applied).toBe(true);
      if (t.applied) status = t.status;
    }
    const late = applyProviderCallback({ providerMessageId: 'wamid.1', status: 'failed' }, signed, alwaysVerifies, {
      current: status,
    });
    expect(late).toEqual({ action: 'recorded_only', reason: 'status_regression' });
    // The final status is still `read`, so the release clause cannot be reached
    // and no second channel opens.
    expect(status).toBe('read');
    expect(blocksAnotherChannel({ state: 'closed', finalStatus: 'read' as never, finalStatusVerified: true })).toBe(true);
  });
});

describe('F-2 — a callback resolves only the delivery it is ABOUT', () => {
  const callback: ProviderCallback = { providerMessageId: 'wamid.MINE', status: 'delivered' };

  it('a verified callback about another message is inconclusive, not a discharge', () => {
    const other: ProviderCallback = { providerMessageId: 'wamid.SOMEONE-ELSE', status: 'delivered' };
    const r = reconcileFromCallback(other, signed, alwaysVerifies, {
      expectedProviderMessageId: 'wamid.MINE',
    });
    expect(r).toEqual({ inconclusive: true, reason: 'provider_message_id_mismatch' });
    expect(resolveUnknown(r).state).toBe('unknown');
  });

  it('a matching verified callback discharges it', () => {
    const r = reconcileFromCallback(callback, signed, alwaysVerifies, {
      expectedProviderMessageId: 'wamid.MINE',
    });
    expect(r).toEqual({ found: true, providerMessageId: 'wamid.MINE' });
    expect(resolveUnknown(r)).toEqual({ state: 'accepted', next: { action: 'none' } });
  });

  it('an id that was never learned cannot be resolved by ANY callback — it needs a status lookup', () => {
    // This is the `invalid_success_response` case: a 2xx whose body carried no
    // usable id. There is nothing to correlate against, so a callback must not
    // be allowed to close it. The challenger named this the one state the
    // function existed to resolve and the one in which it cannot.
    const r = reconcileFromCallback(callback, signed, alwaysVerifies, {});
    expect(r).toEqual({ inconclusive: true, reason: 'provider_message_id_never_learned' });
    expect(resolveUnknown(r).state).toBe('unknown');
  });

  it('correlation is not optional: the function cannot be called without it', () => {
    // A fourth required parameter is what makes the premise unskippable. The
    // previous signature took three, so no caller COULD correlate.
    expect(reconcileFromCallback.length).toBe(4);
  });

  it('an unverified callback still resolves nothing, whatever it claims about the id', () => {
    const r = reconcileFromCallback(callback, signed, { verify: () => ({ verified: false, reason: 'bad_signature' }) } as never, {
      expectedProviderMessageId: 'wamid.MINE',
    });
    expect(r).toEqual({ inconclusive: true, reason: 'signature_unverified' });
  });
});

describe('F-3 — the template parameter is the stricter surface, not the looser one', () => {
  const limits = new DefaultChannelLimits();

  function check(parameter: string) {
    return () =>
      assertWithinLimits(
        {
          channel: 'whatsapp',
          locale: 'ar',
          subject: 'invoice_issued',
          body: 'ok',
          providerTemplate: { name: 'invoice_issued', locale: 'ar', parameters: [parameter] },
        },
        limits,
      );
  }

  it.each([
    ['NUL', '\u0000'],
    ['C1 NEL', '\u0085'],
    ['DEL', '\u007f'],
  ])('%s is refused in a template parameter, as it already was in a body', (_name, ch) => {
    expect(check(`a${ch}b`)).toThrow(NotificationRefusal);
    expect(check(`a${ch}b`)).toThrow(/parameter_invalid.*control_character/);
  });

  it('a whitespace-only parameter is refused: an approved template with a hole in it', () => {
    expect(check('   ')).toThrow(/parameter_invalid.*blank/);
    // A parameter of tab and newline is refused as a CONTROL character, which
    // is the check that runs first — it is refused either way, and the detail
    // says which law caught it rather than guessing.
    expect(check('\t\n')).toThrow(/parameter_invalid.*control_character/);
  });

  it('an ordinary parameter still passes', () => {
    expect(check('أحمد')).not.toThrow();
  });
});

describe('F-4 — a connection that was never made is a proven non-send, however the adapter wraps it', () => {
  // NOTE on my own prediction, recorded rather than quietly corrected: I first
  // asserted the result carried `reason: 'ECONNREFUSED'`. It carries a
  // `ProviderErrorCode` in `code`; the transport string is what is CLASSIFIED,
  // not what is returned. The substance — `outcome` and `retryable`, which are
  // what decide whether the notification is retried or abandoned — was as
  // predicted. The challenger made the same kind of correction on its C-04.
  it('a transport code on err.cause classifies as a retryable rejection, not a permanent unknown', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(classifyTransportThrow(wrapped)).toMatchObject({ outcome: 'rejected', retryable: true });
  });

  it('the same code at the top level is unchanged', () => {
    expect(classifyTransportThrow(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toMatchObject({ outcome: 'rejected', retryable: true });
  });

  it('a code nested two levels deep is still found, because adapters wrap more than once', () => {
    const deep = Object.assign(new Error('a'), { cause: Object.assign(new Error('b'), { cause: Object.assign(new Error('c'), { code: 'EAI_AGAIN' }) }) });
    expect(classifyTransportThrow(deep)).toMatchObject({ outcome: 'rejected', retryable: true });
  });

  it('a throw with no transport code anywhere in the chain is STILL unknown', () => {
    // The fail-safe direction is unchanged: an interrupted request that may
    // have been received is never retried into a duplicate.
    const opaque = Object.assign(new Error('socket hang up'), { cause: new Error('nothing useful') });
    expect(classifyTransportThrow(opaque).outcome).toBe('unknown');
  });

  it('a cause cycle terminates instead of hanging the worker', () => {
    const a: Record<string, unknown> = { message: 'a' };
    a.cause = a;
    expect(classifyTransportThrow(a).outcome).toBe('unknown');
  });
});

describe('F-6 — the obligation key names its tenant and cannot be forged by a separator', () => {
  const customer = { kind: 'customer', customerId: 'c1' } as const;
  const event = { source: 'event', eventId: 'e1' } as const;

  it('the business is IN the key, so a cross-tenant ledger set cannot suppress a real notification', () => {
    expect(obligationKey('b1', event, 'invoice_issued', customer).startsWith('b1|')).toBe(true);
  });

  it('the business is a REQUIRED parameter, because RecipientRef cannot supply it', () => {
    // `businessId` lives on `Recipient`, not on the bare `RecipientRef` — which
    // is what `types.ts` claimed directly above that type. A fifth instance of
    // a law naming a premise it does not read, found while fixing this one.
    expect(obligationKey.length).toBe(4);
    expect('businessId' in customer).toBe(false);
  });

  it('the same obligation under another business is a different key', () => {
    expect(obligationKey('b1', event, 'invoice_issued', customer)).not.toBe(obligationKey('b2', event, 'invoice_issued', customer));
  });

  it('a separator inside a field is REFUSED, not absorbed', () => {
    // The challenger's collision: a free-text field carrying `|` could spell
    // another obligation's key. `occurrenceKey` made that reachable, since the
    // scheduled path accepts it from the automation layer.
    expect(() => obligationKey('b1', { source: 'schedule', scheduleId: 's', occurrenceKey: '2026-09|x' }, 'customer_statement', customer)).toThrow(
      /obligation_key_field_invalid/,
    );
    expect(() => obligationKey('b1', { source: 'event', eventId: 'e1|invoice_issued|customer:c2' }, 'invoice_issued', customer)).toThrow(
      /obligation_key_field_invalid/,
    );
    expect(() => obligationKey('b1', event, 'invoice_issued', { kind: 'customer', customerId: 'c1|k|customer:c2' })).toThrow(/obligation_key_field_invalid/);
    expect(() => obligationKey('b1|x', event, 'invoice_issued', customer)).toThrow(/obligation_key_field_invalid/);
  });

  it('the challenger`s two colliding calls no longer collide — both are refused', () => {
    const one = () => obligationKey('b1', { source: 'event', eventId: 'e1|invoice_issued|customer:c1' }, 'k', { kind: 'customer', customerId: 'c2' });
    const two = () => obligationKey('b1', event, 'invoice_issued', { kind: 'customer', customerId: 'c1|k|customer:c2' });
    expect(one).toThrow();
    expect(two).toThrow();
  });

  it('an ordinary key is unchanged in shape, so the ledger format is still one string', () => {
    expect(obligationKey('b1', event, 'invoice_issued', customer)).toBe('b1|event:e1|invoice_issued|customer:c1');
  });
});
