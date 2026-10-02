/**
 * P4-S3 — THE POS TYPE-AHEAD, ITS ISOLATION AND ITS PACING.
 *
 * `GET /v1/pos/products` is the first Phase 4 read a cashier drives from the
 * keyboard, and the first that can approach the API's own route allowance. Four
 * things are proved here, in this order:
 *
 * 1. THE CONTRACT. A prefix of a barcode, a SKU or a name finds the sellable
 *    unit; a substring that is not a prefix does not. A barcode outranks a SKU
 *    and a SKU outranks a name, because a scanner's answer must be the first
 *    row. The hidden base variant reads as `variantId: null` (P3-AL-52), an
 *    archived product or variant is not offered, an untracked product has
 *    `onHand: null` rather than `0`, and a prefix too broad for one page says
 *    so in `moreMatches` instead of handing out a page two that `OFFSET` would
 *    have had to read and discard.
 *
 * 2. THE ISOLATION, BY RLS AND NOT BY A PREDICATE. Three businesses hold the
 *    SAME SKU and the SAME barcode: A, A2 (another business of the same owner
 *    in the same tenant) and B (another tenant entirely). The registry of
 *    `0037` makes an identifier unique per BUSINESS, so this is a legal
 *    catalogue and the sharpest probe there is — a read that leaked would
 *    return a row that looks exactly like the right answer.
 *
 *    Over HTTP the proof is that A's till never sees A2's or B's row. But an
 *    HTTP test cannot tell a correct policy from a lucky `WHERE business_id`,
 *    so the isolation is also proved on a REAL `daftar_app` connection, with
 *    the scope GUCs a request sets and **the business predicate deliberately
 *    removed** from each of the four relations the read touches. No row of
 *    anyone else comes back. And because a probe that cannot fail proves
 *    nothing, every case carries its own negative control: the identical
 *    statement as the schema owner — who does bypass row security — returns
 *    more than one business's rows, so the probe is demonstrably able to see a
 *    leak. RLS is never weakened, disabled or bypassed for any of it.
 *
 * 3. THE PACING (P4-AL-69). The API allows 300 requests per minute per route
 *    handler and client (`runtime.ts`), and this suite deliberately drives MORE
 *    than 300 type-aheads at that one handler, from one loopback client — so
 *    the allowance is genuinely in play and the pacing is load-bearing rather
 *    than decorative. The limiter is NOT raised and no threshold is relaxed:
 *    every request in this file goes through the `SlidingBudget` the browser
 *    gate paces with (`tests/browser/pacer.ts`), set to the gate's own 270,
 *    which is ten percent of headroom under the API's 300. A 429 stays a
 *    reported error. The suite also asserts, from the composing module's own
 *    source, that the allowance is still `{ ttl: 60_000, limit: 300 }`: a
 *    future "fix" that raised it to make something pass would delete the
 *    protection this case exercises, and would fail here.
 *
 * 4. THE REFUSALS, EVERY ONE OF THEM ABOUT THE SESSION (RULING 2). The till
 *    names its SESSION and the server derives the warehouse, so none of these
 *    is a warehouse the client chose: a session another business owns is
 *    invisible and answers `pos.session_not_found`; a colleague's open till in
 *    the caller's own business is visible and still refused
 *    `pos.session_not_owned` (`OD-P4-09`); the caller's own CLOSED till answers
 *    `pos.session_not_open`; and a session whose frozen warehouse the member
 *    has since been reassigned away from answers
 *    `pos.warehouse_out_of_scope`. Not one of them is an empty page — an empty
 *    page reads as "nothing in stock", which is a different and wrong answer,
 *    and a cashier acting on it refuses a sale of stock that is on the shelf. A
 *    member holding neither `sales.create` nor `sales.view` is refused, and an
 *    unknown query parameter — `warehouseId` included, by name — is refused
 *    rather than ignored, because a POS client whose filter was silently
 *    dropped believes it asked for something the server never did.
 *
 * 5. THE REAL TRANSPORT. Every request here goes through `createTestApp()`,
 *    which composes the production `AppModule` — the same `TillSessionsController`,
 *    `PosReadsController` and `PosCartController` production serves. The
 *    test-only harness this suite used to import
 *    (`tests/helpers/pos-s3-route.ts`, which constructed `PosReadService` by
 *    hand inside a test-declared controller) is DELETED. Until it was, every
 *    assertion in this file measured a hand-built object rather than a route a
 *    cashier can reach, and would have passed with the real route absent. The
 *    fixture's own `POST /v1/pos/till-sessions` is now part of the evidence.
 *
 * Run with `PG_PORT=55140 PG_DIR=/tmp/daftar-pg-c`, as every P4-S3 suite of
 * this agent does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PosProductHitDto, PosProductSearchDto } from '@daftar/shared-contracts';
import { appDbUrl, createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { POS_READ_ROUTE_AUTHORITY } from '../../apps/api/src/modules/pos/pos-reads';
import { P4_S3_REQUIRED_CONTROLLERS } from '../../apps/api/src/modules/pos/pos-permissions';
import { closeTillSession, openTillSession } from '../helpers/pos-till-sessions';
import { asMember, must, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { addMerchantVariant, configureRaw, createProduct, setScope } from '../helpers/stock-ledger';
import { addMember, httpAdjust, nameProduct, nameVariant, readAs } from '../helpers/merchant-reads';
import { SlidingBudget } from '../browser/pacer';

/** The identifiers A, A2 and B all hold. `0037` scopes uniqueness to the business, so this is legal. */
const SHARED = { sku: 'POS-APL-01', barcode: '7290000111111' } as const;

