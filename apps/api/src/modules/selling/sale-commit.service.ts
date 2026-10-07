import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AccountingError,
  convertToBaseMinor,
  parseDatabaseAccountingError,
  type PostingCommand,
  type SaleCogsFacts,
  type SaleCommitPostings,
  type SaleInvoiceFacts,
  type SaleMovementFacts,
} from '@daftar/accounting';
import { hasPermission, MAX_SALE_LINES, type SaleSettlementMode } from '@daftar/domain-core';
import {
  assertQuantityRepresentable,
  formatQuantity,
  InventoryError,
  parseDecimal,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  saleCommitIntentSha256,
  saleCommitPayload,
  SALE_DOMESTIC_RATE_R10,
  type MovementPayload,
  type SaleCommitPayloadLine,
} from '@daftar/inventory';
import type { SaleDto } from '@daftar/shared-contracts';
import { Database, presentInventoryAssertion, type BusinessInventoryAccountingTransaction, type SeamAccountingAuthority } from '../../infra/database';
import { DatabaseAccountingPostingAdapter } from '../accounting/accounting-posting.adapter';
import { AuditService } from '../audit/audit.service';
import { SalePostingService } from '../accounting/sale-posting.service';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import { readWarehouses, resolveVariants, type ReadScope, type ResolvedVariant } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { readSaleHeader, readSalePriceFacts, readSaleStockLevels, scopedSellingRows, type SalePriceFacts, type SaleStockLevel } from './sale-reads';
import { sellingInventoryRefusal, sellingPackageRefusal, sellingRefusal } from './selling-errors';
import { auditThenRethrowSellingRefusal, saleCommitAttempt, type SellingAttempt } from './selling-refusal-audit';
import type { SaleCommitRequest } from './selling.schemas';

/**
 * `POST /v1/sales` — THE ATOMIC SALE COMMIT (P4-S2; lock P4-AL-16, P4-AL-18,
 * P4-AL-25, P4-AL-29, P4-AL-30, P4-AL-35, P4-AL-41, P4-AL-44;
 * docs/PHASE_4_S2_CONTRACT.md A-01 – A-12).
 *
 * The flow is the accepted `PurchaseReceiptService` flow with a sale's
 * sequence, and it is deliberately the same flow: `plan` resolves and BINDS
 * every value, mints nothing and opens no transaction; then everything is
 * minted; then ONE seam-2 transaction runs the routine and the two postings
 * and commits.
 *
 *  1. **the replay proof, FIRST.** The `sales` row for this caller-supplied
 *     `saleId` is read under a per-document advisory lock, and its stored
 *     `commit_intent_sha256` is compared with the digest of THIS request —
 *     before the customer, the catalogue, the rate or a single stock level is
 *     read. `[[daftar-registry-before-state]]`: a stale request replayed after
 *     a later transition, whose handler reads state first, performs a second
 *     real change. Same digest ⇒ the stored sale is returned, having changed
 *     nothing (and the actor's authority is established BEFORE that answer,
 *     for the `customer_credit_application` reason: a replay branch that
 *     answered first would hand a cashier who may not grant a discount a
 *     `200 replayed: true` over a discounted sale).
 *     Different digest ⇒ `sale.idempotency_conflict`: an idempotency
 *     key is not permission, and a replay must prove WHICH command it is
 *     replaying before it answers "success"
 *     (`[[daftar-idempotency-key-is-not-permission]]`);
 *  2. **authority**, over the warehouse the stock leaves. `sales.create` is
 *     the minting key; a `credit` sale additionally needs `receivables.view`
 *     and a non-zero discount additionally needs the SENSITIVE
 *     `sales.discount` — refused, never silently zeroed, because a
 *     silently-zeroed discount charges the customer more than the cashier
 *     told them;
 *  3. **current state**: the customer, the warehouse and its home branch, the
 *     business's base currency and today in its timezone, the products,
 *     variants and catalogue prices, and the FX snapshot;
 *  4. **every amount the database will store, computed and BOUND**: the line
 *     gross, discount and net; the subtotal; the total; the ONE conversion
 *     `B = convertToBaseMinor(T)`; and the exact integer base shares. Not one
 *     of these is read from the request (P4-AL-18);
 *  5. **the `invctl/1` assertion over the sale payload, and TWO accounting
 *     assertions** — `sale` (the COGS entry) and `invoice` (the revenue
 *     entry) — all minted BEFORE the seam opens, in posting order. The COGS
 *     command cannot be built until the routine has returned its value
 *     deltas, so its assertion is minted over the command whose only unknown
 *     is an amount the routine computes; see A-08 of the contract for why this
 *     forces the COGS assertion to be minted from the ROUTINE's figures and
 *     therefore why the sale is a two-phase call inside one transaction;
 *  6. **one seam-2 transaction**: the routine (which writes the sale, its
 *     items, the movements through `inventory_apply_stock_movements`, the
 *     bridge rows, the invoice, its items and the invoice number), then the
 *     COGS entry, then the revenue entry, then COMMIT.
 *
 * **What makes it atomic is structural, not procedural.** The seam refuses to
 * open inside another transaction and nothing opens inside it
 * (`database.ts:150-161`), so there is no second connection to commit
 * independently. `AccountingAssertionSequence.assertComplete()` catches only
 * the PARTIAL-posting case — presenting NONE is deliberately allowed — so the
 * all-or-nothing guarantee is the source rows' own DEFERRED binding FKs:
 * `invoices_binding_fk` (`0075:318`, already shipped) with its
 * status-conditional `invoices_binding_owed_ck`, and the `sales` twin that
 * `0077` adds. A sale that wrote stock and posted nothing fails the COMMIT at
 * the constraint, not at a check this service performs.
 *
 * The commit is optimistic: if the customer, the catalogue, the rate or the
 * stock moved between the reads and the routine's locks, the routine refuses
 * under its own locks and nothing commits. **There is no server retry**
 * (`[[daftar-lock-order-not-retry]]`): a refusal is returned to the client as
 * `sale.state_changed`, and the client decides.
 *
 * **It reads no clock.** `documentDate` and `dueDate` are required request
 * fields; the only `now()` anywhere near this path is the database's
 * `created_at` DEFAULT, which no fingerprint covers. `readBusinessToday`
 * exists only to REFUSE a future document date (the `0058` rule) and its
 * answer is never adopted as a date.
 */
