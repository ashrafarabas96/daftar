#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — R-SAL-01 … R-SAL-07, AND THE DISCREPANCY PLANTS
 *
 * `P4-AL-49` names seven sales reconciliation checks to be ADDED to the
 * existing pass (`packages/accounting/src/reconciliation.ts`, whose accepted
 * `R-ACC-01…09` and `R-INV-01…05` are NOT re-implemented here and NOT edited
 * by S8). This module is the framework half: each check's IDENTITY, the
 * AGREEMENT DOMAINS it is responsible for, the ACCOUNT CODES it reads —
 * written out from the chart migration `0040:44-67`, never read back from a
 * seed, because a balanced entry made of the wrong accounts balances
 * perfectly and that is the GOLD-28 defect — the SUBJECTS it needs to be real,
 * and the DISCREPANCY that must be planted to prove it can go red.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   — the SQL. A check's query belongs to the product's own reconciler on the
 *     `daftar_reconciler` read-only connection (`P4-AL-49`), and writing a
 *     second implementation here would be the second financial model this
 *     slice is forbidden to create. What is here is the check's CONTRACT.
 *   — any claim that a check passes. Six of the seven have subjects that do
 *     not exist in the tree yet; `index.ts` turns that into
 *     `WAITING_FOR_INTEGRATED_SURFACE`.
 *
 * THE PLANT LAW. A red proof plants a REAL subject — a real row, in a real
 * transaction, rolled back afterwards — and asserts the check NAMES it. The
 * two ways to get this wrong are both recorded:
 *
 *   planting a FICTIONAL subject (a row in a relation that does not exist, a
 *   discrepancy in a currency nothing posts) and asserting "no finding"
 *   asserts the OPPOSITE of the proof's intent; and
 *
 *   a LEXICAL plant — editing the check's own source so it reports — proves
 *   the string exists, not that the arithmetic can disagree. Every plant below
 *   is a DATA plant, evaluated semantically.
 */

/** The account codes `R-SAL-*` reads, written out from `0040:44-67`. */
export const ACCOUNT = {
  cash: '1000',
  bank: '1010',
  cardClearing: '1020',
  accountsReceivable: '1100',
  inventory: '1200',
  accountsPayable: '2000',
  taxPayable: '2100',
  customerRefundLiability: '2200',
  customerCreditLiability: '2210',
  salesRevenue: '4000',
  salesReturns: '4100',
  discounts: '4200',
  fxGain: '4900',
  cogs: '5000',
  rounding: '6100',
  fxLoss: '6900',
} as const;

/**
 * The twelve books `R-SAL-*` must make agree. The lifecycle check must cover
 * every one of them; `lifecycle-scenario.ts` asserts the cover is total, which
 * is why this is an enumerated type and not a comment.
 */
export type AgreementDomain =
  | 'gl'
  | 'ar'
  | 'ap'
  | 'inventory'
  | 'cogs'
  | 'cash-bank'
  | 'customer-credit'
  | 'refund-liability'
  | 'invoice-outstanding'
  | 'source-bindings'
  | 'audit'
  | 'outbox'
  | 'reconciliation';

export const AGREEMENT_DOMAINS: readonly AgreementDomain[] = [
  'gl',
  'ar',
  'ap',
  'inventory',
  'cogs',
  'cash-bank',
  'customer-credit',
  'refund-liability',
  'invoice-outstanding',
  'source-bindings',
  'audit',
  'outbox',
  'reconciliation',
];

export type SalesReconciliationCheckId = 'R-SAL-01' | 'R-SAL-02' | 'R-SAL-03' | 'R-SAL-04' | 'R-SAL-05' | 'R-SAL-06' | 'R-SAL-07';

/**
 * One planted discrepancy.
 *
 * `relation` + `mutation` name a REAL write against a REAL relation. `rollback`
 * is how it is undone — always `ROLLBACK`, because a reconciliation plant that
 * commits leaves the next check reading a corrupted book and the slice ends
 * with a finding nobody planted.
 */
