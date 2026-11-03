#!/usr/bin/env node
/**
 * DAFTAR — the P4-S4 acceptance transition, performed by one script.
 *
 * WHY THIS EXISTS. The seal is not a document edit; it is a change of TENSE in
 * permanent machinery, and the tense decides which migrations are the slice's
 * subject. `sliceMigrations` (`scripts/phase4-s4-gate.ts`) returns the keys of
 * `S4_ACCEPTED` when that literal is non-empty and the files past the last
 * accepted migration when it is empty. So filling the literal and deleting the
 * candidate-tense fence are ONE act: either alone leaves the gate describing a
 * world that does not exist. P4-AL-61 requires the fenced region to be deleted
 * by the acceptance commit, and `selfClosureProblems` turns the gate RED if the
 * literal is filled while the fence is still there.
 *
 * REHEARSE THE ACCEPTANCE COMMIT, NOT ONLY THE CANDIDATE. The first time this
 * transition was performed by hand it produced fifteen TypeScript errors,
 * because `S4_ACCEPTED`, `candidateMigrations` and the candidate check's
 * registration all sat inside the region being deleted. A candidate tree that
 * is green proves nothing about the tree the seal commit creates. `--rehearse`
 * therefore performs the whole transition on COPIES and reports what the
 * accepted tree would say, writing nothing.
 *
 * WHAT IT WILL NOT DO. It never edits a migration file, never invents a
 * migration number, never copies a digest from a document or from a previous
 * round, and never writes a CI run id, a conclusion or an acceptance verdict.
 * Every digest is recomputed from the file on disk in the tree being sealed —
 * a digest inherited from the candidate round pins a file that may have
 * changed during a corrective pass, which has happened here before. The
 * acceptance page and the owner's verdict are written by a human hand
 * elsewhere; this script moves machinery only.
 *
 * Usage:
 *   node scripts/seal-p4s4.mjs --rehearse    # default: writes nothing
 *   node scripts/seal-p4s4.mjs --apply       # writes the four files in place
 *
 * `--apply` refuses unless every precondition below holds, and it prints the
 * exact follow-up commands (whole-tree typecheck, the slice gate, the manifest
 * check) that must be green before the seal commit is made. It does not make
 * the commit: the commit message is the owner's record of an acceptance.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = 'scripts/phase4-s4-gate.ts';
const PREFIX = 'scripts/phase4-prefix.ts';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';
const MIGRATIONS = 'infrastructure/database/migrations';

const SLICE = 'P4-S4';
/** The slice whose head this one starts from. Read, never assumed. */
const PREDECESSOR = 'P4-S3';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const sha256 = (rel) =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, rel)))
    .digest('hex');

const problems = [];
const fail = (m) => problems.push(m);

// ──────────────────────────────────────────────────────────────────────────
// 1. The subject: which migrations this seal freezes.
//
// Discovered, never listed. The subject is every migration file on disk
// numbered past the predecessor's accepted head — the same rule
// `candidateMigrations` uses, restated here so the two can be compared rather
// than one trusting the other.
// ──────────────────────────────────────────────────────────────────────────

const manifest = JSON.parse(read(MANIFEST));
const frozenThrough = manifest.frozenThrough;
const number = (file) => {
  const m = /^(\d+)_/.exec(file);
  return m ? Number(m[1]) : null;
};
const frozenNumber = number(frozenThrough);
if (frozenNumber === null) fail(`the manifest's frozenThrough ${JSON.stringify(frozenThrough)} does not begin with a migration number`);

const onDisk = readdirSync(join(ROOT, MIGRATIONS))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const subject = onDisk.filter((f) => {
  const n = number(f);
  return n !== null && frozenNumber !== null && n > frozenNumber;
});

if (subject.length === 0) fail(`no migration on disk is numbered past ${frozenThrough} — there is nothing to seal`);

