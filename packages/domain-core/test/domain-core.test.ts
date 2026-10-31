import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  beyondGrantAuthority,
  isPermission,
  isSensitivePermission,
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
  type Permission,
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
  it('cashier holds catalog.view and no catalog or member authority beyond it', () => {
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

describe('P2-S1 accounting permissions (directive §17, §18, §23)', () => {
  const ACCOUNTING = ['accounting.view', 'accounting.post', 'accounting.reverse', 'accounting.chart.manage', 'accounting.fx.manage'] as const;

  /** P2-S6 §21 added exactly these two, and no third. */
  const PERIOD = ['accounting.period.manage', 'accounting.period.reopen'] as const;

  it('isPermission() recognizes all five non-period accounting keys', () => {
    for (const key of ACCOUNTING) expect(isPermission(key)).toBe(true);
  });

  it('the accounting registry is exactly the five P2-S1 keys plus the two P2-S6 period keys', () => {
    for (const key of PERIOD) expect(isPermission(key)).toBe(true);
    expect(PERMISSIONS.filter((p) => p.startsWith('accounting.'))).toEqual([...ACCOUNTING, ...PERIOD]);
  });

  /**
   * §21, in the registry itself: `reopen` is its own key.
   *
   * Nothing here derives one from the other, and no code path may. Undoing a
   * close is a separate authority from closing, so a member trusted to close
   * the books is not thereby trusted to reopen them.
   */
  it('accounting.period.reopen is a SEPARATE key, not implied by accounting.period.manage', () => {
    const manageOnly = TrustedRoleSet.fromPersistence([{ key: 'closer', isSystem: false, permissions: new Set(['accounting.period.manage']) }]);
    expect(hasPermission(manageOnly, 'accounting.period.manage')).toBe(true);
    expect(hasPermission(manageOnly, 'accounting.period.reopen')).toBe(false);

    const reopenOnly = TrustedRoleSet.fromPersistence([{ key: 'undoer', isSystem: false, permissions: new Set(['accounting.period.reopen']) }]);
    expect(hasPermission(reopenOnly, 'accounting.period.manage')).toBe(false);
    expect(hasPermission(reopenOnly, 'accounting.period.reopen')).toBe(true);
  });

  it('accounting.view is ordinary; posting, reversing, chart, FX and BOTH period keys are sensitive', () => {
    expect(isSensitivePermission('accounting.view')).toBe(false);
    for (const key of ['accounting.post', 'accounting.reverse', 'accounting.chart.manage', 'accounting.fx.manage', ...PERIOD] as const) {
      expect(isSensitivePermission(key)).toBe(true);
    }
    expect((SENSITIVE_PERMISSIONS as readonly string[]).includes('accounting.view')).toBe(false);
  });

  it('the system owner holds all five by identity', () => {
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    for (const key of ACCOUNTING) expect(hasPermission(owner, key)).toBe(true);
    for (const key of ACCOUNTING) expect(BUILTIN_ROLE_PERMISSIONS.owner).toContain(key);
  });

  it('the system owner holds both period keys by identity too (§21)', () => {
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    for (const key of PERIOD) {
      expect(hasPermission(owner, key)).toBe(true);
      expect(BUILTIN_ROLE_PERMISSIONS.owner).toContain(key);
    }
  });

  it('manager and cashier gain NO accounting authority (C-12: no built-in accountant role)', () => {
    for (const roleKey of ['manager', 'cashier'] as const) {
      expect(BUILTIN_ROLE_PERMISSIONS[roleKey].some((p) => p.startsWith('accounting.'))).toBe(false);
      const set = TrustedRoleSet.fromPersistence([{ key: roleKey, isSystem: false, permissions: new Set(BUILTIN_ROLE_PERMISSIONS[roleKey]) }]);
      for (const key of [...ACCOUNTING, ...PERIOD]) expect(hasPermission(set, key)).toBe(false);
    }
  });

  it('an existing custom role is unchanged by the new registry entries', () => {
    const custom = TrustedRoleSet.fromPersistence([{ key: 'stock-clerk', isSystem: false, permissions: new Set(['catalog.view', 'catalog.update']) }]);
    for (const key of ACCOUNTING) expect(hasPermission(custom, key)).toBe(false);
  });

  it('delegation ceiling: a non-owner without accounting.chart.manage cannot delegate it', () => {
    const manager = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: false, permissions: new Set(BUILTIN_ROLE_PERMISSIONS.manager) }]);
    expect(beyondGrantAuthority(manager, ['accounting.chart.manage'])).toEqual(['accounting.chart.manage']);
    // A non-owner who DOES hold it may pass it on — the ceiling is what you hold, not who you are.
    const accountingManager = TrustedRoleSet.fromPersistence([
      { key: 'books', isSystem: false, permissions: new Set(['accounting.view', 'accounting.chart.manage']) },
    ]);
    expect(beyondGrantAuthority(accountingManager, ['accounting.chart.manage', 'accounting.view'])).toEqual([]);
    expect(beyondGrantAuthority(accountingManager, ['accounting.post'])).toEqual(['accounting.post']);
    // The system owner is exempt by identity.
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    expect(beyondGrantAuthority(owner, [...ACCOUNTING])).toEqual([]);
  });

  it('every sensitive permission is a registered permission', () => {
    for (const p of SENSITIVE_PERMISSIONS) expect(isPermission(p)).toBe(true);
  });
});