export interface DiscrepancyPlant {
  readonly id: string;
  /** The relation whose row is planted or mutated. Must be real for the plant to be legal. */
  readonly relation: string;
  /** What exactly is done, in words precise enough to write the SQL from. */
  readonly mutation: string;
  /** The side of the identity the plant breaks, so the expected finding is derivable. */
  readonly breaks: string;
  /** What the check must report. A plant whose finding is not NAMED is not a proof. */
  readonly expectedFinding: string;
  /** How the plant is undone. */
  readonly rollback: 'ROLLBACK';
  /**
   * Why this plant is not a fiction. A plant into a relation that does not
   * exist cannot be performed at all, so the proof would assert "no finding" —
   * the opposite of its intent.
   */
  readonly realityNote: string;
}

export interface SalesReconciliationCheck {
  readonly id: SalesReconciliationCheckId;
  /** The identity, exactly as `P4-AL-49` states it. */
  readonly identity: string;
  /** Which books this check makes agree. */
  readonly domains: readonly AgreementDomain[];
  /** The account codes it reads. Empty only for a document-only identity. */
  readonly accounts: readonly string[];
  /** The relations it reads. These are its subjects. */
  readonly relations: readonly string[];
  /** The slice that makes the last of its relations real. */
  readonly owedBy: string;
  /**
   * The grain it reports at. `R-SAL-01` is explicitly per customer AND in
   * total, and a check that only aggregates would pass over two customers
   * whose errors cancel.
   */
  readonly grain: 'per-row' | 'per-customer-and-total' | 'per-invoice' | 'per-plan' | 'per-entry' | 'total';
  /** The planted discrepancies that prove it can be RED. At least one each. */
  readonly plants: readonly DiscrepancyPlant[];
  /** What a reader must NOT conclude from a green `R-SAL-*`. */
  readonly doesNotProve: string;
}

