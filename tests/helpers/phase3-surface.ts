/**
 * P3-S8 — THE PHASE 3 SURFACE, DISCOVERED FROM THE LIVE CATALOGUE
 * (docs/PHASE_3_S8_CONTRACT.md §0 "The Phase 3 surface", A-03).
 *
 * Every S8 security law is evaluated over sets this module DISCOVERS, never
 * over a list somebody typed: a table, column or routine is "Phase 3" when it
 * exists in the S8-head database (the shared `daftar` the suites run on) and
 * does not exist — or, for a routine, exists with a different body — in a
 * database built from `0000` … `PHASE2_PREFIX_END` (`0052`, the accepted
 * Phase 2 prefix of scripts/phase2-prefix.ts). A later slice that adds a
 * table, a column, a routine or an operation kind is therefore inside every
 * law the moment its migration exists, with no edit here.
 *
 * The prefix database is built ONCE per cluster from the real migration files
 * (tests/helpers/scratch-db.ts) and reused while its `schema_migrations` still
 * names exactly the prefix files with their on-disk digests; anything else
 * rebuilds it. Its catalogue is read once per process.
 *
 * Exports (A-03):
 *   phase3Tables()       relations (r, p) in public created after 0052
 *   phase3Columns()      `table.column` added after 0052 to a table 0052 had
 *   phase3Routines()     routines created after 0052 ∪ pre-Phase-3 routines
 *                        whose `prosrc` differs from 0052's (replaced)
 *   truthTables()        tables on which daftar_inventory_internal holds
 *                        INSERT, UPDATE or DELETE (table or column level, read
 *                        from the ACL) minus the four key-domain / log tables
 *   runtimePrincipals()  rolcanlogin, not rolsuper, minus daftar_migrator
 *   registeredOpKinds()  SELECT op_code FROM inventory_operation_kinds
 *   phase3RegisteredOpKinds()  the same, scoped to registered_by ~ '^P3-'
 *   opKindRegistrants()  op_code → registered_by, for the partition claims
 *
 * ── P4-AL-88: the Phase 3 SCOPE inside the discovered surface ────────────
 *
 * `phase3Tables()` and `phase3Columns()` are anchored on ONE accepted prefix
 * (`0052`), so they are the complement of Phase 1/2 — which means they
 * discover Phase 3 AND every phase after it. That is exactly right for a law
 * ("no runtime principal may write any of these"), and exactly wrong for an
 * exact-equality inventory ("these 48 and nothing else"), because the second
 * shape is a closure rule wearing an invariant's clothes
 * (`[[daftar-a-closure-rule-is-not-an-invariant]]`, P4-AL-88).
 *
 * The estate already owns a SECOND accepted prefix and a second complement
 * predicate: `PHASE4_INHERITED_PREFIX` (`0000`–`0073`, digest-pinned in
 * `scripts/phase4-prefix.ts`, frozen byte for byte by P4-AL-85) and
 * `isPhase4Relation` (`scripts/guards/no-authoritative-balance.ts:631`). The
 * Phase 3 surface is the difference of the two complements — the relations a
 * file in `0053`–`0073` creates — and because that prefix is frozen and
 * digest-verified, NO later phase can enter the scope.
 *
 * So this module exports the scope as well as the surface:
 *
 *   phase3PrefixRelations()   `0053`–`0073` relation names, read from the
 *                             accepted files' digest-verified text
 *   phase3PrefixColumns()     `table.column` those same files ADD
 *   phase3PrefixRoutines()    the routine NAMES those same files declare
 *   phase3ScopeTables()       phase3Tables()   ∩ phase3PrefixRelations()
 *   beyondPhase3Tables()      phase3Tables()   \ phase3PrefixRelations()
 *   phase3ScopeColumns()      phase3Columns()  ∩ phase3PrefixColumns()
 *   beyondPhase3Columns()     phase3Columns()  \ phase3PrefixColumns()
 *
 * The two readers FAIL EMPTY: `acceptedPrefixRelations` yields an empty set
 * when a prefix file is missing or differs from its accepted digest, and the
 * column reader below does the same. An empty scope makes every scoped
 * equality RED, never green, so a tampered prefix is loud rather than
 * laundered.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import { PHASE2_PREFIX } from '../../scripts/phase2-prefix';
import { PHASE3_PREFIX } from '../../scripts/phase3-prefix';
import { phase2PrefixRelations, phase4InheritedPrefixRelations } from '../../scripts/guards/no-authoritative-balance';
import { createScratchDb, scratchPool, urlOf } from './scratch-db';
import { dbUrl, ensurePostgres, ownerPool } from './test-app';
import type { Queryable } from './stock-ledger';

/** The scratch database that holds the accepted Phase 2 prefix. */
export const PREFIX_DB = 'daftar_p3s8_prefix_0052';

