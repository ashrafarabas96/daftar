import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import { configureProductPayload } from '@daftar/inventory';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { BusinessTransactionId } from './business-transaction';
import { InventoryAuthorizationService } from './inventory-authorization';
import type { InventoryConfigurationInput } from './inventory-configuration.schemas';
import { rethrowInventoryRefusal } from './inventory-errors';

/** The configuration a product holds after the command, read back from the database. */
export interface InventoryConfigurationResult {
  readonly productId: string;
  readonly trackInventory: boolean;
  readonly unitCode: string | null;
  readonly unitDecimals: number | null;
  /** The trace id of this operation (P3-AL-35). Observability only. */
  readonly businessTransactionId: BusinessTransactionId;
}

interface ProductConfigurationRow {
  track_inventory: boolean;
  unit_code: string | null;
  unit_decimals: number | null;
}

/**
 * The inventory configuration command (P3-AL-04, P3-AL-05, P3-AL-54 §E,
 * P3-AL-55 §I): enable or disable tracking and select the canonical unit of a
 * product.
 *
 * The flow is the locked one and no other:
 *
 *   authentication and MembershipContext   (AuthGuard)
 *   → `inventory.adjust`                   (route guard, then `authorize` again here)
 *   → payload validation                   (strict schema; product in the business; unit in the registry)
 *   → mint `inventory.configure_product`   over the exact payload the routine will receive
 *   → `withBusinessInventoryTransaction`
 *   → `inventory_configure_product`        which verifies and consumes the assertion first
 *
 * The application writes NOTHING itself. The three configuration columns and
 * the hidden base variant have one writer — the routine, running as
 * `daftar_inventory_internal` — and the routine writes the audit row with the
 * actor taken from the verified assertion, so this service writes no second
 * one. There is no `trusted`, `force` or skip parameter at any layer.
 */
@Injectable()
export class InventoryConfigurationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  async configureProduct(
    m: MembershipContext,
    productId: string,
    input: InventoryConfigurationInput,
    businessTransactionId: BusinessTransactionId,
  ): Promise<InventoryConfigurationResult> {
    // Product configuration affects no warehouse, so the scope half of
    // P3-AL-39 is empty; the permission half is `inventory.adjust`.
    const authority = await this.authorization.authorize(m, 'inventory.configure_product');

    const scope = { tenantId: m.tenantId, businessId: m.businessId };
    // Row level security answers "not found" for another business's product,
    // so a foreign UUID is refused here, before anything is minted.
    const current = (
      await this.db.scoped<ProductConfigurationRow>(
        scope,
        'SELECT track_inventory, unit_code, unit_decimals FROM products WHERE business_id = $1 AND id = $2',
        [m.businessId, productId],
      )
    ).rows[0];
    if (!current) throw AppError.notFound('Product not found');

    const unitCode = input.unitCode === undefined ? current.unit_code : input.unitCode;
    // A code the registry does not hold is refused before anything is signed.
    const registryDefault = unitCode === null ? null : await this.registryDefaultDecimals(scope, unitCode);
    let unitDecimals: number | null;
    if (input.unitDecimals !== undefined) {
      unitDecimals = input.unitDecimals;
    } else if (unitCode !== null && unitCode === current.unit_code && current.unit_decimals !== null) {
      // The unit is unchanged: its decimals were frozen on the product at
      // selection and are not re-derived from a registry default that may
      // have moved since (P3-AL-05 §D, matrix row 8).
      unitDecimals = current.unit_decimals;
    } else {
      // Selecting a unit: the registry default is the initial suggestion,
      // persisted on the product from here on.
      unitDecimals = registryDefault;
    }

    if (input.trackInventory && (unitCode === null || unitDecimals === null)) {
      // P3-AL-04 §3/§4: a tracked product physically cannot exist without a
      // canonical unit. Refused here with a stable code; the table's CHECK
      // refuses it again.
      throw AppError.validation({ unitCode: ['unit_required'], inventoryCode: 'inventory.unit_required' });
    }
    if (unitCode === null && unitDecimals !== null) {
      throw AppError.validation({ unitDecimals: ['unit_decimals_without_unit'] });
    }

    const payload = configureProductPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      productId,
      trackInventory: input.trackInventory,
      unitCode,
      unitDecimals,
    });
    const assertion = this.authorization.mint(authority, payload);

    try {
      const after = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
        await tx.query('SELECT inventory_configure_product($1::uuid, $2::boolean, $3::text, $4::smallint)', [
          productId,
          input.trackInventory,
          unitCode,
          unitDecimals,
        ]);
        return (
          await tx.query<ProductConfigurationRow>('SELECT track_inventory, unit_code, unit_decimals FROM products WHERE business_id = $1 AND id = $2', [
            m.businessId,
            productId,
          ])
        ).rows[0];
      });
      if (!after) throw AppError.notFound('Product not found');
      return {
        productId,
        trackInventory: after.track_inventory,
        unitCode: after.unit_code,
        unitDecimals: after.unit_decimals,
        businessTransactionId,
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      return rethrowInventoryRefusal(e);
    }
  }

  /** The registry's suggested decimals for a unit; refuses a code the registry does not hold. */
  private async registryDefaultDecimals(scope: { tenantId: string; businessId: string }, unitCode: string): Promise<number> {
    const row = (await this.db.scoped<{ default_decimals: number }>(scope, 'SELECT default_decimals FROM units WHERE unit_code = $1', [unitCode])).rows[0];
    if (!row) throw AppError.validation({ unitCode: ['unit_unknown'], inventoryCode: 'inventory.unit_unknown' });
    return row.default_decimals;
  }
}
