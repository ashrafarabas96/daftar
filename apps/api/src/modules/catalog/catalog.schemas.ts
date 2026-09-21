import { z } from 'zod';
import { isSupportedCurrency } from '@daftar/domain-core';
import { LOCALES } from '@daftar/shared-contracts';

const translations = z
  .partialRecord(z.enum(LOCALES as ['ar', 'en', 'tr']), z.string().min(1).max(200))
  .refine((t) => Object.values(t).some((v) => typeof v === 'string' && v.length > 0), {
    message: 'at_least_one_translation',
  });

export const CategoryCreateSchema = z
  .object({
    translations,
    parentId: z.string().uuid().optional(),
  })
  .strict();

const variantSchema = z
  .object({
    attributes: z.record(z.string(), z.string()).default({}),
    sku: z.string().min(1).max(64).optional(),
    barcode: z.string().min(1).max(64).optional(),
    priceMinor: z.coerce.bigint().nonnegative().optional(), // string in, bigint safe
  })
  .strict();

/**
 * Product create (§57): Name + Price are the ONLY mandatory fields.
 * Everything else is optional/progressive. Mass-assignment defense (§94):
 * strict schemas reject tenant_id / business_id / owner flags / system roles.
 */
export const ProductCreateSchema = z
  .object({
    translations,
    basePriceMinor: z.coerce.bigint().nonnegative(),
    // §36 (Stabilization): the SERVER is the currency authority. The client
    // may omit priceCurrency (derived from business.base_currency); if it
    // sends one that disagrees, the request is rejected — never silently
    // accepted.
    priceCurrency: z.string().refine(isSupportedCurrency, { message: 'unsupported_currency' }).optional(),
    categoryId: z.string().uuid().optional(),
    sku: z.string().min(1).max(64).optional(),
    barcode: z.string().min(1).max(64).optional(),
    unit: z.string().min(1).max(32).optional(),
    variants: z.array(variantSchema).max(200).optional(),
  })
  .strict();

export const ProductUpdateSchema = z
  .object({
    translations: translations.optional(),
    basePriceMinor: z.coerce.bigint().nonnegative().optional(),
    priceCurrency: z.string().refine(isSupportedCurrency, { message: 'unsupported_currency' }).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    sku: z.string().min(1).max(64).nullable().optional(),
    barcode: z.string().min(1).max(64).nullable().optional(),
    unit: z.string().min(1).max(32).nullable().optional(),
    version: z.number().int().positive().optional(), // optimistic concurrency precondition (§98)
  })
  .strict();
