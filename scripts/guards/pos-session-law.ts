/**
 * GUARD P4-G-POS — **ONE TILL SESSION = ONE AUTHENTICATED USER, AND THE RULE
 * IS IN THE SCHEMA** (`OD-P4-09` OPTION A, ruled 2026-09-30; lock
 * `P4-AL-40`, `P4-AL-86`; P4-S3).
 *
 * ── What this law is for ─────────────────────────────────────────────────
 *
 * The till-session service refuses a second user by comparing the session's
 * stored owner with the authenticated principal. That check protects the
 * ROUTE. It does not protect the TABLE, and the difference is the whole
 * subject of this module.
 *
 * `Database.withTransaction` and `Database.scoped`
 * (`apps/api/src/infra/database.ts`) are the merchant process's **trusted
 * generic primitive**: they open one transaction on the `daftar_app` pool,
 * set the tenant, business and actor GUCs, and run whatever SQL the caller
 * hands them. Every read in the estate is built on them and nothing about
 * them is wrong. What they mean is that a rule expressed as an `if` in one
 * service is not inherited by the next writer in the same process — a
 * reporting service, a later slice's cash-movement command, a repair path —
 * and each of those reaches the primitive without reaching that `if`.
 *
 * So `OD-P4-09` has to be a property of the DATA:
 *
 *   `POS-LAW-1`  the session carries ONE owning authenticated user, NOT NULL.
 *                A nullable owner is a shared till with the owner omitted,
 *                which is the refused OPTION B spelled as an absence.
 *   `POS-LAW-2`  that owner is IMMUTABLE at the database, so no writer at all
 *                can re-own a till — `UPDATE pos_till_sessions SET
 *                opened_by_user_id = …` through the generic primitive is
 *                refused by a rule, not by a convention.
 *   `POS-LAW-3`  a write that attaches a basket line to a session owned by a
 *                DIFFERENT authenticated user is refused at the database.
 *   `POS-LAW-4`  OPTION B is UNREPRESENTABLE: no POS relation other than the
 *                session itself carries a per-row actor column. The refused
 *                option was "a shared till session with a per-sale actor",
 *                and a column for it is that option left available to the
 *                next writer — the same reason the selling registry carries
 *                no `sale.partially_committed`.
 *   `POS-LAW-5`  the till is bound to a branch (`P4-AL-40`), NOT NULL, so a
 *                session with no branch cannot exist for a branch-scope
 *                policy to be vacuous about.
 *   `POS-LAW-6`  every `pos.*` refusal the Phase 4 DDL raises is REGISTERED
 *                in the canonical selling registry, so a migration cannot
 *                introduce a refusal the error filter renders as an anonymous
 *                `P0001`.
 *
 * ── NOT-YET-APPLICABLE IS NOT A PASS ─────────────────────────────────────
 *
 * The migration that creates the POS relations is the migration owner's, and
 * this law was written before it landed. `posSessionSubject` therefore reports
 * what it can see, and the suite that drives this law asserts the subject
 * EXPLICITLY and by name rather than letting an empty tree read as compliance.
 * Every rule below is additionally proved able to go red by planting the
 * defect into a COPY of the migrations directory — never the real one, because
 * editing an applied migration breaks every suite with "Migration tampered
 * after apply".
 *
 * ── The relation names are the only literals, and they are checked ───────
 *
 * `pos_till_sessions` and `pos_cart_lines` are fixed by `P4-AL-86` itself, so
 * they are not a guess: they are the names the lock chose precisely so that
 * `FUTURE_SLICE_SURFACES` can refuse Phase 6's public checkout cart by prefix.
 * `POS-LAW-0` requires the `pos_`-prefixed relations the Phase 4 tree actually
 * declares to EQUAL the declared contract, so a third one cannot arrive
 * unexamined and a renamed one is a finding rather than a silent n/a.
 */
import { phase4Sql, readTables } from '../phase4-s1-gate';
import {
  POS_CART_LINES,
  POS_RELATIONS,
  POS_TILL_SESSIONS,
  PER_ROW_ACTOR_VOCABULARY,
  TILL_SESSION_COLUMNS,
} from '../../apps/api/src/modules/pos/pos-session-contract';

/** The `pos_` prefix rule `P4-AL-86` fixed, so the subject is discovered and not listed. */
const POS_PREFIX = /^pos_/;

export interface PosSessionSubject {
  /** Every `pos_`-prefixed relation the Phase 4 migration tree declares, sorted. */
  readonly relations: readonly string[];
  /** True once the tree declares the till-session relation — the point at which every rule below has a subject. */
  readonly applicable: boolean;
  /** Constructs the DDL reader could not parse. Reported, never skipped. */
  readonly unreadable: readonly string[];
}

