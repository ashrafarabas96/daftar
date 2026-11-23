/**
 * The send logic of "New customer", outside React, so the page holds no logic
 * a test cannot reach: the page creates ONE flow per form and folds every
 * outcome into its state with `afterOutcome`.
 *
 * - The customer id is minted when the flow is created and never again: every
 *   send of this flow — after no answer, after a refusal, after the merchant
 *   edited a field — carries the same id. The id IS the server's idempotency
 *   key (P4-AL-30): the same id with the same statement is answered 200
 *   `replayed: true` with no second write; the same id with a different
 *   statement is `customer.idempotency_conflict` (409). A new form is a new
 *   flow, offered only after a saved or an already-stored customer is shown.
 * - `customer.idempotency_conflict` is raised ONLY when a customer with this
 *   id is already stored (`customer.service.ts`: the refusal sits under
 *   `existing !== null`). The usual cause: the first send was saved, the
 *   answer was lost, and the merchant changed a field. So the stored customer
 *   is READ (`GET /v1/customers/:customerId`) and shown as already recorded,
 *   never "start over". When that read fails, the screen says the customer may
 *   already be saved and offers to read again; it offers no new form.
 *
 * ── An unknown outcome ───────────────────────────────────────────────────
 * No answer, or a 5xx (`isTransientFailure`), says NOTHING about whether the
 * server saved the customer, so it is never shown as "nothing was saved" and
 * never answered by creating again under a new id:
 * - the customer is read back by its id at once. Found: shown as already
 *   saved. `customer.not_found`: "we could not confirm the save; press Save
 *   again from this form" (`UNCONFIRMED_KEY`), the form and the id kept, so
 *   pressing Save again re-sends the SAME customer. A 404 does not prove the
 *   send was dropped (it may still be running), hence "could not confirm".
 *   Any other read failure: `storedUnread` (may be saved; read again).
 * - the id is written into the page ADDRESS (`?customer=<uuid>`,
 *   `history.replaceState`: no reload, no request) from the moment a send
 *   leaves until it is confirmed, so a reload re-opens the SAME id and reads
 *   it back before anything else (`resume`). Nothing is kept in browser
 *   storage: T-02 / ADR-001 forbids it, and a UUID in the address is not
 *   personal data.
 * - only an explicit server refusal (status below 500) keeps its own text.
 *
 * DECLARED LIMITS:
 * - the read-back needs `customers.view`. A member holding `customers.manage`
 *   without it can create, but cannot confirm: the read is refused (403), the
 *   screen says the customer may be saved and offers to read again. That is
 *   the safe direction; it is not a way to a second customer.
 * - no test in this repository drives `POST /v1/customers` end to end from the
 *   web; the replay behaviour is read from `customer.service.ts`.
 * - a different tab or device that opens a NEW form (an address without
 *   `?customer=`) mints a new id by design.
 * - an address whose `customer` is not one lowercase UUID is ignored (a new id).
 */
import type { CustomerCommandResultDto, CustomerDto } from '@daftar/shared-contracts';
import type { CreateCustomerRequestDto } from '@/lib/phase4-customers-api';
import { isTransientFailure, refusalCode, refusalKey } from '@/lib/phase3-errors';
import { createSubmitGuard, isCanonicalUuid, mintCustomerId, type CreateFormErrors, type CreateFormModel, type CreatePlan } from './customer-create';

/** The refusal that means "a customer with this id is already stored". */
export const ALREADY_STORED_CODE = 'customer.idempotency_conflict';

/** The read-back's own "no customer with this id". */
export const NOT_STORED_CODE = 'customer.not_found';

/** Shown when the stored customer could not be read: it may be saved, so do not enter it again. */
export const STORED_UNREADABLE_KEY = 'customers.create.storedUnreadable';

/** No answer to a send, and the read-back did not find it: the save is not confirmed; press Save again from THIS form. */
export const UNCONFIRMED_KEY = 'customers.create.notConfirmed';

/** After a reload: a send from before it was not found as saved. Saving from this form is the same customer. */
export const PENDING_NOT_FOUND_KEY = 'customers.create.pendingNotFound';

export type CreateOutcome =
  | { readonly kind: 'invalid'; readonly errors: CreateFormErrors }
  | { readonly kind: 'saved'; readonly customer: CustomerCommandResultDto }
  | { readonly kind: 'alreadySaved'; readonly customer: CustomerDto }
  | { readonly kind: 'storedUnread' }
  | { readonly kind: 'unconfirmed'; readonly errorKey: string }
  | { readonly kind: 'refused'; readonly errorKey: string };

/** The query parameter that carries the id of an unconfirmed send. */
export const PENDING_CUSTOMER_PARAM = 'customer';

/** Where the id of an unconfirmed send survives a reload. Every call may fail silently. */
export interface PendingMarker {
  /** The remembered id, only when it is one canonical lowercase UUID; null otherwise. */
  read(): string | null;
  write(customerId: string): void;
  clear(): void;
}

