/**
 * P3-S3 — THE JOURNAL SIDE OF THE FINANCIAL COMMANDS (docs/PHASE_3_S3_CONTRACT.md
 * §5, H-2).
 *
 * The posting of an adjustment, damage, stocktake finalization or Case A
 * opening is built by the APP's own builders (`adjustmentPostingCommand`,
 * `openingPostingCommand`), its accounting assertion minted by the real
 * `mintDomainPostingAssertion` with the test key, and the entry written by
 * the one generic primitive `accounting_post_entry`, as `daftar_app`, in the
 * SAME transaction as the inventory routine — exactly the seam-2 composition
 * the services use. Nothing here writes a journal row as the owner.
 *
 * `postEntryInTx` also takes any other command, which is how the A-14
 * negative tests present a FORGED entry: a genuine `post` assertion over an
 * `inventory_adjustment` / `inventory_opening` posting that no inventory
 * document registered, or one whose amount disagrees with its document.
 */
import { mintDomainPostingAssertion, type AccountingAssertionMinter, type PostingCommand, type PostingLineCommand } from '@daftar/accounting';
import { adjustmentPostingCommand, openingPostingCommand } from '../../apps/api/src/modules/inventory/inventory-posting';
import { adjustCommand, type CommandRow, must, type Queryable, runCommand, type S3Business, type S3Command } from './inventory-commands';
import { mintTestAccountingAssertion } from './test-app';
import {
  openingBalanceFingerprintOf,
  openingBalanceSnapshot,
  positionPayload,
  reversalFingerprintOf,
  reversalFingerprintOfSnapshot,
  sourceAssertion,
  type PostLine,
} from './accounting-posting';
import { randomUUID } from 'node:crypto';

/** The accounting minter the services are wired with, holding the test key. */
export const testMinter: AccountingAssertionMinter = { mint: (claims) => mintTestAccountingAssertion(claims) };

/** The warehouse's home branch, which every Inventory/COGS line carries. */
export async function homeBranch(q: Queryable, businessId: string, warehouseId: string): Promise<string> {
  const r = await q.query<{ branch_id: string }>(`SELECT branch_id::text FROM warehouses WHERE business_id = $1 AND id = $2`, [businessId, warehouseId]);
  return must(r.rows[0], `warehouse ${warehouseId}`).branch_id;
}

/** The posting an adjustment/damage/stocktake document owes (null when its net value is 0), built by the app's builder. */
export function adjustmentEntry(
  biz: S3Business,
  doc: { sourceId: string; occurredOn: string; warehouseId: string; branchId: string; netValueMinor: bigint; trace?: string },
): PostingCommand | null {
  return adjustmentPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceId: doc.sourceId,
    occurredOn: doc.occurredOn,
    baseCurrency: 'ILS',
    businessTransactionId: doc.trace ?? doc.sourceId,
    warehouseId: doc.warehouseId,
    branchId: doc.branchId,
    netValueMinor: doc.netValueMinor,
  });
}

/** The Case A posting an opening owes (null when T = 0), built by the app's builder. */
export function openingEntry(
  biz: S3Business,
  doc: {
    sourceId: string;
    occurredOn: string;
    perWarehouse: readonly { warehouseId: string; branchId: string; valueMinor: bigint }[];
    trace?: string;
  },
): PostingCommand | null {
  return openingPostingCommand({
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceId: doc.sourceId,
    occurredOn: doc.occurredOn,
    baseCurrency: 'ILS',
    businessTransactionId: doc.trace ?? doc.sourceId,
    perWarehouse: doc.perWarehouse,
  });
}

/** The primitive's JSONB lines, exactly as `AccountingPostingAdapter.postEntryInTransaction` serializes them. */
export function entryLines(lines: readonly PostingLineCommand[]): unknown[] {
  return lines.map((l) => ({
    account: l.account.kind === 'system' ? { kind: 'system', system_key: l.account.systemKey } : { kind: 'code', code: l.account.code },
    side: l.side,
    base_amount_minor: l.baseAmountMinor.toString(10),
    base_currency: l.baseCurrency.toUpperCase(),
    txn_amount_minor: l.txnAmountMinor.toString(10),
    txn_currency: l.txnCurrency.toUpperCase(),
    fx_rate: l.fxRate,
    fx_rate_source: l.fxRateSource,
    fx_rate_at: `${l.fxRateAt.toISOString().slice(0, 19)}Z`,
    branch_id: l.branchId,
    warehouse_id: l.warehouseId,
    memo: l.memo ?? null,
  }));
}

