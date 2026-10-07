#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE GOLDEN SUITE, ASSERTED COMPLETE, AND THE
 * BROWSER MATRIX
 *
 * ── THE GOLDEN-COMPLETENESS CHECKER ──────────────────────────────────────
 *
 * `P4-AL-65` declares TWENTY goldens `G-01…G-20` in
 * `tests/golden-regression/phase4*`, each carrying a canonical `GOLD-nn` id
 * and each with a named, resolved RED proof (`P4-AL-67`); `gate:phase4:s8`
 * asserts the suite COMPLETE. "Complete" is the word that does the work, and
 * it is the word easiest to make vacuous: a completeness check that enumerates
 * the files on disk and reports "all present" has asserted that the files
 * present are present.
 *
 * So completeness is asserted against the DECLARED TWENTY, which are a
 * constant here, and the checker reports three populations separately:
 *
 *   DELIVERED  — a golden whose id is referenced by a real golden file
 *   WAITING    — a golden whose owning slice has not shipped
 *   MISSING    — a golden whose owning slice HAS shipped and whose id is
 *                referenced by no file. This is the only population that is a
 *                FAIL, and keeping it apart from WAITING is the whole point.
 *
 * ── THE ESTATE NO `tests/**` RUN AND NO SLICE GATE REACHES ───────────────
 *
 * `npm test` runs FIVE workspace unit trees — `packages/domain-core/test`,
 * `packages/accounting/test`, `packages/shared-contracts/test`,
 * `packages/inventory/test` and `apps/web/test` — through
 * `npm run test -w <workspace>`, under each workspace's OWN runner. The root
 * Vitest config's `include` is `tests/**\/*.test.ts`, so no `tests/**` run and
 * no slice gate roster reaches a single one of those files.
 *
 * And `npm test` is CI `backend` STEP 17, AHEAD of every database step. Its
 * failure therefore skips the integration tests, the goldens and every slice
 * gate below it — so a defect in a workspace unit tree is a defect that
 * prevents the evidence for everything else from existing at all, while
 * looking in the step list like one failed unit test.
 *
 * `[[daftar-a-check-only-asked-where-it-passes]]`. A golden-completeness
 * checker that did not know this estate existed would report a complete
 * golden suite over a tree whose goldens never ran. `unitTreeEstate` measures
 * it, `unitTreeReachProblems` asserts that the ordering is what this comment
 * says it is, and both run today.
 *
 * ── THE BROWSER MATRIX ───────────────────────────────────────────────────
 *
 * `P4-AL-68`: SIXTEEN `p4-`-prefixed steps × ar/en/tr × 360/768/1280 = 144
 * step-runs, plus four new invariant kinds each with its own planted defect.
 * Declared here, discovered from `tests/browser/flows.ts`, and the difference
 * reported.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTree } from './tree';

// ───────────────────────── GOLDENS ────────────────────────────────────────

export interface DeclaredGolden {
  /** `G-01` … `G-20`. */
  readonly id: string;
  /** The canonical `GOLD-nn` ids it carries. No third series (`P4-AL-65`). */
  readonly canonical: readonly string[];
  readonly proves: string;
  /** The slice that owns the invariant. A golden is WAITING until it ships. */
  readonly owner: string;
}

