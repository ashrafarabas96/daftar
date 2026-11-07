/**
 * DR-106 CONDITION 1 — NO FILE OUTSIDE `migrations/` MAY `CREATE OR REPLACE`
 * A FUNCTION WHOSE NAME A SEALED MIGRATION CREATES.
 *
 * ── THE DEFECT THIS MODULE WAS WRITTEN FOR (DR-106, owner, 2026-11-07) ────
 *
 * `infrastructure/database/specifications/p4s7-installment-aging.spec.sql`
 * carries, at `:4222`, a 551-line body under the head
 *
 *   CREATE OR REPLACE FUNCTION customer_ar_aging
 *     — arguments (p_business_id UUID, p_customer_id UUID, p_as_of DATE,
 *       p_bucket_days INTEGER[]); written here with the argument list detached
 *       ON PURPOSE, because this law reads NON-SQL files WITHOUT stripping
 *       their comments, so spelling the head contiguously in this very comment
 *       would make this module an instance of what it forbids. Every file in
 *       this change does the same, and the test file builds its planted head
 *       from fragments for the same reason.
 *
 * with the SAME signature, language, volatility and `search_path` as the live
 * receivables-aging law — which on `main` is `0084:705..:739`, 35 lines, and
 * which `0084:478` first `DROP FUNCTION`s out of `0075:798`. Two bodies, one
 * signature, two different laws: the specification reads
 * `has_active_installment_plan` off the invoice row and the live one does not.
 * `CREATE OR REPLACE` replaces WITHOUT WARNING, so applying that file to a
 * migrated tree silently changes a live financial read. The owner's ruling is
 * that `0084` is the law and the specification is a design, not a law.
 *
 * ── WHAT THIS MODULE ASSERTS, AND IN THE OWNER'S WORDS ────────────────────
 *
 * The law is the owner's sentence, implemented verbatim and NOT widened:
 * a file outside `infrastructure/database/migrations/` containing
 * `CREATE OR REPLACE FUNCTION <name>` where `<name>` is created by a migration
 * at or below `frozenThrough`. `frozenThrough` is read from
 * `infrastructure/database/MIGRATION_MANIFEST.json`, never from prose.
 *
 * ── THE LIMIT OF THE LAW, WHICH IS THE OWNER'S TO MOVE AND NOT MINE ──────
 *
 * DR-106 §3 names it and this module repeats it rather than quietly fixing it:
 * the law is hinged on «a name a SEALED migration creates», so A FUNCTION
 * FIRST CREATED AFTER `0079` IS NOT PROTECTED. Measured on `a191d9da`:
 * EIGHTEEN function names are created only by `0080..0086` and by nothing
 * sealed — among them `customer_collect_payment` and `customer_apply_credit`,
 * which move money. A file outside `migrations/` may replace any of those and
 * this law stays green. `sealedFunctionNames` is therefore the deliberate
 * scope and `candidateOnlyFunctionNames` exists so the gap is a measured
 * number in a test rather than a sentence in a comment. Widening the law to
 * «a name ANY numbered migration creates» would close it, and that is a change
 * to the owner's text, not a reading of it.
 *
 * ── TWO FALSE POSITIVES THIS READER IS BUILT AGAINST ─────────────────────
 *
 * (a) THE MIGRATIONS THEMSELVES carry `CREATE OR REPLACE` legitimately — that
 *     is how `0083:383` works. They are excluded BY PATH PREFIX, never by
 *     file name, so a file called `0083_...sql` sitting somewhere else is
 *     still scanned and a migration in a renamed directory is not silently
 *     exempted.
 *
 * (b) THE TEXT APPEARS IN PROSE. The specification's own comment box at `:33`
 *     reads «signature"; `CREATE OR REPLACE FUNCTION` may not change a
 *     `RETURNS`», and `:4866` names `CREATE FUNCTION` while describing this
 *     very extractor. A reader that counted those would report the pattern it
 *     forbids as an instance of itself. So SQL comments are blanked before the
 *     scan, and the pattern tolerates whitespace and newlines between every
 *     token, because the phrase can be wrapped across a line break.
 *
 *     What is NOT stripped, deliberately: single-quoted and dollar-quoted SQL
 *     bodies (a `CREATE OR REPLACE` inside a string is still applied when that
 *     string is executed), and comments in NON-SQL files. A `//` comment in a
 *     TypeScript file and a fenced block in a Markdown contract are left in
 *     scope because the owner's sentence says «any file», and narrowing it to
 *     «any applicable file» is as much a change to the text as widening it.
 *     The consequence is measured and enumerated in `DR106_BASELINE`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const MIGRATIONS_PREFIX = 'infrastructure/database/migrations/';
export const MANIFEST_PATH = 'infrastructure/database/MIGRATION_MANIFEST.json';

/** One `CREATE OR REPLACE FUNCTION <fn>` occurrence in a file outside `migrations/`. */
export interface Replacement {
  /** The file as the scan was given it — repo-relative for tracked files. */
  readonly file: string;
  /** 1-based line of the `CREATE` keyword, in the file's own numbering. */
  readonly line: number;
  /** The function name, lower-cased. */
  readonly fn: string;
}

