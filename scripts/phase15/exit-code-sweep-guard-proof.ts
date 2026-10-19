/**
 * PHASE 15 — GUARD-DELETION PROOF FOR THE EXIT-CODE SWEEP'S PROVENANCE RULE
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS IS ITS OWN INSTRUMENT
 *   `exit-code-sweep.ts` takes exactly one exemption — it does not scan itself —
 *   and that exemption is MEASURED rather than asserted: the file does not
 *   import `spawnSync` as a value, so it cannot run a command, so it has no exit
 *   code to discard. A guard-deletion test has to run a MODIFIED COPY of that
 *   sweep as a child process, which would mean importing `spawnSync` into it and
 *   withdrawing the exemption its own inertness earns. So the child-process half
 *   lives here instead, and the sweep stays inert.
 *
 * WHAT IT MEASURES (round-9B's F-R9B-01)
 *   The sweep used to credit ANY returned object literal carrying a property
 *   named `status` as forwarding a command's exit code — `{ status: 0, out }`
 *   included, with the real code thrown away. The fix requires the value's
 *   PROVENANCE: the status must come from the spawn result. `X15` in the sweep's
 *   own `--prove` shows the planted defect reddens. That alone cannot say WHICH
 *   rule caught it, so this instrument runs the same plant twice:
 *     1. against the real sweep           → it must be REPORTED
 *     2. against a copy of the sweep with the provenance requirement replaced by
 *        the old blanket test             → it must NOT be reported
 *   If the stripped copy still reports it, provenance is not what catches it and
 *   X15's red belongs to another rule; this instrument then fails rather than
 *   letting the pack keep a credit it has not earned.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SWEEP = join(ROOT, 'scripts/phase15/exit-code-sweep.ts');
const PLANT = 'planted-invented-status.ts';

/** The provenance requirement, as one line of this repository's source. */
const GUARD = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status' && fromSpawn(prop.initializer, call, bound)) return true;";
/** What it replaced, which is the fail-open the challenger measured. */
const BLANKET = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status') return true;";

/**
 * THE SECOND GUARD: THE APPARATUS EXEMPTION (round 14, F-R14-02).
 *
 * The sweep skips exactly one file — itself — and earns that skip by measuring
 * its own inertness. That measurement was a regex naming ONE module specifier,
 * so a pack whose `exit-code-sweep.ts` imported `spawnSync` from the bare
 * `'child_process'` and discarded a code kept the exemption and was never
 * read. The fix resolves the binding through the AST, on both spellings.
 *
 * Each spelling is planted into a COPY of the apparatus and swept twice: once
 * by the real sweep, once by a copy whose inertness check is the old regex.
 */
const INERT_AST: readonly string[] = [
  '  const sf = ast(APPARATUS, text);',
  '  const imported = new Set<string>();',
  '  for (const st of sf.statements) {',
  '    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;',
  '    if (!/^(?:node:)?child_process$/.test(st.moduleSpecifier.text)) continue;',
  '    const nb = st.importClause?.namedBindings;',
  "    if (nb !== undefined && ts.isNamedImports(nb)) for (const e of nb.elements) if ((e.propertyName ?? e.name).text === 'spawnSync') imported.add(e.name.text);",
  '    if (nb !== undefined && ts.isNamespaceImport(nb)) imported.add(`${nb.name.text}.spawnSync`);',
  '  }',
  '  for (const id of requireBound(sf)) imported.add(id);',
  '  const calls = producerCalls(sf, APPARATUS);',
];
/** The round-13 form, which named one spelling and read the text. */
const INERT_REGEX: readonly string[] = [
  "  const valueImport = /^import\\s*\\{[^}]*\\bspawnSync\\b[^}]*\\}\\s*from\\s*'node:child_process'/m.test(text);",
  '  const imported = valueImport ? new Set<string>([`spawnSync`]) : new Set<string>();',
  '  const calls: readonly unknown[] = [];',
];

/**
 * THE THIRD GUARD: A PRODUCER BOUND THROUGH A CALL (round 15, F-R15-02).
 *
 * `const { spawnSync: run } = createRequire(…)('child_process')` binds the
 * producer with no import declaration anywhere, so the import scan found
 * nothing and a bare `run(…)` that discarded its code was invisible — in any
 * pack file, not only in the apparatus.
 */
const REQUIRE_BOUND = '  for (const id of requireBound(sf)) ids.add(id);';
const REQUIRE_BLIND = '  // the require-bound producers are not added, which is the round-14 shape';
const REQUIRE_PLANT = 'planted-require-bound.ts';

function plantRequireBound(dir: string): void {
  writeFileSync(
    join(dir, REQUIRE_PLANT),
    [
      "import { createRequire } from 'node:module';",
      'const req = createRequire(__filename);',
      "const { spawnSync: run } = req('child_process') as typeof import('node:child_process');",
      'export function head(): string {',
      "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
      "  return (r.stdout ?? '').trim();",
      '}',
      '',
    ].join('\n'),
  );
}

