/**
 * B3 — WHERE THE ROUNDING HAPPENS, AND WHAT IT COSTS.
 *
 * The owner's ruling (DR-95): every line that APPEARS on the invoice — the
 * credit for the unused remainder of the outgoing plan, and the charge for the
 * remainder of the incoming one — is rounded ONCE to the minor unit under
 * HALF_EVEN, the accounting core's own policy, and the total is the EXACT sum
 * of those rounded lines. The difference is never rounded a second time.
 *
 * The reason is auditability, not arithmetic: a reader adding up the lines
 * printed on the invoice must get the total printed on it, every time. A total
 * computed by rounding the net once would be right to the cent and would not
 * equal the sum of the lines shown above it.
 *
 * THE DECLARED COST, which is what this file exists to pin: rounding the two
 * sides separately may differ from rounding their difference once by up to ONE
 * MINOR UNIT PER ROUNDED LINE, and the direction follows which side landed on
 * a tie. The cases below do not assume that bound — they sweep for it, assert
 * it holds, and assert that a case reaching it EXISTS, because a bound nothing
 * attains is a bound nobody has measured.
 */
import { describe, expect, it } from 'vitest';
import { divHalfEven, proratePlanChange, proratedAmountMinor } from '../src/proration';
import { composeSubscriptionInvoice } from '../src/invoice';
import { periodLengthMs } from '../src/period';
import { type BillingPeriod, type Price } from '../src/types';

const PERIOD: BillingPeriod = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-02-01T00:00:00.000Z' };
const price = (amountMinor: bigint): Price => ({ amountMinor, currency: 'ILS' });

/** What the invoice would say if the NET were rounded once instead. */
function netRoundedOnce(from: Price, to: Price, period: BillingPeriod, changeAt: string): bigint {
  const totalMs = BigInt(periodLengthMs(period));
  const remainingMs = BigInt(Date.parse(period.endsAt) - Date.parse(changeAt));
  const delta = to.amountMinor - from.amountMinor;
  // HALF_EVEN is stated for a non-negative numerator, so the sign is carried
  // outside the rule rather than smuggled into it.
  const magnitude = divHalfEven((delta < 0n ? -delta : delta) * remainingMs, totalMs);
  return delta < 0n ? -magnitude : magnitude;
}

describe('B3 — each line is rounded once, and the total is their exact sum', () => {
  it('rounds each side with the SAME rule the accounting core states, and nets without rounding again', () => {
    const from = price(4_999n);
    const to = price(9_999n);
    const changeAt = '2026-01-17T13:37:00.000Z';
    const r = proratePlanChange({ from, to, period: PERIOD, changeAt });
    // Each side is the rounded proration of its own price: one rounding each.
    expect(r.creditMinor).toBe(proratedAmountMinor(from, PERIOD, changeAt));
    expect(r.chargeMinor).toBe(proratedAmountMinor(to, PERIOD, changeAt));
    // And the net is their plain difference — no second rounding anywhere.
    expect(r.netMinor).toBe(r.chargeMinor - r.creditMinor);
  });

  it('the invoice total is the EXACT sum of the rounded lines, over a swept range', () => {
    let composed = 0;
    for (let fromMinor = 1n; fromMinor <= 400n; fromMinor += 7n) {
      for (let toMinor = 1n; toMinor <= 400n; toMinor += 11n) {
        const changeAt = '2026-01-10T06:00:00.000Z';
        const r = proratePlanChange({ from: price(fromMinor), to: price(toMinor), period: PERIOD, changeAt });
        if (r.chargeMinor === 0n || r.creditMinor === 0n) continue; // a zero line is refused, by design
        if (r.chargeMinor - r.creditMinor < 0n) continue; // net credit is a credit note, not an invoice
        const inv = composeSubscriptionInvoice({
          lines: [
            { kind: 'plan', ref: 'plan-pro', currency: 'ILS', amountMinor: r.chargeMinor, memo: 'the incoming plan, prorated' },
            { kind: 'proration_credit', ref: 'plan-basic', currency: 'ILS', amountMinor: r.creditMinor, memo: 'the outgoing plan, unused' },
          ],
        });
        expect(inv.totalMinor).toBe(r.chargeMinor - r.creditMinor);
        expect(inv.totalMinor).toBe(inv.subtotalMinor);
        composed += 1;
      }
    }
    // CONTROL: the sweep actually composed invoices. A property over an empty
    // set is not a property.
    expect(composed).toBeGreaterThan(50);
  });

  it('THE DECLARED COST: at most one minor unit per rounded line against rounding the net once, and the bound is REACHED', () => {
    let worst = 0n;
    let reached = 0;
    let compared = 0;
    for (let fromMinor = 1n; fromMinor <= 600n; fromMinor += 1n) {
      for (const changeAt of ['2026-01-05T00:00:00.000Z', '2026-01-16T12:00:00.000Z', '2026-01-17T00:00:00.000Z']) {
        const to = price(fromMinor + 317n);
        const r = proratePlanChange({ from: price(fromMinor), to, period: PERIOD, changeAt });
        const once = netRoundedOnce(price(fromMinor), to, PERIOD, changeAt);
        const drift = r.netMinor - once;
        const magnitude = drift < 0n ? -drift : drift;
        if (magnitude > worst) worst = magnitude;
        if (magnitude === 1n) reached += 1;
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(1000);
    // The bound: one minor unit per rounded line, and there are two lines, so
    // the net moves by at most one — each side's own error is at most half a
    // unit, and only a tie sends it the whole way.
    expect(worst).toBeLessThanOrEqual(1n);
    // And it is attained, so the bound is measured and not merely permitted.
    expect(reached).toBeGreaterThan(0);
  });

  it('a tie is broken toward even, which is where the drift comes from', () => {
    const totalMs = BigInt(periodLengthMs(PERIOD));
    // Exactly half, with an even quotient: stays.
    expect(divHalfEven(totalMs / 2n, totalMs)).toBe(0n);
    // Exactly half, with an odd quotient: goes up to the even one.
    expect(divHalfEven(totalMs + totalMs / 2n, totalMs)).toBe(2n);
    // Either side of the tie, for the control that the rule is not simply
    // flooring or ceiling everything.
    expect(divHalfEven(totalMs / 2n - 1n, totalMs)).toBe(0n);
    expect(divHalfEven(totalMs / 2n + 1n, totalMs)).toBe(1n);
  });
});
