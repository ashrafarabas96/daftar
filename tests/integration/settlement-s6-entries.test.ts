/**
 * P3-S6 T-10 — THE THREE ENTRY SHAPES, LINE FOR LINE, AND THEIR COMPLETENESS
 * (docs/PHASE_3_S6_CONTRACT.md A-05 (a)(b)(c), A-14(a), §6 T-10).
 *
 * On an ILS business with USD at 3.65 (then 3.70), a scenario whose stored
 * amounts exercise every A-05 line — AP dust, credit dust, realized loss and
 * gain, a posting account, two branches — and, for each S6 entry, the
 * posted lines are EXACTLY the A-05 table computed independently from the
 * stored row (account, side, txn currency and amount, rate, source, instant,
 * base, branch, no warehouse; a line only when its amount ≠ 0; base lines at
 * rate 1 on the entry date's midnight):
 *   (a) `supplier_payment`: every line on the purchase's branch;
 *   (b) `supplier_credit_allocation`: AP and FX lines on the TARGET
 *       purchase's branch, receivable lines on the note's ORIGIN branch;
 *   (c) `supplier_refund`: every line on the origin branch.
 * Then each completeness trigger refuses, at COMMIT, an entry that posts
 * the right source with a tampered shape — its FX line folded into the dust,
 * another settlement account, another branch — and a settlement row whose
 * entry is missing fails its deferred binding (23503).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand, PostingLineCommand } from '@daftar/accounting';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  atCommit,
  expectAccepted,
  must,
  ownerClient,
  refusedWith,
  scratch,
  seedS3World,
  today,
  type Outcome,
  type S3Business,
} from '../helpers/inventory-commands';
import { postInTx } from '../helpers/purchase-commands';
import { receivedPurchase, returnGoods } from '../helpers/purchase-returns';
import {
  createMethod,
  flushDeferred,
  payInFull,
  prepareAllocate,
  preparePay,
  prepareRefund,
  runS6,
  seedSettlementAccounts,
  settlementEntry,
  stateRate,
  type S6Call,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let A: S3Business;
let acc: SettlementAccounts;
let day: string;

function ago(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  A = (await seedS3World(ownerPool(), 's6entries')).A;
  acc = await seedSettlementAccounts(ownerPool(), A);
  await stateRate(A, 'USD', 'ILS', '3.6500000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${ago(3)}T00:00:00Z`);
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

interface Line {
  readonly accountId: string;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txn: string;
  readonly base: string;
  readonly rate: string;
  readonly rateSource: string;
  readonly rateAt: string;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

async function systemAccountId(c: Client, key: string): Promise<string> {
  return must((await c.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = $2`, [A.businessId, key])).rows[0], key).id;
}

async function branchOfWarehouse(c: Client, warehouseId: string): Promise<string | null> {
  return must((await c.query<{ b: string | null }>(`SELECT branch_id::text AS b FROM warehouses WHERE id = $1`, [warehouseId])).rows[0]).b;
}

/** A base-currency line (rate 1, the entry date's midnight). */
function baseLine(accountId: string, side: 'D' | 'C', amount: bigint, entryDate: string, branchId: string | null): Line {
  return {
    accountId,
    side,
    currency: 'ILS',
    txn: amount.toString(10),
    base: amount.toString(10),
    rate: '1.0000000000',
    rateSource: 'base',
    rateAt: `${entryDate}T00:00:00.000Z`,
    branchId,
    warehouseId: null,
  };
}

async function actualLines(c: Client, sourceType: string, sourceId: string): Promise<{ date: string; lines: Line[] }> {
  const e = must(await settlementEntry(c, A.businessId, sourceType, sourceId), `${sourceType} entry`);
  return {
    date: e.entryDate,
    lines: e.lines.map((l) => ({
      accountId: l.accountId,
      side: l.side,
      currency: l.currency,
      txn: l.txnAmountMinor,
      base: l.baseAmountMinor,
      rate: l.rate,
      rateSource: l.rateSource,
      rateAt: l.rateAt,
      branchId: l.branchId,
      warehouseId: l.warehouseId,
    })),
  };
}