/** The last file of the accepted Phase 2 prefix (`0052_…`). */
export const PREFIX_END: string = (() => {
  const last = PHASE2_PREFIX[PHASE2_PREFIX.length - 1];
  if (last === undefined) throw new Error('the Phase 2 prefix is empty');
  return last[0];
})();

/** The four tables the truth-table definition excludes by name (L:1868; 0054:564-576). */
export const TRUTH_TABLE_EXCLUSIONS = ['audit_events', 'inventory_assertion_keys', 'inventory_assertion_uses', 'outbox_events'] as const;

export const INVENTORY_INTERNAL = 'daftar_inventory_internal';
export const ACCOUNTING_INTERNAL = 'daftar_accounting_internal';
/** TD-18 (0070): the owners of the four routines 0037-0039 used to leave to whoever applied the history. */
export const CATALOG_INTERNAL = 'daftar_catalog_internal';
export const PROVISIONING_INTERNAL = 'daftar_provisioning_internal';

export interface CatalogueSnapshot {
  /** public relations of kind r/p/v/m/f → relkind */
  readonly relations: ReadonlyMap<string, string>;
  /** `table.column` of every live attribute of a public r/p relation */
  readonly columns: ReadonlySet<string>;
  /** regprocedure text (schema-less) → md5(prosrc) */
  readonly routines: ReadonlyMap<string, string>;
  readonly roles: ReadonlySet<string>;
}

export interface Phase3Routine {
  /** `name(argtypes)`, as `oid::regprocedure::text` without a schema. */
  readonly sig: string;
  readonly name: string;
  /** true when the routine existed at 0052 with another body. */
  readonly replaced: boolean;
}

async function snapshotOf(q: Queryable): Promise<CatalogueSnapshot> {
  const rel = await q.query<{ n: string; k: string }>(
    `SELECT c.relname::text AS n, c.relkind::text AS k FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
  );
  const col = await q.query<{ c: string }>(
    `SELECT c.relname || '.' || a.attname AS c FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const fn = await q.query<{ s: string; h: string }>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS s, md5(p.prosrc) AS h FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
  );
  const roles = await q.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_roles`);
  return {
    relations: new Map(rel.rows.map((x) => [x.n, x.k] as const)),
    columns: new Set(col.rows.map((x) => x.c)),
    routines: new Map(fn.rows.map((x) => [x.s, x.h] as const)),
    roles: new Set(roles.rows.map((x) => x.r)),
  };
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Is the prefix database present with exactly the prefix files, each at its on-disk digest? */
async function prefixDbIsCurrent(): Promise<boolean> {
  const admin = scratchPool(dbUrl, 1);
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [PREFIX_DB]);
    if (exists.rowCount === 0) return false;
  } finally {
    await admin.end();
  }
  const p = scratchPool(urlOf(PREFIX_DB), 1);
  try {
    const r = await p.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM schema_migrations ORDER BY name`);
    const expected = PHASE2_PREFIX.map(([name]) => ({ name, sha256: sha256(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')) }));
    return JSON.stringify(r.rows) === JSON.stringify(expected);
  } catch (e) {
    // A half-built database (no schema_migrations yet) is not current; it is rebuilt.
    if (e instanceof Error && /schema_migrations/.test(e.message)) return false;
    throw e;
  } finally {
    await p.end();
  }
}

let prefixSnapshot: Promise<CatalogueSnapshot> | null = null;

/** The catalogue of a database built from 0000 … 0052, built once per cluster. */
export function prefixCatalogue(): Promise<CatalogueSnapshot> {
  prefixSnapshot ??= (async () => {
    await ensurePostgres();
    if (!(await prefixDbIsCurrent())) {
      const built = await createScratchDb(PREFIX_DB, { upTo: PREFIX_END, keys: false });
      // Keep the database; only this handle's pools close.
      await built.pool.end();
    }
    const p = scratchPool(urlOf(PREFIX_DB), 1);
    try {
      return await snapshotOf(p);
    } finally {
      await p.end();
    }
  })();
  return prefixSnapshot;
}

/** The catalogue of the S8-head database the suites run on. */
export async function headCatalogue(q: Queryable = ownerPool()): Promise<CatalogueSnapshot> {
  return snapshotOf(q);
}

/** Relations (tables and partitioned tables) in public that exist at the head and not at 0052. */
export async function phase3Tables(q: Queryable = ownerPool()): Promise<string[]> {
  const [pre, head] = [await prefixCatalogue(), await headCatalogue(q)];
  return [...head.relations]
    .filter(([n, k]) => (k === 'r' || k === 'p') && !pre.relations.has(n))
    .map(([n]) => n)
    .sort();
}

/**
 * ── The Phase 3 SCOPE (P4-AL-88) ─────────────────────────────────────────
 *
 * Relation names a file of the accepted Phase 3 prefix (`0053`–`0073`)
 * creates: the difference between the two accepted prefixes' relation sets,
 * both read by the one digest-verifying reader in
 * `scripts/guards/no-authoritative-balance.ts`. A missing or edited prefix
 * file empties that reader, which empties this set, which turns every scoped
 * equality below RED.
 */
export function phase3PrefixRelations(): ReadonlySet<string> {
  const inherited = phase4InheritedPrefixRelations();
  const phase2 = phase2PrefixRelations();
  // Either reader empty ⇒ empty scope ⇒ the scoped equalities are red.
  if (inherited.size === 0 || phase2.size === 0) return new Set();
  return new Set([...inherited].filter((t) => !phase2.has(t)));
}

/**
 * `table.column` every `ADD COLUMN` clause of the accepted Phase 3 prefix
 * declares, read from the files' digest-verified text. The same fail-empty
 * rule: one bad digest and the set is empty.
 *
 * The text is lexed with `lexBody` first, so an `ADD COLUMN` inside a `--`
 * comment or a single-quoted literal is not a declaration. Statements are
 * then split on `;` and only a statement that OPENS with `ALTER TABLE <name>`
 * contributes, so the table of every column is the one the statement names —
 * which is what makes a multi-clause `ALTER TABLE products ADD COLUMN a,
 * ADD COLUMN b;` (`0053:114-117`) read correctly.
 */
export function phase3PrefixColumns(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, sha] of PHASE3_PREFIX) {
    const path = join(MIGRATIONS_DIR, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return new Set();
    }
    if (sha256(text) !== sha) return new Set();
    for (const statement of lexBody(text).code.split(';')) {
      const table = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/i.exec(statement);
      if (table === null) continue;
      for (const clause of statement.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi))
        out.add(`${(table[1] ?? '').toLowerCase()}.${(clause[1] ?? '').toLowerCase()}`);
    }
  }
  return out;
}

