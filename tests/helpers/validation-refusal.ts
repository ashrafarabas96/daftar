import type { ArgumentsHost } from '@nestjs/common';
import type { ZodError } from 'zod';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';

/**
 * What the client receives when a request body fails validation, produced by
 * the REAL filter from a REAL schema's refusal. Shared by the validation-
 * contract suites (DR-11 `t10-zod-error-contract`, DR-71 section 3).
 */
export interface CapturedRefusal {
  status: number;
  body: { error: { code: string; message: string; requestId: string; details?: { issues?: { path: string; code: string }[] } } };
}

/** The filter writes through `host.switchToHttp().getResponse()`; this is the smallest thing that is one. */
export function runFilter(exception: unknown): CapturedRefusal {
  const captured: Partial<CapturedRefusal> = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload as CapturedRefusal['body'];
      return this;
    },
    setHeader() {
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  new GlobalExceptionFilter(logger as never).catch(exception, host);
  if (captured.status === undefined || captured.body === undefined) throw new Error('the filter wrote no response');
  return captured as CapturedRefusal;
}

/**
 * Runs a schema over a body. Returns the ZodError, or null when it ACCEPTED
 * the body. A schema that throws something other than a ZodError (a refinement
 * dereferencing data an earlier issue left malformed) is a 500 in production,
 * so it is NOT swallowed here: it propagates and fails the case.
 */
export function refusalOf(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown): ZodError | null {
  const r = schema.safeParse(value);
  return r.success ? null : (r.error as ZodError);
}
