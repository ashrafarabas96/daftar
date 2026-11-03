/**
 * GUARD — THE BIDIRECTIONAL PROCESS-COMPOSITION LAW (TL-P4-S3-R5).
 *
 * ── What was wrong with the one-directional check ────────────────────────
 *
 * `tests/integration/process-composition.test.ts` used to hold exactly one
 * containment: everything `MerchantApiModule` composes, `AppModule` composes
 * too. That is a real law and it stays. What it cannot see is a controller
 * that belongs to NO composition at all — a `*.controller.ts` with a real
 * `@Controller()` on it, imported by nothing, serving nowhere. Containment of
 * one reflected list in another says nothing about the files on disk, so an
 * unattached controller passed, and a controller mounted in the WRONG process
 * passed too as long as both lists happened to agree.
 *
 * ── The recurring defect this module is written against ──────────────────
 *
 * `[[daftar-a-shape-is-not-a-fact]]`. This repository has twice shipped a
 * check whose SHAPE stood in for the FACT it claimed:
 *
 *   — a composition check whose regex matched an `import { XController }`
 *     line and called that "registered". An import is a module-resolution
 *     fact; a registration is a Nest composition fact; the first does not
 *     imply the second, and `merchant-api.module.ts` imports symbols it does
 *     not list to this day.
 *   — a planted-root proof that copied a whole directory before planting, so
 *     the plant landed in the copy and the check under proof never saw it.
 *
 * So this module takes NO source text. Composition reaches it already
 * REFLECTED — the caller calls `Module.register(...)` and reads the
 * `controllers` array off the returned `DynamicModule`, which is the same
 * array Nest's injector walks — and controllers reach it as the opaque tokens
 * those arrays hold. The law compares by IDENTITY (`Set.has` on the
 * constructor), never by name and never by text. `label()` exists only to
 * write a diagnostic a human can act on; no branch of this file is decided by
 * what `label()` returns about membership.
 *
 * Source scanning has exactly one job on the caller's side: to ENUMERATE
 * CANDIDATE FILES. Whether a candidate is a controller is then settled by
 * Nest's own `PATH_METADATA`, read off the imported class. A file that merely
 * mentions or imports a controller is shortlisted and contributes nothing,
 * which is the point — see `P4` below and the two cases in the suite that
 * prove it on the real `app.module.ts`.
 *
 * ── DAFTAR COMPOSES NEST TWICE, AND THE LAW MUST NOT CONFLATE THEM ───────
 *
 * `PROCESS_MODE=all` (`AppModule`) is the DEV AND TEST composition; production
 * config validation refuses that mode outright (Directive §19). The deployed
 * runtimes are `merchant-api`, `platform-api`, `worker` and `reconciler`. A
 * controller mounted only in `AppModule` is a route production never serves; a
 * controller mounted only in a production module is a route NO integration
 * test can reach, which is how the three accounting routes of P2-S4 went
 * unexercised. Those are two different findings with two different fixes, so
 * `kind` separates them and `TESTABILITY` / `DEAD-ROUTE` name them apart.
 * "Mounted" alone is never asserted.
 */

/** One composed Nest process, as reflected off the `DynamicModule` its module factory returned. */
export interface Composition<T> {
  /** The `PROCESS_MODE` this composition is: `merchant-api`, `all`, … */
  readonly process: string;
  /**
   * `production` — a runtime that is actually deployed.
   * `test-composition` — `PROCESS_MODE=all`, which production refuses (§19).
   */
  readonly kind: 'production' | 'test-composition';
  /** The module file the composition was reflected from. Diagnostics only. */
  readonly source: string;
  /** The reflected `controllers` array, as an identity set of constructors. */
  readonly controllers: ReadonlySet<T>;
}

/** One controller class found in the production source tree and confirmed by Nest's own metadata. */
export interface Discovered<T> {
  readonly controller: T;
  /** The repo-relative file the class was imported from. */
  readonly file: string;
}

export interface CompositionLawInput<T> {
  readonly compositions: readonly Composition<T>[];
  readonly discovered: readonly Discovered<T>[];
  /**
   * THE AUTHORITATIVE PROCESS COMPOSITION: controller label → the PRODUCTION
   * processes that controller belongs to. This is the declaration the law
   * holds the tree to; it is not derived from the tree, or the tree would be
   * holding itself to itself.
   */
  readonly intended: Readonly<Record<string, readonly string[]>>;
  /** Diagnostics only — never consulted to decide membership. */
  readonly label: (controller: T) => string;
  /** The one `kind: 'test-composition'` process, by name. */
  readonly testComposition: string;
  /** The repo-relative directory discovery is allowed to have walked. */
  readonly sourceRoot: string;
}

/** A path shape that must never be the origin of a controller this law counts. */
const NON_PRODUCTION_FILE = /(?:^|\/)(?:tests?|__tests__|__fixtures__|fixtures|mocks?)\/|\.(?:test|spec|mock|fixture|stub)\.[cm]?tsx?$/;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/**
 * The whole law. Returns one line per violation; an empty array is the only
 * pass. Every line is prefixed with the property of TL-P4-S3-R5 it enforces,
 * so a red proof can assert WHICH law refused rather than merely that
 * something did.
 */
