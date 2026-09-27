/**
 * P3-S8 T-12 — THE NEGATIVE CONTROLS S8 ADDS
 * (docs/PHASE_3_S8_CONTRACT.md §6.2 rows marked "S8 adds", A-14, Annex R row 18).
 *
 * Every control builds its OWN scratch database with the shared helper
 * (`createScratchDb`: bootstrap, the real migrations, the test keys), seeds
 * the S3 world, commits the state the attack needs, and then:
 *   1. runs the attack as shipped — it is refused, with the stable code (or
 *      the named constraint) of the invariant under test, and nothing commits;
 *   2. removes that one invariant (a trigger dropped, a constraint dropped, a
 *      refusal demoted to a NOTICE with `withoutRefusal`, or a routine
 *      rewritten from its own `pg_get_functiondef` text — owner, ACL and
 *      SECURITY DEFINER kept by `CREATE OR REPLACE`);
 *   3. runs the SAME attack again: it commits, and the damage is read back.
 * Where an invariant is held in two physical places (a routine's stable
 * refusal in front of a UNIQUE), the control shows the second layer refusing
 * on its own before removing it too.
 *
 * The database is dropped (`WITH (FORCE)`) whatever happened.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PERMISSIONS, PERMISSIONS } from '../../packages/domain-core/src/permissions';
import { normalizeIndustryProfileKey } from '../../packages/domain-core/src/industry-profiles';
import type { PostingCommand } from '../../packages/accounting/src/types';
import { ensurePostgres, mintTestAssertion } from '../helpers/test-app';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import {
  expectAccepted,
  expectConstraint,
  must,
  pidOf,
  refusedWith,
  runCommand as runStockCommand,
  seedS3World,
  settle,
  transferCommand,
  waitUntilBlocked,
  withoutRefusal,
  type Outcome,
  type Queryable,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { applyAsApp, installStockFixture, req } from '../helpers/stock-ledger';
import {
  FULL_CONTACTS,
  ROUTINE_OF,
  createSupplier,
  draftCommand,
  honestDraft,
  postInTx,
  prepareReceipt,
  runCommand,
  runReceipt,
  type DraftCommand,
  type PreparedReceipt,
} from '../helpers/purchase-commands';
import { prepareReturn, receivedPurchase, returnGoods, runReturn, type PreparedReturn } from '../helpers/purchase-returns';
import { createMethod, payInFull, preparePay, prepareRefund, runS6, sqlReturnToCredit, type S6Call } from '../helpers/supplier-settlement';
import { seedDeficitKey } from '../helpers/purchase-deficits';
import { OP_KIND_BUILDERS, mintHonest, type PreparedKind, type ResultRow } from '../helpers/op-kind-builders';

const PRIMITIVE = 'inventory_apply_stock_movements(inventory_movement_request[])';

beforeAll(async () => {
  await ensurePostgres();
});

// ── the scratch database of one control ────────────────────────────────────

/** One control's own database, seeded with the S3 world; always dropped. */
async function withScratch(pm: string, fn: (db: ScratchDb, w: S3World) => Promise<void>): Promise<void> {
  const db = await createScratchDb(`daftar_p3s8_t12_${pm}`);
  try {
    await fn(db, await seedS3World(db.pool, `t12${pm}`));
  } finally {
    await db.drop();
  }
}

async function connect(db: ScratchDb): Promise<Client> {
  const c = new Client({ connectionString: db.url() });
  await c.connect();
  return c;
}

/**
 * `fn`, then COMMIT, on a fresh superuser connection: the outcome of the
 * whole transaction. A refusal at any statement or at COMMIT rolls it back.
 */
async function tx<T>(db: ScratchDb, fn: (c: Client) => Promise<T>): Promise<Outcome<T>> {
  const c = await connect(db);
  try {
    await c.query('BEGIN');
    const o = await settle(async () => {
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    });
    if (!o.ok) await c.query('ROLLBACK');
    return o;
  } finally {
    await c.end();
  }
}

/** `tx` that must commit (the state an attack needs). */
async function committed<T>(db: ScratchDb, fn: (c: Client) => Promise<T>): Promise<T> {
  return expectAccepted(await tx(db, fn), 'the control’s setup');
}

/** Replace exactly one occurrence of `from` in `routine`'s own definition and install it (the superuser keeps owner, ACL and SECURITY). */
async function rewriteRoutine(q: Queryable, routine: string, from: string, to: string): Promise<void> {
  const def = must((await q.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [routine])).rows[0]).d;
  const parts = def.split(from);
  if (parts.length !== 2) throw new Error(`control: ${routine} holds ${parts.length - 1} copies of the text to replace, not one`);
  await q.query(parts.join(to));
}

/** Demote `code` in every routine of `public` that raises it (the §0 convention), answering their signatures. */
async function demoteEverywhere(q: Queryable, code: string): Promise<string[]> {
  const r = await q.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND strpos(p.prosrc, $1) > 0
      ORDER BY 1`,
    [`RAISE EXCEPTION '${code}:`],
  );
  for (const row of r.rows) await withoutRefusal(q, row.sig, code);
  return r.rows.map((x) => x.sig);
}

async function scalar(q: Queryable, sql: string, params: unknown[]): Promise<string> {
  const row = must((await q.query<{ v: string | null }>(sql, params)).rows[0], sql);
  return row.v ?? '';
}

async function cashOf(q: Queryable, businessId: string): Promise<string> {
  return scalar(q, `SELECT id::text AS v FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);
}

async function levelOnHand(q: Queryable, biz: S3Business, warehouseId: string, variantId: string): Promise<string> {
  return scalar(q, `SELECT on_hand::text AS v FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
    biz.businessId,
    warehouseId,
    variantId,
  ]);
}

