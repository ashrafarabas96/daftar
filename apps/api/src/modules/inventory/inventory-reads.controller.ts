import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type {
  InventoryAccessDto,
  InventoryItemDto,
  InventoryStockPageDto,
  InventoryStocktakeDetailDto,
  InventoryStocktakeSummaryDto,
  InventoryUnitsDto,
  InventoryWarehousesDto,
  Page,
} from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { localeOf } from '../../common/locale';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { strictUuidParam } from './canonical-id';
import { InventoryItemsQuerySchema, InventoryReadService, InventoryStockQuerySchema, InventoryStocktakesQuerySchema } from './inventory-reads';

/**
 * The P3-S7 inventory reads (PHASE_3_S7_CONTRACT A-05 … A-08). GET only.
 *
 * The controller holds no business logic:
 *
 * - a route with ONE permission names it on the route guard; a route open to
 *   any of several (warehouses, items, stocktakes) or to every member
 *   (access, units) carries no route permission, so the guard still requires
 *   the `X-Business-Id` membership (the `@Membership()` parameter refuses a
 *   request without one) and the service checks the permission set;
 * - the service re-checks every permission and applies the scope rule;
 * - the query is parsed by its strict schema (`VALIDATION_FAILED` otherwise),
 *   path ids are canonical lowercase UUIDs (`strictUuidParam`), and the
 *   locale names are resolved in comes from `Accept-Language`.
 *
 * `stocktakes` is declared before `stocktakes/:stocktakeId`.
 */
@Controller('/v1/inventory')
export class InventoryReadsController {
  constructor(@Inject(InventoryReadService) private readonly reads: InventoryReadService) {}

  @Get('access')
  access(@Membership() m: MembershipContext): Promise<InventoryAccessDto> {
    return this.reads.access(m);
  }

  @Get('warehouses')
  async warehouses(@Membership() m: MembershipContext): Promise<InventoryWarehousesDto> {
    return this.reads.warehouses(m);
  }

  @Get('items')
  async items(@Membership() m: MembershipContext, @Query() query: unknown, @Req() req: Request): Promise<Page<InventoryItemDto>> {
    return this.reads.items(m, InventoryItemsQuerySchema.parse(query), localeOf(req));
  }

  @Get('units')
  async units(@Membership() m: MembershipContext, @Req() req: Request): Promise<InventoryUnitsDto> {
    return this.reads.units(m, localeOf(req));
  }

  @Get('stock')
  @RequiresPermission('inventory.view')
  async stock(@Membership() m: MembershipContext, @Query() query: unknown, @Req() req: Request): Promise<InventoryStockPageDto> {
    return this.reads.stock(m, InventoryStockQuerySchema.parse(query), localeOf(req));
  }

  @Get('stocktakes')
  async stocktakes(@Membership() m: MembershipContext, @Query() query: unknown): Promise<Page<InventoryStocktakeSummaryDto>> {
    return this.reads.stocktakes(m, InventoryStocktakesQuerySchema.parse(query));
  }

  @Get('stocktakes/:stocktakeId')
  async stocktake(@Membership() m: MembershipContext, @Param('stocktakeId') stocktakeId: string, @Req() req: Request): Promise<InventoryStocktakeDetailDto> {
    return this.reads.stocktake(m, strictUuidParam(stocktakeId, 'stocktakeId'), localeOf(req));
  }
}
