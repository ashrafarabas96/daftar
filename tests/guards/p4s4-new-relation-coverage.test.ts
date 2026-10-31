/**
 * P4-S4 — THE RLS/FORCE DISCOVERY LAW AND G-3's VOCABULARY REACH THIS SLICE'S
 * RELATIONS AUTOMATICALLY, AND THAT IS VERIFIED HERE RATHER THAN ASSUMED.
 *
 * The slice adds four relations: the received-money document, its allocation
 * onto invoices, the customer credit, and the credit's application. Both
 * standing Phase 4 laws define their surface the same way —
 *
 *   `isPhase4Relation(t)` = *"the digest-verified inherited prefix did not
 *    create it"* (`scripts/guards/no-authoritative-balance.ts`)
 *
 * — so a relation this slice adds is judged the day its migration lands, by
 * BOTH halves of the RLS/FORCE discovery (the migration tree and the live
 * catalogue) and by G-3's Phase 4 arm, with no registration, no allowlist and
 * no exception. `handwrittenListProblems` refuses a written-down list
 * mechanically.
 *
 * That is a claim about this tree, and a claim nobody has executed is a
 * sentence in a document. So this suite proves, for the four relations the
 * BUILD CONTRACT commits the slice to:
 *
 *   1. the shared predicate ADMITS each of them (if it did not, both laws
 *      would skip the relation in silence, which is the one outcome nobody
 *      would notice);
 *   2. the DECLARED half discovers all four from a migration planted into a
 *      COPY of the migration tree — the real directory is never touched,
 *      because editing an applied migration breaks every suite with
 *      "Migration tampered after apply";
 *   3. the LIVE half discovers all four from catalogue rows, which is the
 *      half that sees a relation reaching a database by a route the text
 *      parser cannot read;
 *   4. `tenant_id`, `business_id`, `ENABLE` and `FORCE` are EACH required —
 *      one missing dimension is a P4-AL-08 violation, both missing is a
 *      declared global registry and red until the lock decides, and neither
 *      flag is a substitute for the other or for the columns;
 *   5. G-3's vocabulary applies to the four: a forbidden column on one of
 *      them is reported, a forbidden relation NAME is reported, and the
 *      accepted words the slice actually uses (`*_applied_*`, `*_released_*`,
 *      `*_dust_*`, `*_carrying_*`, `remaining_*`) are NOT — a rule with no
 *      not-a-finding case is a rule about a string.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`: every plant is applied
 * to a fixture or to a copy, is required to have changed the text, and is
 * undone by being discarded.
 *
 * The TEXT-level half of the law lives in `scripts/phase4-s4-gate.ts`
 * (`relationRlsTextProblems`, `vocabularyProblems`) and is what the gate runs
 * over every candidate migration on disk; the live half stays with
 * `tests/guards/phase4-rls-force-guard.test.ts`, which this suite does not
 * duplicate.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APPLIER_SOURCE,
  BUSINESS_COLUMN,
  LAW_MODULE,
  MIGRATIONS_SUBDIR,
  TENANT_COLUMN,
  type LiveRelation,
  declaredPhase4Relations,
  handwrittenListProblems,
  livePhase4Relations,
  phase4RlsForceReport,
} from '../../scripts/guards/phase4-rls-force';
import { discoverSalesTables, isPhase4Relation } from '../../scripts/guards/no-authoritative-balance';
import {
  CONTRACT_RELATIONS,
  PERMANENT_TENSE_NAMES,
  SELF,
  candidateMigrations,
  createTableBody,
  fenceDeletionProblems,
  fenceDeletionProblemsIn,
  newRelationCoverageProblems,
  relationRlsTextProblems,
  sliceMigrations,
  tenseFences,
  vocabularyProblems,
} from '../../scripts/phase4-s4-gate';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, MIGRATIONS_SUBDIR);
const APPLIER = readFileSync(join(REPO, APPLIER_SOURCE), 'utf8');
const LAW_SOURCE = readFileSync(join(REPO, LAW_MODULE), 'utf8');

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * A CONTRACT-SHAPED fixture for the four relations: the columns, flags and
 * grants the two laws judge, and nothing else. It is deliberately NOT the
 * slice's migration — that file is being written in another worktree — so this
 * suite states what the laws require of it rather than waiting for it, and the
 * gate applies the same functions to whatever candidate migration appears.
 *
 * The money columns use the accepted vocabulary on purpose: `*_applied_*`,
 * `*_released_*`, `*_dust_*`, `*_carrying_*`, `remaining_*`. They are the
 * not-a-finding case of the G-3 claims below.
 */
