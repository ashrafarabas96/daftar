#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 15 — BACKUP / RESTORE / DR PROOF  (master directive Part 76)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STATUS: PREPARED / NOT PROMOTED.
 *
 * THE RULE THIS EXISTS TO SATISFY
 *
 *   "backup created · backup verified · restore executed · restored system
 *    validated · recovery steps documented · RPO/RTO measured · migration
 *    recovery understood —  'backup script exists' is not restore proof."
 *
 * So nothing here reports a backup as good because a file appeared. The drill
 * runs end to end on real PostgreSQL:
 *
 *   1. SOURCE cluster, fresh `initdb`, its own port and data directory.
 *   2. bootstrap.sql → migrations 0000…latest → the three assertion keys.
 *   3. SEED: two tenants, each with one balanced journal entry posted through
 *      the real `daftar_app` + assertion boundary (see `dr-fixture.ts` for why
 *      a direct INSERT is both impossible and forbidden).
 *   4. BACKUP: `pg_dumpall --globals-only` + `pg_dump -Fc`, each hashed.
 *   5. DISASTER: the source cluster is stopped. Nothing after this point may
 *      read it until the restored copy has been measured — the comparison
 *      snapshots are taken BEFORE the stop and compared afterwards, which is
 *      the only way the "source" side of the comparison is honest.
 *   6. RESTORE: a SECOND cluster, fresh `initdb`, globals applied, an empty
 *      database created from `template0`, `pg_restore --exit-on-error
 *      --single-transaction`. No error is tolerated and no error is ignored.
 *   7. VALIDATE: nine validators (§VALIDATORS below), each of which must find
 *      a NON-EMPTY subject or fail. A validator with nothing to look at
 *      reports `UNMEASURED`, never `PASS`.
 *   8. MEASURE: RPO and RTO, from monotonic clocks, with the parts this drill
 *      does NOT measure named as `UNMEASURED` rather than estimated.
 *
 * WHY THE VALIDATORS ARE THE DELIVERABLE
 *
 * A restore that "worked" is the easy half. The hard half is proving the
 * restored database is the same SYSTEM, not merely the same rows: that RLS
 * came back ENABLED and FORCED, that every policy came back with the same
 * predicate, that the immutability triggers still refuse to let a posted line
 * be edited, that `daftar_app` still cannot read the assertion keys, and that
 * the migration history still matches the frozen manifest. A dump that loses
 * a single policy restores a database that answers every SELECT correctly and
 * leaks every tenant.
 *
 * PROOF OF PROOF (`--prove-detection`)
 *
 * Validators that have never been seen to fail are decoration. Each red proof
 * takes a FRESHLY restored copy, makes one surgical change, CONFIRMS THE
 * CHANGE LANDED by querying for it, and then requires one named validator to
 * fail with its own message. A mutation that did not land is itself a failure
 * of the red proof — a `sed`-style change that matched nothing and then went
 * green is how a missing law gets recorded as a present one.
 *
 * WHAT THIS DRILL DOES NOT PROVE — stated here, printed on every run
 *
 *   * NOT PITR. `docs/DAFTAR_BACKUP_AND_DR.md` §1/§2 claims continuous WAL
 *     archiving with RPO ≤ 15 minutes. This drill restores a FULL LOGICAL
 *     DUMP only, so the RPO it measures is the dump's own age, and the WAL
 *     half is `UNMEASURED`. (As of this commit the repository contains no
 *     `archive_mode`, `archive_command`, `wal_level`, `pg_basebackup`,
 *     `pgBackRest`, `wal-g` or `barman` configuration anywhere — measured by
 *     grep over the tree. The claim has no implementation to test.)
 *   * NOT object storage, NOT Redis, NOT secrets. Database only.
 *   * NOT a production timing. RTO here is this container's timing for a
 *     fixture-sized database and does not transfer to a production volume.
 *   * NOT the Phase 4 schema. This branch's migrations end at 0073; the Phase
 *     4 candidates 0074+ live on another branch and are not in this tree.
 *
 * USAGE
 *   npm run dr:proof                 # the drill
 *   npm run dr:proof -- --prove-detection   # the drill plus the red proofs
 *   npm run dr:proof -- --keep       # leave both clusters running for inspection
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, Pool } from 'pg';
import { runMigrations, MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import {
  adminUrl,
  createEmptyDatabase,
  dbUrl,
  dropDatabase,
  dumpDatabase,
  dumpGlobals,
  prepareClusterDir,
  restoreDatabase,
  restoreGlobals,
  roleUrl,
  startCluster,
  stopCluster,
  toolVersions,
  type ClusterSpec,
} from './pg-cluster';
import { APP_PASSWORD, APP_ROLE, installAssertionKey, seedFixture, type Fixture } from './dr-fixture';

const ROOT = join(__dirname, '../..');
const ARGV = process.argv.slice(2);
const PROVE_DETECTION = ARGV.includes('--prove-detection');
const KEEP = ARGV.includes('--keep');

/** Deliberately not 55432 (the shared cluster) and not 55481 (the load harness). */
const SOURCE: ClusterSpec = { dir: '/tmp/daftar-p15-dr-source', port: 55471, label: 'source' };
const TARGET: ClusterSpec = { dir: '/tmp/daftar-p15-dr-target', port: 55472, label: 'target' };
const BACKUP_DIR = '/tmp/daftar-p15-dr-backup';
const DB = 'daftar';

/** The runtime roles bootstrap.sql creates; the restore must bring every one back. */
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_resolver',
  'daftar_identity',
  'daftar_provisioner',
  'daftar_reconciler',
  'daftar_migrator',
  'daftar_accounting_internal',
  'daftar_inventory_internal',
  'daftar_catalog_internal',
  'daftar_provisioning_internal',
] as const;

/** Tables whose emptiness would make the whole drill vacuous. */
const REQUIRED_NON_EMPTY = [
  'tenants',
  'businesses',
  'users',
  'branches',
  'warehouses',
  'accounts',
  'journal_entries',
  'journal_lines',
  'schema_migrations',
] as const;

type Verdict = 'PASS' | 'FAIL' | 'UNMEASURED';

interface ValidatorResult {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  /** How many things this validator actually looked at. Zero is never a pass. */
  readonly subjects: number;
  readonly message: string;
  readonly detail?: string;
}

const results: ValidatorResult[] = [];
const record = (r: ValidatorResult): ValidatorResult => {
  results.push(r);
  const mark = r.verdict === 'PASS' ? 'PASS' : r.verdict === 'FAIL' ? 'FAIL' : 'UNMEASURED';
  console.log(`  [${mark}] ${r.id} ${r.title} — subjects=${r.subjects} — ${r.message}`);
  if (r.detail !== undefined && r.verdict !== 'PASS') console.log(indent(r.detail));
  return r;
};

const indent = (s: string): string =>
  s
    .split('\n')
    .slice(0, 40)
    .map((l) => `        ${l}`)
    .join('\n');

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const nowMs = (): number => Number(process.hrtime.bigint() / 1000000n);

/* ═══════════════════════════════════════════════════════════════════════════
   CATALOGUE PROBES — the "same system, not just the same rows" half.

   Each probe renders one aspect of the live catalogue as sorted text. Two
   databases are structurally identical only when every probe's text matches.
   `min` is the probe's non-vacuity floor: a probe that returns fewer rows than
   this is not reporting "no difference", it is reporting that it failed to see
   its subject, and the drill must say so.
   ═══════════════════════════════════════════════════════════════════════════ */
