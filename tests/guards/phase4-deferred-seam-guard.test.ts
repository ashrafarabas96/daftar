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
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFERRED_SEAMS, deferredSeamProblems, SETTLEMENT_VOCABULARY, phase4RoutineBody } from '../../scripts/phase4-s1-gate';

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

describe('S-P4-01 — the FK owed the moment `sales` exists', () => {
  const SALES = `
    CREATE TABLE sales (
      tenant_id UUID NOT NULL,
      business_id UUID NOT NULL,
      id UUID NOT NULL,
      PRIMARY KEY (business_id, id)
    );
  `;

  it('RED: a Phase 4 migration creates `sales` and nothing binds invoices.sale_id to it', () => {
    const problems = deferredSeamProblems(rootWith(SALES));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-01');
    expect(problems[0]).toContain('sale_id');
  });

  it('NOT A FINDING: the same migration that creates `sales` adds the composite FK', () => {
    const closed = `${SALES}
      ALTER TABLE invoices
        ADD CONSTRAINT invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id);
    `;
    expect(deferredSeamProblems(rootWith(closed))).toEqual([]);
  });
});

describe('S-P4-02 — the registration and the reversal guard move together (P4-AL-47)', () => {
  const REGISTER = `
    INSERT INTO accounting_source_types (source_type, sort_order) VALUES ('invoice', 13);
  `;

  it('RED: the `invoice` source type is registered and the generic reversal guard does not name it', () => {
    const problems = deferredSeamProblems(rootWith(REGISTER));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('S-P4-02');
  });

  it('NOT A FINDING: the same migration widens the reversal guard’s list', () => {
    const closed = `${REGISTER}
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
    expect(deferredSeamProblems(rootWith(closed))).toEqual([]);
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
