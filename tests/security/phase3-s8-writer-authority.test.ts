/**
 * P3-S8 T-02 — THE WRITER-AUTHORITY LAW, DISCOVERED FROM THE CATALOGUE
 * (docs/PHASE_3_S8_CONTRACT.md A-04; L:173, L:1837-1839; PM-44; rule 22's
 * live counterpart).
 *
 * For every Phase 3 routine (tests/helpers/phase3-surface.ts), of ANY owner,
 * whose body INSERTs into, UPDATEs or DELETEs from a truth table (a table the
 * inventory principal may write, from the ACL, minus the key domain and the
 * two logs):
 *
 *   1. its first executable statement is exactly one call of
 *      `inventory_assertion_consume(…)` or `inventory_assertion_current(…)`;
 *   2. every function called inside that call's arguments is IMMUTABLE or
 *      STABLE, writes nothing, and is a `pg_catalog` function or a routine
 *      of the inventory principal — a property of `pg_proc`, not a name list;
 *   3. it has no `EXCEPTION WHEN` block and no DECLARE initialiser that calls
 *      a function or runs a query.
 *
 * The exact exception set is `{warehouses_home_branch_maintain()}` (the
 * derived home-association maintainer, L:1837-1839, L:2161), asserted by
 * equality.
 *
 * DYNAMIC HALF: every discovered writer that is not a trigger function is
 * called AS ITS OWNER with a typed NULL for every argument and no
 * `app.inventory_assertion`; each refuses with `inventory.assertion_missing`
 * or `inventory.assertion_not_consumed`, and every truth table is
 * byte-identical (tests/helpers/table-digest.ts).
 *
 * NEGATIVE CONTROLS in a scratch database built from the real migrations: a
 * writer without the assertion call (the static law names it, and the NULL
 * call is NOT refused), and a writer whose consume arguments call a VOLATILE
 * function (clause 2 names it).
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanced, INVENTORY_INTERNAL, lexBody, phase3Routines, prefixCatalogue, truthTables } from '../helpers/phase3-surface';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import { settle, type Queryable } from '../helpers/stock-ledger';
import { changedTables, tableDigest } from '../helpers/table-digest';
import { dbUrl, ensurePostgres, ownerPool } from '../helpers/test-app';

/** A-04's exact exception set. */
const EXCEPTIONS = ['warehouses_home_branch_maintain()'];
const REFUSALS = ['inventory.assertion_missing', 'inventory.assertion_not_consumed'];

/** Words followed by `(` that are SQL syntax, not a function call. */
const NOT_A_CALL = new Set([
  'array',
  'row',
  'in',
  'any',
  'some',
  'all',
  'exists',
  'values',
  'cast',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'from',
  'join',
  'where',
  'and',
  'or',
  'not',
  'on',
  'select',
  'as',
  'by',
  'when',
  'then',
  'else',
  'is',
  'distinct',
  'lateral',
  'case',
  'with',
  'union',
  'intersect',
  'except',
  'using',
  'between',
  'like',
  'ilike',
  'into',
  'ordinality',
]);

interface Writer {
  readonly sig: string;
  readonly owner: string;
  readonly isTrigger: boolean;
  readonly tables: readonly string[];
  readonly problems: readonly string[];
}

/** The truth tables a body writes (INSERT INTO, UPDATE — not FOR [NO KEY] UPDATE / DO UPDATE —, DELETE FROM, MERGE INTO). */
function tablesWritten(code: string, truth: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bINSERT\s+INTO\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    /(?<!\bFOR\s+(?:NO\s+KEY\s+)?)(?<!\bDO\s+)\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    /\bMERGE\s+INTO\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) if (truth.has((m[1] ?? '').toLowerCase())) found.add((m[1] ?? '').toLowerCase());
  return [...found].sort();
}

/** The functions an expression calls, by bare name (never a `::type(p,s)` modifier or an `AS alias(cols)`). */
function calls(expression: string): string[] {
  const out: string[] = [];
  for (const m of expression.matchAll(/(?<!::\s*)(?<!\bAS\s+)(?<![\w.])(?:public\.|pg_catalog\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/g)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!NOT_A_CALL.has(name)) out.push(name);
  }
  return out;
}

interface CalleeFacts {
  /** every overload IMMUTABLE or STABLE */
  readonly pure: boolean;
  /** pg_catalog, or owned by the inventory principal */
  readonly trusted: boolean;
  /** no overload's body writes */
  readonly writesNothing: boolean;
  readonly known: boolean;
}

