import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GATED_MODULE, gate, inspectReport, main, offendingGraphLines, projectPathsSeen, statusOf } from '../scripts/p7-dr84-link-graph-gate';

/**
 * The parser half of DR-84's strengthened link gate.
 *
 * WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT. They prove that the gate reads
 * a Gradle dependency report the way the gate claims to: that it finds
 * `project :offline-kernel` at any depth and under any configuration, that it
 * does not confuse a differently-named module for it, and that an empty,
 * truncated or wrong-project report comes back UNUSABLE rather than PASS.
 *
 * They do NOT prove that Gradle emits these exact bytes for each declaration
 * spelling — `project(path = ...)`, `projects.offlineKernel`, the multi-line
 * call, or a transitive export through another module. That claim needs Gradle,
 * a JDK and the Android SDK, none of which exist on the host these tests run
 * on, so here it is `NOT_RUN`. It is measured in CI instead, by the planted
 * controls in the `android` job, one per spelling, each of which must drive
 * this same gate to exit 1 (RULE-27). The reports below are written in the
 * SHAPE of that output and are labelled as synthetic for exactly that reason.
 */

const OPEN = '**Status: OPEN**\n';
const CLOSED = '**Status: CLOSED**\n';

/** A synthetic report in the shape of `./gradlew :app:dependencies`. */
function report(body: string): string {
  return [
    '',
    '------------------------------------------------------------',
    "Project ':app'",
    '------------------------------------------------------------',
    '',
    "debugRuntimeClasspath - Runtime classpath of compilation 'debug' (target  (androidJvm)).",
    '+--- androidx.core:core-ktx:1.15.0',
    body,
    '',
    'BUILD SUCCESSFUL',
    '',
  ].join('\n');
}

const EXPECTED = ['debugRuntimeClasspath', 'androidx.core:core-ktx'] as const;

