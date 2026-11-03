/**
 * P4-S1 — THE COMPOSITE SEAM, AND THE PROOF THAT BOTH HALVES OF THE LAW CAN
 * GO RED (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-09; the `composite-fk`
 * check of scripts/phase4-s1-gate.ts; RP-FK).
 *
 * P4-AL-09's law is enforced twice, because each half misses what the other
 * catches:
 *
 *   the STATIC half (`compositeFkProblems`) reads the migration text, so it
 *   catches a seam written wrongly in a migration nobody has applied yet;
 *   the LIVE half (`singleColumnSeams`, from the GOLD-30 golden) reads
 *   `pg_constraint`, so it catches a seam that reached the database by any
 *   route at all — including one the text reader cannot parse.
 *
 * Both are green on the repository as it stands, and a green rule with no
 * planted defect is a rule nobody has tested. So every test below plants one
 * specific defect and requires the corresponding half to NAME it, and each
 * plant is paired with the correct form of the same statement, so the rule is
 * about the defect and not about the string.
 *
 * The live plants are made inside a transaction that is ALWAYS ROLLED BACK, so
 * nothing reaches the shared database.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compositeFkProblems } from '../../scripts/phase4-s1-gate';
import { singleColumnSeams, unvalidated } from '../golden-regression/phase4/02-cross-business-fk.golden.test';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const temporaries: string[] = [];

/** A root whose Phase 4 DDL is the repository's plus `planted`. */
function rootWith(planted: string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-seam-fk-'));
  temporaries.push(root);
  mkdirSync(join(root, 'infrastructure/database/migrations'), { recursive: true });
  cpSync(MIGRATIONS, join(root, 'infrastructure/database/migrations'), { recursive: true });
  writeFileSync(join(root, 'infrastructure/database/migrations/0076_planted.sql'), planted);
  writeFileSync(
    join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
    readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
  );
  return root;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensurePostgres();
}, 120_000);

