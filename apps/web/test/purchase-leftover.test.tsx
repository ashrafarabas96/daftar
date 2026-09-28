import { describe, expect, it } from 'vitest';
import { translate } from '@/lib/i18n';
import { isLeftoverOnly } from '@/views/common/amount-text';
import { purchaseDetailActions, type PurchaseDetailFacts } from '@/views/purchases/detail-actions';
import { VIEW_REGISTRY as PURCHASE_VIEWS } from '@/views/purchases/registry';
import { elements, LOCALES, renderFixture, textOf, type Locale } from './helpers/render';

/**
 * TD-16 (directive §3) from the merchant's side: a purchase whose remaining
 * amount is smaller than the smallest coin of the business's currency can be
 * neither paid nor returned against. The purchase screen then offers ONE plain
 * action to close that leftover, behind a confirmation, instead of a "Pay"
 * the server can only refuse. The server decides: the screen reads the
 * purchase's payable (`outstandingTxnMinor` > 0 and `outstandingBaseMinor`
 * = 0) and the write-off command re-checks everything.
 */
describe('which amount is a leftover', () => {
  it('is a leftover only when something is owed in the purchase currency and nothing in the business currency', () => {
    expect(isLeftoverOnly({ outstandingTxnMinor: '11', outstandingBaseMinor: '0' })).toBe(true);
    expect(isLeftoverOnly({ outstandingTxnMinor: '0', outstandingBaseMinor: '0' })).toBe(false);
    expect(isLeftoverOnly({ outstandingTxnMinor: '1100', outstandingBaseMinor: '4' })).toBe(false);
    expect(isLeftoverOnly({ outstandingTxnMinor: '11', outstandingBaseMinor: '1' })).toBe(false);
    expect(isLeftoverOnly({ outstandingTxnMinor: '-11', outstandingBaseMinor: '0' })).toBe(false);
    expect(isLeftoverOnly({ outstandingTxnMinor: 'x', outstandingBaseMinor: '0' })).toBe(false);
    expect(isLeftoverOnly(null)).toBe(false);
  });
});

const facts = (over: Partial<PurchaseDetailFacts>): PurchaseDetailFacts => ({
  status: 'received',
  returnable: false,
  reversible: false,
  payable: { outstandingTxnMinor: '11', outstandingBaseMinor: '0' },
  businessWide: true,
  can: () => true,
  ...over,
});

describe('the purchase screen’s actions (TD-16)', () => {
  it('a leftover: "Close the leftover" instead of "Pay", which the server would refuse', () => {
    const a = purchaseDetailActions(facts({}));
    expect(a.closeLeftover).toBe(true);
    expect(a.paySupplier).toBe(false);
  });

  it('a payable amount: "Pay", and no leftover action', () => {
    const a = purchaseDetailActions(facts({ payable: { outstandingTxnMinor: '1100', outstandingBaseMinor: '4' } }));
    expect(a.paySupplier).toBe(true);
    expect(a.closeLeftover).toBe(false);
  });

  it('nothing owed: neither', () => {
    const a = purchaseDetailActions(facts({ payable: { outstandingTxnMinor: '0', outstandingBaseMinor: '0' } }));
    expect(a.paySupplier).toBe(false);
    expect(a.closeLeftover).toBe(false);
  });

  it('only a business-wide holder of suppliers.pay is offered the close (the server authorizes it business-wide)', () => {
    expect(purchaseDetailActions(facts({ businessWide: false })).closeLeftover).toBe(false);
    expect(purchaseDetailActions(facts({ can: (p) => p !== 'suppliers.pay' })).closeLeftover).toBe(false);
  });

  it('never on a purchase that is not received', () => {
    for (const status of ['draft', 'cancelled', 'reversed'] as const) expect(purchaseDetailActions(facts({ status })).closeLeftover).toBe(false);
  });
});

function render(fixture: string, locale: Locale) {
  const found = PURCHASE_VIEWS.find((e) => e.name === 'PurchaseDetailView')?.fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${fixture}`);
  return renderFixture(found, locale);
}
const buttons = (r: ReturnType<typeof render>): string[] => [...elements(r.frame)].filter((e) => e.tag === 'button').map((e) => textOf(e));

describe('Close the leftover, in ar, en and tr', () => {
  for (const locale of LOCALES) {
    const T = (key: string) => translate(locale, key);

    it(`${locale}: one plain action, and no Pay`, () => {
      const r = render('received, a leftover smaller than the smallest coin', locale);
      expect(r.missingKeys).toEqual([]);
      expect(buttons(r)).toContain(T('purchasing.detail.leftoverClose'));
      expect(buttons(r)).not.toContain(T('payments.title'));
      expect(textOf(r.frame)).toContain(T('purchasing.detail.leftoverHint'));
    });

    it(`${locale}: the confirmation says what happens, asks why, and can be cancelled`, () => {
      const r = render('received, closing the leftover', locale);
      expect(r.missingKeys).toEqual([]);
      const text = textOf(r.frame);
      expect(text).toContain(T('purchasing.detail.leftoverTitle'));
      expect(text).toContain(T('purchasing.detail.leftoverExplain'));
      expect(text).toContain(T('purchasing.detail.leftoverReasonRequired'));
      expect(buttons(r)).toEqual(expect.arrayContaining([T('purchasing.detail.leftoverConfirm'), T('common.cancel')]));
    });

    it(`${locale}: once closed, it says so and offers nothing more`, () => {
      const r = render('leftover closed', locale);
      expect(r.missingKeys).toEqual([]);
      expect(textOf(r.frame)).toContain(T('purchasing.detail.leftoverClosed'));
      expect(buttons(r)).not.toContain(T('purchasing.detail.leftoverClose'));
    });

    it(`${locale}: an ordinary purchase shows no leftover action`, () => {
      const r = render('received, part paid, returns and settlements', locale);
      expect(buttons(r)).not.toContain(T('purchasing.detail.leftoverClose'));
      expect(textOf(r.frame)).not.toContain(T('purchasing.detail.leftoverHint'));
    });
  }
});
