import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../../apps/api/src/app/app.module';
import { MerchantApiModule } from '../../apps/api/src/app/merchant-api.module';
import { PlatformApiModule } from '../../apps/api/src/app/platform-api.module';
import { WorkerModule } from '../../apps/api/src/app/worker.module';
import { ReconcilerModule } from '../../apps/api/src/app/reconciler.module';
import { AdminController } from '../../apps/api/src/modules/admin/admin.controller';
import { compositionProblems, type Composition, type Discovered } from '../../scripts/guards/process-composition';

/**
 * TL-P4-S3-R5 — THE PROCESS COMPOSITION GUARD, BIDIRECTIONAL.
 *
 * ── What this file used to prove, and what it could not ─────────────────
 *
 * It held ONE containment: every controller `MerchantApiModule` composes,
 * `AppModule` composes too. That law is real and it is still here
 * (`TESTABILITY`, below) — it is why the three accounting routes of P2-S4
 * can no longer be added to the production process alone and go unexercised.
 *
 * What one containment cannot see:
 *
 *   — a `*.controller.ts` with a real `@Controller()` on it that NO module
 *     registers. Both lists agree; the file serves nothing; green.
 *   — a controller mounted in the WRONG process. `AdminController` in
 *     `MerchantApiModule` would have kept both lists in agreement and handed
 *     the merchant runtime the platform surface. Green.
 *
 * The Tech Lead's ruling requires six properties, and each is a named law
 * below and in `scripts/guards/process-composition.ts`:
 *
 *   P1  every controller declared in the authoritative process composition
 *       appears where expected;
 *   P2  every production controller is reachable through at least one
 *       intended production module/process;
 *   P3  no controller accidentally exists only as a file;
 *   P4  no test fixture and no import statement may satisfy the check;
 *   P5  a planted unattached controller ⇒ RED;
 *   P6  a planted wrong-process controller ⇒ RED.
 *
 * ── HOW COMPOSITION IS ESTABLISHED: MODULE REFLECTION, NOT SOURCE TEXT ──
 *
 * `COMPOSITIONS` below calls each process module's own `register()` and reads
 * the `controllers` array off the returned `DynamicModule`. That array is the
 * one Nest's injector walks when it instantiates the process, so membership
 * in it IS the composition fact, and the law compares CONSTRUCTOR IDENTITY
 * against it (`Set.has`), never a name and never a line of source.
 *
 * Source scanning has exactly one job here: `discoverControllers()`
 * ENUMERATES CANDIDATE FILES. Its shortlist is deliberately over-inclusive —
 * any file under `apps/api/src/` whose text contains the substring
 * `Controller`, which sweeps in every module file that merely IMPORTS one.
 * Whether a candidate is a controller is then settled by importing it and
 * asking Nest: `Reflect.getOwnMetadata(PATH_METADATA, value)`, the metadata
 * `@Controller()` itself writes. An import line cannot produce that metadata,
 * which is the whole of P4 and is asserted directly against the real
 * `app.module.ts` below.
 *
 * ── DAFTAR COMPOSES NEST TWICE ──────────────────────────────────────────
 *
 * `PROCESS_MODE=all` (`AppModule`) is DEV AND TEST ONLY; production config
 * validation refuses it (Directive §19). The deployed runtimes are
 * `merchant-api`, `platform-api`, `worker` and `reconciler`. So "mounted" is
 * never asserted on its own: `kind` separates the two compositions, P2 counts
 * only PRODUCTION mounts, `TESTABILITY` catches production-only (untestable)
 * and `DEAD-ROUTE` catches test-only (serves nothing).
 */

const REPO = join(__dirname, '..', '..');
const SOURCE_ROOT = 'apps/api/src';

/** The modules take a config they never read at composition time; nothing here boots a runtime. */
const OPTIONS = { config: {} as never };

type Ctor = abstract new (...args: never[]) => unknown;

/** The reflected `controllers` array of a `DynamicModule`, as an identity set. */
function reflectControllers(dynamic: { controllers?: unknown }): ReadonlySet<Ctor> {
  return new Set((dynamic.controllers ?? []) as readonly Ctor[]);
}

