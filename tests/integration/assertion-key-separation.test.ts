/**
 * P3-S8 T-15b — THE THREE ASSERTION KEYS STAY THREE KEYS, AT EVERY SITE
 * (docs/PHASE_3_S8_CONTRACT.md A-19, §6.3 T-15b; TD-12; PM-24, PM-46).
 *
 * `K` and `K‖0x00` are one HMAC-SHA-256 key, and so are a key longer than the
 * 64-byte block and its own SHA-256 digest. Every site that loads or installs
 * a key compares the EFFECTIVE key (`hmacKeysEquivalent`, T-15a proves the
 * function itself); this suite proves each SITE uses it, for every pair —
 * accounting↔provisioning, inventory↔provisioning, inventory↔accounting:
 *   - the production configuration refuses to start;
 *   - both minters refuse at key load, in every mode;
 *   - each `scripts/install-*-key.ts` exits non-zero with the separation
 *     message BEFORE connecting (spawned with a dummy
 *     `BOOTSTRAP_DATABASE_URL` that nothing listens on).
 *
 * NEGATIVE CONTROL: a tree copy of `apps/api/src/config.ts` with the
 * accounting↔provisioning comparison reverted to a byte `.equals` accepts the
 * `K‖0x00` configuration — the effective-key comparison is what refuses it.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config';
import { AccountingAssertionMinterService } from '../../apps/api/src/modules/accounting/accounting-assertion.minter';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';

const execFileP = promisify(execFile);
const REPO = join(__dirname, '../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');

const KMS_BRIDGE = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
} as const;

const PROVISIONING = Buffer.alloc(32, 9).toString('base64');
const ACCOUNTING = Buffer.alloc(32, 11).toString('base64');
const INVENTORY = Buffer.alloc(32, 13).toString('base64');

/** A complete, valid production merchant-api environment (inventory-config.test.ts). */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: PROVISIONING,
  ACCOUNTING_ASSERTION_KEY: ACCOUNTING,
  ACCOUNTING_ASSERTION_KID: 'acct1',
  INVENTORY_ASSERTION_KEY: INVENTORY,
  INVENTORY_ASSERTION_KID: 'inv1',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://redis:6379',
  ...KMS_BRIDGE,
};

const TEST_BASE: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

type KeyVar = 'PROVISIONING_ASSERTION_KEY' | 'ACCOUNTING_ASSERTION_KEY' | 'INVENTORY_ASSERTION_KEY';

/** The two HMAC-equivalent spellings of one secret that a byte comparison calls different. */
interface Equivalence {
  readonly name: string;
  readonly a: string;
  readonly b: string;
}

const K = Buffer.alloc(32, 21);
const LONG = Buffer.from(Array.from({ length: 65 }, (_, i) => (i * 7 + 3) % 251));
const EQUIVALENCES: readonly Equivalence[] = [
  { name: 'K and K‖0x00', a: K.toString('base64'), b: Buffer.concat([K, Buffer.alloc(1, 0)]).toString('base64') },
  { name: 'a 65-byte key and its SHA-256 digest', a: LONG.toString('base64'), b: createHash('sha256').update(LONG).digest().toString('base64') },
];

/** Every pair, each named by the variable that is refused (the one checked second at its site) and the one it collides with. */
const PAIRS: readonly (readonly [KeyVar, KeyVar])[] = [
  ['ACCOUNTING_ASSERTION_KEY', 'PROVISIONING_ASSERTION_KEY'],
  ['INVENTORY_ASSERTION_KEY', 'PROVISIONING_ASSERTION_KEY'],
  ['INVENTORY_ASSERTION_KEY', 'ACCOUNTING_ASSERTION_KEY'],
];

const sameSecret = (refused: KeyVar, other: KeyVar): RegExp => new RegExp(`${refused}: must not be the same secret as ${other}`);

