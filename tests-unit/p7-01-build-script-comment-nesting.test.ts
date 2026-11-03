import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-01 — a Gradle Kotlin script's block comments must close as many times as
 * they open.
 *
 * KOTLIN BLOCK COMMENTS NEST. Unlike Java, C and JavaScript, every `/*` inside
 * a block comment opens another level, and one `*\/` closes one level. So a
 * KDoc that mentions a glob such as a dot-github path followed by a double star
 * contains a `/` and a `*` side by side, which the lexer reads as a nested
 * opener — and the comment's own closer then only brings the depth back to one.
 * Everything after it, to the end of the file, is comment.
 *
 * That is not a style question. It is what happened to
 * `apps/android/offline-kernel/build.gradle.kts`: the `plugins {}` block ran,
 * because it sits ABOVE the comment, and `android {}` and `dependencies {}` did
 * not, because they sit below it. Measured on the runner through an init-script
 * probe registered before the Android plugin's own callback: at afterEvaluate
 * the module's `android` extension held `compileSdk=null`,
 * `compileSdkVersion=null`, `namespace=null` and `defaultConfig.minSdk=null`,
 * while `:app`, from a script with no block comment at all, held 35,
 * `android-35`, `app.daftar` and 26. The project reported no evaluation
 * failure, the build file Gradle read was the committed blob byte for byte, and
 * its text carried both the block and the assignment. The configuration then
 * failed where a missing `compileSdk` is first read:
 *
 *     > compileSdkVersion is not specified. Please add it to build.gradle
 *
 * A reader cannot see this. The file looks right, the digest matches, and the
 * error names a property the file plainly sets. So it is measured here, over
 * every Gradle Kotlin script in the Android build, rather than left to whoever
 * next writes a glob into a KDoc.
 */

const ANDROID = join(__dirname, '..', 'apps', 'android');

interface Scan {
  depth: number;
  openerLines: number[];
}

/**
 * A deliberately small subset of the Kotlin lexer: enough to count comment
 * depth without mistaking a slash-star inside a string or a line comment for an
 * opener, which is the only way this count could accuse a correct file.
 */
function scanCommentDepth(src: string): Scan {
  let depth = 0;
  let line = 1;
  const openerLines: number[] = [];
  let i = 0;
  const at = (s: string) => src.startsWith(s, i);
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (at('/*')) {
        depth += 1;
        openerLines.push(line);
        i += 2;
        continue;
      }
      if (at('*/')) {
        depth -= 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (at('//')) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (at('/*')) {
      depth = 1;
      openerLines.push(line);
      i += 2;
      continue;
    }
    if (at('"""')) {
      const end = src.indexOf('"""', i + 3);
      const body = src.slice(i, end === -1 ? src.length : end + 3);
      line += (body.match(/\n/g) ?? []).length;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i += 1;
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { depth, openerLines };
}

/**
 * Every file the Kotlin compiler reads in this build, not only the build
 * scripts. The first measurement of this defect stopped at `*.gradle.kts`,
 * which was narrower than the defect: the same glob, copied into the same
 * prose, had also commented out the tail of `SyncEnvelope.kt`, and the android
 * job named it the moment the module began to configure --
 * `Expecting a top level declaration` at the line below the KDoc, and
 * `Unresolved reference 'ENVELOPE_VERSION'` where a declaration inside the dead
 * region was used. A guard narrower than the mechanism reads as a pass.
 */
function kotlinSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'build' || name === '.gradle' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...kotlinSources(p));
    else if (name.endsWith('.kt') || name.endsWith('.kts')) out.push(p);
  }
  return out;
}

describe('P7-01: the comment-depth count can tell the two cases apart', () => {
  /**
   * The negative control comes first, and it is the real sequence rather than
   * an invented one: a KDoc whose prose carries a path glob. Without this, a
   * green run below would be indistinguishable from a count that cannot fail.
   */
  it('a KDoc carrying a path glob leaves the file commented out', () => {
    const glob = ['`.github/', '*', '*`'].join('');
    const bad = ['/**', ` * nothing under ${glob} had to change`, ' */', 'android {', '}', ''].join('\n');
    const scan = scanCommentDepth(bad);
    expect(scan.depth).toBe(1);
    expect(scan.openerLines).toEqual([1, 2]);
  });

  it('the same prose without the glob closes cleanly', () => {
    const ok = ['/**', ' * nothing under `.github` had to change', ' */', 'android {', '}', ''].join('\n');
    expect(scanCommentDepth(ok).depth).toBe(0);
  });

  it('a slash-star inside a string or a line comment is not an opener', () => {
    expect(scanCommentDepth('val p = "/*"\n// /*\nandroid { }\n').depth).toBe(0);
  });

  it('a genuinely unclosed comment is still caught', () => {
    expect(scanCommentDepth('/* open\nandroid { }\n').depth).toBe(1);
  });
});

describe('P7-01: every Kotlin file in the Android build closes its comments', () => {
  const scripts = kotlinSources(ANDROID);

  /**
   * A count over an empty list is zero failures and no measurement (RULE-11,
   * RULE-18). Three build scripts -- the root, `:app` and `:offline-kernel` --
   * plus the kernel's own sources and suites.
   */
  it('the scan found files to scan', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(30);
  });

  it.each(scripts.map((p) => [p.slice(p.indexOf('apps')), p] as const))('%s closes every comment it opens', (_label, path) => {
    const src = readFileSync(path, 'utf8');
    expect(src.length).toBeGreaterThan(0);
    const scan = scanCommentDepth(src);
    expect({ path: _label, depth: scan.depth, openerLines: scan.openerLines }).toMatchObject({
      depth: 0,
    });
  });
});