@Injectable()
export class SaleCommitService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    // The ONE place a sale's posting authority is minted (C's
    // `SalePostingService`). This service mints NO accounting assertion
    // itself: a selling service that did would be a second posting authority
    // with no permission check in front of it.
    @Inject(SalePostingService) private readonly salePosting: SalePostingService,
    @Inject(DatabaseAccountingPostingAdapter) private readonly posting: DatabaseAccountingPostingAdapter,
    // P4-AL-48's refusal audit. `sale_commit` writes ONE audit row —
    // `sale.committed` at `0078:1002`, its LAST step — after all 33 of its
    // `RAISE EXCEPTION`s, every one of which aborts the transaction. So a
    // refused sale persisted no evidence at all until this was injected.
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * P4-AL-48: a refusal is audited as heavily as a success. The attempt record
   * is built BEFORE `run`, so a refusal raised on its very first line still has
   * a sale id, the operation and the request's own figures to audit; `plan`
   * fills in the intent digest and the branch as it learns them.
   *
   * The figures are the ones the REQUEST carried, because those are the ones
   * «that caused it» for a forged total or an over-cap attempt. Not one of them
   * is a derived amount: `sale_commit` RECOMPUTES every price, total and share
   * from the catalogue, so the request carries identities, quantities and a
   * discount request and nothing else — and that is exactly what a reviewer of
   * a refused sale needs to see.
   */
  async commit(m: MembershipContext, input: SaleCommitRequest, btx: BusinessTransactionId): Promise<SaleDto> {
    const attempt = saleCommitAttempt(input, null);
    try {
      return await this.run(m, input, btx, attempt);
    } catch (e) {
      return await auditThenRethrowSellingRefusal(this.audit, m, attempt, e);
    }
  }

  private async run(m: MembershipContext, input: SaleCommitRequest, btx: BusinessTransactionId, attempt: SellingAttempt): Promise<SaleDto> {
    const outcome = await this.plan(m, input, btx, attempt);
    if (outcome.kind === 'replay') return readSale(this.db, m, input.saleId, true);
    const plan = outcome.plan;

    // 5. Mint everything before the seam opens. The order is the posting
    //    order, which is what `AccountingAssertionSequence` hands out by
    //    position: the COGS entry, then the revenue entry.
    const { inventoryAssertion, accountingAssertions } = this.seamAuthority(plan);

    // 6. One transaction: the routine, the COGS entry, the revenue entry, COMMIT.
    const replayed = await this.db.withBusinessInventoryAccountingTransaction(plan.authority.scope, inventoryAssertion, accountingAssertions, (tx) =>
      this.execute(tx, plan),
    );
    return readSale(this.db, m, input.saleId, replayed);
  }

  /**
   * **THE SEAM EXTRACTION (TL-P4-S3-R1).** The two authorities one accepted
   * sale commit runs under, minted from a `plan` and from nothing else:
   * the `invctl/1` inventory assertion over the bound payload, and the
   * accounting authority in posting order with the conditional COGS arm.
   *
   * This is the WHOLE of what `run` used to do between `plan` and the seam,
   * lifted verbatim so there is exactly one place the sale's authority is
   * minted. It exists because an atomic POS checkout must own the transaction
   * — the cart tombstones have to commit or roll back WITH the sale — and a
   * caller that owns the transaction still must not re-derive the sale's
   * authority. A second minting site would be a second sale writer wearing
   * the first one's name.
   *
   * It mints; it opens nothing. `run` and `PosCheckoutService` are now the two
   * callers, and `execute` is the one body that runs inside either's
   * transaction.
   */
  seamAuthority(plan: SaleCommitPlan): { readonly inventoryAssertion: string; readonly accountingAssertions: SeamAccountingAuthority } {
    const inventoryAssertion = this.authorization.mint(plan.authority, plan.built.payload);
    // The two accounting assertions were minted by `SalePostingService` inside
    // `plan`, in posting order, with the P4-AL-35 matrix applied at the mint.
    //
    // The COGS one is declared CONDITIONAL. A sale of stock whose stored
    // valuation is zero releases no value, so it posts only the REVENUE entry
    // — `journal_lines` refuses a zero amount
    // (`journal_lines_money_cap_ck`, `0042:225`) and `0060:388-390` gives an
    // emptying movement exactly `-valuation_base_minor`, which is 0 for a
    // zero valuation. The accounting is sound with one entry: there is no cost
    // of goods to post and `GL Inventory (1200) = Σ value_delta_base_minor`
    // still holds at 0.
    //
    // The seam PERMITS the non-presentation; it does not and cannot police it,
    // because it never sees a COGS total. The law is the DEFERRED
    // `sales_cogs_owed` trigger (contract C-07): a sale whose bridged
    // movements carry a non-zero total value and no `sale` accounting binding
    // cannot COMMIT. A rule only the wrapper enforces is a convention while
    // the trusted primitive can still write the row.
    //
    //    When `postings.cogs` is null the authority is ONE assertion — the
    //    revenue one — and nothing is conditional: there is no COGS entry to
    //    declare optional, so declaring one would exempt a posting that does
    //    not exist (and the seam refuses a wholly-conditional transaction).
    //    When both exist, the COGS assertion (always first, in posting order)
    //    is the conditional one, because the prediction can still turn out to
    //    be zero under the lock.
    const accountingAssertions: SeamAccountingAuthority =
      plan.postings.cogs === null
        ? { kind: 'postings', assertions: plan.accountingAssertions }
        : { kind: 'postings', assertions: plan.accountingAssertions, conditional: [plan.accountingAssertions[0]] };
    return { inventoryAssertion, accountingAssertions };
  }

  /**
   * Steps 1–5: the intent digest, the authority, the replay proof, current state,
   * and every amount bound with both commands built. It opens no transaction and mints
   * nothing, so a refusal here has consumed no authority and left no trace
   * beyond its audit row.
   */
  async plan(m: MembershipContext, input: SaleCommitRequest, btx: BusinessTransactionId, attempt?: SellingAttempt): Promise<SaleCommitPlanOutcome> {
    // 1. THE INTENT DIGEST, BEFORE ANY STATE READ.
    //
    //    The intent digest is computable from the request alone — that is the
    //    property `saleCommitIntentSha256` is built for, and the reason the
    //    resolved price, the rate and every total are outside the fingerprint.
    const intentSha256 = saleCommitIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      saleId: input.saleId,
      settlementMode: input.settlementMode,
      customerId: input.customerId,
      warehouseId: input.warehouseId,
      documentDate: input.documentDate,
      dueDate: input.dueDate,
      taxMinor: 0n,
      notes: input.notes,
      lines: input.lines.map((l) => ({
        lineId: l.lineId,
        productId: l.productId,
        merchantVariantId: l.variantId,
        qtyQ4: parseQuantity(l.quantity),
        discountMinor: parseMinor(l.discountMinor),
      })),
    });
    // The digest exists now, so a refusal from here on can carry it. The
    // attempt is OPTIONAL because `plan` has two callers — `commit` and
    // `PosCheckoutService.checkout` — and each owns its own attempt record;
    // filling it here rather than in each of them is what keeps the digest a
    // fact the ONE planner states once.
    if (attempt !== undefined) attempt.intentSha256 = intentSha256;
    const stored = await readSaleHeader(this.db, m, input.saleId);

    // 2. AUTHORITY, AND P4-AL-35'S MATRIX — BEFORE THE REPLAY BRANCH.
    //
    //    The order is the `customer-credit-application.service.ts:196-220`
    //    order and it is for that file's reason: an argument the intent digest
    //    does not carry must be judged before the branch that answers on the
    //    digest alone. Nothing here is a body key — `sale-payloads.ts` and
    //    `0078:567-584` digest every one of those, field for field — and what
    //    the digest cannot carry is **the actor and its permission set**. It
    //    cannot be added either: the digest is re-derived by `sale_commit`
    //    from its own arguments, and a seventeenth field here would disagree
    //    with the migration on every sale and make a re-issued token a false
    //    `sale.idempotency_conflict`.
    //
    //    While these three sentences sat AFTER the branch, a CASHIER — whose
    //    built-in role holds `sales.create` and neither of the two keys below
    //    (`permissions.ts:214`) — who delivered a manager's already-committed
    //    DISCOUNTED sale was answered `200 replayed: true` with the whole
    //    `SaleDto`: the totals, the granted discount and `cogsBaseMinor`. The
    //    same body under a fresh `saleId` is `403
    //    sale.discount_not_permitted`. `supplier-payment.service.ts:413-415`
    //    is the estate's counter-pattern: it re-authorizes over the stored
    //    payment's warehouses before it answers a replay, because "the stored
    //    answer is shown only to an actor with authority over every warehouse
    //    it touches".
    //
    //    Reading membership here is not a breach of
    //    `[[daftar-registry-before-state]]`: the digest above is built before
    //    it and binds nothing it produces, so the same request still digests
    //    identically for ever. `input.warehouseId` is itself digested, so on a
    //    matching digest the warehouse authorized over IS the stored sale's.
    const authority = await this.authorization.authorize(m, 'sale.commit', btx, [input.warehouseId]);
    // P4-AL-35's matrix: `receivables.view` is the second half of a CREDIT
    // sale, and `sales.discount` is SENSITIVE. A discount asked without it is
    // REFUSED, never silently zeroed, because a silently-zeroed discount
    // charges the customer more than the cashier told them.
    if (input.settlementMode === 'credit' && !hasPermission(m.roles, 'receivables.view')) {
      throw sellingRefusal('sale.credit_not_permitted');
    }
    if (input.lines.some((l) => parseMinor(l.discountMinor) > 0n) && !hasPermission(m.roles, 'sales.discount')) {
      throw sellingRefusal('sale.discount_not_permitted');
    }

    // 3. The idempotency proof. Everything it compares is in the digest, and
    //    the arguments that are not have already been judged above.
    if (stored !== null) {
      if (stored.commit_intent_sha256 === intentSha256) {
        return { kind: 'replay' };
      }
      // The key was seen; the command was NOT. Answering "success" here is
      // the defect `[[daftar-idempotency-key-is-not-permission]]` names.
      throw sellingRefusal('sale.idempotency_conflict');
    }

    // 4. Current state.
    const business = await this.readBusiness(m, input.documentDate);
    if (business.documentDateInFuture) throw sellingRefusal('sale.document_date_in_future');
    const warehouse = (await readWarehouses(this.db, m, [input.warehouseId], [input.warehouseId])).get(input.warehouseId);
    if (warehouse === undefined) throw sellingRefusal('sale.warehouse_not_found');
    // The branch is a SERVER fact derived from the warehouse, and it is bound
    // now, so a refusal from here on carries the dimension the sale would have
    // been written under.
    if (attempt !== undefined) attempt.branchId = warehouse.branchId;
    if (input.customerId !== null) {
      const customer = await this.readCustomer(m, input.customerId);
      if (customer === null) throw sellingRefusal('sale.customer_not_found');
      if (customer.status !== 'active') throw sellingRefusal('sale.customer_inactive');
    }
    // The stock identity: the base variant for a simple product, the named
    // merchant variant otherwise (P3-AL-52 — the hidden base variant never
    // leaves the server, which is why the RESOLVED key is outside the intent).
    const resolved = await resolveVariants(
      this.db,
      m,
      input.lines.map((l) => ({ productId: l.productId, variantId: l.variantId })),
    );
    const facts = await readSalePriceFacts(
      this.db,
      m,
      resolved.map((r) => r.variantId),
    );

    // 5. Every amount the database will store, computed HERE and bound.
    const priced = this.price(input, resolved, facts);
    const fx = await this.readFx(m, priced.currency, business.baseCurrency, input.documentDate);
    const totalBaseMinor =
      fx.source === 'base'
        ? priced.totalTxnMinor
        : convertToBaseMinor({
            txnAmountMinor: priced.totalTxnMinor,
            txnCurrency: priced.currency,
            baseCurrency: business.baseCurrency,
            fxRate: fx.rate,
          });
    const invoiceId = randomUUID();

    // 6. The two postings and their assertions, minted by the ONE sale
    //    posting authority (`SalePostingService`), in posting order: the COGS
    //    entry on source type `sale`, then the revenue entry on source type
    //    `invoice`. **This comes BEFORE the payload is built, and that order
    //    is deliberate**: the per-line base shares the payload carries are the
    //    accounting owner's, and the sale path computes them ONCE (see below).
    //
    //    The COGS figure is a PREDICTION, because the stock writer computes
    //    the real value deltas inside the lock and the seam requires its
    //    assertions before the transaction opens. `readSaleStockLevels` reads
    //    the keys' current valuation and `predictMovements` applies the stock
    //    writer's OWN rule, including the exact-emptying rule that keeps
    //    `R-INV-03` green: a movement that empties a key carries exactly
    //    `-valuation`, never a re-multiplied average. A-08 of the contract
    //    states why a stale prediction is a refused sale and never a
    //    misstated cost.
    const invoiceFacts: SaleInvoiceFacts = {
      tenantId: m.tenantId,
      businessId: m.businessId,
      invoiceId,
      issueDate: input.documentDate,
      branchId: warehouse.branchId,
      customerId: input.customerId,
      settlementKind: input.settlementMode,
      // A cash sale lands in the `cash` system account DIRECTLY and writes no
      // payment document: `payments` and `payment_allocations` are P4-S4's
      // relations and `P4-AL-86` forbids creating a later slice's relation
      // here. RECOMMENDED-PENDING the Tech Lead's word (contract D-01).
      //
      // It is the SYSTEM form and never `{kind:'code'}`. The accounting
      // owner's §3.1 refuses the code arm outright, because it admitted
      // `{kind:'code', code:'4000'}` and derived `Dr 4000 / Cr sales_revenue`
      // — the same account on both sides on the default chart. A till's
      // account is an engine identity, not a code someone typed.
      settlementAccount: input.settlementMode === 'cash' ? { kind: 'system', systemKey: 'cash' } : null,
      currencyCode: priced.currency,
      baseCurrency: business.baseCurrency,
      subtotalTxnMinor: priced.subtotalTxnMinor,
      discountTxnMinor: priced.discountTxnMinor,
      taxMinor: 0n,
      totalTxnMinor: priced.totalTxnMinor,
      totalBaseMinor,
      fx: { sourceToBaseRate: fx.rate, rateSource: fx.source, rateTimestamp: fx.at },
      lines: priced.lines.map((l, i) => ({ lineNo: i + 1, netTxnMinor: l.netTxnMinor, taxMinor: 0n })),
    };
    const levels = await readSaleStockLevels(
      this.db,
      m,
      input.warehouseId,
      priced.lines.map((l) => l.variantId),
    );
    const cogsFacts: SaleCogsFacts = {
      tenantId: m.tenantId,
      businessId: m.businessId,
      saleId: input.saleId,
      soldOn: input.documentDate,
      branchId: warehouse.branchId,
      warehouseId: input.warehouseId,
      baseCurrency: business.baseCurrency,
      movements: predictMovements(priced.lines, levels),
    };
    // A sale of stock whose stored valuation is zero releases no value and
    // posts ONE entry: `postings.cogs` is null, the COGS assertion is not
    // minted, and the conditional seam arm makes the non-presentation lawful.
    // There is no refusal for it any more and there must not be one — a
    // legitimate sale that cannot commit is worse than the code suggested.
    const authorized = this.salePosting.authorizeSaleCommit(m, invoiceFacts, cogsFacts);

    // 7. The per-line base shares, taken from the ACCOUNTING owner's
    //    derivation and consumed BY `lineNo`.
    //
    //    There were briefly two share computations in the sale path — the
    //    inventory `baseShares` zipped positionally here, and
    //    `deriveSaleInvoiceBaseShares` inside the posting derivation — and
    //    they agreed only because they are the same algorithm. Two
    //    derivations of one figure that agree by coincidence are a second
    //    truth waiting for one of them to be changed, so there is now one:
    //    the accounting owner's, because the share is a REVENUE figure and
    //    the entry that carries it is theirs (`R-SAL-03` reconciles revenue
    //    from the journal against `Σ invoice_items.base_share_minor`, so the
    //    two must be the same integers by construction and not by agreement).
    //
    //    It is consumed by `lineNo` and never by index: `SaleInvoiceBaseShare`
    //    NAMES its line precisely so a mis-zip is impossible, and the
    //    duplicate-`lineNo` case is already refused by the derivation. A share
    //    with no line, or a line with no share, is a defect and is raised as
    //    one rather than defaulted to zero — a zero share would silently
    //    break `Σ base_share = total_base`.
    const shareByLineNo = new Map(authorized.postings.baseShares.map((sh) => [sh.lineNo, sh.shareMinor]));
    if (shareByLineNo.size !== priced.lines.length) throw new Error("the derived base shares do not name this sale's lines one for one");
    const lines: SaleCommitPayloadLine[] = priced.lines.map((l, i) => {
      const shareMinor = shareByLineNo.get(i + 1);
      if (shareMinor === undefined) throw new Error('a sale line has no derived base share');
      return {
        lineId: l.lineId,
        productId: l.productId,
        merchantVariantId: l.merchantVariantId,
        variantId: l.variantId,
        qtyQ4: l.qtyQ4,
        discountMinor: l.discountMinor,
        unitPriceC10: l.unitPriceC10,
        netTxnMinor: l.netTxnMinor,
        baseShareMinor: shareMinor,
      };
    });
    const built = saleCommitPayload({
      tenantId: m.tenantId,
      businessId: m.businessId,
      saleId: input.saleId,
      settlementMode: input.settlementMode,
      customerId: input.customerId,
      warehouseId: input.warehouseId,
      branchId: warehouse.branchId,
      invoiceId,
      documentDate: input.documentDate,
      dueDate: input.dueDate,
      currency: priced.currency,
      rate: { rateId: fx.rateId, rateR10: fx.rateR10, source: fx.source, rateAtEpochSeconds: BigInt(fx.at.getTime() / 1000) },
      taxMinor: 0n,
      notes: input.notes,
      subtotalTxnMinor: priced.subtotalTxnMinor,
      discountTxnMinor: priced.discountTxnMinor,
      totalTxnMinor: priced.totalTxnMinor,
      totalBaseMinor,
      lines,
    });
    if (built.intentSha256 !== intentSha256) throw new Error('the bound sale payload does not carry the proven intent');

    const params: unknown[] = [
      input.saleId,
      invoiceId,
      input.settlementMode,
      input.customerId,
      input.warehouseId,
      warehouse.branchId,
      input.documentDate,
      input.dueDate,
      priced.currency,
      fx.rateId,
      fx.rate,
      fx.source,
      `${fx.at.toISOString().slice(0, 19)}Z`,
      priced.subtotalTxnMinor.toString(10),
      priced.discountTxnMinor.toString(10),
      priced.totalTxnMinor.toString(10),
      totalBaseMinor.toString(10),
      input.notes,
      lines.map((l) => l.lineId),
      priced.lines.map((l) => l.productId),
      lines.map((l) => l.merchantVariantId),
      lines.map((l) => l.variantId),
      priced.lines.map((l) => l.nameSnapshot),
      lines.map((l) => formatQuantity(l.qtyQ4)),
      priced.lines.map((l) => l.unitPriceTxnMinor.toString(10)),
      priced.lines.map((l) => l.grossTxnMinor.toString(10)),
      lines.map((l) => l.discountMinor.toString(10)),
      lines.map((l) => l.netTxnMinor.toString(10)),
      lines.map((l) => l.baseShareMinor.toString(10)),
    ];
    return {
      kind: 'plan',
      plan: {
        authority,
        tenantId: m.tenantId,
        businessId: m.businessId,
        saleId: input.saleId,
        invoiceId,
        settlementMode: input.settlementMode,
        warehouseId: input.warehouseId,
        branchId: warehouse.branchId,
        documentDate: input.documentDate,
        baseCurrency: business.baseCurrency,
        businessTransactionId: btx,
        built,
        postings: authorized.postings,
        accountingAssertions: authorized.assertions,
        params,
      },
    };
  }

  /**
   * Step 6 on an open seam-2 transaction: present the `sale.commit`
   * assertion, run `sale_commit`, then post the COGS entry — completed from
   * the routine's own returned value deltas — and the revenue entry, each
   * presented its own accounting assertion by the adapter.
   *
   * `sale_commit` returns `replayed` for the case a concurrent identical
   * commit won the sale's primary key inside the routine's own lock; that
   * commit posts no entry and its minted assertions expire unused, exactly as
   * `purchase_receive`'s replay does.
   */
  async execute(tx: BusinessInventoryAccountingTransaction, plan: SaleCommitPlan): Promise<boolean> {
    await presentInventoryAssertion(tx, 'sale.commit');
    const r = await tx.query<{ replayed: boolean; cogs_base_minor: string }>(SALE_COMMIT_SQL, [...plan.params]);
    const [first] = r.rows;
    if (first === undefined) throw new Error('sale_commit returned no row');
    if (first.replayed) return true;
    // P4-AL-25: the COGS truth is the SUM of the stored
    // `stock_movements.value_delta_base_minor` integers, which is what the
    // routine returns. It is compared against the figure the assertion was
    // signed over, HERE, so a stale prediction is a named refusal before any
    // posting is attempted rather than a fingerprint mismatch inside the
    // ledger writer. Never `quantity x average_cost`.
    const actual = parseMinor(first.cogs_base_minor);
    const released = actual < 0n ? -actual : actual;
    const cogs = plan.postings.cogs;
    // Zero released value ⇒ no COGS entry exists to post. Either the
    // derivation already said so (`cogs === null`: the stock carried no value
    // when the prediction was read) or the prediction said otherwise and the
    // lock disagreed. BOTH end the same way: only the revenue entry is
    // posted, the conditional seam arm makes the non-presentation lawful, and
    // `sales_cogs_owed` (C-07) is what proves at COMMIT that nothing was owed.
    if (released === 0n) {
      await this.posting.postEntryInTransaction(tx.accounting, { command: revenuePostingCommand(plan) });
      return false;
    }
    // Non-zero released value with no derived COGS entry is the OTHER
    // direction of the same disagreement: the prediction read zero and the
    // lock found value. There is no signed authority for the entry that is now
    // owed, so the sale is refused rather than committed without it —
    // `sales_cogs_owed` would fail the COMMIT anyway, and a named refusal is
    // what the till can act on.
    if (cogs === null) throw sellingRefusal('sale.state_changed');
    const signed = cogs.lines.reduce((t, l) => (l.side === 'D' ? t + l.baseAmountMinor : t), 0n);
    if (released !== signed) throw sellingRefusal('sale.state_changed');
    const cogsCommand: PostingCommand = {
      tenantId: plan.tenantId,
      businessId: plan.businessId,
      sourceType: cogs.sourceType,
      sourceId: cogs.sourceId,
      entryDate: cogs.entryDate,
      lines: cogs.lines,
    };
    await this.posting.postEntryInTransaction(tx.accounting, { command: cogsCommand });
    await this.posting.postEntryInTransaction(tx.accounting, { command: revenuePostingCommand(plan) });
    return false;
  }

  /**
   * The server's arithmetic, over the CATALOGUE's prices and the REQUEST's
   * quantities and discounts (P4-AL-18). Nothing here reads a figure the
   * client sent except the quantity and the discount request, which are the
   * only two things the client is allowed to state.
   *
   * One currency for the whole sale: every line's catalogue price is in the
   * product's own `price_currency`, and a sale mixing two currencies has no
   * single total to invoice. A mixed basket is refused rather than converted,
   * because converting would invent a cross-rate nobody stated.
   */
  private price(input: SaleCommitRequest, resolved: readonly ResolvedVariant[], facts: ReadonlyMap<string, SalePriceFacts>): PricedSale {
    if (input.lines.length === 0 || input.lines.length > MAX_SALE_LINES) throw sellingRefusal('sale.lines_required');
    const lines: PricedLine[] = [];
    let currency: string | null = null;
    let subtotal = 0n;
    let discount = 0n;
    for (const [i, l] of input.lines.entries()) {
      const v = resolved[i];
      if (v === undefined) throw sellingRefusal('sale.product_not_found');
      const f = facts.get(v.variantId);
      if (f === undefined) throw sellingRefusal('sale.product_not_found');
      if (!f.trackInventory || f.unitDecimals === null) throw sellingInventoryRefusal('inventory.product_not_tracked');
      if (f.productStatus !== 'active') throw sellingInventoryRefusal('inventory.product_archived');
      if (f.variantStatus !== 'active') throw sellingInventoryRefusal('inventory.variant_archived');
      if (f.priceMinor === null || f.priceCurrency === null || f.nameSnapshot === '') throw sellingRefusal('sale.product_not_priced');
      if (currency === null) currency = f.priceCurrency;
      else if (currency !== f.priceCurrency) throw sellingRefusal('sale.currency_unknown');

      const qtyQ4 = parseQuantity(l.quantity);
      try {
        assertQuantityRepresentable(qtyQ4, f.unitDecimals);
      } catch (e) {
        if (e instanceof InventoryError) throw sellingPackageRefusal(e);
        throw e;
      }
      // gross = HALF_EVEN(qty x unit price), computed ONCE from the exact
      // fixed-point operands. `products.base_price_minor` is already an
      // integer count of MINOR units (`0005:21`), so Q4 x minor is scaled by
      // 10^4 and the quotient is taken at scale 0 with no intermediate
      // rounding (`[[daftar-rounding-is-not-additive]]`). The C10 the payload
      // carries is that same integer widened, never a re-derived quotient.
      const grossTxnMinor = halfEvenDiv(qtyQ4 * f.priceMinor, 10n ** 4n);
      const discountMinor = parseMinor(l.discountMinor);
      if (discountMinor > grossTxnMinor) throw sellingRefusal('sale.discount_invalid');
      lines.push({
        lineId: l.lineId,
        productId: f.productId,
        merchantVariantId: v.merchantVariantId,
        variantId: v.variantId,
        nameSnapshot: f.nameSnapshot,
        qtyQ4,
        unitPriceC10: f.priceMinor * 10n ** 10n,
        unitPriceTxnMinor: f.priceMinor,
        grossTxnMinor,
        discountMinor,
        netTxnMinor: grossTxnMinor - discountMinor,
      });
      subtotal += grossTxnMinor;
      discount += discountMinor;
    }
    if (currency === null) throw sellingRefusal('sale.lines_required');
    const totalTxnMinor = subtotal - discount;
    if (totalTxnMinor <= 0n) throw sellingRefusal('sale.total_zero');
    return { currency, subtotalTxnMinor: subtotal, discountTxnMinor: discount, totalTxnMinor, lines };
  }

  /**
   * The business's base currency, and whether the supplied document date is
   * after today in the business's timezone (the `0058` rule, refused early).
   *
   * This is the ONLY clock read anywhere on the sale path, and it is a
   * REFUSAL, never an adoption: no value derived from `now()` is stored,
   * signed or fingerprinted. The accepted purchase receipt reads exactly this
   * and for exactly this reason.
   */
  private async readBusiness(scope: ReadScope, documentDate: string): Promise<{ readonly baseCurrency: string; readonly documentDateInFuture: boolean }> {
    const [row] = await scopedSellingRows<{ base_currency: string; future: boolean }>(
      this.db,
      scope,
      `SELECT b.base_currency, ($2::date > (now() AT TIME ZONE b.timezone)::date) AS future FROM businesses b WHERE b.id = $1`,
      [scope.businessId, documentDate],
    );
    if (row === undefined) throw new Error('the business is not readable');
    return { baseCurrency: row.base_currency, documentDateInFuture: row.future };
  }

  /** The customer, by the composite key. A customer of another business is not reachable: RLS, not a filter. */
  private async readCustomer(scope: ReadScope, customerId: string): Promise<{ readonly status: string } | null> {
    const [row] = await scopedSellingRows<{ status: string }>(this.db, scope, `SELECT c.status FROM customers c WHERE c.business_id = $1 AND c.id = $2`, [
      scope.businessId,
      customerId,
    ]);
    return row === undefined ? null : { status: row.status };
  }

  /**
   * The FX snapshot the sale binds. Domestic: `(NULL, 1, 'base',
   * <date>T00:00:00Z)`, and the registry is never consulted. Foreign: the
   * registry row `accounting_fx_rate_lookup` returns for `(currency → base)`
   * at the last second of the document date in the business's timezone —
   * computed in SQL from the DATE alone, with no `now()`, so the routine
   * derives the same instant and the two agree by construction.
   *
   * The snapshot is immutable from this moment (P4-AL-10): a rate entered
   * tomorrow never changes this sale's figures and no reader recomputes them.
   */
  private async readFx(scope: ReadScope, currency: string, baseCurrency: string, documentDate: string): Promise<BoundSaleFx> {
    if (currency.toUpperCase() === baseCurrency.toUpperCase()) {
      return { rateId: null, rate: '1.0000000000', rateR10: SALE_DOMESTIC_RATE_R10, source: 'base', at: new Date(`${documentDate}T00:00:00Z`) };
    }
    let row: { rate_id: string; rate: string; source: string; effective_at: Date } | undefined;
    try {
      [row] = await scopedSellingRows<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
        this.db,
        scope,
        `SELECT r.rate_id, r.rate::text AS rate, r.source, r.effective_at
           FROM businesses b
          CROSS JOIN LATERAL accounting_fx_rate_lookup(
                  b.id, $2, b.base_currency, ((($3::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) r
          WHERE b.id = $1`,
        [scope.businessId, currency, documentDate],
      );
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === 'accounting.fx_rate_missing') throw sellingRefusal('sale.fx_rate_missing');
      if (code === 'accounting.fx_currency_unknown') throw sellingRefusal('sale.currency_unknown');
      if (code !== null) throw new AccountingError(code, 'the accounting authority refused this rate lookup', { businessId: scope.businessId });
      throw e;
    }
    if (row === undefined) throw new Error('the FX rate lookup returned no row');
    if (row.source !== 'manual' && row.source !== 'base') throw new Error('a registry rate has a source a sale cannot snapshot');
    if (row.effective_at.getTime() % 1000 !== 0) throw new Error('a registry rate instant is not at second precision');
    return { rateId: row.rate_id, rate: row.rate, rateR10: parseUnitCost(row.rate), source: row.source, at: row.effective_at };
  }
}