/** Give a copy of the apparatus a real import and a real discarded exit code. */
function plantIntoApparatus(pack: string, specifier: string): void {
  const file = join(pack, 'exit-code-sweep.ts');
  const src = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    `${src}
import { spawnSync } from '${specifier}';
export function plantedRunner(): string {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return r.stdout ?? '';
}
`,
  );
}

function plant(dir: string): void {
  writeFileSync(
    join(dir, PLANT),
    [
      "import { spawnSync } from 'node:child_process';",
      '// A helper shaped like every other run-a-command helper in this pack. The',
      '// one thing it does not do is read the exit code: the `0` it hands on is',
      "// its own, and its caller's `if (r.status !== 0)` decides on that zero.",
      'export function run(cmd: string, args: readonly string[]): { status: number; out: string } {',
      "  const r = spawnSync(cmd, [...args], { encoding: 'utf8' });",
      "  return { status: 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };",
      '}',
      'export function listed(): readonly string[] {',
      "  const r = run('git', ['ls-files']);",
      "  if (r.status !== 0) throw new Error('git ls-files failed');",
      "  return r.out.split('\\n');",
      '}',
      '',
    ].join('\n'),
  );
}

/** Run one sweep over one pack copy. The exit code is read HERE, at the spawn. */
function sweepOver(script: string, pack: string): { readonly ran: boolean; readonly reported: boolean; readonly code: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, P15_SWEEP_DIR: pack } });
  const code = r.status;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // The sweep's own codes are 0 and 1. Anything else is this runner failing to
  // start it, which must never read as "nothing was reported".
  const ran = r.error === undefined && (code === 0 || code === 1);
  // ONLY the unchecked block counts. The sweep names every call it measured
  // too, so a bare `out.includes(PLANT)` is true in both arms — the plant's
  // file appears in the GREEN list when the sweep believes the invented status.
  // This proof read exactly that way at first and reported the stripped copy as
  // still catching the defect, which is the fail-open it exists to refuse.
  const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
  const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
  return { ran, reported: block.includes(PLANT), code: code, out };
}

