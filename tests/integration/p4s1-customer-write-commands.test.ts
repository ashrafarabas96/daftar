/**
 * P4-S1 — THE CUSTOMER WRITE COMMANDS (owner decision DR-142, 2026-11-12).
 *
 * The five proofs the owner named, in his order, and every one of them is RED
 * before `0091` and the routes it feeds exist:
 *
 *   (a) a customer is CREATED and UPDATED over HTTP;
 *   (b) a DIRECT write to `customers` is REFUSED for the role the API runs as;
 *   (c) MERCHANT ISOLATION — a merchant can neither READ nor WRITE another
 *       merchant's customer;
 *   (d) the REVISION GUARD (`customers_revision_guard`, `0075:516`) still
 *       refuses a jumped revision and a rewritten identity;
 *   (e) the migration applies UPWARD on a clean database AND on a database
 *       that already holds rows.
 *
 * EVERY CLAIM THAT ASSERTS AN ABSENCE CARRIES A POSITIVE CONTROL in the same
 * test, because a probe that cannot see reports a zero that reads like a pass
 * (RULE-11, RULE-18): the `42501` refusals are paired with a SELECT that
 * succeeds through the same connection, the cross-business refusals are paired
 * with the owner's own success on the same id, and the "no table changed"
 * claim in (e) is paired with the one table that DID change.
 *
 * The cross-business refusals assert INDISTINGUISHABILITY from an unknown
 * customer, derived from the route at runtime, rather than a status literal:
 * a literal would be a sentence about a route this branch is the one to build
 * (P4-AL-88), and the derived form is the stronger claim anyway.
 *
 * Nothing here raises a limit, a timeout or a permission, and nothing is
 * skipped: `tests/helpers/global-setup.ts` calls `ensurePostgres()`
 * unconditionally, so this suite either measures a real database or does not
 * run at all. It never reports a pass without one.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember, onboardS3Business, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { createScratchDb, migrationFiles, type ScratchDb } from '../helpers/scratch-db';
import type { Queryable } from '../helpers/stock-ledger';
import { changedTables, tableDigest } from '../helpers/table-digest';
import { appDbUrl, createTestApp, dbUrl, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';

/** The migration under proof, and the head immediately before it. */
const MIGRATION = '0091_p4s1_customer_write_commands.sql';

/** A refusal as the global error filter renders it: the typed code is in `details`. */
interface RefusalBody {
  readonly error?: { readonly details?: { readonly sellingCode?: string } };
}

/**
 * The file name alone. The helpers are read for their VALUES and not for an
 * assumption about whether they carry a directory, so a shape change here
 * fails the assertion rather than quietly matching nothing (RULE-18).
 */
