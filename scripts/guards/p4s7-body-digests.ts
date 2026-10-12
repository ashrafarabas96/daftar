/**
 * P4-S7 — THE ROUTINE-BODY DIGESTS THE END-STATE BLOCK PINS
 * (`TL-P4-COORD-R46`'s structural ruling; `TL-P4-COORD-R50` §5 and ordered
 *  item 4).
 *
 * ── WHY A DIGEST AND NOT A PATTERN ────────────────────────────────────────
 *
 * The specification's end-state block carried two `prosrc` substring ratchets
 * over `installment_plan_fact_sync()` and `customer_ar_aging()`, and two more
 * over `customer_ar_aging()`'s rounding and `installment_schedule_verify()`'s
 * retired obligation (e). All four were defeated, twice, by the two halves of
 * one ruling:
 *
 *   * a `prosrc LIKE` cannot establish a property of code, because a COMMENT
 *     is a string — round 10 satisfied four such tests with the tokens living
 *     only inside comments of an otherwise round-9 body;
 *   * a `prosrc NOT LIKE` cannot establish the ABSENCE of a property, because
 *     an IDENTIFIER is also a string — round 11 renamed `v_asserted` to
 *     `v_floor`, added one live `OLD.status` assignment, and installed round
 *     9's body with the comment-stripping version of the ratchet reporting OK.
 *
 * A digest of `pg_proc.prosrc` is neither. It is catalogue DATA compared
 * against the digest of the text the file ships, and it establishes exactly
 * one thing: THE INSTALLED BODY IS THE BODY THAT WAS REVIEWED. It makes no
 * claim that the body is correct — no apply-time instrument can — and the
 * behavioural proofs stay where they have to be, in
 * `tests/integration/phase4-s7-installment-fact-db.test.ts`, which plants the
 * defective bodies and requires the refusals.
 *
 * ── THE COUPLING, AND WHY IT IS CHECKED IN BOTH DIRECTIONS ────────────────
 *
 * The constants live in the specification's own `DO $end$` block, so an edit
 * to a body without an edit to its constant produces a migration that will not
 * apply. That is the point of a ratchet and it is also a trap if the only
 * thing that notices is a deployment. So this module is the ONE extractor,
 * `packages/domain-core/test/phase4-s7-installment-aging.test.ts` asserts the
 * constants in the file equal what it computes, and the CLI below prints the
 * replacements when a body legitimately changes.
 *
 * ── THE SLICE IS THE DOLLAR-QUOTED BODY AND NOTHING ELSE ──────────────────
 *
 * `prosrc` holds exactly the characters between the opening `$fn$` and the
 * closing `$fn$` — the leading newline included, the trailing one included,
 * the `CREATE OR REPLACE` header excluded. The extractor below takes that
 * slice literally rather than normalising it, because a normalisation is a
 * second definition of the subject and the cluster applies none.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A routine whose installed body the end-state block pins, keyed by its `regprocedure` text. */
export interface BodyDigest {
  /** The `CREATE OR REPLACE FUNCTION <this>` head, as the specification writes it. */
  readonly head: string;
  /** The `regprocedure` spelling the end-state block casts, e.g. `public.customer_ar_aging(uuid,uuid,date,integer[])`. */
  readonly signature: string;
  /** `sha256` of the dollar-quoted body, hex. */
  readonly sha256: string;
  /** The body's length in characters, for a report that wants to say the slice was non-empty. */
  readonly length: number;
}

/**
 * The SIX routines, in the order the end-state block's `c_bodies` array
 * declares them. The `head` is matched literally against the file: a routine
 * whose head this list does not find is an error and never a silently skipped
 * entry, because a digest list that quietly covers four of five routines is
 * worse than none.
 *
 * ── AND THAT SENTENCE WAS AN ASSERTION IN A COMMENT WHILE THE LIST WAS
 *    EXACTLY THAT (`TL-P4-COORD-R52` ordered item 4, F-6) ─────────────────
 *
 * The list named FIVE of the six routines the specification installs, and the
 * one it omitted was `installment_plan_fact_assert` — THE SINGLE SITE OF ALL
 * FIVE OF THE READER'S REFUSALS. A stub conforming to every attribute the
 * end-state block pins (plpgsql, STABLE, SECURITY INVOKER, the pinned
 * `search_path`, five BIGINTs, boolean return, owned by
 * `daftar_accounting_internal`) whose entire body was `BEGIN RETURN true; END`
 * passed every law in that block, and the reader then served a figure with one
 * of the seven triggers disabled.
 *
 * So the completeness is now ENFORCED and not asserted: `routineHeads` reads
 * every `CREATE [OR REPLACE] FUNCTION` head out of the specification itself
 * and `bodyDigests` THROWS when the file installs a routine this list does not
 * name, or names one the file does not install. The subject of that law is the
 * file's own DDL heads — DATA about what is created — and not a `prosrc`
 * substring, which `TL-P4-COORD-R46` ruled cannot establish a property of code
 * and `TL-P4-COORD-R50` §5 ruled cannot establish an absence.
 */
export const P4S7_PINNED_BODIES: readonly { readonly head: string; readonly signature: string }[] = [
  { head: 'CREATE OR REPLACE FUNCTION installment_plan_fact_sync() RETURNS TRIGGER', signature: 'public.installment_plan_fact_sync()' },
  { head: 'CREATE OR REPLACE FUNCTION installment_plan_fact_verify() RETURNS TRIGGER', signature: 'public.installment_plan_fact_verify()' },
  { head: 'CREATE OR REPLACE FUNCTION installment_plan_active_exclusive() RETURNS TRIGGER', signature: 'public.installment_plan_active_exclusive()' },
  { head: 'CREATE OR REPLACE FUNCTION installment_schedule_verify() RETURNS TRIGGER', signature: 'public.installment_schedule_verify()' },
  {
    head: 'CREATE OR REPLACE FUNCTION installment_plan_fact_assert(p_unreadable_plan BIGINT,',
    signature: 'public.installment_plan_fact_assert(bigint,bigint,bigint,bigint,bigint)',
  },
  {
    head: 'CREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])',
    signature: 'public.customer_ar_aging(uuid,uuid,date,integer[])',
  },
];

