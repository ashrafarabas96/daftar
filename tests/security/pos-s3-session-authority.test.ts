/**
 * P4-S3 — **ONE TILL SESSION = ONE AUTHENTICATED USER, PERFORMED AGAINST THE
 * DATABASE** (`OD-P4-09` OPTION A; lock `P4-AL-40`, `P4-AL-86`, `P4-AL-30`).
 *
 * `tests/guards/pos-s3-session-law.test.ts` reads the migration tree and
 * asserts that the rule is expressed in the DDL: a NOT NULL owner, a
 * trigger-wired routine that compares the two versions of it, the composite
 * referential edge that binds a basket line to the session's own user, and no
 * unearned per-row actor column. That suite's own header says this file
 * «performs the bypass on a real connection and requires the DATABASE to
 * refuse it», and so does `apps/api/src/modules/pos/pos-permissions.ts`.
 *
 * It did not exist. Both comments named a protection that was never written,
 * which is the defect class this slice met five times already — a SHAPE used
 * as a stand-in for a FACT — committed one level up, in the prose that says
 * where the proof lives. A filename in a comment refuses nothing. This file is
 * the fact.
 *
 * ── WHY THE SUBJECT IS THE OWNER CONNECTION AND NOT `daftar_app` ──────────
 *
 * The rule may not live in the service because of the TRUSTED GENERIC
 * PRIMITIVE: `Database.withTransaction` and `Database.scoped` run whatever SQL
 * a caller hands them, so an `if` in the till-session service binds that
 * service and nothing else. The question this file asks is therefore not "can
 * the API do it" — the API holds `SELECT` only — but "can ANYONE do it".
 *
 * So every refusal below is demanded of the SCHEMA OWNER, a principal strictly
 * stronger than any role the running system holds, and stronger than
 * `daftar_inventory_internal`, which is what the till commands themselves run
 * as. A rule that refuses the owner refuses every writer that will ever exist
 * without the next migration editing this schema on purpose. §3 then adds the
 * privilege half for `daftar_app`, which is the only principal reachable from
 * a request.
 *
 * ── EVERY DENY IS PAIRED WITH THE ALLOW OF THE SAME SHAPE ─────────────────
 *
 * A refusal proves nothing on its own: a statement can fail because the row is
 * absent, the connection is wrong, the relation is unreadable or a NOT NULL is
 * unsatisfied, and every one of those reads identically to "the law refused
 * me". So each case here performs the LEGAL version of the same write, on the
 * same row, over the same connection, and requires it to SUCCEED. The pair is
 * the claim; neither half is.
 *
 * Every case runs inside an owner transaction that is rolled back, so the
 * session the fixture opened through the real route stays open for the next
 * one and the suite is order-independent.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, createTestApp, dbUrl, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { openTillSession } from '../helpers/pos-till-sessions';
import { onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { addMember } from '../helpers/merchant-reads';

/** The two relations and the one column the whole ruling rests on, named once. */
const SESSIONS = 'pos_till_sessions';
const CART = 'pos_cart_lines';
const OWNER_COLUMN = 'opened_by';

let t: TestApp;
let owner: HttpActor;
let cashier: HttpActor;
let colleague: HttpActor;
let A: S3Business;
/** An OPEN session, owned by `cashier`, opened through `POST /v1/pos/till-sessions`. */
let till: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'POS S3 authority owner');
  A = await onboardS3Business(t, owner, 'poss3auth');
  cashier = await addMember(t, owner, A, 'POS S3 authority cashier', 'cashier');
  // The bypass TARGET: a real member of the same business, with a real role.
  // The attack this file refuses is not a forged id — it is a colleague, which
  // is the only version of it a schema can be asked about.
  colleague = await addMember(t, owner, A, 'POS S3 authority colleague', 'cashier');
  // Opened through the REAL route, in the production composition: nothing is
  // inserted by hand, because `daftar_app` holds SELECT only and a row seeded
  // past the routine would be a session no cashier could have created.
  till = (await openTillSession(t, cashier, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_auth' })).sessionId;
}, 900_000);

