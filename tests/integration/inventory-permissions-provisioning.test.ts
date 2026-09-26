import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_PERMISSIONS,
  PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  isSensitivePermission,
  type Permission,
} from '../../packages/domain-core/src/permissions';
import { normalizeIndustryProfileKey } from '../../packages/domain-core/src/industry-profiles';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  APP_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  PLATFORM_DB_PASSWORD,
  PROVISIONER_DB_PASSWORD,
  PROVISIONING_ASSERTION_KEY_B64,
  PROVISIONING_ASSERTION_KID,
  RECONCILER_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  applyBootstrap,
  createTestApp,
  dbUrl,
  ensurePostgres,
  mintTestAssertion,
  uniqueEmail,
  type TestApp,
} from '../helpers/test-app';

/**
 * P3-S1 — P3-AL-53: A BUSINESS CREATED AFTER THE MIGRATION GETS THE SAME
 * AUTHORITY AS ONE CREATED BEFORE IT. Independent adversarial suite (Agent F).
 *
 * The lock names two writers of role permissions — the 0057 backfill and the
 * frozen `provision_create_business` fed from `BUILTIN_ROLE_PERMISSIONS` — and
 * demands proof that they agree. The implementer's suite provisions a business
 * on the already-upgraded database and deletes its Phase 3 rows to imitate the
 * past. This suite builds the past for real instead, in ONE throwaway
 * database:
 *
 *   1. the database is migrated to 0056 — the schema the day before P3-S1;
 *   2. businesses are written by the FROZEN routine itself, called exactly as
 *      the pre-Phase-3 service called it (a minted provisioning assertion,
 *      `daftar_provisioner`, the RLS bypass) with the pre-Phase-3 registry —
 *      which is today's registry with the eleven keys removed and nothing else;
 *   3. merchants then edit their roles the way the accepted role API lets
 *      them: a trimmed manager, a widened cashier, deleted templates, a
 *      re-created `manager`, custom roles of every shape;
 *   4. the REAL upgrade runs (`runMigrations`, 0057 first);
 *   5. new businesses are provisioned in the SAME database through the
 *      accepted HTTP flows — first onboarding AND the second-business
 *      command, which are two entry points into the frozen writer;
 *   6. the five P3-AL-38 assertions are computed by this suite, independently
 *      of the migration's own SQL, over BOTH populations; then the fifth
 *      P3-AL-53 check compares them per system role key; then the sensitive
 *      delegation ceiling is exercised through all three delegation paths
 *      (assign, invite, create) in a backfilled AND a fresh business.
 */

// ── the lock, as data ──────────────────────────────────────────────────────

/** P3-AL-38's table: the eleven keys and their sensitivity, copied from the lock, not from the registry. */
const LOCK: readonly (readonly [string, 'ordinary' | 'sensitive'])[] = [
  ['inventory.view', 'ordinary'],
  ['inventory.adjust', 'sensitive'],
  ['inventory.transfer', 'sensitive'],
  ['inventory.stocktake', 'sensitive'],
  ['purchases.view', 'ordinary'],
  ['purchases.manage', 'sensitive'],
  ['purchases.receive', 'sensitive'],
  ['purchases.return', 'sensitive'],
  ['suppliers.view', 'ordinary'],
  ['suppliers.manage', 'sensitive'],
  ['suppliers.pay', 'sensitive'],
];
const PHASE3: readonly string[] = LOCK.map(([k]) => k);
const VIEWS = ['inventory.view', 'purchases.view', 'suppliers.view'];

/** The Manager's accepted Phase 1 set (permissions.ts:98–116 at the pre-P3 head), in its accepted order. */
const MANAGER_PHASE1: readonly string[] = [
  'business.view',
  'branch.view',
  'branch.manage',
  'warehouse.view',
  'warehouse.manage',
  'member.view',
  'member.invite',
  'role.view',
  'role.assign',
  'catalog.view',
  'catalog.create',
  'catalog.update',
  'catalog.archive',
  'category.manage',
  'media.manage',
  'settings.view',
  'subscription.view',
];