/**
 * Every routine the specification INSTALLS, by bare name, read from its own
 * `CREATE [OR REPLACE] FUNCTION` heads.
 *
 * ANCHORED AT THE START OF A LINE, which is what makes the subject DDL rather
 * than prose: this file's own header discusses `CREATE OR REPLACE FUNCTION`
 * inside a box-drawing comment, and an unanchored match would count it as a
 * seventh routine. MEASURED: six heads at a line start, one mention inside a
 * comment, and the law goes red if that ratio ever changes — which is the
 * point, because a seventh routine is exactly what must not slip past the
 * digest list.
 */
export function routineHeads(spec: string): readonly string[] {
  return [...spec.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION[ \t]+([a-z_][a-z0-9_]*)[ \t]*\(/gm)].map((m) => m[1] as string);
}

/** The bare routine name of a pinned `regprocedure` signature. */
function pinnedName(signature: string): string {
  return signature.replace(/^public\./, '').replace(/\(.*$/, '');
}

/**
 * THE COMPLETENESS LAW. Throws when the specification installs a routine
 * `P4S7_PINNED_BODIES` does not name, or names one the specification does not
 * install. It is called by `bodyDigests` so that every consumer — the CLI, the
 * digest-coupling test — enforces it without having to remember to.
 */
export function assertPinnedBodiesComplete(spec: string): void {
  const installed = [...new Set(routineHeads(spec))].sort();
  const pinned = [...new Set(P4S7_PINNED_BODIES.map((r) => pinnedName(r.signature)))].sort();
  const unpinned = installed.filter((n) => !pinned.includes(n));
  const absent = pinned.filter((n) => !installed.includes(n));
  if (unpinned.length > 0 || absent.length > 0) {
    throw new Error(
      `p4s7-body-digests: the pinned-body list is not the set of routines the specification installs` +
        `${unpinned.length > 0 ? `; installed and NOT pinned: ${unpinned.join(', ')}` : ''}` +
        `${absent.length > 0 ? `; pinned and NOT installed: ${absent.join(', ')}` : ''}` +
        `. A digest list that covers some of the routines is worse than none: the uncovered one can be replaced by a conforming stub.`,
    );
  }
}

export const P4S7_SPEC_PATH = join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');

/** The characters between the `$fn$` quotes of the routine whose head starts at `from`. */
export function dollarQuotedBody(spec: string, head: string): string {
  const h = spec.indexOf(head);
  if (h < 0) throw new Error(`p4s7-body-digests: no routine head ${JSON.stringify(head)} in the specification`);
  const open = spec.indexOf('$fn$', h);
  if (open < 0) throw new Error(`p4s7-body-digests: no opening $fn$ after ${JSON.stringify(head)}`);
  const close = spec.indexOf('$fn$', open + 4);
  if (close < 0) throw new Error(`p4s7-body-digests: no closing $fn$ after ${JSON.stringify(head)}`);
  return spec.slice(open + 4, close);
}

/** Every pinned body's digest, computed from `spec`. Refuses an incomplete list first. */
export function bodyDigests(spec: string): readonly BodyDigest[] {
  assertPinnedBodiesComplete(spec);
  return P4S7_PINNED_BODIES.map((r) => {
    const body = dollarQuotedBody(spec, r.head);
    if (body.length < 200) throw new Error(`p4s7-body-digests: the body of ${r.signature} sliced to ${body.length} characters, which is not a routine`);
    return { head: r.head, signature: r.signature, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), length: body.length };
  });
}

/** Every pinned body's digest, computed from the specification on disk. */
export function bodyDigestsOnDisk(): readonly BodyDigest[] {
  return bodyDigests(readFileSync(P4S7_SPEC_PATH, 'utf8'));
}

/**
 * The `c_bodies` rows the end-state block declares, read back out of the
 * specification: `[signature, sha256]` per row, in declaration order. This is
 * the other side of the coupling — what the file SAYS, against what the file
 * IS.
 */
export function declaredBodyDigests(spec: string): readonly { readonly signature: string; readonly sha256: string }[] {
  const start = spec.indexOf('c_bodies    CONSTANT TEXT[][] := ARRAY[');
  if (start < 0) throw new Error('p4s7-body-digests: the end-state block declares no c_bodies array');
  const end = spec.indexOf(']];', start);
  if (end < 0) throw new Error('p4s7-body-digests: the c_bodies array is unterminated');
  const rows: { signature: string; sha256: string }[] = [];
  // `end` is the index of `]];`, whose FIRST `]` is the LAST ROW'S OWN closing
  // bracket -- so slicing to `end` truncates the fifth row and the regex below
  // matches four. That was this instrument's own defect, found by H7 going red
  // on a four-element list, and it is the reason the slice is `end + 1`.
  for (const m of spec.slice(start, end + 1).matchAll(/\['([^']+)',\s*'([0-9a-f]{64}|__SHA_[A-Z]+__)'\]/g)) {
    rows.push({ signature: m[1] as string, sha256: m[2] as string });
  }
  return rows;
}

if (require.main === module) {
  for (const d of bodyDigestsOnDisk()) process.stdout.write(`${d.signature}\t${d.sha256}\t${d.length}\n`);
}
