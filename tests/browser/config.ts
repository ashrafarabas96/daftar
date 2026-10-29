/**
 * What the browser gate covers, in one place: the three platform locales, the
 * three viewport classes (directive §8's suggested sizes), and the design
 * system's own minimum touch target, read from its tokens rather than copied.
 */
import { TOUCH_TARGET } from '../../packages/design-system/src/tokens';

export type Locale = 'ar' | 'en' | 'tr';
export const LOCALES: readonly Locale[] = ['ar', 'en', 'tr'];

export interface Viewport {
  readonly name: 'phone' | 'tablet' | 'desktop';
  readonly width: number;
  readonly height: number;
}

export const VIEWPORTS: readonly Viewport[] = [
  { name: 'phone', width: 360, height: 640 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

export const comboTag = (locale: Locale, viewport: Viewport): string => `${locale}-${viewport.width}`;

/** `TOUCH_TARGET` is a rem length; the root font size is the browser default of 16px. */
function remToPx(value: string): number {
  const match = /^([0-9.]+)rem$/.exec(value);
  if (match === null || match[1] === undefined) throw new Error(`TOUCH_TARGET is not a rem length: ${value}`);
  return Number(match[1]) * 16;
}
export const TOUCH_MIN_PX = remToPx(TOUCH_TARGET);

/** Ports inside the range the gate owns locally; CI may override them. */
export interface Ports {
  readonly pg: number;
  readonly api: number;
  readonly web: number;
}

export function portsFromEnv(): Ports {
  const n = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`${name} is not a port: ${raw}`);
    return value;
  };
  return { pg: n('BROWSER_PG_PORT', 56240), api: n('BROWSER_API_PORT', 56245), web: n('BROWSER_WEB_PORT', 56246) };
}

/**
 * The API's per-client-address auth allowances (apps/api/src/modules/auth/auth.service.ts).
 * Every browser the gate opens connects from the same loopback address, so
 * the gate paces itself below them instead of tripping a limiter a real
 * merchant never meets; a 429 that still happens is reported as an error.
 */
export const AUTH_WINDOW_MS = 300_000;
export const REFRESH_BUDGET = 55; // API: 60 per address per 5 minutes
export const LOGIN_BUDGET = 27; // API: 30 per address per 5 minutes
export const LOGIN_PER_ACCOUNT_BUDGET = 9; // API: 10 per address and account per 5 minutes

/**
 * The API's general allowance (`ThrottlerModule`, apps/api/src/app/runtime.ts):
 * 300 requests per minute for each route handler and client, on every HTTP
 * route. Every request a page makes through the BFF proxy counts, and the
 * gate's three locales drive the same pages at once from one machine, so the
 * busiest reads (the header's own `me/businesses` and `inventory/access`)
 * reach that allowance in a fast run. The gate paces each route below it.
 */
export const ROUTE_WINDOW_MS = 60_000;
/**
 * API: 300 per client and route handler per minute. The margin was 10% and it
 * was not enough: on a 20-core self-hosted runner the gate drives the matrix
 * several times faster than the 4-core hosted runner it was tuned on, and
 * `GET /api/proxy/inventory/access` — the one route the header AND four page
 * modules each read, so the busiest by a wide margin — answered 429 twelve
 * times in one run. The budget is now 80% of the allowance, so the margin is
 * a fifth of it rather than a tenth.
 *
 * The margin is what absorbs the gap between the moment this pacer releases a
 * request and the moment the API counts it; it is not a licence to leave a
 * request uncounted. `RouteCoverage` (pacer.ts) proves separately that every
 * proxied request passes this budget, because a wider margin would otherwise
 * hide an unpaced path instead of fixing it.
 */
export const ROUTE_BUDGET = 240;

/**
 * The negative control: with `BROWSER_GATE_NO_PACING=1` the budgets stop
 * WAITING, and the run is expected to meet the API's limiter and report 429.
 * Interception is untouched, so `RouteCoverage` still accounts for every
 * request — the control removes the pacing, not the proof that pacing is in
 * the path. Never set in CI's own gate steps; it exists so "the pacer is what
 * keeps the gate green" can be measured rather than asserted.
 */
export const pacingDisabled = (): boolean => process.env['BROWSER_GATE_NO_PACING'] === '1';