async function ledgerOnHand(q: Queryable, biz: S3Business, warehouseId: string, variantId: string): Promise<string> {
  return scalar(q, `SELECT sum(qty_delta)::text AS v FROM stock_movements WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
    biz.businessId,
    warehouseId,
    variantId,
  ]);
}

/** R6 for one key, as the superuser under the business's scope: does the cache equal the fold of its ledger? */
async function keyVerifies(db: ScratchDb, biz: S3Business, warehouseId: string, variantId: string): Promise<boolean> {
  return committed(db, async (c) => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [biz.tenantId, biz.businessId]);
    const r = await c.query<{ matches: boolean }>(`SELECT matches FROM inventory_stock_verify($1, $2, $3)`, [biz.businessId, warehouseId, variantId]);
    return must(r.rows[0], 'inventory_stock_verify row').matches;
  });
}

/** A draft of `lines` for a fresh supplier (or `supplierId`), saved and committed. */
async function savedDraft(
  db: ScratchDb,
  biz: S3Business,
  warehouseId: string,
  lines: readonly { variantId: string; qty: string; unitPriceMinor: string }[],
  supplierId?: string,
): Promise<DraftCommand> {
  return committed(db, async (c) => {
    const draft = await draftCommand(c, supplierId ?? (await createSupplier(c, biz, FULL_CONTACTS)), warehouseId, lines);
    await runCommand(c, biz, draft);
    return draft;
  });
}

// ── PM-23, PM-38, PM-17: one guard each, dropped ───────────────────────────

describe('T-12 schema guards', () => {
  it('PM-23 NC: without purchases_tax_policy_absent_ck an invented tax_minor = 1 (carried into the total) commits', async () => {
    await withScratch('pm23', async (db, { A }) => {
      const purchaseId = await committed(db, async (c) => {
        const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
        await runCommand(c, A, draft);
        return draft.purchaseId;
      });
      const invent = (c: Client): Promise<unknown> =>
        c.query(`UPDATE purchases SET tax_minor = 1, total_txn_minor = total_txn_minor + 1, revision = revision + 1 WHERE business_id = $1 AND id = $2`, [
          A.businessId,
          purchaseId,
        ]);
      expectConstraint(await tx(db, invent), '23514', 'purchases_tax_policy_absent_ck', 'as shipped');
      await db.pool.query(`ALTER TABLE purchases DROP CONSTRAINT purchases_tax_policy_absent_ck`);
      expectAccepted(await tx(db, invent), 'without the CHECK');
      expect(await scalar(db.pool, `SELECT tax_minor::text AS v FROM purchases WHERE business_id = $1 AND id = $2`, [A.businessId, purchaseId])).toBe('1');
    });
  });

  it('PM-38 NC: without product_variants_10_base_variant_authority daftar_app’s raw UPDATE turns the hidden base variant into a merchant variant', async () => {
    await withScratch('pm38', async (db, { A }) => {
      const hijack = async (c: Client): Promise<number> => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
        await c.query('SET LOCAL ROLE daftar_app');
        const r = await c.query(`UPDATE product_variants SET is_base = false WHERE business_id = $1 AND id = $2`, [A.businessId, A.piece.variantId]);
        await c.query('RESET ROLE');
        return r.rowCount ?? 0;
      };
      refusedWith(await tx(db, hijack), 'P0001', 'catalog.base_variant_not_mutable', 'as shipped');
      await db.pool.query(`DROP TRIGGER product_variants_10_base_variant_authority ON product_variants`);
      expect(expectAccepted(await tx(db, hijack), 'without the guard'), 'the base variant row was reachable').toBe(1);
      expect(
        await scalar(db.pool, `SELECT is_base::text AS v FROM product_variants WHERE business_id = $1 AND id = $2`, [A.businessId, A.piece.variantId]),
      ).toBe('false');
    });
  });

  it('PM-17 NC: without the 0058 accounting_entry_date_guard the owner’s raw journal entry dated tomorrow commits', async () => {
    await withScratch('pm17', async (db, { A }) => {
      const tomorrow = await scalar(db.pool, `SELECT to_char((now() AT TIME ZONE timezone)::date + 1, 'YYYY-MM-DD') AS v FROM businesses WHERE id = $1`, [
        A.businessId,
      ]);
      const accounts = (
        await db.pool.query<{ key: string; id: string }>(
          `SELECT system_key AS key, id::text FROM accounts WHERE business_id = $1 AND system_key IN ('cash', 'sales_revenue')`,
          [A.businessId],
        )
      ).rows;
      const accountOf = (key: string): string =>
        must(
          accounts.find((a) => a.key === key),
          key,
        ).id;
      const futureEntry = async (c: Client): Promise<void> => {
        const entryId = randomUUID();
        const sourceId = randomUUID();
        await c.query(
          `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id) VALUES ($1, $2, 'manual_adjustment', $3, $4)`,
          [A.tenantId, A.businessId, sourceId, entryId],
        );
        await c.query(`INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id) VALUES ($1, $2, $3, 't12', $4)`, [
          A.tenantId,
          A.businessId,
          sourceId,
          A.userId,
        ]);
        await c.query(
          `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                        actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
           VALUES ($1, $2, $3, $4::date, 'manual_adjustment', $5, 't12', 'user', $6, NULL, 't12', repeat('a', 64))`,
          [A.tenantId, A.businessId, entryId, tomorrow, sourceId, A.userId],
        );
        for (const [lineNo, key, debit, credit] of [
          [1, 'cash', 100, 0],
          [2, 'sales_revenue', 0, 100],
        ] as const) {
          await c.query(
            `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id, debit_minor, credit_minor, base_amount_minor,
                                        base_currency, txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
             VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, 100, 'ILS', 100, 'ILS', 1, 'base', date_trunc('second', now()))`,
            [A.tenantId, A.businessId, entryId, lineNo, accountOf(key), debit, credit],
          );
        }
      };
      refusedWith(await tx(db, futureEntry), 'P0001', 'accounting.entry_date_in_future', 'as shipped');
      await db.pool.query(`DROP TRIGGER accounting_entry_date_guard ON journal_entries`);
      expectAccepted(await tx(db, futureEntry), 'without the guard');
      expect(
        await scalar(db.pool, `SELECT count(*)::text AS v FROM journal_entries WHERE business_id = $1 AND entry_date = $2::date`, [A.businessId, tomorrow]),
      ).toBe('1');
    });
  });
});

// ── S4: the purchase document ──────────────────────────────────────────────

describe('T-12 purchase documents', () => {
  it('PM-08 NC: without the deferred purchase_allocations_consistent trigger the tampered allocation (+1) commits', async () => {
    await withScratch('pm08', async (db, { A }) => {
      const purchaseId = await committed(db, async (c) => {
        const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
        await runCommand(c, A, draft);
        return draft.purchaseId;
      });
      const tamper = async (c: Client): Promise<string> => {
        const row = must(
          (
            await c.query<{ landed_cost_id: string; purchase_line_id: string; amount: string }>(
              `DELETE FROM purchase_landed_cost_allocations
                WHERE business_id = $1 AND (landed_cost_id, purchase_line_id) =
                      (SELECT landed_cost_id, purchase_line_id FROM purchase_landed_cost_allocations WHERE business_id = $1 AND purchase_id = $2
                        ORDER BY landed_cost_id, purchase_line_id LIMIT 1)
                RETURNING landed_cost_id::text, purchase_line_id::text, amount_txn_minor::text AS amount`,
              [A.businessId, purchaseId],
            )
          ).rows[0],
        );
        await c.query(
          `INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [A.tenantId, A.businessId, purchaseId, row.landed_cost_id, row.purchase_line_id, (BigInt(row.amount) + 1n).toString()],
        );
        return row.landed_cost_id;
      };
      refusedWith(await tx(db, tamper), 'P0001', 'purchase.landed_cost_allocation_mismatch', 'as shipped, at COMMIT');
      await db.pool.query(`DROP TRIGGER purchase_allocations_consistent ON purchase_landed_cost_allocations`);
      const costId = expectAccepted(await tx(db, tamper), 'without the deferred trigger');
      const r = must(
        (
          await db.pool.query<{ amount: string; allocated: string }>(
            `SELECT c.amount_txn_minor::text AS amount,
                    (SELECT sum(a.amount_txn_minor) FROM purchase_landed_cost_allocations a WHERE a.business_id = c.business_id AND a.landed_cost_id = c.id)::text AS allocated
               FROM purchase_landed_costs c WHERE c.business_id = $1 AND c.id = $2`,
            [A.businessId, costId],
          )
        ).rows[0],
      );
      expect(BigInt(r.allocated), 'the cost is now allocated one unit more than it is').toBe(BigInt(r.amount) + 1n);
    });
  });

  it('PM-09 NC: without the duplicate-variant check (the routine’s refusal and purchase_lines_variant_uq) one variant commits on two lines', async () => {
    await withScratch('pm09', async (db, { A }) => {
      const supplierId = await committed(db, (c) => createSupplier(c, A, FULL_CONTACTS));
      const twice = async (c: Client): Promise<string> => {
        const draft = await draftCommand(c, supplierId, A.w1, [
          { variantId: A.piece.variantId, qty: '1', unitPriceMinor: '1000' },
          { variantId: A.piece.variantId, qty: '1', unitPriceMinor: '3000' },
        ]);
        await runCommand(c, A, draft, { raw: true });
        return draft.purchaseId;
      };
      refusedWith(await tx(db, twice), 'P0001', 'purchase.duplicate_variant', 'as shipped');
      await withoutRefusal(db.pool, ROUTINE_OF.purchase_draft, 'purchase.duplicate_variant');
      expectConstraint(await tx(db, twice), '23505', 'purchase_lines_variant_uq', 'the routine’s refusal removed: the UNIQUE still holds');
      await db.pool.query(`ALTER TABLE purchase_lines DROP CONSTRAINT purchase_lines_variant_uq`);
      const purchaseId = expectAccepted(await tx(db, twice), 'both layers removed');
      expect(
        await scalar(db.pool, `SELECT count(*)::text AS v FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 AND variant_id = $3`, [
          A.businessId,
          purchaseId,
          A.piece.variantId,
        ]),
      ).toBe('2');
    });
  });

  it('PM-19 NC: without the purchase_landed_cost_allocations_freeze trigger a row of a received purchase is deleted', async () => {
    await withScratch('pm19', async (db, { A }) => {
      const p = await committed(db, (c) =>
        receivedPurchase(
          c,
          A,
          [
            { variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' },
            { variantId: A.piece2.variantId, qty: '1', unitPriceMinor: '500' },
          ],
          { landedCosts: [{ landedCostId: randomUUID(), mode: 'by_value', amountMinor: 300n, description: 'freight', allocations: null }] },
        ),
      );
      const line = must(p.lines[0]).lineId;
      const count = (): Promise<string> =>
        scalar(db.pool, `SELECT count(*)::text AS v FROM purchase_landed_cost_allocations WHERE business_id = $1 AND purchase_id = $2`, [
          A.businessId,
          p.purchaseId,
        ]);
      expect(await count()).toBe('2');
      const erase = (c: Client): Promise<unknown> =>
        c.query(`DELETE FROM purchase_landed_cost_allocations WHERE business_id = $1 AND purchase_id = $2 AND purchase_line_id = $3`, [
          A.businessId,
          p.purchaseId,
          line,
        ]);
      refusedWith(await tx(db, erase), 'P0001', 'inventory.source_line_frozen', 'as shipped');
      await db.pool.query(`DROP TRIGGER purchase_landed_cost_allocations_freeze ON purchase_landed_cost_allocations`);
      expectAccepted(await tx(db, erase), 'without the freeze');
      expect(await count(), 'a historical row of the received purchase is gone').toBe('1');
    });
  });

  it('PM-05 NC: an inventory_configure_product without its base-variant INSERT leaves a tracked product with no stock key', async () => {
    await withScratch('pm05', async (db, { A, A2 }) => {
      const b = must(OP_KIND_BUILDERS['inventory.configure_product']);
      const cashAccountId = await cashOf(db.pool, A.businessId);
      const configure = async (c: Client): Promise<string> => {
        const p: PreparedKind = await b.prepare(c, { biz: A, other: A2, cashAccountId });
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
                  set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
          [A.tenantId, A.businessId, mintHonest(A, b.op, p.sha256(A)), p.trace],
        );
        await c.query('SET LOCAL ROLE daftar_app');
        const rows = (await c.query<ResultRow>(p.sql, [...p.params])).rows;
        await c.query('RESET ROLE');
        await p.post(c, rows);
        const productId = p.params[0];
        if (typeof productId !== 'string') throw new Error('the configure call names its product first');
        return productId;
      };
      const variants = (productId: string): Promise<string> =>
        scalar(db.pool, `SELECT count(*)::text AS v FROM product_variants WHERE business_id = $1 AND product_id = $2`, [A.businessId, productId]);
      const shipped = expectAccepted(await tx(db, configure), 'as shipped');
      expect(await variants(shipped), 'as shipped: the hidden base variant is the stock key').toBe('1');
      await rewriteRoutine(
        db.pool,
        'inventory_configure_product(uuid,boolean,text,smallint)',
        `INSERT INTO product_variants (business_id, id, product_id, is_base)
      VALUES (v_business, gen_random_uuid(), p_product_id, true)
      ON CONFLICT (business_id, product_id) WHERE is_base DO NOTHING;
      v_created := FOUND;`,
        `v_created := false;`,
      );
      const bare = expectAccepted(await tx(db, configure), 'without the base-variant creation');
      expect(await scalar(db.pool, `SELECT track_inventory::text AS v FROM products WHERE business_id = $1 AND id = $2`, [A.businessId, bare])).toBe('true');
      expect(await variants(bare), 'a tracked product with nothing stock can be held on').toBe('0');
    });
  });

  it('PM-22 NC: without journal_entries_purchase_complete a receipt whose entry credits Cash instead of Accounts Payable commits', async () => {
    await withScratch('pm22', async (db, { A }) => {
      const draft = await savedDraft(db, A, A.w1, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
      const receiveAndPay = async (c: Client): Promise<string> => {
        const run = await runReceipt(c, A, await prepareReceipt(c, A, draft.purchaseId), { postings: false });
        const purchase = run.postings.purchase;
        const asPaid: PostingCommand = {
          ...purchase,
          lines: purchase.lines.map((l) =>
            l.account.kind === 'system' && l.account.systemKey === 'accounts_payable' ? { ...l, account: { kind: 'system', systemKey: 'cash' } } : l,
          ),
        };
        return (await postInTx(c, asPaid, A.userId)).entryId;
      };
      refusedWith(await tx(db, receiveAndPay), 'P0001', 'accounting.inventory_entry_mismatch', 'as shipped, at COMMIT');
      await db.pool.query(`DROP TRIGGER journal_entries_purchase_complete ON journal_entries`);
      const entryId = expectAccepted(await tx(db, receiveAndPay), 'without the completeness trigger');
      const credited = (
        await db.pool.query<{ key: string }>(
          `SELECT a.system_key AS key FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1 AND l.journal_entry_id = $2 AND l.credit_minor > 0`,
          [A.businessId, entryId],
        )
      ).rows.map((r) => r.key);
      expect(credited, 'the purchase entry pays in cash').toEqual(['cash']);
      expect(
        await scalar(
          db.pool,
          `SELECT (purchase_ap_outstanding(business_id, id) = total_txn_minor)::text AS v FROM purchases WHERE business_id = $1 AND id = $2`,
          [A.businessId, draft.purchaseId],
        ),
        'while the settlement model still owes the whole purchase',
      ).toBe('true');
    });
  });
});

