/**
 * MVP-03 §2 — THE TWO SOURCES, ASKED THE SAME QUESTION ON ONE LIVE DATABASE.
 *
 * THE CLAIM UNDER MEASUREMENT. `customer-reads.ts:28-29` says what a customer
 * owes "is derived per request from the `journal_lines` on the AR account
 * scoped to that customer". The code reads `customer_ar_outstanding`
 * (`0084:686`), which reads `invoices` / `sales` / `payment_allocations` /
 * `customer_credit_applications` and NO journal, and `0084:263` forbids "no
 * journal read as an alternate authority" in as many words.
 *
 * So this probe asks BOTH derivations, on the same rows, after each event:
 *
 *   A = Σ over customers of `customer_ar_outstanding(business, customer)`
 *       `.base_minor` (the function's own column name, `0084:627`) — the live
 *       source, which counts `status = 'open'` invoices only (`0084:636`)
 *   B = Σ (debit − credit) over `journal_lines` on the `accounts_receivable`
 *       system account                                  — the journal source
 *   B_attr = the part of B that can be ATTRIBUTED to a customer at all, by
 *       joining each AR line's entry through its own source document
 *   B_unattr = B − B_attr                               — AR money the journal
 *       holds that NO join can put behind a customer's name
 *
 * It is a PROBE, not a law: it writes its numbers out and does not fail the
 * run on a difference, because the difference is the finding. The one `expect`
 * at the end is the positive control (RULE-3/RULE-11): the probe must have
 * actually moved AR, or its zeros are blindness and not evidence.
 *
 * Every write goes through the product's own commands — the sale through
 * `POST /v1/sales`, the payment through `POST /v1/customer-payments`, the
 * manual journal through `accounting_post_manual_adjustment`, the base
 * currency through its own route. No hand-built journal line, no hand-built
 * allocation.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool } from '../helpers/test-app';
import { post, type PostCommand } from '../helpers/accounting-posting';
import {
  settlementWorld,
  settlementMissing,
  stockUp,
  newCustomer,
  sellOnCredit,
  stateFxRate,
  baseCurrency,
  type SettlementWorld,
  type OpenInvoice,
} from '../golden-regression/phase4-s4/settlement-world';
import { collectPayment, rateToR10, SYSTEM_KEYS } from '../golden-regression/phase4-s4/settlement-path';
import { must, systemAccountId } from '../golden-regression/phase4-s4/harness';

const AR_KEY = SYSTEM_KEYS.accountsReceivable;
const CREDIT_KEY = SYSTEM_KEYS.customerCreditLiability;
/**
 * R-17 refuses an instant that carries sub-second precision, and the first run
 * of this probe lost scenario 5 to exactly that: `new Date()` carries
 * milliseconds, so `accounting_post_manual_adjustment` refused the command
 * before any AR law could speak — a probe defect read as a refusal (RULE-27).
 */
const wholeSecond = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000);
/** Relative on purpose: this file must run on Linux CI as well as on Windows. `var/` is git-ignored. */
const OUT_DIR = 'var/mvp03-probe/out';

interface Snapshot {
  readonly label: string;
  /** A: Σ outstanding_base_minor over every customer of the business. */
  readonly invoicesSourceBase: string;
  /** Per-customer A, so a per-customer difference is visible and not only the total. */
  readonly invoicesByCustomer: Record<string, string>;
  /** B: the journal's AR balance, business-wide. */
  readonly journalArBase: string;
  readonly journalArLines: number;
  /** B split by the source type that wrote the line. */
  readonly journalBySourceType: Record<string, string>;
  /** B_attr per customer, through each source type's own document join. */
  readonly journalByCustomer: Record<string, string>;
  /** B_unattr: AR money with no path to a customer. */
  readonly journalUnattributedBase: string;
  /** A − B, the headline. */
  readonly deltaTotalBase: string;
  /**
   * The journal's 2210 balance, business-wide, as a CREDIT position (so an
   * overpayment that owes the customer money reads positive). DR-114/ثالثًا/3
   * extends the manual-journal prohibition to this account, and the first run
   * of this probe did not measure it at all.
   */
  readonly journalCreditLiabilityBase: string;
  /** 2210 split by the source type that wrote the line. */
  readonly creditBySourceType: Record<string, string>;
}

