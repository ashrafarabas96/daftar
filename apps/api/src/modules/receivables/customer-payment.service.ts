import { Inject, Injectable } from '@nestjs/common';
import { AccountingError, mintDomainPostingAssertion, parseDatabaseAccountingError, type PostingCommand } from '@daftar/accounting';
import { normalizeDocumentText, parseMinor, parseUnitCost } from '@daftar/inventory';
import { Database, type AccountingAssertions, type BusinessInventoryAccountingTransaction } from '../../infra/database';
import { AccountingAssertionMinterService } from '../accounting/accounting-assertion.minter';
import { AuditService } from '../audit/audit.service';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { planCustomerPayment, type CustomerPaymentAllocationPlan, type InvoiceArState } from './customer-settlement';
import { auditThenRethrowReceivablesRefusal, receivablesRefusal, type ReceivablesAttempt } from './receivables-errors';
import {
  CUSTOMER_COLLECT_PAYMENT_OP,
  customerCollectPaymentIntentSha256,
  customerCollectPaymentPayload,
  RECEIVABLES_REFERENCE_MAX,
  receivablesOperationCode,
  type CollectPaymentIntentAllocation,
} from './receivables-payload';
import {
  findCustomerPaymentIntent,
  RECEIVABLES_METHOD_SQL,
  readCustomerPayment,
  scopedReceivablesRows,
  SETTLED_INVOICES_SQL,
  type ReceivablesMethodRow,
  type ReceivablesReadScope,
  type SettledInvoiceRow,
} from './receivables-reads';
import {
  CUSTOMER_CREDIT_SOURCE,
  CUSTOMER_PAYMENT_ALLOCATION_SOURCE,
  receivablePostingCommand,
  type ReceivableSnapshot,
} from './receivables-settlement-posting';
import type { CustomerPaymentResultDto } from './receivables-contracts';
import type { CustomerPaymentRequest } from './receivables.schemas';

/**
 * `POST /v1/customer-payments` — COLLECT A CUSTOMER PAYMENT (P4-S4).
 *
 * ## The command shape: the SUPPLIER shape (OQ-3, ruled)
 *
 * The estate carries two accepted command mechanisms and this slice uses the
 * supplier one: **the caller computes every figure in TypeScript and the
 * database routine RECOMPUTES EACH ONE and refuses on disagreement.** That is
 * `supplier_pay`'s shape (`0068:760-764`), not `sale_commit`'s
 * recompute-everything-from-the-catalogue shape — the two are different, both
 * shipped, and a reviewer expecting the other will think this is wrong.
 *
 * It is the closer analogue because it is the SAME ARITHMETIC (the four
 * primitives of `customer-settlement.ts`), the same entry shape and the same
 * chain verifier. The figures the service computes are not trusted: they are
 * ASSERTIONS the routine must agree with, and a disagreement is
 * `customer_payment.settlement_changed` — never a silently-adjusted amount.
 *
 * ## The application order
 *
 * 1. **the replay proof, FIRST** — the stored `payments.intent_sha256` for
 *    this caller-supplied `paymentId` against the digest of THIS request,
 *    before the customer, the method, the invoices, the rate or an outstanding
 *    is read (`[[daftar-registry-before-state]]`). Same digest ⇒ the stored
 *    rows, having changed nothing. Different digest ⇒
 *    `customer_payment.idempotency_conflict`: an idempotency key is not
 *    permission, and a replay must prove WHICH command it is replaying before
 *    it answers "success". The INTENT IS REQUEST-ONLY, so a moved rate is not
 *    a false conflict;
 * 2. **authority** — `payments.collect`, through
 *    `InventoryAuthorizationService`, which is also the only issuer of the
 *    proof that lets anything be minted. Applying a credit uses the same key
 *    (OQ-5);
 * 3. **current state in ONE statement** — every allocated invoice with its `O`
 *    from `invoice_outstanding`, its stored snapshot and its branch; the
 *    customer; the method and its account's chart code; the base currency and
 *    "today" in the business's timezone. One snapshot, so two invoices cannot
 *    be read a second apart;
 * 4. **the routine's refusals in ITS order**, then every stored amount BOUND
 *    by the plan — the AR release, the dust, the payment base, the realized FX
 *    and the surplus credit's pair;
 * 5. **everything minted before the seam opens** — one `invctl/1` assertion
 *    over the `customer.collect_payment` payload, and ONE accounting assertion
 *    per entry;
 * 6. **ONE transaction** — the routine, then (unless it answered a replay) the
 *    entries in `line_no` order with the surplus-credit entry last, then
 *    COMMIT with every deferred guard: both binding FKs (`0042:287-298`), the
 *    completeness validators, `invoices_walkin_no_ar` and the chain verifier.
 *    Either all of them pass or the whole transaction rolls back. ATOMICITY IS
 *    THE ESTATE'S EXISTING MACHINERY, not a new rule this service adds.
 *
 * ## What this command does NOT do
 *
 * No arithmetic in the controller and no arithmetic on a float: every figure
 * is `bigint` minor units with ONE half-even at the end, and a rounded
 * quotient is never an input to the next step (P4-AL-25). No second journal
 * writer and no second posting path: every entry goes through
 * `receivablePostingCommand` into the one posting adapter. No stored
 * `paid`/`outstanding` column is written or read — `invoice_outstanding` is
 * the reader of record, and `0080` already excludes a cash-settled invoice
 * from it, so a cash sale to a named customer cannot be collected a second
 * time.
 */