// ── S5: returns ────────────────────────────────────────────────────────────

describe('T-12 supplier returns', () => {
  it('PM-13 NC: without supplier_return.quantity_exceeds_purchased an over-return (3 of 2) commits', async () => {
    await withScratch('pm13', async (db, { A }) => {
      const cash = await cashOf(db.pool, A.businessId);
      const { stale, line } = await committed(db, async (c) => {
        const method = await createMethod(c, A, { postingAccountId: cash });
        const p1 = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
        await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '5', unitPriceMinor: '1000' }], { supplierId: p1.supplierId });
        await payInFull(c, A, p1.purchaseId, p1.supplierId, method);
        const purchaseLineId = must(p1.lines[0]).lineId;
        // Bound while it is legal (1 of 2), then the whole line is returned.
        const bound: PreparedReturn = await prepareReturn(c, A, p1.purchaseId, { lines: [{ purchaseLineId, qty: '1' }], trace: randomUUID() });
        await returnGoods(c, A, p1.purchaseId, { lines: [{ purchaseLineId, qty: '2' }], trace: randomUUID() });
        return { stale: bound, line: purchaseLineId };
      });
      const overReturn = async (c: Client): Promise<void> => {
        await runReturn(c, A, stale);
      };
      refusedWith(await tx(db, overReturn), 'P0001', 'supplier_return.quantity_exceeds_purchased', 'as shipped');
      expect(await demoteEverywhere(db.pool, 'supplier_return.quantity_exceeds_purchased')).not.toEqual([]);
      expectAccepted(await tx(db, overReturn), 'without the quantity bound');
      expect(
        await scalar(db.pool, `SELECT sum(qty)::text AS v FROM supplier_return_lines WHERE business_id = $1 AND purchase_line_id = $2`, [A.businessId, line]),
        'three returned of a line that received two',
      ).toBe('3.0000');
    });
  });

  it('PM-14 NC: without inventory.insufficient_stock a return beyond the key’s holding commits and stock goes negative', async () => {
    await withScratch('pm14', async (db, { A }) => {
      const stale = await committed(db, async (c) => {
        const p1 = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
        await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '1000' }], { supplierId: p1.supplierId });
        // Bound while W1 holds 3, then 2 leave W1: it holds 1.
        const bound = await prepareReturn(c, A, p1.purchaseId, { lines: [{ purchaseLineId: must(p1.lines[0]).lineId, qty: '2' }], trace: randomUUID() });
        await runStockCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]));
        return bound;
      });
      expect(await levelOnHand(db.pool, A, A.w1, A.piece.variantId)).toBe('1.0000');
      const beyond = async (c: Client): Promise<void> => {
        await runReturn(c, A, stale);
      };
      refusedWith(await tx(db, beyond), 'P0001', 'inventory.insufficient_stock', 'as shipped');
      expect(await demoteEverywhere(db.pool, 'inventory.insufficient_stock')).toContain(PRIMITIVE);
      expectAccepted(await tx(db, beyond), 'without the stock bound');
      expect(await levelOnHand(db.pool, A, A.w1, A.piece.variantId), 'the key is negative').toBe('-1.0000');
    });
  });
});

