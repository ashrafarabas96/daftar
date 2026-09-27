/**
 * The shared purchasing and supplier views and their SSR fixtures (P3-S7
 * contract §4.3, §6: T-08, T-15, T-16).
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { ExchangeRatePrompt, PageStateView, RefusalNotice, type ExchangeRatePromptProps } from './feedback';

const noop = (): void => undefined;

const FX_PROMPT: ExchangeRatePromptProps = {
  date: '2026-09-27',
  currency: 'USD',
  baseCurrency: 'JOD',
  canEnter: true,
  rateText: '0.709',
  rateInvalid: false,
  busy: false,
  onRateChange: noop,
  onSubmit: noop,
};

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('PageStateView', PageStateView, {
    loading: { status: 'loading', onRetry: noop },
    denied: { status: 'denied', onRetry: noop },
    failed: { status: 'failed', onRetry: noop },
  }),
  defineView('RefusalNotice', RefusalNotice, {
    'a stable refusal key': { errorKey: 'error.supplier_payment.residue_below_base_unit' },
    'the data-safe fallback': { errorKey: 'error.fallback' },
    'nothing to say': { errorKey: null },
    'saved, but the re-read failed': { errorKey: 'common.savedRefresh' },
  }),
  defineView('ExchangeRatePrompt', ExchangeRatePrompt, {
    'owner enters the rate': FX_PROMPT,
    'rate invalid': { ...FX_PROMPT, rateText: '0', rateInvalid: true, busy: true },
    'ask the owner': { ...FX_PROMPT, canEnter: false, rateText: '' },
  }),
];
