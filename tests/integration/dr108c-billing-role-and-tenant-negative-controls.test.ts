/**
 * DECISION C, THIRD CONDITION — THE TWO NEGATIVE CONTROLS THE OWNER ORDERED
 * AND NOBODY HAD WRITTEN.
 *
 * The owner's third condition names three negative controls on the Phase 5
 * billing relations `0088` creates:
 *
 *   1. an UNAUTHORIZED ROLE IS REFUSED IN EVERY OPERATION;
 *   2. a TENANT DOES NOT WRITE INTO ANOTHER TENANT'S REMAINDERS;
 *   3. a credit write-off with no reason is refused.
 *
 * The third exists and passes (`packages/billing/test/credit-write-off.test.ts`,
 * 38 cases) and is not touched here. THIS FILE IS THE FIRST TWO, and before it
 * there was no case for either: `0088`'s own grant/policy block says so in its
 * own words — "Not one statement below is asserted by any run" — and the only
 * other reader of that block, `tests-unit/dr100-migration-0088-matches-accepted-ddl.test.ts`,
 * compares TEXT and never a privilege.
 *
 * ── WHERE THIS FILE RUNS, AND WHY IT IS IN `tests/integration` ──
 * `.github/workflows/ci.yml` runs "Fresh database migrate (0000 → latest)"
 * (`npm run migrate -w @daftar/api`) and then "Integration + security tests"
 * (`npm run test:integration`) against THE SAME database, so a file placed
 * here meets `0088` installed by the project's own runner, on the real
 * `bootstrap.sql` roles. That is the only arrangement in this repository in
 * which a privilege claim about `daftar_app` means anything.
 *
 * ── THE UNAUTHORIZED ROLE, AND WHY THIS ONE ──
 * `daftar_app`. It is chosen, out of the nine login roles `bootstrap.sql`
 * creates, because it is THE ROLE THE RUNNING APPLICATION HOLDS A CREDENTIAL
 * FOR (`Database.applyScope` connects as it, and `tests/security/dr60-rls-tenant-isolation.test.ts`
 * reaches the money relations through exactly this role). A refusal measured
 * on an unused role would be a statement about nobody. Measured off the
 * bootstrap text: `daftar_app` receives `CONNECT ON DATABASE daftar` and
 * `USAGE ON SCHEMA public` and nothing else; `0088` grants it nothing; there
 * is no `ALTER DEFAULT PRIVILEGES` anywhere under `infrastructure/database/`
 * (zero occurrences, against 14 `GRANT` lines in `bootstrap.sql` — the probe
 * is sighted), and all four relations are `REVOKE ALL … FROM PUBLIC`. So the
 * expected refusal is a MISSING PRIVILEGE and not a policy, on every one of
 * the sixteen relation/operation pairs.
 *
 * ── THE THREE REASONS A STATEMENT CAN COME BACK EMPTY, KEPT APART ──
 * The owner's instruction is that these three are never conflated:
 *
 *   A. MISSING PRIVILEGE — `permission denied for table X`
 *   B. A POLICY REFUSING A WRITE — `new row violates row-level security policy`
 *   C. A POLICY BLINDING A READ — no error at all, `rowCount = 0`
 *
 * `SQLSTATE` separates C from A and B (C has no SQLSTATE). It does NOT
 * separate A from B, and this file says so rather than pretending otherwise:
 * PostgreSQL raises BOTH as `42501 insufficient_privilege`. So A and B are
 * told apart by the MESSAGE SHAPE, through `classify()` below, which refuses
 * unless EXACTLY ONE of the two anchored patterns matches — a message that
 * matched neither, or both, is a defect in this file's reader and is raised as
 * one instead of being rounded to a verdict.
 *
 * ── THE AUTHORIZED PRINCIPAL, AND THE ONE THING THAT IS NOT CLEAN ──
 * `daftar_accounting_internal` is `NOLOGIN NOINHERIT` (`bootstrap.sql:157`),
 * so NO SESSION CAN AUTHENTICATE AS IT and a positive control cannot be run
 * by connecting as it. It is therefore reached the narrowest way that works
 * and the only way the deployment model offers: connect as `daftar_migrator`
 * — `NOSUPERUSER NOBYPASSRLS`, granted `daftar_accounting_internal`
 * `WITH INHERIT FALSE, SET TRUE` (`bootstrap.sql:297`) — and `SET ROLE`. That
 * is stated, not glossed, and it is the same route
 * `tests/integration/migration-portability.test.ts:303` already uses. Each
 * such connection then ASSERTS that the `SET ROLE` landed and that the
 * assumed role does not bypass row security, because a `SET ROLE` that
 * silently failed would turn every positive control below into a measurement
 * of `daftar_migrator`.
 *
 * ── THE ONE POSITIVE CONTROL THAT CANNOT BE A STATEMENT, AND WHY ──
 * `DELETE` is held by NO granted principal on any of the four relations:
 * `0088`'s five grants are three table `SELECT`s, one `SELECT, INSERT` and one
 * `UPDATE (remaining_minor)`. So "the authorized principal succeeds in the
 * corresponding operation" is IMPOSSIBLE for `DELETE`, and inventing a
 * principal for it would be inventing the thing under test. The positive
 * control for `DELETE` is therefore a CATALOGUE one of the same shape: the
 * exact grant set per relation is read out of `information_schema`, `DELETE`
 * is absent from it, and the very same query returns the `SELECT` and
 * `INSERT` rows — so the absence is a measured absence and not an empty
 * probe (RULE-11). The same applies to `INSERT` and `UPDATE` on the three
 * read-only relations, where the authorized principal is refused too, by a
 * missing privilege, which this file also measures.
 *
 * ── WHAT IS ASSERTED AND WHAT IS NOT ──
 * Every behavioural claim below is `NOT_RUN` on the machine this was written
 * on: there is no PostgreSQL cluster on it. Nothing here was executed. The
 * file is written, type-checked and linted locally, and its verdicts are CI's
 * (DR-95/5).
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData, dbUrl } from '../helpers/test-app';
import { urlOf } from '../helpers/scratch-db';

/** The four relations `0088` creates, in the order its grant block names them. */
const RELATIONS = ['platform_credit_adjustments', 'subscription_invoices', 'subscription_charge_attempts', 'platform_credit_grant_remainders'] as const;
type Relation = (typeof RELATIONS)[number];

const OPERATIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Operation = (typeof OPERATIONS)[number];

/** The role the running application holds a credential for, and the subject of control 1. */
const UNAUTHORIZED = 'daftar_app';
/** The only principal `0088` grants anything to. */
const AUTHORIZED = 'daftar_accounting_internal';

const CURRENCY = 'JOD';
/** Every grant below is this many minor units, so a remainder is a known integer. */
const GRANT_MINOR = 500n;

/** The two refusal shapes, anchored so a longer message cannot match by accident. */
const PRIVILEGE_REFUSAL = /^permission denied for table [a-z_]+$/;
const POLICY_REFUSAL = /^new row violates row-level security policy/;

interface Refusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Run `sql` and return the refusal it produced.
 *
 * A statement that SUCCEEDS throws here rather than returning something a
 * caller could read as a refusal: "it was refused" and "it was allowed" must
 * not be able to reach the same assertion.
 */
async function refusalOf(c: Client, sql: string, params: readonly unknown[] = []): Promise<Refusal> {
  try {
    const r = await c.query(sql, [...params]);
    throw new Error(`the statement was NOT refused (rowCount=${String(r.rowCount)}): ${sql}`);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (typeof err.code !== 'string') throw e;
    return { code: err.code, message: typeof err.message === 'string' ? err.message : '' };
  }
}

/**
 * Which of the two `42501` causes this refusal is.
 *
 * Refuses unless exactly one pattern matches. The shared SQLSTATE is the
 * reason this exists: reading the code alone would make a policy refusal and
 * a missing privilege the same answer, which is the conflation the owner's
 * instruction forbids.
 */
function classify(r: Refusal): 'privilege' | 'policy' {
  const priv = PRIVILEGE_REFUSAL.test(r.message);
  const pol = POLICY_REFUSAL.test(r.message);
  if (priv === pol) throw new Error(`a refusal this file cannot classify — ${priv ? 'both patterns' : 'neither pattern'} matched: ${r.code} ${r.message}`);
  return priv ? 'privilege' : 'policy';
}

/** One connection as `daftar_app`, with no scope: the privilege check precedes any policy. */
async function connectUnauthorized(): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', UNAUTHORIZED) });
  await c.connect();
  const who = (await c.query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0];
  if (who?.u !== UNAUTHORIZED) throw new Error(`the unauthorized connection is ${String(who?.u)}, not ${UNAUTHORIZED}`);
  return c;
}

/**
 * One connection ACTING AS `daftar_accounting_internal`, scoped to one tenant.
 *
 * The role is `NOLOGIN`, so this is the narrowest route that exists; the two
 * guards below are what keep a silent `SET ROLE` failure from being read as a
 * positive control, and the `app_bypass()` guard is what keeps the measurement
 * from being about a bypass instead of about a policy.
 */
