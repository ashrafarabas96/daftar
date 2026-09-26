import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, closeTestApps, createTestApp, ensurePostgres, ownerPool, platformDbUrl, resetData, uniqueEmail } from '../helpers/test-app';

/**
 * P3-S1 — THE THREE ENTRY ROUTINES, THE WAREHOUSE LIFECYCLE, TD-09 AND THE
 * PERMISSION SEED, AGAINST THE LIVE DATABASE (P3-AL-03/04/05/15/36/38/53/55).
 *
 * Every call goes over a raw `daftar_app` connection — the exact credential
 * the API holds — with the transaction-local carriers the seam sets:
 * `app.tenant_id`, `app.business_id`, `app.inventory_assertion` and
 * `app.business_transaction_id`. No application code is involved.
 *
 * The assertion is minted HERE, with node:crypto, from the wire format in
 * P3-AL-55 §D/§F — deliberately not by importing packages/inventory, so this
 * file is an independent second implementation of the protocol. Its
 * canonicalizer is pinned to three of the shared invpl/1 vectors, and so is
 * the database's.
 */

// ── invpl/1 and invctl/1, independently ────────────────────────────────────

type FieldType = 'uuid' | 'boolean' | 'code' | 'integer';
type Field = readonly [FieldType, string | null];

const LF = Buffer.from([0x0a]);
const NUL_LINE = Buffer.from([0x00, 0x0a]);

/** The invpl/1 digest: SHA-256 over 'invpl/1' LF op LF tenant LF business LF field… with every line LF-terminated and NULL as 0x00. */
function invpl(op: string, tenant: string, business: string, fields: readonly Field[]): string {
  const parts: Buffer[] = [Buffer.from(`invpl/1\n${op}\n${tenant}\n${business}\n`, 'utf8')];
  for (const [, value] of fields) parts.push(value === null ? NUL_LINE : Buffer.concat([Buffer.from(value, 'utf8'), LF]));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

const KID = 'p3s1-db-routines';
const SECRET = createHash('sha256').update('P3-S1 database routines test key — never deployed').digest();

interface Claims {
  actor: string;
  tenant: string;
  business: string;
  op: string;
  digest: string;
  exp?: number;
  jti?: string;
  kid?: string;
  secret?: Buffer;
}

/** invctl/1: ten dot-separated components, the MAC over 'invctl/1' LF c1..c9. */
function mint(c: Claims): { assertion: string; jti: string } {
  const jti = c.jti ?? randomUUID();
  const exp = c.exp ?? Math.floor(Date.now() / 1000) + 60;
  const components = ['invctl1', c.kid ?? KID, c.actor, c.tenant, c.business, c.op.replace(/\./g, ':'), c.digest, String(exp), jti];
  const mac = createHmac('sha256', c.secret ?? SECRET)
    .update(`invctl/1\n${components.join('.')}`, 'utf8')
    .digest('hex');
  return { assertion: [...components, mac].join('.'), jti };
}

// ── fixture ────────────────────────────────────────────────────────────────

interface Biz {
  tenant: string;
  business: string;
  branch: string;
  branch2: string;
  warehouse: string;
}
let A: Biz;
let B: Biz;
let actor: string;
let product: string; // simple product in A
let variantProduct: string; // product in A with a merchant variant
let productB: string; // product in B

async function one(c: { query: PoolClient['query'] }, sql: string, params: unknown[] = []): Promise<string> {
  const r = await c.query<{ id: string }>(sql, params);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`fixture statement returned no id: ${sql}`);
  return id;
}

async function seedBusiness(slug: string, timezone = 'Asia/Hebron'): Promise<Biz> {
  const p = ownerPool();
  const tenant = await one(p, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const business = await one(
    p,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', $4) RETURNING id`,
    [tenant, `Routines ${slug}`, `inv-rt-${slug}-${Date.now()}`, timezone],
  );
  const branch = await one(p, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [business]);
  const branch2 = await one(p, `INSERT INTO branches (business_id, name) VALUES ($1, 'Second') RETURNING id`, [business]);
  const warehouse = await one(p, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    business,
    branch,
  ]);
  return { tenant, business, branch, branch2, warehouse };
}

async function createProduct(business: string, withMerchantVariant = false): Promise<string> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 1000, 'ILS')`, [business, id]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Routine test product')`, [business, id]);
    if (withMerchantVariant)
      await c.query(`INSERT INTO product_variants (business_id, product_id, sku) VALUES ($1, $2, $3)`, [business, id, `V-${id.slice(0, 8)}`]);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// ── calling a routine exactly as the seam does ─────────────────────────────

interface CallOptions {
  biz: Biz;
  /** The scope GUCs; defaults to biz. */
  scope?: { tenant: string; business: string };
  assertion: string | null;
  trace?: string | null;
  commit?: boolean;
}

