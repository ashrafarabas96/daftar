/**
 * The platform billing credit — `TL-P5-R3`, as executed cases.
 *
 * The ruling has five clauses and each one is a case below: the credit
 * exists, it is DERIVED from immutable adjustments, there is no manually
 * writable balance authority, an overdraw is refused rather than absorbed,
 * and no path from a credit to cash exists in this module at all.
 *
 * The last of those is tested over the module's own SOURCE, because it is an
 * ABSENCE and no call can demonstrate one. The source is blanked first:
 * `credit.ts` explains the ruling in prose, so the words "refund" and
 * "payout" DO appear in its comments, and a raw-text scan would red on the
 * documentation of the very rule it is checking.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldCreditBalance, CREDIT_ADJUSTMENT_KINDS, type CreditAdjustment, type CreditLedgerScope } from '../src/credit';
import { BillingError } from '../src/errors';
import { blankOut } from './helpers/lexer';

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

/** The scope every ledger in this file is folded under. */
const SCOPE: CreditLedgerScope = { businessId: 'biz-1', currency: 'ILS' };

function grant(id: string, amountMinor: bigint, occurredAt: string): CreditAdjustment {
  return { id, businessId: 'biz-1', kind: 'grant', amountMinor, currency: 'ILS', occurredAt, ref: 'plan-change-1', reason: 'downgrade proration' };
}
/**
 * A consumption names the grant it draws down (`TL-P5-R5`), so the helper
 * takes it. Defaulting it would let a case forget the rule it is testing.
 */
function consume(id: string, amountMinor: bigint, occurredAt: string, appliesToGrantId: string): CreditAdjustment {
  return {
    id,
    businessId: 'biz-1',
    kind: 'consumption',
    amountMinor,
    currency: 'ILS',
    occurredAt,
    ref: 'invoice-7',
    reason: 'applied to invoice',
    appliesToGrantId,
  };
}

