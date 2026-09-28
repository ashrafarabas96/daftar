#!/usr/bin/env tsx
/**
 * PHASE 3 CORRECTIVE GATE — `npm run gate:phase3:corrective`
 * (the Tech Lead's corrective directive §18, §19; docs/PHASE_3_FINAL_CORRECTIVE_AUDIT.md
 * requirement O).
 *
 * The permanent gate of the Phase 3 corrective pass. It proves every
 * corrected blocker and is composed by `gate:phase3:release` in place of
 * `gate:phase3:s8`, which it composes itself.
 *
 * Two tenses, chosen by `CORRECTIVE_ACCEPTED` alone (the S8 form,
 * `scripts/phase3-s8-gate.ts`):
 *
 *   — CANDIDATE (`CORRECTIVE_ACCEPTED` empty): `frozenThrough` is exactly the
 *     Phase 3 boundary 0069, the files after it are exactly
 *     `CORRECTIVE_MIGRATIONS`, and none of them is recorded in the manifest.
 *   — ACCEPTED (`CORRECTIVE_ACCEPTED` holds a digest for every corrective
 *     migration): `frozenThrough` is a floor at the last corrective file, and
 *     each hashes to its accepted digest on disk and in the manifest.
 *
 * Directive §18: a corrective migration is "Phase 3 corrective hardening",
 * never a Phase 4 migration, and it is frozen only after this gate passes.
 *
 * WHAT MAY NOT PASS SILENTLY
 *
 * Every required entry this gate names (a suite, a command, the full-range
 * secret scan, a red proof) is either filled or `{ pending }`. A pending entry
 * is a structural FAIL, never a skip: the gate stays red until the coordinator
 * fills it from the stream that owns it. A listed suite that is missing, or
 * that carries `.skip`, `.only` or `.todo`, fails; so does a `p3c-*` suite on
 * disk that no entry lists.
 *
 * The real-browser matrix (directive §8) is declared here, `BROWSER_MATRIX`,
 * and must equal what `tests/browser/config.ts` runs and cover the
 * directive's floor: removing `tr` or a viewport is a structural FAIL, and so
 * is removing a planted-defect kind the red proof relies on.
 *
 * The runtime half composes `gate:phase3:s8` first (which composes P3-S7 …
 * P3-S1, P2-S8 … P2-S1 and Phase 1), then the corrective suites, the
 * corrective commands, the real-browser red proof and the full matrix, and
 * Budget A (and B) in isolation, last.
 *
 * `--root <dir>` and `--structural-only` exist for the red proofs
 * (tests/security/p3c-corrective-gate-tamper.test.ts): they change WHERE the
 * gate looks, never WHAT it demands, and a structural-only run reports no
 * verdict on tests it did not run.
 *
 * Usage: npm run gate:phase3:corrective [-- --list] [--root <dir> --structural-only]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkPhase3Prefix } from './phase3-prefix';
import { testTitles } from './phase3-s8-gate';

// ─────────────────────────────────────────────────────────────────────────
// What the coordinator fills. Every `pending` below is a FAIL until filled.
// ─────────────────────────────────────────────────────────────────────────

/** The Phase 3 boundary: 0000–0069 are byte-immutable (directive §18). */
export const PHASE3_BOUNDARY = '0069_inventory_reconciliation_read_and_account_domain.sql';

/**
 * The corrective migrations, in order: exactly the files after
 * `PHASE3_BOUNDARY`. Adjusted by the coordinator when the DB stream reports
 * its final names.
 */
export const CORRECTIVE_MIGRATIONS: readonly string[] = [
  '0070_definer_ownership_hardening.sql', // TD-18 (directive §6)
  '0071_reversal_inventory_account_domain.sql', // S8 I-1 (directive §4)
  '0072_purchase_sub_unit_residue.sql', // TD-16 (directive §3)
  '0073_default_warehouse_name.sql', // TD-20 default warehouse name (directive §10) — name to be confirmed by the DB stream
];

/** The accepted digests, recorded at the corrective freeze. Empty while a candidate. */
export const CORRECTIVE_ACCEPTED: Readonly<Record<string, string>> = {};

/** The phrase every corrective migration's leading comment carries (directive §18). */
export const CORRECTIVE_MIGRATION_HEADER = 'Phase 3 corrective hardening';

/** An entry the coordinator has not filled yet: a FAIL, never a skip. */
export interface Pending {
  readonly id: string;
  readonly blocker: string;
  readonly pending: string;
}

