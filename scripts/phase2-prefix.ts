/**
 * THE PHASE 2 MIGRATION PREFIX — the historical invariant `gate:phase2:release`
 * protects after Phase 2 closed.
 *
 * Phase 2 was accepted, merged and closed at `0f2b09e7` (accepted head
 * `bf2eeda`) with 53 frozen migrations, `0000` through `0052`. What must stay
 * true about that release for every later phase is exactly this: those 53
 * files remain complete, ordered, immutable and byte-identical to the accepted
 * prefix. Nothing about Phase 2 says anything about files that come after it.
 *
 * ── The correction this module records ───────────────────────────────────
 *
 * Until P3-S1 the release gate asserted "no migration may exist after 0052"
 * (`phase2s9AddsNoMigration`, "P2-S9 creates no migration"). That was a true
 * sentence about the P2-S9 closure slice, which added no migration, but it was
 * written as a permanent property of the tree. The first authorized successor
 * migration (`0053`, P3-S1) made the gate fail on every later tree, frozen or
 * not: a predecessor's release gate was forbidding forward evolution. The
 * Tech Lead accepted that root cause on 2026-09-26 and authorized replacing the
 * assertion with the invariant below, and nothing else.
 *
 * ── What is checked, and what is deliberately not ────────────────────────
 *
 *   1. Every accepted file exists under its accepted name and hashes to its
 *      accepted digest. The digests are a literal copy taken from the accepted
 *      manifest, NOT read from today's manifest, so changing a file and its
 *      manifest entry together is still refused.
 *   2. The files on disk that fall in the prefix range (numbered 0000–0052, or
 *      sorting at or before its last name) are exactly the accepted names, in
 *      order. A rename, a deletion or an inserted file is refused.
 *   3. The manifest's first 53 entries are exactly the accepted (name, digest)
 *      pairs in order, no accepted name appears again later, and nothing after
 *      the prefix sorts into it.
 *   4. `frozenThrough` is at least the prefix end: the prefix stays frozen.
 *
 * Migrations after `0052` are permitted and are not examined here. Protecting
 * them is the job of the gate of the phase that created them, and of the
 * manifest check; this module knows no name after `0052`, so it stays valid for
 * every later phase without being edited.
 *
 * Run standalone against any tree: `npx tsx scripts/phase2-prefix.ts --root=<dir>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The accepted Phase 2 migration prefix, copied from the manifest at `0f2b09e7` (identical at `bf2eeda`). */
