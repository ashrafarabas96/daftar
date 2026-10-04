import { Inject, Injectable } from '@nestjs/common';
import { mintDomainPostingAssertion } from '@daftar/accounting';
import { parseMinor, parseUnitCost } from '@daftar/inventory';
import { Database } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { invoiceArState, invoiceSnapshot, settledInvoice } from './customer-payment.service';
import { planCustomerCreditApplication, type CustomerCreditState } from './customer-settlement';
import { receivablesRefusal, rethrowReceivablesRefusal } from './receivables-errors';
import { CUSTOMER_APPLY_CREDIT_OP, customerApplyCreditIntentSha256, customerApplyCreditPayload, receivablesOperationCode } from './receivables-payload';
import {
  CUSTOMER_CREDIT_SQL,
  findCustomerCreditApplicationIntent,
  readCustomerCreditApplicationResult,
  scopedReceivablesRows,
  SETTLED_INVOICES_SQL,
  type CustomerCreditRow,
  type ReceivablesReadScope,
  type SettledInvoiceRow,
} from './receivables-reads';
import { CUSTOMER_CREDIT_APPLICATION_SOURCE, receivablePostingCommand, type ReceivableSnapshot } from './receivables-settlement-posting';
import type { CustomerCreditApplicationResultDto } from './receivables-contracts';
import type { CustomerCreditApplicationRequest } from './receivables.schemas';

/**
 * `POST /v1/customer-credits/:creditId/applications` — APPLY AN EXISTING
 * CUSTOMER CREDIT TO AN INVOICE (P4-S4).
 *
 * The mirror of the accepted `SupplierCreditAllocationService`, with the
 * supplier's credit note replaced by the customer's credit and AP by AR. It is
 * the SUPPLIER COMMAND SHAPE (OQ-3): the service computes the credit release,
 * both dusts, the AR release and the realized FX, and `customer_apply_credit`
 * recomputes every one of them under its own locks and refuses
 * `customer_credit_application.settlement_changed` on any disagreement.
 *
 * The flow:
 *
 * 1. the client intent and the idempotency proof BEFORE any state read — the
 *    stored `customer_credit_applications.intent_sha256` for this
 *    caller-supplied `applicationId`;
 * 2. authority — **`payments.collect`** (OQ-5, ruled). Applying a credit moves
 *    value exactly the way an allocation does, so it needs settlement
 *    authority; the registry is a closed set of twelve and gains no
 *    `credits.*` key;
 * 3. the invoice with its `O`, the credit with its stored original pair,
 *    remaining pair and snapshot `Rn`, and the business, in ONE statement;
 * 4. the routine's refusals in its order, then every stored amount bound by
 *    `planCustomerCreditApplication`;
 * 5. both assertions minted before the seam opens;
 * 6. ONE transaction: the routine (which inserts the application BEFORE it
 *    decrements the credit, so the decrement is never visible without its
 *    cause), then — unless it answered a replay — the one entry, then COMMIT
 *    with the deferred verifiers.
 *
 * An INACTIVE customer's credit may still be applied: the credit is money the
 * business already owes, and refusing to let it settle an invoice would strand
 * it. That mirrors the accepted supplier rule (TL-13) exactly, and it is the
 * reason this service checks the customer's identity but not their status.
 *
 * Optimistic throughout: a moved `O` or a moved remaining pair is a stable 409
 * and the client retries the same body. The cap is never silently adjusted to
 * fit, and the level uniqueness `(business_id, credit_id,
 * credit_remaining_before_minor)` is the second, independent mechanism —
 * two applications computed from the same level are a unique violation in the
 * database, whatever the application layer believed.
 */

/** Everything a credit application binds, read in ONE statement. */
interface ApplyCreditState {
  base_currency: string;
  base_exponent: number;
  future: boolean;
  invoices: SettledInvoiceRow[];
  credit: CustomerCreditRow | null;
}

/**
 * `customer_apply_credit` — the ASSUMED signature of the routine `0081`
 * exposes (map §8.8; Agent E owns the migration).
 *
 * 15 parameters, the exact mirror of `supplier_allocate_credit`'s 16
 * (`supplier-credit-allocation.service.ts`) with the purchase's
 * `warehouse_id` dropped — an invoice names a branch, which the routine reads
 * from the invoice row itself.
 *
 * NEITHER RATE IS AN ARGUMENT, exactly as the supplier routine takes neither:
 * a stored snapshot is the routine's to read under its own lock, and passing
 * it would make it a figure the caller could state. If `0081` lands with a
 * different order or arity, this constant and `customerApplyCreditPayload`'s
 * field order are the two places that change, and they must stay identical.
 */
