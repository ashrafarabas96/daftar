/**
 * PHASE 3 CORRECTIVE — TD-18: THE FOUR APPLIER-OWNED SECURITY DEFINER
 * ROUTINES (directive §6; migration 0070).
 *
 * Before 0070 `catalog_identifiers_sync()`, `provision_actor(text[])`,
 * `provision_assertion_key_install(text, bytea)` and
 * `provision_assertion_key_retire(text)` were owned by whoever applied the
 * history (a superuser here, `daftar_migrator` in production) and searched
 * `public` before `pg_catalog`. After it each is owned by a NOLOGIN internal
 * principal and pins `search_path = pg_catalog, public, pg_temp`.
 *
 * The suite proves, on the shared (superuser-built) database:
 *   - the model: owner, DEFINER, path, ACL, the two owners' shape, and that
 *     the applier owns no SECURITY DEFINER routine any more;
 *   - public-schema shadowing: a function (or operator) planted in `public`
 *     under a catalogue name is NOT what the routine calls;
 *   - temp-schema shadowing: a planted temporary registry is not read;
 *   - wrong owner and PUBLIC EXECUTE are named by the checks (negative
 *     controls, rolled back);
 *   - forbidden direct invocation by every runtime principal but the
 *     platform, and the platform's required invocation;
 *   - the flows that run through the four: catalogue create/update with the
 *     registry (tenant and same-owner second-business ALLOW and DENY),
 *     onboarding and second-business onboarding, key install and retire.
 *
 * The deployer-built database is proved by `npm run check:deployment-authority`
 * (10b, both builds) and `npm run rehearse:phase3:deployed` (7.3, 7.4), which
 * read the same pinned model (`TD18_DEFINER_OWNERS`).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintProvisioningAssertion } from '../../apps/api/src/infra/provisioning-assertion';
import {
  APPLIER_OWNED_DEFINERS,
  APPLIER_OWNED_DEFINERS_QUERY,
  applierOwnedDefinerProblems,
  DEFINER_PATHS_QUERY,
  definerPathProblems,
  type DefinerPathRow,
  TD18_DEFINER_OWNERS,
  TD18_DEFINER_OWNERS_QUERY,
  td18DefinerProblems,
  type Td18DefinerRow,
} from '../../scripts/phase2-deployment-authority';
import {
  appDbUrl,
  createTestApp,
  dbUrl,
  ensurePostgres,
  identityDbUrl,
  mintTestAssertion,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  reconcilerDbUrl,
  resetData,
  resolverDbUrl,
  uniqueEmail,
  workerDbUrl,
  type TestApp,
} from '../helpers/test-app';
import { createScratchDb, migrationFiles } from '../helpers/scratch-db';

const PINNED = 'search_path=pg_catalog, public, pg_temp';
const CATALOG = 'daftar_catalog_internal';
const PROVISIONING = 'daftar_provisioning_internal';
const FOUR = ['catalog_identifiers_sync()', 'provision_actor(text[])', 'provision_assertion_key_install(text,bytea)', 'provision_assertion_key_retire(text)'];

let t: TestApp;
let token = '';
let userId = '';
let tenantA = '';
let businessA = '';
let businessA2 = '';
let businessB = '';

/** One superuser connection inside a transaction that is always rolled back. */
async function rolledBack<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** The error message `fn` raises inside a savepoint, or null. */
async function failure(c: Client, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query('SAVEPOINT td18');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT td18');
    return null;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT td18');
    return e instanceof Error ? e.message : String(e);
  }
}

async function onboard(path: string, name: string): Promise<{ tenantId: string; businessId: string }> {
  const r = await t.request
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `td18-${randomUUID()}`)
    .send({ businessName: name, countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `td18-${randomUUID().slice(0, 12)}`, preferredLocale: 'en' });
  expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
  return { tenantId: String(r.body.tenantId), businessId: String(r.body.businessId) };
}

