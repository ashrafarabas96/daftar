#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE THREE INVENTORIES, DISCOVERED
 *
 * The idempotency, permission and source inventories. Every row is DISCOVERED
 * from the tree at `root`; nothing here is a hand-written list of what the
 * tree contains. A hand-written inventory of a thing agents are adding to in
 * four worktrees is wrong before it is committed, and an inventory that is
 * wrong in the direction of "fewer rows than exist" is the dangerous
 * direction: the key nobody listed is the key nobody checked.
 *
 * ── THE IDEMPOTENCY INVENTORY ────────────────────────────────────────────
 *
 * `P4-AL-30`: idempotency is a caller-supplied document UUID plus a stored
 * `intent_sha256`, read before any other read, under a per-document advisory
 * lock. There is no `idempotency_key` column — except ONE, on
 * `onboarding_operations` (`0018:7`), which is Phase 1 and is in the inventory
 * precisely because it is the counter-example the decision was taken against.
 *
 * For every key the inventory records the four things the directive names:
 *
 *   IDENTITY        — what makes the command this command (the document UUID,
 *                     and the relation that holds it)
 *   INTENT HASH     — the column the request's meaning is digested into
 *   EXACT REPLAY    — what a replay carrying the SAME intent returns
 *   CHANGED INTENT  — the refusal code a DIFFERENT intent conflicts on
 *
 * plus the two ordering facts `P4-AL-30` makes part of the decision:
 *
 *   `[[daftar-idempotency-key-is-not-permission]]` — a bare key proves a
 *   request was seen before and says nothing about WHICH request it was, so a
 *   replay carrying the same key and different content would be answered
 *   "success". The inventory therefore records whether the key has an intent
 *   digest at all, and a key that does not is a FINDING, not a row.
 *
 *   `[[daftar-registry-before-state]]` — the proof must be consulted BEFORE
 *   current state is read, or a stale request replayed after a later
 *   transition performs a second real change. `registryBeforeState` measures
 *   the two offsets in the routine body and reports which came first.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type TreeFacts, readTree, routineBody } from './tree';

// ───────────────────────── IDEMPOTENCY ────────────────────────────────────

export interface IdempotencyKey {
  /** The database routine that owns the replay path. */
  readonly routine: string;
  /** The migration that last defines it. */
  readonly migration: string;
  /** The relation holding the document row that IS the identity. */
  readonly identityRelation: string;
  /** The identity: the argument the caller supplies as the document's own id. */
  readonly identityArgument: string;
  /** The advisory lock the identity is held under, or null if none was found. */
  readonly advisoryKey: string | null;
  /**
   * HOW THE IDENTITY IS HELD WHILE THE INTENT IS COMPARED.
   *
   * `P4-AL-30` names the per-document advisory lock, and the accepted tree
   * uses three mechanisms, all three of which serialise two concurrent replays
   * of one document:
   *
   *   `advisory`  the per-document `pg_advisory_xact_lock` the decision names;
   *   `row`       `SELECT … FOR UPDATE` on the identity row itself
   *               (`0079:1003`, `0078:586`) — the same serialisation at a
   *               narrower grain;
   *   `physical`  `INSERT … ON CONFLICT DO NOTHING`, then `GET DIAGNOSTICS`,
   *               then re-read and compare (`0062:325-339`) — the UNIQUE
   *               itself is the lock, which is the form `P4-AL-30`'s own last
   *               paragraph calls for ("refused AT THE DATABASE by a real
   *               UNIQUE over real columns").
   *
   * `none` is the finding. Enumerating the three is the difference between an
   * inventory that reports three accepted routines as defective and one that
   * reports which mechanism each uses.
   */
  readonly identityGuard: 'advisory' | 'row' | 'physical' | 'none';
  /** The column the intent is digested into. */
  readonly intentColumn: string | null;
  /** What an equal-intent replay returns, in the routine's own words. */
  readonly exactReplay: string;
  /** The refusal a changed intent conflicts on. */
  readonly changedIntentConflict: string | null;
  /**
   * Did the intent read precede the first REAL CHANGE? `P4-AL-30`.
   *
   * The hazard the decision names is "a stale request replayed after a later
   * transition performs a SECOND REAL CHANGE", so the thing the registry must
   * come before is the change, not every lookup. `false` is a finding.
   */
  readonly registryBeforeState: boolean | null;
  /**
   * Did the routine take a domain row lock BEFORE comparing the intent?
   *
   * Recorded as a FACT and not as a finding. Several accepted routines lock
   * the source row and then compare (`0072:466-471`), which is a lock-order
   * decision rather than an idempotency defect: the comparison still precedes
   * every state-dependent refusal and every write. Recorded because it is the
   * fact a reader needs to judge that for themselves.
   */
  readonly locksBeforeIntent: boolean | null;
  /** The physical UNIQUE constraints that refuse a replay AT THE DATABASE. */
  readonly backingUniques: readonly string[];
  /** A bare key with no intent digest — the shape `P4-AL-30` forbids. */
  readonly bareKey: boolean;
}

