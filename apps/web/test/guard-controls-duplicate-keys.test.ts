import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Duplicate-key guard for the three message catalogs, plus the one registry
 * duplicate that nothing else catches.
 *
 * WHY TEXT, NOT JSON.parse: JSON.parse accepts a duplicate key and keeps the
 * last value, so every other web test (which imports the parsed catalogs)
 * stays green while one translation silently shadows another. A raw-text scan
 * of the top-level key lines sees it. The catalogs are flat (one key per line,
 * two-space indent), which the floor below also proves.
 *
 * WHAT IS ALREADY PROTECTED, MEASURED (not assumed), `npx tsc --noEmit` in apps/web:
 *   - PAGE_AREAS (test/helpers/registries.ts), an object literal: a planted
 *     duplicate property fails with TS1117, exit 2. NOT covered here.
 *   - NAV in src/app/[locale]/AppHeader.tsx, an ARRAY of {key,path}: a planted
 *     duplicate `key` value is NOT a type error, tsc exit 0. So it is covered
 *     here (last describe block).
 *   - The catalogs: nothing. check-localization checks parity and emptiness,
 *     error-keys reads the parsed object. Covered here.
 * The other view registries (VIEW_REGISTRY arrays) were NOT measured.
 */
const WEB = join(__dirname, '..');
const LOCALES = ['ar', 'en', 'tr'] as const;
const FLOOR = 900; // measured on the tree: 923 keys per locale

/** Keys that appear more than once among the top-level key lines of a JSON text, sorted. */
function duplicateKeys(text: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of text.matchAll(/^ {2}"([^"]+)":/gm)) {
    const key = m[1] as string;
    if (seen.has(key)) dup.add(key);
    seen.add(key);
  }
  return [...dup].sort();
}

function keyCount(text: string): number {
  return [...text.matchAll(/^ {2}"([^"]+)":/gm)].length;
}

const read = (locale: string): string => readFileSync(join(WEB, 'src', 'messages', `${locale}.json`), 'utf8');

describe('duplicateKeys() itself (positive control on a planted string)', () => {
  it('names a planted duplicate, once, and nothing else', () => {
    const text = '{\n  "a.one": "x",\n  "b.two": "y",\n  "a.one": "z",\n  "a.one": "w"\n}\n';
    expect(duplicateKeys(text)).toEqual(['a.one']);
    expect(() => void JSON.parse(text)).not.toThrow(); // the reason this scan exists
  });
  it('is quiet on a clean string and ignores nested or indented-deeper keys', () => {
    expect(duplicateKeys('{\n  "a": "x",\n  "b": "y"\n}\n')).toEqual([]);
    expect(duplicateKeys('{\n  "a": {\n    "k": 1\n  },\n  "b": {\n    "k": 2\n  }\n}\n')).toEqual([]);
  });
});

describe('the real catalogs hold no duplicate key', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json: scanned set is non-empty (floor ${FLOOR}) and has no duplicate key`, () => {
      const text = read(locale);
      expect(keyCount(text)).toBeGreaterThanOrEqual(FLOOR);
      expect(duplicateKeys(text)).toEqual([]);
    });
  }
});

describe('CLAIM: invoices.list.issued was removed deliberately (main, 95b7b45b) and stays removed', () => {
  const KEY = 'invoices.list.issued';

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx|js|jsx|mjs|json)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('is absent from all three catalogs', () => {
    for (const locale of LOCALES) {
      const catalog = JSON.parse(read(locale)) as Record<string, string>;
      expect(Object.keys(catalog), `${locale}.json`).not.toContain(KEY);
    }
  });

  it('has zero references under apps/web/src and apps/web/test (this file excluded)', () => {
    const files = [...sourceFiles(join(WEB, 'src')), ...sourceFiles(join(WEB, 'test'))].filter((f) => f !== __filename);
    expect(files.length).toBeGreaterThan(100); // the scan reads a real tree
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(KEY)).map((f) => relative(WEB, f).split(sep).join('/'));
    expect(hits).toEqual([]);
  });
});

describe('AppHeader NAV has no duplicate key or path (an array, so tsc does not catch it)', () => {
  const src = readFileSync(join(WEB, 'src', 'app', '[locale]', 'AppHeader.tsx'), 'utf8');
  const block = /const NAV = \[([\s\S]*?)\] as const satisfies/.exec(src)?.[1] ?? '';
  const keys = [...block.matchAll(/\{\s*key:\s*'([^']+)'\s*,\s*path:\s*'([^']+)'/g)];

  it('the scan reads a real NAV (floor 10 entries; 13 measured)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });
  it('every key and every path appears once', () => {
    const dupOf = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);
    expect(dupOf(keys.map((m) => m[1] as string))).toEqual([]);
    expect(dupOf(keys.map((m) => m[2] as string))).toEqual([]);
  });
});
