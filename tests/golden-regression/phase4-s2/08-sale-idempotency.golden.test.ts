/**
 * GOLDEN REGRESSION — G-16 / GOLD-12, GOLD-62: THE SALE KEY.
 * A REPLAY IS REFUSED AT THE DATABASE, BY A REAL `UNIQUE` OVER REAL COLUMNS.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-30, P4-AL-27, P4-AL-65 G-16,
 *  P4-AL-16; D-03 of §4; docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §6.)
 *
 * P4-AL-30: idempotency is a CALLER-SUPPLIED document UUID plus a stored
 * `intent_sha256`, read before any write. D-03 records that no commercial table
 * in this estate carries an `idempotency_key` column and that `DATA_MODEL.md`
 * §17 is superseded for domain commands, so this golden asserts the accepted
 * mechanism and not the document's.
 *
 * Two halves, and both are needed:
 *
 *   — THE STRUCTURAL HALF. The uniqueness is a `UNIQUE` (or primary key) in
 *     `pg_constraint` whose columns RESOLVE in `pg_attribute`, and the intent
 *     digest is a real column with a real shape CHECK. A service-layer "we
 *     looked first" is not idempotency: two concurrent replays both look, both
 *     see nothing, and both write. The constraint is read from the CATALOGUE,
 *     never from the migration text, for the reason
 *     `04-schema-lint.golden.test.ts` gives at length.
 *
 *   — THE BEHAVIOURAL HALF. The same document id sent twice leaves ONE sale,
 *     ONE movement, ONE decrement, ONE invoice and no second journal entry;
 *     and the same id sent with a DIFFERENT intent is REFUSED rather than
 *     quietly treated as the first.
 *
 * RED UNTIL THE P4-S2 PRIMITIVE LANDS, by the canary, deliberately.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../../helpers/inventory-commands';
import { census, censusDelta, must, requireSubject, saleSubject, type Census, type SaleSubject } from './harness';
import { confirmSale, seedSaleFixtures } from './sale-path';

const CLAIM = 'a replayed sale is refused at the database and writes nothing a second time';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let customerId: string;

let first: Response | null = null;
let replay: Response | null = null;
let tampered: Response | null = null;
let afterFirst: Census = {};
let afterReplay: Census = {};
let afterTampered: Census = {};

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'G-16 owner');
  A = await onboardS3Business(t, owner, 'g16sale');
  ({ customerId } = await seedSaleFixtures(ownerPool(), A, day));
  subject = await saleSubject(ownerPool());

  const inbound = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, A.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'replay fixture',
      lines: [{ productId: A.piece.productId, quantity: '10', unitCost: '5' }],
    });
  expect(inbound.status, 'the fixture inbound adjustment is accepted').toBe(201);

  if (subject.missing.length === 0) {
    const saleId = randomUUID();
    const body = {
      saleId,
      customerId,
      warehouseId: A.w1,
      branchId: A.branchX,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '2' }],
    } as const;
    const headers = asMember(owner, A.businessId);
    first = await confirmSale(t, headers, body);
    afterFirst = await census(ownerPool(), A.businessId);
    replay = await confirmSale(t, headers, body);
    afterReplay = await census(ownerPool(), A.businessId);
    // The SAME document id with a DIFFERENT intent: a replay that is not a
    // replay. P4-AL-30's stored `intent_sha256` is what makes this refusable
    // instead of silently answered with the first sale's receipt.
    tampered = await confirmSale(t, headers, { ...body, lines: [{ productId: A.piece.productId, quantity: '3' }] });
    afterTampered = await census(ownerPool(), A.businessId);
  }
}, 180_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe('G-16 / GOLD-12, GOLD-62 the sale document key', () => {
  it('the subject exists: `sales` is in the catalogue', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the structural half: a UNIQUE or primary key over the document identity, with columns that resolve', async () => {
    requireSubject(subject.missing, CLAIM);
    // The column names are cast to `text[]`, not left as `name[]`:
    // node-postgres has no parser for the `name` array type and hands back the
    // raw array literal as a STRING, so `cols.includes('business_id')` was a
    // substring test that happened to agree and `cols.join` threw outright —
    // which is how the real assertion below came to be hidden behind a
    // TypeError in its own failure message. The cast makes it a real array on
    // this side of the wire.
    const r = await ownerPool().query<{ conname: string; contype: string; cols: string[]; unresolved: number }>(
      `SELECT con.conname, con.contype::text AS contype,
              (SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum), '{}'::text[])
                 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey) AND NOT a.attisdropped) AS cols,
              (SELECT count(*)::int FROM unnest(con.conkey) AS k
                WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = k AND NOT a.attisdropped)) AS unresolved
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'sales' AND con.contype IN ('p', 'u')`,
    );
    expect(r.rows.length, 'NO SUBJECT — `sales` carries no UNIQUE and no primary key').toBeGreaterThan(0);
    for (const row of r.rows) expect(row.unresolved, `${row.conname} names a column that does not resolve in pg_attribute`).toBe(0);
    // Every Phase 4 table carries tenant_id and business_id, and a document
    // key that omitted business_id would make one business's document id
    // collide with another's (P4-AL-09).
    const documentKey = r.rows.find((row) => row.cols.includes('business_id') && row.cols.includes('id'));
    expect(
      documentKey?.conname,
      `no UNIQUE or primary key of \`sales\` covers (business_id, id): the caller-supplied document UUID of P4-AL-30 is then unique by convention only. ` +
        `Found: ${r.rows.map((row) => `${row.conname}(${row.cols.join(',')})`).join(' ')}`,
    ).toBeDefined();
  });

  it('the structural half: a real `intent_sha256` column with a real shape CHECK', async () => {
    requireSubject(subject.missing, CLAIM);
    const cols = (
      await ownerPool().query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'sales' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%intent_sha256'`,
      )
    ).rows.map((x) => x.attname);
    expect(
      cols.length,
      'NO SUBJECT — `sales` carries no *_intent_sha256 column, so there is no stored intent to compare a replay against (P4-AL-30)',
    ).toBeGreaterThan(0);
    const checks = (
      await ownerPool().query<{ def: string }>(
        `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'sales' AND con.contype = 'c'`,
      )
    ).rows.map((x) => x.def);
    expect(
      checks.some((d) => /intent_sha256/.test(d) && /\[0-9a-f\]\{64\}/.test(d)),
      `no CHECK pins the shape of the stored intent digest. Found: ${checks.join(' | ')}`,
    ).toBe(true);
    // D-03: the superseded mechanism must NOT have arrived alongside the
    // accepted one, because two idempotency mechanisms on one table are two
    // truths about whether a command already ran.
    const legacy = (
      await ownerPool().query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'sales' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = 'idempotency_key'`,
      )
    ).rows;
    expect(legacy, 'D-03: no commercial table carries `idempotency_key`; the accepted mechanism is the document UUID plus the stored intent digest').toEqual(
      [],
    );
  });

  it('the first confirmation is accepted', () => {
    requireSubject(subject.missing, CLAIM);
    expect(must(first, 'the first confirmation').status, 'the first confirmation is accepted').toBeLessThan(300);
  });

  it('the replay writes nothing a second time: no second sale, movement, decrement, invoice or journal', () => {
    requireSubject(subject.missing, CLAIM);
    const d = censusDelta(afterFirst, afterReplay);
    for (const table of [
      'sales',
      'sale_items',
      'invoices',
      'invoice_items',
      'stock_movements',
      'stock_source_bridge_sale',
      'journal_entries',
      'journal_lines',
      'accounting_source_bindings',
    ]) {
      expect(d[table] ?? 0, `the replay wrote a second row to ${table}`).toBe(0);
    }
  });

  it('the replay is answered and not refused as a conflict with itself', () => {
    requireSubject(subject.missing, CLAIM);
    const res = must(replay, 'the replay');
    expect(res.status, 'a true replay of an accepted command is answered, not treated as a new attempt').toBeLessThan(300);
  });

  it('the same document id with a DIFFERENT intent is refused, and writes nothing', () => {
    requireSubject(subject.missing, CLAIM);
    const res = must(tampered, 'the tampered replay');
    expect(res.status, 'the same id with another intent is refused (P4-AL-30: the stored intent_sha256 is read before any write)').toBe(409);
    expect(censusDelta(afterReplay, afterTampered), 'the refused attempt wrote nothing at all').toEqual({});
  });
});
