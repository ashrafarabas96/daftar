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
import { foldCreditBalance, CREDIT_ADJUSTMENT_KINDS, type CreditAdjustment } from '../src/credit';
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

function grant(id: string, amountMinor: bigint, occurredAt: string): CreditAdjustment {
  return { id, kind: 'grant', amountMinor, currency: 'ILS', occurredAt, ref: 'plan-change-1', reason: 'downgrade proration' };
}
function consume(id: string, amountMinor: bigint, occurredAt: string): CreditAdjustment {
  return { id, kind: 'consumption', amountMinor, currency: 'ILS', occurredAt, ref: 'invoice-7', reason: 'applied to invoice' };
}

describe('foldCreditBalance', () => {
  it('folds an empty ledger to a zero balance rather than refusing', () => {
    // A business with no credit history has a balance of zero. Refusing here
    // would make every caller special-case the common state.
    expect(foldCreditBalance([], 'ILS')).toEqual({
      currency: 'ILS',
      grantedMinor: 0n,
      consumedMinor: 0n,
      balanceMinor: 0n,
      adjustmentCount: 0,
    });
  });

  it('is granted minus consumed, exactly', () => {
    const b = foldCreditBalance(
      [grant('a1', 4_000n, '2026-04-10T00:00:00.000Z'), grant('a2', 1_500n, '2026-04-12T00:00:00.000Z'), consume('a3', 2_200n, '2026-05-01T00:00:00.000Z')],
      'ILS',
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
    expectRefusal(() => foldCreditBalance(forged, 'ILS'), 'billing.payload_invalid');
  });

  it('REFUSES a consumption beyond the balance, naming the adjustment that overdrew it', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), consume('a2', 1_001n, '2026-04-11T00:00:00.000Z')], 'ILS'),
      'billing.credit_overdrawn',
    );
    // Not "the balance went negative" — which adjustment, by ordinal.
    expect(e.toSafeJSON()).toEqual({ code: 'billing.credit_overdrawn', attemptNo: 2, currency: 'ILS' });
    // And no amount reached the refusal.
    expect(JSON.stringify(e.toSafeJSON())).not.toMatch(/1000|1001|1_00/);
  });

  it('allows a consumption of exactly the balance', () => {
    const b = foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), consume('a2', 1_000n, '2026-04-11T00:00:00.000Z')], 'ILS');
    expect(b.balanceMinor).toBe(0n);
  });

  it('checks the overdraw against the RUNNING balance, not against the totals', () => {
    // Totals-only arithmetic would accept this: granted 1_000 + 1_000 is more
    // than consumed 1_500, so the end balance is positive. But at adjustment
    // 2 the ledger held 1_000 and 1_500 was spent, which never happened.
    expectRefusal(
      () =>
        foldCreditBalance(
          [grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), consume('a2', 1_500n, '2026-04-11T00:00:00.000Z'), grant('a3', 1_000n, '2026-04-12T00:00:00.000Z')],
          'ILS',
        ),
      'billing.credit_overdrawn',
    );
  });

  it('REFUSES an out-of-order ledger rather than sorting it', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-12T00:00:00.000Z'), grant('a2', 500n, '2026-04-10T00:00:00.000Z')], 'ILS'),
      'billing.credit_ledger_out_of_order',
    );
    expect(e.context.attemptNo).toBe(2);
    expect(e.context.at).toBe('2026-04-10T00:00:00.000Z');
  });

  it('accepts two adjustments at the same instant', () => {
    // Equal instants are not disorder: two adjustments can be written in one
    // transaction, and refusing that would make the ledger unwritable.
    const b = foldCreditBalance([grant('a1', 10n, '2026-04-10T00:00:00.000Z'), grant('a2', 10n, '2026-04-10T00:00:00.000Z')], 'ILS');
    expect(b.balanceMinor).toBe(20n);
  });

  it('REFUSES a replayed adjustment id', () => {
    const e = expectRefusal(
      () => foldCreditBalance([grant('a1', 1_000n, '2026-04-10T00:00:00.000Z'), grant('a1', 1_000n, '2026-04-11T00:00:00.000Z')], 'ILS'),
      'billing.credit_adjustment_replayed',
    );
    expect(e.context.attemptNo).toBe(2);
  });

  it('REFUSES an adjustment with no stated reason', () => {
    expectRefusal(() => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), reason: '  ' }], 'ILS'), 'billing.credit_reason_required');
  });

  it('REFUSES a mixed-currency ledger', () => {
    expectRefusal(
      () => foldCreditBalance([grant('a1', 10n, '2026-04-10T00:00:00.000Z'), { ...grant('a2', 10n, '2026-04-11T00:00:00.000Z'), currency: 'USD' }], 'ILS'),
      'billing.credit_currency_mismatch',
    );
  });

  it('REFUSES a negative or zero amount — the kind carries the direction', () => {
    expectRefusal(() => foldCreditBalance([grant('a1', -10n, '2026-04-10T00:00:00.000Z')], 'ILS'), 'billing.payload_invalid');
    expectRefusal(() => foldCreditBalance([grant('a1', 0n, '2026-04-10T00:00:00.000Z')], 'ILS'), 'billing.payload_invalid');
  });

  it('REFUSES a float amount, an unparseable instant, an unknown kind and a missing identity', () => {
    expectRefusal(
      () => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), amountMinor: 10 as unknown as bigint }], 'ILS'),
      'billing.payload_invalid',
    );
    expectRefusal(() => foldCreditBalance([grant('a1', 10n, 'last Tuesday')], 'ILS'), 'billing.as_of_required');
    expectRefusal(
      () => foldCreditBalance([{ ...grant('a1', 10n, '2026-04-10T00:00:00.000Z'), kind: 'reversal' as unknown as 'grant' }], 'ILS'),
      'billing.payload_invalid',
    );
    expectRefusal(() => foldCreditBalance([{ ...grant('  ', 10n, '2026-04-10T00:00:00.000Z') }], 'ILS'), 'billing.payload_invalid');
  });

  it('REFUSES a balance stated in something that is not a currency code', () => {
    expectRefusal(() => foldCreditBalance([], 'shekel'), 'billing.payload_invalid');
  });

  it('REFUSES an amount above the money cap', () => {
    expectRefusal(() => foldCreditBalance([grant('a1', 10n ** 18n + 1n, '2026-04-10T00:00:00.000Z')], 'ILS'), 'billing.payload_invalid');
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
