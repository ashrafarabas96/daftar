import { Inject, Injectable } from '@nestjs/common';
import { AppError, hasPermission } from '@daftar/domain-core';
import {
  normalizeDocumentText,
  paymentMethodActivatePayload,
  paymentMethodCreatePayload,
  paymentMethodDeactivatePayload,
  paymentMethodUpdatePayload,
  type MovementPayload,
  type PaymentMethodNames,
  type PaymentMethodSystemType,
} from '@daftar/inventory';
import type { ListDto, PaymentMethodCommandResultDto, PaymentMethodDto, PaymentMethodNamesDto } from '@daftar/shared-contracts';
import { Database, type TransactionSql } from '../../infra/database';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import type { ReadScope } from '../inventory/inventory-stock-read';
import { rethrowPurchasingRefusal } from '../purchasing/purchasing-errors';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { paymentMethodRefusal } from './payment-method-errors';
import type { PaymentMethodCreateRequest, PaymentMethodLifecycleRequest, PaymentMethodUpdateRequest } from './payment-methods.schemas';

type LifecycleKind = 'payment.deactivate_method' | 'payment.activate_method';

/** One stored method with its names, as `daftar_app` reads it under RLS. */
interface PaymentMethodRow {
  id: string;
  system_type: PaymentMethodSystemType;
  posting_account_id: string;
  is_active: boolean;
  requires_reference: boolean;
  sort_order: number;
  revision: number;
  create_intent_sha256: string;
  last_intent_sha256: string;
  business_transaction_id: string;
  created_at: Date;
  updated_at: Date;
  name_ar: string | null;
  name_en: string | null;
  name_tr: string | null;
}

const METHOD_SELECT = `SELECT m.id, m.system_type, m.posting_account_id, m.is_active, m.requires_reference, m.sort_order, m.revision,
        m.create_intent_sha256, m.last_intent_sha256, m.business_transaction_id, m.created_at, m.updated_at,
        (SELECT n.display_name FROM payment_method_names n WHERE n.business_id = m.business_id AND n.payment_method_id = m.id AND n.locale = 'ar') AS name_ar,
        (SELECT n.display_name FROM payment_method_names n WHERE n.business_id = m.business_id AND n.payment_method_id = m.id AND n.locale = 'en') AS name_en,
        (SELECT n.display_name FROM payment_method_names n WHERE n.business_id = m.business_id AND n.payment_method_id = m.id AND n.locale = 'tr') AS name_tr
   FROM payment_methods m`;

/** The stored method, or null when it is not visible (another business's reads as absent). */
export async function findPaymentMethod(db: Database, scope: ReadScope, paymentMethodId: string): Promise<PaymentMethodRow | null> {
  const r = await db.scoped<PaymentMethodRow>(
    { tenantId: scope.tenantId, businessId: scope.businessId },
    `${METHOD_SELECT} WHERE m.business_id = $1 AND m.id = $2`,
    [scope.businessId, paymentMethodId],
  );
  return r.rows[0] ?? null;
}

