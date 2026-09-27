/**
 * P3-S5 T-02 — SIGNED AUTHORITY OF THE TWO S5 ENTRY ROUTINES
 * (docs/PHASE_3_S5_CONTRACT.md A-03, A-17, §2.5, §6 T-02; P3-AL-55).
 *
 * `purchase_return` and `purchase_reverse` each refuse — as their FIRST
 * decision, before anything is read, locked or written — a missing,
 * malformed, forged, expired, replayed or wrong-kind assertion, an assertion
 * minted for another business (another owner's, or the same owner's A2), and
 * an assertion over a payload with any one field changed
 * (`inventory.assertion_payload_mismatch`). Every DENY is paired with the
 * ALLOW of the same honest command.
 *
 * A `purchase.return` assertion cannot write a `purchase_reversal` movement,
 * nor a `purchase.reverse` one a `supplier_return` movement
 * (`inventory.movement_kind_not_authorized`); the four helpers re-verify
 * their operation, and the credit note is written only by its own helper
 * for its own stored return with a credit (R-55). The released-before AP a
 * return records (X) is cross-checked at COMMIT against the returns other
 * transactions committed: a forged X is `inventory.source_value_mismatch`
 * and nothing is written (R-54). The `invpl-s5` vectors are reproduced by the TS builders
 * and by the SQL canonicalizer, and the stored intent digests are the TS ones.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData } from '../helpers/test-app';
import {
  attempt,
  expectAccepted,
  must,
  ownerClient,
  refusedWith,
  scratch,
  seedS3World,
  type Outcome,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { runCommand, supplierCreate } from '../helpers/purchase-commands';
import { requestsJson, requestsParam, settle, type MovementRequest } from '../helpers/stock-ledger';
import { functionFacts } from '../helpers/purchase-settlement-fixture';
import {
  S5_HELPERS,
  S5_KINDS,
  S5_OP_OF,
  S5_ROUTINE_OF,
  assertionFor,
  commandOfVector,
  invplS5Vectors,
  payloadOf,
  prepareReturn,
  prepareReversal,
  rawPayloadSha256,
  receivedPurchase,
  runReturn,
  runReversal,
  runS5,
  s5Counts,
  tryReturn,
  tryS5,
  type PreparedReversal,
  type ReceivedPurchase,
  type ReturnCommand,
  type ReverseCommand,
  type S5Command,
  type S5Kind,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5auth');
});

afterAll(async () => {
  await resetData();
});

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

/** A fresh two-line received purchase of `biz`, in the caller's transaction. */
async function received(c: Client, biz: S3Business): Promise<ReceivedPurchase> {
  return receivedPurchase(c, biz, [
    { variantId: biz.piece.variantId, qty: '4', unitPriceMinor: '100' },
    { variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '70' },
  ]);
}

async function honestReturn(c: Client, biz: S3Business): Promise<ReturnCommand> {
  const p = await received(c, biz);
  const r = await prepareReturn(c, biz, p.purchaseId, {
    lines: [
      { purchaseLineId: must(p.lines[0]).lineId, qty: '1' },
      { purchaseLineId: must(p.lines[1]).lineId, qty: '2' },
    ],
    reason: 'Damaged on arrival',
  });
  return r.cmd;
}

async function honestReversal(c: Client, biz: S3Business): Promise<PreparedReversal> {
  return prepareReversal(c, biz, (await received(c, biz)).purchaseId);
}

/** An honest command of `kind`, in the caller's transaction. */
async function honestS5(c: Client, biz: S3Business, kind: S5Kind): Promise<S5Command> {
  return kind === 'purchase_return' ? honestReturn(c, biz) : (await honestReversal(c, biz)).cmd;
}

