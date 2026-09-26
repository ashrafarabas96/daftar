/**
 * P3-S3 T-17 — THE EIGHT MOVEMENT ROUTES END TO END
 * (docs/PHASE_3_S3_CONTRACT.md A-10(c), A-21, A-23, A-25, §3, §6 T-11.2, T-17).
 *
 * Through the real Nest application and the real database:
 *   - each route requires its permission and refuses 403 BEFORE the service
 *     runs (no mint, no seam, nothing written): the built-in manager (holding
 *     only `inventory.view`) and cashier on all eight routes, and each custom
 *     single-permission holder on the other permissions' routes — each DENY
 *     paired with the ALLOW of the member who holds the permission;
 *   - revocation by role edit takes effect at the very next request;
 *   - the DTOs are strict (JSON numbers, unknown keys, 201 lines, a missing
 *     `occurredOn`, a non-canonical UUID in the body or the path → 400);
 *   - 201 on creation, 200 `replayed: true` with the stored body on repeat;
 *   - the §3 status mapping of the typed refusals, with `details.inventoryCode`;
 *   - the hidden base variant never appears in a response;
 *   - the audit row names the signed member and carries the response's trace;
 *   - the service proves a replay before any stock read (T-11.2: zero stock
 *     reads, zero mints, no seam), so a replay succeeds on drained stock;
 *   - `AccountingEngine.post` refuses the two domain-owned sources.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AccountingEngine, AccountingError } from '@daftar/accounting';
import { AccountingAssertionMinterService } from '../../apps/api/src/modules/accounting/accounting-assertion.minter';
import { Database } from '../../apps/api/src/infra/database';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { adjustmentPostingCommand, openingPostingCommand } from '../../apps/api/src/modules/inventory/inventory-posting';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  counts,
  delta,
  must,
  onboardS3Business,
  ownerClient,
  registerActor,
  today,
  type Counts,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { position, postOpeningBalanceInTx } from '../helpers/inventory-posting';
import { post as postManualAdjustment, simpleCommand } from '../helpers/accounting-posting';
import { addMerchantVariant, addTrackedProduct } from '../helpers/stock-ledger';

let t: TestApp;
let day: string;
let A: S3Business;
let owner: HttpActor;
let manager: HttpActor;
let cashier: HttpActor;
let mover: HttpActor;
let adjuster: HttpActor;
let counter: HttpActor;
let revokee: HttpActor;
let narrow: HttpActor;
let invMint: MockInstance<InventoryAssertionMinterService['mint']>;
let acctMint: MockInstance<AccountingAssertionMinterService['mint']>;
let scoped: MockInstance<Database['scoped']>;
let seam1: MockInstance<Database['withBusinessInventoryTransaction']>;
let seam2: MockInstance<Database['withBusinessInventoryAccountingTransaction']>;

async function role(key: string, permissions: readonly string[]): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/roles').set(asMember(owner, A.businessId)).send({ key, name: key, permissions });
  expect(r.status, `role ${key}`).toBe(201);
}

async function member(a: HttpActor, roleKey: string): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/members').set(asMember(owner, A.businessId)).send({ email: a.email, roleKey });
  expect(r.status, `member ${roleKey}`).toBe(201);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S3 owner');
  A = await onboardS3Business(t, owner, 'http');
  manager = await registerActor(t, 'Built-in manager');
  cashier = await registerActor(t, 'Built-in cashier');
  mover = await registerActor(t, 'Mover');
  adjuster = await registerActor(t, 'Adjuster');
  counter = await registerActor(t, 'Counter');
  revokee = await registerActor(t, 'Revokee');
  narrow = await registerActor(t, 'Assigned to X only');
  await role('s3-mover', ['catalog.view', 'inventory.transfer']);
  await role('s3-adjuster', ['catalog.view', 'inventory.adjust']);
  await role('s3-counter', ['catalog.view', 'inventory.stocktake']);
  await role('s3-revocable', ['catalog.view', 'inventory.transfer']);
  await role('s3-narrow', ['catalog.view', 'inventory.transfer']);
  await member(manager, 'manager');
  await member(cashier, 'cashier');
  await member(mover, 's3-mover');
  await member(adjuster, 's3-adjuster');
  await member(counter, 's3-counter');
  await member(revokee, 's3-revocable');
  await member(narrow, 's3-narrow');
  const scope = await t.request
    .patch(`/v1/businesses/current/members/${narrow.userId}/branch-scope`)
    .set(asMember(owner, A.businessId))
    .send({ mode: 'assigned', branchIds: [A.branchX] });
  expect(scope.status).toBe(200);

  const db = t.app.get(Database);
  invMint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
  acctMint = vi.spyOn(t.app.get(AccountingAssertionMinterService), 'mint');
  scoped = vi.spyOn(db, 'scoped');
  seam1 = vi.spyOn(db, 'withBusinessInventoryTransaction');
  seam2 = vi.spyOn(db, 'withBusinessInventoryAccountingTransaction');
});

function clearSpies(): void {
  invMint.mockClear();
  acctMint.mockClear();
  scoped.mockClear();
  seam1.mockClear();
  seam2.mockClear();
}

beforeEach(clearSpies);

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

// ── requests ──────────────────────────────────────────────────────────────

const send = (a: HttpActor, method: 'post' | 'put', path: string, body: unknown): Promise<Response> =>
  t.request[method](`/v1/inventory/${path}`)
    .set(asMember(a, A.businessId))
    .send(body as object);

const piece = (quantity: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ productId: A.piece.productId, quantity, ...extra });

const transferBody = (o: { id?: string; qty?: string; from?: string; to?: string } = {}): Record<string, unknown> => ({
  transferId: o.id ?? randomUUID(),
  sourceWarehouseId: o.from ?? A.w1,
  destinationWarehouseId: o.to ?? A.w2,
  lines: [piece(o.qty ?? '1')],
});
const adjustmentBody = (lines: readonly Record<string, unknown>[], o: { id?: string; warehouseId?: string } = {}): Record<string, unknown> => ({
  adjustmentId: o.id ?? randomUUID(),
  warehouseId: o.warehouseId ?? A.w1,
  occurredOn: day,
  reason: 'a counted correction',
  lines,
});
const damageBody = (qty: string, o: { id?: string } = {}): Record<string, unknown> => ({
  adjustmentId: o.id ?? randomUUID(),
  warehouseId: A.w1,
  occurredOn: day,
  reason: 'water damage',
  lines: [piece(qty)],
});

/** The refusal facts a response carries. */
function refusal(res: Response): { status: number; inventoryCode: unknown } {
  const details: unknown = res.body?.error?.details;
  const inventoryCode = typeof details === 'object' && details !== null && 'inventoryCode' in details ? details.inventoryCode : undefined;
  return { status: res.status, inventoryCode };
}

