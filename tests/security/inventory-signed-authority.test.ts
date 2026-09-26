import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../apps/api/src/infra/migrate';
import {
  configureProductPayload,
  associateWarehouseBranchPayload,
  dissociateWarehouseBranchPayload,
  mintInventoryAssertion,
  splitInventoryAssertion,
  type InventoryOperationCode,
} from '../../packages/inventory/src';
import {
  APP_DB_PASSWORD,
  INVENTORY_ASSERTION_KID,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  applyBootstrap,
  appDbUrl,
  dbUrl,
  ensurePostgres,
  identityDbUrl,
  inventoryAssertionKey,
  mintTestAccountingAssertion,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  reconcilerDbUrl,
  resolverDbUrl,
  uniqueEmail,
  workerDbUrl,
} from '../helpers/test-app';

/**
 * P3-S1 — THE SIGNED-AUTHORITY MATRIX OF P3-AL-55, ROWS A–K, N, O, AND THE
 * PM-44 NEGATIVE CONTROL. Independent adversarial suite (Agent F).
 *
 * The attacker of PM-44 holds the `daftar_app` database credential and
 * nothing else: no merchant-api process, no key. They know victim tenant,
 * business, product, warehouse and branch UUIDs and an owner's user UUID.
 * Every row opens a RAW connection as that credential (or, for N/O, as each
 * other runtime role) — no application code is on the path.
 *
 * Genuine assertions are minted with `@daftar/inventory`'s
 * `mintInventoryAssertion` and the `inv1` test key that `ensurePostgres()`
 * installs, exactly as the merchant API would. Forgeries that the minter
 * refuses to produce (non-canonical components, unregistered kinds, long
 * lifetimes) are signed by hand with node:crypto over the §D preimage, using
 * the SAME key where the row needs a correct MAC — so the refusal is the
 * verifier's grammar, not a MAC failure in disguise.
 *
 * Every refusal is asserted by SQLSTATE and by its stable refusal code, and
 * every refused attack is followed by a byte comparison of the victim's
 * products, variants, associations, audit trail and replay registry.
 *
 * The PM-44 negative control at the end builds a throwaway database from the
 * real migrations, replaces `inventory_assertion_consume` with a verifier
 * that verifies nothing (as the superuser — no runtime grant is widened),
 * and shows rows B, C, D and J then SUCCEED: the suite models the attack,
 * not the happy path.
 */

// ── outcomes ───────────────────────────────────────────────────────────────

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; sqlstate: string; code: string; message: string };

const REFUSAL_CODE = /^([a-z_]+\.[a-z_]+):/;

function toOutcome(e: unknown): Outcome {
  const err = e as { code?: unknown; message?: unknown };
  const message = typeof err.message === 'string' ? err.message : String(e);
  return { ok: false, sqlstate: typeof err.code === 'string' ? err.code : '', code: REFUSAL_CODE.exec(message)?.[1] ?? '', message };
}

function expectRefused(o: Outcome, sqlstate: string, code: string | null): void {
  if (o.ok) throw new Error(`expected ${sqlstate}${code ? ` ${code}` : ''}, but the statement succeeded: ${JSON.stringify(o.rows)}`);
  expect({ sqlstate: o.sqlstate, code: code === null ? null : o.code }, o.message).toEqual({ sqlstate, code });
}

function expectAccepted(o: Outcome): Record<string, unknown>[] {
  if (!o.ok) throw new Error(`expected success, got ${o.sqlstate} ${o.message}`);
  return o.rows;
}

// ── sessions ───────────────────────────────────────────────────────────────

interface Carriers {
  tenant?: string;
  business?: string;
  actor?: string;
  assertion?: string;
}

async function setCarriers(c: Client, k: Carriers): Promise<void> {
  const pairs: [string, string | undefined][] = [
    ['app.tenant_id', k.tenant],
    ['app.business_id', k.business],
    ['app.actor_user_id', k.actor],
    ['app.inventory_assertion', k.assertion],
  ];
  for (const [name, value] of pairs) if (value !== undefined) await c.query(`SELECT set_config($1, $2, true)`, [name, value]);
}

/** One transaction on a fresh raw connection: set the carriers, run one statement, COMMIT on success (unless told not to), ROLLBACK otherwise. */
async function once(url: string, carriers: Carriers, sql: string, params: unknown[], commit = true): Promise<Outcome> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await setCarriers(c, carriers);
    let out: Outcome;
    try {
      out = { ok: true, rows: (await c.query<Record<string, unknown>>(sql, params)).rows };
    } catch (e) {
      out = toOutcome(e);
    }
    await c.query(out.ok && commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } finally {
    await c.end();
  }
}

const CONFIGURE_SQL = `SELECT * FROM inventory_configure_product($1::uuid, $2::boolean, $3::text, $4::smallint)`;
const ASSOCIATE_SQL = `SELECT structure_associate_warehouse_branch($1::uuid, $2::uuid) AS changed`;
const DISSOCIATE_SQL = `SELECT structure_dissociate_warehouse_branch($1::uuid, $2::uuid) AS changed`;

// ── world ──────────────────────────────────────────────────────────────────

interface Biz {
  tenant: string;
  business: string;
  branches: string[];
  warehouses: string[];
}
interface World {
  owner: string;
  attacker: string;
  A: Biz; // tenant A, the victim
  A2: Biz; // a second business of the SAME tenant
  B: Biz; // another tenant
}

async function one(q: { query: Pool['query'] }, sql: string, params: unknown[] = []): Promise<string> {
  const r = await q.query<{ id: string }>(sql, params);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`fixture returned no id: ${sql}`);
  return id;
}

async function seedBiz(pool: Pool, tenant: string, label: string): Promise<Biz> {
  const business = await one(
    pool,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenant, `Signed ${label}`, `sa-${label}-${randomUUID().slice(0, 8)}`],
  );
  const branches: string[] = [];
  for (const [i, name] of ['Main', 'North', 'South'].entries()) {
    branches.push(await one(pool, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`, [business, name, i === 0]));
  }
  const warehouses: string[] = [];
  for (const [i, home] of [branches[0], branches[1]].entries()) {
    warehouses.push(
      await one(pool, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, $3, $4) RETURNING id`, [
        business,
        home,
        `WH ${i}`,
        i === 0,
      ]),
    );
  }
  return { tenant, business, branches, warehouses };
}

