import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@daftar/domain-core';
import { Database } from '../../infra/database';
import { AuditService, newId } from '../audit/audit.service';
import type { RateLimiter } from '../../infra/redis';
import { CredentialDeliveryEnqueuer } from '../delivery/credential-enqueuer.service';
import {
  TokenService, hashPassword, hashRefreshToken, verifyPassword,
} from './tokens';
import type { AuthTokensDto, LocaleCode } from '@daftar/shared-contracts';

// §XXXII–XXXVIII: layered auth-abuse defense.
//
// HARD limits (attacker-throttling, never account-targeting):
//   - per-IP: one source cannot spray many accounts.
//   - per-IP+account: one source cannot brute-force one account.
//   - global: CIRCUIT PROTECTION only — a high ceiling that absorbs
//     distributed credential-stuffing spikes, NOT a low kill-switch that a
//     botnet can trip to deny service to everyone.
// SOFT signal (account-wide): failed attempts on an account increment a risk
// counter that ADDS PROGRESSIVE RESPONSE DELAY — it slows an online guessing
// attack to a crawl but can NEVER lock the legitimate user out (a spray from
// many IPs raises delay, not denial). Successful authentication RESETS the
// counter (risk decays immediately for the real user).
const LOGIN_IP_MAX_ATTEMPTS = 30;
const LOGIN_IP_ACCOUNT_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 300;
const LOGIN_GLOBAL_MAX_ATTEMPTS = 50_000; // circuit breaker, not a kill-switch
const LOGIN_GLOBAL_WINDOW_SECONDS = 60;
const ACCOUNT_SOFT_DELAY_THRESHOLD = 5; // failures before delay starts
const ACCOUNT_SOFT_DELAY_STEP_MS = 500;
const ACCOUNT_SOFT_DELAY_MAX_MS = 4000;
const ACCOUNT_SIGNAL_WINDOW_SECONDS = 3600;
const RESET_MAX_ATTEMPTS = 3;
const RESET_WINDOW_SECONDS = 3600;
const RESET_IP_MAX_ATTEMPTS = 20;
const REGISTER_IP_MAX_ATTEMPTS = 10;
const REFRESH_IP_MAX_ATTEMPTS = 60;
const RESET_COMPLETE_IP_MAX_ATTEMPTS = 20;
const SESSION_TTL_DAYS = 30;
const RESET_TTL_MINUTES = 30;

/**
 * Auth foundation (§41–44): registration, login, logout, refresh rotation with
 * reuse detection, session revocation, logout-all, password reset, brute-force
 * protection. Timing-uniform login failures (dummy hash for unknown emails).
 */
