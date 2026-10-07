/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 15 — THE DISASTER-RECOVERY FIXTURE (Part 76)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STATUS: PREPARED / NOT PROMOTED.
 *
 * WHAT IT SEEDS, AND WHY IT IS NOT AN `INSERT` INTO THE LEDGER
 *
 * A restore proof whose validators run over empty tables is a vacuous green:
 * "the ledger balances" is trivially true of no rows, "tenant isolation holds"
 * is trivially true of no tenants. So the drill seeds real data first, and the
 * financial half of it goes through the REAL boundary — a minted assertion and
 * `accounting_post_manual_adjustment` executed as `daftar_app` — because
 * `journal_entries` has no writer any role may reach and a direct INSERT is
 * refused by design (0042 §8). Writing the ledger any other way would also
 * create a second posting path, which this project forbids outright.
 *
 * Two tenants are seeded, each with its own business and its own posted entry.
 * One tenant proves nothing about isolation: the cross-tenant probe needs rows
 * that MUST NOT be visible, and a single-tenant fixture cannot produce one.
 *
 * This module is framework-free (`node:*`, `pg`, and the accounting package's
 * pure assertion/fingerprint functions). It deliberately does NOT import
 * `tests/helpers/test-app.ts`: that module pulls in the Nest application,
 * whose parameter decorators the plain `tsx` transform refuses, and a DR drill
 * must not need the web framework to run.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { mintAccountingAssertion, type AccountingAssertionKey } from '../../packages/accounting/src/assertion';
import { computeCommandFingerprint } from '../../packages/accounting/src/post';

/** The fixture's own assertion key. A throwaway cluster's secret, never a deployment's. */
export const DR_ASSERTION_KID = 'p15dr';
export const DR_ASSERTION_SECRET = Buffer.alloc(32, 'P');
const DR_KEY: AccountingAssertionKey = { kid: DR_ASSERTION_KID, secret: DR_ASSERTION_SECRET };

/** The runtime role the posting path uses, with the throwaway cluster's fixture password. */
export const APP_ROLE = 'daftar_app';
export const APP_PASSWORD = 'test_app_password_123';

export interface SeededTenant {
  readonly tenantId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly slug: string;
  /** The entry this tenant's posting produced — the row a cross-tenant probe must not see. */
  readonly entryId: string;
  readonly amountMinor: string;
}

export interface Fixture {
  readonly tenants: readonly SeededTenant[];
  readonly baseCurrency: string;
  readonly timezone: string;
  readonly entryDate: string;
}

const TIMEZONE = 'Asia/Hebron';
const BASE_CURRENCY = 'ILS';

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`dr-fixture: ${what} was expected and is missing`);
  return v;
}

/** Install the fixture's accounting assertion key through the platform-only ops command (0044). */
export async function installAssertionKey(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [DR_ASSERTION_KID, DR_ASSERTION_SECRET.toString('base64')]);
  } finally {
    await pool.end();
  }
}

/** The civil date today in the business timezone — what the primitive compares against. */
export async function todayInBusinessTimezone(pool: Pool): Promise<string> {
  const r = await pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [TIMEZONE]);
  return must(r.rows[0], 'today in business timezone').d;
}

/** A balanced two-line domestic adjustment: cash debit, opening-equity credit, integer minor units. */
function lines(amountMinor: bigint): readonly {
  readonly account: { readonly kind: 'system'; readonly systemKey: string };
  readonly side: 'D' | 'C';
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: 'base';
  readonly fxRateAt: Date;
  readonly branchId: null;
  readonly warehouseId: null;
}[] {
  const at = new Date('2026-03-14T09:15:00Z');
  const common = {
    baseAmountMinor: amountMinor,
    baseCurrency: BASE_CURRENCY,
    txnAmountMinor: amountMinor,
    txnCurrency: BASE_CURRENCY,
    fxRate: '1',
    fxRateSource: 'base' as const,
    fxRateAt: at,
    branchId: null,
    warehouseId: null,
  };
  return [
    { account: { kind: 'system' as const, systemKey: 'cash' }, side: 'D' as const, ...common },
    { account: { kind: 'system' as const, systemKey: 'opening_equity' }, side: 'C' as const, ...common },
  ];
}