/** The state of one invoice an allocation settles, as the service binds it. */
export interface SettledInvoice {
  readonly invoiceId: string;
  readonly customerId: string;
  /** The dimension of every line of its entry. */
  readonly branchId: string;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly issueDate: string;
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  readonly outstandingTxnMinor: bigint;
  /** `NUMERIC(20,10)` text of the stored `source_to_base_rate` (`R`). */
  readonly rate: string;
  readonly rateSource: 'base' | 'manual' | 'provider';
  readonly rateAt: Date;
}

/** The method a payment names, as read: its account by id AND by chart code. */
export interface ReceivablesMethod {
  readonly paymentMethodId: string;
  readonly requiresReference: boolean;
  readonly postingAccountId: string;
  readonly postingAccountCode: string;
}

/**
 * An invoice's row as the binder's state.
 *
 * A walk-in invoice (`customer_id IS NULL`) is refused HERE, and it is the
 * FIRST of three answers rather than a convenience in front of a constraint.
 *
 * It is now ALSO refused by the edge to `invoices`, and this comment twice
 * said otherwise. `0075` is indeed frozen with no such constraint
 * (`0075:286-288`), which is why `0081` could only carry the two-column
 * `FOREIGN KEY (business_id, invoice_id)` (`0081:357`, `0081:493`). `0082`
 * then added the key to `invoices` in a new migration — `invoices_customer_uq
 * UNIQUE (business_id, id, customer_id)`, non-partial, so it validates on data
 * already holding NULL customers — and widened both reducer edges onto it
 * (`0082:187-203`) under the same constraint names. `customer_id` is `NOT NULL`
 * on both reducers, so all three referencing columns are non-null, the edge is
 * checked on every row, and a customer-mismatched or walk-in target has no
 * parent tuple: the INSERT is refused with `23503`.
 *
 * So this API answer is still the FIRST of three, and that is its whole value —
 * a merchant reads a sentence instead of a constraint name. What changed is
 * what stands behind it: `invoice_settlement_verify`'s identity and walk-in
 * arms at COMMIT, and `invoices_walkin_no_ar` (`0075:661-684`), are now
 * defence in depth behind a shape rather than the only things proving the law.
 */
export function settledInvoice(row: SettledInvoiceRow, domain: 'customer_payment' | 'customer_credit_application'): SettledInvoice {
  if (row.status !== 'open') throw receivablesRefusal(`${domain}.invoice_state_invalid`);
  if (row.customer_id === null) throw receivablesRefusal(`${domain}.invoice_walkin`);
  return {
    invoiceId: row.id,
    customerId: row.customer_id,
    branchId: row.branch_id,
    currency: row.currency_code,
    currencyExponent: row.currency_exponent,
    issueDate: row.issue_date,
    totalTxnMinor: parseMinor(row.total_txn_minor),
    totalBaseMinor: parseMinor(row.total_base_minor),
    outstandingTxnMinor: parseMinor(row.outstanding),
    rate: row.rate,
    rateSource: row.rate_source,
    rateAt: new Date(row.rate_timestamp),
  };
}

/** An invoice's stored snapshot as a posting snapshot. */
export function invoiceSnapshot(i: SettledInvoice): ReceivableSnapshot {
  return { currency: i.currency, rate: i.rate, source: i.rateSource, at: i.rateAt };
}

