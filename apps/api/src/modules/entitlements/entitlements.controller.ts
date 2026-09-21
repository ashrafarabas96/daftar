import { Controller, Get, Inject } from '@nestjs/common';
import type { EntitlementSummaryDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { RequiresPermission, Membership } from '../../common/guards';
import { EntitlementService, type LimitKey } from './entitlements.service';
import type { MembershipContext } from '../tenancy/tenancy.service';

const LIMIT_KEYS: LimitKey[] = ['MAX_USERS', 'MAX_BRANCHES', 'MAX_PRODUCTS', 'MAX_STORAGE'];

/** Read-only plan/usage summary for the merchant (subscription.view). */
@Controller('/v1/businesses/current/entitlement')
export class EntitlementsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
  ) {}

  @Get()
  @RequiresPermission('subscription.view')
  async summary(@Membership() m: MembershipContext): Promise<EntitlementSummaryDto> {
    return this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const state = await this.entitlements.getState(c, m.businessId);
      const features = (
        await c.query<{ key: string }>('SELECT key FROM features ORDER BY key')
      ).rows;
      const limits: EntitlementSummaryDto['limits'] = [];
      for (const key of LIMIT_KEYS) {
        limits.push({
          key,
          limit: await this.entitlements.getLimit(c, m.businessId, key),
          usage: await this.entitlements.getUsage(c, m.businessId, key),
        });
      }
      const featureList: EntitlementSummaryDto['features'] = [];
      for (const f of features) {
        featureList.push({ key: f.key, enabled: await this.entitlements.hasFeature(c, m.businessId, f.key) });
      }
      return {
        planKey: state.planKey, planVersion: state.planVersion, state: state.state,
        effectiveState: state.effectiveState, trialEndsAt: state.trialEndsAt,
        periodEndsAt: state.periodEndsAt, features: featureList, limits,
      };
    });
  }
}
