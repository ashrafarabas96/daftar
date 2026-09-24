import { describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app/app.module';
import { MerchantApiModule } from '../../apps/api/src/app/merchant-api.module';
import { AdminController } from '../../apps/api/src/modules/admin/admin.controller';

/**
 * THE SINGLE-PROCESS COMPOSITION CARRIES THE WHOLE MERCHANT SURFACE.
 *
 * `PROCESS_MODE=all` is what development and every integration test compose.
 * `PROCESS_MODE=merchant-api` is what production runs. When a controller is
 * added to one and not the other, the route silently does not exist in the
 * composition the tests can reach: every contract test written against it
 * answers 404, and the endpoint's first real exercise is in production.
 *
 * That is not hypothetical. The three accounting routes were added to the
 * merchant process alone, so the merchant boundary of P2-S4 — its validation
 * pipe, its permission guard, its date contract — was unreachable from a test
 * until this case existed. This case is what notices next time.
 *
 * The platform and worker surfaces are deliberately NOT symmetric: the single
 * process adds AdminController on purpose, and the separated merchant runtime
 * must never carry it. So the assertion is one-directional — everything the
 * merchant process serves, the single process serves too — plus the one
 * explicit exception, named rather than inferred.
 */

type Ctor = { readonly name: string };

function controllersOf(dynamic: { controllers?: unknown }): readonly string[] {
  const list = (dynamic.controllers ?? []) as readonly Ctor[];
  return list.map((c) => c.name).sort();
}

const OPTIONS = { config: {} as never };

describe('the process compositions agree on the merchant surface', () => {
  const single = controllersOf(AppModule.register(OPTIONS));
  const merchant = controllersOf(MerchantApiModule.register(OPTIONS));

  it('every merchant controller is also composed in the single process', () => {
    const missing = merchant.filter((name) => !single.includes(name));
    expect(missing, 'these routes would exist in production but in no integration test').toEqual([]);
  });

  it('the accounting write surface is composed in both', () => {
    expect(single).toContain('AccountingController');
    expect(merchant).toContain('AccountingController');
  });

  it('the single process adds exactly one controller the merchant process must not have', () => {
    const extra = single.filter((name) => !merchant.includes(name));
    expect(extra).toEqual([AdminController.name]);
  });
});