export const PHASE2_PREFIX: readonly (readonly [name: string, sha256: string])[] = [
  ['0000_extensions.sql', '1f37486fbad1f29f6918f223bf859e2c715dfcc972b49944495fba35515a14b7'],
  ['0001_platform.sql', '49a577344361791ba0c0c3d1d0969be70247744688b88b577d8d637e1dcb3aed'],
  ['0002_identity.sql', '1595dd0be8e385b0bb7f53411200fff558ab228abcd0759ac9c72ae484bcaf55'],
  ['0003_tenancy.sql', 'b72bcb3bd36e9aca1d2beaee01bd7ad324f098e542358a0984ea7a99e912818a'],
  ['0004_infra.sql', '07a647e9d38662cad0d6c00274823e8f0390b6071a3dc7c8afed1bd614d8cb49'],
  ['0005_catalog.sql', 'dafe23d27f2a62553bb65c9069a7e54b7d6f5559ff7cca2ea46e89c8c156f04a'],
  ['0006_rls.sql', '0670ccb65630ef017cc2aaccb2319e31ae4f6bded8fbe45b3fedeb54cf866e75'],
  ['0007_entitlements.sql', 'e790ef5b6b19837c4df6b7364e3c88737b6a3a9562d44eda0a0ff09277154717'],
  ['0008_multiuser_rbac.sql', 'befbd18e31d2e21acd6f21746a43e447a439650d064e3098f09ab196ac7a6fad'],
  ['0009_admin.sql', '1c46a75481d898116635e7338f913291378dc7660dd081af9e25503f3b320308'],
  ['0010_db_roles.sql', 'a21ae45158e92717e60628a6b7a7fad9cdd96c6a3a0e92197954fc679899fb9c'],
  ['0011_auth_lineage.sql', 'cc470416864a6c4e19ecf64e1216f127d676faacf42232c3c0f588bb33ae3b73'],
  ['0012_tenant_memberships.sql', 'e42669136d15c9e92114a62b7546ba3d68b6504456c7605ddc541bf8e1b5a82c'],
  ['0013_security_boundary.sql', 'a14a7c4744e3f41c8133b49540b96107536feb9724cf0427d02550c0cab7a14d'],
  ['0014_branch_scopes.sql', '5c6d02c2829c0eae8b200c4a56dba9df5d4659a62f9bf77486f5b0abfdaa88f5'],
  ['0015_identity_role.sql', 'ccc2725df0ff456c0e128992690f13b03d30335a3d8dc4125f39e1f9b2d5c74b'],
  ['0016_tenant_membership_invariant.sql', '154c71d92a98daf386926bb399bba3aec8c3399e40eec02f680f80133f4d2732'],
  ['0017_delivery_tracking.sql', 'c6f3cc98db5ccb735fb5d224a45fbcbac8a6dd1309aabdab405b99d54c357d52'],
  ['0018_onboarding_operations.sql', 'fe65bf8080b3b809e2f69b312906b9b50828340130c649ca79f77fcee8c8396d'],
  ['0019_owner_authority_integrity.sql', 'd93e7429fa35ef90c1ef140b69c5bc50bd3c7228cadf26a9acc322a9e546c435'],
  ['0020_credential_delivery_outbox.sql', 'a275d67fa6cd988b69d6282105908419e5da264a2e564023aaecf6c95206d0bc'],
  ['0021_saas_enforcement.sql', 'd929e205a687638246e65c4d62fe420f049e9f0acadacb9f7751ee1f8613f88d'],
  ['0022_plan_lifecycle_overrides.sql', '16804a7c476d672a9bb89f0aa3d7817eda59528b65b331cd4161a6884c334c57'],
  ['0023_country_timezone_locale.sql', '2fda39bf599532f98f3ddcb9f4e42c2995d9ee6364171d23c2da6e7f59c59716'],
  ['0024_role_crud_grants.sql', '839b13f6a4c83a7c11698b1fc21d1600e1732d4cea25f5053d6d30dc4c93cb7b'],
  ['0025_credential_payload_protection.sql', '8ce47be8329aa119873f35b64e2fe6791ed88a1c515ee0aba46689def83f6452'],
  ['0026_versioned_trial_override_shape_ownership.sql', 'b5b9e0e0d1ca3027e66b76bce7723c3a4f96c2b825973caf006d4639e8714152'],
  ['0027_plan_version_immutability_hardening.sql', '37909b885fc22514cf55aea7a5372c24d30f5b207c93810bac5e013e7da74fa9'],
  ['0028_credential_delivery_hardening.sql', '6b64bd760ebc37aee37ea360cd5804f935e37ec352572716d05d1d8a21a3bf1c'],
  ['0029_support_sessions.sql', 'cbaa85bf9777fc61942a1ec327ada3b3e830441adfbb195672cdead4b7338b09'],
  ['0030_provisioner_role.sql', '70941c698959b00b06c2b0315243fbb9f78ce56a7d9ee2e75733f27362771346'],
  ['0031_provisioner_entitlement_read.sql', '6de2c7561f75f912f3db356627bcf2306d27ff093ea743f48fa1a1a884cf85cb'],
  ['0032_provisioner_narrow_functions.sql', '694d57f7efd6584edb78305ff6c336ade85ae39e2e3be630a6ec73829dad4888'],
  ['0033_provisioner_atomic_authority.sql', 'de125a460e103b73a081696a808dacb4979727005a9c7b6c65a088bfc3ee3f51'],
  ['0034_platform_console_grants.sql', 'f9048997296e39b92e44bd2ee8bb13c3d843af6529dfbcc779dabdfcd21291c8'],
  ['0035_ownership_implication_and_indexes.sql', '847558583c005357972ce1c44c9bef66e39a08fb7cc74d4976d10572928dfa68'],
  ['0036_catalog_translations_normalized.sql', '7f1f4aa5f087e88cd2e292e26de0c9e9ee58fc20dafcc38fe6efda0376710343'],
  ['0037_catalog_identifiers.sql', '540fa71d28f3c3140935a7325b68667d1679abf461a1ecf84512b18eb3271aed'],
  ['0038_provisioning_assertions.sql', '1baa0f8aa0b318c9ee89e1f1863da1459607826bfe44e129a57bbaa0a5b1ca1b'],
  ['0039_catalog_identifiers_owner_integrity.sql', '935fb8b767054f2c919ff48968af28df6abb823e564f8cee8b2284b42520d9cd'],
  ['0040_accounting_chart.sql', '535c8182a922a8363df2c791759c3e1eff2790757e402e6e28a41a5d113651db'],
  ['0041_accounting_permissions.sql', '3aea7eedfd6ccb9d8fd93ed827d84abaa9923ccd3b01497960237098c19b1f77'],
  ['0042_accounting_journal.sql', '78c852cd1f5888013a02244327a1eb606e3f0fd9582fbbed2018b9382cb92e33'],
  ['0043_accounting_invariants.sql', '9744da043d3c8b3fe68af30b135e5f5f36207ec5b457d115a3f5a465d268e70f'],
  ['0044_accounting_assertion_keys.sql', 'cf49b196598e5dc829b56e656bc7883a2fed3a54f6631cf0bdf112c4521a0902'],
  ['0045_accounting_post_entry.sql', '84fa101e1c25e880b7850a96abd05a5efabd068cec56397c3b465ca11847cb2e'],
  ['0046_accounting_sources.sql', '6e4500dcc639149ac25d3e0736bbce77ff372aa06736c1211fe40725e7d196e6'],
  ['0047_accounting_opening_balances.sql', '0938d513c0bb844c5f36cbdb170612a08f9f52f828660ca88e2db00aeea1cabc'],
  ['0048_accounting_fx_rates.sql', '5438538a9f335c918b231db3faa94dd4eac7b71a1a688d1c62b5cda9f8ee4cc1'],
  ['0049_accounting_periods.sql', '454a52183f8666f88bbf17b87b4b44e6413114af069149d2eb2489854307d851'],
  ['0050_accounting_report_indexes.sql', 'ef20a42788c503317c1e4b9bb69ada47e547faf42330bb1bc0d8e0a2f4c18356'],
  ['0051_accounting_reconciler_read.sql', '2086c87564f5f66243ab64753e7c4f5338f896a1e29984ddf8977be8ba7587cc'],
  ['0052_accounting_journal_lines_rls_performance.sql', '0acf165003c678f8d3017797e77033fadf2e9e791be54f98048031108c72ad84'],
];

