/**
 * P3-S6 T-02 — SIGNED AUTHORITY OF THE SEVEN S6 ENTRY ROUTINES
 * (docs/PHASE_3_S6_CONTRACT.md A-03, A-16, §2.6 step 1, §6 T-02; PM-44, PM-45).
 *
 * Each of `payment_method_create`, `payment_method_update`,
 * `payment_method_deactivate`, `payment_method_activate`, `supplier_pay`,
 * `supplier_allocate_credit` and `supplier_receive_refund` refuses — as its
 * FIRST decision, before anything is read, locked or written — a missing,
 * malformed, forged, expired, replayed or wrong-kind assertion, an assertion
 * minted for another business (another owner's B, or the same owner's A2),
 * and an assertion over a payload with any one A-16 field changed
 * (`inventory.assertion_payload_mismatch`: every argument in turn, and every
 * element of every per-allocation array). A direct EXECUTE by `daftar_app`
 * with forged GUCs (a spliced assertion, another business's scope) is
 * refused the same way. Every DENY is paired with the ALLOW of the same
 * honest command, and no refusal writes anything.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUnitCost, type InventoryOperationCode } from '../../packages/inventory/src';
import { ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, refusedWith, scratch, seedS3World, type S3Business, type S3World } from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  S6_KINDS,
  S6_OP_OF,
  S6_ROUTINE_OF,
  castsOf,
  claimedSha256,
  committed,
  createMethod,
  methodCreateCall,
  methodLifecycleCall,
  methodRevision,
  methodUpdateCall,
  preparePay,
  prepareAllocate,
  prepareRefund,
  runS6,
  s6AssertionFor,
  s6Counts,
  sqlReturnToCredit,
  tryS6,
  withElement,
  withParam,
  type S6Call,
  type S6Kind,
} from '../helpers/supplier-settlement';

let world: S3World;
const cash = new Map<string, string>();

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's6auth');
  for (const biz of [world.A, world.A2, world.B]) {
    const r = await ownerPool().query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [biz.businessId]);
    cash.set(biz.businessId, must(r.rows[0], 'cash account').id);
  }
});

afterAll(async () => {
  await resetData();
});

const cashOf = (biz: S3Business): string => must(cash.get(biz.businessId), 'cash');

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
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

/** An honest assertion with one of its signed segments replaced and its MAC kept: a spliced assertion. */
function spliced(assertion: string, index: number, value: string): string {
  const parts = assertion.split('.');
  parts[index] = value;
  return parts.join('.');
}

/** A method of `biz`, created in the caller's transaction, with its current revision. */
async function aMethod(c: Client, biz: S3Business): Promise<{ id: string; revision: number }> {
  const id = await createMethod(c, biz, { postingAccountId: cashOf(biz) });
  return { id, revision: await methodRevision(c, biz.businessId, id) };
}

/** An honest, bound command of `kind` in `biz`, its state prepared in the caller's transaction. */
async function honest(c: Client, biz: S3Business, kind: S6Kind): Promise<S6Call> {
  switch (kind) {
    case 'method_create':
      return methodCreateCall(biz, { postingAccountId: cashOf(biz), sortOrder: 20 });
    case 'method_update': {
      const m = await aMethod(c, biz);
      return methodUpdateCall(biz, m.id, m.revision, { postingAccountId: cashOf(biz), sortOrder: 30, names: { ar: 'بنك', en: 'Bank', tr: 'Banka' } });
    }
    case 'method_deactivate': {
      const m = await aMethod(c, biz);
      return methodLifecycleCall(biz, 'method_deactivate', m.id, m.revision);
    }
    case 'method_activate': {
      const m = await aMethod(c, biz);
      await runS6(c, biz, methodLifecycleCall(biz, 'method_deactivate', m.id, m.revision));
      return methodLifecycleCall(biz, 'method_activate', m.id, await methodRevision(c, biz.businessId, m.id));
    }
    case 'pay': {
      const m = await aMethod(c, biz);
      const p1 = await receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
      const p2 = await receivedPurchase(c, biz, [{ variantId: biz.piece2.variantId, qty: '1', unitPriceMinor: '700' }], { supplierId: p1.supplierId });
      return preparePay(c, biz, {
        supplierId: p1.supplierId,
        paymentMethodId: m.id,
        reference: 'TRF-1',
        allocations: [
          { purchaseId: p1.purchaseId, paymentAmountMinor: 1200n },
          { purchaseId: p2.purchaseId, paymentAmountMinor: 300n },
        ],
      });
    }
    case 'allocate_credit': {
      const m = await aMethod(c, biz);
      const n = await sqlReturnToCredit(c, biz, m.id);
      const target = await receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: '1', unitPriceMinor: '900' }], {
        supplierId: n.purchase.supplierId,
      });
      return prepareAllocate(c, biz, { creditNoteId: n.creditNoteId, purchaseId: target.purchaseId, consumedMinor: 600n });
    }
    case 'receive_refund': {
      const m = await aMethod(c, biz);
      const n = await sqlReturnToCredit(c, biz, m.id);
      return prepareRefund(c, biz, { creditNoteId: n.creditNoteId, paymentMethodId: m.id, consumedMinor: 400n, reference: 'RF-1' });
    }
  }
}