describe('T-15b the production configuration refuses one secret in two domains', () => {
  it('the distinct keys start', () => {
    expect(() => loadConfig(MERCHANT_PROD)).not.toThrow();
  });

  for (const [refused, other] of PAIRS) {
    for (const eq of EQUIVALENCES) {
      it(`${refused} ≡ ${other} as ${eq.name} → refused`, () => {
        expect(() => loadConfig({ ...MERCHANT_PROD, [refused]: eq.b, [other]: eq.a })).toThrow(sameSecret(refused, other));
        expect(() => loadConfig({ ...MERCHANT_PROD, [refused]: eq.a, [other]: eq.b })).toThrow(sameSecret(refused, other));
      });
    }
  }
});

describe('T-15b both minters refuse at key load, in every mode', () => {
  for (const eq of EQUIVALENCES) {
    it(`the accounting minter: accounting ≡ provisioning as ${eq.name}`, () => {
      expect(
        () => new AccountingAssertionMinterService(loadConfig({ ...TEST_BASE, ACCOUNTING_ASSERTION_KEY: eq.b, PROVISIONING_ASSERTION_KEY: eq.a })),
      ).toThrow(/ACCOUNTING_ASSERTION_KEY must not be the same secret as PROVISIONING_ASSERTION_KEY/);
    });

    it(`the inventory minter: inventory ≡ provisioning and inventory ≡ accounting as ${eq.name}`, () => {
      expect(() => new InventoryAssertionMinterService(loadConfig({ ...TEST_BASE, INVENTORY_ASSERTION_KEY: eq.b, PROVISIONING_ASSERTION_KEY: eq.a }))).toThrow(
        /must not be the same secret as PROVISIONING_ASSERTION_KEY/,
      );
      expect(() => new InventoryAssertionMinterService(loadConfig({ ...TEST_BASE, INVENTORY_ASSERTION_KEY: eq.b, ACCOUNTING_ASSERTION_KEY: eq.a }))).toThrow(
        /must not be the same secret as ACCOUNTING_ASSERTION_KEY/,
      );
    });
  }

  it('distinct keys load in both minters', () => {
    const cfg = loadConfig({
      ...TEST_BASE,
      PROVISIONING_ASSERTION_KEY: PROVISIONING,
      ACCOUNTING_ASSERTION_KEY: ACCOUNTING,
      INVENTORY_ASSERTION_KEY: INVENTORY,
    });
    expect(new AccountingAssertionMinterService(cfg).configured).toBe(true);
    expect(new InventoryAssertionMinterService(cfg).configured).toBe(true);
  });
});

