/**
 * The register (P4-S3): find an item, add it to the basket, ask for a
 * discount, finish the sale.
 *
 * ── WHAT THIS SCREEN BELIEVES ────────────────────────────────────────────
 * Only the server. `basket` is the whole answer of the last accepted basket
 * command, and every amount on screen is one of its fields:
 *
 *   price each   → `basket.lines[i].unitPriceMinor`  (or the search hit's)
 *   line         → `basket.lines[i].lineTotalMinor`
 *   items        → `basket.subtotalMinor`
 *   discount     → `basket.discountMinor`
 *   to pay       → `basket.totalMinor`
 *
 * Nothing is multiplied, added or rounded here, and the screen sends no
 * amount except the ONE the ruling allows: a discount request (`OD-P4-02`,
 * OPTION A — discount only).
 */
import { Button, Card, ConfirmationDialog, List, SearchField, TextField, spacing } from '@daftar/design-system';
import type { ViewBaseProps } from '@/lib/phase3-format';
import type { PosBasketDto, PosSearchHitDto } from '@/lib/phase4-pos-api';
import { Heading, Money, Muted, Notice, Quantity, Stack, Title } from '../common/primitives';
import { RefusalNotice } from '../common/feedback';
import { hasAmount } from './model';
import { BasketTotals, POS_GRID, POS_STACK, PosHint, PosItemName } from './parts';

export interface RegisterViewProps {
  /** False when this user has no open till: the screen sends the cashier to the till instead of selling. */
  tillOpen: boolean;
  search: string;
  /** The hits of the last POS search, or null before one was made. */
  hits: readonly PosSearchHitDto[] | null;
  /** The server's basket, or null while it is being read. */
  basket: PosBasketDto | null;
  /** What the cashier has typed into each line's quantity field, by line id. */
  quantityDrafts: Readonly<Record<string, string>>;
  /** A catalog key per line whose typed quantity is not a quantity of its unit. */
  lineErrors: Readonly<Record<string, string>>;
  discountText: string;
  discountInvalid: boolean;
  confirmingFinish: boolean;
  busy: boolean;
  errorKey: string | null;
  unitNames: Readonly<Record<string, string>>;
  onSearch: (text: string) => void;
  onAdd: (hit: PosSearchHitDto) => void;
  onQuantity: (lineId: string, value: string) => void;
  onRemove: (lineId: string) => void;
  onDiscountText: (value: string) => void;
  onApplyDiscount: () => void;
  onClearDiscount: () => void;
  onAskFinish: () => void;
  onCancelFinish: () => void;
  onFinish: () => void;
  onGoToTill: () => void;
}

