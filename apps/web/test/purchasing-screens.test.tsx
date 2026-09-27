import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '@/lib/i18n';
import type { ViewFixture } from '@/lib/phase3-format';
import { isNonZeroMinor, minorToMajorText, trimFractionZeros } from '@/views/common/amount-text';
import { VIEW_REGISTRY as COMMON } from '@/views/common/registry';
import { VIEW_REGISTRY as PURCHASES } from '@/views/purchases/registry';
import { elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * The purchasing screens, rendered at phone width through their registry
 * fixtures (P3-S7 contract §6 T-15/T-16 scope; A-11, A-13, A-19; Annex R #6,
 * #20, #21): what each screen offers, hides and says, in ar, en and tr.
 */
function fixture(view: string, name: string): ViewFixture {
  const entry = [...PURCHASES, ...COMMON].find((e) => e.name === view);
  const found = entry?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${view} / ${name}`);
  return found;
}

const render = (view: string, name: string, locale: Locale = 'en'): Rendered => renderFixture(fixture(view, name), locale);
const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const buttons = (r: Rendered): string[] => all(r, 'button').map(textOf);
const labels = (r: Rendered): string[] => all(r, 'label').map(textOf);
const options = (r: Rendered): string[] => all(r, 'option').map(textOf);
const text = (r: Rendered): string => textOf(r.frame);
const tr = (locale: Locale, key: string, vars?: Record<string, string>) => translate(locale, key, vars);

describe('Receive Purchase', () => {
  it('opens on the short form: no currency picker until "Different currency", no discount until asked', () => {
    const r = render('ReceivePurchaseView', 'new form, supplier and item search');
    expect(buttons(r)).toContain(tr('en', 'purchasing.receive.differentCurrency'));
    expect(labels(r)).not.toContain(tr('en', 'common.currency'));
    expect(buttons(r)).toContain(tr('en', 'purchasing.receive.addDiscount'));
    expect(buttons(r)).toContain(tr('en', 'purchasing.receive.addExtraCost'));
    expect(buttons(r)).not.toContain(tr('en', 'purchasing.receive.cancelDraft'));
  });

  it('offers exactly shipping, customs clearance and other as extra costs — no duty or tax preset (OD-03)', () => {
    for (const locale of ['ar', 'en', 'tr'] as const) {
      const r = render('ReceivePurchaseView', 'foreign currency, discount, extra costs split manually, field errors', locale);
      const kinds = ['shipping', 'customs', 'other'].map((k) => tr(locale, `purchasing.extraCost.kind.${k}`));
      for (const kind of kinds) expect(options(r)).toContain(kind);
      expect(text(r)).not.toMatch(/tax|vat|duty|ضريب|vergi|kdv/i);
    }
  });

  it('shows the duplicate-name hint without blocking the new supplier', () => {
    const r = render('ReceivePurchaseView', 'new supplier with a duplicate-name hint');
    expect(text(r)).toContain(tr('en', 'suppliers.duplicateName', { name: 'Al-Noor Trading' }));
    expect(buttons(r)).toContain(tr('en', 'purchasing.receive.addSupplier'));
  });

  it('review shows the server totals and "Paid now"; the settled amount is asked only in another currency', () => {
    const same = render('ReceivePurchaseView', 'review, paid now in the purchase currency');
    expect(text(same)).toContain(tr('en', 'purchasing.receive.total'));
    expect(all(same, 'button').some((b) => b.attrs['role'] === 'switch')).toBe(true);
    expect(labels(same).some((l) => l.startsWith('Amount this settles'))).toBe(false);
    expect(buttons(same)).toContain(tr('en', 'purchasing.receive.receiveAndPay'));

    const other = render('ReceivePurchaseView', 'review, paid now in the business currency');
    expect(labels(other)).toContain(tr('en', 'payments.amountSettles', { currency: 'USD' }));
  });

  it('offers only active payment methods, named in the viewer’s language, then Arabic (Annex R #20)', () => {
    const r = render('ReceivePurchaseView', 'review, paid now in the purchase currency');
    expect(options(r)).toContain('Cash');
    expect(options(r)).toContain('شيك');
    expect(options(r)).not.toContain('Old wallet');
    // The cheque method requires a reference: its label carries no "optional".
    expect(labels(r)).toContain(tr('en', 'payments.reference'));
  });

  it('without purchases.receive the review can be saved but not received', () => {
    const r = render('ReceivePurchaseView', 'review without permission to receive, no method yet');
    expect(buttons(r)).not.toContain(tr('en', 'purchasing.receive.receive'));
    expect(text(r)).toContain(tr('en', 'purchasing.receive.savedNoReceive'));
    expect(text(r)).toContain(tr('en', 'payments.noMethodYet'));
  });

  it('a missing exchange rate: the owner enters it inline; anyone else is told who can', () => {
    const owner = render('ReceivePurchaseView', 'missing exchange rate, owner can enter it');
    expect(buttons(owner)).toContain(tr('en', 'payments.exchangeRate.saveAndContinue'));
    const other = render('ReceivePurchaseView', 'missing exchange rate, ask the owner');
    expect(buttons(other)).not.toContain(tr('en', 'payments.exchangeRate.saveAndContinue'));
    expect(text(other)).toContain('Ask the business owner to add it');
  });

  it('the result shows the rate only for a foreign purchase, and the stock it covered', () => {
    const foreign = render('ReceivePurchaseView', 'received and paid, foreign, covered short stock');
    expect(text(foreign)).toContain('1 USD = 0.709 JOD');
    expect(text(foreign)).toContain('Covered 2.5 that was short');
    expect(text(foreign)).toContain(tr('en', 'purchasing.receive.paid'));
    const local = render('ReceivePurchaseView', 'received in the business currency');
    expect(text(local)).not.toContain('Exchange rate used');
    expect(text(local)).not.toContain(tr('en', 'purchasing.receive.paid'));
  });
});

describe('Purchase detail', () => {
  it('"Undo receipt" is absent, not disabled, unless the read says the server would accept it (TL-4, Annex R #21)', () => {
    const plain = render('PurchaseDetailView', 'received, part paid, returns and settlements');
    expect(buttons(plain)).not.toContain(tr('en', 'purchasing.detail.undoReceipt'));
    const offered = render('PurchaseDetailView', 'received, undo receipt offered and open');
    expect(buttons(offered)).toContain(tr('en', 'purchasing.detail.undoConfirm'));
    expect(text(offered)).toContain(tr('en', 'purchasing.detail.undoReasonRequired'));
  });

  it('shows settlements only with suppliers.view, and what is still to pay on a received purchase', () => {
    const withView = render('PurchaseDetailView', 'received, part paid, returns and settlements');
    expect(text(withView)).toContain(tr('en', 'purchasing.detail.favourUsedRow'));
    expect(text(withView)).toContain(tr('en', 'purchasing.detail.stillToPay'));
    const draft = render('PurchaseDetailView', 'draft, no settlements permission');
    expect(text(draft)).not.toContain(tr('en', 'purchasing.detail.payments'));
    expect(text(draft)).not.toContain(tr('en', 'purchasing.detail.stillToPay'));
    expect(buttons(draft)).toContain(tr('en', 'purchasing.detail.continueDraft'));
  });
});

describe('Return to Supplier', () => {
  it('has no amount field: quantities only', () => {
    const r = render('ReturnToSupplierView', 'quantities, one invalid');
    expect(labels(r).filter((l) => l === tr('en', 'purchasing.return.quantityToReturn'))).toHaveLength(2);
    expect(labels(r).some((l) => /amount/i.test(l))).toBe(false);
  });

  it.each(['supplier_inactive', 'nothing_left', 'not_received', 'reversed'])('says why nothing can go back (%s) before anything is filled in', (reason) => {
    const r = render('ReturnToSupplierView', `blocked: ${reason.replace('_', ' ')}`);
    expect(text(r)).toContain(tr('en', `purchasing.return.blocked.${reason}`));
    expect(all(r, 'input')).toHaveLength(0);
  });

  it('the result says the supplier now owes you, and/or that your balance went down — the server’s figures', () => {
    const both = render('ReturnToSupplierView', 'returned: credit and balance down');
    expect(text(both)).toMatch(/The supplier now owes you .*5\.00/);
    expect(text(both)).toMatch(/went down by .*4\.60/);
    const down = render('ReturnToSupplierView', 'returned: balance down only');
    expect(text(down)).not.toContain('now owes you');
  });
});

describe('amount text helpers (no arithmetic, digits moved only)', () => {
  it('re-spells minor units as major text at the currency precision', () => {
    expect(minorToMajorText('12500', 'USD')).toBe('125.00');
    expect(minorToMajorText('7', 'JOD')).toBe('0.007');
    expect(minorToMajorText('-1500', 'TRY')).toBe('-15.00');
    expect(minorToMajorText('12.5', 'USD')).toBe('12.5');
    expect(minorToMajorText('900719925474099399', 'USD')).toBe('9007199254740993.99');
  });

  it('answers "is there anything" by text', () => {
    expect(isNonZeroMinor('0')).toBe(false);
    expect(isNonZeroMinor('000')).toBe(false);
    expect(isNonZeroMinor('10')).toBe(true);
    expect(isNonZeroMinor(null)).toBe(false);
    expect(isNonZeroMinor('1.5')).toBe(false);
  });

  it('drops trailing fraction zeros of a quantity', () => {
    expect(trimFractionZeros('10.5000')).toBe('10.5');
    expect(trimFractionZeros('3.000')).toBe('3');
    expect(trimFractionZeros('40')).toBe('40');
  });
});
