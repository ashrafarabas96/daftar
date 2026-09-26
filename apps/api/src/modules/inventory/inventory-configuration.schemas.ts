import { z } from 'zod';
import { REGISTRY_CODE_RE } from '@daftar/inventory';

/**
 * The inventory configuration command's request (P3-AL-04, P3-AL-05).
 *
 * - `trackInventory` is required: the command states the configuration it
 *   wants, it never toggles.
 * - `unitCode` must already match the registry pattern
 *   `^[a-z][a-z0-9_]{0,31}$`. It is REFUSED otherwise, never lower-cased or
 *   trimmed into acceptance: the `invpl/1` canonicalizer signs the exact
 *   bytes, and the database rebuilds them from its own argument (P3-AL-55 §F).
 *   Omitted = keep the product's current canonical unit. There is no way to
 *   clear a canonical unit: once selected it stays on the product
 *   (P3-AL-05 §D).
 * - `unitDecimals` is an integer 0..4 (P3-AL-05). Omitted = the registry
 *   default when the unit changes, otherwise the product's persisted value —
 *   decided by the routine, once, and then frozen on the product.
 *
 * Strict: tenant, business, actor and any authority flag are refused as
 * unknown keys (mass-assignment defence, §94). There is no `trusted`,
 * `force` or `skip*` field, and none can be added without failing this.
 */
export const InventoryConfigurationSchema = z
  .object({
    trackInventory: z.boolean(),
    unitCode: z.string().regex(REGISTRY_CODE_RE, { message: 'unit_code_invalid' }).optional(),
    unitDecimals: z.number().int().min(0).max(4).optional(),
  })
  .strict();

export type InventoryConfigurationInput = z.infer<typeof InventoryConfigurationSchema>;
