import { z } from 'zod';
import { PAYMENT_METHOD_NAME_MAX, PAYMENT_METHOD_SORT_ORDER_MAX, PAYMENT_METHOD_SYSTEM_TYPES } from '@daftar/inventory';

/**
 * The payment-method requests (PHASE_3_S6_CONTRACT A-06, A-18).
 *
 * Every schema is `.strict()`, as every Phase 3 request: tenant, business,
 * actor, a trace id, a revision the server owns, `isActive` or any authority
 * flag is refused as an unknown key (mass-assignment defence, §94).
 *
 * Ids are canonical LOWERCASE uuids, refused otherwise and never lower-cased
 * into acceptance: the `invpl/1` payload signs the exact spelling.
 *
 * A name is judged here only for its type; its shape — at least one locale
 * (`payment_method.name_required`), each 1..100 characters after trimming
 * with no NUL (`payment_method.name_invalid`) — is the payload builder's
 * judgement, so the typed code, not a generic validation failure, reaches the
 * client (the same codes the routine and the guard raise behind it).
 */

/** The largest revision a command may name: the `INTEGER` column's range. */
const MAX_REVISION = 2_147_483_647;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** One display name: any string (its shape is typed by the builder), or none. Bounded so no body is unbounded. */
const name = z
  .string()
  .max(PAYMENT_METHOD_NAME_MAX * 8)
  .nullish();

const names = z.object({ ar: name, en: name, tr: name }).strict();

const methodFields = {
  postingAccountId: uuid,
  requiresReference: z.boolean(),
  sortOrder: z.number().int().min(0).max(PAYMENT_METHOD_SORT_ORDER_MAX),
  names,
};

/** `POST /v1/payment-methods`. The method id is the client's idempotency key. `systemType` is fixed for ever (A-06). */
export const PaymentMethodCreateSchema = z
  .object({
    paymentMethodId: uuid,
    systemType: z.enum(PAYMENT_METHOD_SYSTEM_TYPES),
    ...methodFields,
  })
  .strict();

/** `PUT /v1/payment-methods/:paymentMethodId`: the whole method at the revision the client read. */
export const PaymentMethodUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(MAX_REVISION),
    ...methodFields,
  })
  .strict();

/** `POST /v1/payment-methods/:paymentMethodId/deactivate` and `/activate`. */
export const PaymentMethodLifecycleSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(MAX_REVISION),
  })
  .strict();

export type PaymentMethodCreateRequest = z.infer<typeof PaymentMethodCreateSchema>;
export type PaymentMethodUpdateRequest = z.infer<typeof PaymentMethodUpdateSchema>;
export type PaymentMethodLifecycleRequest = z.infer<typeof PaymentMethodLifecycleSchema>;
