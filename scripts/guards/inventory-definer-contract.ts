/**
 * Guard G-7 (P3-S1, P3-AL-54 §D) — every routine handed to
 * `daftar_inventory_internal` is an elevated routine written to the one shape
 * that is safe to elevate.
 *
 * ── What the contract is ─────────────────────────────────────────────────
 *
 * `daftar_inventory_internal` owns the inventory authority: the invctl/1
 * verifier, the key store, the three entry routines and the branch–warehouse
 * lifecycle triggers. A function it owns runs with its privileges whenever it
 * is SECURITY DEFINER, so each one must:
 *
 *   1. be SECURITY DEFINER — except exactly the two column guards below;
 *   2. pin `search_path = pg_catalog, public, pg_temp`, in that order;
 *   3. have PUBLIC's default EXECUTE revoked in the same file;
 *   4. never be granted to PUBLIC;
 *   5. never build SQL at run time (`EXECUTE`) or create a session relation;
 *   6. keep that shape: no later `ALTER FUNCTION` may reset its path or turn
 *      it into an invoker routine.
 *
 * And every file that hands a routine over must take the ownership-transfer
 * authority (`GRANT CREATE ON SCHEMA public`) before the first transfer and
 * return it (`REVOKE CREATE ON SCHEMA public`) after the last.
 *
 * ── The two asserted exceptions ──────────────────────────────────────────
 *
 * `products_10_inventory_config_authority` and
 * `product_variants_10_base_variant_authority` (0053) are SECURITY INVOKER by
 * design: they decide by `current_user` whether a write to an inventory
 * column comes from the internal principal, and a definer would always see
 * its owner there. They are named here, not pattern-matched: each must exist,
 * must be invoker, and must still pin the path. A third invoker routine is a
 * violation until someone adds its name here with a reason.
 *
 * ── Why text, when the catalogue is the truth ────────────────────────────
 *
 * The live half of §D is the catalogue sweep in
 * tests/security/search-path-shadowing.test.ts, which reads `pg_proc` for
 * every function the role owns. This half fails on a pull request, before any
 * server exists, and names the file a reviewer must look at.
 *
 * ── Every definition, not the last one (P3-S2, contract §7.2) ────────────
 *
 * 0060 replaces `inventory_configure_product` with `CREATE OR REPLACE`
 * issued under `SET LOCAL ROLE daftar_inventory_internal`. Reading only the
 * LAST definition of each routine would have made every check of the 0055
 * definition vacuous from that day on — a regression there would pass
 * because a later file happens to be correct. So every `CREATE FUNCTION` of
 * a transferred routine, in every file, must itself satisfy 1, 2 and 5.
 *
 * A routine CREATED while the migration runs as the principal (`SET [LOCAL]
 * ROLE daftar_inventory_internal` … `RESET ROLE`) is owned by it exactly as
 * if it had been transferred, so it is a handover too: it must sit inside
 * the CREATE bracket, and it needs its own same-file `REVOKE … FROM PUBLIC`
 * unless it is a `CREATE OR REPLACE` of a routine handed over in an EARLIER
 * file and not dropped in this one — a replacement issued by the owner keeps
 * the ACL it already had.
 */

import { parseRoutines, pathSchemas } from './definer-search-path';
import { stripComments } from './sql-schema';

export const INVENTORY_INTERNAL = 'daftar_inventory_internal';

/** The only routines the inventory principal may own as SECURITY INVOKER. */
export const INVENTORY_INVOKER_EXCEPTIONS: readonly string[] = ['products_10_inventory_config_authority', 'product_variants_10_base_variant_authority'];

export const INVENTORY_SEARCH_PATH: readonly string[] = ['pg_catalog', 'public', 'pg_temp'];

const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';

/**
 * Security review L-1: a routine is a FUNCTION or a PROCEDURE, `ALTER ROUTINE`
 * names either, a name may be quoted or schema-qualified (either part
 * quoted), the argument list of an `ALTER` is optional, and a role name may
 * be quoted. Each reader below accepts every spelling, so no spelling hands a
 * routine over unseen.
 */
