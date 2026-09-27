/**
 * P3-S8 T-03 — EVERY OPERATION KIND HAS EXACTLY ONE CONSUMING ROUTINE, AND
 * NONE IS GENERIC (docs/PHASE_3_S8_CONTRACT.md A-05; L:1864, L:1928).
 *
 * Evaluated over the live catalogue, never over a list: the kinds are
 * `inventory_operation_kinds` (26 at the S7 head, and S8 registers none), the
 * routines are every `pg_proc` row in `public`, and a body is read as CODE
 * (comments stripped, literals tokenised — tests/helpers/phase3-surface.ts
 * `lexBody`), so neither a comment nor an error message can satisfy a clause.
 *
 *   1. for each kind exactly one routine calls
 *      `inventory_assertion_consume('<kind>'`, owned by the inventory
 *      principal, EXECUTE exactly {daftar_app};
 *   2. every caller of `inventory_assertion_consume` calls it exactly once,
 *      with a string LITERAL first argument (no parameter, variable, CASE or
 *      concatenation: no routine accepts a kind on another's behalf);
 *   3. the digest call inside that statement names the same kind;
 *   4. every kind named in an `inventory_assertion_current(ARRAY[…])` literal
 *      and every `inventory_operation_movement_kinds.op_code` is registered;
 *   5. no kind is generic (`inventory.write`, `*`, `%`, `,` …) and every kind
 *      matches `^[a-z]+(\.[a-z_]+)+$`;
 *   6. no routine consumes an unregistered kind.
 *
 * NEGATIVE CONTROLS in a scratch database built from the real migrations: a
 * second consumer of `inventory.adjust` (clause 1 names the kind), and a
 * routine calling `inventory_assertion_consume(p_op, …)` (clause 2 names the
 * routine).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanced, INVENTORY_INTERNAL, lexBody, registeredOpKinds } from '../helpers/phase3-surface';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import type { Queryable } from '../helpers/stock-ledger';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const KIND_SHAPE = /^[a-z]+(\.[a-z_]+)+$/;
const GENERIC = ['inventory.write', 'inventory.execute', 'trusted_inventory_command', '*', '%', ','];

interface Consumption {
  /** The routine, as `name(argtypes)`. */
  readonly sig: string;
  readonly owner: string;
  /** EXECUTE grantees other than the owner, sorted. */
  readonly grantees: readonly string[];
  /** The literal first argument of each consume call, or null where it is not a literal. */
  readonly ops: readonly (string | null)[];
  /** The literal first argument of the digest call inside each consume statement (null: none, or not a literal). */
  readonly digestOps: readonly (string | null)[];
  /** Every literal inside an `inventory_assertion_current(ARRAY[…])` call. */
  readonly currentOps: readonly string[];
}

interface Law {
  /** `kind → consuming routines` for every registered kind. */
  readonly consumers: Readonly<Record<string, string[]>>;
  readonly violations: readonly string[];
}

