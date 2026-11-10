import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  must,
  postAdjustmentAs,
  postOpeningBalanceAs,
  refusal,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  openingBalanceFingerprintOf,
  fingerprintOf,
  type PostCommand,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { settlementWorld, settlementMissing, stockUp, newCustomer, sellOnCredit } from '../golden-regression/phase4-s4/settlement-world';
import { SYSTEM_KEYS } from '../golden-regression/phase4-s4/settlement-path';

/**
 * MVP-03 / DR-114/ثالثًا/2 — NO HAND-WRITTEN JOURNAL ON THE RECEIVABLE
 * CONTROL ACCOUNT, NOR ON THE CUSTOMER CREDIT LIABILITY.
 *
 * WHY THIS LAW EXISTS, measured and not reasoned. The probe on
 * `diag/mvp03-ar-source` @ `0451ef6a` (CI run 42875894978, evidence
 * `MVP03_SOURCE_OF_TRUTH_2026-11-10_AR.md` §12) asked both derivations of a
 * customer's debt after each of nine events. Through every path that goes by
 * a sales document the two agreed EXACTLY — delta 0, with every shekel
 * attributable to a named customer. Then it posted
 * `accounting_post_manual_adjustment` with a debit straight onto
 * `accounts_receivable`: 123,456 minor units, ACCEPTED, entry
 * 79269c76-ea51-4ce1-919c-63e97d8d6856 — and the journal held debt that no
 * join can put behind any customer's name, because `journal_lines` carries
 * `branch_id` and `warehouse_id` and no counterparty column (`0042`). The
 * same command on `customer_credit_liability` was accepted too (65,432 Cr).
 * So the statement a merchant reads and the control account a merchant trusts
 * can be made to disagree, today, through a granted command.
 *
 * THE LAW. A `journal_lines` row on either account must belong to an entry
 * whose `source_type` is one of that account's SALES DOCUMENTS:
 *
 *   accounts_receivable         → invoice · customer_payment_allocation ·
 *                                 customer_credit_application
 *   customer_credit_liability   → customer_credit ·
 *                                 customer_credit_application
 *
 * Those two sets are measured, not assumed: `0077:1457` is the only place an
 * `invoice` entry names the AR key, and `0081`'s three entry-complete
 * functions name exactly these — allocation (`:1463-1549`) touches AR alone,
 * the credit application (`:1550-1653`) touches both, the credit
 * (`:1654-…`) touches 2210 alone. A sweep of every migration on `main` for
 * the two quoted keys hits only `0040`, `0075`, `0077`, `0080` and `0081`,
 * and the mentions outside the posting functions are reads.
 *
 * A `reversal` is allowed TRANSITIVELY — only when the entry it reverses is
 * itself one of the above. That is a temporary decision of this lane
 * (MVP03-م-1 in `OWNER_QUEUE_AR.md`): an absolute ban, with the write-off
 * reducer deferred by `DR-114`/ثالثًا/1, would leave a wrongly posted invoice
 * permanently uncorrectable, which is worse than the thing being prevented.
 *
 * `manual_adjustment`, `opening_balance` and a `reversal` of either are
 * refused. The opening-balance arm carries its own owner decision
 * (`DR-114`/ثالثًا/3 and /4): old customer balances are entered as a
 * historical invoice per customer, with no exception.
 *
 * RED FIRST. Every refusal case below FAILS on `main` @ `4c878e0f`, because
 * `accounting_open_balance_post` is granted to `daftar_app` (`0047:1049`) and
 * its only restriction is that `opening_equity` may not be stated as a
 * position (`0047:519`), and `accounting_post_entry` is granted at
 * `0045:867`. The migration that makes them pass is the next commit.
 */

/**
 * The marker the guard puts in its own message.
 *
 * The cases assert on THIS and not merely on "it threw": a refusal that comes
 * from a balance rule, a period rule or a fingerprint rule would otherwise be
 * read as this law speaking, which is exactly the false positive RULE-27 was
 * written from.
 */
const GUARD_MARKER = 'MVP03_AR_SOURCE_DOCUMENT_GUARD';

const AR_KEY = SYSTEM_KEYS.accountsReceivable;
const CREDIT_KEY = SYSTEM_KEYS.customerCreditLiability;
const AT = new Date('2026-03-14T09:15:00Z');

let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

