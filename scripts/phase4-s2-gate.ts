#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S2 — `npm run gate:phase4:s2`
 *
 * It does NOT compose `gate:phase4:s1`. The sealed predecessor gate is long and
 * is run on its own; composing it here would mean this gate could not be run as
 * a fast answer to the questions it asks.
 *
 * ── P4-AL-60 / P4-AL-61 / P4-AL-88 ───────────────────────────────────────
 *
 * This file is now the OPEN SLICE GATE, which
 * `tests/security/phase4-forward-evolution.test.ts` exempts from the
 * forbidden-shape rules for exactly one reason: P4-AL-61 authorises the open
 * slice's gate — and only it — to assert a CANDIDATE TENSE. That block is
 * fenced between two `CANDIDATE-TENSE (P4-AL-61)` markers below, and the P4-S2
 * acceptance commit DELETES what the fence encloses and fills `S2_ACCEPTED`
 * with the digests. Nothing else here bounds the future: no count of `.sql`
 * files against a literal, no `frozenThrough` equality, and no migration name
 * outside the fence.
 *
 * The marker moved here from `scripts/phase4-s1-gate.ts` in the same commit
 * that wired this roster. P4-S1 is accepted, its gate carries no fence, and it
 * is policed by the shape rules as an ordinary member of the estate again —
 * which is the transition P4-AL-61 exists to make legible.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { phase4RlsForceStructuralProblems } from './guards/phase4-rls-force';
import { closureRuleProblems as predecessorClosureRuleProblems, suitesIn } from './phase4-s1-gate';
import { testTitles } from './phase3-s8-gate';
import { readFileSync } from 'node:fs';

/** The suite that owns the live-catalogue half of the RLS law and its three red proofs. */
const RLS_SUITE = 'tests/guards/phase4-rls-force-guard.test.ts';

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

/**
 * The migrations P4-S2 has had ACCEPTED, by digest. Empty while the slice is
 * open, which is what puts this gate in the candidate tense; the acceptance
 * commit fills it and deletes the fenced block below (P4-AL-61).
 */
export const S2_ACCEPTED: Readonly<Record<string, string>> = {};

export interface SuiteRow {
  readonly id: string;
  /** The suite file, or a DIRECTORY handed to the runner whole. */
  readonly file: string;
  readonly directory?: true;
  /** What this suite is the gate's evidence FOR. */
  readonly claim: string;
  /** `<test file>::<it( title prefix>` — the planted-defect proof this row's verdict rests on (P4-AL-67). */
  readonly proof: string;
}

/**
 * P4-S2's suite roster, delivered by the golden and concurrency owner and
 * accepted as written. Each row names the claim it carries and the `it(` title
 * of the planted-defect proof that shows the claim can go RED — a row whose
 * proof does not resolve is a row asserting something nobody has shown is
 * falsifiable, which `redProofRowProblems` refuses.
 */
