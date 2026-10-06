/**
 * P4-S4 — THE READ POLICIES' ROW-INVARIANT PARTS, EVALUATED ONCE PER QUERY,
 * ANSWER FOR ANSWER THE SAME POLICY.
 * (`0086_phase4_rls_quals_once_per_query.sql`; P4-AL-72's growth rule; §91's
 *  refusal of a disabled or unforced policy surface.)
 *
 * `0086` rewrote the row-invariant subexpressions of `tenant_membership` and
 * `business_isolation_read` on `invoices`, `sales`, `payment_allocations` and
 * `customer_credit_applications` as scalar subselects, so the executor
 * evaluates them once per query as an `InitPlan` instead of once per row. It
 * was done for a measured reason — 51.3 % of the fat-tail receivable read's
 * marginal cost was policy evaluation — and a performance change to a
 * SECURITY surface is exactly the change that has to prove it moved no
 * answer and admitted no row.
 *
 * The argument for why it cannot is short: `app_bypass()`, `CURRENT_USER` and
 * the two GUCs cannot change in the middle of a statement, so once per query
 * and once per row are the same value by construction. This file does not
 * rest on that argument. It captures every reader's answers under BOTH
 * policy shapes on the same rows in the same session and compares them, and
 * it proves default-deny from the outside rather than from the shape of the
 * expression.
 *
 * HOW BOTH SHAPES ARE REACHED. `ALTER POLICY` is transactional in
 * PostgreSQL, so the per-row form is restored inside a transaction that is
 * always rolled back. Nothing is left altered, and no second database is
 * needed for the comparison — which matters, because a comparison across two
 * databases would be a comparison of two datasets.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { urlOf } from '../helpers/scratch-db';
import { randomUUID } from 'node:crypto';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { applyCredit, collectPayment, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';

/** The four relations `0086` names, and the two quals it rewrites on each. */
const RELATIONS = ['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] as const;
const REWRITTEN = ['tenant_membership', 'business_isolation_read'] as const;

/** The per-row form, exactly as 0075/0077/0081 created it. */
const PER_ROW = {
  tenant_membership: `(app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
  business_isolation_read: `(app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
     OR business_id = nullif(app_business(), '')::uuid)`,
} as const;

/** The once-per-query form, exactly as `0086` wrote it. */
const ONCE_PER_QUERY = {
  tenant_membership: `((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid))`,
  business_isolation_read: `((SELECT app_bypass())
     OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
     OR business_id = (SELECT nullif(app_business(), '')::uuid))`,
} as const;

let w: SettlementWorld;
const customers: string[] = [];
const invoices: string[] = [];

/** One connection as `role`, scoped the way `Database.applyScope` scopes one. */
async function connectAs(role: 'daftar_app' | 'daftar_migrator', scope: { tenantId?: string; businessId?: string } = {}): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', role) });
  await c.connect();
  if (scope.tenantId !== undefined) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId]);
  if (scope.businessId !== undefined) await c.query(`SELECT set_config('app.business_id', $1, false)`, [scope.businessId]);
  return c;
}

/**
 * Every answer the five readers give, for EVERY customer and EVERY invoice
 * the connection can see, as one ordered array of strings. Derived from the
 * data rather than from a written-out subject list, so a reader that starts
 * hiding a row changes the capture.
 */
async function captureAnswers(c: Client, businessId: string): Promise<string[]> {
  const out: string[] = [];
  const cs = await c.query<{ id: string }>(`SELECT DISTINCT customer_id AS id FROM invoices WHERE customer_id IS NOT NULL ORDER BY 1`);
  for (const { id } of cs.rows) {
    const ar = await c.query(`SELECT currency_code, txn_minor::text, base_minor::text FROM customer_ar_outstanding($1::uuid, $2::uuid) ORDER BY 1`, [
      businessId,
      id,
    ]);
    out.push(`ar ${id} ${JSON.stringify(ar.rows)}`);
    const aging = await c.query(
      `SELECT bucket_no, currency_code, txn_minor::text, base_minor::text, invoice_count FROM customer_ar_aging($1::uuid, $2::uuid, CURRENT_DATE, ARRAY[30,60,90]) ORDER BY 1, 2`,
      [businessId, id],
    );
    out.push(`aging ${id} ${JSON.stringify(aging.rows)}`);
    const page = await c.query(
      `SELECT invoice_id::text, issue_date::text, currency_code FROM customer_open_invoices_page($1::uuid, $2::uuid, NULL, NULL, 50) ORDER BY 1`,
      [businessId, id],
    );
    out.push(`page ${id} ${JSON.stringify(page.rows)}`);
  }
  const inv = await c.query<{ id: string }>(`SELECT id FROM invoices ORDER BY 1`);
  for (const { id } of inv.rows) {
    const one = await c.query(`SELECT outstanding_txn_minor::text, outstanding_base_minor::text FROM invoice_outstanding($1::uuid, $2::uuid) ORDER BY 1`, [
      businessId,
      id,
    ]);
    out.push(`out ${id} ${JSON.stringify(one.rows)}`);
    const st = await c.query(`SELECT invoice_settlement_state($1::uuid, $2::uuid) AS state`, [businessId, id]);
    out.push(`state ${id} ${JSON.stringify(st.rows)}`);
  }
  // And the SET form over every id at once, which is the one definition.
  const all = await c.query(
    `SELECT invoice_id::text, outstanding_txn_minor::text FROM invoice_outstanding($1::uuid, (SELECT array_agg(id) FROM invoices)::uuid[]) ORDER BY 1`,
    [businessId],
  );
  out.push(`set ${JSON.stringify(all.rows)}`);
  return out;
}

/**
 * Put all eight read quals into `shape` on all four relations.
 *
 * ALTER POLICY needs the table's OWNER, and the owner here is a superuser
 * that bypasses row security altogether — so the role that changes the shape
 * can never be the role that reads under it, and the comparison cannot be
 * done inside one transaction. It is therefore committed and put back in a
 * `finally`, and the last assertion of each case reads the shipped shape back
 * out of the catalogue so a half-finished case cannot be mistaken for a pass.
 */
async function setShape(shape: 'per-row' | 'once-per-query'): Promise<void> {
  const o = new Client({ connectionString: urlOf('daftar', 'postgres') });
  await o.connect();
  try {
    for (const rel of RELATIONS) {
      for (const pol of REWRITTEN) await o.query(`ALTER POLICY ${pol} ON ${rel} USING ${shape === 'per-row' ? PER_ROW[pol] : ONCE_PER_QUERY[pol]}`);
    }
  } finally {
    await o.end();
  }
}

/** Every read qual carries the subselect form, read back from the catalogue. */
async function shippedShapeIsBack(): Promise<void> {
  const r = await ownerPool().query<{ relname: string; polname: string; q: string | null }>(
    `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND p.polname = ANY ($2::text[]) ORDER BY 1, 2`,
    [[...RELATIONS], [...REWRITTEN]],
  );
  expect(r.rows.length).toBe(RELATIONS.length * REWRITTEN.length);
  for (const row of r.rows) expect(row.q ?? '', `${row.relname}.${row.polname} was left in the per-row form by this file`).toContain('( SELECT');
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('p4s4rlsq');
  const missing = await settlementMissing(w);
  if (missing.length > 0) throw new Error(`the settlement surface is incomplete, so this file would prove nothing: ${missing.join(', ')}`);
  await stockUp(w, '400', '5');
  // Two customers, three credit invoices each, and ONE payment that both
  // allocates and leaves a surplus — so `invoice_outstanding`'s payment arm
  // carries rows, a `customer_credit` exists, and the page reader has a
  // settled invoice and open ones to tell apart. An equality over a dataset
  // where one arm is empty would be an equality about the empty arm.
  for (let i = 0; i < 2; i += 1) {
    const customerId = await newCustomer(w);
    customers.push(customerId);
    const opened = [await sellOnCredit(w, customerId, '2'), await sellOnCredit(w, customerId, '3'), await sellOnCredit(w, customerId, '4')];
    invoices.push(...opened.map((o) => o.invoiceId));
    const first = opened[0];
    if (first === undefined) throw new Error('the fixture sold nothing');
    const legs: AllocationInput[] = [
      {
        invoiceId: first.invoiceId,
        appliedMinor: first.totalTxnMinor,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: first.totalTxnMinor,
        invoiceTotalBaseMinor: first.totalBaseMinor,
      },
    ];
    const creditId = randomUUID();
    const res = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      creditId,
      amountMinor: (BigInt(first.totalTxnMinor) + 50n).toString(),
      allocations: legs,
    });
    expect(res.status, `the collection commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);

    // AND THE SURPLUS CREDIT IS APPLIED, so `customer_credit_applications`
    // CARRIES ROWS. It is one of the four relations `0086` rewrote, and the
    // visibility proof over it is only worth anything if it has something to
    // be visible: an equality over an empty relation is an equality about
    // nothing. The non-vacuity guard in that case caught exactly this — the
    // relation was globally empty on the first run of it — and seeding the
    // row is the fix, not relaxing the guard.
    const second = opened[1];
    if (second === undefined) throw new Error('the fixture sold no second invoice to apply the credit to');
    const cr = (
      await ownerPool().query<{ oa: string; ob: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
           FROM customer_credits WHERE business_id = $1 AND id = $2`,
        [w.shop.businessId, creditId],
      )
    ).rows[0];
    if (cr === undefined) throw new Error(`the surplus credit ${creditId} was not created, so the credit arm would be empty`);
    const applied = await applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId,
      invoiceId: second.invoiceId,
      applicationDate: w.day,
      consumedMinor: '1',
      remainingBeforeMinor: cr.oa,
      creditOriginalMinor: cr.oa,
      creditOriginalCarryingMinor: cr.ob,
      leg: {
        invoiceId: second.invoiceId,
        appliedMinor: '1',
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: second.totalTxnMinor,
        invoiceTotalBaseMinor: second.totalBaseMinor,
      },
    });
    expect(applied.status, `the credit application commits: ${JSON.stringify(applied.body)}`).toBeLessThan(300);
  }
}, 900_000);

afterAll(async () => {
  await resetData();
});

describe('P4-S4 — 0086: the read quals are evaluated once per query and answer identically', () => {
  it('every reader gives byte-identical answers under both policy shapes, on the same rows', async () => {
    const c = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
    try {
      const asShipped = await captureAnswers(c, w.shop.businessId);
      expect(asShipped.length, 'the capture found no subject, so an equality between two empty captures would prove nothing').toBeGreaterThan(10);
      let perRow: string[];
      try {
        await setShape('per-row');
        perRow = await captureAnswers(c, w.shop.businessId);
      } finally {
        await setShape('once-per-query');
      }
      expect(perRow).toEqual(asShipped);
      await shippedShapeIsBack();
    } finally {
      await c.end();
    }
  }, 300_000);

  it('RED PROOF: under the per-row form the shape assertion 0086-E(1) makes would FAIL, so that assertion is not vacuous', async () => {
    try {
      await setShape('per-row');
      const r = await ownerPool().query<{ relname: string; polname: string; q: string | null }>(
        `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND p.polname = ANY ($2::text[]) ORDER BY 1, 2`,
        [[...RELATIONS], [...REWRITTEN]],
      );
      expect(r.rows.length).toBe(RELATIONS.length * REWRITTEN.length);
      for (const row of r.rows)
        expect(row.q ?? '', `${row.relname}.${row.polname} reverted, so the subselect must be absent — else 0086-E(1) can never go red`).not.toContain(
          '( SELECT',
        );
    } finally {
      await setShape('once-per-query');
    }
    await shippedShapeIsBack();
  }, 120_000);

  it('DEFAULT-DENY holds from the outside: no scope sees nothing, and another business’s scope sees nothing of this one', async () => {
    const bare = await connectAs('daftar_app');
    try {
      expect((await bare.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n, 'an unscoped connection sees invoices').toBe('0');
      expect((await bare.query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_allocations`)).rows[0]?.n).toBe('0');
    } finally {
      await bare.end();
    }
    const elsewhere = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: '00000000-0000-0000-0000-000000000001' });
    try {
      expect(
        (await elsewhere.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n,
        'a foreign business scope sees this business’s invoices',
      ).toBe('0');
    } finally {
      await elsewhere.end();
    }
  }, 120_000);

  it('CROSS-TENANT denial holds on all four relations, under BOTH shapes', async () => {
    // `tenant_membership` is the qual `0086` rewrote, and the case above
    // proves the BUSINESS boundary, not the TENANT one. They are different
    // policies over different columns: a foreign tenant carrying this
    // business's own `business_id` would satisfy `business_isolation_read`
    // outright, so `tenant_membership` is the only thing standing between it
    // and every row. That makes it exactly the boundary a rewrite of
    // `tenant_membership` has to be shown not to have moved.
    const foreignTenant = randomUUID();
    for (const shape of ['once-per-query', 'per-row'] as const) {
      try {
        if (shape === 'per-row') await setShape('per-row');
        const c = await connectAs('daftar_app', { tenantId: foreignTenant, businessId: w.shop.businessId });
        try {
          for (const rel of RELATIONS) {
            const n = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${rel}`)).rows[0]?.n;
            expect(n, `[${shape}] a FOREIGN TENANT carrying this business's own business_id reads ${rel}`).toBe('0');
          }
        } finally {
          await c.end();
        }
      } finally {
        await setShape('once-per-query');
      }
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('NO ROW BECAME VISIBLE: the exact visible row SET of each relation is identical under both shapes', async () => {
    // The obligation the equivalence case above does not quite discharge. It
    // compares the READERS' answers; this compares the RELATIONS themselves,
    // and it compares the row identities rather than a count, because two
    // equal counts can still be two different sets — one row newly admitted
    // and one newly hidden would cancel out perfectly in a `count(*)`.
    const digests = async (c: Client): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const rel of RELATIONS) {
        const r = await c.query<{ d: string | null; n: string }>(
          `SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS d, count(*)::text AS n FROM ${rel}`,
        );
        out[rel] = `${r.rows[0]?.n ?? '?'}:${r.rows[0]?.d ?? '?'}`;
      }
      return out;
    };
    const c = await connectAs('daftar_app', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
    try {
      const shipped = await digests(c);
      for (const rel of RELATIONS)
        expect(Number((shipped[rel] ?? '0:').split(':')[0]), `${rel} is empty, so an equality over it would be vacuous`).toBeGreaterThan(0);
      let perRow: Record<string, string> = {};
      try {
        await setShape('per-row');
        perRow = await digests(c);
      } finally {
        await setShape('once-per-query');
      }
      expect(perRow, 'the visible row set of at least one relation differs between the per-row and once-per-query policy shapes').toEqual(shipped);
    } finally {
      await c.end();
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('the POLICY ROLE restrictions and the PUBLIC surface are untouched on all four relations', async () => {
    // Obligations 8, 10 and 11, and an honest note on what each can mean
    // here: a GRANT is not a function of policy shape, so asserting that
    // privileges are equal "under both shapes" would be vacuous by
    // construction. What is NOT vacuous is the absolute state — PUBLIC holds
    // nothing, and the two internal read policies are still restricted TO a
    // role rather than having become a PUBLIC `USING (true)`, which is the
    // one way an `ALTER POLICY` file could have widened the read surface
    // without dropping or creating a single policy.
    const r = await ownerPool().query<{ relname: string; polname: string; restricted: boolean }>(
      `SELECT c.relname, p.polname, (p.polroles <> '{0}'::oid[]) AS restricted
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1)
          AND p.polname IN ('inventory_internal_read', 'accounting_validator')
        ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(r.rows.length, 'the two internal read policies must exist on each of the four relations').toBe(RELATIONS.length * 2);
    for (const row of r.rows) expect(row.restricted, `${row.relname}.${row.polname} lost its TO <role> and is now a PUBLIC USING (true)`).toBe(true);

    const pub = await ownerPool().query<{ relname: string; priv: string }>(
      `SELECT c.relname, pr.priv
         FROM pg_class c
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(priv)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1)
          AND has_table_privilege('public', c.oid, pr.priv)
        ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(pub.rows, 'PUBLIC must hold no table privilege on any of the four relations').toEqual([]);
  }, 120_000);

  it('the two INTERNAL principals read the same rows under both shapes — the escape inside a subselect is the same escape', async () => {
    for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
      const c = await connectAs('daftar_migrator', { tenantId: w.shop.tenantId, businessId: w.shop.businessId });
      try {
        await c.query(`SET ROLE ${role}`);
        const shipped = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n;
        expect(Number(shipped), `${role} reads no invoice at all, so an equality here would be vacuous`).toBeGreaterThan(0);
        let perRow: string | undefined;
        try {
          await setShape('per-row');
          perRow = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices`)).rows[0]?.n;
        } finally {
          await setShape('once-per-query');
        }
        expect(perRow, `${role} sees a different number of invoices under the two shapes`).toBe(shipped);
      } finally {
        await c.end();
      }
    }
    await shippedShapeIsBack();
  }, 180_000);

  it('the WRITE path was not touched: every WITH CHECK and every write restrictive keeps the per-row form', async () => {
    const r = await ownerPool().query<{ relname: string; polname: string; q: string | null; w: string | null }>(
      `SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY 1, 2`,
      [[...RELATIONS]],
    );
    expect(r.rows.length, 'the four relations carry seven policies each').toBe(RELATIONS.length * 7);
    for (const row of r.rows) {
      if (row.w !== null) expect(row.w, `${row.relname}.${row.polname} WITH CHECK was rewritten by a file that names no WITH CHECK`).not.toContain('( SELECT');
      if (!REWRITTEN.includes(row.polname as (typeof REWRITTEN)[number]))
        expect(row.q ?? '', `${row.relname}.${row.polname} is not named by 0086 and must be untouched`).not.toContain('( SELECT');
    }
  }, 60_000);

  it('row security is still ENABLED and FORCED on all four relations (§91)', async () => {
    const r = await ownerPool().query<{ relname: string; e: boolean; f: boolean }>(
      `SELECT relname, relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1::text[]) ORDER BY 1`,
      [[...RELATIONS]],
    );
    expect(r.rows.map((x) => `${x.relname} ${x.e} ${x.f}`)).toEqual(RELATIONS.map((n) => `${n} true true`).sort());
  }, 60_000);
});
