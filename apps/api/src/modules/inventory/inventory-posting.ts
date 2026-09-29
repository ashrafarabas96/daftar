import {
  mintDomainPostingAssertion,
  type AccountingAssertionMinter,
  type AccountingPostingTransactionPort,
  type PostingCommand,
  type PostingLineCommand,
  type PostingResult,
} from '@daftar/accounting';
import type { BusinessScope, Database, TransactionSql } from '../../infra/database';

/**
 * The journal side of the P3-S3 financial commands (PHASE_3_S3_CONTRACT A-05,
 * A-06, A-08).
 *
 * The posting is built from the server's PRE-COMPUTED values (A-07), never
 * from request input, and the accounting assertion is minted over exactly
 * that command before the transaction opens. The entry is then written by the
 * one generic primitive, `accounting_post_entry`, through
 * `AccountingPostingTransactionPort.postEntryInTransaction` on seam 2's
 * posting capability — no new journal writer exists (L:1003, G-4).
 *
 * - `entryDate` is the request's required `occurredOn`; there is no default to
 *   "today", which would be a server clock inside the fingerprint.
 * - `fxRateAt` is `<occurredOn>T00:00:00Z`, derived from that date.
 * - Every line is domestic: base = transaction currency = the business base
 *   currency, rate 1, source `base`.
 * - Inventory and COGS lines carry the document warehouse and its home
 *   branch; an opening's equity line carries neither.
 * - `description` is null; `requestId` is the business transaction id
 *   (P3-AL-35), which is narrative and outside the fingerprint.
 * - `rounding` (6100) and `purchase_price_variance` (6200) never appear (L:688).
 */

export const INVENTORY_ADJUSTMENT_SOURCE = 'inventory_adjustment';
export const INVENTORY_OPENING_SOURCE = 'inventory_opening';

const DOMESTIC_RATE = '1.0000000000';

interface PostingBase {
  readonly tenantId: string;
  readonly businessId: string;
  /** The document id: the accounting `source_id`. */
  readonly sourceId: string;
  /** `YYYY-MM-DD`, the request's own date. */
  readonly occurredOn: string;
  readonly baseCurrency: string;
  /** The operation's trace id (P3-AL-35). Narrative only. */
  readonly businessTransactionId: string;
}

function domesticLine(
  base: PostingBase,
  systemKey: 'inventory' | 'cogs' | 'opening_equity',
  side: 'D' | 'C',
  amount: bigint,
  dims: { readonly warehouseId: string; readonly branchId: string } | null,
): PostingLineCommand {
  const currency = base.baseCurrency.toUpperCase();
  return {
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: currency,
    txnAmountMinor: amount,
    txnCurrency: currency,
    fxRate: DOMESTIC_RATE,
    fxRateSource: 'base',
    fxRateAt: new Date(`${base.occurredOn}T00:00:00Z`),
    branchId: dims?.branchId ?? null,
    warehouseId: dims?.warehouseId ?? null,
    memo: null,
  };
}

/**
 * An adjustment, damage or stocktake finalization (A-05): the document's net
 * value V posts `Dr inventory V / Cr cogs V` when V > 0, the reverse when
 * V < 0, and nothing when V = 0 (a journal amount must be positive, `0042`).
 */
export function adjustmentPostingCommand(
  base: PostingBase & { readonly warehouseId: string; readonly branchId: string; readonly netValueMinor: bigint },
): PostingCommand | null {
  const v = base.netValueMinor;
  if (v === 0n) return null;
  const dims = { warehouseId: base.warehouseId, branchId: base.branchId };
  const amount = v > 0n ? v : -v;
  const lines =
    v > 0n
      ? [domesticLine(base, 'inventory', 'D', amount, dims), domesticLine(base, 'cogs', 'C', amount, dims)]
      : [domesticLine(base, 'cogs', 'D', amount, dims), domesticLine(base, 'inventory', 'C', amount, dims)];
  return {
    tenantId: base.tenantId,
    businessId: base.businessId,
    sourceType: INVENTORY_ADJUSTMENT_SOURCE,
    sourceId: base.sourceId,
    entryDate: base.occurredOn,
    lines,
    description: null,
    requestId: base.businessTransactionId,
  };
}