async function connectAuthorized(scope: { tenantId: string; businessId: string }): Promise<Client> {
  const c = new Client({ connectionString: urlOf('daftar', 'daftar_migrator') });
  await c.connect();
  await c.query(`SET ROLE ${AUTHORIZED}`);
  const who = (
    await c.query<{ u: string; bypass: boolean; sup: boolean }>(
      `SELECT current_user::text AS u,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
              (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user) AS sup`,
    )
  ).rows[0];
  if (who?.u !== AUTHORIZED) throw new Error(`SET ROLE did not land: current_user is ${String(who?.u)}`);
  if (who.bypass !== false) throw new Error('the assumed role bypasses row security, so no policy case below would measure a policy');
  if (who.sup !== false) throw new Error('the assumed role is a superuser, so no privilege case below would measure a privilege');
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId]);
  await c.query(`SELECT set_config('app.business_id', $1, false)`, [scope.businessId]);
  const bypass = (await c.query<{ b: boolean }>(`SELECT app_bypass() AS b`)).rows[0];
  if (bypass?.b !== false) throw new Error('app_bypass() is true on the authorized connection, so every policy below would be short-circuited');
  return c;
}

/**
 * The grants each tenant carries, ONE PER PURPOSE.
 *
 * Six and not three, deliberately: two cases that shared a grant would share
 * its remainder row, and the second to run would meet a primary-key collision
 * or an already-decremented figure instead of the thing it measures. Order
 * between cases is then not a dependency this file has.
 */
const GRANT_ROLES = ['read', 'insert_c1', 'insert_own', 'insert_target', 'update_own', 'update_target'] as const;
type GrantRole = (typeof GRANT_ROLES)[number];

interface Party {
  readonly label: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly invoiceId: string;
  readonly attemptId: string;
  readonly grants: Readonly<Record<GrantRole, string>>;
}

type Label = 'a' | 'b';

let A: Party | undefined;
let B: Party | undefined;

/**
 * The fixture for one side, resolved INSIDE a case body.
 *
 * Every case below is named by its LABEL and never by a field of the fixture,
 * because a dynamic title is evaluated at COLLECTION time — before `beforeAll`
 * has built anything. A title that read `A.label` would make the whole file
 * fail to collect, which is a failure that looks like a broken suite rather
 * than a missing fixture. This function is also the non-vacuity guard: a case
 * that somehow ran without a fixture refuses by name instead of measuring
 * `undefined`.
 */
function partyOf(label: Label): Party {
  const p = label === 'a' ? A : B;
  if (p === undefined) throw new Error(`the ${label} fixture was not built, so this case would measure nothing`);
  return p;
}

/**
 * Seed one tenant with rows in ALL FOUR relations, as the cluster superuser.
 *
 * Two things force the shape of this function and are worth naming:
 *
 *   * `assert_invoice_credit_agrees()` is a deferred invariant that FAILS
 *     CLOSED for a caller whose context does not own the invoice, and its
 *     owner exemption is `SESSION_USER = <owner of schema public>` — which is
 *     `daftar_migrator` (`bootstrap.sql:234`) and NOT the superuser this
 *     seeder connects as. So the seeder sets `app.tenant_id` and
 *     `app.business_id` and satisfies the invariant through its OTHER arm.
 *   * `pca_maintain_remainder()` is `SECURITY DEFINER` owned by
 *     `daftar_accounting_internal` (`0088:1431`), so the remainder row it
 *     writes is written under `pcgr_accounting_tenant_insert` and needs those
 *     same two GUCs set. A grant inserted without them would not get its
 *     remainder row.
 *
 * `occurred_at` ascends across the five grants because `pca_chronology()`
 * refuses a ledger that is non-monotonic in `(business, currency)`.
 */
