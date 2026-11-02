import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-01 — the offline kernel is PROMOTED, not rewritten, and CI reaches it.
 *
 * This suite runs in the unit lane (`npm run test:unit`, composed into
 * `npm test`, which `ci.yml` runs), so it needs no database, no JDK and no
 * Android SDK. That matters: on the host this card was executed on there is no
 * `java`, no `gradle` and no `kotlinc`, so NOTHING Kotlin could be compiled or
 * run, and the red-proof harness could not be run either (its self-test passes
 * file descriptors to a child, and `pass_fds` is POSIX-only — measured, as an
 * AssertionError from Python 3.13 on this host). A promotion claim resting on
 * an unrun build is not a measurement. What CAN be measured anywhere is what
 * the card actually asks for: that the bytes did not change, that the module is
 * wired where CI's existing command already looks, and that the harness's own
 * numbers are read FROM THE HARNESS.
 *
 * The source of truth is `prep/phase7/` at commit
 * `9ae37881cf874f24371def3f0e0bad9f61bde0bc`. That path is NOT on `main`; the
 * twenty-seven files were read with `git cat-file blob` — the committed blob,
 * never the working copy, because this worktree is LF and the host is Windows —
 * and hashed. Those hashes are frozen below. Re-derive any of them with:
 *
 *   git cat-file blob 9ae37881:prep/phase7/<path> | sha256sum
 */

const ROOT = join(__dirname, '..');
const MODULE = join(ROOT, 'apps', 'android', 'offline-kernel');

/**
 * Promoted path (relative to the module) -> sha256 of the committed blob at
 * 9ae37881. Every file is byte-identical: all twenty-one Kotlin files already
 * declared `package app.daftar.offline`, so the promotion needed no package
 * rewrite at all and each hash is the UNMODIFIED blob's. There is deliberately
 * no "hash after stripping the package line" escape hatch, because no package
 * line moved.
 */
