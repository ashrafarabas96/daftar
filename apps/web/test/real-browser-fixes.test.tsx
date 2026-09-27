import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { List } from '@daftar/design-system';
import { formatMoney, formatQty, formatUnitPrice } from '@/lib/phase3-format';

/**
 * Fixes from the real-browser run of the S7 screens (Chromium against
 * `next start` and the real API): D-5 (quantity and unit-price spelling) and
 * D-9 (a clickable list row is reachable and operable from the keyboard).
 */

describe('D-5 — a quantity drops insignificant zeros; a unit price reads like the totals', () => {
  it('a piece item the server sends at four places reads as a whole number; nothing is ever rounded', () => {
    expect(formatQty('8.0000', 0, 'en')).toBe('8');
    expect(formatQty('8.0000', 0, 'ar')).toBe('8');
    expect(formatQty('-3.0000', 0, 'en')).toBe('-3');
    expect(formatQty('12.5000', 2, 'tr')).toBe('12,50');
    expect(formatQty('12.5', 3, 'en')).toBe('12.500');
    expect(formatQty('1234.0000', 0, 'en')).toBe('1,234');
    // A significant digit beyond the unit's decimals stays: re-spelled, never rounded.
    expect(formatQty('1.2345', 2, 'en')).toBe('1.2345');
    expect(formatQty('1.2300', 2, 'en')).toBe('1.23');
    expect(formatQty('abc', 0, 'en')).toBe('abc');
  });

  it('a unit price at the currency precision is spelled exactly as formatMoney spells that amount', () => {
    for (const locale of ['ar', 'en', 'tr'] as const) {
      expect(formatUnitPrice('31.5', 'ILS', locale), locale).toBe(formatMoney('3150', 'ILS', locale));
      expect(formatUnitPrice('31.5000', 'ILS', locale), locale).toBe(formatMoney('3150', 'ILS', locale));
      expect(formatUnitPrice('1250', 'ILS', locale), locale).toBe(formatMoney('125000', 'ILS', locale));
      expect(formatUnitPrice('0.709', 'JOD', locale), locale).toBe(formatMoney('709', 'JOD', locale));
      expect(formatUnitPrice('3.20', 'USD', locale), locale).not.toContain('USD');
    }
    expect(formatUnitPrice('31.50', 'ILS', 'en')).toBe('₪31.50');
    expect(formatUnitPrice('3.200', 'USD', 'tr')).toBe('$3,20');
  });

  it('a unit price finer than the currency keeps its significant digits, and a malformed one stays visible', () => {
    expect(formatUnitPrice('0.12345', 'ILS', 'en')).toBe('₪0.12345');
    expect(formatUnitPrice('0.12340', 'ILS', 'tr')).toBe('₪0,1234');
    expect(formatUnitPrice('n/a', 'ILS', 'en')).toBe('n/a ILS');
  });
});

/** Every element of a rendered tree whose props match. */
function find(node: ReactNode, match: (props: Record<string, unknown>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (!isValidElement<Record<string, unknown>>(n)) return;
    if (match(n.props)) out.push(n);
    const children: unknown = n.props['children'];
    if (Array.isArray(children)) for (const c of children) walk(c as ReactNode);
    else if (children !== undefined) walk(children as ReactNode);
  };
  walk(node);
  return out;
}

describe('D-9 — a clickable list row is a button to the keyboard', () => {
  const clicks: string[] = [];
  const tree = List({
    items: [
      { key: 'a', primary: 'Al-Quds Trading Co.', onClick: () => clicks.push('a') },
      { key: 'b', primary: 'Read-only row' },
    ],
  });

  it('renders a focusable role=button inside the list item; a row without onClick stays plain', () => {
    const html = renderToStaticMarkup(tree);
    expect(html).toMatch(/<li[^>]*><div role="button" tabindex="0"[^>]*>.*Al-Quds Trading Co\./);
    expect((html.match(/role="button"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<li[^>]*><span[^>]*><span[^>]*>Read-only row/);
  });

  it('Enter and Space activate it (Space without scrolling); other keys and keys from inside do not', () => {
    const [row] = find(tree, (p) => p['role'] === 'button');
    const onKeyDown = row?.props['onKeyDown'];
    if (typeof onKeyDown !== 'function') throw new Error('the row has no keyboard handler');
    const press = (key: string, fromInside = false) => {
      let prevented = false;
      const self = {};
      onKeyDown({ key, target: fromInside ? {} : self, currentTarget: self, preventDefault: () => (prevented = true) });
      return prevented;
    };
    clicks.length = 0;
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
    expect(press('a')).toBe(false);
    expect(press('Enter', true)).toBe(false);
    expect(clicks).toEqual(['a', 'a']);
  });
});