/** `P4-AL-65` §17.4, the twenty, with their canonical ids. */
export const DECLARED_GOLDENS: readonly DeclaredGolden[] = [
  {
    id: 'G-01',
    canonical: ['GOLD-19'],
    proves: 'last-item race: exactly one sale commits, stable translated refusal, no phantom movement, no partial journal',
    owner: 'P4-S2',
  },
  { id: 'G-02', canonical: ['GOLD-20'], proves: 'cross-tenant refusal at the API and again at SQL, enumerated from the route registry', owner: 'P4-S1' },
  { id: 'G-03', canonical: ['GOLD-30'], proves: 'cross-business FK manipulation refused BY THE DATABASE', owner: 'P4-S1' },
  { id: 'G-04', canonical: ['GOLD-26'], proves: 'payment currency != invoice currency, three snapshots, realized FX, 6100 unmoved', owner: 'P4-S4' },
  { id: 'G-05', canonical: ['GOLD-27', 'GOLD-42', 'GOLD-43'], proves: 'void a paid invoice: direct path refused, composite command atomic', owner: 'P4-S6' },
  { id: 'G-06', canonical: ['GOLD-28'], proves: 'return + refund without double reversal, line for line', owner: 'P4-S5' },
  { id: 'G-07', canonical: ['GOLD-48'], proves: 'invoice sequence isolation: two businesses of one tenant, no mixing, no gap, no duplicate', owner: 'P4-S1' },
  {
    id: 'G-08',
    canonical: ['GOLD-40', 'GOLD-50'],
    proves: 'refund caps: over-cap refused, exact cap leaves remaining = 0, cross-currency cap in the SOURCE currency',
    owner: 'P4-S5',
  },
  { id: 'G-09', canonical: ['GOLD-41', 'GOLD-53'], proves: 'concurrent refund on one source: one succeeds, the sum never exceeds the cap', owner: 'P4-S5' },
  {
    id: 'G-10',
    canonical: ['GOLD-65', 'GOLD-66', 'GOLD-67', 'GOLD-86'],
    proves: 'reverse an allocation by id: AR restored, revenue untouched, CASH DOES NOT MOVE',
    owner: 'P4-S6',
  },
  {
    id: 'G-11',
    canonical: ['GOLD-87'],
    proves: 'payment reversal: the cash original IS reversed, unlike G-10; idempotent by provider_reference AT THE DATABASE',
    owner: 'P4-S6',
  },
  { id: 'G-12', canonical: ['GOLD-85'], proves: 'a raw payment cannot be a refund source — unrepresentable, not rejected', owner: 'P4-S5' },
  {
    id: 'G-13',
    canonical: ['GOLD-09', 'GOLD-10'],
    proves: 'installment totals exact, due/late AS OF A SUPPLIED DATE, no figure from the machine clock',
    owner: 'P4-S7',
  },
  { id: 'G-14', canonical: ['GOLD-07'], proves: 'partial payment: paid + outstanding = total after every step, revenue posted once', owner: 'P4-S4' },
  {
    id: 'G-15',
    canonical: ['GOLD-68', 'GOLD-69', 'GOLD-70', 'GOLD-79', 'GOLD-80'],
    proves: 'overpayment becomes a credit, not revenue; both halves proportional on partial consumption, exactly zero on full',
    owner: 'P4-S4',
  },
  {
    id: 'G-16',
    canonical: ['GOLD-12', 'GOLD-62', 'GOLD-74'],
    proves: 'every replay refused AT THE DATABASE by a real UNIQUE over real columns',
    owner: 'P4-S2',
  },
  {
    id: 'G-17',
    canonical: ['GOLD-88'],
    proves: 'GL = source model: the R-SAL identities by the PRODUCT reconciler; no completed -> refunded transition exists',
    owner: 'P4-S8',
  },
  {
    id: 'G-18',
    canonical: ['GOLD-33'],
    proves: 'GL Inventory (1200) = the sum of stock_movements.value_delta_base_minor after purchase -> sale -> return -> void -> transfer -> adjustment',
    owner: 'P4-S8',
  },
  {
    id: 'G-19',
    canonical: ['GOLD-74'],
    proves: 'schema lint: every column named in every UNIQUE, CHECK and FK of every Phase 4 table exists; no polymorphic FK',
    owner: 'P4-S1',
  },
  { id: 'G-20', canonical: [], proves: 'the Phase 2 shape stand-ins still agree with the real commands, line for line', owner: 'P4-S8' },
];

/** The slices that have SHIPPED at the base SHA this framework was written at. */
export const SHIPPED_SLICES: readonly string[] = ['P4-S1', 'P4-S2', 'P4-S3', 'P4-S4'];

export interface GoldenCompleteness {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly referencedIds: readonly string[];
  readonly referencedCanonical: readonly string[];
  readonly delivered: readonly string[];
  readonly waiting: readonly { readonly id: string; readonly owner: string }[];
  readonly missing: readonly { readonly id: string; readonly owner: string }[];
}

