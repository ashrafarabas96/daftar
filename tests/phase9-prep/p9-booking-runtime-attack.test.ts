/**
 * P9 PREP — THE RUNTIME IS NOT A WRITER, PROVEN BY ATTACK
 * (Master Continuous Mission §16: "runtime ليس كاتبًا مباشرًا … تحقق من
 * bootstrap والمنح والأدوار الداخلية والوصول و RLS بدور غير خارق. لا إثبات
 * نواة أو كتالوج بدل هجوم منفذ" — no catalogue proof in place of an EXECUTED
 * attack; cross-phase law: RLS proved by non-superuser attack.)
 *
 * The schema suite already reads the grant model out of `pg_catalog`, and that
 * is PROVEN BY DATABASE CATALOGUE — a different and weaker class than this
 * file. A catalogue says what was granted. It does not say what happens when a
 * real runtime connection, with no superuser anywhere in the picture, tries
 * the write anyway: a policy can exist and not bite, a grant can be revoked
 * and the role can still own the table, and every one of those gaps has cost
 * this project a round before.
 *
 * So every case below CONNECTS AS the role under test and issues the statement
 * an attacker would. The superuser appears only to seed, never to prove.
 *
 * Status: PREPARED / NOT PROMOTED. Not part of required CI.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH, P9_RELATIONS } from './p9-booking-spec';
import { type BookingWorld, INTENT, applySpecAsMigrator, bookingParams, seedBookingWorld, uuid } from './p9-booking-world';

const DAY = '2027-09-21';
const at = (hhmm: string): string => `${DAY}T${hhmm}:00Z`;

/** Every runtime login role the deployment has. None of them may write here. */
const RUNTIME_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_reconciler'] as const;

