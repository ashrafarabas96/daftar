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
import { foldCreditBalance, type CreditAdjustment } from '../src/credit';
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

  it('NEGATIVE CONTROL: the fold still refuses a MIXED ledger by its own older code, which is where that rule lives', () => {
    // The rule did not move and is not relaxed: ask the fold directly and it
    // refuses, exactly as it did before this law existed. What changed is that
    // the composer no longer asks the fold a question about a ledger it was
    // never scoped to answer -- it folds each currency's own rows.
    const mixed = [grant('g1', 5_000n, 'ILS'), grant('g2', 1_000n, 'USD')];
    let caught: unknown;
    try {
      foldCreditBalance(mixed, { businessId: 'biz-1', currency: 'ILS' });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'the fold was expected to refuse a mixed ledger and did not').toBeInstanceOf(BillingError);
    expect((caught as BillingError).code).toBe('billing.credit_currency_mismatch');
  });

  // ─────────────────────────────────────────────────────────────────────
  // THE TWO DEFECTS REVIEW FOUND IN MY FIRST IMPLEMENTATION, each with the
  // measurement that showed it. Both were in the same three lines.
  // ─────────────────────────────────────────────────────────────────────

  it('a ledger row with NO readable currency is a refusal, never a reason to skip the law', () => {
    // MEASURED ON THE FIRST IMPLEMENTATION: with `input.ledger[0]?.currency`
    // read as the scope and the law run only when it was not `undefined`, this
    // exact ledger -- an unspent ILS grant whose FIRST row carries no currency
    // -- was ACCEPTED on a change to USD, and granted a second credit in USD on
    // top of the balance it had just stranded. The unsafe direction was the one
    // the code took, so a row whose currency cannot be read now refuses.
    const headless = { ...grant('g0', 1_000n, 'ILS') } as { currency?: string };
    delete headless.currency;
    expectRefusal(() => composePlanChangeBilling(change('USD', [headless as CreditAdjustment, grant('g1', 5_000n, 'ILS')])), 'billing.payload_invalid');
    // A HOLE in the array is the same defect by another spelling, and it is the
    // second shape the review measured as accepted.
    const holed: CreditAdjustment[] = [];
    holed[1] = grant('g1', 5_000n, 'ILS');
    expectRefusal(() => composePlanChangeBilling(change('USD', holed)), 'billing.payload_invalid');
    // POSITIVE CONTROL: the same two rows, both carrying their currency, reach
    // the law itself and are refused by IT -- so what is measured above is the
    // unreadable row and not the ledger.
    expectRefusal(
      () => composePlanChangeBilling(change('USD', [grant('g0', 1_000n, 'ILS'), grant('g1', 5_000n, 'ILS')])),
      'billing.subscription_currency_locked_by_credit',
    );
    // And a lower-case code is not a currency either, which is the control that
    // says the shape test is doing the work and not the `typeof`.
    expectRefusal(() => composePlanChangeBilling(change('USD', [grant('g1', 5_000n, 'ils')])), 'billing.payload_invalid');
  });

  it('a HISTORY in another currency does not lock a business out of every plan change for good', () => {
    // MEASURED ON THE FIRST IMPLEMENTATION: a ledger holding a fully consumed
    // ILS history beside a live USD balance was refused
    // `billing.credit_currency_mismatch` -- a PAYLOAD code -- for a change in
    // EITHER direction, permanently. That is the normal state after the audited
    // write-off this slice's own release-blocking card describes, so the older
    // refusal was masking this law rather than the other way round.
    const spentIlsLiveUsd = [grant('g1', 5_000n, 'ILS'), consumption('c1', 5_000n, 'ILS'), { ...grant('g2', 7_000n, 'USD'), id: 'g2' }];
    // Nothing in ILS is left to strand, and the USD balance is in the currency
    // the change is in, so there is nothing to refuse.
    const allowed = composePlanChangeBilling(change('USD', spentIlsLiveUsd));
    expect(['invoice', 'credit', 'nothing']).toContain(allowed.outcome);
    // The mirror image, which is the whole point: moving BACK to ILS would
    // strand the live USD balance, and that refuses by THIS law's name and
    // names USD -- not by a payload code, and not by the first row's currency.
    const refused = expectRefusal(() => composePlanChangeBilling(change('ILS', spentIlsLiveUsd)), 'billing.subscription_currency_locked_by_credit');
    expect(JSON.stringify(refused.toSafeJSON())).toContain('USD');
  });

  it('the currency that is stranded need not be the FIRST one the ledger names', () => {
    // THE CONTROL THE MONEY REVIEW ASKED FOR, and it was right that it was
    // missing: every other ledger in this file strands its first-appearing
    // currency, so a regression to `currencies[0]` would have left all of them
    // green. Here the FIRST currency is the one the change is in and its
    // balance is live, and the SECOND is the one that would be stranded.
    const usdFirstIlsStranded = [grant('g1', 7_000n, 'USD'), { ...grant('g2', 5_000n, 'ILS'), occurredAt: '2026-03-02T00:00:00.000Z' }];
    const refused = expectRefusal(() => composePlanChangeBilling(change('USD', usdFirstIlsStranded)), 'billing.subscription_currency_locked_by_credit');
    expect(JSON.stringify(refused.toSafeJSON()), 'the refusal must name the currency that would be stranded, not the first one the ledger names').toContain(
      'ILS',
    );
    // And with three currencies, where the stranded one is neither first nor
    // the one the change is in.
    const third = [
      grant('g1', 7_000n, 'USD'),
      { ...grant('g2', 1_000n, 'EUR'), occurredAt: '2026-03-02T00:00:00.000Z' },
      { ...grant('g3', 5_000n, 'ILS'), occurredAt: '2026-03-03T00:00:00.000Z' },
    ];
    const consumedEur = [...third, { ...consumption('c1', 1_000n, 'EUR'), appliesToGrantId: 'g2' }];
    const stranded = expectRefusal(() => composePlanChangeBilling(change('USD', consumedEur)), 'billing.subscription_currency_locked_by_credit');
    expect(JSON.stringify(stranded.toSafeJSON())).toContain('ILS');
  });

  it('every rule the fold owns still refuses on the per-currency slice', () => {
    // The slice is not a way around the ledger's own invariants: it is the
    // scope they were written for. Out of order by `occurredAt` inside ONE
    // currency still refuses by the fold's own name, and so does a consumption
    // drawing on a grant that is not in its slice.
    const outOfOrder = [
      { ...grant('g1', 5_000n, 'ILS'), occurredAt: '2026-03-20T00:00:00.000Z' },
      { ...grant('g2', 1_000n, 'ILS'), occurredAt: '2026-03-01T00:00:00.000Z' },
    ];
    expectRefusal(() => composePlanChangeBilling(change('USD', outOfOrder)), 'billing.credit_ledger_out_of_order');
    // The ILS slice is spent to zero first, on purpose: otherwise it would
    // refuse by THIS law before the USD slice is ever folded, which is what
    // happened when this case was first written -- the refusal order is first
    // currency first, and that is deterministic rather than incidental.
    const crossSlice = [grant('g1', 5_000n, 'ILS'), consumption('c1', 5_000n, 'ILS'), { ...consumption('c2', 1_000n, 'USD'), appliesToGrantId: 'g1' }];
    expectRefusal(() => composePlanChangeBilling(change('ILS', crossSlice)), 'billing.credit_grant_unknown');
  });
});
