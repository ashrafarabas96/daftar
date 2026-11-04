/**
 * C1.5 — THE TWO THINGS THE SCHEMA FLOOR GATE'S CLAIMS REST ON, AND NOTHING
 * ELSE HELD.
 *
 * The gate makes two claims. One is about ORDER — «no money read can precede
 * this check» — and it is structural: `Database` is produced by a factory that
 * declares `SCHEMA_VERSION_GUARD` in its `inject` list, Nest cannot construct
 * a provider before its dependencies resolve, and so the handle every money
 * read needs does not exist until the check has passed. The other is about
 * SUBJECT — «the database this process reads» — and it is derived from
 * `PROCESS_MODE` by `schemaGateTargets`, mirroring the pool-ownership decision
 * inside `Database`.
 *
 * Both were unguarded.
 *
 *   — THE ORDER. Nothing pinned the `inject` list. `SCHEMA_VERSION_GUARD`
 *     appeared in the test tree only inside a comment, so an edit that dropped
 *     it from `Database`'s `inject` would have destroyed the only structural
 *     evidence for the ordering claim and left every test green. The gate
 *     would still exist, still be provided, still pass — and simply no longer
 *     stand between the application and its first money read.
 *   — THE SUBJECT. `schemaGateTargets` is a mirror of `database.ts`, and a
 *     mirror drifts. A mode added to one and not the other, or an ownership
 *     rule changed on one side, would narrow what the gate looks at without
 *     narrowing what the process reads.
 *
 * So this file holds both, and it holds them BEHAVIOURALLY rather than by
 * reading source text: it asks `coreProviders` for the provider it actually
 * returns, and it builds a real `Database` and compares the pools that
 * actually came out. It needs no database to do either — `new Pool()` opens no
 * connection until something queries it, which is what lets this live in the
 * unit lane and run on every CI run.
 *
 * ── WHAT WOULD MAKE THIS FILE VACUOUS ─────────────────────────────────────
 *
 * Every assertion here would pass against a probe that found nothing: an
 * `inject` list read off the wrong provider, a pool map read off the wrong
 * fields, a mode matrix that silently matched empty against empty. Each
 * section therefore opens with a positive control that fails if its probe came
 * back empty — the provider must be found, the field names must be the ones
 * `Database` really uses, and at least one mode must yield a non-empty set.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { coreProviders, SCHEMA_VERSION_GUARD, schemaGateTargets, type SchemaGateConfig } from '../apps/api/src/app/runtime';
import { Database } from '../apps/api/src/infra/database';
import type { AppConfig } from '../apps/api/src/config';

type FactoryProvider = { provide: unknown; useFactory: (...args: never[]) => unknown; inject?: unknown[] };

const isFactoryFor = (p: unknown, token: unknown): p is FactoryProvider =>
  typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === token && 'useFactory' in p;

/** Enough of an `AppConfig` for `coreProviders` to build its array and for `Database` to decide its pools. */
const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    NODE_ENV: 'test',
    PROCESS_MODE: 'all',
    LOG_LEVEL: 'silent',
    isTest: true,
    isProd: false,
    ...over,
  }) as AppConfig;