const PROMOTED: ReadonlyArray<readonly [string, string]> = [
  ['.gitignore', '32dae3052f331ee34d628ef535709b301259a45df7c7522c4d35dcf49873f00b'],
  ['README.md', '904ef3cbac60dc2826948b2fcc18ce1485f786ea2ba550538ba8a0ca110ead60'],
  ['src/main/java/app/daftar/offline/Backoff.kt', '321ccf0492fd68bb77c9ad6009d841f1c3f1438e49a067fb03ef8624ab9e1cc9'],
  ['src/main/java/app/daftar/offline/CommandEffects.kt', '7aa9ab67a5673e60052b1697c1d9873d5a2410e801193f834662602e337c4445'],
  ['src/main/java/app/daftar/offline/Conflict.kt', '9b391730d3eb2efd2159638ccf4b6099841da4e0b43be79c8a4d5a39fdefb159'],
  ['src/main/java/app/daftar/offline/Laws.kt', '73a7d4ddcc41d46d58cbef55228219de49184095cf2d8cc34f2cba8fb28944ad'],
  ['src/main/java/app/daftar/offline/Model.kt', '7f0d729bf3ab29adc753e39f5e60bde9896b5b000978a197c9692d4786bf3a1f'],
  ['src/main/java/app/daftar/offline/Outcome.kt', 'da894072be85790af49c1adb2968fa7cb1045a111f30372beb763a89a19e7bd0'],
  ['src/main/java/app/daftar/offline/Queue.kt', '9a03f280b2cdb6446f499bc8508d6b520cb6e82a15b4b8a19f493d35584b6ecc'],
  ['src/main/java/app/daftar/offline/Reconciliation.kt', '249103c864bd3f6416c8338e7e592e170e3c7d3811337fd642cf9608b1f24e50'],
  ['src/main/java/app/daftar/offline/Recovery.kt', 'd1d35b42bcc55a32640a93cb54b567b76a7cfe3b6cd2a0ea70af7e3594544a9f'],
  ['src/main/java/app/daftar/offline/Scope.kt', '20ec7f8209af70aec8e91b1821e698703280c2ed063db1ae72f72902155fff4e'],
  ['src/test/java/app/daftar/offline/BackoffTest.kt', 'f6420927e654c692275dccc275c373806ceddd42fa0808ae2c8bc710f9a809a6'],
  ['src/test/java/app/daftar/offline/CommandEffectsTest.kt', 'd2f7a0eefe56536b416b8f2f884f60f16c8a55ca0ac8a8a1c0d9651bd16a3032'],
  ['src/test/java/app/daftar/offline/ConflictTest.kt', '9c3879119d418170bd91a2dd8747bf4535652e661601ec3a2ee56f588b65c554'],
  ['src/test/java/app/daftar/offline/CrashSafetyTest.kt', '9230661d99e9d76fc3c6841bd9a9e6912812dbcffbaf520d90045e9d9492db1f'],
  ['src/test/java/app/daftar/offline/LawsTest.kt', '8cf21853cb9e3c7f0fe9623363710cbc19498124e51753dae48b730422ff6e86'],
  ['src/test/java/app/daftar/offline/OutcomeExhaustiveTest.kt', '62c927ce5c2018e70a9bca3d1bb80c20aa5670e42dea2c643a70d7a6243d50ea'],
  ['src/test/java/app/daftar/offline/QueueModelCheckTest.kt', '6439ec2de4e5eb514408884b1ed872afa0303164e85483a10e5eda9cd8332a63'],
  ['src/test/java/app/daftar/offline/RecoveryTest.kt', 'ac53827061300841c69a52e856cf49cccfa79fd0f98525d8b0f191adbeabd08c'],
  ['src/test/java/app/daftar/offline/ReentryAndRetentionTest.kt', 'b8537667e3e7f0cbf9188c3f4daeae3183553be263209b632da748c99b845b38'],
  ['src/test/java/app/daftar/offline/ScopeAndSchemaTest.kt', '11ed031382fac4ca52d1069ce5d79639813c92ad63338486fef9144da1f78e09'],
  ['src/test/java/app/daftar/offline/WaitIsHonest.kt', '0b3f86119b4281efbe2d1e5579e9daae4745ef3ee1dacba251f2746dd3ce7f01'],
  ['tools/red-proofs.sh', '5b2ac2b177e3bada3a7d496787e7ebf38335585583bce4f21d91b69835559bc9'],
  ['tools/red_proofs.py', '654521c108b483e776659d348ca3855c3206f2c24007669eb06ee2dc55b3f090'],
  ['tools/run-tests.sh', 'dd79f4fae41ace54f2d2c2e1db817680471d78e973061856b76a2d355b68737a'],
  ['tools/toolchain.sh', 'f002692bd5318346d2de28182deb654db6b25874f007849da0dcd8f6026423fc'],
];

