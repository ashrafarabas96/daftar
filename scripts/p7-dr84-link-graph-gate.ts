/**
 * DR-84's link gate, judged on Gradle's OWN resolved dependency graph instead
 * of on the text of one build file.
 *
 * WHY THIS EXISTS AT ALL. `tests-unit/p7-01-capture-digest-gate.test.ts` reads
 * `apps/android/app/build.gradle.kts` line by line and refuses the single
 * spelling `project(":offline-kernel")` while the decision record is OPEN.
 * The independent review of the P7 seal file found that gate too narrow, and
 * the owner ordered it strengthened (2026-11-08): a declaration can reach the
 * same dependency by spellings that line never sees —
 *
 *   - `implementation(project(path = ":offline-kernel"))`
 *   - `implementation(projects.offlineKernel)`          (type-safe accessors)
 *   - the same call wrapped over several lines
 *   - `implementation(project(":anything-else"))` where THAT module exports
 *     the kernel, so `:app` gets it transitively and no file under
 *     `apps/android/app` names it at all
 *
 * A text gate cannot close that set, because the set is open: it is defined by
 * what Gradle RESOLVES, not by what one file spells. So this gate reads the
 * output of `./gradlew :app:dependencies`, where every one of those spellings
 * collapses to the same four words — `project :offline-kernel` — at whatever
 * depth the graph puts it.
 *
 * WHAT THIS FILE IS AND IS NOT. It is a parser and a verdict over a report
 * that Gradle produced; it does not run Gradle. Running Gradle needs a JDK and
 * the Android SDK, which this development host does not have (`ci.yml` bootstraps
 * both in the `android` job). So the shape of the report is a claim about
 * Gradle's output, and the claim is proved in CI by PLANTED controls, one per
 * spelling, each of which must make this gate refuse (RULE-27). The unit tests
 * beside this file prove the parser; they do not prove Gradle, and they say so.
 *
 * FAIL-CLOSED. Three distinct exits, because "the probe did not work" must
 * never read as "nothing was found" (RULE-11, RULE-18, RULE-20):
 *
 *   0  PASS      — a usable report, and the gated module is not in the graph
 *                  (or the record says CLOSED, which lifts the refusal)
 *   1  REFUSED   — the gated module IS in the graph while the record is OPEN
 *   2  UNUSABLE  — the report is empty, truncated, names another project, or
 *                  lacks an expected marker. Never a pass.
 *
 * Usage:
 *   node scripts/p7-dr84-link-graph-gate.ts \
 *     --record=docs/decisions/2026-11-04-dr84-capture-digest-gate.md \
 *     --report=$RUNNER_TEMP/app-deps.txt \
 *     --expect=debugRuntimeClasspath --expect=androidx.core:core-ktx
 *
 * Run with `node` directly: this file is plain erasable TypeScript, and Node 24
 * (the version `package.json` engines pins) strips the types natively, so the
 * `android` CI job needs no `npm ci` to use it.
 */
import { readFileSync } from 'node:fs';

export type GateStatus = 'OPEN' | 'CLOSED';

/** The module the gate refuses, and the project whose graph is read. */
export const GATED_MODULE = ':offline-kernel';
export const SUBJECT_PROJECT = ':app';

/**
 * `Status: OPEN` or `Status: CLOSED`, read from the tracked decision record —
 * the same source and the same words the text gate reads, deliberately, so the
 * two gates cannot disagree about whether the door is shut.
 */
export function statusOf(recordText: string): GateStatus {
  const m = /^\*\*Status:\s*(OPEN|CLOSED)\*\*$/m.exec(recordText);
  if (m === null) throw new Error('the decision record states no machine-readable status');
  return m[1] as GateStatus;
}

export type ReportVerdict = { usable: false; reason: string } | { usable: true; configurations: number; dependencyLines: number; noDependencySections: number };