async function seedParty(label: string, slug: string): Promise<Party> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const tenantId = (await c.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id::text AS id`)).rows[0]?.id;
    if (tenantId === undefined) throw new Error(`${label}: no tenant was created`);
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    const businessId = (
      await c.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, $2, $3, 'JO', $4, 'Asia/Amman') RETURNING id::text AS id`,
        [tenantId, `DR108C ${label}`, slug, CURRENCY],
      )
    ).rows[0]?.id;
    if (businessId === undefined) throw new Error(`${label}: no business was created`);
    await c.query(`SELECT set_config('app.business_id', $1, false)`, [businessId]);

    const invoiceId = randomUUID();
    await c.query(
      `INSERT INTO public.subscription_invoices
         (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, tax_minor, total_minor, state, issued_at)
       VALUES ($1, $2, $3, 0, $4, 1000, 0, 0, 1000, 'open', now())`,
      [invoiceId, tenantId, businessId, CURRENCY],
    );

    const attemptId = randomUUID();
    await c.query(
      `INSERT INTO public.subscription_charge_attempts
         (id, tenant_id, business_id, invoice_id, attempt_no, idempotency_key, amount_minor, currency, outcome, provider, provider_ref, provider_code, attempted_at)
       VALUES ($1, $2, $3, $4, 1, $5, 1000, $6, 'declined', 'dr108c', 'ref-1', 'card_declined', now())`,
      [attemptId, tenantId, businessId, invoiceId, `dr108c:${invoiceId}:1`, CURRENCY],
    );

    const grants: Record<GrantRole, string> = {} as Record<GrantRole, string>;
    let step = 0;
    for (const role of GRANT_ROLES) {
      const id = randomUUID();
      grants[role] = id;
      await c.query(
        `INSERT INTO public.platform_credit_adjustments
           (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
         VALUES ($1, $2, $3, 'grant', $4, $5, now() + ($6 || ' seconds')::interval, $7, $8)`,
        [id, tenantId, businessId, GRANT_MINOR.toString(), CURRENCY, String(step), `dr108c/${label}/${role}`, `negative-control fixture: ${role}`],
      );
      step += 1;
    }

    // The two grants whose remainder row a case must be free to INSERT. The
    // trigger created one for each; the seeder removes exactly those two, as
    // the superuser, so the FK the case needs is satisfiable and the PRIMARY
    // KEY is free. Nothing else in this file deletes a remainder row.
    for (const role of ['insert_c1', 'insert_own', 'insert_target'] as const) {
      const del = await c.query(`DELETE FROM public.platform_credit_grant_remainders WHERE grant_id = $1`, [grants[role]]);
      if (del.rowCount !== 1) throw new Error(`${label}: the trigger did not write a remainder row for the ${role} grant (deleted ${String(del.rowCount)})`);
    }

    return { label, tenantId, businessId, invoiceId, attemptId, grants };
  } finally {
    await c.end();
  }
}

/** A read that bypasses every policy, for the "did B's row change?" half of a blind-write case. */
async function remainingAsOwner(grantId: string): Promise<string | null> {
  const r = await ownerPool().query<{ m: string }>(`SELECT remaining_minor::text AS m FROM public.platform_credit_grant_remainders WHERE grant_id = $1`, [
    grantId,
  ]);
  return r.rows[0]?.m ?? null;
}

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The statement each operation would run on each relation.
 *
 * Every one is WELL-FORMED and would commit if the privilege existed, so that
 * a refusal is about the ACL and not about a column name. The privilege check
 * runs at executor start, before any constraint, trigger or policy, which is
 * why the unauthorized cases never reach the invariants these relations carry.
 */
function statementFor(rel: Relation, op: Operation, p: Party): Statement {
  const key = `${rel}/${op}`;
  if (op === 'SELECT') return { sql: `SELECT count(*)::int AS n FROM public.${rel}`, params: [] };

  if (op === 'DELETE') {
    const column = rel === 'platform_credit_grant_remainders' ? 'grant_id' : 'id';
    const id = rel === 'subscription_invoices' ? p.invoiceId : rel === 'subscription_charge_attempts' ? p.attemptId : p.grants.read;
    return { sql: `DELETE FROM public.${rel} WHERE ${column} = $1`, params: [id] };
  }

  if (op === 'UPDATE') {
    if (rel === 'platform_credit_adjustments')
      return { sql: `UPDATE public.platform_credit_adjustments SET reason = reason WHERE id = $1`, params: [p.grants.read] };
    if (rel === 'subscription_invoices') return { sql: `UPDATE public.subscription_invoices SET state = state WHERE id = $1`, params: [p.invoiceId] };
    if (rel === 'subscription_charge_attempts')
      return { sql: `UPDATE public.subscription_charge_attempts SET outcome = outcome WHERE id = $1`, params: [p.attemptId] };
    if (rel === 'platform_credit_grant_remainders')
      return { sql: `UPDATE public.platform_credit_grant_remainders SET remaining_minor = remaining_minor WHERE grant_id = $1`, params: [p.grants.update_own] };
    throw new Error(`no statement for ${key}`);
  }

  if (rel === 'platform_credit_adjustments')
    return {
      sql: `INSERT INTO public.platform_credit_adjustments (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
            VALUES ($1, $2, $3, 'grant', 1, $4, now(), 'dr108c/probe', 'probe')`,
      params: [randomUUID(), p.tenantId, p.businessId, CURRENCY],
    };
  if (rel === 'subscription_invoices')
    return {
      sql: `INSERT INTO public.subscription_invoices (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, tax_minor, total_minor, state)
            VALUES ($1, $2, $3, 9001, $4, 1, 0, 0, 1, 'draft')`,
      params: [randomUUID(), p.tenantId, p.businessId, CURRENCY],
    };
  if (rel === 'subscription_charge_attempts')
    return {
      sql: `INSERT INTO public.subscription_charge_attempts
              (id, tenant_id, business_id, invoice_id, attempt_no, idempotency_key, amount_minor, currency, outcome, provider, provider_ref, provider_code, attempted_at)
            VALUES ($1, $2, $3, $4, 9001, $5, 1, $6, 'declined', 'dr108c', 'probe', 'probe', now())`,
      params: [randomUUID(), p.tenantId, p.businessId, p.invoiceId, `dr108c-probe:${p.invoiceId}:9001`, CURRENCY],
    };
  if (rel === 'platform_credit_grant_remainders')
    return {
      // `insert_c1` and nothing else: this is the one case in the file that
      // may actually COMMIT a remainder row here, and control 2 uses other
      // grants, so neither can disturb the other.
      sql: `INSERT INTO public.platform_credit_grant_remainders (tenant_id, business_id, currency, grant_id, granted_minor, remaining_minor)
            VALUES ($1, $2, $3, $4, $5, $5)`,
      params: [p.tenantId, p.businessId, CURRENCY, p.grants.insert_c1, GRANT_MINOR.toString()],
    };
  throw new Error(`no statement for ${key}`);
}

