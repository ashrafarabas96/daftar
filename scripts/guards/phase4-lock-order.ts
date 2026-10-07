/**
 * THE STATIC ACQUISITION-ORDER CHECK `P4-AL-41` PROMISES.
 *
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md` `P4-AL-41` declares one lock order for
 * the whole of Phase 4 and says: "A static check reads each routine's
 * acquisition sequence and compares it against this list."
 *
 * **THAT CHECK DID NOT EXIST** when this module was written. It does now: the
 * reader below, the declared order below it, and the `lock-order` arm of
 * `gate:phase4:s4` that runs `phase4LockOrderProblems` over the whole
 * discovered Phase 4 migration range. What was there before, measured over the
 * tree at `phase/4-sales-pos-customers-receivables` `61677af`:
 *
 *   — `packages/domain-core/src/sale.ts:180` exports `SALE_COMMIT_LOCK_ORDER`,
 *     a frozen four-entry array under the heading "The declared lock order
 *     (P4-AL-41)". It has ZERO consumers: the only occurrence of the name in
 *     the whole tree is its own declaration. It is data no check reads. It is
 *     also inaccurate as a description of acquisitions — it names `businesses`
 *     and `customers`, and `sale_commit` ROW-LOCKS NEITHER (`0078:649-667`
 *     reads both unlocked on purpose, because a locking clause needs `UPDATE`
 *     on the relation, and takes a SHARED ADVISORY lock on
 *     `daftar.customer_id` for the customer instead).
 *   — `scripts/phase4-s4-gate.ts:692` `rowLockOnlyWriteProblems` is the only
 *     machine check in the tree that reads the two settlement routine bodies
 *     for anything lock-related, and its law is a WRITE law (`UPDATE invoices`
 *     / `UPDATE customers`), not an order law. Its own doc comment treats
 *     `FOR UPDATE` only as a token that must not be MISTAKEN for a write. It
 *     never tokenises an acquisition at all, so a fortiori it never reads
 *     `FOR SHARE` as one.
 *   — `gate:phase4:s8`, the DYNAMIC half `P4-AL-41` also promises, has no
 *     script: `scripts/phase4-s8-gate.ts` is referenced by
 *     `tests/security/phase4-forward-evolution.test.ts:698` as a future file
 *     and `package.json` registers gates s1–s4 only.
 *
 * A check that cannot see an inversion cannot see the next one, so this module
 * is the reader: it extracts each routine's acquisition sequence — ADVISORY
 * KEYS AND ROW LOCKS ALIKE, in body order, with the lock mode — and compares
 * it against a declared order passed in as data.
 *
 * ── THE READER TAKES THE ORDER AS AN ARGUMENT; THE LAW SUPPLIES ONE ───────
 *
 * `lockOrderProblems` takes the order it judges against as DATA, so the suite
 * can assert both directions over one implementation: that the order the
 * routines actually take is reported clean, and that an order they do not take
 * is reported INVERTED, naming both resources and both ranks. That is what
 * makes this a check somebody has watched say no rather than one that has only
 * ever agreed with itself.
 *
 * `PHASE4_LOCK_ORDER`, further down, is the order `P4-AL-41` declares — the
 * argument the gate arm actually passes. It is a constant here and prose there
 * because a document cannot be executed, and because the gate must judge the
 * tree against a list a reviewer can diff rather than against whatever a
 * caller happened to supply.
 *
 * ── THE 0085 LESSON: THE LAST DEFINITION, NEVER THE FIRST ─────────────────
 *
 * `0085` RE-DEFINES `customer_collect_payment`, so a reader handed the joined
 * candidate surface and using `RegExp.exec` finds `0081`'s superseded body and
 * judges a routine that no longer exists. That is not hypothetical: it is what
 * `scripts/phase4-s4-gate.ts`'s `routineBody` does today, because
 * `settlementContractProblems` is called with the JOINED surface
 * (`phase4-s4-gate.ts:971`) and `routineBody` takes the first match
 * (`:669-679`). `lastRoutineBody` below takes the LAST, which is what
 * "the live definition" means in a migration estate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { phase4MigrationsOnDisk } from '../phase4-prefix';
import { MIGRATIONS_SUBDIR } from './phase4-rls-force';

/** One acquisition, as the body takes it. */
export interface Acquisition {
  /** An advisory key is a different lock SPACE from a row lock: it conflicts only with other advisory locks on the same key. */
  readonly kind: 'advisory' | 'row';
  /** The advisory CLASS string (`daftar.payment_id`) or the relation name (`invoices`). */
  readonly name: string;
  /** `exclusive` / `shared` for an advisory key; `UPDATE`, `NO KEY UPDATE`, `SHARE`, `KEY SHARE` for a row lock. */
  readonly mode: string;
  /** 1-based, relative to the start of the routine BODY, so a diagnostic can be located. */
  readonly line: number;
  /**
   * The call chain this acquisition was reached through, when it is not the
   * judged routine's own — `sale_lock_commit_targets`, for the `products` lock
   * `sale_commit` takes by calling it. Absent for a direct acquisition, and set
   * only by `effectiveAcquisitions`: `bodyAcquisitions` follows no call.
   */
  readonly via?: string;
}

