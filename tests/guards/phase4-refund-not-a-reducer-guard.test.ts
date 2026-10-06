/**
 * TL-P4-S5-R1 — A REFUND MUST NOT REDUCE INVOICE AR AGAIN
 * (the `refund-not-a-reducer` check of `scripts/phase4-s1-gate.ts`;
 * RP-REFUND-AR; lock `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-34, P4-AL-05;
 * `docs/PHASE_4_DECISION_REGISTER.md` TL-P4-S5-R1).
 *
 * ── THE RULING ────────────────────────────────────────────────────────────
 *
 * An invoice becomes a receivable, and an accepted REDUCER — a payment
 * allocation, a customer-credit application, a credit-note effect where
 * applicable — reduces that invoice receivable. ONCE. A later refund does not
 * reduce it a second time: it consumes the liability or right represented by a
 * credit note's or a customer credit's remaining value, and creates the
 * matching OUTWARD cash movement. Credit/return effect may reduce AR; a refund
 * must not reduce AR again.
 *
 * `scripts/phase4-s1-gate.ts` used to predict the opposite. Its
 * `SETTLEMENT_VOCABULARY` counted `refunds` among the relations whose
 * existence seam S-P4-03 requires `invoice_outstanding` to READ, which is the
 * double reduction P4-AL-34 forbids, written into an accepted gate as a
 * future obligation. P4-AL-34 is authoritative; the prediction was the defect.
 * The ruling removed the token, restated the concept as
 * `INVOICE_REDUCER_VOCABULARY`, and required this suite: a PERMANENT NEGATIVE
 * PROOF, so that removing a token from a regex is not the whole protection.
 *
 * ── WHY THE NEGATIVE PROOF IS A SEPARATE LAW ──────────────────────────────
 *
 * Narrowing the vocabulary only stops the gate from DEMANDING the second
 * reduction. It does not stop a later slice from writing it anyway, and the
 * ruling names the ways that was already attempted: making
 * `invoice_outstanding` read refunds, adding a dead SQL reference, or renaming
 * a refund relation to escape the vocabulary. So the law here is the opposite
 * shape of the seam: whatever a later slice creates and whatever it calls it,
 * no routine that reads the derived receivable may subtract a cash refund.
 *
 * It is a law about EXECUTABLE SQL SEMANTICS, never about prose. A comment
 * mentioning `refunds` must neither satisfy nor fail it — §C3 and §C4 below
 * plant exactly that, in all three comment forms, and require silence in one
 * direction and a finding in the other from the SAME text differing only in
 * whether the read is commented out.
 *
 * Nothing is planted into the real migrations directory. Every plant is a
 * COPY (`rootWith`), exactly as the deferred-seam proofs do it: `0075`-`0082`
 * are applied, and editing an applied migration breaks every suite with
 * "Migration tampered after apply".
 *
 * ── WHAT IS NOT HERE, AND WHY ─────────────────────────────────────────────
 *
 * The ruling also owes a LIVE financial double-reduction test: open a credit
 * invoice, make the accepted return/credit-note effect, verify AR falls
 * exactly once, refund the resulting liability, verify the invoice outstanding
 * does NOT fall again, and verify that cash and the liability do move. That
 * test cannot be written today and is not stubbed here. It needs three
 * relations the migration tree does not contain at any prefix — `refunds`,
 * `credit_notes` and `credit_note_applications` — and a test over relations
 * this suite created itself would prove the fixture, not the system. It is
 * recorded as owed by the P4-S5 implementation in
 * `docs/PHASE_4_DECISION_REGISTER.md` under TL-P4-S5-R1, with those three
 * absences as the measured reason.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INVOICE_REDUCER_VOCABULARY,
  RECEIVABLE_READER_VOCABULARY,
  REFUND_VOCABULARY,
  mentionsRefundRelation,
  deferredSeamProblems,
  invoiceReducerProblems,
  phase4Migrations,
  phase4RoutineBody,
  phase4Sql,
  readTables,
  stripSql,
} from '../../scripts/phase4-s1-gate';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const temporaries: string[] = [];

/**
 * A root whose migrations directory is the real one plus `planted` as a
 * further Phase 4 migration. `9999_` keeps the plant LAST whatever the tree
 * grows, because the law reads the last definition of a routine — the one the
 * database ends up holding. A plant numbered under the head would silently
 * stop being the body under test the day a real migration after it replaced
 * the routine, which already cost three proofs in P4-S4.
 */
function rootWith(planted: string, name = '9999_planted.sql'): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-refund-'));
  temporaries.push(root);
  const dir = join(root, 'infrastructure/database/migrations');
  mkdirSync(dir, { recursive: true });
  cpSync(MIGRATIONS, dir, { recursive: true });
  writeFileSync(join(dir, name), planted);
  writeFileSync(
    join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
    readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
  );
  return root;
}

/** The refund relation as P4-S5 will design it: paid out of a credit, naming no invoice. */
const REFUNDS = `
  CREATE TABLE refunds (
    tenant_id UUID NOT NULL,
    business_id UUID NOT NULL,
    id UUID NOT NULL,
    customer_credit_id UUID,
    credit_note_id UUID,
    amount_txn_minor BIGINT NOT NULL,
    PRIMARY KEY (business_id, id)
  );
`;

/**
 * A replacement `invoice_outstanding` whose body is `body`. The signature and
 * the return shape are the tree's, so what differs between a planted RED and
 * a planted GREEN below is only the arithmetic — which is the point: the law
 * must be about the read, not about the shape of the plant.
 */
