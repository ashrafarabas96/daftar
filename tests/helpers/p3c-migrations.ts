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
  // TD-16: no return leaves a sub-unit AP residue; one already left is written off (R-95, R-96).
  '0072_purchase_sub_unit_residue.sql',
  // TD-20: the system-named default warehouse in the business's locale (onboarding trigger and backfill).
  '0073_default_warehouse_locale_name.sql',
] as const;

/**
 * The operation kinds the corrective migrations register — each with
 * `registered_by = 'P3-C'` (0072 §8 widens the registry's CHECK to admit
 * exactly that literal). Registry pins that enumerate the kinds append this
 * list, so a corrective kind is a reviewed change, never a silent widening.
 */
export const P3C_OPERATION_KINDS = [
  // TD-16 (0072 R-96): the write-off of a purchase's sub-unit AP residue.
  'purchase.write_off_residue',
] as const;

/** The relations the corrective migrations create (each a reviewed addition to the Phase 3 surface). */
export const P3C_RELATIONS = [
  // TD-16 (0072 R-96): the residue write-offs.
  'purchase_residue_write_offs',
] as const;

/** The accounting source types the corrective migrations register, with their sort order; each is owned by `post`. */
export const P3C_ACCOUNTING_SOURCE_TYPES = [
  // TD-16 (0072 R-96): the write-off entry, Dr Accounts Payable / Cr FX gain.
  ['purchase_residue_write_off', 12],
] as const;

/** The `concat_ws(':', 'src', source_type, sort_order)` rows the upgrade matrices protect, for the corrective source types. */
export const P3C_SOURCE_TYPE_ROWS: readonly string[] = P3C_ACCOUNTING_SOURCE_TYPES.map(([t, n]) => `src:${t}:${n}`);

/** The registry rows the corrective migrations add, in the upgrade matrices' `registries()` spelling. */
export const P3C_REGISTRY_ROWS: readonly string[] = [
  ...P3C_OPERATION_KINDS.map((op) => `op:${op}:P3-C`),
  ...P3C_ACCOUNTING_SOURCE_TYPES.map(([t]) => `acct:post:${t}`),
];
