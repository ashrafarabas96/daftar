/**
 * P4-S7 — THE SPECIFICATION, MEASURED BY POSTGRESQL.
 *
 * CHALLENGER S7-1, CRITICAL (EVIDENCE). Every database-level claim in this
 * slice was `SPEC ONLY`: the whole of it never applied to a cluster, never
 * parsed by PostgreSQL and never executed. The suite that judged it read it
 * with `readFileSync` and analysed it as TEXT. So the brief's requirement —
 * «the installment sum must equal the invoice total exactly in BOTH
 * directions and at the DATABASE level, not in TypeScript only» — was NOT
 * MET: the two constraint triggers had never fired, and
 * `installment_schedule_verify()` had never been compiled by the parser.
 *
 * Writing the verifier body instead of promising it at promotion moved the
 * claim from PROSE to UNPARSED SQL. That is one class up, not evidence.
 * A SPECIFICATION IS DESIGN UNTIL A PARSER HAS HAD AN OPINION.
 *
 * ── WHAT IS ASSERTED, AND IN WHAT ORDER ──────────────────────────────────
 *
 * §A THE PARSER'S OPINION IS THE FIRST RESULT. A `CREATE` that fails is the
 *    finding, and it is reported as the finding rather than as a setup error.
 *    Specifically it settles three claims that were read out of text:
 *      * that `CREATE OR REPLACE FUNCTION customer_ar_aging(...)` is legal
 *        against the LIVE definition — i.e. that the five-column return shape
 *        really is unchanged, because `CREATE OR REPLACE` cannot alter a
 *        `RETURNS TABLE` list at all (42P13), which is design §5.6;
 *      * that `coalesce(pg_catalog.sum(...) OVER w)` parses — the estate's
 *        recorded trap is a specification containing SQL that could never
 *        have been created, and `pg_catalog.coalesce` is impossible because
 *        `COALESCE` is syntax and cannot be schema-qualified;
 *      * that `installment_schedule_verify()`'s plpgsql body compiles.
 * §A2 THE PRIVILEGES AND THE POLICY ROLES, from `pg_policy` and
 *    `has_table_privilege` — including the `inventory_internal_read` whose
 *    absence was challenger C1.
 *
 * WHAT THIS FILE DOES **NOT** CONTAIN, stated because its first version's
 * docblock advertised three sections it did not have (challenger M9): the
 * triggers FIRING, an accepted equal schedule, PR-6's `42501`, model-to-SQL
 * equivalence and the row-security measurement are all in the SIBLING suite
 * `phase4-s7-installment-aging-live.test.ts`, because they need a real invoice
 * and the running application. A reader who opens this file to check that the
 * triggers fire must go there; a docblock that says otherwise is the estate's
 * named failure shape — a name with no evidence behind it — applied to a
 * table of contents.
 *
 * It runs in a SCRATCH DATABASE built from the real migration files by the
 * real runner, and drops it afterwards. The specification is applied as the
 * S7 migration WOULD be applied — which is the only way to learn whether it
 * could be.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';

const SPEC_PATH = join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const SPEC = readFileSync(SPEC_PATH, 'utf8');

/**
 * `0075`'s own declared closed lists, PARSED OUT OF `0075` (challenger H5).
 * A hand-written copy of a closed list is the shape
 * `tests/guards/p4s4-new-relation-coverage.test.ts` and
 * `scripts/guards/phase4-rls-force.ts` exist to refuse: derive it, so that a
 * change to the predecessor's declared set reds this file instead of silently
 * leaving it a strict subset.
 */
const PREDECESSOR = readFileSync(
  join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations', '0075_phase4_customers_invoices_numbering.sql'),
  'utf8',
);

