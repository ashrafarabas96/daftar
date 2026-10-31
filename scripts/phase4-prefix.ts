/**
 * THE PHASE 4 MIGRATION PREFIX — the historical invariant every Phase 4 gate
 * protects, and the one `gate:phase4:release` will protect after Phase 4 closes
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-60).
 *
 * This is the twin of `scripts/phase3-prefix.ts` and `scripts/phase2-prefix.ts`
 * and it inherits their lesson, which is the only reason this file is written
 * before the migration it protects exists.
 *
 * ── `[[daftar-a-closure-rule-is-not-an-invariant]]` ──────────────────────
 *
 * Until P3-S1 the Phase 2 release gate asserted "no migration may exist after
 * 0052". That was a true sentence about the P2-S9 closure slice, written as a
 * permanent property of the tree, and the first authorized successor migration
 * (`0053`) made every later tree fail: a predecessor's gate was forbidding
 * forward evolution, and correcting it cost a commit and a seal.
 *
 * So no line of this module, and no line of any permanent Phase 4 gate, may
 * contain a sentence of the form "nothing after N". Concretely, in this file:
 *
 *   — `frozenThrough` is compared with `>=`, as a FLOOR, never with `===`;
 *   — the only names this module knows are names already accepted, and it
 *     asserts nothing whatever about a file numbered past the last of them;
 *   — the number 74, the name `0074_…` and the count of files on disk appear
 *     in no assertion. `PHASE4_FIRST_NUMBER` is DERIVED from the inherited
 *     prefix, so it stays correct without being edited.
 *
 * ── What is checked ──────────────────────────────────────────────────────
 *
 *   0. The inherited prefix `0000–0073` is intact, byte for byte, by delegation
 *      to the two accepted modules that own it (`checkPhase2Prefix`,
 *      `checkPhase3Prefix`). No digest is copied a second time here: a digest
 *      copied twice is a digest that can disagree with itself.
 *   1. Every accepted Phase 4 file exists under its accepted name and hashes to
 *      its accepted digest. The digests are a literal copy, NOT read from
 *      today's manifest, so changing a file and its manifest entry together is
 *      still refused.
 *   2. The files on disk inside the accepted Phase 4 RANGE — from the first
 *      accepted Phase 4 name to the LAST ACCEPTED one, never to infinity — are
 *      exactly the accepted names, in order. A rename, a deletion or a file
 *      inserted between two accepted migrations is refused.
 *   3. The manifest entries at `MANIFEST_OFFSET` are exactly the accepted pairs
 *      in order, and no later entry sorts into the accepted range.
 *   4. `frozenThrough` is at least the prefix end: the prefix stays frozen.
 *   5. The literal itself is well formed: the accepted Phase 4 names are
 *      numbered contiguously and begin exactly one past the inherited prefix,
 *      so a migration cannot be quietly dropped from the literal.
 *
 * ── Correct today, correct after `0074` ──────────────────────────────────
 *
 * This module was written while `PHASE4_PREFIX` was still empty — before the
 * first Phase 4 migration existed — and the arrival of that migration required
 * no edit to any check here, which was the point. P4-S1's acceptance commit
 * appended its three `[name, sha256]` pairs to `PHASE4_S1_PREFIX` below, and the
 * same code began protecting them: checks 1–3 and 5 became live over exactly
 * those three names, check 0 is still the whole inherited history, and check 4
 * is still a floor — now at the last accepted Phase 4 name rather than at the
 * inherited head. Nothing is asserted about a file numbered past the last
 * ACCEPTED name, so P4-S2's first migration cannot make this module fail
 * either. Each later slice is accepted the same way: append to that slice's
 * sub-prefix, change nothing else, and none of the checks changes shape.
 *
 * The candidate tense — "`frozenThrough` is exactly the previous head and the
 * files after it are exactly this slice's list" — is deliberately NOT here. It
 * is a closure rule about one open slice, it lives only in the gate of the slice
 * currently open, and that slice's acceptance commit deletes it (P4-AL-61).
 *
 * Run standalone against any tree: `npx tsx scripts/phase4-prefix.ts --root=<dir>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE2_PREFIX, checkPhase2Prefix } from './phase2-prefix';
import { PHASE3_PREFIX, PHASE3_PREFIX_END, checkPhase3Prefix } from './phase3-prefix';

export type Prefix = readonly (readonly [name: string, sha256: string])[];

/**
 * The migration history Phase 4 inherits and may not touch: the accepted
 * Phase 2 prefix followed by the accepted Phase 3 prefix, `0000–0073`. The
 * names and digests live in those two modules and are not repeated here.
 */