const ROUTINE_KIND = '(?:FUNCTION|PROCEDURE|ROUTINE)';
/** Any schema, so that a qualified spelling is never missed where missing it would hide a handover or a grant. */
const ANY_SCHEMA = '(?:(?:"[^"]+"|[A-Za-z_][\\w$]*)\\s*\\.\\s*)?';
/** Only `public`, where accepting another schema would credit a protection to the wrong object. */
const PUBLIC_SCHEMA = '(?:"?public"?\\s*\\.\\s*)?';
/** An optional argument list: `ALTER FUNCTION f OWNER TO …` is valid when `f` is unique. */
const OPTIONAL_ARGS = '(?:\\s*\\([^;]*?\\))?';
const INTERNAL = `"?${INVENTORY_INTERNAL}"?`;

const DEFINITION_HEADER = /CREATE\s+(OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;

/** The routine names in a `ON FUNCTION a(…), b(…)` list, argument lists removed. */
function routineNames(list: string, schema: string): string[] {
  let flat = '';
  let depth = 0;
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0) flat += ch;
  }
  const names: string[] = [];
  for (const item of flat.split(',')) {
    const m = new RegExp(`^\\s*${schema}${IDENT}\\s*$`).exec(item);
    if (m) names.push((m[1] ?? '').toLowerCase());
  }
  return names;
}

/** One `CREATE FUNCTION` in one file, with the options and body the guard reads. */
export interface InventoryRoutineDefinition {
  readonly name: string;
  /** Base name of the migration file. */
  readonly file: string;
  /** Offset of the `CREATE` in the comment-stripped file text. */
  readonly offset: number;
  readonly orReplace: boolean;
  readonly securityDefiner: boolean;
  readonly searchPath: string | null;
  /** The body text (string body, or the SQL-standard body), or null when none can be read. */
  readonly body: string | null;
  /** Offset just past the definition's body in the comment-stripped file text. */
  readonly end: number;
  /** True when the definition runs while the migration has assumed the principal's role. */
  readonly createdAsInternal: boolean;
}

/** The body that starts at `from` (just after a routine header), and the offset where it ends; null when unreadable. */
function readBody(sql: string, from: number): { body: string; end: number } | null {
  const rest = sql.slice(from);
  const start = /\$([A-Za-z_]*)\$|\bAS\s+'|\bRETURN\b|\bBEGIN\s+ATOMIC\b/i.exec(rest);
  if (!start) return null;
  const token = start[0];
  const at = start.index + token.length;
  if (token.startsWith('$')) {
    const close = rest.indexOf(token, at);
    return close < 0 ? null : { body: rest.slice(at, close), end: from + close + token.length };
  }
  if (/^AS/i.test(token)) {
    let j = at;
    while (j < rest.length) {
      if (rest[j] === "'" && rest[j + 1] === "'") j += 2;
      else if (rest[j] === "'") return { body: rest.slice(at, j), end: from + j + 1 };
      else j += 1;
    }
    return null;
  }
  if (/^RETURN/i.test(token)) {
    const end = rest.indexOf(';', at);
    return end < 0 ? null : { body: rest.slice(start.index, end), end: from + end };
  }
  const end = /\bEND\s*;/i.exec(rest.slice(at));
  return end ? { body: rest.slice(start.index, at + end.index), end: from + at + end.index + end[0].length } : null;
}