const CUSTOMER_APPLY_CREDIT_SQL = `SELECT application_id, replayed FROM customer_apply_credit(
   $1::uuid, $2::uuid, $3::uuid, $4::date, $5::char(3), $6::bigint, $7::bigint, $8::bigint, $9::bigint,
   $10::char(3), $11::bigint, $12::bigint, $13::bigint, $14::bigint, $15::bigint)`;

/** A credit row as the arithmetic reads it: its stored pairs and its own snapshot `Rn`, never a new lookup. */
export function customerCreditState(k: CustomerCreditRow, baseExponent: number): CustomerCreditState {
  return {
    originalMinor: parseMinor(k.original_amount_minor),
    originalCarryingMinor: parseMinor(k.original_carrying_base_amount_minor),
    remainingMinor: parseMinor(k.remaining_amount_minor),
    conversion: { rateR10: parseUnitCost(k.rate), txnExponent: k.currency_exponent, baseExponent },
  };
}

/** A credit's stored snapshot as the posting's. */
export function creditSnapshot(k: CustomerCreditRow): ReceivableSnapshot {
  return { currency: k.currency_code, rate: k.rate, source: k.rate_source, at: new Date(k.rate_timestamp) };
}

/**
 * The credit's remaining checks, in the routine's order: nothing remaining
 * first, then more consumed than remains. `planCustomerCreditApplication`
 * judges the same again; checking here keeps the refusal order the routine's
 * when a later check (the dates) would also fail.
 */
export function creditRemainingRefusal(k: CustomerCreditRow, consumedMinor: bigint): void {
  const remaining = parseMinor(k.remaining_amount_minor);
  if (remaining === 0n) throw receivablesRefusal('customer_credit_application.credit_exhausted');
  if (consumedMinor > remaining) throw receivablesRefusal('customer_credit_application.amount_exceeds_credit');
}

