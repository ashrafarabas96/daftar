/**
 * THE PHASE 3 MIGRATION PREFIX — the historical invariant `gate:phase3:release`
 * protects once Phase 3 closes (docs/PHASE_3_S9_CONTRACT.md A-03).
 *
 * Phase 3 froze 17 migrations, `0053` through `0069`, over slices P3-S1 … P3-S8.
 * What must stay true about that release for every later phase is exactly
 * this: those 17 files remain complete, ordered, immutable and byte-identical
 * to the accepted prefix. Nothing about Phase 3 says anything about files that
 * come after it.
 *
 * This is the twin of `scripts/phase2-prefix.ts`, and it inherits that
 * module's lesson. Until P3-S1 the Phase 2 release gate asserted "no migration
 * may exist after 0052", a true sentence about one closure slice written as a
 * permanent property of the tree, and the first authorized successor migration
 * made every later tree fail. No sentence of the form "nothing after 0069"
 * belongs here or in any gate. P3-S9's own zero-migration claim is about one
 * release and lives only in its evidence (`scripts/phase3-s9-evidence.ts`).
 *
 * ── What is checked, and what is deliberately not ────────────────────────
 *
 *   1. Every accepted file exists under its accepted name and hashes to its
 *      accepted digest. The digests are a literal copy, NOT read from today's
 *      manifest, so changing a file and its manifest entry together is still
 *      refused.
 *   2. The files on disk that fall in the prefix range (numbered 0053–0069, or
 *      sorting between its first and last names) are exactly the accepted
 *      names, in order. A rename, a deletion or an inserted file is refused.
 *   3. The manifest entries that follow the Phase 2 prefix are exactly the
 *      accepted pairs in order, and no later entry sorts into the range.
 *   4. `frozenThrough` is at least the prefix end: the prefix stays frozen.
 *
 * Entries 0000–0052 are `checkPhase2Prefix`'s, and migrations after 0069 are
 * permitted and not examined: protecting them is the job of the gate of the
 * phase that creates them, of the manifest check, of `verify:history` and of
 * the runner's own checksum refusal.
 *
 * Run standalone against any tree: `npx tsx scripts/phase3-prefix.ts --root=<dir>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE2_PREFIX } from './phase2-prefix';

/**
 * The accepted Phase 3 migration prefix. Entries 0053–0068 are copied from
 * the manifest (entries 53–68) as P3-S7 froze it; 0069 is the P3-S8 file under
 * the Tech Lead's B-1 ruling R-B1a, at the digest the S8 freeze records.
 */
export const PHASE3_PREFIX: readonly (readonly [name: string, sha256: string])[] = [
  ['0053_inventory_units_and_product_configuration.sql', '63940fbcf2c5a3cd99a20280cd83fe53198a0e2d0e2dc0db7ed80d31c47bd3e6'],
  ['0054_inventory_assertion_authority.sql', '7205dea79f090ecf8ded122557d92b2b9669463ce3e5aefca466a968ef9aa450'],
  ['0055_inventory_configure_product.sql', '6652cd5949ad2d9bdda559e23174b850f3cf6bcc2a54d307c5fb9a0a1f5fa2b7'],
  ['0056_inventory_branch_warehouses.sql', '2de288c370e90df5c304ccf354638d178452798662d83054c6a8df8c6f7195a5'],
  ['0057_inventory_permissions.sql', 'f6c7b56f920215cc8ba3e84d24e4f353329edab8dccb8d4e43a66712f7c1941d'],
  ['0058_accounting_entry_date_guard.sql', '455973c26bfdf0a185112a4e20a24676d54b5c4c7d4d1232f3e2dce3046b431a'],
  ['0059_inventory_stock_ledger.sql', '4d613225cf880c653918d7106f7fdcecbbda6adfa64d6c7dc2b991e49eb6494d'],
  ['0060_inventory_stock_primitive.sql', 'be240e163a7894dc2de4a384a9a86e47addf0ea10c60fadc0e8c6341c278d66b'],
  ['0061_inventory_movement_sources.sql', '7b785537a866606990ab2cfab2a783eb05fe7fb362a67f9ea127119d569f57ff'],
  ['0062_inventory_movement_commands.sql', 'dc47df235cc563606705de2a3a991992e573486bfa8d6a8493eb744129bb4b91'],
  ['0063_purchases_suppliers_sources.sql', 'bf505fbad5ac4b32d1de2dba729fcd61f7a0651b3b99c8f38e5c2c4980c0a5fe'],
  ['0064_purchase_commands.sql', 'b82e01810568390d21156ae555a7fbd35a990e33d8b280361bc85eaa6c7074ad'],
  ['0065_supplier_returns_reversals_sources.sql', 'fbf674d2663854da31024932df428ec9d16ccdbda15d3c83a10dbcf554b95e68'],
  ['0066_supplier_return_reversal_commands.sql', 'a9d5e6175a99677db33ebbadfac6ac41310fbc97cbc8390ac669534679eeef9e'],
  ['0067_payment_methods_supplier_settlement_sources.sql', '81363f1adf8a296b94690baee4766bcacfa72520477b26f8044cccda398fe660'],
  ['0068_supplier_settlement_commands.sql', 'dafad8c698b8668eef24b38315117b3813ceeeaad7cc84b9089ab66b3be89a04'],
  ['0069_inventory_reconciliation_read_and_account_domain.sql', '912299e90a937b684b1829df4be90d5815ee61bcee79d9a01c5e47c4d6fe3084'],
];

