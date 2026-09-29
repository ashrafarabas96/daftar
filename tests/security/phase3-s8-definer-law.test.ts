/**
 * P3-S8 T-05 — THE SECURITY DEFINER LAW OVER EVERY PHASE 3 ROUTINE
 * (docs/PHASE_3_S8_CONTRACT.md A-08 with the rulings-header amendment of
 * TL-3; L:1689-1694; PM-43).
 *
 * The §D sweep of `search-path-shadowing.test.ts` covers the routines OWNED
 * by the inventory principal. This suite evaluates the seven clauses over
 * `phase3Routines()` — every routine created after 0052 plus every
 * pre-Phase-3 routine whose body changed — whoever owns it:
 *
 *   1. a SECURITY DEFINER routine pins exactly
 *      `search_path=pg_catalog, public, pg_temp` (pg_temp named and last);
 *   2. its owner is NOLOGIN and one of the two internal principals;
 *   3. PUBLIC may not EXECUTE any Phase 3 routine, definer or invoker;
 *   4. a trigger function has no EXECUTE grantee at all;
 *   5. no routine creates, or depends on, a temporary relation;
 *   6. dynamic SQL only as `EXECUTE format('…%I…%L…')` (none exists today);
 *   7. no Phase 3 DEFINER routine is owned by `daftar_migrator` (or by the
 *      superuser that stands in for it when the harness applies the
 *      migrations).
 *
 * The exception set was `{provision_actor(text[])}` for clauses 1, 2 and 7
 * (TL-3 as amended: re-created by its owner, the migrator, in 0061 for TD-13,
 * keeping its accepted Phase 1 owner and path). TD-18 (0070) closed it:
 * provision_actor and the three other routines 0037-0039 left to the applier
 * now have NOLOGIN internal owners and the pinned path, so the set is EMPTY.
 * It is asserted by EQUALITY: a clause's violators must be exactly the
 * exception set, so a new violator fails, and so does an owner reverted to
 * the applier. `accounting_actor` is internal-owned and passes every clause.
 *
 * NEGATIVE CONTROLS in a scratch database built from the real migrations: the
 * path order of `supplier_pay` reversed (clause 1 names it), a routine handed
 * to the migrator (clauses 2 and 7 name it), and PUBLIC given EXECUTE
 * (clause 3 names it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTING_INTERNAL,
  CATALOG_INTERNAL,
  INVENTORY_INTERNAL,
  lexBody,
  phase3Routines,
  prefixCatalogue,
  PROVISIONING_INTERNAL,
} from '../helpers/phase3-surface';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import type { Queryable } from '../helpers/stock-ledger';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const PINNED = 'search_path=pg_catalog, public, pg_temp';
/** TL-3 as amended, closed by TD-18 (0070): no replaced pre-Phase-3 routine keeps an applier owner or a public-first path. */
const TL3_EXCEPTIONS: string[] = [];

interface ClauseViolations {
  readonly c1: string[];
  readonly c2: string[];
  readonly c3: string[];
  readonly c4: string[];
  readonly c5: string[];
  readonly c6: string[];
  readonly c7: string[];
}

interface RoutineRow {
  sig: string;
  definer: boolean;
  config: string[] | null;
  owner: string;
  owner_login: boolean;
  owner_deployer: boolean;
  public_exec: boolean;
  is_trigger: boolean;
  exec_grantees: string[] | null;
  acl_null: boolean;
  src: string;
  temp_dep: boolean;
}

/** Clause 6: every EXECUTE outside a literal is `EXECUTE format('<literal with only %I %L %%>' …`. */
function dynamicSqlProblem(src: string): string | null {
  const { code, literals } = lexBody(src);
  const re = /\bEXECUTE\b/gi;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const rest = code.slice(m.index);
    const f = /^EXECUTE\s+format\s*\(\s*'#(\d+)'/i.exec(rest);
    if (f === null) return `EXECUTE not followed by format('…'): ${rest.slice(0, 60)}`;
    const lit = literals[Number(f[1])] ?? '';
    const placeholders = lit.match(/%[^%]|%%/g) ?? [];
    const bad = placeholders.filter((p) => p !== '%I' && p !== '%L' && p !== '%%');
    if (bad.length > 0) return `format placeholder ${bad.join(',')} in ${JSON.stringify(lit)}`;
  }
  return null;
}