/**
 * An opening, Case A (A-05): one `Dr inventory` line per warehouse holding a
 * positive share total, in first-appearance order, and one
 * `Cr opening_equity` for the sum. Nothing when the total is 0. Case B posts
 * no entry at all (L:720-722) and never calls this.
 */
export function openingPostingCommand(
  base: PostingBase & { readonly perWarehouse: readonly { readonly warehouseId: string; readonly branchId: string; readonly valueMinor: bigint }[] },
): PostingCommand | null {
  const debits = base.perWarehouse.filter((w) => w.valueMinor > 0n);
  const total = debits.reduce((a, w) => a + w.valueMinor, 0n);
  if (total === 0n) return null;
  return {
    tenantId: base.tenantId,
    businessId: base.businessId,
    sourceType: INVENTORY_OPENING_SOURCE,
    sourceId: base.sourceId,
    entryDate: base.occurredOn,
    lines: [
      ...debits.map((w) => domesticLine(base, 'inventory', 'D', w.valueMinor, { warehouseId: w.warehouseId, branchId: w.branchId })),
      domesticLine(base, 'opening_equity', 'C', total, null),
    ],
    description: null,
    requestId: base.businessTransactionId,
  };
}

/** A posting the command owes, with the assertion minted over exactly it. */
export interface PostingPlan {
  readonly command: PostingCommand;
  readonly assertion: string;
}

/**
 * Mint the accounting assertion for a derived posting (P3-AL-33): only when a
 * posting is implied, never to satisfy a boundary (L:1026). `actorUserId` is
 * the authenticated member the inventory authority was established for.
 */
export function planPosting(minter: AccountingAssertionMinter, command: PostingCommand | null, actorUserId: string): PostingPlan | null {
  return command === null ? null : { command, assertion: mintDomainPostingAssertion(minter, command, actorUserId) };
}

/**
 * Run one movement command in ONE transaction (A-08). With no posting, seam 1
 * (`withBusinessInventoryTransaction`); with one, seam 2
 * (`withBusinessInventoryAccountingTransaction`), where the routine runs and
 * then — unless the routine answered a replay, which commits nothing new — the
 * entry is posted on the same transaction. The seam is chosen by the
 * server-computed plan, never by a request field (L:990-991).
 *
 * `call` runs the entry routine and must itself verify what the routine
 * returned, so a defect there rolls the whole transaction back.
 */
export async function executeMovement<R extends { readonly replayed: boolean }>(
  db: Database,
  posting: AccountingPostingTransactionPort,
  scope: BusinessScope,
  inventoryAssertion: string,
  plan: PostingPlan | null,
  call: (sql: TransactionSql) => Promise<R>,
): Promise<{ readonly result: R; readonly entry: PostingResult | null }> {
  if (plan === null) {
    return db.withBusinessInventoryTransaction(scope, inventoryAssertion, async (tx) => ({ result: await call(tx), entry: null }));
  }
  return db.withBusinessInventoryAccountingTransaction(scope, inventoryAssertion, plan.assertion, async (tx) => {
    const result = await call(tx);
    const entry = result.replayed ? null : await posting.postEntryInTransaction(tx.accounting, { command: plan.command });
    return { result, entry };
  });
}

/**
 * The expected-value check of A-07 step 4, repeated in the application: the
 * routine already refuses `inventory.valuation_changed`, so a mismatch here
 * is an invariant defect, thrown as a plain error to roll the transaction
 * back rather than post an amount the ledger does not hold.
 */
export function assertStoredValues(expected: readonly bigint[], stored: readonly string[]): void {
  if (expected.length !== stored.length || expected.some((v, i) => stored[i] !== v.toString(10))) {
    throw new Error('an inventory routine stored movement values other than the bound expected values');
  }
}