afterAll(async () => {
  await t.close();
  await resetData();
});

/** One owner transaction, always rolled back: the fixture outlives every case. */
async function inOwnerTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    // The two guards are SECURITY DEFINER, owned by `daftar_inventory_internal`,
    // so RLS applies to the reads they make on this schema's own relations and
    // `tenant_membership` is a PERMISSIVE policy keyed on `app.tenant_id`. With
    // no scope set, `pos_cart_line_guard()`'s session lookup finds nothing and
    // raises `pos.session_not_open` — a refusal that LOOKS like the law and is
    // really a missing GUC. The first draft of this suite hit exactly that and
    // its ALLOW pair is what caught it. So the scope is set the way the API
    // sets it: transaction-local, from the fixture's own ids, never
    // `app.bypass_rls`, which would make every refusal below unfalsifiable.
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** The outcome of one statement, as the server reported it. */
interface Outcome {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

async function attempt(c: Client, sql: string, params: readonly unknown[] = []): Promise<Outcome> {
  try {
    await c.query(sql, [...params]);
    return { ok: true, code: '', message: '' };
  } catch (e) {
    // A failed statement aborts the transaction, so each attempt is wrapped in
    // its own savepoint by the caller when a later statement must still run.
    return { ok: false, code: String((e as { code?: string }).code ?? ''), message: String((e as { message?: string }).message ?? '') };
  }
}

/** Run `fn` so that its failure does not abort the surrounding transaction. */
async function savepointed(c: Client, fn: () => Promise<Outcome>): Promise<Outcome> {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${name}`);
  const out = await fn();
  if (!out.ok) await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
  else await c.query(`RELEASE SAVEPOINT ${name}`);
  return out;
}

/** The legal insert of one cart line, owned by `addedBy`. */
function insertLine(addedBy: string, lineNo: number): { readonly sql: string; readonly params: readonly unknown[] } {
  return {
    sql: `INSERT INTO ${CART} (tenant_id, business_id, till_session_id, id, line_no, product_id, variant_id, quantity, added_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, '1.0000', $8)`,
    params: [A.tenantId, A.businessId, till, randomUUID(), lineNo, A.piece.productId, A.piece.variantId, addedBy],
  };
}

// ═════════════════════════════════════════════════════════════════════════
describe('§1 — the owner of a till cannot be changed, and the SCHEMA OWNER is the one refused', () => {
  it('the fixture is a real OPEN session owned by the cashier — so every refusal below has a subject', async () => {
    const { rows } = await ownerPool().query<{ opened_by: string; status: string }>(
      `SELECT ${OWNER_COLUMN}, status FROM ${SESSIONS} WHERE business_id = $1 AND id = $2`,
      [A.businessId, till],
    );
    expect(rows[0]?.opened_by, 'the owner is the verified actor, never a request field').toBe(cashier.userId);
    expect(rows[0]?.status).toBe('open');
    // And the colleague is a DIFFERENT real user, so the swap below is a swap.
    expect(colleague.userId).not.toBe(cashier.userId);
  });

  it('`UPDATE opened_by` is REFUSED by name, while a LEGAL update of the same row on the same connection succeeds', async () => {
    await inOwnerTx(async (c) => {
      // ── THE ALLOW, first: the row is reachable and writable by this
      //    principal, so the refusal that follows is the rule's and not the
      //    connection's, the row's or a missing privilege's.
      const legal = await savepointed(c, () =>
        attempt(
          c,
          // All FOUR closing columns at once: `pos_till_sessions_state_ck`
          // enumerates each status with every column that must be null or
          // non-null in it, so a partial close is refused by the CHECK — which
          // is another refusal that would have read as the law's.
          `UPDATE ${SESSIONS} SET status = 'closed', closed_at = now(), closing_count_minor = 0, close_intent_sha256 = repeat('a', 64)
             WHERE business_id = $1 AND id = $2`,
          [A.businessId, till],
        ),
      );
      expect(legal.ok, `the owner could not perform the LEGAL close either, so this suite proves nothing: ${legal.message}`).toBe(true);

      // ── THE DENY, on the same row, same connection, same statement shape.
      const swap = await savepointed(c, () =>
        attempt(c, `UPDATE ${SESSIONS} SET ${OWNER_COLUMN} = $3 WHERE business_id = $1 AND id = $2`, [A.businessId, till, colleague.userId]),
      );
      expect(swap.ok, 'the schema owner re-owned a till session: OD-P4-09 is a service convention, not a rule').toBe(false);
      // The refusal NAMES the ruling. An anonymous `P0001` would be a rule the
      // client cannot act on and the next reader cannot find.
      expect(swap.code).toBe('P0001');
      expect(swap.message).toContain('pos.session_owner_immutable');
      expect(swap.message).toContain('OD-P4-09');
    });
  });

  it('a till session is never DELETED, and never UPDATED back to open', async () => {
    await inOwnerTx(async (c) => {
      const del = await savepointed(c, () => attempt(c, `DELETE FROM ${SESSIONS} WHERE business_id = $1 AND id = $2`, [A.businessId, till]));
      expect(del.ok, 'a till session was deleted: the drawer of a shift is not evidence').toBe(false);
      expect(del.code).toBe('P0001');
      expect(del.message).toContain('pos.till_session_immutable');

      // The opening facts are final too — in particular the counted float,
      // because a float that can be rewritten after the shift opened is not a
      // counted float (R-P4-S3-09).
      const float = await savepointed(c, () =>
        attempt(c, `UPDATE ${SESSIONS} SET opening_float_minor = opening_float_minor + 1 WHERE business_id = $1 AND id = $2`, [A.businessId, till]),
      );
      expect(float.ok, 'the counted opening float was rewritten after the shift opened').toBe(false);
      expect(float.message).toContain('pos.till_session_immutable');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§2 — a basket line cannot name a user the session does not belong to', () => {
  it('the SAME insert succeeds for the session’s owner and is refused for a colleague — by referential integrity', async () => {
    await inOwnerTx(async (c) => {
      // ── THE ALLOW: the line the cashier's own command would write.
      const legal = insertLine(cashier.userId, 1);
      const ok = await savepointed(c, () => attempt(c, legal.sql, legal.params));
      expect(ok.ok, `the legal line could not be written, so the refusal below is not about the actor: ${ok.message}`).toBe(true);

      // ── THE DENY: the identical statement with ONE value changed. There is
      //    no parent row `(business_id, id, opened_by)` for a colleague, so
      //    the refusal is the database's referential integrity and not a
      //    check inside a wrapper — `daftar_inventory_internal`, which every
      //    till command runs as, cannot write it either.
      const forged = insertLine(colleague.userId, 2);
      const denied = await savepointed(c, () => attempt(c, forged.sql, forged.params));
      expect(denied.ok, 'a basket line was written naming a user the session does not belong to').toBe(false);
      expect(denied.code, 'the refusal is not the composite foreign key — check which constraint refused and why').toBe('23503');
      expect(denied.message).toContain('pos_cart_lines_session_actor_fk');
    });
  });

  it('a line’s actor cannot be revised after the insert, and a line is never deleted', async () => {
    await inOwnerTx(async (c) => {
      const legal = insertLine(cashier.userId, 3);
      const ok = await savepointed(c, () => attempt(c, legal.sql, legal.params));
      expect(ok.ok, ok.message).toBe(true);

      // The ALLOW for an UPDATE: the quantity is what a revision changes.
      const qty = await savepointed(c, () =>
        attempt(c, `UPDATE ${CART} SET quantity = '2.0000' WHERE business_id = $1 AND till_session_id = $2 AND line_no = 3`, [A.businessId, till]),
      );
      expect(qty.ok, `a legal quantity revision was refused, so the refusals below are not about the actor: ${qty.message}`).toBe(true);

      const reassign = await savepointed(c, () =>
        attempt(c, `UPDATE ${CART} SET added_by = $3 WHERE business_id = $1 AND till_session_id = $2 AND line_no = 3`, [A.businessId, till, colleague.userId]),
      );
      expect(reassign.ok, 'a basket line was reassigned to another user after the insert').toBe(false);
      expect(reassign.message).toContain('pos.cart_line_immutable');

      const del = await savepointed(c, () =>
        attempt(c, `DELETE FROM ${CART} WHERE business_id = $1 AND till_session_id = $2 AND line_no = 3`, [A.businessId, till]),
      );
      expect(del.ok, 'a basket line was deleted: a removal is a tombstone and the basket is the record of the shift').toBe(false);
      expect(del.code).toBe('P0001');
      expect(del.message).toContain('pos.cart_line_immutable');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§3 — the only principal a request can reach holds no write at all', () => {
  it('`daftar_app` reads both relations and cannot insert, update or delete either', async () => {
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      // ── THE ALLOW: the connection is real and both relations are reachable
      //    through it, so each refusal below is a PRIVILEGE and not a missing
      //    relation, a bad password or a search path.
      for (const relation of [SESSIONS, CART]) {
        const read = await savepointed(c, () => attempt(c, `SELECT count(*) FROM ${relation}`));
        expect(read.ok, `daftar_app cannot even read ${relation}: ${read.message}`).toBe(true);
      }

      // ── THE DENY: every write, on both relations. 42501 is reported before
      //    RLS and before any constraint, which is why no fixture row is
      //    needed for this half and why the refusal cannot be a side effect of
      //    the predicate.
      // Each statement carries its OWN parameters. A statement that names $2
      // and $3 but never $1 is refused with `42P18 could not determine data
      // type of parameter $1` — a TEST defect that arrives looking exactly
      // like a privilege refusal, and one the first draft of this file made on
      // all six of the writes below. The `42501` assertion is what caught it.
      const biz = [A.businessId] as const;
      const writes: readonly { readonly what: string; readonly sql: string; readonly params: readonly unknown[] }[] = [
        {
          what: `INSERT ${SESSIONS}`,
          sql: `INSERT INTO ${SESSIONS} (tenant_id, business_id, id) VALUES ($1, $2, $3)`,
          params: [A.tenantId, A.businessId, randomUUID()],
        },
        {
          what: `UPDATE ${SESSIONS}.${OWNER_COLUMN}`,
          sql: `UPDATE ${SESSIONS} SET ${OWNER_COLUMN} = $2 WHERE business_id = $1`,
          params: [A.businessId, colleague.userId],
        },
        { what: `UPDATE ${SESSIONS}.status`, sql: `UPDATE ${SESSIONS} SET status = 'closed' WHERE business_id = $1`, params: biz },
        { what: `DELETE ${SESSIONS}`, sql: `DELETE FROM ${SESSIONS} WHERE business_id = $1`, params: biz },
        {
          what: `INSERT ${CART}`,
          sql: `INSERT INTO ${CART} (tenant_id, business_id, id) VALUES ($1, $2, $3)`,
          params: [A.tenantId, A.businessId, randomUUID()],
        },
        { what: `UPDATE ${CART}.added_by`, sql: `UPDATE ${CART} SET added_by = $2 WHERE business_id = $1`, params: [A.businessId, colleague.userId] },
        { what: `UPDATE ${CART}.quantity`, sql: `UPDATE ${CART} SET quantity = '1.0000' WHERE business_id = $1`, params: biz },
        { what: `DELETE ${CART}`, sql: `DELETE FROM ${CART} WHERE business_id = $1`, params: biz },
      ];
      const permitted: string[] = [];
      for (const w of writes) {
        const out = await savepointed(c, () => attempt(c, w.sql, w.params));
        if (out.ok || out.code !== '42501') permitted.push(`${w.what} → ${out.ok ? 'SUCCEEDED' : `${out.code} ${out.message}`}`);
      }
      expect(permitted, 'daftar_app holds a write on a POS relation: every till write must go through the asserting routines').toEqual([]);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
/**
 * §4 — THE CANARIES: each refusal above is proved to be THAT protection's.
 *
 * Every assertion so far is of the form "the statement failed". A suite made
 * only of those is green for the wrong reason the moment something unrelated
 * refuses first — which is not a hypothetical here: the first run of this file
 * failed four cases, and all four were refusals by a CHECK constraint, by a
 * missing scope GUC and by `42P18`, each arriving in the shape of the law.
 *
 * So each protection is REMOVED inside a transaction that is rolled back, and
 * the same statement is required to SUCCEED. That is the red half, performed
 * rather than described: it proves the refusal was the named trigger's and the
 * named constraint's, and it proves these assertions can fail — which is the
 * only thing that makes their passing mean anything (`0079` is a CANDIDATE
 * migration and nothing here edits it; `DISABLE TRIGGER` and `DROP
 * CONSTRAINT` are transactional in PostgreSQL and this transaction never
 * commits).
 */
describe('§4 — each refusal is proved to belong to the protection that is claimed to make it', () => {
  it('with `pos_till_sessions_lifecycle` disabled, the owner swap SUCCEEDS — so the refusal was that trigger’s', async () => {
    await inOwnerTx(async (c) => {
      await c.query(`ALTER TABLE ${SESSIONS} DISABLE TRIGGER pos_till_sessions_lifecycle`);
      const swap = await savepointed(c, () =>
        attempt(c, `UPDATE ${SESSIONS} SET ${OWNER_COLUMN} = $3 WHERE business_id = $1 AND id = $2`, [A.businessId, till, colleague.userId]),
      );
      // And it succeeds, which also states the division of labour the schema
      // documents: with NO basket line yet there is no referencing row, so
      // `pos_cart_lines_session_actor_fk` cannot see this write at all. The
      // trigger is the only thing covering that window — exactly as
      // `0079:493` says — and this is the measurement of it.
      expect(swap.ok, `the swap failed for a SECOND reason, so §1 may be green because of that one instead: ${swap.code} ${swap.message}`).toBe(true);
    });
  });

  it('with `pos_cart_lines_session_actor_fk` dropped, the forged line SUCCEEDS — so the refusal was that constraint’s', async () => {
    await inOwnerTx(async (c) => {
      await c.query(`ALTER TABLE ${CART} DROP CONSTRAINT pos_cart_lines_session_actor_fk`);
      const forged = insertLine(colleague.userId, 7);
      const out = await savepointed(c, () => attempt(c, forged.sql, forged.params));
      expect(out.ok, `the forged line failed for a SECOND reason, so §2 may be green because of that one instead: ${out.code} ${out.message}`).toBe(true);
    });
  });

  it('a basket line of a CLOSED shift is refused, and the suite’s own fixture is still open after every rollback', async () => {
    // The last thing a suite of rolled-back transactions owes: that the
    // rollbacks really happened. If any case above had committed, the session
    // would now be closed or re-owned, and every earlier assertion would have
    // been about a different world than the one the fixture created.
    const { rows } = await ownerPool().query<{ opened_by: string; status: string }>(
      `SELECT ${OWNER_COLUMN}, status FROM ${SESSIONS} WHERE business_id = $1 AND id = $2`,
      [A.businessId, till],
    );
    expect(rows[0]?.status, 'a case committed: the fixture session is no longer open').toBe('open');
    expect(rows[0]?.opened_by, 'a case committed: the fixture session changed hands').toBe(cashier.userId);
    const { rows: lines } = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${CART} WHERE business_id = $1 AND till_session_id = $2`, [
      A.businessId,
      till,
    ]);
    expect(lines[0]?.n, 'a case committed: the basket holds rows no command wrote').toBe('0');
  });
});