/** An invoice as the AR arithmetic reads it. */
export function invoiceArState(i: SettledInvoice, baseExponent: number, rateR10: bigint): InvoiceArState {
  return {
    totalTxnMinor: i.totalTxnMinor,
    totalBaseMinor: i.totalBaseMinor,
    outstandingTxnMinor: i.outstandingTxnMinor,
    conversion: { rateR10, txnExponent: i.currencyExponent, baseExponent },
  };
}

/**
 * The method checks the service can see: missing, inactive, the reference
 * rule. ELIGIBILITY OF THE ACCOUNT IS THE DATABASE'S, in one place
 * (`accounting_settlement_account_eligibility`, `0067:1918-1946`), and the
 * routine judges it under its own `FOR SHARE` on the method row. This service
 * does not re-derive it and must not.
 */
export function receivablesMethod(row: ReceivablesMethodRow | null, reference: string | null): ReceivablesMethod {
  if (row === null || !row.is_active) throw receivablesRefusal('customer_payment.not_found');
  if (row.requires_reference && reference === null) throw receivablesRefusal('customer_payment.reference_required');
  return {
    paymentMethodId: row.id,
    requiresReference: row.requires_reference,
    postingAccountId: row.posting_account_id,
    postingAccountCode: row.account_code,
  };
}

/** A reference: trimmed, NULL when empty, refused when longer than its bound. */
export function receivablesReference(raw: string | null | undefined): string | null {
  const reference = normalizeDocumentText(raw);
  if (reference !== null && [...reference].length > RECEIVABLES_REFERENCE_MAX) throw receivablesRefusal('customer_payment.allocations_invalid');
  return reference;
}

/** Everything a payment binds, read in ONE statement. */
interface CollectPaymentState {
  base_currency: string;
  base_exponent: number;
  future: boolean;
  currency_exponent: number | null;
  customer_status: string | null;
  method: ReceivablesMethodRow | null;
  invoices: SettledInvoiceRow[];
}

/**
 * `customer_collect_payment` — the ASSUMED signature of the routine `0081`
 * exposes (map §8.8; Agent E owns the migration).
 *
 * 26 parameters: 16 header scalars and 10 per-allocation arrays. It is
 * `supplier_pay`'s 24 (`SUPPLIER_PAY_SQL`,
 * `supplier-payment.service.ts:97-100`) with the supplier replaced by the
 * customer, the per-allocation `warehouse_ids` array dropped (an invoice names
 * a branch, not a warehouse; the routine reads it from the invoice itself) and
 * THREE header scalars added for the surplus credit — `credit_id`,
 * `credit_amount_minor`, `credit_carrying_base_minor`, all NULL together when
 * the payment is fully allocated.
 *
 * It returns one row per allocation plus, when there is a surplus, the credit
 * id on every row — so a payment with zero allocations still returns exactly
 * one row and the service can tell a replay from a write. `line_no` is the
 * ordinal the routine assigned, which is the order the entries are posted in.
 *
 * **If `0081` lands with a different order or arity, THIS CONSTANT and
 * `receivables-payload.ts`' field order are the two places that change** —
 * they must stay byte-identical to each other, because the assertion the
 * routine consumes was signed over exactly these arguments.
 */
export const CUSTOMER_COLLECT_PAYMENT_SQL = `SELECT payment_id, allocation_id, line_no, invoice_id, credit_id, replayed FROM customer_collect_payment(
   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::char(3), $7::bigint, $8::uuid, $9::numeric, $10::text, $11::timestamptz,
   $12::bigint, $13::text, $14::uuid, $15::bigint, $16::bigint,
   $17::uuid[], $18::uuid[], $19::char(3)[], $20::bigint[], $21::bigint[], $22::bigint[], $23::bigint[], $24::bigint[], $25::bigint[], $26::bigint[])`;

/** One allocation of a payment to bind: the client's two amounts and the invoice they settle. */
export interface PaymentAllocationToBind {
  readonly allocationId: string;
  readonly invoice: SettledInvoice;
  readonly paymentAmountMinor: bigint;
  readonly appliedMinor: bigint;
}

/**
 * The FX snapshot a payment binds at its date. It is declared here, beside the
 * command that binds it, because the lookup that produces it is command-side
 * (see `CustomerPaymentService.readFx`).
 */