/**
 * `sql` with every comment and every single-quoted literal replaced by spaces,
 * BYTE FOR BYTE, so offsets — and therefore line numbers — are preserved.
 *
 * Both are blanked, and each for its own reason:
 *
 *   — a COMMENT may describe an acquisition the body does not take. `0081`'s
 *     own lock-order commentary at `:626-642` lists five acquisitions in prose;
 *     a reader that counted them would be reading the migration's description
 *     of itself.
 *   — a LITERAL may CONTAIN an acquisition. `0085:987` asserts its own end
 *     state with `strpos(v_def, '… ORDER BY i.id FOR UPDATE) AS k;')`, and
 *     `COMMENT ON FUNCTION` bodies quote whole lock sequences. A reader that
 *     saw those would find acquisitions in a self-capture assertion and report
 *     an order the routine never takes.
 *
 * Length-preserving, which is why the gate's own `stripSqlComments` is not
 * reused: that one replaces each comment with a SINGLE space on purpose (so
 * stripping can never fuse two tokens), which shifts every later offset and
 * makes a line number meaningless. Different contract, different function —
 * and this one blanks literals too, which that one must not.
 */
export function blankCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  const keep = (ch: string): void => {
    out.push(ch);
  };
  const blank = (n: number): void => {
    out.push(' '.repeat(n));
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl < 0 ? sql.length : nl;
      blank(end - i);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close < 0 ? sql.length : close + 2;
      // Newlines INSIDE a blanked block comment are preserved, or every line
      // number after a multi-line comment would be wrong.
      for (let k = i; k < end; k += 1) keep(sql[k] === '\n' ? '\n' : ' ');
      i = end;
      continue;
    }
    if (ch === "'") {
      keep("'");
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            blank(2);
            i += 2;
            continue;
          }
          keep("'");
          i += 1;
          break;
        }
        keep(sql[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    keep(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * The LAST dollar-quoted body `sql` declares for `fn`, or null when it
 * declares none (or leaves one unterminated).
 *
 * The LAST, because a migration estate supersedes by re-definition and the
 * live routine is the one the final `CREATE OR REPLACE` installed. Returning
 * null keeps a caller LOUD: an unreadable body is never "nothing to check".
 */
export function lastRoutineBody(sql: string, fn: string): string | null {
  const head = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?${fn}\b`, 'gi');
  let found: string | null = null;
  for (const m of sql.matchAll(head)) {
    const rest = sql.slice(m.index ?? 0);
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (open === null) continue;
    const tag = open[0];
    const from = (m.index ?? 0) + open.index + tag.length;
    const end = sql.indexOf(tag, from);
    if (end < 0) continue;
    found = sql.slice(from, end);
  }
  return found;
}

/** How many definitions of `fn` the text declares — so "the last one" can be shown to be a CHOICE and not an accident. */
export function definitionCount(sql: string, fn: string): number {
  return [...sql.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?${fn}\b`, 'gi'))].length;
}

