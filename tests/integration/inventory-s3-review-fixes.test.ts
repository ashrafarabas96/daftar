/**
 * P3-S3 — the independent security review's findings, proven against the
 * live migrations 0061/0062 (SQL smoke proofs, two connections where the
 * finding is a race).
 *
 * F1 (0061 R-13): a Case B inventory opening and a reversed opening balance
 *     never meet — in either order, and while either is in flight.
 * F2 (0062 R-14): a concurrent identical opening replays; it is not refused
 *     inventory.opening_already_posted.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { openingPayload } from '../../packages/inventory/src/movement-payloads';
import {
  appClient,
  must,
  openingBalanceFingerprintOf,
  openingBalanceSnapshot,
  postOpeningBalanceAs,
  positionPayload,
  postReversalAs,
  reversalFingerprintOfSnapshot,
  sourceAssertion,
  todayIn,
  type PostLine,
} from '../helpers/accounting-posting';
import { expectAccepted, expectRefused, ownerClient, pidOf, settle, waitUntilBlocked, seedStockBusiness, type StockBusiness } from '../helpers/stock-ledger';
import { ensurePostgres, mintTestInventoryAssertion, ownerPool } from '../helpers/test-app';

const AT = new Date('2026-03-14T09:15:00Z');
const line = (systemKey: string, side: 'D' | 'C', amount: bigint): PostLine => ({
  account: { kind: 'system', systemKey },
  side,
  baseAmountMinor: amount,
  baseCurrency: 'ILS',
  txnAmountMinor: amount,
  txnCurrency: 'ILS',
  fxRate: '1',
  fxRateSource: 'base',
  fxRateAt: AT,
  memo: null,
});

/** An opening position holding Inventory 10000 (and cash, so it is not only Inventory). */
const POSITIONS = [line('inventory', 'D', 10000n), line('cash', 'D', 5000n)];

interface PostedBalance {
  readonly openingBalanceId: string;
  readonly entryId: string;
}

async function postBalance(s: StockBusiness, day: string, positions: readonly PostLine[] = POSITIONS): Promise<PostedBalance> {
  const openingBalanceId = randomUUID();
  const ob = await postOpeningBalanceAs(
    sourceAssertion({
      actorUserId: s.userId,
      tenantId: s.tenantId,
      businessId: s.businessId,
      operationKind: 'post',
      sourceType: 'opening_balance',
      sourceId: openingBalanceId,
      postingFingerprint: openingBalanceFingerprintOf({
        tenantId: s.tenantId,
        businessId: s.businessId,
        openingBalanceId,
        asOfDate: day,
        baseCurrency: 'ILS',
        positions,
      }),
    }),
    { asOfDate: day, positions, openingBalanceId },
  );
  return { openingBalanceId, entryId: ob.entryId };
}

/** `accounting_post_reversal` of the balance's entry, in `client`'s open transaction when given. */
async function reverseBalance(s: StockBusiness, day: string, ob: PostedBalance, client?: Client): Promise<string> {
  const snap = openingBalanceSnapshot({
    entryId: ob.entryId,
    tenantId: s.tenantId,
    businessId: s.businessId,
    asOfDate: day,
    baseCurrency: 'ILS',
    positions: POSITIONS,
  });
  const r = await postReversalAs(
    sourceAssertion({
      actorUserId: s.userId,
      tenantId: s.tenantId,
      businessId: s.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: ob.entryId,
      postingFingerprint: reversalFingerprintOfSnapshot(snap, day),
    }),
    ob.entryId,
    day,
    'reverse the opening balance',
    'req-reversal',
    client,
  );
  return r.entryId;
}

interface OpeningCall {
  readonly openingId: string;
  readonly openingBalanceId: string | null;
  readonly positionMinor: bigint | null;
  /** 10 units at 1000.0000000000 = 10000 minor unless overridden. */
  readonly unitCost?: string;
  readonly unitCostC10?: bigint;
}

