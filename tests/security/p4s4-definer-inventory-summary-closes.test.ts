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
 *
 * AND THE DIVISION OF LABOUR, STATED HERE SO A GREEN CANNOT BE MISREAD. Both
 * sections measure ONE thing: that the page AGREES with the live catalogue of
 * the tree under test. Neither says that the live catalogue is the one
 * intended. If a migration granted a door that should never have existed, the
 * catalogue would hold it, the page would be updated to state it, and this
 * suite would be GREEN — correctly, because the page would not be stale. What
 * authority OUGHT to exist is the subject of the signature-and-doors law in
 * `p4s4-internal-definer-inventory.test.ts` (every door's proof, the signed
 * gate, the sealed set, the §14 completeness arm and its red proof). So:
 *
 *   green here  = the summary is not stale.
 *   green here != the authority it summarises is safe.
 *
 * Two laws, one page, read independently. Restating the neighbour's claim here
 * would make a single document carry two witnesses that look like two
 * measurements, and the weaker one would be read as confirming the stronger.
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
    sealedTriggers: await one(`SELECT count(*) AS c ${def} AND NOT ${hasOtherGrantee} AND p.prorettype = 'pg_catalog.trigger'::regtype`),
    sealedHelpers: await one(`SELECT count(*) AS c ${def} AND NOT ${hasOtherGrantee} AND p.prorettype <> 'pg_catalog.trigger'::regtype`),
    appDoors: await one(`${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d WHERE grantee = 'daftar_app' GROUP BY oid) x`),
    otherLoginDoors: await one(`${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d WHERE rolcanlogin AND grantee <> 'daftar_app' GROUP BY oid) x`),
    nologinOnlyDoors: await one(`${doorRows} SELECT count(*) AS c FROM (SELECT oid FROM d GROUP BY oid HAVING bool_and(NOT rolcanlogin)) x`),
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

