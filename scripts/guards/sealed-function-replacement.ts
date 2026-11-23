/**
 * DR-106 CONDITION 1 — NO FILE OUTSIDE `migrations/` MAY `CREATE OR REPLACE`
 * A FUNCTION WHOSE NAME ANY NUMBERED MIGRATION CREATES.
 *
 * ── THE DEFECT THIS MODULE WAS WRITTEN FOR (DR-106, owner, 2026-11-07) ────
 *
 * `infrastructure/database/specifications/p4s7-installment-aging.spec.sql`
 * carries, at `:4318`, a 551-line body under the head
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
 * ── WHAT THIS MODULE ASSERTS ──────────────────────────────────────────────
 *
 * A file outside `infrastructure/database/migrations/` containing
 * `CREATE OR REPLACE FUNCTION <name>` where `<name>` is created by ANY
 * NUMBERED MIGRATION — sealed or candidate. `frozenThrough` is still read
 * from `infrastructure/database/MIGRATION_MANIFEST.json`, never from prose,
 * because BOTH counts are reported: the sealed subset and the whole.
 *
 * ── THE SCOPE WAS WIDENED BY THE OWNER, AND §3's GAP IS CLOSED ────────────
 *
 * As first written, the law was hinged on «a name a SEALED migration creates»
 * (`<= frozenThrough`), and DR-106 §3 recorded that this protected 277 names
 * from 80 sealed migrations WHILE LEAVING UNPROTECTED every routine first
 * created after `0079`. That was measured here, not asserted: EIGHTEEN names,
 * and SEVENTEEN OF THEM ARE MONEY ROUTINES —
 *
 *   customer_collect_payment · customer_apply_credit · payment_complete ·
 *   payment_guard · payment_closure_verify · payment_allocation_guard ·
 *   payment_allocation_value_complete · invoice_settlement_verify ·
 *   customer_credit_consume · customer_credit_guard · customer_credit_verify ·
 *   customer_credit_application_guard ·
 *   customer_credit_application_value_complete ·
 *   customer_open_invoices_page ·
 *   accounting_customer_payment_allocation_entry_complete ·
 *   accounting_customer_credit_entry_complete ·
 *   accounting_customer_credit_application_entry_complete
 *
 * A file outside `migrations/` could have replaced the routine that collects a
 * payment, the routine that applies a credit, or the verifier that attests an
 * invoice was settled, and the law would have stayed green. That is the effect,
 * described and not decorated.
 *
 * OWNER DECISION 2026-11-08, appended to DR-106: «yes, widen it» — the scope is
 * now EVERY NAME ANY NUMBERED MIGRATION CREATES, 295 names from 87 migration
 * files, measured here. So this is a change to the owner's text MADE BY ITS
 * OWNER, not a reading of it taken here, and §3's gap is closed. The widening
 * is readable FROM THE TOOL and not from this comment: `verdict` reports the
 * sealed count and the total count side by side, and
 * `candidateOnlyFunctionNames` still names the 18 the widening added — which is
 * why the suite's plant on one of them, previously required to stay GREEN, is
 * now required to go RED.
 *
 * ── TWO FALSE POSITIVES THIS READER IS BUILT AGAINST ─────────────────────
 *
 * (a) THE MIGRATIONS THEMSELVES carry `CREATE OR REPLACE` legitimately — that
 *     is how `0083:383` works. They are excluded BY PATH PREFIX, never by
 *     file name, so a file called `0083_...sql` sitting somewhere else is
 *     still scanned and a migration in a renamed directory is not silently
 *     exempted.
 *
 * (b) THE TEXT APPEARS IN PROSE. The specification's own comment box at `:129`
 *     reads «signature"; `CREATE OR REPLACE FUNCTION` may not change a
 *     `RETURNS`», and `:4962` names `CREATE FUNCTION` while describing this
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
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Every file the tree claims to consist of, repo-relative — not a directory
 * walk, so a developer's untracked scratch cannot turn this law red on one
 * machine and green on another. A pinned baseline needs a deterministic
 * subject.
 *
 * IN AN EXTRACTED RELEASE CANDIDATE THERE IS NO GIT, BY DESIGN — the release
 * gate runs from the archive with no `.git` — so the archive's own
 * `DELIVERY_MANIFEST.json` inventory is the source there, which is the rule
 * `tests/helpers/delivered-files.ts` and
 * `tests/security/phase2-s8-gate-tamper.test.ts` already follow and which
 * `tests/security/archive-portability.test.ts` enforces on every git call under
 * `scripts/**` and `tests/**`. CI measured that law red here first: this
 * function had neither branch, and the finding named
 * `scripts/guards/sealed-function-replacement.ts:138`.
 *
 * An empty inventory is a REFUSAL, never a silently empty file list: a scan
 * over zero files would report zero violations and read as a pass.
 */
