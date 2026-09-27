/**
 * The building blocks the stock screens share (P3-S7 A-11, A-16). Pure: text
 * comes from `t`, data from props; nothing imports `next/*` or the client.
 *
 * Layout law (A-16): one column by default, a grid that collapses at 360px,
 * logical properties only, design-system controls at their full touch size,
 * every number inside `<bdi dir="ltr">`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Badge, Button, Card, List, SearchField, Select, TextField, colors, spacing, typography } from '@daftar/design-system';
import type { InventoryWarehouseDto } from '@/lib/phase3-api';
import { Ltr, formatQty, isZeroQuantityText, rich, unsignedQty, type Translate, type ViewBaseProps } from '@/lib/phase3-format';
import type { Locale } from '@/lib/i18n';
import { PageStateView, type PageStatus } from '../common/feedback';
import { Notice as SharedNotice } from '../common/primitives';
import { isNegativeText, trimQtyText, type DraftLine, type PickOption } from './model';

/** A grid that is one column at phone width and more when there is room (A-16(1)). */
export const AUTO_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
  gap: spacing[3],
};

/** A vertical stack. */
export const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: spacing[4] };

export function ScreenTitle(props: { children: ReactNode }) {
  return <h1 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.xl, margin: 0 }}>{props.children}</h1>;
}

export function SectionTitle(props: { children: ReactNode }) {
  return <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, margin: 0 }}>{props.children}</h2>;
}

/** Secondary text under a field or a section. */
export function Hint(props: { children: ReactNode }) {
  return <p style={{ margin: 0, color: colors.neutral[500], fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>{props.children}</p>;
}

const NOTICE_TONE = { error: 'danger', success: 'success', info: 'info' } as const;

/** A server answer or a refusal, as text the catalog holds (A-15(d)) — the one Notice of every S7 screen (N-1). */
export function Notice(props: { tone: keyof typeof NOTICE_TONE; children: ReactNode }) {
  return <SharedNotice tone={NOTICE_TONE[props.tone]}>{props.children}</SharedNotice>;
}

/** A wrapping row of actions; on a phone each action takes its own row. */
export function ActionRow(props: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[2] }}>{props.children}</div>;
}

/** A page that cannot show its screen: loading, no permission, or a failed load (§3(b)) — the shared page state (N-1, m-8). */
export function ScreenState(props: ViewBaseProps & { state: PageStatus; onRetry?: () => void }) {
  return <PageStateView t={props.t} locale={props.locale} status={props.state} onRetry={props.onRetry ?? (() => undefined)} />;
}

/** The unit's name in the merchant's language, or its code. */
export function unitLabel(unitCode: string | null, unitNames: Readonly<Record<string, string>>): string {
  if (unitCode === null) return '';
  return unitNames[unitCode] ?? unitCode;
}

/** A quantity, re-spelled at the unit's precision, isolated left-to-right. */
export function Qty(props: { value: string; decimals: number; locale: Locale }) {
  return <Ltr>{formatQty(trimQtyText(props.value, props.decimals), props.decimals, props.locale)}</Ltr>;
}

/**
 * An on-hand quantity as the merchant reads it: a figure, "Out of stock" at
 * zero, and "Short by {qty}" below zero (A-07; the word "deficit" is never used).
 */
export function OnHand(props: { t: Translate; locale: Locale; value: string; decimals: number }) {
  const { t, value, decimals, locale } = props;
  if (isNegativeText(value)) {
    return (
      <Badge tone="danger">
        <span>{rich(t('stock.levels.shortBy'), { qty: <Qty value={unsignedQty(value)} decimals={decimals} locale={locale} /> })}</span>
      </Badge>
    );
  }
  if (isZeroQuantityText(value.trim())) return <Badge tone="neutral">{t('stock.levels.outOfStock')}</Badge>;
  return (
    <strong style={{ fontFamily: typography.fontFamily.base }}>
      <Qty value={value} decimals={decimals} locale={locale} />
    </strong>
  );
}

/** Warehouses a picker may offer: active ones only (A-05, A-18). */
export function warehouseOptions(t: Translate, warehouses: readonly InventoryWarehouseDto[], exclude?: string): { value: string; label: string }[] {
  return [
    { value: '', label: t('stock.common.chooseWarehouse') },
    ...warehouses.filter((w) => w.status === 'active' && w.warehouseId !== exclude).map((w) => ({ value: w.warehouseId, label: w.name })),
  ];
}

