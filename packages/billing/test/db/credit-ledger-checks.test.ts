/**
 * ROUND 10 — one case per CHECK constraint, each naming the defence it
 * provokes.
 *
 * The independent challenger's F-11 (P2) measured that 19 of the 25 CHECK
 * constraints in `p5scratch` were unobserved: dropping any one of them left
 * the DB lane green, so the lane could not have told a reader which of them
 * the schema actually enforces. It also measured a masking PAIR —
 * `si_credit_within_charge` and `si_total_non_negative` — where dropping
 * either alone left 77 cases passing and only dropping BOTH reddened one.
 *
 * Two things were wrong, and they are separate. The first is coverage: a
 * constraint no case provokes is a line of DDL with no witness. The second
 * is resolution: a case that asserts the bare SQLSTATE cannot distinguish
 * the constraint it meant from the five others that raise the same class
 * (23514 comes from six constraints here, 23503 from four, 23505 from four,
 * and 23000 from fifteen RAISE sites). Both are closed the same way: every
 * refusal in `test/db/**` is now asserted by NAME, through `refusedBy`, and
 * this file adds the missing provocations.
 *
 * Each case below is built so that exactly one CHECK is violated and every
 * other constraint on the row holds — which is what makes the assertion a
 * witness for that constraint and nothing else: drop it alone and the
 * received value changes, so the case reds.
 *
 * ONE constraint resists that construction and is recorded rather than
 * faked: `si_total_non_negative` cannot be reached alone. `tax_minor` is a
 * structural zero and `si_total_is_charge_minus_credit` makes `total_minor`
 * a function of the other two, so a negative total needs `credit_minor >
 * charge_minor`, which `si_credit_within_charge` refuses first. The case
 * below asserts that masking by name, and the red proof M39 shows that the
 * masked constraint is not dead: with `si_credit_within_charge` dropped on a
 * SCRATCH COPY of the DDL, the same row is refused by
 * `si_total_non_negative`. `test/db-refusals-name-their-defence.test.ts`
 * carries the exemption and this reason, so the gate cannot be satisfied by
 * silence.
 *
 * Class: `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, ownerUrl, refusedBy, uuid } from './helpers/cluster';
import { createBusiness, insertGrant, type Scope } from './helpers/finalize';

const TENANT = '7f1a0000-0000-4000-8000-000000000006';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

let owner: Client;

/** A business, an invoice and a grant to hang the violations on. */
interface Ground {
  readonly scope: Scope;
  readonly invoiceId: string;
  readonly grantId: string;
}

async function ground(): Promise<Ground> {
  const businessId = uuid();
  await createBusiness(owner, 'p5scratch', TENANT, businessId, 'USD');
  const scope: Scope = { tenantId: TENANT, businessId, currency: 'USD' };
  const invoiceId = uuid();
  await owner.query(
    `INSERT INTO p5scratch.subscription_invoices
       (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
     VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,0,1000,'draft')`,
    [invoiceId, TENANT, businessId],
  );
  const grantId = await insertGrant(owner, 'p5scratch', scope, 500n, T1, 'checks-ground');
  return { scope, invoiceId, grantId };
}

/** Run one statement and report the defence that refused it, by name. */
async function refusal(sql: string, params: readonly unknown[]): Promise<string> {
  return owner.query(sql, params as unknown[]).then(
    () => '',
    (e: unknown) => refusedBy(e),
  );
}

/** A draft invoice in one currency, for the canonical-currency cases. */
async function insertInvoiceIn(g: Ground, currency: string): Promise<string> {
  return refusal(
    `INSERT INTO p5scratch.subscription_invoices
       (id,tenant_id,business_id,period_index,currency,charge_minor,credit_minor,total_minor,state)
     VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,$4,100,0,100,'draft')`,
    [uuid(), g.scope.tenantId, g.scope.businessId, currency],
  );
}

beforeAll(async () => {
  owner = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
});

describe('the ledger CHECKs, each provoked on its own', () => {
  it('refuses a grant of zero', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason)
         VALUES ($1,$2,$3,'grant',0,'USD',$4,'checks','a grant of nothing')`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2],
      ),
    ).toBe('23514/pca_amount_positive');
  });

  it('refuses a grant that names an invoice, and a consumption that names none', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason,invoice_id)
         VALUES ($1,$2,$3,'grant',100,'USD',$4,'checks','a grant naming an invoice',$5)`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2, g.invoiceId],
      ),
      'a grant was allowed to name an invoice',
    ).toBe('23514/pca_consumption_invoice');
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason,applies_to_grant_id)
         VALUES ($1,$2,$3,'consumption',100,'USD',$4,'checks','a consumption naming no invoice',$5)`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2, g.grantId],
      ),
      'a consumption was allowed to name no invoice',
    ).toBe('23514/pca_consumption_invoice');
  });

  it('refuses a currency that is not three upper-case letters, on the ledger', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason)
         VALUES ($1,$2,$3,'grant',100,'usd',$4,'checks','a lower-case currency')`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2],
      ),
    ).toBe('23514/pca_currency_shape');
  });

  it('refuses a kind outside the two the ledger knows', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason)
         VALUES ($1,$2,$3,'refund',100,'USD',$4,'checks','a third kind')`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2],
      ),
    ).toBe('23514/pca_kind_known');
  });

  it('refuses a grant that applies to a grant, and a consumption that applies to nothing', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason,applies_to_grant_id)
         VALUES ($1,$2,$3,'grant',100,'USD',$4,'checks','a grant applying to a grant',$5)`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2, g.grantId],
      ),
      'a grant was allowed to apply to a grant',
    ).toBe('23514/pca_kind_names_grant');
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason,invoice_id)
         VALUES ($1,$2,$3,'consumption',100,'USD',$4,'checks','a consumption spending no grant',$5)`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2, g.invoiceId],
      ),
      'a consumption was allowed to spend no grant',
    ).toBe('23514/pca_kind_names_grant');
  });

  it('refuses a ledger row with no reason', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason)
         VALUES ($1,$2,$3,'grant',100,'USD',$4,'checks','')`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2],
      ),
    ).toBe('23514/pca_reason_present');
  });
});

