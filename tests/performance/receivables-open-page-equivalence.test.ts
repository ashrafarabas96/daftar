/**
 * THE CORRECTNESS EVIDENCE FOR `customer_open_invoices_page` (migration
 * `0084`; P4-S4-0084-CONTRACT §8, §10, §11, §13).
 *
 * The population, the oracle, the canonical set and the fake fix all live in
 * `receivables-open-page-population.ts`, with the reasoning for each. This
 * file is the assertions.
 *
 * ── WHAT IS PROVED, AND IN WHAT ORDER ──────────────────────────────────────
 *
 * §11 RESULT EQUIVALENCE. For every case of the matrix, the new reader and
 * the OLD per-row `JOIN LATERAL` semantics return the SAME ROWS IN THE SAME
 * ORDER — the ids, `paid`, `outstanding`, the currency, the due date, the
 * ordering and the pagination boundary, element by element. `toEqual` over
 * two arrays of objects is an ORDERED comparison in Vitest, which is what §11
 * asks for; set equality is explicitly not enough and is never taken.
 *
 * §10 THE FAT-TAIL MATRIX. Eight cases. For each: the exact rows, the exact
 * ordering, no duplicate, no omission, stable pagination, business isolation,
 * and row security APPLIED — every read is taken as `daftar_app` with
 * `app.tenant_id` and `app.business_id` set, and each read asserts
 * `current_user`, `app_bypass()` and `rolbypassrls` before it trusts its own
 * result. The owner bypasses row security and would hide a leak, so the owner
 * is used for exactly one thing: the NEGATIVE CONTROL that shows the
 * cross-business read's emptiness came from row security and not from an
 * empty table.
 *
 * §8 THE CASH-ELIGIBILITY IDENTITY. The table pre-filter
 * (`sales.settlement_mode <> 'cash'`) is an eligibility optimization only if
 * the result set is EXACTLY the canonical one. So the reader is compared to
 * the canonical definition — the ONE definition asked about every candidate,
 * with no settlement-mode predicate anywhere — on every case, and on a
 * population that carries the row that would catch the claim if it were
 * wrong: a cash-settled, `status = 'open'`, long-overdue invoice with NO
 * reducer at all, whose raw `total - sum(reducers)` is its whole total.
 *
 * §13 THE FAKE `LIMIT` FIX. On the `fakeLimit` population the first 51
 * candidates hold exactly ten genuinely outstanding invoices and 79 more
 * follow. The fake fix — take the first 51 candidate rows, then drop the
 * zero-outstanding ones — is written out in full as test-only SQL and
 * asserted to return that SHORT page, so the §13 assertion is demonstrably
 * red-capable; the reader is asserted to return a FULL PAGE OF 51.
 *
 * ── WHERE IT RUNS ──────────────────────────────────────────────────────────
 *
 * One scratch database of this suite's own, built from the real migration
 * files by the real runner, on the deployment target (PostgreSQL 16). The
 * whole population is written inside ONE transaction that is ALWAYS ROLLED
 * BACK, so nothing this suite writes is ever committed and no other suite's
 * relations are touched. The environment is measured and printed rather than
 * assumed (`tests/helpers/plan-evidence-env.ts`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_PORT, PG_USER, PG_PASSWORD, applyBootstrap, startOrReuse } from '../helpers/embedded-cluster';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { planEvidenceBanner, readPlanEvidenceEnvironment } from '../helpers/plan-evidence-env';
import {
  CANONICAL_SQL,
  FAKE_LIMIT_SQL,
  ORACLE_SQL,
  PAGE,
  READER_SQL,
  seed,
  type BusinessSlot,
  type CaseSpec,
  type PageRow,
  type Seeded,
} from './receivables-open-page-population';

/** A scratch database of this suite's own. Created here, dropped here. */
const DB = `daftar_open_page_eq_${process.pid}`;
const url = (db: string, user = PG_USER, password = PG_PASSWORD): string => `postgresql://${user}:${password}@localhost:${PG_PORT}/${db}`;

/** The signature the contract fixes for the reader under test. */
const READER_SIGNATURE = 'public.customer_open_invoices_page(uuid,uuid,date,uuid,integer)';

/** The signature the contract fixes for the reshaped ONE definition. */
const ARRAY_FORM_SIGNATURE = 'public.invoice_outstanding(uuid,uuid[])';

let client: Client;
let seeded: Seeded;
let cases: readonly CaseSpec[];
/** Null when the reader is present; otherwise why it is not. */
let readerAbsence: string | null = null;

/** One read's outcome: rows, or the refusal that replaced them. */
interface Answer {
  readonly rows?: readonly PageRow[];
  readonly error?: string;
}