/** The FX snapshot the sale binds, in the payload's and the posting's forms at once. */
export interface BoundSaleFx {
  readonly rateId: string | null;
  /** Canonical decimal string with exactly 10 fraction digits, as `invoices.source_to_base_rate` stores it. */
  readonly rate: string;
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual';
  /** Second precision. Derived from the DATE alone, never from a clock. */
  readonly at: Date;
}

/** The revenue entry as a posting command, from the derived posting the authority was minted over. */
function revenuePostingCommand(plan: SaleCommitPlan): PostingCommand {
  return {
    tenantId: plan.tenantId,
    businessId: plan.businessId,
    sourceType: plan.postings.revenue.sourceType,
    sourceId: plan.postings.revenue.sourceId,
    entryDate: plan.postings.revenue.entryDate,
    lines: plan.postings.revenue.lines,
  };
}

/**
 * The stock writer's OWN valuation rule (`0060:383-396`), applied to the
 * pre-lock level rows to predict what it will compute inside the lock.
 *
 * The exact-emptying rule is the part that matters: a movement taking the LAST
 * unit of a key carries exactly `-valuation_base_minor`, not
 * `-HALF_EVEN(qty x average)`. An average unit cost is a derived ROUNDED
 * quotient, and re-multiplying it leaves a residue the stored valuation does
 * not have — `[[daftar-a-rounded-quotient-is-never-an-input]]` — which is
 * exactly the drift `R-INV-03` ("an emptied key carries zero valuation")
 * exists to catch. Predicting it any other way would make the prediction
 * disagree with the writer on every emptying sale.
 */
