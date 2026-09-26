import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalInventoryPayload,
  inventoryAssertionPreimage,
  inventoryPayloadSha256,
  mintInventoryAssertion,
  InventoryError,
  type InventoryOperationCode,
  type InventoryPayloadField,
} from '../../packages/inventory/src';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

/**
 * P3-S1 — ROW Q OF THE SIGNED-AUTHORITY MATRIX: `invpl/1` PARITY, TypeScript ↔
 * PostgreSQL, OVER EVERY SHARED VECTOR (P3-AL-55 §F). Independent adversarial
 * suite (Agent F).
 *
 * The SQL canonicalizer `inventory_payload_digest` is owned by
 * `daftar_inventory_internal` and has no EXECUTE grant — correctly. It is
 * called here in a rolled-back test-only transaction as the superuser with
 * `SET LOCAL ROLE daftar_inventory_internal`, i.e. as its owner. No runtime
 * grant is added anywhere.
 *
 * Three levels of parity are asserted for every vector:
 *
 *   1. BYTES. The SQL function returns only a digest, so the byte stream is
 *      obtained from the DEPLOYED body itself: `pg_get_functiondef` is read
 *      from the live catalogue, its final `RETURN encode(digest(…))` is
 *      rewritten to return the stream, and the result is installed as a
 *      pg_temp function inside a rolled-back transaction. Everything else in
 *      the body is byte-for-byte what the migration shipped; the rewrite is
 *      asserted to have touched exactly that one line.
 *   2. DIGEST. The real function, as its owner.
 *   3. THE ROUTINE PATH. `inventory_claimed_payload_digest`, fed exactly as
 *      the entry routines feed it — typed arguments cast to text in SQL
 *      (`::uuid::text`, `::boolean::text`, `::smallint::text`) — which is the
 *      digest a routine actually compares with component 7.
 *
 * Plus: the vectors that must differ do differ on both sides (associate vs
 * dissociate over identical ids, another business, swapped ids, NULL vs 0),
 * non-canonical input is refused by BOTH canonicalizers rather than
 * normalized by either, and the three `invctl/1` vectors reproduce their
 * preimage and MAC in TypeScript and in PostgreSQL's `hmac()`.
 */

interface VectorField {
  name: string;
  type: 'uuid' | 'boolean' | 'code' | 'integer';
  value: string | boolean | number | null;
}
interface InvplCase {
  name: string;
  opCode: InventoryOperationCode;
  tenantId: string;
  businessId: string;
  fields: VectorField[];
  canonicalHex: string;
  sha256: string;
}
interface InvctlCase {
  name: string;
  key: { kid: string; keyBase64: string; secretHex: string };
  claims: { actorUserId: string; tenantId: string; businessId: string; opCode: InventoryOperationCode; payloadSha256: string; jti: string };
  now: string;
  ttlSeconds: number;
  exp: string;
  wireOperation: string;
  preimage: string;
  mac: string;
  assertion: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/invpl-vectors.json'), 'utf8')) as {
  invpl: { cases: InvplCase[] };
  invctl: { cases: InvctlCase[] };
};
const INVPL = vectors.invpl.cases;
const INVCTL = vectors.invctl.cases;
const byName = (name: string): InvplCase => {
  const c = INVPL.find((x) => x.name === name);
  if (!c) throw new Error(`no vector named ${name}`);
  return c;
};

function tsField(f: VectorField): InventoryPayloadField {
  if (f.value === null) return { kind: 'null' };
  switch (f.type) {
    case 'uuid':
      return { kind: 'uuid', value: String(f.value) };
    case 'code':
      return { kind: 'code', value: String(f.value) };
    case 'boolean':
      if (typeof f.value !== 'boolean') throw new Error(`vector boolean ${f.name} is not a JSON boolean`);
      return { kind: 'boolean', value: f.value };
    case 'integer':
      if (typeof f.value !== 'number') throw new Error(`vector integer ${f.name} is not a JSON number`);
      return { kind: 'integer', value: f.value };
  }
}
/** The canonical SQL text of a field, or SQL NULL — what the routines pass after their own casts. */
const sqlText = (f: VectorField): string | null => (f.value === null ? null : String(f.value));