// ── S6: settlement ─────────────────────────────────────────────────────────

/** PM-12's detection query (settlement-s6-over-allocation): every purchase whose AP reducers exceed its total, or whose outstanding is negative. */
async function pm12(q: Queryable): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    `SELECT p.id::text FROM purchases p
      WHERE p.status = 'received'
        AND ((SELECT coalesce(sum(r.ap_txn_minor), 0) FROM supplier_returns r WHERE r.business_id = p.business_id AND r.purchase_id = p.id)
           + (SELECT coalesce(sum(a.purchase_amount_applied_minor), 0) FROM supplier_payment_allocations a WHERE a.business_id = p.business_id AND a.purchase_id = p.id)
           + (SELECT coalesce(sum(a.purchase_amount_applied_minor), 0) FROM supplier_credit_allocations a WHERE a.business_id = p.business_id AND a.purchase_id = p.id)
           > p.total_txn_minor
          OR purchase_ap_outstanding(p.business_id, p.id) < 0)`,
  );
  return r.rows.map((x) => x.id);
}

/** PM-15's detection query (settlement-s6-credit-concurrency): every note whose stored pair is not what its consumers leave, or is out of bounds. */
async function pm15(q: Queryable): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    `SELECT n.id::text FROM supplier_credit_notes n
      WHERE n.remaining_amount_minor < 0 OR n.remaining_amount_minor > n.original_amount_minor
         OR n.remaining_amount_minor <> n.original_amount_minor
              - (SELECT coalesce(sum(a.credit_amount_consumed_minor), 0) FROM supplier_credit_allocations a WHERE a.business_id = n.business_id AND a.credit_note_id = n.id)
              - (SELECT coalesce(sum(f.source_amount_consumed_minor), 0) FROM supplier_refunds f WHERE f.business_id = n.business_id AND f.credit_note_id = n.id)
         OR n.remaining_carrying_base_amount_minor
              <> supplier_credit_remaining_carrying(n.original_amount_minor, n.original_carrying_base_amount_minor, n.remaining_amount_minor)`,
  );
  return r.rows.map((x) => x.id);
}

