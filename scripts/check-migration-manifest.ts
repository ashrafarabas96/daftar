/**
 * Migration manifest guard (Execution Contract §IV + §CXLII).
 * Migrations listed in infrastructure/database/MIGRATION_MANIFEST.json are
 * FROZEN (PATH A — pre-release freeze). This script fails CI if:
 *  - a frozen migration's bytes changed (SHA-256 mismatch),
 *  - a frozen migration file was deleted,
 *  - the manifest is missing or malformed.
 * New migrations (higher numbers than the frozen set) are allowed; they are
 * appended to the manifest only at release time.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '../infrastructure/database/migrations');
const MANIFEST = join(__dirname, '../infrastructure/database/MIGRATION_MANIFEST.json');

interface ManifestEntry {
  name: string;
  sha256: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { migrations?: ManifestEntry[] };
if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
  console.error('MIGRATION_MANIFEST.json is missing or has no migrations');
  process.exit(1);
}

const onDisk = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')));
let failures = 0;
for (const entry of manifest.migrations) {
  if (!onDisk.has(entry.name)) {
    console.error(`FROZEN migration deleted: ${entry.name}`);
    failures++;
    continue;
  }
  const sha = createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_DIR, entry.name)))
    .digest('hex');
  if (sha !== entry.sha256) {
    console.error(`FROZEN migration modified: ${entry.name} (expected ${entry.sha256}, got ${sha})`);
    failures++;
  }
}
if (failures > 0) {
  console.error(`Migration manifest check FAILED (${failures} violation(s)). Frozen migrations 0000–0027 must never change — add a new migration instead.`);
  process.exit(1);
}
console.log(`Migration manifest OK: ${manifest.migrations.length} frozen migrations verified.`);