async function call<T extends Record<string, unknown>>(sql: string, params: unknown[], o: CallOptions): Promise<T[]> {
  const c = new Client({ connectionString: appDbUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const scope = o.scope ?? { tenant: o.biz.tenant, business: o.biz.business };
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenant, scope.business]);
    if (o.assertion !== null) await c.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [o.assertion]);
    if (o.trace !== undefined && o.trace !== null) await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [o.trace]);
    const r = await c.query<T>(sql, params);
    await c.query(o.commit === false ? 'ROLLBACK' : 'COMMIT');
    return r.rows;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const CONFIGURE = 'inventory.configure_product';
const ASSOCIATE = 'structure.associate_warehouse_branch';
const DISSOCIATE = 'structure.dissociate_warehouse_branch';

interface Configured extends Record<string, unknown> {
  product_id: string;
  track_inventory: boolean;
  unit_code: string | null;
  unit_decimals: number | null;
  base_variant_id: string | null;
  changed: boolean;
}

const configureFields = (id: string, track: boolean | null, unit: string | null, decimals: number | null): Field[] => [
  ['uuid', id],
  ['boolean', track === null ? null : String(track)],
  ['code', unit],
  ['integer', decimals === null ? null : String(decimals)],
];

/** Mint for (biz, args) and call inventory_configure_product with exactly those args. */
async function configure(
  biz: Biz,
  id: string,
  track: boolean | null,
  unit: string | null,
  decimals: number | null,
  extra: Partial<CallOptions> & { mintFor?: Field[]; op?: string; claims?: Partial<Claims> } = {},
): Promise<{ row: Configured | undefined; jti: string }> {
  const digest = invpl(extra.op ?? CONFIGURE, biz.tenant, biz.business, extra.mintFor ?? configureFields(id, track, unit, decimals));
  const { assertion, jti } = mint({ actor, tenant: biz.tenant, business: biz.business, op: extra.op ?? CONFIGURE, digest, ...extra.claims });
  const rows = await call<Configured>(`SELECT * FROM inventory_configure_product($1, $2, $3, $4)`, [id, track, unit, decimals], {
    biz,
    assertion: extra.assertion === undefined ? assertion : extra.assertion,
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.trace !== undefined ? { trace: extra.trace } : {}),
    ...(extra.commit !== undefined ? { commit: extra.commit } : {}),
  });
  return { row: rows[0], jti };
}

async function association(
  op: typeof ASSOCIATE | typeof DISSOCIATE,
  biz: Biz,
  warehouse: string,
  branch: string,
  extra: Partial<CallOptions> = {},
): Promise<{ changed: boolean | undefined; jti: string }> {
  const digest = invpl(op, biz.tenant, biz.business, [
    ['uuid', warehouse],
    ['uuid', branch],
  ]);
  const { assertion, jti } = mint({ actor, tenant: biz.tenant, business: biz.business, op, digest });
  const fn = op === ASSOCIATE ? 'structure_associate_warehouse_branch' : 'structure_dissociate_warehouse_branch';
  const rows = await call<{ r: boolean }>(`SELECT ${fn}($1, $2) AS r`, [warehouse, branch], {
    biz,
    assertion: extra.assertion === undefined ? assertion : extra.assertion,
    ...(extra.trace !== undefined ? { trace: extra.trace } : {}),
  });
  return { changed: rows[0]?.r, jti };
}

interface AuditRow {
  actor_user_id: string;
  business_id: string;
  entity: string;
  metadata: Record<string, unknown>;
}

async function auditRows(action: string, entityId: string): Promise<AuditRow[]> {
  const r = await ownerPool().query<AuditRow>(
    `SELECT actor_user_id, business_id, entity, metadata FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY created_at, id`,
    [action, entityId],
  );
  return r.rows;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const platform = new Client({ connectionString: platformDbUrl });
  await platform.connect();
  try {
    await platform.query(`SELECT inventory_assertion_key_install($1, $2)`, [KID, SECRET]);
  } finally {
    await platform.end();
  }
  A = await seedBusiness('a');
  B = await seedBusiness('b');
  actor = await one(ownerPool(), `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Stock keeper') RETURNING id`, [uniqueEmail()]);
  product = await createProduct(A.business);
  variantProduct = await createProduct(A.business, true);
  productB = await createProduct(B.business);
});

afterAll(async () => {
  await closeTestApps(() => true);
});

// ── the protocol itself ────────────────────────────────────────────────────

