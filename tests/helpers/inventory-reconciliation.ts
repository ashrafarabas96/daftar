/**
 * P3-S8 — R-INV-01 … R-INV-05 THROUGH THE PRODUCTION READER
 * (docs/PHASE_3_S8_CONTRACT.md A-10, A-11, §4.1, §4.3).
 *
 * The suites never re-implement a reconciliation check: they run the reader's
 * own SQL (`DatabaseAccountingReconciliationReader`) through the framework's
 * own `reconcile()` — statuses, the offending-id cap, `assertSafeCheckResult`
 * — over a pool of the caller's choosing:
 *   - the `daftar_reconciler` credential (the authority production uses, so a
 *     missing grant answers `unavailable`, never `ok`);
 *   - a scratch database's reconciler, for the planted defects.
 *
 * `reconcile()` visits every business its reader enumerates. A suite that
 * asks about ONE business wraps the reader so its enumeration is exactly that
 * business; the check itself is the production reader's, unchanged.
 */
import type { Client, Pool } from 'pg';
import {
  INVENTORY_RECONCILIATION_CHECK_IDS,
  reconcile,
  type AccountingReconciliationReader,
  type ReconciliationCheckResult,
  type ReconciliationRunResult,
  type ReconciliationTarget,
} from '@daftar/accounting';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import { PoolReconciliationConnection } from './accounting-reconciliation';
import {
  adjustCommand,
  countCommand,
  damageCommand,
  finalizeCommand,
  glInventory,
  movementValue,
  must,
  openingCommand,
  runCommand as runS3,
  stocktakeOpenCommand,
  today,
  transferCommand,
  type Queryable,
  type S3Business,
} from './inventory-commands';
import { runFinancial, runOpening } from './inventory-posting';
import { FULL_CONTACTS, createSupplier, draftAndReceive, honestDraft } from './purchase-commands';
import { prepareReversal, receivedPurchase, returnGoods, runReversal, type ReceivedPurchase } from './purchase-returns';
import { createMethod, prepareAllocate, preparePay, prepareRefund, runS6, sqlReturnToCredit, type S6Call } from './supplier-settlement';

/** Whatever list `reconcile()` accepts in `options.checks`. */
export type CheckList = NonNullable<NonNullable<Parameters<typeof reconcile>[2]>['checks']>;
export type CheckId = CheckList[number];

/** The five inventory checks, as the list `reconcile()` accepts. */
export const R_INV: CheckList = INVENTORY_RECONCILIATION_CHECK_IDS;

const clock = { now: (): Date => new Date() };

/** The production reader over `pool`, enumerating exactly `target`. */
export function readerFor(pool: Pool, target: ReconciliationTarget): AccountingReconciliationReader {
  const inner = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
  return {
    targets: async () => [target],
    check: (t, id) => inner.check(t, id),
  };
}

/** Run `checks` (default R-INV-01 … R-INV-05) for one business over `pool`. */
export async function runChecks(pool: Pool, target: ReconciliationTarget, checks: CheckList = R_INV): Promise<ReconciliationRunResult> {
  return reconcile(readerFor(pool, target), clock, { checks });
}

/** Run `checks` over every business the production reader itself enumerates on `pool` (no wrapper). */
export async function runAll(pool: Pool, checks: CheckList = R_INV): Promise<ReconciliationRunResult> {
  return reconcile(new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool)), clock, { checks });
}

/** The one result of `checkId` in `run`. */
export function resultOf(run: ReconciliationRunResult, checkId: CheckId): ReconciliationCheckResult {
  const r = run.results.filter((x) => x.checkId === checkId);
  if (r.length !== 1) throw new Error(`expected exactly one ${checkId} result, found ${r.length}`);
  const only = r[0];
  if (only === undefined) throw new Error(`no ${checkId} result`);
  return only;
}

/** `checkId → status` for every result in `run`. */
export function statuses(run: ReconciliationRunResult): Record<string, string> {
  return Object.fromEntries(run.results.map((r) => [r.checkId, r.status]));
}

// ── PM-16's long mixed sequence (T-06, T-08) ───────────────────────────────

/** One committed command of the sequence (its own transaction, as one API request is). */
export interface MixedStep {
  readonly name: string;
  run(c: Client): Promise<void>;
}

/**
 * PM-16's "long mixed sequence" (PM:227) for one business of the S3 shape,
 * every step through the real commands and their entries: an opening,
 * receipts (landed cost; a foreign currency), transfers both ways, an
 * adjustment, damage, a stocktake, a supplier payment, a return that issues a
 * credit note, the credit allocated and refunded, a plain return and a
 * reversal. The steps share state through the closure, so they run in order.
 * `usdRate` enters the business's USD rate (its own connection) before the
 * foreign receipt.
 */
