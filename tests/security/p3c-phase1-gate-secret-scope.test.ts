/**
 * The raw-credential scans of the release (review L-4): the Phase 1 release
 * gate and the release export read EVERY shipped file that is not binary —
 * scripts, templates, config of any spelling, `.github/**`, `tests/**`,
 * `docs/**` and the root files — through one scanner, `scripts/secret-scan.ts`,
 * with no extension list and no path exemption. The only allowance is for the
 * dev/test key's constant NAME, in the exact files that define, guard or
 * document it; raw key material is refused everywhere.
 *
 * The gate runs every release step in order and cannot be run for one step
 * alone, so its wiring is read from its source: the `secret scan` step hands
 * `shippedFiles()` to the shared scanner with nothing filtered out on the way.
 * The scanner itself is exercised here with planted files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');

// Assembled so that this file itself never carries the patterns it plants.
const PRIVATE_KEY = ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' ');
const ARGON_HASH = `${['argon2id', ''].join('$')}${'Q'.repeat(24)}`;
const DEV_KEY_NAME = ['DEV', 'TEST', 'KEY'].join('_');

type Finding = (rel: string, content: Buffer, rules: { devKeyName: boolean }) => string | null;
const isObject = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;
/** Loaded by path so that a missing scanner is a failing case, not a file that does not compile. */
async function scanner(): Promise<{ finding: Finding; allowed: ReadonlyMap<string, string> }> {
  const m: unknown = await import(fileURLToPath(new URL('../../scripts/secret-scan.ts', import.meta.url))).catch(() => null);
  const fn = isObject(m) ? m['credentialFinding'] : undefined;
  const allowed = isObject(m) ? m['DEV_KEY_NAME_ALLOWED'] : undefined;
  if (typeof fn !== 'function' || !(allowed instanceof Map)) throw new Error('scripts/secret-scan.ts exports no credentialFinding and DEV_KEY_NAME_ALLOWED');
  const entries: [string, string][] = [];
  for (const [k, v] of allowed) if (typeof k === 'string' && typeof v === 'string') entries.push([k, v]);
  return {
    finding: (rel, content, rules) => {
      const out: unknown = fn(rel, content, rules);
      if (out !== null && typeof out !== 'string') throw new Error('credentialFinding answered neither a string nor null');
      return out;
    },
    allowed: new Map(entries),
  };
}

function secretScanStep(): string {
  const text = readFileSync(join(ROOT, 'scripts/phase1-release-gate.ts'), 'utf8');
  const start = text.indexOf("name: 'secret scan'");
  if (start < 0) throw new Error("the gate has no 'secret scan' step");
  return text.slice(start, text.indexOf("name: '", start + 1));
}

const PLANTED = [
  'apps/web/server.mts',
  'scripts/planted.cts',
  'scripts/planted.sh',
  'infrastructure/database/procedures/planted.sql.template',
  'planted.toml',
  '.github/workflows/planted.yml',
  'tests/security/planted.test.ts',
  'docs/planted.md',
  'apps/android/planted.pro',
  'apps/api/src/modules/delivery/credential-protector.ts',
];

describe('the Phase 1 release gate scans every shipped file', () => {
  it('its secret scan hands every shipped file to the shared scanner, filtering none out by path', () => {
    const step = secretScanStep();
    expect(step).toMatch(/credentialFinding\(/);
    expect(step).toContain('shippedFiles()');
    expect(step).not.toMatch(/\.filter\(\(rel\) =>[^\n]*\.test\(rel\)/);
  });

  it('the release export uses the same scanner', () => {
    const text = readFileSync(join(ROOT, 'scripts/export-release.ts'), 'utf8');
    expect(text).toMatch(/import \{[^}]*credentialFinding[^}]*\} from '\.\/secret-scan'/);
    expect(text).not.toMatch(/CONTENT_SCANNED|CONTENT_SCAN_EXEMPT/);
  });
});

describe('the shared scanner', () => {
  it.each(PLANTED)('refuses a private key in %s', async (rel) => {
    const { finding } = await scanner();
    expect(finding(rel, Buffer.from(`x\n${PRIVATE_KEY}\nMIIB\n`), { devKeyName: false })).not.toBeNull();
    expect(finding(rel, Buffer.from(`x\n${PRIVATE_KEY}\nMIIB\n`), { devKeyName: true })).not.toBeNull();
  });

  it.each(PLANTED)('refuses an argon2id hash in %s', async (rel) => {
    const { finding } = await scanner();
    expect(finding(rel, Buffer.from(`const h = '${ARGON_HASH}';\n`), { devKeyName: false })).not.toBeNull();
  });

  it('refuses the dev/test key name outside the exact files allowed to hold it, when asked to', async () => {
    const { finding, allowed } = await scanner();
    const text = Buffer.from(`export const k = '${DEV_KEY_NAME}';\n`);
    expect(finding('tests/security/planted.test.ts', text, { devKeyName: true })).not.toBeNull();
    expect(finding('apps/web/src/lib/planted.ts', text, { devKeyName: true })).not.toBeNull();
    expect(finding('tests/security/planted.test.ts', text, { devKeyName: false })).toBeNull();
    for (const rel of allowed.keys()) expect(finding(rel, text, { devKeyName: true }), rel).toBeNull();
  });

  it('allows the dev/test key name only in exact paths, each with a reason, each holding it today', async () => {
    const { allowed } = await scanner();
    expect(allowed.size).toBeGreaterThan(0);
    for (const [rel, reason] of allowed) {
      expect(rel).not.toMatch(/[*?[\]]|\/$/);
      expect(reason.length, rel).toBeGreaterThan(20);
      expect(readFileSync(join(ROOT, rel), 'utf8'), rel).toContain(DEV_KEY_NAME);
    }
  });

  it('does not read a binary file as text, and reads clean text as clean', async () => {
    const { finding } = await scanner();
    expect(finding('apps/web/public/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x2d, 0x2d]), { devKeyName: true })).toBeNull();
    expect(finding('scripts/clean.sh', Buffer.from('#!/bin/sh\necho ok\n'), { devKeyName: true })).toBeNull();
  });
});
