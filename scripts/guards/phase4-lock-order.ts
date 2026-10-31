/**
 * THE STATIC ACQUISITION-ORDER CHECK `P4-AL-41` PROMISES.
 *
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md` `P4-AL-41` declares one lock order for
 * the whole of Phase 4 and says: "A static check reads each routine's
 * acquisition sequence and compares it against this list."
 *
 * **THAT CHECK DID NOT EXIST.** Measured over the tree at
 * `phase/4-sales-pos-customers-receivables` `61677af`:
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
 * ── WHY THE DECLARED ORDER IS A PARAMETER AND NOT A CONSTANT HERE ─────────
 *
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md` is the coordinator's file. This module
 * therefore takes the order it judges against as an ARGUMENT, and its suite
 * asserts both directions: that the order the routines actually take is
 * reported clean, and that the order the document currently declares is
 * reported INVERTED. The second is the machine evidence for
 * `docs/patch-requests/PATCH-REQ-S4X-001.md`, and it is what makes this a
 * check somebody has watched say no rather than a check that has only ever
 * agreed with itself.
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
  return files.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
}
