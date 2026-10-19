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
import { CarrierFault, assertNotProxyCarrier, snapshotFields } from './carrier';
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
/** The two fields a declaration states, as a LIST, so an undeclared one is refused rather than ignored. */
const DECLARATION_FIELDS: readonly string[] = Object.freeze(['tracksInventory', 'unitDecimals']);

/**
 * The intrinsic lookup, captured at module load, before any caller exists.
 *
 * `D-A`: `declarations instanceof Map` asks about the PROTOTYPE, not about which
 * `get` runs, and the independent challenger measured three shapes that are
 * `instanceof Map` and answer `undefined` for a key the honest map holds — a Map
 * with an own `get`, a `Map` subclass overriding `get`, and a Proxy over a real
 * Map (`instanceof` goes through the `getPrototypeOf` trap). All three accepted
 * `5.5000` on a product the catalogue declares in WHOLE units, at the digest a
 * quote with NO `checks` produces: the C-B omission again, one level down.
 *
 * So the lookup is not asked of the object. `Map.prototype.get` reads the map's
 * internal slots, which no own property, no subclass override and no trap can
 * answer for, and it throws a `TypeError` for anything that has no such slots —
 * a Proxy over a Map included. That is the check and the read in one call.
 */
const mapGet = Map.prototype.get;

/**
 * Refuse a declaration container this package cannot read by its own lookup.
 *
 * Split out so a caller can state the contract defect UP FRONT, where it belongs
 * — `checks` naming a container that is not a Map is wrong about the contract
 * whether or not any line ever asks it for a key.
 */
export function assertUnitPrecisionContainer(declarations: unknown): void {
  if (declarations === null || typeof declarations !== 'object') {
    throw new CarrierFault('not-map', null, 'a unit precision container is not an object');
  }
  assertNotProxyCarrier(declarations);
  try {
    mapGet.call(declarations as Map<unknown, unknown>, undefined);
  } catch {
    throw new CarrierFault('not-map', null, "a unit precision container is not a Map, so this package's own lookup cannot read it");
  }
}

/** The intrinsic key iterator, captured for the same reason `mapGet` is. */
const mapKeys = Map.prototype.keys;

/**
 * Refuse a container KEY that no key of this package could ever be, and return
 * the string keys it declares.
 *
 * `E-A`, measured by the independent challenger at `f44222b`: the previous
 * remedy made the lookup honest about the VALUE and left the KEY unchecked, so a
 * boxed `String`, a numeric key and a `Symbol` key all dropped the whole
 * unit-precision law at the digest of a quote with no `checks` at all — `C-B`
 * again, from the other side of the same `get`.
 *
 * **What is refused here, and what is deliberately NOT.** An absent key MUST
 * stay lawful: a caller that declares precisions for some stock keys and not
 * others is legitimate, and that is the contract this module publishes. So a key
 * that merely FAILS TO MATCH cannot be refused by type — which leaves the
 * challenger's whitespace and upper-cased arms silent, and that is a stated
 * residual rather than an oversight (`OD-P6-08`'s kind of question: whether the
 * SHAPE of a stock key is the caller's business). What a type check CAN decide
 * is the subset that carries no information at all: a key that is not a string
 * can never be a deliberate declaration, because no key this package builds or
 * compares has that type.
 *
 * The walk happens ONCE PER CALL rather than once per lookup, which is why it is
 * split from `lookupUnitPrecision`: a quote with `n` lines would otherwise walk
 * the container `n` times. Its cost is proportional to entries the caller
 * actually inserted, not to a `length` it merely claims, which is why the `R-C2`
 * bound-before-walk rule does not apply to a `Map` the way it applied to a
 * sparse array.
 */
export function assertUnitPrecisionKeys(declarations: unknown): readonly string[] {
  assertUnitPrecisionContainer(declarations);
  const keys: string[] = [];
  for (const key of mapKeys.call(declarations as Map<unknown, unknown>) as IterableIterator<unknown>) {
    if (typeof key !== 'string') {
      throw new CarrierFault(
        'not-string-key',
        typeof key,
        'a unit precision container is keyed by something that is not a string, so it declares a law for no stock key this package can ask about',
      );
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Read ONE declaration out of a caller-supplied container, as a frozen snapshot.
 *
 * Two laws in one place, because they were two halves of one hole:
 *
 * - the container is read by the intrinsic lookup above, so the value is the
 *   one the map HOLDS rather than the one its `get` chose to return (`D-A`);
 * - the declaration itself is SNAPSHOTTED, because `requireUnitPrecision` reads
 *   `tracksInventory` twice and `unitDecimals` five times, and `cart.ts` records
 *   `tracksInventory` on the position a sixth. `D-B` measured both: a
 *   `unitDecimals` accessor answering `0` to every check and `4` to the read
 *   whose value is RETURNED accepted `5.5000` on a whole-unit product, and a
 *   `tracksInventory` accessor answering `true` to the `typeof` check and
 *   `false` to the law admitted a TRACKED product with no precision, which the
 *   honest object is refused for by `order.unit_precision_required`. The boxes
 *   were never the escape — `Number.isInteger` does not coerce — the second read
 *   was.
 *
 * `snapshotFields` carries the rest of the discipline: a Proxy, a non-plain
 * prototype, an accessor on any key, an undeclared field or a non-primitive leaf
 * is refused by name, and what comes back is frozen own data, so every later
 * read of it is the read that was checked. A missing field reads as `undefined`,
 * which is not a primitive leaf, so a half-stated declaration is refused here
 * instead of reaching the law as "no precision".
 *
 * Faults are raised as `CarrierFault` and mapped by the caller: a `field` of
 * `null` is the CONTAINER's defect and a named `field` is the declaration's, so
 * a caller can keep the contract refusal it already publishes for the first and
 * name the stock key in the second.
 */
export function lookupUnitPrecision(declarations: unknown, stockKey: string): UnitPrecisionDeclaration | undefined {
  assertUnitPrecisionContainer(declarations);
  const value: unknown = mapGet.call(declarations as Map<unknown, unknown>, stockKey);
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new CarrierFault('not-primitive', stockKey, 'a unit precision declaration is not an object stating the two halves of the law');
  }
  return snapshotFields<UnitPrecisionDeclaration>(value, DECLARATION_FIELDS);
}

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
