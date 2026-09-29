'use client';
/**
 * What every stock page does before it shows its screen (P3-S7 A-11): the
 * Phase 1 page pattern — `ensureSession()` on mount, else to login — then
 * the caller's own grants (`GET /v1/inventory/access`, advisory), the
 * warehouses it reaches, the unit names and the business currency.
 *
 * A member without the screen's permission gets `common.noPermission`
 * without a single command being tried; a refused load renders the
 * permission state on a 403 and the data-safe load failure otherwise (§3(b)).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, currentBusinessId, ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getMyBusinesses } from '@/lib/merchant-api';
import {
  getInventoryAccess,
  listInventoryItems,
  listInventoryUnits,
  listInventoryWarehouses,
  listStock,
  type InventoryAccessDto,
  type InventoryWarehouseDto,
  type Phase3Permission,
} from '@/lib/phase3-api';
import { isPermissionRefusal, refusalKey } from '@/lib/phase3-errors';
import { itemOptions, stockRowOptions, type PickOption } from '@/views/stock/model';

export type ScreenPhase = 'loading' | 'ready' | 'denied' | 'failed';

export interface InventoryScreen {
  readonly phase: ScreenPhase;
  readonly access: InventoryAccessDto | null;
  readonly warehouses: readonly InventoryWarehouseDto[];
  readonly unitNames: Readonly<Record<string, string>>;
  /** The business currency code (costs are typed in it), or null when unknown. */
  readonly currency: string | null;
  readonly can: (permission: Phase3Permission) => boolean;
  readonly reload: () => void;
  readonly reloadWarehouses: () => Promise<void>;
}

/** Load the screen's context; `anyOf` is the permission set that may see the screen. */
export function useInventoryScreen(locale: Locale, anyOf: readonly Phase3Permission[]): InventoryScreen {
  const router = useRouter();
  const [phase, setPhase] = useState<ScreenPhase>('loading');
  const [access, setAccess] = useState<InventoryAccessDto | null>(null);
  const [warehouses, setWarehouses] = useState<readonly InventoryWarehouseDto[]>([]);
  const [unitNames, setUnitNames] = useState<Readonly<Record<string, string>>>({});
  const [currency, setCurrency] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const required = anyOf.join(',');

  useEffect(() => {
    let live = true;
    void (async () => {
      setPhase('loading');
      if (!(await ensureSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const granted = await getInventoryAccess();
        if (!live) return;
        setAccess(granted);
        if (!required.split(',').some((p) => granted.permissions.some((g) => g === p))) {
          setPhase('denied');
          return;
        }
        const [w, u, b] = await Promise.all([listInventoryWarehouses(), listInventoryUnits(), getMyBusinesses()]);
        if (!live) return;
        setWarehouses(w.items);
        setUnitNames(Object.fromEntries(u.items.map((unit) => [unit.unitCode, unit.name])));
        setCurrency(b.items.find((x) => x.businessId === currentBusinessId())?.baseCurrency ?? null);
        setPhase('ready');
      } catch (error) {
        if (!live) return;
        if (isPermissionRefusal(error)) {
          setPhase('denied');
          return;
        }
        setPhase('failed');
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, required, attempt]);

  const can = useCallback((permission: Phase3Permission) => access?.permissions.includes(permission) ?? false, [access]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const reloadWarehouses = useCallback(async () => {
    const w = await listInventoryWarehouses();
    setWarehouses(w.items);
  }, []);
  return { phase, access, warehouses, unitNames, currency, can, reload, reloadWarehouses };
}

/** The first active warehouse, for a screen that must show one. */
export function firstActiveWarehouse(warehouses: readonly InventoryWarehouseDto[]): string {
  return warehouses.find((w) => w.status === 'active')?.warehouseId ?? '';
}

/** The warehouse a form starts with: pre-selected only when exactly one is active. */
export function onlyActiveWarehouse(warehouses: readonly InventoryWarehouseDto[]): string {
  const active = warehouses.filter((w) => w.status === 'active');
  return active.length === 1 ? (active[0]?.warehouseId ?? '') : '';
}

/**
 * The lines a refusal names, from its typed details — `inventory.unit_cost_required`
 * lists the lines that need a cost (A-13). Null when the refusal names none.
 */
export function refusedLines(error: unknown): { productId: string; variantId: string | null }[] | null {
  if (!(error instanceof ApiError)) return null;
  const lines = error.details?.['lines'];
  if (!Array.isArray(lines)) return null;
  const out: { productId: string; variantId: string | null }[] = [];
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) continue;
    const productId: unknown = Reflect.get(line, 'productId');
    const variantId: unknown = Reflect.get(line, 'variantId');
    if (typeof productId !== 'string') continue;
    out.push({ productId, variantId: typeof variantId === 'string' ? variantId : null });
  }
  return out;
}

/** Wait briefly after typing before searching, so each keystroke is not a request. */
export const SEARCH_DELAY_MS = 250;

/**
 * The items a form may add, for the current search.
 *
 * - `stock`: the rows of `GET /v1/inventory/stock` for the warehouse — each
 *   already one stock identity, with what is there now (Move and Adjust Stock,
 *   for a member who may see stock);
 * - `items`: `GET /v1/inventory/items`, with no quantity (Count Stock, where
 *   the counter must not see the expected figure, TL-8; and Move/Adjust for a
 *   member without `inventory.view`).
 */
export function usePickOptions(
  source: 'stock' | 'items',
  warehouseId: string,
  search: string,
  enabled: boolean,
): { options: PickOption[] | null; errorKey: string | null } {
  const [options, setOptions] = useState<PickOption[] | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || (source === 'stock' && warehouseId === '')) {
      setOptions(null);
      return;
    }
    let live = true;
    const text = search.trim();
    const query = text.length > 0 ? text : undefined;
    const timer = setTimeout(
      () => {
        const load =
          source === 'stock'
            ? listStock({ warehouseId, search: query }).then((page) => stockRowOptions(page.items))
            : listInventoryItems({ search: query, trackedOnly: true }).then((page) => itemOptions(page.items));
        load
          .then((found) => {
            if (!live) return;
            setOptions(found);
            setErrorKey(null);
          })
          .catch((error: unknown) => {
            if (!live) return;
            setOptions([]);
            setErrorKey(refusalKey(error));
          });
      },
      text.length > 0 ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, warehouseId, search, enabled]);
  return { options, errorKey };
}