/** Superuser → owner, in a transaction that is always rolled back. */
async function asOwner<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    return await run(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const DIGEST_SQL = `SELECT inventory_payload_digest($1, $2::uuid, $3::uuid, $4::text[], $5::text[]) AS d`;
const RETURN_DIGEST = `RETURN encode(digest(v_stream, 'sha256'), 'hex');`;

/** Install the deployed canonicalizer body, returning its stream instead of the stream's hash, as pg_temp.invpl_stream_probe. */
async function installStreamProbe(c: PoolClient): Promise<void> {
  const def = (await c.query<{ d: string }>(`SELECT pg_get_functiondef('inventory_payload_digest(text,uuid,uuid,text[],text[])'::regprocedure) AS d`)).rows[0]
    ?.d;
  if (!def) throw new Error('inventory_payload_digest is not in the catalogue');
  const header = 'CREATE OR REPLACE FUNCTION public.inventory_payload_digest(';
  expect(def.split(header).length - 1, 'the deployed header appears exactly once').toBe(1);
  expect(def.split(RETURN_DIGEST).length - 1, 'the deployed digest return appears exactly once').toBe(1);
  const probe = def.replace(header, 'CREATE FUNCTION pg_temp.invpl_stream_probe(').replace(RETURN_DIGEST, `RETURN encode(v_stream, 'hex');`);
  await c.query(probe);
}

beforeAll(async () => {
  await ensurePostgres();
});

describe('the shared vectors are what the lock requires them to contain', () => {
  it('17 invpl/1 cases and 3 invctl/1 cases, over all three P3-S1 kinds', () => {
    expect(INVPL).toHaveLength(17);
    expect(INVCTL).toHaveLength(3);
    expect([...new Set(INVPL.map((c) => c.opCode))].sort()).toEqual([
      'inventory.configure_product',
      'structure.associate_warehouse_branch',
      'structure.dissociate_warehouse_branch',
    ]);
  });

  it('they include a NULL unit_code, a NULL unit_decimals, unit_decimals = 0, and associate/dissociate over identical ids', () => {
    const configure = INVPL.filter((c) => c.opCode === 'inventory.configure_product');
    expect(configure.some((c) => c.fields[2]?.value === null)).toBe(true);
    expect(configure.some((c) => c.fields[3]?.value === null)).toBe(true);
    expect(configure.some((c) => c.fields[3]?.value === 0)).toBe(true);
    const a = byName('associate_w1_br1');
    const d = byName('dissociate_w1_br1');
    expect([d.tenantId, d.businessId, d.fields.map((f) => f.value)]).toEqual([a.tenantId, a.businessId, a.fields.map((f) => f.value)]);
  });

  it('each vector is internally consistent: sha256 is the SHA-256 of canonicalHex', () => {
    for (const c of INVPL) expect(createHash('sha256').update(Buffer.from(c.canonicalHex, 'hex')).digest('hex'), c.name).toBe(c.sha256);
  });
});

describe('Row Q — every invpl/1 vector, byte for byte and digest for digest, in TypeScript and in PostgreSQL', () => {
  it.each(INVPL.map((c) => [c.name, c] as const))('%s — TypeScript bytes and digest', (_name, c) => {
    const fields = c.fields.map(tsField);
    expect(canonicalInventoryPayload(c.opCode, c.tenantId, c.businessId, fields).toString('hex')).toBe(c.canonicalHex);
    expect(inventoryPayloadSha256(c.opCode, c.tenantId, c.businessId, fields)).toBe(c.sha256);
  });

  it.each(INVPL.map((c) => [c.name, c] as const))(
    '%s — PostgreSQL bytes (the deployed body) and digest (the deployed function, as its owner)',
    async (_name, c) => {
      const types = c.fields.map((f) => f.type);
      const values = c.fields.map(sqlText);
      const [bytes, digest] = await asOwner(async (conn) => {
        await installStreamProbe(conn);
        const b = await conn.query<{ s: string }>(`SELECT pg_temp.invpl_stream_probe($1, $2::uuid, $3::uuid, $4::text[], $5::text[]) AS s`, [
          c.opCode,
          c.tenantId,
          c.businessId,
          types,
          values,
        ]);
        await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
        const d = await conn.query<{ d: string }>(DIGEST_SQL, [c.opCode, c.tenantId, c.businessId, types, values]);
        return [b.rows[0]?.s, d.rows[0]?.d];
      });
      expect(bytes).toBe(c.canonicalHex);
      expect(digest).toBe(c.sha256);
    },
  );

  it.each(INVPL.map((c) => [c.name, c] as const))(
    '%s — the routine path: typed arguments cast in SQL, under the claimed tenant and business',
    async (_name, c) => {
      const digest = await asOwner(async (conn) => {
        await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
        // Only components 4 and 5 are read by the claimed-digest helper; the
        // rest merely make a ten-component carrier.
        await conn.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [`invctl1.k.x.${c.tenantId}.${c.businessId}.x.x.x.x.x`]);
        if (c.opCode === 'inventory.configure_product') {
          const [id, track, unit, decimals] = c.fields.map((f) => f.value);
          return (
            await conn.query<{ d: string }>(
              `SELECT inventory_claimed_payload_digest('inventory.configure_product', ARRAY['uuid', 'boolean', 'code', 'integer'],
                    ARRAY[$1::uuid::text, $2::boolean::text, $3::text, $4::smallint::text]) AS d`,
              [id, track, unit, decimals],
            )
          ).rows[0]?.d;
        }
        const [warehouse, branch] = c.fields.map((f) => f.value);
        return (
          await conn.query<{ d: string }>(`SELECT inventory_claimed_payload_digest($1, ARRAY['uuid', 'uuid'], ARRAY[$2::uuid::text, $3::uuid::text]) AS d`, [
            c.opCode,
            warehouse,
            branch,
          ])
        ).rows[0]?.d;
      });
      expect(digest).toBe(c.sha256);
    },
  );
});