/** A-05(a) from the stored allocation, its header and its purchase. */
async function expectedPayment(c: Client, allocationId: string): Promise<{ date: string; lines: Line[] }> {
  const r = must(
    (
      await c.query<{
        pc: string;
        a: string;
        pr: string;
        prs: string;
        prat: Date;
        rel: string;
        dust: string;
        yc: string;
        p: string;
        yr: string;
        yrs: string;
        yrat: Date;
        pb: string;
        fx: string;
        account: string;
        date: string;
        wh: string;
      }>(
        `SELECT a.purchase_currency::text AS pc, a.purchase_amount_applied_minor::text AS a, a.purchase_historical_to_base_rate::text AS pr,
                p.rate_source AS prs, p.rate_timestamp AS prat, a.purchase_carrying_base_released_minor::text AS rel, a.ap_dust_base_minor::text AS dust,
                a.payment_currency::text AS yc, a.payment_amount_minor::text AS p, a.payment_to_base_rate::text AS yr, h.rate_source AS yrs,
                h.rate_timestamp AS yrat, a.payment_base_amount_minor::text AS pb, a.realized_fx_gain_loss_minor::text AS fx,
                h.posting_account_id::text AS account, to_char(h.payment_date, 'YYYY-MM-DD') AS date, p.warehouse_id::text AS wh
           FROM supplier_payment_allocations a
           JOIN supplier_payments h ON h.business_id = a.business_id AND h.id = a.payment_id
           JOIN purchases p ON p.business_id = a.business_id AND p.id = a.purchase_id
          WHERE a.business_id = $1 AND a.id = $2`,
        [A.businessId, allocationId],
      )
    ).rows[0],
  );
  const branch = await branchOfWarehouse(c, r.wh);
  const dust = BigInt(r.dust);
  const fx = BigInt(r.fx);
  const ap = await systemAccountId(c, 'accounts_payable');
  const lines: Line[] = [
    {
      accountId: ap,
      side: 'D',
      currency: r.pc,
      txn: r.a,
      base: (BigInt(r.rel) - dust).toString(10),
      rate: r.pr,
      rateSource: r.prs,
      rateAt: r.prat.toISOString(),
      branchId: branch,
      warehouseId: null,
    },
  ];
  if (dust !== 0n) lines.push(baseLine(ap, dust > 0n ? 'D' : 'C', abs(dust), r.date, branch));
  lines.push({
    accountId: r.account,
    side: 'C',
    currency: r.yc,
    txn: r.p,
    base: r.pb,
    rate: r.yr,
    rateSource: r.yrs,
    rateAt: r.yrat.toISOString(),
    branchId: branch,
    warehouseId: null,
  });
  if (fx !== 0n) lines.push(baseLine(await systemAccountId(c, fx > 0n ? 'fx_loss' : 'fx_gain'), fx > 0n ? 'D' : 'C', abs(fx), r.date, branch));
  return { date: r.date, lines };
}

interface NoteSnapshot {
  readonly nc: string;
  readonly nr: string;
  readonly nrs: string;
  readonly nrat: Date;
  readonly origin: string;
}

async function noteSnapshot(c: Client, creditNoteId: string): Promise<NoteSnapshot> {
  return must(
    (
      await c.query<NoteSnapshot>(
        `SELECT n.currency_code::text AS nc, n.source_to_base_rate::text AS nr, n.rate_source AS nrs, n.rate_timestamp AS nrat, p.warehouse_id::text AS origin
           FROM supplier_credit_notes n
           JOIN supplier_returns r ON r.business_id = n.business_id AND r.id = n.supplier_return_id
           JOIN purchases p ON p.business_id = r.business_id AND p.id = r.purchase_id
          WHERE n.business_id = $1 AND n.id = $2`,
        [A.businessId, creditNoteId],
      )
    ).rows[0],
  );
}

/** The receivable lines of a consumption of `c` releasing `crRel` with dust `crDust`. */
async function receivableLines(
  c: Client,
  n: NoteSnapshot,
  consumed: string,
  crRel: bigint,
  crDust: bigint,
  date: string,
  branch: string | null,
): Promise<Line[]> {
  const sr = await systemAccountId(c, 'supplier_receivable');
  const lines: Line[] = [
    {
      accountId: sr,
      side: 'C',
      currency: n.nc,
      txn: consumed,
      base: (crRel - crDust).toString(10),
      rate: n.nr,
      rateSource: n.nrs,
      rateAt: n.nrat.toISOString(),
      branchId: branch,
      warehouseId: null,
    },
  ];
  if (crDust !== 0n) lines.push(baseLine(sr, crDust > 0n ? 'C' : 'D', abs(crDust), date, branch));
  return lines;
}