/** Nothing ran past the guard: no mint of either kind, no seam, and no row of the business changed. */
async function expectUntouched(before: Counts, what: string): Promise<void> {
  expect(invMint, `${what}: no inventory mint`).not.toHaveBeenCalled();
  expect(acctMint, `${what}: no accounting mint`).not.toHaveBeenCalled();
  expect(seam1, `${what}: no seam`).not.toHaveBeenCalled();
  expect(seam2, `${what}: no seam`).not.toHaveBeenCalled();
  expect(delta(before, await counts(ownerPool(), A.businessId)), `${what}: nothing written`).toEqual({});
}

/** The eight routes, each with a body that is well formed (state is irrelevant: the guard refuses first). */
function routes(): readonly { name: string; permission: string; call: (a: HttpActor) => Promise<Response> }[] {
  const st = randomUUID();
  return [
    { name: 'POST transfers', permission: 'inventory.transfer', call: (a) => send(a, 'post', 'transfers', transferBody()) },
    { name: 'POST adjustments', permission: 'inventory.adjust', call: (a) => send(a, 'post', 'adjustments', adjustmentBody([piece('1', { unitCost: '5' })])) },
    { name: 'POST damages', permission: 'inventory.adjust', call: (a) => send(a, 'post', 'damages', damageBody('1')) },
    { name: 'POST stocktakes', permission: 'inventory.stocktake', call: (a) => send(a, 'post', 'stocktakes', { stocktakeId: st, warehouseId: A.w1 }) },
    { name: 'PUT counts', permission: 'inventory.stocktake', call: (a) => send(a, 'put', `stocktakes/${st}/counts`, { lines: [piece('1')] }) },
    { name: 'POST finalize', permission: 'inventory.stocktake', call: (a) => send(a, 'post', `stocktakes/${st}/finalize`, { occurredOn: day }) },
    { name: 'POST cancel', permission: 'inventory.stocktake', call: (a) => send(a, 'post', `stocktakes/${st}/cancel`, {}) },
    {
      name: 'POST openings',
      permission: 'inventory.adjust',
      call: (a) =>
        send(a, 'post', 'openings', {
          openingId: randomUUID(),
          occurredOn: day,
          lines: [{ productId: A.piece.productId, warehouseId: A.w1, quantity: '1', unitCost: '1' }],
        }),
    },
  ];
}

// ── T-17.1-4 permissions ──────────────────────────────────────────────────

describe('T-17.1-3 each route refuses 403 without its permission, before the service runs', () => {
  it('the built-in manager (inventory.view only) and the cashier: 403 on all eight routes; nothing minted, no seam, nothing written', async () => {
    const before = await counts(ownerPool(), A.businessId);
    for (const r of routes()) {
      for (const [who, a] of [
        ['manager', manager],
        ['cashier', cashier],
      ] as const) {
        expect((await r.call(a)).status, `${who} ${r.name}`).toBe(403);
      }
    }
    await expectUntouched(before, 'manager and cashier');
  });

  it('each single-permission member is refused every route of the other two permissions', async () => {
    const before = await counts(ownerPool(), A.businessId);
    const holders = [
      ['inventory.transfer', mover],
      ['inventory.adjust', adjuster],
      ['inventory.stocktake', counter],
    ] as const;
    for (const r of routes()) {
      for (const [permission, a] of holders) {
        if (permission !== r.permission) expect((await r.call(a)).status, `${permission} holder on ${r.name}`).toBe(403);
      }
    }
    await expectUntouched(before, 'cross-permission');
  });
});

