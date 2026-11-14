import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findPostingSurfaceViolations } from '../../../scripts/guards/posting-surface';
import { createSandbox, type Sandbox } from './helpers/guard-sandbox';
import { REPO_ROOT } from './helpers/refusal-codes';

/**
 * Positive and negative controls for the repository guards that apply to
 * apps/web. A guard that scans nothing, or that cannot go red, proves nothing.
 *
 * The guard SCRIPTS run at import time from a root derived from __dirname, so
 * they are driven through a copy of the tree (helpers/guard-sandbox.ts); the
 * scripts are never edited. The pure guard functions are called directly.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src');
const MIGRATIONS = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, re, out);
    else if (re.test(entry)) out.push(full);
  }
  return out;
}

const failLines = (out: string): string[] => out.split('\n').filter((l) => l.includes('FAIL ['));
const hits = (out: string, rule: string, file: string): string[] => failLines(out).filter((l) => l.includes(`[${rule}]`) && l.includes(file));

describe('the web scope the guards read is not empty (floor measured on the tree: 95 ts/tsx files)', () => {
  it('apps/web/src holds at least 90 ts/tsx files for R1, R6b, R14 and R17 to read', () => {
    expect(walk(WEB_SRC, /\.(ts|tsx)$/).length).toBeGreaterThanOrEqual(90);
  });
});

describe('static-guards on apps/web/src (R1, R6b, R14, R17) — the real script over a planted tree', () => {
  // Measured: the guard's logic on a temp copy of the tree, NOT that CI reaches the guard.
  let box: Sandbox;
  beforeAll(() => {
    box = createSandbox();
  });
  afterAll(() => box.dispose());

  const PLANTS: Record<string, string> = {
    'apps/web/src/__plant_money.ts': [
      '// Number(amountMinor) in a comment is allowed to name the anti-pattern',
      'export const ok = Number(rows.length);',
      'export const bad = Number(row.amountMinor);',
      'export const bad2 = parseFloat(priceText);',
      '',
    ].join('\n'),
    'apps/web/src/__plant_pg.ts': "import { Pool } from 'pg';\nexport const p = Pool;\n",
    'apps/web/src/__plant_nest.ts': "import { Injectable } from '@nestjs/common';\nexport const i = Injectable;\n",
    'apps/web/src/__plant_role.ts': "export const role = 'daftar_migrator';\n",
    'apps/web/src/__plant_migcreds.ts': 'export const u = process.env.MIGRATION_DATABASE_URL;\n',
    'apps/web/src/__plant_ledger.ts': 'export const sql = "INSERT INTO journal_lines (id) VALUES (1)";\n',
  };

  it('a clean web tree stays green (the sandbox is a faithful copy of the real tree)', () => {
    const { status, out } = box.run('static-guards.ts');
    expect(out).toContain('STATIC GUARDS: PASS');
    expect(status).toBe(0);
    expect(failLines(out).filter((l) => l.includes('apps/web'))).toEqual([]);
  });

  it('every planted violation goes red under the right rule, in its own file', () => {
    for (const [rel, src] of Object.entries(PLANTS)) box.put(rel, src);
    let result: { status: number | null; out: string };
    try {
      result = box.run('static-guards.ts');
    } finally {
      for (const rel of Object.keys(PLANTS)) box.restore(rel);
    }
    const { status, out } = result;
    expect(status).toBe(1);
    const money = hits(out, 'money-no-number-conversion', '__plant_money.ts');
    expect(money).toHaveLength(2); // lines 3 and 4; the comment and Number(rows.length) stay clean
    expect(money.join('\n')).toMatch(/line 3[\s\S]*line 4/);
    expect(hits(out, 'no-direct-db', '__plant_pg.ts')).toHaveLength(1);
    expect(hits(out, 'no-direct-db', '__plant_nest.ts')).toHaveLength(1);
    expect(hits(out, 'no-direct-db', '__plant_role.ts')).toHaveLength(1);
    expect(hits(out, 'no-migration-creds-in-runtime', '__plant_migcreds.ts')).toHaveLength(1);
    expect(hits(out, 'posting-surface', '__plant_ledger.ts')).toHaveLength(1);
  });

  it('removing the plants turns the same tree green again', () => {
    expect(box.run('static-guards.ts').status).toBe(0);
  });
});

describe('R17 posting-surface called directly with a web path', () => {
  // Measured: the guard's logic on a temp copy of the tree, NOT that CI reaches the guard.
  const schema = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

  it('the real migrations plus the real web sources are clean', () => {
    const appFiles: Record<string, string> = {};
    for (const f of walk(WEB_SRC, /\.(ts|tsx)$/))
      appFiles[
        f
          .slice(REPO_ROOT.length + 1)
          .split('\\')
          .join('/')
      ] = readFileSync(f, 'utf8');
    expect(Object.keys(appFiles).length).toBeGreaterThanOrEqual(90);
    expect(findPostingSurfaceViolations({ schema, appFiles }).filter((v) => v.includes('apps/web'))).toEqual([]);
  });

  it('a web file writing the ledger is refused, and a clean one is not', () => {
    const v = findPostingSurfaceViolations({
      schema,
      appFiles: { 'apps/web/src/x.ts': 'const q = "DELETE FROM journal_entries";', 'apps/web/src/clean.ts': 'export const a = 1;' },
    });
    expect(v.filter((m) => m.includes('apps/web/src/x.ts'))).toHaveLength(1);
    expect(v.filter((m) => m.includes('apps/web/src/clean.ts'))).toEqual([]);
  });
});

describe('check-localization (parity, empty, raw key, t() scan) — the real script over a planted tree', () => {
  let box: Sandbox;
  const MSG = (l: string): string => `apps/web/src/messages/${l}.json`;
  const real = (l: string): Record<string, string> => JSON.parse(readFileSync(join(REPO_ROOT, MSG(l)), 'utf8')) as Record<string, string>;
  const PLANT_T = 'apps/web/src/__plant_t.ts';
  beforeAll(() => {
    box = createSandbox();
  });
  afterAll(() => box.dispose());

  it('scans a non-empty set (floors measured: 923 keys per locale, 735 single-quoted t() calls) and the real tree is green', () => {
    for (const l of ['ar', 'en', 'tr']) expect(Object.keys(real(l)).length).toBeGreaterThanOrEqual(900);
    let calls = 0;
    for (const f of walk(WEB_SRC, /\.(ts|tsx)$/)) calls += [...readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-z][\w.]+)'\s*[,)]/g)].length;
    expect(calls).toBeGreaterThanOrEqual(700);
    const { status, out } = box.run('check-localization.ts');
    expect(out).toMatch(/LOCALIZATION CHECK: PASS \(\d+ keys/);
    expect(status).toBe(0);
  });

  const scenarios: [string, () => void, RegExp][] = [
    [
      'a key missing from tr',
      () => {
        const d = real('tr');
        delete d[Object.keys(d)[5] ?? ''];
        box.put(MSG('tr'), JSON.stringify(d));
      },
      /catalog tr: key mismatch/,
    ],
    ['an extra key in en', () => box.put(MSG('en'), JSON.stringify({ ...real('en'), 'zz.extra_key': 'x' })), /catalog en: key mismatch/],
    [
      'an empty value',
      () => {
        const d = real('en');
        d[Object.keys(d)[3] ?? ''] = '   ';
        box.put(MSG('en'), JSON.stringify(d));
      },
      /catalog en: empty value for key/,
    ],
    [
      'a raw key as its own value',
      () => {
        const d = real('ar');
        const k = Object.keys(d)[3] ?? '';
        d[k] = k;
        box.put(MSG('ar'), JSON.stringify(d));
      },
      /catalog ar: raw key rendered as value/,
    ],
    [
      'a value that looks like an untranslated key',
      () => {
        const d = real('tr');
        d[Object.keys(d)[3] ?? ''] = 'stock.page.title';
        box.put(MSG('tr'), JSON.stringify(d));
      },
      /looks like an untranslated key/,
    ],
    [
      'a t() call to an unknown key',
      () => box.put(PLANT_T, "export const f = (t: (k: string) => string) => t('zz.no_such_key_anywhere');\n"),
      /t\('zz\.no_such_key_anywhere'\) references an unknown key/,
    ],
  ];
  it.each(scenarios)('%s goes red', (_name, plant, expected) => {
    let result: { status: number | null; out: string };
    try {
      plant();
      result = box.run('check-localization.ts');
    } finally {
      for (const rel of [MSG('ar'), MSG('en'), MSG('tr'), PLANT_T]) box.restore(rel);
    }
    const { status, out } = result;
    expect(out).toMatch(expected);
    expect(status).toBe(1);
  });

  it('DOCUMENTED BLIND SPOT: the t() scan reads single-quoted keys only, so a template-literal call to an unknown key passes', () => {
    let result: { status: number | null; out: string };
    try {
      box.put('apps/web/src/__plant_blind.ts', 'export const f = (t: (k: string) => string, n: string) => t(`zz.tpl_${n}`);\n');
      result = box.run('check-localization.ts');
    } finally {
      box.restore('apps/web/src/__plant_blind.ts');
    }
    // Asserts the CURRENT behaviour, so closing the gap shows up as a deliberate change to this test.
    expect(result.out).not.toMatch(/zz\.tpl_/);
    expect(result.status).toBe(0);
  });

  it('pins the live template-literal t() calls the scan cannot read (10 outside AppHeader, whose nav keys are enumerated)', () => {
    // The red here is INTENTIONAL when a new template-literal t() call appears: its key is checked by no gate.
    // The only exits: convert the call to a single-quoted literal key, or update the number with the old and
    // the new value stated in the commit message. Never raise it silently.
    let live = 0;
    for (const f of walk(WEB_SRC, /\.(ts|tsx)$/)) {
      if (f.endsWith('AppHeader.tsx')) continue;
      live += [...readFileSync(f, 'utf8').matchAll(/\bt\(\s*`/g)].length;
    }
    // Measured: 10. Raising this number means a NEW call whose key no gate checks; lower it only when the scan learns templates.
    expect(live).toBe(10);
  });
});