describe('C1.5 — the ordering claim: `Database` depends on the gate, and the dependency is load-bearing', () => {
  it('`coreProviders` returns `Database` as a factory whose `inject` list names SCHEMA_VERSION_GUARD', () => {
    const providers = coreProviders(cfg());

    // POSITIVE CONTROL. Everything below reads this provider; if the probe
    // found nothing, every later assertion would be about `undefined` and
    // would be trivially satisfiable.
    const found = providers.filter((p) => isFactoryFor(p, Database));
    expect(found.length, `coreProviders no longer returns exactly one factory provider for Database — the probe below reads nothing`).toBe(1);
    const db = found[0] as FactoryProvider;

    // The gate must be PROVIDED at all...
    expect(
      providers.some((p) => typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === SCHEMA_VERSION_GUARD),
      `SCHEMA_VERSION_GUARD is no longer provided, so there is no gate to depend on`,
    ).toBe(true);

    // ...and `Database` must DEPEND on it. This is the ordering claim's only
    // structural evidence. Drop the token from this list and Nest is free to
    // construct the database handle before the schema has been checked.
    expect(
      db.inject,
      `Database's inject list no longer names SCHEMA_VERSION_GUARD — «no money read can precede the gate» is now a declaration-order ` +
        `coincidence rather than a structural guarantee, and nothing else in this repository would have noticed`,
    ).toContain(SCHEMA_VERSION_GUARD);
  });

  it('the gate is injected at the position the factory reads, and the factory REFUSES a resolution that is not an ordinal', () => {
    const db = coreProviders(cfg()).filter((p) => isFactoryFor(p, Database))[0] as FactoryProvider;
    const at = (db.inject ?? []).indexOf(SCHEMA_VERSION_GUARD);
    expect(at, `SCHEMA_VERSION_GUARD is not in the inject list at all`).toBeGreaterThanOrEqual(0);

    // An injected dependency nobody reads is one a later edit drops without
    // anything going red. The factory reads it, and throws when it is not the
    // ordinal the gate promises — so the dependency cannot decay into
    // decoration. Argument `at` is the gate's slot; everything else is left
    // undefined deliberately, so the throw can only come from that check.
    const args: unknown[] = (db.inject ?? []).map(() => undefined);
    args[at] = 'not-an-ordinal';
    expect(
      () => db.useFactory(...(args as never[])),
      `the Database factory accepted a gate resolution that was not an ordinal, so the injected dependency is decoration`,
    ).toThrow();
  });
});

