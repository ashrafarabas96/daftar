import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Request-scoped correlation context (§99): request id + actor/tenant/business. */
export interface RequestContextData {
  requestId: string;
  userId?: string;
  tenantId?: string;
  businessId?: string;
}

const als = new AsyncLocalStorage<RequestContextData>();

export function runWithContext<T>(fn: () => T): T {
  return als.run({ requestId: randomUUID() }, fn);
}

export function getContext(): RequestContextData | undefined {
  return als.getStore();
}

export function patchContext(patch: Partial<Omit<RequestContextData, 'requestId'>>): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}
