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
 * - The payment id IS the server's replay key (P4-AL-30): the same id with
 *   the same intent (`intent_sha256`) is answered 200 `replayed: true` with
 *   no second write (`customer-payment.service.ts:605-607`); the same id with
 *   a different intent is `customer_payment.idempotency_conflict`.
 * - `customer_payment.idempotency_conflict` is raised ONLY when a payment
 *   with this id is already stored (`customer-payment.service.ts`: the
 *   refusal sits under `stored !== null`; a refused send stores nothing). The
 *   usual cause: the server saved the first send, the answer was lost, and
 *   the merchant changed a figure. So the stored payment is READ
 *   (`GET /v1/customer-payments/:paymentId`) and shown as already recorded —
 *   never "start over", which would record it twice. When that read fails,
 *   the screen says the payment may already be saved and offers to read it
 *   again; it offers no new form.
 *
 * ── An unknown outcome (closes the client-side double-payment defect) ─────
 * No answer, or a 5xx (`isTransientFailure`), says NOTHING about whether the
 * server saved the payment. It used to be shown as a refusal ("Nothing was
 * saved…"), and a reload minted new ids: a second payment. Now:
 * - the payment is read back by its id at once. Found → shown as already
 *   saved. `customer_payment.not_found` → "we could not confirm the save;
 *   press Save again from this form" (`UNCONFIRMED_KEY`), the form and the
 *   ids kept, so pressing Save again re-sends the SAME payment. A 404 does
 *   not prove the send was dropped (it may still be running on the server),
 *   which is why the text says "could not confirm" and never "not saved".
 *   Any other read failure → `storedUnread` (may be saved; read again).
 * - the payment id is written into the page ADDRESS (`?payment=<uuid>`,
 *   `history.replaceState`: no reload, no request) from the moment a send
 *   leaves until it is confirmed (saved or already stored), so a reload of
 *   this page re-opens the SAME payment id and reads it back before anything
 *   else (`resume`). Nothing is kept in browser storage: T-02 / ADR-001
 *   (`tests/integration/read-s7-static.test.ts`) forbids it, and a UUID in
 *   the address is not personal data. Only the payment id travels: the
 *   credit and allocation ids are minted anew after a reload. If that makes
 *   the request differ from a send the server already stored, the server
 *   answers `idempotency_conflict` and the stored payment is read and shown
 *   (above) — the safe direction. If nothing was stored, the payment is
 *   saved once under the same id.
 * - only an explicit server refusal (status below 500, i.e. the server
 *   answered and refused) keeps its own text.
 *
 * DECLARED LIMITS, not covered here:
 * - no test in this repository confirms the replay path on
 *   `POST /v1/customer-payments` itself (`replayed: true` is confirmed on
 *   other commands, on this one by the code reading only). This is not a
 *   guarantee against a second payment; it is the client keeping the key.
 * - a different tab or device that starts a NEW form (an address without
 *   `?payment=`) mints new ids by design.
 * - an address whose `payment` is not one UUID is ignored (fresh ids). That
 *   direction can lose the key of an unconfirmed send; it is reachable only
 *   by editing the address by hand.
 *
 * - A refusal changes nothing but the refusal text.
 */
import type { CustomerPaymentDto, CustomerPaymentResultDto } from '@daftar/shared-contracts';
import type { CollectPaymentRequestDto } from '@/lib/phase4-collect-payment-api';
import { isTransientFailure, refusalCode, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { isUuid } from '@/lib/route-ids';
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

/** The read-back's own "no payment with this id" (`receivables-reads.ts`). */
export const NOT_STORED_CODE = 'customer_payment.not_found';

/** Shown when the stored payment could not be read: it may be saved, so do not enter it again. */
export const STORED_UNREADABLE_KEY = 'customers.collect.storedUnreadable';

/** No answer to a send, and the read-back did not find it: the save is not confirmed; press Save again from THIS form. */
export const UNCONFIRMED_KEY = 'customers.collect.notConfirmed';

/** After a reload: a send from before it was not found as saved. Saving from this form is the same payment. */
export const PENDING_NOT_FOUND_KEY = 'customers.collect.pendingNotFound';

export type CollectOutcome =
  | { readonly kind: 'invalid'; readonly errors: CollectFormErrors; readonly invalidRows: readonly string[] }
  | { readonly kind: 'saved'; readonly payment: CustomerPaymentResultDto }
  | { readonly kind: 'alreadySaved'; readonly payment: CustomerPaymentDto }
  | { readonly kind: 'storedUnread' }
  | { readonly kind: 'unconfirmed'; readonly errorKey: string }
  | { readonly kind: 'refused'; readonly errorKey: string };

/** The query parameter that carries the payment id of an unconfirmed send. */
export const PENDING_PAYMENT_PARAM = 'payment';

/** Where the payment id of an unconfirmed send survives a reload. Every call may fail silently. */
export interface PendingMarker {
  /** The remembered payment id, only when it is one UUID; null otherwise. */
  read(): string | null;
  write(paymentId: string): void;
  clear(): void;
}

/** The two parts of `window` the marker touches. */
export interface AddressWindow {
  readonly location: { readonly href: string };
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
}

/**
 * The page address as the marker: `?payment=<uuid>`, rewritten in place with `history.replaceState`
 * (the router's own state is passed through untouched), every other part of the address kept.
 */
export function urlPendingMarker(win: AddressWindow): PendingMarker {
  const rewrite = (change: (params: URLSearchParams) => void) => {
    try {
      const url = new URL(win.location.href);
      change(url.searchParams);
      win.history.replaceState(win.history.state, '', url.href);
    } catch {
      // No address to write: the page works on, only a reload will not re-open the id.
    }
  };
  return {
    read() {
      try {
        const value = new URL(win.location.href).searchParams.get(PENDING_PAYMENT_PARAM);
        return value !== null && isUuid(value) ? value : null;
      } catch {
        return null;
      }
    },
    write: (paymentId) => rewrite((params) => params.set(PENDING_PAYMENT_PARAM, paymentId)),
    clear: () => rewrite((params) => params.delete(PENDING_PAYMENT_PARAM)),
  };
}

export interface CollectFlowDeps {
  send: (body: CollectPaymentRequestDto) => Promise<CustomerPaymentResultDto>;
  readStored: (paymentId: string) => Promise<CustomerPaymentDto>;
  mint?: () => string;
  /** Where the payment id of an unconfirmed send survives a reload; null or absent when there is none. */
  pending?: PendingMarker | null;
}

export interface CollectFlow {
  readonly ids: CollectIds;
  /** True when the payment id was re-opened from an unconfirmed send before a reload. */
  readonly resumed: boolean;
  /** Plan with this flow's ids and send; null when a send or read is already in flight (a double click). */
  submit(plan: (ids: CollectIds) => CollectPlan): Promise<CollectOutcome> | null;
  /** Read the stored payment of this flow's id again; null while something is in flight. */
  rereadStored(): Promise<CollectOutcome> | null;
  /** On a resumed flow, read the earlier send back before anything else; null when not resumed or busy. */
  resume(): Promise<CollectOutcome> | null;
}

export function createCollectFlow(deps: CollectFlowDeps): CollectFlow {
  const marker = deps.pending ?? null;
  const restored = marker?.read() ?? null;
  const ids = mintCollectIds(deps.mint, restored ?? undefined);
  const guard = createSubmitGuard();
  const remember = () => marker?.write(ids.paymentId);
  const forget = () => marker?.clear();
  // True once any send of this payment id may have been saved without our knowing.
  let uncertain = restored !== null;
  let notFoundKey = restored !== null ? PENDING_NOT_FOUND_KEY : UNCONFIRMED_KEY;

  async function readStored(): Promise<CollectOutcome> {
    try {
      const payment = await deps.readStored(ids.paymentId);
      forget();
      return { kind: 'alreadySaved', payment };
    } catch (error) {
      // Only the read's own "no payment with this id" gives the form back; anything else may hide a saved payment.
      if (uncertain && refusalCode(error) === NOT_STORED_CODE) return { kind: 'unconfirmed', errorKey: notFoundKey };
      return { kind: 'storedUnread' };
    }
  }

  return {
    ids,
    resumed: restored !== null,
    submit(plan) {
      if (guard.busy) return null;
      const planned = plan(ids);
      if (!planned.ok) return Promise.resolve({ kind: 'invalid', errors: planned.errors, invalidRows: planned.invalidRows });
      const body = planned.body;
      return guard.run(async (): Promise<CollectOutcome> => {
        // Written BEFORE the send leaves: a reload during it must re-open this payment id.
        remember();
        try {
          const payment = await withConflictRetry(() => deps.send(body));
          forget();
          return { kind: 'saved', payment };
        } catch (error) {
          if (refusalCode(error) === ALREADY_STORED_CODE) return readStored();
          if (isTransientFailure(error)) {
            uncertain = true;
            notFoundKey = UNCONFIRMED_KEY;
            return readStored();
          }
          // The server answered and refused: this send stored nothing. Unless an earlier one may have, forget the id.
          if (!uncertain) forget();
          return { kind: 'refused', errorKey: refusalKey(error) };
        }
      });
    },
    rereadStored() {
      return guard.run(readStored);
    },
    resume() {
      if (restored === null) return null;
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
    case 'unconfirmed':
      // The form comes back as typed, with the same ids behind it: Save again is the same payment.
      return { ...idle, errorKey: outcome.errorKey, stored: null, storedUnread: false };
    case 'refused':
      return { ...idle, errorKey: outcome.errorKey };
  }
}

/** The screen as a send starts: busy, the last refusal and field errors cleared, every figure kept. */
export function beforeSend(state: CollectScreenState): CollectScreenState {
  return { ...state, busy: true, errorKey: null, form: { ...state.form, errors: {} } };
}
