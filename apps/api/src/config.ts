import { z } from 'zod';

/**
 * Central validated config (§34). No module reads process.env directly; missing
 * required config fails startup fast.
 *
 * Security Gate Zero (§8–§14):
 * - The API runtime NEVER knows the migration/owner connection. There is no
 *   DATABASE_URL/MIGRATION_DATABASE_URL here — the migration CLI reads
 *   MIGRATION_DATABASE_URL itself, inside the migration command only.
 * - APP_DATABASE_URL (daftar_app) is the normal runtime role — RLS-enforced.
 * - PLATFORM_DATABASE_URL (daftar_platform) is the identity/platform boundary.
 * - Production FAILS CLOSED: local storage, log delivery, memory rate limiter
 *   or a missing platform URL are startup errors, never silent fallbacks.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // §XXV–XXIX: deployment modes within the SAME modular monolith.
    //  - merchant-api: merchant surface only (app/identity/resolver DB roles)
    //  - platform-api: super-admin surface (platform + identity-read DB roles)
    //  - worker:       credential delivery + outbox (worker DB role, key ring, SMTP)
    //  - all:          single-process deployment (small installs, dev/test)
    PROCESS_MODE: z.enum(['merchant-api', 'platform-api', 'worker', 'all']).default('all'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000), // 0 = ephemeral (tests)
    // Required for HTTP modes; the WORKER process must not receive it (§XXVIII).
    APP_DATABASE_URL: z.string().min(1).optional(),
    PLATFORM_DATABASE_URL: z.string().min(1).optional(),
    IDENTITY_DATABASE_URL: z.string().min(1).optional(),
    RESOLVER_DATABASE_URL: z.string().min(1).optional(),
    // §13 (Stabilization): narrow provisioning principal — onboarding,
    // create-business, invitation acceptance ONLY.
    PROVISIONER_DATABASE_URL: z.string().min(1).optional(),
    WORKER_DATABASE_URL: z.string().min(1).optional(),
    // Required for HTTP modes; the WORKER process must not receive it (§XXVIII).
    JWT_SECRET: z.string().min(32).optional(),
    // §56–60: JWT key ring — JSON array [{kid, secret, status:'active'|'previous'}].
    // Exactly one active key signs; active+previous verify (rotation without mass logout).
    // When unset, JWT_SECRET is used as a single legacy key.
    JWT_KEYS: z.string().optional(),
    // §52–55: only trust X-Forwarded-For when explicitly behind a known proxy.
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    // §XXXIX–XL: known proxies of this deployment — comma-separated exact IPs
    // (v4/v6) and/or IPv4 CIDR ranges. When set, XFF is walked right-to-left
    // skipping trusted hops; a direct (untrusted) socket peer voids XFF.
    TRUSTED_PROXIES: z.string().default(''),
    PLATFORM_ROOT_DOMAIN: z.string().min(1).default('localhost:3001'),
    MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
    MEDIA_ROOT: z.string().min(1).default('./var/media'),
    MEDIA_PUBLIC_BASE_URL: z.string().min(1).default('/media'),
    MEDIA_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(5 * 1024 * 1024),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_PUBLIC_BASE_URL: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    REDIS_URL: z.string().optional(),
    CREDENTIAL_DELIVERY_KIND: z.enum(['log', 'smtp']).default('log'),
    CREDENTIAL_PAYLOAD_KEY: z.string().optional(),
    CREDENTIAL_KMS_ENDPOINT: z.string().url().optional(),
    // §23–27: credential encryption key ring — JSON [{version, key(base64 32B), status:'active'|'previous'}].
    CREDENTIAL_PAYLOAD_KEYS: z.string().optional(),
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().email().optional(),
    DEV_MAILBOX_FILE: z.string().min(1).default('./var/dev-mailbox.log'),
    CORS_ORIGINS: z.string().default('http://localhost:3001'),
    // §11 (Final Enforcement): support session lifetime is capped SERVER-SIDE.
    // Arbitrary far-future expiry is rejected; default maximum is 4 hours.
    SUPPORT_SESSION_MAX_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(240),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== 'production') return;
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const mode = c.PROCESS_MODE;
    // §10 (Stabilization): PROCESS_MODE=all is a dev/test convenience ONLY —
    // production must deploy the separated runtimes.
    if (mode === 'all') fail('PROCESS_MODE', 'PROCESS_MODE=all is forbidden in production (dev/test only)');
    if (mode !== 'worker') {
      if (!c.JWT_SECRET && !c.JWT_KEYS) fail('JWT_SECRET', `${mode} requires JWT_SECRET or JWT_KEYS`);
    }
    if (mode === 'all' || mode === 'merchant-api') {
      // Directive §17: the platform process has no merchant (app-role) pool.
      if (!c.APP_DATABASE_URL) fail('APP_DATABASE_URL', `${mode} requires the app DB URL (daftar_app role)`);
    }
    if (mode === 'worker') {
      for (const n of [
        'APP_DATABASE_URL',
        'PLATFORM_DATABASE_URL',
        'IDENTITY_DATABASE_URL',
        'RESOLVER_DATABASE_URL',
        'PROVISIONER_DATABASE_URL',
        'CREDENTIAL_KMS_ENDPOINT',
      ] as const) {
        if (c[n]) fail(n, 'must NOT be set in PROCESS_MODE=worker (worker receives worker DB + key ring + SMTP only)');
      }
    }

    // ── §XXV–XXIX: per-mode SECRET ENVIRONMENT SEPARATION ────────────────
    // A process must not even RECEIVE secrets outside its authority.
    const forbid = (
      name: 'PLATFORM_DATABASE_URL' | 'WORKER_DATABASE_URL' | 'PROVISIONER_DATABASE_URL' | 'CREDENTIAL_PAYLOAD_KEY' | 'CREDENTIAL_PAYLOAD_KEYS' | 'SMTP_URL',
      why: string,
    ): void => {
      if (c[name]) fail(name, `must NOT be set in PROCESS_MODE=${mode} (${why})`);
    };
    if (mode === 'merchant-api') {
      forbid('PLATFORM_DATABASE_URL', 'merchant API has no platform authority');
      forbid('WORKER_DATABASE_URL', 'merchant API has no worker authority');
      forbid('CREDENTIAL_PAYLOAD_KEY', 'decryption keys belong to the worker process');
      forbid('CREDENTIAL_PAYLOAD_KEYS', 'decryption keys belong to the worker process');
      forbid('SMTP_URL', 'delivery is the worker process');
    }
    if (mode === 'platform-api') {
      forbid('WORKER_DATABASE_URL', 'platform API has no worker authority');
      forbid('PROVISIONER_DATABASE_URL', 'provisioning is a merchant-surface boundary');
      forbid('CREDENTIAL_PAYLOAD_KEY', 'no worker credential payload authority');
      forbid('CREDENTIAL_PAYLOAD_KEYS', 'no worker credential payload authority');
      forbid('SMTP_URL', 'delivery is the worker process');
    }

    // ── per-mode REQUIRED configuration ──────────────────────────────────
    if (mode === 'all' || mode === 'platform-api') {
      if (!c.PLATFORM_DATABASE_URL) {
        fail('PLATFORM_DATABASE_URL', `${mode} requires the platform DB URL (daftar_platform role)`);
      } else if (c.PLATFORM_DATABASE_URL === c.APP_DATABASE_URL) {
        fail('PLATFORM_DATABASE_URL', 'must be a distinct role from APP_DATABASE_URL (privilege separation)');
      }
    }
    if (mode === 'all' || mode === 'worker') {
      if (!c.WORKER_DATABASE_URL) {
        fail('WORKER_DATABASE_URL', `${mode} requires the worker DB URL (daftar_worker role)`);
      }
      if (!c.CREDENTIAL_PAYLOAD_KEY && !c.CREDENTIAL_PAYLOAD_KEYS) {
        fail(
          'CREDENTIAL_PAYLOAD_KEYS',
          'production requires CREDENTIAL_PAYLOAD_KEYS (JSON key ring, base64 32-byte AES-256-GCM keys, KMS-managed) or legacy CREDENTIAL_PAYLOAD_KEY. The dev/test key is forbidden in production.',
        );
      }
    }
    if (mode === 'all' || mode === 'merchant-api' || mode === 'platform-api') {
      // HTTP surfaces
      if (!c.REDIS_URL) {
        fail('REDIS_URL', 'production requires REDIS_URL (memory rate limiter is dev-only)');
      }
      if (!c.IDENTITY_DATABASE_URL) {
        fail('IDENTITY_DATABASE_URL', `production requires the identity DB URL (daftar_identity role)`);
      } else if (c.IDENTITY_DATABASE_URL === c.APP_DATABASE_URL || c.IDENTITY_DATABASE_URL === c.PLATFORM_DATABASE_URL) {
        fail('IDENTITY_DATABASE_URL', 'must be distinct from APP_DATABASE_URL and PLATFORM_DATABASE_URL (auth credentials ≠ platform admin credentials)');
      }
    }
    if (mode === 'merchant-api' || mode === 'platform-api') {
      // Part C / Directive §24: HTTP runtimes encrypt (password-reset and
      // invitation enqueue) via a KMS-style provider only — they must never
      // hold credential key material (encrypt OR decrypt) in production.
      if (!c.CREDENTIAL_KMS_ENDPOINT) {
        fail(
          'CREDENTIAL_KMS_ENDPOINT',
          `production ${mode} runtime requires a KMS-style credential encrypt provider (local/DEV keys are structurally forbidden)`,
        );
      }
    }
    if (mode === 'all' || mode === 'merchant-api') {
      if (!c.RESOLVER_DATABASE_URL) {
        fail('RESOLVER_DATABASE_URL', 'production requires the membership-resolver DB URL (daftar_resolver role)');
      }
      if (!c.PROVISIONER_DATABASE_URL) {
        fail('PROVISIONER_DATABASE_URL', 'production requires the provisioning DB URL (daftar_provisioner role)');
      } else if (c.PROVISIONER_DATABASE_URL === c.APP_DATABASE_URL || c.PROVISIONER_DATABASE_URL === c.PLATFORM_DATABASE_URL) {
        fail('PROVISIONER_DATABASE_URL', 'must be a distinct role from APP/PLATFORM (least-privilege provisioning boundary)');
      }
      if (c.MEDIA_STORAGE === 'local') {
        fail('MEDIA_STORAGE', 'production requires MEDIA_STORAGE=s3 (local disk is dev-only)');
      }
      if (c.MEDIA_STORAGE === 's3' && (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
        fail('S3_BUCKET', 'S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are all required for s3 storage');
      }
    }
    if (mode === 'all' || mode === 'worker') {
      if (c.CREDENTIAL_DELIVERY_KIND === 'log') {
        fail('CREDENTIAL_DELIVERY_KIND', 'production requires CREDENTIAL_DELIVERY_KIND=smtp (log delivery is dev-only)');
      }
      if (c.CREDENTIAL_DELIVERY_KIND === 'smtp' && !c.SMTP_URL) {
        fail('SMTP_URL', 'SMTP_URL required when CREDENTIAL_DELIVERY_KIND=smtp');
      }
      if (c.CREDENTIAL_DELIVERY_KIND === 'smtp' && !c.SMTP_FROM) {
        fail('SMTP_FROM', 'SMTP_FROM (sender address) required when CREDENTIAL_DELIVERY_KIND=smtp');
      }
    }
    // §31: ACTUAL PRINCIPALS MUST DIFFER — no aliasing one role's credentials
    // for another pool via misconfiguration.
    const urls: Record<string, string | undefined> = {
      APP_DATABASE_URL: c.APP_DATABASE_URL,
      PLATFORM_DATABASE_URL: c.PLATFORM_DATABASE_URL,
      IDENTITY_DATABASE_URL: c.IDENTITY_DATABASE_URL,
      RESOLVER_DATABASE_URL: c.RESOLVER_DATABASE_URL,
      WORKER_DATABASE_URL: c.WORKER_DATABASE_URL,
    };
    const seen = new Map<string, string>();
    for (const [name, url] of Object.entries(urls)) {
      if (!url) continue;
      const prior = seen.get(url);
      if (prior) fail(name, `duplicates ${prior} — every DB principal must use distinct credentials`);
      seen.set(url, name);
    }
  });

export type AppConfig = z.infer<typeof EnvSchema> & { isTest: boolean; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration (fails fast at startup): ${issues}`);
  }
  const c = parsed.data;
  return { ...c, isTest: c.NODE_ENV === 'test', isProd: c.NODE_ENV === 'production' };
}