describe('P9 bookings — attacked as the real runtime roles, with no superuser', () => {
  let db: ScratchDb;
  let world: BookingWorld;
  /** A booking that exists, so a failed UPDATE or DELETE is a refusal and not a no-op. */
  let standing = '';
  /** A recorded operation id over that booking, for the replay lookup. */
  let recorded = '';

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_attack', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
    world = await seedBookingWorld(db);
    standing = uuid(3000);
    await db.pool.query(
      `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                             starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                             state, intent_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::int, $12::int,
               tstzrange($9::timestamptz, $10::timestamptz, '[)'), $13, $14, $15)`,
      bookingParams({ world, id: standing, startsAt: at('10:00'), endsAt: at('10:30') }),
    );
    // A recorded operation naming it, so the replay lookup has a real row to
    // leak if row security does not reach inside the routine.
    recorded = uuid(3002);
    await db.pool.query(
      `INSERT INTO booking_operations (tenant_id, business_id, operation_id, op_code, intent_sha256, booking_id, actor_user_id)
       VALUES ($1, $2, $3, 'booking.create', $4, $5, $6)`,
      [world.tenantId, world.businessId, recorded, INTENT, standing, world.userId],
    );
    // A booking in the SIBLING business of the same tenant, so a cross-business
    // read has something real to find if the policies do not hold.
    await db.pool.query(
      `INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'room', 'Sibling room', $5)`,
      [world.tenantId, world.otherBusinessId, world.otherBranchId, uuid(3001), world.userId],
    );
    await db.pool.query(
      `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                             starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                             state, intent_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'resource_block', $5, NULL, NULL, $6::timestamptz, $7::timestamptz, 0, 0,
               tstzrange($6::timestamptz, $7::timestamptz, '[)'), 'booked', $8, $9)`,
      [world.tenantId, world.otherBusinessId, world.otherBranchId, uuid(3002), uuid(3001), at('10:00'), at('10:30'), INTENT, world.userId],
    );
    // The subjects exist, or every refusal below would be vacuous.
    const seeded = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings`);
    expect(seeded.rows[0]?.n).toBe(2);
  }, 600_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** Run `fn` on a fresh connection as `role`, with the app GUCs it would carry. */
  const asRole = async <T>(
    role: 'daftar_app' | 'daftar_platform' | 'daftar_worker' | 'daftar_resolver' | 'daftar_identity' | 'daftar_reconciler' | 'daftar_migrator',
    scope: { tenant?: string; business?: string } | null,
    fn: (c: Client) => Promise<T>,
  ): Promise<T> => {
    const client = new Client({ connectionString: db.url(role) });
    await client.connect();
    try {
      await client.query('BEGIN');
      if (scope !== null) {
        await client.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`,
          [scope.tenant ?? '', scope.business ?? ''],
        );
      }
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  };

  /** The SQLSTATE a statement raised, or '' if it unexpectedly succeeded. */
  const attack = async (c: Client, sql: string, params: unknown[] = []): Promise<string> => {
    try {
      await c.query(sql, params);
      return '';
    } catch (e) {
      return typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'no-sqlstate';
    }
  };

  it('no runtime role can INSERT into any of the seven relations — executed, not read from a grant', async () => {
    for (const role of RUNTIME_ROLES) {
      for (const relation of P9_RELATIONS) {
        const code = await asRole(role, { tenant: world.tenantId, business: world.businessId }, (c) =>
          // A deliberately shapeless INSERT: it must be stopped by PRIVILEGE,
          // before any CHECK or NOT NULL could be what refused it. A refusal
          // for the wrong reason would prove nothing about the grant model.
          attack(c, `INSERT INTO ${relation} (tenant_id) VALUES ($1)`, [world.tenantId]),
        );
        expect(code, `${role} INSERT ${relation}`).toBe('42501');
      }
    }
  });

  it('no runtime role can UPDATE or DELETE a booking that really exists', async () => {
    for (const role of RUNTIME_ROLES) {
      const updated = await asRole(role, { tenant: world.tenantId, business: world.businessId }, (c) =>
        attack(c, `UPDATE bookings SET state = 'cancelled' WHERE business_id = $1 AND id = $2`, [world.businessId, standing]),
      );
      expect(updated, `${role} UPDATE bookings`).toBe('42501');
      const deleted = await asRole(role, { tenant: world.tenantId, business: world.businessId }, (c) =>
        attack(c, `DELETE FROM bookings WHERE business_id = $1 AND id = $2`, [world.businessId, standing]),
      );
      expect(deleted, `${role} DELETE bookings`).toBe('42501');
    }
    // And it is still there, which is what makes the two refusals above mean
    // something rather than describing a row that was never reachable.
    const alive = await db.pool.query<{ state: string }>(`SELECT state FROM bookings WHERE business_id = $1 AND id = $2`, [world.businessId, standing]);
    expect(alive.rows[0]?.state).toBe('booked');
  });

  it('the merchant runtime can READ the calendar it must show, under its own business scope', async () => {
    // The other half of the grant model: a deny-everything schema would pass
    // every case above and be useless. This is the case that makes them
    // meaningful.
    const rows = await asRole('daftar_app', { tenant: world.tenantId, business: world.businessId }, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id::text FROM bookings ORDER BY id`);
      return r.rows.map((x) => x.id);
    });
    expect(rows).toEqual([standing]);
  });

  it('RLS BITES: the sibling business of the same tenant is invisible, and its booking exists (tenant leakage)', async () => {
    // Two businesses, one tenant, both carrying a booking at the same hour. A
    // permissive tenant policy alone would show both; the restrictive
    // per-business policies are what reduce it to one, and swapping the scope
    // swaps which one.
    const ours = await asRole('daftar_app', { tenant: world.tenantId, business: world.businessId }, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings`);
      return r.rows[0]?.n;
    });
    const theirs = await asRole('daftar_app', { tenant: world.tenantId, business: world.otherBusinessId }, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id::text FROM bookings`);
      return r.rows.map((x) => x.id);
    });
    expect(ours).toBe(1);
    expect(theirs).toEqual([uuid(3002)]);
    // With no business scope at all, nothing is visible — the policies fail
    // CLOSED. An empty GUC must not read as "every business".
    const unscoped = await asRole('daftar_app', { tenant: world.tenantId, business: '' }, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings`);
      return r.rows[0]?.n;
    });
    expect(unscoped).toBe(0);
    // And a foreign tenant id with a real business id of another tenant sees
    // nothing either: both halves must agree.
    const foreign = await asRole('daftar_app', { tenant: uuid(3999), business: world.businessId }, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings`);
      return r.rows[0]?.n;
    });
    expect(foreign).toBe(0);
  });

  it('no runtime role can read the operation registry at all — it is nobody’s merchant surface', async () => {
    for (const role of RUNTIME_ROLES) {
      const code = await asRole(role, { tenant: world.tenantId, business: world.businessId }, (c) => attack(c, `SELECT count(*) FROM booking_operations`));
      expect(code, `${role} SELECT booking_operations`).toBe('42501');
    }
  });

  it('no runtime role can execute the lock-key, lock-set, local-time or replay routines', async () => {
    for (const role of RUNTIME_ROLES) {
      const calls: [string, unknown[]][] = [
        [`SELECT booking_resource_lock_key($1, $2)`, [world.businessId, world.resourceAId]],
        [`SELECT booking_lock_resources($1, ARRAY[$2]::uuid[])`, [world.businessId, world.resourceAId]],
        [`SELECT booking_resolve_local('UTC', '2027-01-01 10:00'::timestamp, NULL)`, []],
        // The replay lookup is the registry read in routine form, and the
        // case above already proves no runtime role may read the registry.
        // A grant here would be that refusal undone through a function.
        [`SELECT * FROM booking_replay_result($1, $2, 'booking.create', $3)`, [world.businessId, world.resourceAId, 'a'.repeat(64)]],
      ];
      for (const [sql, params] of calls) {
        const code = await asRole(role, { tenant: world.tenantId, business: world.businessId }, (c) => attack(c, sql, params));
        expect(code, `${role} ${sql}`).toBe('42501');
      }
    }
  });

  it('no runtime role can execute the definer buffer guard directly', async () => {
    for (const role of RUNTIME_ROLES) {
      const code = await asRole(role, null, (c) => attack(c, `SELECT bookings_buffers_match_service()`));
      // 42501 if the privilege stops it. Nothing may reach the body.
      expect(code, `${role} buffer guard`).toBe('42501');
    }
  });

  it('EVEN THE INTERNAL AUTHORITY cannot write across the business boundary: RLS applies to the writer too', async () => {
    // The sharpest case in this file. `daftar_booking_internal` holds the only
    // DML on these relations, is NOLOGIN, and is reached the way a command
    // would reach it — `SET ROLE` from the deployment principal, which holds
    // it WITH INHERIT FALSE, SET TRUE. It is NOBYPASSRLS, so FORCE ROW LEVEL
    // SECURITY applies to it as much as to anyone, and a write aimed at
    // another business must be refused by POLICY rather than by privilege.
    const outcome = await asRole('daftar_migrator', null, async (c) => {
      await c.query(`SET ROLE daftar_booking_internal`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
        world.tenantId,
        world.businessId,
      ]);
      const role = (await c.query<{ r: string }>(`SELECT current_user AS r`)).rows[0]?.r;
      // Scoped to OUR business, aimed at the SIBLING's: the row is legal in
      // every other respect, so only the policy can stop it.
      //
      // Behind a SAVEPOINT, because the refusal aborts the transaction and the
      // legal write below would then fail with 25P02 — a refusal for the wrong
      // reason, which would have let this case pass while proving nothing.
      await c.query('SAVEPOINT smuggle');
      const code = await attack(
        c,
        `INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'room', 'Smuggled', $5)`,
        [world.tenantId, world.otherBusinessId, world.otherBranchId, uuid(3100), world.userId],
      );
      await c.query('ROLLBACK TO SAVEPOINT smuggle');
      // And the same row INSIDE our own business is accepted, so the refusal
      // above is the boundary and not a blanket denial.
      const allowed = await attack(
        c,
        `INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'room', 'Ours', $5)`,
        [world.tenantId, world.businessId, world.branchId, uuid(3101), world.userId],
      );
      return { role, code, allowed };
    });
    // The attack really ran as the internal authority, not as the migrator.
    expect(outcome.role).toBe('daftar_booking_internal');
    expect(outcome.code).toBe('42501');
    expect(outcome.allowed).toBe('');
    // Nothing was smuggled: the transaction was rolled back, and in any case
    // the refused row never existed.
    const smuggled = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM booking_resources WHERE id = $1`, [uuid(3100)]);
    expect(smuggled.rows[0]?.n).toBe(0);
  });

  it('a replay cannot be used to read ACROSS businesses: the lookup enforces the caller\u2019s own scope (R-P9-14)', async () => {
    // `booking_replay_result` is SECURITY INVOKER precisely so that row
    // security reaches inside it. A DEFINER lookup would have been the
    // tenant leak this file exists to rule out: an operation id is a value a
    // caller supplies, so a sibling business could walk them and learn both
    // that a key exists and which booking it produced.
    const outcome = await asRole('daftar_migrator', null, async (c) => {
      await c.query(`SET ROLE daftar_booking_internal`);
      const replay = async (scope: string): Promise<{ o_replay: boolean; o_booking_id: string | null }> => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
          world.tenantId,
          scope,
        ]);
        const r = await c.query<{ o_replay: boolean; o_booking_id: string | null }>(
          `SELECT o_replay, o_booking_id FROM booking_replay_result($1, $2, 'booking.create', $3)`,
          [world.businessId, recorded, INTENT],
        );
        const row = r.rows[0];
        if (row === undefined) throw new Error('booking_replay_result returned no row');
        return row;
      };
      // Scoped to the business that owns the key: the answer is the record.
      // Asserted first, or the sibling's empty answer below would be
      // consistent with the lookup simply never working.
      const ours = await replay(world.businessId);
      // The SAME key, the SAME business argument, a sibling's scope.
      // Each refusal behind its own SAVEPOINT: the first one aborts the
      // transaction, and without this the second would come back as 25P02 —
      // a refusal for the wrong reason, which passes while proving nothing.
      const refused = async (scope: string): Promise<string> => {
        await c.query('SAVEPOINT replay_probe');
        try {
          await replay(scope);
          await c.query('RELEASE SAVEPOINT replay_probe');
          return '';
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT replay_probe');
          return e instanceof Error ? e.message : String(e);
        }
      };
      const refusal = await refused(world.otherBusinessId);
      // And an unscoped caller is refused too, rather than served.
      const unscoped = await refused('');
      return { ours, refusal, unscoped };
    });
    expect(outcome.ours.o_replay).toBe(true);
    expect(outcome.ours.o_booking_id).toBe(standing);
    // This case was written expecting row security to answer "first attempt",
    // and it returned the SIBLING'S ROW instead: §8's read policies exempt
    // `daftar_booking_internal` by name, and that is the only principal that
    // may execute this routine, so RLS confines it to the tenant and not to
    // the business. The boundary now lives in the routine, and this is the
    // measurement that put it there.
    expect(outcome.refusal).toContain('booking.replay_scope_mismatch');
    expect(outcome.unscoped).toContain('booking.replay_scope_mismatch');
  });

  it('the internal authority cannot DELETE a booking, by privilege and then by trigger', async () => {
    const outcome = await asRole('daftar_migrator', null, async (c) => {
      await c.query(`SET ROLE daftar_booking_internal`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
        world.tenantId,
        world.businessId,
      ]);
      return attack(c, `DELETE FROM bookings WHERE business_id = $1 AND id = $2`, [world.businessId, standing]);
    });
    // Append-only is a property of the GRANT, so this stops before the trigger
    // is reached at all.
    expect(outcome).toBe('42501');
    const alive = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND id = $2`, [
      world.businessId,
      standing,
    ]);
    expect(alive.rows[0]?.n).toBe(1);
  });
});
