/**
 * P3-S3 T-01 — AUTHORITY OF THE SEVEN ENTRY ROUTINES
 * (docs/PHASE_3_S3_CONTRACT.md A-09, A-15, A-18, §6 T-01; brief: "each of the
 * seven entry routines: its first statement consumes the assertion; no
 * runtime role can call the bridge helper; a replayed assertion is refused").
 *
 * Every DENY is paired with the ALLOW of the same honest command. Every case
 * runs in an owner transaction that is rolled back, except the one
 * cross-transaction replay, whose committed stocktake draft is removed in
 * `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  OP_OF,
  ROUTINE_OF,
  RUNTIME_ROLES,
  S3_BRIDGES,
  S3_KINDS,
  S3_TABLES,
  assertionFor,
  attempt,
  expectAccepted,
  must,
  ownerClient,
  payloadOf,
  rawPayloadSha256,
  refusedWith,
  roleClient,
  runCommand,
  scratch,
  seedS3World,
  settle,
  stocktakeOpenCommand,
  transferCommand,
  tryCommand,
  type S3Kind,
  type S3World,
} from '../helpers/inventory-commands';
import { honestCommand, tampers } from '../helpers/inventory-posting';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'auth');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

const HELPERS = [
  'inventory_fixed_text(numeric,integer)',
  'inventory_reason_words(text)',
  'inventory_lock_stock_targets(uuid[],uuid[])',
  'inventory_bridge_source_lines(text,uuid)',
  'inventory_largest_remainder(numeric[],bigint)',
] as const;

describe('T-01.1..4 the assertion is the first decision of every routine', () => {
  for (const kind of S3_KINDS) {
    it(`${kind}: no carrier → assertion_missing; the honest assertion → accepted`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        refusedWith(await tryCommand(c, A, cmd, { assertion: null }), 'P0001', 'inventory.assertion_missing');
        refusedWith(await tryCommand(c, A, cmd, { assertion: 'invctl/1.garbage' }), 'P0001', 'inventory.assertion_malformed');
        // The builder the service uses and the field-by-field claimed stream agree on the honest command.
        expect(payloadOf(A, cmd).payload.sha256).toBe(rawPayloadSha256(A, cmd));
        expectAccepted(await tryCommand(c, A, cmd), 'the honest command');
      });
    });

    it(`${kind}: an assertion of each OTHER S3 kind → assertion_wrong_operation`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        for (const other of S3_KINDS.filter((k) => k !== kind)) {
          refusedWith(await tryCommand(c, A, cmd, { op: OP_OF[other] }), 'P0001', 'inventory.assertion_wrong_operation', `${other} for ${kind}`);
        }
        refusedWith(await tryCommand(c, A, cmd, { op: 'inventory.configure_product' }), 'P0001', 'inventory.assertion_wrong_operation', 'an S1 kind');
        expectAccepted(await tryCommand(c, A, cmd));
      });
    });

    it(`${kind}: every bound field tampered one at a time → assertion_payload_mismatch (PM-45)`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        const list = tampers(cmd, world.A2);
        expect(list.length).toBeGreaterThan(1);
        for (const t of list) {
          refusedWith(await tryCommand(c, A, cmd, { mintFor: t.cmd, raw: true }), 'P0001', 'inventory.assertion_payload_mismatch', `${kind} ${t.field}`);
        }
        expectAccepted(await tryCommand(c, A, cmd));
      });
    });

    it(`${kind}: a replayed assertion is refused in the same transaction; a rolled-back first use may be retried`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        const assertion = assertionFor(A, cmd);
        await scratch(c, async () => {
          expectAccepted(await tryCommand(c, A, cmd, { assertion }), 'a first use, then rolled back');
        });
        expectAccepted(await tryCommand(c, A, cmd, { assertion }), 'the identical payload after the rollback (L:2004)');
        refusedWith(await tryCommand(c, A, cmd, { assertion }), 'P0001', 'inventory.assertion_replayed');
        expectAccepted(await tryCommand(c, A, cmd), 'a fresh assertion answers the stored document');
      });
    });
  }

  it('a replay in ANOTHER transaction, after the first committed, is refused', async () => {
    const A = world.A;
    const cmd = stocktakeOpenCommand(A.w2);
    const assertion = assertionFor(A, cmd);
    const first = await ownerClient();
    try {
      await first.query('BEGIN');
      await runCommand(first, A, cmd, { assertion });
      await first.query('COMMIT');
    } finally {
      await first.end();
    }
    await inTx(async () => {
      refusedWith(await tryCommand(c, A, cmd, { assertion }), 'P0001', 'inventory.assertion_replayed');
      expectAccepted(await tryCommand(c, A, cmd), 'a fresh assertion replays the stored draft');
    });
  });

  it('catalogue: the first statement of each routine consumes its own kind; of each helper, re-verifies it', async () => {
    const q = ownerPool();
    for (const kind of S3_KINDS) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [ROUTINE_OF[kind]])).rows[0]).d;
      const body = must(def.split(/\nBEGIN\n/)[1], `${kind} body`);
      expect(
        body.trimStart().startsWith(`v_actor := inventory_assertion_consume('${OP_OF[kind]}', inventory_claimed_payload_digest('${OP_OF[kind]}',`),
        kind,
      ).toBe(true);
    }
    for (const helper of ['inventory_lock_stock_targets(uuid[],uuid[])', 'inventory_bridge_source_lines(text,uuid)']) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [helper])).rows[0]).d;
      expect(
        must(def.split(/\nBEGIN\n/)[1])
          .trimStart()
          .startsWith('v_actor := inventory_assertion_current(ARRAY['),
        helper,
      ).toBe(true);
    }
  });
});

describe('T-01.5/8 least authority from the catalogue', () => {
  /** Install, as the owner, a copy of `routine` named `name` with `edit` applied to its body, owned like the original, executable by daftar_app. */
  async function installCopy(routine: string, name: string, edit: (body: string) => string): Promise<void> {
    const def = must((await c.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [routine])).rows[0]).d;
    const base = routine.slice(0, routine.indexOf('('));
    const copy = edit(def.replace(`FUNCTION public.${base}(`, `FUNCTION public.${name}(`));
    expect(copy).not.toBe(def.replace(`FUNCTION public.${base}(`, `FUNCTION public.${name}(`));
    await c.query(copy);
    const sig = routine.slice(routine.indexOf('('));
    await c.query(`ALTER FUNCTION ${name}${sig} OWNER TO daftar_inventory_internal`);
    await c.query(`GRANT EXECUTE ON FUNCTION ${name}${sig} TO daftar_app`);
  }

  it('an inventory.adjust assertion cannot make the primitive write transfer_in (movement_kind_not_authorized); the real routine can write adjustment', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = await honestCommand(c, A, 'adjust');
      if (cmd.kind !== 'adjust') throw new Error('unreachable');
      await installCopy(ROUTINE_OF.adjust, 's3_fixture_adjust_as_transfer_in', (d) =>
        d.replace(`ROW(p_warehouse_id, p_variant_ids[v_i], 'adjustment',`, `ROW(p_warehouse_id, p_variant_ids[v_i], 'transfer_in',`),
      );
      const o = await attempt(c, async () => {
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.inventory_assertion', $3, true),
                  set_config('app.business_transaction_id', $4, true)`,
          [A.tenantId, A.businessId, assertionFor(A, cmd), randomUUID()],
        );
        await c.query('SET LOCAL ROLE daftar_app');
        await c.query(
          `SELECT * FROM s3_fixture_adjust_as_transfer_in($1::uuid, $2::uuid, $3::date, $4::text, $5::uuid[], $6::numeric[], $7::numeric[], $8::bigint[])`,
          [
            cmd.adjustmentId,
            cmd.warehouseId,
            cmd.occurredOn,
            cmd.reason,
            cmd.lines.map((l) => l.variantId),
            cmd.lines.map((l) => l.qty),
            cmd.lines.map((l) => l.unitCost),
            cmd.lines.map((l) => l.expected.toString()),
          ],
        );
      });
      refusedWith(o, 'P0001', 'inventory.movement_kind_not_authorized');
      expectAccepted(await tryCommand(c, A, cmd), 'the real routine');
    });
  });

  for (const kind of ['stocktake_open', 'stocktake_count'] as const) {
    it(`${kind} cannot reach the primitive: a copy that asks it for a movement after consuming is refused`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        const name = `s3_fixture_${kind}_moves`;
        const inject = `v_trace    := inventory_business_transaction_id();
  PERFORM 1 FROM inventory_apply_stock_movements(ARRAY[ROW(p_warehouse_id, '${A.piece.variantId}'::uuid, 'adjustment', 'inventory_adjustment',
    p_stocktake_id, gen_random_uuid(), 1, 1, NULL, 'x')::inventory_movement_request]);`;
        await installCopy(ROUTINE_OF[kind], name, (d) => d.replace('v_trace    := inventory_business_transaction_id();', inject));
        const o = await attempt(c, async () => {
          await c.query(
            `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.inventory_assertion', $3, true)`,
            [A.tenantId, A.businessId, assertionFor(A, cmd)],
          );
          await c.query('SET LOCAL ROLE daftar_app');
          if (cmd.kind === 'stocktake_open') {
            await c.query(`SELECT * FROM ${name}($1::uuid, $2::uuid)`, [cmd.stocktakeId, cmd.warehouseId]);
          } else if (cmd.kind === 'stocktake_count') {
            await c.query(`SELECT * FROM ${name}($1::uuid, $2::uuid, $3::uuid[], $4::numeric[])`, [
              cmd.stocktakeId,
              cmd.warehouseId,
              cmd.lines.map((l) => l.variantId),
              cmd.lines.map((l) => l.counted),
            ]);
          }
        });
        refusedWith(o, 'P0001', 'inventory.assertion_wrong_operation', `${kind} → primitive`);
        expectAccepted(await tryCommand(c, A, cmd), 'the real routine');
      });
    });
  }

  it('the bridge helper refuses a source type its verified operation does not own; the one it owns is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = await honestCommand(c, A, 'transfer');
      await runCommand(c, A, cmd);
      // Still inside the transaction that consumed the inventory.transfer assertion.
      const call = (st: string) => attempt(c, () => c.query(`SELECT inventory_bridge_source_lines($1, $2::uuid) AS n`, [st, randomUUID()]));
      for (const st of ['inventory_adjustment', 'stocktake', 'inventory_opening', 'fixture_line']) {
        refusedWith(await call(st), 'P0001', 'inventory.source_type_not_authorized', st);
      }
      expectAccepted(await call('inventory_transfer'), 'its own type');
    });
  });

  it('the bridge helper without a consumed assertion: assertion_not_consumed', async () => {
    await inTx(async () => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.inventory_assertion', $3, true)`, [
        A.tenantId,
        A.businessId,
        assertionFor(A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '1' }])),
      ]);
      refusedWith(
        await attempt(c, () => c.query(`SELECT inventory_bridge_source_lines('inventory_transfer', $1::uuid)`, [randomUUID()])),
        'P0001',
        'inventory.assertion_not_consumed',
      );
    });
  });
});

