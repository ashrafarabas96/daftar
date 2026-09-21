import { AppError } from '@daftar/domain-core';

/**
 * §17–19 (Ultimate Closure): provisioning SECURITY DEFINER functions raise
 * domain errors as `PROV:<CODE>:<message>`. The provisioner boundary must
 * surface the SAME API contract the inline SQL produced — map, never leak.
 * Unknown provisioner errors propagate as-is (500) — never silently swallowed.
 */
export function mapProvisionError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^PROV:([A-Z_]+):?(.*)$/.exec(msg);
  if (!m) throw e;
  const code = m[1] ?? '';
  const detail = m[2] ?? '';
  switch (code) {
    case 'FORBIDDEN':
      throw AppError.forbidden(detail || 'Forbidden');
    case 'INVITATION_NOT_FOUND':
      throw AppError.notFound(detail || 'Invitation not found');
    case 'BUSINESS_NOT_FOUND':
      throw AppError.notFound(detail || 'Business not found');
    case 'ALREADY_MEMBER':
      throw AppError.conflict('ALREADY_MEMBER', detail || 'User is already a member');
    case 'MEMBER_SUSPENDED':
      throw AppError.conflict('MEMBER_SUSPENDED', detail || 'Member is suspended — use the reactivate command');
    case 'PLAN_LIMIT_EXCEEDED':
      throw AppError.conflict('PLAN_LIMIT_EXCEEDED', detail || 'Plan limit reached');
    case 'SLUG_RESERVED':
      throw AppError.conflict('SLUG_RESERVED', detail || 'This store slug is reserved');
    default:
      throw e;
  }
}

/** True when the error is a specific provisioning-domain code. */
export function isProvisionError(e: unknown, code: string): boolean {
  return e instanceof Error && e.message.startsWith(`PROV:${code}`);
}
