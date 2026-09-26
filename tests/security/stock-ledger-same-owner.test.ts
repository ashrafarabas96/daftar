/**
 * P3-S2 — STOCK-LEDGER ISOLATION BETWEEN TWO BUSINESSES OF THE SAME TENANT
 * WITH THE SAME OWNER (docs/PHASE_3_S2_CONTRACT.md §2.6, §5, T-16, T-18).
 *
 * stock-ledger-authority.test.ts proves T-16/T-18 against a business B of
 * ANOTHER tenant, where the permissive `tenant_membership` policy alone
 * already hides B. Here A2 shares A's tenant AND A's owner, who is also the
 * signed actor: `tenant_membership` admits both, and the actor legitimately
 * holds authority in both. Only the restrictive `business_isolation` policy,
 * the composite FKs and the routines' business binding can keep them apart —
 * the P3-S1 precedent is inventory-tenant-isolation.test.ts.
 *
 * Every DENY is paired with an ALLOW of the same shape, with only the business
 * of one identifier changed. Every case runs in a rolled-back fixture
 * transaction (A-11).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  FIXTURE_OP,
  INTERNAL,
  addVariantProduct,
  applyOne,
  assertMigrationState,
  attempt,
  expectAccepted,
  expectConstraint,
  expectRefused,
  mintFixtureAssertion,
  must,
  req,
  requestsJson,
  requestsParam,
  scratch,
  seedSameOwnerBusiness,
  seedStockBusiness,
  setScope,
  tryApply,
  withRolledBackFixture,
  type Key,
  type MovementRequest,
  type MovementRow,
  type Queryable,
  type SameOwnerBusiness,
  type Scope,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;
let a2: SameOwnerBusiness;
/** Business A as a scope (the owner is the actor). */
let A: Scope;
/** Business A2: the same tenant, the same owner. */
let A2: Scope;
let KA: Key;
let KA2: Key;
/** A tracked variant product of A and of A2 with one merchant variant each: a legitimate reparent target. */
let targetA: string;
let targetA2: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'sameowner');
  a2 = await seedSameOwnerBusiness(ownerPool(), biz, 'sameowner');
  A = { tenantId: biz.tenantId, businessId: biz.businessId, userId: biz.userId };
  A2 = { tenantId: a2.tenantId, businessId: a2.businessId, userId: a2.userId };
  KA = { warehouseId: biz.warehouse1, variantId: biz.piece.variantId };
  KA2 = { warehouseId: a2.warehouseId, variantId: a2.piece.variantId };
  targetA = (await addVariantProduct(ownerPool(), A, 1)).productId;
  targetA2 = (await addVariantProduct(ownerPool(), A2, 1)).productId;
});

afterAll(async () => {
  await assertMigrationState();
});

const purchase = (key: Key, qty = '1', over: Partial<MovementRequest> = {}) => req(key, 'purchase', qty, { unitCost: '1', ...over });

/** One movement in A and one in A2, both signed by the same owner, in the caller's transaction. */
async function bothBusinesses(c: Client): Promise<void> {
  await applyOne(c, A, purchase(KA, '4', { unitCost: '2' }));
  await applyOne(c, A2, purchase(KA2, '7', { unitCost: '3' }));
}

