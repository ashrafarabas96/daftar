/**
 * REACH OF THE API'S RESPONSE SECURITY HEADERS.
 *
 * `RequestContextMiddleware` is the single place the API sets
 * X-Content-Type-Options, X-Frame-Options, Referrer-Policy and Cache-Control.
 * It reaches a surface only if that surface's Nest module applies it, and the
 * API has exactly three HTTP modules (the other two process modes use
 * `createApplicationContext` and serve no HTTP).
 *
 * WHAT WAS AND WAS NOT ALREADY COVERED — corrected after review, because the
 * first version of this comment claimed more than was true:
 *   - `app.module.ts` WAS already covered. `tests/security/rel09-api-security-headers-wiring.test.ts`
 *     boots a real application through `createTestApp`, which composes
 *     `AppModule` (`tests/helpers/test-app.ts`), and asserts the headers on
 *     live 200 and 401 responses. Dropping the registration there was red
 *     before this law existed.
 *   - `merchant-api.module.ts` and `platform-api.module.ts` were NOT. No test
 *     reached either composition, so a refactor that dropped the line from
 *     one of them — or a fourth HTTP module added without it — would have
 *     served a surface with no security headers and nothing would have gone
 *     red.
 * So this law's subject is those two compositions and the claim that the set
 * is exactly three; `app.module.ts` is held here as well, cheaply, but it is
 * not where the gap was.
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
    const expr = sel?.[1] ?? '';
    expect(expr).not.toBe('');
    // EVERY module identifier in the selection, not only those called through
    // `.register(`. Matching the call form let a fourth HTTP composition
    // referenced directly — `SomeModule` with no `.register(` — pass this case
    // green while serving a surface with no security headers, and the closure
    // case below could not catch it either: a module that forgets the
    // middleware never mentions `MiddlewareConsumer`, so it never enters that
    // set. (Review of this PR, finding 2.)
    const names = [...new Set([...expr.matchAll(/\b(\w+Module)\b/g)].map((m) => m[1]))].sort();
    expect(names).toEqual(['AppModule', 'MerchantApiModule', 'PlatformApiModule']);
  });

  it('and no second entrypoint can create an HTTP app behind this law', () => {
    // The case above reads `main.ts`. That is the whole claim only if `main.ts`
    // is the only place an HTTP application is created: a second entrypoint
    // would compose whatever it liked, unmeasured. (Review of this PR,
    // finding 2, second half.)
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) sources.push(p);
      }
    };
    walk(join(ROOT, 'apps', 'api', 'src'));
    expect(sources.length).toBeGreaterThan(20); // positive control: the walk found the tree
    const creators = sources
      .filter((p) => /NestFactory\.create\(/.test(read(p)))
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .sort();
    expect(creators).toEqual(['apps/api/src/main.ts']);
  });

  it('NEGATIVE CONTROL: the two non-HTTP process modules are not in the set, and the reader can tell', () => {
    // The preamble claims the other two process modes serve no HTTP. If the
    // reader matched them too, the "exactly three" assertion would be true by
    // a coincidence of counting rather than by what it names.
    for (const name of ['worker.module.ts', 'reconciler.module.ts']) {
      const p = join(APP_DIR, name);
      const text = read(p);
      expect(text, `${name} must exist to be excluded`).not.toBe('');
      expect(text).not.toContain('MiddlewareConsumer');
      expect(text).not.toContain('RequestContextMiddleware');
    }
  });
});