/** `inventory_record_opening` as `daftar_app` in `c`'s OPEN transaction (the caller commits or rolls back). */
async function recordOpening(c: Client, s: StockBusiness, day: string, o: OpeningCall): Promise<{ replayed: boolean; case_kind: string }> {
  const built = openingPayload({
    tenantId: s.tenantId,
    businessId: s.businessId,
    openingId: o.openingId,
    occurredOn: day,
    openingBalanceId: o.openingBalanceId,
    positionMinor: o.positionMinor,
    lines: [{ warehouseId: s.warehouse1, variantId: s.piece.variantId, qtyQ4: 100000n, unitCostC10: o.unitCostC10 ?? 10000000000000n }],
  });
  const assertion = mintTestInventoryAssertion({
    actorUserId: s.userId,
    tenantId: s.tenantId,
    businessId: s.businessId,
    opCode: 'inventory.opening',
    payloadSha256: built.payload.sha256,
  });
  await c.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
            set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
    [s.tenantId, s.businessId, assertion, randomUUID()],
  );
  const r = await c.query<{ replayed: boolean; case_kind: string }>(
    `SELECT replayed, case_kind FROM inventory_record_opening($1, $2::date, $3, $4::bigint, ARRAY[$5]::uuid[], ARRAY[$6]::uuid[], ARRAY['10']::numeric[], ARRAY[$7]::numeric[])`,
    [o.openingId, day, o.openingBalanceId, o.positionMinor === null ? null : o.positionMinor.toString(), s.warehouse1, s.piece.variantId, o.unitCost ?? '1000'],
  );
  return must(r.rows[0]);
}

