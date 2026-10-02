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
import type { PosBasketDto } from '@/lib/phase4-pos-api';
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

/** An item's name and its option, stacked; merchant-typed names are isolated. */
export function PosItemName(props: { name: string; variantName: string | null }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column' }}>
      <bdi>{props.name}</bdi>
      {props.variantName !== null ? <bdi style={{ color: colors.neutral[500], fontSize: typography.size.sm }}>{props.variantName}</bdi> : null}
    </span>
  );
}

/**
 * The three amounts of a basket or a finished sale, exactly as the server sent
 * them: what the items come to, the discount the server allowed, and what is
 * left to pay. The screen displays three separate server fields; it does not
 * derive one from the others.
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
export function BasketTotals(props: { t: Translate; locale: Locale; basket: PosBasketDto }) {
  const { basket } = props;
  return (
    <PosTotals
      t={props.t}
      locale={props.locale}
      currency={basket.currency}
      subtotalMinor={basket.subtotalMinor}
      discountMinor={basket.discountMinor}
      totalMinor={basket.totalMinor}
    />
  );
}
