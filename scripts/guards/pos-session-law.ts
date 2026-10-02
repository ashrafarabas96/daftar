/**
 * GUARD P4-G-POS — **ONE TILL SESSION = ONE AUTHENTICATED USER, AND THE RULE
 * IS IN THE SCHEMA** (`OD-P4-09` OPTION A, ruled 2026-09-30; lock
 * `P4-AL-40`, `P4-AL-86`; P4-S3).
 *
 * ── What this law is for ─────────────────────────────────────────────────
 *
 * `Database.withTransaction` and `Database.scoped`
 * (`apps/api/src/infra/database.ts`) are the merchant process's **trusted
 * generic primitive**: they open one transaction on the `daftar_app` pool, set
 * the tenant, business and actor GUCs, and run whatever SQL the caller hands
 * them. Every read in the estate is built on them and nothing about them is
 * wrong. What they mean is that a rule expressed as an `if` in one service is
 * not inherited by the next writer in the same process.
 *
 * So `OD-P4-09` has to be a property of the DATA. This law checks that it is.
 *
 * ── The mechanism this law checks is the SCHEMA'S, not one it assumed ────
 *
 * The first version of this module required a trigger that read
 * `app.actor_user_id` and raised a code this module had invented. `0079` does
 * something stronger and different, and the migration is the truth:
 *
 *   `POS-LAW-1`  the session carries ONE owning authenticated user —
 *                `opened_by`, `NOT NULL`. A nullable owner is a shared till
 *                with the owner omitted, which is the refused OPTION B
 *                spelled as an absence.
 *   `POS-LAW-2`  that owner is IMMUTABLE, by a trigger-wired routine on the
 *                session relation that compares `NEW.opened_by` with
 *                `OLD.opened_by` and RAISEs. The check is on the MECHANISM
 *                and never on the code's NAME, so the rename the coordinator
 *                ruled through does not move this law.
 *   `POS-LAW-3`  a basket line CANNOT belong to another user, by REFERENTIAL
 *                INTEGRITY: `pos_cart_lines (business_id, till_session_id,
 *                added_by)` references `pos_till_sessions (business_id, id,
 *                opened_by)`. A line added by any user but the session's own
 *                has no parent row to point at, so the refusal binds
 *                `daftar_inventory_internal` — the trusted principal every
 *                till command runs as — and not merely the service.
 *   `POS-LAW-4`  OPTION B stays UNREPRESENTABLE: a per-row actor column on a
 *                POS relation is a finding unless its (relation, column) pair
 *                is exempt AND every fact its exemption rests on still holds.
 *   `POS-LAW-5`  the till is bound to a branch and a warehouse (`P4-AL-40`),
 *                both `NOT NULL`.
 *   `POS-LAW-6`  the refusal contract, in BOTH directions — see below.
 *
 * ── POS-LAW-6: reachability is STRUCTURAL, because a name list is a trap ──
 *
 * `0079` RAISEs fifteen `pos.*` codes and they are not one kind of thing.
 * Twelve are runtime refusals a request can meet and must be classified by the
 * canonical registry, or the error filter renders them as an anonymous
 * `P0001` with the historical 403 fallback. THREE — `pos.authority_leak`,
 * `pos.derived_truth_stored`, `pos.migration_end_state_invalid` — are
 * migration-time end-state assertions that fire only while the migration
 * applies. Registering one would demand merchant text for a build-time
 * assertion, and whoever met that demand would put an end-state sentence on a
 * cashier's screen.
 *
 * A hand-written list of those three would be the exact trap this module has
 * already fallen into once: `PER_ROW_ACTOR_VOCABULARY` named three verbs and
 * `0079`'s real `added_by` walked straight through it. So the split is
 * DERIVED, from three facts in the text:
 *
 *   - a code raised inside a `CREATE FUNCTION` body is raised by a ROUTINE;
 *   - a routine is REACHABLE when some role holds `GRANT EXECUTE` on it, or
 *     when a `CREATE TRIGGER` executes it. The second arm is not a
 *     convenience: `pos_till_session_guard()` and `pos_cart_line_guard()`
 *     carry no `GRANT EXECUTE` at all, and they still fire inside the
 *     request's own transaction whenever a granted command writes their
 *     relation. A rule that tested grants alone would classify both guards as
 *     build-time and would have excused exactly the refusals a merchant can
 *     meet. It is the same reading `selling-errors.ts` already applies to
 *     `selling.source_document_immutable`, a trigger nothing grants;
 *   - a code raised nowhere inside any routine body is raised from a `DO`
 *     block or at top level, which runs only while the migration applies.
 *
 * REACHABILITY WINS when a code is raised in both places, so moving a
 * build-time code into a granted routine's body starts demanding it, with no
 * edit here. That is the inversion the suite red-proves.
 *
 * ── NOT-YET-APPLICABLE IS NOT A PASS ─────────────────────────────────────
 *
 * This law reads the migrations DIRECTORY. On a tree without `0079` it has no
 * subject, and a check with no subject proves nothing. Two things answer that,
 * and neither is a claim about the future: the subject is REPORTED by name,
 * and every rule is exercised against a PLANTED tree in which the subject
 * exists — the compliant DDL for the silence case, one specific defect for
 * each red case. The planting is done in a COPY of the migrations directory,
 * never the real one, and the planted file's number is DERIVED from the head
 * on disk, so this module writes down no migration number.
 */
