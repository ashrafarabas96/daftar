import type { Provider } from '@nestjs/common';
import { TillSessionService } from './till-session.service';

/**
 * The P4-S3 POS providers, as the two merchant compositions spread them.
 *
 * It is deliberately NOT a Nest `@Module` imported by the compositions, for
 * the reason `sellingProviders()` and `purchasingProviders()` both document:
 * these services depend on providers composed inline by `AppModule` and
 * `MerchantApiModule`, and a child module's controllers would not appear in
 * the composition's own `controllers` list — which
 * `tests/integration/process-composition.test.ts` holds both processes to.
 *
 * DAFTAR composes Nest twice, and a controller registered in only one of them
 * is a route that cannot be tested. The controller wiring P4-S3 owes both
 * compositions is STATED in `P4_S3_REQUIRED_CONTROLLERS`
 * (`pos-permissions.ts`) and reported rather than made, because those two
 * files are outside this module's ownership.
 *
 * `TillSessionService` needs only `Database` and `AuditService`, both of which
 * each composition already provides. It needs no posting capability and no
 * accounting assertion, because P4-S3 creates no accounting object at all.
 */
export function posProviders(): Provider[] {
  return [TillSessionService];
}