/**
 * A read taken AS `daftar_app`, WITH the request-scope GUCs set.
 *
 * `SET LOCAL ROLE` and `set_config(..., true)` are both transaction-scoped, so
 * the savepoint that wraps the read restores the owner's session afterwards —
 * which matters, because the next statement may have to seed or `ANALYZE`.
 * Nothing in the read writes, so rolling back to the savepoint discards
 * nothing but the role and the GUCs.
 *
 * Before the read is trusted, the session is interrogated: a read taken as
 * the owner, or as a role with `BYPASSRLS`, or as the one role `app_bypass()`
 * answers true for, would pass every isolation assertion below while a leak
 * went unseen. So those three facts are asserted, every time, in the
 * transaction the read happens in.
 */
async function readAsApp(slot: BusinessSlot, sql: string, params: readonly unknown[]): Promise<Answer> {
  await client.query('SAVEPOINT open_page_read');
  try {
    await client.query('SET LOCAL ROLE daftar_app');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [seeded.tenantId, seeded.businessId[slot]]);
    const guard = await client.query<{ who: string; bypass: boolean; rls: boolean }>(
      `SELECT current_user::text AS who, public.app_bypass() AS bypass,
              (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS rls`,
    );
    const g = guard.rows[0];
    if (g === undefined) throw new Error('the row-security self-check returned no row');
    expect(g.who).toBe('daftar_app');
    expect(g.bypass).toBe(false);
    expect(g.rls).toBe(false);
    const r = await client.query<PageRow>(sql, params as unknown[]);
    const rows = r.rows;
    await client.query('ROLLBACK TO SAVEPOINT open_page_read');
    await client.query('RELEASE SAVEPOINT open_page_read');
    return { rows };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT open_page_read');
    await client.query('RELEASE SAVEPOINT open_page_read');
    return { error: (e as Error).message };
  }
}

/** A read taken as the OWNER, with row security bypassed. The negative control only. */
async function readAsOwnerBypassingRowSecurity(sql: string, params: readonly unknown[]): Promise<Answer> {
  await client.query('SAVEPOINT open_page_owner_read');
  try {
    const r = await client.query<PageRow>(sql, params as unknown[]);
    const rows = r.rows;
    await client.query('ROLLBACK TO SAVEPOINT open_page_owner_read');
    await client.query('RELEASE SAVEPOINT open_page_owner_read');
    return { rows };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT open_page_owner_read');
    await client.query('RELEASE SAVEPOINT open_page_owner_read');
    return { error: (e as Error).message };
  }
}

/** The rows of a read that MUST have succeeded, with the refusal in the message when it did not. */
function rowsOf(label: string, a: Answer): readonly PageRow[] {
  if (a.rows === undefined) throw new Error(`${label} did not return rows: ${a.error ?? 'no reason given'}`);
  return a.rows;
}

/** One page, for `(business, customer)`, after the keyset `(afterDate, afterId)`. */
const pageParams = (k: CaseSpec, businessId: string, afterDate: string | null, afterId: string | null, limit: number): readonly unknown[] => [
  businessId,
  k.customerId,
  afterDate,
  afterId,
  limit,
];

/** `(issue_date, id)` must be strictly increasing down a page. */
function assertStrictlyOrdered(rows: readonly PageRow[]): void {
  for (let n = 1; n < rows.length; n += 1) {
    const prev = rows[n - 1] as PageRow;
    const cur = rows[n] as PageRow;
    const before = prev.issue_date < cur.issue_date || (prev.issue_date === cur.issue_date && prev.invoice_id < cur.invoice_id);
    expect(before, `row ${n} (${cur.issue_date}, ${cur.invoice_id}) does not follow row ${n - 1} (${prev.issue_date}, ${prev.invoice_id})`).toBe(true);
  }
}

/** No id twice. */
function assertNoDuplicate(rows: readonly PageRow[]): void {
  const ids = rows.map((r) => r.invoice_id);
  expect(new Set(ids).size).toBe(ids.length);
}