interface Probe {
  readonly name: string;
  readonly min: number;
  readonly sql: string;
}

const PROBES: readonly Probe[] = [
  {
    name: 'relations',
    min: 50,
    sql: `SELECT c.relname || ' | ' || c.relkind::text || ' | rls=' || c.relrowsecurity::text || ' | forced=' || c.relforcerowsecurity::text AS t
            FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','m','p','S') ORDER BY 1`,
  },
  {
    name: 'columns',
    min: 300,
    sql: `SELECT c.relname || '.' || a.attname || ' | ' || format_type(a.atttypid, a.atttypmod) || ' | notnull=' || a.attnotnull::text
               || ' | default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') AS t
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  },
  {
    name: 'constraints',
    min: 100,
    sql: `SELECT conrelid::regclass::text || ' | ' || conname || ' | ' || pg_get_constraintdef(oid) AS t
            FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
  },
  {
    name: 'indexes',
    min: 50,
    sql: `SELECT tablename || ' | ' || indexname || ' | ' || indexdef AS t FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  },
  {
    name: 'triggers',
    min: 5,
    sql: `SELECT tgrelid::regclass::text || ' | ' || tgname || ' | ' || pg_get_triggerdef(oid) AS t
            FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY 1`,
  },
  {
    name: 'routines',
    min: 20,
    sql: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') | secdef=' || p.prosecdef::text
               || ' | owner=' || pg_get_userbyid(p.proowner) || ' | body=' || md5(coalesce(p.prosrc, '')) AS t
            FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
  },
  {
    name: 'policies',
    min: 20,
    sql: `SELECT tablename || ' | ' || policyname || ' | permissive=' || permissive::text || ' | roles=' || array_to_string(roles, ',')
               || ' | cmd=' || cmd::text || ' | using=' || coalesce(qual, '-') || ' | check=' || coalesce(with_check, '-') AS t
            FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`,
  },
  {
    name: 'table_grants',
    min: 20,
    sql: `SELECT grantee || ' | ' || table_name || ' | ' || privilege_type AS t
            FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee LIKE 'daftar%' ORDER BY 1`,
  },
  {
    name: 'routine_grants',
    min: 1,
    sql: `SELECT grantee || ' | ' || routine_name || ' | ' || privilege_type AS t
            FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND grantee LIKE 'daftar%' ORDER BY 1`,
  },
  {
    name: 'sequences',
    min: 0,
    sql: `SELECT sequencename || ' | last_value=' || coalesce(last_value::text, 'null') AS t FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
  },
  {
    name: 'extensions',
    min: 1,
    sql: `SELECT extname || ' | ' || extversion AS t FROM pg_extension ORDER BY 1`,
  },
  {
    name: 'roles',
    min: 12,
    sql: `SELECT rolname || ' | super=' || rolsuper::text || ' | inherit=' || rolinherit::text || ' | login=' || rolcanlogin::text
               || ' | bypassrls=' || rolbypassrls::text || ' | createdb=' || rolcreatedb::text || ' | createrole=' || rolcreaterole::text AS t
            FROM pg_roles WHERE rolname LIKE 'daftar%' ORDER BY 1`,
  },
  {
    name: 'role_memberships',
    min: 1,
    sql: `SELECT pg_get_userbyid(m.member) || ' -> ' || pg_get_userbyid(m.roleid) || ' | admin=' || m.admin_option::text
               || ' | inherit=' || m.inherit_option::text || ' | set=' || m.set_option::text AS t
            FROM pg_auth_members m WHERE pg_get_userbyid(m.roleid) LIKE 'daftar%' OR pg_get_userbyid(m.member) LIKE 'daftar%' ORDER BY 1`,
  },
];

type Snapshot = Readonly<Record<string, readonly string[]>>;

async function probeAll(pool: Pool): Promise<Snapshot> {
  const out: Record<string, readonly string[]> = {};
  for (const p of PROBES) {
    const r = await pool.query<{ t: string }>(p.sql);
    out[p.name] = r.rows.map((x) => x.t);
  }
  return out;
}

/** Every public base table, discovered from the catalogue rather than listed here. */
async function baseTables(pool: Pool): Promise<readonly string[]> {
  const r = await pool.query<{ t: string }>(
    `SELECT c.relname::text AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`,
  );
  return r.rows.map((x) => x.t);
}

/**
 * `<rows>:<md5 of the sorted whole-row texts>` per table — the same shape
 * `tests/helpers/table-digest.ts` uses, inlined so this drill stays
 * framework-free. Every column of every row is rendered, so a single changed
 * byte in any column changes its table's digest.
 */
async function dataDigest(pool: Pool, tables: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const IDENT = /^[a-z_][a-z0-9_]*$/;
  const names = tables.filter((t) => IDENT.test(t));
  if (names.length !== tables.length) throw new Error('dataDigest: refusing a table name that is not a plain identifier');
  if (names.length === 0) throw new Error('dataDigest: refusing to digest an empty table set');
  const out: Record<string, string> = {};
  // One statement per table: a single UNION ALL over ~90 tables exceeds the
  // planner's comfort and makes a failure impossible to attribute.
  for (const t of names) {
    const r = await pool.query<{ d: string }>(
      `SELECT count(*)::text || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, E'\\n' ORDER BY to_jsonb(x)::text), '')) AS d FROM public.${t} x`,
    );
    out[t] = r.rows[0]?.d ?? '0:';
  }
  return out;
}

const rowsOf = (digest: string): number => Number(digest.slice(0, digest.indexOf(':')));