describe('Row Q — what must differ does differ, on both sides', () => {
  const pairs: [string, string, string][] = [
    ['associate vs dissociate over identical ids (the op_code line)', 'associate_w1_br1', 'dissociate_w1_br1'],
    ['the same dissociation in another business', 'dissociate_w1_br1', 'dissociate_w1_br1_other_business'],
    ['the same configuration in another business', 'configure_track_piece_0', 'configure_other_business'],
    ['warehouse and branch swapped', 'associate_w1_br1', 'associate_br1_w1_swapped'],
    ['NULL precision vs precision 0', 'configure_untracked_null_null', 'configure_null_code_decimals_0'],
  ];
  it.each(pairs)('%s', async (_name, left, right) => {
    const [l, r] = [byName(left), byName(right)];
    expect(l.sha256).not.toBe(r.sha256);
    const sql = await asOwner(async (conn) => {
      await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
      const one = async (c: InvplCase): Promise<string | undefined> =>
        (await conn.query<{ d: string }>(DIGEST_SQL, [c.opCode, c.tenantId, c.businessId, c.fields.map((f) => f.type), c.fields.map(sqlText)])).rows[0]?.d;
      return [await one(l), await one(r)];
    });
    expect(sql).toEqual([l.sha256, r.sha256]);
  });

  it('every one of the 17 vectors has a distinct digest', () => {
    expect(new Set(INVPL.map((c) => c.sha256)).size).toBe(INVPL.length);
  });
});