export function goldenCompleteness(root: string, shipped: readonly string[] = SHIPPED_SLICES): GoldenCompleteness {
  const base = join(root, 'tests/golden-regression');
  const directories: string[] = [];
  if (existsSync(base))
    for (const entry of readdirSync(base).sort()) {
      const abs = join(base, entry);
      if (statSync(abs).isDirectory() && entry.startsWith('phase4')) directories.push(`tests/golden-regression/${entry}`);
    }
  const files: string[] = [];
  for (const dir of directories) for (const entry of readdirSync(join(root, dir)).sort()) if (entry.endsWith('.golden.test.ts')) files.push(`${dir}/${entry}`);

  const text = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  const referencedIds = [...new Set(text.match(/\bG-[0-9]{2}\b/g) ?? [])].sort();
  const referencedCanonical = [...new Set(text.match(/\bGOLD-[0-9]{2}\b/g) ?? [])].sort();

  const delivered: string[] = [];
  const waiting: { id: string; owner: string }[] = [];
  const missing: { id: string; owner: string }[] = [];
  for (const golden of DECLARED_GOLDENS) {
    if (referencedIds.includes(golden.id)) delivered.push(golden.id);
    else if (shipped.includes(golden.owner)) missing.push({ id: golden.id, owner: golden.owner });
    else waiting.push({ id: golden.id, owner: golden.owner });
  }
  return { directories, files, referencedIds, referencedCanonical, delivered, waiting, missing };
}

/**
 * The completeness verdict's PROBLEMS — the FAIL population only.
 *
 * A WAITING golden is not a problem; it is the honest state of a slice that
 * has not run. A MISSING golden is a problem, because its owner has shipped
 * and its invariant is therefore live and unproven.
 */
export function goldenCompletenessProblems(root: string, shipped: readonly string[] = SHIPPED_SLICES): string[] {
  const completeness = goldenCompleteness(root, shipped);
  const problems: string[] = [];
  if (completeness.files.length === 0) problems.push('no Phase 4 golden file was discovered at all — an empty golden estate is never a complete one');
  for (const m of completeness.missing) {
    // WHERE the invariant actually lives matters, and the two cases need
    // different words. A canonical id referenced only by an INTEGRATION suite
    // is an invariant that is TESTED and not GOLDEN — the assertion exists but
    // it is outside the estate `P4-AL-65` declares mandatory and outside what
    // `gate:phase4:s8` asserts complete. Reporting that as "unproven" would be
    // an over-claim; reporting it as complete would be the vacuous pass.
    const declared = DECLARED_GOLDENS.find((g) => g.id === m.id);
    const elsewhere = declared === undefined ? [] : canonicalIdsReferencedOutsideGoldens(root, declared.canonical);
    if (elsewhere.length > 0)
      problems.push(
        `${m.id} is owned by ${m.owner}, which has SHIPPED, and no file in tests/golden-regression/phase4* references it; ` +
          `its canonical ids (${declared?.canonical.join(', ') ?? ''}) are referenced by ${elsewhere.join(', ')} instead — ` +
          'the invariant is asserted somewhere, and NOT in the golden estate P4-AL-65 declares mandatory and this gate asserts complete',
      );
    else
      problems.push(
        `${m.id} is owned by ${m.owner}, which has SHIPPED, and neither its id nor its canonical ids appear anywhere under tests/ — the invariant is live and unproven`,
      );
  }
  // No third id series (`P4-AL-65`): every canonical id referenced must be one
  // the declared table claims.
  const claimed = new Set(DECLARED_GOLDENS.flatMap((g) => g.canonical));
  for (const canonical of completeness.referencedCanonical)
    if (!claimed.has(canonical))
      problems.push(`${canonical} is referenced by a Phase 4 golden and is claimed by no declared G-nn — a third id series is how two numbering schemes start`);
  // A `G-nn` outside the declared twenty.
  const declared = new Set(DECLARED_GOLDENS.map((g) => g.id));
  for (const id of completeness.referencedIds) if (!declared.has(id)) problems.push(`${id} is referenced and is not one of the declared twenty`);
  return problems;
}

