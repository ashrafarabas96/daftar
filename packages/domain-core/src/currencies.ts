/**
 * DAFTAR Currency Registry — ISO 4217 financial facts ONLY:
 * code, numeric code, minor units.
 *
 * Display names are NOT stored here. Currency names come from CLDR via
 * Intl.DisplayNames per UI locale (ar/en/tr) — see locale.ts.
 * No hand-written transliterations.
 */

export interface CurrencyMeta {
  /** ISO 4217 alpha code */
  readonly code: string;
  /** ISO 4217 numeric code */
  readonly numeric: string;
  /** Number of minor units (fraction digits) */
  readonly minorUnits: number;
}

const REGISTRY: ReadonlyMap<string, CurrencyMeta> = new Map(
  (
    [
      { code: 'ILS', numeric: '376', minorUnits: 2 },
      { code: 'JOD', numeric: '400', minorUnits: 3 },
      { code: 'LBP', numeric: '422', minorUnits: 2 },
      { code: 'SYP', numeric: '760', minorUnits: 2 },
      { code: 'TRY', numeric: '949', minorUnits: 2 },
      { code: 'USD', numeric: '840', minorUnits: 2 },
      { code: 'EUR', numeric: '978', minorUnits: 2 },
    ] as const
  ).map((c) => [c.code, c] as const),
);

export function getCurrency(code: string): CurrencyMeta {
  const meta = REGISTRY.get(code.toUpperCase());
  if (!meta) throw new CurrencyError(`Unsupported currency: ${code}`, 'UNSUPPORTED_CURRENCY');
  return meta;
}

export function isSupportedCurrency(code: string): boolean {
  return REGISTRY.has(code.toUpperCase());
}

/** All currencies the platform can technically process (the technical whitelist). */
export function supportedCurrencies(): readonly CurrencyMeta[] {
  return [...REGISTRY.values()];
}

export function minorUnitsOf(code: string): number {
  return getCurrency(code).minorUnits;
}

export class CurrencyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CurrencyError';
  }
}
