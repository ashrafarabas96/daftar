/**
 * P4-S1 red proofs — guard G-6 reaches the Phase 4 read modules.
 *
 * G-6 (P2-S7 §61, widened in P3-S7) is the guard that says the reporting
 * surface is read-only and reads the journal: no write, no `OFFSET`, no
 * current-rate lookup, no `is_active` filter over history, no `Number(amount)`,
 * no persisted balance source, no module-level cache.
 *
 * Its merchant half was scoped by DIRECTORY — `inventory/inventory-reads.ts`
 * and `purchasing/supplier-balance-reads.ts` — so a read module in a directory
 * the regex had never heard of was simply not examined, and an `OFFSET` or a
 * `Number()` on money in `selling/customer-reads.ts` would have shipped green.
 * That is the same shape of hole G-3's balance rule had, and it is closed the
 * same way: by a rule about what the file IS, not by a longer list of names.
 *
 * Every rule widened here is planted as the defect it refuses and asserted to
 * fail for that reason; the green half is that the shipped surface and its
 * membership are unchanged, measured over the tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MERCHANT_READ_TABLES,
  READ_SURFACE,
  READ_SURFACE_EXEMPT,
  declaresCommonTableExpression,
  findReadSurfaceViolations,
  readSurfaceFiles,
  relationsReferenced,
} from '../../scripts/guards/read-surface';

const ROOT = join(__dirname, '../..');

/** Every non-test module the gate feeds G-6, keyed exactly as the gate keys it. */
function appFiles(): Record<string, string> {
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage', '.scratch']);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full) && !/\.(test|spec)\.tsx?$/.test(full)) out[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(ROOT);
  return out;
}

/** The two Phase 4 read modules the contract owner is writing. */
const CUSTOMER_READS = 'apps/api/src/modules/selling/customer-reads.ts';
const INVOICE_READS = 'apps/api/src/modules/selling/invoice-reads.ts';
const rules = (file: string, source: string): string[] => findReadSurfaceViolations({ [file]: source }).map((v) => v.rule);