export interface SuiteEntry {
  readonly id: string;
  readonly blocker: string;
  /** `root`: the root Vitest configuration; `web`: apps/web/vitest.config.mts. */
  readonly runner: 'root' | 'web';
  readonly file: string;
}

export interface CommandEntry {
  readonly id: string;
  readonly blocker: string;
  readonly npmScript: string;
  readonly args: readonly string[];
}

export const isPending = (entry: object): entry is Pending => 'pending' in entry;

/** Every corrective suite, by id. Exact: nothing is discovered, and every `p3c-*` suite on disk must be listed. */
export const CORRECTIVE_SUITES: readonly (SuiteEntry | Pending)[] = [
  // A — TD-16 (DB stream)
  { id: 'A-01', blocker: 'A TD-16', pending: 'the DB stream’s TD-16 residue suite (reported as tests/integration/p3c-td16-residue-closure.test.ts)' },
  // B — S8 I-1 (DB stream)
  { id: 'B-01', blocker: 'B I-1', pending: 'the DB stream’s I-1 reversal suite (reported as tests/integration/p3c-reversal-inventory-domain.test.ts)' },
  // C — TD-19, BFF client address and refresh 429
  { id: 'C-01', blocker: 'C TD-19', runner: 'root', file: 'tests/integration/p3c-bff-client-ip.test.ts' },
  { id: 'C-02', blocker: 'C TD-19', runner: 'root', file: 'tests/integration/p3c-bff-admin-client-ip.test.ts' },
  { id: 'C-03', blocker: 'C TD-19', runner: 'root', file: 'tests/integration/p3c-bff-route-throttle.test.ts' },
  { id: 'C-04', blocker: 'C TD-19', runner: 'root', file: 'tests/security/p3c-bff-admin-proxy-path.test.ts' },
  { id: 'C-05', blocker: 'C TD-19', runner: 'root', file: 'tests/security/p3c-bff-admin-session-retry.test.ts' },
  { id: 'C-06', blocker: 'C TD-19', runner: 'root', file: 'tests/security/p3c-bff-entry-parity.test.ts' },
  { id: 'C-07', blocker: 'C TD-19', runner: 'root', file: 'tests/security/p3c-legacy-trust-proxy.test.ts' },
  { id: 'C-08', blocker: 'C TD-19', runner: 'root', file: 'tests/security/p3c-ipv6-limiter-key.test.ts' },
  { id: 'C-09', blocker: 'C TD-19', runner: 'web', file: 'apps/web/test/bff-client-address.test.ts' },
  { id: 'C-10', blocker: 'C TD-19', runner: 'web', file: 'apps/web/test/bff-refresh.test.ts' },
  { id: 'C-11', blocker: 'C TD-19', runner: 'web', file: 'apps/web/test/bff-upstream.test.ts' },
  { id: 'C-12', blocker: 'C TD-19', runner: 'web', file: 'apps/web/test/bff-session-notice.test.tsx' },
  { id: 'C-13', blocker: 'C TD-19', runner: 'web', file: 'apps/web/test/bff-session-retry.test.ts' },
  // D — TD-18 (DB stream)
  { id: 'D-01', blocker: 'D TD-18', pending: 'the DB stream’s TD-18 definer suite (reported as tests/security/p3c-td18-definer-ownership.test.ts)' },
  { id: 'D-02', blocker: 'D TD-18', pending: 'the DB stream’s key install/retire suite (reported as tests/security/p3c-provisioning-key-install.test.ts)' },
  // E — the release's secret scans
  { id: 'E-01', blocker: 'E secret scan', runner: 'root', file: 'tests/security/p3c-export-content-scan.test.ts' },
  { id: 'E-02', blocker: 'E secret scan', runner: 'root', file: 'tests/security/p3c-phase1-gate-secret-scope.test.ts' },
  { id: 'E-03', blocker: 'E secret scan', pending: 'the hygiene stream’s range-scan canary suite (reported as tests/security/p3c-secret-scan.test.ts)' },
  // H — TD-20
  { id: 'H-01', blocker: 'H TD-20', runner: 'web', file: 'apps/web/test/starting-stock.test.tsx' },
  { id: 'H-02', blocker: 'H TD-20', pending: 'the DB stream’s openingPosted read suite (reported as tests/integration/p3c-inventory-access-opening.test.ts)' },
  { id: 'H-03', blocker: 'H TD-20', pending: 'the DB stream’s default-warehouse-name suite, ar/en/tr (0073)' },
  // K — TD-14
  { id: 'K-01', blocker: 'K TD-14', runner: 'root', file: 'tests/security/p3c-td14-platform-credential.test.ts' },
  // N — the review index
  { id: 'N-01', blocker: 'N review index', runner: 'root', file: 'tests/security/p3c-review-index.test.ts' },
  // O — this gate's own red proofs
  { id: 'O-01', blocker: 'O corrective gate', runner: 'root', file: 'tests/security/p3c-corrective-gate-tamper.test.ts' },
];

