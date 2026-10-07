#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE WHOLE-LIFECYCLE SCENARIO AND THE
 * SECOND-BUSINESS ISOLATION SCENARIO
 *
 * ── THE LIFECYCLE ────────────────────────────────────────────────────────
 *
 * The final lifecycle the reconciliation must cover, in order:
 *
 *   customer -> sale -> invoice -> payment -> allocation -> overpayment credit
 *   -> credit application -> return -> credit note -> refund -> reversal
 *   -> installment -> statement -> reconciliation
 *
 * Fourteen stages. Each one declares the AGREEMENT DOMAINS that must still
 * hold after it, the commands it runs, and the subjects it needs. The point of
 * declaring the domains per stage is that the reconciliation is run AFTER EVERY
 * STAGE and not only at the end: a scenario checked once at the end cannot say
 * WHICH stage broke the books, and an error introduced at stage 4 and
 * cancelled at stage 11 is invisible to it.
 *
 * ── THE ISOLATION SCENARIO ───────────────────────────────────────────────
 *
 * The isolation-critical path is run with a SECOND TENANT **and** a SECOND
 * BUSINESS of the first tenant. Those are two different invariants and the
 * second is the one that is easy to lose:
 *
 *   a SECOND TENANT tests the RLS tenant policy — `tenant_id = app_tenant()`;
 *   a SECOND BUSINESS OF ONE TENANT tests the per-business composite keys and
 *   the four RESTRICTIVE per-command policies, because both businesses pass
 *   the tenant policy. `GOLD-48`'s numbering isolation is exactly this case,
 *   and a suite that only ever had one business per tenant would pass with the
 *   business arm of every policy deleted.
 */
import { AGREEMENT_DOMAINS, type AgreementDomain } from './reconciliation-framework';
import { type SubjectRequirement } from './verdict';

export interface LifecycleStage {
  readonly order: number;
  readonly id: string;
  /** The command, in the operation vocabulary where there is one. */
  readonly command: string;
  /** The books that must still agree AFTER this stage. */
  readonly domains: readonly AgreementDomain[];
  /** The reconciliation checks run after this stage. */
  readonly reconciliationChecks: readonly string[];
  readonly subjects: readonly SubjectRequirement[];
  readonly owedBy: string;
}

const relation = (name: string, owedBy: string, why: string): SubjectRequirement => ({ kind: 'relation', name, owedBy, why });
const routine = (name: string, owedBy: string, why: string): SubjectRequirement => ({ kind: 'routine', name, owedBy, why });

