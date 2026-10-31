/**
 * P4-S1 — THE RED PROOF FOR THE PHASE 4 `role_permissions` ASSERTION
 * (P4-AL-37, and the `OD-P4-01` TECH LEAD RULING of 2026-09-30, OPTION A).
 *
 * P4-AL-37 says in terms that no accepted constraint binds a Phase 4
 * permission key: `0041:57-65` and `0057:140-151` are one-shot migration-time
 * `DO`-block assertions over their own hard-coded arrays, and
 * `role_permissions` carries no `CHECK`, no trigger and no exclusion
 * constraint. So "nothing today would stop a migration granting `sales.void`,
 * `refunds.approve` or `payments.reverse` to the cashier by default", and the
 * first Phase 4 permission migration must carry the sibling assertion "with a
 * red proof that plants `cashier -> sales.void` and requires the migration to
 * raise".
 *
 * This is that proof, and it runs in BOTH directions, because a green
 * assertion never shown able to say no proves nothing:
 *
 *   RED   plant `cashier -> sales.void` (the lock's own example), then
 *         `manager -> sales.discount`, then `<custom role> -> sales.void` —
 *         each must make the migration RAISE
 *         `phase4.permission_backfill_overreach`.
 *   GREEN a legitimate NON-SENSITIVE default already present on the cashier,
 *         and an ORDINARY Phase 4 key on a custom role — the same shape as the
 *         third red plant, differing only in the key's sensitivity — must both
 *         let the migration apply cleanly. That pair is what shows the
 *         assertion discriminates on SENSITIVITY and not merely on "a row it
 *         did not write itself".
 *   NOT VACUOUS the carrier must declare all twelve keys by name, and the
 *         backfill must actually write Phase 4 rows on a populated database.
 *         An assertion over an empty key array would pass every red plant
 *         above, so emptying it must turn this suite red rather than green.
 *
 * ── Where the assertion SQL comes from ────────────────────────────────────
 *
 * The carrier is resolved from disk, never pasted here: a permanent test that
 * carried its own copy of the SQL would go green while the migration drifted.
 * It is the one Phase 4 MIGRATION that carries the marker, and nothing else.
 *
 * This resolver had a second arm while P4-S1 was drafting — a specification
 * draft under `docs/drafts/` accepted as the carrier until the single migration
 * owner wrote the file. `0076` is that file, so the draft and the arm that
 * reached for it are both gone, in this commit, deliberately: a second copy of
 * applied DDL in the tree is a second truth, and a fallback that can reactivate
 * silently would let every test below go on passing while asserting something
 * about a file no deployment applies. More than one carrier, or none, is an
 * error rather than a choice.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';

const REPO = join(__dirname, '../..');
const MIGRATIONS_DIR = join(REPO, 'infrastructure/database/migrations');
/** The exception name the assertion raises. The sibling of `0057`'s own. */
const OVERREACH = 'phase4.permission_backfill_overreach';

/** P4-AL-36's twelve, with P4-AL-37's sensitivity. Copied from the lock, not read from the registry. */
const LOCK: readonly (readonly [key: string, sensitive: boolean])[] = [
  ['sales.view', false],
  ['sales.create', false],
  ['sales.void', true],
  ['sales.return', true],
  ['sales.discount', true],
  ['customers.view', false],
  ['customers.manage', false],
  ['payments.collect', false],
  ['payments.reverse', true],
  ['refunds.approve', true],
  ['receivables.view', false],
  ['installments.manage', true],
];
const PHASE4 = LOCK.map(([k]) => k);
const P4_SENSITIVE = LOCK.filter(([, s]) => s).map(([k]) => k);

interface Carrier {
  readonly path: string;
  readonly sql: string;
  readonly tense: 'migration';
}

/** The one MIGRATION that carries the assertion. There is no other carrier. */
function carrier(): Carrier {
  const hits = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ path: join(MIGRATIONS_DIR, f), sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }))
    .filter((c) => c.sql.includes(OVERREACH));
  if (hits.length > 1) {
    throw new Error(`more than one migration carries ${OVERREACH}: ${hits.map((h) => h.path).join(', ')} — there is one assertion, in one file`);
  }
  const only = hits[0];
  if (only === undefined) {
    throw new Error(`no migration carries ${OVERREACH} — the P4-AL-37 assertion has no carrier at all`);
  }
  return { ...only, tense: 'migration' };
}

const CARRIER = carrier();

/**
 * The carrier is a MIGRATION, stated as an assertion and not only as a
 * resolver's preference — so that losing the error code from `0076`, splitting
 * it, or renaming it is a red test rather than a silent change of subject.
 * It does not name the migration, so a later slice may move the assertion into
 * a different file without touching this suite.
 */