describe('DR-84 link graph gate: the module in the graph, however it got there', () => {
  it('a direct project dependency is refused while the record is OPEN', () => {
    const r = gate(OPEN, report('+--- project :offline-kernel'), { expect: EXPECTED });
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(':offline-kernel');
    expect(r.message).toContain('REFUSED');
  });

  it('a TRANSITIVE dependency through another module is refused too — the case no build-file text gate can see', () => {
    const body = ['+--- project :probe', '|    \\--- project :offline-kernel', '|         \\--- junit:junit:4.13.2'].join('\n');
    const r = gate(OPEN, report(body), { expect: EXPECTED });
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    // Nothing under apps/android/app would have named the kernel in this case:
    // the offending words exist only in Gradle's resolved output.
    expect(r.lines[0]).toContain('project :offline-kernel');
  });

  it('the repeated-subtree marker and the failure marker are still the module', () => {
    expect(offendingGraphLines(report('|    +--- project :offline-kernel (*)'))).toHaveLength(1);
    expect(offendingGraphLines(report('\\--- project :offline-kernel FAILED'))).toHaveLength(1);
  });

  it('every configuration is read, not only the first', () => {
    const body = ['', "releaseRuntimeClasspath - Runtime classpath of compilation 'release' (target  (androidJvm)).", '+--- project :offline-kernel'].join(
      '\n',
    );
    expect(offendingGraphLines(report(body))).toHaveLength(1);
  });

  it('a module with a longer name that merely starts the same is NOT this module', () => {
    const r = gate(OPEN, report('+--- project :offline-kernel-probe'), { expect: EXPECTED });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it('a graph without the module passes, and says what it read', () => {
    const r = gate(OPEN, report('+--- com.squareup.okhttp3:okhttp:4.12.0'), { expect: EXPECTED });
    expect(r.code).toBe(0);
    expect(r.message).toContain('PASS');
    expect(r.message).toMatch(/\d+ configuration\(s\)/);
  });

  it('the record, not this file, lifts the gate', () => {
    const r = gate(CLOSED, report('+--- project :offline-kernel'), { expect: EXPECTED });
    expect(r.code).toBe(0);
    expect(r.status).toBe('CLOSED');
    // The module is still NAMED in the result: lifting the refusal is not the
    // same as forgetting what the graph said.
    expect(r.lines).toHaveLength(1);
  });

  it('a record with no machine-readable status is an error, not a quiet pass', () => {
    expect(() => statusOf('# a note with no status line\n')).toThrow(/machine-readable status/);
    expect(() => gate('# nothing\n', report('+--- project :offline-kernel'))).toThrow(/machine-readable status/);
  });
});

describe('DR-84 link graph gate: a probe that did not work is never a pass', () => {
  it('an empty report is UNUSABLE', () => {
    const r = gate(OPEN, '   \n\n', { expect: EXPECTED });
    expect(r.code).toBe(2);
    expect(r.message).toContain('empty');
  });

  it('a report for another project is UNUSABLE', () => {
    const other = report('+--- project :offline-kernel').replace("Project ':app'", "Project ':offline-kernel'");
    const r = gate(OPEN, other, { expect: EXPECTED });
    expect(r.code).toBe(2);
    expect(r.message).toContain("Project ':app'");
  });

  it('a report truncated after the project header is UNUSABLE', () => {
    const head = ["Project ':app'", '------------------------------------------------------------', ''].join('\n');
    const r = gate(OPEN, head, { expect: EXPECTED });
    expect(r.code).toBe(2);
    expect(r.message).toContain('configuration');
  });

  it('a configuration section with neither a dependency nor "No dependencies" is UNUSABLE', () => {
    const text = ["Project ':app'", '', 'debugRuntimeClasspath - Runtime classpath.', ''].join('\n');
    expect(inspectReport(text)).toEqual({
      usable: false,
      reason: 'the report lists neither a dependency nor "No dependencies"',
    });
  });

  it('an honestly empty configuration is usable', () => {
    const text = ["Project ':app'", '', 'debugRuntimeClasspath - Runtime classpath.', 'No dependencies', ''].join('\n');
    const v = inspectReport(text);
    expect(v.usable).toBe(true);
    expect(gate(OPEN, text).code).toBe(0);
  });

  it('a missing expected marker is UNUSABLE, which is how a half-resolved report is caught', () => {
    const r = gate(OPEN, report('+--- com.squareup.okhttp3:okhttp:4.12.0'), {
      expect: ['androidx.compose.material3:material3'],
    });
    expect(r.code).toBe(2);
    expect(r.message).toContain('expected marker');
  });
});

describe('DR-84 link graph gate: the command-line contract CI depends on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr84-link-'));
  const write = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };
  const recordOpen = write('record-open.md', OPEN);
  const clean = write('clean.txt', report('+--- com.squareup.okhttp3:okhttp:4.12.0'));
  const dirty = write('dirty.txt', report('+--- project :offline-kernel'));

  it('exit 0 on a clean graph', () => {
    expect(main([`--record=${recordOpen}`, `--report=${clean}`, '--expect=debugRuntimeClasspath'])).toBe(0);
  });

  it('exit 1 on a graph that carries the module', () => {
    expect(main([`--record=${recordOpen}`, `--report=${dirty}`])).toBe(1);
  });

  it('exit 1 if ANY of several reports carries it', () => {
    expect(main([`--record=${recordOpen}`, `--report=${clean}`, `--report=${dirty}`])).toBe(1);
  });

  it('exit 2 when no report is named — an unread graph is not a passing graph', () => {
    expect(main([`--record=${recordOpen}`])).toBe(2);
  });

  it('exit 2 when a named report does not exist', () => {
    expect(main([`--record=${recordOpen}`, `--report=${join(dir, 'absent.txt')}`])).toBe(2);
  });

  it('exit 2 on an unknown option, rather than ignoring it', () => {
    expect(main([`--record=${recordOpen}`, `--report=${clean}`, '--allow-offline-kernel'])).toBe(2);
  });

  it('the verdict NAMES the project dependencies it saw, so the absence is readable', () => {
    const body = ['+--- project :relay', '|    \\--- project :offline-kernel', '+--- project :relay (*)'].join('\n');
    expect(projectPathsSeen(report(body))).toEqual([':offline-kernel', ':relay']);
    expect(gate(OPEN, report('+--- project :relay')).message).toContain('project dependencies seen: :relay');
    expect(gate(OPEN, report('+--- junit:junit:4.13.2')).message).toContain('project dependencies seen: none');
  });

  it('the gated module is the one DR-84 is about', () => {
    expect(GATED_MODULE).toBe(':offline-kernel');
  });
});
