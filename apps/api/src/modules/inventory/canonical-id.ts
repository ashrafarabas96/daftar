import { AppError } from '@daftar/domain-core';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A request id as the canonical lowercase UUID.
 *
 * The `invpl/1` payload signs the lowercase form (P3-AL-55 §F), which is also
 * how PostgreSQL renders the routine's `uuid` argument when it rebuilds the
 * digest, so the application and the database hash one spelling of the same
 * identifier. Anything that is not a UUID at all is a 400, before any read.
 */
export function canonicalUuidParam(id: string, field: string): string {
  if (!UUID_RE.test(id)) throw AppError.validation({ [field]: ['invalid_uuid'] });
  return id.toLowerCase();
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A P3-S3 document id in a path, held to exactly the grammar of the body DTOs
 * (`inventory-movements.schemas.ts`): the canonical LOWERCASE UUID, refused
 * with a 400 otherwise and never lower-cased. The id is the idempotency key
 * of its document (A-10(a)), so one document has one spelling everywhere.
 */
export function strictUuidParam(id: string, field: string): string {
  if (!CANONICAL_UUID_RE.test(id)) throw AppError.validation({ [field]: ['invalid_uuid'] });
  return id;
}