import { phase4Sql, readTables } from '../phase4-s1-gate';
import {
  ACTOR_COLUMN_EXEMPTIONS,
  PER_ROW_ACTOR_VOCABULARY,
  POS_CART_LINES,
  POS_RELATIONS,
  POS_TILL_SESSIONS,
  TILL_SESSION_COLUMNS,
} from '../../apps/api/src/modules/pos/pos-session-contract';

/** The `pos_` prefix rule `P4-AL-86` fixed, so the subject is discovered and not listed. */
const POS_PREFIX = /^pos_/;

export interface PosSessionSubject {
  /** Every `pos_`-prefixed relation the Phase 4 migration tree declares, sorted. */
  readonly relations: readonly string[];
  /** True once the tree declares the till-session relation — the point at which every rule has a subject. */
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

// ── The narrow readers ────────────────────────────────────────────────────

interface Routine {
  readonly name: string;
  readonly text: string;
}

/** Every `CREATE [OR REPLACE] FUNCTION name(...) … $$;` definition, as its name and its whole text. */
function routines(sql: string): Routine[] {
  const out: Routine[] = [];
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\([\s\S]*?\$\$;/gi)) {
    out.push({ name: (m[1] ?? '').toLowerCase(), text: m[0] });
  }
  return out;
}

/** The routines some role holds `GRANT EXECUTE` on. */
function grantedRoutines(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)) out.add((m[1] ?? '').toLowerCase());
  return out;
}

/**
 * The relations a `CREATE TRIGGER` executing `routine` fires on, and the events
 * it fires for.
 *
 * The gaps are `[^;]*?` and not `[\s\S]*?`, which was a real hole and not a
 * tidying: a gap that may cross a statement terminator lets the engine pair the
 * FIRST `CREATE TRIGGER` in the whole Phase 4 DDL with the LAST
 * `EXECUTE FUNCTION <routine>`, so the relation read out belongs to an
 * unrelated trigger and a correctly-wired rule reads as unwired. A trigger
 * statement carries no `;` until its own end, so the bound is exact.
 */
function triggersExecuting(sql: string, routine: string): { readonly relation: string; readonly events: string }[] {
  const found: { relation: string; events: string }[] = [];
  const re = new RegExp(
    `CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+[a-z_][a-z0-9_]*\\s+(BEFORE|AFTER|INSTEAD\\s+OF)\\s+([^;]*?)\\s+ON\\s+([a-z_][a-z0-9_]*)\\b([^;]*?)EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+${routine}\\s*\\(`,
    'gi',
  );
  for (const m of sql.matchAll(re)) found.push({ relation: (m[3] ?? '').toLowerCase(), events: `${m[1] ?? ''} ${m[2] ?? ''}`.toUpperCase() });
  return found;
}