const REPLAY_READ = /SELECT\s+([a-z_][a-z0-9_]*)\.((?:[a-z_][a-z0-9_]*_)?intent_sha256)\s*(?:,|INTO)/i;
const MULTI_READ = /SELECT\s+(?:[^;]*?)([a-z_][a-z0-9_]*)\.((?:[a-z_][a-z0-9_]*_)?intent_sha256)\s*INTO/i;
const FROM_RELATION = /\bFROM\s+(?:public\.)?([a-z_][a-z0-9_]*)/i;
const ADVISORY = /(?:pg_catalog\.)?pg_advisory_xact_lock(?:_shared)?\s*\(\s*(?:pg_catalog\.)?hashtext(?:extended)?\s*\(\s*'([^']+)'\s*\)/i;
/**
 * THE REFUSAL A CHANGED INTENT CONFLICTS ON.
 *
 * Found by locating the branch that COMPARES the stored digest against the
 * re-derived one, in either of the two shapes the accepted tree uses, and
 * taking the refusal that a CHANGED intent actually reaches:
 *
 *   NEGATIVE  `IF <col>_intent_sha256 <> v_intent THEN RAISE <code>` — the
 *             refusal is the RAISE in that branch (`0078:588`, `0079:1012`).
 *   POSITIVE  `IF <state> = ... AND <col>_intent_sha256 = v_intent THEN
 *             v_replay := true; ELSE … RAISE <code>` — a changed intent falls
 *             THROUGH to the ELSE, so the refusal is what the ELSE raises
 *             (`0064:1047-1053` purchase.state_invalid / draft_changed,
 *             `0064:471-475` supplier.revision_changed).
 *
 * Neither the variable names nor the word `idempotency_conflict` are the
 * mechanism: the BRANCH is, and the code is only its name. A rule that
 * pattern-matched the word reported five accepted routines as having no
 * conflict refusal at all, which is the kind of false finding that gets a
 * whole inventory distrusted.
 */
const COMPARISON = /\b([a-z_][a-z0-9_.]*)\s*(<>|=|IS\s+NOT\s+DISTINCT\s+FROM|IS\s+DISTINCT\s+FROM)\s*([a-z_][a-z0-9_.]*)/gi;
const RAISE_CODE = /RAISE\s+EXCEPTION\s+'([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+)/i;

/**
 * The first comparison in the body in which ONE SIDE is an intent digest.
 *
 * Either side, because the tree writes it both ways (`v_stored <> v_intent`
 * and `v_row.cancel_intent_sha256 = v_intent`), and a rule anchored to one
 * side reported half the estate as unprotected.
 */
function intentComparison(body: string): { index: number; negative: boolean } | null {
  COMPARISON.lastIndex = 0;
  let m = COMPARISON.exec(body);
  while (m !== null) {
    const left = (m[1] ?? '').toLowerCase();
    const right = (m[3] ?? '').toLowerCase();
    if (left.includes('intent') || right.includes('intent')) {
      const operator = (m[2] ?? '').toUpperCase().replace(/\s+/g, ' ');
      return { index: m.index, negative: operator === '<>' || operator === 'IS DISTINCT FROM' };
    }
    m = COMPARISON.exec(body);
  }
  return null;
}