async function seedWorld(pool: Pool): Promise<World> {
  const owner = await one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Victim owner') RETURNING id`, [uniqueEmail()]);
  const attacker = await one(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Attacker') RETURNING id`, [uniqueEmail()]);
  const tenantA = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const tenantB = await one(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  return { owner, attacker, A: await seedBiz(pool, tenantA, 'a'), A2: await seedBiz(pool, tenantA, 'a2'), B: await seedBiz(pool, tenantB, 'b') };
}

/** An unconfigured simple product (the translation check is deferred, so one transaction). */
async function newProduct(pool: Pool, business: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 500, 'ILS')`, [business, id]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Signed-authority product')`, [business, id]);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Everything a successful attack would change, as one string, read by the superuser. */
async function snapshot(pool: Pool, w: World): Promise<string> {
  const ids = [w.A.business, w.A2.business, w.B.business];
  const r = await pool.query<{ s: string }>(
    `SELECT jsonb_build_object(
       'products', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM products p WHERE p.business_id = ANY ($1::uuid[])),
       'variants', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM product_variants v WHERE v.business_id = ANY ($1::uuid[])),
       'associations', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.business_id, b.warehouse_id, b.branch_id) FROM branch_warehouses b WHERE b.business_id = ANY ($1::uuid[])),
       'audit', (SELECT count(*) FROM audit_events a WHERE a.business_id = ANY ($1::uuid[])),
       'uses', (SELECT count(*) FROM inventory_assertion_uses))::text AS s`,
    [ids],
  );
  return r.rows[0]?.s ?? '';
}

// ── minting ────────────────────────────────────────────────────────────────

const KEY = inventoryAssertionKey();
const scopeOf = (b: Biz, actor?: string): Carriers => ({ tenant: b.tenant, business: b.business, ...(actor ? { actor } : {}) });

function configureDigest(b: Biz, product: string, track: boolean, unit: string | null, decimals: number | null): string {
  return configureProductPayload({
    tenantId: b.tenant,
    businessId: b.business,
    productId: product,
    trackInventory: track,
    unitCode: unit,
    unitDecimals: decimals,
  }).sha256;
}
function pairDigest(op: 'associate' | 'dissociate', b: Biz, warehouse: string, branch: string): string {
  const input = { tenantId: b.tenant, businessId: b.business, warehouseId: warehouse, branchId: branch };
  return (op === 'associate' ? associateWarehouseBranchPayload(input) : dissociateWarehouseBranchPayload(input)).sha256;
}

/** A genuine assertion, minted by the package exactly as the merchant API mints it. */
function genuine(actor: string, b: Biz, opCode: InventoryOperationCode, payloadSha256: string, now = new Date(), ttl = 60): string {
  return mintInventoryAssertion({ actorUserId: actor, tenantId: b.tenant, businessId: b.business, opCode, payloadSha256 }, KEY, now, ttl);
}

/** Sign nine components by hand over the §D preimage — used only for what the minter refuses to produce. */
function handSigned(nine: readonly string[], secret: Buffer = KEY.secret, domainPrefix = 'invctl/1\n'): string {
  const mac = createHmac('sha256', secret)
    .update(`${domainPrefix}${nine.join('.')}`, 'utf8')
    .digest('hex');
  return [...nine, mac].join('.');
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ── the suite ──────────────────────────────────────────────────────────────

let w: World;
const ALT_KID = `f-alt-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ensurePostgres();
  w = await seedWorld(ownerPool());
  // A second ACTIVE key, so that swapping component 2 lands on real key
  // material and is judged by the MAC, not by the key lookup.
  const platform = new Client({ connectionString: platformDbUrl });
  await platform.connect();
  try {
    await platform.query(`SELECT inventory_assertion_key_install($1, $2)`, [ALT_KID, randomBytes(32)]);
  } finally {
    await platform.end();
  }
});

/** Run a configure attack as daftar_app and require the named refusal AND an untouched world. */
async function refusedUnchanged(sql: string, params: unknown[], carriers: Carriers, sqlstate: string, code: string): Promise<void> {
  const before = await snapshot(ownerPool(), w);
  expectRefused(await once(appDbUrl, carriers, sql, params), sqlstate, code);
  expect(await snapshot(ownerPool(), w)).toBe(before);
}

describe('Row A — raw DML of the three configuration columns (P3-AL-54 §F)', () => {
  let p: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
  });

  it.each([
    ['track_inventory alone', `UPDATE products SET track_inventory = true WHERE id = $1`],
    ['unit_code alone', `UPDATE products SET unit_code = 'kg' WHERE id = $1`],
    ['unit_decimals alone', `UPDATE products SET unit_decimals = 3 WHERE id = $1`],
    [
      'all three at once — the PM-40 statement that satisfies the CHECK',
      `UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE id = $1`,
    ],
    ['through a writable CTE', `WITH x AS (UPDATE products SET unit_code = 'kg', unit_decimals = 3 WHERE id = $1 RETURNING 1) SELECT count(*) FROM x`],
    [
      'through an upsert that turns into an UPDATE',
      `INSERT INTO products (business_id, id, base_price_minor, price_currency) SELECT business_id, id, 1, 'ILS' FROM products WHERE id = $1
       ON CONFLICT (business_id, id) DO UPDATE SET track_inventory = true, unit_code = 'piece', unit_decimals = 0`,
    ],
  ])('%s → P0001 inventory.configuration_authority_required', async (_name, sql) => {
    await refusedUnchanged(sql, [p], scopeOf(w.A, w.owner), 'P0001', 'inventory.configuration_authority_required');
  });

  it('a raw INSERT born tracked is refused the same way', async () => {
    await refusedUnchanged(
      `INSERT INTO products (business_id, base_price_minor, price_currency, track_inventory, unit_code, unit_decimals) VALUES ($1, 1, 'ILS', true, 'piece', 0)`,
      [w.A.business],
      scopeOf(w.A, w.owner),
      'P0001',
      'inventory.configuration_authority_required',
    );
  });

  it('a GENUINE, unconsumed configure assertion sitting in the carrier does not admit raw DML', async () => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    await refusedUnchanged(
      `UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE id = $1`,
      [p],
      { ...scopeOf(w.A, w.owner), assertion },
      'P0001',
      'inventory.configuration_authority_required',
    );
  });

  it.each([
    ['SET ROLE', `SET ROLE daftar_inventory_internal`],
    ['SET LOCAL ROLE', `SET LOCAL ROLE daftar_inventory_internal`],
    ['SET SESSION AUTHORIZATION', `SET SESSION AUTHORIZATION daftar_inventory_internal`],
  ])('the credential cannot become the principal the guard trusts (%s) → 42501', async (_name, sql) => {
    expectRefused(await once(appDbUrl, scopeOf(w.A), sql, []), '42501', null);
  });
});

describe('Row B — direct inventory_configure_product with no assertion', () => {
  let p: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
  });

  it('no carriers at all → P0001 inventory.assertion_missing', async () => {
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], {}, 'P0001', 'inventory.assertion_missing');
  });

  it('the attacker’s own scope set, no assertion → inventory.assertion_missing', async () => {
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], scopeOf(w.A), 'P0001', 'inventory.assertion_missing');
  });

  it('an empty carrier is not an assertion → inventory.assertion_missing', async () => {
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.A), assertion: '' }, 'P0001', 'inventory.assertion_missing');
  });
});

describe('Row C — victim GUCs, and a genuine assertion for another business', () => {
  let p: string;
  let pA2: string;
  let pB: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
    pA2 = await newProduct(ownerPool(), w.A2.business);
    pB = await newProduct(ownerPool(), w.B.business);
  });

  it('victim tenant, business and the owner as actor, no assertion → inventory.assertion_missing, for all three routines', async () => {
    const victim = scopeOf(w.A, w.owner);
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'kg', 3], victim, 'P0001', 'inventory.assertion_missing');
    await refusedUnchanged(ASSOCIATE_SQL, [w.A.warehouses[0], w.A.branches[2]], victim, 'P0001', 'inventory.assertion_missing');
    await refusedUnchanged(DISSOCIATE_SQL, [w.A.warehouses[0], w.A.branches[2]], victim, 'P0001', 'inventory.assertion_missing');
  });

  it('a genuine assertion for a business of ANOTHER tenant, under the victim GUCs → inventory.assertion_scope_mismatch', async () => {
    const assertion = genuine(w.attacker, w.B, 'inventory.configure_product', configureDigest(w.B, pB, true, 'piece', 0));
    await refusedUnchanged(CONFIGURE_SQL, [pB, true, 'piece', 0], { ...scopeOf(w.A, w.owner), assertion }, 'P0001', 'inventory.assertion_scope_mismatch');
  });

  it('a genuine assertion for another business of the SAME tenant, under the victim GUCs → inventory.assertion_scope_mismatch', async () => {
    const assertion = genuine(w.attacker, w.A2, 'inventory.configure_product', configureDigest(w.A2, pA2, true, 'piece', 0));
    await refusedUnchanged(CONFIGURE_SQL, [pA2, true, 'piece', 0], { ...scopeOf(w.A, w.owner), assertion }, 'P0001', 'inventory.assertion_scope_mismatch');
  });

  it('a genuine assertion for the victim business, carried into a transaction scoped to another business → inventory.assertion_scope_mismatch', async () => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.B), assertion }, 'P0001', 'inventory.assertion_scope_mismatch');
    await refusedUnchanged(
      CONFIGURE_SQL,
      [p, true, 'piece', 0],
      { tenant: w.A.tenant, business: w.A2.business, assertion },
      'P0001',
      'inventory.assertion_scope_mismatch',
    );
  });

  it('with no business scope at all a genuine assertion still does not reach the routine body → inventory.assertion_scope_mismatch', async () => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { assertion }, 'P0001', 'inventory.assertion_scope_mismatch');
  });

  it('§G step 8 — claims naming a business the claimed tenant does not own (signed under the real key) → inventory.forbidden', async () => {
    const nine = [
      'invctl1',
      INVENTORY_ASSERTION_KID,
      w.attacker,
      w.A.tenant,
      w.B.business,
      'inventory:configure_product',
      configureProductPayload({ tenantId: w.A.tenant, businessId: w.B.business, productId: pB, trackInventory: true, unitCode: 'piece', unitDecimals: 0 })
        .sha256,
      String(nowSeconds() + 60),
      randomUUID(),
    ];
    await refusedUnchanged(
      CONFIGURE_SQL,
      [pB, true, 'piece', 0],
      { tenant: w.A.tenant, business: w.B.business, assertion: handSigned(nine) },
      'P0001',
      'inventory.forbidden',
    );
    await refusedUnchanged(
      CONFIGURE_SQL,
      [pB, true, 'piece', 0],
      { tenant: w.B.tenant, business: w.B.business, assertion: handSigned(nine) },
      'P0001',
      'inventory.forbidden',
    );
  });
});

describe('Row D — forged assertions', () => {
  let p: string;
  let base: string;
  const args = (): unknown[] => [p, true, 'piece', 0];
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
    base = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
  });
  const withAssertion = (assertion: string): Carriers => ({ ...scopeOf(w.A, w.owner), assertion });

  it('the genuine assertion itself would be accepted (the control every forgery below is measured against)', async () => {
    const other = await newProduct(ownerPool(), w.A.business);
    const ok = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, other, true, 'piece', 0));
    const rows = expectAccepted(await once(appDbUrl, withAssertion(ok), CONFIGURE_SQL, [other, true, 'piece', 0], false));
    expect(rows[0]).toMatchObject({ product_id: other, track_inventory: true, unit_code: 'piece', unit_decimals: 0, changed: true });
  });

  it('signed under the wrong key, same kid → inventory.assertion_invalid_signature', async () => {
    const forged = mintInventoryAssertion(
      {
        actorUserId: w.owner,
        tenantId: w.A.tenant,
        businessId: w.A.business,
        opCode: 'inventory.configure_product',
        payloadSha256: configureDigest(w.A, p, true, 'piece', 0),
      },
      { kid: INVENTORY_ASSERTION_KID, secret: randomBytes(32) },
      new Date(),
    );
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(forged), 'P0001', 'inventory.assertion_invalid_signature');
  });

  it('signed under the real key but WITHOUT the invctl/1 domain prefix → inventory.assertion_invalid_signature', async () => {
    const nine = splitInventoryAssertion(base).components.slice(0, 9);
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(handSigned(nine, KEY.secret, '')), 'P0001', 'inventory.assertion_invalid_signature');
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(handSigned(nine, KEY.secret, 'acctctl/1\n')), 'P0001', 'inventory.assertion_invalid_signature');
  });

  it.each([
    ['the last hex digit flipped', (m: string) => m.slice(0, 63) + (m.endsWith('0') ? '1' : '0')],
    ['the first hex digit flipped', (m: string) => (m.startsWith('0') ? '1' : '0') + m.slice(1)],
    ['all zeros', () => '0'.repeat(64)],
    ['the MAC of another genuine assertion', () => splitInventoryAssertion(genuine(w.owner, w.A, 'inventory.configure_product', '0'.repeat(64))).mac],
  ])('MAC altered: %s → inventory.assertion_invalid_signature', async (_name, alter) => {
    const c = [...splitInventoryAssertion(base).components];
    c[9] = alter(c[9] ?? '');
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(c.join('.')), 'P0001', 'inventory.assertion_invalid_signature');
  });

  // Claims 2–9, each altered in turn to ANOTHER canonical value, under the
  // original MAC. Every one is caught by the MAC (step 4) before the later
  // checks it would otherwise reach — expiry, operation, payload, scope.
  const claimAlterations: [string, number, () => string][] = [
    ['2 kid → another ACTIVE key', 1, () => ALT_KID],
    ['3 actor → the attacker', 2, () => w.attacker],
    ['4 tenant → another tenant', 3, () => w.B.tenant],
    ['5 business → another business of the same tenant', 4, () => w.A2.business],
    ['6 operation → the association kind', 5, () => 'structure:associate_warehouse_branch'],
    ['7 payload digest → another canonical digest', 6, () => configureDigest(w.A, p, true, 'kg', 3)],
    ['8 expiry → one second later', 7, () => String(Number(splitInventoryAssertion(base).exp) + 1)],
    ['9 jti → a fresh uuid', 8, () => randomUUID()],
  ];
  it.each(claimAlterations)('claim %s, original MAC → inventory.assertion_invalid_signature', async (_name, index, value) => {
    const c = [...splitInventoryAssertion(base).components];
    c[index] = value();
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(c.join('.')), 'P0001', 'inventory.assertion_invalid_signature');
  });

  it('claim 2 kid → a kid that does not exist → inventory.assertion_key_unknown', async () => {
    const c = [...splitInventoryAssertion(base).components];
    c[1] = 'no-such-kid';
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(c.join('.')), 'P0001', 'inventory.assertion_key_unknown');
  });

  // Non-canonical spellings, CORRECTLY SIGNED with the real key over the
  // non-canonical bytes: the verifier must refuse the grammar itself and
  // never lowercase, trim or normalize its way into acceptance.
  const upper = (s: string): string => s.toUpperCase();
  const nonCanonical: [string, (c: string[]) => string[]][] = [
    ['uppercase actor uuid', (c) => c.map((x, i) => (i === 2 ? upper(x) : x))],
    ['uppercase tenant uuid', (c) => c.map((x, i) => (i === 3 ? upper(x) : x))],
    ['uppercase business uuid', (c) => c.map((x, i) => (i === 4 ? upper(x) : x))],
    ['uppercase jti', (c) => c.map((x, i) => (i === 8 ? upper(x) : x))],
    ['uppercase payload digest', (c) => c.map((x, i) => (i === 6 ? upper(x) : x))],
    ['uppercase operation', (c) => c.map((x, i) => (i === 5 ? upper(x) : x))],
    ['uppercase version', (c) => c.map((x, i) => (i === 0 ? upper(x) : x))],
    ['a leading-zero expiry', (c) => c.map((x, i) => (i === 7 ? `0${x}` : x))],
    ['a signed expiry', (c) => c.map((x, i) => (i === 7 ? `+${x}` : x))],
    ['an unbraced uuid without hyphens', (c) => c.map((x, i) => (i === 2 ? x.replace(/-/g, '') : x))],
    ['a braced uuid', (c) => c.map((x, i) => (i === 2 ? `{${x}}` : x))],
    ['a version of another protocol', (c) => c.map((x, i) => (i === 0 ? 'invctl2' : x))],
    ['a kid with a space', (c) => c.map((x, i) => (i === 1 ? 'inv 1' : x))],
    ['a 33-character kid', (c) => c.map((x, i) => (i === 1 ? 'k'.repeat(33) : x))],
  ];
  it.each(nonCanonical)('non-canonical, correctly signed: %s → inventory.assertion_malformed', async (_name, alter) => {
    const nine = alter([...splitInventoryAssertion(base).components.slice(0, 9)]);
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(handSigned(nine)), 'P0001', 'inventory.assertion_malformed');
  });

  it('non-canonical: the genuine assertion with its MAC in uppercase hex → inventory.assertion_malformed', async () => {
    const c = [...splitInventoryAssertion(base).components];
    c[9] = upper(c[9] ?? '');
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(c.join('.')), 'P0001', 'inventory.assertion_malformed');
  });

  const framing: [string, () => string][] = [
    [
      '9 components (jti removed, re-signed)',
      () =>
        handSigned(
          splitInventoryAssertion(base)
            .components.slice(0, 9)
            .filter((_, i) => i !== 8),
        ),
    ],
    ['9 components (MAC removed)', () => splitInventoryAssertion(base).components.slice(0, 9).join('.')],
    ['11 components (an extra trailing component)', () => `${base}.00`],
    ['11 components (a trailing separator)', () => `${base}.`],
    ['11 components (an extra claim, re-signed)', () => handSigned([...splitInventoryAssertion(base).components.slice(0, 9), 'extra'])],
    [
      'an empty kid component',
      () =>
        handSigned(
          splitInventoryAssertion(base)
            .components.slice(0, 9)
            .map((x, i) => (i === 1 ? '' : x)),
        ),
    ],
    ['a leading separator', () => `.${base}`],
    ['a trailing line feed', () => `${base}\n`],
    ['a leading space', () => ` ${base}`],
    ['a trailing space on the MAC', () => `${base} `],
  ];
  it.each(framing)('framing: %s → inventory.assertion_malformed', async (_name, make) => {
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(make()), 'P0001', 'inventory.assertion_malformed');
  });

  it('PM-46 cross-protocol: a genuine accounting control/posting-format assertion in the inventory carrier → inventory.assertion_malformed', async () => {
    const acct = mintTestAccountingAssertion({
      actorUserId: w.owner,
      tenantId: w.A.tenant,
      businessId: w.A.business,
      operationKind: 'post',
      sourceType: 'manual',
      sourceId: randomUUID(),
      postingFingerprint: configureDigest(w.A, p, true, 'piece', 0),
    });
    await refusedUnchanged(CONFIGURE_SQL, args(), withAssertion(acct), 'P0001', 'inventory.assertion_malformed');
  });

  it('none of the forgeries consumed the genuine assertion: it is still usable once, afterwards', async () => {
    const rows = expectAccepted(await once(appDbUrl, withAssertion(base), CONFIGURE_SQL, args(), false));
    expect(rows[0]).toMatchObject({ product_id: p, changed: true });
  });
});

describe('Row E — expiry and the TTL ceiling', () => {
  let p: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
  });
  const args = (): unknown[] => [p, true, 'piece', 0];
  const signedExp = (exp: number): string =>
    handSigned([
      'invctl1',
      INVENTORY_ASSERTION_KID,
      w.owner,
      w.A.tenant,
      w.A.business,
      'inventory:configure_product',
      configureDigest(w.A, p, true, 'piece', 0),
      String(exp),
      randomUUID(),
    ]);

  it('minted by the package 61 s ago with the full 60 s life → inventory.assertion_expired', async () => {
    const stale = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0), new Date(Date.now() - 61_000));
    await refusedUnchanged(CONFIGURE_SQL, args(), { ...scopeOf(w.A), assertion: stale }, 'P0001', 'inventory.assertion_expired');
  });

  it('expired by one second → inventory.assertion_expired', async () => {
    await refusedUnchanged(CONFIGURE_SQL, args(), { ...scopeOf(w.A), assertion: signedExp(nowSeconds() - 1) }, 'P0001', 'inventory.assertion_expired');
  });

  it.each([70, 120, 3600, 10 ** 18])('expiring %i s ahead (signed with the real key) → inventory.assertion_ttl_exceeded', async (ahead) => {
    await refusedUnchanged(CONFIGURE_SQL, args(), { ...scopeOf(w.A), assertion: signedExp(nowSeconds() + ahead) }, 'P0001', 'inventory.assertion_ttl_exceeded');
  });

  it('the ceiling is 60 s plus the fixed 5 s skew, not less: 63 s ahead is still accepted', async () => {
    expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion: signedExp(nowSeconds() + 63) }, CONFIGURE_SQL, args(), false));
  });

  it('the minter itself refuses to issue a life longer than 60 s', () => {
    expect(() => genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0), new Date(), 61)).toThrow(
      /inventory assertion requires a ttl of 1 to 60 seconds/,
    );
  });
});

describe('Row F — wrong operation kind', () => {
  let p: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
  });
  const signedOp = (wireOp: string): string =>
    handSigned([
      'invctl1',
      INVENTORY_ASSERTION_KID,
      w.owner,
      w.A.tenant,
      w.A.business,
      wireOp,
      configureDigest(w.A, p, true, 'piece', 0), // the RIGHT digest: only the kind is wrong
      String(nowSeconds() + 60),
      randomUUID(),
    ]);

  it.each([
    ['a registered kind of another routine', 'structure:associate_warehouse_branch'],
    ['the other registered association kind', 'structure:dissociate_warehouse_branch'],
    ['a kind locked for P3-S3 but not registered', 'inventory:transfer'],
    ['a forbidden generic kind', 'inventory:write'],
    ['a look-alike of the right kind', 'inventory:configure_products'],
  ])('%s, correctly signed over the right digest → inventory.assertion_wrong_operation', async (_name, wireOp) => {
    await refusedUnchanged(
      CONFIGURE_SQL,
      [p, true, 'piece', 0],
      { ...scopeOf(w.A), assertion: signedOp(wireOp) },
      'P0001',
      'inventory.assertion_wrong_operation',
    );
  });
});

describe('Row G — each configure argument altered under a valid assertion', () => {
  let p: string;
  let p2: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
    p2 = await newProduct(ownerPool(), w.A.business);
  });

  it.each<[string, (x: { p: string; p2: string }) => unknown[]]>([
    ['product_id → another product of the same business', (x) => [x.p2, true, 'piece', 0]],
    ['track_inventory true → false', (x) => [x.p, false, 'piece', 0]],
    ['unit_code piece → kg', (x) => [x.p, true, 'kg', 0]],
    ['unit_code piece → NULL', (x) => [x.p, true, null, 0]],
    ['unit_code piece → Piece (case)', (x) => [x.p, true, 'Piece', 0]],
    ['unit_code piece → "piece " (trailing space)', (x) => [x.p, true, 'piece ', 0]],
    ['unit_decimals 0 → 1', (x) => [x.p, true, 'piece', 1]],
    ['unit_decimals 0 → NULL (NULL is not zero)', (x) => [x.p, true, 'piece', null]],
  ])('%s → inventory.assertion_payload_mismatch', async (_name, make) => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    await refusedUnchanged(CONFIGURE_SQL, make({ p, p2 }), { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_payload_mismatch');
  });

  it('an assertion over NULL unit and NULL precision does not authorize a unit', async () => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, false, null, null));
    await refusedUnchanged(CONFIGURE_SQL, [p, false, 'piece', null], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_payload_mismatch');
    await refusedUnchanged(CONFIGURE_SQL, [p, false, null, 0], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_payload_mismatch');
  });
});

describe('Row H — replay', () => {
  it('a committed use, presented again in a second transaction → inventory.assertion_replayed', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion }, CONFIGURE_SQL, [p, true, 'piece', 0]));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_replayed');
  });

  it('a second call in the SAME transaction → inventory.assertion_replayed, and the transaction takes the first use down with it', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    const before = await snapshot(ownerPool(), w);
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await setCarriers(c, { ...scopeOf(w.A), assertion });
      await c.query(CONFIGURE_SQL, [p, true, 'piece', 0]);
      let second: Outcome = { ok: true, rows: [] };
      try {
        await c.query(CONFIGURE_SQL, [p, true, 'piece', 0]);
      } catch (e) {
        second = toOutcome(e);
      }
      expectRefused(second, 'P0001', 'inventory.assertion_replayed');
      await expect(c.query('COMMIT')).resolves.toMatchObject({ command: 'ROLLBACK' });
    } finally {
      await c.end();
    }
    expect(await snapshot(ownerPool(), w)).toBe(before);
  });

  it('a rolled-back first use, retried with the identical payload inside the TTL → accepted (a retry of the same decision, not a replay)', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    const jti = splitInventoryAssertion(assertion).jti;
    expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion }, CONFIGURE_SQL, [p, true, 'piece', 0], false));
    expect((await ownerPool().query(`SELECT count(*)::int AS n FROM inventory_assertion_uses WHERE jti = $1`, [jti])).rows[0]).toEqual({ n: 0 });
    const rows = expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion }, CONFIGURE_SQL, [p, true, 'piece', 0]));
    expect(rows[0]).toMatchObject({ product_id: p, track_inventory: true, changed: true });
    expect((await ownerPool().query(`SELECT count(*)::int AS n FROM inventory_assertion_uses WHERE jti = $1`, [jti])).rows[0]).toEqual({ n: 1 });
    // …and the retry has now consumed it for good.
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_replayed');
  });

  it('the retry window admits ONLY the signed payload: after a rollback a different unit is still a payload mismatch', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion }, CONFIGURE_SQL, [p, true, 'piece', 0], false));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'kg', 3], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_payload_mismatch');
  });

  it('a use consumed by a routine that then FAILED rolls back with it: the identical retry meets the same domain refusal, never inventory.assertion_replayed', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    // 'furlong' is a canonical registry-code spelling, so it is signable,
    // but it is not a registered unit: the routine consumes, then refuses.
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'furlong', 0));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'furlong', 0], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.unit_unknown');
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'furlong', 0], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.unit_unknown');
  });

  it('two concurrent transactions presenting one assertion: the second waits for the first, and is refused once the first commits', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    const [c1, c2] = [new Client({ connectionString: appDbUrl }), new Client({ connectionString: appDbUrl })];
    await c1.connect();
    await c2.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('BEGIN');
        await setCarriers(c, { ...scopeOf(w.A), assertion });
      }
      await c1.query(CONFIGURE_SQL, [p, true, 'piece', 0]);
      const second = c2.query(CONFIGURE_SQL, [p, true, 'piece', 0]).then(
        (r): Outcome => ({ ok: true, rows: r.rows as Record<string, unknown>[] }),
        (e: unknown): Outcome => toOutcome(e),
      );
      await c1.query('COMMIT');
      expectRefused(await second, 'P0001', 'inventory.assertion_replayed');
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    const r = await ownerPool().query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inventory.product_configured' AND entity_id = $1`, [p]);
    expect(r.rows[0]).toEqual({ n: 1 });
  });

  it('…and if the first ROLLS BACK instead, the waiting second use goes through exactly once', async () => {
    const p = await newProduct(ownerPool(), w.A.business);
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    const [c1, c2] = [new Client({ connectionString: appDbUrl }), new Client({ connectionString: appDbUrl })];
    await c1.connect();
    await c2.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('BEGIN');
        await setCarriers(c, { ...scopeOf(w.A), assertion });
      }
      await c1.query(CONFIGURE_SQL, [p, true, 'piece', 0]);
      const second = c2.query(CONFIGURE_SQL, [p, true, 'piece', 0]).then(
        (r): Outcome => ({ ok: true, rows: r.rows as Record<string, unknown>[] }),
        (e: unknown): Outcome => toOutcome(e),
      );
      await c1.query('ROLLBACK');
      expectAccepted(await second);
      await c2.query('COMMIT');
    } finally {
      await c1.end();
      await c2.end();
    }
    const r = await ownerPool().query(`SELECT track_inventory FROM products WHERE id = $1`, [p]);
    expect(r.rows).toEqual([{ track_inventory: true }]);
  });
});

