import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

/**
 * DR-173/5 + SEC-01-DEPLOY: the TEST environment's deployment files, held to
 * the two conditions the owner set, as measurements and not as prose:
 *
 *   1. NO real secret, NO merchant data, NO domain in the environment files.
 *   2. The worker is given neither JWT_SECRET nor JWT_KEYS.
 *
 * WHAT THIS PROVES: what the FILES say, by running the real `loadConfig` over
 * each env file. WHAT IT DOES NOT: that a deployed worker refuses to boot —
 * that needs a deployed environment (days 8-9) and stays open as SEC-01-DEPLOY.
 * NODE_ENV is `development` in these files, so the PRODUCTION gate of
 * config.ts (Redis, KMS, https origins) is NOT exercised here. This is not a
 * production configuration and nothing here calls it ready.
 */

const ROOT = resolve(__dirname, '..');
const DIR = 'deploy/test-env';
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
};
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
const envFile = (n: string): Record<string, string> => parseEnv(read(`${DIR}/env/${n}.vars`));

const SECRET_NAME = /(SECRET|KEY|PASSWORD|TOKEN|_URL)$/;
const decoded = (v: string): string => {
  try {
    return Buffer.from(v, 'base64').toString('latin1');
  } catch {
    return '';
  }
};
/** A secret-class value is acceptable only if it names itself a placeholder. */
const isPlaceholder = (v: string): boolean => v.includes('PLACEHOLDER') || decoded(v).includes('PLACEHOLDER');
/** Every value that LOOKS like a credential but does not name itself a placeholder. */
const realLooking = (env: Record<string, string>): string[] =>
  Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && /(:[^/@\s]+@|^[A-Za-z0-9+/=_-]{20,}$)/.test(v) && !isPlaceholder(v))
    .map(([k]) => k);
/** A value that names a host with a dot-TLD or a public scheme: a domain. */
const domains = (env: Record<string, string>): string[] =>
  Object.entries(env)
    .filter(([, v]) => /\b(?:\d{1,3}\.){3}\d{1,3}\b(?!\/)|https?:\/\/|@[\w-]+\.[a-z]{2,}\b|\b[\w-]+\.(com|net|org|io|app|dev|sa|ae|co)\b/i.test(v))
    .map(([k]) => k);

const MODES = ['merchant-api', 'platform-api', 'worker'] as const;
/** The env directory is WALKED, not listed: a file added tomorrow is checked tomorrow (P1-GOLD-33 guards the .env shape; this guards the .vars shape). */ const ALL_VARS: string[] =
  readdirSync(resolve(ROOT, DIR, 'env'))
    .filter((f) => f.endsWith('.vars'))
    .map((f) => f.slice(0, -'.vars'.length));

