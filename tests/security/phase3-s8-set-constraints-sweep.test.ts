/**
 * P3-S8 — `SET CONSTRAINTS … IMMEDIATE` SWEEP OVER EVERY PHASE 2/3 DEFERRED
 * GUARD (review H-1 follow-up; 0069 R-94).
 *
 * `SET CONSTRAINTS` needs no privilege, so any session may fire a deferred
 * constraint trigger at the end of the statement that queued it instead of at
 * COMMIT, and it then never fires again. A guard that reads rows written
 * AFTER that statement (a header check reading its details, a detail check
 * reading its movements) must refuse when it cannot see them — it must never
 * pass vacuously. R-B1a did (H-1, fixed in 0069 R-94); this suite proves the
 * rest do not.
 *
 * The catalogue: every deferrable, non-internal constraint trigger ON A
 * RELATION THE ACCEPTED PHASE 2/3 PREFIX CREATED is in exactly one of two
 * lists, so a new deferred guard on one of those relations fails this suite
 * until it is classified:
 *
 *   REFUSES_EARLY — forced IMMEDIATE by name, the real command (as
 *     `daftar_app`, through the entry routine of its kind and the entries the
 *     service posts) is REFUSED by that trigger, with its own code, because it
 *     fires before the rows it judges exist. So a violating write in the same
 *     statement order is refused as well. Proved below for every row.
 *   JUDGES_COMPLETE — forced IMMEDIATE, the trigger fires after the last
 *     write it reads, or the invariant is re-judged by a sibling that does
 *     (the reason is recorded per trigger). The honest command is accepted,
 *     which is correct; no row of these is a fail-open.
 *
 * Deferrable foreign keys are not listed: an RI check fired early raises when
 * the referenced row is missing, so it fails closed by construction.
 *
 * ── P4-AL-88: why the catalogue equality is scoped ──────────────────────
 *
 * The equality was over EVERY deferrable non-internal constraint trigger in
 * the database, which made it a claim about the phase that follows this one:
 * the first later-phase deferred guard turns an accepted Phase 3 gate red
 * although nothing about the Phase 2/3 guards changed
 * (`[[daftar-a-closure-rule-is-not-an-invariant]]`). It could not be proved
 * for a later phase's guard either — every proof below drives a Phase 3
 * command through its own entry routine, and there is no such command for a
 * guard on a relation Phase 3 never built.
 *
 * So the equality is scoped by POSITION, to the triggers on the relations the
 * accepted inherited prefix (`0000`–`0073`, frozen byte for byte by P4-AL-85,
 * digest-verified by `phase4InheritedPrefixRelations()`) created. A later
 * phase cannot enter that scope, and a later phase that adds a deferred guard
 * to one of THOSE relations still lands inside it and is still red until
 * classified and proved.
 *
 * "And nothing more" is kept by a PARTITION plus a structural claim: every
 * deferrable non-internal constraint trigger in the database is either inside
 * the scope or on a relation no accepted prefix created, disjointly and
 * covering; and each one outside the scope must be INITIALLY DEFERRED,
 * enabled, and backed by a SECURITY DEFINER function with the pinned
 * `search_path` owned by a NOLOGIN internal principal — so it is inside the
 * T-05 definer law and cannot be an applier-owned or invoker guard.
 *
 * What is NOT claimed of a guard outside the scope is that it refuses when
 * forced IMMEDIATE. That proof needs the phase's own command surface, and it
 * belongs to that phase's `SET CONSTRAINTS` sweep. It is a hand-off, recorded
 * here, not a hole hidden here.
 */
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { attempt, must, ownerClient, rolledBack, seedS3Business, seedS3World, today, type Queryable, type S3Business } from '../helpers/inventory-commands';
import { expectRefused, settle, type Outcome } from '../helpers/stock-ledger';
import { OP_KIND_BUILDERS, mintHonest, type PreparedKind, type ResultRow } from '../helpers/op-kind-builders';
import { inheritedPrefixTriggers, splitByTriggerProvenance } from '../helpers/phase4-inherited-scope';
import { truthTables } from '../helpers/phase3-surface';
import { JOURNAL_AND_LOGS, changedTables, tableDigest } from '../helpers/table-digest';
import { assertionFor, postAs, postReversalAs, reversalFingerprintOf, sourceAssertion, type PostCommand } from '../helpers/accounting-posting';
import { position, postOpeningBalanceInTx, stockUp } from '../helpers/inventory-posting';
import { installStockFixture } from '../helpers/stock-ledger';
import { createSupplier, draftCommand, prepareReceipt, runCommand, runReceipt } from '../helpers/purchase-commands';
import { coverageVector, seedVector } from '../helpers/purchase-deficits';
import { parseQuantity } from '../../packages/inventory/src';