const ADVISORY = /pg_(?:catalog\s*\.\s*)?advisory_xact_lock(_shared)?\s*\(\s*(?:pg_catalog\s*\.\s*)?hashtext\s*\(\s*'([^']*)'/gi;
const LOCKING = /\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/gi;
/** The relation a locking clause attaches to: the nearest `FROM <table>` before it, through an optional subselect. */
const FROM_TABLE = /\bfrom\s+(?:\(\s*select\b[\s\S]*?\bfrom\s+)?(?:public\s*\.\s*)?([a-z_][a-z0-9_]*)/gi;

/**
 * EVERY ACQUISITION `body` TAKES, IN BODY ORDER — advisory keys and row locks
 * in ONE sequence, because that is the only form in which the question "do the
 * two kinds interleave?" can be answered.
 *
 * The advisory class is read from a LITERAL argument, which is how every
 * accepted call site in the estate is written
 * (`pg_advisory_xact_lock(hashtext('daftar.<class>'), …)`). A call whose class
 * is computed rather than written is reported as `<computed>` rather than
 * skipped: a key no reader can name is a key no order can govern, and that is
 * a finding about the call site.
 *
 * A row lock's relation is resolved from the nearest preceding `FROM` WITHIN
 * THE SAME STATEMENT. Statements are split on `;`, so a locking clause can
 * never be attributed to a table named by an earlier statement — which is the
 * mistake that would make `customer_apply_credit`'s `customers FOR SHARE` read
 * as a second lock on `customer_credits`.
 */
export function bodyAcquisitions(body: string): readonly Acquisition[] {
  const clean = blankCommentsAndLiterals(body);
  const lineOf = (offset: number): number => 1 + (clean.slice(0, offset).match(/\n/g) ?? []).length;
  const found: Acquisition[] = [];
  for (const m of clean.matchAll(ADVISORY))
    found.push({
      kind: 'advisory',
      // The literal was blanked to preserve offsets, so the CLASS is read back
      // out of the original body at the same offset. A computed class has no
      // literal to read and is named as such.
      name: readLiteralAt(body, (m.index ?? 0) + m[0].length - (m[2]?.length ?? 0) - 1, m[2]?.length ?? 0),
      mode: m[1] === undefined || m[1] === null ? 'exclusive' : 'shared',
      line: lineOf(m.index ?? 0),
    });
  // Statement boundaries, so a `FROM` cannot leak across a `;`.
  const bounds: number[] = [0];
  for (const s of clean.matchAll(/;/g)) bounds.push((s.index ?? 0) + 1);
  const startOf = (offset: number): number => {
    let best = 0;
    for (const b of bounds) if (b <= offset) best = b;
    return best;
  };
  for (const m of clean.matchAll(LOCKING)) {
    const at = m.index ?? 0;
    const statement = clean.slice(startOf(at), at);
    const tables = [...statement.matchAll(FROM_TABLE)].map((t) => t[1] as string);
    found.push({
      kind: 'row',
      name: tables.length === 0 ? '<unresolved>' : (tables[tables.length - 1] as string),
      mode: (m[1] as string).replace(/\s+/g, ' ').toUpperCase(),
      line: lineOf(at),
    });
  }
  return found.sort((a, b) => a.line - b.line || (a.kind === 'advisory' ? -1 : 1));
}

/** The literal text at `offset` of the ORIGINAL body, or `<computed>` when the blanked span held no literal. */
function readLiteralAt(body: string, offset: number, length: number): string {
  const text = body.slice(offset, offset + length);
  return /^[A-Za-z0-9_.]+$/.test(text) ? text : '<computed>';
}

/**
 * WHAT IS WRONG WITH `acquisitions` AGAINST `declared`, empty when nothing is.
 *
 * `declared` is a RANKED list of names — advisory classes and relations in one
 * sequence, which is what a single total order means. An acquisition whose
 * name the list does not hold is reported as UNRANKED rather than ignored: a
 * resource no rank governs is exactly the `P4-AL-41` gap that advisory keys sat
 * in, and silence about it is how it survived.
 *
 * A repeated acquisition of the SAME name is not a finding — re-locking a
 * resource already held takes nothing new — so the comparison is over the rank
 * of each name's FIRST acquisition.
 *
 * `FOR SHARE` is judged exactly as `FOR UPDATE` is. A shared lock taken after
 * an exclusive lock on a higher-ranked resource still inverts the order and can
 * still deadlock against a transaction taking them in the declared order, so a
 * reader that skipped shared modes would be blind to precisely the inversion
 * `customer_collect_payment` carries.
 */
export function lockOrderProblems(acquisitions: readonly Acquisition[], declared: readonly string[], subject: string): string[] {
  const problems: string[] = [];
  const rank = new Map<string, number>();
  declared.forEach((name, i) => rank.set(name, i));
  const firstSeen: Acquisition[] = [];
  const already = new Set<string>();
  for (const a of acquisitions) {
    if (already.has(a.name)) continue;
    already.add(a.name);
    firstSeen.push(a);
  }
  for (const a of firstSeen)
    if (!rank.has(a.name))
      problems.push(
        `${subject}: the ${a.kind === 'advisory' ? 'advisory key' : 'relation'} \`${a.name}\` is acquired at body line ${a.line} ` +
          `(${a.mode}) and the declared order ranks it NOWHERE — a resource no rank governs is a resource whose order no check can judge, ` +
          `and a routine taking it in either order passes`,
      );
  const ranked = firstSeen.filter((a) => rank.has(a.name));
  for (let i = 1; i < ranked.length; i += 1) {
    const prev = must(ranked[i - 1]);
    const here = must(ranked[i]);
    const rp = rank.get(prev.name) as number;
    const rh = rank.get(here.name) as number;
    if (rh < rp)
      problems.push(
        `${subject}: \`${here.name}\` (declared rank ${rh + 1}, acquired ${here.mode} at body line ${here.line}) is taken AFTER ` +
          `\`${prev.name}\` (declared rank ${rp + 1}, acquired ${prev.mode} at body line ${prev.line}) — an inversion of the declared ` +
          `order. Deadlock freedom needs ONE order obeyed by every lock-taking command; a ${here.mode} acquisition inverts it just as an ` +
          `exclusive one does ([[daftar-lock-order-not-retry]]: fixed by changing the order, never by a retry)`,
      );
  }
  return problems;
}

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('unreachable: indexed past a bounded array');
  return x;
}

/** Whether the two KINDS interleave — advisory, then row, then advisory again. Decides whether a head BLOCK can describe the routine at all. */
export function advisoryInterleaves(acquisitions: readonly Acquisition[]): boolean {
  const kinds = acquisitions.map((a) => a.kind);
  const lastAdvisory = kinds.lastIndexOf('advisory');
  const firstRow = kinds.indexOf('row');
  return firstRow >= 0 && lastAdvisory > firstRow;
}

/** One routine's live acquisition sequence, read from the joined text of several migrations. */
export function routineAcquisitions(sql: string, fn: string): readonly Acquisition[] | null {
  const body = lastRoutineBody(sql, fn);
  return body === null ? null : bodyAcquisitions(body);
}

