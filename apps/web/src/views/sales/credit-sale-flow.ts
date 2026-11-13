/**
 * The send logic of the credit sale, outside React, so the page holds no logic
 * a test cannot reach: the page creates ONE flow per form and folds every
 * outcome into its state with `afterOutcome`.
 *
 * - The ids are minted when the flow is created and never again: every send
 *   of this flow — after no answer, after a refusal, after the merchant edited
 *   a quantity — carries the same sale id and the same line ids. A new form is
 *   a new flow, and the page offers one only after a saved or an
 *   already-stored sale has been shown.
 * - `sale.idempotency_conflict` is raised ONLY when a sale with this id is
 *   already stored with a different command (`sale-commit.service.ts`: the
 *   refusal sits under `stored !== null`; a refused send stores nothing). The
 *   usual cause: the server saved the first send, the answer was lost, and the
 *   merchant changed a quantity. So the stored sale is READ
 *   (`GET /v1/sales/:saleId`) and shown as already recorded — never "start
 *   over", which would sell the goods twice. When that read fails, the screen
 *   says the sale may already be saved and offers to read it again; it offers
 *   no new form.
 * - There is no automatic retry. `sale.state_changed` is "retryable BY THE
 *   CLIENT; there is no server retry" (`selling-errors.ts`), and the client
 *   here is the merchant: the refusal is shown and the same ids go again when
 *   they press the button.
 * - A refusal changes nothing but the refusal text.
 */
import type { SaleDto } from '@daftar/shared-contracts';
import type { CreditSaleRequestDto } from '@/lib/phase4-credit-sale-api';
import { refusalCode, refusalKey } from '@/lib/phase3-errors';
import type { DraftLine } from '../stock/model';
import {
  createSubmitGuard,
  mintCreditSaleIds,
  type CreditSaleFormErrors,
  type CreditSaleFormModel,
  type CreditSaleIds,
  type CreditSalePlan,
} from './credit-sale';

/** The refusal that means "a sale with this id is already stored". */
export const ALREADY_STORED_CODE = 'sale.idempotency_conflict';

/** Shown when the stored sale could not be read: it may be saved, so do not enter it again. */
export const STORED_UNREADABLE_KEY = 'sales.credit.storedUnreadable';

/**
 * The selling refusals THIS screen words itself, by code.
 *
 * Five have no `error.*` text in the shared catalogue: `tests/guards/
 * phase4-pos-refusal-catalogue.test.ts` excludes them as unreachable from the
 * till ("the receivables slice ships selling on account"), and from this screen
 * they are reachable. Keying them under `error.sale.*` would contradict that
 * guard, which is not this slice's file, so they are keyed here, by exact
 * code. The sixth, `sale.state_changed`, IS keyed, but in the till's words
 * ("the basket changed"); this screen has no basket.
 *
 * Every other answer goes through the shared `refusalKey`, unchanged.
 */
export const CREDIT_SALE_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'sale.credit_not_permitted': 'sales.credit.refusedNotPermitted',
  'sale.customer_inactive': 'sales.credit.refusedInactive',
  'sale.customer_not_found': 'sales.credit.refusedNotFound',
  'sale.currency_unknown': 'sales.credit.refusedCurrency',
  'sale.fx_rate_missing': 'sales.credit.refusedRate',
  'sale.state_changed': 'sales.credit.refusedChanged',
};

/** The catalogue key a refusal on this screen shows. Always a key that exists. */
export function creditSaleRefusalKey(error: unknown): string {
  const code = refusalCode(error);
  const own = code === null ? undefined : CREDIT_SALE_REFUSAL_KEYS[code];
  return own ?? refusalKey(error);
}

export type CreditSaleOutcome =
  | { readonly kind: 'invalid'; readonly errors: CreditSaleFormErrors; readonly lineErrors: Readonly<Record<string, string>> }
  | { readonly kind: 'saved'; readonly sale: SaleDto }
  | { readonly kind: 'alreadySaved'; readonly sale: SaleDto }
  | { readonly kind: 'storedUnread' }
  | { readonly kind: 'refused'; readonly errorKey: string };

export interface CreditSaleFlowDeps {
  send: (body: CreditSaleRequestDto) => Promise<SaleDto>;
  readStored: (saleId: string) => Promise<SaleDto>;
  mint?: () => string;
}

export interface CreditSaleFlow {
  readonly ids: CreditSaleIds;
  /** Plan with this flow's ids and send; null when a send or read is already in flight (a double click). */
  submit(plan: (ids: CreditSaleIds) => CreditSalePlan): Promise<CreditSaleOutcome> | null;
  /** Read the stored sale of this flow's id again; null while something is in flight. */
  rereadStored(): Promise<CreditSaleOutcome> | null;
}

export function createCreditSaleFlow(deps: CreditSaleFlowDeps): CreditSaleFlow {
  const ids = mintCreditSaleIds(deps.mint);
  const guard = createSubmitGuard();

  async function readStored(): Promise<CreditSaleOutcome> {
    try {
      return { kind: 'alreadySaved', sale: await deps.readStored(ids.saleId) };
    } catch {
      return { kind: 'storedUnread' };
    }
  }

  return {
    ids,
    submit(plan) {
      if (guard.busy) return null;
      const planned = plan(ids);
      if (!planned.ok) return Promise.resolve({ kind: 'invalid', errors: planned.errors, lineErrors: planned.lineErrors });
      const body = planned.body;
      return guard.run(async (): Promise<CreditSaleOutcome> => {
        try {
          return { kind: 'saved', sale: await deps.send(body) };
        } catch (error) {
          if (refusalCode(error) === ALREADY_STORED_CODE) return readStored();
          return { kind: 'refused', errorKey: creditSaleRefusalKey(error) };
        }
      });
    },
    rereadStored() {
      return guard.run(readStored);
    },
  };
}

/** What the screen holds between sends. */
export interface CreditSaleScreenState {
  form: CreditSaleFormModel;
  lines: DraftLine[];
  lineErrors: Readonly<Record<string, string>>;
  busy: boolean;
  errorKey: string | null;
  result: SaleDto | null;
  stored: SaleDto | null;
  storedUnread: boolean;
}

/** The screen as a send leaves it. A refusal touches the refusal text and nothing typed. */
export function afterOutcome(state: CreditSaleScreenState, outcome: CreditSaleOutcome): CreditSaleScreenState {
  const idle = { ...state, busy: false };
  switch (outcome.kind) {
    case 'invalid':
      return { ...idle, errorKey: null, form: { ...state.form, errors: outcome.errors }, lineErrors: outcome.lineErrors };
    case 'saved':
      return { ...idle, errorKey: null, result: outcome.sale, stored: null, storedUnread: false };
    case 'alreadySaved':
      return { ...idle, errorKey: null, stored: outcome.sale, storedUnread: false };
    case 'storedUnread':
      return { ...idle, errorKey: STORED_UNREADABLE_KEY, storedUnread: true };
    case 'refused':
      return { ...idle, errorKey: outcome.errorKey };
  }
}

/** The screen as a send starts: busy, the last refusal and field errors cleared, everything typed kept. */
export function beforeSend(state: CreditSaleScreenState): CreditSaleScreenState {
  return { ...state, busy: true, errorKey: null, form: { ...state.form, errors: {} }, lineErrors: {} };
}