export const SALES_RECONCILIATION_CHECKS: readonly SalesReconciliationCheck[] = [
  {
    id: 'R-SAL-01',
    identity: 'AR from the journal = Σ(invoice totals) − Σ(allocations) − Σ(applied credit notes), per customer AND in total',
    domains: ['gl', 'ar', 'invoice-outstanding'],
    accounts: [ACCOUNT.accountsReceivable],
    relations: ['journal_entries', 'journal_lines', 'invoices', 'payment_allocations', 'credit_notes'],
    owedBy: 'P4-S5',
    grain: 'per-customer-and-total',
    plants: [
      {
        id: 'R-SAL-01/P1',
        relation: 'payment_allocations',
        mutation: 'INSERT one extra allocation row of 1 minor unit against an invoice of the fixture customer, with no journal entry behind it',
        breaks: 'the document side of the identity moves and the journal side does not',
        expectedFinding: 'R-SAL-01 reports a discrepancy of 1 minor unit NAMING that customer, and the total arm reports the same 1',
        rollback: 'ROLLBACK',
        realityNote: '`payment_allocations` is real since 0081, so the row is a real row in a real relation under the real constraints',
      },
      {
        id: 'R-SAL-01/P2',
        relation: 'payment_allocations',
        mutation: 'INSERT two offsetting extra allocations of +1 and −1 against invoices of TWO DIFFERENT customers',
        breaks: 'the TOTAL arm nets to zero while each per-customer arm is wrong by 1',
        expectedFinding:
          'the per-customer arm reports BOTH customers; a check that only aggregated would report nothing, which is why the grain is part of the contract',
        rollback: 'ROLLBACK',
        realityNote: 'the same real relation; this plant exists because the aggregate-only form of this check is the easiest wrong one to write',
      },
    ],
    doesNotProve: 'that each invoice total is itself right — that is the documents` own law, not an agreement between two books',
  },
  {
    id: 'R-SAL-02',
    identity: "per invoice, paid + outstanding = total in the invoice's own currency (P4-AL-26)",
    domains: ['invoice-outstanding', 'ar'],
    accounts: [],
    relations: ['invoices', 'payment_allocations', 'customer_credit_applications'],
    owedBy: 'P4-S4',
    grain: 'per-invoice',
    plants: [
      {
        id: 'R-SAL-02/P1',
        relation: 'payment_allocations',
        mutation: 'UPDATE one allocation`s paid amount by +1 minor unit, leaving the invoice total untouched',
        breaks: 'derived paid exceeds total by 1, so paid + outstanding ≠ total',
        expectedFinding: 'R-SAL-02 names that invoice id and reports the 1-unit excess',
        rollback: 'ROLLBACK',
        realityNote:
          'a real UPDATE of a real allocation row; the invoice relation carries no stored paid column (P4-AL-24), so the plant has to move the allocation',
      },
      {
        id: 'R-SAL-02/P2',
        relation: 'payment_allocations',
        mutation: 'INSERT an allocation in a DIFFERENT currency from the invoice`s own, of an amount that nets to zero in base',
        breaks: 'the identity holds in base and fails in the invoice`s own currency — which is the currency P4-AL-26 names',
        expectedFinding: 'R-SAL-02 names the invoice; a check written in base currency would report nothing, which is exactly the defect this plant exists for',
        rollback: 'ROLLBACK',
        realityNote: 'the 85/10/5 currency mix of D-SALES makes a non-base allocation an ordinary row, not a contrivance',
      },
    ],
    doesNotProve: 'that the base-currency figures agree; that is R-SAL-01`s side of the pair',
  },
  {
    id: 'R-SAL-03',
    identity: 'revenue from the journal = Σ(invoice line revenue), and each invoice`s revenue posted exactly once',
    domains: ['gl', 'source-bindings'],
    accounts: [ACCOUNT.salesRevenue, ACCOUNT.salesReturns, ACCOUNT.discounts],
    relations: ['journal_lines', 'invoices', 'invoice_items'],
    owedBy: 'P4-S2',
    grain: 'per-invoice',
    plants: [
      {
        id: 'R-SAL-03/P1',
        relation: 'journal_lines',
        mutation: 'INSERT a second revenue line of 1 minor unit on the invoice`s existing entry',
        breaks: 'the journal side exceeds the document side by 1',
        expectedFinding: 'R-SAL-03 names the invoice and the entry',
        rollback: 'ROLLBACK',
        realityNote:
          'a real line on a real posted entry; the plant runs as the owner because the journal is immutable to daftar_app, and that asymmetry is recorded rather than worked around',
      },
      {
        id: 'R-SAL-03/P2',
        relation: 'journal_lines',
        mutation: 'POST the same invoice`s revenue to 4100 (Sales Returns) instead of 4000 (Sales Revenue), keeping the entry perfectly balanced',
        breaks: 'nothing in the balance; everything in the account identity',
        expectedFinding:
          'R-SAL-03 reports the invoice, because the check reads the CODE and not merely the balance — this is the GOLD-28 defect, and an `it balances` check reports nothing here',
        rollback: 'ROLLBACK',
        realityNote:
          '4100 is a real account in the seeded chart (0040:60); the source-of-truth matrix once pinned revenue to it, which is why this plant is mandatory rather than decorative',
      },
    ],
    doesNotProve: 'that COGS is right; the cost side is R-INV-* and G-18',
  },
  {
    id: 'R-SAL-04',
    identity: '2200 = Σ(open refund liability); 2210 = Σ(customer-credit remainders)',
    domains: ['gl', 'refund-liability', 'customer-credit'],
    accounts: [ACCOUNT.customerRefundLiability, ACCOUNT.customerCreditLiability],
    relations: ['journal_lines', 'refunds', 'customer_credits', 'customer_credit_applications'],
    owedBy: 'P4-S5',
    grain: 'total',
    plants: [
      {
        id: 'R-SAL-04/P1',
        relation: 'customer_credits',
        mutation: 'UPDATE one credit`s remaining amount down by 1 minor unit without an application row',
        breaks: 'the document remainder falls below the 2210 balance',
        expectedFinding: 'R-SAL-04 reports 2210 off by 1 and names the credit',
        rollback: 'ROLLBACK',
        realityNote:
          '`customer_credits` is real since 0081; the credit carries two proportional halves (P4-AL-15/G-15) and the plant moves exactly one of them, which is the realistic drift',
      },
      {
        id: 'R-SAL-04/P2',
        relation: 'refunds',
        mutation: 'INSERT one open refund of 1 minor unit with no 2200 line behind it',
        breaks: 'the refund-liability document side exceeds the 2200 balance',
        expectedFinding: 'R-SAL-04 reports 2200 off by 1 and names the refund',
        rollback: 'ROLLBACK',
        realityNote:
          'NOT YET PERFORMABLE — `refunds` does not exist before P4-S5. This plant is declared and its check reports WAITING_FOR_INTEGRATED_SURFACE; planting it into a relation that does not exist would assert "no finding", which is the opposite of the proof',
      },
    ],
    doesNotProve: 'that a refund was authorized; authority is G-02 and the permission inventory, not an agreement of books',
  },
  {
    id: 'R-SAL-05',
    identity: 'tax payable = Σ(line tax) = 0 while P4-AL-44 holds — an identity that will still be true when it stops being zero',
    domains: ['gl'],
    accounts: [ACCOUNT.taxPayable],
    relations: ['journal_lines', 'invoice_items'],
    owedBy: 'P4-S2',
    grain: 'total',
    plants: [
      {
        id: 'R-SAL-05/P1',
        relation: 'journal_lines',
        mutation: 'INSERT a 2100 (Tax Payable) line of 1 minor unit on a real invoice entry, with the balancing line on 1100',
        breaks: 'the journal carries tax the documents do not',
        expectedFinding: 'R-SAL-05 reports 2100 non-zero against Σ(line tax) = 0 and names the entry',
        rollback: 'ROLLBACK',
        realityNote:
          '2100 is a real seeded account; `invoices.tax_minor` is pinned to 0 by `invoices_tax_policy_absent_ck` (0075:261), so the plant must move the JOURNAL, not the document — which is precisely why the identity is written as an equality of two sides rather than as `tax = 0`',
      },
    ],
    doesNotProve: 'that the structural zero is correct policy. OD-03 is OPEN; this check asserts the two sides agree, whatever the number becomes',
  },
  {
    id: 'R-SAL-06',
    identity: 'every installment plan: Σ instalments + down = invoice total; Σ collected ≤ total',
    domains: ['invoice-outstanding', 'ar'],
    accounts: [],
    relations: ['installment_plans', 'installments', 'invoices'],
    owedBy: 'P4-S7',
    grain: 'per-plan',
    plants: [
      {
        id: 'R-SAL-06/P1',
        relation: 'installments',
        mutation: 'UPDATE one instalment amount by +1 minor unit',
        breaks: 'Σ instalments + down exceeds the invoice total by 1',
        expectedFinding: 'R-SAL-06 names the plan and the instalment',
        rollback: 'ROLLBACK',
        realityNote: 'NOT YET PERFORMABLE — `installments` does not exist before P4-S7. Declared, and its check reports WAITING_FOR_INTEGRATED_SURFACE',
      },
      {
        id: 'R-SAL-06/P2',
        relation: 'installments',
        mutation: 'UPDATE collected amounts so Σ collected exceeds the plan total by 1 minor unit',
        breaks: 'the second, inequality half of the identity',
        expectedFinding: 'R-SAL-06 reports the over-collection; a check that only asserted the sum equality would report nothing',
        rollback: 'ROLLBACK',
        realityNote:
          'same relation, same slice. The two halves are planted separately because a single plant cannot break an equality and an inequality at once',
      },
    ],
    doesNotProve: 'that a due or late status is right; those are derived AS OF A SUPPLIED DATE (P4-AL-33) and are G-13`s subject',
  },
  {
    id: 'R-SAL-07',
    identity:
      'no journal entry bound to a Phase 4 source lacks its source row, and no source row lacks its entry — the bindings` own claim, re-asserted over data',
    domains: ['source-bindings', 'gl'],
    accounts: [],
    relations: ['accounting_source_bindings', 'journal_entries', 'sales', 'invoices', 'payments', 'payment_allocations', 'customer_credits'],
    owedBy: 'P4-S6',
    grain: 'per-entry',
    plants: [
      {
        id: 'R-SAL-07/P1',
        relation: 'accounting_source_bindings',
        mutation:
          'DELETE one binding row for a posted Phase 4 entry inside the transaction (deferred constraint triggers fire at COMMIT, so the plant is read BEFORE commit and then rolled back)',
        breaks: 'an entry bound to a Phase 4 source has no source row',
        expectedFinding: 'R-SAL-07 names the entry and the source type',
        rollback: 'ROLLBACK',
        realityNote:
          '`accounting_source_bindings` is real since 0046. The plant deliberately exercises the gap the DEFERRED binding FK leaves open mid-transaction, which is the window a check over data covers and a constraint does not',
      },
      {
        id: 'R-SAL-07/P2',
        relation: 'payments',
        mutation: 'INSERT a payment row with no entry and no binding',
        breaks: 'a source row with no entry — the other direction of the same claim',
        expectedFinding: 'R-SAL-07 names the orphan source row; a one-directional check reports nothing here',
        rollback: 'ROLLBACK',
        realityNote:
          '`payments` is real since 0081. `assertComplete()` allows the ZERO-posting case (RT-19, database.ts:488-495), so this direction is genuinely reachable and not a contrivance',
      },
    ],
    doesNotProve: 'that the entry`s lines are right; the shape is the goldens` subject',
  },
];

