/**
 * PHASE 3 CORRECTIVE — TD-20, the default warehouse's name (the Tech Lead's
 * corrective directive §10; migration 0073 and the API's createBranch()).
 *
 * The defect: `provision_create_business` (0038) named every business's
 * default warehouse 'Main warehouse' whatever the business's locale (and a
 * business onboarded without one is 'ar'); createBranch() named each further
 * branch's default `<branch> — default warehouse`, English again — and, for a
 * branch name over 100 characters, a name over the column's 120, refused by
 * its CHECK as a 500.
 *
 * Pinned here, in ar, en and tr:
 *   1. onboarding names the default warehouse in the business's locale
 *      (ar 'المستودع الرئيسي', en 'Main warehouse', tr 'Ana depo');
 *   2. createBranch() names the branch's default `<branch> — <suffix>` in
 *      the business's locale (ar 'المستودع الافتراضي', en 'default
 *      warehouse', tr 'varsayılan depo'), cutting the branch name to the
 *      longest prefix with which the whole fits the column's 120 as the
 *      server counts (`char_length`: characters on UTF8, bytes on the
 *      SQL_ASCII test cluster), the suffix kept whole;
 *   3. isolation: the name follows the business the request is scoped to —
 *      a same-owner second business (A2) of another locale and a business of
 *      another tenant (B) — ALLOW and DENY;
 *   4. the upgrade: a database frozen at 0072 holding real pre-0073 rows is
 *      migrated by the non-superuser deployment principal; exactly the rows
 *      PROVABLY written by the system and never since (0073 §2 (a), (b)) are
 *      renamed into the business's locale (a branch default only when its
 *      localized name fits whole), every other row is untouched,
 *      row security is forced again, and a second run applies nothing;
 *   5. provision_create_business stays byte-for-byte 0038's (re-created, it
 *      would become a Phase 3 routine the P3-S8 definer law refuses: a login
 *      owner and a public-first path); the name is given as the onboarding
 *      row is inserted, by one BEFORE INSERT trigger on an INVOKER function
 *      with the pinned path that nobody may execute — and only on proof that
 *      the row is the onboarding default.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember, must, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { createScratchDb, migrationFiles, type ScratchDb } from '../helpers/scratch-db';
import { createTestApp, ensurePostgres, grantFeature, mintTestAssertion, ownerPool, raiseLimit, resetData, type TestApp } from '../helpers/test-app';

type Locale = 'ar' | 'en' | 'tr';
const LOCALES: readonly Locale[] = ['ar', 'en', 'tr'];

/** The onboarding default's name, per business locale. */
const MAIN: Readonly<Record<Locale, string>> = { ar: 'المستودع الرئيسي', en: 'Main warehouse', tr: 'Ana depo' };
/** The branch default's suffix, per business locale. */
const SUFFIX: Readonly<Record<Locale, string>> = { ar: 'المستودع الافتراضي', en: 'default warehouse', tr: 'varsayılan depo' };
const SEP = ' — ';

const chars = (s: string): number => [...s].length;

/** `char_length` as the server counts it (bytes on a SQL_ASCII server, characters on UTF8): the measure of `warehouses_name_check`. */
async function serverLength(text: string, q: Pick<Pool, 'query'> = ownerPool()): Promise<number> {
  return must((await q.query<{ n: number }>(`SELECT char_length($1::text)::int AS n`, [text])).rows[0]).n;
}

interface Warehouse {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly isDefault: boolean;
}

let t: TestApp;
let owner: HttpActor;
let stranger: HttpActor;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'TD-20 owner');
  stranger = await registerActor(t, 'TD-20 stranger');
}, 300_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