/** Commands the gate runs after the suites. */
export const CORRECTIVE_COMMANDS: readonly (CommandEntry | Pending)[] = [
  { id: 'N-CHECK', blocker: 'N review index', npmScript: 'check:phase3:review-index', args: [] },
];

/** The Phase 2 merge into main: Phase 3 is everything after it (directive §7). */
export const PHASE3_BASE = '0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f';

/**
 * Directive §7: the explicit Phase 3 range scan from `PHASE3_BASE` through the
 * candidate. Filled, it names an npm script whose program derives its range
 * from `PHASE3_BASE` (the SHA appears in the program), and the gate runs it.
 */
export const SECRET_RANGE_SCAN: CommandEntry | Pending = {
  id: 'E-SCAN',
  blocker: 'E secret scan',
  pending: 'the hygiene stream’s full Phase 3 range scan (reported as npm run scan:secrets:phase3)',
};

/** Corrective performance budgets, each run alone after the suites. None yet; Budget A (and B) run last in any case. */
export const CORRECTIVE_BUDGETS: readonly string[] = [];

/** Budgets A and B, re-measured in isolation and last: 0071 adds a deferred trigger on journal_entries. */
export const ACCOUNTING_BUDGETS = 'tests/performance/accounting-budgets.test.ts';

// ── The real-browser matrix (directive §8) ──────────────────────────────────