describe('the assertion is carried by an applied migration, not by the candidate draft', () => {
  it('a Phase 4 migration carries phase4.permission_backfill_overreach', () => {
    expect(CARRIER.tense, `the assertion resolved to ${CARRIER.path}`).toBe('migration');
    expect(CARRIER.path).toContain('infrastructure/database/migrations/');
  });
});

let db: ScratchDb;
let pool: Pool;
/** The fixture business, and its four role ids. */
const R: Record<'owner' | 'manager' | 'cashier' | 'custom', string> = { owner: '', manager: '', cashier: '', custom: '' };
let businessId = '';

/**
 * A business that PREDATES the twelve keys: owner, manager and cashier roles
 * whose persisted sets hold no Phase 4 key at all, plus one custom role. Built
 * on the platform principal, because `business_roles_protect_system` refuses a
 * system role to anyone `app_bypass()` is false for.
 */
async function plantLegacyBusiness(): Promise<void> {
  const plat = db.poolAs('daftar_platform');
  const currency = (await pool.query<{ code: string }>(`SELECT code FROM currencies ORDER BY code LIMIT 1`)).rows[0]?.code;
  expect(currency, 'the migrations seed at least one currency').toBeTruthy();
  const tenantId = (await plat.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id::text AS id`)).rows[0]?.id ?? '';
  businessId =
    (
      await plat.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, 'legacy', 'legacy-' || substr(md5(random()::text), 1, 12), 'JO', $2, 'Asia/Amman')
         RETURNING id::text AS id`,
        [tenantId, currency],
      )
    ).rows[0]?.id ?? '';
  const role = async (key: string, isSystem: boolean, perms: readonly string[]): Promise<string> => {
    const id =
      (
        await plat.query<{ id: string }>(`INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, $2, $2, $3) RETURNING id::text AS id`, [
          businessId,
          key,
          isSystem,
        ])
      ).rows[0]?.id ?? '';
    if (perms.length > 0) {
      await plat.query(`INSERT INTO role_permissions (business_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`, [businessId, id, perms]);
    }
    return id;
  };
  // The accepted pre-Phase-4 sets, in miniature: enough to show preservation,
  // not the whole registry, which this suite does not own.
  R.owner = await role('owner', true, ['business.view', 'accounting.post', 'inventory.adjust']);
  R.manager = await role('manager', false, ['business.view', 'inventory.view']);
  R.cashier = await role('cashier', false, ['catalog.view']);
  R.custom = await role('floor-lead', false, ['catalog.view']);
  for (const id of Object.values(R)) expect(id).toBeTruthy();
}

/** Run the carrier inside a transaction that is ALWAYS rolled back. */
async function attempt(plant: (c: PoolClient) => Promise<void>): Promise<{ ok: boolean; message: string; client: PoolClient }> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    await plant(c);
    await c.query(CARRIER.sql);
    return { ok: true, message: '', client: c };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), client: c };
  }
}

async function finish(c: PoolClient): Promise<void> {
  await c.query('ROLLBACK').catch(() => undefined);
  c.release();
}

const grant = (c: PoolClient, roleId: string, permission: string): Promise<unknown> =>
  c.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [businessId, roleId, permission]);

beforeAll(async () => {
  db = await createScratchDb('daftar_p4s1_backfill_assertion');
  pool = db.pool;
  await plantLegacyBusiness();
}, 600_000);

afterAll(async () => {
  if (db !== undefined) await db.drop();
});

describe('§0 the carrier', () => {
  it('exactly one file carries the P4-AL-37 assertion, and it declares all twelve keys by name', () => {
    expect(CARRIER.path).toBeTruthy();
    // NOT VACUOUS, part one: an assertion over a short key array is an
    // assertion that cannot fire for the keys it dropped.
    for (const key of PHASE4) expect(CARRIER.sql, `${CARRIER.path} must name ${key}`).toContain(`'${key}'`);
    // And it must name the exception it raises, so the red cases below can
    // distinguish it from any other failure.
    expect(CARRIER.sql).toContain(OVERREACH);
  });
});