describe('TL-P4-RLS-INT-01 §14 SUMMARY §1 — the arithmetic closes over the measured sets, before any page is read', () => {
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

/**
 * The comparison itself, as a FUNCTION of (page text, measurement), so the red
 * proofs below can run it against a mutated page without touching the
 * checkout. A law whose comparison is inline in its own assertion cannot be
 * shown to refuse anything.
 */
interface SummaryRow {
  readonly what: string;
  readonly re: RegExp;
  readonly want: readonly number[];
}

const summaryRows = (x: Measured): readonly SummaryRow[] => [
  { what: 'routines owned by the two internal principals', re: /\| routines owned by the two internal principals \| (\d+) \|/, want: [x.owned] },
  {
    what: 'SECURITY DEFINER, with its owner split',
    re: /\| of those, `SECURITY DEFINER` \| \*\*(\d+)\*\* \((\d+) inventory, (\d+) accounting\) \|/,
    want: [x.definers, x.inventory, x.accounting],
  },
  { what: 'INVOKER', re: /\| of those, `INVOKER` \| (\d+) /, want: [x.invokers] },
  { what: 'the doors', re: /\(\*\*the doors\*\*\) \| \*\*(\d+)\*\* \|/, want: [x.doors] },
  {
    what: 'sealed definers, with the trigger/helper split',
    re: /no caller at all \| \*\*(\d+)\*\* \((\d+) trigger functions, (\d+) helpers\) \|/,
    want: [x.sealed, x.sealedTriggers, x.sealedHelpers],
  },
  { what: 'definers executable by PUBLIC', re: /\| definers executable by `PUBLIC` \| \*\*(\d+)\*\* \|/, want: [x.publicExecutable] },
  { what: 'definers whose proacl is null', re: /never revoked\) \| \*\*(\d+)\*\* \|/, want: [x.nullAcl] },
  { what: 'definers not pinning search_path', re: /not pinning `search_path[^|]*\| \*\*(\d+)\*\* \|/, want: [x.unpinnedSearchPath] },
  { what: 'doors granted to daftar_app', re: /the ordinary runtime credential \| \*\*(\d+)\*\* \|/, want: [x.appDoors] },
  // The NUMBER only. That all of them are signed is the neighbouring suite's
  // result, and claiming it here would be claiming its work.
  {
    what: 'of those N, gated by a signed decision',
    re: /\| of those (\d+), gated by a signed server decision \| \*\*(\d+) — all of them\*\* \|/,
    want: [x.appDoors, x.appDoors],
  },
  { what: 'doors granted to any other login principal', re: /\| doors granted to any other login principal \| \*\*(\d+)\*\* /, want: [x.otherLoginDoors] },
  { what: 'doors granted only to a NOLOGIN internal principal', re: /only to a NOLOGIN internal principal \| \*\*(\d+)\*\* \|/, want: [x.nologinOnlyDoors] },
];

/** Every way the page can disagree with the catalogue, named. Empty is a pass. */
const summaryProblems = (pageText: string, x: Measured): readonly string[] => {
  const problems: string[] = [];
  for (const r of summaryRows(x)) {
    const found = r.re.exec(pageText);
    if (found === null) {
      // A row the law cannot find is a FAILURE, not a skip: a reworded page is
      // how such a law goes quiet.
      problems.push(`${r.what}: the row was not found, so its numbers were never compared`);
      continue;
    }
    const got = found.slice(1, r.want.length + 1).map(Number);
    if (JSON.stringify(got) !== JSON.stringify([...r.want])) {
      problems.push(`${r.what}: the page states ${JSON.stringify(got)} and the live catalogue holds ${JSON.stringify([...r.want])}`);
    }
  }
  return problems;
};

/**
 * The data rows of the page's own summary table, counted from the page.
 *
 * The law above compares the twelve rows it KNOWS. A thirteenth added to the
 * table would be unchecked and nothing would say so, which is the same quiet
 * failure as a reworded row seen from the other side. So the table's own row
 * count is pinned to the number of rows the law carries.
 */
const summaryTableRows = (pageText: string): readonly string[] => {
  const start = pageText.indexOf('## What was measured');
  if (start < 0) return [];
  const rest = pageText.slice(start);
  const end = rest.indexOf('\n## ', 3);
  const section = end < 0 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .filter((l) => l.startsWith('| '))
    .filter((l) => !/^\| fact \| value \|/.test(l) && !/^\|\s*-+\s*\|/.test(l));
};

describe('TL-P4-RLS-INT-01 §14 SUMMARY §2 — the page states what the live catalogue holds', () => {
  it('every summary row is found and carries the measured number', () => {
    expect(summaryProblems(page, m), `${INVENTORY_DOC} — the summary disagrees with the catalogue of this tree`).toEqual([]);
  });

  it('and the law compares EVERY row the table has, so a row added to the page cannot go unchecked', () => {
    const inThePage = summaryTableRows(page);
    // The parser's own control: a section it cannot find reads as "no rows",
    // which would make the equality below satisfiable by an empty page.
    expect(inThePage.length, `NO SUBJECT — no summary row was parsed out of ${INVENTORY_DOC}`).toBeGreaterThan(0);
    expect(
      inThePage.length,
      `${INVENTORY_DOC} — the table has ${inThePage.length} data row(s) and this law carries ${summaryRows(m).length}: ` +
        `a row on the page that no pattern here claims is a row nothing checks. The unmatched row(s): ` +
        `${JSON.stringify(inThePage.filter((l) => !summaryRows(m).some((r) => r.re.test(l))).map((l) => l.slice(0, 70)))}`,
    ).toBe(summaryRows(m).length);
  });
});

describe('TL-P4-RLS-INT-01 §14 SUMMARY RED PROOF — the law can fail, on a mutated page and never on the checkout', () => {
  // Every plant below mutates a STRING. The page on disk is never written, so
  // no plant can leave the checkout changed if an assertion throws.
  it('red: a stale count is refused, and the refusal names both numbers', () => {
    const stale = page.replace(
      `| of those, \`SECURITY DEFINER\` | **${m.definers}** (${m.inventory} inventory, ${m.accounting} accounting) |`,
      `| of those, \`SECURITY DEFINER\` | **${m.definers - 1}** (${m.inventory} inventory, ${m.accounting - 1} accounting) |`,
    );
    // RULE-27 — the plant is proved APPLIED before its effect is read. A
    // replacement that matched nothing would leave the page intact and the
    // assertion below would then be reporting a pass as a red proof.
    expect(stale, 'the plant changed the page text').not.toEqual(page);
    const found = summaryProblems(stale, m);
    expect(found.length, `a stale count went unreported: ${JSON.stringify(found)}`).toBeGreaterThan(0);
    expect(
      found.some((x) => x.includes('SECURITY DEFINER') && x.includes(String(m.definers - 1)) && x.includes(String(m.definers))),
      `the refusal names the page's number and the catalogue's: ${JSON.stringify(found)}`,
    ).toBe(true);
    // And this is the exact staleness that survived BOTH sides of a merge: one
    // side said 223 definers, the other 222, the catalogue 224.
    expect(summaryProblems(page, m), 'the unmutated page is still a pass, so the red above is the plant and not the page').toEqual([]);
  });

  it('red: a reworded row is refused as NOT FOUND, because a quiet law is the failure mode', () => {
    const reworded = page.replace('| definers executable by `PUBLIC` |', '| definers that PUBLIC may execute |');
    expect(reworded, 'the plant changed the page text').not.toEqual(page);
    const found = summaryProblems(reworded, m);
    expect(
      found.some((x) => x.includes('definers executable by PUBLIC') && x.includes('not found')),
      `a reworded row was not reported as unfound: ${JSON.stringify(found)}`,
    ).toBe(true);
  });

  it('red: a page with no summary table at all is refused on every row, not silently', () => {
    const found = summaryProblems('', m);
    expect(found.length, 'an empty page must fail every row').toBe(summaryRows(m).length);
    expect(
      found.every((x) => x.includes('not found')),
      `every finding on an empty page is a not-found: ${JSON.stringify(found)}`,
    ).toBe(true);
  });
});
