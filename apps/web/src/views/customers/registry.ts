/**
 * The customer views and the fixtures the SSR suites render them with, in the
 * shape of `suppliers/registry.ts`.
 *
 * Every fixture is a state the page can reach:
 *
 * - each `errorKey` is one `refusalKey` produces for an explicit refusal this
 *   page can receive (a customer refusal carries `details.sellingCode`; a 403
 *   is `error.FORBIDDEN`), or one of the flow's own keys: no answer or a 5xx
 *   is read back, never shown as a refusal (`UNCONFIRMED_KEY`,
 *   `PENDING_NOT_FOUND_KEY`, `STORED_UNREADABLE_KEY`) — asserted in
 *   `test/customer-create-screens.test.tsx`;
 * - a refused fixture keeps the values typed, because the page sets the
 *   refusal and touches nothing else;
 * - a 403 on LOAD renders `PageStateView` and never reaches this view.
 */
import type { CustomerCommandResultDto } from '@daftar/shared-contracts';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { CustomerCreateView, type CustomerCreateViewProps } from './CustomerCreateView';
import type { CreateFormModel } from './customer-create';
import { PENDING_NOT_FOUND_KEY, UNCONFIRMED_KEY, afterOutcome, type CreateScreenState } from './customer-create-flow';

const noop = (): void => undefined;

const form = (over: Partial<CreateFormModel> = {}): CreateFormModel => ({ name: '', phone: '', email: '', notes: '', errors: {}, ...over });

const TYPED = form({ name: 'بقالة الزيتون', phone: '0599 123 456', email: 'zaytoun@example.com', notes: 'يدفع نهاية الأسبوع' });

const view = (over: Partial<CustomerCreateViewProps> = {}): CustomerCreateViewProps => ({
  form: form(),
  busy: false,
  errorKey: null,
  result: null,
  stored: null,
  storedUnread: false,
  on: { onField: noop, onSubmit: noop, onRereadStored: noop, onStartOver: noop },
  ...over,
});

const SAVED: CustomerCommandResultDto = {
  id: '5e1d0c9b-0001-4a7b-8c9d-0000000000c1',
  name: 'بقالة الزيتون',
  phone: '0599 123 456',
  email: 'zaytoun@example.com',
  notes: 'يدفع نهاية الأسبوع',
  status: 'active',
  revision: 1,
  createdAt: '2026-11-13T08:00:00Z',
  updatedAt: '2026-11-13T08:00:00Z',
  contacts: [],
  replayed: false,
  // A trace id the view must never show (T-08 searches the props for it).
  businessTransactionId: '5e1d0c9b-0099-4a7b-8c9d-0000000000b7',
};

/** The stored customer as `GET /v1/customers/:customerId` returns it: the result without `replayed` and the trace id. */
const { replayed: _replayed, businessTransactionId: _trace, ...STORED_BASE } = SAVED;
void _replayed;
void _trace;

/** A screen state the flow folds an outcome into, as the page holds it. */
const screen = (f: CreateFormModel): CreateScreenState => ({ form: f, busy: true, errorKey: null, result: null, stored: null, storedUnread: false });

const asView = (state: CreateScreenState): CustomerCreateViewProps => view(state);

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('CustomerCreateView', CustomerCreateView, {
    'empty form': view(),
    'typed, ready to save': view({ form: TYPED }),
    'a field is not valid': view({ form: form({ name: 'بقالة الزيتون', email: 'not-an-email', errors: { email: true } }) }),
    'the name is missing': view({ form: form({ errors: { name: true } }) }),
    sending: view({ form: TYPED, busy: true }),
    'refused: the name is not valid, values kept': view({ form: TYPED, errorKey: 'error.customer.name_invalid' }),
    'refused: the phone is not valid, values kept': view({ form: TYPED, errorKey: 'error.customer.phone_invalid' }),
    'refused: the email is not valid, values kept': view({ form: TYPED, errorKey: 'error.customer.email_invalid' }),
    'refused: the note is not valid, values kept': view({ form: TYPED, errorKey: 'error.customer.notes_invalid' }),
    'refused: no permission to add customers': view({ form: TYPED, errorKey: 'error.FORBIDDEN' }),
    // The first send was saved but its answer lost; the merchant changed the name and sent again.
    // The flow reads the stored customer and the screen shows IT, not the edited form.
    'already recorded: the stored customer is shown': view(
      afterOutcome(screen(form({ ...TYPED, name: 'بقالة الزيتون الجديدة' })), { kind: 'alreadySaved', customer: STORED_BASE }),
    ),
    'already recorded, but it could not be read': asView(afterOutcome(screen(TYPED), { kind: 'storedUnread' })),
    // No answer, or a 5xx: the fate of the send is unknown. The flow reads the customer back by its id; NOT found,
    // the screen says the save could not be confirmed (never "nothing was saved") and keeps the form and the id.
    'no answer, not found when read back: not confirmed, values kept': asView(afterOutcome(screen(TYPED), { kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY })),
    // The page was reloaded while a send was unconfirmed: the same id was re-opened and the send read back, not found.
    'reloaded, the earlier send not found: the same customer can be saved from this form': asView(
      afterOutcome(screen(form()), { kind: 'unconfirmed', errorKey: PENDING_NOT_FOUND_KEY }),
    ),
    saved: view({ result: SAVED }),
    'saved earlier: the same customer sent again': view({ result: { ...SAVED, replayed: true } }),
    'saved, with only a name': view({ result: { ...SAVED, phone: null, email: null, notes: null } }),
  }),
];