export interface ReceivablesFx {
  readonly rateId: string | null;
  /** `NUMERIC(20,10)` text. */
  readonly rate: string;
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual';
  /** Second precision: `<date>T00:00:00Z` when domestic, the registry row's `effective_at` otherwise. */
  readonly at: Date;
}

const DOMESTIC_RATE_TEXT = '1.0000000000';
const DOMESTIC_RATE_R10 = 10_000_000_000n;

export interface PaymentToBind {
  readonly tenantId: string;
  readonly businessId: string;
  readonly businessTransactionId: string;
  readonly paymentId: string;
  readonly customerId: string;
  readonly method: ReceivablesMethod;
  readonly paymentDate: string;
  /** The payment currency `P`, ISO upper case. */
  readonly currency: string;
  readonly currencyExponent: number;
  readonly baseCurrency: string;
  readonly baseExponent: number;
  readonly amountMinor: bigint;
  /** Already `normalizeDocumentText`-ed. */
  readonly reference: string | null;
  /** Client-supplied, and NULL exactly when the payment is fully allocated. */
  readonly creditId: string | null;
  readonly fx: ReceivablesFx;
  /** In `line_no` order; possibly EMPTY (OQ-4). */
  readonly allocations: readonly PaymentAllocationToBind[];
}

/** A payment with every value the database will store computed and bound, before anything is minted. */
export interface BoundCustomerPayment {
  readonly intentSha256: string;
  readonly payloadSha256: string;
  readonly payload: { readonly opCode: string; readonly sha256: string };
  /** One entry per allocation in `line_no` order, then the surplus-credit entry when there is one. */
  readonly commands: readonly PostingCommand[];
  /** The routine's arguments, in `CUSTOMER_COLLECT_PAYMENT_SQL`'s order. */
  readonly params: readonly unknown[];
  readonly inventoryPayload: Parameters<InventoryAuthorizationService['mint']>[1];
}

/**
 * Bind a customer payment: each allocation's AR release, dust, payment base
 * and realized FX through the plan — the exact half-even arithmetic of the
 * four accepted primitives — the header base `Σ pb + OB_credit` (never
 * `conv(Σ p)`), the surplus credit's `(OA, OB)`, the
 * `customer.collect_payment` payload and one posting command per entry.
 */