/**
 * Is this text a dependency report for the subject project, and does it carry
 * the markers the caller said it must?
 *
 * The positive controls live here rather than in the shell step, so that a
 * truncated, empty or wrong-project report is a NAMED failure of the probe and
 * not a silent zero. The one that matters most in practice is `expect`: a
 * report whose resolution failed can still contain a configuration header and
 * still contain no dependency at all, and would otherwise read as "the kernel
 * is not in the graph".
 */
export function inspectReport(reportText: string, options: { subject?: string; expect?: readonly string[] } = {}): ReportVerdict {
  const subject = options.subject ?? SUBJECT_PROJECT;
  const expect = options.expect ?? [];
  if (reportText.trim().length === 0) return { usable: false, reason: 'the report is empty' };
  if (!reportText.includes(`Project '${subject}'`)) {
    return { usable: false, reason: `the report does not name Project '${subject}'` };
  }
  const lines = reportText.split('\n');
  // A configuration section header in Gradle's report starts at column 0 and
  // reads `name - description`, e.g. `debugRuntimeClasspath - Runtime classpath`.
  const configurations = lines.filter((l) => /^[A-Za-z][A-Za-z0-9]* - \S/.test(l)).length;
  const dependencyLines = lines.filter((l) => l.includes('--- ')).length;
  const noDependencySections = lines.filter((l) => /^No dependencies$/.test(l.trim())).length;
  if (configurations === 0) {
    return { usable: false, reason: 'the report names no configuration section' };
  }
  if (dependencyLines === 0 && noDependencySections === 0) {
    return { usable: false, reason: 'the report lists neither a dependency nor "No dependencies"' };
  }
  for (const marker of expect) {
    if (!reportText.includes(marker)) {
      return { usable: false, reason: `the report does not contain the expected marker ${marker}` };
    }
  }
  return { usable: true, configurations, dependencyLines, noDependencySections };
}

/**
 * Every line of the report that puts the gated module in the graph, at any
 * depth and under any configuration.
 *
 * Gradle prints a project dependency as the four words `project :offline-kernel`,
 * with the tree drawing (`+---`, `\---`, `|    `) to its left and sometimes a
 * marker (`(*)`, `(n)`, `FAILED`) to its right. The spelling that DECLARED it
 * does not survive into this output, which is exactly the property that makes
 * this gate wider than the text one.
 *
 * The path is matched whole: `:offline-kernel-probe` is a different module and
 * must not be reported as this one.
 */
export function offendingGraphLines(reportText: string, gatedModule: string = GATED_MODULE): string[] {
  const out: string[] = [];
  const lines = reportText.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const m of line.matchAll(/project\s+(:[A-Za-z0-9_.:-]+)/g)) {
      if (m[1] === gatedModule) {
        out.push(`${index + 1}: ${line.trim()}`);
        break;
      }
    }
  }
  return out;
}

/**
 * Every DISTINCT module path the report names as a project dependency, sorted.
 *
 * This is the gate's named positive control. The first CI run of the gate
 * printed `grep -c 'project :'` = 5 on the real report and said the gated
 * module was absent, which leaves "five of WHAT" unanswered -- and an unnamed
 * number is how a probe gets believed without being read (RULE-30). The paths
 * are printed instead, so the next reader sees which modules are in `:app`'s
 * graph and does not have to take the absence on trust.
 */
export function projectPathsSeen(reportText: string): string[] {
  const seen = new Set<string>();
  for (const m of reportText.matchAll(/project\s+(:[A-Za-z0-9_.:-]+)/g)) {
    const path = m[1];
    if (path !== undefined) seen.add(path);
  }
  return [...seen].sort();
}

export type GateResult = {
  code: 0 | 1 | 2;
  status: GateStatus;
  lines: string[];
  paths: string[];
  message: string;
};

/**
 * The whole verdict as one pure function, so the same words judge the real
 * report and every planted control.
 */