/** Every bound field of a command changed one at a time. */
function s5Tampers(cmd: S5Command, other: S3Business): readonly { field: string; cmd: S5Command }[] {
  const id = randomUUID();
  if (cmd.kind === 'purchase_return') {
    const l = must(cmd.lines[0]);
    const withLine = (over: Partial<ReturnCommand['lines'][number]>): ReturnCommand => ({ ...cmd, lines: [{ ...l, ...over }, ...cmd.lines.slice(1)] });
    return [
      { field: 'returnId', cmd: { ...cmd, returnId: id } },
      { field: 'purchaseId', cmd: { ...cmd, purchaseId: id } },
      { field: 'warehouseId', cmd: { ...cmd, warehouseId: other.w1 } },
      { field: 'documentDate', cmd: { ...cmd, documentDate: '2026-01-02' } },
      { field: 'reason', cmd: { ...cmd, reason: 'Damaged on arrival.' } },
      { field: 'reason → none', cmd: { ...cmd, reason: null } },
      { field: 'creditNoteId', cmd: { ...cmd, creditNoteId: id } },
      { field: 'carrying', cmd: { ...cmd, carryingTxnMinor: cmd.carryingTxnMinor + 1n } },
      { field: 'ap txn', cmd: { ...cmd, apTxnMinor: cmd.apTxnMinor - 1n } },
      { field: 'ap base', cmd: { ...cmd, apBaseMinor: cmd.apBaseMinor + 1n } },
      { field: 'credit txn', cmd: { ...cmd, creditTxnMinor: 1n } },
      { field: 'credit base', cmd: { ...cmd, creditBaseMinor: 1n } },
      { field: 'inventory value', cmd: { ...cmd, inventoryValueMinor: cmd.inventoryValueMinor + 1n } },
      { field: 'ppv', cmd: { ...cmd, ppvMinor: cmd.ppvMinor - 1n } },
      { field: 'line id', cmd: withLine({ returnLineId: id }) },
      { field: 'line purchase line', cmd: withLine({ purchaseLineId: id }) },
      { field: 'line variant', cmd: withLine({ variantId: other.piece.variantId }) },
      { field: 'line qty', cmd: withLine({ qtyQ4: l.qtyQ4 + 1n }) },
      { field: 'line carrying', cmd: withLine({ carryingTxnMinor: l.carryingTxnMinor + 1n }) },
      { field: 'line value out', cmd: withLine({ valueOutMinor: l.valueOutMinor + 1n }) },
      { field: 'a line dropped', cmd: { ...cmd, lines: cmd.lines.slice(1) } },
      { field: 'the line order', cmd: { ...cmd, lines: [...cmd.lines].reverse() } },
    ];
  }
  const l = must(cmd.lines[0]);
  const withLine = (over: Partial<ReverseCommand['lines'][number]>): ReverseCommand => ({ ...cmd, lines: [{ ...l, ...over }, ...cmd.lines.slice(1)] });
  return [
    { field: 'purchaseId', cmd: { ...cmd, purchaseId: id } },
    { field: 'warehouseId', cmd: { ...cmd, warehouseId: other.w1 } },
    { field: 'reversalDate', cmd: { ...cmd, reversalDate: '2026-01-02' } },
    { field: 'reason', cmd: { ...cmd, reason: `${must(cmd.reason)}.` } },
    { field: 'originalEntryId', cmd: { ...cmd, originalEntryId: id } },
    { field: 'total', cmd: { ...cmd, totalValueMinor: cmd.totalValueMinor + 1n } },
    { field: 'line id', cmd: withLine({ lineId: id }) },
    { field: 'line variant', cmd: withLine({ variantId: other.piece.variantId }) },
    { field: 'line qty', cmd: withLine({ qtyQ4: l.qtyQ4 - 1n }) },
    { field: 'line value', cmd: withLine({ valueMinor: l.valueMinor - 1n }) },
    { field: 'a line dropped', cmd: { ...cmd, lines: cmd.lines.slice(1) } },
    { field: 'the line order', cmd: { ...cmd, lines: [...cmd.lines].reverse() } },
  ];
}

