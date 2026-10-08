/**
 * `composePlanChangeBilling` — the one place the SIGN of a proration turns
 * into an action, and the place `TL-P5-R3` is enforced rather than described.
 *
 * The three outcomes are tested by construction, not by inspection: a real
 * upgrade, a real downgrade and a real same-price change through the same
 * function, with the arithmetic checked against `proratePlanChange` so a
 * composer that silently dropped a line would be caught.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composePlanChangeBilling, PLAN_CHANGE_OUTCOMES, type PlanChangeInput } from '../src/plan-change';
import { proratePlanChange } from '../src/proration';
import { foldCreditBalance } from '../src/credit';
import { BillingError } from '../src/errors';
import { blankOut } from './helpers/lexer';
import type { BillingPeriod } from '../src/types';

const APRIL: BillingPeriod = { startsAt: '2026-04-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' };
/** Exactly half of April, so a half-price remainder is exact and needs no rounding story. */
const MID = '2026-04-16T00:00:00.000Z';

function base(fromMinor: bigint, toMinor: bigint): PlanChangeInput {
  return {
    period: APRIL,
    changeAt: MID,
    from: { amountMinor: fromMinor, currency: 'ILS' },
    to: { amountMinor: toMinor, currency: 'ILS' },
    fromPlanKey: 'PLAN_BASIC',
    toPlanKey: 'PLAN_PRO',
    adjustmentId: 'adj-0001',
    creditReason: 'mid-period downgrade proration',
  };
}

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

