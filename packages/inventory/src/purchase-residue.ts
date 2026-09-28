/**
 * Phase 3 corrective — TD-16 (migration 0072): a purchase's sub-unit AP
 * residue.
 *
 * A frozen P3-S5 partial return released `ap = least(C, O)` and could leave
 * `0 < O` whose conversion at the purchase's snapshot is 0 base minor units
 * (TRY at 0.11 into ILS: lines 49.99 + 0.01, the 49.99 returned, O = 1
 * kurus). No settlement can clear such an O. Two halves:
 *
 * - PREVENTION (R-95): `supplierReturnLeavesSubUnitResidue` — a return with
 *   `ap > 0` must leave `O − ap` either 0 or converting to at least one base
 *   minor unit. The twin of 0072's COMMIT guard `supplier_return_residue_bound`;
 *   the return service refuses the same case before minting.
 * - CLOSURE (R-96): `planResidueWriteOff` binds the write-off of an existing
 *   residue — lawful only when `0 < O` and `convertToBase(O) = 0` — with the
 *   chain point `X = T − O` it closes and the base the ledger still carries,
 *   `rb = apRelease(B, T, X, O)` (0 or 1). When `rb > 0` the release is one
 *   base-only entry, Dr Accounts Payable rb / Cr FX gain rb (the S6
 *   "the last consumption releases the entire residue" dust rule); when
 *   `rb = 0` nothing is posted. `purchaseResidueWriteOffPayload` is the
 *   `invpl/1` payload of `purchase.write_off_residue`, field for field the
 *   routine's own arguments.
 *
 * Exact integer arithmetic only; nothing here reads a clock, a rate or the
 * database.
 */
import { InventoryError } from './errors';
import { yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { REASON_MAX_CHARS } from './reason-digest';
import { documentTextWords } from './supplier-payloads';
import { apRelease, convertToBase, type SettlementEntryLine } from './supplier-settlement';

const OP = 'purchase.write_off_residue';

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });

// ── Prevention (R-95) ────────────────────────────────────────────────────

/**
 * True iff a return releasing `apTxnMinor` of a purchase whose outstanding AP
 * is `outstandingTxnMinor` would leave it a positive remainder converting to
 * 0 base minor units — `supplier_return.residue_below_base_unit`. A return
 * that releases no AP (the purchase already settled: all credit) cannot
 * create one.
 */
export function supplierReturnLeavesSubUnitResidue(outstandingTxnMinor: bigint, apTxnMinor: bigint, convert: (txnMinor: bigint) => bigint): boolean {
  if (typeof outstandingTxnMinor !== 'bigint' || typeof apTxnMinor !== 'bigint' || apTxnMinor < 0n || apTxnMinor > outstandingTxnMinor) {
    throw new InventoryError('inventory.arithmetic_invalid', 'a return releases between 0 and the outstanding AP');
  }
  if (apTxnMinor === 0n) return false;
  const left = outstandingTxnMinor - apTxnMinor;
  return left > 0n && convert(left) === 0n;
}

// ── Closure (R-96) ───────────────────────────────────────────────────────

/** A received purchase's AP state and stored snapshot, as the write-off binds it. */
export interface ResidueWriteOffState {
  /** `T`, ≥ 1. */
  readonly totalTxnMinor: bigint;
  /** `B`, ≥ 0. */
  readonly totalBaseMinor: bigint;
  /** `O = purchase_ap_outstanding`, 0..T. */
  readonly outstandingTxnMinor: bigint;
  /** The purchase's snapshot rate as R10. */
  readonly rateR10: bigint;
  readonly txnExponent: number;
  readonly baseExponent: number;
}

/** The bound write-off: the residue, the chain point it closes, the base it releases, and the entry lines (none when that base is 0). */
export interface ResidueWriteOffBound {
  readonly verdict: 'write_off';
  readonly residueTxnMinor: bigint;
  readonly releasedBeforeTxnMinor: bigint;
  readonly residueBaseMinor: bigint;
  readonly entryLines: readonly SettlementEntryLine[];
}

/**
 * The write-off's verdict, in the routine's order: `nothing_outstanding`
 * (O = 0), `not_below_base_unit` (O converts to at least one base minor unit:
 * it can be paid or allocated), else the bound write-off. A verdict, not a
 * throw: the codes are the routine's `purchase_residue.*`, which the service
 * raises from it.
 */
