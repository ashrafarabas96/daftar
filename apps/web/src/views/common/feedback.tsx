/**
 * Page states, refusals and the missing-exchange-rate prompt shared by the
 * purchasing and supplier screens (P3-S7 contract §3 web-side rules, A-14).
 */
import { Button, ErrorState, PermissionDeniedState, Spinner, TextField } from '@daftar/design-system';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { CivilDate, Notice, Stack, Text } from './primitives';

/** What a page shows before its data: loading, a 403 on load (`PermissionDeniedState`, §3(b)), or a failed load. */
export type PageStatus = 'loading' | 'denied' | 'failed';

export interface PageStateProps {
  status: PageStatus;
  onRetry: () => void;
}

export function PageStateView({ t, status, onRetry }: PageStateProps & ViewBaseProps) {
  if (status === 'loading') return <Spinner label={t('common.loading')} />;
  if (status === 'denied') return <PermissionDeniedState title={t('error.FORBIDDEN')} />;
  return <ErrorState title={t('error.fallback')} retryLabel={t('common.tryAgain')} onRetry={onRetry} />;
}

/**
 * A refusal, as the catalog says it (A-15(d)): the key comes from
 * `refusalKey(error)` in the page, never from the server's message (A-15(e)).
 */
export function RefusalNotice({ t, errorKey }: { errorKey: string | null } & ViewBaseProps) {
  if (errorKey === null) return null;
  return <Notice tone="danger">{t(errorKey)}</Notice>;
}

export interface ExchangeRatePromptProps {
  /** The document or payment date the rate is missing for. */
  date: string;
  /** The foreign currency and the business's own currency, shown as codes, never as "base" (A-14). */
  currency: string;
  baseCurrency: string;
  /** True when the caller holds `accounting.fx.manage` and is business-wide; otherwise the screen says who can add it. */
  canEnter: boolean;
  rateText: string;
  rateInvalid: boolean;
  busy: boolean;
  onRateChange: (value: string) => void;
  onSubmit: () => void;
}

/** A-14: "Exchange rate on {date}: 1 {C} = [ ] {base}", then the original command again with the same document id. */
export function ExchangeRatePrompt(props: ExchangeRatePromptProps & ViewBaseProps) {
  const { t, locale } = props;
  const date = <CivilDate iso={props.date} locale={locale} />;
  if (!props.canEnter) {
    return <Notice tone="warning">{rich(t('payments.exchangeRate.askOwner'), { date })}</Notice>;
  }
  return (
    <Notice tone="warning">
      <Stack gap={3}>
        <Text>
          {rich(t('payments.exchangeRate.missing'), {
            date,
            from: <Ltr>{`1 ${props.currency}`}</Ltr>,
            to: <Ltr>{props.baseCurrency}</Ltr>,
          })}
        </Text>
        <TextField
          label={t('payments.exchangeRate.rateLabel', { currency: props.currency, base: props.baseCurrency })}
          inputMode="decimal"
          value={props.rateText}
          error={props.rateInvalid ? t('payments.exchangeRate.rateInvalid') : undefined}
          onChange={props.onRateChange}
        />
        <Button fullWidth loading={props.busy} onClick={props.onSubmit}>
          {t('payments.exchangeRate.saveAndContinue')}
        </Button>
      </Stack>
    </Notice>
  );
}