export const PHASE4_INHERITED_PREFIX: Prefix = [...PHASE2_PREFIX, ...PHASE3_PREFIX];

/** The last inherited migration: the floor `frozenThrough` may never retreat below. */
export const PHASE4_INHERITED_PREFIX_END = PHASE3_PREFIX_END;

/**
 * The manifest index of the first Phase 4 entry: it follows the inherited
 * prefix directly. Derived, never hard-coded (P4-AL-60).
 */
export const MANIFEST_OFFSET = PHASE2_PREFIX.length + PHASE3_PREFIX.length;

/** The number the first Phase 4 migration carries. Derived from the inherited prefix, so `0074` is written nowhere. */
export const PHASE4_FIRST_NUMBER = Number(PHASE4_INHERITED_PREFIX_END.slice(0, 4)) + 1;

// ─────────────────────────────────────────────────────────────────────────
// The accepted Phase 4 migrations, per slice, in acceptance order.
//
// Each list is EMPTY until that slice's acceptance commit, which appends the
// `[name, sha256]` pairs exactly as the manifest froze them — the same
// provenance shape as PHASE3_SLICE_PREFIX / PHASE3_CORRECTIVE_PREFIX. An empty
// list is not a claim that the slice has no migration; it is the absence of an
// accepted one, which is why nothing below asserts a count.
// ─────────────────────────────────────────────────────────────────────────

/**
 * P4-S1 — customers, sales documents and per-business document numbering.
 * Accepted and frozen by the P4-S1 seal commit; the digests are the ones the
 * manifest froze, computed from the files in the accepted candidate tree.
 */
export const PHASE4_S1_PREFIX: Prefix = [
  ['0074_phase4_registry_widening.sql', '8f8fa9c080661255f77a6a036292bc8cd786a3c8f5a22a38f359cbbdaf66901d'],
  ['0075_phase4_customers_invoices_numbering.sql', 'b5d64176c3af9fb38a56b26f3e767a36fd2fd4a583423a1f60b3165d5f239905'],
  ['0076_phase4_permission_defaults_backfill.sql', '2bbad56286ac06e988e4d590b290957fbb716313a6d82c4ba85c1f164bc3dcec'],
];
/**
 * P4-S2 — the sale commit primitive and the stock source bridge.
 * Accepted and frozen by the P4-S2 seal commit; the digests are the ones the
 * manifest froze, computed from the files in the accepted candidate tree.
 */
export const PHASE4_S2_PREFIX: Prefix = [
  ['0077_phase4_sales_sale_items_sources.sql', '9d9c34f83b77085b8e8d85aeb457ce9df9c011084b25d382ad7d323b4f544237'],
  ['0078_phase4_sale_commit.sql', '8a11b768c3259a75d0e341f20b97037146ae8b40e9dc7f86655f77ba1b6dc730'],
];
/** P4-S3 — POS till sessions and cart lines. */
export const PHASE4_S3_PREFIX: Prefix = [['0079_phase4_pos_till_sessions_cart.sql', '1dd406985f6800244e0a0d8a14248595330f6995d3e867e483eda6b9affa173f']];
/** P4-S4 — payments, allocation, customer credit. */
export const PHASE4_S4_PREFIX: Prefix = [];
/** P4-S5 — returns, credit notes, refunds. */
export const PHASE4_S5_PREFIX: Prefix = [];
/** P4-S6 — reversals and the void path. */
export const PHASE4_S6_PREFIX: Prefix = [];
/** P4-S7 — installment plans and instalments. */
export const PHASE4_S7_PREFIX: Prefix = [];
/** P4-S8 — hardening; any index a measured budget proved necessary. */
export const PHASE4_S8_PREFIX: Prefix = [];