/** The operations `0088` grants the authorized principal, per relation. Read off its five GRANT statements. */
const GRANTED: Readonly<Record<Relation, readonly Operation[]>> = {
  platform_credit_adjustments: ['SELECT'],
  subscription_invoices: ['SELECT'],
  subscription_charge_attempts: ['SELECT'],
  platform_credit_grant_remainders: ['SELECT', 'INSERT', 'UPDATE'],
};

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const tag = randomUUID().slice(0, 8);
  A = await seedParty('a', `dr108c-a-${tag}`);
  B = await seedParty('b', `dr108c-b-${tag}`);
  const parties = [partyOf('a'), partyOf('b')] as const;
  const [a, b] = parties;

  // NON-VACUITY, before any case runs. Two distinct scopes, both populated in
  // all four relations: a refusal measured against an empty relation is a
  // statement about nothing.
  if (a.tenantId === b.tenantId) throw new Error('the two fixtures share a tenant, so no cross-tenant case would be cross-tenant');
  if (a.businessId === b.businessId) throw new Error('the two fixtures share a business');
  for (const rel of RELATIONS) {
    for (const p of parties) {
      const n = (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${rel} WHERE business_id = $1`, [p.businessId])).rows[0]?.n ?? 0;
      if (n === 0) throw new Error(`${rel} carries no row for tenant ${p.label}, so every assertion over it would be vacuous`);
    }
  }
  for (const role of ['insert_c1', 'insert_own', 'insert_target'] as const) {
    for (const p of parties) {
      if ((await remainingAsOwner(p.grants[role])) !== null)
        throw new Error(`${p.label}: the ${role} remainder row still exists, so an INSERT case would collide on the primary key instead of measuring a policy`);
    }
  }
  for (const role of ['read', 'update_own', 'update_target'] as const) {
    for (const p of parties) {
      const m = await remainingAsOwner(p.grants[role]);
      if (m !== GRANT_MINOR.toString())
        throw new Error(
          `${p.label}: the ${role} remainder is ${String(m)}, not ${GRANT_MINOR.toString()}, so an UPDATE case would measure the wrong arithmetic`,
        );
    }
  }
}, 900_000);

afterAll(async () => {
  await resetData();
});

/* ===================================================================== */
/* CONTROL 1 — AN UNAUTHORIZED ROLE IS REFUSED IN EVERY OPERATION        */
/* ===================================================================== */

describe('DR-108-C control 1 — an unauthorized role is refused in every operation', () => {
  it('the exact grant set per relation, read from the catalogue, names SELECT/INSERT/UPDATE and never DELETE', async () => {
    // This is the positive control for the operations no statement can
    // demonstrate — DELETE on all four relations, and INSERT/UPDATE on the
    // three read-only ones. The probe is sighted: the rows it DOES return are
    // asserted, so an empty answer cannot pass as an absence.
    for (const rel of RELATIONS) {
      // Read from `pg_class.relacl` through `aclexplode`, NOT from
      // `information_schema.table_privileges`: that view shows only
      // privileges of or granted by a CURRENTLY ENABLED role, and this
      // connection is neither the grantor (the schema owner) nor a member of
      // the grantee, so it would have answered zero rows for every relation —
      // an empty probe read as an absence, which is RULE-11's whole subject.
      const granted = (
        await ownerPool().query<{ grantee: string; priv: string }>(
          `SELECT coalesce(g.rolname, 'PUBLIC')::text AS grantee, a.privilege_type AS priv
             FROM pg_class c
             CROSS JOIN LATERAL aclexplode(c.relacl) a
             LEFT JOIN pg_roles g ON g.oid = a.grantee
            WHERE c.oid = format('public.%I', $1)::regclass AND a.grantee <> c.relowner
            ORDER BY 1, 2`,
          [rel],
        )
      ).rows;
      const expected = rel === 'platform_credit_grant_remainders' ? ['INSERT', 'SELECT'] : ['SELECT'];
      expect(
        granted.map((r) => r.priv),
        `${rel}: the table-level grant set`,
      ).toEqual(expected);
      expect(new Set(granted.map((r) => r.grantee)), `${rel}: every grant goes to the one named principal`).toEqual(new Set([AUTHORIZED]));
      expect(
        granted.map((r) => r.priv),
        `${rel}: no principal but the owner holds DELETE`,
      ).not.toContain('DELETE');
      expect(granted.length, `${rel}: the probe returned rows, so its silence about DELETE is a measurement`).toBeGreaterThan(0);
    }

    // The column-level half: UPDATE exists on exactly one column of one relation.
    const upd = (
      await ownerPool().query<{ grantee: string; col: string; priv: string }>(
        `SELECT coalesce(g.rolname, 'PUBLIC')::text AS grantee, att.attname AS col, a.privilege_type AS priv
           FROM pg_attribute att
           CROSS JOIN LATERAL aclexplode(att.attacl) a
           LEFT JOIN pg_roles g ON g.oid = a.grantee
          WHERE att.attrelid = 'public.platform_credit_grant_remainders'::regclass AND att.attnum > 0
          ORDER BY 1, 2, 3`,
      )
    ).rows;
    expect(upd, 'one column-level grant exists, and it is UPDATE on remaining_minor alone').toEqual([
      { grantee: AUTHORIZED, col: 'remaining_minor', priv: 'UPDATE' },
    ]);
  });

  it(`${UNAUTHORIZED} holds no privilege at all on the four relations, per has_table_privilege`, async () => {
    for (const rel of RELATIONS) {
      for (const op of OPERATIONS) {
        const r = (
          await ownerPool().query<{ y: boolean }>(`SELECT has_table_privilege($1, format('public.%I', $2)::regclass, $3) AS y`, [UNAUTHORIZED, rel, op])
        ).rows[0];
        expect(r?.y, `${UNAUTHORIZED} on ${rel}/${op}`).toBe(false);
      }
      // Sightedness of the same probe, on the same relation, in the same run.
      const yes = (
        await ownerPool().query<{ y: boolean }>(`SELECT has_table_privilege($1, format('public.%I', $2)::regclass, 'SELECT') AS y`, [AUTHORIZED, rel])
      ).rows[0];
      expect(yes?.y, `${AUTHORIZED} holds SELECT on ${rel}, so the false answers above are answers`).toBe(true);
    }
  });

  for (const rel of RELATIONS) {
    for (const op of OPERATIONS) {
      it(`${UNAUTHORIZED} is refused ${op} on ${rel}, by a missing privilege and not by a policy`, async () => {
        const a = partyOf('a');
        const c = await connectUnauthorized();
        try {
          const { sql, params } = statementFor(rel, op, a);
          const r = await refusalOf(c, sql, params);
          expect(r.code, `${rel}/${op}: SQLSTATE`).toBe('42501');
          // `42501` is shared by a missing privilege and a policy refusal, so
          // the message shape is what separates them. It must be the former:
          // the privilege check runs before any policy, so a policy could not
          // have been reached.
          expect(classify(r), `${rel}/${op}: the cause`).toBe('privilege');
          expect(r.message, `${rel}/${op}: the relation is named in the refusal`).toContain(rel);
        } finally {
          await c.end();
        }
      });
    }
  }

  for (const rel of RELATIONS) {
    for (const op of OPERATIONS) {
      const isGranted = GRANTED[rel].includes(op);
      it(`${AUTHORIZED} ${isGranted ? 'succeeds in' : 'is refused'} ${op} on ${rel} — the control that makes the refusal above about the role`, async () => {
        const a = partyOf('a');
        const c = await connectAuthorized({ tenantId: a.tenantId, businessId: a.businessId });
        try {
          const { sql, params } = statementFor(rel, op, a);
          if (!isGranted) {
            // The least-privilege claim is per OPERATION, not per role: the
            // authorized principal is refused the operations it was not
            // granted, by the same missing-privilege cause.
            const r = await refusalOf(c, sql, params);
            expect(r.code, `${rel}/${op}: SQLSTATE`).toBe('42501');
            expect(classify(r), `${rel}/${op}: the cause`).toBe('privilege');
            return;
          }
          const res = await c.query(sql, [...params]);
          if (op === 'SELECT') {
            const n = (res.rows[0] as { n?: number } | undefined)?.n;
            expect(typeof n, `${rel}: the authorized SELECT returned a count`).toBe('number');
            expect(n, `${rel}: the authorized principal sees its scope's rows, so the relation is not merely locked for everyone`).toBeGreaterThan(0);
          } else {
            expect(res.rowCount, `${rel}/${op}: the authorized write touched exactly one row`).toBe(1);
          }
        } finally {
          await c.end();
        }
      });
    }
  }

  it(`${AUTHORIZED} is refused an UPDATE of a column it was not granted, on a relation it may update`, async () => {
    // The sharpest discriminator in the file: same role, same relation, same
    // operation, same tenant scope — and the refusal is a missing privilege,
    // because the grant is column-level. Nothing about row security changed.
    const a = partyOf('a');
    const c = await connectAuthorized({ tenantId: a.tenantId, businessId: a.businessId });
    try {
      const r = await refusalOf(c, `UPDATE public.platform_credit_grant_remainders SET granted_minor = granted_minor WHERE grant_id = $1`, [
        a.grants.update_own,
      ]);
      expect(r.code).toBe('42501');
      expect(classify(r)).toBe('privilege');
      const ok = await c.query(`UPDATE public.platform_credit_grant_remainders SET remaining_minor = remaining_minor WHERE grant_id = $1`, [
        a.grants.update_own,
      ]);
      expect(ok.rowCount, 'the granted column on the same row in the same session still updates').toBe(1);
    } finally {
      await c.end();
    }
  });
});