async function levelCount(c: Queryable, businessId: string): Promise<number> {
  return must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_levels WHERE business_id = $1`, [businessId])).rows[0]).n;
}

describe('the premise: A and A2 are two businesses of ONE tenant with ONE owner', () => {
  it('the same user holds the tenant_owner link and the system owner role of both businesses, and signs for both', async () => {
    expect(A.tenantId).toBe(A2.tenantId);
    expect(A.businessId).not.toBe(A2.businessId);
    expect(A.userId).toBe(A2.userId);
    const r = await ownerPool().query<{ b: string; t: string }>(
      `SELECT mr.business_id::text AS b, b.tenant_id::text AS t
         FROM membership_roles mr
         JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id AND r.is_system AND r.key = 'owner'
         JOIN memberships m ON m.business_id = mr.business_id AND m.user_id = mr.user_id AND m.status = 'active'
         JOIN businesses b ON b.id = mr.business_id
         JOIN tenant_memberships tm ON tm.tenant_id = b.tenant_id AND tm.user_id = mr.user_id AND tm.role_key = 'tenant_owner'
        WHERE mr.user_id = $1 ORDER BY 1`,
      [biz.userId],
    );
    expect(r.rows).toEqual(
      [
        { b: A.businessId, t: A.tenantId },
        { b: A2.businessId, t: A.tenantId },
      ].sort((x, y) => x.b.localeCompare(y.b)),
    );
  });
});

describe('T-18.1 (same owner) — daftar_app reads', () => {
  async function asAppSees(c: Client, scope: { tenantId: string; businessId: string }, rel: string): Promise<string[]> {
    await setScope(c, scope);
    await c.query('SET LOCAL ROLE daftar_app');
    const r = await c.query<{ b: string }>(`SELECT DISTINCT business_id::text AS b FROM ${rel} ORDER BY 1`);
    await c.query('RESET ROLE');
    return r.rows.map((x) => x.b);
  }

  it('ALLOW/DENY: scoped to A it reads only A’s movements and cache rows; scoped to A2 only A2’s', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      for (const rel of ['stock_movements', 'stock_levels']) {
        expect(await asAppSees(c, A, rel), `${rel} as A`).toEqual([A.businessId]);
        expect(await asAppSees(c, A2, rel), `${rel} as A2`).toEqual([A2.businessId]);
      }
    });
  });

  it('DENY: a split scope reads nothing — the shared tenant with no business, with another tenant’s business, or A’s business under another tenant', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      for (const rel of ['stock_movements', 'stock_levels']) {
        expect(await asAppSees(c, { tenantId: A.tenantId, businessId: '' }, rel), `${rel}: tenant only`).toEqual([]);
        expect(await asAppSees(c, { tenantId: A.tenantId, businessId: biz.other.businessId }, rel), `${rel}: foreign business`).toEqual([]);
        expect(await asAppSees(c, { tenantId: biz.other.tenantId, businessId: A2.businessId }, rel), `${rel}: A2 under another tenant`).toEqual([]);
      }
    });
  });

  it('control: with row security disabled in-transaction, the same read scoped to A sees A2’s rows — the restrictive policy is what isolates', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      for (const rel of ['stock_movements', 'stock_levels']) {
        await scratch(c, async () => {
          // ALTER TABLE refuses while deferred checks are pending; they pass, so run them first.
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          await c.query(`ALTER TABLE ${rel} DISABLE ROW LEVEL SECURITY`);
          expect(await asAppSees(c, A, rel)).toEqual([A.businessId, A2.businessId].sort());
        });
      }
    });
  });
});

describe('T-16.5 / T-16.6 (same owner) — R3 through the fixture producer', () => {
  const callR3 = (c: Queryable, requests: readonly MovementRequest[]) =>
    attempt(c, async () => (await c.query<MovementRow>(`SELECT * FROM inventory_apply_stock_movements(${requestsParam(1)})`, [requestsJson(requests)])).rows);

  const signedFor = (s: Scope, nonce: string, jti?: string) =>
    mintFixtureAssertion({
      opCode: FIXTURE_OP,
      actorUserId: s.userId,
      tenantId: s.tenantId,
      businessId: s.businessId,
      nonce,
      ...(jti === undefined ? {} : { jti }),
    });

  it.each([
    ['A', 'A2'],
    ['A2', 'A'],
  ])('DENY: an assertion signed for %s used under scope %s → inventory.assertion_scope_mismatch, nothing written', async (signed, used) => {
    await withRolledBackFixture(async (c) => {
      const [s, u, key] = signed === 'A' ? [A, A2, KA2] : [A2, A, KA];
      const nonce = randomUUID();
      expectRefused(
        await tryApply(c, u, [purchase(key)], { assertion: signedFor(s, nonce), nonce }),
        'P0001',
        'inventory.assertion_scope_mismatch',
        `${signed} under ${used}`,
      );
      expect(await levelCount(c, A.businessId)).toBe(0);
      expect(await levelCount(c, A2.businessId)).toBe(0);
    });
  });

  it('ALLOW: the same call with each assertion under its own business’s scope writes', async () => {
    await withRolledBackFixture(async (c) => {
      for (const [s, key] of [
        [A, KA],
        [A2, KA2],
      ] as const) {
        const nonce = randomUUID();
        const rows = expectAccepted(await tryApply(c, s, [purchase(key)], { assertion: signedFor(s, nonce), nonce }), s.businessId);
        expect(rows.map((x) => [x.warehouse_id, x.variant_id, x.stock_seq])).toEqual([[key.warehouseId, key.variantId, '1']]);
      }
    });
  });

  it('DENY/ALLOW: R3 called directly with A’s carrier and a uses row for this transaction — under scope A2 → inventory.assertion_scope_mismatch; under scope A it writes', async () => {
    await withRolledBackFixture(async (c) => {
      const jti = randomUUID();
      await c.query(`INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id) VALUES ($1, pg_current_xact_id(), $2, $3)`, [
        jti,
        FIXTURE_OP,
        A.businessId,
      ]);
      await c.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [signedFor(A, randomUUID(), jti)]);
      await setScope(c, A2);
      expectRefused(await callR3(c, [purchase(KA2)]), 'P0001', 'inventory.assertion_scope_mismatch', 'under A2');
      await scratch(c, async () => {
        await setScope(c, A);
        expect(expectAccepted(await callR3(c, [purchase(KA)]), 'under A')).toHaveLength(1);
      });
    });
  });

  it.each([
    ['A', 'A2'],
    ['A2', 'A'],
  ])(
    'DENY: %s’s verified assertion naming %s’s warehouse → inventory.warehouse_not_found; its variant → inventory.variant_not_found; nothing written',
    async (own) => {
      await withRolledBackFixture(async (c) => {
        const [s, mine, theirs] = own === 'A' ? [A, KA, KA2] : [A2, KA2, KA];
        expectRefused(
          await tryApply(c, s, [purchase({ warehouseId: theirs.warehouseId, variantId: mine.variantId })]),
          'P0001',
          'inventory.warehouse_not_found',
        );
        expectRefused(await tryApply(c, s, [purchase({ warehouseId: mine.warehouseId, variantId: theirs.variantId })]), 'P0001', 'inventory.variant_not_found');
        expectRefused(await tryApply(c, s, [purchase(theirs)]), 'P0001', 'inventory.warehouse_not_found');
        expect(await levelCount(c, A.businessId)).toBe(0);
        expect(await levelCount(c, A2.businessId)).toBe(0);
      });
    },
  );

  it('ALLOW: the same request with each business’s own warehouse and variant writes in that business only', async () => {
    await withRolledBackFixture(async (c) => {
      expectAccepted(await tryApply(c, A, [purchase(KA)]), 'A');
      expect([await levelCount(c, A.businessId), await levelCount(c, A2.businessId)]).toEqual([1, 0]);
      expectAccepted(await tryApply(c, A2, [purchase(KA2)]), 'A2');
      expect([await levelCount(c, A.businessId), await levelCount(c, A2.businessId)]).toEqual([1, 1]);
    });
  });
});

describe('T-18.4 / T-18.5 (same owner) — raw writes as the internal role, scoped to A', () => {
  /** As the internal role under scope A, in a savepoint. */
  const asInternalInA = <T>(c: Queryable, run: () => Promise<T>) =>
    attempt(c, async () => {
      await setScope(c, A);
      await c.query(`SET LOCAL ROLE ${INTERNAL}`);
      const out = await run();
      await c.query('RESET ROLE');
      return out;
    });

  const insertLevel = (c: Queryable, businessId: string, key: Key) =>
    asInternalInA(c, () =>
      c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
        A.tenantId,
        businessId,
        key.warehouseId,
        key.variantId,
      ]),
    );

  const insertBinding = (c: Queryable, businessId: string) =>
    asInternalInA(c, () =>
      c.query(
        `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, 'fixture_line', $3, $4, 'purchase')`,
        [A.tenantId, businessId, randomUUID(), randomUUID()],
      ),
    );

  const insertMovement = (c: Queryable, businessId: string, key: Key) =>
    asInternalInA(c, () =>
      c.query(
        `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
                                      qty_delta, unit_cost_base_minor, value_delta_base_minor, actor_user_id)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, 1, 'purchase', 'fixture_line', gen_random_uuid(), gen_random_uuid(), 1, 1, 1, $5)`,
        [A.tenantId, businessId, key.warehouseId, key.variantId, A.userId],
      ),
    );

  it('DENY: an A2 cache row, binding or movement — the shared tenant passes tenant_membership, the restrictive WITH CHECK refuses (42501)', async () => {
    await withRolledBackFixture(async (c) => {
      expectRefused(await insertLevel(c, A2.businessId, KA2), '42501', null, 'A2 cache row');
      expectRefused(await insertBinding(c, A2.businessId), '42501', null, 'A2 binding');
      // The movement's own key row exists in A2 (written by A2's own authority), so only the policy can refuse.
      await applyOne(c, A2, purchase(KA2));
      expectRefused(await insertMovement(c, A2.businessId, KA2), '42501', null, 'A2 movement');
      expect(await levelCount(c, A2.businessId)).toBe(1);
    });
  });

  it('ALLOW: the same cache row, binding and movement in A are accepted', async () => {
    await withRolledBackFixture(async (c) => {
      expectAccepted(await insertLevel(c, A.businessId, KA), 'A cache row');
      expectAccepted(await insertBinding(c, A.businessId), 'A binding');
      expectAccepted(await insertMovement(c, A.businessId, KA), 'A movement');
    });
  });

  it('control: relaxing ONLY business_isolation’s WITH CHECK in-transaction lets the A2 cache row in — for a same-tenant business it is the one policy that stands', async () => {
    await withRolledBackFixture(async (c) => {
      await scratch(c, async () => {
        await c.query(
          `ALTER POLICY business_isolation ON stock_levels WITH CHECK (app_bypass() OR current_user = '${INTERNAL}' OR business_id = nullif(app_business(), '')::uuid)`,
        );
        expectAccepted(await insertLevel(c, A2.businessId, KA2), 'restrictive WITH CHECK relaxed, tenant_membership untouched');
      });
    });
  });

  it('DENY/ALLOW: an UPDATE of A2’s cache row — reachable because the internal read admission and the shared tenant both pass USING — is refused by the WITH CHECK (42501); the same UPDATE of A’s row is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      const bump = (businessId: string, key: Key) =>
        asInternalInA(c, async () => {
          const r = await c.query(`UPDATE stock_levels SET last_stock_seq = last_stock_seq WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
            businessId,
            key.warehouseId,
            key.variantId,
          ]);
          return r.rowCount;
        });
      expectRefused(await bump(A2.businessId, KA2), '42501', null, 'A2 row');
      expect(expectAccepted(await bump(A.businessId, KA), 'A row')).toBe(1);
    });
  });

  it('DENY: a split pair — A’s business with A2’s warehouse or A2’s variant — is refused by the composite FKs (23503)', async () => {
    await withRolledBackFixture(async (c) => {
      expectConstraint(await insertLevel(c, A.businessId, { warehouseId: KA2.warehouseId, variantId: KA.variantId }), '23503', 'stock_levels_warehouse_fk');
      expectConstraint(await insertLevel(c, A.businessId, { warehouseId: KA.warehouseId, variantId: KA2.variantId }), '23503', 'stock_levels_variant_fk');
      expectConstraint(await insertMovement(c, A.businessId, KA2), '23503', 'stock_movements_level_fk');
      expect(await levelCount(c, A.businessId)).toBe(0);
    });
  });

  it('ALLOW: the same shapes with A’s own warehouse and variant are accepted', async () => {
    await withRolledBackFixture(async (c) => {
      expectAccepted(await insertLevel(c, A.businessId, KA), 'A key');
      expectAccepted(await insertMovement(c, A.businessId, KA), 'A movement on its key');
      expect(await levelCount(c, A.businessId)).toBe(1);
    });
  });
});