/** The accepted Phase 4 migration history so far, in order. Empty until the first Phase 4 acceptance. */
export const PHASE4_PREFIX: Prefix = [
  ...PHASE4_S1_PREFIX,
  ...PHASE4_S2_PREFIX,
  ...PHASE4_S3_PREFIX,
  ...PHASE4_S4_PREFIX,
  ...PHASE4_S5_PREFIX,
  ...PHASE4_S6_PREFIX,
  ...PHASE4_S7_PREFIX,
  ...PHASE4_S8_PREFIX,
];

/** The last migration each accepted Phase 4 slice left frozen, by full name. Filled by the same acceptance commit. */
export const PHASE4_SLICE_HEADS: Readonly<Record<string, string>> = {
  'P4-S1': '0076_phase4_permission_defaults_backfill.sql',
  'P4-S2': '0078_phase4_sale_commit.sql',
  'P4-S3': '0079_phase4_pos_till_sessions_cart.sql',
};

const migrationNumber = (file: string): number | null => {
  const m = /^(\d+)_/.exec(file);
  return m ? Number(m[1]) : null;
};

/** The name of entry `i` of a prefix literal, or `null` when the literal is shorter. */
const nameAt = (prefix: Prefix, i: number): string | null => prefix[i]?.[0] ?? null;

/**
 * The last accepted Phase 4 migration, or `null` while none is accepted. This
 * is the ONLY upper bound this module knows, and it is a name that has already
 * been accepted — never the current last file on disk.
 */
export const phase4PrefixEnd = (prefix: Prefix = PHASE4_PREFIX): string | null => nameAt(prefix, prefix.length - 1);

/**
 * The floor `frozenThrough` must reach: the last accepted Phase 4 migration
 * while there is one, the inherited prefix's end before that. A floor, so a
 * manifest frozen further ahead than this module knows about is fine.
 */
export const frozenThroughFloor = (prefix: Prefix = PHASE4_PREFIX): string => phase4PrefixEnd(prefix) ?? PHASE4_INHERITED_PREFIX_END;

/**
 * Whether `file` falls inside the accepted Phase 4 range: between the first and
 * the LAST ACCEPTED Phase 4 name, by name and by number. With no accepted
 * Phase 4 migration the range is empty and this is false for every file, which
 * is exactly why a new `0074` does not make this module fail.
 */
export function inPhase4PrefixRange(file: string, prefix: Prefix = PHASE4_PREFIX): boolean {
  const start = nameAt(prefix, 0);
  const end = phase4PrefixEnd(prefix);
  if (start === null || end === null) return false;
  const n = migrationNumber(file);
  return (file >= start && file <= end) || (n !== null && n >= Number(start.slice(0, 4)) && n <= Number(end.slice(0, 4)));
}

/**
 * The migration files on disk that are Phase 4's: numbered past the inherited
 * prefix. Not an assertion — a fact a gate needs in order to decide whether its
 * Phase 4 checks are applicable yet.
 */
export function phase4MigrationsOnDisk(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const n = migrationNumber(f);
      return n !== null ? n >= PHASE4_FIRST_NUMBER : f > PHASE4_INHERITED_PREFIX_END;
    })
    .sort();
}

interface Manifest {
  readonly frozenThrough: string;
  readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
}

/** Check 5: the literal is well formed — contiguous, and starting one past the inherited prefix. */
export function phase4PrefixLiteralProblems(prefix: Prefix = PHASE4_PREFIX): string[] {
  const problems: string[] = [];
  prefix.forEach(([name], i) => {
    const n = migrationNumber(name);
    if (n === null) {
      problems.push(`the Phase 4 prefix literal entry ${i} (${name}) is not a numbered migration`);
      return;
    }
    const expected = PHASE4_FIRST_NUMBER + i;
    if (n !== expected)
      problems.push(
        `the Phase 4 prefix literal entry ${i} is ${name}; the accepted Phase 4 history is contiguous from ${String(PHASE4_FIRST_NUMBER).padStart(4, '0')}, so it is numbered ${String(expected).padStart(4, '0')}`,
      );
  });
  return problems;
}

