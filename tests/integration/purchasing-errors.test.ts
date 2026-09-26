import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountingError } from '@daftar/accounting';
import { AppError } from '@daftar/domain-core';
import { InventoryError } from '@daftar/inventory';
import { inventoryRefusal } from '../../apps/api/src/modules/inventory/inventory-errors';
import {
  classifiedRefusal,
  isPurchasingCode,
  purchasingInventoryRefusal,
  purchasingPackageRefusal,
  purchasingRefusal,
  rethrowPurchasingRefusal,
  UnclassifiedRefusalError,
} from '../../apps/api/src/modules/purchasing/purchasing-errors';

/**
 * The purchasing error model (PHASE_3_S4_CONTRACT §3; review M2, I3): an
 * explicit code → status table, the §3 statuses of the `inventory.*` codes
 * the purchasing paths meet, a typed failure for an unclassified code, and
 * the deferred refusals raised at COMMIT. Pure: no database, no app.
 */

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'infrastructure', 'database', 'migrations');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

/** §3, row by row. */
const CONTRACT_S3: ReadonlyArray<readonly [string, number]> = [
  ['purchase.tax_policy_absent', 422],
  ['purchase.not_found', 404],
  ['supplier.not_found', 404],
  ['purchase.state_invalid', 409],
  ['purchase.draft_changed', 409],
  ['purchase.supplier_changed', 409],
  ['purchase.supplier_inactive', 409],
  ['purchase.fx_rate_changed', 409],
  ['purchase.fx_rate_missing', 422],
  ['purchase.currency_unknown', 400],
  ['purchase.document_date_in_future', 422],
  ['purchase.duplicate_variant', 400],
  ['purchase.lines_required', 400],
  ['purchase.amount_precision_invalid', 400],
  ['purchase.discount_invalid', 400],
  ['purchase.landed_cost_invalid', 400],
  ['purchase.landed_cost_denominator_zero', 422],
  ['purchase.landed_cost_allocation_mismatch', 422],
  ['purchase.total_zero', 422],
  ['purchase.idempotency_conflict', 409],
  ['supplier.idempotency_conflict', 409],
  ['supplier.revision_changed', 409],
  ['supplier.state_invalid', 409],
  ['supplier.not_deletable', 409],
  ['inventory.valuation_changed', 409],
  ['inventory.deficit_state_invalid', 500],
  ['inventory.deficit_immutable', 500],
  ['inventory.deficit_coverage_mismatch', 500],
  ['inventory.source_document_immutable', 500],
  ['inventory.source_guard_missing', 500],
  ['inventory.source_line_frozen', 500],
  ['inventory.source_movement_set_incomplete', 500],
  ['inventory.source_type_not_authorized', 500],
  ['inventory.source_value_mismatch', 500],
  ['inventory.ledger_immutable', 500],
  ['inventory.stock_source_line_missing', 500],
];
const S4_INVENTORY = new Set(CONTRACT_S3.map(([c]) => c).filter((c) => c.startsWith('inventory.')));

/** Refusals only a migration's own end-state or probe block raises: never a runtime path, so never classified. */
const MIGRATION_TIME_ONLY = new Set([
  'purchase.migration_end_state_invalid',
  'inventory.migration_end_state_invalid',
  'inventory.probe_rollback',
  'inventory.permission_backfill_incomplete',
  'inventory.permission_backfill_manager_mismatch',
  'inventory.permission_backfill_overreach',
  'inventory.branch_warehouses_seed_mismatch',
]);

function codesRaisedIn(text: string, domains: string): Set<string> {
  const re = new RegExp(`'((?:${domains})\\.[a-z_]+): `, 'g');
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? ''));
}

function statusOf(code: string): number {
  return classifiedRefusal(code).httpStatus;
}

