/**
 * P4-S1 — THE PHASE 4 PERMISSION DEFAULTS AND THE DELEGATION CEILING.
 *
 * Lock: P4-AL-35 (the authority matrix), P4-AL-36 (the twelve keys),
 * P4-AL-37 (what "sensitive" means, and that NO accepted constraint enforces
 * it), and the `OD-P4-01` TECH LEAD RULING of 2026-09-30 (OPTION A — the
 * cashier gets only non-sensitive operational permissions by default, and
 * nothing sensitive is a default for ANY built-in role).
 *
 * For each of the twelve keys this suite proves: owner behaviour, manager
 * behaviour, cashier behaviour, custom-role behaviour, the delegation ceiling
 * (`beyondGrantAuthority`), branch scope, second-business denial and
 * second-tenant denial. A cross-tenant or cross-business leak is a BLOCKER.
 *
 * ── Why it drives the frozen writer directly and not the HTTP surface ──────
 *
 * The lock names two writers of `role_permissions`: a migration backfill, and
 * the frozen `provision_create_business` routine fed from
 * `BUILTIN_ROLE_PERMISSIONS`. P4-S1 writes no migration, so the writer that can
 * actually leak a Phase 4 default into every new business is the frozen routine,
 * and this suite calls it exactly as `tenancy.service.ts:257-269` calls it — on
 * the provisioner principal, with a minted assertion and the RLS bypass — with
 * the registry argument taken from the source of truth this slice changed.
 * That also keeps the suite independent of whether `@daftar/domain-core` has
 * been rebuilt, which the HTTP role API would not be.
 *
 * `role_permissions.permission` is a bare `TEXT NOT NULL` with no `CHECK`
 * (`0003_tenancy.sql:35-41`), and the Phase 2 and Phase 3 "no sensitive leak"
 * checks are one-shot migration-time `DO` blocks over their own hard-coded key
 * arrays (`0041:57-65`, `0057:140-151`), not constraints. So for a Phase 4 key
 * the database enforces NOTHING today. §1 proves that gap is real; it is exactly
 * what P4-AL-37 requires the Phase 4 migration's own assertion to close, and
 * this suite is the TypeScript-side half of that contract.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_PERMISSIONS,
  PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  TrustedRoleSet,
  beyondGrantAuthority,
  hasPermission,
  isPermission,
  isSensitivePermission,
  type Permission,
} from '../../packages/domain-core/src/permissions';
import { normalizeIndustryProfileKey } from '../../packages/domain-core/src/industry-profiles';
import { ensurePostgres, mintTestAssertion, ownerPool, provisionerDbUrl, resetData, uniqueEmail } from '../helpers/test-app';

// ── the lock, as data (copied from P4-AL-35/36/37, not read from the registry) ─

const LOCK: readonly (readonly [key: string, sensitive: boolean])[] = [
  ['sales.view', false],
  ['sales.create', false],
  ['sales.void', true],
  ['sales.return', true],
  ['sales.discount', true],
  ['customers.view', false],
  ['customers.manage', false],
  ['payments.collect', false],
  ['payments.reverse', true],
  ['refunds.approve', true],
  ['receivables.view', false],
  ['installments.manage', true],
];
/**
 * The six Phase 4 permission namespaces. Hoisted to a named constant because
 * it is the SCOPE of a claim rather than part of any one assertion, and
 * because the namespaces are the lock's, not this suite's, to choose.
 */
const IN_PHASE4_NAMESPACE = /^(sales|customers|payments|refunds|receivables|installments)\./;

const PHASE4 = LOCK.map(([k]) => k);
const P4_ORDINARY = LOCK.filter(([, s]) => !s).map(([k]) => k);
const P4_SENSITIVE = LOCK.filter(([, s]) => s).map(([k]) => k);

/** The `OD-P4-01` ruling's forbidden-as-a-default list, verbatim. */
const FORBIDDEN_AS_DEFAULT = ['sales.discount', 'sales.void', 'refunds.approve', 'payments.reverse', 'installments.manage'];