/** The joined text of the named migration files, in the order given. */
export function joinMigrations(dir: string, files: readonly string[]): string {
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE DECLARED ORDER ITSELF, AND THE SWEEP THAT HOLDS THE TREE TO IT.
 *
 * Everything above is a READER: it takes an order as data and says what a body
 * does. Everything below is the LAW: the one order `P4-AL-41` declares, and the
 * sweep that judges every lock-taking routine the Phase 4 range ships against
 * it.
 *
 * ── WHY ONE LIST AND NOT AN ADVISORY BLOCK AT THE HEAD ───────────────────
 *
 * MEASURED: `sale_commit` takes `daftar.sale_id` (exclusive), then
 * `sales FOR UPDATE`, then `daftar.customer_id` (SHARED) — an advisory key
 * AFTER a row lock. A block of advisory ranks bolted on the front of a row-lock
 * list would declare `daftar.customer_id` to be acquired before `sales`, which
 * is false of the routine, and a check built on that block would have to exempt
 * `sale_commit` from the only law it has. The two kinds therefore share ONE
 * ranked sequence. `advisoryInterleaves` above is the measurement.
 *
 * ── WHAT A RANK DOES AND DOES NOT MEAN ───────────────────────────────────
 *
 * An advisory lock and a row lock are DIFFERENT LOCK SPACES. An advisory key
 * conflicts only with other advisory locks on the same key; a row lock
 * conflicts only with other row locks on the same row, by mode. Sharing one
 * ranked sequence says nothing about the two conflicting with each other — it
 * says only that every transaction acquires whatever it acquires in ONE
 * direction through this list, which is the whole of what deadlock freedom
 * needs and is a claim about the ORDER, never about the conflict. `kind` on
 * each rank is therefore load-bearing, and `declarationProblems` below refuses
 * a rank whose kind disagrees with the acquisition the tree takes, so the two
 * notions cannot be quietly merged by a later edit.
 *
 * ── THE INSERTION RULE FOR A LATER SLICE ─────────────────────────────────
 *
 * A slice that ships a routine taking a resource this list does not rank adds
 * that rank IN THE SAME CHANGE as the migration that takes it, at the position
 * its own routine takes it, and marks its kind. No slice ranks a resource no
 * migration acquires: a rank for an unacquired resource is a permanent module
 * bounding the future (`P4-AL-60`,
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`), and it is also unfalsifiable
 * — nothing can be shown to obey it. `exercised` below is what makes that rule
 * enforceable in BOTH directions rather than advisory in either: the sweep
 * refuses an acquisition no rank governs, and it refuses a rank marked
 * `exercised` that the sweep does not actually see taken.
 */

/** One rank of the declared order. */
export interface LockRank {
  /** The advisory CLASS (`daftar.sale_id`) or the relation name (`invoices`). */
  readonly name: string;
  /** Which lock SPACE this rank lives in. `advisory-shared` and `advisory-exclusive` are one key space; `row` is the heap. */
  readonly kind: 'row' | 'advisory-exclusive' | 'advisory-shared';
  /**
   * Whether the STATIC SWEEP over the Phase 4 migration range can see this rank
   * taken. `false` means a Phase 4 command does take it, but the acquiring text
   * is outside the range the sweep reads — a frozen routine it calls — and the
   * rank is justified by `why` rather than by a measurement. A rank that is
   * NEITHER exercised NOR justified is refused: that is the shape of a rank for
   * a resource nothing acquires.
   */
  readonly exercised: boolean;
  /** Why this rank sits here, in one line. Printed in the report, so a reader never has to open the document to audit the list. */
  readonly why: string;
}

/**
 * **THE ONE DECLARED LOCK ORDER FOR THE WHOLE OF PHASE 4** — row locks and
 * advisory keys in a single ranked sequence, in the order the shipped tree
 * takes them.
 *
 * Every rank here was MEASURED, not remembered. The four chains the tree
 * actually constrains are, in body order:
 *
 *   `pos_till_session_open`    @actor → @terminal → @session_id → pos_till_sessions
 *   `pos_cart_set_line`        pos_till_sessions → pos_cart_lines
 *   `sale_commit`              @sale_id → sales → @customer_id → [ @stock_target → products ]
 *                              → [ stock_levels ] → invoice_sequences
 *   `customer_collect_payment` @payment_id → invoices → customers → payment_methods
 *   `customer_apply_credit`    @credit_application_id → invoices → customer_credits → customers
 *
 * The bracketed legs are taken through a CALL: `sale_commit` calls
 * `sale_lock_commit_targets` (which takes `daftar.stock_target` then
 * `products FOR SHARE`) and then the frozen stock writer (which takes
 * `stock_levels FOR UPDATE`). `effectiveAcquisitions` follows the first,
 * because that routine is inside the range the sweep reads; it cannot follow
 * the second, and `stock_levels` is marked `exercised: false` for exactly that
 * reason rather than being dropped or silently trusted.
 *
 * The chains are pairwise disjoint, so a total order exists and this is one of
 * them. Deadlock freedom needs ONE consistent order and not a particular one,
 * so where two resources are never taken together their relative rank here is a
 * free choice; where they are, this list follows the routine.
 */
export const PHASE4_LOCK_ORDER: readonly LockRank[] = Object.freeze<LockRank>([
  { name: 'daftar.pos_till_session_actor', kind: 'advisory-exclusive', exercised: true, why: 'pos_till_session_open takes three keys consecutively; this is the first' },
  { name: 'daftar.pos_till_terminal', kind: 'advisory-exclusive', exercised: true, why: 'pos_till_session_open, second of the three' },
  { name: 'daftar.pos_till_session_id', kind: 'advisory-exclusive', exercised: true, why: 'pos_till_session_open, third of the three' },
  { name: 'pos_till_sessions', kind: 'row', exercised: true, why: 'the till row, after the three till keys and before the cart line' },
  { name: 'pos_cart_lines', kind: 'row', exercised: true, why: 'pos_cart_set_line takes the till row first and the line second' },
  { name: 'daftar.sale_id', kind: 'advisory-exclusive', exercised: true, why: 'sale_commit, the per-document key, before every other acquisition it makes' },
  { name: 'sales', kind: 'row', exercised: true, why: 'sale_commit, after its own document key' },
  { name: 'daftar.customer_id', kind: 'advisory-shared', exercised: true, why: 'sale_commit, SHARED and AFTER sales — the interleave that forbids a head block' },
  { name: 'daftar.stock_target', kind: 'advisory-shared', exercised: true, why: 'sale_lock_commit_targets, reached through sale_commit after the customer key' },
  { name: 'products', kind: 'row', exercised: true, why: 'sale_lock_commit_targets, FOR SHARE per product, ascending by id' },
  {
    name: 'stock_levels',
    kind: 'row',
    exercised: false,
    why: 'FOR UPDATE ascending by (warehouse_id, variant_id) inside the ONE frozen stock writer sale_commit calls — outside the migration range this sweep reads, so declared here and not measured here',
  },
  { name: 'daftar.payment_id', kind: 'advisory-exclusive', exercised: true, why: 'customer_collect_payment, the per-document key; it is also what serialises the payment row, which is never row-locked' },
  { name: 'daftar.customer_credit_application_id', kind: 'advisory-exclusive', exercised: true, why: 'customer_apply_credit, the per-document key. Never taken together with daftar.payment_id, so this pair is a free choice' },
  { name: 'invoices', kind: 'row', exercised: true, why: 'BOTH settlement routines take the cap lock FIRST among their row locks, FOR UPDATE, ascending by id' },
  { name: 'customer_credits', kind: 'row', exercised: true, why: 'customer_apply_credit takes the consumed source after invoices and before customers' },
  { name: 'customers', kind: 'row', exercised: true, why: 'FOR SHARE, and LAST among the row locks both settlement routines share — which is why the pre-patch list ranking it 2nd described no command' },
  {
    name: 'payment_methods',
    kind: 'row',
    exercised: true,
    why: 'customer_collect_payment takes it FOR SHARE AFTER customers. A LOOKUP, not a consumed source — which is why it ranks after customers and not with customer_credits',
  },
  { name: 'accounting_opening_balances', kind: 'row', exercised: true, why: 'the reversal domain-source guard takes the opening-balance ROW FOR NO KEY UPDATE; no other Phase 4 routine takes it, so its rank is a free choice' },
  { name: 'invoice_sequences', kind: 'row', exercised: true, why: 'LAST of the domain locks (P4-AL-32) — sale_commit takes it after every other acquisition it makes' },
]);

/** One relation a routine names and deliberately does not row-lock. */
export interface ReadUnlocked {
  /** The relation named and not row-locked. */
  readonly relation: string;
  /** The routine that reads it unlocked. */
  readonly by: string;
  /** Why no lock is taken. A privilege rule, not a preference. */
  readonly why: string;
}

/**
 * Relations a Phase 4 command names and DELIBERATELY DOES NOT ROW-LOCK, with
 * the reason. These carry NO rank, and must not: a rank is a position in an
 * acquisition order, and an unlocked read makes no acquisition to position.
 *
 * Recorded here because the absence is a DECISION and not an omission. A reader
 * who finds `businesses` in `sale_commit` and no `businesses` rank needs to
 * find this list, or the next edit will "fix" the order by granting the
 * inventory writer `UPDATE` on the tenancy root.
 */
export const PHASE4_READ_UNLOCKED: readonly ReadUnlocked[] = Object.freeze<ReadUnlocked>([
  {
    relation: 'businesses',
    by: 'sale_commit',
    why: 'EVERY PostgreSQL locking clause — FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE and FOR KEY SHARE alike — requires UPDATE on the relation, so SELECT … FOR SHARE on the tenancy root would mean granting the inventory writer the right to WRITE businesses. A larger authority than the lock is worth, and no law in the slice rests on it',
  },
  {
    relation: 'customers',
    by: 'sale_commit',
    why: 'the same privilege rule. sale_commit takes a SHARED ADVISORY lock on daftar.customer_id instead, which PUBLIC may execute and which therefore adds no privilege at all: two concurrent sales of one customer serialise there. The customers RANK above is the settlement routines’ row lock, which sale_commit does not take',
  },
  {
    relation: 'payments',
    by: 'customer_collect_payment',
    why: 'the consumed money document is serialised by the exclusive advisory key daftar.payment_id, not by a row lock. No Phase 4 routine takes a payments row lock, so payments carries no rank — the pre-patch list ranked it, and nothing obeyed that rank',
  },
]);

/** The ranked names, in order — the form `lockOrderProblems` judges against. */
export function rankedNames(order: readonly LockRank[] = PHASE4_LOCK_ORDER): readonly string[] {
  return order.map((r) => r.name);
}

/** The lock SPACE an acquisition lives in, in the vocabulary a rank uses. */
export function acquisitionKind(a: Acquisition): LockRank['kind'] {
  if (a.kind === 'row') return 'row';
  return a.mode === 'shared' ? 'advisory-shared' : 'advisory-exclusive';
}

/** An acquisition plus where in the body it was found, so a call site can be merged into the sequence at the right place. */
interface Positioned {
  readonly acq: Acquisition;
  readonly offset: number;
}

/** A call to another routine, and where. */
interface CallSite {
  readonly fn: string;
  readonly offset: number;
}

/**
 * `body`'s own acquisitions AND its calls to other routines, both located by
 * byte offset in the blanked text, so the two can be MERGED into one sequence.
 *
 * `bodyAcquisitions` is this function with the calls thrown away and the
 * offsets dropped; it stays as the simple reader because a caller judging ONE
 * body (every planted red proof) must not have a call followed out from under
 * it, and because its contract is already asserted.
 */
function bodyScan(body: string, callees: readonly string[]): { readonly acquisitions: readonly Positioned[]; readonly calls: readonly CallSite[] } {
  const clean = blankCommentsAndLiterals(body);
  const lineOf = (offset: number): number => 1 + (clean.slice(0, offset).match(/\n/g) ?? []).length;
  const acquisitions: Positioned[] = [];
  for (const m of clean.matchAll(ADVISORY)) {
    const at = m.index ?? 0;
    acquisitions.push({
      offset: at,
      acq: {
        kind: 'advisory',
        name: readLiteralAt(body, at + m[0].length - (m[2]?.length ?? 0) - 1, m[2]?.length ?? 0),
        mode: m[1] === undefined || m[1] === null ? 'exclusive' : 'shared',
        line: lineOf(at),
      },
    });
  }
  const bounds: number[] = [0];
  for (const s of clean.matchAll(/;/g)) bounds.push((s.index ?? 0) + 1);
  const startOf = (offset: number): number => {
    let best = 0;
    for (const b of bounds) if (b <= offset) best = b;
    return best;
  };
  for (const m of clean.matchAll(LOCKING)) {
    const at = m.index ?? 0;
    const statement = clean.slice(startOf(at), at);
    const tables = [...statement.matchAll(FROM_TABLE)].map((t) => t[1] as string);
    acquisitions.push({
      offset: at,
      acq: {
        kind: 'row',
        name: tables.length === 0 ? '<unresolved>' : (tables[tables.length - 1] as string),
        mode: (m[1] as string).replace(/\s+/g, ' ').toUpperCase(),
        line: lineOf(at),
      },
    });
  }
  const calls: CallSite[] = [];
  for (const fn of callees)
    for (const m of clean.matchAll(new RegExp(String.raw`\b${fn}\s*\(`, 'g'))) calls.push({ fn, offset: m.index ?? 0 });
  return {
    acquisitions: acquisitions.sort((a, b) => a.offset - b.offset || (a.acq.kind === 'advisory' ? -1 : 1)),
    calls: calls.sort((a, b) => a.offset - b.offset),
  };
}

/** Every routine `sql` defines, by name — the set a call can be followed into. */
export function definedRoutines(sql: string): readonly string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?([a-z_][a-z0-9_]*)/gi)) names.add((m[1] as string).toLowerCase());
  return [...names].sort();
}

/**
 * `fn`'s EFFECTIVE acquisition sequence: its own acquisitions and those of
 * every routine it calls that `sql` also defines, spliced in at the call site.
 *
 * WHY THIS AND NOT THE BODY ALONE. `sale_commit` takes `daftar.sale_id`,
 * `sales FOR UPDATE` and `daftar.customer_id`, then CALLS
 * `sale_lock_commit_targets`, which takes `daftar.stock_target` and
 * `products FOR SHARE`, and only then takes `invoice_sequences`. A reader that
 * judged each body alone would see two short sequences, each monotone, and
 * could never see an inversion ACROSS the call — which is the only place in
 * this tree where one could hide, because it is the only place a lock-taking
 * routine calls another.
 *
 * Bounded by `seen`: a routine never expands itself, so mutual recursion
 * terminates instead of overflowing. A call it cannot follow — a routine
 * defined outside `sql`, which is every frozen one — contributes nothing, and
 * the ranks whose only acquirer is such a routine are marked
 * `exercised: false` rather than being quietly assumed.
 */
export function effectiveAcquisitions(sql: string, fn: string, seen: ReadonlySet<string> = new Set()): readonly Acquisition[] | null {
  const body = lastRoutineBody(sql, fn);
  if (body === null) return null;
  const callees = definedRoutines(sql).filter((n) => n !== fn.toLowerCase() && !seen.has(n));
  const { acquisitions, calls } = bodyScan(body, callees);
  const nextSeen = new Set([...seen, fn.toLowerCase()]);
  const out: Acquisition[] = [];
  let ci = 0;
  const expandUpTo = (offset: number): void => {
    while (ci < calls.length && (calls[ci] as CallSite).offset < offset) {
      const call = calls[ci] as CallSite;
      ci += 1;
      for (const a of effectiveAcquisitions(sql, call.fn, nextSeen) ?? []) out.push({ ...a, via: `${a.via === undefined ? '' : `${a.via} ← `}${call.fn}` });
    }
  };
  for (const p of acquisitions) {
    expandUpTo(p.offset);
    out.push(p.acq);
  }
  expandUpTo(Number.MAX_SAFE_INTEGER);
  return out;
}

/** One routine the sweep found taking at least one lock. */
export interface SweptRoutine {
  readonly fn: string;
  /** The migration file whose definition is the LIVE one — the last to define the name. */
  readonly file: string;
  /** The EFFECTIVE sequence: its own acquisitions and those of every in-range routine it calls, in order. */
  readonly acquisitions: readonly Acquisition[];
}

/** What the sweep saw. Carried as data so a non-vacuity claim has something to assert about. */
export interface LockOrderSweep {
  /** The migration files read, discovered from disk — never listed. */
  readonly migrations: readonly string[];
  /** Every routine the range defines, by name. */
  readonly routines: readonly string[];
  /** Those of them that acquire something, with their effective sequences. */
  readonly lockTaking: readonly SweptRoutine[];
}

/**
 * EVERY ACQUISITION THE PHASE 4 MIGRATION RANGE SHIPS, discovered.
 *
 * The subject is DISCOVERED, twice over: the files come from
 * `phase4MigrationsOnDisk` (numbered past the digest-verified inherited
 * prefix), and the routines come from the text of those files. Nothing here
 * names a migration and nothing here lists a routine, so a slice that adds a
 * lock-taking command is judged on the day its migration lands.
 *
 * `[[daftar-a-grep-over-008-star-is-not-a-sweep]]`: the range starts at the
 * first Phase 4 number and not at `008*`. A glob restricted to `008*.sql`
 * misses `0077`–`0079` — which is `sale_commit`, `sale_lock_commit_targets` and
 * all four POS routines, six of the nine lock-taking routines in the range —
 * and a sweep that misses them reports that no routine interleaves the two lock
 * kinds and that no routine takes more than one advisory key. Both are false of
 * this tree, and both were asserted from such a grep.
 */
export function sweepPhase4Acquisitions(migrationsDir: string, files: readonly string[]): LockOrderSweep {
  const perFile = files.map((f) => ({ file: f, text: readFileSync(join(migrationsDir, f), 'utf8') }));
  const surface = perFile.map((p) => p.text).join('\n');
  const routines = definedRoutines(surface);
  const lockTaking: SweptRoutine[] = [];
  for (const fn of routines) {
    const acquisitions = effectiveAcquisitions(surface, fn);
    if (acquisitions === null || acquisitions.length === 0) continue;
    // The LIVE definition's file: the LAST file to define the name, which is
    // the one whose body `lastRoutineBody` returned.
    const defining = perFile.filter((p) => definitionCount(p.text, fn) > 0);
    lockTaking.push({ fn, file: defining.length === 0 ? '<unknown>' : (defining[defining.length - 1] as { file: string }).file, acquisitions });
  }
  return { migrations: files, routines, lockTaking };
}

/**
 * WHAT IS WRONG WITH THE DECLARED ORDER ITSELF, against what the sweep saw.
 *
 * This is the half that makes the law SELF-MAINTAINING rather than a document
 * that falls behind the code, and it refuses in both directions:
 *
 *   — a rank marked `exercised` that the sweep does not see taken. Either the
 *     acquisition was removed and the rank is now a module bounding the future,
 *     or the sweep stopped seeing it — and the second is the failure mode that
 *     makes every other claim here vacuous, so it is never silent.
 *   — a rank whose KIND disagrees with the acquisition the tree takes. An
 *     advisory key and a row lock are different lock spaces; a list that calls
 *     one the other has merged two notions of "lock" into one, which is how a
 *     reader concludes that a shared advisory key on `daftar.customer_id`
 *     discharges the `customers` row-lock rank. It does not.
 *   — a duplicate rank, which would make "the rank of a name" ambiguous and
 *     silently decide every comparison by `Map` insertion order.
 */
export function declarationProblems(sweep: LockOrderSweep, order: readonly LockRank[] = PHASE4_LOCK_ORDER): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const r of order) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  for (const [name, n] of counts)
    if (n > 1) problems.push(`the declared order ranks \`${name}\` ${n} times — "the rank of a name" is then whichever entry a Map kept, and every comparison against it is decided silently`);
  const taken = new Map<string, Acquisition[]>();
  for (const r of sweep.lockTaking) for (const a of r.acquisitions) taken.set(a.name, [...(taken.get(a.name) ?? []), a]);
  for (const r of order) {
    const seen = taken.get(r.name);
    if (r.exercised && (seen === undefined || seen.length === 0))
      problems.push(
        `the declared order ranks \`${r.name}\` as EXERCISED and the sweep found no routine in the ${sweep.migrations.length} discovered Phase 4 migration(s) acquiring it — ` +
          `either the acquisition is gone and this rank now bounds the future with nothing to obey it (P4-AL-60), or the sweep has stopped reading the routine that takes it, ` +
          `which would make every order claim here vacuous. Declared reason: ${r.why}`,
      );
    if (!r.exercised && seen !== undefined && seen.length > 0)
      problems.push(
        `the declared order marks \`${r.name}\` as NOT statically measurable and the sweep acquired it ${seen.length} time(s) — the exemption is no longer true, ` +
          `so the rank is now measurable and must be marked \`exercised: true\` and judged like every other`,
      );
    for (const a of seen ?? [])
      if (acquisitionKind(a) !== r.kind)
        problems.push(
          `the declared order ranks \`${r.name}\` as a ${r.kind} and the tree acquires it as a ${acquisitionKind(a)} (body line ${a.line}${a.via === undefined ? '' : `, via ${a.via}`}) — ` +
            `an advisory key conflicts only with other advisory locks on the same key and a row lock only with other row locks on the same row, so the two are different lock SPACES ` +
            `and a list that names one as the other has merged them`,
        );
  }
  return problems;
}

/**
 * THE WHOLE LAW over a tree: non-vacuity, then the declaration, then every
 * routine's sequence.
 *
 * NON-VACUITY FIRST AND LOUDLY. A sweep that found nothing obeys every order
 * ever declared, so the two refusals below would be silent over a tree with no
 * migrations, over a renamed migrations directory, and over a reader whose
 * regexes have stopped matching. The order of the checks is deliberate: a
 * vacuous sweep is reported as a vacuous sweep and not as a pass, and the
 * `exercised` arm of `declarationProblems` then names each rank that went
 * missing, so the diagnostic says WHICH routine the reader lost.
 */
export function phase4LockOrderProblems(root: string, order: readonly LockRank[] = PHASE4_LOCK_ORDER): string[] {
  const dir = join(root, MIGRATIONS_SUBDIR);
  const files = phase4MigrationsOnDisk(dir);
  if (files.length === 0)
    return [
      `VACUOUS: no Phase 4 migration was discovered under ${MIGRATIONS_SUBDIR} (numbered past the digest-verified inherited prefix), so this law judged an empty text — ` +
        `a sweep that finds no acquisition obeys every order that was ever declared, and that is not a pass`,
    ];
  const sweep = sweepPhase4Acquisitions(dir, files);
  const problems: string[] = [];
  if (sweep.lockTaking.length === 0)
    problems.push(
      `VACUOUS: ${files.length} Phase 4 migration(s) and ${sweep.routines.length} routine(s) were read and NOT ONE acquisition was found — ` +
        `the declared order is unfalsifiable over this subject, so its silence is not evidence`,
    );
  problems.push(...declarationProblems(sweep, order));
  const names = rankedNames(order);
  for (const r of sweep.lockTaking) problems.push(...lockOrderProblems(r.acquisitions, names, `${r.file} ${r.fn}`));
  return problems;
}

/** What the sweep found, printed on a PASS as well as on a FAIL: a tally nobody can audit is a tally nobody checks. */
export function phase4LockOrderReport(root: string, order: readonly LockRank[] = PHASE4_LOCK_ORDER): string {
  const dir = join(root, MIGRATIONS_SUBDIR);
  const files = phase4MigrationsOnDisk(dir);
  if (files.length === 0) return `no Phase 4 migration discovered under ${MIGRATIONS_SUBDIR} — nothing was judged`;
  const sweep = sweepPhase4Acquisitions(dir, files);
  const ranks = `${order.length} declared rank(s) (${order.filter((r) => r.exercised).length} statically exercised, ${order.filter((r) => !r.exercised).length} declared-not-measured)`;
  const seq = sweep.lockTaking
    .map((r) => `${r.fn}: ${r.acquisitions.map((a) => `${a.kind === 'advisory' ? '@' : ''}${a.name}:${a.mode}${a.via === undefined ? '' : `(via ${a.via})`}`).join(' → ')}`)
    .join('; ');
  return (
    `${files.length} Phase 4 migration(s) swept, ${files[0]}…${files[files.length - 1]}; ${sweep.routines.length} routine(s) defined, ` +
    `${sweep.lockTaking.length} lock-taking; ${ranks}; ${PHASE4_READ_UNLOCKED.length} relation(s) recorded as deliberately read unlocked. ${seq}`
  );
}
