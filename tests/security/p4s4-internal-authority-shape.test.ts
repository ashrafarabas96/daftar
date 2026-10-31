/**
 * P4-S4 — THE SHAPE OF EVERY INTERNAL AUTHORITY, AND THEIR UNREACHABILITY
 * FROM RUNTIME (Tech Lead ruling TL-P4-RLS-INT-01 §11, §12, §17).
 *
 * ── WHY THIS FILE STOPPED NAMING TWO ROLES (A5) ─────────────────────────────
 *
 * The first draft of this file judged TWO roles BY NAME, the two the ruling's
 * own text names. The catalogue holds FOUR internal NOLOGIN authorities:
 * `infrastructure/database/bootstrap.sql:156-183` creates
 * `daftar_accounting_internal`, `daftar_inventory_internal`,
 * `daftar_catalog_internal` and `daftar_provisioning_internal`, each with the
 * SAME `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
 * NOBYPASSRLS` clause and `PASSWORD NULL` re-asserted on every run. MEASURED
 * on a from-zero build of the 87 migrations: all four carry the identical
 * accepted shape, all four have exactly `daftar_migrator` as their single
 * member WITH INHERIT FALSE / SET TRUE / no ADMIN, all four are members of
 * nothing, and no runtime login reaches any of the four by MEMBER, USAGE or
 * SET.
 *
 * A pinned pair of names inside a permanent law makes the unnamed subjects
 * DORMANT FOREVER: a §17 reopening condition arriving on the catalogue or
 * provisioning authority would have turned nothing red here. So the ROSTER is
 * now DERIVED from the catalogue by a stated rule and the EXPECTATION stays
 * hand-written, and the two are asserted EQUAL in both directions — a FIFTH
 * authority is NAMED by a failure instead of being silently judged or
 * silently skipped.
 *
 * WHAT WAS ALREADY TRUE, measured rather than taken from the brief: the two
 * newly covered roles were NOT entirely unjudged. `p3c-td18-definer-ownership`
 * holds a shape case for them (tests/security/p3c-td18-definer-ownership.test.ts:185-201)
 * and one `SET ROLE` refusal from `daftar_app`
 * (tests/security/p3c-td18-definer-ownership.test.ts:415-416). That case
 * collapses the seven attributes into ONE boolean named `bad`, so its failure
 * names no attribute, no §17 condition and no ruling; it never reads
 * `rolpassword`; and its refusal sweep is one principal of seven. What is new
 * here is a per-attribute, ruling-citing judgement of ALL FOUR, the full
 * runtime × authority `SET ROLE` sweep, and the derived roster.
 *
 * TWO CLAUSES THAT DO NOT EXTEND, RECORDED RATHER THAN ASSERTED AWAY (§11,
 * §13 below carry the full text): `daftar_provisioning_internal` is named by
 * NO policy at all, so it is not a cross-tenant READER and §13's "has a
 * policy admission" clause is FALSE of it; and the catalogue and provisioning
 * authorities own NO INVOKER routine, so the `<role>=X/<role>` INVOKER-ACL
 * clause has no subject for them. Both are stated as what the rows support.
 *
 * WHAT WAS RULED, AND WHY THIS FILE IS NOT A NARROWING OF IT.
 *
 * `daftar_inventory_internal` and `daftar_accounting_internal` read rows
 * ACROSS TENANTS under their own role identity. The policy surface says so in
 * as many words: `inventory_internal_read` and `accounting_validator` are
 * PERMISSIVE `FOR SELECT TO <the internal role> USING (true)`
 * (tests/security/p4s4-rls-barrier-behaviour.test.ts:112-118). TL-P4-RLS-INT-01
 * ruled that visibility INTENTIONAL: "intentional internal authority
 * visibility". This file does not propose narrowing it, writes no migration,
 * and touches none.
 *
 * What the ruling RESTS ON is that the authority has no credential and no
 * runtime can borrow it. That is the thing this file makes permanent. The
 * ruling's §17 names the conditions that REOPEN it, and three of them are
 * catalogue facts:
 *
 *   R1  an internal role that can LOGIN            — it would have a credential
 *   R2  an internal role that holds BYPASSRLS      — it would not be a policy
 *                                                    grant any more, it would
 *                                                    be a bypass
 *   R3  a runtime credential that can SET ROLE into one — the cross-tenant
 *       read would be reachable from an ordinary request
 *
 * Any of the three turns this suite RED with a message naming the condition
 * and the ruling id, because a sentinel whose failure does not say what has
 * been reopened is a sentinel nobody acts on.
 *
 * ── WHAT WAS ALREADY PROVEN, AND IS VERIFIED HERE RATHER THAN REBUILT ──────
 *
 * The estate already holds most of §11 for each role SEPARATELY:
 *
 *   tests/security/inventory-db-authority.test.ts:155-173  all six attributes
 *       plus `rolpassword IS NULL`, for daftar_inventory_internal, from
 *       pg_authid.
 *   tests/security/inventory-db-authority.test.ts:175-189  its memberships in
 *       BOTH directions (one member, the migrator, INHERIT FALSE / SET TRUE /
 *       no ADMIN; a member of nothing).
 *   tests/security/inventory-db-authority.test.ts:194-200  pg_has_role
 *       MEMBER/USAGE/SET false for seven runtime roles.
 *   tests/security/inventory-db-authority.test.ts:202-205  a live refusal of
 *       `SET ROLE` on a real daftar_app connection.
 *   tests/security/accounting-boundary.test.ts:223-250     all six attributes
 *       plus `rolpassword IS NOT NULL` false, for daftar_accounting_internal.
 *   tests/security/accounting-boundary.test.ts:256-263     its members (one
 *       direction only).
 *   tests/integration/migration-portability.test.ts:1634-1660  both roles'
 *       login/super/bypass/inherit and membership options on a from-zero
 *       managed build.
 *   tests/security/reconciler-authority-matrix.test.ts:258-259  the reconciler
 *       credential's live `SET ROLE` refusal, platform and accounting only.
 *
 * Three things were NOT proven anywhere, and are this file's reason to exist:
 *
 *   G1  THE SYMMETRY. Each role's shape is asserted in the file of its own
 *       subsystem, against a differently-shaped literal. Nothing asserts the
 *       two roles have the SAME shape, so a later slice can relax one and the
 *       other file stays green. Here one hand-written expectation judges both.
 *
 *   G2  THE SET-ROLE SWEEP FOR THE ACCOUNTING AUTHORITY. The pg_has_role
 *       sweep and the live `SET ROLE` refusal exist for the inventory role
 *       only; for the accounting role only the reconciler credential was ever
 *       pointed at it. Every runtime login is swept at both roles here, and
 *       every one of them is REALLY CONNECTED AS and really refused.
 *
 *   G3  THE ROSTER DERIVED FROM THE CATALOGUE. Every existing sweep iterates
 *       a hand-written list, so a role a later migration adds is silently
 *       skipped — the one case a sentinel is for. Here the EXPECTATION is
 *       hand-written (a list read out of the thing it judges moves with the
 *       attack) and the ROSTER is derived from pg_roles, so a role nobody
 *       told this file about is judged and, if it is not in the hand-written
 *       expectation, named.
 *
 * ── HOW IT IS PROVEN ───────────────────────────────────────────────────────
 *
 * The laws are PURE FUNCTIONS over catalogue RECORDS, so each one is shown
 * RED on a synthesized row before it is believed green on the live cluster —
 * the pattern tests/security/deployment-authority-model.test.ts:60-124
 * already uses for the deployer's memberships. A law that cannot be made to
 * fail proves nothing.
 *
 * The live arm runs on a scratch database BUILT FROM ZERO by applying the
 * migration files (tests/helpers/scratch-db.ts), never on the shared
 * `daftar`, and it is dropped at the end. Two live red proofs mutate that
 * throwaway database and put it back:
 *
 *   - `ALTER ROLE … LOGIN BYPASSRLS`, re-read, law red naming R1 and R2,
 *     reverted and re-read green;
 *   - `GRANT daftar_inventory_internal TO daftar_app WITH SET TRUE`, re-read,
 *     law red naming R3, and the live `SET ROLE` that was refused a moment
 *     ago now SUCCEEDS — then revoked and re-read green. This is the only
 *     form of proof that the refusal measured earlier was the GRANT model's
 *     doing and not an artefact of the harness.
 *
 * ── TWO DISTINCTIONS THIS FILE REFUSES TO BLUR ─────────────────────────────
 *
 * DEPLOYMENT AUTHORITY IS NOT RUNTIME AUTHORITY. `daftar_migrator` CAN
 * `SET ROLE` into both internal roles, and must be able to: PostgreSQL will
 * not let a non-superuser hand a SECURITY DEFINER routine to an owner it
 * cannot assume, so that one membership is what keeps DAFTAR migratable
 * without a superuser. It is a controlled installation authority whose
 * credential no service loads. Every message in this file says which of the
 * two it is talking about, so a failure cannot be read as the other.
 *
 * A POLICY ADMISSION IS NOT A DATA PATH. A role can be admitted by an RLS
 * policy and still be refused by the missing GRANT, and the other way round.
 * The two are asserted separately, with separate messages: §13 records which
 * relations each internal role is POLICY-admitted on, and which it holds the
 * TABLE PRIVILEGE on, and names any relation where the policy admits a role
 * the grant model does not — which is a dead admission, not a usable read.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, type ScratchDb, type ScratchRole } from '../helpers/scratch-db';

/**
 * THE HAND-WRITTEN ROSTER of internal authorities (§11's subject set).
 *
 * Written out BY HAND, which is the point: the live arm DERIVES the same set
 * from the catalogue and asserts the two are equal in BOTH directions. A
 * roster read out of the catalogue it judges would move with the attack, and
 * a roster that is only hand-written goes dormant the day a migration adds a
 * fifth authority. Both halves together are what names a new subject.
 */