describe('T-18.6 (same owner) — R4, R5 and R6 are bound to the scope’s business', () => {
  const R456 = [
    `SELECT inventory_next_deficit_seq($1, $2, $3)::text AS v`,
    `SELECT on_hand::text AS v FROM inventory_stock_fold($1, $2, $3)`,
    `SELECT matches::text AS v FROM inventory_stock_verify($1, $2, $3)`,
  ];

  it.each([
    ['A2', 'A'],
    ['A', 'A2'],
  ])('DENY: R4, R5 and R6 for %s’s key under scope %s → inventory.scope_mismatch', async (owner) => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      const [keyOf, scope] = owner === 'A2' ? [{ b: A2.businessId, k: KA2 }, A] : [{ b: A.businessId, k: KA }, A2];
      await setScope(c, scope);
      for (const sql of R456) {
        expectRefused(await attempt(c, () => c.query(sql, [keyOf.b, keyOf.k.warehouseId, keyOf.k.variantId])), 'P0001', 'inventory.scope_mismatch', sql);
      }
    });
  });

  it('ALLOW: the same calls for each business’s own key under its own scope answer', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      for (const [s, key, onHand] of [
        [A, KA, '4.0000'],
        [A2, KA2, '7.0000'],
      ] as const) {
        await setScope(c, s);
        const answers: string[] = [];
        for (const sql of R456) {
          const r = expectAccepted(await attempt(c, () => c.query<{ v: string }>(sql, [s.businessId, key.warehouseId, key.variantId])), sql);
          answers.push(must(r.rows[0]).v);
        }
        expect(answers, s.businessId).toEqual(['1', onHand, 'true']);
      }
    });
  });
});

