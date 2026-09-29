import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, workerDbUrl, type TestApp } from '../helpers/test-app';

/**
 * `npm run check:key-retirement` answers "can credential key version X be
 * retired?" as `daftar_worker`. It used top-level await, which `tsx` does not
 * compile for this repo's CommonJS scripts, so every run failed before it
 * connected (found by the P3-S9 deployed rehearsal). This suite runs the real
 * script as a process, so a script that does not compile is red here.
 */
const ROOT = join(__dirname, '..', '..');

function check(args: readonly string[], env: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const res = spawnSync('npx', ['tsx', 'scripts/check-key-retirement.ts', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('check:key-retirement runs and answers (§XXI)', () => {
  let t: TestApp;
  let pendingVersion: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetData();
    const email = uniqueEmail();
    await t.request.post('/v1/auth/register').send({ email, password: 'Str0ng!Passw0rd', displayName: 'O', preferredLocale: 'ar' });
    const res = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect(res.status).toBeLessThan(300);
    const row = (
      await ownerPool().query<{ key_version: string }>(
        `SELECT key_version FROM credential_deliveries WHERE secret_ciphertext IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    if (row === undefined) throw new Error('the password reset enqueued no pending delivery');
    pendingVersion = row.key_version;
  });

  afterAll(async () => {
    await t.close();
  });

  it('without arguments it prints its usage and exits 2', () => {
    const { status, out } = check([], { ...process.env, WORKER_DATABASE_URL: '' });
    expect(out).toContain('usage: WORKER_DATABASE_URL=');
    expect(status).toBe(2);
  });

  it('a version no pending delivery references: YES, exit 0', () => {
    const { status, out } = check(['never-issued-version'], { ...process.env, WORKER_DATABASE_URL: workerDbUrl });
    expect(out).toContain("YES — key version 'never-issued-version' is not referenced");
    expect(status).toBe(0);
  });

  it('the version a pending delivery is encrypted under: NO, exit 1', () => {
    const { status, out } = check([pendingVersion], { ...process.env, WORKER_DATABASE_URL: workerDbUrl });
    expect(out).toContain(`NO — key version '${pendingVersion}' is still referenced by 1 non-terminal delivery.`);
    expect(status).toBe(1);
  });
});