const INTERNAL_ROLES = ['daftar_accounting_internal', 'daftar_catalog_internal', 'daftar_inventory_internal', 'daftar_provisioning_internal'] as const;
type InternalRole = (typeof INTERNAL_ROLES)[number];

/**
 * The two authorities TL-P4-RLS-INT-01's own text names. The DERIVED roster
 * must CONTAIN them: a derivation that stopped matching the ruling's own
 * subjects is judging something else, and a ruling whose subject is gone is
 * itself a finding.
 */
const RULING_NAMED_AUTHORITIES = ['daftar_accounting_internal', 'daftar_inventory_internal'] as const;

/**
 * THE STATED DERIVATION RULE: a non-superuser role whose name is the
 * project's internal-authority naming. The estate already derives this set
 * the same way (tests/security/search-path-shadowing.test.ts:684 matches
 * `daftar\_%\_internal`), and `bootstrap.sql:156-183` is where the names
 * come from.
 *
 * `rolcanlogin = false` is DELIBERATELY NOT part of the rule, although it is
 * the shape of every member. Filtering on it would make the derivation move
 * with the attack in the worst possible way: an authority that GAINED LOGIN —
 * the §17 R1 condition this file exists for — would drop OUT of the derived
 * roster and the LOGIN flag would turn nothing red. NOLOGIN is judged as a
 * LAW below (REQUIRED_SHAPE.rolcanlogin), never used as a filter. The
 * derivation at search-path-shadowing.test.ts:684 does filter on it, and
 * would lose an authority exactly when it mattered.
 */
const INTERNAL_AUTHORITY_NAME = /^daftar_[a-z0-9_]+_internal$/;

/** The ruling every failure message cites, so a red run is actionable without this file open. */
const RULING = 'TL-P4-RLS-INT-01';

/**
 * THE §17 REOPENING CONDITIONS THIS SUITE IS THE SENTINEL FOR, as the text
 * that must appear in the failure. A message is part of the law here: the
 * ruling stands on these three facts, so a regression has to say which one
 * it broke.
 */
const REOPEN = {
  login: `R1 an internal authority can LOGIN — it would hold a credential, which REOPENS ${RULING}`,
  bypass: `R2 an internal authority holds BYPASSRLS — its cross-tenant read would no longer be a policy grant but a bypass, which REOPENS ${RULING}`,
  assume: `R3 a RUNTIME credential can SET ROLE into an internal authority — the intentional cross-tenant read becomes reachable from an ordinary request, which REOPENS ${RULING}`,
} as const;

/**
 * §11 — THE SHAPE, WRITTEN OUT BY HAND, ONCE, FOR BOTH ROLES.
 *
 * Not imported from a module the migrations also feed, and not read off the
 * live rows: an expectation derived from its own subject moves with the
 * attack. `rolinherit` is false as well — the ruling's §11 asks for it to be
 * INSPECTED, and the accepted value on this estate is NOINHERIT, which is
 * what makes the migrator's membership something that has to be ASSUMED
 * deliberately rather than something it carries.
 */
const REQUIRED_SHAPE: Readonly<Record<string, boolean>> = {
  rolcanlogin: false,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
};

/** A pg_authid row as this file judges it. `null` means the role is absent. */
interface ShapeRow {
  readonly rolname: string;
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly rolinherit: boolean;
  /** `rolpassword IS NULL` — a NOLOGIN role with a password is a credential waiting for a LOGIN flag. */
  readonly noPassword: boolean;
}

/**
 * §11's judgement. Every departure is a SECURITY defect, and the two §17
 * conditions carry their own text so the failure names what it reopened.
 */
export function shapeProblems(rows: readonly ShapeRow[]): string[] {
  const problems: string[] = [];
  const byName = new Map(rows.map((r) => [r.rolname, r]));
  // The subjects are the hand-written roster UNION anything the caller found
  // that the derivation rule calls an internal authority. The union, not the
  // roster, is what keeps a FIFTH authority from being handed in and skipped:
  // it is judged on the six attributes here AND named by the roster law
  // below. Absence from the roster is a roster finding; absence from the
  // catalogue is a §11 finding; both are reported.
  const subjects = [...new Set([...INTERNAL_ROLES, ...rows.map((r) => r.rolname).filter((n) => INTERNAL_AUTHORITY_NAME.test(n))])].sort();
  for (const role of subjects) {
    const row = byName.get(role);
    if (row === undefined) {
      problems.push(
        `${role} is absent from pg_authid — ${RULING} §11 judged nothing about it, and a law with no subject is not a pass (if the authority was retired, the ruling it supports is retired with it)`,
      );
      continue;
    }
    for (const [attribute, required] of Object.entries(REQUIRED_SHAPE)) {
      const actual = row[attribute as keyof ShapeRow];
      if (actual === required) continue;
      const head = `${role}.${attribute} is ${String(actual)}, and ${RULING} §11 requires ${String(required)}`;
      if (attribute === 'rolcanlogin') problems.push(`${head} — ${REOPEN.login}`);
      else if (attribute === 'rolbypassrls') problems.push(`${head} — ${REOPEN.bypass}`);
      else problems.push(`${head} — this is a SECURITY regression in the internal authority's shape (${RULING} §11)`);
    }
    if (!row.noPassword)
      problems.push(
        `${role} has a stored password although it is NOLOGIN — ${RULING} §11: the authority must have no credential at all, because a password plus one later LOGIN flag is ${REOPEN.login}`,
      );
  }
  for (const row of rows)
    if (!INTERNAL_AUTHORITY_NAME.test(row.rolname))
      problems.push(
        `${row.rolname} was handed to the ${RULING} §11 shape law, which judges internal authorities (the stated derivation rule is ${INTERNAL_AUTHORITY_NAME.source}) — the caller read the wrong rows`,
      );
  return problems;
}

/**
 * THE ROSTER LAW (§11's subject set). The catalogue's own answer to "which
 * internal authorities exist" must be NON-EMPTY, must CONTAIN the roles the
 * ruling names, and must EQUAL the hand-written roster. Each of the four ways
 * it can be wrong carries its own message, because they are four different
 * defects:
 *
 *   - nothing derived            — the law has no subject, which is not a pass
 *   - a ruling-named role absent — the ruling's own subject is gone
 *   - a derived role unrostered  — a NEW authority nobody has judged
 *   - a rostered role undervied  — a RETIRED authority whose laws judge nothing
 */
