import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/phase3-format';
import { LOCALES, renderFixture } from './helpers/render';
import { registeredFixtures } from './helpers/registries';

/**
 * A-13 FOR THE POS RECEIPT, after the receipt became a `SaleDto`.
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────
 * The POS receipt used to be an invented `PosSaleReceiptDto` carrying
 * `businessTransactionId` and `movementIds`, and `invisible.test.tsx` (T-08)
 * caught those two by NAME: `HIDDEN_FIELD` matches `businessTransactionId`,
 * `movementId(s)`, `*EntryId`, the stock sequences, the base variant and the
 * posting account.
 *
 * P4-S3's register finishes a sale through P4-S2's `POST /v1/sales`, so the
 * receipt is a real `SaleDto` — and a `SaleDto` has NEITHER of those fields.
 * What it does carry is a different set of things a merchant must not be
 * shown, and not one of their names matches `HIDDEN_FIELD`:
 *
 *   - `cogsBaseMinor` — the cost of goods the sale posted, read back from the
 *     ledger (`P4-AL-25`). It is the shop's margin, on the customer's receipt;
 *   - `totalBaseMinor`, `sourceToBaseRate`, `rateSource`, `rateTimestamp` —
 *     the FX snapshot the sale is bound to (`P4-AL-10`). An operator's trace;
 *   - each line's `baseShareMinor` — that line's integer share of the base
 *     total (`0043`'s per-line law);
 *   - `saleId`, `invoice.invoiceId`, `branchId`, `warehouseId` — the engine's
 *     identities. The merchant reads the receipt NUMBER, which is what the
 *     database rendered from the sequence row;
 *   - `status`, `settlementMode`, `replayed` — lifecycle and protocol facts.
 *
 * So T-08's coverage of the POS area did not get weaker by accident; it
 * stopped applying because the DTO changed under it. Extending `HIDDEN_FIELD`
 * was the wrong fix: it is shared by every registry, and `totalBaseMinor` is a
 * figure other Phase 4 surfaces legitimately report. This suite is the right
 * scope — the POS receipt's own fields, by value, in all three locales.
 *
 * Every value below is checked BY VALUE and the values are distinctive, so a
 * match is never chance; and each is asserted to be present in the fixture
 * first, so a renamed field makes this suite RED rather than vacuous.
 */

/** Every path through a `SaleDto` whose value a receipt must never render, with why. */
const INVISIBLE: Readonly<Record<string, string>> = {
  cogsBaseMinor: 'the cost of goods the sale posted — the shop margin (P4-AL-25)',
  totalBaseMinor: 'the base-currency total: the FX snapshot, not what the customer pays',
  sourceToBaseRate: 'the FX rate the sale is bound to (P4-AL-10)',
  rateTimestamp: 'when the FX snapshot was taken',
  baseShareMinor: "a line's integer share of the base total (0043)",
  saleId: "the engine's identity; the merchant reads the receipt number",
  invoiceId: "the invoice's identity; the number is what is printed",
  branchId: 'resolved by the server from the warehouse; not a fact of the receipt',
  warehouseId: 'the till session fixed it; a receipt does not state a stockroom id',
};

/** Every string value under one of those names, found anywhere in the props. */
function invisibleValues(props: unknown, out: { field: string; value: string }[] = [], field: string | null = null): { field: string; value: string }[] {
  if (props === null || props === undefined) return out;
  if (Array.isArray(props)) {
    for (const item of props) invisibleValues(item, out, field);
    return out;
  }
  if (typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) invisibleValues(v, out, k);
    return out;
  }
  if (field !== null && Object.hasOwn(INVISIBLE, field)) out.push({ field, value: String(props) });
  return out;
}

describe('A-13 — the POS receipt shows what was sold, never the engine behind it', () => {
  it('the rule fires on a planted value and ignores an ordinary one', () => {
    expect(invisibleValues({ sale: { cogsBaseMinor: '3310000', currencyCode: 'JOD' } })).toEqual([{ field: 'cogsBaseMinor', value: '3310000' }]);
    expect(invisibleValues({ sale: { lines: [{ baseShareMinor: '4154500' }] } })).toEqual([{ field: 'baseShareMinor', value: '4154500' }]);
    expect(invisibleValues({ sale: { totalTxnMinor: '7000' } })).toEqual([]);
  });

  it('every SaleDone fixture really carries each of them, so the claim below is not vacuous', async () => {
    const { fixtures } = await registeredFixtures();
    const receipts = fixtures.filter(({ area, entry }) => area === 'pos' && entry.name === 'SaleDoneView');
    expect(receipts.length).toBeGreaterThan(0);
    for (const { fixture, label } of receipts) {
      const fields = new Set(invisibleValues(fixture.props).map((v) => v.field));
      const missing = Object.keys(INVISIBLE).filter((field) => !fields.has(field));
      expect(missing, `${label} plants no value for: ${missing.join(', ')}`).toEqual([]);
      // Short values match by chance; these must not be able to.
      for (const { field, value } of invisibleValues(fixture.props)) expect(value.length, `${label} ${field}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('no receipt render emits one, in any locale', async () => {
    const { fixtures } = await registeredFixtures();
    const receipts = fixtures.filter(({ area, entry }) => area === 'pos' && entry.name === 'SaleDoneView');
    const leaked = receipts.flatMap(({ fixture, label }) =>
      LOCALES.flatMap((locale) => {
        const { html } = renderFixture(fixture, locale);
        return invisibleValues(fixture.props)
          .filter(({ value }) => html.includes(value))
          .map(({ field, value }) => `${label} [${locale}] ${field} = ${value} (${INVISIBLE[field] ?? ''})`);
      }),
    );
    expect(leaked).toEqual([]);
  });

  it('and it DOES show what the merchant reads: the number, the names and the three amounts', async () => {
    const { fixtures } = await registeredFixtures();
    const receipt = fixtures.find(({ area, entry }) => area === 'pos' && entry.name === 'SaleDoneView');
    if (receipt === undefined) throw new Error('no SaleDoneView fixture');
    const sale = Reflect.get(receipt.fixture.props as object, 'sale') as {
      currencyCode: string;
      subtotalTxnMinor: string;
      discountTxnMinor: string;
      totalTxnMinor: string;
      lines: { nameSnapshot: string }[];
    };
    for (const locale of LOCALES) {
      const { html } = renderFixture(receipt.fixture, locale);
      // The database rendered the number from the sequence row's format.
      expect(html, locale).toContain('S-2026-000417');
      // The product names as the server snapshotted them.
      for (const line of sale.lines) expect(html, `${locale} ${line.nameSnapshot}`).toContain(line.nameSnapshot);
      // The three amounts a receipt is for — the transaction-currency ones,
      // through the one formatter the screens use, so this says WHICH fields
      // reach the page and not how money is spelled.
      for (const amount of [sale.subtotalTxnMinor, sale.discountTxnMinor, sale.totalTxnMinor]) {
        expect(html, `${locale} ${amount}`).toContain(formatMoney(amount, sale.currencyCode, locale));
      }
    }
  });
});