describe('T-02 the assertion is the first decision of both S5 routines', () => {
  for (const kind of S5_KINDS) {
    it(`${kind}: none, malformed, forged or expired → refused, nothing written; the honest assertion → accepted`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const cmd = await honestS5(c, A, kind);
        const before = await s5Counts(c, A.businessId);
        refusedWith(await tryS5(c, A, cmd, { assertion: null }), 'P0001', 'inventory.assertion_missing');
        refusedWith(await tryS5(c, A, cmd, { assertion: 'invctl/1.garbage' }), 'P0001', 'inventory.assertion_malformed');
        const honest = assertionFor(A, cmd);
        refusedWith(await tryS5(c, A, cmd, { assertion: forged(honest) }), 'P0001', 'inventory.assertion_invalid_signature', 'a forged MAC');
        const expired = mintTestInventoryAssertion(
          { actorUserId: A.userId, tenantId: A.tenantId, businessId: A.businessId, opCode: S5_OP_OF[kind], payloadSha256: payloadOf(A, cmd).payload.sha256 },
          new Date(Date.now() - 600_000),
        );
        refusedWith(await tryS5(c, A, cmd, { assertion: expired }), 'P0001', 'inventory.assertion_expired', 'expired ten minutes ago');
        expect(await s5Counts(c, A.businessId), 'no refusal wrote anything').toEqual(before);
        expect(payloadOf(A, cmd).payload.sha256, 'the builder and the claimed stream agree').toBe(rawPayloadSha256(A, cmd));
        expectAccepted(await tryS5(c, A, cmd, { assertion: honest }), 'the honest command');
      });
    });

    it(`${kind}: an assertion of each other kind (S5, S4, S3, S1) → assertion_wrong_operation`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const cmd = await honestS5(c, A, kind);
        for (const other of S5_KINDS.filter((k) => k !== kind)) {
          refusedWith(await tryS5(c, A, cmd, { op: S5_OP_OF[other] }), 'P0001', 'inventory.assertion_wrong_operation', `${other} for ${kind}`);
        }
        for (const op of ['purchase.receive', 'purchase.draft', 'inventory.adjust', 'inventory.configure_product'] as const) {
          refusedWith(await tryS5(c, A, cmd, { op }), 'P0001', 'inventory.assertion_wrong_operation', `${op} for ${kind}`);
        }
        expectAccepted(await tryS5(c, A, cmd));
      });
    });

    it(`${kind}: every bound field changed one at a time → assertion_payload_mismatch, nothing written`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const cmd = await honestS5(c, A, kind);
        const list = s5Tampers(cmd, world.A2);
        const before = await s5Counts(c, A.businessId);
        for (const t of list) {
          refusedWith(await tryS5(c, A, cmd, { mintFor: t.cmd, raw: true }), 'P0001', 'inventory.assertion_payload_mismatch', `${kind} ${t.field}`);
        }
        expect(await s5Counts(c, A.businessId)).toEqual(before);
        expectAccepted(await tryS5(c, A, cmd));
      });
    });

    it(`${kind}: a replayed assertion is refused in the same transaction; a rolled-back first use may be retried`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const cmd = await honestS5(c, A, kind);
        const assertion = assertionFor(A, cmd);
        await scratch(c, async () => {
          expectAccepted(await tryS5(c, A, cmd, { assertion }), 'a first use, then rolled back');
        });
        expectAccepted(await tryS5(c, A, cmd, { assertion }), 'the identical payload after the rollback');
        refusedWith(await tryS5(c, A, cmd, { assertion }), 'P0001', 'inventory.assertion_replayed');
        const again = expectAccepted(await tryS5(c, A, cmd), 'a fresh assertion answers the stored document');
        expect(
          again.every((r) => r.replayed),
          'the command is idempotent',
        ).toBe(true);
      });
    });

    it(`${kind}: an assertion minted for another owner's business, or the same owner's A2, → assertion_scope_mismatch`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const cmd = await honestS5(c, A, kind);
        refusedWith(await tryS5(c, A, cmd, { mintBusiness: world.A2 }), 'P0001', 'inventory.assertion_scope_mismatch', 'minted for A2');
        refusedWith(await tryS5(c, A, cmd, { mintBusiness: world.B }), 'P0001', 'inventory.assertion_scope_mismatch', 'minted for B');
        // A's command under A2's scope GUCs with A's assertion: the verified business is A, and the GUCs disagree.
        refusedWith(await tryS5(c, A, cmd, { scope: world.A2 }), 'P0001', 'inventory.assertion_scope_mismatch', 'A2 scope GUCs');
        expectAccepted(await tryS5(c, A, cmd));
      });
    });
  }

  it('a replay in ANOTHER transaction, after the first committed, is refused', async () => {
    const A = world.A;
    const setup = await ownerClient();
    let prepared: PreparedReversal;
    let assertion = '';
    try {
      await setup.query('BEGIN');
      prepared = await honestReversal(setup, A);
      // The whole service run: the routine, then the Phase 2 reversal its deferred binding needs at COMMIT.
      await runReversal(setup, A, prepared, { onAssertion: (a) => (assertion = a) });
      await setup.query('COMMIT');
    } finally {
      await setup.end();
    }
    const cmd = prepared.cmd;
    await inTx(async (c) => {
      refusedWith(await tryS5(c, A, cmd, { assertion }), 'P0001', 'inventory.assertion_replayed');
      const again = expectAccepted(await tryS5(c, A, cmd), 'a fresh assertion replays the stored reversal');
      expect(again.every((r) => r.replayed)).toBe(true);
    });
  });
});

