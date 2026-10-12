import type { Client } from 'pg';

import { applyCreditToInvoice, type CreditApplication } from '../../../src/credit-application';
import type { CreditAdjustment } from '../../../src/credit';
import { uuid } from './cluster';

export interface Scope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly currency: string;
}

interface LedgerRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind: 'grant' | 'consumption';
  readonly amount_minor: string;
  readonly currency: string;
  readonly occurred_at: Date;
  readonly source_ref: string;
  readonly reason: string;
  readonly applies_to_grant_id: string | null;
}

/**
 * Read the ledger exactly as §11 of the patch request specifies it:
 * `ORDER BY created_at, id`, scoped to one business and one currency.
 *
 * `created_at` is the allocation key and it is the DATABASE's value, never
 * the caller's. `occurred_at` cannot disagree with it, because the
 * chronology trigger refuses a row that would make the ledger non-monotonic
 * — which is how the recorded `created_at,id` vs `occurred_at` conflict is
 * resolved without a second ordering formula.
 */
export async function readLedger(c: Client, schema: string, s: Scope): Promise<readonly CreditAdjustment[]> {
  const r = await c.query<LedgerRow>(
    `SELECT id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason, applies_to_grant_id
       FROM ${schema}.platform_credit_adjustments
      WHERE tenant_id = $1 AND business_id = $2 AND currency = $3
      ORDER BY created_at, id`,
    [s.tenantId, s.businessId, s.currency],
  );
  return r.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
    ref: row.source_ref,
    reason: row.reason,
    ...(row.applies_to_grant_id === null ? {} : { appliesToGrantId: row.applies_to_grant_id }),
  }));
}

export async function insertGrant(
  c: Client,
  schema: string,
  s: Scope,
  amountMinor: bigint,
  occurredAt: string,
  ref = 'plan-change',
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO ${schema}.platform_credit_adjustments
       (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
     VALUES ($1,$2,$3,'grant',$4,$5,$6,$7,'negative proration becomes platform credit')`,
    [id, s.tenantId, s.businessId, amountMinor.toString(), s.currency, occurredAt, ref],
  );
  return id;
}

export interface FinalizationPlan {
  readonly application: CreditApplication;
  readonly invoiceId: string;
}

/**
 * One platform invoice finalization, as the integrated command would do it.
 *
 * The caller owns BEGIN and COMMIT, because what is being proved is what
 * happens between two of them in two different sessions. `withLock`
 * switches the one line §11b asks for — `pg_advisory_xact_lock` on the
 * business, the pattern `EntitlementService.acquireQuotaLock` already
 * establishes in this codebase — so the same interleaving can be run with
 * and without it and the difference attributed to that line alone.
 */
export async function finalizeInvoice(
  c: Client,
  schema: string,
  s: Scope,
  invoiceTotalMinor: bigint,
  invoiceRef: string,
  appliedAt: string,
  opts: { readonly withLock: boolean; readonly invoiceId?: string },
): Promise<FinalizationPlan> {
  if (opts.withLock) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}:${s.businessId}`]);
  }
  const ledger = await readLedger(c, schema, s);
  const application = applyCreditToInvoice({
    scope: { businessId: s.businessId, currency: s.currency },
    ledger,
    invoiceTotalMinor,
    invoiceRef,
    appliedAt,
    consumptionIds: Array.from({ length: Math.max(ledger.length, 1) }, () => uuid()),
    reason: 'platform credit applied at invoice finalization',
  });
  const invoiceId = opts.invoiceId ?? uuid();
  for (const row of application.consumptions) {
    await c.query(
      `INSERT INTO ${schema}.platform_credit_adjustments
         (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
          applies_to_grant_id, invoice_id)
       VALUES ($1,$2,$3,'consumption',$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.id,
        s.tenantId,
        s.businessId,
        row.amountMinor.toString(),
        row.currency,
        row.occurredAt,
        row.ref,
        row.reason,
        row.appliesToGrantId ?? null,
        invoiceId,
      ],
    );
  }
  return { application, invoiceId };
}

export async function consumedMinor(c: Client, schema: string, s: Scope): Promise<bigint> {
  const r = await c.query<{ total: string | null }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS total
       FROM ${schema}.platform_credit_adjustments
      WHERE tenant_id = $1 AND business_id = $2 AND currency = $3 AND kind = 'consumption'`,
    [s.tenantId, s.businessId, s.currency],
  );
  return BigInt(r.rows[0]?.total ?? '0');
}

export async function remainderOf(c: Client, grantId: string): Promise<bigint | null> {
  const r = await c.query<{ remaining_minor: string }>(
    `SELECT remaining_minor::text AS remaining_minor
       FROM p5scratch.platform_credit_grant_remainders WHERE grant_id = $1`,
    [grantId],
  );
  const row = r.rows[0];
  return row === undefined ? null : BigInt(row.remaining_minor);
}

/**
 * One consumption row, written directly.
 *
 * Used only where a case must drive the two sessions ROW BY ROW — the
 * deadlock case, which has to interleave two writes against two grants in
 * opposite orders and cannot do that through a function that writes a whole
 * allocation in one go.
 */
export async function insertConsumption(
  c: Client,
  schema: string,
  s: Scope,
  grantId: string,
  amountMinor: bigint,
  invoiceId: string,
  ref: string,
  occurredAt: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ${schema}.platform_credit_adjustments
       (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
        applies_to_grant_id, invoice_id)
     VALUES ($1,$2,$3,'consumption',$4,$5,$6,$7,'row-by-row allocation',$8,$9)`,
    [uuid(), s.tenantId, s.businessId, amountMinor.toString(), s.currency, occurredAt, ref, grantId, invoiceId],
  );
}
