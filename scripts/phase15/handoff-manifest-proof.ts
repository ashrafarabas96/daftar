/**
 * PHASE 15 — RED PROOF: CAN DIRECTION 4 OF THE MANIFEST GATE GO RED?
 * (PREPARED / NOT PROMOTED)
 *
 * WHY
 *   The coordinator's F-14 was a false SENTENCE in the handoff manifest, not a
 *   stale digest: §8 claimed the independent challenger had never run while six
 *   of its reports sat in the same directory. The remedy was a fourth direction
 *   in `verify:handoff-manifest` that reads those reports and checks the prose
 *   against them. A direction that has never been shown to fail is not a gate,
 *   so this harness plants, one at a time, each way the prose and the reports can
 *   disagree — and the one way they can APPEAR to disagree while being correct.
 *
 *   Every plant is made in a throwaway COPY of the directory. The shared pack at
 *   /mnt/project-files/phase15 is read and never written: other sessions are
 *   working in it, and a proof that edits the subject it is proving over is not a
 *   proof.
 *
 * THE FOURTH PLANT IS THE POINT
 *   M4 plants the false sentence as a QUOTATION, inside guillemets, exactly as
 *   the corrected §8 records it. It must NOT redden. A check that cannot tell a
 *   correction from a repetition punishes a document for admitting its error, and
 *   authors then stop admitting them — so the exemption is proved in both
 *   directions, M3 against M4, rather than asserted in a comment.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACK = process.env.P15_PACK_DIR ?? '/mnt/project-files/phase15';
const MANIFEST = 'P15-HANDOFF-MANIFEST.md';
const FALSE_CLAIM = 'NOT RUN on any Phase 15 artifact';

/** Run the gate against a copy and return only its DIRECTION 4 block. */
function direction4(dir: string): { readonly text: string; readonly contradictions: number; readonly ran: boolean } {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // The gate exits 1 for any direction, so its CODE cannot tell us which one
  // spoke. But a gate that did not run at all must never read as "nothing
  // contradicted": that is the fail-open this whole round is about.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // The gate's own codes are 0 and 1. Any other code is the runner failing to
  // start it, which must not reach the marker test at all: `ran: false` is the
  // only honest answer, and it is the answer the exit code gives here.
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    return { text: `${out.slice(-500)}\n[harness] the gate did not run: exit ${String(r.status)}`, contradictions: 0, ran: false };
  if (!out.includes('DIRECTION 4')) return { text: out.slice(-600), contradictions: 0, ran: false };
  const block = out.slice(out.indexOf('DIRECTION 4'));
  return { text: block, contradictions: (block.match(/CONTRADICTED /g) ?? []).length, ran: true };
}

interface Plant {
  readonly id: string;
  readonly what: string;
  readonly plant: (dir: string) => void;
  /** null when the gate behaved as required. */
  readonly expect: (d: ReturnType<typeof direction4>) => string | null;
}

const reports = (dir: string): string[] => readdirSync(dir).filter((f) => /^P15-CHALLENGE-[0-9a-f]{7,40}\.md$/.test(f)).sort();

/**
 * Run the gate's own sanctioned regeneration against a copy. `--rewrite` adds
 * every P15-* file in the directory to the digest table, which is exactly what
 * made B2's fail-open invisible: M2 plants an unnamed report but never
 * regenerates, so it never reached the state a real handoff is left in.
 */
