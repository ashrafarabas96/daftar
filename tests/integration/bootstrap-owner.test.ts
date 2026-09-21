import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbUrl, ensurePostgres, ownerPool, platformDbUrl, resetData, uniqueEmail } from '../helpers/test-app';

const execFileP = promisify(execFile);
const CLI = ['scripts/bootstrap-platform-owner.ts'];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
async function run(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const clean = Object.fromEntries(
    Object.entries({ ...process.env, MIGRATION_DATABASE_URL: undefined, BOOTSTRAP_DATABASE_URL: undefined, ...env }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  return execFileP('./node_modules/.bin/tsx', [...CLI, ...args], { env: clean, cwd: process.cwd() }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }),
  );
}

/** Completion Directive §44–46 — platform owner bootstrap: credential, concurrency, existing identity. */
describe('platform owner bootstrap (§44–46)', () => {
  beforeEach(async () => {
    await ensurePostgres();
    await resetData();
  });

  it('§44 refuses migration credentials and any principal other than daftar_platform', async () => {
    const asMigrator = await run([`--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], { MIGRATION_DATABASE_URL: dbUrl });
    expect(asMigrator.code).not.toBe(0);
    expect(asMigrator.stderr).toMatch(/not a bootstrap credential/);
    const asOwner = await run([`--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], { BOOTSTRAP_DATABASE_URL: dbUrl });
    expect(asOwner.code).not.toBe(0);
    expect(asOwner.stderr).toMatch(/must run as the platform principal/);
    const owners = await ownerPool().query(`SELECT 1 FROM platform_role_memberships WHERE role_key = 'platform_owner'`);
    expect(owners.rows).toEqual([]);
  });

  it('§45 two SIMULTANEOUS initial bootstraps: exactly one succeeds, one owner, one audit event', async () => {
    const env = { BOOTSTRAP_DATABASE_URL: platformDbUrl };
    const [a, b] = await Promise.all([
      run([`--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], env),
      run([`--email=${uniqueEmail()}`, '--confirm=BOOTSTRAP'], env),
    ]);
    const codes = [a.code, b.code].sort();
    expect(codes[0]).toBe(0);
    expect(codes[1]).not.toBe(0);
    const failed = a.code === 0 ? b : a;
    expect(failed.stderr).toMatch(/already exists — bootstrap is disabled/);
    const owners = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM platform_role_memberships WHERE role_key = 'platform_owner'`);
    expect(owners.rows[0]?.n).toBe(1);
    const audit = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'platform.owner_bootstrapped'`);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('§46 existing identity: refused without --promote-existing; with the flag the password is untouched and never printed', async () => {
    const email = uniqueEmail();
    const before = (
      await ownerPool().query<{ id: string; password_hash: string }>(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'argon2id$existing-hash-marker', 'Existing') RETURNING id, password_hash`,
        [email],
      )
    ).rows[0];
    const refused = await run([`--email=${email}`, '--confirm=BOOTSTRAP'], { BOOTSTRAP_DATABASE_URL: platformDbUrl });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/--promote-existing/);
    expect((await ownerPool().query(`SELECT 1 FROM platform_role_memberships WHERE user_id = $1`, [before?.id])).rows).toEqual([]);

    const promoted = await run([`--email=${email}`, '--confirm=BOOTSTRAP', '--promote-existing'], { BOOTSTRAP_DATABASE_URL: platformDbUrl });
    expect(promoted.code).toBe(0);
    expect(promoted.stdout).toContain('existing identity');
    expect(promoted.stdout).not.toMatch(/One-time password/);
    const after = (
      await ownerPool().query<{ password_hash: string; role_key: string }>(
        `SELECT u.password_hash, prm.role_key FROM users u JOIN platform_role_memberships prm ON prm.user_id = u.id WHERE u.id = $1`,
        [before?.id],
      )
    ).rows[0];
    expect(after?.password_hash).toBe(before?.password_hash); // never changed
    expect(after?.role_key).toBe('platform_owner');
  });
});
