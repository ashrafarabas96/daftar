import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { SupplierBalancesPageDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { SupplierBalanceReadService, SupplierBalancesQuerySchema } from './supplier-balance-reads';

/**
 * `GET /v1/supplier-balances` (PHASE_3_S7_CONTRACT A-09(a)): one page of
 * suppliers with what the merchant owes each (per purchase currency) and the
 * balance in the merchant's favour (per note currency), derived live.
 *
 * A top-level path, because `GET /v1/suppliers/:supplierId` would capture
 * `/v1/suppliers/balances` and refuse it as a non-UUID. `suppliers.view` at
 * the route; the service re-checks it and requires business-wide scope (the
 * amounts sum every warehouse). The controller holds no business logic.
 */
@Controller('/v1/supplier-balances')
export class SupplierBalancesController {
  constructor(@Inject(SupplierBalanceReadService) private readonly reads: SupplierBalanceReadService) {}

  @Get()
  @RequiresPermission('suppliers.view')
  async list(@Membership() m: MembershipContext, @Query() query: unknown): Promise<SupplierBalancesPageDto> {
    return this.reads.balances(m, SupplierBalancesQuerySchema.parse(query));
  }
}