const isPhase3 = (p: string): boolean => PHASE3.includes(p);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/**
 * The registry a pre-Phase-3 deployment passed to the frozen writer. Derived
 * from TODAY's registry by removing exactly the eleven keys, and asserted
 * below to equal the pre-P3 literal, so the reconstruction is itself checked.
 */
const PRE_P3_REGISTRY: Record<string, readonly string[]> = {
  owner: PERMISSIONS.filter((p) => !isPhase3(p)),
  manager: BUILTIN_ROLE_PERMISSIONS.manager.filter((p) => !isPhase3(p)),
  cashier: BUILTIN_ROLE_PERMISSIONS.cashier.filter((p) => !isPhase3(p)),
};

describe('P3-AL-53 — the registry evolved in the same shape the lock fixes', () => {
  it('the closed registry holds exactly the eleven Phase 3 keys under the three Phase 3 prefixes', () => {
    const underPrefixes = PERMISSIONS.filter((p) => /^(inventory|purchases|suppliers)\./.test(p));
    expect(sorted(underPrefixes)).toEqual(sorted(PHASE3));
  });

  it('the sensitivity column matches the lock row by row — three ordinary views, eight sensitive', () => {
    for (const [key, level] of LOCK) {
      expect(isSensitivePermission(key as Permission), key).toBe(level === 'sensitive');
    }
    expect(sorted(SENSITIVE_PERMISSIONS.filter(isPhase3))).toEqual(sorted(LOCK.filter(([, l]) => l === 'sensitive').map(([k]) => k)));
  });

  it('owner is the whole registry; manager is the accepted Phase 1 list, unaltered and in order, with the three views APPENDED; cashier is untouched', () => {
    expect(BUILTIN_ROLE_PERMISSIONS.owner).toBe(PERMISSIONS);
    expect([...BUILTIN_ROLE_PERMISSIONS.manager]).toEqual([...MANAGER_PHASE1, ...VIEWS]);
    expect([...BUILTIN_ROLE_PERMISSIONS.cashier]).toEqual(['catalog.view']);
    expect(PRE_P3_REGISTRY['manager']).toEqual(MANAGER_PHASE1);
    expect(PRE_P3_REGISTRY['cashier']).toEqual(['catalog.view']);
  });
});

// ── the throwaway database ─────────────────────────────────────────────────

const SCRATCH = 'daftar_p3s1_adv_perms';
const at = (user: string, password: string): string => `postgresql://${user}:${password}@localhost:${PG_PORT}/${SCRATCH}`;
const scratchSuper = at(PG_USER, PG_PASSWORD);
/** Every runtime pool of the application, pointed at the throwaway database. */
const SCRATCH_APP = {
  APP_DATABASE_URL: at('daftar_app', APP_DB_PASSWORD),
  PLATFORM_DATABASE_URL: at('daftar_platform', PLATFORM_DB_PASSWORD),
  IDENTITY_DATABASE_URL: at('daftar_identity', IDENTITY_DB_PASSWORD),
  RESOLVER_DATABASE_URL: at('daftar_resolver', RESOLVER_DB_PASSWORD),
  WORKER_DATABASE_URL: at('daftar_worker', WORKER_DB_PASSWORD),
  PROVISIONER_DATABASE_URL: at('daftar_provisioner', PROVISIONER_DB_PASSWORD),
  RECONCILER_DATABASE_URL: at('daftar_reconciler', RECONCILER_DB_PASSWORD),
};

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-adv-perms-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql') && x <= upTo)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

interface Actor {
  token: string;
  userId: string;
  email: string;
}

const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

async function register(t: TestApp, displayName: string): Promise<Actor> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'en' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  expect(me.status).toBe(200);
  return { token, userId: me.body.userId as string, email: me.body.email as string };
}