export type ResidueWriteOffPlan = { readonly verdict: 'nothing_outstanding' } | { readonly verdict: 'not_below_base_unit' } | ResidueWriteOffBound;

export function planResidueWriteOff(s: ResidueWriteOffState): ResidueWriteOffPlan {
  const { totalTxnMinor: t, totalBaseMinor: b, outstandingTxnMinor: o } = s;
  if (typeof o !== 'bigint' || typeof t !== 'bigint' || o < 0n || o > t) {
    throw new InventoryError('inventory.arithmetic_invalid', 'an outstanding AP is between 0 and the purchase total');
  }
  if (o === 0n) return { verdict: 'nothing_outstanding' };
  if (convertToBase(o, s.rateR10, s.txnExponent, s.baseExponent) !== 0n) return { verdict: 'not_below_base_unit' };
  const x = t - o;
  const rb = apRelease(b, t, x, o);
  const entryLines: SettlementEntryLine[] =
    rb === 0n
      ? []
      : [
          { account: 'accounts_payable', side: 'D', currency: 'base', txnAmountMinor: rb, baseAmountMinor: rb, dimension: 'purchase' },
          { account: 'fx_gain', side: 'C', currency: 'base', txnAmountMinor: rb, baseAmountMinor: rb, dimension: 'purchase' },
        ];
  return { verdict: 'write_off', residueTxnMinor: o, releasedBeforeTxnMinor: x, residueBaseMinor: rb, entryLines: Object.freeze(entryLines) };
}

// ── The invpl/1 payload of purchase.write_off_residue ─────────────────────

/** A write-off's reason: REQUIRED, trimmed, 1..500 characters; NULL is `inventory.reason_required`. */
export function purchaseResidueReasonWords(reason: string | null): InventoryPayloadField[] {
  if (reason === null) throw new InventoryError('inventory.reason_required', 'a residue write-off must state a reason');
  return documentTextWords(reason, 'reason', { min: 1, max: REASON_MAX_CHARS }).map((w): InventoryPayloadField => (w === null ? { kind: 'null' } : int(w)));
}

export interface PurchaseResidueWriteOffIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  /** `YYYY-MM-DD`, bound by the client. */
  readonly writeOffDate: string;
  /** Required: NULL is `inventory.reason_required` (the type admits it so a caller's absent reason is refused here, typed). */
  readonly reason: string | null;
  /** The residue the client states: exactly the purchase's outstanding O. */
  readonly residueTxnMinor: bigint;
}

function intentFields(input: PurchaseResidueWriteOffIntentInput): InventoryPayloadField[] {
  if (typeof input.residueTxnMinor !== 'bigint' || input.residueTxnMinor <= 0n) refuse('residue must be a positive integer');
  return [uuid(input.purchaseId, 'purchase_id'), int(yyyymmdd(input.writeOffDate)), ...purchaseResidueReasonWords(input.reason), int(input.residueTxnMinor)];
}

/** The write-off's intent digest: the value `purchase_residue_write_offs.intent_sha256` stores. */
export function purchaseResidueWriteOffIntentSha256(input: PurchaseResidueWriteOffIntentInput): string {
  return inventoryIntentSha256(OP, input.tenantId, input.businessId, intentFields(input));
}

export interface PurchaseResidueWriteOffPayloadInput extends PurchaseResidueWriteOffIntentInput {
  /** `X = T − O`, ≥ 1 (a return released part of the AP). */
  readonly releasedBeforeTxnMinor: bigint;
  /** `rb = apRelease(B, T, X, O)`, ≥ 0. */
  readonly residueBaseMinor: bigint;
}

/** `purchase.write_off_residue`: purchase_id, write_off_date, reason_w1..w8, residue, released_before, residue_base. */
export function purchaseResidueWriteOffPayload(input: PurchaseResidueWriteOffPayloadInput): MovementPayload {
  if (typeof input.releasedBeforeTxnMinor !== 'bigint' || input.releasedBeforeTxnMinor <= 0n) refuse('released_before must be a positive integer');
  if (typeof input.residueBaseMinor !== 'bigint' || input.residueBaseMinor < 0n) refuse('residue_base must be a non-negative integer');
  const fields = [...intentFields(input), int(input.releasedBeforeTxnMinor), int(input.residueBaseMinor)];
  return { payload: buildInventoryPayload(OP, input.tenantId, input.businessId, fields), intentSha256: purchaseResidueWriteOffIntentSha256(input) };
}