/** The defaults the ruling grants. Written out, not derived from the registry. */
const MANAGER_PHASE4 = ['sales.view', 'sales.create', 'customers.view', 'customers.manage', 'payments.collect', 'receivables.view'];
const CASHIER_PHASE4 = ['sales.view', 'sales.create', 'customers.view', 'payments.collect'];

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

let pool: Pool;

interface Biz {
  label: string;
  tenantId: string;
  businessId: string;
  ownerUserId: string;
}

/** A user row, written directly: this suite proves authority, not registration. */
async function makeUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, preferred_locale) VALUES ($1, $2, 'x', 'U', 'ar')`, [id, uniqueEmail()]);
  return id;
}

/**
 * The frozen writer, called exactly as `tenancy.service.ts:257-269` calls it,
 * with the registry this slice changed.
 */
async function provision(label: string, registry: unknown = BUILTIN_ROLE_PERMISSIONS): Promise<Biz> {
  const { biz, finish } = await provisionOpen(label, registry);
  await finish('COMMIT');
  return biz;
}

/**
 * The same call, with the transaction left OPEN so a caller can read the rows
 * back and then ROLL BACK. Used for the counter-proof in §2, which must show
 * that a bad registry WOULD be persisted without actually persisting it.
 */
async function provisionOpen(label: string, registry: unknown): Promise<{ biz: Biz; probe: Client; finish: (how: 'COMMIT' | 'ROLLBACK') => Promise<void> }> {
  const ownerUserId = await makeUser();
  const c = new Client({ connectionString: provisionerDbUrl });
  await c.connect();
  const tenantId = randomUUID();
  const businessId = randomUUID();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.provisioning_assertion', $1, true), set_config('app.bypass_rls', 'true', true)`, [
      mintTestAssertion(ownerUserId, 'onboarding'),
    ]);
    await c.query('SELECT provision_create_tenant($1)', [tenantId]);
    await c.query(`SELECT provision_create_business($1,$2,$3,$4,'PS','ILS',$6,'ar',ARRAY['ar'],'Asia/Hebron',$5,'tenancy.onboarding_completed')`, [
      tenantId,
      businessId,
      `P4 ${label}`,
      `p4perm-${label.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      JSON.stringify(registry),
      normalizeIndustryProfileKey(undefined),
    ]);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    throw e;
  }
  return {
    biz: { label, tenantId, businessId, ownerUserId },
    probe: c,
    finish: async (how) => {
      await c.query(how).catch(() => undefined);
      await c.end();
    },
  };
}

/** A second business inside an EXISTING tenant, through the same frozen writer. */
async function provisionInto(tenant: Biz, label: string): Promise<Biz> {
  const c = new Client({ connectionString: provisionerDbUrl });
  await c.connect();
  const businessId = randomUUID();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.provisioning_assertion', $1, true), set_config('app.bypass_rls', 'true', true)`, [
      mintTestAssertion(tenant.ownerUserId, 'create_business'),
    ]);
    await c.query(`SELECT provision_create_business($1,$2,$3,$4,'PS','ILS',$6,'ar',ARRAY['ar'],'Asia/Hebron',$5,'tenancy.business_created')`, [
      tenant.tenantId,
      businessId,
      `P4 ${label}`,
      `p4perm-${label.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      JSON.stringify(BUILTIN_ROLE_PERMISSIONS),
      normalizeIndustryProfileKey(undefined),
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
  return { label, tenantId: tenant.tenantId, businessId, ownerUserId: tenant.ownerUserId };
}

/**
 * The permissions the writer persisted for a built-in role of a business.
 *
 * Matched on `key`, NOT on `is_system`: the frozen routine sets
 * `is_system := (key = 'owner')` (`0038_provisioning_assertions.sql:232-233`),
 * so only the OWNER template is a system role — `manager` and `cashier` are
 * ordinary rows a merchant may edit or delete. That is why the accepted Phase 3
 * assertion also keys on `r.key = 'manager'` alone (`0057:132`), and why the
 * Phase 4 assertion must do the same rather than on `is_system`.
 */
async function persisted(businessId: string, roleKey: string): Promise<string[]> {
  const r = await pool.query<{ p: string }>(
    `SELECT rp.permission AS p
       FROM role_permissions rp
       JOIN business_roles br ON br.business_id = rp.business_id AND br.id = rp.role_id
      WHERE rp.business_id = $1 AND br.key = $2
      ORDER BY rp.permission`,
    [businessId, roleKey],
  );
  return r.rows.map((x) => x.p);
}

/**
 * The trusted role set a server loads for this user IN THIS BUSINESS, and no
 * other. Authority is `memberships` (one row per business) joined to
 * `membership_roles` (the assigned roles) — both keyed `(business_id, user_id)`
 * — so a business id is part of every lookup and no query shape returns another
 * business's rows.
 */
async function trustedSetFor(userId: string, businessId: string): Promise<TrustedRoleSet> {
  const r = await pool.query<{ key: string; is_system: boolean; perms: string[] | null }>(
    `SELECT br.key, br.is_system,
            (SELECT array_agg(rp.permission) FROM role_permissions rp
              WHERE rp.business_id = br.business_id AND rp.role_id = br.id) AS perms
       FROM memberships m
       JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
       JOIN business_roles br ON br.business_id = mr.business_id AND br.id = mr.role_id
      WHERE m.user_id = $1 AND m.business_id = $2 AND m.status = 'active'
      ORDER BY br.key`,
    [userId, businessId],
  );
  return TrustedRoleSet.fromPersistence(r.rows.map((row) => ({ key: row.key, isSystem: row.is_system, permissions: new Set(row.perms ?? []) })));
}

/** A merchant's own custom role, written as the accepted role API writes it. */
async function customRole(businessId: string, key: string, permissions: readonly string[]): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES ($1, $2, $3, $3, false)`, [businessId, id, key]);
  for (const p of permissions) {
    await pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)`, [businessId, id, p]);
  }
  return id;
}

/**
 * A member of ONE business with ONE role, as the accepted member API writes it:
 * a tenant membership, a business membership, and a `membership_roles` row —
 * each keyed to the tenant or business it belongs to.
 */
async function addMember(biz: Biz, userId: string, roleId: string): Promise<void> {
  await pool.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member') ON CONFLICT DO NOTHING`, [
    biz.tenantId,
    userId,
  ]);
  await pool.query(`INSERT INTO memberships (business_id, user_id, tenant_id) VALUES ($1, $2, $3)`, [biz.businessId, userId, biz.tenantId]);
  await pool.query(`INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)`, [biz.businessId, userId, roleId]);
}

