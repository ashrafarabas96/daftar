/**
 * DR-60 — THE EIGHT READ POLICIES `0086` REWROTE, PROVED TO STILL ISOLATE ONE
 * MERCHANT FROM ANOTHER, ON A LIVE DATABASE WITH TWO TENANTS IN IT.
 *
 * `0086_phase4_rls_quals_once_per_query.sql` rewrote eight read quals on four
 * relations that carry money. It is NOT the first migration in this project
 * to have altered a row-security policy, and an earlier draft of this file
 * said it was. Measured with a lexer over every migration: `0045` alters 3
 * policies, `0052` — the journal's own RLS PERFORMANCE migration, the same
 * class of change for the same reason — alters 6, `0067` and `0070` and
 * `0077` alter 1 each, and `0086` alters 8. What IS true, and is what makes
 * this file worth writing, is narrower: every Phase 4 branch ships a `ci.yml`
 * with no runnable runner on it, so this project has no recorded run in which
 * `0086` was installed on a live cluster until the migration-signature card
 * ran `0000 → latest` by hand. Its own end-state
 * block reads the new quals back out of the catalogue, and
 * `p4s4-rls-quals-once-per-query.test.ts` proves the rewrite moved no answer.
 * Neither of those is this file's subject.
 *
 * WHAT IS ALREADY PROVED ELSEWHERE, AND IS NOT RE-PROVED HERE. The
 * once-per-query suite already shows, on all four relations: that a foreign
 * tenant reads nothing, that an unscoped connection reads nothing, and that
 * the visible row SET is identical under both policy shapes. This file does
 * not claim that ground as its own. What it adds is the part no suite on this
 * head covers:
 *
 *   1. TWO TENANTS AT ONCE, both carrying real rows in all four relations, so
 *      "sees only its own" is a statement about two populated scopes and not
 *      about one scope and an empty database. A count of zero under a foreign
 *      scope proves nothing when the relation is globally empty; here the
 *      other tenant's rows are present, counted, and named by id.
 *   2. ONE CASE PER POLICY. Eight cases, each scoped so that exactly ONE of
 *      the eight quals is the thing refusing. That is what makes a negative
 *      control meaningful: weaken one policy and exactly one case turns red,
 *      by name. A single "a foreigner sees nothing" case would turn red for
 *      any of the eight and so could not tell them apart.
 *   3. THE WRITE PATH — `UPDATE` and `DELETE` — which no suite measures at
 *      all, and whose true shape is not what the card that commissioned this
 *      file assumed. See the block above the write cases.
 *   4. THE MONEY READERS, exercised with rows under a tenant scope. They are
 *      `INVOKER` routines (measured, not assumed: `pg_proc.prosecdef` is
 *      false for every one of them), so they read through the caller's row
 *      security and a tenant boundary that holds on the relations has to hold
 *      through them too — but "has to" is an argument, and this file measures
 *      it instead.
 *
 * HOW A CASE IS SCOPED SO THAT ONE POLICY IS THE ONLY THING DECIDING.
 * `tenant_membership` is PERMISSIVE and `FOR ALL`; `business_isolation_read`
 * is RESTRICTIVE and `FOR SELECT` (both measured from `pg_policy`, not read
 * off the migration text). A row is visible only when the permissive one
 * admits it AND the restrictive one does.
 *
 *   — To make `tenant_membership` the only refuser: scope the connection to a
 *     FOREIGN tenant but to THIS business. `business_isolation_read` is then
 *     satisfied outright, so a row that becomes visible became visible
 *     because the tenant qual let it through.
 *   — To make `business_isolation_read` the only refuser: scope to THIS
 *     tenant but to a foreign business. `tenant_membership` is then satisfied
 *     outright.
 *
 * The foreign tenant and foreign business are FRESH UUIDs minted each run, so
 * no qual can have been written against them.
 *
 * EVERY ZERO HAS A POSITIVE CONTROL. A case that asserts "this scope sees
 * nothing" is satisfied by a broken fixture, a mistyped relation name or an
 * empty database. Each such case therefore also asserts that the OWNING scope
 * sees the very rows the foreign scope did not, in the same statement shape,
 * in the same run.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { urlOf } from '../helpers/scratch-db';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { applyCredit, collectPayment, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';

/** The four relations `0086` rewrote quals on, and the two quals on each. */
const RELATIONS = ['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] as const;
const REWRITTEN = ['tenant_membership', 'business_isolation_read'] as const;
type Relation = (typeof RELATIONS)[number];
type Policy = (typeof REWRITTEN)[number];

/**
 * The stable token a negative control greps for.
 *
 * The harness that weakens one policy and asks whether the right case turned
 * red matches on this token, so the token — not the prose around it — is the
 * contract between the plant and the case.
 */
const token = (pol: Policy, rel: Relation): string => `[DR60:${pol}@${rel}]`;

interface Tenant {
  readonly label: string;
  readonly w: SettlementWorld;
  readonly tenantId: string;
  readonly businessId: string;
  readonly customerId: string;
  /** Every row id this tenant owns, per relation, read as the owner. */
  readonly ids: Record<Relation, readonly string[]>;
}

let A: Tenant;
let B: Tenant;
/** Minted per run: a scope no qual in the tree can have been written against. */
const FOREIGN_TENANT = randomUUID();
const FOREIGN_BUSINESS = randomUUID();

/** One connection as `daftar_app`, scoped exactly the way `Database.applyScope` scopes one. */
async function connectAs(scope: { tenantId?: string; businessId?: string } = {}): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', 'daftar_app') });
  await c.connect();
  if (scope.tenantId !== undefined) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId]);
  if (scope.businessId !== undefined) await c.query(`SELECT set_config('app.business_id', $1, false)`, [scope.businessId]);
  return c;
}