/** Hash BYTES. Reading as text would normalise newlines and hide a change. */
function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('P7-01: the promotion is a move, not a rewrite', () => {
  it('promotes exactly twenty-seven files, the count measured at 9ae37881', () => {
    expect(PROMOTED).toHaveLength(27);
  });

  it('every promoted file is present and byte-identical to its committed blob', () => {
    const missing: string[] = [];
    const changed: string[] = [];
    for (const [rel, expected] of PROMOTED) {
      const abs = join(MODULE, rel);
      if (!existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      const actual = sha256Of(abs);
      if (actual !== expected) changed.push(`${rel}: ${actual} != ${expected}`);
    }
    expect({ missing, changed }).toEqual({ missing: [], changed: [] });
  });

  it('the hashing probe can tell a changed byte from an unchanged one', () => {
    // An absence claim needs a probe proven able to find the thing. Hash the
    // same bytes with one byte appended: the digest must move.
    const subject = PROMOTED.find(([rel]) => rel.endsWith('/Laws.kt'));
    if (subject === undefined) throw new Error('Laws.kt is not in the promoted set');
    const [rel, expected] = subject;
    const bytes = readFileSync(join(MODULE, rel));
    const tampered = createHash('sha256')
      .update(Buffer.concat([bytes, Buffer.from('x')]))
      .digest('hex');
    expect(tampered).not.toBe(expected);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
  });
});

describe('P7-01: the CI command already in place reaches the module', () => {
  const settings = () => readFileSync(join(ROOT, 'apps', 'android', 'settings.gradle.kts'), 'utf8');
  const moduleBuild = () => readFileSync(join(MODULE, 'build.gradle.kts'), 'utf8');
  const ci = () => readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the Gradle build includes the module', () => {
    expect(settings()).toMatch(/^include\(":offline-kernel"\)$/m);
  });

  /**
   * The whole reason the module is an ANDROID LIBRARY rather than a plain
   * `kotlin("jvm")` one. `ci.yml` runs, in `apps/android`:
   *
   *     ./gradlew lint testDebugUnitTest assembleDebug --no-daemon --stacktrace
   *
   * Those task names carry no project path, so Gradle runs them in every
   * subproject that HAS them — and a subproject lacking one is not an error, as
   * long as some project has it. A `kotlin("jvm")` module's unit tests hang off
   * `test`, which that command never names: its tests would simply never run,
   * and the run would still be green. A silent non-run is the worst of the three
   * outcomes, so the module takes the plugin whose variant task names the
   * command already says.
   *
   * `.github/**` is outside this lane's ownership and was NOT touched. This
   * asserts the command exactly as it already stands.
   */
  it('runs the unqualified variant tasks the Android library plugin provides', () => {
    expect(ci()).toContain('./gradlew lint testDebugUnitTest assembleDebug --no-daemon --stacktrace');
    expect(moduleBuild()).toMatch(/id\("com\.android\.library"\)/);
  });

  it('the task-scoping probe would notice a project-scoped task', () => {
    const scoped = /(^|\s):[A-Za-z0-9_-]+:(lint|testDebugUnitTest|assembleDebug)\b/;
    // Proven able to find a scoped task when one is there...
    expect(scoped.test('./gradlew :app:testDebugUnitTest')).toBe(true);
    // ...and the real command has none, so the tasks apply to every subproject.
    const command = ci()
      .split('\n')
      .filter((line) => line.includes('./gradlew'))
      .join('\n');
    expect(command).not.toBe('');
    expect(scoped.test(command)).toBe(false);
  });
});

