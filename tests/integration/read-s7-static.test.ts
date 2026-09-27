import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULE_CACHE } from '../../scripts/guards/read-surface';
import { isS7WebFile, stripTsComments } from '../../scripts/guards/merchant-jargon';

/**
 * T-02 (P3-S7 contract §6, A-03; MP-1): the S7 reads are live. The read
 * modules hold no module-level result cache, the S7 web files keep nothing
 * in browser storage, and the Phase 3 client issues every GET with
 * `cache: 'no-store'`. Each rule is shown red on a planted fixture first.
 */

const ROOT = join(__dirname, '../..');

/** The S7 read modules (contract §8, R's row): every file that serves an S7 GET. */
const S7_READ_MODULES = [
  'apps/api/src/modules/inventory/inventory-reads.ts',
  'apps/api/src/modules/inventory/inventory-reads.controller.ts',
  'apps/api/src/modules/inventory/read-scope.ts',
  'apps/api/src/modules/purchasing/supplier-balance-reads.ts',
  'apps/api/src/modules/purchasing/supplier-balances.controller.ts',
  'apps/api/src/modules/payment-methods/payment-method-defaults.controller.ts',
] as const;

const PHASE3_API = 'apps/web/src/lib/phase3-api.ts';

/** Browser storage of any kind: business data never lives on the device (A-03, MP-1). */
const BROWSER_STORAGE = /\b(?:localStorage|sessionStorage|indexedDB)\b|\bcaches\s*\./;

const moduleCache = (source: string): string | null => MODULE_CACHE.exec(stripTsComments(source))?.[0] ?? null;
const browserStorage = (source: string): string | null => BROWSER_STORAGE.exec(stripTsComments(source))?.[0] ?? null;

/** Every `apiFetch(…)` call in `source` with its argument text, balanced on parentheses. */
function apiFetchCalls(source: string): string[] {
  const code = stripTsComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/\bapiFetch\s*(?:<[^>(]*>)?\s*\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
      i += 1;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

function webFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) out[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(join(ROOT, 'apps/web/src'));
  return out;
}

describe('T-02 — the rules fire (planted fixtures)', () => {
  it('a module-level Map is a cache, and a Map inside a function is not', () => {
    expect(moduleCache('import { x } from "y";\nconst cache = new Map();\nexport function read() { return cache; }')).toBe('const cache = new Map');
    expect(moduleCache('export const seen: Set<string> = new Set();')).not.toBeNull();
    expect(moduleCache('let byId = new WeakMap();')).not.toBeNull();
    expect(moduleCache("import Redis from 'ioredis';")).not.toBeNull();
    expect(moduleCache("import { LRUCache } from 'lru-cache';")).not.toBeNull();
    expect(moduleCache('export const read = memoize(load);')).not.toBeNull();
    expect(moduleCache('class R {\n  @Memoize()\n  read() {}\n}')).not.toBeNull();
    expect(moduleCache('export function group(rows: string[]) {\n  const byId = new Map<string, string>();\n  return byId;\n}')).toBeNull();
    expect(moduleCache('// const cache = new Map();\nexport const x = 1;')).toBeNull();
  });

  it('browser storage in any form is found, and a word that merely contains it is not', () => {
    for (const bad of ["localStorage.setItem('stock', rows)", 'window.sessionStorage.getItem(k)', "indexedDB.open('daftar')", "await caches.open('reads')"]) {
      expect(browserStorage(bad), bad).not.toBeNull();
    }
    expect(browserStorage('const noLocalStorageHere = 1; const cachesOpened = 0;')).toBeNull();
  });

  it('an apiFetch call is read whole, so a missing no-store is visible', () => {
    const calls = apiFetchCalls("const a = apiFetch<T>(path, { cache: 'no-store' });\nconst b = apiFetch(`${BFF}/x/${seg(id)}`, { method: 'GET' });");
    expect(calls).toEqual(["path, { cache: 'no-store' }", "`${BFF}/x/${seg(id)}`, { method: 'GET' }"]);
    expect(calls.filter((c) => !/\bcache\s*:\s*'no-store'/.test(c))).toHaveLength(1);
  });
});

describe('T-02 — the S7 reads are live', () => {
  it('the S7 read modules exist', () => {
    expect(S7_READ_MODULES.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it('no S7 read module holds a module-level result cache', () => {
    const found = S7_READ_MODULES.filter((p) => existsSync(join(ROOT, p))).flatMap((p) => {
      const hit = moduleCache(readFileSync(join(ROOT, p), 'utf8'));
      return hit === null ? [] : [`${p}: ${hit}`];
    });
    expect(found).toEqual([]);
  });

  it('no S7 web file uses browser storage, and there are S7 web files to check', () => {
    const files = Object.entries(webFiles()).filter(([p]) => isS7WebFile(p));
    expect(files.map(([p]) => p)).toContain(PHASE3_API);
    const found = files.flatMap(([p, source]) => {
      const hit = browserStorage(source);
      return hit === null ? [] : [`${p}: ${hit}`];
    });
    expect(found).toEqual([]);
  });

  it('phase3-api.ts issues every request, and so every GET, with cache: no-store', () => {
    const source = readFileSync(join(ROOT, PHASE3_API), 'utf8');
    const calls = apiFetchCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !/\bcache\s*:\s*'no-store'/.test(c))).toEqual([]);
    // No path around apiFetch: no bare fetch, no XHR.
    expect(stripTsComments(source)).not.toMatch(/(?<![\w.])fetch\s*\(|XMLHttpRequest/);
  });

  it('every GET export of phase3-api.ts goes through read(), and read() is the only method-less call', () => {
    const code = stripTsComments(readFileSync(join(ROOT, PHASE3_API), 'utf8'));
    const exports = [...code.matchAll(/^export const (\w+)\s*=([\s\S]*?)(?=^export const |^\/\/ ──|$(?![\s\S]))/gm)].map((m) => ({
      name: m[1] ?? '',
      body: m[2] ?? '',
    }));
    expect(exports.length).toBeGreaterThanOrEqual(40);
    const astray = exports.filter(({ body }) => !/\b(?:read|send)\s*</.test(body)).map(({ name }) => name);
    expect(astray).toEqual([]);
    // A call without `method` is a GET; there must be exactly one, inside read().
    const gets = apiFetchCalls(code).filter((c) => !/\bmethod\b/.test(c));
    expect(gets).toEqual(["path, { cache: 'no-store' }"]);
  });
});
