/**
 * P3-S3 T-15 — TD-13: THE REPLAY-REGISTRY PRUNE NEVER MAKES A CONSUMER WAIT
 * (docs/PHASE_3_S3_CONTRACT.md A-17, §6 T-15).
 *
 * `accounting_actor` and `provision_actor` both end with an opportunistic
 * DELETE of expired jtis. As a plain DELETE it row-locked every expired row,
 * so while one consuming transaction stayed open every other consumer — in
 * any tenant — queued behind it. 0061 puts the DELETE under a
 * transaction-scoped advisory try-lock: only the winner prunes, everyone else
 * skips hygiene and never waits.
 *
 * Two real connections, committed fixtures (a two-connection suite), cleaned
 * up with `resetData`. For each registry:
 *   1. connection 1 consumes, wins the prune (holds the advisory lock and the
 *      row locks of the rows it deleted) and stays open;
 *   2. connection 2, in another tenant, consumes under lock_timeout 2 s and
 *      commits without waiting;
 *   3. the skipped hygiene is only deferred: a later consume prunes, and never
 *      a live jti;
 *   4. negative control: with the plain-DELETE body restored in connection 2's
 *      own transaction (owner, rolled back), the same pair fails 55P03;
 *   5. the catalogue: owner, SECURITY DEFINER, proconfig and the EXECUTE grants
 *      are the ones 0061-E pins, and the try-lock precedes the only DELETE.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  assertionFor as accountingAssertion,
  postAs,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { ensurePostgres, mintTestAssertion, ownerPool, provisionerDbUrl, resetData } from '../helpers/test-app';
import { RUNTIME_ROLES, must, ownerClient, pidOf, refusedWith, roleClient, settle } from '../helpers/inventory-commands';

let one: PostingFixture;
let two: PostingFixture;
let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  one = await seedPostingFixture(ownerPool(), 'prune-one');
  two = await seedPostingFixture(ownerPool(), 'prune-two');
  day = await todayIn(ownerPool(), 'Asia/Hebron');
});

afterAll(async () => {
  await resetData();
});

interface Registry {
  readonly name: 'accounting' | 'provisioning';
  readonly table: 'accounting_assertion_uses' | 'provisioning_assertion_uses';
  readonly fn: 'accounting_actor' | 'provision_actor';
  readonly lockKey: string;
  /** Open a transaction on a fresh runtime connection and consume one jti in it for the given fixture. */
  readonly open: (fx: PostingFixture, timeouts: boolean) => Promise<Client>;
  /** Consume one jti inside the open transaction of `c` (which may be an owner connection that switches role). */
  readonly consume: (c: Client, fx: PostingFixture) => Promise<void>;
  readonly runtimeRole: 'daftar_app' | 'daftar_provisioner';
  /** The owner: accounting's internal principal (0061-E), and since TD-18 (0070) the provisioning internal principal. */
  readonly owner: () => Promise<string>;
  readonly proconfig: readonly string[];
  readonly executors: readonly string[];
}

async function withTimeouts(c: Client): Promise<void> {
  await c.query(`SET LOCAL lock_timeout = '2s'`);
  await c.query(`SET LOCAL statement_timeout = '5s'`);
}

async function consumeAccounting(c: Client, fx: PostingFixture): Promise<void> {
  const cmd = simpleCommand(fx, randomUUID(), day);
  await postAs(accountingAssertion(cmd, fx.userId), cmd, {}, c);
}

async function consumeProvisioning(c: Client, fx: PostingFixture): Promise<void> {
  await c.query(`SELECT set_config('app.provisioning_assertion', $1, true), set_config('app.bypass_rls', 'true', true)`, [
    mintTestAssertion(fx.userId, 'onboarding'),
  ]);
  await c.query('SELECT provision_create_tenant($1)', [randomUUID()]);
}

