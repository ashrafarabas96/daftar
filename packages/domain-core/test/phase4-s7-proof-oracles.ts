/**
 * P4-S7 — THE PROOF MACHINERY: INDEPENDENT ORACLES, A SEMANTIC SQL READER,
 * THE EXACT SCHEDULE INVARIANT, AND THE AUDITOR THAT PROVES THE PROOFS.
 *
 * WHAT THIS FILE IS. It is the machine that claims the product is correct. It
 * is NOT a second copy of the aging algorithm, and it is not the aging
 * algorithm's derivation: that is `phase4-s7-aging-reference-model.ts` and it
 * belongs to the S7 implementation owner. Nothing here is exported from
 * `packages/domain-core/src/index.ts`, nothing here is reachable from product
 * code, and nothing here is imported by anything but
 * `phase4-s7-proof-authority.test.ts`.
 *
 * THE FOUR THINGS IT EXISTS TO FIX, each measured on the shipped tree before
 * it was written:
 *
 *  1. LAW 2 WAS TRUE BY CONSTRUCTION IN ITS BUCKET ARITHMETIC. The law
 *     `contribution.bucketNo === bucketOf(asOf, declaredDate, thresholds)`
 *     derives its EXPECTED value by calling `bucketOf` — the same function
 *     `projectInvoice` calls to produce `bucketNo`. The subject was correctly
 *     moved off the projection's own output and onto the plan's declared date
 *     (that repaired challenger H-3), but the BAND ARITHMETIC is still
 *     `f(x) === f(x)`: any defect inside `bucketOf` moves both sides together
 *     and the law is mathematically unable to refuse. `bucketIndexByBand`
 *     below is a second implementation of the same law, written from the law's
 *     own definition — the aging BANDS the merchant is shown — by interval
 *     containment instead of by threshold counting, over a day count computed
 *     from the civil calendar instead of from `Date.UTC`. It shares no
 *     algorithmic path with the implementation under test.
 *
 *  2. `meta_1` HELD A TEXTUAL RELATIONSHIP TO THE PROOFS, NOT A STRUCTURAL
 *     ONE. `expect(SELF).toContain("mutate('carryResidual'")` is satisfied by
 *     that text appearing anywhere in the file, comments included; it cannot
 *     see a proof skipped, a proof body replaced by an unconditional pass, or
 *     a proof deleted while its name survives in prose. And proofs 6, 7, 8 and
 *     9 were outside the registry altogether, so deleting one of them left
 *     every meta test green. `auditProofFile` parses the file structurally and
 *     `PROOF_LEDGER` gives the proofs a runtime data flow into the verdict.
 *
 *  3. THE REDUCER DETECTOR WAS LEXICAL. `/\bpublic\.([a-z_]\w*)/` is
 *     alias-independent — that repaired challenger H-5 — but it sees only a
 *     `public.`-QUALIFIED reference, in a body with its comments and string
 *     literals still in it. An UNQUALIFIED `FROM installment_collections`,
 *     which is the ordinary PostgreSQL form under a `search_path`, is
 *     invisible to it; a relation named in a comment or inside a quoted string
 *     is a false positive. `relationReferences` is a tokenizing reader of
 *     actual relation-reference positions (FROM / JOIN / INTO / UPDATE /
 *     USING / MERGE), CTE-aware and alias-excluding, over a body whose
 *     comments, quoted literals and dollar bodies have been removed; and the
 *     watched set comes from `canonicalReducerRegistry`, derived from column
 *     declarations by the estate's own `findColumnDeclarations` with EXACT
 *     column equality rather than a substring.
 *
 *  4. THE SCHEDULE INVARIANT WAS PROVED IN ONE DIRECTION. `down_payment +
 *     SUM(installments) = invoice total` is EXACT: not `<=`, not `>=`. The
 *     specification states it in prose and defers its body to promotion, so
 *     nothing executable said no in either direction.
 *     `scheduleInvariantVerdict` is the executable statement of it, and
 *     `ONE_SIDED_INVARIANTS` are the one-directional mutants that let the
 *     challenger's counterexample through.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. The carrying-base basis for
 * `paid_base`, the SUPPLIED `asOf` as the only time source, and installments
 * as a SCHEDULE over existing AR rather than a ledger. Those are correct and
 * are relied on here, never re-litigated. No clock is read anywhere in this
 * file.
 *
 * CITATIONS. `0083` is HISTORICAL INPUT; `0084` is the LIVE predecessor
 * contract, because `0084:488` DROPs `public.invoice_outstanding(UUID,
 * UUID[])` and `0084:593` recreates it. `lastEffectiveRoutineDefinition` is
 * the modest mechanism that proves which body the database will hold, so no
 * claim here reads a routine out of a migration a later migration superseded.
 */
import { readFileSync } from 'node:fs';
import {
  QUALIFIED_NAME,
  findColumnDeclarations,
  findColumnRenames,
  findTableRenames,
  stripComments,
  stripNonSchema,
  unquote,
} from '../../../scripts/guards/sql-schema';
import { agingBucketLabels } from '../src/invoice';
import type { InstallmentPlan } from './phase4-s7-aging-reference-model';

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — THE INDEPENDENT ORACLE FOR LAW 2 (the aging band of a date)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A civil day number computed from the CIVIL CALENDAR, not from `Date`.
 *
 * The implementation under test reaches its day number through
 * `Date.UTC(y, m - 1, d) / 86_400_000`. An oracle that did the same would
 * share that path, so this is the days-from-civil algorithm: shift the year
 * to start in March so the leap day falls at the end of the cycle, then count
 * 400-year, 100-year and 4-year eras exactly in integers. No `Date` object,
 * no milliseconds and no rounding.
 */