/**
 * Which of the three accepted mechanisms holds the identity.
 *
 * Ordered by the strength of the evidence, not by preference: an advisory key
 * is unambiguous, a `FOR UPDATE` on the identity relation is unambiguous once
 * the relation is resolved, and the physical form is recognised by its three
 * parts together (`ON CONFLICT DO NOTHING`, `GET DIAGNOSTICS`, and a re-read
 * of the intent) rather than by `ON CONFLICT` alone — because `ON CONFLICT`
 * on some other relation is not a replay guard at all.
 */
function identityGuardOf(body: string, identityRelation: string, advisoryKey: string | null): 'advisory' | 'row' | 'physical' | 'none' {
  if (advisoryKey !== null) return 'advisory';
  const rowLock = new RegExp(`FROM\\s+(?:public\\.)?${identityRelation}\\b[^;]{0,400}?FOR\\s+(?:NO\\s+KEY\\s+)?UPDATE`, 'i');
  if (identityRelation !== 'unresolved' && rowLock.test(body)) return 'row';
  const physical =
    new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${identityRelation}\\b[\\s\\S]{0,2000}?ON\\s+CONFLICT[\\s\\S]{0,200}?DO\\s+NOTHING`, 'i').test(body) &&
    /GET\s+DIAGNOSTICS/i.test(body) &&
    /intent_sha256\s+INTO/i.test(body);
  if (physical) return 'physical';
  return 'none';
}

function conflictRefusal(body: string): string | null {
  const comparison = intentComparison(body);
  if (comparison === null) return null;
  if (comparison.negative) return RAISE_CODE.exec(body.slice(comparison.index, comparison.index + 900))?.[1] ?? null;
  const elseAt = body.indexOf('ELSE', comparison.index);
  if (elseAt === -1) return null;
  return RAISE_CODE.exec(body.slice(elseAt, elseAt + 1400))?.[1] ?? null;
}

/**
 * Every idempotency key in the system.
 *
 * THE DISCOVERY RULE, stated so it can be refuted: a routine is a replay path
 * if and only if its body READS an `*intent_sha256` column into a variable.
 * That is the mechanism `P4-AL-30` names, so a routine that does not do it is
 * not a replay path, and a routine that does cannot hide from the rule by
 * being named something new.
 */
export function discoverIdempotencyKeys(root: string): IdempotencyKey[] {
  const facts = readTree(root);
  const out: IdempotencyKey[] = [];

  for (const [routine, migration] of [...facts.routines].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = routineBody(facts, routine);
    if (body === null) continue;
    const read = REPLAY_READ.exec(body) ?? MULTI_READ.exec(body);
    if (read === null) continue;

    const intentColumn = read[2] ?? null;
    const alias = read[1] ?? '';
    // The relation is the `FROM` of the statement that performed the read.
    const after = body.slice(read.index, read.index + 600);
    const from = FROM_RELATION.exec(after);
    const identityRelation = from === null ? 'unresolved' : (from[1] ?? 'unresolved');

    const advisory = ADVISORY.exec(body);
    const advisoryKey = advisory === null ? null : (advisory[1] ?? null);

    // The identity argument: the `p_*` parameter the read compares the row on.
    const identityArgument = /\b(p_[a-z_]+)\s*(?:;|\s|\))/.exec(after.slice(after.search(/WHERE/i) === -1 ? 0 : after.search(/WHERE/i)))?.[1] ?? 'unresolved';

    const conflict = conflictRefusal(body);

    // REGISTRY BEFORE STATE. The intent read's offset versus the first OTHER
    // read of a domain relation. Measured, not assumed: this is the ordering
    // whose absence lets a stale request replayed after a later transition
    // perform a second real change.
    const intentAt = read.index;
    const changeAt = firstChangeOffset(body);
    const registryBeforeState = changeAt === null ? null : intentAt < changeAt;
    const lockAt = firstStateReadOffset(body, identityRelation, intentAt);
    const locksBeforeIntent = lockAt === null ? null : lockAt < intentAt;

    const backingUniques = [...facts.constraints.keys()].filter((c) => c.startsWith(`${identityRelation}_`) && (c.endsWith('_uq') || c.includes('_unique')));

    out.push({
      routine,
      migration,
      identityRelation,
      identityArgument,
      advisoryKey,
      identityGuard: identityGuardOf(body, identityRelation, advisoryKey),
      intentColumn,
      exactReplay: describeReplay(body, alias),
      changedIntentConflict: conflict,
      registryBeforeState,
      locksBeforeIntent,
      backingUniques,
      bareKey: false,
    });
  }

  // The ONE bare key in the tree, and the reason `P4-AL-30` exists. Discovered
  // by the same kind of rule (a column literally named `idempotency_key`)
  // rather than hard-coded, so a second one cannot appear unlisted.
  for (const column of facts.columns)
    if (column.endsWith('.idempotency_key')) {
      const relation = column.slice(0, column.indexOf('.'));
      out.push({
        routine: `(none — the key is the row's own PRIMARY KEY on ${relation})`,
        migration: facts.relations.get(relation) ?? 'unknown',
        identityRelation: relation,
        identityArgument: 'p_key',
        advisoryKey: null,
        // The composite PRIMARY KEY is the guard: a second INSERT of the same
        // (user, key) cannot commit. That is the `physical` mechanism, and it
        // is the ONLY protection this row has — which is the counter-example
        // P4-AL-30 was decided against, since the key says a request was seen
        // and the `payload_hash` beside it is compared by the APPLICATION
        // rather than by the database.
        identityGuard: 'physical',
        intentColumn: facts.columns.has(`${relation}.payload_hash`) ? 'payload_hash' : null,
        exactReplay: 'the recorded result tenant/business of the first call',
        changedIntentConflict: null,
        registryBeforeState: null,
        locksBeforeIntent: null,
        backingUniques: [`PRIMARY KEY (user_id, idempotency_key)`],
        bareKey: true,
      });
    }

  return out;
}