const P = 'P0001';

/** The `search_path` the definer law pins on every guard function (T-05 clause 1). */
const PINNED_PATH = 'search_path=pg_catalog, public, pg_temp';

/** Phase 1 deferred guards (0036), outside this sweep's range. */
const PHASE1 = ['categories_require_translation', 'category_translations_keep_one', 'product_translations_keep_one', 'products_require_translation'];

/** trigger → the code it raises when it fires before the rows it judges exist. */
const REFUSES_EARLY: Readonly<Record<string, string>> = {
  inventory_adjustments_value_complete: 'inventory.source_value_mismatch',
  inventory_openings_value_complete: 'inventory.source_value_mismatch',
  journal_entries_inventory_account_domain: 'accounting.inventory_account_domain_owned',
  // 0071 R-B1c: the serial re-check of R-B1a under the account domain lock. Forced early it sees no
  // line of its entry yet and judges the entry as touching Inventory, so it refuses as R-B1a does.
  journal_entries_inventory_account_domain_serial: 'accounting.inventory_account_domain_owned',
  journal_entries_inventory_adjustment_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_inventory_opening_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_manual_adjustment_complete: 'accounting.adjustment_detail_missing',
  journal_entries_negative_inventory_cost_adjustment_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_opening_balance_complete: 'accounting.opening_balance_detail_missing',
  journal_entries_purchase_complete: 'accounting.inventory_entry_mismatch',
  // Phase 3 corrective (0072, TD-16 R-96): fired at the entry header, before its two lines.
  journal_entries_purchase_residue_write_off_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_reversal_complete: 'accounting.reversal_detail_missing',
  journal_entries_supplier_credit_allocation_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_supplier_payment_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_supplier_refund_complete: 'accounting.inventory_entry_mismatch',
  journal_entries_supplier_return_complete: 'accounting.inventory_entry_mismatch',
  journal_entry_validate: 'accounting.entry_too_few_lines',
  journal_line_validate: 'accounting.entry_binding_missing',
  negative_deficit_coverages_value_complete: 'inventory.source_value_mismatch',
  negative_inventory_cost_adjustments_value_complete: 'inventory.source_value_mismatch',
  payment_methods_named: 'payment_method.name_required',
  purchase_landed_costs_consistent: 'purchase.landed_cost_allocation_mismatch',
  purchase_reversals_complete: 'inventory.source_movement_set_incomplete',
  purchase_reversals_value_complete: 'inventory.source_value_mismatch',
  purchases_received_complete: 'inventory.source_movement_set_incomplete',
  purchases_value_complete: 'inventory.source_value_mismatch',
  stock_binding_requires_inventory_adjustment: 'inventory.stock_source_line_missing',
  stock_binding_requires_inventory_opening: 'inventory.stock_source_line_missing',
  stock_binding_requires_inventory_transfer: 'inventory.stock_source_line_missing',
  stock_binding_requires_negative_inventory_cost_adjustment: 'inventory.stock_source_line_missing',
  stock_binding_requires_purchase: 'inventory.stock_source_line_missing',
  stock_binding_requires_purchase_reversal: 'inventory.stock_source_line_missing',
  stock_binding_requires_stocktake: 'inventory.stock_source_line_missing',
  stock_binding_requires_supplier_return: 'inventory.stock_source_line_missing',
  stock_levels_zero_on_hand_zero_value: 'inventory.zero_stock_residual_value',
  stock_source_complete_inventory_adjustment: 'inventory.source_movement_set_incomplete',
  stock_source_complete_inventory_opening: 'inventory.source_movement_set_incomplete',
  stock_source_complete_inventory_transfer: 'inventory.source_movement_set_incomplete',
  stock_source_complete_negative_inventory_cost_adjustment: 'inventory.source_movement_set_incomplete',
  stock_source_complete_purchase_reversal: 'inventory.source_movement_set_incomplete',
  stock_source_complete_supplier_return: 'inventory.source_movement_set_incomplete',
  supplier_credit_allocations_value_complete: 'supplier_credit_note.consumption_inconsistent',
  supplier_payments_complete: 'supplier_payment.allocations_invalid',
  supplier_refunds_value_complete: 'supplier_credit_note.consumption_inconsistent',
  supplier_returns_complete: 'inventory.source_movement_set_incomplete',
  supplier_returns_value_complete: 'inventory.source_value_mismatch',
};