describe('T-02 a verified operation writes only its own movement kind', () => {
  /** The primitive called directly by the owner, under whatever operation the transaction verified. */
  async function primitive(c: Client, r: MovementRequest): Promise<Outcome<unknown>> {
    return attempt(c, () => c.query(`SELECT * FROM inventory_apply_stock_movements(${requestsParam(1)})`, [requestsJson([r])]));
  }

  it('under purchase.return: a purchase_reversal movement → movement_kind_not_authorized; under purchase.reverse: a supplier_return one → the same', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '10' }]);
      const ret = await honestReturn(c, A);
      const line = must(target.lines[0]);
      const reversalReq: MovementRequest = {
        warehouseId: A.w1,
        variantId: line.variantId,
        kind: 'purchase_reversal',
        sourceType: 'purchase_reversal',
        sourceId: target.purchaseId,
        sourceLineId: line.lineId,
        qty: '-1',
        unitCost: null,
        value: null,
        reason: null,
      };
      const returnReq: MovementRequest = { ...reversalReq, kind: 'supplier_return', sourceType: 'supplier_return', sourceId: randomUUID() };
      await runS5(c, A, ret);
      refusedWith(await primitive(c, reversalReq), 'P0001', 'inventory.movement_kind_not_authorized', 'purchase.return → purchase_reversal');
      await runS5(c, A, (await honestReversal(c, A)).cmd);
      refusedWith(await primitive(c, returnReq), 'P0001', 'inventory.movement_kind_not_authorized', 'purchase.reverse → supplier_return');
    });
  });

  it('catalogue: each routine first consumes its own kind; each helper re-verifies its operation', async () => {
    const q = ownerPool();
    for (const kind of S5_KINDS) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [S5_ROUTINE_OF[kind]])).rows[0]).d;
      const body = must(def.split(/\nBEGIN\n/)[1], `${kind} body`);
      expect(
        body.trimStart().startsWith(`v_actor := inventory_assertion_consume('${S5_OP_OF[kind]}', inventory_claimed_payload_digest('${S5_OP_OF[kind]}',`),
        kind,
      ).toBe(true);
    }
    const expected: Record<(typeof S5_HELPERS)[number], string> = {
      'purchase_lock_stock_keys(uuid,uuid[])': `ARRAY['purchase.return', 'purchase.reverse']`,
      'purchase_bridge_return(uuid)': `ARRAY['purchase.return']`,
      'purchase_bridge_credit_note(uuid)': `ARRAY['purchase.return']`,
      'purchase_bridge_reversal(uuid)': `ARRAY['purchase.reverse']`,
    };
    for (const helper of S5_HELPERS) {
      const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [helper])).rows[0]).d;
      expect(must(def.split(/\nBEGIN\n/)[1]).trimStart(), helper).toMatch(
        new RegExp(`^v_actor := inventory_assertion_current\\(${escape(expected[helper])}\\);`),
      );
    }
  });

  it('the helpers refuse a transaction with no consumed assertion, and one whose assertion is another S5 kind', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const calls = [
        { name: 'purchase_bridge_return', sql: `SELECT purchase_bridge_return($1::uuid)`, params: [randomUUID()], wrong: 'purchase_reverse' as const },
        {
          name: 'purchase_bridge_credit_note',
          sql: `SELECT purchase_bridge_credit_note($1::uuid)`,
          params: [randomUUID()],
          wrong: 'purchase_reverse' as const,
        },
        { name: 'purchase_bridge_reversal', sql: `SELECT purchase_bridge_reversal($1::uuid)`, params: [randomUUID()], wrong: 'purchase_return' as const },
        { name: 'purchase_lock_stock_keys', sql: `SELECT purchase_lock_stock_keys($1::uuid, ARRAY[$2::uuid])`, params: [A.w1, A.piece.variantId], wrong: null },
      ];
      for (const call of calls) {
        const none = await attempt(c, async () => {
          await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
          await c.query(call.sql, call.params);
        });
        expect(none.ok ? 'accepted' : none.code, `${call.name} with no consumed assertion`).toMatch(
          /^inventory\.assertion_(missing|not_consumed|wrong_operation)$/,
        );
      }
      // A consumed supplier.create does not open any of them.
      await runCommand(c, A, supplierCreate());
      for (const call of calls) {
        const o = await attempt(c, () => c.query(call.sql, call.params));
        refusedWith(o, 'P0001', 'inventory.assertion_wrong_operation', `${call.name} under supplier.create`);
      }
      // A consumed purchase.return does not open the reversal bridge, nor purchase.reverse the return bridge.
      for (const call of calls.filter((x) => x.wrong !== null)) {
        await scratch(c, async () => {
          await runS5(c, A, await honestS5(c, A, must(call.wrong)));
          refusedWith(
            await attempt(c, () => c.query(call.sql, call.params)),
            'P0001',
            'inventory.assertion_wrong_operation',
            `${call.name} under ${call.wrong}`,
          );
        });
      }
    });
  });
});

