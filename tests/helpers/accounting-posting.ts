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
import {
  computeOpeningBalanceFingerprint,
  computeReversalFingerprint,
  deriveOpeningBalanceLines,
  mirrorReversalLines,
  type PostedEntrySnapshot,
} from '../../packages/accounting/src/sources';
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
    // A `manual_adjustment` goes through the command that OWNS it.
    //
    // Since round three every Phase-2-native source owes a detail row at
    // COMMIT, so driving the primitive straight produces an entry the
    // database refuses — correctly, because such an entry would carry no
    // reason and no actor. The wrapper is a thin one: it narrows the
    // authority, requires a reason, and forwards THIS assertion and THIS
    // payload to `accounting_post_entry` unchanged. Everything these suites
    // prove about the primitive — replay, idempotent identity, tenancy from
    // the assertion, indifference to spoofed GUCs — is proved through it
    // exactly as before.
    //
    // A suite that genuinely needs the raw primitive (the completeness
    // bypass matrix) issues the call itself rather than asking for it here,
    // because doing so is the thing under test and should be visible where
    // it happens.
    const r =
      c.sourceType === 'manual_adjustment'
        ? await conn.query<{ entry_id: string; created: boolean }>(
            `SELECT entry_id, created FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`,
            [c.entryDate, c.description ?? 'test posting', 'a fixture adjustment', c.requestId ?? null, JSON.stringify(dbPayload(c.lines))],
          )
        : await conn.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
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

// ── P2-S4 sources ─────────────────────────────────────────────────────────
//
// Same discipline as everything above: every helper goes through the REAL
// boundary, as `daftar_app`, carrying a real assertion minted with the real
// key. Nothing here borrows the schema owner's identity or the internal
// principal's, because a test that did would prove nothing about the path
// production uses.

/** Mint an assertion for a source command, with optional tampering. */
export function sourceAssertion(
  claims: {
    actorUserId: string;
    tenantId: string;
    businessId: string;
    operationKind: 'post' | 'reverse';
    sourceType: string;
    sourceId: string;
    postingFingerprint: string;
  },
  mintedAt: Date = new Date(),
  ttlSeconds = 60,
): string {
  return mintTestAccountingAssertion(claims, mintedAt, ttlSeconds);
}

/** Execute `accounting_post_manual_adjustment` as the merchant runtime. */
export async function postAdjustmentAs(assertion: string, c: PostCommand, reason: string, client?: Client): Promise<PostOutcome> {
  const own = client === undefined;
  const conn = client ?? (await appClient());
  try {
    if (own) await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    const r = await conn.query<{ entry_id: string; created: boolean }>(
      `SELECT entry_id, created FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`,
      [c.entryDate, c.description ?? null, reason, c.requestId ?? null, JSON.stringify(dbPayload(c.lines))],
    );
    if (own) await conn.query('COMMIT');
    return { entryId: must(r.rows[0]).entry_id, created: must(r.rows[0]).created };
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (own) await conn.end().catch(() => undefined);
  }
}

