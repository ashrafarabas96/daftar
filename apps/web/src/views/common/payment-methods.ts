/**
 * Payment methods as a picker offers them (P3-S7 Annex R #20, A-18).
 *
 * `GET /v1/payment-methods` answers every method, active and inactive, with
 * its names in all three languages unresolved. The web filters on `isActive`
 * (an inactive method is never offered) and picks the name in the viewer's
 * language, then Arabic, then any; a method with no name at all is called by
 * its kind. The posting account a method carries for accounting roles is
 * never read here.
 */
import type { PaymentMethodDto } from '@daftar/shared-contracts';
import type { Locale } from '@/lib/i18n';
import { pickLocalized, type Translate } from '@/lib/phase3-format';

export interface MethodChoice {
  paymentMethodId: string;
  name: string;
  requiresReference: boolean;
}

/** The active methods, in the business's order, named for the viewer. */
export function activeMethodChoices(methods: readonly PaymentMethodDto[], locale: Locale, t: Translate): MethodChoice[] {
  return methods
    .filter((m) => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => ({
      paymentMethodId: m.paymentMethodId,
      name: pickLocalized(m.names, locale) ?? t(`payments.kind.${m.systemType}`),
      requiresReference: m.requiresReference,
    }));
}