describe('C1.5 — the subject claim: the gate looks at exactly the databases `Database` opens pools for', () => {
  /** `Database`'s private pool fields, by the role name `schemaGateTargets` uses. */
  const POOL_FIELDS: readonly (readonly [string, string])[] = [
    ['app', 'pool'],
    ['platform', 'platformPool'],
    ['identity', 'identityPool'],
    ['resolver', 'resolverPool'],
    ['worker', 'workerPool'],
    ['provisioner', 'provisionerPool'],
    ['reconciler', 'reconcilerPool'],
  ];

  /** The URLs a real `Database` actually opened, read off the pools themselves. */
  const poolsOf = (config: AppConfig): { roles: string[]; urls: Set<string> } => {
    const d = new Database(config) as unknown as Record<string, Pool | null>;
    const roles: string[] = [];
    const urls = new Set<string>();
    for (const [role, field] of POOL_FIELDS) {
      expect(field in d, `Database no longer has a \`${field}\` field, so this probe reads nothing for the ${role} role`).toBe(true);
      const p = d[field];
      if (p === null || p === undefined) continue;
      roles.push(role);
      const url = (p as unknown as { options?: { connectionString?: string } }).options?.connectionString;
      expect(url, `the ${role} pool exposes no connectionString, so the comparison below is empty`).toBeTypeOf('string');
      urls.add(url as string);
    }
    return { roles, urls };
  };

  const U = {
    app: 'postgresql://daftar_app:p@h:5432/daftar',
    platform: 'postgresql://daftar_platform:p@h:5432/daftar',
    identity: 'postgresql://daftar_identity:p@h:5432/daftar',
    resolver: 'postgresql://daftar_resolver:p@h:5432/daftar',
    worker: 'postgresql://daftar_worker:p@h:5432/daftar',
    provisioner: 'postgresql://daftar_provisioner:p@h:5432/daftar',
    reconciler: 'postgresql://daftar_reconciler:p@h:5432/daftar',
  } as const;

  /**
   * The matrix. Each row is a `PROCESS_MODE` with the URLs that mode is
   * actually allowed to hold — `merchant-api` with four, the reconciler with
   * one and NO app URL (which `config.ts` forbids it in every environment,
   * and which is the defect this whole card exists for), `worker` with one,
   * and `all` twice: once fully configured and once with the app URL alone,
   * which is how every test in this repository composes it and which exercises
   * the dev-only fallback.
   */
  const MATRIX: readonly (readonly [string, AppConfig])[] = [
    [
      'merchant-api',
      cfg({
        PROCESS_MODE: 'merchant-api',
        APP_DATABASE_URL: U.app,
        IDENTITY_DATABASE_URL: U.identity,
        RESOLVER_DATABASE_URL: U.resolver,
        PROVISIONER_DATABASE_URL: U.provisioner,
      }),
    ],
    ['merchant-api, app URL alone', cfg({ PROCESS_MODE: 'merchant-api', APP_DATABASE_URL: U.app })],
    ['platform-api', cfg({ PROCESS_MODE: 'platform-api', PLATFORM_DATABASE_URL: U.platform, IDENTITY_DATABASE_URL: U.identity })],
    ['platform-api, platform URL alone', cfg({ PROCESS_MODE: 'platform-api', PLATFORM_DATABASE_URL: U.platform })],
    ['worker', cfg({ PROCESS_MODE: 'worker', WORKER_DATABASE_URL: U.worker })],
    ['reconciler', cfg({ PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: U.reconciler })],
    [
      'all, fully configured',
      cfg({ PROCESS_MODE: 'all', ...Object.fromEntries(POOL_FIELDS.map(([r]) => [`${r.toUpperCase()}_DATABASE_URL`, U[r as keyof typeof U]])) }),
    ],
    ['all, app URL alone (the dev fallback)', cfg({ PROCESS_MODE: 'all', APP_DATABASE_URL: U.app })],
    // A process whose own URL is absent owns no pool — and the gate must then
    // refuse rather than connect to the ambient environment, which is asserted
    // in `tests/integration/dr71-schema-floor-guard.test.ts` §6 where a live
    // connection can prove no connection was attempted.
    ['worker with no URL at all', cfg({ PROCESS_MODE: 'worker' })],
  ];

  it('the probe is not empty: at least one mode opens pools and the gate names URLs for it', () => {
    const [, merchant] = MATRIX[0] as readonly [string, AppConfig];
    expect(poolsOf(merchant).urls.size, `the pool probe found no URLs, so every comparison below is empty against empty`).toBeGreaterThan(0);
    expect(schemaGateTargets(merchant as SchemaGateConfig).length, `the gate resolved no targets for a fully configured merchant process`).toBeGreaterThan(0);
  });

  it.each(MATRIX.map(([name, config]) => [name, config] as const))(
    'PROCESS_MODE %s: the gate checks exactly the distinct databases Database opens',
    (name, config) => {
      const actual = poolsOf(config);
      const targets = schemaGateTargets(config as SchemaGateConfig);

      // The gate's URL set must equal the pools' URL set. Not a subset: a gate
      // that checked FEWER databases than the process reads is the defect this
      // card fixed, and one that checked MORE would refuse a correct
      // deployment over a database the process never touches.
      expect(
        [...new Set(targets.map((t) => t.url))].sort(),
        `the gate's subject for ${name} is not the set of databases this process reads — it checks ` +
          `[${targets.map((t) => t.role).join(', ') || 'nothing'}] while Database opens [${actual.roles.join(', ') || 'nothing'}]`,
      ).toEqual([...actual.urls].sort());

      // And no URL may be listed twice: the gate opens a connection per
      // target, and a duplicate is a connection spent proving the same thing.
      expect(new Set(targets.map((t) => t.url)).size, `the gate lists the same database twice for ${name}`).toBe(targets.length);
    },
  );

  it('the reconciler is the case that was broken: its subject is its own URL, and the app URL is not consulted', () => {
    const config = cfg({ PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: U.reconciler });
    expect(schemaGateTargets(config as SchemaGateConfig)).toEqual([{ role: 'reconciler', url: U.reconciler }]);

    // Even if an app URL were somehow present, the reconciler does not own an
    // app pool — so the gate must not reach for it. `config.ts` rejects this
    // combination outright; the gate does not rely on that, because a check
    // that is correct only because something upstream refuses the input is
    // one URL change away from being wrong.
    const withApp = cfg({ PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: U.reconciler, APP_DATABASE_URL: U.app });
    expect(schemaGateTargets(withApp as SchemaGateConfig).map((t) => t.url)).toEqual([U.reconciler]);
  });
});