function nameAt(i: number): string {
  const pair = PHASE3_PREFIX[i];
  if (pair === undefined) throw new Error(`the Phase 3 prefix literal has no entry ${i}`);
  return pair[0];
}

export const PHASE3_PREFIX_START = nameAt(0);
export const PHASE3_PREFIX_END = nameAt(PHASE3_PREFIX.length - 1);
const START_NUMBER = Number(PHASE3_PREFIX_START.slice(0, 4));
const END_NUMBER = Number(PHASE3_PREFIX_END.slice(0, 4));

/** The manifest index of the first Phase 3 entry: it follows the Phase 2 prefix directly. */
const MANIFEST_OFFSET = PHASE2_PREFIX.length;

/**
 * The last migration each accepted Phase 3 slice left frozen, by full name.
 * P3-S7 shipped no migration, so its head is P3-S6's. The deployment matrix
 * (Case H) upgrades a deployer-built database from one head to the next.
 */
export const PHASE3_SLICE_HEADS: Readonly<Record<'P3-S1' | 'P3-S2' | 'P3-S3' | 'P3-S4' | 'P3-S5' | 'P3-S6' | 'P3-S7' | 'P3-S8', string>> = {
  'P3-S1': '0058_accounting_entry_date_guard.sql',
  'P3-S2': '0060_inventory_stock_primitive.sql',
  'P3-S3': '0062_inventory_movement_commands.sql',
  'P3-S4': '0064_purchase_commands.sql',
  'P3-S5': '0066_supplier_return_reversal_commands.sql',
  'P3-S6': '0068_supplier_settlement_commands.sql',
  'P3-S7': '0068_supplier_settlement_commands.sql',
  'P3-S8': '0069_inventory_reconciliation_read_and_account_domain.sql',
};

function inPrefixRange(file: string): boolean {
  const n = /^(\d+)_/.exec(file);
  return (file >= PHASE3_PREFIX_START && file <= PHASE3_PREFIX_END) || (n !== null && Number(n[1]) >= START_NUMBER && Number(n[1]) <= END_NUMBER);
}

export function checkPhase3Prefix(migrationsDir: string, manifestPath: string): string[] {
  const problems: string[] = [];
  const expectedNames = PHASE3_PREFIX.map(([name]) => name);
  const range = `${PHASE3_PREFIX_START.slice(0, 4)}–${PHASE3_PREFIX_END.slice(0, 4)}`;

  for (const [name, sha256] of PHASE3_PREFIX) {
    const path = join(migrationsDir, name);
    if (!existsSync(path)) {
      problems.push(`${name} belongs to the accepted Phase 3 prefix but is missing`);
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== sha256) problems.push(`${name} hashes to ${onDisk.slice(0, 12)}… but was accepted at ${sha256.slice(0, 12)}…`);
  }

  const inRange = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && inPrefixRange(f))
    .sort();
  if (inRange.join('\n') !== expectedNames.join('\n')) {
    const extra = inRange.filter((f) => !expectedNames.includes(f));
    for (const f of extra) problems.push(`${f} is in the Phase 3 range ${range} but is not an accepted Phase 3 migration`);
    if (extra.length === 0 && problems.length === 0) problems.push('the Phase 3 migrations on disk are not the accepted prefix in its accepted order');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };
  if (!(manifest.frozenThrough >= PHASE3_PREFIX_END)) {
    problems.push(`frozenThrough is ${manifest.frozenThrough}; the Phase 3 prefix must stay frozen through ${PHASE3_PREFIX_END}`);
  }
  PHASE3_PREFIX.forEach(([name, sha256], i) => {
    const at = MANIFEST_OFFSET + i;
    const m = manifest.migrations[at];
    if (!m) problems.push(`the manifest ends before entry ${at} (${name}) of the Phase 3 prefix`);
    else if (m.name !== name) problems.push(`manifest entry ${at} is ${m.name}; the accepted Phase 3 prefix has ${name} there`);
    else if (m.sha256 !== sha256) problems.push(`the manifest records ${name} at ${m.sha256.slice(0, 12)}… but it was accepted at ${sha256.slice(0, 12)}…`);
  });
  for (const m of manifest.migrations.slice(MANIFEST_OFFSET + PHASE3_PREFIX.length)) {
    if (inPrefixRange(m.name)) problems.push(`manifest entry ${m.name} follows the Phase 3 prefix but belongs to its range`);
  }
  return problems;
}

if (require.main === module) {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const problems = checkPhase3Prefix(join(root, 'infrastructure/database/migrations'), join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'));
  if (problems.length > 0) {
    console.error(`FAIL Phase 3 migration prefix at ${root}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `PASS Phase 3 migration prefix at ${root}: ${PHASE3_PREFIX.length} migrations ${PHASE3_PREFIX_START.slice(0, 4)}–${PHASE3_PREFIX_END.slice(0, 4)} intact; later migrations permitted`,
  );
}