export function trackedFiles(root: string): string[] {
  const manifest = join(root, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { inventory?: { path?: string }[] };
    const paths = (parsed.inventory ?? []).map((e) => e.path).filter((p): p is string => typeof p === 'string' && p !== '');
    if (paths.length === 0) throw new Error('DELIVERY_MANIFEST.json is present and carries no inventory, so this law has no subject');
    return paths;
  }
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

/**
 * The SEALED subset: names a migration at or below `frozenThrough` creates.
 * This WAS the whole scope until the owner's 2026-11-08 widening; it is kept
 * and still reported so the widening is a difference the tool prints rather
 * than a claim in a comment.
 */
export function sealedFunctionNames(root: string): Set<string> {
  return namesCreatedBy(root, migrationSplit(root).sealed);
}

/** THE PROTECTED SET after the owner's 2026-11-08 widening: every name ANY numbered migration creates. */
export function allMigrationFunctionNames(root: string): Set<string> {
  const { sealed, candidates } = migrationSplit(root);
  return namesCreatedBy(root, [...sealed, ...candidates]);
}

/**
 * The names the widening ADDED: created by a candidate migration and by no
 * sealed one. These were DR-106 §3's gap — 18 names, 17 of them money — and
 * they are now protected, which is why the suite's plant on one of them must
 * go RED where it previously had to stay GREEN.
 */
export function candidateOnlyFunctionNames(root: string): Set<string> {
  const { sealed, candidates } = migrationSplit(root);
  const sealedNames = namesCreatedBy(root, sealed);
  const out = new Set<string>();
  for (const n of namesCreatedBy(root, candidates)) if (!sealedNames.has(n)) out.add(n);
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
 * The law, run over the whole tracked tree at `a191d9da` IN ITS WIDENED SCOPE,
 * is TRUE OF FORTY-TWO (file, function) PAIRS AND FIFTY-ONE OCCURRENCES — not
 * of one. DR-106 §3 measured only that the specification IS caught; it did not
 * measure what else is. One of the forty-two is the specification, the case the
 * decision was written for. The other forty-one are, by inspection of the list:
 *
 *   * SIX Markdown phase contracts, which quote a migration's own DDL in prose
 *     and cannot be applied to anything;
 *   * THIRTY-FIVE TypeScript sites, almost all of them the project's OWN
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
 * WHAT THE 2026-11-08 WIDENING ADDED: exactly THREE occurrences in TWO pairs,
 * all in `tests/guards/p4s4-settlement-surface-laws.test.ts`, each read at its
 * own line and justified beside its entry below — none of them a new kind, all
 * of them planted body TEXT fed to a text analyser. Nothing was added whose
 * reason is unknown; an unexplained addition would be a REAL hit being hidden,
 * so it stops the work instead of being pinned.
 *
 * So the law would be red on forty-one sites that are the technique rather than
 * the defect, and a law that fails falsely is a law that gets switched off.
 * This baseline keeps it enforceable: a NEW occurrence is red and NAMED — file,
 * line and function — every listed one is pinned by (file, function, count) so
 * a SECOND plant in an already-listed file is still red, and a listed pair that
 * DISAPPEARS is also red, so the list cannot quietly rot.
 *
 * THIS IS A NARROWING OF THE OWNER'S TEXT AND IT IS DECLARED, NOT SILENT. The
 * owner decides, and I do not: whether the forty-one stand as technique, and
 * whether the specification's own entry should be emptied out of this list by
 * renaming the routine or dropping `OR REPLACE` from it. Both of those were
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
  // ── THE THREE OCCURRENCES THE 2026-11-08 WIDENING ADDED, EACH WITH ITS
  //    REASON, READ AT ITS LINE AND NOT ASSUMED FROM ITS NEIGHBOURS ────────
  //
  // All three are in ONE file and all three are the SAME KNOWN CLASS as the
  // 32 TypeScript sites above: a body is planted AS TEXT and handed to a text
  // analyser, never applied to a database (DR-55/RULE-27).
  //
  //   `:577` + `:578` — `shape(stmt)` of `describe('RP-S4-ROWLOCK …')` builds a
  //   synthetic TWO-ROUTINE body text with one statement planted, and feeds it
  //   to `rowLockOnlyWriteProblems(...)` to prove that law catches a routine
  //   writing a table it only locks. `customer_collect_payment` is the first
  //   routine of that fixture and `customer_apply_credit` the second.
  //
  //   `:664` — an UNTERMINATED dollar-quoted `customer_collect_payment` body,
  //   planted to prove the same law REPORTS an unreadable body rather than
  //   skipping it («a routine whose body cannot be read is reported, never
  //   skipped»). Hence `customer_collect_payment` counts 2 in this file, not 1.
  { file: 'tests/guards/p4s4-settlement-surface-laws.test.ts', fn: 'customer_apply_credit', count: 1 },
  { file: 'tests/guards/p4s4-settlement-surface-laws.test.ts', fn: 'customer_collect_payment', count: 2 },
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
  /** The post-widening scope: every name any numbered migration creates. */
  readonly protectedNames: number;
  /** The pre-widening subset, reported beside the total so the widening is readable from the tool. */
  readonly sealedNames: number;
  readonly found: readonly Replacement[];
} {
  const names = allMigrationFunctionNames(root);
  const sealed = sealedFunctionNames(root);
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
  return { surplus, vanished, scannedFiles: files.length, protectedNames: names.size, sealedNames: sealed.size, found };
}

if (require.main === module) {
  const v = verdict();
  // BOTH COUNTS, side by side: the widening of 2026-11-08 is read from the
  // tool, not from a comment.
  process.stdout.write(`protected function names, SEALED subset (<= frozenThrough): ${v.sealedNames}\n`);
  process.stdout.write(`protected function names, ALL numbered migrations (the scope): ${v.protectedNames}\n`);
  process.stdout.write(`added by the owner's 2026-11-08 widening: ${candidateOnlyFunctionNames(REPO_ROOT).size} names, 17 of them money\n`);
  process.stdout.write(`files scanned outside migrations/: ${v.scannedFiles}\n`);
  process.stdout.write(`occurrences found: ${v.found.length} (baseline allows ${DR106_BASELINE.reduce((a, b) => a + b.count, 0)})\n`);
  for (const r of v.surplus) process.stdout.write(`SURPLUS\t${r.file}:${r.line}\t${r.fn}\n`);
  for (const r of v.vanished) process.stdout.write(`VANISHED\t${r.file}\t${r.fn}\texpected ${r.expected} found ${r.actual}\n`);
  const bad = v.surplus.length + v.vanished.length;
  process.stdout.write(`${bad === 0 ? 'DR-106 SEALED-REPLACEMENT LAW: PASS' : `DR-106 SEALED-REPLACEMENT LAW: FAIL (${bad})`}\n`);
  process.exit(bad === 0 ? 0 : 1);
}
