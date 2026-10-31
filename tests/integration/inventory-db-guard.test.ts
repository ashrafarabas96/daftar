import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_INVOKER_EXCEPTIONS,
  INVENTORY_SEARCH_PATH,
  checkInventoryDefinerContract,
  inventoryRoutineDefinitions,
} from '../../scripts/guards/inventory-definer-contract';
import { checkInventoryWriterAuthority, stockTablesWritten } from '../../scripts/guards/inventory-writer-authority';
// P4-AL-88: the accepted Phase 3 head, the boundary the handover inventory is scoped to.
import { PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';

/**
 * GUARD G-7 — the §D definer contract for daftar_inventory_internal
 * (P3-AL-54 §D), tested by breaking it: each case removes exactly one
 * protection from a real migration and requires the guard to notice. A case
 * that goes green while the text is broken means a check went vacuous.
 */

const MIGRATIONS = join(__dirname, '../../infrastructure/database/migrations');

const real = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    out[f] = readFileSync(join(MIGRATIONS, f), 'utf8');
  }
  return out;
};

const F53 = '0053_inventory_units_and_product_configuration.sql';
const F54 = '0054_inventory_assertion_authority.sql';
const F55 = '0055_inventory_configure_product.sql';
const F60 = '0060_inventory_stock_primitive.sql';
const F62 = '0062_inventory_movement_commands.sql';
// P3-S4 (0063/0064)
const F64 = '0064_purchase_commands.sql';
// P3-S5 (0065/0066)
const F65 = '0065_supplier_returns_reversals_sources.sql';
const F66 = '0066_supplier_return_reversal_commands.sql';
// P3-S6 (0067/0068)
const F68 = '0068_supplier_settlement_commands.sql';
const F72 = '0072_purchase_sub_unit_residue.sql';

/** The real tree with one file's text rewritten; the rewrite must change something. */
function mutate(file: string, from: string | RegExp, to: string): Record<string, string> {
  const tree = real();
  const before = tree[file] ?? '';
  const after = before.replace(from, to);
  expect(after, `mutation of ${file} did not apply`).not.toBe(before);
  tree[file] = after;
  return tree;
}

const violations = (migrations: Record<string, string>): string[] => checkInventoryDefinerContract({ migrations }).violations;

/**
 * THE HANDOVER SET, SPLIT BY THE FILE THAT MADE THE HANDOVER (P4-AL-88).
 *
 * `transferred` is an INVENTORY — "these and no others are handed to the
 * inventory principal" — so asserting it whole was a claim about the phase that
 * follows: `0075` hands six more routines over and an accepted P3-S8 gate went
 * red for a reason that has nothing to do with the §D contract. The claim is
 * scoped by POSITION instead: a routine belongs to the Phase 3 scope when the
 * FIRST file that hands it over is inside the accepted inherited prefix, which
 * `0000`-`0073` being frozen byte for byte (P4-AL-85) closes to every later
 * phase. A later file re-handing a Phase 3 routine cannot move it out of the
 * scope, and no prefix file can hand a later phase's routine in.
 */
function handoverScope(migrations: Record<string, string>): { inScope: string[]; beyond: string[]; all: string[] } {
  const { transferred, handovers } = checkInventoryDefinerContract({ migrations });
  const firstHandover = (name: string): string => handovers[name]?.[0] ?? '\uffff';
  return {
    inScope: transferred.filter((n) => firstHandover(n) <= PHASE4_INHERITED_PREFIX_END).sort(),
    beyond: transferred.filter((n) => firstHandover(n) > PHASE4_INHERITED_PREFIX_END).sort(),
    all: [...transferred].sort(),
  };
}

