import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const GATE = join(__dirname, '../../scripts/phase1-release-gate.ts');

/**
 * Final Release Blocker 5 — THE GATE ITSELF IS TESTED. A mandatory check that
 * is skipped can never yield a release PASS: the release gate fails before
 * running anything when any RELEASE_GATE_SKIP_* variable is set. The dev
 * helper may skip Android but is labelled and can never be a release verdict.
 */
describe('release gate refuses mandatory skips (Blocker 5)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const runGate = async (env: Record<string, string>, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'daftar-gate-test-'));
    dirs.push(dir);
    const evidence = join(dir, 'evidence.json');
    try {
      const r = await execFileP(process.execPath, ['--import', 'tsx', GATE, `--evidence=${evidence}`, `--log-dir=${join(dir, 'logs')}`, ...extra], {
        env: { ...process.env, ...env },
        cwd: join(__dirname, '../..'),
      });
      return { code: 0, out: r.stdout + r.stderr, evidence };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, evidence };
    }
  };

  it('RELEASE_GATE_SKIP_ANDROID=1 → the release gate FAILS immediately, records the refusal, runs no other step', async () => {
    const r = await runGate({ RELEASE_GATE_SKIP_ANDROID: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('PHASE 1 RELEASE GATE: FAIL');
    expect(r.out).toMatch(/RELEASE_GATE_SKIP_ANDROID is set/);
    const ev = JSON.parse(readFileSync(r.evidence, 'utf8')) as { verdict: string; requestedSkips: string[]; steps: { name: string; status: string }[] };
    expect(ev.verdict).toBe('FAIL');
    expect(ev.requestedSkips).toEqual(['RELEASE_GATE_SKIP_ANDROID']);
    expect(ev.steps).toHaveLength(1);
    expect(ev.steps[0]?.status).toBe('fail');
  }, 60_000);

  it('any other RELEASE_GATE_SKIP_* variable (e.g. a future web/admin/db skip) is refused the same way', async () => {
    for (const k of ['RELEASE_GATE_SKIP_WEB', 'RELEASE_GATE_SKIP_INTEGRATION', 'RELEASE_GATE_SKIP_DB']) {
      const r = await runGate({ [k]: 'true' });
      expect(r.code, k).toBe(1);
      expect(r.out, k).toContain(`${k} is set`);
    }
  }, 120_000);

  it('the plan lists every mandatory surface, and --list never runs anything', async () => {
    const r = await runGate({}, ['--list']);
    expect(r.code).toBe(0);
    for (const s of [
      'db from zero',
      'unit',
      'integration',
      'golden',
      'static guards',
      'localization',
      'migration manifest',
      'api build',
      'web build',
      'admin build',
      'android',
      'artifact scan',
      'secret scan',
      'audit',
    ]) {
      expect(r.out).toContain(s);
    }
    expect(r.out).not.toContain('SUMMARY');
  }, 60_000);

  it('the dev helper (--dev) may skip Android but is labelled and cannot claim a release verdict', async () => {
    const r = await runGate({ RELEASE_GATE_SKIP_ANDROID: '1' }, ['--dev', '--list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('dev mode');
    expect(r.out).toContain('SKIPPED (dev only)');
  }, 60_000);
});
