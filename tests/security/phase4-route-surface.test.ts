/**
 * THE PHASE 4 ROUTE SURFACE IS EXACTLY WHAT THE PHASE 4 CONTROLLERS DECLARE
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-31, P4-AL-61, P4-AL-88).
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * `tests/security/settlement-s6-no-customer-payments.test.ts` is a permanent
 * PHASE 3 suite. Its §B4 re-expression correctly scoped the route assertions to
 * the supplier settlement surface, and in doing so it dropped the assertion the
 * suite is named for: *there is no customer payment route*. Dropping a
 * protection is not a re-expression, so the protection was restored — but it was
 * restored into that Phase 3 suite as a literal list requiring `/v1/payments`,
 * `/v1/refunds`, `/v1/customer-credits` and `/v1/credit-notes` to answer 404
 * FOREVER. That is `[[daftar-a-closure-rule-is-not-an-invariant]]` all over
 * again: P4-S4 and P4-S5 build those routes by design, so a permanent Phase 3
 * suite was once more holding a claim about the phase that follows it, and
 * `tests/security/phase4-forward-evolution.test.ts` was right to name it.
 *
 * The protection is MOVED here, not deleted, and re-expressed in a
 * TENSE-INDEPENDENT form. Nothing in this file is a list of what does or does
 * not exist today. There is exactly one claim:
 *
 *     The `/v1` surface a Phase 4 controller answers is exactly the surface the
 *     Phase 4 controllers DECLARE — no more and no less — and any path or verb
 *     outside it is 404.
 *
 * BOTH SIDES of that equality are derived from the same source: the Nest route
 * metadata of every `*.controller.ts` ANYWHERE under `apps/api/src/modules`
 * whose declared paths fall under `PHASE4_ROUTE_PREFIXES`. So mounting a route
 * updates both halves in the same commit, by construction, and there is no list
 * anywhere for a later slice to forget to edit.
 *
 * ── Why the subject is the TREE and not one directory ────────────────────
 *
 * This derivation used to read `apps/api/src/modules/selling` alone, and that
 * was a hand-written choice of directory doing the work a derivation was
 * supposed to do. It cost exactly what such a choice costs: P4-S3 built its
 * whole POS surface under `apps/api/src/modules/pos`, and this suite — the one
 * suite whose entire purpose is "the mounted surface equals the declared
 * surface" — could not see a single one of those nine routes. It would have
 * passed with the POS controllers mounted, unmounted, or mounted in one
 * composition only. That is the same defect as a hand-kept list of refusal
 * field names, which this project has already paid for once with a whole
 * family of dead error strings.
 *
 * So the directory is gone. A controller is this suite's subject when it
 * DECLARES A PHASE 4 ROUTE, discovered by walking the whole module tree and
 * filtering on `PHASE4_ROUTE_PREFIXES` — the estate's own canonical prefix
 * list, the same one `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts`)
 * filters by, imported rather than retyped. A later slice that puts customer
 * settlement routes in `modules/receivables` is covered by existing, with no
 * edit here. There is no POS path written anywhere in this file, and that is
 * the property that keeps the derivation from going stale silently: nothing
 * here can be true of a surface it is not looking at, because what it looks at
 * is "every Phase 4 route in the tree".
 *
 * Why that is the SAME protection §B5 carried:
 *
 *   - `/v1/payments` is refused because it is OUTSIDE THE DERIVED SURFACE, not
 *     because a literal names it. Today the declared surface is nine read
 *     routes, so every customer settlement path is outside it and must 404 on
 *     every verb — which is precisely what §B5 asserted.
 *   - A write verb on a read route is refused for the same reason: `POST
 *     /v1/invoices` is not declared, so it must 404.
 *   - A route smuggled in without a declaration — a wildcard, a stray
 *     middleware, a controller mounted in one composition only — is caught,
 *     which §B5's literal list could not catch at all.
 *
 * Why it survives P4-S4:
 *
 *   When P4-S4 mounts `POST /v1/payments`, that route becomes DECLARED. The
 *   probe half stops requiring it to 404 in the same commit that makes it
 *   answer, because the probe half asks the declaration, not a literal. Nothing
 *   here needs editing, and nothing here goes red for the success of a later
 *   slice. Equally, if P4-S4 mounts the controller in only ONE of the two
 *   compositions, or declares a route no composition registers, this suite
 *   fails — which is the protection getting STRONGER as the surface grows.
 *
 * The one claim that genuinely belongs to P4-S1 alone — *the declared surface
 * contains no write verb at all* — is NOT here. A permanent suite may not hold
 * it, because P4-S4 makes it false by design. It lives in the
 * `CANDIDATE-TENSE (P4-AL-61)` fence of `scripts/phase4-s1-gate.ts`, the one
 * place in the estate allowed to carry a claim the acceptance commit deletes.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { PHASE4_ROUTE_PREFIXES } from '../../scripts/phase4-s1-gate';
import { P4_S3_REQUIRED_CONTROLLERS } from '../../apps/api/src/modules/pos/pos-permissions';

/** The whole module tree. A controller is a Phase 4 controller by what it DECLARES, never by where it lives. */
const MODULES_DIR = join(__dirname, '../../apps/api/src/modules');