/** Every plant across every check, flattened — the discrepancy-injection inventory. */
export function allPlants(): readonly DiscrepancyPlant[] {
  return SALES_RECONCILIATION_CHECKS.flatMap((c) => c.plants);
}

/**
 * THE FRAMEWORK'S OWN LAWS, asserted over the table above.
 *
 * These are not checks on the product — the product half does not exist. They
 * are checks on THIS FILE, which is why they run unconditionally and have no
 * subject: a contract table that is internally inconsistent is a defect
 * available today.
 */
/*
 * The table is a PARAMETER with the real table as its default, for one reason:
 * a law that cannot be shown refusing a bad table is a law nobody has seen
 * work. `tests/guards/p4s89-framework-laws.test.ts` hands it a MUTATED copy of
 * the real table and requires the named refusal.
 */
export function frameworkSelfProblems(checks: readonly SalesReconciliationCheck[] = SALES_RECONCILIATION_CHECKS): string[] {
  const problems: string[] = [];
  const expected: readonly SalesReconciliationCheckId[] = ['R-SAL-01', 'R-SAL-02', 'R-SAL-03', 'R-SAL-04', 'R-SAL-05', 'R-SAL-06', 'R-SAL-07'];
  const ids = checks.map((c) => c.id);
  for (const id of expected) if (!ids.includes(id)) problems.push(`${id} is named by P4-AL-49 and is absent from this framework`);
  for (const id of ids) if (!expected.includes(id)) problems.push(`${id} is in this framework and is not one of P4-AL-49's seven — no third series`);

  const plantIds = new Set<string>();
  for (const check of checks) {
    if (check.plants.length === 0)
      problems.push(`${check.id}: no planted discrepancy, so it has never been shown able to be RED — a check with no red proof is a claim`);
    if (check.relations.length === 0) problems.push(`${check.id}: reads no relation, so nothing decides whether its subject is real`);
    if (check.domains.length === 0) problems.push(`${check.id}: declares no agreement domain, so no lifecycle stage can be mapped onto it`);
    for (const plant of check.plants) {
      if (plantIds.has(plant.id)) problems.push(`plant ${plant.id} is declared twice`);
      plantIds.add(plant.id);
      if (!check.relations.includes(plant.relation))
        problems.push(
          `plant ${plant.id} mutates ${plant.relation}, which ${check.id} does not read — a plant in a relation the check never looks at proves nothing`,
        );
      if (plant.expectedFinding.includes('names') === false && plant.expectedFinding.includes('reports') === false)
        problems.push(`plant ${plant.id}: its expected finding does not say what the check must NAME, so the proof could be satisfied by any red at all`);
    }
  }

  // Every agreement domain except `ap`, `inventory`, `cogs`, `cash-bank`,
  // `audit`, `outbox` and `reconciliation` must be covered by some R-SAL
  // check. Those seven are covered by R-INV-*, R-ACC-* and the lifecycle
  // scenario respectively — which is a statement this file has to make,
  // because a domain nobody claims is a domain nobody checks.
  const covered = new Set(checks.flatMap((c) => c.domains));
  const delegated: readonly AgreementDomain[] = ['ap', 'inventory', 'cogs', 'cash-bank', 'audit', 'outbox', 'reconciliation'];
  for (const domain of AGREEMENT_DOMAINS) {
    if (covered.has(domain)) continue;
    if (!delegated.includes(domain)) problems.push(`agreement domain ${domain} is covered by no R-SAL check and is not one of the delegated seven`);
  }
  return problems;
}