export function compositionProblems<T>(input: CompositionLawInput<T>): string[] {
  const { compositions, discovered, intended, label, testComposition, sourceRoot } = input;
  const problems: string[] = [];

  const production = compositions.filter((c) => c.kind === 'production');
  const test = compositions.filter((c) => c.kind === 'test-composition');

  // ── Preconditions. A law handed nothing must say so, not pass. ──────────
  if (production.length === 0) problems.push('P0: no production composition was reflected — the law would then be vacuous');
  if (test.length !== 1 || test[0]?.process !== testComposition)
    problems.push(
      `P0: expected exactly one test composition named ${testComposition} and got [${sorted(test.map((c) => c.process)).join(', ') || 'none'}] — the law cannot tell "mounted in production" from "mounted in the test composition" without it`,
    );
  if (discovered.length === 0) problems.push('P0: source discovery enumerated no controller at all — an empty candidate set makes P2 and P3 unfalsifiable');
  const processNames = new Set(compositions.map((c) => c.process));
  if (processNames.size !== compositions.length) problems.push('P0: two compositions share a process name');

  // ── P4 — NO TEST FIXTURE MAY SATISFY THE CHECK ──────────────────────────
  // Discovery may only have walked the production source root, and no file it
  // counted may look like a test, a fixture or a mock. A controller the law
  // counts because a fixture defines one is the same defect class as a regex
  // that counts an import line.
  for (const d of discovered) {
    if (!d.file.startsWith(`${sourceRoot}/`))
      problems.push(
        `P4: ${label(d.controller)} was discovered in ${d.file}, outside the production source root ${sourceRoot}/ — only production source may satisfy this law`,
      );
    else if (NON_PRODUCTION_FILE.test(d.file))
      problems.push(
        `P4: ${label(d.controller)} was discovered in ${d.file}, which is a test, fixture or mock path — a fixture controller may not satisfy this law`,
      );
  }

  // Identity index: label → the discovered classes carrying it. Built once so
  // P1 can resolve a DECLARED NAME to a REAL CLASS and then go back to
  // identity for every membership question.
  const byLabel = new Map<string, T[]>();
  for (const d of discovered) {
    const list = byLabel.get(label(d.controller)) ?? [];
    list.push(d.controller);
    byLabel.set(label(d.controller), list);
  }
  const fileOf = new Map<T, string>(discovered.map((d) => [d.controller, d.file]));

  // ── P1 — EVERY DECLARED CONTROLLER APPEARS WHERE EXPECTED ───────────────
  // ── P6 — AND NOWHERE ELSE (the wrong-process half) ──────────────────────
  for (const [name, processes] of Object.entries(intended).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const matches = byLabel.get(name) ?? [];
    if (matches.length === 0) {
      problems.push(`P1: ${name} is declared in the authoritative process composition and no controller class of that name exists under ${sourceRoot}/`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(
        `P1: ${name} resolves to ${matches.length} distinct classes (${sorted(matches.map((m) => fileOf.get(m) ?? '?')).join(', ')}) — the declaration cannot name one of them`,
      );
      continue;
    }
    const controller = matches[0] as T;
    const expected = new Set(processes);
    for (const process of sorted(expected)) {
      const composition = compositions.find((c) => c.process === process);
      if (composition === undefined) {
        problems.push(`P1: ${name} is declared for process ${process} and no composition of that name was reflected`);
        continue;
      }
      if (!composition.controllers.has(controller))
        problems.push(
          `P1: ${name} is declared for process ${process} and the reflected composition of ${process} (${composition.source}) does not register it — a declaration is not a registration`,
        );
    }
    for (const composition of production) {
      if (expected.has(composition.process)) continue;
      if (composition.controllers.has(controller))
        problems.push(
          `P6: ${name} is registered in production process ${composition.process} (${composition.source}) and the authoritative process composition places it only in [${sorted(expected).join(', ') || 'no production process'}]`,
        );
    }
  }

  // ── P2 — EVERY PRODUCTION CONTROLLER IS REACHABLE THROUGH AN INTENDED ───
  // ──      PRODUCTION PROCESS, and P3 — NONE EXISTS ONLY AS A FILE ────────
  for (const d of sortedDiscovered(discovered, label)) {
    const name = label(d.controller);
    const mountedIn = production.filter((c) => c.controllers.has(d.controller)).map((c) => c.process);
    const mountedAnywhere = compositions.some((c) => c.controllers.has(d.controller));
    if (!mountedAnywhere)
      problems.push(
        `P3: ${name} (${d.file}) exists only as a file — no reflected process composition, production or test, registers it. A controller nothing composes serves no route anywhere.`,
      );
    if (mountedIn.length === 0)
      problems.push(
        `P2: ${name} (${d.file}) is composed in no production process — it is reachable in no deployed runtime (${production
          .map((c) => c.process)
          .sort()
          .join(', ')})`,
      );
    if (!(name in intended))
      problems.push(
        `P2: ${name} (${d.file}) is a real @Controller the authoritative process composition does not mention at all — it belongs to no intended production module`,
      );
  }

  // ── THE TWO HALVES OF THE DOUBLE COMPOSITION ────────────────────────────
  const testComp = test[0];
  if (testComp !== undefined) {
    for (const composition of production)
      for (const controller of composition.controllers)
        if (!testComp.controllers.has(controller))
          problems.push(
            `TESTABILITY: ${label(controller)} is composed in production process ${composition.process} (${composition.source}) and NOT in the test composition ${testComp.process} (${testComp.source}) — its routes exist in production and no integration test can reach them`,
          );
    for (const controller of testComp.controllers)
      if (!production.some((c) => c.controllers.has(controller)))
        problems.push(
          `DEAD-ROUTE: ${label(controller)} is composed in the test composition ${testComp.process} (${testComp.source}) and in no production process — tests exercise a route no deployed runtime serves`,
        );
  }

  return [...new Set(problems)];
}

function sortedDiscovered<T>(discovered: readonly Discovered<T>[], label: (c: T) => string): readonly Discovered<T>[] {
  return [...discovered].sort((a, b) => (label(a.controller) < label(b.controller) ? -1 : 1));
}