async function consumptions(q: Queryable): Promise<Consumption[]> {
  const r = await q.query<{ sig: string; owner: string; grantees: string[] | null; src: string }>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig, pg_get_userbyid(p.proowner) AS owner,
            (SELECT array_agg(z.g ORDER BY z.g) FROM (SELECT DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END AS g
                                                      FROM aclexplode(p.proacl) x WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) z) AS grantees,
            p.prosrc AS src
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname NOT IN ('inventory_assertion_consume', 'inventory_assertion_current')
        AND (p.prosrc ~ 'inventory_assertion_consume' OR p.prosrc ~ 'inventory_assertion_current')`,
  );
  const out: Consumption[] = [];
  for (const row of r.rows) {
    const { code, literals } = lexBody(row.src);
    const lit = (token: string | undefined): string | null => {
      const m = token === undefined ? null : /^'#(\d+)'$/.exec(token.trim());
      return m === null ? null : (literals[Number(m[1])] ?? null);
    };
    const ops: (string | null)[] = [];
    const digestOps: (string | null)[] = [];
    const consume = /\binventory_assertion_consume\s*\(/g;
    for (let m = consume.exec(code); m !== null; m = consume.exec(code)) {
      const call = balanced(code, m.index + m[0].length - 1);
      const first = /^\(\s*('#\d+'|[^,()]+)/.exec(call);
      ops.push(lit(first?.[1]));
      const digest = /\binventory_claimed_payload_digest\s*\(\s*('#\d+'|[^,()]+)/.exec(call);
      digestOps.push(lit(digest?.[1]));
    }
    const currentOps: string[] = [];
    const current = /\binventory_assertion_current\s*\(/g;
    for (let m = current.exec(code); m !== null; m = current.exec(code)) {
      const call = balanced(code, m.index + m[0].length - 1);
      for (const t of call.match(/'#\d+'/g) ?? []) {
        const v = lit(t);
        if (v !== null) currentOps.push(v);
      }
    }
    if (ops.length > 0 || currentOps.length > 0) out.push({ sig: row.sig, owner: row.owner, grantees: row.grantees ?? [], ops, digestOps, currentOps });
  }
  return out.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

async function operationKindLaw(q: Queryable): Promise<Law> {
  const kinds = await registeredOpKinds(q);
  const registered = new Set(kinds);
  const all = await consumptions(q);
  const consumers: Record<string, string[]> = Object.fromEntries(kinds.map((k) => [k, [] as string[]]));
  const v: string[] = [];
  for (const c of all) {
    // Clause 2: exactly once, literal first argument.
    if (c.ops.length > 1) v.push(`2: ${c.sig} consumes ${c.ops.length} times`);
    c.ops.forEach((op, i) => {
      if (op === null) {
        v.push(`2: ${c.sig} consumes a non-literal kind`);
        return;
      }
      // Clause 3: the digest names the same kind.
      if (c.digestOps[i] !== op) v.push(`3: ${c.sig} digests ${String(c.digestOps[i])} for ${op}`);
      // Clause 6: a consumed kind is registered.
      if (!registered.has(op)) v.push(`6: ${c.sig} consumes unregistered ${op}`);
      else consumers[op]?.push(c.sig);
    });
    // Clause 4 (current): every kind it accepts is registered.
    for (const op of c.currentOps) if (!registered.has(op)) v.push(`4: ${c.sig} accepts unregistered ${op} in inventory_assertion_current`);
  }
  // Clause 1: one consumer per kind, internal-owned, EXECUTE exactly {daftar_app}.
  for (const [kind, sigs] of Object.entries(consumers)) {
    if (sigs.length !== 1) v.push(`1: ${kind} has ${sigs.length} consumers${sigs.length > 0 ? ` (${sigs.join(', ')})` : ''}`);
    for (const sig of sigs) {
      const c = all.find((x) => x.sig === sig);
      if (c?.owner !== INVENTORY_INTERNAL) v.push(`1: ${sig} is owned by ${String(c?.owner)}`);
      if (JSON.stringify(c?.grantees) !== JSON.stringify(['daftar_app'])) v.push(`1: ${sig} EXECUTE ${JSON.stringify(c?.grantees)}`);
    }
  }
  // Clause 4 (mappings).
  const mapped = await q.query<{ op: string }>(`SELECT DISTINCT op_code::text AS op FROM inventory_operation_movement_kinds ORDER BY 1`);
  for (const r of mapped.rows) if (!registered.has(r.op)) v.push(`4: movement mapping names unregistered ${r.op}`);
  // Clause 5.
  for (const k of kinds) {
    if (!KIND_SHAPE.test(k)) v.push(`5: ${k} does not match ${String(KIND_SHAPE)}`);
    for (const g of GENERIC) if (k === g || k.includes(g)) v.push(`5: ${k} is generic (${g})`);
  }
  return { consumers, violations: v.sort() };
}

beforeAll(async () => {
  await ensurePostgres();
}, 300_000);

describe('T-03 — the operation-kind law over the catalogue (A-05)', () => {
  it('26 kinds are registered at the S8 head (S8 registers none), each with exactly one consuming routine', async () => {
    const law = await operationKindLaw(ownerPool());
    expect(Object.keys(law.consumers)).toHaveLength(26);
    for (const [kind, sigs] of Object.entries(law.consumers)) expect(sigs, kind).toHaveLength(1);
  });

  it('no violation of clauses 1–6', async () => {
    expect((await operationKindLaw(ownerPool())).violations).toEqual([]);
  });

  it('the consumers are 26 distinct routines, and no other routine calls inventory_assertion_consume', async () => {
    const law = await operationKindLaw(ownerPool());
    const sigs = Object.values(law.consumers).flat();
    expect(new Set(sigs).size).toBe(26);
    const consumers = (await consumptions(ownerPool())).filter((c) => c.ops.length > 0).map((c) => c.sig);
    expect([...consumers].sort()).toEqual([...sigs].sort());
  });

  it('the recogniser reads code, not text: a kind in a comment or an error message is not a consumption', async () => {
    const { code, literals } = lexBody(
      `-- inventory_assertion_consume('x.y', d)\nRAISE EXCEPTION 'inventory_assertion_consume(%)', 1; v := inventory_assertion_consume('a.b', inventory_claimed_payload_digest('a.b', x));`,
    );
    expect(code.match(/inventory_assertion_consume\s*\(/g)).toHaveLength(1);
    expect(literals).toContain('a.b');
  });
});

describe('T-03 NEGATIVE CONTROLS — a second consumer, and a kind taken from a parameter (A-05)', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t03_nc', { keys: false });
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped the scratch database obeys the law', async () => {
    expect((await operationKindLaw(scratch.pool)).violations).toEqual([]);
  });

  it('a second consumer of inventory.adjust: clause 1 names the kind and both routines', async () => {
    await scratch.pool.query(`
      CREATE FUNCTION t03_second_adjust(p_x uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_actor inventory_verified_actor;
      BEGIN
        v_actor := inventory_assertion_consume('inventory.adjust', inventory_claimed_payload_digest('inventory.adjust', ARRAY['uuid'], ARRAY[p_x::text]));
      END $$`);
    await scratch.pool.query(`ALTER FUNCTION t03_second_adjust(uuid) OWNER TO ${INVENTORY_INTERNAL}`);
    await scratch.pool.query(`REVOKE ALL ON FUNCTION t03_second_adjust(uuid) FROM PUBLIC`);
    await scratch.pool.query(`GRANT EXECUTE ON FUNCTION t03_second_adjust(uuid) TO daftar_app`);
    const v = (await operationKindLaw(scratch.pool)).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^1: inventory\.adjust has 2 consumers \(.*t03_second_adjust\(uuid\).*\)$/);
    await scratch.pool.query(`DROP FUNCTION t03_second_adjust(uuid)`);
  });

  it('consume(p_op, …): clause 2 names the routine that accepts a kind on another’s behalf', async () => {
    await scratch.pool.query(`
      CREATE FUNCTION t03_generic(p_op text, p_x uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_actor inventory_verified_actor;
      BEGIN
        v_actor := inventory_assertion_consume(p_op, inventory_claimed_payload_digest(p_op, ARRAY['uuid'], ARRAY[p_x::text]));
      END $$`);
    expect((await operationKindLaw(scratch.pool)).violations).toEqual(['2: t03_generic(text,uuid) consumes a non-literal kind']);
  });
});
