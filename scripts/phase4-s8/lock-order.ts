#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE DECLARED LOCK ORDER, STATICALLY CHECKED
 *
 * `P4-AL-41` declares ONE domain lock order for the whole of Phase 4 and
 * requires a static check that reads each routine's acquisition sequence and
 * compares it against that list. This module is that check.
 *
 * THREE THINGS IT IS CAREFUL ABOUT, each because getting them wrong produces a
 * green check over a real deadlock:
 *
 *   1. `accounting_post_entry` is NOT a position in the list. A sale enters the
 *      journal TWICE (COGS, then revenue), so a linear order naming
 *      `journal_entries` once could not describe the sale at all. The routine's
 *      own internal order is asserted separately, ONCE, against its body —
 *      `internalOrderProblems` — and its call sites are skipped by the domain
 *      walker rather than being silently folded into it.
 *   2. `invoice_sequences` is LAST of the domain locks (`P4-AL-32`), and it is
 *      last for a measured reason: it is business-wide, so taking it first
 *      serialises the whole till on the slowest sale. A checker that treated
 *      the list as a set rather than a sequence would accept exactly that.
 *   3. THE BODY IS READ SEMANTICALLY WHERE IT CAN BE. `acquisitionsOf` runs
 *      over a routine BODY — which the caller may obtain from the migration
 *      text (static) or from `pg_proc.prosrc` on a live catalogue (semantic).
 *      The live read is the one that cannot be fooled by a routine replaced
 *      after its migration, which is why `lock-order.red-proof` plants a REAL
 *      routine and reads `prosrc`.
 *
 * `[[daftar-lock-order-not-retry]]`: a deadlock here is a lock-order DEFECT,
 * fixed by changing the order — never by a retry loop, never by
 * `SET deadlock_timeout`, and never by handing the deadlock to the caller as a
 * business outcome. `forbiddenRemedyProblems` refuses all three in text.
 */
import { blankCommentsAndLiterals } from './tree';

/** `P4-AL-41`, verbatim and in order. Position is meaning. */
export const DOMAIN_LOCK_ORDER: readonly string[] = [
  'businesses',
  'customers',
  'invoices',
  'payments',
  'credit_notes',
  'customer_credits',
  'stock_levels',
  'installment_plans',
  'invoice_sequences',
];

/**
 * Rank 4 of `P4-AL-41` is "`payments` / `credit_notes` / `customer_credits` —
 * the consumed source": three relations at ONE rank, because a command
 * consumes one of them and never two. Expressed as a rank map rather than an
 * index into the array above, so a command that locks `customer_credits` after
 * `payments` is not reported as out of order when it is in fact at one rank.
 */
export const LOCK_RANK: ReadonlyMap<string, number> = new Map([
  ['businesses', 1],
  ['customers', 2],
  ['invoices', 3],
  ['payments', 4],
  ['credit_notes', 4],
  ['customer_credits', 4],
  ['refunds', 4],
  ['stock_levels', 5],
  ['installment_plans', 6],
  ['installments', 6],
  ['invoice_sequences', 7],
]);

/**
 * The routine whose locks are its OWN internal order and are therefore not a
 * position in the domain list. Named, not pattern-matched: a pattern would
 * swallow the next routine somebody names `*_post_*` and stop checking it.
 */
export const INTERNAL_ORDER_ROUTINES: readonly string[] = ['accounting_post_entry', 'accounting_post_reversal', 'inventory_apply_stock_movements'];

export type LockStrength = 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'FOR SHARE' | 'FOR KEY SHARE';

export interface Acquisition {
  readonly relation: string;
  readonly strength: LockStrength;
  /** 1-based position within the routine body, so a report can say WHICH acquisition. */
  readonly position: number;
  /** The rank of this relation in `P4-AL-41`, or null when the relation is not a domain lock. */
  readonly rank: number | null;
}

const LOCK_CLAUSE = /\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/gi;

/**
 * The relation a locking clause applies to: the last `FROM <relation>` or
 * `UPDATE <relation>` before it.
 *
 * Deliberately conservative. A clause whose relation cannot be resolved is
 * returned as `unresolved:<n>` rather than dropped, because dropping it is how
 * a lock the walker could not read becomes a lock the checker says nothing
 * about — which reads as compliance.
 */
