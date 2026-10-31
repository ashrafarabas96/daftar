import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { DocumentSequenceListDto, InvoiceDto, InvoicePageDto, InvoiceSettlementDto } from '@daftar/shared-contracts';
import { Membership } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { strictUuidParam } from '../inventory/canonical-id';
import { InvoiceReadService } from './invoice-reads';
import { sellingRefusal } from './selling-errors';
import { phase4Permission } from './selling-permissions';
import { DocumentSequenceQuerySchema, InvoiceListQuerySchema } from './selling.schemas';

/**
 * The invoice READ routes and the document-numbering read of P4-S1 (lock
 * P4-AL-16, P4-AL-24, P4-AL-31, P4-AL-35, P4-AL-54).
 *
 * **Every route here is a GET, and that is the design rather than a staging
 * decision.** P4-AL-16's atomic sale law puts the `invoices` row, its items, its
 * number and its revenue/AR entry in ONE transaction with the `sales` row, the
 * stock movements and the COGS entry: "There is no intermediate state in which
 * stock left the shelf and no invoice exists, or an invoice exists and no
 * movement was written." A `POST /v1/invoices` would offer exactly that
 * intermediate state over HTTP, so the invoice has one writer — the sale command
 * — and it belongs to the slice that writes the sale.
 *
 * There is no void route either. P4-AL-24 makes voiding a compound command that
 * reverses the revenue entry exactly once, reverses the inventory entry, returns
 * the stock and issues any refund from the credit-note source only; a direct
 * `UPDATE invoices SET status = 'void'` is refused by a trigger, and a route
 * that did the easy part of that command would be the first half of a split
 * commit.
 *
 * And there is no "allocate a number" route. The ordinal is `max + 1` taken
 * inside the sale's transaction while holding the sequence row — last of the
 * domain locks (P4-AL-32) — so a number allocated over HTTP could only be a
 * number that gaps, which a document number may not do.
 */
@Controller('/v1')
export class InvoicesController {
  constructor(@Inject(InvoiceReadService) private readonly reads: InvoiceReadService) {}

  /**
   * A keyset page of invoices. Requires `sales.view`.
   *
   * `status` filters the LIFECYCLE only (`draft`, `open`, `void`). There is no
   * `paid` value to ask for: settlement is derived and never a status
   * (P4-AL-24), so a caller after unpaid documents asks the customer's
   * open-invoice read, which derives it.
   */
  @Get('invoices')
  @phase4Permission('sales.view')
  async list(@Membership() m: MembershipContext, @Query() query: unknown): Promise<InvoicePageDto> {
    return this.reads.list(m, InvoiceListQuerySchema.parse(query));
  }

  /** One invoice with its items, its customer snapshot and the rate as posted. Requires `sales.view`. */
  @Get('invoices/:invoiceId')
  @phase4Permission('sales.view')
  async get(@Membership() m: MembershipContext, @Param('invoiceId') invoiceId: string): Promise<InvoiceDto> {
    return this.reads.get(m, strictUuidParam(invoiceId, 'invoiceId'));
  }

  /**
   * What is paid and what is left on one invoice, derived on read. Requires
   * `receivables.view` AND business-wide branch scope: the figure counts
   * payments and credit notes taken anywhere in the business, so an actor
   * limited to some branches would read a number that is true of their branches
   * and false of the invoice.
   */
  @Get('invoices/:invoiceId/settlement')
  @phase4Permission('receivables.view')
  async settlement(@Membership() m: MembershipContext, @Param('invoiceId') invoiceId: string): Promise<InvoiceSettlementDto> {
    const id = strictUuidParam(invoiceId, 'invoiceId');
    if (m.branchScopeMode !== 'all') throw sellingRefusal('customer.business_wide_scope_required');
    return this.reads.settlement(m, id);
  }

  /**
   * The business's document series: the kind, the period, the stored format and
   * the highest ordinal already committed. Requires `sales.view`.
   *
   * It reports no counter and no next number. P4-AL-31 refuses a counter column
   * because it is a derived number and therefore a second truth, and a published
   * "next number" is a number a client would use.
   */
  @Get('document-sequences')
  @phase4Permission('sales.view')
  async sequences(@Membership() m: MembershipContext, @Query() query: unknown): Promise<DocumentSequenceListDto> {
    return this.reads.sequences(m, DocumentSequenceQuerySchema.parse(query));
  }
}