export function bindCustomerPayment(i: PaymentToBind): BoundCustomerPayment {
  const payment = { rateR10: i.fx.rateR10, txnExponent: i.currencyExponent, baseExponent: i.baseExponent };

  // ONE call into the plan layer. The AR release, both dusts, each leg's base,
  // the realized FX, the surplus credit's `(OA, OB)`, the header base and both
  // closure laws are the planner's — this service recomputes none of them.
  const plan = planCustomerPayment({
    amountMinor: i.amountMinor,
    payment,
    legs: i.allocations.map((a) => ({
      invoice: invoiceArState(a.invoice, i.baseExponent, parseUnitCostR10(a.invoice.rate)),
      sameCurrency: a.invoice.currency === i.currency,
      paymentAmountMinor: a.paymentAmountMinor,
      appliedMinor: a.appliedMinor,
    })),
  });
  const planned = i.allocations.map((a, index) => {
    const leg = plan.allocations[index];
    if (leg === undefined) throw new Error('an allocation lost its plan');
    return { a, plan: leg };
  });
  const credit = plan.credit;
  const baseAmountMinor = plan.baseAmountMinor;
  // The credit id is the CALLER'S (coordinator ruling): a server-minted id
  // would make two identical requests two different commands, which is the
  // opposite of idempotent. So the request's `creditId` and the plan's surplus
  // must agree, and a disagreement is refused before anything is signed.
  if ((credit === null) !== (i.creditId === null)) throw receivablesRefusal('customer_payment.allocations_invalid');

  const rateAtEpochSeconds = BigInt(i.fx.at.getTime() / 1000);
  const built = customerCollectPaymentPayload({
    tenantId: i.tenantId,
    businessId: i.businessId,
    paymentId: i.paymentId,
    customerId: i.customerId,
    paymentMethodId: i.method.paymentMethodId,
    postingAccountId: i.method.postingAccountId,
    paymentDate: i.paymentDate,
    // ONE currency field, the RESOLVED code, on both sides of the digest: it
    // is what `0081` signs into the intent (`:1859`) and into the payload
    // (`:1820`), by the same `lower(p_currency_code::text)` expression.
    currency: i.currency,
    amountMinor: i.amountMinor,
    reference: i.reference,
    rate: { rateId: i.fx.rateId, rateR10: i.fx.rateR10, source: i.fx.source, rateAtEpochSeconds },
    baseAmountMinor,
    creditId: i.creditId,
    credit: credit === null ? null : { originalAmountMinor: credit.originalAmountMinor, originalCarryingBaseMinor: credit.originalCarryingBaseMinor },
    allocations: planned.map(({ a, plan }) => ({
      allocationId: a.allocationId,
      invoiceId: a.invoice.invoiceId,
      invoiceCurrency: a.invoice.currency,
      paymentAmountMinor: plan.paymentAmountMinor,
      paymentBaseMinor: plan.paymentBaseMinor,
      appliedMinor: plan.invoiceAmountAppliedMinor,
      arReleasedBeforeMinor: plan.arReleasedBeforeMinor,
      carryingReleasedMinor: plan.invoiceCarryingReleasedMinor,
      arDustBaseMinor: plan.arDustBaseMinor,
      realizedFxMinor: plan.realizedFxMinor,
    })),
  });

  const paymentSnapshot: ReceivableSnapshot = { currency: i.currency, rate: i.fx.rate, source: i.fx.source, at: i.fx.at };
  const commands: PostingCommand[] = planned.map(({ a, plan }) =>
    receivablePostingCommand({
      tenantId: i.tenantId,
      businessId: i.businessId,
      sourceType: CUSTOMER_PAYMENT_ALLOCATION_SOURCE,
      sourceId: a.allocationId,
      entryDate: i.paymentDate,
      baseCurrency: i.baseCurrency,
      snapshots: { invoice: invoiceSnapshot(a.invoice), payment: paymentSnapshot },
      postingAccountCode: i.method.postingAccountCode,
      branchId: a.invoice.branchId,
      lines: plan.entryLines,
      businessTransactionId: i.businessTransactionId,
    }),
  );
  if (credit !== null && i.creditId !== null) {
    // The surplus leg: Dr posting account / Cr customer_credit_liability, both
    // at the payment's own snapshot. No revenue account appears in it, which
    // is what G-15 asserts — a surplus is a liability to the customer, never
    // income. It carries no branch: it settles no invoice, so there is no
    // invoice branch to carry, and inventing one would make the dimension a
    // guess.
    commands.push(
      receivablePostingCommand({
        tenantId: i.tenantId,
        businessId: i.businessId,
        sourceType: CUSTOMER_CREDIT_SOURCE,
        sourceId: i.creditId,
        entryDate: i.paymentDate,
        baseCurrency: i.baseCurrency,
        snapshots: { payment: paymentSnapshot },
        postingAccountCode: i.method.postingAccountCode,
        branchId: null,
        lines: credit.entryLines,
        businessTransactionId: i.businessTransactionId,
      }),
    );
  }

  const col = <T>(f: (x: { readonly a: PaymentAllocationToBind; readonly plan: CustomerPaymentAllocationPlan }) => T): T[] => planned.map(f);
  const params: unknown[] = [
    i.paymentId,
    i.customerId,
    i.method.paymentMethodId,
    i.method.postingAccountId,
    i.paymentDate,
    i.currency,
    i.amountMinor.toString(10),
    i.fx.rateId,
    i.fx.rate,
    i.fx.source,
    `${i.fx.at.toISOString().slice(0, 19)}Z`,
    baseAmountMinor.toString(10),
    i.reference,
    i.creditId,
    credit === null ? null : credit.originalAmountMinor.toString(10),
    credit === null ? null : credit.originalCarryingBaseMinor.toString(10),
    col(({ a }) => a.allocationId),
    col(({ a }) => a.invoice.invoiceId),
    col(({ a }) => a.invoice.currency),
    col(({ plan }) => plan.paymentAmountMinor.toString(10)),
    col(({ plan }) => plan.paymentBaseMinor.toString(10)),
    col(({ plan }) => plan.invoiceAmountAppliedMinor.toString(10)),
    col(({ plan }) => plan.arReleasedBeforeMinor.toString(10)),
    col(({ plan }) => plan.invoiceCarryingReleasedMinor.toString(10)),
    col(({ plan }) => plan.arDustBaseMinor.toString(10)),
    col(({ plan }) => plan.realizedFxMinor.toString(10)),
  ];
  return {
    intentSha256: built.intentSha256,
    payloadSha256: built.payload.sha256,
    payload: built.payload,
    commands,
    params,
    inventoryPayload: built.payload,
  };
}