describe('Row Q — non-canonical input is refused by BOTH canonicalizers, never normalized', () => {
  const base = byName('configure_track_piece_0');
  type Tamper = [string, number, VectorField['type'], string];
  const tampers: Tamper[] = [
    ['an uppercase product uuid', 0, 'uuid', base.fields[0]?.value?.toString().toUpperCase() ?? ''],
    ['a product uuid without hyphens', 0, 'uuid', base.fields[0]?.value?.toString().replace(/-/g, '') ?? ''],
    ['a braced product uuid', 0, 'uuid', `{${String(base.fields[0]?.value)}}`],
    ['a unit in uppercase', 2, 'code', 'PIECE'],
    ['a unit with a trailing space', 2, 'code', 'piece '],
    ['a unit of 33 characters', 2, 'code', `u${'x'.repeat(32)}`],
    ['an empty unit (not NULL)', 2, 'code', ''],
    ['a unit starting with a digit', 2, 'code', '9piece'],
    ['a unit with a line feed', 2, 'code', 'pie\nce'],
  ];

  it.each(tampers)('%s', async (_name, index, type, value) => {
    // TypeScript refuses before a byte is produced.
    const tsFields = base.fields.map(tsField);
    tsFields[index] = type === 'uuid' ? { kind: 'uuid', value } : { kind: 'code', value };
    let tsCode = '';
    try {
      canonicalInventoryPayload(base.opCode, base.tenantId, base.businessId, tsFields);
    } catch (e) {
      tsCode = e instanceof InventoryError ? e.code : String(e);
    }
    expect(tsCode).toBe('inventory.payload_invalid');

    // PostgreSQL refuses too, with the same stable code.
    const values = base.fields.map(sqlText);
    values[index] = value;
    const message = await asOwner(async (conn) => {
      await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
      try {
        await conn.query(DIGEST_SQL, [base.opCode, base.tenantId, base.businessId, base.fields.map((f) => f.type), values]);
        return 'accepted';
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return `${err.code ?? ''} ${err.message ?? ''}`;
      }
    });
    expect(message).toMatch(/^P0001 inventory\.payload_invalid:/);
  });

  it.each([
    ['a leading-zero integer', '01'],
    ['a plus-signed integer', '+1'],
    ['negative zero', '-0'],
    ['a decimal', '1.0'],
    ['whitespace around an integer', ' 1'],
  ])('PostgreSQL refuses %s in an integer field (the TypeScript side takes integers as numbers, never as text)', async (_name, value) => {
    const values = base.fields.map(sqlText);
    values[3] = value;
    const message = await asOwner(async (conn) => {
      await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
      return conn.query(DIGEST_SQL, [base.opCode, base.tenantId, base.businessId, base.fields.map((f) => f.type), values]).then(
        () => 'accepted',
        (e: unknown) => String((e as { message?: string }).message),
      );
    });
    expect(message).toMatch(/^inventory\.payload_invalid:/);
  });

  it.each([
    ['TRUE', 'TRUE'],
    ['t', 't'],
    ['1', '1'],
  ])('PostgreSQL refuses the boolean spelling %s', async (_name, value) => {
    const values = base.fields.map(sqlText);
    values[1] = value;
    const message = await asOwner(async (conn) => {
      await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
      return conn.query(DIGEST_SQL, [base.opCode, base.tenantId, base.businessId, base.fields.map((f) => f.type), values]).then(
        () => 'accepted',
        (e: unknown) => String((e as { message?: string }).message),
      );
    });
    expect(message).toMatch(/^inventory\.payload_invalid:/);
  });

  it('TypeScript refuses a field list of the wrong length, an unregistered kind, and a NULL product; PostgreSQL refuses an unknown field type', async () => {
    const fields = base.fields.map(tsField);
    const code = (run: () => unknown): string => {
      try {
        run();
        return 'accepted';
      } catch (e) {
        return e instanceof InventoryError ? e.code : String(e);
      }
    };
    expect(code(() => canonicalInventoryPayload(base.opCode, base.tenantId, base.businessId, fields.slice(0, 3)))).toBe('inventory.payload_invalid');
    expect(code(() => canonicalInventoryPayload('inventory.transfer' as InventoryOperationCode, base.tenantId, base.businessId, fields))).toBe(
      'inventory.payload_invalid',
    );
    expect(code(() => canonicalInventoryPayload(base.opCode, base.tenantId, base.businessId, [{ kind: 'null' }, ...fields.slice(1)]))).toBe(
      'inventory.payload_invalid',
    );
    const message = await asOwner(async (conn) => {
      await conn.query(`SET LOCAL ROLE daftar_inventory_internal`);
      return conn.query(DIGEST_SQL, [base.opCode, base.tenantId, base.businessId, ['uuid', 'boolean', 'text', 'integer'], base.fields.map(sqlText)]).then(
        () => 'accepted',
        (e: unknown) => String((e as { message?: string }).message),
      );
    });
    expect(message).toMatch(/^inventory\.payload_invalid:/);
  });
});

describe('Row Q — the three invctl/1 vectors: preimage and MAC in TypeScript and in PostgreSQL', () => {
  it.each(INVCTL.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const secret = Buffer.from(c.key.keyBase64, 'base64');
    expect(secret.toString('hex')).toBe(c.key.secretHex);

    // TypeScript: the package's minter reproduces the whole assertion from the vector's clock.
    const minted = mintInventoryAssertion(c.claims, { kid: c.key.kid, secret }, new Date(c.now), c.ttlSeconds);
    expect(minted).toBe(c.assertion);
    const nine = c.assertion.split('.').slice(0, 9);
    expect(inventoryAssertionPreimage(nine).toString('utf8')).toBe(c.preimage);
    expect(nine[5]).toBe(c.wireOperation);
    expect(nine[7]).toBe(c.exp);
    expect(createHmac('sha256', secret).update(c.preimage, 'utf8').digest('hex')).toBe(c.mac);

    // PostgreSQL: the exact expression the verifier uses at step 4.
    const sqlMac = await asOwner(
      async (conn) =>
        (
          await conn.query<{ m: string }>(
            `SELECT encode(hmac(convert_to('invctl/1' || E'\\n' || array_to_string((string_to_array($1, '.'))[1:9], '.'), 'UTF8'), decode($2, 'hex'), 'sha256'), 'hex') AS m`,
            [c.assertion, c.key.secretHex],
          )
        ).rows[0]?.m,
    );
    expect(sqlMac).toBe(c.mac);
  });
});