/** trigger → why firing it early cannot let a violating write commit. */
const JUDGES_COMPLETE: Readonly<Record<string, string>> = {
  accounting_periods_topology: 'reads accounting_periods only; every INSERT/UPDATE of a period re-queues it',
  branch_warehouses_keep_home: 'a warehouse home branch is immutable (0056 BEFORE UPDATE); the dissociate routine refuses the home pair too',
  warehouses_require_home_branch:
    'the home association is written by the non-deferred AFTER INSERT maintain trigger before it fires; removing it re-queues keep_home',
  negative_inventory_deficits_coverage_consistent: 'fires at the deficit UPDATE, which follows its coverage insert in purchase_cover_deficits',
  purchase_allocations_consistent:
    'the allocation insert is the last write of a draft; the landed-cost insert (purchase_landed_costs_consistent) refuses early',
  purchase_reversals_unsettled: 'the allocation side re-judges: both allocation value checks refuse a reversed purchase and verify the settlement chain',
  supplier_returns_value_settled: 'an allocation written later runs purchase_settlement_verify itself',
  stock_source_complete_purchase:
    'a line is judged while the purchase is a draft; purchases_received_complete re-judges every line at receipt and refuses early',
  stock_source_complete_stocktake: 'a line is judged while the stocktake is open; stocktakes_finalized_complete re-judges every line at the finalizing UPDATE',
  stocktakes_finalized_complete: 'fires at the finalizing UPDATE, after every line and movement of the stocktake',
  stocktakes_value_complete: 'fires at the finalizing UPDATE, after every movement of the stocktake',
  supplier_payment_allocations_value_complete: 'reads the received purchase (frozen), the payment header written before, and its own rows',
  supplier_return_lines_quantity_bound: 'reads its own table and the frozen purchase line quantity; every returned line re-queues it',
  journal_entries_inventory_reversal_domain:
    '0071 R-B1b: judges the REVERSED entry’s committed lines, visible however early it fires (its own lines are a second witness); proved forced early, refusing and not over-refusing, in p3c-reversal-inventory-domain',
  supplier_returns_residue_bound:
    '0072 R-95: reads only its own return header (the AP it releases and the chain point before it, both written by the INSERT it fires on) and the frozen received purchase and currencies',
  stock_movements_account_domain_lock:
    '0071 R-B1c: judges and refuses nothing; it only takes the account domain lock SHARED, so forced early the session takes that lock earlier, its own lock order (0069 R-94); proved under forced checks in p3c-reversal-inventory-domain',
  purchase_residue_write_offs_value_complete:
    '0072 R-96: fires at the write-off INSERT, the routine’s only write, after every reducer it sums; a reducer written later in the transaction reads purchase_ap_outstanding, which counts the write-off (0072 §4), so it finds nothing outstanding',
};

/** Per scenario, the triggers that must refuse it when forced early. */
const OP_KIND_EXPECTED: Readonly<Record<string, readonly string[]>> = {
  'inventory.adjust': [
    'inventory_adjustments_value_complete',
    'journal_entries_inventory_adjustment_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'stock_binding_requires_inventory_adjustment',
    'stock_source_complete_inventory_adjustment',
  ],
  'inventory.damage': [
    'inventory_adjustments_value_complete',
    'journal_entries_inventory_adjustment_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'stock_binding_requires_inventory_adjustment',
    'stock_source_complete_inventory_adjustment',
  ],
  'inventory.opening': [
    'inventory_openings_value_complete',
    'journal_entries_inventory_opening_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'stock_binding_requires_inventory_opening',
    'stock_source_complete_inventory_opening',
  ],
  'inventory.stocktake_finalize': [
    'journal_entries_inventory_adjustment_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'stock_binding_requires_stocktake',
  ],
  'inventory.transfer': ['stock_binding_requires_inventory_transfer', 'stock_source_complete_inventory_transfer'],
  'payment.create_method': ['payment_methods_named'],
  'purchase.draft': ['purchase_landed_costs_consistent'],
  'purchase.receive': [
    'journal_entries_purchase_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'purchases_received_complete',
    'purchases_value_complete',
    'stock_binding_requires_purchase',
  ],
  'purchase.return': [
    'journal_entries_supplier_return_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'stock_binding_requires_supplier_return',
    'stock_source_complete_supplier_return',
    'supplier_returns_complete',
    'supplier_returns_value_complete',
  ],
  'purchase.reverse': [
    'journal_entries_reversal_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'purchase_reversals_complete',
    'purchase_reversals_value_complete',
    'stock_binding_requires_purchase_reversal',
    'stock_source_complete_purchase_reversal',
  ],
  'supplier.allocate_credit': [
    'journal_entries_supplier_credit_allocation_complete',
    'journal_entry_validate',
    'journal_line_validate',
    'supplier_credit_allocations_value_complete',
  ],
  'supplier.pay': ['journal_entries_supplier_payment_complete', 'journal_entry_validate', 'journal_line_validate', 'supplier_payments_complete'],
  'supplier.receive_refund': ['journal_entries_supplier_refund_complete', 'journal_entry_validate', 'journal_line_validate', 'supplier_refunds_value_complete'],
  // Phase 3 corrective (0072, TD-16): the write-off with a base residue (rb = 1) posts its entry.
  'purchase.write_off_residue': ['journal_entries_purchase_residue_write_off_complete', 'journal_entry_validate', 'journal_line_validate'],
};

