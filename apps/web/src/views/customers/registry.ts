/**
 * The customer views the SSR suites render (T-08, T-15, T-16), in the shape of
 * `suppliers/registry.ts`. Each entry's fixtures live beside its view.
 */
import type { ViewEntry } from '@/lib/phase3-format';
import { CUSTOMER_ACCOUNT_VIEW } from './account-registry';

export const VIEW_REGISTRY: readonly ViewEntry[] = [CUSTOMER_ACCOUNT_VIEW];
