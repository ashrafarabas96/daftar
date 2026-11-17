import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { ApiError } from '@/lib/client';
import { refusalKey } from '@/lib/phase3-errors';
import type { ViewEntry } from '@/lib/phase3-format';
import { VIEW_REGISTRY as CUSTOMER_VIEWS } from '@/views/customers/registry';
import { findMerchantJargon, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { elements, LOCALES, renderFixture, textOf, type Locale, type Rendered } from './helpers/render';

/**
 * MVP-02, the customers list (read-only), on `GET /v1/customers`
 * (`customer-reads.ts`, a keyset page ordered `(name, id)`, permission
 * `customers.view`).
 *
 * What this screen is NOT, and the suite holds it to that:
 *  - it creates or edits nothing (the write routes are another lane's PR);
 *  - it shows no balance, credit limit, receivable or any money figure — that is
 *    the next, finance-reviewed screen. The list DTO carries none, and the view
 *    must not reach for the receivable read either;
 *  - it does not sort: the server's `(name, id)` order is the merchant's alphabet.
 */
const WEB_SRC = join(__dirname, '..', 'src');
const read = (...parts: string[]): string => readFileSync(join(WEB_SRC, ...parts), 'utf8');
const VIEW_SOURCE = (): string => stripTsComments(read('views', 'customers', 'CustomerListView.tsx'));
const PAGE_SOURCE = (): string => stripTsComments(read('app', '[locale]', 'customers', 'page.tsx'));
const LIB_SOURCE = (): string => stripTsComments(read('lib', 'phase4-customers-api.ts'));

function render(entries: readonly ViewEntry[], view: string, fixture: string, locale: Locale = 'en'): Rendered {
  const found = entries.find((e) => e.name === view)?.fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${view} / ${fixture}`);
  return renderFixture(found, locale);
}
const text = (r: Rendered): string => textOf(r.frame);
const buttons = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'button').map((e) => textOf(e));
const ALL = 'four customers: with phone and contact, inactive, and one with no contact details';
const CATALOGS: Record<Locale, Record<string, string>> = { ar, en, tr };

/** The keys this screen adds, as the gate's jargon pass sees them. */
const NEW_KEY_PREFIXES = ['customers.', 'nav.customers'];
const onlyNewKeys = (dict: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(dict).filter(([k]) => NEW_KEY_PREFIXES.some((p) => k.startsWith(p))));

/**
 * The tie between the fixture "show more was refused" and `page.tsx`: the page's
 * `loadMore` catch must set the refusal and must NOT clear the cursor, while its
 * try block does set it (the positive control, so "absent" is a measurement).
 * One function, so the shipped page and the planted defect are read the same way.
 */
function loadMoreFindings(page: string): string[] {
  const body = /async function loadMore\(\)[\s\S]*?try \{([\s\S]*?)\} catch \(error\) \{([\s\S]*?)\} finally/.exec(page);
  if (!body) return ['loadMore with try/catch/finally not found'];
  const tried = body[1] ?? '';
  const caught = body[2] ?? '';
  const out: string[] = [];
  if (!tried.includes('setCursor(')) out.push('the try block does not advance the cursor');
  if (!caught.includes('setErrorKey(')) out.push('the catch does not set the refusal');
  if (caught.includes('setCursor(')) out.push('the catch touches the cursor');
  if (!page.includes('hasMore={cursor !== null}')) out.push('hasMore is not derived from the cursor alone');
  return out;
}

/** Words and spellings of money; none may reach the view, the markup or the client. */
const MONEY_WORDS = /balance|credit|receivable|owed|owing|outstanding|debt|Minor\b|currency|<Money|Amounts|رصيد|دين|مدين|ائتمان|bakiye|borç|kredi/i;

describe('the customer view registry', () => {
  it('registers the list, with fixtures', () => {
    expect(CUSTOMER_VIEWS.map((e) => e.name)).toEqual(['CustomerListView']);
    for (const entry of CUSTOMER_VIEWS) expect(entry.fixtures.length, entry.name).toBeGreaterThan(0);
  });

  it('has exactly the states the page can reach', () => {
    expect(CUSTOMER_VIEWS[0]?.fixtures.map((f) => f.name)).toEqual([
      ALL,
      'one customer, no further page',
      'no customers at all',
      'show more was refused, with the rows still on screen',
    ]);
  });

  it('every fixture renders in ar, en and tr with no missing key', () => {
    for (const entry of CUSTOMER_VIEWS) {
      for (const fixture of entry.fixtures) {
        for (const locale of LOCALES) expect(renderFixture(fixture, locale).missingKeys, `${entry.name}/${fixture.name} ${locale}`).toEqual([]);
      }
    }
  });

  it('adds no key the merchant-language guard denies', () => {
    expect(findMerchantJargon({ ar: onlyNewKeys(ar), en: onlyNewKeys(en), tr: onlyNewKeys(tr) })).toEqual([]);
  });

  it('adds the same keys to all three catalogues', () => {
    const keysOf = (d: Record<string, string>) => Object.keys(onlyNewKeys(d)).sort();
    expect(keysOf(ar).length).toBeGreaterThan(0);
    expect(keysOf(en)).toEqual(keysOf(ar));
    expect(keysOf(tr)).toEqual(keysOf(ar));
    expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
    expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  });

  it('adds no key that names money, and no key a create or edit screen would need', () => {
    for (const locale of LOCALES) {
      const keys = Object.keys(onlyNewKeys(CATALOGS[locale]));
      expect(
        keys.filter((k) => MONEY_WORDS.test(k) || /\.(create|new|edit|save|add)\b/.test(k)),
        locale,
      ).toEqual([]);
    }
  });
});

describe('the customer list', () => {
  const r = render(CUSTOMER_VIEWS, 'CustomerListView', ALL);
  const fixtureItems = (): readonly { id: string; name: string; phone: string | null }[] =>
    (CUSTOMER_VIEWS[0]?.fixtures.find((f) => f.name === ALL)?.props as { customers: readonly { id: string; name: string; phone: string | null }[] }).customers;

  it('shows each customer by name and phone, with the phone kept left-to-right in <bdi>', () => {
    for (const c of fixtureItems()) expect(text(r), c.name).toContain(c.name);
    expect(r.html).toContain('<bdi dir="ltr">0599-123456</bdi>');
  });

  it('shows the primary contact from the catalogue sentence, in all three languages', () => {
    for (const locale of LOCALES) {
      const shown = text(render(CUSTOMER_VIEWS, 'CustomerListView', ALL, locale));
      expect(CATALOGS[locale]['customers.list.contact'], locale).toContain('{name}');
      expect(shown, locale).toContain('Samira Haddad');
    }
  });

  it('labels the inactive customer and only that one', () => {
    for (const locale of LOCALES) {
      const html = render(CUSTOMER_VIEWS, 'CustomerListView', ALL, locale).html;
      const label = CATALOGS[locale]['common.inactive'] as string;
      expect(html.split(label).length - 1, locale).toBe(1);
    }
  });

  it('shows the rows in the order the server gave them, and claims no other order', () => {
    const given = fixtureItems().map((c) => c.name);
    const shown = text(r);
    const positions = given.map((n) => shown.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions, 'rows appear in the order the server gave them').toEqual([...positions].sort((a, b) => a - b));
    // The fixture is NOT already in alphabetical order, so a view that sorted
    // would visibly change it (positive control for the check above).
    expect(given, 'fixture order differs from a sorted copy').not.toEqual([...given].sort((a, b) => a.localeCompare(b)));
    const source = VIEW_SOURCE();
    expect(source).not.toContain('.sort(');
    expect(source).not.toContain('.reverse(');
    expect(source).not.toContain('localeCompare');
  });

  it('never renders an identifier', () => {
    for (const c of fixtureItems()) expect(r.html, c.id).not.toContain(c.id);
  });

  it('shows no money figure, no balance, no credit limit, in markup or source', () => {
    for (const locale of LOCALES) {
      const shown = render(CUSTOMER_VIEWS, 'CustomerListView', ALL, locale);
      expect(text(shown), locale).not.toMatch(/[₪$€]|\d+\.\d{2}\b/);
      expect(text(shown), locale).not.toMatch(MONEY_WORDS);
    }
    expect(VIEW_SOURCE()).not.toMatch(MONEY_WORDS);
    expect(LIB_SOURCE()).not.toMatch(/receivable|balance|credit|aging/i);
  });

  it('the money probe can fail: it fires on a planted figure and on a planted receivable read', () => {
    expect('<Money amountMinor={c.balanceMinor} />').toMatch(MONEY_WORDS);
    expect('Credit limit: ₪500.00').toMatch(MONEY_WORDS);
    expect('apiFetch(`/customers/${id}/receivable`)').toMatch(MONEY_WORDS);
    expect('رصيد العميل').toMatch(MONEY_WORDS);
    expect('Müşteri bakiyesi').toMatch(MONEY_WORDS);
    // And it does not fire on the real wording.
    expect('Customers. No customers yet. Contact: {name}').not.toMatch(MONEY_WORDS);
  });

  it('offers more only when the server gave a cursor', () => {
    expect(buttons(r)).toContain(en['common.loadMore']);
    expect(buttons(render(CUSTOMER_VIEWS, 'CustomerListView', 'one customer, no further page'))).not.toContain(en['common.loadMore']);
  });

  it('shows the empty state with no action: nothing can be created from here', () => {
    const empty = render(CUSTOMER_VIEWS, 'CustomerListView', 'no customers at all');
    expect(text(empty)).toContain(en['customers.list.empty']);
    expect(buttons(empty)).toEqual([]);
  });

  it('has no navigation or write affordance: rows are inert and there is no form', () => {
    const source = VIEW_SOURCE();
    expect(source).not.toContain('onClick:');
    expect(source).not.toContain('onOpen');
    expect(source).not.toMatch(/TextField|<form|onSubmit|onCreate|onEdit/);
    expect(source, 'positive control: the probe sees the one onClick the view has').toContain('onClick={props.onLoadMore}');
  });

  it('renders a refused "show more" from the catalogue, never the server’s own sentence, and keeps the rows and the button', () => {
    const refused = render(CUSTOMER_VIEWS, 'CustomerListView', 'show more was refused, with the rows still on screen');
    // The key must be one the PAGE can produce: its catch sets `refusalKey(error)`, which only ever returns `error.<code>` or the fallback.
    expect(refusalKey(new ApiError(403, 'FORBIDDEN')), 'what the page would set for a refused read').toBe('error.FORBIDDEN');
    expect(text(refused)).toContain(en['error.FORBIDDEN']);
    expect(text(refused)).not.toContain('FORBIDDEN');
    expect(text(refused)).not.toContain(en['customers.list.empty']);
    expect(text(refused)).toContain('Samira Haddad');
    expect(buttons(refused)).toContain(en['common.loadMore']);
  });
});

describe('the customers page and client', () => {
  it('the refused "show more" fixture is what the PAGE does: its catch keeps the cursor', () => {
    expect(loadMoreFindings(PAGE_SOURCE())).toEqual([]);
    expect(PAGE_SOURCE()).toMatch(/phase !== 'ready' \?\s*\(\s*<ScreenState/);
  });

  it('the page probe can fail: it fires on a page whose catch clears the cursor', () => {
    const planted = PAGE_SOURCE().replace(/setErrorKey\(refusalKey\(error\)\);/, 'setErrorKey(refusalKey(error)); setCursor(null);');
    expect(planted).not.toEqual(PAGE_SOURCE());
    expect(loadMoreFindings(planted)).toEqual(['the catch touches the cursor']);
    expect(loadMoreFindings('export default function P() {}')).toEqual(['loadMore with try/catch/finally not found']);
  });

  it('the page passes the server order through and reads only the list', () => {
    const page = PAGE_SOURCE();
    expect(page).toContain('listCustomers');
    expect(page).not.toContain('.sort(');
    expect(page).toContain('setCustomers((current) => [...current, ...page.items])');
    expect(page).toContain('active="customers"');
  });

  it('the client asks GET /customers through the BFF, with no /v1 and no other route', () => {
    const lib = LIB_SOURCE();
    expect(lib).toContain('${BFF}/customers${qs(');
    expect(lib).toContain("cache: 'no-store'");
    expect(lib).not.toMatch(/\/v1\b/);
    expect(lib).not.toMatch(/method\s*:|POST|PUT|DELETE|PATCH/);
    expect([...lib.matchAll(/\/customers[^`'"]*/g)].map((m) => m[0])).toEqual(['/customers${qs({ ...q })}']);
    expect(read('app', '[locale]', 'customers', 'page.tsx').startsWith("'use client'")).toBe(true);
  });

  it('is reachable from the header, by a nav key every catalogue has', () => {
    expect(read('app', '[locale]', 'AppHeader.tsx')).toContain("{ key: 'customers', path: 'customers' }");
    for (const locale of LOCALES) expect(CATALOGS[locale]['nav.customers'], locale).toBeTruthy();
  });
});