/**
 * THE FIVE COMPOSED PROCESSES, each reflected off its own module factory.
 * `worker` and `reconciler` are here precisely BECAUSE they compose no
 * controller: a law that only reflects the processes it expects controllers
 * in cannot notice one appearing where none belongs (P6).
 */
const COMPOSITIONS: readonly Composition<Ctor>[] = [
  {
    process: 'merchant-api',
    kind: 'production',
    source: `${SOURCE_ROOT}/app/merchant-api.module.ts`,
    controllers: reflectControllers(MerchantApiModule.register(OPTIONS)),
  },
  {
    process: 'platform-api',
    kind: 'production',
    source: `${SOURCE_ROOT}/app/platform-api.module.ts`,
    controllers: reflectControllers(PlatformApiModule.register(OPTIONS)),
  },
  { process: 'worker', kind: 'production', source: `${SOURCE_ROOT}/app/worker.module.ts`, controllers: reflectControllers(WorkerModule.register(OPTIONS)) },
  {
    process: 'reconciler',
    kind: 'production',
    source: `${SOURCE_ROOT}/app/reconciler.module.ts`,
    controllers: reflectControllers(ReconcilerModule.register(OPTIONS)),
  },
  { process: 'all', kind: 'test-composition', source: `${SOURCE_ROOT}/app/app.module.ts`, controllers: reflectControllers(AppModule.register(OPTIONS)) },
];

/**
 * THE AUTHORITATIVE PROCESS COMPOSITION — controller → the PRODUCTION
 * processes it belongs to.
 *
 * This is a DECLARATION, not a derivation. If it were read out of the modules
 * it would be the tree holding itself to itself, and a controller moved to
 * the wrong process would move the expectation with it. Every row is checked
 * from both sides: the declared process must register it (P1) and no other
 * production process may (P6).
 *
 * `all` is not a column. The test composition is required to be exactly the
 * union of the production processes — that is the `TESTABILITY` /
 * `DEAD-ROUTE` pair — so writing it out again would be a second place for the
 * same fact to drift.
 */
const MERCHANT = ['merchant-api'] as const;
const INTENDED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The identity surface both HTTP runtimes serve.
  AuthController: ['merchant-api', 'platform-api'],
  HealthController: ['merchant-api', 'platform-api'],
  // Platform-only. §16: the merchant runtime must never carry the admin surface.
  AdminController: ['platform-api'],
  // The merchant surface.
  PlatformController: MERCHANT,
  TenancyController: MERCHANT,
  CatalogController: MERCHANT,
  EntitlementsController: MERCHANT,
  AccountingController: MERCHANT,
  InventoryConfigurationController: MERCHANT,
  InventoryMovementsController: MERCHANT,
  SuppliersController: MERCHANT,
  PurchasesController: MERCHANT,
  SupplierReturnsController: MERCHANT,
  SupplierCreditNotesController: MERCHANT,
  PaymentMethodsController: MERCHANT,
  SupplierSettlementsController: MERCHANT,
  InventoryReadsController: MERCHANT,
  SupplierBalancesController: MERCHANT,
  PaymentMethodDefaultsController: MERCHANT,
  // P4-S1 / P4-S2.
  CustomersController: MERCHANT,
  InvoicesController: MERCHANT,
  SalesController: MERCHANT,
  // P4-S3 — the POS till surface.
  TillSessionsController: MERCHANT,
  PosReadsController: MERCHANT,
  PosCartController: MERCHANT,
});

// ───── CANDIDATE ENUMERATION (source scanning, and ONLY for candidates) ───

/**
 * `main.ts` boots a process on import. It is excluded by name, with that
 * reason, and `discovery excludes only the process entry point` below asserts
 * the exclusion set is exactly this one file — an exclusion list nobody
 * bounds is a hole that grows.
 */
const ENTRY_POINTS: readonly string[] = [`${SOURCE_ROOT}/main.ts`];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, dir)).sort()) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(REPO, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(rel);
  }
  return out;
}

