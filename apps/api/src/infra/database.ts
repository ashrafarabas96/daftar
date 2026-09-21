import { Injectable, Inject, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '../config';

/** Merchant business scope — tenant + business context for the app role. */
export interface Scope {
  tenantId?: string;
  businessId?: string;
  /**
   * Server-derived actor (Directive §12): the authenticated principal, set
   * as a TRANSACTION-LOCAL GUC so trusted SQL commands read it themselves
   * (provision_actor()) instead of trusting a caller-supplied user id.
   */
  actorUserId?: string;
}

/**
 * Database access layer (§36). Raw SQL via pg — chosen for correctness over
 * convenience (ADR-011): RLS, composite FKs, partial indexes, SELECT FOR
 * UPDATE and explicit transactions are all first-class.
 *
 * EXPLICIT BOUNDARIES (Final Closure Directive §5–9): there is NO generic
 * `bypass` flag any service can pass. Each boundary is a typed method with
 * its own pool and DB role:
 * - withTransaction / scoped  → daftar_app    (merchant runtime, RLS-enforced)
 * - withResolverTransaction   → daftar_resolver (membership resolution only)
 * - withIdentityTransaction   → daftar_identity (auth/session runtime ONLY — WAVE 2)
 * - withPlatformTransaction   → daftar_platform (provisioning + super-admin ops)
 * - withWorkerTransaction     → daftar_worker  (outbox relay)
 * A merchant service CANNOT accidentally use platform privileges.
 *
 * RLS pool safety (§38): scope is applied with set_config(..., true) —
 * TRANSACTION-LOCAL. A pooled connection returned to the pool carries no
 * stale context; without scope the app role sees zero rows (default-deny).
 */
@Injectable()
export class Database implements OnModuleDestroy, OnModuleInit {
  private readonly pool: Pool | null;
  private readonly platformPool: Pool | null;
  private readonly identityPool: Pool | null;
  private readonly resolverPool: Pool | null;
  private readonly workerPool: Pool | null;
  private readonly provisionerPool: Pool | null;

  private readonly expectedPrincipals: [Pool | null, string][] = [];

  constructor(@Inject('APP_CONFIG') private readonly config: AppConfig) {
    // §XXV–XXXI: a process creates pools ONLY for the credentials it actually
    // received. Absent URL → no pool → accidental cross-boundary use fails
    // loudly ("role pool is not configured"), never silently connects
    // somewhere default.
    const fallback = config.isProd ? undefined : config.APP_DATABASE_URL;
    this.pool = config.APP_DATABASE_URL ? new Pool({ connectionString: config.APP_DATABASE_URL, max: 10 }) : null;
    this.platformPool = (config.PLATFORM_DATABASE_URL ?? fallback) ? new Pool({ connectionString: config.PLATFORM_DATABASE_URL ?? fallback, max: 4 }) : null;
    this.identityPool =
      (config.IDENTITY_DATABASE_URL ?? config.PLATFORM_DATABASE_URL ?? fallback)
        ? new Pool({ connectionString: config.IDENTITY_DATABASE_URL ?? config.PLATFORM_DATABASE_URL ?? fallback, max: 4 })
        : null;
    this.resolverPool = (config.RESOLVER_DATABASE_URL ?? fallback) ? new Pool({ connectionString: config.RESOLVER_DATABASE_URL ?? fallback, max: 4 }) : null;
    this.workerPool = (config.WORKER_DATABASE_URL ?? fallback) ? new Pool({ connectionString: config.WORKER_DATABASE_URL ?? fallback, max: 2 }) : null;
    this.provisionerPool =
      (config.PROVISIONER_DATABASE_URL ?? fallback) ? new Pool({ connectionString: config.PROVISIONER_DATABASE_URL ?? fallback, max: 2 }) : null;
    // §32/§XXX startup verification: every explicitly-configured pool must be
    // authenticated as its intended DB role — per deployment mode, only the
    // pools this process actually owns are verified.
    if (config.isProd && this.pool) this.expectedPrincipals.push([this.pool, 'daftar_app']);
    if (config.PLATFORM_DATABASE_URL) this.expectedPrincipals.push([this.platformPool, 'daftar_platform']);
    if (config.IDENTITY_DATABASE_URL) this.expectedPrincipals.push([this.identityPool, 'daftar_identity']);
    if (config.RESOLVER_DATABASE_URL) this.expectedPrincipals.push([this.resolverPool, 'daftar_resolver']);
    if (config.WORKER_DATABASE_URL) this.expectedPrincipals.push([this.workerPool, 'daftar_worker']);
    if (config.PROVISIONER_DATABASE_URL) this.expectedPrincipals.push([this.provisionerPool, 'daftar_provisioner']);
  }

  /** §32: fail startup on principal mismatch — SELECT current_user per pool. */
  async onModuleInit(): Promise<void> {
    for (const [pool, expected] of this.expectedPrincipals) {
      if (!pool) throw new Error(`database pool for role ${expected} is not configured`);
      const { rows } = await pool.query<{ current_user: string }>('SELECT current_user');
      const actual = rows[0]?.current_user;
      if (actual !== expected) {
        throw new Error(
          `DB principal mismatch: expected role "${expected}", connected as "${actual}". ` +
            'Refusing to start — each runtime boundary must use its own database role (§30–32).',
        );
      }
    }
  }

  private async applyScope(client: PoolClient, scope: Scope, bypass: boolean): Promise<void> {
    await client.query(
      `SELECT
      set_config('app.tenant_id', $1, true),
      set_config('app.business_id', $2, true),
      set_config('app.bypass_rls', $3, true),
      set_config('app.actor_user_id', $4, true)`,
      [scope.tenantId ?? '', scope.businessId ?? '', bypass ? 'true' : 'false', scope.actorUserId ?? ''],
    );
  }

  private async run<T>(pool: Pool | null, scope: Scope, bypass: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!pool) throw new Error('database role pool is not configured');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyScope(client, scope, bypass);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Merchant runtime: RLS-enforced business/tenant scope, daftar_app role. */
  async withTransaction<T>(scope: Scope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.pool, scope, false, fn);
  }

  /** Scoped single query (auto transaction for RLS locality). */
  async scoped<T extends QueryResultRow>(scope: Scope, text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.withTransaction(scope, (c) => c.query<T>(text, params));
  }

  /** Membership resolution boundary: daftar_resolver — narrow read-only role. */
  async withResolverTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.resolverPool, {}, false, fn);
  }

  /**
   * Identity boundary (WAVE 2): auth runtime ONLY — users, sessions, refresh
   * lineage, password reset tokens — as the daftar_identity principal. It has
   * NO grants on plans/flags/overrides/catalog/businesses and does NOT bypass
   * RLS (its access comes from dedicated identity_access policies).
   */
  async withIdentityTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.identityPool, {}, false, fn);
  }

  /** Platform admin boundary: plans/flags/overrides/platform roles (daftar_platform). */
  async withPlatformTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.platformPool, {}, true, fn);
  }

  /** Worker boundary: outbox relay (daftar_worker — own policy, no bypass). */
  async withWorkerTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.workerPool, {}, false, fn);
  }

  /**
   * Provisioning boundary (Stabilization §13–14): daftar_provisioner — the
   * ONLY authority for initial onboarding, additional business creation and
   * invitation acceptance. NO bypass and NO table CRUD (0032): its only
   * authority is EXECUTE on narrow SECURITY DEFINER commands that verify the
   * server-derived actor's authority INSIDE the same command (0033).
   */
  async withProvisionerTransaction<T>(actorUserId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    // §12: the actor travels as transaction-local context, derived from the
    // authenticated principal by the caller — never from a request body.
    // `null` = no actor: only actor-independent lookups (invitation peek /
    // expire) may run; every mutating command raises PROV:FORBIDDEN.
    return this.run(this.provisionerPool, actorUserId ? { actorUserId } : {}, true, fn);
  }

  async healthCheck(): Promise<boolean> {
    // Per-mode: check every pool this process actually owns.
    const pools = [this.pool, this.platformPool, this.identityPool, this.resolverPool, this.workerPool, this.provisionerPool].filter(
      (x): x is Pool => x !== null,
    );
    if (pools.length === 0) return false;
    try {
      for (const p of pools) await p.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    await Promise.all([this.platformPool?.end(), this.identityPool?.end(), this.resolverPool?.end(), this.workerPool?.end(), this.provisionerPool?.end()]);
  }

  /** Nest lifecycle: pools die with the app — no connection leaks across tests/reloads. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