describe('T-12 supplier settlement', () => {
  it('PM-12 NC: without the R-62 chain guard (purchase_settlement_verify) a forged overlapping payment allocation commits and AP is over-allocated', async () => {
    await withScratch('pm12', async (db, { A }) => {
      const cash = await cashOf(db.pool, A.businessId);
      const { method, p } = await committed(db, async (c) => ({
        method: await createMethod(c, A, { postingAccountId: cash }),
        p: await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }]),
      }));
      // The honest 60 of 100, then the owner's copy of it under new ids — the
      // same X restated, triggers on, its own entry posted (the S6 T-05 forgery).
      const overlap = async (c: Client): Promise<void> => {
        const honest: S6Call = await preparePay(c, A, {
          supplierId: p.supplierId,
          paymentMethodId: method,
          allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 60n }],
        });
        await runS6(c, A, honest);
        const paymentId = randomUUID();
        const allocationId = randomUUID();
        await c.query(
          `INSERT INTO supplier_payments (tenant_id, business_id, id, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                                          payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                                          allocation_count, intent_sha256, business_transaction_id, created_by)
           SELECT tenant_id, business_id, $3, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                  payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                  allocation_count, intent_sha256, business_transaction_id, created_by
             FROM supplier_payments WHERE business_id = $1 AND id = $2`,
          [A.businessId, honest.params[0], paymentId],
        );
        await c.query(
          `INSERT INTO supplier_payment_allocations (tenant_id, business_id, id, payment_id, supplier_id, purchase_id, line_no, payment_currency,
                                                     payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                                                     purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                                     purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, binding_source_id)
           SELECT tenant_id, business_id, $4, $3, supplier_id, purchase_id, line_no, payment_currency,
                  payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                  purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                  purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, $4
             FROM supplier_payment_allocations WHERE business_id = $1 AND payment_id = $2`,
          [A.businessId, honest.params[0], paymentId, allocationId],
        );
        await postInTx(c, { ...must(honest.postings[0]), sourceId: allocationId }, A.userId);
      };
      refusedWith(await tx(db, overlap), 'P0001', 'supplier_payment.settlement_inconsistent', 'as shipped, at COMMIT');
      expect(await pm12(db.pool)).toEqual([]);
      await withoutRefusal(db.pool, 'purchase_settlement_verify(uuid,uuid)', 'supplier_payment.settlement_inconsistent');
      expectAccepted(await tx(db, overlap), 'without the chain guard');
      expect(await pm12(db.pool), 'PM-12’s detection finds the over-allocated purchase').toEqual([p.purchaseId]);
    });
  });

  it('PM-15 NC: without the R-63 note chain guard (supplier_credit_note_verify) a forged refund consumes credit the note never gave up', async () => {
    await withScratch('pm15', async (db, { A }) => {
      const cash = await cashOf(db.pool, A.businessId);
      const { method, creditNoteId } = await committed(db, async (c) => {
        const m = await createMethod(c, A, { postingAccountId: cash });
        const n = await sqlReturnToCredit(c, A, m, { qty: '2', unitPriceMinor: '10000' });
        return { method: m, creditNoteId: n.creditNoteId };
      });
      const original = await scalar(db.pool, `SELECT original_amount_minor::text AS v FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`, [
        A.businessId,
        creditNoteId,
      ]);
      expect(original).toBe('10000');
      // The honest refund of 3000 (the note goes 10000 → 7000), then the owner's
      // copy of it one level down — its own amounts consistent, its own entry
      // posted — which the note never decrements for.
      const forgedRefund = async (c: Client): Promise<void> => {
        const honest = await prepareRefund(c, A, { creditNoteId, paymentMethodId: method, consumedMinor: 3000n, reference: 'RF-1' });
        await runS6(c, A, honest);
        const forgedId = randomUUID();
        await c.query(
          `INSERT INTO supplier_refunds (tenant_id, business_id, id, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date, reference,
                                         source_currency, source_amount_consumed_minor, source_to_base_rate, credit_remaining_before_minor,
                                         source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, receipt_amount_minor,
                                         receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id,
                                         realized_fx_gain_loss_minor, intent_sha256, business_transaction_id, created_by, binding_source_id)
           SELECT tenant_id, business_id, $3, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date, reference,
                  source_currency, source_amount_consumed_minor, source_to_base_rate, credit_remaining_before_minor - 1000,
                  source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, receipt_amount_minor,
                  receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id,
                  realized_fx_gain_loss_minor, intent_sha256, business_transaction_id, created_by, $3
             FROM supplier_refunds WHERE business_id = $1 AND credit_note_id = $2`,
          [A.businessId, creditNoteId, forgedId],
        );
        await postInTx(c, { ...must(honest.postings[0]), sourceId: forgedId }, A.userId);
      };
      refusedWith(await tx(db, forgedRefund), 'P0001', 'supplier_credit_note.consumption_inconsistent', 'as shipped, at COMMIT');
      expect(await pm15(db.pool)).toEqual([]);
      await withoutRefusal(db.pool, 'supplier_credit_note_verify(uuid,uuid)', 'supplier_credit_note.consumption_inconsistent');
      expectAccepted(await tx(db, forgedRefund), 'without the note chain guard');
      expect(await pm15(db.pool), 'PM-15’s detection finds the note').toEqual([creditNoteId]);
      // The note still offers 7000, so the credit is consumed twice: 13000 of 10000.
      expectAccepted(
        await tx(db, async (c) => {
          await runS6(c, A, await prepareRefund(c, A, { creditNoteId, paymentMethodId: method, consumedMinor: 7000n, reference: 'RF-2' }));
        }),
        'the remaining 7000 the note still states',
      );
      expect(
        await scalar(db.pool, `SELECT sum(source_amount_consumed_minor)::text AS v FROM supplier_refunds WHERE business_id = $1 AND credit_note_id = $2`, [
          A.businessId,
          creditNoteId,
        ]),
      ).toBe('13000');
    });
  });
});

