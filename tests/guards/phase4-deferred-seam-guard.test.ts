/**
 * P4-S1 — THE DECLARED SEAMS, AND THE PROOF THAT EACH ONE CAN GO RED
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-07, P4-AL-09, P4-AL-47; the
 * `deferred-seams` check of scripts/phase4-s1-gate.ts).
 *
 * `0075` leaves three seams open on purpose, because closing any of them
 * would mean creating a later slice's relation, which P4-AL-86 refuses:
 *
 *   S-P4-01  `invoices.sale_id` carries no FK, because `sales` does not exist;
 *   S-P4-02  the `invoice` accounting source type is not registered, because
 *            no slice can post an invoice yet;
 *   S-P4-03  `invoice_outstanding` subtracts nothing, because nothing that
 *            settles an invoice exists yet.
 *
 * A seam check that is green because it has no subject proves nothing
 * ([[daftar-a-green-gate-must-prove-it-can-be-red]], and the gate's own
 * discipline that NOT-YET-APPLICABLE IS NOT A PASS). So every test below
 * plants the later condition in a SYNTHETIC SQL text and requires the check
 * to name the seam — and then plants the correct closure and requires
 * silence, so the rule is a rule about the defect and not about the string.
 *
 * The planting is done through a temporary migrations directory, never by
 * touching the real one: `0075` is applied, and editing an applied migration
 * breaks every suite with "Migration tampered after apply".
 *
 * ── P4-S2: TWO OF THOSE SEAMS HAVE BEEN DISCHARGED ───────────────────────
 *
 * `0077_phase4_sales_sale_items_sources.sql` creates `sales`, adds
 * `invoices_sale_fk`, registers the `invoice` accounting source type AND
 * widens the generic reversal guard's list in the same file. S-P4-01 and
 * S-P4-02 are therefore CLOSED in the tree, and their red proofs as first
 * written could no longer go red: each planted the later CONDITION (a `sales`
 * relation, an `invoice` registration) onto a tree that already carries the
 * DISCHARGE, so the seam was correctly silent and `toHaveLength(1)` failed.
 *
 * A discharged seam still needs a proof that the discharge can be detected as
 * MISSING — otherwise the gate's silence about S-P4-01 and S-P4-02 is once
 * again the silence of a check with no subject, this time because nothing can
 * make it speak. So each of those two proofs is RE-AIMED: it plants the
 * ABSENCE of the discharge on a COPY of the tree (`rootMinus`, never the
 * checkout) and requires the seam to name it, and it is paired with the
 * discharge restored on that same stripped copy, so the rule is still about
 * the defect and not about the string.
 *
 * The subject is `deferredSeamProblems` from the SEALED `phase4-s1-gate`, not
 * a second copy of its rules: the live claim lives there, this suite only
 * proves it can go red. The discharge is DISCOVERED — the Phase 4 migration
 * that carries it is found with the seam's OWN predicate, so no migration
 * number and no slice's file name is written here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFERRED_SEAMS, deferredSeamProblems, SETTLEMENT_VOCABULARY, phase4Migrations, phase4RoutineBody } from '../../scripts/phase4-s1-gate';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const temporaries: string[] = [];

/**
 * A root whose migrations directory is the real one plus `planted` as a
 * further Phase 4 migration. Everything else the gate reads is shared with
 * the repository, so only the DDL differs.
 */
function rootWith(planted: string, name = '0076_planted.sql'): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-seam-'));
  temporaries.push(root);
  mkdirSync(join(root, 'infrastructure/database/migrations'), { recursive: true });
  cpSync(MIGRATIONS, join(root, 'infrastructure/database/migrations'), { recursive: true });
  writeFileSync(join(root, 'infrastructure/database/migrations', name), planted);
  writeFileSync(
    join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
    readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
  );
  return root;
}

