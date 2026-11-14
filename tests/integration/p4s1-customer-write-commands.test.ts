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
 * and, on the owner's requirement after review, the claim (b) does NOT make:
 *
 *   (f) a NAMED runtime principal other than `daftar_app` is refused `42501`
 *       when it ACTUALLY CALLS each routine — an execution claim, where (b)
 *       is a catalogue claim about `proacl`. It is proved able to fail by
 *       planting the opposite grant, and the catalogue is restored from a
 *       digest taken before the plant.
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
import { createHash, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '../../packages/domain-core/src/permissions';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember, onboardS3Business, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { createScratchDb, headMigration, migrationFiles, type ScratchDb } from '../helpers/scratch-db';
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

/**
 * `25P02` — `current transaction is aborted, commands ignored until end of
 * transaction block`.
 *
 * ONE STATEMENT PER TRANSACTION, AND THIS IS WHY. In PostgreSQL ANY error
 * aborts the whole transaction, a refusal this suite deliberately provokes
 * included, and every statement after it returns `25P02` instead of its own
 * error. So a second refusal asserted in the same transaction as the first
 * measures NOTHING — and it reads as a pass or a fail by accident, in either
 * direction, which is worse than no claim at all.
 *
 * The two helpers below therefore open and roll back a transaction of their
 * OWN around each statement, and each one asserts that what it observed is not
 * `25P02`. That guard is here, once, rather than at each call site, so no
 * future claim in this suite can inherit a verdict from an abort.
 */
const ABORTED = '25P02';
const ABORT_TEXT = 'current transaction is aborted';

/** Set the GUCs a transaction needs for row security to apply to it. */
async function applyScope(c: Client, scope?: { readonly tenantId: string; readonly businessId: string }): Promise<void> {
  if (scope === undefined) return;
  // `is_local = true`, so it lasts exactly as long as this transaction — which
  // is precisely why it has to be re-applied per isolated statement.
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
}

/** One statement, in a transaction of its own, as its SQLSTATE or 'executed'. */
async function sqlstateOf(c: Client, sql: string, params: unknown[] = [], scope?: { readonly tenantId: string; readonly businessId: string }): Promise<string> {
  await c.query('BEGIN');
  try {
    await applyScope(c, scope);
    const code = await c.query(sql, params).then(
      () => 'executed',
      (e: unknown) => String((e as { code?: string }).code ?? 'no-code'),
    );
    expect(code, `this claim read an ABORTED transaction, so it measured nothing: ${sql}`).not.toBe(ABORTED);
    return code;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
  }
}

/** One statement, in a transaction of its own, as its refusal message or 'executed'. */
async function refusalOf(c: Client, sql: string, params: unknown[] = [], scope?: { readonly tenantId: string; readonly businessId: string }): Promise<string> {
  await c.query('BEGIN');
  try {
    await applyScope(c, scope);
    const outcome = await c.query(sql, params).then(
      () => ({ message: 'executed', code: 'executed' }),
      (e: unknown) => ({ message: String((e as { message?: string }).message ?? 'no-message'), code: String((e as { code?: string }).code ?? 'no-code') }),
    );
    expect(outcome.code, `this claim read an ABORTED transaction, so it measured nothing: ${sql}`).not.toBe(ABORTED);
    expect(outcome.message, `this claim read an abort message, so it measured nothing: ${sql}`).not.toContain(ABORT_TEXT);
    return outcome.message;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
  }
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
      const scope = { tenantId: bizA.tenantId, businessId: bizA.businessId };
      try {
        // THE POSITIVE CONTROL, FIRST, and in a transaction of its own: this
        // connection can see the table at all, so the four refusals below are
        // about the privilege and not about a dead connection or an invisible
        // row (RULE-11).
        await c.query('BEGIN');
        await applyScope(c, scope);
        const seen = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE id = $1`, [customerId]);
        expect(seen.rows[0]?.n, 'daftar_app can READ the customer it just created').toBe(1);
        await c.query('ROLLBACK');

        // EACH REFUSAL IN ITS OWN TRANSACTION. The INSERT's own `42501` aborts
        // the transaction it runs in, so running the other three after it in
        // that same transaction made them read `25P02` and measure nothing.
        // `sqlstateOf` now isolates and refuses an abort outright.
        expect(
          await sqlstateOf(
            c,
            `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                                    business_transaction_id, created_by, updated_by)
             VALUES ($1, $2, $3, 'Direct', 'active', 1, repeat('a', 64), repeat('a', 64), $4, $5, $5)`,
            [bizA.tenantId, bizA.businessId, randomUUID(), randomUUID(), bizA.userId],
            scope,
          ),
          'a direct INSERT',
        ).toBe('42501');

        expect(await sqlstateOf(c, `UPDATE customers SET name = 'Direct' WHERE id = $1`, [customerId], scope), 'a direct UPDATE').toBe('42501');
        expect(await sqlstateOf(c, `DELETE FROM customers WHERE id = $1`, [customerId], scope), 'a direct DELETE').toBe('42501');
        expect(await sqlstateOf(c, `TRUNCATE customers`, [], scope), 'a direct TRUNCATE').toBe('42501');
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
        // THE POSITIVE CONTROL, FIRST: a one-step revision on an editable
        // column IS admitted, so the refusals below are the guard's judgement
        // and not a connection that cannot write at all. `refusalOf` runs it
        // in a transaction of its own and rolls it back, so it changes nothing.
        expect(
          await refusalOf(c, `UPDATE customers SET name = 'Guard Control', revision = revision + 1 WHERE id = $1`, [customerId]),
          'a legal one-step change',
        ).toBe('executed');

        // EACH REFUSAL IN ITS OWN TRANSACTION. The first guard refusal aborts
        // the transaction it runs in, so the ones after it in that same
        // transaction were reading `25P02` and the abort's message instead of
        // their own — which is exactly how a real refusal and a missing one
        // became indistinguishable here.
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

  // ── (f) a named role other than daftar_app is refused AT CALL TIME ─────
  describe('(f) another runtime principal is refused when it actually calls', () => {
    /**
     * WHY THIS IS NOT THE SAME CLAIM AS (b).
     *
     * (b) reads `proacl` and shows PUBLIC holds no EXECUTE. That is a
     * CATALOGUE claim: it proves no grant was written. It does not prove that
     * a NAMED role is refused when it calls, and those are different
     * sentences — the second is the one a merchant's security actually rests
     * on, and only an execution can say it.
     *
     * WHY `daftar_worker`. It is one of the seven runtime principals the
     * project's Phase 3 runtime grant model already defines, and that model
     * records it as holding ZERO `EXECUTE` entries over the whole Phase
     * 3-and-later surface — measured: its execute list is empty. So it is the
     * principal whose refusal is most meaningful: a background worker able to
     * mint a customer would be a path from a job queue into master data, and
     * the model says it must hold nothing. It is also NOT `daftar_app`, which
     * is the one role the pattern grants.
     *
     * NO FILE IS NAMED IN THIS COMMENT, and that is deliberate rather than
     * vague. The review-index generator turns a unique basename of ten
     * characters or more into a COVERAGE needle, so citing a file here would
     * make the index record this suite as covering it. This suite does not
     * cover the grant model or the generator; it cites them. A false coverage
     * claim in a review index is the same defect as a stale count in a
     * security inventory. The paths are in the commit message, which the index
     * does not read.
     *
     * The session connects as the superuser and takes the role with
     * `SET LOCAL ROLE` inside a transaction — the `purchase-commands.ts:544`
     * pattern — so the privilege under test is the function's own ACL and not
     * a connection string.
     */
    it('daftar_worker is refused 42501 by both routines, and the claim is proved able to fail', async () => {
      const c = new Client({ connectionString: dbUrl });
      await c.connect();

      /** The ACL of both routines, as one ordered digest — the state to restore TO. */
      const aclDigest = async (): Promise<{ readonly digest: string; readonly acl: string }> => {
        const r = await c.query<{ sig: string; acl: string }>(
          `SELECT p.oid::regprocedure::text AS sig, coalesce(array_to_string(p.proacl, ','), '<null>') AS acl
             FROM pg_proc p
            WHERE p.oid IN (to_regprocedure('public.customer_create(uuid,text,text,text,text)'),
                            to_regprocedure('public.customer_update(uuid,integer,text,text,text,text)'))
            ORDER BY 1`,
        );
        expect(r.rows.length, 'both routines are in the catalogue (the control for every claim below)').toBe(2);
        const acl = r.rows.map((x) => `${x.sig}=${x.acl}`).join('\n');
        return { digest: createHash('sha256').update(acl).digest('hex'), acl };
      };

      /**
       * `SET LOCAL ROLE <role>`, then the call, in a transaction of its own.
       *
       * It returns the SQLSTATE **and** the message, because a control that
       * names only a code cannot distinguish two refusals that share one:
       * every domain refusal in this schema raises `P0001`.
       */
      const callAs = async (role: string, sql: string, params: unknown[]): Promise<{ readonly code: string; readonly message: string }> => {
        await c.query('BEGIN');
        try {
          await c.query(`SET LOCAL ROLE ${role}`);
          const outcome = await c.query(sql, params).then(
            () => ({ code: 'executed', message: 'executed' }),
            (e: unknown) => ({
              code: String((e as { code?: string }).code ?? 'no-code'),
              message: String((e as { message?: string }).message ?? 'no-message'),
            }),
          );
          // The same guard the shared helpers carry: a verdict inherited from
          // an aborted transaction is not a measurement of this role.
          expect(outcome.code, `this claim read an ABORTED transaction, so it measured nothing: ${role} / ${sql}`).not.toBe(ABORTED);
          return outcome;
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
        }
      };

      const CREATE = `SELECT replayed FROM customer_create($1::uuid, $2::text, NULL, NULL, NULL)`;
      const UPDATE = `SELECT replayed FROM customer_update($1::uuid, 1::integer, $2::text, NULL, NULL, NULL)`;

      // THE SAVED COPY, taken before anything is planted, and the state the
      // restoration is measured against. `git checkout` could not restore
      // this: a grant lives in the catalogue, not in the tree.
      const before = await aclDigest();
      expect(before.acl, 'daftar_worker holds no EXECUTE before the plant').not.toContain('daftar_worker');

      /** Both signatures, so the plant and its restore cover everything the claim claims. */
      const SIGNATURES = ['customer_create(uuid,text,text,text,text)', 'customer_update(uuid,integer,text,text,text,text)'] as const;

      try {
        // ── THE CLAIM ────────────────────────────────────────────────────
        expect((await callAs('daftar_worker', CREATE, [randomUUID(), 'Worker Mint'])).code, 'customer_create called by daftar_worker').toBe('42501');
        expect((await callAs('daftar_worker', UPDATE, [customerId, 'Worker Edit'])).code, 'customer_update called by daftar_worker').toBe('42501');

        // THE POSITIVE CONTROL for the refusals: the same connection, the same
        // SET LOCAL ROLE mechanism, the role the pattern DOES grant.
        //
        // IT NAMES THE CODE IT EXPECTS. `not.toBe('42501')` would be a loose
        // reader: a malformed parameter (`22P02`) or any other fault would
        // satisfy it and the control would pass while measuring nothing. What
        // this call actually fails on, once past the privilege check, is the
        // assertion gate — `0054:361` raises `inventory.assertion_missing`
        // under `ERRCODE = 'P0001'`. `P0001` is `raise_exception` and every
        // domain refusal in this schema uses it, so the code alone is
        // ambiguous and the message is asserted with it.
        const asApp = await callAs('daftar_app', CREATE, [randomUUID(), 'App Mint']);
        expect(asApp.code, 'daftar_app is stopped by a RAISE, not by the privilege check').toBe('P0001');
        expect(asApp.message, 'and the RAISE is the assertion gate refusing an unsigned command').toContain('inventory.assertion_missing');

        // ── THE PLANT: the opposite state, so the claim is shown ABLE TO FAIL ──
        // BOTH functions, because the claim is about both.
        for (const sig of SIGNATURES) await c.query(`GRANT EXECUTE ON FUNCTION ${sig} TO daftar_worker`);
        const planted = await aclDigest();
        // The plant is PROVED APPLIED before its verdict is read (RULE-27):
        // the digest moved and BOTH routines' ACLs now name the role.
        expect(planted.digest, 'the plant changed the catalogue ACL').not.toBe(before.digest);
        expect(
          planted.acl.split('\n').filter((l) => l.includes('daftar_worker')),
          'both routines now name daftar_worker',
        ).toHaveLength(2);

        // And now the claim FAILS, for each function in turn: the same calls
        // are no longer refused 42501, and each is stopped by the gate instead.
        const plantedCreate = await callAs('daftar_worker', CREATE, [randomUUID(), 'Worker Mint']);
        const plantedUpdate = await callAs('daftar_worker', UPDATE, [customerId, 'Worker Edit']);
        // Stated POSITIVELY, for the same reason the control is: with the
        // grant in place each call now reaches the assertion gate, so the
        // expected answer is that gate's own refusal — naming it rules out
        // every other way a call could stop, which `not.toBe('42501')` would
        // have admitted.
        expect(plantedCreate.code, 'with the grant planted, customer_create is stopped by the gate and not the ACL').toBe('P0001');
        expect(plantedUpdate.code, 'with the grant planted, customer_update is stopped by the gate and not the ACL').toBe('P0001');
        expect(plantedCreate.message, 'and the gate is the one refusing it').toContain('inventory.assertion_missing');
        expect(plantedUpdate.message, 'and so for the update').toContain('inventory.assertion_missing');
      } finally {
        // ── THE RESTORE, from the saved copy and not from the tree ───────
        for (const sig of SIGNATURES) await c.query(`REVOKE EXECUTE ON FUNCTION ${sig} FROM daftar_worker`).catch(() => undefined);
      }

      try {
        const after = await aclDigest();
        expect(after.digest, `the ACL is restored byte for byte: ${before.digest} -> ${after.digest}`).toBe(before.digest);
        expect(after.acl, 'and daftar_worker holds no EXECUTE again').not.toContain('daftar_worker');

        // The claim holds again on the restored state, for BOTH functions,
        // which is what makes the restoration a measurement and not an
        // assertion.
        expect((await callAs('daftar_worker', CREATE, [randomUUID(), 'Worker Mint'])).code, 'customer_create refused once more').toBe('42501');
        expect((await callAs('daftar_worker', UPDATE, [customerId, 'Worker Edit'])).code, 'customer_update refused once more').toBe('42501');
      } finally {
        // The connection is closed here and not after the assertions: an
        // assertion that throws above would otherwise leak it.
        await c.end();
      }
    });
  });

  // ── (g) the control for the derived-head guard in the barrier suite ────
  describe('(g) a scratch database below the complete set is still detected', () => {
    /**
     * THE MANDATORY POSITIVE CONTROL for the one line this branch changed in
     * `tests/security/p4s4-rls-barrier-behaviour.test.ts` — a file that
     * belongs to the train, changed under a LIMITED permission from the
     * coordinator.
     *
     * That line used to read `!head.startsWith('0086_')` and now reads
     * `head !== headMigration()`. Deriving the head removes a literal that
     * goes stale at every migration; it must NOT remove the guard's ability
     * to refuse a database built short of the complete set. So the red arm is
     * proved here rather than asserted: a scratch database built deliberately
     * to an EARLIER head must NOT satisfy the new predicate.
     *
     * It lives in this suite and not in the barrier suite because the
     * permission is for one line in a file this lane does not own, and a
     * control added there would widen that change.
     */
    let shortDb: ScratchDb | undefined;

    afterAll(async () => {
      await shortDb?.drop();
    });

    it('headMigration() is the migrations directory own highest file, and a short build fails the predicate', async () => {
      // PART ONE, which needs no database: the derivation is the directory's
      // highest file, and it is NOT the stale literal the line used to carry.
      const files = migrationFiles().map(base);
      const highest = files[files.length - 1];
      expect(highest, 'the migrations directory has a highest file').toBeDefined();
      expect(base(headMigration()), 'headMigration() derives that same file').toBe(highest);
      expect(highest?.startsWith('0086_'), 'and it is no longer the 0086 the old literal pinned').toBe(false);
      expect(highest).toBe(MIGRATION);

      // PART TWO, the red arm: a database built to the migration BEFORE the
      // head. The seed is the `upTo` option, and it is PROVED APPLIED before
      // its verdict is read (RULE-27) — the applied list ends where asked and
      // does not contain the head.
      const short = headBefore();
      shortDb = await createScratchDb('daftar_l3_short_of_head', { upTo: short });
      const appliedHead = base(String(shortDb.applied[shortDb.applied.length - 1]));
      expect(appliedHead, 'the seed applied: the build stopped at the migration before the head').toBe(short);
      expect(shortDb.applied.map(base), 'and the head itself is absent').not.toContain(highest);

      // THE CLAIM GOES RED: this is exactly the comparison the barrier suite's
      // `beforeAll` performs, and on a short build it must not hold.
      expect(appliedHead === base(headMigration()), 'a database below the complete set does NOT satisfy the derived-head guard').toBe(false);
    }, 420_000);
  });

  // ── (h) the permission bit is load-bearing ─────────────────────────────
  //
  // Proved able to fail, and the planting measured WHERE the refusal lives.
  // Weakening `@phase4Permission('customers.manage')` on one route, on the
  // other, or on both leaves this test GREEN: a second gate refuses as well —
  // `OPERATION_AUTHORITY` in apps/api/src/modules/inventory/
  // inventory-authorization.ts maps `customer.create` and `customer.update` to
  // `customers.manage`, and customer.service.ts calls it. The test goes RED
  // only when BOTH are weakened: measured on this file's own tree, the route
  // then answered 201 and this `it` failed on
  // `expected 201 to be 403`. Both files were restored byte-for-byte
  // afterwards (git hash-object equal to the pre-plant blobs).
  //
  // So what this group defends is the ROUTE's refusal, not one decorator. A
  // future change that drops only the decorator will not be caught here — it
  // will be caught by that second gate, and if someone ever deletes the gate
  // too, this test is what goes red.
  describe('(h) the permission bit itself is load-bearing on both write routes', () => {
    it('refuses POST /v1/customers and PUT /v1/customers/:id for a member holding every permission but customers.manage, while the same member still reads', async () => {
      // A custom role = every permission the owner holds EXCEPT the one under
      // proof. The owner holds all of them, so the delegation ceiling lets the
      // role through; any other refusal would then be about the fixture.
      const without = PERMISSIONS.filter((p) => p !== 'customers.manage');
      expect(without.length, 'the stripped set is the full set minus exactly one key').toBe(PERMISSIONS.length - 1);
      expect(without, 'customers.view stays: it is the positive control').toContain('customers.view');

      const role = await t.request
        .post('/v1/businesses/current/roles')
        .set(asMember(ownerA, bizA.businessId))
        .send({ key: 'no-cust-manage', name: 'No customers.manage', permissions: without });
      expect(role.status, `create the stripped role: ${JSON.stringify(role.body)}`).toBe(201);

      // Self-contained: the owner (who DOES hold customers.manage) creates the
      // customer under test, so this group does not lean on (a)'s state.
      const targetId = randomUUID();
      const seeded = await t.request.post('/v1/customers').set(asMember(ownerA, bizA.businessId)).send({ customerId: targetId, name: 'Permission Target' });
      expect(seeded.status, `owner seeds the target customer: ${JSON.stringify(seeded.body)}`).toBe(201);

      const member = await registerActor(t, 'L3 stripped member');
      const add = await t.request
        .post('/v1/businesses/current/members')
        .set(asMember(ownerA, bizA.businessId))
        .send({ email: member.email, roleKey: 'no-cust-manage' });
      expect(add.status, `add the member to the stripped role: ${JSON.stringify(add.body)}`).toBe(201);
      const h = asMember(member, bizA.businessId);

      // POSITIVE CONTROL: the same caller, token and business succeed on a
      // route it does hold, and see the customer the owner seeded.
      const read = await t.request.get('/v1/customers').set(h);
      expect(read.status, `positive control, GET /v1/customers by the stripped member: ${JSON.stringify(read.body)}`).toBe(200);
      const one = await t.request.get(`/v1/customers/${targetId}`).set(h);
      expect(one.status, `positive control, GET the customer by id: ${JSON.stringify(one.body)}`).toBe(200);

      const newId = randomUUID();
      const post = await t.request.post('/v1/customers').set(h).send({ customerId: newId, name: 'Should Not Exist' });
      expect(post.status, `POST /v1/customers without customers.manage must be refused 403: ${JSON.stringify(post.body)}`).toBe(403);
      const put = await t.request.put(`/v1/customers/${targetId}`).set(h).send({ expectedRevision: 1, name: 'Should Not Change' });
      expect(put.status, `PUT /v1/customers/:id without customers.manage must be refused 403: ${JSON.stringify(put.body)}`).toBe(403);
      for (const [route, res] of [
        ['POST', post],
        ['PUT', put],
      ] as const) {
        expect(JSON.stringify(res.body), `${route} refusal names the missing permission`).toContain('customers.manage');
      }

      // The refusal wrote nothing: the owner still sees the seeded state, and the
      // refused create left no row.
      const after = await t.request.get(`/v1/customers/${targetId}`).set(asMember(ownerA, bizA.businessId));
      expect(after.body.name, 'a refused PUT changed nothing').toBe('Permission Target');
      expect(after.body.revision, 'a refused PUT advanced nothing').toBe(1);
      const ghost = await t.request.get(`/v1/customers/${newId}`).set(asMember(ownerA, bizA.businessId));
      expect(ghost.status, 'a refused POST created no customer').toBe(404);
    }, 120_000);
  });
});