const ACCOUNTING_EXPECTED: Readonly<Record<string, readonly string[]>> = {
  manual_adjustment: ['journal_entries_manual_adjustment_complete', 'journal_entry_validate', 'journal_line_validate'],
  opening_balance: ['journal_entries_opening_balance_complete', 'journal_entry_validate', 'journal_line_validate'],
  reversal: ['journal_entries_reversal_complete', 'journal_entry_validate', 'journal_line_validate'],
};

const DEFICIT_EXPECTED: readonly string[] = [
  'journal_entries_negative_inventory_cost_adjustment_complete',
  'journal_entries_purchase_complete',
  'journal_entry_validate',
  'journal_line_validate',
  'negative_deficit_coverages_value_complete',
  'negative_inventory_cost_adjustments_value_complete',
  'purchases_received_complete',
  'purchases_value_complete',
  'stock_binding_requires_negative_inventory_cost_adjustment',
  'stock_binding_requires_purchase',
  'stock_levels_zero_on_hand_zero_value',
  'stock_source_complete_negative_inventory_cost_adjustment',
];

const codeOf = (t: string): string => must(REFUSES_EARLY[t], `the early-refusal code of ${t}`);

let A: S3Business;
let A2: S3Business;
let day: string;
let tables: string[];

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const w = await seedS3World(ownerPool(), 'sc-sweep');
  A = w.A;
  A2 = w.A2;
  day = await today();
  tables = [...(await truthTables()), ...JOURNAL_AND_LOGS];
});

afterAll(async () => {
  await resetData();
});

/** One deferrable, non-internal constraint trigger, with everything the catalogue claim reads. */
interface DeferredGuard {
  n: string;
  rel: string;
  deferred: boolean;
  enabled: string;
  definer: boolean;
  owner: string;
  cfg: string[] | null;
}

/** The internal principals a guard function may be owned by (T-05 clause 2). */
const GUARD_OWNERS = ['daftar_inventory_internal', 'daftar_accounting_internal', 'daftar_catalog_internal', 'daftar_provisioning_internal'];

/**
 * The deferred-guard catalogue of `q`, split by POSITION: the guards on the
 * relations the accepted inherited prefix created, and those on relations no
 * accepted prefix created. `beyondProblems` is the structural claim's
 * findings over the second half. An empty prefix reader empties `inScope`,
 * which makes the equality red rather than vacuous.
 */