async function calleeFacts(q: Queryable, names: readonly string[]): Promise<Map<string, CalleeFacts>> {
  const r = await q.query<{ name: string; pure: boolean; trusted: boolean; src: string[] }>(
    `SELECT p.proname::text AS name, bool_and(p.provolatile IN ('i', 's')) AS pure,
            bool_and(p.pronamespace = 'pg_catalog'::regnamespace OR pg_get_userbyid(p.proowner) = $2) AS trusted,
            array_agg(CASE WHEN p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'internal') THEN '' ELSE p.prosrc END) AS src
       FROM pg_proc p
      WHERE p.proname = ANY ($1::text[]) AND p.pronamespace IN ('pg_catalog'::regnamespace, 'public'::regnamespace)
      GROUP BY p.proname`,
    [names, INVENTORY_INTERNAL],
  );
  const facts = new Map<string, CalleeFacts>();
  for (const x of r.rows) {
    const writesNothing = x.src.every(
      (s) => !/\b(INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO)\b|(?<!\bFOR\s+(?:NO\s+KEY\s+)?)(?<!\bDO\s+)\bUPDATE\s+[a-z_]/i.test(lexBody(s).code),
    );
    facts.set(x.name, { pure: x.pure, trusted: x.trusted, writesNothing, known: true });
  }
  return facts;
}

/** Every Phase 3 writer of a truth table on `q`, with the clause problems of each. */
async function writerLaw(q: Queryable): Promise<Writer[]> {
  const truth = new Set(await truthTables(q));
  const sigs = (await phase3Routines(q)).map((r) => r.sig);
  const r = await q.query<{ sig: string; owner: string; trg: boolean; src: string; lang: string }>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig, pg_get_userbyid(p.proowner) AS owner,
            p.prorettype = 'trigger'::regtype AS trg, p.prosrc AS src, l.lanname::text AS lang
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = ANY (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s)`,
    [sigs],
  );
  const writers: { sig: string; owner: string; trg: boolean; code: string; tables: string[] }[] = [];
  for (const x of r.rows) {
    const { code } = lexBody(x.src);
    const tables = tablesWritten(code, truth);
    if (tables.length > 0) writers.push({ sig: x.sig, owner: x.owner, trg: x.trg, code, tables });
  }
  const firsts = new Map<string, { first: string; args: string | null }>();
  const allCallees = new Set<string>();
  for (const w of writers) {
    const begin = /\bBEGIN\b(?:\s+ATOMIC\b)?/i.exec(w.code);
    const from = begin === null ? 0 : begin.index + begin[0].length;
    const end = w.code.indexOf(';', from);
    const first = w.code.slice(from, end < 0 ? w.code.length : end).trim();
    const m = /^(?:[A-Za-z_][A-Za-z0-9_.]*\s*:?=\s*|SELECT\s+|PERFORM\s+)?(?:public\.)?inventory_assertion_(?:consume|current)\s*\(/i.exec(first);
    const args = m === null ? null : balanced(first, m.index + m[0].length - 1);
    firsts.set(w.sig, { first, args });
    if (args !== null) for (const c of calls(args.slice(1, -1))) allCallees.add(c);
  }
  const facts = await calleeFacts(q, [...allCallees]);
  const out: Writer[] = [];
  for (const w of writers) {
    const problems: string[] = [];
    const f = firsts.get(w.sig);
    if (f === undefined || f.args === null) {
      problems.push('1: the first statement is not an assertion call');
    } else {
      const tail = f.first.slice(f.first.indexOf(f.args) + f.args.length);
      if (!/^\s*(?:INTO\s+(?:STRICT\s+)?[A-Za-z_][\w$.]*(?:\s*,\s*[A-Za-z_][\w$.]*)*)?\s*$/i.test(tail))
        problems.push('1: the first statement does more than the assertion call');
      for (const c of calls(f.args.slice(1, -1))) {
        const x = facts.get(c);
        if (x === undefined) problems.push(`2: calls unknown ${c}`);
        else {
          if (!x.pure) problems.push(`2: calls VOLATILE ${c}`);
          if (!x.trusted) problems.push(`2: calls ${c}, neither pg_catalog nor the inventory principal's`);
          if (!x.writesNothing) problems.push(`2: calls ${c}, which writes`);
        }
      }
    }
    if (/\bEXCEPTION\s+WHEN\b/i.test(w.code)) problems.push('3: EXCEPTION WHEN');
    const begin = /\bBEGIN\b/i.exec(w.code);
    if (begin !== null) {
      for (const item of w.code.slice(0, begin.index).split(';')) {
        if (/\bCURSOR\b[\s\S]*\b(?:FOR|IS)\b/i.test(item)) continue;
        const init = /(?::=|\bDEFAULT\b)([\s\S]*)$/i.exec(item);
        if (init === null) continue;
        if (calls(init[1] ?? '').length > 0 || /\bSELECT\b/i.test(init[1] ?? '')) problems.push('3: a DECLARE initialiser runs code');
      }
    }
    out.push({ sig: w.sig, owner: w.owner, isTrigger: w.trg, tables: w.tables, problems });
  }
  return out.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

