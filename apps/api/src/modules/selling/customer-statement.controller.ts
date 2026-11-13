import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { CustomerStatementDto } from '@daftar/shared-contracts';
import { Membership } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { strictUuidParam } from '../inventory/canonical-id';
import { CustomerStatementQuerySchema, CustomerStatementReadService } from './customer-statement-reads';
import { sellingRefusal } from './selling-errors';
import { phase4Permission } from './selling-permissions';

/**
 * L3 / P4-S1 — `GET /v1/customers/:customerId/statement`, the HTTP reader of
 * `customer_account_statement` (`0092`, owner permit DR-146).
 *
 * ── WHY THIS IS ITS OWN CONTROLLER AND NOT A METHOD ON `CustomersController` ──
 *
 * It would ordinarily belong beside `receivable`, `aging` and `open-invoices`
 * on `CustomersController`, and the route path is deliberately the same family
 * so a merchant sees one coherent surface. It is separate because
 * `customers.controller.ts` is being edited by another lane on a branch that
 * will merge beside this one, and "one writer per file" is not a style
 * preference here: a textual conflict in a controller is resolved by a human
 * choosing a side, and the side not chosen is a route that silently stops
 * existing. A new file cannot be resolved that way. Both compositions
 * register both controllers, so the merchant surface is identical either way.
 *
 * ── THE AUTHORITY, AND WHY IT IS THE RECEIVABLE'S AND NOT THE CUSTOMER'S ──
 *
 * `receivables.view`, through this module's own `phase4Permission` decorator,
 * exactly as `@Get(':customerId/receivable/aging')` declares it — the guard
 * runs BEFORE the query is parsed, so a caller without the key never reaches
 * a statement, a cursor or a database.
 *
 * AND business-wide branch scope with it, the
 * `GET /v1/customers/:id/receivable` rule (`customers.controller.ts:71-77`,
 * `suppliers.controller.ts:139-146`). This is the one judgement call the
 * design did not state for me, and it is made in the conservative direction
 * with its reason: the statement's debit side is EVERY open credit invoice of
 * the customer, across every branch of the business, and its running balance
 * is a business-wide figure. An actor scoped to one branch who read it would
 * be reading money from branches it has no authority over — and would read it
 * as a TOTAL, with nothing on the row saying which branch it came from. The
 * rejected alternative was `receivables.view` alone, which is the narrower
 * change; it was rejected because the error direction of the narrower choice
 * is a disclosure, and of this choice is a refusal the merchant can see and
 * ask about. `assertBusinessWide`'s logic is duplicated here rather than
 * imported, because importing it would mean exporting it from the file the
 * other lane is editing.
 */
@Controller('/v1/customers')
export class CustomerStatementController {
  constructor(@Inject(CustomerStatementReadService) private readonly reads: CustomerStatementReadService) {}

  /**
   * One keyset page of the customer's account statement, running balance
   * included. Requires `receivables.view` AND business-wide branch scope.
   *
   * `limit` and `cursor` decide WHICH ROWS arrive and nothing else. The
   * running balance on a row is computed by a window inside the reader over
   * the customer's whole ordered set, so no page size can change it; a client
   * must never re-sum a page to derive a balance (`P4-AL-07`).
   */
  @Get(':customerId/statement')
  @phase4Permission('receivables.view')
  async statement(@Membership() m: MembershipContext, @Param('customerId') customerId: string, @Query() query: unknown): Promise<CustomerStatementDto> {
    const id = strictUuidParam(customerId, 'customerId');
    this.assertBusinessWide(m);
    return this.reads.statement(m, id, CustomerStatementQuerySchema.parse(query));
  }

  /**
   * The business-wide scope rule, with this module's own typed code so the
   * merchant reads a localized sentence about branch access rather than an
   * inventory refusal borrowed from another domain.
   */
  private assertBusinessWide(m: MembershipContext): void {
    if (m.branchScopeMode !== 'all') throw sellingRefusal('customer.business_wide_scope_required');
  }
}