describe('invpl/1 and invctl/1 parity with the shared vectors (P3-AL-55 §D, §F)', () => {
  const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const Bz = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const P = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const vectors: [string, string, Field[], string][] = [
    ['configure_track_piece_0', CONFIGURE, configureFields(P, true, 'piece', 0), '7cfd4cff4abf8f83384926d6fbc6feb6aa8c1115f5e0761ae32030a9ae2d0302'],
    ['configure_untracked_null_null', CONFIGURE, configureFields(P, false, null, null), '2fda040b9ab95b445452663b79b62a29bb75538ca595be479c4838db624a4d17'],
    [
      'associate_w1_br1',
      ASSOCIATE,
      [
        ['uuid', '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303'],
        ['uuid', '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301'],
      ],
      'c9c0b1487f687f93d9420e2240bc68803f77c3ad901b9cddbfff317a9e9338ee',
    ],
  ];

  it.each(vectors)('%s: this file and the database canonicalizer both produce the vector digest', async (_name, op, fields, expected) => {
    expect(invpl(op, T, Bz, fields)).toBe(expected);
    const r = await ownerPool().query<{ d: string }>(`SELECT inventory_payload_digest($1, $2, $3, $4::text[], $5::text[]) AS d`, [
      op,
      T,
      Bz,
      fields.map((f) => f[0]),
      fields.map((f) => f[1]),
    ]);
    expect(r.rows[0]?.d).toBe(expected);
  });

  it('configure_default_ttl: this file mints the vector MAC', () => {
    const { assertion } = mint({
      actor: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      tenant: T,
      business: Bz,
      op: CONFIGURE,
      digest: '7cfd4cff4abf8f83384926d6fbc6feb6aa8c1115f5e0761ae32030a9ae2d0302',
      exp: 1790409660,
      jti: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      kid: 'inv-p3s1_a',
      secret: Buffer.alloc(32, 0x07),
    });
    expect(assertion.split('.').at(-1)).toBe('b401d427215e6209817d1c5a919e4a40d5da6c37c90cd3135227714724fe2edf');
  });

  it('the database refuses a non-canonical field instead of normalizing it', async () => {
    for (const [type, value] of [
      ['uuid', '6BA7B810-9DAD-11D1-80B4-00C04FD430C8'],
      ['boolean', 'TRUE'],
      ['integer', '007'],
      ['integer', '+1'],
      ['code', 'Piece'],
      ['code', ' piece'],
    ] as const) {
      await expect(
        ownerPool().query(`SELECT inventory_payload_digest($1, $2, $3, ARRAY[$4]::text[], ARRAY[$5]::text[])`, [CONFIGURE, T, Bz, type, value]),
        `${type} ${value}`,
      ).rejects.toThrow(/inventory\.payload_invalid/);
    }
  });
});

// ── inventory_configure_product ────────────────────────────────────────────

