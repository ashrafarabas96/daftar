/**
 * Regenerates `vectors/invpl-s6-vectors.json` and
 * `vectors/supplier-settlement-vectors.json` from `scripts/s6-vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-s6-vectors.ts`. The
 * committed files are checked byte-for-byte by the unit suites
 * (`test/payment-method-payloads.test.ts`,
 * `test/supplier-settlement-payloads.test.ts`,
 * `test/supplier-settlement.test.ts`), and the SQL routines and arithmetic
 * functions are tested against the same files (PHASE_3_S6_CONTRACT T-02,
 * T-07). Regenerate only when the SPEC changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInvplS6Vectors, buildSupplierSettlementVectors, renderInvplS6Vectors, renderSupplierSettlementVectors } from './s6-vector-cases';

async function main(): Promise<void> {
  const dir = join(__dirname, '..', 'vectors');
  writeFileSync(join(dir, 'invpl-s6-vectors.json'), await renderInvplS6Vectors(), 'utf8');
  writeFileSync(join(dir, 'supplier-settlement-vectors.json'), await renderSupplierSettlementVectors(), 'utf8');
  const p = buildInvplS6Vectors();
  const s = buildSupplierSettlementVectors();
  const steps = s.cases.reduce((n, c) => n + c.steps.length, 0);
  process.stdout.write(`wrote ${p.cases.length} invpl/1 P3-S6 vectors, ${s.cases.length} supplier-settlement cases (${steps} steps) to ${dir}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
