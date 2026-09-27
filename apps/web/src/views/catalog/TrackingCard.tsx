/**
 * "Track stock" on the product page (P3-S7 A-11, A-06) —
 * `PUT /v1/inventory/products/:productId/configuration`.
 *
 * The command states the end state and answers `changed: false` when it
 * already holds, so a repeat is harmless. While the item holds stock the
 * card says, ahead of time, that turning tracking off or changing the unit
 * needs zero stock; the server stays the authority and its refusal is shown.
 */
import { Button, Card, Checkbox, Select } from '@daftar/design-system';
import type { InventoryItemDto, InventoryUnitDto } from '@/lib/phase3-api';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { Hint, Notice, STACK, SectionTitle } from '../stock/parts';

export interface TrackingCardProps {
  /** The product as the inventory read sees it; null while loading. */
  item: InventoryItemDto | null;
  units: readonly InventoryUnitDto[];
  track: boolean;
  unitCode: string;
  /** '' keeps the unit's own default. */
  decimals: string;
  busy: boolean;
  errorKey: string | null;
  noticeKey: string | null;
  onTrack: (value: boolean) => void;
  onUnit: (unitCode: string) => void;
  onDecimals: (value: string) => void;
  onSave: () => void;
}

const DECIMAL_CHOICES = ['0', '1', '2', '3', '4'] as const;

export function TrackingCard(props: TrackingCardProps & ViewBaseProps) {
  const { t, item } = props;
  if (item === null) {
    return <Card>{props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : <Hint>{t('common.loading')}</Hint>}</Card>;
  }
  return (
    <Card>
      <div style={STACK}>
        <SectionTitle>{t('stock.tracking.title')}</SectionTitle>
        <Hint>{t('stock.tracking.intro')}</Hint>
        <Checkbox label={t('stock.tracking.track')} checked={props.track} disabled={props.busy} onChange={props.onTrack} />
        {props.track ? (
          <>
            <Select
              label={t('stock.tracking.unit')}
              value={props.unitCode}
              disabled={props.busy}
              options={[
                ...(item.unitCode === null ? [{ value: '', label: t('stock.tracking.chooseUnit') }] : []),
                ...props.units.map((u) => ({ value: u.unitCode, label: u.name })),
              ]}
              onChange={props.onUnit}
            />
            <Select
              label={t('stock.tracking.decimals')}
              hint={t('stock.tracking.decimalsHint')}
              value={props.decimals}
              disabled={props.busy}
              options={[{ value: '', label: t('stock.tracking.decimalsDefault') }, ...DECIMAL_CHOICES.map((d) => ({ value: d, label: d }))]}
              onChange={props.onDecimals}
            />
          </>
        ) : null}
        {item.holdsStock ? <Hint>{t('stock.tracking.holdsStock')}</Hint> : null}
        {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
        {props.noticeKey !== null ? <Notice tone="success">{t(props.noticeKey)}</Notice> : null}
        <Button fullWidth loading={props.busy} disabled={props.track && props.unitCode === ''} onClick={props.onSave}>
          {t('stock.tracking.save')}
        </Button>
      </div>
    </Card>
  );
}