/**
 * The ROUTINE NAMES the accepted Phase 3 prefix declares, read from the
 * files' digest-verified text: every `CREATE [OR REPLACE] FUNCTION` and
 * `CREATE [OR REPLACE] PROCEDURE`. Names, not signatures, because a later
 * migration may legitimately add an overload of a Phase 3 routine and the
 * scope question is "whose routine is this". Same fail-empty rule.
 */
export function phase3PrefixRoutines(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, sha] of PHASE3_PREFIX) {
    const path = join(MIGRATIONS_DIR, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return new Set();
    }
    if (sha256(text) !== sha) return new Set();
    for (const m of text.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi))
      out.add((m[1] ?? '').toLowerCase());
  }
  return out;
}

/** `phase3Routines()` whose NAME no accepted prefix file declares: the routines of a later phase. */
export async function beyondPhase3Routines(q: Queryable = ownerPool()): Promise<Phase3Routine[]> {
  const declared = phase3PrefixRoutines();
  return (await phase3Routines(q)).filter((r) => !declared.has(r.name));
}

/** `phase3Tables()` restricted to the Phase 3 scope: created by a file in `0053`–`0073`. */
export async function phase3ScopeTables(q: Queryable = ownerPool()): Promise<string[]> {
  const scope = phase3PrefixRelations();
  return (await phase3Tables(q)).filter((t) => scope.has(t));
}

/** `phase3Tables()` OUTSIDE the Phase 3 scope: no accepted prefix file creates it — Phase 4 and later. */
export async function beyondPhase3Tables(q: Queryable = ownerPool()): Promise<string[]> {
  const scope = phase3PrefixRelations();
  return (await phase3Tables(q)).filter((t) => !scope.has(t));
}

/** `phase3Columns()` restricted to the Phase 3 scope: declared by a file in `0053`–`0073`. */
export async function phase3ScopeColumns(q: Queryable = ownerPool()): Promise<string[]> {
  const scope = phase3PrefixColumns();
  return (await phase3Columns(q)).filter((c) => scope.has(c));
}

/** `phase3Columns()` OUTSIDE the Phase 3 scope: no accepted prefix file declares it. */
export async function beyondPhase3Columns(q: Queryable = ownerPool()): Promise<string[]> {
  const scope = phase3PrefixColumns();
  return (await phase3Columns(q)).filter((c) => !scope.has(c));
}