describe('purchasing error model — the §3 table (M2)', () => {
  it.each(CONTRACT_S3)('%s → %i', (code, status) => {
    const e = classifiedRefusal(code);
    expect(e).toBeInstanceOf(AppError);
    expect(e.httpStatus).toBe(status);
    const key = code.startsWith('inventory.') ? 'inventoryCode' : 'purchasingCode';
    expect(e.details?.[key]).toBe(code);
  });

  it('a `.not_found` is 404 and a `.state_invalid` is 409, whatever separates the word (the M2 regression)', () => {
    expect(purchasingRefusal('purchase.not_found')).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(purchasingRefusal('supplier.not_found')).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(purchasingRefusal('purchase.state_invalid')).toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(purchasingRefusal('supplier.state_invalid')).toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('every purchase.* / supplier.* code a 0063/0064 routine or trigger raises is classified', () => {
    const raised = codesRaisedIn(
      read('infrastructure/database/migrations/0063_purchases_suppliers_sources.sql') + read('infrastructure/database/migrations/0064_purchase_commands.sql'),
      'purchase|supplier',
    );
    expect(raised.size).toBeGreaterThan(20);
    for (const code of raised) {
      if (MIGRATION_TIME_ONLY.has(code)) continue;
      expect(isPurchasingCode(code), code).toBe(true);
    }
  });

  it('every inventory.* runtime refusal of the inventory migrations (0059–0064) is classified', () => {
    const raised = codesRaisedIn(migrationTexts(), 'inventory');
    expect(raised.size).toBeGreaterThan(60);
    for (const code of raised) {
      if (MIGRATION_TIME_ONLY.has(code)) continue;
      expect(() => classifiedRefusal(code), code).not.toThrow();
    }
  });

  it("every code of the package's InventoryErrorCode is classified", () => {
    const union = read('packages/inventory/src/errors.ts');
    const codes = [...union.matchAll(/^\s*\| '((?:inventory|purchase)\.[a-z_]+)'/gm)].map((m) => m[1] ?? '');
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) expect(() => classifiedRefusal(code), code).not.toThrow();
  });

  it('every inventory.* code §3 does not restate keeps the accepted P3-S3 status', () => {
    const raised = codesRaisedIn(migrationTexts(), 'inventory');
    for (const code of raised) {
      if (MIGRATION_TIME_ONLY.has(code) || S4_INVENTORY.has(code)) continue;
      const mine = purchasingInventoryRefusal(code);
      const s3 = inventoryRefusal(code);
      expect({ code, status: mine.httpStatus, api: mine.code }).toEqual({ code, status: s3.httpStatus, api: s3.code });
    }
  });

  it('a 500-class §3 code surfaces as its typed code', () => {
    expect(purchasingInventoryRefusal('inventory.deficit_state_invalid')).toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
      details: { inventoryCode: 'inventory.deficit_state_invalid' },
    });
  });

  it('an unclassified code is a typed failure, never a default status', () => {
    for (const code of [
      'purchase.bogus_refusal',
      'supplier.not_founds',
      'inventory.bogus_refusal',
      'catalog.product_not_found',
      'purchase.migration_end_state_invalid',
    ]) {
      expect(() => classifiedRefusal(code), code).toThrow(UnclassifiedRefusalError);
    }
    expect(() => statusOf('inventory.probe_rollback')).toThrow(UnclassifiedRefusalError);
  });

  it('package refusals map through the same table', () => {
    expect(purchasingPackageRefusal(new InventoryError('purchase.total_zero', 'x'))).toMatchObject({
      httpStatus: 422,
      details: { purchasingCode: 'purchase.total_zero' },
    });
    expect(purchasingPackageRefusal(new InventoryError('inventory.deficit_state_invalid', 'x'))).toMatchObject({ httpStatus: 500 });
    expect(purchasingPackageRefusal(new InventoryError('inventory.unit_cost_required', 'x', { reason: 'r' }))).toMatchObject({
      httpStatus: 400,
      details: { reason: 'r', inventoryCode: 'inventory.unit_cost_required' },
    });
  });
});