async function deferredGuards(q: Queryable): Promise<{ inScope: string[]; beyond: string[]; beyondProblems: string[] }> {
  const rows = (
    await q.query<DeferredGuard>(
      `SELECT DISTINCT g.tgname::text AS n, c.relname::text AS rel, g.tginitdeferred AS deferred, g.tgenabled::text AS enabled,
              f.prosecdef AS definer, pg_get_userbyid(f.proowner) AS owner, f.proconfig AS cfg
         FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_proc f ON f.oid = g.tgfoid
        WHERE g.tgdeferrable AND NOT g.tgisinternal AND g.tgconstraint <> 0 ORDER BY 1`,
    )
  ).rows.filter((r) => !PHASE1.includes(r.n));
  /**
   * ── P4-AL-88: a trigger claim a RELATION name cannot scope ─────────────
   *
   * The scope used to be POSITION OF THE RELATION —
   * `phase4InheritedPrefixRelations()`. That is right for a claim whose
   * subject IS a relation, and wrong here, because a later phase may put a
   * deferred guard on a relation the accepted prefix created, and `0077`
   * does: `stock_binding_requires_sale` on `stock_source_bindings`, and
   * `journal_entries_sale_complete` / `journal_entries_invoice_complete` on
   * `journal_entries`. All three landed inside the Phase 3 equality and
   * turned an accepted P3-S8 sweep red for guards whose ABSENCE would have
   * been the defect (`[[daftar-a-closure-rule-is-not-an-invariant]]`).
   *
   * The separable part is the TRIGGER'S OWN NAME, read from the accepted
   * prefix's digest-verified text. A guard is outside the scope only when a
   * migration PAST the accepted head declares it and the accepted prefix does
   * not; a guard NO migration declares — a hand-planted intruder — stays
   * inside, where the classified equality names it. Both readers fail LOUD:
   * an emptied prefix reader empties `inScope` and the equality goes red, and
   * an unread later file leaves its guards inside the scope, where the
   * equality goes red too. Neither direction lets a guard escape judgement.
   */
  const { inScope: scoped, beyond: outside } = splitByTriggerProvenance(rows, (r) => r.n);
  const login = new Set((await q.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_roles WHERE rolcanlogin OR rolsuper`)).rows.map((x) => x.r));
  const beyondProblems = outside
    .filter(
      (r) =>
        !r.deferred ||
        r.enabled !== 'O' ||
        !r.definer ||
        !GUARD_OWNERS.includes(r.owner) ||
        login.has(r.owner) ||
        JSON.stringify(r.cfg) !== JSON.stringify([PINNED_PATH]),
    )
    .map((r) => `${r.rel}.${r.n}`)
    .sort();
  return { inScope: scoped.map((r) => r.n).sort(), beyond: outside.map((r) => r.n).sort(), beyondProblems };
}

describe('the catalogue: every Phase 2/3 deferred guard is classified', () => {
  it('REFUSES_EARLY ∪ JUDGES_COMPLETE is exactly the deferrable non-internal constraint triggers on the accepted prefix’s relations, and the two are disjoint', async () => {
    expect(inheritedPrefixTriggers().size, 'the digest-verified prefix trigger reader came back empty').toBeGreaterThan(0);
    const { inScope, beyond, beyondProblems } = await deferredGuards(ownerPool());
    const early = Object.keys(REFUSES_EARLY);
    const complete = Object.keys(JUDGES_COMPLETE);
    expect(
      early.filter((t) => complete.includes(t)),
      'disjoint',
    ).toEqual([]);
    expect([...early, ...complete].sort(), 'every deferred guard is classified, and nothing else').toEqual(inScope);
    // The PARTITION: nothing escapes between the scoped equality and the
    // structural claim, and the two halves are disjoint by construction.
    expect(
      inScope.filter((n) => beyond.includes(n)),
      'the two scopes are disjoint',
    ).toEqual([]);
    // And what IS claimed of a guard outside the scope: initially deferred,
    // enabled, and inside the T-05 definer law.
    expect(
      beyondProblems,
      'a deferred guard outside the accepted prefix must still be initially deferred, enabled, and a DEFINER of a NOLOGIN internal principal with the pinned path',
    ).toEqual([]);
    const proved = new Set([...Object.values(OP_KIND_EXPECTED).flat(), ...Object.values(ACCOUNTING_EXPECTED).flat(), ...DEFICIT_EXPECTED]);
    proved.add('journal_entries_inventory_account_domain');
    proved.add('journal_entries_inventory_account_domain_serial');
    expect(
      early.filter((t) => !proved.has(t)),
      'every REFUSES_EARLY trigger is proved by a scenario below',
    ).toEqual([]);
  });
});

// ── the op kinds: prepared and committed, then each trigger forced early in its own transaction ──

async function present(c: Queryable, p: PreparedKind, biz: S3Business, op: string): Promise<void> {
  await c.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
            set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
    [biz.tenantId, biz.businessId, mintHonest(biz, must(OP_KIND_BUILDERS[op]).op, p.sha256(biz)), p.trace],
  );
  await c.query('SET LOCAL ROLE daftar_app');
  const r = await c.query<ResultRow>(p.sql, [...p.params]);
  await c.query('RESET ROLE');
  await p.post(c, r.rows);
}

describe.each(Object.keys(OP_KIND_EXPECTED).map((op, i) => [op, i] as const))('forced early: %s', (op, i) => {
  let biz: S3Business;
  let prepared: PreparedKind;

  beforeAll(async () => {
    biz = await seedS3Business(ownerPool(), A.tenantId, A.userId, `sc-${i}`);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      const cash = must(
        (await c.query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [biz.businessId])).rows[0],
      ).id;
      prepared = await must(OP_KIND_BUILDERS[op]).prepare(c, { biz, other: A2, cashAccountId: cash });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      await c.end();
    }
  });

  it(`every guard the command queues refuses it with its own code when forced IMMEDIATE by name, and nothing is written`, async () => {
    const before = await tableDigest(ownerPool(), tables, { businessId: biz.businessId });
    for (const t of must(OP_KIND_EXPECTED[op])) {
      const c = await ownerClient();
      let o: Outcome<unknown>;
      try {
        await c.query('BEGIN');
        await c.query(`SET CONSTRAINTS ${t} IMMEDIATE`);
        o = await settle(async () => {
          await present(c, prepared, biz, op);
          return c.query('COMMIT');
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expectRefused(o, P, codeOf(t), `${op}, ${t} forced IMMEDIATE`);
    }
    expect(changedTables(before, await tableDigest(ownerPool(), tables, { businessId: biz.businessId })), 'nothing written').toEqual([]);
    // Control: the same command, deferred as shipped, commits.
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await present(c, prepared, biz, op);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  });
});

// ── the Phase 2 accounting commands ─────────────────────────────────────────

const AT = new Date('2026-03-14T09:15:00Z');

function manual(biz: S3Business, debit: string, credit: string, amount = 500n): PostCommand {
  const line = (systemKey: string, side: 'D' | 'C'): PostCommand['lines'][number] => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: AT,
    branchId: null,
    warehouseId: null,
  });
  return {
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: day,
    description: 'SET CONSTRAINTS sweep',
    requestId: randomUUID(),
    lines: [line(debit, 'D'), line(credit, 'C')],
  };
}

/** One transaction as `daftar_app` (its own login), `stmt` first, then `run`, then COMMIT. */
async function asApp(stmt: string, run: (c: Client) => Promise<unknown>): Promise<Outcome<unknown>> {
  const c = new Client({ connectionString: appDbUrl });
  await c.connect();
  try {
    return await settle(async () => {
      await c.query('BEGIN');
      await c.query(stmt);
      await run(c);
      return c.query('COMMIT');
    });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** One owner transaction, `stmt` first, then `run` (which sets its own role), then COMMIT. */
async function asOwner(stmt: string, run: (c: Client) => Promise<unknown>): Promise<Outcome<unknown>> {
  const c = await ownerClient();
  try {
    return await settle(async () => {
      await c.query('BEGIN');
      await c.query(stmt);
      await run(c);
      return c.query('COMMIT');
    });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

describe('forced early: the Phase 2 accounting commands', () => {
  it('manual adjustment, opening balance and reversal: every guard they queue refuses them when forced IMMEDIATE, nothing written', async () => {
    const biz = await seedS3Business(ownerPool(), A.tenantId, A.userId, 'sc-acct');
    const original = manual(biz, 'cash', 'opening_equity', 900n);
    const committed = await asApp('SELECT 1', (c) => postAs(assertionFor(original, biz.userId), original, {}, c));
    expect(committed.ok, 'the original manual entry').toBe(true);
    const originalId = must(
      (
        await ownerPool().query<{ id: string }>(`SELECT id::text FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [
          biz.businessId,
          original.sourceId,
        ])
      ).rows[0],
    ).id;
    const before = await tableDigest(ownerPool(), tables, { businessId: biz.businessId });
    for (const t of must(ACCOUNTING_EXPECTED.manual_adjustment)) {
      const cmd = manual(biz, 'cash', 'opening_equity');
      expectRefused(await asApp(`SET CONSTRAINTS ${t} IMMEDIATE`, (c) => postAs(assertionFor(cmd, biz.userId), cmd, {}, c)), P, codeOf(t), `manual, ${t}`);
    }
    for (const t of must(ACCOUNTING_EXPECTED.opening_balance)) {
      expectRefused(
        await asOwner(`SET CONSTRAINTS ${t} IMMEDIATE`, (c) => postOpeningBalanceInTx(c, biz, day, [position('cash', 'D', 100n)])),
        P,
        codeOf(t),
        `opening balance, ${t}`,
      );
    }
    for (const t of must(ACCOUNTING_EXPECTED.reversal)) {
      const assertion = sourceAssertion({
        actorUserId: biz.userId,
        tenantId: biz.tenantId,
        businessId: biz.businessId,
        operationKind: 'reverse',
        sourceType: 'reversal',
        sourceId: originalId,
        postingFingerprint: reversalFingerprintOf(original, originalId, day),
      });
      expectRefused(
        await asApp(`SET CONSTRAINTS ${t} IMMEDIATE`, (c) => postReversalAs(assertion, originalId, day, 'sweep', randomUUID(), c)),
        P,
        codeOf(t),
        `reversal, ${t}`,
      );
    }
    expect(changedTables(before, await tableDigest(ownerPool(), tables, { businessId: biz.businessId })), 'nothing written').toEqual([]);
  });

  it('R-B1a (0069 R-94): after the first movement, a manual Inventory line and an Inventory opening position are refused when the guard is forced IMMEDIATE', async () => {
    const biz = await seedS3Business(ownerPool(), A.tenantId, A.userId, 'sc-rb1a');
    const setup = await asOwner('SELECT 1', (c) => stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '2', unitCost: '5' }]));
    expect(setup.ok, 'the first movement').toBe(true);
    const before = await tableDigest(ownerPool(), tables, { businessId: biz.businessId });
    // 0071 R-B1c adds the serial re-check: each of the two, forced early alone, refuses both.
    for (const t of ['journal_entries_inventory_account_domain', 'journal_entries_inventory_account_domain_serial']) {
      const cmd = manual(biz, 'inventory', 'opening_equity', 777n);
      expectRefused(
        await asApp(`SET CONSTRAINTS ${t} IMMEDIATE`, (c) => postAs(assertionFor(cmd, biz.userId), cmd, {}, c)),
        P,
        codeOf(t),
        `manual Inventory line, ${t}`,
      );
      expectRefused(
        await asOwner(`SET CONSTRAINTS ${t} IMMEDIATE`, (c) =>
          postOpeningBalanceInTx(c, biz, day, [position('inventory', 'D', 4321n), position('cash', 'D', 100n)]),
        ),
        P,
        codeOf(t),
        `Inventory opening position, ${t}`,
      );
    }
    expect(changedTables(before, await tableDigest(ownerPool(), tables, { businessId: biz.businessId })), 'nothing written').toEqual([]);
  });
});

