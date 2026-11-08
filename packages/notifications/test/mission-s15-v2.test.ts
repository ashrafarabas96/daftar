/**
 * MASTER CONTINUOUS MISSION **V2** §15 — what V2 adds to Phase 8 beyond V1.
 *
 * V2's P8 section is written "from the visible head only", so most of it
 * records what round 4 already built. Three items are genuinely new, and each
 * is a law here:
 *
 *   1. Post-render EMPTY content is rejected (V1 bounded only oversize).
 *   2. Post-render CONTROL-CHARACTER content is rejected, in the body as well
 *      as in a template parameter, and never truncated or stripped.
 *   3. `ChannelLimits` must come from APPROVED PROVIDER POLICY, so a limit
 *      must name its origin and the shipped default must declare itself
 *      unapproved.
 *
 * And one law V2 restates that this package did not actually keep: "every
 * obligation gets a named outcome". It held everywhere except the one path
 * that dropped a duplicated recipient, which is proven below.
 */
import { describe, expect, it } from 'vitest';
import { assertWithinLimits, DefaultChannelLimits, type ChannelLimit, type ChannelLimits } from '../src/limits';
import { NotificationRefusal } from '../src/errors';
import { dispatchIntent, type DispatchPorts, type HydratedObligation, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type DispatchIntent, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { consentOf, dateFormatter, moneyFormatter } from './helpers';
import type { Channel, Recipient, RenderedMessage, TemplateVars } from '../src/types';

const limits = new DefaultChannelLimits();

function rendered(over: Partial<RenderedMessage> = {}): RenderedMessage {
  return { channel: 'whatsapp', locale: 'ar', subject: 'فاتورة', body: 'فاتورتك جاهزة', ...over };
}

/** The code a refusal carries, or `undefined` when nothing was refused. */
function refusalOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof NotificationRefusal) return err.code;
    throw err;
  }
}

describe('V2 §15 — post-render EMPTY content is refused, not sent', () => {
  it('an empty body is refused on every channel', () => {
    for (const channel of ['whatsapp', 'sms', 'email', 'inapp'] as const) {
      expect(
        refusalOf(() => assertWithinLimits(rendered({ channel, body: '', subject: 'x' }), limits)),
        channel,
      ).toBe('notification.content_empty');
    }
  });

  it('a whitespace-only body is empty too: a blank message is not a cheap message', () => {
    // The visible difference between '' and '   ' is nothing to a recipient,
    // so a law that only checked length would pass the second one through.
    for (const blank of ['   ', '\n\n', '\t', '  ']) {
      expect(refusalOf(() => assertWithinLimits(rendered({ body: blank }), limits))).toBe('notification.content_empty');
    }
  });

  it('an empty EMAIL subject is refused, and an empty subject elsewhere is the documented shape', () => {
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email', subject: '' }), limits))).toBe('notification.content_empty');
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email', subject: '  ' }), limits))).toBe('notification.content_empty');
    // sms and inapp carry `subject: ''` by construction (`types.ts`), so
    // refusing emptiness there would refuse every correct message.
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'sms', subject: '' }), limits))).toBeUndefined();
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'inapp', subject: '' }), limits))).toBeUndefined();
  });

  it('a non-empty body and subject still pass: the law refuses emptiness, not content', () => {
    expect(refusalOf(() => assertWithinLimits(rendered(), limits))).toBeUndefined();
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email' }), limits))).toBeUndefined();
  });
});

describe('V2 §15 — control characters are refused, never stripped', () => {
  it('a C0 control, a C1 control or DEL in the body is refused', () => {
    for (const bad of ['\u0000', '\u0007', '\u001b', '\u007f', '\u009f']) {
      expect(
        refusalOf(() => assertWithinLimits(rendered({ body: `فاتورتك${bad} جاهزة` }), limits)),
        JSON.stringify(bad),
      ).toBe('notification.content_invalid');
    }
  });

  it('newline, carriage return and tab are legitimate IN A BODY and stay legal', () => {
    // A refusal here would refuse every multi-line email ever rendered, which
    // is the shape of defect this program keeps finding: a law whose premise
    // is wider than the harm it was written for.
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email', body: 'سطر\nسطر\tآخر\r\n' }), limits))).toBeUndefined();
  });

  it('a newline in a SUBJECT is refused: that is header injection, not formatting', () => {
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email', subject: 'فاتورة\nBcc: attacker@example.com' }), limits))).toBe(
      'notification.content_invalid',
    );
    expect(refusalOf(() => assertWithinLimits(rendered({ channel: 'email', subject: 'فاتورة\r\nX: y' }), limits))).toBe('notification.content_invalid');
  });

  it('the refusal is a REFUSAL: nothing is returned trimmed, stripped or shortened', () => {
    // `assertWithinLimits` returns void, so there is no sanitised value for a
    // caller to send by mistake. Proven by the type AND by the throw: the only
    // two exits are "unchanged" and "refused".
    const message = rendered({ body: 'فاتورتك\u0000 جاهزة' });
    expect(() => assertWithinLimits(message, limits)).toThrow(NotificationRefusal);
    expect(message.body).toBe('فاتورتك\u0000 جاهزة');
  });
});