/** What this law can see in `root`'s Phase 4 migration tree. */
export function posSessionSubject(root: string): PosSessionSubject {
  const { tables, unreadable } = readTables(phase4Sql(root));
  const relations = tables
    .map((t) => t.name)
    .filter((n) => POS_PREFIX.test(n))
    .sort();
  return { relations, applicable: relations.includes(POS_TILL_SESSIONS), unreadable };
}

/** One `CREATE FUNCTION` definition, as its name and its whole text. */
interface Routine {
  readonly name: string;
  readonly text: string;
}

function routines(sql: string): Routine[] {
  const out: Routine[] = [];
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\([\s\S]*?\$\$;/gi)) {
    out.push({ name: (m[1] ?? '').toLowerCase(), text: m[0] });
  }
  return out;
}

/**
 * The relations a `CREATE TRIGGER` whose body executes `routine` fires on,
 * together with the events it fires for. The regex reads the accepted
 * `CREATE TRIGGER name BEFORE <events> ON <relation> … EXECUTE FUNCTION f();`
 * shape of `0077:791-811`.
 */
function triggersExecuting(sql: string, routine: string): { readonly relation: string; readonly events: string }[] {
  const found: { relation: string; events: string }[] = [];
  // The gaps are `[^;]*?` and not `[\\s\\S]*?`, which was a real hole and not a
  // tidying: a gap that may cross a statement terminator lets the engine pair
  // the FIRST `CREATE TRIGGER` in the whole Phase 4 DDL with the LAST
  // `EXECUTE FUNCTION <routine>`, so the relation read out belongs to an
  // unrelated trigger and a correctly-wired rule reads as unwired. A trigger
  // statement carries no `;` until its own end, so the bound is exact.
  const re = new RegExp(
    `CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+[a-z_][a-z0-9_]*\\s+(BEFORE|AFTER|INSTEAD\\s+OF)\\s+([^;]*?)\\s+ON\\s+([a-z_][a-z0-9_]*)\\b([^;]*?)EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+${routine}\\s*\\(`,
    'gi',
  );
  for (const m of sql.matchAll(re)) found.push({ relation: (m[3] ?? '').toLowerCase(), events: `${m[1] ?? ''} ${m[2] ?? ''}`.toUpperCase() });
  return found;
}

/** Every distinct `pos.<something>` code any `RAISE` in the Phase 4 DDL carries. */
export function posCodesRaised(sql: string): string[] {
  return [...new Set([...sql.matchAll(/'(pos\.[a-z_]+)[:'\s]/g)].map((m) => m[1] ?? ''))].filter((c) => c !== '').sort();
}

/**
 * A rule that must hold of the DDL once the subject exists: a routine that
 * raises `code`, wired as a trigger on `relation` for the given events.
 */
function refusalRule(
  sql: string,
  law: string,
  code: string,
  relation: string,
  requiredEvent: RegExp,
  extraCondition: { readonly test: RegExp; readonly why: string } | null,
): string[] {
  const raisers = routines(sql).filter((r) => r.text.includes(`'${code}`));
  if (raisers.length === 0)
    return [`${law}: no Phase 4 routine raises ${code} — the rule is not in the schema, so the trusted generic primitive is not bound by it`];
  const problems: string[] = [];
  if (extraCondition !== null) {
    const satisfying = raisers.filter((r) => extraCondition.test.test(r.text));
    if (satisfying.length === 0) problems.push(`${law}: the routine raising ${code} ${extraCondition.why}`);
  }
  const wired = raisers.flatMap((r) => triggersExecuting(sql, r.name));
  const onRelation = wired.filter((w) => w.relation === relation);
  if (onRelation.length === 0)
    problems.push(
      `${law}: ${raisers.map((r) => r.name).join(', ')} raises ${code} but no trigger executes it on ${relation} — a routine nothing fires refuses nothing`,
    );
  else if (!onRelation.some((w) => requiredEvent.test(w.events)))
    problems.push(
      `${law}: the trigger that enforces ${code} on ${relation} does not fire for ${String(requiredEvent)} — the write it must refuse is not covered`,
    );
  return problems;
}

/**
 * THE LAW. `[]` means every rule with a subject holds; each problem names its
 * own `POS-LAW-n` so a gate's log says WHICH rule refused and not merely that
 * something did.
 *
 * `isRegistered` is injected rather than imported so this module stays a pure
 * reader of the tree: the suite passes the canonical registry's own
 * `isSellingCode`, which is what makes `POS-LAW-6` a statement about the one
 * registry the error filter reads and not about a second list.
 */