/** A-05(b) from the stored credit allocation, its target purchase and its note. */
async function expectedCreditAllocation(c: Client, allocationId: string): Promise<{ date: string; lines: Line[] }> {
  const r = must(
    (
      await c.query<{
        note: string;
        pc: string;
        a: string;
        pr: string;
        prs: string;
        prat: Date;
        rel: string;
        dust: string;
        cons: string;
        crrel: string;
        crdust: string;
        fx: string;
        date: string;
        wh: string;
      }>(
        `SELECT a.credit_note_id::text AS note, a.purchase_currency::text AS pc, a.purchase_amount_applied_minor::text AS a,
                a.purchase_historical_to_base_rate::text AS pr, p.rate_source AS prs, p.rate_timestamp AS prat,
                a.purchase_carrying_base_released_minor::text AS rel, a.ap_dust_base_minor::text AS dust,
                a.credit_amount_consumed_minor::text AS cons, a.credit_carrying_base_released_minor::text AS crrel, a.credit_dust_base_minor::text AS crdust,
                a.realized_fx_gain_loss_minor::text AS fx, to_char(a.allocation_date, 'YYYY-MM-DD') AS date, p.warehouse_id::text AS wh
           FROM supplier_credit_allocations a JOIN purchases p ON p.business_id = a.business_id AND p.id = a.purchase_id
          WHERE a.business_id = $1 AND a.id = $2`,
        [A.businessId, allocationId],
      )
    ).rows[0],
  );
  const target = await branchOfWarehouse(c, r.wh);
  const n = await noteSnapshot(c, r.note);
  const origin = await branchOfWarehouse(c, n.origin);
  const ap = await systemAccountId(c, 'accounts_payable');
  const dust = BigInt(r.dust);
  const fx = BigInt(r.fx);
  const lines: Line[] = [
    {
      accountId: ap,
      side: 'D',
      currency: r.pc,
      txn: r.a,
      base: (BigInt(r.rel) - dust).toString(10),
      rate: r.pr,
      rateSource: r.prs,
      rateAt: r.prat.toISOString(),
      branchId: target,
      warehouseId: null,
    },
  ];
  if (dust !== 0n) lines.push(baseLine(ap, dust > 0n ? 'D' : 'C', abs(dust), r.date, target));
  lines.push(...(await receivableLines(c, n, r.cons, BigInt(r.crrel), BigInt(r.crdust), r.date, origin)));
  if (fx !== 0n) lines.push(baseLine(await systemAccountId(c, fx > 0n ? 'fx_loss' : 'fx_gain'), fx > 0n ? 'D' : 'C', abs(fx), r.date, target));
  return { date: r.date, lines };
}

/** A-05(c) from the stored refund and its note. */
async function expectedRefund(c: Client, refundId: string): Promise<{ date: string; lines: Line[] }> {
  const r = must(
    (
      await c.query<{
        note: string;
        account: string;
        rc: string;
        m: string;
        rr: string;
        rrs: string;
        rrat: Date;
        mb: string;
        cons: string;
        crrel: string;
        crdust: string;
        fx: string;
        date: string;
      }>(
        `SELECT f.credit_note_id::text AS note, f.posting_account_id::text AS account, f.receipt_currency::text AS rc, f.receipt_amount_minor::text AS m,
                f.receipt_to_base_rate::text AS rr, f.rate_source AS rrs, f.rate_timestamp AS rrat, f.receipt_base_amount_minor::text AS mb,
                f.source_amount_consumed_minor::text AS cons, f.source_carrying_base_released_minor::text AS crrel, f.source_dust_base_minor::text AS crdust,
                f.realized_fx_gain_loss_minor::text AS fx, to_char(f.refund_date, 'YYYY-MM-DD') AS date
           FROM supplier_refunds f WHERE f.business_id = $1 AND f.id = $2`,
        [A.businessId, refundId],
      )
    ).rows[0],
  );
  const n = await noteSnapshot(c, r.note);
  const origin = await branchOfWarehouse(c, n.origin);
  const fx = BigInt(r.fx);
  const lines: Line[] = [
    {
      accountId: r.account,
      side: 'D',
      currency: r.rc,
      txn: r.m,
      base: r.mb,
      rate: r.rr,
      rateSource: r.rrs,
      rateAt: r.rrat.toISOString(),
      branchId: origin,
      warehouseId: null,
    },
    ...(await receivableLines(c, n, r.cons, BigInt(r.crrel), BigInt(r.crdust), r.date, origin)),
  ];
  if (fx !== 0n) lines.push(baseLine(await systemAccountId(c, fx > 0n ? 'fx_gain' : 'fx_loss'), fx > 0n ? 'C' : 'D', abs(fx), r.date, origin));
  return { date: r.date, lines };
}

/**
 * The scenario, in the caller's transaction: USD purchases at 3.65 (w1,
 * branch X) and 3.70 (w2, branch Y), payments that leave AP dust and a
 * realized loss, a 3.00 USD note (origin on branch X) consumed by three
 * allocations to branch-Y purchases and by two refunds (USD and ILS).
 */