@Injectable()
export class AuthService {
  /** Pre-computed dummy hash so unknown-email logins cost the same as real ones. */
  private dummyHash: string | null = null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject('RATE_LIMITER') private readonly rateLimiter: RateLimiter,
    @Inject(CredentialDeliveryEnqueuer) private readonly enqueuer: CredentialDeliveryEnqueuer,
  ) {}

  async register(input: { email: string; password: string; displayName: string; preferredLocale: LocaleCode }, clientIp = 'unknown'): Promise<AuthTokensDto> {
    // §XXXV: registration abuse — per-IP cap stops scripted account farms.
    await this.rateLimiter.take(`register:ip:${clientIp}`, REGISTER_IP_MAX_ATTEMPTS, RESET_WINDOW_SECONDS);
    const passwordHash = await hashPassword(input.password);
    try {
      const userId = await this.db.withIdentityTransaction( async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, preferred_locale)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.email, passwordHash, input.displayName, input.preferredLocale],
        );
        const id = r.rows[0]?.id;
        if (!id) throw new Error('user insert failed');
        await this.audit.recordTx(c, { action: 'auth.register', entity: 'user', entityId: id });
        return id;
      });
      return this.createSession(userId);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw AppError.conflict('CONFLICT', 'Email is already registered');
      }
      throw e;
    }
  }

  async login(email: string, password: string, clientIp = 'unknown'): Promise<AuthTokensDto> {
    await this.rateLimiter.take('login:global', LOGIN_GLOBAL_MAX_ATTEMPTS, LOGIN_GLOBAL_WINDOW_SECONDS);
    await this.rateLimiter.take(`login:ip:${clientIp}`, LOGIN_IP_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
    // §XXXIII: per-IP+account HARD limit — one source brute-forcing one
    // account is stopped at the source; the ACCOUNT itself is never locked.
    await this.rateLimiter.take(`login:ipacct:${clientIp}:${email.toLowerCase()}`, LOGIN_IP_ACCOUNT_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
    const fail = async (e: AppError): Promise<never> => {
      // Account-wide soft delay: slows online guessing, cannot lock anyone out.
      const risk = await this.rateLimiter.increment(`login:acct:${email.toLowerCase()}`, ACCOUNT_SIGNAL_WINDOW_SECONDS);
      const over = risk - ACCOUNT_SOFT_DELAY_THRESHOLD;
      if (over > 0) {
        const delay = Math.min(over * ACCOUNT_SOFT_DELAY_STEP_MS, ACCOUNT_SOFT_DELAY_MAX_MS);
        await new Promise((r) => setTimeout(r, delay));
      }
      throw e;
    };
    const user = (
      await this.db.withIdentityTransaction((c) => c.query<{ id: string; password_hash: string; status: string }>(
        'SELECT id, password_hash, status FROM users WHERE email = $1',
        [email],
      ))
    ).rows[0];

    // Uniform timing: verify against a dummy hash when the user doesn't exist.
    if (!user) {
      this.dummyHash ??= await hashPassword(`dummy-${Date.now()}`);
      await verifyPassword(this.dummyHash, password);
      return fail(AppError.unauthenticated('Invalid email or password'));
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok || user.status !== 'active') {
      return fail(AppError.unauthenticated('Invalid email or password'));
    }
    // §XXXIII: successful authentication resets the account risk signal.
    await this.rateLimiter.reset(`login:acct:${email.toLowerCase()}`);
    return this.createSession(user.id);
  }

  private async createSession(userId: string): Promise<AuthTokensDto> {
    const sessionId = newId();
    const refresh = this.tokens.newRefreshToken();
    const family = this.tokens.newSessionFamily();
    await this.db.withIdentityTransaction( async (c) => {
      await c.query(
        `INSERT INTO sessions (id, user_id, family_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '${SESSION_TTL_DAYS} days')`,
        [sessionId, userId, family, hashRefreshToken(refresh)],
      );
      await c.query(
        `INSERT INTO session_refresh_tokens (session_id, token_hash, state) VALUES ($1, $2, 'issued')`,
        [sessionId, hashRefreshToken(refresh)],
      );
      await this.audit.recordTx(c, { action: 'auth.session_created', entity: 'session', entityId: sessionId, actorUserId: userId });
    });
    const accessToken = await this.tokens.signAccessToken(userId, sessionId);
    return { accessToken, refreshToken: refresh, expiresInSeconds: this.tokens.accessTtlSeconds };
  }

  /**
   * Refresh rotation with full LINEAGE (§16–20):
   * - The lineage row is locked FOR UPDATE — concurrent refresh of the same
   *   token serializes; exactly ONE succeeds, the other observes state <>
   *   'issued' and is treated securely as reuse.
   * - Reuse of a consumed/replaced/revoked token revokes the ENTIRE family in
   *   a SEPARATE COMMITTED transaction BEFORE the error is thrown (§20):
   *   detection must survive the failed request.
   */
  async refresh(refreshToken: string, clientIp = 'unknown'): Promise<AuthTokensDto> {
    // §XXXVII: refresh abuse — per-IP cap; token-level reuse detection (below)
    // remains the primary defense.
    await this.rateLimiter.take(`refresh:ip:${clientIp}`, REFRESH_IP_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
    const hash = hashRefreshToken(refreshToken);
    const next = this.tokens.newRefreshToken();

    type Verdict =
      | { kind: 'ok'; userId: string; sessionId: string }
      | { kind: 'reuse'; userId: string; sessionId: string; familyId: string }
      | { kind: 'unknown' };

    const verdict = await this.db.withIdentityTransaction( async (c): Promise<Verdict> => {
      const row = (
        await c.query<{
          id: string; state: string; session_id: string;
          user_id: string; family_id: string; session_status: string; session_expires: Date;
        }>(
          `SELECT l.id, l.state, l.session_id, s.user_id, s.family_id,
                  s.status AS session_status, s.expires_at AS session_expires
           FROM session_refresh_tokens l JOIN sessions s ON s.id = l.session_id
           WHERE l.token_hash = $1 FOR UPDATE OF l, s`,
          [hash],
        )
      ).rows[0];
      if (!row) return { kind: 'unknown' };
      if (row.state !== 'issued' || row.session_status !== 'active' || row.session_expires < new Date()) {
        return { kind: 'reuse', userId: row.user_id, sessionId: row.session_id, familyId: row.family_id };
      }
      // Consume (single-use) + issue the successor in the same locked tx.
      const consumed = await c.query(
        `UPDATE session_refresh_tokens SET state = 'consumed', consumed_at = now()
         WHERE id = $1 AND state = 'issued'`,
        [row.id],
      );
      if (consumed.rowCount !== 1) {
        return { kind: 'reuse', userId: row.user_id, sessionId: row.session_id, familyId: row.family_id };
      }
      const successor = (
        await c.query<{ id: string }>(
          `INSERT INTO session_refresh_tokens (session_id, token_hash, state) VALUES ($1, $2, 'issued') RETURNING id`,
          [row.session_id, hashRefreshToken(next)],
        )
      ).rows[0];
      if (!successor) throw new Error('refresh successor insert failed');
      await c.query('UPDATE session_refresh_tokens SET replaced_by = $2 WHERE id = $1', [row.id, successor.id]);
      await c.query(
        `UPDATE sessions SET prev_refresh_token_hash = refresh_token_hash,
           refresh_token_hash = $2, last_used_at = now(),
           expires_at = now() + interval '${SESSION_TTL_DAYS} days'
         WHERE id = $1`,
        [row.session_id, hashRefreshToken(next)],
      );
      return { kind: 'ok', userId: row.user_id, sessionId: row.session_id };
    });

    if (verdict.kind === 'unknown') {
      throw new AppError('UNAUTHENTICATED', 'Invalid refresh token', 401);
    }
    if (verdict.kind === 'reuse') {
      // §20: revocation COMMITS before the throw.
      await this.db.withIdentityTransaction( async (c) => {
        await c.query(
          `UPDATE sessions SET status = 'revoked', revoked_reason = 'token_reuse_detected'
           WHERE family_id = $1 AND status = 'active'`,
          [verdict.familyId],
        );
        await c.query(
          `UPDATE session_refresh_tokens SET state = 'revoked'
           WHERE state = 'issued' AND session_id IN (SELECT id FROM sessions WHERE family_id = $1)`,
          [verdict.familyId],
        );
        await this.audit.recordTx(c, {
          action: 'auth.refresh_token_reuse_detected', entity: 'session', entityId: verdict.sessionId, actorUserId: verdict.userId,
        });
      });
      throw new AppError('TOKEN_REUSE_DETECTED', 'Session terminated for security reasons', 401);
    }

    const accessToken = await this.tokens.signAccessToken(verdict.userId, verdict.sessionId);
    return { accessToken, refreshToken: next, expiresInSeconds: this.tokens.accessTtlSeconds };
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'logout');
  }

  async logoutAll(userId: string): Promise<void> {
    await this.db.withIdentityTransaction( async (c) => {
      await c.query(
        `UPDATE sessions SET status = 'revoked', revoked_reason = 'logout_all' WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
      await c.query(
        `UPDATE session_refresh_tokens SET state = 'revoked'
         WHERE state = 'issued' AND session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
        [userId],
      );
      await this.audit.recordTx(c, { action: 'auth.logout_all', entity: 'user', entityId: userId, actorUserId: userId });
    });
  }

  private async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db.withIdentityTransaction( async (c) => {
      await c.query(
        `UPDATE sessions SET status = 'revoked', revoked_reason = $2 WHERE id = $1 AND status = 'active'`,
        [sessionId, reason],
      );
      await c.query(
        `UPDATE session_refresh_tokens SET state = 'revoked' WHERE session_id = $1 AND state = 'issued'`,
        [sessionId],
      );
      await this.audit.recordTx(c, { action: 'auth.session_revoked', entity: 'session', entityId: sessionId });
    });
  }

  /** Password reset: no user enumeration — always the same outcome shape (§41). Rate-limited per email (§19). */
  async requestPasswordReset(email: string, clientIp = 'unknown'): Promise<void> {
    await this.rateLimiter.take(`pwd-reset:ip:${clientIp}`, RESET_IP_MAX_ATTEMPTS, RESET_WINDOW_SECONDS);
    await this.rateLimiter.take(`pwd-reset:${email.toLowerCase()}`, RESET_MAX_ATTEMPTS, RESET_WINDOW_SECONDS);
    const user = (
      await this.db.withIdentityTransaction((c) => c.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 AND status = $2', [email, 'active'],
      ))
    ).rows[0];
    if (!user) return; // silent — identical response either way
    const token = this.tokens.newRefreshToken();
    await this.db.withIdentityTransaction( async (c) => {
      const row = (
        await c.query<{ id: string }>(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '${RESET_TTL_MINUTES} minutes') RETURNING id`,
          [user.id, hashRefreshToken(token)],
        )
      ).rows[0];
      await this.audit.recordTx(c, { action: 'auth.password_reset_requested', entity: 'user', entityId: user.id });
      // §18–20: same outbox pipeline as invitations — enqueue IN the identity
      // transaction; the worker drains with retry + dead-letter after commit.
      await this.enqueuer.enqueueTx(c, {
        kind: 'password_reset', passwordResetTokenId: row?.id as string, email, secret: token,
      });
    });
  }

  async resetPassword(token: string, newPassword: string, clientIp = 'unknown'): Promise<void> {
    // §XXXVII: token-guessing defense — per-IP cap on reset completion.
    await this.rateLimiter.take(`pwd-reset-complete:ip:${clientIp}`, RESET_COMPLETE_IP_MAX_ATTEMPTS, RESET_WINDOW_SECONDS);
    const passwordHash = await hashPassword(newPassword);
    await this.db.withIdentityTransaction( async (c) => {
      const row = (
        await c.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM password_reset_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
          [hashRefreshToken(token)],
        )
      ).rows[0];
      if (!row) throw AppError.validation({ token: ['invalid_or_expired'] });
      await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [row.user_id, passwordHash]);
      await c.query(
        `UPDATE sessions SET status = 'revoked', revoked_reason = 'password_reset' WHERE user_id = $1 AND status = 'active'`,
        [row.user_id],
      );
      await c.query(
        `UPDATE session_refresh_tokens SET state = 'revoked'
         WHERE state = 'issued' AND session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
        [row.user_id],
      );
      await this.audit.recordTx(c, { action: 'auth.password_reset_completed', entity: 'user', entityId: row.user_id });
    });
  }

  /** Principal resolution for the guard: session must be live, user active. */
  async resolvePrincipal(userId: string, sessionId: string): Promise<{
    userId: string; email: string | null; displayName: string; preferredLocale: string;
  }> {
    const row = (
      await this.db.withIdentityTransaction((c) => c.query<{
        id: string; email: string | null; display_name: string; preferred_locale: string; user_status: string;
      }>(
        `SELECT u.id, u.email::text AS email, u.display_name, u.preferred_locale, u.status AS user_status
         FROM users u JOIN sessions s ON s.user_id = u.id
         WHERE u.id = $1 AND s.id = $2 AND s.status = 'active' AND s.expires_at > now() AND u.status = 'active'`,
        [userId, sessionId],
      ))
    ).rows[0];
    if (!row) throw AppError.unauthenticated('Session is no longer valid');
    return { userId: row.id, email: row.email, displayName: row.display_name, preferredLocale: row.preferred_locale };
  }
}