/** A stored method as the API reports it; the account only to a reader of the chart (A-18). */
function methodDto(r: PaymentMethodRow, withAccount: boolean): PaymentMethodDto {
  return {
    paymentMethodId: r.id,
    systemType: r.system_type,
    ...(withAccount ? { postingAccountId: r.posting_account_id } : {}),
    isActive: r.is_active,
    requiresReference: r.requires_reference,
    sortOrder: r.sort_order,
    names: { ar: r.name_ar, en: r.name_en, tr: r.name_tr },
    revision: r.revision,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** A command's answer: the actor holds `accounting.chart.manage`, so the account is always shown. */
function answer(r: PaymentMethodRow, replayed: boolean): PaymentMethodCommandResultDto {
  return { ...methodDto(r, true), replayed, businessTransactionId: r.business_transaction_id };
}

/** The three names as the document stores them: trimmed, NULL when empty or omitted (a full statement). */
function namesOf(input: PaymentMethodNamesDto): PaymentMethodNames {
  return { ar: normalizeDocumentText(input.ar), en: normalizeDocumentText(input.en), tr: normalizeDocumentText(input.tr) };
}

/**
 * Payment methods (PHASE_3_S6_CONTRACT A-03, A-04, A-06, A-16, A-18): shared
 * infrastructure — S6's supplier payments and refunds name them, and so will
 * later phases.
 *
 * Every command is the S4 supplier flow (S4C A-10(c)): the permission
 * (`accounting.chart.manage`, no warehouse: a method is business-wide master
 * data, TL-4) → the exact payload, whose digest IS the intent (every field is
 * the client's, A-16) → the idempotency proof against the stored row
 * (`create_intent_sha256` for a create, `last_intent_sha256` with the revision
 * it produced for the rest), BEFORE any other read → the `invctl/1` assertion
 * → seam 1 (a method posts nothing) → the routine, which proves it all again
 * under the per-method advisory key and judges the account (A-06, MP-1/MP-2)
 * → the answer, read from the stored row.
 *
 * The account policy (AL-27) is implemented ONCE, in the database
 * (`accounting_settlement_account_eligibility`), and never re-stated here.
 */
@Injectable()
export class PaymentMethodService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  async create(m: MembershipContext, input: PaymentMethodCreateRequest, btx: BusinessTransactionId): Promise<PaymentMethodCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, 'payment.create_method', btx);
      const names = namesOf(input.names);
      const built = paymentMethodCreatePayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        paymentMethodId: input.paymentMethodId,
        systemType: input.systemType,
        postingAccountId: input.postingAccountId,
        requiresReference: input.requiresReference,
        sortOrder: input.sortOrder,
        names,
      });

      const existing = await findPaymentMethod(this.db, m, input.paymentMethodId);
      if (existing !== null) {
        if (existing.create_intent_sha256 !== built.intentSha256) throw paymentMethodRefusal('payment_method.idempotency_conflict');
        return answer(existing, true);
      }

      return await this.execute(authority, built, input.paymentMethodId, (sql) =>
        sql.query<{ replayed: boolean }>(
          `SELECT replayed FROM payment_method_create($1::uuid, $2::text, $3::uuid, $4::boolean, $5::integer, $6::text, $7::text, $8::text)`,
          [input.paymentMethodId, input.systemType, input.postingAccountId, input.requiresReference, input.sortOrder, names.ar, names.en, names.tr],
        ),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  async update(
    m: MembershipContext,
    paymentMethodId: string,
    input: PaymentMethodUpdateRequest,
    btx: BusinessTransactionId,
  ): Promise<PaymentMethodCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, 'payment.update_method', btx);
      const names = namesOf(input.names);
      const built = paymentMethodUpdatePayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        paymentMethodId,
        expectedRevision: input.expectedRevision,
        postingAccountId: input.postingAccountId,
        requiresReference: input.requiresReference,
        sortOrder: input.sortOrder,
        names,
      });

      const replay = await this.prove(m, paymentMethodId, input.expectedRevision, built.intentSha256);
      if (replay !== null) return replay;

      return await this.execute(authority, built, paymentMethodId, (sql) =>
        sql.query<{ replayed: boolean }>(
          `SELECT replayed FROM payment_method_update($1::uuid, $2::integer, $3::uuid, $4::boolean, $5::integer, $6::text, $7::text, $8::text)`,
          [paymentMethodId, input.expectedRevision, input.postingAccountId, input.requiresReference, input.sortOrder, names.ar, names.en, names.tr],
        ),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  async deactivate(
    m: MembershipContext,
    paymentMethodId: string,
    input: PaymentMethodLifecycleRequest,
    btx: BusinessTransactionId,
  ): Promise<PaymentMethodCommandResultDto> {
    return this.lifecycle(m, 'payment.deactivate_method', paymentMethodId, input, btx);
  }

  async activate(
    m: MembershipContext,
    paymentMethodId: string,
    input: PaymentMethodLifecycleRequest,
    btx: BusinessTransactionId,
  ): Promise<PaymentMethodCommandResultDto> {
    return this.lifecycle(m, 'payment.activate_method', paymentMethodId, input, btx);
  }

  /**
   * `GET /v1/payment-methods`: every method of the business, active and
   * inactive, in `sort_order`. Readable with `suppliers.pay`, `accounting.view`
   * or `accounting.chart.manage` (A-18); the account only for the latter two.
   */
  async list(m: MembershipContext): Promise<ListDto<PaymentMethodDto>> {
    const withAccount = this.assertReader(m);
    const r = await this.db.scoped<PaymentMethodRow>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `${METHOD_SELECT} WHERE m.business_id = $1 ORDER BY m.sort_order, m.created_at, m.id`,
      [m.businessId],
    );
    return { items: r.rows.map((row) => methodDto(row, withAccount)) };
  }

  /** `GET /v1/payment-methods/:paymentMethodId`, on the rules of `list`. */
  async get(m: MembershipContext, paymentMethodId: string): Promise<PaymentMethodDto> {
    const withAccount = this.assertReader(m);
    const row = await findPaymentMethod(this.db, m, paymentMethodId);
    if (row === null) throw paymentMethodRefusal('payment_method.not_found');
    return methodDto(row, withAccount);
  }

  /** Any of the three read permissions (A-18); true when the reader may see the posting account. */
  private assertReader(m: MembershipContext): boolean {
    const chart = hasPermission(m.roles, 'accounting.view') || hasPermission(m.roles, 'accounting.chart.manage');
    if (!chart && !hasPermission(m.roles, 'suppliers.pay'))
      throw AppError.forbidden('Missing permission: suppliers.pay, accounting.view or accounting.chart.manage');
    return chart;
  }

  private async lifecycle(
    m: MembershipContext,
    kind: LifecycleKind,
    paymentMethodId: string,
    input: PaymentMethodLifecycleRequest,
    btx: BusinessTransactionId,
  ): Promise<PaymentMethodCommandResultDto> {
    try {
      const authority = await this.authorization.authorize(m, kind, btx);
      const payloadInput = { tenantId: m.tenantId, businessId: m.businessId, paymentMethodId, expectedRevision: input.expectedRevision };
      const built = kind === 'payment.deactivate_method' ? paymentMethodDeactivatePayload(payloadInput) : paymentMethodActivatePayload(payloadInput);

      const replay = await this.prove(m, paymentMethodId, input.expectedRevision, built.intentSha256);
      if (replay !== null) return replay;

      const routine = kind === 'payment.deactivate_method' ? 'payment_method_deactivate' : 'payment_method_activate';
      return await this.execute(authority, built, paymentMethodId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM ${routine}($1::uuid, $2::integer)`, [paymentMethodId, input.expectedRevision]),
      );
    } catch (e) {
      return rethrowPurchasingRefusal(e);
    }
  }

  /**
   * The idempotency proof of update, deactivate and activate: the stored
   * revision is the one this command would have produced and the stored
   * intent is this command's → the stored answer. Otherwise a moved revision
   * is `payment_method.revision_changed`; the state and account rules are the
   * routine's, under its lock.
   */
  private async prove(
    scope: ReadScope,
    paymentMethodId: string,
    expectedRevision: number,
    intentSha256: string,
  ): Promise<PaymentMethodCommandResultDto | null> {
    const existing = await findPaymentMethod(this.db, scope, paymentMethodId);
    if (existing === null) throw paymentMethodRefusal('payment_method.not_found');
    if (existing.revision === expectedRevision + 1 && existing.last_intent_sha256 === intentSha256) return answer(existing, true);
    if (existing.revision !== expectedRevision) throw paymentMethodRefusal('payment_method.revision_changed');
    return null;
  }

  /** Mint over the exact payload, run the routine on seam 1, and answer from the stored row. */
  private async execute(
    authority: InventoryCommandAuthority,
    built: MovementPayload,
    paymentMethodId: string,
    call: (sql: TransactionSql) => Promise<{ readonly rows: readonly { replayed: boolean }[] }>,
  ): Promise<PaymentMethodCommandResultDto> {
    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const [row] = (await call(tx)).rows;
      if (row === undefined) throw new Error('a payment-method routine returned no row');
      return row.replayed;
    });
    const stored = await findPaymentMethod(this.db, authority.scope, paymentMethodId);
    if (stored === null) throw new Error('a payment method the routine wrote is not readable');
    return answer(stored, replayed);
  }
}
