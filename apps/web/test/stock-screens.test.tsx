import { describe, expect, it } from 'vitest';
import type { InventoryItemDto } from '@/lib/phase3-api';
import { VIEW_REGISTRY as CATALOG_VIEWS } from '@/views/catalog/registry';
import { VIEW_REGISTRY as STOCK_VIEWS } from '@/views/stock/registry';
import { VIEW_REGISTRY as STRUCTURE_VIEWS } from '@/views/structure/registry';
import { draftLineOf, isNegativeText, itemOptions, lineQuantityErrors, trimQtyText } from '@/views/stock/model';
import { elements, LOCALES, renderFixture, textOf, type Locale, type Rendered } from './helpers/render';
import { loadViewRegistries } from './helpers/render';
import type { ViewEntry } from '@/lib/phase3-format';

/**
 * The inventory screens of P3-S7 (A-07, A-08, A-11, A-13; TL-4, TL-7, TL-8),
 * screen by screen, on their registry fixtures: what each shows, and what it
 * must not. The layout law (T-15), the mirror (T-16) and the hidden values
 * (T-08) run over the same fixtures in their own suites.
 */
function render(entries: readonly ViewEntry[], view: string, fixture: string, locale: Locale = 'en'): Rendered {
  const found = entries.find((e) => e.name === view)?.fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${view} / ${fixture}`);
  return renderFixture(found, locale);
}
const text = (r: Rendered): string => textOf(r.frame);
const labels = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'label').map((e) => textOf(e));
const buttons = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'button').map((e) => textOf(e));

describe('the inventory view registries', () => {
  it('register every stock, catalog and structure view, each with fixtures', async () => {
    const areas = await loadViewRegistries();
    const names = (area: string) => areas.find((a) => a.area === area)?.entries.map((e) => e.name) ?? [];
    expect(names('stock')).toEqual(['StockLevelsView', 'MoveStockView', 'AdjustStockView', 'CountListView', 'CountSheetView', 'ScreenState']);
    expect(names('catalog')).toEqual(['TrackingCard']);
    expect(names('structure')).toEqual(['WarehouseBranches']);
    for (const entry of [...STOCK_VIEWS, ...CATALOG_VIEWS, ...STRUCTURE_VIEWS]) expect(entry.fixtures.length, entry.name).toBeGreaterThan(0);
  });

  it('every fixture renders in ar, en and tr with no missing key', () => {
    for (const entry of [...STOCK_VIEWS, ...CATALOG_VIEWS, ...STRUCTURE_VIEWS]) {
      for (const fixture of entry.fixtures) {
        for (const locale of LOCALES) expect(renderFixture(fixture, locale).missingKeys, `${entry.name}/${fixture.name} ${locale}`).toEqual([]);
      }
    }
  });
});

describe('Stock (A-07, TL-7)', () => {
  const r = render(STOCK_VIEWS, 'StockLevelsView', 'rows in stock, out of stock, short, with options and stock from before options');

  it('reads a negative on-hand as "Short by", zero as out of stock, and never says "deficit"', () => {
    expect(text(r)).toContain('Short by 3');
    expect(text(r)).toContain('Out of stock');
    expect(text(render(STOCK_VIEWS, 'StockLevelsView', 'rows in stock, out of stock, short, with options and stock from before options', 'ar'))).toContain(
      'ناقص 3',
    );
    expect(text(render(STOCK_VIEWS, 'StockLevelsView', 'rows in stock, out of stock, short, with options and stock from before options', 'tr'))).toContain(
      '3 eksik',
    );
    expect(text(r).toLowerCase()).not.toContain('deficit');
  });

  it('shows the quantity at the unit precision, isolated left-to-right', () => {
    expect(r.html).toContain('<bdi dir="ltr">1,234.500</bdi>');
    expect(render(STOCK_VIEWS, 'StockLevelsView', 'rows in stock, out of stock, short, with options and stock from before options', 'tr').html).toContain(
      '<bdi dir="ltr">1.234,500</bdi>',
    );
  });

  it('lists options by name, and stock from before the options under the item name alone', () => {
    expect(text(r)).toContain('ShirtRed / M');
    expect(text(r)).toContain('ShirtBlue / L');
    // The shirt appears three times: two options and the stock it had before options.
    expect(text(r).match(/Shirt/g)).toHaveLength(3);
  });

  it('offers only the actions the member holds, and only active warehouses', () => {
    expect(buttons(r)).toEqual(expect.arrayContaining(['Move Stock', 'Count Stock', 'Adjust Stock']));
    const none = render(STOCK_VIEWS, 'StockLevelsView', 'loading');
    expect(buttons(none)).not.toContain('Move Stock');
    expect(r.html).not.toContain('Old depot');
  });
});

describe('Move Stock (A-13)', () => {
  it('asks from, to and lines, and shows what is here now at the source', () => {
    const r = render(STOCK_VIEWS, 'MoveStockView', 'two lines, one with a bad quantity');
    expect(labels(r)).toEqual(expect.arrayContaining(['From warehouse', 'To warehouse', 'Quantity to move']));
    expect(text(r)).toContain('Here now:');
    expect(text(r)).toContain('Enter a quantity this unit allows');
  });

  it('shows what the server says arrived — quantities only, never a value', () => {
    const r = render(STOCK_VIEWS, 'MoveStockView', 'moved: the server answer');
    expect(text(r)).toContain('Moved from Main store to Back room.');
    expect(r.html).toContain('<bdi dir="ltr">5</bdi>');
    expect(r.html).toContain('<bdi dir="ltr">2.500</bdi>');
    expect(r.html).not.toContain('98765431');
    expect(r.html).not.toContain('-5');
  });
});

describe('Adjust Stock (A-13, TL-4)', () => {
  it('asks a cost only on the line the server named, for extra stock', () => {
    const r = render(STOCK_VIEWS, 'AdjustStockView', 'found extra: the server asked a cost on one line');
    expect(labels(r).filter((l) => l.startsWith('Cost per unit'))).toEqual(['Cost per unit (SAR)']);
    expect(text(r)).toContain('A cost per unit is needed for new stock.');
  });

  it('never asks a cost for missing or damaged stock, and offers "Starting stock" only to a business-wide member', () => {
    const missing = render(STOCK_VIEWS, 'AdjustStockView', 'missing, member without starting stock');
    expect(labels(missing).some((l) => l.startsWith('Cost per unit'))).toBe(false);
    expect(text(missing)).not.toContain('Starting stock');
    expect(labels(missing)).toContain('Quantity to take off');
    const damaged = render(STOCK_VIEWS, 'AdjustStockView', 'damaged');
    expect(labels(damaged).some((l) => l.startsWith('Cost per unit'))).toBe(false);
  });

  it('asks a cost on every line of starting stock', () => {
    const r = render(STOCK_VIEWS, 'AdjustStockView', 'starting stock asks a cost on every line');
    expect(text(r)).toContain('Starting stock');
    expect(labels(r).filter((l) => l.startsWith('Cost per unit'))).toHaveLength(1);
  });

  it('shows the recorded change as added / taken off, never a value or a posting', () => {
    const r = render(STOCK_VIEWS, 'AdjustStockView', 'recorded: the server answer');
    expect(text(r)).toContain('3 added');
    expect(text(r)).toContain('0.250 taken off');
    expect(r.html).not.toContain('98765431');
    expect(text(render(STOCK_VIEWS, 'AdjustStockView', 'starting stock recorded'))).toContain('Your starting stock is recorded.');
  });
});

describe('Count Stock (A-08, TL-8)', () => {
  it('a blind count shows no expected quantity and its picker no stock, in any locale', () => {
    for (const locale of LOCALES) {
      const r = render(STOCK_VIEWS, 'CountSheetView', 'blind count in progress', locale);
      expect(text(r)).not.toMatch(/Expected|المتوقع|Beklenen/);
      expect(text(r)).not.toMatch(/Here now|الموجود الآن|Şu an burada/);
    }
  });

  it('shows the expected quantity only when the server returned it', () => {
    const r = render(STOCK_VIEWS, 'CountSheetView', 'count with expected quantities and a cost asked');
    expect(text(r)).toContain('Expected 12 Piece');
    expect(labels(r).filter((l) => l.startsWith('Cost per unit'))).toEqual(['Cost per unit (SAR)']);
  });

  it('after finishing, says how each line compared', () => {
    const r = render(STOCK_VIEWS, 'CountSheetView', 'finished: how each line compared');
    expect(text(r)).toContain('1 fewer than expected');
    expect(text(r)).toContain('2 more than expected');
    expect(text(r)).toContain('As expected');
    expect(r.frame.children.length).toBeGreaterThan(0);
    expect(buttons(r)).not.toContain('Finish the count');
  });

  it('a member who may only look sees the counts but cannot enter any', () => {
    const r = render(STOCK_VIEWS, 'CountSheetView', 'view only');
    expect([...elements(r.frame)].filter((e) => e.tag === 'input')).toEqual([]);
    expect(buttons(render(STOCK_VIEWS, 'CountListView', 'view only'))).not.toContain('Continue the open count');
  });

  it('the list offers to continue the open count, or to start one', () => {
    expect(buttons(render(STOCK_VIEWS, 'CountListView', 'an open count and earlier ones'))).toContain('Continue the open count');
    expect(buttons(render(STOCK_VIEWS, 'CountListView', 'no count yet'))).toContain('Start a count');
  });

  it('cancelling asks first', () => {
    const r = render(STOCK_VIEWS, 'CountSheetView', 'cancelling asks first');
    expect([...elements(r.frame)].some((e) => e.attrs['role'] === 'dialog')).toBe(true);
    expect(buttons(r)).toEqual(expect.arrayContaining(['Cancel the count', 'Keep counting']));
  });
});

describe('Track stock (A-06) and warehouse reach (A-05)', () => {
  it('warns ahead of time that a unit change needs zero stock, and shows the refusal', () => {
    const r = render(CATALOG_VIEWS, 'TrackingCard', 'tracked, holds stock, refused a unit change');
    expect(text(r)).toContain('bring its stock to zero first');
    expect(text(r)).toContain("The unit can't be changed while the item has stock.");
  });

  it('a warehouse always serves its own branch: no control there; archived warehouses are not offered', () => {
    const r = render(STRUCTURE_VIEWS, 'WarehouseBranches', 'a warehouse serving two branches');
    expect(text(r)).toContain('Own branch');
    expect(buttons(r)).toEqual(['Stop serving', 'Serve this branch', 'Serve this branch', 'Serve this branch']);
    expect(r.html).not.toContain('Old depot');
  });
});

describe('the stock screen helpers (text only, A-17)', () => {
  it('trims only fraction zeros beyond the unit precision, never rounds', () => {
    expect(trimQtyText('5.0000', 0)).toBe('5');
    expect(trimQtyText('2.5000', 3)).toBe('2.500');
    expect(trimQtyText('0.1234', 2)).toBe('0.1234');
    expect(trimQtyText('-3.0000', 0)).toBe('-3');
    expect(isNegativeText(' -0.5')).toBe(true);
    expect(isNegativeText('0.5')).toBe(false);
  });

  it('item options never offer the base variant, archived items or options, or untracked items', () => {
    const item = (over: Partial<InventoryItemDto>): InventoryItemDto => ({
      productId: 'p1',
      name: 'Item',
      status: 'active',
      trackInventory: true,
      unitCode: 'piece',
      unitDecimals: 0,
      holdsStock: false,
      variants: [],
      ...over,
    });
    const options = itemOptions([
      item({ productId: 'simple' }),
      item({
        productId: 'shirt',
        variants: [
          { variantId: 'red', name: 'Red', status: 'active' },
          { variantId: 'old', name: 'Old', status: 'archived' },
        ],
      }),
      item({ productId: 'gone', status: 'archived' }),
      item({ productId: 'untracked', trackInventory: false, unitCode: null, unitDecimals: null }),
    ]);
    expect(options.map((o) => [o.productId, o.variantId, o.onHand])).toEqual([
      ['simple', null, null],
      ['shirt', 'red', null],
    ]);
  });

  it('checks a typed quantity by its shape and the unit precision, zero only where allowed', () => {
    const [simple] = itemOptions([
      { productId: 'p', name: 'Rice', status: 'active', trackInventory: true, unitCode: 'kg', unitDecimals: 3, holdsStock: false, variants: [] },
    ]);
    if (!simple) throw new Error('no option');
    const line = (quantity: string, key: string) => ({ ...draftLineOf(simple, key), quantity });
    const lines = [line('1.250', 'a'), line('١٫٥', 'b'), line('1.2345', 'c'), line('0', 'd'), line('-1', 'e'), line('', 'f')];
    expect(lineQuantityErrors(lines, false)).toEqual({
      c: 'stock.line.quantityInvalid',
      d: 'stock.line.quantityZero',
      e: 'stock.line.quantityInvalid',
      f: 'stock.line.quantityInvalid',
    });
    expect(lineQuantityErrors(lines, true)).toEqual({ c: 'stock.line.quantityInvalid', e: 'stock.line.quantityInvalid', f: 'stock.line.quantityInvalid' });
  });
});