export function WarehouseSelect(props: {
  t: Translate;
  label: string;
  warehouses: readonly InventoryWarehouseDto[];
  value: string;
  exclude?: string;
  disabled?: boolean;
  onChange: (warehouseId: string) => void;
}) {
  return (
    <Select
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      options={warehouseOptions(props.t, props.warehouses, props.exclude)}
      onChange={props.onChange}
    />
  );
}

/** The item and its option, as two lines of text. Merchant-typed names are isolated (`<bdi>`): they may mix scripts and digits. */
export function ItemName(props: { name: string; variantName: string | null }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column' }}>
      <bdi>{props.name}</bdi>
      {props.variantName !== null ? <bdi style={{ color: colors.neutral[500], fontSize: typography.size.sm }}>{props.variantName}</bdi> : null}
    </span>
  );
}

/**
 * Search the items and add one to the form. `onHand` is shown only when the
 * option carries it (it never does on Count Stock, TL-8).
 */
export function ItemPicker(
  props: ViewBaseProps & {
    search: string;
    options: readonly PickOption[] | null;
    added: ReadonlySet<string>;
    unitNames: Readonly<Record<string, string>>;
    disabled?: boolean;
    onSearch: (text: string) => void;
    onPick: (option: PickOption) => void;
  },
) {
  const { t, locale } = props;
  return (
    <div style={STACK}>
      <SearchField
        label={t('stock.picker.search')}
        placeholder={t('stock.picker.placeholder')}
        value={props.search}
        disabled={props.disabled}
        onChange={props.onSearch}
      />
      {props.options === null ? null : props.options.length === 0 ? (
        <Hint>{t('common.noResults')}</Hint>
      ) : (
        <List
          items={props.options.map((o) => ({
            key: o.key,
            primary: <ItemName name={o.name} variantName={o.variantName} />,
            secondary:
              o.onHand === null ? (
                unitLabel(o.unitCode, props.unitNames)
              ) : (
                <span style={{ display: 'inline-flex', gap: spacing[2], alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{t('stock.picker.here')}</span>
                  <OnHand t={t} locale={locale} value={o.onHand} decimals={o.unitDecimals} />
                  <span>{unitLabel(o.unitCode, props.unitNames)}</span>
                </span>
              ),
            trailing: props.added.has(o.key) ? (
              <Badge tone="brand">{t('stock.picker.added')}</Badge>
            ) : (
              <Button variant="secondary" disabled={props.disabled} onClick={() => props.onPick(o)}>
                {t('common.add')}
              </Button>
            ),
          }))}
        />
      )}
    </div>
  );
}

/**
 * One form line, stacked (A-16(6)): the item, the quantity, and the cost per
 * unit when the screen or the server asks for it (A-13).
 */
export function LineCard(
  props: ViewBaseProps & {
    line: DraftLine;
    unitNames: Readonly<Record<string, string>>;
    quantityLabel: string;
    showCost: boolean;
    currency: string | null;
    errorKey?: string | null;
    disabled?: boolean;
    onQuantity: (value: string) => void;
    onCost: (value: string) => void;
    onRemove: () => void;
  },
) {
  const { t, locale, line } = props;
  const unit = unitLabel(line.unitCode, props.unitNames);
  return (
    <Card>
      <div style={STACK}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing[2], flexWrap: 'wrap' }}>
          <strong style={{ fontFamily: typography.fontFamily.base }}>
            <ItemName name={line.name} variantName={line.variantName} />
          </strong>
          <Button variant="ghost" disabled={props.disabled} onClick={props.onRemove}>
            {t('common.remove')}
          </Button>
        </div>
        {line.onHand !== null ? (
          <Hint>
            <span style={{ display: 'inline-flex', gap: spacing[2], alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{t('stock.picker.here')}</span>
              <OnHand t={t} locale={locale} value={line.onHand} decimals={line.unitDecimals} />
              <span>{unit}</span>
            </span>
          </Hint>
        ) : null}
        <TextField
          label={props.quantityLabel}
          hint={unit.length > 0 ? t('stock.line.unit', { unit }) : undefined}
          inputMode="decimal"
          value={line.quantity}
          disabled={props.disabled}
          error={props.errorKey ? t(props.errorKey) : undefined}
          onChange={props.onQuantity}
        />
        {props.showCost ? (
          <TextField
            label={t('stock.line.costPerUnit', { currency: props.currency ?? '' })}
            hint={t('stock.line.costHint')}
            inputMode="decimal"
            value={line.unitCost}
            disabled={props.disabled}
            onChange={props.onCost}
          />
        ) : null}
      </div>
    </Card>
  );
}
