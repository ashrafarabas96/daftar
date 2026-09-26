import { Inject, Injectable } from '@nestjs/common';
import { configureProductPayload } from '@daftar/inventory';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { BusinessTransactionId } from './business-transaction';
import { InventoryAuthorizationService } from './inventory-authorization';
import type { InventoryConfigurationInput } from './inventory-configuration.schemas';
import { inventoryRefusal, rethrowInventoryRefusal } from './inventory-errors';

/** The configuration a product holds after the command, as the routine reports it. */
export interface InventoryConfigurationResult {
  readonly productId: string;
  readonly trackInventory: boolean;
  readonly unitCode: string | null;
  readonly unitDecimals: number | null;
  /** False when the product already held exactly this configuration (idempotent success, no audit row). */
  readonly changed: boolean;
  /** The trace id of this operation (P3-AL-35). Observability only. */
  readonly businessTransactionId: BusinessTransactionId;
}

/** The row `inventory_configure_product` returns. */
interface ConfigureProductRow {
  product_id: string;
  track_inventory: boolean;
  unit_code: string | null;
  unit_decimals: number | null;
  changed: boolean;
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
    const authority = await this.authorization.authorize(m, 'inventory.configure_product', businessTransactionId);

    // ── Payload validation, before anything is signed ──────────────────────
    const scope = { tenantId: m.tenantId, businessId: m.businessId };
    // Row level security answers "not found" for another business's product,
    // so a foreign UUID is refused here, before anything is minted.
    const current = (
      await this.db.scoped<{ unit_code: string | null }>(scope, 'SELECT unit_code FROM products WHERE business_id = $1 AND id = $2', [m.businessId, productId])
    ).rows[0];
    if (!current) throw inventoryRefusal('inventory.product_not_found');
    if (input.unitCode !== undefined) {
      const known = await this.db.scoped(scope, 'SELECT 1 FROM units WHERE unit_code = $1', [input.unitCode]);
      if ((known.rowCount ?? 0) === 0) throw inventoryRefusal('inventory.unit_unknown');
    }
    // P3-AL-04 §3/§4: a tracked product cannot exist without a canonical
    // unit, and a precision means nothing without the unit it is for. The
    // routine and the table's CHECK refuse both again; refusing here keeps an
    // assertion from being minted for a command that cannot succeed.
    if (input.unitDecimals !== undefined && input.unitCode === undefined) throw inventoryRefusal('inventory.unit_required');
    if (input.trackInventory && input.unitCode === undefined && current.unit_code === null) throw inventoryRefusal('inventory.unit_required');

    // The exact arguments the routine will receive. NULL means "keep the
    // current unit" / "registry default on a unit change, else the current
    // precision" — resolved by the routine, under its own lock, not here.
    const unitCode = input.unitCode ?? null;
    const unitDecimals = input.unitDecimals ?? null;
    const payload = configureProductPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      productId,
      trackInventory: input.trackInventory,
      unitCode,
      unitDecimals,
    });
    const assertion = this.authorization.mint(authority, payload);

    let row: ConfigureProductRow | undefined;
    try {
      row = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
        const r = await tx.query<ConfigureProductRow>(
          'SELECT product_id, track_inventory, unit_code, unit_decimals, changed FROM inventory_configure_product($1::uuid, $2::boolean, $3::text, $4::smallint)',
          [productId, input.trackInventory, unitCode, unitDecimals],
        );
        return r.rows[0];
      });
    } catch (e) {
      return rethrowInventoryRefusal(e);
    }
    if (!row) throw new Error('inventory_configure_product returned no row');
    return {
      productId: row.product_id,
      trackInventory: row.track_inventory,
      unitCode: row.unit_code,
      unitDecimals: row.unit_decimals,
      changed: row.changed,
      businessTransactionId,
    };
  }
}