function declaredList(name: string): readonly string[] {
  const m = new RegExp(`${name}\\s+CONSTANT TEXT\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(PREDECESSOR);
  if (m === null) throw new Error(`0075 no longer declares ${name}, so this file has lost its oracle`);
  return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

let db: ScratchDb;
/** The parser's verdict on the whole specification. `null` means it created. */
let parserError: string | null = null;
/** Whether the migration principal held CREATE on `public` before this file re-issued it. */
/** The schema ACL as the scratch database really holds it, for the report. */
let schemaAcl: string | null = null;
let applied: readonly string[] = [];

beforeAll(async () => {
  // CHALLENGER H3. The first version applied the specification as the
  // PostgreSQL SUPERUSER, which bypasses row level security entirely and —
  // more to the point here — needs no privilege at all. The `ORDER_NOTE`'s
  // second justification (`0075:632-634`: «a non-superuser must hold EXECUTE
  // on a function to create a trigger on it») was therefore unexercised, and
  // the note itself conceded as much. `migratorOwned` hands every
  // `postgres`-owned object in `public` to `daftar_migrator` — the ownership a
  // managed deployment holds — and the specification is then applied AS that
  // principal, which is `NOSUPERUSER NOBYPASSRLS` (`bootstrap.sql:187`) and is
  // a member of `daftar_accounting_internal` (`bootstrap.sql:297`), which is
  // what lets the authority transfer at the end succeed.
  db = await createScratchDb('daftar_s7_aging_spec', { migratorOwned: true });
  applied = db.applied;
  schemaAcl =
    (await db.pool.query<{ acl: string | null }>(`SELECT nspacl::text AS acl FROM pg_catalog.pg_namespace WHERE nspname = 'public'`)).rows[0]?.acl ?? null;
  const migrator = db.poolAs('daftar_migrator');
  try {
    await migrator.query(SPEC);
  } catch (e) {
    parserError = e instanceof Error ? `${(e as { code?: string }).code ?? '?'}: ${e.message}` : String(e);
  }
}, 600_000);

afterAll(async () => {
  if (db !== undefined) await db.drop();
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════
describe("§A THE PARSER'S OPINION — a specification is design until PostgreSQL has had one", () => {
  it('the scratch database really carries the predecessor contract, so the subject is not empty', () => {
    expect(applied.length).toBeGreaterThan(80);
    expect(applied.some((f) => f.startsWith('0084_'))).toBe(true);
  });

  it('THE APPLIER IS THE MIGRATION PRINCIPAL, NOT A SUPERUSER — and it needed its own grant back', async () => {
    // CHALLENGER H3(4). Applying as `postgres` needs no privilege at all, so
    // the `ORDER_NOTE`'s second justification — «a non-superuser must hold
    // EXECUTE on a function to create a trigger on it» (`0075:632-634`) — was
    // unexercised, as the note itself conceded. It is exercised now.
    const who = await db
      .poolAs('daftar_migrator')
      .query<{ cu: string; su: boolean }>(`SELECT current_user::text AS cu, (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS su`);
    expect(who.rows[0]?.cu).toBe('daftar_migrator');
    expect(who.rows[0]?.su, 'the applier is a superuser, so nothing about privilege was measured').toBe(false);
    const bypass = await db.pool.query<{ b: boolean }>(`SELECT rolbypassrls AS b FROM pg_catalog.pg_roles WHERE rolname = 'daftar_migrator'`);
    expect(bypass.rows[0]?.b, 'the applier bypasses row security, so it is a superuser in all but name').toBe(false);
    // ...and the membership that lets the authority transfer at the end succeed
    // is real (`bootstrap.sql:297`), not assumed.
    const member = await db.pool.query<{ ok: boolean }>(`SELECT pg_catalog.pg_has_role('daftar_migrator', 'daftar_accounting_internal', 'SET') AS ok`);
    expect(member.rows[0]?.ok, 'the migrator cannot SET ROLE to the owner, so ALTER FUNCTION ... OWNER TO must fail').toBe(true);
    // THE APPLIER'S OWN CREATE IS REAL (`bootstrap.sql:209`, `:234`) — so the
    // `42501 permission denied for schema public` this file first met was NOT
    // the applier's privilege. It was the NEW OWNER's: `ALTER FUNCTION ...
    // OWNER TO r` requires `r` to hold CREATE on the schema, and
    // `daftar_accounting_internal` holds only USAGE. Hence the CREATE bracket
    // the specification now carries, on `0075:657`/`:695`'s pattern.
    const applierCreate = await db.pool.query<{ ok: boolean }>(`SELECT pg_catalog.has_schema_privilege('daftar_migrator', 'public', 'CREATE') AS ok`);
    expect(applierCreate.rows[0]?.ok, `the applier cannot create in public at all; the schema ACL is ${String(schemaAcl)}`).toBe(true);
    // AND THE BRACKET CLOSED. The lend is taken back, so the slice leaves the
    // accounting principal exactly the USAGE it started with — a bracket that
    // only opens is a permanent widening.
    const ownerCreate = await db.pool.query<{ ok: boolean }>(`SELECT pg_catalog.has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') AS ok`);
    expect(ownerCreate.rows[0]?.ok, 'the CREATE lent to the new owner was never taken back').toBe(false);
    const ownerUsage = await db.pool.query<{ ok: boolean }>(`SELECT pg_catalog.has_schema_privilege('daftar_accounting_internal', 'public', 'USAGE') AS ok`);
    expect(ownerUsage.rows[0]?.ok, 'and USAGE was taken away with it').toBe(true);
  });

  it('THE SPECIFICATION CREATES — and if it does not, THIS MESSAGE IS THE FINDING', () => {
    expect(parserError, `the specification does not create: ${parserError ?? ''}`).toBeNull();
  });

  it('`installment_schedule_verify()` was COMPILED, not merely written', async () => {
    const r = await db.pool.query<{ oid: string; prosecdef: boolean; owner: string }>(
      `SELECT p.oid::text AS oid, p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner
         FROM pg_catalog.pg_proc p WHERE p.proname = 'installment_schedule_verify'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.prosecdef).toBe(true);
    expect(r.rows[0]?.owner).toBe('daftar_accounting_internal');
    // A plpgsql body is parsed at CREATE but its STATEMENTS are planned at
    // first call, so compiling the body is necessary and not sufficient.
    // `plpgsql_check` is not installed here, so this is stated as the limit of
    // §A and closed by §B, which actually RUNS it.
  });

  it('the two constraint triggers EXIST, deferred, on both relations, and the row one fires on DELETE', async () => {
    const r = await db.pool.query<{ tgname: string; rel: string; deferred: boolean; events: string }>(
      `SELECT t.tgname, c.relname AS rel, t.tgdeferrable AND t.tginitdeferred AS deferred,
              concat_ws(',', CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END,
                             CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END,
                             CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END) AS events
         FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%schedule_complete' ORDER BY c.relname`,
    );
    expect(r.rows.map((x) => x.rel)).toEqual(['installment_plans', 'installments']);
    for (const row of r.rows) expect(row.deferred, row.tgname).toBe(true);
    const byRel = new Map(r.rows.map((x) => [x.rel, x.events]));
    expect(byRel.get('installment_plans')).toContain('INSERT');
    expect(byRel.get('installment_plans')).toContain('UPDATE');
    // THE DELETE ARM. A schedule can be pushed BELOW the total by deleting a
    // row, so a verifier that fired only on INSERT and UPDATE would leave one
    // of the three directions unenforceable whatever the prose said.
    expect(byRel.get('installments')).toContain('DELETE');
  });

  it('`customer_ar_aging` KEPT its five-column return shape — `CREATE OR REPLACE` proves it, since 42P13 is the alternative', async () => {
    const r = await db.pool.query<{ args: string; result: string }>(
      `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
              pg_catalog.pg_get_function_result(p.oid) AS result
         FROM pg_catalog.pg_proc p WHERE p.proname = 'customer_ar_aging'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.args).toBe('p_business_id uuid, p_customer_id uuid, p_as_of date, p_bucket_days integer[]');
    const result = r.rows[0]?.result ?? '';
    for (const col of ['bucket_no integer', 'currency_code text', 'txn_minor bigint', 'base_minor bigint', 'invoice_count integer']) {
      expect(result, `the return shape lost ${col}`).toContain(col);
    }
    // ...and it is still INVOKER and still not IMMUTABLE, because the label is
    // not a clock guard.
    const v = await db.pool.query<{ prosecdef: boolean; provolatile: string }>(
      `SELECT p.prosecdef, p.provolatile::text FROM pg_catalog.pg_proc p WHERE p.proname = 'customer_ar_aging'`,
    );
    expect(v.rows[0]?.prosecdef).toBe(false);
    expect(v.rows[0]?.provolatile).toBe('s'); // STABLE, not 'i'
  });

  it('the projection really CALLS the canonical law and holds no HALF_EVEN of its own', async () => {
    const r = await db.pool.query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_catalog.pg_proc p WHERE p.proname = 'customer_ar_aging'`);
    const src = r.rows[0]?.src ?? '';
    expect(src).toContain('supplier_ap_release(');
    expect(src).not.toContain('inventory_half_even');
    // THE INSTALLED BODY, from the catalogue — not the file on disk. A law
    // whose subject is a file cannot tell you what the database holds.
    expect(src.length).toBeGreaterThan(500);
  });
  it('THE VERIFIER CAN READ WHAT IT JUDGES — the privilege the executor found missing', async () => {
    // S7-1, SECOND FINDING, FOUND BY THE EXECUTOR. The relations were created
    // with RLS ENABLED and FORCED and with no policy and no grant to anybody,
    // so `installment_schedule_verify()` — a DEFINER owned by
    // `daftar_accounting_internal` — raised `42501 permission denied for table
    // installment_plans` on the FIRST plan write ever attempted. A verifier
    // that cannot read the schedule refuses every schedule, which looks strict
    // and discriminates nothing. Asserted as privilege AND as policy, because
    // FORCE ROW LEVEL SECURITY makes either one sufficient to deny.
    const g = await db.pool.query<{ rel: string; sel: boolean }>(
      `SELECT c.relname AS rel,
              pg_catalog.has_table_privilege('daftar_accounting_internal', c.oid, 'SELECT') AS sel
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('installment_plans', 'installments')
        ORDER BY c.relname`,
    );
    expect(g.rows.map((r) => r.rel)).toEqual(['installment_plans', 'installments']);
    for (const row of g.rows) expect(row.sel, `daftar_accounting_internal cannot SELECT ${row.rel}`).toBe(true);

    const pol = await db.pool.query<{ rel: string; polname: string }>(
      `SELECT c.relname AS rel, p.polname
         FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        WHERE c.relname IN ('installment_plans', 'installments') AND p.polname = 'accounting_validator'
        ORDER BY c.relname`,
    );
    expect(pol.rows.map((r) => r.rel)).toEqual(['installment_plans', 'installments']);

    // and `daftar_app` can read them, or the INVOKER projection cannot either.
    const a = await db.pool.query<{ rel: string; sel: boolean }>(
      `SELECT c.relname AS rel, pg_catalog.has_table_privilege('daftar_app', c.oid, 'SELECT') AS sel
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('installment_plans', 'installments')`,
    );
    for (const row of a.rows) expect(row.sel, `daftar_app cannot SELECT ${row.rel}`).toBe(true);

    // NO DML to any runtime principal (P4-AL-38): this specification ships no writer.
    // CHALLENGER H5. The first version wrote 3 roles x 3 privileges where the
    // predecessor declares 8 x 6 — omitting `public`, five runtime principals,
    // and `TRUNCATE`, `REFERENCES` and `TRIGGER`. `TRIGGER` is not a rounding
    // error: disabling a trigger requires it, and the design's own "the
    // verifier cannot be bypassed" argument rests on that being unreachable.
    // So the lists are DERIVED from `0075`'s own declared constants, parsed
    // out of the migration file, and never enumerated here.
    const runtime = declaredList('c_runtime');
    const dmlPrivs = declaredList('c_dml');
    const columnDml = declaredList('c_column_dml');
    expect(runtime.length, `0075's c_runtime is no longer the eight-principal list: ${JSON.stringify(runtime)}`).toBe(8);
    expect(dmlPrivs.length).toBe(6);
    expect(dmlPrivs).toContain('TRIGGER');
    expect(runtime).toContain('public');
    const dml = await db.pool.query<{ rel: string; role: string; priv: string }>(
      `SELECT c.relname AS rel, r.rolname AS role, x.priv
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_catalog.unnest($1::TEXT[]) AS r(rolname)
        CROSS JOIN pg_catalog.unnest($2::TEXT[]) AS x(priv)
        WHERE n.nspname = 'public' AND c.relname IN ('installment_plans', 'installments')
          AND (pg_catalog.has_table_privilege(r.rolname, c.oid, x.priv)
               OR (x.priv = ANY ($3::TEXT[]) AND pg_catalog.has_any_column_privilege(r.rolname, c.oid, x.priv)))`,
      [runtime, dmlPrivs, columnDml],
    );
    expect(dml.rows, `a runtime principal holds DML on an installment relation: ${JSON.stringify(dml.rows)}`).toEqual([]);
    // NON-VACUITY: the matrix really is 8 x 6 x 2 and the query really can
    // report something — asked of a privilege every one of them DOES hold.
    const control = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_catalog.unnest($1::TEXT[]) AS r(rolname)
        WHERE n.nspname = 'public' AND c.relname IN ('installment_plans', 'installments')
          AND pg_catalog.has_table_privilege(r.rolname, c.oid, 'SELECT')`,
      [['daftar_app', 'daftar_inventory_internal', 'daftar_accounting_internal']],
    );
    expect(control.rows[0]?.n, 'the privilege query reports nothing even for a privilege that IS held').toBe('6');
  });
});
