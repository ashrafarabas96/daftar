/**
 * `invpl/1` builders for the four supplier kinds (PHASE_3_S4_CONTRACT A-09,
 * A-10(b), A-11), and the free-text binding every P3-S4 kind shares.
 *
 * A supplier's text fields travel as eight uint32 words of the SHA-256 of
 * their exact UTF-8 bytes — the S3 reason binding (TL-4), computed in SQL by
 * `inventory_reason_words` from the text the routine receives — and a NULL
 * text as eight NULLs. Text is trimmed, and empty text is NULL, BEFORE it is
 * bound: `normalizeDocumentText` does that once, in the service, and the
 * builders refuse any text that is not already in that form rather than
 * normalizing it, so the application can never sign bytes other than the
 * ones the routine will hash.
 *
 * Every supplier field is client intent, so each kind's intent digest is the
 * digest of its whole payload (A-10(b)).
 */
import { createHash } from 'node:crypto';
import { InventoryError } from './errors';
import type { MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField, type InventoryS4OperationCode } from './payload';

/** A UTF-16 surrogate that is not half of a pair: such text has no exact UTF-8 bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

/** Text as a document stores it: trimmed, and NULL when nothing is left (A-09). The service's one normalization. */
export function normalizeDocumentText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return refuse('a text field must be a string');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The eight words of a document text, or eight NULLs for NULL (A-09). Refuses
 * text that is not already normalized (`normalizeDocumentText`), that holds
 * NUL or a lone surrogate, or whose length in code points (PostgreSQL's
 * `char_length`) is outside `min..max`.
 */
export function documentTextWords(text: string | null, what: string, bounds: { readonly min: number; readonly max: number }): readonly (bigint | null)[] {
  if (text === null) return Object.freeze(Array.from({ length: 8 }, () => null));
  if (typeof text !== 'string' || text !== text.trim() || text.length === 0) refuse(`${what} must be trimmed, non-empty text or NULL`);
  if (text.includes('\u0000') || LONE_SURROGATE.test(text)) refuse(`${what} must be well-formed text without NUL`);
  const length = [...text].length;
  if (length < bounds.min || length > bounds.max) refuse(`${what} must be ${bounds.min}..${bounds.max} characters`);
  const digest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
  return Object.freeze(Array.from({ length: 8 }, (_, i) => BigInt(digest.readUInt32BE(i * 4))));
}

/** The A-11 bounds, in characters after trimming. */
export const SUPPLIER_TEXT_BOUNDS = Object.freeze({
  name: Object.freeze({ min: 1, max: 200 }),
  phone: Object.freeze({ min: 1, max: 40 }),
  email: Object.freeze({ min: 3, max: 254 }),
  taxIdentifier: Object.freeze({ min: 1, max: 64 }),
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

/** Every field is intent (A-10(b)): the intent stream carries the same fields, so its digest is the payload's. */
export function finishS4(opCode: InventoryS4OperationCode, tenantId: string, businessId: string, fields: readonly InventoryPayloadField[]): MovementPayload {
  return { payload: buildInventoryPayload(opCode, tenantId, businessId, fields), intentSha256: inventoryIntentSha256(opCode, tenantId, businessId, fields) };
}

// ── The four kinds ───────────────────────────────────────────────────────

/** A supplier's master data, each text already `normalizeDocumentText`-ed; only the name is required. */
export interface SupplierText {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxIdentifier: string | null;
  readonly notes: string | null;
}

function supplierTextFields(t: SupplierText): InventoryPayloadField[] {
  if (t.name === null) refuse('a supplier name is required');
  return [
    ...wordFields(documentTextWords(t.name, 'name', SUPPLIER_TEXT_BOUNDS.name)),
    ...wordFields(documentTextWords(t.phone, 'phone', SUPPLIER_TEXT_BOUNDS.phone)),
    ...wordFields(documentTextWords(t.email, 'email', SUPPLIER_TEXT_BOUNDS.email)),
    ...wordFields(documentTextWords(t.taxIdentifier, 'tax identifier', SUPPLIER_TEXT_BOUNDS.taxIdentifier)),
    ...wordFields(documentTextWords(t.notes, 'notes', SUPPLIER_TEXT_BOUNDS.notes)),
  ];
}

export interface SupplierCreatePayloadInput extends SupplierText {
  readonly tenantId: string;
  readonly businessId: string;
  readonly supplierId: string;
}

/** `supplier.create`: supplier_id, name_w1..w8, phone_w1..w8, email_w1..w8, tax_identifier_w1..w8, notes_w1..w8. */
export function supplierCreatePayload(input: SupplierCreatePayloadInput): MovementPayload {
  return finishS4('supplier.create', input.tenantId, input.businessId, [uuidField(input.supplierId, 'supplier_id'), ...supplierTextFields(input)]);
}

export interface SupplierUpdatePayloadInput extends SupplierCreatePayloadInput {
  /** The revision the client read; the update produces `expectedRevision + 1`. */
  readonly expectedRevision: number;
}

/** `supplier.update`: supplier_id, expected_revision, then the five word groups of the new values. */
export function supplierUpdatePayload(input: SupplierUpdatePayloadInput): MovementPayload {
  return finishS4('supplier.update', input.tenantId, input.businessId, [
    uuidField(input.supplierId, 'supplier_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
    ...supplierTextFields(input),
  ]);
}

export interface SupplierLifecyclePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly supplierId: string;
  readonly expectedRevision: number;
}

/** `supplier.archive` (`active → inactive`): supplier_id, expected_revision. */
export function supplierArchivePayload(input: SupplierLifecyclePayloadInput): MovementPayload {
  return finishS4('supplier.archive', input.tenantId, input.businessId, [
    uuidField(input.supplierId, 'supplier_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
  ]);
}

/** `supplier.reactivate` (`inactive → active`): supplier_id, expected_revision. The op code keeps it apart from archive (TL-3). */
export function supplierReactivatePayload(input: SupplierLifecyclePayloadInput): MovementPayload {
  return finishS4('supplier.reactivate', input.tenantId, input.businessId, [
    uuidField(input.supplierId, 'supplier_id'),
    revisionField(input.expectedRevision, 'expected_revision'),
  ]);
}