/** Which suites outside the Phase 4 golden directories reference these canonical ids. */
export function canonicalIdsReferencedOutsideGoldens(root: string, canonical: readonly string[]): string[] {
  if (canonical.length === 0) return [];
  const facts = readTree(root);
  const pattern = new RegExp(`\\b(?:${canonical.map((c) => c.replace('-', '-')).join('|')})\\b`);
  const out: string[] = [];
  for (const suite of facts.suites) {
    if (suite.startsWith('tests/golden-regression/phase4')) continue;
    const path = join(root, suite);
    if (!existsSync(path)) continue;
    if (pattern.test(readFileSync(path, 'utf8'))) out.push(suite);
  }
  return out;
}

// ───────── THE ESTATE NO tests/** RUN AND NO SLICE GATE REACHES ───────────

export interface UnitTreeEstate {
  readonly trees: readonly { readonly path: string; readonly files: number }[];
  readonly totalFiles: number;
  /** The command that runs them, from the root `package.json`. */
  readonly command: string;
  /** Its 1-based position among the steps of the required `backend` job. */
  readonly backendStepIndex: number | null;
  /** The 1-based position of the first database step of that job. */
  readonly firstDatabaseStepIndex: number | null;
}

export const UNIT_TREE_PATHS: readonly string[] = [
  'packages/domain-core/test',
  'packages/accounting/test',
  'packages/shared-contracts/test',
  'packages/inventory/test',
  'apps/web/test',
];

export function unitTreeEstate(root: string): UnitTreeEstate {
  const facts = readTree(root);
  const trees = UNIT_TREE_PATHS.map((path) => ({ path, files: countTests(join(root, path)) }));
  const backendSteps = facts.workflowSteps.filter((s) => s.job === 'backend');
  const unitAt = backendSteps.findIndex((s) => s.run !== null && /^npm test$/.test(s.run.trim()));
  const dbAt = backendSteps.findIndex((s) => s.run !== null && /CREATE DATABASE daftar|bootstrap:db-roles/.test(s.run));
  return {
    trees,
    totalFiles: trees.reduce((n, t) => n + t.files, 0),
    command: facts.npmScripts.get('test') ?? '(no root `test` script)',
    backendStepIndex: unitAt === -1 ? null : unitAt + 1,
    firstDatabaseStepIndex: dbAt === -1 ? null : dbAt + 1,
  };
}

function countTests(abs: string): number {
  if (!existsSync(abs)) return 0;
  let n = 0;
  for (const entry of readdirSync(abs)) {
    const child = join(abs, entry);
    if (statSync(child).isDirectory()) n += countTests(child);
    else if (/\.test\.tsx?$/.test(entry)) n += 1;
  }
  return n;
}

/**
 * The two facts the golden-completeness checker must KNOW, asserted so they
 * cannot quietly stop being true.
 */
export function unitTreeReachProblems(root: string): string[] {
  const estate = unitTreeEstate(root);
  const problems: string[] = [];
  if (estate.totalFiles === 0)
    problems.push('the five workspace unit trees hold no test file — the estate this checker exists to know about has vanished, which is itself the finding');
  for (const tree of estate.trees)
    if (tree.files === 0) problems.push(`${tree.path} holds no test file, so the root \`npm test\` runs nothing for that workspace`);

  // The root runner does not reach them. Asserted, because if it ever did,
  // this whole paragraph of reasoning would be wrong.
  const facts = readTree(root);
  for (const suite of facts.suites)
    if (!suite.startsWith('tests/')) problems.push(`${suite} is in the root runner's reach and is not under tests/ — the include pattern has changed`);

  if (estate.backendStepIndex === null)
    problems.push('no step of the required `backend` job runs `npm test` — the five workspace unit trees are executed by nothing in required CI');
  else if (estate.firstDatabaseStepIndex === null)
    problems.push('no database step of the required `backend` job could be located, so the ordering claim cannot be verified');
  else if (estate.backendStepIndex > estate.firstDatabaseStepIndex)
    problems.push(
      `\`npm test\` is step ${estate.backendStepIndex.toString()} of \`backend\` and the first database step is ${estate.firstDatabaseStepIndex.toString()} — ` +
        'the recorded ordering (unit trees AHEAD of the database steps) has changed, so the consequence this checker documents no longer holds and the documentation is now wrong',
    );
  return problems;
}