function diffLists(a: readonly string[], b: readonly string[]): { readonly onlySource: string[]; readonly onlyRestored: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlySource: a.filter((x) => !sb.has(x)), onlyRestored: b.filter((x) => !sa.has(x)) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   VALIDATORS
   ═══════════════════════════════════════════════════════════════════════════ */

/** V1 — the restored catalogue is the source catalogue, probe by probe. */
/**
 * V1 — the restored catalogue is the source catalogue, probe by probe.
 *
 * THE ONE DIFFERENCE THAT IS THE PRINTER'S AND NOT THE SCHEMA'S
 *
 * `pg_get_constraintdef` prints the stored parse tree, and a dump/restore
 * round-trip re-parses the text it printed. For a CHECK holding a chain of
 * three or more `AND`s the original tree is left-nested — `((A AND B) AND C)` —
 * while the re-parsed one is flat — `(A AND B AND C)`. Same predicate, two
 * spellings, and this tree carries 14 of them (five `char_length` + `btrim`
 * checks and their siblings).
 *
 * Blanket-stripping parentheses would make the validator accept a REAL change
 * of precedence, which for a money CHECK is exactly the defect worth catching.
 * So nothing is normalised by this script. Instead, every textual difference is
 * handed back to PostgreSQL on the RESTORED cluster: the SOURCE's expression is
 * re-parsed there as a `NOT VALID` CHECK inside a transaction that is always
 * rolled back, and the server prints it. If the server's own print of the
 * source expression equals what the restore holds, the difference was the
 * printer's. If it does not, the difference is real and V1 fails.
 *
 * The authority for "these two predicates are the same" is therefore the
 * PostgreSQL parser, never a regular expression written here. Red proofs R7
 * and R8 prove that this reconciliation still fails on a dropped CHECK and on
 * a weakened one.
 */
async function validateStructure(source: Snapshot, restored: Snapshot, restoredPool: Pool): Promise<ValidatorResult> {
  const vacuous = PROBES.filter((p) => (source[p.name] ?? []).length < p.min);
  if (vacuous.length > 0) {
    return {
      id: 'V1',
      title: 'catalogue structure is identical',
      verdict: 'UNMEASURED',
      subjects: 0,
      message: `${vacuous.length} probe(s) saw fewer rows than their non-vacuity floor on the SOURCE — nothing is being compared`,
      detail: vacuous.map((p) => `${p.name}: ${(source[p.name] ?? []).length} rows < floor ${p.min}`).join('\n'),
    };
  }
  const subjects = PROBES.reduce((n, p) => n + (source[p.name] ?? []).length, 0);
  const broken: string[] = [];
  let reconciled = 0;
  const reconciledDetail: string[] = [];
  for (const p of PROBES) {
    const d = diffLists(source[p.name] ?? [], restored[p.name] ?? []);
    if (d.onlySource.length === 0 && d.onlyRestored.length === 0) continue;
    if (p.name === 'constraints') {
      const verdict = await reconcileConstraints(restoredPool, d.onlySource, d.onlyRestored);
      reconciled += verdict.reconciled.length;
      reconciledDetail.push(...verdict.reconciled);
      if (verdict.unreconciled.length === 0) continue;
      broken.push(`constraints: ${verdict.unreconciled.length} real difference(s)` + verdict.unreconciled.map((x) => `\n  ${x}`).join(''));
      continue;
    }
    broken.push(
      `${p.name}: ${d.onlySource.length} lost, ${d.onlyRestored.length} added` +
        d.onlySource
          .slice(0, 5)
          .map((x) => `\n  LOST     ${x}`)
          .join('') +
        d.onlyRestored
          .slice(0, 5)
          .map((x) => `\n  ADDED    ${x}`)
          .join(''),
    );
  }
  const note = reconciled > 0 ? `; ${reconciled} CHECK spelling difference(s) reconciled by the restored server's own re-parse` : '';
  return broken.length === 0
    ? {
        id: 'V1',
        title: 'catalogue structure is identical',
        verdict: 'PASS',
        subjects,
        message: `${PROBES.length} probes, ${subjects} catalogue rows, no difference${note}`,
        detail: reconciledDetail.length > 0 ? reconciledDetail.join('\n') : undefined,
      }
    : {
        id: 'V1',
        title: 'catalogue structure is identical',
        verdict: 'FAIL',
        subjects,
        message: `the restored catalogue differs from the source in ${broken.length} probe(s): ${broken.map((b) => b.slice(0, b.indexOf(':'))).join(', ')}${note}`,
        detail: broken.join('\n'),
      };
}

const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Hand each differing constraint back to PostgreSQL and ask it to print the
 * SOURCE's expression. Pairs that print identically were a spelling
 * difference; everything else is a real difference, including a constraint
 * that exists on one side only.
 */
async function reconcileConstraints(
  pool: Pool,
  lost: readonly string[],
  added: readonly string[],
): Promise<{ readonly reconciled: readonly string[]; readonly unreconciled: readonly string[] }> {
  const keyOf = (l: string): string => l.split(' | ').slice(0, 2).join(' | ');
  const defOf = (l: string): string => l.split(' | ').slice(2).join(' | ');
  const addedByKey = new Map(added.map((l) => [keyOf(l), l] as const));
  const lostKeys = new Set(lost.map(keyOf));
  const reconciled: string[] = [];
  const unreconciled: string[] = [];

  for (const l of lost) {
    const counterpart = addedByKey.get(keyOf(l));
    if (counterpart === undefined) {
      unreconciled.push(`${keyOf(l)} — present in the SOURCE, ABSENT after the restore`);
      continue;
    }
    const table = l.split(' | ')[0] ?? '';
    const expr = /^CHECK \((.*)\)$/s.exec(defOf(l))?.[1];
    if (expr === undefined || !PLAIN_IDENT.test(table)) {
      unreconciled.push(`${keyOf(l)} — differs and is not a reconcilable CHECK on a plain table: source=${defOf(l)} restored=${defOf(counterpart)}`);
      continue;
    }
    const printed = await reprintCheck(pool, table, expr);
    if (printed === defOf(counterpart)) reconciled.push(`${keyOf(l)} — spelling only; the server re-prints the source expression as the restored one`);
    else
      unreconciled.push(
        `${keyOf(l)} — REAL difference: the restored server prints the source expression as "${printed}" but the restore holds "${defOf(counterpart)}"`,
      );
  }
  for (const a of added) {
    if (!lostKeys.has(keyOf(a))) unreconciled.push(`${keyOf(a)} — appeared after the restore and is not in the SOURCE`);
  }
  return { reconciled, unreconciled };
}

/** The server's own printed form of `expr`, obtained inside a rolled-back transaction. */
async function reprintCheck(pool: Pool, table: string, expr: string): Promise<string> {
  const name = 'p15_dr_reparse_probe';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} CHECK (${expr}) NOT VALID`);
    const r = await client.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [
      name,
      `public.${table}`,
    ]);
    return (r.rows[0]?.d ?? '(the server printed nothing)').replace(/ NOT VALID$/, '');
  } catch (e) {
    return `(re-parse failed: ${e instanceof Error ? e.message : String(e)})`;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** V2 — every table's whole-row digest is identical, and the seeded ones are not empty. */
function validateData(source: Readonly<Record<string, string>>, restored: Readonly<Record<string, string>>): ValidatorResult {
  const nonEmpty = Object.entries(source).filter(([, d]) => rowsOf(d) > 0);
  const missing = REQUIRED_NON_EMPTY.filter((t) => rowsOf(source[t] ?? '0:') === 0);
  if (missing.length > 0) {
    return {
      id: 'V2',
      title: 'row-level data is identical',
      verdict: 'UNMEASURED',
      subjects: nonEmpty.length,
      message: `the SOURCE fixture left ${missing.length} required table(s) empty, so a matching digest would prove nothing: ${missing.join(', ')}`,
    };
  }
  const tables = new Set([...Object.keys(source), ...Object.keys(restored)]);
  const changed = [...tables].filter((t) => source[t] !== restored[t]).sort();
  return changed.length === 0
    ? {
        id: 'V2',
        title: 'row-level data is identical',
        verdict: 'PASS',
        subjects: tables.size,
        message: `${tables.size} tables digested, ${nonEmpty.length} of them non-empty, every digest equal`,
      }
    : {
        id: 'V2',
        title: 'row-level data is identical',
        verdict: 'FAIL',
        subjects: tables.size,
        message: `${changed.length} table(s) differ after restore: ${changed.join(', ')}`,
        detail: changed.map((t) => `${t}: source=${source[t] ?? '(absent)'} restored=${restored[t] ?? '(absent)'}`).join('\n'),
      };
}

/** V3 — on the RESTORED database, every posted entry still balances, in integer minor units. */
async function validateLedgerBalance(pool: Pool): Promise<ValidatorResult> {
  const count = Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries`)).rows[0]?.n ?? '0');
  if (count === 0) {
    return {
      id: 'V3',
      title: 'the restored ledger balances',
      verdict: 'UNMEASURED',
      subjects: 0,
      message: 'no journal entries exist — "balanced" would be vacuously true',
    };
  }
  const unbalanced = await pool.query<{ e: string; d: string; c: string }>(
    `SELECT journal_entry_id::text AS e, sum(debit_minor)::text AS d, sum(credit_minor)::text AS c
       FROM journal_lines GROUP BY journal_entry_id HAVING sum(debit_minor) <> sum(credit_minor) ORDER BY 1`,
  );
  const global = (
    await pool.query<{ d: string; c: string }>(`SELECT coalesce(sum(debit_minor),0)::text AS d, coalesce(sum(credit_minor),0)::text AS c FROM journal_lines`)
  ).rows[0];
  const gd = BigInt(global?.d ?? '0');
  const gc = BigInt(global?.c ?? '0');
  if (unbalanced.rowCount !== 0 || gd !== gc) {
    return {
      id: 'V3',
      title: 'the restored ledger balances',
      verdict: 'FAIL',
      subjects: count,
      message: `${unbalanced.rowCount ?? 0} entry/entries do not balance and the global sums are D=${gd} C=${gc}`,
      detail: unbalanced.rows.map((r) => `entry ${r.e}: debit ${r.d} <> credit ${r.c}`).join('\n'),
    };
  }
  return {
    id: 'V3',
    title: 'the restored ledger balances',
    verdict: 'PASS',
    subjects: count,
    message: `${count} entries, every one balanced, global D=C=${gd} minor units`,
  };
}

