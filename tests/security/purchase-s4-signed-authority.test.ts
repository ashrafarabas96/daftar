/**
 * P3-S4 T-02 — SIGNED AUTHORITY OF THE SEVEN ENTRY ROUTINES
 * (docs/PHASE_3_S4_CONTRACT.md A-03, A-09, A-10, §2.4, §6 T-02; P3-AL-55).
 *
 * Each of `supplier_create`, `supplier_update`, `supplier_archive`,
 * `supplier_reactivate`, `purchase_save_draft`, `purchase_cancel` and
 * `purchase_receive` refuses — as its FIRST decision, before anything is
 * read, locked or written — a missing, malformed, forged, replayed or
 * wrong-kind assertion, and an assertion over a payload with any one field
 * changed (`inventory.assertion_payload_mismatch`). Every DENY is paired with
 * the ALLOW of the same honest command; every case is rolled back except the
 * one cross-transaction replay.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, refusedWith, scratch, seedS3World, type S3World } from '../helpers/inventory-commands';
import {
  OP_OF,
  ROUTINE_OF,
  S4_HELPERS,
  S4_KINDS,
  assertionFor,
  honestS4,
  payloadOf,
  rawPayloadSha256,
  runCommand,
  s4Counts,
  s4Delta,
  s4Tampers,
  supplierCreate,
  tryCommand,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4auth');
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

/** Re-sign an assertion's preimage with a key the database does not hold: a well-formed forgery. */
function forged(assertion: string): string {
  const parts = assertion.split('.');
  const mac = createHmac('sha256', Buffer.from('not-the-inventory-assertion-key!')).update(parts.slice(0, -1).join('.')).digest('hex');
  return [...parts.slice(0, -1), mac].join('.');
}