// ───────────────────────────────────────────────────────────────────────────
describe('P4-S1 — G-6 examines a Phase 4 read module (P4-AL-07, §61)', () => {
  it('the surface is a rule about the module, so the CONTEXT DIRECTORY NAME does not matter', () => {
    for (const path of [
      CUSTOMER_READS,
      INVOICE_READS,
      // the same file if `selling/` is renamed, which the contract owner flagged as undecided
      'apps/api/src/modules/sales/invoice-reads.ts',
      'apps/api/src/modules/pos/customer-reads.ts',
      'apps/api/src/modules/receivables/customer-reads.ts',
      'apps/api/src/modules/debts/installment-reads.ts',
      // a context nobody has thought of yet
      'apps/api/src/modules/whatever-phase-5-calls-it/quote-reads.ts',
      // Windows separators
      'apps\\api\\src\\modules\\selling\\invoice-reads.ts',
    ]) {
      expect(READ_SURFACE.test(path), path).toBe(true);
    }
    // …and the guard's code names no Phase 4 context, so a rename cannot break it.
    const code = readFileSync(join(ROOT, 'scripts/guards/read-surface.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const context of ['selling', 'sales', 'pos', 'receivables', 'invoices', 'customers', 'debts', 'installments'])
      expect(code.includes(`modules/${context}`), context).toBe(false);
  });

  it('the Phase 3 surface and its accepted exclusions are byte-for-byte what they were', () => {
    for (const path of [
      'apps/api/src/modules/accounting/accounting-reports.reader.ts',
      'apps/api/src/modules/accounting/accounting-reports.service.ts',
      'packages/accounting/src/reports.ts',
      'apps/api/src/modules/inventory/inventory-reads.ts',
      'apps/api/src/modules/purchasing/supplier-balance-reads.ts',
      'apps\\api\\src\\modules\\purchasing\\supplier-balance-reads.ts',
    ]) {
      expect(READ_SURFACE.test(path), path).toBe(true);
    }
    for (const path of [
      // S6's command-side FX binding (readSettlementFx) must look the current rate up.
      'apps/api/src/modules/purchasing/purchasing-reads.ts',
      'apps\\api\\src\\modules\\purchasing\\purchasing-reads.ts',
      'apps/api/src/modules/inventory/inventory-reads.controller.ts',
      'apps/api/src/modules/inventory/inventory-movements.service.ts',
      'apps/api/src/modules/inventory/inventory-stock-read.ts',
      // a DTO package and a test helper are not reporting modules
      'packages/shared-contracts/src/merchant-reads.ts',
      'tests/helpers/merchant-reads.ts',
    ]) {
      expect(READ_SURFACE.test(path), path).toBe(false);
    }
    // The exemption is named, with its reason, in the guard — not implied by a gap in a regex.
    expect([...READ_SURFACE_EXEMPT]).toEqual(['purchasing-reads.ts']);
  });

  it('PLANTED: every G-6 rule fires inside a Phase 4 read module', () => {
    expect(rules(INVOICE_READS, 'const sql = `SELECT 1 FROM invoices ORDER BY id LIMIT $1 OFFSET $2`;')).toContain('no OFFSET pagination');
    expect(rules(CUSTOMER_READS, 'const sql = `SELECT accounting_fx_rate_lookup($1, $2, now())`;')).toContain('no current exchange-rate lookup');
    expect(rules(CUSTOMER_READS, 'const owed = Number(row.outstandingMinor);')).toContain('no floating-point parse of an amount');
    expect(rules(INVOICE_READS, 'const paid = parseFloat(row.paid_minor);')).toContain('no floating-point parse of an amount');
    expect(rules(CUSTOMER_READS, 'const cache = new Map();')).toContain('no module-level result cache');
    for (const planted of [
      'const sql = `SELECT amount FROM customer_balance_snapshots WHERE business_id = $1`;',
      'const sql = `SELECT bucket FROM ar_aging_summary WHERE business_id = $1`;',
      'const sql = `SELECT outstanding FROM invoice_outstanding_cache WHERE id = $1`;',
      'const sql = `SELECT x FROM receivables_rollup`;',
      'const sql = `SELECT x FROM customer_ar_projection`;',
      'const sql = `CREATE MATERIALIZED VIEW ar_rollup AS SELECT 1`;',
    ]) {
      expect(rules(CUSTOMER_READS, planted), planted).toContain('no persisted or materialized balance source');
    }
    // …and a page size is still a page size.
    expect(rules(INVOICE_READS, 'const size = Number(limitText);')).toEqual([]);
  });

  it('PLANTED: a stored total is refused in the RELATION position, and a column or a CTE of the same name is not', () => {
    // The rule is a relation-name grammar, so it is asked only about relations.
    // A `FROM customer_balances` is a stored total and is refused…
    for (const relation of ['customer_balances', 'ar_aging_summary', 'invoice_outstanding_cache', 'invoice_balance_snapshots', 'receivables_rollup']) {
      expect(rules(CUSTOMER_READS, `const sql = \`SELECT x FROM ${relation} WHERE business_id = $1\`;`), relation).toContain(
        'no persisted or materialized balance source',
      );
      expect(relationsReferenced(`SELECT x FROM ${relation}`), relation).toContain(relation);
    }

    // …and a COLUMN of a snapshot-shaped name is not, because it is not a
    // relation. This is the false positive that failed the merged tree:
    // `invoices.customer_phone_snapshot` is a contact label frozen on the
    // document at issue, read in a select list and never in a FROM.
    expect(
      rules(INVOICE_READS, 'const sql = `SELECT i.id, i.customer_name_snapshot, i.customer_phone_snapshot FROM invoices i WHERE i.business_id = $1`;'),
    ).toEqual([]);
    // The next label column, which an exemption list would not have covered.
    expect(
      rules(INVOICE_READS, 'const sql = `SELECT i.customer_address_snapshot, t.name_snapshot FROM invoices i JOIN invoice_items t ON t.invoice_id = i.id`;'),
    ).toEqual([]);
    expect(relationsReferenced('SELECT i.customer_phone_snapshot FROM invoices i')).toEqual(['invoices']);

    // A CTE is computed inside the statement, so it is not a stored total
    // either — `accounting-reconciliation.reader.ts` already has one called
    // `cache` (`:549-555`).
    for (const cte of ['summary', 'cache', 'outstanding', 'balances']) {
      const sql = `const sql = \`WITH ${cte} AS (SELECT 1 AS n) SELECT n FROM ${cte}\`;`;
      expect(rules(CUSTOMER_READS, sql), cte).toEqual([]);
      expect(declaresCommonTableExpression(sql, cte), cte).toBe(true);
    }

    // A derived-figure FUNCTION in a FROM is the CORRECT read path (P4-AL-07),
    // not a stored total, and must pass.
    for (const fn of ['customer_ar_outstanding($1, $2)', 'invoice_outstanding($1)', 'purchase_ap_outstanding($1)']) {
      expect(rules(CUSTOMER_READS, `const sql = \`SELECT * FROM ${fn} o\`;`), fn).toEqual([]);
    }
    // …and the function name is not captured as a relation, whole or truncated.
    expect(relationsReferenced('SELECT * FROM customer_ar_outstanding($1, $2) o')).toEqual([]);
  });

  it('PLANTED: a write to a Phase 4 relation inside a read module is refused', () => {
    for (const planted of [
      'const sql = `UPDATE invoices SET status = $1`;',
      'const sql = `INSERT INTO customers (id) VALUES ($1)`;',
      'const sql = `DELETE FROM invoice_items WHERE id = $1`;',
      'const sql = `UPDATE invoice_sequences SET next_no = next_no + 1`;',
      'const sql = `UPDATE customer_contacts SET seen_at = now()`;',
    ]) {
      expect(rules(INVOICE_READS, planted), planted).toContain('no write to an accounting table');
    }
    for (const t of ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences']) expect(MERCHANT_READ_TABLES, t).toContain(t);
  });

  it('PLANTED: the write rule is the STATEMENT, so a relation in no list is refused too', () => {
    // Nothing in the guard mentions `quotes` or `layaway_plans`. A read module
    // still may not write them, and the rule does not wait for the array to grow.
    for (const planted of [
      'const sql = `UPDATE quotes SET accepted_at = now()`;',
      'const sql = `INSERT INTO layaway_plans (id) VALUES ($1)`;',
      'const sql = `DELETE FROM public.whatever_phase_5_adds WHERE id = $1`;',
      'const sql = `TRUNCATE TABLE scratch_rollup`;',
      'const sql = `MERGE INTO some_table USING src ON src.id = some_table.id`;',
    ]) {
      expect(rules(CUSTOMER_READS, planted), planted).toContain('no write to an accounting table');
    }
    // A row lock is not an UPDATE statement, and must not be mistaken for one.
    for (const innocent of [
      'const sql = `SELECT id FROM invoices WHERE id = $1 FOR UPDATE`;',
      'const sql = `SELECT id FROM invoices WHERE id = $1 FOR NO KEY UPDATE`;',
      'const sql = `SELECT id FROM invoices i FOR UPDATE OF i NOWAIT`;',
      'const sql = `SELECT id FROM invoices FOR UPDATE SKIP LOCKED`;',
    ]) {
      expect(rules(CUSTOMER_READS, innocent), innocent).toEqual([]);
    }
  });

  it('PLANTED: an is_active filter over Phase 4 history is refused (§33, one phase later)', () => {
    // A deactivated customer's debt is still owed. Filtering AR history on
    // `is_active` is the same defect as hiding a closed shop from the books.
    expect(rules(CUSTOMER_READS, 'const sql = `SELECT c.id FROM journal_lines l JOIN customers c ON c.id = l.customer_id WHERE c.is_active`;')).toContain(
      'no historical filter on accounts.is_active',
    );
    expect(
      rules(INVOICE_READS, 'const sql = `SELECT i.id FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE c.is_active AND i.business_id = $1`;'),
    ).toContain('no historical filter on accounts.is_active');
    expect(rules(CUSTOMER_READS, 'const sql = `SELECT p.id FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.is_active`;')).toContain(
      'no historical filter on accounts.is_active',
    );
    // Reporting it is the opposite of hiding it: a projection is not a filter.
    expect(
      rules(INVOICE_READS, 'const sql = `SELECT i.id, c.is_active FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.business_id = $1`;'),
    ).toEqual([]);
  });

  it('does not trip on a comment that names what it forbids', () => {
    expect(rules(CUSTOMER_READS, '/** Never OFFSET, never accounting_fx_rate_lookup, never Number(amount). */\nexport const x = 1;')).toEqual([]);
  });

  it('GREEN HALF — the shipped surface, its membership and its verdicts are unchanged', () => {
    const files = appFiles();
    expect(Object.keys(files).length).toBeGreaterThan(300);
    // The Phase 3 surface, always. The two Phase 4 read modules join it when the
    // selling context is present in the tree — which is the point of the rule,
    // and is why this is a superset assertion over a fixed list of five.
    for (const path of [
      'apps/api/src/modules/accounting/accounting-reports.reader.ts',
      'apps/api/src/modules/accounting/accounting-reports.service.ts',
      'apps/api/src/modules/inventory/inventory-reads.ts',
      'apps/api/src/modules/purchasing/supplier-balance-reads.ts',
      'packages/accounting/src/reports.ts',
    ]) {
      expect(readSurfaceFiles(files), path).toContain(path);
    }
    // Nothing else is on the surface except a context read module.
    for (const path of readSurfaceFiles(files)) {
      const isAccountingReport = /accounting-reports\.|packages\/accounting\/src\/reports\.ts$/.test(path);
      expect(isAccountingReport || /^apps\/api\/src\/modules\/[^/]+\/[\w.-]*-reads\.ts$/.test(path), path).toBe(true);
    }
    // Every Phase 4 read module that exists is watched.
    for (const path of Object.keys(files)) {
      if (/^apps\/api\/src\/modules\/selling\/[\w.-]*-reads\.ts$/.test(path)) expect(readSurfaceFiles(files), path).toContain(path);
    }
    expect(findReadSurfaceViolations(files)).toEqual([]);
  });
});