describe('G-7 — the tree as it stands', () => {
  it('accepts the real migrations', () => {
    expect(violations(real())).toEqual([]);
  });

  it('sees every routine the migrations hand to the inventory principal, including the two asserted exceptions', () => {
    const { inScope, beyond, all } = handoverScope(real());
    // P3-S3 appends thirty routines (0061: the bridge, completeness, freeze,
    // header, value and archive guards and the allocator; 0062: the seven
    // entry routines and their four helpers), all DEFINER — no new exception.
    // P3-S4 appends twenty-five (0063: the binding, completeness, freeze,
    // header, value, supplier, allocation, deficit and same-transaction coverage guards; 0064: the seven
    // entry routines and their three receipt helpers), all DEFINER — no new
    // exception. The list is the guard's sorted output.
    // P3-S5 appends seventeen (0065: the two binding guards, the return and
    // reversal completeness and header guards, the return value and quantity
    // guards, the reversal value guard, the credit-note guard and the two
    // same-transaction detail guards; 0066: the two entry routines and their
    // three helpers), all DEFINER — no new exception. 0065's owner replacement
    // of the primitive (R-B1a) adds a definition, not a name.
    // P3-S6 appends twenty-five (0067: the three arithmetic helpers, the two
    // verifiers, the method, method-name, payment, payment-allocation,
    // credit-allocation and refund guards and completeness/value triggers, and
    // the reversal's unsettled guard; 0068: the seven entry routines and the
    // credit-note writer, R-73), all DEFINER — no new exception. 0067's owner
    // replacement of the credit-note guard (A-12) adds a definition, not a name.
    // P4-AL-88: the list below is the one that stood here, name for name; it
    // is now asserted over the routines the ACCEPTED PHASE 3 PREFIX hands
    // over, and the handovers a later phase makes are judged beside it.
    expect(inScope).toEqual(
      [
        'branch_warehouses_keep_home',
        'inventory_adjust_stock',
        'inventory_apply_stock_movements',
        'inventory_assertion_consume',
        'inventory_assertion_current',
        'inventory_assertion_key_install',
        'inventory_assertion_key_retire',
        'inventory_bridge_source_lines',
        'inventory_business_transaction_id',
        'inventory_claimed_payload_digest',
        'inventory_configure_product',
        'inventory_fixed_text',
        'inventory_half_even',
        'inventory_largest_remainder',
        'inventory_lock_stock_targets',
        'inventory_next_deficit_seq',
        'inventory_payload_digest',
        'inventory_payload_field_is_canonical',
        'inventory_quantity_is_representable',
        'inventory_reason_words',
        'inventory_record_damage',
        'inventory_record_opening',
        'inventory_source_header_guard',
        'inventory_source_value_complete',
        'inventory_stock_fold',
        'inventory_stock_verify',
        'inventory_stocktake_count',
        'inventory_stocktake_finalize',
        'inventory_stocktake_open',
        'inventory_transfer_stock',
        'product_variants_10_base_variant_authority',
        'product_variants_20_stock_identity_lock',
        'product_variants_30_archive_requires_zero_stock',
        'products_10_inventory_config_authority',
        'products_20_unit_history_lock',
        'products_30_archive_requires_zero_stock',
        'stock_binding_requires_inventory_adjustment',
        'stock_binding_requires_inventory_opening',
        'stock_binding_requires_inventory_transfer',
        'stock_binding_requires_stocktake',
        'stock_levels_zero_on_hand_zero_value',
        'stock_source_complete_inventory_adjustment',
        'stock_source_complete_inventory_opening',
        'stock_source_complete_inventory_transfer',
        'stock_source_complete_stocktake',
        'stock_source_complete_stocktake_header',
        'stock_source_freeze_inventory_adjustment',
        'stock_source_freeze_inventory_opening',
        'stock_source_freeze_inventory_transfer',
        'stock_source_freeze_stocktake',
        'structure_associate_warehouse_branch',
        'structure_dissociate_warehouse_branch',
        'warehouses_30_archive_requires_zero_stock',
        'warehouses_home_branch_maintain',
        'warehouses_require_home_branch',
        // P3-S4 (0063/0064)
        'negative_inventory_deficits_coverage_consistent',
        'negative_inventory_deficits_coverage_guard',
        'purchase_allocations_consistent',
        'purchase_bridge_receipt',
        'purchase_cancel',
        'purchase_cover_deficits',
        'purchase_header_guard',
        'purchase_landed_cost_freeze',
        'purchase_lock_receipt_targets',
        'purchase_receive',
        'purchase_save_draft',
        'purchase_source_value_complete',
        'stock_binding_requires_negative_inventory_cost_adjustment',
        'stock_binding_requires_purchase',
        'stock_source_complete_negative_inventory_cost_adjustment',
        'stock_source_complete_purchase',
        'stock_source_complete_purchase_header',
        'stock_source_freeze_purchase',
        'supplier_archive',
        'supplier_create',
        'supplier_reactivate',
        'supplier_update',
        'suppliers_no_delete',
        'suppliers_revision_guard',
        // P3-S4 (0063/0064, review L2, R-36): the same-transaction coverage guard.
        'negative_deficit_coverage_same_transaction',
        // P3-S5 (0065/0066; 0066 R-55: the credit note's own asserted writer)
        'purchase_bridge_credit_note',
        'purchase_bridge_return',
        'purchase_bridge_reversal',
        'purchase_lock_stock_keys',
        'purchase_return',
        'purchase_reversal_detail_same_transaction',
        'purchase_reversal_value_complete',
        'purchase_reverse',
        'stock_binding_requires_purchase_reversal',
        'stock_binding_requires_supplier_return',
        'stock_source_complete_purchase_reversal',
        'stock_source_complete_purchase_reversal_header',
        'stock_source_complete_supplier_return',
        'stock_source_complete_supplier_return_header',
        'supplier_credit_note_guard',
        'supplier_return_detail_same_transaction',
        'supplier_return_quantity_bound',
        'supplier_return_value_complete',
        // P3-S6 (0067/0068)
        'payment_method_activate',
        'payment_method_create',
        'payment_method_deactivate',
        'payment_method_guard',
        'payment_method_name_guard',
        'payment_method_named',
        'payment_method_update',
        'purchase_reversal_unsettled',
        'purchase_settlement_verify',
        'supplier_allocate_credit',
        'supplier_ap_release',
        'supplier_convert_base',
        'supplier_credit_allocation_guard',
        'supplier_credit_allocation_value_complete',
        'supplier_credit_note_consume',
        'supplier_credit_note_verify',
        'supplier_credit_remaining_carrying',
        'supplier_pay',
        'supplier_payment_allocation_guard',
        'supplier_payment_allocation_value_complete',
        'supplier_payment_complete',
        'supplier_payment_guard',
        'supplier_receive_refund',
        'supplier_refund_guard',
        'supplier_refund_value_complete',
        // 0067 R-80
        'supplier_return_value_settled',
        // P3-S8 (0069 R-92, Annex R §2.4; pin 8): the R-B1a boolean helper,
        // DEFINER, handed over inside the inventory CREATE bracket — no new
        // exception.
        'inventory_business_has_stock_movements',
        // Phase 3 corrective (0071 R-B1b): the stock-value equality boolean,
        // same shape and same bracket — no new exception.
        'inventory_business_stock_value_equals',
        // Phase 3 corrective (0072 TD-16, R-95/R-96): the residue bound on a
        // supplier return, the write-off's header and value guards and its
        // entry routine, all DEFINER, handed over inside the inventory CREATE
        // bracket — no new exception.
        'purchase_residue_write_off_guard',
        'purchase_residue_write_off_value_complete',
        'purchase_write_off_residue',
        'supplier_return_residue_bound',
        // Phase 3 corrective (0071 R-B1c): the stock side of the account
        // domain lock, DEFINER, handed over inside the inventory CREATE
        // bracket — no new exception.
        'stock_movements_account_domain_lock',
      ].sort(),
    );
    expect([...INVENTORY_INVOKER_EXCEPTIONS].sort()).toEqual(['product_variants_10_base_variant_authority', 'products_10_inventory_config_authority']);

    // The partition, so "and nothing more" is still said about the Phase 3
    // scope: the two halves are disjoint and together they are the WHOLE
    // handover set — nothing is quietly dropped from judgement.
    expect(
      inScope.filter((n) => beyond.includes(n)),
      'the two halves are disjoint',
    ).toEqual([]);
    expect([...inScope, ...beyond].sort(), 'and together they are the whole handover set').toEqual(all);
    // And the later phase's half is judged POSITIVELY, not tolerated: every
    // routine it hands over is really defined, every definition of it is
    // SECURITY DEFINER with the pinned path, and none of them is smuggled in
    // as an asserted INVOKER exception (§D; the exceptions are the two above).
    const defs = inventoryRoutineDefinitions(real());
    const beyondProblems = beyond.flatMap((name) => {
      const own = defs.filter((d) => d.name === name);
      if (own.length === 0) return [`${name}: handed over but no migration defines it`];
      return own.flatMap((d) => [
        ...(d.securityDefiner ? [] : [`${d.file}: ${name} is handed to the inventory principal but is not SECURITY DEFINER`]),
        ...((d.searchPath ?? '')
          .split(',')
          .map((x) => x.trim().replaceAll('"', ''))
          .join(',') === INVENTORY_SEARCH_PATH.join(',')
          ? []
          : [`${d.file}: ${name} pins ${d.searchPath ?? 'no search_path'}, not ${INVENTORY_SEARCH_PATH.join(', ')}`]),
      ]);
    });
    expect(beyondProblems, 'every handover a later phase makes satisfies §D 1, 2 and 5').toEqual([]);
    expect(
      beyond.filter((n) => INVENTORY_INVOKER_EXCEPTIONS.includes(n)),
      'and none of them claims an asserted INVOKER exception',
    ).toEqual([]);
  });

  /**
   * P4-AL-88 — the re-expression proved in both directions. The green one is
   * the case above, which runs with `0075` on disk handing six routines over.
   * This is the red one, and each case breaks the PHASE 3 half of the claim in
   * a real prefix file and requires the scoped list to notice.
   */
  it('P4-AL-88 — the scoped handover inventory is red when the Phase 3 half is wrong', () => {
    const asIs = handoverScope(real());
    expect(asIs.beyond.length, 'a later phase really hands routines over — which is what forced the scoping').toBeGreaterThan(0);
    expect(asIs.inScope.length, 'and the Phase 3 half is not empty').toBeGreaterThan(100);

    // (a) A Phase 3 handover REMOVED from a prefix file: the scoped list loses
    //     that name, so the exact equality above is red. Scoping cannot hide a
    //     routine the prefix stopped handing over.
    const dropped = handoverScope(mutate(F62, 'ALTER FUNCTION inventory_bridge_source_lines(TEXT, UUID) OWNER TO daftar_inventory_internal;\n', ''));
    expect(dropped.inScope).not.toEqual(asIs.inScope);
    expect(asIs.inScope.filter((n) => !dropped.inScope.includes(n))).toEqual(['inventory_bridge_source_lines']);

    // (b) A handover ADDED to a prefix file: it lands in the Phase 3 half, not
    //     the later one, so the exact equality is red. A new authority cannot
    //     be slipped into the frozen prefix and pass as a successor's.
    const added = handoverScope(
      mutate(
        F62,
        'ALTER FUNCTION inventory_fixed_text(NUMERIC, INTEGER) OWNER TO daftar_inventory_internal;',
        'ALTER FUNCTION inventory_fixed_text(NUMERIC, INTEGER) OWNER TO daftar_inventory_internal;\nALTER FUNCTION inventory_smuggled_guard() OWNER TO daftar_inventory_internal;',
      ),
    );
    expect(added.inScope.filter((n) => !asIs.inScope.includes(n))).toEqual(['inventory_smuggled_guard']);
    expect(added.beyond, 'and the later phase’s half is untouched by it').toEqual(asIs.beyond);

    // (c) A LATER phase's handover cannot be moved into the Phase 3 half, and
    //     removing one leaves the Phase 3 half exactly as it was — which is
    //     what "says nothing about the phase that follows" means here.
    const successorGone = handoverScope(
      mutate('0075_phase4_customers_invoices_numbering.sql', /ALTER FUNCTION customers_no_delete\(\) OWNER TO daftar_inventory_internal;\n/, ''),
    );
    expect(successorGone.inScope, 'the Phase 3 half is indifferent to the successor').toEqual(asIs.inScope);
    expect(asIs.beyond.filter((n) => !successorGone.beyond.includes(n))).toEqual(['customers_no_delete']);

    // (d) And the partition never loses a name: every routine the tree hands
    //     over is in exactly one half, in each of the trees above.
    for (const [label, scope] of [
      ['as it stands', asIs],
      ['a Phase 3 handover removed', dropped],
      ['a handover smuggled into the prefix', added],
      ['a successor handover removed', successorGone],
    ] as const) {
      expect([...scope.inScope, ...scope.beyond].sort(), label).toEqual(scope.all);
      expect(
        scope.inScope.filter((n) => scope.beyond.includes(n)),
        label,
      ).toEqual([]);
    }
  });

  it('reads EVERY definition of a transferred routine: inventory_configure_product is defined in 0055 and replaced in 0060 as the principal', () => {
    const defs = inventoryRoutineDefinitions(real()).filter((d) => d.name === 'inventory_configure_product');
    expect(defs.map((d) => [d.file, d.createdAsInternal, d.securityDefiner])).toEqual([
      [F55, false, true],
      [F60, true, true],
    ]);
  });

  it('rule 22: the only stock writers are the primitive, the P3-S3 bridge writer and the two P3-S4 receipt helpers, the P3-S5 primitive replacement and its three bridge writers (credit note included), the P3-S6 credit-note writer, and the first statement of each verifies the assertion', () => {
    const report = checkInventoryWriterAuthority(real());
    expect(report.violations).toEqual([]);
    // 0062 R-5: the seven entry routines write no stock table themselves; the
    // bridges are written by one helper that opens with
    // inventory_assertion_current(...). The primitive stays the only writer of
    // movements, levels and bindings.
    // P3-S4 (0064, R-25): the receipt's coverage writes deficits and
    // coverages, and its bridge writer the two S4 bridges; each opens with
    // inventory_assertion_current(...).
    // P3-S5 (0065/0066): 0065 replaces the primitive by its owner (R-B1a), a
    // second definition of the same writer that is checked the same way; the
    // two 0066 bridge writers write the two S5 bridges and each opens with
    // inventory_assertion_current(...).
    // P3-S6 (0067/0068, R-73 and S6 contract §7.2): the note's remaining
    // values are decremented by one writer, supplier_credit_note_consume,
    // which opens with inventory_assertion_current(...); the allocation and
    // refund routines call it and write no stock table themselves.
    // P3-S8 (pin 8): rule 22 now watches the whole truth set (next case); the
    // writers of the STOCK tables among them are still exactly these.
    const stockWriters = new Set(
      inventoryRoutineDefinitions(real())
        .filter((d) => stockTablesWritten(d.body ?? '').length > 0)
        .map((d) => `${d.file}: ${d.name}`),
    );
    /**
     * ── P4-AL-88 ───────────────────────────────────────────────────────────
     *
     * "the ONLY stock writers are these" is an inventory, so asserting it
     * whole was a claim about the phase that follows: `0078` adds
     * `sale_bridge_commit`, the one writer of `stock_source_bridge_sale`, and
     * an accepted P3-S8 claim went red for a writer that is the design
     * (`[[daftar-a-closure-rule-is-not-an-invariant]]`).
     *
     * Scoped by POSITION, the same shape `handoverScope` above uses: a writer
     * belongs to the Phase 3 scope when the FILE that defines it is inside the
     * accepted inherited prefix, which `0000`-`0073` being frozen byte for
     * byte (P4-AL-85) closes to every later phase. The ORIGINAL list below is
     * unchanged, entry for entry.
     *
     * `report.violations` is asserted EMPTY above and is unscoped, so the real
     * authority law — every writer of the truth set opens with the assertion —
     * already reaches `0078`'s writers as a law. What is scoped here is only
     * the enumeration, and the later phases' half is then asserted separately
     * and positively just below.
     */
    const inPrefix = (w: string): boolean => w.slice(0, w.indexOf(':')) <= PHASE4_INHERITED_PREFIX_END;
    const scopedStockWriters = report.writers.filter((w) => stockWriters.has(w) && inPrefix(w));
    const beyondStockWriters = report.writers.filter((w) => stockWriters.has(w) && !inPrefix(w));
    expect(scopedStockWriters).toEqual([
      `${F60}: inventory_apply_stock_movements`,
      `${F62}: inventory_bridge_source_lines`,
      // P3-S4 (0063/0064)
      `${F64}: purchase_cover_deficits`,
      `${F64}: purchase_bridge_receipt`,
      // P3-S5 (0065/0066, R-B1a and S5 contract §7.2): the primitive replaced
      // by its owner, the two bridge writers and (0066 R-55) the credit-note
      // writer; each opens with the assertion.
      `${F65}: inventory_apply_stock_movements`,
      `${F66}: purchase_bridge_return`,
      `${F66}: purchase_bridge_credit_note`,
      `${F66}: purchase_bridge_reversal`,
      // P3-S6 (0067/0068)
      `${F68}: supplier_credit_note_consume`,
    ]);
    // The successor's half, positively and completely. A later phase's stock
    // writer is a DEFINER routine owned by the inventory principal that opens
    // with the assertion — which `report.violations` above already proves of
    // every writer — and the two scopes together are every stock writer in the
    // tree, so nothing can be dropped from the claim by falling between them.
    expect(beyondStockWriters.length, 'the beyond-prefix scope is empty, so the claim below says nothing').toBeGreaterThan(0);
    expect([...scopedStockWriters, ...beyondStockWriters].sort(), 'the two scopes together are every stock writer the guard found').toEqual(
      report.writers.filter((w) => stockWriters.has(w)).sort(),
    );
  });

  it('rule 22 (P3-S8 A-04, pin 8): the writers of the truth set are every entry routine and asserted helper, each opening with the assertion, and the one exception is the home-branch maintainer', () => {
    const report = checkInventoryWriterAuthority(real());
    expect(report.violations).toEqual([]);
    // The truth set is read from the grants to the principal after 0052, minus
    // the key domain and the logs; it includes every stock table.
    for (const t of ['stock_movements', 'stock_levels', 'stock_source_bindings', 'supplier_credit_notes', 'suppliers', 'purchases', 'supplier_payments']) {
      expect(report.truthTables, t).toContain(t);
    }
    for (const t of ['inventory_assertion_keys', 'inventory_assertion_uses', 'audit_events', 'outbox_events']) expect(report.truthTables, t).not.toContain(t);
    expect(report.exempt).toEqual(['0056_inventory_branch_warehouses.sql: warehouses_home_branch_maintain']);
    const F56 = '0056_inventory_branch_warehouses.sql';
    /**
     * P4-AL-88, the same treatment as the case above and for the same reason:
     * `0078` adds `sale_commit` and `sale_bridge_commit` to the writers of the
     * truth set. Scoped by the DEFINING FILE's position in the accepted
     * inherited prefix; the list below is unchanged entry for entry. The
     * authority law itself — `report.violations` — is asserted empty and
     * unscoped above, so every later writer is held to "opens with the
     * assertion" as a law rather than by appearing in this enumeration.
     */
    const inPrefixFile = (w: string): boolean => w.slice(0, w.indexOf(':')) <= PHASE4_INHERITED_PREFIX_END;
    const scopedWriters = report.writers.filter(inPrefixFile);
    const beyondWriters = report.writers.filter((w) => !inPrefixFile(w));
    expect(scopedWriters).toEqual([
      `${F55}: inventory_configure_product`,
      `${F56}: structure_associate_warehouse_branch`,
      `${F56}: structure_dissociate_warehouse_branch`,
      `${F60}: inventory_apply_stock_movements`,
      `${F60}: inventory_configure_product`,
      `${F62}: inventory_bridge_source_lines`,
      `${F62}: inventory_transfer_stock`,
      `${F62}: inventory_adjust_stock`,
      `${F62}: inventory_record_damage`,
      `${F62}: inventory_stocktake_open`,
      `${F62}: inventory_stocktake_count`,
      `${F62}: inventory_stocktake_finalize`,
      `${F62}: inventory_record_opening`,
      `${F64}: purchase_cover_deficits`,
      `${F64}: purchase_bridge_receipt`,
      `${F64}: supplier_create`,
      `${F64}: supplier_update`,
      `${F64}: supplier_archive`,
      `${F64}: supplier_reactivate`,
      `${F64}: purchase_save_draft`,
      `${F64}: purchase_cancel`,
      `${F64}: purchase_receive`,
      `${F65}: inventory_apply_stock_movements`,
      `${F66}: purchase_bridge_return`,
      `${F66}: purchase_bridge_credit_note`,
      `${F66}: purchase_bridge_reversal`,
      `${F66}: purchase_return`,
      `${F66}: purchase_reverse`,
      `${F68}: payment_method_create`,
      `${F68}: payment_method_update`,
      `${F68}: payment_method_deactivate`,
      `${F68}: payment_method_activate`,
      `${F68}: supplier_credit_note_consume`,
      `${F68}: supplier_pay`,
      `${F68}: supplier_allocate_credit`,
      `${F68}: supplier_receive_refund`,
      // Phase 3 corrective (0072 TD-16, R-96): the residue write-off opens
      // with the assertion; it writes its own document, no stock table.
      `${F72}: purchase_write_off_residue`,
    ]);
    // The successor's half, positively and completely.
    expect(beyondWriters.length, 'the beyond-prefix scope is empty, so the claim below says nothing').toBeGreaterThan(0);
    expect([...scopedWriters, ...beyondWriters].sort(), 'the two scopes together are every writer of the truth set').toEqual([...report.writers].sort());
    // And the exemption stays a CLOSED list over the whole tree, unscoped: a
    // later phase may add writers, never a second routine excused from opening
    // with the assertion. That is the security claim, so it is not scoped.
    expect(report.exempt, 'no later phase has excused a second writer from the assertion').toHaveLength(1);
  });
});

