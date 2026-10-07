/**
 * P4-S4 — THE SHAPE OF THE TWO INTERNAL AUTHORITIES, AND THEIR UNREACHABILITY
 * FROM RUNTIME (Tech Lead ruling TL-P4-RLS-INT-01 §11, §12, §17).
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

/** The two authorities TL-P4-RLS-INT-01 is about. */
const INTERNAL_ROLES = ['daftar_accounting_internal', 'daftar_inventory_internal'] as const;
type InternalRole = (typeof INTERNAL_ROLES)[number];

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
  for (const role of INTERNAL_ROLES) {
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
    if (!(INTERNAL_ROLES as readonly string[]).includes(row.rolname))
      problems.push(
        `${row.rolname} was handed to the ${RULING} §11 shape law, which judges only ${INTERNAL_ROLES.join(' and ')} — the caller read the wrong rows`,
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
      problems.push(`${row.authority} is not one of the two ${RULING} internal authorities — the caller handed the §12 law the wrong subject`);
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

/** Every pg_authid fact §11 asks for, for the two authorities, from the live catalogue. */
async function liveShape(): Promise<ShapeRow[]> {
  const { rows } = await db.pool.query<ShapeRow>(
    `SELECT rolname::text AS "rolname", rolcanlogin AS "rolcanlogin", rolsuper AS "rolsuper", rolbypassrls AS "rolbypassrls",
            rolcreatedb AS "rolcreatedb", rolcreaterole AS "rolcreaterole", rolreplication AS "rolreplication",
            rolinherit AS "rolinherit", (rolpassword IS NULL) AS "noPassword"
       FROM pg_authid WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [[...INTERNAL_ROLES]],
  );
  return rows;
}

/** pg_has_role for every (principal, authority) pair of `principals`. */
async function liveReach(principals: readonly string[]): Promise<ReachRow[]> {
  const { rows } = await db.pool.query<ReachRow>(
    `SELECT p AS "principal", a AS "authority",
            pg_has_role(p, a, 'MEMBER') AS "member",
            pg_has_role(p, a, 'USAGE')  AS "usage",
            pg_has_role(p, a, 'SET')    AS "set"
       FROM unnest($1::text[]) p, unnest($2::text[]) a ORDER BY p, a`,
    [[...principals], [...INTERNAL_ROLES]],
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

  it('no rows at all is red twice, not green', () => {
    expect(shapeProblems([])).toHaveLength(2);
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
    expect(problems[0]).toContain('is not one of the two');
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

  it('both authorities exist and the hand-written shape law is silent on them', async () => {
    const rows = await liveShape();
    expect(rows.map((r) => r.rolname)).toEqual([...INTERNAL_ROLES]);
    expect(shapeProblems(rows)).toEqual([]);
  });

  it('the six §11 attributes and the password are asserted literally, for both roles and identically', async () => {
    const rows = await liveShape();
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

      // MEASURED, AND IT CONTRADICTED THE FIRST DRAFT OF THIS FILE. Both
      // authorities DO hold DELETE: `daftar_accounting_internal` on
      // accounting_assertion_uses, accounting_opening_balances and
      // accounting_opening_balance_lines; `daftar_inventory_internal` on
      // branch_warehouses, inventory_assertion_uses, payment_method_names,
      // purchase_lines and the two purchase_landed_cost* relations. A law
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
    for (const role of INTERNAL_ROLES) {
      const { rows } = await db.pool.query<{ sig: string; acl: string | null }>(
        `SELECT p.oid::regprocedure::text AS sig, array_to_string(p.proacl, ',') AS acl
           FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE o.rolname = $1 AND p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef ORDER BY 1`,
        [role],
      );
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
  });
});

describe('TL-P4-RLS-INT-01 §12 — no runtime credential can assume either authority, measured live', () => {
  it('the catalogue roster holds no login role the hand-written §12 roster does not name', async () => {
    expect(rosterProblems(await liveLoginRoles())).toEqual([]);
  });

  it('the catalogue-DERIVED roster is swept, not just the hand-written one', async () => {
    const derived = (await liveLoginRoles()).filter((r) => r !== DEPLOYMENT_AUTHORITY);
    // The derivation must really have found the named principals, or the
    // sweep below is over a smaller set than the ruling names.
    for (const named of NAMED_RUNTIME_PRINCIPALS) expect(derived, `${named} must be a login role of the built database`).toContain(named);
    expect(reachProblems([...(await liveReach(derived)), ...(await liveReach([DEPLOYMENT_AUTHORITY]))])).toEqual([]);
  });

  it.each(NAMED_RUNTIME_PRINCIPALS)('a real %s connection is refused SET ROLE into BOTH authorities', async (role) => {
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

  it('the DEPLOYMENT credential, by contrast, CAN assume both — deployment authority is not runtime authority', async () => {
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
  it('R1 + R2: ALTER ROLE … LOGIN BYPASSRLS turns §11 red naming both conditions, and reverting turns it green', async () => {
    const role = 'daftar_inventory_internal';
    expect(shapeProblems(await liveShape()), 'green before the plant').toEqual([]);
    await db.pool.query(`ALTER ROLE ${role} LOGIN BYPASSRLS`);
    try {
      const problems = shapeProblems(await liveShape());
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain('R1 an internal authority can LOGIN');
      expect(problems.join('\n')).toContain('R2 an internal authority holds BYPASSRLS');
      expect(problems.every((p) => p.includes(RULING))).toBe(true);
    } finally {
      await db.pool.query(`ALTER ROLE ${role} NOLOGIN NOBYPASSRLS`);
    }
    expect(shapeProblems(await liveShape()), 'green again after the revert').toEqual([]);
  });

  it('R3: GRANT the authority to daftar_app WITH SET TRUE turns §12 red, and the refused SET ROLE really succeeds', async () => {
    const authority = 'daftar_inventory_internal';
    const sweep = async (): Promise<string[]> => reachProblems([...(await liveReach(NAMED_RUNTIME_PRINCIPALS)), ...(await liveReach([DEPLOYMENT_AUTHORITY]))]);
    expect(await sweep(), 'green before the plant').toEqual([]);
    // Before: a real daftar_app connection is refused.
    expect(await asLogin('daftar_app', (c) => refusal(() => c.query(`SET ROLE ${authority}`)))).toMatch(/permission denied to set role/i);
    await db.pool.query(`GRANT ${authority} TO daftar_app WITH INHERIT FALSE, SET TRUE`);
    try {
      const problems = await sweep();
      // MEMBER and SET both become true; INHERIT FALSE keeps USAGE false.
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain(`RUNTIME principal daftar_app may SET ROLE to ${authority}`);
      expect(problems.join('\n')).toContain('R3 a RUNTIME credential can SET ROLE');
      // AND THE DATA PATH IS REALLY OPEN: the same statement the law was
      // measuring now succeeds. Without this, the earlier refusal could have
      // been an artefact of the harness rather than the grant model.
      const opened = await asLogin('daftar_app', async (c) => {
        await c.query(`SET ROLE ${authority}`);
        return (await c.query<{ u: string }>(`SELECT current_user::text AS u`)).rows[0]?.u;
      });
      expect(opened).toBe(authority);
    } finally {
      await db.pool.query(`REVOKE ${authority} FROM daftar_app`);
    }
    expect(await sweep(), 'green again after the revoke').toEqual([]);
    expect(await asLogin('daftar_app', (c) => refusal(() => c.query(`SET ROLE ${authority}`)))).toMatch(/permission denied to set role/i);
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

  it.each(INTERNAL_ROLES)('%s really is admitted BY NAME by a permissive policy — the ruled visibility has a subject', async (role) => {
    const admitted = await policyAdmitted(role);
    expect(
      admitted.length,
      `${role} is named by no permissive policy, so there is no "intentional internal authority visibility" left for ${RULING} to be about — the ruling's subject is gone, which is itself a finding`,
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
    expect(
      usable.length,
      `${role} holds SELECT on none of the ${admitted.length} relation(s) a permissive policy admits it on — then the ruled read is not a data path at all, and ${RULING}'s premise needs re-reading`,
    ).toBeGreaterThan(0);
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