export function civilDay(civil: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (m === null) throw new Error(`not a civil date: ${civil}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`not a civil date: ${civil}`);
  const yAdj = y - (mo <= 2 ? 1 : 0);
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400; // 0..399
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1; // 0..365
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // 0..146096
  return era * 146_097 + doe - 719_468;
}

/** One aging band, as a CLOSED interval of whole overdue days. */
export interface AgingBand {
  readonly bucketNo: number;
  readonly label: string;
  readonly loDays: number;
  /** `Number.POSITIVE_INFINITY` for the open top band. */
  readonly hiDays: number;
}

/**
 * THE BANDS, DERIVED FROM THE SHIPPED LABEL CONTRACT.
 *
 * `agingBucketLabels` is product code in `packages/domain-core/src/invoice.ts`
 * and is what the merchant is shown: `[30, 60, 90]` yields
 * `['0-30', '31-60', '61-90', 'over-90']`. This function PARSES those labels
 * back into intervals, so the band table is read off the contract the product
 * publishes rather than reconstructed from the same counting expression the
 * routine uses. A label the parser cannot read is a refusal, not a guess.
 *
 * It is also the executable tie between this oracle and the product: the
 * oracle imports `agingBucketLabels`, so the ownership is a call and not a
 * comment, and a change to the labels changes the oracle.
 */
export function agingBands(thresholds: readonly number[]): readonly AgingBand[] {
  if (thresholds.length === 0) throw new Error('no aging thresholds');
  for (let i = 1; i < thresholds.length; i += 1) {
    if ((thresholds[i] as number) <= (thresholds[i - 1] as number)) {
      throw new Error(`aging thresholds are not strictly ascending: ${thresholds.join(',')}`);
    }
  }
  const labels = agingBucketLabels(thresholds);
  const bands: AgingBand[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i] as string;
    const over = /^over-(\d+)$/.exec(label);
    if (over !== null) {
      bands.push({
        bucketNo: i + 1,
        label,
        loDays: Number(over[1]) + 1,
        hiDays: Number.POSITIVE_INFINITY,
      });
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(label);
    if (range === null) throw new Error(`unreadable aging label: ${label}`);
    bands.push({ bucketNo: i + 1, label, loDays: Number(range[1]), hiDays: Number(range[2]) });
  }
  // The bands must tile 0..infinity with no gap and no overlap, or the oracle
  // is not a function. Asserted here so a label change cannot silently make
  // the oracle partial.
  if ((bands[0] as AgingBand).loDays !== 0) throw new Error('the first aging band does not start at 0');
  for (let i = 1; i < bands.length; i += 1) {
    if ((bands[i] as AgingBand).loDays !== (bands[i - 1] as AgingBand).hiDays + 1) {
      throw new Error(`aging bands do not tile at band ${i + 1}`);
    }
  }
  if ((bands[bands.length - 1] as AgingBand).hiDays !== Number.POSITIVE_INFINITY) {
    throw new Error('the top aging band is not open');
  }
  return Object.freeze(bands);
}

/**
 * THE INDEPENDENT ORACLE. The bucket a civil date belongs to at a SUPPLIED
 * `asOf`, derived by INTERVAL CONTAINMENT over the band table.
 *
 * The law, in its own words: a receivable is reported in the band whose day
 * range contains how long it has been overdue, and money that is not yet due
 * is reported in the first band. This function says exactly that and nothing
 * else. It performs no threshold comparison loop, counts nothing, and never
 * calls the implementation under test.
 *
 * `asOf` is the caller's. No clock is read.
 */
export function bucketIndexByBand(asOf: string, date: string | null, thresholds: readonly number[]): number {
  const bands = agingBands(thresholds);
  // A NULL schedule date is money no date governs; the shipped routine's
  // `due_date IS NOT NULL AND ...` puts it in the first band, and the law
  // says the same: nothing about it is overdue.
  if (date === null) return (bands[0] as AgingBand).bucketNo;
  const overdue = civilDay(asOf) - civilDay(date);
  // Not yet due is not negatively overdue; it is not overdue, so it is the
  // first band. This is the law's own reading, and it is why the band table
  // starts at 0 rather than at minus infinity.
  const aged = overdue < 0 ? 0 : overdue;
  const found = bands.find((b) => aged >= b.loDays && aged <= b.hiDays);
  if (found === undefined) throw new Error(`no aging band contains ${aged} days`);
  return found.bucketNo;
}

/**
 * A THIRD derivation, by binary search, used only to calibrate the oracle
 * against itself. Two independent derivations that agree are evidence the
 * oracle is right; one is an assertion.
 */
export function bucketIndexByBinarySearch(asOf: string, date: string | null, thresholds: readonly number[]): number {
  if (date === null) return 1;
  const aged = Math.max(0, civilDay(asOf) - civilDay(date));
  let lo = 0;
  let hi = thresholds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (aged <= (thresholds[mid] as number)) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

/**
 * THE IMPLEMENTATION'S OWN EXPRESSION, TRANSCRIBED, so that a mutation of it
 * is a mutation of live behaviour rather than of a lookalike.
 *
 * This is `0084:708-710` and the reference model's `bucketOf`:
 * `1 + count(t in thresholds where (as_of - date) > t)`. The transcription is
 * proved FAITHFUL against the live imported `bucketOf` by exhaustive sweep in
 * the test, which is what gives the mutants below their authority: a mutant
 * of a transcription proved equal to live code is a mutant of live code.
 */
export function bucketOfAsShipped(asOf: string, date: string | null, thresholds: readonly number[]): number {
  if (date === null) return 1;
  const overdueDays = civilDay(asOf) - civilDay(date);
  return 1 + thresholds.filter((t) => overdueDays > t).length;
}

export type BucketFn = (asOf: string, date: string | null, thresholds: readonly number[]) => number;

/**
 * THE PLANTED MUTATIONS OF LAW 2.
 *
 * Each one breaks the law while leaving the surrounding structure entirely
 * valid: the function still returns an integer in `1..n+1`, the projection
 * still totals the authoritative outstanding, every contribution still
 * reports a schedule date, and the output stays self-consistent. These are
 * the defects an oracle that calls `bucketOf` cannot refuse.
 */
export const BUCKET_MUTANTS: readonly { readonly name: string; readonly fn: BucketFn }[] = Object.freeze([
  Object.freeze({
    // `>` becomes `>=`: every receivable exactly on a band boundary is
    // reported one band too old. 30 days overdue leaves '0-30'.
    name: 'boundary_inclusive',
    fn: ((asOf, date, ts) => {
      if (date === null) return 1;
      const d = civilDay(asOf) - civilDay(date);
      return 1 + ts.filter((t) => d >= t).length;
    }) as BucketFn,
  }),
  Object.freeze({
    // The band index is zero-based: every receivable is reported one band too
    // young, and the oldest band is never reported at all.
    name: 'zero_based_index',
    fn: ((asOf, date, ts) => {
      if (date === null) return 1;
      const d = civilDay(asOf) - civilDay(date);
      return Math.max(1, ts.filter((t) => d > t).length);
    }) as BucketFn,
  }),
  Object.freeze({
    // The sign is reversed: a date in the future ages, and an overdue date
    // reports as current. The challenger's shape, reached arithmetically.
    name: 'reversed_sign',
    fn: ((asOf, date, ts) => {
      if (date === null) return 1;
      const d = civilDay(date) - civilDay(asOf);
      return 1 + ts.filter((t) => d > t).length;
    }) as BucketFn,
  }),
  Object.freeze({
    // Only the FIRST threshold is consulted, so '31-60' and '61-90' collapse
    // into one band and everything over 30 days reports as band 2.
    name: 'first_threshold_only',
    fn: ((asOf, date, ts) => {
      if (date === null) return 1;
      const d = civilDay(asOf) - civilDay(date);
      return d > (ts[0] as number) ? 2 : 1;
    }) as BucketFn,
  }),
  Object.freeze({
    // Off by one day: a day is subtracted from the age before banding, so
    // every boundary moves and nothing else does.
    name: 'off_by_one_day',
    fn: ((asOf, date, ts) => {
      if (date === null) return 1;
      const d = civilDay(asOf) - civilDay(date) - 1;
      return 1 + ts.filter((t) => d > t).length;
    }) as BucketFn,
  }),
]);

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — THE SEMANTIC SQL RELATION READER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A routine body with everything that is not SQL removed: line comments,
 * block comments, single-quoted literals (doubled quotes handled), quoted
 * identifiers PRESERVED, and nested dollar-quoted bodies collapsed.
 *
 * The estate's `stripNonSchema` blanks a dollar body, which is right for
 * schema laws and wrong here: the dollar body IS the subject. So the comment
 * pass is the estate's `stripComments` and only the literal pass is local,
 * and the literal pass is red-proved in the test.
 */
export function stripSqlNoise(sql: string): string {
  const noComments = stripComments(sql);
  let out = '';
  let i = 0;
  while (i < noComments.length) {
    const ch = noComments[i] as string;
    if (ch === "'") {
      let j = i + 1;
      while (j < noComments.length) {
        if (noComments[j] === "'" && noComments[j + 1] === "'") j += 2;
        else if (noComments[j] === "'") break;
        else j += 1;
      }
      out += " '' ";
      i = j + 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(noComments.slice(i));
    if (dollar !== null) {
      const tag = dollar[0];
      const end = noComments.indexOf(tag, i + tag.length);
      out += ' ';
      i = end === -1 ? noComments.length : end + tag.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The keywords that may introduce a relation reference in a FROM-like position. */
const RELATION_INTRODUCERS: readonly RegExp[] = Object.freeze([
  /\bFROM\s+/gi,
  /\bJOIN\s+/gi,
  /\bINSERT\s+INTO\s+/gi,
  /\bUPDATE\s+/gi,
  /\bMERGE\s+INTO\s+/gi,
  /\bUSING\s+/gi,
  /\bDELETE\s+FROM\s+/gi,
]);

/**
 * Words that may follow an introducer and are NOT a relation: a derived table,
 * a row constructor, a function-call table source, or the `ONLY`/`LATERAL`
 * decorations.
 */
const NOT_A_RELATION =
  /^(ONLY|LATERAL|RECURSIVE|SELECT|VALUES|UNNEST|ROWS|GENERATE_SERIES|JSONB?_[A-Z_]+|ON|AND|OR|NOT|WHERE|SET|DISTINCT|CASCADE|RESTRICT|NO|SKIP|NOWAIT|SHARE|KEY|BTREE|GIN|GIST|SPGIST|BRIN|HASH|INDEX|COLUMNS?|ERRCODE|MESSAGE|DETAIL|HINT|CONSTRAINT|DATATYPE|TABLE|SCHEMA)$/i;

/** Every CTE name a statement defines, so a reference to one is not a relation. */
export function cteNames(sql: string): ReadonlySet<string> {
  const out = new Set<string>();
  // `WITH [RECURSIVE] a AS (...) , b AS (...)` — and a CTE name is also
  // introduced after each top-level comma that closes a previous CTE body.
  const re = new RegExp(String.raw`(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)("[^"]+"|[A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?AS\s*(?:MATERIALIZED\s+|NOT\s+MATERIALIZED\s+)?\(`, 'gi');
  for (const m of sql.matchAll(re)) out.add(unquote(m[1] ?? ''));
  return out;
}

export interface RelationReference {
  /** The relation, unquoted and lower-cased. */
  readonly relation: string;
  /** The schema as written, unquoted and lower-cased; `null` when unqualified. */
  readonly schema: string | null;
  /** The keyword that introduced it, upper-cased. */
  readonly via: string;
  /** Character offset in the cleaned text, for a finding that can be located. */
  readonly at: number;
}

/**
 * EVERY RELATION A PIECE OF SQL ACTUALLY READS OR WRITES, found by POSITION
 * and not by spelling.
 *
 * It sees, alike and proved so by the mutation matrix in the test:
 *   — a one-character alias, a multi-character alias, an `AS` alias, no alias;
 *   — a schema-qualified reference, an unqualified reference, a quoted
 *     identifier, and `"public" . "t"` with space around the dot;
 *   — any whitespace, any line breaks, any case;
 *   — a reference inside a CTE body, a subquery, a `UNION ALL` branch or a
 *     lateral join.
 *
 * It does NOT see, and is proved not to see:
 *   — a relation named in a comment;
 *   — a relation named inside a quoted string literal;
 *   — a CTE's own name where the CTE is referenced;
 *   — an alias, in any position;
 *   — a column, a parameter or a variable whose name contains a relation's;
 *   — a similarly-named relation (matching is on the whole identifier).
 *
 * Aliases are excluded STRUCTURALLY: a relation reference is the identifier
 * immediately after an introducer, and whatever follows it is an alias and is
 * never itself treated as a relation, because only post-introducer positions
 * are ever read.
 */
export function relationReferences(sql: string): readonly RelationReference[] {
  const clean = stripSqlNoise(sql);
  const ctes = cteNames(clean);
  const name = new RegExp(String.raw`^(?:("[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?("[^"]+"|[A-Za-z_][\w$]*)`);
  const out: RelationReference[] = [];
  for (const intro of RELATION_INTRODUCERS) {
    const re = new RegExp(intro.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const rest = clean.slice(re.lastIndex);
      // `FROM (` is a derived table; `USING (` is a join column list.
      if (/^\(/.test(rest)) continue;
      const n = name.exec(rest);
      if (n === null) continue;
      const bare = unquote(n[2] ?? '');
      if (NOT_A_RELATION.test(bare)) continue;
      // A function-call table source — `FROM f(x)` — is not a relation.
      if (/^\s*\(/.test(rest.slice(n[0].length))) continue;
      if (n[1] === undefined && ctes.has(bare)) continue;
      out.push({
        relation: bare,
        schema: n[1] === undefined ? null : unquote(n[1]),
        via: (m[0] ?? '').trim().toUpperCase().replace(/\s+/g, ' '),
        at: re.lastIndex,
      });
    }
  }
  return Object.freeze(out.sort((a, b) => a.at - b.at));
}

/** The distinct relation names a piece of SQL reads or writes, sorted. */
export function relationsTouched(sql: string): readonly string[] {
  return Object.freeze([...new Set(relationReferences(sql).map((r) => r.relation))].sort());
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — THE CANONICAL REDUCER REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHAT MAKES A RELATION AN INVOICE REDUCER, canonically: it declares a column
 * named EXACTLY `invoice_amount_applied_minor`. That is the column the one
 * definition of the settlement sum sums, and it is the structural answer to
 * seam `S-P4-03`.
 *
 * EXACT equality, not a substring. A substring test accepts
 * `bill_invoice_amount_applied_minor` and
 * `invoice_amount_applied_minor_cents`, which would make an unrelated
 * relation a reducer and put the supplier side inside a customer-side law.
 */
export const INVOICE_REDUCER_COLUMN = 'invoice_amount_applied_minor';

/**
 * The SUPPLIER-side reducer column (`0067:375`, `0067:424`). It is named here
 * so the precision arm can assert the detector does not confuse the two
 * sides, and so a reader can see the discrimination is deliberate.
 */
export const PURCHASE_REDUCER_COLUMN = 'purchase_amount_applied_minor';

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Load the migration tree in apply order. READ-ONLY: nothing here writes it. */
export function loadMigrations(dir: string, files: readonly string[]): readonly MigrationFile[] {
  return Object.freeze(
    [...files]
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => Object.freeze({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })),
  );
}

/**
 * Every relation in the tree that declares the invoice reducer column,
 * discovered through the estate's own `findColumnDeclarations` — so the
 * ownership is an executable import of the estate's schema reader, not a
 * local regex and not a name list.
 *
 * `DROP TABLE` is honoured, so a relation created and later dropped is not in
 * the registry: that is the same "last effective definition" discipline the
 * routine mechanism below applies, at the relation grain.
 */
export function canonicalReducerRegistry(migrations: readonly MigrationFile[]): readonly string[] {
  const live = new Set<string>();
  for (const m of migrations) {
    // (1) DECLARED — `CREATE TABLE` and `ALTER TABLE … ADD COLUMN`, both of
    //     which `findColumnDeclarations` already reads.
    for (const c of findColumnDeclarations(m.sql)) {
      if (c.column === INVOICE_REDUCER_COLUMN) live.add(c.table);
    }
    // (2) RENAMED INTO or OUT OF the reducer column. INTO is a RECALL gap —
    //     the relation never entered the registry — and OUT OF is a
    //     PRECISION gap — it stayed in it. Both use the estate's own
    //     `findColumnRenames`, which already refuses `RENAME CONSTRAINT`.
    for (const r of findColumnRenames(m.sql)) {
      if (r.to === INVOICE_REDUCER_COLUMN) live.add(r.table);
      else if (r.from === INVOICE_REDUCER_COLUMN) live.delete(r.table);
    }
    // (3) DROPPED COLUMN — a PRECISION gap, and the one statement shape the
    //     estate's schema reader has no function for, so the scan is here.
    for (const d of alterDropColumns(m.sql)) {
      if (d.column === INVOICE_REDUCER_COLUMN) live.delete(d.table);
    }
    // (4) RENAMED RELATION — a RECALL gap: the registry would hold a name no
    //     `CREATE TABLE` ever wrote again. Membership is CARRIED ACROSS the
    //     rename rather than dropped, because the relation is the same
    //     relation and still declares the column.
    for (const t of findTableRenames(m.sql)) {
      if (live.delete(t.from)) live.add(t.to);
    }
    // (5) DROPPED RELATION — the original discipline, kept.
    const drop = new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED_NAME}`, 'gi');
    for (const d of m.sql.matchAll(drop)) live.delete(unquote(d[1] ?? ''));
  }
  return Object.freeze([...live].sort());
}

export interface DroppedColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Every `ALTER TABLE t DROP [COLUMN] c`, bare or quoted, with `IF EXISTS` and
 * a trailing `CASCADE`/`RESTRICT` tolerated. `DROP CONSTRAINT` is refused
 * explicitly: it is a different statement that happens to start with the same
 * word, which is the kind of near-miss this file exists to be careful about.
 *
 * It lives here rather than in `sql-schema.ts` because that file is the
 * estate's and not this slice's; promoting it is a patch request (PR-7), and
 * until then a local reader that says it is local is better than editing a
 * shared file this slice does not own.
 */
export function alterDropColumns(sql: string): readonly DroppedColumn[] {
  const out: DroppedColumn[] = [];
  const alter = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED_NAME}\s*\*?([\s\S]*?);`,
    'gi',
  );
  for (const m of stripNonSchema(sql).matchAll(alter)) {
    const table = unquote(m[1] ?? '');
    const actions = m[2] ?? '';
    const dropColumn = /DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi;
    for (const d of actions.matchAll(dropColumn)) {
      const name = unquote(d[1] ?? '');
      // `DROP CONSTRAINT x` would otherwise read as dropping a column called
      // `CONSTRAINT`. Same for the other things an ALTER can drop.
      if (/^(CONSTRAINT|DEFAULT|NOT|IDENTITY|EXPRESSION|GENERATED)$/i.test(name)) continue;
      out.push({ table, column: name });
    }
  }
  return Object.freeze(out);
}

/**
 * THE ORDERING LIMITATION, STATED RATHER THAN DISCOVERED.
 *
 * The five passes above run per FILE and not interleaved by POSITION inside
 * the file, so a migration that drops the column and re-adds it in that order
 * within one file is read as a declaration followed by a drop. The routine
 * mechanism in part 4 DOES interleave by position, because `0084` drops at
 * :488 and recreates at :593 and the order decides there. Here it does not
 * yet, and the honest claim is the weaker one: a file that both adds and
 * removes the reducer column is OUTSIDE what this registry establishes, and
 * no such file exists in the tree today.
 */

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — THE LAST EFFECTIVE ROUTINE DEFINITION IN THE MIGRATION PREFIX
// ═══════════════════════════════════════════════════════════════════════════

export interface RoutineDefinition {
  readonly migration: string;
  /** 1-based line of the `CREATE ... FUNCTION` header, for a citable reference. */
  readonly line: number;
  readonly body: string;
}

export interface RoutineHistory {
  /** The definition the database will hold, or `null` when the last act was a DROP. */
  readonly live: RoutineDefinition | null;
  /** Every earlier definition, oldest first. Each one is a SUPERSEDED REFERENCE. */
  readonly superseded: readonly RoutineDefinition[];
  /** Migrations that DROPped the signature, in order. */
  readonly dropped: readonly string[];
}

/**
 * THE MODEST MECHANISM. Walk the migration prefix in apply order and keep the
 * LAST surviving `CREATE [OR REPLACE] FUNCTION <header>`; a `DROP FUNCTION`
 * of that signature clears it.
 *
 * This exists because a claim that reads a routine's body out of a migration
 * a later migration superseded is reading a definition the database will not
 * hold. `0083:295` created `invoice_outstanding(UUID, UUID[])`; `0084:488`
 * DROPs that signature and `0084:593` recreates it. `0083`'s body is
 * therefore HISTORICAL INPUT and `0084`'s is the LIVE predecessor contract.
 *
 * It is a prefix scanner and not a parser: it finds headers by text, takes
 * the dollar-quoted body that opens after the header by matching the OPENING
 * TAG to its own closing tag (never the first `$$` that happens to appear
 * later in the file), and tracks DROPs. That is all a body claim needs.
 */
export function lastEffectiveRoutineDefinition(
  migrations: readonly MigrationFile[],
  header: string,
  dropPattern: RegExp,
): RoutineHistory {
  let live: RoutineDefinition | null = null;
  const superseded: RoutineDefinition[] = [];
  const dropped: string[] = [];
  for (const m of migrations) {
    // Interleave DROP and CREATE by POSITION inside the file, because `0084`
    // drops at :488 and recreates at :593 and the order is what decides.
    const acts: { at: number; kind: 'drop' | 'create' }[] = [];
    for (const d of m.sql.matchAll(new RegExp(dropPattern.source, `${dropPattern.flags.replace(/g/g, '')}g`))) {
      acts.push({ at: d.index ?? 0, kind: 'drop' });
    }
    let at = -1;
    for (;;) {
      at = m.sql.indexOf(header, at + 1);
      if (at === -1) break;
      acts.push({ at, kind: 'create' });
    }
    acts.sort((a, b) => a.at - b.at);
    for (const act of acts) {
      if (act.kind === 'drop') {
        if (live !== null) superseded.push(live);
        live = null;
        dropped.push(m.name);
        continue;
      }
      const tagMatch = /\$[A-Za-z_]*\$/.exec(m.sql.slice(act.at));
      if (tagMatch === null) continue;
      const tag = tagMatch[0] as string;
      const open = act.at + (tagMatch.index ?? 0);
      const close = m.sql.indexOf(tag, open + tag.length);
      if (close === -1) continue;
      if (live !== null) superseded.push(live);
      live = {
        migration: m.name,
        line: m.sql.slice(0, act.at).split('\n').length,
        body: m.sql.slice(open + tag.length, close),
      };
    }
  }
  return Object.freeze({ live, superseded: Object.freeze(superseded), dropped: Object.freeze(dropped) });
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 5 — THE EXACT SCHEDULE INVARIANT, IN BOTH DIRECTIONS
// ═══════════════════════════════════════════════════════════════════════════

export type InvariantVerdict = 'exact' | 'below' | 'above';

export interface InvariantFinding {
  readonly verdict: InvariantVerdict;
  /** `down + Σ installments − invoice total`. Negative below, positive above. */
  readonly excessTxnMinor: bigint;
}

/**
 * `down_payment + SUM(installments) = invoice total`, EXACTLY.
 *
 * Not `<=` and not `>=`. Both inequalities are satisfied by the exact case,
 * which is why a one-sided verifier looks correct on every well-formed
 * fixture and lets exactly one direction of pathology through. The missing
 * reverse bound is what let the challenger's counterexample reach the aging:
 * an OVER-scheduled plan produces no residual, satisfies every money law, and
 * reports a 265-day-overdue receivable as entirely not yet due.
 */
export function scheduleInvariantVerdict(plan: InstallmentPlan, invoiceTotalTxnMinor: bigint): InvariantFinding {
  const scheduled = plan.installments.reduce((a, i) => a + i.amountTxnMinor, 0n) + plan.downPaymentMinor;
  const excess = scheduled - invoiceTotalTxnMinor;
  return Object.freeze({
    verdict: excess === 0n ? 'exact' : excess < 0n ? 'below' : 'above',
    excessTxnMinor: excess,
  });
}

/** `true` when the schedule is accepted. The exact invariant accepts only equality. */
export function scheduleInvariantAccepts(plan: InstallmentPlan, invoiceTotalTxnMinor: bigint): boolean {
  return scheduleInvariantVerdict(plan, invoiceTotalTxnMinor).verdict === 'exact';
}

export type InvariantFn = (plan: InstallmentPlan, invoiceTotalTxnMinor: bigint) => boolean;

/**
 * THE ONE-DIRECTIONAL MUTANTS. Each is a verifier that states only half the
 * invariant. They are planted so the test can prove that the exact invariant
 * refuses a case a one-sided one accepts, in BOTH directions — which is the
 * reproducer for the defect, not a restatement of it.
 */
export const ONE_SIDED_INVARIANTS: readonly { readonly name: string; readonly fn: InvariantFn }[] = Object.freeze([
  Object.freeze({
    // `Σ <= total`: the UNDER-scheduled direction only. An over-scheduled
    // plan is accepted, and that is the challenger's counterexample.
    name: 'at_most_total',
    fn: ((plan, total) => scheduleInvariantVerdict(plan, total).excessTxnMinor <= 0n) as InvariantFn,
  }),
  Object.freeze({
    // `Σ >= total`: the OVER-scheduled direction only. An under-scheduled
    // plan is accepted, and the difference is silently carried as residual.
    name: 'at_least_total',
    fn: ((plan, total) => scheduleInvariantVerdict(plan, total).excessTxnMinor >= 0n) as InvariantFn,
  }),
]);

// ═══════════════════════════════════════════════════════════════════════════
// PART 6 — THE INDEPENDENT OVERDUE ORACLE (the challenger's counterexample)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * HOW MUCH OF THE SCHEDULE HAD FALLEN DUE AND IS STILL UNPAID at a SUPPLIED
 * `asOf`, derived from the PLAN'S DECLARED DATES and the AUTHORITATIVE `paid`
 * figure, by arithmetic the allocation does not perform.
 *
 * `max(0, D − paid)` where `D = Σ {amount : declared date <= asOf}` is a
 * prefix sum over the declared schedule and a single clamp. The allocation is
 * a suffix-sum clamp per row. The two share no code path and no intermediate.
 *
 * WHY IT IS EXACT, and therefore a law and not an approximation. Under the
 * declared oldest-scheduled-first policy with the schedule satisfying the
 * exact invariant (`T = total`, so `O = total − paid`), the allocation
 * telescopes, so the money landing on rows due at or before `asOf` is
 *
 *     min(O, T) − min(O, T − D) = (T − paid) − min(T − paid, T − D)
 *                              = max(0, D − paid).
 *
 * So this oracle is the law's own statement of the overdue portion, and the
 * projection must reproduce it. It is the measurement the challenger's
 * counterexample fails: there, the invariant is violated ABOVE, `T ≠ total`,
 * the telescoping identity no longer gives `max(0, D − paid)`, and the
 * projection reports zero overdue on a 265-day-overdue receivable.
 *
 * `asOf` is the caller's. No clock is read.
 */
export function unpaidDuePortion(plan: InstallmentPlan, asOf: string, paidTxnMinor: bigint): bigint {
  const asOfDay = civilDay(asOf);
  let due = 0n;
  if (civilDay(plan.downPaymentDueDate) <= asOfDay) due += plan.downPaymentMinor;
  for (const i of plan.installments) if (civilDay(i.dueDate) <= asOfDay) due += i.amountTxnMinor;
  const unpaid = due - paidTxnMinor;
  return unpaid < 0n ? 0n : unpaid;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 7 — THE PROOF LEDGER: A RUNTIME DATA FLOW FROM EACH PROOF TO THE GATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY A LEDGER AND NOT A STRING SEARCH. `expect(SELF).toContain("[proof_2]")`
 * is a textual relationship: the tag in a comment satisfies it, a skipped
 * proof satisfies it, and a proof whose body has been replaced by
 * `expect(true).toBe(true)` satisfies it. A ledger is a DATA FLOW. A proof
 * that does not RUN does not record, and the gate reads the record.
 *
 * `record` is called from inside each mandatory proof's mutation arm, AFTER
 * its assertions, so the entry exists only if the assertions passed. The gate
 * runs last in the file and requires an entry for every mandatory proof.
 */
const ledger = new Map<string, { readonly assertions: number; readonly detail: string }>();

export function recordProof(id: string, assertions: number, detail: string): void {
  ledger.set(id, Object.freeze({ assertions, detail }));
}

export function proofLedger(): ReadonlyMap<string, { readonly assertions: number; readonly detail: string }> {
  return ledger;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 8 — THE AUDITOR: A STRUCTURAL RELATIONSHIP FROM EACH PROOF TO THE GATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One mandatory proof, declared explicitly. This is the registry the meta
 * gate reads; it is NOT prose and it is NOT a comment. Every field is
 * consumed by `auditProofFile`.
 */
export interface MandatoryProof {
  /** The tag that must appear in a live `describe` title, e.g. `proof_2`. */
  readonly id: string;
  /**
   * A fragment that must appear in the title of the `it` inside that
   * `describe` which carries the "goes red under mutation" evidence. `null`
   * means the whole `describe` block is the arm.
   */
  readonly armTitleContains: string | null;
  /**
   * HOW MANY live arms matching `armTitleContains` the proof must carry.
   *
   * It is declared rather than counted, because a proof with three red arms
   * that loses one is a proof that lost a mutation — and an auditor which
   * only looked at the FIRST matching arm stayed green on exactly that,
   * measured. `1` for a single-armed proof; ignored when
   * `armTitleContains` is `null`.
   */
  readonly arms: number;
  /**
   * Text that must appear inside the arms' own bodies — a call site, never a
   * comment, because the auditor masks comments before looking. Required in
   * the UNION of the live arms, since a call site may legitimately belong to
   * one arm of several.
   */
  readonly requiresInArm: readonly string[];
  /** EACH arm must carry at least this many assertions. */
  readonly minAssertions: number;
  /** Which file the proof lives in, for the finding. */
  readonly file: string;
}

export type ProofFindingKind =
  | 'missing'
  | 'disabled'
  | 'arm_missing'
  | 'arm_disabled'
  | 'arm_count_short'
  | 'too_few_assertions'
  | 'call_site_missing'
  | 'unconditional_pass';

export interface ProofFinding {
  readonly proof: string;
  readonly kind: ProofFindingKind;
  readonly detail: string;
}

/**
 * MASK the source: every character that belongs to a comment or to a regular
 * expression literal becomes a space, and every `(` or `)` INSIDE a string or
 * template literal becomes a space. Offsets are PRESERVED one-for-one, so a
 * span found in the mask splices the raw source.
 *
 * WHY A MASK AND NOT A STRIP. Three things defeat a naive reader:
 *   — a tag or a call site written in PROSE. `expect(SELF).toContain("mutate('k'")`
 *     is satisfied by a comment, which is the shape the shipped `meta_1`
 *     could not refuse. Comments are masked, so prose reaches nothing.
 *   — a `describe` TITLE, which must survive, because the proof tag lives in
 *     it. String contents are kept; only the brackets a call scanner counts
 *     are neutralised inside them.
 *   — a REGEX LITERAL with unbalanced parentheses, such as
 *     `/Date\.now\(|new Date\(\)/`. A brace-matching reader that did not
 *     know about regexes would mis-span the enclosing block and then report a
 *     proof missing that is present — a FALSE RED, which is as bad as a false
 *     green. Regex literals are masked whole.
 */
export function maskSource(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const REGEX_MAY_FOLLOW = '(,=:[!&|?{};+-*%~^<>';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const j = src.indexOf('\n', i);
      const end = j === -1 ? src.length : j;
      blank(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      const j = src.indexOf('*/', i + 2);
      const end = j === -1 ? src.length : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_MAY_FOLLOW.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j] as string;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      let end = Math.min(j + 1, src.length);
      while (end < src.length && 'gimsuyd'.includes(src[end] as string)) end += 1;
      blank(i, end);
      i = end;
      prev = 'x';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      for (let k = i + 1; k < j && k < src.length; k += 1) {
        if (src[k] === '(' || src[k] === ')') out[k] = ' ';
      }
      i = j + 1;
      prev = 'x';
      continue;
    }
    prev = c;
    i += 1;
  }
  return out.join('');
}

/** The balanced `(...)` that opens at `open`, in MASKED source. */
function balancedCall(src: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

interface Block {
  readonly callee: string;
  readonly title: string;
  readonly body: string;
}

/** Every `describe`/`it` call in a cleaned source, with its title and its body. */
function blocksOf(src: string, kind: 'describe' | 'it'): readonly Block[] {
  const out: Block[] = [];
  const alt = kind === 'describe' ? 'xdescribe' : 'xit';
  const re = new RegExp(String.raw`\b(${kind}|${alt})((?:\.\w+)*)\s*\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const call = balancedCall(src, re.lastIndex - 1);
    if (call === null) continue;
    const title = /^\s*(['"`])([\s\S]*?)\1/.exec(call.body);
    out.push({
      callee: `${m[1] as string}${m[2] as string}`,
      title: title === null ? '' : (title[2] as string),
      body: call.body,
    });
  }
  return out;
}

const DISABLED = /^(x(describe|it)|(describe|it)\.(skip|todo|skipIf|runIf|concurrent\.skip))$/;

function countAssertions(body: string): number {
  return [...body.matchAll(/\bexpect(?:\.soft)?\s*\(/g)].length;
}

/**
 * An UNCONDITIONAL PASS: every assertion in the arm compares two literals, so
 * the arm cannot fail whatever the subject does. `expect(true).toBe(true)`,
 * `expect(1).toBe(1)`, `expect('x').toBe('x')`.
 *
 * `some(...) === true` over a possibly-empty subject is the other shape of
 * green-about-nothing, and it is answered differently: every discovery-based
 * assertion in the proofs carries an explicit non-vacuity canary, and the
 * auditor requires the arm to name its subject through `requiresInArm`.
 */
function isUnconditionalPass(body: string): boolean {
  const calls = [...body.matchAll(/\bexpect(?:\.soft)?\s*\(/g)];
  if (calls.length === 0) return true;
  const LITERAL = /^\s*(true|false|null|undefined|-?\d[\d_]*n?|(['"`])[^'"`]*\2)\s*$/;
  for (const c of calls) {
    const call = balancedCall(body, (c.index ?? 0) + (c[0] as string).length - 1);
    if (call === null) return false;
    if (!LITERAL.test(call.body)) return false;
  }
  return true;
}

/**
 * THE AUDITOR. Given a file's source and the proofs declared mandatory in it,
 * return every reason the file does not carry those proofs.
 *
 * An EMPTY result is the only pass. The relationship is structural: the
 * `describe` must exist and be live, the arm must exist and be live, the arm
 * must carry real assertions over a named subject, and the call sites must be
 * inside the arm's own body rather than anywhere in the file.
 */
export function auditProofFile(source: string, mandatory: readonly MandatoryProof[]): readonly ProofFinding[] {
  const src = maskSource(source);
  const describes = blocksOf(src, 'describe');
  const findings: ProofFinding[] = [];
  for (const p of mandatory) {
    const tag = `[${p.id}]`;
    const matching = describes.filter((d) => d.title.includes(tag));
    if (matching.length === 0) {
      findings.push({ proof: p.id, kind: 'missing', detail: `no live describe titled ${tag} in ${p.file}` });
      continue;
    }
    const live = matching.filter((d) => !DISABLED.test(d.callee));
    if (live.length === 0) {
      findings.push({ proof: p.id, kind: 'disabled', detail: `${tag} is ${matching.map((d) => d.callee).join('/')}` });
      continue;
    }
    const block = live[0] as Block;
    let arms: readonly Block[];
    if (p.armTitleContains === null) {
      arms = [block];
    } else {
      const its = blocksOf(block.body, 'it');
      const named = its.filter((t) => t.title.includes(p.armTitleContains as string));
      if (named.length === 0) {
        findings.push({
          proof: p.id,
          kind: 'arm_missing',
          detail: `${tag} has no it() titled ...${p.armTitleContains}...`,
        });
        continue;
      }
      for (const d of named.filter((t) => DISABLED.test(t.callee))) {
        findings.push({ proof: p.id, kind: 'arm_disabled', detail: `${tag}'s mutation arm is ${d.callee}` });
      }
      const liveArms = named.filter((t) => !DISABLED.test(t.callee));
      if (liveArms.length === 0) continue;
      // THE DECLARED COUNT. Losing one of several red arms is losing a
      // mutation, and an auditor that read only the first matching arm was
      // green on exactly that.
      if (liveArms.length < p.arms) {
        findings.push({
          proof: p.id,
          kind: 'arm_count_short',
          detail: `${tag} has ${liveArms.length} live mutation arms, ${p.arms} declared`,
        });
      }
      arms = liveArms;
    }
    for (const arm of arms) {
      const n = countAssertions(arm.body);
      if (n < p.minAssertions) {
        findings.push({
          proof: p.id,
          kind: 'too_few_assertions',
          detail: `${tag} arm "${arm.title.slice(0, 48)}" has ${n} < ${p.minAssertions}`,
        });
      }
      if (isUnconditionalPass(arm.body)) {
        findings.push({
          proof: p.id,
          kind: 'unconditional_pass',
          detail: `${tag} arm "${arm.title.slice(0, 48)}" asserts only literals`,
        });
      }
    }
    const union = arms.map((a) => a.body).join('\n');
    for (const needed of p.requiresInArm) {
      if (!union.includes(needed)) {
        findings.push({ proof: p.id, kind: 'call_site_missing', detail: `${tag} arms do not call ${needed}` });
      }
    }
  }
  return Object.freeze(findings);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 9 — THE PROOF-OF-THE-PROOF MUTATION OPERATORS
// ═══════════════════════════════════════════════════════════════════════════

export type ProofSourceMutator = (source: string, proofId: string) => string;

/**
 * Locate the `describe(...)` call whose TITLE carries `[proofId]`.
 *
 * ALL SEARCHING IS DONE IN THE MASK and the span is returned as RAW offsets,
 * which the mask preserves one-for-one. Two things make that necessary:
 *   — the tag is also written in PROSE (this file's and the suites' headers
 *     name the proofs), and a mutator that grabbed the first occurrence would
 *     surgically edit a comment and then report that the gate stayed green;
 *   — a regex literal with unbalanced parentheses would mis-span the block.
 */
function describeSpan(source: string, proofId: string): { start: number; end: number } {
  const mask = maskSource(source);
  const tag = `[${proofId}]`;
  let at = mask.indexOf(tag);
  if (at === -1) throw new Error(`cannot mutate: ${tag} is in no live code`);
  for (; at !== -1; at = mask.indexOf(tag, at + 1)) {
    const start = mask.lastIndexOf('describe(', at);
    if (start === -1) continue;
    const call = balancedCall(mask, mask.indexOf('(', start));
    if (call === null || call.end <= at) continue;
    const title = /^\s*(['"`])([\s\S]*?)\1/.exec(call.body);
    if (title === null || !(title[2] as string).includes(tag)) continue;
    return { start, end: call.end + 1 };
  }
  throw new Error(`cannot mutate: ${tag} is in no describe() title`);
}

/**
 * The `it(...)` call inside `[proofId]`'s describe whose TITLE contains
 * `fragment`.
 *
 * It enumerates the `it(` tokens of the block and reads each one's TITLE,
 * rather than searching for the fragment's text and scanning backwards. The
 * fragment is also a STRING in the proof registry, and that string lives
 * inside the gate's own `describe` ahead of its `it` — a backwards scan from
 * the first textual hit found no `it(` at all and threw, which would have
 * disabled a whole column of the mutation matrix while looking like a bug in
 * the fixture.
 */
function armSpan(source: string, proofId: string, fragment: string): { start: number; end: number } {
  const mask = maskSource(source);
  const span = describeSpan(source, proofId);
  for (let i = span.start; i < span.end; i += 1) {
    if (!mask.startsWith('it(', i)) continue;
    const before = i === 0 ? ' ' : (mask[i - 1] as string);
    if (/[\w$.]/.test(before)) continue;
    const call = balancedCall(mask, mask.indexOf('(', i));
    if (call === null) continue;
    const title = /^\s*(['"`])([\s\S]*?)\1/.exec(call.body);
    if (title === null || !(title[2] as string).includes(fragment)) continue;
    return { start: i, end: call.end + 1 };
  }
  throw new Error(`cannot mutate: no it() titled ...${fragment}... in [${proofId}]`);
}

/**
 * THE SEVEN MUTATIONS THE META GATE MUST GO RED ON. Each one is deterministic
 * text surgery on the REAL shipped source, and each one is asserted to have
 * actually changed the source — a mutation that does not change the text
 * proves nothing, and that is itself a canary.
 */
export const PROOF_MUTATIONS: readonly { readonly name: string; readonly apply: ProofSourceMutator }[] =
  Object.freeze([
    Object.freeze({
      name: 'remove the proof',
      apply: ((source, id) => {
        const s = describeSpan(source, id);
        return `${source.slice(0, s.start)}${source.slice(s.end)}`;
      }) as ProofSourceMutator,
    }),
    Object.freeze({
      name: 'rename the proof so discovery misses it',
      apply: ((source, id) => {
        const s = describeSpan(source, id);
        const head = source.slice(s.start, s.end).replace(`[${id}]`, `[${id}_renamed]`);
        return `${source.slice(0, s.start)}${head}${source.slice(s.end)}`;
      }) as ProofSourceMutator,
    }),
    Object.freeze({
      name: 'skip the proof',
      apply: ((source, id) => {
        const s = describeSpan(source, id);
        return `${source.slice(0, s.start)}describe.skip(${source.slice(s.start + 'describe('.length)}`;
      }) as ProofSourceMutator,
    }),
    Object.freeze({
      name: 'comment out the proof',
      apply: ((source, id) => {
        const s = describeSpan(source, id);
        const body = source
          .slice(s.start, s.end)
          .split('\n')
          .map((l) => `// ${l}`)
          .join('\n');
        return `${source.slice(0, s.start)}${body}${source.slice(s.end)}`;
      }) as ProofSourceMutator,
    }),
  ]);

/** Mutations that need the arm's title, applied to one mandatory proof. */
export const ARM_MUTATIONS: readonly {
  readonly name: string;
  readonly apply: (source: string, proofId: string, fragment: string) => string;
}[] = Object.freeze([
  Object.freeze({
    name: 'remove the mutation arm',
    apply: (source: string, id: string, fragment: string): string => {
      const s = armSpan(source, id, fragment);
      return `${source.slice(0, s.start)}${source.slice(s.end)}`;
    },
  }),
  Object.freeze({
    name: 'replace the arm body with an unconditional pass',
    apply: (source: string, id: string, fragment: string): string => {
      const s = armSpan(source, id, fragment);
      const title = maskSource(source).slice(s.start, s.end).match(/^it\(\s*(['"`])([\s\S]*?)\1/);
      const t = title === null ? 'arm' : (title[2] as string);
      return `${source.slice(0, s.start)}it('${t.replace(/'/g, "\\'")}', () => { expect(true).toBe(true); });${source.slice(s.end)}`;
    },
  }),
  Object.freeze({
    name: 'skip the mutation arm',
    apply: (source: string, id: string, fragment: string): string => {
      const s = armSpan(source, id, fragment);
      return `${source.slice(0, s.start)}it.skip(${source.slice(s.start + 'it('.length)}`;
    },
  }),
  Object.freeze({
    name: 'comment out the mutation arm',
    apply: (source: string, id: string, fragment: string): string => {
      const s = armSpan(source, id, fragment);
      const body = source
        .slice(s.start, s.end)
        .split('\n')
        .map((l) => `// ${l}`)
        .join('\n');
      return `${source.slice(0, s.start)}${body}${source.slice(s.end)}`;
    },
  }),
]);