/** `table.column` added after 0052 to a table that existed at 0052. */
export async function phase3Columns(q: Queryable = ownerPool()): Promise<string[]> {
  const [pre, head] = [await prefixCatalogue(), await headCatalogue(q)];
  return [...head.columns]
    .filter((c) => {
      const table = c.slice(0, c.indexOf('.'));
      return pre.relations.has(table) && !pre.columns.has(c);
    })
    .sort();
}

/** Routines created after 0052, and pre-Phase-3 routines whose body differs from 0052's. */
export async function phase3Routines(q: Queryable = ownerPool()): Promise<Phase3Routine[]> {
  const [pre, head] = [await prefixCatalogue(), await headCatalogue(q)];
  const out: Phase3Routine[] = [];
  for (const [sig, h] of head.routines) {
    const before = pre.routines.get(sig);
    if (before === undefined || before !== h) out.push({ sig, name: sig.slice(0, sig.indexOf('(')), replaced: before !== undefined });
  }
  return out.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

/**
 * Tables on which the inventory principal holds INSERT, UPDATE or DELETE at
 * table or column level — read from `relacl`/`attacl` with `aclexplode`, so a
 * grant through a role membership is not counted (the principal is NOINHERIT
 * and holds none) — minus the four excluded tables.
 */
export async function truthTables(q: Queryable = ownerPool()): Promise<string[]> {
  const r = await q.query<{ t: string }>(
    `SELECT DISTINCT c.relname::text AS t
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) x
                      WHERE x.grantee = $1::regrole AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))
             OR EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x
                         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                           AND x.grantee = $1::regrole AND x.privilege_type IN ('INSERT', 'UPDATE')))
      ORDER BY 1`,
    [INVENTORY_INTERNAL],
  );
  const excluded = new Set<string>(TRUTH_TABLE_EXCLUSIONS);
  return r.rows.map((x) => x.t).filter((t) => !excluded.has(t));
}

/** Every login role other than the deployment principal and superusers (L:1660). */
export async function runtimePrincipals(q: Queryable = ownerPool()): Promise<string[]> {
  const r = await q.query<{ r: string }>(
    `SELECT rolname::text AS r FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname <> 'daftar_migrator' ORDER BY 1`,
  );
  return r.rows.map((x) => x.r);
}

/**
 * A routine body as code: `--` and `/* *\/` comments removed and every
 * single-quoted literal replaced by the placeholder `'#<n>'`, its text kept in
 * `literals[n]` (with `''` unescaped). The laws that read a body (A-04, A-05,
 * A-08 clause 6) read THIS, so text inside a comment or an error message can
 * neither satisfy nor break them.
 */
export interface LexedBody {
  readonly code: string;
  readonly literals: readonly string[];
}

export function lexBody(src: string): LexedBody {
  let code = '';
  const literals: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '-' && next === '-') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (ch === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (src[j] === "'") {
          break;
        } else {
          text += src[j];
          j += 1;
        }
      }
      literals.push(text);
      code += `'#${literals.length - 1}'`;
      i = j + 1;
    } else {
      code += ch;
      i += 1;
    }
  }
  return { code, literals };
}

/** The text from the `(` at `open` to its matching `)`, inclusive (or to the end). */
export function balanced(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

/** The registered operation kinds, in code order. */
export async function registeredOpKinds(q: Queryable = ownerPool()): Promise<string[]> {
  const r = await q.query<{ op: string }>(`SELECT op_code::text AS op FROM inventory_operation_kinds ORDER BY op_code`);
  return r.rows.map((x) => x.op);
}

/**
 * The operation kinds a PHASE 3 registrant registered, in code order
 * (P4-AL-88). `registered_by` is the registry's own provenance column, and
 * `0074` widened its CHECK from `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$` (keeping
 * the corrective `P3-C` arm) precisely so a later phase can register a kind.
 * So `registered_by ~ '^P3-'` is the scope a later phase cannot enter, and it
 * is the estate's existing idiom for exactly this.
 */
export async function phase3RegisteredOpKinds(q: Queryable = ownerPool()): Promise<string[]> {
  const r = await q.query<{ op: string }>(`SELECT op_code::text AS op FROM inventory_operation_kinds WHERE registered_by ~ '^P3-' ORDER BY op_code`);
  return r.rows.map((x) => x.op);
}

/** `op_code → registered_by` for every registered operation kind. */
export async function opKindRegistrants(q: Queryable = ownerPool()): Promise<Readonly<Record<string, string>>> {
  const r = await q.query<{ op: string; by: string }>(`SELECT op_code::text AS op, registered_by::text AS by FROM inventory_operation_kinds ORDER BY op_code`);
  return Object.fromEntries(r.rows.map((x) => [x.op, x.by] as const));
}