/** Every routine any `CREATE TRIGGER` executes. */
function triggerRoutines(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+[^;]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-z_][a-z0-9_]*)\s*\(/gi))
    out.add((m[1] ?? '').toLowerCase());
  return out;
}

/**
 * Every `pos.<code>` a `RAISE` in `text` carries.
 *
 * The COLON is required, and that is what keeps the discovery honest: an
 * operation code (`inventory_assertion_consume('pos.session_open', …)`) and an
 * audit action (`'pos.till_session_opened'`) are `pos.`-prefixed strings that
 * are not refusals at all, and an earlier form of this reader demanded
 * registry rows for both.
 */
function raisedPosCodes(text: string): string[] {
  return [...new Set([...text.matchAll(/RAISE\s+EXCEPTION\s+'(pos\.[a-z_]+):/gi)].map((m) => (m[1] ?? '').toLowerCase()))].sort();
}

/** The reachable and the build-time `pos.*` refusal vocabularies of a tree, derived. */
export interface PosRefusalReachability {
  /** Raised by a routine some role can execute, or that a trigger fires. A request can meet one. */
  readonly reachable: readonly string[];
  /** Raised only outside every routine body — a `DO` block or top level — so only while the migration applies. */
  readonly buildTime: readonly string[];
  /** The reachable routines, for the diagnostic. */
  readonly reachableRoutines: readonly string[];
}

export function posRefusalReachability(sql: string): PosRefusalReachability {
  const all = routines(sql);
  const granted = grantedRoutines(sql);
  const triggered = triggerRoutines(sql);
  const reachableRoutines = all.filter((r) => granted.has(r.name) || triggered.has(r.name));
  const reachable = new Set(reachableRoutines.flatMap((r) => raisedPosCodes(r.text)));
  const inAnyRoutine = new Set(all.flatMap((r) => raisedPosCodes(r.text)));
  // Reachability wins: a code raised both in a `DO` block and in a reachable
  // routine is reachable, so an end-state code moved into a command's body
  // starts being demanded with no edit to this module.
  const buildTime = raisedPosCodes(sql).filter((c) => !inAnyRoutine.has(c));
  return {
    reachable: [...reachable].sort(),
    buildTime: buildTime.sort(),
    reachableRoutines: reachableRoutines.map((r) => r.name).sort(),
  };
}

// ── The exemption facts ───────────────────────────────────────────────────

/** The `UPDATE (<columns>)` grant on `relation`, or null when the relation has no column-level UPDATE grant. */
function updateGrantColumns(sql: string, relation: string): string[] | null {
  const re = new RegExp(`GRANT\\s+UPDATE\\s*\\(([^)]*)\\)\\s+ON\\s+${relation}\\b`, 'i');
  const inner = re.exec(sql)?.[1];
  if (inner === undefined) return null;
  return inner
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter((c) => c !== '');
}

const identifierList = (text: string): string[] =>
  text
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));

/** True when `constraints` carry a FOREIGN KEY whose column lists and parent are exactly these, in order. */
function hasCompositeEdge(
  constraints: readonly string[],
  childColumns: readonly string[],
  parentRelation: string,
  parentColumns: readonly string[],
): { readonly found: boolean; readonly onUpdateRestrict: boolean } {
  for (const c of constraints) {
    const m = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*)/i.exec(c);
    if (m === null) continue;
    if ((m[2] ?? '').toLowerCase() !== parentRelation) continue;
    const child = identifierList(m[1] ?? '');
    const parent = identifierList(m[3] ?? '');
    if (child.join(',') !== childColumns.join(',') || parent.join(',') !== parentColumns.join(',')) continue;
    return { found: true, onUpdateRestrict: /ON\s+UPDATE\s+RESTRICT/i.test(m[4] ?? '') };
  }
  return { found: false, onUpdateRestrict: false };
}

/** True when `constraints` carry a UNIQUE over exactly these columns, in order. */
function hasUniqueTarget(constraints: readonly string[], columns: readonly string[]): boolean {
  for (const c of constraints) {
    const m = /\bUNIQUE\s*\(([^)]*)\)/i.exec(c);
    if (m === null) continue;
    if (identifierList(m[1] ?? '').join(',') === columns.join(',')) return true;
  }
  return false;
}