/** The offset of the first DML in the body: the first REAL CHANGE. */
function firstChangeOffset(body: string): number | null {
  const dml = /\b(?:INSERT\s+INTO|UPDATE\s+(?:public\.)?[a-z_][a-z0-9_]*\s+SET|DELETE\s+FROM)\b/i.exec(body);
  return dml === null ? null : dml.index;
}

/**
 * THE OFFSET OF THE FIRST DOMAIN ROW LOCK.
 *
 * `P4-AL-30` says "the first read of every Phase 4 command is the document row
 * and its `intent_sha256`". The reads that make a stale replay dangerous are
 * the LOCKING ones — a `FOR UPDATE` / `FOR SHARE` / `FOR NO KEY UPDATE` on a
 * domain row whose current state the command then acts on. A non-locking
 * lookup of the actor's own scope row cannot be the thing a stale replay
 * races, and counting it would report every accepted routine in the tree as
 * defective, which is a measurement of this rule rather than of the product.
 *
 * So: the first locking acquisition on a relation OTHER than the identity
 * relation. Reported with its offset, so a finding names something.
 */
function firstStateReadOffset(body: string, identityRelation: string, intentAt: number): number | null {
  const clause = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/gi;
  let m = clause.exec(body);
  while (m !== null) {
    const before = body.slice(0, m.index);
    const from = /(?:\bFROM|\bUPDATE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let relation = '';
    let f = from.exec(before);
    while (f !== null) {
      relation = (f[1] ?? '').toLowerCase();
      f = from.exec(before);
    }
    if (relation !== identityRelation && relation !== '' && m.index !== intentAt) return m.index;
    m = clause.exec(body);
  }
  return null;
}

function describeReplay(body: string, alias: string): string {
  // `RETURN` immediately after the equality branch is the replay's answer.
  const equality = new RegExp(`v_stored\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,400}?RETURN\\s+([^;]{0,160});`, 'i').exec(body);
  if (equality !== null) return `RETURN ${(equality[1] ?? '').replace(/\s+/g, ' ').trim()}`;
  const anyReturn = new RegExp(`IS\\s+NOT\\s+DISTINCT\\s+FROM[\\s\\S]{0,400}?RETURN\\s+([^;]{0,160});`, 'i').exec(body);
  if (anyReturn !== null) return `RETURN ${(anyReturn[1] ?? '').replace(/\s+/g, ' ').trim()}`;
  return `the stored rows of ${alias === '' ? 'the document' : alias} (shape not resolvable from the body text)`;
}

/**
 * The inventory's own laws. A key with no intent digest, or one that reads
 * state before its registry, is a FINDING — routed to the slice that owns the
 * routine, because S8 is evidence and S9 is evidence only.
 */
export function idempotencyFindings(keys: readonly IdempotencyKey[]): string[] {
  const findings: string[] = [];
  if (keys.length === 0)
    findings.push('the idempotency inventory is EMPTY — no replay path was discovered, which is a defect of the discovery rule, not a property of the tree');
  for (const key of keys) {
    if (key.bareKey && key.intentColumn === null)
      findings.push(
        `${key.identityRelation}: a BARE idempotency key with no intent digest — a key proves a request was seen, never WHICH request it was ([[daftar-idempotency-key-is-not-permission]])`,
      );
    if (!key.bareKey && key.intentColumn === null) findings.push(`${key.routine}: a replay path with no intent column`);
    if (!key.bareKey && key.identityGuard === 'none')
      findings.push(
        `${key.routine}: the identity is held by NONE of the three accepted mechanisms (per-document advisory lock, FOR UPDATE on the identity row, or INSERT ... ON CONFLICT DO NOTHING plus a re-read), so two concurrent replays can both pass the intent comparison`,
      );
    if (key.registryBeforeState === false)
      findings.push(
        `${key.routine}: reads domain state BEFORE its intent registry — a stale request replayed after a later transition performs a second real change ([[daftar-registry-before-state]])`,
      );
    if (!key.bareKey && key.changedIntentConflict === null)
      findings.push(`${key.routine}: no refusal code was found for a CHANGED intent, so a different request can be answered "success"`);
  }
  return findings;
}

// ───────────────────────── PERMISSIONS ────────────────────────────────────

export interface PermissionRow {
  readonly key: string;
  readonly phase: string;
  readonly sensitive: boolean;
  /** The built-in roles that hold it BY DEFAULT. */
  readonly defaultRoles: readonly string[];
  /** The migration-time `DO`-block assertion that binds it, if any. */
  readonly migrationAssertion: string | null;
  /** The API files that require it, discovered from the source. */
  readonly requiredBy: readonly string[];
}

const PHASE_OF: readonly (readonly [RegExp, string])[] = [
  [/^(sales|customers|payments|refunds|receivables|installments)\./, 'Phase 4'],
  [/^(inventory|purchases|suppliers)\./, 'Phase 3'],
  [/^accounting\./, 'Phase 2'],
];

export function discoverPermissions(root: string): PermissionRow[] {
  const facts = readTree(root);
  const requiredIndex = indexPermissionRequirements(root);
  const assertionIndex = indexMigrationAssertions(facts);
  return facts.permissions.map((key) => {
    const phase = PHASE_OF.find(([pattern]) => pattern.test(key))?.[1] ?? 'Phase 1';
    const defaultRoles = [...facts.builtinRoleDefaults]
      .filter(([, keys]) => keys.includes(key))
      .map(([role]) => role)
      .sort();
    return {
      key,
      phase,
      sensitive: facts.sensitivePermissions.has(key),
      defaultRoles,
      migrationAssertion: assertionIndex.get(key) ?? null,
      requiredBy: requiredIndex.get(key) ?? [],
    };
  });
}

function indexPermissionRequirements(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      const childRel = `${rel}/${entry}`;
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(join(root, childRel), 'utf8');
        const literal =
          /'((?:sales|customers|payments|refunds|receivables|installments|inventory|purchases|suppliers|accounting|catalog|member|role|branch|warehouse|business|settings|billing|subscription|category|media)\.[a-z_.]+)'/g;
        let m = literal.exec(text);
        while (m !== null) {
          const key = m[1];
          if (key !== undefined) {
            const list = index.get(key) ?? [];
            if (!list.includes(childRel)) list.push(childRel);
            index.set(key, list);
          }
          m = literal.exec(text);
        }
      }
    }
  };
  walk('apps/api/src');
  return index;
}

