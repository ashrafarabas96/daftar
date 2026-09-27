import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import { AppError, hasPermission } from '@daftar/domain-core';
import type { PaymentMethodDefaultDto, PaymentMethodDefaultsDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The account the SYSTEM uses for each payment-method type
 * (PHASE_3_S7_CONTRACT A-09(e), TL-3): the merchant never chooses an
 * account (L:1309). `other` is never offered. The mapping is S7's own UX
 * rule; S6 accepts any settlement key for any type (S6 A-06, TL-6).
 */
const DEFAULT_ACCOUNT: readonly (readonly [PaymentMethodDefaultDto['systemType'], string])[] = [
  ['cash', 'cash'],
  ['card', 'card_clearing'],
  ['bank_transfer', 'bank'],
  ['wallet', 'wallet_clearing'],
  ['cheque', 'cheque_clearing'],
];

/**
 * The read behind `GET /v1/payment-method-defaults`: for each type, whether
 * its system account exists in the business and is active. No account id
 * leaves the server. Permission-only (`accounting.chart.manage`), like the
 * method commands it feeds (S6 A-03; coordinator ruling on A-09(e)).
 */
@Injectable()
export class PaymentMethodDefaultsReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async defaults(m: MembershipContext): Promise<PaymentMethodDefaultsDto> {
    if (!hasPermission(m.roles, 'accounting.chart.manage')) throw AppError.forbidden('Missing permission: accounting.chart.manage');
    const found = await this.db.scoped<{ system_key: string }>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `SELECT a.system_key FROM accounts a WHERE a.business_id = $1 AND a.system_key = ANY($2::text[]) AND a.is_active`,
      [m.businessId, DEFAULT_ACCOUNT.map(([, key]) => key)],
    );
    const active = found.rows.map((r) => r.system_key);
    return { items: DEFAULT_ACCOUNT.map(([systemType, key]) => ({ systemType, available: active.includes(key) })) };
  }
}

/**
 * `GET /v1/payment-method-defaults` (PHASE_3_S7_CONTRACT A-09(e)). It lets
 * the Pay Supplier screen create the business's first payment method
 * without the merchant choosing an account. The controller holds no
 * business logic.
 */
@Controller('/v1/payment-method-defaults')
export class PaymentMethodDefaultsController {
  constructor(@Inject(PaymentMethodDefaultsReadService) private readonly reads: PaymentMethodDefaultsReadService) {}

  @Get()
  @RequiresPermission('accounting.chart.manage')
  async list(@Membership() m: MembershipContext): Promise<PaymentMethodDefaultsDto> {
    return this.reads.defaults(m);
  }
}
