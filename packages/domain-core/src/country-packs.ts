/**
 * DAFTAR Country Packs — configuration data only, no domain code (COUNTRY_PACKS §1).
 * Tax = unconfigured for every pack until a documented legal source exists (§5).
 *
 * Currency semantics (Recovery Directive §21): a pack RECOMMENDS currencies.
 * `recommendedCurrencies` is a UX default/recommendation — NOT a security
 * whitelist. The technical whitelist of currencies the platform can process
 * lives in the Platform Currency Registry (currencies.ts). A country/currency
 * mismatch is a UX warning, never a security rejection.
 *
 * Phone metadata (§23): nationalLength values are UX hints only — never hard
 * validators. Real phone validation, when introduced, goes through a dedicated
 * numbering-library adapter, not these arrays.
 */

export type PlatformLocale = 'ar' | 'en' | 'tr';
export const PLATFORM_SUPPORTED_LOCALES: readonly PlatformLocale[] = ['ar', 'en', 'tr'];

export interface CountryPack {
  readonly code: string;
  readonly name: Readonly<Record<PlatformLocale, string>>;
  readonly defaultCurrency: string;
  /** Recommendation only — not a whitelist. */
  readonly recommendedCurrencies: readonly string[];
  readonly recommendedLocale: PlatformLocale;
  readonly recommendedStorefrontLocales: readonly PlatformLocale[];
  readonly phone: { readonly countryCode: string; readonly nationalLength: readonly number[] };
  readonly address: { readonly fields: readonly string[]; readonly required: readonly string[] };
  readonly tax: { readonly status: 'unconfigured' | 'configured'; readonly legalSource: string | null };
  readonly invoice: { readonly numberingPrefix: string };
  readonly chartOfAccountsTemplate: 'standard';
  readonly recommendedTimezone: string;
}

const PACKS: ReadonlyMap<string, CountryPack> = new Map(
  (
    [
      {
        code: 'PS',
        name: { ar: 'فلسطين', en: 'Palestine', tr: 'Filistin' },
        defaultCurrency: 'ILS',
        recommendedCurrencies: ['ILS', 'USD', 'JOD'],
        recommendedLocale: 'ar',
        recommendedStorefrontLocales: ['ar'],
        phone: { countryCode: '+970', nationalLength: [9] },
        address: { fields: ['city', 'street', 'building', 'notes'], required: ['city'] },
        tax: { status: 'unconfigured', legalSource: null },
        invoice: { numberingPrefix: 'INV' },
        chartOfAccountsTemplate: 'standard',
        recommendedTimezone: 'Asia/Hebron',
      },
      {
        code: 'JO',
        name: { ar: 'الأردن', en: 'Jordan', tr: 'Ürdün' },
        defaultCurrency: 'JOD',
        recommendedCurrencies: ['JOD', 'USD'],
        recommendedLocale: 'ar',
        recommendedStorefrontLocales: ['ar'],
        phone: { countryCode: '+962', nationalLength: [9] },
        address: { fields: ['city', 'street', 'building', 'notes'], required: ['city'] },
        tax: { status: 'unconfigured', legalSource: null },
        invoice: { numberingPrefix: 'INV' },
        chartOfAccountsTemplate: 'standard',
        recommendedTimezone: 'Asia/Amman',
      },
      {
        code: 'LB',
        name: { ar: 'لبنان', en: 'Lebanon', tr: 'Lübnan' },
        defaultCurrency: 'LBP',
        recommendedCurrencies: ['LBP', 'USD'],
        recommendedLocale: 'ar',
        recommendedStorefrontLocales: ['ar'],
        phone: { countryCode: '+961', nationalLength: [7, 8] },
        address: { fields: ['city', 'street', 'building', 'notes'], required: ['city'] },
        tax: { status: 'unconfigured', legalSource: null },
        invoice: { numberingPrefix: 'INV' },
        chartOfAccountsTemplate: 'standard',
        recommendedTimezone: 'Asia/Beirut',
      },
      {
        code: 'SY',
        name: { ar: 'سوريا', en: 'Syria', tr: 'Suriye' },
        defaultCurrency: 'SYP',
        recommendedCurrencies: ['SYP', 'USD'],
        recommendedLocale: 'ar',
        recommendedStorefrontLocales: ['ar'],
        phone: { countryCode: '+963', nationalLength: [9] },
        address: { fields: ['city', 'street', 'building', 'notes'], required: ['city'] },
        tax: { status: 'unconfigured', legalSource: null },
        invoice: { numberingPrefix: 'INV' },
        chartOfAccountsTemplate: 'standard',
        recommendedTimezone: 'Asia/Damascus',
      },
      {
        code: 'TR',
        name: { ar: 'تركيا', en: 'Türkiye', tr: 'Türkiye' },
        defaultCurrency: 'TRY',
        recommendedCurrencies: ['TRY', 'USD', 'EUR'],
        recommendedLocale: 'tr',
        recommendedStorefrontLocales: ['tr'],
        phone: { countryCode: '+90', nationalLength: [10] },
        address: { fields: ['city', 'district', 'street', 'building', 'notes'], required: ['city'] },
        tax: { status: 'unconfigured', legalSource: null },
        invoice: { numberingPrefix: 'INV' },
        chartOfAccountsTemplate: 'standard',
        recommendedTimezone: 'Europe/Istanbul',
      },
    ] as const
  ).map((p) => [p.code, p] as const),
);

export function getCountryPack(code: string): CountryPack {
  const pack = PACKS.get(code.toUpperCase());
  if (!pack) throw new CountryPackError(`Unsupported country: ${code}`, 'UNSUPPORTED_COUNTRY');
  return pack;
}

export function isSupportedCountry(code: string): boolean {
  return PACKS.has(code.toUpperCase());
}

export function supportedCountries(): readonly CountryPack[] {
  return [...PACKS.values()];
}

export class CountryPackError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CountryPackError';
  }
}
