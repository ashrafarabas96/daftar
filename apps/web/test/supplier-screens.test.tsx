import { describe, expect, it } from 'vitest';
import type { PaymentMethodDto } from '@daftar/shared-contracts';
import { makeT, translate, type Locale } from '@/lib/i18n';
import type { ViewFixture } from '@/lib/phase3-format';
import { activeMethodChoices } from '@/views/common/payment-methods';
import { VIEW_REGISTRY as SUPPLIERS } from '@/views/suppliers/registry';
import { elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * The supplier screens, rendered at phone width through their registry
 * fixtures (P3-S7 contract §6 T-15/T-16 scope; A-12, A-17, A-18; Annex R #20):
 * balances, Pay Supplier's proposal, the first way to pay, the balance in your
 * favour and getting money back — in ar, en and tr.
 */
function fixture(view: string, name: string): ViewFixture {
  const found = SUPPLIERS.find((e) => e.name === view)?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${view} / ${name}`);
  return found;
}

const render = (view: string, name: string, locale: Locale = 'en'): Rendered => renderFixture(fixture(view, name), locale);
const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const buttons = (r: Rendered): string[] => all(r, 'button').map(textOf);
const labels = (r: Rendered): string[] => all(r, 'label').map(textOf);
const text = (r: Rendered): string => textOf(r.frame);
const tr = (locale: Locale, key: string, vars?: Record<string, string>) => translate(locale, key, vars);
const button = (r: Rendered, label: string): ElementNode => {
  const found = all(r, 'button').find((b) => textOf(b) === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
};
const isDisabled = (b: ElementNode): boolean => 'disabled' in b.attrs;

describe('Suppliers', () => {
  it('shows balances and the owed-only filter to a business-wide caller only', () => {
    const wide = render('SupplierListView', 'business-wide, with balances');
    expect(labels(wide)).toContain(tr('en', 'suppliers.list.owedOnly'));
    expect(text(wide)).toContain(tr('en', 'suppliers.balance.youOwe'));
    expect(text(wide)).toContain(tr('en', 'suppliers.balance.inYourFavour'));
    expect(text(wide)).toContain(tr('en', 'suppliers.balance.settled'));
    const assigned = render('SupplierListView', 'assigned scope, plain list');
    expect(labels(assigned)).not.toContain(tr('en', 'suppliers.list.owedOnly'));
    expect(text(assigned)).not.toContain(tr('en', 'suppliers.balance.youOwe'));
  });

  it('the detail hides balances, payments and Pay from an assigned-scope caller', () => {
    const wide = render('SupplierDetailView', 'business-wide, owes and in your favour');
    expect(buttons(wide)).toContain(tr('en', 'payments.title'));
    expect(text(wide)).toContain(tr('en', 'suppliers.detail.payments'));
    const assigned = render('SupplierDetailView', 'assigned scope');
    expect(buttons(assigned)).not.toContain(tr('en', 'payments.title'));
    expect(text(assigned)).not.toContain(tr('en', 'suppliers.balance.youOwe'));
    expect(text(assigned)).not.toContain(tr('en', 'suppliers.detail.payments'));
  });

  it('getting money back received in another currency asks for the currency and the amount received', () => {
    const r = render('SupplierDetailView', 'get money back, received in another currency');
    expect(labels(r)).toContain(tr('en', 'suppliers.moneyBack.receivedIn'));
    expect(labels(r)).toContain(tr('en', 'suppliers.moneyBack.receivedAmount', { currency: 'JOD' }));
    expect(labels(r)).toContain(tr('en', 'suppliers.moneyBack.receivedBy'));
  });
});

describe('Pay Supplier', () => {
  it('pays only what the proposal placed: an amount no open purchase can take blocks Pay', () => {
    const fits = render('PaySupplierView', 'proposal, other-currency purchase not paid');
    expect(isDisabled(button(fits, tr('en', 'payments.submit')))).toBe(false);
    const larger = render('PaySupplierView', 'amount larger than what is owed');
    expect(isDisabled(button(larger, tr('en', 'payments.submit')))).toBe(true);
    expect(text(larger)).toContain('is more than you still owe on these purchases');
  });

  it('offers Pay only once the server has proposed the split', () => {
    const before = render('PaySupplierView', 'before the proposal');
    expect(buttons(before)).not.toContain(tr('en', 'payments.submit'));
  });

  it('a purchase in another currency is marked not paid by this payment', () => {
    const r = render('PaySupplierView', 'proposal, other-currency purchase not paid');
    expect(text(r)).toContain(tr('en', 'payments.notPaid'));
  });

  it('a split the merchant changed is sent as typed, asking the settled amount in the purchase currency', () => {
    const r = render('PaySupplierView', 'split changed, another currency');
    expect(isDisabled(button(r, tr('en', 'payments.submit')))).toBe(false);
    expect(labels(r)).toContain(tr('en', 'payments.amountSettles', { currency: 'USD' }));
    expect(text(r)).toContain(tr('en', 'payments.rowsInvalid'));
  });

  it('first way to pay: only the kinds the business is ready for, never an account (A-18)', () => {
    for (const locale of ['ar', 'en', 'tr'] as const) {
      const r = render('PaySupplierView', 'first way to pay, owner chooses the kind', locale);
      for (const kind of ['cash', 'bank_transfer', 'wallet', 'cheque']) expect(text(r)).toContain(tr(locale, `payments.kind.${kind}`));
      expect(text(r)).not.toContain(tr(locale, 'payments.kind.card'));
      expect(text(r)).not.toMatch(/account|حساب|hesap/i);
      expect(buttons(r)).toContain(tr(locale, 'payments.setup.create'));
    }
  });

  it('with no way to pay, anyone but the owner is told to ask the owner', () => {
    const r = render('PaySupplierView', 'no way to pay, ask the owner');
    expect(text(r)).toContain(tr('en', 'payments.setup.askOwner'));
    expect(buttons(r)).not.toContain(tr('en', 'payments.setup.create'));
    expect(buttons(r)).not.toContain(tr('en', 'payments.submit'));
  });

  it('lists the balance in your favour and the server’s proposal to use it', () => {
    const r = render('PaySupplierView', 'balance in your favour, proposal to use it');
    expect(text(r)).toContain(tr('en', 'suppliers.balance.inYourFavour'));
    expect(buttons(r)).toContain(tr('en', 'payments.favour.apply'));
    const used = render('PaySupplierView', 'balance in your favour used');
    expect(text(used)).toContain(tr('en', 'payments.favour.done'));
    expect(buttons(used)).not.toContain(tr('en', 'payments.favour.apply'));
  });

  it('the result names the supplier and how many purchases the payment settled', () => {
    const r = render('PaySupplierView', 'inactive supplier, paid');
    expect(text(r)).toMatch(/paid to Al-Noor Trading, settling one purchase\./);
    expect(buttons(r)).toEqual([tr('en', 'payments.backToSupplier')]);
  });

  it('D-6: the settled count agrees in number — one, several, none — in every locale', () => {
    expect(text(render('PaySupplierView', 'paid, settling two purchases'))).toMatch(/paid to Al-Noor Trading, settling 2 purchases\./);
    expect(text(render('PaySupplierView', 'paid, nothing settled'))).toContain('paid to Al-Noor Trading.');
    for (const locale of ['ar', 'en', 'tr'] as const) {
      const one = text(render('PaySupplierView', 'inactive supplier, paid', locale));
      const two = text(render('PaySupplierView', 'paid, settling two purchases', locale));
      const none = text(render('PaySupplierView', 'paid, nothing settled', locale));
      expect(one, locale).not.toMatch(/\b1\b/);
      expect(two, locale).toMatch(/\b2\b/);
      for (const [r, key] of [
        [one, 'payments.doneDetailOne'],
        [two, 'payments.doneDetail'],
        [none, 'payments.doneDetailNone'],
      ] as const) {
        // The template's fixed words (around the placeholders) are what renders.
        for (const piece of tr(locale, key).split(/\{\w+\}/)) expect(r, `${locale} ${key}`).toContain(piece.trim());
      }
    }
    expect(text(render('PaySupplierView', 'paid, settling two purchases'))).not.toMatch(/settling 1 purchases|settling one purchase/);
  });
});

describe('payment methods as a picker offers them (Annex R #20)', () => {
  const method = (over: Partial<PaymentMethodDto>): PaymentMethodDto => ({
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m001',
    systemType: 'cash',
    isActive: true,
    requiresReference: false,
    sortOrder: 1,
    names: { ar: null, en: null, tr: null },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
    ...over,
  });
  const methods: PaymentMethodDto[] = [
    method({ paymentMethodId: 'm-bank', systemType: 'bank_transfer', sortOrder: 2, requiresReference: true, names: { ar: 'تحويل', en: null, tr: 'Havale' } }),
    method({ paymentMethodId: 'm-cash', sortOrder: 1 }),
    method({ paymentMethodId: 'm-old', systemType: 'card', sortOrder: 0, isActive: false, names: { ar: 'قديمة', en: 'Old card', tr: 'Eski' } }),
  ];

  it('drops inactive methods and keeps the business’s order', () => {
    expect(activeMethodChoices(methods, 'en', makeT('en')).map((m) => m.paymentMethodId)).toEqual(['m-cash', 'm-bank']);
  });

  it('names a method in the viewer’s language, then Arabic, then by its kind', () => {
    expect(activeMethodChoices(methods, 'tr', makeT('tr')).map((m) => m.name)).toEqual([tr('tr', 'payments.kind.cash'), 'Havale']);
    expect(activeMethodChoices(methods, 'en', makeT('en')).map((m) => m.name)).toEqual([tr('en', 'payments.kind.cash'), 'تحويل']);
    expect(activeMethodChoices(methods, 'en', makeT('en')).map((m) => m.requiresReference)).toEqual([false, true]);
  });
});