/** The POS module directory — named once, for the `P4_S3_REQUIRED_CONTROLLERS` cross-check, and never for a route path. */
const POS_DIR = join(MODULES_DIR, 'pos');

/** The two compositions. A controller registered in only one of them is a route no integration test can reach. */
const COMPOSITIONS: readonly string[] = ['apps/api/src/app/app.module.ts', 'apps/api/src/app/merchant-api.module.ts'];

/** Whether a declared path is on the Phase 4 surface, by the estate's own prefix list. */
const isPhase4Path = (path: string): boolean => PHASE4_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

/** Every HTTP verb a route could be mounted on, so "no more" is asserted over all of them. */
const ALL_VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Verb = (typeof ALL_VERBS)[number];

/** Nest's `RequestMethod` enum member -> the supertest verb. `ALL` is deliberately absent: see `declaredRoutes`. */
const VERB_OF: Readonly<Record<number, Verb>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

interface DeclaredRoute {
  readonly controller: string;
  readonly verb: Verb;
  /** The mounted path, Nest-normalised: a single leading slash, no trailing slash. */
  readonly path: string;
  /** The same path with every `:param` segment left in place, for reporting. */
  readonly template: string;
}

const normalise = (p: string): string =>
  `/${p
    .split('/')
    .filter((s) => s !== '')
    .join('/')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControllerClass = new (...args: any[]) => unknown;

/** Every `*.controller.ts` anywhere under `apps/api/src/modules`, with the directory it lives in. */
function controllerFiles(dir: string): { readonly dir: string; readonly file: string }[] {
  const found: { dir: string; file: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) found.push({ dir, file: full });
  }
  return found;
}

/** One discovered controller class, with every route it declares and where its file sits. */
interface DiscoveredController {
  readonly name: string;
  readonly cls: ControllerClass;
  readonly dir: string;
  readonly routes: readonly DeclaredRoute[];
}

/** Every route one controller class declares, read from the Nest metadata its decorators wrote. */
function routesOf(name: string, cls: ControllerClass): DeclaredRoute[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
  const proto = (cls as unknown as { prototype: object }).prototype;
  const routes: DeclaredRoute[] = [];
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const handler = (proto as Record<string, unknown>)[key];
    if (typeof handler !== 'function') continue;
    const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (methodPath === undefined || method === undefined) continue;
    const verb = VERB_OF[method];
    // `@All()` would make the surface unenumerable, which is itself a finding.
    expect(verb, `${name}.${key} is mounted on a verb this suite cannot enumerate (RequestMethod ${method})`).toBeDefined();
    const template = normalise(`${base}/${methodPath}`);
    routes.push({ controller: name, verb: verb as Verb, path: template, template });
  }
  return routes;
}

/**
 * EVERY PHASE 4 CONTROLLER IN THE TREE, discovered rather than listed.
 *
 * The walk covers all of `apps/api/src/modules`; the filter is "declares at
 * least one path under `PHASE4_ROUTE_PREFIXES`". So `modules/selling` and
 * `modules/pos` are both in the subject today, by derivation, and a Phase 4
 * route a later slice mounts from a third directory joins it by existing.
 *
 * A controller that declares a mix of Phase 4 and non-Phase-4 paths would make
 * the "no more" half of the equality unstateable — the probe loop would demand
 * 404 on verbs of a path this suite has no business judging — so a mixed
 * controller is reported as a finding rather than silently split. None exists
 * today, and the assertion is what notices if one appears.
 */
async function phase4Controllers(): Promise<DiscoveredController[]> {
  const found: DiscoveredController[] = [];
  for (const { dir, file } of controllerFiles(MODULES_DIR)) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      const routes = routesOf(name, value as ControllerClass);
      const phase4 = routes.filter((r) => isPhase4Path(r.path));
      if (phase4.length === 0) continue;
      expect(
        routes.length,
        `${name} declares both Phase 4 and non-Phase-4 paths (${routes
          .filter((r) => !isPhase4Path(r.path))
          .map((r) => r.path)
          .join(', ')}) — this suite's "no more" half cannot speak for the second kind`,
      ).toBe(phase4.length);
      found.push({ name, cls: value as ControllerClass, dir, routes: phase4 });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The DECLARED half: every route the Phase 4 controllers mount, read from the
 * Nest metadata the decorators wrote. This is the same metadata Nest itself
 * routes on, so it cannot drift from what the process serves.
 */
