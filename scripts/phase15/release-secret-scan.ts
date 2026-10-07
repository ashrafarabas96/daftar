#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 15 RELEASE SECRET SCAN — the whole shipped artifact
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS DIFFERENT ABOUT PHASE 15 SCOPE
 *
 * `scripts/phase3-secret-scan.ts` answers a question about a PULL REQUEST:
 * does the history between a named base and a named head contain a secret.
 * It answers it very carefully — an explicit range named by commit id, the
 * base proved against the merge-base, `--diff-merges=first-parent` so a
 * merge's own content is read, gitleaks pinned and checksum-verified, the
 * built-in default rule set with no in-tree config permitted,
 * `--ignore-gitleaks-allow` so no commit can suppress its own finding, and an
 * allowlist whose every entry is PROVED to be a migration digest rather than
 * trusted. That is the right question for a PR and the right machinery for
 * it, and this script does not rebuild any of it.
 *
 * Phase 15 asks a different question: does the ARTIFACT WE ARE ABOUT TO SHIP
 * contain a secret. A range scan cannot answer that. A range is a diff, and a
 * secret that entered the tree before the range's base is invisible to it
 * however many commits it reads; a release archive, meanwhile, can contain a
 * file no commit in the range ever touched. So the primary Phase 15 mode is
 * the WHOLE TREE, and history is a second, separately-named mode rather than
 * the thing a release rests on.
 *
 * WHAT THIS SCRIPT ADDS, AND WHAT IT REUSES
 *
 * It REUSES, by import, the whole of the Phase 3 machinery — `ensureGitleaks`
 * (pinned 8.24.3, archive digest and binary digest both verified),
 * `scanTree`, `scan`, `parseIgnoreFile`, `verifyTreeEntry`. Those exports are
 * usable as they stand, so nothing about gitleaks acquisition, the default
 * rule set, the config refusal or the proved allowlist is re-implemented
 * here; re-implementing them would mean two slightly different disciplines
 * and one of them eventually weaker.
 *
 * On top of that it adds exactly what release scope needs:
 *
 *   1. INDEPENDENT NON-VACUITY. `scanTree` reports how many files it scanned.
 *      This script does not take that number on trust: it recomputes the
 *      inventory itself (the delivery manifest's entries, or `git ls-files`)
 *      and FAILS unless the scan's own count equals its count and both are
 *      greater than zero. A secret scan that scanned nothing is the classic
 *      vacuous green — it prints "0 findings" and exits 0 — and the only
 *      defence is a subject count measured twice, from two places.
 *   2. MANIFEST DIGEST COVERAGE. `scanTree` checks a file against its
 *      recorded SHA-256 when the manifest records one. At release scope an
 *      inventory entry with NO recorded digest is itself a finding: the
 *      archive would then contain a file nothing binds to the source tree.
 *      So every entry must carry a 64-hex digest, and the count of verified
 *      digests is printed.
 *   3. AN INVENTORY-WIDE CONFIG REFUSAL. Phase 3 refuses a `.gitleaks.toml`
 *      at the scanned root. A release archive is a whole tree, so this script
 *      refuses one ANYWHERE in the inventory, and refuses any `.gitleaksignore`
 *      below the root as well: a nested ignore file in a subdirectory is read
 *      by gitleaks when that subdirectory is scanned, and nothing in a
 *      shipped artifact has any business carrying one.
 *   4. ALLOWLIST ENTRIES RE-PROVED AT RELEASE SCOPE. Every `.gitleaksignore`
 *      entry that applies to the tree is re-verified here, entry by entry,
 *      through the Phase 3 `verifyTreeEntry` — so the report can state how
 *      many entries were proved rather than how many were present — and an
 *      entry that no finding uses is named, because a stale exemption is how
 *      the next one gets waved through.
 *   5. A NAMED RANGE MODE. `--range=<base>..<head>` scans history, through
 *      the Phase 3 `scan`. The declared base is proved to be an ancestor of
 *      the head: `scan` proves its base by requiring it to equal
 *      `git merge-base <head> <main-ref>`, and `--main-ref` defaults here to
 *      the resolved base commit itself, for which that equality holds exactly
 *      when the base is an ancestor of the head. The proof is therefore the
 *      same proof, applied to an arbitrary declared base.
 *
 * WHAT IS NEVER A PASS
 *
 *   - gitleaks cannot be downloaded, or its archive or binary digest does not
 *     match the pin → UNMEASURED, exit non-zero, with the exact command and
 *     error. There is no "scan skipped" outcome and no fallback scanner.
 *   - the subject set is empty, or the two counts disagree → FAIL.
 *   - any finding that is not an allowlist entry PROVED against its content
 *     → FAIL.
 *   - a mode that was not run → UNMEASURED, named.
 *
 * Usage:
 *   npm run scan:secrets:release [-- --mode=auto|tree|range]
 *     --root=<dir>            the tree to scan (default: this repository)
 *     --range=<base>..<head>  range mode's range; or --base=/--head=
 *     --main-ref=<ref>        the ref the base lies on (default: the base itself)
 *     --gitleaks=<path>       a pre-obtained pinned binary (GITLEAKS_BIN also works)
 *     --json=<file>           write the summary object as JSON
 *
 * `auto` is tree mode. Exit 0 = PASS; FAIL and UNMEASURED both exit 1.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import {
  GITLEAKS_BINARY_SHA256,
  GITLEAKS_VERSION,
  SecretScanError,
  ensureGitleaks,
  git,
  parseIgnoreFile,
  scan,
  scanTree,
  verifyTreeEntry,
  type IgnoreEntry,
  type ScanResult,
} from '../phase3-secret-scan';

const ROOT = resolve(join(__dirname, '..', '..'));

/**
 * The lower bound on a release tree's file count.
 *
 * This is NOT a guess at the repository's size: it is a floor below which the
 * inventory is obviously not a DAFTAR release, so that a scan over a tree
 * that has been emptied, truncated or pointed at the wrong directory fails
 * instead of reporting a clean nothing. The real non-vacuity proof is the
 * two-sided count agreement; this is the backstop for the case where both
 * sides agree on a number that cannot be the artifact.
 */
const MIN_RELEASE_FILES = 200;

/** A file whose presence in a shipped tree would let the tree change the rules it is scanned under. */
const RULE_SUBVERTING_NAMES = ['.gitleaks.toml', 'gitleaks.toml'];

type Verdict = 'PASS' | 'FAIL' | 'UNMEASURED';

interface Finding {
  readonly check: string;
  readonly detail: string;
}

const findings: Finding[] = [];
const fail = (check: string, detail: string): void => {
  findings.push({ check, detail });
};

interface DeliveryInventory {
  readonly sourceCommit?: string;
  readonly inventory?: readonly { readonly path?: string; readonly sha256?: string }[];
}

/**
 * The inventory recomputed HERE, independently of `scanTree`'s own walk. The
 * whole point is that it is a second measurement: if this and the scan
 * disagree about how many files were read, neither number is evidence.
 */
function independentInventory(root: string): { readonly source: string; readonly paths: string[]; readonly withDigest: number; readonly head: string | null } {
  const manifestPath = join(root, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeliveryInventory;
    const entries = manifest.inventory ?? [];
    const paths: string[] = [];
    let withDigest = 0;
    entries.forEach((entry, i) => {
      const path = entry.path;
      if (typeof path !== 'string' || path === '') {
        fail('manifest', `DELIVERY_MANIFEST.json inventory entry ${i} has no path`);
        return;
      }
      paths.push(path);
      if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) withDigest += 1;
      else
        fail(
          'manifest-digest',
          `${path} is in the delivery inventory with no recorded SHA-256. An inventory entry without a digest binds the shipped file to nothing: the scan would read whatever is on disk and could not say it is the file the manifest means.`,
        );
    });
    return { source: 'DELIVERY_MANIFEST.json', paths, withDigest, head: manifest.sourceCommit ?? null };
  }
  const listed = git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((f) => f.length > 0 && existsSync(join(root, f)));
  return { source: 'git ls-files -z', paths: listed, withDigest: 0, head: git(root, ['rev-parse', 'HEAD']) };
}