describe('inventory_configure_product (P3-AL-04, P3-AL-03, P3-AL-55 §G)', () => {
  const productRow = async (id: string) =>
    (await ownerPool().query(`SELECT track_inventory, unit_code, unit_decimals, version FROM products WHERE id = $1`, [id])).rows[0] as {
      track_inventory: boolean;
      unit_code: string | null;
      unit_decimals: number | null;
      version: number;
    };
  const baseVariants = async (id: string) =>
    (
      await ownerPool().query<Record<string, unknown>>(
        `SELECT id, sku, barcode, price_minor, attributes FROM product_variants WHERE product_id = $1 AND is_base`,
        [id],
      )
    ).rows;

  it('refuses a call with no assertion, and changes nothing', async () => {
    const before = await productRow(product);
    const message = await refusal(() => configure(A, product, true, 'piece', null, { assertion: null }));
    expect(message).toMatch(/inventory\.assertion_missing/);
    expect(await productRow(product)).toEqual(before);
    expect(await baseVariants(product)).toEqual([]);
  });

  it('refuses tracking without a unit (tracked ⇒ unit)', async () => {
    expect(await refusal(() => configure(A, product, true, null, null))).toMatch(/inventory\.unit_required: tracking inventory requires a canonical unit/);
  });

  it('refuses an unknown unit, a precision without a unit, and a precision out of range', async () => {
    expect(await refusal(() => configure(A, product, true, 'furlong', null))).toMatch(/inventory\.unit_unknown/);
    expect(await refusal(() => configure(A, product, false, null, 2))).toMatch(/inventory\.unit_required/);
    expect(await refusal(() => configure(A, product, true, 'kg', 5))).toMatch(/inventory\.unit_decimals_invalid/);
  });

  it('happy path: tracks the product in its unit, creates the hidden base variant, audits with the signed actor and the trace, and does not bump version', async () => {
    const before = await productRow(product);
    const trace = randomUUID();
    const { row, jti } = await configure(A, product, true, 'kg', null, { trace });
    expect(row).toMatchObject({ product_id: product, track_inventory: true, unit_code: 'kg', unit_decimals: 3, changed: true });
    expect(row?.base_variant_id).toMatch(/^[0-9a-f-]{36}$/);

    const after = await productRow(product);
    expect(after).toEqual({ track_inventory: true, unit_code: 'kg', unit_decimals: 3, version: before.version });

    const base = await baseVariants(product);
    expect(base).toEqual([{ id: row?.base_variant_id, sku: null, barcode: null, price_minor: null, attributes: {} }]);

    const audit = await auditRows('inventory.product_configured', product);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: actor, business_id: A.business, entity: 'product' });
    expect(audit[0]?.metadata).toEqual({
      trackInventory: true,
      unitCode: 'kg',
      unitDecimals: 3,
      previous: { trackInventory: false, unitCode: null, unitDecimals: null },
      baseVariantId: row?.base_variant_id,
      baseVariantCreated: true,
      assertionJti: jti,
      business_transaction_id: trace,
    });
  });

  it('a repeated identical configuration is an idempotent no-op: changed = false, no second audit event, one base variant', async () => {
    const { row } = await configure(A, product, true, 'kg', 3);
    expect(row).toMatchObject({ track_inventory: true, unit_code: 'kg', unit_decimals: 3, changed: false });
    expect(await auditRows('inventory.product_configured', product)).toHaveLength(1);
    expect(await baseVariants(product)).toHaveLength(1);
  });

  it('a NULL unit KEEPS the current unit and precision; turning tracking off keeps the base variant', async () => {
    const { row } = await configure(A, product, false, null, null);
    expect(row).toMatchObject({ track_inventory: false, unit_code: 'kg', unit_decimals: 3, changed: true });
    expect(await productRow(product)).toMatchObject({ track_inventory: false, unit_code: 'kg', unit_decimals: 3 });
    expect(await baseVariants(product)).toHaveLength(1);
    const audit = await auditRows('inventory.product_configured', product);
    expect(audit).toHaveLength(2);
    expect(audit[1]?.metadata).toMatchObject({ baseVariantCreated: false, business_transaction_id: null });
  });

  it('the same unit with no precision keeps the current precision; a new unit takes its registry default', async () => {
    expect((await configure(A, product, true, 'kg', null)).row).toMatchObject({ unit_code: 'kg', unit_decimals: 3 });
    expect((await configure(A, product, true, 'piece', null)).row).toMatchObject({ unit_code: 'piece', unit_decimals: 0 });
    expect((await configure(A, product, true, 'litre', 1)).row).toMatchObject({ unit_code: 'litre', unit_decimals: 1 });
  });

  it('a product with a merchant variant is tracked through it and never gets a base variant', async () => {
    const { row } = await configure(A, variantProduct, true, 'piece', null);
    expect(row).toMatchObject({ track_inventory: true, base_variant_id: null, changed: true });
    expect(await baseVariants(variantProduct)).toEqual([]);
  });

  it('refuses a replay of a consumed assertion — in another transaction', async () => {
    const digest = invpl(CONFIGURE, A.tenant, A.business, configureFields(product, true, 'box', null));
    const { assertion } = mint({ actor, tenant: A.tenant, business: A.business, op: CONFIGURE, digest });
    await call(`SELECT * FROM inventory_configure_product($1, true, 'box', NULL)`, [product], { biz: A, assertion });
    expect(await refusal(() => call(`SELECT * FROM inventory_configure_product($1, true, 'box', NULL)`, [product], { biz: A, assertion }))).toMatch(
      /inventory\.assertion_replayed/,
    );
  });

  it('refuses a replay inside the same transaction', async () => {
    const digest = invpl(CONFIGURE, A.tenant, A.business, configureFields(product, true, 'carton', null));
    const { assertion } = mint({ actor, tenant: A.tenant, business: A.business, op: CONFIGURE, digest });
    const message = await refusal(() =>
      call(
        `SELECT (SELECT changed FROM inventory_configure_product($1, true, 'carton', NULL)), (SELECT changed FROM inventory_configure_product($1, true, 'carton', NULL))`,
        [product],
        {
          biz: A,
          assertion,
        },
      ),
    );
    expect(message).toMatch(/inventory\.assertion_replayed/);
  });

  it('a first use that rolled back rolled its consumption back with it — the same assertion may be retried', async () => {
    const digest = invpl(CONFIGURE, A.tenant, A.business, configureFields(product, true, 'dozen', null));
    const { assertion } = mint({ actor, tenant: A.tenant, business: A.business, op: CONFIGURE, digest });
    await call(`SELECT * FROM inventory_configure_product($1, true, 'dozen', NULL)`, [product], { biz: A, assertion, commit: false });
    const rows = await call<Configured>(`SELECT * FROM inventory_configure_product($1, true, 'dozen', NULL)`, [product], { biz: A, assertion });
    expect(rows[0]).toMatchObject({ unit_code: 'dozen', changed: true });
  });

  it('refuses arguments other than the ones that were signed', async () => {
    const message = await refusal(() => configure(A, product, true, 'gram', null, { mintFor: configureFields(product, true, 'kg', null) }));
    expect(message).toMatch(/inventory\.assertion_payload_mismatch/);
  });

  it('refuses an assertion minted for another operation', async () => {
    const message = await refusal(() => configure(A, product, true, 'kg', null, { op: ASSOCIATE }));
    expect(message).toMatch(/inventory\.assertion_wrong_operation/);
  });

  it('refuses a transaction scope that is not the asserted business', async () => {
    const message = await refusal(() => configure(A, product, true, 'kg', null, { scope: { tenant: B.tenant, business: B.business } }));
    expect(message).toMatch(/inventory\.assertion_scope_mismatch/);
  });

  it('refuses a forged signature, an unknown key, an expired assertion and one that lives too long', async () => {
    expect(await refusal(() => configure(A, product, true, 'kg', null, { claims: { secret: Buffer.alloc(32, 0x01) } }))).toMatch(
      /inventory\.assertion_invalid_signature/,
    );
    expect(await refusal(() => configure(A, product, true, 'kg', null, { claims: { kid: 'nobody' } }))).toMatch(/inventory\.assertion_key_unknown/);
    expect(await refusal(() => configure(A, product, true, 'kg', null, { claims: { exp: Math.floor(Date.now() / 1000) - 1 } }))).toMatch(
      /inventory\.assertion_expired/,
    );
    expect(await refusal(() => configure(A, product, true, 'kg', null, { claims: { exp: Math.floor(Date.now() / 1000) + 600 } }))).toMatch(
      /inventory\.assertion_ttl_exceeded/,
    );
    expect(await refusal(() => configure(A, product, true, 'kg', null, { assertion: 'invctl1.not.an.assertion' }))).toMatch(/inventory\.assertion_malformed/);
  });

  it('a product of another business is not found — the business is the asserted one, never an argument', async () => {
    expect(await refusal(() => configure(A, productB, true, 'kg', null))).toMatch(/inventory\.product_not_found/);
  });

  it('a present but malformed business_transaction_id is refused; the trace is never authority', async () => {
    for (const trace of ['not-a-uuid', randomUUID().toUpperCase(), ` ${randomUUID()}`]) {
      expect(await refusal(() => configure(A, product, true, 'kg', null, { trace })), trace).toMatch(/inventory\.trace_malformed/);
    }
  });
});