describe('Row I — an assertion of one kind presented to another routine', () => {
  let p: string;
  let W: string;
  let Br: string;
  beforeAll(async () => {
    p = await newProduct(ownerPool(), w.A.business);
    W = w.A.warehouses[0] ?? '';
    Br = w.A.branches[2] ?? '';
  });

  it('a configuration assertion → the association routine and the dissociation routine: inventory.assertion_wrong_operation', async () => {
    const assertion = genuine(w.owner, w.A, 'inventory.configure_product', configureDigest(w.A, p, true, 'piece', 0));
    await refusedUnchanged(ASSOCIATE_SQL, [W, Br], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_wrong_operation');
    await refusedUnchanged(DISSOCIATE_SQL, [W, Br], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_wrong_operation');
  });

  it('an association assertion → the dissociation routine, and a dissociation assertion → the association routine: inventory.assertion_wrong_operation', async () => {
    const assoc = genuine(w.owner, w.A, 'structure.associate_warehouse_branch', pairDigest('associate', w.A, W, Br));
    const dissoc = genuine(w.owner, w.A, 'structure.dissociate_warehouse_branch', pairDigest('dissociate', w.A, W, Br));
    await refusedUnchanged(DISSOCIATE_SQL, [W, Br], { ...scopeOf(w.A), assertion: assoc }, 'P0001', 'inventory.assertion_wrong_operation');
    await refusedUnchanged(ASSOCIATE_SQL, [W, Br], { ...scopeOf(w.A), assertion: dissoc }, 'P0001', 'inventory.assertion_wrong_operation');
  });

  it('an association assertion → the configuration routine: inventory.assertion_wrong_operation', async () => {
    const assoc = genuine(w.owner, w.A, 'structure.associate_warehouse_branch', pairDigest('associate', w.A, W, Br));
    await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.A), assertion: assoc }, 'P0001', 'inventory.assertion_wrong_operation');
  });

  it('the associate and dissociate digests over the SAME ids differ, so a relabelled kind cannot reuse a digest', () => {
    expect(pairDigest('associate', w.A, W, Br)).not.toBe(pairDigest('dissociate', w.A, W, Br));
  });
});