/**
 * The one-shot migration-time `DO`-block assertions over hard-coded key
 * arrays (`0041:57-65`, `0057:140-151`, and the Phase 4 one `P4-AL-37`
 * requires). Discovered by finding the migration whose text mentions the key
 * near `permission_backfill_overreach`, which is the refusal all three raise.
 */
function indexMigrationAssertions(facts: TreeFacts): Map<string, string> {
  const index = new Map<string, string>();
  for (const migration of facts.migrations) {
    if (!migration.text.includes('permission_backfill_overreach')) continue;
    const keys = /'([a-z]+\.[a-z_.]+)'/g;
    let m = keys.exec(migration.text);
    while (m !== null) {
      const key = m[1];
      if (key !== undefined && !index.has(key)) index.set(key, migration.name);
      m = keys.exec(migration.text);
    }
  }
  return index;
}

/**
 * `P4-AL-37` and the `OD-P4-01` OPTION A ruling: no SENSITIVE key may be a
 * DEFAULT of any built-in role, the cashier and the manager included. The
 * owner holds the whole registry by identity and is exempt by construction.
 */
export function permissionFindings(rows: readonly PermissionRow[]): string[] {
  const findings: string[] = [];
  if (rows.length === 0) findings.push('the permission inventory is EMPTY — the registry could not be read, which is a defect of the discovery rule');
  for (const row of rows) {
    const nonOwnerDefaults = row.defaultRoles.filter((r) => r !== 'owner');
    // `OD-P4-01` OPTION A (2026-09-30) is a ruling about PHASE 4 sensitive
    // keys: none of the six may be a default of any built-in role. It is NOT
    // retroactive over Phase 1's own sensitivity classification — `role.assign`
    // is sensitive and is a manager default (`permissions.ts`, accepted Phase 1
    // surface), and reporting that as a Phase 4 finding would be an over-claim
    // against a sealed decision. The fact is recorded by
    // `inheritedSensitiveDefaults` below instead, where a reader can see it
    // without it being counted as this slice's finding.
    if (row.sensitive && row.phase === 'Phase 4' && nonOwnerDefaults.length > 0)
      findings.push(
        `${row.key} is a SENSITIVE Phase 4 key and is a DEFAULT of ${nonOwnerDefaults.join(', ')} — OD-P4-01 OPTION A forbids that for any built-in role`,
      );
    if (row.phase === 'Phase 4' && row.migrationAssertion === null)
      findings.push(
        `${row.key} is a Phase 4 key with no migration-time role-default assertion behind it (P4-AL-37) — nothing in the database stops a later migration granting it by default`,
      );
  }
  return findings;
}