/** A stored `NUMERIC(20,10)` rate as its R10, without ever becoming a float. */
function parseUnitCostR10(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  if (!/^\d+$/.test(whole) || (fraction !== '' && !/^\d+$/.test(fraction)) || fraction.length > 10) {
    throw receivablesRefusal('customer_payment.arithmetic_invalid', { reason: 'a stored rate is not NUMERIC(20,10)' });
  }
  return BigInt(`${whole}${fraction.padEnd(10, '0')}`);
}

/**
 * Run `customer_collect_payment` on an open seam-2 transaction and, unless the
 * routine answered a replay, post its entries in order — each through the
 * posting adapter, which presents that entry's own assertion.
 */
export async function executeCollectPayment(
  tx: BusinessInventoryAccountingTransaction,
  posting: DatabaseAccountingPostingAdapter,
  bound: BoundCustomerPayment,
): Promise<boolean> {
  const r = await tx.query<{ replayed: boolean }>(CUSTOMER_COLLECT_PAYMENT_SQL, [...bound.params]);
  const [first] = r.rows;
  if (first === undefined) throw new Error('customer_collect_payment returned no row');
  // A replay inside the routine (a concurrent identical payment won the key)
  // commits no entry; its minted accounting assertions expire unused.
  if (first.replayed) return true;
  for (const command of bound.commands) await posting.postEntryInTransaction(tx.accounting, { command });
  return false;
}