// ── The law ───────────────────────────────────────────────────────────────

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

  // ── POS-LAW-6, both directions. Its subject is a RAISED code, so it is
  //    live whether or not the relations exist.
  const reach = posRefusalReachability(sql);
  for (const code of reach.reachable)
    if (!isRegistered(code))
      problems.push(
        `POS-LAW-6a: ${code} is raised by a reachable routine (one of ${reach.reachableRoutines.join(', ')}) and the canonical selling registry does not classify it — a request can meet it, and an unregistered refusal is rendered as an anonymous P0001 with the historical 403 fallback instead of its own contract`,
      );
  for (const code of reach.buildTime)
    if (isRegistered(code))
      problems.push(
        `POS-LAW-6b: ${code} is raised only outside every routine body, so it fires while the migration applies and no request can reach it — registering it demands merchant text for a build-time assertion, and whoever supplies that text puts an end-state sentence on a cashier's screen`,
      );

  if (!subject.applicable) return problems;

  // ── POS-LAW-0: the discovered surface equals the declared contract.
  const declared = [...POS_RELATIONS].sort();
  for (const r of subject.relations.filter((x) => !declared.includes(x)))
    problems.push(`POS-LAW-0: ${r} is a pos_ relation no POS contract declares — the till-session law has not been applied to it (P4-AL-86)`);
  for (const r of declared.filter((x) => !subject.relations.includes(x)))
    problems.push(`POS-LAW-0: the POS contract declares ${r} and the Phase 4 tree does not create it`);

  const tables = readTables(sql).tables;
  const till = tables.find((t) => t.name === POS_TILL_SESSIONS);
  if (till === undefined) return problems; // unreachable while `applicable`; a null check is not an assumption.

  // ── POS-LAW-1 / POS-LAW-5: the owner, the branch and the warehouse,
  //    present and NOT NULL. The NOT NULL is read from the column's own item
  //    text, so a column declared nullable and "always set by the command" is
  //    a finding.
  const item = (column: string): string | undefined => {
    const m = new RegExp(`(?:^|,)\\s*"?${column}"?\\s+([^,]*)`, 'i').exec(till.body);
    return m === null ? undefined : `${column} ${m[1] ?? ''}`;
  };
  for (const [law, column, why] of [
    ['POS-LAW-1', TILL_SESSION_COLUMNS.owner, 'the one authenticated user the session belongs to (OD-P4-09 OPTION A)'],
    ['POS-LAW-5', TILL_SESSION_COLUMNS.branch, 'the branch the till is bound to (P4-AL-40)'],
    ['POS-LAW-5', TILL_SESSION_COLUMNS.warehouse, 'the warehouse the till sells out of, and the one the minting side branch-scope checks (P4-AL-40)'],
  ] as const) {
    const text = item(column);
    if (text === undefined) {
      problems.push(`${law}: ${POS_TILL_SESSIONS} declares no ${column} — ${why}`);
      continue;
    }
    if (!/\bNOT\s+NULL\b/i.test(text))
      problems.push(`${law}: ${POS_TILL_SESSIONS}.${column} is nullable — ${why}, and an absent one is the refused option spelled as an absence`);
  }

  // ── POS-LAW-2: the owner is immutable, by a REACHABLE routine on the
  //    session relation that fires for UPDATE and compares the two versions
  //    of the owner. The CODE's NAME is deliberately not part of this claim:
  //    the mechanism is what makes the rule true, and a law that pinned the
  //    name would have gone red for a rename that changed no behaviour.
  const owner = TILL_SESSION_COLUMNS.owner;
  const comparesOwner = new RegExp(`NEW\\.${owner}\\b[\\s\\S]{0,80}?OLD\\.${owner}\\b|OLD\\.${owner}\\b[\\s\\S]{0,80}?NEW\\.${owner}\\b`, 'i');
  const immutability = routines(sql).filter(
    (r) =>
      comparesOwner.test(r.text) && /RAISE\s+EXCEPTION\s+'pos\./i.test(r.text) && triggersExecuting(sql, r.name).some((t) => t.relation === POS_TILL_SESSIONS),
  );
  if (immutability.length === 0)
    problems.push(
      `POS-LAW-2: no trigger-wired routine on ${POS_TILL_SESSIONS} compares NEW.${owner} with OLD.${owner} and raises — nothing then stops a writer re-owning a till, and the trusted generic primitive is not bound by the rule`,
    );
  else if (!immutability.some((r) => triggersExecuting(sql, r.name).some((t) => t.relation === POS_TILL_SESSIONS && /UPDATE/.test(t.events))))
    problems.push(`POS-LAW-2: the routine that guards ${owner} is not fired for UPDATE on ${POS_TILL_SESSIONS} — the write it exists to refuse is not covered`);

  // ── POS-LAW-3 / POS-LAW-4: the per-row actor vocabulary, and every exempt
  //    pair's facts.
  //
  //    The exemption is the PAIR (relation, column) and never the column name:
  //    a relation-blind exemption would let a third relation carry an
  //    `added_by` of its own and call itself compliant.
  const exemptionFor = (relation: string, column: string) => ACTOR_COLUMN_EXEMPTIONS.find((e) => e.relation === relation && e.column === column);
  for (const table of tables.filter((t) => POS_PREFIX.test(t.name)))
    for (const column of table.columns) {
      if (!PER_ROW_ACTOR_VOCABULARY.test(column)) continue;
      const exemption = exemptionFor(table.name, column);
      if (exemption === undefined) {
        problems.push(
          `POS-LAW-4: ${table.name}.${column} is a per-row actor on a POS relation and no exempt pair covers it — OD-P4-09 refused OPTION B (a shared till with a per-sale actor), and a column nothing forbids from disagreeing with the session's owner leaves that option available to the next writer`,
        );
        continue;
      }
      // The exemption holds only while the facts it was granted on hold. Each
      // one is checked, because the moment any of them stops being true the
      // column really IS the refused option.
      if (exemption.edge !== null) {
        const edge = hasCompositeEdge(table.constraints, exemption.edge.childColumns, exemption.edge.parentRelation, exemption.edge.parentColumns);
        if (!edge.found)
          problems.push(
            `POS-LAW-3: ${table.name}.${column} is exempt only while (${exemption.edge.childColumns.join(', ')}) references ${exemption.edge.parentRelation} (${exemption.edge.parentColumns.join(', ')}), and that edge is absent — without it OD-P4-09 is a service convention and the trusted generic principal can write a line on another user's session`,
          );
        else if (!edge.onUpdateRestrict)
          problems.push(
            `POS-LAW-3: the actor edge on ${table.name} is not ON UPDATE RESTRICT, so the session's user could be swapped out from under an existing basket`,
          );
      }
      if (exemption.uniqueTarget !== null) {
        const parent = tables.find((t) => t.name === (exemption.edge?.parentRelation ?? exemption.relation));
        if (parent === undefined || !hasUniqueTarget(parent.constraints, exemption.uniqueTarget))
          problems.push(
            `POS-LAW-3: ${exemption.edge?.parentRelation ?? exemption.relation} carries no UNIQUE (${exemption.uniqueTarget.join(', ')}) candidate key, so OD-P4-09's actor edge is not expressible at all and ${table.name}.${column}'s exemption rests on nothing`,
          );
      }
      if (exemption.excludedFromUpdateGrant) {
        const granted = updateGrantColumns(sql, table.name);
        if (granted !== null && granted.includes(column))
          problems.push(
            `POS-LAW-3: ${column} is in ${table.name}'s UPDATE column grant, so the copy can be revised away from its parent after the insert and the composite key no longer forbids it from disagreeing`,
          );
      }
    }

  // The cart relation must actually be there for POS-LAW-3 to have had a
  // subject. Reported, so a tree that creates the session and not the basket
  // is not silently a pass for the actor edge.
  if (!subject.relations.includes(POS_CART_LINES))
    problems.push(
      `POS-LAW-3: the Phase 4 tree creates ${POS_TILL_SESSIONS} and not ${POS_CART_LINES}, so OD-P4-09's actor edge has no subject to be checked on`,
    );

  return problems;
}