export function gate(recordText: string, reportText: string, options: { subject?: string; expect?: readonly string[]; gatedModule?: string } = {}): GateResult {
  const status = statusOf(recordText);
  const verdict = inspectReport(reportText, options);
  if (!verdict.usable) {
    return { code: 2, status, lines: [], paths: [], message: `UNUSABLE REPORT — ${verdict.reason}` };
  }
  const lines = offendingGraphLines(reportText, options.gatedModule ?? GATED_MODULE);
  const paths = projectPathsSeen(reportText);
  const read = `${verdict.configurations} configuration(s), ${verdict.dependencyLines} dependency line(s), project dependencies seen: ${paths.length === 0 ? 'none' : paths.join(' ')}`;
  if (status === 'CLOSED') {
    return {
      code: 0,
      status,
      lines,
      paths,
      message: `LIFTED — the record says CLOSED; the graph (${read}) is not judged. ${lines.length} line(s) name the module.`,
    };
  }
  if (lines.length > 0) {
    return {
      code: 1,
      status,
      lines,
      paths,
      message: `REFUSED — ${lines.length} line(s) put ${options.gatedModule ?? GATED_MODULE} in the resolved graph while the record is OPEN (${read}).`,
    };
  }
  return { code: 0, status, lines, paths, message: `PASS — read ${read}; the module is absent from the graph.` };
}

function valuesOf(argv: readonly string[], name: string): string[] {
  return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
}

export function main(argv: readonly string[]): number {
  const known = ['record', 'report', 'expect', 'subject', 'module'];
  const unknown = argv.filter((a) => !known.some((k) => a.startsWith(`--${k}=`)));
  if (unknown.length > 0) {
    console.error(`DR84-LINK-GRAPH: UNUSABLE — unknown option(s) ${unknown.join(' ')}`);
    return 2;
  }
  const records = valuesOf(argv, 'record');
  const reports = valuesOf(argv, 'report');
  const expect = valuesOf(argv, 'expect');
  const subject = valuesOf(argv, 'subject')[0] ?? SUBJECT_PROJECT;
  const gatedModule = valuesOf(argv, 'module')[0] ?? GATED_MODULE;
  const recordPath = records[0];
  if (records.length !== 1 || recordPath === undefined) {
    console.error('DR84-LINK-GRAPH: UNUSABLE — exactly one --record= is required');
    return 2;
  }
  if (reports.length === 0) {
    console.error('DR84-LINK-GRAPH: UNUSABLE — no --report= named. An unread graph is not a passing graph.');
    return 2;
  }
  let recordText: string;
  try {
    recordText = readFileSync(recordPath, 'utf8');
  } catch (e) {
    console.error(`DR84-LINK-GRAPH: UNUSABLE — cannot read the record: ${(e as Error).message}`);
    return 2;
  }
  let worst: 0 | 1 | 2 = 0;
  for (const path of reports) {
    let reportText: string;
    try {
      reportText = readFileSync(path, 'utf8');
    } catch (e) {
      console.error(`DR84-LINK-GRAPH: UNUSABLE — cannot read ${path}: ${(e as Error).message}`);
      worst = 2;
      continue;
    }
    const r = gate(recordText, reportText, { subject, expect, gatedModule });
    const head = r.code === 0 ? 'PASS' : r.code === 1 ? 'REFUSED' : 'UNUSABLE';
    console.log(`DR84-LINK-GRAPH [${head}] record=${recordPath} status=${r.status} report=${path}`);
    console.log(`  ${r.message}`);
    for (const l of r.lines) console.log(`  graph: ${l}`);
    if (r.code > worst) worst = r.code;
  }
  console.log(
    worst === 0
      ? `DR84-LINK-GRAPH: PASS (${reports.length} report(s), module ${gatedModule} absent)`
      : worst === 1
        ? `DR84-LINK-GRAPH: FAIL (${gatedModule} is in the resolved graph)`
        : 'DR84-LINK-GRAPH: FAIL (at least one report was unusable — this is not a pass)',
  );
  return worst;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (/p7-dr84-link-graph-gate\.ts$/.test(entry)) process.exit(main(process.argv.slice(2)));