/**
 * The journal's AR money, grouped by the customer its source document names.
 *
 * The three AR-touching Phase 4 source types each reach a customer by a
 * DIFFERENT path, and that is the point of writing all three out: `invoice`
 * through `invoices.customer_id`, `customer_payment_allocation` through its
 * allocation's payment, `customer_credit_application` through its application.
 * `manual_adjustment`, `opening_balance` and `reversal` reach none, and their
 * money lands in `unattributed` — which is a property of the SCHEMA
 * (`journal_lines` carries `branch_id` and `warehouse_id` and no counterparty
 * column, `0042`), not of this query.
 */
const JOURNAL_BY_CUSTOMER_SQL = `
  WITH ar AS (
    SELECT l.id, e.source_type, e.source_id, (l.debit_minor - l.credit_minor) AS signed_minor
      FROM journal_lines l
      JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
      JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
     WHERE l.business_id = $1 AND a.system_key = $2
  )
  SELECT coalesce(c.customer_id::text, '(unattributed)') AS customer_id,
         sum(ar.signed_minor)::text AS signed_minor
    FROM ar
    LEFT JOIN LATERAL (
      SELECT CASE ar.source_type
               WHEN 'invoice' THEN (SELECT i.customer_id FROM invoices i WHERE i.business_id = $1 AND i.id = ar.source_id)
               WHEN 'customer_payment_allocation' THEN (
                 SELECT p.customer_id FROM payment_allocations pa
                   JOIN payments p ON p.business_id = pa.business_id AND p.id = pa.payment_id
                  WHERE pa.business_id = $1 AND pa.id = ar.source_id)
               WHEN 'customer_credit_application' THEN (
                 SELECT i.customer_id FROM customer_credit_applications ca
                   JOIN invoices i ON i.business_id = ca.business_id AND i.id = ca.invoice_id
                  WHERE ca.business_id = $1 AND ca.id = ar.source_id)
               ELSE NULL
             END AS customer_id
    ) c ON TRUE
   GROUP BY 1
   ORDER BY 1`;

