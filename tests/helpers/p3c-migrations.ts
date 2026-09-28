/**
 * The Phase 3 corrective forward migrations (the Tech Lead's corrective
 * directive; 0070 onwards), named one by one. The upgrade matrices that pin
 * "exactly these files apply" append this list after the slices they were
 * written for, so a new corrective file is a reviewed change here, never a
 * silent widening of a pin.
 */
export const P3_CORRECTIVE_MIGRATIONS = [
  // TD-18: internal owners and a pinned path for the four applier-owned definers; the provisioning key is written once.
  '0070_definer_ownership_hardening.sql',
  // S8 I-1: after the first stock movement, a generic reversal may not change the Inventory account (R-B1b).
  '0071_reversal_inventory_account_domain.sql',
] as const;