/** Onboard a business through the real API (a new tenant, or `inTenant`), with the business locale `locale` (none: the server's default). */
async function onboard(by: HttpActor, locale: Locale | undefined, inTenant?: string): Promise<{ tenantId: string; businessId: string }> {
  const r = await t.request
    .post(inTenant === undefined ? '/v1/onboarding/complete' : `/v1/tenants/${inTenant}/businesses`)
    .set('Idempotency-Key', `td20-${randomUUID()}`)
    .set('Authorization', `Bearer ${by.token}`)
    .send({
      businessName: `TD-20 ${locale ?? 'default'}`,
      countryCode: 'PS',
      baseCurrency: 'ILS',
      storeSlug: `td20-${randomUUID().slice(0, 12)}`,
      ...(locale === undefined ? {} : { preferredLocale: locale }),
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const businessId = String(r.body.businessId);
  const tenantId = inTenant ?? String(r.body.tenantId);
  await grantFeature(businessId, by.userId, 'MULTI_BRANCH');
  await raiseLimit(businessId, by.userId, 'MAX_BRANCHES', 10);
  return { tenantId, businessId };
}

async function warehouses(by: HttpActor, businessId: string): Promise<Warehouse[]> {
  const r = await t.request.get('/v1/businesses/current/warehouses').set(asMember(by, businessId));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { items: Warehouse[] }).items;
}

async function createBranch(by: HttpActor, businessId: string, name: string): Promise<{ status: number; id: string | null }> {
  const r = await t.request.post('/v1/businesses/current/branches').set(asMember(by, businessId)).send({ name });
  return { status: r.status, id: typeof r.body?.id === 'string' ? r.body.id : null };
}

/** The default warehouse of `branchId`, as the API lists it. */
async function defaultOf(by: HttpActor, businessId: string, branchId: string): Promise<Warehouse> {
  const all = (await warehouses(by, businessId)).filter((w) => w.isDefault && w.branchId === branchId);
  expect(all, `exactly one default warehouse on branch ${branchId}`).toHaveLength(1);
  return must(all[0]);
}

describe('TD-20 (1) onboarding names the default warehouse in the business locale', () => {
  it.each(LOCALES.map((l) => [l]))('%s', async (locale) => {
    const b = await onboard(owner, locale);
    const list = await warehouses(owner, b.businessId);
    expect(list.map((w) => ({ name: w.name, isDefault: w.isDefault }))).toEqual([{ name: MAIN[locale], isDefault: true }]);
  });

  it('a merchant’s own warehouse named "Main warehouse" keeps the merchant’s name, in an ar business', async () => {
    const b = await onboard(owner, 'ar');
    const home = must((await warehouses(owner, b.businessId))[0]);
    const r = await t.request
      .post('/v1/businesses/current/warehouses')
      .set(asMember(owner, b.businessId))
      .send({ name: 'Main warehouse', branchId: home.branchId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await warehouses(owner, b.businessId)).map((w) => [w.name, w.isDefault])).toEqual([
      [MAIN.ar, true],
      ['Main warehouse', false],
    ]);
  });

  it('a business onboarded without a locale is ar, and so is its default warehouse', async () => {
    const b = await onboard(owner, undefined);
    const loc = must((await ownerPool().query<{ l: string }>(`SELECT default_locale AS l FROM businesses WHERE id = $1`, [b.businessId])).rows[0]).l;
    expect(loc).toBe('ar');
    expect((await warehouses(owner, b.businessId)).map((w) => w.name)).toEqual([MAIN.ar]);
  });
});

describe('TD-20 (2) createBranch() names the branch default in the business locale', () => {
  it.each(LOCALES.map((l) => [l]))('%s: `<branch> — <suffix>`', async (locale) => {
    const b = await onboard(owner, locale);
    const br = await createBranch(owner, b.businessId, 'Doğu');
    expect(br.status).toBe(201);
    expect((await defaultOf(owner, b.businessId, must(br.id))).name).toBe(`Doğu${SEP}${SUFFIX[locale]}`);
  });

  it.each(LOCALES.map((l) => [l]))(
    '%s: a 120-character branch name is accepted; its default keeps the suffix whole and the LONGEST branch prefix that fits 120 as the server counts',
    async (locale) => {
      const b = await onboard(owner, locale);
      const long = 'x'.repeat(119) + 'y';
      expect(chars(long)).toBe(120);
      const br = await createBranch(owner, b.businessId, long);
      expect(br.status, 'the branch is created, not a 500').toBe(201);
      const name = (await defaultOf(owner, b.businessId, must(br.id))).name;
      const tail = `${SEP}${SUFFIX[locale]}`;
      expect(name.endsWith(tail), 'the suffix whole').toBe(true);
      const head = name.slice(0, name.length - tail.length);
      expect(long.startsWith(head) && head.length > 0, 'a prefix of the branch name').toBe(true);
      expect(await serverLength(name), 'fits the column').toBeLessThanOrEqual(120);
      expect(await serverLength(long.slice(0, head.length + 1) + tail), 'one more character would not').toBeGreaterThan(120);
    },
  );

  it('a trimmed branch name loses its trailing spaces before the separator', async () => {
    const b = await onboard(owner, 'tr');
    const tail = `${SEP}${SUFFIX.tr}`;
    const keep = 120 - (await serverLength(tail));
    const name = 'a'.repeat(keep - 1) + ' ' + 'z'.repeat(120 - keep);
    expect(chars(name)).toBe(120);
    const br = await createBranch(owner, b.businessId, name);
    expect(br.status).toBe(201);
    expect((await defaultOf(owner, b.businessId, must(br.id))).name).toBe('a'.repeat(keep - 1) + tail);
  });
});

describe('TD-20 (3) isolation: the name follows the business the request is scoped to', () => {
  it('same owner, same tenant: A (ar) and A2 (tr) each get their own locale; a branch of A2 is tr and A is untouched (ALLOW / DENY)', async () => {
    const a = await onboard(owner, 'ar');
    const a2 = await onboard(owner, 'tr', a.tenantId);
    const aBefore = await warehouses(owner, a.businessId);
    expect(aBefore.map((w) => w.name)).toEqual([MAIN.ar]);
    expect(
      (await warehouses(owner, a2.businessId)).map((w) => w.name),
      'ALLOW: the owner reads A2',
    ).toEqual([MAIN.tr]);

    const br = await createBranch(owner, a2.businessId, 'Batı');
    expect(br.status).toBe(201);
    expect((await defaultOf(owner, a2.businessId, must(br.id))).name).toBe(`Batı${SEP}${SUFFIX.tr}`);
    const aAfter = await warehouses(owner, a.businessId);
    expect(aAfter, 'DENY: nothing of A2 appears in A, and A is unchanged').toEqual(aBefore);
  });

  it('another tenant: B’s owner can neither list A’s warehouses nor create a branch in A (DENY); B’s own default is B’s locale (ALLOW)', async () => {
    const a = await onboard(owner, 'ar');
    const b = await onboard(stranger, 'en');
    const before = await warehouses(owner, a.businessId);
    const list = await t.request.get('/v1/businesses/current/warehouses').set(asMember(stranger, a.businessId));
    expect([403, 404]).toContain(list.status);
    const br = await createBranch(stranger, a.businessId, 'Intruder');
    expect([403, 404]).toContain(br.status);
    expect(await warehouses(owner, a.businessId)).toEqual(before);
    expect((await warehouses(stranger, b.businessId)).map((w) => w.name)).toEqual([MAIN.en]);
  });
});

// ── (4) the upgrade ─────────────────────────────────────────────────────────

const FROZEN = '0072_purchase_sub_unit_residue.sql';
const TD20 = '0073_default_warehouse_locale_name.sql';
const ROLE_PERMISSIONS = JSON.stringify({ owner: [] });

interface Row {
  readonly business: string;
  readonly id: string;
  readonly branch: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

async function rows(q: Pool): Promise<Row[]> {
  const r = await q.query<{ business: string; id: string; branch: string; name: string; is_default: boolean; created_at: string }>(
    `SELECT business_id::text AS business, id::text, branch_id::text AS branch, name, is_default, created_at::text FROM warehouses ORDER BY business_id, id`,
  );
  return r.rows.map((x) => ({ business: x.business, id: x.id, branch: x.branch, name: x.name, isDefault: x.is_default, createdAt: x.created_at }));
}

describe('TD-20 (4) the upgrade: 0073 renames exactly the provably system-written names, as the deployment principal', () => {
  let db: ScratchDb;
  let provisioner: Pool;
  let actor: string;

  /** A business through the REAL frozen routine (0038's body), as daftar_provisioner with a signed assertion. */
  async function provisioned(locale: Locale): Promise<{ businessId: string; branchId: string }> {
    const tenantId = randomUUID();
    const businessId = randomUUID();
    const c = await provisioner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [mintTestAssertion(actor, 'onboarding')]);
      await c.query(`SELECT provision_create_tenant($1)`, [tenantId]);
      await c.query('COMMIT');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [mintTestAssertion(actor, 'onboarding')]);
      await c.query(
        `SELECT provision_create_business($1, $2, $3, $4, 'PS', 'ILS', 'generic', $5, ARRAY[$5], 'Asia/Hebron', $6::jsonb, 'tenancy.business_created')`,
        [tenantId, businessId, `Upgrade ${locale}`, `td20-up-${randomUUID().slice(0, 12)}`, locale, ROLE_PERMISSIONS],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    const branchId = must(
      (await db.pool.query<{ id: string }>(`SELECT id::text FROM branches WHERE business_id = $1 AND is_default`, [businessId])).rows[0],
      'the default branch',
    ).id;
    return { businessId, branchId };
  }

  /** A branch and its default exactly as the pre-TD-20 createBranch() wrote them: one transaction, `<name> — default warehouse`. */
  async function oldBranch(
    businessId: string,
    name: string,
    warehouseName = `${name}${SEP}default warehouse`,
  ): Promise<{ branchId: string; warehouseId: string }> {
    const branchId = randomUUID();
    const warehouseId = randomUUID();
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO branches (business_id, id, name) VALUES ($1, $2, $3)`, [businessId, branchId, name]);
      await c.query(`INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ($1, $2, $3, $4, true)`, [
        businessId,
        warehouseId,
        branchId,
        warehouseName,
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return { branchId, warehouseId };
  }

  beforeAll(async () => {
    db = await createScratchDb('daftar_p3c_td20_upgrade', { upTo: FROZEN, migratorOwned: true });
    provisioner = db.poolAs('daftar_provisioner', 1);
    actor = must(
      (
        await db.pool.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, preferred_locale) VALUES ($1, 'x', 'TD-20 upgrade', 'en') RETURNING id::text`,
          [`td20-${randomUUID()}@test.daftar.local`],
        )
      ).rows[0],
    ).id;
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('renames the onboarding and branch defaults of ar and tr businesses, keeps en, merchant and unproven rows, forces RLS again; a second run applies nothing', async () => {
    const ar = await provisioned('ar');
    const tr = await provisioned('tr');
    const en = await provisioned('en');
    const arDogu = await oldBranch(ar.businessId, 'Doğu');
    // The longest ASCII branch name whose English default fits the column on either kind of server (the separator is 5 bytes).
    const arLong = await oldBranch(ar.businessId, 'q'.repeat(98));
    const arLongFits = (await serverLength(`${'q'.repeat(98)}${SEP}${SUFFIX.ar}`, db.pool)) <= 120;
    const trDogu = await oldBranch(tr.businessId, 'Doğu');
    const enDogu = await oldBranch(en.businessId, 'Doğu');
    // Not provable, so not renamed:
    //  - a merchant's own (non-default) warehouse that happens to be called 'Main warehouse';
    const merchant = randomUUID();
    await db.pool.query(`INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, $2, $3, 'Main warehouse')`, [
      ar.businessId,
      merchant,
      ar.branchId,
    ]);
    //  - a branch default whose name is not its own branch's system name;
    const foreign = await oldBranch(ar.businessId, 'Batı', `Doğu${SEP}default warehouse`);
    //  - a default 'Main warehouse' on a default branch created after its business (another transaction).
    const late = randomUUID();
    const lateBranch = randomUUID();
    await db.pool.query(
      `INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, default_locale, enabled_locales, timezone, storefront_locale)
       SELECT $1, tenant_id, 'Late', $2, 'PS', 'ILS', 'ar', ARRAY['ar'], 'Asia/Hebron', 'ar' FROM businesses WHERE id = $3`,
      [late, `td20-late-${randomUUID().slice(0, 8)}`, ar.businessId],
    );
    await db.pool.query(`INSERT INTO branches (business_id, id, name, is_default) VALUES ($1, $2, 'Main', true)`, [late, lateBranch]);
    const lateWarehouse = randomUUID();
    await db.pool.query(`INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ($1, $2, $3, 'Main warehouse', true)`, [
      late,
      lateWarehouse,
      lateBranch,
    ]);

    const before = await rows(db.pool);
    const applied = await db.migrateRest('daftar_migrator');
    expect(applied[0], 'the TD-20 migration applies, first after the frozen checkpoint').toBe(TD20);
    expect(applied).toEqual(migrationFiles().filter((f) => f > FROZEN));
    const after = await rows(db.pool);

    const nameOf = (id: string): string =>
      must(
        after.find((r) => r.id === id),
        id,
      ).name;
    const defaultOn = (businessId: string, branchId: string): string =>
      must(
        after.find((r) => r.business === businessId && r.branch === branchId && r.isDefault),
        `default of ${branchId}`,
      ).name;
    const expected = new Map<string, string>([
      [must(before.find((r) => r.business === ar.businessId && r.branch === ar.branchId && r.isDefault)).id, MAIN.ar],
      [must(before.find((r) => r.business === tr.businessId && r.branch === tr.branchId && r.isDefault)).id, MAIN.tr],
      [arDogu.warehouseId, `Doğu${SEP}${SUFFIX.ar}`],
      // Renamed only when the localized name fits WHOLE; the migration never cuts a branch name.
      [arLong.warehouseId, arLongFits ? `${'q'.repeat(98)}${SEP}${SUFFIX.ar}` : `${'q'.repeat(98)}${SEP}default warehouse`],
      [trDogu.warehouseId, `Doğu${SEP}${SUFFIX.tr}`],
    ]);
    // Every row keeps its identity, branch, default flag and creation time; only the expected names change.
    expect(after.map((r) => ({ ...r, name: undefined }))).toEqual(before.map((r) => ({ ...r, name: undefined })));
    for (const r of before) expect(nameOf(r.id), `${r.name} (${r.id})`).toBe(expected.get(r.id) ?? r.name);
    expect(await serverLength(nameOf(arLong.warehouseId), db.pool)).toBeLessThanOrEqual(120);
    // The kept ones, named.
    expect(defaultOn(en.businessId, en.branchId), 'en is already its locale').toBe('Main warehouse');
    expect(nameOf(enDogu.warehouseId)).toBe(`Doğu${SEP}default warehouse`);
    expect(nameOf(merchant), 'a merchant row').toBe('Main warehouse');
    expect(nameOf(foreign.warehouseId), 'not its branch’s system name').toBe(`Doğu${SEP}default warehouse`);
    expect(nameOf(lateWarehouse), 'not created with its business').toBe('Main warehouse');

    const force = await db.pool.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid IN ('businesses'::regclass, 'branches'::regclass, 'warehouses'::regclass) ORDER BY 1`,
    );
    expect(force.rows).toEqual([
      { relname: 'branches', rls: true, forced: true },
      { relname: 'businesses', rls: true, forced: true },
      { relname: 'warehouses', rls: true, forced: true },
    ]);
    expect(await db.migrateRest('daftar_migrator'), 'a second run applies nothing').toEqual([]);

    // And onboarding after the upgrade, through the replaced routine, is localized.
    const next = await provisioned('tr');
    const nextRows = (await rows(db.pool)).filter((r) => r.business === next.businessId);
    expect(nextRows.map((r) => ({ branch: r.branch, name: r.name, isDefault: r.isDefault }))).toEqual([
      { branch: next.branchId, name: MAIN.tr, isDefault: true },
    ]);
  });
});

// ── (5) the routine and the trigger ────────────────────────────────────────

describe('TD-20 (5) provision_create_business is untouched; the name is given by one narrow INVOKER trigger', () => {
  it('the routine keeps 0038’s body, owner, definer and grant (re-creating it would make it a Phase 3 routine the definer law refuses); only 0070 re-pins its path', async () => {
    const file = readFileSync(join(__dirname, '../../infrastructure/database/migrations/0038_provisioning_assertions.sql'), 'utf8');
    const start = file.indexOf('CREATE OR REPLACE FUNCTION provision_create_business(');
    expect(start).toBeGreaterThan(0);
    const bodyStart = file.indexOf('AS $$', start) + 'AS $$'.length;
    const frozen = file.slice(bodyStart, file.indexOf('$$;', bodyStart));
    expect(frozen, 'the frozen body writes the English literal; the trigger names the row').toContain(`v_branch_id, 'Main warehouse', true);`);
    const live = must(
      (
        await ownerPool().query<{ src: string; definer: boolean; owner: string; config: string[] | null; grantees: string[]; public_execute: boolean }>(
          `SELECT p.prosrc AS src, p.prosecdef AS definer, pg_get_userbyid(p.proowner)::text AS owner, p.proconfig AS config,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                  coalesce((SELECT array_agg(pg_get_userbyid(a.grantee)::text ORDER BY 1) FROM aclexplode(p.proacl) a
                             WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), ARRAY[]::text[]) AS grantees
             FROM pg_proc p
            WHERE p.oid = 'provision_create_business(uuid,uuid,text,text,text,text,text,text,text[],text,jsonb,text)'::regprocedure`,
        )
      ).rows[0],
    );
    expect(live).toEqual({
      src: frozen,
      definer: true,
      owner: 'daftar_platform',
      // 0038 said `public, pg_catalog`; 0070 (review I3) pins pg_temp last.
      config: ['search_path=pg_catalog, public, pg_temp'],
      grantees: ['daftar_provisioner'],
      public_execute: false,
    });
  });

  it('warehouses_default_name_locale: BEFORE INSERT, only for a default named "Main warehouse", on an INVOKER with the pinned path that nobody may execute', async () => {
    const r = must(
      (
        await ownerPool().query<{ def: string; enabled: string; definer: boolean; config: string[] | null; grantees: string[]; public_execute: boolean }>(
          `SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled::text AS enabled, p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                  coalesce((SELECT array_agg(pg_get_userbyid(a.grantee)::text ORDER BY 1) FROM aclexplode(p.proacl) a
                             WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), ARRAY[]::text[]) AS grantees
             FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = 'warehouses'::regclass AND t.tgname = 'warehouses_default_name_locale'`,
        )
      ).rows[0],
      'the trigger',
    );
    expect(r).toEqual({
      def: `CREATE TRIGGER warehouses_default_name_locale BEFORE INSERT ON public.warehouses FOR EACH ROW WHEN ((new.is_default AND (new.name = 'Main warehouse'::text))) EXECUTE FUNCTION warehouse_default_name_localize()`,
      enabled: 'O',
      definer: false,
      config: ['search_path=pg_catalog, public, pg_temp'],
      grantees: [],
      public_execute: false,
    });
  });

  it('a default row named "Main warehouse" that is not the onboarding default keeps its name (the proof, not the name, decides)', async () => {
    const b = await onboard(owner, 'ar');
    const branch = must(
      (await ownerPool().query<{ id: string }>(`SELECT id::text FROM branches WHERE business_id = $1 AND is_default`, [b.businessId])).rows[0],
    ).id;
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      // A second default on the default branch is refused by the one-default index, so drop the
      // flag of the onboarding default first; the branch and the business were NOT created now.
      await c.query(`UPDATE warehouses SET is_default = false WHERE business_id = $1 AND branch_id = $2`, [b.businessId, branch]);
      const id = randomUUID();
      await c.query(`INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ($1, $2, $3, 'Main warehouse', true)`, [
        b.businessId,
        id,
        branch,
      ]);
      const name = must((await c.query<{ name: string }>(`SELECT name FROM warehouses WHERE business_id = $1 AND id = $2`, [b.businessId, id])).rows[0]).name;
      expect(name).toBe('Main warehouse');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