describe('foldCreditBalance', () => {
  it('folds an empty ledger to a zero balance rather than refusing', () => {
    // A business with no credit history has a balance of zero. Refusing here
    // would make every caller special-case the common state.
    expect(foldCreditBalance([], SCOPE)).toEqual({
      businessId: 'biz-1',
      currency: 'ILS',
      grantedMinor: 0n,
      consumedMinor: 0n,
      balanceMinor: 0n,
      adjustmentCount: 0,
      grants: [],
    });
  });

  it('is granted minus consumed, exactly', () => {
    const b = foldCreditBalance(
      [
        grant('a1', 4_000n, '2026-04-10T00:00:00.000Z'),
        grant('a2', 1_500n, '2026-04-12T00:00:00.000Z'),
        consume('a3', 2_200n, '2026-05-01T00:00:00.000Z', 'a1'),
      ],
      SCOPE,
    );
    expect(b.grantedMinor).toBe(5_500n);
    expect(b.consumedMinor).toBe(2_200n);
    expect(b.balanceMinor).toBe(3_300n);
    expect(b.adjustmentCount).toBe(3);
  });

  it('exposes no way to SET a balance — the only input is the ledger', () => {
    // `TL-P5-R3`: "No manually writable balance authority." The function's
    // arity is the enforcement: there is no second object in which a caller
    // could pass a balance, and the returned record is not read back.
    expect(foldCreditBalance.length).toBe(2);
    const forged = { balanceMinor: 999_999n } as unknown as CreditAdjustment[];
    // A caller that passes a balance-shaped object instead of a ledger gets a
    // refusal, not a balance of 999_999.
    expectRefusal(() => foldCreditBalance(forged, SCOPE), 'billing.payload_invalid');
  });

  it('REFUSES a consumption beyond what it can draw, naming the adjustment that overdrew it', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), consume('a2', 1_001n, '2026-04-11T00:00:00.000Z', 'a1')], SCOPE),
      'billing.credit_grant_overdrawn',
    );
    // Not "the balance went negative" — which adjustment, by ordinal.
    expect(e.toSafeJSON()).toEqual({ code: 'billing.credit_grant_overdrawn', attemptNo: 2, currency: 'ILS' });
    // And no amount reached the refusal.
    expect(JSON.stringify(e.toSafeJSON())).not.toMatch(/1000|1001|1_00/);
  });

  it('allows a consumption of exactly the balance', () => {
    const b = foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), consume('a2', 1_000n, '2026-04-11T00:00:00.000Z', 'a1')], SCOPE);
    expect(b.balanceMinor).toBe(0n);
  });

  it('checks a draw-down against the grant it names, not against the totals', () => {
    // Totals-only arithmetic would accept this: granted 1_000 + 1_000 is more
    // than consumed 1_500, so the end balance is positive. But at adjustment
    // 2 the only grant that existed held 1_000 and 1_500 was drawn from it,
    // which never happened.
    expectRefusal(
      () =>
        foldCreditBalance(
          [
            grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'),
            consume('a2', 1_500n, '2026-04-11T00:00:00.000Z', 'a1'),
            grant('a3', 1_000n, '2026-04-12T00:00:00.000Z'),
          ],
          SCOPE,
        ),
      'billing.credit_grant_overdrawn',
    );
  });

  it('is STRICTLY STRONGER than a balance-level check: enough credit in total, one grant over-drawn', () => {
    // 1_000 + 1_000 granted, 1_200 drawn, so the BALANCE is 800 and positive
    // at every step — a balance-level overdraw check sees nothing wrong. Only
    // the per-grant check sees that `a1` was drawn 200 past its own amount.
    // This is why `TL-P5-R5`'s allocation order is auditable at all.
    expectRefusal(
      () =>
        foldCreditBalance(
          [
            grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'),
            grant('a2', 1_000n, '2026-04-11T00:00:00.000Z'),
            consume('a3', 1_200n, '2026-04-12T00:00:00.000Z', 'a1'),
          ],
          SCOPE,
        ),
      'billing.credit_grant_overdrawn',
    );
  });

  it('reports a remainder per grant, summing to the balance', () => {
    const b = foldCreditBalance(
      [
        grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'),
        grant('a2', 2_500n, '2026-04-11T00:00:00.000Z'),
        consume('a3', 1_000n, '2026-04-12T00:00:00.000Z', 'a1'),
        consume('a4', 500n, '2026-04-13T00:00:00.000Z', 'a2'),
      ],
      SCOPE,
    );
    expect(b.grants).toEqual([
      { grantId: 'a1', occurredAt: '2026-04-10T00:00:00.000Z', grantedMinor: 1_000n, remainingMinor: 0n },
      { grantId: 'a2', occurredAt: '2026-04-11T00:00:00.000Z', grantedMinor: 2_500n, remainingMinor: 2_000n },
    ]);
    // An exhausted grant is REPORTED, not filtered out: "this grant is spent"
    // is a fact the allocator reads, not an absence it has to infer.
    expect(b.grants.reduce((t, g) => t + g.remainingMinor, 0n)).toBe(b.balanceMinor);
    expect(b.balanceMinor).toBe(2_000n);
  });

  it('REFUSES a ledger that mixes two businesses, however well-ordered', () => {
    // The hole `TL-P5-R5` closed. Before `businessId` existed, two ledgers
    // interleaved in correct time order folded to one plausible balance, and
    // this module's own comment claimed the order check would catch it.
    expectRefusal(
      () =>
        foldCreditBalance(
          [grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), { ...grant('a2', 1_000n, '2026-04-11T00:00:00.000Z'), businessId: 'biz-2' }],
          SCOPE,
        ),
      'billing.credit_business_mismatch',
    );
  });

  it('REFUSES a consumption that names no grant, an unknown grant, or a later one', () => {
    const g = grant('a1', 1_000n, '2026-04-11T00:00:00.000Z');
    const c = consume('a2', 100n, '2026-04-12T00:00:00.000Z', 'a1');
    expectRefusal(() => foldCreditBalance([g, { ...c, appliesToGrantId: undefined }], SCOPE), 'billing.payload_invalid');
    expectRefusal(() => foldCreditBalance([g, { ...c, appliesToGrantId: 'nope' }], SCOPE), 'billing.credit_grant_unknown');
    // A forward reference: the consumption precedes the grant it names.
    expectRefusal(() => foldCreditBalance([{ ...c, occurredAt: '2026-04-10T00:00:00.000Z' }, g], SCOPE), 'billing.credit_grant_unknown');
  });

  it('REFUSES a grant that claims to draw down another grant', () => {
    expectRefusal(() => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), appliesToGrantId: 'a0' }], SCOPE), 'billing.payload_invalid');
  });

  it('REFUSES an out-of-order ledger rather than sorting it', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-12T00:00:00.000Z'), grant('a2', 500n, '2026-04-10T00:00:00.000Z')], SCOPE),
      'billing.credit_ledger_out_of_order',
    );
    expect(e.context.attemptNo).toBe(2);
    expect(e.context.at).toBe('2026-04-10T00:00:00.000Z');
  });

  it('accepts two adjustments at the same instant', () => {
    // Equal instants are not disorder: two adjustments can be written in one
    // transaction, and refusing that would make the ledger unwritable.
    const b = foldCreditBalance([grant('a1', 10n, '2026-04-10T00:00:00.000Z'), grant('a2', 10n, '2026-04-10T00:00:00.000Z')], SCOPE);
    expect(b.balanceMinor).toBe(20n);
  });

  it('REFUSES a replayed adjustment id', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), grant('a1', 1_000n, '2026-04-11T00:00:00.000Z')], SCOPE),
      'billing.credit_adjustment_replayed',
    );
    expect(e.context.attemptNo).toBe(2);
  });

  it('REFUSES an adjustment with no stated reason', () => {
    expectRefusal(() => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), reason: '  ' }], SCOPE), 'billing.credit_reason_required');
  });

  it('REFUSES a mixed-currency ledger', () => {
    expectRefusal(
      () => foldCreditBalance([grant('a1', 10n, '2026-04-10T00:00:00.000Z'), { ...grant('a2', 10n, '2026-04-11T00:00:00.000Z'), currency: 'USD' }], SCOPE),
      'billing.credit_currency_mismatch',
    );
  });

  it('REFUSES a negative or zero amount — the kind carries the direction', () => {
    expectRefusal(() => foldCreditBalance([grant('a1', -10n, '2026-04-10T00:00:00.000Z')], SCOPE), 'billing.payload_invalid');
    expectRefusal(() => foldCreditBalance([grant('a1', 0n, '2026-04-10T00:00:00.000Z')], SCOPE), 'billing.payload_invalid');
  });

  it('REFUSES a float amount, an unparseable instant, an unknown kind and a missing identity', () => {
    expectRefusal(
      () => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), amountMinor: 10 as unknown as bigint }], SCOPE),
      'billing.payload_invalid',
    );
    expectRefusal(() => foldCreditBalance([grant('a1', 10n, 'last Tuesday')], SCOPE), 'billing.as_of_required');
    expectRefusal(
      () => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), kind: 'reversal' as unknown as 'grant' }], SCOPE),
      'billing.payload_invalid',
    );
    expectRefusal(() => foldCreditBalance([{ ...grant('  ', 10n, '2026-04-10T00:00:00.000Z') }], SCOPE), 'billing.payload_invalid');
  });

  it('REFUSES a balance stated in something that is not a currency code', () => {
    expectRefusal(() => foldCreditBalance([], { businessId: 'biz-1', currency: 'shekel' }), 'billing.payload_invalid');
  });

  it('REFUSES an amount above the money cap', () => {
    expectRefusal(() => foldCreditBalance([grant('a1', 10n ** 18n + 1n, '2026-04-10T00:00:00.000Z')], SCOPE), 'billing.payload_invalid');
  });

  it('declares exactly two kinds', () => {
    // A third kind would be a direction nobody ruled on. `reversal`,
    // `expiry` and `write_off` are all real and all absent.
    expect(CREDIT_ADJUSTMENT_KINDS).toEqual(['grant', 'consumption']);
  });
});

describe('TL-P5-R3 — no path from a credit to cash exists in this module', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'src', 'credit.ts'), 'utf8');
  const CODE = blankOut(SOURCE);

  it('mentions the ruling in prose (so the scan below has something to distinguish)', () => {
    // Non-vacuity, and the reason the blanker is here: the forbidden words DO
    // occur in this file — in its documentation of the ruling. A raw-text law
    // would red on the explanation instead of on a defect.
    expect(SOURCE.toLowerCase()).toContain('refund');
    expect(SOURCE.toLowerCase()).toContain('payout');
  });

  it('contains no refund or payout symbol in CODE', () => {
    expect(CODE.toLowerCase()).not.toContain('refund');
    expect(CODE.toLowerCase()).not.toContain('payout');
    expect(CODE.toLowerCase()).not.toContain('disburse');
  });

  it('imports nothing that could move money', () => {
    // A provider port in this module would be the second half of the cash
    // refund arriving quietly. The ruling makes that a separate command.
    expect(CODE).not.toContain('./ports');
    expect(CODE).not.toContain('./fake-provider');
  });
});
