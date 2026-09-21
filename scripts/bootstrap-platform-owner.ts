/**
 * §LIV + Completion Directive §44–46: platform owner ONE-TIME BOOTSTRAP.
 *
 * Creates (or, with an explicit flag, promotes) the FIRST platform owner.
 *
 *  §44 CREDENTIAL — runs with the PLATFORM administrative principal
 *      (BOOTSTRAP_DATABASE_URL → daftar_platform), never with the migration
 *      credentials. The script REFUSES MIGRATION_DATABASE_URL and refuses to
 *      run as any principal other than daftar_platform.
 *  §45 CONCURRENCY — a transaction-scoped advisory lock serializes concurrent
 *      bootstraps; the "no owner exists yet" check runs INSIDE the lock, so of
 *      two simultaneous runs exactly one succeeds.
 *  §46 EXISTING IDENTITY — if the email already belongs to a user, the run
 *      refuses unless --promote-existing is passed; the existing password is
 *      NEVER changed and NEVER printed. Only a NEWLY created identity receives
 *      a generated one-time password, printed once to stdout.
 *
 * Usage:
 *   BOOTSTRAP_DATABASE_URL=postgres://daftar_platform:...@host/db \
 *     tsx scripts/bootstrap-platform-owner.ts --email=ops@daftar.app --confirm=BOOTSTRAP [--promote-existing]
 */
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';

// Same parameters as apps/api/src/modules/auth/tokens.ts hashPassword —
// duplicated here so this CLI has ZERO Nest/decorator imports (plain tsx).
async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
}

const BOOTSTRAP_LOCK = 'daftar:platform-owner-bootstrap';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.startsWith('--email='))?.slice('--email='.length);
  const confirm = args.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
  const promoteExisting = args.includes('--promote-existing');
  const url = process.env['BOOTSTRAP_DATABASE_URL'];

  if (process.env['MIGRATION_DATABASE_URL'] && !url) {
    throw new Error('MIGRATION_DATABASE_URL is not a bootstrap credential (§44) — set BOOTSTRAP_DATABASE_URL to the daftar_platform connection');
  }
  if (!url) throw new Error('BOOTSTRAP_DATABASE_URL is required (daftar_platform principal)');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Usage: --email=<valid email> --confirm=BOOTSTRAP [--promote-existing]');
  }
  if (confirm !== 'BOOTSTRAP') {
    throw new Error('Explicit confirmation required: pass --confirm=BOOTSTRAP');
  }
  const normalizedEmail = email.toLowerCase();

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const who = (await client.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
      if (who !== 'daftar_platform') {
        throw new Error(`bootstrap must run as the platform principal daftar_platform (connected as "${who ?? 'unknown'}")`);
      }

      await client.query('BEGIN');
      // §45: serialize concurrent bootstraps; the existence check below runs
      // under the lock, so the second runner sees the first one's commit.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BOOTSTRAP_LOCK]);
      const existing = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_role_memberships WHERE role_key = 'platform_owner'`);
      if (Number(existing.rows[0]?.n ?? '0') > 0) {
        throw new Error('A platform owner already exists — bootstrap is disabled');
      }

      const identity = (await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [normalizedEmail])).rows[0];
      let userId: string;
      let oneTimePassword: string | null = null;
      if (identity) {
        // §46: an existing identity is promoted ONLY with explicit intent, and
        // its credentials are left untouched.
        if (!promoteExisting) {
          throw new Error(
            `${normalizedEmail} already exists — pass --promote-existing to grant platform_owner to the EXISTING identity (its password is never changed)`,
          );
        }
        userId = identity.id;
      } else {
        oneTimePassword = `Daftar-${randomBytes(18).toString('base64url')}`;
        const passwordHash = await hashPassword(oneTimePassword);
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, preferred_locale)
           VALUES ($1, $2, 'Platform Owner', 'en') RETURNING id`,
          [normalizedEmail, passwordHash],
        );
        userId = created.rows[0]?.id ?? '';
        if (!userId) throw new Error('user insert failed');
      }
      await client.query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [userId]);
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, entity, entity_id, metadata)
         VALUES ($1::uuid, 'platform.owner_bootstrapped', 'user', $1::text, $2::jsonb)`,
        [userId, JSON.stringify({ email: normalizedEmail, promotedExisting: identity !== undefined })],
      );
      await client.query('COMMIT');
      if (oneTimePassword) {
        // Printed ONCE. Never written to any file or log.
        process.stdout.write(
          `\nPlatform owner created: ${normalizedEmail}\nOne-time password: ${oneTimePassword}\nChange it immediately after first login.\n\n`,
        );
      } else {
        process.stdout.write(
          `\nPlatform owner granted to existing identity: ${normalizedEmail}\nExisting password unchanged — sign in with the current credentials.\n\n`,
        );
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
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
