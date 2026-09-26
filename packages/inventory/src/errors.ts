/**
 * Typed inventory errors raised by this package — stable machine codes, never
 * a key, an assertion, a secret or the canonical byte stream.
 *
 * This package only MINTS and CANONICALIZES. Every refusal here means the
 * application tried to sign something the database would refuse, so it is a
 * defect caught before a connection is taken, never a verification verdict:
 * verification is the database's, and only the database's (P3-AL-55 §G).
 *
 * - `inventory.assertion_malformed` is the database's own code for a
 *   structurally impossible `invctl/1` assertion (§G step 2). The minter uses
 *   it for the same shape errors, so one vocabulary spans both layers.
 * - `inventory.payload_invalid` is package-local: the `invpl/1` canonicalizer
 *   refuses non-canonical input BEFORE hashing (§F) rather than normalizing
 *   it. The database never sees such a payload, because the application's
 *   payload validation runs before the minter (§I).
 *
 * P3-S2 adds the fixed-point and valuation codes (PHASE_3_S2_CONTRACT §4).
 * Where the database primitive raises a code for the same condition (for
 * example `inventory.insufficient_stock`), the package uses that code, so a
 * simulation and the stored ledger refuse in one vocabulary. These refusals
 * are pure arithmetic verdicts and never carry a quantity, cost or value.
 */
export type InventoryErrorCode =
  | 'inventory.assertion_malformed'
  | 'inventory.payload_invalid'
  | 'inventory.quantity_invalid'
  | 'inventory.cost_invalid'
  | 'inventory.unit_decimals_invalid'
  | 'inventory.quantity_precision_invalid'
  | 'inventory.insufficient_stock'
  | 'inventory.arithmetic_invalid'
  | 'inventory.value_out_of_range'
  | 'inventory.quantity_out_of_range'
  | 'inventory.movement_shape_invalid'
  | 'inventory.transfer_pair_mismatch'
  | 'inventory.rebuild_sequence_invalid';

export class InventoryError extends Error {
  readonly code: InventoryErrorCode;

  constructor(code: InventoryErrorCode, message: string) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }

  /** The only representation that should ever be logged or returned. */
  toSafeJSON(): { code: InventoryErrorCode } {
    return { code: this.code };
  }
}