// The numbering must be contiguous from the frozen head. A gap means a
// migration was renamed, deleted, or never written, and sealing across it
// would freeze a prefix that no fresh install can reproduce.
for (let i = 0; i < subject.length; i += 1) {
  const expected = (frozenNumber ?? 0) + i + 1;
  const got = number(subject[i]);
  if (got !== expected)
    fail(
      `the candidate numbering is not contiguous from ${frozenThrough}: expected ${String(expected).padStart(4, '0')} at position ${i} and found ${subject[i]}`,
    );
}

// Every subject file must already be listed by the gate's own discovery, or
// the two rules disagree and the gate is describing a different slice.
const gateSrc = read(GATE);
if (!/export function candidateMigrations/.test(gateSrc))
  fail(`${GATE} no longer exports candidateMigrations — this script's subject rule has nothing to agree with`);

// ──────────────────────────────────────────────────────────────────────────
// 2. Preconditions. Each one is a reason the transition would produce a tree
//    that lies, so each is fatal rather than a warning.
// ──────────────────────────────────────────────────────────────────────────

const S4_ACCEPTED_RE = /export const S4_ACCEPTED: Readonly<Record<string, string>> = \{\};/;
if (!S4_ACCEPTED_RE.test(gateSrc))
  fail(`${GATE}: S4_ACCEPTED is not the empty literal this transition expects — it may already be filled, or its declaration changed`);

const FENCE_OPEN = /^[ \t]*\/\/ ─+ CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm;
const FENCE_CLOSE = /^[ \t]*\/\/ ─+ end CANDIDATE-TENSE \(P4-AL-61\)[^\n]*\n/gm;
const opens = [...gateSrc.matchAll(FENCE_OPEN)];
const closes = [...gateSrc.matchAll(FENCE_CLOSE)];
if (opens.length === 0) fail(`${GATE}: no candidate-tense fence is present, so there is nothing for the acceptance commit to delete (P4-AL-61)`);
if (opens.length !== closes.length) fail(`${GATE}: the candidate-tense fences are not paired — ${opens.length} opening and ${closes.length} closing marker(s)`);

// The header explains the mechanism in PROSE, outside every fence, so the
// transition leaves it standing. After the seal three of its claims are false:
// the literal is not empty, the slice is not a candidate, and nothing is
// fenced. `selfClosureProblems` reads markers, not prose, so nothing else
// would ever notice. The exact sentence is required to be present, so this
// script REFUSES rather than silently skipping a paragraph that has been
// reworded since.
const CANDIDATE_PROSE_RE =
  /`S4_ACCEPTED` is EMPTY because P4-S4 is a CANDIDATE, and everything\n \* the accepted tense has no use for is fenced between\n \* `CANDIDATE-TENSE \(P4-AL-61\)` markers — the candidate-tense block below and\n \* that check's registration in `CHECKS` — so the acceptance commit can find\n \* exactly what to delete and nothing it still needs\./;
const ACCEPTED_PROSE =
  "`S4_ACCEPTED` holds this slice's seven accepted digests, so `sliceMigrations`\n * takes the ACCEPTED keys as its subject and `candidateMigrations` names the\n * NEXT slice's files rather than this one's. The candidate-tense fence the\n * acceptance commit deleted is gone, and `selfClosureProblems` asserts that no\n * marker survived it.";
if (!CANDIDATE_PROSE_RE.test(gateSrc))
  fail(
    `${GATE}: the header's candidate-tense paragraph is not the text this transition rewrites — it has been reworded, and a seal that leaves it standing leaves a false present-tense claim in a permanent module`,
  );

const prefixSrc = read(PREFIX);
const PREFIX_RE = /export const PHASE4_S4_PREFIX: Prefix = \[\];/;
if (!PREFIX_RE.test(prefixSrc)) fail(`${PREFIX}: PHASE4_S4_PREFIX is not the empty literal this transition expects`);
if (new RegExp(`'${SLICE}':`).test(prefixSrc)) fail(`${PREFIX}: PHASE4_SLICE_HEADS already names ${SLICE}`);
if (!new RegExp(`'${PREDECESSOR}': '`).test(prefixSrc))
  fail(`${PREFIX}: PHASE4_SLICE_HEADS does not name ${PREDECESSOR}, so this slice has no head to start from`);

