/**
 * §LIV: platform owner ONE-TIME BOOTSTRAP.
 *
 * Creates the FIRST platform owner. Hard rules:
 *  - Refuses to run if ANY platform owner already exists (disabled after use).
 *  - Requires --email and --confirm=BOOTSTRAP (explicit operator intent).
 *  - NO default password: a random one-time password is generated and printed
 *    ONCE to stdout; it is never logged or persisted in plaintext.
 *  - The operation is audited (audit_events).
 *
 * Usage:
 *   MIGRATION_DATABASE_URL=postgres://daftar_migrator:...@host/db \
 *     tsx scripts/bootstrap-platform-owner.ts --email ops@daftar.app --confirm=BOOTSTRAP
 */
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';

// Same parameters as apps/api/src/modules/auth/tokens.ts hashPassword —
// duplicated here so this CLI has ZERO Nest/decorator imports (plain tsx).
async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.startsWith('--email='))?.slice('--email='.length);
  const confirm = args.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
  const url = process.env.MIGRATION_DATABASE_URL;

  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Usage: --email=<valid email> --confirm=BOOTSTRAP');
  }
  if (confirm !== 'BOOTSTRAP') {
    throw new Error('Explicit confirmation required: pass --confirm=BOOTSTRAP');
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const existing = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_role_memberships WHERE role_key = 'platform_owner'`);
    if (Number(existing.rows[0]?.n ?? '0') > 0) {
      throw new Error('A platform owner already exists — bootstrap is disabled');
    }

    const oneTimePassword = `Daftar-${randomBytes(18).toString('base64url')}`;
    const passwordHash = await hashPassword(oneTimePassword);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, preferred_locale)
         VALUES ($1, $2, 'Platform Owner', 'en')
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [email.toLowerCase(), passwordHash],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error('user upsert failed');
      await client.query(
        `INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')
         ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, entity, entity_id, metadata)
         VALUES ($1::uuid, 'platform.owner_bootstrapped', 'user', $1::text, $2::jsonb)`,
        [userId, JSON.stringify({ email: email.toLowerCase() })],
      );
      await client.query('COMMIT');
      // Printed ONCE. Never written to any file or log.
      process.stdout.write(
        `\nPlatform owner created: ${email.toLowerCase()}\nOne-time password: ${oneTimePassword}\nChange it immediately after first login.\n\n`,
      );
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`bootstrap failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
