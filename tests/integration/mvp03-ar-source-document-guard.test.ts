import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  must,
  postAdjustmentAs,
  postOpeningBalanceAs,
  postReversalAs,
  reversalFingerprintOf,
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
import { SYSTEM_KEYS, collectPayment, applyCredit, rateToR10, CREDIT_SOURCE_TYPE, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import { entryLines, creditSnapshot } from '../golden-regression/phase4-s4/harness';
import { Client } from 'pg';
import { dbUrl } from '../helpers/test-app';

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
 * itself one of the above.
 *
 * AND THE REASON THIS FILE USED TO GIVE FOR THAT ARM WAS FALSE, corrected here
 * rather than deleted. It said an absolute ban would leave a wrongly posted
 * invoice permanently uncorrectable. Measured:
 * `accounting_reversals_20_domain_source_guard()` already refuses a reversal
 * whose original entry is an `invoice`, `customer_payment_allocation`,
 * `customer_credit_application`, `customer_credit` or `sale`
 * (`0081:1409-1416`), so that correction is impossible for a reason that has
 * nothing to do with this guard, and the ACCEPTING half of the reversal arm is
 * unreachable through the product today. The arm is kept for forward
 * compatibility with the slice that ships the reversal document, which
 * `0081:1399-1402` promises in those words, and the open question — what IS the
 * intended route to correct a wrongly posted invoice — is the owner's
 * (MVP03-م-1 in `OWNER_QUEUE_AR.md`), not this file's.
 *
 * The REFUSING half of that arm is reachable and is exercised below, over a
 * forbidden row that only exists because this suite disabled the guard to
 * create it, inside a transaction it rolls back.
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

/**
 * THE NEGATIVE CONTROL THE REVIEW ASKED FOR, and the reversal arm with it.
 *
 * Every case above asserts a refusal. A refusal is also what a broken machine
 * produces, so none of them proves that THIS trigger is what refuses, nor that
 * it is capable of failing. The cases below close that, and they pay for it in
 * a way that leaves no residue: each one runs in a single transaction it ROLLS
 * BACK, and `ALTER TABLE … DISABLE TRIGGER` is transactional in PostgreSQL, so
 * the disable dies with the rollback. The suite asserts that afterwards, by
 * reading `tgenabled` back.
 *
 * The guard is a DEFERRED constraint trigger, so inside one transaction
 * nothing fires until commit; `SET CONSTRAINTS <name> IMMEDIATE` forces the
 * pending events to be checked at that point, which is how a rolled-back
 * transaction can still see the refusal.
 */
const TRIGGER = 'journal_lines_ar_control_source_document';

async function ownerClient(): Promise<Client> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  return c;
}

/** `O`, `D`, … straight out of `pg_trigger`, so the control's own state is measured and not assumed. */
async function triggerState(): Promise<string> {
  const r = await ownerPool().query<{ tgenabled: string }>(
    `SELECT tgenabled::text AS tgenabled FROM pg_trigger
      WHERE tgrelid = 'public.journal_lines'::regclass AND tgname = $1 AND NOT tgisinternal`,
    [TRIGGER],
  );
  return must(r.rows[0], `the trigger ${TRIGGER} must exist for any of this to mean anything`).tgenabled;
}