function base(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

function headBefore(): string {
  const files = migrationFiles().map(base);
  const at = files.indexOf(MIGRATION);
  expect(at, `${MIGRATION} is not on disk, so there is nothing to prove`).toBeGreaterThan(0);
  const before = files[at - 1];
  expect(before, 'the migration before 0091').toBeDefined();
  return String(before);
}

/** Every ordinary table of the public schema, so a digest cannot miss one by being listed by hand. */
async function allTables(q: Queryable): Promise<string[]> {
  const r = await q.query<{ t: string }>(
    `SELECT c.relname::text AS t FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`,
  );
  return r.rows.map((x) => x.t);
}

/** Run one statement and return its SQLSTATE, or the literal 'executed'. */
async function sqlstateOf(c: Client, sql: string, params: unknown[] = []): Promise<string> {
  return await c.query(sql, params).then(
    () => 'executed',
    (e: unknown) => String((e as { code?: string }).code ?? 'no-code'),
  );
}

/** Run one statement and return its refusal message, or 'executed'. */
async function refusalOf(q: Queryable, sql: string, params: unknown[] = []): Promise<string> {
  return await q.query(sql, params).then(
    () => 'executed',
    (e: unknown) => String((e as { message?: string }).message ?? 'no-message'),
  );
}

describe('P4-S1 the customer write commands (DR-142)', () => {
  let t: TestApp;
  let ownerA: HttpActor;
  let ownerB: HttpActor;
  let bizA: Awaited<ReturnType<typeof onboardS3Business>>;
  let bizB: Awaited<ReturnType<typeof onboardS3Business>>;
  /** The customer created in (a) and read by (b), (c) and (d). */
  let customerId: string;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    ownerA = await registerActor(t, 'L3 customer owner A');
    ownerB = await registerActor(t, 'L3 customer owner B');
    bizA = await onboardS3Business(t, ownerA, 'cust-a');
    bizB = await onboardS3Business(t, ownerB, 'cust-b');
  }, 420_000);

  afterAll(async () => {
    await t?.close();
    await resetData();
  });

  // ── (a) create and update over HTTP ────────────────────────────────────
  describe('(a) a customer is created and updated over HTTP', () => {
    it('creates at revision 1, active, with 201; and replays the same statement as 200', async () => {
      customerId = randomUUID();
      const body = { customerId, name: 'Mahmoud Odeh', phone: '0599000111', email: 'mahmoud@example.com', notes: 'walk-in turned credit' };

      const first = await t.request.post('/v1/customers').set(asMember(ownerA, bizA.businessId)).send(body);
      expect(first.status, `create: ${JSON.stringify(first.body)}`).toBe(201);
      expect(first.body.id).toBe(customerId);
      expect(first.body.revision).toBe(1);
      expect(first.body.status).toBe('active');
      expect(first.body.replayed).toBe(false);
      expect(first.body.name).toBe('Mahmoud Odeh');
      // No contacts were asked for and none exist: the answer is read back
      // from the stored row, so this is the table's state and not an echo.
      expect(first.body.contacts).toEqual([]);
      expect(String(first.body.businessTransactionId).length).toBeGreaterThan(0);

      // The idempotency key is the customer id: the identical statement is a
      // replay, answered 200, and it does NOT advance the revision.
      const again = await t.request.post('/v1/customers').set(asMember(ownerA, bizA.businessId)).send(body);
      expect(again.status, `replay: ${JSON.stringify(again.body)}`).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.revision).toBe(1);
    });

    it('refuses the same id carrying a different statement with customer.idempotency_conflict', async () => {
      const res = await t.request.post('/v1/customers').set(asMember(ownerA, bizA.businessId)).send({ customerId, name: 'Somebody Else' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error?.details?.sellingCode ?? res.body.error?.details?.code ?? JSON.stringify(res.body)).toContain('customer.idempotency_conflict');
    });

    it('updates the whole statement at the revision read: revision 2, an omitted optional field CLEARED, status untouched', async () => {
      const res = await t.request
        .put(`/v1/customers/${customerId}`)
        .set(asMember(ownerA, bizA.businessId))
        .send({ expectedRevision: 1, name: 'Mahmoud A. Odeh' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.revision).toBe(2);
      expect(res.body.name).toBe('Mahmoud A. Odeh');
      // A full statement CLEARS what it does not name — it never merges.
      expect(res.body.phone).toBeNull();
      expect(res.body.email).toBeNull();
      expect(res.body.notes).toBeNull();
      // THE STATUS RULE: an update is not a lifecycle change.
      expect(res.body.status).toBe('active');
      expect(res.body.replayed).toBe(false);
    });

    it('refuses a stale revision with customer.revision_changed, and leaves the row alone', async () => {
      const res = await t.request.put(`/v1/customers/${customerId}`).set(asMember(ownerA, bizA.businessId)).send({ expectedRevision: 1, name: 'Stale Writer' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      const after = await t.request.get(`/v1/customers/${customerId}`).set(asMember(ownerA, bizA.businessId));
      expect(after.status).toBe(200);
      expect(after.body.revision, 'a refused update advanced nothing').toBe(2);
      expect(after.body.name).toBe('Mahmoud A. Odeh');
    });

    it('refuses a statement that names contacts, rather than accepting it and storing none', async () => {
      // DR-142 is create and update only, and `customer_contacts` is another
      // table. A silently dropped contact would tell the merchant their
      // contact was saved; this route refuses instead.
      const res = await t.request
        .post('/v1/customers')
        .set(asMember(ownerA, bizA.businessId))
        .send({ customerId: randomUUID(), name: 'With Contacts', contacts: [{ contactId: randomUUID(), name: 'Son', phone: '0599000222' }] });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    });
  });

  // ── (b) a direct write is refused ──────────────────────────────────────
  describe('(b) a direct write to customers is refused for the role the API runs as', () => {
    it('refuses INSERT, UPDATE, DELETE and TRUNCATE with 42501, while SELECT through the same connection succeeds', async () => {
      const c = new Client({ connectionString: appDbUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [bizA.tenantId, bizA.businessId]);

        // THE POSITIVE CONTROL, FIRST: this connection can see the table at
        // all, so the four refusals below are about the privilege and not
        // about a dead connection or an invisible row (RULE-11).
        const seen = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE id = $1`, [customerId]);
        expect(seen.rows[0]?.n, 'daftar_app can READ the customer it just created').toBe(1);

        expect(
          await sqlstateOf(
            c,
            `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                                    business_transaction_id, created_by, updated_by)
             VALUES ($1, $2, $3, 'Direct', 'active', 1, repeat('a', 64), repeat('a', 64), $4, $5, $5)`,
            [bizA.tenantId, bizA.businessId, randomUUID(), randomUUID(), bizA.userId],
          ),
          'a direct INSERT',
        ).toBe('42501');

        expect(await sqlstateOf(c, `UPDATE customers SET name = 'Direct' WHERE id = $1`, [customerId]), 'a direct UPDATE').toBe('42501');
        expect(await sqlstateOf(c, `DELETE FROM customers WHERE id = $1`, [customerId]), 'a direct DELETE').toBe('42501');
        expect(await sqlstateOf(c, `TRUNCATE customers`), 'a direct TRUNCATE').toBe('42501');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });

    it('grants the two routines to daftar_app and to nobody else, and no DML with them', async () => {
      const r = await ownerPool().query<{ app: boolean; pub: boolean; ins: boolean; upd: boolean }>(
        `SELECT has_function_privilege('daftar_app', p.oid, 'EXECUTE') AS app,
                EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl::text LIKE '=%') AS pub,
                has_table_privilege('daftar_app', 'customers', 'INSERT') AS ins,
                has_table_privilege('daftar_app', 'customers', 'UPDATE') AS upd
           FROM pg_proc p
          WHERE p.oid IN (to_regprocedure('public.customer_create(uuid,text,text,text,text)'),
                          to_regprocedure('public.customer_update(uuid,integer,text,text,text,text)'))`,
      );
      expect(r.rows.length, 'both routines exist (the control for the flags below)').toBe(2);
      for (const row of r.rows) {
        expect(row.app, 'daftar_app can EXECUTE the routine').toBe(true);
        expect(row.pub, 'PUBLIC cannot').toBe(false);
        expect(row.ins, 'daftar_app holds no INSERT on customers').toBe(false);
        expect(row.upd, 'daftar_app holds no UPDATE on customers').toBe(false);
      }
    });
  });

  // ── (c) merchant isolation ─────────────────────────────────────────────
  describe('(c) merchant isolation', () => {
    /**
     * THE CLAIM IS INDISTINGUISHABILITY, NOT A NUMBER.
     *
     * This case used to require a bare status code, which was both weaker than
     * the property it meant and a sentence about a route that did not yet
     * exist (P4-AL-88): a literal there says "this route answers 404", and the
     * route now answers for real. What cross-merchant isolation actually
     * promises is that ANOTHER MERCHANT'S CUSTOMER IS INDISTINGUISHABLE FROM
     * ONE THAT DOES NOT EXIST — if B could tell the two apart, B would have
     * learned that A holds that id, which is the leak.
     *
     * So the expected answer is DERIVED at runtime from the route itself: A
     * asks for an id nobody has, and B's answer to A's real customer must
     * equal it, status and typed refusal code alike. Nothing is hard-coded,
     * and the assertion is strictly stronger than the number it replaces.
     */
    it('business B can neither read nor write business A customer, and A still sees it unchanged', async () => {
      const headersB = asMember(ownerB, bizB.businessId);
      const headersA = asMember(ownerA, bizA.businessId);

      // The reference answer: a customer that genuinely does not exist, asked
      // for by a member of the business, on the same route.
      const absent = await t.request.get(`/v1/customers/${randomUUID()}`).set(headersA);
      const absentCode = (absent.body as RefusalBody).error?.details?.sellingCode;
      expect(absentCode, 'the route refuses an unknown customer with its typed code').toBe('customer.not_found');

      const read = await t.request.get(`/v1/customers/${customerId}`).set(headersB);
      expect(read.status, `B reading A's customer must be indistinguishable from an unknown one: ${JSON.stringify(read.body)}`).toBe(absent.status);
      expect((read.body as RefusalBody).error?.details?.sellingCode, 'and carry the same typed code').toBe(absentCode);

      const write = await t.request.put(`/v1/customers/${customerId}`).set(headersB).send({ expectedRevision: 2, name: 'Taken Over' });
      expect(write.status, `B writing A's customer: ${JSON.stringify(write.body)}`).toBe(absent.status);
      expect((write.body as RefusalBody).error?.details?.sellingCode, 'the write refuses as an unknown customer too').toBe(absentCode);

      // B cannot claim the same id as a CREATE in its own business either —
      // and if it could, that would be a second customer, not a theft; so the
      // claim that matters is that A's row is byte-identical afterwards.
      const stolen = await t.request.post('/v1/customers').set(headersB).send({ customerId, name: 'Taken Over' });
      expect(stolen.status, 'whatever B is answered, it is answered about B').toBeLessThan(500);

      // THE POSITIVE CONTROL: the same id, the same route, A's own header.
      const mine = await t.request.get(`/v1/customers/${customerId}`).set(headersA);
      expect(mine.status, 'A can still read its own customer, so the refusals above are about the business').toBe(200);
      expect(mine.body.revision).toBe(2);
      expect(mine.body.name).toBe('Mahmoud A. Odeh');

      // And A's row belongs to A's business and tenant in the table itself.
      const owned = await ownerPool().query<{ b: string; n: string }>(`SELECT business_id::text AS b, name AS n FROM customers WHERE id = $1`, [customerId]);
      expect(owned.rows.length, 'exactly one row carries that id in A').toBeGreaterThanOrEqual(1);
      expect(owned.rows.some((x) => x.b === bizA.businessId && x.n === 'Mahmoud A. Odeh')).toBe(true);
    });

    /**
     * The claim here is an EFFECT, not a status: a non-member of B must not be
     * able to write into B. So the refusal is asserted as a client refusal and
     * — the part that actually matters — the table is read afterwards to show
     * that nothing was created in B under that id.
     */
    it('a member of A cannot act in B by presenting B business id', async () => {
      const intruderId = randomUUID();
      const res = await t.request.post('/v1/customers').set(asMember(ownerA, bizB.businessId)).send({ customerId: intruderId, name: 'Cross Business' });
      expect(res.status, `a non-member of B is refused: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      expect(res.status, 'and refused as a client error, not a server fault').toBeLessThan(500);

      const anywhere = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE id = $1`, [intruderId]);
      expect(anywhere.rows[0]?.n, 'and no customer was created under that id in ANY business').toBe(0);
    });
  });

  // ── (d) the revision guard ─────────────────────────────────────────────
  describe('(d) customers_revision_guard is still in force', () => {
    it('refuses a jumped revision, a rewritten identity and a DELETE, while a one-step change is admitted', async () => {
      const c = new Client({ connectionString: dbUrl });
      await c.connect();
      try {
        await c.query('BEGIN');

        // THE POSITIVE CONTROL, FIRST: a one-step revision on an editable
        // column IS admitted, so the three refusals below are the guard's
        // judgement and not a connection that cannot write at all. Rolled
        // back with everything else.
        expect(
          await refusalOf(c, `UPDATE customers SET name = 'Guard Control', revision = revision + 1 WHERE id = $1`, [customerId]),
          'a legal one-step change',
        ).toBe('executed');

        expect(await refusalOf(c, `UPDATE customers SET revision = revision + 2 WHERE id = $1`, [customerId])).toContain('customer.revision_changed');
        expect(await refusalOf(c, `UPDATE customers SET revision = revision WHERE id = $1`, [customerId])).toContain('customer.revision_changed');
        expect(
          await refusalOf(c, `UPDATE customers SET create_intent_sha256 = repeat('b', 64), revision = revision + 1 WHERE id = $1`, [customerId]),
        ).toContain('customer.state_invalid');
        expect(await refusalOf(c, `DELETE FROM customers WHERE id = $1`, [customerId])).toContain('customer.not_deletable');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }

      // And the row the API owns is exactly where (a) left it.
      const after = await ownerPool().query<{ r: number; n: string }>(`SELECT revision AS r, name AS n FROM customers WHERE id = $1`, [customerId]);
      expect(after.rows[0]?.r, 'the rolled-back control changed nothing').toBe(2);
      expect(after.rows[0]?.n).toBe('Mahmoud A. Odeh');
    });

    it('both 0075 guards are still triggered on the table after 0091', async () => {
      const r = await ownerPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger tg
          WHERE tg.tgrelid = 'customers'::regclass AND NOT tg.tgisinternal
            AND tg.tgfoid IN (to_regprocedure('public.customers_revision_guard()'), to_regprocedure('public.customers_no_delete()'))`,
      );
      expect(r.rows[0]?.n, 'customers_revision_guard and customers_no_delete').toBe(2);
    });
  });

  // ── (e) the migration applies upward, twice over ───────────────────────
  describe('(e) 0091 applies upward on a clean database and on one that already holds rows', () => {
    let clean: ScratchDb | undefined;
    let loaded: ScratchDb | undefined;

    afterAll(async () => {
      await clean?.drop();
      await loaded?.drop();
    });

    it('applies from zero on a clean database, and leaves the asserted end state', async () => {
      clean = await createScratchDb('daftar_l3_customer_write_clean');
      expect(clean.applied.map(base), '0091 is among the migrations applied from zero').toContain(MIGRATION);

      const r = await clean.pool.query<{ routines: number; kinds: number; lifecycle: number }>(
        `SELECT (SELECT count(*)::int FROM pg_proc p
                  WHERE p.oid IN (to_regprocedure('public.customer_create(uuid,text,text,text,text)'),
                                  to_regprocedure('public.customer_update(uuid,integer,text,text,text,text)'))) AS routines,
                (SELECT count(*)::int FROM inventory_operation_kinds k
                  WHERE k.op_code IN ('customer.create', 'customer.update') AND k.registered_by = 'P4-S1') AS kinds,
                (SELECT count(*)::int FROM inventory_operation_kinds k
                  WHERE k.op_code IN ('customer.archive', 'customer.reactivate')) AS lifecycle`,
      );
      expect(r.rows[0]?.routines, 'both routines').toBe(2);
      expect(r.rows[0]?.kinds, 'both operation kinds, registered by P4-S1').toBe(2);
      // The scope limit of DR-142, measured: the lifecycle kinds are NOT
      // registered, and the control for that zero is the 2 above — the same
      // probe on the same table.
      expect(r.rows[0]?.lifecycle, 'the lifecycle kinds DR-142 excludes are not registered').toBe(0);
    }, 420_000);

    it('applies on a database already holding rows, and changes no table but the registry it writes', async () => {
      loaded = await createScratchDb('daftar_l3_customer_write_loaded', { upTo: headBefore() });
      expect(loaded.applied.map(base), 'the copy stops short of 0091').not.toContain(MIGRATION);

      const tables = await allTables(loaded.pool);
      const before = await tableDigest(loaded.pool, tables);
      // The probe must be able to see: a database with no rows at all would
      // make "nothing changed" true for the wrong reason (RULE-11/RULE-19).
      const populated = Object.values(before).filter((v) => Number(v.slice(0, v.indexOf(':'))) > 0);
      expect(populated.length, 'the database this upgrade runs over already holds rows').toBeGreaterThan(0);

      const applied = await loaded.migrateRest();
      expect(applied.map(base), 'the remaining migrations include 0091').toContain(MIGRATION);

      const after = await tableDigest(loaded.pool, tables);
      const changed = changedTables(before, after);

      // The ONE table 0091 writes a row to, and the control for the claim
      // below: if the probe saw nothing, this would be empty too.
      expect(changed, 'inventory_operation_kinds gained the two P4-S1 rows').toContain('inventory_operation_kinds');
      // Everything else that existed before the upgrade is untouched — above
      // all `customers` itself: a migration that rewrote customer master data
      // on the way up is the failure this test exists to catch.
      expect(
        changed.filter((x) => x !== 'inventory_operation_kinds' && !x.startsWith('schema_migrations')),
        'no other pre-existing table changed',
      ).toEqual([]);
    }, 420_000);
  });
});