async function inOwnTransaction<T>(run: (c: Client) => Promise<T>): Promise<T> {
  const c = await appClient();
  try {
    await c.query('BEGIN');
    const v = await run(c);
    await c.query('COMMIT');
    return v;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function glInventory(businessId: string): Promise<bigint> {
  const r = await ownerPool().query<{ n: string }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = 'inventory'`,
    [businessId],
  );
  return BigInt(must(r.rows[0]).n);
}

async function stockValue(businessId: string): Promise<bigint> {
  const r = await ownerPool().query<{ n: string }>(`SELECT coalesce(sum(value_delta_base_minor), 0)::text AS n FROM stock_movements WHERE business_id = $1`, [
    businessId,
  ]);
  return BigInt(must(r.rows[0]).n);
}

/** The accounting-owned position read, as the one principal that may call it. */
async function positionRead(s: StockBusiness): Promise<{ opening_balance_id: string; inventory_net_minor: string }[]> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [s.tenantId, s.businessId]);
    await c.query('SET LOCAL ROLE daftar_inventory_internal');
    const r = await c.query<{ opening_balance_id: string; inventory_net_minor: string }>(
      `SELECT opening_balance_id, inventory_net_minor::text AS inventory_net_minor FROM accounting_inventory_opening_position($1)`,
      [s.businessId],
    );
    return r.rows;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

let seq = 0;
async function business(tag: string): Promise<{ s: StockBusiness; day: string }> {
  seq += 1;
  const s = await seedStockBusiness(ownerPool(), `rv${tag}${seq}${Date.now().toString(36)}`);
  return { s, day: await todayIn(ownerPool(), 'Asia/Hebron') };
}

beforeAll(async () => {
  await ensurePostgres();
});

describe('F1 — a Case B inventory opening and a reversed opening balance never meet (0061 R-13)', () => {
  it('reversing the entry of an opening balance a posted Case B opening is bound to is refused, and the ledger still equals the stock', async () => {
    const { s, day } = await business('a');
    const ob = await postBalance(s, day);
    const opened = await inOwnTransaction((c) =>
      recordOpening(c, s, day, { openingId: randomUUID(), openingBalanceId: ob.openingBalanceId, positionMinor: 10000n }),
    );
    expect(opened.case_kind).toBe('opening_balance_bound');

    const refused = await settle(() => reverseBalance(s, day, ob));
    expectRefused(refused, 'P0001', 'accounting.opening_balance_inventory_bound', 'reverse after bind');
    expect(await glInventory(s.businessId)).toBe(10000n);
    expect(await stockValue(s.businessId)).toBe(10000n);
    const reversals = await ownerPool().query(`SELECT 1 FROM accounting_reversals WHERE business_id = $1`, [s.businessId]);
    expect(reversals.rowCount).toBe(0);
  });

  it('a reversed opening balance states no position: Case B cannot bind it (inventory.opening_case_changed)', async () => {
    const { s, day } = await business('b');
    const ob = await postBalance(s, day);
    expect((await positionRead(s)).map((r) => r.inventory_net_minor)).toEqual(['10000']);
    await reverseBalance(s, day, ob);
    expect(await positionRead(s)).toEqual([]);

    const refused = await settle(() =>
      inOwnTransaction((c) => recordOpening(c, s, day, { openingId: randomUUID(), openingBalanceId: ob.openingBalanceId, positionMinor: 10000n })),
    );
    expectRefused(refused, 'P0001', 'inventory.opening_case_changed', 'bind after reversal');
    expect(await stockValue(s.businessId)).toBe(0n);
    expect(await glInventory(s.businessId)).toBe(0n);
    // Case A is what remains: a zero-value opening (no entry owed) records.
    const caseA = await inOwnTransaction((c) =>
      recordOpening(c, s, day, { openingId: randomUUID(), openingBalanceId: null, positionMinor: null, unitCost: '0', unitCostC10: 0n }),
    );
    expect(caseA.case_kind).toBe('ledger_posting');
  });

  it('opening in flight first: the reversal waits on the balance row, then is refused once the opening commits', async () => {
    const { s, day } = await business('c');
    const ob = await postBalance(s, day);
    const opening = await appClient();
    const reversal = await appClient();
    const reversalPid = await pidOf(reversal);
    try {
      await opening.query('BEGIN');
      expect((await recordOpening(opening, s, day, { openingId: randomUUID(), openingBalanceId: ob.openingBalanceId, positionMinor: 10000n })).case_kind).toBe(
        'opening_balance_bound',
      );
      await reversal.query('BEGIN');
      const pending = settle(() => reverseBalance(s, day, ob, reversal));
      await waitUntilBlocked(reversalPid, 'the reversal behind the in-flight opening');
      await opening.query('COMMIT');
      expectRefused(await pending, 'P0001', 'accounting.opening_balance_inventory_bound', 'reversal after the opening committed');
      await reversal.query('ROLLBACK');
      expect(await glInventory(s.businessId)).toBe(await stockValue(s.businessId));
    } finally {
      await opening.end().catch(() => undefined);
      await reversal.end().catch(() => undefined);
    }
  });

  it('reversal in flight first: the opening waits on the balance row, then sees the reversal (inventory.opening_case_changed)', async () => {
    const { s, day } = await business('d');
    const ob = await postBalance(s, day);
    const opening = await appClient();
    const reversal = await appClient();
    const openingPid = await pidOf(opening);
    try {
      await reversal.query('BEGIN');
      await reverseBalance(s, day, ob, reversal);
      await opening.query('BEGIN');
      const pending = settle(() => recordOpening(opening, s, day, { openingId: randomUUID(), openingBalanceId: ob.openingBalanceId, positionMinor: 10000n }));
      await waitUntilBlocked(openingPid, 'the opening behind the in-flight reversal');
      await reversal.query('COMMIT');
      expectRefused(await pending, 'P0001', 'inventory.opening_case_changed', 'opening after the reversal committed');
      await opening.query('ROLLBACK');
      expect(await stockValue(s.businessId)).toBe(0n);
      expect(await glInventory(s.businessId)).toBe(0n);
    } finally {
      await opening.end().catch(() => undefined);
      await reversal.end().catch(() => undefined);
    }
  });

  it('no deadlock with the opening-balance workflow: a reversal holding businesses FOR SHARE never needs the R-1 key a waiting workflow command holds', async () => {
    const { s, day } = await business('e');
    const ob = await postBalance(s, day);
    const holder = await ownerClient();
    const reversal = await appClient();
    const workflow = await appClient();
    const reversalPid = await pidOf(reversal);
    const workflowPid = await pidOf(workflow);
    try {
      // Park the reversal AFTER it took `businesses` FOR SHARE (0046 step 2)
      // and BEFORE its guard: someone else holds its source-identity key (step 3).
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || '|reversal|' || $2::text, 0))`, [s.businessId, ob.entryId]);
      await reversal.query('BEGIN');
      const reversing = settle(() => reverseBalance(s, day, ob, reversal));
      await waitUntilBlocked(reversalPid, 'the reversal holding businesses FOR SHARE');

      // A workflow command takes the R-1 key, then queues for businesses FOR UPDATE behind the reversal's FOR SHARE.
      const draftId = randomUUID();
      await workflow.query('BEGIN');
      await workflow.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [
        sourceAssertion({
          actorUserId: s.userId,
          tenantId: s.tenantId,
          businessId: s.businessId,
          operationKind: 'post',
          sourceType: 'opening_balance',
          sourceId: draftId,
          postingFingerprint: '0'.repeat(64),
        }),
      ]);
      const drafting = settle(() =>
        workflow.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [day, JSON.stringify(positionPayload(POSITIONS))]),
      );
      await waitUntilBlocked(workflowPid, 'the workflow command behind the reversal');

      // Released: the reversal runs its guard while the workflow holds the R-1
      // key and waits for the reversal's FOR SHARE. A guard that asked for the
      // key would close the cycle (40P01); the row lock does not.
      await holder.query('COMMIT');
      const reversed = await reversing;
      expectAccepted(reversed, 'the reversal completes: its guard never asks for the R-1 key');
      await reversal.query('COMMIT');
      const drafted = await drafting;
      expect(drafted.ok ? 'ok' : drafted.sqlstate).not.toBe('40P01');
      await workflow.query('ROLLBACK');
    } finally {
      await holder.end().catch(() => undefined);
      await reversal.end().catch(() => undefined);
      await workflow.end().catch(() => undefined);
    }
  });
});