export interface BrowserViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** The matrix this gate runs: equal to tests/browser/config.ts, and never under the directive floor. */
export const BROWSER_MATRIX: { readonly locales: readonly string[]; readonly viewports: readonly BrowserViewport[] } = {
  locales: ['ar', 'en', 'tr'],
  viewports: [
    { name: 'phone', width: 360, height: 640 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ],
};

/** Directive §8, verbatim: the platform locales and the three viewport classes. Never narrowed. */
const DIRECTIVE_BROWSER_FLOOR = {
  locales: ['ar', 'en', 'tr'],
  viewports: ['360x640', '768x1024', '1280x800'],
} as const;

/** The planted-defect kinds the red proof must catch; `missing-string` is the Turkish (and Arabic) untranslated-text proof. */
export const REQUIRED_PLANTS: readonly string[] = ['overflow', 'raw-key', 'console-error', 'missing-string'];

const BROWSER_CONFIG = 'tests/browser/config.ts';
const BROWSER_RUN_CONTEXT = 'tests/browser/run-context.ts';
const matrixArgs = (): string[] => [`--locales=${BROWSER_MATRIX.locales.join(',')}`, `--viewports=${BROWSER_MATRIX.viewports.map((v) => v.name).join(',')}`];

// ── The red proofs (directive §19) ──────────────────────────────────────────

export interface RedProof {
  readonly id: string;
  readonly defect: string;
  /** `<test file>::<it( title prefix>` — the test that shows the gate failing on the old defect. */
  readonly proof: string;
}

const TAMPER = 'tests/security/p3c-corrective-gate-tamper.test.ts';

/** One row per old defect the directive names. A pending row is a FAIL. */
export const RED_PROOFS: readonly (RedProof | Pending)[] = [
  { id: 'RP-TD16', blocker: 'A TD-16', pending: 'TD-16 historical reproduction RED on the frozen S5 behaviour (DB stream)' },
  { id: 'RP-I1', blocker: 'B I-1', pending: 'I-1 reversal discrepancy RED without 0071 (DB stream)' },
  { id: 'RP-TD19', defect: 'TD-19 shared BFF client address', proof: `${TAMPER}::TD-19 red:` },
  { id: 'RP-TD18', blocker: 'D TD-18', pending: 'TD-18 insecure definer ownership / search path RED without 0070 (DB stream)' },
  { id: 'RP-SCAN', defect: 'partial secret-history scan', proof: `${TAMPER}::E red:` },
  { id: 'RP-TR', defect: 'missing Turkish real-browser coverage', proof: `${TAMPER}::F red:` },
  { id: 'RP-TD20', defect: 'TD-20 impossible Starting stock action', proof: `${TAMPER}::TD-20 red:` },
];

// ─────────────────────────────────────────────────────────────────────────
// The checks. Each takes the root it looks at and returns its problems.
// ─────────────────────────────────────────────────────────────────────────

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const migrationsDir = (root: string): string => join(root, 'infrastructure/database/migrations');

interface Manifest {
  readonly frozenThrough: string;
  readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
}

/** §18: the boundary, in the tense `accepted` names. */
export function boundaryProblems(root: string, accepted: Readonly<Record<string, string>> = CORRECTIVE_ACCEPTED): string[] {
  const problems = checkPhase3Prefix(migrationsDir(root), join(root, 'infrastructure/database/MIGRATION_MANIFEST.json')).map((p) => `the Phase 3 prefix: ${p}`);
  const manifest = JSON.parse(read(root, 'infrastructure/database/MIGRATION_MANIFEST.json')) as Manifest;
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  const after = readdirSync(migrationsDir(root))
    .filter((f) => f.endsWith('.sql') && f > PHASE3_BOUNDARY)
    .sort();
  const declared = [...CORRECTIVE_MIGRATIONS];
  if (JSON.stringify(after) !== JSON.stringify(declared))
    problems.push(`the files after ${PHASE3_BOUNDARY} are exactly CORRECTIVE_MIGRATIONS (${declared.join(', ')}) — found ${after.join(', ') || 'none'}`);
  const last = declared[declared.length - 1] ?? PHASE3_BOUNDARY;
  if (Object.keys(accepted).length === 0) {
    if (manifest.frozenThrough !== PHASE3_BOUNDARY)
      problems.push(`frozenThrough is ${manifest.frozenThrough} — a corrective candidate sits exactly on the Phase 3 boundary ${PHASE3_BOUNDARY}`);
    for (const name of after) if (recorded.has(name)) problems.push(`${name} is in the manifest before the corrective gate passed — premature freeze (§18)`);
    return problems;
  }
  if (JSON.stringify(Object.keys(accepted).sort()) !== JSON.stringify([...declared].sort()))
    problems.push(`CORRECTIVE_ACCEPTED must name exactly CORRECTIVE_MIGRATIONS (${declared.join(', ')})`);
  if (manifest.frozenThrough < last)
    problems.push(`frozenThrough is ${manifest.frozenThrough} — it is a floor at ${last} once the corrective pass is accepted`);
  for (const [name, digest] of Object.entries(accepted)) {
    const path = join(migrationsDir(root), name);
    if (!existsSync(path)) {
      problems.push(`${name} was accepted but is missing`);
      continue;
    }
    const onDisk = sha256(path);
    if (onDisk !== digest) problems.push(`${name} hashes to ${onDisk.slice(0, 12)}… but was accepted at ${digest.slice(0, 12)}…`);
    if (recorded.get(name) !== digest) problems.push(`${name} is not frozen in the manifest at its accepted digest`);
  }
  return problems;
}

/** §18: each corrective migration's leading comment names it Phase 3 corrective hardening. */
export function migrationHeaderProblems(root: string): string[] {
  const problems: string[] = [];
  for (const name of CORRECTIVE_MIGRATIONS) {
    const path = join(migrationsDir(root), name);
    if (!existsSync(path)) continue; // the boundary check reports it
    const lines = readFileSync(path, 'utf8').split('\n');
    const header: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('--')) break;
      header.push(line.replace(/^--\s?/, ''));
    }
    if (!header.join(' ').replace(/\s+/g, ' ').includes(CORRECTIVE_MIGRATION_HEADER))
      problems.push(`${name}: its leading comment does not name it "${CORRECTIVE_MIGRATION_HEADER}" (directive §18)`);
  }
  return problems;
}

/** Every pending entry is a FAIL: the gate is red until the coordinator fills it. */
export function pendingProblems(): string[] {
  const rows: readonly object[] = [...CORRECTIVE_SUITES, ...CORRECTIVE_COMMANDS, SECRET_RANGE_SCAN, ...RED_PROOFS];
  return rows.filter(isPending).map((p) => `${p.id} (${p.blocker}) is not filled: ${p.pending}`);
}