/** The two parts of `window` the marker touches. */
export interface AddressWindow {
  readonly location: { readonly href: string };
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
}

/**
 * The page address as the marker: `?customer=<uuid>`, rewritten in place with `history.replaceState`
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
        const value = new URL(win.location.href).searchParams.get(PENDING_CUSTOMER_PARAM);
        return value !== null && isCanonicalUuid(value) ? value : null;
      } catch {
        return null;
      }
    },
    write: (customerId) => rewrite((params) => params.set(PENDING_CUSTOMER_PARAM, customerId)),
    clear: () => rewrite((params) => params.delete(PENDING_CUSTOMER_PARAM)),
  };
}

export interface CreateFlowDeps {
  send: (body: CreateCustomerRequestDto) => Promise<CustomerCommandResultDto>;
  readStored: (customerId: string) => Promise<CustomerDto>;
  mint?: () => string;
  /** Where the id of an unconfirmed send survives a reload; null or absent when there is none. */
  pending?: PendingMarker | null;
}

export interface CreateFlow {
  readonly customerId: string;
  /** True when the id was re-opened from an unconfirmed send before a reload. */
  readonly resumed: boolean;
  /** Plan with this flow's id and send; null when a send or read is already in flight (a double click). */
  submit(plan: (customerId: string) => CreatePlan): Promise<CreateOutcome> | null;
  /** Read the stored customer of this flow's id again; null while something is in flight. */
  rereadStored(): Promise<CreateOutcome> | null;
  /** On a resumed flow, read the earlier send back before anything else; null when not resumed or busy. */
  resume(): Promise<CreateOutcome> | null;
}

export function createCustomerFlow(deps: CreateFlowDeps): CreateFlow {
  const marker = deps.pending ?? null;
  const restored = marker?.read() ?? null;
  const customerId = mintCustomerId(deps.mint, restored ?? undefined);
  const guard = createSubmitGuard();
  const remember = () => marker?.write(customerId);
  const forget = () => marker?.clear();
  // True once any send of this id may have been saved without our knowing.
  let uncertain = restored !== null;
  let notFoundKey = restored !== null ? PENDING_NOT_FOUND_KEY : UNCONFIRMED_KEY;

  async function readStored(): Promise<CreateOutcome> {
    try {
      const customer = await deps.readStored(customerId);
      forget();
      return { kind: 'alreadySaved', customer };
    } catch (error) {
      // Only the read's own "no customer with this id" gives the form back, and only when nothing proved it stored.
      if (uncertain && refusalCode(error) === NOT_STORED_CODE) return { kind: 'unconfirmed', errorKey: notFoundKey };
      return { kind: 'storedUnread' };
    }
  }

  return {
    customerId,
    resumed: restored !== null,
    submit(plan) {
      if (guard.busy) return null;
      const planned = plan(customerId);
      if (!planned.ok) return Promise.resolve({ kind: 'invalid', errors: planned.errors });
      const body = planned.body;
      return guard.run(async (): Promise<CreateOutcome> => {
        // Written BEFORE the send leaves: a reload during it must re-open this id.
        remember();
        try {
          const customer = await deps.send(body);
          forget();
          return { kind: 'saved', customer };
        } catch (error) {
          if (refusalCode(error) === ALREADY_STORED_CODE) {
            // Proven stored: a not-found read now is not "unconfirmed", it is unread.
            uncertain = false;
            return readStored();
          }
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
export interface CreateScreenState {
  form: CreateFormModel;
  busy: boolean;
  errorKey: string | null;
  result: CustomerCommandResultDto | null;
  stored: CustomerDto | null;
  storedUnread: boolean;
}

/** The screen as a send leaves it. A refusal touches nothing but the refusal text. */
export function afterOutcome(state: CreateScreenState, outcome: CreateOutcome): CreateScreenState {
  const idle = { ...state, busy: false };
  switch (outcome.kind) {
    case 'invalid':
      return { ...idle, errorKey: null, form: { ...state.form, errors: outcome.errors } };
    case 'saved':
      return { ...idle, errorKey: null, result: outcome.customer, stored: null, storedUnread: false };
    case 'alreadySaved':
      return { ...idle, errorKey: null, stored: outcome.customer, storedUnread: false };
    case 'storedUnread':
      return { ...idle, errorKey: STORED_UNREADABLE_KEY, storedUnread: true };
    case 'unconfirmed':
      // The form comes back as typed, with the same id behind it: Save again is the same customer.
      return { ...idle, errorKey: outcome.errorKey, stored: null, storedUnread: false };
    case 'refused':
      return { ...idle, errorKey: outcome.errorKey };
  }
}

/** The screen as a send starts: busy, the last refusal and field errors cleared, every value kept. */
export function beforeSend(state: CreateScreenState): CreateScreenState {
  return { ...state, busy: true, errorKey: null, form: { ...state.form, errors: {} } };
}