const REGISTRIES: readonly Registry[] = [
  {
    name: 'accounting',
    table: 'accounting_assertion_uses',
    fn: 'accounting_actor',
    lockKey: 'daftar.accounting_assertion_uses',
    open: async (fx, timeouts) => {
      const c = await appClient();
      await c.query('BEGIN');
      if (timeouts) await withTimeouts(c);
      await consumeAccounting(c, fx);
      return c;
    },
    consume: consumeAccounting,
    runtimeRole: 'daftar_app',
    owner: () => Promise.resolve('daftar_accounting_internal'),
    proconfig: ['search_path=pg_catalog, public, pg_temp'],
    executors: [],
  },
  {
    name: 'provisioning',
    table: 'provisioning_assertion_uses',
    fn: 'provision_actor',
    lockKey: 'daftar.provisioning_assertion_uses',
    open: async (fx, timeouts) => {
      const c = await roleClient(provisionerDbUrl);
      await c.query('BEGIN');
      if (timeouts) await withTimeouts(c);
      await consumeProvisioning(c, fx);
      return c;
    },
    consume: consumeProvisioning,
    runtimeRole: 'daftar_provisioner',
    // Phase 3 corrective TD-18 (0070): no longer whoever applied the history,
    // and no longer a public-first path — the provisioning internal owner and
    // the pinned path, like the accounting registry.
    owner: () => Promise.resolve('daftar_provisioning_internal'),
    proconfig: ['search_path=pg_catalog, public, pg_temp'],
    executors: ['daftar_platform'],
  },
];

async function seedExpired(r: Registry, n: number): Promise<void> {
  await ownerPool().query(
    `INSERT INTO ${r.table} (jti, xact, used_at) SELECT gen_random_uuid(), pg_current_xact_id(), now() - interval '2 hours' FROM generate_series(1, $1::int)`,
    [n],
  );
}

async function expired(r: Registry): Promise<number> {
  return Number(
    must((await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${r.table} WHERE used_at < now() - interval '1 hour'`)).rows[0]).n,
  );
}

/** Whether backend `pid` holds this registry's hygiene advisory lock. */
async function holdsPruneLock(r: Registry, pid: number): Promise<boolean> {
  const q = await ownerPool().query(
    `SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND pid = $1 AND objsubid = 2
        AND classid::bigint = (hashtext($2)::bigint & 4294967295) AND objid::bigint = (hashtext('hygiene')::bigint & 4294967295)`,
    [pid, r.lockKey],
  );
  return q.rowCount === 1;
}

async function definition(r: Registry): Promise<string> {
  return must(
    (await ownerPool().query<{ d: string }>(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.proname = $1 AND p.pronargs = 1`, [r.fn])).rows[0],
  ).d;
}

/** The body 0061 replaced: the same function with the try-lock guard removed, a plain DELETE. */
function plainDeleteBody(def: string, r: Registry): string {
  const guarded = new RegExp(
    // TD-18 (0070) schema-qualifies the provisioning body's table and (review I2) its built-ins.
    `IF (?:pg_catalog\\.)?pg_try_advisory_xact_lock\\((?:pg_catalog\\.)?hashtext\\('${r.lockKey.replace('.', '\\.')}'\\), (?:pg_catalog\\.)?hashtext\\('hygiene'\\)\\) THEN\\s*(DELETE FROM (?:public\\.)?${r.table} WHERE [^;]+;)\\s*END IF;`,
  );
  const plain = def.replace(guarded, '$1');
  expect(plain, 'the installed body carries the guarded prune').not.toBe(def);
  expect(plain).not.toContain('pg_try_advisory_xact_lock');
  return plain;
}

async function closeRolledBack(c: Client): Promise<void> {
  await c.query('ROLLBACK');
  await c.end();
}