// ───────────────────────── BROWSER MATRIX ─────────────────────────────────

export const LOCALES: readonly string[] = ['ar', 'en', 'tr'];
export const VIEWPORTS: readonly number[] = [360, 768, 1280];

/** `P4-AL-68`'s sixteen, every one `p4-` prefixed so none can collide with `flows.ts:275`'s `return`. */
export const DECLARED_P4_STEPS: readonly string[] = [
  'p4-pos',
  'p4-pos-credit',
  'p4-pos-keypad',
  'p4-customers',
  'p4-customer',
  'p4-statement',
  'p4-invoices',
  'p4-invoice',
  'p4-collect',
  'p4-return',
  'p4-refund',
  'p4-installments',
  'p4-installment-collect',
  'p4-debts',
  'p4-void',
  'p4-states',
];

/** The four new invariant kinds, each with its own planted defect (`P4-AL-68`). */
export const NEW_INVARIANT_KINDS: readonly { readonly kind: string; readonly asserts: string; readonly plant: string }[] = [
  {
    kind: 'money',
    asserts: 'every amount inside <bdi>, the currency minor-unit decimals exactly, no locale digit substitution inside a document number',
    plant: 'render one amount outside <bdi> and one document number with Arabic-Indic digits',
  },
  {
    kind: 'total-visible',
    asserts: 'at 360x640 with the keypad open, the cart total AND the primary action fully inside the viewport',
    plant: 'push the primary action 1px below the fold at 360x640 with the keypad open',
  },
  {
    kind: 'cap-shown',
    asserts: 'the refund screen renders the remaining cap, in the SOURCE currency, BEFORE the amount field',
    plant: 'move the cap below the amount field, and separately render it in the base currency',
  },
  {
    kind: 'sequence-verbatim',
    asserts: 'a document number rendered byte for byte as the server produced it',
    plant: 'pass the document number through the locale number formatter',
  },
];

export interface BrowserMatrix {
  /** The step names `tests/browser/flows.ts` actually registers. */
  readonly registeredSteps: readonly string[];
  readonly declaredP4Steps: readonly string[];
  readonly presentP4Steps: readonly string[];
  readonly absentP4Steps: readonly string[];
  /** Phase 3 step names, for the disjointness law of `P4-AL-63`. */
  readonly phase3Steps: readonly string[];
  /** `PHASE4_STEPS` as the tree exports it. */
  readonly exportedP4Steps: readonly string[];
  /**
   * Every registered step whose name begins `p4-`, whether or not the lock
   * names it. The difference between this and `declaredP4Steps` is a NAMING
   * DIVERGENCE and is reported as such: the lock's `P4-AL-68` list is the
   * contract, and a shipped step the contract does not name is a step no
   * document describes.
   */
  readonly registeredP4Steps: readonly string[];
  readonly registeredButUndeclared: readonly string[];
  readonly stepRuns: number;
}

