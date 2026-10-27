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
 * ── WHAT THIS INSTRUMENT IS, AND WHAT IT IS NOT (`TL-P4-COORD-R55` ordered
 *    item 5, F13-5) ──────────────────────────────────────────────────────
 *
 * IT IS A REGEX OVER SQL TEXT, WHICH IS THE INSTRUMENT CLASS THIS ESTATE HAS
 * RULED AGAINST THREE TIMES (`TL-P4-COORD-R46`, `R50` §5, `R55` §6). The
 * previous version was line-anchored, case-sensitive and single-space, and
 * EIGHT valid SQL spellings of an installed routine were invisible to it:
 * indented by two spaces, `create function` lowercase, `Create Function`
 * mixed case, a newline between `FUNCTION` and the name, two spaces after
 * `REPLACE`, `CREATE PROCEDURE`, an uppercase-initial routine name, and a
 * `CREATE FUNCTION` issued from a dynamic `EXECUTE`. A seventh routine in any
 * of those spellings installed with the entire end-state block reporting OK.
 *
 * SO THE COMPLETENESS LAW IS NOW A CATALOGUE LAW AND THIS IS ITS BELT. The
 * law that decides the question is in
 * `tests/integration/phase4-s7-installment-aging-db.test.ts`: it reads the set
 * of routines in schema `public` BEFORE the specification is applied and
 * AFTER, and requires the DIFFERENCE to be exactly the pinned set. That is
 * catalogue DATA about what the file really installed; it is blind to no
 * spelling, including a dynamic `EXECUTE`, because it never reads the text at
 * all.
 *
 * This function is kept because the digest EXTRACTOR needs the file's own
 * heads to slice bodies from, and it is widened to the spellings above so
 * that it is not quietly weaker than its own comment: case-insensitive,
 * leading whitespace allowed, `FUNCTION` or `PROCEDURE`, any whitespace
 * (newline included) between the keyword and the name, and any
 * case of the name. It remains ANCHORED at a line start, which is what keeps
 * the subject DDL rather than prose — this file's own header discusses
 * `CREATE OR REPLACE FUNCTION` inside a box-drawing comment, and an
 * unanchored match would count it as a seventh routine. WHAT IT STILL CANNOT
 * SEE IS DECLARED AND NOT CERTIFIED ABSENT: a routine created from a dynamic
 * `EXECUTE`, or from inside a dollar-quoted body, is text no pattern over this
 * file can recognise as DDL. The catalogue law above is what covers it.
 */