/**
 * Sensitive keys that ARE built-in defaults and are not Phase 4's.
 *
 * Recorded, not reported as a finding: these are accepted Phase 1 and Phase 2
 * classifications and `OD-P4-01` does not reach them. They are in the
 * inventory because a reader comparing the Phase 4 rule against the estate
 * will notice them, and an inventory that silently omitted them would look
 * like it had not looked.
 */
export function inheritedSensitiveDefaults(rows: readonly PermissionRow[]): readonly PermissionRow[] {
  return rows.filter((r) => r.sensitive && r.phase !== 'Phase 4' && r.defaultRoles.some((role) => role !== 'owner'));
}

// ───────── THE SAME QUESTION, ASKED OF THE LIVE CATALOGUE ─────────────────

/**
 * `[[daftar-the-live-catalogue-is-the-policy]]`.
 *
 * Everything above reads the TypeScript registry, which is the DECLARATION.
 * The thing that actually decides what a cashier may do is the row in
 * `role_permissions`, and a migration, a backfill or an operator can put a row
 * there that the declaration never mentioned. So the same question is asked of
 * `role_permissions` joined to `business_roles`, out of the live database.
 *
 * A lexical check over the migration text could not answer this: the row may
 * arrive from a `DO` block, from a backfill driven by a join, or from an
 * operator. `[[daftar-grant-before-owner]]` is the neighbouring lesson — what
 * is granted is a fact about the catalogue, not about the file that asked.
 */
export const LIVE_ROLE_GRANT_SQL = `
SELECT r.key AS role_key, r.is_system, rp.permission
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
 ORDER BY r.key, rp.permission`;

export interface LiveRoleGrantRow {
  readonly role_key: string;
  readonly is_system: boolean;
  readonly permission: string;
}

/**
 * A SENSITIVE key granted to a built-in role other than the owner, read from
 * the live catalogue.
 *
 * `sensitive` is passed in rather than imported so the caller states which
 * classification it is judging against — the same reason
 * `frameworkSelfProblems` takes its table.
 */
