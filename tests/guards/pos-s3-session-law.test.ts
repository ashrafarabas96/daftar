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
 * an actor-bound write rule on the basket, and the absence of any per-row
 * actor column; and `tests/security/pos-s3-session-authority.test.ts` performs
 * the bypass on a real connection and requires the DATABASE to refuse it.
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
import { POS_RELATIONS, POS_TILL_SESSIONS, TILL_SESSION_COLUMNS } from '../../apps/api/src/modules/pos/pos-session-contract';
import {
  isSellingCode,
  isSellingInternalInvariant,
  parseDatabaseSellingCode,
  parseDatabaseSellingInternalCode,
  sellingRefusal,
  SELLING_INTERNAL_INVARIANT_CODES,
} from '../../apps/api/src/modules/selling/selling-errors';
import { posCodesRaised, posSessionLawProblems, posSessionSubject } from '../../scripts/guards/pos-session-law';

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
// The compliant plant. It is the DDL a conforming `pos_till_sessions` /
// `pos_cart_lines` migration writes, in the accepted shapes of the tree:
// `0077:791-811`'s trigger form, `0077:515`'s routine form, and the integer
// minor units the project allows money to be stored in.
//
// It is a FIXTURE, not a migration and not a draft of one. A second copy of
// applied DDL in the tree would be a second truth; this text is applied to no
// database, is written only into a temporary directory, and exists so the
// NOT-A-FINDING case of every rule below has a subject.
// ─────────────────────────────────────────────────────────────────────────

const C = TILL_SESSION_COLUMNS;

const TILL_TABLE = `CREATE TABLE ${POS_TILL_SESSIONS} (
  ${C.tenant} UUID NOT NULL,
  ${C.business} UUID NOT NULL,
  ${C.id} UUID NOT NULL,
  ${C.branch} UUID NOT NULL,
  ${C.owner} UUID NOT NULL,
  ${C.status} TEXT NOT NULL,
  ${C.openedAt} TIMESTAMPTZ NOT NULL DEFAULT now(),
  ${C.closedAt} TIMESTAMPTZ,
  ${C.openingFloatMinor} BIGINT NOT NULL,
  ${C.closingCountMinor} BIGINT,
  ${C.intentDigest} TEXT NOT NULL,
  PRIMARY KEY (${C.business}, ${C.id})
);`;

const CART_TABLE = `CREATE TABLE pos_cart_lines (
  tenant_id UUID NOT NULL,
  business_id UUID NOT NULL,
  id UUID NOT NULL,
  till_session_id UUID NOT NULL,
  PRIMARY KEY (business_id, id)
);`;

const OWNER_IMMUTABLE = `CREATE FUNCTION pos_till_session_owner_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.${C.owner} IS DISTINCT FROM OLD.${C.owner} THEN
    RAISE EXCEPTION 'pos.session_owner_immutable: a till session is never re-owned' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_till_session_owner_fixed
  BEFORE UPDATE ON ${POS_TILL_SESSIONS}
  FOR EACH ROW EXECUTE FUNCTION pos_till_session_owner_immutable();`;

const ACTOR_BOUND = `CREATE FUNCTION pos_cart_line_actor_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT s.${C.owner} INTO v_owner FROM ${POS_TILL_SESSIONS} s
   WHERE s.${C.business} = NEW.business_id AND s.${C.id} = NEW.till_session_id;
  IF v_owner IS NULL OR v_owner <> nullif(current_setting('app.actor_user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'pos.session_not_owned: a till session belongs to one authenticated user' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_cart_line_actor
  BEFORE INSERT OR UPDATE ON pos_cart_lines
  FOR EACH ROW EXECUTE FUNCTION pos_cart_line_actor_bound();`;

const COMPLIANT = [TILL_TABLE, CART_TABLE, OWNER_IMMUTABLE, ACTOR_BOUND].join('\n\n');

/** The compliant plant with one substring rewritten — the plant, as a one-line edit of the correct form. */
function broken(from: string, to: string): string {
  expect(COMPLIANT.includes(from), `the compliant fixture does not contain "${from}" — this plant would be a no-op`).toBe(true);
  const planted = COMPLIANT.split(from).join(to);
  expect(planted, 'the plant changed nothing').not.toBe(COMPLIANT);
  return planted;
}