/** A / A2: two businesses of ONE tenant. B: a business of a DIFFERENT tenant. */
let A: Biz;
let A2: Biz;
let B: Biz;
/** The custom role in A that holds all twelve keys, and its member. */
let salesAdminRoleId: string;
let salesAdminUserId: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  A = await provision('A');
  A2 = await provisionInto(A, 'A2');
  B = await provision('B');
  expect(B.tenantId).not.toBe(A.tenantId);
  salesAdminRoleId = await customRole(A.businessId, 'sales-admin', PHASE4);
  salesAdminUserId = await makeUser();
  await addMember(A, salesAdminUserId, salesAdminRoleId);
}, 120_000);

afterAll(async () => {
  await resetData();
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 The twelve keys, and the enforcement gap P4-AL-37 names.
// ─────────────────────────────────────────────────────────────────────────────

describe('§1 P4-S1 the twelve keys and the enforcement gap', () => {
  it('all twelve are registered and classified exactly as the lock classifies them', () => {
    for (const [key, sensitive] of LOCK) {
      expect(isPermission(key), key).toBe(true);
      expect(isSensitivePermission(key as Permission), key).toBe(sensitive);
    }
    // P4-AL-88: this is the one genuinely forward-looking equality of the five.
    // `PERMISSIONS` filtered by the Phase 4 namespaces is a set LATER PHASE 4
    // SLICES GROW — P4-S4 registers the payment keys, P4-S5 the credit-note
    // ones — so requiring it to EQUAL P4-S1's twelve would make this suite red
    // for the success of the slice that follows it, which is precisely the
    // disease P4-AL-88 names.
    //
    // Every one of the twelve is still required BY NAME, so none can be
    // dropped or renamed. What the equality additionally bought — "and the
    // registry holds no thirteenth Phase 4 key" — is a true statement about
    // P4-S1 and a false one about P4-S4, so it is not asserted here in any
    // tense. It is not lost either: it is asserted in the one place in the
    // estate allowed to carry a claim the acceptance commit deletes, the
    // `CANDIDATE-TENSE (P4-AL-61)` fence of `scripts/phase4-s1-gate.ts`. An
    // allowlist of the later slices' names was deliberately NOT used: the lock
    // (§17.3) rejects it, because "these exist and that is fine" asserts
    // nothing.
    expect(sorted(PERMISSIONS.filter((p) => IN_PHASE4_NAMESPACE.test(p)))).toEqual(expect.arrayContaining(sorted(PHASE4)));
    expect(PHASE4).toHaveLength(12);
    expect(sorted(SENSITIVE_PERMISSIONS.filter((p) => PHASE4.includes(p)))).toEqual(sorted(P4_SENSITIVE));
    expect(P4_ORDINARY).toHaveLength(6);
    expect(P4_SENSITIVE).toHaveLength(6);
  });

  it('role_permissions.permission carries no CHECK, so the database binds no Phase 4 key at all', async () => {
    const cks = await pool.query<{ n: string }>(
      `SELECT conname::text AS n FROM pg_constraint WHERE conrelid = 'public.role_permissions'::regclass AND contype = 'c'`,
    );
    expect(cks.rows.map((r) => r.n)).toEqual([]);
  });

  it('nothing in the database refuses a sensitive Phase 4 default on the cashier — the gap P4-AL-37 must close', async () => {
    const r = await pool.query<{ id: string }>(`SELECT id::text FROM business_roles WHERE business_id = $1 AND key = 'cashier'`, [B.businessId]);
    const roleId = r.rows[0]?.id ?? '';
    expect(roleId).toBeTruthy();
    const c = await pool.connect();
    try {
      // Inside a transaction that is ALWAYS rolled back, so the gap is
      // demonstrated without leaving the leak behind.
      await c.query('BEGIN');
      await c.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'sales.void')`, [B.businessId, roleId]);
      const leaked = await c.query<{ p: string }>(
        `SELECT permission AS p FROM role_permissions WHERE business_id = $1 AND role_id = $2 AND permission = 'sales.void'`,
        [B.businessId, roleId],
      );
      expect(
        leaked.rows.map((x) => x.p),
        'the database accepted a sensitive default: nothing refuses it',
      ).toEqual(['sales.void']);
      // It does not even refuse a key that is not in the registry.
      await c.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'not.a.permission')`, [B.businessId, roleId]);
      expect(isPermission('not.a.permission')).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await persisted(B.businessId, 'cashier')).not.toContain('sales.void');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 The built-in defaults, as the frozen writer actually persisted them.
// ─────────────────────────────────────────────────────────────────────────────

describe('§2 P4-S1 built-in defaults, as persisted by the frozen provisioning writer', () => {
  it('owner: every one of the twelve, persisted, and total authority by identity', async () => {
    const rows = await persisted(A.businessId, 'owner');
    for (const key of PHASE4) expect(rows, `owner / ${key}`).toContain(key);
    expect(sorted(rows)).toEqual(sorted(PERMISSIONS));
    const set = await trustedSetFor(A.ownerUserId, A.businessId);
    for (const key of PHASE4) expect(hasPermission(set, key as Permission), key).toBe(true);
    expect(beyondGrantAuthority(set, PHASE4 as Permission[])).toEqual([]);
  });

  it('manager: exactly the six ORDINARY keys among the twelve, and no sensitive one', async () => {
    const rows = await persisted(A.businessId, 'manager');
    expect(sorted(rows.filter((p) => PHASE4.includes(p)))).toEqual(sorted(MANAGER_PHASE4));
    expect(sorted(MANAGER_PHASE4)).toEqual(sorted(P4_ORDINARY));
    for (const key of P4_SENSITIVE) expect(rows, `manager / ${key}`).not.toContain(key);
    expect(sorted(rows)).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.manager));
  });

  it('cashier: exactly the four ORDINARY till keys, no sensitive one, and NOT receivables.view', async () => {
    const rows = await persisted(A.businessId, 'cashier');
    expect(sorted(rows.filter((p) => PHASE4.includes(p)))).toEqual(sorted(CASHIER_PHASE4));
    for (const key of CASHIER_PHASE4) expect(isSensitivePermission(key as Permission), key).toBe(false);
    for (const key of FORBIDDEN_AS_DEFAULT) expect(rows, `cashier / ${key}`).not.toContain(key);
    // A credit sale is `sales.create` + `receivables.view` (P4-AL-35): the
    // second half is a delegation, not a default.
    expect(rows).not.toContain('receivables.view');
    expect(sorted(rows)).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.cashier));
  });

  it('the P4-AL-37 assertion, computed here over every business: no built-in role holds a sensitive Phase 4 key', async () => {
    const r = await pool.query<{ b: string; k: string; p: string }>(
      `SELECT rp.business_id::text AS b, br.key AS k, rp.permission AS p
         FROM role_permissions rp
         JOIN business_roles br ON br.business_id = rp.business_id AND br.id = rp.role_id
        WHERE rp.permission = ANY ($1) AND br.key = ANY (ARRAY['manager', 'cashier'])
        ORDER BY 1, 2, 3`,
      [P4_SENSITIVE],
    );
    expect(r.rows.map((x) => `${x.k}:${x.p}`)).toEqual([]);
  });

  it('the manager set is exactly the Phase 1 + Phase 3 + Phase 4 concatenation, in order, in the database too', async () => {
    const r = await pool.query<{ p: string }>(
      `SELECT rp.permission AS p FROM role_permissions rp
         JOIN business_roles br ON br.business_id = rp.business_id AND br.id = rp.role_id
        WHERE rp.business_id = $1 AND br.key = 'manager'`,
      [A.businessId],
    );
    // Order is not a property of a table, so the ORDER is asserted on the
    // registry and the CONTENTS on the table — together they pin both.
    expect([...BUILTIN_ROLE_PERMISSIONS.manager].slice(-MANAGER_PHASE4.length)).toEqual(MANAGER_PHASE4);
    expect(sorted(r.rows.map((x) => x.p))).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.manager));
  });

  it('every business the writer provisions gets the identical defaults — first onboarding AND the second-business path', async () => {
    for (const roleKey of ['owner', 'manager', 'cashier'] as const) {
      expect(sorted(await persisted(A2.businessId, roleKey)), `A2/${roleKey}`).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS[roleKey]));
      expect(sorted(await persisted(B.businessId, roleKey)), `B/${roleKey}`).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS[roleKey]));
      expect(sorted(await persisted(A.businessId, roleKey)), `A/${roleKey}`).toEqual(sorted(await persisted(A2.businessId, roleKey)));
    }
  });

  it('the frozen writer applies NO policy of its own: it persists whatever registry it is handed, verbatim', async () => {
    // The counter-proof for §2, read out of the frozen routine itself rather
    // than by provisioning a deliberately broken business.
    //
    // `provision_create_business` loops over the registry JSON and inserts every
    // element of every array, with no filter, no allowlist and no sensitivity
    // check (`0038_provisioning_assertions.sql:231-235`). So a registry that
    // granted `sales.void` to the cashier WOULD reach `role_permissions` in
    // every new business. Nothing downstream would refuse it either: §1 proved
    // `role_permissions` carries no CHECK. `BUILTIN_ROLE_PERMISSIONS` and the
    // Phase 4 migration's own assertion (P4-AL-37) are therefore the ONLY two
    // things holding the `OD-P4-01` line, which is exactly why this slice pins
    // the registry and specifies that assertion.
    const r = await pool.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'provision_create_business'`);
    expect(r.rows, 'the frozen writer exists exactly once').toHaveLength(1);
    const src = r.rows[0]?.src ?? '';
    // It reads every key of the registry and inserts every element of its array.
    expect(src).toMatch(/jsonb_each\s*\(\s*p_role_permissions\s*\)/);
    expect(src).toMatch(/INSERT INTO role_permissions[\s\S]{0,200}jsonb_array_elements_text\s*\(\s*v_perms\s*\)/);
    // And it filters nothing: no mention of any sensitive key, of a sensitivity
    // notion, or of any allowlist of permissions.
    for (const key of P4_SENSITIVE) expect(src, `the writer must not know about ${key}`).not.toContain(key);
    expect(src.toLowerCase()).not.toContain('sensitive');
    // Only the OWNER template is a system role, which is why `persisted()` keys
    // on `key` and not on `is_system`.
    expect(src).toMatch(/is_system\s*\)?[\s\S]{0,120}v_key\s*=\s*'owner'/);
    // And the provisioner principal holds NO direct privilege on
    // `role_permissions` at all — not even INSERT: every write goes through this
    // SECURITY DEFINER routine (`0032_provisioner_narrow_functions.sql` narrowed
    // what `0030:29` first granted). So the routine body above is the whole of
    // the writer, and there is no application-side or grant-side filter that
    // could be refusing a sensitive default on its behalf.
    const priv = await pool.query<{ ins: boolean; sel: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('daftar_provisioner', 'public.role_permissions', 'INSERT') AS ins,
              has_table_privilege('daftar_provisioner', 'public.role_permissions', 'SELECT') AS sel,
              has_table_privilege('daftar_provisioner', 'public.role_permissions', 'UPDATE') AS upd,
              has_table_privilege('daftar_provisioner', 'public.role_permissions', 'DELETE') AS del`,
    );
    expect(priv.rows[0]).toEqual({ ins: false, sel: false, upd: false, del: false });
    // The routine is the definer that does hold the authority.
    const def = await pool.query<{ sd: boolean }>(`SELECT prosecdef AS sd FROM pg_proc WHERE proname = 'provision_create_business'`);
    expect(def.rows[0]?.sd, 'provision_create_business is SECURITY DEFINER').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 Custom roles and the delegation ceiling, key by key.
// ─────────────────────────────────────────────────────────────────────────────

describe('§3 P4-S1 custom roles and the delegation ceiling over the twelve keys', () => {
  it('a pre-existing custom role gains nothing from the twelve new registry entries', async () => {
    const roleId = await customRole(A.businessId, 'stock-clerk', ['catalog.view', 'catalog.update']);
    const user = await makeUser();
    await addMember(A, user, roleId);
    const set = await trustedSetFor(user, A.businessId);
    for (const key of PHASE4) expect(hasPermission(set, key as Permission), key).toBe(false);
    expect(beyondGrantAuthority(set, PHASE4 as Permission[])).toEqual([...PHASE4]);
  });

  it('the ceiling, key by key, for each built-in role — computed from the rows the writer persisted', async () => {
    const managerSet = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: true, permissions: new Set(await persisted(A.businessId, 'manager')) }]);
    const cashierSet = TrustedRoleSet.fromPersistence([{ key: 'cashier', isSystem: true, permissions: new Set(await persisted(A.businessId, 'cashier')) }]);
    for (const key of PHASE4) {
      const k = key as Permission;
      expect(hasPermission(managerSet, k), `manager holds ${key}`).toBe(MANAGER_PHASE4.includes(key));
      expect(hasPermission(cashierSet, k), `cashier holds ${key}`).toBe(CASHIER_PHASE4.includes(key));
      expect(beyondGrantAuthority(managerSet, [k]), `manager delegating ${key}`).toEqual(MANAGER_PHASE4.includes(key) ? [] : [key]);
      expect(beyondGrantAuthority(cashierSet, [k]), `cashier delegating ${key}`).toEqual(CASHIER_PHASE4.includes(key) ? [] : [key]);
    }
    // No built-in non-owner role can delegate ANY sensitive Phase 4 key.
    expect(beyondGrantAuthority(managerSet, P4_SENSITIVE as Permission[])).toEqual(P4_SENSITIVE);
    expect(beyondGrantAuthority(cashierSet, P4_SENSITIVE as Permission[])).toEqual(P4_SENSITIVE);
    // The cashier cannot delegate the credit-sale half it does not hold.
    expect(beyondGrantAuthority(cashierSet, ['receivables.view'] as Permission[])).toEqual(['receivables.view']);
  });

  it('a delegated sensitive key may be passed on, and only that one — the ceiling is what you hold, not who you are', async () => {
    const roleId = await customRole(A.businessId, 'till-lead', ['sales.view', 'sales.create', 'sales.discount', 'payments.collect']);
    const user = await makeUser();
    await addMember(A, user, roleId);
    const set = await trustedSetFor(user, A.businessId);
    expect(hasPermission(set, 'sales.discount')).toBe(true);
    expect(beyondGrantAuthority(set, ['sales.discount', 'sales.view'] as Permission[])).toEqual([]);
    expect(beyondGrantAuthority(set, P4_SENSITIVE.filter((k) => k !== 'sales.discount') as Permission[])).toEqual(
      P4_SENSITIVE.filter((k) => k !== 'sales.discount'),
    );
    expect(beyondGrantAuthority(set, ['receivables.view', 'customers.manage'] as Permission[])).toEqual(['receivables.view', 'customers.manage']);
  });

  it('the owner is exempt by IDENTITY, and a forged owner row is not', async () => {
    const owner = await trustedSetFor(A.ownerUserId, A.businessId);
    expect(beyondGrantAuthority(owner, PHASE4 as Permission[])).toEqual([]);
    const fakeOwner = TrustedRoleSet.fromPersistence([{ key: 'owner', isSystem: false, permissions: new Set() }]);
    expect(beyondGrantAuthority(fakeOwner, PHASE4 as Permission[])).toEqual([...PHASE4]);
    for (const key of PHASE4) expect(hasPermission(fakeOwner, key as Permission), key).toBe(false);
    // A system role that is not keyed `owner` is not the owner either.
    const systemManager = TrustedRoleSet.fromPersistence([{ key: 'manager', isSystem: true, permissions: new Set() }]);
    expect(beyondGrantAuthority(systemManager, PHASE4 as Permission[])).toEqual([...PHASE4]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 Branch scope.
// ─────────────────────────────────────────────────────────────────────────────

describe('§4 P4-S1 branch scope over the Phase 4 keys', () => {
  it('a member scoped to one branch holds the till keys, and the scope row names one business and one branch', async () => {
    const branches = await pool.query<{ id: string }>(`SELECT id::text FROM branches WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [A.businessId]);
    const branchId = branches.rows[0]?.id ?? '';
    expect(branchId, 'the provisioned business has a branch').toBeTruthy();

    const roleId = await customRole(A.businessId, 'till', CASHIER_PHASE4);
    const user = await makeUser();
    await addMember(A, user, roleId);
    await pool.query(`INSERT INTO member_branch_scopes (business_id, user_id, branch_id) VALUES ($1, $2, $3)`, [A.businessId, user, branchId]);

    const rows = await pool.query<{ b: string; br: string }>(
      `SELECT business_id::text AS b, branch_id::text AS br FROM member_branch_scopes WHERE user_id = $1 ORDER BY 1, 2`,
      [user],
    );
    expect(rows.rows.map((r) => `${r.b}/${r.br}`)).toEqual([`${A.businessId}/${branchId}`]);

    const here = await trustedSetFor(user, A.businessId);
    for (const key of CASHIER_PHASE4) expect(hasPermission(here, key as Permission), `scoped member / ${key}`).toBe(true);
    for (const key of P4_SENSITIVE) expect(hasPermission(here, key as Permission), `scoped member / ${key}`).toBe(false);
    // The scope narrows WITHIN a business; it never widens across one.
    const elsewhere = await trustedSetFor(user, A2.businessId);
    for (const key of PHASE4) expect(hasPermission(elsewhere, key as Permission), `scoped member in A2 / ${key}`).toBe(false);
  });

  it('a branch scope cannot name another business branch — the composite FK refuses it', async () => {
    const other = await pool.query<{ id: string }>(`SELECT id::text FROM branches WHERE business_id = $1 LIMIT 1`, [B.businessId]);
    const foreignBranch = other.rows[0]?.id ?? '';
    expect(foreignBranch).toBeTruthy();
    const roleId = await customRole(A.businessId, 'till-2', CASHIER_PHASE4);
    const user = await makeUser();
    await addMember(A, user, roleId);
    await expect(
      pool.query(`INSERT INTO member_branch_scopes (business_id, user_id, branch_id) VALUES ($1, $2, $3)`, [A.businessId, user, foreignBranch]),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 Second business and second tenant. A leak here is a BLOCKER.
// ─────────────────────────────────────────────────────────────────────────────

describe('§5 P4-S1 second-business and second-tenant denial over every Phase 4 key (BLOCKER class)', () => {
  it('the holder of all twelve in A holds none of them in the sibling business of the SAME tenant', async () => {
    const inA = await trustedSetFor(salesAdminUserId, A.businessId);
    for (const key of PHASE4) expect(hasPermission(inA, key as Permission), `granted in A / ${key}`).toBe(true);
    const inA2 = await trustedSetFor(salesAdminUserId, A2.businessId);
    for (const key of PHASE4) expect(hasPermission(inA2, key as Permission), `BLOCKER: ${key} leaked into the sibling business`).toBe(false);
    const m = await pool.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2`, [salesAdminUserId, A2.businessId]);
    expect(m.rowCount, 'no membership row in the sibling business').toBe(0);
    // The role itself does not exist there, so there is nothing to inherit.
    const roles = await pool.query<{ k: string }>(`SELECT key AS k FROM business_roles WHERE business_id = $1 ORDER BY key`, [A2.businessId]);
    expect(roles.rows.map((r) => r.k)).not.toContain('sales-admin');
  });

  it('and none of them in a business of a DIFFERENT tenant', async () => {
    const inB = await trustedSetFor(salesAdminUserId, B.businessId);
    for (const key of PHASE4) expect(hasPermission(inB, key as Permission), `BLOCKER: ${key} leaked into tenant B`).toBe(false);
    const m = await pool.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2`, [salesAdminUserId, B.businessId]);
    expect(m.rowCount, 'no membership row in the other tenant').toBe(0);
    const t = await pool.query(`SELECT 1 FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2`, [salesAdminUserId, B.tenantId]);
    expect(t.rowCount, 'no tenant membership in the other tenant').toBe(0);
  });

  it('no sensitive Phase 4 key exists anywhere outside the role that was explicitly granted it', async () => {
    const r = await pool.query<{ b: string; k: string; p: string }>(
      `SELECT rp.business_id::text AS b, br.key AS k, rp.permission AS p
         FROM role_permissions rp
         JOIN business_roles br ON br.business_id = rp.business_id AND br.id = rp.role_id
        WHERE rp.permission = ANY ($1) AND NOT (br.is_system AND br.key = 'owner')
        ORDER BY 1, 2, 3`,
      [P4_SENSITIVE],
    );
    // Exactly the two custom roles this suite granted, in A and nowhere else.
    const expected = [...P4_SENSITIVE.map((p) => `${A.businessId}|sales-admin|${p}`), `${A.businessId}|till-lead|sales.discount`].sort();
    expect(r.rows.map((x) => `${x.b}|${x.k}|${x.p}`).sort()).toEqual(expected);
  });

  it('the composite FK makes a cross-business Phase 4 grant physically impossible, not merely refused', async () => {
    // `role_permissions` is keyed (business_id, role_id) with a composite FK to
    // `business_roles(business_id, id)` (`0003_tenancy.sql:35-41`), so A2 cannot
    // borrow A's role id, and no membership can point across a business.
    await expect(
      pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'sales.void')`, [A2.businessId, salesAdminRoleId]),
    ).rejects.toThrow(/foreign key|violates/i);
    // And `membership_roles(business_id, role_id)` refuses a role from another
    // business, so a role holding the twelve keys cannot be assigned across one.
    await expect(
      pool.query(`INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)`, [B.businessId, B.ownerUserId, salesAdminRoleId]),
    ).rejects.toThrow(/foreign key|violates/i);
    await expect(
      pool.query(`INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)`, [A2.businessId, A2.ownerUserId, salesAdminRoleId]),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
