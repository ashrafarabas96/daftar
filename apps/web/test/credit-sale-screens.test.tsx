import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/client';
import { translate, type Locale } from '@/lib/i18n';
import type { ViewFixture } from '@/lib/phase3-format';
import type { CreditSaleViewProps } from '@/views/sales/CreditSaleView';
import { STORED_UNREADABLE_KEY, creditSaleRefusalKey } from '@/views/sales/credit-sale-flow';
import { VIEW_REGISTRY } from '@/views/sales/registry';
import { stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { LOCALES, elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * The credit sale (البيع بالدين), rendered through its registry fixtures in ar,
 * en and tr: the form keeps what the merchant typed when the server refuses,
 * the button is disabled while a send is in flight, a replay is a success,
 * every figure on the saved screen is the server's, and no fixture shows a
 * refusal the page could not actually produce.
 */
const WEB = join(__dirname, '..');

function fixture(name: string): ViewFixture {
  const found = VIEW_REGISTRY.find((e) => e.name === 'CreditSaleView')?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture CreditSaleView / ${name}`);
  return found;
}
const propsOf = (name: string): CreditSaleViewProps => fixture(name).props as CreditSaleViewProps;
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
const entry = () => VIEW_REGISTRY.find((e) => e.name === 'CreditSaleView');

describe('the registry holds only states the page can reach', () => {
  /**
   * Every error key a fixture shows must be one `creditSaleRefusalKey` — the
   * one function the flow folds a refusal through — produces for an answer
   * `POST /v1/sales` can give this page (the API attaches
   * `details.sellingCode`), an envelope refusal, or no answer at all; or the
   * flow's own key for a stored sale it could not read.
   */
  const reachable = new Set<string>([
    creditSaleRefusalKey(new ApiError(403, 'FORBIDDEN', { sellingCode: 'sale.credit_not_permitted' })),
    creditSaleRefusalKey(new ApiError(409, 'CONFLICT', { sellingCode: 'sale.customer_inactive' })),
    creditSaleRefusalKey(new ApiError(409, 'CONFLICT', { sellingCode: 'sale.state_changed' })),
    creditSaleRefusalKey(new ApiError(422, 'VALIDATION_FAILED', { sellingCode: 'sale.product_not_priced' })),
    creditSaleRefusalKey(new ApiError(422, 'VALIDATION_FAILED', { sellingCode: 'sale.fx_rate_missing' })),
    creditSaleRefusalKey(new ApiError(403, 'FORBIDDEN')),
    creditSaleRefusalKey(new ApiError(500, 'INTERNAL_ERROR')),
    creditSaleRefusalKey(new TypeError('Failed to fetch')),
    STORED_UNREADABLE_KEY,
  ]);

  it('the reachable set is real keys, not the fallback only', () => {
    expect(reachable).toContain('sales.credit.refusedNotPermitted');
    expect(reachable).toContain('error.sale.product_not_priced');
    expect(reachable).toContain('error.FORBIDDEN');
    expect(reachable).toContain('error.fallback');
    for (const key of reachable) for (const locale of LOCALES) expect(tr(locale, key), `${locale} ${key}`).not.toBe(key);
  });

  it('every fixture error key is reachable, and more than one is used', () => {
    expect(entry()?.fixtures.length).toBeGreaterThan(12);
    const keys = (entry()?.fixtures ?? []).map((f) => (f.props as CreditSaleViewProps).errorKey).filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(4);
    for (const key of keys) expect(reachable, key).toContain(key);
  });

  it('every saved or stored fixture is a credit sale for the fixture customer — never a walk-in', () => {
    const shown = (entry()?.fixtures ?? []).map((f) => f.props as CreditSaleViewProps).flatMap((p) => [p.result, p.stored]);
    const sales = shown.filter((s) => s !== null);
    expect(sales.length).toBeGreaterThanOrEqual(4);
    for (const sale of sales) {
      expect(sale?.settlementMode).toBe('credit');
      expect(sale?.customerId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('Sell to be paid later — the form', () => {
  it('names the buyer, offers where it is sold from, the sale date, the pay-by date and the item search', () => {
    for (const locale of LOCALES) {
      const r = render('two items added', locale);
      const labels = all(r, 'label').map(textOf);
      expect(text(r)).toContain(propsOf('two items added').customer.name);
      expect(labels).toContain(tr(locale, 'sales.credit.warehouse'));
      expect(labels).toContain(tr(locale, 'common.date'));
      expect(labels).toContain(`${tr(locale, 'sales.credit.dueDate')} (${tr(locale, 'common.optional')})`);
      expect(labels).toContain(tr(locale, 'stock.picker.search'));
      expect(isDisabled(button(r, tr(locale, 'sales.credit.submit')))).toBe(false);
    }
  });

  it('says plainly that the prices and the total are the shop’s, shown once the sale is saved', () => {
    expect(text(render('two items added'))).toContain(tr('en', 'sales.credit.pricesHint'));
  });

  it('is disabled while the send is in flight', () => {
    const r = render('sending');
    expect(all(r, 'button').map(textOf)).not.toContain(tr('en', 'sales.credit.submit'));
    const busy = all(r, 'button').filter((b) => b.attrs['aria-busy'] === 'true');
    expect(busy.length).toBe(1);
    expect(busy.every(isDisabled)).toBe(true);
    expect(isDisabled(button(render('refused: no permission to sell to be paid later, figures kept'), tr('en', 'sales.credit.submit')))).toBe(false);
  });

  it('a refused send keeps every quantity and date typed, and shows the refusal in merchant words', () => {
    const name = 'refused: no permission to sell to be paid later, figures kept';
    const props = propsOf(name);
    for (const locale of LOCALES) {
      const r = render(name, locale);
      expect(text(r)).toContain(tr(locale, 'sales.credit.refusedNotPermitted'));
      const values = inputValues(r);
      for (const l of props.lines) expect(values).toContain(l.quantity);
      expect(values).toContain(props.form.dueDate);
      expect(isDisabled(button(r, tr(locale, 'sales.credit.submit')))).toBe(false);
    }
  });

  it('an inactive buyer is said before the merchant types, not only after a refusal', () => {
    expect(text(render('inactive buyer'))).toContain(tr('en', 'sales.credit.customerInactive'));
    expect(text(render('two items added'))).not.toContain(tr('en', 'sales.credit.customerInactive'));
  });

  it('with no warehouse to sell from, says so', () => {
    expect(text(render('no warehouse to sell from'))).toContain(tr('en', 'sales.credit.noWarehouse'));
  });

  it('marks the form errors the plan returns', () => {
    expect(text(render('sent with no item'))).toContain(tr('en', 'sales.credit.noLines'));
    expect(text(render('pay-by date before the sale date'))).toContain(tr('en', 'sales.credit.dueDateInvalid'));
    expect(text(render('a quantity is not valid'))).toContain(tr('en', 'stock.line.quantityInvalid'));
  });

  it('a sale already stored under this form is shown with its saved figures, not a fresh form', () => {
    for (const locale of LOCALES) {
      const r = render('already recorded: the stored sale is shown', locale);
      expect(text(r)).toContain(tr(locale, 'sales.credit.alreadyRecorded'));
      // The stored total (75.00), not anything still typed in the form.
      expect(all(r, 'bdi').map(textOf).join(' ')).toMatch(/75[.,]00/);
      expect(all(r, 'input')).toEqual([]);
      expect(text(r)).not.toContain(tr(locale, 'error.sale.idempotency_conflict'));
    }
  });

  it('when the stored sale cannot be read, no new form is offered: only reading it again', () => {
    const r = render('already recorded, but it could not be read');
    expect(text(r)).toContain(tr('en', 'sales.credit.storedUnreadable'));
    const labels = all(r, 'button').map(textOf);
    expect(labels).toContain(tr('en', 'sales.credit.readAgain'));
    expect(labels).not.toContain(tr('en', 'sales.credit.another'));
    expect(labels).not.toContain(tr('en', 'sales.credit.submit'));
    expect(all(r, 'input')).toEqual([]);
  });

  it('no fixture offers a new form while a form is on screen', () => {
    for (const f of entry()?.fixtures ?? []) {
      const p = f.props as CreditSaleViewProps;
      if (p.result !== null || p.stored !== null) continue;
      expect(all(renderFixture(f, 'en'), 'button').map(textOf), f.name).not.toContain(tr('en', 'sales.credit.another'));
    }
  });
});

describe('Sell to be paid later — the answer, as the server states it', () => {
  it('shows the saved sale with the server figures and the invoice number', () => {
    const props = propsOf('saved, with a pay-by date');
    const r = render('saved, with a pay-by date');
    expect(text(r)).toContain(tr('en', 'sales.credit.done'));
    expect(text(r)).toContain(props.result?.invoice.number.documentNumber ?? 'missing');
    // 1,234,567,890,123,456.78 is above 2^53 minor units: the server's text, re-spelled exactly, never a float.
    expect(text(r)).toContain('1,234,567,890,123,456.78');
    expect(text(r)).toContain('600.00');
    expect(text(r)).toContain(props.customer.name);
  });

  it('says when it is to be paid by, or that no date was set', () => {
    expect(text(render('saved, with a pay-by date'))).toMatch(/15/);
    expect(text(render('saved, no pay-by date'))).toContain(tr('en', 'sales.credit.noDue'));
  });

  it('a replay is a success, not an error', () => {
    for (const locale of LOCALES) {
      const r = render('saved earlier: the same sale sent again', locale);
      expect(text(r)).toContain(tr(locale, 'sales.credit.done'));
      expect(text(r)).toContain(tr(locale, 'sales.credit.alreadySaved'));
      expect(all(r, 'div').some((d) => d.attrs.role === 'alert')).toBe(false);
    }
  });

  it('never states the cost, the rate or the base figure of the sale', () => {
    const props = propsOf('saved, with a pay-by date');
    const r = text(render('saved, with a pay-by date'));
    expect(props.result?.cogsBaseMinor).toBe('31415926');
    expect(r).not.toContain('314,159.26');
    expect(r).not.toContain('3.14159');
  });

  it('every amount sits in an isolated left-to-right run, and nothing is a table', () => {
    for (const name of ['two items added', 'saved, with a pay-by date']) {
      for (const locale of LOCALES) {
        const r = render(name, locale);
        expect(all(r, 'table')).toEqual([]);
        expect(all(r, 'bdi').map(textOf).join(' '), `${name} ${locale}`).toMatch(/\d/);
      }
    }
    expect(all(render('saved, with a pay-by date', 'ar'), 'bdi').map(textOf).join(' ')).toContain('600.00');
  });
});

describe('the screen does no number arithmetic on money', () => {
  const FILES = [
    'src/lib/phase4-credit-sale-api.ts',
    'src/views/sales/credit-sale.ts',
    'src/views/sales/credit-sale-flow.ts',
    'src/views/sales/CreditSaleView.tsx',
    'src/views/sales/registry.ts',
    'src/app/[locale]/customers/[customerId]/sell/page.tsx',
  ];
  const FORBIDDEN = /\bNumber\s*\(|\bparseInt\s*\(|\bparseFloat\s*\(|\bMath\.|\.toFixed\s*\(|(?:^|[=(,:?]\s*)\+\s*[A-Za-z_(]/m;

  it('the probe fires on each forbidden spelling', () => {
    for (const planted of ['const a = Number(x);', 'parseInt(s, 10)', 'parseFloat(s)', 'Math.round(x)', 'x.toFixed(2)', 'const n = +amount;']) {
      expect(FORBIDDEN.test(planted), planted).toBe(true);
    }
    expect(FORBIDDEN.test('const s = `${a}+${b}`; BigInt(a) + BigInt(b);')).toBe(false);
  });

  it('none of the screen files use one, and none adds two figures', () => {
    for (const file of FILES) {
      const source = stripTsComments(readFileSync(join(WEB, file), 'utf8'));
      expect(FORBIDDEN.exec(source)?.[0] ?? null, file).toBeNull();
      expect(/BigInt\s*\(/.test(source), `${file}: the screen sums nothing, so it needs no BigInt either`).toBe(false);
    }
  });
});