export function authorityRosterProblems(derived: readonly string[]): string[] {
  const problems: string[] = [];
  if (derived.length === 0)
    problems.push(
      `the ${RULING} §11 internal-authority derivation (${INTERNAL_AUTHORITY_NAME.source}, non-superuser) matched NO role in the catalogue — a derivation with no subject is NOT a pass, it is a law that judges nothing`,
    );
  for (const named of RULING_NAMED_AUTHORITIES)
    if (!derived.includes(named))
      problems.push(
        `${named} is named by ${RULING} itself and the catalogue derivation did not find it — either the authority is gone (and the ruling resting on it is gone with it) or the derivation stopped matching it, and both are SECURITY findings`,
      );
  for (const found of derived)
    if (!(INTERNAL_ROLES as readonly string[]).includes(found))
      problems.push(
        `${found} is an internal NOLOGIN authority the catalogue holds and the hand-written ${RULING} §11 roster does not name — until it is rostered, nothing had decided what its shape or its runtime reachability must be. Add it to INTERNAL_ROLES, hand-write what it may hold, and re-run: this is how a FIFTH authority gets NAMED instead of silently judged or silently skipped`,
      );
  for (const expected of INTERNAL_ROLES)
    if (!derived.includes(expected))
      problems.push(
        `${expected} is on the hand-written ${RULING} §11 roster and the catalogue derivation did not find it — the authority was retired or renamed, so every §11/§12/§17 law about it is now judging nothing`,
      );
  return problems;
}

/**
 * §12 — WHO MAY ASSUME AN INTERNAL AUTHORITY, WRITTEN OUT BY HAND.
 *
 * Exactly one principal, and it is the DEPLOYER. It is named here as the
 * deployment authority, separately from every runtime principal, because the
 * two refusals read identically in a log and mean opposite things.
 */
const DEPLOYMENT_AUTHORITY = 'daftar_migrator';

/**
 * The runtime principals the ruling's §12 names AT MINIMUM. Hand-written;
 * the live arm ALSO derives the roster from pg_roles and feeds anything it
 * finds through the same law, so a role a later migration adds is judged.
 */
const NAMED_RUNTIME_PRINCIPALS = [
  'daftar_app',
  'daftar_worker',
  'daftar_platform',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;

/** One (principal, authority) reachability fact, as pg_has_role reports it. */
interface ReachRow {
  readonly principal: string;
  readonly authority: string;
  /** pg_has_role(principal, authority, 'MEMBER') */
  readonly member: boolean;
  /** pg_has_role(principal, authority, 'USAGE') — privileges carried WITHOUT a SET ROLE */
  readonly usage: boolean;
  /** pg_has_role(principal, authority, 'SET') — may SET ROLE into it */
  readonly set: boolean;
}

/**
 * §12's judgement. A principal is admitted ONLY when it is the deployment
 * authority; every other principal must be refused all three ways. The
 * deployer is required to KEEP its SET (a lost deployment authority is a
 * different defect, and saying so is how the two stay told apart).
 */
export function reachProblems(rows: readonly ReachRow[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!(INTERNAL_ROLES as readonly string[]).includes(row.authority)) {
      problems.push(
        `${row.authority} is not on the ${RULING} internal-authority roster (${INTERNAL_ROLES.join(', ')}) — the caller handed the §12 law the wrong subject`,
      );
      continue;
    }
    seen.add(`${row.principal}\u0000${row.authority}`);
    if (row.principal === DEPLOYMENT_AUTHORITY) {
      // DEPLOYMENT authority, not runtime authority. It MUST be able to
      // assume the role (PostgreSQL refuses to hand a SECURITY DEFINER
      // routine to an owner the non-superuser applier cannot assume), and it
      // must NOT carry the authority's privileges without asking.
      if (!row.set)
        problems.push(
          `${DEPLOYMENT_AUTHORITY} can no longer SET ROLE to ${row.authority} — this is the DEPLOYMENT authority, not a runtime one: without it a non-superuser migration cannot own the authority's routines. This is a DEPLOYABILITY defect, NOT the §17 R3 runtime-reachability condition`,
        );
      if (row.usage)
        problems.push(
          `${DEPLOYMENT_AUTHORITY} carries ${row.authority}'s privileges by INHERITANCE (pg_has_role USAGE) — ${RULING} §12 requires the DEPLOYMENT membership to be WITH INHERIT FALSE, so the authority has to be assumed deliberately and never arrives with an ordinary deployment statement`,
        );
      continue;
    }
    // A RUNTIME principal. All three must be false, and `set` is §17 R3.
    if (row.set) problems.push(`RUNTIME principal ${row.principal} may SET ROLE to ${row.authority} — ${REOPEN.assume}`);
    if (row.member)
      problems.push(
        `RUNTIME principal ${row.principal} is a member of ${row.authority} (pg_has_role MEMBER) — ${RULING} §12: a runtime credential must reach an internal authority no way at all, and membership is one SET option away from ${REOPEN.assume}`,
      );
    if (row.usage)
      problems.push(
        `RUNTIME principal ${row.principal} carries ${row.authority}'s privileges by INHERITANCE (pg_has_role USAGE) — ${RULING} §12: this is WORSE than R3, because the cross-tenant read needs no SET ROLE at all`,
      );
  }
  // The roster must really have been swept: a law handed no rows for a
  // principal it names reported nothing about it, which is not a pass.
  for (const principal of NAMED_RUNTIME_PRINCIPALS)
    for (const authority of INTERNAL_ROLES)
      if (!seen.has(`${principal}\u0000${authority}`))
        problems.push(
          `the §12 sweep was handed no (${principal}, ${authority}) fact — ${RULING} §12 names ${principal} AT MINIMUM, and a principal the sweep skipped is exactly the hole a sentinel is for`,
        );
  return problems;
}

/**
 * The roster law (G3). The catalogue's own answer to "who can log in" must be
 * contained in the hand-written expectation; a login role nobody wrote down
 * is named, because the sweeps above would otherwise skip it in silence.
 */
export function rosterProblems(loginRoles: readonly string[]): string[] {
  const expected = new Set<string>([...NAMED_RUNTIME_PRINCIPALS, DEPLOYMENT_AUTHORITY]);
  return loginRoles
    .filter((r) => !expected.has(r))
    .map(
      (r) =>
        `${r} can LOG IN and is in neither the hand-written ${RULING} §12 runtime roster nor the deployment authority — it was added after this law was written, so nothing had decided whether it may assume an internal authority. Add it to NAMED_RUNTIME_PRINCIPALS (runtime) and re-run, or state why it is a deployment principal`,
    );
}

let db: ScratchDb;

/**
 * THE DERIVED ROSTER: every non-superuser role the stated naming rule calls
 * an internal authority. Read from `pg_authid` (not `pg_roles`) so the same
 * read that finds the subject can also see whether it holds a password, and
 * NOT filtered on `rolcanlogin` — see INTERNAL_AUTHORITY_NAME for why a
 * filter there would lose the subject exactly when §17 R1 fires.
 */
async function liveInternalAuthorities(): Promise<string[]> {
  const { rows } = await db.pool.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_authid WHERE NOT rolsuper AND rolname ~ $1 ORDER BY 1`, [
    INTERNAL_AUTHORITY_NAME.source,
  ]);
  return rows.map((x) => x.r);
}

/**
 * Every pg_authid fact §11 asks for, for the authorities named in `names`,
 * from the live catalogue. The live arm hands it the DERIVED roster, so a
 * role the hand-written roster never heard of is still judged on the six
 * attributes rather than merely counted.
 */
async function liveShape(names: readonly string[] = INTERNAL_ROLES): Promise<ShapeRow[]> {
  const { rows } = await db.pool.query<ShapeRow>(
    `SELECT rolname::text AS "rolname", rolcanlogin AS "rolcanlogin", rolsuper AS "rolsuper", rolbypassrls AS "rolbypassrls",
            rolcreatedb AS "rolcreatedb", rolcreaterole AS "rolcreaterole", rolreplication AS "rolreplication",
            rolinherit AS "rolinherit", (rolpassword IS NULL) AS "noPassword"
       FROM pg_authid WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [[...names]],
  );
  return rows;
}

/**
 * pg_has_role for every (principal, authority) pair of `principals` ×
 * `authorities`. The live sweep hands it the DERIVED roster, so an authority
 * the hand-written roster never heard of is still swept — `reachProblems`
 * then names it as a subject §12 never decided about.
 */
async function liveReach(principals: readonly string[], authorities: readonly string[] = INTERNAL_ROLES): Promise<ReachRow[]> {
  const { rows } = await db.pool.query<ReachRow>(
    `SELECT p AS "principal", a AS "authority",
            pg_has_role(p, a, 'MEMBER') AS "member",
            pg_has_role(p, a, 'USAGE')  AS "usage",
            pg_has_role(p, a, 'SET')    AS "set"
       FROM unnest($1::text[]) p, unnest($2::text[]) a ORDER BY p, a`,
    [[...principals], [...authorities]],
  );
  return rows;
}

