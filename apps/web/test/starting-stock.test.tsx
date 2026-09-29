import { describe, expect, it } from 'vitest';
import type { InventoryAccessDto } from '@/lib/phase3-api';
import { translate } from '@/lib/i18n';
import { adjustReasons, openingPostedOf } from '@/views/stock/model';
import { VIEW_REGISTRY as STOCK_VIEWS } from '@/views/stock/registry';
import { elements, LOCALES, renderFixture, textOf, type Locale } from './helpers/render';

/**
 * TD-20 (directive §10): a business records its starting stock ONCE — the
 * server refuses a second opening for the whole business
 * (`inventory.opening_already_posted`, 0062). Once that opening is posted,
 * Adjust Stock must not offer an action the server can only refuse, and it
 * says plainly, in the merchant's language, what to do instead. The rule is
 * the server's: the screen reads `openingPosted` from `GET /v1/inventory/access`.
 */
const access = (over: Partial<InventoryAccessDto>): InventoryAccessDto => ({ businessWide: true, permissions: ['inventory.adjust'], ...over });

describe('which reasons Adjust Stock offers (TD-20)', () => {
  it('a business-wide member of a business with no opening yet may record starting stock', () => {
    expect(adjustReasons(true, false)).toEqual({ reasons: ['found', 'missing', 'damaged', 'starting'], startingRecorded: false });
  });

  it('once the business has its opening, starting stock is not offered and the screen says so', () => {
    expect(adjustReasons(true, true)).toEqual({ reasons: ['found', 'missing', 'damaged'], startingRecorded: true });
  });

  it('a member who does not reach every branch is never offered starting stock, and is not told about it', () => {
    expect(adjustReasons(false, false)).toEqual({ reasons: ['found', 'missing', 'damaged'], startingRecorded: false });
    expect(adjustReasons(false, true)).toEqual({ reasons: ['found', 'missing', 'damaged'], startingRecorded: false });
  });

  it('reads the server’s answer, and only a literal true closes the option', () => {
    expect(openingPostedOf(access({ openingPosted: true }))).toBe(true);
    expect(openingPostedOf(access({ openingPosted: false }))).toBe(false);
    expect(openingPostedOf(access({}))).toBe(false);
    expect(openingPostedOf(null)).toBe(false);
  });
});

const EXPLANATION: Readonly<Record<Locale, { business: string; found: string; missing: string }>> = {
  ar: { business: 'لهذا النشاط', found: 'وجدت زيادة', missing: 'مفقود' },
  en: { business: 'for this business', found: 'Found extra', missing: 'Missing' },
  tr: { business: 'Bu işletme', found: 'Fazla bulundu', missing: 'Kayıp' },
};

function renderAdjust(locale: Locale, fixture: string) {
  const found = STOCK_VIEWS.find((e) => e.name === 'AdjustStockView')?.fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${fixture}`);
  return renderFixture(found, locale);
}

const radios = (frame: ReturnType<typeof renderAdjust>['frame']) =>
  [...elements(frame)].filter((e) => e.tag === 'input' && e.attrs['type'] === 'radio').map((e) => e.attrs['value']);

describe('Adjust Stock once starting stock is recorded (TD-20), in ar, en and tr', () => {
  for (const locale of LOCALES) {
    it(`${locale}: no "Starting stock" choice, and a plain explanation naming the business-wide rule and the way to correct`, () => {
      const r = renderAdjust(locale, 'starting stock already recorded for the business');
      expect(r.missingKeys).toEqual([]);
      expect(radios(r.frame)).toEqual(['found', 'missing', 'damaged']);
      const text = textOf(r.frame);
      expect(text).not.toContain(translate(locale, 'stock.adjust.reason.startingHint'));
      const note = translate(locale, 'stock.adjust.startingRecorded');
      expect(text).toContain(note);
      const want = EXPLANATION[locale];
      for (const part of [want.business, want.found, want.missing]) expect(note).toContain(part);
    });

    it(`${locale}: with no opening yet the choice is there and no explanation is shown`, () => {
      const r = renderAdjust(locale, 'starting stock asks a cost on every line');
      expect(radios(r.frame)).toContain('starting');
      expect(textOf(r.frame)).not.toContain(translate(locale, 'stock.adjust.startingRecorded'));
    });

    it(`${locale}: the refusal names the business, not an item, and the way to correct`, () => {
      const refusal = translate(locale, 'error.inventory.opening_already_posted');
      const want = EXPLANATION[locale];
      for (const part of [want.business, want.found, want.missing]) expect(refusal).toContain(part);
      expect(refusal).not.toMatch(/this item|لهذا المنتج|Bu ürün/);
    });
  }

  it('the explanation is a hint, not a control: nothing to press', () => {
    const r = renderAdjust('en', 'starting stock already recorded for the business');
    const note = translate('en', 'stock.adjust.startingRecorded');
    const holders = [...elements(r.frame)].filter((e) => textOf(e) === note);
    expect(holders.length).toBeGreaterThan(0);
    for (const h of holders) expect(['button', 'a', 'label']).not.toContain(h.tag);
  });
});