/**
 * Rule-subverting files anywhere in the inventory, and any `.gitleaksignore`
 * below the root. Phase 3 refuses them at the scanned root; a release tree is
 * refused them everywhere.
 */
function checkRuleIntegrity(root: string, paths: readonly string[]): number {
  let checked = 0;
  for (const path of paths) {
    checked += 1;
    const base = posix.basename(path.split('\\').join('/'));
    if (RULE_SUBVERTING_NAMES.includes(base))
      fail(
        'rule-integrity',
        `${path} is a gitleaks configuration inside the shipped tree. This scan runs the built-in default rule set; a tree that carries a config is a tree that can narrow the rules it is judged by.`,
      );
    if (base === '.gitleaksignore' && path.split('\\').join('/').includes('/'))
      fail(
        'rule-integrity',
        `${path} is a .gitleaksignore below the root. gitleaks reads an ignore file from the directory it scans, so a nested one suppresses findings in its own subtree before any allowlist proof can see them.`,
      );
  }
  // The root ignore file is permitted — it is the allowlist this script proves
  // entry by entry — but nothing may be hidden under a nested one, and nothing
  // outside the inventory may be a config either.
  for (const name of RULE_SUBVERTING_NAMES) {
    if (existsSync(join(root, name)) && !paths.includes(name))
      fail(
        'rule-integrity',
        `${name} exists in the scanned tree but is not in the inventory (${root}). A config that the inventory does not list is a config nobody reviewed, and gitleaks would still read it.`,
      );
  }
  return checked;
}

