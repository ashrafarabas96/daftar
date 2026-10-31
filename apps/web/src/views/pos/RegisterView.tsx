/**
 * The register (P4-S3): find an item, add it to the basket, ask for a discount
 * on a line, finish the sale.
 *
 * ── WHAT THIS SCREEN BELIEVES ────────────────────────────────────────────
 * Only the server. `cart` is the whole answer of the last accepted cart
 * command (`CartDto`), and every amount on screen is one of its fields:
 *
 *   price each   → `cart.lines[i].unitPriceMinor`  (or the search hit's)
 *   line         → `cart.lines[i].netMinor`        (gross less the discount)
 *   on the line  → `cart.lines[i].discountMinor`
 *   items        → `cart.subtotalMinor`
 *   discount     → `cart.discountMinor`            (the server's exact sum)
 *   to pay       → `cart.totalMinor`
 *
 * Nothing is multiplied, added or rounded here, and the screen sends no amount
 * except the ONE the ruling allows: a discount request (`OD-P4-02`, OPTION A).
 *
 * `cart.taxMinor` is deliberately not rendered: it is structurally zero
 * (`P4-AL-44`, `OD-03` OPEN) and a "Tax 0.00" row would state a policy that
 * does not exist.
 *
 * ── THE DISCOUNT IS ASKED FOR ON A LINE ──────────────────────────────────
 * `POS_DISCOUNT_GRAIN` is `'line'` and the whole reasoning lives there. The
 * consequence here is that the discount field sits INSIDE each basket line's
 * card, and the basket's "Discount given" stays as the one figure the merchant
 * reads — the server's exact integer sum of the line requests, never a total
 * this screen added up.
 */
import { Button, Card, ConfirmationDialog, List, SearchField, TextField, spacing } from '@daftar/design-system';
import type { ViewBaseProps } from '@/lib/phase3-format';
import type { PosCartDto, PosProductHitDto } from '@/lib/phase4-pos-api';
import { Heading, Money, Muted, Notice, Quantity, Stack, Title } from '../common/primitives';
import { RefusalNotice } from '../common/feedback';
import { hasAmount } from './model';
import { BasketTotals, POS_GRID, POS_STACK, PosHint, PosItemName } from './parts';

export interface RegisterViewProps {
  /** False when this user has no open till: the screen sends the cashier to the till instead of selling. */
  tillOpen: boolean;
  search: string;
  /** The hits of the last POS search, or null before one was made. */
  hits: readonly PosProductHitDto[] | null;
  /**
   * True when the server found further matches and dropped them: the prefix is
   * too broad. The screen says so rather than offering a page two, because
   * there is none — a type-ahead is narrowed by typing one more character.
   */
  moreMatches: boolean;
  /**
   * The server's basket, or null when this screen has not driven a cart
   * command yet. A till session is created empty and every cart command
   * answers with the whole recomputed cart, so null renders as "the basket is
   * empty" rather than as a loading state.
   */
  cart: PosCartDto | null;
  /** What the cashier has typed into each line's quantity field, by cart line id. */
  quantityDrafts: Readonly<Record<string, string>>;
  /** What the cashier has typed into each line's discount field, by cart line id. */
  discountDrafts: Readonly<Record<string, string>>;
  /** A catalogue key per line whose typed quantity is not a quantity the cart admits. */
  quantityErrors: Readonly<Record<string, string>>;
  /** A catalogue key per line whose typed discount is not an amount in this currency. */
  discountErrors: Readonly<Record<string, string>>;
  confirmingFinish: boolean;
  busy: boolean;
  errorKey: string | null;
  unitNames: Readonly<Record<string, string>>;
  onSearch: (text: string) => void;
  onAdd: (hit: PosProductHitDto) => void;
  onQuantity: (cartLineId: string, value: string) => void;
  onRemove: (cartLineId: string) => void;
  onDiscountText: (cartLineId: string, value: string) => void;
  onApplyDiscount: (cartLineId: string) => void;
  onClearDiscount: (cartLineId: string) => void;
  onAskFinish: () => void;
  onCancelFinish: () => void;
  onFinish: () => void;
  onGoToTill: () => void;
}