describe('G-7 — each protection, removed in turn, is noticed', () => {
  it('a definer turned invoker', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('a 0060 replacement turned invoker (the principal replaces its own routine — every definition is checked)', () => {
    const v = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('not SECURITY DEFINER'))).toBe(true);
    // …and the 0055 definition, which is still correct, is not blamed.
    expect(v.some((m) => m.startsWith(F55))).toBe(false);
  });

  it('a 0060 replacement with a reordered path, and a new S2 routine turned invoker', () => {
    const v = violations(
      mutate(
        F60,
        /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SET search_path = pg_catalog, public, pg_temp/,
        '$1SET search_path = public, pg_catalog, pg_temp',
      ),
    );
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('search_path'))).toBe(true);
    const w = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_stock_verify\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(w.some((m) => m.startsWith(F60) && m.includes('inventory_stock_verify') && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('dynamic SQL in the 0060 replacement', () => {
    const v = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, "$1\n  EXECUTE 'SELECT 1';"));
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('dynamic SQL'))).toBe(true);
  });

  it('the 0060 replacement left outside the CREATE bracket', () => {
    // The CREATE revoke moved up to just after the ownership transfers: the
    // replacement issued as the principal now runs after the bracket closed.
    const tree = mutate(
      F60,
      /REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;(?![\s\S]*REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;)/,
      '',
    );
    const moved = tree[F60] ?? '';
    tree[F60] = moved.replace(
      'ALTER FUNCTION stock_levels_zero_on_hand_zero_value() OWNER TO daftar_inventory_internal;',
      'ALTER FUNCTION stock_levels_zero_on_hand_zero_value() OWNER TO daftar_inventory_internal;\nREVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    );
    expect(tree[F60]).not.toBe(moved);
    const v = violations(tree);
    expect(v.some((m) => m.startsWith(F60) && m.includes('without revoking'))).toBe(true);
  });

  it('a routine CREATED as the principal is a handover: it needs its own REVOKE unless it replaces an earlier one', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'SET LOCAL ROLE daftar_inventory_internal;',
      'CREATE FUNCTION inventory_role_made() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
      'RESET ROLE;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    const report = checkInventoryDefinerContract({ migrations: tree });
    expect(report.transferred).toContain('inventory_role_made');
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain('inventory_role_made');
    expect(report.violations[0]).toContain('FROM PUBLIC');
  });

  it('a replacement as the principal that is DROPped first loses its ACL, so it needs its own REVOKE', () => {
    const v = violations(
      mutate(
        F60,
        /SET LOCAL ROLE daftar_inventory_internal;\s*CREATE OR REPLACE FUNCTION inventory_configure_product\(/,
        'SET LOCAL ROLE daftar_inventory_internal;\nDROP FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT);\nCREATE OR REPLACE FUNCTION inventory_configure_product(',
      ),
    );
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('FROM PUBLIC'))).toBe(true);
  });

  it('an asserted invoker exception turned definer', () => {
    const v = violations(mutate(F53, /(CREATE OR REPLACE FUNCTION products_10_inventory_config_authority\([\s\S]*?)SECURITY INVOKER/, '$1SECURITY DEFINER'));
    expect(v.some((m) => m.includes('products_10_inventory_config_authority') && m.includes('must not be SECURITY DEFINER'))).toBe(true);
  });

  it('a reordered search_path', () => {
    const v = violations(
      mutate(
        F54,
        /(CREATE OR REPLACE FUNCTION inventory_assertion_consume\([\s\S]*?)SET search_path = pg_catalog, public, pg_temp/,
        '$1SET search_path = public, pg_catalog, pg_temp',
      ),
    );
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path'))).toBe(true);
  });

  it('a missing REVOKE … FROM PUBLIC', () => {
    const v = violations(mutate(F54, 'REVOKE ALL ON FUNCTION inventory_assertion_current(TEXT[]) FROM PUBLIC;', ''));
    expect(v.some((m) => m.includes('inventory_assertion_current') && m.includes('FROM PUBLIC'))).toBe(true);
  });

  it('a grant to PUBLIC', () => {
    const v = violations(
      mutate(
        F55,
        'GRANT EXECUTE ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) TO daftar_app;',
        'GRANT EXECUTE ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) TO daftar_app, PUBLIC;',
      ),
    );
    expect(v.some((m) => m.includes('inventory_configure_product') && m.includes('PUBLIC'))).toBe(true);
  });

  it('a missing CREATE grant before the transfer', () => {
    const v = violations(mutate(F55, 'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;', ''));
    expect(v.some((m) => m.startsWith(F55) && m.includes('without first granting'))).toBe(true);
  });

  it('a missing CREATE revoke after the transfer', () => {
    const v = violations(mutate(F55, 'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;', ''));
    expect(v.some((m) => m.startsWith(F55) && m.includes('without revoking'))).toBe(true);
  });

  it('dynamic SQL in a body', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, "$1\n  EXECUTE 'SELECT 1';"));
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('dynamic SQL'))).toBe(true);
  });

  it('a session relation created in a body', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, '$1\n  CREATE TEMP TABLE t (x int);'));
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('session relation'))).toBe(true);
  });

  it('a later ALTER that resets the path or flips the security mode', () => {
    const tree = real();
    tree['9999_regression.sql'] =
      'ALTER FUNCTION inventory_assertion_consume(TEXT, TEXT) RESET search_path;\nALTER FUNCTION inventory_assertion_current(TEXT[]) SECURITY INVOKER;\n';
    const v = violations(tree);
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path after the fact'))).toBe(true);
    expect(v.some((m) => m.includes('inventory_assertion_current') && m.includes('security mode after the fact'))).toBe(true);
  });

  it('L-1: a grant to PUBLIC hidden in a list, in ALL FUNCTIONS IN SCHEMA, or under ALTER ROUTINE', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT EXECUTE ON FUNCTION products_touch(), "public"."inventory_stock_verify"(UUID, UUID, UUID) TO daftar_app, PUBLIC;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;',
      'ALTER ROUTINE inventory_assertion_consume RESET search_path;',
    ].join('\n');
    const v = violations(tree);
    expect(v.some((m) => m.includes('grants inventory_stock_verify to PUBLIC'))).toBe(true);
    expect(v.some((m) => m.includes('grants ALL routines in a schema to PUBLIC'))).toBe(true);
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path after the fact'))).toBe(true);
  });

  it('L-1: REASSIGN OWNED … TO the principal hands over routines no statement names', () => {
    const tree = real();
    tree['9999_regression.sql'] = 'REASSIGN OWNED BY daftar_migrator TO "daftar_inventory_internal";\n';
    expect(violations(tree).some((m) => m.includes('REASSIGN OWNED'))).toBe(true);
  });

  it('L-1: SET SESSION AUTHORIZATION, a literal role and set_config(role) all make a routine created as the principal', () => {
    for (const [open, close] of [
      ['SET SESSION AUTHORIZATION daftar_inventory_internal;', 'RESET SESSION AUTHORIZATION;'],
      ["SET ROLE 'daftar_inventory_internal';", 'RESET ROLE;'],
      ["SELECT set_config('role', 'daftar_inventory_internal', true);", 'RESET ROLE;'],
    ] as const) {
      const tree = real();
      tree['9999_regression.sql'] = [
        'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
        open,
        'CREATE FUNCTION inventory_session_made() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
        close,
        'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      ].join('\n');
      const report = checkInventoryDefinerContract({ migrations: tree });
      expect(report.transferred, open).toContain('inventory_session_made');
      expect(
        report.violations.some((m) => m.includes('inventory_session_made') && m.includes('FROM PUBLIC')),
        open,
      ).toBe(true);
    }
  });

  it('an asserted exception that has disappeared', () => {
    const v = violations(mutate(F53, 'ALTER FUNCTION products_10_inventory_config_authority() OWNER TO daftar_inventory_internal;', ''));
    expect(v.some((m) => m.includes('asserted INVOKER exception products_10_inventory_config_authority'))).toBe(true);
  });

  it('a third invoker routine handed to the principal', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_sneaky() RETURNS int LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
      'REVOKE ALL ON FUNCTION inventory_sneaky() FROM PUBLIC;',
      'ALTER FUNCTION inventory_sneaky() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    const v = violations(tree);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('inventory_sneaky');
    expect(v[0]).toContain('not SECURITY DEFINER');
  });
});