export const PHASE2_PREFIX_END = PHASE2_PREFIX[PHASE2_PREFIX.length - 1][0];
const PREFIX_END_NUMBER = Number(PHASE2_PREFIX_END.slice(0, 4));

function inPrefixRange(file: string): boolean {
  const n = /^(\d+)_/.exec(file);
  return file <= PHASE2_PREFIX_END || (n !== null && Number(n[1]) <= PREFIX_END_NUMBER);
}

export function checkPhase2Prefix(migrationsDir: string, manifestPath: string): string[] {
  const problems: string[] = [];
  const expectedNames = PHASE2_PREFIX.map(([name]) => name);

  for (const [name, sha256] of PHASE2_PREFIX) {
    const path = join(migrationsDir, name);
    if (!existsSync(path)) {
      problems.push(`${name} belongs to the accepted Phase 2 prefix but is missing`);
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
    for (const f of extra) problems.push(`${f} is in the Phase 2 range 0000–${PHASE2_PREFIX_END.slice(0, 4)} but is not an accepted Phase 2 migration`);
    if (extra.length === 0 && problems.length === 0) problems.push('the Phase 2 migrations on disk are not the accepted prefix in its accepted order');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };
  if (!(manifest.frozenThrough >= PHASE2_PREFIX_END)) {
    problems.push(`frozenThrough is ${manifest.frozenThrough}; the Phase 2 prefix must stay frozen through ${PHASE2_PREFIX_END}`);
  }
  PHASE2_PREFIX.forEach(([name, sha256], i) => {
    const m = manifest.migrations[i];
    if (!m) problems.push(`the manifest ends before entry ${i} (${name}) of the Phase 2 prefix`);
    else if (m.name !== name) problems.push(`manifest entry ${i} is ${m.name}; the accepted Phase 2 prefix has ${name} there`);
    else if (m.sha256 !== sha256) problems.push(`the manifest records ${name} at ${m.sha256.slice(0, 12)}… but it was accepted at ${sha256.slice(0, 12)}…`);
  });
  for (const m of manifest.migrations.slice(PHASE2_PREFIX.length)) {
    if (inPrefixRange(m.name)) problems.push(`manifest entry ${m.name} follows the Phase 2 prefix but belongs to its range`);
  }
  return problems;
}

if (require.main === module) {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const problems = checkPhase2Prefix(join(root, 'infrastructure/database/migrations'), join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'));
  if (problems.length > 0) {
    console.error(`FAIL Phase 2 migration prefix at ${root}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`PASS Phase 2 migration prefix at ${root}: ${PHASE2_PREFIX.length} migrations 0000–${PHASE2_PREFIX_END.slice(0, 4)} intact`);
}
