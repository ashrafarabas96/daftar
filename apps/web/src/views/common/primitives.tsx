/**
 * Shared presentational pieces of the purchasing and supplier screens
 * (P3-S7 contract A-11, A-16). Pure: they receive text and data, never the
 * client and never `next/*`, so the SSR suites can render them.
 *
 * Layout law (A-16): one column, logical properties only, no fixed width,
 * every number, amount, date and currency code inside `<bdi dir="ltr">`.
 */
import type { ReactNode } from 'react';
import { colors, radius, spacing, typography } from '@daftar/design-system';
import type { Locale } from '@/lib/i18n';
import { Ltr, formatMoney, formatQty } from '@/lib/phase3-format';

type Gap = 1 | 2 | 3 | 4 | 6;

/** An amount the server computed, as the locale shows money (A-17: display only, never arithmetic). */
export function Money(props: { amountMinor: string; currency: string; locale: Locale }) {
  return <Ltr>{formatMoney(props.amountMinor, props.currency, props.locale)}</Ltr>;
}

/** A quantity the server returned, re-spelled at the unit's decimals. */
export function Quantity(props: { value: string; decimals: number; locale: Locale }) {
  return <Ltr>{formatQty(props.value, props.decimals, props.locale)}</Ltr>;
}

/** A civil date (`YYYY-MM-DD`) in the locale's words, Western digits. */
export function CivilDate(props: { iso: string; locale: Locale }) {
  const at = new Date(`${props.iso.slice(0, 10)}T00:00:00Z`);
  const text = Number.isNaN(at.getTime())
    ? props.iso
    : new Intl.DateTimeFormat(`${props.locale}-u-nu-latn`, { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
  return <Ltr>{text}</Ltr>;
}

/** A currency code, isolated left-to-right. */
export function Code(props: { children: string }) {
  return <Ltr>{props.children}</Ltr>;
}

/** A vertical stack: the one-column phone layout. */
export function Stack(props: { gap?: Gap; children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[props.gap ?? 4], minWidth: 0 }}>{props.children}</div>;
}

/** Inline pieces that wrap onto the next line on a phone. */
export function Inline(props: { gap?: Gap; children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacing[props.gap ?? 2] }}>{props.children}</div>;
}

/** Two or more blocks side by side on a wide screen, one column at 360px, with no media query (A-16(1)). */
export function Columns(props: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: spacing[4] }}>{props.children}</div>;
}

/** The screen title. */
export function Title(props: { children: ReactNode }) {
  return <h1 style={{ margin: 0, fontSize: typography.size.xl, fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{props.children}</h1>;
}

/** A section heading inside a screen. */
export function Heading(props: { children: ReactNode }) {
  return <h2 style={{ margin: 0, fontSize: typography.size.lg, fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{props.children}</h2>;
}

/** Secondary text. */
export function Muted(props: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: typography.size.sm, fontFamily: typography.fontFamily.base, color: colors.neutral[600] }}>{props.children}</p>;
}

/** Body text. */
export function Text(props: { children: ReactNode; strong?: boolean }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: typography.size.md,
        fontFamily: typography.fontFamily.base,
        color: colors.neutral[900],
        fontWeight: props.strong ? typography.weight.semibold : typography.weight.regular,
      }}
    >
      {props.children}
    </p>
  );
}

const NOTICE_TONES = {
  info: { background: colors.semantic.infoSoft, color: colors.neutral[900], border: colors.semantic.info },
  success: { background: colors.semantic.successSoft, color: colors.neutral[900], border: colors.semantic.success },
  warning: { background: colors.semantic.warningSoft, color: colors.neutral[900], border: colors.semantic.warning },
  danger: { background: colors.semantic.dangerSoft, color: colors.neutral[900], border: colors.semantic.danger },
} as const;

/** A message in the flow of the page: a refusal, a result, a hint. A refusal is announced (`role="alert"`). */
export function Notice(props: { tone: keyof typeof NOTICE_TONES; children: ReactNode }) {
  const tone = NOTICE_TONES[props.tone];
  return (
    <div
      role={props.tone === 'danger' ? 'alert' : 'status'}
      style={{
        background: tone.background,
        color: tone.color,
        borderInlineStart: `4px solid ${tone.border}`,
        borderRadius: radius.md,
        padding: spacing[3],
        fontFamily: typography.fontFamily.base,
        fontSize: typography.size.md,
      }}
    >
      {props.children}
    </div>
  );
}

/** A bordered block for one stacked editor card (a line, an extra cost, an open purchase). */
export function Panel(props: { children: ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${colors.neutral[200]}`,
        borderRadius: radius.lg,
        padding: spacing[3],
        display: 'flex',
        flexDirection: 'column',
        gap: spacing[3],
        minWidth: 0,
      }}
    >
      {props.children}
    </div>
  );
}

/** One label–value pair of a summary, stacked so a long Turkish or Arabic label never pushes the value off a phone. */
export function Fact(props: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing[2], fontFamily: typography.fontFamily.base }}>
      <span style={{ color: colors.neutral[600], fontSize: typography.size.sm }}>{props.label}</span>
      <span style={{ color: colors.neutral[900], fontSize: typography.size.md, fontWeight: typography.weight.medium }}>{props.children}</span>
    </div>
  );
}

/** Several per-currency amounts on one line (a supplier's balance can be in more than one currency). */
export function Amounts(props: { amounts: readonly { currency: string; amountMinor: string }[]; locale: Locale }) {
  return (
    <Inline gap={2}>
      {props.amounts.map((a) => (
        <span key={a.currency}>
          <Money amountMinor={a.amountMinor} currency={a.currency} locale={props.locale} />
        </span>
      ))}
    </Inline>
  );
}