/** The API's general allowance, and the pacer's ceiling beneath it (the browser gate's `ROUTE_BUDGET`). */
const API_ROUTE_LIMIT = 300;
const PACER_BUDGET = 270;
const PACER_WINDOW_MS = 60_000;
/** Keystrokes the type-ahead case drives: bounded (P4-AL-69), and chosen to put the 300/min allowance in play. */
const KEYSTROKES = 220;
/** Type-aheads the "writes nothing" case drives. */
const IDLE_READS = 60;

/**
 * ONE pacer for the whole file, because the API counts one bucket for the
 * whole file: every request here reaches the same route handler from the same
 * loopback client. A per-case pacer would let three cases spend 270 each and
 * meet the very limiter this suite exists to stay under.
 */
const pacer = new SlidingBudget('GET /v1/pos/products', PACER_BUDGET, PACER_WINDOW_MS);
let pacerWaitedMs = 0;
let pacedRequests = 0;

let t: TestApp;
let owner: HttpActor;
let ownerB: HttpActor;
let manager: HttpActor;
let clerk: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;
let baseCurrency: string;
let applePriceMinor: string;
let shirtL: string;
let shirtM: string;
/**
 * The open tills every case below reads through. One per (actor, business),
 * because `pos_till_sessions_one_open_per_user_uq` is a partial unique index
 * on `(business_id, opened_by) WHERE status = 'open'`: an actor holds at most
 * ONE open drawer in a business, which is `OD-P4-09` in the schema. Two
 * warehouses at once therefore needs two ACTORS, and that is the ruling rather
 * than an obstacle.
 */
let tillA: string;
let tillA2: string;
let tillB: string;
/** The branch-Y manager's till, whose warehouse is W2 — the second warehouse this file reads. */
let tillManagerW2: string;
/** A CLOSED till of its own owner, for the one refusal only a closed session can produce. */
let tillClosed: string;
/** A second cashier in A, so a colleague's open till exists to be refused by name. */
let cashier: HttpActor;