/** Execute `accounting_post_reversal` as the merchant runtime. */
export async function postReversalAs(
  assertion: string,
  originalEntryId: string,
  entryDate: string | null,
  reason: string,
  requestId: string | null = 'req-reversal',
  client?: Client,
): Promise<PostOutcome> {
  const own = client === undefined;
  const conn = client ?? (await appClient());
  try {
    if (own) await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    const r = await conn.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_reversal($1::uuid, $2::date, $3, $4)`, [
      originalEntryId,
      entryDate,
      reason,
      requestId,
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

/** The position payload `accounting_open_balance_draft` accepts — ten keys, no branch. */
export function positionPayload(lines: readonly PostLine[]): unknown[] {
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
    memo: l.memo ?? null,
  }));
}

/** Open a draft and post it, in ONE transaction, exactly as the adapter does. */
export async function postOpeningBalanceAs(
  assertion: string,
  input: { asOfDate: string; positions: readonly PostLine[]; openingBalanceId: string; description?: string | null; requestId?: string | null },
  client?: Client,
): Promise<PostOutcome> {
  const own = client === undefined;
  const conn = client ?? (await appClient());
  try {
    if (own) await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    await conn.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [input.asOfDate, JSON.stringify(positionPayload(input.positions))]);
    const r = await conn.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_open_balance_post($1::uuid, $2, $3)`, [
      input.openingBalanceId,
      input.description ?? null,
      input.requestId ?? 'req-opening',
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

/**
 * The fingerprint a reversal authority signs, built from the command that was
 * posted rather than from a database read.
 *
 * That is deliberate: it makes every reversal case an independent derivation
 * of the mirror, so a test passes only when the test's mirror, the engine's
 * mirror and the database's mirror all agree. A helper that asked the database
 * what the mirror should be would agree with the database by construction and
 * prove nothing.
 */
export function reversalFingerprintOf(original: PostCommand, originalEntryId: string, entryDate: string): string {
  const snapshot: PostedEntrySnapshot = {
    entryId: originalEntryId,
    tenantId: original.tenantId,
    businessId: original.businessId,
    sourceType: original.sourceType,
    entryDate: original.entryDate,
    lines: original.lines.map((l, i) => ({
      lineNo: i + 1,
      account: l.account,
      side: l.side,
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency: l.baseCurrency,
      txnAmountMinor: l.txnAmountMinor,
      txnCurrency: l.txnCurrency,
      fxRate: rate10(l.fxRate),
      fxRateSource: l.fxRateSource,
      fxRateAt: l.fxRateAt,
      branchId: l.branchId ?? null,
      warehouseId: l.warehouseId ?? null,
      memo: l.memo ?? null,
    })),
  };
  return computeReversalFingerprint(snapshot, entryDate, mirrorReversalLines(snapshot));
}

/**
 * The same fingerprint, for an entry whose lines the ENGINE derived rather
 * than the caller — an opening balance, whose equity plug no test writes by
 * hand. The snapshot still comes from the test's own derivation, so the
 * mirror is independently computed exactly as it is above.
 */
export function reversalFingerprintOfSnapshot(snapshot: PostedEntrySnapshot, entryDate: string): string {
  return computeReversalFingerprint(snapshot, entryDate, mirrorReversalLines(snapshot));
}

/** The posted shape of an opening balance, derived the way the engine derives it. */
export function openingBalanceSnapshot(input: {
  entryId: string;
  tenantId: string;
  businessId: string;
  asOfDate: string;
  baseCurrency: string;
  positions: readonly PostLine[];
}): PostedEntrySnapshot {
  const lines = deriveOpeningBalanceLines(
    input.positions.map((p) => ({
      account: p.account,
      side: p.side,
      baseAmountMinor: p.baseAmountMinor,
      baseCurrency: p.baseCurrency,
      txnAmountMinor: p.txnAmountMinor,
      txnCurrency: p.txnCurrency,
      fxRate: rate10(p.fxRate),
      fxRateSource: p.fxRateSource === 'provider' ? 'manual' : p.fxRateSource,
      fxRateAt: p.fxRateAt,
      memo: p.memo ?? null,
    })),
    input.baseCurrency,
    input.asOfDate,
  );
  return {
    entryId: input.entryId,
    tenantId: input.tenantId,
    businessId: input.businessId,
    sourceType: 'opening_balance',
    entryDate: input.asOfDate,
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      account: l.account,
      side: l.side,
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency: l.baseCurrency,
      txnAmountMinor: l.txnAmountMinor,
      txnCurrency: l.txnCurrency,
      fxRate: l.fxRate,
      fxRateSource: l.fxRateSource,
      fxRateAt: l.fxRateAt,
      branchId: null,
      warehouseId: null,
      memo: l.memo ?? null,
    })),
  };
}

/** The fingerprint an opening-balance authority signs, over the engine-derived lines. */
export function openingBalanceFingerprintOf(input: {
  tenantId: string;
  businessId: string;
  openingBalanceId: string;
  asOfDate: string;
  baseCurrency: string;
  positions: readonly PostLine[];
}): string {
  const lines = deriveOpeningBalanceLines(
    input.positions.map((p) => ({
      account: p.account,
      side: p.side,
      baseAmountMinor: p.baseAmountMinor,
      baseCurrency: p.baseCurrency,
      txnAmountMinor: p.txnAmountMinor,
      txnCurrency: p.txnCurrency,
      fxRate: rate10(p.fxRate),
      fxRateSource: p.fxRateSource === 'provider' ? 'manual' : p.fxRateSource,
      fxRateAt: p.fxRateAt,
      memo: p.memo ?? null,
    })),
    input.baseCurrency,
    input.asOfDate,
  );
  return computeOpeningBalanceFingerprint(input, lines);
}