export function RegisterView(props: RegisterViewProps & ViewBaseProps) {
  const { t, locale, basket } = props;
  const unitOf = (unitCode: string | null): string => (unitCode === null ? '' : (props.unitNames[unitCode] ?? unitCode));
  const lineError = (lineId: string): string | undefined => {
    const key = props.lineErrors[lineId];
    return key === undefined || key === '' ? undefined : t(key);
  };

  if (!props.tillOpen) {
    return (
      <div style={POS_STACK}>
        <Title>{t('pos.title')}</Title>
        <Notice tone="warning">{t('pos.till.mustOpen')}</Notice>
        <Button fullWidth onClick={props.onGoToTill}>
          {t('pos.till.goToTill')}
        </Button>
      </div>
    );
  }

  const inBasket = new Set((basket?.lines ?? []).map((line) => `${line.productId}:${line.variantId ?? ''}`));
  const lines = basket?.lines ?? [];
  return (
    <div style={POS_STACK}>
      <Title>{t('pos.title')}</Title>
      <Muted>{t('pos.intro')}</Muted>

      <SearchField
        label={t('pos.search.label')}
        placeholder={t('pos.search.placeholder')}
        value={props.search}
        disabled={props.busy}
        onChange={props.onSearch}
      />
      <PosHint>{t('pos.search.hint')}</PosHint>
      {props.hits === null ? null : props.hits.length === 0 ? (
        <PosHint>{t('common.noResults')}</PosHint>
      ) : (
        <List
          items={props.hits.map((hit) => ({
            key: `${hit.productId}:${hit.variantId ?? ''}`,
            primary: <PosItemName name={hit.name} variantName={hit.variantName} />,
            secondary: (
              <span style={{ display: 'inline-flex', gap: spacing[2], alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{t('pos.search.priceEach')}</span>
                <Money amountMinor={hit.unitPriceMinor} currency={hit.currency} locale={locale} />
                {hit.onHand === null ? null : <span>{t('pos.search.here')}</span>}
                {hit.onHand === null ? null : <Quantity value={hit.onHand} decimals={hit.unitDecimals} locale={locale} />}
              </span>
            ),
            trailing: (
              <Button variant="secondary" disabled={props.busy || inBasket.has(`${hit.productId}:${hit.variantId ?? ''}`)} onClick={() => props.onAdd(hit)}>
                {t('common.add')}
              </Button>
            ),
          }))}
        />
      )}

      <Heading>{t('pos.basket.title')}</Heading>
      {basket === null || lines.length === 0 ? <PosHint>{t('pos.basket.empty')}</PosHint> : null}
      {lines.map((line) => (
        <Card key={line.lineId}>
          <Stack gap={3}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing[2], flexWrap: 'wrap' }}>
              <PosItemName name={line.name} variantName={line.variantName} />
              <Button variant="ghost" disabled={props.busy} onClick={() => props.onRemove(line.lineId)}>
                {t('common.remove')}
              </Button>
            </div>
            <TextField
              label={t('pos.basket.quantity')}
              hint={unitOf(line.unitCode).length > 0 ? t('pos.basket.unit', { unit: unitOf(line.unitCode) }) : undefined}
              inputMode="decimal"
              value={props.quantityDrafts[line.lineId] ?? line.quantity}
              disabled={props.busy}
              error={lineError(line.lineId)}
              onChange={(value) => props.onQuantity(line.lineId, value)}
            />
            <div style={POS_GRID}>
              <Stack gap={1}>
                <PosHint>{t('pos.search.priceEach')}</PosHint>
                <Money amountMinor={line.unitPriceMinor} currency={basket?.currency ?? ''} locale={locale} />
              </Stack>
              <Stack gap={1}>
                <PosHint>{t('pos.basket.lineTotal')}</PosHint>
                <Money amountMinor={line.lineTotalMinor} currency={basket?.currency ?? ''} locale={locale} />
              </Stack>
            </div>
          </Stack>
        </Card>
      ))}

      {basket === null ? null : (
        <Stack gap={4}>
          <Heading>{t('pos.discount.title')}</Heading>
          <PosHint>{t('pos.discount.hint')}</PosHint>
          <TextField
            label={t('pos.discount.amount', { currency: basket.currency })}
            inputMode="decimal"
            value={props.discountText}
            disabled={props.busy}
            error={props.discountInvalid ? t('pos.discount.invalid') : undefined}
            onChange={props.onDiscountText}
          />
          <Button variant="secondary" fullWidth disabled={props.busy} onClick={props.onApplyDiscount}>
            {t('pos.discount.apply')}
          </Button>
          {hasAmount(basket.discountMinor) ? (
            <Button variant="ghost" fullWidth disabled={props.busy} onClick={props.onClearDiscount}>
              {t('pos.discount.clear')}
            </Button>
          ) : null}
          <Card>
            <BasketTotals t={t} locale={locale} basket={basket} />
          </Card>
        </Stack>
      )}

      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      <Button fullWidth loading={props.busy} disabled={lines.length === 0} onClick={props.onAskFinish}>
        {t('pos.finish.action')}
      </Button>
      {/* The till is reached from the register: it is where the sitting is closed. */}
      <Button variant="ghost" fullWidth onClick={props.onGoToTill}>
        {t('pos.till.goToTill')}
      </Button>
      <ConfirmationDialog
        open={props.confirmingFinish}
        title={t('pos.finish.confirmTitle')}
        message={t('pos.finish.confirmHint')}
        confirmLabel={t('pos.finish.action')}
        cancelLabel={t('common.cancel')}
        loading={props.busy}
        onConfirm={props.onFinish}
        onCancel={props.onCancelFinish}
      />
    </div>
  );
}
