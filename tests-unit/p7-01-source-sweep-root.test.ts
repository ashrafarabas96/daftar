import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-01 — the suites that read the kernel as TEXT must be pointed at the
 * promoted source, and this lane can say so without a JVM.
 *
 * Kotlin suites defend laws a type system cannot observe: no defaulted
 * `EffectClass`, no fallback to `BENIGN`, no refusal code that no sweep can
 * see, no fenced absence inferred from a status, and — added by the link cards
 * — no unstated isolation behind a frozen key and no `invpl/1` intent encoder
 * growing on the device. Each reads its root from the system property
 * `p7.src`, falling back to `prep/phase7/kotlin/src` — the path the kernel
 * lived at before P7-01 promoted it, and a path this repository does not have.
 *
 * The roster below is SEVEN, measured, not five: the promotion's five plus
 * `CaptureRaceSameKeyTest` (card P7-LINK-01) and `WireCompatOnReplayTest`
 * (card P7-LINK-03). It is listed by name on purpose — a sweep that loses its
 * subject to a rename must fail here, in a lane that needs no JVM, and a
 * roster that grew must be read and named rather than silently recounted.
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
  it('every suite that reads the kernel text reads it from the p7.src property', () => {
    // The whole of `src/test`, recursively, NOT `src/test/java` alone: the
    // Robolectric suites live at `src/test/robolectric/java` (see the module's
    // `srcDir`, and the reason it is there), and a scan rooted at `java` would
    // be blind to a sweep added beside them.
    const testDir = join(MODULE, 'src', 'test');
    const readers = kotlinFiles(testDir).filter((f) => readFileSync(f, 'utf8').includes('"p7.src"'));
    const names = readers.map((f) => f.split(/[\\/]/).pop()).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([
      'CaptureRaceSameKeyTest.kt',
      'CommandEffectsTest.kt',
      'CrashSafetyTest.kt',
      'QueueModelCheckTest.kt',
      'RecoveryTest.kt',
      'ReentryAndRetentionTest.kt',
      'WireCompatOnReplayTest.kt',
    ]);
  });

  it('the build file passes that property to every test task', () => {
    const text = buildFile();
    expect(text).toMatch(/tasks\.withType<Test>\(\)\.configureEach\s*\{/);
    expect(text).toMatch(/systemProperty\("p7\.src",\s*file\("src\/main\/java"\)\.absolutePath\)/);
  });

  /**
   * The second half of the same gap. One convention check reads its OWN
   * source, so it needs the TEST root, and it derives that from `p7.test`
   * falling back to the sibling of `p7.src` — `src/main/test` after the
   * promotion, which has never existed. It was the single remaining failure
   * when the other eight went green.
   */
  it('the test root is passed too, and holds the suite that reads its own source', () => {
    expect(buildFile()).toMatch(/systemProperty\("p7\.test",\s*file\("src\/test\/java"\)\.absolutePath\)/);

    const testRoot = join(MODULE, 'src', 'test', 'java');
    expect(existsSync(testRoot)).toBe(true);
    const names = kotlinFiles(testRoot).map((f) => f.split(/[\\/]/).pop());
    expect(names).toContain('QueueModelCheckTest.kt');

    // The fallback the Kotlin would use if the property were dropped again.
    expect(existsSync(join(MODULE, 'src', 'main', 'test'))).toBe(false);
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