export const S2_SUITES: readonly SuiteRow[] = [
  {
    id: 'S2-G05',
    file: 'tests/golden-regression/phase4-s2/05-last-item-race.golden.test.ts',
    claim: 'the last-item race on the stock writer the sale must use: no oversell, and the lock order is the key order',
    proof:
      'tests/golden-regression/phase4-s2/05-last-item-race.golden.test.ts::the lock order is the KEY order and not the payload order — the deterministic lock-order probe',
  },
  {
    id: 'S2-G06',
    file: 'tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts',
    claim: 'the same race through POST /v1/sales: exactly one commit, exactly one stable business refusal, no orphan of any kind (§16)',
    proof:
      'tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts::exactly one attempt is refused, and the refusal is a stable business refusal naming the stock',
  },
  {
    id: 'S2-G07',
    file: 'tests/golden-regression/phase4-s2/07-atomic-sale-law.golden.test.ts',
    claim: '§15 as laws over committed state, plus §18: the official reconciliation identity and the structural ban on reconstructing it',
    proof: 'tests/golden-regression/phase4-s2/07-atomic-sale-law.golden.test.ts::the identity is never reconstructed from quantity × average cost',
  },
  {
    id: 'S2-G08',
    file: 'tests/golden-regression/phase4-s2/08-sale-idempotency.golden.test.ts',
    claim: 'the replay contract, structural and behavioural (P4-AL-30: the stored intent is read before any write)',
    proof: 'tests/golden-regression/phase4-s2/08-sale-idempotency.golden.test.ts::the same document id with a DIFFERENT intent is refused, and writes nothing',
  },
  {
    id: 'S2-I01',
    file: 'tests/integration/sale-s2-interleaving.test.ts',
    claim: 'that the forcing MECHANISM works: the blockedBehind fixed point, every throw of waitUntilQueued, and no retry anywhere (§16: no sleeps)',
    proof: 'tests/integration/sale-s2-interleaving.test.ts::a real deadlock is classified as a deadlock, and expectNoDeadlock fails on it',
  },
  {
    id: 'S2-I02',
    file: 'tests/integration/sale-s2-atomic-law.test.ts',
    claim: 'failure injection at every DISCOVERED seam the sale writes, including stock_source_bindings, and the held-lock case on the invoice series',
    /**
     * The PREMISE, not the held-lock case itself. Planting the regression —
     * putting `invoice_sequences` back into the trigger set — fails this law
     * AND the generated case that then cannot fire, and this is the one that
     * says why: a row trigger cannot observe a row lock. Twice this slice the
     * injection was reported as a defect because a comment was carrying that
     * premise.
     */
    proof:
      'tests/integration/sale-s2-atomic-law.test.ts::invoice_sequences is LOCKED and never written, so it belongs to the held-lock case and not to the trigger set',
  },
  {
    id: 'S2-C01',
    file: 'tests/integration/sale-s2-cogs-owed.test.ts',
    claim: "C-07's matched pair: the live-catalogue agreement law, and the ZERO and NON-ZERO arms driven through the real sale command",
    proof: 'tests/integration/sale-s2-cogs-owed.test.ts::PLANTED: a strictly-negative predicate on the LINE guard is reported, and names the guard',
  },
  {
    id: 'S2-T01',
    file: 'tests/integration/sale-s2-bridge-tenancy.test.ts',
    claim: 'the sale bridge carries tenant_id as a real NOT NULL column with the composite businesses FK, and the two shapes differ in nothing else',
    proof: 'tests/integration/sale-s2-bridge-tenancy.test.ts::tenant_id inside the PRIMARY KEY is refused by the guard as `bridge_pk`',
  },
  {
    id: 'S2-A01',
    file: 'tests/integration/sale-s2-seam-authority.test.ts',
    claim: 'the seam accounting authority: the conditional COGS arm, the required revenue element, and the two malformed shapes that are never tolerated typos',
    proof:
      'tests/integration/sale-s2-seam-authority.test.ts::a conditional assertion that is not one of the transaction own assertions is MALFORMED, never a tolerated typo',
  },
  {
    id: 'S2-B01',
    file: 'tests/guards/sale-s2-base-split-agreement.test.ts',
    claim: 'the two base-split implementations in two packages agree over a swept range, so agreement is a property rather than a handful of coincidences',
    proof: 'tests/guards/sale-s2-base-split-agreement.test.ts::THE VECTORS DISCRIMINATE: flipping the tie rule changes the answer on at least three of them',
  },
  {
    id: 'S2-R01',
    file: 'tests/guards/sale-s2-red-proofs.test.ts',
    claim: 'that every law on the books has a planted defect, and that the runner’s exit status can carry a refusal',
    proof: 'tests/guards/sale-s2-red-proofs.test.ts::the runner’s exit status can say no — and can say yes',
  },
];

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly run: (root: string) => string[];
  readonly ok: string;
}

/** The structural half of `TL-P4-S1-R2`: the canaries and the "never a handwritten list" meta-rule. */
const rlsStructuralProblems = (root: string): string[] => phase4RlsForceStructuralProblems(root);

