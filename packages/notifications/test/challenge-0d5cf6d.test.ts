/**
 * The THIRD independent challenge, at `0d5cf6d`. Verdict PASS-WITH-SCOPE with
 * N-6 (P1, in the DDL) the blocker and two new code findings.
 *
 * N-6 is not here, because it is not in this package: it is the DDL's release
 * clause depending on an ordering enforced on another column of another
 * relation. Its proof is executable SQL — `proof/run-p8-ddl-proof.sh`, case
 * N6-e — because the defect is reachable only from direct SQL, which is the
 * threat model the trigger exists for and the one a pure test cannot reach.
 *
 * What is here is N-7 and N-8.
 */
import { describe, expect, it } from 'vitest';
import { attemptIdentity, deliveryKey, obligationKey, originKeyFieldsAreValid, type NotificationOrigin } from '../src/identity';
import { NotificationRefusal } from '../src/errors';
import { classifySend } from '../src/delivery';
import { MAX_ATTEMPTS, nextStepAfterFailure } from '../src/retry';

const customer = { kind: 'customer', customerId: 'c1' } as const;

describe('N-7 — the law is asserted on the COMPOSED key, not only on the parts', () => {
  // The challenger's own case, verbatim in effect: an occurrence key that
  // merely BEGINS with a colon carries no `::` of its own, and the composition
  // `schedule:<id>:<occurrence>` supplies the first one.
  const leadingColon: NotificationOrigin = { source: 'schedule', scheduleId: 's1', occurrenceKey: ':00' };

  it('refuses an occurrence that forms `::` at the JOIN, which no field check can see', () => {
    expect(() => obligationKey('biz-1', leadingColon, 'k', customer)).toThrow(NotificationRefusal);
    try {
      obligationKey('biz-1', leadingColon, 'k', customer);
      throw new Error('unreachable');
    } catch (err) {
      // Named, not merely thrown: the subject says WHERE the law was broken.
      expect(err).toBeInstanceOf(NotificationRefusal);
      expect((err as NotificationRefusal).code).toBe('notification.obligation_key_field_invalid');
      expect((err as NotificationRefusal).subject).toBe('originKey/composed_double_colon');
    }
  });

  it('and the planner learns it WITHOUT composing a key, so a batch refuses one firing instead of dying', () => {
    expect(originKeyFieldsAreValid(leadingColon)).toEqual({ valid: false, detail: 'originKey/composed_double_colon' });
    // An occurrence of exactly ':' does the same thing.
    expect(originKeyFieldsAreValid({ source: 'schedule', scheduleId: 's1', occurrenceKey: ':' }).valid).toBe(false);
  });

  it('a trailing colon is harmless and stays legal, because nothing follows it in the segment', () => {
    // `|` terminates the segment, so `…:00:|kind|…` forms no `::`. The rule is
    // the composition's, not a new prohibition invented for symmetry.
    const trailing: NotificationOrigin = { source: 'schedule', scheduleId: 's1', occurrenceKey: '2026-10:' };
    expect(originKeyFieldsAreValid(trailing)).toEqual({ valid: true });
    expect(obligationKey('biz-1', trailing, 'k', customer)).toBe('biz-1|schedule:s1:2026-10:|k|customer:c1');
  });

  it('the ISO occurrence the second challenge made legal is STILL legal — the fix is not a re-blanket', () => {
    const iso: NotificationOrigin = { source: 'schedule', scheduleId: 's1', occurrenceKey: '2026-10-12T00:00' };
    expect(originKeyFieldsAreValid(iso)).toEqual({ valid: true });
    const obligation = obligationKey('biz-1', iso, 'customer_statement', customer);
    expect(obligation).toBe('biz-1|schedule:s1:2026-10-12T00:00|customer_statement|customer:c1');
    // And the guarantee the relaxation rests on now HOLDS: splitting a delivery
    // key on `::` yields exactly two parts, the first of which is the obligation.
    const delivery = deliveryKey(obligation, 'whatsapp');
    expect(delivery.split('::')).toHaveLength(2);
    expect(delivery.split('::')[0]).toBe(obligation);
    expect(attemptIdentity(delivery, 3)).toBe(`${obligation}::whatsapp#3`);
  });

  // Stated so that nobody counts it as proved: the SECOND composed check, the
  // one in `obligationKey`, is unreachable with today's rules, and this case is
  // the enumeration that says why rather than a mutation that cannot land.
  // Every field except the occurrence refuses `:` outright, so no join that
  // `obligationKey` makes can produce `::`. It is kept as the guard for a future
  // field that is allowed a colon, and it carries no red proof because no input
  // reaches it.
  it('no field other than the occurrence may carry a colon at all, which is why only that join can form `::`', () => {
    expect(() => obligationKey('biz:1', { source: 'event', eventId: 'e1' }, 'k', customer)).toThrow(NotificationRefusal);
    expect(() => obligationKey('biz-1', { source: 'event', eventId: 'e:1' }, 'k', customer)).toThrow(NotificationRefusal);
    expect(() => obligationKey('biz-1', { source: 'event', eventId: 'e1' }, 'k:1', customer)).toThrow(NotificationRefusal);
    expect(() => obligationKey('biz-1', { source: 'event', eventId: 'e1' }, 'k', { kind: 'customer', customerId: 'c:1' })).toThrow(NotificationRefusal);
    expect(() => obligationKey('biz-1', { source: 'schedule', scheduleId: 's:1', occurrenceKey: '2026-10' }, 'k', customer)).toThrow(NotificationRefusal);
  });
});