// ── S2/S4: the stock ledger under concurrency and retries ──────────────────

const GATE = 7_309_002;

/**
 * Two receipts of one key, each parked at a test-held gate inside the
 * primitive right after it has read the key's cache row; the gate is released
 * once both are parked, and each commits as soon as it can.
 */
async function gatedPair(db: ScratchDb, biz: S3Business, pair: readonly [PreparedReceipt, PreparedReceipt]): Promise<Outcome<null>[]> {
  const gate = await connect(db);
  const workers = [await connect(db), await connect(db)];
  try {
    await gate.query('SELECT pg_advisory_lock($1)', [GATE]);
    const runs: Promise<Outcome<null>>[] = [];
    for (const [i, prepared] of pair.entries()) {
      const c = must(workers[i]);
      const pid = await pidOf(c);
      runs.push(
        settle(async () => {
          await c.query('BEGIN');
          try {
            await runReceipt(c, biz, prepared);
            await c.query('COMMIT');
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          }
          return null;
        }),
      );
      await waitUntilBlocked(pid, `receipt ${i + 1} parks`);
    }
    await gate.query('SELECT pg_advisory_unlock($1)', [GATE]);
    return await Promise.all(runs);
  } finally {
    await gate.end();
    for (const c of workers) await c.end();
  }
}

describe('T-12 the stock ledger', () => {
  it('PM-02 NC: without the primitive’s key lock (and the stock_seq UNIQUE behind it) two concurrent receipts lose an update — a wrong average', async () => {
    await withScratch('pm02', async (db, { A }) => {
      const key = { warehouseId: A.w1, variantId: A.piece.variantId };
      const seed = await committed(db, (c) => receivedPurchase(c, A, [{ variantId: key.variantId, qty: '10', unitPriceMinor: '100' }]));
      const drafts: DraftCommand[] = [];
      for (const price of ['200', '400', '200', '400']) {
        drafts.push(await savedDraft(db, A, key.warehouseId, [{ variantId: key.variantId, qty: '10', unitPriceMinor: price }], seed.supplierId));
      }
      const prepared = (d: DraftCommand | undefined): Promise<PreparedReceipt> => prepareReceipt(db.pool, A, must(d).purchaseId);
      await rewriteRoutine(
        db.pool,
        PRIMITIVE,
        '    -- a. The five-part identity',
        `    PERFORM pg_advisory_xact_lock_shared(${GATE});\n    -- a. The five-part identity`,
      );

      // As shipped (gated only): the second waits on the key lock, then reads the first's result.
      const shipped = await gatedPair(db, A, [await prepared(drafts[0]), await prepared(drafts[1])]);
      shipped.forEach((o, i) => expectAccepted(o, `as shipped, receipt ${i + 1}`));
      expect(await levelOnHand(db.pool, A, key.warehouseId, key.variantId)).toBe('30.0000');
      expect(await keyVerifies(db, A, key.warehouseId, key.variantId), 'as shipped the cache is the fold of its ledger').toBe(true);

      await rewriteRoutine(db.pool, PRIMITIVE, 'l.variant_id = v_key.va\n       FOR UPDATE;', 'l.variant_id = v_key.va;');
      await db.pool.query(`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_key_seq_uq`);
      const racing = await gatedPair(db, A, [await prepared(drafts[2]), await prepared(drafts[3])]);
      racing.forEach((o, i) => expectAccepted(o, `without the key lock, receipt ${i + 1}`));
      expect(await ledgerOnHand(db.pool, A, key.warehouseId, key.variantId), 'the ledger holds all four receipts').toBe('50.0000');
      expect(await levelOnHand(db.pool, A, key.warehouseId, key.variantId), 'the cache lost one of the two concurrent receipts').toBe('40.0000');
      expect(await keyVerifies(db, A, key.warehouseId, key.variantId)).toBe(false);
    });
  });

  it('PM-04 NC: without the replay guard (the stable identity check, stock_movements_identity_uq and the binding key) a retried movement duplicates', async () => {
    await withScratch('pm04', async (db, { A }) => {
      const key = { warehouseId: A.w1, variantId: A.piece.variantId };
      const first = req(key, 'purchase', '2', { unitCost: '1' });
      await committed(db, async (c) => {
        await installStockFixture(c);
        await applyAsApp(c, A, [first]);
      });
      const retry = async (c: Client): Promise<void> => {
        await applyAsApp(c, A, [first]);
      };
      refusedWith(await tx(db, retry), 'P0001', 'inventory.movement_identity_conflict', 'as shipped');
      await withoutRefusal(db.pool, PRIMITIVE, 'inventory.movement_identity_conflict');
      expectConstraint(await tx(db, retry), '23505', 'stock_movements_identity_uq', 'the stable check removed: the UNIQUE still holds');
      await db.pool.query(`ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_identity_uq CASCADE`);
      await db.pool.query(`ALTER TABLE stock_source_bindings DROP CONSTRAINT stock_source_bindings_pkey CASCADE`);
      expectAccepted(await tx(db, retry), 'every holder of the identity removed');
      expect(
        await scalar(
          db.pool,
          `SELECT count(*)::text AS v FROM stock_movements
            WHERE business_id = $1 AND source_type = $2 AND source_id = $3 AND source_line_id = $4 AND movement_kind = $5`,
          [A.businessId, first.sourceType, first.sourceId, first.sourceLineId, first.kind],
        ),
        'one five-part identity, two movements',
      ).toBe('2');
      expect(await levelOnHand(db.pool, A, key.warehouseId, key.variantId), 'the retry doubled the stock').toBe('4.0000');
    });
  });
});