/** V4 — tenant isolation still holds on the restored copy, probed as the runtime role. */
async function validateTenantIsolation(port: number, fx: Fixture): Promise<ValidatorResult> {
  const [a, b] = fx.tenants;
  if (a === undefined || b === undefined) {
    return {
      id: 'V4',
      title: 'tenant isolation survives the restore',
      verdict: 'UNMEASURED',
      subjects: 0,
      message: 'fewer than two tenants were seeded — a cross-tenant probe has no subject',
    };
  }
  const client = new Client({ connectionString: roleUrl(port, APP_ROLE, APP_PASSWORD, DB) });
  await client.connect();
  const ids = async (tenantId: string | null, businessId: string | null): Promise<string[]> => {
    await client.query('BEGIN');
    try {
      if (tenantId !== null) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      if (businessId !== null) await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);
      const r = await client.query<{ id: string }>(`SELECT id::text AS id FROM journal_entries ORDER BY 1`);
      return r.rows.map((x) => x.id);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  };
  try {
    const own = await ids(a.tenantId, a.businessId);
    const other = await ids(b.tenantId, b.businessId);
    const crossed = await ids(a.tenantId, b.businessId);
    const blind = await ids(null, null);
    const problems: string[] = [];
    if (own.length === 0) problems.push("the owning tenant's own context returned NO rows — the probe cannot distinguish isolation from invisibility");
    if (!own.includes(a.entryId)) problems.push(`the owning tenant cannot see its own seeded entry ${a.entryId}`);
    if (own.includes(b.entryId)) problems.push(`tenant A can see tenant B's entry ${b.entryId}`);
    if (other.includes(a.entryId)) problems.push(`tenant B can see tenant A's entry ${a.entryId}`);
    if (crossed.length !== 0)
      problems.push(
        `tenant A's tenant GUC with tenant B's business GUC returned ${crossed.length} row(s); the restrictive business policy should have left it empty`,
      );
    if (blind.length !== 0) problems.push(`a session with no tenant or business context returned ${blind.length} row(s)`);
    return problems.length === 0
      ? {
          id: 'V4',
          title: 'tenant isolation survives the restore',
          verdict: 'PASS',
          subjects: own.length + other.length,
          message: `as ${APP_ROLE}: own context sees ${own.length}, the other tenant sees ${other.length}, mismatched context and no context both see 0`,
        }
      : {
          id: 'V4',
          title: 'tenant isolation survives the restore',
          verdict: 'FAIL',
          subjects: own.length + other.length,
          message: problems[0] ?? 'isolation failed',
          detail: problems.join('\n'),
        };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** V5 — the migration history came back whole and re-running migrations is a no-op. */
async function validateMigrationRecovery(pool: Pool, sourceHistory: readonly string[]): Promise<ValidatorResult> {
  const restored = (await pool.query<{ t: string }>(`SELECT name || ' | ' || sha256 AS t FROM schema_migrations ORDER BY 1`)).rows.map((x) => x.t);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
  };
  const manifestRows = manifest.migrations.map((m) => `${m.name} | ${m.sha256}`).sort();
  if (restored.length === 0 || sourceHistory.length === 0 || manifestRows.length === 0) {
    return {
      id: 'V5',
      title: 'migration history and upgrade path recovered',
      verdict: 'UNMEASURED',
      subjects: restored.length,
      message: `empty subject set (restored=${restored.length}, source=${sourceHistory.length}, manifest=${manifestRows.length})`,
    };
  }
  const problems: string[] = [];
  const vsSource = diffLists(sourceHistory, restored);
  if (vsSource.onlySource.length > 0 || vsSource.onlyRestored.length > 0) {
    problems.push(`history differs from the source: ${vsSource.onlySource.length} lost, ${vsSource.onlyRestored.length} added`);
  }
  const vsManifest = diffLists(manifestRows, restored);
  if (vsManifest.onlySource.length > 0)
    problems.push(
      `the manifest names ${vsManifest.onlySource.length} migration(s) the restored history does not: ${vsManifest.onlySource.slice(0, 3).join(', ')}`,
    );
  // Re-running must apply nothing: the restored database is already current.
  let reapplied: readonly string[] = [];
  try {
    reapplied = await runMigrations(dbUrl(TARGET.port, DB), MIGRATIONS_DIR);
  } catch (e) {
    problems.push(`re-running migrations against the restored database failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (reapplied.length > 0)
    problems.push(`re-running migrations applied ${reapplied.length} file(s) — the restored history was incomplete: ${reapplied.join(', ')}`);
  return problems.length === 0
    ? {
        id: 'V5',
        title: 'migration history and upgrade path recovered',
        verdict: 'PASS',
        subjects: restored.length,
        message: `${restored.length} history rows match the source and the frozen manifest; re-running the runner applied nothing`,
      }
    : {
        id: 'V5',
        title: 'migration history and upgrade path recovered',
        verdict: 'FAIL',
        subjects: restored.length,
        message: problems[0] ?? '',
        detail: problems.join('\n'),
      };
}

/** V6 — the immutability triggers are alive, not merely catalogued. */
async function validateImmutabilityEnforced(pool: Pool): Promise<ValidatorResult> {
  const line = (await pool.query<{ b: string; i: string }>(`SELECT business_id::text AS b, id::text AS i FROM journal_lines ORDER BY 1 LIMIT 1`)).rows[0];
  if (line === undefined) {
    return {
      id: 'V6',
      title: 'posted-ledger immutability is enforced after restore',
      verdict: 'UNMEASURED',
      subjects: 0,
      message: 'no journal line exists to attempt a forbidden edit on',
    };
  }
  const attempts: { readonly what: string; readonly sql: string; readonly params: readonly unknown[] }[] = [
    { what: 'UPDATE a posted line', sql: `UPDATE journal_lines SET memo = 'tampered' WHERE business_id = $1 AND id = $2`, params: [line.b, line.i] },
    { what: 'DELETE a posted line', sql: `DELETE FROM journal_lines WHERE business_id = $1 AND id = $2`, params: [line.b, line.i] },
  ];
  const problems: string[] = [];
  for (const a of attempts) {
    try {
      await pool.query('BEGIN');
      await pool.query(a.sql, [...a.params]);
      problems.push(`${a.what} was ACCEPTED; the journal_immutable trigger did not fire`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/accounting\.journal_immutable/.test(m)) problems.push(`${a.what} was refused, but not by journal_immutable: ${m}`);
    } finally {
      await pool.query('ROLLBACK').catch(() => undefined);
    }
  }
  return problems.length === 0
    ? {
        id: 'V6',
        title: 'posted-ledger immutability is enforced after restore',
        verdict: 'PASS',
        subjects: attempts.length,
        message: `${attempts.length} forbidden edits, each refused by accounting.journal_immutable`,
      }
    : {
        id: 'V6',
        title: 'posted-ledger immutability is enforced after restore',
        verdict: 'FAIL',
        subjects: attempts.length,
        message: problems[0] ?? '',
        detail: problems.join('\n'),
      };
}

/** V7 — the runtime role's privileges came back as narrow as they were. */
async function validateRuntimePrivileges(port: number): Promise<ValidatorResult> {
  const client = new Client({ connectionString: roleUrl(port, APP_ROLE, APP_PASSWORD, DB) });
  await client.connect();
  const refused: { readonly what: string; readonly sql: string }[] = [
    {
      what: 'write the journal directly',
      sql: `INSERT INTO journal_lines (tenant_id, business_id, journal_entry_id, line_no, account_id, debit_minor, credit_minor, base_amount_minor, base_currency, txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 1, 0, 1, 'ILS', 'ILS', 1, 1, 'base', now())`,
    },
    { what: 'read the accounting assertion keys', sql: `SELECT * FROM accounting_assertion_keys` },
    { what: 'create a table', sql: `CREATE TABLE p15_dr_should_not_exist (i INT)` },
    { what: 'become the internal accounting authority', sql: `SET ROLE daftar_accounting_internal` },
  ];
  const problems: string[] = [];
  // ── The catalogue half, and why it is not redundant ──────────────────────
  //
  // The execution half below cannot see a widened grant on its own: RLS
  // refuses `daftar_app`'s INSERT whether or not the INSERT privilege was
  // granted, so a restore that handed the runtime role write access to the
  // ledger would still look refused. (Red proof R6 found exactly that in an
  // earlier version of this validator, which is why this half exists.) A
  // privilege is a catalogue fact and is asserted as one.
  const FORBIDDEN_PRIVILEGES: readonly { readonly table: string; readonly privilege: string }[] = [
    { table: 'journal_entries', privilege: 'INSERT' },
    { table: 'journal_entries', privilege: 'UPDATE' },
    { table: 'journal_entries', privilege: 'DELETE' },
    { table: 'journal_lines', privilege: 'INSERT' },
    { table: 'journal_lines', privilege: 'UPDATE' },
    { table: 'journal_lines', privilege: 'DELETE' },
    { table: 'accounting_assertion_keys', privilege: 'SELECT' },
    { table: 'accounting_source_bindings', privilege: 'INSERT' },
  ];
  const owner = new Pool({ connectionString: dbUrl(port, DB), max: 1 });
  try {
    for (const f of FORBIDDEN_PRIVILEGES) {
      const r = await owner.query<{ h: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS h`, [APP_ROLE, `public.${f.table}`, f.privilege]);
      if (r.rows[0]?.h === true) problems.push(`${APP_ROLE} holds ${f.privilege} on ${f.table}, a privilege the source did not grant`);
    }
  } finally {
    await owner.end().catch(() => undefined);
  }
  try {
    for (const r of refused) {
      try {
        await client.query('BEGIN');
        await client.query(r.sql);
        problems.push(`${APP_ROLE} could ${r.what} — a privilege the source did not grant`);
      } catch {
        /* refused, as it must be */
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    }
    return problems.length === 0
      ? {
          id: 'V7',
          title: 'runtime role privileges are still narrow',
          verdict: 'PASS',
          subjects: refused.length + FORBIDDEN_PRIVILEGES.length,
          message: `${FORBIDDEN_PRIVILEGES.length} privileges absent from the catalogue and ${refused.length} forbidden operations refused in execution, as ${APP_ROLE}`,
        }
      : {
          id: 'V7',
          title: 'runtime role privileges are still narrow',
          verdict: 'FAIL',
          subjects: refused.length + FORBIDDEN_PRIVILEGES.length,
          message: problems[0] ?? '',
          detail: problems.join('\n'),
        };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** V8 — every runtime role exists on the restored cluster and can still authenticate. */
async function validateRolesRecovered(port: number): Promise<ValidatorResult> {
  const pool = new Pool({ connectionString: adminUrl(port), max: 1 });
  try {
    const present = new Set((await pool.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_roles WHERE rolname LIKE 'daftar%'`)).rows.map((x) => x.r));
    const absent = RUNTIME_ROLES.filter((r) => !present.has(r));
    if (absent.length > 0) {
      return {
        id: 'V8',
        title: 'runtime roles recovered from the globals backup',
        verdict: 'FAIL',
        subjects: present.size,
        message: `${absent.length} role(s) are missing after the globals restore: ${absent.join(', ')}`,
        detail: `globals backup did not carry: ${absent.join(', ')}`,
      };
    }
    // A role that exists but whose password did not survive cannot connect, and
    // the application would be down with every catalogue check green.
    const client = new Client({ connectionString: roleUrl(port, APP_ROLE, APP_PASSWORD, DB) });
    try {
      await client.connect();
      await client.query('SELECT 1');
    } catch (e) {
      return {
        id: 'V8',
        title: 'runtime roles recovered from the globals backup',
        verdict: 'FAIL',
        subjects: present.size,
        message: `${APP_ROLE} exists but cannot authenticate after the restore`,
        detail: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await client.end().catch(() => undefined);
    }
    return {
      id: 'V8',
      title: 'runtime roles recovered from the globals backup',
      verdict: 'PASS',
      subjects: present.size,
      message: `all ${RUNTIME_ROLES.length} runtime roles present and ${APP_ROLE} authenticated`,
    };
  } finally {
    await pool.end();
  }
}

/** V9 — the backup artefacts themselves are present, non-trivial and hashed. */
function validateArtifacts(globals: string, dump: string): ValidatorResult {
  const files = [globals, dump];
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    return {
      id: 'V9',
      title: 'backup artefacts exist and are hashed',
      verdict: 'FAIL',
      subjects: files.length - missing.length,
      message: `${missing.length} backup artefact(s) were never written: ${missing.join(', ')}`,
    };
  }
  const sizes = files.map((f) => statSync(f).size);
  const tiny = files.filter((_, i) => (sizes[i] ?? 0) < 1024);
  if (tiny.length > 0) {
    return {
      id: 'V9',
      title: 'backup artefacts exist and are hashed',
      verdict: 'FAIL',
      subjects: files.length,
      message: `${tiny.length} artefact(s) are under 1 KiB, which no real dump of this schema can be: ${tiny.join(', ')}`,
    };
  }
  return {
    id: 'V9',
    title: 'backup artefacts exist and are hashed',
    verdict: 'PASS',
    subjects: files.length,
    message: `globals ${sizes[0]} bytes sha256=${sha256(globals).slice(0, 16)}…, dump ${sizes[1]} bytes sha256=${sha256(dump).slice(0, 16)}…`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RED PROOFS — each one must turn a NAMED validator red.
   ═══════════════════════════════════════════════════════════════════════════ */
interface RedProof {
  readonly id: string;
  readonly title: string;
  /** The surgical change, applied to a freshly restored copy. */
  readonly mutate: string;
  /** Proof the change landed: this query must return exactly `landedExpected`. */
  readonly landedProbe: string;
  readonly landedExpected: string;
  /** The validator that must fail, and a fragment its message must contain. */
  readonly expect: { readonly validator: string; readonly messageContains: string };
}

const RED_PROOFS: readonly RedProof[] = [
  {
    id: 'R1',
    title: 'a dropped RLS policy is detected',
    mutate: `DROP POLICY tenant_membership ON journal_entries`,
    landedProbe: `SELECT count(*)::text FROM pg_policies WHERE schemaname='public' AND tablename='journal_entries' AND policyname='tenant_membership'`,
    landedExpected: '0',
    expect: { validator: 'V1', messageContains: 'policies' },
  },
  {
    id: 'R2',
    title: 'RLS left enabled but no longer FORCED is detected',
    mutate: `ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`,
    landedProbe: `SELECT relforcerowsecurity::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='journal_lines'`,
    landedExpected: 'false',
    expect: { validator: 'V1', messageContains: 'relations' },
  },
  {
    id: 'R3',
    title: 'a dropped immutability trigger is detected by execution, not only by catalogue',
    mutate: `DROP TRIGGER journal_lines_no_mutation ON journal_lines`,
    landedProbe: `SELECT count(*)::text FROM pg_trigger WHERE NOT tgisinternal AND tgname='journal_lines_no_mutation'`,
    landedExpected: '0',
    expect: { validator: 'V6', messageContains: 'ACCEPTED' },
  },
  {
    id: 'R4',
    title: 'a journal line silently lost in the restore is detected',
    // `session_replication_role = replica` is how the row is removed without
    // the immutability trigger refusing it: the point of R4 is a line LOST in
    // the restore, not a line a user edited, and the trigger is left enabled so
    // V1's trigger probe stays green and only V2 reds.
    mutate: `SET session_replication_role = replica; DELETE FROM journal_lines WHERE id = (SELECT id FROM journal_lines ORDER BY 1 LIMIT 1); SET session_replication_role = origin`,
    landedProbe: `SELECT count(*)::text FROM journal_lines`,
    landedExpected: '3',
    expect: { validator: 'V2', messageContains: 'journal_lines' },
  },
  {
    id: 'R5',
    title: 'a missing migration-history row is detected',
    mutate: `DELETE FROM schema_migrations WHERE name = (SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1)`,
    landedProbe: `SELECT count(*)::text FROM schema_migrations`,
    landedExpected: '73',
    expect: { validator: 'V5', messageContains: 'migration' },
  },
  {
    id: 'R6',
    title: 'a widened runtime grant is detected',
    mutate: `GRANT INSERT ON journal_lines TO daftar_app`,
    landedProbe: `SELECT count(*)::text FROM information_schema.role_table_grants WHERE table_name='journal_lines' AND grantee='daftar_app' AND privilege_type='INSERT'`,
    landedExpected: '1',
    expect: { validator: 'V7', messageContains: 'holds INSERT on journal_lines' },
  },
  {
    id: 'R7',
    title: 'a CHECK constraint missing after the restore is detected — the reconciliation does not absorb it',
    mutate: `ALTER TABLE purchases DROP CONSTRAINT purchases_notes_check`,
    landedProbe: `SELECT count(*)::text FROM pg_constraint WHERE conname = 'purchases_notes_check'`,
    landedExpected: '0',
    expect: { validator: 'V1', messageContains: 'ABSENT after the restore' },
  },
  {
    id: 'R8',
    title: 'a CHECK constraint WEAKENED under the same name is detected — the reconciliation compares predicates, not names',
    mutate: `ALTER TABLE purchases DROP CONSTRAINT purchases_notes_check; ALTER TABLE purchases ADD CONSTRAINT purchases_notes_check CHECK (notes IS NULL OR char_length(notes) >= 1)`,
    landedProbe: `SELECT (pg_get_constraintdef(oid) LIKE '%btrim%')::text FROM pg_constraint WHERE conname = 'purchases_notes_check'`,
    landedExpected: 'false',
    expect: { validator: 'V1', messageContains: 'REAL difference' },
  },
];

/* ═══════════════════════════════════════════════════════════════════════════
   THE DRILL
   ═══════════════════════════════════════════════════════════════════════════ */

interface Timings {
  seedEndedAt: number;
  backupStartedAt: number;
  backupEndedAt: number;
  disasterAt: number;
  restoreStartedAt: number;
  restoreEndedAt: number;
  validatedAt: number;
}

async function main(): Promise<void> {
  const started = new Date();
  const gitSha = (spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
  const gitDirty = (spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').trim().length > 0;

  console.log('━'.repeat(78));
  console.log('PHASE 15 — BACKUP / RESTORE / DR PROOF   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  console.log(`  tree              ${gitSha || '(unknown)'}${gitDirty ? ' + UNCOMMITTED CHANGES' : ''}`);
  console.log(
    `  tools             ${Object.entries(toolVersions())
      .map(([k, v]) => `${k}=${v.split(' ')[2] ?? v}`)
      .join(' ')}`,
  );
  console.log(`  source cluster    ${SOURCE.dir} :${SOURCE.port}`);
  console.log(`  target cluster    ${TARGET.dir} :${TARGET.port}`);
  console.log(`  red proofs        ${PROVE_DETECTION ? `${RED_PROOFS.length} planted` : 'NOT RUN (pass --prove-detection)'}`);
  console.log('');

  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(BACKUP_DIR, { recursive: true });
  const globalsFile = join(BACKUP_DIR, 'globals.sql');
  const dumpFile = join(BACKUP_DIR, `${DB}.dump`);

  const t: Timings = { seedEndedAt: 0, backupStartedAt: 0, backupEndedAt: 0, disasterAt: 0, restoreStartedAt: 0, restoreEndedAt: 0, validatedAt: 0 };
  let sourceStructure: Snapshot = {};
  let sourceData: Readonly<Record<string, string>> = {};
  let sourceHistory: readonly string[] = [];
  let fixture: Fixture | null = null;

  try {
    /* ── 1/8 SOURCE CLUSTER ─────────────────────────────────────────────── */
    console.log('1/8  bringing up the SOURCE cluster');
    stopCluster(SOURCE);
    prepareClusterDir(SOURCE.dir);
    startCluster(SOURCE);

    /* ── 2/8 SCHEMA ─────────────────────────────────────────────────────── */
    console.log('2/8  bootstrap.sql → migrations → assertion keys');
    const { applyBootstrapTo, ensureDatabaseOn } = await bootstrapHelpers();
    await ensureDatabaseOn(SOURCE.port, DB);
    await applyBootstrapTo(SOURCE.port, DB);
    const applied = await runMigrations(dbUrl(SOURCE.port, DB), MIGRATIONS_DIR);
    console.log(`     ${applied.length} migrations applied`);
    await installKeys(SOURCE.port);
    await installAssertionKey(dbUrl(SOURCE.port, DB));

    /* ── 3/8 SEED ───────────────────────────────────────────────────────── */
    console.log('3/8  seeding two tenants with real posted entries');
    const sourcePool = new Pool({ connectionString: dbUrl(SOURCE.port, DB), max: 4 });
    sourcePool.on('error', () => undefined);
    fixture = await seedFixture(sourcePool, roleUrl(SOURCE.port, APP_ROLE, APP_PASSWORD, DB));
    console.log(
      `     tenants ${fixture.tenants.map((x) => x.tenantId.slice(0, 8)).join(', ')}  entries ${fixture.tenants.map((x) => x.entryId.slice(0, 8)).join(', ')}`,
    );
    t.seedEndedAt = nowMs();

    /* ── 4/8 SNAPSHOT THE SOURCE (before it is lost) ─────────────────────── */
    console.log('4/8  snapshotting the source catalogue and data for comparison');
    sourceStructure = await probeAll(sourcePool);
    const tables = await baseTables(sourcePool);
    sourceData = await dataDigest(sourcePool, tables);
    sourceHistory = (await sourcePool.query<{ t: string }>(`SELECT name || ' | ' || sha256 AS t FROM schema_migrations ORDER BY 1`)).rows.map((x) => x.t);
    console.log(`     ${PROBES.length} catalogue probes, ${tables.length} tables digested, ${sourceHistory.length} history rows`);

    /* ── 5/8 BACKUP ─────────────────────────────────────────────────────── */
    console.log('5/8  BACKUP — pg_dumpall --globals-only + pg_dump -Fc');
    t.backupStartedAt = nowMs();
    dumpGlobals(SOURCE.port, globalsFile);
    dumpDatabase(SOURCE.port, DB, dumpFile);
    t.backupEndedAt = nowMs();
    await sourcePool.end().catch(() => undefined);
    console.log(`     globals ${statSync(globalsFile).size} B, dump ${statSync(dumpFile).size} B, ${t.backupEndedAt - t.backupStartedAt} ms`);

    /* ── 6/8 DISASTER ───────────────────────────────────────────────────── */
    console.log('6/8  DISASTER — stopping the source cluster; from here only the backup exists');
    stopCluster(SOURCE);
    t.disasterAt = nowMs();

    /* ── 7/8 RESTORE ────────────────────────────────────────────────────── */
    console.log('7/8  RESTORE onto a fresh cluster');
    t.restoreStartedAt = nowMs();
    stopCluster(TARGET);
    prepareClusterDir(TARGET.dir);
    startCluster(TARGET);
    const tolerated = restoreGlobals(TARGET.port, globalsFile).tolerated;
    createEmptyDatabase(TARGET.port, DB);
    restoreDatabase(TARGET.port, DB, dumpFile);
    t.restoreEndedAt = nowMs();
    console.log(
      `     restored in ${t.restoreEndedAt - t.restoreStartedAt} ms (${tolerated.length} tolerated globals collision(s): the pre-existing bootstrap superuser)`,
    );

    /* ── 8/8 VALIDATE ───────────────────────────────────────────────────── */
    console.log('8/8  VALIDATING the restored system');
    const targetPool = new Pool({ connectionString: dbUrl(TARGET.port, DB), max: 4 });
    targetPool.on('error', () => undefined);
    const restoredStructure = await probeAll(targetPool);
    const restoredData = await dataDigest(targetPool, await baseTables(targetPool));
    record(validateArtifacts(globalsFile, dumpFile));
    record(await validateStructure(sourceStructure, restoredStructure, targetPool));
    record(validateData(sourceData, restoredData));
    record(await validateLedgerBalance(targetPool));
    record(await validateTenantIsolation(TARGET.port, fixture));
    record(await validateMigrationRecovery(targetPool, sourceHistory));
    record(await validateImmutabilityEnforced(targetPool));
    record(await validateRuntimePrivileges(TARGET.port));
    record(await validateRolesRecovered(TARGET.port));
    t.validatedAt = nowMs();
    await targetPool.end().catch(() => undefined);

    /* ── RED PROOFS ─────────────────────────────────────────────────────── */
    const redResults: {
      readonly id: string;
      readonly title: string;
      readonly outcome: 'RED AS REQUIRED' | 'MUTATION DID NOT LAND' | 'VALIDATOR STAYED GREEN';
      readonly note: string;
    }[] = [];
    if (PROVE_DETECTION) {
      console.log('');
      console.log(`RED PROOFS — ${RED_PROOFS.length} planted defects, each must turn a named validator red`);
      for (const rp of RED_PROOFS) {
        redResults.push(await runRedProof(rp, dumpFile, sourceStructure, sourceData, sourceHistory, fixture));
      }
    }

    /* ── REPORT ─────────────────────────────────────────────────────────── */
    const rpoMs = t.restoreStartedAt - t.backupStartedAt;
    const rtoMs = t.validatedAt - t.disasterAt;
    const failed = results.filter((r) => r.verdict === 'FAIL');
    const unmeasured = results.filter((r) => r.verdict === 'UNMEASURED');
    const redBad = redResults.filter((r) => r.outcome !== 'RED AS REQUIRED');

    console.log('');
    console.log('─'.repeat(78));
    console.log('MEASURED RECOVERY OBJECTIVES');
    console.log('─'.repeat(78));
    console.log(`  RPO (this drill)  ${rpoMs} ms — the age of the dump when the restore began.`);
    console.log('                    This is the FULL-DUMP RPO only. Continuous WAL / PITR is');
    console.log('                    UNMEASURED: no WAL archiving exists in this repository to test.');
    console.log(`  RTO (this drill)  ${rtoMs} ms — disaster declared → restored system validated,`);
    console.log('                    on a fixture-sized database in this container. NOT a production');
    console.log('                    figure: the documented target (≤ 4 h) is UNMEASURED here.');
    console.log(`  backup duration   ${t.backupEndedAt - t.backupStartedAt} ms`);
    console.log(`  restore duration  ${t.restoreEndedAt - t.restoreStartedAt} ms`);
    console.log(
      `  host load         ${loadavg()
        .map((l) => l.toFixed(2))
        .join(' ')}`,
    );
    console.log('');
    console.log('─'.repeat(78));
    console.log('LIMITATIONS — true of every run, printed on PASS as well as on FAIL');
    console.log('─'.repeat(78));
    for (const l of [
      'This proves a FULL LOGICAL DUMP restore. It does not prove PITR, and the',
      '  repository contains no WAL-archiving configuration for PITR to be tested against.',
      'Database only: object storage, Redis and secret material are out of scope.',
      "Timings are this container's, on a fixture-sized database. They are not a",
      '  production RTO and must not be quoted as one.',
      'The schema under test ends at migration 0073 (this branch). Phase 4 candidates',
      '  0074+ are on another branch and are NOT covered.',
      'Without --prove-detection no validator has been shown to fail, and a validator',
      '  that has never failed is not evidence.',
    ])
      console.log(`  • ${l}`);

    const summary = {
      status: 'PREPARED / NOT PROMOTED',
      sha: gitSha,
      dirty: gitDirty,
      startedAt: started.toISOString(),
      validators: results.map((r) => ({ id: r.id, verdict: r.verdict, subjects: r.subjects })),
      redProofs: redResults.map((r) => ({ id: r.id, outcome: r.outcome })),
      rpoMs,
      rtoMs,
      backupMs: t.backupEndedAt - t.backupStartedAt,
      restoreMs: t.restoreEndedAt - t.restoreStartedAt,
      artefacts: {
        globals: { bytes: statSync(globalsFile).size, sha256: sha256(globalsFile) },
        dump: { bytes: statSync(dumpFile).size, sha256: sha256(dumpFile) },
      },
      pitr: 'UNMEASURED',
    };
    console.log('');
    console.log(`P15_DR_PROOF: ${JSON.stringify(summary)}`);
    writeFileSync(join(BACKUP_DIR, 'run-identity.json'), `${JSON.stringify({ ...summary, tools: toolVersions(), loadavg: loadavg() }, null, 2)}\n`);

    console.log('');
    if (failed.length > 0 || unmeasured.length > 0 || redBad.length > 0) {
      console.log(`VERDICT: FAIL — ${failed.length} validator(s) failed, ${unmeasured.length} UNMEASURED, ${redBad.length} red proof(s) did not behave.`);
      process.exitCode = 1;
    } else {
      console.log(
        `VERDICT: PASS — ${results.length} validators, every one with a non-empty subject${PROVE_DETECTION ? `, and all ${RED_PROOFS.length} red proofs turned their named validator red` : ', red proofs NOT RUN'}.`,
      );
      process.exitCode = 0;
    }
  } finally {
    if (!KEEP) {
      stopCluster(SOURCE);
      stopCluster(TARGET);
    } else {
      console.log(`\n(--keep) clusters left running: source :${SOURCE.port}, target :${TARGET.port}`);
    }
  }
}

/**
 * One red proof: restore a clean copy, mutate it, PROVE the mutation landed,
 * then require the named validator to fail.
 *
 * The order matters. Reading the validator's result before confirming the
 * mutation would let a change that never happened be recorded as a detected
 * defect, which is the inverse of a proof.
 */
async function runRedProof(
  rp: RedProof,
  dumpFile: string,
  sourceStructure: Snapshot,
  sourceData: Readonly<Record<string, string>>,
  sourceHistory: readonly string[],
  fixture: Fixture,
): Promise<{
  readonly id: string;
  readonly title: string;
  readonly outcome: 'RED AS REQUIRED' | 'MUTATION DID NOT LAND' | 'VALIDATOR STAYED GREEN';
  readonly note: string;
}> {
  dropDatabase(TARGET.port, DB);
  createEmptyDatabase(TARGET.port, DB);
  restoreDatabase(TARGET.port, DB, dumpFile);
  const pool = new Pool({ connectionString: dbUrl(TARGET.port, DB), max: 2 });
  pool.on('error', () => undefined);
  try {
    await pool.query(rp.mutate);
    const landed = (await pool.query<{ c: string }>(rp.landedProbe)).rows[0];
    const actual = landed === undefined ? '(no row)' : String(Object.values(landed)[0]);
    if (actual !== rp.landedExpected) {
      const note = `the mutation did not land: probe returned ${actual}, expected ${rp.landedExpected}`;
      console.log(`  [MUTATION DID NOT LAND] ${rp.id} ${rp.title} — ${note}`);
      return { id: rp.id, title: rp.title, outcome: 'MUTATION DID NOT LAND', note };
    }

    const before = results.length;
    const restoredStructure = await probeAll(pool);
    const restoredData = await dataDigest(pool, await baseTables(pool));
    const got: ValidatorResult[] = [
      await validateStructure(sourceStructure, restoredStructure, pool),
      validateData(sourceData, restoredData),
      await validateLedgerBalance(pool),
      await validateTenantIsolation(TARGET.port, fixture),
      await validateMigrationRecovery(pool, sourceHistory),
      await validateImmutabilityEnforced(pool),
      await validateRuntimePrivileges(TARGET.port),
    ];
    results.length = before; // a red proof's own runs are not the drill's verdict
    const named = got.find((g) => g.id === rp.expect.validator);
    if (named === undefined) {
      const note = `red proof names validator ${rp.expect.validator}, which did not run`;
      console.log(`  [VALIDATOR STAYED GREEN] ${rp.id} ${rp.title} — ${note}`);
      return { id: rp.id, title: rp.title, outcome: 'VALIDATOR STAYED GREEN', note };
    }
    if (named.verdict === 'PASS') {
      const note = `${rp.expect.validator} still PASSED with the defect present: ${named.message}`;
      console.log(`  [VALIDATOR STAYED GREEN] ${rp.id} ${rp.title} — ${note}`);
      return { id: rp.id, title: rp.title, outcome: 'VALIDATOR STAYED GREEN', note };
    }
    const haystack = `${named.message}\n${named.detail ?? ''}`;
    if (!haystack.includes(rp.expect.messageContains)) {
      const note = `${rp.expect.validator} failed, but its message does not name "${rp.expect.messageContains}": ${named.message}`;
      console.log(`  [VALIDATOR STAYED GREEN] ${rp.id} ${rp.title} — ${note}`);
      return { id: rp.id, title: rp.title, outcome: 'VALIDATOR STAYED GREEN', note };
    }
    const note = `${rp.expect.validator} ${named.verdict}: ${named.message}`;
    console.log(`  [RED AS REQUIRED] ${rp.id} ${rp.title} — ${note}`);
    return { id: rp.id, title: rp.title, outcome: 'RED AS REQUIRED', note };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/* ── bootstrap and keys, applied to an arbitrary port ───────────────────────
   `tests/helpers/embedded-cluster.ts` does the same thing but only for the
   cluster named by PG_DIR/PG_PORT, and importing it would also import the
   embedded distribution this drill deliberately does not use. The password
   placeholders are the throwaway fixture values, identical to the suites' so
   that a developer can point the test helpers at a kept cluster. */
async function bootstrapHelpers(): Promise<{
  applyBootstrapTo: (port: number, db: string) => Promise<void>;
  ensureDatabaseOn: (port: number, db: string) => Promise<void>;
}> {
  const PASSWORDS: Readonly<Record<string, string>> = {
    __APP_DB_PASSWORD__: APP_PASSWORD,
    __PLATFORM_DB_PASSWORD__: 'test_platform_password_123',
    __WORKER_DB_PASSWORD__: 'test_worker_password_123',
    __RESOLVER_DB_PASSWORD__: 'test_resolver_password_123',
    __IDENTITY_DB_PASSWORD__: 'test_identity_password_123',
    __PROVISIONER_DB_PASSWORD__: 'test_provisioner_password_123',
    __RECONCILER_DB_PASSWORD__: 'test_reconciler_password_123',
    __MIGRATOR_DB_PASSWORD__: 'test_migrator_password_123',
  };
  return {
    async ensureDatabaseOn(port, db) {
      const pool = new Pool({ connectionString: adminUrl(port), max: 1 });
      try {
        const r = await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [db]);
        if (r.rowCount === 0) await pool.query(`CREATE DATABASE ${db}`);
      } finally {
        await pool.end();
      }
    },
    async applyBootstrapTo(port, db) {
      let sql = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
      for (const [k, v] of Object.entries(PASSWORDS)) sql = sql.replaceAll(k, v);
      const pool = new Pool({ connectionString: dbUrl(port, db), max: 1 });
      try {
        await pool.query(sql);
      } finally {
        await pool.end();
      }
    },
  };
}

/** The provisioning and inventory assertion keys, through their own ops commands. */
async function installKeys(port: number): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl(port, DB), max: 1 });
  try {
    await pool.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, ['p15dr', Buffer.alloc(32, 'V').toString('base64')]);
    await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, ['p15dr', Buffer.alloc(32, 'I').toString('base64')]);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('');
  console.error('P15 DR PROOF ABORTED — the drill itself failed, which is not a PASS and not a FAIL of the restore:');
  console.error(e instanceof Error ? `${e.message}\n${(e as { detail?: string }).detail ?? ''}` : String(e));
  stopCluster(SOURCE);
  stopCluster(TARGET);
  process.exit(2);
});
