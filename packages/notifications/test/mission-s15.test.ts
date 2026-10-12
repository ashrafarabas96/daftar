/**
 * MASTER CONTINUOUS MISSION §15 — what the 2026-10-12 mission directive adds
 * to Phase 8 beyond PARTs 41–48, each item as an executable law.
 *
 *   1. Consent and channel eligibility are read LIVE at enqueue AND again
 *      before every send or retry. "An audit consent snapshot is not a lasting
 *      send right after withdrawal."
 *   2. No channel fallback that yields two messages.
 *   3. A notification failure never cancels a successful sale or payment, and
 *      is never silent.
 *   4. Formatters read canonical values in the correct language, currency and
 *      scope.
 *   5. Body limits, out-of-order status, lost-ack acceptance.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dispatchIntent, type DispatchOutcome, type DispatchPorts, type HydratedObligation, type NotificationHydrator } from '../src/dispatch';
import { planFromOutboxRow, type DispatchIntent, type OutboxRow } from '../src/consumer';
import { FakeNotificationProvider } from '../src/providers/fake-provider';
import type { ChannelEligibility, EligibilityDecision } from '../src/eligibility';
import { resolveUnknown } from '../src/delivery';
import { HmacSha256WebhookVerifier, reconcileFromCallback } from '../src/webhook';
import { consentOf, consentSequence, dateFormatter, moneyFormatter, NOTHING_RECORDED, OPTED_OUT_WHATSAPP } from './helpers';
import type { Channel, Recipient, TemplateVars } from '../src/types';

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

const allEligible: ChannelEligibility = { evaluate: (): EligibilityDecision => ({ eligible: true }) };

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

function obligation(over: Partial<HydratedObligation> = {}): HydratedObligation {
  return { recipient, vars, channelOrder: ['whatsapp', 'email', 'inapp'], ...over };
}

function hydratorOf(list: readonly HydratedObligation[] | undefined): NotificationHydrator {
  return { hydrate: () => Promise.resolve(list) };
}

function ports(over: Partial<DispatchPorts> = {}): DispatchPorts {
  return {
    hydrator: hydratorOf([obligation()]),
    provider: new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp', 'email', 'inapp'] }),
    consent: consentOf(),
    eligibility: allEligible,
    moneyFormatter,
    dateFormatter,
    nowMinuteOfDay: 600,
    ...over,
  };
}

describe('§15.1 — consent is read live, at enqueue AND before the send', () => {
  it('asks the consent port TWICE for one delivered channel: once per gate', async () => {
    const consent = consentOf(NOTHING_RECORDED);
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, consent, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]?.result).toBe('delivered');
    // Not "at least once": exactly the two gates. A single read would mean the
    // send rested on the enqueue answer, which is the defect §15 names.
    expect(consent.reads).toBe(2);
  });

  it('a withdrawal BETWEEN enqueue and send stops the send, and says so by its own code', async () => {
    const consent = consentSequence(NOTHING_RECORDED, OPTED_OUT_WHATSAPP);
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, consent, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes).toEqual([
      {
        result: 'suppressed',
        kind: 'invoice_issued',
        obligation: 'event:ev-1|invoice_issued|customer:c-1',
        channel: 'whatsapp',
        code: 'notification.consent_withdrawn',
        detail: 'notification.channel_blocked',
        stage: 'send',
      },
    ]);
    // Nothing left the building.
    expect(provider.acceptedCount()).toBe(0);
  });

  it('`consent_withdrawn` is a DIFFERENT fact from "never permitted", and the codes differ', async () => {
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const never = await dispatchIntent(
      intentOf(),
      ports({ provider, consent: consentOf(OPTED_OUT_WHATSAPP), hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }),
    );
    expect(never[0]).toMatchObject({ result: 'suppressed', code: 'notification.channel_blocked', stage: 'enqueue' });
    const withdrawn = await dispatchIntent(
      intentOf(),
      ports({ provider, consent: consentSequence(NOTHING_RECORDED, OPTED_OUT_WHATSAPP), hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }),
    );
    expect(withdrawn[0]).toMatchObject({ result: 'suppressed', code: 'notification.consent_withdrawn', stage: 'send' });
  });

  it('channel eligibility is re-read before the send too, and a withdrawal there has its own code', async () => {
    let asked = 0;
    const flips: ChannelEligibility = {
      evaluate: (): EligibilityDecision => {
        asked += 1;
        return asked === 1 ? { eligible: true } : { eligible: false, reason: 'the service window closed' };
      },
    };
    const provider = new FakeNotificationProvider({ requiresApprovedTemplate: true, channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({ provider, eligibility: flips, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }),
    );
    expect(outcomes[0]).toMatchObject({
      result: 'suppressed',
      code: 'notification.eligibility_withdrawn',
      detail: 'the service window closed',
      stage: 'send',
    });
    expect(asked).toBe(2);
    expect(provider.acceptedCount()).toBe(0);
  });

  it('nothing on the hydrated obligation can grant a send right: it carries no consent at all', () => {
    // §15's snapshot rule, enforced by the type rather than by discipline.
    expect(Object.keys(obligation())).toEqual(['recipient', 'vars', 'channelOrder']);
  });
});

describe('§15.2 — no channel fallback that yields two messages', () => {
  it('a transient rejection with a retry scheduled WITHHOLDS every later channel', async () => {
    // The defect this closes: the loop used to continue to email while the
    // whatsapp delivery still had a retry pending. The retry lands later, the
    // email landed now — one obligation, two messages.
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: false,
      channels: ['whatsapp', 'email', 'inapp'],
      failWith: ['PROVIDER_UNAVAILABLE'],
    });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    expect(outcomes.map((o) => o.result)).toEqual(['failed', 'withheld', 'withheld']);
    expect(outcomes[0]).toMatchObject({ channel: 'whatsapp', state: 'retry_scheduled', next: { action: 'retry' } });
    for (const o of outcomes.slice(1)) {
      expect(o).toMatchObject({ result: 'withheld', code: 'notification.channel_withheld_pending_delivery' });
    }
    // Exactly one provider call was made, and it was rejected: no message.
    expect(provider.acceptedCount()).toBe(0);
  });

  it('a withheld channel is NAMED, not omitted — a channel that vanished looks unconfigured', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'], failWith: ['PROVIDER_UNAVAILABLE'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    const withheld = outcomes.filter((o): o is Extract<DispatchOutcome, { result: 'withheld' }> => o.result === 'withheld');
    expect(withheld.map((o) => o.channel)).toEqual(['email', 'inapp']);
    for (const o of withheld) expect(o.detail).toContain('whatsapp');
  });

  it('an ambiguous send withholds the later channels too', async () => {
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: false,
      channels: ['whatsapp', 'email', 'inapp'],
      serverSideIdempotency: false,
      unknownWith: ['timeout_after_send'],
    });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    // The dispatcher returns at the ambiguous send, so the later channels are
    // not even enumerated — which is the same guarantee by a shorter route.
    expect(outcomes.map((o) => o.result)).toEqual(['unknown']);
    expect(provider.acceptedCount()).toBe(1);
  });

  it('but a DEAD rejection does fall through, and exactly one message results', async () => {
    // Proven not sent, and nothing further will be attempted on that channel.
    // Withholding here would lose the notification altogether, which §15 does
    // not ask for: it forbids TWO messages, not the first one.
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: false,
      channels: ['whatsapp', 'email', 'inapp'],
      failWith: ['RECIPIENT_REJECTED'],
    });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider }));
    expect(outcomes.map((o) => o.result)).toEqual(['failed', 'delivered']);
    expect(outcomes[0]).toMatchObject({ channel: 'whatsapp', state: 'dead', next: { action: 'stop' } });
    expect(outcomes[1]).toMatchObject({ channel: 'email' });
    expect(provider.acceptedCount()).toBe(1);
  });

  it('a channel refused BEFORE any provider call still falls through: nothing was sent', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp', 'email', 'inapp'] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, consent: consentOf(OPTED_OUT_WHATSAPP) }));
    expect(outcomes.map((o) => o.result)).toEqual(['suppressed', 'delivered']);
    expect(provider.acceptedCount()).toBe(1);
  });
});

describe('§15.3 — a failure is never silent, and cannot cancel anything', () => {
  it('every obligation the hydrator returned produces at least one named outcome', async () => {
    const refs = [
      { kind: 'customer' as const, customerId: 'c-1' },
      { kind: 'customer' as const, customerId: 'c-2' },
      { kind: 'user' as const, userId: 'u-9' },
    ];
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH_FAILED'] });
    const owed = refs.map((ref) => obligation({ recipient: { ...recipient, ref }, channelOrder: ['whatsapp'] }));
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf(owed) }));
    expect(outcomes.length).toBeGreaterThanOrEqual(refs.length);
    const obligations = new Set(outcomes.map((o) => ('obligation' in o ? o.obligation : undefined)));
    expect(obligations.size).toBe(3);
    // Two of the three failed. None disappeared.
    expect(outcomes.filter((o) => o.result === 'failed')).toHaveLength(2);
  });

  it('an empty outcome list means only "nobody was owed", never "something went wrong quietly"', async () => {
    expect(await dispatchIntent(intentOf(), ports({ hydrator: hydratorOf([]) }))).toEqual([]);
    // And a read that failed is a named refusal, not an empty list.
    expect(await dispatchIntent(intentOf(), ports({ hydrator: hydratorOf(undefined) }))).toEqual([
      { result: 'refused', kind: 'invoice_issued', code: 'notification.hydration_incomplete' },
    ]);
  });

  it('every refusing outcome carries a code or a reason a human can act on', async () => {
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'], failWith: ['PROVIDER_AUTH_FAILED'] });
    const cases = await Promise.all([
      dispatchIntent(
        intentOf(),
        ports({ provider, consent: consentOf(OPTED_OUT_WHATSAPP), hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }),
      ),
      dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) })),
      dispatchIntent(intentOf(), ports({ hydrator: hydratorOf(undefined) })),
    ]);
    for (const outcomes of cases) {
      for (const o of outcomes) {
        const described = 'code' in o || 'next' in o || 'reason' in o || o.result === 'delivered' || o.result === 'already_owed';
        expect(described, JSON.stringify(o)).toBe(true);
      }
    }
  });
});

describe('§15.4 — the correct language, currency and scope', () => {
  it('refuses a currency the contract does not name, rather than formatting it', async () => {
    // Mission §23 names this value specifically: "no SAR from mockups".
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const outcomes = await dispatchIntent(
      intentOf(),
      ports({
        provider,
        hydrator: hydratorOf([
          obligation({ vars: { ...vars, invoiceTotal: { kind: 'money', money: { minor: '125000', currency: 'SAR' } } }, channelOrder: ['whatsapp'] }),
        ]),
      }),
    );
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.currency_not_in_contract' });
    expect(provider.acceptedCount()).toBe(0);
  });

  it('accepts every currency the contract DOES name — the law is a contract, not a single case', async () => {
    for (const currency of ['ILS', 'JOD', 'LBP', 'SYP', 'TRY', 'USD', 'EUR']) {
      const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
      const outcomes = await dispatchIntent(
        intentOf(),
        ports({
          provider,
          hydrator: hydratorOf([
            obligation({ vars: { ...vars, invoiceTotal: { kind: 'money', money: { minor: '125000', currency } } }, channelOrder: ['whatsapp'] }),
          ]),
        }),
      );
      expect(outcomes[0]?.result, currency).toBe('delivered');
    }
  });

  it('refuses a minor-unit amount that is not an integer decimal string', async () => {
    for (const minor of ['125.00', '1,250', '1e5', '', ' 125', '0125', '-']) {
      const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
      const outcomes = await dispatchIntent(
        intentOf(),
        ports({
          provider,
          hydrator: hydratorOf([
            obligation({ vars: { ...vars, invoiceTotal: { kind: 'money', money: { minor, currency: 'ILS' } } }, channelOrder: ['whatsapp'] }),
          ]),
        }),
      );
      expect(outcomes[0], JSON.stringify(minor)).toMatchObject({ result: 'suppressed', code: 'notification.money_minor_invalid' });
      expect(provider.acceptedCount(), JSON.stringify(minor)).toBe(0);
    }
    // A negative amount is legitimate (a credit) and is not refused.
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    const ok = await dispatchIntent(
      intentOf(),
      ports({
        provider,
        hydrator: hydratorOf([
          obligation({ vars: { ...vars, invoiceTotal: { kind: 'money', money: { minor: '-125000', currency: 'ILS' } } }, channelOrder: ['whatsapp'] }),
        ]),
      }),
    );
    expect(ok[0]?.result).toBe('delivered');
  });

  it('renders in the RECIPIENT’s language, and the formatter is told which one', async () => {
    const seen: string[] = [];
    const recording = {
      format: (money: { minor: string; currency: string }, locale: string) => {
        seen.push(locale);
        return `${locale}:${money.minor}`;
      },
    };
    const provider = new FakeNotificationProvider({ channels: ['whatsapp'] });
    await dispatchIntent(
      intentOf(),
      ports({
        provider,
        moneyFormatter: recording,
        hydrator: hydratorOf([obligation({ recipient: { ...recipient, locale: 'tr' }, channelOrder: ['whatsapp'] })]),
      }),
    );
    expect(seen).toEqual(['tr']);
    expect(provider.deliveries()[0]?.rendered.locale).toBe('tr');
  });
});

describe('§15.5 — body limits', () => {
  function longName(n: number): TemplateVars {
    return { ...vars, customerName: { kind: 'text', text: 'ء'.repeat(n) } };
  }

  async function dispatchWith(v: TemplateVars, channel: Channel = 'whatsapp') {
    const provider = new FakeNotificationProvider({ channels: [channel] });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ vars: v, channelOrder: [channel] })]) }));
    return { outcomes, provider };
  }

  it('refuses an over-long body instead of truncating it', async () => {
    const { outcomes, provider } = await dispatchWith(longName(5000));
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.body_too_long' });
    expect(provider.acceptedCount()).toBe(0);
  });

  it('refuses an over-long approved-template parameter', async () => {
    const { outcomes, provider } = await dispatchWith(longName(1100));
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.parameter_invalid' });
    expect(provider.acceptedCount()).toBe(0);
  });

  it('refuses a control character in a template parameter — Meta rejects it outright', async () => {
    const { outcomes } = await dispatchWith({ ...vars, customerName: { kind: 'text', text: 'أشرف\nعرابي' } });
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.parameter_invalid' });
  });

  it('refuses an EMPTY template parameter: an approved template with a hole in it', async () => {
    const { outcomes } = await dispatchWith({ ...vars, customerName: { kind: 'text', text: '' } });
    expect(outcomes[0]).toMatchObject({ result: 'suppressed', code: 'notification.parameter_invalid' });
  });

  it('a body within the limit is delivered — the law refuses the long one, not every one', async () => {
    const { outcomes } = await dispatchWith(longName(100));
    expect(outcomes[0]?.result).toBe('delivered');
  });
});

describe('§15.5 — lost-ack acceptance, end to end', () => {
  const SECRET = 'webhook-secret-for-tests-only';
  const verifier = new HmacSha256WebhookVerifier(SECRET);

  it('the ack was lost, a VERIFIED callback arrives, and nothing is ever resent', async () => {
    // The provider took the message; the response never came back.
    const provider = new FakeNotificationProvider({
      requiresApprovedTemplate: false,
      channels: ['whatsapp'],
      serverSideIdempotency: false,
      unknownWith: ['timeout_after_send'],
    });
    const outcomes = await dispatchIntent(intentOf(), ports({ provider, hydrator: hydratorOf([obligation({ channelOrder: ['whatsapp'] })]) }));
    expect(outcomes[0]).toMatchObject({ result: 'unknown', next: { action: 'reconcile' } });
    expect(provider.acceptedCount()).toBe(1);

    // Later, the provider's own status callback arrives, signed.
    const body = JSON.stringify({ id: 'wamid.LOST', status: 'delivered' });
    const signature = `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`;
    const reconciliation = reconcileFromCallback(
      { providerMessageId: 'wamid.LOST', status: 'delivered' },
      { rawBody: body, signatureHeader: signature },
      verifier,
    );
    expect(reconciliation).toEqual({ found: true, providerMessageId: 'wamid.LOST' });

    // The delivery closes on the evidence. No second send, at any point.
    expect(resolveUnknown(reconciliation)).toEqual({ state: 'accepted', next: { action: 'none' } });
    expect(provider.acceptedCount()).toBe(1);
  });

  it('an UNVERIFIED callback cannot close a lost-ack delivery — it would be a silencing attack', () => {
    const body = JSON.stringify({ id: 'wamid.LOST', status: 'delivered' });
    const forged = reconcileFromCallback({ providerMessageId: 'wamid.LOST', status: 'delivered' }, { rawBody: body, signatureHeader: 'sha256=00' }, verifier);
    expect(forged).toEqual({ inconclusive: true });
    expect(resolveUnknown(forged)).toEqual({ state: 'unknown', next: { action: 'reconcile', reason: 'reconciliation inconclusive' } });
  });
});
