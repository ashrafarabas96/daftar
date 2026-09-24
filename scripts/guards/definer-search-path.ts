/**
 * Guard G-5 (P2-S3 correction, directive §9) — a SECURITY DEFINER routine may
 * not resolve names through a schema its caller can write.
 *
 * ── The defect this exists for ───────────────────────────────────────────
 *
 * `SET search_path = public, pg_catalog` reads as a locked-down path. It is
 * not one. PostgreSQL searches the session temporary schema for RELATION and
 * TYPE names whether or not `pg_temp` appears in the path — and when it does
 * not appear, it is searched FIRST, ahead of every schema that does. Omitting
 * it does not exclude it. It only forfeits the choice of where it sits.
 *
 * Combined with `TEMPORARY`, which PostgreSQL grants to PUBLIC on every
 * database by default, that let a stolen `daftar_app` credential create
 * `pg_temp.accounting_assertion_keys`, grant the elevated principal SELECT on
 * the table it now owned, and have the verifier check signatures against a key
 * the attacker chose. It forged a journal entry. The reproduction is
 * `tests/security/search-path-shadowing.test.ts`.
 *
 * ── Why a regex is not the guard ─────────────────────────────────────────
 *
 * The real proof is the live catalogue and the live role privileges, and that
 * is where the matrix above asserts it. This guard is the half that can fail
 * on a pull request, before a server exists: it reads the migration text and
 * refuses the shapes that are wrong by construction. Specifically it does NOT
 * declare a path safe because the string "pg_temp" occurs somewhere in it —
 * `pg_temp, public` names pg_temp and is exactly as broken as omitting it.
 * Position is the whole rule.
 */

import { stripComments } from './sql-schema';

/**
 * Schemas a runtime credential can create objects in, and therefore schemas
 * that must never precede a trusted one in an elevated routine's path.
 *
 * `public` is deliberately NOT here. `bootstrap.sql` revokes CREATE on it from
 * PUBLIC and from all six runtime roles, and the live matrix proves that; a
 * guard that called `public` caller-writable would be asserting something the
 * database says is false.
 */
const CALLER_WRITABLE = ['pg_temp'] as const;

/** One `CREATE FUNCTION` header, as far as this rule cares about it. */
export interface RoutineHeader {
  readonly name: string;
  readonly securityDefiner: boolean;
  /** The raw `search_path=` value, or null when the routine pins none. */
  readonly searchPath: string | null;
  /**
   * True when the body is written in the SQL-standard form — `RETURN <expr>`
   * or `BEGIN ATOMIC … END` — rather than as a string literal (`AS $$ … $$`).
   *
   * The distinction is not stylistic. A string body is text: PostgreSQL keeps
   * it verbatim in `pg_proc.prosrc` and PARSES IT AT CALL TIME, which is when
   * the caller's `search_path` decides what each unqualified name means. A
   * SQL-standard body is parsed and RESOLVED AT CREATE TIME and stored as a
   * parse tree in `pg_proc.prosqlbody`, with every referenced object recorded
   * in `pg_depend`. Nothing is left to resolve when it runs, so no path — the
   * caller's or a pinned one — can reach it.
   */
  readonly sqlStandardBody: boolean;
}

const HEADER = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

/**
 * Where a routine's options stop and its body starts.
 *
 * `$…$` and `AS '` open a string body. `RETURN` and `BEGIN ATOMIC` open a
 * SQL-standard one — and they have to be here, not only for the flag above:
 * without them the window for a SQL-standard routine would run to the end of
 * the file and pick up the NEXT routine's `SET search_path` as its own.
 * `\bRETURN\b` does not match `RETURNS`.
 */
const BODY_START = /\$[A-Za-z_]*\$|\bAS\s+'|\bRETURN\b|\bBEGIN\s+ATOMIC\b/i;

/**
 * Every routine a migration file defines, with the options PostgreSQL would
 * apply to it.
 *
 * The options of a `CREATE FUNCTION` sit between the closing parenthesis of
 * the argument list and the body delimiter, so the window scanned is the text
 * from the routine's name up to the first `$$`, `$func$` or `AS '`. Scanning
 * the whole file instead would attribute one routine's `SET search_path` to
 * the routine before it.
 */
export function parseRoutines(sql: string): RoutineHeader[] {
  const schema = stripComments(sql);
  const out: RoutineHeader[] = [];
  for (const m of schema.matchAll(HEADER)) {
    const name = m[1] ?? '';
    const from = m.index ?? 0;
    const body = BODY_START.exec(schema.slice(from));
    const header = schema.slice(from, from + (body?.index ?? schema.length - from));
    const path =
      /\bSET\s+search_path\s*(?:=|\bTO\b)\s*([^;]*?)(?=\s+(?:AS|LANGUAGE|STABLE|IMMUTABLE|VOLATILE|STRICT|SECURITY|RETURNS|PARALLEL|COST|ROWS|WINDOW|SET)\b|$)/i.exec(
        header,
      );
    out.push({
      name,
      securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(header),
      searchPath: path?.[1]?.trim() ?? null,
      sqlStandardBody: /^(?:RETURN\b|BEGIN\s+ATOMIC\b)/i.test(body?.[0] ?? ''),
    });
  }
  return out;
}