/**
 * The twelve Phase 4 keys (P4-AL-36), copied from the lock and NOT read back
 * from the registry, so a key added to the registry without being added to the
 * lock's list is not silently absorbed by any assertion that uses `isPhase4`.
 */
const PHASE_4_KEYS: readonly string[] = [
  'sales.view',
  'sales.create',
  'sales.void',
  'sales.return',
  'sales.discount',
  'customers.view',
  'customers.manage',
  'payments.collect',
  'payments.reverse',
  'refunds.approve',
  'receivables.view',
  'installments.manage',
];
const isPhase4 = (p: string): boolean => PHASE_4_KEYS.includes(p);

/**
 * P3-S1's own lists, hoisted to module scope in P4-S1 so the Phase 4 block can
 * reuse the same `isPhase3` predicate for its totality check. Contents
 * unchanged, byte for byte.
 */
const P3_ORDINARY = ['inventory.view', 'purchases.view', 'suppliers.view'] as const;
const P3_SENSITIVE = [
  'inventory.adjust',
  'inventory.transfer',
  'inventory.stocktake',
  'purchases.manage',
  'purchases.receive',
  'purchases.return',
  'suppliers.manage',
  'suppliers.pay',
] as const;
const PHASE_3: readonly string[] = [...P3_ORDINARY, ...P3_SENSITIVE];
const isPhase3 = (p: string): boolean => PHASE_3.includes(p);

/** The Manager's accepted Phase 1 set, byte for byte and in order (P3-AL-38 precision note). */
const MANAGER_PHASE_1 = [
  'business.view',
  'branch.view',
  'branch.manage',
  'warehouse.view',
  'warehouse.manage',
  'member.view',
  'member.invite',
  'role.view',
  'role.assign',
  'catalog.view',
  'catalog.create',
  'catalog.update',
  'catalog.archive',
  'category.manage',
  'media.manage',
  'settings.view',
  'subscription.view',
];

