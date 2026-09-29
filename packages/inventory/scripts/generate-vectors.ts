/**
 * Regenerates `vectors/invpl-vectors.json` from `scripts/vector-cases.ts`.
 *
 * Run with `npx tsx packages/inventory/scripts/generate-vectors.ts`. The
 * committed file is checked byte-for-byte by `test/vectors.test.ts`, so a
 * change to the canonicalizer or the minter that is not followed by a
 * regeneration fails the unit suite — and a regeneration that changes an
 * existing digest fails the SQL parity test, which is the point.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInventoryVectors, renderInventoryVectors } from './vector-cases';

const target = join(__dirname, '..', 'vectors', 'invpl-vectors.json');
writeFileSync(target, renderInventoryVectors(), 'utf8');
const v = buildInventoryVectors();
process.stdout.write(`wrote ${v.invpl.cases.length} invpl/1 and ${v.invctl.cases.length} invctl/1 vectors to ${target}\n`);
