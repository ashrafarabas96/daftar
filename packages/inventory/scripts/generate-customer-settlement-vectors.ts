/**
 * Regenerates `vectors/customer-settlement-vectors.json` from
 * `scripts/customer-settlement-vector-cases.ts` — the receivable mirror of
 * `generate-s6-vectors.ts`' supplier half.
 *
 * Run with
 * `npx tsx packages/inventory/scripts/generate-customer-settlement-vectors.ts`.
 * The committed file is checked BYTE FOR BYTE by
 * `test/customer-settlement.test.ts`, so a change to the arithmetic that moves
 * any number turns that suite red until the file is regenerated deliberately.
 * Regenerate only when the SPEC changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCustomerSettlementVectors, renderCustomerSettlementVectors } from './customer-settlement-vector-cases';

async function main(): Promise<void> {
  const dir = join(__dirname, '..', 'vectors');
  writeFileSync(join(dir, 'customer-settlement-vectors.json'), await renderCustomerSettlementVectors(), 'utf8');
  const v = buildCustomerSettlementVectors();
  const steps = v.cases.reduce((n, c) => n + c.steps.length, 0);
  const primitives = v.cases.reduce((n, c) => n + c.steps.reduce((m, s) => m + s.primitives.length, 0), 0);
  process.stdout.write(`wrote ${v.cases.length} customer-settlement cases (${steps} steps, ${primitives} primitive calls) to ${dir}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