describe('T-02 R-55: the credit note has its own asserted writer', () => {
  it('catalogue: purchase_return writes the credit note only through purchase_bridge_credit_note, which no role may call', async () => {
    const q = ownerPool();
    const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [S5_ROUTINE_OF.purchase_return])).rows[0]).d;
    expect(def, 'the routine calls the helper').toContain('PERFORM purchase_bridge_credit_note(p_return_id);');
    expect(def, 'the routine inserts no credit note itself').not.toMatch(/INSERT\s+INTO\s+supplier_credit_notes/i);
    const helper = must(
      (
        await q.query<{ owner: string; secdef: boolean; grantees: string[] | null }>(
          `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
                  (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a
                    WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
             FROM pg_proc p WHERE p.oid = 'purchase_bridge_credit_note(uuid)'::regprocedure`,
        )
      ).rows[0],
    );
    expect(helper).toEqual({ owner: 'daftar_inventory_internal', secdef: true, grantees: null });
  });

  it('under a consumed purchase.return it writes nothing for a return with no credit, nor for an unknown return', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const cmd = await honestReturn(c, A);
      await runS5(c, A, cmd);
      expect(cmd.creditNoteId, 'the honest return issues no credit').toBeNull();
      const before = await s5Counts(c, A.businessId);
      for (const id of [cmd.returnId, randomUUID()]) {
        refusedWith(
          await attempt(c, () => c.query(`SELECT purchase_bridge_credit_note($1::uuid)`, [id])),
          'P0001',
          'inventory.source_type_not_authorized',
          id === cmd.returnId ? 'its own return, no credit' : 'an unknown return',
        );
      }
      expect(await s5Counts(c, A.businessId), 'nothing written').toEqual(before);
    });
  });
});