describe('composePlanChangeBilling', () => {
  it('declares exactly three outcomes', () => {
    expect(PLAN_CHANGE_OUTCOMES).toEqual(['invoice', 'credit', 'nothing']);
  });

  it('an UPGRADE produces an invoice carrying both proration lines', () => {
    const input = base(10_000n, 30_000n);
    const expected = proratePlanChange(input);
    const result = composePlanChangeBilling(input);
    expect(result.outcome).toBe('invoice');
    if (result.outcome !== 'invoice') throw new Error('unreachable');
    expect(result.invoice.totalMinor).toBe(expected.netMinor);
    expect(result.invoice.chargeMinor).toBe(expected.chargeMinor);
    expect(result.invoice.creditMinor).toBe(expected.creditMinor);
    // Both sides are shown, each POSITIVE, with the kind carrying direction.
    expect(result.invoice.lines.map((l) => [l.kind, l.ref, l.amountMinor])).toEqual([
      ['proration_charge', 'PLAN_PRO', expected.chargeMinor],
      ['proration_credit', 'PLAN_BASIC', expected.creditMinor],
    ]);
    expect(result.invoice.lines.every((l) => l.amountMinor > 0n)).toBe(true);
    expect(result.invoice.taxMinor).toBe(0n);
  });

  it('a DOWNGRADE produces ONE credit grant and NO invoice', () => {
    const input = base(30_000n, 10_000n);
    const expected = proratePlanChange(input);
    expect(expected.netMinor).toBeLessThan(0n);
    const result = composePlanChangeBilling(input);
    expect(result.outcome).toBe('credit');
    if (result.outcome !== 'credit') throw new Error('unreachable');
    // The whole of the negative net becomes the credit, positive.
    expect(result.adjustment.amountMinor).toBe(-expected.netMinor);
    expect(result.adjustment.kind).toBe('grant');
    expect(result.adjustment.currency).toBe('ILS');
    expect(result.adjustment.occurredAt).toBe(MID);
    expect(result.adjustment.id).toBe('adj-0001');
    expect(result.adjustment.reason).toBe('mid-period downgrade proration');
    // There is no invoice on this branch at all — not a zero one, not an
    // empty one. The shape is the enforcement.
    expect('invoice' in result).toBe(false);
  });

  it("the downgrade's credit is a real ledger entry the fold accepts", () => {
    // The two halves of `TL-P5-R3` joined: what the composer produces is
    // exactly what the balance authority consumes, with no adapter between
    // them that could change a sign.
    const result = composePlanChangeBilling(base(30_000n, 10_000n));
    if (result.outcome !== 'credit') throw new Error('expected a credit');
    const balance = foldCreditBalance([result.adjustment], 'ILS');
    expect(balance.balanceMinor).toBe(10_000n);
    expect(balance.grantedMinor).toBe(10_000n);
    expect(balance.consumedMinor).toBe(0n);
  });

  it('a SAME-PRICE change produces nothing — no invoice, no adjustment', () => {
    const result = composePlanChangeBilling(base(20_000n, 20_000n));
    expect(result.outcome).toBe('nothing');
    expect('invoice' in result).toBe(false);
    expect('adjustment' in result).toBe(false);
    // The proration is still returned, because that is the figure support is
    // asked about when a merchant sees a plan change that cost nothing.
    expect(result.proration.netMinor).toBe(0n);
    expect(result.proration.creditMinor).toBe(10_000n);
    expect(result.proration.chargeMinor).toBe(10_000n);
  });

  it('never produces a negative invoice total, over a swept range of price pairs', () => {
    // A property rather than an example: every pair either invoices a
    // positive total or credits a positive amount, and no third thing ever
    // happens.
    let invoiced = 0;
    let credited = 0;
    let nothing = 0;
    for (let from = 0n; from <= 40_000n; from += 2_500n) {
      for (let to = 0n; to <= 40_000n; to += 2_500n) {
        const r = composePlanChangeBilling(base(from, to));
        if (r.outcome === 'invoice') {
          expect(r.invoice.totalMinor).toBeGreaterThan(0n);
          invoiced++;
        } else if (r.outcome === 'credit') {
          expect(r.adjustment.amountMinor).toBeGreaterThan(0n);
          credited++;
        } else {
          nothing++;
        }
      }
    }
    // Non-vacuity: all three branches were actually exercised by the sweep.
    expect(invoiced).toBeGreaterThan(0);
    expect(credited).toBeGreaterThan(0);
    expect(nothing).toBeGreaterThan(0);
    expect(invoiced + credited + nothing).toBe(17 * 17);
  });

  it('refuses a change that does not name its plans, its adjustment identity or its reason', () => {
    expectRefusal(() => composePlanChangeBilling({ ...base(10n, 20n), fromPlanKey: ' ' }), 'billing.payload_invalid');
    expectRefusal(() => composePlanChangeBilling({ ...base(10n, 20n), toPlanKey: '' }), 'billing.payload_invalid');
    expectRefusal(() => composePlanChangeBilling({ ...base(10n, 20n), adjustmentId: '' }), 'billing.payload_invalid');
    expectRefusal(() => composePlanChangeBilling({ ...base(10n, 20n), creditReason: '   ' }), 'billing.credit_reason_required');
  });

  it('refuses the reason and the identity even when the outcome will NOT be a credit', () => {
    // An upgrade does not create a credit, so it is tempting to validate the
    // credit's fields lazily. Then a downgrade of the same subscription a
    // month later is the first time anyone discovers the caller never had an
    // id to mint. The fields are required up front for every outcome.
    expectRefusal(() => composePlanChangeBilling({ ...base(10_000n, 30_000n), adjustmentId: '' }), 'billing.payload_invalid');
    expectRefusal(() => composePlanChangeBilling({ ...base(10_000n, 30_000n), creditReason: '' }), 'billing.credit_reason_required');
  });

  it('refuses a cross-currency change, and refuses a change outside its period', () => {
    expectRefusal(
      () => composePlanChangeBilling({ ...base(10_000n, 30_000n), to: { amountMinor: 30_000n, currency: 'USD' } }),
      'billing.proration_currency_mismatch',
    );
    expectRefusal(() => composePlanChangeBilling({ ...base(10_000n, 30_000n), changeAt: APRIL.endsAt }), 'billing.proration_outside_period');
  });
});

describe('TL-P5-R3 — the composer holds no path to cash either', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'src', 'plan-change.ts'), 'utf8');
  const CODE = blankOut(SOURCE);

  it('mentions the ruling in prose (non-vacuity for the scan below)', () => {
    expect(SOURCE.toLowerCase()).toContain('refund');
    expect(SOURCE.toLowerCase()).toContain('payout');
  });

  it('contains no refund or payout symbol in CODE, and imports no provider', () => {
    expect(CODE.toLowerCase()).not.toContain('refund');
    expect(CODE.toLowerCase()).not.toContain('payout');
    expect(CODE).not.toContain('./ports');
    expect(CODE).not.toContain('./fake-provider');
  });
});
