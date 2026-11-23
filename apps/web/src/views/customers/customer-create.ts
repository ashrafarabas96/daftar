/**
 * "New customer": the form model, the plan that turns it into the request
 * body, and the one-send-at-a-time guard. Pure: no React, no client.
 *
 * The bounds and the email shape are the server's, restated here so a typo is
 * caught before a round trip; the server stays the judge
 * (`CUSTOMER_TEXT_BOUNDS` in `@daftar/domain-core`, `CustomerWriteCreateSchema`
 * in `apps/api/.../selling.schemas.ts`):
 *
 * - `name` 1..200, `phone` 1..40, `email` 3..254 and address-shaped, `notes`
 *   1..1000 — counted in CODE POINTS after trimming;
 * - the server trims and its stored `intent_sha256` binds the TRIMMED text, so
 *   the client sends trimmed text: the same customer typed with stray spaces
 *   is the same command, not a `customer.idempotency_conflict`;
 * - an optional field left blank is OMITTED, which the server stores as NULL;
 * - the body holds `customerId`, `name` and those three, and nothing else: the
 *   mounted schema is `.strict()` and refuses `contacts`.
 *
 * A phone number is TEXT: it is neither validated by digit nor converted, so a
 * number typed in Arabic-Indic digits is stored as typed.
 */
import type { CreateCustomerRequestDto } from '@/lib/phase4-customers-api';

/** The server's text bounds (`CUSTOMER_TEXT_BOUNDS`), in code points. */
export const CUSTOMER_FIELD_BOUNDS = Object.freeze({
  name: Object.freeze({ min: 1, max: 200 }),
  phone: Object.freeze({ min: 1, max: 40 }),
  email: Object.freeze({ min: 3, max: 254 }),
  notes: Object.freeze({ min: 1, max: 1000 }),
});

export type CreateField = 'name' | 'phone' | 'email' | 'notes';

export type CreateFormErrors = Partial<Record<CreateField, true>>;

/** What the merchant is typing. */
export interface CreateFormModel {
  name: string;
  phone: string;
  email: string;
  notes: string;
  errors: CreateFormErrors;
}

export type CreatePlan = { ok: true; body: CreateCustomerRequestDto } | { ok: false; errors: CreateFormErrors };

/** A canonical LOWERCASE uuid: what the server accepts for an id the client chooses. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

/** The customer id of a form: minted once, or the one a reload re-opened. */
export function mintCustomerId(mint: () => string = () => crypto.randomUUID(), restored?: string): string {
  return restored ?? mint();
}

const within = (value: string, bounds: { readonly min: number; readonly max: number }): boolean => {
  const length = [...value].length;
  return length >= bounds.min && length <= bounds.max;
};

/** Plan the request, or name every field that cannot be sent. Throws on an id that is not canonical (a defect, not a typo). */
export function planCreateCustomer(form: CreateFormModel, customerId: string): CreatePlan {
  if (!isCanonicalUuid(customerId)) throw new Error('customerId must be a canonical lowercase uuid');
  const name = form.name.trim();
  const phone = form.phone.trim();
  const email = form.email.trim();
  const notes = form.notes.trim();

  const errors: CreateFormErrors = {};
  if (!within(name, CUSTOMER_FIELD_BOUNDS.name)) errors.name = true;
  if (phone !== '' && !within(phone, CUSTOMER_FIELD_BOUNDS.phone)) errors.phone = true;
  if (email !== '' && !(within(email, CUSTOMER_FIELD_BOUNDS.email) && /^[^\s@]+@[^\s@]+$/.test(email))) errors.email = true;
  if (notes !== '' && !within(notes, CUSTOMER_FIELD_BOUNDS.notes)) errors.notes = true;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: CreateCustomerRequestDto = { customerId, name };
  if (phone !== '') body.phone = phone;
  if (email !== '') body.email = email;
  if (notes !== '') body.notes = notes;
  return { ok: true, body };
}

// ── Sending ──────────────────────────────────────────────────────────────

export interface SubmitGuard {
  /** Runs `send` unless a send is already in flight, in which case it returns null and sends nothing. */
  run<T>(send: () => Promise<T>): Promise<T> | null;
  readonly busy: boolean;
}

/** One send at a time per form: a double click, or a second tap before the button re-renders disabled, sends once. */
export function createSubmitGuard(): SubmitGuard {
  let inFlight = false;
  return {
    run<T>(send: () => Promise<T>): Promise<T> | null {
      if (inFlight) return null;
      inFlight = true;
      let sent: Promise<T>;
      try {
        sent = send();
      } catch (error) {
        inFlight = false;
        throw error;
      }
      return sent.finally(() => {
        inFlight = false;
      });
    },
    get busy() {
      return inFlight;
    },
  };
}
