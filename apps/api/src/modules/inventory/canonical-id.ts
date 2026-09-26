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