describe('T-17.4 ALLOW: each holder succeeds on its own routes; 201 then 200 replayed with the stored body', () => {
  it('inventory.adjust: opening, adjustment and damage — created, then replayed', async () => {
    const opening = { openingId: randomUUID(), occurredOn: day, lines: [{ productId: A.piece.productId, warehouseId: A.w1, quantity: '10', unitCost: '10' }] };
    const o1 = await send(adjuster, 'post', 'openings', opening);
    expect(o1.status).toBe(201);
    expect(o1.body).toMatchObject({ id: opening.openingId, replayed: false, case: 'ledger_posting', openingBalanceId: null, matchedAmountMinor: null });
    expect(o1.body.journalEntryId).toEqual(expect.any(String));
    const o2 = await send(adjuster, 'post', 'openings', opening);
    expect(o2.status).toBe(200);
    expect(o2.body).toEqual({ ...o1.body, replayed: true });

    const adj = adjustmentBody([piece('2', { unitCost: '13' })]);
    const a1 = await send(adjuster, 'post', 'adjustments', adj);
    expect(a1.status).toBe(201);
    expect(a1.body.lines).toEqual([
      { lineId: expect.any(String), productId: A.piece.productId, variantId: null, warehouseId: A.w1, qtyDelta: '2.0000', valueDeltaBaseMinor: '26' },
    ]);
    const a2 = await send(adjuster, 'post', 'adjustments', adj);
    expect(a2.status).toBe(200);
    expect(a2.body).toEqual({ ...a1.body, replayed: true });

    const dmg = damageBody('1');
    const d1 = await send(adjuster, 'post', 'damages', dmg);
    expect(d1.status).toBe(201);
    const d2 = await send(adjuster, 'post', 'damages', dmg);
    expect(d2.status).toBe(200);
    expect(d2.body).toEqual({ ...d1.body, replayed: true });
  });

  it('inventory.transfer: a transfer — created (no journal), then replayed', async () => {
    const body = transferBody({ qty: '1' });
    const r1 = await send(mover, 'post', 'transfers', body);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ id: body['transferId'], replayed: false, journalEntryId: null });
    expect(r1.body.lines.map((l: { warehouseId: string; qtyDelta: string }) => [l.warehouseId, l.qtyDelta])).toEqual([
      [A.w1, '-1.0000'],
      [A.w2, '1.0000'],
    ]);
    // T-03.5: one inventory assertion, no accounting assertion, only the one-assertion seam.
    expect(invMint).toHaveBeenCalledTimes(1);
    expect(acctMint).not.toHaveBeenCalled();
    expect(seam2).not.toHaveBeenCalled();
    expect(seam1).toHaveBeenCalledTimes(1);
    const r2 = await send(mover, 'post', 'transfers', body);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ ...r1.body, replayed: true });
  });

  it('inventory.stocktake: open (201, replay 200), counts (200, a repeat reports changed: false), finalize (200), and a second draft cancelled (200)', async () => {
    const stocktakeId = randomUUID();
    const s1 = await send(counter, 'post', 'stocktakes', { stocktakeId, warehouseId: A.w2 });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ id: stocktakeId, warehouseId: A.w2, status: 'draft', replayed: false });
    const s2 = await send(counter, 'post', 'stocktakes', { stocktakeId, warehouseId: A.w2 });
    expect(s2.status).toBe(200);
    expect({ ...s2.body, businessTransactionId: null }).toEqual({ ...s1.body, replayed: true, businessTransactionId: null });

    const c1 = await send(counter, 'put', `stocktakes/${stocktakeId}/counts`, { lines: [piece('0')] });
    expect(c1.status).toBe(200);
    expect(c1.body.lines).toMatchObject([{ productId: A.piece.productId, variantId: null, countedQty: '0.0000', changed: true }]);
    const c2 = await send(counter, 'put', `stocktakes/${stocktakeId}/counts`, { lines: [piece('0')] });
    expect(c2.status).toBe(200);
    expect(c2.body.lines).toMatchObject([{ changed: false }]);

    const f1 = await send(counter, 'post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day });
    expect(f1.status).toBe(200);
    expect(f1.body).toMatchObject({ id: stocktakeId, status: 'finalized', replayed: false });
    const f2 = await send(counter, 'post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day });
    expect(f2.status).toBe(200);
    expect({ ...f2.body, businessTransactionId: null }).toEqual({ ...f1.body, replayed: true, businessTransactionId: null });

    const second = randomUUID();
    expect((await send(counter, 'post', 'stocktakes', { stocktakeId: second, warehouseId: A.w2 })).status).toBe(201);
    const x = await send(counter, 'post', `stocktakes/${second}/cancel`, {});
    expect(x.status).toBe(200);
    expect(x.body).toMatchObject({ id: second, status: 'cancelled', lines: [], journalEntryId: null });
  });

  /**
   * REAL-BUG PIN (A-10(f): "a replay answers from stored rows only"; the DTO
   * contract: "the trace id of the operation that produced the document").
   * Adjustment, damage, transfer and opening replays answer the stored trace;
   * a stocktake-open or finalize replay answers the REPLAYING request's fresh
   * trace, because `stocktakes` stores no trace and
   * `InventoryStocktakeService` returns its own argument on the replay paths
   * (apps/api/src/modules/inventory/inventory-stocktake.service.ts:193 for
   * open, :307 for finalize/cancel). The replay is not the stored answer.
   */
  it('stocktake open and finalize: the replay answers the trace of the operation that produced the document', async () => {
    const stocktakeId = randomUUID();
    const first = await send(counter, 'post', 'stocktakes', { stocktakeId, warehouseId: A.w1 });
    expect(first.status).toBe(201);
    const audit = await ownerPool().query<{ trace: string }>(
      `SELECT metadata->>'business_transaction_id' AS trace FROM audit_events WHERE business_id = $1 AND action = 'inventory.stocktake_opened' AND entity_id = $2`,
      [A.businessId, stocktakeId],
    );
    expect(audit.rows).toEqual([{ trace: first.body.businessTransactionId }]);
    // A key that holds nothing, counted as nothing: a zero variance, so W1's stock is untouched for the cases below.
    expect((await send(counter, 'put', `stocktakes/${stocktakeId}/counts`, { lines: [{ productId: A.piece2.productId, quantity: '0' }] })).status).toBe(200);
    const fin = await send(counter, 'post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day });
    expect(fin.status).toBe(200);

    const openAgain = await send(counter, 'post', 'stocktakes', { stocktakeId, warehouseId: A.w1 });
    const finAgain = await send(counter, 'post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day });
    expect({ open: openAgain.status, finalize: finAgain.status }).toEqual({ open: 200, finalize: 200 });
    expect(
      { open: openAgain.body.businessTransactionId, finalize: finAgain.body.businessTransactionId },
      "the stored traces, not the replaying requests'",
    ).toEqual({ open: first.body.businessTransactionId, finalize: fin.body.businessTransactionId });
  });

  it('revocation by role edit: ALLOW while held; 403 with nothing minted at the very next request', async () => {
    expect((await send(revokee, 'post', 'transfers', transferBody())).status).toBe(201);
    expect(invMint).toHaveBeenCalledTimes(1);
    const roleId = must(
      (await ownerPool().query<{ id: string }>(`SELECT id::text FROM business_roles WHERE business_id = $1 AND key = 's3-revocable'`, [A.businessId])).rows[0],
    ).id;
    const edit = await t.request
      .patch(`/v1/businesses/current/roles/${roleId}`)
      .set(asMember(owner, A.businessId))
      .send({ permissions: ['catalog.view'] });
    expect(edit.status).toBe(200);
    clearSpies();
    const before = await counts(ownerPool(), A.businessId);
    expect((await send(revokee, 'post', 'transfers', transferBody())).status).toBe(403);
    await expectUntouched(before, 'revoked');
  });

  it('warehouse scope over BOTH ends of a transfer: an actor assigned to X only is refused W1→W2 (warehouse_out_of_scope); widened, the same body is accepted', async () => {
    const body = transferBody();
    const before = await counts(ownerPool(), A.businessId);
    expect(refusal(await send(narrow, 'post', 'transfers', body))).toEqual({ status: 403, inventoryCode: 'inventory.warehouse_out_of_scope' });
    expect(refusal(await send(narrow, 'post', 'transfers', transferBody({ from: A.w2, to: A.w1 }))), 'the reverse direction').toEqual({
      status: 403,
      inventoryCode: 'inventory.warehouse_out_of_scope',
    });
    await expectUntouched(before, 'out of scope');
    const widen = await t.request
      .patch(`/v1/businesses/current/members/${narrow.userId}/branch-scope`)
      .set(asMember(owner, A.businessId))
      .send({ mode: 'assigned', branchIds: [A.branchX, A.branchY] });
    expect(widen.status).toBe(200);
    expect((await send(narrow, 'post', 'transfers', body)).status).toBe(201);
  });
});