const violators = (ws: readonly Writer[]): string[] => ws.filter((w) => w.problems.length > 0).map((w) => w.sig);

/**
 * Call `sig` as `owner` with a typed NULL for every argument and no assertion
 * carrier, inside a transaction that is always rolled back. Returns the
 * outcome and whether any truth table changed before the refusal.
 */
async function nullCall(url: string, sig: string, owner: string, truth: readonly string[]): Promise<{ code: string; changed: string[] }> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const t = await c.query<{ kind: string; args: string[] }>(
      `SELECT p.prokind::text AS kind, coalesce((SELECT array_agg(format_type(a.t, NULL) ORDER BY a.n) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(t, n)), '{}') AS args
         FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || $1)`,
      [sig],
    );
    const row = t.rows[0];
    if (row === undefined) throw new Error(`${sig} does not resolve`);
    const name = sig.slice(0, sig.indexOf('('));
    const call = `${row.kind === 'p' ? 'CALL' : 'SELECT'} ${name}(${row.args.map((a) => `NULL::${a}`).join(', ')})`;
    await c.query('BEGIN');
    const before = await tableDigest(c, truth);
    await c.query('SAVEPOINT null_call');
    await c.query(`SELECT set_config('app.inventory_assertion', '', true)`);
    await c.query(`SET LOCAL ROLE ${owner}`);
    const o = await settle(() => c.query(call));
    if (o.ok) {
      await c.query('RESET ROLE');
      return { code: 'ACCEPTED', changed: changedTables(before, await tableDigest(c, truth)) };
    }
    await c.query('ROLLBACK TO SAVEPOINT null_call');
    return { code: o.code === '' ? `${o.sqlstate} ${o.message}` : o.code, changed: changedTables(before, await tableDigest(c, truth)) };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

beforeAll(async () => {
  await ensurePostgres();
  await prefixCatalogue();
}, 300_000);

describe('T-02 — the writer law over the catalogue (A-04)', () => {
  it('the writers are real: every S2–S6 slice contributes, and each writes a truth table', async () => {
    const ws = await writerLaw(ownerPool());
    // Annex R #5: re-measured on the frozen tree, at least twenty (35 at S8 start).
    expect(ws.length).toBeGreaterThanOrEqual(20);
    for (const expected of [
      'inventory_apply_stock_movements',
      'inventory_adjust_stock',
      'purchase_receive',
      'purchase_return',
      'supplier_pay',
      'supplier_credit_note_consume',
    ]) {
      expect(
        ws.some((w) => w.sig.startsWith(`${expected}(`)),
        expected,
      ).toBe(true);
    }
  });

  it('the violators of clauses 1–3 are exactly the exception set {warehouses_home_branch_maintain()}', async () => {
    const ws = await writerLaw(ownerPool());
    expect(violators(ws)).toEqual(EXCEPTIONS);
    // The exception is what A-04 says: the maintainer, a trigger, writing only the home association.
    const m = ws.find((w) => w.sig === 'warehouses_home_branch_maintain()');
    expect({ trigger: m?.isTrigger, tables: m?.tables }).toEqual({ trigger: true, tables: ['branch_warehouses'] });
  });

  it('clause 2 is a property, not a list: every function the consume arguments call today is pure, trusted and writes nothing', async () => {
    const ws = await writerLaw(ownerPool());
    expect(ws.flatMap((w) => w.problems.filter((p) => p.startsWith('2:')).map((p) => `${w.sig} ${p}`))).toEqual([]);
  });

  it('the recogniser: FOR UPDATE and DO UPDATE are not writes; a write in a comment or a message is not a write', () => {
    const truth = new Set(['stock_levels']);
    expect(tablesWritten(lexBody(`SELECT 1 FROM stock_levels FOR UPDATE; INSERT INTO x VALUES (1) ON CONFLICT DO UPDATE SET y = 1;`).code, truth)).toEqual([]);
    expect(tablesWritten(lexBody(`-- UPDATE stock_levels\nRAISE EXCEPTION 'UPDATE stock_levels';`).code, truth)).toEqual([]);
    expect(tablesWritten(lexBody(`UPDATE public.stock_levels SET x = 1;`).code, truth)).toEqual(['stock_levels']);
    expect(calls(`'#1', inventory_claimed_payload_digest('#2', ARRAY['#3'] || array_fill('#4'::text, ARRAY[24]), ARRAY[p_x::numeric(28,4)::text])`)).toEqual([
      'inventory_claimed_payload_digest',
      'array_fill',
    ]);
  });
});