/**
 * One connection acting as `daftar_inventory_internal`, the only principal
 * holding any write privilege on these relations.
 *
 * It is `NOLOGIN` (measured in `pg_roles`), exactly as the deployment model
 * intends: it is reached by ASSUMING it, never by holding a credential for
 * it. `bootstrap.sql` grants it to `daftar_migrator` `WITH INHERIT FALSE,
 * SET TRUE`, so the only way in is `SET ROLE` — which is what the inventory
 * routines do, and which is what is done here. `daftar_migrator` is itself
 * `NOSUPERUSER` and `NOBYPASSRLS`, so nothing on this path bypasses row
 * security; the case below asserts the effective role rather than trusting
 * that the `SET ROLE` landed.
 */
async function connectAsInventoryInternal(scope: { tenantId: string; businessId: string }): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', 'daftar_migrator') });
  await c.connect();
  await c.query(`SET ROLE daftar_inventory_internal`);
  const who = await c.query<{ u: string; bypass: boolean }>(
    `SELECT current_user::text AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
  );
  if (who.rows[0]?.u !== 'daftar_inventory_internal') throw new Error(`SET ROLE did not land: current_user is ${who.rows[0]?.u}`);
  if (who.rows[0]?.bypass !== false) throw new Error('the assumed role bypasses row security, so no write case below would measure a policy');
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId]);
  await c.query(`SELECT set_config('app.business_id', $1, false)`, [scope.businessId]);
  return c;
}

/** The ids of `rel` this connection can actually see, in a stable order. */
async function visible(c: Client, rel: Relation): Promise<string[]> {
  const r = await c.query<{ id: string }>(`SELECT id::text AS id FROM ${rel} ORDER BY 1`);
  return r.rows.map((x) => x.id);
}

/**
 * Build one tenant with rows in ALL FOUR relations.
 *
 * `payment_allocations` and `customer_credit_applications` have no rows until
 * a payment is both allocated AND leaves a surplus that is then applied, so
 * the fixture goes all the way through the real commands rather than stopping
 * at the invoice. A relation left empty would make every visibility assertion
 * over it an assertion about nothing, and the non-vacuity guard below would —
 * correctly — refuse the whole run rather than let that pass.
 */
async function buildTenant(label: string): Promise<Tenant> {
  const w = await settlementWorld(label);
  const missing = await settlementMissing(w);
  if (missing.length > 0) throw new Error(`the settlement surface is incomplete, so this file would prove nothing: ${missing.join(', ')}`);
  await stockUp(w, '400', '5');
  const customerId = await newCustomer(w);
  const opened = [await sellOnCredit(w, customerId, '2'), await sellOnCredit(w, customerId, '3')];
  const first = opened[0];
  const second = opened[1];
  if (first === undefined || second === undefined) throw new Error(`${label}: the fixture sold fewer than two invoices`);

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
  expect(res.status, `${label}: the collection commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);

  const cr = (
    await ownerPool().query<{ oa: string; ob: string }>(
      `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
         FROM customer_credits WHERE business_id = $1 AND id = $2`,
      [w.shop.businessId, creditId],
    )
  ).rows[0];
  if (cr === undefined) throw new Error(`${label}: the surplus credit was not created, so customer_credit_applications would be empty`);
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
  expect(applied.status, `${label}: the credit application commits: ${JSON.stringify(applied.body)}`).toBeLessThan(300);

  const ids = {} as Record<Relation, readonly string[]>;
  for (const rel of RELATIONS) {
    const r = await ownerPool().query<{ id: string }>(`SELECT id::text AS id FROM ${rel} WHERE business_id = $1 ORDER BY 1`, [w.shop.businessId]);
    ids[rel] = r.rows.map((x) => x.id);
  }
  return { label, w, tenantId: w.shop.tenantId, businessId: w.shop.businessId, customerId, ids };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  A = await buildTenant('dr60a');
  B = await buildTenant('dr60b');

  // NON-VACUITY, before any case runs. Two distinct scopes, and every one of
  // the four relations populated on BOTH sides. Without this the whole file
  // could be green against an empty database.
  if (A.tenantId === B.tenantId) throw new Error('the two fixtures share a tenant, so no cross-tenant case would be cross-tenant');
  if (A.businessId === B.businessId) throw new Error('the two fixtures share a business');
  for (const rel of RELATIONS) {
    if (A.ids[rel].length === 0) throw new Error(`${rel} carries no row for tenant A, so every assertion over it would be vacuous`);
    if (B.ids[rel].length === 0) throw new Error(`${rel} carries no row for tenant B, so "sees only its own" would be vacuous`);
    const overlap = A.ids[rel].filter((id) => B.ids[rel].includes(id));
    if (overlap.length > 0) throw new Error(`${rel}: the two tenants share row id(s) ${overlap.join(',')}`);
  }
}, 1_800_000);

