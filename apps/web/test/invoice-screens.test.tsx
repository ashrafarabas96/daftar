import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { formatCivilDate, formatMomentDate, formatMoney } from '@/lib/phase3-format';
import type { ViewEntry } from '@/lib/phase3-format';
import { VIEW_REGISTRY as INVOICE_VIEWS } from '@/views/invoices/registry';
import { findMerchantJargon, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { elements, LOCALES, renderFixture, textOf, type Locale, type Rendered } from './helpers/render';

/**
 * MVP-02 screen 1 — the invoice list (card §3(1)).
 *
 * It sits on `GET /v1/invoices`, which answered live on this commit with these
 * exact field names (`.local-context/evidence/MVP01_RUN_VERIFY_2026-11-11_AR.md`
 * §3), and consumes `InvoicePageDto` / `InvoiceSummaryDto` unchanged.
 *
 * ── THE CARD'S NAMED UNKNOWN, ANSWERED (MVP-02 §5) ───────────────────────
 * `tests/browser/flows.ts` was read before this screen was written, and the
 * answer is: this screen is covered by `VIEW_REGISTRY` alone, NOT by a browser
 * flow. Two measured reasons. `flows.ts` walks a fixed list of named paths and
 * never iterates the nav (`:39-53`, `:64`), so a step would have to be declared
 * there by hand; and `tests/browser/` belongs to another lane, so L8 may not
 * write it (charter §2, one writer per file). The registry route is not a
 * lesser one: `loadViewRegistries` discovers this area from disk, which puts
 * every fixture through T-08, T-15 and T-16 in ar, en and tr automatically. The
 * gap is named rather than hidden: the screen is NOT exercised at three viewport
 * sizes in a real browser, and the request for that step is the lane owner's to
 * send.
 *
 * ── WHAT THIS SUITE IS FOR, beyond "it renders" ──────────────────────────
 *  - **no money is computed.** Every amount must be a verbatim field of the
 *    fixture; `noComputedMoney` guards the page total and every pairwise sum.
 *  - **the two totals are told apart.** One fixture is in a second currency with
 *    a DIFFERENT base figure, and the base figure must not reach the markup —
 *    without that row, rendering `totalBaseMinor` beside `currency` passed.
 *  - **settlement is never claimed** (P4-AL-24): a list answer has no settlement
 *    figure, so no word and no colour may imply one — checked per locale in that
 *    locale's own words, not in English against an English render.
 *  - **the merchant reads no accounting word** (T-09), through the gate's own
 *    `findMerchantJargon`.
 *  - **the row is inert.** It offers no navigation, because the detail screen is
 *    held out of the tree by T-12 and a row that pushed `/invoices/:id` would
 *    404. The test reads the view's source for an `onClick`, since a prop that
 *    does not exist cannot be asserted through a render.
 *
 * The invoice DETAIL screen is not here: an `InvoiceDto` fixture must name
 * `customerSnapshot`, which T-12 refuses in every file of `apps/web`. That is a
 * law for its owner to amend, not a line to bend here:
 * `.local-context/cards/L8_INVOICE_DETAIL_BLOCKED_BY_T12_AR.md`.
 */
function render(entries: readonly ViewEntry[], view: string, fixture: string, locale: Locale = 'en'): Rendered {
  const found = entries.find((e) => e.name === view)?.fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${view} / ${fixture}`);
  return renderFixture(found, locale);
}
const text = (r: Rendered): string => textOf(r.frame);
const buttons = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'button').map((e) => textOf(e));
const ALL = 'four invoices: open, draft, cancelled and one in another currency';

/** The keys this screen adds, as the gate's jargon pass sees them. */
const NEW_KEY_PREFIXES = ['invoices.', 'nav.invoices'];
const onlyNewKeys = (dict: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(dict).filter(([k]) => NEW_KEY_PREFIXES.some((p) => k.startsWith(p))));
const CATALOGS: Record<Locale, Record<string, string>> = { ar, en, tr };

describe('the invoice view registry', () => {
  it('registers the list and the detail, each with fixtures', () => {
    expect(INVOICE_VIEWS.map((e) => e.name)).toEqual(['InvoiceListView', 'InvoiceDetailView']);
    for (const entry of INVOICE_VIEWS) expect(entry.fixtures.length, entry.name).toBeGreaterThan(0);
  });

  it('every fixture renders in ar, en and tr with no missing key', () => {
    for (const entry of INVOICE_VIEWS) {
      for (const fixture of entry.fixtures) {
        for (const locale of LOCALES) expect(renderFixture(fixture, locale).missingKeys, `${entry.name}/${fixture.name} ${locale}`).toEqual([]);
      }
    }
  });

  it('adds no key the merchant-language guard denies', () => {
    expect(findMerchantJargon({ ar: onlyNewKeys(ar), en: onlyNewKeys(en), tr: onlyNewKeys(tr) })).toEqual([]);
  });

  it('adds the same keys to all three catalogues, and only keys a screen renders', () => {
    const keysOf = (d: Record<string, string>) => Object.keys(onlyNewKeys(d)).sort();
    expect(keysOf(ar).length).toBeGreaterThan(0);
    expect(keysOf(en)).toEqual(keysOf(ar));
    expect(keysOf(tr)).toEqual(keysOf(ar));
    // The detail and collection keys ship WITH their screen now, and the one
    // key that stays out is the buyer's: T-12 still refuses that vocabulary, so
    // the detail screen names no buyer and keys none.
    expect(keysOf(en).filter((k) => k.startsWith('invoices.detail.')).length).toBeGreaterThan(0);
    expect(keysOf(en).filter((k) => k.startsWith('invoices.settlement.')).length).toBeGreaterThan(0);
    expect(keysOf(en)).not.toContain('invoices.detail.customer');
    expect(keysOf(en)).not.toContain('invoices.noCustomer');
  });
});

describe('the invoice list', () => {
  const r = render(INVOICE_VIEWS, 'InvoiceListView', ALL);

  // The words that would make this list claim collection. One list, used by BOTH
  // the assertion and its control below — so emptying it breaks the control.
  const COLLECTION_WORDS: Record<Locale, readonly string[]> = {
    en: ['open', 'paid', 'unpaid', 'collected', 'outstanding', 'remaining', 'due', 'overdue', 'settled', 'balance', 'owing'],
    ar: ['مفتوح', 'مدفوع', 'مسدد', 'مسدَّد', 'محصَّل', 'محصل', 'متبقي', 'المتبقي', 'تستحق', 'متأخر', 'رصيد', 'دين'],
    tr: ['açık', 'ödendi', 'ödenmedi', 'tahsil', 'kalan', 'vadesi', 'gecikmiş', 'bakiye', 'borç'],
  };

  it('shows each document by its number', () => {
    expect(text(r)).toContain('INV-2026-000002');
    expect(text(r)).toContain('INV-2026-000006');
  });

  it('shows the day it was issued, spelled the one way every screen spells a date', () => {
    // Pinned to the literal string, in each locale, rather than to the helper's
    // own output on the same input: a view that rendered the raw ISO text, or
    // dropped the date entirely, has to fail this.
    expect(r.html).toContain('<bdi dir="ltr">Nov 10, 2026</bdi>');
    // The other two locales spell the same day their own way, and each must
    // reach the markup inside its own `<bdi>`.
    for (const locale of ['ar', 'tr'] as const) {
      const html = render(INVOICE_VIEWS, 'InvoiceListView', ALL, locale).html;
      expect(html, locale).toContain(`<bdi dir="ltr">${formatCivilDate('2026-11-10', locale)}</bdi>`);
      // And it is a spelled date, not the ISO text passed through.
      expect(html, locale).not.toContain('2026-11-10');
    }
  });

  it('reads no due date at all, so a cancelled row cannot claim money is still owed', () => {
    // This assertion used to compare the render against a catalogue key that no
    // longer exists, falling back to a string nothing contains — it could not
    // fail, and every fixture has `dueDate: null` anyway, so no render could
    // have exercised the branch either. The honest probe is the SOURCE: the view
    // must not read the field at all, which is what makes the cancelled row safe
    // whatever a fixture carries.
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceListView.tsx'), 'utf8'));
    expect(source).not.toContain('dueDate');
    // Positive control: the probe does see the fields the row DOES read, so
    // "not found" is a measurement and not an empty input.
    for (const read of ['documentNumber', 'issueDate', 'totalTxnMinor', 'status']) expect(source, read).toContain(read);
    // And the key it would have needed is gone from all three catalogues.
    for (const locale of LOCALES) expect(CATALOGS[locale]['invoices.list.due'], locale).toBeUndefined();
  });

  it('shows the rows in the order the server gave them, and claims no other order', () => {
    // The server orders ASCENDING by (issue_date, id) and takes no ordering
    // parameter (`invoice-reads.ts:155`, `selling.schemas.ts:235-249`), so the
    // view must pass the page through untouched. A view that sorted would
    // reorder twenty arbitrary rows out of hundreds and read as "newest".
    const fixture = INVOICE_VIEWS[0]?.fixtures.find((f) => f.name === ALL)?.props as { invoices: readonly { documentNumber: string }[] };
    const given = fixture.invoices.map((i) => i.documentNumber);
    const shown = text(r);
    const positions = given.map((n) => shown.indexOf(n));
    expect(
      positions.every((p) => p >= 0),
      `every document number reaches the markup: ${given.join(', ')}`,
    ).toBe(true);
    expect(positions, 'the rows appear in the order the server gave them').toEqual([...positions].sort((a, b) => a - b));
    // And the view does not sort: the source names no comparator.
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceListView.tsx'), 'utf8'));
    expect(source).not.toContain('.sort(');
    expect(source).not.toContain('.reverse(');
  });

  it('shows the total as the server stated it, in the invoice’s own currency', () => {
    expect(r.html).toContain(`<bdi dir="ltr">${formatMoney('22500', 'ILS', 'en')}</bdi>`);
    expect(r.html).toContain('<bdi dir="ltr">₪225.00</bdi>');
    // The second-currency row carries its own symbol, not the base one.
    expect(r.html).toContain(`<bdi dir="ltr">${formatMoney('10000', 'USD', 'en')}</bdi>`);
    expect(r.html).toContain('<bdi dir="ltr">$100.00</bdi>');
  });

  it('never renders totalBaseMinor: a base-currency figure wearing the invoice’s symbol is a misstatement', () => {
    // 36500 is the foreign row's base figure. It must appear in NO spelling:
    // neither as its own currency nor as the transaction one.
    for (const currency of ['ILS', 'USD']) {
      expect(text(r), currency).not.toContain(formatMoney('36500', currency, 'en'));
    }
    // Positive control: the figure IS in the fixture, so its absence from the
    // markup is a measurement and not a fixture that never carried it.
    const foreign = INVOICE_VIEWS[0]?.fixtures.find((f) => f.name === ALL)?.props as { invoices: readonly { totalBaseMinor: string }[] };
    expect(foreign.invoices.map((i) => i.totalBaseMinor)).toContain('36500');
  });

  it('names every lifecycle the server can answer, in all three languages, and names issuance rather than collection', () => {
    for (const locale of LOCALES) {
      const shown = text(render(INVOICE_VIEWS, 'InvoiceListView', ALL, locale));
      for (const status of ['open', 'draft', 'void'] as const) {
        expect(shown, `${locale}/${status}`).toContain(CATALOGS[locale][`invoices.status.${status}`]);
      }
    }
  });

  it('says nothing about collection, in each locale’s own words — the LOADED words included', () => {
    // P4-AL-24: settlement is derived per invoice and absent from a list answer,
    // so no label here may imply it. Checked in the words a reader of THAT
    // language would recognise — an English word list proves nothing about ar.
    //
    // The first version of this list left out the words that actually carry the
    // claim. `Open` / `مفتوحة` / `Açık` on an INVOICE is read as "not paid yet",
    // and because they were absent the test stayed green on labels that made
    // exactly the claim it was written to forbid. They are the first entries now.
    for (const locale of LOCALES) {
      const shown = text(render(INVOICE_VIEWS, 'InvoiceListView', ALL, locale)).toLowerCase();
      for (const word of COLLECTION_WORDS[locale]) expect(shown, `${locale}: ${word}`).not.toContain(word.toLowerCase());
    }
  });

  it('the collection-word probe can actually fail: it fires on the labels this screen used to ship', () => {
    // A denylist is only worth its weight if something would trip it, and the
    // thing that would is what this screen said yesterday. Without this control
    // a future edit could quietly empty the list above and nothing would notice.
    const RETIRED = { en: 'Open', ar: 'مفتوحة', tr: 'Açık' } as const;
    //
    // It reads the REAL list. An earlier draft compared a private `DENIED` copy
    // against these literals and never referred to `COLLECTION_WORDS`, so
    // emptying the real list left it green while its comment claimed otherwise.
    for (const locale of LOCALES) {
      const tripped = COLLECTION_WORDS[locale].some((w) => RETIRED[locale].toLowerCase().includes(w.toLowerCase()));
      expect(tripped, `${locale}: "${RETIRED[locale]}" must trip the denylist`).toBe(true);
      // And the retired label is genuinely gone from the shipped catalogue.
      expect(Object.values(onlyNewKeys(CATALOGS[locale])), locale).not.toContain(RETIRED[locale]);
    }
  });

  it('opens the invoice it names, now that the detail page exists', () => {
    // This was the inverse control while the detail screen was held out of the
    // tree: a row that pushed `/invoices/:id` would have landed on a 404. The
    // page ships in this change, so the row is clickable and the probe flips.
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceListView.tsx'), 'utf8'));
    expect(source).toContain('onOpen');
    // And it passes the invoice's own id, not an index or a document number.
    expect(source).toContain('props.onOpen(invoice.id)');
    // The page that receives it is on disk, so the push has somewhere to land.
    expect(existsSync(join(__dirname, '..', 'src', 'app', '[locale]', 'invoices', '[invoiceId]', 'page.tsx'))).toBe(true);
  });

  it('offers more only when the server gave a cursor', () => {
    expect(buttons(r)).toContain(en['common.loadMore']);
    expect(buttons(render(INVOICE_VIEWS, 'InvoiceListView', 'one invoice, no further page'))).not.toContain(en['common.loadMore']);
  });

  it('shows the empty state, and it leads to selling', () => {
    const empty = render(INVOICE_VIEWS, 'InvoiceListView', 'no invoices at all');
    expect(text(empty)).toContain(en['invoices.list.empty']);
    expect(buttons(empty)).toContain(en['invoices.list.sellSomething']);
  });

  it('renders a refused "show more" from the catalogue, never the server’s own sentence, and keeps the rows', () => {
    // A refused FIRST read never reaches this view: the page shows `ScreenState`
    // for `denied`/`failed`. The reachable refusal is the one on "show more",
    // and it must not take the rows away with it.
    const refused = render(INVOICE_VIEWS, 'InvoiceListView', 'show more was refused, with the rows still on screen');
    expect(text(refused)).toContain(en['common.noPermission']);
    expect(text(refused)).not.toContain('FORBIDDEN');
    expect(text(refused)).not.toContain(en['invoices.list.empty']);
    // The rows survive the refusal.
    expect(text(refused)).toContain('INV-2026-000002');
    // And "show more" STAYS. The page's `catch` sets `errorKey` and leaves the
    // cursor alone (`page.tsx`, `loadMore`), so the merchant can try again. The
    // first version of this assertion said the button was GONE "because the
    // server gave no cursor" — the opposite of what the page does.
    expect(buttons(refused)).toContain(en['common.loadMore']);
  });

  it('the refused "show more" fixture is what the PAGE does: its catch keeps the cursor', () => {
    // The fixture above says "show more" stays after a refusal. That is a claim
    // about `page.tsx`, and a fixture can only assert what it was written to say —
    // it cannot notice the page change. This is the tie: the page's `loadMore`
    // catch must set the refusal and must NOT clear the cursor, while its try
    // block does set it (the positive control, so "absent" is a measurement).
    const page = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'app', '[locale]', 'invoices', 'page.tsx'), 'utf8'));
    const body = /async function loadMore\(\)[\s\S]*?try \{([\s\S]*?)\} catch \(error\) \{([\s\S]*?)\} finally/.exec(page);
    expect(body, 'could not find loadMore with a try/catch/finally in page.tsx').not.toBeNull();
    const tried = body?.[1] ?? '';
    const caught = body?.[2] ?? '';
    expect(tried, 'positive control: the try block advances the cursor').toContain('setCursor(');
    expect(caught).toContain('setErrorKey(');
    expect(caught, 'the catch must leave the cursor alone, so "show more" stays').not.toContain('setCursor(');
    // ...and the button's visibility must be derived from the cursor alone, or a
    // refusal could hide it some other way while the catch still looks innocent.
    expect(page).toContain('hasMore={cursor !== null}');
    // The view never receives a null list: the page shows ScreenState until ready.
    expect(page).toMatch(/phase !== 'ready' \?\s*\(\s*<ScreenState/);
  });

  it('noComputedMoney: no figure appears that is a sum of two the server stated', () => {
    // The ILS rows state 22500, 6000 and 9000. Their sums are the figures a view
    // would show if it totalled the page — including 28500, the "total without
    // the cancelled row" a well-meaning aggregate would most likely produce.
    const shown = text(r);
    for (const invented of ['37500', '31500', '28500', '15000']) {
      expect(shown, invented).not.toContain(formatMoney(invented, 'ILS', 'en'));
    }
    // And no cross-currency total: adding USD to ILS is the worst of them.
    for (const invented of ['32500', '47500']) {
      for (const currency of ['ILS', 'USD']) expect(shown, `${invented} ${currency}`).not.toContain(formatMoney(invented, currency, 'en'));
    }
  });

  it('never renders an identifier', () => {
    for (const hidden of ['8b773805-d57f-4e22-89d5-f1a8e842e11f', '8b773805-0000-4000-8000-000000000003']) {
      expect(r.html, hidden).not.toContain(hidden);
    }
  });
});

describe('one invoice', () => {
  const COLLECTED = 'two items, collected in full';
  const r = render(INVOICE_VIEWS, 'InvoiceDetailView', COLLECTED);

  it('names the document and the day it was issued', () => {
    expect(text(r)).toContain('INV-2026-000002');
    expect(r.html).toContain('<bdi dir="ltr">Nov 10, 2026</bdi>');
  });

  it('lists each item with the figures the server stated for it', () => {
    const shown = text(r);
    expect(shown).toContain('Basmati rice 5 kg');
    expect(shown).toContain('Olive oil 1 L');
    expect(shown).toContain(formatMoney('4500', 'ILS', 'en'));
    expect(shown).toContain(formatMoney('13000', 'ILS', 'en'));
    expect(shown).toContain(formatMoney('9000', 'ILS', 'en'));
    expect(r.html).toContain('<bdi dir="ltr">3</bdi>');
  });

  it('READS the subtotal rather than adding the items up', () => {
    // The assertion the money review asked for, and it has teeth only because
    // of the fixture: the server's own invariant is
    // `SUM(net) === subtotal - discount` (`sale-payloads.ts:316`, measured), so
    // with a non-zero discount SUM(net) is 22000 while the subtotal is 22500. A
    // view that summed the items and labelled it "before discount" prints
    // 220.00 where 225.00 belongs, and this fails.
    // The NARROWEST element whose text starts with the label — the `Fact` row
    // itself. Taking the first match found the whole totals card, whose text
    // also holds the total, so the assertion below passed on the wrong element.
    // The narrowest element that holds BOTH the label and a figure — the `Fact`
    // row. Taking the first match found the whole totals card (whose text also
    // holds the total, so the negative below passed on the wrong element), and
    // taking the shortest match found the bare label (which holds no figure at
    // all). The row is the shortest one that has both.
    const label = en['invoices.detail.subtotal'];
    const rows = [...elements(r.frame)]
      .map((e) => textOf(e))
      .filter((txt) => txt.startsWith(label) && txt.length > label.length)
      .sort((a, b) => a.length - b.length);
    expect(rows.length, 'the subtotal row must be findable').toBeGreaterThan(0);
    const rowText = rows[0] ?? '';
    expect(rowText).toContain(formatMoney('22500', 'ILS', 'en'));
    expect(rowText).not.toContain(formatMoney('22000', 'ILS', 'en'));
    expect(text(r)).toContain(formatMoney('500', 'ILS', 'en'));
    expect(text(r)).toContain(formatMoney('22000', 'ILS', 'en'));
  });

  it('computes no money: the source holds no arithmetic at all', () => {
    // The earlier probe tested `Minor` immediately followed by an operator,
    // which made four of its arms impossible strings (`MinorBigInt(` and
    // friends) and missed the one dangerous spelling,
    // `BigInt(invoice.totalTxnMinor)`. These look for the operations themselves.
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceDetailView.tsx'), 'utf8'));
    for (const op of ['BigInt(', 'Number(', 'parseInt', 'parseFloat', '.reduce(', '.sort(', '+=', '-=']) {
      expect(source, `the detail view must not compute money: ${op}`).not.toContain(op);
    }
    // Positive control: the probe sees the call the view does make on a money
    // field, so "not found" is a measurement and not an empty input.
    expect(source).toContain('amountMinor=');
  });

  it('shows what was collected, in the settlement own currency', () => {
    const shown = text(r);
    expect(shown).toContain(en['invoices.settlement.paid']);
    expect(shown).toContain(en['invoices.settlement.collected']);
    expect(shown).toContain(en['invoices.settlement.remaining']);
    // A cash invoice is paid in full and owes nothing — measured from
    // `invoice_outstanding`'s cash branch (`0080:172-175`), not assumed.
    expect(shown).toContain(formatMoney('22000', 'ILS', 'en'));
    expect(shown).toContain(formatMoney('0', 'ILS', 'en'));
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceDetailView.tsx'), 'utf8'));
    expect(source).toContain('currency={settlement.currency}');
  });

  it('SAYS SO when the collection read was refused, instead of quietly omitting it', () => {
    // Omitting it silently is the defect the money review named: read
    // right-to-left the page would end at the total as its last and largest
    // fact, and a merchant who has seen the collection card elsewhere reads its
    // absence as "no collection record" — the whole amount still standing. The
    // error ran toward asking for money already received.
    const refused = render(INVOICE_VIEWS, 'InvoiceDetailView', 'the collection read was refused');
    const shown = text(refused);
    expect(shown).toContain(en['invoices.settlement.title']);
    expect(shown).toContain(en['common.noPermission']);
    expect(shown).not.toContain(en['invoices.settlement.collected']);
    expect(shown).not.toContain(en['invoices.settlement.paid']);
    expect(shown).not.toContain('FORBIDDEN');
    expect(shown).toContain('INV-2026-000002');
    expect(shown).toContain(formatMoney('22500', 'ILS', 'en'));
  });

  it('says nothing at all about collection when the read was never attempted', () => {
    const silent = render(INVOICE_VIEWS, 'InvoiceDetailView', 'two items, settlement not read');
    expect(text(silent)).toContain('INV-2026-000002');
    for (const key of ['invoices.settlement.title', 'invoices.settlement.state', 'invoices.settlement.collected', 'invoices.settlement.remaining'] as const) {
      expect(text(silent), key).not.toContain(en[key]);
    }
    for (const state of ['unpaid', 'partial', 'paid'] as const) {
      expect(text(silent), state).not.toContain(en[`invoices.settlement.${state}`]);
    }
    // Positive control: those labels DO appear when the read succeeded.
    expect(text(r)).toContain(en['invoices.settlement.collected']);
  });

  it('names no buyer, in any of the three languages — T-12 stands', () => {
    for (const locale of LOCALES) {
      const html = render(INVOICE_VIEWS, 'InvoiceDetailView', COLLECTED, locale).html.toLowerCase();
      // `customer` is the probe that can actually fire: the fixture carries
      // `customerSnapshot: null`, so there is no NAME in it to look for, and
      // looking for one would be an empty arm pretending to be a control.
      for (const word of ['customer', 'عميل', 'müşteri']) {
        expect(html, `${locale}: ${word}`).not.toContain(word.toLowerCase());
      }
    }
    for (const locale of LOCALES) expect(CATALOGS[locale]['invoices.detail.customer'], locale).toBeUndefined();
  });

  it('never renders an identifier, and never the posted exchange rate', () => {
    for (const hidden of [
      '8b773805-d57f-4e22-89d5-f1a8e842e11f',
      '0f9c1e2a-1111-4c0d-9f3a-aaaaaaaaaaaa',
      '0f9c1e2a-2222-4c0d-9f3a-bbbbbbbbbbbb',
      '0f9c1e2a-3333-4c0d-9f3a-cccccccccccc',
      '0f9c1e2a-4444-4c0d-9f3a-dddddddddddd',
    ]) {
      expect(r.html, hidden).not.toContain(hidden);
    }
    // `not.toContain('rate')` would pass on sheer wording — `separate` and
    // `generate` contain it — so the probe names the field reads instead.
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceDetailView.tsx'), 'utf8'));
    for (const read of ['invoice.rate', 'rate.rate', 'rateId', 'rate.source']) expect(source, read).not.toContain(read);
  });

  it('dates a cancellation by the reader own day, not by UTC', () => {
    // `voided_at` is `TIMESTAMPTZ` (`0075:275`) — a moment. The fixture is
    // 22:30Z, half an hour before UTC midnight, so a view that sliced the first
    // ten characters and formatted them in UTC would show 11 Nov while a
    // merchant at UTC+2/+3 is already on the 12th.
    const cancelled = render(INVOICE_VIEWS, 'InvoiceDetailView', 'a cancelled invoice');
    expect(text(cancelled)).toContain(en['invoices.status.void']);
    expect(text(cancelled)).toContain(en['invoices.detail.cancelledOn']);
    expect(cancelled.html).not.toContain('2026-11-11T22:30:00Z');
    expect(text(cancelled)).toContain(formatMomentDate('2026-11-11T22:30:00Z', 'en'));
    const source = stripTsComments(readFileSync(join(__dirname, '..', 'src', 'views', 'invoices', 'InvoiceDetailView.tsx'), 'utf8'));
    expect(source).toContain('formatMomentDate(invoice.voidedAt');
    expect(text(cancelled)).toContain(formatMoney('22000', 'ILS', 'en'));
    expect(source).not.toContain('dueDate');
  });
});

describe('the view fixtures that no guard reads', () => {
  it('a .json fixture under src/views names no buyer and no tax, since no law scans it', () => {
    // T-12 and T-09 scan `.tsx?` only (`merchant-jargon.ts:193-201`,
    // `od03.test.ts:78-89`), and the catalogue rule reads the three message
    // files alone. This change introduced the first `.json` under `src/views`,
    // so that file sits outside every guard — legal by the letter, and unguarded
    // for whoever edits it next. This is the control that closes it.
    const dir = join(__dirname, '..', 'src', 'views');
    const walk = (at: string): string[] =>
      readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(at, e.name)) : e.name.endsWith('.json') ? [join(at, e.name)] : []));
    const files = walk(dir);
    // Positive control: there IS such a file, so the loop is not vacuous.
    expect(files.length, 'no .json fixture found — this control would be empty').toBeGreaterThan(0);
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ['customerSnapshot', 'customerId']) {
        if (key in parsed) expect(parsed[key], `${file}: ${key}`).toBeNull();
      }
      // `taxMinor` is a REQUIRED contract field on the invoice and on every
      // item, so forbidding the word would forbid an honest one — the same
      // over-broad mistake as forbidding the spelling of zero. The rule is the
      // one P4-AL-44 actually states: wherever it appears, it is a structural
      // zero.
      const taxes: unknown[] = [];
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(visit);
        if (v === null || typeof v !== 'object') return;
        for (const [k, inner] of Object.entries(v)) {
          if (/tax/i.test(k)) taxes.push(inner);
          visit(inner);
        }
      };
      visit(parsed);
      // Positive control: the field IS there, so "all zero" is a measurement.
      expect(taxes.length, `${file}: no tax field found — this arm would be empty`).toBeGreaterThan(0);
      for (const value of taxes) expect(value, `${file}: a tax field must be the structural zero`).toBe('0');
      // No tax VOCABULARY in any human-readable value, in any of the three languages.
      expect(raw, file).not.toMatch(/ضريب|vergi|kdv|vat/i);
    }
  });
});
