/**
 * PHASE 3 CORRECTIVE — THE PROVISIONING KEY IS WRITTEN ONCE (migration 0070,
 * with TD-18).
 *
 * 0038's `provision_assertion_key_install` was an UPSERT: `daftar_platform`
 * could replace the secret of an ACTIVE kid (every outstanding assertion
 * minted under it changes meaning) and bring a RETIRED kid back. The
 * accounting (0044) and inventory (0054) install commands refuse both. 0070
 * gives the provisioning command the same semantics:
 *
 *   ALLOW  a new kid; the same kid re-installed with the same bytes while it is
 *          active (a no-op — the documented re-run of the ops CLI and of the
 *          test harness);
 *   DENY   the same kid with different bytes, a retired kid (same bytes or
 *          not), a malformed kid, a secret under 32 bytes — each with a
 *          `PROV:` code that names it and never the secret;
 *   RACE   two first installs of one kid with different bytes: exactly one
 *          wins, the other is a conflict.
 *
 * Retirement is unchanged: terminal, and a retired kid authorizes nothing.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintProvisioningAssertion } from '../../apps/api/src/infra/provisioning-assertion';
import { ensurePostgres, ownerPool, platformDbUrl, PROVISIONING_ASSERTION_KEY_B64, PROVISIONING_ASSERTION_KID } from '../helpers/test-app';

const execFileP = promisify(execFile);

/** One platform connection for `fn`. */
async function asPlatform<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: platformDbUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The message `sql` fails with as the platform, or null when it succeeds. */
async function installError(kid: string | null, secret: Buffer | null): Promise<string | null> {
  return asPlatform(async (c) => {
    try {
      await c.query(`SELECT provision_assertion_key_install($1, $2)`, [kid, secret]);
      return null;
    } catch (e) {
      if (e instanceof Error) return e.message;
      throw e;
    }
  });
}

/** The stored row, read through the owner connection the runtime never has. */
async function stored(kid: string): Promise<{ secret: string; status: string } | undefined> {
  const r = await ownerPool().query<{ secret: string; status: string }>(
    `SELECT encode(secret, 'hex') AS secret, status FROM provisioning_assertion_keys WHERE kid = $1`,
    [kid],
  );
  return r.rows[0];
}

