import { Body, Controller, Inject, Param, Put, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { newBusinessTransactionId } from './business-transaction';
import { canonicalUuidParam } from './canonical-id';
import { InventoryConfigurationSchema, type InventoryConfigurationInput } from './inventory-configuration.schemas';
import { InventoryConfigurationService, type InventoryConfigurationResult } from './inventory-configuration.service';

/**
 * Merchant inventory configuration (P3-AL-04, P3-AL-05, P3-AL-55 §I).
 *
 * The route guard requires `inventory.adjust` before the body is even parsed,
 * so a member without it is refused before the service — and therefore the
 * minter — is reached. The trace id of the operation is minted here, at the
 * API boundary, once (P3-AL-35).
 */
@Controller('/v1/inventory')
export class InventoryConfigurationController {
  constructor(@Inject(InventoryConfigurationService) private readonly configuration: InventoryConfigurationService) {}

  @Put('products/:productId/configuration')
  @RequiresPermission('inventory.adjust')
  @UsePipes(new ZodValidationPipe(InventoryConfigurationSchema))
  async configureProduct(
    @Membership() m: MembershipContext,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<InventoryConfigurationResult> {
    return this.configuration.configureProduct(m, canonicalUuidParam(productId, 'productId'), body as InventoryConfigurationInput, newBusinessTransactionId());
  }
}