// ── the association routines and the warehouse lifecycle ──────────────────

describe('structure_associate / structure_dissociate_warehouse_branch (P3-AL-15 §B)', () => {
  const associated = async (warehouse: string, branch: string): Promise<boolean> =>
    (await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [warehouse, branch])).rowCount === 1;

  it('refuses both commands with no assertion', async () => {
    expect(await refusal(() => association(ASSOCIATE, A, A.warehouse, A.branch2, { assertion: null }))).toMatch(/inventory\.assertion_missing/);
    expect(await refusal(() => association(DISSOCIATE, A, A.warehouse, A.branch2, { assertion: null }))).toMatch(/inventory\.assertion_missing/);
    expect(await associated(A.warehouse, A.branch2)).toBe(false);
  });

  it('associates, audits once with the signed actor, and is idempotent', async () => {
    const trace = randomUUID();
    const first = await association(ASSOCIATE, A, A.warehouse, A.branch2, { trace });
    expect(first.changed).toBe(true);
    expect(await associated(A.warehouse, A.branch2)).toBe(true);
    const second = await association(ASSOCIATE, A, A.warehouse, A.branch2);
    expect(second.changed).toBe(false);
    const audit = await auditRows('structure.warehouse_branch_associated', A.warehouse);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: actor, business_id: A.business, entity: 'warehouse' });
    expect(audit[0]?.metadata).toEqual({ warehouseId: A.warehouse, branchId: A.branch2, assertionJti: first.jti, business_transaction_id: trace });
  });

  it('dissociates, audits once, and is idempotent', async () => {
    const first = await association(DISSOCIATE, A, A.warehouse, A.branch2);
    expect(first.changed).toBe(true);
    expect(await associated(A.warehouse, A.branch2)).toBe(false);
    expect((await association(DISSOCIATE, A, A.warehouse, A.branch2)).changed).toBe(false);
    const audit = await auditRows('structure.warehouse_branch_dissociated', A.warehouse);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toEqual({ warehouseId: A.warehouse, branchId: A.branch2, assertionJti: first.jti, business_transaction_id: null });
  });

  it('never removes the home association', async () => {
    expect(await refusal(() => association(DISSOCIATE, A, A.warehouse, A.branch))).toMatch(/inventory\.home_branch_association_required/);
    expect(await associated(A.warehouse, A.branch)).toBe(true);
  });

  it('a warehouse or branch of another business is not found, even with a valid assertion for this one (Row H)', async () => {
    expect(await refusal(() => association(ASSOCIATE, A, B.warehouse, A.branch2))).toMatch(/structure\.warehouse_not_found/);
    expect(await refusal(() => association(ASSOCIATE, A, A.warehouse, B.branch))).toMatch(/structure\.branch_not_found/);
    expect(await refusal(() => association(DISSOCIATE, A, B.warehouse, B.branch))).toMatch(/structure\.warehouse_not_found/);
    expect(await associated(A.warehouse, B.branch)).toBe(false);
  });

  it('an archived warehouse or branch cannot gain an association', async () => {
    const archivedWh = await one(ownerPool(), `INSERT INTO warehouses (business_id, branch_id, name) VALUES ($1, $2, 'Archived WH') RETURNING id`, [
      A.business,
      A.branch,
    ]);
    await ownerPool().query(`UPDATE warehouses SET status = 'archived' WHERE id = $1`, [archivedWh]);
    expect(await refusal(() => association(ASSOCIATE, A, archivedWh, A.branch2))).toMatch(/structure\.warehouse_archived/);
    const archivedBr = await one(ownerPool(), `INSERT INTO branches (business_id, name, status) VALUES ($1, 'Closed', 'archived') RETURNING id`, [A.business]);
    expect(await refusal(() => association(ASSOCIATE, A, A.warehouse, archivedBr))).toMatch(/structure\.branch_archived/);
  });

  it('the association routines refuse an assertion minted for the other one — the op code is inside the digest and the claims', async () => {
    const digest = invpl(ASSOCIATE, A.tenant, A.business, [
      ['uuid', A.warehouse],
      ['uuid', A.branch2],
    ]);
    const { assertion } = mint({ actor, tenant: A.tenant, business: A.business, op: ASSOCIATE, digest });
    const message = await refusal(() => call(`SELECT structure_dissociate_warehouse_branch($1, $2)`, [A.warehouse, A.branch2], { biz: A, assertion }));
    expect(message).toMatch(/inventory\.assertion_wrong_operation/);
  });
});