function rewrite(dir: string): void {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`, '--rewrite'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    throw new Error(`--rewrite did not run: exit ${String(r.status)}${r.error === undefined ? '' : ` (${String(r.error)})`}`);
}

const PLANTS: readonly Plant[] = [
  {
    id: 'M1',
    what: 'a challenge report the manifest names is DELETED — the absence case',
    plant: (dir) => {
      const first = reports(dir)[0];
      if (first === undefined) throw new Error('no challenge report in the copy to delete');
      unlinkSync(join(dir, first));
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'the manifest still claims a round whose report is gone, and direction 4 said nothing. A check that only catches drift passes when the evidence is simply absent',
  },
  {
    id: 'M2',
    what: 'a round happened and was never recorded — a report on disk the manifest does not name',
    plant: (dir) => {
      writeFileSync(join(dir, 'P15-CHALLENGE-0bada55.md'), '# planted round\nThis file exists only inside a throwaway copy.\n');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'a challenge report sat on disk unnamed by the manifest and the gate passed — which is exactly how "NOT RUN" survived six rounds',
  },
  {
    id: 'M3',
    what: 'the false sentence is re-ASSERTED in the prose',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      writeFileSync(join(dir, MANIFEST), `${readFileSync(f, 'utf8')}\n\nThe challenger is ${FALSE_CLAIM}.\n`);
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'the manifest asserts the challenger never ran, six reports are on disk, and the gate agreed with the manifest',
  },
  {
    id: 'M4',
    what: 'the same sentence as a QUOTATION, as the correction records it — must NOT redden',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      writeFileSync(join(dir, MANIFEST), `${readFileSync(f, 'utf8')}\n\nThis file used to say «${FALSE_CLAIM}», and that was wrong.\n`);
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions === 0
          ? null
          : 'a correction QUOTING the claim it retracts was failed as if it were repeating it. Punish that and the next author stops recording the correction at all',
  },
  {
    id: 'M5',
    what: 'an unrecorded round, THEN the sanctioned --rewrite — the index must not become the record',
    plant: (dir) => {
      writeFileSync(join(dir, 'P15-CHALLENGE-0bada55.md'), '# planted round\nThis file exists only inside a throwaway copy.\n');
      rewrite(dir);
      const digested = readFileSync(join(dir, MANIFEST), 'utf8').includes('P15-CHALLENGE-0bada55.md');
      if (!digested) throw new Error('--rewrite did not add the planted report to the digest table, so this plant does not reach the state B2 describes');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'after its own --rewrite the gate counted the planted report as NAMED, because the digest row it had just written looked like a record. An index proves a file exists, which is the one thing never in doubt',
  },
];

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — RED PROOF: DIRECTION 4 OF THE HANDOFF MANIFEST GATE   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  console.log(`  subject pack  ${PACK} — READ, never written. Each plant goes in its own copy.`);
  console.log('');

  const base = mkdtempSync(join(tmpdir(), 'p15-mf-base-'));
  let baseline: ReturnType<typeof direction4>;
  try {
    cpSync(PACK, join(base, 'pack'), { recursive: true });
    baseline = direction4(join(base, 'pack'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (!baseline.ran || baseline.contradictions > 0) {
    console.log(`  M0 BASELINE  an untouched copy is clean: FAIL — ${baseline.ran ? `${baseline.contradictions} contradiction(s) already` : 'the gate did not run'}`);
    console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a');
    console.log('  later red to a planted defect. Fix the manifest first, then re-run this proof.');
    console.log(baseline.text);
    return 1;
  }
  console.log('  M0 BASELINE  an untouched copy is clean: OK (direction 4 reports no contradiction)');

  let failures = 0;
  for (const p of PLANTS) {
    const tmp = mkdtempSync(join(tmpdir(), 'p15-mf-'));
    try {
      cpSync(PACK, join(tmp, 'pack'), { recursive: true });
      const dir = join(tmp, 'pack');
      p.plant(dir);
      const d = direction4(dir);
      const problem = p.expect(d);
      const verdict = p.id === 'M4' ? 'HELD GREEN ' : 'RED';
      if (problem === null) console.log(`  ${p.id} ${verdict.padEnd(10)}${p.what}`);
      else {
        failures += 1;
        console.log(`  ${p.id} FAILED    ${p.what}`);
        console.log(`       ${problem}`);
      }
    } catch (e) {
      failures += 1;
      console.log(`  ${p.id} FAILED    ${p.what}`);
      console.log(`       the plant itself did not go in: ${(e as Error).message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log('');
  if (failures > 0) {
    console.log(`EXIT 1 — ${failures} of ${PLANTS.length} plant(s) did not behave as required. Direction 4 is not`);
    console.log('  established, so the manifest’s §8 is prose again and F-14 is not closed.');
    return 1;
  }
  console.log(`All ${PLANTS.length} plants behaved as required: three reddened direction 4, and the quotation did not.`);
  console.log('  What this does NOT show: that any round PASSED. A verdict is the challenger’s to');
  console.log('  state and this author’s to quote. The gate checks only that the rounds this file');
  console.log('  claims and the rounds on disk are the same set.');
  return 0;
}

process.exitCode = main();
