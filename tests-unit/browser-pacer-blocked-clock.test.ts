/**
 * The browser gate paces itself below the API's per-route allowance. A page's
 * request therefore waits in `RouteBudgets` whenever a route's window is full,
 * and `waitForFocusTarget` adds that wait back to its deadline so the 20s it
 * enforces is 20s OF THE APPLICATION'S OWN TIME.
 *
 * That discount is only honest if the quantity it discounts is a union of
 * blocked intervals. A sum of each wait would exceed wall-clock whenever two
 * requests wait at once - and this gate drives three locale workers through one
 * shared budget, so they wait at once routinely. An over-counted discount is a
 * softened assertion wearing a measurement's clothes, which is worse than no
 * discount at all.
 *
 * Measured on run 40851309513, the failure that produced all of this: step
 * durations were bimodal - six steps between 19.1s and 23.1s, the
 * seventh-slowest at 4.98s, p50 1.68s - and `tr 768px receive` failed at 20.4s
 * while `ar 768px receive` passed at 22.4s. The busiest routes were at 92% of
 * their 240/min budget. Nothing in the application explains a 20s page; the
 * screenshot shows it still on its loading spinner.
 */
import { describe, expect, it } from 'vitest';
import { BlockedClock } from '../tests/browser/pacer';

/** A clock the test moves by hand, so the arithmetic is asserted without sleeping. */
function fake(): { clock: BlockedClock; tick: (ms: number) => void } {
  let now = 1_000;
  return { clock: new BlockedClock(() => now), tick: (ms) => void (now += ms) };
}

describe('BlockedClock - what the readiness deadline is allowed to discount', () => {
  it('is zero before anything waits, so a page the pacer never held gets no allowance at all', () => {
    const { clock, tick } = fake();
    tick(5_000);
    expect(clock.elapsed()).toBe(0);
  });

  it('counts one wait as its own wall-clock', () => {
    const { clock, tick } = fake();
    clock.enter();
    tick(3_000);
    clock.leave();
    expect(clock.elapsed()).toBe(3_000);
  });

  it('counts OVERLAPPING waits once, where a sum of waits would double-count them', () => {
    // Two requests on different routes, both held across the same 4s.
    // Summing each one's own wait gives 4000 + 3000 = 7000ms of discount for
    // 4000ms the page actually lost. This is the case the gate meets on every
    // run, because its three locale workers share one set of route budgets.
    const { clock, tick } = fake();
    clock.enter(); // first request starts waiting
    tick(1_000);
    clock.enter(); // second joins, still inside the first's wait
    tick(3_000);
    clock.leave(); // first is released
    tick(0);
    clock.leave(); // second is released
    expect(clock.elapsed()).toBe(4_000);
    expect(clock.elapsed()).toBeLessThan(4_000 + 3_000);
  });

  it('does not count the gaps between waits, so idle time is never discounted', () => {
    const { clock, tick } = fake();
    clock.enter();
    tick(2_000);
    clock.leave();
    tick(9_000); // the page is free; nothing is being held
    clock.enter();
    tick(1_000);
    clock.leave();
    expect(clock.elapsed()).toBe(3_000);
  });

  it('includes an interval still open, so a deadline computed mid-stall is not short by that stall', () => {
    // waitForFocusTarget polls every 100ms and recomputes its allowance each
    // time. If `elapsed()` only closed intervals, a request held for the whole
    // deadline would contribute nothing until after the step had already
    // failed - which is the exact failure this change exists to remove.
    const { clock, tick } = fake();
    clock.enter();
    tick(12_000);
    expect(clock.elapsed()).toBe(12_000);
    tick(4_000);
    expect(clock.elapsed()).toBe(16_000);
    clock.leave();
    expect(clock.elapsed()).toBe(16_000);
  });

  it('never exceeds the wall-clock it was alive for, however many requests overlap', () => {
    const { clock, tick } = fake();
    const start = 1_000;
    let now = start;
    const advance = (ms: number): void => {
      tick(ms);
      now += ms;
    };
    for (let i = 0; i < 20; i += 1) clock.enter();
    advance(5_000);
    for (let i = 0; i < 20; i += 1) clock.leave();
    advance(1_000);
    expect(clock.elapsed()).toBe(5_000);
    expect(clock.elapsed()).toBeLessThanOrEqual(now - start);
  });

  it('refuses a leave with no matching enter rather than drifting a discount upwards', () => {
    const { clock } = fake();
    expect(() => clock.leave()).toThrow(/without a matching enter/);
  });
});