/** The accounting assertion a domain command mints for exactly this posting (the real minting function). */
export function mintEntry(command: PostingCommand, actorUserId: string): string {
  return mintDomainPostingAssertion(testMinter, command, actorUserId);
}

/**
 * Post `command` in the CALLER's transaction as `daftar_app`, carrying
 * `assertion` (by default the one `mintDomainPostingAssertion` mints for it).
 * The deferred completeness triggers fire at COMMIT (or `atCommit`).
 */
export async function postEntryInTx(
  c: Queryable,
  command: PostingCommand,
  actorUserId: string,
  assertion?: string,
): Promise<{ entryId: string; created: boolean }> {
  await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion ?? mintEntry(command, actorUserId)]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
    command.entryDate,
    command.description ?? null,
    command.requestId ?? null,
    JSON.stringify(entryLines(command.lines)),
  ]);
  await c.query('RESET ROLE');
  const row = must(r.rows[0], 'accounting_post_entry row');
  return { entryId: row.entry_id, created: row.created };
}

/** The document total a financial routine answered (the same on every row). */
export function totalOf(rows: readonly CommandRow[]): bigint {
  return BigInt(must(rows[0]?.total, 'document total'));
}

/**
 * One financial command the way the service runs it (A-08): the routine, then
 * — only when it owes an entry and was not a replay — the entry, in the same
 * transaction. Returns the routine's rows and the entry (or null).
 */
export async function runFinancial(
  c: Queryable,
  biz: S3Business,
  cmd: Extract<S3Command, { kind: 'adjust' | 'damage' | 'stocktake_finalize' }>,
  o: { trace?: string } = {},
): Promise<{ rows: CommandRow[]; entry: { entryId: string; created: boolean } | null; command: PostingCommand | null }> {
  const rows = await runCommand(c, biz, cmd, o.trace === undefined ? {} : { trace: o.trace });
  if (cmd.kind === 'stocktake_finalize' && cmd.outcome === 'cancelled') return { rows, entry: null, command: null };
  const sourceId = cmd.kind === 'stocktake_finalize' ? cmd.stocktakeId : cmd.adjustmentId;
  const occurredOn = must(cmd.occurredOn, 'occurredOn');
  const command = adjustmentEntry(biz, {
    sourceId,
    occurredOn,
    warehouseId: cmd.warehouseId,
    branchId: await homeBranch(c, biz.businessId, cmd.warehouseId),
    netValueMinor: totalOf(rows),
    ...(o.trace === undefined ? {} : { trace: o.trace }),
  });
  if (command === null || rows[0]?.replayed === true) return { rows, entry: null, command };
  return { rows, entry: await postEntryInTx(c, command, biz.userId), command };
}

/** A Case A / Case B opening the way the service runs it: the routine, then the Case A entry when T > 0. */
export async function runOpening(
  c: Queryable,
  biz: S3Business,
  cmd: Extract<S3Command, { kind: 'opening' }>,
  o: { trace?: string } = {},
): Promise<{ rows: CommandRow[]; entry: { entryId: string; created: boolean } | null; command: PostingCommand | null }> {
  const rows = await runCommand(c, biz, cmd, o.trace === undefined ? {} : { trace: o.trace });
  if (must(rows[0]).case_kind !== 'ledger_posting') return { rows, entry: null, command: null };
  const per = new Map<string, bigint>();
  for (const r of rows) {
    const wh = must(r.warehouse_id);
    per.set(wh, (per.get(wh) ?? 0n) + BigInt(must(r.value)));
  }
  const perWarehouse = [];
  for (const [warehouseId, valueMinor] of per) perWarehouse.push({ warehouseId, branchId: await homeBranch(c, biz.businessId, warehouseId), valueMinor });
  const command = openingEntry(biz, {
    sourceId: cmd.openingId,
    occurredOn: cmd.occurredOn,
    perWarehouse,
    ...(o.trace === undefined ? {} : { trace: o.trace }),
  });
  if (command === null || rows[0]?.replayed === true) return { rows, entry: null, command };
  return { rows, entry: await postEntryInTx(c, command, biz.userId), command };
}

