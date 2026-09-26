import { Body, Controller, HttpCode, Inject, Param, Post, Put, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import type {
  InventoryMovementDocumentDto,
  InventoryOpeningDto,
  InventoryStocktakeCloseDto,
  InventoryStocktakeCountDto,
  InventoryStocktakeDto,
} from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from './business-transaction';
import { strictUuidParam } from './canonical-id';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import {
  AdjustmentSchema,
  DamageSchema,
  OpeningSchema,
  StocktakeCancelSchema,
  StocktakeCountSchema,
  StocktakeFinalizeSchema,
  StocktakeOpenSchema,
  TransferSchema,
  type AdjustmentRequest,
  type DamageRequest,
  type OpeningRequest,
  type StocktakeCountRequest,
  type StocktakeFinalizeRequest,
  type StocktakeOpenRequest,
  type TransferRequest,
} from './inventory-movements.schemas';
import { InventoryOpeningService } from './inventory-opening.service';
import { InventoryStocktakeService } from './inventory-stocktake.service';
import { InventoryTransferService } from './inventory-transfer.service';

/**
 * The P3-S3 stock movement commands (PHASE_3_S3_CONTRACT A-21): transfers,
 * adjustments, damage, stocktakes and the inventory opening.
 *
 * The controller holds no business logic. For every route:
 *
 * - the route guard requires the permission before the body is even parsed,
 *   so a member without it never reaches the service (and so never the
 *   minter); the service then authorizes the op code over EVERY affected
 *   warehouse (A-10(c) steps 1–4);
 * - the strict DTO is validated by the pipe (`ZodValidationPipe` parses
 *   the body and hands on the parsed value), and path ids are canonical
 *   UUIDs;
 * - the trace id is minted here, once, at the API boundary (P3-AL-35);
 * - the client-chosen document id is the idempotency key, and it is passed on
 *   untouched: the service proves a replay before it reads any state, and a
 *   replay is not a creation, so it answers 200 instead of 201 (§54).
 *
 * Refusals leave the services already typed (`inventory.*` as an `AppError`
 * carrying `details.inventoryCode`; `accounting.*` as an `AccountingError`),
 * and the global error filter renders them. Nothing is caught here.
 */
@Controller('/v1/inventory')
export class InventoryMovementsController {
  constructor(
    @Inject(InventoryTransferService) private readonly transfers: InventoryTransferService,
    @Inject(InventoryAdjustmentService) private readonly adjustments: InventoryAdjustmentService,
    @Inject(InventoryStocktakeService) private readonly stocktakes: InventoryStocktakeService,
    @Inject(InventoryOpeningService) private readonly openings: InventoryOpeningService,
  ) {}

  /** Moves stock between two warehouses of the business. No journal (L:537). */
  @Post('transfers')
  @RequiresPermission('inventory.transfer')
  @UsePipes(new ZodValidationPipe(TransferSchema))
  async transfer(
    @Membership() m: MembershipContext,
    @Body() body: TransferRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InventoryMovementDocumentDto> {
    const result = await this.transfers.transfer(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** A reasoned stock correction with signed quantities (A-12). */
  @Post('adjustments')
  @RequiresPermission('inventory.adjust')
  @UsePipes(new ZodValidationPipe(AdjustmentSchema))
  async adjust(
    @Membership() m: MembershipContext,
    @Body() body: AdjustmentRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InventoryMovementDocumentDto> {
    const result = await this.adjustments.adjust(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** Writes off damaged stock (A-12). The same permission as an adjustment (A-21). */
  @Post('damages')
  @RequiresPermission('inventory.adjust')
  @UsePipes(new ZodValidationPipe(DamageSchema))
  async damage(
    @Membership() m: MembershipContext,
    @Body() body: DamageRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InventoryMovementDocumentDto> {
    const result = await this.adjustments.damage(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** Opens a draft stocktake on one warehouse (A-11). */
  @Post('stocktakes')
  @RequiresPermission('inventory.stocktake')
  @UsePipes(new ZodValidationPipe(StocktakeOpenSchema))
  async openStocktake(
    @Membership() m: MembershipContext,
    @Body() body: StocktakeOpenRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InventoryStocktakeDto> {
    const result = await this.stocktakes.open(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  /** Captures counted quantities; an idempotent upsert per line (A-10(g)). */
  @Put('stocktakes/:stocktakeId/counts')
  @RequiresPermission('inventory.stocktake')
  @UsePipes(new ZodValidationPipe(StocktakeCountSchema))
  async countStocktake(
    @Membership() m: MembershipContext,
    @Param('stocktakeId') stocktakeId: string,
    @Body() body: StocktakeCountRequest,
  ): Promise<InventoryStocktakeCountDto> {
    return this.stocktakes.count(m, strictUuidParam(stocktakeId, 'stocktakeId'), body, newBusinessTransactionId());
  }

  /** Closes the draft as `finalized`: the variances move and post (A-11). */
  @Post('stocktakes/:stocktakeId/finalize')
  @HttpCode(200)
  @RequiresPermission('inventory.stocktake')
  @UsePipes(new ZodValidationPipe(StocktakeFinalizeSchema))
  async finalizeStocktake(
    @Membership() m: MembershipContext,
    @Param('stocktakeId') stocktakeId: string,
    @Body() body: StocktakeFinalizeRequest,
  ): Promise<InventoryStocktakeCloseDto> {
    return this.stocktakes.finalize(m, strictUuidParam(stocktakeId, 'stocktakeId'), body, newBusinessTransactionId());
  }

  /** Closes the draft as `cancelled`: nothing moves (A-11, TL-3). */
  @Post('stocktakes/:stocktakeId/cancel')
  @HttpCode(200)
  @RequiresPermission('inventory.stocktake')
  @UsePipes(new ZodValidationPipe(StocktakeCancelSchema))
  async cancelStocktake(
    @Membership() m: MembershipContext,
    @Param('stocktakeId') stocktakeId: string,
    // Validated as empty (unknown keys are refused) and otherwise unused.
    @Body() _body: unknown,
  ): Promise<InventoryStocktakeCloseDto> {
    return this.stocktakes.cancel(m, strictUuidParam(stocktakeId, 'stocktakeId'), newBusinessTransactionId());
  }

  /** Records the business's opening stock over every warehouse it names (A-13). */
  @Post('openings')
  @RequiresPermission('inventory.adjust')
  @UsePipes(new ZodValidationPipe(OpeningSchema))
  async recordOpening(
    @Membership() m: MembershipContext,
    @Body() body: OpeningRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InventoryOpeningDto> {
    const result = await this.openings.record(m, body, newBusinessTransactionId());
    res.status(result.replayed ? 200 : 201);
    return result;
  }
}
