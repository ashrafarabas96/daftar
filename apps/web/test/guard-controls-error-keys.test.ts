import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import en from '@/messages/en.json';
import { VITEST_MJS } from './helpers/guard-sandbox';

/**
 * Negative control for T-10 (error-keys.test.ts). Its assertions read the
 * imported catalogs inline, so they cannot be handed a bad input in-process.
 * Instead the REAL test file is run by a child vitest whose `@/messages/en.json`
 * alias points at a planted catalog, and the child's per-test result is read.
 */
const WEB = join(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'daftar-t10-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEYS_TEST = 'has a non-empty key for every code in every locale';
const WORDS_TEST = 'every error text is words, not a code, and answers the "is my data safe" question';
const catalog = en as Record<string, string>;

function runT10(name: string, planted: Record<string, string> | null): Record<string, string> {
  const alias: { find: string; replacement: string }[] = [];
  if (planted) {
    const file = join(dir, `${name}.en.json`);
    writeFileSync(file, JSON.stringify(planted));
    alias.push({ find: '@/messages/en.json', replacement: file });
  }
  alias.push({ find: '@', replacement: join(WEB, 'src') }, { find: 'server-only', replacement: join(WEB, 'test', 'helpers', 'server-only.ts') });
  const cfg = join(dir, `${name}.config.mjs`);
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: WEB,
      esbuild: { jsx: 'automatic' },
      resolve: { alias },
      test: { environment: 'node', include: ['test/error-keys.test.ts'], globalSetup: ['test/helpers/global-setup.ts'] },
    })};`,
  );
  const outFile = join(dir, `${name}.json`);
  const child = spawnSync(process.execPath, [VITEST_MJS, 'run', '--config', cfg, '--reporter=json', `--outputFile=${outFile}`], {
    cwd: WEB,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (child.error || child.signal) throw new Error(`child vitest did not finish: ${child.error?.message ?? child.signal}`);
  const report = JSON.parse(readFileSync(outFile, 'utf8')) as { testResults: { assertionResults: { title: string; status: string }[] }[] };
  const out: Record<string, string> = {};
  for (const r of report.testResults) for (const a of r.assertionResults) out[a.title] = a.status;
  return out;
}

describe('T-10 negative control — the real error-keys test, fed a planted en catalog', () => {
  it('the harness itself is sound: the unplanted catalog passes both catalog tests', () => {
    const r = runT10('clean', null);
    expect(r[KEYS_TEST]).toBe('passed');
    expect(r[WORDS_TEST]).toBe('passed');
  }, 120_000);

  it('a missing error.<code> key makes the key-coverage test fail', () => {
    const planted = { ...catalog };
    delete planted['error.supplier_credit_note.not_found'];
    const r = runT10('missing', planted);
    expect(r[KEYS_TEST]).toBe('failed');
  }, 120_000);

  it('a text that is a code, or that does not say the data is safe, makes the words test fail', () => {
    const codeLike = { ...catalog, 'error.supplier_credit_note.not_found': 'Nothing was saved. supplier_credit_note.not_found' };
    const unsafe = { ...catalog, 'error.supplier_credit_note.not_found': 'Something went wrong' };
    expect(runT10('codelike', codeLike)[WORDS_TEST]).toBe('failed');
    expect(runT10('unsafe', unsafe)[WORDS_TEST]).toBe('failed');
  }, 180_000);
});
