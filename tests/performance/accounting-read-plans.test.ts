/**
 * THE INDEX DECISION, MEASURED (P2-S7 §12, §13, §14, §57, §71).
 *
 * `0050_accounting_report_indexes.sql` is OPTIONAL, and the directive is
 * explicit about the order: implement the reports against the schema 0049
 * already froze, MEASURE, and create a migration only if the evidence asks
 * for one. An index added because indexes are usually a good idea is a
 * change to frozen-adjacent schema nobody can point at a reason for.
 *
 * So this file is the evidence. It seeds a dataset of the size a small
 * merchant reaches after a couple of years, runs the three reads that matter
 * under `EXPLAIN (ANALYZE, BUFFERS)`, and asserts the plan properties the
 * decision turned on. The numbers it prints are what `docs/PHASE_2_S7_
 * ACCEPTANCE.md` records.
 *
 * What this is NOT: the P2-S8 performance gate. There is no million-line
 * dataset here, no latency budget and no throughput target (§67). The only
 * question being answered is whether the planner can reach one account's
 * lines and one date range's entries without reading the whole journal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData, uniqueEmail, createTestApp, type TestApp } from '../helpers/test-app';
import { must, todayIn } from '../helpers/accounting-posting';

/** Entries seeded. Two years of a merchant posting a few dozen times a week. */
const ENTRIES = 4_000;

/**
 * Every account of the seeded chart, because the selectivity of "one
 * account" is the whole question. A fixture using a handful of accounts
 * would put 12% of the journal behind each one, which is the one region
 * where the planner's choice is genuinely a toss-up — and a measurement
 * taken there would say more about the fixture than about the product.
 *
 * THE SHAPE, AND WHY IT IS NOT UNIFORM (correction, P2-S8 §7 revalidation).
 *
 * The first version of this fixture spread both lines of every entry evenly
 * across all 21 accounts, which gave each account ~4.8% of the journal. That
 * put the measured account back INSIDE the toss-up region the paragraph above
 * warns about: at that selectivity, reaching a page through the account index
 * and walking the entries by date cost the planner almost the same, so which
 * one it chose was decided by the statistics ANALYZE happened to sample. The
 * test was green on one run and red on the next with no code change between
 * them, and a measurement that can flip like that is not evidence.
 *
 * So the fixture now has the shape a real ledger has. Every manual adjustment
 * moves CASH, and the other side lands on one of the remaining accounts: one
 * dense account carrying half the journal, twenty sparse ones carrying 2.5%
 * each. The index decision is then measured where it actually matters and
 * where no planner is in two minds — on a sparse account — and the dense
 * account is measured too, for the property that holds either way.
 */
const ACCOUNTS_USED = 21;

/**
 * One entry in every SPARSE_EVERY posts to the sparse account.
 *
 * The number is chosen to sit clearly OUTSIDE the region where the two plans
 * cost the same, not to make a particular plan win: at roughly 0.8% of the
 * journal, answering "the first fifty lines of this account" by walking the
 * entries in date order means visiting thousands of entries to find fifty
 * rows, while the account index visits about sixty. No cost model is in two
 * minds about that, which is precisely the point — the assertion must hold on
 * any planner, not on the one this machine happens to run.
 *
 * It is also the shape of a real chart. A merchant's bank-charges or
 * rounding-difference account is touched a handful of times a year while cash
 * moves on every entry.
 */
const SPARSE_EVERY = 64;

let t: TestApp;
let businessId: string;
let tenantId: string;
let today: string;
let cashId: string;
/** A sparse account: the side of the entry that is NOT cash. */
let sparseId: string;
const plans: Record<string, PlanSummary> = {};

interface PlanSummary {
  readonly rows: number;
  readonly ms: number;
  readonly sharedRead: number;
  readonly scans: string[];
  readonly text: string;
}

