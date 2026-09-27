/**
 * `invpl/1` builders for the four payment-method kinds (PHASE_3_S6_CONTRACT
 * A-03, A-06, A-16; TL-4).
 *
 * A payment method is business-wide master data under the S4 supplier
 * pattern: a signed command whose routine owns every write. Every field is
 * client intent, so each kind's intent digest is the digest of its whole
 * payload (A-16, `0064:384`), stored as `create_intent_sha256` /
 * `last_intent_sha256`.
 *
 * A name travels as the eight words of the SHA-256 of its exact UTF-8 bytes,
 * and a missing locale as eight NULLs (S4C A-09). Names are trimmed once, in
 * the service (`normalizeDocumentText`); the builders refuse a name that is
 * not already in that form, or outside 1..100 characters, with
 * `payment_method.name_invalid`, and a method without any name with
 * `payment_method.name_required` — the codes the routine raises (§2.6 step
 * 5), so no assertion is minted for a command it would refuse.
 */
import { InventoryError } from './errors';
import type { MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField, type InventoryS6OperationCode } from './payload';
import { documentTextWords } from './supplier-payloads';

/** `payment_methods.system_type` (§2.2): the method's general accounting behaviour, immutable (A-06). */
export const PAYMENT_METHOD_SYSTEM_TYPES = ['cash', 'card', 'bank_transfer', 'wallet', 'cheque', 'other'] as const;
export type PaymentMethodSystemType = (typeof PAYMENT_METHOD_SYSTEM_TYPES)[number];

/** A name's bound, in characters after trimming (§2.2 `payment_method_names.display_name`). */
export const PAYMENT_METHOD_NAME_MAX = 100;
/** `payment_methods.sort_order` (§2.2). */
export const PAYMENT_METHOD_SORT_ORDER_MAX = 10000;

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};

type PaymentMethodOperationCode = Extract<InventoryS6OperationCode, `payment.${string}`>;

/** Every field is intent (A-16): the intent stream carries the same fields, so its digest is the payload's. */
function finish(opCode: PaymentMethodOperationCode, tenantId: string, businessId: string, fields: readonly InventoryPayloadField[]): MovementPayload {
  return { payload: buildInventoryPayload(opCode, tenantId, businessId, fields), intentSha256: inventoryIntentSha256(opCode, tenantId, businessId, fields) };
}

function revisionField(revision: number): InventoryPayloadField {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) refuse('expected_revision must be a positive integer revision');
  return { kind: 'integer', value: revision };
}

function sortOrderField(sortOrder: number): InventoryPayloadField {
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > PAYMENT_METHOD_SORT_ORDER_MAX)
    refuse(`sort_order must be 0..${PAYMENT_METHOD_SORT_ORDER_MAX}`);
  return { kind: 'integer', value: sortOrder };
}

/** The names of a method, each already `normalizeDocumentText`-ed; NULL where the locale has none. */
export interface PaymentMethodNames {
  readonly ar: string | null;
  readonly en: string | null;
  readonly tr: string | null;
}

/** The twenty-four name words (A-16): `name_ar_w1..w8`, `name_en_w1..w8`, `name_tr_w1..w8`. */
export function paymentMethodNameFields(names: PaymentMethodNames): InventoryPayloadField[] {
  const locales = [names.ar, names.en, names.tr];
  if (locales.every((n) => n === null)) throw new InventoryError('payment_method.name_required', 'a payment method needs a name in at least one locale');
  const out: InventoryPayloadField[] = [];
  for (const name of locales) {
    let words: readonly (bigint | null)[];
    try {
      words = documentTextWords(name, 'name', { min: 1, max: PAYMENT_METHOD_NAME_MAX });
    } catch (e) {
      if (e instanceof InventoryError) throw new InventoryError('payment_method.name_invalid', 'a payment method name must be trimmed, 1..100 characters');
      throw e;
    }
    for (const w of words) out.push(w === null ? { kind: 'null' } : { kind: 'integer', value: w });
  }
  return out;
}

function systemTypeField(systemType: string): InventoryPayloadField {
  if (!(PAYMENT_METHOD_SYSTEM_TYPES as readonly string[]).includes(systemType)) refuse('system_type is not a payment-method system type');
  return { kind: 'code', value: systemType };
}

export interface PaymentMethodCreatePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** Client-supplied: the idempotency key (TL-10). */
  readonly paymentMethodId: string;
  readonly systemType: PaymentMethodSystemType;
  readonly postingAccountId: string;
  readonly requiresReference: boolean;
  readonly sortOrder: number;
  readonly names: PaymentMethodNames;
}

/** `payment.create_method`: payment_method_id, system_type, posting_account_id, requires_reference, sort_order, the name words. */
export function paymentMethodCreatePayload(input: PaymentMethodCreatePayloadInput): MovementPayload {
  if (typeof input.requiresReference !== 'boolean') refuse('requires_reference must be a boolean');
  return finish('payment.create_method', input.tenantId, input.businessId, [
    uuid(input.paymentMethodId, 'payment_method_id'),
    systemTypeField(input.systemType),
    uuid(input.postingAccountId, 'posting_account_id'),
    { kind: 'boolean', value: input.requiresReference },
    sortOrderField(input.sortOrder),
    ...paymentMethodNameFields(input.names),
  ]);
}

export interface PaymentMethodUpdatePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly paymentMethodId: string;
  /** The revision the client read; the update produces `expectedRevision + 1`. */
  readonly expectedRevision: number;
  readonly postingAccountId: string;
  readonly requiresReference: boolean;
  readonly sortOrder: number;
  readonly names: PaymentMethodNames;
}

/** `payment.update_method`: payment_method_id, expected_revision, posting_account_id, requires_reference, sort_order, the name words. */
export function paymentMethodUpdatePayload(input: PaymentMethodUpdatePayloadInput): MovementPayload {
  if (typeof input.requiresReference !== 'boolean') refuse('requires_reference must be a boolean');
  return finish('payment.update_method', input.tenantId, input.businessId, [
    uuid(input.paymentMethodId, 'payment_method_id'),
    revisionField(input.expectedRevision),
    uuid(input.postingAccountId, 'posting_account_id'),
    { kind: 'boolean', value: input.requiresReference },
    sortOrderField(input.sortOrder),
    ...paymentMethodNameFields(input.names),
  ]);
}

export interface PaymentMethodLifecyclePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly paymentMethodId: string;
  readonly expectedRevision: number;
}

/** `payment.deactivate_method` (`is_active` true → false): payment_method_id, expected_revision. */
export function paymentMethodDeactivatePayload(input: PaymentMethodLifecyclePayloadInput): MovementPayload {
  return finish('payment.deactivate_method', input.tenantId, input.businessId, [
    uuid(input.paymentMethodId, 'payment_method_id'),
    revisionField(input.expectedRevision),
  ]);
}

/** `payment.activate_method` (`is_active` false → true): payment_method_id, expected_revision. The op code keeps it apart from deactivate. */
export function paymentMethodActivatePayload(input: PaymentMethodLifecyclePayloadInput): MovementPayload {
  return finish('payment.activate_method', input.tenantId, input.businessId, [
    uuid(input.paymentMethodId, 'payment_method_id'),
    revisionField(input.expectedRevision),
  ]);
}