/** A rate as the primitive's exact schema requires it: ten fraction digits. */
function rate10(value: string): string {
  const [w, f = ''] = value.split('.');
  return `${w}.${f.padEnd(10, '0')}`;
}

/** The JSONB payload, exactly the twelve keys the primitive accepts. */
function payload(amountMinor: bigint): unknown[] {
  return lines(amountMinor).map((l) => ({
    account: { kind: 'system', system_key: l.account.systemKey },
    side: l.side,
    base_amount_minor: l.baseAmountMinor.toString(),
    base_currency: l.baseCurrency,
    txn_amount_minor: l.txnAmountMinor.toString(),
    txn_currency: l.txnCurrency,
    fx_rate: rate10(l.fxRate),
    fx_rate_source: l.fxRateSource,
    fx_rate_at: `${l.fxRateAt.toISOString().slice(0, 19)}Z`,
    branch_id: l.branchId,
    warehouse_id: l.warehouseId,
    memo: null,
  }));
}

/**
 * Post one balanced entry as `daftar_app` with a real assertion.
 *
 * The fingerprint is computed from the same command the payload renders, so the
 * database's own recomputation must agree; a mismatch is a refusal, which is
 * exactly the property that makes this a real posting rather than a fixture
 * bypass.
 */
async function postEntry(
  appUrl: string,
  t: { readonly tenantId: string; readonly businessId: string; readonly userId: string },
  entryDate: string,
  amountMinor: bigint,
): Promise<string> {
  const sourceId = randomUUID();
  const command = {
    tenantId: t.tenantId,
    businessId: t.businessId,
    sourceType: 'manual_adjustment',
    sourceId,
    entryDate,
    lines: lines(amountMinor).map((l) => ({ ...l })),
  };
  const assertion = mintAccountingAssertion(
    DR_KEY,
    {
      actorUserId: t.userId,
      tenantId: t.tenantId,
      businessId: t.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId,
      postingFingerprint: computeCommandFingerprint(command),
    },
    new Date(),
    60,
  );
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    const r = await client.query<{ entry_id: string }>(`SELECT entry_id FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`, [
      entryDate,
      'Phase 15 DR fixture posting',
      'seeded so the restore validators are not vacuous',
      null,
      JSON.stringify(payload(amountMinor)),
    ]);
    await client.query('COMMIT');
    return must(r.rows[0], 'posted entry id').entry_id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Seed two tenants, each with one posted balanced entry. */
export async function seedFixture(ownerPool: Pool, appUrl: string): Promise<Fixture> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> =>
    must((await ownerPool.query<{ id: string }>(sql, params)).rows[0], `row from ${sql.slice(0, 40)}`).id;
  const entryDate = await todayInBusinessTimezone(ownerPool);
  const stamp = Date.now();
  const amounts = [150000n, 275500n];
  const tenants: SeededTenant[] = [];

  for (const [i, amount] of amounts.entries()) {
    const slug = `p15dr-${i + 1}-${stamp}`;
    const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, $2, $3, 'PS', $4, $5) RETURNING id`,
      [tenantId, `DR Fixture ${i + 1}`, slug, BASE_CURRENCY, TIMEZONE],
    );
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`, [
      `${slug}@dr.daftar.local`,
      `DR Poster ${i + 1}`,
    ]);
    const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
    const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
      businessId,
      branchId,
    ]);
    const entryId = await postEntry(appUrl, { tenantId, businessId, userId }, entryDate, amount);
    tenants.push({ tenantId, businessId, userId, branchId, warehouseId, slug, entryId, amountMinor: amount.toString() });
  }

  if (tenants.length < 2) throw new Error('dr-fixture: the isolation probe needs at least two tenants; refusing to report a one-tenant fixture');
  return { tenants, baseCurrency: BASE_CURRENCY, timezone: TIMEZONE, entryDate };
}