export function browserMatrix(root: string): BrowserMatrix {
  const path = join(root, 'tests/browser/flows.ts');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const registered = [...new Set([...text.matchAll(/run\.step\(\s*'([^']+)'/g)].map((m) => m[1] ?? ''))].filter((s) => s !== '').sort();
  const phase3 = extractList(text, 'PHASE3_STEPS');
  const present = DECLARED_P4_STEPS.filter((s) => registered.includes(s));
  const registeredP4 = registered.filter((s) => s.startsWith('p4-'));
  return {
    registeredSteps: registered,
    declaredP4Steps: DECLARED_P4_STEPS,
    presentP4Steps: present,
    absentP4Steps: DECLARED_P4_STEPS.filter((s) => !registered.includes(s)),
    phase3Steps: phase3,
    exportedP4Steps: extractList(text, 'PHASE4_STEPS'),
    registeredP4Steps: registeredP4,
    registeredButUndeclared: registeredP4.filter((s) => !DECLARED_P4_STEPS.includes(s)),
    // The step-runs the matrix actually performs today: the REGISTERED p4-
    // steps, not the declared ones. 16 x 9 = 144 is the target; reporting the
    // target as the measurement is how a matrix comes to be believed complete.
    stepRuns: registeredP4.length * LOCALES.length * VIEWPORTS.length,
  };
}

function extractList(text: string, identifier: string): string[] {
  // Anchored at the EXPORT, not at the first occurrence of the name: the file
  // mentions both list names in its own header comment, and anchoring at the
  // first occurrence made the extractor read the comment and return nothing —
  // which then reported the two lists as trivially disjoint. A disjointness
  // law satisfied by an empty set is the vacuous pass P4-AL-63 exists against.
  const at = text.indexOf(`export const ${identifier}`);
  if (at === -1) return [];
  // The opening bracket of the VALUE, after the `=`. Searching for the first
  // `[` found the one in the TYPE ANNOTATION (`: readonly string[] =`) and
  // returned an empty list, which then satisfied the disjointness law
  // vacuously — the same failure mode in the checker as in the thing checked.
  const equals = text.indexOf('=', at);
  if (equals === -1) return [];
  const open = text.indexOf('[', equals);
  if (open === -1) return [];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return [...(text.slice(open + 1, i).match(/'([^']+)'/g) ?? [])].map((s) => s.slice(1, -1));
    }
  }
  return [];
}

/**
 * The matrix's own laws. These run today over the real `flows.ts`.
 *
 * The DISJOINTNESS law (`P4-AL-63`) is the one with a measured reason:
 * `flows.ts:275` already has `run.step('return', …)` — the SUPPLIER return,
 * one of the fifteen Phase 3 steps — and `tests/browser/gate.ts` filters
 * `--steps` as a plain name list with step records keyed by name, so a second
 * `return` would be run by `--steps=<PHASE3_STEPS>` and would reintroduce the
 * exact coupling `P4-AL-63` exists to remove.
 */
export function browserMatrixProblems(root: string): string[] {
  const matrix = browserMatrix(root);
  const problems: string[] = [];
  if (matrix.registeredSteps.length === 0) problems.push('tests/browser/flows.ts registers no step at all — an empty matrix is never a green matrix');
  for (const step of matrix.declaredP4Steps)
    if (!step.startsWith('p4-')) problems.push(`declared browser step ${step} is not p4- prefixed, so it can collide with a Phase 3 step name (P4-AL-68)`);
  if (matrix.phase3Steps.length === 0)
    problems.push('PHASE3_STEPS could not be read from tests/browser/flows.ts — a disjointness law over an empty set is a vacuous pass');
  if (matrix.exportedP4Steps.length === 0) problems.push('PHASE4_STEPS could not be read from tests/browser/flows.ts');
  for (const step of matrix.exportedP4Steps)
    if (matrix.phase3Steps.includes(step))
      problems.push(`${step} is in BOTH PHASE4_STEPS and PHASE3_STEPS — P4-AL-63 asserts the two exported lists are DISJOINT`);
  for (const step of matrix.registeredButUndeclared)
    problems.push(
      `the browser step ${step} is registered in flows.ts and is named by NONE of P4-AL-68's declared sixteen — ` +
        'a shipped step the contract does not name is a step no document describes, and the completeness claim "sixteen steps x nine combinations" cannot be read against the tree',
    );
  if (LOCALES.length !== 3 || VIEWPORTS.length !== 3)
    problems.push(
      'Phase 4 keeps exactly three locales and three viewports: adding either turns the accepted Phase 3 corrective gate red, because it asserts EQUALITY between its matrix and tests/browser/config.ts',
    );
  const kinds = new Set(NEW_INVARIANT_KINDS.map((k) => k.kind));
  if (kinds.size !== NEW_INVARIANT_KINDS.length) problems.push('two new invariant kinds share a name');
  for (const kind of NEW_INVARIANT_KINDS)
    if (kind.plant.trim() === '') problems.push(`invariant kind ${kind.kind} declares no planted defect, so it has never been proved able to fire`);
  return problems;
}
