/**
 * `invpl/1` builders for the four P4-S1 customer kinds (lock P4-AL-39, gap G-5).
 *
 * A customer write needs a signed server decision: `P4-AL-38` gives
 * `daftar_app` no DML on any Phase 4 table and `P4-AL-39` requires every Phase 4
 * definer routine to verify one. A customer posts nothing to the ledger, so the
 * assertion is the `invctl/1` inventory one, and this file is its payload half.
 *
 * ── It reimplements NO framing ─────────────────────────────────────────────
 *
 * The `invpl/1` stream framing and the `intent_sha256` digest live in exactly
 * one place, `./payload` (`buildInventoryPayload`, `inventoryIntentSha256`), and
 * this file calls them. A second copy of a signed format is a second truth, and
 * this project's standing lesson is that two command protocols over one signing
 * secret are separated by DISJOINT PREIMAGES, never by parser shape: here the
 * preimage is disjoint because the operation code is part of the stream and
 * `customer.*` is a code no other protocol uses. Nothing about the encoding is
 * restated here.
 *
 * The text binding is `documentTextWords` from `./supplier-payloads`, also
 * reused rather than copied: a customer's free text travels as eight uint32
 * words of the SHA-256 of its exact UTF-8 bytes, the same binding the routine
 * recomputes in SQL with `inventory_reason_words`. Text is trimmed, and empty
 * text becomes NULL, BEFORE it is bound — `normalizeDocumentText` does that
 * once in the service, and these builders REFUSE text that is not already in
 * that form rather than normalizing it, so the application can never sign bytes
 * other than the ones the routine will hash.
 *
 * Every customer field is client intent, so each kind's intent digest is the
 * digest of its whole payload — the P3-S4 supplier rule (A-10(b)), which is why
 * `customer.*` has no `INVENTORY_OPERATION_INTENT_FIELDS` entry.
 */
import { InventoryError } from './errors';
import type { MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField, type InventoryP4S1OperationCode } from './payload';
import { documentTextWords } from './supplier-payloads';

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

/**
 * The text bounds, in characters after trimming: the SUPPLIER bounds of
 * `PHASE_3_S4_CONTRACT` A-11 for the four fields a customer has, because a
 * customer is the mirror of a supplier and this slice is not inventing a
 * different data model for one. They are also exactly the bounds the accepted
 * P4-S1 read contract states for `CustomerFieldsDto`
 * (`packages/shared-contracts/src/customers.ts:42-43`).
 *
 * There is no `taxIdentifier` bound because there is no tax identifier:
 * P4-AL-44 records that the registered / unregistered / exempt distinction has
 * no representation in the data model yet and P4-AL-45 forbids inventing one
 * while OD-03 is open.
 */
export const CUSTOMER_TEXT_BOUNDS = Object.freeze({
  name: Object.freeze({ min: 1, max: 200 }),
  phone: Object.freeze({ min: 1, max: 40 }),
  email: Object.freeze({ min: 3, max: 254 }),
  notes: Object.freeze({ min: 1, max: 1000 }),
});

// ── Fields ───────────────────────────────────────────────────────────────

const uuidField = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};

const wordFields = (words: readonly (bigint | null)[]): InventoryPayloadField[] =>
  words.map((w): InventoryPayloadField => (w === null ? { kind: 'null' } : { kind: 'integer', value: w }));

function revisionField(revision: number, what: string): InventoryPayloadField {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) refuse(`${what} must be a positive integer revision`);
  return { kind: 'integer', value: revision };
}

/**
 * Every field is intent, so the intent stream carries the same fields and its
 * digest is the payload's — the S4 `finishS4` shape, for the P4-S1 codes.
 */
export function finishP4S1(
  opCode: InventoryP4S1OperationCode,
  tenantId: string,
  businessId: string,
  fields: readonly InventoryPayloadField[],
): MovementPayload {
  return { payload: buildInventoryPayload(opCode, tenantId, businessId, fields), intentSha256: inventoryIntentSha256(opCode, tenantId, businessId, fields) };
}

// ── The four kinds ───────────────────────────────────────────────────────

/**
 * A customer's master data, each text already `normalizeDocumentText`-ed; only
 * the name is required. Exactly the fields of the accepted `CustomerFieldsDto`
 * (`packages/shared-contracts/src/customers.ts:64-71`), less the contacts,
 * which are their own rows and not part of this stream.
 *
 * There is no credit limit (`OD-P4-03` is RULED OPTION A — no limit in Phase 4),
 * no balance, paid total, outstanding total or aging figure (`P4-AL-06` forbids
 * a stored authoritative one, and a signed field is the strongest form of
 * storing one), and no tax identifier or registration flag (P4-AL-44, P4-AL-45,
 * OD-03 open). A customer's position is derived from the ledger, never carried
 * here.
 */
export interface CustomerText {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly notes: string | null;
}

function customerTextFields(t: CustomerText): InventoryPayloadField[] {
  if (t.name === null || t.name === undefined) refuse('a customer name is required');
  return [
    ...wordFields(documentTextWords(t.name, 'name', CUSTOMER_TEXT_BOUNDS.name)),
    ...wordFields(documentTextWords(t.phone, 'phone', CUSTOMER_TEXT_BOUNDS.phone)),
    ...wordFields(documentTextWords(t.email, 'email', CUSTOMER_TEXT_BOUNDS.email)),
    ...wordFields(documentTextWords(t.notes, 'notes', CUSTOMER_TEXT_BOUNDS.notes)),
  ];
}

export interface CustomerCreatePayloadInput extends CustomerText {
  readonly tenantId: string;
  readonly businessId: string;
  readonly customerId: string;
}

/** `customer.create`: customer_id, name_w1..w8, phone_w1..w8, email_w1..w8, notes_w1..w8. */
export function customerCreatePayload(input: CustomerCreatePayloadInput): MovementPayload {
  return finishP4S1('customer.create', input.tenantId, input.businessId, [uuidField(input.customerId, 'customer_id'), ...customerTextFields(input)]);
}

export interface CustomerUpdatePayloadInput extends CustomerCreatePayloadInput {
  /** The revision the client read; the update produces `expectedRevision + 1`. */
  readonly expectedRevision: number;
}

/** `customer.update`: customer_id, expected_revision, then the four word groups of the new values. */
export function customerUpdatePayload(input: CustomerUpdatePayloadInput): MovementPayload {
  return finishP4S1('customer.update', input.tenantId, input.businessId, [
    uuidField(input.customerId, 'customer_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
    ...customerTextFields(input),
  ]);
}

export interface CustomerLifecyclePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly customerId: string;
  readonly expectedRevision: number;
}

/** `customer.archive` (`active → inactive`): customer_id, expected_revision. */
export function customerArchivePayload(input: CustomerLifecyclePayloadInput): MovementPayload {
  return finishP4S1('customer.archive', input.tenantId, input.businessId, [
    uuidField(input.customerId, 'customer_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
  ]);
}

/** `customer.reactivate` (`inactive → active`): customer_id, expected_revision. Its own kind, not a direction flag (the S4 TL-3 ruling). */
export function customerReactivatePayload(input: CustomerLifecyclePayloadInput): MovementPayload {
  return finishP4S1('customer.reactivate', input.tenantId, input.businessId, [
    uuidField(input.customerId, 'customer_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
  ]);
}