/** `[from, to)` windows of a file during which it runs as the inventory principal. */
function internalRoleWindows(sql: string): [number, number][] {
  const windows: [number, number][] = [];
  // SET ROLE and SET SESSION AUTHORIZATION, the role quoted or as a literal,
  // and `set_config('role', …)`: each makes the migration run as that role.
  const setRole =
    /\bSET\s+(?:LOCAL\s+|SESSION\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?|\bset_config\s*\(\s*'role'\s*,\s*'([A-Za-z_][A-Za-z0-9_]*)'|\bRESET\s+(?:ROLE|SESSION\s+AUTHORIZATION)\b/gi;
  let open: number | null = null;
  for (const m of sql.matchAll(setRole)) {
    const at = m.index ?? 0;
    const role = (m[1] ?? m[2] ?? '').toLowerCase();
    if (open !== null) {
      windows.push([open, at]);
      open = null;
    }
    if (role === INVENTORY_INTERNAL) open = at;
  }
  if (open !== null) windows.push([open, sql.length]);
  return windows;
}

/** Every `CREATE FUNCTION` in every migration, in apply order. */
export function inventoryRoutineDefinitions(migrations: Readonly<Record<string, string>>): InventoryRoutineDefinition[] {
  const out: InventoryRoutineDefinition[] = [];
  for (const path of Object.keys(migrations).sort()) {
    const file = path.split('/').pop() ?? path;
    const sql = stripComments(migrations[path] ?? '');
    const windows = internalRoleWindows(sql);
    for (const m of sql.matchAll(DEFINITION_HEADER)) {
      const offset = m.index ?? 0;
      const name = (m[2] ?? '').toLowerCase();
      const afterHeader = offset + m[0].length;
      // Re-read the options with the shared G-5 parser, on the header written
      // unqualified so that parser sees this routine and not the next one.
      const header = parseRoutines(`CREATE FUNCTION ${name}(${sql.slice(afterHeader)}`)[0];
      const body = readBody(sql, afterHeader);
      out.push({
        name,
        file,
        offset,
        orReplace: m[1] !== undefined,
        securityDefiner: header?.securityDefiner ?? false,
        searchPath: header?.searchPath ?? null,
        body: body?.body ?? null,
        end: body?.end ?? afterHeader,
        createdAsInternal: windows.some(([from, to]) => offset > from && offset < to),
      });
    }
  }
  return out;
}

export interface InventoryDefinerSources {
  /** Migration file path → contents, every file (frozen ones included). */
  readonly migrations: Readonly<Record<string, string>>;
}

export interface InventoryDefinerReport {
  readonly violations: string[];
  /** Every routine the migrations hand to the inventory principal. */
  readonly transferred: string[];
}

export function checkInventoryDefinerContract(src: InventoryDefinerSources): InventoryDefinerReport {
  const v: string[] = [];
  const files = Object.keys(src.migrations).sort();
  const definitions = inventoryRoutineDefinitions(src.migrations);

  // Every file that revokes PUBLIC's EXECUTE on a routine, by routine name.
  const revoked = new Map<string, Set<string>>();
  // Routine → the files that hand it over (by ALTER … OWNER TO, or by
  // creating it as the principal), in apply order.
  const handovers = new Map<string, string[]>();
  const handOver = (name: string, file: string) => {
    const list = handovers.get(name) ?? [];
    if (!list.includes(file)) list.push(file);
    handovers.set(name, list);
  };

  for (const path of files) {
    const file = path.split('/').pop() ?? path;
    const sql = stripComments(src.migrations[path] ?? '');

    for (const m of sql.matchAll(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+${ROUTINE_KIND}\\s+([^;]*?)\\s+FROM\\s+PUBLIC\\s*;`, 'gi'))) {
      for (const name of routineNames(m[1] ?? '', PUBLIC_SCHEMA)) {
        const set = revoked.get(name) ?? new Set<string>();
        set.add(file);
        revoked.set(name, set);
      }
    }

    // A bulk reassignment hands over routines no statement names (L-1).
    if (new RegExp(`\\bREASSIGN\\s+OWNED\\s+BY\\s+[^;]*?\\bTO\\s+${INTERNAL}`, 'i').test(sql)) {
      v.push(`${file}: REASSIGN OWNED … TO ${INVENTORY_INTERNAL} hands over routines no statement names — transfer each one explicitly (§D)`);
    }

    // Ownership handovers, and the CREATE bracket around them.
    const transfer = new RegExp(`ALTER\\s+${ROUTINE_KIND}\\s+${ANY_SCHEMA}${IDENT}${OPTIONAL_ARGS}\\s*OWNER\\s+TO\\s+${INTERNAL}\\s*;`, 'gi');
    const spans: [number, number][] = [];
    for (const m of sql.matchAll(transfer)) {
      handOver((m[1] ?? '').toLowerCase(), file);
      spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
    for (const d of definitions) {
      if (d.file !== file || !d.createdAsInternal) continue;
      handOver(d.name, file);
      spans.push([d.offset, d.end]);
    }
    if (spans.length > 0) {
      const first = Math.min(...spans.map((s) => s[0]));
      const last = Math.max(...spans.map((s) => s[1]));
      const grant = new RegExp(`GRANT\\s+CREATE\\s+ON\\s+SCHEMA\\s+"?public"?\\s+TO\\s+${INTERNAL}(?![\\w$])`, 'i').exec(sql);
      const revokes = [...sql.matchAll(new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+"?public"?\\s+FROM\\s+${INTERNAL}(?![\\w$])`, 'gi'))];
      if (!grant || (grant.index ?? 0) > first) {
        v.push(`${file}: hands a routine to ${INVENTORY_INTERNAL} without first granting it CREATE on schema public in the same file (§D bracket)`);
      }
      if (!revokes.some((r) => (r.index ?? 0) > last)) {
        v.push(`${file}: hands a routine to ${INVENTORY_INTERNAL} without revoking CREATE on schema public after the last transfer (§D bracket)`);
      }
    }
  }

  // Nothing the principal owns may ever be granted to PUBLIC, and no later
  // ALTER may undo the shape. Checked once the transferred set is known, so a
  // statement in a file after the transfer is still seen.
  for (const path of files) {
    const file = path.split('/').pop() ?? path;
    const sql = stripComments(src.migrations[path] ?? '');
    for (const m of sql.matchAll(new RegExp(`GRANT\\s+[^;]*?\\bON\\s+${ROUTINE_KIND}\\s+([^;]*?)\\s+TO\\s+([^;]*);`, 'gi'))) {
      if (!/\bPUBLIC\b/i.test(m[2] ?? '')) continue;
      for (const name of routineNames(m[1] ?? '', ANY_SCHEMA)) {
        if (handovers.has(name)) v.push(`${file}: grants ${name} to PUBLIC — no inventory routine may be callable by every role (§D)`);
      }
    }
    // `ON ALL FUNCTIONS IN SCHEMA` names no routine, and grants every one (L-1).
    if (handovers.size > 0) {
      for (const m of sql.matchAll(/GRANT\s+[^;]*?\bON\s+ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES)\s+IN\s+SCHEMA\s+[^;]*?\bTO\s+([^;]*);/gi)) {
        if (/\bPUBLIC\b/i.test(m[1] ?? '')) {
          v.push(`${file}: grants ALL routines in a schema to PUBLIC — that includes every inventory routine (§D)`);
        }
      }
    }
  }

  // Later ALTERs that would undo the shape.
  for (const path of files) {
    const file = path.split('/').pop() ?? path;
    const sql = stripComments(src.migrations[path] ?? '');
    for (const m of sql.matchAll(new RegExp(`ALTER\\s+${ROUTINE_KIND}\\s+${ANY_SCHEMA}${IDENT}${OPTIONAL_ARGS}\\s*([^;]*);`, 'gi'))) {
      const name = (m[1] ?? '').toLowerCase();
      const action = m[2] ?? '';
      if (!handovers.has(name)) continue;
      if (/\bRESET\b/i.test(action) || /\bSET\s+search_path\b/i.test(action)) {
        v.push(`${file}: ALTER FUNCTION ${name} changes its search_path after the fact — define it with the pinned path instead (§D)`);
      }
      if (/\bSECURITY\s+INVOKER\b/i.test(action) || /\bSECURITY\s+DEFINER\b/i.test(action)) {
        v.push(`${file}: ALTER FUNCTION ${name} changes its security mode after the fact (§D)`);
      }
    }
  }

  const dropped = (name: string, file: string, before: number): boolean => {
    const path = files.find((p) => (p.split('/').pop() ?? p) === file);
    const sql = stripComments(src.migrations[path ?? ''] ?? '').slice(0, before);
    return new RegExp(`DROP\\s+${ROUTINE_KIND}\\s+(?:IF\\s+EXISTS\\s+)?${ANY_SCHEMA}"?${name}"?\\b`, 'i').test(sql);
  };

  for (const [name, handedIn] of handovers) {
    const defs = definitions.filter((d) => d.name === name);
    if (defs.length === 0) {
      v.push(`${handedIn[handedIn.length - 1] ?? '?'}: ${name} is handed to ${INVENTORY_INTERNAL} but no migration defines it`);
      continue;
    }

    // PUBLIC's default EXECUTE is revoked where the routine is handed over.
    for (const file of handedIn) {
      const byOwnerChange = new RegExp(
        `ALTER\\s+${ROUTINE_KIND}\\s+${ANY_SCHEMA}"?${name}"?${OPTIONAL_ARGS}\\s*OWNER\\s+TO\\s+${INTERNAL}(?![\\w$])`,
        'i',
      ).test(stripComments(src.migrations[files.find((p) => (p.split('/').pop() ?? p) === file) ?? ''] ?? ''));
      const asInternal = defs.filter((d) => d.file === file && d.createdAsInternal);
      const earlier = handedIn.indexOf(file) > 0;
      const keepsAcl = !byOwnerChange && earlier && asInternal.every((d) => d.orReplace && !dropped(name, file, d.offset));
      if (!keepsAcl && !revoked.get(name)?.has(file)) {
        v.push(`${file}: ${name} is handed to ${INVENTORY_INTERNAL} without REVOKE ALL ON FUNCTION … FROM PUBLIC in the same file (§D)`);
      }
    }

    // Every definition, in every file, has the shape (1, 2, 5).
    const invokerException = INVENTORY_INVOKER_EXCEPTIONS.includes(name);
    for (const d of defs) {
      if (invokerException && d.securityDefiner) {
        v.push(`${d.file}: ${name} is an asserted INVOKER column guard (§F) and must not be SECURITY DEFINER — it decides by current_user`);
      }
      if (!invokerException && !d.securityDefiner) {
        v.push(
          `${d.file}: ${name} is owned by ${INVENTORY_INTERNAL} but is not SECURITY DEFINER — only ${INVENTORY_INVOKER_EXCEPTIONS.join(' and ')} may be (§D)`,
        );
      }
      const schemas = d.searchPath === null ? null : pathSchemas(d.searchPath);
      if (schemas === null || schemas.join(',') !== INVENTORY_SEARCH_PATH.join(',')) {
        v.push(`${d.file}: ${name} must pin search_path = ${INVENTORY_SEARCH_PATH.join(', ')} exactly, found ${d.searchPath ?? 'none'} (§D)`);
      }
      if (d.body === null) {
        v.push(`${d.file}: ${name} has no body the guard can read (§D)`);
        continue;
      }
      if (/\bEXECUTE\b(?!\s+FUNCTION\b)/i.test(d.body)) {
        v.push(`${d.file}: ${name} runs dynamic SQL (EXECUTE) — an inventory routine's statements are fixed at CREATE time (§D)`);
      }
      if (/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\b/i.test(d.body)) {
        v.push(`${d.file}: ${name} creates a session relation — the principal holds no TEMPORARY (§D)`);
      }
    }
  }

  // The exceptions are asserted, not tolerated: each must still exist.
  for (const name of INVENTORY_INVOKER_EXCEPTIONS) {
    if (!handovers.has(name)) {
      v.push(`asserted INVOKER exception ${name} is no longer handed to ${INVENTORY_INTERNAL} — update the guard and the live sweep together`);
    }
  }

  return { violations: v, transferred: [...handovers.keys()].sort() };
}