async function explain(sql: string, params: readonly unknown[]): Promise<PlanSummary> {
  const client = await ownerPool().connect();
  try {
    const res = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, COSTS, FORMAT TEXT) ${sql}`, [...params]);
    const text = res.rows.map((r) => r['QUERY PLAN']).join('\n');
    const scans = [...text.matchAll(/(Seq Scan on (\w+)|Index (?:Only )?Scan (?:Backward )?using (\w+))/g)].map((m) => m[0]);
    return {
      rows: Number(/rows=(\d+)/.exec(text)?.[1] ?? '0'),
      ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '0'),
      sharedRead: Number(/shared hit=(\d+)/.exec(text)?.[1] ?? '0'),
      scans,
      text,
    };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();

  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Perf', preferredLocale: 'ar' });
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const userId = me.body.userId as string;
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${Date.now()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Volume Books', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `perf-${Date.now()}` });
  expect(on.status).toBe(201);
  businessId = on.body.businessId as string;
  tenantId = must((await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId])).rows[0]).tenant_id;
  today = await todayIn(ownerPool(), 'Asia/Hebron');

  const accounts = (
    await ownerPool().query<{ id: string; code: string }>(`SELECT id, code FROM accounts WHERE business_id = $1 ORDER BY code LIMIT $2`, [
      businessId,
      ACCOUNTS_USED,
    ])
  ).rows;
  cashId = must(accounts.find((a) => a.code === '1000')).id;
  const others = accounts.filter((a) => a.id !== cashId);
  sparseId = must(others[0]).id;
  /** The nineteen accounts that carry the ordinary traffic. */
  const busyIds = others.slice(1).map((a) => a.id);

  // The journal is seeded in bulk, as the schema owner, because the point of
  // this file is the SHAPE of the data the planner sees: four thousand
  // entries posted through the real command would take minutes and would
  // prove nothing this does not. Every row is still a well-formed, balanced
  // entry — the deferred constraint triggers are left ON, so that is checked
  // at COMMIT rather than merely claimed here.
  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE seed_ids (entry_id UUID, source_id UUID, i INT) ON COMMIT DROP`);
    await client.query(`INSERT INTO seed_ids SELECT gen_random_uuid(), gen_random_uuid(), g FROM generate_series(0, $1::int - 1) AS g`, [ENTRIES]);
    await client.query(
      `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                    actor_kind, actor_user_id, request_id, posting_fingerprint)
       SELECT $1, $2, s.entry_id, current_date - (s.i % 730), 'manual_adjustment', s.source_id, 'seeded',
              'user', $3, 'perf', md5(s.entry_id::text) || md5(s.i::text)
         FROM seed_ids s`,
      [tenantId, businessId, userId],
    );
    // Direction 2 of the journal's own FK pair: an entry that reaches COMMIT
    // without a registered source identity is refused by the database. The
    // bulk seed obeys that like any other writer.
    await client.query(
      `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
       SELECT $1, $2, 'manual_adjustment', s.source_id, s.entry_id FROM seed_ids s`,
      [tenantId, businessId],
    );
    // …and AL-01's own half: a manual adjustment carries its reason and its
    // actor, or the journal refuses it.
    await client.query(
      `INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id)
       SELECT $1, $2, s.source_id, 'seeded for the read-plan measurement', $3 FROM seed_ids s`,
      [tenantId, businessId, userId],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                                  debit_minor, credit_minor, base_amount_minor, base_currency,
                                  txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
       SELECT $1, $2, gen_random_uuid(), s.entry_id, v.line_no, v.account,
              v.debit, v.credit, 1000 + (s.i % 997), 'ILS', 1000 + (s.i % 997), 'ILS', 1, 'base', date_trunc('second', now())
         FROM seed_ids s
         CROSS JOIN LATERAL (VALUES
                (1, $3::uuid, 1000 + (s.i % 997), 0),
                (2, CASE WHEN s.i % $6::int = 0 THEN $4::uuid ELSE ($5::uuid[])[(s.i % $7::int) + 1] END,
                    0, 1000 + (s.i % 997))
              ) AS v(line_no, account, debit, credit)`,
      [tenantId, businessId, cashId, sparseId, busyIds, SPARSE_EVERY, busyIds.length],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  await ownerPool().query('ANALYZE journal_entries');
  await ownerPool().query('ANALYZE journal_lines');
}, 600_000);

describe('the three reads, under EXPLAIN (ANALYZE, BUFFERS) (§13, §57, §71)', () => {
  it('measures the trial balance over the whole history', async () => {
    plans['trial balance'] = await explain(
      `SELECT a.id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
         FROM accounts a
         LEFT JOIN (SELECT l.account_id, l.debit_minor, l.credit_minor
                      FROM journal_lines l
                      JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
                     WHERE l.business_id = $1 AND e.business_id = $1 AND e.entry_date <= $2::date) l ON l.account_id = a.id
        WHERE a.business_id = $1
        GROUP BY a.id`,
      [businessId, today],
    );
    expect(must(plans['trial balance']).rows).toBeGreaterThan(0);
  });

  const LEDGER_PAGE = `SELECT l.journal_entry_id, l.line_no, l.debit_minor, l.credit_minor
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE l.business_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3::date AND $4::date
        ORDER BY e.entry_date, l.journal_entry_id, l.line_no
        LIMIT 50`;

  it('measures one page of a SPARSE account’s ledger', async () => {
    plans['ledger page'] = await explain(LEDGER_PAGE, [businessId, sparseId, '2000-01-01', today]);
    expect(must(plans['ledger page']).rows).toBeGreaterThan(0);
  });

  it('measures one page of the DENSE account’s ledger', async () => {
    plans['ledger page (dense)'] = await explain(LEDGER_PAGE, [businessId, cashId, '2000-01-01', today]);
    expect(must(plans['ledger page (dense)']).rows).toBeGreaterThan(0);
  });

  it('measures one keyset page of the entry list', async () => {
    plans['entry page'] = await explain(
      `SELECT e.id, e.entry_date
         FROM journal_entries e
        WHERE e.business_id = $1 AND e.entry_date BETWEEN $2::date AND $3::date
          AND (e.entry_date, e.id) > ($2::date, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY e.entry_date, e.id
        LIMIT 50`,
      [businessId, '2000-01-01', today],
    );
    expect(must(plans['entry page']).rows).toBeGreaterThan(0);
  });

  it('measures one account balance as of a date', async () => {
    plans['account balance'] = await explain(
      `SELECT sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE l.business_id = $1 AND l.account_id = $2 AND e.entry_date <= $3::date`,
      [businessId, sparseId, today],
    );
    expect(must(plans['account balance']).rows).toBeGreaterThan(0);
  });

  /**
   * THE FINDING, as an assertion rather than a paragraph (§13, §57).
   *
   * A merchant opening ONE account's ledger and asking for the FIRST PAGE
   * must not cause the database to read the whole business's journal. That
   * cost is proportional to the merchant's entire history, so it gets worse
   * every day they trade. `0050_accounting_report_indexes.sql` exists for
   * exactly this line, and if the index were dropped or stopped being
   * chosen, this is what would say so.
   */
  it('reaches a sparse account\u2019s ledger page through the account index', () => {
    const plan = must(plans['ledger page']);
    expect(plan.scans.some((s) => s === 'Seq Scan on journal_lines')).toBe(false);
    expect(plan.text).toContain('journal_lines_business_account_idx');
  });

  /**
   * And the whole of that account's history, which has no LIMIT to stop it
   * early. This is the read the index most clearly exists for: without it the
   * only way to total one account is to visit every entry of the business.
   */
  it('totals a sparse account through the account index', () => {
    const plan = must(plans['account balance']);
    expect(plan.scans.some((s) => s === 'Seq Scan on journal_lines')).toBe(false);
    expect(plan.text).toContain('journal_lines_business_account_idx');
  });

  /**
   * The dense account, and the honest limit of what can be asserted about it.
   *
   * Half this journal is cash, so a page of the cash ledger is reachable both
   * ways for about the same cost: through the account index, or by walking
   * the entries in date order and taking the cash line of each. Which one a
   * planner picks is a version-and-statistics decision, and PostgreSQL 16 and
   * 18 were observed picking differently on identical data — so asserting a
   * particular index here would be asserting a planner's taste, not a
   * property of the product (§38).
   *
   * What IS a property, and is asserted: the page must never fall back to
   * reading the journal's lines end to end. That fails the moment 0050 is
   * dropped, on either version.
   */
  it('never reads the journal end to end for the dense account\u2019s page', () => {
    const plan = must(plans['ledger page (dense)']);
    expect(plan.scans.some((s) => s === 'Seq Scan on journal_lines')).toBe(false);
  });

  /**
   * The entry list's ordering tuple IS an index, so a keyset page is a range
   * scan over the rows of that page and not a sort of the whole journal.
   */
  it('pages the entry list by its ordering tuple', () => {
    const plan = must(plans['entry page']);
    expect(plan.text).toContain('journal_entries_business_date_idx');
  });

  /**
   * And the counter-case. The whole-business trial balance aggregates every
   * line of the business by construction, so there is no "just this part" an
   * index could find: it was measured, and it got nothing. The claim is
   * about the migration rather than the plan, because which node the planner
   * picks for a full aggregate is its business and changes between versions;
   * what must not change is that nobody added an index for a query that
   * reads everything (§12).
   */
  it('creates exactly the two indexes the measurement asked for, and no others', () => {
    const sql = readFileSync(join(__dirname, '../../infrastructure/database/migrations/0050_accounting_report_indexes.sql'), 'utf8');
    const created = [...sql.matchAll(/CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)/gi)].map((m) => `${m[2]}.${m[1]}`);
    expect(created).toEqual(['journal_lines.journal_lines_business_account_idx', 'journal_entries.journal_entries_business_date_idx']);
    expect(sql).not.toMatch(/CREATE\s+(TABLE|MATERIALIZED\s+VIEW|FUNCTION|TRIGGER|POLICY)/i);
  });

  it('records the decision the measurement supports', () => {
    const lines: string[] = [];
    for (const [name, plan] of Object.entries(plans)) {
      lines.push(`${name.padEnd(16)} rows=${String(plan.rows).padStart(6)}  ${plan.ms.toFixed(2).padStart(8)} ms   ${plan.scans.join(', ')}`);
    }
    console.log(`\nP2-S7 read-plan measurement — ${ENTRIES} entries, ${ENTRIES * 2} lines, ${ACCOUNTS_USED} accounts\n${lines.join('\n')}\n`);
    expect(Object.keys(plans).length).toBe(5);
  });
});
