import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_PERMISSIONS,
  CountryPackError,
  CurrencyError,
  Money,
  MoneyError,
  direction,
  formatMinorAmount,
  formatMoney,
  getCountryPack,
  getCurrency,
  getCurrencyDisplayName,
  hasPermission,
  isRtl,
  isSystemOwner,
  PERMISSIONS,
  TrustedRoleSet,
  isSupportedCountry,
  isSupportedCurrency,
  minorUnitsOf,
  normalizeSlug,
  plural,
  resolveLocale,
  suggestSlugFromName,
  suggestSlugs,
  supportedCurrencies,
  supportedCountries,
  transliterateArabic,
  validateSlug,
} from '../src';

describe('currency registry (financial facts only)', () => {
  it('holds exactly the seven platform currencies with ISO facts', () => {
    const codes = supportedCurrencies()
      .map((c) => c.code)
      .sort();
    expect(codes).toEqual(['EUR', 'ILS', 'JOD', 'LBP', 'SYP', 'TRY', 'USD']);
    expect(minorUnitsOf('JOD')).toBe(3);
    expect(minorUnitsOf('ILS')).toBe(2);
    expect(getCurrency('USD').numeric).toBe('840');
  });
  it('rejects unsupported currencies', () => {
    expect(isSupportedCurrency('GBP')).toBe(false);
    expect(() => getCurrency('GBP')).toThrow(CurrencyError);
  });
  it('stores no display names — names come from CLDR', () => {
    expect('nameAr' in getCurrency('USD')).toBe(false);
    expect('nameEn' in getCurrency('USD')).toBe(false);
  });
});

describe('currency display names via Intl.DisplayNames (ar/en/tr first-class)', () => {
  it('returns CLDR names in all three platform locales', () => {
    expect(getCurrencyDisplayName('TRY', 'tr')).toBe('Türk lirası');
    expect(getCurrencyDisplayName('USD', 'en')).toBe('US Dollar');
    expect(getCurrencyDisplayName('JOD', 'ar')).toContain('دينار');
    expect(getCurrencyDisplayName('ILS', 'ar')).toContain('شيكل');
  });
});

describe('Money VO — same-currency arithmetic', () => {
  it('adds and subtracts minor units exactly', () => {
    const a = Money.ofMinor(1500n, 'USD');
    const b = Money.ofMinor('250', 'USD');
    expect(a.add(b).amountMinor).toBe(1750n);
    expect(a.subtract(b).amountMinor).toBe(1250n);
  });
  it('rejects currency mismatch on every operation', () => {
    const usd = Money.ofMinor(100n, 'USD');
    const eur = Money.ofMinor(100n, 'EUR');
    expect(() => usd.add(eur)).toThrow(MoneyError);
    expect(() => usd.subtract(eur)).toThrow(MoneyError);
    expect(() => usd.compareTo(eur)).toThrow(MoneyError);
    expect(usd.equals(Money.ofMinor(100n, 'USD'))).toBe(true);
    expect(usd.equals(eur)).toBe(false);
  });
  it('supports zero, comparison, min/max', () => {
    expect(Money.zero('TRY').isZero()).toBe(true);
    const a = Money.ofMinor(5n, 'TRY');
    const b = Money.ofMinor(9n, 'TRY');
    expect(a.compareTo(b)).toBe(-1);
    expect(Money.max(a, b).amountMinor).toBe(9n);
    expect(Money.min(a, b).amountMinor).toBe(5n);
  });
});

