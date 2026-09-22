/**
 * The FX fixture — how a test enters and reads a rate the way the merchant
 * API will.
 *
 * Every helper goes through the REAL boundary: it mints a real `acctctl/1`
 * control assertion with the real key and executes the command as
 * `daftar_app`, the one runtime role that may. Nothing here posts as the
 * schema owner or as the internal authority, because a test that borrowed a
 * stronger identity would prove nothing about the path production uses.
 */
import { Client } from 'pg';
import { mintAccountingControlAssertion, type AccountingControlAssertionClaims } from '../../packages/accounting/src/control-assertion';
import { computeFxRateFingerprint, deriveFxRateId } from '../../packages/accounting/src/fx-rate';
import { accountingAssertionKey, appDbUrl } from './test-app';
import { must } from './accounting-posting';

export interface RateFacts {
  tenantId: string;
  businessId: string;
  rateId: string;
  fromCurrency: string;
  toCurrency: string;
  /** Exactly as the caller states it — "3.71" and "3.7100000000" are one value. */
  rate: string;
  effectiveAt: string;
}

export interface RateOutcome {
  rateId: string;
  created: boolean;
}

/** A connection as the one runtime role that may execute the FX commands. */
export async function fxClient(): Promise<Client> {
  const client = new Client({ connectionString: appDbUrl });
  await client.connect();
  return client;
}

/** The rate id a given business and idempotency key derive. */
export function rateIdFor(businessId: string, idempotencyKey: string): string {
  return deriveFxRateId(businessId, idempotencyKey);
}

/** The fingerprint the control authority signs for these facts. */
export function fxFingerprintOf(f: RateFacts): string {
  return computeFxRateFingerprint({
    tenantId: f.tenantId,
    businessId: f.businessId,
    rateId: f.rateId,
    fromCurrency: f.fromCurrency,
    toCurrency: f.toCurrency,
    rate: f.rate,
    effectiveAt: new Date(f.effectiveAt),
    source: 'manual',
  });
}

/** Mint a control assertion, with optional tampering for the authority matrix. */
export function controlAssertion(claims: AccountingControlAssertionClaims, mintedAt: Date = new Date(), ttlSeconds = 60): string {
  return mintAccountingControlAssertion(accountingAssertionKey(), claims, mintedAt, ttlSeconds);
}

/** The assertion an untampered rate entry carries. */
export function assertionFor(f: RateFacts, actorUserId: string): string {
  return controlAssertion({
    actorUserId,
    tenantId: f.tenantId,
    businessId: f.businessId,
    commandKind: 'fx_rate_enter',
    resourceId: f.rateId,
    payloadFingerprint: fxFingerprintOf(f),
  });
}

/**
 * Execute `accounting_fx_rate_enter` in its own transaction, as `daftar_app`,
 * carrying the given assertion in `app.accounting_control_assertion`.
 *
 * `extraGucs` exists for the spoofing cases: a stolen credential would set
 * `app.tenant_id` and friends to whatever it liked, and the point is that
 * doing so changes nothing.
 */
export async function enterRateAs(
  assertion: string | null,
  f: Pick<RateFacts, 'fromCurrency' | 'toCurrency' | 'rate' | 'effectiveAt'>,
  extraGucs: Record<string, string> = {},
  client?: Client,
): Promise<RateOutcome> {
  const own = client === undefined;
  const conn = client ?? (await fxClient());
  try {
    if (own) await conn.query('BEGIN');
    if (assertion !== null) await conn.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
    for (const [k, v] of Object.entries(extraGucs)) await conn.query(`SELECT set_config($1, $2, true)`, [k, v]);
    const r = await conn.query<{ rate_id: string; created: boolean }>(
      `SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`,
      [f.fromCurrency, f.toCurrency, f.rate, f.effectiveAt, 'req-fx-test'],
    );
    if (own) await conn.query('COMMIT');
    return { rateId: must(r.rows[0]).rate_id, created: must(r.rows[0]).created };
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (own) await conn.end().catch(() => undefined);
  }
}

/** Enter a rate with a freshly minted, untampered assertion. */
export async function enterRate(f: RateFacts, actorUserId: string): Promise<RateOutcome> {
  return enterRateAs(assertionFor(f, actorUserId), f);
}

export interface RateSnapshotRow {
  rate_id: string;
  rate: string;
  source: string;
  effective_at: Date;
}

/**
 * Look a rate up as the MERCHANT runtime would, inside the tenant/business
 * scope the application sets — so row level security is genuinely in play and
 * a cross-business read is refused by the database rather than by the test.
 */
export async function lookupRateAs(
  scope: { tenantId: string; businessId: string },
  target: { businessId?: string; from: string; to: string; at: string },
  client?: Client,
): Promise<RateSnapshotRow> {
  const own = client === undefined;
  const conn = client ?? (await fxClient());
  try {
    if (own) await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
      scope.tenantId,
      scope.businessId,
    ]);
    const r = await conn.query<RateSnapshotRow>(
      `SELECT rate_id, rate, source, effective_at FROM accounting_fx_rate_lookup($1::uuid, $2, $3, $4::timestamptz)`,
      [target.businessId ?? scope.businessId, target.from, target.to, target.at],
    );
    if (own) await conn.query('COMMIT');
    return must(r.rows[0]);
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (own) await conn.end().catch(() => undefined);
  }
}

/** The error message of a refused FX command, or a loud failure if it succeeded. */
export async function fxRefusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('the FX command was accepted, but this case requires a refusal');
}
