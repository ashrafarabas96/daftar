/**
 * The pieces the two POS screens share (P4-S3), in the idiom of the Phase 3
 * screens: pure, text from `t`, data from props, nothing from `next/*` and
 * nothing from the client.
 *
 * Layout law (the Phase 3 contract's A-16, unchanged here): one column,
 * logical properties only, no fixed width, design-system controls at their
 * full touch size, and every number, amount and date inside `<bdi dir="ltr">`.
 *
 * AMOUNTS: every amount below is a field of a SERVER answer, re-spelled by
 * `Money` (integer minor units → the locale's money text). Nothing here adds,
 * multiplies or rounds.
 */
import type { CSSProperties, ReactNode } from 'react';
import { colors, spacing, typography } from '@daftar/design-system';
import type { Locale } from '@/lib/i18n';
import type { Translate } from '@/lib/phase3-format';
import type { PosCartDto } from '@/lib/phase4-pos-api';
import { Fact, Money, Stack } from '../common/primitives';

/** A grid that is one column at phone width and more when there is room. */
export const POS_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
  gap: spacing[3],
};

/** A vertical stack, the POS screens' default. */
export const POS_STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: spacing[4] };

/** Secondary text under a field or a section. */
export function PosHint(props: { children: ReactNode }) {
  return <p style={{ margin: 0, color: colors.neutral[500], fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>{props.children}</p>;
}

/**
 * An item's name and, where the answer carries one, its option, stacked;
 * merchant-typed names are isolated.
 *
 * `variantName` is `null` on a basket line and on a sale line and always will
 * be: `CartDto`'s line carries `name` alone (the server's snapshot) and
 * `SaleLineDto` carries `nameSnapshot` alone. Only the type-ahead's
 * `PosProductHitDto` has a variant name, so only the search list passes one.
 */
export function PosItemName(props: { name: string; variantName?: string | null }) {
  const variant = props.variantName ?? null;
  return (
    <span style={{ display: 'flex', flexDirection: 'column' }}>
      <bdi>{props.name}</bdi>
      {variant !== null ? <bdi style={{ color: colors.neutral[500], fontSize: typography.size.sm }}>{variant}</bdi> : null}
    </span>
  );
}

/**
 * The three amounts of a basket or a finished sale, exactly as the server sent
 * them: what the items come to, the discount the server allowed, and what is
 * left to pay. The screen displays three separate server fields; it does not
 * derive one from the others.
 *
 * There is no tax row. `CartDto.taxMinor` and `SaleDto.taxMinor` are reported
 * and are structurally zero (`P4-AL-44`, `OD-03` OPEN); a row reading
 * "Tax 0.00" would state a tax policy that does not exist yet, so the screen
 * states none and nothing here computes one.
 */
export function PosTotals(props: { t: Translate; locale: Locale; currency: string; subtotalMinor: string; discountMinor: string; totalMinor: string }) {
  const { t, locale, currency } = props;
  return (
    <Stack gap={2}>
      <Fact label={t('pos.total.items')}>
        <Money amountMinor={props.subtotalMinor} currency={currency} locale={locale} />
      </Fact>
      <Fact label={t('pos.total.discount')}>
        <Money amountMinor={props.discountMinor} currency={currency} locale={locale} />
      </Fact>
      <Fact label={t('pos.total.due')}>
        <Money amountMinor={props.totalMinor} currency={currency} locale={locale} />
      </Fact>
    </Stack>
  );
}

/** The basket's own totals, for the register screen. */
export function BasketTotals(props: { t: Translate; locale: Locale; cart: PosCartDto }) {
  const { cart } = props;
  return (
    <PosTotals
      t={props.t}
      locale={props.locale}
      currency={cart.currency}
      subtotalMinor={cart.subtotalMinor}
      discountMinor={cart.discountMinor}
      totalMinor={cart.totalMinor}
    />
  );
}
