import { Inject, Injectable } from '@nestjs/common';
import { customerCreatePayload, customerUpdatePayload, normalizeDocumentText, type CustomerText, type MovementPayload } from '@daftar/inventory';
import type { CustomerCommandResultDto } from '@daftar/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { Database, type TransactionSql } from '../../infra/database';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { CustomerReadService, findCustomer } from './customer-reads';
import { auditThenRethrowSellingRefusal, type SellingAttempt } from './selling-refusal-audit';
import { sellingRefusal } from './selling-errors';
import type { CustomerWriteCreateRequest, CustomerWriteUpdateRequest } from './selling.schemas';

/**
 * `POST /v1/customers` and `PUT /v1/customers/:customerId` (P4-S1; owner
 * decision DR-142, 2026-11-12).
 *
 * The flow of each command is the accepted `SupplierService` flow
 * (`purchasing/supplier.service.ts:23-37`), step for step, because DR-142
 * approved this slice as "`withBusinessInventoryTransaction` in the `supplier_*`
 * shape":
 *
 *   the permission (`customers.manage`, checked by the route guard before a
 *   body is parsed) → the exact payload and its intent digest → the idempotency
 *   proof against the stored row (`create_intent_sha256` for a create,
 *   `last_intent_sha256` with the revision it produced for an update), BEFORE
 *   any other read → the `invctl/1` assertion minted over that payload → the
 *   definer routine inside `withBusinessInventoryTransaction`, which proves it
 *   all again under the per-customer advisory key → the answer, read back from
 *   the stored row.
 *
 * THE TABLE IS NEVER WRITTEN FROM HERE. `daftar_app` holds no INSERT and no
 * UPDATE on `customers` (`0075:494`, and `0091` deliberately grants it none),
 * so the only path to a write is `customer_create` / `customer_update`. This
 * service issues exactly two `SELECT … FROM customer_*` calls and no DML
 * statement of its own.
 *
 * NO CLOCK IS READ. The customer id is the caller's idempotency key (the
 * `saleId` precedent, `selling.schemas.ts:337`) and the trace id is minted once
 * at the API boundary; neither this service nor either routine derives a date,
 * a period or an FX instant, because a customer carries none.
 *
 * Text is trimmed once here (`normalizeDocumentText`) and the routine receives
 * exactly the text whose words were signed. An update states the whole
 * customer: an omitted optional field is cleared, never merged.
 *
 * Contacts are out of DR-142's scope and the mounted schemas refuse them
 * (`selling.schemas.ts`, `CustomerWriteCreateSchema`), so no code path here
 * reaches `customer_contacts`.
 */
