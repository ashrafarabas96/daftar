'use client';
/**
 * What both POS screens do before they show anything (P4-S3), in the shape of
 * `stock/stock-page-kit.ts`: the Phase 1 page pattern — `ensureSession()` on
 * mount, else to login — then the one till this user has open
 * (`GET /v1/pos/till-sessions/current`, `OD-P4-09`), the branches they may
 * open a till in, the business currency the till is counted in, and the unit
 * names.
 *
 * THERE IS NO POS ACCESS READ, deliberately. The POS routes name `sales.view`
 * and `sales.create`, the Phase 4 permission registry is closed, and no
 * endpoint answers "what may I do at the till". So the screen asks the server
 * and renders its answer: a 403 on load is `common.noPermission` (§3(b)), any
 * other failed load is the data-safe load failure, and a 403 on a command is
 * the mapped refusal text. Nothing is hidden on a guess about authority.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BranchDto } from '@daftar/shared-contracts';
import { currentBusinessId, ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getMyBusinesses, listBranches } from '@/lib/merchant-api';
import { listInventoryUnits } from '@/lib/phase3-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import { getCurrentTill, type PosTillSessionDto } from '@/lib/phase4-pos-api';

export type PosScreenPhase = 'loading' | 'ready' | 'denied' | 'failed';

export interface PosScreen {
  readonly phase: PosScreenPhase;
  readonly branches: readonly BranchDto[];
  readonly unitNames: Readonly<Record<string, string>>;
  /** The business currency: what the till is counted in and what prices are shown in. */
  readonly currency: string | null;
  /** The one till this user has open, or null. */
  readonly till: PosTillSessionDto | null;
  readonly setTill: (session: PosTillSessionDto | null) => void;
  readonly reload: () => void;
}

/**
 * How long the register waits after a keystroke before it searches, and the
 * shortest text it searches at all. The POS type-ahead is PACED here — a
 * handful of reads per sale — rather than by asking for a bigger allowance
 * anywhere.
 */
export const POS_SEARCH_DELAY_MS = 300;
export const POS_SEARCH_MIN_CHARS = 2;

export function usePosScreen(locale: Locale): PosScreen {
  const router = useRouter();
  const [phase, setPhase] = useState<PosScreenPhase>('loading');
  const [branches, setBranches] = useState<readonly BranchDto[]>([]);
  const [unitNames, setUnitNames] = useState<Readonly<Record<string, string>>>({});
  const [currency, setCurrency] = useState<string | null>(null);
  const [till, setTill] = useState<PosTillSessionDto | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      setPhase('loading');
      if (!(await ensureSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const [current, places, businesses] = await Promise.all([getCurrentTill(), listBranches(), getMyBusinesses()]);
        // The unit names are a courtesy: a cashier who may not read the
        // inventory catalogue still sells, and the unit shows as its code.
        const units = await listInventoryUnits().catch(() => ({ items: [] }));
        if (!live) return;
        setTill(current.session);
        setBranches(places.items);
        setCurrency(businesses.items.find((b) => b.businessId === currentBusinessId())?.baseCurrency ?? null);
        setUnitNames(Object.fromEntries(units.items.map((unit) => [unit.unitCode, unit.name])));
        setPhase('ready');
      } catch (error) {
        if (!live) return;
        setPhase(isPermissionRefusal(error) ? 'denied' : 'failed');
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { phase, branches, unitNames, currency, till, setTill, reload };
}