const RELATIONS_SQL = `
CREATE TABLE payments (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  customer_id UUID NOT NULL,
  payment_method_id UUID NOT NULL,
  posting_account_id UUID NOT NULL,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL,
  base_amount_minor BIGINT NOT NULL,
  payment_date DATE NOT NULL,
  intent_sha256 TEXT NOT NULL,
  CONSTRAINT payments_pk PRIMARY KEY (business_id, id)
);
CREATE TABLE payment_allocations (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  payment_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  line_no INTEGER NOT NULL,
  invoice_amount_applied_minor BIGINT NOT NULL,
  ar_released_before_txn_minor BIGINT NOT NULL,
  ar_released_minor BIGINT NOT NULL,
  ar_dust_minor BIGINT NOT NULL,
  CONSTRAINT payment_allocations_pk PRIMARY KEY (business_id, id),
  CONSTRAINT payment_allocations_invoice_fk FOREIGN KEY (business_id, invoice_id)
    REFERENCES invoices (business_id, id) ON DELETE RESTRICT
);
CREATE TABLE customer_credits (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  customer_id UUID NOT NULL,
  currency_code CHAR(3) NOT NULL,
  original_amount_minor BIGINT NOT NULL,
  remaining_minor BIGINT NOT NULL,
  remaining_carrying_minor BIGINT NOT NULL,
  CONSTRAINT customer_credits_pk PRIMARY KEY (business_id, id)
);
CREATE TABLE customer_credit_applications (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  credit_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  line_no INTEGER NOT NULL,
  invoice_amount_applied_minor BIGINT NOT NULL,
  ar_released_minor BIGINT NOT NULL,
  ar_dust_minor BIGINT NOT NULL,
  credit_dust_minor BIGINT NOT NULL,
  CONSTRAINT customer_credit_applications_pk PRIMARY KEY (business_id, id),
  CONSTRAINT customer_credit_applications_invoice_fk FOREIGN KEY (business_id, invoice_id)
    REFERENCES invoices (business_id, id) ON DELETE RESTRICT
);

REVOKE ALL ON payments FROM PUBLIC;
REVOKE ALL ON payment_allocations FROM PUBLIC;
REVOKE ALL ON customer_credits FROM PUBLIC;
REVOKE ALL ON customer_credit_applications FROM PUBLIC;

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_applications FORCE ROW LEVEL SECURITY;
`;

/** The migration number one past the head on disk. Derived, so this suite names no future file. */
function plantedMigrationName(): string {
  const head = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .slice(-1)[0];
  if (head === undefined) throw new Error('no migration on disk');
  return `${String(Number(head.slice(0, 4)) + 1).padStart(4, '0')}_planted.sql`;
}

/** A migrations directory that is the real one plus one further Phase 4 file. The real one is never touched. */
function migrationsPlus(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-cover-'));
  temporaries.push(dir);
  const migrations = join(dir, MIGRATIONS_SUBDIR);
  mkdirSync(migrations, { recursive: true });
  cpSync(MIGRATIONS, migrations, { recursive: true });
  writeFileSync(join(migrations, plantedMigrationName()), sql);
  return migrations;
}

/**
 * Catalogue rows for every relation `sql` declares, PLUS one row for every
 * Phase 4 relation the real migration tree already declares — both dimensions,
 * both flags. A catalogue holding only the four would make the law report every
 * accepted Phase 4 relation as DECLARED AND NOT APPLIED, and a plant whose
 * finding is indistinguishable from that noise proves nothing. With this
 * baseline the law is SILENT, so each plant below produces exactly its own
 * finding.
 */
