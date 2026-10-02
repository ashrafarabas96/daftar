/**
 * P4-S3 — **ONE TILL SESSION = ONE AUTHENTICATED USER**, AND THE PROOF THAT
 * EVERY HALF OF THAT LAW CAN GO RED (`OD-P4-09` OPTION A, ruled 2026-09-30;
 * lock `P4-AL-40`, `P4-AL-86`, `P4-AL-30`; `TL-P4-S2-R5` for the error
 * contract).
 *
 * This is a PERMANENT guard suite. It lives in `tests/guards`, which the
 * sealed `gate:phase4:s1` executes by DIRECTORY (`S1_SUITES` row `GD-01`), so
 * it is run by every composed Phase 4 gate without a gate edit — and
 * `guardSuiteProblems` refuses a file in that directory the root runner would
 * not pick up, which is why it is a `.test.ts`.
 *
 * ── The two things it holds, and why they are one suite ──────────────────
 *
 * **§A — the rule is in the SCHEMA, not in the service.** The live claim is
 * `posSessionLawProblems` (`scripts/guards/pos-session-law.ts`); this suite
 * only proves it can speak. The reason the rule may not live in the service
 * is the TRUSTED GENERIC PRIMITIVE: `Database.withTransaction` and
 * `Database.scoped` open one scoped transaction on the `daftar_app` pool and
 * run whatever SQL a caller hands them, so a rule expressed as an `if` in the
 * till-session service is not inherited by the next writer in the process. The
 * law therefore asks the DDL for a NOT NULL owner, an immutability rule on it,
 * the referential edge that binds a basket line to the session's own user, and
 * the absence of any unearned per-row actor column; and
 * `tests/security/pos-s3-session-authority.test.ts` performs the bypass on a
 * real connection and requires the DATABASE to refuse it.
 *
 * **§B — every refusal renders through the canonical path.** A rule in the
 * schema that surfaces as an anonymous `P0001` is a rule whose refusal the
 * client cannot act on. So: every `pos.*` code is registered in the ONE Phase 4
 * registry, each keeps its registered status through the production
 * `GlobalExceptionFilter`, a recognized internal `selling.*` invariant is 500
 * with no details, an unknown `P0001` keeps its historical fallback — and the
 * PUBLIC recognizer still does not carry the internal vocabulary, which is the
 * non-widening claim `TL-P4-S2-R5` was written about and the one thing adding
 * a prefix to that regex could have broken.
 *
 * ── Reachability is the claim that needed the most care ──────────────────
 *
 * The fifteen `pos.*` codes the till migration RAISEs are not one kind of
 * thing. Most are runtime refusals a request can meet and must be classified
 * by the canonical registry. Three — `pos.authority_leak`,
 * `pos.derived_truth_stored`, `pos.migration_end_state_invalid` — are
 * end-state assertions that fire only while the migration applies, and
 * demanding registry rows for those would demand merchant text for a build-time
 * assertion. A hand-written list of the three would be the exact trap this
 * slice has already fallen into once, so the law DERIVES the split and §A
 * red-proves it in three directions: an unregistered reachable code is
 * reported; a build-time code is NOT reported merely for being unregistered;
 * and a build-time code moved into a granted routine's body starts being
 * demanded with no edit to the law.
 *
 * ── NOT-YET-APPLICABLE IS NOT A PASS ─────────────────────────────────────
 *
 * The migration that creates the POS relations is the migration owner's. While
 * the tree does not carry it, §A's rules have no subject in the CHECKOUT — and
 * a green check with no subject proves nothing
 * (`[[daftar-a-green-gate-must-prove-it-can-be-red]]`). Two things answer that
 * here, and neither is a claim about the future:
 *
 *   - the subject is REPORTED by name, so a reader of the log knows which
 *     rules were live against the checkout rather than inferring it from
 *     silence;
 *   - every rule is exercised against a PLANTED tree in which the subject
 *     exists — the compliant DDL for the silence case, one specific defect for
 *     each red case — so each rule is proved to be a rule about the DEFECT and
 *     not about a string, today, with no migration in the tree.
 *
 * The planting is done in a COPY of the migrations directory, never the real
 * one: editing an applied migration breaks every suite with "Migration
 * tampered after apply". The planted file's number is DERIVED from the head on
 * disk, so this suite writes down no migration number and claims none.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArgumentsHost } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import type { Logger } from '../../apps/api/src/infra/logger';
import { POS_CODES } from '../../apps/api/src/modules/pos/pos-errors';
import { POS_ROUTE_AUTHORITY } from '../../apps/api/src/modules/pos/pos-permissions';
import { CART_LINE_COLUMNS, POS_CART_LINES, POS_RELATIONS, POS_TILL_SESSIONS, TILL_SESSION_COLUMNS } from '../../apps/api/src/modules/pos/pos-session-contract';
import {
  isSellingCode,
  isSellingInternalInvariant,
  parseDatabaseSellingCode,
  parseDatabaseSellingInternalCode,
  sellingRefusal,
  SELLING_INTERNAL_INVARIANT_CODES,
} from '../../apps/api/src/modules/selling/selling-errors';
import { phase4Sql } from '../../scripts/phase4-s1-gate';
import { posRefusalReachability, posSessionLawProblems, posSessionSubject } from '../../scripts/guards/pos-session-law';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** The law, bound to the ONE registry the error filter reads. */
const law = (root: string): string[] => posSessionLawProblems(root, isSellingCode);

