/**
 * P15 — RC ARCHIVE SOURCE IDENTITY, VERIFIED AFTER EXTRACTION
 * ============================================================
 *
 * The Mission's requirement is two things in one sentence: the RC archive must
 * EMBED its source identity, and that identity must be TESTED ONCE EXTRACTED.
 * The embedding already exists — `scripts/export-release.ts` writes
 * DELIVERY_MANIFEST.json with `sourceCommit`, a `treeHash` and a per-file
 * inventory, and a sibling `.sha256` that is deliberately never inside the zip
 * (no circular hash). What has not existed is the second half: something that
 * takes an EXTRACTED archive and establishes, from the bytes on disk, that it
 * is the commit it says it is.
 *
 * ── Why three routes and not one ───────────────────────────────────────────
 *
 * Each route alone is defeated by a different tamper, which is the whole
 * reason there are three:
 *
 *   R1  the manifest's own treeHash, recomputed from the inventory it carries.
 *       Defeated on its own by editing a file AND its inventory entry
 *       together — the recomputation would then agree with the edit.
 *
 *   R2  every file's digest, recomputed from the extracted bytes. Defeated on
 *       its own by editing a file and its entry together, exactly as R1 is:
 *       R1 and R2 together close that, because the treeHash then disagrees.
 *
 *   R3  the independent one. `git archive <sourceCommit>` is read from a
 *       repository, and the SAME treeHash algorithm is applied to that tree.
 *       Nothing inside the archive can influence this number, so it is what
 *       makes "this is commit X" a claim about the commit rather than a claim
 *       the archive makes about itself. R1 and R2 prove internal consistency;
 *       only R3 proves identity.
 *
 * ── §79, stated before anyone reads a number out of this ───────────────────
 *
 * A run of this script against an archive built from a PREP branch proves
 * that the VERIFIER works. It proves nothing whatever about a Phase 15 release
 * candidate: §79 is that final P15 evidence must run on the FINAL EXACT SHA,
 * and a prep SHA is not it. The script prints the SHA it measured and says so
 * itself, so no reader can carry a number out of here as release evidence.
 *
 * ── The red proofs ─────────────────────────────────────────────────────────
 *
 * A verifier that has never refused anything is a verifier nobody has tested.
 * `--prove` makes four tampers, each of which must be refused by a NAMED route
 * with a NAMED reason, and then restores nothing — because it never touched
 * anything to restore. Every tamper happens on a COPY in a temporary
 * directory, never on the extracted archive and never on the repository.
 * That rule is PART 6's, and it is named after this thread's own mutation
 * harness: no red proof may mutate a tree it does not own, not even
 * temporarily.
 *
 * Usage:
 *   tsx scripts/phase15/verify-rc-identity.ts --archive=release/DAFTAR_PHASE_3_RC.zip
 *   tsx scripts/phase15/verify-rc-identity.ts --dir=<extracted>/DAFTAR
 *   tsx scripts/phase15/verify-rc-identity.ts --archive=… --prove
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface InventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
interface Manifest {
  readonly phase?: number;
  readonly sourceCommit?: string;
  readonly treeHash?: string;
  readonly treeHashAlgorithm?: string;
  readonly fileCount?: number;
  readonly inventory?: InventoryEntry[];
}

/**
 * The tree hash, exactly as export-release.ts:205 defines it:
 *   sha256 over "<relative path>:<sha256 of file bytes>" lines, sorted by
 *   path, joined with \n.
 * It is implemented here rather than imported so that a change to the
 * exporter cannot silently change what this verifier checks against. If the
 * exporter's stated algorithm ever differs from this one, R1 turns red and
 * names the difference, which is the correct outcome.
 */
function treeHashOf(entries: readonly { readonly path: string; readonly sha256: string }[]): string {
  // BYTE order, not locale collation.
  //
  // The exporter's `treeHashAlgorithm` string says "sorted by path" and names
  // no ordering. This verifier was first written with `localeCompare`, which
  // is the ordinary JavaScript reading of that phrase, and it produced a
  // DIFFERENT hash from the one the manifest states — on an archive whose
  // inventory matches the commit's tree file-for-file. The exporter does not
  // sort at all: it preserves the order `git ls-files` returns, which is byte
  // order. So the documented description admits two readings that disagree,
  // and only one of them reproduces the number.
  //
  // That matters beyond this file: a hash an independent party must reproduce
  // is only as good as the description of how to reproduce it, and a verifier
  // written from this description would reject a sound archive. The lead goes
  // to the exporter's owner — export-release.ts is not this branch's file.
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.map((e) => `${e.path}:${e.sha256}`).join('\n'));
}