async function registerOwner(): Promise<{ token: string; userId: string }> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'TD18', preferredLocale: 'en' });
  expect(reg.status).toBe(201);
  const tk = String(reg.body.accessToken);
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${tk}`);
  return { token: tk, userId: String(me.body.userId) };
}

async function definerRows(q: { query: Client['query'] } | ReturnType<typeof ownerPool> = ownerPool()): Promise<Td18DefinerRow[]> {
  return (await q.query<Td18DefinerRow>(TD18_DEFINER_OWNERS_QUERY)).rows;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  const o = await registerOwner();
  token = o.token;
  userId = o.userId;
  const a = await onboard('/v1/onboarding/complete', 'TD18 A');
  tenantA = a.tenantId;
  businessA = a.businessId;
  businessA2 = (await onboard(`/v1/tenants/${tenantA}/businesses`, 'TD18 A2')).businessId;
  const other = await registerOwner();
  const rb = await t.request
    .post('/v1/onboarding/complete')
    .set('Authorization', `Bearer ${other.token}`)
    .set('Idempotency-Key', `td18-${randomUUID()}`)
    .send({ businessName: 'TD18 B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `td18-b-${randomUUID().slice(0, 12)}`, preferredLocale: 'en' });
  expect(rb.status).toBe(201);
  businessB = String(rb.body.businessId);
}, 300_000);

afterAll(async () => {
  await t.close();
  await resetData();
});

describe('TD-18 the model: owner, DEFINER, path and ACL of the four routines (0070)', () => {
  it('each routine is owned by its internal principal, DEFINER, with the pinned path', async () => {
    const rows = await definerRows();
    expect(td18DefinerProblems(rows)).toEqual([]);
    const r = await ownerPool().query<{ sig: string; owner: string; definer: boolean; config: string[] | null }>(
      `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              p.proconfig AS config
         FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s) ORDER BY 1`,
      [FOUR],
    );
    expect(r.rows).toEqual([
      { sig: 'catalog_identifiers_sync()', owner: CATALOG, definer: true, config: [PINNED] },
      { sig: 'provision_actor(text[])', owner: PROVISIONING, definer: true, config: [PINNED] },
      { sig: 'provision_assertion_key_install(text,bytea)', owner: PROVISIONING, definer: true, config: [PINNED] },
      { sig: 'provision_assertion_key_retire(text)', owner: PROVISIONING, definer: true, config: [PINNED] },
    ]);
  });

  it('EXECUTE: nobody on the trigger function, daftar_platform alone on the three provisioning routines; never PUBLIC', async () => {
    const r = await ownerPool().query<{ sig: string; grantees: string[] | null }>(
      `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
              (SELECT array_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type ORDER BY 1)
                 FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s) ORDER BY 1`,
      [FOUR],
    );
    expect(r.rows).toEqual([
      { sig: 'catalog_identifiers_sync()', grantees: null },
      { sig: 'provision_actor(text[])', grantees: ['daftar_platform:EXECUTE'] },
      { sig: 'provision_assertion_key_install(text,bytea)', grantees: ['daftar_platform:EXECUTE'] },
      { sig: 'provision_assertion_key_retire(text)', grantees: ['daftar_platform:EXECUTE'] },
    ]);
  });

  it('the two owners are NOLOGIN NOINHERIT roles without attributes, members of nothing, SET-able by the deployer alone, with no TEMPORARY or CREATE', async () => {
    const r = await ownerPool().query<{ role: string; bad: boolean; member_of: string[] | null; members: string[] | null; temp: boolean; create: boolean }>(
      `SELECT r.rolname::text AS role,
              (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit) AS bad,
              (SELECT array_agg(g.rolname::text ORDER BY 1) FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid WHERE a.member = r.oid) AS member_of,
              (SELECT array_agg(m.rolname || ':' || a.inherit_option || ':' || a.set_option || ':' || a.admin_option ORDER BY 1)
                 FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member WHERE a.roleid = r.oid) AS members,
              has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege(r.oid, 'public', 'CREATE') AS create
         FROM pg_roles r WHERE r.rolname = ANY ($1::text[]) ORDER BY 1`,
      [[CATALOG, PROVISIONING]],
    );
    expect(r.rows).toEqual([
      { role: CATALOG, bad: false, member_of: null, members: ['daftar_migrator:false:true:false'], temp: false, create: false },
      { role: PROVISIONING, bad: false, member_of: null, members: ['daftar_migrator:false:true:false'], temp: false, create: false },
    ]);
  });

  it('each owner holds exactly the table privileges its bodies need', async () => {
    const r = await ownerPool().query<{ g: string }>(
      `SELECT r.role || ':' || c.relname || ':' || p AS g
         FROM unnest($1::text[]) AS r(role)
        CROSS JOIN pg_class c
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
          AND (has_table_privilege(r.role, c.oid, p) OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r.role, c.oid, p)))
        ORDER BY 1`,
      [[CATALOG, PROVISIONING]],
    );
    expect(r.rows.map((x) => x.g)).toEqual([
      `${CATALOG}:businesses:SELECT`,
      `${CATALOG}:catalog_identifiers:DELETE`,
      `${CATALOG}:catalog_identifiers:INSERT`,
      `${CATALOG}:catalog_identifiers:SELECT`,
      `${PROVISIONING}:provisioning_assertion_keys:INSERT`,
      `${PROVISIONING}:provisioning_assertion_keys:SELECT`,
      `${PROVISIONING}:provisioning_assertion_keys:UPDATE`,
      `${PROVISIONING}:provisioning_assertion_uses:DELETE`,
      `${PROVISIONING}:provisioning_assertion_uses:INSERT`,
      `${PROVISIONING}:provisioning_assertion_uses:SELECT`,
    ]);
    const cols = await ownerPool().query<{ c: string }>(
      `SELECT a.attname::text AS c FROM pg_attribute a WHERE a.attrelid = 'public.businesses'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege($1, a.attrelid, a.attnum, 'SELECT') ORDER BY 1`,
      [CATALOG],
    );
    expect(
      cols.rows.map((x) => x.c),
      'businesses: the two columns the registry policy reads',
    ).toEqual(['id', 'tenant_id']);
  });

  it('TD-18 itself: the principal that applied the history owns no SECURITY DEFINER routine in public', async () => {
    const applier = (await ownerPool().query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0]?.u ?? '';
    const owned = (await ownerPool().query<{ f: string }>(APPLIER_OWNED_DEFINERS_QUERY, [applier])).rows.map((x) => x.f);
    expect(owned).toEqual([]);
    expect(APPLIER_OWNED_DEFINERS).toEqual([]);
    expect(applierOwnedDefinerProblems(owned, applier)).toEqual([]);
  });
});

describe('TD-18 negative controls: wrong owner, PUBLIC EXECUTE and a lost path are named (rolled back)', () => {
  it('an owner reverted to the applier is named by the model and by the applier check', async () => {
    await rolledBack(async (c) => {
      await c.query(`ALTER FUNCTION provision_actor(text[]) OWNER TO postgres`);
      const problems = td18DefinerProblems(await definerRows(c));
      expect(problems).toEqual(['provision_actor(p_allowed_kinds text[]) is owned by postgres, not daftar_provisioning_internal']);
      const owned = (await c.query<{ f: string }>(APPLIER_OWNED_DEFINERS_QUERY, ['postgres'])).rows.map((x) => x.f);
      expect(applierOwnedDefinerProblems(owned, 'postgres')).toEqual([
        'provision_actor(p_allowed_kinds text[]) is a SECURITY DEFINER routine owned by the applier postgres, and none may be',
      ]);
    });
  });

  it('a routine handed to a runtime role, a path without pg_temp last, and a lost DEFINER flag are each named', async () => {
    await rolledBack(async (c) => {
      await c.query(`ALTER FUNCTION catalog_identifiers_sync() OWNER TO daftar_platform`);
      await c.query(`ALTER FUNCTION provision_assertion_key_install(text, bytea) SET search_path = public, pg_catalog`);
      await c.query(`ALTER FUNCTION provision_assertion_key_retire(text) SECURITY INVOKER`);
      expect(td18DefinerProblems(await definerRows(c))).toEqual([
        'catalog_identifiers_sync() is owned by daftar_platform, not daftar_catalog_internal',
        'provision_assertion_key_install(p_kid text, p_secret bytea) pins search_path=public, pg_catalog, not search_path=pg_catalog, public, pg_temp',
        'provision_assertion_key_retire(p_kid text) is not SECURITY DEFINER',
      ]);
    });
  });

  it('PUBLIC EXECUTE granted on a routine is named; removing a routine is named', async () => {
    await rolledBack(async (c) => {
      await c.query(`GRANT EXECUTE ON FUNCTION provision_actor(text[]) TO PUBLIC`);
      expect(td18DefinerProblems(await definerRows(c))).toEqual(['provision_actor(p_allowed_kinds text[]) is executable by PUBLIC']);
    });
    expect(td18DefinerProblems((await definerRows()).filter((r) => r.f !== 'catalog_identifiers_sync()'))).toEqual(['catalog_identifiers_sync() is missing']);
    expect(Object.keys(TD18_DEFINER_OWNERS).sort()).toEqual([
      'catalog_identifiers_sync()',
      'provision_actor(p_allowed_kinds text[])',
      'provision_assertion_key_install(p_kid text, p_secret bytea)',
      'provision_assertion_key_retire(p_kid text)',
    ]);
  });
});

describe('TD-18 public-schema shadowing: a planted catalogue name in public is not called', () => {
  it('provision_actor: a planted public.string_to_array is not what the verifier calls', async () => {
    await rolledBack(async (c) => {
      await c.query(`CREATE FUNCTION public.string_to_array(text, text) RETURNS text[] LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'td18.shadowed'; END$$`);
      await c.query(`SET LOCAL ROLE daftar_platform`);
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [mintTestAssertion(userId, 'onboarding')]);
      const actor = await c.query<{ a: string }>(`SELECT provision_actor(ARRAY['onboarding'])::text AS a`);
      expect(actor.rows[0]?.a).toBe(userId);
    });
  });

  it('provision_assertion_key_install: a planted public.octet_length is not called', async () => {
    await rolledBack(async (c) => {
      await c.query(`CREATE FUNCTION public.octet_length(bytea) RETURNS integer LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'td18.shadowed'; END$$`);
      await c.query(`SET LOCAL ROLE daftar_platform`);
      const kid = `td18-${randomUUID().slice(0, 8)}`;
      await c.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [kid, Buffer.alloc(32, 3).toString('base64')]);
      await c.query('RESET ROLE');
      expect((await c.query(`SELECT status FROM provisioning_assertion_keys WHERE kid = $1`, [kid])).rows).toEqual([{ status: 'active' }]);
    });
  });

  it('provision_assertion_key_retire: a planted public "=" on text is not the operator the retirement uses', async () => {
    await rolledBack(async (c) => {
      const keep = `td18-keep-${randomUUID().slice(0, 6)}`;
      const drop = `td18-drop-${randomUUID().slice(0, 6)}`;
      await c.query(
        `INSERT INTO provisioning_assertion_keys (kid, secret) VALUES ($1, decode(repeat('ab', 32), 'hex')), ($2, decode(repeat('cd', 32), 'hex'))`,
        [keep, drop],
      );
      await c.query(`CREATE FUNCTION public.td18_always(text, text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`);
      await c.query(`CREATE OPERATOR public.= (LEFTARG = text, RIGHTARG = text, FUNCTION = public.td18_always)`);
      await c.query(`SET LOCAL ROLE daftar_platform`);
      await c.query(`SELECT provision_assertion_key_retire($1)`, [drop]);
      await c.query('RESET ROLE');
      const r = await c.query<{ kid: string; status: string }>(
        `SELECT kid, status FROM provisioning_assertion_keys WHERE kid OPERATOR(pg_catalog.=) ANY ($1::text[]) ORDER BY kid OPERATOR(pg_catalog.<) 'z'`,
        [[keep, drop]],
      );
      expect(Object.fromEntries(r.rows.map((x) => [x.kid, x.status]))).toEqual({ [keep]: 'active', [drop]: 'retired' });
      const v1 = await c.query(`SELECT status FROM provisioning_assertion_keys WHERE kid OPERATOR(pg_catalog.=) 'v1'`);
      expect(v1.rows).toEqual([{ status: 'active' }]);
    });
  });

  it('catalog_identifiers_sync: a planted public.btrim is not called; the SKU is registered', async () => {
    await rolledBack(async (c) => {
      await c.query(`CREATE FUNCTION public.btrim(text) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'td18.shadowed'; END$$`);
      await c.query(`SET LOCAL ROLE daftar_app`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      const sku = `TD18-${randomUUID().slice(0, 8)}`;
      const p = await c.query<{ id: string }>(
        `INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, $2, 1, 'JOD') RETURNING id::text`,
        [businessA, sku],
      );
      const reg = await c.query(
        `SELECT owner_type, product_id::text FROM catalog_identifiers WHERE business_id = $1 AND kind = 'sku' AND value_norm = lower($2)`,
        [businessA, sku],
      );
      expect(reg.rows).toEqual([{ owner_type: 'product', product_id: p.rows[0]?.id }]);
    });
  });
});

describe('TD-18 temp-schema shadowing: pg_temp is searched last, so a planted temporary relation is never read', () => {
  it('a temporary provisioning key registry holding an attacker key does not authorize an assertion', async () => {
    await rolledBack(async (c) => {
      const secret = Buffer.alloc(32, 9);
      await c.query(`CREATE TEMP TABLE provisioning_assertion_keys (kid TEXT, secret BYTEA, status TEXT)`);
      await c.query(`INSERT INTO pg_temp.provisioning_assertion_keys VALUES ('evil', $1, 'active')`, [secret]);
      await c.query(`GRANT SELECT ON pg_temp.provisioning_assertion_keys TO PUBLIC`);
      await c.query(`SET LOCAL ROLE daftar_platform`);
      const forged = mintProvisioningAssertion({ kid: 'evil', secret }, userId, 'onboarding', new Date(), 60);
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [forged]);
      expect(await failure(c, () => c.query(`SELECT provision_actor(ARRAY['onboarding'])`))).toMatch(
        /PROV:FORBIDDEN:Provisioning assertion key is unknown or retired/,
      );
    });
  });

  it('a temporary catalog_identifiers does not receive the registration', async () => {
    await rolledBack(async (c) => {
      await c.query(
        `CREATE TEMP TABLE catalog_identifiers (business_id UUID, kind TEXT, value_norm TEXT, owner_type TEXT, owner_id UUID, product_id UUID, variant_id UUID)`,
      );
      await c.query(`GRANT ALL ON pg_temp.catalog_identifiers TO PUBLIC`);
      await c.query(`SET LOCAL ROLE daftar_app`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      const sku = `TMP-${randomUUID().slice(0, 8)}`;
      await c.query(`INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, $2, 1, 'JOD')`, [businessA, sku]);
      await c.query('RESET ROLE');
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_temp.catalog_identifiers`)).rows).toEqual([{ n: 0 }]);
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM public.catalog_identifiers WHERE business_id = $1 AND value_norm = lower($2)`, [businessA, sku])).rows,
      ).toEqual([{ n: 1 }]);
    });
  });
});

describe('TD-18 invocation: forbidden to every runtime principal but the platform, required for the platform', () => {
  const RUNTIME: readonly (readonly [string, string])[] = [
    ['daftar_app', appDbUrl],
    ['daftar_provisioner', provisionerDbUrl],
    ['daftar_worker', workerDbUrl],
    ['daftar_identity', identityDbUrl],
    ['daftar_resolver', resolverDbUrl],
    ['daftar_reconciler', reconcilerDbUrl],
  ];
  for (const [role, url] of RUNTIME) {
    it(`${role} may not call any of the four directly`, async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await expect(c.query(`SELECT provision_actor(ARRAY['onboarding'])`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`SELECT provision_assertion_key_install('td18-evil', decode(repeat('ab', 32), 'hex'))`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`SELECT provision_assertion_key_retire('v1')`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`SELECT catalog_identifiers_sync()`)).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/);
      } finally {
        await c.end();
      }
    });
  }

  it('the internal owners cannot be assumed by a runtime principal', async () => {
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await expect(c.query(`SET ROLE ${PROVISIONING}`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SET ROLE ${CATALOG}`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('daftar_platform installs and retires a key through the commands, cannot read it, and the verifier honours both', async () => {
    const kid = `td18-${randomUUID().slice(0, 8)}`;
    const secret = Buffer.alloc(32, 11);
    const c = new Client({ connectionString: platformDbUrl });
    await c.connect();
    try {
      await c.query(`SELECT provision_assertion_key_install($1, $2)`, [kid, secret]);
      await expect(c.query(`SELECT secret FROM provisioning_assertion_keys WHERE kid = $1`, [kid])).rejects.toThrow(/permission denied/);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [
        mintProvisioningAssertion({ kid, secret }, userId, 'onboarding', new Date(), 60),
      ]);
      expect((await c.query<{ a: string }>(`SELECT provision_actor(ARRAY['onboarding'])::text AS a`)).rows[0]?.a).toBe(userId);
      await c.query('ROLLBACK');
      await c.query(`SELECT provision_assertion_key_retire($1)`, [kid]);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [
        mintProvisioningAssertion({ kid, secret }, userId, 'onboarding', new Date(), 60),
      ]);
      await expect(c.query(`SELECT provision_actor(ARRAY['onboarding'])`)).rejects.toThrow(/unknown or retired/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect((await ownerPool().query(`SELECT status FROM provisioning_assertion_keys WHERE kid = $1`, [kid])).rows).toEqual([{ status: 'retired' }]);
  });
});