/**
 * A root whose migrations directory is the real one with the DISCHARGE of a
 * seam stripped out of it, plus an optional further planted migration.
 *
 * `carries` is the seam's own predicate for "the discharge is present". Every
 * Phase 4 migration whose text matches it is found — DISCOVERY, so neither the
 * file that carries the discharge nor its number is written here — and in the
 * COPY every match is rewritten to `instead`. The rewrite is then required to
 * have changed something in every one of those files, so a proof cannot pass
 * vacuously on the day the discharge is written differently: if nothing
 * matched, or a match rewrote to itself, this fails before the seam is asked.
 *
 * The checkout is never touched. `0077` is applied in the shared cluster and
 * editing an applied migration breaks every suite with "Migration tampered
 * after apply".
 */
function rootMinus(carries: RegExp, instead: string, planted?: { sql: string; name: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-seam-minus-'));
  temporaries.push(root);
  const dir = join(root, 'infrastructure/database/migrations');
  mkdirSync(dir, { recursive: true });
  cpSync(MIGRATIONS, dir, { recursive: true });
  writeFileSync(
    join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
    readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
  );
  // A fresh object per use: a `/g` regex carries `lastIndex`, so one shared
  // instance would skip files in the filter below.
  const global = (): RegExp => new RegExp(carries.source, carries.flags.includes('g') ? carries.flags : `${carries.flags}g`);
  const carriers = phase4Migrations(root).filter((f) => global().test(readFileSync(join(dir, f), 'utf8')));
  expect(carriers, `no Phase 4 migration carries the discharge ${String(carries)} — the seam has nothing to strip`).not.toEqual([]);
  for (const f of carriers) {
    const before = readFileSync(join(dir, f), 'utf8');
    const after = before.replace(global(), instead);
    expect(after === before, `${f}: stripping ${String(carries)} changed nothing, so the plant proves nothing`).toBe(false);
    writeFileSync(join(dir, f), after);
  }
  if (planted !== undefined) writeFileSync(join(dir, planted.name), planted.sql);
  return root;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe('the seams are declared, and the registry is the gate’s subject', () => {
  it('the three seams of 0075 are declared, each with what is open and a predicate', () => {
    expect(DEFERRED_SEAMS.map((s) => s.id)).toEqual(['S-P4-01', 'S-P4-02', 'S-P4-03']);
    for (const seam of DEFERRED_SEAMS) {
      expect(seam.what.length).toBeGreaterThan(20);
      expect(typeof seam.run).toBe('function');
    }
  });

  it('the tree as it stands is safe: every seam is silent, and that silence is about the real DDL', () => {
    expect(deferredSeamProblems(REPO)).toEqual([]);
    // The silence is not the silence of a missing subject: 0075 really does
    // define the routine S-P4-03 watches.
    expect(phase4RoutineBody(REPO, 'invoice_outstanding')).not.toBeNull();
  });
});

describe('S-P4-01 — the FK owed the moment `sales` exists (DISCHARGED: the proof is now that the discharge can go missing)', () => {
  /**
   * The seam's OWN predicate for the discharge, copied from `DEFERRED_SEAMS`
   * (`phase4-s1-gate.ts`, sealed): a FOREIGN KEY naming `sale_id` that
   * REFERENCES `sales`. Stripping exactly what the check looks for is what
   * makes the plant the ABSENCE OF THE DISCHARGE rather than a guess at it.
   */
  const DISCHARGE = /FOREIGN\s+KEY\s*\([^)]*\bsale_id\b[^)]*\)\s*REFERENCES\s+sales\b/i;

  it('the discharge is in the tree, and the seam is silent BECAUSE of it, not for want of a subject', () => {
    // `sales` exists — so the seam's precondition is met and its silence is a
    // judgement, not an abstention.
    expect(deferredSeamProblems(REPO)).toEqual([]);
    const phase4Sql = phase4Migrations(REPO)
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(/CREATE\s+TABLE\s+(?:public\.)?sales\b/i.test(phase4Sql), 'a Phase 4 migration creates `sales`').toBe(true);
    expect(DISCHARGE.test(phase4Sql), 'and a Phase 4 migration binds a sale_id to it').toBe(true);
  });

  it('RED: the discharge is removed — `sales` exists and nothing binds invoices.sale_id to it', () => {
    // The planted defect is now the REMOVAL of what closed the seam: the
    // tree still creates `sales`, and every edge the seam can see is gone.
    const problems = deferredSeamProblems(rootMinus(DISCHARGE, 'FOREIGN KEY (business_id, id) REFERENCES businesses (tenant_id, id)'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-01');
    expect(problems[0]).toContain('sale_id');
  });

  it('NOT A FINDING: the discharge restored on that same stripped tree', () => {
    // The rule is about the defect, not the string: the same stripped tree
    // plus a later migration that adds the composite edge back is silent.
    expect(
      deferredSeamProblems(
        rootMinus(DISCHARGE, 'FOREIGN KEY (business_id, id) REFERENCES businesses (tenant_id, id)', {
          name: '9999_planted_restores_the_edge.sql',
          sql: `ALTER TABLE invoices
                  ADD CONSTRAINT invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id);`,
        }),
      ),
    ).toEqual([]);
  });

  it('NOTE: the seam does not read WHICH relation carries the edge — documented so no suite claims otherwise', () => {
    /**
     * A FINDING, reported rather than fixed here (`scripts/phase4-s1-gate.ts`
     * is sealed). S-P4-01's predicate greps the whole concatenated Phase 4
     * DDL for "a FOREIGN KEY on `sale_id` REFERENCING `sales`" and never asks
     * which table it is ON. `0077` writes two such edges — `invoices_sale_fk`
     * on `invoices` and `sale_items_sale_fk` on `sale_items` — so dropping
     * the one the seam exists for leaves the seam silent, satisfied by the
     * other.
     *
     * This test states that behaviour positively so it cannot change
     * unnoticed, and names where the gap IS closed: `0077`'s own end-state
     * block asserts `invoices_sale_fk` is the validated composite edge on
     * `public.invoices`, which is the assertion with the force the gate's
     * grep does not have.
     */
    const onlyInvoices = /FOREIGN\s+KEY\s*\(business_id,\s*sale_id\)\s*REFERENCES\s+sales\s*\(business_id,\s*id\);/i;
    const stripped = rootMinus(onlyInvoices, 'FOREIGN KEY (business_id, id) REFERENCES businesses (tenant_id, id);');
    expect(deferredSeamProblems(stripped), 'S-P4-01 is satisfied by an edge on another relation — the predicate reads no child table').toEqual([]);
    // Where the claim really lives, in the migration's own end state.
    const phase4Sql = phase4Migrations(REPO)
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(
      /conname\s*=\s*'invoices_sale_fk'[\s\S]{0,200}?conrelid\s*=\s*'public\.invoices'::regclass/i.test(phase4Sql),
      'the end-state assertion that does name the child relation',
    ).toBe(true);
  });
});

describe('S-P4-02 — the registration and the reversal guard move together (P4-AL-47) (DISCHARGED: the proof is now that the discharge can go missing)', () => {
  /**
   * The seam fires when the `invoice` source type is registered and the
   * generic reversal guard is not named near it. The discharge is therefore
   * the Phase 4 DDL NAMING that guard at all, which is exactly the half of
   * the seam's own predicate that can be stripped: with the identifier gone
   * the registration stands alone, which is the defect P4-AL-47 forbids.
   */
  const DISCHARGE = /accounting_reversals?/i;

  it('the discharge is in the tree, and the seam is silent BECAUSE of it', () => {
    expect(deferredSeamProblems(REPO)).toEqual([]);
    const phase4Sql = phase4Migrations(REPO)
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(/INSERT\s+INTO\s+accounting_source_types\b[\s\S]{0,400}?'invoice'/i.test(phase4Sql), 'the `invoice` source type is registered').toBe(true);
    expect(/accounting_reversals?[\s\S]{0,4000}?'invoice'/i.test(phase4Sql), 'and the generic reversal guard names it').toBe(true);
  });

  it('RED: the discharge is removed — the `invoice` source type is registered and the generic reversal guard does not name it', () => {
    const problems = deferredSeamProblems(rootMinus(DISCHARGE, 'accounting_no_such_guard'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-02');
  });

  it('NOT A FINDING: the reversal guard’s list widened on that same stripped tree', () => {
    const closed = `
      CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_type IN ('purchase', 'supplier_return', 'invoice') THEN
          RETURN NULL;
        END IF;
        RETURN NULL;
      END;
      $$;
    `;
    expect(deferredSeamProblems(rootMinus(DISCHARGE, 'accounting_no_such_guard', { name: '9999_planted_rewidens.sql', sql: closed }))).toEqual([]);
  });
});

describe('S-P4-03 — the reader-of-record reads every relation that settles an invoice', () => {
  const ALLOCATIONS = `
    CREATE TABLE payment_allocations (
      tenant_id UUID NOT NULL,
      business_id UUID NOT NULL,
      id UUID NOT NULL,
      invoice_id UUID NOT NULL,
      applied_txn_minor BIGINT NOT NULL,
      PRIMARY KEY (business_id, id)
    );
  `;

  it('the vocabulary is discovered, not listed: the settlement names a later slice will use all match', () => {
    for (const name of ['payment_allocations', 'allocation_reversals', 'payment_reversals', 'refunds', 'customer_credit_applications'])
      expect(SETTLEMENT_VOCABULARY.test(name)).toBe(true);
    // …and an ordinary Phase 4 relation does not, so the rule has a shape.
    for (const name of ['customers', 'invoices', 'invoice_items', 'invoice_sequences', 'sales', 'sale_items'])
      expect(SETTLEMENT_VOCABULARY.test(name)).toBe(false);
  });

  it('RED: a Phase 4 migration creates payment_allocations and invoice_outstanding still subtracts nothing', () => {
    const problems = deferredSeamProblems(rootWith(ALLOCATIONS));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-03');
    expect(problems[0]).toContain('payment_allocations');
    expect(problems[0]).toContain('reports the invoice unpaid');
  });

  it('NOT A FINDING: the same migration replaces invoice_outstanding so it reads the new relation', () => {
    const closed = `${ALLOCATIONS}
      CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
      RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
      LANGUAGE plpgsql STABLE AS $$
      BEGIN
        RETURN QUERY
          SELECT coalesce(sum(a.applied_txn_minor), 0)::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT
            FROM public.payment_allocations a
           WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id;
      END;
      $$;
    `;
    expect(deferredSeamProblems(rootWith(closed))).toEqual([]);
  });

  it('RED: two settlement relations land and the routine reads only one — the finding names the one it misses', () => {
    const both = `${ALLOCATIONS}
      CREATE TABLE refunds (
        tenant_id UUID NOT NULL,
        business_id UUID NOT NULL,
        id UUID NOT NULL,
        PRIMARY KEY (business_id, id)
      );
      CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID) RETURNS BIGINT
      LANGUAGE sql STABLE AS $$
        SELECT coalesce(sum(a.applied_txn_minor), 0)::BIGINT FROM public.payment_allocations a
         WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id;
      $$;
    `;
    const problems = deferredSeamProblems(rootWith(both));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('refunds');
    expect(problems[0]).not.toContain('payment_allocations,');
  });

  it('RED: the settlement relation lands and no Phase 4 migration defines the routine at all', () => {
    // The same planting, but against a root whose Phase 4 DDL is ONLY the
    // planted file — so the absence of the reader is the defect, and the
    // check says so in its own words rather than passing for want of a body.
    const root = mkdtempSync(join(tmpdir(), 'p4-seam-bare-'));
    temporaries.push(root);
    mkdirSync(join(root, 'infrastructure/database/migrations'), { recursive: true });
    cpSync(MIGRATIONS, join(root, 'infrastructure/database/migrations'), { recursive: true });
    rmSync(join(root, 'infrastructure/database/migrations/0075_phase4_customers_invoices_numbering.sql'));
    writeFileSync(join(root, 'infrastructure/database/migrations/0076_planted.sql'), ALLOCATIONS);
    writeFileSync(
      join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
      readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
    );
    const problems = deferredSeamProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot be absent once something settles');
  });
});
