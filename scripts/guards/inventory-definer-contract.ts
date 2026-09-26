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
 */

import { parseRoutines, pathSchemas } from './definer-search-path';
import { stripComments } from './sql-schema';

export const INVENTORY_INTERNAL = 'daftar_inventory_internal';

/** The only routines the inventory principal may own as SECURITY INVOKER. */
export const INVENTORY_INVOKER_EXCEPTIONS: readonly string[] = ['products_10_inventory_config_authority', 'product_variants_10_base_variant_authority'];

export const INVENTORY_SEARCH_PATH: readonly string[] = ['pg_catalog', 'public', 'pg_temp'];

const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';

/** `$tag$ … $tag$` string bodies of every `CREATE FUNCTION` in a file, by name, last wins. */
function routineBodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const header = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;
  for (const m of sql.matchAll(header)) {
    const from = m.index ?? 0;
    const rest = sql.slice(from);
    const open = /\$([A-Za-z_]*)\$/.exec(rest);
    if (!open) continue;
    const start = open.index + open[0].length;
    const close = rest.indexOf(open[0], start);
    if (close < 0) continue;
    out.set((m[1] ?? '').toLowerCase(), rest.slice(start, close));
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

  // Effective definition of each routine: the LAST `CREATE FUNCTION` of that
  // name, in apply order.
  const headers = new Map<string, { file: string; securityDefiner: boolean; searchPath: string | null }>();
  const bodies = new Map<string, { file: string; body: string }>();
  // Every file that revokes PUBLIC's EXECUTE on a routine, by routine name.
  const revoked = new Map<string, Set<string>>();
  const transferredIn = new Map<string, string>();

  for (const path of files) {
    const file = path.split('/').pop() ?? path;
    const raw = src.migrations[path] ?? '';
    const sql = stripComments(raw);
    for (const r of parseRoutines(raw)) {
      headers.set(r.name.toLowerCase(), { file, securityDefiner: r.securityDefiner, searchPath: r.searchPath });
    }
    for (const [name, body] of routineBodies(sql)) bodies.set(name, { file, body });

    for (const m of sql.matchAll(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${IDENT}\\s*\\([^;]*?FROM\\s+PUBLIC\\s*;`, 'gi'))) {
      const name = (m[1] ?? '').toLowerCase();
      const set = revoked.get(name) ?? new Set<string>();
      set.add(file);
      revoked.set(name, set);
    }

    // Ownership transfers, and the CREATE bracket around them.
    const transfer = new RegExp(`ALTER\\s+FUNCTION\\s+(?:public\\.)?${IDENT}\\s*\\([^;]*?\\)\\s*OWNER\\s+TO\\s+${INVENTORY_INTERNAL}\\s*;`, 'gi');
    const transfers = [...sql.matchAll(transfer)];
    for (const m of transfers) transferredIn.set((m[1] ?? '').toLowerCase(), file);
    if (transfers.length > 0) {
      const first = transfers[0]?.index ?? 0;
      const lastMatch = transfers[transfers.length - 1];
      const last = (lastMatch?.index ?? 0) + (lastMatch?.[0].length ?? 0);
      const grant = new RegExp(`GRANT\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+TO\\s+${INVENTORY_INTERNAL}\\b`, 'i').exec(sql);
      const revokes = [...sql.matchAll(new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+FROM\\s+${INVENTORY_INTERNAL}\\b`, 'gi'))];
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
    for (const m of sql.matchAll(new RegExp(`GRANT\\s+[^;]*?\\bON\\s+FUNCTION\\s+(?:public\\.)?${IDENT}\\s*\\([^;]*?\\)\\s*TO\\s+([^;]*);`, 'gi'))) {
      const name = (m[1] ?? '').toLowerCase();
      if (transferredIn.has(name) && /\bPUBLIC\b/i.test(m[2] ?? '')) {
        v.push(`${file}: grants ${name} to PUBLIC — no inventory routine may be callable by every role (§D)`);
      }
    }
  }

  // Later ALTERs that would undo the shape.
  for (const path of files) {
    const file = path.split('/').pop() ?? path;
    const sql = stripComments(src.migrations[path] ?? '');
    for (const m of sql.matchAll(new RegExp(`ALTER\\s+FUNCTION\\s+(?:public\\.)?${IDENT}\\s*\\([^;]*?\\)\\s*([^;]*);`, 'gi'))) {
      const name = (m[1] ?? '').toLowerCase();
      const action = m[2] ?? '';
      if (!transferredIn.has(name)) continue;
      if (/\bRESET\b/i.test(action) || /\bSET\s+search_path\b/i.test(action)) {
        v.push(`${file}: ALTER FUNCTION ${name} changes its search_path after the fact — define it with the pinned path instead (§D)`);
      }
      if (/\bSECURITY\s+INVOKER\b/i.test(action) || /\bSECURITY\s+DEFINER\b/i.test(action)) {
        v.push(`${file}: ALTER FUNCTION ${name} changes its security mode after the fact (§D)`);
      }
    }
  }

  for (const [name, file] of transferredIn) {
    const header = headers.get(name);
    if (!header) {
      v.push(`${file}: ${name} is handed to ${INVENTORY_INTERNAL} but no migration defines it`);
      continue;
    }
    const invokerException = INVENTORY_INVOKER_EXCEPTIONS.includes(name);
    if (invokerException && header.securityDefiner) {
      v.push(`${header.file}: ${name} is an asserted INVOKER column guard (§F) and must not be SECURITY DEFINER — it decides by current_user`);
    }
    if (!invokerException && !header.securityDefiner) {
      v.push(
        `${header.file}: ${name} is owned by ${INVENTORY_INTERNAL} but is not SECURITY DEFINER — only ${INVENTORY_INVOKER_EXCEPTIONS.join(' and ')} may be (§D)`,
      );
    }
    const schemas = header.searchPath === null ? null : pathSchemas(header.searchPath);
    if (schemas === null || schemas.join(',') !== INVENTORY_SEARCH_PATH.join(',')) {
      v.push(`${header.file}: ${name} must pin search_path = ${INVENTORY_SEARCH_PATH.join(', ')} exactly, found ${header.searchPath ?? 'none'} (§D)`);
    }
    if (!revoked.get(name)?.has(file)) {
      v.push(`${file}: ${name} is handed to ${INVENTORY_INTERNAL} without REVOKE ALL ON FUNCTION … FROM PUBLIC in the same file (§D)`);
    }
    const body = bodies.get(name);
    if (!body) {
      v.push(`${header.file}: ${name} has no dollar-quoted body the guard can read (§D)`);
    } else {
      const text = stripComments(body.body);
      if (/\bEXECUTE\b(?!\s+FUNCTION\b)/i.test(text)) {
        v.push(`${body.file}: ${name} runs dynamic SQL (EXECUTE) — an inventory routine's statements are fixed at CREATE time (§D)`);
      }
      if (/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\b/i.test(text)) {
        v.push(`${body.file}: ${name} creates a session relation — the principal holds no TEMPORARY (§D)`);
      }
    }
  }

  // The exceptions are asserted, not tolerated: each must still exist.
  for (const name of INVENTORY_INVOKER_EXCEPTIONS) {
    if (!transferredIn.has(name)) {
      v.push(`asserted INVOKER exception ${name} is no longer handed to ${INVENTORY_INTERNAL} — update the guard and the live sweep together`);
    }
  }

  return { violations: v, transferred: [...transferredIn.keys()].sort() };
}