async function scenario(c: Client): Promise<{ payments: S6Call[]; allocations: S6Call[]; refunds: S6Call[] }> {
  const bank = await createMethod(c, A, { postingAccountId: acc.settlement.bank, systemType: 'bank_transfer' });
  const cash = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
  const usd = { currency: 'USD', documentDate: ago(8) } as const;
  // (a) 1.00 USD @ 3.65 (B 3.65), paid 0.33 at 3.65 then 0.33 at 3.70: the second releases 121 of AP for a conversion of 120 (dust 1), pb 122 (loss 1).
  const p1 = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }], { ...usd, warehouseId: A.w1 });
  const payments: S6Call[] = [];
  for (const [paymentDate, method] of [
    [ago(8), bank],
    [day, cash],
  ] as const) {
    const call = await preparePay(c, A, {
      supplierId: p1.supplierId,
      paymentMethodId: method,
      currency: 'USD',
      paymentDate,
      allocations: [{ purchaseId: p1.purchaseId, paymentAmountMinor: 33n }],
    });
    await runS6(c, A, call);
    payments.push(call);
  }
  // A 3.00 USD note carried at 10.95 (origin w1): three pieces paid, all three returned.
  const origin = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '3', unitPriceMinor: '100' }], {
    ...usd,
    warehouseId: A.w1,
    supplierId: p1.supplierId,
  });
  await payInFull(c, A, origin.purchaseId, origin.supplierId, bank);
  await returnGoods(c, A, origin.purchaseId, { lines: [{ purchaseLineId: must(origin.lines[0]).lineId, qty: '3' }] });
  await flushDeferred(c);
  const creditNoteId = must(
    (await c.query<{ id: string }>(`SELECT id::text FROM supplier_credit_notes WHERE business_id = $1 AND supplier_id = $2`, [A.businessId, p1.supplierId]))
      .rows[0],
  ).id;
  // (b) to a 1.00 USD purchase at 3.65 on w2: 0.33 twice (the second leaves AP dust 1 and credit dust 1);
  //     to a 1.00 USD purchase at 3.70 on w2: 0.33 (a realized gain of 2).
  const p4 = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }], {
    ...usd,
    warehouseId: A.w2,
    supplierId: p1.supplierId,
  });
  const p3 = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }], {
    currency: 'USD',
    documentDate: day,
    warehouseId: A.w2,
    supplierId: p1.supplierId,
  });
  const allocations: S6Call[] = [];
  for (const purchaseId of [p4.purchaseId, p4.purchaseId, p3.purchaseId]) {
    const call = await prepareAllocate(c, A, { creditNoteId, purchaseId, consumedMinor: 33n });
    await runS6(c, A, call);
    allocations.push(call);
  }
  // (c) 0.33 received as 0.33 USD @ 3.70 (credit dust 1, gain 1); 0.33 received as 1.00 ILS (a loss of 20).
  const refunds: S6Call[] = [];
  for (const receipt of [
    { receiptCurrency: 'USD', receiptAmountMinor: 33n },
    { receiptCurrency: 'ILS', receiptAmountMinor: 100n },
  ]) {
    const call = await prepareRefund(c, A, { creditNoteId, paymentMethodId: bank, consumedMinor: 33n, ...receipt });
    await runS6(c, A, call);
    refunds.push(call);
  }
  return { payments, allocations, refunds };
}

