/**
 * Regenerates `vectors/valuation-vectors.json` from the LITERAL cases in
 * `scripts/valuation-vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-valuation-vectors.ts`.
 * The committed file is checked byte-for-byte by
 * `test/valuation-vectors.test.ts`, which also replays every case through the
 * package's functions. The SQL primitive and `inventory_half_even` are tested
 * against the same file, so a regeneration that changes an expected number
 * fails the SQL parity suite — which is the point. Regenerate only when the
 * SPEC changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildValuationVectors, renderValuationVectors } from './valuation-vector-cases';

const target = join(__dirname, '..', 'vectors', 'valuation-vectors.json');
writeFileSync(target, renderValuationVectors(), 'utf8');
const v = buildValuationVectors();
process.stdout.write(
  `wrote ${v.precision.length} precision, ${v.rounding.length} rounding, ${v.scenarios.length} scenario and ${v.controls.length} control vectors to ${target}\n`,
);