describe('P3-AL-53 — a backfilled population and a freshly provisioned one, in ONE upgraded database', () => {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  admin.on('error', () => undefined);
  let pool: Pool;
  const apps: TestApp[] = [];

  /** Business ids by label. B* were written before 0057 by the frozen routine; F* after it, through HTTP. */
  const biz: Record<string, string> = {};
  const tenantOf: Record<string, string> = {};
  const ownerOf: Record<string, Actor> = {};
  /** Every role's whole permission set, keyed `label/roleKey`, as it stood BEFORE the upgrade. */
  let before: Map<string, string[]>;

  async function app(): Promise<TestApp> {
    const t = await createTestApp({ configOverrides: SCRATCH_APP });
    apps.push(t);
    return t;
  }

  async function roleSets(): Promise<Map<string, string[]>> {
    const rows = (
      await pool.query<{ business_id: string; key: string; perms: string[] }>(
        `SELECT r.business_id::text, r.key, coalesce(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS perms
           FROM business_roles r LEFT JOIN role_permissions rp ON rp.business_id = r.business_id AND rp.role_id = r.id
          GROUP BY r.business_id, r.key`,
      )
    ).rows;
    const label = new Map(Object.entries(biz).map(([k, v]) => [v, k]));
    return new Map(rows.map((r) => [`${label.get(r.business_id) ?? r.business_id}/${r.key}`, r.perms]));
  }

  const perms = async (label: string, key: string): Promise<string[] | undefined> => (await roleSets()).get(`${label}/${key}`);

  /**
   * The frozen writer, called the way the pre-Phase-3 service called it: on
   * the provisioner principal, with a minted assertion and the RLS bypass —
   * only the registry argument is the pre-Phase-3 one.
   */
  async function provisionBeforeP3(label: string, owner: Actor): Promise<void> {
    const c = new Client({ connectionString: SCRATCH_APP.PROVISIONER_DATABASE_URL });
    await c.connect();
    const tenantId = randomUUID();
    const businessId = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true), set_config('app.bypass_rls', 'true', true)`, [
        mintTestAssertion(owner.userId, 'onboarding'),
      ]);
      await c.query('SELECT provision_create_tenant($1)', [tenantId]);
      await c.query(`SELECT provision_create_business($1,$2,$3,$4,'PS','ILS',$6,'en',ARRAY['en'],'Asia/Hebron',$5,'tenancy.onboarding_completed')`, [
        tenantId,
        businessId,
        `Before ${label}`,
        `adv-pre-${label.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        JSON.stringify(PRE_P3_REGISTRY),
        normalizeIndustryProfileKey(undefined),
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      await c.end();
    }
    biz[label] = businessId;
    tenantOf[label] = tenantId;
    ownerOf[label] = owner;
  }

  /** A merchant's own role edit, as the accepted role API performs it (custom-role rows are ordinary rows). */
  async function customRole(label: string, key: string, permissions: readonly string[]): Promise<void> {
    const id = randomUUID();
    await pool.query(`INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES ($1, $2, $3, $3, false)`, [biz[label], id, key]);
    for (const p of permissions) await pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)`, [biz[label], id, p]);
  }

  const entitled = new Set<string>();
  async function entitle(label: string): Promise<void> {
    if (entitled.has(label)) return;
    entitled.add(label);
    await pool.query(
      `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, reason, actor_user_id) VALUES ($1, 'CUSTOM_ROLES', true, 'test-fixture', $2)`,
      [biz[label], ownerOf[label]?.userId],
    );
    await pool.query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id) VALUES ($1, 'MAX_USERS', 50, 'test-fixture', $2)`,
      [biz[label], ownerOf[label]?.userId],
    );
  }

  beforeAll(async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    await applyBootstrap(SCRATCH);
    const pre = migrationsUpTo('0056_inventory_branch_warehouses.sql');
    try {
      await runMigrations(scratchSuper, pre);
    } finally {
      rmSync(pre, { recursive: true, force: true });
    }
    pool = new Pool({ connectionString: scratchSuper, max: 2 });
    pool.on('error', () => undefined);
    await pool.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [PROVISIONING_ASSERTION_KID, PROVISIONING_ASSERTION_KEY_B64]);
    await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

    // Identities of the pre-P3 world (registration touches identity tables only).
    const t0 = await app();
    const owners = [await register(t0, 'Owner B1'), await register(t0, 'Owner B2'), await register(t0, 'Owner B3'), await register(t0, 'Owner B4')];
    await t0.close();

    // The pre-Phase-3 population, written by the frozen routine.
    for (const [i, label] of ['B1', 'B2', 'B3', 'B4'].entries()) await provisionBeforeP3(label, owners[i] as Actor);
    // B1 is left exactly as provisioned. B2–B4 carry every merchant edit the role API allows.
    const roleId = async (label: string, key: string): Promise<string> =>
      (await pool.query<{ id: string }>(`SELECT id FROM business_roles WHERE business_id = $1 AND key = $2`, [biz[label], key])).rows[0]?.id ?? '';
    // B2: a trimmed-and-widened manager, a widened cashier, custom roles of every shape.
    await pool.query(`DELETE FROM role_permissions WHERE business_id = $1 AND role_id = $2 AND permission IN ('catalog.archive', 'member.invite')`, [
      biz['B2'],
      await roleId('B2', 'manager'),
    ]);
    await pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'member.manage')`, [
      biz['B2'],
      await roleId('B2', 'manager'),
    ]);
    await pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'catalog.update')`, [
      biz['B2'],
      await roleId('B2', 'cashier'),
    ]);
    await customRole('B2', 'clerk', ['catalog.view', 'catalog.update']);
    await customRole('B2', 'empty-role', []);
    await customRole('B2', 'bookkeeper', ['accounting.view', 'accounting.post', 'accounting.reverse']);
    await customRole('B2', 'store-manager', [...MANAGER_PHASE1]);
    await customRole('B2', 'inventory', ['warehouse.view', 'warehouse.manage']);
    // B3: both templates deleted — no role keyed manager or cashier exists.
    await pool.query(`DELETE FROM business_roles WHERE business_id = $1 AND key IN ('manager', 'cashier')`, [biz['B3']]);
    await customRole('B3', 'supervisor', [...MANAGER_PHASE1]);
    // B4: the manager template deleted and a custom role keyed `manager` created in its place.
    await pool.query(`DELETE FROM business_roles WHERE business_id = $1 AND key = 'manager'`, [biz['B4']]);
    await customRole('B4', 'manager', ['catalog.view', 'branch.view']);

    before = await roleSets();
    expect([...before.values()].flat().filter(isPhase3), 'the pre-Phase-3 world holds no Phase 3 key anywhere — the reconstruction is honest').toEqual([]);

    // THE UPGRADE: exactly as a deployment applies it.
    const applied = await runMigrations(scratchSuper);
    expect(applied[0]).toBe('0057_inventory_permissions.sql');
    await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);

    // The post-migration population, through the accepted HTTP flows.
    const t1 = await app();
    const f = await register(t1, 'Owner F1');
    const on = await t1.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `adv-perms-${randomUUID()}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ businessName: 'After F1', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `adv-post-f1-${randomUUID().slice(0, 8)}`, preferredLocale: 'en' });
    expect(on.status).toBe(201);
    biz['F1'] = on.body.businessId as string;
    tenantOf['F1'] = on.body.tenantId as string;
    ownerOf['F1'] = f;
    // The second writer entry point: an additional business in the same tenant.
    const second = await t1.request
      .post(`/v1/tenants/${tenantOf['F1']}/businesses`)
      .set('Idempotency-Key', `adv-perms-${randomUUID()}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ businessName: 'After F2', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `adv-post-f2-${randomUUID().slice(0, 8)}`, preferredLocale: 'en' });
    expect(second.status).toBe(201);
    biz['F2'] = second.body.businessId as string;
    tenantOf['F2'] = tenantOf['F1'];
    ownerOf['F2'] = f;
    await t1.close();
  }, 120_000);

  afterEach(async () => {
    for (const t of apps.splice(0)) await t.close();
  });

  afterAll(async () => {
    for (const t of apps.splice(0)) await t.close();
    await pool?.end();
    // A closed pool has only SENT its terminate messages; wait for those
    // backends to leave before the drop, or FORCE would kill a client that is
    // still ending and surface as an uncaught 57P01 in this process.
    for (let i = 0; i < 100; i += 1) {
      const n = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [SCRATCH])).rows[0]?.n ?? 0;
      if (n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
  });

  const BACKFILLED = ['B1', 'B2', 'B3', 'B4'];
  const FRESH = ['F1', 'F2'];
  const ALL = [...BACKFILLED, ...FRESH];

  it('both writers mark only the owner as a system role, so every assertion below identifies manager and cashier by key', async () => {
    for (const label of ['B1', 'F1', 'F2']) {
      const r = await pool.query(`SELECT key, is_system FROM business_roles WHERE business_id = $1 AND key IN ('owner', 'manager', 'cashier') ORDER BY key`, [
        biz[label],
      ]);
      expect(r.rows, label).toEqual([
        { key: 'cashier', is_system: false },
        { key: 'manager', is_system: false },
        { key: 'owner', is_system: true },
      ]);
    }
  });

  it('assertion 1 — completeness: the owner of EVERY business, backfilled and fresh, holds all eleven', async () => {
    const sets = await roleSets();
    for (const label of ALL) {
      const owner = sets.get(`${label}/owner`) ?? [];
      expect(
        PHASE3.filter((p) => !owner.includes(p)),
        `${label}: missing`,
      ).toEqual([]);
    }
  });

  it('…and the owner of a backfilled business kept every accepted permission it held before, gaining the eleven and nothing else', async () => {
    const sets = await roleSets();
    for (const label of BACKFILLED) {
      expect(sets.get(`${label}/owner`), label).toEqual(sorted([...(before.get(`${label}/owner`) ?? []), ...PHASE3]));
    }
  });

  it('assertion 2 — manager exactness: every role keyed `manager`, in both populations, holds exactly the three view keys of Phase 3', async () => {
    const sets = await roleSets();
    const managers = [...sets.entries()].filter(([k]) => k.endsWith('/manager'));
    expect(managers.map(([k]) => k.split('/')[0]).sort()).toEqual(['B1', 'B2', 'B4', 'F1', 'F2']);
    for (const [k, set] of managers) expect(set.filter(isPhase3), k).toEqual(sorted(VIEWS));
  });

  it('…a business with NO manager role gets no substitute: nothing in it but its owner gained a Phase 3 key', async () => {
    const sets = await roleSets();
    const gained = [...sets.entries()].filter(([k, set]) => k.startsWith('B3/') && k !== 'B3/owner' && set.some(isPhase3));
    expect(gained).toEqual([]);
  });

  it('assertion 3 — no sensitive leak: no non-owner role of any kind, anywhere, holds a sensitive Phase 3 key (read from the registry sensitivity, not a list)', async () => {
    const sensitive = PHASE3.filter((p) => isSensitivePermission(p as Permission));
    expect(sensitive).toHaveLength(8);
    const leaks = (
      await pool.query<{ business_id: string; key: string; permission: string }>(
        `SELECT r.business_id::text, r.key, rp.permission FROM role_permissions rp
           JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
          WHERE NOT (r.is_system AND r.key = 'owner') AND rp.permission = ANY ($1::text[])`,
        [sensitive],
      )
    ).rows;
    expect(leaks).toEqual([]);
  });

  it('assertion 4 — custom roles unchanged: every non-template role of every backfilled business is byte-identical, including one named like a manager', async () => {
    const sets = await roleSets();
    const custom = [...before.keys()].filter((k) => !/\/(owner|manager|cashier)$/.test(k));
    expect(custom.sort()).toEqual(['B2/bookkeeper', 'B2/clerk', 'B2/empty-role', 'B2/inventory', 'B2/store-manager', 'B3/supervisor']);
    for (const k of custom) expect(sets.get(k), k).toEqual(before.get(k));
  });

  it('…and the cashier, edited or not, is byte-identical too', async () => {
    const sets = await roleSets();
    for (const label of ['B1', 'B2', 'B4']) expect(sets.get(`${label}/cashier`), label).toEqual(before.get(`${label}/cashier`));
    expect(sets.get('B2/cashier')).toEqual(['catalog.update', 'catalog.view']);
  });

  it('assertion 5 — manager preservation: each manager’s non-Phase-3 set is byte-identical, a merchant-trimmed one is NOT restored to the template', async () => {
    const sets = await roleSets();
    for (const label of ['B1', 'B2', 'B4']) {
      expect(
        (sets.get(`${label}/manager`) ?? []).filter((p) => !isPhase3(p)),
        label,
      ).toEqual(before.get(`${label}/manager`));
    }
    const b2 = sets.get('B2/manager') ?? [];
    expect(b2).toContain('member.manage');
    expect(b2).not.toContain('catalog.archive');
    expect(b2).not.toContain('member.invite');
    expect(sets.get('B1/manager')).toEqual(sorted([...MANAGER_PHASE1, ...VIEWS]));
  });

  it('…and a custom role keyed `manager` in place of the deleted template receives only the three views (the accepted Agent 0 ruling), no sensitive key', async () => {
    expect(await perms('B4', 'manager')).toEqual(sorted(['catalog.view', 'branch.view', ...VIEWS]));
  });

  it('P3-AL-53 fifth check — for every system role key, a backfilled business and BOTH freshly provisioned ones hold the same Phase 3 set', async () => {
    const sets = await roleSets();
    for (const key of ['owner', 'manager', 'cashier']) {
      const b1 = (sets.get(`B1/${key}`) ?? ['<absent>']).filter(isPhase3);
      expect((sets.get(`F1/${key}`) ?? ['<absent>']).filter(isPhase3), `F1/${key}`).toEqual(b1);
      expect((sets.get(`F2/${key}`) ?? ['<absent>']).filter(isPhase3), `F2/${key}`).toEqual(b1);
    }
  });

  it('…stronger: an UNEDITED backfilled business is indistinguishable from a fresh one — whole sets, role key by role key, and the same role keys', async () => {
    const sets = await roleSets();
    const keysOf = (label: string): string[] =>
      [...sets.keys()]
        .filter((k) => k.startsWith(`${label}/`))
        .map((k) => k.slice(label.length + 1))
        .sort();
    expect(keysOf('B1')).toEqual(['cashier', 'manager', 'owner']);
    for (const label of FRESH) {
      expect(keysOf(label), label).toEqual(keysOf('B1'));
      for (const key of keysOf('B1')) expect(sets.get(`${label}/${key}`), `${label}/${key}`).toEqual(sets.get(`B1/${key}`));
    }
    expect(sets.get('F1/owner')).toEqual(sorted(PERMISSIONS));
  });

  it('a custom role created after the migration gets no automatic Phase 3 authority — the persisted set is exactly what was asked', async () => {
    await entitle('F1');
    const t = await app();
    const owner = ownerOf['F1'] as Actor;
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(hdr(owner, biz['F1'] ?? ''))
      .send({ key: 'late-clerk', name: 'Late clerk', permissions: ['catalog.view'] });
    expect(res.status).toBe(201);
    expect(await perms('F1', 'late-clerk')).toEqual(['catalog.view']);
    const empty = await t.request
      .post('/v1/businesses/current/roles')
      .set(hdr(owner, biz['F1'] ?? ''))
      .send({ key: 'late-empty', name: 'Late empty', permissions: [] });
    expect(empty.status).toBe(201);
    expect(await perms('F1', 'late-empty')).toEqual([]);
  });

  /**
   * The sensitive delegation ceiling is unchanged in BOTH populations. The
   * manager's persisted rows are what the ceiling reads, so this is also the
   * runtime proof that the backfilled and the fresh manager rows are live:
   * the views are delegable because the manager now holds them, the
   * sensitive keys are not because it does not.
   */
  describe.each(['B1', 'F1'])('the sensitive delegation ceiling in %s', (label) => {
    let t: TestApp;
    let owner: Actor;
    let manager: Actor;
    let target: Actor;
    let roleAdmin: Actor;
    const B = (): string => biz[label] ?? '';

    beforeAll(async () => {
      await entitle(label);
      t = await createTestApp({ configOverrides: SCRATCH_APP });
      owner = ownerOf[label] as Actor;
      manager = await register(t, `Manager ${label}`);
      target = await register(t, `Target ${label}`);
      roleAdmin = await register(t, `Role admin ${label}`);
      for (const [key, name, permissions] of [
        ['adjuster', 'Adjuster', ['inventory.adjust']],
        ['buyer', 'Buyer', ['purchases.view', 'purchases.manage']],
        ['stock-viewer', 'Stock viewer', [...VIEWS]],
        ['role-admin', 'Role admin', ['role.view', 'role.create', 'inventory.view']],
      ] as const) {
        const r = await t.request
          .post('/v1/businesses/current/roles')
          .set(hdr(owner, B()))
          .send({ key, name, permissions: [...permissions] });
        expect(r.status, `owner creates ${key} — the owner is exempt`).toBe(201);
      }
      for (const [who, roleKey] of [
        [manager, 'manager'],
        [target, 'cashier'],
        [roleAdmin, 'role-admin'],
      ] as const) {
        expect((await t.request.post('/v1/businesses/current/members').set(hdr(owner, B())).send({ email: who.email, roleKey })).status).toBe(201);
      }
    }, 60_000);

    afterAll(async () => {
      await t?.close();
    });

    const targetRoles = async (): Promise<string[]> =>
      (
        await pool.query<{ key: string }>(
          `SELECT r.key FROM membership_roles mr JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
            WHERE mr.business_id = $1 AND mr.user_id = $2 ORDER BY r.key`,
          [B(), target.userId],
        )
      ).rows.map((r) => r.key);

    it('the manager cannot ASSIGN a role carrying a sensitive Phase 3 key — refused, naming the key, nothing changed', async () => {
      for (const [roleKey, beyond] of [
        ['adjuster', 'inventory.adjust'],
        ['buyer', 'purchases.manage'],
      ] as const) {
        const res = await t.request
          .patch(`/v1/businesses/current/members/${target.userId}/roles`)
          .set(hdr(manager, B()))
          .send({ roleKeys: [roleKey] });
        expect(res.status, roleKey).toBe(403);
        expect(JSON.stringify(res.body)).toContain(`Delegation ceiling exceeded: ${beyond}`);
        expect(JSON.stringify(res.body)).not.toContain('purchases.view');
        expect(await targetRoles()).toEqual(['cashier']);
      }
    });

    it('…but CAN assign the three view keys, because its own persisted rows now hold them', async () => {
      const res = await t.request
        .patch(`/v1/businesses/current/members/${target.userId}/roles`)
        .set(hdr(manager, B()))
        .send({ roleKeys: ['stock-viewer'] });
      expect(res.status).toBe(200);
      expect(await targetRoles()).toEqual(['stock-viewer']);
    });

    it('the manager cannot INVITE into a sensitive role, and can invite into the view role', async () => {
      const refused = await t.request.post('/v1/businesses/current/invitations').set(hdr(manager, B())).send({ email: uniqueEmail(), roleKey: 'adjuster' });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toContain('Delegation ceiling exceeded: inventory.adjust');
      const allowed = await t.request.post('/v1/businesses/current/invitations').set(hdr(manager, B())).send({ email: uniqueEmail(), roleKey: 'stock-viewer' });
      expect(allowed.status).toBe(201);
    });

    it('a non-owner role creator holding inventory.view cannot CREATE a role with a sensitive Phase 3 key; with the view key it can', async () => {
      for (const p of PHASE3.filter((x) => isSensitivePermission(x as Permission))) {
        const res = await t.request
          .post('/v1/businesses/current/roles')
          .set(hdr(roleAdmin, B()))
          .send({ key: `try-${p.replace('.', '-')}`, name: 'Try', permissions: ['inventory.view', p] });
        expect(res.status, p).toBe(403);
        expect(JSON.stringify(res.body)).toContain(`Delegation ceiling exceeded: ${p}`);
      }
      expect(
        (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM business_roles WHERE business_id = $1 AND key LIKE 'try-%'`, [B()])).rows[0]?.n,
      ).toBe(0);
      const ok = await t.request
        .post('/v1/businesses/current/roles')
        .set(hdr(roleAdmin, B()))
        .send({ key: 'view-only', name: 'View only', permissions: ['inventory.view'] });
      expect(ok.status).toBe(201);
      expect(await perms(label, 'view-only')).toEqual(['inventory.view']);
    });

    it('the manager holding the views does not thereby reach the sensitive command: PUT configuration is refused', async () => {
      const res = await t.request
        .put(`/v1/inventory/products/${randomUUID()}/configuration`)
        .set(hdr(manager, B()))
        .send({ trackInventory: true, unitCode: 'piece' });
      expect(res.status).toBe(403);
    });
  });
});