describe('PM-24 the install scripts refuse before connecting', () => {
  /** Nothing listens on port 1: a script that connected would fail with a connection error, not the separation message. */
  const DUMMY_BOOTSTRAP = 'postgresql://daftar_platform:x@127.0.0.1:1/none';
  const SCRIPTS: readonly (readonly [string, KeyVar, readonly KeyVar[]])[] = [
    ['scripts/install-accounting-key.ts', 'ACCOUNTING_ASSERTION_KEY', ['PROVISIONING_ASSERTION_KEY', 'INVENTORY_ASSERTION_KEY']],
    ['scripts/install-inventory-key.ts', 'INVENTORY_ASSERTION_KEY', ['PROVISIONING_ASSERTION_KEY', 'ACCOUNTING_ASSERTION_KEY']],
    ['scripts/install-provisioning-key.ts', 'PROVISIONING_ASSERTION_KEY', ['ACCOUNTING_ASSERTION_KEY', 'INVENTORY_ASSERTION_KEY']],
  ];

  async function run(script: string, env: NodeJS.ProcessEnv): Promise<{ readonly code: number; readonly output: string }> {
    const base: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], BOOTSTRAP_DATABASE_URL: DUMMY_BOOTSTRAP };
    try {
      const { stdout, stderr } = await execFileP(TSX, [join(REPO, script)], { cwd: REPO, env: { ...base, ...env } });
      return { code: 0, output: `${stdout}${stderr}` };
    } catch (e) {
      if (e instanceof Error && 'code' in e && typeof e.code === 'number' && 'stdout' in e && 'stderr' in e) {
        return { code: e.code, output: `${String(e.stdout)}${String(e.stderr)}` };
      }
      throw e;
    }
  }

  for (const [script, own, others] of SCRIPTS) {
    it(`PM-24 ${script}: the same secret as either other key (K‖0x00, and a 65-byte key against its digest) exits non-zero before connecting`, async () => {
      for (const other of others) {
        for (const eq of EQUIVALENCES) {
          const r = await run(script, { [own]: eq.b, [other]: eq.a });
          expect(r.code, `${script} ${other} ${eq.name}`).not.toBe(0);
          expect(r.output, `${script} ${other} ${eq.name}`).toContain(`${own} must not be the same secret as ${other}`);
          expect(r.output, 'refused before any connection').not.toMatch(/ECONNREFUSED|connect|daftar_platform \(connected as/);
          expect(r.output, 'the secret is never printed').not.toContain(eq.b);
        }
      }
    }, 120_000);

    it(`PM-24 ${script}: with distinct keys it gets as far as connecting (the dummy URL refuses it)`, async () => {
      const distinct: NodeJS.ProcessEnv = {
        PROVISIONING_ASSERTION_KEY: PROVISIONING,
        ACCOUNTING_ASSERTION_KEY: ACCOUNTING,
        INVENTORY_ASSERTION_KEY: INVENTORY,
      };
      const r = await run(script, distinct);
      expect(r.code).not.toBe(0);
      expect(r.output).not.toMatch(/must not be the same secret/);
      expect(r.output).toMatch(/ECONNREFUSED|connect/);
    }, 60_000);
  }
});

describe('PM-24 NEGATIVE CONTROL — the byte comparison would have accepted K‖0x00', () => {
  it('PM-24 NC: a tree copy of config.ts comparing accounting and provisioning with .equals accepts K‖0x00; the shipped config refuses it', async () => {
    const source = readFileSync(join(REPO, 'apps/api/src/config.ts'), 'utf8');
    const effective = `hmacKeysEquivalent(Buffer.from(c.ACCOUNTING_ASSERTION_KEY, 'base64'), Buffer.from(c.PROVISIONING_ASSERTION_KEY, 'base64'))`;
    expect(source.split(effective).length - 1, 'the accounting↔provisioning comparison occurs exactly once').toBe(1);
    const bytes = source.replace(effective, `Buffer.from(c.ACCOUNTING_ASSERTION_KEY, 'base64').equals(Buffer.from(c.PROVISIONING_ASSERTION_KEY, 'base64'))`);
    // Inside the repository, so the copy resolves `zod` and `@daftar/accounting` exactly as the original does.
    const dir = mkdtempSync(join(REPO, 'apps/api/src/.t15b-'));
    try {
      const copy = join(dir, 'config.ts');
      writeFileSync(copy, bytes);
      const imported: unknown = await import(copy);
      if (typeof imported !== 'object' || imported === null || !('loadConfig' in imported) || typeof imported.loadConfig !== 'function') {
        throw new Error('the tree copy exports no loadConfig');
      }
      const revertedLoad = imported.loadConfig;
      const reverted = (env: NodeJS.ProcessEnv): unknown => Reflect.apply(revertedLoad, undefined, [env]);
      const eq = EQUIVALENCES[0];
      if (eq === undefined) throw new Error('no K‖0x00 equivalence');
      const env = { ...MERCHANT_PROD, ACCOUNTING_ASSERTION_KEY: eq.b, PROVISIONING_ASSERTION_KEY: eq.a, INVENTORY_ASSERTION_KEY: INVENTORY };
      expect(() => reverted(env), 'the byte comparison accepts K‖0x00').not.toThrow();
      expect(() => loadConfig(env), 'the shipped comparison refuses it').toThrow(sameSecret('ACCOUNTING_ASSERTION_KEY', 'PROVISIONING_ASSERTION_KEY'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