export function RegisterView(props: RegisterViewProps & ViewBaseProps) {
  const { t, locale, cart } = props;
  const unitOf = (unitCode: string | null): string => (unitCode === null ? '' : (props.unitNames[unitCode] ?? unitCode));
  /** One line's refused input, as merchant text, or undefined when there is none. */
  const errorOn = (errors: Readonly<Record<string, string>>, cartLineId: string): string | undefined => {
    const key = errors[cartLineId];
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

  const currency = cart?.currency ?? '';
  const lines = cart?.lines ?? [];
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
                {/*
                 * The unit shows HERE, on the hit, and not on a basket line:
                 * the type-ahead carries `unitCode` and `unitDecimals` and
                 * `CartDto`'s line carries neither, so a basket line has no
                 * unit to name and the screen does not invent one.
                 */}
                {unitOf(hit.unitCode).length > 0 ? <span>{t('pos.basket.unit', { unit: unitOf(hit.unitCode) })}</span> : null}
                {hit.onHand === null ? null : <span>{t('pos.search.here')}</span>}
                {hit.onHand === null ? null : <Quantity value={hit.onHand} decimals={hit.unitDecimals ?? 0} locale={locale} />}
              </span>
            ),
            trailing: (
              <Button variant="secondary" disabled={props.busy} onClick={() => props.onAdd(hit)}>
                {t('common.add')}
              </Button>
            ),
          }))}
        />
      )}
      {props.hits !== null && props.moreMatches ? <PosHint>{t('pos.search.narrow')}</PosHint> : null}

      <Heading>{t('pos.basket.title')}</Heading>
      {lines.length === 0 ? <PosHint>{t('pos.basket.empty')}</PosHint> : <PosHint>{t('pos.discount.hint')}</PosHint>}
      {lines.map((line) => (
        <Card key={line.cartLineId}>
          <Stack gap={3}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing[2], flexWrap: 'wrap' }}>
              <PosItemName name={line.name} />
              <Button variant="ghost" disabled={props.busy} onClick={() => props.onRemove(line.cartLineId)}>
                {t('common.remove')}
              </Button>
            </div>
            <TextField
              label={t('pos.basket.quantity')}
              inputMode="decimal"
              value={props.quantityDrafts[line.cartLineId] ?? line.quantity}
              disabled={props.busy}
              error={errorOn(props.quantityErrors, line.cartLineId)}
              onChange={(value) => props.onQuantity(line.cartLineId, value)}
            />
            <div style={POS_GRID}>
              <Stack gap={1}>
                <PosHint>{t('pos.search.priceEach')}</PosHint>
                <Money amountMinor={line.unitPriceMinor} currency={currency} locale={locale} />
              </Stack>
              <Stack gap={1}>
                <PosHint>{t('pos.basket.lineTotal')}</PosHint>
                {/* `netMinor` — the server's gross less the discount it granted on this line. */}
                <Money amountMinor={line.netMinor} currency={currency} locale={locale} />
              </Stack>
            </div>
            {/* The discount, at the grain the server offers it (`POS_DISCOUNT_GRAIN`). */}
            <TextField
              label={t('pos.discount.amount', { currency })}
              inputMode="decimal"
              value={props.discountDrafts[line.cartLineId] ?? ''}
              disabled={props.busy}
              error={errorOn(props.discountErrors, line.cartLineId)}
              onChange={(value) => props.onDiscountText(line.cartLineId, value)}
            />
            <Button variant="secondary" fullWidth disabled={props.busy} onClick={() => props.onApplyDiscount(line.cartLineId)}>
              {t('pos.discount.apply')}
            </Button>
            {hasAmount(line.discountMinor) ? (
              <Button variant="ghost" fullWidth disabled={props.busy} onClick={() => props.onClearDiscount(line.cartLineId)}>
                {t('pos.discount.clear')}
              </Button>
            ) : null}
          </Stack>
        </Card>
      ))}

      {/*
       * No totals for an EMPTY basket, and the reason is the server's own
       * answer rather than taste: `PosCartService.recompute` prices the stored
       * lines and takes the currency from them, with `fallbackCurrency = ''`
       * and no caller passing one (`pos-cart.service.ts:323`), so a cart with
       * no lines comes back with `currency: ''`. Measured on the browser gate:
       * after the sale the register removes each committed line, the last
       * answer is that empty cart, and rendering its totals threw
       * `Unsupported currency: ` out of `minorUnitsOf` — a client-side
       * exception in all three locales at all three viewports, which then took
       * the till-close step with it.
       *
       * Reading the currency off the lines is defensible — an empty basket has
       * no currency to state, and the alternative is the client naming one,
       * which is exactly what `P4-AL-18` forbids. So the screen shows what an
       * empty basket is: "The basket is empty", and no figures.
       */}
      {cart === null || lines.length === 0 ? null : (
        <Card>
          <BasketTotals t={t} locale={locale} cart={cart} />
        </Card>
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