const outstandingReading = (body: string): string => `
  CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
  RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
  LANGUAGE sql STABLE AS $$
${body}
  $$;
`;

/** The reducer relations the tree itself creates, discovered — never listed here. */
const reducerRelations = (root: string): string[] =>
  readTables(phase4Sql(root))
    .tables.map((t) => t.name)
    .filter((n) => INVOICE_REDUCER_VOCABULARY.test(n))
    .sort();

/** The receivable readers the Phase 4 DDL defines, discovered by the same vocabulary the law uses. */
const receivableReaders = (root: string): string[] =>
  [
    ...new Set(
      [...phase4Sql(root).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)]
        .map((m) => (m[1] ?? '').toLowerCase())
        .filter((n) => RECEIVABLE_READER_VOCABULARY.test(n)),
    ),
  ].sort();

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe('§A the law has a subject, and the tree satisfies it for a reason', () => {
  it('the tree as it stands is silent, and the silence is a judgement over real receivable readers', () => {
    const readers = receivableReaders(REPO);
    expect(readers.length, 'the Phase 4 DDL defines no receivable reader, so this law would have no subject').toBeGreaterThan(0);
    for (const name of readers) expect(phase4RoutineBody(REPO, name), `${name} has a body the law can read`).not.toBeNull();
    expect(invoiceReducerProblems(REPO)).toEqual([]);
  });

  it('both halves of the identity hold in the tree at once: every reducer is read, and no refund is', () => {
    // The seam demands the first reduction; this law refuses the second. The
    // tree must satisfy both, and the two are asserted together so that a
    // slice cannot buy one by giving up the other.
    const reducers = reducerRelations(REPO);
    expect(reducers.length, 'the tree creates no reducer at all, so the paired claim would be vacuous').toBeGreaterThan(0);
    expect(deferredSeamProblems(REPO)).toEqual([]);
    const executable = phase4RoutineBody(REPO, 'invoice_outstanding') ?? '';
    for (const name of reducers) expect(new RegExp(`\\b${name}\\b`).test(executable), `invoice_outstanding reads ${name}`).toBe(true);
    expect(mentionsRefundRelation(executable), 'and reads no refund relation').toBe(false);
  });

  it('a tree with no Phase 4 DDL is silent, and a tree with DDL but no receivable reader is NOT', () => {
    // NOT-YET-APPLICABLE IS NOT A PASS. The one state in which this law has
    // nothing to say is a tree in which the receivable does not exist; a tree
    // that has Phase 4 DDL and no reader of the receivable is a defect, not an
    // abstention.
    const bare = mkdtempSync(join(tmpdir(), 'p4-refund-bare-'));
    temporaries.push(bare);
    mkdirSync(join(bare, 'infrastructure/database/migrations'), { recursive: true });
    expect(invoiceReducerProblems(bare)).toEqual([]);

    const noReader = mkdtempSync(join(tmpdir(), 'p4-refund-noreader-'));
    temporaries.push(noReader);
    const dir = join(noReader, 'infrastructure/database/migrations');
    mkdirSync(dir, { recursive: true });
    cpSync(MIGRATIONS, dir, { recursive: true });
    writeFileSync(
      join(noReader, 'infrastructure/database/MIGRATION_MANIFEST.json'),
      readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
    );
    // Every Phase 4 migration that defines a receivable reader is removed —
    // DISCOVERED, so no migration number is written here.
    const definers = phase4Migrations(noReader).filter((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      return [...text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)].some((m) =>
        RECEIVABLE_READER_VOCABULARY.test((m[1] ?? '').toLowerCase()),
      );
    });
    expect(definers, 'no Phase 4 migration defines a receivable reader, so removing them proves nothing').not.toEqual([]);
    for (const f of definers) rmSync(join(dir, f));
    expect(receivableReaders(noReader)).toEqual([]);
    const problems = invoiceReducerProblems(noReader);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('no subject');
  });
});