// ── S4: deficit coverage ───────────────────────────────────────────────────

/** A key seeded short by `layers` quantities at a provisional cost of 120 (so a receipt at 120 covers with a zero catch-up: no movement, no entry). */
function shortAt120(layers: readonly string[]): {
  state: { onHand: string; valuation: string; avg: string };
  layers: { deficitId: string; deficitSeq: string; uncovered: string; provisional: string }[];
} {
  const short = layers.reduce((s, q) => s + Number(q), 0);
  return {
    state: { onHand: `-${short}.0000`, valuation: String(-120 * short), avg: '120.0000000000' },
    layers: layers.map((q, i) => ({ deficitId: randomUUID(), deficitSeq: String(i + 1), uncovered: `${q}.0000`, provisional: '120.0000000000' })),
  };
}

async function coveragesOf(q: Queryable, businessId: string, purchaseId: string): Promise<number> {
  return Number(
    await scalar(
      q,
      `SELECT count(*)::text AS v FROM negative_deficit_coverages c JOIN negative_inventory_cost_adjustments a ON a.business_id = c.business_id AND a.id = c.adjustment_id
        WHERE c.business_id = $1 AND a.origin_source_id = $2`,
      [businessId, purchaseId],
    ),
  );
}

describe('T-12 deficit coverage', () => {
  it('PM-20 NC: without the per-deficit Σ guard (negative_inventory_deficits_coverage_consistent) a deficit covered twice commits', async () => {
    await withScratch('pm20', async (db, { A }) => {
      const seed = shortAt120(['5']);
      const layer = must(seed.layers[0]).deficitId;
      await committed(db, async (c) => {
        await installStockFixture(c);
        await seedDeficitKey(c, A, A.w1, A.piece.variantId, seed);
      });
      const first = await savedDraft(db, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitPriceMinor: '120' }]);
      const second = await savedDraft(db, A, A.w1, [{ variantId: A.piece.variantId, qty: '10', unitPriceMinor: '120' }]);
      // The first receipt covers the layer; the second (bound after it, nothing
      // left to cover) gets a coverage header and a second coverage of the
      // same layer forged by the owner in the same transaction.
      const coverTwice = async (c: Client): Promise<void> => {
        await runReceipt(c, A, await prepareReceipt(c, A, first.purchaseId));
        await runReceipt(c, A, await prepareReceipt(c, A, second.purchaseId));
        const header = randomUUID();
        await c.query(
          `INSERT INTO negative_inventory_cost_adjustments (tenant_id, business_id, id, warehouse_id, origin_source_type, origin_source_id, origin_source_line_id,
                                                            occurred_on, total_value_base_minor, actor_user_id, business_transaction_id, binding_source_id)
           SELECT $1, p.business_id, $3, p.warehouse_id, 'purchase', p.id, NULL, p.document_date, 0, $4, inventory_business_transaction_id(), NULL
             FROM purchases p WHERE p.business_id = $2 AND p.id = $5`,
          [A.tenantId, A.businessId, header, A.userId, second.purchaseId],
        );
        await c.query(
          `INSERT INTO negative_deficit_coverages (tenant_id, business_id, id, adjustment_id, deficit_id, variant_id, qty_covered,
                                                   provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
           VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, 5, 120, 120)`,
          [A.tenantId, A.businessId, header, layer, A.piece.variantId],
        );
      };
      refusedWith(await tx(db, coverTwice), 'P0001', 'inventory.deficit_coverage_mismatch', 'as shipped, at COMMIT');
      await db.pool.query(`DROP TRIGGER negative_inventory_deficits_coverage_consistent ON negative_inventory_deficits`);
      expectAccepted(await tx(db, coverTwice), 'without the Σ guard');
      const r = must(
        (
          await db.pool.query<{ original: string; covered: string }>(
            `SELECT d.original_deficit_qty::text AS original,
                    (SELECT sum(c.qty_covered) FROM negative_deficit_coverages c WHERE c.business_id = d.business_id AND c.deficit_id = d.id)::text AS covered
               FROM negative_inventory_deficits d WHERE d.business_id = $1 AND d.id = $2`,
            [A.businessId, layer],
          )
        ).rows[0],
      );
      expect(r, 'a deficit of 5 covered 10').toEqual({ original: '5.0000', covered: '10.0000' });
    });
  });

  it('PM-30 NC: a coverage writer that keeps only the first coverage of a line over three layers — the Σ mismatch is caught; without the Σ guard it commits', async () => {
    await withScratch('pm30', async (db, { A }) => {
      const keys = [
        { warehouseId: A.w1, variantId: A.piece.variantId },
        { warehouseId: A.w2, variantId: A.piece.variantId },
        { warehouseId: A.w1, variantId: A.piece2.variantId },
      ];
      await committed(db, async (c) => {
        await installStockFixture(c);
        for (const k of keys) await seedDeficitKey(c, A, k.warehouseId, k.variantId, shortAt120(['2', '3', '1']));
      });
      const drafts: DraftCommand[] = [];
      for (const k of keys) drafts.push(await savedDraft(db, A, k.warehouseId, [{ variantId: k.variantId, qty: '8', unitPriceMinor: '120' }]));
      const receive = (d: DraftCommand | undefined): Promise<Outcome<void>> =>
        tx(db, async (c) => {
          await runReceipt(c, A, await prepareReceipt(c, A, must(d).purchaseId));
        });

      expectAccepted(await receive(drafts[0]), 'as shipped');
      expect(await coveragesOf(db.pool, A.businessId, must(drafts[0]).purchaseId), 'as shipped: one coverage per layer').toBe(3);

      await rewriteRoutine(
        db.pool,
        'purchase_cover_deficits(uuid,uuid)',
        'FROM unnest(v_ids, v_deficits, v_variants, v_qtys, v_provs, v_actuals) AS x(id, deficit, variant, qty, prov, actual);',
        'FROM unnest(v_ids, v_deficits, v_variants, v_qtys, v_provs, v_actuals) WITH ORDINALITY AS x(id, deficit, variant, qty, prov, actual, o) WHERE x.o = 1;',
      );
      refusedWith(await receive(drafts[1]), 'P0001', 'inventory.deficit_coverage_mismatch', 'the dropping writer, caught at COMMIT');
      expect(await coveragesOf(db.pool, A.businessId, must(drafts[1]).purchaseId)).toBe(0);

      await db.pool.query(`DROP TRIGGER negative_inventory_deficits_coverage_consistent ON negative_inventory_deficits`);
      expectAccepted(await receive(drafts[2]), 'the dropping writer without the Σ guard');
      expect(await coveragesOf(db.pool, A.businessId, must(drafts[2]).purchaseId), 'three layers closed by one coverage').toBe(1);
      expect(
        await scalar(
          db.pool,
          `SELECT count(*)::text AS v FROM negative_inventory_deficits WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 AND status = 'closed'`,
          [A.businessId, A.w1, A.piece2.variantId],
        ),
      ).toBe('3');
    });
  });
});

