/**
 * THE STUCK BALANCE, PREVENTED AT ITS ORIGIN (DR-97).
 *
 * B1 closed the hole where a credit balance in one currency could be
 * subtracted from an invoice in another. Closing it left a question the
 * reviewer put to the owner: a business granted credit in ILS whose
 * subscription then moves to USD holds a balance that can never be spent,
 * because `foldCreditBalance` scopes a ledger to ONE currency and this slice
 * has no rate, no expiry and no reversal.
 *
 * The owner's ruling: NO automatic conversion, ever. Instead the currency
 * change is refused at its origin while a non-zero balance in another currency
 * exists, by name, and the only way out is an explicit audited administrative
 * command (refund, or write-off with a mandatory reason) which is a card of its
 * own and release-blocking.
 *
 * So a plan change now reads the ledger it could strand. `proratePlanChange`
 * already refuses a change that crosses currencies INSIDE one period
 * (`billing.proration_currency_mismatch`, measured below as the control that
 * this file adds a law and removes none); what was missing is the case where
 * the plan change itself is consistent but the BALANCE is in another currency.
 */
import { describe, expect, it } from 'vitest';
import { composePlanChangeBilling, type PlanChangeInput } from '../src/plan-change';
import { type CreditAdjustment } from '../src/credit';
import { BillingError } from '../src/errors';
import type { BillingPeriod } from '../src/types';

const APRIL: BillingPeriod = { startsAt: '2026-04-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' };
const MID = '2026-04-16T00:00:00.000Z';

function grant(id: string, amountMinor: bigint, currency: string): CreditAdjustment {
  return {
    id,
    businessId: 'biz-1',
    kind: 'grant',
    amountMinor,
    currency,
    occurredAt: '2026-03-01T00:00:00.000Z',
    ref: 'earlier-downgrade',
    reason: 'the remainder of an earlier downgrade',
  };
}

function consumption(id: string, amountMinor: bigint, currency: string): CreditAdjustment {
  return {
    id,
    businessId: 'biz-1',
    kind: 'consumption',
    amountMinor,
    currency,
    occurredAt: '2026-03-15T00:00:00.000Z',
    ref: 'inv-2026-03',
    reason: 'applied at an earlier finalization',
    appliesToGrantId: 'g1',
  };
}

function change(currency: string, ledger: readonly CreditAdjustment[]): PlanChangeInput {
  return {
    period: APRIL,
    changeAt: MID,
    from: { amountMinor: 30_000n, currency },
    to: { amountMinor: 10_000n, currency },
    businessId: 'biz-1',
    fromPlanKey: 'PLAN_PRO',
    toPlanKey: 'PLAN_BASIC',
    adjustmentId: 'adj-0002',
    creditReason: 'mid-period downgrade proration',
    ledger,
  };
}

function expectRefusal(fn: () => unknown, code: string): BillingError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
  return caught as BillingError;
}

describe('DR-97 — a plan change may not strand a credit balance in another currency', () => {
  it('REFUSES by name: a USD plan change while an ILS balance is unspent', () => {
    const e = expectRefusal(() => composePlanChangeBilling(change('USD', [grant('g1', 5_000n, 'ILS')])), 'billing.subscription_currency_locked_by_credit');
    // The refusal must name the currency that holds the balance, or the
    // operator cannot tell which of the two is the obstacle.
    expect(JSON.stringify(e.toSafeJSON())).toContain('ILS');
  });

  it('POSITIVE CONTROL: the same change in the currency the balance is in is accepted', () => {
    const r = composePlanChangeBilling(change('ILS', [grant('g1', 5_000n, 'ILS')]));
    expect(['invoice', 'credit', 'nothing']).toContain(r.outcome);
  });

  it('a balance that is ZERO does not lock anything: there is nothing to strand', () => {
    // The grant was fully consumed, so the fold is 0 and the business holds no
    // ILS. Moving to USD strands nothing and is allowed.
    const spent = [grant('g1', 5_000n, 'ILS'), consumption('c1', 5_000n, 'ILS')];
    const r = composePlanChangeBilling(change('USD', spent));
    expect(['invoice', 'credit', 'nothing']).toContain(r.outcome);
  });

  it('an EMPTY ledger does not lock anything', () => {
    const r = composePlanChangeBilling(change('USD', []));
    expect(['invoice', 'credit', 'nothing']).toContain(r.outcome);
  });

  it('the ledger is MANDATORY: a plan change that cannot see the balance is refused, not assumed empty', () => {
    const { ledger: _dropped, ...withoutLedger } = change('USD', []);
    expectRefusal(() => composePlanChangeBilling(withoutLedger as unknown as PlanChangeInput), 'billing.payload_invalid');
  });

  it('NEGATIVE CONTROL: the refusal that already existed still fires, so this adds a law and removes none', () => {
    // A change whose two prices disagree about currency is refused by
    // `proratePlanChange` as it always was -- before the balance is ever read.
    const crossing = { ...change('ILS', []), to: { amountMinor: 10_000n, currency: 'USD' } };
    expectRefusal(() => composePlanChangeBilling(crossing), 'billing.proration_currency_mismatch');
  });

  it('NEGATIVE CONTROL: a ledger that mixes two currencies still refuses, by the older code', () => {
    // The fold owns that rule and keeps it: this law reads a balance, it does
    // not re-implement the ledger's own invariants.
    expectRefusal(() => composePlanChangeBilling(change('ILS', [grant('g1', 5_000n, 'ILS'), grant('g2', 1_000n, 'USD')])), 'billing.credit_currency_mismatch');
  });
});
