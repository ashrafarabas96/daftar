/**
 * The send logic of "Receive a payment", outside React, so the page holds no
 * logic a test cannot reach: the page creates ONE flow per form and folds
 * every outcome into its state with `afterOutcome`.
 *
 * - The ids are minted when the flow is created and never again: every send
 *   of this flow — after no answer, after a retryable 409, after the merchant
 *   edited a figure — carries the same payment, credit and allocation ids.
 *   A new form is a new flow, and the page offers one only after a saved or
 *   an already-stored payment has been shown.
 * - `customer_payment.idempotency_conflict` is raised ONLY when a payment
 *   with this id is already stored (`customer-payment.service.ts`: the
 *   refusal sits under `stored !== null`; a refused send stores nothing). The
 *   usual cause: the server saved the first send, the answer was lost, and
 *   the merchant changed a figure. So the stored payment is READ
 *   (`GET /v1/customer-payments/:paymentId`) and shown as already recorded —
 *   never "start over", which would record it twice. When that read fails,
 *   the screen says the payment may already be saved and offers to read it
 *   again; it offers no new form.
 * - A refusal changes nothing but the refusal text.
 */
import type { CustomerPaymentDto, CustomerPaymentResultDto } from '@daftar/shared-contracts';
import type { CollectPaymentRequestDto } from '@/lib/phase4-collect-payment-api';
import { refusalCode, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import {
  createSubmitGuard,
  mintCollectIds,
  type CollectFormErrors,
  type CollectFormModel,
  type CollectIds,
  type CollectPlan,
  type CollectRowModel,
} from './collect-payment';

/** The refusal that means "a payment with this id is already stored". */
export const ALREADY_STORED_CODE = 'customer_payment.idempotency_conflict';

/** Shown when the stored payment could not be read: it may be saved, so do not enter it again. */
export const STORED_UNREADABLE_KEY = 'customers.collect.storedUnreadable';

export type CollectOutcome =
  | { readonly kind: 'invalid'; readonly errors: CollectFormErrors; readonly invalidRows: readonly string[] }
  | { readonly kind: 'saved'; readonly payment: CustomerPaymentResultDto }
  | { readonly kind: 'alreadySaved'; readonly payment: CustomerPaymentDto }
  | { readonly kind: 'storedUnread' }
  | { readonly kind: 'refused'; readonly errorKey: string };

export interface CollectFlowDeps {
  send: (body: CollectPaymentRequestDto) => Promise<CustomerPaymentResultDto>;
  readStored: (paymentId: string) => Promise<CustomerPaymentDto>;
  mint?: () => string;
}

export interface CollectFlow {
  readonly ids: CollectIds;
  /** Plan with this flow's ids and send; null when a send or read is already in flight (a double click). */
  submit(plan: (ids: CollectIds) => CollectPlan): Promise<CollectOutcome> | null;
  /** Read the stored payment of this flow's id again; null while something is in flight. */
  rereadStored(): Promise<CollectOutcome> | null;
}

export function createCollectFlow(deps: CollectFlowDeps): CollectFlow {
  const ids = mintCollectIds(deps.mint);
  const guard = createSubmitGuard();

  async function readStored(): Promise<CollectOutcome> {
    try {
      return { kind: 'alreadySaved', payment: await deps.readStored(ids.paymentId) };
    } catch {
      return { kind: 'storedUnread' };
    }
  }

  return {
    ids,
    submit(plan) {
      if (guard.busy) return null;
      const planned = plan(ids);
      if (!planned.ok) return Promise.resolve({ kind: 'invalid', errors: planned.errors, invalidRows: planned.invalidRows });
      const body = planned.body;
      return guard.run(async (): Promise<CollectOutcome> => {
        try {
          return { kind: 'saved', payment: await withConflictRetry(() => deps.send(body)) };
        } catch (error) {
          if (refusalCode(error) === ALREADY_STORED_CODE) return readStored();
          return { kind: 'refused', errorKey: refusalKey(error) };
        }
      });
    },
    rereadStored() {
      return guard.run(readStored);
    },
  };
}

/** What the screen holds between sends. */
export interface CollectScreenState {
  form: CollectFormModel;
  rows: CollectRowModel[];
  busy: boolean;
  errorKey: string | null;
  result: CustomerPaymentResultDto | null;
  stored: CustomerPaymentDto | null;
  storedUnread: boolean;
}

/** The screen as a send leaves it. A refusal touches the refusal text and nothing typed. */
export function afterOutcome(state: CollectScreenState, outcome: CollectOutcome): CollectScreenState {
  const idle = { ...state, busy: false };
  switch (outcome.kind) {
    case 'invalid': {
      const invalid = new Set(outcome.invalidRows);
      return {
        ...idle,
        errorKey: null,
        form: { ...state.form, errors: outcome.errors },
        rows: state.rows.map((r) => ({ ...r, invalid: invalid.has(r.invoiceId) })),
      };
    }
    case 'saved':
      return { ...idle, errorKey: null, result: outcome.payment, stored: null, storedUnread: false };
    case 'alreadySaved':
      return { ...idle, errorKey: null, stored: outcome.payment, storedUnread: false };
    case 'storedUnread':
      return { ...idle, errorKey: STORED_UNREADABLE_KEY, storedUnread: true };
    case 'refused':
      return { ...idle, errorKey: outcome.errorKey };
  }
}

/** The screen as a send starts: busy, the last refusal and field errors cleared, every figure kept. */
export function beforeSend(state: CollectScreenState): CollectScreenState {
  return { ...state, busy: true, errorKey: null, form: { ...state.form, errors: {} } };
}