describe('N-8 — a stop says WHY it stopped, and the policy decides, not the reader', () => {
  it('an exhausted schedule and a terminal class no longer report the same shape', () => {
    const exhausted = nextStepAfterFailure(MAX_ATTEMPTS - 1, 'PROVIDER_TIMEOUT');
    const terminal = nextStepAfterFailure(0, 'RECIPIENT_REJECTED');
    expect(exhausted).toEqual({ step: 'dead', attempts: MAX_ATTEMPTS, reason: 'PROVIDER_TIMEOUT', cause: 'attempt_limit' });
    expect(terminal).toEqual({ step: 'dead', attempts: 1, reason: 'RECIPIENT_REJECTED', cause: 'terminal_class' });
    // The distinction is in the value, not in the reader's knowledge of the
    // class table — which is what the finding objected to.
    expect(exhausted.step === 'dead' && exhausted.cause).not.toBe(terminal.step === 'dead' && terminal.cause);
  });

  it('and `classifySend` carries the cause through rather than re-deriving it', () => {
    const atLimit = classifySend({
      result: { outcome: 'rejected', retryable: true, code: 'PROVIDER_TIMEOUT' },
      providerServerSideIdempotency: false,
      attemptsMade: MAX_ATTEMPTS,
      maxAttempts: MAX_ATTEMPTS,
      backoffSeconds: () => 1,
    });
    expect(atLimit).toEqual({
      state: 'dead',
      next: { action: 'stop', reason: 'PROVIDER_TIMEOUT', cause: 'attempt_limit', attempts: MAX_ATTEMPTS },
    });

    const firstAttempt = classifySend({
      result: { outcome: 'rejected', retryable: true, code: 'TEMPLATE_REJECTED' },
      providerServerSideIdempotency: false,
      attemptsMade: 1,
      maxAttempts: MAX_ATTEMPTS,
      backoffSeconds: () => 1,
    });
    expect(firstAttempt).toEqual({
      state: 'dead',
      next: { action: 'stop', reason: 'TEMPLATE_REJECTED', cause: 'terminal_class', attempts: 1 },
    });
  });

  it('an ambiguous delivery that runs out of attempts says the limit, and never says it failed', () => {
    const out = classifySend({
      result: { outcome: 'unknown', reason: 'timeout_after_send' },
      providerServerSideIdempotency: true,
      attemptsMade: MAX_ATTEMPTS,
      maxAttempts: MAX_ATTEMPTS,
      backoffSeconds: () => 1,
    });
    expect(out.state).toBe('unknown');
    expect(out.next).toMatchObject({ action: 'stop', cause: 'attempt_limit', attempts: MAX_ATTEMPTS });
  });
});
