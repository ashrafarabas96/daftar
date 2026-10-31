/**
 * THE ACCEPTED-PREFIX SCOPE FOR CLAIMS A RELATION NAME CANNOT SEPARATE
 * (P4-AL-88, `[[daftar-a-closure-rule-is-not-an-invariant]]`).
 *
 * `tests/helpers/phase3-surface.ts` already scopes by RELATION — which
 * accepted prefix created the table — and `scripts/guards/no-authoritative-
 * balance.ts` owns the one digest-verifying reader that answers it
 * (`phase4InheritedPrefixRelations`). That is the right scope for a claim
 * whose subject IS a relation.
 *
 * Two kinds of claim in the accepted estate are not separable that way, and
 * both broke when `0077` landed:
 *
 *   1. A TRIGGER claim. `0077` puts `stock_binding_requires_sale` on
 *      `stock_source_bindings` and `journal_entries_sale_complete` /
 *      `journal_entries_invoice_complete` on `journal_entries` — relations the
 *      ACCEPTED prefix created. Scoping "the deferred guards of the accepted
 *      prefix" by relation therefore pulls a later phase's triggers into the
 *      Phase 3 equality, which is exactly the closure rule P4-AL-88 removes.
 *      The separable part is the trigger's own NAME, and the accepted prefix
 *      declares it in digest-verified text: `inheritedPrefixTriggers()`.
 *
 *   2. A REGISTRY claim over a registry with NO provenance column.
 *      `inventory_operation_kinds`, `stock_source_types` and
 *      `inventory_operation_movement_kinds` carry `registered_by`, so the
 *      estate's `registered_by ~ '^P3-'` idiom scopes them
 *      (`tests/helpers/stock-ledger.ts:661-692`). `accounting_source_types`
 *      and `accounting_operation_kinds` carry none — `0042:51-57`,
 *      `0046:86-93` — so the only scope available is the one
 *      `tests/security/phase3-s8-signed-authority-matrix.test.ts:262` uses: a
 *      database built to `PHASE4_INHERITED_PREFIX_END`, read as data.
 *      `readInheritedHead()` is that database, built ONCE per cluster rather
 *      than once per assertion.
 *
 * BOTH READERS FAIL LOUD, NEVER QUIET. `inheritedPrefixTriggers()` returns an
 * EMPTY set when a prefix file is missing or differs from its accepted digest
 * — the same rule as `phase3PrefixColumns()` — and an empty scope makes every
 * scoped equality RED rather than vacuous. `readInheritedHead()` rebuilds its
 * database whenever `schema_migrations` is not exactly the accepted prefix at
 * its on-disk digests, so a stale data directory cannot launder a claim.
 *
 * Nothing here names a Phase 4 relation, trigger, routine or registration.
 * The scope is read from the frozen prefix, never from a list of the new
 * phase's names (P4-AL-88).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import { PHASE4_INHERITED_PREFIX, PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';
import { createScratchDb, scratchPool, urlOf } from './scratch-db';
import { dbUrl, ensurePostgres } from './test-app';
import { lexBody } from './phase3-surface';
import type { Queryable } from './stock-ledger';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

let triggerCache: ReadonlySet<string> | null = null;

/**
 * The TRIGGER NAMES the accepted inherited prefix (`0000`–`PHASE4_INHERITED_
 * PREFIX_END`) declares, read from the files' digest-verified text: every
 * `CREATE [CONSTRAINT] TRIGGER`. Fail-empty on a missing or edited file.
 *
 * Names, not `relation.name` pairs, because PostgreSQL scopes a trigger name
 * to its relation and the estate's deferred-guard catalogue is keyed by name
 * alone; a later phase re-using an accepted name on another relation would
 * land INSIDE the scope and be judged by the accepted equality, which is the
 * conservative direction.
 *
 * The text is lexed with `lexBody` first, so a `CREATE TRIGGER` inside a `--`
 * comment or a quoted literal is not a declaration — the header blocks of
 * these files quote their own DDL.
 */
export function inheritedPrefixTriggers(): ReadonlySet<string> {
  if (triggerCache !== null) return triggerCache;
  const out = new Set<string>();
  for (const [name, sha] of PHASE4_INHERITED_PREFIX) {
    const path = join(MIGRATIONS_DIR, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      triggerCache = new Set();
      return triggerCache;
    }
    if (sha256(text) !== sha) {
      triggerCache = new Set();
      return triggerCache;
    }
    for (const n of declaredTriggers(text)) out.add(n);
  }
  triggerCache = out;
  return out;
}

let routineCache: ReadonlySet<string> | null = null;

/**
 * The ROUTINE NAMES the accepted inherited prefix declares — every `CREATE
 * [OR REPLACE] FUNCTION` and `CREATE [OR REPLACE] PROCEDURE` — from the
 * files' digest-verified text. Fail-empty on a missing or edited file.
 *
 * The twin of `phase3PrefixRoutines()` (`tests/helpers/phase3-surface.ts`),
 * anchored on the later of the two accepted prefixes. Names, not signatures,
 * for the same reason: a later migration may legitimately add an overload of
 * an accepted routine, and the scope question is "whose routine is this".
 */