/**
 * The shortlist. DELIBERATELY over-inclusive: the bare substring `Controller`
 * matches `import { AdminController } from …` and every `controllers: [ … ]`
 * entry, so every module file is a candidate. Nothing about being on this
 * list establishes anything.
 */
export function candidateFiles(): readonly string[] {
  return walk(SOURCE_ROOT).filter((f) => !ENTRY_POINTS.includes(f) && readFileSync(join(REPO, f), 'utf8').includes('Controller'));
}

/** How many `@Controller(...)` decorators the file's source carries — corroboration only; see the P3 case that uses it. */
function decoratorCount(file: string): number {
  return [...readFileSync(join(REPO, file), 'utf8').matchAll(/@Controller\s*\(/g)].length;
}

/**
 * The FACT. Each candidate is imported and each exported value is asked
 * whether Nest's `@Controller()` wrote `PATH_METADATA` ON IT —
 * `getOwnMetadata`, so a subclass does not inherit controller-hood from a
 * base it merely extends.
 */
async function discoverControllers(): Promise<readonly Discovered<Ctor>[]> {
  const found = new Map<Ctor, string>();
  for (const file of candidateFiles()) {
    const module: Record<string, unknown> = await import(pathToFileURL(join(REPO, file)).href);
    for (const value of Object.values(module)) {
      if (typeof value !== 'function') continue;
      if (Reflect.getOwnMetadata(PATH_METADATA, value) === undefined) continue;
      if (!found.has(value as Ctor)) found.set(value as Ctor, file);
    }
  }
  return [...found].map(([controller, file]) => ({ controller, file }));
}

const label = (c: Ctor): string => (c as { name: string }).name;

const discovered = await discoverControllers();

describe('the process compositions carry exactly the controllers the authoritative composition places in them', () => {
  const run = (over: Partial<Parameters<typeof compositionProblems<Ctor>>[0]> = {}): string[] =>
    compositionProblems<Ctor>({ compositions: COMPOSITIONS, discovered, intended: INTENDED, label, testComposition: 'all', sourceRoot: SOURCE_ROOT, ...over });

  it('P1–P3: the whole bidirectional law holds over the reflected compositions and the discovered controllers', () => {
    expect(run(), 'the process composition law refuses this tree').toEqual([]);
  });

  it('establishes composition by MODULE REFLECTION: every reflected set is non-empty where it must be and empty where it must be', () => {
    const of = (p: string): ReadonlySet<Ctor> => (COMPOSITIONS.find((c) => c.process === p) as Composition<Ctor>).controllers;
    // Reflected off the DynamicModule, not read out of the source.
    expect(of('merchant-api').size, 'the merchant runtime composes no controller — the reflection is not reaching the composition').toBeGreaterThan(0);
    expect(of('platform-api').size).toBeGreaterThan(0);
    expect(of('all').size).toBeGreaterThan(0);
    // §18: no HTTP surface in either background runtime. A controller here is
    // a route in a process that was built to have none.
    expect([...of('worker')].map(label), 'the worker process has no HTTP surface').toEqual([]);
    expect([...of('reconciler')].map(label), 'the reconciler process has no HTTP surface').toEqual([]);
  });

  it('P2: discovery found every controller the compositions register, and the two sets are the same set', () => {
    const composed = new Set<Ctor>();
    for (const c of COMPOSITIONS) for (const k of c.controllers) composed.add(k);
    const discoveredSet = new Set(discovered.map((d) => d.controller));
    expect(
      sortedNames([...composed].filter((k) => !discoveredSet.has(k))),
      'a composed controller that source discovery never found — discovery is blind to part of the tree',
    ).toEqual([]);
    expect(sortedNames([...discoveredSet].filter((k) => !composed.has(k))), 'a discovered controller no composition registers').toEqual([]);
  });

  it('P3: every `@Controller(` in the production tree resolved to an exported class the law could see', () => {
    // Corroboration, never satisfaction: this can only ADD a violation. A
    // `@Controller()` class that is not exported cannot be registered by any
    // module and cannot be imported here either, so without this count it
    // would be invisible to both sides at once.
    const byFile = new Map<string, number>();
    for (const d of discovered) byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1);
    const mismatched = candidateFiles()
      .map((file) => ({ file, decorators: decoratorCount(file), exported: byFile.get(file) ?? 0 }))
      .filter((r) => r.decorators !== r.exported);
    expect(mismatched, 'a file carries @Controller() decorators the law could not resolve to an exported class').toEqual([]);
  });

  it('P4: discovery excludes only the process entry point, and no counted controller came from a test, fixture or mock path', () => {
    expect(ENTRY_POINTS, 'the exclusion set grew — every excluded file is a controller this law cannot see').toEqual([`${SOURCE_ROOT}/main.ts`]);
    for (const file of ENTRY_POINTS) expect(statSync(join(REPO, file)).isFile(), `${file} is excluded by name and does not exist`).toBe(true);
    for (const d of discovered) expect(d.file.startsWith(`${SOURCE_ROOT}/`), `${label(d.controller)} came from ${d.file}`).toBe(true);
    // Nothing under tests/ is on the candidate list at all.
    expect(candidateFiles().filter((f) => f.includes(`${sep}tests${sep}`) || f.startsWith('tests/'))).toEqual([]);
  });

  it('P4: AN IMPORT STATEMENT DOES NOT SATISFY THE CHECK — app.module.ts is a candidate and contributes no controller', () => {
    const appModuleFile = `${SOURCE_ROOT}/app/app.module.ts`;
    // It is shortlisted: its text is full of the substring `Controller`.
    expect(candidateFiles(), 'the shortlist is not over-inclusive, so this case proves nothing').toContain(appModuleFile);
    expect(readFileSync(join(REPO, appModuleFile), 'utf8')).toContain('import { AdminController }');
    // And it contributes nothing, because an import writes no PATH_METADATA.
    expect(
      discovered.filter((d) => d.file === appModuleFile).map((d) => label(d.controller)),
      'a module file that only imports controllers was counted as defining one',
    ).toEqual([]);
    // AdminController is counted exactly once, from the file that DEFINES it.
    const admin = discovered.filter((d) => d.controller === (AdminController as unknown as Ctor));
    expect(admin.map((d) => d.file)).toEqual([`${SOURCE_ROOT}/modules/admin/admin.controller.ts`]);
  });

  it('P4: a module whose source imports a controller but whose `controllers` array omits it is RED', () => {
    // The import-vs-registration distinction, as a law-level proof. The
    // composition handed in is what such a module reflects: the symbol is in
    // scope, the registration is not there.
    const ghost = class GhostController {} as unknown as Ctor;
    const problems = run({
      compositions: [
        { process: 'merchant-api', kind: 'production', source: 'imports-it-but-does-not-register-it.module.ts', controllers: new Set<Ctor>() },
        { process: 'all', kind: 'test-composition', source: 'app.module.ts', controllers: new Set<Ctor>() },
      ],
      discovered: [{ controller: ghost, file: `${SOURCE_ROOT}/modules/ghost/ghost.controller.ts` }],
      intended: { GhostController: ['merchant-api'] },
    });
    expect(
      problems.some((p) => p.startsWith('P1: GhostController is declared for process merchant-api') && p.endsWith('a declaration is not a registration')),
      problems.join('\n'),
    ).toBe(true);
    expect(
      problems.some((p) => p.startsWith('P2: GhostController')),
      problems.join('\n'),
    ).toBe(true);
    expect(
      problems.some((p) => p.startsWith('P3: GhostController')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('P4: a controller discovered from a test fixture path cannot satisfy the law', () => {
    // Both halves of P4's file rule: a fixture OUTSIDE the production source
    // root, and one inside it on a fixture path.
    const outside = class OutsideFixtureController {} as unknown as Ctor;
    const inside = class InsideFixtureController {} as unknown as Ctor;
    const problems = run({
      discovered: [
        ...discovered,
        { controller: outside, file: 'tests/helpers/fixture.controller.ts' },
        { controller: inside, file: `${SOURCE_ROOT}/modules/catalog/__fixtures__/catalog.controller.ts` },
      ],
    });
    expect(
      problems.some((p) => p.startsWith('P4: OutsideFixtureController') && p.includes(`outside the production source root ${SOURCE_ROOT}/`)),
      problems.join('\n'),
    ).toBe(true);
    expect(
      problems.some((p) => p.startsWith('P4: InsideFixtureController') && p.includes('test, fixture or mock path')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('P5 (law level): red — a planted unattached controller is refused by P2 and P3', () => {
    const planted = class PlantedUnattachedController {} as unknown as Ctor;
    const problems = run({ discovered: [...discovered, { controller: planted, file: `${SOURCE_ROOT}/modules/platform/planted-unattached.controller.ts` }] });
    expect(
      problems.filter((p) => p.includes('PlantedUnattachedController')),
      'the law accepted a controller no composition registers',
    ).not.toEqual([]);
    expect(
      problems.some((p) => p.startsWith('P3: PlantedUnattachedController') && p.includes('exists only as a file')),
      problems.join('\n'),
    ).toBe(true);
    expect(
      problems.some((p) => p.startsWith('P2: PlantedUnattachedController') && p.includes('composed in no production process')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('P6 (law level): red — a planted wrong-process controller is refused', () => {
    // AdminController, the real class, moved into the merchant runtime. The
    // two lists still agree with each other; only the authoritative
    // composition disagrees, which is exactly the case the old containment
    // could not see.
    const merchant = COMPOSITIONS.find((c) => c.process === 'merchant-api') as Composition<Ctor>;
    const problems = run({
      compositions: COMPOSITIONS.map((c) =>
        c.process === 'merchant-api' ? { ...c, controllers: new Set<Ctor>([...merchant.controllers, AdminController as unknown as Ctor]) } : c,
      ),
    });
    expect(
      problems.some((p) => p.startsWith('P6: AdminController is registered in production process merchant-api')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('red: the law is not a permanent no — the real tree produces no violation at all', () => {
    // The other half of every red proof. A law that could only refuse would
    // make each case above meaningless.
    expect(run()).toEqual([]);
  });
});

describe('the two Nest compositions are distinguished, not conflated', () => {
  const of = (p: string): ReadonlySet<Ctor> => (COMPOSITIONS.find((c) => c.process === p) as Composition<Ctor>).controllers;

  it('TESTABILITY: every controller a production process serves, the test composition serves too', () => {
    const all = of('all');
    const missing: string[] = [];
    for (const c of COMPOSITIONS.filter((x) => x.kind === 'production'))
      for (const k of c.controllers) if (!all.has(k)) missing.push(`${label(k)} (${c.process})`);
    expect(missing.sort(), 'these routes would exist in production and in no integration test').toEqual([]);
  });

  it('DEAD-ROUTE: the test composition adds nothing no production process serves', () => {
    const productionUnion = new Set<Ctor>();
    for (const c of COMPOSITIONS.filter((x) => x.kind === 'production')) for (const k of c.controllers) productionUnion.add(k);
    expect(sortedNames([...of('all')].filter((k) => !productionUnion.has(k))), 'tests exercise a route no deployed runtime serves').toEqual([]);
  });

  it('the merchant runtime does not carry the platform surface, and the single process still adds exactly AdminController to it', () => {
    expect([...of('merchant-api')].map(label)).not.toContain(AdminController.name);
    expect(sortedNames([...of('all')].filter((k) => !of('merchant-api').has(k)))).toEqual([AdminController.name]);
  });

  it('the accounting write surface is composed in both, by identity', () => {
    const accounting = discovered.find((d) => label(d.controller) === 'AccountingController')?.controller;
    expect(accounting, 'AccountingController was not discovered at all').toBeDefined();
    expect(of('all').has(accounting as Ctor)).toBe(true);
    expect(of('merchant-api').has(accounting as Ctor)).toBe(true);
  });
});

function sortedNames(controllers: readonly Ctor[]): string[] {
  return controllers.map(label).sort();
}