describe('T-01.6/7/9 the grant matrix (A-18)', () => {
  it('each routine is internal-owned SECURITY DEFINER with the pinned path, executable by daftar_app alone', async () => {
    const q = ownerPool();
    for (const kind of S3_KINDS) {
      const r = must(
        (
          await q.query<{ owner: string; secdef: boolean; config: string[] | null; grantees: string[] | null }>(
            `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                    (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text)
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
               FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [ROUTINE_OF[kind]],
          )
        ).rows[0],
      );
      expect(r, kind).toEqual({
        owner: 'daftar_inventory_internal',
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['daftar_app'],
      });
    }
  });

  it('no runtime role, daftar_app and daftar_accounting_internal included, may execute a helper (the bridge writer included)', async () => {
    const q = ownerPool();
    for (const helper of HELPERS) {
      for (const role of [...RUNTIME_ROLES.map((r) => r.role), 'daftar_accounting_internal', 'daftar_migrator']) {
        const r = must((await q.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, helper])).rows[0]);
        expect(r.ok, `${role} → ${helper}`).toBe(false);
      }
    }
  });

  it('daftar_app calling the bridge helper directly is refused 42501; the entry routine it may call is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await c.query('SET LOCAL ROLE daftar_app');
      refusedWith(await attempt(c, () => c.query(`SELECT inventory_bridge_source_lines('inventory_transfer', $1::uuid)`, [randomUUID()])), '42501', null);
      refusedWith(await attempt(c, () => c.query(`SELECT inventory_lock_stock_targets(ARRAY[$1::uuid], NULL)`, [A.w1])), '42501', null);
      await c.query('RESET ROLE');
      expectAccepted(await tryCommand(c, A, stocktakeOpenCommand(A.w1)));
    });
  });

  it('every other runtime role is refused EXECUTE on every routine, from the catalogue and on a real connection', async () => {
    const q = ownerPool();
    for (const { role, url } of RUNTIME_ROLES) {
      for (const kind of S3_KINDS) {
        const r = must((await q.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, ROUTINE_OF[kind]])).rows[0]);
        expect(r.ok, `${role} → ${kind}`).toBe(role === 'daftar_app');
      }
      if (role === 'daftar_app') continue;
      const rc = await roleClient(url);
      try {
        const o = await settle(() => rc.query(`SELECT * FROM inventory_stocktake_open($1::uuid, $2::uuid)`, [randomUUID(), world.A.w1]));
        refusedWith(o, '42501', null, role);
      } finally {
        await rc.end();
      }
    }
  });

  it('daftar_app holds SELECT on the eight document tables and no DML on them or on the four bridges (42501)', async () => {
    const q = ownerPool();
    for (const t of [...S3_TABLES, ...S3_BRIDGES]) {
      const r = must(
        (
          await q.query<{ s: boolean; i: boolean; u: boolean; d: boolean; tr: boolean }>(
            `SELECT has_table_privilege('daftar_app', $1, 'SELECT') AS s, has_table_privilege('daftar_app', $1, 'INSERT') AS i,
                    has_table_privilege('daftar_app', $1, 'UPDATE') AS u, has_table_privilege('daftar_app', $1, 'DELETE') AS d,
                    has_table_privilege('daftar_app', $1, 'TRUNCATE') AS tr`,
            [t],
          )
        ).rows[0],
      );
      expect(r, t).toEqual({ s: (S3_TABLES as readonly string[]).includes(t), i: false, u: false, d: false, tr: false });
    }
    await inTx(async () => {
      const A = world.A;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const t of [...S3_TABLES, ...S3_BRIDGES]) {
        for (const sql of [
          `INSERT INTO ${t} (business_id) VALUES ($1)`,
          `UPDATE ${t} SET business_id = $1 WHERE false`,
          `DELETE FROM ${t} WHERE business_id = $1`,
        ]) {
          const o = await attempt(c, async () => {
            await c.query('SET LOCAL ROLE daftar_app');
            await c.query(sql, [A.businessId]);
          });
          refusedWith(o, '42501', null, `${sql}`);
        }
      }
    });
  });
});

describe('the migration end state holds', () => {
  it('the source-guard gap report is empty and the registries are exactly S1 + S3 (P3-S4: + S4; P3-S5: + S5)', async () => {
    const q = ownerPool();
    expect((await q.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows).toEqual([]);
    const kinds = (await q.query<{ op_code: string }>(`SELECT op_code FROM inventory_operation_kinds ORDER BY op_code`)).rows.map((r) => r.op_code);
    expect(kinds).toEqual(
      [
        ...S3_KINDS.map((k: S3Kind) => OP_OF[k]),
        'inventory.configure_product',
        'structure.associate_warehouse_branch',
        'structure.dissociate_warehouse_branch',
        // P3-S4 (0063/0064): the seven S4 operation kinds (0064, contract A-03).
        'supplier.create',
        'supplier.update',
        'supplier.archive',
        'supplier.reactivate',
        'purchase.draft',
        'purchase.cancel',
        'purchase.receive',
        // P3-S5 (0065/0066): the two S5 operation kinds (0066, contract A-03).
        'purchase.return',
        'purchase.reverse',
      ].sort(),
    );
    const maps = (await q.query<{ m: string }>(`SELECT op_code || '→' || movement_kind AS m FROM inventory_operation_movement_kinds ORDER BY 1`)).rows.map(
      (r) => r.m,
    );
    expect(maps).toEqual(
      [
        'inventory.adjust→adjustment',
        'inventory.damage→damage',
        'inventory.opening→inventory_opening',
        'inventory.stocktake_finalize→stocktake',
        'inventory.transfer→transfer_in',
        'inventory.transfer→transfer_out',
        // P3-S4 (0063/0064): the receipt's two op→kind rows (0064, contract §2.5).
        'purchase.receive→purchase',
        'purchase.receive→negative_inventory_cost_adjustment',
        // P3-S5 (0065/0066): the two S5 op→kind rows (0066, contract §2.6).
        'purchase.return→supplier_return',
        'purchase.reverse→purchase_reversal',
      ].sort(),
    );
  });
});