describe('the warehouse ↔ home-branch lifecycle (P3-AL-15 §A)', () => {
  it('a warehouse created by the merchant runtime gets exactly its home association', async () => {
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    let id = '';
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenant, A.business]);
      id = await one(c, `INSERT INTO warehouses (business_id, branch_id, name) VALUES ($1, $2, 'Runtime WH') RETURNING id`, [A.business, A.branch2]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const r = await ownerPool().query(`SELECT business_id, branch_id FROM branch_warehouses WHERE warehouse_id = $1`, [id]);
    expect(r.rows).toEqual([{ business_id: A.business, branch_id: A.branch2 }]);
  });

  it('Row D: with the maintainer switched off, a warehouse without its home association cannot commit', async () => {
    const c = await ownerPool().connect();
    const id = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE warehouses DISABLE TRIGGER warehouses_home_branch_maintain`);
      await c.query(`INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, $2, $3, 'Orphan WH')`, [A.business, id, A.branch]);
      await expect(c.query('COMMIT')).rejects.toThrow(/inventory\.home_branch_association_required/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const left = await ownerPool().query(`SELECT 1 FROM warehouses WHERE id = $1`, [id]);
    expect(left.rowCount).toBe(0);
    const trig = await ownerPool().query(`SELECT tgenabled::text AS e FROM pg_trigger WHERE tgname = 'warehouses_home_branch_maintain'`);
    expect(trig.rows).toEqual([{ e: 'O' }]);
  });

  /**
   * Lock row I: refused in raw SQL, not only through the command. The raw
   * writer here is the schema owner inside the business's own scope — the
   * scope every writer that can see a branch_warehouses row has (daftar_app
   * holds no DML; the migrator is under FORCE RLS and sees nothing without
   * one). The keep-one trigger reads `warehouses` as the internal principal
   * under that scope. Known limit, reported: a superuser with NO business
   * scope bypasses RLS on branch_warehouses while the trigger cannot see the
   * warehouse, so it is not refused — a superuser can disable triggers anyway.
   */
  it('the home association cannot be deleted or moved in raw SQL while the warehouse exists', async () => {
    const raw = async (sql: string, params: unknown[]): Promise<string> => {
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenant, A.business]);
        await c.query(sql, params);
        await c.query('COMMIT');
        return 'committed';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    expect(await raw(`DELETE FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.warehouse, A.branch])).toMatch(
      /inventory\.home_branch_association_required/,
    );
    expect(await raw(`UPDATE branch_warehouses SET branch_id = $3 WHERE warehouse_id = $1 AND branch_id = $2`, [A.warehouse, A.branch, A.branch2])).toMatch(
      /inventory\.home_branch_association_required/,
    );
    const still = await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.warehouse, A.branch]);
    expect(still.rowCount).toBe(1);
  });

  it('deleting a non-home association in raw SQL is allowed and leaves the home mapping intact (row J)', async () => {
    await ownerPool().query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      A.business,
      A.branch2,
      A.warehouse,
    ]);
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenant, A.business]);
      await c.query(`DELETE FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.warehouse, A.branch2]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const r = await ownerPool().query(`SELECT branch_id FROM branch_warehouses WHERE warehouse_id = $1`, [A.warehouse]);
    expect(r.rows).toEqual([{ branch_id: A.branch }]);
  });

  it("a warehouse's home branch is immutable", async () => {
    await expect(ownerPool().query(`UPDATE warehouses SET branch_id = $2 WHERE id = $1`, [A.warehouse, A.branch2])).rejects.toThrow(
      /inventory\.warehouse_home_branch_immutable/,
    );
  });

  it('deleting a warehouse takes its associations with it — the keep-home rule does not block the cascade', async () => {
    const id = await one(ownerPool(), `INSERT INTO warehouses (business_id, branch_id, name) VALUES ($1, $2, 'Doomed WH') RETURNING id`, [
      A.business,
      A.branch,
    ]);
    await ownerPool().query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [A.business, A.branch2, id]);
    await ownerPool().query(`DELETE FROM warehouses WHERE id = $1`, [id]);
    const r = await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1`, [id]);
    expect(r.rowCount).toBe(0);
  });

  it('every warehouse in the database has its home association', async () => {
    const r = await ownerPool().query(
      `SELECT w.id FROM warehouses w
       WHERE NOT EXISTS (SELECT 1 FROM branch_warehouses bw WHERE bw.business_id = w.business_id AND bw.warehouse_id = w.id AND bw.branch_id = w.branch_id)`,
    );
    expect(r.rows).toEqual([]);
  });
});

