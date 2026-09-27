import type { Request } from 'express';
import { LOCALES, type LocaleCode } from '@daftar/shared-contracts';

function isLocale(value: string): value is LocaleCode {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale a read resolves names in (PHASE_3_S7_CONTRACT §4.2): the first
 * `Accept-Language` tag's primary subtag when it is one of the three product
 * locales, else `ar`. The parser of `catalog.controller.ts`, copied here so
 * the S7 reads and the catalog resolve one way.
 */
export function localeOf(req: Request): LocaleCode {
  const raw = (req.headers['accept-language'] ?? 'ar').split(',')[0]?.trim() ?? 'ar';
  const base = raw.split('-')[0]?.toLowerCase() ?? 'ar';
  return isLocale(base) ? base : 'ar';
}
