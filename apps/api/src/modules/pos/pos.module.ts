import type { Provider } from '@nestjs/common';
import { PosCartService } from './pos-cart.service';
import { PosCheckoutService } from './pos-checkout.service';
import { PosReadService } from './pos-reads';
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
 * is a route that cannot be tested. The three controllers this slice owns —
 * `TillSessionsController`, `PosReadsController` and `PosCartController` — are
 * therefore registered in BOTH compositions' own `controllers` lists, beside
 * this function in the `providers` list, and `P4_S3_REQUIRED_CONTROLLERS`
 * (`pos-permissions.ts`) names every one of them.
 *
 * That list is checked from BOTH SIDES, which is the only thing that makes it
 * evidence rather than a description of itself: it is asserted EQUAL to the
 * controllers DISCOVERED in this directory, and every name is required to
 * appear in both composition sources. A controller added here and not listed
 * is red; a name listed and not built is red; a name built, listed and
 * composed in only one process is red. And the routes themselves are driven
 * over real HTTP through `createTestApp()` by
 * `tests/security/phase4-route-surface.test.ts` and the G-02 cross-tenant
 * golden, so the mount is proved by a request and not by a list.
 *
 * ## What each service needs, and why that decides the composition
 *
 *   - `TillSessionService` needs `Database` and `InventoryAuthorizationService`:
 *     `daftar_app` holds `SELECT` only on both POS relations (`0079:605`), so
 *     every write goes through a `SECURITY DEFINER` routine consuming an
 *     `invctl/1` assertion, and the service AUTHORIZES and MINTS rather than
 *     issuing SQL. It needs no posting capability and no accounting assertion,
 *     because P4-S3 creates no accounting object at all.
 *   - `PosReadService` needs `Database` alone. It is a read: it writes
 *     nothing, caches nothing and derives the till's warehouse from the
 *     session on every call.
 *   - `PosCartService` needs `Database`, `InventoryAuthorizationService` and
 *     `'LOGGER'`. Both compositions already provide all three
 *     (`app.module.ts`, `merchant-api.module.ts`, `runtime.ts:126`), which is
 *     why the cart needs no new provider of its own.
 *   - `PosCheckoutService` needs `Database`, `InventoryAuthorizationService`
 *     and `SaleCommitService` (TL-P4-S3-R1). The third is the point: the ONE
 *     sale writer is INJECTED rather than reimplemented, which is what makes
 *     an atomic checkout an orchestration of the accepted primitive instead of
 *     a second financial writer. Both compositions spread `sellingProviders()`
 *     BEFORE `posProviders()` (`app.module.ts:150`,
 *     `merchant-api.module.ts:138`), so the dependency resolves in both
 *     processes.
 */
export function posProviders(): Provider[] {
  return [TillSessionService, PosReadService, PosCartService, PosCheckoutService];
}
