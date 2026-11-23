/**
 * THE DEFINER INVENTORY'S SUMMARY TABLE, PINNED TO THE LIVE CATALOGUE AND TO
 * AN ARITHMETIC THAT CLOSES — the law DR-180/3 asks for, written because its
 * absence was measured and not supposed.
 *
 * WHY IT EXISTS. `docs/PHASE_4_INTERNAL_DEFINER_INVENTORY.md` carries a
 * twelve-row summary of what was measured. The suite beside this one
 * (`p4s4-internal-definer-inventory.test.ts`) checks that every recorded
 * SIGNATURE is named in that page — and nothing checked the summary NUMBERS.
 * The consequence was measured during a merge: this branch's page said 223
 * definers, `main`'s said 222, and the live catalogue of the merged tree said
 * **224**. Both sides were stale, each in its own direction, so the conflict
 * showed two wrong answers and no right one — and on the arithmetic neither
 * closed (223 + 19 and 222 + 19 against a stated 240). A generated or
 * hand-kept figure that no law checks goes stale on BOTH sides of a merge,
 * where a conflict cannot reveal it.
 *
 * WHAT IT DOES NOT DO: pin a number. Every expected value here is MEASURED
 * from `pg_proc`/`pg_roles`/`aclexplode` at the tree under test, and the page
 * is compared against that. A suite carrying `expect(...).toBe(224)` would be
 * tomorrow's false red the first time a lawful migration adds a definer, and
 * would pin the page to a constant instead of to the database.
 *
 * THE ARMS:
 *   §1 the arithmetic closes — four identities over the measured sets, so a
 *      partition that stops partitioning is a red by itself, with no page
 *      involved;
 *   §2 the page states what the catalogue holds, row by row, with the
 *      parser's own positive control: every row it needs must be FOUND, so a
 *      reworded or deleted row is a red and never a silent pass.
 *
 * THE ONE CLAIM IT LEAVES TO ITS NEIGHBOUR. The row "of those N, gated by a
 * signed server decision | N — all of them" is checked here only for its
 * NUMBER. That every one of them is signed is a property of the doors, and it
 * is `p4s4-internal-definer-inventory.test.ts` that proves it; this suite
 * would be claiming its neighbour's result if it said otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ownerPool } from '../helpers/test-app';
import type { PoolClient } from 'pg';

const INVENTORY_DOC = 'docs/PHASE_4_INTERNAL_DEFINER_INVENTORY.md';
const OWNERS = `'daftar_inventory_internal','daftar_accounting_internal'`;

interface Measured {
  readonly owned: number;
  readonly definers: number;
  readonly invokers: number;
  readonly inventory: number;
  readonly accounting: number;
  readonly doors: number;
  readonly sealed: number;
  readonly sealedTriggers: number;
  readonly sealedHelpers: number;
  readonly appDoors: number;
  readonly otherLoginDoors: number;
  readonly nologinOnlyDoors: number;
  readonly publicExecutable: number;
  readonly nullAcl: number;
  readonly unpinnedSearchPath: number;
}

let c: PoolClient;
let m: Measured;
let page = '';

const one = async (sql: string): Promise<number> => {
  const r = await c.query<{ c: string }>(sql);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`NO SUBJECT — the probe returned no row: ${sql}`);
  return Number(row.c);
};

beforeAll(async () => {
  c = await ownerPool().connect();
  page = readFileSync(join(__dirname, '..', '..', INVENTORY_DOC), 'utf8');

  const base = `FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
                WHERE n.nspname = 'public' AND r.rolname IN (${OWNERS})`;
  const def = `${base} AND p.prosecdef`;
  const hasOtherGrantee = `EXISTS (SELECT 1 FROM aclexplode(p.proacl) a JOIN pg_roles g ON g.oid = a.grantee
                                   WHERE a.privilege_type = 'EXECUTE' AND g.rolname <> r.rolname)`;
  const doorRows = `WITH d AS (
      SELECT p.oid, g.rolname AS grantee, g.rolcanlogin
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
        CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles g ON g.oid = a.grantee
       WHERE n.nspname = 'public' AND r.rolname IN (${OWNERS}) AND p.prosecdef
         AND a.privilege_type = 'EXECUTE' AND g.rolname <> r.rolname)`;

  m = {
    owned: await one(`SELECT count(*) AS c ${base}`),
    definers: await one(`SELECT count(*) AS c ${def}`),
    invokers: await one(`SELECT count(*) AS c ${base} AND NOT p.prosecdef`),
    inventory: await one(`SELECT count(*) AS c ${def} AND r.rolname = 'daftar_inventory_internal'`),
    accounting: await one(`SELECT count(*) AS c ${def} AND r.rolname = 'daftar_accounting_internal'`),
    doors: await one(`SELECT count(*) AS c ${def} AND ${hasOtherGrantee}`),
    sealed: await one(`SELECT count(*) AS c ${def} AND NOT ${hasOtherGrantee}`),
    sealedTriggers: await one(
      `SELECT count(*) AS c ${def} AND NOT ${hasOtherGrantee} AND p.prorettype = 'pg_catalog.trigger'::regtype`,
    ),
    sealedHelpers: await one(
      `SELECT count(*) AS c ${def} AND NOT ${hasOtherGrantee} AND p.prorettype <> 'pg_catalog.trigger'::regtype`,
    ),
    appDoors: await one(`${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d WHERE grantee = 'daftar_app' GROUP BY oid) x`),
    otherLoginDoors: await one(
      `${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d WHERE rolcanlogin AND grantee <> 'daftar_app' GROUP BY oid) x`,
    ),
    nologinOnlyDoors: await one(
      `${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d GROUP BY oid HAVING bool_and(NOT rolcanlogin)) x`,
    ),
    publicExecutable: await one(
      `SELECT count(*) AS c ${def} AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`,
    ),
    nullAcl: await one(`SELECT count(*) AS c ${def} AND p.proacl IS NULL`),
    unpinnedSearchPath: await one(
      `SELECT count(*) AS c ${def} AND NOT (coalesce(array_to_string(p.proconfig, ','), '')
         LIKE '%search_path=pg_catalog, public, pg_temp%')`,
    ),
  };
}, 300_000);

afterAll(() => {
  c?.release();
});

describe('§1 the arithmetic closes over the measured sets, before any page is read', () => {
  it('four identities hold, and the sets they partition are not empty', () => {
    // NO SUBJECT: every identity below is satisfied by all-zeros, which is what
    // a probe against the wrong database or an unmigrated one returns.
    expect(m.definers, 'NO SUBJECT — the catalogue holds no SECURITY DEFINER routine owned by an internal principal').toBeGreaterThan(0);
    expect(m.doors, 'NO SUBJECT — no door was measured').toBeGreaterThan(0);
    expect(m.sealed, 'NO SUBJECT — no sealed definer was measured').toBeGreaterThan(0);

    expect(m.definers + m.invokers, `definers + invokers = routines owned (${m.definers} + ${m.invokers})`).toBe(m.owned);
    expect(m.inventory + m.accounting, `inventory + accounting = definers (${m.inventory} + ${m.accounting})`).toBe(m.definers);
    expect(m.doors + m.sealed, `doors + sealed = definers (${m.doors} + ${m.sealed})`).toBe(m.definers);
    expect(m.sealedTriggers + m.sealedHelpers, `trigger functions + helpers = sealed (${m.sealedTriggers} + ${m.sealedHelpers})`).toBe(m.sealed);
    // The door partition is disjoint IN FACT — a door granted both to
    // `daftar_app` and to another login principal would break this, and that
    // would be a finding about authority, not about a document.
    expect(
      m.appDoors + m.otherLoginDoors + m.nologinOnlyDoors,
      `app doors + other-login doors + NOLOGIN-only doors = doors (${m.appDoors} + ${m.otherLoginDoors} + ${m.nologinOnlyDoors})`,
    ).toBe(m.doors);
  });
});

describe('§2 and the page states what the catalogue holds', () => {
  it('every summary row is found and carries the measured number', () => {
    // Each row is (what it is, the pattern that finds it, the measured value).
    // The pattern captures the number; it is never written here.
    const rows: readonly { readonly what: string; readonly re: RegExp; readonly want: readonly number[] }[] = [
      { what: 'routines owned by the two internal principals', re: /\| routines owned by the two internal principals \| (\d+) \|/, want: [m.owned] },
      {
        what: 'SECURITY DEFINER, with its owner split',
        re: /\| of those, `SECURITY DEFINER` \| \*\*(\d+)\*\* \((\d+) inventory, (\d+) accounting\) \|/,
        want: [m.definers, m.inventory, m.accounting],
      },
      { what: 'INVOKER', re: /\| of those, `INVOKER` \| (\d+) /, want: [m.invokers] },
      { what: 'the doors', re: /\(\*\*the doors\*\*\) \| \*\*(\d+)\*\* \|/, want: [m.doors] },
      {
        what: 'sealed definers, with the trigger/helper split',
        re: /no caller at all \| \*\*(\d+)\*\* \((\d+) trigger functions, (\d+) helpers\) \|/,
        want: [m.sealed, m.sealedTriggers, m.sealedHelpers],
      },
      { what: 'definers executable by PUBLIC', re: /\| definers executable by `PUBLIC` \| \*\*(\d+)\*\* \|/, want: [m.publicExecutable] },
      { what: 'definers whose proacl is null', re: /never revoked\) \| \*\*(\d+)\*\* \|/, want: [m.nullAcl] },
      { what: 'definers not pinning search_path', re: /not pinning `search_path[^|]*\| \*\*(\d+)\*\* \|/, want: [m.unpinnedSearchPath] },
      { what: 'doors granted to daftar_app', re: /the ordinary runtime credential \| \*\*(\d+)\*\* \|/, want: [m.appDoors] },
      // The NUMBER only. That all of them are signed is the neighbouring
      // suite's result, and claiming it here would be claiming its work.
      { what: 'of those N, gated by a signed decision', re: /\| of those (\d+), gated by a signed server decision \| \*\*(\d+) — all of them\*\* \|/, want: [m.appDoors, m.appDoors] },
      { what: 'doors granted to any other login principal', re: /\| doors granted to any other login principal \| \*\*(\d+)\*\* /, want: [m.otherLoginDoors] },
      { what: 'doors granted only to a NOLOGIN internal principal', re: /only to a NOLOGIN internal principal \| \*\*(\d+)\*\* \|/, want: [m.nologinOnlyDoors] },
    ];

    const missing = rows.filter((r) => r.re.exec(page) === null).map((r) => r.what);
    // THE PARSER'S POSITIVE CONTROL. A row this suite cannot find is the way
    // the whole law goes quiet: reword the page and every comparison below
    // simply never runs. So an unfound row is a failure, not a skip.
    expect(missing, `${INVENTORY_DOC} — these summary rows were not found, so their numbers were never compared`).toEqual([]);

    for (const r of rows) {
      const found = r.re.exec(page);
      if (found === null) continue; // already reported above
      const got = found.slice(1, r.want.length + 1).map(Number);
      expect(got, `${INVENTORY_DOC} — the row "${r.what}" states ${JSON.stringify(got)} and the live catalogue holds ${JSON.stringify(r.want)}`).toEqual(
        [...r.want],
      );
    }
  });
});