// ── TD-09 ──────────────────────────────────────────────────────────────────

describe('TD-09: no journal entry dated in the future, in the business timezone (P3-AL-36)', () => {
  // UTC+14 and UTC-11: 25 hours apart, so at every instant the eastern
  // business's today is strictly after the western one's.
  let east: Biz;
  let west: Biz;

  beforeAll(async () => {
    east = await seedBusiness('east', 'Pacific/Kiritimati');
    west = await seedBusiness('west', 'Pacific/Pago_Pago');
  });

  const todayIn = async (tz: string): Promise<string> =>
    (await ownerPool().query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).rows[0]?.d ?? '';
  const plusDays = async (d: string, n: number): Promise<string> =>
    (await ownerPool().query<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [d, n])).rows[0]?.d ?? '';

  /** A raw journal_entries INSERT by the schema owner, rolled back: 'accepted' or the refusal. */
  async function rawEntry(biz: Biz, entryDate: string): Promise<string> {
    const c = await ownerPool().connect();
    const entryId = randomUUID();
    const sourceId = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id) VALUES ($1, $2, 'manual_adjustment', $3, $4)`,
        [biz.tenant, biz.business, sourceId, entryId],
      );
      await c.query(`INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id) VALUES ($1, $2, $3, 'td-09', $4)`, [
        biz.tenant,
        biz.business,
        sourceId,
        actor,
      ]);
      await c.query(
        `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                      actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
         VALUES ($1, $2, $3, $4::date, 'manual_adjustment', $5, 'td-09', 'user', $6, NULL, 'td-09', repeat('a', 64))`,
        [biz.tenant, biz.business, entryId, entryDate, sourceId, actor],
      );
      return 'accepted';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  it("today in the business's own timezone is accepted, even from the schema owner", async () => {
    expect(await rawEntry(east, await todayIn('Pacific/Kiritimati'))).toBe('accepted');
    expect(await rawEntry(west, await todayIn('Pacific/Pago_Pago'))).toBe('accepted');
  });

  it("tomorrow in the business's own timezone is refused, even from the schema owner", async () => {
    expect(await rawEntry(east, await plusDays(await todayIn('Pacific/Kiritimati'), 1))).toMatch(/accounting\.entry_date_in_future/);
    expect(await rawEntry(west, await plusDays(await todayIn('Pacific/Pago_Pago'), 1))).toMatch(/accounting\.entry_date_in_future/);
  });

  it('the same date is today for one business and the future for the other: the rule reads the business timezone, not the server clock', async () => {
    const eastToday = await todayIn('Pacific/Kiritimati');
    expect(await rawEntry(east, eastToday)).toBe('accepted');
    expect(await rawEntry(west, eastToday)).toMatch(/accounting\.entry_date_in_future/);
  });

  it('the guard fires before the period guard, so a future date is reported as future', async () => {
    const r = await ownerPool().query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND NOT tgisinternal AND tgname IN ('accounting_entry_date_guard', 'accounting_period_guard') ORDER BY tgname`,
    );
    expect(r.rows.map((x) => x.tgname)).toEqual(['accounting_entry_date_guard', 'accounting_period_guard']);
    expect(await rawEntry(east, '2999-01-01')).toMatch(/accounting\.entry_date_in_future/);
  });
});

// ── the permission seed (P3-AL-38, P3-AL-53) ───────────────────────────────

