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

/**
 * A tenant and a business, as the FROZEN tables define them.
 *
 * ROUND 11, the challenger's §5 cross-check: the fixture `businesses` used
 * to be two columns, and the live table has four NOT NULL columns with no
 * default plus a reference to `tenants`. A two-column INSERT that worked
 * against the stub would have failed against the real table, which is a
 * gap that would have been discovered at promotion. Every case now creates
 * its business through this helper, so there is one place where the shape
 * of the real relation is satisfied.
 *
 * `baseCurrency` is a real column of the real table and it REFERENCES the
 * canonical `currencies`. It defaults to the scope's own currency here;
 * whether a platform invoice may be issued in a currency other than the
 * business's base currency is an OWNER question
 * (`P5-MIGRATION-PATCH-REQUEST.md` §13), not something a fixture decides.
 */
export async function createBusiness(c: Client, schema: string, tenantId: string, businessId: string, baseCurrency = 'USD'): Promise<void> {
  // ROUND 12: the column list is DISCOVERED, not written down, because this
  // same helper now creates a business in the FIXTURE copy and in the REAL
  // `businesses`, and the real one has thirteen columns to the fixture's
  // six. Writing the real list here would make the fixture lane fail;
  // writing the fixture list here is what made the real-schema lane fail
  // with `invalid IANA timezone: <NULL>` the first time it ran — the
  // frozen table carries a `timezone` NOT NULL and a trigger that
  // validates it against `pg_timezone_names`, which no fixture had.
  const columns = await c.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'businesses'`,
    [schema],
  );
  const have = new Set(columns.rows.map((row) => row.column_name));
  if (have.size === 0) throw new Error(`no ${schema}.businesses to create a business in`);

  // `PS` and `Asia/Hebron` are the frozen `country_registry` row for
  // Palestine, so the country FK and the timezone trigger are both
  // satisfied by data the project itself seeds.
  const supply: ReadonlyArray<readonly [string, unknown]> = [
    ['tenant_id', tenantId],
    ['id', businessId],
    ['name', `fixture ${businessId}`],
    ['store_slug', `b-${businessId}`],
    ['country_code', 'PS'],
    ['base_currency', baseCurrency],
    ['timezone', 'Asia/Hebron'],
  ];
  const used = supply.filter(([column]) => have.has(column));
  const names = used.map(([column]) => column).join(', ');
  const holes = used.map((_, i) => `$${i + 1}`).join(', ');

  if (have.has('tenant_id')) {
    // The real `tenants` table may carry columns of its own; the same
    // discovery applies, and anything NOT NULL without a default that this
    // helper cannot supply is a finding, not something to guess at.
    await c.query(`INSERT INTO ${schema}.tenants (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);
  }
  await c.query(
    `INSERT INTO ${schema}.businesses (${names}) VALUES (${holes})`,
    used.map(([, value]) => value),
  );
}

export async function insertGrant(c: Client, schema: string, s: Scope, amountMinor: bigint, occurredAt: string, ref = 'plan-change'): Promise<string> {
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
 * A draft platform invoice, in its own statement.
 *
 * Round 4's helper wrote no invoice at all — it wrote consumption rows
 * naming an invoice that did not exist, and nothing noticed, because
 * nothing tied the two. That is exactly the gap V2 names ("this does not
 * prove the real `subscription_invoices` finalization is tied to the grant
 * and the consumption in the same transaction"), and adding
 * `pca_invoice_fk` to the DDL made eight of round 4's twenty cases fail
 * immediately. They were right to fail.
 *
 * A draft carries no credit: `credit_minor` is 0 and
 * `total_minor` is the whole total, and the deferred agreement trigger
 * checks that rather than assuming it.
 */
export async function createDraftInvoice(c: Client, schema: string, s: Scope, totalMinor: bigint, periodIndex?: number): Promise<string> {
  const id = uuid();
  // `charge_minor` and `total_minor` are the same figure on a draft, and
  // `credit_minor` is 0: a draft claims no credit, and the deferred
  // agreement trigger checks that rather than assuming it. The period is
  // the fixture sequence unless the case is itself about the period.
  await c.query(
    `INSERT INTO ${schema}.subscription_invoices
       (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
     VALUES ($1,$2,$3,coalesce($6::integer, nextval('${schema}.scratch_period_seq')::integer),$4,$5,0,$5,'draft')`,
    [id, s.tenantId, s.businessId, s.currency, totalMinor.toString(), periodIndex ?? null],
  );
  return id;
}

/**
 * One platform invoice finalization, as the integrated command would do it.
 *
 * The caller owns BEGIN and COMMIT, because what is being proved is what
 * happens between two of them in two different sessions. Everything inside
 * is one transaction: the lock, the read, the allocation, the invoice
 * UPDATE and the consumption INSERTs.
 *
 * Two switches, so the same interleaving can be run with and without each
 * and the difference attributed to that one line:
 *
 *   `withLock`       — `pg_advisory_xact_lock` on the business, the pattern
 *                      `EntitlementService.acquireQuotaLock` already
 *                      establishes in this codebase. §11b asks for it.
 *   `withGrantLocks` — the DETERMINISTIC GRANT LOCK ORDER V2 asks for:
 *                      every remainder row for this business and currency
 *                      locked up front in `(created_at, id)` order. It is
 *                      the second line, for a path that forgets the first.
 */
export async function finalizeInvoice(
  c: Client,
  schema: string,
  s: Scope,
  invoiceId: string,
  invoiceTotalMinor: bigint,
  invoiceRef: string,
  appliedAt: string,
  opts: { readonly withLock: boolean; readonly withGrantLocks?: boolean },
): Promise<FinalizationPlan> {
  if (opts.withLock) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}:${s.businessId}`]);
  }
  if (opts.withGrantLocks === true) {
    await c.query(`SELECT ${schema}.lock_grants_in_order($1, $2, $3)`, [s.tenantId, s.businessId, s.currency]);
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

  // The invoice figures and the ledger rows, in this order, in this
  // transaction. The order does not matter to the database — the
  // agreement trigger is DEFERRED and the FK from a consumption to its
  // invoice is too — and the test that writes them the other way round
  // proves that.
  await c.query(
    `UPDATE ${schema}.subscription_invoices
        SET state = 'open', issued_at = $2,
            credit_minor = $3, total_minor = $4
      WHERE id = $1`,
    [invoiceId, appliedAt, application.appliedMinor.toString(), application.payableMinor.toString()],
  );
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