// ── T-17.5 DTO strictness ─────────────────────────────────────────────────

describe('T-17.5 strict DTOs: 400 before anything is minted', () => {
  it('JSON numbers, unknown keys, 201 lines, a missing occurredOn, non-canonical UUIDs in the body and the path', async () => {
    const st = randomUUID();
    const many = Array.from({ length: 201 }, () => piece('1'));
    const cases: [string, () => Promise<Response>][] = [
      [
        'transfer: a JSON number quantity',
        () => send(owner, 'post', 'transfers', { ...transferBody(), lines: [{ productId: A.piece.productId, quantity: 1 }] }),
      ],
      ['transfer: an unknown key (tenantId)', () => send(owner, 'post', 'transfers', { ...transferBody(), tenantId: A.tenantId })],
      ['transfer: an unknown line key (unitCost)', () => send(owner, 'post', 'transfers', { ...transferBody(), lines: [piece('1', { unitCost: '1' })] })],
      ['transfer: 201 lines', () => send(owner, 'post', 'transfers', { ...transferBody(), lines: many })],
      ['transfer: an upper-case id', () => send(owner, 'post', 'transfers', transferBody({ id: randomUUID().toUpperCase() }))],
      ['transfer: a zero quantity', () => send(owner, 'post', 'transfers', transferBody({ qty: '0' }))],
      [
        'adjustment: a JSON number cost',
        () => send(owner, 'post', 'adjustments', adjustmentBody([{ productId: A.piece.productId, quantity: '1', unitCost: 5 }])),
      ],
      [
        'adjustment: no occurredOn',
        () => {
          const { occurredOn: _omitted, ...rest } = adjustmentBody([piece('1', { unitCost: '5' })]);
          return send(owner, 'post', 'adjustments', rest);
        },
      ],
      [
        'adjustment: an impossible date',
        () => send(owner, 'post', 'adjustments', { ...adjustmentBody([piece('1', { unitCost: '5' })]), occurredOn: '2026-02-30' }),
      ],
      ['adjustment: a blank reason', () => send(owner, 'post', 'adjustments', { ...adjustmentBody([piece('-1')]), reason: '   ' })],
      ['adjustment: an authority flag (force)', () => send(owner, 'post', 'adjustments', { ...adjustmentBody([piece('-1')]), force: true })],
      ['damage: a negative quantity', () => send(owner, 'post', 'damages', damageBody('-1'))],
      ['damage: a unitCost', () => send(owner, 'post', 'damages', { ...damageBody('1'), lines: [piece('1', { unitCost: '1' })] })],
      ['stocktake: an unknown key (status)', () => send(owner, 'post', 'stocktakes', { stocktakeId: st, warehouseId: A.w1, status: 'finalized' })],
      ['counts: a JSON number', () => send(owner, 'put', `stocktakes/${st}/counts`, { lines: [{ productId: A.piece.productId, quantity: 3 }] })],
      ['counts: a path id that is not a UUID', () => send(owner, 'put', `stocktakes/${st.slice(0, 35)}/counts`, { lines: [piece('3')] })],
      ['finalize: a path id that is not a UUID', () => send(owner, 'post', 'stocktakes/not-a-uuid/finalize', { occurredOn: day })],
      ['finalize: no occurredOn', () => send(owner, 'post', `stocktakes/${st}/finalize`, {})],
      ['cancel: a body key', () => send(owner, 'post', `stocktakes/${st}/cancel`, { force: true })],
      [
        'opening: a quantity with 5 decimals',
        () =>
          send(owner, 'post', 'openings', {
            openingId: randomUUID(),
            occurredOn: day,
            lines: [{ productId: A.piece.productId, warehouseId: A.w1, quantity: '1.00001', unitCost: '1' }],
          }),
      ],
      [
        'opening: no occurredOn',
        () =>
          send(owner, 'post', 'openings', {
            openingId: randomUUID(),
            lines: [{ productId: A.piece.productId, warehouseId: A.w1, quantity: '1', unitCost: '1' }],
          }),
      ],
    ];
    const before = await counts(ownerPool(), A.businessId);
    for (const [what, call] of cases) expect((await call()).status, what).toBe(400);
    await expectUntouched(before, 'DTO refusals');
    expect((await send(owner, 'post', 'transfers', transferBody())).status, 'ALLOW: the well-formed transfer').toBe(201);
  });
});

