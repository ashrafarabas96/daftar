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
 * - the ids are remembered in this tab's `sessionStorage`, per customer,
 *   from the moment a send leaves until it is confirmed (saved or already
 *   stored), so a reload re-opens the SAME ids and reads the payment back
 *   before anything else (`resume`).
 * - only an explicit server refusal (status below 500, i.e. the server
 *   answered and refused) keeps its own text.
 *
 * DECLARED LIMITS, not covered here:
 * - no test in this repository confirms the replay path on
 *   `POST /v1/customer-payments` itself (`replayed: true` is confirmed on
 *   other commands, on this one by the code reading only). This is not a
 *   guarantee against a second payment; it is the client keeping the key.
 * - a second tab, another device, or a browser with storage blocked mints
 *   new ids by design: `sessionStorage` is per tab and the page works
 *   without it.
 * - a corrupted stored record is ignored (fresh ids). That direction can
 *   lose the key of an unconfirmed send; it is reachable only by editing
 *   the browser's storage.
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
  type CollectIdsSnapshot,
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

/** The few calls of `Storage` the flow uses; any of them may throw (private mode, blocked site data). */
export interface PendingStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Where the ids of an unconfirmed send of one customer are kept. */
export const pendingKey = (customer: string): string => `daftar.collect.pending.${customer}`;

/** This tab's `sessionStorage`, or null when the browser refuses it. */
export function sessionPendingStore(): PendingStore | null {
  try {
    const s = window.sessionStorage;
    return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v), remove: (k) => s.removeItem(k) };
  } catch {
    return null;
  }
}

/** A stored record, only when every id in it is a UUID; anything else is not ids. */
function parseSnapshot(text: string | null): CollectIdsSnapshot | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { paymentId, creditId, allocations } = value as Record<string, unknown>;
  if (typeof paymentId !== 'string' || !isUuid(paymentId)) return null;
  if (typeof creditId !== 'string' || !isUuid(creditId)) return null;
  if (typeof allocations !== 'object' || allocations === null || Array.isArray(allocations)) return null;
  const entries = Object.entries(allocations as Record<string, unknown>);
  const valid: Record<string, string> = {};
  for (const [invoiceId, allocationId] of entries) {
    if (!isUuid(invoiceId) || typeof allocationId !== 'string' || !isUuid(allocationId)) return null;
    valid[invoiceId] = allocationId;
  }
  return { paymentId, creditId, allocations: valid };
}

export interface CollectFlowDeps {
  send: (body: CollectPaymentRequestDto) => Promise<CustomerPaymentResultDto>;
  readStored: (paymentId: string) => Promise<CustomerPaymentDto>;
  mint?: () => string;
  /** Where the ids of an unconfirmed send survive a reload; `store: null` when there is none. */
  pending?: { readonly store: PendingStore | null; readonly customerId: string };
}

export interface CollectFlow {
  readonly ids: CollectIds;
  /** True when the ids were re-opened from an unconfirmed send before a reload. */
  readonly resumed: boolean;
  /** Plan with this flow's ids and send; null when a send or read is already in flight (a double click). */
  submit(plan: (ids: CollectIds) => CollectPlan): Promise<CollectOutcome> | null;
  /** Read the stored payment of this flow's id again; null while something is in flight. */
  rereadStored(): Promise<CollectOutcome> | null;
  /** On a resumed flow, read the earlier send back before anything else; null when not resumed or busy. */
  resume(): Promise<CollectOutcome> | null;
}

export function createCollectFlow(deps: CollectFlowDeps): CollectFlow {
  const store = deps.pending?.store ?? null;
  const key = deps.pending ? pendingKey(deps.pending.customerId) : null;
  const attempt = <T>(op: (s: PendingStore, k: string) => T): T | null => {
    if (store === null || key === null) return null;
    try {
      return op(store, key);
    } catch {
      return null;
    }
  };
  const restored = parseSnapshot(attempt((s, k) => s.get(k)));
  const ids = mintCollectIds(deps.mint, restored ?? undefined);
  const guard = createSubmitGuard();
  const remember = () => attempt((s, k) => s.set(k, JSON.stringify(ids.snapshot())));
  const forget = () => attempt((s, k) => s.remove(k));
  // True once any send of these ids may have been saved without our knowing.
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
        // Remembered BEFORE the send leaves: a reload during it must re-open these ids.
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
          // The server answered and refused: this send stored nothing. Unless an earlier one may have, forget the ids.
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