function predictMovements(lines: readonly PricedLine[], levels: ReadonlyMap<string, SaleStockLevel>): readonly SaleMovementFacts[] {
  return lines.map((l) => {
    const level = levels.get(l.variantId);
    // A key with no row holds nothing; the writer will refuse the sale under
    // the lock with `inventory.insufficient_stock`. The prediction says zero
    // rather than guessing, because the refusal is the writer's to make.
    if (level === undefined) return { sourceLineId: l.lineId, valueDeltaBaseMinor: 0n };
    if (l.qtyQ4 === level.onHandQ4) return { sourceLineId: l.lineId, valueDeltaBaseMinor: -level.valuationBaseMinor };
    const avg = level.avgUnitCostC10 ?? 0n;
    return { sourceLineId: l.lineId, valueDeltaBaseMinor: -halfEvenDiv(l.qtyQ4 * avg, 10n ** 14n) };
  });
}

interface PricedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly merchantVariantId: string | null;
  readonly variantId: string;
  readonly nameSnapshot: string;
  readonly qtyQ4: bigint;
  readonly unitPriceC10: bigint;
  readonly unitPriceTxnMinor: bigint;
  readonly grossTxnMinor: bigint;
  readonly discountMinor: bigint;
  readonly netTxnMinor: bigint;
}