/** A business of its own per case: the one-posted-set rule makes each case a new tenant. */
async function freshBusiness(label: string): Promise<PostingFixture> {
  return seedPostingFixture(ownerPool(), `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
}

function line(systemKey: string, side: 'D' | 'C', amount: bigint): PostLine {
  return {
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: AT,
    branchId: null,
    warehouseId: null,
  };
}

/** A balanced two-line `manual_adjustment` whose FIRST line is the account under test. */
function adjustmentOn(f: PostingFixture, systemKey: string, side: 'D' | 'C', amount: bigint): PostCommand {
  return {
    tenantId: f.tenantId,
    businessId: f.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: today,
    description: 'a merchant correction straight onto a control account',
    requestId: `req-${randomUUID()}`,
    lines: [line(systemKey, side, amount), line('sales_revenue', side === 'D' ? 'C' : 'D', amount)],
  };
}

function assertionForAdjustment(f: PostingFixture, c: PostCommand): string {
  return sourceAssertion({
    actorUserId: f.userId,
    tenantId: f.tenantId,
    businessId: f.businessId,
    operationKind: 'post',
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
}

describe('MVP-03 — a hand-written journal on the receivable control account is refused', () => {
  it('refuses a manual adjustment that debits accounts_receivable', async () => {
    const f = await freshBusiness('mvp03-ar-dr');
    const c = adjustmentOn(f, AR_KEY, 'D', 123456n);
    const message = await refusal(() => postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants the debt higher'));
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);

  it('refuses a manual adjustment that credits accounts_receivable', async () => {
    const f = await freshBusiness('mvp03-ar-cr');
    const c = adjustmentOn(f, AR_KEY, 'C', 98765n);
    const message = await refusal(() => postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants the debt lower'));
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);

  it('refuses a manual adjustment that credits customer_credit_liability', async () => {
    const f = await freshBusiness('mvp03-cl-cr');
    const c = adjustmentOn(f, CREDIT_KEY, 'C', 65432n);
    const message = await refusal(() => postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants to owe a customer'));
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);

  it('refuses a manual adjustment that debits customer_credit_liability', async () => {
    const f = await freshBusiness('mvp03-cl-dr');
    const c = adjustmentOn(f, CREDIT_KEY, 'D', 4321n);
    const message = await refusal(() => postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants to owe a customer less'));
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);
});

describe('MVP-03 — an opening balance may not state a receivable position either', () => {
  /**
   * `DR-114`/ثالثًا/3 and /4. The merchant's old customer balances are a real
   * need and this refusal is what forces them down the only path that keeps a
   * customer's name on the money: a historical invoice per customer.
   */
  async function openingRefusal(label: string, systemKey: string, side: 'D' | 'C', amount: bigint): Promise<string> {
    const f = await freshBusiness(label);
    const openingBalanceId = randomUUID();
    const positions: readonly PostLine[] = [line(systemKey, side, amount)];
    const assertion = sourceAssertion({
      actorUserId: f.userId,
      tenantId: f.tenantId,
      businessId: f.businessId,
      operationKind: 'post',
      sourceType: 'opening_balance',
      sourceId: openingBalanceId,
      postingFingerprint: openingBalanceFingerprintOf({
        tenantId: f.tenantId,
        businessId: f.businessId,
        openingBalanceId,
        asOfDate: today,
        baseCurrency: 'ILS',
        positions,
      }),
    });
    return refusal(() =>
      postOpeningBalanceAs(assertion, {
        asOfDate: today,
        positions,
        openingBalanceId,
        description: 'the balances the merchant arrived with',
        requestId: `req-${randomUUID()}`,
      }),
    );
  }

  it('refuses an opening balance that states accounts_receivable', async () => {
    const message = await openingRefusal('mvp03-ob-ar', AR_KEY, 'D', 777000n);
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);

  it('refuses an opening balance that states customer_credit_liability', async () => {
    const message = await openingRefusal('mvp03-ob-cl', CREDIT_KEY, 'C', 31000n);
    expect(message, `the refusal must come from this law, not from another rule: ${message}`).toContain(GUARD_MARKER);
  }, 120_000);
});

describe('MVP-03 — the guard is narrow, and the legitimate paths still pass', () => {
  /**
   * THE POSITIVE CONTROL THE OWNER ASKED FOR, in two halves.
   *
   * A law that refused everything would make every case above green while
   * breaking the product, and a green suite is exactly how such a law hides.
   * So: a manual adjustment that touches NEITHER account still posts, and a
   * real credit sale still writes its AR line.
   */
  it('still accepts a manual adjustment on accounts the law does not name', async () => {
    const f = await freshBusiness('mvp03-narrow');
    const c = simpleCommand(f, randomUUID(), today, 150000n);
    const outcome = await postAdjustmentAs(assertionForAdjustment(f, c), c, 'an ordinary correction on cash');
    expect(outcome.created, 'the machine is alive and the guard is narrow').toBe(true);
  }, 120_000);

  it('still writes the AR line of a real credit invoice, owned by its invoice', async () => {
    const w = await settlementWorld('mvp03 guard positive control');
    const missing = await settlementMissing(w);
    expect(missing, `the settlement subject must be complete on this head: ${missing.join(', ')}`).toEqual([]);
    await stockUp(w, '1000', '1000');
    const customerId = await newCustomer(w);
    const invoice = await sellOnCredit(w, customerId, '10');

    const r = await ownerPool().query<{ source_type: string; signed_minor: string }>(
      `SELECT e.source_type, sum(l.debit_minor - l.credit_minor)::text AS signed_minor
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1 AND a.system_key = $2
        GROUP BY e.source_type`,
      [w.shop.businessId, AR_KEY],
    );
    const rows = r.rows;
    expect(
      rows.map((x) => x.source_type),
      'the invoice, and nothing else, owns the AR money',
    ).toEqual(['invoice']);
    expect(must(rows[0], 'the AR row').signed_minor, 'the whole invoice sits on AR').toBe(invoice.totalBaseMinor);
  }, 600_000);
});
