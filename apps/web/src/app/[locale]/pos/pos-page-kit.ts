'use client';
/**
 * What both POS screens do before they show anything (P4-S3), in the shape of
 * `stock/stock-page-kit.ts`: the Phase 1 page pattern — `ensureSession()` on
 * mount, else to login — then the one till this user has open
 * (`GET /v1/pos/till-sessions/current`, `OD-P4-09`), the WAREHOUSES a till may
 * be opened in, the business currency the till is counted in, and the unit
 * names the type-ahead's hits are shown with.
 *
 * It reads WAREHOUSES and not branches. `TillSessionOpenSchema` requires both
 * a `branchId` and a `warehouseId`, and `GET /v1/businesses/current/warehouses`
 * answers `{ id, branchId, name }` — so one read supplies both identities and
 * the screen never pairs a branch with a warehouse itself. A branch list could
 * not have supplied the warehouse at all, which is why opening a till used to
 * be refused for two missing keys.
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
import { currentBusinessId, ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getMyBusinesses, listWarehouses } from '@/lib/merchant-api';
import { listInventoryUnits } from '@/lib/phase3-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import { getCurrentTill, type PosTillSessionDto } from '@/lib/phase4-pos-api';
import type { PosSellingPlace } from '@/views/pos/TillView';

export type PosScreenPhase = 'loading' | 'ready' | 'denied' | 'failed';

export interface PosScreen {
  readonly phase: PosScreenPhase;
  /** The warehouses a till may be opened in, each carrying its own home branch. */
  readonly places: readonly PosSellingPlace[];
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

/**
 * The physical till this browser is, as `terminalCode` on the open.
 *
 * `TillSessionOpenSchema` holds it to the `invpl/1` `code` grammar
 * (`^[a-z][a-z0-9_]{0,31}$`), which is also the grammar
 * `pos_till_sessions_terminal_code_ck` holds the column to, and
 * `pos_till_sessions_one_open_per_terminal_uq` makes one open session per
 * terminal per business. So this is a CONSTANT and not a generated id: the web
 * register is one named till, and a per-tab value would let the same cashier
 * open a second till by opening a second tab — which is exactly what
 * `pos.terminal_already_open` exists to refuse. A merchant who runs two real
 * drawers needs a screen that names them, and that screen does not exist yet.
 */
export const POS_WEB_TERMINAL_CODE = 'web';

export function usePosScreen(locale: Locale): PosScreen {
  const router = useRouter();
  const [phase, setPhase] = useState<PosScreenPhase>('loading');
  const [places, setPlaces] = useState<readonly PosSellingPlace[]>([]);
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
        const [current, warehouses, businesses] = await Promise.all([getCurrentTill(), listWarehouses(), getMyBusinesses()]);
        // The unit names are a courtesy: a cashier who may not read the
        // inventory catalogue still sells, and the unit shows as its code.
        const units = await listInventoryUnits().catch(() => ({ items: [] }));
        if (!live) return;
        // The route answers the session or a bare null, never an envelope.
        setTill(current);
        setPlaces(warehouses.items.map((w) => ({ id: w.id, branchId: w.branchId, name: w.name })));
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
  return { phase, places, unitNames, currency, till, setTill, reload };
}
