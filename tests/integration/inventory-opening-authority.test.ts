/**
 * P3-S3 review F4 (coordinator ruling) — recording an inventory opening posts
 * to opening equity and reveals the accounting position, so it needs
 * `inventory.adjust` with BUSINESS-WIDE scope. Unit-level: the authorization
 * seam is exercised directly, with a database that counts every read, so the
 * refusal is proven to come before any warehouse lookup and before the minter.
 * And `inventory.opening_valuation_mismatch` leaves the service as the code
 * alone: no total of the stock or of the opening position.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError, TrustedRoleSet } from '@daftar/domain-core';
// The package as the service imports it, so the refusal is the same class the service maps.
import { assertOpeningMatchesPosition } from '@daftar/inventory';
import type { Database } from '../../apps/api/src/infra/database';
import type { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { InventoryAuthorizationService } from '../../apps/api/src/modules/inventory/inventory-authorization';
import { rethrowMovementRefusal } from '../../apps/api/src/modules/inventory/inventory-errors';
import { newBusinessTransactionId } from '../../apps/api/src/modules/inventory/business-transaction';
import type { MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';

const WAREHOUSE = randomUUID();
const BRANCH = randomUUID();

/** A database whose only query answers "every named warehouse is reachable from the assigned branch". */
function countingDb(): { db: Database; reads: () => number } {
  let reads = 0;
  const db = {
    scoped: async (_scope: unknown, _text: string, params: unknown[] = []) => {
      reads += 1;
      return { rows: (params[1] as string[]).map((warehouse_id) => ({ warehouse_id })) };
    },
  } as unknown as Database;
  return { db, reads: () => reads };
}

const minter = {
  mint: () => {
    throw new Error('the minter is never reached in these cases');
  },
} as unknown as InventoryAssertionMinterService;

function member(mode: 'all' | 'assigned', permissions: readonly string[]): MembershipContext {
  return {
    tenantId: randomUUID(),
    businessId: randomUUID(),
    userId: randomUUID(),
    roles: TrustedRoleSet.fromPersistence([{ key: 'stock-keeper', isSystem: false, permissions: new Set(permissions) }]),
    roleKeys: ['stock-keeper'],
    branchScopeMode: mode,
    allowedBranchIds: mode === 'assigned' ? [BRANCH] : [],
  };
}

async function refusal(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('F4 — inventory.opening requires inventory.adjust with business-wide scope', () => {
  it('an assigned-scope actor holding inventory.adjust, whose warehouse IS in scope, is refused 403 inventory.business_wide_scope_required before any read', async () => {
    const { db, reads } = countingDb();
    const svc = new InventoryAuthorizationService(db, minter);
    const e = await refusal(() => svc.authorize(member('assigned', ['inventory.adjust']), 'inventory.opening', newBusinessTransactionId(), [WAREHOUSE]));
    expect(e.httpStatus).toBe(403);
    expect(e.details).toEqual({ inventoryCode: 'inventory.business_wide_scope_required' });
    expect(reads()).toBe(0);
  });

  it('the same assigned-scope actor may still adjust that warehouse (the ruling is the opening’s alone)', async () => {
    const { db, reads } = countingDb();
    const svc = new InventoryAuthorizationService(db, minter);
    const a = await svc.authorize(member('assigned', ['inventory.adjust']), 'inventory.adjust', newBusinessTransactionId(), [WAREHOUSE]);
    expect(a.opCode).toBe('inventory.adjust');
    expect(reads()).toBe(1);
  });

  it('a business-wide actor holding inventory.adjust is authorized, with every named warehouse on the authority', async () => {
    const { db, reads } = countingDb();
    const svc = new InventoryAuthorizationService(db, minter);
    const a = await svc.authorize(member('all', ['inventory.adjust']), 'inventory.opening', newBusinessTransactionId(), [WAREHOUSE, WAREHOUSE]);
    expect(a.opCode).toBe('inventory.opening');
    expect(a.warehouseIds).toEqual([WAREHOUSE]);
    expect(reads()).toBe(0);
  });

  it('a business-wide actor without inventory.adjust is refused 403 on the permission', async () => {
    const { db } = countingDb();
    const svc = new InventoryAuthorizationService(db, minter);
    const e = await refusal(() =>
      svc.authorize(member('all', ['inventory.transfer', 'inventory.stocktake']), 'inventory.opening', newBusinessTransactionId(), [WAREHOUSE]),
    );
    expect(e.httpStatus).toBe(403);
    expect(e.message).toBe('Missing permission: inventory.adjust');
  });
});

describe('F4 — inventory.opening_valuation_mismatch carries the code alone', () => {
  it('the package refusal has no details, and the HTTP refusal carries only the inventory code', () => {
    const e = refusalOf(() => assertOpeningMatchesPosition(10001n, 10000n));
    expect(e.httpStatus).toBe(409);
    expect(e.details).toEqual({ inventoryCode: 'inventory.opening_valuation_mismatch' });
    expect(JSON.stringify(e.details)).not.toMatch(/1000[01]/);
    expect(e.message).not.toMatch(/1000[01]/);
  });
});

function refusalOf(run: () => void): AppError {
  try {
    run();
  } catch (e) {
    try {
      rethrowMovementRefusal(e);
    } catch (mapped) {
      if (mapped instanceof AppError) return mapped;
      throw mapped;
    }
  }
  throw new Error('expected a refusal');
}