describe('MVP-03 — the guard is what refuses, and it can be made to fail', () => {
  it('the harness can see this law refuse inside its own transaction, with the deferral forced', async () => {
    expect(await triggerState(), 'the guard is enabled on this head').toBe('O');
    const f = await freshBusiness('mvp03-negctl-on');
    const c = adjustmentOn(f, AR_KEY, 'D', 123456n);
    const conn = await ownerClient();
    try {
      await conn.query('BEGIN');
      await conn.query('SET LOCAL ROLE daftar_app');
      await postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants the debt higher', conn);
      await conn.query('RESET ROLE');
      const message = await refusal(() => conn.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`));
      expect(message, `forcing the deferred guard must raise THIS law and not another rule: ${message}`).toContain(GUARD_MARKER);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
  }, 180_000);

  it('and with the guard DISABLED the same posting is accepted, so nothing else was refusing', async () => {
    const f = await freshBusiness('mvp03-negctl-off');
    const c = adjustmentOn(f, AR_KEY, 'D', 123456n);
    const conn = await ownerClient();
    try {
      await conn.query('BEGIN');
      await conn.query(`ALTER TABLE journal_lines DISABLE TRIGGER ${TRIGGER}`);
      await conn.query('SET LOCAL ROLE daftar_app');
      const outcome = await postAdjustmentAs(assertionForAdjustment(f, c), c, 'the merchant wants the debt higher', conn);
      await conn.query('RESET ROLE');
      // Nothing is pending, because a disabled trigger queues no event. The
      // statement is here so the two legs differ in ONE thing only.
      await conn.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`);
      expect(outcome.created, 'with this one trigger off, the ledger takes a debt that belongs to no customer').toBe(true);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
    expect(await triggerState(), 'the rollback took the DISABLE with it, and the next suite inherits the guard on').toBe('O');
  }, 180_000);

  it('the reversal arm judges by the ORIGIN: a reversal of a manual adjustment on AR is refused', async () => {
    const f = await freshBusiness('mvp03-rev-arm');
    const c = adjustmentOn(f, AR_KEY, 'D', 50500n);
    const conn = await ownerClient();
    try {
      await conn.query('BEGIN');
      // The forbidden entry can only be created with the guard off, which is
      // the whole reason the accepting half of this arm is unreachable through
      // the product. This is the one way to exercise 0090:103-116 at all.
      await conn.query(`ALTER TABLE journal_lines DISABLE TRIGGER ${TRIGGER}`);
      await conn.query('SET LOCAL ROLE daftar_app');
      const original = await postAdjustmentAs(assertionForAdjustment(f, c), c, 'a row only this control can create', conn);
      await conn.query('RESET ROLE');
      // TWO RUNNER ERRORS MEASURED HERE, named rather than read as findings
      // (RULE-8). First, `ALTER TABLE … ENABLE TRIGGER` answers `cannot ALTER
      // TABLE "journal_lines" because it has pending trigger events`: the
      // ordinary posting queued OTHER deferred events, and they must be checked
      // before the table can be altered again. They pass. Second, leaving the
      // transaction in `ALL IMMEDIATE` then breaks the engine itself — the
      // reversal's entry is written before its binding row, so the deferred
      // `journal_entries_binding_fk` fires early and refuses. So the queue is
      // drained and the deferral is put straight back, and only THIS law is
      // forced, after the reversal, below.
      await conn.query('SET CONSTRAINTS ALL IMMEDIATE');
      await conn.query('SET CONSTRAINTS ALL DEFERRED');
      await conn.query(`ALTER TABLE journal_lines ENABLE TRIGGER ${TRIGGER}`);
      const assertion = sourceAssertion({
        actorUserId: f.userId,
        tenantId: f.tenantId,
        businessId: f.businessId,
        operationKind: 'reverse',
        sourceType: 'reversal',
        sourceId: original.entryId,
        postingFingerprint: reversalFingerprintOf(c, original.entryId, today),
      });
      await conn.query('SET LOCAL ROLE daftar_app');
      await postReversalAs(assertion, original.entryId, today, 'undoing what should never have been posted', `req-${randomUUID()}`, conn);
      await conn.query('RESET ROLE');
      const message = await refusal(() => conn.query(`SET CONSTRAINTS ${TRIGGER} IMMEDIATE`));
      expect(message, `the arm must refuse, and by this law: ${message}`).toContain(GUARD_MARKER);
      expect(message, 'and it must say what it judged, so the arm is proved and not merely crossed').toContain('(judged as manual_adjustment)');
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
    expect(await triggerState(), 'the guard is on after the control').toBe('O');
  }, 180_000);

  it('the ACCEPTING half of that arm is unreachable, measured on the applied database', async () => {
    const r = await ownerPool().query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = 'accounting_reversals_20_domain_source_guard'`);
    const src = must(r.rows[0], 'the upstream domain guard must exist on the applied head').src;
    for (const t of ['invoice', 'customer_payment_allocation', 'customer_credit_application', 'customer_credit', 'sale']) {
      expect(src, `the upstream guard refuses a reversal of ${t}, which is WHY this law's accepting arm cannot be reached`).toContain(`'${t}'`);
    }
    // The positive control for this probe: a type the upstream guard does NOT
    // name. Without it, a `toContain` sweep over a long body proves nothing.
    expect(src, 'the probe discriminates: manual_adjustment is NOT in that list, which is why the case above is reachable').not.toContain(
      "'manual_adjustment'",
    );
  }, 60_000);
});

describe('MVP-03 — the three accepted paths still post', () => {
  /**
   * The refusals above name five source types. The law also ACCEPTS four, and
   * only one of them (`invoice`) was exercised. A guard that refused the other
   * three would leave every case in this file green and break settlement, so
   * each is driven here through its real HTTP route and then read back out of
   * the ledger.
   */
  it('accepts customer_payment_allocation, customer_credit and customer_credit_application', async () => {
    const w = await settlementWorld('mvp03 accepted arms');
    const missing = await settlementMissing(w);
    expect(missing, `the settlement subject must be complete on this head: ${missing.join(', ')}`).toEqual([]);
    await stockUp(w, '1000', '1000');
    const customer = await newCustomer(w);

    const invoiceA = await sellOnCredit(w, customer, '10');
    const totalA = BigInt(invoiceA.totalTxnMinor);
    const surplus = 100n;
    const paymentId = randomUUID();
    const creditId = randomUUID();
    const legA: AllocationInput = {
      invoiceId: invoiceA.invoiceId,
      appliedMinor: totalA.toString(),
      releasedBeforeMinor: '0',
      invoiceTotalTxnMinor: invoiceA.totalTxnMinor,
      invoiceTotalBaseMinor: invoiceA.totalBaseMinor,
    };
    const paid = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: (totalA + surplus).toString(),
      creditId,
      allocations: [legA],
    });
    expect(paid.status, `the payment and its surplus are accepted: ${JSON.stringify(paid.body)}`).toBeLessThan(300);

    const invoiceB = await sellOnCredit(w, customer, '3');
    expect(
      BigInt(invoiceB.totalTxnMinor) >= surplus,
      `NO SUBJECT — the later invoice (${invoiceB.totalTxnMinor}) is smaller than the credit (${surplus}), so the credit cannot be applied to it`,
    ).toBe(true);
    const before = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
    const consumed = before.remainingAmountMinor;
    const applied = await applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId: customer,
      invoiceId: invoiceB.invoiceId,
      applicationDate: w.day,
      consumedMinor: consumed,
      remainingBeforeMinor: before.remainingAmountMinor,
      creditOriginalMinor: before.originalAmountMinor,
      creditOriginalCarryingMinor: before.originalCarryingBaseAmountMinor,
      creditToBaseRateR10: rateToR10(before.creditToBaseRate),
      leg: {
        invoiceId: invoiceB.invoiceId,
        appliedMinor: consumed,
        paymentAmountMinor: consumed,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: invoiceB.totalTxnMinor,
        invoiceTotalBaseMinor: invoiceB.totalBaseMinor,
        invoiceToBaseRateR10: rateToR10(invoiceB.sourceToBaseRate),
        paymentToBaseRateR10: rateToR10(before.creditToBaseRate),
      },
    });
    expect(applied.status, `the credit is applied to the later invoice: ${JSON.stringify(applied.body)}`).toBeLessThan(300);

    // Now read the ledger back: each accepted source type must own at least
    // one line on the account this law guards for it.
    const bound = await ownerPool().query<{ source_type: string; journal_entry_id: string }>(
      `SELECT b.source_type::text AS source_type, b.journal_entry_id::text AS journal_entry_id
         FROM accounting_source_bindings b
        WHERE b.business_id = $1 AND b.source_type = ANY($2::text[])`,
      [w.shop.businessId, ['customer_payment_allocation', CREDIT_SOURCE_TYPE, 'customer_credit_application']],
    );
    const byType = new Map<string, string[]>();
    for (const row of bound.rows) byType.set(row.source_type, [...(byType.get(row.source_type) ?? []), row.journal_entry_id]);

    for (const [sourceType, keys] of [
      ['customer_payment_allocation', [AR_KEY]],
      [CREDIT_SOURCE_TYPE, [CREDIT_KEY]],
      ['customer_credit_application', [AR_KEY, CREDIT_KEY]],
    ] as const) {
      const entries = byType.get(sourceType) ?? [];
      expect(entries.length, `${sourceType} posted no entry at all, so this arm has no subject`).toBeGreaterThan(0);
      const touched = new Set<string>();
      for (const entryId of entries) {
        for (const l of await entryLines(ownerPool(), w.shop.businessId, entryId)) {
          if (l.systemKey !== null) touched.add(l.systemKey);
        }
      }
      for (const key of keys) {
        expect(touched.has(key), `${sourceType} was accepted but wrote no line on ${key}, so the accepting arm is not the one being measured`).toBe(true);
      }
    }
  }, 900_000);
});