async function declaredRoutes(): Promise<DeclaredRoute[]> {
  const routes = (await phase4Controllers()).flatMap((c) => [...c.routes]);
  return routes.sort((a, b) => `${a.path} ${a.verb}`.localeCompare(`${b.path} ${b.verb}`));
}

/** A concrete, requestable path: every `:param` segment replaced by a real UUID. */
const concrete = (template: string, id: string): string =>
  template
    .split('/')
    .map((s) => (s.startsWith(':') ? id : s))
    .join('/');

/**
 * The PROBE half: the Phase 4 route prefixes the ESTATE declares, imported from
 * `scripts/phase4-s1-gate.ts` rather than written out here.
 *
 * These are not a claim that the paths do not exist. They are the places a
 * Phase 4 route would appear, and each is required to 404 only WHILE IT IS
 * OUTSIDE THE DECLARED SURFACE. The moment a controller declares one, it leaves
 * this set by derivation.
 *
 * Imported, not listed, for two reasons. It is the estate's own canonical list,
 * so the probe set grows when the lock's route surface grows — no literal here
 * to forget to update. And a literal `/v1/payments` next to a 404 expectation
 * is itself the shape `tests/security/phase4-forward-evolution.test.ts` refuses,
 * correctly: read as text, a file that names a Phase 4 route and demands 404 is
 * indistinguishable from the §B5 block this suite replaced. Deriving the set
 * removes the shape along with the claim.
 */
const PROBE_BASES: readonly string[] = PHASE4_ROUTE_PREFIXES;

/** The nested positions: a customer's settlement is not reachable through the customer either. */
const NESTED_UNDER_CUSTOMER: readonly string[] = ['payments', 'refunds', 'credits', 'credit-notes', 'installments', 'statements'];

let t: TestApp;
let owner: HttpActor;
let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'P4 route surface owner');
  A = await onboardS3Business(t, owner, 'p4route');
}, 180_000);

afterAll(async () => {
  await t.close();
  await resetData();
});