for (const r of REGISTRIES) {
  describe(`T-15 ${r.name}: ${r.fn} prunes ${r.table} without making a consumer wait`, () => {
    it('with expired uses present and one consumer left open, a consumer in another tenant commits without waiting', async () => {
      await seedExpired(r, 5);
      expect(await expired(r)).toBeGreaterThanOrEqual(5);

      const first = await r.open(one, false);
      try {
        expect(await holdsPruneLock(r, await pidOf(first)), 'connection 1 won the prune').toBe(true);
        const started = Date.now();
        const second = await r.open(two, true);
        try {
          expect(await holdsPruneLock(r, await pidOf(second)), 'connection 2 skipped it').toBe(false);
          await second.query('COMMIT');
        } finally {
          await second.end();
        }
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        await closeRolledBack(first);
      }
      expect(await expired(r), 'the prune of the rolled-back winner is undone; the skipper pruned nothing').toBeGreaterThanOrEqual(5);
    });

    it('the skipped hygiene is only deferred: a later consume prunes every expired use, never a live one', async () => {
      await seedExpired(r, 3);
      const liveBefore = Number(
        must((await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${r.table} WHERE used_at >= now() - interval '1 hour'`)).rows[0]).n,
      );
      expect(await expired(r)).toBeGreaterThanOrEqual(3);
      const c = await r.open(one, true);
      await c.query('COMMIT');
      await c.end();
      expect(await expired(r)).toBe(0);
      const liveAfter = Number(
        must((await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${r.table} WHERE used_at >= now() - interval '1 hour'`)).rows[0]).n,
      );
      expect(liveAfter, 'every live jti kept, plus the one just consumed').toBe(liveBefore + 1);
    });

    it('negative control: with the plain-DELETE body restored, the second consumer waits on the first and fails lock_timeout (55P03)', async () => {
      await seedExpired(r, 5);
      const installed = await definition(r);
      const plain = plainDeleteBody(installed, r);

      const first = await r.open(one, false);
      try {
        expect(await holdsPruneLock(r, await pidOf(first))).toBe(true);
        // Connection 2 is the owner: in its own transaction it restores the
        // plain body (visible to itself only), becomes the runtime role and
        // consumes — and now it must wait for connection 1's deleted rows.
        const second = await ownerClient();
        try {
          await second.query('BEGIN');
          await withTimeouts(second);
          await second.query(plain);
          await second.query(`SET LOCAL ROLE ${r.runtimeRole}`);
          const started = Date.now();
          refusedWith(await settle(() => r.consume(second, two)), '55P03', null, 'plain DELETE behind an open pruner');
          expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
        } finally {
          await closeRolledBack(second);
        }
      } finally {
        await closeRolledBack(first);
      }
      expect(await definition(r), 'the body swap was rolled back').toBe(installed);
    });

    it('the catalogue: owner, SECURITY DEFINER, proconfig and EXECUTE grants as 0061-E pins; the try-lock precedes the only DELETE', async () => {
      const row = must(
        (
          await ownerPool().query<{ owner: string; secdef: boolean; config: string[] | null; public_exec: boolean }>(
            `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                    coalesce(p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'), true) AS public_exec
               FROM pg_proc p WHERE p.proname = $1 AND p.pronargs = 1 AND p.proargtypes[0] = 'text[]'::regtype`,
            [r.fn],
          )
        ).rows[0],
      );
      expect(row).toEqual({ owner: await r.owner(), secdef: true, config: [...r.proconfig], public_exec: false });

      const executors: string[] = [];
      for (const { role } of RUNTIME_ROLES) {
        const q = await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `${r.fn}(text[])`]);
        if (must(q.rows[0]).ok) executors.push(role);
      }
      expect(executors, 'runtime roles that may call it directly').toEqual([...r.executors]);

      const def = await definition(r);
      expect(def.split('DELETE FROM').length - 1, 'exactly one DELETE').toBe(1);
      expect(def.indexOf('pg_try_advisory_xact_lock(')).toBeGreaterThan(-1);
      expect(def.indexOf('pg_try_advisory_xact_lock(')).toBeLessThan(def.indexOf('DELETE FROM'));

      const schemaCreate = await ownerPool().query<{ ok: boolean }>(`SELECT has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') AS ok`);
      expect(must(schemaCreate.rows[0]).ok, 'daftar_accounting_internal holds no CREATE on public').toBe(false);
    });
  });
}
