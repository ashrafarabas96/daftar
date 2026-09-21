/**
 * Capability registry (Directive §49–50, §107–110).
 *
 * A CapabilityKey is a stable, dot-namespaced identifier for an OPTIONAL
 * future feature (inventory.advanced, inventory.serial-tracking,
 * inventory.lot-expiry, appointments, restaurant.tables, restaurant.kitchen,
 * repairs, bookings, catalog.variant-matrix, …).
 *
 * Phase 1 ships the REGISTRY ONLY — a stable extension seam. No capability
 * module is implemented now, and enabling a capability must never require
 * changing the Financial Core (§50). The UI must not render navigation or
 * controls for capabilities that are not enabled (§110).
 */

export type CapabilityKey = string;

export interface CapabilityDefinition {
  readonly key: CapabilityKey;
  /** Domain that will own the implementation when its phase arrives. */
  readonly ownerDomain: 'inventory' | 'catalog' | 'scheduling' | 'restaurant' | 'services';
  /** True once an implementation exists; Phase 1: all false. */
  readonly implemented: boolean;
}

const DEFINITIONS: readonly CapabilityDefinition[] = [
  { key: 'inventory.advanced', ownerDomain: 'inventory', implemented: false },
  { key: 'inventory.serial-tracking', ownerDomain: 'inventory', implemented: false },
  { key: 'inventory.lot-expiry', ownerDomain: 'inventory', implemented: false },
  { key: 'catalog.variant-matrix', ownerDomain: 'catalog', implemented: false },
  { key: 'appointments', ownerDomain: 'scheduling', implemented: false },
  { key: 'bookings', ownerDomain: 'services', implemented: false },
  { key: 'restaurant.tables', ownerDomain: 'restaurant', implemented: false },
  { key: 'restaurant.kitchen', ownerDomain: 'restaurant', implemented: false },
].map((d) => Object.freeze(d) as CapabilityDefinition);

const REGISTRY: ReadonlyMap<CapabilityKey, CapabilityDefinition> = new Map(DEFINITIONS.map((d) => [d.key, d]));

export const CapabilityRegistry = Object.freeze({
  get(key: CapabilityKey): CapabilityDefinition | undefined {
    return REGISTRY.get(key);
  },
  isKnown(key: CapabilityKey): boolean {
    return REGISTRY.has(key);
  },
  /** Phase 1: always false — no capability is implemented yet. */
  isImplemented(key: CapabilityKey): boolean {
    return REGISTRY.get(key)?.implemented === true;
  },
  all(): readonly CapabilityDefinition[] {
    return DEFINITIONS;
  },
});
