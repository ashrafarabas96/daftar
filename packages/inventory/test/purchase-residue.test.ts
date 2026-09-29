/**
 * Phase 3 corrective — TD-16 (0072): the pure half of the sub-unit residue
 * rule. `supplierReturnLeavesSubUnitResidue` is the TS twin of the COMMIT
 * guard `supplier_return_residue_bound`; `planResidueWriteOff` binds the
 * write-off exactly as `purchase_write_off_residue` re-derives it; the
 * payload is the routine's own argument list.
 */
import { describe, expect, it } from 'vitest';
import {
  convertToBase,
  InventoryError,
  INVENTORY_PAYLOAD_SCHEMAS,
  inventoryIntentSchema,
  planResidueWriteOff,
  purchaseResidueWriteOffIntentSha256,
  purchaseResidueWriteOffPayload,
  supplierReturnLeavesSubUnitResidue,
} from '../src';

/** TRY at 0.11 into ILS: both currencies of 2 minor units. */
const R11 = 1_100_000_000n;
const conv = (x: bigint): bigint => convertToBase(x, R11, 2, 2);
const state = (t: bigint, b: bigint, o: bigint) => ({
  totalTxnMinor: t,
  totalBaseMinor: b,
  outstandingTxnMinor: o,
  rateR10: R11,
  txnExponent: 2,
  baseExponent: 2,
});

const T0 = '11111111-1111-4111-8111-111111111111';
const B0 = '22222222-2222-4222-8222-222222222222';
const P0 = '33333333-3333-4333-8333-333333333333';

describe('supplierReturnLeavesSubUnitResidue (R-95)', () => {
  it('the 0.11 reproduction: returning 49.99 of 50.00 leaves 0.01 (conv 0) — refused; the lawful alternatives are not', () => {
    expect(conv(1n)).toBe(0n);
    expect(supplierReturnLeavesSubUnitResidue(5000n, 4999n, conv)).toBe(true);
    expect(supplierReturnLeavesSubUnitResidue(5000n, 5000n, conv), 'O′ = 0').toBe(false);
    expect(supplierReturnLeavesSubUnitResidue(5000n, 4995n, conv), 'O′ = 0.05 converts to 1').toBe(false);
    expect(supplierReturnLeavesSubUnitResidue(5000n, 4996n, conv), 'O′ = 0.04 converts to 0').toBe(true);
    expect(supplierReturnLeavesSubUnitResidue(5000n, 0n, conv), 'no AP released (all credit)').toBe(false);
  });

  it('refuses an AP release outside 0..O', () => {
    expect(() => supplierReturnLeavesSubUnitResidue(10n, 11n, conv)).toThrow(InventoryError);
    expect(() => supplierReturnLeavesSubUnitResidue(10n, -1n, conv)).toThrow(InventoryError);
  });
});