describe('F2 — a concurrent identical opening replays (0062 R-14)', () => {
  it('the second identical call waits on the document key and replays the first once it commits', async () => {
    const { s, day } = await business('f');
    const openingId = randomUUID();
    const zero = { openingId, openingBalanceId: null, positionMinor: null, unitCost: '0', unitCostC10: 0n } as const;
    const first = await appClient();
    const second = await appClient();
    const secondPid = await pidOf(second);
    try {
      await first.query('BEGIN');
      expect(await recordOpening(first, s, day, zero)).toEqual({ replayed: false, case_kind: 'ledger_posting' });
      await second.query('BEGIN');
      const pending = settle(() => recordOpening(second, s, day, zero));
      await waitUntilBlocked(secondPid, 'the identical opening behind the first');
      await first.query('COMMIT');
      expect(expectAccepted(await pending, 'the identical opening replays')).toEqual({ replayed: true, case_kind: 'ledger_posting' });
      await second.query('COMMIT');
      const rows = await ownerPool().query(`SELECT id FROM inventory_openings WHERE business_id = $1`, [s.businessId]);
      expect(rows.rows).toEqual([{ id: openingId }]);
      expect(await stockValue(s.businessId)).toBe(0n);
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
    }
  });

  it('a concurrent DIFFERENT opening of the same business is still refused inventory.opening_already_posted', async () => {
    const { s, day } = await business('g');
    const first = await appClient();
    const second = await appClient();
    const secondPid = await pidOf(second);
    try {
      await first.query('BEGIN');
      await recordOpening(first, s, day, { openingId: randomUUID(), openingBalanceId: null, positionMinor: null, unitCost: '0', unitCostC10: 0n });
      await second.query('BEGIN');
      const pending = settle(() =>
        recordOpening(second, s, day, { openingId: randomUUID(), openingBalanceId: null, positionMinor: null, unitCost: '0', unitCostC10: 0n }),
      );
      await waitUntilBlocked(secondPid, 'the other opening behind the first (the R-1 key)');
      await first.query('COMMIT');
      expectRefused(await pending, 'P0001', 'inventory.opening_already_posted', 'a second opening');
      await second.query('ROLLBACK');
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
    }
  });
});