const SKIP = /\b(?:it|test|describe|suite)\.(?:skip|only|todo|skipIf|runIf)\b|\bx(?:it|describe)\s*\(|RELEASE_GATE_SKIP_/;
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const QUOTED = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

/** The listed suites exist and do not skip; every `p3c-*` suite on disk is listed; ids are unique. */
export function suiteProblems(root: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of CORRECTIVE_SUITES) {
    if (ids.has(e.id)) problems.push(`${e.id} is listed twice`);
    ids.add(e.id);
  }
  const files = CORRECTIVE_SUITES.filter((e): e is SuiteEntry => !isPending(e));
  for (const e of files) {
    if (!has(root, e.file)) {
      problems.push(`${e.id} ${e.file} is missing`);
      continue;
    }
    if ((e.runner === 'web') !== e.file.startsWith('apps/web/test/')) problems.push(`${e.id} ${e.file} is not a ${e.runner} suite`);
    // Code only: a quoted fixture that NAMES a skip is not one.
    const hit = SKIP.exec(stripTsProse(read(root, e.file)).replace(QUOTED, "''"));
    if (hit) problems.push(`${e.id} ${e.file} contains ${hit[0]} — no corrective suite skips`);
  }
  const listed = new Set(files.map((e) => e.file));
  for (const dir of ['tests/integration', 'tests/security', 'tests/performance']) {
    if (!has(root, dir)) continue;
    for (const f of readdirSync(join(root, dir)).sort()) {
      if (/^p3c-.*\.test\.ts$/.test(f) && !listed.has(`${dir}/${f}`)) problems.push(`${dir}/${f} is a corrective suite no CORRECTIVE_SUITES entry lists`);
    }
  }
  for (const budget of CORRECTIVE_BUDGETS) if (!has(root, budget)) problems.push(`the corrective budget ${budget} is missing`);
  return problems;
}