describe('Money VO — precision hard tests (§17)', () => {
  it('keeps 9007199254740993 minor (MAX_SAFE_INTEGER + 2) exact for USD', () => {
    const m = Money.ofMinor(9007199254740993n, 'USD');
    expect(m.amountMinor).toBe(9007199254740993n);
    expect(Money.ofMinor(9007199254740993n, 'USD').add(Money.ofMinor(1n, 'USD')).amountMinor).toBe(9007199254740994n);
  });
  it('keeps 9007199254740993 minor exact for LBP (large-denomination reality)', () => {
    const m = Money.ofMinor('9007199254740993', 'LBP');
    expect(m.toJSON().amountMinor).toBe('9007199254740993');
  });
  it('keeps 999999999999999999 minor exact for SYP', () => {
    const m = Money.ofMinor(999999999999999999n, 'SYP');
    expect(m.add(Money.ofMinor(1n, 'SYP')).amountMinor).toBe(1000000000000000000n);
    expect(m.times(3n).amountMinor).toBe(2999999999999999997n);
  });
  it('parses JOD with 3 minor units exactly', () => {
    const m = Money.ofMajor('1234.567', 'JOD');
    expect(m.amountMinor).toBe(1234567n);
    expect(Money.ofMajor('0.001', 'JOD').amountMinor).toBe(1n);
  });
  it('rejects excess precision instead of rounding silently', () => {
    expect(() => Money.ofMajor('1.999', 'USD')).toThrow(MoneyError);
    expect(() => Money.ofMajor('1.0001', 'JOD')).toThrow(MoneyError);
  });
  it('handles ILS/TRY/EUR arithmetic exactly', () => {
    for (const c of ['ILS', 'TRY', 'EUR'] as const) {
      const m = Money.ofMajor('999999999.99', c);
      expect(m.add(Money.ofMinor(1n, c)).amountMinor).toBe(100000000000n);
    }
  });
});