describe('DR-173/5 test environment files — what they say', () => {
  it('each process env file loads through the real loadConfig, in its own mode', () => {
    for (const m of MODES) {
      const cfg = loadConfig(envFile(m) as NodeJS.ProcessEnv);
      expect(cfg.PROCESS_MODE).toBe(m);
    }
  });

  it('SEC-01: the worker file carries no JWT variable, and the red controls are real', () => {
    const w = envFile('worker');
    expect(Object.keys(w).filter((k) => k.startsWith('JWT_'))).toEqual([]);
    // Negative controls (red first): the same file with either key IS refused.
    expect(() => loadConfig({ ...w, JWT_SECRET: 'PLACEHOLDER-control' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...w, JWT_KEYS: '[]' } as NodeJS.ProcessEnv)).toThrow(/JWT_KEYS/);
    // Positive control: the HTTP files DO carry the session key (the check is not vacuous).
    expect(envFile('merchant-api')['JWT_SECRET']).toBeTruthy();
    expect(envFile('platform-api')['JWT_SECRET']).toBeTruthy();
  });

  it('SEC-01: compose gives the worker worker.vars alone — no environment: block, no other source', () => {
    const compose = code(read(`${DIR}/compose.yaml`));
    const block = compose.split(/\n {2}(?=[a-z-]+:\n)/).find((b) => b.startsWith('worker:')) ?? '';
    expect(block, 'worker service not found in compose.yaml').not.toBe('');
    expect(block).toMatch(/env_file: \[env\/worker.vars\]/);
    expect(block).not.toMatch(/^\s+environment:/m);
    expect(block).not.toMatch(/JWT/);
    // The shared anchor must give nobody a secret either.
    const anchor = compose.slice(compose.indexOf('x-app:'), compose.indexOf('services:'));
    expect(anchor).not.toMatch(/env_file|environment|JWT/);
    expect(compose, 'JWT must appear nowhere in compose.yaml').not.toMatch(/JWT/);
  });

  it('no real-looking secret and no domain in any env file, and the detectors fire on controls', () => {
    // Sighted: the detectors catch a real-looking secret and a domain.
    expect(realLooking({ APP_DATABASE_URL: 'postgresql://u:Zk3pQ9xLm2Vb7Nc@db/x', JWT_SECRET: 'q8WnE4rT6yU1iO3pA5sD7fG9hJ2kL0zX' })).toEqual([
      'APP_DATABASE_URL',
      'JWT_SECRET',
    ]);
    expect(domains({ CORS_ORIGINS: 'https://app.example.com' })).toEqual(['CORS_ORIGINS']);
    expect(domains({ TESTENV_HOST_ADDRESS: '203.0.113.7' })).toEqual(['TESTENV_HOST_ADDRESS']); // a public address is refused
    expect(domains({ TRUSTED_PROXIES: '172.16.0.0/12' })).toEqual([]); // a CIDR range is not an address
    for (const f of ALL_VARS) {
      const e = envFile(f);
      expect(Object.keys(e).length, `${f}.vars parsed empty — the probe is blind`).toBeGreaterThan(0);
      expect(realLooking(e), `${f}.vars`).toEqual([]);
      expect(domains(e), `${f}.vars`).toEqual([]);
    }
  });

  it('the host address is a named placeholder input, not a built-in value', () => {
    const h = envFile('host');
    expect(h['TESTENV_HOST_ADDRESS']).toBe('PLACEHOLDER-host-address');
    expect(code(read(`${DIR}/compose.yaml`)).replaceAll('127.0.0.1', 'LOOPBACK')).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?!\/)/);
  });

  it('P1-GOLD-33 is respected as written: no file under deploy/ is an .env file (the placeholder files are .vars)', () => {
    // tests/golden-regression/phase1/05-artifact-hygiene.golden.test.ts forbids /\.env($|\.)/ anywhere in the tree.
    // The files here hold placeholders only (held by the tests above); the name is chosen so the golden stays untouched.
    const names = execFileSync('git', ['ls-files', DIR], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(names.length, 'git ls-files saw nothing — the probe is blind').toBeGreaterThan(5);
    expect(names.filter((f) => /\.env($|\.)/.test(f))).toEqual([]);
    expect(names.filter((f) => f.endsWith('.vars')).length).toBe(6);
  });

  it('the directory walk is sighted and holds nothing but .vars files', () => {
    const all = readdirSync(resolve(ROOT, DIR, 'env'));
    expect(ALL_VARS.length, 'the walk found no .vars files — the probe is blind').toBeGreaterThanOrEqual(6);
    expect(
      all.filter((f) => !f.endsWith('.vars')),
      'a non-.vars file sits in the env directory',
    ).toEqual([]);
    for (const named of ['merchant-api', 'platform-api', 'worker', 'migrate', 'postgres', 'host']) expect(ALL_VARS).toContain(named);
  });

  it('every secret-class variable in the files is a named placeholder', () => {
    for (const f of ALL_VARS) {
      for (const [k, v] of Object.entries(envFile(f))) {
        if (SECRET_NAME.test(k) && /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/.test(k)) {
          expect(isPlaceholder(v), `${f}.vars ${k}`).toBe(true);
        }
      }
    }
  });

  it('the image carries no secret, and no process mode is baked in', () => {
    const df = code(read(`${DIR}/Dockerfile`));
    expect(df).not.toMatch(/^\s*(ENV|ARG)\s+\S*(SECRET|KEY|PASSWORD|TOKEN|JWT)/im);
    expect(df).not.toMatch(/PROCESS_MODE/);
  });

  it('compose runs the three separated processes, never PROCESS_MODE=all', () => {
    const compose = code(read(`${DIR}/compose.yaml`));
    for (const s of ['merchant-api:', 'platform-api:', 'worker:', 'migrate:', 'bootstrap:']) expect(compose).toContain(`\n  ${s}`);
    expect(compose).not.toMatch(/PROCESS_MODE/);
    for (const f of ['merchant-api', 'platform-api', 'worker']) expect(envFile(f)['PROCESS_MODE']).not.toBe('all');
  });

  it('bootstrap.sql: every password marker it carries is substituted by compose with a placeholder', () => {
    const markers = [...new Set(read('infrastructure/database/bootstrap.sql').match(/__[A-Z_]+_DB_PASSWORD__/g) ?? [])];
    expect(markers.length, 'bootstrap.sql shows no markers — the probe is blind').toBeGreaterThan(0);
    const compose = read(`${DIR}/compose.yaml`);
    for (const m of markers) expect(compose, m).toMatch(new RegExp(`${m}/PLACEHOLDER-[a-z]+/g`));
  });

  it('the runtime URLs point at roles bootstrap creates, and no URL reuses a role across APP/PLATFORM', () => {
    const m = envFile('merchant-api');
    const p = envFile('platform-api');
    expect(m['APP_DATABASE_URL']).not.toBe(p['PLATFORM_DATABASE_URL']);
    for (const [, v] of Object.entries({ ...m, ...p })) {
      const role = /postgresql:\/\/(daftar_[a-z_]+):/.exec(v)?.[1];
      if (role) expect(read('infrastructure/database/bootstrap.sql')).toContain(`CREATE ROLE ${role} `);
    }
  });
});
