import { Inject, Injectable } from '@nestjs/common';
import {
  normalizeDocumentText,
  supplierArchivePayload,
  supplierCreatePayload,
  supplierReactivatePayload,
  supplierUpdatePayload,
  type MovementPayload,
  type SupplierText,
} from '@daftar/inventory';
import type { SupplierCommandResultDto } from '@daftar/shared-contracts';
import { Database, type TransactionSql } from '../../infra/database';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal, rethrowPurchasingRefusal } from './purchasing-errors';
import { findSupplier, supplierDto, type SupplierRow } from './purchasing-reads';
import type { SupplierCreateRequest, SupplierLifecycleRequest, SupplierUpdateRequest } from './purchasing.schemas';

type LifecycleKind = 'supplier.archive' | 'supplier.reactivate';

/**
 * `POST/PUT /v1/suppliers…` (PHASE_3_S4_CONTRACT A-03, A-04, A-09, A-10, A-11).
 *
 * The flow of every command is A-10(c): the permission (`suppliers.manage`,
 * no warehouse: TL-4) → the exact payload and its intent digest → the
 * idempotency proof against the stored row (`create_intent_sha256` for a
 * create, `last_intent_sha256` with the revision it produced for the rest),
 * BEFORE any other read → the `invctl/1` assertion over the payload → seam 1
 * (a supplier posts nothing, L:981) → the routine, which proves it all again
 * under the per-supplier advisory key → the answer, read from the stored row.
 *
 * Text is trimmed once here (`normalizeDocumentText`), and the routine
 * receives exactly the text whose words were signed. An update states the
 * whole supplier: an omitted optional field is cleared.
 */
@Injectable()
export class SupplierService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  async create(m: MembershipContext, input: SupplierCreateRequest, btx: BusinessTransactionId): Promise<SupplierCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, 'supplier.create', btx);
      const text = supplierText(input);
      const built = supplierCreatePayload({ tenantId: m.tenantId, businessId: m.businessId, supplierId: input.supplierId, ...text });

      const existing = await findSupplier(this.db, m, input.supplierId);
      if (existing !== null) {
        if (existing.create_intent_sha256 !== built.intentSha256) throw purchasingRefusal('supplier.idempotency_conflict');
        return answer(existing, true);
      }

      return await this.execute(authority, built, input.supplierId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM supplier_create($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)`, [
          input.supplierId,
          text.name,
          text.phone,
          text.email,
          text.taxIdentifier,
          text.notes,
        ]),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  async update(m: MembershipContext, supplierId: string, input: SupplierUpdateRequest, btx: BusinessTransactionId): Promise<SupplierCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, 'supplier.update', btx);
      const text = supplierText(input);
      const built = supplierUpdatePayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        supplierId,
        expectedRevision: input.expectedRevision,
        ...text,
      });

      const replay = await this.prove(m, supplierId, input.expectedRevision, built.intentSha256);
      if (replay !== null) return replay;

      return await this.execute(authority, built, supplierId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM supplier_update($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text)`, [
          supplierId,
          input.expectedRevision,
          text.name,
          text.phone,
          text.email,
          text.taxIdentifier,
          text.notes,
        ]),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  async archive(m: MembershipContext, supplierId: string, input: SupplierLifecycleRequest, btx: BusinessTransactionId): Promise<SupplierCommandResultDto> {
    return this.lifecycle(m, 'supplier.archive', supplierId, input, btx);
  }

  async reactivate(m: MembershipContext, supplierId: string, input: SupplierLifecycleRequest, btx: BusinessTransactionId): Promise<SupplierCommandResultDto> {
    return this.lifecycle(m, 'supplier.reactivate', supplierId, input, btx);
  }

  private async lifecycle(
    m: MembershipContext,
    kind: LifecycleKind,
    supplierId: string,
    input: SupplierLifecycleRequest,
    btx: BusinessTransactionId,
  ): Promise<SupplierCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, kind, btx);
      const payloadInput = { tenantId: m.tenantId, businessId: m.businessId, supplierId, expectedRevision: input.expectedRevision };
      const built = kind === 'supplier.archive' ? supplierArchivePayload(payloadInput) : supplierReactivatePayload(payloadInput);

      const replay = await this.prove(m, supplierId, input.expectedRevision, built.intentSha256);
      if (replay !== null) return replay;

      const routine = kind === 'supplier.archive' ? 'supplier_archive' : 'supplier_reactivate';
      return await this.execute(authority, built, supplierId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM ${routine}($1::uuid, $2::integer)`, [supplierId, input.expectedRevision]),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  /**
   * A-10(c) for update, archive and reactivate: the stored revision is the
   * one this command would have produced and the stored intent is this
   * command's → the stored answer. Otherwise a moved revision is
   * `supplier.revision_changed`; the state rules (`supplier.state_invalid`)
   * are the routine's, under its lock.
   */
  private async prove(scope: ReadScope, supplierId: string, expectedRevision: number, intentSha256: string): Promise<SupplierCommandResultDto | null> {
    const existing = await findSupplier(this.db, scope, supplierId);
    if (existing === null) throw purchasingRefusal('supplier.not_found');
    if (existing.revision === expectedRevision + 1 && existing.last_intent_sha256 === intentSha256) return answer(existing, true);
    if (existing.revision !== expectedRevision) throw purchasingRefusal('supplier.revision_changed');
    return null;
  }

  /** Mint over the exact payload, run the routine on seam 1, and answer from the stored row. */
  private async execute(
    authority: InventoryCommandAuthority,
    built: MovementPayload,
    supplierId: string,
    call: (sql: TransactionSql) => Promise<{ readonly rows: readonly { replayed: boolean }[] }>,
  ): Promise<SupplierCommandResultDto> {
    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const [row] = (await call(tx)).rows;
      if (row === undefined) throw new Error('a supplier routine returned no row');
      return row.replayed;
    });
    const stored = await findSupplier(this.db, authority.scope, supplierId);
    if (stored === null) throw new Error('a supplier the routine wrote is not readable');
    return answer(stored, replayed);
  }
}

/** The five texts as the document stores them: trimmed, NULL when empty or omitted (a full statement). */
function supplierText(input: {
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly taxIdentifier?: string | null;
  readonly notes?: string | null;
}): SupplierText {
  return {
    // The DTO guarantees a non-empty name; an empty one would reach the
    // builder as '' and be refused there (`inventory.payload_invalid`).
    name: normalizeDocumentText(input.name) ?? '',
    phone: normalizeDocumentText(input.phone),
    email: normalizeDocumentText(input.email),
    taxIdentifier: normalizeDocumentText(input.taxIdentifier),
    notes: normalizeDocumentText(input.notes),
  };
}

function answer(row: SupplierRow, replayed: boolean): SupplierCommandResultDto {
  return { ...supplierDto(row), replayed, businessTransactionId: row.business_transaction_id };
}
