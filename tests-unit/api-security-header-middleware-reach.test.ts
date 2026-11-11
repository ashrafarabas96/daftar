/**
 * REACH OF THE API'S RESPONSE SECURITY HEADERS.
 *
 * `RequestContextMiddleware` is the single place the API sets
 * X-Content-Type-Options, X-Frame-Options, Referrer-Policy and Cache-Control.
 * It reaches a surface only if that surface's Nest module applies it, and the
 * API has exactly three HTTP modules (the other two process modes use
 * `createApplicationContext` and serve no HTTP). Nothing else asserted that all
 * three apply it, so a fourth HTTP module, or a refactor that dropped the line
 * from one, would have served a surface with no security headers and no test
 * would have gone red.
 *
 * This is a source-text law: it needs no database and no application.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const APP_DIR = join(ROOT, 'apps', 'api', 'src', 'app');
const read = (p: string): string => readFileSync(p, 'utf8');

const HTTP_MODULES = ['app.module.ts', 'merchant-api.module.ts', 'platform-api.module.ts'] as const;

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIPPED_DIRS.has(e.name)) return [];
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : [];
  });

const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');

describe('API security-header middleware reach', () => {
  it('positive control: each HTTP module file is a Nest module with configure() and consumer.apply(', () => {
    for (const file of HTTP_MODULES) {
      const src = read(join(APP_DIR, file));
      expect(src, `${file} @Module`).toMatch(/@Module\(/);
      expect(src, `${file} configure`).toMatch(/configure\(consumer: MiddlewareConsumer\)/);
      expect(src, `${file} consumer.apply`).toMatch(/consumer\s*\.apply\(/);
    }
  });

  it('positive control: the middleware really sets the four security headers', () => {
    const src = read(join(APP_DIR, 'request-context.middleware.ts'));
    for (const h of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Cache-Control']) {
      expect(src, h).toContain(`setHeader('${h}'`);
    }
  });

  for (const file of HTTP_MODULES) {
    it(`${file} applies RequestContextMiddleware to every route`, () => {
      const src = read(join(APP_DIR, file));
      expect(src).toMatch(/consumer\s*\.apply\(\s*RequestContextMiddleware\s*\)\s*\.forRoutes\(\s*'\*'\s*\)/);
    });
  }

  it('the set of source files that configure middleware is exactly the three HTTP modules', () => {
    const files = [join(ROOT, 'apps'), join(ROOT, 'packages')]
      .flatMap((d) => walk(d))
      .filter((f) => /\bMiddlewareConsumer\b|\bconfigure\s*\(\s*consumer\b/.test(read(f)))
      .map(rel)
      .sort();
    expect(files).toEqual(HTTP_MODULES.map((f) => `apps/api/src/app/${f}`).sort());
  });

  it('the entrypoint creates an HTTP app from exactly those three modules and no other', () => {
    const main = read(join(ROOT, 'apps', 'api', 'src', 'main.ts'));
    expect(main.match(/NestFactory\.create\(/g) ?? []).toHaveLength(1);
    expect(main.match(/NestFactory\.createApplicationContext\(/g) ?? []).toHaveLength(2);
    const sel = main.match(/const module =([\s\S]*?);\s*const app = await NestFactory\.create\(/);
    expect(sel, 'module selection expression').not.toBeNull();
    const names = [...(sel?.[1] ?? '').matchAll(/(\w+Module)\.register\(/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['AppModule', 'MerchantApiModule', 'PlatformApiModule']);
  });
});
