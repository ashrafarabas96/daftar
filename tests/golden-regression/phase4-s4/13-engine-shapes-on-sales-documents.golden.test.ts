import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintDomainReversalAssertion } from '@daftar/accounting';
import { postReversalAs } from '../../helpers/accounting-posting';
import { testMinter } from '../../helpers/inventory-posting';
import { entrySnapshot } from '../../helpers/purchase-returns';
import { committed, createMethod } from '../../helpers/supplier-settlement';
import { ownerPool } from '../../helpers/test-app';
import { expected, type PersistedLine, type Shape } from '../phase2/engine-shapes';
import { entryOfSource, must, systemAccountId } from './harness';
import { collectPayment } from './settlement-path';
import { newCustomer, sellOnCredit, settlementWorld, stockUp, type SettlementWorld } from './settlement-world';

/**
 * GOLDEN REGRESSION — AN ENGINE SHAPE CARRIED BY A REAL SALES DOCUMENT
 * (`DR-115`/1, owner's decision 2026-11-11).
 *
 * WHY THIS FILE EXISTS. `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts`
 * proves the posting engine can express a future domain's journal before that
 * domain exists, and it does so by posting each shape with a
 * `manual_adjustment` source identity standing in for the record the domain
 * will create. That stand-in is now REFUSED on two accounts: migration
 * `0090_mvp03_ar_source_document_guard.sql` (`DR-114`/ثالثًا/2) requires every
 * `journal_lines` row on `accounts_receivable` or `customer_credit_liability`
 * to belong to a sales document, because a hand-written journal there holds
 * debt that no join can put behind a customer's name (`journal_lines` carries
 * `branch_id` and `warehouse_id` and no counterparty column, `0042`).
 *
 * The owner's instruction was to MOVE THE CARRIER, not to weaken the guard and
 * not to delete a golden: the shape stays, the stand-in goes, and a real
 * document produces the journal. This suite is where that happens, because
 * this is the suite that already owns the whole selling world — a business, a
 * catalogue, priced stock, a customer, a payment method, an invoice through
 * `POST /v1/sales` and a collection through `POST /v1/customer-payments`.
 *
 * WHAT IS PROVED HERE THAT WAS NOT PROVED BEFORE, and it is not a smaller
 * claim than the old one — it is strictly larger:
 *
 *   1. the shape is still asserted LINE BY LINE over the same eleven columns,
 *      from the same `Shape` literal and the same `expected()`, both imported
 *      from `../phase2/engine-shapes` rather than copied. That is how
 *      "unchanged by a letter" is PROVED instead of claimed: there is one
 *      copy, so the two suites cannot disagree about it;
 *   2. and the journal now comes from a document a merchant can actually
 *      raise, so the shape is no longer only REPRESENTABLE — it is PRODUCED.
 *
 * ONE SHAPE, AND WHY ONLY ONE. Of the eight shapes the guard refuses, this is
 * the only one a document on this head reproduces column for column, `line_no`
 * included. The other seven stay in the Phase 2 suite as refusal tests with
 * their shapes and sentences intact, each with its own measured reason
 * (`MVP03_SOURCE_OF_TRUTH_2026-11-10_AR.md` §16, and the comment on
 * `refusedWithoutASalesDocument` there). Two of them — `GOLD-65` and
 * `GOLD-66` — are produced by a real credit application's reversal in every
 * respect EXCEPT the order of their two lines, and reordering a sealed golden
 * is the one thing `DR-115`/1 forbids.
 *
 * AND IT EXERCISES THE GUARD'S TRANSITIVE ARM ON A REAL DOCUMENT. The carrier
 * is a `reversal`, which the guard admits only when the entry it reverses is
 * itself a sales document (`MVP03-م-1`). The integration suite proves that arm
 * refuses `manual_adjustment` and `opening_balance`; nothing proved it ADMITS
 * a real allocation until here.
 */

/** The shape, verbatim from the Phase 2 suite — not one character of it is new. */
const GOLD_87: Shape = {
  id: 'GOLD-87',
  title: 'card chargeback on an allocated payment',
  lines: [
    { account: 'accounts_receivable', side: 'D', base: 300 },
    { account: 'card_clearing', side: 'C', base: 300 },
  ],
};

/**
 * The money the shape is about: 300 whole base units, which is what
 * `minor(300)` in the shared vocabulary makes of it. The catalogue price of
 * `shop.piece` is 1000 minor units (`stock-ledger.ts:1542`), so thirty of
 * them invoice for exactly 30000 — and the suite ASSERTS that rather than
 * trusting it, because a catalogue price that moved would otherwise turn this
 * golden quietly into a golden about a different number.
 */