describe('Money VO — unsafe number rejection (§18)', () => {
  it('rejects non-safe-integer JS numbers', () => {
    expect(() => Money.ofMinor(2 ** 53 + 1, 'USD')).toThrow(MoneyError);
    expect(() => Money.ofMinor(1.5, 'USD')).toThrow(MoneyError);
    expect(() => Money.ofMinor(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(MoneyError);
  });
  it('accepts safe integers, bigints, and decimal strings', () => {
    expect(Money.ofMinor(42, 'USD').amountMinor).toBe(42n);
    expect(Money.ofMinor(42n, 'USD').amountMinor).toBe(42n);
    expect(Money.ofMinor('42', 'USD').amountMinor).toBe(42n);
  });
});

describe('Money VO — multiplication integer-only (§19)', () => {
  it('multiplies by integer factors', () => {
    expect(Money.ofMinor(250n, 'USD').times(4).amountMinor).toBe(1000n);
    expect(Money.ofMinor(250n, 'USD').times('4').amountMinor).toBe(1000n);
  });
  it('rejects fractional and unsafe factors', () => {
    const m = Money.ofMinor(250n, 'USD');
    expect(() => m.times(2.5)).toThrow(MoneyError);
    expect(() => m.times(Number.MAX_SAFE_INTEGER * 2)).toThrow(MoneyError);
  });
});

describe('Money VO — negative policy (§20)', () => {
  it('forbids negatives by default — construction and subtraction', () => {
    expect(() => Money.ofMinor(-1n, 'USD')).toThrow(MoneyError);
    expect(() => Money.ofMajor('-5.00', 'USD')).toThrow(MoneyError);
    expect(() => Money.ofMinor(5n, 'USD').subtract(Money.ofMinor(6n, 'USD'))).toThrow(MoneyError);
  });
  it('allows negatives only with explicit policy, propagated through ops', () => {
    const deficit = Money.ofMinor(5n, 'USD').subtract(Money.ofMinor(8n, 'USD'), { allowNegative: true });
    expect(deficit.amountMinor).toBe(-3n);
    expect(deficit.isNegative()).toBe(true);
    // Explicitly signed values keep producing signed results without re-stating policy.
    expect(deficit.subtract(Money.ofMinor(2n, 'USD')).amountMinor).toBe(-5n);
    // An unsigned value never becomes negative silently even when added to a signed one.
    const signed = Money.ofMinor(-3n, 'USD', { allowNegative: true });
    expect(signed.add(Money.ofMinor(10n, 'USD')).amountMinor).toBe(7n);
  });
});

describe('Money formatting — BigInt-safe, no Number() path (§15–16)', () => {
  it('formats amounts above MAX_SAFE_INTEGER exactly', () => {
    const m = Money.ofMinor(9007199254740993n, 'USD');
    const s = formatMoney(m, 'en');
    expect(s).toContain('90,071,992,547,409.93');
    const lbp = formatMoney(Money.ofMinor(999999999999999999n, 'LBP'), 'en');
    expect(lbp).toContain('9,999,999,999,999,999.99');
  });
  it('formats JOD with 3 fraction digits', () => {
    const s = formatMoney(Money.ofMinor(1234567n, 'JOD'), 'en');
    expect(s).toContain('1,234.567');
  });
  it('formats zero and negative with explicit signed money', () => {
    expect(formatMoney(Money.zero('USD'), 'en')).toContain('0.00');
    const neg = Money.ofMinor(-500n, 'USD', { allowNegative: true });
    expect(formatMoney(neg, 'en')).toContain('5.00');
  });
  it('formats in Arabic and Turkish locales without precision loss', () => {
    const ar = formatMoney(Money.ofMinor(9007199254740993n, 'SYP'), 'ar');
    expect(ar).toContain('90,071,992,547,409.93');
    const tr = formatMoney(Money.ofMinor(123456789n, 'TRY'), 'tr');
    expect(tr).toContain('1.234.567,89');
  });
  it('formatMinorAmount renders grouped exact decimals', () => {
    expect(formatMinorAmount(9007199254740993n, 'USD', 'en')).toBe('90,071,992,547,409.93');
    expect(formatMinorAmount(1234567n, 'JOD', 'en')).toBe('1,234.567');
  });
});

describe('country packs', () => {
  it('covers PS/JO/LB/SY/TR with tax unconfigured everywhere', () => {
    const codes = supportedCountries()
      .map((c) => c.code)
      .sort();
    expect(codes).toEqual(['JO', 'LB', 'PS', 'SY', 'TR']);
    for (const p of supportedCountries()) {
      expect(p.tax.status).toBe('unconfigured');
      expect(p.tax.legalSource).toBeNull();
    }
  });
  it('recommends (not whitelists) currencies — §21', () => {
    expect(getCountryPack('PS').defaultCurrency).toBe('ILS');
    expect(getCountryPack('TR').recommendedCurrencies).toContain('EUR');
    // The pack does not pretend to be a security boundary:
    expect('supportedCurrencies' in getCountryPack('PS')).toBe(false);
  });
  it('rejects unsupported countries', () => {
    expect(isSupportedCountry('EG')).toBe(false);
    expect(() => getCountryPack('EG')).toThrow(CountryPackError);
  });
  it('keeps phone lengths as UX hints only', () => {
    expect(getCountryPack('TR').phone.nationalLength).toEqual([10]);
  });
});

describe('locale foundation', () => {
  it('resolves fallback chain to en', () => {
    expect(resolveLocale('ar')).toBe('ar');
    expect(resolveLocale('ar-PS')).toBe('ar');
    expect(resolveLocale('tr-TR')).toBe('tr');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
  });
  it('direction: ar is rtl, en/tr ltr', () => {
    expect(direction('ar')).toBe('rtl');
    expect(isRtl('ar')).toBe(true);
    expect(direction('en')).toBe('ltr');
    expect(direction('tr')).toBe('ltr');
  });
  it('CLDR pluralization differs per locale', () => {
    expect(plural('ar', 0, { zero: 'لا منتجات', other: '{count} منتج' })).toBe('لا منتجات');
    expect(plural('en', 1, { one: 'one product', other: '{count} products' })).toBe('one product');
    expect(plural('en', 5, { one: 'one product', other: '{count} products' })).toBe('5 products');
    expect(plural('tr', 5, { other: '{count} ürün' })).toBe('5 ürün');
  });
  it('Turkish casing survives Intl paths (İıŞşĞğÇçÖöÜü)', () => {
    const s = 'Iıİi Şş Ğğ Çç Öö Üü';
    expect(s.toLocaleLowerCase('tr')).toBe('ııii şş ğğ çç öö üü');
    expect('istanbul'.toLocaleUpperCase('tr')).toBe('İSTANBUL');
  });
});

describe('store slugs', () => {
  it('normalizes case, spaces, Arabic-Indic digits', () => {
    expect(normalizeSlug('  My Shop٢ ')).toBe('my-shop2');
    expect(normalizeSlug('A__B--C')).toBe('a-b-c');
  });
  it('validates length, charset, reserved words', () => {
    expect(validateSlug('ab').ok).toBe(false);
    expect(validateSlug('admin').reason).toBe('RESERVED');
    expect(validateSlug('my-store').ok).toBe(true);
    expect(validateSlug('x'.repeat(60)).reason).toBe('TOO_LONG');
  });
  it('suggests alternatives when taken', () => {
    const s = suggestSlugs('coffee', (slug) => slug === 'coffee-market');
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain('coffee-market');
  });
});

describe('Arabic store slug (§24)', () => {
  it('transliterates Arabic names into ASCII-safe slugs', () => {
    expect(transliterateArabic('متجر')).toBe('mtjr');
    expect(suggestSlugFromName('متجر')).toBe('mtjr');
    expect(suggestSlugFromName('قهوة الصباح')).toBe('qhwh-alsbah');
  });
  it('never returns an empty or reserved suggestion for Unicode input', () => {
    const s = suggestSlugFromName('متجر');
    expect(validateSlug(s).ok).toBe(true);
    const emoji = suggestSlugFromName('🚀🚀');
    expect(validateSlug(emoji).ok).toBe(true);
    expect(emoji.startsWith('store-')).toBe(true);
    // fallback tokens are random, not a shared word
    expect(suggestSlugFromName('🚀🚀')).not.toBe('store-shop');
  });
  it('fallback tokens differ between calls (no shared collision word)', () => {
    expect(suggestSlugFromName('❄️')).not.toBe(suggestSlugFromName('❄️'));
  });
});

describe('RBAC evaluator (§25–27: owner authority = trusted role identity)', () => {
  it('system owner role (is_system AND key=owner from DB) holds every permission', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.owner.length).toBeGreaterThan(10);
    const set = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    expect(hasPermission(set, 'business.manage')).toBe(true);
    expect(isSystemOwner(set)).toBe(true);
  });
  it('non-system role named "owner" does NOT get owner authority (identity requires is_system)', () => {
    const set = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: false, permissions: new Set(['catalog.view']) }]);
    expect(hasPermission(set, 'business.manage')).toBe(false);
    expect(isSystemOwner(set)).toBe(false);
  });
  it('fake owner flag on an untrusted-like structure does not escalate (§27)', () => {
    // A forged row claiming a privileged key without system attestation grants nothing extra.
    const forged = TrustedRoleSet.fromPersistence([
      { key: 'owner', isSystem: false, permissions: new Set() },
      { key: 'superadmin', isSystem: false, permissions: new Set() },
    ]);
    for (const p of PERMISSIONS) expect(hasPermission(forged, p)).toBe(false);
    // A system role that is not the owner key is also not owner.
    const notOwner = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: true, permissions: new Set() }]);
    expect(hasPermission(notOwner, 'member.manage')).toBe(false);
  });
  it('cashier is catalog.view only', () => {
    const cashier = TrustedRoleSet.fromPersistence([{ key: 'cashier', isSystem: false, permissions: new Set(BUILTIN_ROLE_PERMISSIONS.cashier) }]);
    expect(hasPermission(cashier, 'catalog.view')).toBe(true);
    expect(hasPermission(cashier, 'catalog.create')).toBe(false);
    expect(hasPermission(cashier, 'member.manage')).toBe(false);
  });
  it('custom roles evaluate by their permission set', () => {
    const custom = TrustedRoleSet.fromPersistence([{ key: 'stock-clerk', isSystem: false, permissions: new Set(['catalog.view', 'catalog.update']) }]);
    expect(hasPermission(custom, 'catalog.update')).toBe(true);
    expect(hasPermission(custom, 'catalog.archive')).toBe(false);
  });
});