describe('P3-S1 Phase 3 permissions (P3-AL-38, P3-AL-53)', () => {
  const ORDINARY = P3_ORDINARY;
  const SENSITIVE = P3_SENSITIVE;

  it('registers exactly the eleven Phase 3 keys, and no other key under their prefixes', () => {
    for (const key of PHASE_3) expect(isPermission(key)).toBe(true);
    expect(PERMISSIONS.filter((p) => /^(inventory|purchases|suppliers)\./.test(p)).sort()).toEqual([...PHASE_3].sort());
  });

  it('the three view keys are ordinary and the other eight are sensitive', () => {
    for (const key of ORDINARY) expect(isSensitivePermission(key)).toBe(false);
    for (const key of SENSITIVE) expect(isSensitivePermission(key)).toBe(true);
    expect(SENSITIVE_PERMISSIONS.filter((p) => isPhase3(p)).sort()).toEqual([...SENSITIVE].sort());
  });

  it('owner: all eleven, by construction of the registry and by identity', () => {
    for (const key of PHASE_3) expect(BUILTIN_ROLE_PERMISSIONS.owner).toContain(key);
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    for (const key of [...ORDINARY, ...SENSITIVE]) expect(hasPermission(owner, key)).toBe(true);
  });

  it('manager: exactly the three view keys among the Phase 3 keys', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.manager.filter((p) => isPhase3(p)).sort()).toEqual([...ORDINARY].sort());
  });

  it('manager: the accepted Phase 1 set survives untouched, in order, with the Phase 3 keys appended', () => {
    // P4-S1 (P4-AL-35, plan action 6): this equality was `filter((p) => !isPhase3(p))`,
    // which put every LATER phase's keys inside the Phase 1 list and broke on the
    // first Phase 4 default. Re-expressed PER PHASE, exactly as Phase 3 itself did
    // for its own keys: the claim is still "the accepted Phase 1 list, byte for
    // byte and in order", and it is NOT loosened — the Phase 4 keys are not
    // dropped from scrutiny, they are asserted by exact equality in the P4-S1
    // block below, which also proves the registry holds no key belonging to no
    // phase at all. A key under a prefix no phase owns still lands in this filter
    // and still turns this assertion red.
    expect(BUILTIN_ROLE_PERMISSIONS.manager.filter((p) => !isPhase3(p) && !isPhase4(p))).toEqual(MANAGER_PHASE_1);
    expect(BUILTIN_ROLE_PERMISSIONS.manager.slice(0, MANAGER_PHASE_1.length)).toEqual(MANAGER_PHASE_1);
  });

  it('cashier: no Phase 3 key', () => {
    // P4-S1: `toEqual(['catalog.view'])` became `filter((p) => !isPhase4(p))` for
    // the same reason and with the same guarantee — the cashier's non-Phase-4 set
    // is still exactly `['catalog.view']`, so a Phase 3 key, or a key of no phase,
    // appearing on the cashier is still red here.
    expect(BUILTIN_ROLE_PERMISSIONS.cashier.some((p) => isPhase3(p))).toBe(false);
    expect(BUILTIN_ROLE_PERMISSIONS.cashier.filter((p) => !isPhase4(p))).toEqual(['catalog.view']);
  });

  it('no non-owner built-in role holds a sensitive Phase 3 key', () => {
    for (const roleKey of ['manager', 'cashier'] as const) {
      const set = TrustedRoleSet.fromPersistence([{ key: roleKey, isSystem: true, permissions: new Set(BUILTIN_ROLE_PERMISSIONS[roleKey]) }]);
      for (const key of SENSITIVE) expect(hasPermission(set, key)).toBe(false);
    }
  });

  it('an existing custom role gains nothing, and the delegation ceiling holds for the new keys', () => {
    const custom = TrustedRoleSet.fromPersistence([{ key: 'stock-clerk', isSystem: false, permissions: new Set(['catalog.view', 'catalog.update']) }]);
    for (const key of [...ORDINARY, ...SENSITIVE]) expect(hasPermission(custom, key)).toBe(false);
    const manager = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: true, permissions: new Set(BUILTIN_ROLE_PERMISSIONS.manager) }]);
    expect(beyondGrantAuthority(manager, ['inventory.view'])).toEqual([]);
    expect(beyondGrantAuthority(manager, ['inventory.adjust', 'suppliers.pay'])).toEqual(['inventory.adjust', 'suppliers.pay']);
  });
});