/** The root `.gitleaksignore`'s entries, re-proved here one by one. */
function proveAllowlist(root: string): { present: boolean; total: number; treeEntries: number; proved: number } {
  const path = join(root, '.gitleaksignore');
  if (!existsSync(path)) return { present: false, total: 0, treeEntries: 0, proved: 0 };
  const text = readFileSync(path, 'utf8');
  const parsed = parseIgnoreFile(text);
  for (const problem of parsed.problems) fail('allowlist', problem);
  const treeEntries: IgnoreEntry[] = parsed.entries.filter((e) => e.kind === 'tree');
  let proved = 0;
  for (const entry of treeEntries) {
    const problem = verifyTreeEntry(root, entry);
    if (problem === null) proved += 1;
    else
      fail(
        'allowlist',
        `${problem}. An allowlist entry is proved against the content it names on every run, or it does not apply — a listed fingerprint is not a reason.`,
      );
  }
  return { present: true, total: parsed.entries.length, treeEntries: treeEntries.length, proved };
}

/** Anything that would make a scan result unusable as evidence, whatever the scan said. */
function checkScanIntegrity(result: ScanResult): void {
  if (result.tool.version !== GITLEAKS_VERSION) fail('tool', `the scan ran gitleaks ${result.tool.version}, not the pinned ${GITLEAKS_VERSION}`);
  if (result.tool.binarySha256 !== GITLEAKS_BINARY_SHA256)
    fail('tool', `the scan ran a gitleaks binary with SHA-256 ${result.tool.binarySha256}, not the pinned ${GITLEAKS_BINARY_SHA256}`);
  if (result.findings === null) fail('scan', 'the scan produced no findings report at all — gitleaks did not complete, so there is no measurement to read');
  // `scan`/`scanTree` already push one `problems` line per remaining finding.
  // Those are reported below as `[secret]`, with the rule, file, line and
  // commit broken out, so repeating them verbatim here would double every
  // leak in the output and make the count of distinct defects unreadable.
  // Every OTHER problem — a precondition, an allowlist entry that did not
  // prove, a gitleaks failure — is reported as it stands.
  for (const problem of result.problems) if (!problem.startsWith('finding ')) fail('scan', problem);
  for (const r of result.remaining)
    fail('secret', `${r.rule} in ${r.file}:${r.line}${r.commit === null ? '' : ` at ${r.commit.slice(0, 12)}`} (${r.fingerprint})`);
}