/** Every roster row names a file that exists, carries a claim, and has a resolvable red proof. Ids are unique. */
export function rosterProblems(root: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const row of S2_SUITES) {
    if (ids.has(row.id)) problems.push(`${row.id} is listed twice`);
    ids.add(row.id);
    if (!has(root, row.file)) {
      problems.push(`${row.id}: ${row.file} is missing`);
      continue;
    }
    if (row.claim.trim().length < 20) problems.push(`${row.id}: the claim is too short to say what this row is evidence for`);
    const [file = '', prefix = ''] = row.proof.split('::');
    if (prefix.trim() === '') {
      problems.push(`${row.id}: ${row.proof} names no title`);
      continue;
    }
    if (!has(root, file)) {
      problems.push(`${row.id}: the proof file ${file} does not exist`);
      continue;
    }
    if (!testTitles(read(root, file)).some((t) => t.startsWith(prefix))) {
      problems.push(`${row.id}: no it( title in ${file} starts with "${prefix}"`);
    }
  }
  /**
   * Placement, which the SEALED predecessor gate polices from the other side:
   * its `suiteProblems` refuses any `phase4-*.test.ts` under `tests/integration`,
   * `tests/security` or `tests/performance` that `S1_SUITES` does not list, and
   * ANY `.test.ts` under `tests/golden-regression/phase4` that it does not list.
   * That is why this slice's suites are named `sale-s2-*` and its goldens live
   * in `tests/golden-regression/phase4-s2`. A P4-S2 suite dropped into either
   * forbidden place turns the predecessor gate red for a reason that reads as
   * nothing to do with placement, so this gate says it in its own words.
   */
  const listed = new Set(S2_SUITES.flatMap((r) => (r.directory === true ? suitesIn(root, r.file) : [r.file])));
  const S2_GOLDEN_DIR = 'tests/golden-regression/phase4-s2';
  if (!has(root, S2_GOLDEN_DIR)) problems.push(`${S2_GOLDEN_DIR} is missing — this slice's goldens cannot live in the predecessor's directory`);
  else
    for (const f of suitesIn(root, S2_GOLDEN_DIR))
      if (!listed.has(f)) problems.push(`${f} is a P4-S2 golden no S2_SUITES row lists — it would run and no gate row would rest on it`);
  for (const dir of ['tests/integration', 'tests/guards']) {
    if (!has(root, dir)) continue;
    for (const f of readdirSync(join(root, dir)).sort())
      if (/^sale-s2-.*\.test\.ts$/.test(f) && !listed.has(`${dir}/${f}`)) problems.push(`${dir}/${f} is a P4-S2 suite no S2_SUITES row lists`);
  }
  return problems;
}

// ───── CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────────
// P4-S2's migration boundary, in the CANDIDATE tense. `0077` and `0078` are
// written, applied and tested, and they are NOT frozen: the manifest's
// `frozenThrough` is still the predecessor's accepted head, and no entry for
// either file exists in it. That is the whole claim, and it is a claim about
// TODAY which stops being true the moment the Tech Lead accepts this slice —
// which is why it lives here, behind this fence, and why the acceptance commit
// DELETES everything between these two markers and fills `S2_ACCEPTED`.
//
// P4-AL-60 is not violated by the migration names below BECAUSE of the fence:
// a permanent module may never name them, and this block is by construction
// not permanent.
const S2_CANDIDATES: readonly string[] = ['0077_phase4_sales_sale_items_sources.sql', '0078_phase4_sale_commit.sql'];

/** The candidate migrations exist on disk and NONE of them is frozen yet. */
export function candidateBoundaryProblems(root: string): string[] {
  if (Object.keys(S2_ACCEPTED).length > 0) return [];
  const problems: string[] = [];
  const manifestRel = 'infrastructure/database/MIGRATION_MANIFEST.json';
  if (!has(root, manifestRel)) return [`${manifestRel} is missing`];
  const manifest = JSON.parse(read(root, manifestRel)) as {
    frozenThrough?: string;
    migrations?: readonly { readonly name: string }[];
  };
  const frozen = new Set((manifest.migrations ?? []).map((m) => m.name));
  for (const name of S2_CANDIDATES) {
    if (!has(root, `infrastructure/database/migrations/${name}`)) problems.push(`${name} is a declared P4-S2 candidate and is not on disk`);
    if (frozen.has(name)) problems.push(`${name} is frozen in the manifest while P4-S2 is still open — only the Tech Lead's acceptance freezes a migration`);
    if (manifest.frozenThrough === name) problems.push(`frozenThrough is ${name}, a candidate of the open slice`);
  }
  return problems;
}
// ───── end CANDIDATE-TENSE (P4-AL-61) ─────────────────────────────────────

/**
 * The closure rules, plus this gate's own tense.
 *
 * The permanent-module sweep is DELEGATED to the predecessor gate, which still
 * owns it — P4-S1 is accepted, so its own self-check contributes nothing and
 * composing is not double-counting. What is added is the half that moved here
 * with the open-slice marker: while this slice is open the candidate tense must
 * be FENCED between a pair of markers, so the acceptance commit can find what
 * to delete; once `S2_ACCEPTED` is filled the fence must be GONE.
 */
