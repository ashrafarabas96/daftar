import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DR-84's gate: the app may not depend on the offline kernel while the capture
 * door is still open.
 *
 * `Operation.capture` accepts any non-empty string as a digest (`Queue.kt:358`)
 * and an `Operation` holds no bytes, so it cannot verify one. The store's two
 * doors do verify — that is DR-84 — and today nothing reaches `capture` except
 * tests: measured, eighteen call sites, all under `src/test`, with no
 * production caller and no file wiring the store to the state machine.
 *
 * The day `apps/android/app` depends on `:offline-kernel` is the day that stops
 * being true, and it is the day the wiring must pass the store's verified
 * digest in. So that dependency is refused here until the decision record says
 * the door is shut. Closing it re-pins the 27/27 promotion digests and touches
 * five pinned suites, which is an owner decision and not a build-file edit.
 *
 * The status is read from the tracked decision record rather than from this
 * file, so lifting the gate is a decision taken in the open — and rather than
 * from the card in `.local-context`, which is excluded from git and which CI
 * therefore cannot see.
 */

const ROOT = join(__dirname, '..');
const RECORD = join(ROOT, 'docs', 'decisions', '2026-11-04-dr84-capture-digest-gate.md');
const APP_BUILD = join(ROOT, 'apps', 'android', 'app', 'build.gradle.kts');

/** `Status: OPEN` or `Status: CLOSED`, read from the record's own text. */
function statusOf(recordText: string): 'OPEN' | 'CLOSED' {
  const m = /^\*\*Status:\s*(OPEN|CLOSED)\*\*$/m.exec(recordText);
  if (m === null) throw new Error('the decision record states no machine-readable status');
  return m[1] as 'OPEN' | 'CLOSED';
}

/**
 * The gate itself, as one function over text, so the same words judge the real
 * build file and the synthetic controls. Returns the offending lines.
 */
function offendingLines(recordText: string, buildText: string): string[] {
  if (statusOf(recordText) === 'CLOSED') return [];
  return buildText
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => !line.trimStart().startsWith('//'))
    .filter(([, line]) => /project\s*\(\s*["']:offline-kernel["']\s*\)/.test(line))
    .map(([n, line]) => `${n}: ${line.trim()}`);
}

describe('DR-84: the gate can refuse, and can be lifted only by the record', () => {
  const OPEN = '**Status: OPEN**\n';
  const CLOSED = '**Status: CLOSED**\n';
  const WITH_DEP = 'dependencies {\n    implementation(project(":offline-kernel"))\n}\n';
  const WITHOUT = 'dependencies {\n    implementation("androidx.core:core-ktx:1.13.1")\n}\n';

  it('a build file that declares the dependency is refused while the record is OPEN', () => {
    const offenders = offendingLines(OPEN, WITH_DEP);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain(':offline-kernel');
  });

  it('the single-quoted and loosely spaced spellings are refused too', () => {
    expect(offendingLines(OPEN, "    implementation(project( ':offline-kernel' ))\n")).toHaveLength(1);
  });

  it('a commented-out dependency is not an offence', () => {
    expect(offendingLines(OPEN, '    // implementation(project(":offline-kernel"))\n')).toEqual([]);
  });

  it('a build file without it passes', () => {
    expect(offendingLines(OPEN, WITHOUT)).toEqual([]);
  });

  it('the same dependency passes once the record says CLOSED', () => {
    expect(offendingLines(CLOSED, WITH_DEP)).toEqual([]);
  });

  it('a record with no machine-readable status is an error, not a quiet pass', () => {
    expect(() => offendingLines('# a note with no status line\n', WITH_DEP)).toThrow(/machine-readable status/);
  });
});

describe('DR-84: the gate as it stands on this tree', () => {
  const record = () => readFileSync(RECORD, 'utf8');
  const build = () => readFileSync(APP_BUILD, 'utf8');

  /**
   * The positive control for the subjects themselves: a gate that reads an
   * empty file, or the wrong file, is a gate that passes for the wrong reason
   * (RULE-11, RULE-18).
   */
  it('both subjects are the files this gate is about', () => {
    expect(record()).toContain('DR-84');
    expect(build()).toMatch(/id\("com\.android\.application"\)/);
    expect(build().length).toBeGreaterThan(200);
  });

  it('the record still says OPEN, so the gate is live', () => {
    expect(statusOf(record())).toBe('OPEN');
  });

  it('the app does not depend on the offline kernel', () => {
    expect(offendingLines(record(), build())).toEqual([]);
  });
});