/** Every inventory migration's text, concatenated. */
function migrationTexts(): string {
  return [
    '0059_inventory_stock_ledger.sql',
    '0060_inventory_stock_primitive.sql',
    '0061_inventory_movement_sources.sql',
    '0062_inventory_movement_commands.sql',
    '0063_purchases_suppliers_sources.sql',
    '0064_purchase_commands.sql',
  ]
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

/** A PostgreSQL error as `pg` raises it: a message and a SQLSTATE, and the constraint of a key refusal. */
function pgError(code: string, message: string, constraint?: string): Error {
  return Object.assign(new Error(message), { code, ...(constraint === undefined ? {} : { constraint }) });
}

function caught(error: unknown): unknown {
  try {
    rethrowPurchasingRefusal(error);
  } catch (e) {
    return e;
  }
  throw new Error('rethrowPurchasingRefusal returned');
}

describe('purchasing error model — refusals raised by the database, at the routine and at COMMIT (I3)', () => {
  it('a routine refusal carries its §3 status', () => {
    expect(caught(pgError('P0001', 'purchase.not_found: the purchase is not visible'))).toMatchObject({
      httpStatus: 404,
      details: { purchasingCode: 'purchase.not_found' },
    });
    expect(caught(pgError('P0001', 'supplier.state_invalid: already archived'))).toMatchObject({
      httpStatus: 409,
      details: { purchasingCode: 'supplier.state_invalid' },
    });
    expect(caught(pgError('P0001', 'inventory.valuation_changed: moved'))).toMatchObject({
      httpStatus: 409,
      details: { inventoryCode: 'inventory.valuation_changed' },
    });
  });

  it('a deferred S4 guard raised at COMMIT surfaces as its typed code', () => {
    expect(caught(pgError('P0001', 'inventory.source_value_mismatch: at commit'))).toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
      details: { inventoryCode: 'inventory.source_value_mismatch' },
    });
    expect(caught(pgError('P0001', 'purchase.landed_cost_allocation_mismatch: at commit'))).toMatchObject({ httpStatus: 422 });
    const accounting = caught(pgError('P0001', 'accounting.inventory_entry_mismatch: at commit'));
    expect(accounting).toBeInstanceOf(AccountingError);
    expect(accounting).toMatchObject({ code: 'accounting.inventory_entry_mismatch' });
  });

  it.each([
    ['23503', 'purchases_binding_fk', 'purchase'],
    ['23001', 'purchases_binding_fk', 'purchase'],
    ['23503', 'negative_inventory_cost_adjustments_binding_fk', 'negative_inventory_cost_adjustment'],
    ['23001', 'negative_inventory_cost_adjustments_binding_fk', 'negative_inventory_cost_adjustment'],
  ])('a deferred binding FK refused at COMMIT (%s, %s) is accounting.inventory_detail_missing', (sqlstate, constraint, sourceType) => {
    const e = caught(pgError(sqlstate, `insert or update on table violates foreign key constraint "${constraint}"`, constraint));
    expect(e).toBeInstanceOf(AccountingError);
    expect(e).toMatchObject({ code: 'accounting.inventory_detail_missing', context: { sourceType } });
  });

  it.each(['23503', '23001'])('a stock-source bridge FK (%s) is inventory.source_line_frozen, 500-class', (sqlstate) => {
    expect(caught(pgError(sqlstate, 'update or delete violates foreign key constraint', 'stock_source_bridge_purchase_line_fk'))).toMatchObject({
      httpStatus: 500,
      details: { inventoryCode: 'inventory.source_line_frozen' },
    });
  });

  it('any other foreign key, and an unrecognised failure, is re-thrown untouched', () => {
    const fk = pgError('23503', 'violates foreign key constraint', 'purchases_supplier_fk');
    expect(caught(fk)).toBe(fk);
    const infra = pgError('08006', 'connection failure');
    expect(caught(infra)).toBe(infra);
  });

  it('an unclassified database code is a typed failure', () => {
    expect(caught(pgError('P0001', 'purchase.bogus_refusal: x'))).toBeInstanceOf(UnclassifiedRefusalError);
    expect(caught(pgError('P0001', 'inventory.bogus_refusal: x'))).toBeInstanceOf(UnclassifiedRefusalError);
  });
});
