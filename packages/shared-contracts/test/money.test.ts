import { describe, expect, it } from 'vitest';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '../src/money';

/**
 * Money contract (Stabilization Part S §97): exact decimal parsing across
 * 0/2/3-decimal currencies, very large values, no float ever.
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

  it('parses 0-decimal currencies (JPY)', () => {
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
    const jpy = formatMinor('1500', 'JPY', 'en');
    expect(jpy).toContain('1,500');
  });

  it('knows the minor units of supported currencies', () => {
    expect(minorUnitsOf('JOD')).toBe(3);
    expect(minorUnitsOf('KWD')).toBe(3);
    expect(minorUnitsOf('USD')).toBe(2);
    expect(minorUnitsOf('TRY')).toBe(2);
    expect(minorUnitsOf('ILS')).toBe(2);
    expect(minorUnitsOf('JPY')).toBe(0);
  });
});