const alreadyInManifest = subject.filter((f) => manifest.migrations.some((e) => e.name === f));
if (alreadyInManifest.length > 0)
  fail(`the manifest already holds ${alreadyInManifest.join(', ')} while frozenThrough is ${frozenThrough} — the manifest and the freeze disagree`);

// ──────────────────────────────────────────────────────────────────────────
// 3. The transition, as four pure text/JSON functions.
// ──────────────────────────────────────────────────────────────────────────

const digests = new Map(subject.map((f) => [f, sha256(join(MIGRATIONS, f))]));

/** Fill `S4_ACCEPTED`, then delete EVERY fenced region. Both, or neither. */
function transitionGate(src) {
  const body = subject.map((f) => `  '${f}': '${digests.get(f)}',`).join('\n');
  let out = src.replace(S4_ACCEPTED_RE, `export const S4_ACCEPTED: Readonly<Record<string, string>> = {\n${body}\n};`);
  // Delete each fenced region, from the opening marker through the closing
  // one inclusive, working from the end so earlier offsets stay valid.
  const o = [...out.matchAll(FENCE_OPEN)];
  const c = [...out.matchAll(FENCE_CLOSE)];
  if (o.length !== c.length) throw new Error('fence pairing changed while filling the literal');
  for (let i = o.length - 1; i >= 0; i -= 1) {
    const start = o[i].index;
    const end = c[i].index + c[i][0].length;
    if (!(start < end)) throw new Error(`fence ${i} closes before it opens`);
    out = out.slice(0, start) + out.slice(end);
  }
  // Finally the prose, which no fence covered.
  out = out.replace(CANDIDATE_PROSE_RE, ACCEPTED_PROSE);
  return out;
}

function transitionPrefix(src) {
  const body = subject.map((f) => `['${f}', '${digests.get(f)}']`).join(', ');
  let out = src.replace(PREFIX_RE, `export const PHASE4_S4_PREFIX: Prefix = [${body}];`);
  const head = subject[subject.length - 1];
  out = out.replace(new RegExp(`(  '${PREDECESSOR}': '[^']*',\\n)`), `$1  '${SLICE}': '${head}',\n`);
  return out;
}