describe('the remainder CHECKs, each provoked on its own', () => {
  it('refuses a remainder that summarises a grant of nothing', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_grant_remainders
           (tenant_id,business_id,currency,grant_id,granted_minor,remaining_minor)
         VALUES ($1,$2,'USD',$3,0,0)`,
        [g.scope.tenantId, g.scope.businessId, uuid()],
      ),
    ).toBe('23514/pcgr_granted_positive');
  });

  it('refuses a remainder that claims to summarise a consumption', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_grant_remainders
           (tenant_id,business_id,currency,grant_id,grant_kind,granted_minor,remaining_minor)
         VALUES ($1,$2,'USD',$3,'consumption',100,50)`,
        [g.scope.tenantId, g.scope.businessId, uuid()],
      ),
    ).toBe('23514/pcgr_kind_is_grant');
  });
});

describe('the attempt CHECKs, each provoked on its own', () => {
  const attempt = (overrides: {
    readonly attemptNo?: number;
    readonly key?: string;
    readonly amountMinor?: number;
    readonly outcome?: string;
  }) => overrides;

  async function insertAttempt(g: Ground, o: ReturnType<typeof attempt>): Promise<string> {
    const attemptNo = o.attemptNo ?? 1;
    return refusal(
      `INSERT INTO p5scratch.subscription_charge_attempts
         (id,tenant_id,business_id,invoice_id,attempt_no,idempotency_key,amount_minor,currency,
          outcome,provider,provider_ref,provider_code,attempted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,'checks','ref','card_declined',$9)`,
      [
        uuid(),
        g.scope.tenantId,
        g.scope.businessId,
        g.invoiceId,
        attemptNo,
        o.key ?? `checks:${g.invoiceId}:${attemptNo}`,
        o.amountMinor ?? 100,
        o.outcome ?? 'failed',
        T2,
      ],
    );
  }

  it('refuses an attempt for nothing', async () => {
    const g = await ground();
    expect(await insertAttempt(g, attempt({ amountMinor: 0 }))).toBe('23514/sca_amount_positive');
  });

  it('refuses an attempt numbered below one', async () => {
    const g = await ground();
    expect(await insertAttempt(g, attempt({ attemptNo: 0 }))).toBe('23514/sca_attempt_no_valid');
  });

  it('refuses a key too short to be an idempotency key', async () => {
    const g = await ground();
    // `:1` violates the naming CHECK as well, and PostgreSQL reports the
    // length one; the assertion records WHICH refused rather than claiming
    // both. That is the point of naming: with `sca_key_long_enough`
    // dropped, this case does not go green, it changes answer to
    // `sca_key_names_attempt` and reds.
    expect(await insertAttempt(g, attempt({ key: ':1' }))).toBe('23514/sca_key_long_enough');
  });

  it('refuses an outcome outside the four the provider seam knows', async () => {
    const g = await ground();
    expect(await insertAttempt(g, attempt({ outcome: 'abandoned' }))).toBe('23514/sca_outcome_known');
  });
});