/** The violators of each clause among the Phase 3 routines of the database `q` reads. */
async function definerLawViolations(q: Queryable): Promise<ClauseViolations> {
  const sigs = (await phase3Routines(q)).map((r) => r.sig);
  const r = await q.query<RoutineRow>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
            p.prosecdef AS definer, p.proconfig AS config,
            o.rolname::text AS owner, o.rolcanlogin AS owner_login, (o.rolsuper OR o.rolname = 'daftar_migrator') AS owner_deployer,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
            p.prorettype = 'trigger'::regtype AS is_trigger,
            (SELECT array_agg(z.g ORDER BY z.g)
               FROM (SELECT DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS g
                       FROM aclexplode(p.proacl) x WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) z) AS exec_grantees,
            p.proacl IS NULL AS acl_null,
            p.prosrc AS src,
            EXISTS (SELECT 1 FROM pg_depend d JOIN pg_class c ON d.refclassid = 'pg_class'::regclass AND c.oid = d.refobjid
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND (n.nspname LIKE 'pg\\_temp\\_%' OR c.relpersistence = 't')) AS temp_dep
       FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
      WHERE p.oid = ANY (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s)`,
    [sigs],
  );
  if (r.rows.length !== sigs.length) throw new Error(`resolved ${r.rows.length} of ${sigs.length} Phase 3 routines`);
  const internal = new Set([INVENTORY_INTERNAL, ACCOUNTING_INTERNAL, CATALOG_INTERNAL, PROVISIONING_INTERNAL]);
  const pick = (f: (x: RoutineRow) => boolean): string[] =>
    r.rows
      .filter(f)
      .map((x) => x.sig)
      .sort();
  return {
    c1: pick((x) => x.definer && JSON.stringify(x.config) !== JSON.stringify([PINNED])),
    c2: pick((x) => x.definer && (x.owner_login || !internal.has(x.owner))),
    c3: pick((x) => x.public_exec),
    c4: pick((x) => x.is_trigger && (x.acl_null || (x.exec_grantees ?? []).length > 0)),
    c5: pick((x) => x.temp_dep || /\bCREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY)\b/i.test(lexBody(x.src).code)),
    c6: pick((x) => dynamicSqlProblem(x.src) !== null),
    c7: pick((x) => x.definer && x.owner_deployer),
  };
}

const SHIPPED: ClauseViolations = { c1: TL3_EXCEPTIONS, c2: TL3_EXCEPTIONS, c3: [], c4: [], c5: [], c6: [], c7: TL3_EXCEPTIONS };

beforeAll(async () => {
  await ensurePostgres();
  await prefixCatalogue();
}, 300_000);

describe('T-05 — the seven clauses over phase3Routines(), with exactly the TL-3 exception set (A-08)', () => {
  it('the surface is real: definers of the internal principals, trigger functions, and the replaced pre-Phase-3 routines', async () => {
    const routines = await phase3Routines();
    expect(routines.filter((r) => r.replaced).map((r) => r.sig)).toEqual([
      'accounting_actor(text[])',
      'catalog_identifier_norm(text,text)',
      'catalog_identifiers_sync()',
      'provision_actor(text[])',
      'provision_assertion_key_install(text,bytea)',
      'provision_assertion_key_retire(text)',
    ]);
    const owners = await ownerPool().query<{ o: string; n: number }>(
      `SELECT pg_get_userbyid(p.proowner) AS o, count(*)::int AS n FROM pg_proc p
        WHERE p.prosecdef AND p.oid = ANY (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s) GROUP BY 1 ORDER BY 1`,
      [routines.map((r) => r.sig)],
    );
    const byOwner = Object.fromEntries(owners.rows.map((x) => [x.o, x.n]));
    expect(byOwner[INVENTORY_INTERNAL]).toBeGreaterThan(100);
    expect(byOwner[ACCOUNTING_INTERNAL]).toBeGreaterThan(10);
  });

  it('every clause’s violators are exactly its exception set: none, for every clause (TD-18 closed TL-3)', async () => {
    expect(await definerLawViolations(ownerPool())).toEqual(SHIPPED);
  });

  /**
   * "The migrator" is the principal that applied the migrations: daftar_migrator
   * on a managed deployment, the superuser in this harness (the shared database
   * is built by the superuser). Both are reported as `<deployment principal>`;
   * clause 7 treats them alike for the same reason.
   */
  it('the former exception is closed: provision_actor and the three other 0037-0039 definers have internal owners and the pinned path; accounting_actor passes every clause', async () => {
    const r = await ownerPool().query<{ sig: string; owner: string; definer: boolean; config: string[] | null }>(
      `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
              CASE WHEN o.rolsuper OR o.rolname = 'daftar_migrator' THEN '<deployment principal>' ELSE o.rolname::text END AS owner,
              p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
        WHERE p.oid IN (to_regprocedure('public.provision_actor(text[])'), to_regprocedure('public.accounting_actor(text[])'),
                        to_regprocedure('public.catalog_identifiers_sync()'), to_regprocedure('public.provision_assertion_key_install(text,bytea)'),
                        to_regprocedure('public.provision_assertion_key_retire(text)')) ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { sig: 'accounting_actor(text[])', owner: ACCOUNTING_INTERNAL, definer: true, config: [PINNED] },
      { sig: 'catalog_identifiers_sync()', owner: CATALOG_INTERNAL, definer: true, config: [PINNED] },
      { sig: 'provision_actor(text[])', owner: PROVISIONING_INTERNAL, definer: true, config: [PINNED] },
      { sig: 'provision_assertion_key_install(text,bytea)', owner: PROVISIONING_INTERNAL, definer: true, config: [PINNED] },
      { sig: 'provision_assertion_key_retire(text)', owner: PROVISIONING_INTERNAL, definer: true, config: [PINNED] },
    ]);
  });

  it('clause 6 recogniser: a format with %I/%L is admitted, a %s or a bare string EXECUTE is not, and text inside literals and comments is ignored', () => {
    expect(dynamicSqlProblem(`BEGIN EXECUTE format('ALTER TABLE %I OWNER TO %I', 'a', 'b'); END`)).toBeNull();
    expect(dynamicSqlProblem(`BEGIN RAISE EXCEPTION 'x: never EXECUTE this'; -- EXECUTE 'y'\n END`)).toBeNull();
    expect(dynamicSqlProblem(`BEGIN EXECUTE format('SELECT %s', p_x); END`)).toMatch(/%s/);
    expect(dynamicSqlProblem(`BEGIN EXECUTE 'SELECT ' || p_x; END`)).toMatch(/not followed by format/);
    expect(dynamicSqlProblem(`BEGIN EXECUTE v_sql; END`)).toMatch(/not followed by format/);
  });
});