export function inheritedPrefixRoutines(): ReadonlySet<string> {
  if (routineCache !== null) return routineCache;
  const out = new Set<string>();
  for (const [name, sha] of PHASE4_INHERITED_PREFIX) {
    const path = join(MIGRATIONS_DIR, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      routineCache = new Set();
      return routineCache;
    }
    if (sha256(text) !== sha) {
      routineCache = new Set();
      return routineCache;
    }
    for (const m of text.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi))
      out.add((m[1] ?? '').toLowerCase());
  }
  routineCache = out;
  return out;
}

/** Every `CREATE [CONSTRAINT] TRIGGER` name in one SQL text, read as code. */
function declaredTriggers(text: string): string[] {
  return [...lexBody(text).code.matchAll(/\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => (m[1] ?? '').toLowerCase());
}

let beyondTriggerCache: ReadonlySet<string> | null = null;

/**
 * The trigger names declared by the migrations BEYOND the accepted inherited
 * prefix — the open slice's files, which are not frozen and so cannot be
 * digest-verified.
 *
 * That is deliberate and safe, because this set is only ever used to NARROW
 * the accepted prefix's scope, and its failure mode is LOUD: if it comes back
 * empty (no such files, an unreadable one), every trigger that the accepted
 * prefix does not declare falls INSIDE the scope, where the accepted
 * equalities judge it and go red. A later phase can therefore never quieten
 * an accepted claim by failing to be read.
 */
export function triggersDeclaredBeyondInheritedPrefix(): ReadonlySet<string> {
  if (beyondTriggerCache !== null) return beyondTriggerCache;
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f > PHASE4_INHERITED_PREFIX_END);
  } catch {
    beyondTriggerCache = out;
    return out;
  }
  for (const f of files.sort()) {
    try {
      for (const n of declaredTriggers(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))) out.add(n);
    } catch {
      // Unreadable: its triggers stay inside the accepted scope, which is red.
    }
  }
  beyondTriggerCache = out;
  return out;
}

/**
 * Split a set of live trigger names into the half the ACCEPTED PREFIX
 * accounts for and the half a LATER PHASE'S MIGRATION declares.
 *
 * A trigger is "beyond" only when a migration past the accepted head declares
 * it AND the accepted prefix does not. Everything else is in scope —
 * including a trigger that NO migration declares at all, which is what a
 * hand-planted intruder is, so the accepted equalities still name it. The two
 * halves partition the input by construction; a caller still asserts the
 * closure, because a claim that is true by construction is worth stating
 * where a future edit could break it.
 */
export function splitByTriggerProvenance<T>(rows: readonly T[], nameOf: (row: T) => string): { inScope: T[]; beyond: T[] } {
  const prefix = inheritedPrefixTriggers();
  const later = triggersDeclaredBeyondInheritedPrefix();
  const isBeyond = (row: T): boolean => {
    const n = nameOf(row);
    return !prefix.has(n) && later.has(n);
  };
  return { inScope: rows.filter((r) => !isBeyond(r)), beyond: rows.filter(isBeyond) };
}

/** The scratch database that holds the accepted inherited prefix, reused across processes. */
export const INHERITED_HEAD_DB = 'daftar_p4al88_inherited_head';

/** Is that database present with exactly the inherited prefix files, each at its on-disk digest? */
async function inheritedHeadIsCurrent(): Promise<boolean> {
  const admin = scratchPool(dbUrl, 1);
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [INHERITED_HEAD_DB]);
    if (exists.rowCount === 0) return false;
  } finally {
    await admin.end();
  }
  const p = scratchPool(urlOf(INHERITED_HEAD_DB), 1);
  try {
    const r = await p.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM schema_migrations ORDER BY name`);
    const expected = PHASE4_INHERITED_PREFIX.map(([name]) => ({ name, sha256: sha256(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')) }));
    return JSON.stringify(r.rows) === JSON.stringify(expected);
  } catch (e) {
    // A half-built database (no schema_migrations yet) is not current; it is rebuilt.
    if (e instanceof Error && /schema_migrations/.test(e.message)) return false;
    throw e;
  } finally {
    await p.end();
  }
}

let building: Promise<void> | null = null;

/** Ensure the inherited-head database exists and is current, building it at most once per process. */
async function ensureInheritedHead(): Promise<void> {
  building ??= (async () => {
    await ensurePostgres();
    if (await inheritedHeadIsCurrent()) return;
    const built = await createScratchDb(INHERITED_HEAD_DB, { upTo: PHASE4_INHERITED_PREFIX_END, keys: false });
    if (built.applied[built.applied.length - 1] !== PHASE4_INHERITED_PREFIX_END) {
      throw new Error(`the inherited-head build stopped at ${String(built.applied[built.applied.length - 1])}, not ${PHASE4_INHERITED_PREFIX_END}`);
    }
    // Keep the database; only this handle's pools close.
    await built.pool.end();
  })();
  return building;
}

/**
 * Read `fn` against a database built to the accepted Phase 3 head. The
 * database is shared and kept; only the pool this call opens is closed, so a
 * second caller in the same cluster pays nothing.
 *
 * READ-ONLY BY CONTRACT: a caller that wrote to it would corrupt every later
 * caller's scope, so `fn` reads and nothing else.
 */
export async function readInheritedHead<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  await ensureInheritedHead();
  const pool: Pool = scratchPool(urlOf(INHERITED_HEAD_DB), 1);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
