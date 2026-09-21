import { describe, expect, it } from 'vitest';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '../src/money';

/**
 * Money contract (Stabilization Part S §97; Completion Directive §34–36):
 * exact decimal parsing, very large values, no float ever, ONE currency
 * registry (domain-core) behind every client-facing helper.
 */
describe('money contract', () => {
  it('parses 3-decimal currencies exactly (JOD)', () => {
    expect(parseMajorToMinor('1.234', 3)).toBe('1234');
    expect(parseMajorToMinor('12', 3)).toBe('12000');
    expect(parseMajorToMinor('0.001', 3)).toBe('1');
  });

  it('parses 2-decimal currencies exactly (ILS/TRY/USD)', () => {
    expect(parseMajorToMinor('12.34', 2)).toBe('1234');
    expect(parseMajorToMinor('0.10', 2)).toBe('10');
    expect(parseMajorToMinor('100', 2)).toBe('10000');
  });

  it('parses 0-decimal scales', () => {
    expect(parseMajorToMinor('1500', 0)).toBe('1500');
    expect(() => parseMajorToMinor('1.5', 0)).toThrow();
  });

  it('rejects more precision than the currency supports — never rounds silently', () => {
    expect(() => parseMajorToMinor('1.2345', 3)).toThrow();
    expect(() => parseMajorToMinor('1.999', 2)).toThrow();
  });

  it('rejects non-decimal input', () => {
    expect(() => parseMajorToMinor('abc', 2)).toThrow();
    expect(() => parseMajorToMinor('1.2.3', 2)).toThrow();
    expect(() => parseMajorToMinor('', 2)).toThrow();
  });

  it('handles very large values beyond float safety', () => {
    expect(parseMajorToMinor('9007199254740993.99', 2)).toBe('900719925474099399');
  });

  it('formats minor units as a localized major amount, never the raw integer', () => {
    const jod = formatMinor('1234', 'JOD', 'en');
    expect(jod).toContain('1.234');
    expect(jod).not.toBe('1234');
    const ils = formatMinor('1234', 'ILS', 'en');
    expect(ils).toContain('12.34');
  });

  const digits = (s: string) => s.replace(/[^0-9]/g, '');
  const toAscii = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

  it('§36 TEST LARGE MONEY: values above the JS safe integer keep exact digits in every locale', () => {
    for (const minor of ['900719925474099399', '999999999999999999', '9007199254740993']) {
      for (const currency of ['ILS', 'JOD', 'TRY', 'USD']) {
        for (const locale of ['en', 'ar', 'tr']) {
          const out = formatMinor(minor, currency, locale);
          expect(digits(toAscii(out)), `${minor} ${currency} ${locale} → ${out}`).toBe(minor);
          // The fraction is exactly the currency's minor units — never float noise.
          const frac = minor.slice(-minorUnitsOf(currency));
          expect(
            toAscii(out)
              .replace(/[^0-9]/g, '')
              .endsWith(frac),
          ).toBe(true);
        }
      }
    }
  });

  it('formats negative values without touching Number', () => {
    const out = formatMinor('-900719925474099399', 'USD', 'en');
    expect(digits(out)).toBe('900719925474099399');
    expect(out).toMatch(/[-−]/);
  });

  it('minor units come from the domain-core registry — no second table', () => {
    expect(minorUnitsOf('JOD')).toBe(3);
    expect(minorUnitsOf('USD')).toBe(2);
    expect(minorUnitsOf('TRY')).toBe(2);
    expect(minorUnitsOf('ILS')).toBe(2);
    expect(() => minorUnitsOf('KWD')).toThrow(/Unsupported currency/);
    expect(() => minorUnitsOf('JPY')).toThrow(/Unsupported currency/);
  });
});