beforeAll(async () => {
  await startOrReuse();
  const admin = new Pool({ connectionString: url('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
  await applyBootstrap(DB);
  const owner = new Pool({ connectionString: url(DB), max: 1 });
  try {
    await owner.query(`GRANT CONNECT ON DATABASE ${DB} TO daftar_migrator`);
  } finally {
    await owner.end();
  }
  const applied = await runMigrations(url(DB));

  client = new Client({ connectionString: url(DB) });
  await client.connect();

  const env = await readPlanEvidenceEnvironment(async <R>(sql: string) => ({ rows: (await client.query(sql)).rows as R[] }));
  console.log(planEvidenceBanner(env));
  console.log(`[open-page] scratch database ${DB}, ${applied.length} migrations applied, head ${applied[applied.length - 1] ?? 'none'}`);

  const present = await client.query<{ reader: string | null; arrayForm: string | null }>(
    `SELECT to_regprocedure($1)::text AS reader, to_regprocedure($2)::text AS "arrayForm"`,
    [READER_SIGNATURE, ARRAY_FORM_SIGNATURE],
  );
  readerAbsence =
    (present.rows[0]?.reader ?? null) === null
      ? `${READER_SIGNATURE} does not exist on this tree; migration 0084 has not been applied (head ${applied[applied.length - 1] ?? 'none'})`
      : null;
  console.log(`[open-page] reader: ${readerAbsence ?? 'present'} | array form: ${present.rows[0]?.arrayForm ?? 'ABSENT'}`);

  await client.query('BEGIN');
  seeded = await seed(client);
  cases = seeded.cases;
  // A plan over missing statistics is a plan about the missing statistics, and
  // the chunked reader's candidate scan is the thing being asked about.
  for (const t of ['invoices', 'sales', 'payment_allocations', 'customer_credit_applications', 'customer_credits', 'payments']) {
    await client.query(`ANALYZE ${t}`);
  }
}, 900_000);

afterAll(async () => {
  if (client !== undefined) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  const admin = new Pool({ connectionString: url('postgres'), max: 1 });
  admin.on('error', () => undefined);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}, 300_000);

describe('P4-S4 0084 — the open-invoice page reader', () => {
  it('the reader the contract fixes exists, with the signature the contract fixes', () => {
    expect(readerAbsence, readerAbsence ?? 'present').toBe(null);
  });

  it('the reshaped ONE definition exists, returning the currency and the due date as passthrough', async () => {
    const got = await client.query<{ sig: string | null; args: string | null; result: string | null }>(
      `SELECT to_regprocedure($1)::text AS sig,
              pg_catalog.pg_get_function_identity_arguments(to_regprocedure($1)) AS args,
              pg_catalog.pg_get_function_result(to_regprocedure($1)) AS result`,
      [ARRAY_FORM_SIGNATURE],
    );
    const r = got.rows[0];
    expect(r?.sig).toBe('invoice_outstanding(uuid,uuid[])');
    expect(r?.result ?? '').toContain('currency_code text');
    expect(r?.result ?? '').toContain('due_date date');
  });

  it('the realized population is the population §10 asks for', async () => {
    const report: Record<string, { candidates: number; outstanding: number; cash: number; settledCredit: number }> = {};
    for (const k of cases) {
      const got = await client.query<{ candidates: string; outstanding: string; cash: string; settled_credit: string }>(
        `WITH cand AS (
           SELECT i.id, s.settlement_mode
             FROM public.invoices i
             JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
            WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open'
         ), answered AS (
           SELECT c.id, c.settlement_mode, o.outstanding_txn_minor
             FROM cand c
             JOIN public.invoice_outstanding($1, (SELECT array_agg(x.id) FROM cand x)) o ON o.invoice_id = c.id
         )
         SELECT count(*)::text AS candidates,
                count(*) FILTER (WHERE outstanding_txn_minor <> 0)::text AS outstanding,
                count(*) FILTER (WHERE settlement_mode = 'cash')::text AS cash,
                count(*) FILTER (WHERE settlement_mode = 'credit' AND outstanding_txn_minor = 0)::text AS settled_credit
           FROM answered`,
        [seeded.businessId[k.business], k.customerId],
      );
      const g = got.rows[0] as { candidates: string; outstanding: string; cash: string; settled_credit: string };
      report[k.key] = {
        candidates: Number(g.candidates),
        outstanding: Number(g.outstanding),
        cash: Number(g.cash),
        settledCredit: Number(g.settled_credit),
      };
    }
    console.log('[open-page] realized population', JSON.stringify(report, null, 2));

    // §10 case 2: about 1 500 cash-settled, and at least 51 genuinely outstanding.
    expect(report['cashTail']?.cash).toBeGreaterThanOrEqual(1_500);
    expect(report['cashTail']?.outstanding).toBeGreaterThanOrEqual(PAGE);
    // §10 case 3, MANDATORY: about 1 500 fully-settled CREDIT invoices — settled
    // to zero through their reducers, not by a status change — and at least 51
    // genuinely outstanding. A benchmark of cash history alone is not accepted.
    expect(report['settledCreditTail']?.settledCredit).toBeGreaterThanOrEqual(1_500);
    expect(report['settledCreditTail']?.cash).toBe(0);
    expect(report['settledCreditTail']?.outstanding).toBeGreaterThanOrEqual(PAGE);
    // Every settled-credit invoice is still `status = 'open'`.
    const states = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.invoices i WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status <> 'open'`,
      [seeded.businessId['subject'], cases.find((k) => k.key === 'settledCreditTail')?.customerId],
    );
    expect(states.rows[0]?.n).toBe('0');
    // §10 case 4, 5, 6, 7 and §13 all need more outstanding rows than one page.
    expect(report['mixture']?.outstanding).toBeGreaterThanOrEqual(PAGE);
    expect(report['currencies']?.outstanding).toBeGreaterThanOrEqual(PAGE);
    expect(report['tiedDates']?.outstanding).toBeGreaterThanOrEqual(PAGE);
    expect(report['secondPage']?.outstanding).toBeGreaterThanOrEqual(2 * PAGE);
    expect(report['fakeLimit']?.outstanding).toBe(89);
    // §10 case 5 really does carry two currencies among its outstanding rows.
    const currencies = await client.query<{ n: string }>(
      `SELECT count(DISTINCT i.currency_code)::text AS n FROM public.invoices i
        WHERE i.business_id = $1 AND i.customer_id = $2`,
      [seeded.businessId['subject'], cases.find((k) => k.key === 'currencies')?.customerId],
    );
    expect(currencies.rows[0]?.n).toBe('2');
    // §10 case 6 really does carry one issue date and one due date across the case.
    const tied = await client.query<{ issues: string; dues: string; n: string }>(
      `SELECT count(DISTINCT i.issue_date)::text AS issues, count(DISTINCT i.due_date)::text AS dues, count(*)::text AS n
         FROM public.invoices i WHERE i.business_id = $1 AND i.customer_id = $2`,
      [seeded.businessId['subject'], cases.find((k) => k.key === 'tiedDates')?.customerId],
    );
    expect(tied.rows[0]?.issues).toBe('1');
    expect(tied.rows[0]?.dues).toBe('1');
    expect(Number(tied.rows[0]?.n)).toBeGreaterThanOrEqual(PAGE);
    // §10 case 8: the neighbour's customer id is the subject's, exactly.
    expect(cases.find((k) => k.key === 'neighbour')?.customerId).toBe(cases.find((k) => k.key === 'cashTail')?.customerId);
    expect(report['neighbour']?.outstanding).toBeGreaterThan(0);
  });

  // ───── §10, one described case at a time ────────────────────────────────

  for (const key of ['mostlyOpen', 'cashTail', 'settledCreditTail', 'mixture', 'currencies', 'tiedDates', 'secondPage', 'neighbour'] as const) {
    describe(`§10 ${key}`, () => {
      const subject = (): CaseSpec => {
        const k = cases.find((c) => c.key === key);
        if (k === undefined) throw new Error(`no case ${key}`);
        return k;
      };

      it('the oracle and the canonical definition agree, exactly and in order', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const oracle = rowsOf('oracle', await readAsApp(k.business, ORACLE_SQL, pageParams(k, bid, null, null, PAGE)));
        const canonical = rowsOf('canonical', await readAsApp(k.business, CANONICAL_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(oracle).toEqual(canonical);
        assertStrictlyOrdered(oracle);
        assertNoDuplicate(oracle);
        expect(oracle.length).toBeGreaterThan(0);
      });

      it('the new reader equals the oracle EXACTLY — ids, paid, outstanding, currency, due date, order', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const oracle = rowsOf('oracle', await readAsApp(k.business, ORACLE_SQL, pageParams(k, bid, null, null, PAGE)));
        const reader = rowsOf('reader', await readAsApp(k.business, READER_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(reader).toEqual(oracle);
        assertStrictlyOrdered(reader);
        assertNoDuplicate(reader);
      });

      it('the new reader equals the CANONICAL set exactly (§8: the cash pre-filter removes only zero rows)', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const canonical = rowsOf('canonical', await readAsApp(k.business, CANONICAL_SQL, pageParams(k, bid, null, null, PAGE)));
        const reader = rowsOf('reader', await readAsApp(k.business, READER_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(reader).toEqual(canonical);
      });

      it('the page is full when the case has a full page of outstanding invoices, and omits nothing', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const everything = rowsOf('canonical, unbounded', await readAsApp(k.business, CANONICAL_SQL, pageParams(k, bid, null, null, 1_000_000)));
        const reader = rowsOf('reader', await readAsApp(k.business, READER_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(reader.length).toBe(Math.min(PAGE, everything.length));
        // No omission: the page is the ORDERED PREFIX of the whole answer, not
        // a sample of it.
        expect(reader).toEqual(everything.slice(0, reader.length));
      });

      it('the whole answer is reachable by keyset pagination, with no duplicate and no omission across any boundary', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const everything = rowsOf('canonical, unbounded', await readAsApp(k.business, CANONICAL_SQL, pageParams(k, bid, null, null, 1_000_000)));
        const walked: PageRow[] = [];
        let afterDate: string | null = null;
        let afterId: string | null = null;
        for (let page = 0; page < 60; page += 1) {
          const got = rowsOf(`reader page ${page}`, await readAsApp(k.business, READER_SQL, pageParams(k, bid, afterDate, afterId, PAGE)));
          if (got.length === 0) break;
          walked.push(...got);
          const last = got[got.length - 1] as PageRow;
          afterDate = last.issue_date;
          afterId = last.invoice_id;
          if (got.length < PAGE) break;
        }
        expect(walked).toEqual(everything);
        assertStrictlyOrdered(walked);
        assertNoDuplicate(walked);
      });

      it('the second page of the oracle and of the reader are the same page', async () => {
        const k = subject();
        const bid = seeded.businessId[k.business];
        const first = rowsOf('reader page 1', await readAsApp(k.business, READER_SQL, pageParams(k, bid, null, null, PAGE)));
        const boundary = first[first.length - 1] as PageRow | undefined;
        if (boundary === undefined) throw new Error('the first page is empty, so there is no boundary to continue across');
        const readerSecond = rowsOf(
          'reader page 2',
          await readAsApp(k.business, READER_SQL, pageParams(k, bid, boundary.issue_date, boundary.invoice_id, PAGE)),
        );
        const oracleSecond = rowsOf(
          'oracle page 2',
          await readAsApp(k.business, ORACLE_SQL, pageParams(k, bid, boundary.issue_date, boundary.invoice_id, PAGE)),
        );
        expect(readerSecond).toEqual(oracleSecond);
        // The boundary itself is in exactly one of the two pages.
        expect(readerSecond.map((r) => r.invoice_id)).not.toContain(boundary.invoice_id);
      });

      it('row security is applied: the read is as daftar_app, and the neighbouring business cannot reach these rows (canonical)', async () => {
        const k = subject();
        const other: BusinessSlot = k.business === 'subject' ? 'neighbour' : 'subject';
        // Every `readAsApp` above and below asserts, inside the transaction it
        // reads in, that `current_user` is `daftar_app`, that `app_bypass()` is
        // false and that the role does not hold `BYPASSRLS` — so none of this
        // case's evidence was taken as the owner.
        //
        // Here the GUCs name one business and the ARGUMENT names the other. The
        // function's own predicate matches the other business's rows; row
        // security hides them, so the answer is empty. The red-capability of
        // that emptiness is established once, by the dedicated negative control
        // below, on the one customer uuid that exists in BOTH businesses.
        const leaked = await readAsApp(k.business, CANONICAL_SQL, pageParams(k, seeded.businessId[other], null, null, PAGE));
        expect(leaked.rows ?? []).toEqual([]);
        // And row security is not silently dropping rows this customer SHOULD
        // see: the owner, with row security bypassed, sees exactly the same page.
        const bid = seeded.businessId[k.business];
        const asApp = rowsOf('canonical as daftar_app', await readAsApp(k.business, CANONICAL_SQL, pageParams(k, bid, null, null, PAGE)));
        const asOwner = rowsOf('canonical as owner', await readAsOwnerBypassingRowSecurity(CANONICAL_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(asApp).toEqual(asOwner);
      });

      it('row security is applied, and the neighbouring business cannot reach these rows (over the new reader)', async () => {
        const k = subject();
        const other: BusinessSlot = k.business === 'subject' ? 'neighbour' : 'subject';
        const leaked = await readAsApp(k.business, READER_SQL, pageParams(k, seeded.businessId[other], null, null, PAGE));
        expect(leaked.error ?? null, `the reader refused rather than answering: ${leaked.error ?? ''}`).toBe(null);
        expect(leaked.rows ?? []).toEqual([]);
        const bid = seeded.businessId[k.business];
        const asApp = rowsOf('reader as daftar_app', await readAsApp(k.business, READER_SQL, pageParams(k, bid, null, null, PAGE)));
        const asOwner = rowsOf('reader as owner', await readAsOwnerBypassingRowSecurity(READER_SQL, pageParams(k, bid, null, null, PAGE)));
        expect(asApp).toEqual(asOwner);
      });
    });
  }

  /**
   * THE NEGATIVE CONTROL for every isolation assertion above
   * ([[daftar-a-green-gate-must-prove-it-can-be-red]]).
   *
   * `customers` is keyed `(business_id, id)`, so the neighbour's customer
   * carries case 2's uuid EXACTLY. One statement, one customer uuid, two
   * business arguments, two roles:
   *
   *   — as `daftar_app` with the subject's GUCs, asking about the NEIGHBOUR's
   *     business: EMPTY. Row security hid rows that exist.
   *   — as the OWNER, with row security bypassed, the same statement: ROWS.
   *
   * Without the second half the first half would pass over an empty table and
   * prove nothing, which is exactly how a leak hides.
   */
  it('§10 row security can be shown to be red: the owner sees what daftar_app is denied', async () => {
    const subject = cases.find((k) => k.key === 'cashTail') as CaseSpec;
    const neighbour = cases.find((k) => k.key === 'neighbour') as CaseSpec;
    expect(subject.customerId).toBe(neighbour.customerId);

    for (const [from, to] of [
      ['subject', 'neighbour'],
      ['neighbour', 'subject'],
    ] as const) {
      const denied = await readAsApp(from, CANONICAL_SQL, pageParams(subject, seeded.businessId[to], null, null, PAGE));
      expect(denied.rows ?? [], `a read scoped to ${from} returned ${to}'s rows`).toEqual([]);
      const control = rowsOf(
        `owner control for ${to}`,
        await readAsOwnerBypassingRowSecurity(CANONICAL_SQL, pageParams(subject, seeded.businessId[to], null, null, PAGE)),
      );
      expect(control.length, `the owner sees nothing in ${to}, so the denial above proves nothing`).toBeGreaterThan(0);
    }
  });

  it('§10 row security can be shown to be red over the new reader too', async () => {
    const subject = cases.find((k) => k.key === 'cashTail') as CaseSpec;
    for (const [from, to] of [
      ['subject', 'neighbour'],
      ['neighbour', 'subject'],
    ] as const) {
      const denied = await readAsApp(from, READER_SQL, pageParams(subject, seeded.businessId[to], null, null, PAGE));
      expect(denied.error ?? null, `the reader refused rather than answering: ${denied.error ?? ''}`).toBe(null);
      expect(denied.rows ?? [], `a reader call scoped to ${from} returned ${to}'s rows`).toEqual([]);
      const control = rowsOf(
        `owner control for ${to}`,
        await readAsOwnerBypassingRowSecurity(READER_SQL, pageParams(subject, seeded.businessId[to], null, null, PAGE)),
      );
      expect(control.length, `the owner sees nothing in ${to}, so the denial above proves nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * §10 case 8, the half the per-case loop cannot state: the two businesses'
   * answers for the SAME customer uuid are DISJOINT, and each is exactly its
   * own business's invoices.
   */
  it('§10 neighbour — the same customer uuid in two businesses yields two disjoint answers', async () => {
    const subject = cases.find((k) => k.key === 'cashTail') as CaseSpec;
    const neighbour = cases.find((k) => k.key === 'neighbour') as CaseSpec;
    expect(subject.customerId).toBe(neighbour.customerId);

    const here = rowsOf('subject', await readAsApp('subject', CANONICAL_SQL, pageParams(subject, seeded.businessId['subject'], null, null, 1_000_000)));
    const there = rowsOf(
      'neighbour',
      await readAsApp('neighbour', CANONICAL_SQL, pageParams(neighbour, seeded.businessId['neighbour'], null, null, 1_000_000)),
    );
    const hereIds = new Set(here.map((r) => r.invoice_id));
    const thereIds = new Set(there.map((r) => r.invoice_id));
    expect(here.length).toBeGreaterThan(0);
    expect(there.length).toBeGreaterThan(0);
    for (const id of thereIds) expect(hereIds.has(id)).toBe(false);

    // And every id each side returned really does belong to that side's business.
    for (const [slot, ids] of [
      ['subject', hereIds],
      ['neighbour', thereIds],
    ] as const) {
      const got = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.invoices i WHERE i.id = ANY($1::uuid[]) AND i.business_id <> $2`, [
        [...ids],
        seeded.businessId[slot],
      ]);
      expect(got.rows[0]?.n).toBe('0');
    }
  });

  // ───── §8, the identity the cash pre-filter owes ────────────────────────

  describe('§8 the cash-eligibility identity', () => {
    const subject = (): CaseSpec => cases.find((k) => k.key === 'identity') as CaseSpec;

    it('the catching rows really are there: cash-settled, open, overdue, and raw-arithmetic outstanding', async () => {
      const k = subject();
      const got = await client.query<{ id: string; mode: string; status: string; total: string; reduced: string; canonical: string }>(
        `WITH cand AS (
           SELECT i.id, s.settlement_mode AS mode, i.status, i.total_txn_minor AS total,
                  coalesce((SELECT sum(a.invoice_amount_applied_minor) FROM public.payment_allocations a
                             WHERE a.business_id = i.business_id AND a.invoice_id = i.id), 0)
                + coalesce((SELECT sum(x.invoice_amount_applied_minor) FROM public.customer_credit_applications x
                             WHERE x.business_id = i.business_id AND x.invoice_id = i.id), 0) AS reduced
             FROM public.invoices i
             JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
            WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open' AND s.settlement_mode = 'cash'
         )
         SELECT c.id, c.mode, c.status, c.total::text AS total, c.reduced::text AS reduced,
                o.outstanding_txn_minor::text AS canonical
           FROM cand c
           JOIN public.invoice_outstanding($1, (SELECT array_agg(x.id) FROM cand x)) o ON o.invoice_id = c.id
          ORDER BY c.id`,
        [seeded.businessId['subject'], k.customerId],
      );
      console.log('[open-page] §8 cash-settled candidates', JSON.stringify(got.rows, null, 2));
      expect(got.rows.length).toBe(10);
      // At least five of them have NO reducer at all, so raw
      // `total - sum(reducers)` is their WHOLE total: everything but
      // `settlement_mode` says outstanding.
      const noReducer = got.rows.filter((r) => r.reduced === '0');
      expect(noReducer.length).toBeGreaterThanOrEqual(5);
      for (const r of noReducer) expect(BigInt(r.total)).toBeGreaterThan(0n);
      // Three carry a PARTIAL reducer, so even a naive
      // `total - sum(reducers) <> 0` would call them outstanding.
      expect(got.rows.filter((r) => r.reduced !== '0' && BigInt(r.reduced) < BigInt(r.total)).length).toBe(3);
      // And the CANONICAL answer for every one of them is zero: `0080`'s law.
      for (const r of got.rows) expect(r.canonical).toBe('0');
    });

    it('the reader returns exactly the canonical result set, and no cash-settled invoice is in it', async () => {
      const k = subject();
      const bid = seeded.businessId['subject'];
      const canonical = rowsOf('canonical', await readAsApp('subject', CANONICAL_SQL, pageParams(k, bid, null, null, 1_000_000)));
      const oracle = rowsOf('oracle', await readAsApp('subject', ORACLE_SQL, pageParams(k, bid, null, null, 1_000_000)));
      expect(oracle).toEqual(canonical);
      const reader = rowsOf('reader', await readAsApp('subject', READER_SQL, pageParams(k, bid, null, null, 1_000_000)));
      expect(reader).toEqual(canonical);

      const cash = await client.query<{ id: string }>(
        `SELECT i.id FROM public.invoices i JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
          WHERE i.business_id = $1 AND i.customer_id = $2 AND s.settlement_mode = 'cash'`,
        [bid, k.customerId],
      );
      const returned = new Set(reader.map((r) => r.invoice_id));
      for (const r of cash.rows) expect(returned.has(r.id)).toBe(false);
      // The identity has content: there are credit invoices in the answer.
      expect(reader.length).toBeGreaterThan(0);
    });

    it('the figures the reader returns are the ONE definition’s, and the passthrough columns are the invoice’s own', async () => {
      const k = subject();
      const bid = seeded.businessId['subject'];
      const reader = rowsOf('reader', await readAsApp('subject', READER_SQL, pageParams(k, bid, null, null, 1_000_000)));
      const expected = await client.query<PageRow>(
        `SELECT o.invoice_id,
                to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
                o.paid_txn_minor::text              AS paid_txn_minor,
                o.paid_base_minor::text             AS paid_base_minor,
                o.outstanding_txn_minor::text       AS outstanding_txn_minor,
                o.outstanding_base_minor::text      AS outstanding_base_minor,
                i.currency_code::text               AS currency_code,
                to_char(i.due_date, 'YYYY-MM-DD')   AS due_date
           FROM public.invoice_outstanding($1, $2::uuid[]) o
           JOIN public.invoices i ON i.business_id = $1 AND i.id = o.invoice_id
          ORDER BY i.issue_date, i.id`,
        [bid, reader.map((r) => r.invoice_id)],
      );
      expect(reader).toEqual(expected.rows);
    });
  });

  // ───── §13, the fake LIMIT fix ──────────────────────────────────────────

  describe('§13 the semantics test that catches a fake LIMIT fix', () => {
    const subject = (): CaseSpec => cases.find((k) => k.key === 'fakeLimit') as CaseSpec;

    it('the fake fix returns the SHORT page — about ten rows while 89 invoices are outstanding', async () => {
      const k = subject();
      const bid = seeded.businessId['subject'];
      const fake = rowsOf('fake fix', await readAsApp('subject', FAKE_LIMIT_SQL, pageParams(k, bid, null, null, PAGE)));
      const everything = rowsOf('canonical, unbounded', await readAsApp('subject', CANONICAL_SQL, pageParams(k, bid, null, null, 1_000_000)));
      console.log(`[open-page] §13 fake fix returned ${fake.length} rows; ${everything.length} invoices are genuinely outstanding`);
      expect(everything.length).toBe(89);
      expect(fake.length).toBe(10);
      expect(fake.length).toBeLessThan(PAGE);
      // It is not merely short: it is a PREFIX of the right answer that stops
      // early, which is why it looks plausible in a log.
      expect(fake).toEqual(everything.slice(0, 10));
    });

    it('the reader returns a FULL PAGE OF 51, and it is the oracle’s page', async () => {
      const k = subject();
      const bid = seeded.businessId['subject'];
      const reader = rowsOf('reader', await readAsApp('subject', READER_SQL, pageParams(k, bid, null, null, PAGE)));
      const oracle = rowsOf('oracle', await readAsApp('subject', ORACLE_SQL, pageParams(k, bid, null, null, PAGE)));
      expect(reader.length).toBe(PAGE);
      expect(oracle.length).toBe(PAGE);
      expect(reader).toEqual(oracle);
      assertStrictlyOrdered(reader);
      assertNoDuplicate(reader);
    });

    it('the oracle itself returns the full page, so the fake fix is wrong about the SEMANTICS and not about the data', async () => {
      const k = subject();
      const bid = seeded.businessId['subject'];
      const oracle = rowsOf('oracle', await readAsApp('subject', ORACLE_SQL, pageParams(k, bid, null, null, PAGE)));
      const fake = rowsOf('fake fix', await readAsApp('subject', FAKE_LIMIT_SQL, pageParams(k, bid, null, null, PAGE)));
      expect(oracle.length).toBe(PAGE);
      expect(fake).not.toEqual(oracle);
    });
  });

  // ───── §11, the standing that makes the oracle an oracle ────────────────

  it('§11 the oracle is test-only: no file under apps/api filters on the settlement function’s output', () => {
    const root = join(__dirname, '../../apps/api/src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts')) continue;
        const text = readFileSync(path, 'utf8');
        // The defect's exact signature: the page's business predicate applied
        // to `invoice_outstanding`'s OUTPUT, which is what stops `LIMIT` from
        // short-circuiting. The single-invoice settlement read at
        // `invoice-reads.ts` keeps its `LATERAL` and is not this shape: it is
        // predicated on the primary key, so its lateral runs once.
        if (/outstanding_txn_minor\s*<>\s*0/.test(text)) offenders.push(path);
      }
    };
    walk(root);
    expect(offenders, `these files still filter on the settlement function's output: ${offenders.join(', ')}`).toEqual([]);
  });

  it('§11 the reader has exactly ONE owning migration, and every serial past the frozen floor is a candidate', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // THE OWNERSHIP CLAIM, which is what this check is named for and what the
    // bound it replaced only ever asserted in its title: exactly ONE migration
    // in the whole history defines the page reader. A later serial that
    // recreated it would be a second place to keep the AR page right, and the
    // live definition would be findable only by reading two files — the very
    // objection `0084`'s own header records and answers.
    expect(
      files.filter((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('customer_open_invoices_page')),
      'the page reader is defined by a number of migrations other than exactly one',
    ).toEqual(['0084_phase4_ar_fixed_cost_and_open_invoice_page.sql']);

    // AND THE SERIALS PAST THE FROZEN FLOOR ARE CANDIDATES, DERIVED.
    //
    // This deliberately does NOT pin the list of serials. An earlier form
    // bounded it at one, and when `0085` arrived its successor pinned the pair
    // exactly — which is the P4-AL-88 shape this project refuses: a list every
    // later pass must append to is a closure rule, not an invariant, and the
    // day someone appends to it instead of thinking is the day it stops
    // protecting anything. Migration-count discipline is the single migration
    // owner's and the manifest's, not this suite's.
    //
    // What IS an invariant, and is asserted from the manifest rather than from
    // a literal: nothing past `frozenThrough` is frozen, and the frozen floor
    // has not moved up to swallow a candidate. That grows to cover each new
    // serial the moment it exists and names none of them.
    const manifest = JSON.parse(readFileSync(join(MIGRATIONS_DIR, '..', 'MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: readonly { readonly name: string }[];
    };
    const frozen = new Set(manifest.migrations.map((m) => m.name));
    const beyond = files.filter((f) => f > manifest.frozenThrough);
    expect(beyond.length, 'no migration exists past the frozen floor, so this slice has no candidate at all').toBeGreaterThan(0);
    expect(
      beyond.filter((f) => frozen.has(f)),
      `a migration past the frozen floor ${manifest.frozenThrough} is also in the frozen manifest, so the two disagree about what is immutable`,
    ).toEqual([]);
    expect(
      files.filter((f) => f <= manifest.frozenThrough && !frozen.has(f)),
      'a migration at or below the frozen floor is absent from the manifest, so the floor covers a file nothing pins',
    ).toEqual([]);
    expect(beyond, 'the page reader’s own migration is not among the candidates').toContain('0084_phase4_ar_fixed_cost_and_open_invoice_page.sql');
  });
});