describe('P4-AL-88: the declared Phase 4 surface is discovered, not listed', () => {
  it('the Phase 4 controllers declare a non-empty surface, and every declaration is enumerable', async () => {
    const routes = await declaredRoutes();
    // The canary. An empty surface would make every assertion below vacuous,
    // so a tree that stops declaring Phase 4 routes is a finding and not a pass.
    expect(routes.length, 'no Phase 4 route is declared — every probe below would pass vacuously').toBeGreaterThan(0);
    const controllers = (await phase4Controllers()).map((c) => c.name);
    expect(controllers.length, 'no Phase 4 controller was discovered in the module tree').toBeGreaterThan(0);
    // Every declared path is under `/v1`: a Phase 4 route mounted anywhere else
    // would escape the probe half entirely.
    for (const r of routes) expect(r.path, `${r.controller} declares ${r.verb.toUpperCase()} ${r.path} outside /v1`).toMatch(/^\/v1(\/|$)/);
  });

  /**
   * The surface is drawn from MORE THAN ONE module directory, asserted so the
   * widening of this suite's subject cannot silently narrow back.
   *
   * This case is the one that would have caught the defect it was written for:
   * while the derivation read `modules/selling` alone, the whole POS surface
   * was invisible here, and every assertion in this file passed without ever
   * looking at it. The claim is deliberately STRUCTURAL and names no path — it
   * says the subject spans at least two module directories, and that the
   * Phase 4 prefixes the tree actually declares span more than one prefix.
   * Narrowing the walk back to one directory makes it red.
   */
  it('the discovered surface spans more than one module directory — the walk is the tree, not a directory', async () => {
    const controllers = await phase4Controllers();
    const dirs = new Set(controllers.map((c) => c.dir));
    expect(
      dirs.size,
      `every Phase 4 controller was found in one directory (${[...dirs].join(', ')}) — either the estate really has one, or this walk narrowed back to one`,
    ).toBeGreaterThan(1);
    const prefixes = new Set((await declaredRoutes()).map((r) => PHASE4_ROUTE_PREFIXES.find((p) => r.path === p || r.path.startsWith(`${p}/`))));
    expect(prefixes.size, 'the declared surface covers one Phase 4 prefix only — a whole slice may be invisible to this derivation').toBeGreaterThan(1);
  });

  it('both Nest compositions register every discovered Phase 4 controller', async () => {
    // DAFTAR composes Nest twice (`selling.module.ts:19-22`, `pos.module.ts`),
    // and a controller in one composition only is a route no integration test
    // can reach. Both compositions are `@Module({})` classes that build a
    // `DynamicModule` in `register(options)`, so the controller list is not in
    // class metadata and is read from the composition SOURCE instead.
    //
    // `tests/integration/process-composition.test.ts` already holds the two
    // lists to EACH OTHER. What it cannot notice is a Phase 4 controller that
    // is in neither, which is what this adds — derived from the tree, so a
    // controller added later is covered by existing.
    const discovered = (await phase4Controllers()).map((c) => c.name);
    expect(discovered.length, 'no Phase 4 controller was discovered in the module tree').toBeGreaterThan(0);
    for (const file of COMPOSITIONS) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      const missing = discovered.filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
      expect(missing, `${file} does not register these Phase 4 controllers`).toEqual([]);
    }
  });

  /**
   * `P4_S3_REQUIRED_CONTROLLERS` IS CHECKED FROM BOTH SIDES.
   *
   * `pos-permissions.ts` states the controllers P4-S3 owes the compositions.
   * For most of the slice's life nothing read that constant and it named a
   * class that did not exist — a list describing itself, which is no evidence
   * at all. Two claims make it evidence:
   *
   *   1. it is EQUAL to the Phase 4 controllers discovered by reading
   *      `apps/api/src/modules/pos`. A controller built and not listed is red;
   *      a name listed and not built is red. Neither direction can be settled
   *      by editing only the list, because the other direction then fails.
   *   2. every name appears in BOTH composition sources.
   *
   * The routes themselves are proved by the HTTP cases below, which drive them
   * through the production composition. That is what finally makes the mount a
   * fact rather than a claim: the list names the obligation, and a request is
   * what settles whether it was met.
   */
  it('P4_S3_REQUIRED_CONTROLLERS is exactly what modules/pos builds, and both compositions register all of it', async () => {
    const built = (await phase4Controllers())
      .filter((c) => c.dir === POS_DIR)
      .map((c) => c.name)
      .sort();
    expect(built.length, 'modules/pos declares no Phase 4 controller — the whole POS surface would be unmounted').toBeGreaterThan(0);
    expect([...P4_S3_REQUIRED_CONTROLLERS].sort(), 'the stated POS controllers and the built ones disagree').toEqual(built);
    for (const file of COMPOSITIONS) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      const missing = P4_S3_REQUIRED_CONTROLLERS.filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
      expect(missing, `${file} does not register these P4-S3 controllers`).toEqual([]);
    }
  });
});