describe('the invoice CHECKs, each provoked on its own', () => {
  async function insertInvoice(
    g: Ground,
    row: {
      readonly periodIndex?: number;
      readonly currency?: string;
      readonly chargeMinor?: number;
      readonly creditMinor?: number;
      readonly totalMinor?: number;
      readonly state?: string;
      readonly issuedAt?: string | null;
    },
  ): Promise<string> {
    return refusal(
      `INSERT INTO p5scratch.subscription_invoices
         (id,tenant_id,business_id,period_index,currency,charge_minor,credit_minor,total_minor,state,issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uuid(),
        g.scope.tenantId,
        g.scope.businessId,
        row.periodIndex ?? 9100,
        row.currency ?? 'USD',
        row.chargeMinor ?? 100,
        row.creditMinor ?? 0,
        row.totalMinor ?? 100,
        row.state ?? 'draft',
        row.issuedAt ?? null,
      ],
    );
  }

  it('refuses a negative charge', async () => {
    const g = await ground();
    expect(await insertInvoice(g, { chargeMinor: -1, creditMinor: 0, totalMinor: -1 })).toBe(
      '23514/si_charge_non_negative',
    );
  });

  it('refuses a negative credit', async () => {
    const g = await ground();
    expect(await insertInvoice(g, { chargeMinor: 100, creditMinor: -1, totalMinor: 101 })).toBe(
      '23514/si_credit_non_negative',
    );
  });

  it('refuses a currency that is not three upper-case letters, on the invoice', async () => {
    const g = await ground();
    expect(await insertInvoice(g, { currency: 'usd' })).toBe('23514/si_currency_shape');
  });

  it('refuses a draft that already carries an instant', async () => {
    const g = await ground();
    expect(await insertInvoice(g, { state: 'draft', issuedAt: T1 })).toBe('23514/si_issued_when_not_draft');
  });

  it('refuses a negative period index', async () => {
    const g = await ground();
    expect(await insertInvoice(g, { periodIndex: -1 })).toBe('23514/si_period_index_valid');
  });

  it('records that a negative total is refused by the credit bound, not by the total bound', async () => {
    const g = await ground();
    // The masking pair, measured rather than asserted away. A negative
    // total is only representable with `credit_minor > charge_minor`,
    // because `tax_minor` is a structural zero and
    // `si_total_is_charge_minus_credit` makes the total a function of the
    // other two. So `si_credit_within_charge` answers first and
    // `si_total_non_negative` is unreachable from the application's side.
    //
    // This case is the witness for the MASKING, which is what the lane can
    // actually observe; the red proof M39 is the witness for the masked
    // constraint itself, on a scratch copy with the bound dropped.
    expect(await insertInvoice(g, { chargeMinor: 0, creditMinor: 1, totalMinor: -1 })).toBe(
      '23514/si_credit_within_charge',
    );
  });
});

describe('the canonical currency set is a key, not a shape', () => {
  it('refuses an invoice in a code that passes the shape and names no currency', async () => {
    const g = await ground();
    // `ZZZ` is three upper-case letters. It is not a currency.
    expect(await insertInvoiceIn(g, 'ZZZ')).toBe('23503/si_currency_fk');
  });

  it('refuses a ledger row in a code that passes the shape and names no currency', async () => {
    const g = await ground();
    expect(
      await refusal(
        `INSERT INTO p5scratch.platform_credit_adjustments
           (id,tenant_id,business_id,kind,amount_minor,currency,occurred_at,source_ref,reason)
         VALUES ($1,$2,$3,'grant',100,'ZZZ',$4,'checks','a grant in no currency')`,
        [uuid(), g.scope.tenantId, g.scope.businessId, T2],
      ),
    ).toBe('23503/pca_currency_fk');
  });

  it('carries the precision of each currency, including the one that is not two', async () => {
    // The reason the package stores integer minor units and never a
    // decimal: JOD has three. A `/ 100` anywhere would be wrong for it,
    // and `test/currency-is-canonical.test.ts` scans `src/` for exactly
    // that. Here the fact is read from the table, where it belongs.
    const r = await owner.query<{ code: string; minor_units: number }>(
      `SELECT code, minor_units FROM p5scratch.currencies ORDER BY code`,
    );
    expect(r.rows.length, 'the canonical currency fixture is empty').toBe(7);
    expect(r.rows.filter((row) => row.minor_units !== 2).map((row) => `${row.code}=${row.minor_units}`)).toStrictEqual([
      'JOD=3',
    ]);
  });
});

describe('the subscription state machine is not this slice to move', () => {
  it('gives the application role no write of any kind on the entitlement record', async () => {
    const r = await owner.query<{ privilege: string; held: boolean }>(
      `SELECT p AS privilege, has_table_privilege('p5_app', 'p5scratch.business_entitlements', p) AS held
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`,
    );
    expect(r.rows.length, 'the privilege probe returned nothing').toBe(4);
    expect(r.rows.filter((row) => row.held).map((row) => row.privilege)).toStrictEqual([]);
  });

  it('has no function or trigger in this schema that touches it', async () => {
    // A grant is not the only way to write a row: a SECURITY DEFINER
    // function would do it on the caller's behalf. So the catalogue is
    // asked about both.
    const fns = await owner.query<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'p5scratch' AND p.prosrc ILIKE '%business_entitlements%'`,
    );
    expect(fns.rows.map((row) => row.proname)).toStrictEqual([]);
    const trgs = await owner.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'p5scratch' AND c.relname = 'business_entitlements' AND NOT t.tgisinternal`,
    );
    expect(trgs.rows.map((row) => row.tgname)).toStrictEqual([]);
    // And the probe is not vacuous: the same question about a relation this
    // schema DOES maintain finds its maintainer.
    const live = await owner.query<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'p5scratch' AND p.prosrc ILIKE '%platform_credit_grant_remainders%'`,
    );
    expect(live.rows.length, 'the catalogue probe finds nothing even where it should').toBeGreaterThan(0);
  });
});
