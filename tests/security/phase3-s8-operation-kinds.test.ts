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
import { type PoolClient } from 'pg';
import { OP_KIND_BUILDERS } from '../helpers/op-kind-builders';
import { balanced, INVENTORY_INTERNAL, lexBody, opKindRegistrants, phase3RegisteredOpKinds, registeredOpKinds } from '../helpers/phase3-surface';
import { P3C_OPERATION_KINDS } from '../helpers/p3c-migrations';
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
  it('26 kinds are registered by Phase 3 at the S8 head (S8 registers none) plus exactly the corrective kinds (P3-C), and every registered kind has exactly one consuming routine', async () => {
    const law = await operationKindLaw(ownerPool());
    // P4-AL-88. The COUNT is scoped by provenance — `registered_by ~ '^P3-'`,
    // the registry's own column, which `0074` widened so a later phase can
    // register a kind — because "there are exactly N kinds" is a closure rule
    // and not an invariant. The LAW below is deliberately NOT scoped: every
    // registered kind, whichever phase registered it, must have exactly one
    // consuming routine, and the partition assertion is what keeps the two
    // halves from leaving a gap between them.
    const registrants = await opKindRegistrants();
    const phase3Kinds = await phase3RegisteredOpKinds();
    expect(phase3Kinds).toHaveLength(26 + P3C_OPERATION_KINDS.length);
    const registered = Object.keys(registrants).sort();
    const beyond = registered.filter((k) => !phase3Kinds.includes(k));
    expect(
      phase3Kinds.filter((k) => beyond.includes(k)),
      'the two scopes are disjoint',
    ).toEqual([]);
    expect([...phase3Kinds, ...beyond].sort(), 'and together they are the whole registry').toEqual(registered);
    // The law's own surface is the whole registry, both ways.
    expect(Object.keys(law.consumers).sort(), 'the law is evaluated over every registered kind').toEqual(registered);
    for (const [kind, sigs] of Object.entries(law.consumers)) expect(sigs, kind).toHaveLength(1);
    // Phase 3 corrective (0072): the kinds registered after the S8 head are
    // exactly the reviewed corrective list, each registered by 'P3-C'.
    const corrective = await ownerPool().query<{ op: string }>(
      `SELECT op_code::text AS op FROM inventory_operation_kinds WHERE registered_by = 'P3-C' ORDER BY 1`,
    );
    expect(corrective.rows.map((r) => r.op)).toEqual([...P3C_OPERATION_KINDS].sort());
  });

  it('no violation of clauses 1–6', async () => {
    expect((await operationKindLaw(ownerPool())).violations).toEqual([]);
  });

  it('the consumers are 26 distinct routines (plus one per corrective kind), and no other routine calls inventory_assertion_consume', async () => {
    // P4-AL-88, the same shape as the count above and for the same reason:
    // "there are exactly N consuming routines" is a CLOSURE RULE, not an
    // invariant. `0078` makes it false by registering the first consumer a
    // later phase owns — `sale_commit`, which consumes `sale.commit` — and the
    // original sentence was about PHASE 3's consumers all along.
    //
    // So the 26 is kept WORD FOR WORD, scoped by the provenance of the KINDS
    // (`registered_by ~ '^P3-'`, discovered from the registry rather than from
    // a name list), the later phases' half is asserted SEPARATELY and
    // POSITIVELY, and a closure assertion states the two are the whole. The
    // second half — no routine calls `inventory_assertion_consume` that the
    // law does not account for — stays UNSCOPED, over every phase's consumers,
    // because that is the security claim and it was never a closure rule.
    const law = await operationKindLaw(ownerPool());
    const phase3Kinds = await phase3RegisteredOpKinds();
    const sigsOf = (kinds: readonly string[]): readonly string[] => [...new Set(kinds.flatMap((k) => law.consumers[k] ?? []))].sort();

    const phase3Sigs = sigsOf(phase3Kinds);
    expect(new Set(phase3Sigs).size).toBe(26 + P3C_OPERATION_KINDS.length);

    // The later phases' half, positively: every kind beyond the Phase 3 scope
    // HAS a consumer (an unconsumed kind would otherwise vanish from the
    // claim), and no routine serves both scopes — so the two consumer sets are
    // disjoint and the whole is really the sum of the two halves rather than
    // an overlap nobody counted.
    const beyondKinds = Object.keys(law.consumers)
      .filter((k) => !phase3Kinds.includes(k))
      .sort();
    for (const k of beyondKinds) expect(law.consumers[k], `${k} is registered beyond Phase 3 and must still have its one consumer`).toHaveLength(1);
    const beyondSigs = sigsOf(beyondKinds);
    expect(
      beyondSigs.filter((sig) => phase3Sigs.includes(sig)),
      'no routine consumes both a Phase 3 kind and a later phase kind, so the two consumer sets are disjoint',
    ).toEqual([]);

    // Closure: the two scopes together are every consumer the law accounts
    // for, and that set is exactly the set of routines that call
    // `inventory_assertion_consume` at all — the original second half,
    // unscoped.
    const sigs = Object.values(law.consumers).flat();
    expect([...new Set(sigs)].sort(), 'the two scopes are the whole set of consumers the law accounts for').toEqual([...phase3Sigs, ...beyondSigs].sort());
    const consumers = (await consumptions(ownerPool())).filter((c) => c.ops.length > 0).map((c) => c.sig);
    expect([...consumers].sort()).toEqual([...new Set(sigs)].sort());
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

/**
 * ── P4-AL-88 proof: the provenance-scoped registry claims, both directions ──
 *
 * `0074` widened `inventory_operation_kinds.registered_by` from
 * `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$` so that a later phase can register an
 * operation kind. The two claims that were exact over the whole registry —
 * the COUNT here and `OP_KIND_BUILDERS = registeredOpKinds()` in
 * `tests/security/phase3-s8-signed-authority-matrix.test.ts` — are now scoped
 * to `registered_by ~ '^P3-'`. This proves the scoping, in both directions,
 * by actually registering a later-phase kind inside a transaction that is
 * always rolled back, which is what the widening made possible.
 */
describe('P4-AL-88 — the provenance scope of the registry claims', () => {
  let owner: PoolClient;

  beforeAll(async () => {
    owner = await ownerPool().connect();
  });

  afterAll(() => {
    owner.release();
  });

  const planted = async (plant: readonly string[], body: () => Promise<void>): Promise<void> => {
    await owner.query('BEGIN');
    try {
      for (const sql of plant) await owner.query(sql);
      await body();
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  };

  const builders = Object.keys(OP_KIND_BUILDERS).sort();

  it('GREEN with a later-phase kind registered: the scoped claims hold, the unscoped one would not, and the LAW reaches it', async () => {
    /**
     * ── P4-AL-88, a second time, on this proof's OWN expectations ────────
     *
     * Two lines of this proof were themselves closure rules about the phase
     * that follows, and `0077` — which registers `sale.commit` as `P4-S2`,
     * the first real later-phase registration this proof was written to
     * anticipate — turned them red for exactly the reason the proof exists
     * to demonstrate:
     *
     *   - `beyond === ['sale.issue_invoice']` said "the plant is the ONLY
     *     kind outside the Phase 3 scope";
     *   - `registeredOpKinds() === phase3RegisteredOpKinds()` after the
     *     rollback said "once the plant is gone the registry is Phase 3's
     *     and nothing else".
     *
     * Both are re-expressed against the beyond-scope half the LIVE registry
     * already holds, read here before the plant: the plant must be accounted
     * for positively on top of it, and a kind that appeared from anywhere
     * else is still named. Nothing is dropped from either claim — the
     * registry is still covered end to end, by the two halves together.
     */
    const beyondBefore = (await registeredOpKinds()).filter((k) => !builders.includes(k));
    const registrantsBefore = await opKindRegistrants();
    expect(
      beyondBefore.filter((k) => !/^P[0-9]+-S[0-9]+$/.test(registrantsBefore[k] ?? '') || /^P3-/.test(registrantsBefore[k] ?? '')),
      'every kind already beyond the Phase 3 scope records a well-formed later-phase registrant',
    ).toEqual([]);
    await planted([`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.issue_invoice', 'P4-S2')`], async () => {
      const registrants = await opKindRegistrants(owner);
      const phase3Kinds = await phase3RegisteredOpKinds(owner);
      const all = await registeredOpKinds(owner);
      // The kind is really registered, and really outside the Phase 3 scope.
      expect(all).toContain('sale.issue_invoice');
      expect(phase3Kinds).not.toContain('sale.issue_invoice');
      expect(registrants['sale.issue_invoice']).toBe('P4-S2');
      // SCOPED: both re-expressed claims are green.
      expect(phase3Kinds).toHaveLength(26 + P3C_OPERATION_KINDS.length);
      expect(builders).toEqual(phase3Kinds);
      // The partition still covers the whole registry.
      const beyond = all.filter((k) => !phase3Kinds.includes(k));
      expect([...phase3Kinds, ...beyond].sort()).toEqual([...all].sort());
      // The plant lands outside the scope, and the beyond-scope half is
      // exactly what was already there PLUS the plant — so nothing arrived
      // unaccounted for and nothing was merely dropped from the claim.
      expect(beyond, 'the plant on top of the beyond-scope kinds already registered').toEqual([...beyondBefore, 'sale.issue_invoice'].sort());
      // UNSCOPED, for contrast: the claim as it was written is red — which is
      // the breakage this re-expression removes.
      expect(builders).not.toEqual(all);
      // And the LAW is not scoped: it reaches the new kind and refuses it,
      // because nothing consumes it yet. A later phase's migration satisfies
      // the law by shipping the consuming routine with the registration.
      const law = await operationKindLaw(owner);
      expect(Object.keys(law.consumers)).toContain('sale.issue_invoice');
      expect(law.violations).toEqual(['1: sale.issue_invoice has 0 consumers']);
    });
    // Rolled back: the registry is as it was — the Phase 3 half exactly, the
    // beyond-scope half exactly, and the two together the whole of it. The
    // plant is gone from both.
    const after = await registeredOpKinds();
    expect(await phase3RegisteredOpKinds(), 'the Phase 3 half is untouched').toEqual(builders);
    expect(
      after.filter((k) => !builders.includes(k)),
      'the beyond-scope half is untouched',
    ).toEqual(beyondBefore);
    expect([...builders, ...beyondBefore].sort(), 'and the two halves are the whole registry again').toEqual([...after].sort());
    expect(after, 'the plant is gone').not.toContain('sale.issue_invoice');
    expect((await operationKindLaw(ownerPool())).violations).toEqual([]);
  }, 120_000);

  it('RED: a kind registered by a PHASE 3 registrant with no builder is still named by the scoped claim', async () => {
    await planted([`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('purchase.probe_unbuilt', 'P3-S9')`], async () => {
      const phase3Kinds = await phase3RegisteredOpKinds(owner);
      expect(phase3Kinds).toContain('purchase.probe_unbuilt');
      expect(phase3Kinds).toHaveLength(26 + P3C_OPERATION_KINDS.length + 1);
      expect(builders).not.toEqual(phase3Kinds);
      expect(phase3Kinds.filter((k) => !builders.includes(k))).toEqual(['purchase.probe_unbuilt']);
    });
  }, 120_000);

  it('RED: a kind whose registrant is not of the accepted shape is named, so the beyond-scope half is not vacuous', async () => {
    // The 0074 CHECK refuses a malformed registrant outright, which is the
    // strongest form of this: the provenance cannot be omitted or invented.
    await owner.query('BEGIN');
    try {
      await expect(owner.query(`INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.issue_invoice', 'P4')`)).rejects.toThrow(
        /inventory_operation_kinds_registered_by_check/,
      );
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  });
});