describe('P4-S1 Phase 4 permissions (P4-AL-35, P4-AL-36, P4-AL-37, OD-P4-01 OPTION A)', () => {
  /**
   * P4-AL-36's twelve keys with P4-AL-37's sensitivity column, copied from the
   * lock rather than read from the registry. `PHASE_4_KEYS` above is derived
   * from this table and asserted against it, so the two cannot drift.
   */
  const LOCK: readonly (readonly [string, 'ordinary' | 'sensitive'])[] = [
    ['sales.view', 'ordinary'],
    ['sales.create', 'ordinary'],
    ['sales.void', 'sensitive'],
    ['sales.return', 'sensitive'],
    ['sales.discount', 'sensitive'],
    ['customers.view', 'ordinary'],
    ['customers.manage', 'ordinary'],
    ['payments.collect', 'ordinary'],
    ['payments.reverse', 'sensitive'],
    ['refunds.approve', 'sensitive'],
    ['receivables.view', 'ordinary'],
    ['installments.manage', 'sensitive'],
  ];
  const ORDINARY = LOCK.filter(([, l]) => l === 'ordinary').map(([k]) => k);
  const SENSITIVE = LOCK.filter(([, l]) => l === 'sensitive').map(([k]) => k);

  /** The `OD-P4-01` ruling's forbidden-as-a-default list, verbatim. */
  const FORBIDDEN_AS_DEFAULT = ['sales.discount', 'sales.void', 'refunds.approve', 'payments.reverse', 'installments.manage'];

  /** The DEFAULTS the ruling grants, by role. Not read from the registry. */
  const MANAGER_PHASE_4 = ['sales.view', 'sales.create', 'customers.view', 'customers.manage', 'payments.collect', 'receivables.view'];
  const CASHIER_PHASE_4 = ['sales.view', 'sales.create', 'customers.view', 'payments.collect'];

  /** The accepted pre-Phase-4 built-in sets, byte for byte and in order. */
  const MANAGER_PRE_P4 = [...MANAGER_PHASE_1, 'inventory.view', 'purchases.view', 'suppliers.view'];
  const CASHIER_PRE_P4 = ['catalog.view'];

  const sorted = (xs: readonly string[]): string[] => [...xs].sort();

  it('the lock table and the shared isPhase4 predicate are the same twelve keys', () => {
    expect(sorted(LOCK.map(([k]) => k))).toEqual(sorted(PHASE_4_KEYS));
    expect(LOCK).toHaveLength(12);
  });

  it('registers exactly the twelve Phase 4 keys, and no other key under their prefixes', () => {
    for (const key of PHASE_4_KEYS) expect(isPermission(key), key).toBe(true);
    expect(sorted(PERMISSIONS.filter((p) => /^(sales|customers|payments|refunds|receivables|installments)\./.test(p)))).toEqual(sorted(PHASE_4_KEYS));
  });

  it('the registry went from 46 keys to exactly 58, and every key belongs to a phase this suite knows', () => {
    expect(PERMISSIONS).toHaveLength(58);
    expect(PERMISSIONS.filter((p) => !isPhase4(p))).toHaveLength(46);
    // Totality: this is what keeps the per-phase re-expression from being a
    // loosening. Every registered key is claimed by exactly one phase, so a key
    // added under a prefix NO phase owns is red here even though it slips
    // through every phase-scoped filter above.
    const PHASE_1_2 = PERMISSIONS.filter((p) => !isPhase3(p) && !isPhase4(p));
    const claimed = new Set([...PHASE_1_2, ...PHASE_3, ...PHASE_4_KEYS]);
    expect(PERMISSIONS.filter((p) => !claimed.has(p))).toEqual([]);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    // And the Phase 1/2 residue is exactly the accepted 35 keys, so "no phase
    // owns it" cannot be laundered by calling a new key a Phase 1 key.
    expect(PHASE_1_2).toHaveLength(35);
  });

  it('the sensitivity column matches the lock row by row: six ordinary, six sensitive', () => {
    for (const [key, level] of LOCK) expect(isSensitivePermission(key as Permission), key).toBe(level === 'sensitive');
    expect(sorted(SENSITIVE_PERMISSIONS.filter(isPhase4))).toEqual(sorted(SENSITIVE));
    expect(ORDINARY).toHaveLength(6);
    expect(SENSITIVE).toHaveLength(6);
    // Every key the ruling forbids as a default is in fact classified sensitive.
    for (const key of FORBIDDEN_AS_DEFAULT) expect(isSensitivePermission(key as Permission), key).toBe(true);
  });

  it('owner: all twelve, by construction of the registry and by identity', () => {
    for (const key of PHASE_4_KEYS) expect(BUILTIN_ROLE_PERMISSIONS.owner).toContain(key);
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    for (const key of PHASE_4_KEYS) expect(hasPermission(owner, key as Permission), key).toBe(true);
  });

  it('manager: the accepted pre-Phase-4 list survives untouched, in order, with exactly the six ordinary keys appended', () => {
    // FULL exact equality on the whole array — nothing weaker than the
    // `toEqual` this slice re-expressed, only re-expressed per phase.
    expect([...BUILTIN_ROLE_PERMISSIONS.manager]).toEqual([...MANAGER_PRE_P4, ...MANAGER_PHASE_4]);
    expect(BUILTIN_ROLE_PERMISSIONS.manager.filter((p) => isPhase4(p))).toEqual(MANAGER_PHASE_4);
    expect(sorted(MANAGER_PHASE_4)).toEqual(sorted(ORDINARY));
  });

  it('cashier: the accepted ["catalog.view"] survives untouched, with exactly the four ordinary till keys appended', () => {
    expect([...BUILTIN_ROLE_PERMISSIONS.cashier]).toEqual([...CASHIER_PRE_P4, ...CASHIER_PHASE_4]);
    expect(BUILTIN_ROLE_PERMISSIONS.cashier.filter((p) => isPhase4(p))).toEqual(CASHIER_PHASE_4);
    // The narrowest thing a till needs: read, sell, see the customer, take money.
    for (const key of CASHIER_PHASE_4) expect(isSensitivePermission(key as Permission), key).toBe(false);
    // `receivables.view` is ordinary but is the second half of a CREDIT sale
    // (P4-AL-35), so it is a grant and not a default.
    expect(BUILTIN_ROLE_PERMISSIONS.cashier).not.toContain('receivables.view');
  });

  /**
   * The sensitive keys a built-in role already held when Phase 4 opened, byte
   * for byte. `role.assign` is a SENSITIVE permission (`permissions.ts:84`) and
   * is an ACCEPTED Phase 1 manager default (`permissions.ts:132`). That is an
   * accepted Phase 1 decision, not something Phase 4 may reopen, and the P4-S1
   * brief forbids altering the Phase 1 set. So the ruling's "no sensitive
   * default" is asserted here as an EXACT equality against this inventory
   * rather than against `[]`: a new sensitive default, in any phase, on any
   * built-in role, is red — and the accepted Phase 1 fact stays visible instead
   * of being silently absorbed.
   */
  const ACCEPTED_SENSITIVE_DEFAULTS: Record<'manager' | 'cashier', readonly string[]> = {
    manager: ['role.assign'],
    cashier: [],
  };

  it('OD-P4-01 OPTION A: Phase 4 adds no sensitive default to any built-in role, and the sensitive-default inventory is unchanged', () => {
    for (const roleKey of ['manager', 'cashier'] as const) {
      const defaults = BUILTIN_ROLE_PERMISSIONS[roleKey];
      // (a) every key the ruling names, over the whole registry.
      for (const key of FORBIDDEN_AS_DEFAULT) expect(defaults, `${roleKey} / ${key}`).not.toContain(key);
      // (b) "and any other sensitive permission", for the phases that added keys
      //     under a no-sensitive-default rule: Phase 3 (P3-AL-38) and Phase 4.
      expect(
        defaults.filter((p) => isSensitivePermission(p) && (isPhase3(p) || isPhase4(p))),
        roleKey,
      ).toEqual([]);
      // (c) exact equality on the whole sensitive-default inventory, so a new
      //     sensitive default under ANY prefix — including one no phase owns —
      //     turns this red.
      expect(
        defaults.filter((p) => isSensitivePermission(p)),
        roleKey,
      ).toEqual(ACCEPTED_SENSITIVE_DEFAULTS[roleKey]);
      const set = TrustedRoleSet.fromPersistence([{ key: roleKey, isSystem: true, permissions: new Set(defaults) }]);
      for (const key of SENSITIVE) expect(hasPermission(set, key as Permission), `${roleKey} / ${key}`).toBe(false);
    }
  });

  it('an existing custom role gains nothing from the twelve new registry entries', () => {
    const custom = TrustedRoleSet.fromPersistence([{ key: 'stock-clerk', isSystem: false, permissions: new Set(['catalog.view', 'catalog.update']) }]);
    for (const key of PHASE_4_KEYS) expect(hasPermission(custom, key as Permission), key).toBe(false);
  });

  it('delegation ceiling: a built-in role may pass on only what it holds', () => {
    const manager = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: true, permissions: new Set(BUILTIN_ROLE_PERMISSIONS.manager) }]);
    expect(beyondGrantAuthority(manager, MANAGER_PHASE_4 as Permission[])).toEqual([]);
    expect(beyondGrantAuthority(manager, SENSITIVE as Permission[])).toEqual(SENSITIVE);
    const cashier = TrustedRoleSet.fromPersistence([{ key: 'cashier', isSystem: true, permissions: new Set(BUILTIN_ROLE_PERMISSIONS.cashier) }]);
    expect(beyondGrantAuthority(cashier, CASHIER_PHASE_4 as Permission[])).toEqual([]);
    expect(beyondGrantAuthority(cashier, ['receivables.view', ...SENSITIVE] as Permission[])).toEqual(['receivables.view', ...SENSITIVE]);
    // A custom role that WAS delegated a sensitive key may pass that one on and
    // no other — the ceiling is what you hold, not who you are.
    const tillLead = TrustedRoleSet.fromPersistence([{ key: 'till-lead', isSystem: false, permissions: new Set(['sales.view', 'sales.discount']) }]);
    expect(beyondGrantAuthority(tillLead, ['sales.discount', 'sales.view'] as Permission[])).toEqual([]);
    expect(beyondGrantAuthority(tillLead, ['sales.void', 'refunds.approve'] as Permission[])).toEqual(['sales.void', 'refunds.approve']);
    // The system owner is exempt by identity, and only by identity.
    const owner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: true, permissions: new Set() }]);
    expect(beyondGrantAuthority(owner, PHASE_4_KEYS as Permission[])).toEqual([]);
    const fakeOwner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: false, permissions: new Set() }]);
    expect(beyondGrantAuthority(fakeOwner, PHASE_4_KEYS as Permission[])).toEqual([...PHASE_4_KEYS]);
  });

  it('every Phase 4 key satisfies the frozen operation-code regex (0054:53, 0054:229)', () => {
    // `customer_payment.*` is unbuildable: no underscore is allowed in the first
    // segment. Every Phase 4 first segment is a single lowercase word.
    const OP_CODE = /^[a-z]+(\.[a-z_]+)+$/;
    for (const key of PHASE_4_KEYS) expect(OP_CODE.test(key), key).toBe(true);
    expect(OP_CODE.test('customer_payment.collect')).toBe(false);
  });

  it('every Phase 4 sensitive permission is a registered permission', () => {
    for (const key of SENSITIVE) expect(isPermission(key), key).toBe(true);
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