/** `body` against a rolled-back transaction. */
async function rolledBack(body: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    await body(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('the repository is clean, so a plant means something', () => {
  it('the static half finds nothing to report today', () => {
    expect(compositeFkProblems(REPO)).toEqual([]);
  });

  it('the live half finds nothing to report today, over a subject that exists', async () => {
    await rolledBack(async (c) => {
      expect(await singleColumnSeams(c, ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'])).toEqual([]);
      expect(await unvalidated(c, ['invoices'])).toEqual([]);
    });
  });
});

describe('RED: the static half names each planted seam (RP-FK)', () => {
  it('a COLUMN-level REFERENCES to a business-scoped parent', () => {
    const problems = compositeFkProblems(
      rootWith(`
        CREATE TABLE sale_notes (
          tenant_id UUID NOT NULL,
          business_id UUID NOT NULL,
          id UUID NOT NULL,
          invoice_id UUID NOT NULL REFERENCES invoices (id),
          PRIMARY KEY (business_id, id)
        );
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('sale_notes.invoice_id');
    expect(problems[0]).toContain('SINGLE column');
  });

  it('a TABLE-level FK that omits business_id on the child side', () => {
    const problems = compositeFkProblems(
      rootWith(`
        CREATE TABLE sale_notes (
          tenant_id UUID NOT NULL,
          business_id UUID NOT NULL,
          id UUID NOT NULL,
          invoice_id UUID NOT NULL,
          PRIMARY KEY (business_id, id),
          CONSTRAINT sale_notes_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id)
        );
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('omits business_id on one side');
  });

  it('NOT A FINDING: the same table with the composite form', () => {
    expect(
      compositeFkProblems(
        rootWith(`
        CREATE TABLE sale_notes (
          tenant_id UUID NOT NULL,
          business_id UUID NOT NULL,
          id UUID NOT NULL,
          invoice_id UUID NOT NULL,
          PRIMARY KEY (business_id, id),
          CONSTRAINT sale_notes_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
          CONSTRAINT sale_notes_invoice_fk FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id)
        );
      `),
      ),
    ).toEqual([]);
  });

  it('a constraint added NOT VALID', () => {
    const problems = compositeFkProblems(
      rootWith(`
        ALTER TABLE invoices ADD CONSTRAINT invoices_probe_ck CHECK (number_seq >= 1) NOT VALID;
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NOT VALID');
  });

  it('a dropped foreign key: the composite seams are never dropped', () => {
    const problems = compositeFkProblems(
      rootWith(`
        ALTER TABLE invoices DROP CONSTRAINT invoices_customer_fk;
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('invoices_customer_fk');
  });
});

describe('RED: the live half names a seam that reached the database', () => {
  it('a single-column FK to `customers` is not even EXPRESSIBLE — the parent offers no single-column key', async () => {
    await rolledBack(async (c) => {
      await c.query('SAVEPOINT probe');
      const refusal = await c
        .query(
          `CREATE TABLE seam_probe (
             tenant_id UUID NOT NULL,
             business_id UUID NOT NULL,
             id UUID NOT NULL,
             customer_id UUID NOT NULL,
             PRIMARY KEY (business_id, id),
             CONSTRAINT seam_probe_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
           )`,
        )
        .then(() => null)
        .catch((e: unknown) => String(e));
      await c.query('ROLLBACK TO SAVEPOINT probe');
      // `customers`' only candidate key is (business_id, id), so PostgreSQL
      // itself refuses the single-column seam. That is the first layer of
      // P4-AL-09 and the reason the law is cheap to keep: the wrong shape is
      // not a thing someone can write and have accepted.
      expect(refusal, 'a single-column FK to customers (id) was ACCEPTED, so the parent offers a key it should not').not.toBeNull();
      expect(refusal ?? '').toMatch(/no unique constraint|there is no unique/i);
    });
  });

  it('a single-column seam against a parent that DOES offer one is named by the catalogue reader', async () => {
    await rolledBack(async (c) => {
      // The law still has to catch the case PostgreSQL permits: a parent whose
      // primary key is the bare id, which is how a Phase 4 relation would be
      // keyed by someone who forgot the business. The live reader catches it
      // however it got there — a hand-run statement on a deployment, a
      // restored dump, or a migration whose DDL the text parser cannot read.
      await c.query(`CREATE TABLE seam_parent (business_id UUID NOT NULL, id UUID NOT NULL PRIMARY KEY)`);
      await c.query(`CREATE TABLE seam_probe (
        tenant_id UUID NOT NULL,
        business_id UUID NOT NULL,
        id UUID NOT NULL,
        parent_id UUID NOT NULL,
        PRIMARY KEY (business_id, id),
        CONSTRAINT seam_probe_parent_fk FOREIGN KEY (parent_id) REFERENCES seam_parent (id)
      )`);
      expect(await singleColumnSeams(c, ['seam_probe'])).toEqual(['seam_probe.seam_probe_parent_fk']);
      // …and the correct form on the same two relations is not a finding.
      await c.query(`ALTER TABLE seam_parent ADD CONSTRAINT seam_parent_uq UNIQUE (business_id, id)`);
      await c.query(`CREATE TABLE seam_ok (
        tenant_id UUID NOT NULL,
        business_id UUID NOT NULL,
        id UUID NOT NULL,
        parent_id UUID NOT NULL,
        PRIMARY KEY (business_id, id),
        CONSTRAINT seam_ok_parent_fk FOREIGN KEY (business_id, parent_id) REFERENCES seam_parent (business_id, id)
      )`);
      expect(await singleColumnSeams(c, ['seam_ok'])).toEqual([]);
    });
  });

  it('an unvalidated constraint is named by the catalogue reader', async () => {
    await rolledBack(async (c) => {
      await c.query(`CREATE TABLE valid_probe (business_id UUID NOT NULL, id UUID NOT NULL, n BIGINT NOT NULL, PRIMARY KEY (business_id, id))`);
      await c.query(`INSERT INTO valid_probe (business_id, id, n) VALUES (gen_random_uuid(), gen_random_uuid(), -1)`);
      await c.query(`ALTER TABLE valid_probe ADD CONSTRAINT valid_probe_n_ck CHECK (n >= 0) NOT VALID`);
      expect(await unvalidated(c, ['valid_probe'])).toEqual(['valid_probe.valid_probe_n_ck']);
    });
  });
});