describe('§B the vocabulary a refund relation cannot be renamed out of', () => {
  it('the refund vocabulary covers the shapes a refund relation will be given, and nothing a reducer is called', () => {
    for (const name of ['refunds', 'refund_allocations', 'refund_applications', 'invoice_refunds', 'credit_note_refunds', 'customer_credit_refunds'])
      expect(mentionsRefundRelation(name), `${name} is a refund relation`).toBe(true);
    // A reducer is not a refund, in either direction: the two vocabularies are
    // disjoint, so no relation can be demanded by the seam and refused by this
    // law at the same time.
    for (const name of [
      'payment_allocations',
      'allocation_reversals',
      'payment_reversals',
      'credit_notes',
      'credit_note_applications',
      'customer_credit_applications',
      'customer_credits',
      'invoice_write_offs',
      'invoices',
      'invoice_items',
      'customers',
      'sales',
    ]) {
      expect(mentionsRefundRelation(name), `${name} is not a refund relation`).toBe(false);
      if (INVOICE_REDUCER_VOCABULARY.test(name)) expect(mentionsRefundRelation(name)).toBe(false);
    }
    expect(INVOICE_REDUCER_VOCABULARY.test('refunds'), 'a refund is not a reducer of the invoice receivable (P4-AL-34)').toBe(false);
  });

  it('the supplier exclusion is load-bearing: the purchase side of the estate really carries refund relations, and this law is about the CUSTOMER receivable', () => {
    // NON-VACUITY FIRST. The exclusion is only worth a law because the tree
    // genuinely contains purchase-side refund relations. Derived from the
    // migrations, never from a list here, so a purchase-side name a later
    // slice adds is covered without this file being edited.
    const identifiers = new Set<string>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')))
      for (const token of readFileSync(join(MIGRATIONS, file), 'utf8').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        if (REFUND_VOCABULARY.test(token)) identifiers.add(token.toLowerCase());
    const purchaseSide = [...identifiers].filter((name) => /(^|_)(supplier|suppliers|purchase|purchases|vendor|vendors)(_|$)/i.test(name)).sort();
    expect(purchaseSide, 'the tree carries no purchase-side refund name, so excluding one proves nothing').not.toEqual([]);

    // THE RED PROOF. The device WITHOUT the exclusion — the whole rule minus
    // the one clause — refuses every one of those real names. That is the
    // false red the exclusion exists to prevent: a routine of the purchase
    // ledger refused by a law about the sales receivable.
    const withoutTheExclusion = (text: string): boolean => (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((token) => REFUND_VOCABULARY.test(token));
    for (const name of purchaseSide) {
      expect(withoutTheExclusion(name), `${name} IS refund vocabulary, which is why the exclusion is needed`).toBe(true);
      expect(mentionsRefundRelation(name), `${name} is the purchase ledger, not the customer receivable`).toBe(false);
    }

    // And the exclusion is a TOKEN rule, so it narrows the law by exactly one
    // ledger and not by a spelling: a customer refund relation does not escape
    // this law by carrying the purchase vocabulary as a SUBSTRING.
    for (const name of ['refunds_supplierish', 'refund_purchased', 'vendorless_refunds'])
      expect(mentionsRefundRelation(name), `${name} is a customer refund relation with a purchase-looking substring`).toBe(true);

    // The same holds inside free text, which is where the law is actually
    // applied: a purchase-side read is silent, a customer-side read is not.
    expect(mentionsRefundRelation('SELECT amount FROM public.supplier_refunds WHERE id = p_id')).toBe(false);
    expect(mentionsRefundRelation('SELECT amount FROM public.refunds WHERE id = p_id')).toBe(true);
  });

  it('the receivable-reader vocabulary finds the tree’s readers by what they are CALLED, not by a list', () => {
    const readers = receivableReaders(REPO);
    // The family is discovered; this asserts the discovery has the SHAPE a
    // receivable reader has, so a reader added by a later slice is covered
    // without this file being edited.
    for (const name of readers) expect(RECEIVABLE_READER_VOCABULARY.test(name)).toBe(true);
    expect(RECEIVABLE_READER_VOCABULARY.test('invoice_outstanding')).toBe(true);
    expect(RECEIVABLE_READER_VOCABULARY.test('customer_ar_outstanding')).toBe(true);
    for (const name of ['sale_commit', 'payment_complete', 'customer_apply_credit', 'invoices_no_delete'])
      expect(RECEIVABLE_READER_VOCABULARY.test(name), `${name} does not read the receivable`).toBe(false);
  });
});

describe('§C the planted defects — direction C of TL-P4-S5-R1', () => {
  it('RED C: a direct `refunds` subtraction planted into invoice_outstanding', () => {
    const planted = `${REFUNDS}${outstandingReading(`    SELECT 0::BIGINT, 0::BIGINT,
           i.total_txn_minor - coalesce((SELECT sum(r.amount_txn_minor) FROM public.refunds r WHERE r.business_id = i.business_id), 0)::BIGINT,
           0::BIGINT
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.id = p_invoice_id`)}`;
    const root = rootWith(planted);
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('invoice_outstanding');
    expect(problems[0]).toContain('refunds');
    expect(problems[0]).toContain('reduces invoice AR a second time');
  });

  it('RED C: a renamed refund relation does not escape — the law is about the vocabulary, not the one token the ruling removed', () => {
    // One of the ways the ruling explicitly refused to make the gate green was
    // renaming `refunds`. A reader that subtracts `invoice_refunds` is the same
    // second reduction under a different name.
    const planted = `
      CREATE TABLE invoice_refunds (
        tenant_id UUID NOT NULL,
        business_id UUID NOT NULL,
        id UUID NOT NULL,
        amount_txn_minor BIGINT NOT NULL,
        PRIMARY KEY (business_id, id)
      );
      ${outstandingReading(`    SELECT 0::BIGINT, 0::BIGINT,
           i.total_txn_minor - coalesce((SELECT sum(r.amount_txn_minor) FROM public.invoice_refunds r WHERE r.business_id = i.business_id), 0)::BIGINT,
           0::BIGINT
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.id = p_invoice_id`)}`;
    const problems = invoiceReducerProblems(rootWith(planted));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('invoice_refunds');
  });

  it('RED C: a DEAD reference is a read — a reader that names a refund relation at all is refused', () => {
    // The other refused shortcut: a reference that changes no arithmetic,
    // added so a grep for the relation succeeds. It is still executable SQL
    // naming a refund inside the receivable reader, and the law says no.
    const planted = `${REFUNDS}${outstandingReading(`    SELECT 0::BIGINT, 0::BIGINT, i.total_txn_minor, 0::BIGINT
      FROM public.invoices i
      LEFT JOIN public.refunds r ON FALSE
     WHERE i.business_id = p_business_id AND i.id = p_invoice_id`)}`;
    const problems = invoiceReducerProblems(rootWith(planted));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('refunds');
  });

  it('RED C: a reader OTHER than invoice_outstanding subtracts a refund — the family is discovered, so it is caught too', () => {
    // The law is not aimed at one routine name. Any routine the receivable
    // reader vocabulary finds is subject to it, which is what makes it outlive
    // this slice.
    const planted = `${REFUNDS}
      CREATE OR REPLACE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID)
      RETURNS TABLE (outstanding_txn_minor BIGINT) LANGUAGE sql STABLE AS $$
        SELECT coalesce(sum(r.amount_txn_minor), 0)::BIGINT FROM public.refunds r WHERE r.business_id = p_business_id;
      $$;
    `;
    const problems = invoiceReducerProblems(rootWith(planted));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('customer_ar_outstanding');
    expect(problems[0]).toContain('refunds');
  });

  it('NOT A FINDING C: the same plant with the subtraction COMMENTED OUT — a comment mentioning `refunds` does not fail the law', () => {
    // The pair of the first RED above, differing only in whether the read is
    // executable. Both of SQL's comment forms are planted at once — a block
    // comment and a `--` line comment — and both name a refund relation in the
    // exact shape the law refuses, including a URL, so the prose stripping is
    // exercised and not merely trusted.
    const prose = `    /* TL-P4-S5-R1: a refund settles the credit note it is paid out of.
       It must never be subtracted here: that would reduce invoice AR twice.
       The shape this file must never contain is
       \`- (SELECT sum(x.amount_txn_minor) FROM public.refunds x)\`.
       See docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-34: https://example.invalid/refunds */
    -- and not from public.refunds either, nor from public.invoice_refunds
    SELECT 0::BIGINT, 0::BIGINT, i.total_txn_minor, 0::BIGINT
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.id = p_invoice_id`;
    // The prose really does name a refund relation — otherwise this test would
    // pass for want of a subject.
    expect(mentionsRefundRelation(prose), 'the planted prose does mention refund relations').toBe(true);
    const root = rootWith(`${REFUNDS}${outstandingReading(prose)}`);
    // …and it is gone, in both comment forms, by the time the law looks.
    const body = phase4RoutineBody(root, 'invoice_outstanding') ?? '';
    expect(body).not.toMatch(/--|\/\*/);
    expect(mentionsRefundRelation(body)).toBe(false);
    expect(invoiceReducerProblems(root)).toEqual([]);
  });

  it('NOT A FINDING C: a comment cannot SATISFY the law either — commenting the read out of a real defect is not a fix', () => {
    // The law is one-directional by construction: prose is removed before it
    // looks, so a comment neither fails nor satisfies it. The proof is that the
    // SAME text is red with the read executable and green with the read
    // commented out, and nothing else about it changes.
    const read = `    SELECT 0::BIGINT, 0::BIGINT,
           i.total_txn_minor - coalesce((SELECT sum(r.amount_txn_minor) FROM public.refunds r WHERE r.business_id = i.business_id), 0)::BIGINT,
           0::BIGINT
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.id = p_invoice_id`;
    const live = rootWith(`${REFUNDS}${outstandingReading(read)}`);
    const dead = rootWith(
      `${REFUNDS}${outstandingReading(`${read
        .split('\n')
        .map((l) => `    -- ${l.trim()}`)
        .join('\n')}
    SELECT 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT`)}`,
      '9999_planted_dead.sql',
    );
    expect(invoiceReducerProblems(live)).toHaveLength(1);
    expect(invoiceReducerProblems(dead)).toEqual([]);
  });

  it('the prose stripping this law stands on is the gate’s own `stripSql`, and it really removes both SQL comment forms', () => {
    // The law never strips anything itself: `phase4Sql` applies `stripSql` to
    // every migration before any check in the gate sees one, which is why a
    // comment can neither fail this law nor satisfy it. A second stripper
    // beside it would be a second truth, so the property is ASSERTED here
    // against the device that actually provides it.
    const sql = [
      '  /* FROM public.refunds commented */',
      '  SELECT a.amount -- FROM public.invoice_refunds commented',
      '  FROM public.payment_allocations a WHERE a.id = p_id',
    ].join('\n');
    const out = stripSql(sql);
    expect(mentionsRefundRelation(sql), 'the fixture does name refund relations, in comments only').toBe(true);
    expect(mentionsRefundRelation(out), 'and no comment survives the gate’s stripping device').toBe(false);
    expect(out).toContain('public.payment_allocations');
    expect(out).toContain('a.id = p_id');
    // And the bodies the law reads really do arrive prose-free, which is the
    // precondition it asserts for itself rather than assuming.
    for (const name of receivableReaders(REPO)) expect(phase4RoutineBody(REPO, name) ?? '').not.toMatch(/--|\/\*/);
  });

  it('RED C: if the prose stripping stops being in force, the law reports THAT instead of reading a sentence as SQL', () => {
    // The precondition is a claim, so it has its own red: a body that reaches
    // the law with a comment marker still in it is refused outright. A dollar
    // quote inside a comment is what makes `stripSql` leave one behind, which
    // is also exactly the shape that would let prose be read as SQL.
    const planted = outstandingReading(`    SELECT 0::BIGINT, 0::BIGINT, i.total_txn_minor, 0::BIGINT
      FROM public.invoices i /* an unterminated block comment leaves its marker: $$;
     WHERE i.business_id = p_business_id`);
    const root = rootWith(planted);
    const body = phase4RoutineBody(root, 'invoice_outstanding') ?? '';
    expect(body, 'the plant really does reach the law with a comment marker in it').toMatch(/--|\/\*/);
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('comment marker');
  });
});

/**
 * §E THE AMPUTATION — TL-P4-S5-R1's correction to the gate's SQL comment
 * stripping, and the two measurements that show it was a FALSE GREEN.
 *
 * `stripSql` used to be two blind passes, `/* … *\/` then `--[^\n]*`, neither
 * of which knew what a string literal was. A `--` or a `/*` INSIDE a literal
 * was therefore read as the start of a comment, and everything after it
 * vanished from every check in the gate — `phase4Sql` applies the device to
 * every migration before any check sees one. On TL-P4-S5-R1 that is not a
 * cosmetic loss: a refund read sitting after such a literal is simply not
 * there any more, and the law reports nothing while the second reduction is
 * live in the database.
 *
 * The fix is literal-AWARE stripping, not literal blanking: several P4-S1 laws
 * search for the content inside a literal (a refusal code, a registered source
 * type, a role name), so a device that blanked them would make those checks
 * stop seeing what they exist to see. §E3 pins that down so the next reader
 * cannot "simplify" this into blanking.
 *
 * Each proof below states BOTH measurements over the same planted text: what
 * the blind device returns, and what the literal-aware one returns.
 */
describe('§E a literal containing a comment marker no longer amputates the line (TL-P4-S5-R1)', () => {
  /** The device as it was: two blind passes, neither literal-aware. Reproduced here, not imported, because it is gone from the gate. */
  const blindStrip = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');

  /**
   * A reader whose refund read sits AFTER a literal, ON THE SAME LINE as the
   * comment marker the literal contains. That placement is the whole defect:
   * the blind `--` pass cut from the marker to the end of the line, so the
   * subtraction that followed it was not in the text any check was given.
   */
  const readAfterLiteral = (literal: string): string =>
    `    SELECT 0::BIGINT, 0::BIGINT, (SELECT i.total_txn_minor FROM public.invoices i WHERE i.memo <> ${literal} AND i.business_id = p_business_id AND i.id = p_invoice_id) - coalesce((SELECT sum(r.amount_txn_minor) FROM public.refunds r WHERE r.business_id = p_business_id), 0)::BIGINT, 0::BIGINT`;

  it('RED E1: a literal holding `--` earlier on the line no longer hides the refund read that follows it', () => {
    const routine = outstandingReading(readAfterLiteral("'-- not a comment'"));
    // Both measurements are taken over the ROUTINE, which is what the law
    // reads. Taking them over the whole planted file would be a measurement
    // about the `CREATE TABLE refunds` beside it, which no device removes.
    // MEASUREMENT 1 — the blind device: the refund read is GONE, cut away with
    // the rest of its line, so the law would have been green while the second
    // reduction was live in the database. This is the false green.
    const blind = blindStrip(routine);
    expect(blind).not.toContain('public.refunds');
    expect(mentionsRefundRelation(blind), 'the blind device loses the refund read entirely — this is the false green').toBe(false);
    // MEASUREMENT 2 — the literal-aware device: the read is there, and the
    // literal is still there too, byte for byte.
    const aware = stripSql(routine);
    expect(mentionsRefundRelation(aware), 'the literal-aware device sees the refund read').toBe(true);
    expect(aware).toContain('public.refunds');
    expect(aware, 'and the literal survives unchanged').toContain("'-- not a comment'");
    // And the law itself is RED on it.
    const problems = invoiceReducerProblems(rootWith(`${REFUNDS}${routine}`));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('refunds');
  });

  it('RED E2: a literal holding `/*` no longer swallows everything up to the next real block comment', () => {
    // The block-comment half of the same defect, and it is worse than the line
    // half: the blind pass looked for the next `*/` ANYWHERE, so a literal
    // containing `/*` swallowed every line between it and the next genuine
    // block comment — and a migration in this tree is full of those. The plant
    // carries one after the routine, which is what a real file looks like.
    const routine = `${outstandingReading(readAfterLiteral("'/* not a comment'"))}
      /* The end-state note a migration of this tree carries after its routine. */
    `;
    // MEASUREMENT 1 — the blind device swallows across lines and the refund
    // read goes with it.
    const blind = blindStrip(routine);
    expect(blind).not.toContain('public.refunds');
    expect(mentionsRefundRelation(blind), 'the blind device loses the refund read across lines — the same false green').toBe(false);
    // MEASUREMENT 2 — the literal-aware device keeps the read and the literal,
    // and still removes the genuine block comment that follows.
    const aware = stripSql(routine);
    expect(mentionsRefundRelation(aware)).toBe(true);
    expect(aware).toContain("'/* not a comment'");
    expect(aware).not.toContain('The end-state note');
    const problems = invoiceReducerProblems(rootWith(`${REFUNDS}${routine}`, '9999_planted_block.sql'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('refunds');
  });

  it('E3: literals are kept BYTE FOR BYTE, never blanked — every refusal code the Phase 4 DDL raises survives the strip', () => {
    /**
     * The guard against the "simplification" that would blank literals instead
     * of reading them. Several P4-S1 laws search INSIDE a literal, so a device
     * that emptied them would make those checks stop finding their subject —
     * silently, and greenly.
     *
     * The codes are DISCOVERED from the raw migration text, not listed here:
     * the day a slice adds a refusal code, this proof covers it without being
     * edited.
     */
    const raw = phase4Migrations(REPO)
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    const codes = [...new Set([...raw.matchAll(/'([a-z_]+\.[a-z_]+):/g)].map((m) => m[1] ?? ''))].sort();
    expect(codes.length, 'the Phase 4 DDL raises no refusal code at all, so this proof would be vacuous').toBeGreaterThan(10);
    const stripped = phase4Sql(REPO);
    for (const code of codes) expect(stripped, `the refusal code '${code}' must survive the strip`).toContain(`'${code}:`);
    // And a literal is returned unchanged even when it is nothing but a
    // comment marker — the narrowest case of the same rule.
    expect(stripSql("SELECT '--', '/*', '*/' FROM t -- gone")).toBe("SELECT '--', '/*', '*/' FROM t ");
    // A doubled quote is how SQL escapes one, so it does not end the literal.
    expect(stripSql("SELECT 'it''s -- fine' FROM t")).toBe("SELECT 'it''s -- fine' FROM t");
    // An apostrophe INSIDE a comment is part of the comment, not the start of
    // a literal: the comment's marker is always to the left of its own text.
    expect(stripSql("SELECT a FROM t -- don't read this\nSELECT b FROM u")).toBe('SELECT a FROM t \nSELECT b FROM u');
  });

  it('NOT A FINDING E: a legitimate reader whose literal contains `--` is not refused as prose', () => {
    // The other half of literal-awareness, in the law itself: the prose-free
    // precondition looks for a comment marker OUTSIDE literals, so a routine
    // that genuinely compares against `'--'` is a routine and not a leftover
    // comment. Without that, the fix above would have turned every such
    // reader red — trading a false green for a false red.
    const planted = outstandingReading(`    SELECT 0::BIGINT, 0::BIGINT, i.total_txn_minor, 0::BIGINT
      FROM public.invoices i
     WHERE i.memo <> '-- not a comment' AND i.memo <> '/* nor this */' AND i.business_id = p_business_id AND i.id = p_invoice_id`);
    const root = rootWith(planted, '9999_planted_literal.sql');
    const body = phase4RoutineBody(root, 'invoice_outstanding') ?? '';
    expect(body, 'the literals really do reach the law with their markers intact').toContain("'-- not a comment'");
    expect(invoiceReducerProblems(root)).toEqual([]);
  });

  it('E4: the real tree is unchanged in the one way that matters — every reader still arrives prose-free and refund-free', () => {
    // The device changed for every check in the gate, so the property
    // TL-P4-S5-R1 stands on is re-asserted against the real tree under it.
    for (const name of receivableReaders(REPO)) {
      const body = phase4RoutineBody(REPO, name) ?? '';
      expect(body, `${name} arrives with no comment marker`).not.toMatch(/--|\/\*/);
      expect(mentionsRefundRelation(body), `${name} reads no refund relation`).toBe(false);
    }
    expect(invoiceReducerProblems(REPO)).toEqual([]);
  });
});

describe('§D the discovered stripper of the S-P4-03 red proof is kept (commit 479110f)', () => {
  it('every TRUE reducer the tree creates is actually removed from the planted copy the S-P4-03 red proof uses', () => {
    /**
     * The S-P4-03 red proof plants the ABSENCE of the discharge by rewriting
     * the reader's `FROM public.<reducer>` clauses on a COPY, and it builds
     * that rewrite FROM THE DISCOVERED REDUCER SET rather than from a
     * handwritten literal. The Tech Lead accepted that approach and forbade
     * reverting it, because a proof whose discovery half is hard-coded goes
     * quietly vacuous the day the tree grows a reducer.
     *
     * This is the independent check of that property, from outside the proof
     * that relies on it: build the same discovered stripper, apply it to a
     * copy, and require that NO reducer the tree creates is still read — while
     * the relations themselves are still created, so the seam keeps its
     * subject.
     */
    const reducers = reducerRelations(REPO);
    expect(reducers.length, 'the tree creates no reducer, so there is nothing for the stripper to discover').toBeGreaterThan(0);
    const stripper = new RegExp(`FROM public\\.(?:${reducers.join('|')}) \\w+`, 'g');
    const root = mkdtempSync(join(tmpdir(), 'p4-refund-strip-'));
    temporaries.push(root);
    const dir = join(root, 'infrastructure/database/migrations');
    mkdirSync(dir, { recursive: true });
    cpSync(MIGRATIONS, dir, { recursive: true });
    writeFileSync(
      join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
      readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
    );
    const carriers = phase4Migrations(root).filter((f) => new RegExp(stripper.source, 'g').test(readFileSync(join(dir, f), 'utf8')));
    expect(carriers, 'no Phase 4 migration reads a reducer in the form the stripper covers').not.toEqual([]);
    for (const f of carriers) {
      const before = readFileSync(join(dir, f), 'utf8');
      const after = before.replace(new RegExp(stripper.source, 'g'), 'FROM public.invoices x');
      expect(after === before, `${f}: the strip changed nothing`).toBe(false);
      writeFileSync(join(dir, f), after);
    }
    // The relations survive — so the seam still has a subject…
    expect(reducerRelations(root)).toEqual(reducers);
    // …and not one of them is read any more, which is the property the
    // discovered stripper exists to guarantee.
    for (const name of reducers)
      expect(
        new RegExp(`FROM public\\.${name} \\w+`).test(phase4Sql(root)),
        `${name} is still read after the discovered strip — this tree reads it in a form the stripper does not cover`,
      ).toBe(false);
    // And the seam speaks, naming every one of them.
    const problems = deferredSeamProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-03');
    for (const name of reducers) expect(problems[0]).toContain(name);
    // The refund law is unaffected by the strip: it never depended on the
    // reducers being read, only on no refund being read.
    expect(invoiceReducerProblems(root)).toEqual([]);
  });
});

describe('§F the body-reading device cannot be escaped by a dollar-quote tag', () => {
  /**
   * MEASURED HOLE, closed here. `phase4RoutineBody` read a routine from its
   * `CREATE` to the first `$$;`, so a routine closed with ANY TAGGED
   * dollar-quote was not found at all — and a subject the device returns
   * `null` for was silently skipped by the refund law. A reader subtracting
   * `public.refunds` inside a `$fn$` body therefore produced ZERO findings.
   *
   * The shape is not hypothetical: the accepted Phase 4 migrations already
   * dollar-quote with `$coll$`, `$end$`, `$pre$`, `$post$` and `$proof$`, so
   * `$fn$` is the idiom a future author reaches for, not an exotic evasion.
   * Repairing the device is byte-neutral on the real tree: the four readers it
   * already found come back identical.
   */
  it('RED F1: a refund read inside a TAGGED dollar-quoted reader is found, not skipped', () => {
    const planted = `CREATE OR REPLACE FUNCTION invoice_outstanding_tagged(p_business_id uuid, p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT i.total_minor
       - COALESCE((SELECT sum(a.amount_minor) FROM public.payment_allocations a WHERE a.invoice_id = i.id), 0)
       - COALESCE((SELECT sum(r.amount_minor) FROM public.refunds r WHERE r.invoice_id = i.id), 0)
    FROM public.invoices i
   WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
$fn$;
`;
    const root = rootWith(planted, '9999_planted_tagged.sql');
    // First: the device can now READ it. That is the repair, stated separately
    // from the law, so a regression says which of the two broke.
    expect(phase4RoutineBody(root, 'invoice_outstanding_tagged'), 'a `$fn$`-quoted routine is unreadable again').not.toBeNull();
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('invoice_outstanding_tagged');
    expect(problems[0]).toContain('refunds');
  });

  it('F2: repairing the device is byte-neutral on the real tree — every reader it already read is unchanged', () => {
    // The repair widens reach only. If any of these bodies changed length, the
    // tagged-close regex is matching something different from what the first
    // device matched, and every law reading a body through it has moved.
    const readers = [
      ...new Set([...phase4Sql(REPO).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase())),
    ]
      .filter((n) => RECEIVABLE_READER_VOCABULARY.test(n))
      .sort();
    expect(readers, 'the tree defines no receivable reader, so this check has no subject').not.toEqual([]);
    for (const name of readers) {
      const body = phase4RoutineBody(REPO, name);
      expect(body, `${name} is no longer readable`).not.toBeNull();
      // The body is the routine it claims to be, and it ends where its own
      // opening tag closes rather than at some later routine's.
      expect(body).toContain(name);
      const tag = /AS\s+(\$[a-z_]*\$)/i.exec(body ?? '')?.[1];
      expect(tag, `${name}: no dollar-quote opening found in the body read`).toBeTruthy();
      expect(body?.endsWith(`${tag};`), `${name}: the body does not end at its own closing tag ${tag}`).toBe(true);
    }
    expect(invoiceReducerProblems(REPO)).toEqual([]);
  });

  it('RED F3: a reader whose body the device CANNOT read is reported, never skipped', () => {
    // A string-literal routine body is legal PostgreSQL and carries no
    // dollar-quote, so the device returns `null` for it. That used to be a
    // silent `continue`: a discovered subject vanishing from its own law. It
    // is now a finding in its own right — the same judgement the law already
    // made for a tree with no reader at all.
    const planted = `CREATE OR REPLACE FUNCTION invoice_outstanding_literal(p_business_id uuid, p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS 'SELECT 0::numeric';
`;
    const root = rootWith(planted, '9999_planted_literal.sql');
    expect(phase4RoutineBody(root, 'invoice_outstanding_literal')).toBeNull();
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('invoice_outstanding_literal');
    expect(problems[0]).toContain('an unreadable subject is not a pass');
  });
});

describe('§G a reader of the derived receivable is discovered by DEPENDENCY, not only by its name', () => {
  /**
   * The hole §G closes, measured rather than imagined.
   *
   * `RECEIVABLE_READER_VOCABULARY` finds the family by NAME — `outstanding`,
   * `receivable`, `aging`, `settlement_state` — and §B2 is right that finding
   * them by what they are CALLED beats a list. But a routine that CALLS one of
   * the family reads the derived receivable just as surely, and its name need
   * not carry any of those four tokens.
   *
   * Measured on the Phase 4 DDL as it stood: 48 routines, 4 in the family by
   * name, and `customer_apply_credit` and `customer_collect_payment` each call
   * one while matching no token — so they sat OUTSIDE this law entirely. Those
   * two are the invoice reducers' own command paths, which is precisely where
   * a refund subtraction would do the damage P4-AL-34 forbids: the hole was
   * over the most dangerous routines rather than the least. `0084`'s page
   * reader of a customer's open invoices would have joined them.
   *
   * The remedy is NOT a list of extra names. That would close it for exactly
   * as long as nobody added a routine, which is the closure-rule shape
   * P4-AL-88 refuses. It is discovery by DEPENDENCY: a routine is a subject of
   * this law if it calls a member of the family, whatever it is called. That
   * needs no list and grows to cover each new reader the moment its migration
   * exists, and it is strictly WIDER than the name match rather than a
   * replacement for it — which G3 asserts, so a future narrowing is loud.
   */
  it('RED G1: a routine with NO vocabulary token in its name, which calls the family and subtracts a refund, is found', () => {
    // `customer_picker_page` carries none of `outstanding`, `receivable`,
    // `aging` or `settlement_state`. Before the widening it was invisible to
    // this law; the tagged dollar quote is deliberate, so G1 cannot pass by
    // accident of §F's device.
    const planted = `CREATE FUNCTION customer_picker_page(p_business_id uuid, p_customer_id uuid)
RETURNS TABLE (invoice_id uuid, left_minor bigint)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $pick$
  SELECT o.invoice_id,
         o.outstanding_txn_minor - coalesce((SELECT sum(f.amount_minor) FROM public.refunds f
                                              WHERE f.business_id = p_business_id AND f.invoice_id = o.invoice_id), 0)
    FROM public.invoice_outstanding(p_business_id,
           (SELECT array_agg(x.id) FROM public.invoices x
             WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o;
$pick$;
`;
    const root = rootWith(planted, '9999_planted_picker.sql');
    // The name really does escape the vocabulary — otherwise G1 would be
    // proving the name match and not the dependency discovery.
    expect(RECEIVABLE_READER_VOCABULARY.test('customer_picker_page'), 'the planted name matches the vocabulary, so G1 proves the wrong device').toBe(false);
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('TL-P4-S5-R1');
    expect(problems[0]).toContain('customer_picker_page');
    expect(problems[0]).toContain('refunds');
  });

  it('NOT A FINDING G: the same routine WITHOUT the refund subtraction is silent — the discovery widens the law, it does not fail a legitimate reader', () => {
    const planted = `CREATE FUNCTION customer_picker_page(p_business_id uuid, p_customer_id uuid)
RETURNS TABLE (invoice_id uuid, left_minor bigint)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $pick$
  SELECT o.invoice_id, o.outstanding_txn_minor
    FROM public.invoice_outstanding(p_business_id,
           (SELECT array_agg(x.id) FROM public.invoices x
             WHERE x.business_id = p_business_id AND x.customer_id = p_customer_id AND x.status = 'open')) o;
$pick$;
`;
    const root = rootWith(planted, '9999_planted_picker_clean.sql');
    expect(invoiceReducerProblems(root)).toEqual([]);
  });

  it('G2: the two command paths the widening brought in are real, and the real tree is still silent with them as subjects', () => {
    // The hole and its closure, asserted over the actual tree rather than a
    // plant. If either routine stops calling the family, this says so — and
    // then the widening has a smaller subject set than the day it was written,
    // which is exactly the drift worth hearing about.
    const sql = phase4Sql(REPO);
    const defined = [
      ...new Set([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase())),
    ].sort();
    const family = defined.filter((n) => RECEIVABLE_READER_VOCABULARY.test(n));
    expect(family, 'the family is not the four readers this law has always had').toEqual([
      'customer_ar_aging',
      'customer_ar_outstanding',
      'invoice_outstanding',
      'invoice_settlement_state',
    ]);
    const dependent = defined.filter((n) => {
      if (family.includes(n)) return false;
      const body = phase4RoutineBody(REPO, n);
      return body !== null && family.some((r) => new RegExp(`\\b${r}\\s*\\(`, 'i').test(body));
    });
    // NOT an inventory, and the correction is measured rather than argued:
    // a literal list here is a closure rule a later slice must append to
    // (P4-AL-88), and `0084` proved it the first time it landed —
    // `customer_open_invoices_page` joined this set the day it was written,
    // and the exact-list assertion turned red on a CORRECT widening of the
    // law's reach. So the law is stated as a property instead: the two
    // command paths the widening was written for are still subjects, and
    // every member of the set earns its place by the two things that put it
    // there.
    for (const name of ['customer_apply_credit', 'customer_collect_payment'])
      expect(dependent, `${name} reads the receivable through a call, so it must still be a subject of this law`).toContain(name);
    expect(dependent.length, 'the dependency discovery found no subject at all, so it is no wider than the name match').toBeGreaterThan(0);
    for (const name of dependent) {
      expect(RECEIVABLE_READER_VOCABULARY.test(name), `${name} is in the set BY DEPENDENCY, so its name must not have matched the vocabulary`).toBe(false);
      const body = phase4RoutineBody(REPO, name);
      expect(body, `${name} has a body this law can read`).not.toBeNull();
      expect(
        family.some((r) => new RegExp(`\\b${r}\\s*\\(`, 'i').test(body ?? '')),
        `${name} is a subject only because it calls a family member, and it must genuinely do so`,
      ).toBe(true);
    }
    // Every Phase 4 routine's body is readable, which is what makes the
    // "unclassifiable subject" branch a report of an ANOMALY and not noise.
    expect(
      defined.filter((n) => phase4RoutineBody(REPO, n) === null),
      'a Phase 4 routine body this gate cannot read',
    ).toEqual([]);
    expect(invoiceReducerProblems(REPO)).toEqual([]);
  });

  it('G3: the dependency discovery is strictly WIDER than the name match — a narrowing cannot pass unnoticed', () => {
    const sql = phase4Sql(REPO);
    const defined = [
      ...new Set([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase())),
    ].sort();
    const family = defined.filter((n) => RECEIVABLE_READER_VOCABULARY.test(n));
    // A plant that the NAME match alone would have caught must still be
    // caught, so the widening is additive and nothing was traded away for it.
    const planted = `CREATE FUNCTION invoice_outstanding_shadow(p_business_id uuid, p_invoice_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $sh$
  SELECT coalesce((SELECT sum(f.amount_minor) FROM public.refunds f WHERE f.business_id = p_business_id AND f.invoice_id = p_invoice_id), 0);
$sh$;
`;
    const root = rootWith(planted, '9999_planted_shadow.sql');
    expect(RECEIVABLE_READER_VOCABULARY.test('invoice_outstanding_shadow'), 'the plant no longer matches the name vocabulary').toBe(true);
    const body = phase4RoutineBody(root, 'invoice_outstanding_shadow');
    expect(body, 'the plant is unreadable, so G3 would pass for the wrong reason').not.toBeNull();
    expect(
      family.some((r) => new RegExp(`\\b${r}\\s*\\(`, 'i').test(body ?? '')),
      'the plant calls the family, so the name match is not what catches it',
    ).toBe(false);
    const problems = invoiceReducerProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('invoice_outstanding_shadow');
  });
});