type Outcome = { readonly route: string; readonly ok: boolean; readonly detail: string };

/** Every file under `dir`, relative to it, excluding the manifest itself. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.isFile()) out.push(relative(base, full));
  }
  return out;
}

/** Extract a zip into a fresh temp directory and return the tree root. */
function extract(zip: string): string {
  const into = mkdtempSync(join(tmpdir(), 'p15-rc-'));
  const r = spawnSync('unzip', ['-q', zip, '-d', into], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`unzip ${zip}: ${(r.stderr ?? '').slice(0, 300)}`);
  const tops = readdirSync(into).filter((n) => statSync(join(into, n)).isDirectory());
  // The exporter writes the tree under a single prefix directory.
  return tops.length === 1 && tops[0] !== undefined ? join(into, tops[0]) : into;
}

/** The three routes, run against an extracted tree. */
function verify(dir: string): { readonly outcomes: Outcome[]; readonly manifest: Manifest | null } {
  const outcomes: Outcome[] = [];
  const manifestPath = join(dir, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) {
    outcomes.push({
      route: 'R0 manifest',
      ok: false,
      detail: 'DELIVERY_MANIFEST.json is not in the extracted tree: the archive embeds no source identity at all',
    });
    return { outcomes, manifest: null };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (e) {
    outcomes.push({ route: 'R0 manifest', ok: false, detail: `DELIVERY_MANIFEST.json is not readable JSON: ${(e as Error).message.slice(0, 160)}` });
    return { outcomes, manifest: null };
  }
  const inv = manifest.inventory ?? [];
  const commit = manifest.sourceCommit ?? '';
  const stated = manifest.treeHash ?? '';
  if (inv.length === 0 || stated === '' || !/^[0-9a-f]{40}$/.test(commit)) {
    outcomes.push({
      route: 'R0 manifest',
      ok: false,
      detail: `the manifest does not carry a usable identity: inventory ${inv.length} entries, treeHash ${stated === '' ? 'MISSING' : 'present'}, sourceCommit ${/^[0-9a-f]{40}$/.test(commit) ? 'present' : JSON.stringify(commit)}`,
    });
    return { outcomes, manifest };
  }
  outcomes.push({
    route: 'R0 manifest',
    ok: true,
    detail: `phase ${manifest.phase ?? '?'}, commit ${commit}, ${inv.length} inventory entries, fileCount ${manifest.fileCount ?? '?'}`,
  });

  // R1 — the manifest's treeHash, recomputed from the inventory it carries.
  const fromInventory = treeHashOf(inv);
  outcomes.push(
    fromInventory === stated
      ? { route: 'R1 manifest self-consistency', ok: true, detail: `treeHash recomputed from the inventory equals the stated one (${stated})` }
      : {
          route: 'R1 manifest self-consistency',
          ok: false,
          detail: `the stated treeHash is ${stated} but the inventory it carries hashes to ${fromInventory}: the inventory and the treeHash disagree`,
        },
  );

  // R2 — every file's digest, recomputed from the extracted bytes.
  const onDisk = new Set(walk(dir).filter((p) => p !== 'DELIVERY_MANIFEST.json'));
  const mismatched: string[] = [];
  const missing: string[] = [];
  for (const e of inv) {
    const full = join(dir, e.path);
    if (!existsSync(full)) {
      missing.push(e.path);
      continue;
    }
    const buf = readFileSync(full);
    if (sha256(buf) !== e.sha256)
      mismatched.push(`${e.path} (inventory ${e.sha256.slice(0, 12)}…, on disk ${sha256(buf).slice(0, 12)}…, ${e.bytes} → ${buf.byteLength} bytes)`);
    onDisk.delete(e.path);
  }
  const extra = [...onDisk];
  const r2problems = [
    ...(missing.length > 0
      ? [`${missing.length} inventory file(s) absent from the extracted tree: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`]
      : []),
    ...(mismatched.length > 0
      ? [`${mismatched.length} file(s) whose bytes do not match their digest: ${mismatched.slice(0, 3).join('; ')}${mismatched.length > 3 ? '; …' : ''}`]
      : []),
    ...(extra.length > 0
      ? [`${extra.length} file(s) in the tree that the inventory does not list: ${extra.slice(0, 4).join(', ')}${extra.length > 4 ? ', …' : ''}`]
      : []),
  ];
  outcomes.push(
    r2problems.length === 0
      ? { route: 'R2 extracted bytes', ok: true, detail: `all ${inv.length} inventory files present, digests match, and no unlisted file is in the tree` }
      : { route: 'R2 extracted bytes', ok: false, detail: r2problems.join(' | ') },
  );

  // R3 — the independent route: the commit's own tree, read from git.
  const known = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT, encoding: 'utf8' });
  if (known.status !== 0) {
    outcomes.push({
      route: 'R3 git identity',
      ok: false,
      detail: `UNMEASURED: ${commit} is not a commit in the repository at ${ROOT}, so the identity claim cannot be checked against anything independent of the archive. Run this where that commit is reachable.`,
    });
    return { outcomes, manifest };
  }
  const listed = spawnSync('git', ['ls-tree', '-r', '--format=%(path)%x00%(objectname)%x00%(objecttype)', commit], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    outcomes.push({ route: 'R3 git identity', ok: false, detail: `UNMEASURED: git ls-tree ${commit} failed: ${(listed.stderr ?? '').slice(0, 200)}` });
    return { outcomes, manifest };
  }
  // The exporter's inventory is every TRACKED file, so the commit's blobs are
  // the comparison set. Each blob's bytes are hashed the same way.
  const fromGit: { path: string; sha256: string }[] = [];
  for (const line of (listed.stdout ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    const [path, oid, type] = line.split('\0');
    if (type !== 'blob' || path === undefined || oid === undefined) continue;
    const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd: ROOT, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    if (blob.status !== 0) {
      outcomes.push({ route: 'R3 git identity', ok: false, detail: `UNMEASURED: could not read blob ${oid} for ${path}` });
      return { outcomes, manifest };
    }
    fromGit.push({ path, sha256: sha256(blob.stdout as unknown as Buffer) });
  }
  const gitTreeHash = treeHashOf(fromGit);
  if (gitTreeHash === stated) {
    outcomes.push({
      route: 'R3 git identity',
      ok: true,
      detail: `the commit's own tree hashes to the archive's stated treeHash (${stated}), computed from ${fromGit.length} blobs read out of git — a number nothing inside the archive can influence`,
    });
  } else {
    // Say exactly HOW they differ: a count difference and a content difference
    // are different accusations.
    const byPath = new Map(fromGit.map((e) => [e.path, e.sha256]));
    const invByPath = new Map(inv.map((e) => [e.path, e.sha256]));
    const onlyInArchive = [...invByPath.keys()].filter((p) => !byPath.has(p));
    const onlyInCommit = [...byPath.keys()].filter((p) => !invByPath.has(p));
    const differing = [...invByPath.entries()].filter(([p, h]) => byPath.has(p) && byPath.get(p) !== h).map(([p]) => p);
    outcomes.push({
      route: 'R3 git identity',
      ok: false,
      detail: `the archive says it is ${commit}, but that commit's tree hashes to ${gitTreeHash} and the archive states ${stated}. ${differing.length} file(s) differ in content${differing.length > 0 ? ` (${differing.slice(0, 4).join(', ')}${differing.length > 4 ? ', …' : ''})` : ''}; ${onlyInArchive.length} only in the archive${onlyInArchive.length > 0 ? ` (${onlyInArchive.slice(0, 3).join(', ')})` : ''}; ${onlyInCommit.length} only in the commit${onlyInCommit.length > 0 ? ` (${onlyInCommit.slice(0, 3).join(', ')})` : ''}.`,
    });
  }
  return { outcomes, manifest };
}