// ── tree mode ────────────────────────────────────────────────────────────

interface TreeOutcome {
  readonly mode: 'tree';
  readonly root: string;
  readonly inventorySource: string;
  readonly inventoryFiles: number;
  readonly filesScanned: number | null;
  readonly digestsRecorded: number;
  readonly head: string | null;
  readonly allowlist: { present: boolean; total: number; treeEntries: number; proved: number };
  readonly gitleaksFindings: number | null;
  readonly allowlisted: number;
  readonly remaining: number;
}

function runTree(root: string, gitleaks: string): TreeOutcome {
  const inventory = independentInventory(root);
  console.log(`  inventory source: ${inventory.source}`);
  console.log(`  subject: ${inventory.paths.length} files in the inventory, ${inventory.withDigest} with a recorded SHA-256`);

  if (inventory.paths.length === 0)
    fail(
      'non-vacuity',
      `the inventory of ${root} lists 0 files. A secret scan over an empty subject set reports no findings and means nothing; this is a failure, not a clean tree.`,
    );
  else if (inventory.paths.length < MIN_RELEASE_FILES)
    fail(
      'non-vacuity',
      `the inventory of ${root} lists ${inventory.paths.length} files, below the MIN_RELEASE_FILES floor of ${MIN_RELEASE_FILES}. A DAFTAR release tree is not this small; the scan is pointed at something that is not the artifact.`,
    );

  const examined = checkRuleIntegrity(root, inventory.paths);
  console.log(`  subject: ${examined} inventory paths examined for a rule-subverting config`);
  const allowlist = proveAllowlist(root);
  console.log(`  subject: ${allowlist.treeEntries} tree allowlist entries, ${allowlist.proved} proved against their content`);

  const result = scanTree({ root, gitleaks });
  checkScanIntegrity(result);
  console.log(`  gitleaks: ${result.tool.version} (sha256 ${result.tool.binarySha256.slice(0, 16)}…)`);
  console.log(`  subject: gitleaks reports ${String(result.filesScanned)} files scanned`);

  // The two-sided count: the scan's own number against this script's.
  if (result.filesScanned === null) fail('non-vacuity', 'the scan did not report how many files it read, so its "no findings" covers an unknown subject set');
  else if (result.filesScanned !== inventory.paths.length)
    fail(
      'non-vacuity',
      `gitleaks scanned ${result.filesScanned} files but the inventory recomputed here holds ${inventory.paths.length}. Two independent counts of the same subject set disagree, so neither is evidence.`,
    );
  if (allowlist.treeEntries !== allowlist.proved)
    fail('allowlist', `${allowlist.treeEntries - allowlist.proved} of ${allowlist.treeEntries} tree allowlist entries were not proved`);
  for (const a of result.allowlisted) console.log(`  allowlisted: ${a.fingerprint} — ${a.reason}`);
  const unused = result.ignoreFile.unused;
  if (unused > 0)
    console.log(
      `  note: ${unused} allowlist entr${unused === 1 ? 'y' : 'ies'} matched no finding this run — a stale exemption is how the next one gets waved through`,
    );

  return {
    mode: 'tree',
    root,
    inventorySource: inventory.source,
    inventoryFiles: inventory.paths.length,
    filesScanned: result.filesScanned,
    digestsRecorded: inventory.withDigest,
    head: inventory.head ?? result.head,
    allowlist,
    gitleaksFindings: result.findings,
    allowlisted: result.allowlisted.length,
    remaining: result.remaining.length,
  };
}

// ── range mode ───────────────────────────────────────────────────────────