describe('planResidueWriteOff (R-96)', () => {
  it('O = 0 is nothing_outstanding; O converting to ≥ 1 is not_below_base_unit (boundary 0.05 / 0.04)', () => {
    expect(planResidueWriteOff(state(5000n, 550n, 0n))).toEqual({ verdict: 'nothing_outstanding' });
    expect(planResidueWriteOff(state(5000n, 550n, 5n))).toEqual({ verdict: 'not_below_base_unit' });
    expect(planResidueWriteOff(state(5000n, 550n, 5000n))).toEqual({ verdict: 'not_below_base_unit' });
    expect(planResidueWriteOff(state(5000n, 550n, 4n)).verdict).toBe('write_off');
  });

  it('the 0.11 reproduction: O = 1 kurus, X = 4999, rb = 0 — nothing to post', () => {
    expect(planResidueWriteOff(state(5000n, 550n, 1n))).toEqual({
      verdict: 'write_off',
      residueTxnMinor: 1n,
      releasedBeforeTxnMinor: 4999n,
      residueBaseMinor: 0n,
      entryLines: [],
    });
  });

  it('rb = 1 is reachable: T = 14 kurus (B 2), 10 released, O = 4 — Dr AP 1 / Cr FX gain 1, base lines on the purchase', () => {
    expect(conv(14n)).toBe(2n);
    expect(planResidueWriteOff(state(14n, 2n, 4n))).toEqual({
      verdict: 'write_off',
      residueTxnMinor: 4n,
      releasedBeforeTxnMinor: 10n,
      residueBaseMinor: 1n,
      entryLines: [
        { account: 'accounts_payable', side: 'D', currency: 'base', txnAmountMinor: 1n, baseAmountMinor: 1n, dimension: 'purchase' },
        { account: 'fx_gain', side: 'C', currency: 'base', txnAmountMinor: 1n, baseAmountMinor: 1n, dimension: 'purchase' },
      ],
    });
  });

  it('whenever conv(O) = 0 the remaining base is 0 or 1 (exhaustive over small purchases at 0.11)', () => {
    for (let t = 1n; t <= 300n; t++) {
      const b = conv(t);
      for (let o = 1n; o <= t; o++) {
        const p = planResidueWriteOff(state(t, b, o));
        if (p.verdict !== 'write_off') continue;
        expect(p.residueBaseMinor >= 0n && p.residueBaseMinor <= 1n, `T ${t} O ${o}`).toBe(true);
      }
    }
  });

  it('refuses an outstanding outside 0..T', () => {
    expect(() => planResidueWriteOff(state(10n, 1n, 11n))).toThrow(InventoryError);
    expect(() => planResidueWriteOff(state(10n, 1n, -1n))).toThrow(InventoryError);
  });
});

describe('the purchase.write_off_residue payload', () => {
  const input = { tenantId: T0, businessId: B0, purchaseId: P0, writeOffDate: '2026-09-01', reason: 'Sub-unit residue', residueTxnMinor: 1n };

  it('is the routine’s argument list: purchase, date, 8 reason words, residue, released_before, residue_base; the intent drops the derived two', () => {
    expect(INVENTORY_PAYLOAD_SCHEMAS['purchase.write_off_residue'].map((f) => [f.name, f.type, f.nullable])).toEqual([
      ['purchase_id', 'uuid', false],
      ['write_off_date', 'integer', false],
      ...Array.from({ length: 8 }, (_, i) => [`reason_w${i + 1}`, 'integer', false]),
      ['residue', 'integer', false],
      ['released_before', 'integer', false],
      ['residue_base', 'integer', false],
    ]);
    expect(inventoryIntentSchema('purchase.write_off_residue').map((f) => f.name)).toEqual([
      'purchase_id',
      'write_off_date',
      ...Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`),
      'residue',
    ]);
    const built = purchaseResidueWriteOffPayload({ ...input, releasedBeforeTxnMinor: 4999n, residueBaseMinor: 0n });
    expect(built.payload.opCode).toBe('purchase.write_off_residue');
    expect(built.intentSha256).toBe(purchaseResidueWriteOffIntentSha256(input));
    expect(
      purchaseResidueWriteOffPayload({ ...input, releasedBeforeTxnMinor: 4999n, residueBaseMinor: 1n }).intentSha256,
      'derived fields stay out of the intent',
    ).toBe(built.intentSha256);
    expect(purchaseResidueWriteOffIntentSha256({ ...input, reason: 'Another reason' })).not.toBe(built.intentSha256);
  });

  it('refuses a missing or blank reason, a non-positive residue or chain point, and a negative base', () => {
    const codeOf = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        if (e instanceof InventoryError) return e.code;
        throw e;
      }
      return 'accepted';
    };
    const full = { ...input, releasedBeforeTxnMinor: 4999n, residueBaseMinor: 0n };
    expect(codeOf(() => purchaseResidueWriteOffIntentSha256({ ...input, reason: null }))).toBe('inventory.reason_required');
    expect(codeOf(() => purchaseResidueWriteOffIntentSha256({ ...input, reason: ' ' }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseResidueWriteOffIntentSha256({ ...input, residueTxnMinor: 0n }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseResidueWriteOffPayload({ ...full, releasedBeforeTxnMinor: 0n }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseResidueWriteOffPayload({ ...full, residueBaseMinor: -1n }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => purchaseResidueWriteOffPayload(full))).toBe('accepted');
  });
});
