#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 RELEASE-EVIDENCE RUNNER — `npx tsx scripts/phase4-s9/run.ts`
 *
 * Prints every S9 check with its verdict, and carries the three evidence
 * sub-commands the release plan names.
 *
 * The exit status is non-zero when any check FAILS. On the live tree one check
 * DOES fail — `secret-scan-push-coverage`, over the real `ci.yml` asymmetry —
 * so this runner is a gate that has been observed RED. A gate that has never
 * been proven able to be RED is not a gate.
 *
 * It carries NO npm alias. `gate:phase4:release` is a PATCH REQUEST, because
 * the integrated gate cannot exist until S5, S6, S7 and S8 seal, and a gate
 * wired while red by design can never show a real regression appearing.
 *
 * Flags:
 *   --list               the plan, without evaluating anything
 *   --root=<dir>         point the registry at a copy of the tree (every red proof does this)
 *   --json               machine-readable evidence
 *   --plan               the ordered release plan
 *   --evidence-index     the evidence index
 *   --migration-hashes   the migration hash verification, as the release plan step 5 runs it
 *   --report             render the release report over the current tree
 */
import { join } from 'node:path';
import { S9_CHECKS, registryProblems, runS9 } from './index';
import { PHASE4_BASE, EVIDENCE_INDEX, renderReleaseReport, releaseReportProblems, verifyMergeBase } from './evidence';
import { PHASE4_INHERITED_PREFIX, PHASE4_PREFIX } from '../phase4-prefix';
import { RELEASE_PLAN, headSha, migrationHashProblems, verifyMigrationHashes } from './release';
import { runVerdict, tally } from '../phase4-s8/verdict';

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg === undefined ? join(__dirname, '..', '..') : rootArg.slice('--root='.length);

  if (args.includes('--list')) {
    console.log(`P4-S9 RELEASE EVIDENCE — ${S9_CHECKS.length.toString()} check(s). S9 IS EVIDENCE ONLY: no product fix belongs to this slice.`);
    for (const check of S9_CHECKS) {
      console.log(`\n${check.id} — ${check.title}`);
      console.log(`  ok:       ${check.ok}`);
      console.log(`  redProof: ${check.redProof}`);
      for (const subject of check.subjects) console.log(`  subject:  ${subject.kind} ${subject.name} (owed by ${subject.owedBy}) — ${subject.why}`);
    }
    process.exit(0);
  }

  if (args.includes('--plan')) {
    for (const step of [...RELEASE_PLAN].sort((a, b) => a.order - b.order))
      console.log(
        `${step.order.toString().padStart(2, ' ')}. ${step.id}${step.blocking ? ' [blocking]' : ''}${step.inExtractedArchive ? ' [in extracted archive]' : ''}` +
          `${step.produces === null ? '' : ` [produces ${step.produces}]`}\n    ${step.what}\n    ${step.command ?? '(no command: a refusal, not an execution)'}`,
      );
    process.exit(0);
  }

  if (args.includes('--evidence-index')) {
    for (const artefact of EVIDENCE_INDEX)
      console.log(
        `${artefact.id} [${artefact.shaBinding}]${artefact.required ? ' [required]' : ''} ${artefact.path}\n    ${artefact.claim}\n    produced by ${artefact.producedBy}`,
      );
    process.exit(0);
  }

  if (args.includes('--migration-hashes')) {
    const digests = new Map([...PHASE4_INHERITED_PREFIX, ...PHASE4_PREFIX].map(([name, sha256]) => [name, sha256] as const));
    const rows = verifyMigrationHashes(root, digests);
    const problems = migrationHashProblems(rows);
    if (args.includes('--json')) console.log(JSON.stringify({ root, rows, problems }, null, 2));
    else {
      for (const row of rows)
        console.log(
          `${row.agrees ? 'ok  ' : 'FAIL'} ${row.name} ${row.onDisk.slice(0, 16)}… manifest ${row.inManifest === null ? 'ABSENT' : 'recorded'} prefix ${row.inPrefixModule === null ? 'absent' : 'recorded'}`,
        );
      for (const problem of problems) console.error(`  ${problem}`);
      console.log(
        problems.length === 0
          ? `PASS ${rows.length.toString()} migration file(s) agree across disk, manifest and prefix module`
          : `FAIL ${problems.length.toString()} migration digest problem(s)`,
      );
    }
    process.exit(problems.length === 0 ? 0 : 1);
  }

  if (args.includes('--report')) {
    const head = headSha(root) ?? '0'.repeat(40);
    // No CI records and no artefacts are PASSED IN, because none have been
    // produced: the report is generated over what is real, and it says NO.
    const text = renderReleaseReport({
      sealSha: head,
      baseSha: PHASE4_BASE,
      ciRecords: [],
      artefactsPresent: [],
      archiveSha256: null,
      mergeBase: verifyMergeBase(root, head, 'main', PHASE4_BASE),
    });
    console.log(text);
    const problems = releaseReportProblems(text);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(problems.length === 0 ? 0 : 1);
  }

  const outcomes = runS9(root);
  const structural = registryProblems(root);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ root, outcomes, structural, tally: tally(outcomes) }, null, 2));
    process.exit(tally(outcomes).fail === 0 && structural.length === 0 ? 0 : 1);
  }

  for (const outcome of outcomes) {
    if (outcome.verdict === 'PASS') console.log(`PASS    ${outcome.id} — ${outcome.title}: ${S9_CHECKS.find((c) => c.id === outcome.id)?.ok ?? ''}`);
    else if (outcome.verdict === 'FAIL') console.error(`FAIL    ${outcome.id} — ${outcome.title}\n  ${outcome.problems.join('\n  ')}`);
    else {
      console.log(`WAITING_FOR_INTEGRATED_SURFACE  ${outcome.id} — ${outcome.title}`);
      for (const subject of outcome.missingSubjects) console.log(`  not yet real: ${subject.kind} ${subject.name} — owed by ${subject.owedBy}; ${subject.why}`);
      if (outcome.presentSubjects.length > 0) console.log(`  already real: ${outcome.presentSubjects.map((s) => `${s.kind} ${s.name}`).join(', ')}`);
    }
    if (outcome.note !== null) console.log(`        ${outcome.id} measured: ${outcome.note}`);
    console.log(`        ${outcome.id} red proof: ${outcome.redProof}`);
  }

  for (const problem of structural) console.error(`REGISTRY  ${problem}`);

  const t = tally(outcomes);
  console.log(`\n${runVerdict(t)}`);
  process.exit(t.fail === 0 && structural.length === 0 ? 0 : 1);
}