/**
 * The problems of the Phase 4 migration prefix under `migrationsDir` /
 * `manifestPath`, empty when the invariant holds.
 *
 * `prefix` is a parameter so a red proof can hand this function a fixture
 * prefix (an accepted Phase 4 history that is not today's) and watch the same
 * code refuse a tampered tree. Every permanent caller uses the default.
 */
export function checkPhase4Prefix(migrationsDir: string, manifestPath: string, prefix: Prefix = PHASE4_PREFIX): string[] {
  const problems: string[] = [
    ...checkPhase2Prefix(migrationsDir, manifestPath).map((p) => `the inherited Phase 2 prefix: ${p}`),
    ...checkPhase3Prefix(migrationsDir, manifestPath).map((p) => `the inherited Phase 3 prefix: ${p}`),
    ...phase4PrefixLiteralProblems(prefix),
  ];

  for (const [name, sha256] of prefix) {
    const path = join(migrationsDir, name);
    if (!existsSync(path)) {
      problems.push(`${name} belongs to the accepted Phase 4 prefix but is missing`);
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== sha256) problems.push(`${name} hashes to ${onDisk.slice(0, 12)}… but was accepted at ${sha256.slice(0, 12)}…`);
  }

  const expectedNames = prefix.map(([name]) => name);
  const end = phase4PrefixEnd(prefix);
  if (end !== null) {
    const inRange = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && inPhase4PrefixRange(f, prefix))
      .sort();
    if (inRange.join('\n') !== expectedNames.join('\n')) {
      const range = `${expectedNames[0]?.slice(0, 4) ?? ''}–${end.slice(0, 4)}`;
      const extra = inRange.filter((f) => !expectedNames.includes(f));
      for (const f of extra) problems.push(`${f} is in the accepted Phase 4 range ${range} but is not an accepted Phase 4 migration`);
      if (extra.length === 0) problems.push(`the Phase 4 migrations on disk are not the accepted prefix in its accepted order (range ${range})`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const floor = frozenThroughFloor(prefix);
  // A FLOOR. `>=`, never `===`: a manifest frozen past what this module knows
  // is a later slice doing its job, not a violation.
  if (!(manifest.frozenThrough >= floor)) {
    problems.push(`frozenThrough is ${manifest.frozenThrough}; the accepted history must stay frozen through at least ${floor}`);
  }
  prefix.forEach(([name, sha256], i) => {
    const at = MANIFEST_OFFSET + i;
    const m = manifest.migrations[at];
    if (!m) problems.push(`the manifest ends before entry ${at} (${name}) of the Phase 4 prefix`);
    else if (m.name !== name) problems.push(`manifest entry ${at} is ${m.name}; the accepted Phase 4 prefix has ${name} there`);
    else if (m.sha256 !== sha256) problems.push(`the manifest records ${name} at ${m.sha256.slice(0, 12)}… but it was accepted at ${sha256.slice(0, 12)}…`);
  });
  for (const m of manifest.migrations.slice(MANIFEST_OFFSET + prefix.length)) {
    if (inPhase4PrefixRange(m.name, prefix)) problems.push(`manifest entry ${m.name} follows the Phase 4 prefix but belongs to its range`);
  }
  return problems;
}

if (require.main === module) {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const migrationsDir = join(root, 'infrastructure/database/migrations');
  const problems = checkPhase4Prefix(migrationsDir, join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'));
  if (problems.length > 0) {
    console.error(`FAIL Phase 4 migration prefix at ${root}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const end = phase4PrefixEnd();
  const onDisk = phase4MigrationsOnDisk(migrationsDir);
  console.log(
    `PASS Phase 4 migration prefix at ${root}: the inherited ${PHASE4_INHERITED_PREFIX.length} migrations 0000–${PHASE4_INHERITED_PREFIX_END.slice(0, 4)} intact byte for byte; ` +
      (end === null
        ? `no Phase 4 migration is accepted yet, so nothing is asserted about files numbered ${String(PHASE4_FIRST_NUMBER).padStart(4, '0')} and up (${onDisk.length} on disk)`
        : `${PHASE4_PREFIX.length} accepted Phase 4 migrations through ${end.slice(0, 4)} intact`) +
      `; frozenThrough is a floor at ${frozenThroughFloor()}; later migrations permitted`,
  );
}