describe('T-02 the assertion is the first decision of every S4 routine', () => {
  for (const kind of S4_KINDS) {
    it(`${kind}: none, malformed, forged or expired → refused, nothing written; the honest assertion → accepted`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestS4(c, A, kind);
        const before = await s4Counts(c, A.businessId);
        refusedWith(await tryCommand(c, A, cmd, { assertion: null }), 'P0001', 'inventory.assertion_missing');
        refusedWith(await tryCommand(c, A, cmd, { assertion: 'invctl/1.garbage' }), 'P0001', 'inventory.assertion_malformed');
        const honest = assertionFor(A, cmd);
        refusedWith(await tryCommand(c, A, cmd, { assertion: forged(honest) }), 'P0001', 'inventory.assertion_invalid_signature', 'a forged MAC');
        const expired = mintTestInventoryAssertion(
          { actorUserId: A.userId, tenantId: A.tenantId, businessId: A.businessId, opCode: OP_OF[kind], payloadSha256: payloadOf(A, cmd).payload.sha256 },
          new Date(Date.now() - 600_000),
        );
        refusedWith(await tryCommand(c, A, cmd, { assertion: expired }), 'P0001', 'inventory.assertion_expired', 'expired ten minutes ago');
        expect(s4Delta(before, await s4Counts(c, A.businessId)), 'no refusal wrote anything').toEqual({});
        // The builder the service uses and the field-by-field claimed stream agree on the honest command.
        expect(payloadOf(A, cmd).payload.sha256).toBe(rawPayloadSha256(A, cmd));
        expectAccepted(await tryCommand(c, A, cmd, { assertion: honest }), 'the honest command');
      });
    });

    it(`${kind}: an assertion of each OTHER kind (S4, S3, S1) → assertion_wrong_operation`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestS4(c, A, kind);
        for (const other of S4_KINDS.filter((k) => k !== kind)) {
          refusedWith(await tryCommand(c, A, cmd, { op: OP_OF[other] }), 'P0001', 'inventory.assertion_wrong_operation', `${other} for ${kind}`);
        }
        refusedWith(await tryCommand(c, A, cmd, { op: 'inventory.adjust' }), 'P0001', 'inventory.assertion_wrong_operation', 'an S3 kind');
        refusedWith(await tryCommand(c, A, cmd, { op: 'inventory.configure_product' }), 'P0001', 'inventory.assertion_wrong_operation', 'an S1 kind');
        expectAccepted(await tryCommand(c, A, cmd));
      });
    });

    it(`${kind}: every bound field changed one at a time → assertion_payload_mismatch`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestS4(c, A, kind);
        const list = s4Tampers(cmd, world.A2);
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
        const cmd = await honestS4(c, A, kind);
        const assertion = assertionFor(A, cmd);
        await scratch(c, async () => {
          expectAccepted(await tryCommand(c, A, cmd, { assertion }), 'a first use, then rolled back');
        });
        expectAccepted(await tryCommand(c, A, cmd, { assertion }), 'the identical payload after the rollback');
        refusedWith(await tryCommand(c, A, cmd, { assertion }), 'P0001', 'inventory.assertion_replayed');
        const again = expectAccepted(await tryCommand(c, A, cmd), 'a fresh assertion answers the stored document');
        expect(must(again[0]).replayed, 'the command is idempotent').toBe(true);
      });
    });
  }

  it('a replay in ANOTHER transaction, after the first committed, is refused', async () => {
    const A = world.A;
    const cmd = supplierCreate({ name: 'Committed once' });
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
      const again = expectAccepted(await tryCommand(c, A, cmd), 'a fresh assertion replays the stored supplier');
      expect(must(again[0]).replayed).toBe(true);
    });
  });

  it('an assertion minted for another actor’s business, or another business of the same owner, is refused', async () => {
    await inTx(async () => {
      const A = world.A;
      for (const kind of S4_KINDS) {
        const cmd = await honestS4(c, A, kind);
        refusedWith(await tryCommand(c, A, cmd, { mintBusiness: world.A2 }), 'P0001', 'inventory.assertion_scope_mismatch', `${kind} for A2`);
        refusedWith(await tryCommand(c, A, cmd, { mintBusiness: world.B }), 'P0001', 'inventory.assertion_scope_mismatch', `${kind} for B`);
        expectAccepted(await tryCommand(c, A, cmd), kind);
      }
    });
  });

  it('catalogue: the first statement of each routine consumes its own kind; of each helper, re-verifies purchase.receive', async () => {
    const q = ownerPool();
    for (const kind of S4_KINDS) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [ROUTINE_OF[kind]])).rows[0]).d;
      const body = must(def.split(/\nBEGIN\n/)[1], `${kind} body`);
      expect(
        body.trimStart().startsWith(`v_actor := inventory_assertion_consume('${OP_OF[kind]}', inventory_claimed_payload_digest('${OP_OF[kind]}',`),
        kind,
      ).toBe(true);
    }
    for (const helper of S4_HELPERS) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [helper])).rows[0]).d;
      expect(
        must(def.split(/\nBEGIN\n/)[1])
          .trimStart()
          .startsWith(`v_actor := inventory_assertion_current(ARRAY['purchase.receive']);`),
        helper,
      ).toBe(true);
    }
  });

  it('the three receipt helpers refuse a transaction whose consumed assertion is not purchase.receive; none without any', async () => {
    await inTx(async () => {
      const A = world.A;
      const calls = [
        { sql: `SELECT purchase_lock_receipt_targets($1::uuid, ARRAY[$2::uuid])`, params: [A.w1, A.piece.variantId] },
        { sql: `SELECT * FROM purchase_cover_deficits($1::uuid, NULL)`, params: [randomUUID()] },
        { sql: `SELECT purchase_bridge_receipt($1::uuid, NULL)`, params: [randomUUID()] },
      ];
      for (const call of calls) {
        const none = await (async () => {
          await c.query('SAVEPOINT h');
          try {
            await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
            await c.query(call.sql, call.params);
            return 'accepted';
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          } finally {
            await c.query('ROLLBACK TO SAVEPOINT h');
          }
        })();
        expect(none, `${call.sql} with no consumed assertion`).toMatch(/^inventory\.assertion_(missing|not_consumed|wrong_operation)/);
      }
      // A consumed supplier.create in the same transaction does not open the receipt helpers.
      await runCommand(c, A, supplierCreate());
      for (const call of calls) {
        await c.query('SAVEPOINT h');
        let message = 'accepted';
        try {
          await c.query(call.sql, call.params);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT h');
        }
        expect(message, `${call.sql} under supplier.create`).toMatch(/^inventory\.assertion_wrong_operation:/);
      }
    });
  });
});
