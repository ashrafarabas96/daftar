/**
 * Industry profiles (Directive §46–48).
 *
 * Business type is NOT a closed enum — DAFTAR serves many sectors. A business
 * carries an open `industry_profile_key` string; this registry maps KNOWN keys
 * to Phase-1-neutral defaults. Unknown keys resolve to GENERIC so the app works
 * for unlisted activities without waiting for an update (§48).
 *
 * Phase 1 role: suggest future Defaults/Capabilities ONLY. Profiles never
 * change Accounting, Money, Tenant Security, or Ledger (§47), and no
 * `if restaurant / if pharmacy` branching may appear in Core.
 */

export interface IndustryProfile {
  readonly key: string;
  /** Capability keys this profile will likely want (advisory only in Phase 1). */
  readonly suggestedCapabilities: readonly string[];
}

export const GENERIC_INDUSTRY_PROFILE: IndustryProfile = Object.freeze({
  key: 'generic',
  suggestedCapabilities: Object.freeze([]),
});

const KNOWN: readonly IndustryProfile[] = [
  Object.freeze({ key: 'retail', suggestedCapabilities: Object.freeze(['inventory.advanced']) }),
  Object.freeze({ key: 'apparel', suggestedCapabilities: Object.freeze(['inventory.advanced', 'catalog.variant-matrix']) }),
  Object.freeze({ key: 'electronics', suggestedCapabilities: Object.freeze(['inventory.serial-tracking']) }),
  Object.freeze({ key: 'pharmacy', suggestedCapabilities: Object.freeze(['inventory.lot-expiry']) }),
  Object.freeze({ key: 'restaurant', suggestedCapabilities: Object.freeze(['restaurant.tables', 'restaurant.kitchen']) }),
  Object.freeze({ key: 'clinic', suggestedCapabilities: Object.freeze(['appointments']) }),
  Object.freeze({ key: 'services', suggestedCapabilities: Object.freeze(['bookings']) }),
];

const REGISTRY: ReadonlyMap<string, IndustryProfile> = new Map(KNOWN.map((p) => [p.key, p]));

/**
 * Resolve a profile by key. Unknown / empty / unlisted keys resolve to the
 * GENERIC profile — never an error, never a blocker to onboarding (§48).
 */
export function resolveIndustryProfile(key: string | null | undefined): IndustryProfile {
  if (!key) return GENERIC_INDUSTRY_PROFILE;
  return REGISTRY.get(key.trim().toLowerCase()) ?? GENERIC_INDUSTRY_PROFILE;
}

/** Non-empty, URL-ish safe profile key normalization for storage. */
export function normalizeIndustryProfileKey(key: string | null | undefined): string {
  if (!key) return GENERIC_INDUSTRY_PROFILE.key;
  const k = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return k.length > 0 && k.length <= 64 ? k : GENERIC_INDUSTRY_PROFILE.key;
}