@Injectable()
export class CustomerCreditApplicationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
  ) {}

  async apply(
    m: MembershipContext,
    creditId: string,
    input: CustomerCreditApplicationRequest,
    btx: BusinessTransactionId,
  ): Promise<CustomerCreditApplicationResultDto> {
    try {
      return await this.run(m, creditId, input, btx);
    } catch (e) {
      return rethrowReceivablesRefusal(e);
    }
  }

  private async run(
    m: MembershipContext,
    creditId: string,
    input: CustomerCreditApplicationRequest,
    btx: BusinessTransactionId,
  ): Promise<CustomerCreditApplicationResultDto> {
    const consumedMinor = parseMinor(input.creditAmountConsumedMinor);
    const appliedMinor = parseMinor(input.invoiceAmountAppliedMinor);

    // 1. The client intent, then the idempotency proof — before any state read.
    const intentSha256 = customerApplyCreditIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      applicationId: input.applicationId,
      creditId,
      invoiceId: input.invoiceId,
      applicationDate: input.applicationDate,
      consumedMinor,
      appliedMinor,
    });
    const stored = await findCustomerCreditApplicationIntent(this.db, m, input.applicationId);
    // 2. Authority: `payments.collect`. It reads membership only.
    const authority = await this.authorization.authorize(m, receivablesOperationCode(CUSTOMER_APPLY_CREDIT_OP), btx);
    if (stored !== null) {
      if (stored !== intentSha256) throw receivablesRefusal('customer_credit_application.idempotency_conflict');
      return readCustomerCreditApplicationResult(this.db, m, input.applicationId, true);
    }

    // 3. Current state, and the routine's refusals in its order.
    const state = await this.readState(m, creditId, input);
    const [invoiceRow] = state.invoices;
    if (invoiceRow === undefined) throw receivablesRefusal('customer_credit_application.not_found');
    const invoice = settledInvoice(invoiceRow, 'customer_credit_application');
    const credit = state.credit;
    if (credit === null) throw receivablesRefusal('customer_credit.not_found');
    // THREE identities must be one: the credit's customer, the invoice's, and
    // the one the caller stated. The first two make the row representable; the
    // third is what tells a client that meant someone else, instead of
    // silently settling the invoice it named.
    if (credit.customer_id !== invoice.customerId) throw receivablesRefusal('customer_credit_application.customer_mismatch');
    if (input.customerId !== invoice.customerId) throw receivablesRefusal('customer_credit_application.customer_mismatch');
    creditRemainingRefusal(credit, consumedMinor);
    const source = invoice.issueDate > credit.credit_date ? invoice.issueDate : credit.credit_date;
    if (input.applicationDate < source) throw receivablesRefusal('customer_credit_application.date_before_source');
    if (state.future) throw receivablesRefusal('customer_credit_application.date_in_future');

    // 4. Every stored amount, bound.
    const plan = planCustomerCreditApplication({
      invoice: invoiceArState(invoice, state.base_exponent, parseUnitCost(invoice.rate)),
      credit: customerCreditState(credit, state.base_exponent),
      sameCurrency: credit.currency_code === invoice.currency,
      consumedMinor,
      appliedMinor,
    });
    const built = customerApplyCreditPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      applicationId: input.applicationId,
      creditId,
      invoiceId: input.invoiceId,
      applicationDate: input.applicationDate,
      consumedMinor: plan.creditAmountConsumedMinor,
      appliedMinor: plan.invoiceAmountAppliedMinor,
      creditCurrency: credit.currency_code,
      creditRemainingBeforeMinor: plan.creditRemainingBeforeMinor,
      creditCarryingReleasedMinor: plan.creditCarryingReleasedMinor,
      creditDustBaseMinor: plan.creditDustBaseMinor,
      invoiceCurrency: invoice.currency,
      arReleasedBeforeMinor: plan.arReleasedBeforeMinor,
      carryingReleasedMinor: plan.invoiceCarryingReleasedMinor,
      arDustBaseMinor: plan.arDustBaseMinor,
      realizedFxMinor: plan.realizedFxMinor,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound credit-application payload does not carry the proven intent');
    const command = receivablePostingCommand({
      tenantId: m.tenantId,
      businessId: m.businessId,
      sourceType: CUSTOMER_CREDIT_APPLICATION_SOURCE,
      sourceId: input.applicationId,
      entryDate: input.applicationDate,
      baseCurrency: state.base_currency,
      snapshots: { invoice: invoiceSnapshot(invoice), credit: creditSnapshot(credit) },
      postingAccountCode: null,
      branchId: invoice.branchId,
      lines: plan.entryLines,
      businessTransactionId: btx,
    });

    // 5. Mint both assertions before the seam opens.
    const inventoryAssertion = this.authorization.mint(authority, built.payload);
    const accountingAssertion = mintDomainPostingAssertion(this.accountingMinter, command, m.userId);

    // 6. One transaction: the routine, the entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, [accountingAssertion], async (tx) => {
      const r = await tx.query<{ replayed: boolean }>(CUSTOMER_APPLY_CREDIT_SQL, [
        input.applicationId,
        creditId,
        input.invoiceId,
        input.applicationDate,
        credit.currency_code,
        plan.creditAmountConsumedMinor.toString(10),
        plan.creditRemainingBeforeMinor.toString(10),
        plan.creditCarryingReleasedMinor.toString(10),
        plan.creditDustBaseMinor.toString(10),
        invoice.currency,
        plan.invoiceAmountAppliedMinor.toString(10),
        plan.arReleasedBeforeMinor.toString(10),
        plan.invoiceCarryingReleasedMinor.toString(10),
        plan.arDustBaseMinor.toString(10),
        plan.realizedFxMinor.toString(10),
      ]);
      const [first] = r.rows;
      if (first === undefined) throw new Error('customer_apply_credit returned no row');
      if (first.replayed) return true;
      await this.posting.postEntryInTransaction(tx.accounting, { command });
      return false;
    });
    return readCustomerCreditApplicationResult(this.db, m, input.applicationId, replayed);
  }

  /** The application's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReceivablesReadScope, creditId: string, input: CustomerCreditApplicationRequest): Promise<ApplyCreditState> {
    const [row] = await scopedReceivablesRows<ApplyCreditState>(
      this.db,
      scope,
      `SELECT b.base_currency::text AS base_currency, bc.minor_units AS base_exponent,
              ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              ${SETTLED_INVOICES_SQL.replace('%IDS%', 'ARRAY[$3::uuid]')} AS invoices,
              ${CUSTOMER_CREDIT_SQL.replace('%CREDIT%', '$4')} AS credit
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
        WHERE b.id = $1`,
      [scope.businessId, input.applicationDate, input.invoiceId, creditId],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }
}