describe('P4-AL-88: the mounted surface equals the declared surface', () => {
  it('every declared route is reached on its declared verb', async () => {
    const headers = asMember(owner, A.businessId);
    const id = randomUUID();
    for (const r of await declaredRoutes()) {
      const res = await t.request[r.verb](concrete(r.path, id)).set(headers).send({});
      /**
       * Reached, not necessarily successful. The old form of this claim was
       * `not.toBe(404)`, which its own comment already contradicted: a
       * well-formed request for an absent row IS a 404, from the handler. It
       * passed only while no Phase 4 relation existed and an item route could
       * not answer cleanly — `0075` gave `GET /v1/customers/:customerId` a
       * table to miss in, and a correct handler 404 broke the assertion. A
       * status that a correct implementation returns is not a discriminator.
       *
       * What discriminates is WHO answered, and the two are not told apart by
       * the status or by `error.code`: `common/error.filter.ts:68-80` maps
       * Nest's own router `NotFoundException` to the same
       * `{ error: { code: 'NOT_FOUND', message: 'Resource not found' } }` body
       * a handler's refusal gets. The one thing only a handler produces is
       * `error.details.sellingCode` — `selling-errors.ts:108-113` puts the
       * stable code there on every refusal of this surface, so an unmounted
       * route cannot forge it.
       *
       * The claim is therefore what it always meant, and one notch stronger:
       * a declared route answers, and when it answers 404 it answers with this
       * surface's own stable code rather than the router's anonymous one.
       */
      if (res.status !== 404) continue;
      const details = ((res.body as { error?: { details?: Record<string, unknown> } } | undefined)?.error?.details ?? {}) as {
        sellingCode?: unknown;
      };
      expect(
        typeof details.sellingCode === 'string' ? details.sellingCode : null,
        `${r.verb.toUpperCase()} ${r.template} (${r.controller}) answered 404 with no sellingCode — that is Nest's router answering, not a handler`,
      ).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  }, 120_000);

  it('no verb outside the declared surface is mounted on a declared path', async () => {
    // The read-only property of P4-S1, in the ONE form that survives P4-S4:
    // the undeclared verbs are refused. When a later slice declares
    // `POST /v1/invoices`, that verb leaves this set in the same commit that
    // mounts it, because both halves read the same declaration.
    const headers = asMember(owner, A.businessId);
    const id = randomUUID();
    const routes = await declaredRoutes();
    const declared = new Set(routes.map((r) => `${r.verb} ${r.path}`));
    const offenders: string[] = [];
    for (const r of routes) {
      for (const verb of ALL_VERBS) {
        if (declared.has(`${verb} ${r.path}`)) continue;
        const res = await t.request[verb](concrete(r.path, id)).set(headers).send({});
        if (res.status !== 404) offenders.push(`${verb.toUpperCase()} ${r.template} answered ${res.status} but no controller declares it`);
      }
    }
    expect(offenders).toEqual([]);
  }, 180_000);
});

describe('P4-AL-88: a path outside the declared surface is 404 on every verb', () => {
  it('every customer settlement path outside the declared surface is 404 on every verb', async () => {
    const headers = asMember(owner, A.businessId);
    const id = randomUUID();
    const routes = await declaredRoutes();
    /** A probe is skipped exactly when a controller declares it — never by a literal. */
    const isDeclared = (path: string, verb: Verb): boolean => routes.some((r) => r.verb === verb && (r.path === path || concrete(r.path, id) === path));

    const probes: string[] = [...PROBE_BASES.flatMap((base) => [base, `${base}/${id}`]), ...NESTED_UNDER_CUSTOMER.map((leaf) => `/v1/customers/${id}/${leaf}`)];
    // The canary: if the declared surface ever swallowed every probe, this
    // assertion would pass by testing nothing. At least one probe must be
    // genuinely outside the surface for the check to mean anything.
    const outside = probes.filter((p) => !ALL_VERBS.every((v) => isDeclared(p, v)));
    expect(outside.length, 'every settlement probe is now declared — this check has no subject left').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of probes) {
      for (const verb of ALL_VERBS) {
        if (isDeclared(path, verb)) continue; // a later slice mounted it: that is its business, not this suite's
        const res = await t.request[verb](path).set(headers).send({});
        if (res.status !== 404) offenders.push(`${verb.toUpperCase()} ${path} answered ${res.status} but is outside the declared Phase 4 surface`);
      }
    }
    expect(offenders).toEqual([]);
  }, 300_000);

  it('red proof: the probe half is driven by the declaration, and refuses a path the declaration does not cover', async () => {
    const routes = await declaredRoutes();
    const declaredPaths = new Set(routes.map((r) => r.path));

    // A settlement prefix that the controllers do not declare today. Chosen
    // from the estate's list rather than named, so this proof carries no
    // literal Phase 4 route either.
    const undeclared = PROBE_BASES.filter((base) => !declaredPaths.has(base));
    expect(undeclared.length, 'every Phase 4 prefix is declared — the probe half has no subject left').toBeGreaterThan(0);
    const subject = undeclared[0] as string;

    // (1) The mechanism is genuinely derivation, not a literal: a SYNTHETIC
    // declaration of that path moves it INSIDE the surface, so the probe half
    // stops covering it without this file being edited. That is exactly what
    // P4-S4 will do to the customer settlement routes, proved here rather than
    // promised.
    const synthetic = [...routes, { controller: 'SyntheticController', verb: 'post' as Verb, path: subject, template: subject }];
    const syntheticDeclares = (path: string, verb: Verb): boolean => synthetic.some((r) => r.verb === verb && r.path === path);
    expect(syntheticDeclares(subject, 'post')).toBe(true);
    // ... while every other verb on it, and every other probe, is still outside.
    expect(syntheticDeclares(subject, 'delete')).toBe(false);
    for (const other of undeclared.slice(1)) expect(syntheticDeclares(other, 'post'), other).toBe(false);

    // (2) And the real, unsynthesised surface still leaves that path outside,
    // which is why the 404 assertion above has force today.
    expect(declaredPaths.has(subject)).toBe(false);
  });
});