const QUANTITY = '30';
const TOTAL_MINOR = '30000';

let w: SettlementWorld;
/** The method the chargeback's money originally came in through: a CARD. */
let cardMethodId: string;

beforeAll(async () => {
  w = await settlementWorld('gold-87-chargeback');
  const cardClearing = must(await systemAccountId(ownerPool(), w.shop.businessId, 'card_clearing'), `the business's card_clearing system account`);
  cardMethodId = await committed((c) =>
    createMethod(c, w.shop, { postingAccountId: cardClearing, systemType: 'card', names: { ar: 'بطاقة', en: 'Card', tr: null } }),
  );
  await stockUp(w, '200', '7');
});

/** The stored rows of one entry, in the eleven columns the shared `expected()` speaks. */
async function storedLines(entryId: string): Promise<PersistedLine[]> {
  const rows = await ownerPool().query<PersistedLine>(
    `SELECT l.line_no, a.code, a.system_key,
            l.debit_minor::text, l.credit_minor::text, l.base_amount_minor::text, l.base_currency,
            l.txn_amount_minor::text, l.txn_currency, l.fx_rate::text, l.fx_rate_source
       FROM journal_lines l
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.journal_entry_id = $1
      ORDER BY l.line_no`,
    [entryId],
  );
  return rows.rows;
}

describe('golden: an engine shape carried by a real sales document (DR-115/1, GOLD-87)', () => {
  it('a card payment allocated in full, then reversed, posts GOLD-87 exactly: 300 back onto AR, 300 off card clearing', async () => {
    // ── the document half: a real credit invoice and a real card collection ──
    const customerId = await newCustomer(w);
    const invoice = await sellOnCredit(w, customerId, QUANTITY);
    expect(
      invoice.totalTxnMinor,
      `the catalogue must still invoice ${TOTAL_MINOR} minor units for ${QUANTITY} pieces, or this golden is about another number`,
    ).toBe(TOTAL_MINOR);
    expect(invoice.currencyCode, 'a base-currency invoice, so the shape carries no foreign leg').toBe('ILS');

    const paymentId = randomUUID();
    const allocationId = randomUUID();
    const collected = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId,
      paymentMethodId: cardMethodId,
      paymentDate: w.day,
      amountMinor: TOTAL_MINOR,
      allocations: [
        {
          allocationId,
          invoiceId: invoice.invoiceId,
          appliedMinor: TOTAL_MINOR,
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
      ],
    });
    expect(collected.status, `the card collection is accepted: ${JSON.stringify(collected.body)}`).toBe(201);

    const allocationEntryId = must(
      await entryOfSource(ownerPool(), w.shop.businessId, 'customer_payment_allocation', allocationId),
      `the journal entry of allocation ${allocationId}`,
    );

    // ── the carrier: the Phase 2 reversal of that document's own entry ──────
    // Prepared exactly as a domain service prepares one: the original read
    // back AS PERSISTED, and the assertion minted by the real
    // `mintDomainReversalAssertion` over that snapshot. A reversal whose lines
    // a test chose would prove nothing about what the document produces.
    const original = await entrySnapshot(ownerPool(), w.shop.businessId, allocationEntryId);
    expect(original.sourceType, 'the entry being reversed is the ALLOCATION’s, which is what makes the guard admit the reversal').toBe(
      'customer_payment_allocation',
    );
    const reversal = await postReversalAs(
      mintDomainReversalAssertion(testMinter, original, w.day, w.shop.userId),
      allocationEntryId,
      w.day,
      'GOLD-87: the card issuer took the money back',
      `golden-gold-87-${allocationId}`,
    );
    expect(reversal.created, 'GOLD-87 was expected to create a new reversing entry').toBe(true);

    // ── the assertion: the shared `expected()`, unchanged, over the stored rows
    expect(await storedLines(reversal.entryId)).toEqual(expected(GOLD_87));

    // And — separately, as the Phase 2 suite does — that it balances. A
    // balanced entry made of the wrong accounts is the defect the line-by-line
    // assertion above exists to catch, so this is never the whole claim.
    const debits = GOLD_87.lines.filter((l) => l.side === 'D').length;
    const credits = GOLD_87.lines.filter((l) => l.side === 'C').length;
    expect(debits + credits, 'GOLD-87 is a two-line shape').toBe(2);
  });
});