// ── T-17.6 the §3 status mapping ──────────────────────────────────────────

describe('T-17.6 typed refusals and their statuses (§3)', () => {
  it('each refusal carries its stable code with its §3 status; each is paired with an accepted request', async () => {
    const transfer = transferBody({ qty: '1' });
    expect((await send(owner, 'post', 'transfers', transfer)).status).toBe(201);
    const draft = randomUUID();
    expect((await send(owner, 'post', 'stocktakes', { stocktakeId: draft, warehouseId: A.w1 })).status).toBe(201);
    const [v1] = A.variantProduct.variantIds;
    const mixed = await addTrackedProduct(ownerPool(), A, 'piece', 0);
    await addMerchantVariant(ownerPool(), A.businessId, mixed.productId);
    const cases: [string, () => Promise<Response>, number, string][] = [
      ['same warehouse on both ends', () => send(owner, 'post', 'transfers', transferBody({ to: A.w1 })), 400, 'inventory.transfer_same_warehouse'],
      ['more than the source holds', () => send(owner, 'post', 'transfers', transferBody({ qty: '9999' })), 409, 'inventory.insufficient_stock'],
      [
        'the transfer id with another body',
        () => send(owner, 'post', 'transfers', { ...transfer, lines: [piece('2')] }),
        409,
        'inventory.idempotency_conflict',
      ],
      [
        'an adjustment under the stocktake id',
        () => send(owner, 'post', 'adjustments', adjustmentBody([piece('-1')], { id: draft })),
        409,
        'inventory.document_id_conflict',
      ],
      ['a gain without a cost', () => send(owner, 'post', 'adjustments', adjustmentBody([piece('1')])), 400, 'inventory.unit_cost_required'],
      [
        'a product with a merchant variant, named without it',
        () => send(owner, 'post', 'adjustments', adjustmentBody([{ productId: mixed.productId, quantity: '1', unitCost: '1' }])),
        400,
        'inventory.variant_required',
      ],
      [
        'a variant-only product named without a variant (no base variant to resolve)',
        () => send(owner, 'post', 'adjustments', adjustmentBody([{ productId: A.variantProduct.productId, quantity: '1', unitCost: '1' }])),
        404,
        'inventory.variant_not_found',
      ],
      [
        'an untracked product',
        () =>
          send(
            owner,
            'post',
            'adjustments',
            adjustmentBody([{ productId: A.untracked.productId, variantId: A.untracked.variantId, quantity: '1', unitCost: '1' }]),
          ),
        400,
        'inventory.product_not_tracked',
      ],
      [
        'an unknown product',
        () => send(owner, 'post', 'adjustments', adjustmentBody([{ productId: randomUUID(), quantity: '1', unitCost: '1' }])),
        404,
        'inventory.product_not_found',
      ],
      [
        'an unknown variant',
        () =>
          send(
            owner,
            'post',
            'adjustments',
            adjustmentBody([{ productId: A.variantProduct.productId, variantId: randomUUID(), quantity: '1', unitCost: '1' }]),
          ),
        404,
        'inventory.variant_not_found',
      ],
      [
        'an unknown warehouse',
        () => send(owner, 'post', 'adjustments', adjustmentBody([piece('1', { unitCost: '1' })], { warehouseId: randomUUID() })),
        404,
        'inventory.warehouse_not_found',
      ],
      [
        'a second draft on the warehouse',
        () => send(owner, 'post', 'stocktakes', { stocktakeId: randomUUID(), warehouseId: A.w1 }),
        409,
        'inventory.stocktake_already_open',
      ],
      [
        'counts on an unknown stocktake',
        () => send(owner, 'put', `stocktakes/${randomUUID()}/counts`, { lines: [piece('1')] }),
        404,
        'inventory.stocktake_not_found',
      ],
      [
        'a second opening',
        () =>
          send(owner, 'post', 'openings', {
            openingId: randomUUID(),
            occurredOn: day,
            lines: [{ productId: A.piece2.productId, warehouseId: A.w1, quantity: '1', unitCost: '1' }],
          }),
        409,
        'inventory.opening_already_posted',
      ],
    ];
    for (const [what, call, status, code] of cases) {
      const before = await counts(ownerPool(), A.businessId);
      expect(refusal(await call()), what).toEqual({ status, inventoryCode: code });
      expect(delta(before, await counts(ownerPool(), A.businessId)), `${what}: nothing written`).toEqual({});
    }
    expect((await send(owner, 'post', `stocktakes/${draft}/cancel`, {})).status, 'ALLOW: the draft closes').toBe(200);
    expect(refusal(await send(owner, 'put', `stocktakes/${draft}/counts`, { lines: [piece('1')] }))).toEqual({
      status: 409,
      inventoryCode: 'inventory.stocktake_state_invalid',
    });
    const allow = await send(
      owner,
      'post',
      'adjustments',
      adjustmentBody([{ productId: A.variantProduct.productId, variantId: v1, quantity: '1', unitCost: '1' }]),
    );
    expect(allow.status, 'ALLOW: the merchant variant named').toBe(201);
  });

  /**
   * REAL-BUG PIN (§3: `inventory.stocktake_empty` 400 for finalizing a draft
   * with no counted line). `InventoryStocktakeService.runClose` computes the
   * finalize intent digest over the stored lines BEFORE its empty check, and
   * the package builder refuses zero lines first, so the client receives
   * `inventory.lines_required` and the §3 code is unreachable
   * (apps/api/src/modules/inventory/inventory-stocktake.service.ts:298 runs
   * before :310). Same status; wrong stable code.
   */
  it('finalizing a draft with no counted line is inventory.stocktake_empty (400); counted, it finalizes', async () => {
    const draft = randomUUID();
    expect((await send(owner, 'post', 'stocktakes', { stocktakeId: draft, warehouseId: A.w2 })).status).toBe(201);
    const before = await counts(ownerPool(), A.businessId);
    const empty = await send(owner, 'post', `stocktakes/${draft}/finalize`, { occurredOn: day });
    expect(delta(before, await counts(ownerPool(), A.businessId)), 'nothing written').toEqual({});
    const closeDraft = async (): Promise<void> => {
      expect((await send(owner, 'put', `stocktakes/${draft}/counts`, { lines: [{ productId: A.piece2.productId, quantity: '0' }] })).status).toBe(200);
      expect((await send(owner, 'post', `stocktakes/${draft}/finalize`, { occurredOn: day })).status, 'ALLOW: counted, it finalizes').toBe(200);
    };
    await closeDraft();
    expect(refusal(empty)).toEqual({ status: 400, inventoryCode: 'inventory.stocktake_empty' });
  });

  it('Case B: a stock total off the opening position is opening_valuation_mismatch (409) with both totals; the exact one binds (201)', async () => {
    const B = await onboardS3Business(t, owner, 'http-b');
    const c = await ownerClient();
    let openingBalanceId = '';
    try {
      await c.query('BEGIN');
      openingBalanceId = (await postOpeningBalanceInTx(c, B, day, [position('inventory', 'D', 5000n), position('cash', 'D', 1000n)])).openingBalanceId;
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const opening = (unitCost: string): Record<string, unknown> => ({
      openingId: randomUUID(),
      occurredOn: day,
      lines: [{ productId: B.piece.productId, warehouseId: B.w1, quantity: '4', unitCost }],
    });
    const post = (body: Record<string, unknown>): Promise<Response> => t.request.post('/v1/inventory/openings').set(asMember(owner, B.businessId)).send(body);
    const off = await post(opening('1250.5'));
    expect(off.status).toBe(409);
    expect(off.body.error.details).toEqual({ inventoryCode: 'inventory.opening_valuation_mismatch', stockTotalMinor: '5002', openingPositionMinor: '5000' });
    const exact = await post(opening('1250'));
    expect(exact.status).toBe(201);
    expect(exact.body).toMatchObject({ case: 'opening_balance_bound', openingBalanceId, matchedAmountMinor: '5000', journalEntryId: null });
  });
});

// ── T-17.7 the hidden base variant ────────────────────────────────────────

describe('T-17.7 the base variant never appears in a response', () => {
  it('a simple product answers variantId null and its base variant id appears nowhere; a merchant variant is named', async () => {
    const [v1] = A.variantProduct.variantIds;
    const res = await send(
      owner,
      'post',
      'adjustments',
      adjustmentBody([piece('1', { unitCost: '2' }), { productId: A.variantProduct.productId, variantId: v1, quantity: '1', unitCost: '2' }]),
    );
    expect(res.status).toBe(201);
    expect(res.body.lines.map((l: { productId: string; variantId: string | null }) => [l.productId, l.variantId])).toEqual([
      [A.piece.productId, null],
      [A.variantProduct.productId, v1],
    ]);
    expect(JSON.stringify(res.body)).not.toContain(A.piece.variantId);
    const st = randomUUID();
    expect((await send(owner, 'post', 'stocktakes', { stocktakeId: st, warehouseId: A.w2 })).status).toBe(201);
    const counted = await send(owner, 'put', `stocktakes/${st}/counts`, { lines: [piece('0')] });
    expect(counted.status).toBe(200);
    expect(JSON.stringify(counted.body)).not.toContain(A.piece.variantId);
    expect((await send(owner, 'post', `stocktakes/${st}/cancel`, {})).status).toBe(200);
  });
});

// ── T-17.8 the trace and the signed actor in the audit ────────────────────

describe('T-17.8 the audit row names the signed member and carries the response trace; a replay keeps the first trace', () => {
  it('an adjustment by a non-owner member', async () => {
    const body = adjustmentBody([piece('1', { unitCost: '3' })]);
    const res = await send(adjuster, 'post', 'adjustments', body);
    expect(res.status).toBe(201);
    const audit = await ownerPool().query<{ actor_user_id: string; trace: string }>(
      `SELECT actor_user_id::text, metadata->>'business_transaction_id' AS trace FROM audit_events WHERE business_id = $1 AND action = 'inventory.stock_adjusted' AND entity_id = $2`,
      [A.businessId, body['adjustmentId']],
    );
    expect(audit.rows).toEqual([{ actor_user_id: adjuster.userId, trace: res.body.businessTransactionId }]);
    const again = await send(adjuster, 'post', 'adjustments', body);
    expect(again.body.businessTransactionId).toBe(res.body.businessTransactionId);
  });
});

// ── T-11.2 the proof before the state, at the service ─────────────────────

describe('T-11.2 the service proves a replay before it reads any stock', () => {
  it('drain the stock after a loss; the replay answers 200 with zero stock reads, zero mints and no seam; a fresh id is refused insufficient_stock', async () => {
    const c = await ownerClient();
    const onHand = async (): Promise<string> =>
      must(
        (
          await c.query<{ q: string }>(`SELECT on_hand::text AS q FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
            A.businessId,
            A.w1,
            A.piece.variantId,
          ])
        ).rows[0],
      ).q;
    try {
      const held = await onHand();
      const loss = adjustmentBody([piece('-1')]);
      const first = await send(owner, 'post', 'adjustments', loss);
      expect(first.status).toBe(201);
      const rest = (Number(held) - 1).toString();
      expect((await send(owner, 'post', 'damages', damageBody(rest))).status).toBe(201);
      expect(await onHand()).toBe('0.0000');

      clearSpies();
      const replay = await send(owner, 'post', 'adjustments', loss);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, replayed: true });
      const stockReads = scoped.mock.calls.filter(([, text]) => /\bstock_levels\b/.test(text));
      expect(stockReads, 'zero stock reads').toEqual([]);
      expect(invMint).not.toHaveBeenCalled();
      expect(acctMint).not.toHaveBeenCalled();
      expect(seam1).not.toHaveBeenCalled();
      expect(seam2).not.toHaveBeenCalled();

      const fresh = await send(owner, 'post', 'adjustments', { ...loss, adjustmentId: randomUUID() });
      expect(refusal(fresh), 'the same body judged on the drained stock').toEqual({ status: 409, inventoryCode: 'inventory.insufficient_stock' });
      expect(
        scoped.mock.calls.some(([, text]) => /\bstock_levels\b/.test(text)),
        'the fresh command did read stock',
      ).toBe(true);
    } finally {
      await c.end();
    }
  });
});

// ── A-06: the generic entry point refuses the domain-owned sources ─────────

describe('A-06 AccountingEngine.post refuses inventory_adjustment and inventory_opening before minting', () => {
  it('accounting.assertion_wrong_source for both; the domain command posts the same entry (ALLOW above)', async () => {
    const engine = t.app.get(AccountingEngine, { strict: false });
    const base = {
      tenantId: A.tenantId,
      businessId: A.businessId,
      sourceId: randomUUID(),
      occurredOn: day,
      baseCurrency: 'ILS',
      businessTransactionId: randomUUID(),
    };
    const commands = [
      must(adjustmentPostingCommand({ ...base, warehouseId: A.w1, branchId: A.branchX, netValueMinor: 100n })),
      must(openingPostingCommand({ ...base, perWarehouse: [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 100n }] })),
    ];
    const before = await counts(ownerPool(), A.businessId);
    for (const command of commands) {
      const posting = engine.post(command, { actorUserId: owner.userId, branchScope: { mode: 'all' } });
      await expect(posting, command.sourceType).rejects.toBeInstanceOf(AccountingError);
      await expect(posting, command.sourceType).rejects.toMatchObject({ code: 'accounting.assertion_wrong_source' });
    }
    expect(acctMint).not.toHaveBeenCalled();
    expect(delta(before, await counts(ownerPool(), A.businessId))).toEqual({});
  });
});

// ── T-02 over HTTP: the same owner, two businesses of one tenant ──────────

describe('T-02 HTTP: the same owner switching business reaches only the business the request names', () => {
  it('a transfer in A naming A2’s warehouse is refused with nothing written in either; A’s document is not answered in A2; A2’s own is', async () => {
    const A2 = await onboardS3Business(t, owner, 'http-a2', A.tenantId);
    const inA2 = (body: Record<string, unknown>): Promise<Response> =>
      t.request.post('/v1/inventory/adjustments').set(asMember(owner, A2.businessId)).send(body);
    const beforeA = await counts(ownerPool(), A.businessId);
    const beforeA2 = await counts(ownerPool(), A2.businessId);
    expect(refusal(await send(owner, 'post', 'transfers', transferBody({ to: A2.w1 }))), 'A.W1 → A2.W1').toEqual({
      status: 404,
      inventoryCode: 'inventory.warehouse_not_found',
    });
    const inA = adjustmentBody([piece('1', { unitCost: '4' })]);
    expect((await send(owner, 'post', 'adjustments', inA)).status, 'the document in A').toBe(201);
    const afterA = await counts(ownerPool(), A.businessId);
    expect(refusal(await inA2(inA)), 'A’s body replayed under A2: A’s stored answer is not disclosed').toEqual({
      status: 404,
      inventoryCode: 'inventory.product_not_found',
    });
    expect(delta(beforeA2, await counts(ownerPool(), A2.businessId)), 'A2 untouched by the refusals').toEqual({});

    const own = await inA2({ ...inA, warehouseId: A2.w1, lines: [{ productId: A2.piece.productId, quantity: '1', unitCost: '4' }] });
    expect(own.status, 'ALLOW: A2’s own ids under A2, even with the same document id').toBe(201);
    expect(own.body.lines).toMatchObject([{ productId: A2.piece.productId, warehouseId: A2.w1 }]);
    expect(delta(afterA, await counts(ownerPool(), A.businessId)), 'A untouched by A2’s request').toEqual({});
    expect(delta(beforeA, afterA)['inventory_adjustments']).toBe(1);
  });
});

// ── T-06.11 the reversal route refuses an inventory-owned entry ────────────

describe('T-06.11 POST …/entries/:id/reversals of an inventory entry is reversal_source_domain_owned (409); an ordinary entry reverses', () => {
  it('the adjustment’s entry is refused; a manual adjustment’s entry is reversed', async () => {
    const adj = await send(owner, 'post', 'adjustments', adjustmentBody([piece('1', { unitCost: '6' })]));
    expect(adj.status).toBe(201);
    const entryId = String(adj.body.journalEntryId);
    const reverse = (id: string): Promise<Response> =>
      t.request
        .post(`/v1/businesses/${A.businessId}/accounting/entries/${id}/reversals`)
        .set(asMember(owner, A.businessId))
        .send({ entryDate: day, reason: 'undo it' });
    const before = await counts(ownerPool(), A.businessId);
    const refused = await reverse(entryId);
    expect({ status: refused.status, code: refused.body?.error?.details?.code }).toEqual({ status: 409, code: 'accounting.reversal_source_domain_owned' });
    expect(delta(before, await counts(ownerPool(), A.businessId))).toEqual({});

    const fixture = {
      tenantId: A.tenantId,
      businessId: A.businessId,
      userId: owner.userId,
      branchId: A.branchX,
      otherBranchId: A.branchY,
      warehouseId: A.w1,
      otherTenantId: A.tenantId,
      otherBusinessId: A.businessId,
      otherUserId: owner.userId,
    };
    const manual = await postManualAdjustment(simpleCommand(fixture, randomUUID(), day, 700n), owner.userId);
    expect((await reverse(manual.entryId)).status, 'ALLOW: an ordinary entry reverses').toBe(201);
  });
});