function catalogueFor(sql: string): LiveRelation[] {
  const existing: LiveRelation[] = declaredPhase4Relations(MIGRATIONS, APPLIER).map((name) => ({
    name,
    kind: 'r',
    rowSecurity: true,
    forceRowSecurity: true,
    columns: [TENANT_COLUMN, BUSINESS_COLUMN],
  }));
  return [...existing.filter((r) => !discoverSalesTables(sql).includes(r.name)), ...declaredIn(sql)];
}

/** Catalogue rows for the relations one SQL text declares, with their real column names. */
function declaredIn(sql: string): LiveRelation[] {
  return discoverSalesTables(sql).map((name) => ({
    name,
    kind: 'r',
    rowSecurity: true,
    forceRowSecurity: true,
    columns: (createTableBody(sql, name) ?? '')
      .split('\n')
      .map((l) => /^\s*([a-z_][a-z0-9_]*)\s+(?:uuid|bigint|integer|text|date|char|numeric|timestamptz|boolean)/i.exec(l.trim())?.[1] ?? '')
      .filter((c) => c !== ''),
  }));
}

/** The problems naming `fragment`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], fragment: string): string[] => problems.filter((p) => p.includes(fragment));

const law = (live: readonly LiveRelation[] | null, migrationsDir: string): readonly string[] =>
  phase4RlsForceReport({ migrationsDir, applierSource: APPLIER, live }).problems;

// ─────────────────────────────────────────────────────────────────────────

describe('the shared Phase 4 predicate admits all four relations, with no registration', () => {
  it('each contract relation is outside the digest-verified inherited prefix, so both laws cover it', () => {
    expect(CONTRACT_RELATIONS.length).toBe(4);
    for (const name of CONTRACT_RELATIONS) expect(isPhase4Relation(name), `${name} is an inherited name and both Phase 4 laws would skip it`).toBe(true);
  });

  it('the guard’s own module still contains no relation name — the surface is DISCOVERED, never listed', () => {
    expect(handwrittenListProblems(LAW_SOURCE, CONTRACT_RELATIONS)).toEqual([]);
    expect(handwrittenListProblems(LAW_SOURCE, declaredPhase4Relations(MIGRATIONS, APPLIER))).toEqual([]);
  });
});

describe('both halves of the discovery find all four, automatically', () => {
  it('the DECLARED half discovers them from a migration planted into a copy of the tree', () => {
    const dir = migrationsPlus(RELATIONS_SQL);
    const declared = declaredPhase4Relations(dir, APPLIER);
    for (const name of CONTRACT_RELATIONS) expect(declared, `${name} was not discovered from the migration tree`).toContain(name);
    // Every relation the REAL tree declares is still discovered too: the
    // planted file adds subjects and removes none.
    for (const name of declaredPhase4Relations(MIGRATIONS, APPLIER)) expect(declared).toContain(name);
    // And the real directory was never written to — editing an applied
    // migration breaks every suite with "Migration tampered after apply".
    expect(readdirSync(MIGRATIONS)).not.toContain(plantedMigrationName());
  });

  it('the LIVE half discovers them from catalogue rows alone', () => {
    const live = declaredIn(RELATIONS_SQL);
    expect(live.length).toBe(4);
    expect(livePhase4Relations(live, APPLIER)).toEqual([...CONTRACT_RELATIONS].sort());
  });

  it('with both halves agreeing, the law is silent about all four and says it judged them', () => {
    const dir = migrationsPlus(RELATIONS_SQL);
    const live = catalogueFor(RELATIONS_SQL);
    const report = phase4RlsForceReport({ migrationsDir: dir, applierSource: APPLIER, live });
    // The baseline is SILENT, which is what makes every plant below readable:
    // a finding that cannot be told from background noise proves nothing.
    expect(report.problems).toEqual([]);
    for (const name of CONTRACT_RELATIONS) {
      expect(report.surface, `${name} is not on the discovered surface`).toContain(name);
      expect(report.judged, `${name} was discovered and not judged`).toContain(name);
      expect(about(report.problems, name), `${name} is correctly shaped and the law reported it anyway`).toEqual([]);
      expect(report.partition.tenantAndBusiness).toContain(name);
    }
  });
});

describe('RP-S4-RLS — each of the four requirements is PLANTED and named', () => {
  const dir = (): string => migrationsPlus(RELATIONS_SQL);
  const subject = 'payment_allocations';

  it('red: ROW LEVEL SECURITY not ENABLED on one of the four is named', () => {
    const live = catalogueFor(RELATIONS_SQL).map((r) => (r.name === subject ? { ...r, rowSecurity: false } : r));
    expect(about(law(live, dir()), subject).join('\n')).toContain('relrowsecurity is false');
  });

  it('red: FORCE lifted on one of the four is named — the owner would bypass every policy', () => {
    const live = catalogueFor(RELATIONS_SQL).map((r) => (r.name === subject ? { ...r, forceRowSecurity: false } : r));
    expect(about(law(live, dir()), subject).join('\n')).toContain('relforcerowsecurity is false');
  });

  it('red: a missing tenant_id is named as a P4-AL-08 violation, and ENABLE+FORCE is no substitute', () => {
    const live = catalogueFor(RELATIONS_SQL).map((r) => (r.name === subject ? { ...r, columns: r.columns.filter((c) => c !== TENANT_COLUMN) } : r));
    const problems = about(law(live, dir()), subject);
    expect(problems.join('\n')).toContain('P4-AL-08 violation');
    // Both flags are still true, and the relation is still refused.
    expect(problems.join('\n')).not.toContain('relrowsecurity is false');
  });

  it('red: a missing business_id is named the same way, in the other direction', () => {
    const live = catalogueFor(RELATIONS_SQL).map((r) => (r.name === subject ? { ...r, columns: r.columns.filter((c) => c !== BUSINESS_COLUMN) } : r));
    expect(about(law(live, dir()), subject).join('\n')).toContain('P4-AL-08 violation');
  });

  it('red: a relation of this slice carrying NEITHER dimension is red until the lock records a decision', () => {
    const live = catalogueFor(RELATIONS_SQL).map((r) =>
      r.name === subject ? { ...r, columns: r.columns.filter((c) => c !== TENANT_COLUMN && c !== BUSINESS_COLUMN) } : r,
    );
    expect(about(law(live, dir()), subject).join('\n')).toContain('GLOBAL REGISTRY');
  });

  it('red: a relation declared by the migration and absent from the catalogue is named, never silently dropped', () => {
    const live = catalogueFor(RELATIONS_SQL).filter((r) => r.name !== subject);
    expect(about(law(live, dir()), subject).join('\n')).toContain('DECLARED AND NOT APPLIED');
  });

  it('red: a relation in the catalogue that no migration declares is named — the completeness proof of the other half', () => {
    const live = [
      ...catalogueFor(RELATIONS_SQL),
      { name: `p4s4_canary_${process.pid}`, kind: 'r', rowSecurity: true, forceRowSecurity: true, columns: [TENANT_COLUMN, BUSINESS_COLUMN] },
    ];
    expect(about(law(live, dir()), `p4s4_canary_${process.pid}`).join('\n')).toContain('OMITS it');
  });
});

describe('the text-level half the gate runs over every candidate migration', () => {
  it('a contract-shaped text is accepted', () => {
    expect(relationRlsTextProblems(RELATIONS_SQL)).toEqual([]);
  });

  it('red: the ENABLE statement deleted from the text is named', () => {
    const sql = RELATIONS_SQL.replace('ALTER TABLE payments ENABLE ROW LEVEL SECURITY;\n', '');
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(relationRlsTextProblems(sql), 'never given ENABLE')).not.toEqual([]);
  });

  it('red: the FORCE statement deleted from the text is named', () => {
    const sql = RELATIONS_SQL.replace('ALTER TABLE customer_credits FORCE ROW LEVEL SECURITY;\n', '');
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(relationRlsTextProblems(sql), 'never given FORCE')).not.toEqual([]);
  });

  it('red: a relation never REVOKEd from PUBLIC is named', () => {
    const sql = RELATIONS_SQL.replace('REVOKE ALL ON payment_allocations FROM PUBLIC;\n', '');
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(relationRlsTextProblems(sql), 'never REVOKEd from PUBLIC')).not.toEqual([]);
  });

  it('red: a nullable RLS dimension is named — a row no policy constrains', () => {
    const sql = RELATIONS_SQL.replace('CREATE TABLE customer_credits (\n  tenant_id UUID NOT NULL,', 'CREATE TABLE customer_credits (\n  tenant_id UUID,');
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(relationRlsTextProblems(sql), 'is nullable')).not.toEqual([]);
  });

  it('red: a dimension column missing from the table body is named', () => {
    const sql = RELATIONS_SQL.replace(
      'CREATE TABLE payments (\n  tenant_id UUID NOT NULL,\n  business_id UUID NOT NULL,',
      'CREATE TABLE payments (\n  business_id UUID NOT NULL,',
    );
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(relationRlsTextProblems(sql), 'declares no tenant_id')).not.toEqual([]);
  });
});

describe('G-3’s vocabulary applies to all four relations', () => {
  it('the accepted words the slice uses are NOT findings — the rule has a not-a-finding case', () => {
    expect(vocabularyProblems(RELATIONS_SQL)).toEqual([]);
    const body = createTableBody(RELATIONS_SQL, 'payment_allocations') ?? '';
    // The claim above is about a text that really does carry the accepted
    // words, not about an empty table.
    for (const column of ['invoice_amount_applied_minor', 'ar_released_minor', 'ar_dust_minor']) expect(body).toContain(column);
    expect(createTableBody(RELATIONS_SQL, 'customer_credits') ?? '').toContain('remaining_carrying_minor');
  });

  it('red: a forbidden AP/AR word in a column on one of the four is named (G-3 / P4-AL-06)', () => {
    const sql = RELATIONS_SQL.replace(
      '  ar_dust_minor BIGINT NOT NULL,\n  CONSTRAINT payment_allocations_pk',
      '  ar_outstanding_minor BIGINT NOT NULL,\n  CONSTRAINT payment_allocations_pk',
    );
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(vocabularyProblems(sql), 'payment_allocations.ar_outstanding_minor')).not.toEqual([]);
  });

  it('red: a stored balance column on one of the four is named', () => {
    const sql = RELATIONS_SQL.replace('  remaining_minor BIGINT NOT NULL,', '  credit_balance_minor BIGINT NOT NULL,');
    expect(sql).not.toBe(RELATIONS_SQL);
    expect(about(vocabularyProblems(sql), 'customer_credits.credit_balance_minor')).not.toEqual([]);
  });

  it('red: a derived-truth RELATION name added beside the four is named', () => {
    const sql = `${RELATIONS_SQL}\nCREATE TABLE customer_receivables_summary (tenant_id UUID NOT NULL, business_id UUID NOT NULL);\n`;
    expect(about(vocabularyProblems(sql), 'customer_receivables_summary')).not.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('F12 — the coverage check reports ABSENCE as a finding, never as `ok`', () => {
  /**
   * A root holding every ACCEPTED migration byte for byte, plus whatever
   * candidate files the case plants. The accepted prefix has to be real or the
   * digest machinery refuses the root for an unrelated reason and the case
   * proves nothing.
   */
  function rootWithCandidates(candidates: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'p4s4-vacuity-'));
    temporaries.push(root);
    mkdirSync(join(root, MIGRATIONS_SUBDIR), { recursive: true });
    // EVERY candidate is withheld, and the set is DERIVED by the same
    // `candidateMigrations` the gate itself uses — not matched on a number
    // range. A literal range (`/^008[01]_/`) silently stopped withholding the
    // next candidate the moment one landed: the fake root then held a real
    // candidate, the "no candidate migration" case below was no longer the
    // case it claimed to be, and the law was measured against the wrong tree.
    // Deriving the set means it cannot drift again.
    const withheld = new Set(candidateMigrations(REPO));
    for (const f of readdirSync(MIGRATIONS)) {
      if (withheld.has(f)) continue; // the candidate files are what each case varies
      cpSync(join(MIGRATIONS, f), join(root, MIGRATIONS_SUBDIR, f));
    }
    mkdirSync(join(root, APPLIER_SOURCE, '..'), { recursive: true });
    writeFileSync(join(root, APPLIER_SOURCE), APPLIER);
    for (const [name, body] of Object.entries(candidates)) writeFileSync(join(root, MIGRATIONS_SUBDIR, name), body);
    return root;
  }

  it('the checkout’s own tree HAS the subject, so the laws below judged something', () => {
    expect(newRelationCoverageProblems(REPO)).toEqual([]);
  });

  it('red: a tree with NO candidate migration is refused — every relation law judged an empty set', () => {
    const problems = newRelationCoverageProblems(rootWithCandidates({}));
    expect(about(problems, 'reporting ABSENCE, not correctness'), `measured: ${JSON.stringify(problems)}`).not.toEqual([]);
    // and the finding NAMES what should have been discovered
    for (const name of CONTRACT_RELATIONS) expect(problems.join('\n')).toContain(name);
  });

  it('red: a candidate migration declaring NONE of the four is refused, however lawful it is in itself', () => {
    // This relation satisfies every property the laws assert — both RLS
    // dimensions, ENABLE, FORCE, REVOKE, a clean name. Before the fix the
    // check passed on it, because the properties held over a set containing
    // none of this slice's relations.
    const unrelated = [
      'CREATE TABLE unrelated_thing (',
      '  tenant_id UUID NOT NULL,',
      '  business_id UUID NOT NULL,',
      '  id UUID NOT NULL,',
      '  PRIMARY KEY (business_id, id)',
      ');',
      'ALTER TABLE unrelated_thing ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE unrelated_thing FORCE ROW LEVEL SECURITY;',
      'REVOKE ALL ON unrelated_thing FROM PUBLIC;',
      '',
    ].join('\n');
    const problems = newRelationCoverageProblems(rootWithCandidates({ '0081_unrelated.sql': unrelated }));
    expect(about(problems, 'declares none of'), `measured: ${JSON.stringify(problems)}`).not.toEqual([]);
    expect(problems.join('\n')).toContain('their silence is not evidence');
  });

  it('CONTRACT_RELATIONS is the derived subject and is non-empty — an empty contract would make the predicate law vacuous too', () => {
    expect(CONTRACT_RELATIONS.length).toBeGreaterThan(0);
  });
});

