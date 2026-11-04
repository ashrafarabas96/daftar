import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-01 — the suites that read the kernel as TEXT must be pointed at the
 * promoted source, and this lane can say so without a JVM.
 *
 * Five Kotlin suites defend laws a type system cannot observe: no defaulted
 * `EffectClass`, no fallback to `BENIGN`, no refusal code that no sweep can
 * see, no fenced absence inferred from a status. Each reads its root from the
 * system property `p7.src`, falling back to `prep/phase7/kotlin/src` — the path
 * the kernel lived at before P7-01 promoted it, and a path this repository does
 * not have.
 *
 * Nothing set the property, so on the first run that ever executed them (run
 * 41749455670, android job 126310932907) all nine of their cases failed, with
 * 119 tests completed and 9 failed. They failed CLOSED, which is what they were
 * written to do: an empty file list is a failure, never a quiet pass.
 *
 * The fix is one `systemProperty` in the module's build file. The point of this
 * suite is that the next person to move a file learns it here, in a lane that
 * runs on any machine, rather than three minutes into an Android job.
 */

const ROOT = join(__dirname, '..');
const MODULE = join(ROOT, 'apps', 'android', 'offline-kernel');

const buildFile = () => readFileSync(join(MODULE, 'build.gradle.kts'), 'utf8');

function kotlinFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...kotlinFiles(p));
    else if (name.endsWith('.kt')) out.push(p);
  }
  return out;
}

describe('P7-01: the source-sweeping suites are given a root that exists', () => {
  /**
   * The positive control, and it must come first: if no suite read the
   * property, everything below would pass by being vacuous.
   */
  it('five suites read the kernel text from the p7.src property', () => {
    const testDir = join(MODULE, 'src', 'test', 'java', 'app', 'daftar', 'offline');
    const readers = kotlinFiles(testDir).filter((f) => readFileSync(f, 'utf8').includes('"p7.src"'));
    const names = readers.map((f) => f.slice(f.lastIndexOf('\\') + 1).replace(/^.*\//, '')).sort();
    expect(names).toEqual(['CommandEffectsTest.kt', 'CrashSafetyTest.kt', 'QueueModelCheckTest.kt', 'RecoveryTest.kt', 'ReentryAndRetentionTest.kt']);
  });

  it('the build file passes that property to every test task', () => {
    const text = buildFile();
    expect(text).toMatch(/tasks\.withType<Test>\(\)\.configureEach\s*\{/);
    expect(text).toMatch(/systemProperty\("p7\.src",\s*file\("src\/main\/java"\)\.absolutePath\)/);
  });

  /**
   * The path is not merely spelled correctly: it holds the subject the sweeps
   * require. Each of them refuses to report on fewer than six sources, so a
   * root that exists but is nearly empty is still a blind sweep.
   */
  it('the root it names holds the kernel, not an empty directory', () => {
    const main = join(MODULE, 'src', 'main', 'java');
    expect(existsSync(main)).toBe(true);
    const sources = kotlinFiles(main);
    expect(sources.length).toBeGreaterThanOrEqual(6);

    // The files the sweeps name explicitly, so a rename cannot leave the root
    // valid and the sweep subjectless.
    const basenames = sources.map((f) => f.split(/[\\/]/).pop());
    for (const required of ['Queue.kt', 'Outcome.kt', 'Recovery.kt', 'Model.kt']) {
      expect(basenames).toContain(required);
    }
  });

  /**
   * The fallback is left in the Kotlin exactly as it was. It is not the bug —
   * an unset property is — and rewriting a pinned file to change a default
   * would break the 27/27 promotion digests that prove P7-01 moved bytes
   * rather than rewriting them. This asserts the repository really does lack
   * that path, so the fallback can never silently become the subject.
   */
  it('the pre-promotion fallback path does not exist in this repository', () => {
    expect(existsSync(join(ROOT, 'prep', 'phase7', 'kotlin', 'src'))).toBe(false);
  });
});