export function posSessionLawProblems(root: string, isRegistered: (code: string) => boolean): string[] {
  const sql = phase4Sql(root);
  const subject = posSessionSubject(root);
  const problems: string[] = [];

  // A construct the reader cannot parse is reported, never skipped: a lint
  // that silently ignores what it does not understand passes on the defect it
  // exists to catch.
  for (const u of subject.unreadable) problems.push(`POS-LAW-0: ${u}`);

  // POS-LAW-6 has its own subject — a raised code — and is live whether or not
  // the relations exist, because a migration can raise a refusal before the
  // relation it guards is read by anything else.
  for (const code of posCodesRaised(sql))
    if (!isRegistered(code))
      problems.push(
        `POS-LAW-6: the Phase 4 DDL raises ${code}, which the canonical selling registry does not classify — an unregistered refusal is rendered as an anonymous P0001 with the historical 403 fallback, not as its own contract`,
      );

  if (!subject.applicable) return problems;

  // POS-LAW-0: the discovered surface equals the declared contract.
  const declared = [...POS_RELATIONS].sort();
  const extra = subject.relations.filter((r) => !declared.includes(r));
  const missing = declared.filter((r) => !subject.relations.includes(r));
  for (const r of extra)
    problems.push(`POS-LAW-0: ${r} is a pos_ relation no POS contract declares — the till-session law has not been applied to it (P4-AL-86)`);
  for (const r of missing) problems.push(`POS-LAW-0: the POS contract declares ${r} and the Phase 4 tree does not create it`);

  const till = readTables(sql).tables.find((t) => t.name === POS_TILL_SESSIONS);
  if (till === undefined) return problems; // unreachable while `applicable`, but a null check is not an assumption.

  // POS-LAW-1 / POS-LAW-5: the owner and the branch, present and NOT NULL.
  // The NOT NULL is read from the column's own item text, so a column
  // declared nullable and "always set by the service" is a finding.
  const item = (column: string): string | undefined => {
    const m = new RegExp(`(?:^|,)\\s*"?${column}"?\\s+([^,]*)`, 'i').exec(till.body);
    return m === null ? undefined : `${column} ${m[1] ?? ''}`;
  };
  for (const [law, column, why] of [
    ['POS-LAW-1', TILL_SESSION_COLUMNS.owner, 'the one authenticated user the session belongs to (OD-P4-09 OPTION A)'],
    ['POS-LAW-5', TILL_SESSION_COLUMNS.branch, 'the branch the till is bound to (P4-AL-40)'],
  ] as const) {
    const text = item(column);
    if (text === undefined) {
      problems.push(`${law}: ${POS_TILL_SESSIONS} declares no ${column} — ${why}`);
      continue;
    }
    if (!/\bNOT\s+NULL\b/i.test(text))
      problems.push(`${law}: ${POS_TILL_SESSIONS}.${column} is nullable — ${why}, and an absent one is the refused option spelled as an absence`);
  }

  // POS-LAW-2: the owner is immutable, by a database rule, on UPDATE.
  problems.push(
    ...refusalRule(sql, 'POS-LAW-2', 'pos.session_owner_immutable', POS_TILL_SESSIONS, /UPDATE/, {
      test: new RegExp(`\\b(?:NEW|OLD)\\.${TILL_SESSION_COLUMNS.owner}\\b`, 'i'),
      why: `never compares NEW.${TILL_SESSION_COLUMNS.owner} with OLD.${TILL_SESSION_COLUMNS.owner}, so it is not the immutability rule`,
    }),
  );

  // POS-LAW-3: a basket line written into another authenticated user's till is
  // refused at the database. The routine must read the ACTOR — the GUC the
  // generic primitive sets from the authenticated principal — because a rule
  // that reads only the row cannot tell whose till it is.
  if (subject.relations.includes(POS_CART_LINES))
    problems.push(
      ...refusalRule(sql, 'POS-LAW-3', 'pos.session_not_owned', POS_CART_LINES, /INSERT/, {
        test: /app\.actor_user_id/i,
        why: 'never reads app.actor_user_id, so it cannot tell which authenticated user is writing',
      }),
    );

  // POS-LAW-4: OPTION B is unrepresentable. The exemption is the PAIR
  // (relation, column) and not the column name: a relation-blind exemption
  // would let a cart line carry an `opened_by_user_id` of its own and call it
  // compliant.
  for (const table of readTables(sql).tables.filter((t) => POS_PREFIX.test(t.name)))
    for (const column of table.columns) {
      if (!PER_ROW_ACTOR_VOCABULARY.test(column)) continue;
      if (table.name === POS_TILL_SESSIONS && column === TILL_SESSION_COLUMNS.owner) continue;
      problems.push(
        `POS-LAW-4: ${table.name}.${column} is a per-row actor on a POS relation — OD-P4-09 refused OPTION B (a shared till with a per-sale actor), and a column for it leaves that option available to the next writer`,
      );
    }

  return problems;
}
