#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE CHECK REGISTRY
 *
 * Every S8 check, with its SUBJECTS. The registry is the thing that makes the
 * no-fake-PASS law operational: a check cannot be added without naming what it
 * is about, and `evaluateCheck` refuses to evaluate it while any of those
 * subjects is absent.
 *
 * This is NOT `gate:phase4:s8`. The integrated gate — the one that composes
 * `gate:phase4:s7`, executes the rosters, runs the browser matrix and the
 * Tier-1 budgets, and is wired as a visible step of the required `backend`
 * job — comes only after S5, S6 and S7 seal, because a gate wired while red by
 * design cannot show a real regression appearing. The wiring is a PATCH
 * REQUEST (`docs/patch-requests/PATCH-REQ-S8-004.md`), not an edit, because
 * `.github/workflows/ci.yml` is the evidence surface for a slice in acceptance
 * and `scripts/phase4-s*-gate.ts` has one owner per slice.
 */
import { buildMatrix, matrixProblems, staleHeadProblems } from './deadlock-matrix';
import {
  browserMatrixProblems,
  browserMatrix,
  goldenCompleteness,
  goldenCompletenessProblems,
  unitTreeEstate,
  unitTreeReachProblems,
} from './golden-and-browser';
import { discoverIdempotencyKeys, discoverPermissions, discoverSources, idempotencyFindings, permissionFindings, sourceFindings } from './inventories';
import { acquisitionOrderProblems, forbiddenRemedyProblems, sequenceLastProblems, unwalkedHelpers } from './lock-order';
import { budgetPlanProblems, BUDGETS, mutationProblems, orchestrate } from './performance-orchestrator';
import { allPlants, frameworkSelfProblems, SALES_RECONCILIATION_CHECKS } from './reconciliation-framework';
import { expectedPolicyCounts, staticEstateProblems } from './rls-estate';
import { isolationProblems, lifecycleProblems, LIFECYCLE, ISOLATION_PATH } from './scenarios';
import { readTree, routineBody } from './tree';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arrayLiteralStrings, probeSubject } from './tree';
import { type CheckOutcome, type FrameworkCheck, evaluateCheck, runVerdict, tally } from './verdict';

export { probeSubject };

const PROOFS = 'tests/guards/p4s89-framework-laws.test.ts';
const WAITING_PROOF = 'tests/guards/p4s89-waiting-status-law.test.ts';
const DB_PROOF = 'tests/guards/p4s8-red-proofs.test.ts';

/**
 * A subject that is ALWAYS real: this framework's own source.
 *
 * A check about the framework rather than about the product still needs a
 * subject, because `declaredSubjectsProblem` refuses a subject-less check.
 * Pointing it at the module it checks is honest — if the module is deleted the
 * check reports WAITING rather than passing over nothing.
 */
const selfSubject = (file: string, exported: string, why: string) => ({ kind: 'module-export', name: `${file}#${exported}`, owedBy: 'P4-S8', why }) as const;

