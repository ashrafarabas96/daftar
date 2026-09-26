import { Inject, Injectable } from '@nestjs/common';
import { formatQuantity, outboundValue, toQ4, transferPayload } from '@daftar/inventory';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import type { BusinessTransactionId } from './business-transaction';
import { InventoryAuthorizationService } from './inventory-authorization';
import { inventoryRefusal, rethrowMovementRefusal } from './inventory-errors';
import {
  assertMovableVariant,
  findTransfer,
  readStockStates,
  readStoredResult,
  readWarehouses,
  resolveVariants,
  stockKey,
  type MovementDocumentResult,
} from './inventory-stock-read';

/** A transfer request, as the controller hands it over after strict DTO validation (A-21). */
export interface TransferInput {
  /** The client-chosen document id: the idempotency key and the stock `source_id`. */
  readonly transferId: string;
  readonly sourceWarehouseId: string;
  readonly destinationWarehouseId: string;
  /** 1..200 lines in request order; `quantity` is a positive decimal string. */
  readonly lines: readonly { readonly productId: string; readonly variantId?: string | null; readonly quantity: string }[];
}

/** The row `inventory_transfer_stock` returns per line. */
interface TransferRow {
  document_id: string;
  replayed: boolean;
  line_id: string;
  variant_id: string;
  value_moved_base_minor: string;
}

/**
 * `POST /v1/inventory/transfers` (PHASE_3_S3_CONTRACT A-04, A-08, A-10, A-21).
 *
 * A same-business transfer moves stock and value between two warehouses and
 * posts NO journal (L:537): it runs on seam 1 and no accounting assertion is
 * ever minted for it. The flow is the locked order of A-10(c):
 *
 *   permission and scope over BOTH warehouses → variant resolution →
 *   idempotency proof (stored intent digest; a replay reads stored rows only)
 *   → current state (warehouses, variants, stock) → mint → seam 1 →
 *   `inventory_transfer_stock`, which verifies and consumes the assertion
 *   first → commit.
 */
@Injectable()
export class InventoryTransferService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  async transfer(m: MembershipContext, input: TransferInput, businessTransactionId: BusinessTransactionId): Promise<MovementDocumentResult> {
    try {
      return await this.run(m, input, businessTransactionId);
    } catch (e) {
      return rethrowMovementRefusal(e);
    }
  }

  private async run(m: MembershipContext, input: TransferInput, businessTransactionId: BusinessTransactionId): Promise<MovementDocumentResult> {
    const { sourceWarehouseId: source, destinationWarehouseId: destination } = input;
    if (source === destination) throw inventoryRefusal('inventory.transfer_same_warehouse');
    // 1–4. Permission and warehouse scope over both warehouses, before anything else.
    const authority = await this.authorization.authorize(m, 'inventory.transfer', businessTransactionId, [source, destination]);
    const scope = { tenantId: m.tenantId, businessId: m.businessId };

    // 5. Validation and variant resolution.
    const resolved = await resolveVariants(this.db, scope, input.lines);
    const qtys = input.lines.map((l) => toQ4(l.quantity));
    const built = transferPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      transferId: input.transferId,
      sourceWarehouseId: source,
      destinationWarehouseId: destination,
      lines: resolved.map((r, i) => ({ variantId: r.variantId, qtyQ4: qtys[i] ?? 0n })),
    });

    // 6. The idempotency proof, before any current-state read.
    const existing = await findTransfer(this.db, scope, input.transferId);
    if (existing !== null) {
      if (existing.intentSha256 !== built.intentSha256) throw inventoryRefusal('inventory.idempotency_conflict');
      return readStoredResult(this.db, scope, 'inventory_transfer', input.transferId, true, existing.businessTransactionId);
    }

    // 7. Current state: both warehouses exist, the destination is active;
    // every variant is tracked and exact; the source holds enough.
    await readWarehouses(this.db, scope, [source, destination], [destination]);
    resolved.forEach((r, i) => assertMovableVariant(r, qtys[i] ?? 0n, true));
    const states = await readStockStates(
      this.db,
      scope,
      resolved.map((r) => ({ warehouseId: source, variantId: r.variantId })),
    );
    resolved.forEach((r, i) => {
      const state = states.get(stockKey(source, r.variantId));
      if (state === undefined) throw new Error('a stock state was not read');
      outboundValue(state, -(qtys[i] ?? 0n));
    });

    // 8–12. Mint over the exact payload; seam 1 — a transfer never holds a
    // posting capability; the routine; commit.
    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const r = await tx.query<TransferRow>(
        `SELECT document_id, replayed, line_id, variant_id, value_moved_base_minor::text AS value_moved_base_minor
           FROM inventory_transfer_stock($1::uuid, $2::uuid, $3::uuid, $4::uuid[], $5::numeric[])`,
        [input.transferId, source, destination, resolved.map((v) => v.variantId), qtys.map(formatQuantity)],
      );
      const first = r.rows[0];
      if (first === undefined) throw new Error('inventory_transfer_stock returned no row');
      return first.replayed;
    });
    // A replay caught inside the routine (a concurrent identical request)
    // answers with the trace id of the operation that wrote the document.
    const trace = replayed ? ((await findTransfer(this.db, scope, input.transferId))?.businessTransactionId ?? businessTransactionId) : businessTransactionId;
    return readStoredResult(this.db, scope, 'inventory_transfer', input.transferId, replayed, trace);
  }
}