/**
 * The number the next migration in `root` would take, READ from the head on
 * disk. Nothing here writes a migration number down, so this suite never
 * names a file that does not exist and never claims the next one.
 */
function nextNumber(dir: string): string {
  const head = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .slice(-1)[0];
  const n = Number((head ?? '0000').slice(0, 4)) + 1;
  return String(n).padStart(4, '0');
}

/**
 * A root whose migrations directory is the repository's plus `planted` as a
 * further Phase 4 migration. Everything else the law reads is shared with the
 * checkout, so only the DDL differs — the house pattern of
 * `tests/guards/phase4-deferred-seam-guard.test.ts`.
 */
function rootWith(planted: string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-pos-law-'));
  temporaries.push(root);
  const dir = join(root, 'infrastructure/database/migrations');
  mkdirSync(dir, { recursive: true });
  cpSync(MIGRATIONS, dir, { recursive: true });
  writeFileSync(join(dir, `${nextNumber(MIGRATIONS)}_planted_pos.sql`), planted);
  writeFileSync(
    join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'),
    readFileSync(join(REPO, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8'),
  );
  return root;
}

// ─────────────────────────────────────────────────────────────────────────
// The compliant plant. It is the DDL a conforming till-session migration
// writes, in the SHAPES THE MIGRATION ACTUALLY USES: the owner named
// `opened_by`, the actor candidate key it is unique under, the composite
// foreign key that binds a basket line to the session's own user, the two
// trigger-wired guard routines that nothing grants, the one granted command,
// the column-level UPDATE grants, and a migration-time end-state assertion in
// a `DO` block.
//
// It is a FIXTURE, not a migration and not a draft of one. A second copy of
// applied DDL in the tree would be a second truth; this text is applied to no
// database, is written only into a temporary directory, and exists so the
// NOT-A-FINDING case of every rule below has a subject.
// ─────────────────────────────────────────────────────────────────────────

const C = TILL_SESSION_COLUMNS;
const L = CART_LINE_COLUMNS;

const TILL_TABLE = `CREATE TABLE ${POS_TILL_SESSIONS} (
  ${C.tenant} UUID NOT NULL,
  ${C.business} UUID NOT NULL,
  ${C.id} UUID NOT NULL,
  ${C.branch} UUID NOT NULL,
  ${C.warehouse} UUID NOT NULL,
  ${C.terminalCode} TEXT NOT NULL,
  ${C.currency} CHAR(3) NOT NULL,
  ${C.status} TEXT NOT NULL,
  ${C.owner} UUID NOT NULL,
  ${C.openedAt} TIMESTAMPTZ NOT NULL DEFAULT now(),
  ${C.closedAt} TIMESTAMPTZ,
  ${C.openingFloatMinor} BIGINT NOT NULL,
  ${C.closingCountMinor} BIGINT,
  ${C.intentDigest} TEXT NOT NULL,
  ${C.closeIntentDigest} TEXT,
  ${C.businessTransactionId} UUID NOT NULL,
  PRIMARY KEY (${C.business}, ${C.id}),
  CONSTRAINT pos_till_sessions_actor_uq UNIQUE (${C.business}, ${C.id}, ${C.owner})
);`;

const CART_TABLE = `CREATE TABLE ${POS_CART_LINES} (
  ${L.tenant} UUID NOT NULL,
  ${L.business} UUID NOT NULL,
  ${L.session} UUID NOT NULL,
  ${L.id} UUID NOT NULL,
  line_no INTEGER NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  requested_discount_minor BIGINT NOT NULL DEFAULT 0,
  ${L.addedBy} UUID NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (${L.business}, ${L.id}),
  CONSTRAINT pos_cart_lines_session_actor_fk FOREIGN KEY (${L.business}, ${L.session}, ${L.addedBy}) REFERENCES ${POS_TILL_SESSIONS} (${C.business}, ${C.id}, ${C.owner}) ON DELETE RESTRICT ON UPDATE RESTRICT
);`;

/**
 * The session guard. Note what it is NOT: it holds no `GRANT EXECUTE` of its
 * own, and it is still reachable from a request, because a trigger fires it
 * inside the request's own transaction. That is the whole reason the law's
 * reachability test has a trigger arm as well as a grant arm.
 */
const TILL_GUARD = `CREATE FUNCTION pos_till_session_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.${C.owner} IS DISTINCT FROM OLD.${C.owner} THEN
    RAISE EXCEPTION 'pos.session_owner_immutable: a till session is never re-owned' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos.till_session_immutable: an opening fact of a till session is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_till_sessions_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON ${POS_TILL_SESSIONS}
  FOR EACH ROW EXECUTE FUNCTION pos_till_session_guard();`;

/** The basket guard, likewise trigger-wired and likewise granted to nobody. */
const CART_GUARD = `CREATE FUNCTION pos_cart_line_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'pos.cart_line_removed: a removed basket line is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_cart_lines_session_open
  BEFORE INSERT OR UPDATE OR DELETE ON ${POS_CART_LINES}
  FOR EACH ROW EXECUTE FUNCTION pos_cart_line_guard();`;

/** The one granted command, reachable by the grant arm. */
const OPEN_COMMAND = `CREATE FUNCTION pos_till_session_open(p_session_id UUID, p_terminal_code TEXT) RETURNS TABLE (till_session_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ${POS_TILL_SESSIONS} s WHERE s.${C.terminalCode} = p_terminal_code AND s.${C.status} = 'open') THEN
    RAISE EXCEPTION 'pos.terminal_already_open: this till already has an open session' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT p_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION pos_till_session_open(UUID, TEXT) TO daftar_app;`;

const GRANTS = `GRANT SELECT ON ${POS_TILL_SESSIONS}, ${POS_CART_LINES} TO daftar_app;
GRANT SELECT, INSERT ON ${POS_TILL_SESSIONS}, ${POS_CART_LINES} TO daftar_inventory_internal;
GRANT UPDATE (${C.status}, ${C.closedAt}, ${C.closingCountMinor}) ON ${POS_TILL_SESSIONS} TO daftar_inventory_internal;
GRANT UPDATE (quantity, removed_at) ON ${POS_CART_LINES} TO daftar_inventory_internal;`;

/**
 * The migration-time end-state assertion. It is raised in a `DO` block, so no
 * request can reach it and the registry must NOT classify it — the direction
 * that is easy to get backwards and is red-proved below in both senses.
 */
const END_STATE = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${POS_TILL_SESSIONS}') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: the till-session relation did not survive this migration';
  END IF;
END;
$$;`;

const COMPLIANT = [TILL_TABLE, CART_TABLE, TILL_GUARD, CART_GUARD, OPEN_COMMAND, GRANTS, END_STATE].join('\n\n');

/** The build-time code the fixture asserts with, read from the fixture rather than written twice. */
const BUILD_TIME_CODE = 'pos.migration_end_state_invalid';

/** The compliant plant with one substring rewritten — the plant, as a one-line edit of the correct form. */
function broken(from: string, to: string): string {
  expect(COMPLIANT.includes(from), `the compliant fixture does not contain "${from}" — this plant would be a no-op`).toBe(true);
  const planted = COMPLIANT.split(from).join(to);
  expect(planted, 'the plant changed nothing').not.toBe(COMPLIANT);
  return planted;
}

/** Every problem the law reports whose text names `lawId`. */
const named = (problems: readonly string[], lawId: string): string[] => problems.filter((p) => p.startsWith(`${lawId}:`));

/** The reachability split of a planted tree, read the way the law reads it. */
const reachabilityOf = (root: string) => posRefusalReachability(phase4Sql(root));

// ─────────────────────────────────────────────────────────────────────────
// §A — THE RULE IS IN THE SCHEMA
// ─────────────────────────────────────────────────────────────────────────

describe('§A — OD-P4-09 is a property of the data, and the law can say so', () => {
  it('the subject is reported by name, and the checkout is judged rather than assumed', () => {
    const subject = posSessionSubject(REPO);
    // No equality on emptiness and no claim about what the tree will carry:
    // the list is REPORTED, and the assertions below are about the law's
    // behaviour over a tree that has the subject. A declared `pos_` relation
    // the contract does not know about is a finding either way.
    const extra = subject.relations.filter((r) => !POS_RELATIONS.includes(r));
    expect(extra, `the Phase 4 tree declares pos_ relations the POS contract does not: ${extra.join(', ')}`).toEqual([]);
    expect(subject.unreadable, 'the DDL reader could not parse part of the Phase 4 tree').toEqual([]);
    // The checkout itself must be clean under the law as it stands.
    expect(law(REPO)).toEqual([]);
  });

  it('NOT-A-FINDING: the compliant till-session DDL satisfies every rule, so each red proof below is about a defect and not a string', () => {
    const root = rootWith(COMPLIANT);
    expect(law(root)).toEqual([]);
    // The canary: the plant really did give the law a subject. Without this,
    // every red proof below could be passing because the law read an empty
    // tree and the planted defect was never examined at all.
    const subject = posSessionSubject(root);
    expect(subject.applicable, 'the compliant plant did not make the law applicable — every proof below would be vacuous').toBe(true);
    expect([...subject.relations].sort()).toEqual([...POS_RELATIONS].sort());
  });

  it('RED POS-LAW-0: a third pos_ relation nobody applied the law to is named', () => {
    const problems = law(rootWith(`${COMPLIANT}\n\nCREATE TABLE pos_drawer_counts (tenant_id UUID NOT NULL, business_id UUID NOT NULL, id UUID NOT NULL);`));
    expect(named(problems, 'POS-LAW-0')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-0')[0]).toContain('pos_drawer_counts');
  });

  it('RED POS-LAW-1: a NULLABLE owning user is refused — a shared till is not made legal by omitting the owner', () => {
    const problems = law(rootWith(broken(`${C.owner} UUID NOT NULL,`, `${C.owner} UUID,`)));
    expect(named(problems, 'POS-LAW-1')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-1')[0]).toContain(`${POS_TILL_SESSIONS}.${C.owner} is nullable`);
  });

  it('RED POS-LAW-1: an owning user column that is absent altogether is refused', () => {
    const problems = law(rootWith(broken(`  ${C.owner} UUID NOT NULL,\n`, '')));
    expect(named(problems, 'POS-LAW-1')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-1')[0]).toContain(`declares no ${C.owner}`);
  });

  it('RED POS-LAW-5: a till with no branch is refused — P4-AL-40 binds a session to a branch', () => {
    const problems = law(rootWith(broken(`${C.branch} UUID NOT NULL,`, `${C.branch} UUID,`)));
    expect(named(problems, 'POS-LAW-5')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-5')[0]).toContain(C.branch);
  });

  it('RED POS-LAW-5: a till with no warehouse is refused — the minting side has nothing to branch-scope check', () => {
    const problems = law(rootWith(broken(`  ${C.warehouse} UUID NOT NULL,\n`, '')));
    expect(named(problems, 'POS-LAW-5')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-5')[0]).toContain(`declares no ${C.warehouse}`);
  });

  it('RED POS-LAW-2: the immutability routine removed — nothing then stops the generic primitive re-owning a till', () => {
    const problems = law(rootWith(broken(TILL_GUARD, '')));
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('trusted generic primitive');
  });

  it('RED POS-LAW-2: the routine present and fired on INSERT only — the UPDATE it exists to refuse is uncovered', () => {
    const problems = law(
      rootWith(
        broken(
          `BEFORE INSERT OR UPDATE OR DELETE ON ${POS_TILL_SESSIONS}\n  FOR EACH ROW EXECUTE FUNCTION pos_till_session_guard();`,
          `BEFORE INSERT ON ${POS_TILL_SESSIONS}\n  FOR EACH ROW EXECUTE FUNCTION pos_till_session_guard();`,
        ),
      ),
    );
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('is not fired for UPDATE');
  });

  it('RED POS-LAW-2: the routine exists and no trigger fires it — a routine nothing fires refuses nothing', () => {
    const problems = law(
      rootWith(
        broken(
          `CREATE TRIGGER pos_till_sessions_lifecycle\n  BEFORE INSERT OR UPDATE OR DELETE ON ${POS_TILL_SESSIONS}\n  FOR EACH ROW EXECUTE FUNCTION pos_till_session_guard();`,
          '',
        ),
      ),
    );
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain(`compares NEW.${C.owner} with OLD.${C.owner}`);
  });

  it('RED POS-LAW-2: the routine fires and raises but compares nothing, so it is not the immutability rule at all', () => {
    const problems = law(rootWith(broken(`TG_OP = 'UPDATE' AND NEW.${C.owner} IS DISTINCT FROM OLD.${C.owner}`, `TG_OP = 'UPDATE' AND false`)));
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('re-owning a till');
  });

  it('RED POS-LAW-4: an unearned per-row actor column on the basket is the refused OD-P4-09 OPTION B, and is named', () => {
    const problems = law(rootWith(broken(`  line_no INTEGER NOT NULL,\n`, `  line_no INTEGER NOT NULL,\n  sold_by UUID NOT NULL,\n`)));
    expect(named(problems, 'POS-LAW-4')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-4')[0]).toContain(`${POS_CART_LINES}.sold_by`);
    expect(named(problems, 'POS-LAW-4')[0]).toContain('OPTION B');
  });

  it('RED POS-LAW-4: the exemption is the (relation, column) PAIR, so the basket’s own actor name on the SESSION relation is still a finding', () => {
    // `added_by` is exempt on `pos_cart_lines` and nowhere else. A
    // column-name exemption would have let this through, which is exactly
    // the trap the actor vocabulary already fell into once.
    const problems = law(
      rootWith(
        broken(`  ${C.openedAt} TIMESTAMPTZ NOT NULL DEFAULT now(),\n`, `  ${L.addedBy} UUID NOT NULL,\n  ${C.openedAt} TIMESTAMPTZ NOT NULL DEFAULT now(),\n`),
      ),
    );
    expect(named(problems, 'POS-LAW-4')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-4')[0]).toContain(`${POS_TILL_SESSIONS}.${L.addedBy}`);
  });

  it('RED POS-LAW-3: the composite actor edge removed — the exemption rests on it, so the copy becomes a second truth', () => {
    const problems = law(
      rootWith(
        broken(
          `,\n  CONSTRAINT pos_cart_lines_session_actor_fk FOREIGN KEY (${L.business}, ${L.session}, ${L.addedBy}) REFERENCES ${POS_TILL_SESSIONS} (${C.business}, ${C.id}, ${C.owner}) ON DELETE RESTRICT ON UPDATE RESTRICT`,
          '',
        ),
      ),
    );
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('that edge is absent');
  });

  it('RED POS-LAW-3: the actor edge present but not ON UPDATE RESTRICT — the session’s user could be swapped out from under a live basket', () => {
    const problems = law(rootWith(broken('ON DELETE RESTRICT ON UPDATE RESTRICT', 'ON DELETE RESTRICT ON UPDATE CASCADE')));
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('ON UPDATE RESTRICT');
  });

  it('RED POS-LAW-3: the actor candidate key dropped — the edge is then not expressible at all', () => {
    const problems = law(rootWith(broken(`,\n  CONSTRAINT pos_till_sessions_actor_uq UNIQUE (${C.business}, ${C.id}, ${C.owner})`, '')));
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('candidate key');
  });

  it('RED POS-LAW-3: the actor copy inside the basket’s UPDATE column grant — it could then be revised away from its parent after the insert', () => {
    const problems = law(
      rootWith(broken(`GRANT UPDATE (quantity, removed_at) ON ${POS_CART_LINES}`, `GRANT UPDATE (quantity, removed_at, ${L.addedBy}) ON ${POS_CART_LINES}`)),
    );
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('UPDATE column grant');
  });

  it('RED POS-LAW-3: a tree with the session and no basket is not silently a pass — the actor edge would have had no subject', () => {
    const problems = law(rootWith(broken(CART_TABLE, '')));
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('no subject');
  });

  // ── POS-LAW-6, the three directions the reachability split has to survive.

  it('reachability is DERIVED, and the trigger arm is not a convenience: the two guards hold no GRANT EXECUTE and their codes are still reachable', () => {
    const reach = reachabilityOf(rootWith(COMPLIANT));
    // The fixture grants EXECUTE on exactly one routine, and the two guards
    // are not it — asserted, so this claim cannot quietly become a statement
    // about a grant somebody added.
    expect(COMPLIANT.includes('GRANT EXECUTE ON FUNCTION pos_till_session_guard')).toBe(false);
    expect(COMPLIANT.includes('GRANT EXECUTE ON FUNCTION pos_cart_line_guard')).toBe(false);
    // Narrowed to the POS routines on purpose: the reachable set is the whole
    // Phase 4 tree's, and the accepted Phase 3 and Phase 4 guards in it are
    // reachable for exactly the same trigger reason.
    expect(reach.reachableRoutines.filter((r) => r.startsWith('pos_')).sort()).toEqual([
      'pos_cart_line_guard',
      'pos_till_session_guard',
      'pos_till_session_open',
    ]);
    // A grants-only rule would have called all three of these build-time and
    // excused refusals a merchant can actually meet.
    expect(reach.reachable).toContain('pos.session_owner_immutable');
    expect(reach.reachable).toContain('pos.till_session_immutable');
    expect(reach.reachable).toContain('pos.cart_line_removed');
    expect(reach.reachable).toContain('pos.terminal_already_open');
  });

  it('SILENCE POS-LAW-6: a migration-time code is NOT reported merely for being absent from the registry', () => {
    const root = rootWith(COMPLIANT);
    const reach = reachabilityOf(root);
    // The three facts that make this claim a claim: the code IS raised, it is
    // classified build-time, and the registry does not carry it — and the law
    // is silent anyway.
    expect(reach.buildTime).toContain(BUILD_TIME_CODE);
    expect(reach.reachable).not.toContain(BUILD_TIME_CODE);
    expect(isSellingCode(BUILD_TIME_CODE)).toBe(false);
    expect(named(law(root), 'POS-LAW-6a')).toEqual([]);
    expect(named(law(root), 'POS-LAW-6b')).toEqual([]);
  });

  it('RED POS-LAW-6a: a pos.* refusal a reachable routine raises and the canonical registry does not classify is named', () => {
    const root = rootWith(broken("'pos.terminal_already_open:", "'pos.terminal_locked:"));
    const problems = law(root);
    expect(named(problems, 'POS-LAW-6a')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-6a')[0]).toContain('pos.terminal_locked');
    // The discovery really did see the code in the right place, so the finding
    // is a judgement and not a reading failure.
    expect(reachabilityOf(root).reachable).toContain('pos.terminal_locked');
    expect(isSellingCode('pos.terminal_locked')).toBe(false);
  });

  it('RED POS-LAW-6b: a build-time end-state code that the registry DOES classify is named — merchant text for an assertion no cashier can reach', () => {
    const registered = 'pos.session_state_invalid';
    // The plant is only meaningful while that code is registered and raised
    // nowhere reachable, so both are asserted rather than assumed.
    expect(isSellingCode(registered)).toBe(true);
    const root = rootWith(broken(`'${BUILD_TIME_CODE}:`, `'${registered}:`));
    const reach = reachabilityOf(root);
    expect(reach.buildTime).toContain(registered);
    expect(reach.reachable).not.toContain(registered);
    const problems = law(root);
    expect(named(problems, 'POS-LAW-6b')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-6b')[0]).toContain(registered);
  });

  it('RED POS-LAW-6, THE INVERSION: a build-time code moved into a granted routine’s body starts being demanded, with no edit to the law', () => {
    // Nothing is removed from the `DO` block: the code is raised in BOTH
    // places, which is the case that decides whether reachability wins.
    const root = rootWith(
      broken(
        '  RETURN QUERY SELECT p_session_id;',
        `  IF p_session_id IS NULL THEN\n    RAISE EXCEPTION '${BUILD_TIME_CODE}: an end-state assertion moved into a granted command' USING ERRCODE = 'P0001';\n  END IF;\n  RETURN QUERY SELECT p_session_id;`,
      ),
    );
    const reach = reachabilityOf(root);
    expect(reach.reachable, 'reachability must win over the DO-block occurrence').toContain(BUILD_TIME_CODE);
    expect(reach.buildTime).not.toContain(BUILD_TIME_CODE);
    const problems = law(root);
    expect(named(problems, 'POS-LAW-6a')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-6a')[0]).toContain(BUILD_TIME_CODE);
    expect(named(problems, 'POS-LAW-6b')).toEqual([]);
  });

  it('the discovery counts a RAISE and not every pos.-prefixed string — an operation code and an audit action are not refusals', () => {
    // The earlier form of this reader demanded registry rows for the
    // operation codes the commands consume and for the audit actions they
    // write, neither of which is a refusal anybody renders.
    const root = rootWith(
      broken(
        '  RETURN QUERY SELECT p_session_id;',
        `  PERFORM inventory_assertion_consume('pos.session_open', 'x');\n  INSERT INTO audit_log (action) VALUES ('pos.till_session_opened');\n  RETURN QUERY SELECT p_session_id;`,
      ),
    );
    const reach = reachabilityOf(root);
    expect(reach.reachable).not.toContain('pos.session_open');
    expect(reach.reachable).not.toContain('pos.till_session_opened');
    expect(named(law(root), 'POS-LAW-6a')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §B — EVERY REFUSAL RENDERS THROUGH THE CANONICAL PATH
// ─────────────────────────────────────────────────────────────────────────

interface Rendered {
  readonly status: number;
  readonly payload: { error: { code: string; message: string; requestId: string; details?: Record<string, unknown> } };
  readonly logged: readonly { readonly fields: Record<string, unknown>; readonly message: string }[];
}

/**
 * `exception` through the PRODUCTION `GlobalExceptionFilter` — the real class,
 * a real `ArgumentsHost`, its real logger port, and nothing of the mapping
 * under test replaced. The response double implements the three methods the
 * filter calls and nothing else, so a filter that started calling a fourth one
 * fails here rather than silently taking a different path. The harness is the
 * accepted one of `tests/integration/sale-s2-error-contract.test.ts:98-126`.
 */
function render(exception: unknown): Rendered {
  let status = 0;
  let payload: Rendered['payload'] | undefined;
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value as Rendered['payload'];
      return this;
    },
    setHeader(): void {},
  };
  const host = { switchToHttp: () => ({ getResponse: <T>(): T => res as unknown as T }) } as unknown as ArgumentsHost;
  const logger = {
    error: (fields: unknown, message?: unknown): void => {
      logged.push({ fields: (fields ?? {}) as Record<string, unknown>, message: String(message ?? '') });
    },
    warn: (): void => {},
    info: (): void => {},
    debug: (): void => {},
  } as unknown as Logger;
  new GlobalExceptionFilter(logger).catch(exception, host);
  expect(payload, 'the filter rendered a body').not.toBeUndefined();
  if (payload === undefined) throw new Error('unreachable');
  return { status, payload, logged };
}

/** A PostgreSQL error as `pg` delivers one: the SQLSTATE on `code`, the routine's text on `message`. */
function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code, severity: 'ERROR' }) as Error & { code: string };
}

describe('§B — the POS refusal vocabulary is registered once and renders through the canonical path', () => {
  it('every pos.* code is classified by the ONE registry, and the OD-P4-09 statuses are the ruled ones', () => {
    expect(POS_CODES.length, 'no pos.* code is registered — every claim below would be vacuous').toBeGreaterThan(0);
    for (const code of POS_CODES) expect(isSellingCode(code), code).toBe(true);
    // The distinction the ruling forces, asserted rather than described:
    // isolation answers 404 and must be indistinguishable from "never
    // opened"; OD-P4-09 answers 403 about a session the caller CAN see.
    expect(sellingRefusal('pos.session_not_found').httpStatus).toBe(404);
    expect(sellingRefusal('pos.session_not_owned').httpStatus).toBe(403);
    // Re-owning a till is a server-side defect, not a merchant outcome.
    expect(sellingRefusal('pos.session_owner_immutable').httpStatus).toBe(500);
  });

  it('the five refusals the migration raises with no twin in this vocabulary are registered, and each status is the kind of thing the refusal is', () => {
    // A merchant CAN meet each of these three, and each has an action: use
    // another till, re-read the basket, start a new line.
    expect(sellingRefusal('pos.terminal_already_open').httpStatus).toBe(409);
    expect(sellingRefusal('pos.cart_line_conflict').httpStatus).toBe(409);
    expect(sellingRefusal('pos.cart_line_removed').httpStatus).toBe(409);
    // These two are guard refusals NO route can reach: `daftar_app` holds
    // SELECT only on both relations, and the columns the guards protect are
    // absent from `daftar_inventory_internal`'s column-level UPDATE grants. So
    // reaching one is a server-side defect, which is the reading
    // `sale.immutable` and `invoice.immutable` already have. A 409 would tell
    // a cashier their shift is in a state they can fix.
    expect(sellingRefusal('pos.till_session_immutable').httpStatus).toBe(500);
    expect(sellingRefusal('pos.cart_line_immutable').httpStatus).toBe(500);
  });

  it('a pos.* refusal raised by a trigger keeps its registered status and carries its stable code', () => {
    for (const code of POS_CODES) {
      const expected = sellingRefusal(code);
      const rendered = render(pgError('P0001', `${code}: an internal sentence written for an engineer reading a log`));
      expect(rendered.status, code).toBe(expected.httpStatus);
      expect(rendered.payload.error.code, code).toBe(expected.code);
      expect(rendered.payload.error.details?.sellingCode, code).toBe(code);
      // The routine's own text never leaves the process.
      expect(JSON.stringify(rendered.payload)).not.toContain('engineer reading a log');
    }
  });

  it('the PUBLIC recognizer still does not carry the internal vocabulary — adding `pos` did not widen it to `selling.*`', () => {
    expect(SELLING_INTERNAL_INVARIANT_CODES.length, 'no internal invariant is registered — this claim would be vacuous').toBeGreaterThan(0);
    for (const code of SELLING_INTERNAL_INVARIANT_CODES) {
      const error = pgError('P0001', `${code}: the invariant's own assertion sentence`);
      // (1) the public recognizer does not see it at all;
      expect(parseDatabaseSellingCode(error), code).toBeNull();
      // (2) the internal recognizer does, and the registry recognizes it;
      expect(parseDatabaseSellingInternalCode(error), code).toBe(code);
      expect(isSellingInternalInvariant(code), code).toBe(true);
      // (3) so the filter answers 500 with NO details — not a 403, and not a
      //     merchant refusal. `TL-P4-S2-R5`: an internal invariant failure is
      //     not an authorization denial.
      const rendered = render(error);
      expect(rendered.status, code).toBe(500);
      expect(rendered.payload.error.code, code).toBe('INTERNAL_ERROR');
      expect(rendered.payload.error.details, code).toBeUndefined();
      // and the invariant's name reaches the LOG, where the engineer is.
      expect(
        rendered.logged.some((l) => l.fields.invariant === code),
        code,
      ).toBe(true);
    }
  });

  it('RED: the non-widening claim has force — a recognizer that DID carry the internal prefix would render an invariant as a merchant refusal', () => {
    // The plant is a recognizer widened exactly the way the public one was
    // widened for `pos`, applied to the internal vocabulary. It is not
    // installed anywhere: it demonstrates that the claim above distinguishes
    // the two regexes rather than restating that both exist.
    const widened = /^((?:customer|invoice|pos|sale|selling)\.[a-z_]+)\b/;
    const code = SELLING_INTERNAL_INVARIANT_CODES[0] as string;
    expect(widened.exec(`${code}: the assertion sentence`)?.[1]).toBe(code);
    expect(parseDatabaseSellingCode(pgError('P0001', `${code}: the assertion sentence`))).toBeNull();
    // And the consequence the production recognizer avoids: under the widened
    // form the code would be looked up in the merchant registry, miss, and
    // leave the invariant to a status nobody classified.
    expect(isSellingCode(code)).toBe(false);
  });

  it('a migration-time end-state code is NOT renderable merchant vocabulary — it falls to the historical fallback and carries no details', () => {
    // The other half of the reachability ruling, stated where the rendering
    // actually happens: these three are unregistered BY DESIGN, so if one
    // ever did escape a routine the client gets the generic answer rather
    // than an end-state sentence.
    for (const code of ['pos.migration_end_state_invalid', 'pos.authority_leak', 'pos.derived_truth_stored']) {
      expect(isSellingCode(code), code).toBe(false);
      const rendered = render(pgError('P0001', `${code}: an end-state assertion sentence`));
      expect(rendered.status, code).toBe(403);
      expect(rendered.payload.error.code, code).toBe('FORBIDDEN');
      expect(rendered.payload.error.details, code).toBeUndefined();
      expect(JSON.stringify(rendered.payload)).not.toContain('end-state assertion sentence');
    }
  });

  it('an unknown P0001 keeps its historical fallback, so this slice redesigned no accepted rendering', () => {
    const rendered = render(pgError('P0001', 'pos_something_unregistered: a raise this slice never registered'));
    expect(rendered.status).toBe(403);
    expect(rendered.payload.error.code).toBe('FORBIDDEN');
    expect(rendered.payload.error.details).toBeUndefined();
  });

  it('every POS route names a registered permission and none is a new `pos.*` key — the twelve-key set is closed (P4-AL-36)', () => {
    expect(POS_ROUTE_AUTHORITY.length).toBeGreaterThan(0);
    for (const route of POS_ROUTE_AUTHORITY) {
      expect(['sales.view', 'sales.create'], `${route.method} ${route.path}`).toContain(route.permission);
      expect(route.sensitive, `${route.method} ${route.path}`).toBe(false);
      expect(route.path, `${route.method} ${route.path}`).toMatch(/^\/v1\/pos\//);
    }
  });
});