/** A scoped write by the schema owner, so the identifier triggers of `0037` run with a business context. */
async function scopedWrite(s: S3Business, sql: string, params: readonly unknown[]): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    await setScope(c, { tenantId: s.tenantId, businessId: s.businessId });
    await c.query(sql, [...params]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

const identifyProduct = (s: S3Business, productId: string, sku: string | null, barcode: string | null): Promise<void> =>
  scopedWrite(s, 'UPDATE products SET sku = $3, barcode = $4 WHERE business_id = $1 AND id = $2', [s.businessId, productId, sku, barcode]);

const identifyVariant = (s: S3Business, variantId: string, sku: string | null, barcode: string | null): Promise<void> =>
  scopedWrite(s, 'UPDATE product_variants SET sku = $3, barcode = $4 WHERE business_id = $1 AND id = $2', [s.businessId, variantId, sku, barcode]);

const archive = (s: S3Business, table: 'products' | 'product_variants', id: string): Promise<void> =>
  scopedWrite(s, `UPDATE ${table} SET status = 'archived' WHERE business_id = $1 AND id = $2`, [s.businessId, id]);

interface SearchResult {
  readonly status: number;
  readonly body: PosProductSearchDto & { readonly error?: { readonly code: string; readonly details?: Record<string, unknown> } };
}

/** Every HTTP call in this file goes through here, so every one of them is paced. */
async function paced(by: HttpActor, businessId: string, path: string, locale = 'en'): Promise<SearchResult> {
  pacerWaitedMs += await pacer.take();
  pacedRequests += 1;
  const r = await readAs(t, by, businessId, path, locale);
  return { status: r.status, body: r.body as SearchResult['body'] };
}

/**
 * THE TILL NAMES ITS SESSION, AND THE SERVER DERIVES THE WAREHOUSE (RULING 2).
 *
 * Every call in this file used to send `warehouseId=…`, and
 * `PosProductSearchQuerySchema` has refused that since Ruling 2 replaced it:
 * twenty assertions here answered 400 with `{"path":"sessionId","code":
 * "invalid_type"}` plus `unrecognized_keys`, which is a suite measuring the
 * validator rather than the read.
 *
 * The realignment is to open REAL till sessions in the fixture and name them.
 * It is deliberately NOT to re-add `warehouseId`: a client that could name the
 * warehouse could name one its own open till does not sell from, which is
 * `P4-AL-18` exactly — the client would be the source of truth for the scope of
 * its own read. Nor is any assertion lowered: the warehouse-shaped claims below
 * are restated as SESSION-shaped claims of the same strength, and the two
 * refusals that only a session can produce (`pos.session_not_owned`,
 * `pos.session_not_open`) are added rather than traded for the one Ruling 2
 * made unreachable.
 */
function searchPath(sessionId: string, q: string, limit?: number): string {
  return `/v1/pos/products?sessionId=${sessionId}&q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`;
}

const search = (
  by: HttpActor,
  biz: { businessId: string },
  sessionId: string,
  q: string,
  opts: { limit?: number; locale?: string } = {},
): Promise<SearchResult> => paced(by, biz.businessId, searchPath(sessionId, q, opts.limit), opts.locale);

async function hits(q: string, opts: { limit?: number; locale?: string } = {}): Promise<PosProductHitDto[]> {
  const r = await search(owner, A, tillA, q, opts);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.items;
}

/** A tracked, base-variant product carrying A's identifiers, in another business, with stock. */
async function twinCatalogue(by: HttpActor, s: S3Business, name: string): Promise<string> {
  const pool = ownerPool();
  const productId = await createProduct(pool, s.businessId);
  await configureRaw(pool, { tenantId: s.tenantId, businessId: s.businessId }, productId, 'piece', 0, true);
  await nameProduct(s.businessId, productId, { en: name });
  await identifyProduct(s, productId, SHARED.sku, SHARED.barcode);
  await httpAdjust(t, by, s, s.w1, [{ productId, quantity: '3', unitCost: '1.00' }]);
  return productId;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'POS S3 owner');
  A = await onboardS3Business(t, owner, 'poss3a');
  A2 = await onboardS3Business(t, owner, 'poss3a2', A.tenantId);
  ownerB = await registerActor(t, 'POS S3 other owner');
  B = await onboardS3Business(t, ownerB, 'poss3b');

  // The manager is ASSIGNED to branch Y, so it reaches W2 and never W1.
  manager = await addMember(t, owner, A, 'POS S3 manager', 'manager', [A.branchY]);

  // A member with catalogue rights and NO sales key at all. The three built-in
  // roles all hold `sales.view`, so proving the permission boundary needs a
  // custom role rather than a built-in one.
  const role = await t.request
    .post('/v1/businesses/current/roles')
    .set(asMember(owner, A.businessId))
    .send({ key: 'stockclerk', name: 'Stock clerk', permissions: ['catalog.view', 'inventory.view'] });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  clerk = await registerActor(t, 'POS S3 clerk');
  const add = await t.request.post('/v1/businesses/current/members').set(asMember(owner, A.businessId)).send({ email: clerk.email, roleKey: 'stockclerk' });
  expect(add.status, JSON.stringify(add.body)).toBe(201);

  // ── A's catalogue ────────────────────────────────────────────────────
  await nameProduct(A.businessId, A.piece.productId, { ar: 'تفاح أحمر', en: 'Apple Red', tr: 'Kırmızı Elma' });
  await identifyProduct(A, A.piece.productId, SHARED.sku, SHARED.barcode);

  await nameProduct(A.businessId, A.piece2.productId, { en: 'Apricot Jam' });
  await identifyProduct(A, A.piece2.productId, 'POS-APR-02', '7290000222222');

  // Named in `ar` ONLY: the Phase 1 locale fallback must still find and name it.
  await nameProduct(A.businessId, A.dec2.productId, { ar: 'سلك نحاسي' });
  await identifyProduct(A, A.dec2.productId, 'POS-WIRE-03', null);

  await nameProduct(A.businessId, A.variantProduct.productId, { en: 'Shirt' });
  shirtL = must(A.variantProduct.variantIds[0]);
  shirtM = must(A.variantProduct.variantIds[1]);
  await nameVariant(A.businessId, shirtL, { size: 'L' });
  await nameVariant(A.businessId, shirtM, { size: 'M' });
  await identifyVariant(A, shirtL, 'POS-SHIRT-L', '7290000333331');
  await identifyVariant(A, shirtM, 'POS-SHIRT-M', '7290000333332');
  // An archived merchant variant of the same product: never offered.
  const shirtX = await addMerchantVariant(ownerPool(), A.businessId, A.variantProduct.productId);
  await identifyVariant(A, shirtX, 'POS-SHIRT-X', null);
  await archive(A, 'product_variants', shirtX);

  // Untracked: `onHand` must be null, not 0 — a gift card is always sellable.
  await nameProduct(A.businessId, A.untracked.productId, { en: 'Gift Card' });
  await identifyProduct(A, A.untracked.productId, 'POS-GIFT-09', null);

  // A product whose NAME starts with the SKU everyone searches for, so the
  // barcode > SKU > name ranking has something to order.
  const lookalike = await createProduct(ownerPool(), A.businessId);
  await configureRaw(ownerPool(), { tenantId: A.tenantId, businessId: A.businessId }, lookalike, 'piece', 0, true);
  await nameProduct(A.businessId, lookalike, { en: `${SHARED.sku} lookalike` });

  // An archived product that would otherwise match every probe.
  const archivedProductId = await createProduct(ownerPool(), A.businessId);
  await configureRaw(ownerPool(), { tenantId: A.tenantId, businessId: A.businessId }, archivedProductId, 'piece', 0, true);
  await nameProduct(A.businessId, archivedProductId, { en: 'Apple Archived' });
  await identifyProduct(A, archivedProductId, 'POS-APL-99', '7290000999999');
  await archive(A, 'products', archivedProductId);

  // Stock at W1 for the apple, so `onHand` is a real figure and not a zero.
  await httpAdjust(t, owner, A, A.w1, [{ productId: A.piece.productId, quantity: '7', unitCost: '2.00' }]);

  // ── The two decoy catalogues, with A's identifiers ───────────────────
  await twinCatalogue(owner, A2, 'Apple Red');
  await twinCatalogue(ownerB, B, 'Apple Red');

  const facts = await ownerPool().query<{ base_currency: string; base_price_minor: string }>(
    `SELECT b.base_currency, p.base_price_minor::text AS base_price_minor
       FROM businesses b JOIN products p ON p.business_id = b.id AND p.id = $2
      WHERE b.id = $1`,
    [A.businessId, A.piece.productId],
  );
  baseCurrency = must(facts.rows[0]).base_currency;
  applePriceMinor = must(facts.rows[0]).base_price_minor;

  // ── The tills, opened through the REAL route ─────────────────────────
  //
  // `POST /v1/pos/till-sessions` in the production composition, as each actor,
  // and nothing else. No row is inserted by hand: `daftar_app` holds SELECT
  // only on `pos_till_sessions` (`0079:605`), every write goes through a
  // SECURITY DEFINER routine consuming an `invctl/1` assertion, and a session
  // seeded past that would be a scope no cashier could have created. If the
  // mount, the provider wiring or the minting is wrong, this fixture fails
  // with the route's own refusal body — which is the point of reaching the
  // routes through the composition rather than through a bespoke harness.
  tillA = (await openTillSession(t, owner, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_a1' })).sessionId;
  tillA2 = (await openTillSession(t, owner, A2.businessId, { branchId: A2.branchX, warehouseId: A2.w1 }, { terminalCode: 'poss3_a2' })).sessionId;
  tillB = (await openTillSession(t, ownerB, B.businessId, { branchId: B.branchX, warehouseId: B.w1 }, { terminalCode: 'poss3_b1' })).sessionId;
  // The manager is ASSIGNED to branch Y, so its till sells from W2 — the only
  // way this file reads a second warehouse, now that the warehouse is a fact
  // of the session and not a query parameter.
  tillManagerW2 = (await openTillSession(t, manager, A.businessId, { branchId: A.branchY, warehouseId: A.w2 }, { terminalCode: 'poss3_w2' })).sessionId;
  // A second cashier in A: its OPEN till is the colleague's drawer that
  // `pos.session_not_owned` refuses, and the till it then closes is the
  // subject of `pos.session_not_open`.
  cashier = await addMember(t, owner, A, 'POS S3 cashier', 'cashier');
  tillClosed = (await openTillSession(t, cashier, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_shut' })).sessionId;
  await closeTillSession(t, cashier, A.businessId, tillClosed);

  // P4-AL-74: a benchmark — and a correctness read whose plan matters —
  // measures what the planner saw.
  await ownerPool().query('ANALYZE');
}, 900_000);

afterAll(async () => {
  console.info('[P4-S3] pacing total', JSON.stringify({ pacedRequests, pacerWaitedMs, budget: PACER_BUDGET, apiLimit: API_ROUTE_LIMIT }));
  await t.close();
  await resetData();
});

describe('the contract of the type-ahead', () => {
  it('a whole barcode finds its unit, and says the barcode is what matched', async () => {
    const items = await hits(SHARED.barcode);
    expect(items.map((h) => ({ id: h.productId, on: h.matchedOn }))).toEqual([{ id: A.piece.productId, on: 'barcode' }]);
    expect(items[0]?.variantId, 'a simple product never names its base variant').toBeNull();
    expect(items[0]?.barcode).toBe(SHARED.barcode);
  });

  it('a barcode PREFIX finds it too — a scanner that sent half a code still narrows', async () => {
    expect((await hits('729000011')).map((h) => h.productId)).toEqual([A.piece.productId]);
  });

  it('a SKU prefix matches, and matches whatever case the cashier typed', async () => {
    const lower = (await hits('pos-apr')).map((h) => h.sku);
    const upper = (await hits('POS-APR')).map((h) => h.sku);
    expect(lower).toEqual(['POS-APR-02']);
    expect(upper).toEqual(lower);
  });

  it('a name prefix matches, and the name comes back in the locale asked for', async () => {
    expect((await hits('appl', { locale: 'en' })).map((h) => h.name)).toEqual(['Apple Red']);
    expect((await hits('kırmızı', { locale: 'tr' })).map((h) => h.name)).toEqual(['Kırmızı Elma']);
    expect((await hits('تفاح', { locale: 'ar' })).map((h) => h.name)).toEqual(['تفاح أحمر']);
  });

  it('a product named only in `ar` is found by its Arabic prefix and named by the `ar` fallback in an `en` till', async () => {
    const items = await hits('سلك', { locale: 'en' });
    expect(items.map((h) => ({ id: h.productId, name: h.name }))).toEqual([{ id: A.dec2.productId, name: 'سلك نحاسي' }]);
  });

  it('a substring that is NOT a prefix is not a match — this read is a prefix read, by index and by contract', async () => {
    expect(await hits('ple')).toEqual([]);
    expect(await hits('ricot')).toEqual([]);
    expect(await hits('90000111')).toEqual([]);
  });

  it('a barcode outranks a SKU and a SKU outranks a name', async () => {
    // `POS-APL-01` is the apple's SKU and the first word of the lookalike's name.
    const items = await hits(SHARED.sku);
    expect(items.map((h) => h.matchedOn)).toEqual(['sku', 'name']);
    expect(items[0]?.productId).toBe(A.piece.productId);
  });

  it('every active merchant variant of a matched product is offered, and the archived one is not', async () => {
    const items = await hits('shirt');
    expect([...items.map((h) => h.variantId)].sort()).toEqual([shirtL, shirtM].sort());
    expect([...items.map((h) => h.variantName)].sort()).toEqual(['L', 'M']);
    expect(items.every((h) => h.sku !== 'POS-SHIRT-X')).toBe(true);
  });

  it('a variant SKU names that ONE variant, not every variant of the product', async () => {
    expect((await hits('pos-shirt-l')).map((h) => h.variantId)).toEqual([shirtL]);
  });

  it('an archived product is never offered, by any of its identifiers', async () => {
    expect(await hits('pos-apl-99')).toEqual([]);
    expect(await hits('7290000999999')).toEqual([]);
    expect((await hits('apple')).map((h) => h.productId)).toEqual([A.piece.productId]);
  });

  it('on hand is the stock at the till’s warehouse; an untracked product reports null and not zero', async () => {
    expect((await hits(SHARED.barcode))[0]?.onHand).toBe('7');
    // A SECOND warehouse is now a second TILL, read by the cashier whose
    // session sells from it. The claim is unchanged — the figure is the stock
    // at the till's own warehouse — but the till is what says which warehouse
    // that is, which is the whole of Ruling 2.
    const atW2 = await search(manager, A, tillManagerW2, SHARED.barcode);
    expect(atW2.status, JSON.stringify(atW2.body)).toBe(200);
    expect(atW2.body.warehouseId, 'the server derived the warehouse from the session').toBe(A.w2);
    expect(atW2.body.items[0]?.onHand, 'no stock of it at W2').toBe('0');
    const gift = await hits('pos-gift');
    expect(gift.map((h) => ({ onHand: h.onHand, tracked: h.trackInventory }))).toEqual([{ onHand: null, tracked: false }]);
  });

  it('the price is the catalogue’s, as minor units in a string, with the business currency', async () => {
    const h = must((await hits(SHARED.barcode))[0]);
    expect(h.unitPriceMinor).toBe(applePriceMinor);
    expect(typeof h.unitPriceMinor, 'money is a string, never a JSON number').toBe('string');
    expect(h.currency).toBe(baseCurrency);
  });

  it('a prefix too broad for one page says so, and offers no page two', async () => {
    const r = await search(owner, A, tillA, 'pos-', { limit: 2 });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.moreMatches).toBe(true);
    expect(Object.keys(r.body), 'there is no cursor to walk, by design').not.toContain('nextCursor');
    const wide = await search(owner, A, tillA, 'pos-', { limit: 50 });
    expect(wide.body.moreMatches).toBe(false);
  });
});

describe('isolation — by RLS, and proved on a real connection', () => {
  it('A2 and B hold A’s exact SKU and barcode, so the decoys are real', async () => {
    const r = await ownerPool().query<{ business_id: string }>(
      `SELECT business_id::text AS business_id FROM catalog_identifiers WHERE kind = 'barcode' AND value_norm = $1`,
      [SHARED.barcode],
    );
    expect(new Set(r.rows.map((x) => x.business_id))).toEqual(new Set([A.businessId, A2.businessId, B.businessId]));
  });

  it('A’s till never sees A2’s row, though the owner is a member of both', async () => {
    const inA = await search(owner, A, tillA, SHARED.barcode);
    expect(inA.body.items.map((h) => h.productId)).toEqual([A.piece.productId]);
    const inA2 = await search(owner, A2, tillA2, SHARED.barcode);
    expect(inA2.status).toBe(200);
    expect(inA2.body.items).toHaveLength(1);
    expect(inA2.body.items.map((h) => h.productId)).not.toContain(A.piece.productId);
  });

  it('A’s till never sees another tenant’s row, and A’s owner cannot even address B', async () => {
    expect((await search(owner, A, tillA, SHARED.barcode)).body.items).toHaveLength(1);
    // B's OWN till, named by A's owner under B's header. The session is real
    // and open — it is the membership that is absent, so the refusal happens
    // before any session fact is consulted.
    const crossTenant = await search(owner, B, tillB, SHARED.barcode);
    expect(crossTenant.status, 'A’s owner is not a member of B').toBe(403);
  });

  /**
   * THE SAME CLAIM AS BEFORE RULING 2, AT THE SAME STRENGTH, ABOUT THE SESSION.
   *
   * This case used to name A's WAREHOUSE under A2's header and expect
   * `pos.warehouse_not_found`. That code is GONE and it had to go: it became
   * genuinely unreachable once the warehouse stopped being a request field,
   * because `pos_till_sessions.warehouse_id` is `NOT NULL` and carries a
   * composite FK into `warehouses (business_id, id)` — a derived warehouse
   * always exists and always belongs to this business. «A code nothing can
   * raise is worse than no code.»
   *
   * What the case was really protecting is intact and is asserted here: the
   * cross-business identifier is REFUSED rather than answered from the wrong
   * business with a zero on hand. A 200 whose every `onHand` is `0` reads as
   * "the shop is empty", and a cashier acting on it refuses a sale of stock
   * that is on the shelf. The answer is `pos.session_not_found`, and it is 404
   * for the usual reason: A's session is INVISIBLE to A2's transaction under
   * RLS, so a mistyped id and another business's id are the same answer and
   * neither confirms the other exists.
   */
  it('A’s session id in A2’s context is REFUSED, not answered from A2 with a zero on hand', async () => {
    const r = await search(owner, A2, tillA, SHARED.barcode);
    expect(r.status).toBe(404);
    expect(r.body.error?.details?.['sellingCode']).toBe('pos.session_not_found');
    expect(r.body.items, 'a refusal carries no page at all — an empty page would read as "nothing in stock"').toBeUndefined();
  });

  it('a session that exists nowhere is refused the same way, and so is one that is not a canonical uuid', async () => {
    const nowhere = await search(owner, A, '11111111-2222-4333-8444-555555555555', SHARED.barcode);
    expect(nowhere.status).toBe(404);
    expect(nowhere.body.error?.details?.['sellingCode']).toBe('pos.session_not_found');
    // A malformed id is refused by the schema instead, which is a DIFFERENT
    // answer and the right one: it never reaches the session lookup, so it
    // cannot be an oracle for which session ids exist.
    const malformed = await paced(owner, A.businessId, `/v1/pos/products?sessionId=not-a-uuid&q=${encodeURIComponent(SHARED.barcode)}`);
    expect(malformed.status).toBe(400);
  });

  /**
   * THE REAL-CONNECTION PROOF.
   *
   * For each relation the read touches, the same statement runs three ways on a
   * live `daftar_app` connection with NO `business_id` predicate at all: with
   * A's scope GUCs, with B's, and with none. Then once as the schema owner,
   * who DOES bypass row security, to show the statement is capable of
   * returning several businesses' rows — without that control the first three
   * could pass on a statement that simply finds nothing.
   */
  it('with the business predicate REMOVED, a daftar_app connection sees only its own business — and the probe can see a leak', async () => {
    const probes: readonly { relation: string; sql: string; params: readonly unknown[] }[] = [
      { relation: 'products', sql: `SELECT business_id::text AS b FROM products WHERE barcode = $1`, params: [SHARED.barcode] },
      { relation: 'product_variants', sql: `SELECT business_id::text AS b FROM product_variants WHERE status <> 'archived'`, params: [] },
      { relation: 'product_translations', sql: `SELECT business_id::text AS b FROM product_translations WHERE lower(name) LIKE 'apple%'`, params: [] },
      { relation: 'stock_levels', sql: `SELECT business_id::text AS b FROM stock_levels`, params: [] },
    ];

    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      for (const p of probes) {
        for (const scope of [
          { label: 'A', tenantId: A.tenantId, businessId: A.businessId },
          { label: 'B', tenantId: B.tenantId, businessId: B.businessId },
        ]) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
          const rows = (await c.query<{ b: string }>(p.sql, [...p.params])).rows;
          await c.query('ROLLBACK');
          expect(rows.length, `${p.relation} as daftar_app in ${scope.label} must see its OWN rows`).toBeGreaterThan(0);
          expect(
            [...new Set(rows.map((r) => r.b))].filter((b) => b !== scope.businessId),
            `${p.relation} as daftar_app in ${scope.label} leaked another business`,
          ).toEqual([]);
        }
        // No scope at all: RLS is default-deny, so the connection sees nothing.
        await c.query('BEGIN');
        const unscoped = (await c.query<{ b: string }>(p.sql, [...p.params])).rows;
        await c.query('ROLLBACK');
        expect(unscoped, `${p.relation} with no scope must be empty`).toEqual([]);
      }
    } finally {
      await c.end();
    }

    // The negative control: the schema owner bypasses row security, so the
    // very same statements DO return more than one business. The probe works.
    for (const p of probes) {
      const rows = (await ownerPool().query<{ b: string }>(p.sql, [...p.params])).rows;
      expect(new Set(rows.map((r) => r.b)).size, `the ${p.relation} probe must be able to see more than one business`).toBeGreaterThan(1);
    }
  });

  it('RLS is still FORCED on every relation this read touches, and daftar_app does not bypass it', async () => {
    const r = await ownerPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [['products', 'product_translations', 'product_variants', 'stock_levels']],
    );
    expect(r.rows).toEqual([
      { relname: 'product_translations', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'product_variants', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'products', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'stock_levels', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const bypass = await ownerPool().query<{ rolbypassrls: boolean }>(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'daftar_app'`);
    expect(must(bypass.rows[0]).rolbypassrls, 'the principal the read runs as must not bypass row security').toBe(false);
  });
});

describe('refusals', () => {
  /**
   * `pos.warehouse_out_of_scope` SURVIVES RULING 2, and this is the path that
   * reaches it.
   *
   * The old form named a warehouse the member did not reach, which a client can
   * no longer do. The code is still live and still security-relevant, because a
   * session's warehouse is FROZEN while a membership is not:
   * `pos_till_session_guard()` refuses any change to `branch_id` or
   * `warehouse_id`, so a till opened at branch Y keeps selling from Y's
   * warehouse for its whole life — while `member_branch_scopes` is editable at
   * any moment. Move an assigned-scope cashier off Y and they now own an open
   * till whose warehouse they do not reach.
   *
   * So the case performs exactly that, through the real member route: the
   * manager's till answers normally at W2, the manager is reassigned to branch
   * X, and the SAME till is then refused. Removing this check would turn a
   * stale till into a standing read on a branch the member was deliberately
   * moved off. The scope is restored afterwards so no later case depends on
   * this one's order.
   */
  it('a session whose warehouse the member no longer reaches is REFUSED, never answered with an empty page', async () => {
    const rescope = async (branchIds: readonly string[]): Promise<void> => {
      const res = await t.request
        .patch(`/v1/businesses/current/members/${manager.userId}/branch-scope`)
        .set(asMember(owner, A.businessId))
        .send({ mode: 'assigned', branchIds });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };

    const inScope = await search(manager, A, tillManagerW2, SHARED.barcode);
    expect(inScope.status, 'the warehouse its own till sells from answers normally').toBe(200);

    await rescope([A.branchX]);
    try {
      const outOfScope = await search(manager, A, tillManagerW2, SHARED.barcode);
      expect(outOfScope.status).toBe(403);
      expect(outOfScope.body.error?.details?.['sellingCode']).toBe('pos.warehouse_out_of_scope');
      expect(outOfScope.body.items, 'an empty page would read as "nothing in stock", which is a different and wrong answer').toBeUndefined();
    } finally {
      await rescope([A.branchY]);
    }
    expect((await search(manager, A, tillManagerW2, SHARED.barcode)).status, 'and the reassignment back restores the read').toBe(200);
  });

  /**
   * `OD-P4-09`: one session, one authenticated user. A colleague's till in the
   * caller's own business is VISIBLE and still refused — reading another
   * cashier's drawer through its own warehouse would be the shared till the
   * ruling refused, read-only. 403 and not 404, because the row really is
   * there: the 404 answer is reserved for invisibility, and using it here would
   * make a present row indistinguishable from an absent one.
   */
  it('a colleague’s open till is refused by name, not read through', async () => {
    const r = await search(cashier, A, tillA, SHARED.barcode);
    expect(r.status).toBe(403);
    expect(r.body.error?.details?.['sellingCode']).toBe('pos.session_not_owned');
  });

  /**
   * A closed till has no selling context. Answering from one would let a
   * cashier keep ringing up a drawer that has already been counted, which is
   * why this is a refusal and not an empty page.
   */
  it('the caller’s OWN closed till is refused — a counted drawer has no selling context', async () => {
    const r = await search(cashier, A, tillClosed, SHARED.barcode);
    expect(r.status).toBe(409);
    expect(r.body.error?.details?.['sellingCode']).toBe('pos.session_not_open');
  });

  it('a member holding neither sales.create nor sales.view is refused', async () => {
    expect((await search(clerk, A, tillA, SHARED.barcode)).status).toBe(403);
  });

  it('an unknown query parameter is refused, not quietly ignored', async () => {
    const r = await paced(owner, A.businessId, `/v1/pos/products?sessionId=${tillA}&q=appl&unitPriceMinor=1`);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  /**
   * `warehouseId` is refused BY NAME, and that is the Ruling 2 assertion this
   * file owes. A client whose warehouse was silently dropped would believe it
   * had asked the server to read one warehouse while the server read another —
   * and would render the answer as the answer to its own question.
   */
  it('warehouseId is refused as an unknown key — the client does not name its own read scope', async () => {
    const r = await paced(owner, A.businessId, `/v1/pos/products?sessionId=${tillA}&q=appl&warehouseId=${A.w2}`);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('a request with no session at all is refused, and so is an empty prefix, an oversized limit and a NUL', async () => {
    for (const query of [`q=appl`, `sessionId=${tillA}&q=`, `sessionId=${tillA}&q=a&limit=51`, `sessionId=${tillA}&q=${encodeURIComponent('a\u0000b')}`]) {
      expect((await paced(owner, A.businessId, `/v1/pos/products?${query}`)).status, query).toBe(400);
    }
  });
});

describe('the declared route, and the real transport that now serves it', () => {
  /**
   * The module declares ONE read route, and this suite drives that one. If the
   * mounted path, verb or permission ever differs from
   * `POS_READ_ROUTE_AUTHORITY`, this is where the two stop agreeing.
   */
  it('the module declares exactly one POS read route, and this suite exercises that one', () => {
    expect(POS_READ_ROUTE_AUTHORITY).toEqual([{ method: 'GET', path: '/v1/pos/products', permission: 'sales.view', sensitive: false }]);
  });

  /**
   * THE REPLACEMENT OF THIS CASE IS THE WHOLE POINT OF THE MOUNT.
   *
   * What stood here asserted that `modules/pos` contains NO `*.controller.ts`,
   * and the reason was real while it held: `discoverPhase4Routes` walks
   * `apps/api/src/modules` for controller files and the sealed G-02 golden
   * asserts its route list EQUAL to that discovery, so a controller file's mere
   * existence turned that golden red. The condition was never "a POS controller
   * is wrong"; it was "the transport, the goldens and the route surface land
   * together, once". They have, in this commit, so the claim inverts.
   *
   * The inverted claim is stronger than the old one, because it is about the
   * COMPOSITION rather than about a directory listing. Until now the only
   * transport for this read was `tests/helpers/pos-s3-route.ts`, a test-declared
   * controller that constructed `PosReadService` by hand through `ModuleRef`:
   * every assertion above measured a hand-built object, and would have passed
   * with the real route absent, the provider uncomposed or the DI graph broken.
   * That harness is deleted; this suite now reaches the route through
   * `createTestApp()`, which composes the production `AppModule`. So the
   * fixture's own `POST /v1/pos/till-sessions` and every case above are
   * evidence that the mount exists — a 404 or a DI failure would fail them all.
   *
   * The structural half of the claim is derived rather than listed: the
   * controllers the slice BUILDS are read from the directory and asserted equal
   * to `P4_S3_REQUIRED_CONTROLLERS`, so a controller added and not stated is
   * red and a name stated and not built is red.
   */
  it('modules/pos builds exactly the controllers it states, and the read route answers through the production composition', async () => {
    const dir = join(__dirname, '../../apps/api/src/modules/pos');
    const files = readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));
    expect(files.length, 'the POS surface has no transport at all — every case above would be measuring a 404').toBeGreaterThan(0);

    const built: string[] = [];
    for (const file of files.sort()) {
      const mod = (await import(join(dir, file))) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) if (typeof value === 'function' && name.endsWith('Controller')) built.push(name);
    }
    expect(built.sort(), 'the stated P4-S3 controllers and the built ones disagree').toEqual([...P4_S3_REQUIRED_CONTROLLERS].sort());

    // And the route really answers in this application, on its declared verb
    // and path, rather than being a file that exists: a 404 here would mean the
    // controller is built but composed into neither process.
    const reached = await paced(owner, A.businessId, searchPath(tillA, SHARED.barcode));
    expect(reached.status, 'the declared POS read route does not answer in the production composition').toBe(200);
  });
});

describe('pacing, never raising (P4-AL-69)', () => {
  it('the API’s route allowance is still 300 a minute — a test paces, and never moves a limiter', () => {
    const runtime = readFileSync(join(__dirname, '../../apps/api/src/app/runtime.ts'), 'utf8');
    expect(runtime, 'the throttler both merchant compositions import').toContain('throttlers: [{ ttl: 60_000, limit: 300 }]');
    expect(PACER_BUDGET, 'the pacer stays BELOW the allowance; it never moves the allowance').toBeLessThan(API_ROUTE_LIMIT);
  });

  it(`${KEYSTROKES} paced keystrokes all answer 200, and the suite spends MORE than the allowance in total`, async () => {
    const word = 'pos-shirt-l';
    const statuses: number[] = [];
    for (let i = 0; i < KEYSTROKES; i += 1) {
      const q = word.slice(0, 3 + (i % (word.length - 2)));
      statuses.push((await search(owner, A, tillA, q)).status);
    }
    console.info('[P4-S3] pacing', JSON.stringify({ keystrokes: KEYSTROKES, pacedRequests, pacerWaitedMs }));
    expect(
      statuses.filter((s) => s === 429),
      'a 429 is a reported error, never a reason to raise the limiter',
    ).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([200]));
  }, 600_000);
});

describe('the read writes nothing', () => {
  it('a run of type-aheads leaves every catalogue row and every stock row byte-identical', async () => {
    const digest = async (): Promise<string> => {
      const r = await ownerPool().query<{ d: string }>(
        `SELECT md5(string_agg(x, '|' ORDER BY x)) AS d FROM (
           SELECT business_id::text || id::text || coalesce(sku,'') || coalesce(barcode,'') || status || base_price_minor::text AS x FROM products
           UNION ALL SELECT business_id::text || id::text || coalesce(sku,'') || coalesce(barcode,'') || status AS x FROM product_variants
           UNION ALL SELECT business_id::text || product_id::text || locale || name AS x FROM product_translations
           UNION ALL SELECT business_id::text || warehouse_id::text || variant_id::text || on_hand::text AS x FROM stock_levels
         ) s`,
      );
      return must(r.rows[0]).d;
    };
    const before = await digest();
    for (let i = 0; i < IDLE_READS; i += 1) {
      expect((await search(owner, A, tillA, i % 2 === 0 ? 'pos' : 'appl')).status).toBe(200);
    }
    expect(await digest()).toBe(before);
    expect(pacedRequests, 'this file drives more type-aheads than the API allows in a minute, so the pacing is load-bearing').toBeGreaterThan(API_ROUTE_LIMIT);
  }, 600_000);
});
