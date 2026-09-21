import { describe, expect, it } from 'vitest';
import { API_VERSION, LOCALES, type Page, type ProductListItemDto } from '../src';

describe('shared contracts (§30)', () => {
  it('API is versioned', () => {
    expect(API_VERSION).toBe('v1');
  });
  it('locales are exactly ar/en/tr', () => {
    expect([...LOCALES]).toEqual(['ar', 'en', 'tr']);
  });
  it('money fields are string-typed (bigint-safe over JSON)', () => {
    const item: ProductListItemDto = {
      id: 'x',
      name: 'n',
      sku: null,
      basePriceMinor: '999999999999999999',
      priceCurrency: 'JOD',
      status: 'active',
    };
    const page: Page<ProductListItemDto> = { items: [item], nextCursor: null };
    expect(typeof page.items[0]?.basePriceMinor).toBe('string');
  });
});