describe('Row J — the association routines with no assertion', () => {
  it.each([
    ['associate', ASSOCIATE_SQL],
    ['dissociate', DISSOCIATE_SQL],
  ])('%s: no carriers → inventory.assertion_missing; victim GUCs with the owner as actor → inventory.assertion_missing', async (_name, sql) => {
    const pair = [w.A.warehouses[0], w.A.branches[2]];
    await refusedUnchanged(sql, pair, {}, 'P0001', 'inventory.assertion_missing');
    await refusedUnchanged(sql, pair, scopeOf(w.A, w.owner), 'P0001', 'inventory.assertion_missing');
  });

  it('dissociating a NON-home pair that exists, with no assertion → inventory.assertion_missing and the row survives', async () => {
    const W = w.A.warehouses[1] ?? '';
    const Br = w.A.branches[2] ?? '';
    const assertion = genuine(w.owner, w.A, 'structure.associate_warehouse_branch', pairDigest('associate', w.A, W, Br));
    expect(expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion }, ASSOCIATE_SQL, [W, Br]))[0]).toEqual({ changed: true });
    await refusedUnchanged(DISSOCIATE_SQL, [W, Br], scopeOf(w.A, w.owner), 'P0001', 'inventory.assertion_missing');
  });
});

describe('Row K — a pair assertion used for another pair', () => {
  it.each(['associate', 'dissociate'] as const)(
    '%s: minted for (W_A, B_2), used for (W_A, B_3), (W_D, B_2) and the swapped pair → inventory.assertion_payload_mismatch',
    async (op) => {
      const [WA, WD] = [w.A.warehouses[0] ?? '', w.A.warehouses[1] ?? ''];
      const [B2, B3] = [w.A.branches[1] ?? '', w.A.branches[2] ?? ''];
      const opCode = op === 'associate' ? 'structure.associate_warehouse_branch' : 'structure.dissociate_warehouse_branch';
      const sql = op === 'associate' ? ASSOCIATE_SQL : DISSOCIATE_SQL;
      for (const pair of [
        [WA, B3],
        [WD, B2],
        [B2, WA],
      ]) {
        const assertion = genuine(w.owner, w.A, opCode, pairDigest(op, w.A, WA, B2));
        await refusedUnchanged(sql, pair, { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_payload_mismatch');
      }
    },
  );

  it('a pair assertion of business A2 carried to the same ids under A2’s scope works only there: under A it is a scope mismatch', async () => {
    const W = w.A.warehouses[0] ?? '';
    const Br = w.A.branches[2] ?? '';
    const assertion = genuine(w.owner, w.A2, 'structure.associate_warehouse_branch', pairDigest('associate', w.A2, W, Br));
    await refusedUnchanged(ASSOCIATE_SQL, [W, Br], { ...scopeOf(w.A), assertion }, 'P0001', 'inventory.assertion_scope_mismatch');
    // Under A2's own scope the ids are not A2's: the business is the asserted one, never an argument.
    await refusedUnchanged(ASSOCIATE_SQL, [W, Br], { ...scopeOf(w.A2), assertion }, 'P0001', 'structure.warehouse_not_found');
  });
});

const OTHER_RUNTIME: [string, string][] = [
  ['daftar_platform', platformDbUrl],
  ['daftar_worker', workerDbUrl],
  ['daftar_provisioner', provisionerDbUrl],
  ['daftar_reconciler', reconcilerDbUrl],
  ['daftar_identity', identityDbUrl],
  ['daftar_resolver', resolverDbUrl],
];

describe('Row N — no other runtime role can execute the routines or the verifiers', () => {
  const calls: [string, string, unknown[]][] = [
    ['inventory_configure_product', CONFIGURE_SQL, [randomUUID(), true, 'piece', 0]],
    ['structure_associate_warehouse_branch', ASSOCIATE_SQL, [randomUUID(), randomUUID()]],
    ['structure_dissociate_warehouse_branch', DISSOCIATE_SQL, [randomUUID(), randomUUID()]],
    ['inventory_assertion_consume', `SELECT inventory_assertion_consume('inventory.configure_product', $1)`, ['0'.repeat(64)]],
    ['inventory_assertion_current', `SELECT inventory_assertion_current(ARRAY['inventory.configure_product'])`, []],
  ];

  it.each(OTHER_RUNTIME)('%s: every one → 42501', async (_role, url) => {
    for (const [name, sql, params] of calls) {
      const o = await once(url, {}, sql, params);
      expectRefused(o, '42501', null);
      expect(o.ok ? '' : o.message, name).toMatch(new RegExp(`permission denied for function ${name}`));
    }
  });

  it('daftar_app itself cannot call a verifier, the canonicalizer or the trace reader directly → 42501', async () => {
    for (const [name, sql] of [
      ['inventory_assertion_consume', `SELECT inventory_assertion_consume('inventory.configure_product', '${'0'.repeat(64)}')`],
      ['inventory_assertion_current', `SELECT inventory_assertion_current(ARRAY['inventory.configure_product'])`],
      [
        'inventory_payload_digest',
        `SELECT inventory_payload_digest('inventory.configure_product', gen_random_uuid(), gen_random_uuid(), ARRAY[]::text[], ARRAY[]::text[])`,
      ],
      ['inventory_claimed_payload_digest', `SELECT inventory_claimed_payload_digest('inventory.configure_product', ARRAY[]::text[], ARRAY[]::text[])`],
      ['inventory_business_transaction_id', `SELECT inventory_business_transaction_id()`],
    ] as const) {
      const o = await once(appDbUrl, scopeOf(w.A), sql, []);
      expectRefused(o, '42501', null);
      expect(o.ok ? '' : o.message, name).toMatch(new RegExp(`permission denied for function ${name}`));
    }
  });
});

describe('Row O — the key domain is unreadable and unwritable by every runtime role', () => {
  const ALL_RUNTIME: [string, string][] = [['daftar_app', appDbUrl], ...OTHER_RUNTIME];
  const statements = [
    `SELECT * FROM inventory_assertion_keys`,
    `SELECT kid FROM inventory_assertion_keys`,
    `INSERT INTO inventory_assertion_keys (kid, secret) VALUES ('rogue', decode(repeat('ab', 32), 'hex'))`,
    `UPDATE inventory_assertion_keys SET status = 'active'`,
    `DELETE FROM inventory_assertion_keys`,
    `SELECT * FROM inventory_assertion_uses`,
    `INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES (gen_random_uuid(), pg_current_xact_id(), 'inventory.configure_product', gen_random_uuid())`,
    `UPDATE inventory_assertion_uses SET consumed_at = now()`,
    `DELETE FROM inventory_assertion_uses`,
  ];

  it.each(ALL_RUNTIME)('%s: SELECT, INSERT, UPDATE and DELETE on both tables → 42501', async (_role, url) => {
    for (const sql of statements) expectRefused(await once(url, scopeOf(w.A), sql, []), '42501', null);
  });

  it('daftar_platform installs a key that then authorizes a real command, cannot read it back by any path, retires it, and cannot reinstate it', async () => {
    const kid = `f-life-${randomUUID().slice(0, 8)}`;
    const secret = randomBytes(48);
    const platform = new Client({ connectionString: platformDbUrl });
    await platform.connect();
    try {
      await platform.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]);

      // Same kid, different secret, while active → conflict; the secret is not echoed.
      const conflict = await platform.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, randomBytes(32)]).then(
        (): Outcome => ({ ok: true, rows: [] }),
        (e: unknown): Outcome => toOutcome(e),
      );
      expectRefused(conflict, 'P0001', 'inventory.assertion_key_conflict');
      expect(conflict.ok ? '' : conflict.message).not.toContain(secret.toString('hex'));

      for (const sql of [
        `SELECT secret FROM inventory_assertion_keys WHERE kid = '${kid}'`,
        `TABLE inventory_assertion_keys`,
        `COPY inventory_assertion_keys TO STDOUT`,
        `SELECT * FROM inventory_assertion_uses`,
      ]) {
        const o = await platform.query(sql).then(
          (): Outcome => ({ ok: true, rows: [] }),
          (e: unknown): Outcome => toOutcome(e),
        );
        expectRefused(o, '42501', null);
      }

      // The platform-installed key is real key material: a command signed with it is accepted.
      const p = await newProduct(ownerPool(), w.A.business);
      const withKey = (): string =>
        mintInventoryAssertion(
          {
            actorUserId: w.owner,
            tenantId: w.A.tenant,
            businessId: w.A.business,
            opCode: 'inventory.configure_product',
            payloadSha256: configureDigest(w.A, p, true, 'piece', 0),
          },
          { kid, secret },
          new Date(),
        );
      expectAccepted(await once(appDbUrl, { ...scopeOf(w.A), assertion: withKey() }, CONFIGURE_SQL, [p, true, 'piece', 0], false));

      await platform.query(`SELECT inventory_assertion_key_retire($1)`, [kid]);
      await refusedUnchanged(CONFIGURE_SQL, [p, true, 'piece', 0], { ...scopeOf(w.A), assertion: withKey() }, 'P0001', 'inventory.assertion_key_unknown');

      const reinstate = await platform.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]).then(
        (): Outcome => ({ ok: true, rows: [] }),
        (e: unknown): Outcome => toOutcome(e),
      );
      expectRefused(reinstate, 'P0001', 'inventory.assertion_key_conflict');
    } finally {
      await platform.end();
    }
  });
});