// ── the deficit coverage path (seeded as the S4 suites do: a Phase 4 oversell stand-in, always rolled back) ──

function unitPriceFor(qty: string, share: string): string {
  const q4 = parseQuantity(qty);
  const scaled = BigInt(share) * 10000n;
  expect(scaled % q4, `share ${share} over qty ${qty} is an exact minor unit price`).toBe(0n);
  return (scaled / q4).toString(10);
}

describe('forced early: a receipt that covers deficits (GOLD72 and FLUSH-RESIDUE)', () => {
  for (const id of ['GOLD72', 'FLUSH-RESIDUE']) {
    it(`${id}: every guard the covering receipt queues refuses it when forced IMMEDIATE`, async () => {
      const v = coverageVector(id);
      await rolledBack(async (c) => {
        await installStockFixture(c);
        const ids = v.seed.map((s) => s.variantId);
        const variantOf = (x: string): string => (ids.indexOf(x) === 0 ? A.piece.variantId : A.piece2.variantId);
        await seedVector(c, A, A.w1, v, variantOf);
        const supplierId = await createSupplier(c, A);
        const draftOf = async (r: (typeof v.receipts)[number]): Promise<Awaited<ReturnType<typeof prepareReceipt>>> => {
          const d = await draftCommand(
            c,
            supplierId,
            A.w1,
            r.lines.map((l) => ({
              variantId: variantOf(l.variantId),
              qty: l.qty,
              unitPriceMinor: unitPriceFor(l.qty, l.baseShareMinor),
              lineId: randomUUID(),
            })),
          );
          const saved = await runCommand(c, A, d);
          return prepareReceipt(c, A, d.purchaseId, { draftRevision: must(saved[0]?.revision) });
        };
        for (const prior of v.receipts.slice(0, -1)) await runReceipt(c, A, await draftOf(prior));
        const prepared = await draftOf(must(v.receipts[v.receipts.length - 1]));
        const run = async (pre: string | null): Promise<Outcome<unknown>> => {
          await c.query('SAVEPOINT sc_trial');
          const o = await attempt(c, async () => {
            if (pre !== null) await c.query(pre);
            await runReceipt(c, A, prepared);
            await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          });
          await c.query('ROLLBACK TO SAVEPOINT sc_trial');
          await c.query('SET CONSTRAINTS ALL DEFERRED');
          return o;
        };
        for (const t of DEFICIT_EXPECTED) expectRefused(await run(`SET CONSTRAINTS ${t} IMMEDIATE`), P, codeOf(t), `${id}, ${t}`);
        expect((await run(null)).ok, `${id}: the same receipt, deferred as shipped, is accepted`).toBe(true);
      });
    });
  }
});