/**
 * THE ACCEPTANCE TRANSITION — the one tense no check in the gate ever runs in.
 *
 * Every check in `scripts/phase4-s4-gate.ts` executes while P4-S4 is a
 * CANDIDATE. The acceptance commit changes the tense, and the shape of the
 * file that makes that commit COMPILE was asserted by nothing: rehearsing the
 * seal on a scratch worktree produced fifteen TypeScript errors, because
 * `S4_ACCEPTED`, `candidateMigrations` and the `CHECKS` entry registering the
 * two candidate-only functions were all on the deleted side of the fence.
 * `fenceDeletionProblems` performs the deletion in memory and asks whether the
 * remainder still names what went; these cases plant each shape it must name.
 */
describe('P4-S4 — the acceptance commit leaves a tree that compiles (planted-defect proofs)', () => {
  const GATE = readFileSync(join(REPO, SELF), 'utf8');

  it('the shipped tree passes, and the law was watching something — two paired fences declaring names', () => {
    expect(fenceDeletionProblems(REPO)).toEqual([]);
    const { fences, problems } = tenseFences(GATE);
    expect(problems).toEqual([]);
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it('the permanent machinery is declared OUTSIDE every fence, which is what makes the deletion safe', () => {
    const { fences } = tenseFences(GATE);
    for (const name of PERMANENT_TENSE_NAMES) {
      const at = new RegExp(String.raw`export (?:function|const) ${name}\b`).exec(GATE);
      expect(at, `${name} must be declared somewhere`).not.toBeNull();
      const i = at?.index ?? -1;
      for (const f of fences) expect(i >= f.start && i < f.end, `${name} is inside a fenced region`).toBe(false);
    }
  });

  it('PLANTED: S4_ACCEPTED moved inside the fence is named twice — as read-outside and as permanent machinery', () => {
    const line = 'export const S4_ACCEPTED: Readonly<Record<string, string>> = {};\n';
    expect(GATE.split(line).length - 1, 'the declaration must appear exactly once').toBe(1);
    const open = /^[ \t]*\/\/ ─+ CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/m.exec(GATE);
    expect(open).not.toBeNull();
    const removed = GATE.replace(line, '');
    const openEnd = removed.indexOf(open?.[0] ?? '') + (open?.[0].length ?? 0);
    const planted = removed.slice(0, openEnd) + line + removed.slice(openEnd);
    expect(planted).not.toBe(GATE);
    const inside = tenseFences(planted).fences.some((f) => {
      const at = planted.indexOf(line);
      return at >= f.start && at < f.end;
    });
    expect(inside, 'the plant must actually land inside a fenced region').toBe(true);
    const problems = fenceDeletionProblemsIn(planted, {}).join('\n');
    expect(problems).toMatch(/S4_ACCEPTED is declared inside candidate-tense fenced region 1 and read outside it/);
    expect(problems).toMatch(/would delete the literal it had just filled/);
  });

  it('PLANTED: a fenced function read from outside is named with the line that reads it', () => {
    const renamed = GATE.replace(
      'export function candidateReport(root: string): string {',
      'export function candidateReportFenced(root: string): string {',
    ).replace('note: candidateReport,', 'note: candidateReportFenced,');
    expect(renamed).not.toBe(GATE);
    // A reference appended after everything is unambiguously outside every
    // fence, which is the defect's shape: a reader the deletion leaves behind.
    const planted = `${renamed}\nexport const theReaderLeftBehind = candidateReportFenced;\n`;
    const problems = fenceDeletionProblemsIn(planted, {}).join('\n');
    expect(problems).toMatch(/candidateReportFenced is declared inside candidate-tense fenced region 1 and read outside it/);
    // and the line it names is the reader's line, not the declaration's.
    const at = Number(/phase4-s4-gate\.ts:(\d+): candidateReportFenced/.exec(problems)?.[1] ?? '0');
    expect(planted.split('\n')[at - 1]).toContain('theReaderLeftBehind');
  });

  it('PLANTED: an unpaired fence is refused rather than silently halving the subject', () => {
    const planted = GATE.replace('// ───── end CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────\n', '');
    expect(planted).not.toBe(GATE);
    expect(fenceDeletionProblemsIn(planted, {}).join('\n')).toMatch(/fences are not paired — 2 opening marker\(s\) and 1 closing/);
  });

  it('PLANTED: a candidate tree with NO fence at all is refused — there would be nothing to delete', () => {
    const planted = GATE.replace(/^[ \t]*\/\/ ─+ (?:end )?CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm, '');
    expect(planted).not.toBe(GATE);
    expect(fenceDeletionProblemsIn(planted, {}).join('\n')).toMatch(/holds no candidate-tense fenced region at all/);
  });

  it('a fenced region that declares nothing is refused as a sweep over an empty set', () => {
    const empty =
      [
        '// ───── CANDIDATE-TENSE (P4-AL-61) ─────',
        '// prose only',
        '// ───── end CANDIDATE-TENSE (P4-AL-61) ─────',
        'export const S4_ACCEPTED = {};',
        'export function candidateMigrations() {}',
        'export function sliceMigrations() {}',
      ].join('\n') + '\n';
    expect(fenceDeletionProblemsIn(empty, {}).join('\n')).toMatch(/declare no exported name between them/);
  });

  it('in the ACCEPTED tense the absence of a fence is the correct verdict, not a finding — the forward-evolution trap', () => {
    const sealed = GATE.replace(/^[ \t]*\/\/ ─+ CANDIDATE-TENSE \(P4-AL-61\)[\s\S]*?^[ \t]*\/\/ ─+ end CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm, '');
    expect(sealed).not.toBe(GATE);
    expect(tenseFences(sealed).fences).toEqual([]);
    expect(fenceDeletionProblemsIn(sealed, { '0086_x.sql': 'deadbeef' })).toEqual([]);
    // and the same text in the CANDIDATE tense is a finding, so the tense is
    // doing the work and not the text alone.
    expect(fenceDeletionProblemsIn(sealed, {}).join('\n')).toMatch(/holds no candidate-tense fenced region at all/);
  });

  it('sliceMigrations is the ONE place the tense picks a subject, and both relation laws read it', () => {
    expect(typeof sliceMigrations).toBe('function');
    expect(sliceMigrations(REPO)).toEqual(candidateMigrations(REPO));
    const body = GATE.slice(GATE.indexOf('export function newRelationCoverageProblems'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('sliceMigrations(root)');
    const report = GATE.slice(GATE.indexOf('export function newRelationReport'));
    expect(report.slice(0, report.indexOf('\n}\n'))).toContain('sliceMigrations(root)');
  });
  it('the real gate calls candidateMigrations ONLY inside a fence or from sliceMigrations', () => {
    // The positional law, on the file as it is: silence here is the claim that
    // no permanent derivation will lose its subject when the slice is sealed.
    expect(fenceDeletionProblemsIn(GATE, {}).filter((p) => p.includes('candidateMigrations()'))).toEqual([]);
    // Non-vacuity: the call sites exist, so the law judged something.
    const sites = [...GATE.matchAll(/\bcandidateMigrations\s*\(/g)];
    expect(sites.length, 'candidateMigrations is never called, so the positional law judged nothing').toBeGreaterThan(1);
  });

  it('PLANTED: a permanent derivation that reads candidateMigrations is refused — the seal would empty its surface', () => {
    // This is the defect as it actually occurred. `evidenceCoverageProblems`
    // derived its surface from `candidateMigrations`, which names nothing once
    // the acceptance commit freezes every candidate, so seven findings fired
    // on the sealed tree from one empty set — and no gate run could ever have
    // seen it, because every check runs while the slice is a candidate.
    const planted = `${GATE}\nexport function aPermanentDerivation(root: string): string[] {\n  return candidateMigrations(root);\n}\n`;
    const problems = fenceDeletionProblemsIn(planted, {}).join('\n');
    expect(problems).toMatch(/candidateMigrations\(\) is called outside every candidate-tense fence and outside sliceMigrations/);
    expect(problems).toMatch(/derives an empty set in the sealed tree/);
    // And it points at the planted line, not at one of the legitimate ones.
    const at = Number(/phase4-s4-gate\.ts:(\d+): candidateMigrations/.exec(problems)?.[1]);
    expect(planted.split('\n')[at - 1]).toContain('return candidateMigrations(root);');
  });

  it('the positional law is about POSITION: the same call inside a fence is allowed, outside it is not', () => {
    // The identical text judged both ways, so the verdict is the fence and not
    // the call. A reader kept with the candidate tense is deleted with it and
    // can never empty anything.
    const inside = GATE.replace(
      '// ───── end CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────',
      'export function aCandidateOnlyReader(root: string): string[] {\n  return candidateMigrations(root);\n}\n// ───── end CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────',
    );
    expect(inside).not.toBe(GATE);
    expect(fenceDeletionProblemsIn(inside, {}).filter((p) => p.includes('candidateMigrations()'))).toEqual([]);
    const outside = `${GATE}\nexport function anAcceptedTenseReader(root: string): string[] {\n  return candidateMigrations(root);\n}\n`;
    expect(fenceDeletionProblemsIn(outside, {}).filter((p) => p.includes('candidateMigrations()'))).toHaveLength(1);
  });

  it('the measured-suite surface reads sliceMigrations, which is what made the sealed gate pass', () => {
    const body = GATE.slice(GATE.indexOf('export function measuredCandidateSuites'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('sliceMigrations(root)');
  });
});