afterAll(async () => {
  await resetData();
});

describe('DR-60 — the eight read quals 0086 rewrote isolate one merchant from another', () => {
  // ── 1. ONE CASE PER POLICY: the eight ───────────────────────────────────
  for (const rel of RELATIONS) {
    it(`${token('tenant_membership', rel)} a FOREIGN TENANT carrying this business's own business_id reads none of ${rel}`, async () => {
      // `business_isolation_read` is satisfied here — the business matches —
      // so `tenant_membership` is the only qual that can refuse, and a row
      // that appears appeared because the tenant qual let it through.
      const foreign = await connectAs({ tenantId: FOREIGN_TENANT, businessId: A.businessId });
      const own = await connectAs({ tenantId: A.tenantId, businessId: A.businessId });
      try {
        const seen = await visible(foreign, rel);
        expect(seen, `a foreign tenant read ${seen.length} row(s) of ${rel} that belong to another merchant`).toEqual([]);
        // POSITIVE CONTROL, same statement, same run: the owning scope does
        // see them, so the empty array above is a refusal and not an empty
        // relation or a misspelled table.
        expect(await visible(own, rel), `the owning scope cannot see its own ${rel}, so the zero above proves nothing`).toEqual([...A.ids[rel]]);
      } finally {
        await foreign.end();
        await own.end();
      }
    }, 120_000);

    it(`${token('business_isolation_read', rel)} a FOREIGN BUSINESS carrying this tenant's own tenant_id reads none of ${rel}`, async () => {
      // `tenant_membership` is satisfied here — the tenant matches — so
      // `business_isolation_read` is the only qual that can refuse.
      const foreign = await connectAs({ tenantId: A.tenantId, businessId: FOREIGN_BUSINESS });
      const own = await connectAs({ tenantId: A.tenantId, businessId: A.businessId });
      try {
        const seen = await visible(foreign, rel);
        expect(seen, `a foreign business inside the right tenant read ${seen.length} row(s) of ${rel}`).toEqual([]);
        expect(await visible(own, rel), `the owning scope cannot see its own ${rel}, so the zero above proves nothing`).toEqual([...A.ids[rel]]);
      } finally {
        await foreign.end();
        await own.end();
      }
    }, 120_000);
  }

  // ── 2. EACH TENANT SEES EXACTLY ITS OWN ─────────────────────────────────
  it('each of the two tenants sees EXACTLY its own rows on all four relations — not a subset, not a superset', async () => {
    for (const t of [A, B]) {
      const other = t === A ? B : A;
      const c = await connectAs({ tenantId: t.tenantId, businessId: t.businessId });
      try {
        for (const rel of RELATIONS) {
          const seen = await visible(c, rel);
          // Set equality, not a count. Two equal counts can be two different
          // sets: one row of the other merchant admitted and one of this
          // merchant's own hidden would cancel out perfectly in a count(*).
          expect(seen, `${t.label} does not see exactly its own ${rel}`).toEqual([...t.ids[rel]]);
          for (const foreignId of other.ids[rel]) expect(seen, `${t.label} can see ${other.label}'s ${rel} row ${foreignId}`).not.toContain(foreignId);
        }
      } finally {
        await c.end();
      }
    }
  }, 180_000);

  // ── 3. NO SCOPE AT ALL ──────────────────────────────────────────────────
  it('with NO tenant context set, a runtime connection sees nothing on any of the four relations', async () => {
    const bare = await connectAs();
    try {
      for (const rel of RELATIONS) expect(await visible(bare, rel), `an unscoped connection reads ${rel}`).toEqual([]);
    } finally {
      await bare.end();
    }
    // POSITIVE CONTROL: the same role, scoped, does read rows — so "nothing"
    // above is default-deny and not a role with no privileges at all.
    const scoped = await connectAs({ tenantId: A.tenantId, businessId: A.businessId });
    try {
      for (const rel of RELATIONS) expect((await visible(scoped, rel)).length, `${rel} is empty even for its owner`).toBeGreaterThan(0);
    } finally {
      await scoped.end();
    }
  }, 180_000);

  // ── 4. THE WRITE PATH ───────────────────────────────────────────────────
  /**
   * WHAT THE WRITE PATH ACTUALLY IS ON THIS HEAD, MEASURED RATHER THAN
   * ASSUMED — AND IT IS NOT WHAT THE CARD THAT COMMISSIONED THIS FILE SAID.
   *
   * The card asked for "a tenant can neither UPDATE nor DELETE another
   * tenant's rows", as though both were decided by the eight rewritten quals.
   * Two measurements say otherwise, and both are made below from the
   * catalogue rather than from the migration text:
   *
   *   — `business_isolation_read` is `FOR SELECT` (`polcmd = 'r'`). It is not
   *     consulted on an `UPDATE` or a `DELETE` at all. The quals that govern
   *     writes are `business_isolation_update` and `business_isolation_delete`,
   *     which `0086` did not touch and which are therefore not this file's
   *     subject. Only `tenant_membership` (`polcmd = '*'`, FOR ALL) is in both.
   *   — `daftar_app`, the runtime principal, holds SELECT and nothing else on
   *     all four relations. An `UPDATE` or `DELETE` it issues is refused by
   *     PRIVILEGE (SQLSTATE 42501) before row security is ever reached.
   *
   * So the honest statement of the write side is in two parts, and the two
   * cases below are those two parts. Dressing a privilege refusal up as an
   * RLS proof would be the more impressive claim and the false one.
   */
  it('the merchant runtime principal holds NO write privilege on any of the four, so its UPDATE and DELETE are refused by privilege (42501) before row security', async () => {
    const grants = await ownerPool().query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = 'daftar_app' AND table_name = ANY($1::text[])`,
      [[...RELATIONS]],
    );
    const cols = await ownerPool().query<{ table_name: string; privilege_type: string; column_name: string }>(
      `SELECT table_name, privilege_type, column_name FROM information_schema.role_column_grants
        WHERE table_schema = 'public' AND grantee = 'daftar_app' AND table_name = ANY($1::text[])
          AND privilege_type IN ('UPDATE', 'DELETE', 'INSERT')`,
      [[...RELATIONS]],
    );
    expect(grants.rows.length, 'daftar_app holds no privilege at all on these relations, so this case has no subject').toBeGreaterThan(0);
    expect([...new Set(grants.rows.map((r) => r.privilege_type))].sort(), 'daftar_app holds a table privilege other than SELECT').toEqual(['SELECT']);
    expect(cols.rows, 'daftar_app holds a COLUMN-level write grant, which a table-level check does not see').toEqual([]);

    // And the refusal is measured, not inferred from the grant table: a
    // revoked privilege that some later GRANT re-added would show up here.
    const c = await connectAs({ tenantId: A.tenantId, businessId: A.businessId });
    try {
      for (const rel of RELATIONS) {
        await expect(
          c.query(`DELETE FROM ${rel} WHERE id = $1`, [A.ids[rel][0]]),
          `daftar_app was allowed to attempt a DELETE on ${rel}`,
        ).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await c.end();
    }
  }, 180_000);

  it(`${token('tenant_membership', 'invoices')} the one principal that CAN write cannot write across the tenant boundary: a foreign tenant scope updates ZERO rows`, async () => {
    // `daftar_inventory_internal` holds a column-level `UPDATE (status)` on
    // `invoices` — measured below, so this case cannot quietly become
    // vacuous if that grant is ever withdrawn. On an UPDATE the deciding
    // permissive qual is `tenant_membership`, which is one of the eight.
    //
    // Every statement here runs inside a transaction that is rolled back, so
    // the shared fixture is the same after this case as before it.
    const col = await ownerPool().query(
      `SELECT 1 FROM information_schema.role_column_grants
        WHERE table_schema = 'public' AND table_name = 'invoices' AND grantee = 'daftar_inventory_internal'
          AND privilege_type = 'UPDATE' AND column_name = 'status'`,
    );
    expect(col.rows.length, 'no principal holds UPDATE on invoices any more, so this case would be a vacuous zero').toBe(1);

    const foreign = await connectAsInventoryInternal({ tenantId: FOREIGN_TENANT, businessId: A.businessId });
    try {
      await foreign.query('BEGIN');
      const r = await foreign.query(`UPDATE invoices SET status = status WHERE id = ANY($1::uuid[])`, [[...A.ids.invoices]]);
      expect(r.rowCount, 'a foreign tenant UPDATED rows belonging to another merchant').toBe(0);
      await foreign.query('ROLLBACK');
    } finally {
      await foreign.end();
    }

    // POSITIVE CONTROL: the same statement, the same rows, the owning scope.
    // Without it, a zero here is equally well explained by a WHERE clause
    // that matches nothing.
    const own = await connectAsInventoryInternal({ tenantId: A.tenantId, businessId: A.businessId });
    try {
      await own.query('BEGIN');
      const r = await own.query(`UPDATE invoices SET status = status WHERE id = ANY($1::uuid[])`, [[...A.ids.invoices]]);
      expect(r.rowCount, 'the owning scope updated nothing either, so the zero above is not a refusal').toBe(A.ids.invoices.length);
      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }
  }, 180_000);

  it(`${token('tenant_membership', 'sales')} the one principal that CAN write cannot write across the tenant boundary on sales either`, async () => {
    const col = await ownerPool().query(
      `SELECT 1 FROM information_schema.role_column_grants
        WHERE table_schema = 'public' AND table_name = 'sales' AND grantee = 'daftar_inventory_internal'
          AND privilege_type = 'UPDATE' AND column_name = 'status'`,
    );
    expect(col.rows.length, 'no principal holds UPDATE on sales any more, so this case would be a vacuous zero').toBe(1);

    const foreign = await connectAsInventoryInternal({ tenantId: FOREIGN_TENANT, businessId: A.businessId });
    try {
      await foreign.query('BEGIN');
      const r = await foreign.query(`UPDATE sales SET status = status WHERE id = ANY($1::uuid[])`, [[...A.ids.sales]]);
      expect(r.rowCount, 'a foreign tenant UPDATED sales rows belonging to another merchant').toBe(0);
      await foreign.query('ROLLBACK');
    } finally {
      await foreign.end();
    }

    const own = await connectAsInventoryInternal({ tenantId: A.tenantId, businessId: A.businessId });
    try {
      await own.query('BEGIN');
      const r = await own.query(`UPDATE sales SET status = status WHERE id = ANY($1::uuid[])`, [[...A.ids.sales]]);
      expect(r.rowCount, 'the owning scope updated nothing either, so the zero above is not a refusal').toBe(A.ids.sales.length);
      await own.query('ROLLBACK');
    } finally {
      await own.end();
    }
  }, 180_000);

  it('DELETE is held by NO runtime principal on any of the four relations — the boundary there is a missing grant, not a qual', async () => {
    // ONE arm, not two. An earlier draft also queried `role_column_grants`
    // for `DELETE`, which looks thorough and is empty BY CONSTRUCTION:
    // PostgreSQL has no column-level DELETE privilege, so that arm could
    // never have returned a row and contributed nothing but the appearance
    // of coverage. The table-level view is the whole of the question.
    //
    // THE OWNER EXCLUSION IS AN ASSUMPTION, AND IT IS NAMED. `postgres` owns
    // these relations in this fixture, so it holds DELETE implicitly and is
    // excluded. A managed deployment hands ownership to `daftar_migrator`
    // (the migration-portability pattern), and there this case would FAIL —
    // loudly, naming `daftar_migrator`, which is the safe direction for an
    // assumption to break in. If that day comes, the fix is to exclude the
    // measured OWNER rather than a hard-coded name.
    const owner = await ownerPool().query<{ relowner: string }>(
      `SELECT pg_get_userbyid(relowner) AS relowner FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'invoices'`,
    );
    expect(owner.rows[0]?.relowner, 'the relations are no longer owned by the role this case excludes').toBe('postgres');

    const deleteGrants = async (excludeOwner: boolean): Promise<{ table_name: string; grantee: string }[]> =>
      (
        await ownerPool().query<{ table_name: string; grantee: string }>(
          `SELECT table_name, grantee FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND privilege_type = 'DELETE'
              AND ($2::bool IS FALSE OR grantee <> 'postgres')
            ORDER BY 1, 2`,
          [[...RELATIONS], excludeOwner],
        )
      ).rows;

    // POSITIVE CONTROL FIRST: without the owner exclusion the very same probe
    // DOES find DELETE grants. Without this, "no rows" is equally well
    // explained by a misspelled privilege name or a view that never matches.
    const withOwner = await deleteGrants(false);
    expect(withOwner.length, 'the probe finds no DELETE grant at all, so its emptiness below proves nothing about grants').toBeGreaterThan(0);
    expect([...new Set(withOwner.map((r) => r.grantee))], 'the probe found a DELETE holder other than the owner, which the next assertion then denies').toEqual(
      ['postgres'],
    );

    expect(await deleteGrants(true), 'some runtime principal holds DELETE on a Phase 4 money relation').toEqual([]);
  }, 60_000);

  // ── 5. THE MONEY READERS, UNDER A TENANT SCOPE ──────────────────────────
  it('the money readers are INVOKER, and one merchant reads NONE of another merchant’s money through them', async () => {
    // INVOKER is measured. A SECURITY DEFINER routine would read with its
    // owner's row security — which here is a superuser that bypasses RLS
    // altogether — and then every assertion below would be about the
    // p_business_id argument rather than about the tenant boundary.
    //
    // AND THE SET IS PINNED BY NAME, not counted. An earlier draft asserted
    // `rows.length > 0` over three named routines, which passes when ONE of
    // the three is present — so a reader that had been dropped, renamed, or
    // re-created as SECURITY DEFINER under another name would have left this
    // case green while its title claimed all of them were INVOKER.
    const MONEY_READERS = ['customer_ar_aging', 'customer_ar_open_document_counts', 'invoice_outstanding'] as const;
    const sec = await ownerPool().query<{ proname: string; prosecdef: boolean }>(
      `SELECT DISTINCT proname, prosecdef FROM pg_proc WHERE proname = ANY($1::text[]) ORDER BY 1`,
      [[...MONEY_READERS]],
    );
    expect(
      sec.rows.map((r) => r.proname),
      'the set of money readers present is not the set this case claims to be speaking about',
    ).toEqual([...MONEY_READERS].sort());
    for (const r of sec.rows) expect(r.prosecdef, `${r.proname} is SECURITY DEFINER, so it does not read through the caller's row security`).toBe(false);

    interface AgingRow {
      bucket_no: number;
      currency_code: string;
      txn_minor: string;
      base_minor: string;
      invoice_count: number;
    }
    interface CountRow {
      currency_code: string;
      open_debit_count: number;
      open_credit_count: number;
    }
    // The band set is the standard one DR-10 fixed, `[0, 30, 60, 90]`, so the
    // reader is asked the question the product asks it and not an easier one.
    const aging = async (c: Client, businessId: string, customerId: string): Promise<AgingRow[]> =>
      (
        await c.query<AgingRow>(
          `SELECT bucket_no, currency_code, txn_minor::text, base_minor::text, invoice_count
             FROM customer_ar_aging($1::uuid, $2::uuid, CURRENT_DATE, ARRAY[0,30,60,90]) ORDER BY 1, 2`,
          [businessId, customerId],
        )
      ).rows;
    const counts = async (c: Client, businessId: string, customerId: string): Promise<CountRow[]> =>
      (
        await c.query<CountRow>(
          `SELECT currency_code, open_debit_count, open_credit_count FROM customer_ar_open_document_counts($1::uuid, $2::uuid) ORDER BY 1`,
          [businessId, customerId],
        )
      ).rows;

    // POSITIVE CONTROL FIRST: A, in its own scope, gets real figures for its
    // own customer. Everything below is an emptiness claim, and an emptiness
    // claim whose positive control was never taken is a claim about a broken
    // fixture.
    const ownA = await connectAs({ tenantId: A.tenantId, businessId: A.businessId });
    const ownB = await connectAs({ tenantId: B.tenantId, businessId: B.businessId });
    try {
      const mineAging = await aging(ownA, A.businessId, A.customerId);
      const mineCounts = await counts(ownA, A.businessId, A.customerId);
      expect(mineAging.length, 'A reads no aging band for its own customer, so every emptiness below is vacuous').toBeGreaterThan(0);
      expect(mineCounts.length, 'A reads no open-document counter for its own customer').toBeGreaterThan(0);
      expect((await aging(ownB, B.businessId, B.customerId)).length, 'B reads no aging band for its own customer').toBeGreaterThan(0);

      // A, in its own legitimate scope, asking for B's customer and B's
      // business: the arguments are B's, the row security is A's.
      expect(await aging(ownA, B.businessId, B.customerId), 'A read B’s aging through customer_ar_aging').toEqual([]);
      expect(await counts(ownA, B.businessId, B.customerId), 'A read B’s open-document counters').toEqual([]);
      expect(await aging(ownB, A.businessId, A.customerId), 'B read A’s aging through customer_ar_aging').toEqual([]);
      expect(await counts(ownB, A.businessId, A.customerId), 'B read A’s open-document counters').toEqual([]);
    } finally {
      await ownA.end();
      await ownB.end();
    }

    // And a foreign TENANT holding this business's own id — the scope that
    // isolates `tenant_membership` — reads nothing through the readers either.
    const foreign = await connectAs({ tenantId: FOREIGN_TENANT, businessId: A.businessId });
    try {
      expect(await aging(foreign, A.businessId, A.customerId), 'a foreign tenant read this merchant’s aging').toEqual([]);
      expect(await counts(foreign, A.businessId, A.customerId), 'a foreign tenant read this merchant’s document counters').toEqual([]);
    } finally {
      await foreign.end();
    }
  }, 300_000);

  // ── 6. THE SURFACE ITSELF ───────────────────────────────────────────────
  it('row security is ENABLED and FORCED on all four relations, and exactly the eight quals 0086 names are in the subselect form', async () => {
    const rs = await ownerPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1`,
      [[...RELATIONS]],
    );
    expect(rs.rows.length).toBe(RELATIONS.length);
    for (const r of rs.rows) {
      expect(r.relrowsecurity, `${r.relname} has row security disabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} does not FORCE row security, so its owner bypasses it`).toBe(true);
    }
    const p = await ownerPool().query<{ relname: string; polname: string; polcmd: string; polpermissive: boolean; q: string | null }>(
      `SELECT c.relname, p.polname, p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS q
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[]) AND p.polname = ANY($2::text[])
        ORDER BY 1, 2`,
      [[...RELATIONS], [...REWRITTEN]],
    );
    expect(p.rows.length, 'the eight rewritten policies are not all present').toBe(RELATIONS.length * REWRITTEN.length);
    for (const row of p.rows) {
      expect(row.q ?? '', `${row.relname}.${row.polname} is not in the once-per-query form this file was written against`).toContain('( SELECT');
      // The two commands each policy answers for, which is what decides
      // whether this file's write cases are about it at all.
      if (row.polname === 'tenant_membership') {
        expect(row.polcmd, `${row.relname}.tenant_membership no longer answers for ALL commands`).toBe('*');
        expect(row.polpermissive, `${row.relname}.tenant_membership is no longer permissive`).toBe(true);
      } else {
        expect(row.polcmd, `${row.relname}.business_isolation_read no longer answers for SELECT only`).toBe('r');
        expect(row.polpermissive, `${row.relname}.business_isolation_read is no longer restrictive`).toBe(false);
      }
    }
  }, 60_000);
});
