/**
 * Regenerates `vectors/invpl-s5-vectors.json` and
 * `vectors/supplier-return-vectors.json` from `scripts/s5-vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-s5-vectors.ts`. The
 * committed files are checked byte-for-byte by the unit suite
 * (`test/supplier-return-payloads.test.ts`, `test/supplier-return.test.ts`),
 * and the SQL routines are tested against the same files
 * (PHASE_3_S5_CONTRACT T-02, T-07, T-14). Regenerate only when the SPEC
 * changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInvplS5Vectors, buildSupplierReturnVectors, renderInvplS5Vectors, renderSupplierReturnVectors } from './s5-vector-cases';

async function main(): Promise<void> {
  const dir = join(__dirname, '..', 'vectors');
  writeFileSync(join(dir, 'invpl-s5-vectors.json'), await renderInvplS5Vectors(), 'utf8');
  writeFileSync(join(dir, 'supplier-return-vectors.json'), await renderSupplierReturnVectors(), 'utf8');
  const p = buildInvplS5Vectors();
  const r = buildSupplierReturnVectors();
  const returns = r.cases.reduce((n, c) => n + c.returns.length, 0);
  process.stdout.write(`wrote ${p.cases.length} invpl/1 P3-S5 vectors, ${r.cases.length} supplier-return cases (${returns} returns) to ${dir}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