/* ── red proofs ───────────────────────────────────────────────────────────── */

interface RedProof {
  readonly id: string;
  readonly law: string;
  readonly tamper: (dir: string) => string;
  /** Which route must refuse, and a fragment its reason must contain. */
  readonly route: string;
  readonly reason: RegExp;
}

const RED: readonly RedProof[] = [
  {
    id: 'R-RC-1',
    law: 'a file whose bytes were changed is refused',
    route: 'R2 extracted bytes',
    reason: /do not match their digest/,
    tamper: (dir) => {
      const inv = (JSON.parse(readFileSync(join(dir, 'DELIVERY_MANIFEST.json'), 'utf8')) as Manifest).inventory ?? [];
      const target = inv.find((e) => e.path.endsWith('.md') && e.bytes > 0)?.path ?? inv[0]?.path;
      if (target === undefined) throw new Error('no inventory entry to tamper with');
      writeFileSync(join(dir, target), `${readFileSync(join(dir, target), 'utf8')}\n<!-- tampered -->\n`);
      return `appended two lines to ${target}`;
    },
  },
  {
    id: 'R-RC-2',
    law: 'a file removed after export is refused',
    route: 'R2 extracted bytes',
    reason: /absent from the extracted tree/,
    tamper: (dir) => {
      const inv = (JSON.parse(readFileSync(join(dir, 'DELIVERY_MANIFEST.json'), 'utf8')) as Manifest).inventory ?? [];
      const target = inv.find((e) => e.path.endsWith('.md'))?.path ?? inv[0]?.path;
      if (target === undefined) throw new Error('no inventory entry to remove');
      unlinkSync(join(dir, target));
      return `removed ${target}`;
    },
  },
  {
    id: 'R-RC-3',
    law: 'a file edited together with its inventory entry still fails, because the treeHash then disagrees',
    route: 'R1 manifest self-consistency',
    reason: /the inventory and the treeHash disagree/,
    tamper: (dir) => {
      const p = join(dir, 'DELIVERY_MANIFEST.json');
      const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest & { inventory: InventoryEntry[] };
      const target = m.inventory.find((e) => e.path.endsWith('.md')) ?? m.inventory[0];
      if (target === undefined) throw new Error('no inventory entry to tamper with');
      const bytes = Buffer.from(`${readFileSync(join(dir, target.path), 'utf8')}\n<!-- tampered consistently -->\n`);
      writeFileSync(join(dir, target.path), bytes);
      // The tamper a single-route verifier would miss: the entry is updated to
      // match the new bytes, so R2 would pass. Only the treeHash notices.
      const updated = m.inventory.map((e) => (e.path === target.path ? { ...e, sha256: sha256(bytes), bytes: bytes.byteLength } : e));
      writeFileSync(p, JSON.stringify({ ...m, inventory: updated }, null, 2));
      return `edited ${target.path} AND its inventory entry to match`;
    },
  },
  {
    id: 'R-RC-4',
    law: 'an archive claiming a commit it is not is refused by the independent route',
    route: 'R3 git identity',
    reason: /but that commit's tree hashes to|is not a commit in the repository/,
    tamper: (dir) => {
      const p = join(dir, 'DELIVERY_MANIFEST.json');
      const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
      // A real, reachable, DIFFERENT commit: claiming an unreachable one would
      // only prove the verifier can fail to look something up.
      const parent = spawnSync('git', ['rev-parse', `${m.sourceCommit ?? 'HEAD'}~1`], { cwd: ROOT, encoding: 'utf8' });
      const other = parent.status === 0 ? parent.stdout.trim() : '0'.repeat(40);
      writeFileSync(p, JSON.stringify({ ...m, sourceCommit: other }, null, 2));
      return `changed sourceCommit from ${(m.sourceCommit ?? '').slice(0, 12)}… to its parent ${other.slice(0, 12)}…`;
    },
  },
];

