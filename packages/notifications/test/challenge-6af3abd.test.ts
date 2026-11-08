/**
 * The FOURTH independent challenge, at `6af3abd`. Verdict REJECT, scoped: the
 * code was signed and the DDL TRANSCRIPTION was rejected on D-1 and D-2, both
 * blocking.
 *
 * D-1 .. D-5 are not here, and cannot be: they are about what a real cluster
 * does with the real frozen schema, and they are measured by
 * `proof/run-p8-real-proof.sh`, which applies all 87 migrations unmodified and
 * then Phase 8 as an overlay. Round 10's prototype is superseded, and so are
 * its isolation results.
 *
 * What is here is D-6, the one finding in this package: `deliveryKey` took an
 * arbitrary `providerContext` and composed it into a key whose separators the
 * module reserves, while N-7 had just closed the same hole one level down in
 * `obligationKey`. New scope beside a fix is the least-reviewed code in a
 * change — this package has now been caught by that twice.
 */
import { describe, expect, it } from 'vitest';
import { attemptIdentity, deliveryKey, obligationKey, type NotificationOrigin } from '../src/identity';
import { NotificationRefusal } from '../src/errors';

const customer = { kind: 'customer', customerId: 'c1' } as const;
const event: NotificationOrigin = { source: 'event', eventId: 'e1' };
const obligation = obligationKey('b1', event, 'invoice_issued', customer);

function refusal(fn: () => unknown): NotificationRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof NotificationRefusal) return err;
    throw err;
  }
  throw new Error('expected a NotificationRefusal, and the call returned');
}

describe('D-6 — the composed delivery key', () => {
  it('still makes the key it existed to make', () => {
    expect(deliveryKey(obligation, 'whatsapp')).toBe(`${obligation}::whatsapp`);
    expect(deliveryKey(obligation, 'whatsapp', 'promo_v2')).toBe(`${obligation}::whatsapp@promo_v2`);
  });

  it('refuses a provider context carrying the delivery separator', () => {
    // `promo::v2` produced `...::whatsapp@promo::v2` before this round: two
    // `::` in a key the module declares to have exactly one.
    const err = refusal(() => deliveryKey(obligation, 'whatsapp', 'promo::v2'));
    expect(err.code).toBe('notification.obligation_key_field_invalid');
    expect(err.subject).toBe('providerContext/separator');
  });

  it('refuses a provider context carrying the attempt separator', () => {
    const err = refusal(() => deliveryKey(obligation, 'whatsapp', 'promo#2'));
    expect(err.code).toBe('notification.obligation_key_field_invalid');
    expect(err.subject).toBe('providerContext/separator');
  });

  it('refuses a provider context carrying a second context separator', () => {
    const err = refusal(() => deliveryKey(obligation, 'whatsapp', 'promo@v2'));
    expect(err.code).toBe('notification.obligation_key_field_invalid');
    expect(err.subject).toBe('providerContext/separator');
  });

  it('refuses a provider context carrying the field separator', () => {
    const err = refusal(() => deliveryKey(obligation, 'whatsapp', 'promo|v2'));
    expect(err.code).toBe('notification.obligation_key_field_invalid');
    expect(err.subject).toBe('providerContext/separator');
  });

  /**
   * The field check and the composed check are not the same rule, which is the
   * whole lesson of N-7. These cases reach the COMPOSED check directly, by
   * handing `deliveryKey` an obligation string that is already malformed —
   * which is what a caller that composed one by hand would do. Without them the
   * composed check would be unreachable code that looks like a guard.
   */
  it('refuses a composition that already carries the delivery separator', () => {
    const err = refusal(() => deliveryKey(`${obligation}::sms`, 'whatsapp'));
    expect(err.code).toBe('notification.delivery_key_invalid');
    expect(err.subject).toBe('deliveryKey/composed_double_colon_count_2');
  });

  it('refuses a composition whose context sits before the channel', () => {
    const err = refusal(() => deliveryKey(`${obligation}@early`, 'whatsapp'));
    expect(err.code).toBe('notification.delivery_key_invalid');
    expect(err.subject).toBe('deliveryKey/composed_at_before_channel');
  });

  it('refuses a composition carrying the attempt separator', () => {
    const err = refusal(() => deliveryKey(`${obligation}#1`, 'whatsapp'));
    expect(err.code).toBe('notification.delivery_key_invalid');
    expect(err.subject).toBe('deliveryKey/composed_hash');
  });

  /**
   * WHAT THE ENUMERATION SETTLED. I claimed this branch was unreachable through
   * `deliveryKey`, reasoning that a second `@` could only come from the
   * obligation and would sit before the `::`. The enumeration below refuses
   * that: an obligation carrying an `@` together with a context produces TWO,
   * and the count check — which runs before the position check — is what
   * answers. So both `@` refusals are reachable, each from its own shape, and
   * the case asserts the whole outcome set rather than an argument about it.
   *
   * The lesson is the one the twelfth phase wrote down: a claim about which
   * cases are reachable is itself a claim, and it goes stale the same way. An
   * enumeration is cheap; an argument is not evidence.
   */
  it('refuses a second context separator by count, before judging its position', () => {
    const err = refusal(() => deliveryKey(`${obligation}@one`, 'whatsapp', 'ctx'));
    expect(err.code).toBe('notification.delivery_key_invalid');
    expect(err.subject).toBe('deliveryKey/composed_at_count_2');
  });

  it('enumerates every @ shape this function can compose, and names each outcome', () => {
    const channels = ['whatsapp', 'sms', 'email', 'inapp'] as const;
    const obligations = [obligation, `${obligation}@one`, `pre@a${obligation}`];
    const contexts = [undefined, '', 'ctx'];
    const outcomes = new Set<string>();
    for (const channel of channels) {
      for (const ob of obligations) {
        for (const ctx of contexts) {
          try {
            const key = deliveryKey(ob, channel, ctx);
            outcomes.add('accepted');
            // Whatever is accepted must carry at most one `@`, and after the `::`.
            expect(key.split('@').length - 1).toBeLessThanOrEqual(1);
            if (key.includes('@')) expect(key.indexOf('@')).toBeGreaterThan(key.indexOf('::'));
          } catch (err) {
            outcomes.add(err instanceof NotificationRefusal ? err.subject : 'other');
          }
        }
      }
    }
    expect([...outcomes].sort()).toEqual(['accepted', 'deliveryKey/composed_at_before_channel', 'deliveryKey/composed_at_count_2']);
  });
});

describe('D-6 — and the same asymmetry one level up', () => {
  it('refuses an attempt identity over a delivery key carrying a hash', () => {
    const err = refusal(() => attemptIdentity(`${obligation}::whatsapp#1`, 2));
    expect(err.code).toBe('notification.attempt_identity_invalid');
    expect(err.subject).toBe('attemptIdentity/delivery_hash');
  });

  it('still makes the attempt identity it existed to make', () => {
    expect(attemptIdentity(deliveryKey(obligation, 'whatsapp'), 3)).toBe(`${obligation}::whatsapp#3`);
  });
});