@Injectable()
export class CustomerService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(CustomerReadService) private readonly reads: CustomerReadService,
    // P4-AL-48: a refusal is audited as heavily as a success, and a customer
    // command is refused inside a routine whose `RAISE EXCEPTION` aborts the
    // transaction — so without this, a refused create or update would persist
    // no evidence at all. The precedent is `SaleCommitService`
    // (`sale-commit.service.ts:132`).
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(m: MembershipContext, input: CustomerWriteCreateRequest, btx: BusinessTransactionId): Promise<CustomerCommandResultDto> {
    // Built BEFORE the try, so a refusal raised on the command's very first
    // line still has the id, the operation and the request's own facts to
    // audit; the intent digest is filled in as it is learned.
    const attempt = customerAttempt('customer.create', input.customerId, input);
    try {
      const authority = await this.authorization.authorize(m, 'customer.create', btx);
      const text = customerText(input);
      const built = customerCreatePayload({ tenantId: m.tenantId, businessId: m.businessId, customerId: input.customerId, ...text });
      attempt.intentSha256 = built.intentSha256;

      // The idempotency proof comes first and reads nothing else: the id is
      // the caller's key, so the same id under a different intent is a second
      // customer wearing a used key and is refused rather than overwritten.
      const existing = await findCustomer(this.db, m, input.customerId);
      if (existing !== null) {
        if (existing.create_intent_sha256 !== built.intentSha256) throw sellingRefusal('customer.idempotency_conflict');
        return await this.answer(m, input.customerId, true);
      }

      return await this.execute(m, authority, built, input.customerId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM customer_create($1::uuid, $2::text, $3::text, $4::text, $5::text)`, [
          input.customerId,
          text.name,
          text.phone,
          text.email,
          text.notes,
        ]),
      );
    } catch (e) {
      // The composer produces the refusal that will leave, classifies THAT
      // object, writes the row and throws the same object. Nothing is
      // swallowed or reshaped: it ends in `rethrowSellingRefusal` exactly as
      // this method did before, so the merchant's refusal is unchanged.
      return await auditThenRethrowSellingRefusal(this.audit, m, attempt, e);
    }
  }

  async update(m: MembershipContext, customerId: string, input: CustomerWriteUpdateRequest, btx: BusinessTransactionId): Promise<CustomerCommandResultDto> {
    const attempt = customerAttempt('customer.update', customerId, input);
    try {
      const authority = await this.authorization.authorize(m, 'customer.update', btx);
      const text = customerText(input);
      const built = customerUpdatePayload({
        tenantId: m.tenantId,
        businessId: m.businessId,
        customerId,
        expectedRevision: input.expectedRevision,
        ...text,
      });
      attempt.intentSha256 = built.intentSha256;

      const replay = await this.prove(m, customerId, input.expectedRevision, built.intentSha256);
      if (replay !== null) return replay;

      return await this.execute(m, authority, built, customerId, (sql) =>
        sql.query<{ replayed: boolean }>(`SELECT replayed FROM customer_update($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::text)`, [
          customerId,
          input.expectedRevision,
          text.name,
          text.phone,
          text.email,
          text.notes,
        ]),
      );
    } catch (e) {
      return await auditThenRethrowSellingRefusal(this.audit, m, attempt, e);
    }
  }

  /**
   * The update's replay proof: the stored revision is the one this command
   * would have produced AND the stored intent is this command's → the stored
   * answer. A revision that moved otherwise is `customer.revision_changed`.
   * The routine proves the same two facts again under its own lock, which is
   * what makes this an optimisation rather than the authority.
   */
  private async prove(m: MembershipContext, customerId: string, expectedRevision: number, intentSha256: string): Promise<CustomerCommandResultDto | null> {
    const existing = await findCustomer(this.db, m, customerId);
    if (existing === null) throw sellingRefusal('customer.not_found');
    if (existing.revision === expectedRevision + 1 && existing.last_intent_sha256 === intentSha256) return await this.answer(m, customerId, true);
    if (existing.revision !== expectedRevision) throw sellingRefusal('customer.revision_changed');
    return null;
  }

  /** Mint over the exact payload, run the routine on seam 1, and answer from the stored row. */
  private async execute(
    m: MembershipContext,
    authority: InventoryCommandAuthority,
    built: MovementPayload,
    customerId: string,
    call: (sql: TransactionSql) => Promise<{ readonly rows: readonly { replayed: boolean }[] }>,
  ): Promise<CustomerCommandResultDto> {
    const assertion = this.authorization.mint(authority, built.payload);
    const replayed = await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
      const [row] = (await call(tx)).rows;
      if (row === undefined) throw new Error('a customer routine returned no row');
      return row.replayed;
    });
    return await this.answer(m, customerId, replayed);
  }

  /**
   * The answer is READ BACK, never assembled from the request: the merchant
   * sees the stored row, so a routine that stored something other than what
   * was asked cannot be hidden by echoing the input.
   */
  private async answer(m: MembershipContext, customerId: string, replayed: boolean): Promise<CustomerCommandResultDto> {
    const stored = await findCustomer(this.db, m, customerId);
    if (stored === null) throw new Error('a customer the routine wrote is not readable');
    return { ...(await this.reads.get(m, customerId)), replayed, businessTransactionId: stored.business_transaction_id };
  }
}

/**
 * What a refused customer command knows about itself (P4-AL-48), built from the
 * REQUEST alone so that a refusal on the command's first line still audits.
 *
 * `branchId` and `tillSessionId` are NULL and that is the TRUTH rather than a
 * gap: a customer is business-wide master data and names no branch (P4-AL-37),
 * and no customer command runs on a till.
 *
 * THE FIGURES CARRY NO CUSTOMER TEXT, ON PURPOSE. `audit_events.metadata` is
 * "safe metadata only" (`0004:11`) and P4-AL-54 governs what a refusal may
 * record. A name, a phone or an email is the merchant's customer's personal
 * data, and a refused attempt is exactly the row most likely to be read by
 * someone debugging rather than by the merchant who owns it — so what is
 * recorded is WHICH FIELDS the statement named, never their contents. The
 * entity id and the intent digest already identify the attempt uniquely, and
 * the digest distinguishes two different statements of the same id without
 * revealing either.
 *
 * There is no money figure because a customer carries none: its position is
 * derived from the ledger (P4-AL-06), never from this record.
 */
function customerAttempt(
  operation: 'customer.create' | 'customer.update',
  customerId: string,
  input: { readonly phone?: string | null; readonly email?: string | null; readonly notes?: string | null; readonly expectedRevision?: number },
): SellingAttempt {
  const attempt: SellingAttempt = {
    operation,
    entity: 'customer',
    entityId: customerId,
    branchId: null,
    tillSessionId: null,
    figures: {
      statesPhone: input.phone !== undefined && input.phone !== null,
      statesEmail: input.email !== undefined && input.email !== null,
      statesNotes: input.notes !== undefined && input.notes !== null,
    },
  };
  // A decimal string, never a JSON number — the shape `RefusalAttempt.figures`
  // requires and the one `openingFloatMinor` already uses.
  if (input.expectedRevision !== undefined) attempt.figures['expectedRevision'] = String(input.expectedRevision);
  return attempt;
}

/** The four texts as the customer stores them: trimmed, NULL when empty or omitted (a full statement). */
function customerText(input: {
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
}): CustomerText {
  return {
    // The DTO guarantees a non-empty name; an empty one would reach the
    // builder as '' and be refused there (`inventory.payload_invalid`).
    name: normalizeDocumentText(input.name) ?? '',
    phone: normalizeDocumentText(input.phone),
    email: normalizeDocumentText(input.email),
    notes: normalizeDocumentText(input.notes),
  };
}