const SYSTEM_TYPE_SWAP: Readonly<Record<string, string>> = { cash: 'wallet', manual: 'base', base: 'manual' };

/** One argument of SQL type `cast` changed so that its invpl/1 field changes (and nothing else). */
function changed(value: unknown, cast: string): unknown {
  switch (cast) {
    case 'uuid':
      return randomUUID();
    case 'boolean':
      return value !== true;
    case 'integer':
      if (typeof value !== 'number') throw new Error(`integer argument ${String(value)}`);
      return value + 1;
    case 'bigint':
      return (BigInt(String(value)) + 1n).toString(10);
    case 'date':
      return new Date(Date.parse(`${String(value)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    case 'char(3)':
      return value === 'EUR' ? 'USD' : 'EUR';
    case 'numeric': {
      const r = parseUnitCost(String(value)) + 1n;
      const scale = 10_000_000_000n;
      return `${(r / scale).toString(10)}.${(r % scale).toString(10).padStart(10, '0')}`;
    }
    case 'timestamptz':
      return new Date(Date.parse(String(value)) + 1000).toISOString();
    case 'text':
      if (value === null) return 'Tampered';
      if (/^[A-Z]{3}$/.test(String(value))) return value === 'EUR' ? 'USD' : 'EUR';
      return SYSTEM_TYPE_SWAP[String(value)] ?? `${String(value)}.`;
    default:
      throw new Error(`no change for ${cast}`);
  }
}

/** Every argument of the call changed one at a time; every element of every array argument; the arrays shortened and reordered. */
function tampers(call: S6Call): readonly { field: string; call: S6Call }[] {
  const casts = castsOf(call.kind);
  const out: { field: string; call: S6Call }[] = [];
  casts.forEach((cast, i) => {
    const value = call.params[i];
    if (cast.endsWith('[]')) {
      const elements = Array.isArray(value) ? value.map((x) => String(x)) : [];
      elements.forEach((e, k) => {
        out.push({ field: `argument ${i + 1}[${k + 1}] (${cast})`, call: withElement(call, i, k, String(changed(e, cast.slice(0, -2)))) });
      });
    } else {
      out.push({ field: `argument ${i + 1} (${cast})`, call: withParam(call, i, changed(value, cast)) });
    }
  });
  const arrays = casts.flatMap((cast, i) => (cast.endsWith('[]') ? [i] : []));
  if (arrays.length > 0) {
    const reshape = (f: (xs: readonly unknown[]) => unknown[]): S6Call =>
      arrays.reduce<S6Call>((acc, i) => withParam(acc, i, f(Array.isArray(acc.params[i]) ? acc.params[i] : [])), call);
    out.push({ field: 'an allocation dropped', call: reshape((xs) => xs.slice(0, 1)) });
    out.push({ field: 'the allocation order', call: reshape((xs) => [...xs].reverse()) });
  }
  return out;
}

describe('T-02 the assertion is the first decision of every S6 routine', () => {
  for (const kind of S6_KINDS) {
    it(`${kind}: none, malformed, forged or expired → refused, nothing written; the honest assertion → accepted`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const call = await honest(c, A, kind);
        expect(call.builtSha256, 'the builder and the claimed stream agree').toBe(claimedSha256(A, call));
        const before = await s6Counts(c, A.businessId);
        refusedWith(await tryS6(c, A, call, { assertion: null }), 'P0001', 'inventory.assertion_missing');
        refusedWith(await tryS6(c, A, call, { assertion: 'invctl/1.garbage' }), 'P0001', 'inventory.assertion_malformed');
        const good = s6AssertionFor(A, call);
        refusedWith(await tryS6(c, A, call, { assertion: forged(good) }), 'P0001', 'inventory.assertion_invalid_signature', 'a forged MAC');
        const expired = mintTestInventoryAssertion(
          { actorUserId: A.userId, tenantId: A.tenantId, businessId: A.businessId, opCode: S6_OP_OF[kind], payloadSha256: claimedSha256(A, call) },
          new Date(Date.now() - 600_000),
        );
        refusedWith(await tryS6(c, A, call, { assertion: expired }), 'P0001', 'inventory.assertion_expired', 'expired ten minutes ago');
        expect(await s6Counts(c, A.businessId), 'no refusal wrote anything').toEqual(before);
        expectAccepted(await tryS6(c, A, call, { assertion: good }), 'the honest command');
      });
    });

    it(`${kind}: an assertion of each other kind (S6, S5, S4, S3) → assertion_wrong_operation`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const call = await honest(c, A, kind);
        const before = await s6Counts(c, A.businessId);
        const others: InventoryOperationCode[] = [
          ...S6_KINDS.filter((k) => k !== kind).map((k) => S6_OP_OF[k]),
          'purchase.return',
          'purchase.reverse',
          'purchase.receive',
          'purchase.draft',
          'supplier.create',
          'inventory.adjust',
        ];
        for (const op of others) {
          refusedWith(await tryS6(c, A, call, { op }), 'P0001', 'inventory.assertion_wrong_operation', `${op} for ${kind}`);
        }
        expect(await s6Counts(c, A.businessId)).toEqual(before);
        expectAccepted(await tryS6(c, A, call));
      });
    });

    it(`${kind}: every A-16 field changed one at a time → assertion_payload_mismatch, nothing written`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const call = await honest(c, A, kind);
        const list = tampers(call);
        expect(list.length, 'every argument is tampered').toBeGreaterThanOrEqual(castsOf(kind).length);
        const before = await s6Counts(c, A.businessId);
        for (const t of list) {
          expect(claimedSha256(A, t.call), `${t.field} changes the signed stream`).not.toBe(claimedSha256(A, call));
          refusedWith(await tryS6(c, A, call, { mintFor: t.call }), 'P0001', 'inventory.assertion_payload_mismatch', `${kind} ${t.field} (signed)`);
          refusedWith(
            await tryS6(c, A, t.call, { mintFor: call, post: false }),
            'P0001',
            'inventory.assertion_payload_mismatch',
            `${kind} ${t.field} (executed)`,
          );
        }
        expect(await s6Counts(c, A.businessId), 'no tamper wrote anything').toEqual(before);
        expectAccepted(await tryS6(c, A, call));
      });
    });

    it(`${kind}: a replayed assertion is refused in the same transaction; a rolled-back first use may be retried`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const call = await honest(c, A, kind);
        const assertion = s6AssertionFor(A, call);
        await scratch(c, async () => {
          expectAccepted(await tryS6(c, A, call, { assertion }), 'a first use, then rolled back');
        });
        expectAccepted(await tryS6(c, A, call, { assertion }), 'the identical payload after the rollback');
        refusedWith(await tryS6(c, A, call, { assertion }), 'P0001', 'inventory.assertion_replayed');
        const again = expectAccepted(await tryS6(c, A, call), 'a fresh assertion answers the stored document');
        expect(again.length > 0 && again.every((r) => r.replayed), 'the command is idempotent').toBe(true);
      });
    });

    it(`${kind}: minted for another owner's business or the same owner's A2, or run under forged GUCs → refused`, async () => {
      await inTx(async (c) => {
        const { A, A2, B } = world;
        const call = await honest(c, A, kind);
        const before = await s6Counts(c, A.businessId);
        refusedWith(await tryS6(c, A, call, { mintBusiness: A2 }), 'P0001', 'inventory.assertion_scope_mismatch', 'minted for A2');
        refusedWith(await tryS6(c, A, call, { mintBusiness: B }), 'P0001', 'inventory.assertion_scope_mismatch', 'minted for B');
        // A's assertion under another business's scope GUCs: the verified business is A, the GUCs disagree.
        refusedWith(await tryS6(c, A, call, { scope: A2 }), 'P0001', 'inventory.assertion_scope_mismatch', 'A2 scope GUCs');
        refusedWith(await tryS6(c, A, call, { scope: B }), 'P0001', 'inventory.assertion_scope_mismatch', 'B scope GUCs');
        // A spliced assertion: A's MAC over a preimage whose business segment now names A2 (and the GUCs follow).
        const good = s6AssertionFor(A, call);
        const parts = good.split('.');
        expect(parts[4], 'segment 5 is the business').toBe(A.businessId);
        refusedWith(
          await tryS6(c, A, call, { assertion: spliced(good, 4, A2.businessId), scope: A2 }),
          'P0001',
          'inventory.assertion_invalid_signature',
          'business segment spliced to A2',
        );
        refusedWith(
          await tryS6(c, A, call, { assertion: spliced(good, 4, B.businessId), scope: B }),
          'P0001',
          'inventory.assertion_invalid_signature',
          'business segment spliced to B',
        );
        expect(await s6Counts(c, A.businessId)).toEqual(before);
        for (const other of [A2, B])
          expect(await s6Counts(c, other.businessId), 'nothing in the other business').toEqual(await s6Counts(ownerPool(), other.businessId));
        expectAccepted(await tryS6(c, A, call, { assertion: good }));
      });
    });

    it(`${kind}: with no assertion, a call naming only unknown ids is still assertion_missing — nothing is read first`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const call = await honest(c, A, kind);
        const casts = castsOf(kind);
        const garbage = casts.reduce<S6Call>((acc, cast, i) => {
          if (cast === 'uuid') return withParam(acc, i, randomUUID());
          if (cast === 'uuid[]')
            return withParam(
              acc,
              i,
              (Array.isArray(acc.params[i]) ? acc.params[i] : []).map(() => randomUUID()),
            );
          return acc;
        }, call);
        refusedWith(await tryS6(c, A, garbage, { assertion: null, post: false }), 'P0001', 'inventory.assertion_missing', 'unknown ids, no assertion');
        refusedWith(
          await tryS6(c, A, garbage, { scope: world.B, assertion: null, post: false }),
          'P0001',
          'inventory.assertion_missing',
          'B scope, no assertion',
        );
      });
    });
  }

  it('a replay in ANOTHER transaction, after the first committed, is refused; a fresh assertion answers the stored payment', async () => {
    const A = world.A;
    let assertion = '';
    const call = await committed(async (c) => {
      const pay = await honest(c, A, 'pay');
      await runS6(c, A, pay, { onAssertion: (a) => (assertion = a) });
      return pay;
    });
    expect(assertion).not.toBe('');
    await inTx(async (c) => {
      const before = await s6Counts(c, A.businessId);
      refusedWith(await tryS6(c, A, call, { assertion }), 'P0001', 'inventory.assertion_replayed');
      const again = expectAccepted(await tryS6(c, A, call), 'a fresh assertion replays the stored payment');
      expect(again.map((r) => r.replayed)).toEqual([true, true]);
      // Only the fresh assertion's own use is recorded; the replay writes nothing else.
      expect(await s6Counts(c, A.businessId), 'the replay writes nothing').toEqual({
        ...before,
        inventory_assertion_uses: Number(before.inventory_assertion_uses) + 1,
      });
    });
  });

  it('catalogue: the first statement of each routine consumes its own operation over the claimed digest of its own arguments', async () => {
    for (const kind of S6_KINDS) {
      const def = must((await ownerPool().query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [S6_ROUTINE_OF[kind]])).rows[0]).d;
      const body = must(def.split(/\nBEGIN\n/)[1], `${kind} body`)
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n')
        .trimStart();
      const op = S6_OP_OF[kind];
      expect(body.startsWith(`v_actor := inventory_assertion_consume('${op}', inventory_claimed_payload_digest('${op}',`), kind).toBe(true);
      const security = must(
        (
          await ownerPool().query<{ secdef: boolean; path: string[] | null }>(
            `SELECT prosecdef AS secdef, proconfig AS path FROM pg_proc WHERE oid = $1::regprocedure`,
            [S6_ROUTINE_OF[kind]],
          )
        ).rows[0],
      );
      expect(security, kind).toEqual({ secdef: true, path: ['search_path=pg_catalog, public, pg_temp'] });
    }
  });
});
