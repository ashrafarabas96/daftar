/**
 * The posting fixture — how a test calls the P2-S3 primitive the way the
 * merchant API will.
 *
 * Every helper here goes through the REAL boundary: it mints a real assertion
 * with the real key and executes `accounting_post_entry` as `daftar_app`, the
 * one runtime role that may. Nothing here can post as the schema owner or as
 * the internal authority, because a test that borrowed a stronger identity
 * would prove nothing about the path production actually uses.
 */
import { Client } from 'pg';
import { computeCommandFingerprint } from '../../packages/accounting/src/post';
import type { AccountRef, PostingLineCommand, PostingSide } from '../../packages/accounting/src/types';
import { appDbUrl, mintTestAccountingAssertion } from './test-app';

export interface PostLine {
  account: AccountRef;
  side: PostingSide;
  baseAmountMinor: bigint;
  baseCurrency: string;
  txnAmountMinor: bigint;
  txnCurrency: string;
  fxRate: string;
  fxRateSource: 'base' | 'manual' | 'provider';
  fxRateAt: Date;
  branchId?: string | null;
  warehouseId?: string | null;
  memo?: string | null;
}

export interface PostCommand {
  tenantId: string;
  businessId: string;
  sourceType: string;
  sourceId: string;
  entryDate: string;
  description?: string;
  requestId?: string;
  lines: PostLine[];
}

const full = (l: PostLine): PostingLineCommand => ({
  account: l.account,
  side: l.side,
  baseAmountMinor: l.baseAmountMinor,
  baseCurrency: l.baseCurrency,
  txnAmountMinor: l.txnAmountMinor,
  txnCurrency: l.txnCurrency,
  fxRate: l.fxRate,
  fxRateSource: l.fxRateSource,
  fxRateAt: l.fxRateAt,
  branchId: l.branchId ?? null,
  warehouseId: l.warehouseId ?? null,
  ...(l.memo === undefined || l.memo === null ? {} : { memo: l.memo }),
});

/** A rate as the primitive's exact schema requires it: ten fraction digits. */
export function rate10(value: string): string {
  const [w, f = ''] = value.split('.');
  return `${w}.${f.padEnd(10, '0')}`;
}

/** The JSONB payload, exactly the twelve keys the primitive accepts. */
export function dbPayload(lines: readonly PostLine[]): unknown[] {
  return lines.map((l) => ({
    account: l.account.kind === 'system' ? { kind: 'system', system_key: l.account.systemKey } : { kind: 'code', code: l.account.code },
    side: l.side,
    base_amount_minor: l.baseAmountMinor.toString(),
    base_currency: l.baseCurrency,
    txn_amount_minor: l.txnAmountMinor.toString(),
    txn_currency: l.txnCurrency,
    fx_rate: rate10(l.fxRate),
    fx_rate_source: l.fxRateSource,
    fx_rate_at: `${l.fxRateAt.toISOString().slice(0, 19)}Z`,
    branch_id: l.branchId ?? null,
    warehouse_id: l.warehouseId ?? null,
    memo: l.memo ?? null,
  }));
}

/** The fingerprint the engine would sign for this command. */
export function fingerprintOf(c: PostCommand): string {
  return computeCommandFingerprint({
    tenantId: c.tenantId,
    businessId: c.businessId,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    entryDate: c.entryDate,
    lines: c.lines.map(full),
  });
}

export interface AssertionOverrides {
  actorUserId?: string;
  tenantId?: string;
  businessId?: string;
  sourceType?: string;
  sourceId?: string;
  postingFingerprint?: string;
  /** Mint as if `now` were this instant — an expired assertion is minted in the past. */
  mintedAt?: Date;
  ttlSeconds?: number;
}

/** Mint the assertion this command would carry, with optional tampering. */
export function assertionFor(c: PostCommand, actorUserId: string, o: AssertionOverrides = {}): string {
  return mintTestAccountingAssertion(
    {
      actorUserId: o.actorUserId ?? actorUserId,
      tenantId: o.tenantId ?? c.tenantId,
      businessId: o.businessId ?? c.businessId,
      operationKind: 'post',
      sourceType: o.sourceType ?? c.sourceType,
      sourceId: o.sourceId ?? c.sourceId,
      postingFingerprint: o.postingFingerprint ?? fingerprintOf(c),
    },
    o.mintedAt ?? new Date(),
    o.ttlSeconds ?? 60,
  );
}

/** A connection as the one runtime role that may execute the primitive. */
export async function appClient(): Promise<Client> {
  const client = new Client({ connectionString: appDbUrl });
  await client.connect();
  return client;
}

