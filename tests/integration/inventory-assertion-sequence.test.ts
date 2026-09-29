/**
 * P3-S6 A-19 — THE INVENTORY-ASSERTION SEQUENCE OF SEAM 2
 * (docs/PHASE_3_S6_CONTRACT.md A-19, §6 "apps/api unit tests";
 * `apps/api/src/infra/database.ts` `InventoryAssertionSequence`,
 * `presentInventoryAssertion`).
 *
 * The sibling of R-B1's accounting sequence. First the pure rules, with no
 * connection: every element coherence-checked, a duplicate `malformed`, an
 * empty tuple `missing`, a single string exactly the old seam, `next` refusing
 * an operation that is not its claim and a call beyond the last, and a STRICT
 * `assertComplete`. Then the same rules through the real `Database` of the
 * application: the GUC starts empty with two or more assertions, each
 * presentation sets exactly its element, and a commit that left one
 * unpresented rolls back.
 *
 * The routines of 0067/0068 are not needed here and are not called: the seam
 * only carries the assertions, and verifying them is the database's (T-14 and
 * T-13 run the combined command end to end).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InventoryOperationCode } from '@daftar/inventory';
import {
  Database,
  InventoryAssertionSequence,
  presentInventoryAssertion,
  TransactionSeamError,
  type BusinessInventoryAccountingTransaction,
  type BusinessScope,
} from '../../apps/api/src/infra/database';
import { createTestApp, ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { seedPostingFixture, sourceAssertion, type PostingFixture } from '../helpers/accounting-posting';

function seamCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    throw e;
  }
  return 'accepted';
}

async function seamCodeAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('InventoryAssertionSequence — the pure rules', () => {
  const scope: BusinessScope = { tenantId: randomUUID(), businessId: randomUUID(), actorUserId: randomUUID(), businessTransactionId: randomUUID() };
  const mint = (opCode: InventoryOperationCode, over: Partial<BusinessScope> = {}): string =>
    mintTestInventoryAssertion({
      actorUserId: scope.actorUserId,
      tenantId: over.tenantId ?? scope.tenantId,
      businessId: over.businessId ?? scope.businessId,
      opCode,
      payloadSha256: randomUUID().replaceAll('-', '').repeat(2),
    });

  it('a string, or a one-element tuple, is the single-assertion seam: the GUC is the assertion, no sequence', () => {
    const one = mint('purchase.receive');
    for (const form of [one, [one] as const]) {
      const plan = InventoryAssertionSequence.plan(scope, form);
      expect(plan.guc).toBe(one);
      expect(plan.sequence).toBeNull();
      expect(plan.singleOperation).toBe('purchase.receive');
    }
  });

  it('two or more: the GUC starts empty and each is handed out once, in order, for its own operation', () => {
    const receive = mint('purchase.receive');
    const pay = mint('supplier.pay');
    const plan = InventoryAssertionSequence.plan(scope, [receive, pay]);
    expect(plan.guc).toBe('');
    expect(plan.singleOperation).toBeNull();
    const sequence = plan.sequence;
    if (sequence === null) throw new Error('expected a sequence');
    expect(seamCode(() => sequence.assertComplete())).toBe('seam.inventory_assertion_unused');
    expect(sequence.next('purchase.receive')).toBe(receive);
    expect(seamCode(() => sequence.assertComplete())).toBe('seam.inventory_assertion_unused');
    expect(sequence.next('supplier.pay')).toBe(pay);
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
    expect(seamCode(() => sequence.next('supplier.pay'))).toBe('seam.inventory_assertion_exhausted');
  });

  it('an operation that is not the next claim is refused, and consumes nothing', () => {
    const sequence = InventoryAssertionSequence.plan(scope, [mint('purchase.receive'), mint('supplier.pay')]).sequence;
    if (sequence === null) throw new Error('expected a sequence');
    expect(seamCode(() => sequence.next('supplier.pay'))).toBe('seam.inventory_assertion_operation_mismatch');
    expect(seamCode(() => sequence.next('purchase.receive'))).toBe('accepted');
    expect(seamCode(() => sequence.next('purchase.return'))).toBe('seam.inventory_assertion_operation_mismatch');
  });

  it('refuses before any connection: an empty tuple, a duplicate, a malformed element, another scope, a malformed trace', () => {
    const a = mint('purchase.receive');
    // The type forbids an empty tuple; the runtime refuses one all the same.
    expect(seamCode(() => Reflect.apply(InventoryAssertionSequence.plan, InventoryAssertionSequence, [scope, []]))).toBe('seam.inventory_assertion_missing');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, ''))).toBe('seam.inventory_assertion_missing');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [a, a]))).toBe('seam.inventory_assertion_malformed');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [a, 'invctl1.not.an.assertion']))).toBe('seam.inventory_assertion_malformed');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [a, mint('supplier.pay', { businessId: randomUUID() })]))).toBe(
      'seam.inventory_assertion_scope_mismatch',
    );
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [a, mint('supplier.pay', { tenantId: randomUUID() })]))).toBe(
      'seam.inventory_assertion_scope_mismatch',
    );
    expect(seamCode(() => InventoryAssertionSequence.plan({ ...scope, businessTransactionId: 'nope' }, a))).toBe('seam.business_transaction_id_malformed');
  });

  it('presentInventoryAssertion refuses anything that is not a seam-2 handle', async () => {
    const forged = Object.freeze({ scope, query: async () => ({ rows: [] }), accounting: Object.freeze(Object.create(null)) });
    // A look-alike carries no brand, so only an untyped call can even try it.
    const attempt = async (): Promise<void> => {
      const pending: unknown = Reflect.apply(presentInventoryAssertion, undefined, [forged, 'supplier.pay']);
      await pending;
    };
    expect(await seamCodeAsync(attempt)).toBe('seam.inventory_assertion_missing');
  });
});

describe('InventoryAssertionSequence — through the real seam 2', () => {
  let t: TestApp;
  let db: Database;
  let fx: PostingFixture;
  let scope: BusinessScope;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    fx = await seedPostingFixture(ownerPool(), 's6seq');
    scope = { tenantId: fx.tenantId, businessId: fx.businessId, actorUserId: fx.userId, businessTransactionId: randomUUID() };
    t = await createTestApp();
    db = t.app.get(Database);
  }, 180_000);

  afterAll(async () => {
    await t.close();
  });

  const mint = (opCode: InventoryOperationCode): string =>
    mintTestInventoryAssertion({ actorUserId: fx.userId, tenantId: fx.tenantId, businessId: fx.businessId, opCode, payloadSha256: 'b'.repeat(64) });
  const accounting = (): string =>
    sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'post',
      sourceType: 'supplier_payment',
      sourceId: randomUUID(),
      postingFingerprint: 'c'.repeat(64),
    });
  const guc = async (tx: BusinessInventoryAccountingTransaction): Promise<string> =>
    (await tx.query<{ v: string }>(`SELECT coalesce(current_setting('app.inventory_assertion', true), '') AS v`)).rows[0]?.v ?? '';

  it('the GUC starts empty, and each presentation sets exactly its element', async () => {
    const receive = mint('purchase.receive');
    const pay = mint('supplier.pay');
    const seen = await db.withBusinessInventoryAccountingTransaction(scope, [receive, pay], accounting(), async (tx) => {
      const before = await guc(tx);
      await presentInventoryAssertion(tx, 'purchase.receive');
      const first = await guc(tx);
      await presentInventoryAssertion(tx, 'supplier.pay');
      const second = await guc(tx);
      return { before, first, second };
    });
    expect(seen).toEqual({ before: '', first: receive, second: pay });
  });

  it('a commit that left an assertion unpresented is refused, as is a presentation beyond the last or out of order', async () => {
    const pair = (): [string, string] => [mint('purchase.receive'), mint('supplier.pay')];
    expect(
      await seamCodeAsync(() =>
        db.withBusinessInventoryAccountingTransaction(scope, pair(), accounting(), async (tx) => {
          await presentInventoryAssertion(tx, 'purchase.receive');
        }),
      ),
    ).toBe('seam.inventory_assertion_unused');
    expect(await seamCodeAsync(() => db.withBusinessInventoryAccountingTransaction(scope, pair(), accounting(), async () => undefined))).toBe(
      'seam.inventory_assertion_unused',
    );
    expect(
      await seamCodeAsync(() =>
        db.withBusinessInventoryAccountingTransaction(scope, pair(), accounting(), async (tx) => {
          await presentInventoryAssertion(tx, 'supplier.pay');
        }),
      ),
    ).toBe('seam.inventory_assertion_operation_mismatch');
    expect(
      await seamCodeAsync(() =>
        db.withBusinessInventoryAccountingTransaction(scope, pair(), accounting(), async (tx) => {
          await presentInventoryAssertion(tx, 'purchase.receive');
          await presentInventoryAssertion(tx, 'supplier.pay');
          await presentInventoryAssertion(tx, 'supplier.pay');
        }),
      ),
    ).toBe('seam.inventory_assertion_exhausted');
  });

  it('a single string is the old seam: set at BEGIN, nothing to present, and presenting its own operation is a no-op', async () => {
    const receive = mint('purchase.receive');
    const seen = await db.withBusinessInventoryAccountingTransaction(scope, receive, accounting(), async (tx) => {
      const before = await guc(tx);
      await presentInventoryAssertion(tx, 'purchase.receive');
      return { before, after: await guc(tx) };
    });
    expect(seen).toEqual({ before: receive, after: receive });
    expect(await seamCodeAsync(() => db.withBusinessInventoryAccountingTransaction(scope, receive, accounting(), async () => undefined))).toBe('accepted');
    expect(
      await seamCodeAsync(() =>
        db.withBusinessInventoryAccountingTransaction(scope, receive, accounting(), async (tx) => {
          await presentInventoryAssertion(tx, 'supplier.pay');
        }),
      ),
    ).toBe('seam.inventory_assertion_operation_mismatch');
  });

  it('a handle that escaped its transaction cannot present', async () => {
    let escaped: BusinessInventoryAccountingTransaction | undefined;
    await expect(
      db.withBusinessInventoryAccountingTransaction(scope, [mint('purchase.receive'), mint('supplier.pay')], accounting(), async (tx) => {
        escaped = tx;
      }),
    ).rejects.toThrow(TransactionSeamError);
    if (escaped === undefined) throw new Error('the callback did not run');
    const handle = escaped;
    expect(await seamCodeAsync(() => presentInventoryAssertion(handle, 'purchase.receive'))).toBe('seam.transaction_closed');
  });
});