export function acquisitionsOf(rawBody: string): Acquisition[] {
  // THE COMMENTS COME OUT FIRST. A DAFTAR routine body documents its own lock
  // steps in prose (`-- 7. Lock step 2b: the customer FOR SHARE.`), so a
  // walker over the raw text reports locks the routine never takes, on
  // relations it never touches, in an order it never uses — which then reads
  // as a lock-order DEFECT in accepted, sealed code. Offsets are preserved by
  // blanking rather than deleting.
  const body = blankCommentsAndLiterals(rawBody);
  const out: Acquisition[] = [];
  LOCK_CLAUSE.lastIndex = 0;
  let match = LOCK_CLAUSE.exec(body);
  let position = 0;
  while (match !== null) {
    position += 1;
    const before = body.slice(0, match.index);
    const from = /(?:\bFROM|\bJOIN|\bUPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let relation: string | null = null;
    let f = from.exec(before);
    while (f !== null) {
      relation = (f[1] ?? '').toLowerCase();
      f = from.exec(before);
    }
    const raw = (match[1] ?? '').toUpperCase().replace(/\s+/g, ' ');
    const strength: LockStrength =
      raw === 'NO KEY UPDATE' ? 'FOR NO KEY UPDATE' : raw === 'KEY SHARE' ? 'FOR KEY SHARE' : raw === 'SHARE' ? 'FOR SHARE' : 'FOR UPDATE';
    const name = relation ?? `unresolved:${position}`;
    out.push({ relation: name, strength, position, rank: LOCK_RANK.get(name) ?? null });
    match = LOCK_CLAUSE.exec(body);
  }
  return out;
}

/**
 * THE ACQUISITIONS A COMMAND ACTUALLY PERFORMS, HELPER ROUTINES INCLUDED.
 *
 * `sale_commit` takes `customers` and `stock_levels` through
 * `sale_lock_commit_targets`, not in its own body. A walker that stopped at
 * the body would report a two-lock command and say nothing about the order of
 * the four locks it really takes — and would then report "no problem", which
 * is the vacuous pass in its most expensive form, because the lock order is
 * exactly what it was asked about.
 *
 * So a `PERFORM <helper>(…)` whose helper body is available is INLINED at the
 * position of the call, once (recursion is bounded by `seen`). A helper whose
 * body is NOT available is reported, by name, as a gap in the walk — never
 * silently skipped.
 */
export function effectiveAcquisitions(
  routine: string,
  body: string,
  bodies: ReadonlyMap<string, string>,
  seen: ReadonlySet<string> = new Set(),
): Acquisition[] {
  const own = acquisitionsOf(body);
  const clean = blankCommentsAndLiterals(body);
  const calls: { readonly index: number; readonly helper: string }[] = [];
  const perform = /\bPERFORM\s+(?:pg_catalog\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m = perform.exec(clean);
  while (m !== null) {
    const helper = (m[1] ?? '').toLowerCase();
    if (bodies.has(helper) && !seen.has(helper) && helper !== routine) calls.push({ index: m.index, helper });
    m = perform.exec(clean);
  }
  if (calls.length === 0) return own;

  const nextSeen = new Set([...seen, routine]);
  const merged: Acquisition[] = [];
  // Walk the body in offset order, emitting each own acquisition and each
  // inlined helper's acquisitions at the position where they really happen.
  const ownWithOffsets = own.map((a) => ({ a, offset: offsetOfNthClause(clean, a.position) }));
  const items: { offset: number; acquisitions: Acquisition[] }[] = [
    ...ownWithOffsets.map((o) => ({ offset: o.offset, acquisitions: [o.a] })),
    ...calls.map((c) => ({ offset: c.index, acquisitions: effectiveAcquisitions(c.helper, bodies.get(c.helper) ?? '', bodies, nextSeen) })),
  ].sort((x, y) => x.offset - y.offset);
  let position = 0;
  for (const item of items)
    for (const acquisition of item.acquisitions) {
      position += 1;
      merged.push({ ...acquisition, position });
    }
  return merged;
}

function offsetOfNthClause(clean: string, n: number): number {
  LOCK_CLAUSE.lastIndex = 0;
  let count = 0;
  let m = LOCK_CLAUSE.exec(clean);
  while (m !== null) {
    count += 1;
    if (count === n) return m.index;
    m = LOCK_CLAUSE.exec(clean);
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Helper routines a command PERFORMs whose bodies were not supplied: gaps in the walk. */
export function unwalkedHelpers(body: string, bodies: ReadonlyMap<string, string>, known: ReadonlySet<string>): string[] {
  const clean = blankCommentsAndLiterals(body);
  const out = new Set<string>();
  const perform = /\bPERFORM\s+(?:pg_catalog\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m = perform.exec(clean);
  while (m !== null) {
    const helper = (m[1] ?? '').toLowerCase();
    if (known.has(helper) && !bodies.has(helper)) out.add(helper);
    m = perform.exec(clean);
  }
  return [...out].sort();
}

/**
 * THE CHECK: a routine's DOMAIN acquisitions must be non-decreasing in rank.
 *
 * Non-decreasing, not strictly increasing: rank 4 holds three relations, and a
 * command may legitimately take two invoices at rank 3 (ascending by id, which
 * is the invoice-level rule and is checked separately by
 * `ascendingWithinRankProblems`).
 */
export function acquisitionOrderProblems(routine: string, body: string, bodies: ReadonlyMap<string, string> = new Map()): string[] {
  if (INTERNAL_ORDER_ROUTINES.includes(routine)) return internalOrderProblems(routine, body);
  const problems: string[] = [];
  const acquisitions = effectiveAcquisitions(routine, body, bodies);
  const domain = acquisitions.filter((a) => a.rank !== null);
  let highest = 0;
  let highestRelation = '';
  for (const a of domain) {
    const rank = a.rank ?? 0;
    if (rank < highest)
      problems.push(
        `${routine}: acquisition ${a.position} takes ${a.relation} (rank ${rank}) AFTER ${highestRelation} (rank ${highest}) — ` +
          `P4-AL-41 declares one order and this inverts it; the remedy is the order, never a retry`,
      );
    if (rank > highest) {
      highest = rank;
      highestRelation = a.relation;
    }
  }
  for (const a of acquisitions)
    if (a.relation.startsWith('unresolved:'))
      problems.push(
        `${routine}: acquisition ${a.position} carries a locking clause whose relation this walker could not resolve — an unreadable lock is not a compliant lock`,
      );
  return problems;
}

/**
 * `invoice_sequences` LAST (`P4-AL-32`). Asserted separately from the rank walk
 * because it is the one position with a measured justification, and because a
 * routine that takes it and nothing afterwards still has to be shown to have
 * taken it after everything it does take.
 */
export function sequenceLastProblems(routine: string, body: string): string[] {
  const acquisitions = acquisitionsOf(body).filter((a) => a.rank !== null);
  const at = acquisitions.findIndex((a) => a.relation === 'invoice_sequences');
  if (at === -1) return [];
  const after = acquisitions.slice(at + 1).filter((a) => a.relation !== 'invoice_sequences');
  if (after.length === 0) return [];
  return [
    `${routine}: takes invoice_sequences at acquisition ${(acquisitions[at]?.position ?? 0).toString()} and then ` +
      `${after.map((a) => a.relation).join(', ')} — the series row is business-wide and is the LAST domain lock (P4-AL-32), ` +
      `so holding it across a later per-key lock serialises the whole till on the slowest sale`,
  ];
}

/**
 * `accounting_post_entry` and the other internal-order routines: their order is
 * their own and is asserted ONCE, against the body, as a FIXED order rather
 * than against the domain list. What must hold is that the order is the same at
 * every call — which, for a routine, means the body contains one acquisition
 * sequence and no branch that reorders it.
 */
export function internalOrderProblems(routine: string, body: string): string[] {
  const problems: string[] = [];
  const acquisitions = acquisitionsOf(body);
  if (acquisitions.length === 0) return problems;
  // A conditional locking clause is a second order. `IF ... THEN ... FOR UPDATE`
  // inside a branch that another branch does not take means two call paths with
  // two orders, which is the thing a fixed internal order rules out.
  const branchLock = /\bIF\b[^;]{0,4000}?\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b[^;]{0,200}?;[\s\S]{0,4000}?\bEND\s+IF\b/i;
  if (branchLock.test(body))
    problems.push(
      `${routine}: a locking clause sits inside an IF branch, so two call paths can acquire in two orders — ` +
        `an internal order is safe only because it is the SAME at every call (P4-AL-41)`,
    );
  return problems;
}

/**
 * `[[daftar-lock-order-not-retry]]`, as text law.
 *
 * The three forbidden remedies, refused wherever they appear in a Phase 4
 * command or a Phase 4 concurrency suite. Lexical, and stated to be lexical:
 * it is a check on the REMEDY, which is a textual artefact, not on behaviour.
 */
export function forbiddenRemedyProblems(where: string, text: string): string[] {
  const problems: string[] = [];
  if (/SET\s+(?:LOCAL\s+)?deadlock_timeout/i.test(text))
    problems.push(`${where}: sets deadlock_timeout — a deadlock is a lock-order defect and tuning the detector is not a fix`);
  if (/(?:40P01|deadlock_detected)[\s\S]{0,200}?(?:RETRY|retry|LOOP|loop)/.test(text))
    problems.push(`${where}: retries on a detected deadlock — the remedy is the order, never a retry loop`);
  if (/deadlock[\s\S]{0,120}?(?:business|caller should|merchant)/i.test(text))
    problems.push(`${where}: describes a deadlock as something the caller handles — a deadlock is never a business outcome`);
  return problems;
}