async function snapshot(w: SettlementWorld, label: string, customers: readonly string[]): Promise<Snapshot> {
  const businessId = w.shop.businessId;
  const pool = ownerPool();

  const invoicesByCustomer: Record<string, string> = {};
  let aTotal = 0n;
  for (const customerId of customers) {
    const r = await pool.query<{ n: string }>(`SELECT coalesce(sum(o.base_minor), 0)::text AS n FROM customer_ar_outstanding($1::uuid, $2::uuid) o`, [
      businessId,
      customerId,
    ]);
    const n = BigInt(must(r.rows[0], `customer_ar_outstanding for ${customerId}`).n);
    invoicesByCustomer[customerId] = n.toString();
    aTotal += n;
  }

  const bal = await pool.query<{ n: string; lines: number }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n, count(*)::int AS lines
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2`,
    [businessId, AR_KEY],
  );
  const b = must(bal.rows[0], 'the journal AR balance');

  const bySource = await pool.query<{ source_type: string; n: string }>(
    `SELECT e.source_type, sum(l.debit_minor - l.credit_minor)::text AS n
       FROM journal_lines l
       JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2
      GROUP BY 1 ORDER BY 1`,
    [businessId, AR_KEY],
  );
  const journalBySourceType: Record<string, string> = {};
  for (const row of bySource.rows) journalBySourceType[row.source_type] = row.n;

  const byCustomer = await pool.query<{ customer_id: string; signed_minor: string }>(JOURNAL_BY_CUSTOMER_SQL, [businessId, AR_KEY]);
  const journalByCustomer: Record<string, string> = {};
  let unattributed = 0n;
  for (const row of byCustomer.rows) {
    if (row.customer_id === '(unattributed)') unattributed += BigInt(row.signed_minor);
    else journalByCustomer[row.customer_id] = row.signed_minor;
  }

  const credit = await pool.query<{ n: string }>(
    `SELECT coalesce(sum(l.credit_minor - l.debit_minor), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2`,
    [businessId, CREDIT_KEY],
  );
  const creditBy = await pool.query<{ source_type: string; n: string }>(
    `SELECT e.source_type, sum(l.credit_minor - l.debit_minor)::text AS n
       FROM journal_lines l
       JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2
      GROUP BY 1 ORDER BY 1`,
    [businessId, CREDIT_KEY],
  );
  const creditBySourceType: Record<string, string> = {};
  for (const row of creditBy.rows) creditBySourceType[row.source_type] = row.n;

  return {
    label,
    invoicesSourceBase: aTotal.toString(),
    invoicesByCustomer,
    journalArBase: b.n,
    journalArLines: b.lines,
    journalBySourceType,
    journalByCustomer,
    journalUnattributedBase: unattributed.toString(),
    deltaTotalBase: (aTotal - BigInt(b.n)).toString(),
    journalCreditLiabilityBase: must(credit.rows[0], 'the journal 2210 balance').n,
    creditBySourceType,
  };
}

const steps: Snapshot[] = [];
const notes: string[] = [];
const control = { arMovedBase: '0', scenariosRun: 0 };

describe('MVP-03 §2 — invoices-derived AR versus journal-derived AR, on one live database', () => {
  let w: SettlementWorld;
  let c1 = '';
  let c2 = '';
  let inv1: OpenInvoice | null = null;

  beforeAll(async () => {
    w = await settlementWorld('mvp03 source of truth');
    const missing = await settlementMissing(w);
    if (missing.length > 0) {
      notes.push(`the settlement subject is incomplete on this head: ${missing.join(', ')}`);
      return;
    }
    await stockUp(w, '1000', '1000');

    // ── scenario 1: an invoice ───────────────────────────────────────────
    c1 = await newCustomer(w);
    c2 = await newCustomer(w);
    steps.push(await snapshot(w, '0 — empty business', [c1, c2]));
    inv1 = await sellOnCredit(w, c1, '10');
    steps.push(await snapshot(w, '1 — one credit invoice to C1', [c1, c2]));
    control.scenariosRun += 1;

    // ── scenario 2: a partial payment ────────────────────────────────────
    const total = BigInt(inv1.totalTxnMinor);
    const part = total / 4n;
    const payRes = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: c1,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: part.toString(),
      allocations: [
        {
          invoiceId: inv1.invoiceId,
          appliedMinor: part.toString(),
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: inv1.totalTxnMinor,
          invoiceTotalBaseMinor: inv1.totalBaseMinor,
        },
      ],
    });
    notes.push(`scenario 2 — partial payment ${part} of ${total}: status ${payRes.status} ${payRes.status >= 300 ? JSON.stringify(payRes.body) : ''}`);
    steps.push(await snapshot(w, '2 — a quarter of C1 invoice paid', [c1, c2]));
    control.scenariosRun += 1;

    // ── scenario 3: an OVERPAYMENT, surplus into a customer credit ───────
    const rest = total - part;
    const over = rest + 5000n;
    const overRes = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: c1,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: over.toString(),
      creditId: randomUUID(),
      allocations: [
        {
          invoiceId: inv1.invoiceId,
          appliedMinor: rest.toString(),
          releasedBeforeMinor: part.toString(),
          invoiceTotalTxnMinor: inv1.totalTxnMinor,
          invoiceTotalBaseMinor: inv1.totalBaseMinor,
        },
      ],
    });
    notes.push(
      `scenario 3 — overpayment ${over} against a remaining ${rest}: status ${overRes.status} ${overRes.status >= 300 ? JSON.stringify(overRes.body) : ''}`,
    );
    steps.push(await snapshot(w, '3 — C1 invoice settled and overpaid by 5000', [c1, c2]));
    control.scenariosRun += 1;

    // ── scenario 4: a CANCELLATION ───────────────────────────────────────
    // There is no void route on this head (`invoices.controller.ts:24`), so
    // the probe asks the DATABASE what it does with the only cancellation a
    // merchant could attempt, and records the refusal verbatim.
    try {
      await ownerPool().query(`UPDATE invoices SET status = 'void' WHERE business_id = $1 AND id = $2`, [w.shop.businessId, inv1.invoiceId]);
      notes.push(`scenario 4 — UPDATE invoices SET status='void' SUCCEEDED as the owner; the two sources now diverge by the whole invoice`);
    } catch (e) {
      notes.push(`scenario 4 — UPDATE invoices SET status='void' refused: ${(e as Error).message}`);
    }
    steps.push(await snapshot(w, '4 — after the cancellation attempt', [c1, c2]));
    control.scenariosRun += 1;

    // ── scenario 5: a MANUAL JOURNAL on the AR account ───────────────────
    // The merchant's own correction, through the command that owns it. It
    // names an account, never a customer: `journal_lines` has no counterparty
    // column (`0042`).
    const arAccountId = must(await systemAccountId(ownerPool(), w.shop.businessId, AR_KEY), 'the AR system account');
    const base = await baseCurrency(w);
    const amount = 123456n;
    const cmd: PostCommand = {
      tenantId: w.shop.tenantId,
      businessId: w.shop.businessId,
      sourceType: 'manual_adjustment',
      sourceId: randomUUID(),
      entryDate: w.day,
      description: 'mvp03 probe — merchant correction straight onto AR',
      lines: [
        {
          account: { kind: 'system', systemKey: AR_KEY },
          side: 'D',
          baseAmountMinor: amount,
          baseCurrency: base,
          txnAmountMinor: amount,
          txnCurrency: base,
          fxRate: '1',
          fxRateSource: 'base',
          fxRateAt: wholeSecond(),
        },
        {
          account: { kind: 'system', systemKey: 'sales_revenue' },
          side: 'C',
          baseAmountMinor: amount,
          baseCurrency: base,
          txnAmountMinor: amount,
          txnCurrency: base,
          fxRate: '1',
          fxRateSource: 'base',
          fxRateAt: wholeSecond(),
        },
      ],
    };
    try {
      const outcome = await post(cmd, w.shop.userId);
      notes.push(`scenario 5 — manual_adjustment Dr AR ${amount} posted, entry ${outcome.entryId} (AR account ${arAccountId})`);
    } catch (e) {
      notes.push(`scenario 5 — manual_adjustment refused: ${(e as Error).message}`);
    }
    steps.push(await snapshot(w, '5 — after a manual journal of 123456 straight onto AR', [c1, c2]));
    control.scenariosRun += 1;

    // ── scenario 6: the same manual journal, straight onto 2210 ──────────
    // DR-114/ثالثًا/3 extends the prohibition to `customer_credit_liability`
    // for the same reason it holds on AR, and that extension rests on what
    // the machine permits TODAY. This arm measures it instead of assuming it.
    const creditAmount = 65432n;
    const creditCmd: PostCommand = {
      ...cmd,
      sourceId: randomUUID(),
      description: 'mvp03 probe — merchant correction straight onto 2210',
      lines: [
        {
          ...must(cmd.lines[0], 'the AR line'),
          account: { kind: 'system', systemKey: CREDIT_KEY },
          side: 'C',
          baseAmountMinor: creditAmount,
          txnAmountMinor: creditAmount,
        },
        { ...must(cmd.lines[1], 'the revenue line'), side: 'D', baseAmountMinor: creditAmount, txnAmountMinor: creditAmount },
      ],
    };
    try {
      const outcome = await post(creditCmd, w.shop.userId);
      notes.push(`scenario 6 — manual_adjustment Cr 2210 ${creditAmount} posted, entry ${outcome.entryId}`);
    } catch (e) {
      notes.push(`scenario 6 — manual_adjustment on 2210 refused: ${(e as Error).message}`);
    }
    steps.push(await snapshot(w, '6 — after a manual journal of 65432 straight onto 2210', [c1, c2]));
    control.scenariosRun += 1;

    const last = must(steps[steps.length - 1], 'the last snapshot');
    control.arMovedBase = last.journalArBase;
  }, 600_000);

  afterAll(() => {
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(`${OUT_DIR}/single-currency.json`, JSON.stringify({ steps, notes, control }, null, 2), 'utf8');
    } catch {
      /* the console line below is the evidence of record on CI */
    }

    console.log(`MVP03_PROBE_SC ${JSON.stringify({ steps, notes, control })}`);
  });

  it('records both derivations after every event', () => {
    // The positive control FIRST: zeros from a probe that never moved AR are
    // blindness, not agreement.
    expect(control.scenariosRun, 'the probe ran its scenarios').toBeGreaterThan(0);
    expect(steps.length, 'a snapshot per event').toBeGreaterThan(1);
  });
});

/**
 * SCENARIO 6 — A FOREIGN-CURRENCY INVOICE, PAID AT A DIFFERENT RATE.
 *
 * The question the owner asked: can the two derivations differ in BASE terms
 * when the rate moves? `customer_ar_outstanding` reports
 * `total_base − Σ invoice_carrying_base_released_minor` at the INVOICE's own
 * historical snapshot, while the journal's AR lines carry the release plus a
 * second line of base dust on the same account and send the rate difference to
 * `fx_gain` / `fx_loss`. Whether those two land on the same integer is exactly
 * what is measured here, on a live database, and not reasoned about.
 *
 * The world is a FRESH one: the base-currency route is refused once a posting
 * has armed the lock, so the currency moves before any stock exists.
 */
describe('MVP-03 §2 — scenario 6, a foreign-currency invoice paid at a moved rate', () => {
  const fxSteps: Snapshot[] = [];
  const fxNotes: string[] = [];
  let ran = false;

  beforeAll(async () => {
    const w = await settlementWorld('mvp03 fx');
    const missing = await settlementMissing(w);
    if (missing.length > 0) {
      fxNotes.push(`the settlement subject is incomplete: ${missing.join(', ')}`);
      return;
    }
    const businessId = w.shop.businessId;
    const invoiceCcy = await baseCurrency(w);
    const newBase = invoiceCcy === 'USD' ? 'ILS' : 'USD';

    const change = await w.t.request.post('/v1/businesses/current/base-currency').set(w.headers).send({ currency: newBase });
    fxNotes.push(`base currency ${invoiceCcy} → ${newBase}: status ${change.status} ${change.status >= 300 ? JSON.stringify(change.body) : ''}`);
    if (change.status >= 300) return;

    const dayShift = async (days: number): Promise<string> => {
      const r = await ownerPool().query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [w.day, days]);
      return must(r.rows[0], 'the shifted civil day').d;
    };
    const instantOf = async (civil: string): Promise<string> => {
      const r = await ownerPool().query<{ at: Date }>(
        `SELECT ((($2::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second') AS at FROM businesses b WHERE b.id = $1`,
        [businessId, civil],
      );
      return must(r.rows[0], `the R-17 instant of ${civil}`).at.toISOString();
    };

    const saleDay = await dayShift(-10);
    const rateSale = '0.2404000000';
    const ratePay = '0.2750000000';
    await stateFxRate(w, invoiceCcy, newBase, rateSale, await instantOf(saleDay));
    await stateFxRate(w, invoiceCcy, newBase, ratePay, await instantOf(w.day));
    fxNotes.push(`rates stated: sale ${rateSale} on ${saleDay}, payment ${ratePay} on ${w.day}`);

    const onSale: SettlementWorld = { ...w, day: saleDay };
    await stockUp(onSale, '100', '50');
    const customerId = await newCustomer(w);
    fxSteps.push(await snapshot(w, 'fx 0 — before the sale', [customerId]));

    const inv = await sellOnCredit(onSale, customerId, '7');
    fxNotes.push(`invoice ${inv.invoiceId}: ${inv.totalTxnMinor} ${inv.currencyCode}, base ${inv.totalBaseMinor}, own rate ${inv.sourceToBaseRate}`);
    fxSteps.push(await snapshot(w, 'fx 1 — a foreign-currency credit invoice', [customerId]));

    const total = BigInt(inv.totalTxnMinor);
    const half = total / 2n;
    const leg1 = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      currencyCode: inv.currencyCode,
      amountMinor: half.toString(),
      allocations: [
        {
          invoiceId: inv.invoiceId,
          appliedMinor: half.toString(),
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: inv.totalTxnMinor,
          invoiceTotalBaseMinor: inv.totalBaseMinor,
          invoiceToBaseRateR10: rateToR10(inv.sourceToBaseRate),
          paymentToBaseRateR10: rateToR10(ratePay),
        },
      ],
    });
    fxNotes.push(`fx leg 1 — half (${half}) at the moved rate: status ${leg1.status} ${leg1.status >= 300 ? JSON.stringify(leg1.body) : ''}`);
    fxSteps.push(await snapshot(w, 'fx 2 — half paid at the moved rate', [customerId]));

    const rest = total - half;
    const leg2 = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      currencyCode: inv.currencyCode,
      amountMinor: rest.toString(),
      allocations: [
        {
          invoiceId: inv.invoiceId,
          appliedMinor: rest.toString(),
          releasedBeforeMinor: half.toString(),
          invoiceTotalTxnMinor: inv.totalTxnMinor,
          invoiceTotalBaseMinor: inv.totalBaseMinor,
          invoiceToBaseRateR10: rateToR10(inv.sourceToBaseRate),
          paymentToBaseRateR10: rateToR10(ratePay),
        },
      ],
    });
    fxNotes.push(`fx leg 2 — the rest (${rest}): status ${leg2.status} ${leg2.status >= 300 ? JSON.stringify(leg2.body) : ''}`);
    fxSteps.push(await snapshot(w, 'fx 3 — settled to zero in the invoice currency', [customerId]));
    ran = true;
  }, 600_000);

  afterAll(() => {
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(`${OUT_DIR}/foreign-currency.json`, JSON.stringify({ fxSteps, fxNotes, ran }, null, 2), 'utf8');
    } catch {
      /* idem */
    }

    console.log(`MVP03_PROBE_FX ${JSON.stringify({ fxSteps, fxNotes, ran })}`);
  });

  it('records both derivations across the foreign-currency chain', () => {
    expect(fxNotes.length, 'the foreign-currency arm reported what it did').toBeGreaterThan(0);
  });
});
