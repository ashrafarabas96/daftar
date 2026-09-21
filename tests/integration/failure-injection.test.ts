import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { appDbUrl, createTestApp, dbUrl, ownerPool, resetData, uniqueEmail, workerDbUrl, type TestApp } from '../helpers/test-app';

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

/**
 * Directive §67 — failure injection. Each scenario injects a concrete fault
 * and asserts the system's documented reaction: nothing silent, nothing torn.
 *
 * Covered elsewhere: outbox sink outage + dead-letter (outbox), delivery
 * adapter outage + dead-letter (delivery-outbox), media variant/compensation
 * failure (media-compensation), rate-limiter outage → 503 (auth-abuse).
 */
describe('failure injection (§67)', () => {
  describe('credential worker crash (lease reclaim)', () => {
    let t: TestApp;
    const sent: string[] = [];
    const delivery = {
      kind: 'capture-test-adapter',
      sendPasswordReset: () => Promise.resolve(),
      sendInvitation: (email: string) => {
        sent.push(email);
        return Promise.resolve();
      },
    };

    beforeEach(async () => {
      t = await createTestApp({ delivery });
      await resetData();
      sent.length = 0;
    });

    async function enqueueInvitation(): Promise<string> {
      const reg = await t.request
        .post('/v1/auth/register')
        .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'O', preferredLocale: 'ar' });
      const token = reg.body.accessToken as string;
      const on = await t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', `fi-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ businessName: 'FI', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `fi-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
      const invitee = uniqueEmail();
      const inv = await t.request
        .post('/v1/businesses/current/invitations')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', on.body.businessId as string)
        .send({ email: invitee, roleKey: 'cashier' });
      expect(inv.status).toBe(201);
      return invitee;
    }

    it('a job left in PROCESSING by a crashed worker is reclaimed once its lease expires — delivered exactly once afterwards', async () => {
      const invitee = await enqueueInvitation();
      // Simulate: another worker claimed the row, then died before finishing.
      const crashed = await ownerPool().query(
        `UPDATE credential_deliveries SET status = 'processing', locked_by = 'crashed-host:1', locked_at = now() - interval '10 minutes',
           lease_until = now() - interval '1 minute' WHERE status = 'pending' AND email = $1`,
        [invitee],
      );
      expect(crashed.rowCount).toBe(1);

      const first = await t.worker.drain();
      expect(first).toEqual({ sent: 1, failed: 0, dead: 0 });
      expect(sent).toEqual([invitee]);
      const row = must(
        (
          await ownerPool().query<{ status: string; locked_by: string | null; lease_until: string | null; secret_ciphertext: string | null }>(
            'SELECT status, locked_by, lease_until, secret_ciphertext FROM credential_deliveries WHERE email = $1',
            [invitee],
          )
        ).rows[0],
      );
      expect(row.status).toBe('sent');
      expect(row.locked_by).toBeNull();
      expect(row.lease_until).toBeNull();
      expect(row.secret_ciphertext).toBeNull(); // §11 retention: wiped on terminal state
      // A second drain finds nothing — no duplicate send.
      expect(await t.worker.drain()).toEqual({ sent: 0, failed: 0, dead: 0 });
      expect(sent).toHaveLength(1);
    });

    it('a job with a LIVE lease held by another worker is NOT stolen', async () => {
      const invitee = await enqueueInvitation();
      await ownerPool().query(
        `UPDATE credential_deliveries SET status = 'processing', locked_by = 'other-host:2', locked_at = now(), lease_until = now() + interval '2 minutes'
         WHERE status = 'pending' AND email = $1`,
        [invitee],
      );
      expect(await t.worker.drain()).toEqual({ sent: 0, failed: 0, dead: 0 });
      expect(sent).toHaveLength(0);
      const row = must(
        (await ownerPool().query<{ status: string; locked_by: string }>('SELECT status, locked_by FROM credential_deliveries WHERE email = $1', [invitee]))
          .rows[0],
      );
      expect(row).toEqual({ status: 'processing', locked_by: 'other-host:2' });
    });
  });

  describe('migration failure and wrong principal', () => {
    const scratchDirs: string[] = [];
    afterAll(() => {
      for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
    });

    function migrationsPlus(extra: Record<string, string>): string {
      const dir = mkdtempSync(join(tmpdir(), 'daftar-fi-mig-'));
      scratchDirs.push(dir);
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
      return dir;
    }

    it('a migration that fails mid-file is rolled back atomically: no partial DDL, no history row, rerun is clean', async () => {
      const dir = migrationsPlus({
        '9999_failure_injection.sql': `CREATE TABLE fi_partial_table (id int PRIMARY KEY);\nSELECT 1 / 0; -- injected fault after DDL\n`,
      });
      await expect(runMigrations(dbUrl, dir)).rejects.toThrow(/division by zero/);

      const partial = await ownerPool().query(`SELECT to_regclass('public.fi_partial_table') AS t`);
      expect(must(partial.rows[0]).t).toBeNull();
      const history = await ownerPool().query('SELECT count(*)::text AS n FROM schema_migrations WHERE name = $1', ['9999_failure_injection.sql']);
      expect(Number(must(history.rows[0]).n)).toBe(0);
      // The advisory lock was released: the real migration set is a no-op afterwards.
      expect(await runMigrations(dbUrl)).toEqual([]);
    });

    it('migrations refuse to run under a runtime principal (daftar_app / daftar_worker): permission denied, nothing applied', async () => {
      const dir = migrationsPlus({ '9998_wrong_principal.sql': `CREATE TABLE fi_wrong_principal (id int);\n` });
      await expect(runMigrations(appDbUrl, dir)).rejects.toThrow(/permission denied/);
      await expect(runMigrations(workerDbUrl, dir)).rejects.toThrow(/permission denied/);
      const created = await ownerPool().query(`SELECT to_regclass('public.fi_wrong_principal') AS t`);
      expect(must(created.rows[0]).t).toBeNull();
      const history = await ownerPool().query('SELECT count(*)::text AS n FROM schema_migrations WHERE name = $1', ['9998_wrong_principal.sql']);
      expect(Number(must(history.rows[0]).n)).toBe(0);
    });
  });
});