/** The catalogue's own roster: every non-superuser login role. */
async function liveLoginRoles(): Promise<string[]> {
  const { rows } = await db.pool.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_roles WHERE rolcanlogin AND NOT rolsuper ORDER BY 1`);
  return rows.map((x) => x.r);
}

/** The error message of `run`, or null when it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Open a real connection as `role` on the scratch database and run `fn`. */
async function asLogin<T>(role: ScratchRole, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  db = await createScratchDb('daftar_p4s4_internal_shape');
}, 600_000);

afterAll(async () => {
  if (db !== undefined) await db.drop();
});

/* ─────────────────────────── THE RED PROOFS ─────────────────────────────── */

/** The accepted shape, as a record, so a planted defect has something to depart from. */
const GOOD_SHAPE: readonly ShapeRow[] = INTERNAL_ROLES.map((rolname) => ({
  rolname,
  rolcanlogin: false,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  noPassword: true,
}));

const plantShape = (rolname: InternalRole, patch: Partial<ShapeRow>): ShapeRow[] => GOOD_SHAPE.map((r) => (r.rolname === rolname ? { ...r, ...patch } : r));

/** The accepted reachability, as records: the deployer assumes, nobody else reaches. */
const GOOD_REACH: readonly ReachRow[] = [
  ...NAMED_RUNTIME_PRINCIPALS.flatMap((principal) => INTERNAL_ROLES.map((authority) => ({ principal, authority, member: false, usage: false, set: false }))),
  ...INTERNAL_ROLES.map((authority) => ({ principal: DEPLOYMENT_AUTHORITY, authority, member: true, usage: false, set: true })),
];

const plantReach = (principal: string, authority: InternalRole, patch: Partial<ReachRow>): ReachRow[] =>
  GOOD_REACH.map((r) => (r.principal === principal && r.authority === authority ? { ...r, ...patch } : r));

describe('TL-P4-RLS-INT-01 §11 — the shape law is able to say no', () => {
  it('is silent on the accepted shape (so every red below is the plant, not the law)', () => {
    expect(shapeProblems(GOOD_SHAPE)).toEqual([]);
  });

  it.each(INTERNAL_ROLES)('%s with LOGIN is red, and the message names the §17 R1 reopening condition', (role) => {
    const problems = shapeProblems(plantShape(role, { rolcanlogin: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${role}.rolcanlogin is true`);
    expect(problems[0]).toContain('R1 an internal authority can LOGIN');
    expect(problems[0]).toContain(RULING);
  });

  it.each(INTERNAL_ROLES)('%s with BYPASSRLS is red, and the message names the §17 R2 reopening condition', (role) => {
    const problems = shapeProblems(plantShape(role, { rolbypassrls: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${role}.rolbypassrls is true`);
    expect(problems[0]).toContain('R2 an internal authority holds BYPASSRLS');
    expect(problems[0]).toContain(RULING);
  });

  it.each(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolinherit'] as const)('a planted %s is red on either role', (attribute) => {
    for (const role of INTERNAL_ROLES) {
      const problems = shapeProblems(plantShape(role, { [attribute]: true }));
      expect(problems, `${role}.${attribute}`).toHaveLength(1);
      expect(problems[0]).toContain(`${role}.${attribute} is true`);
      expect(problems[0]).toContain('SECURITY regression');
    }
  });

  it('a stored password on a NOLOGIN authority is red on its own', () => {
    const problems = shapeProblems(plantShape('daftar_accounting_internal', { noPassword: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has a stored password although it is NOLOGIN');
  });

  it('every attribute at once is red once per attribute — the law does not stop at the first', () => {
    const problems = shapeProblems(
      plantShape('daftar_inventory_internal', {
        rolcanlogin: true,
        rolsuper: true,
        rolbypassrls: true,
        rolcreatedb: true,
        rolcreaterole: true,
        rolreplication: true,
        rolinherit: true,
        noPassword: false,
      }),
    );
    expect(problems).toHaveLength(Object.keys(REQUIRED_SHAPE).length + 1);
  });

  it('a MISSING authority is red — a law with no subject is not a pass', () => {
    const problems = shapeProblems(GOOD_SHAPE.filter((r) => r.rolname !== 'daftar_inventory_internal'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('daftar_inventory_internal is absent from pg_authid');
  });

  it('no rows at all is red once per rostered authority, not green', () => {
    expect(shapeProblems([])).toHaveLength(INTERNAL_ROLES.length);
  });

  it('a FIFTH internal authority handed in is JUDGED on the six attributes, not skipped', () => {
    // The roster law below NAMES it; this law must also JUDGE it, or a new
    // authority would be reported as unrostered and still have its shape
    // unexamined. A synthesized record, with a defect planted in it.
    const fifth: ShapeRow = {
      rolname: 'daftar_receivables_internal',
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
      noPassword: true,
    };
    const problems = shapeProblems([...GOOD_SHAPE, fifth]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('daftar_receivables_internal.rolcanlogin is true');
    expect(problems[0]).toContain('R1 an internal authority can LOGIN');
  });

  it('a row that is not an internal authority is red — the law refuses a subject it does not judge', () => {
    const stranger: ShapeRow = {
      rolname: 'daftar_app',
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: true,
      noPassword: false,
    };
    const problems = shapeProblems([...GOOD_SHAPE, stranger]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('daftar_app was handed to the');
  });
});

describe('TL-P4-RLS-INT-01 §12 — the reachability law is able to say no', () => {
  it('is silent on the accepted reachability', () => {
    expect(reachProblems(GOOD_REACH)).toEqual([]);
  });

  it.each(NAMED_RUNTIME_PRINCIPALS)('%s able to SET ROLE into either authority is red, naming §17 R3', (principal) => {
    for (const authority of INTERNAL_ROLES) {
      const problems = reachProblems(plantReach(principal, authority, { set: true }));
      expect(problems, `${principal} -> ${authority}`).toHaveLength(1);
      expect(problems[0]).toContain(`RUNTIME principal ${principal} may SET ROLE to ${authority}`);
      expect(problems[0]).toContain('R3 a RUNTIME credential can SET ROLE');
      expect(problems[0]).toContain(RULING);
    }
  });

  it('a runtime MEMBERSHIP with no SET is still red, and says it is one option away from R3', () => {
    const problems = reachProblems(plantReach('daftar_app', 'daftar_inventory_internal', { member: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is a member of daftar_inventory_internal');
    expect(problems[0]).toContain('one SET option away');
  });

  it('a runtime INHERITING the authority is red and is called WORSE than R3 — no SET ROLE is needed at all', () => {
    const problems = reachProblems(plantReach('daftar_worker', 'daftar_accounting_internal', { member: true, usage: true, set: true }));
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('WORSE than R3');
  });

  it('a LOST deployment authority is red as a DEPLOYABILITY defect, explicitly NOT as the runtime condition', () => {
    const problems = reachProblems(plantReach(DEPLOYMENT_AUTHORITY, 'daftar_accounting_internal', { set: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DEPLOYMENT authority, not a runtime one');
    expect(problems[0]).toContain('NOT the §17 R3 runtime-reachability condition');
    // And it is told apart from R3 by its text, which is the whole point.
    expect(problems[0]).not.toContain('REOPENS');
  });

  it('a deployment membership that INHERITS is red — the authority must be assumed, never carried', () => {
    const problems = reachProblems(plantReach(DEPLOYMENT_AUTHORITY, 'daftar_inventory_internal', { usage: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('WITH INHERIT FALSE');
  });

  it('a sweep that SKIPPED a named principal is red — silence about a subject is not a pass', () => {
    const problems = reachProblems(GOOD_REACH.filter((r) => r.principal !== 'daftar_reconciler'));
    expect(problems).toHaveLength(INTERNAL_ROLES.length);
    expect(problems[0]).toContain('was handed no (daftar_reconciler,');
  });

  it('an empty sweep is red once per named (principal, authority) pair', () => {
    expect(reachProblems([])).toHaveLength(NAMED_RUNTIME_PRINCIPALS.length * INTERNAL_ROLES.length);
  });

  it('a fact about something that is not an internal authority is refused, not judged', () => {
    const problems = reachProblems([...GOOD_REACH, { principal: 'daftar_app', authority: 'daftar_platform', member: true, usage: true, set: true }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not on the TL-P4-RLS-INT-01 internal-authority roster');
  });
});

describe('TL-P4-RLS-INT-01 §11 — the internal-authority roster law is able to say no', () => {
  it('is silent when the derivation and the hand-written roster agree', () => {
    expect(authorityRosterProblems([...INTERNAL_ROLES])).toEqual([]);
  });

  it('a derivation that found NOTHING is red — a law with no subject is not a pass', () => {
    const problems = authorityRosterProblems([]);
    // Empty, so: the derivation itself, both ruling-named roles, and every
    // rostered role missing.
    expect(problems).toHaveLength(1 + RULING_NAMED_AUTHORITIES.length + INTERNAL_ROLES.length);
    expect(problems[0]).toContain('matched NO role in the catalogue');
    expect(problems[0]).toContain('a derivation with no subject is NOT a pass');
  });

  it('a FIFTH internal authority the roster does not name is NAMED, with what to do about it', () => {
    const problems = authorityRosterProblems([...INTERNAL_ROLES, 'daftar_receivables_internal']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('daftar_receivables_internal is an internal NOLOGIN authority the catalogue holds');
    expect(problems[0]).toContain('Add it to INTERNAL_ROLES');
  });

  it.each(INTERNAL_ROLES)('a RETIRED authority (%s gone from the catalogue) is red — its laws would judge nothing', (role) => {
    const problems = authorityRosterProblems(INTERNAL_ROLES.filter((r) => r !== role));
    const expected = (RULING_NAMED_AUTHORITIES as readonly string[]).includes(role) ? 2 : 1;
    expect(problems, role).toHaveLength(expected);
    expect(problems.join('\n')).toContain(`${role} is on the hand-written`);
    expect(problems.join('\n')).toContain('now judging nothing');
  });

  it.each(RULING_NAMED_AUTHORITIES)('a derivation that stopped matching %s, the RULING\u2019s own subject, is red for that reason too', (role) => {
    const problems = authorityRosterProblems(INTERNAL_ROLES.filter((r) => r !== role));
    expect(problems.join('\n')).toContain(`${role} is named by TL-P4-RLS-INT-01 itself`);
  });
});

describe('TL-P4-RLS-INT-01 §12 — the roster law is able to say no', () => {
  it('is silent on the accepted roster', () => {
    expect(rosterProblems([...NAMED_RUNTIME_PRINCIPALS, DEPLOYMENT_AUTHORITY])).toEqual([]);
  });

  it('a login role a later migration added, that nobody wrote down, is named', () => {
    const problems = rosterProblems([...NAMED_RUNTIME_PRINCIPALS, DEPLOYMENT_AUTHORITY, 'daftar_receivables']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('daftar_receivables can LOG IN');
    expect(problems[0]).toContain('nothing had decided whether it may assume an internal authority');
  });
});

/* ──────────────────── THE LIVE ARM, ON A FROM-ZERO DATABASE ─────────────── */

describe('TL-P4-RLS-INT-01 §11 — the live catalogue of a database built from the migrations', () => {
  it('the build really applied the migration files (a from-zero claim with no migrations behind it is vacuous)', () => {
    expect(db.applied.length).toBeGreaterThan(80);
    expect(
      db.applied.every((f) => /^\d{4}_.*\.sql$/.test(f)),
      db.applied.slice(0, 3).join(','),
    ).toBe(true);
  });

  it('the DERIVED roster is non-empty, contains the roles the ruling names, and EQUALS the hand-written roster', async () => {
    const derived = await liveInternalAuthorities();
    // NON-VACUITY FIRST: a derivation that matched nothing would make every
    // law below a law about an empty set.
    expect(derived.length, `the ${RULING} §11 derivation must have a subject`).toBeGreaterThan(0);
    for (const named of RULING_NAMED_AUTHORITIES) expect(derived, `${named} is named by ${RULING} itself and must be derived`).toContain(named);
    // AND EQUAL, in both directions, so a fifth authority is NAMED.
    expect(authorityRosterProblems(derived)).toEqual([]);
    expect(derived, 'the catalogue holds exactly the internal authorities this file hand-wrote').toEqual([...INTERNAL_ROLES]);
  });

  it('every authority on the DERIVED roster exists in pg_authid and the hand-written shape law is silent on all of them', async () => {
    const rows = await liveShape(await liveInternalAuthorities());
    expect(rows.map((r) => r.rolname)).toEqual([...INTERNAL_ROLES]);
    expect(shapeProblems(rows)).toEqual([]);
  });

  it('the six §11 attributes and the password are asserted literally, for every authority and identically', async () => {
    const rows = await liveShape(await liveInternalAuthorities());
    expect(rows.length, 'the literal assertion below must have run on every derived authority').toBe(INTERNAL_ROLES.length);
    for (const row of rows) {
      const { rolname, noPassword, ...attributes } = row;
      expect(attributes, `${rolname} must hold the accepted internal-authority shape (${RULING} §11)`).toEqual(REQUIRED_SHAPE);
      expect(noPassword, `${rolname} must hold no credential at all (${RULING} §11)`).toBe(true);
    }
  });

  it('§11 memberships, BOTH directions: one member — the deployment authority — and a member of nothing', async () => {
    for (const role of INTERNAL_ROLES) {
      const members = await db.pool.query<{ member: string; inherit_option: boolean; set_option: boolean; admin_option: boolean }>(
        `SELECT m.rolname::text AS member, a.inherit_option, a.set_option, a.admin_option
           FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
          WHERE g.rolname = $1 ORDER BY m.rolname`,
        [role],
      );
      expect(members.rows, `${role}'s only member must be the DEPLOYMENT authority, WITH INHERIT FALSE / SET TRUE / no ADMIN (${RULING} §11)`).toEqual([
        { member: DEPLOYMENT_AUTHORITY, inherit_option: false, set_option: true, admin_option: false },
      ]);
      const memberOf = await db.pool.query<{ g: string }>(
        `SELECT g.rolname::text AS g FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1`,
        [role],
      );
      expect(
        memberOf.rows,
        `${role} must be a member of nothing — an authority that inherits another role's grants is not the authority that was ruled on`,
      ).toEqual([]);
    }
  });

  it('§11 inheritance: NOINHERIT on the authority, and the deployer carries none of its privileges without asking', async () => {
    const rows = await liveReach([DEPLOYMENT_AUTHORITY]);
    expect(rows.map((r) => ({ a: r.authority, member: r.member, usage: r.usage, set: r.set }))).toEqual(
      INTERNAL_ROLES.map((a) => ({ a, member: true, usage: false, set: true })),
    );
    expect(reachProblems([...GOOD_REACH.filter((r) => r.principal !== DEPLOYMENT_AUTHORITY), ...rows])).toEqual([]);
  });

  it('§11 table privileges: recorded, every DELETE is paired with an INSERT, and TRUNCATE is held by neither', async () => {
    for (const role of INTERNAL_ROLES) {
      const { rows } = await db.pool.query<{ t: string; p: string }>(
        `SELECT table_name::text AS t, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS p
           FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY table_name ORDER BY table_name`,
        [role],
      );
      // RECORDED, not pinned: an exact inventory here would be a closure rule
      // wearing an invariant's clothes — the next slice's relation would
      // redden it with nothing about the ruling having changed. What IS a law
      // is that the authority holds a real, non-empty surface (so the §13
      // policy/privilege split below has a subject), plus the two claims
      // below, which were DERIVED from the built catalogue and not assumed.
      expect(rows.length, `${role} holds a table privilege somewhere — otherwise §13's policy/privilege split has nothing to tell apart`).toBeGreaterThan(0);

      // MEASURED, AND IT CONTRADICTED THE FIRST DRAFT OF THIS FILE. The
      // authorities DO hold DELETE: `daftar_accounting_internal` on
      // accounting_assertion_uses, accounting_opening_balances and
      // accounting_opening_balance_lines; `daftar_inventory_internal` on
      // branch_warehouses, inventory_assertion_uses, payment_method_names,
      // purchase_lines and the two purchase_landed_cost* relations. The two
      // authorities added to this roster by A5 hold DELETE as well, and the
      // SAME invariant holds of them — measured on the from-zero build:
      // `daftar_catalog_internal` holds DELETE,INSERT,SELECT on
      // `catalog_identifiers` and nothing else at all;
      // `daftar_provisioning_internal` holds INSERT,SELECT,UPDATE on
      // `provisioning_assertion_keys` and DELETE,INSERT,SELECT on
      // `provisioning_assertion_uses`. Every DELETE is paired with an INSERT
      // on all four, and no authority holds TRUNCATE anywhere. A law
      // forbidding DELETE would have been a narrowing of the accepted model
      // dressed as an invariant, which TL-P4-RLS-INT-01 forbids. The real
      // invariant the rows support is this: an authority never holds DELETE
      // on a relation it cannot also WRITE. A DELETE without an INSERT is a
      // destructive-only grant, and no posting or lifecycle authority has
      // one — it would be an authority that can only remove other people's
      // rows.
      const destructiveOnly = rows.filter((r) => r.p.includes('DELETE') && !r.p.includes('INSERT'));
      expect(
        destructiveOnly,
        `${role} holds DELETE without INSERT on these relations — a destructive-only grant is not an internal WRITE authority, and ${RULING} §11 records none (table privileges)`,
      ).toEqual([]);

      // TRUNCATE is held by NOBODY but the object owner. Measured: the only
      // grantee of TRUNCATE on the whole built database is `postgres`, which
      // holds it because PostgreSQL gives an owner every right on what it
      // created and there is no way to refuse them.
      const truncate = rows.filter((r) => r.p.includes('TRUNCATE'));
      expect(truncate, `${role} must hold TRUNCATE on no relation — ${RULING} §11 table privileges`).toEqual([]);
    }
  });

  it('§11 function execution authority: the authority owns SECURITY DEFINER routines, and PUBLIC may execute none of them', async () => {
    for (const role of INTERNAL_ROLES) {
      const { rows } = await db.pool.query<{ sig: string; acl: string | null }>(
        `SELECT p.oid::regprocedure::text AS sig, array_to_string(p.proacl, ',') AS acl
           FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE o.rolname = $1 AND p.pronamespace = 'public'::regnamespace AND p.prosecdef ORDER BY 1`,
        [role],
      );
      // The owner of a SECURITY DEFINER routine IS the authority its body
      // runs with, and that is the whole mechanism the ruling is about, so
      // the claim is about their shape, not their count.
      // MEASURED per authority on the from-zero build: accounting and
      // inventory own many, `daftar_catalog_internal` owns exactly ONE
      // (`catalog_identifiers_sync()`) and `daftar_provisioning_internal`
      // owns THREE (`provision_actor`, `provision_assertion_key_install`,
      // `provision_assertion_key_retire`). The claim is "at least one", not a
      // count: a count here would be a closure rule wearing an invariant's
      // clothes. What matters is that every rostered authority really IS a
      // DEFINER identity, so none of them is a role with no mechanism behind
      // it that the §12 sweep then guards for nothing.
      expect(
        rows.length,
        `${role} must own at least one SECURITY DEFINER routine — it is the DEFINER identity the ruled cross-tenant read runs under`,
      ).toBeGreaterThan(0);
      for (const r of rows)
        expect(r.acl ?? '', `PUBLIC must hold no EXECUTE on ${r.sig} (${RULING} §11 function execution authority)`).not.toMatch(/(^|,)=[^/]*X/);
    }
  });

  it('§11 the INVOKER routines either authority owns are executable by that authority ALONE', async () => {
    // MEASURED, AND AGAIN AGAINST THE FIRST DRAFT. Not every routine an
    // authority owns is SECURITY DEFINER: the accounting authority owns 17
    // INVOKER helpers (accounting_fingerprint, accounting_pow10, the lock-key
    // builders, two trigger guards) and the inventory authority owns 2. A law
    // requiring DEFINER on everything an authority owns was simply false, and
    // the measurement is the deliverable. An INVOKER body runs with the
    // CALLER's rights, so owning it grants the caller nothing — but EXECUTE
    // on it is still authority-shaped surface nobody reviewed for a runtime.
    // Measured ACL on every one of the 19: `<role>=X/<role>` — EXECUTE
    // revoked from PUBLIC and held by the owning authority and nobody else.
    // That is the law.
    //
    // A5: AND IT DOES NOT EXTEND TO ALL FOUR, which is recorded rather than
    // asserted away. Measured on the from-zero build, the INVOKER routines
    // each rostered authority owns are: accounting 17, inventory 2
    // (`product_variants_10_base_variant_authority()` and
    // `products_10_inventory_config_authority()`), catalog 0, provisioning 0.
    // So for the two roles A5 added the `<role>=X/<role>` clause has NO
    // SUBJECT — it is vacuously true of them, and this file says so instead
    // of claiming it proved something about them. What IS asserted for all
    // four is the counts-with-a-subject guard below: the clause must really
    // have judged something SOMEWHERE, or the whole case is a green that
    // proves nothing.
    const invokerCounts = new Map<string, number>();
    for (const role of INTERNAL_ROLES) {
      const { rows } = await db.pool.query<{ sig: string; acl: string | null }>(
        `SELECT p.oid::regprocedure::text AS sig, array_to_string(p.proacl, ',') AS acl
           FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE o.rolname = $1 AND p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef ORDER BY 1`,
        [role],
      );
      invokerCounts.set(role, rows.length);
      for (const r of rows) {
        // A null ACL is PostgreSQL's default, which is PUBLIC EXECUTE. An
        // authority-owned routine must have been revoked explicitly.
        expect(r.acl, `${r.sig} carries the DEFAULT function ACL, which is PUBLIC EXECUTE — ${RULING} §11 function execution authority`).not.toBeNull();
        expect(r.acl ?? '', `PUBLIC must hold no EXECUTE on ${r.sig}`).not.toMatch(/(^|,)=[^/]*X/);
        expect(r.acl, `${r.sig} must be executable by ${role} and nobody else (${RULING} §11)`).toBe(`${role}=X/${role}`);
        for (const principal of NAMED_RUNTIME_PRINCIPALS)
          expect(r.acl ?? '', `RUNTIME principal ${principal} must hold no EXECUTE on the authority-owned helper ${r.sig}`).not.toContain(`${principal}=`);
      }
    }
    // NON-VACUITY. The ACL clause above is a loop over rows; with no rows
    // anywhere it would be a green case that judged nothing, which is the
    // failure mode this estate refuses. At least one rostered authority must
    // really own an INVOKER routine for the clause to have been exercised,
    // and the per-authority counts are RECORDED so a role whose count drops
    // to zero is readable here rather than invisible.
    const judged = [...invokerCounts.entries()].filter(([, n]) => n > 0);
    expect(
      judged.length,
      `the ${RULING} §11 INVOKER-ACL clause judged no routine at all (counts: ${[...invokerCounts.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}) — a loop over an empty set is not a pass`,
    ).toBeGreaterThan(0);
  });
});