describe('TD-18 flows through the four routines: onboarding, second business, catalogue identifiers', () => {
  it('onboarding and same-owner second-business onboarding ran through provision_actor (both businesses exist, each with its owner membership)', async () => {
    const r = await ownerPool().query<{ b: string; n: number }>(
      `SELECT m.business_id::text AS b, count(*)::int AS n FROM memberships m WHERE m.user_id = $1 AND m.status = 'active' GROUP BY 1 ORDER BY 1`,
      [userId],
    );
    expect(r.rows.map((x) => x.b).sort()).toEqual([businessA, businessA2].sort());
    const used = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM provisioning_assertion_uses`);
    expect(used.rows[0]?.n ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('catalogue create and update keep the registry exact; a duplicate SKU in the same business is refused', async () => {
    const h = { Authorization: `Bearer ${token}`, 'X-Business-Id': businessA };
    const sku = `CAT-${randomUUID().slice(0, 8)}`;
    const created = await t.request
      .post('/v1/catalog/products')
      .set(h)
      .send({ translations: { en: 'TD18 product' }, basePriceMinor: '100', priceCurrency: 'JOD', sku, barcode: `BC-${sku}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.id);
    const reg = async (): Promise<string[]> =>
      (
        await ownerPool().query<{ k: string }>(
          `SELECT kind || ':' || value_norm AS k FROM catalog_identifiers WHERE business_id = $1 AND product_id = $2 ORDER BY 1`,
          [businessA, id],
        )
      ).rows.map((x) => x.k);
    expect(await reg()).toEqual([`barcode:BC-${sku}`, `sku:${sku.toLowerCase()}`]);
    const renamed = `REN-${randomUUID().slice(0, 8)}`;
    const upd = await t.request.patch(`/v1/catalog/products/${id}`).set(h).send({ sku: renamed, barcode: null });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(await reg()).toEqual([`sku:${renamed.toLowerCase()}`]);
    const dup = await t.request
      .post('/v1/catalog/products')
      .set(h)
      .send({ translations: { en: 'dup' }, basePriceMinor: '1', priceCurrency: 'JOD', sku: renamed.toLowerCase() });
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
  });

  it('ALLOW: the same SKU in the same-owner second business and in another tenant; DENY: neither registry is visible across businesses', async () => {
    const sku = `SHARED-${randomUUID().slice(0, 8)}`;
    for (const b of [businessA, businessA2]) {
      const r = await t.request
        .post('/v1/catalog/products')
        .set({ Authorization: `Bearer ${token}`, 'X-Business-Id': b })
        .send({ translations: { en: 'shared' }, basePriceMinor: '1', priceCurrency: 'JOD', sku });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      const seen = await c.query<{ b: string }>(`SELECT DISTINCT business_id::text AS b FROM catalog_identifiers WHERE value_norm = lower($1)`, [sku]);
      expect(seen.rows).toEqual([{ b: businessA }]);
      for (const foreign of [businessA2, businessB]) {
        expect(
          await failure(c, () =>
            c.query(`INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, 'X-CROSS', 1, 'JOD')`, [foreign]),
          ),
          'a write into another business of the same owner, or of another tenant',
        ).toMatch(/row-level security/);
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    const other = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM catalog_identifiers WHERE business_id = $1 AND value_norm = lower($2)`,
      [businessB, sku],
    );
    expect(other.rows[0]?.n).toBe(0);
  });

  it("the same on every build: an unscoped owner write registers in the row's own business; a scope naming another business is refused", async () => {
    await rolledBack(async (c) => {
      // No business scope: the internal owner is admitted (0056's shape), and
      // the row lands in the product's own business, as on the superuser build.
      const sku = `TD18-U-${randomUUID().slice(0, 8)}`;
      const p = await c.query<{ id: string }>(
        `INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, $2, 1, 'JOD') RETURNING id::text`,
        [businessA, sku],
      );
      const reg = await c.query(`SELECT business_id::text AS b, product_id::text AS p FROM catalog_identifiers WHERE kind = 'sku' AND value_norm = lower($1)`, [
        sku,
      ]);
      expect(reg.rows).toEqual([{ b: businessA, p: p.rows[0]?.id }]);
      // A scope naming the sibling business: the registry row for business A
      // is refused by business_isolation, even for the internal owner.
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA2]);
      expect(
        await failure(c, () =>
          c.query(`INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, $2, 1, 'JOD')`, [businessA, `${sku}-X`]),
        ),
      ).toMatch(/row-level security policy "business_isolation" for table "catalog_identifiers"/);
    });
  });

  it('the registry policies are exactly the 0037 pair plus the internal admission', async () => {
    const r = await ownerPool().query<{ p: string }>(
      `SELECT pol.polname::text || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
              || (SELECT coalesce(string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x) END, ','), '') FROM unnest(pol.polroles) x) AS p
         FROM pg_policy pol WHERE pol.polrelid = 'public.catalog_identifiers'::regclass ORDER BY pol.polname COLLATE "C"`,
    );
    expect(r.rows.map((x) => x.p)).toEqual([
      'business_isolation:*:false:public',
      `catalog_internal_delete:d:true:${CATALOG}`,
      `catalog_internal_insert:a:true:${CATALOG}`,
      `catalog_internal_read:r:true:${CATALOG}`,
      'tenant_membership:*:true:public',
    ]);
  });
});

// ── Review I3: every SECURITY DEFINER routine, not only the four ────────────

/** The thirteen older definers 0070 §5b re-pins (their frozen paths put public first or left pg_temp unnamed). */
const REPINNED = [
  'public.accounting_assert_entry_valid',
  'public.accounting_seed_chart',
  'public.accounting_seed_chart_trg',
  'public.accounting_validate_entry',
  'public.accounting_validate_entry_of_line',
  'public.businesses_base_currency_lock',
  'public.provision_accept_invitation',
  'public.provision_create_business',
  'public.provision_create_tenant',
  'public.provision_expire_invitation',
  'public.provision_peek_invitation',
  'public.provision_persist_operation',
  'public.provision_replay_operation',
];

async function definerPaths(q: { query: Client['query'] } | ReturnType<typeof ownerPool> = ownerPool()): Promise<DefinerPathRow[]> {
  return (await q.query<DefinerPathRow>(DEFINER_PATHS_QUERY)).rows;
}

describe('review I3: every SECURITY DEFINER routine lists pg_catalog before public and pg_temp last (0070 §5b)', () => {
  it('the superuser build: the whole catalogue, the thirteen re-pinned routines included, exactly pinned', async () => {
    const rows = await definerPaths();
    expect(rows.length).toBeGreaterThan(100);
    expect(definerPathProblems(rows)).toEqual([]);
    const repinned = rows.filter((r) => REPINNED.includes(r.f.slice(0, r.f.indexOf('('))));
    expect(repinned.map((r) => r.f.slice(0, r.f.indexOf('(')))).toEqual(REPINNED);
    for (const r of repinned) expect(r.paths, r.f).toEqual([PINNED]);
  });

  it('a public-first path, an unnamed pg_temp and a lost path are each named (rolled back)', async () => {
    await rolledBack(async (c) => {
      await c.query(`ALTER FUNCTION provision_create_tenant(uuid) SET search_path = public, pg_catalog`);
      await c.query(`ALTER FUNCTION accounting_seed_chart(uuid) SET search_path = public, pg_catalog, pg_temp`);
      await c.query(`ALTER FUNCTION accounting_post_entry(date, text, text, jsonb) RESET search_path`);
      expect(definerPathProblems(await definerPaths(c))).toEqual([
        'public.accounting_post_entry(p_entry_date date, p_description text, p_request_id text, p_lines jsonb) sets no search_path',
        'public.accounting_seed_chart(p_business_id uuid) lists public before pg_catalog',
        'public.provision_create_tenant(p_tenant_id uuid) lists public before pg_catalog',
        'public.provision_create_tenant(p_tenant_id uuid) does not name pg_temp last',
      ]);
    });
  });

  it('the migrator build: red on the frozen history through 0069, green once daftar_migrator applies 0070 onward', async () => {
    const frozenHead = migrationFiles().find((f) => f.startsWith('0069_'));
    expect(frozenHead).toBeDefined();
    const db = await createScratchDb('daftar_p3c_td18_i3', { upTo: frozenHead, migratorOwned: true });
    try {
      const before = definerPathProblems(await definerPaths(db.pool));
      const named = [...new Set(before.map((p) => p.slice(0, p.indexOf('('))))].sort();
      // The four TD-18 routines (public first) and the thirteen older ones.
      expect(named).toEqual(
        [
          ...REPINNED,
          'public.catalog_identifiers_sync',
          'public.provision_actor',
          'public.provision_assertion_key_install',
          'public.provision_assertion_key_retire',
        ].sort(),
      );
      const applied = await db.migrateRest('daftar_migrator');
      expect(applied[0]).toMatch(/^0070_/);
      const after = await definerPaths(db.pool);
      expect(definerPathProblems(after)).toEqual([]);
      for (const r of after.filter((x) => REPINNED.includes(x.f.slice(0, x.f.indexOf('('))))) expect(r.paths, r.f).toEqual([PINNED]);
      const owners = await db.pool.query<{ f: string; owner: string }>(
        `SELECT p.proname::text AS f, pg_get_userbyid(p.proowner)::text AS owner FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND ('public.' || p.proname) = ANY($1::text[]) ORDER BY 1`,
        [REPINNED],
      );
      // The path changed; the owners did not.
      expect(owners.rows.map((r) => `${r.f}:${r.owner}`)).toEqual(
        REPINNED.map((f) => `${f.slice('public.'.length)}:${f.includes('provision_') ? 'daftar_platform' : 'daftar_accounting_internal'}`),
      );
    } finally {
      await db.drop();
    }
  }, 300_000);
});