describe('R7 / R9 (same owner) — the unit lock and the variant stock-identity lock refuse the other business’s scope', () => {
  /**
   * A raw unit change as the superuser under `scope`, with guard 1 (the
   * configuration authority) dropped — T-17.5’s shape. Both the drop and the
   * change are rolled back afterwards, so every call starts from the same state.
   */
  const unitChange = (c: Queryable, scope: { tenantId: string; businessId: string }, productId: string) =>
    scratch(c, async () => {
      await c.query(`DROP TRIGGER products_10_inventory_config_authority ON products`);
      return attempt(c, async () => {
        await setScope(c, scope);
        return (await c.query(`UPDATE products SET unit_code = 'kg' WHERE id = $1`, [productId])).rowCount;
      });
    });

  it('R7 DENY: a unit change of A’s product under scope A2 (and of A2’s under scope A) → inventory.scope_mismatch, with or without history', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      expectRefused(await unitChange(c, A2, biz.piece.productId), 'P0001', 'inventory.scope_mismatch', 'A product with history, scope A2');
      expectRefused(await unitChange(c, A2, biz.dec2.productId), 'P0001', 'inventory.scope_mismatch', 'A product without history, scope A2');
      expectRefused(await unitChange(c, A, a2.piece.productId), 'P0001', 'inventory.scope_mismatch', 'A2 product with history, scope A');
    });
  });

  it('R7 ALLOW: in the product’s own scope the scope check passes — history → inventory.unit_identity_locked, no history → the change is accepted', async () => {
    await withRolledBackFixture(async (c) => {
      await bothBusinesses(c);
      expectRefused(await unitChange(c, A, biz.piece.productId), 'P0001', 'inventory.unit_identity_locked', 'A product with history, scope A');
      expectRefused(await unitChange(c, A2, a2.piece.productId), 'P0001', 'inventory.unit_identity_locked', 'A2 product with history, scope A2');
      expect(expectAccepted(await unitChange(c, A, biz.dec2.productId), 'A product without history, scope A')).toBe(1);
    });
  });

  /** A reparent as the superuser under `scope` (RLS bypassed, so the trigger alone decides). */
  const reparent = (c: Queryable, scope: { tenantId: string; businessId: string }, variantId: string, toProductId: string) =>
    attempt(c, async () => {
      await setScope(c, scope);
      return (await c.query(`UPDATE product_variants SET product_id = $2 WHERE id = $1`, [variantId, toProductId])).rowCount;
    });

  it('R9 DENY: a reparent of A’s stocked or unstocked variant under scope A2 (and of A2’s under scope A) → inventory.scope_mismatch', async () => {
    await withRolledBackFixture(async (c) => {
      const [v1, v2] = biz.variantProduct.variantIds;
      const [w1, w2] = a2.variantProduct.variantIds;
      await applyOne(c, A, purchase({ warehouseId: KA.warehouseId, variantId: v1 }));
      await applyOne(c, A2, purchase({ warehouseId: KA2.warehouseId, variantId: w1 }));
      expectRefused(await reparent(c, A2, v1, targetA), 'P0001', 'inventory.scope_mismatch', 'A stocked, scope A2');
      expectRefused(await reparent(c, A2, v2, targetA), 'P0001', 'inventory.scope_mismatch', 'A unstocked, scope A2');
      expectRefused(await reparent(c, A, w1, targetA2), 'P0001', 'inventory.scope_mismatch', 'A2 stocked, scope A');
      expectRefused(await reparent(c, A, w2, targetA2), 'P0001', 'inventory.scope_mismatch', 'A2 unstocked, scope A');
    });
  });

  it('R9 ALLOW: in the variant’s own scope the scope check passes — stocked → inventory.variant_stock_identity_locked, unstocked → it moves', async () => {
    await withRolledBackFixture(async (c) => {
      const [v1, v2] = biz.variantProduct.variantIds;
      const [w1, w2] = a2.variantProduct.variantIds;
      await applyOne(c, A, purchase({ warehouseId: KA.warehouseId, variantId: v1 }));
      await applyOne(c, A2, purchase({ warehouseId: KA2.warehouseId, variantId: w1 }));
      expectRefused(await reparent(c, A, v1, targetA), 'P0001', 'inventory.variant_stock_identity_locked', 'A stocked, scope A');
      expectRefused(await reparent(c, A2, w1, targetA2), 'P0001', 'inventory.variant_stock_identity_locked', 'A2 stocked, scope A2');
      expect(expectAccepted(await reparent(c, A, v2, targetA), 'A unstocked, scope A')).toBe(1);
      expect(expectAccepted(await reparent(c, A2, w2, targetA2), 'A2 unstocked, scope A2')).toBe(1);
    });
  });

  it('R9 (daftar_app): scoped to A2 the owner’s app session cannot even reach A’s variant (0 rows); scoped to A the same UPDATE moves it', async () => {
    await withRolledBackFixture(async (c) => {
      const v2 = biz.variantProduct.variantIds[1];
      const asApp = (scope: { tenantId: string; businessId: string }) =>
        attempt(c, async () => {
          await setScope(c, scope);
          await c.query('SET LOCAL ROLE daftar_app');
          const r = await c.query(`UPDATE product_variants SET product_id = $2 WHERE id = $1`, [v2, targetA]);
          await c.query('RESET ROLE');
          return r.rowCount;
        });
      expect(expectAccepted(await asApp(A2), 'scope A2')).toBe(0);
      expect(expectAccepted(await asApp(A), 'scope A')).toBe(1);
    });
  });
});

it('the fixture only ever ran in rolled-back transactions: the registries are in the migration state', async () => {
  await assertMigrationState();
});
