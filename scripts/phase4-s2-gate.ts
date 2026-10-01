#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S2 — `npm run gate:phase4:s2`
 *
 * MINIMAL AND DELIBERATELY SO. This file is created by the owner of P4-S2's
 * first mandatory protection (`TL-P4-S1-R2`, lock §25) and carries that
 * protection and nothing else. P4-S2's remaining checks — the sale commit
 * primitive, the stock source bridge, the `invoice` accounting source type
 * moved here by `TL-P4-S1-R1`, the slice's migration boundary — belong to
 * whoever owns them, and each is added as a further `CHECKS` entry and a
 * further `S2_SUITES` row. Nothing here is a claim that this is the whole gate.
 *
 * It does NOT compose `gate:phase4:s1`. The sealed predecessor gate is long and
 * is run on its own; composing it here would mean this gate could not be run as
 * a fast answer to the one question it currently asks.
 *
 * ── P4-AL-60 / P4-AL-88 ──────────────────────────────────────────────────
 *
 * No line of this file bounds the future. There is no migration name, no count
 * of files compared with a literal, no `frozenThrough` equality and no
 * candidate-tense block: P4-S2 has no accepted migration, and when it has one
 * the boundary check that polices it is its owner's to add, fenced as
 * P4-AL-61 requires. `tests/security/phase4-forward-evolution.test.ts` polices
 * the shape of every `scripts/phase4-*.ts` but the open slice gate, and this
 * file is written to satisfy it as an ordinary member of that estate.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { phase4RlsForceStructuralProblems } from './guards/phase4-rls-force';

/** The suite that owns the live-catalogue half of the RLS law and its three red proofs. */
const RLS_SUITE = 'tests/guards/phase4-rls-force-guard.test.ts';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly run: (root: string) => string[];
  readonly ok: string;
}

/** The structural half of `TL-P4-S1-R2`: the canaries and the "never a handwritten list" meta-rule. */
const rlsStructuralProblems = (root: string): string[] => phase4RlsForceStructuralProblems(root);

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