describe('T-02 R-54: the released-before AP (X) is cross-checked at COMMIT', () => {
  async function committed<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      const v = await fn(c);
      await c.query('COMMIT');
      return v;
    } finally {
      await c.end();
    }
  }

  /** `purchase_ap_outstanding` answering T whatever was returned — a forged O, so X = T − O = 0 — in the caller's transaction only. */
  async function forgeOutstanding(c: Client): Promise<void> {
    await c.query(`CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
                   LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
                   BEGIN RETURN (SELECT p.total_txn_minor FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id); END; $$`);
  }

  async function storedX(q: Client, businessId: string, returnId: string): Promise<string | null> {
    const r = await q.query<{ x: string }>(`SELECT ap_released_before_txn_minor::text AS x FROM supplier_returns WHERE business_id = $1 AND id = $2`, [
      businessId,
      returnId,
    ]);
    return r.rows[0]?.x ?? null;
  }

  it('a return whose X forgets a return another transaction committed fails COMMIT with source_value_mismatch, writing nothing; the honest X commits', async () => {
    const A = world.A;
    const honestFacts = await functionFacts(ownerPool(), 'purchase_ap_outstanding(uuid,uuid)');
    // Committed on W2, so the rolled-back cases on W1 keep starting from empty keys.
    const p = await committed((c) => receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }], { warehouseId: A.w2 }));
    const lines = [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }];
    const first = await committed(async (c) => {
      const prep = await prepareReturn(c, A, p.purchaseId, { lines });
      await runReturn(c, A, prep);
      return prep;
    });
    const released = first.cmd.apTxnMinor;
    expect(released, 'the first return released AP').toBeGreaterThan(0n);
    const before = await s5Counts(ownerPool(), A.businessId);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await forgeOutstanding(c);
      const prep = await prepareReturn(c, A, p.purchaseId, { lines });
      // Signed, routine-accepted and posted: every immediate check holds, because the forged O is consistent with itself.
      expectAccepted(await tryReturn(c, A, prep), 'the forged return is taken by the routine');
      expect(await storedX(c, A.businessId, prep.cmd.returnId), 'X = T − forged O = 0').toBe('0');
      refusedWith(await settle(() => c.query('COMMIT')), 'P0001', 'inventory.source_value_mismatch', `X = 0 < ${released} released by the committed return`);
    } finally {
      await c.end();
    }
    expect(await s5Counts(ownerPool(), A.businessId), 'nothing written').toEqual(before);
    expect(await functionFacts(ownerPool(), 'purchase_ap_outstanding(uuid,uuid)'), 'the forge went with its transaction').toEqual(honestFacts);
    // The honest second return records X = the AP the first released, and commits.
    const honest = await committed(async (h) => {
      const prep = await prepareReturn(h, A, p.purchaseId, { lines });
      await runReturn(h, A, prep);
      return prep;
    });
    const r = await ownerClient();
    try {
      expect(await storedX(r, A.businessId, honest.cmd.returnId)).toBe(released.toString(10));
    } finally {
      await r.end();
    }
  });
});

describe('T-02 the invpl-s5 vectors: TS builders = SQL canonicalizer = vector', () => {
  for (const v of invplS5Vectors()) {
    it(`${v.id}: ${v.why}`, async () => {
      const q = ownerPool();
      const cmd = commandOfVector(v);
      const biz = { tenantId: v.tenantId, businessId: v.businessId };
      const built = payloadOf(biz, cmd);
      expect(built.payload.sha256, 'the TS builder: payload').toBe(v.payload.sha256);
      expect(built.payload.bytes.toString('hex'), 'the TS builder: canonical bytes').toBe(v.payload.canonicalHex);
      expect(built.intentSha256, 'the TS builder: intent').toBe(v.intent.sha256);
      expect(rawPayloadSha256(biz, cmd), 'the claimed stream of the routine arguments').toBe(v.payload.sha256);
      for (const [what, s] of [
        ['payload', v.payload],
        ['intent', v.intent],
      ] as const) {
        const d = must(
          (
            await q.query<{ d: string }>(`SELECT inventory_payload_digest($1, $2::uuid, $3::uuid, $4::text[], $5::text[]) AS d`, [
              v.opCode,
              v.tenantId,
              v.businessId,
              s.fields.map((f) => f.type),
              s.fields.map((f) => f.value),
            ])
          ).rows[0],
        ).d;
        expect(d, `the SQL canonicalizer: ${what}`).toBe(s.sha256);
      }
      const words = must((await q.query<{ w: string[] | null }>(`SELECT inventory_reason_words($1::text)::text[] AS w`, [cmd.reason])).rows[0]).w;
      expect(words, 'the SQL reason words').toEqual(v.payload.fields.filter((f) => f.name.startsWith('reason_w')).map((f) => f.value));
    });
  }

  it('the stored intent digest of an accepted return and reversal is the TS intent', async () => {
    await inTx(async (c) => {
      const A = world.A;
      for (const kind of S5_KINDS) {
        const cmd = await honestS5(c, A, kind);
        await runS5(c, A, cmd);
        const table = kind === 'purchase_return' ? 'supplier_returns' : 'purchase_reversals';
        const id = cmd.kind === 'purchase_return' ? cmd.returnId : cmd.purchaseId;
        const stored = must(
          (await c.query<{ i: string }>(`SELECT intent_sha256 AS i FROM ${table} WHERE business_id = $1 AND id = $2`, [A.businessId, id])).rows[0],
        ).i;
        expect(stored, kind).toBe(payloadOf(A, cmd).intentSha256);
      }
    });
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