describe('T-10 A-05: every S6 entry is exactly its table, line for line, with its dimensions', () => {
  it('(a) supplier_payment, (b) supplier_credit_allocation, (c) supplier_refund; every line kind appears', async () => {
    await inTx(async (c) => {
      const s = await scenario(c);
      expectAccepted(await atCommit(c), 'the honest scenario passes every COMMIT guard');
      const seen = new Set<string>();
      const check = async (sourceType: string, sourceId: string, expected: { date: string; lines: Line[] }): Promise<void> => {
        const actual = await actualLines(c, sourceType, sourceId);
        expect(actual.date, `${sourceType} entry date`).toBe(expected.date);
        expect(actual.lines, `${sourceType} ${sourceId}`).toEqual(expected.lines);
        for (const l of actual.lines) seen.add(`${sourceType}:${l.rateSource === 'base' ? 'base' : 'txn'}:${l.side}`);
      };
      for (const call of s.payments) {
        const posting = must(call.postings[0]);
        await check('supplier_payment', posting.sourceId, await expectedPayment(c, posting.sourceId));
      }
      for (const call of s.allocations) {
        const posting = must(call.postings[0]);
        await check('supplier_credit_allocation', posting.sourceId, await expectedCreditAllocation(c, posting.sourceId));
      }
      for (const call of s.refunds) {
        const posting = must(call.postings[0]);
        await check('supplier_refund', posting.sourceId, await expectedRefund(c, posting.sourceId));
      }
      // The scenario reaches every line of every table: base lines on both sides in each entry type.
      expect([...seen].sort()).toEqual(
        [
          'supplier_payment:txn:D',
          'supplier_payment:txn:C',
          'supplier_payment:base:D',
          'supplier_credit_allocation:txn:D',
          'supplier_credit_allocation:txn:C',
          'supplier_credit_allocation:base:D',
          'supplier_credit_allocation:base:C',
          'supplier_refund:txn:D',
          'supplier_refund:txn:C',
          'supplier_refund:base:D',
          'supplier_refund:base:C',
        ].sort(),
      );
      const keys = await c.query<{ k: string }>(
        `SELECT DISTINCT a.system_key AS k FROM journal_lines l JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
           JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
          WHERE l.business_id = $1 AND e.source_type IN ('supplier_payment', 'supplier_credit_allocation', 'supplier_refund') ORDER BY 1`,
        [A.businessId],
      );
      expect(keys.rows.map((x) => x.k)).toEqual(['accounts_payable', 'bank', 'cash', 'fx_gain', 'fx_loss', 'supplier_receivable']);
    });
  });
});

/** The posting of `call` with `edit` applied to its lines. */
function tampered(call: S6Call, edit: (lines: readonly PostingLineCommand[]) => PostingLineCommand[]): PostingCommand {
  const posting = must(call.postings[0]);
  return { ...posting, lines: edit(posting.lines) };
}

describe('T-10 A-14(a): each completeness trigger refuses a tampered entry at COMMIT', () => {
  /** Run `call` without its entry, post `posting` instead, and probe COMMIT; all rolled back. */
  function withEntry(c: Client, call: S6Call, posting: PostingCommand): Promise<Outcome<null>> {
    return scratch(c, async () => {
      await runS6(c, A, call, { post: false });
      await postInTx(c, posting, A.userId);
      return atCommit(c);
    });
  }

  it('the FX line folded into the dust line, another settlement account, another branch → inventory_entry_mismatch; no entry → the binding FK', async () => {
    await inTx(async (c) => {
      const bank = await createMethod(c, A, { postingAccountId: acc.settlement.bank, systemType: 'bank_transfer' });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }], {
        currency: 'USD',
        documentDate: ago(8),
        warehouseId: A.w1,
      });
      const first = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: bank,
        currency: 'USD',
        paymentDate: ago(8),
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 33n }],
      });
      await runS6(c, A, first);
      const second = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: bank,
        currency: 'USD',
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 33n }],
      });
      const lines = must(second.postings[0]).lines;
      expect(
        lines.map((l) => ('systemKey' in l.account ? l.account.systemKey : 'code')),
        'AP, AP dust, the method, the loss',
      ).toEqual(['accounts_payable', 'accounts_payable', 'code', 'fx_loss']);
      const cases: readonly (readonly [string, PostingCommand])[] = [
        [
          'the FX line folded into the AP dust line',
          tampered(second, (ls) => {
            const [ap, dust, pay, fx] = [must(ls[0]), must(ls[1]), must(ls[2]), must(ls[3])];
            const sum = dust.baseAmountMinor + fx.baseAmountMinor;
            return [ap, { ...dust, baseAmountMinor: sum, txnAmountMinor: sum }, pay];
          }),
        ],
        [
          'another settlement account (cash for the method’s bank)',
          tampered(second, (ls) => ls.map((l, i) => (i === 2 ? { ...l, account: { kind: 'system', systemKey: 'cash' } } : l))),
        ],
        ['another branch on the AP line', tampered(second, (ls) => ls.map((l, i) => (i === 0 ? { ...l, branchId: A.branchY } : l)))],
      ];
      for (const [what, posting] of cases) {
        const o = await withEntry(c, second, posting);
        expect(o.ok ? 'accepted' : o.code, what).toMatch(/^accounting\.inventory_(entry_mismatch|detail_missing)$/);
      }
      const none = await scratch(c, async () => {
        await runS6(c, A, second, { post: false });
        return atCommit(c);
      });
      refusedWith(none, '23503', null, 'a settlement row without its entry: the deferred binding FK');
      expectAccepted(await withEntry(c, second, must(second.postings[0])), 'the honest entry');
    });
  });
});