// The title of this block (and of the two below) is RECORDED BY NAME in
// scripts/phase4-s4-gate.ts ROSTER_RECORDED, which this file does not own, so
// it is left WORD FOR WORD although the roster is now four authorities rather
// than "either". The subject is every rostered authority; the sweeps below
// derive it.
describe('TL-P4-RLS-INT-01 §12 — no runtime credential can assume ANY internal authority, measured live', () => {
  it('the catalogue roster holds no login role the hand-written §12 roster does not name', async () => {
    expect(rosterProblems(await liveLoginRoles())).toEqual([]);
  });

  it('the catalogue-DERIVED roster is swept on BOTH axes, not just the hand-written ones', async () => {
    const derived = (await liveLoginRoles()).filter((r) => r !== DEPLOYMENT_AUTHORITY);
    const authorities = await liveInternalAuthorities();
    // Both derivations must really have found their named subjects, or the
    // sweep below is over a smaller set than the ruling names.
    for (const named of NAMED_RUNTIME_PRINCIPALS) expect(derived, `${named} must be a login role of the built database`).toContain(named);
    for (const named of RULING_NAMED_AUTHORITIES) expect(authorities, `${named} must be a derived internal authority`).toContain(named);
    expect(derived.length * authorities.length, 'the swept product must be non-empty on both axes').toBeGreaterThan(0);
    const rows = [...(await liveReach(derived, authorities)), ...(await liveReach([DEPLOYMENT_AUTHORITY], authorities))];
    expect(rows.length, 'every (principal, authority) pair of the derived product was really read').toBe((derived.length + 1) * authorities.length);
    expect(reachProblems(rows)).toEqual([]);
  });

  it.each(NAMED_RUNTIME_PRINCIPALS)('a real %s connection is refused SET ROLE into EVERY internal authority', async (role) => {
    await asLogin(role as ScratchRole, async (c) => {
      for (const authority of INTERNAL_ROLES) {
        const message = await refusal(() => c.query(`SET ROLE ${authority}`));
        expect(message, `RUNTIME principal ${role} must be refused SET ROLE ${authority} — admitting it is ${REOPEN.assume}`).toMatch(
          /permission denied to set role|must be (a )?member/i,
        );
        // And the session is still itself: a refused SET ROLE that silently
        // half-applied would be the same hole wearing an error message.
        const who = await c.query<{ u: string }>(`SELECT current_user::text AS u`);
        expect(who.rows[0]?.u).toBe(role);
      }
    });
  });

  it('the DEPLOYMENT credential, by contrast, CAN assume every one of them — deployment authority is not runtime authority', async () => {
    await asLogin('daftar_migrator', async (c) => {
      for (const authority of INTERNAL_ROLES) {
        await c.query('BEGIN');
        const message = await refusal(() => c.query(`SET LOCAL ROLE ${authority}`));
        expect(
          message,
          `the DEPLOYMENT authority ${DEPLOYMENT_AUTHORITY} must keep SET ROLE ${authority}: a non-superuser migration cannot own that authority's routines without it. This is NOT runtime reachability`,
        ).toBeNull();
        expect((await c.query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0]?.u).toBe(authority);
        await c.query('ROLLBACK');
      }
    });
  });

  it('and the deployment credential does NOT arrive already holding the authority — it has to ask', async () => {
    await asLogin('daftar_migrator', async (c) => {
      expect((await c.query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0]?.u).toBe(DEPLOYMENT_AUTHORITY);
      // And the deployment credential is not a superuser in disguise: it is a
      // CONTROLLED installation authority, which is the whole reason the one
      // membership above is acceptable.
      const su = await c.query<{ s: string }>(`SELECT current_setting('is_superuser') AS s`);
      expect(su.rows[0]?.s, `${DEPLOYMENT_AUTHORITY} is the DEPLOYMENT authority, not a superuser`).toBe('off');
      // NOINHERIT on the membership is what makes the rest true; assert the
      // effect, for both authorities.
      for (const authority of INTERNAL_ROLES) {
        const inherited = await c.query<{ u: boolean }>(`SELECT pg_has_role(current_user, $1, 'USAGE') AS u`, [authority]);
        expect(inherited.rows[0]?.u, `the deployment membership in ${authority} must be WITH INHERIT FALSE — the authority is assumed, never carried`).toBe(
          false,
        );
      }
    });
  });
});