/** The same reading, for any file name the unchecked block may carry. */
function sweepFile(script: string, pack: string, file: string): { readonly ran: boolean; readonly reported: boolean; readonly code: number | null } {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, P15_SWEEP_DIR: pack } });
  const code = r.status;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ran = r.error === undefined && (code === 0 || code === 1);
  const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
  const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
  return { ran, reported: block.includes(file), code };
}

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — GUARD-DELETION PROOF: PROVENANCE, AND THE APPARATUS EXEMPTION   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  const me = readFileSync(SWEEP, 'utf8');
  if (!me.includes(GUARD)) {
    console.log('  the provenance requirement is not written in the shape this proof removes, so nothing here was measured.');
    console.log('  Expected this line in scripts/phase15/exit-code-sweep.ts:');
    console.log(`    ${GUARD.trim()}`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A guard-deletion proof that cannot find the guard proves nothing.');
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'p15-guard-'));
  try {
    const pack = join(tmp, 'phase15');
    cpSync(join(ROOT, 'scripts/phase15'), pack, { recursive: true });
    plant(pack);
    const stripped = join(tmp, 'sweep-without-provenance.ts');
    writeFileSync(stripped, me.replace(GUARD, BLANKET));

    const real = sweepOver(SWEEP, pack);
    const without = sweepOver(stripped, pack);
    const problems: string[] = [];
    if (!real.ran) problems.push(`the real sweep did not run (exit ${String(real.code)}), so its silence says nothing`);
    else if (!real.reported) problems.push(`the real sweep did not report ${PLANT}: a helper that invents its status is being credited as a forwarder`);
    if (!without.ran) problems.push(`the sweep with the guard removed did not run (exit ${String(without.code)}), so the deletion arm is UNMEASURED`);
    else if (without.reported)
      problems.push(
        `the sweep with the provenance requirement REMOVED still reported ${PLANT}: provenance is not the rule that catches this, and the red proof credits it to the wrong guard`,
      );

    console.log(`  with provenance required   exit ${String(real.code)}  ${real.reported ? 'REPORTED the invented status' : 'said nothing'}`);
    console.log(
      `  with that one line removed exit ${String(without.code)}  ${without.reported ? 'REPORTED it anyway' : 'said nothing — so that line is what catches it'}`,
    );
    console.log('');
    // ── THE APPARATUS EXEMPTION, ON BOTH SPELLINGS ────────────────────────
    const strippedInert = join(tmp, 'sweep-with-the-old-inertness-check.ts');
    // THE WHOLE BLOCK, not line by line (round 15, measured on this proof).
    // Checking each line separately passed while the lines had drifted apart,
    // so `replace()` found nothing, the "stripped" copy was byte-identical to
    // the real sweep, and both arms agreed — a deletion proof that deleted
    // nothing and reported the agreement as a result.
    if (!me.includes(INERT_AST.join('\n'))) {
      console.log('  the apparatus inertness check is not written, as ONE contiguous block, in the shape');
      console.log('  this proof removes, so the second half measures nothing. Re-anchor it before reading.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    writeFileSync(strippedInert, me.replace(INERT_AST.join('\n'), INERT_REGEX.join('\n')));

    const apparatusRows: string[] = [];
    for (const specifier of ['child_process', 'node:child_process']) {
      const copy = join(tmp, `pack-${specifier.replace(':', '-')}`);
      cpSync(join(ROOT, 'scripts/phase15'), copy, { recursive: true });
      plantIntoApparatus(copy, specifier);
      const seen = sweepFile(SWEEP, copy, 'exit-code-sweep.ts');
      const seenStripped = sweepFile(strippedInert, copy, 'exit-code-sweep.ts');
      apparatusRows.push(
        `  import from '${specifier}'${specifier === 'child_process' ? '      ' : ' '} real sweep ${seen.ran ? (seen.reported ? 'WITHDREW the exemption and read it' : 'kept the exemption — the file was never read') : `did not run (exit ${String(seen.code)})`}`,
      );
      apparatusRows.push(
        `  ${' '.repeat(`import from '${specifier}'`.length)}${specifier === 'child_process' ? '      ' : ' '} old check  ${seenStripped.ran ? (seenStripped.reported ? 'WITHDREW it too' : 'kept the exemption — so the spelling is what the new check adds') : `did not run (exit ${String(seenStripped.code)})`}`,
      );
      if (!seen.ran) problems.push(`the real sweep did not run over the '${specifier}' plant (exit ${String(seen.code)}), so its silence says nothing`);
      else if (!seen.reported)
        problems.push(
          `a pack whose own apparatus imports spawnSync from '${specifier}' and discards a code kept its exemption: the one file the sweep may skip is the one file nobody can see`,
        );
      if (!seenStripped.ran)
        problems.push(
          `the sweep with the old inertness check did not run over the '${specifier}' plant (exit ${String(seenStripped.code)}), so that arm is UNMEASURED`,
        );
      else if (specifier === 'child_process' && seenStripped.reported)
        problems.push("the OLD inertness check also withdrew the exemption on the bare 'child_process' spelling, so the new check is not what catches it");
      else if (specifier === 'node:child_process' && !seenStripped.reported)
        problems.push("the old check did not withdraw the exemption on 'node:child_process' either, so this comparison is not isolating the spelling");
    }
    console.log('');
    console.log('  THE APPARATUS EXEMPTION, MEASURED ON BOTH SPELLINGS OF THE MODULE');
    for (const row of apparatusRows) console.log(row);
    // ── A PRODUCER BOUND THROUGH A CALL, IN AN ORDINARY PACK FILE ─────────
    if (!me.includes(REQUIRE_BOUND)) {
      console.log('  the require-bound producer rule is not written in the shape this proof removes, so');
      console.log('  the third section measures nothing. Re-anchor it before reading it again.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    const strippedRequire = join(tmp, 'sweep-without-require-bound.ts');
    writeFileSync(strippedRequire, me.replace(REQUIRE_BOUND, REQUIRE_BLIND));
    const reqPack = join(tmp, 'pack-require-bound');
    cpSync(join(ROOT, 'scripts/phase15'), reqPack, { recursive: true });
    plantRequireBound(reqPack);
    const reqReal = sweepFile(SWEEP, reqPack, REQUIRE_PLANT);
    const reqWithout = sweepFile(strippedRequire, reqPack, REQUIRE_PLANT);
    console.log('');
    console.log('  A PRODUCER BOUND THROUGH `createRequire` AND RENAMED, IN AN ORDINARY PACK FILE');
    console.log(
      `  real sweep      exit ${String(reqReal.code)}  ${reqReal.ran ? (reqReal.reported ? 'REPORTED the discarded code' : 'said nothing') : 'did not run'}`,
    );
    console.log(
      `  rule removed    exit ${String(reqWithout.code)}  ${reqWithout.ran ? (reqWithout.reported ? 'REPORTED it anyway' : 'said nothing — so that rule is what catches it') : 'did not run'}`,
    );
    if (!reqReal.ran) problems.push(`the real sweep did not run over the require-bound plant (exit ${String(reqReal.code)}), so its silence says nothing`);
    else if (!reqReal.reported)
      problems.push(
        'a bare call to a producer bound through `createRequire` discarded its exit code and the sweep said nothing: a fail-open in the rule that enumerates producers',
      );
    if (!reqWithout.ran)
      problems.push(`the sweep with the require-bound rule removed did not run (exit ${String(reqWithout.code)}), so that deletion is UNMEASURED`);
    else if (reqWithout.reported) problems.push('the sweep with the require-bound rule REMOVED still reported the plant, so that rule is not what catches it');

    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s). A rule that can be deleted without the proof noticing was never doing the work.`);
      return 1;
    }
    console.log('The provenance requirement is load-bearing: deleting that one line makes the planted');
    console.log('  defect invisible, and restoring it makes it visible again. The apparatus exemption is');
    console.log('  withdrawn on BOTH spellings of child_process, and the old check lost the bare one. A');
    console.log('  producer bound through `createRequire` and renamed is enumerated, and is invisible');
    console.log('  without the one line that enumerates it.');
    console.log('  Every plant and every run happens in a throwaway copy; neither this repository nor');
    console.log('  the pack is written to.');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
