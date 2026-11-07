import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

const EVIDENCE_SCRIPTS = ['scripts/phase2-s9-evidence.ts', 'scripts/phase3-s9-evidence.ts'] as const;

/**
 * T-11 — the release-evidence scripts must name their archive with a path API
 * that survives a Windows separator.
 *
 * The defect: `ARCHIVE` is built with `join()` (and in the Phase 3 script
 * `resolve(join())`), so its separator is `\` on Windows. The scripts then
 * took its basename with `ARCHIVE.split('/').pop()`, which finds no `/` there
 * and returns THE WHOLE ABSOLUTE PATH. That value is written into the release
 * evidence artefact as `archive.name`, so a signed statement about a release
 * said something different depending on which operating system produced it.
 * `phase2-s9-evidence.ts` had the same class of bug in its message path,
 * stripping the repository root with `ARCHIVE.replace(`${ROOT}/`, '')`.
 *
 * Two kinds of assertion below, and the split is deliberate.
 *
 *   The BEHAVIOURAL cases build their inputs with `join`/`resolve`, the same
 *   way the scripts do, and assert on `basename`/`relative`. Written that way
 *   they state one truth on every platform. Hard-coding `'C:\\r\\a.zip'`
 *   instead would have been worse than useless: `basename` is bound to the
 *   platform it runs on, so on Linux it answers with the whole string, and the
 *   case would pass here on Windows and fail the moment this lane reaches CI.
 *
 *   The ONE Windows-only case is marked as such with `runIf`, because it is
 *   the bug itself: on a `\`-separated path the retired expression cannot
 *   produce the right answer. It is skipped on POSIX rather than weakened,
 *   since on POSIX the retired expression was in fact correct — which is
 *   exactly why CI on Linux could never have caught this.
 *
 *   The STATIC cases read the two sources. A correct API used nowhere fixes
 *   nothing, and the behavioural cases above would stay green through a full
 *   revert of the call sites, so these fail if the fragile pattern returns.
 */
describe('T-11 release-evidence path portability', () => {
  describe('the platform path API answers correctly for paths the scripts build', () => {
    const archive = join(ROOT, 'release', 'DAFTAR_PHASE_2_RC.zip');
    const resolvedArchive = resolve(join(ROOT, 'release', 'DAFTAR_PHASE_3_RC.zip'));

    it('basename names the file, not the path', () => {
      expect(basename(archive)).toBe('DAFTAR_PHASE_2_RC.zip');
      expect(basename(resolvedArchive)).toBe('DAFTAR_PHASE_3_RC.zip');
    });

    it('relative names the file against the repository root, with forward slashes', () => {
      expect(relative(ROOT, archive).split(sep).join('/')).toBe('release/DAFTAR_PHASE_2_RC.zip');
    });

    it('relative does not strip a sibling whose name merely starts with the root', () => {
      const sibling = `${ROOT}-backup`;
      expect(relative(ROOT, join(sibling, 'rc.zip')).startsWith('..')).toBe(true);
    });

    it.runIf(sep === '\\')("the retired expression split('/').pop() cannot answer on a Windows path — the defect itself", () => {
      expect(archive.split('/').pop()).not.toBe('DAFTAR_PHASE_2_RC.zip');
      expect(archive.split('/').pop()).toBe(archive);
      expect(archive.replace(`${ROOT}/`, '')).toBe(archive);
    });
  });

  describe('the evidence scripts use the platform path API', () => {
    for (const file of EVIDENCE_SCRIPTS) {
      it(`${file} imports basename from node:path`, () => {
        expect(read(file)).toMatch(/import \{[^}]*\bbasename\b[^}]*\} from 'node:path'/);
      });

      it(`${file} never takes a basename with split('/')`, () => {
        const offenders = read(file)
          .split('\n')
          .map((line, i) => [i + 1, line] as const)
          .filter(([, line]) => /\.split\(['"]\/['"]\)\s*\.pop\(\)/.test(line))
          .map(([n, line]) => `${n}: ${line.trim()}`);
        expect(offenders).toEqual([]);
      });

      it(`${file} does not strip the repository root by string replace`, () => {
        const offenders = read(file)
          .split('\n')
          .map((line, i) => [i + 1, line] as const)
          .filter(([, line]) => /\.replace\(\s*`\$\{ROOT\}\//.test(line))
          .map(([n, line]) => `${n}: ${line.trim()}`);
        expect(offenders).toEqual([]);
      });
    }

    it("leaves phase3-review-index.ts alone — its split('/') is an HTTP route, not a file path", () => {
      expect(read('scripts/phase3-review-index.ts')).toMatch(/\.split\('\/'\)/);
    });
  });
});
