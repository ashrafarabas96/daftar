import { readFileSync } from 'node:fs';
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
const envFile = (n: string): Record<string, string> => parseEnv(read(`${DIR}/env/${n}.env`));

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
    .filter(([, v]) => /https?:\/\/|@[\w-]+\.[a-z]{2,}\b|\b[\w-]+\.(com|net|org|io|app|dev|sa|ae|co)\b/i.test(v))
    .map(([k]) => k);

const MODES = ['merchant-api', 'platform-api', 'worker'] as const;

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

  it('SEC-01: compose gives the worker worker.env alone — no environment: block, no other source', () => {
    const compose = code(read(`${DIR}/compose.yaml`));
    const block = compose.split(/\n  (?=[a-z-]+:\n)/).find((b) => b.startsWith('worker:')) ?? '';
    expect(block, 'worker service not found in compose.yaml').not.toBe('');
    expect(block).toMatch(/env_file: \[env\/worker\.env\]/);
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
    for (const f of ['merchant-api', 'platform-api', 'worker', 'migrate', 'postgres']) {
      const e = envFile(f);
      expect(Object.keys(e).length, `${f}.env parsed empty — the probe is blind`).toBeGreaterThan(0);
      expect(realLooking(e), `${f}.env`).toEqual([]);
      expect(domains(e), `${f}.env`).toEqual([]);
    }
  });

  it('every secret-class variable in the files is a named placeholder', () => {
    for (const f of ['merchant-api', 'platform-api', 'worker', 'migrate', 'postgres']) {
      for (const [k, v] of Object.entries(envFile(f))) {
        if (SECRET_NAME.test(k) && /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/.test(k)) {
          expect(isPlaceholder(v), `${f}.env ${k}`).toBe(true);
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