export const S8_CHECKS: readonly FrameworkCheck[] = [
  // ───── THE RECONCILIATION FRAMEWORK ─────────────────────────────────────
  {
    id: 'rsal-contract',
    title: 'the R-SAL-01…07 contract table, internally consistent',
    ok: "all seven of P4-AL-49's checks are present, each reads at least one relation, each declares its agreement domains, and each carries at least one planted discrepancy whose relation it actually reads",
    subjects: [selfSubject('scripts/phase4-s8/reconciliation-framework.ts', 'SALES_RECONCILIATION_CHECKS', 'the contract table itself')],
    evaluate: () => frameworkSelfProblems(),
    redProof: `${PROOFS}::the R-SAL contract refuses a check whose plant mutates a relation it never reads`,
    note: () => `${SALES_RECONCILIATION_CHECKS.length.toString()} checks, ${allPlants().length.toString()} planted discrepancies`,
  },
  {
    id: 'rsal-in-product-reconciler',
    title: 'R-SAL-01…07 added to the PRODUCT reconciler',
    ok: 'the accepted reconciliation module exports the sales check ids, so the identities are computed by the product on a daftar_reconciler read-only connection and not by a second implementation here',
    subjects: [
      {
        kind: 'module-export',
        name: 'packages/accounting/src/reconciliation.ts#SALES_RECONCILIATION_CHECK_IDS',
        owedBy: 'P4-S8',
        why: 'P4-AL-49 adds the seven to the EXISTING pass; until they are there, no R-SAL identity is computed anywhere',
      },
    ],
    evaluate: (root) => {
      // Reached only once the export is real. Then it asserts the two things
      // that make it meaningful: the ids are exactly P4-AL-49's seven, and the
      // deferral whose reason was "the R-SAL-* pass is assembled in P4-S8" is
      // gone. A deferral whose stated reason has become false is the kind of
      // green nobody re-reads — the module's own comment says so.
      const path = join(root, 'packages/accounting/src/reconciliation.ts');
      if (!existsSync(path)) return ['packages/accounting/src/reconciliation.ts is absent'];
      const text = readFileSync(path, 'utf8');
      const ids = arrayLiteralStrings(text, 'SALES_RECONCILIATION_CHECK_IDS');
      const expected = SALES_RECONCILIATION_CHECKS.map((c) => c.id);
      const problems: string[] = [];
      if (ids.join(',') !== expected.join(','))
        problems.push(`SALES_RECONCILIATION_CHECK_IDS is [${ids.join(', ')}] and P4-AL-49 declares [${expected.join(', ')}]`);
      if (/id:\s*'sales-payment'/.test(text) && /assembled in P4-S8/.test(text))
        problems.push(
          'the `sales-payment` deferral still states that the R-SAL pass is assembled in P4-S8, while the ids are now here — a deferral whose reason has become false is a green nobody re-reads',
        );
      return problems;
    },
    redProof: `${WAITING_PROOF}::rsal-in-product-reconciler reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },

  // ───── THE LOCK ORDER ───────────────────────────────────────────────────
  {
    id: 'lock-order-static',
    title: 'every discovered Phase 4 lock-taking routine acquires in the declared order (P4-AL-41)',
    ok: 'no routine inverts the declared domain rank order, every locking clause resolved to a relation, and invoice_sequences is last wherever it is taken (P4-AL-32)',
    subjects: [
      { kind: 'routine', name: 'sale_commit', owedBy: 'P4-S2', why: 'the sale is the routine the declared order was written for' },
      { kind: 'routine', name: 'customer_collect_payment', owedBy: 'P4-S4', why: 'the settlement command takes invoices then customers then the method' },
    ],
    evaluate: (root) => {
      const facts = readTree(root);
      // Every routine body in the tree, so the walk can INLINE the helper
      // routines a command PERFORMs. `sale_commit` takes `products` through
      // `sale_lock_commit_targets`, so a walk that stopped at the body would
      // say nothing about the order of the locks the command really takes and
      // would then report no problem — the vacuous pass, on the one question
      // this check was asked.
      const bodies = new Map<string, string>();
      for (const name of facts.routines.keys()) {
        const body = routineBody(facts, name);
        if (body !== null) bodies.set(name, body);
      }
      const problems: string[] = [];
      for (const routine of ['sale_commit', 'customer_collect_payment', 'customer_apply_credit']) {
        const body = bodies.get(routine);
        if (body === undefined) continue;
        problems.push(...acquisitionOrderProblems(routine, body, bodies), ...sequenceLastProblems(routine, body), ...forbiddenRemedyProblems(routine, body));
        const gaps = unwalkedHelpers(body, bodies, new Set(facts.routines.keys()));
        if (gaps.length > 0)
          problems.push(`${routine}: the lock order through ${gaps.join(', ')} is NOT covered by this walk — a gap in the walk is reported, never skipped`);
      }
      return problems;
    },
    redProof: `${DB_PROOF}::the lock-order checker names a REAL planted routine that inverts the declared order`,
    note: (root) => {
      const facts = readTree(root);
      const found = ['sale_commit', 'customer_collect_payment', 'customer_apply_credit'].filter((r) => facts.routines.has(r));
      return `${found.length.toString()} of 3 lock-taking routines present: ${found.join(', ')}`;
    },
  },
  {
    id: 'deadlock-matrix-plan',
    title: 'the deadlock pair matrix, generated, in BOTH directions, with deterministic barriers',
    ok: 'every pair of contending commands appears in both directions, every contended relation has a rank in P4-AL-41, every pair declares the head whose re-read proves no stale-head commit, and the iteration count is above one',
    subjects: [selfSubject('scripts/phase4-s8/deadlock-matrix.ts', 'LOCK_TAKING_COMMANDS', 'the command table the matrix is generated from')],
    evaluate: () => {
      const pairs = buildMatrix();
      return [...matrixProblems(pairs), ...staleHeadProblems(pairs)];
    },
    redProof: `${PROOFS}::the deadlock matrix refuses a pair run in only one direction`,
    note: () =>
      `${buildMatrix().length.toString()} ordered pairs over ${new Set(buildMatrix().map((p) => [p.first, p.second].sort().join('|'))).size.toString()} unordered pairs`,
  },
  {
    id: 'deadlock-matrix-execution',
    title: 'the deadlock matrix, EXECUTED, zero deadlocks and zero stale-head commits',
    ok: 'every pair ran N times in both directions against a real cluster with a detected park, and no run deadlocked or committed against a stale head',
    subjects: [
      { kind: 'routine', name: 'customer_issue_credit_note', owedBy: 'P4-S5', why: 'the return command is half of four pairs' },
      { kind: 'routine', name: 'customer_reverse_payment', owedBy: 'P4-S6', why: 'the reversal command is half of five pairs' },
      { kind: 'routine', name: 'customer_create_installment_plan', owedBy: 'P4-S7', why: 'the plan command is half of three pairs' },
    ],
    evaluate: () => [],
    redProof: `${WAITING_PROOF}::deadlock-matrix-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },

  // ───── THE INVENTORIES ──────────────────────────────────────────────────
  {
    id: 'idempotency-inventory',
    title: 'every idempotency key in the system, discovered, with its four facts',
    ok: 'every discovered replay path carries an intent digest, holds its identity by one of the three accepted mechanisms, consults the registry BEFORE the first real change, and names the refusal a changed intent conflicts on',
    subjects: [
      { kind: 'column', name: 'sales.commit_intent_sha256', owedBy: 'P4-S2', why: 'the first Phase 4 intent digest' },
      { kind: 'column', name: 'payments.intent_sha256', owedBy: 'P4-S4', why: 'the settlement intent digest' },
    ],
    evaluate: (root) => idempotencyFindings(discoverIdempotencyKeys(root)),
    redProof: `${PROOFS}::the idempotency inventory names a replay path whose registry read follows its first change`,
    note: (root) => {
      const keys = discoverIdempotencyKeys(root);
      const guards = keys.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k.identityGuard]: (acc[k.identityGuard] ?? 0) + 1 }), {});
      return `${keys.length.toString()} keys; identity guards ${JSON.stringify(guards)}; ${keys.filter((k) => k.bareKey).length.toString()} bare`;
    },
  },
  {
    id: 'idempotency-provider-reference',
    title: 'the provider-reference partial unique that refuses a replayed webhook AT THE DATABASE (P4-AL-30)',
    ok: 'a partial unique over (business_id, provider_source, provider_reference) exists, so a replayed payment-provider webhook is refused physically rather than by an application check',
    subjects: [
      {
        kind: 'column',
        name: 'payment_reversals.provider_reference',
        owedBy: 'P4-S6',
        why: 'the duplicate-reversal block P4-AL-30 names; no column in the tree matches provider_reference today',
      },
    ],
    evaluate: () => [],
    redProof: `${WAITING_PROOF}::idempotency-provider-reference reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
  {
    id: 'permission-inventory',
    title: 'the permission estate, discovered from the closed registry',
    ok: 'no SENSITIVE Phase 4 key is a default of any built-in role (OD-P4-01 OPTION A), and every Phase 4 key is bound by a migration-time role-default assertion (P4-AL-37)',
    subjects: [
      { kind: 'permission', name: 'sales.void', owedBy: 'P4-S1', why: 'the sensitive key the red proof plants against the cashier' },
      { kind: 'permission', name: 'refunds.approve', owedBy: 'P4-S1', why: 'the second sensitive key P4-AL-37 names' },
    ],
    evaluate: (root) => permissionFindings(discoverPermissions(root)),
    redProof: `${DB_PROOF}::the permission inventory names a REAL planted cashier -> sales.void grant`,
    note: (root) => {
      const rows = discoverPermissions(root);
      return `${rows.length.toString()} keys, ${rows.filter((r) => r.sensitive).length.toString()} sensitive, ${rows.filter((r) => r.phase === 'Phase 4').length.toString()} Phase 4`;
    },
  },
  {
    id: 'source-inventory',
    title: 'the accounting, stock and operation registries, discovered, with no dead registry concept',
    ok: 'every registered source type and operation kind has a writer somewhere in the migration estate, and every accounting source type binds its entry',
    subjects: [
      { kind: 'accounting-source-type', name: 'sale', owedBy: 'P4-S2', why: 'the first Phase 4 accounting source' },
      { kind: 'stock-source-type', name: 'sale', owedBy: 'P4-S2', why: 'the sale bridge' },
      { kind: 'operation-kind', name: 'sale.commit', owedBy: 'P4-S2', why: 'the one Phase 4 operation kind S2 registered' },
    ],
    evaluate: (root) => sourceFindings(discoverSources(root)),
    redProof: `${PROOFS}::the source inventory names a registry row whose name appears nowhere but its own INSERT`,
    note: (root) => {
      const rows = discoverSources(root);
      return `${rows.length.toString()} registry rows: ${rows.filter((r) => r.kind === 'accounting-source-type').length.toString()} accounting, ${rows.filter((r) => r.kind === 'stock-source-type').length.toString()} stock, ${rows.filter((r) => r.kind === 'operation-kind').length.toString()} operation kinds`;
    },
  },

  // ───── THE RLS ESTATE ───────────────────────────────────────────────────
  {
    id: 'rls-estate-static',
    title: 'the Phase 4 RLS estate: ENABLE + FORCE and six or seven policies (TL-P4-S1-C2)',
    ok: 'every discovered Phase 4 relation with a policy set carries ENABLE and FORCE ROW LEVEL SECURITY, at least six policies, and on an accounting-source relation the seventh — accounting_validator, whose absence makes the deferred completeness validator pass VACUOUSLY',
    subjects: [
      { kind: 'relation', name: 'invoices', owedBy: 'P4-S1', why: 'the seven-policy accounting-source relation' },
      { kind: 'policy', name: 'invoices.accounting_validator', owedBy: 'P4-S1', why: 'the seventh policy whose omission is the worst failure available here' },
    ],
    evaluate: (root) => staticEstateProblems(root),
    redProof: `${DB_PROOF}::the RLS estate checker names a REAL planted relation with FORCE missing and three policies`,
    note: (root) => {
      const counts = expectedPolicyCounts(root);
      const seven = [...counts.values()].filter((n) => n === 7).length;
      return `${counts.size.toString()} policy-bearing Phase 4 relations, ${seven.toString()} of them accounting sources expecting seven policies`;
    },
  },

  // ───── GOLDENS, THE UNIT-TREE ESTATE, THE BROWSER MATRIX ────────────────
  {
    id: 'golden-completeness',
    title: 'the Phase 4 golden suite, asserted COMPLETE against the declared twenty (P4-AL-65)',
    ok: 'every declared golden whose owning slice has shipped is referenced by a file in tests/golden-regression/phase4*, no canonical id is referenced that the declared table does not claim, and no third id series exists',
    subjects: [{ kind: 'golden-directory', name: 'tests/golden-regression/phase4', owedBy: 'P4-S1', why: 'the Phase 4 golden estate' }],
    evaluate: (root) => goldenCompletenessProblems(root),
    redProof: `${PROOFS}::golden completeness names a declared golden whose shipped owner left it unreferenced`,
    note: (root) => {
      const c = goldenCompleteness(root);
      return `${c.files.length.toString()} golden files; ${c.delivered.length.toString()} delivered, ${c.waiting.length.toString()} waiting, ${c.missing.length.toString()} missing of ${20}`;
    },
  },
  {
    id: 'unit-tree-estate',
    title: 'the five workspace unit trees that no tests/** run and no slice gate reaches',
    ok: 'all five trees hold tests, the root runner still reaches only tests/**, `npm test` is a step of the required backend job, and it is still AHEAD of the database steps so its failure skips the integration tests, the goldens and every gate',
    subjects: [
      { kind: 'npm-script', name: 'test', owedBy: 'P4-S1', why: 'the command that runs the five trees' },
      { kind: 'workflow-step', name: 'Unit tests', owedBy: 'P4-S1', why: 'the required-job step that executes them' },
    ],
    evaluate: (root) => unitTreeReachProblems(root),
    redProof: `${PROOFS}::the unit-tree estate check names the ordering when npm test moves after the database steps`,
    note: (root) => {
      const e = unitTreeEstate(root);
      return (
        `${e.totalFiles.toString()} test files across ${e.trees.length.toString()} trees (${e.trees.map((t) => `${t.path}:${t.files.toString()}`).join(', ')}); ` +
        `\`npm test\` is backend step ${e.backendStepIndex?.toString() ?? 'ABSENT'}, first database step ${e.firstDatabaseStepIndex?.toString() ?? 'ABSENT'}`
      );
    },
  },
  {
    id: 'browser-matrix',
    title: 'the Phase 4 browser matrix: p4- prefixed steps, disjoint lists, three locales, three viewports',
    ok: 'PHASE3_STEPS and PHASE4_STEPS are both readable and disjoint, every declared step is p4- prefixed, every registered p4- step is one the contract names, and each of the four new invariant kinds declares its planted defect',
    subjects: [{ kind: 'suite', name: 'tests/browser/flows.ts', owedBy: 'P4-S1', why: 'the step registry the matrix is read from' }],
    evaluate: (root) => browserMatrixProblems(root),
    redProof: `${PROOFS}::the browser matrix refuses a PHASE4_STEPS entry that collides with a Phase 3 step`,
    note: (root) => {
      const m = browserMatrix(root);
      return `${m.registeredSteps.length.toString()} registered steps, ${m.registeredP4Steps.length.toString()} of them p4-; ${m.stepRuns.toString()} step-runs today against a declared target of ${(16 * 9).toString()}`;
    },
  },

  // ───── PERFORMANCE: BUILD ONLY ──────────────────────────────────────────
  {
    id: 'performance-plan',
    title: 'the eight budgets plus the reconciliation total, each anchored, each with a host-independent ratio',
    ok: 'every budget carries either a ceiling or a calibration hard cap but never both, an anchor, a ratio assertion and at least one plan assertion, and no plan assertion pins the planner choice',
    subjects: [selfSubject('scripts/phase4-s8/performance-orchestrator.ts', 'BUDGETS', 'the budget table')],
    evaluate: () => budgetPlanProblems(),
    redProof: `${PROOFS}::the budget plan refuses a ceiling increase, a p95 to p90 change and a reduced sample`,
    note: () => `${BUDGETS.length.toString()} budgets; ${BUDGETS.filter((b) => b.hardCapMs !== null).length.toString()} calibration-locked under a product cap`,
  },
  {
    id: 'performance-orchestration-refuses-contention',
    title: 'the orchestrator refuses to measure without an exclusive-box attestation',
    ok: 'orchestrate(null, …) returns INVALID_RESOURCE_CONTENTION and no timing is taken; a figure produced under contention is neither a pass nor a fail',
    subjects: [selfSubject('scripts/phase4-s8/performance-orchestrator.ts', 'orchestrate', 'the orchestrator')],
    evaluate: () => {
      const plan = orchestrate(null, 1);
      const problems: string[] = [];
      if (plan.verdict !== 'INVALID_RESOURCE_CONTENTION') problems.push(`orchestrate(null) returned ${plan.verdict} rather than INVALID_RESOURCE_CONTENTION`);
      if (plan.steps.length > 0) problems.push('orchestrate(null) returned measurement steps, so a caller could run them');
      const relaxed = mutationProblems({ budgetId: 'P4-A', ceilingMs: 500 });
      if (relaxed.length === 0) problems.push('a ceiling increase from 150 ms to 500 ms was accepted — the immutable-threshold rule is not enforced');
      return problems;
    },
    redProof: `${PROOFS}::the orchestrator refuses an unattested box and a relaxed ceiling`,
  },

  // ───── THE SCENARIOS ────────────────────────────────────────────────────
  {
    id: 'lifecycle-scenario-plan',
    title: 'the fourteen-stage whole-lifecycle scenario, in order, with every agreement domain covered before the final pass',
    ok: 'the stage order is customer -> sale -> invoice -> payment -> allocation -> overpayment credit -> credit application -> return -> credit note -> refund -> reversal -> installment -> statement -> reconciliation; every stage declares a subject and a domain; every agreement domain is covered by a stage other than the last; and every stage from the invoice onwards re-runs at least one reconciliation check',
    subjects: [selfSubject('scripts/phase4-s8/scenarios.ts', 'LIFECYCLE', 'the stage table')],
    evaluate: () => lifecycleProblems(),
    redProof: `${PROOFS}::the lifecycle refuses a stage order that is not the required fourteen`,
    note: () =>
      `${LIFECYCLE.length.toString()} stages; ${LIFECYCLE.filter((s) => s.reconciliationChecks.length > 0).length.toString()} run a reconciliation pass`,
  },
  {
    id: 'lifecycle-scenario-execution',
    title: 'the whole-lifecycle scenario, EXECUTED, with the books agreeing after every stage',
    ok: 'all fourteen stages ran against a real cluster through the product own commands, and GL, AR, AP, inventory, COGS, cash/bank, customer credit, refund liability, invoice outstanding, source bindings, audit, outbox and reconciliation agreed after every one',
    subjects: [
      {
        kind: 'relation',
        name: 'credit_notes',
        owedBy: 'P4-S5',
        why: 'stages 8 (return) and 9 (credit note) cannot be performed without it, so the lifecycle stops before revenue is reversed and nothing downstream is reached',
      },
      {
        kind: 'relation',
        name: 'refunds',
        owedBy: 'P4-S5',
        why: 'stage 10 (refund) moves real money out; without the relation the refund liability and cash arms have nothing to reconcile',
      },
      {
        kind: 'relation',
        name: 'payment_reversals',
        owedBy: 'P4-S6',
        why: 'stage 11 (reversal) is where a settled payment is undone; without the relation no reversal can be recorded or verified',
      },
      {
        kind: 'relation',
        name: 'installments',
        owedBy: 'P4-S7',
        why: 'stage 12 (installment) carries the schedule whose sum must equal the invoice; without the relation that identity cannot be checked',
      },
    ],
    evaluate: () => [],
    redProof: `${WAITING_PROOF}::lifecycle-scenario-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
  {
    id: 'isolation-scenario-plan',
    title: 'the isolation-critical path, with a second tenant AND a second business of one tenant',
    ok: 'both arms exist, the second-business arm reaches SQL rather than only the API, and every step names what refuses it',
    subjects: [selfSubject('scripts/phase4-s8/scenarios.ts', 'ISOLATION_PATH', 'the isolation step table')],
    evaluate: () => isolationProblems(),
    redProof: `${PROOFS}::the isolation path refuses a second-business arm that only drives the API`,
    note: () =>
      `${ISOLATION_PATH.length.toString()} steps: ${ISOLATION_PATH.filter((s) => s.arm === 'second-tenant').length.toString()} second-tenant, ` +
      `${ISOLATION_PATH.filter((s) => s.arm === 'second-business-of-one-tenant').length.toString()} second-business`,
  },
  {
    id: 'isolation-scenario-execution',
    title: 'the isolation-critical path, EXECUTED against a real cluster',
    ok: 'every step was attempted and refused at the layer it names, with the second-business arm refused by the database rather than by a service check',
    subjects: [
      {
        kind: 'relation',
        name: 'refunds',
        owedBy: 'P4-S5',
        why: 'iso-06 attempts a cross-business refund, the value-moving edge; without the relation the attempt cannot be made and a pass would mean only that nothing happened',
      },
      { kind: 'constraint', name: 'invoices_customer_uq', owedBy: 'P4-S4', why: 'iso-03 structural pin' },
    ],
    evaluate: () => [],
    redProof: `${WAITING_PROOF}::isolation-scenario-execution reports WAITING_FOR_INTEGRATED_SURFACE and never PASS`,
  },
];

export function runS8(root: string): readonly CheckOutcome[] {
  return S8_CHECKS.map((check) => evaluateCheck(root, check, probeSubject));
}

export { runVerdict, tally };