describe('rule 22 — a stock writer verifies invctl/1 first (PM-44 static half)', () => {
  const writer = (migrations: Record<string, string>): string[] => checkInventoryWriterAuthority(migrations).violations;
  const ASSERT = 'v_actor := inventory_assertion_current(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));';

  it('the primitive with its assertion moved below another statement', () => {
    const v = writer(mutate(F60, ASSERT, `v_rows := 0;\n  ${ASSERT}`));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(F60);
    expect(v[0]).toContain('inventory_apply_stock_movements');
  });

  it('the primitive with its assertion removed', () => {
    const v = writer(mutate(F60, ASSERT, 'v_business := NULL;'));
    expect(v.some((m) => m.includes('inventory_apply_stock_movements') && m.includes('first statement'))).toBe(true);
  });

  it('a new internal routine that writes the ledger without any assertion', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_sneaky_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$',
      'BEGIN',
      '  DELETE FROM negative_deficit_coverages WHERE false;',
      'END; $$;',
      'REVOKE ALL ON FUNCTION inventory_sneaky_writer() FROM PUBLIC;',
      'ALTER FUNCTION inventory_sneaky_writer() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    // G-7 alone is satisfied: the shape is right. Only rule 22 sees the missing authority.
    expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
    const v = writer(tree);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('inventory_sneaky_writer');
    expect(v[0]).toContain('negative_deficit_coverages');
  });

  describe('L-1: writer evasions', () => {
    const PATH = 'SET search_path = pg_catalog, public, pg_temp';
    /** The real tree plus one file that creates `name` with `body` and hands it over with `handover`. */
    const planted = (name: string, body: string, handover = `ALTER FUNCTION ${name}() OWNER TO daftar_inventory_internal;`, kind = 'FUNCTION') => {
      const tree = real();
      tree['9999_regression.sql'] = [
        'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
        `CREATE ${kind} ${name}() ${kind === 'FUNCTION' ? 'RETURNS void ' : ''}LANGUAGE plpgsql SECURITY DEFINER ${PATH} AS $$`,
        body,
        '$$;',
        `REVOKE ALL ON ${kind} ${name.replace(/^(?:"?public"?\s*\.\s*)/, '')}() FROM PUBLIC;`,
        handover,
        'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      ].join('\n');
      return tree;
    };
    const CHECK = "v_actor := inventory_assertion_current(ARRAY['op']);";

    it('MERGE INTO, TRUNCATE and COPY … FROM are writes', () => {
      expect(stockTablesWritten('MERGE INTO stock_levels l USING (SELECT 1 AS k) s ON false WHEN NOT MATCHED THEN DO NOTHING;')).toEqual(['stock_levels']);
      expect(stockTablesWritten('MERGE INTO ONLY public.stock_movements m USING x ON false WHEN MATCHED THEN DELETE;')).toEqual(['stock_movements']);
      expect(stockTablesWritten('TRUNCATE TABLE products, ONLY "stock_source_bindings", public.negative_deficit_coverages;')).toEqual([
        'negative_deficit_coverages',
        'stock_source_bindings',
      ]);
      expect(stockTablesWritten("COPY stock_movements (id) FROM '/tmp/x';")).toEqual(['stock_movements']);
      const v = writer(
        planted('inventory_merge_writer', 'BEGIN\n  MERGE INTO stock_levels l USING (SELECT 1 AS k) s ON false WHEN NOT MATCHED THEN DO NOTHING;\nEND;'),
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_merge_writer writes stock_levels');
    });

    it('a quoted or schema-qualified stock table is still that table', () => {
      expect(stockTablesWritten('INSERT INTO "stock_movements" DEFAULT VALUES;')).toEqual(['stock_movements']);
      expect(stockTablesWritten('UPDATE "public"."stock_levels" SET on_hand = 0;')).toEqual(['stock_levels']);
      expect(stockTablesWritten('DELETE FROM public . "negative_inventory_deficits" WHERE false;')).toEqual(['negative_inventory_deficits']);
      expect(stockTablesWritten('UPDATE ONLY "public".stock_source_bridge_purchase SET x = 1;')).toEqual(['stock_source_bridge_purchase']);
      const v = writer(planted('inventory_quoted_writer', 'BEGIN\n  UPDATE "public"."stock_levels" SET on_hand = 0 WHERE false;\nEND;'));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_quoted_writer writes stock_levels');
    });

    it('a PROCEDURE handed over is a writer like a function', () => {
      const tree = planted(
        'inventory_proc_writer',
        'BEGIN\n  DELETE FROM stock_levels WHERE false;\nEND;',
        'ALTER PROCEDURE inventory_proc_writer() OWNER TO daftar_inventory_internal;',
        'PROCEDURE',
      );
      expect(checkInventoryDefinerContract({ migrations: tree }).transferred).toContain('inventory_proc_writer');
      expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
      const v = writer(tree);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_proc_writer writes stock_levels');
    });

    it('ALTER ROUTINE, an ALTER without its argument list, a quoted owner and a quoted, qualified name all hand a writer over', () => {
      const body = 'BEGIN\n  INSERT INTO stock_movements DEFAULT VALUES;\nEND;';
      for (const [name, handover] of [
        ['inventory_routine_writer', 'ALTER ROUTINE inventory_routine_writer() OWNER TO daftar_inventory_internal;'],
        ['inventory_bare_writer', 'ALTER FUNCTION inventory_bare_writer OWNER TO daftar_inventory_internal;'],
        ['inventory_owner_writer', 'ALTER FUNCTION inventory_owner_writer() OWNER TO "daftar_inventory_internal";'],
        ['"public"."inventory_named_writer"', 'ALTER FUNCTION "public"."inventory_named_writer"() OWNER TO daftar_inventory_internal;'],
      ] as const) {
        const tree = planted(name, body, handover);
        const bare = name.replace(/"/g, '').replace(/^public\./, '');
        expect(checkInventoryDefinerContract({ migrations: tree }).transferred, handover).toContain(bare);
        const v = writer(tree);
        expect(v, handover).toHaveLength(1);
        expect(v[0], handover).toContain(`${bare} writes stock_movements`);
      }
    });

    it('a DECLARE initialiser that calls a writer (or anything) runs before the assertion', () => {
      const v = writer(mutate(F60, /v_rows {10}BIGINT;/, 'v_rows          BIGINT := inventory_next_deficit_seq(NULL, NULL, NULL);'));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_apply_stock_movements');
      expect(v[0]).toContain('DECLARE initialiser calls inventory_next_deficit_seq');
      const w = writer(
        planted(
          'inventory_declare_writer',
          `DECLARE\n  v_actor inventory_verified_actor;\n  v_seen BIGINT := (SELECT count(1) FROM stock_levels);\nBEGIN\n  ${CHECK}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
        ),
      );
      expect(w.some((m) => m.includes('inventory_declare_writer') && m.includes('DECLARE initialiser calls count'))).toBe(true);
      expect(w.some((m) => m.includes('inventory_declare_writer') && m.includes('DECLARE initialiser runs a query'))).toBe(true);
    });

    it('the first statement is the assertion call and nothing else: no call in its arguments, nothing after it', () => {
      const v = writer(mutate(F60, ASSERT, ASSERT.replace('ORDER BY 1)', 'ORDER BY 1) || inventory_evil()')));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("assertion call's arguments call inventory_evil");
      for (const first of [
        "PERFORM inventory_assertion_current(ARRAY['op']), inventory_apply_stock_movements(NULL);",
        "SELECT inventory_assertion_current(ARRAY['op']) INTO v_actor FROM inventory_evil();",
        "v_actor := inventory_assertion_current(ARRAY['op']) OR inventory_evil();",
      ]) {
        const w = writer(
          planted(
            'inventory_trailing_writer',
            `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${first}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
          ),
        );
        expect(w, first).toHaveLength(1);
        expect(w[0], first).toMatch(/does more than call the assertion|arguments call/);
      }
      // The shapes the rule accepts: an assignment, PERFORM, SELECT … INTO, a quoted or qualified name.
      for (const first of [
        CHECK,
        "PERFORM inventory_assertion_current(ARRAY['op']);",
        "SELECT inventory_assertion_current(ARRAY['op']) INTO v_actor;",
        'v_actor := public."inventory_assertion_current"(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));',
      ]) {
        expect(
          writer(
            planted(
              'inventory_good_writer',
              `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${first}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
            ),
          ),
          first,
        ).toEqual([]);
      }
    });

    it('an EXCEPTION WHEN handler could swallow the refusal and write anyway', () => {
      const v = writer(
        planted(
          'inventory_handler_writer',
          `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${CHECK}\nEXCEPTION WHEN others THEN\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
        ),
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('EXCEPTION WHEN handler');
    });
  });

  describe('P3-S4 §7.2: the coverage header negative_inventory_cost_adjustments is a stock table', () => {
    /** The real tree plus one internal DEFINER routine `name` whose body is `body`. */
    const plantedWriter = (name: string, body: string): Record<string, string> => {
      const tree = real();
      tree['9999_regression.sql'] = [
        'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
        `CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$`,
        body,
        '$$;',
        `REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC;`,
        `ALTER FUNCTION ${name}() OWNER TO daftar_inventory_internal;`,
        'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      ].join('\n');
      return tree;
    };

    it('a write of the header is a stock write, and its real writer is purchase_cover_deficits', () => {
      expect(stockTablesWritten('INSERT INTO negative_inventory_cost_adjustments DEFAULT VALUES;')).toEqual(['negative_inventory_cost_adjustments']);
      expect(stockTablesWritten('UPDATE "public"."negative_inventory_cost_adjustments" SET x = 1;')).toEqual(['negative_inventory_cost_adjustments']);
      expect(stockTablesWritten('SELECT 1 FROM negative_inventory_cost_adjustments a WHERE false;')).toEqual([]);
      const cover = inventoryRoutineDefinitions(real()).filter((d) => d.name === 'purchase_cover_deficits');
      expect(cover.map((d) => d.file)).toEqual([F64]);
      expect(stockTablesWritten(cover[0]?.body ?? '')).toContain('negative_inventory_cost_adjustments');
    });

    it('positive: a header writer that verifies invctl/1 first passes', () => {
      const tree = plantedWriter(
        'inventory_header_writer',
        "DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  v_actor := inventory_assertion_current(ARRAY['purchase.receive']);\n  INSERT INTO negative_inventory_cost_adjustments DEFAULT VALUES;\nEND;",
      );
      expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
      const report = checkInventoryWriterAuthority(tree);
      expect(report.violations).toEqual([]);
      expect(report.writers).toContain('9999_regression.sql: inventory_header_writer');
    });

    it('negative: a header writer without the assertion first is refused', () => {
      const tree = plantedWriter('inventory_header_sneak', 'BEGIN\n  INSERT INTO public.negative_inventory_cost_adjustments DEFAULT VALUES;\nEND;');
      // G-7 alone is satisfied: the shape is right. Only rule 22 sees the missing authority.
      expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
      const v = writer(tree);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_header_sneak writes negative_inventory_cost_adjustments');
      expect(v[0]).toContain('first statement');
    });
  });

  it('a read, a FOR UPDATE lock or a table named in a message is not a write', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_reader() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$',
      'BEGIN',
      '  PERFORM 1 FROM stock_levels WHERE false FOR UPDATE;',
      "  RAISE NOTICE 'never INSERT INTO stock_movements here';",
      'END; $$;',
      'REVOKE ALL ON FUNCTION inventory_reader() FROM PUBLIC;',
      'ALTER FUNCTION inventory_reader() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    expect(writer(tree)).toEqual([]);
  });
});