// ── P3-AL-53: the provisioning writer ──────────────────────────────────────

/** P3-AL-38's eleven keys and the three views manager holds, copied from the lock (inventory-permissions-provisioning.test.ts). */
const PHASE3: readonly string[] = [
  'inventory.view',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.stocktake',
  'purchases.view',
  'purchases.manage',
  'purchases.receive',
  'purchases.return',
  'suppliers.view',
  'suppliers.manage',
  'suppliers.pay',
];
const VIEWS: readonly string[] = ['inventory.view', 'purchases.view', 'suppliers.view'];

describe('T-12 provisioning', () => {
  it('PM-35 NC: a provisioning writer that appends one Phase 3 key to manager fails the exact-list check', async () => {
    await withScratch('pm35', async (db) => {
      const userId = await scalar(db.pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'T-12 owner') RETURNING id::text AS v`, [
        `t12-${randomUUID().slice(0, 8)}@test.daftar.local`,
      ]);
      /** The frozen writer, called as the service calls it, with `registry` as its role registry; answers the business id. */
      const provision = async (registry: Readonly<Record<string, readonly string[]>>): Promise<string> => {
        const c = new Client({ connectionString: db.url('daftar_provisioner') });
        await c.connect();
        const tenantId = randomUUID();
        const businessId = randomUUID();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.provisioning_assertion', $1, true), set_config('app.bypass_rls', 'true', true)`, [
            mintTestAssertion(userId, 'onboarding'),
          ]);
          await c.query('SELECT provision_create_tenant($1)', [tenantId]);
          await c.query(`SELECT provision_create_business($1,$2,$3,$4,'PS','ILS',$6,'en',ARRAY['en'],'Asia/Hebron',$5,'tenancy.onboarding_completed')`, [
            tenantId,
            businessId,
            `T-12 ${businessId.slice(0, 8)}`,
            `t12-${businessId.slice(0, 8)}`,
            JSON.stringify(registry),
            normalizeIndustryProfileKey(undefined),
          ]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          await c.end();
        }
        return businessId;
      };
      /** The exact-list check (P3-AL-53 assertion 2): the Phase 3 keys the role keyed `manager` holds are exactly the three views. */
      const managerIsExact = async (businessId: string): Promise<{ exact: boolean; phase3: string[] }> => {
        const held = (
          await db.pool.query<{ permission: string }>(
            `SELECT rp.permission FROM business_roles r JOIN role_permissions rp ON rp.business_id = r.business_id AND rp.role_id = r.id
              WHERE r.business_id = $1 AND r.key = 'manager' ORDER BY 1`,
            [businessId],
          )
        ).rows
          .map((x) => x.permission)
          .filter((p) => PHASE3.includes(p));
        return { exact: JSON.stringify(held) === JSON.stringify([...VIEWS].sort()), phase3: held };
      };
      const registry = { owner: [...PERMISSIONS], manager: [...BUILTIN_ROLE_PERMISSIONS.manager], cashier: [...BUILTIN_ROLE_PERMISSIONS.cashier] };
      expect(await managerIsExact(await provision(registry)), 'the accepted writer').toEqual({ exact: true, phase3: [...VIEWS].sort() });
      const widened = await managerIsExact(await provision({ ...registry, manager: [...registry.manager, 'inventory.adjust'] }));
      expect(widened.exact, 'the exact-list check fails on the widened manager').toBe(false);
      expect(widened.phase3).toContain('inventory.adjust');
    });
  });
});
