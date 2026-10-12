#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P15 HANDOFF MANIFEST VERIFIER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS — a failure of mine, mechanised so it cannot recur quietly
 *
 * PART 13 of DIRECTIVE #11 makes the handoff manifest a required gate and
 * requires a SHA256 for every off-Git artifact. I wrote that manifest, computed
 * the digests, and then kept editing three of the documents it describes. The
 * digests were therefore stale the moment the next edit landed, and nothing
 * said so: a reader would have taken a stale digest as a verified one.
 *
 * The bundle-integrity audit caught it from the outside, which is the part that
 * matters — my own evidence index was wrong and only an external check noticed.
 * The repository's own rule already covered this and I broke it:
 * **generated artifacts LAST.** A digest is a generated artifact.
 *
 * Recomputing the digests fixes this instance and nothing else. This script is
 * the part that generalises: the manifest becomes self-verifying, so the same
 * ordering mistake fails loudly on the next run instead of shipping.
 *
 * ── BOTH DIRECTIONS, because a one-sided check is half a ratchet ──────────
 *
 *   1. every digest in the manifest matches the file it names  (no stale digest)
 *   2. every artifact in the directory appears in the manifest (no silent gap)
 *
 * (1) alone would pass a manifest that simply omits the document somebody
 * forgot to hash — which is the failure PART 13 exists to prevent in the first
 * place. (2) alone would pass a complete list of wrong numbers.
 *
 * It also refuses to pass on an empty digest table: a verifier that parsed
 * nothing and reported success is the vacuous green PART 17 forbids.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/phase15/verify-handoff-manifest.ts
 *   npx tsx scripts/phase15/verify-handoff-manifest.ts --rewrite
 *
 * `--rewrite` recomputes the table in place, and is the ONLY sanctioned way to
 * update it: run it as the last action before a handoff, after every document
 * edit, never before. Without it the script is read-only and exits non-zero on
 * any mismatch or omission.
 */

import { protectFailingExitCode } from '../../tests/helpers/exit-code';

protectFailingExitCode();

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ARGV = process.argv.slice(2);
const REWRITE = ARGV.includes('--rewrite');
const DIR = ARGV.find((a) => a.startsWith('--dir='))?.slice('--dir='.length) ?? '/mnt/project-files/phase15';
const MANIFEST = 'P15-HANDOFF-MANIFEST.md';

/** The manifest cannot carry its own digest: writing it changes it. */
const SELF = MANIFEST;

const ROW = /^\| `(P15-[A-Za-z0-9_.-]+\.(?:md|json))` \| ([\d,]+) \| `([0-9a-f]{64})` \|$/gm;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function artifactsOnDisk(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^P15-.*\.(md|json)$/.test(f) && f !== SELF)
    .sort();
}

function main(): void {
  console.log('P15 HANDOFF MANIFEST VERIFIER — PART 13');
  console.log(`  directory ${DIR}`);

  const manifestPath = join(DIR, MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(
      `\nFAIL — the manifest itself is missing at ${manifestPath}. PART 13 makes it a required gate, so its absence is a gate failure, not a nil result.`,
    );
    process.exitCode = 1;
    return;
  }

  const manifest = readFileSync(manifestPath, 'utf8');
  const rows = [...manifest.matchAll(ROW)].map((m) => ({ name: m[1] as string, bytes: Number((m[2] as string).replace(/,/g, '')), digest: m[3] as string }));

  // ── non-vacuity: a verifier that parsed nothing has measured nothing ────
  if (rows.length === 0) {
    console.error(
      '\nUNMEASURED — no digest rows were parsed from the manifest. A verifier with an empty subject set proves nothing, so this is a failure and not a pass (PART 17).',
    );
    process.exitCode = 1;
    return;
  }

  const onDisk = artifactsOnDisk(DIR);
  console.log(`  subjects  ${rows.length} digest row(s) in the manifest, ${onDisk.length} artifact(s) on disk\n`);

  // ── direction 1: no stale or wrong digest ──────────────────────────────
  const stale: { name: string; was: string; now: string; wasBytes: number; nowBytes: number }[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const p = join(DIR, row.name);
    if (!existsSync(p)) {
      missing.push(row.name);
      console.log(`  MISSING  ${row.name} — named in the manifest, absent from disk`);
      continue;
    }
    const now = sha256(p);
    const nowBytes = statSync(p).size;
    if (now === row.digest) {
      console.log(`  OK       ${row.name}`);
    } else {
      stale.push({ name: row.name, was: row.digest, now, wasBytes: row.bytes, nowBytes });
      console.log(`  STALE    ${row.name}`);
      console.log(`           manifest ${row.digest} (${row.bytes} bytes)`);
      console.log(`           actual   ${now} (${nowBytes} bytes, ${nowBytes - row.bytes >= 0 ? '+' : ''}${nowBytes - row.bytes})`);
    }
  }

  // ── direction 2: no artifact omitted from the manifest ─────────────────
  const listed = new Set(rows.map((r) => r.name));
  const unlisted = onDisk.filter((f) => !listed.has(f));
  for (const f of unlisted) console.log(`  UNLISTED ${f} — present on disk, absent from the manifest`);

  if (REWRITE) {
    const table = onDisk.map((f) => `| \`${f}\` | ${statSync(join(DIR, f)).size.toLocaleString('en-US')} | \`${sha256(join(DIR, f))}\` |`).join('\n');
    const first = rows[0];
    if (first === undefined) {
      console.error('\nFAIL — cannot rewrite a table that was not parsed.');
      process.exitCode = 1;
      return;
    }
    const firstRow = new RegExp(`^\\| \`${first.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\` \\|.*$`, 'm');
    const start = manifest.search(firstRow);
    if (start < 0) {
      console.error('\nFAIL — could not locate the digest table to rewrite.');
      process.exitCode = 1;
      return;
    }
    const lines = manifest.slice(start).split('\n');
    let end = 0;
    while (end < lines.length && /^\| `P15-/.test(lines[end] ?? '')) end++;
    const rewritten = `${manifest.slice(0, start)}${table}\n${lines.slice(end).join('\n')}`;
    writeFileSync(manifestPath, rewritten);
    console.log(`\nREWROTE the digest table: ${onDisk.length} artifact(s).`);
    console.log(
      '  This is the LAST action before a handoff, never an earlier one: a digest computed before the next edit is stale the moment that edit lands.',
    );
    console.log('\nPHASE 15 HANDOFF MANIFEST: REWRITTEN');
    return;
  }

  const problems = stale.length + missing.length + unlisted.length;
  console.log('');
  if (problems === 0) {
    console.log(`PHASE 15 HANDOFF MANIFEST: VERIFIED — ${rows.length} digest(s) match, ${onDisk.length} artifact(s) all listed, none missing`);
    return;
  }
  console.error(
    `PHASE 15 HANDOFF MANIFEST: FAIL — ${stale.length} stale digest(s), ${missing.length} missing file(s), ${unlisted.length} unlisted artifact(s).`,
  );
  console.error('  A stale digest is not a cosmetic defect: it is an evidence index asserting a byte state that is not the one on disk.');
  console.error(
    '  Fix the DOCUMENTS first if a change was unintended, then re-run with --rewrite as the last action. Do not swap digests to make a diff disappear.',
  );
  process.exitCode = 1;
}

main();