/**
 * H-4 stock seeding through the REAL adjustment command (gains at an explicit
 * cost), with its entry, in the caller's transaction.
 */
export async function stockUp(
  c: Queryable,
  biz: S3Business,
  warehouseId: string,
  lines: readonly { variantId: string; qty: string; unitCost: string }[],
): Promise<{ rows: CommandRow[]; entry: { entryId: string; created: boolean } | null; command: PostingCommand | null }> {
  return runFinancial(c, biz, await adjustCommand(c, biz, warehouseId, lines, { reason: 'seed stock' }));
}

// ── the accounting side the opening interacts with (A-14(c), T-08) ─────────

/** A domestic ILS opening position line. */
export function position(systemKey: string, side: 'D' | 'C', amount: bigint): PostLine {
  return {
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: new Date('2026-01-01T00:00:00Z'),
    memo: null,
  };
}

/**
 * The P2-S4 opening-balance workflow, draft then post, in the CALLER's
 * transaction as `daftar_app` under a genuine `post` assertion for
 * `opening_balance` — exactly `postOpeningBalanceAs`, without its own
 * connection.
 */
export async function postOpeningBalanceInTx(
  c: Queryable,
  biz: S3Business,
  asOfDate: string,
  positions: readonly PostLine[],
): Promise<{ openingBalanceId: string; entryId: string }> {
  const openingBalanceId = randomUUID();
  const assertion = sourceAssertion({
    actorUserId: biz.userId,
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: biz.tenantId,
      businessId: biz.businessId,
      openingBalanceId,
      asOfDate,
      baseCurrency: 'ILS',
      positions,
    }),
  });
  await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
  await c.query('SET LOCAL ROLE daftar_app');
  await c.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [asOfDate, JSON.stringify(positionPayload(positions))]);
  const r = await c.query<{ entry_id: string }>(`SELECT entry_id FROM accounting_open_balance_post($1::uuid, $2, $3)`, [
    openingBalanceId,
    'opening position',
    randomUUID(),
  ]);
  await c.query('RESET ROLE');
  return { openingBalanceId, entryId: must(r.rows[0], 'opening balance entry').entry_id };
}

/** The generic reversal primitive, as `daftar_app` in the caller's transaction, under a `reverse` assertion over `fingerprint`. */
export async function reverseInTx(c: Queryable, biz: S3Business, originalEntryId: string, entryDate: string, fingerprint: string): Promise<string> {
  const assertion = sourceAssertion({
    actorUserId: biz.userId,
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: originalEntryId,
    postingFingerprint: fingerprint,
  });
  await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<{ entry_id: string }>(`SELECT entry_id FROM accounting_post_reversal($1::uuid, $2::date, $3, $4)`, [
    originalEntryId,
    entryDate,
    'a test reversal',
    randomUUID(),
  ]);
  await c.query('RESET ROLE');
  return must(r.rows[0], 'reversal entry').entry_id;
}

/** The fingerprint a reversal of an opening balance's entry signs. */
export function openingBalanceReversalFingerprint(
  biz: S3Business,
  entryId: string,
  asOfDate: string,
  positions: readonly PostLine[],
  entryDate: string,
): string {
  return reversalFingerprintOfSnapshot(
    openingBalanceSnapshot({ entryId, tenantId: biz.tenantId, businessId: biz.businessId, asOfDate, baseCurrency: 'ILS', positions }),
    entryDate,
  );
}

/** The fingerprint a reversal of a domain entry posted from `command` would sign. */
export function domainReversalFingerprint(command: PostingCommand, entryId: string, entryDate: string): string {
  return reversalFingerprintOf(
    {
      tenantId: command.tenantId,
      businessId: command.businessId,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      entryDate: command.entryDate,
      lines: command.lines.map((l) => ({ ...l, memo: l.memo ?? null })),
    },
    entryId,
    entryDate,
  );
}
