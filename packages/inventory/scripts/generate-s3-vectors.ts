/**
 * Regenerates `vectors/invpl-s3-vectors.json` and
 * `vectors/allocation-vectors.json` from `scripts/s3-vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-s3-vectors.ts`. Both
 * committed files are checked byte-for-byte by the unit suite
 * (`test/movement-payloads.test.ts`, `test/allocation.test.ts`), and the SQL
 * twins are tested against the same files (T-16). Regenerate only when the
 * SPEC changed: a regeneration that changes an existing digest or share fails
 * the SQL parity suite, which is the point.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllocationVectors, buildInvplS3Vectors, renderAllocationVectors, renderInvplS3Vectors } from './s3-vector-cases';

async function main(): Promise<void> {
  const dir = join(__dirname, '..', 'vectors');
  writeFileSync(join(dir, 'invpl-s3-vectors.json'), await renderInvplS3Vectors(), 'utf8');
  writeFileSync(join(dir, 'allocation-vectors.json'), await renderAllocationVectors(), 'utf8');
  const p = buildInvplS3Vectors();
  const a = buildAllocationVectors();
  process.stdout.write(
    `wrote ${p.cases.length} invpl/1 P3-S3 and ${p.reasons.length} reason vectors, ${a.cases.length} allocation and ${a.openings.length} opening vectors to ${dir}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
