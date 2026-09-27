'use client';
/**
 * What every purchasing and supplier page loads first (P3-S7 contract A-11):
 * the session, the caller's own Phase 3 grants (`GET /v1/inventory/access`)
 * and the business (its id and currency). The grants are advisory — they
 * only decide which actions a page offers; every read and command still
 * enforces its own authority on the server.
 *
 * A 403 on this load renders the permission state, any other failure the
 * data-safe state with a retry (§3(b), (d)).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BusinessSettingsDto } from '@daftar/shared-contracts';
import { refreshSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getCurrentBusiness } from '@/lib/merchant-api';
import { getInventoryAccess, type InventoryAccessDto, type Phase3Permission } from '@/lib/phase3-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import type { PageStatus } from '@/views/common/feedback';

export interface MerchantContext {
  access: InventoryAccessDto;
  business: BusinessSettingsDto;
  /** True when the caller holds the permission (advisory: the server decides). */
  can: (permission: Phase3Permission) => boolean;
}

export interface MerchantContextState {
  status: PageStatus | 'ready';
  context: MerchantContext | null;
  retry: () => void;
}

/** A load failure as a page status: a 403 is the permission state, anything else the data-safe retry. */
export function statusOfFailure(error: unknown): PageStatus {
  return isPermissionRefusal(error) ? 'denied' : 'failed';
}

export function useMerchantContext(locale: Locale): MerchantContextState {
  const router = useRouter();
  const [status, setStatus] = useState<PageStatus | 'ready'>('loading');
  const [context, setContext] = useState<MerchantContext | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const [access, business] = await Promise.all([getInventoryAccess(), getCurrentBusiness()]);
        if (!live) return;
        const granted = new Set<string>(access.permissions);
        setContext({ access, business, can: (permission) => granted.has(permission) });
        setStatus('ready');
      } catch (error) {
        if (live) setStatus(statusOfFailure(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, context, retry };
}