export interface PostOutcome {
  entryId: string;
  created: boolean;
}

/**
 * Execute the primitive in its own transaction, as `daftar_app`, carrying the
 * given assertion in `app.accounting_assertion`.
 *
 * `extraGucs` exists for the spoofing cases: a stolen credential would set
 * `app.business_id` and friends to whatever it liked, and the point is that
 * doing so changes nothing.
 */
export async function postAs(assertion: string | null, c: PostCommand, extraGucs: Record<string, string> = {}, client?: Client): Promise<PostOutcome> {
  const own = client === undefined;
  const conn = client ?? (await appClient());
  try {
    if (own) await conn.query('BEGIN');
    if (assertion !== null) await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    for (const [k, v] of Object.entries(extraGucs)) await conn.query(`SELECT set_config($1, $2, true)`, [k, v]);
    const r = await conn.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
      c.entryDate,
      c.description ?? 'test posting',
      c.requestId ?? null,
      JSON.stringify(dbPayload(c.lines)),
    ]);
    if (own) await conn.query('COMMIT');
    return { entryId: must(r.rows[0]).entry_id, created: must(r.rows[0]).created };
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (own) await conn.end().catch(() => undefined);
  }
}

/** Post with a freshly minted, untampered assertion. */
export async function post(c: PostCommand, actorUserId: string, o: AssertionOverrides = {}): Promise<PostOutcome> {
  return postAs(assertionFor(c, actorUserId, o), c);
}

/** The error message of a refused post, or `null` if it unexpectedly succeeded. */
export async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('the posting was accepted, but this case requires a refusal');
}

export interface PostingFixture {
  tenantId: string;
  businessId: string;
  userId: string;
  branchId: string;
  otherBranchId: string;
  warehouseId: string;
  /** A second tenant + business, for the cross-business cases. */
  otherTenantId: string;
  otherBusinessId: string;
  otherUserId: string;
}

/**
 * One tenant with a business whose chart is seeded by `0040`'s trigger, plus a
 * second tenant nobody in the first may reach.
 */
export async function seedPostingFixture(pool: import('pg').Pool, slug = 'posting'): Promise<PostingFixture> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await pool.query<{ id: string }>(sql, params)).rows[0]).id;

  const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const businessId = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'Posting One', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantId, `${slug}-one`],
  );
  const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Poster') RETURNING id`, [
    `${slug}-poster-${Date.now()}@test.daftar.local`,
  ]);
  const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
  const otherBranchId = await one(`INSERT INTO branches (business_id, name) VALUES ($1, 'Second') RETURNING id`, [businessId]);
  const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    businessId,
    branchId,
  ]);

  const otherTenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const otherBusinessId = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'Posting Two', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [otherTenantId, `${slug}-two`],
  );
  const otherUserId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Other') RETURNING id`, [
    `${slug}-other-${Date.now()}@test.daftar.local`,
  ]);

  return { tenantId, businessId, userId, branchId, otherBranchId, warehouseId, otherTenantId, otherBusinessId, otherUserId };
}

/** The civil date today in the business timezone — what the primitive compares against. */
export async function todayIn(pool: import('pg').Pool, timezone: string): Promise<string> {
  const r = await pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [timezone]);
  return must(r.rows[0]).d;
}

/** A balanced two-line domestic command: cash debit, opening equity credit. */
export function simpleCommand(fx: PostingFixture, sourceId: string, entryDate: string, amount = 150000n, sourceType = 'manual_adjustment'): PostCommand {
  const at = new Date('2026-03-14T09:15:00Z');
  return {
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    sourceType,
    sourceId,
    entryDate,
    description: 'a balanced posting',
    requestId: 'req-test',
    lines: [
      {
        account: { kind: 'system', systemKey: 'cash' },
        side: 'D',
        baseAmountMinor: amount,
        baseCurrency: 'ILS',
        txnAmountMinor: amount,
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: at,
        branchId: null,
        warehouseId: null,
      },
      {
        account: { kind: 'system', systemKey: 'opening_equity' },
        side: 'C',
        baseAmountMinor: amount,
        baseCurrency: 'ILS',
        txnAmountMinor: amount,
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: at,
        branchId: null,
        warehouseId: null,
      },
    ],
  };
}

/**
 * Narrow an optional to its value, loudly.
 *
 * `noUncheckedIndexedAccess` makes every indexed read optional and the lint
 * rules forbid `!`, so a test that means "there is a row here" says so with
 * this — and a missing row fails as a clear error rather than as
 * `Cannot read properties of undefined`.
 */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, found none`);
  return value;
}