export function mixedSequence(biz: S3Business, cashAccountId: string, usdRate: () => Promise<unknown>): MixedStep[] {
  let supplierId = '';
  let domesticPurchase = '';
  let foreign: ReceivedPurchase | null = null;
  let methodId = '';
  let credit: { readonly creditNoteId: string; readonly supplierId: string } | null = null;
  let allocationTarget = '';
  let reversible = '';
  let stocktakeId = '';
  const v = biz.piece.variantId;
  const s6 = async (c: Client, call: S6Call): Promise<void> => {
    await runS6(c, biz, call);
  };
  return [
    {
      name: 'opening (Case A, both warehouses)',
      run: async (c) =>
        void (await runOpening(
          c,
          biz,
          openingCommand(await today(c), [
            { warehouseId: biz.w1, variantId: v, qty: '10', unitCost: '25' },
            { warehouseId: biz.w2, variantId: biz.dec2.variantId, qty: '1.5', unitCost: '10' },
          ]),
        )),
    },
    {
      name: 'receipt with landed costs',
      run: async (c) => {
        supplierId = await createSupplier(c, biz, FULL_CONTACTS);
        const draft = await honestDraft(c, biz, supplierId);
        await draftAndReceive(c, biz, draft);
        domesticPurchase = draft.purchaseId;
      },
    },
    {
      name: 'receipt in a foreign currency',
      run: async (c) => {
        await usdRate();
        foreign = await receivedPurchase(
          c,
          biz,
          [
            { variantId: v, qty: '3', unitPriceMinor: '1999' },
            { variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '350' },
          ],
          { supplierId, currency: 'USD' },
        );
      },
    },
    { name: 'transfer W1 → W2', run: async (c) => void (await runS3(c, biz, transferCommand(biz.w1, biz.w2, [{ variantId: v, qty: '4' }]))) },
    { name: 'transfer W2 → W1', run: async (c) => void (await runS3(c, biz, transferCommand(biz.w2, biz.w1, [{ variantId: v, qty: '1' }]))) },
    {
      name: 'adjustment (a loss and a gain)',
      run: async (c) =>
        void (await runFinancial(
          c,
          biz,
          await adjustCommand(c, biz, biz.w1, [
            { variantId: v, qty: '-1' },
            { variantId: biz.piece2.variantId, qty: '2', unitCost: '7.5' },
          ]),
        )),
    },
    { name: 'damage', run: async (c) => void (await runFinancial(c, biz, await damageCommand(c, biz, biz.w2, [{ variantId: v, qty: '1' }]))) },
    {
      name: 'stocktake opened',
      run: async (c) => {
        const open = stocktakeOpenCommand(biz.w1);
        await runS3(c, biz, open);
        stocktakeId = open.stocktakeId;
      },
    },
    { name: 'stocktake counted', run: async (c) => void (await runS3(c, biz, countCommand(stocktakeId, biz.w1, [{ variantId: v, counted: '5' }]))) },
    { name: 'stocktake finalized', run: async (c) => void (await runFinancial(c, biz, await finalizeCommand(c, biz, stocktakeId, biz.w1))) },
    {
      name: 'supplier payment (part of the domestic receipt)',
      run: async (c) => {
        methodId = await createMethod(c, biz, { postingAccountId: cashAccountId });
        await s6(
          c,
          await preparePay(c, biz, {
            supplierId,
            paymentMethodId: methodId,
            reference: 'TRF-16',
            allocations: [{ purchaseId: domesticPurchase, paymentAmountMinor: 1000n }],
          }),
        );
      },
    },
    {
      name: 'supplier return after a full payment (a credit note)',
      run: async (c) => {
        const n = await sqlReturnToCredit(c, biz, methodId, { supplierId });
        credit = { creditNoteId: n.creditNoteId, supplierId: n.purchase.supplierId };
      },
    },
    {
      name: 'receipt the credit will settle',
      run: async (c) => {
        allocationTarget = (await receivedPurchase(c, biz, [{ variantId: biz.piece2.variantId, qty: '1', unitPriceMinor: '900' }], { supplierId })).purchaseId;
      },
    },
    {
      name: 'credit allocation',
      run: async (c) => {
        const note = must(credit, 'the credit note');
        await s6(c, await prepareAllocate(c, biz, { creditNoteId: note.creditNoteId, purchaseId: allocationTarget, consumedMinor: 600n }));
      },
    },
    {
      name: 'credit refund',
      run: async (c) => {
        const note = must(credit, 'the credit note');
        await s6(c, await prepareRefund(c, biz, { creditNoteId: note.creditNoteId, paymentMethodId: methodId, consumedMinor: 300n, reference: 'RF-16' }));
      },
    },
    {
      name: 'supplier return of the foreign receipt (AP only)',
      run: async (c) => {
        const p = must(foreign, 'the foreign receipt');
        await returnGoods(c, biz, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }], reason: 'Wrong colour' });
      },
    },
    {
      name: 'receipt to reverse',
      run: async (c) => {
        reversible = (
          await receivedPurchase(c, biz, [{ variantId: biz.dec2.variantId, qty: '2.25', unitPriceMinor: '440' }], { supplierId, warehouseId: biz.w2 })
        ).purchaseId;
      },
    },
    { name: 'purchase reversal', run: async (c) => void (await runReversal(c, biz, await prepareReversal(c, biz, reversible))) },
  ];
}

/** `GL(Inventory)` and `Σ movements` of one business, read by the owner: the two figures R-INV-01 compares. */
export async function inventoryFigures(q: Queryable, businessId: string): Promise<{ readonly gl: bigint; readonly movements: bigint }> {
  return { gl: await glInventory(q, businessId), movements: await movementValue(q, businessId) };
}