/** Every problem the law reports whose text names `lawId`. */
const named = (problems: readonly string[], lawId: string): string[] => problems.filter((p) => p.startsWith(`${lawId}:`));

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
    const problems = law(rootWith(COMPLIANT));
    expect(problems).toEqual([]);
    // The canary: the plant really did give the law a subject. Without this,
    // every red proof below could be passing because the law read an empty
    // tree and the planted defect was never examined at all.
    const subject = posSessionSubject(rootWith(COMPLIANT));
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
    expect(named(problems, 'POS-LAW-1')[0]).toContain(C.owner);
  });

  it('RED POS-LAW-1: an owning user column that is absent altogether is refused', () => {
    const problems = law(rootWith(broken(`${C.owner} UUID NOT NULL,\n`, '')));
    expect(named(problems, 'POS-LAW-1').length).toBeGreaterThan(0);
    expect(named(problems, 'POS-LAW-1')[0]).toContain('declares no');
  });

  it('RED POS-LAW-2: the immutability rule removed — nothing then stops the generic primitive re-owning a till', () => {
    const problems = law(rootWith(broken(OWNER_IMMUTABLE, '')));
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('trusted generic primitive');
  });

  it('RED POS-LAW-2: the rule present but fired on INSERT only — the UPDATE it exists to refuse is uncovered', () => {
    const problems = law(rootWith(broken(`BEFORE UPDATE ON ${POS_TILL_SESSIONS}`, `BEFORE INSERT ON ${POS_TILL_SESSIONS}`)));
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('does not fire');
  });

  it('RED POS-LAW-2: the routine raises the code but compares nothing, so it is not the immutability rule', () => {
    const problems = law(rootWith(broken(`IF NEW.${C.owner} IS DISTINCT FROM OLD.${C.owner} THEN`, 'IF false THEN')));
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('never compares');
  });

  it('RED POS-LAW-2: the routine exists and no trigger fires it — a routine nothing fires refuses nothing', () => {
    const problems = law(
      rootWith(
        broken(
          `CREATE TRIGGER pos_till_session_owner_fixed\n  BEFORE UPDATE ON ${POS_TILL_SESSIONS}\n  FOR EACH ROW EXECUTE FUNCTION pos_till_session_owner_immutable();`,
          '',
        ),
      ),
    );
    expect(named(problems, 'POS-LAW-2')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-2')[0]).toContain('no trigger executes it');
  });

  it('RED POS-LAW-3: the actor-bound basket rule removed — a colleague may then write into another cashier’s till', () => {
    const problems = law(rootWith(broken(ACTOR_BOUND, '')));
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('pos.session_not_owned');
  });

  it('RED POS-LAW-3: a rule that reads only the row and never the actor cannot tell whose till it is', () => {
    const problems = law(rootWith(broken(`nullif(current_setting('app.actor_user_id', true), '')::uuid`, `NEW.business_id`)));
    expect(named(problems, 'POS-LAW-3')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-3')[0]).toContain('app.actor_user_id');
  });

  it('RED POS-LAW-4: a per-row actor column on the basket is the refused OD-P4-09 OPTION B, and is named', () => {
    const problems = law(rootWith(broken('till_session_id UUID NOT NULL,', 'till_session_id UUID NOT NULL,\n  sold_by_user_id UUID NOT NULL,')));
    expect(named(problems, 'POS-LAW-4')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-4')[0]).toContain('sold_by_user_id');
    expect(named(problems, 'POS-LAW-4')[0]).toContain('OPTION B');
  });

  it('RED POS-LAW-4: the exemption is the (relation, column) PAIR, so the session’s own owner name on a basket line is still a finding', () => {
    const problems = law(rootWith(broken('till_session_id UUID NOT NULL,', `till_session_id UUID NOT NULL,\n  ${C.owner} UUID NOT NULL,`)));
    expect(named(problems, 'POS-LAW-4')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-4')[0]).toContain('pos_cart_lines');
  });

  it('RED POS-LAW-5: a till with no branch is refused — P4-AL-40 binds a session to a branch', () => {
    const problems = law(rootWith(broken(`${C.branch} UUID NOT NULL,`, `${C.branch} UUID,`)));
    expect(named(problems, 'POS-LAW-5')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-5')[0]).toContain(C.branch);
  });

  it('RED POS-LAW-6: a pos.* refusal the canonical registry does not classify is named, and the registered ones are not', () => {
    const planted = rootWith(broken("'pos.session_not_owned:", "'pos.session_hijacked:"));
    const problems = law(planted);
    expect(named(problems, 'POS-LAW-6')).toHaveLength(1);
    expect(named(problems, 'POS-LAW-6')[0]).toContain('pos.session_hijacked');
    // The discovery really did see both codes, so the single finding is a
    // judgement and not a reading failure.
    expect(posCodesRaised(readFileSync(join(planted, 'infrastructure/database/migrations', `${nextNumber(MIGRATIONS)}_planted_pos.sql`), 'utf8'))).toEqual([
      'pos.session_hijacked',
      'pos.session_owner_immutable',
    ]);
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