/* ───────── THE LIVE RED PROOFS: the laws really bind THIS database ───────── */

describe('TL-P4-RLS-INT-01 §17 — the reopening conditions, planted live and put back', () => {
  it.each(INTERNAL_ROLES)('R1 + R2 on %s: ALTER ROLE … LOGIN BYPASSRLS turns §11 red naming both conditions, and reverting turns it green', async (role) => {
    // EVERY rostered authority gets its own live plant, because the whole
    // defect this file closed was a law that was alive for two roles and
    // dormant for the rest. The plant is a REAL ALTER on a real role of a
    // throwaway database, and it is both PROVEN TO HAVE TAKEN EFFECT (the
    // re-read row carries the flags) and PROVEN RESTORED.
    const derived = await liveInternalAuthorities();
    expect(derived, `${role} must be a real role of this database for the plant to be a real plant`).toContain(role);
    expect(shapeProblems(await liveShape(derived)), 'green before the plant').toEqual([]);
    await db.pool.query(`ALTER ROLE ${role} LOGIN BYPASSRLS`);
    try {
      // The plant really took: the catalogue now says so.
      const planted = (await liveShape([role]))[0];
      expect(planted?.rolcanlogin, 'the plant must have taken effect').toBe(true);
      expect(planted?.rolbypassrls, 'the plant must have taken effect').toBe(true);
      // And the role is STILL DERIVED although it can now log in — which is
      // the reason INTERNAL_AUTHORITY_NAME does not filter on rolcanlogin. A
      // derivation that filtered it out would have gone green on R1.
      expect(await liveInternalAuthorities(), 'an authority that gained LOGIN must not drop out of the derived roster').toContain(role);
      const problems = shapeProblems(await liveShape(await liveInternalAuthorities()));
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain(`${role}.rolcanlogin is true`);
      expect(problems.join('\n')).toContain('R1 an internal authority can LOGIN');
      expect(problems.join('\n')).toContain('R2 an internal authority holds BYPASSRLS');
      expect(problems.every((p) => p.includes(RULING))).toBe(true);
    } finally {
      await db.pool.query(`ALTER ROLE ${role} NOLOGIN NOBYPASSRLS`);
    }
    const restored = (await liveShape([role]))[0];
    expect(restored?.rolcanlogin, 'the plant must have been restored').toBe(false);
    expect(restored?.rolbypassrls, 'the plant must have been restored').toBe(false);
    expect(shapeProblems(await liveShape(await liveInternalAuthorities())), 'green again after the revert').toEqual([]);
  });

  it.each([
    ['daftar_app', 'daftar_accounting_internal'],
    ['daftar_app', 'daftar_inventory_internal'],
    ['daftar_platform', 'daftar_catalog_internal'],
    ['daftar_worker', 'daftar_provisioning_internal'],
  ] as const)('R3: GRANT %s the authority %s WITH SET TRUE turns §12 red, and the refused SET ROLE really succeeds', async (principal, authority) => {
    // One pair per rostered authority, each with a DIFFERENT runtime
    // principal, so the proof is not an accident of one credential. The
    // grant is real, the §12 law is shown red on it, the SET ROLE that was
    // refused a moment earlier really succeeds (without this the earlier
    // refusal could be an artefact of the harness and not the grant model),
    // and the grant is revoked and the refusal re-measured.
    const sweep = async (): Promise<string[]> => reachProblems([...(await liveReach(NAMED_RUNTIME_PRINCIPALS)), ...(await liveReach([DEPLOYMENT_AUTHORITY]))]);
    expect(await sweep(), 'green before the plant').toEqual([]);
    expect(await asLogin(principal as ScratchRole, (c) => refusal(() => c.query(`SET ROLE ${authority}`)))).toMatch(/permission denied to set role/i);
    await db.pool.query(`GRANT ${authority} TO ${principal} WITH INHERIT FALSE, SET TRUE`);
    try {
      const problems = await sweep();
      // MEMBER and SET both become true; INHERIT FALSE keeps USAGE false.
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain(`RUNTIME principal ${principal} may SET ROLE to ${authority}`);
      expect(problems.join('\n')).toContain('R3 a RUNTIME credential can SET ROLE');
      const opened = await asLogin(principal as ScratchRole, async (c) => {
        await c.query(`SET ROLE ${authority}`);
        return (await c.query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0]?.u;
      });
      expect(opened, 'the data path really opened — the law was measuring the GRANT model, not the harness').toBe(authority);
    } finally {
      await db.pool.query(`REVOKE ${authority} FROM ${principal}`);
    }
    expect(await sweep(), 'green again after the revoke').toEqual([]);
    expect(await asLogin(principal as ScratchRole, (c) => refusal(() => c.query(`SET ROLE ${authority}`)))).toMatch(/permission denied to set role/i);
  });

  it('a FIFTH internal authority created live is seen by the roster law, and NAMED', async () => {
    // A REAL subject: a role that really exists in the catalogue, matching the
    // stated derivation rule, with the accepted shape — so the shape law has
    // nothing to say about it and ONLY the roster law speaks. That is the
    // dormancy this file closed: a new authority is named, not skipped.
    const probe = 'daftar_a5probe_internal';
    expect(authorityRosterProblems(await liveInternalAuthorities()), 'green before the plant').toEqual([]);
    await db.pool.query(`CREATE ROLE ${probe} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    try {
      const derived = await liveInternalAuthorities();
      expect(derived, 'the plant must have taken effect').toContain(probe);
      const problems = authorityRosterProblems(derived);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${probe} is an internal NOLOGIN authority the catalogue holds`);
      expect(problems[0]).toContain('Add it to INTERNAL_ROLES');
      // And the §11 shape law is SILENT on it — it carries the accepted shape.
      // The two laws are separate on purpose: unrostered is a roster finding,
      // a bad attribute is a shape finding, and a role can be either.
      expect(shapeProblems(await liveShape(derived))).toEqual([]);
    } finally {
      await db.pool.query(`DROP ROLE ${probe}`);
    }
    const after = await liveInternalAuthorities();
    expect(after, 'the plant must have been restored').not.toContain(probe);
    expect(authorityRosterProblems(after), 'green again after the drop').toEqual([]);
  });

  it('a login role added later is seen by the roster law, live, and named', async () => {
    expect(rosterProblems(await liveLoginRoles()), 'green before the plant').toEqual([]);
    await db.pool.query(`CREATE ROLE daftar_p4s4_shape_probe LOGIN PASSWORD 'probe-only-dropped-below'`);
    try {
      const problems = rosterProblems(await liveLoginRoles());
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('daftar_p4s4_shape_probe can LOG IN');
    } finally {
      await db.pool.query(`DROP ROLE daftar_p4s4_shape_probe`);
    }
    expect(rosterProblems(await liveLoginRoles()), 'green again after the drop').toEqual([]);
  });
});