const kidOf = (tag: string): string => `pk-${tag}-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ensurePostgres();
}, 300_000);

describe('provisioning key install: ALLOW a new kid and an idempotent re-install', () => {
  it('a new kid is installed active', async () => {
    const kid = kidOf('new');
    const secret = Buffer.alloc(32, 21);
    expect(await installError(kid, secret)).toBeNull();
    expect(await stored(kid)).toEqual({ secret: secret.toString('hex'), status: 'active' });
  });

  it('the same kid with the same bytes, while active, is a no-op', async () => {
    const kid = kidOf('same');
    const secret = Buffer.alloc(40, 22);
    expect(await installError(kid, secret)).toBeNull();
    expect(await installError(kid, Buffer.from(secret))).toBeNull();
    expect(await stored(kid)).toEqual({ secret: secret.toString('hex'), status: 'active' });
  });

  it('the harness key re-install that ensurePostgres performs still succeeds and changes nothing', async () => {
    const before = await stored(PROVISIONING_ASSERTION_KID);
    expect(await installError(PROVISIONING_ASSERTION_KID, Buffer.from(PROVISIONING_ASSERTION_KEY_B64, 'base64'))).toBeNull();
    expect(await stored(PROVISIONING_ASSERTION_KID)).toEqual(before);
    expect(before?.status).toBe('active');
  });
});

describe('provisioning key install: DENY an overwrite, a reinstatement and malformed input', () => {
  it('an active kid with different bytes is a conflict; the stored secret is unchanged and never echoed', async () => {
    const kid = kidOf('over');
    const first = Buffer.alloc(32, 31);
    const second = Buffer.alloc(32, 32);
    expect(await installError(kid, first)).toBeNull();
    const msg = await installError(kid, second);
    expect(msg).toBe(`PROV:KEY_CONFLICT:provisioning assertion key ${kid} already exists with different key material`);
    expect(msg).not.toContain(second.toString('hex'));
    expect(msg).not.toContain(second.toString('base64'));
    expect(await stored(kid)).toEqual({ secret: first.toString('hex'), status: 'active' });
  });

  it('the harness kid cannot be overwritten by the platform either', async () => {
    const msg = await installError(PROVISIONING_ASSERTION_KID, Buffer.alloc(32, 33));
    expect(msg).toMatch(/^PROV:KEY_CONFLICT:provisioning assertion key v1 already exists with different key material$/);
    expect((await stored(PROVISIONING_ASSERTION_KID))?.secret).toBe(Buffer.from(PROVISIONING_ASSERTION_KEY_B64, 'base64').toString('hex'));
  });

  it('a retired kid is not reinstated, with the same bytes or new ones, and it still authorizes nothing', async () => {
    const kid = kidOf('ret');
    const secret = Buffer.alloc(32, 41);
    expect(await installError(kid, secret)).toBeNull();
    await asPlatform((c) => c.query(`SELECT provision_assertion_key_retire($1)`, [kid]));
    for (const again of [secret, Buffer.alloc(32, 42)]) {
      expect(await installError(kid, again)).toBe(`PROV:KEY_CONFLICT:provisioning assertion key ${kid} is retired and cannot be reinstated`);
    }
    expect(await stored(kid)).toEqual({ secret: secret.toString('hex'), status: 'retired' });
    await asPlatform(async (c) => {
      await c.query('BEGIN');
      try {
        const assertion = mintProvisioningAssertion({ kid, secret }, '00000000-0000-4000-8000-000000000031', 'onboarding', new Date(), 60);
        await c.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, [assertion]);
        await expect(c.query(`SELECT provision_actor(ARRAY['onboarding'])`)).rejects.toThrow(/unknown or retired/);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('a malformed kid and a short or missing secret are refused as PROV:INVALID_KEY, and nothing is stored', async () => {
    const malformed = await installError('bad kid!', Buffer.alloc(32, 51));
    expect(malformed).toBe('PROV:INVALID_KEY:the provisioning assertion key id is malformed');
    expect(await installError(null, Buffer.alloc(32, 51))).toBe('PROV:INVALID_KEY:the provisioning assertion key id is malformed');
    const kid = kidOf('short');
    expect(await installError(kid, Buffer.alloc(31, 52))).toBe('PROV:INVALID_KEY:provisioning assertion key must be at least 32 bytes');
    expect(await installError(kid, null)).toBe('PROV:INVALID_KEY:provisioning assertion key must be at least 32 bytes');
    expect(await stored(kid)).toBeUndefined();
  });
});

describe('provisioning key install: concurrent first installs of one kid', () => {
  it('two platform sessions racing different bytes: exactly one wins, the other is a conflict', async () => {
    const kid = kidOf('race');
    const a = Buffer.alloc(32, 61);
    const b = Buffer.alloc(32, 62);
    const first = new Client({ connectionString: platformDbUrl });
    const second = new Client({ connectionString: platformDbUrl });
    await first.connect();
    await second.connect();
    try {
      await first.query('BEGIN');
      await first.query(`SELECT provision_assertion_key_install($1, $2)`, [kid, a]);
      // The second session blocks on the uncommitted primary key, then compares.
      const racing = second.query(`SELECT provision_assertion_key_install($1, $2)`, [kid, b]).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : 'non-error rejection'),
      );
      await first.query('COMMIT');
      expect(await racing).toBe(`PROV:KEY_CONFLICT:provisioning assertion key ${kid} already exists with different key material`);
    } finally {
      await first.end();
      await second.end();
    }
    expect(await stored(kid)).toEqual({ secret: a.toString('hex'), status: 'active' });
  });
});

describe('provisioning key install: the ops CLI', () => {
  it('re-running the CLI with the same key succeeds; a different key under the same kid fails without printing either secret', async () => {
    const kid = kidOf('cli');
    const key = Buffer.alloc(32, 71).toString('base64');
    const other = Buffer.alloc(32, 72).toString('base64');
    const run = (secret: string): Promise<{ code: number; out: string }> =>
      execFileP(process.execPath, ['--import', 'tsx', 'scripts/install-provisioning-key.ts'], {
        env: { ...process.env, BOOTSTRAP_DATABASE_URL: platformDbUrl, PROVISIONING_ASSERTION_KEY: secret, PROVISIONING_ASSERTION_KID: kid },
        cwd: process.cwd(),
      }).then(
        (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
        (e: unknown) => {
          if (typeof e === 'object' && e !== null && 'code' in e && 'stdout' in e && 'stderr' in e) {
            return { code: Number(e.code), out: `${String(e.stdout)}${String(e.stderr)}` };
          }
          throw e;
        },
      );
    expect((await run(key)).code).toBe(0);
    const again = await run(key);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`installed kid=${kid}`);
    const clash = await run(other);
    expect(clash.code).not.toBe(0);
    expect(clash.out).toContain(`PROV:KEY_CONFLICT:provisioning assertion key ${kid} already exists with different key material`);
    for (const s of [key, other]) {
      expect(clash.out).not.toContain(s);
      expect(clash.out).not.toContain(Buffer.from(s, 'base64').toString('hex'));
    }
    expect((await stored(kid))?.secret).toBe(Buffer.from(key, 'base64').toString('hex'));
    await asPlatform((c) => c.query(`SELECT provision_assertion_key_retire($1)`, [kid]));
  }, 60_000);
});