describe('§1 GREEN — the assertion lets the legitimate state through', () => {
  it('applies cleanly to a business that predates the twelve keys, and writes Phase 4 rows', async () => {
    const a = await attempt(async () => undefined);
    try {
      expect(a.message).toBe('');
      expect(a.ok, 'the carrier must apply cleanly to a legitimate database').toBe(true);
      // NOT VACUOUS, part two: it actually wrote something. An assertion that
      // runs over zero Phase 4 rows says nothing.
      const n = await a.client.query<{ n: string }>(`SELECT count(*)::text AS n FROM role_permissions WHERE permission = ANY ($1)`, [PHASE4]);
      expect(Number(n.rows[0]?.n ?? 0)).toBeGreaterThan(0);
      // And the audit record exists for what it wrote — "audited" has to mean
      // the record is there (`OD-P4-01` OPTION A).
      const audited = await a.client.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE entity = 'role' AND action LIKE '%permission%'`);
      expect(Number(audited.rows[0]?.n ?? 0)).toBeGreaterThan(0);
    } finally {
      await finish(a.client);
    }
  });

  it('a legitimate NON-SENSITIVE cashier default already present is accepted, and re-application is a no-op', async () => {
    const a = await attempt(async (c) => {
      // The four ordinary till keys of `OD-P4-01` OPTION A, planted as if an
      // earlier run had already granted them.
      for (const key of ['sales.view', 'sales.create', 'customers.view', 'payments.collect']) await grant(c, R.cashier, key);
    });
    try {
      expect(a.message).toBe('');
      expect(a.ok).toBe(true);
      const rows = await a.client.query<{ p: string }>(
        `SELECT permission AS p FROM role_permissions WHERE business_id = $1 AND role_id = $2 AND permission = ANY ($3) ORDER BY 1`,
        [businessId, R.cashier, PHASE4],
      );
      expect(rows.rows.map((r) => r.p)).toEqual(['customers.view', 'payments.collect', 'sales.create', 'sales.view']);
      // Applied a second time inside the same transaction: still clean, and
      // nothing further written.
      await a.client.query(CARRIER.sql);
      const again = await a.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM role_permissions WHERE business_id = $1 AND role_id = $2 AND permission = ANY ($3)`,
        [businessId, R.cashier, PHASE4],
      );
      expect(Number(again.rows[0]?.n ?? 0)).toBe(4);
    } finally {
      await finish(a.client);
    }
  });

  it('an ORDINARY Phase 4 key on a custom role is accepted — the sensitivity-only control for §2', async () => {
    const a = await attempt(async (c) => grant(c, R.custom, 'receivables.view').then(() => undefined));
    try {
      expect(a.message).toBe('');
      expect(a.ok).toBe(true);
    } finally {
      await finish(a.client);
    }
  });
});

describe('§2 RED — the assertion says no', () => {
  it("plants the lock's own example, cashier -> sales.void, and the migration RAISES", async () => {
    const a = await attempt(async (c) => grant(c, R.cashier, 'sales.void').then(() => undefined));
    try {
      expect(a.ok, 'a sensitive Phase 4 key on the cashier must not be allowed to commit').toBe(false);
      expect(a.message).toContain(OVERREACH);
      expect(a.message).toContain('cashier:sales.void');
    } finally {
      await finish(a.client);
    }
  });

  it('plants manager -> sales.discount, the key OD-P4-01 OPTION B would have granted, and the migration RAISES', async () => {
    const a = await attempt(async (c) => grant(c, R.manager, 'sales.discount').then(() => undefined));
    try {
      expect(a.ok).toBe(false);
      expect(a.message).toContain(OVERREACH);
    } finally {
      await finish(a.client);
    }
  });

  it('plants a sensitive key on a CUSTOM role — same shape as the §1 control, and the migration RAISES', async () => {
    const a = await attempt(async (c) => grant(c, R.custom, 'sales.void').then(() => undefined));
    try {
      expect(a.ok, '"no non-owner role of any kind" includes a custom role').toBe(false);
      expect(a.message).toContain(OVERREACH);
    } finally {
      await finish(a.client);
    }
  });

  it('every one of the six sensitive keys is refused on the cashier, not just the one the lock names', async () => {
    for (const key of P4_SENSITIVE) {
      const a = await attempt(async (c) => grant(c, R.cashier, key).then(() => undefined));
      try {
        expect(a.ok, `cashier / ${key}`).toBe(false);
        expect(a.message, `cashier / ${key}`).toContain(OVERREACH);
      } finally {
        await finish(a.client);
      }
    }
  });

  it('the OWNER is the one exemption, and it is deliberate: the same key on the owner role is accepted', async () => {
    // `0041:57-65` and `0057:140-151` both exempt `is_system AND key='owner'`,
    // and owner authority is role IDENTITY rather than a row (`0041:19-22`).
    // Asserted here so that the exemption is a recorded decision rather than a
    // hole nobody noticed.
    const a = await attempt(async (c) => grant(c, R.owner, 'sales.void').then(() => undefined));
    try {
      expect(a.message).toBe('');
      expect(a.ok).toBe(true);
    } finally {
      await finish(a.client);
    }
  });
});
