/**
 * Regenerates `vectors/invpl-s4-vectors.json`, `vectors/landed-cost-vectors.json`
 * and `vectors/coverage-vectors.json` from `scripts/s4-vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-s4-vectors.ts`. The
 * committed files are checked byte-for-byte by the unit suite
 * (`test/purchase-payloads.test.ts`, `test/landed-cost.test.ts`,
 * `test/deficit-coverage.test.ts`), and the SQL routines are tested against
 * the same files (PHASE_3_S4_CONTRACT T-05, T-08). Regenerate only when the
 * SPEC changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCoverageVectors,
  buildInvplS4Vectors,
  buildLandedCostVectors,
  renderCoverageVectors,
  renderInvplS4Vectors,
  renderLandedCostVectors,
} from './s4-vector-cases';

async function main(): Promise<void> {
  const dir = join(__dirname, '..', 'vectors');
  writeFileSync(join(dir, 'invpl-s4-vectors.json'), await renderInvplS4Vectors(), 'utf8');
  writeFileSync(join(dir, 'landed-cost-vectors.json'), await renderLandedCostVectors(), 'utf8');
  writeFileSync(join(dir, 'coverage-vectors.json'), await renderCoverageVectors(), 'utf8');
  const p = buildInvplS4Vectors();
  const l = buildLandedCostVectors();
  const c = buildCoverageVectors();
  process.stdout.write(
    `wrote ${p.cases.length} invpl/1 P3-S4 and ${p.texts.length} text vectors, ${l.splits.length} split, ${l.purchases.length} purchase and ` +
      `${l.refusals.length} refusal vectors, ${c.cases.length} coverage cases to ${dir}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