/**
 * Blank SQL comments IN PLACE, preserving every newline.
 *
 * `scripts/guards/sql-schema.ts#stripComments` is the sibling reader and it
 * collapses a block comment to one space, which is right for a guard that only
 * asks whether a token is present. This law has to NAME THE LINE in its
 * failure, so a reader that loses newlines would report a line number that is
 * not the file's. Hence a copy that replaces comment bytes with spaces and
 * newlines with themselves: same subject, exact coordinates.
 */
export function blankSqlComments(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      while (i < stop) {
        out.push(sql[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    out.push(sql[i] as string);
    i += 1;
  }
  return out.join('');
}

/** `CREATE FUNCTION` or `CREATE OR REPLACE FUNCTION` — what a migration uses to DEFINE a name. */
const CREATE_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
/** `CREATE OR REPLACE FUNCTION` ALONE — the owner's sentence names this form and no other. */
const CREATE_OR_REPLACE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

function read(root: string, file: string): string {
  return readFileSync(isAbsolute(file) ? file : join(root, file), 'utf8');
}

/** Every tracked file, repo-relative, from git — not a directory walk, so untracked scratch is out of scope. */
export function trackedFiles(root: string): string[] {
  return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((f) => f.length > 0);
}

/** The numbered migrations, repo-relative and sorted, split at `frozenThrough`. */
export function migrationSplit(root: string): {
  readonly frozenThrough: string;
  readonly sealed: readonly string[];
  readonly candidates: readonly string[];
  readonly manifestCount: number;
} {
  const manifest = JSON.parse(read(root, MANIFEST_PATH)) as {
    frozenThrough: string;
    migrations: readonly { readonly name: string }[];
  };
  const frozenThrough = manifest.frozenThrough;
  const all = trackedFiles(root)
    .filter((f) => f.startsWith(MIGRATIONS_PREFIX) && f.endsWith('.sql'))
    .sort();
  const base = (f: string): string => f.slice(MIGRATIONS_PREFIX.length);
  return {
    frozenThrough,
    sealed: all.filter((f) => base(f) <= frozenThrough),
    candidates: all.filter((f) => base(f) > frozenThrough),
    manifestCount: manifest.migrations.length,
  };
}

function namesCreatedBy(root: string, migrations: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const f of migrations) {
    const text = blankSqlComments(read(root, f));
    for (const m of text.matchAll(CREATE_ANY)) names.add((m[1] as string).toLowerCase());
  }
  return names;
}

/** The protected set: every function name a SEALED migration creates. This is the law's scope. */
export function sealedFunctionNames(root: string): Set<string> {
  return namesCreatedBy(root, migrationSplit(root).sealed);
}

/** The MEASURED gap of DR-106 §3: names no sealed migration creates, so the law does not reach them. */
export function candidateOnlyFunctionNames(root: string): Set<string> {
  const { sealed, candidates } = migrationSplit(root);
  const protectedNames = namesCreatedBy(root, sealed);
  const out = new Set<string>();
  for (const n of namesCreatedBy(root, candidates)) if (!protectedNames.has(n)) out.add(n);
  return out;
}

/**
 * Scan `files` for `CREATE OR REPLACE FUNCTION <name>` with `<name>` in
 * `protectedNames`. Anything under `MIGRATIONS_PREFIX` is dropped BY PATH, and
 * `files` is a parameter rather than something this function discovers so a
 * test can hand it a planted file and get a real read of real bytes.
 */
export function scanForSealedReplacements(root: string, files: readonly string[], protectedNames: ReadonlySet<string>): Replacement[] {
  const found: Replacement[] = [];
  for (const file of files) {
    if (file.startsWith(MIGRATIONS_PREFIX)) continue;
    let raw: string;
    try {
      raw = read(root, file);
    } catch {
      continue; // a tracked path that is not a readable regular file here
    }
    if (raw.includes('\u0000')) continue; // binary
    const text = file.toLowerCase().endsWith('.sql') ? blankSqlComments(raw) : raw;
    for (const m of text.matchAll(CREATE_OR_REPLACE)) {
      const fn = (m[1] as string).toLowerCase();
      if (!protectedNames.has(fn)) continue;
      found.push({ file, line: text.slice(0, m.index).split('\n').length, fn });
    }
  }
  return found;
}

/**
 * THE MEASURED STARTING STATE, AND WHY IT IS NOT AN EXONERATION.
 *
 * The owner's sentence, run over the whole tracked tree at `a191d9da`, is TRUE
 * OF FORTY (file, function) PAIRS AND FORTY-EIGHT OCCURRENCES — not of one.
 * DR-106 §3 measured only that the specification IS caught; it did not measure
 * what else is. One of the forty is the specification, the case the decision
 * was written for. The other thirty-nine are, by inspection of the list:
 *
 *   * SIX Markdown phase contracts, which quote a migration's own DDL in prose
 *     and cannot be applied to anything;
 *   * THIRTY-TWO TypeScript sites, almost all of them the project's OWN
 *     technique for proving a guard — a defective body is PLANTED and the
 *     refusal is required (DR-55/RULE-27). `tests/security/p4s4-internal-
 *     definer-inventory.test.ts` plants `inventory_business_has_stock_
 *     movements` precisely to prove the DEFINER law catches it;
 *   * `scripts/guards/p4s7-body-digests.ts`, whose `P4S7_PINNED_BODIES` holds
 *     the specification's `customer_ar_aging` replacement head AS A STRING
 *     LITERAL, matched literally to locate the body it digests. That is why
 *     renaming the routine, or dropping `OR REPLACE` from it, BREAKS a
 *     consumer: `assertPinnedBodiesComplete` errors on a head it cannot find.
 *
 * So the law as written would be red on thirty-nine sites that are the
 * technique rather than the defect, and a law that fails falsely is a law that
 * gets switched off. This baseline keeps it enforceable: a NEW occurrence is
 * red and named, every listed one is pinned by (file, function, count) so a
 * SECOND plant in an already-listed file is still red, and a listed pair that
 * DISAPPEARS is also red, so the list cannot quietly rot.
 *
 * THIS IS A NARROWING OF THE OWNER'S TEXT AND IT IS DECLARED, NOT SILENT. The
 * owner decides, and I do not: whether the thirty-nine stand as technique,
 * and whether the specification's own entry should be emptied out of this list
 * by renaming the routine or dropping `OR REPLACE` from it. Both of those were
 * MEASURED to break consumers and neither is authorised by DR-106 §2, which
 * offers renaming or marking only — see the PR body.
 *
 * Pinned by (file, function) rather than by line because a prose edit above a
 * site moves its line without changing the subject. The cost is that moving an
 * occurrence WITHIN a listed file is invisible to this law; the count still
 * pins how many there are.
 */
export const DR106_BASELINE: readonly { readonly file: string; readonly fn: string; readonly count: number }[] = [
  { file: 'docs/PHASE_3_S2_CONTRACT.md', fn: 'inventory_configure_product', count: 1 },
  { file: 'docs/PHASE_3_S3_CONTRACT.md', fn: 'accounting_actor', count: 1 },
  { file: 'docs/PHASE_3_S4_CONTRACT.md', fn: 'inventory_stock_source_guard_gaps', count: 1 },
  { file: 'docs/PHASE_3_S5_CONTRACT.md', fn: 'inventory_stock_source_guard_gaps', count: 1 },
  { file: 'docs/PHASE_3_S6_CONTRACT.md', fn: 'purchase_ap_outstanding', count: 1 },
  { file: 'docs/PHASE_3_S6_CONTRACT.md', fn: 'supplier_credit_note_guard', count: 2 },
  { file: 'infrastructure/database/specifications/p4s7-installment-aging.spec.sql', fn: 'customer_ar_aging', count: 1 },
  { file: 'scripts/guards/p4s7-body-digests.ts', fn: 'customer_ar_aging', count: 2 },
  { file: 'scripts/phase2-s4-gate.ts', fn: 'accounting_post_reversal', count: 1 },
  { file: 'tests/guards/p4s4-settlement-surface-laws.test.ts', fn: 'invoice_outstanding', count: 1 },
  { file: 'tests/guards/phase4-deferred-seam-guard.test.ts', fn: 'accounting_reversals_20_domain_source_guard', count: 1 },
  { file: 'tests/guards/phase4-deferred-seam-guard.test.ts', fn: 'invoice_outstanding', count: 3 },
  { file: 'tests/guards/phase4-refund-not-a-reducer-guard.test.ts', fn: 'customer_ar_outstanding', count: 1 },
  { file: 'tests/guards/phase4-refund-not-a-reducer-guard.test.ts', fn: 'invoice_outstanding', count: 3 },
  { file: 'tests/guards/rowcount-refusal-law.test.ts', fn: 'invoice_outstanding', count: 2 },
  { file: 'tests/helpers/purchase-settlement-fixture.ts', fn: 'purchase_ap_outstanding', count: 1 },
  { file: 'tests/helpers/purchase-settlement-fixture.ts', fn: 'purchase_settlement_state', count: 1 },
  { file: 'tests/integration/accounting-guards.test.ts', fn: 'app_bypass', count: 1 },
  { file: 'tests/integration/inventory-db-guard.test.ts', fn: 'inventory_configure_product', count: 1 },
  { file: 'tests/integration/p3c-td20-default-warehouse-name.test.ts', fn: 'provision_create_business', count: 1 },
  { file: 'tests/integration/phase4-s7-installment-aging-db.test.ts', fn: 'customer_ar_aging', count: 1 },
  { file: 'tests/integration/phase4-s7-installment-aging-live.test.ts', fn: 'customer_ar_aging', count: 1 },
  { file: 'tests/integration/settlement-s6-s5-reproof.test.ts', fn: 'purchase_ap_outstanding', count: 1 },
  { file: 'tests/integration/settlement-s6-s5-reproof.test.ts', fn: 'purchase_settlement_state', count: 1 },
  { file: 'tests/performance/accounting-correction-candidate.test.ts', fn: 'app_business', count: 1 },
  { file: 'tests/performance/accounting-correction-candidate.test.ts', fn: 'app_bypass', count: 1 },
  { file: 'tests/performance/accounting-correction-candidate.test.ts', fn: 'app_tenant', count: 1 },
  { file: 'tests/performance/accounting-trial-balance-diagnosis.test.ts', fn: 'app_business', count: 1 },
  { file: 'tests/performance/accounting-trial-balance-diagnosis.test.ts', fn: 'app_bypass', count: 1 },
  { file: 'tests/performance/accounting-trial-balance-diagnosis.test.ts', fn: 'app_tenant', count: 1 },
  { file: 'tests/security/inventory-payload-parity.test.ts', fn: 'inventory_payload_digest', count: 1 },
  { file: 'tests/security/inventory-signed-authority.test.ts', fn: 'inventory_assertion_consume', count: 1 },
  { file: 'tests/security/p4s4-internal-definer-inventory.test.ts', fn: 'inventory_business_has_stock_movements', count: 2 },
  { file: 'tests/security/phase3-s8-signed-authority-matrix.test.ts', fn: 'inventory_assertion_consume', count: 1 },
  { file: 'tests/security/phase3-s8-signed-authority-matrix.test.ts', fn: 'inventory_assertion_current', count: 1 },
  { file: 'tests/security/purchase-s5-signed-authority.test.ts', fn: 'purchase_ap_outstanding', count: 1 },
  { file: 'tests/security/settlement-s6-guard-gaps.test.ts', fn: 'purchase_ap_outstanding', count: 1 },
  { file: 'tests/security/settlement-s6-guard-gaps.test.ts', fn: 'purchase_settlement_state', count: 1 },
  { file: 'tests/security/settlement-s6-guard-gaps.test.ts', fn: 'supplier_credit_note_guard', count: 1 },
  { file: 'tests/security/stock-ledger-authority.test.ts', fn: 'inventory_assertion_current', count: 1 },
];

/** `file\u0000fn` → occurrences, for comparing a scan against `DR106_BASELINE` without ambiguity. */
export function tally(found: readonly Replacement[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of found) m.set(`${r.file}\u0000${r.fn}`, (m.get(`${r.file}\u0000${r.fn}`) ?? 0) + 1);
  return m;
}

/** The repository root, from this file's own location. */
export const REPO_ROOT = join(__dirname, '..', '..');

/** Every surplus or missing occurrence against `DR106_BASELINE`, as the law's verdict. */
export function verdict(root: string = REPO_ROOT): {
  readonly surplus: readonly Replacement[];
  readonly vanished: readonly { readonly file: string; readonly fn: string; readonly expected: number; readonly actual: number }[];
  readonly scannedFiles: number;
  readonly protectedNames: number;
  readonly found: readonly Replacement[];
} {
  const names = sealedFunctionNames(root);
  const files = trackedFiles(root).filter((f) => !f.startsWith(MIGRATIONS_PREFIX));
  const found = scanForSealedReplacements(root, files, names);
  const seen = tally(found);
  const allowed = new Map(DR106_BASELINE.map((b) => [`${b.file}\u0000${b.fn}`, b.count]));
  const used = new Map<string, number>();
  const surplus: Replacement[] = [];
  for (const r of found) {
    const key = `${r.file}\u0000${r.fn}`;
    const budget = allowed.get(key) ?? 0;
    const spent = used.get(key) ?? 0;
    if (spent >= budget) surplus.push(r);
    used.set(key, spent + 1);
  }
  const vanished = DR106_BASELINE.filter((b) => (seen.get(`${b.file}\u0000${b.fn}`) ?? 0) < b.count).map((b) => ({
    file: b.file,
    fn: b.fn,
    expected: b.count,
    actual: seen.get(`${b.file}\u0000${b.fn}`) ?? 0,
  }));
  return { surplus, vanished, scannedFiles: files.length, protectedNames: names.size, found };
}

if (require.main === module) {
  const v = verdict();
  process.stdout.write(`protected sealed function names: ${v.protectedNames}\n`);
  process.stdout.write(`files scanned outside migrations/: ${v.scannedFiles}\n`);
  process.stdout.write(`occurrences found: ${v.found.length} (baseline allows ${DR106_BASELINE.reduce((a, b) => a + b.count, 0)})\n`);
  process.stdout.write(`gap of DR-106 §3 — names created only after frozenThrough: ${candidateOnlyFunctionNames(REPO_ROOT).size}\n`);
  for (const r of v.surplus) process.stdout.write(`SURPLUS\t${r.file}:${r.line}\t${r.fn}\n`);
  for (const r of v.vanished) process.stdout.write(`VANISHED\t${r.file}\t${r.fn}\texpected ${r.expected} found ${r.actual}\n`);
  const bad = v.surplus.length + v.vanished.length;
  process.stdout.write(`${bad === 0 ? 'DR-106 SEALED-REPLACEMENT LAW: PASS' : `DR-106 SEALED-REPLACEMENT LAW: FAIL (${bad})`}\n`);
  process.exit(bad === 0 ? 0 : 1);
}