export function closureRuleProblems(root: string): string[] {
  const problems = [...predecessorClosureRuleProblems(root)];
  const self = 'scripts/phase4-s2-gate.ts';
  if (!has(root, self)) return problems;
  const text = read(root, self);
  // The FENCE COMMENTS, not every mention: the diagnostics below name the
  // marker too, and a function that counted its own error message would report
  // a surviving fence in the accepted tense for ever.
  const fences = text.split('\n').filter((l) => /^\s*\/\/\s*[─-]+\s*(?:end\s+)?CANDIDATE-TENSE \(P4-AL-61\)/.test(l)).length;
  const candidate = Object.keys(S2_ACCEPTED).length === 0;
  if (candidate && fences < 2)
    problems.push(
      `${self}: the candidate-tense block is not fenced between two "CANDIDATE-TENSE (P4-AL-61)" markers, so the acceptance commit cannot find what to delete`,
    );
  if (!candidate && fences > 0)
    problems.push(`${self}: P4-S2 is accepted and the candidate-tense block is still here — the acceptance commit deletes it (P4-AL-61)`);
  return problems;
}

/**
 * The runtime half: the suite is executed, because the catalogue claim cannot
 * be made without a database and a check that skipped it would be a pass with
 * no subject. `--structural-only` suppresses it for a tree with no cluster, and
 * the verdict then says the runtime half did not run.
 */
function rlsSuiteProblems(root: string): string[] {
  if (!existsSync(join(root, RLS_SUITE))) return [`${RLS_SUITE} is missing — the live-catalogue half of TL-P4-S1-R2 has no owner`];
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', RLS_SUITE], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if (r.status === 0) return [];
  return [`${RLS_SUITE} refuses this tree:\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000)}`];
}

export const CHECKS: readonly Check[] = [
  {
    id: 'rls-force-structural',
    title: 'the Phase 4 RLS/FORCE discovery, structural half (TL-P4-S1-R2)',
    run: rlsStructuralProblems,
    ok: 'the inherited-prefix reader and the applier subtraction both have subjects, the migration tree declares a Phase 4 surface, and no discovered relation name is a string literal in the law',
  },
  {
    id: 'rls-force-runtime',
    title: 'the Phase 4 RLS/FORCE discovery, live catalogue and its three red proofs',
    run: rlsSuiteProblems,
    ok: 'every discovered Phase 4 relation ENABLEs and FORCEs row level security, and the law is proved red on a disabled relation, a lifted FORCE and a relation the discovery omits',
  },
  {
    id: 'roster',
    title: "P4-S2's suite roster, and the placement the sealed predecessor gate polices from the other side",
    run: rosterProblems,
    ok: 'every row names a suite that exists, states what it is evidence for, and resolves to a planted-defect proof that shows the claim can go red; and no sale-s2 suite or phase4-s2 golden on disk is unlisted',
  },
  {
    id: 'closure-and-tense',
    title: 'the closure rules, and this gate holding the open slice’s candidate tense (P4-AL-60 / P4-AL-61)',
    run: closureRuleProblems,
    ok: 'no permanent module bounds the future, and the candidate-tense block is fenced between the two markers the acceptance commit deletes',
  },
  {
    id: 'candidate-boundary',
    title: `the P4-S2 migration boundary (${Object.keys(S2_ACCEPTED).length === 0 ? 'candidate' : 'accepted'} tense)`,
    run: candidateBoundaryProblems,
    ok:
      Object.keys(S2_ACCEPTED).length === 0
        ? 'the slice’s migrations are on disk, and NONE of them is frozen — only the Tech Lead’s acceptance freezes a migration'
        : 'the slice’s migrations are accepted and frozen by digest',
  },
];

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const structuralOnly = args.includes('--structural-only');
  const checks = structuralOnly ? CHECKS.filter((c) => c.id !== 'rls-force-runtime') : CHECKS;
  let failed = 0;
  for (const check of checks) {
    const problems = check.run(root);
    if (problems.length === 0) console.log(`ok   ${check.id} — ${check.title}: ${check.ok}`);
    else {
      failed += 1;
      console.error(`FAIL ${check.id} — ${check.title}\n  ${problems.join('\n  ')}`);
    }
  }
  const skipped = CHECKS.length - checks.length;
  console.log(
    failed === 0
      ? `PASS gate:phase4:s2 at ${root}: ${checks.length} check(s) ok${skipped > 0 ? `; ${skipped} runtime check(s) NOT RUN (--structural-only) — not a pass` : ''}`
      : `FAIL gate:phase4:s2 at ${root}: ${failed} of ${checks.length} check(s) refuse this tree`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