describe('Phase 3 permissions (P3-AL-38, P3-AL-53)', () => {
  const PHASE3 = [
    'inventory.adjust',
    'inventory.stocktake',
    'inventory.transfer',
    'inventory.view',
    'purchases.manage',
    'purchases.receive',
    'purchases.return',
    'purchases.view',
    'suppliers.manage',
    'suppliers.pay',
    'suppliers.view',
  ];
  const MANAGER_PHASE1 = [
    'branch.manage',
    'branch.view',
    'business.view',
    'catalog.archive',
    'catalog.create',
    'catalog.update',
    'catalog.view',
    'category.manage',
    'media.manage',
    'member.invite',
    'member.view',
    'role.assign',
    'role.view',
    'settings.view',
    'subscription.view',
    'warehouse.manage',
    'warehouse.view',
  ];
  let onboarded = '';

  const perms = async (business: string, key: string): Promise<string[]> =>
    (
      await ownerPool().query<{ permission: string }>(
        `SELECT rp.permission FROM role_permissions rp JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
         WHERE rp.business_id = $1 AND r.key = $2 ORDER BY rp.permission`,
        [business, key],
      )
    ).rows.map((r) => r.permission);

  /** A real business through the accepted onboarding flow — provision_create_business writes its roles. */
  async function provision(name: string): Promise<string> {
    const t = await createTestApp();
    const reg = await t.request
      .post('/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'en' });
    const token = (reg.body.accessToken ?? reg.body.tokens?.accessToken) as string;
    const res = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-p3s1-${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: name, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `p3s1-${randomUUID().slice(0, 12)}`, preferredLocale: 'en' });
    expect(res.status).toBe(201);
    return res.body.businessId as string;
  }

  beforeAll(async () => {
    onboarded = await provision('Phase Three Shop');
  });

  it('the frozen writer marks only the owner as a system role — manager and cashier are template roles identified by key', async () => {
    const r = await ownerPool().query(`SELECT key, is_system FROM business_roles WHERE business_id = $1 ORDER BY key`, [onboarded]);
    expect(r.rows).toEqual([
      { key: 'cashier', is_system: false },
      { key: 'manager', is_system: false },
      { key: 'owner', is_system: true },
    ]);
  });

  it('a business provisioned after the migration: the owner holds all eleven', async () => {
    const owner = await perms(onboarded, 'owner');
    expect(PHASE3.filter((p) => !owner.includes(p))).toEqual([]);
  });

  it('…the manager holds exactly its accepted Phase 1 set plus the three view keys', async () => {
    expect(await perms(onboarded, 'manager')).toEqual([...MANAGER_PHASE1, 'inventory.view', 'purchases.view', 'suppliers.view'].sort());
  });

  it('…and the cashier holds no Phase 3 permission', async () => {
    const cashier = await perms(onboarded, 'cashier');
    expect(cashier.filter((p) => PHASE3.includes(p))).toEqual([]);
  });

  it('…and the onboarding flow wrote the home association of its default warehouse', async () => {
    const r = await ownerPool().query(
      `SELECT count(*)::int AS n FROM warehouses w JOIN branch_warehouses bw ON bw.warehouse_id = w.id AND bw.branch_id = w.branch_id WHERE w.business_id = $1`,
      [onboarded],
    );
    expect(r.rows).toEqual([{ n: 1 }]);
  });

  /**
   * The five assertions of 0057 are live code, not comments: re-applying the
   * file to today's database passes, and each tampering it exists to catch
   * makes it refuse. Every run is rolled back.
   */
  describe('0057 refuses to commit a wrong end state', () => {
    const file = readFileSync(join(__dirname, '../../infrastructure/database/migrations/0057_inventory_permissions.sql'), 'utf8');

    async function reapply(tamper: (c: PoolClient) => Promise<void>): Promise<string> {
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await tamper(c);
        await c.query(file);
        return 'committed';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const roleId = async (c: PoolClient, key: string): Promise<string> =>
      one(c, `SELECT id FROM business_roles WHERE business_id = $1 AND key = $2`, [onboarded, key]);
    const grant = async (c: PoolClient, role: string, permission: string): Promise<void> => {
      await c.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)`, [onboarded, role, permission]);
    };

    it('a business backfilled by 0057 ends identical, role key by role key, to one provisioned after it (P3-AL-53, fifth check)', async () => {
      // A business provisioned through the real flow, returned to its
      // pre-migration shape (no Phase 3 key on any role), then backfilled by
      // the migration file itself — committed, as a deployment would.
      const backfilled = await provision('Backfilled Shop');
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`DELETE FROM role_permissions WHERE business_id = $1 AND split_part(permission, '.', 1) IN ('inventory', 'purchases', 'suppliers')`, [
          backfilled,
        ]);
        await c.query(file);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      for (const key of ['owner', 'manager', 'cashier']) {
        expect(await perms(backfilled, key), key).toEqual(await perms(onboarded, key));
      }
      expect(await perms(backfilled, 'manager')).toContain('inventory.view');
    });

    it('re-applied to a correct database, it passes and changes nothing', async () => {
      expect(await reapply(async () => undefined)).toBe('committed');
    });

    it('a cashier holding a sensitive key: overreach', async () => {
      expect(await reapply(async (c) => grant(c, await roleId(c, 'cashier'), 'inventory.adjust'))).toMatch(/inventory\.permission_backfill_overreach/);
    });

    it('a cashier holding even an ordinary Phase 3 key: overreach', async () => {
      expect(await reapply(async (c) => grant(c, await roleId(c, 'cashier'), 'inventory.view'))).toMatch(/inventory\.permission_backfill_overreach/);
    });

    it('a manager holding a sensitive key: manager mismatch', async () => {
      expect(await reapply(async (c) => grant(c, await roleId(c, 'manager'), 'suppliers.pay'))).toMatch(/inventory\.permission_backfill_manager_mismatch/);
    });

    it('a custom role holding a sensitive key: overreach', async () => {
      expect(
        await reapply(async (c) => {
          const custom = await one(c, `INSERT INTO business_roles (business_id, key, name) VALUES ($1, $2, 'Stock clerk') RETURNING id`, [
            onboarded,
            `clerk-${Date.now()}`,
          ]);
          await grant(c, custom, 'inventory.transfer');
        }),
      ).toMatch(/inventory\.permission_backfill_overreach/);
    });

    it('a custom role holding an ordinary key is left exactly as it was', async () => {
      expect(
        await reapply(async (c) => {
          const custom = await one(c, `INSERT INTO business_roles (business_id, key, name) VALUES ($1, $2, 'Viewer') RETURNING id`, [
            onboarded,
            `viewer-${Date.now()}`,
          ]);
          await grant(c, custom, 'inventory.view');
        }),
      ).toBe('committed');
    });
  });
});