export function routineHeads(spec: string): readonly string[] {
  return [...spec.matchAll(/^[ \t]*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gim)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
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

// ═══════════════════════════════════════════════════════════════════════════
// DR-13 / DR-21 — THE AGING FALLBACK LAW, ON THE BODY ITSELF
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS LAW IS, AND WHAT IT IS NOT. The digests above establish that the
// INSTALLED body is the body that was reviewed; they say nothing about what
// the body does, and a digest cannot: it changes for a comma. So a body that
// ages a termless receivable at no date at all is a body this module would
// have happily pinned — and that is exactly what happened. The specification
// replaced `customer_ar_aging` under the SAME signature `0084:705` creates,
// derived its bucket date from `due_date` ALONE, and guarded the band
// arithmetic with `bucket_date IS NOT NULL AND …`, which the owner's DR-13
// had already retired from `0084:727`. A receivable with no stated term
// exceeded NO threshold however old it got and sat in the first band for
// ever: debt leaving an aging report BY OMISSION rather than by payment.
//
// THIS IS A TEXT LAW AND THE ESTATE HAS RULED THREE TIMES THAT A TEXT LAW
// CANNOT ESTABLISH A PROPERTY OF CODE (`TL-P4-COORD-R46`, `R50` §5, `R55` §6).
// So the claim is narrow and stated rather than implied:
//
//   * it DETECTS the retired guard, in the one spelling family that produced
//     the defect, on COMMENT-STRIPPED text — so a sentence describing the
//     retired guard (which `0084:717` and this file both carry, deliberately)
//     cannot trip it, and cannot satisfy it either;
//   * it REQUIRES the `coalesce(…due_date, …issue_date)` resolution to be
//     present in code;
//   * it DOES NOT establish that the body is correct. Nothing read off text
//     can. The behavioural proofs are
//     `packages/domain-core/test/phase4-s7-installment-aging.test.ts`
//     (`proof_13`, which plants the withdrawal of the fallback through a
//     policy knob and requires the band to go wrong) and the live arms of
//     `tests/integration/phase4-s7-installment-aging-live.test.ts`.
//
// It is applied to BOTH bodies on purpose: the specification's, and the
// APPROVED body `0084` ships. A law that passes on the file it was written
// for and was never asked about the body of record is a law with one data
// point.

/** A violation of the DR-13 / DR-21 aging-fallback law, named. */
export interface Dr13Finding {
  /** Which body was judged, e.g. `p4s7 specification` or `0084`. */
  readonly where: string;
  readonly kind: 'retired_null_guard' | 'fallback_absent' | 'boundary_not_strict';
  readonly detail: string;
}

/**
 * Comments and single-quoted literals blanked, offsets preserved. The subject
 * of a code law is CODE: `0084:717` carries the retired guard inside a
 * sentence that explains why it was retired, and a law that could not tell
 * the two apart would have to choose between a false red on the body of
 * record and a false green on the defect.
 *
 * The input is the DOLLAR-QUOTED BODY, so there is no nested `$…$` to track.
 */
export function sqlCodeOnlyBody(body: string): string {
  const out = body.split('');
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < body.length) {
    if (body.slice(i, i + 2) === '--') {
      const j = body.indexOf('\n', i);
      const end = j === -1 ? body.length : j;
      blank(i, end);
      i = end;
      continue;
    }
    if (body.slice(i, i + 2) === '/*') {
      const j = body.indexOf('*/', i + 2);
      const end = j === -1 ? body.length : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (body[i] === "'") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "'" && body[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (body[j] === "'") break;
        j += 1;
      }
      blank(i, Math.min(j + 1, body.length));
      i = Math.min(j + 1, body.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * THE RETIRED GUARD, in the spelling family that shipped it. `due_date` and
 * `bucket_date` are the two names the aging bodies have used for the date the
 * band arithmetic subtracts, with or without a table alias, and with any
 * whitespace: a guard on either one is the defect, because a NULL that the
 * guard excludes from the threshold count IS a receivable placed in band 1.
 */
const RETIRED_NULL_GUARD = /\b(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?(?:bucket_date|due_date)\s+IS\s+NOT\s+NULL/i;

/** The DR-13 resolution, in code: `coalesce(<alias>.due_date, <alias>.issue_date)`. */
const DR13_FALLBACK = /coalesce\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?due_date\s*,\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?issue_date\s*\)/i;

/** The strict boundary the bands are defined by: `(p_as_of - <date>) > t.threshold`. */
const STRICT_BOUNDARY = /\(\s*p_as_of\s*-\s*[\s\S]{1,160}?\)\s*>\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?threshold/i;

/**
 * The DR-13 / DR-21 findings against ONE aging body. Empty means the law
 * found nothing to refuse — never that the body is correct.
 */
export function dr13AgingFindings(body: string, where: string): readonly Dr13Finding[] {
  const code = sqlCodeOnlyBody(body);
  const findings: Dr13Finding[] = [];
  const guard = RETIRED_NULL_GUARD.exec(code);
  if (guard !== null)
    findings.push({
      where,
      kind: 'retired_null_guard',
      detail:
        `${where}: the band arithmetic is guarded by ${JSON.stringify(guard[0].replace(/\s+/g, ' '))}, which DR-13 retired. ` +
        `A NULL bucket date the guard excludes exceeds no threshold, counts zero of them and places the WHOLE figure in band 1 — ` +
        `not-due since DR-10 — however old the receivable gets. That is a receivable leaving the aging report by OMISSION rather than by payment.`,
    });
  if (!DR13_FALLBACK.test(code))
    findings.push({
      where,
      kind: 'fallback_absent',
      detail:
        `${where}: no \`coalesce(…due_date, …issue_date)\` in the body's CODE. DR-13 and DR-21 require every amount with no stated ` +
        `term — the whole invoice, and the residual an installment schedule does not declare — to age from the document's own issue date. ` +
        `\`invoices.issue_date\` is NOT NULL and \`invoices_due_date_ck\` enforces \`due_date >= issue_date\`, so the substitution is TOTAL ` +
        `and its direction is SIGNED: it can only ever make a receivable MORE overdue, never less.`,
    });
  if (!STRICT_BOUNDARY.test(code))
    findings.push({
      where,
      kind: 'boundary_not_strict',
      detail:
        `${where}: the threshold comparison \`(p_as_of - <bucket date>) > t.threshold\` is not in the body's CODE. The boundary is STRICT ` +
        `by decision (DR-10): a receivable exactly \`t\` days overdue stays in the younger band, and a zero threshold therefore separates ` +
        `at the due date itself. A law that cannot find the comparison cannot say which way it points.`,
    });
  return findings;
}

/** Throws when `body` violates the DR-13 / DR-21 aging-fallback law. */
export function assertDr13AgingFallback(body: string, where: string): void {
  const findings = dr13AgingFindings(body, where);
  if (findings.length > 0)
    throw new Error(`p4s7-body-digests: DR-13/DR-21 aging-fallback law REFUSES this body\n  - ${findings.map((f) => f.detail).join('\n  - ')}`);
}

/**
 * The APPROVED aging body: the one `0084` creates, sliced out of the
 * migration by the same dollar-quote rule the specification's bodies use.
 * This is the body of record DR-13 was decided against, and the law above is
 * asked about it on every run so that it has a positive control and not only
 * a subject.
 */
export const P4S4_SHIPPED_AGING_PATH = join(
  __dirname,
  '..',
  '..',
  'infrastructure',
  'database',
  'migrations',
  '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql',
);

/** `0084`'s own `customer_ar_aging` body, as shipped. */
export function shippedAgingBody(): string {
  return dollarQuotedBody(
    readFileSync(P4S4_SHIPPED_AGING_PATH, 'utf8'),
    'CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])',
  );
}

/** The specification's `customer_ar_aging` body, as this file ships it. */
export function specAgingBody(): string {
  return dollarQuotedBody(
    readFileSync(P4S7_SPEC_PATH, 'utf8'),
    'CREATE OR REPLACE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])',
  );
}

/**
 * THE PLANTED DEFECT, as a function of a body, so the red proof runs against
 * the REAL text rather than a lookalike. It puts the retired guard back in
 * front of whichever bucket-date expression the body uses — the
 * specification's `c.bucket_date`, or `0084`'s resolved
 * `coalesce(o.due_date, o.issue_date)` — and returns the body UNCHANGED when
 * it recognises neither, so a caller can tell «the law is blind» from «the
 * plant did not apply».
 */
export function plantRetiredNullGuard(body: string): string {
  const specForm = '(p_as_of - c.bucket_date)';
  if (body.includes(specForm)) return body.replace(specForm, '(c.bucket_date IS NOT NULL AND (p_as_of - c.bucket_date)');
  const shippedForm = '(p_as_of - coalesce(o.due_date, o.issue_date))';
  if (body.includes(shippedForm)) return body.replace(shippedForm, '(o.due_date IS NOT NULL AND (p_as_of - o.due_date)');
  return body;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--dr13')) {
    // BOTH DIRECTIONS IN ONE RUN, because a law asserted in only the green
    // direction is a law nobody has seen refuse.
    const subjects: readonly { readonly where: string; readonly body: string }[] = [
      { where: 'p4s7-specification-customer_ar_aging', body: specAgingBody() },
      { where: '0084-APPROVED-customer_ar_aging', body: shippedAgingBody() },
    ];
    let bad = 0;
    for (const subject of subjects) {
      const findings = dr13AgingFindings(subject.body, subject.where);
      process.stdout.write(`GREEN\t${subject.where}\t${findings.length === 0 ? 'no finding' : findings.map((f) => f.kind).join(',')}\n`);
      for (const f of findings) process.stdout.write(`  ${f.detail}\n`);
      if (findings.length > 0) bad += 1;
      // THE PLANTED DEFECT: the retired guard put back, on the real body, and
      // the law must name it. A law asserted only in the green direction is a
      // law nobody has watched refuse anything.
      const planted = plantRetiredNullGuard(subject.body);
      const red = dr13AgingFindings(planted, `${subject.where}-WITH-THE-RETIRED-GUARD-PLANTED`);
      const caught = planted !== subject.body && red.some((f) => f.kind === 'retired_null_guard');
      process.stdout.write(
        `RED\t${subject.where}\t${caught ? 'the retired guard was caught by name' : 'NOT CAUGHT - the plant did not apply, or the law is blind'}\n`,
      );
      if (!caught) bad += 1;
    }
    process.stdout.write(`${bad === 0 ? 'P4S7 DR-13 BODY LAW: PASS' : `P4S7 DR-13 BODY LAW: FAIL (${bad})`}\n`);
    process.exit(bad === 0 ? 0 : 1);
  }
  for (const d of bodyDigestsOnDisk()) process.stdout.write(`${d.signature}\t${d.sha256}\t${d.length}\n`);
}