/** The commands name npm scripts that exist. */
export function commandProblems(root: string): string[] {
  const problems: string[] = [];
  const scripts = (JSON.parse(read(root, 'package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
  for (const c of CORRECTIVE_COMMANDS) {
    if (isPending(c)) continue;
    if (typeof scripts[c.npmScript] !== 'string') problems.push(`${c.id}: package.json has no script ${c.npmScript}`);
  }
  return problems;
}

/**
 * Directive §7: the range scan is the explicit one, from `PHASE3_BASE`. A scan
 * whose program does not carry the base is a partial scan — the gitleaks
 * action's PR window — and is refused.
 */
export function secretScanProblems(root: string, scan: CommandEntry | Pending = SECRET_RANGE_SCAN): string[] {
  if (isPending(scan)) return [`${scan.id}: no Phase 3 range scan is declared — the gitleaks action's PR window is not Phase 3 history evidence`];
  const scripts = (JSON.parse(read(root, 'package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
  const command = scripts[scan.npmScript];
  if (typeof command !== 'string') return [`${scan.id}: package.json has no script ${scan.npmScript}`];
  const program = /\btsx\s+(\S+\.ts)\b/.exec(command)?.[1];
  if (program === undefined) return [`${scan.id}: ${scan.npmScript} (${command}) does not run a tsx program this gate can read`];
  if (!has(root, program)) return [`${scan.id}: ${program} (run by ${scan.npmScript}) is missing`];
  if (!stripTsProse(read(root, program)).includes(PHASE3_BASE))
    return [`${scan.id}: ${program} does not derive its range from the Phase 3 base ${PHASE3_BASE} — a partial scan is not Phase 3 history evidence`];
  return [];
}

/** The quoted strings of a TS array literal. */
const quotedItems = (list: string): string[] => [...list.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');

/** Directive §8: the declared matrix, what the browser gate runs, and the planted kinds of its red proof. */
export function browserMatrixProblems(root: string, matrix: typeof BROWSER_MATRIX = BROWSER_MATRIX): string[] {
  const problems: string[] = [];
  const declaredLocales = [...matrix.locales];
  const declaredViewports = matrix.viewports.map((v) => `${v.name}:${v.width}x${v.height}`);
  for (const locale of DIRECTIVE_BROWSER_FLOOR.locales)
    if (!declaredLocales.includes(locale)) problems.push(`BROWSER_MATRIX drops the locale ${locale} — directive §8 requires ar, en and tr`);
  for (const size of DIRECTIVE_BROWSER_FLOOR.viewports)
    if (!matrix.viewports.some((v) => `${v.width}x${v.height}` === size)) problems.push(`BROWSER_MATRIX drops the viewport ${size} — directive §8 requires it`);

  if (!has(root, BROWSER_CONFIG)) return [...problems, `${BROWSER_CONFIG} is missing`];
  const config = stripTsProse(read(root, BROWSER_CONFIG));
  const locales = /export const LOCALES\b[^=]*=\s*\[([^\]]*)\]/.exec(config);
  if (!locales) problems.push(`${BROWSER_CONFIG} declares no LOCALES list`);
  else {
    const found = quotedItems(locales[1] ?? '');
    if (JSON.stringify(found) !== JSON.stringify(declaredLocales))
      problems.push(`${BROWSER_CONFIG} runs the locales ${found.join(', ') || 'none'} — the corrective matrix is ${declaredLocales.join(', ')}`);
  }
  const viewports = /export const VIEWPORTS\b[^=]*=\s*\[([\s\S]*?)\];/.exec(config);
  if (!viewports) problems.push(`${BROWSER_CONFIG} declares no VIEWPORTS list`);
  else {
    const body = viewports[1] ?? '';
    const found = [...body.matchAll(/\{\s*name:\s*'([^']+)',\s*width:\s*(\d+),\s*height:\s*(\d+),?\s*\}/g)].map(
      (m) => `${m[1] ?? ''}:${m[2] ?? ''}x${m[3] ?? ''}`,
    );
    const entries = (body.match(/\{/g) ?? []).length;
    if (entries !== found.length) problems.push(`${BROWSER_CONFIG} VIEWPORTS holds an entry this gate cannot read`);
    if (JSON.stringify(found) !== JSON.stringify(declaredViewports))
      problems.push(`${BROWSER_CONFIG} runs the viewports ${found.join(', ') || 'none'} — the corrective matrix is ${declaredViewports.join(', ')}`);
  }
  if (!has(root, BROWSER_RUN_CONTEXT)) problems.push(`${BROWSER_RUN_CONTEXT} is missing`);
  else {
    const plants = /export const PLANTS\b[^=]*=\s*\[([^\]]*)\]/.exec(stripTsProse(read(root, BROWSER_RUN_CONTEXT)));
    const found = plants ? quotedItems(plants[1] ?? '') : [];
    for (const kind of REQUIRED_PLANTS)
      if (!found.includes(kind)) problems.push(`${BROWSER_RUN_CONTEXT} PLANTS lacks ${kind} — the red proof must plant it in every locale`);
  }
  for (const locale of DIRECTIVE_BROWSER_FLOOR.locales)
    if (!has(root, `apps/web/src/messages/${locale}.json`)) problems.push(`apps/web/src/messages/${locale}.json is missing`);
  return problems;
}

/** Directive §19: every red proof is filled and resolves to an it( title. */
export function redProofProblems(root: string): string[] {
  const problems: string[] = [];
  for (const row of RED_PROOFS) {
    if (isPending(row)) continue;
    const [file = '', prefix = ''] = row.proof.split('::');
    if (prefix.trim() === '') {
      problems.push(`${row.id}: ${row.proof} names no title`);
      continue;
    }
    if (!has(root, file)) {
      problems.push(`${row.id}: ${file} does not exist`);
      continue;
    }
    if (!testTitles(read(root, file)).some((t) => t.startsWith(prefix))) problems.push(`${row.id}: no it( title in ${file} starts with "${prefix}"`);
  }
  return problems;
}

/** Budget A stays 15 ms and B 60 ms. */
export function budgetProblems(root: string): string[] {
  const text = has(root, ACCOUNTING_BUDGETS) ? read(root, ACCOUNTING_BUDGETS) : '';
  const problems: string[] = [];
  if (!/\bA_POST_P95:\s*15,/.test(text)) problems.push(`Budget A is not 15 ms in ${ACCOUNTING_BUDGETS} — it is never raised`);
  if (!/\bB_ADJUSTMENT_ENDPOINT_P95:\s*60,/.test(text)) problems.push(`Budget B is not 60 ms in ${ACCOUNTING_BUDGETS} — it is never raised`);
  return problems;
}

// ── The runtime plan ────────────────────────────────────────────────────────

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export type Step =
  | { readonly kind: 'command'; readonly name: string; readonly area: string; readonly cmd: string; readonly args: readonly string[] }
  | { readonly kind: 'in-process'; readonly name: string; readonly area: string; readonly fn: () => string[] };

/** The runtime half, in order. Exported so the red proofs run a step's exact command. */
export function correctivePlan(root: string): readonly Step[] {
  const suites = CORRECTIVE_SUITES.filter((e): e is SuiteEntry => !isPending(e));
  const rootSuites = suites.filter((e) => e.runner === 'root').map((e) => e.file);
  const webSuites = suites.filter((e) => e.runner === 'web').map((e) => e.file);
  const commands = [...CORRECTIVE_COMMANDS, SECRET_RANGE_SCAN].filter((c): c is CommandEntry => !isPending(c));
  return [
    {
      kind: 'command',
      name: 'P3-S8 gate (permanent predecessor; composes P3-S7 … P3-S1, P2-S8 … P2-S1 and Phase 1)',
      area: 'predecessor',
      cmd: npm,
      args: ['run', 'gate:phase3:s8'],
    },
    { kind: 'command', name: `corrective suites, root runner (${rootSuites.length})`, area: 'suites', cmd: 'npx', args: ['vitest', 'run', ...rootSuites] },
    {
      kind: 'command',
      name: `corrective suites, web runner (${webSuites.length})`,
      area: 'web-suites',
      cmd: 'npx',
      args: ['vitest', 'run', '--config', 'apps/web/vitest.config.mts', ...webSuites],
    },
    ...commands.map(
      (c): Step => ({
        kind: 'command',
        name: `${c.id} npm run ${c.npmScript}`,
        area: 'commands',
        cmd: npm,
        args: ['run', c.npmScript, ...(c.args.length ? ['--', ...c.args] : [])],
      }),
    ),
    {
      kind: 'command',
      name: 'real-browser red proof: every planted defect reported in every run (builds the API and the web app)',
      area: 'browser',
      cmd: npm,
      args: ['run', 'gate:browser', '--', '--build', '--plant=all', '--steps=header,stock', ...matrixArgs(), '--out=release/browser-red-proof'],
    },
    {
      kind: 'command',
      name: `real-browser gate: ${BROWSER_MATRIX.locales.join('/')} × ${BROWSER_MATRIX.viewports.map((v) => `${v.width}×${v.height}`).join(', ')}`,
      area: 'browser',
      cmd: npm,
      args: ['run', 'gate:browser', '--', ...matrixArgs(), '--out=release/browser'],
    },
    // The browser build leaves apps/api/dist, which the Phase 1 machine gate
    // refuses in a source tree: the release gate's own restore step, here.
    {
      kind: 'in-process',
      name: 'the source tree is a source tree again (the API build output is removed)',
      area: 'browser',
      fn: () => {
        rmSync(join(root, 'apps/api/dist'), { recursive: true, force: true });
        return existsSync(join(root, 'apps/api/dist')) ? ['apps/api/dist is still present after being removed'] : [];
      },
    },
    ...CORRECTIVE_BUDGETS.map((b): Step => ({ kind: 'command', name: `corrective budget ${b}, alone`, area: 'perf', cmd: 'npx', args: ['vitest', 'run', b] })),
    { kind: 'command', name: 'Budget A and B in isolation, last', area: 'perf', cmd: 'npx', args: ['vitest', 'run', ACCOUNTING_BUDGETS] },
  ];
}

// ── The gate against a tree ─────────────────────────────────────────────────

function runGate(root: string, listOnly: boolean, structuralOnly: boolean): void {
  let failures = 0;
  const fail = (area: string, detail: string): void => {
    failures += 1;
    console.error(`  FAIL [${area}] ${detail}`);
  };
  const ok = (detail: string): void => console.log(`  ok      ${detail}`);
  const accepted = Object.keys(CORRECTIVE_ACCEPTED).length > 0;
  const tense = accepted ? 'accepted' : 'candidate';

  if (listOnly) {
    console.log(`P3 CORRECTIVE GATE plan (${tense}):`);
    if (accepted)
      console.log(
        `  structural: frozenThrough at or beyond ${CORRECTIVE_MIGRATIONS[CORRECTIVE_MIGRATIONS.length - 1] ?? PHASE3_BOUNDARY}; CORRECTIVE_ACCEPTED digests`,
      );
    else console.log(`  structural: frozenThrough = ${PHASE3_BOUNDARY}; after it exactly ${CORRECTIVE_MIGRATIONS.join(', ')}, unrecorded`);
    console.log(`  structural: 0053–0069 intact; each corrective migration named "${CORRECTIVE_MIGRATION_HEADER}"; Budget A 15 ms, B 60 ms`);
    console.log(
      `  structural: browser matrix ${BROWSER_MATRIX.locales.join('/')} × ${BROWSER_MATRIX.viewports.map((v) => `${v.width}x${v.height}`).join(', ')}; plants ${REQUIRED_PLANTS.join(', ')}`,
    );
    console.log('  suites:');
    for (const e of CORRECTIVE_SUITES)
      console.log(
        `    ${e.id.padEnd(6)} ${isPending(e) ? `PENDING — FAILS until filled: ${e.pending}` : `${e.runner.padEnd(4)} ${e.file}${has(root, e.file) ? '' : '   (missing)'}`}`,
      );
    console.log('  commands:');
    for (const c of [...CORRECTIVE_COMMANDS, SECRET_RANGE_SCAN])
      console.log(`    ${c.id.padEnd(8)} ${isPending(c) ? `PENDING — FAILS until filled: ${c.pending}` : ['npm run', c.npmScript, ...c.args].join(' ')}`);
    console.log('  red proofs (directive §19):');
    for (const r of RED_PROOFS)
      console.log(`    ${r.id.padEnd(8)} ${isPending(r) ? `PENDING — FAILS until filled: ${r.pending}` : `${r.defect} — ${r.proof}`}`);
    console.log('  runtime:    the root and web runner canaries');
    for (const s of correctivePlan(root)) console.log(`  ${s.kind === 'command' ? `command:    ${s.cmd} ${s.args.join(' ')}` : `in process: ${s.name}`}`);
    const pending = pendingProblems().length;
    console.log(`\n${pending} pending entr${pending === 1 ? 'y' : 'ies'}: the gate FAILS until ${pending === 1 ? 'it is' : 'they are'} filled.`);
    return;
  }

  const checks: readonly (readonly [title: string, area: string, run: () => string[], okText: string])[] = [
    [
      `boundary (${tense})`,
      'boundary',
      () => boundaryProblems(root),
      accepted
        ? 'the corrective migrations are frozen at their accepted digests'
        : `frozenThrough = ${PHASE3_BOUNDARY}; after it exactly the declared corrective files, none recorded`,
    ],
    ['corrective migration headers (§18)', 'migration', () => migrationHeaderProblems(root), `every corrective migration is "${CORRECTIVE_MIGRATION_HEADER}"`],
    ['required entries', 'pending', pendingProblems, 'no required entry is pending'],
    ['suites', 'suites', () => suiteProblems(root), `${CORRECTIVE_SUITES.length} corrective suites exist, none skips, every p3c-* suite is listed`],
    ['commands', 'commands', () => commandProblems(root), 'every corrective command names an npm script that exists'],
    ['full-range secret scan (§7)', 'secret-scan', () => secretScanProblems(root), `the range scan derives from ${PHASE3_BASE.slice(0, 12)}…`],
    [
      'real-browser matrix (§8)',
      'browser-matrix',
      () => browserMatrixProblems(root),
      'ar/en/tr × phone/tablet/desktop, as the browser gate runs it, with every planted kind',
    ],
    ['red proofs (§19)', 'red-proof', () => redProofProblems(root), `${RED_PROOFS.length} red proofs resolve to their tests`],
    ['budgets', 'perf', () => budgetProblems(root), 'Budget A 15 ms and B 60 ms unchanged'],
  ];
  for (const [title, area, run, okText] of checks) {
    console.log(`P3 CORRECTIVE GATE — ${title}`);
    const problems = run();
    for (const p of problems) fail(area, p);
    if (problems.length === 0) ok(okText);
  }
  if (failures > 0) {
    console.error(`\nP3 CORRECTIVE GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
    process.exitCode = 1;
    return;
  }
  if (structuralOnly) {
    console.log('\nP3 CORRECTIVE GATE: PASS (structural checks only)');
    return;
  }

  console.log('P3 CORRECTIVE GATE — runner canaries');
  for (const [label, config] of [
    ['root', 'tests/fixtures/runner-exit-code/vitest.config.ts'],
    ['web', 'apps/web/test/fixtures/runner-exit-code/vitest.config.mts'],
  ] as const) {
    const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], { cwd: root, encoding: 'utf8', env: process.env });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (!/1 failed/.test(output)) fail('runner', `the ${label} canary did not run its failing test, so this run proves nothing:\n${output.slice(-2000)}`);
    else if (res.status === 0) fail('runner', `the ${label} runner exited 0 over a failing test; no result it gives is evidence (tests/helpers/exit-code.ts)`);
    else ok(`the ${label} runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
  }
  if (failures > 0) {
    console.error('\nP3 CORRECTIVE GATE: FAIL — a test runner cannot report failure; refusing to run the regression matrix');
    process.exitCode = 1;
    return;
  }

  console.log('P3 CORRECTIVE GATE — composed regression matrix');
  for (const step of correctivePlan(root)) {
    const started = Date.now();
    if (step.kind === 'in-process') {
      const problems = step.fn();
      for (const p of problems) fail(step.area, `${step.name}: ${p}`);
      if (problems.length === 0) ok(step.name);
      continue;
    }
    const res = spawnSync(step.cmd, [...step.args], { cwd: root, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail(step.area, `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
  if (failures > 0) {
    console.error(`\nP3 CORRECTIVE GATE: FAIL (${failures})`);
    process.exitCode = 1;
    return;
  }
  console.log('\nP3 CORRECTIVE GATE: PASS');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : join(__dirname, '..');
  runGate(root, argv.includes('--list'), argv.includes('--structural-only'));
}