/* ===================================================================== */
/* CONTROL 2 — A TENANT DOES NOT WRITE INTO ANOTHER TENANT'S REMAINDERS  */
/* ===================================================================== */

describe('DR-108-C control 2 — a tenant does not write into another tenant’s remainders', () => {
  /** The INSERT case, one direction. `self` writes its own row; `other`'s row is the refused one. */
  const insertCase = (selfLabel: Label, otherLabel: Label) =>
    it(`tenant ${selfLabel}: an INSERT carrying tenant ${otherLabel}’s ids is refused by WITH CHECK, and its own insert commits`, async () => {
      const self = partyOf(selfLabel);
      const other = partyOf(otherLabel);
      const c = await connectAuthorized({ tenantId: self.tenantId, businessId: self.businessId });
      try {
        // The refused row is fully valid but for its owner: the grant it
        // summarises really is `other`'s, in `other`'s business and currency,
        // and `other`'s remainder row for it was removed by the seeder. So the
        // foreign key is satisfiable and the ONLY thing refusing is the policy.
        const r = await refusalOf(
          c,
          `INSERT INTO public.platform_credit_grant_remainders (tenant_id, business_id, currency, grant_id, granted_minor, remaining_minor)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [other.tenantId, other.businessId, CURRENCY, other.grants.insert_target, GRANT_MINOR.toString()],
        );
        expect(r.code, 'SQLSTATE — shared with a missing privilege, hence the shape check below').toBe('42501');
        expect(classify(r), 'a policy refused the row, not a missing privilege').toBe('policy');
        expect(await remainingAsOwner(other.grants.insert_target), `tenant ${other.label}’s remainder row was not created`).toBeNull();

        // THE POSITIVE CONTROL. The same statement, same session, same
        // privilege — only the owner differs — commits.
        const ok = await c.query(
          `INSERT INTO public.platform_credit_grant_remainders (tenant_id, business_id, currency, grant_id, granted_minor, remaining_minor)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [self.tenantId, self.businessId, CURRENCY, self.grants.insert_own, GRANT_MINOR.toString()],
        );
        expect(ok.rowCount, 'the same INSERT into its own scope commits, so the refusal is about isolation and not about a locked table').toBe(1);
        expect(await remainingAsOwner(self.grants.insert_own), 'and the row is really there, read around every policy').toBe(GRANT_MINOR.toString());
      } finally {
        await c.end();
      }
    });

  /** The UPDATE case, one direction. `USING` blinds it, so there is no error to read — only a row count. */
  const updateCase = (selfLabel: Label, otherLabel: Label) =>
    it(`tenant ${selfLabel}: an UPDATE of tenant ${otherLabel}’s remainder touches no row and changes nothing, while its own updates`, async () => {
      const self = partyOf(selfLabel);
      const other = partyOf(otherLabel);
      const target = other.grants.update_target;
      const before = await remainingAsOwner(target);
      expect(before, `the foreign row exists before the attempt, so "no row touched" is not "no row there"`).toBe(GRANT_MINOR.toString());

      const c = await connectAuthorized({ tenantId: self.tenantId, businessId: self.businessId });
      try {
        // THE THIRD CAUSE, and the one with no SQLSTATE at all: the policy
        // does not refuse the write, it hides the row from it. A case that
        // only asserted "an error was raised" would be red here while the
        // isolation held.
        const blind = await c.query(`UPDATE public.platform_credit_grant_remainders SET remaining_minor = remaining_minor - 1 WHERE grant_id = $1`, [target]);
        expect(blind.rowCount, 'the foreign row is invisible to the decrement').toBe(0);

        // Conservation, as an ABSOLUTE value and not as a difference of two
        // numbers this file computed the same way.
        expect(await remainingAsOwner(target), `tenant ${other.label}’s remainder is still exactly ${GRANT_MINOR.toString()}`).toBe(GRANT_MINOR.toString());

        // THE POSITIVE CONTROL: the same decrement on its own row lands, by one.
        const own = self.grants.update_own;
        const ownBefore = await remainingAsOwner(own);
        expect(ownBefore, 'its own row exists').not.toBeNull();
        const hit = await c.query(`UPDATE public.platform_credit_grant_remainders SET remaining_minor = remaining_minor - 1 WHERE grant_id = $1`, [own]);
        expect(hit.rowCount, 'its own row is visible to the same statement').toBe(1);
        expect(await remainingAsOwner(own), 'and the decrement is exactly one minor unit').toBe((BigInt(ownBefore ?? '0') - 1n).toString());
      } finally {
        await c.end();
      }
    });

  /** The read half, one direction: the remainder policies are tenant-scoped, so a scope sees only its own. */
  const readCase = (selfLabel: Label, otherLabel: Label) =>
    it(`tenant ${selfLabel}: SELECT over the remainders returns its own grant ids and none of tenant ${otherLabel}’s`, async () => {
      const self = partyOf(selfLabel);
      const other = partyOf(otherLabel);
      const c = await connectAuthorized({ tenantId: self.tenantId, businessId: self.businessId });
      try {
        const seen = (await c.query<{ id: string }>(`SELECT grant_id::text AS id FROM public.platform_credit_grant_remainders ORDER BY 1`)).rows.map(
          (r) => r.id,
        );
        expect(seen.length, 'the scope sees rows, so the exclusion below is not an empty relation').toBeGreaterThan(0);
        expect(seen, 'its own read grant is visible').toContain(self.grants.read);
        expect(seen, `tenant ${other.label}’s read grant is not`).not.toContain(other.grants.read);
        expect(seen, `tenant ${other.label}’s update target is not`).not.toContain(other.grants.update_target);
      } finally {
        await c.end();
      }
    });

  // BOTH DIRECTIONS. Isolation that was only ever measured one way is a
  // statement about one fixture's qual, not about the pair.
  insertCase('a', 'b');
  insertCase('b', 'a');
  updateCase('a', 'b');
  updateCase('b', 'a');
  readCase('a', 'b');
  readCase('b', 'a');

  it('the WITH CHECK half of the UPDATE policy is not reachable by the granted principal, and that is stated rather than claimed shut', async () => {
    // `pcgr_accounting_tenant_update` carries both USING and WITH CHECK, so a
    // row cannot be MOVED to another tenant by updating it. This file does not
    // measure that half, and the reason is a privilege and not an oversight:
    // the only UPDATE grant is on `remaining_minor`, so no statement the
    // authorized principal may issue can write `tenant_id` or `business_id`
    // at all. The refusal it gets is `42501` on the column, measured above.
    // Whether a principal should ever be able to reach that half is a
    // MIGRATION OWNER question, not one this file answers.
    const pol = (
      await ownerPool().query<{ cmd: string; qual: string | null; chk: string | null }>(
        `SELECT p.polcmd::text AS cmd, pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
           FROM pg_policy p WHERE p.polname = 'pcgr_accounting_tenant_update'`,
      )
    ).rows[0];
    expect(pol, 'the policy exists').toBeDefined();
    expect(pol?.qual, 'it blinds the read half').not.toBeNull();
    expect(pol?.chk, 'and it guards the write half, unreached by any grant this principal holds').not.toBeNull();
  });
});