interface RangeOutcome {
  readonly mode: 'range';
  readonly repo: string;
  readonly base: string | null;
  readonly head: string | null;
  readonly mainRef: string | null;
  readonly mergeBase: string | null;
  readonly commitsInRange: number | null;
  readonly commitsScanned: number | null;
  readonly gitleaksFindings: number | null;
  readonly allowlisted: number;
  readonly remaining: number;
}

function runRange(repo: string, baseRev: string, headRev: string, mainRef: string | undefined, gitleaks: string): RangeOutcome {
  const head = git(repo, ['rev-parse', '--verify', `${headRev}^{commit}`]);
  const base = git(repo, ['rev-parse', '--verify', `${baseRev}^{commit}`]);
  console.log(`  base: ${base} (${baseRev})`);
  console.log(`  head: ${head} (${headRev})`);
  if (base === head)
    fail('non-vacuity', `base and head are the same commit ${head}: the range holds no commits, and a scan of nothing is not evidence of anything`);

  // The Phase 3 scan proves its declared base by requiring it to equal
  // `git merge-base <head> <main-ref>`. Defaulting the main ref to the base
  // itself turns that into exactly the ancestry proof a release range needs:
  // `merge-base(head, base) == base` holds precisely when base is an ancestor
  // of head. A caller who wants the stricter "the base is on main" proof
  // passes `--main-ref=origin/main` and gets it.
  const result = scan({ repo, head, base, mainRef: mainRef ?? base, gitleaks, phase3Head: head });
  checkScanIntegrity(result);
  console.log(`  gitleaks: ${result.tool.version} (sha256 ${result.tool.binarySha256.slice(0, 16)}…)`);
  console.log(`  log options: ${String(result.logOpts)}`);
  console.log(
    `  subject: ${String(result.commitsInRange)} commits in range (${String(result.mergesInRange)} merges), ${String(result.commitsScanned)} scanned`,
  );

  if (result.commitsInRange === null || result.commitsInRange < 1)
    fail('non-vacuity', `the range ${base.slice(0, 12)}..${head.slice(0, 12)} holds ${String(result.commitsInRange)} commits`);
  if (result.commitsScanned !== result.commitsInRange)
    fail(
      'non-vacuity',
      `gitleaks read ${String(result.commitsScanned)} of ${String(result.commitsInRange)} commits in the range. A scan that read fewer commits than the range holds is the exact defect the Phase 3 scan exists to answer, and it is not a pass here either.`,
    );

  return {
    mode: 'range',
    repo,
    base: result.base,
    head: result.head,
    mainRef: result.mainRef,
    mergeBase: result.mergeBase,
    commitsInRange: result.commitsInRange,
    commitsScanned: result.commitsScanned,
    gitleaksFindings: result.findings,
    allowlisted: result.allowlisted.length,
    remaining: result.remaining.length,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function emit(summary: Record<string, unknown>, verdict: Verdict, jsonOut: string | undefined): never {
  if (jsonOut !== undefined) {
    const p = resolve(jsonOut);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log('');
  console.log(`P15_RELEASE_SECRET_SCAN: ${JSON.stringify(summary)}`);
  console.log(`PHASE 15 RELEASE SECRET SCAN: ${verdict}`);
  for (const f of findings) console.log(`  - [${f.check}] ${f.detail}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

function main(): never {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const root = resolve(flag('root') ?? ROOT);
  const jsonOut = flag('json');
  const rangeArg = flag('range');
  const requested = flag('mode') ?? (rangeArg === undefined && flag('base') === undefined ? 'auto' : 'range');
  if (!['auto', 'tree', 'range'].includes(requested)) {
    emit(
      { produced: 'scripts/phase15/release-secret-scan.ts', result: 'UNMEASURED', cause: `--mode must be auto, tree or range, not "${requested}"` },
      'UNMEASURED',
      jsonOut,
    );
  }
  const mode = requested === 'auto' ? 'tree' : requested;

  console.log('PHASE 15 RELEASE SECRET SCAN');
  console.log(`  scope: ${mode === 'tree' ? 'the whole shipped tree' : 'git history (a named range)'}`);
  console.log(`  root: ${root}`);
  console.log(`  rule set: gitleaks ${GITLEAKS_VERSION} built-in defaults, --ignore-gitleaks-allow, no in-tree config permitted`);
  if (!existsSync(root)) {
    emit({ produced: 'scripts/phase15/release-secret-scan.ts', mode, root, result: 'UNMEASURED', cause: `${root} does not exist` }, 'UNMEASURED', jsonOut);
  }
  if (readdirSync(root).length === 0) {
    emit(
      { produced: 'scripts/phase15/release-secret-scan.ts', mode, root, result: 'UNMEASURED', cause: `${root} is empty: there is no artifact here to scan` },
      'UNMEASURED',
      jsonOut,
    );
  }

  // gitleaks first, and loudly: an unobtainable or unverifiable scanner is
  // UNMEASURED. There is no fallback scanner and no "skipped" outcome.
  let gitleaks: string;
  try {
    gitleaks = ensureGitleaks(flag('gitleaks') ?? process.env['GITLEAKS_BIN'], ROOT);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit(
      {
        produced: 'scripts/phase15/release-secret-scan.ts',
        mode,
        root,
        result: 'UNMEASURED',
        unmeasuredArm: 'gitleaks-acquisition',
        cause:
          `the pinned gitleaks ${GITLEAKS_VERSION} could not be obtained or verified: ${message}. ` +
          `The download is \`curl -fsSL --retry 3 -o <tmp>/gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz\`, ` +
          `and the archive and the extracted binary are both checked against their pinned SHA-256. Nothing was scanned, so nothing is claimed.`,
      },
      'UNMEASURED',
      jsonOut,
    );
  }

  let outcome: TreeOutcome | RangeOutcome;
  try {
    if (mode === 'tree') {
      outcome = runTree(root, gitleaks);
    } else {
      let baseRev = flag('base');
      let headRev = flag('head');
      if (rangeArg !== undefined) {
        const parts = rangeArg.split('..');
        if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
          emit(
            {
              produced: 'scripts/phase15/release-secret-scan.ts',
              mode,
              root,
              result: 'UNMEASURED',
              cause: `--range must be <base>..<head>, not "${rangeArg}"`,
            },
            'UNMEASURED',
            jsonOut,
          );
        }
        baseRev = parts[0];
        headRev = parts[1];
      }
      if (baseRev === undefined || headRev === undefined) {
        emit(
          {
            produced: 'scripts/phase15/release-secret-scan.ts',
            mode,
            root,
            result: 'UNMEASURED',
            unmeasuredArm: 'range',
            cause: 'range mode needs --range=<base>..<head> (or --base= and --head=); no range was named, so no history was read',
          },
          'UNMEASURED',
          jsonOut,
        );
      }
      outcome = runRange(root, baseRev, headRev, flag('main-ref'), gitleaks);
    }
  } catch (e) {
    if (!(e instanceof SecretScanError)) throw e;
    emit(
      { produced: 'scripts/phase15/release-secret-scan.ts', mode, root, result: 'UNMEASURED', unmeasuredArm: mode, cause: e.message },
      'UNMEASURED',
      jsonOut,
    );
  }

  const verdict: Verdict = findings.length === 0 ? 'PASS' : 'FAIL';
  emit(
    {
      produced: 'scripts/phase15/release-secret-scan.ts',
      tool: { name: 'gitleaks', version: GITLEAKS_VERSION, pinnedBinarySha256: GITLEAKS_BINARY_SHA256 },
      ...outcome,
      findings: findings.length,
      checksFailed: [...new Set(findings.map((f) => f.check))],
      result: verdict,
    },
    verdict,
    jsonOut,
  );
}

if (require.main === module) main();
