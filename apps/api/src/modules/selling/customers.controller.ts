import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { CustomerAgingDto, CustomerDto, CustomerOpenInvoicesDto, CustomerPageDto, CustomerReceivableDto } from '@daftar/shared-contracts';
import { Membership } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { strictUuidParam } from '../inventory/canonical-id';
import { CustomerReadService } from './customer-reads';
import { sellingRefusal } from './selling-errors';
import { phase4Permission } from './selling-permissions';
import { CustomerAgingQuerySchema, CustomerListQuerySchema, CustomerOpenInvoicesQuerySchema } from './selling.schemas';

/**
 * The customer READ routes of P4-S1 (lock P4-AL-35, P4-AL-54; `OD-P4-03`
 * OPTION A; `OD-P4-07` OPTION A).
 *
 * The controller holds no business logic, exactly as `SuppliersController` does:
 * the route guard requires the permission before a query is parsed, path ids are
 * canonical lowercase UUIDs (`strictUuidParam`, never lower-cased into
 * acceptance), the query is validated by its own strict schema, and refusals
 * leave the read service already typed. Nothing is caught here.
 *
 * **The customer WRITE routes are absent from this slice and it is deliberate.**
 * `POST /v1/customers`, `PUT /v1/customers/:customerId` and the two lifecycle
 * routes have their full contract (`CustomerCreateRequestDto` and friends) and
 * their validated request schemas (`selling.schemas.ts`), and they are not
 * mounted, because a customer command cannot yet be written without breaking a
 * lock decision:
 *
 * - P4-AL-38 gives `daftar_app` no DML on any Phase 4 table, so the write must
 *   go through a definer routine;
 * - P4-AL-39 requires every Phase 4 definer routine to verify a signed server
 *   decision — "the signed accounting assertion, or the `invctl/1` inventory
 *   assertion, or both" — because `EXECUTE` is reachability and not authority;
 * - the `invctl/1` operation codes are a closed union in `@daftar/inventory`
 *   and a closed table in `apps/api/src/modules/inventory/inventory-authorization.ts`
 *   (`OPERATION_AUTHORITY`, `:24-77`), and a kind absent from the table does not
 *   compile. Both files are outside this agent's ownership.
 *
 * Mounting a write route that reached the database any other way would be the
 * unauthorized writer the lock spent §11 closing. The requirement is stated for
 * the owners of those two files instead; the routes mount unchanged once the
 * four `customer.*` codes exist.
 */
@Controller('/v1/customers')
export class CustomersController {
  constructor(@Inject(CustomerReadService) private readonly reads: CustomerReadService) {}

  /** A keyset page ordered by the merchant's own alphabet. Requires `customers.view`. */
  @Get()
  @phase4Permission('customers.view')
  async list(@Membership() m: MembershipContext, @Query() query: unknown): Promise<CustomerPageDto> {
    return this.reads.list(m, CustomerListQuerySchema.parse(query));
  }

  /** One customer with its contacts. Requires `customers.view`. */
  @Get(':customerId')
  @phase4Permission('customers.view')
  async get(@Membership() m: MembershipContext, @Param('customerId') customerId: string): Promise<CustomerDto> {
    return this.reads.get(m, strictUuidParam(customerId, 'customerId'));
  }

  /**
   * The customer's live AR, derived from the ledger on read. Requires
   * `receivables.view` AND business-wide branch scope: the figure sums across
   * every branch of the business, so an actor limited to some of them is refused
   * before any read, whatever the customer — the accepted
   * `GET /v1/suppliers/:id/payable` rule (`suppliers.controller.ts:139-146`).
   *
   * There is no credit limit in the answer and none behind it (`OD-P4-03`
   * OPTION A), and no revaluation figure (`OD-P4-07` OPTION A).
   */
  @Get(':customerId/receivable')
  @phase4Permission('receivables.view')
  async receivable(@Membership() m: MembershipContext, @Param('customerId') customerId: string): Promise<CustomerReceivableDto> {
    const id = strictUuidParam(customerId, 'customerId');
    this.assertBusinessWide(m);
    return this.reads.receivable(m, id);
  }

  /**
   * The same AR split into the SUPPLIED buckets at the SUPPLIED as-of date.
   * Requires `receivables.view` and business-wide scope.
   *
   * Neither input has a server default: a read whose date the server resolved
   * from its own clock answers a different question either side of local
   * midnight, and the bucket boundaries are a commercial policy the lock does
   * not state and the server may not invent.
   */
  @Get(':customerId/receivable/aging')
  @phase4Permission('receivables.view')
  async aging(@Membership() m: MembershipContext, @Param('customerId') customerId: string, @Query() query: unknown): Promise<CustomerAgingDto> {
    const id = strictUuidParam(customerId, 'customerId');
    this.assertBusinessWide(m);
    return this.reads.aging(m, id, CustomerAgingQuerySchema.parse(query));
  }

  /** The customer's still-outstanding documents, oldest first, for the picker. Requires `receivables.view`. */
  @Get(':customerId/open-invoices')
  @phase4Permission('receivables.view')
  async openInvoices(@Membership() m: MembershipContext, @Param('customerId') customerId: string, @Query() query: unknown): Promise<CustomerOpenInvoicesDto> {
    const id = strictUuidParam(customerId, 'customerId');
    this.assertBusinessWide(m);
    return this.reads.openInvoices(m, id, CustomerOpenInvoicesQuerySchema.parse(query));
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