/* ───────── §13: A POLICY ADMISSION IS NOT A DATA PATH ─────────────────────── */

describe('TL-P4-RLS-INT-01 §13 — the policy admission and the GRANT, told apart', () => {
  /** Every relation each authority is PERMISSIVE-admitted on by name, from pg_policy. */
  async function policyAdmitted(role: InternalRole): Promise<string[]> {
    const { rows } = await db.pool.query<{ t: string }>(
      `SELECT DISTINCT c.relname::text AS t
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polpermissive AND p.polroles @> ARRAY[$1::regrole]::oid[] ORDER BY 1`,
      [role],
    );
    return rows.map((r) => r.t);
  }

  /** Every relation the authority holds SELECT on, from the ACL. */
  async function selectGranted(role: InternalRole): Promise<Set<string>> {
    const { rows } = await db.pool.query<{ t: string }>(
      `SELECT DISTINCT table_name::text AS t FROM information_schema.role_table_grants
        WHERE grantee = $1 AND privilege_type = 'SELECT'`,
      [role],
    );
    return new Set(rows.map((r) => r.t));
  }

  /** Every SECURITY DEFINER routine `role` owns — what makes a non-reader still an authority. */
  async function definerCount(role: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
        WHERE o.rolname = $1 AND p.pronamespace = 'public'::regnamespace AND p.prosecdef`,
      [role],
    );
    return Number(rows[0]?.n ?? '0');
  }

  it.each(RULING_NAMED_AUTHORITIES)('%s really is admitted BY NAME by a permissive policy — the ruled visibility has a subject', async (role) => {
    const admitted = await policyAdmitted(role);
    expect(
      admitted.length,
      `${role} is named by no permissive policy, so there is no "intentional internal authority visibility" left for ${RULING} to be about — the ruling's subject is gone, which is itself a finding`,
    ).toBeGreaterThan(0);
  });

  it('MEASURED: not every internal authority is a cross-tenant READER, and the law says what the rows support', async () => {
    // A5, AND THIS IS THE CLAUSE THAT DID NOT EXTEND. The case above was
    // written `it.each(INTERNAL_ROLES)` when the roster was two names. Run
    // over all four it is simply FALSE: measured on the from-zero build,
    // `daftar_provisioning_internal` is named by NO policy at all — not
    // permissive, not restrictive. It is a DEFINER-WRITE authority (three
    // SECURITY DEFINER routines, INSERT/SELECT/UPDATE on
    // `provisioning_assertion_keys`, DELETE/INSERT/SELECT on
    // `provisioning_assertion_uses`), not a cross-tenant reader, and
    // `daftar_catalog_internal` is admitted on exactly one relation
    // (`catalog_identifiers`).
    //
    // So "every internal authority is policy-admitted" would have been the
    // invariant that sounds strongest and is false. The invariant the rows
    // support, and the one asserted here, is: an internal authority is a
    // cross-tenant reader OR a definer-write authority, never a role with
    // neither — and the roles the RULING is about are readers, because that
    // is what the ruling is about.
    const admitted = new Map<string, string[]>();
    for (const role of INTERNAL_ROLES) admitted.set(role, await policyAdmitted(role));
    const readers = INTERNAL_ROLES.filter((r) => (admitted.get(r) ?? []).length > 0);
    const nonReaders = INTERNAL_ROLES.filter((r) => (admitted.get(r) ?? []).length === 0);
    // NON-VACUITY: the §13 policy/privilege split below must have a subject.
    expect(readers.length, `no internal authority is policy-admitted anywhere, so ${RULING} §13 has nothing to tell apart`).toBeGreaterThan(0);
    // The ruling's own subjects must be among the readers.
    for (const named of RULING_NAMED_AUTHORITIES)
      expect(readers, `${named} is what ${RULING} calls the intentional cross-tenant read — it must be policy-admitted`).toContain(named);
    // And a non-reader is still a real authority, not a dangling role.
    for (const role of nonReaders)
      expect(
        await definerCount(role),
        `${role} is named by no policy AND owns no SECURITY DEFINER routine — it is an internal authority with no mechanism behind it, which is a role nobody needs and a ${RULING} §11 finding`,
      ).toBeGreaterThan(0);
  });

  it.each(INTERNAL_ROLES)('%s: the POLICY admission and the TABLE PRIVILEGE are asserted separately, never conflated', async (role) => {
    const admitted = await policyAdmitted(role);
    const granted = await selectGranted(role);
    const deadAdmissions = admitted.filter((t) => !granted.has(t));
    const usable = admitted.filter((t) => granted.has(t));
    // THE DISTINCTION, STATED. A relation in `deadAdmissions` is a POLICY
    // refusal that never happens because the PRIVILEGE refuses first: the
    // authority would be admitted by the policy and is still refused by the
    // missing GRANT. Reporting one of those as a usable cross-tenant data
    // path would be a false positive, so they are counted and named, not
    // asserted away.
    // GUARDED BY THE MEASUREMENT ABOVE, not by wishful thinking: an authority
    // no policy admits (`daftar_provisioning_internal`) has no admission to
    // turn into a data path, and demanding one of it would be this file
    // narrowing the accepted model. For an authority that IS admitted, at
    // least one admission must be backed by the GRANT, or the ruled read is
    // not a data path at all.
    if (admitted.length > 0)
      expect(
        usable.length,
        `${role} holds SELECT on none of the ${admitted.length} relation(s) a permissive policy admits it on — then the ruled read is not a data path at all, and ${RULING}'s premise needs re-reading`,
      ).toBeGreaterThan(0);
    else expect(usable, `${role} is admitted by no policy, so it can have no usable admission either`).toEqual([]);
    // And a dead admission is never counted as a path.
    for (const t of deadAdmissions)
      expect(
        granted.has(t),
        `${t}: a POLICY admission for ${role} with no SELECT GRANT is a DEAD admission, not a usable read — it must not be reported as a data path`,
      ).toBe(false);
  });

  it('the privilege refusal and the policy refusal are different refusals, measured on the same relation', async () => {
    // `daftar_app` holds SELECT on `invoices` and is refused the other
    // tenant's rows BY THE POLICY (0 rows, no error). It holds no DELETE at
    // all and is refused BY THE PRIVILEGE (SQLSTATE 42501). Same relation,
    // two refusals, two different shapes — which is exactly why this file
    // never reads one as the other.
    const c = new Client({ connectionString: db.url('daftar_app') });
    await c.connect();
    try {
      const policyRefusal = await refusal(() => c.query(`SELECT count(*) FROM invoices`));
      expect(policyRefusal, 'a POLICY refusal hands back rows (none), it does not raise').toBeNull();
      const privilegeRefusal = await refusal(() => c.query(`DELETE FROM invoices WHERE false`));
      expect(privilegeRefusal, 'a PRIVILEGE refusal raises permission denied — a different refusal from the policy one above').toMatch(/permission denied/i);
    } finally {
      await c.end().catch(() => undefined);
    }
  });
});