interface PricedSale {
  readonly currency: string;
  readonly subtotalTxnMinor: bigint;
  readonly discountTxnMinor: bigint;
  readonly totalTxnMinor: bigint;
  readonly lines: readonly PricedLine[];
}

/** Everything `execute` needs, with every value the database will store already bound. */
export interface SaleCommitPlan {
  readonly authority: InventoryCommandAuthority;
  readonly saleId: string;
  readonly invoiceId: string;
  readonly settlementMode: SaleSettlementMode;
  readonly warehouseId: string;
  readonly branchId: string;
  readonly documentDate: string;
  readonly baseCurrency: string;
  readonly businessTransactionId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly built: MovementPayload;
  /**
   * Both derived postings, from the ONE sale posting authority. `cogs` is null
   * for a sale that released no value, which posts ONE entry. The COGS amount
   * is the PREDICTION (A-08).
   */
  readonly postings: SaleCommitPostings;
  /**
   * The minted assertions, in posting order: the COGS one then the revenue
   * one, or the revenue one alone when the sale released no value. Minted by
   * `SalePostingService`, never here.
   */
  readonly accountingAssertions: readonly [string] | readonly [string, string];
  /** The `sale_commit` arguments, in its signature's order. */
  readonly params: readonly unknown[];
}

/** What `plan` found: an idempotent replay to answer from the stored rows, or a bound commit. */
export type SaleCommitPlanOutcome = { readonly kind: 'replay' } | { readonly kind: 'plan'; readonly plan: SaleCommitPlan };