/** The schemas of a `search_path` value, in order, unquoted. */
export function pathSchemas(searchPath: string): string[] {
  return searchPath
    .split(',')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s !== '');
}

export interface DefinerSearchPathSources {
  /** Migration file path → contents. Only the unfrozen ones need to comply. */
  readonly migrations: Readonly<Record<string, string>>;
  /** `bootstrap.sql`, which is where the privilege half of the rule lives. */
  readonly bootstrap: string;
  /**
   * Migrations whose bytes are frozen. They are skipped entirely: the fix for
   * a frozen routine is `ALTER FUNCTION` in a candidate migration plus the
   * privilege revocation in `bootstrap.sql`, never an edit here, so reporting
   * one would be reporting something nobody may act on.
   */
  readonly frozen: ReadonlySet<string>;
}

export function findDefinerSearchPathViolations(src: DefinerSearchPathSources): string[] {
  const v: string[] = [];

  // ── Half one: the privilege boundary. ─────────────────────────────────
  //
  // This is what actually closes the class, including for the frozen Phase 1
  // routines whose bytes may not change and whose owner the deployment
  // migrator may not assume. Without it, every search_path in the repository
  // could be perfect and a caller could still own the relation an elevated
  // routine reads.
  const bootstrap = stripComments(src.bootstrap);
  if (!/REVOKE\s+TEMPORARY\s+ON\s+DATABASE\s+[^;]*FROM\s+PUBLIC/i.test(bootstrap)) {
    v.push('bootstrap.sql does not revoke TEMPORARY on the database from PUBLIC — PostgreSQL grants it by default, and pg_temp is searched first (G-5)');
  }
  if (!/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+PUBLIC/i.test(bootstrap)) {
    v.push('bootstrap.sql does not revoke CREATE on schema public from PUBLIC (G-5)');
  }
  if (/\bGRANT\s+[^;]*\bTEMPORARY\b[^;]*;/i.test(bootstrap)) {
    v.push('bootstrap.sql grants TEMPORARY to somebody — the policy is default deny, and nothing in DAFTAR needs a session relation (G-5)');
  }

  // ── Half two: the paths themselves. ───────────────────────────────────
  for (const [path, sql] of Object.entries(src.migrations)) {
    const file = path.split('/').pop() ?? path;
    const frozen = src.frozen.has(file);
    for (const routine of parseRoutines(sql)) {
      // A frozen file's bytes may never change, so reporting one here would
      // be reporting something nobody is allowed to fix. Their EFFECTIVE
      // paths are corrected by ALTER FUNCTION in candidate 0045, and the live
      // catalogue matrix is what proves that landed. This half of the rule
      // governs what may still be WRITTEN.
      if (frozen) continue;

      if (routine.searchPath === null) {
        // ONE routine shape needs no path, and it is not an exemption: it is
        // the absence of the thing a path protects. A SQL-standard body
        // (`RETURN …`, `BEGIN ATOMIC … END`) is resolved when the function is
        // CREATED and stored as a parse tree, so at call time there is no
        // unqualified name left for any search_path to bind. Pinning one on
        // such a routine changes nothing except to make it non-inlinable:
        // `inline_function()` refuses outright to inline a function carrying
        // a SET clause, which is what P2-S8 measured costing 1.56 µs per row
        // per call inside a row-level security expression.
        //
        // SECURITY DEFINER is still excluded. Not because a definer's SQL
        // body would resolve late — it would not — but because this guard's
        // subject is elevated routines, and an elevated one that looks
        // unpinned should have to say why in a place a reviewer reads, not
        // pass a regex. Nothing in DAFTAR needs that combination today.
        if (routine.sqlStandardBody && !routine.securityDefiner) continue;
        // Everything else: a routine with no pinned path takes the caller's
        // entirely, which is strictly worse than a badly ordered one.
        v.push(`${file}: ${routine.name} pins no search_path, so it resolves every name through the caller's (G-5)`);
        continue;
      }

      const schemas = pathSchemas(routine.searchPath);
      const last = schemas[schemas.length - 1];
      if (last !== 'pg_temp') {
        v.push(
          `${file}: ${routine.name} has search_path "${routine.searchPath}" — pg_temp is searched first when it is not named, so it must be named LAST (G-5)`,
        );
        continue;
      }
      for (let i = 0; i < schemas.length - 1; i += 1) {
        const schema = schemas[i] ?? '';
        if ((CALLER_WRITABLE as readonly string[]).includes(schema)) {
          v.push(`${file}: ${routine.name} searches ${schema} before a trusted schema (G-5)`);
        }
      }
    }
  }

  // ── Half three: nobody may reintroduce a session relation. ────────────
  //
  // A temporary table named inside an elevated routine is a relation the
  // CALLER can create first, own, and grant away — `IF NOT EXISTS` then
  // quietly declines to create the real one. `accounting_post_entry` shipped
  // exactly that before this guard existed.
  for (const [path, sql] of Object.entries(src.migrations)) {
    const file = path.split('/').pop() ?? path;
    if (src.frozen.has(file)) continue;
    const schema = stripComments(sql);
    const match = /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY)\b/i.exec(schema);
    if (match) {
      v.push(
        `${file} creates a ${match[1]?.toUpperCase()} relation — its caller can pre-create and own that name, and an elevated routine would then read the caller's table (G-5)`,
      );
    }
  }

  return v;
}
