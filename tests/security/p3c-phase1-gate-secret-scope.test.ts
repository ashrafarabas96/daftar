/**
 * The Phase 1 release gate's raw-credential scan covers every source spelling
 * a release can execute or configure with — `.mts` (the web and admin
 * production entries), `.cts`, `.mjs`, `.cjs`, `.js`, `.jsx` beside `.ts` and
 * `.tsx` — and the same spellings as the release export's own content scan
 * (scripts/export-release.ts), so a secret the export would refuse cannot pass
 * the gate. Phase 3 corrective follow-up to TD-19.
 *
 * The gate runs every release step in order and cannot be run for one step
 * alone, so this reads the scan's scope from the gate's own source — the
 * regular expressions its `secret scan` step filters with — and applies them
 * to planted paths. A scope that cannot be found fails; it never passes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');

function regexLiteral(source: string): RegExp {
  const match = /^\/(.+)\/([a-z]*)$/.exec(source.trim());
  if (match === null || match[1] === undefined) throw new Error(`not a regular expression literal: ${source}`);
  return new RegExp(match[1], match[2]);
}

/** The directory and extension filters of the gate's `secret scan` step. */
function gateScope(): { dirs: RegExp; ext: RegExp } {
  const text = readFileSync(join(ROOT, 'scripts/phase1-release-gate.ts'), 'utf8');
  const start = text.indexOf("name: 'secret scan'");
  if (start < 0) throw new Error("the gate has no 'secret scan' step");
  const block = text.slice(start, text.indexOf("name: '", start + 1));
  const filter = /\.filter\(\(rel\) => (\/\^[^\n]+?\/)\.test\(rel\) && ([A-Z_]+|\/[^\n]+?\/)\.test\(rel\)\)/.exec(block);
  if (filter === null || filter[1] === undefined || filter[2] === undefined) throw new Error('the secret scan step has no directory-and-extension filter');
  const ext = filter[2].startsWith('/') ? filter[2] : constantIn(text, filter[2]);
  return { dirs: regexLiteral(filter[1]), ext: regexLiteral(ext) };
}

function constantIn(text: string, name: string): string {
  const match = new RegExp(`const ${name} = (/[^\\n]+/[a-z]*);`).exec(text);
  if (match === null || match[1] === undefined) throw new Error(`no regular expression constant ${name}`);
  return match[1];
}

/** The release export's content-scan scope (scripts/export-release.ts). */
function exportScope(): RegExp {
  const text = readFileSync(join(ROOT, 'scripts/export-release.ts'), 'utf8');
  return regexLiteral(constantIn(text, 'CONTENT_SCANNED'));
}

const EXECUTABLE = [
  'apps/web/server.mts',
  'apps/admin/server.mts',
  'scripts/planted.cts',
  'scripts/planted.mjs',
  'scripts/planted.cjs',
  'apps/web/planted.js',
  'apps/web/planted.jsx',
  'packages/domain-core/src/planted.ts',
  'apps/web/src/planted.tsx',
];

describe('the Phase 1 release gate scans what the release runs', () => {
  it.each(EXECUTABLE)('its secret scan reads %s', (rel) => {
    const { dirs, ext } = gateScope();
    expect(dirs.test(rel)).toBe(true);
    expect(ext.test(rel), `${ext} does not cover ${rel}`).toBe(true);
  });

  it('scans every spelling the release export scans', () => {
    const { ext } = gateScope();
    const spellings = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'sql', 'kt', 'kts', 'json', 'yml', 'yaml', 'xml', 'properties', 'md', 'svg', 'png'];
    const exported = spellings.filter((s) => exportScope().test(`scripts/x.${s}`));
    const gated = spellings.filter((s) => ext.test(`scripts/x.${s}`));
    expect(exported).toContain('mts');
    expect(gated).toEqual(exported);
  });
});