export function liveRoleGrantProblems(
  rows: readonly LiveRoleGrantRow[],
  sensitive: readonly string[],
  builtinRoles: readonly string[] = ['manager', 'cashier'],
): string[] {
  const problems: string[] = [];
  if (rows.length === 0)
    problems.push(
      'the live role_permissions join returned NO row — an empty result set is never a refusal, and a database with no grant at all is not a database this check can speak about',
    );
  if (sensitive.length === 0)
    problems.push('no sensitive key was supplied, so this check would pass over every grant there is — a classification with nothing in it is a vacuous pass');
  for (const row of rows)
    if (builtinRoles.includes(row.role_key) && sensitive.includes(row.permission))
      problems.push(
        `the built-in role '${row.role_key}' holds the SENSITIVE permission '${row.permission}' in the LIVE catalogue (role_permissions, is_system=${row.is_system.toString()}) — ` +
          'OD-P4-01 OPTION A forbids a sensitive key as a built-in default, and what the catalogue holds is what the request is authorised by',
      );
  return problems;
}

// ───────────────────────── SOURCES ────────────────────────────────────────

export interface SourceRow {
  readonly kind: 'accounting-source-type' | 'stock-source-type' | 'operation-kind';
  readonly name: string;
  readonly migration: string;
  /** For an accounting source type: does a binding relation reference it? */
  readonly hasBinding: boolean;
  /** Does a DEFERRABLE completeness validator exist for it? */
  readonly hasCompletenessValidator: boolean;
  /** Is there a routine that actually writes it? A dead registry concept is a finding. */
  readonly hasWriter: boolean;
}

export function discoverSources(root: string): SourceRow[] {
  const facts = readTree(root);
  const out: SourceRow[] = [];
  const allText = facts.migrations.map((m) => m.text).join('\n');

  const push = (kind: SourceRow['kind'], name: string, migration: string): void => {
    const bindingPattern = new RegExp(`'${name}'`, 'g');
    const occurrences = (allText.match(bindingPattern) ?? []).length;
    out.push({
      kind,
      name,
      migration,
      hasBinding: new RegExp(`source_bindings[\\s\\S]{0,4000}?'${name}'|'${name}'[\\s\\S]{0,4000}?source_bindings`).test(allText),
      hasCompletenessValidator: new RegExp(`CREATE\\s+CONSTRAINT\\s+TRIGGER\\s+[a-z_]*${name.replace(/[^a-z_]/g, '_')}[a-z_]*`, 'i').test(allText),
      // A source type whose name appears exactly ONCE — in its own
      // registration INSERT — has no writer, which is the "dead registry
      // concept" TL-P4-S1-R1 refused.
      hasWriter: occurrences > 1,
    });
  };

  for (const [name, migration] of facts.accountingSourceTypes) push('accounting-source-type', name, migration);
  for (const [name, migration] of facts.stockSourceTypes) push('stock-source-type', name, migration);
  for (const [name, migration] of facts.operationKinds) push('operation-kind', name, migration);
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
}

export function sourceFindings(rows: readonly SourceRow[]): string[] {
  const findings: string[] = [];
  if (rows.length === 0) findings.push('the source inventory is EMPTY — no registry row was discovered, which is a defect of the discovery rule');
  for (const row of rows) {
    if (!row.hasWriter)
      findings.push(
        `${row.kind} '${row.name}' (${row.migration}) is registered and its name appears nowhere else — a registry row with no writer is live AUTHORITY with no command (TL-P4-S1-R1, TL-P4-S2-K1)`,
      );
    if (row.kind === 'accounting-source-type' && !row.hasBinding)
      findings.push(`accounting source type '${row.name}' has no source binding — an accounting source must bind its entry (P4-AL-16)`);
  }
  // The probe rows `0074` plants and drops inside its own DO block are a
  // deliberate exception: they exist in the text to PROVE the widened CHECK
  // accepts a Phase 4 registrant, and they are rolled back. They are named so
  // the finding above is not reported for them.
  return findings.filter((f) => !f.includes("'probe_0074'") && !f.includes("'sale.probe'"));
}
