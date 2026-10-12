/**
 * The catalogue's unit-precision law, as the frozen schema states it — Phase 6
 * (`PREPARED / NOT PROMOTED`).
 *
 * This module exists because of the round-6 challenge. The package demanded an
 * integer precision for every basket position, and the frozen catalogue does
 * not promise one: `0053_inventory_units_and_product_configuration.sql` makes
 * `products.unit_decimals` NULLABLE and requires it only of a product that
 * tracks inventory —
 *
 *     products_tracked_requires_unit_ck
 *       CHECK (track_inventory = false OR (unit_code IS NOT NULL AND unit_decimals IS NOT NULL))
 *     products_unit_decimals_ck
 *       CHECK (unit_decimals IS NULL OR (unit_decimals >= 0 AND unit_decimals <= 4))
 *
 * — so a service, a delivery fee or a digital good legitimately carries NO
 * precision, and a package that refuses absence cannot sell one at all. That is
 * the SALE PATH being wrong about the catalogue, not the catalogue being wrong:
 * the shape is frozen, it is coherent, and inventing a precision for a product
 * the merchant declared precision-free would be this package writing catalogue
 * policy.
 *
 * So the law here is the frozen CHECK's own two halves and nothing more:
 *
 * - a product that TRACKS inventory must declare a precision, and it must be an
 *   integer in `0..4` — the mirror of both CHECKs;
 * - a product that does not track inventory MAY declare one, and then it is
 *   enforced exactly as a tracked product's is, so a merchant who declares `0`
 *   for a service gets whole units;
 * - a product that does not track inventory and declares NO precision is
 *   admitted, and the only bound its quantity then has is the one the STORAGE
 *   carries: `NUMERIC(18,4)`, which `@daftar/inventory`'s parse already applies.
 *   No narrower bound is invented here.
 *
 * Whether a precision-free line should be bounded more tightly than the storage
 * scale — whole units for a service, say — is a merchant policy question and it
 * is the owner's: **OD-P6-08**. The default shipped here refuses nothing the
 * frozen catalogue admits, which is the conservative direction for a default,
 * and the question is raised rather than answered by refusing.
 */
import { OrderError } from './errors';

/**
 * The inventory authority's own bound on a product's frozen `unit_decimals`
 * (`packages/inventory/src/quantity.ts`, `Q4_STEP` for d = 0..4). It is mirrored
 * here so a malformed PRECISION is refused under its own code instead of being
 * relabelled as a malformed quantity.
 */
export const MAX_UNIT_DECIMALS = 4;

/**
 * What the catalogue declares about one stock key, as DATA.
 *
 * Both halves are required, because the law is the relationship BETWEEN them: a
 * null precision is lawful or not according to `tracksInventory`, so a caller
 * that supplied only the precision would be supplying half a premise. They are
 * carried together for the same reason the position carries the precision it was
 * checked against — a figure a hand-off has to be given twice is a figure it can
 * be given differently.
 */
export interface UnitPrecisionDeclaration {
  /** `products.track_inventory` for this stock key. */
  tracksInventory: boolean;
  /** `products.unit_decimals`, or `null` where the catalogue declares none. */
  unitDecimals: number | null;
}

/**
 * Check one declaration and return the precision a quantity must be
 * representable at, or `null` when the catalogue declares none.
 *
 * Every check is at RUNTIME. A type-only requirement has no runtime existence,
 * and this one decides whether a law is claimed at all: a declaration whose
 * `unitDecimals` is `undefined` rather than `null` would otherwise read as
 * "no precision" from a product that tracks inventory and must have one.
 */
export function requireUnitPrecision(declaration: UnitPrecisionDeclaration, detail: Readonly<Record<string, string>>): number | null {
  if (typeof declaration.tracksInventory !== 'boolean') {
    throw new OrderError('order.unit_precision_invalid', 'a unit precision declaration states whether the product tracks inventory, as a boolean', {
      ...detail,
      stated: String(declaration.tracksInventory),
    });
  }
  if (declaration.unitDecimals === null) {
    // The frozen CHECK's first half, in the package's vocabulary. A tracked
    // product with no precision is a contradiction the catalogue itself
    // refuses, so it is refused here under its own code rather than being
    // admitted and bounded by the storage scale.
    if (declaration.tracksInventory) {
      throw new OrderError('order.unit_precision_required', 'a product that tracks inventory declares a unit precision; the catalogue requires it', detail);
    }
    return null;
  }
  if (!Number.isInteger(declaration.unitDecimals) || declaration.unitDecimals < 0 || declaration.unitDecimals > MAX_UNIT_DECIMALS) {
    throw new OrderError('order.unit_precision_invalid', 'a stated unit precision is an integer from 0 to 4', {
      ...detail,
      stated: String(declaration.unitDecimals),
    });
  }
  return declaration.unitDecimals;
}
