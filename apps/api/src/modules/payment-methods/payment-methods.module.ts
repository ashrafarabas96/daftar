import type { Provider } from '@nestjs/common';
import { PaymentMethodService } from './payment-method.service';

/**
 * The payment-method providers (PHASE_3_S6_CONTRACT §4.3), as the two merchant
 * compositions spread them.
 *
 * Deliberately NOT a Nest `@Module`, for the reason `purchasingProviders`
 * gives: the service depends on providers composed inline by `AppModule` and
 * `MerchantApiModule` (the database, the inventory authorization seam), and a
 * child module's controllers would not appear in the composition's own
 * `controllers` list, which `tests/integration/process-composition.test.ts`
 * holds the two processes to. So both compositions name
 * `PaymentMethodsController` directly and spread these providers.
 */
export function paymentMethodProviders(): Provider[] {
  return [PaymentMethodService];
}