/**
 * ── P4-AL-88 proof: the scoped catalogue, both directions ────────────────
 *
 * The scoped equality must still be RED when a deferred guard appears on one
 * of the accepted prefix's own relations — that is the protection the
 * unscoped equality bought, and scoping must not have dropped it — and the
 * structural claim must be RED when a guard outside the scope is not the
 * shape it must be. Both are planted on the real catalogue inside a
 * transaction that is always rolled back.
 */
describe('P4-AL-88 — the scoped deferred-guard catalogue is red where it must be', () => {
  let owner: PoolClient;

  beforeAll(async () => {
    owner = await ownerPool().connect();
  });

  afterAll(() => {
    owner.release();
  });

  const planted = async (plant: readonly string[], body: () => Promise<void>): Promise<void> => {
    await owner.query('BEGIN');
    try {
      for (const sql of plant) await owner.query(sql);
      await body();
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  };

  it('the later phase really did add a deferred guard outside the scope, so the structural claim is not vacuous', async () => {
    const { beyond, beyondProblems } = await deferredGuards(ownerPool());
    expect(beyond.length, 'no deferred guard outside the accepted prefix exists, so the claims below prove nothing').toBeGreaterThan(0);
    expect(beyondProblems).toEqual([]);
  });

  it('RED: an unclassified deferred guard on one of the accepted prefix’s relations is named by the scoped equality', async () => {
    await planted(
      [
        `CREATE FUNCTION p4al88_probe_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN NULL; END $fn$`,
        `ALTER FUNCTION p4al88_probe_guard() OWNER TO daftar_inventory_internal`,
        `CREATE CONSTRAINT TRIGGER p4al88_probe_unclassified AFTER INSERT ON purchases
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION p4al88_probe_guard()`,
      ],
      async () => {
        const { inScope } = await deferredGuards(owner);
        expect(inScope).toContain('p4al88_probe_unclassified');
        // Which is exactly the assertion the suite makes: the classified
        // lists are no longer the scope, so it is red and it names the guard.
        expect([...Object.keys(REFUSES_EARLY), ...Object.keys(JUDGES_COMPLETE)].sort()).not.toEqual(inScope);
        expect(inScope.filter((n) => !Object.keys(REFUSES_EARLY).includes(n) && !Object.keys(JUDGES_COMPLETE).includes(n))).toEqual([
          'p4al88_probe_unclassified',
        ]);
      },
    );
    const { inScope } = await deferredGuards(ownerPool());
    expect([...Object.keys(REFUSES_EARLY), ...Object.keys(JUDGES_COMPLETE)].sort()).toEqual(inScope);
  });

  it('RED: a guard outside the scope that is not the required shape is named by the structural claim', async () => {
    const { beyond } = await deferredGuards(ownerPool());
    const victim = must(beyond[0], 'a deferred guard outside the accepted prefix');
    const fn = must(
      (
        await ownerPool().query<{ sig: string; rel: string }>(
          `SELECT regexp_replace(f.oid::regprocedure::text, '^public\\.', '') AS sig, c.relname::text AS rel
             FROM pg_trigger g JOIN pg_proc f ON f.oid = g.tgfoid JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = $1`,
          [victim],
        )
      ).rows[0],
      `the function of ${victim}`,
    );
    // (1) The pinned path removed.
    await planted([`ALTER FUNCTION ${fn.sig} RESET search_path`], async () => {
      expect((await deferredGuards(owner)).beyondProblems).toEqual([`${fn.rel}.${victim}`]);
    });
    // (2) Handed to the applying principal, which is a login/superuser role.
    await planted([`ALTER FUNCTION ${fn.sig} OWNER TO daftar_migrator`], async () => {
      expect((await deferredGuards(owner)).beyondProblems).toEqual([`${fn.rel}.${victim}`]);
    });
    // (3) Disabled — a guard that never fires is the fail-open this suite exists for.
    await planted([`ALTER TABLE ${fn.rel} DISABLE TRIGGER ${victim}`], async () => {
      expect((await deferredGuards(owner)).beyondProblems).toEqual([`${fn.rel}.${victim}`]);
    });
    expect((await deferredGuards(ownerPool())).beyondProblems).toEqual([]);
  }, 120_000);
});