describe('V2 §15 — ChannelLimits must come from approved provider policy', () => {
  it('every shipped limit NAMES its origin', () => {
    for (const channel of ['whatsapp', 'sms', 'email', 'inapp'] as const) {
      expect(limits.for(channel).policySource, channel).not.toBe('');
    }
  });

  it('the shipped default declares itself UNAPPROVED, so approval is an explicit edit', () => {
    // The owner has not confirmed these figures (they are provider
    // documentation read from here, with no live provider call). Saying so in
    // the value is what stops "our dev numbers" quietly becoming "policy".
    for (const channel of ['whatsapp', 'sms', 'email', 'inapp'] as const) {
      expect(limits.for(channel).policySource, channel).toContain('UNAPPROVED');
    }
  });

  it('a limit with no stated origin is refused rather than applied', () => {
    const unattributed: ChannelLimits = {
      for: (): ChannelLimit => ({ policySource: '  ', maxBodyChars: 10, maxSubjectChars: 10 }),
    };
    expect(refusalOf(() => assertWithinLimits(rendered(), unattributed))).toBe('notification.limits_policy_unstated');
  });

  it('an APPROVED policy with different figures is honoured, and its refusal path still works', () => {
    // The point of the port: whichever figures are in force, the refusal is
    // proven. This is what makes the owner's confirmation a configuration
    // change rather than a re-verification of the package.
    const approved: ChannelLimits = {
      for: (): ChannelLimit => ({ policySource: 'owner-approved:OD-P8-LIMITS-2026', maxBodyChars: 5, maxSubjectChars: 50 }),
    };
    expect(refusalOf(() => assertWithinLimits(rendered({ body: 'ab' }), approved))).toBeUndefined();
    expect(refusalOf(() => assertWithinLimits(rendered({ body: 'abcdefgh' }), approved))).toBe('notification.body_too_long');
  });
});

const saleRow: OutboxRow = {
  id: 'ev-1',
  type: 'sale.committed.v1',
  payload: { businessId: 'b-1', saleId: 's-1', invoiceId: 'i-1', businessTransactionId: 't-1' },
};

function intentOf(): DispatchIntent {
  const intent = planFromOutboxRow(saleRow).intents[0];
  if (!intent) throw new Error('fixture produced no intent');
  return intent;
}

const vars: TemplateVars = {
  customerName: { kind: 'text', text: 'أشرف' },
  invoiceNumber: { kind: 'text', text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money', money: { minor: '125000', currency: 'ILS' } },
};

const recipient: Recipient = {
  businessId: 'b-1',
  ref: { kind: 'customer', customerId: 'c-1' },
  locale: 'ar',
  phoneE164: '+972591234567',
  email: 'customer@example.com',
};

function obligationFor(channelOrder: readonly Channel[] = ['whatsapp']): HydratedObligation {
  return { recipient, vars, channelOrder };
}

function hydratorOf(list: readonly HydratedObligation[]): NotificationHydrator {
  return { hydrate: () => Promise.resolve(list) };
}

function ports(over: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    hydrator: hydratorOf([obligationFor()]),
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    consent: consentOf(),
    eligibility: { evaluate: (): EligibilityDecision => ({ eligible: true }) } satisfies ChannelEligibility,
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

describe('V2 §15 — every obligation gets a NAMED outcome, including the duplicate', () => {
  it('a hydrator that returns the same recipient twice yields TWO outcomes, the second named already_owed', async () => {
    // The defect V2's restatement found: this path used to `continue`
    // silently, so three obligations in produced two outcomes out and nothing
    // said which one went missing or why. One message is still sent — the
    // duplicate must not send twice — but the drop is now on the record.
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const owed = [obligationFor(), obligationFor(), obligationFor()];
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf(owed) }));

    expect(outcomes).toHaveLength(owed.length);
    expect(outcomes.map((o) => o.result)).toEqual(['delivered', 'already_owed', 'already_owed']);
    for (const o of outcomes) expect('obligation' in o ? o.obligation : undefined).toBe('b-1|event:ev-1|invoice_issued|customer:c-1');
    // The whole point of collapsing them: one customer message, not three.
    expect(provider.acceptedCount()).toBe(1);
  });

  it('distinct recipients are unaffected: no outcome is invented and none is lost', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const owed = [
      obligationFor(),
      { ...obligationFor(), recipient: { ...recipient, ref: { kind: 'customer', customerId: 'c-2' } as const } },
      { ...obligationFor(), recipient: { ...recipient, ref: { kind: 'user', userId: 'u-9' } as const } },
    ];
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf(owed) }));
    expect(outcomes.map((o) => o.result)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(new Set(outcomes.map((o) => ('obligation' in o ? o.obligation : '')))).toHaveProperty('size', 3);
    expect(provider.acceptedCount()).toBe(3);
  });
});
