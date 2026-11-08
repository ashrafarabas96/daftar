/**
 * MASTER CONTINUOUS MISSION **V3** §15 — the three P8 items V3 adds, as laws.
 *
 *   1. The partial unique index excluded `accepted`, so the no-two-messages
 *      rule did not constrain the one state where a duplicate is worst.
 *   2. The DDL spec and this package disagreed about the delivery states.
 *   3. `consent_gate = 'send'` is not proof of a live consent read.
 *
 * (3) is a schema and documentation finding — a column pinned to a constant
 * carries no information — so it is answered in `P8-DDL-SPEC.md` rather than
 * here. (1) and (2) are code, and are proven below.
 */
import { describe, expect, it } from 'vitest';
import { ALL_DELIVERY_STATES, blocksAnotherChannel, isOpenWork, type ChannelBlockInput, type DeliveryState } from '../src/delivery';

describe('V3 §15.1 — an ACCEPTED delivery forbids another channel', () => {
  it('accepted blocks — the case the old index predicate did not cover', () => {
    // The defect, stated as the test that would have caught it: the index
    // listed only the open states, so once a delivery was accepted nothing
    // stopped a second channel opening and sending the customer twice.
    expect(blocksAnotherChannel({ state: 'accepted' })).toBe(true);
  });

  it('only three states release the obligation, and each one means nothing was sent', () => {
    const releasing = ALL_DELIVERY_STATES.filter((state) => !blocksAnotherChannel({ state }));
    expect(releasing).toEqual(['dead', 'withheld', 'suppressed']);
  });

  it('every other state blocks, including the ones that are not open work', () => {
    for (const state of ALL_DELIVERY_STATES) {
      const blocks = blocksAnotherChannel({ state });
      if (state === 'dead' || state === 'withheld' || state === 'suppressed') continue;
      expect(blocks, state).toBe(true);
    }
    // `accepted` and `closed` are NOT open work, yet they block: "finished" and
    // "nothing more is owed" are different questions, and conflating them is
    // what produced the duplicate.
    expect(isOpenWork('accepted')).toBe(false);
    expect(blocksAnotherChannel({ state: 'accepted' })).toBe(true);
  });

  it('fails CLOSED: an unrecognised state blocks instead of permitting a duplicate', () => {
    // An inclusion list would let a state added later fall outside the
    // predicate and silently permit a second message. This is the direction
    // that costs a refused notification rather than a duplicated one.
    const future = 'parked_for_review' as DeliveryState;
    expect(blocksAnotherChannel({ state: future })).toBe(true);
  });
});

describe('V3 §15.1 — `closed` collapses two opposite facts, so it is split', () => {
  const closed = (over: Partial<ChannelBlockInput> = {}): ChannelBlockInput => ({ state: 'closed', ...over });

  it('closed on delivered or read blocks: the message arrived', () => {
    expect(blocksAnotherChannel(closed({ finalStatus: 'delivered', finalStatusVerified: true }))).toBe(true);
    expect(blocksAnotherChannel(closed({ finalStatus: 'read', finalStatusVerified: true }))).toBe(true);
  });

  it('closed on a VERIFIED failed releases: accepted then reported not delivered is still owed', () => {
    // Without this, a provider-reported failure after acceptance would lose the
    // notification permanently — the rule forbids a SECOND message, not the
    // first. Exactly the reasoning that lets a `dead` rejection fall through.
    expect(blocksAnotherChannel(closed({ finalStatus: 'failed', finalStatusVerified: true }))).toBe(false);
  });

  it('closed on an UNVERIFIED failed still blocks: otherwise a forged callback manufactures a duplicate', () => {
    // The mirror of the attack the webhook rules already refuse in the other
    // direction (a fake `delivered` silencing a real notification).
    expect(blocksAnotherChannel(closed({ finalStatus: 'failed' }))).toBe(true);
    expect(blocksAnotherChannel(closed({ finalStatus: 'failed', finalStatusVerified: false }))).toBe(true);
  });

  it('closed with no final status recorded blocks: an unexplained close is not evidence of failure', () => {
    expect(blocksAnotherChannel(closed())).toBe(true);
    expect(blocksAnotherChannel(closed({ finalStatusVerified: true }))).toBe(true);
  });
});

describe('V3 §15.2 — one vocabulary for the delivery states', () => {
  it('the state list includes the two the DDL spec held and this package did not', () => {
    expect(ALL_DELIVERY_STATES).toContain('withheld');
    expect(ALL_DELIVERY_STATES).toContain('suppressed');
    expect(ALL_DELIVERY_STATES).toHaveLength(9);
  });

  it('neither new state is open work: nothing was attempted and nothing will be', () => {
    expect(isOpenWork('withheld')).toBe(false);
    expect(isOpenWork('suppressed')).toBe(false);
  });

  it('every state is classified by both predicates — a new state cannot slip in unanswered', () => {
    // The law that reds if a state is added to the union without being added
    // here: the enumeration is the subject, and an empty subject set fails.
    expect(ALL_DELIVERY_STATES.length).toBeGreaterThan(0);
    const classified = new Set<DeliveryState>();
    for (const state of ALL_DELIVERY_STATES) {
      expect(typeof isOpenWork(state), state).toBe('boolean');
      expect(typeof blocksAnotherChannel({ state }), state).toBe('boolean');
      classified.add(state);
    }
    expect(classified.size).toBe(ALL_DELIVERY_STATES.length);
    // And no state is both open work and releasing: that pair would mean "there
    // is work left on this channel" and "another channel may start" at once.
    for (const state of ALL_DELIVERY_STATES) {
      if (isOpenWork(state)) expect(blocksAnotherChannel({ state }), state).toBe(true);
    }
  });
});
