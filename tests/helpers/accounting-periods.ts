/**
 * The period fixture — how a test creates, closes and reopens a period the
 * way the merchant API will.
 *
 * Every helper goes through the REAL boundary: it mints a real `acctctl/1`
 * control assertion with the real key and executes the command as
 * `daftar_app`, the one runtime role that may. Nothing here mutates
 * `accounting_periods` as the schema owner or as the internal authority,
 * because a test that borrowed a stronger identity would prove nothing about
 * the path production uses.
 */
import { Client } from 'pg';
import { mintAccountingControlAssertion, type AccountingControlAssertionClaims } from '../../packages/accounting/src/control-assertion';
import {
  computePeriodFingerprint,
  derivePeriodId,
  derivePeriodOperationId,
  type AccountingPeriodCommandKind,
  type PeriodCommandFacts,
} from '../../packages/accounting/src/period';
import { accountingAssertionKey, appDbUrl } from './test-app';
import { must } from './accounting-posting';

export interface PeriodScope {
  tenantId: string;
  businessId: string;
  userId: string;
}

export interface PeriodOutcome {
  periodId: string;
  changed: boolean;
}

/** A connection as the one runtime role that may execute the period commands. */
export async function periodClient(): Promise<Client> {
  const client = new Client({ connectionString: appDbUrl });
  await client.connect();
  return client;
}

/** The period id a given business and idempotency key derive. */
export function periodIdFor(businessId: string, idempotencyKey: string): string {
  return derivePeriodId(businessId, idempotencyKey);
}

/** The operation id a given business and idempotency key derive. */
export function operationIdFor(businessId: string, idempotencyKey: string): string {
  return derivePeriodOperationId(businessId, idempotencyKey);
}

/** Mint a control assertion, with optional tampering for the authority matrix. */
export function controlAssertion(claims: AccountingControlAssertionClaims, mintedAt: Date = new Date(), ttlSeconds = 60): string {
  return mintAccountingControlAssertion(accountingAssertionKey(), claims, mintedAt, ttlSeconds);
}

/** The assertion an untampered period command carries. */
export function periodAssertion(facts: PeriodCommandFacts, actorUserId: string): string {
  return controlAssertion({
    actorUserId,
    tenantId: facts.tenantId,
    businessId: facts.businessId,
    commandKind: facts.kind as AccountingPeriodCommandKind,
    resourceId: facts.periodId,
    payloadFingerprint: computePeriodFingerprint(facts),
  });
}

interface RunOptions {
  readonly extraGucs?: Record<string, string>;
  readonly client?: Client;
}

async function runCommand<T>(assertion: string | null, options: RunOptions, body: (conn: Client) => Promise<T>): Promise<T> {
  const own = options.client === undefined;
  const conn = options.client ?? (await periodClient());
  try {
    if (own) await conn.query('BEGIN');
    if (assertion !== null) await conn.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
    for (const [k, v] of Object.entries(options.extraGucs ?? {})) await conn.query(`SELECT set_config($1, $2, true)`, [k, v]);
    const out = await body(conn);
    if (own) await conn.query('COMMIT');
    return out;
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (own) await conn.end().catch(() => undefined);
  }
}

/**
 * Execute `accounting_period_create` as `daftar_app`.
 *
 * `extraGucs` exists for the spoofing cases: a stolen credential would set
 * `app.tenant_id` and friends to whatever it liked, and the point is that
 * doing so changes nothing.
 */
export async function createPeriodAs(
  assertion: string | null,
  command: { operationId: string; startDate: string; endDate: string },
  options: RunOptions = {},
): Promise<PeriodOutcome> {
  return runCommand(assertion, options, async (conn) => {
    const r = await conn.query<{ period_id: string; created: boolean }>(
      `SELECT period_id, created FROM accounting_period_create($1::uuid, $2::date, $3::date, $4)`,
      [command.operationId, command.startDate, command.endDate, 'req-period-test'],
    );
    return { periodId: must(r.rows[0]).period_id, changed: must(r.rows[0]).created };
  });
}

export async function closePeriodAs(assertion: string | null, command: { operationId: string }, options: RunOptions = {}): Promise<PeriodOutcome> {
  return runCommand(assertion, options, async (conn) => {
    const r = await conn.query<{ period_id: string; changed: boolean }>(`SELECT period_id, changed FROM accounting_period_close($1::uuid, $2)`, [
      command.operationId,
      'req-period-test',
    ]);
    return { periodId: must(r.rows[0]).period_id, changed: must(r.rows[0]).changed };
  });
}

export async function reopenPeriodAs(
  assertion: string | null,
  command: { operationId: string; reason: string },
  options: RunOptions = {},
): Promise<PeriodOutcome> {
  return runCommand(assertion, options, async (conn) => {
    const r = await conn.query<{ period_id: string; changed: boolean }>(`SELECT period_id, changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [
      command.operationId,
      command.reason,
      'req-period-test',
    ]);
    return { periodId: must(r.rows[0]).period_id, changed: must(r.rows[0]).changed };
  });
}

/** Create a period with a freshly minted, untampered assertion. */
export async function createPeriod(scope: PeriodScope, idempotencyKey: string, startDate: string, endDate: string): Promise<PeriodOutcome> {
  const periodId = periodIdFor(scope.businessId, idempotencyKey);
  const operationId = operationIdFor(scope.businessId, idempotencyKey);
  const facts: PeriodCommandFacts = {
    kind: 'period_create',
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    operationId,
    periodId,
    startDate,
    endDate,
  };
  return createPeriodAs(periodAssertion(facts, scope.userId), { operationId, startDate, endDate });
}

/** Close a period with a freshly minted, untampered assertion. */
export async function closePeriod(scope: PeriodScope, idempotencyKey: string, periodId: string): Promise<PeriodOutcome> {
  const operationId = operationIdFor(scope.businessId, idempotencyKey);
  const facts: PeriodCommandFacts = {
    kind: 'period_close',
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    operationId,
    periodId,
  };
  return closePeriodAs(periodAssertion(facts, scope.userId), { operationId });
}

/** Reopen a period with a freshly minted, untampered assertion. */
export async function reopenPeriod(scope: PeriodScope, idempotencyKey: string, periodId: string, reason: string): Promise<PeriodOutcome> {
  const operationId = operationIdFor(scope.businessId, idempotencyKey);
  const facts: PeriodCommandFacts = {
    kind: 'period_reopen',
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    operationId,
    periodId,
    reason,
  };
  return reopenPeriodAs(periodAssertion(facts, scope.userId), { operationId, reason });
}

export interface PeriodRow {
  id: string;
  start_date: Date;
  end_date: Date;
  status: string;
  closed_at: Date | null;
  closed_by_user_id: string | null;
  last_reopened_at: Date | null;
  last_reopened_by_user_id: string | null;
  last_reopen_reason: string | null;
}

/** Read one period's stored row, as the owner pool (test observation only). */
export async function readPeriod(pool: import('pg').Pool, businessId: string, periodId: string): Promise<PeriodRow> {
  const r = await pool.query<PeriodRow>(
    `SELECT id, start_date, end_date, status, closed_at, closed_by_user_id, last_reopened_at, last_reopened_by_user_id, last_reopen_reason
       FROM accounting_periods WHERE business_id = $1 AND id = $2`,
    [businessId, periodId],
  );
  return must(r.rows[0], 'period row');
}

/** The error message of a refused period command, or a loud failure if it succeeded. */
export async function periodRefusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('the period command was accepted, but this case requires a refusal');
}