describe('T-02 — the dynamic half: every non-trigger writer, called as its owner with NULL arguments and no carrier, refuses first (A-04)', () => {
  it('each refuses with assertion_missing or assertion_not_consumed, and no truth table changes', async () => {
    const truth = await truthTables();
    const ws = (await writerLaw(ownerPool())).filter((w) => !w.isTrigger && !EXCEPTIONS.includes(w.sig));
    expect(ws.length).toBeGreaterThan(30);
    const wrong: string[] = [];
    for (const w of ws) {
      const r = await nullCall(dbUrl, w.sig, w.owner, truth);
      if (!REFUSALS.includes(r.code) || r.changed.length > 0) wrong.push(`${w.sig}: ${r.code} changed=${JSON.stringify(r.changed)}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('T-02 NEGATIVE CONTROLS — a writer without the assertion, and an impure consume argument (A-04)', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t02_nc', { keys: false });
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped the scratch database has exactly the exception set', async () => {
    expect(violators(await writerLaw(scratch.pool))).toEqual(EXCEPTIONS);
  });

  it('a writer with no assertion call: the static law names it, and its NULL call is NOT refused', async () => {
    await scratch.pool.query(`
      CREATE FUNCTION t02_rogue(p_business uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        -- A column the internal role may update (0059): the write is within its privileges, so only the law can catch it.
        UPDATE stock_levels SET last_stock_seq = last_stock_seq WHERE business_id = p_business;
      END $$`);
    await scratch.pool.query(`ALTER FUNCTION t02_rogue(uuid) OWNER TO ${INVENTORY_INTERNAL}`);
    const ws = await writerLaw(scratch.pool);
    expect(violators(ws)).toEqual(['t02_rogue(uuid)', ...EXCEPTIONS].sort());
    expect(ws.find((w) => w.sig === 't02_rogue(uuid)')?.problems).toEqual(['1: the first statement is not an assertion call']);
    const r = await nullCall(scratch.url(), 't02_rogue(uuid)', INVENTORY_INTERNAL, await truthTables(scratch.pool));
    expect(r.code).toBe('ACCEPTED');
    await scratch.pool.query(`DROP FUNCTION t02_rogue(uuid)`);
  });

  it('a consume argument calling a VOLATILE function: clause 2 names it', async () => {
    await scratch.pool.query(`
      CREATE FUNCTION t02_impure(p_business uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_actor inventory_verified_actor;
      BEGIN
        v_actor := inventory_assertion_consume('inventory.adjust', inventory_claimed_payload_digest('inventory.adjust', ARRAY['uuid'], ARRAY[gen_random_uuid()::text]));
        DELETE FROM stock_levels WHERE business_id = p_business;
      END $$`);
    await scratch.pool.query(`ALTER FUNCTION t02_impure(uuid) OWNER TO ${INVENTORY_INTERNAL}`);
    const ws = await writerLaw(scratch.pool);
    // Both halves of clause 2 name it: not pure, and (pgcrypto's copy in public resolves first) not a trusted catalogue function.
    expect(ws.find((w) => w.sig === 't02_impure(uuid)')?.problems).toEqual([
      '2: calls VOLATILE gen_random_uuid',
      "2: calls gen_random_uuid, neither pg_catalog nor the inventory principal's",
    ]);
  });
});