describe('T-05 NEGATIVE CONTROLS — each removed invariant is named by its clause (A-08)', () => {
  let scratch: ScratchDb;
  let supplierPay: string;
  let guard: string;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t05_nc', { keys: false });
    const sig = async (name: string): Promise<string> => {
      const r = await scratch.pool.query<{ s: string }>(
        `SELECT oid::regprocedure::text AS s FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
        [name],
      );
      const only = r.rows[0];
      if (r.rows.length !== 1 || only === undefined) throw new Error(`expected one ${name}`);
      return only.s.replace(/^public\./, '');
    };
    supplierPay = await sig('supplier_pay');
    guard = await sig('supplier_payment_guard');
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped, the scratch database has exactly the shipped violations', async () => {
    expect(await definerLawViolations(scratch.pool)).toEqual(SHIPPED);
  });

  it('PM-43 path order reversed on supplier_pay → clause 1 names it', async () => {
    await scratch.pool.query(`ALTER FUNCTION ${supplierPay} SET search_path = public, pg_temp, pg_catalog`);
    expect((await definerLawViolations(scratch.pool)).c1).toEqual([...TL3_EXCEPTIONS, supplierPay].sort());
    await scratch.pool.query(`ALTER FUNCTION ${supplierPay} SET search_path = pg_catalog, public, pg_temp`);
    expect(await definerLawViolations(scratch.pool)).toEqual(SHIPPED);
  });

  it('PM-43 supplier_pay handed to the migrator → clauses 2 and 7 name it', async () => {
    await scratch.pool.query(`ALTER FUNCTION ${supplierPay} OWNER TO daftar_migrator`);
    const v = await definerLawViolations(scratch.pool);
    expect({ c2: v.c2, c7: v.c7 }).toEqual({ c2: [...TL3_EXCEPTIONS, supplierPay].sort(), c7: [...TL3_EXCEPTIONS, supplierPay].sort() });
    await scratch.pool.query(`ALTER FUNCTION ${supplierPay} OWNER TO ${INVENTORY_INTERNAL}`);
  });

  it('TD-18 provision_actor handed back to the migrator → clauses 2 and 7 name it; the old public-first path → clause 1', async () => {
    await scratch.pool.query(`ALTER FUNCTION provision_actor(text[]) OWNER TO daftar_migrator`);
    const v = await definerLawViolations(scratch.pool);
    expect({ c2: v.c2, c7: v.c7 }).toEqual({ c2: ['provision_actor(text[])'], c7: ['provision_actor(text[])'] });
    await scratch.pool.query(`ALTER FUNCTION provision_actor(text[]) OWNER TO ${PROVISIONING_INTERNAL}`);
    await scratch.pool.query(`ALTER FUNCTION catalog_identifiers_sync() SET search_path = public, pg_catalog, pg_temp`);
    expect((await definerLawViolations(scratch.pool)).c1).toEqual(['catalog_identifiers_sync()']);
    await scratch.pool.query(`ALTER FUNCTION catalog_identifiers_sync() SET search_path = pg_catalog, public, pg_temp`);
    expect(await definerLawViolations(scratch.pool)).toEqual(SHIPPED);
  });

  it('PM-43 EXECUTE granted to PUBLIC on a trigger function → clauses 3 and 4 name it', async () => {
    await scratch.pool.query(`GRANT EXECUTE ON FUNCTION ${guard} TO PUBLIC`);
    const v = await definerLawViolations(scratch.pool);
    expect({ c3: v.c3, c4: v.c4 }).toEqual({ c3: [guard], c4: [guard] });
  });
});
