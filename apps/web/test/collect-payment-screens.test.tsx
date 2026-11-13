import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '@/lib/i18n';
import { ApiError } from '@/lib/client';
import type { ViewFixture } from '@/lib/phase3-format';
import { refusalKey } from '@/lib/phase3-errors';
import { VIEW_REGISTRY } from '@/views/customers/registry';
import type { CollectPaymentViewProps } from '@/views/customers/CollectPaymentView';
import { stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { LOCALES, elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * "Receive a payment" (القبض), rendered through its registry fixtures in ar,
 * en and tr: the form keeps what the merchant typed when the server refuses,
 * the button is disabled while a send is in flight, a replay is a success,
 * every figure on the success screen is the server's, and no fixture shows a
 * refusal the page could not actually produce.
 */
const WEB = join(__dirname, '..');

function fixture(name: string): ViewFixture {
  const found = VIEW_REGISTRY.find((e) => e.name === 'CollectPaymentView')?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture CollectPaymentView / ${name}`);
  return found;
}
const propsOf = (name: string): CollectPaymentViewProps => fixture(name).props as CollectPaymentViewProps;
const render = (name: string, locale: Locale = 'en'): Rendered => renderFixture(fixture(name), locale);
const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const text = (r: Rendered): string => textOf(r.frame);
const tr = (locale: Locale, key: string, vars?: Record<string, string>) => translate(locale, key, vars);
const button = (r: Rendered, label: string): ElementNode => {
  const found = all(r, 'button').find((b) => textOf(b) === label);
  if (!found) throw new Error(`no button "${label}" in ${all(r, 'button').map(textOf).join(' | ')}`);
  return found;
};
const isDisabled = (b: ElementNode): boolean => 'disabled' in b.attrs;
const inputValues = (r: Rendered): string[] => all(r, 'input').map((i) => i.attrs.value ?? '');

describe('the registry holds only states the page can reach', () => {
  /**
   * Every error key a fixture shows must be one `refusalKey` produces for an
   * error this page can actually receive: a receivables refusal (the API
   * attaches `details.receivablesCode`), a payment-method refusal, an
   * envelope refusal such as a 403, or no answer at all.
   */
  const reachable = new Set<string>([
    refusalKey(new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.amount_exceeds_outstanding' })),
    refusalKey(new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.idempotency_conflict' })),
    refusalKey(new ApiError(409, 'CONFLICT', { receivablesCode: 'customer_payment.settlement_changed' })),
    refusalKey(new ApiError(400, 'VALIDATION_FAILED', { receivablesCode: 'customer_payment.allocations_invalid' })),
    refusalKey(new ApiError(403, 'FORBIDDEN')),
    refusalKey(new ApiError(500, 'INTERNAL_ERROR')),
    refusalKey(new TypeError('Failed to fetch')),
  ]);

  it('the reachable set is real keys, not the fallback only', () => {
    expect(reachable).toContain('error.customer_payment.amount_exceeds_outstanding');
    expect(reachable).toContain('error.FORBIDDEN');
    expect(reachable).toContain('error.fallback');
  });

  it('every fixture error key is reachable', () => {
    const entry = VIEW_REGISTRY.find((e) => e.name === 'CollectPaymentView');
    expect(entry?.fixtures.length).toBeGreaterThan(8);
    const keys = (entry?.fixtures ?? []).map((f) => (f.props as CollectPaymentViewProps).errorKey).filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) expect(reachable, key).toContain(key);
  });
});

describe('Receive a payment — the form', () => {
  it('offers the method, the amount, the date and each open invoice of the payment currency', () => {
    for (const locale of LOCALES) {
      const r = render('fresh form, three open invoices', locale);
      const labels = all(r, 'label').map(textOf);
      expect(labels).toContain(tr(locale, 'customers.collect.method'));
      expect(labels).toContain(tr(locale, 'customers.collect.amount', { currency: 'ILS' }));
      expect(labels).toContain(tr(locale, 'common.date'));
      expect(isDisabled(button(r, tr(locale, 'customers.collect.submit')))).toBe(false);
      expect(text(r)).toContain('INV-0007');
    }
  });

  it('is disabled while the send is in flight', () => {
    const r = render('sending');
    // While loading the design-system button shows "…" in place of its label and is disabled and busy.
    expect(all(r, 'button').map(textOf)).not.toContain(tr('en', 'customers.collect.submit'));
    const busy = all(r, 'button').filter((b) => b.attrs['aria-busy'] === 'true');
    expect(busy.length).toBe(1);
    expect(busy.every(isDisabled)).toBe(true);
    // And the same form not sending has it enabled under its label.
    expect(isDisabled(button(render('refused: more than is still due, figures kept'), tr('en', 'customers.collect.submit')))).toBe(false);
  });

  it('a refused send keeps every figure the merchant typed, and shows the refusal in merchant words', () => {
    const props = propsOf('refused: more than is still due, figures kept');
    for (const locale of LOCALES) {
      const r = render('refused: more than is still due, figures kept', locale);
      expect(text(r)).toContain(tr(locale, 'error.customer_payment.amount_exceeds_outstanding'));
      const values = inputValues(r);
      expect(values).toContain(props.form.amount);
      for (const row of props.rows.filter((x) => x.amount !== '')) expect(values).toContain(row.amount);
      expect(isDisabled(button(r, tr(locale, 'customers.collect.submit')))).toBe(false);
    }
  });

  it('a 403 on send is a refusal message beside the kept form, never an empty screen', () => {
    const r = render('refused: no permission to receive payments');
    expect(text(r)).toContain(tr('en', 'error.FORBIDDEN'));
    expect(inputValues(r)).toContain(propsOf('refused: no permission to receive payments').form.amount);
  });

  it('a payment sent twice with different figures offers a fresh form', () => {
    const r = render('refused: already sent with other figures');
    expect(text(r)).toContain(tr('en', 'error.customer_payment.idempotency_conflict'));
    expect(all(r, 'button').map(textOf)).toContain(tr('en', 'customers.collect.startOver'));
  });

  it('says the rest is held for the customer when the invoices take less than was received', () => {
    expect(text(render('partial: the rest is held for the customer'))).toContain(tr('en', 'customers.collect.restHeld'));
    expect(text(render('exact: the invoices take it all'))).not.toContain(tr('en', 'customers.collect.restHeld'));
  });

  it('warns, without deciding, when the invoices take more than was received', () => {
    const r = render('over: the invoices take more than was received');
    expect(text(r)).toContain(tr('en', 'customers.collect.over'));
    expect(isDisabled(button(r, tr('en', 'customers.collect.submit')))).toBe(false);
  });

  it('an invoice in another currency and a balance row take no amount', () => {
    const r = render('fresh form, three open invoices');
    const props = propsOf('fresh form, three open invoices');
    const editable = props.rows.filter((row) => !row.isCredit && row.currency === props.form.currency);
    const amountInputs = all(r, 'input').filter((i) => i.attrs.inputmode === 'decimal');
    // The payment amount plus one field per editable invoice, and no more.
    expect(amountInputs.length).toBe(1 + editable.length);
    expect(text(r)).toContain(tr('en', 'customers.collect.otherCurrency', { currency: 'USD' }));
    expect(text(r)).toContain(tr('en', 'customers.collect.balanceRow'));
  });

  it('with no open invoice, says the whole payment is held for the customer', () => {
    expect(text(render('no open invoices'))).toContain(tr('en', 'customers.collect.noOpenInvoices'));
  });

  it('marks a malformed invoice amount', () => {
    const r = render('an invoice amount is not valid');
    expect(text(r)).toContain(tr('en', 'customers.collect.rowInvalid'));
    expect(text(r)).toContain(tr('en', 'customers.collect.rowsInvalid'));
  });
});

describe('Receive a payment — the answer, as the server states it', () => {
  it('shows the saved payment with the server figures', () => {
    const props = propsOf('saved, with the rest held for the customer');
    const r = render('saved, with the rest held for the customer');
    expect(text(r)).toContain(tr('en', 'customers.collect.done'));
    expect(props.result?.credit).not.toBeNull();
    // 1,250.00 received and 250.00 held: both come from the answer, not from the form.
    expect(text(r)).toContain('1,250.00');
    expect(text(r)).toContain('250.00');
    expect(text(r)).not.toContain(tr('en', 'error.fallback'));
  });

  it('a replay is a success, not an error', () => {
    for (const locale of LOCALES) {
      const r = render('saved earlier: the same payment sent again', locale);
      expect(text(r)).toContain(tr(locale, 'customers.collect.done'));
      expect(text(r)).toContain(tr(locale, 'customers.collect.alreadySaved'));
      expect(all(r, 'div').some((d) => d.attrs.role === 'alert')).toBe(false);
    }
  });

  it('every amount sits in an isolated left-to-right run, and nothing is a table', () => {
    for (const name of ['fresh form, three open invoices', 'saved, with the rest held for the customer']) {
      for (const locale of LOCALES) {
        const r = render(name, locale);
        expect(all(r, 'table')).toEqual([]);
        const isolated = all(r, 'bdi').map(textOf).join(' ');
        expect(isolated, `${name} ${locale}`).toMatch(/\d/);
      }
    }
    const r = render('saved, with the rest held for the customer', 'ar');
    expect(all(r, 'bdi').map(textOf).join(' ')).toContain('1,250.00');
  });
});

describe('the screen does no number arithmetic on money', () => {
  const FILES = [
    'src/lib/phase4-collect-payment-api.ts',
    'src/views/customers/collect-payment.ts',
    'src/views/customers/CollectPaymentView.tsx',
    'src/views/customers/registry.ts',
    'src/app/[locale]/customers/[customerId]/collect/page.tsx',
    'src/app/[locale]/customers/[customerId]/collect/collect-page-kit.ts',
  ];
  const FORBIDDEN = /\bNumber\s*\(|\bparseInt\s*\(|\bparseFloat\s*\(|\bMath\.|\.toFixed\s*\(|(?:^|[=(,:?]\s*)\+\s*[A-Za-z_(]/m;

  it('the probe fires on each forbidden spelling', () => {
    for (const planted of ['const a = Number(x);', 'parseInt(s, 10)', 'parseFloat(s)', 'Math.round(x)', 'x.toFixed(2)', 'const n = +amount;']) {
      expect(FORBIDDEN.test(planted), planted).toBe(true);
    }
    expect(FORBIDDEN.test('const s = `${a}+${b}`; BigInt(a) + BigInt(b);')).toBe(false);
  });

  it('none of the screen files use one', () => {
    for (const file of FILES) {
      const source = stripTsComments(readFileSync(join(WEB, file), 'utf8'));
      expect(FORBIDDEN.exec(source)?.[0] ?? null, file).toBeNull();
    }
  });
});