/**
 * The trusted command `0077` supplies, named here so the application and the
 * migration owner read one signature. Its exact shape is specified in
 * docs/PHASE_4_S2_CONTRACT.md C-09, including the two things it must NOT have:
 * a `DEFAULT`, and any `coalesce(p_*, current_date)`.
 */
const SALE_COMMIT_SQL = `SELECT replayed, cogs_base_minor::text AS cogs_base_minor FROM sale_commit(
   $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::date, $8::date, $9::char(3),
   $10::uuid, $11::numeric, $12::text, $13::timestamptz, $14::bigint, $15::bigint, $16::bigint, $17::bigint,
   $18::text, $19::uuid[], $20::uuid[], $21::uuid[], $22::uuid[], $23::text[], $24::numeric[], $25::bigint[],
   $26::bigint[], $27::bigint[], $28::bigint[], $29::bigint[])`;

/**
 * Exact `HALF_EVEN` of `n / d` at scale 0, by integer division and remainder —
 * sign-symmetric, with no float anywhere. The same arithmetic as
 * `inventory_half_even` (`0060:85-111`) and `packages/accounting`'s
 * conversion, because a second rounding rule would disagree only on the
 * numbers nobody tested.
 */
function halfEvenDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('a HALF_EVEN denominator is positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a - q * d;
  if (2n * r > d || (2n * r === d && q % 2n !== 0n)) q += 1n;
  return neg ? -q : q;
}

/** Placeholder for the read `0077` makes possible; see docs/PHASE_4_S2_CONTRACT.md A-11. */
async function readSale(db: Database, m: MembershipContext, saleId: string, replayed: boolean): Promise<SaleDto> {
  const { readSaleDto } = await import('./sale-reads');
  return readSaleDto(db, m, saleId, replayed);
}

/** Re-exported so `parseDecimal`'s presence here is deliberate rather than incidental. */
export const SALE_PRICE_SCALE = parseDecimal('1').scale;