describe('industry profiles (§46–48)', () => {
  it('generic profile exists and resolves unknown activities', async () => {
    const { resolveIndustryProfile, normalizeIndustryProfileKey, GENERIC_INDUSTRY_PROFILE } = await import('../src');
    expect(GENERIC_INDUSTRY_PROFILE.key).toBe('generic');
    expect(resolveIndustryProfile('tattoo-parlor').key).toBe('generic');
    expect(resolveIndustryProfile(undefined).key).toBe('generic');
    expect(resolveIndustryProfile('RESTAURANT').key).toBe('restaurant');
    expect(normalizeIndustryProfileKey('  My Shop!! ')).toBe('my-shop');
    expect(normalizeIndustryProfileKey('***')).toBe('generic');
  });
});

describe('capability registry (§49–50)', () => {
  it('registry exists, all capabilities unimplemented in Phase 1, no closed enum', async () => {
    const { CapabilityRegistry } = await import('../src');
    const all = CapabilityRegistry.all();
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const c of all) expect(c.implemented).toBe(false);
    expect(CapabilityRegistry.isKnown('inventory.serial-tracking')).toBe(true);
    expect(CapabilityRegistry.isImplemented('inventory.serial-tracking')).toBe(false);
    expect(CapabilityRegistry.get('nope')).toBeUndefined();
  });
});
