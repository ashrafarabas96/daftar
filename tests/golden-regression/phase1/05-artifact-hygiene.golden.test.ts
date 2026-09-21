import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GOLDEN REGRESSION — Artifact Hygiene & Product Surfaces (P1-GOLD-33 … P1-GOLD-36).
 * Pure static checks: the release archive must never carry dev debris, and the
 * product surfaces must never bypass the API boundary.
 */
const ROOT = join(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.next', 'dist', 'coverage', '.gradle', 'build', 'release'].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('golden: artifact hygiene', () => {
  it('P1-GOLD-33 no forbidden artifacts in the repository tree', () => {
    const files = walk(ROOT).map((f) => relative(ROOT, f));
    const forbidden = files.filter(
      (f) =>
        /(^|\/)var\/dev-mailbox/.test(f) || /\.env($|\.)/.test(f) || /\.tsbuildinfo$/.test(f) || /\.(pem|key)$/.test(f) || /\.zip$/.test(f) || /\.log$/.test(f),
    );
    expect(forbidden).toEqual([]);
  });

  it('P1-GOLD-34 web/admin never import database or server-only infrastructure', () => {
    const surfaces = ['apps/web/src', 'apps/admin/src'];
    const offenders: string[] = [];
    for (const surface of surfaces) {
      for (const file of walk(join(ROOT, surface))) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const src = readFileSync(file, 'utf8');
        if (/from 'pg'|require\('pg'\)|@nestjs|DATABASE_URL|daftar_(app|platform|worker|migrator)/.test(src)) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('P1-GOLD-35 shared contracts never express money as float/number', () => {
    const files = walk(join(ROOT, 'packages/shared-contracts/src')).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/(amount|price|total|balance|cost|fee)(Minor)?\s*:/i.test(line) && /:\s*number\b/.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('P1-GOLD-36 ar/en/tr catalogs are in parity, non-empty, and the design system is RTL-aware', () => {
    const ar = JSON.parse(readFileSync(join(ROOT, 'apps/web/src/messages/ar.json'), 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync(join(ROOT, 'apps/web/src/messages/en.json'), 'utf8')) as Record<string, string>;
    const tr = JSON.parse(readFileSync(join(ROOT, 'apps/web/src/messages/tr.json'), 'utf8')) as Record<string, string>;
    const arKeys = Object.keys(ar).sort();
    expect(Object.keys(en).sort()).toEqual(arKeys);
    expect(Object.keys(tr).sort()).toEqual(arKeys);
    for (const dict of [ar, en, tr]) {
      for (const [k, v] of Object.entries(dict)) {
        expect(v.trim().length, `empty value for key ${k}`).toBeGreaterThan(0);
      }
    }
    const provider = readFileSync(join(ROOT, 'packages/design-system/src/provider.tsx'), 'utf8');
    expect(provider).toMatch(/dir.*rtl|rtl.*dir/s);
  });
});
