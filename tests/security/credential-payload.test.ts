import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  createTestApp, ownerPool, resetData, uniqueEmail, appDbUrl, identityDbUrl, workerDbUrl, platformDbUrl,
  type TestApp,
} from '../helpers/test-app';

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

/**
 * Gate A §3–19: credential payload protection + worker lease.
 *  - payload is encrypted at rest (never plaintext, key never in DB)
 *  - daftar_app / daftar_identity can ENQUEUE but CANNOT read the payload
 *  - retention: ciphertext wiped on terminal states (sent/dead)
 *  - lease: crashed worker's processing rows are reclaimed and delivered
 */
describe('credential payload protection + worker lease (Gate A §3–19)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function asRole(url: string, fn: (c: Client) => Promise<unknown>): Promise<unknown> {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  /** Request a password reset, leaving one queued delivery. Returns the raw token captured at enqueue time. */
  async function queuePasswordReset(): Promise<{ email: string }> {
    const email = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    const res = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect(res.status).toBeLessThan(300);
    return { email };
  }

  it('payload is encrypted at rest: ciphertext ≠ token, nonce + key_version present', async () => {
    // Failing adapter keeps the row non-terminal so the payload is inspectable.
    const t2 = await createTestApp({
      delivery: {
        kind: 'capture',
        sendPasswordReset: () => Promise.reject(new Error('smtp down')),
        sendInvitation: () => Promise.reject(new Error('smtp down')),
      },
    });
    const email = uniqueEmail();
    await t2.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    await t2.request.post('/v1/auth/password-reset/request').send({ email });
    await t2.worker.drain();
    const { rows } = await ownerPool().query<{
      secret_ciphertext: string | null; secret_nonce: string | null; key_version: string | null;
    }>(`SELECT secret_ciphertext, secret_nonce, key_version FROM credential_deliveries WHERE status = 'failed'`);
    expect(rows.length).toBeGreaterThan(0);
    const row = must(rows[0], 'delivery row');
    await t2.close();
    expect(row.secret_ciphertext).toBeTruthy();
    expect(row.secret_nonce).toBeTruthy();
    expect(row.key_version).toBe('v1');
    // 36-char UUID-ish tokens are hex/dash; base64 ciphertext must never equal or contain a raw token shape.
    expect(row.secret_ciphertext).not.toMatch(/^[0-9a-f-]{20,}$/);
    // No legacy plaintext column exists anymore.
    await expect(ownerPool().query('SELECT secret FROM credential_deliveries')).rejects.toThrow();
  });

  it('ATTACK (§14): daftar_app and daftar_identity cannot SELECT the credential payload', async () => {
    await queuePasswordReset();
    for (const url of [appDbUrl, identityDbUrl]) {
      await expect(
        asRole(url, (c) => c.query('SELECT secret_ciphertext FROM credential_deliveries')),
      ).rejects.toThrow(/permission denied/i);
      // enqueue (INSERT) still works for the correct kind — verified implicitly
      // by the invitation/reset flows; here we assert the read boundary only.
    }
  });

  it('retention (§11): ciphertext is wiped once delivered', async () => {
    await queuePasswordReset();
    await t.worker.drain();
    const { rows } = await ownerPool().query<{ status: string; secret_ciphertext: string | null }>(
      'SELECT status, secret_ciphertext FROM credential_deliveries',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe('sent');
      expect(r.secret_ciphertext).toBeNull();
    }
  });

  it('worker crash golden (§18): crashed worker lease expires → another worker reclaims → delivered', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const captured: string[] = [];
    const t2 = await createTestApp({
      delivery: {
        kind: 'capture',
        sendPasswordReset: (_e: string, tok: string) => {
          if (mode === 'fail') return Promise.reject(new Error('smtp down'));
          captured.push(tok); return Promise.resolve();
        },
        sendInvitation: () => Promise.resolve(),
      },
    });
    const email = uniqueEmail();
    await t2.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    await t2.request.post('/v1/auth/password-reset/request').send({ email });
    // Worker A claims the row, then "dies" before finalize: status=processing
    // with an already-expired lease and no payload wipe.
    await asRole(workerDbUrl, async (c) => {
      await (c as Client).query(
        `UPDATE credential_deliveries
         SET status = 'processing', locked_at = now() - interval '10 minutes', locked_by = 'worker-A',
             lease_until = now() - interval '8 minutes', updated_at = now()`,
      );
    });
    mode = 'ok';
    const result = await t2.worker.drain();
    expect(result.sent).toBe(1);
    expect(captured.length).toBe(1);
    const { rows } = await ownerPool().query<{ status: string; locked_by: string | null }>(
      'SELECT status, locked_by FROM credential_deliveries',
    );
    expect(must(rows[0], 'delivery row').status).toBe('sent');
    await t2.close();
  });

  it('at-least-once (§19): an un-finalized send is re-delivered after reclaim (no exactly-once claim)', async () => {
    let sends = 0;
    let crashAfterSend = true;
    const t2 = await createTestApp({
      delivery: {
        kind: 'capture',
        // The external send happens, then the worker "crashes" (finalize
        // never runs) — modelled as an adapter error AFTER the send.
        sendPasswordReset: () => { sends += 1; return crashAfterSend ? Promise.reject(new Error('worker crashed after send')) : Promise.resolve(); },
        sendInvitation: () => Promise.resolve(),
      },
    });
    const email = uniqueEmail();
    await t2.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    await t2.request.post('/v1/auth/password-reset/request').send({ email });
    // Part C: the request path only enqueues — the first (crashing) delivery
    // attempt is performed by the WORKER, not the request.
    await t2.worker.drain();
    // Simulate: the external send HAPPENED but the worker died before finalize.
    // The row is still claimable (failed with backoff / crashed processing) and
    // the payload was never wiped — so a later drain re-delivers.
    await ownerPool().query(
      `UPDATE credential_deliveries
       SET next_attempt_at = now() - interval '1 minute', locked_by = 'dead-worker'
       WHERE status IN ('pending', 'failed')`,
    );
    expect(sends).toBe(1); // the pre-crash external send
    crashAfterSend = false;
    await t2.worker.drain();
    expect(sends).toBe(2); // re-delivered — duplicates are safe, exactly-once is never claimed
    const { rows } = await ownerPool().query<{ status: string }>('SELECT status FROM credential_deliveries');
    expect(must(rows[0], 'delivery row').status).toBe('sent'); // and the retry eventually completes
    await t2.close();
  });

  it('ATTACK (§XVII): daftar_platform cannot SELECT ciphertext; safe view exposes metadata only', async () => {
    await queuePasswordReset();
    await expect(
      asRole(platformDbUrl, (c) => c.query('SELECT secret_ciphertext FROM credential_deliveries')),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asRole(platformDbUrl, (c) => c.query('SELECT secret_nonce FROM credential_deliveries')),
    ).rejects.toThrow(/permission denied/i);
    // Safe metadata columns still readable (delivery monitoring).
    const meta = (await asRole(platformDbUrl, async (c) => (
      await c.query<{ status: string }>('SELECT status FROM credential_deliveries')
    ))) as { rows: { status: string }[] };
    expect(meta.rows.length).toBeGreaterThan(0);
    // §XVIII: the safe view masks the recipient and carries no payload columns.
    const view = (await asRole(platformDbUrl, async (c) => (
      await c.query<Record<string, unknown>>('SELECT * FROM credential_deliveries_safe')
    ))) as { rows: Record<string, unknown>[] };
    expect(view.rows.length).toBeGreaterThan(0);
    const row = view.rows[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('secret_ciphertext');
    expect(row).not.toHaveProperty('secret_nonce');
    expect(row).not.toHaveProperty('key_version');
    expect(String(row['recipient_masked'])).toContain('***');
  });

  it('§XIX: strict parent invariant — password_reset carries NO business; invitation business must match', async () => {
    // password_reset with business_id → CHECK violation
    const user = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id`,
      [uniqueEmail()])).rows[0], 'user');
    const prt = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [user.id, `h-${Date.now()}`])).rows[0], 'prt');
    const tenant = must((await ownerPool().query<{ id: string }>(
      'INSERT INTO tenants DEFAULT VALUES RETURNING id')).rows[0], 'tenant');
    const biz = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'B', $2, 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
      [tenant.id, `b-${Date.now()}`])).rows[0], 'biz');
    await expect(ownerPool().query(
      `INSERT INTO credential_deliveries (kind, password_reset_token_id, business_id, email, secret_ciphertext, secret_nonce, key_version)
       VALUES ('password_reset', $1, $2, 'x@x.dev', 'c', 'n', 'v1')`, [prt.id, biz.id],
    )).rejects.toThrow(/parent_chk/);
    // invitation with mismatched business → composite FK violation
    const role = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO business_roles (business_id, key, name) VALUES ($1, $2, 'R') RETURNING id`,
      [biz.id, `r-${Date.now()}`])).rows[0], 'role');
    const inv = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO business_invitations (business_id, email, role_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING id`,
      [biz.id, uniqueEmail(), role.id, `t-${Date.now()}`, user.id])).rows[0], 'inv');
    const otherBiz = must((await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       SELECT tenant_id, 'Other', $1, 'JO', 'JOD', 'Asia/Amman' FROM businesses WHERE id = $2 RETURNING id`,
      [`other-${Date.now()}`, biz.id])).rows[0], 'otherBiz');
    await expect(ownerPool().query(
      `INSERT INTO credential_deliveries (kind, invitation_id, business_id, email, secret_ciphertext, secret_nonce, key_version)
       VALUES ('invitation', $1, $2, 'y@y.dev', 'c', 'n', 'v1')`, [inv.id, otherBiz.id],
    )).rejects.toThrow(/invitation_business_fk/);
  });

});