function main(): number {
  const args = process.argv.slice(2);
  const archive = args.find((a) => a.startsWith('--archive='))?.slice('--archive='.length);
  const dirArg = args.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const prove = args.includes('--prove');

  console.log('P15 — RC ARCHIVE SOURCE IDENTITY, VERIFIED AFTER EXTRACTION');
  console.log('='.repeat(78));

  if (archive === undefined && dirArg === undefined) {
    console.log('UNMEASURED: pass --archive=<zip> or --dir=<extracted tree>. Nothing was checked.');
    return 1;
  }

  let dir: string;
  let temp: string | null = null;
  try {
    if (dirArg !== undefined) {
      dir = resolve(dirArg);
      if (!existsSync(dir)) {
        console.log(`UNMEASURED: ${dir} does not exist.`);
        return 1;
      }
      console.log(`subject: an already-extracted tree at ${dir}`);
    } else {
      const zip = resolve(archive as string);
      if (!existsSync(zip)) {
        console.log(`UNMEASURED: ${zip} does not exist.`);
        return 1;
      }
      const zipHash = sha256(readFileSync(zip));
      const sidecar = `${zip}.sha256`;
      console.log(`subject: ${relative(ROOT, zip)} (sha256 ${zipHash})`);
      if (existsSync(sidecar)) {
        const stated = (readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '').toLowerCase();
        console.log(`  sibling .sha256: ${stated === zipHash ? 'MATCHES the archive’s bytes' : `DISAGREES — states ${stated}`}`);
        if (stated !== zipHash) {
          console.log('  ! the archive does not hash to what its own sidecar states; stop here and find out why before reading anything below');
        }
      } else {
        console.log('  sibling .sha256: ABSENT — the exporter writes one, so its absence is itself a question');
      }
      dir = extract(zip);
      temp = dir;
    }

    const { outcomes, manifest } = verify(dir);
    console.log('');
    for (const o of outcomes) {
      console.log(`${o.ok ? 'PASS' : 'FAIL'}  ${o.route.padEnd(30)} ${o.detail}`);
    }
    const green = outcomes.every((o) => o.ok);

    let redOk = true;
    if (prove) {
      console.log('');
      console.log('RED PROOFS — each tamper is made on a COPY, never on the subject or the repository');
      console.log('-'.repeat(78));
      for (const r of RED) {
        const copy = mkdtempSync(join(tmpdir(), 'p15-rc-red-'));
        const into = join(copy, 'tree');
        try {
          cpSync(dir, into, { recursive: true });
          const what = r.tamper(into);
          const { outcomes: after } = verify(into);
          const refusal = after.find((o) => o.route === r.route);
          const refused = refusal !== undefined && !refusal.ok && r.reason.test(refusal.detail);
          console.log(`${refused ? 'RED AS REQUIRED' : 'NOT RED — DEFECT'}  ${r.id}  ${r.law}`);
          console.log(`     tamper: ${what}`);
          if (refused) {
            console.log(`     refused by ${r.route}: ${(refusal?.detail ?? '').slice(0, 200)}`);
          } else {
            redOk = false;
            console.log(
              `     ${r.route} said: ${refusal === undefined ? '(that route did not run)' : refusal.ok ? 'PASS — it did not notice' : `FAIL, but for another reason: ${refusal.detail.slice(0, 200)}`}`,
            );
          }
        } catch (e) {
          redOk = false;
          console.log(`NOT RED — DEFECT  ${r.id}  the proof itself failed: ${(e as Error).message.slice(0, 200)}`);
        } finally {
          rmSync(copy, { recursive: true, force: true });
        }
      }
    }

    console.log('');
    console.log('-'.repeat(78));
    console.log(
      `identity: ${green ? 'ESTABLISHED by all three routes' : 'NOT ESTABLISHED'}${prove ? `; red proofs ${redOk ? 'all RED as required' : 'INCOMPLETE'}` : '; red proofs not run (pass --prove)'}`,
    );
    const commit = manifest?.sourceCommit ?? '(unknown)';
    const onBranch = spawnSync('git', ['branch', '--contains', commit, '--format=%(refname:short)'], { cwd: ROOT, encoding: 'utf8' });
    const branches = onBranch.status === 0 ? onBranch.stdout.trim().split('\n').filter(Boolean) : [];
    console.log('');
    console.log('§79 — WHAT THIS RUN IS NOT');
    console.log(`  The archive verified here is commit ${commit}${branches.length > 0 ? `, on ${branches.join(', ')}` : ''}.`);
    console.log('  If that is a PREP branch, this run proves the VERIFIER works and proves');
    console.log('  nothing about a release candidate: final P15 evidence must run on the');
    console.log('  FINAL EXACT SHA. A number carried out of here is not release evidence.');
    return green && redOk ? 0 : 1;
  } finally {
    if (temp !== null) rmSync(resolve(temp, '..'), { recursive: true, force: true });
  }
}

process.exitCode = main();