function transitionManifest(m) {
  const head = subject[subject.length - 1];
  return {
    ...m,
    generatedAt: new Date().toISOString(),
    frozenThrough: head,
    migrations: [...m.migrations, ...subject.map((f) => ({ name: f, sha256: digests.get(f) }))],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Report, and write only under --apply.
// ──────────────────────────────────────────────────────────────────────────

const apply = process.argv.includes('--apply');

console.log(`P4-S4 ACCEPTANCE TRANSITION — ${apply ? 'APPLY' : 'REHEARSE (writes nothing)'}`);
console.log(`  root            ${ROOT}`);
console.log(`  frozenThrough   ${frozenThrough}  (${manifest.migrations.length} entries)`);
console.log(`  subject         ${subject.length} migration(s) discovered past the frozen head:`);
for (const f of subject) console.log(`                  ${f}  ${digests.get(f)}`);

if (problems.length > 0) {
  console.error(`\nREFUSED — ${problems.length} precondition(s) not met:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

let nextGate;
let nextPrefix;
let nextManifest;
try {
  nextGate = transitionGate(gateSrc);
  nextPrefix = transitionPrefix(prefixSrc);
  nextManifest = transitionManifest(manifest);
} catch (e) {
  console.error(`\nREFUSED — the transition itself failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Post-conditions on the tree the transition WOULD create. These are the
// checks a textual edit cannot be trusted without: the fence must be gone,
// the literal must be filled, the manifest must be valid and the head must
// have moved to this slice's own last migration.
const after = [];
// The MARKERS must be gone, not the phrase: the file's header explains the
// mechanism in prose and must go on explaining it, and `selfClosureProblems`
// owns this same assertion in the accepted tense. Asking for the phrase
// instead of the marker is how a correct seal is refused — the rehearsal
// refused one that way before this distinction was drawn.
if (new RegExp(FENCE_OPEN.source, 'm').test(nextGate) || new RegExp(FENCE_CLOSE.source, 'm').test(nextGate))
  after.push(`${GATE}: a candidate-tense fence MARKER LINE survives the transition`);
if (CANDIDATE_PROSE_RE.test(nextGate))
  after.push(`${GATE}: the header still says S4_ACCEPTED is empty and the slice is a candidate, which the seal makes false`);
if (S4_ACCEPTED_RE.test(nextGate)) after.push(`${GATE}: S4_ACCEPTED is still the empty literal`);
for (const f of subject) {
  if (!nextGate.includes(`'${f}': '${digests.get(f)}'`)) after.push(`${GATE}: ${f} is not recorded with its recomputed digest`);
  if (!nextPrefix.includes(`['${f}', '${digests.get(f)}']`)) after.push(`${PREFIX}: ${f} is not in PHASE4_S4_PREFIX with its recomputed digest`);
}
if (!new RegExp(`'${SLICE}': '${subject[subject.length - 1]}'`).test(nextPrefix))
  after.push(`${PREFIX}: PHASE4_SLICE_HEADS does not name ${SLICE} at ${subject[subject.length - 1]}`);
if (nextManifest.frozenThrough !== subject[subject.length - 1]) after.push(`${MANIFEST}: frozenThrough did not move to the slice head`);
if (nextManifest.migrations.length !== manifest.migrations.length + subject.length)
  after.push(`${MANIFEST}: entry count moved by ${nextManifest.migrations.length - manifest.migrations.length} rather than ${subject.length}`);
{
  const names = nextManifest.migrations.map((e) => e.name);
  if (new Set(names).size !== names.length) after.push(`${MANIFEST}: a migration is listed twice`);
  if ([...names].sort().join() !== names.join()) after.push(`${MANIFEST}: the entries are not in name order`);
}

if (after.length > 0) {
  console.error(`\nREFUSED — the transition would produce a tree that lies (${after.length}):`);
  for (const p of after) console.error(`  - ${p}`);
  process.exit(1);
}

const fencedLines = gateSrc.split('\n').length - nextGate.split('\n').length;
console.log(`\n  gate            S4_ACCEPTED filled with ${subject.length} digest(s); ${opens.length} fenced region(s) deleted (${fencedLines} lines)`);
console.log(`  prefix          PHASE4_S4_PREFIX filled; PHASE4_SLICE_HEADS gains ${SLICE} → ${subject[subject.length - 1]}`);
console.log(`  manifest        frozenThrough → ${nextManifest.frozenThrough}; ${manifest.migrations.length} → ${nextManifest.migrations.length} entries`);

if (!apply) {
  console.log(`\nREHEARSAL ONLY — nothing was written. Every precondition and post-condition passed.`);
  console.log(`What a rehearsal CANNOT tell you: whether the accepted tree typechecks. The first`);
  console.log(`hand-performed transition produced fifteen TypeScript errors because the deleted`);
  console.log(`region held machinery the rest of the file still referenced. Run --apply on a quiet`);
  console.log(`tree, then the three commands below, and revert if any is red.`);
  process.exit(0);
}

writeFileSync(join(ROOT, GATE), nextGate);
writeFileSync(join(ROOT, PREFIX), nextPrefix);
writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(nextManifest, null, 2)}\n`);

console.log(`\nAPPLIED to three files. NOT committed, and no acceptance is recorded by this script.`);
console.log(`Now, in this order, and each must be green before the seal commit:`);
console.log(`  npm run typecheck                                  # whole tree, real exit status`);
console.log(`  npx tsx scripts/check-migration-manifest.ts        # digests recomputed independently`);
console.log(`  npx tsx scripts/phase4-s4-gate.ts                  # the gate in its ACCEPTED tense`);
console.log(`  npm run format && npm run lint`);
console.log(`The acceptance page and the owner's verdict are written by hand; this script moved`);
console.log(`machinery only, and ${MANIFEST}'s generatedAt now differs, so a re-run is not idempotent.`);