@Injectable()
export class CustomerPaymentService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    @Inject(AccountingAssertionMinterService) private readonly accountingMinter: AccountingAssertionMinterService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * P4-AL-48: a refusal is audited as heavily as a success. The attempt record
   * is created BEFORE `run` so that a refusal raised on its very first line
   * still has a document id, an operation and the request's own figures to
   * audit; `run` fills in the intent digest and the branch as it learns them.
   *
   * The figures are the ones the REQUEST carried, because those are the ones
   * «that caused it» for a forged total or an over-cap attempt — the two cases
   * P4-AL-48 names as the ones worth seeing.
   */
  async collect(m: MembershipContext, input: CustomerPaymentRequest, btx: BusinessTransactionId): Promise<CustomerPaymentResultDto> {
    const attempt: ReceivablesAttempt = {
      operation: CUSTOMER_COLLECT_PAYMENT_OP,
      entity: 'payment',
      entityId: input.paymentId,
      tillSessionId: null,
      figures: {
        customerId: input.customerId,
        paymentMethodId: input.paymentMethodId,
        paymentDate: input.paymentDate,
        currencyCode: input.currencyCode ?? null,
        amountMinor: input.amountMinor,
        creditId: input.creditId ?? null,
        allocationCount: String(input.allocations.length),
        allocations: JSON.stringify(
          input.allocations.map((a) => ({
            allocationId: a.allocationId,
            invoiceId: a.invoiceId,
            paymentAmountMinor: a.paymentAmountMinor,
            invoiceAmountAppliedMinor: a.invoiceAmountAppliedMinor,
          })),
        ),
      },
    };
    try {
      return await this.run(m, input, btx, attempt);
    } catch (e) {
      return await auditThenRethrowReceivablesRefusal(this.audit, m, attempt, e);
    }
  }

  private async run(
    m: MembershipContext,
    input: CustomerPaymentRequest,
    btx: BusinessTransactionId,
    attempt: ReceivablesAttempt,
  ): Promise<CustomerPaymentResultDto> {
    // 1. The request, then the state snapshot, then the intent — IN THAT ORDER.
    //
    //    The state read used to come AFTER the digest, and the comment here used
    //    to say the intent "cannot depend on the base currency the state read
    //    would resolve". That ordering was self-imposed and it was WRONG: the
    //    routine signs `lower(p_currency_code::text)` into its own intent
    //    (`0081:1859`) over an argument it refuses as NULL, so an intent built
    //    from the client's nullable code can never equal the one
    //    `payments.intent_sha256` stores, and every replay of a stored payment
    //    came back a false `customer_payment.idempotency_conflict`.
    //
    //    Reading state first is not a breach of `[[daftar-registry-before-state]]`.
    //    What that rule keeps out of an intent is a DERIVED figure that moves
    //    between two retries — a rate, a base, a release, a dust, a realized
    //    amount, a posting account — and none of those enters the digest. The
    //    one thing the read contributes to it is `base_currency`, an immutable
    //    business attribute, so the same request still digests identically for
    //    ever (the argument `receivables.schemas.ts`' header makes).
    const reference = receivablesReference(input.reference);
    const amountMinor = parseMinor(input.amountMinor);
    const creditId = input.creditId ?? null;
    const intentAllocations: CollectPaymentIntentAllocation[] = input.allocations.map((a) => ({
      allocationId: a.allocationId,
      invoiceId: a.invoiceId,
      paymentAmountMinor: parseMinor(a.paymentAmountMinor),
      appliedMinor: parseMinor(a.invoiceAmountAppliedMinor),
    }));
    const state = await this.readState(m, input);
    // A NULL `currencyCode` means "the business's base currency", resolved
    // HERE, once, from the snapshot everything else comes out of — and this is
    // the code the intent, the payload and every stored line all carry.
    const currency = input.currencyCode ?? state.base_currency;
    const intentSha256 = customerCollectPaymentIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      paymentId: input.paymentId,
      customerId: input.customerId,
      paymentMethodId: input.paymentMethodId,
      paymentDate: input.paymentDate,
      currency,
      amountMinor,
      reference,
      creditId,
      allocations: intentAllocations,
    });
    // The digest exists now, so a refusal from here on can carry it.
    attempt.intentSha256 = intentSha256;
    attempt.figures['resolvedCurrency'] = currency;
    // The replay lookup stays AFTER the digest and before any write: only the
    // state read moved ahead of it.
    const stored = await findCustomerPaymentIntent(this.db, m, input.paymentId);

    // 2. Authority. `payments.collect`, re-established through the one issuer
    //    of a minting proof — the route decorator gates the REQUEST, this
    //    gates the CALL.
    const authority: InventoryCommandAuthority = await this.authorization.authorize(m, receivablesOperationCode(CUSTOMER_COLLECT_PAYMENT_OP), btx);
    if (stored !== null) {
      if (stored !== intentSha256) throw receivablesRefusal('customer_payment.idempotency_conflict');
      return { ...(await readCustomerPayment(this.db, m, input.paymentId)), replayed: true };
    }

    // 3. The snapshot read at step 1, now read for everything else it carries.
    const byId = new Map(state.invoices.map((i) => [i.id, i]));
    const rows = intentAllocations.map((a) => {
      const row = byId.get(a.invoiceId);
      if (row === undefined) throw receivablesRefusal('customer_payment.not_found');
      return row;
    });

    // 4. The routine's refusals, in its order.
    const invoices = rows.map((row) => settledInvoice(row, 'customer_payment'));
    // The branch dimension is the first allocated invoice's. A payment with
    // zero allocations settles no invoice and therefore has no branch, and
    // NULL there is the truth rather than a gap (the same reason the surplus
    // credit's entry carries no branch).
    attempt.branchId = invoices[0]?.branchId ?? null;
    attempt.figures['outstandingAtRead'] = JSON.stringify(invoices.map((i) => [i.invoiceId, i.outstandingTxnMinor.toString(10)]));
    for (const invoice of invoices) {
      if (invoice.customerId !== input.customerId) throw receivablesRefusal('customer_payment.customer_mismatch');
      if (input.paymentDate < invoice.issueDate) throw receivablesRefusal('customer_payment.date_before_invoice');
    }
    if (state.customer_status === null) throw receivablesRefusal('customer_payment.not_found');
    if (state.customer_status !== 'active') throw receivablesRefusal('customer_payment.customer_inactive');
    const method = receivablesMethod(state.method, reference);
    if (state.future) throw receivablesRefusal('customer_payment.date_in_future');
    if (state.currency_exponent === null) throw receivablesRefusal('customer_payment.allocations_invalid');
    const fx = await this.readFx(m, currency, state.base_currency, input.paymentDate);

    const bound = bindCustomerPayment({
      tenantId: m.tenantId,
      businessId: m.businessId,
      businessTransactionId: btx,
      paymentId: input.paymentId,
      customerId: input.customerId,
      method,
      paymentDate: input.paymentDate,
      currency,
      currencyExponent: state.currency_exponent,
      baseCurrency: state.base_currency,
      baseExponent: state.base_exponent,
      amountMinor,
      reference,
      creditId,
      fx,
      allocations: intentAllocations.map((a, index) => {
        const invoice = invoices[index];
        if (invoice === undefined) throw new Error('an allocation lost its invoice');
        return { allocationId: a.allocationId, invoice, paymentAmountMinor: a.paymentAmountMinor, appliedMinor: a.appliedMinor };
      }),
    });
    if (bound.intentSha256 !== intentSha256) throw new Error('the bound payment payload does not carry the proven intent');

    // 5. Mint everything before the seam opens: one inventory assertion, one accounting assertion per entry.
    const inventoryAssertion = this.authorization.mint(authority, bound.inventoryPayload);
    const [firstCommand, ...rest] = bound.commands.map((c) => mintDomainPostingAssertion(this.accountingMinter, c, m.userId));
    if (firstCommand === undefined) throw new Error('a collected payment posts at least one entry');
    const accountingAssertions: AccountingAssertions = [firstCommand, ...rest];

    // 6. One transaction: the routine, the entries, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(authority.scope, inventoryAssertion, accountingAssertions, (tx) =>
      executeCollectPayment(tx, this.posting, bound),
    );
    return { ...(await readCustomerPayment(this.db, m, input.paymentId)), replayed };
  }

  /** The payment's state in ONE statement, read by `daftar_app` under RLS. */
  private async readState(scope: ReceivablesReadScope, input: CustomerPaymentRequest): Promise<CollectPaymentState> {
    const [row] = await scopedReceivablesRows<CollectPaymentState>(
      this.db,
      scope,
      `SELECT b.base_currency::text AS base_currency, bc.minor_units AS base_exponent,
              ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future,
              (SELECT c.minor_units FROM currencies c WHERE c.code = coalesce($3::char(3), b.base_currency)) AS currency_exponent,
              (SELECT k.status FROM customers k WHERE k.business_id = b.id AND k.id = $4) AS customer_status,
              ${RECEIVABLES_METHOD_SQL.replace('%METHOD%', '$5')} AS method,
              ${SETTLED_INVOICES_SQL.replace('%IDS%', '$6')} AS invoices
         FROM businesses b
         JOIN currencies bc ON bc.code = b.base_currency
        WHERE b.id = $1`,
      [scope.businessId, input.paymentDate, input.currencyCode ?? null, input.customerId, input.paymentMethodId, input.allocations.map((a) => a.invoiceId)],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return row;
  }

  /**
   * The payment's FX snapshot at its date.
   *
   * Domestic: `(NULL, 1, 'base', <date>T00:00:00Z)` and the registry is never
   * consulted. Foreign: the row `accounting_fx_rate_lookup` returns for
   * `(currency → base)` at the LAST SECOND of the date in the business's
   * timezone — computed in SQL from the date alone, which is the same instant
   * the routine recomputes under its lock. Nothing here reads a clock.
   *
   * It lives HERE, on the command service, and not on the read surface: this
   * is the payment's COMMAND-side rate binding, and a current-rate lookup on a
   * reporting module is what G-6 forbids (`scripts/guards/read-surface.ts`) —
   * a report must re-read the rate the document froze, never today's. That is
   * also the shape of the precedent this slice follows: the sale commit keeps
   * its own `readFx` private to the service (`sale-commit.service.ts`), so a
   * change to another slice's rate read cannot silently move a receivable's
   * rate.
   */
  private async readFx(scope: ReceivablesReadScope, currency: string, baseCurrency: string, date: string): Promise<ReceivablesFx> {
    if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
      return { rateId: null, rate: DOMESTIC_RATE_TEXT, rateR10: DOMESTIC_RATE_R10, source: 'base', at: new Date(`${date}T00:00:00Z`) };
    }
    let row: { rate_id: string; rate: string; source: 'base' | 'manual'; effective_at: Date } | undefined;
    try {
      [row] = await scopedReceivablesRows<{ rate_id: string; rate: string; source: 'base' | 'manual'; effective_at: Date }>(
        this.db,
        scope,
        `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
           FROM businesses b
          CROSS JOIN LATERAL accounting_fx_rate_lookup(
                  b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
          WHERE b.id = $1`,
        [scope.businessId, currency, date],
      );
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code !== null) throw new AccountingError(code, 'the accounting authority refused this rate lookup', { businessId: scope.businessId });
      throw e;
    }
    if (row === undefined) throw new Error('the FX rate lookup returned no row');
    return { rateId: row.rate_id, rate: row.rate, rateR10: parseUnitCost(row.rate), source: row.source, at: row.effective_at };
  }
}
