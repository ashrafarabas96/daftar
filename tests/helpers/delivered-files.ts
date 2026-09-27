import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The files a tree claims to consist of, relative to `root`.
 *
 * In a git checkout: `git ls-files --cached --others --exclude-standard`,
 * tracked or untracked and not ignored, which is what a reviewer's checkout
 * contains. In an extracted release candidate there is no git, by design
 * (the release gate runs from the archive with no `.git`), and the archive's
 * own `DELIVERY_MANIFEST.json` inventory is the source: it is what the release
 * gate has already checked the tree against, file by file. The same rule as
 * `tests/security/phase2-s8-gate-tamper.test.ts`.
 */
export function deliveredFiles(root: string): string[] {
  const manifest = join(root, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { inventory?: { path?: string }[] };
    const paths = (parsed.inventory ?? []).map((entry) => entry.path).filter((path): path is string => typeof path === 'string' && path !== '');
    if (paths.length === 0) throw new Error('DELIVERY_MANIFEST.json is present and carries no inventory');
    return paths;
  }
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((rel) => rel !== '');
}