export const LIFECYCLE: readonly LifecycleStage[] = [
  {
    order: 1,
    id: 'customer',
    command: 'customers.manage',
    domains: ['audit', 'outbox'],
    reconciliationChecks: [],
    subjects: [relation('customers', 'P4-S1', 'the lifecycle starts at a named customer')],
    owedBy: 'P4-S1',
  },
  {
    order: 2,
    id: 'sale',
    command: 'sale.commit',
    domains: ['gl', 'inventory', 'cogs', 'source-bindings', 'audit', 'outbox'],
    reconciliationChecks: ['R-SAL-03', 'R-SAL-07', 'R-INV-01', 'R-INV-02'],
    subjects: [relation('sales', 'P4-S2', 'the sale is the stock-moving half'), routine('sale_commit', 'P4-S2', 'the atomic sale command')],
    owedBy: 'P4-S2',
  },
  {
    order: 3,
    id: 'invoice',
    command: 'sale.commit (the same transaction)',
    domains: ['gl', 'ar', 'invoice-outstanding', 'source-bindings'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-02', 'R-SAL-03', 'R-SAL-05'],
    subjects: [
      relation('invoices', 'P4-S1', 'the revenue and AR half'),
      relation('invoice_sequences', 'P4-S1', 'the number is allocated under the series row lock'),
    ],
    owedBy: 'P4-S2',
  },
  {
    order: 4,
    id: 'payment',
    command: 'customer.collect_payment',
    domains: ['gl', 'ar', 'cash-bank', 'audit', 'outbox'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-07'],
    subjects: [
      relation('payments', 'P4-S4', 'without the payments relation there is no row whose settlement the cash, AR and GL arms can be reconciled against'),
      routine('customer_collect_payment', 'P4-S4', 'the settlement command'),
    ],
    owedBy: 'P4-S4',
  },
  {
    order: 5,
    id: 'allocation',
    command: 'customer.collect_payment (the allocation array)',
    domains: ['gl', 'ar', 'invoice-outstanding', 'source-bindings'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-02', 'R-SAL-07'],
    subjects: [relation('payment_allocations', 'P4-S4', 'one journal entry per allocation')],
    owedBy: 'P4-S4',
  },
  {
    order: 6,
    id: 'overpayment-credit',
    command: 'customer.collect_payment (the surplus)',
    domains: ['gl', 'customer-credit'],
    reconciliationChecks: ['R-SAL-04'],
    subjects: [relation('customer_credits', 'P4-S4', 'the surplus becomes a credit and never revenue')],
    owedBy: 'P4-S4',
  },
  {
    order: 7,
    id: 'credit-application',
    command: 'customer.apply_credit',
    domains: ['gl', 'ar', 'customer-credit', 'invoice-outstanding'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-02', 'R-SAL-04'],
    subjects: [relation('customer_credit_applications', 'P4-S4', 'the credit lands on a later invoice under a lock')],
    owedBy: 'P4-S4',
  },
  {
    order: 8,
    id: 'return',
    command: 'sales.return',
    domains: ['gl', 'inventory', 'cogs', 'ar'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-03', 'R-INV-01', 'R-INV-02'],
    subjects: [
      relation(
        'credit_note_items',
        'P4-S5',
        'the credit-note lines are the quantities the inventory and COGS arms reconcile against; with no lines there is nothing to disagree',
      ),
      routine(
        'customer_issue_credit_note',
        'P4-S5',
        'the command that writes the credit note; without it the return stage can be described and not performed, and a described stage reconciles nothing',
      ),
    ],
    owedBy: 'P4-S5',
  },
  {
    order: 9,
    id: 'credit-note',
    command: 'sales.return (the document)',
    domains: ['gl', 'ar', 'invoice-outstanding'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-03'],
    subjects: [relation('credit_notes', 'P4-S5', 'revenue reversed exactly once')],
    owedBy: 'P4-S5',
  },
  {
    order: 10,
    id: 'refund',
    command: 'refunds.approve',
    domains: ['gl', 'cash-bank', 'refund-liability'],
    reconciliationChecks: ['R-SAL-04', 'R-SAL-07'],
    subjects: [relation('refunds', 'P4-S5', 'the refund never touches revenue')],
    owedBy: 'P4-S5',
  },
  {
    order: 11,
    id: 'reversal',
    command: 'payments.reverse',
    domains: ['gl', 'ar', 'cash-bank', 'invoice-outstanding', 'source-bindings'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-02', 'R-SAL-07'],
    subjects: [
      relation(
        'payment_reversals',
        'P4-S6',
        'the reversal rows are the only place a chargeback is recorded; with no relation the reversal stage has no effect to verify',
      ),
      relation('allocation_reversals', 'P4-S6', 'no stale allocation after a payment reversal'),
    ],
    owedBy: 'P4-S6',
  },
  {
    order: 12,
    id: 'installment',
    command: 'installments.manage',
    domains: ['ar', 'invoice-outstanding'],
    reconciliationChecks: ['R-SAL-06'],
    subjects: [
      relation('installment_plans', 'P4-S7', 'the schedule as a view over an existing receivable'),
      relation(
        'installments',
        'P4-S7',
        'the installment rows carry the constraint that their sum equals the invoice; with no relation the constraint can be neither violated nor upheld',
      ),
    ],
    owedBy: 'P4-S7',
  },
  {
    order: 13,
    id: 'statement',
    command: 'receivables.view (the statement read)',
    domains: ['ar', 'invoice-outstanding'],
    reconciliationChecks: ['R-SAL-01', 'R-SAL-02'],
    subjects: [{ kind: 'npm-script', name: 'perf:phase4:s7', owedBy: 'P4-S7', why: 'the statement keyset page and its budget' }],
    owedBy: 'P4-S7',
  },
  {
    order: 14,
    id: 'reconciliation',
    command: 'the product reconciler on a daftar_reconciler read-only connection',
    domains: [...AGREEMENT_DOMAINS],
    reconciliationChecks: [
      'R-SAL-01',
      'R-SAL-02',
      'R-SAL-03',
      'R-SAL-04',
      'R-SAL-05',
      'R-SAL-06',
      'R-SAL-07',
      'R-INV-01',
      'R-INV-02',
      'R-INV-03',
      'R-INV-04',
      'R-INV-05',
    ],
    subjects: [
      {
        kind: 'module-export',
        name: 'packages/accounting/src/reconciliation.ts#SALES_RECONCILIATION_CHECK_IDS',
        owedBy: 'P4-S8',
        why: 'the R-SAL ids added to the product reconciler',
      },
    ],
    owedBy: 'P4-S8',
  },
];

/**
 * THE LIFECYCLE'S OWN LAWS.
 *
 * The one that earns its place: EVERY agreement domain must be covered by at
 * least one stage. A lifecycle that never touched `cash-bank` would run the
 * whole fourteen stages and never once check that the money moved — and the
 * final stage's domain list, which is every domain, is not allowed to be the
 * only cover, because a check made once at the end cannot name the stage that
 * broke it.
 */
export function lifecycleProblems(stages: readonly LifecycleStage[] = LIFECYCLE): string[] {
  const problems: string[] = [];
  if (stages.length === 0) problems.push('the lifecycle is EMPTY');
  const expectedOrder = [
    'customer',
    'sale',
    'invoice',
    'payment',
    'allocation',
    'overpayment-credit',
    'credit-application',
    'return',
    'credit-note',
    'refund',
    'reversal',
    'installment',
    'statement',
    'reconciliation',
  ];
  const actual = [...stages].sort((a, b) => a.order - b.order).map((s) => s.id);
  if (actual.join(' -> ') !== expectedOrder.join(' -> '))
    problems.push(`the lifecycle is ${actual.join(' -> ')} and the required order is ${expectedOrder.join(' -> ')}`);
  for (const stage of stages) {
    if (stage.subjects.length === 0) problems.push(`stage ${stage.id}: declares no subject, so nothing decides whether it can run`);
    if (stage.domains.length === 0) problems.push(`stage ${stage.id}: declares no agreement domain, so nothing is checked after it`);
  }
  // Every domain covered by a stage OTHER than the final whole-pass stage —
  // except the two that cannot be, and are named rather than silently skipped:
  //
  //   `reconciliation` IS the final stage, so requiring an earlier stage to
  //   cover it is a contradiction in the law, not a gap in the lifecycle.
  //
  //   `ap` — Accounts Payable — is touched by NO stage of the SALES lifecycle.
  //   `P4-AL-49` says "GL, AR, AP WHERE APPLICABLE", and the only Phase 4 path
  //   that reaches AP is TD-15's supplier twin, closed in P4-S6 in the same
  //   transaction shape, which is a SUPPLIER settlement and not a stage of
  //   customer -> ... -> reconciliation. The final pass still checks it,
  //   through the accepted `R-ACC-*` set, which is why it stays in
  //   AGREEMENT_DOMAINS rather than being deleted from the vocabulary: a
  //   domain removed from the list is a domain nobody notices is unchecked.
  const STAGE_EXEMPT: readonly AgreementDomain[] = ['reconciliation', 'ap'];
  const covered = new Set(stages.filter((s) => s.id !== 'reconciliation').flatMap((s) => s.domains));
  for (const domain of AGREEMENT_DOMAINS) {
    if (covered.has(domain) || STAGE_EXEMPT.includes(domain)) continue;
    problems.push(
      `agreement domain ${domain} is covered only by the final reconciliation stage — a check made once at the end cannot name the stage that broke it`,
    );
  }
  // And the exemption itself is checked, so it cannot quietly grow: a domain
  // exempted AND covered by a stage means the exemption's stated reason has
  // stopped being true.
  for (const domain of STAGE_EXEMPT)
    if (domain !== 'reconciliation' && covered.has(domain))
      problems.push(
        `agreement domain ${domain} is listed as stage-exempt AND is covered by a stage — the exemption's stated reason has stopped being true and the comment above is now wrong`,
      );
  // Every stage from `payment` onwards must re-run at least one check, or an
  // error introduced early and cancelled late is invisible.
  for (const stage of stages)
    if (stage.order >= 3 && stage.reconciliationChecks.length === 0)
      problems.push(`stage ${stage.id}: runs no reconciliation check, so a discrepancy it introduces is only found later or not at all`);
  return problems;
}

// ───────────────────── THE ISOLATION SCENARIO ─────────────────────────────

export type IsolationArm = 'second-tenant' | 'second-business-of-one-tenant';

export interface IsolationStep {
  readonly id: string;
  /** Which arm this step belongs to. BOTH arms are required.*/
  readonly arm: IsolationArm;
  /** What is attempted. */
  readonly attempt: string;
  /** What must refuse it, and at which layer. */
  readonly refusedBy: string;
  /** The layer. A refusal only at the API layer is not isolation. */
  readonly layer: 'api' | 'sql' | 'both';
  readonly subjects: readonly SubjectRequirement[];
  readonly owedBy: string;
}

export const ISOLATION_PATH: readonly IsolationStep[] = [
  {
    id: 'iso-01',
    arm: 'second-tenant',
    attempt: "tenant B's token against every Phase 4 route, enumerated FROM THE ROUTE REGISTRY so a new route cannot escape",
    refusedBy: 'the RLS tenant policy, and the four RESTRICTIVE per-command policies behind it',
    layer: 'both',
    subjects: [relation('customers', 'P4-S1', 'the first tenant-scoped Phase 4 relation')],
    owedBy: 'P4-S1',
  },
  {
    id: 'iso-02',
    arm: 'second-tenant',
    attempt: "direct SQL as daftar_app with tenant A's GUCs, selecting tenant B's rows",
    refusedBy: "the tenant policy's direct form `tenant_id = nullif(app_tenant(), '')::uuid`",
    layer: 'sql',
    subjects: [relation('invoices', 'P4-S1', 'the relation with seven policies')],
    owedBy: 'P4-S1',
  },
  {
    id: 'iso-03',
    arm: 'second-business-of-one-tenant',
    attempt: "business B2's invoice settled by a payment of business B1, both of tenant A — so BOTH pass the tenant policy",
    refusedBy: 'the three-column composite FK (business_id, invoice_id, customer_id) -> invoices (business_id, id, customer_id), 0082:217',
    layer: 'sql',
    subjects: [
      relation(
        'payment_allocations',
        'P4-S4',
        'the allocation is the edge a second business must not be able to settle across; with no relation the isolation attempt has nothing to attempt',
      ),
      {
        kind: 'constraint',
        name: 'invoices_customer_uq',
        owedBy: 'P4-S4',
        why: 'the unique constraint is what makes the cross-business settlement structurally impossible rather than merely refused by code',
      },
    ],
    owedBy: 'P4-S4',
  },
  {
    id: 'iso-04',
    arm: 'second-business-of-one-tenant',
    attempt: 'two businesses of one tenant allocate invoice numbers concurrently, N each',
    refusedBy: "the series row's key includes business_id, so no tenant-level mixing is EXPRESSIBLE (GOLD-48); N distinct numbers, no gap, no duplicate",
    layer: 'sql',
    subjects: [relation('invoice_sequences', 'P4-S1', 'the per-business series')],
    owedBy: 'P4-S1',
  },
  {
    id: 'iso-05',
    arm: 'second-business-of-one-tenant',
    attempt: "business B1's credit applied to business B2's invoice",
    refusedBy: 'the composite FK on customer_credit_applications (0082:225)',
    layer: 'sql',
    subjects: [relation('customer_credit_applications', 'P4-S4', 'the credit-application edge')],
    owedBy: 'P4-S4',
  },
  {
    id: 'iso-06',
    arm: 'second-business-of-one-tenant',
    attempt: "business B1's credit note refunded against business B2's source",
    refusedBy: "the refund's single non-null source and its own composite FK",
    layer: 'sql',
    subjects: [
      relation(
        'refunds',
        'P4-S5',
        'the refund is the value-moving edge a second business must not reach; with no relation the attempt cannot be made and a pass would mean only that nothing happened',
      ),
    ],
    owedBy: 'P4-S5',
  },
  {
    id: 'iso-07',
    arm: 'second-business-of-one-tenant',
    attempt: "a branch-scoped user of business B1 reading business B2's till session",
    refusedBy: 'the policy, not the controller (P4-AL-40)',
    layer: 'sql',
    subjects: [relation('pos_till_sessions', 'P4-S3', 'the branch-scoped relation')],
    owedBy: 'P4-S3',
  },
];

/**
 * BOTH ARMS ARE REQUIRED, and the second-business arm must reach SQL.
 *
 * A second-business suite that only drove the API would pass with every
 * composite FK dropped, because the service layer also checks — which is
 * exactly the shape `P4-AL-40` names ("the temptation is to check it in the
 * service layer").
 */
export function isolationProblems(steps: readonly IsolationStep[] = ISOLATION_PATH): string[] {
  const problems: string[] = [];
  const arms = new Set(steps.map((s) => s.arm));
  for (const arm of ['second-tenant', 'second-business-of-one-tenant'] as const)
    if (!arms.has(arm))
      problems.push(`the isolation path has no ${arm} arm — the two are different invariants and the second-business one is the one easy to lose`);
  const businessArm = steps.filter((s) => s.arm === 'second-business-of-one-tenant');
  if (businessArm.length === 0) problems.push('the second-business arm is empty');
  else if (!businessArm.some((s) => s.layer === 'sql' || s.layer === 'both'))
    problems.push('no second-business step reaches SQL — an API-only second-business suite passes with every composite FK dropped (P4-AL-40)');
  for (const step of steps) {
    if (step.subjects.length === 0) problems.push(`${step.id}: declares no subject`);
    if (step.refusedBy.trim() === '') problems.push(`${step.id}: names nothing that refuses it, so a pass means only that nothing happened`);
  }
  return problems;
}