describe('P7-01: N is read from the harness, never copied from a report', () => {
  const harness = () => readFileSync(join(MODULE, 'tools', 'red_proofs.py'), 'utf8');
  const laws = () => readFileSync(join(MODULE, 'src', 'main', 'java', 'app', 'daftar', 'offline', 'Laws.kt'), 'utf8');

  /**
   * The harness's own verdict sentence, quoted from its source:
   *
   *   ALL {len(PROOFS)} RED PROOFS SATISFIED over a {baseline_cases}-case green
   *   baseline, with {guards_armed} of {guards_armed} guard branches armed.
   *
   * So it reports TWO totals, and neither of them is 20. A previous card in
   * this programme was rejected for pinning a number taken from a different
   * file, so every figure below is derived from this file's own text.
   */
  it('declares 105 proofs, counted from its own PROOFS table', () => {
    const entries = harness()
      .split('\n')
      .filter((line) => /^ {4}Proof\(/.test(line));
    expect(entries).toHaveLength(105);
  });

  it('pins its guard-branch census as a literal, and that literal is 102', () => {
    const m = /^GUARD_BRANCHES_THIS_HARNESS_DECLARES = (\d+)$/m.exec(harness());
    if (m === null) throw new Error('the harness declares no guard-branch census literal');
    expect(Number(m[1])).toBe(102);
  });

  /**
   * A MEASURED LIMIT, stated rather than smoothed over. The static count of
   * `expect(` arm sites inside `self_test()` is 100, not 102: two arms are
   * raised inside loops, so only a RUN produces the declared figure. That is
   * precisely why the harness pins 102 as a literal and refuses by name
   * (`REFUSED-P7-GUARD-BRANCH-CENSUS`) when the runtime length differs in
   * either direction. This test pins the static floor and says that it is a
   * floor, not the verdict.
   */
  it('has one hundred arm sites statically, the remaining two being loop-raised', () => {
    const source = harness();
    const start = source.indexOf('def self_test() -> int:');
    const end = source.indexOf('_SAMPLE_SOURCE = """');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const sites = source
      .slice(start, end)
      .split('\n')
      .filter((line) => /^ *expect\(/.test(line));
    expect(sites).toHaveLength(100);
  });

  it('declares twenty kernel laws, and Laws.kt carries exactly those twenty', () => {
    const m = /^LAWS_THE_KERNEL_DECLARES = (\d+)$/m.exec(harness());
    if (m === null) throw new Error('the harness declares no kernel-law count literal');
    expect(Number(m[1])).toBe(20);
    // Equality, not containment: a law added to Laws.kt that no proof carries,
    // and a law the harness expects that Laws.kt has lost, are both differences.
    const found = [...new Set(laws().match(/P7-L\d+\b/g) ?? [])].sort();
    const expected = Array.from({ length: 20 }, (_, i) => `P7-L${i + 1}`).sort();
    expect(found).toEqual(expected);
  });

  /**
   * The card's phrase "N of N caught by name" is NOT this harness's wording:
   * the literal does not occur in it even once. It belongs to
   * `scripts/phase4-gate.ts`. Recorded here so the next reader does not go
   * hunting for a sentence this file never prints.
   */
  it('never uses the phrase "caught by name", on a probe proven to find it', () => {
    const probe = (s: string) => s.includes('caught by name');
    expect(probe('nine of nine caught by name')).toBe(true);
    expect(probe(harness())).toBe(false);
    expect(harness()).toContain('RED PROOFS SATISFIED over a');
    expect(harness()).toContain('guard branches armed.');
  });
});

describe('P7-01: the test roster survived the move intact', () => {
  /**
   * Ninety-nine cases across TEN suites, frozen BY NAME and by count. A roster
   * pinned only by its total is satisfied by deleting one suite and adding
   * another; this one is not. `WaitIsHonest.kt` sits in the test source set but
   * carries no `@Test` — it is a helper, and that zero is asserted rather than
   * left to read as an oversight.
   */
  const ROSTER: ReadonlyArray<readonly [string, number]> = [
    ['BackoffTest.kt', 6],
    ['CommandEffectsTest.kt', 6],
    ['ConflictTest.kt', 5],
    ['CrashSafetyTest.kt', 14],
    ['LawsTest.kt', 3],
    ['OutcomeExhaustiveTest.kt', 13],
    ['QueueModelCheckTest.kt', 3],
    ['RecoveryTest.kt', 13],
    ['ReentryAndRetentionTest.kt', 22],
    ['ScopeAndSchemaTest.kt', 14],
    ['WaitIsHonest.kt', 0],
  ];

  const read = (name: string) => readFileSync(join(MODULE, 'src', 'test', 'java', 'app', 'daftar', 'offline', name), 'utf8');

  it('carries ninety-nine @Test cases, distributed exactly as measured', () => {
    const measured = ROSTER.map(([name]) => {
      const count = (read(name).match(/@Test\b/g) ?? []).length;
      return [name, count] as const;
    });
    expect(measured).toEqual(ROSTER);
    expect(measured.reduce((total, [, count]) => total + count, 0)).toBe(99);
  });

  it('carries no skipped, focused or pending marker', () => {
    const banned = /@Ignore\b|\.skip\b|\.only\b|\.todo\b|@Disabled\b/;
    // Probe proven able to find one before the absence is read.
    expect(banned.test('@Ignore')).toBe(true);
    const offenders = ROSTER.map(([name]) => name).filter((name) => banned.test(read(name)));
    expect(offenders).toEqual([]);
  });
});