// ── PM-44: the negative control ────────────────────────────────────────────

describe('PM-44 negative control — with verification removed, the same attacks succeed', () => {
  const SCRATCH = 'daftar_p3s1_adv_pm44';
  const scratchSuper = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
  const scratchApp = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  admin.on('error', () => undefined);
  let pool: Pool;
  let sw: World;

  /** The attacks of rows A, B, C, D and J, run against `url`; each returns its outcome and the product/pair it aimed at. */
  async function attacks(url: string): Promise<Record<'A' | 'B' | 'C' | 'D' | 'J', Outcome> & { victimProducts: string[] }> {
    const [pa, pb, pc, pd] = [
      await newProduct(pool, sw.A.business),
      await newProduct(pool, sw.A.business),
      await newProduct(pool, sw.A.business),
      await newProduct(pool, sw.A.business),
    ];
    const victim = scopeOf(sw.A, sw.owner);
    const forged = mintInventoryAssertion(
      {
        actorUserId: sw.owner,
        tenantId: sw.A.tenant,
        businessId: sw.A.business,
        opCode: 'inventory.configure_product',
        payloadSha256: configureProductPayload({
          tenantId: sw.A.tenant,
          businessId: sw.A.business,
          productId: pd,
          trackInventory: true,
          unitCode: 'kg',
          unitDecimals: 3,
        }).sha256,
      },
      { kid: INVENTORY_ASSERTION_KID, secret: randomBytes(32) },
      new Date(),
    );
    return {
      victimProducts: [pc, pd],
      A: await once(url, victim, `UPDATE products SET track_inventory = true, unit_code = 'kg', unit_decimals = 3 WHERE id = $1`, [pa]),
      B: await once(url, { tenant: sw.A.tenant, business: sw.A.business }, CONFIGURE_SQL, [pb, true, 'kg', 3]),
      C: await once(url, victim, CONFIGURE_SQL, [pc, true, 'kg', 3]),
      D: await once(url, { ...victim, assertion: forged }, CONFIGURE_SQL, [pd, true, 'kg', 3]),
      J: await once(url, victim, ASSOCIATE_SQL, [sw.A.warehouses[0], sw.A.branches[2]]),
    };
  }

  beforeAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    await applyBootstrap(SCRATCH);
    await runMigrations(scratchSuper);
    pool = new Pool({ connectionString: scratchSuper, max: 2 });
    pool.on('error', () => undefined);
    await pool.query(`SELECT inventory_assertion_key_install($1, $2)`, [INVENTORY_ASSERTION_KID, KEY.secret]);
    sw = await seedWorld(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
  });

  it('on the migrated schema, as shipped, every attack is refused with its own code', async () => {
    const o = await attacks(scratchApp);
    expectRefused(o.A, 'P0001', 'inventory.configuration_authority_required');
    expectRefused(o.B, 'P0001', 'inventory.assertion_missing');
    expectRefused(o.C, 'P0001', 'inventory.assertion_missing');
    expectRefused(o.D, 'P0001', 'inventory.assertion_invalid_signature');
    expectRefused(o.J, 'P0001', 'inventory.assertion_missing');
  });

  it('with inventory_assertion_consume replaced by a verifier that verifies nothing, rows B, C, D and J SUCCEED — and name the victim owner', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION inventory_assertion_consume(p_op_code TEXT, p_payload_sha256 TEXT) RETURNS inventory_verified_actor
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE v inventory_verified_actor;
      BEGIN
        v.actor_user_id := nullif(current_setting('app.actor_user_id', true), '')::uuid;
        v.tenant_id     := nullif(current_setting('app.tenant_id', true), '')::uuid;
        v.business_id   := nullif(current_setting('app.business_id', true), '')::uuid;
        v.op_code       := p_op_code;
        v.jti           := gen_random_uuid();
        RETURN v;
      END $fn$`);
    // Still owned by the internal principal — only the verification is gone.
    const owner = await pool.query(`SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE proname = 'inventory_assertion_consume'`);
    expect(owner.rows).toEqual([{ o: 'daftar_inventory_internal' }]);

    const o = await attacks(scratchApp);
    expectRefused(o.A, 'P0001', 'inventory.configuration_authority_required'); // row A is the column guard's, not the verifier's
    for (const row of ['B', 'C', 'D'] as const) {
      const rows = expectAccepted(o[row]);
      expect(rows[0], row).toMatchObject({ track_inventory: true, unit_code: 'kg', unit_decimals: 3, changed: true });
    }
    expect(expectAccepted(o.J)[0]).toEqual({ changed: true });
    // Rows C and D set the victim owner as app.actor_user_id: the audit trail names whoever the attacker chose.
    const audit = await pool.query(
      `SELECT DISTINCT actor_user_id FROM audit_events WHERE action = 'inventory.product_configured' AND entity_id = ANY ($1::text[])`,
      [o.victimProducts],
    );
    expect(audit.rows).toEqual([{ actor_user_id: sw.owner }]);
  });

  it('with the column guard dropped as well, row A succeeds — the row-A test is not decorative either', async () => {
    await pool.query(`DROP TRIGGER products_10_inventory_config_authority ON products`);
    const o = await attacks(scratchApp);
    expect(expectAccepted(o.A)).toEqual([]);
  });
});
