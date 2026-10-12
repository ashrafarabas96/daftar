/**
 * P13-PROOF-RLS — TENANT AND BUSINESS ISOLATION, AS A NON-SUPERUSER.
 *
 * WHY THIS FILE EXISTS. Phase 13's directive lists "RLS and permission tests"
 * among the phase's outstanding work, and the security part of the same
 * directive is explicit about how such a test may NOT be written: *do not rely
 * on a superuser to test RLS*, the proof must reach the real enforcement layer,
 * and every capability needs a POSITIVE control proving the permitted thing
 * works beside the NEGATIVE control proving the forbidden thing is refused.
 * Until this file, Phase 13 had **no RLS evidence of any kind** — 193 pure unit
 * tests cannot have a tenant, and a fold cannot be denied a row.
 *
 * WHAT IT IS NOT
 * --------------
 * - NOT a migration. The DDL is scratch and unnumbered, created inside a
 *   throwaway cluster destroyed on exit. **No frozen migration is read, copied
 *   or applied**, and no migration number or filename appears anywhere.
 * - NOT evidence about the REAL relations. It proves that the SHAPE Phase 13's
 *   patch request asks for isolates correctly. Whether the relations that
 *   eventually ship carry these policies is established by the catalogue at
 *   integration, by the Migration Owner, and not by this file.
 * - NOT a claim about the frozen history. The policy shape here MIRRORS the
 *   live pattern (the PERMISSIVE tenant policy plus the RESTRICTIVE business
 *   policy, `FORCE ROW LEVEL SECURITY`, and the `app_tenant()` /
 *   `app_business()` / `app_bypass()` helpers). Applying the real migration
 *   history is the deployment path's business and belongs to its own authority;
 *   doing it here as a superuser would produce exactly the evidence the
 *   directive says must not be equated with the real deployment principal's.
 * - NOT a performance measurement. No duration is asserted and nothing sleeps.
 *
 * HOW IT AVOIDS THE SUPERUSER TRAP
 * --------------------------------
 * Every isolation assertion runs on a connection authenticated as an
 * unprivileged role created for the purpose. The superuser connection is used
 * ONLY to build the fixture and to read the catalogue, never to assert that a
 * row was or was not visible. The role's own attributes are read back out of
 * `pg_roles` and the case FAILS if it is superuser or carries BYPASSRLS, so
 * "we tested as a non-superuser" is itself measured rather than asserted.
 *
 * Run it directly (it is `.mts` under `test/rls/`, deliberately outside the
 * package's vitest pattern so the unit suite stays cluster-free):
 *
 *     node packages/analytics/test/rls/tenant-isolation.pgtest.mts
 */
import { execFileSync } from 'node:child_process';
import { chownSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';

/* ------------------------------------------------------------------ *
 * The settled target
 * ------------------------------------------------------------------ */

const BINDIR_CANDIDATES: readonly string[] = [
  '/usr/lib/postgresql/16/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@16/bin',
];

const PG_DIR = process.env['P13_RLS_PG_DIR'] ?? '/tmp/daftar-pg-p13-rls';
const PG_PORT = Number(process.env['P13_RLS_PG_PORT'] ?? 55781);
const PG_LOCALE = process.env['P13_PG_LOCALE'] ?? 'en_US.utf8';
const PG_OWNER = process.env['P13_PG_OWNER'] ?? 'claude';
const SUPER = 'postgres';
const APP_ROLE = 'daftar_app_probe';
const APP_PASSWORD = 'probe';

const superUrl = `postgresql://${SUPER}@localhost:${PG_PORT}/postgres`;
const appUrl = `postgresql://${APP_ROLE}:${APP_PASSWORD}@localhost:${PG_PORT}/postgres`;

/**
 * F-03 — the locale is a PRECONDITION, so it is checked before `initdb` and
 * named in the failure.
 *
 * The settled deploy line is the PostgreSQL 16 family at `en_US.utf8`, so the
 * cluster is built with `--locale=en_US.utf8`. A reviewer on a minimal image
 * does not have that locale generated, and `initdb` then dies with
 * `initdb: error: invalid locale name "en_US.utf8"` — which names neither the
 * cause nor the fix. An independent challenge hit exactly that and recorded a
 * run with exit code 1. Two glibc spellings mean the same locale
 * (`en_US.utf8`, `en_US.UTF-8`), so the comparison normalises both sides
 * rather than asking for a string match.
 */
function normaliseLocale(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '');
}

function assertLocaleAvailable(): void {
  if (normaliseLocale(PG_LOCALE) === 'c' || normaliseLocale(PG_LOCALE) === 'cutf8') return;
  let available: readonly string[];
  try {
    available = execFileSync('locale', ['-a'], { encoding: 'utf8' }).split('\n');
  } catch (error) {
    // No `locale` binary is not a reason to claim the locale is missing. Say
    // what could not be checked and let `initdb` be the authority.
    process.stdout.write(`NOTE: could not list locales (${String(error)}); letting initdb decide\n`);
    return;
  }
  const wanted = normaliseLocale(PG_LOCALE);
  if (available.some((name) => normaliseLocale(name) === wanted)) return;
  const [language = 'en_US', charset = 'UTF-8'] = PG_LOCALE.split('.');
  // `localedef` wants the charmap's own spelling, which is `UTF-8`: passing the
  // `utf8` that PostgreSQL reports back would fail with `cannot open charmap`,
  // so a command printed from the locale name verbatim would be useless advice.
  const charmap = normaliseLocale(charset) === 'utf8' ? 'UTF-8' : charset.toUpperCase();
  throw new Error(
    `the locale ${PG_LOCALE} is not generated on this machine, and the settled deploy line is the ` +
      'PostgreSQL 16 family at en_US.utf8, so this proof will not silently measure another ' +
      'collation. Generate it and re-run:\n' +
      `    localedef -i ${language} -f ${charmap} ${language}.${charmap}\n` +
      'Or, to measure a line this is NOT evidence for, set P13_PG_LOCALE explicitly.',
  );
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function findBinDir(): string {
  const explicit = process.env['P13_PG_BINDIR'];
  for (const dir of explicit === undefined || explicit === '' ? BINDIR_CANDIDATES : [explicit]) {
    try {
      if (statSync(join(dir, 'initdb')).isFile()) return dir;
    } catch {
      /* try the next */
    }
  }
  throw new Error(
    'no PostgreSQL 16 bin directory found. The settled deploy line is the PostgreSQL 16 family ' +
      'with en_US.utf8; set P13_PG_BINDIR. This proof deliberately has NO fallback to another ' +
      'major line, because an RLS result on an unchosen version is not the evidence that was asked for.',
  );
}

class Cluster {
  private readonly binDir: string;

  constructor(binDir: string) {
    this.binDir = binDir;
  }

  private run(bin: string, args: readonly string[]): string {
    const command = [join(this.binDir, bin), ...args].join(' ');
    if (isRoot()) {
      return execFileSync('su', [PG_OWNER, '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return execFileSync(join(this.binDir, bin), [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  version(): string {
    return execFileSync(join(this.binDir, 'postgres'), ['--version'], { encoding: 'utf8' }).trim();
  }

  start(): void {
    mkdirSync(join(PG_DIR, 'sock'), { recursive: true });
    if (isRoot()) {
      const uid = Number(execFileSync('id', ['-u', PG_OWNER], { encoding: 'utf8' }).trim());
      const gid = Number(execFileSync('id', ['-g', PG_OWNER], { encoding: 'utf8' }).trim());
      chownSync(PG_DIR, uid, gid);
      chownSync(join(PG_DIR, 'sock'), uid, gid);
    }
    assertLocaleAvailable();
    this.run('initdb', ['-D', join(PG_DIR, 'data'), `--locale=${PG_LOCALE}`, '--encoding=UTF8', '-U', SUPER, '--auth=trust']);
    this.run('pg_ctl', [
      '-D',
      join(PG_DIR, 'data'),
      '-o',
      `'-p ${PG_PORT} -c listen_addresses=localhost -c unix_socket_directories=${join(PG_DIR, 'sock')}'`,
      '-l',
      join(PG_DIR, 'server.log'),
      'start',
      '-w',
    ]);
  }

  stop(): void {
    try {
      this.run('pg_ctl', ['-D', join(PG_DIR, 'data'), 'stop', '-m', 'immediate']);
    } catch {
      /* already down */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string | null; readonly message: string };

async function settle<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null;
    return { ok: false, code, message: e instanceof Error ? e.message : String(e) };
  }
}

function observed(o: Outcome<unknown>): string {
  return o.ok ? 'accepted' : `SQLSTATE ${o.code ?? '(none)'}`;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

async function one<R extends Record<string, unknown>>(c: Client | Pool, sql: string, params: unknown[] = []): Promise<R> {
  const r = await c.query<R>(sql, params);
  return must(r.rows[0], `a row from ${sql.slice(0, 50)}`) as R;
}

/** A connection as the UNPRIVILEGED role, with the tenant/business context a request would carry. */
async function asApp(tenantId: string | null, businessId: string | null): Promise<Client> {
  const c = new Client({ connectionString: appUrl });
  await c.connect();
  // Per-session SET, never a global one: the live comment is explicit that
  // there is no global SET on pooled connections, so stale context is
  // impossible by construction.
  if (tenantId !== null) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
  if (businessId !== null) await c.query(`SELECT set_config('app.business_id', $1, false)`, [businessId]);
  return c;
}

async function visibleRows(c: Client): Promise<number> {
  const r = await one<{ n: string }>(c, 'SELECT count(*)::text AS n FROM p13_rls.loyalty_point_movements');
  return Number(r.n);
}

/* ------------------------------------------------------------------ *
 * Fixture identity — recorded, because the evidence rules require it
 * ------------------------------------------------------------------ */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUSINESS_A1 = '11111111-1111-4111-8111-111111111111';
const BUSINESS_A2 = '22222222-2222-4222-8222-222222222222';
const BUSINESS_B1 = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

/**
 * The scratch schema: the policy shape Phase 13's patch request asks for,
 * mirroring the live pattern rather than inventing one.
 *
 * `app_bypass()` is written in its LIVE form — a pure role check. The earlier
 * form in the history was `current_setting('app.bypass_rls', true) = 'true'`,
 * a CLIENT-SETTABLE GUC, and case 5 is the measured demonstration that the
 * role form closes what the GUC form left open.
 */
const SCHEMA = `
create schema p13_rls;

create or replace function p13_rls.app_tenant() returns text language sql stable parallel safe
  return pg_catalog.current_setting('app.tenant_id', true);
create or replace function p13_rls.app_business() returns text language sql stable parallel safe
  return pg_catalog.current_setting('app.business_id', true);
create or replace function p13_rls.app_bypass() returns boolean language sql stable parallel safe
  return CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'::pg_catalog.name;

create table p13_rls.businesses (
  business_id uuid primary key,
  tenant_id   uuid not null
);
-- Before the composite foreign key below, because that key needs this index to
-- exist first: PostgreSQL requires a unique constraint matching the referenced
-- columns at the moment the referencing table is created.
create unique index businesses_pair_uq on p13_rls.businesses (business_id, tenant_id);

create table p13_rls.loyalty_point_movements (
  id            uuid   not null,
  tenant_id     uuid   not null,
  business_id   uuid   not null,
  customer_id   uuid   not null,
  movement_kind text   not null,
  points_delta  bigint not null,
  corrects_id   uuid,
  -- THE DECLARED KEY SHAPE, and a cross-phase check is why this is not a
  -- simple \`id\`. P13-LOYALTY-DESIGN §1.3 declares PRIMARY KEY (business_id,
  -- id) with no global unique on id, and the frozen house comment at
  -- 0043:139 says what that is for: two businesses may hold the same id. A
  -- fixture keyed on id alone is NARROWER than the real table, so the
  -- collision this proof's own subject requires could not even be built, and
  -- the self-referential composite key below cannot be created on it at all
  -- (measured: ERROR 42830, no unique constraint matching given keys).
  primary key (business_id, id),
  constraint corrects_fk foreign key (business_id, corrects_id)
    references p13_rls.loyalty_point_movements (business_id, id) on delete restrict,
  foreign key (business_id, tenant_id) references p13_rls.businesses (business_id, tenant_id)
);

alter table p13_rls.businesses enable row level security;
alter table p13_rls.businesses force row level security;
create policy tenant_isolation on p13_rls.businesses
  using      (p13_rls.app_bypass() or tenant_id::text = p13_rls.app_tenant())
  with check (p13_rls.app_bypass() or tenant_id::text = p13_rls.app_tenant());

alter table p13_rls.loyalty_point_movements enable row level security;
alter table p13_rls.loyalty_point_movements force row level security;
-- PERMISSIVE: the row's tenant must be the active tenant context.
create policy tenant_membership on p13_rls.loyalty_point_movements
  using      (p13_rls.app_bypass() or tenant_id::text = p13_rls.app_tenant())
  with check (p13_rls.app_bypass() or tenant_id::text = p13_rls.app_tenant());
-- RESTRICTIVE: and the row's business must be the active business context.
-- Both must hold; this is the pair whose necessity case 6 measures by removal.
create policy business_isolation on p13_rls.loyalty_point_movements as restrictive
  using      (p13_rls.app_bypass() or business_id::text = p13_rls.app_business())
  with check (p13_rls.app_bypass() or business_id::text = p13_rls.app_business());
`;

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly notes: readonly string[];
}
type CaseFn = (admin: Pool, note: (line: string) => void) => Promise<void>;

const cases: readonly { readonly name: string; readonly fn: CaseFn }[] = [
  {
    name: 'case-1-catalogue: the probing role is NOT superuser and NOT bypassrls, and FORCE RLS is on',
    /**
     * This runs FIRST on purpose. Every later case's meaning depends on the
     * connection being genuinely unprivileged, so that is read out of
     * `pg_roles` rather than assumed from the fact that a role was created
     * without the attributes. A proof that accidentally ran as a superuser
     * would pass its positive control and silently pass nothing else.
     */
    fn: async (admin, note) => {
      const r = await one<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
      }>(
        admin,
        `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
           FROM pg_roles WHERE rolname = $1`,
        [APP_ROLE],
      );
      note(
        `1: pg_roles for ${APP_ROLE}: superuser=${r.rolsuper} bypassrls=${r.rolbypassrls} ` +
          `createdb=${r.rolcreatedb} createrole=${r.rolcreaterole} replication=${r.rolreplication}`,
      );
      if (r.rolsuper) throw new Error('1: the probing role is a SUPERUSER — every isolation result below would be meaningless');
      if (r.rolbypassrls) throw new Error('1: the probing role carries BYPASSRLS — RLS would not apply to it at all');
      if (r.rolcreatedb || r.rolcreaterole || r.rolreplication) {
        throw new Error('1: the probing role carries an elevated attribute it was not given deliberately');
      }

      const t = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'p13_rls' AND c.relkind = 'r' ORDER BY c.relname`,
      );
      for (const row of t.rows) {
        note(`1: ${row.relname}: rowsecurity=${row.relrowsecurity} forcerowsecurity=${row.relforcerowsecurity}`);
        if (!row.relrowsecurity || !row.relforcerowsecurity) {
          throw new Error(`1: ${row.relname} does not have RLS enabled AND forced`);
        }
      }
      note('1: OUTCOME = PROVEN BY DATABASE CATALOGUE — unprivileged role, RLS enabled and FORCED on every relation');
    },
  },

  {
    name: 'case-2-positive-control: with its own tenant and business context, the role CAN read its own rows',
    /**
     * The positive control. Without it, a schema that denies everything — a
     * revoked grant, a typo in a policy, a missing GRANT USAGE — would pass
     * every negative case below and prove nothing.
     */
    fn: async (admin, note) => {
      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const n = await visibleRows(c);
        const ctx = await one<{ t: string; b: string; u: string }>(
          c,
          `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.business_id', true) AS b, current_user AS u`,
        );
        note(`2: connected as ${ctx.u}, tenant=${ctx.t}, business=${ctx.b}`);
        note(`2: rows visible = ${n} (the fixture put 3 in this business)`);
        if (n !== 3) throw new Error(`2: expected the role to see its own 3 rows, it saw ${n}`);
        const ins = await settle(() =>
          c.query(
            `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta)
               VALUES (gen_random_uuid(), $1, $2, $3, 'earn', 5)`,
            [TENANT_A, BUSINESS_A1, CUSTOMER],
          ),
        );
        note(`2: an INSERT into its OWN business: ${observed(ins)}`);
        if (!ins.ok) throw new Error(`2: the permitted write was refused: ${ins.message}`);
        note('2: OUTCOME = the permitted capability WORKS. Every refusal below is therefore a real refusal');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-3-negative: a session scoped to its own business cannot see or write the SIBLING business',
    /**
     * A FIRST DRAFT OF THIS CASE WAS WRONG, and the proof caught it, which is
     * the only reason it is worth recording. It set the business context TO the
     * sibling business and then asserted zero rows — so it was asking the
     * sibling's own session whether it could see the sibling's own rows, and
     * failing because the answer was correctly "yes, two of them". That is not
     * a leak; it is the positive control again, under a different name.
     *
     * The isolation question is the other way round: a session scoped to ITS
     * OWN business must see NOTHING of the sibling's. Asserted here on the
     * CONTENT of what is visible rather than on a count, so the case cannot be
     * perturbed by a row an earlier case legitimately inserted.
     */
    fn: async (admin, note) => {
      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const foreign = await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM p13_rls.loyalty_point_movements WHERE business_id <> $1`, [BUSINESS_A1]);
        const own = await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM p13_rls.loyalty_point_movements WHERE business_id = $1`, [BUSINESS_A1]);
        const truth = await one<{ sibling: string; own: string }>(
          admin,
          `SELECT
             (SELECT count(*)::text FROM p13_rls.loyalty_point_movements WHERE business_id = $2) AS sibling,
             (SELECT count(*)::text FROM p13_rls.loyalty_point_movements WHERE business_id = $1) AS own`,
          [BUSINESS_A1, BUSINESS_A2],
        );
        note(`3: scoped to its own business, rows visible whose business is NOT its own = ${foreign.n}`);
        note(`3: rows visible that ARE its own = ${own.n}; the superuser counts ${truth.own} of its own and ${truth.sibling} in the sibling`);
        if (Number(truth.sibling) === 0) {
          throw new Error('3: the sibling business holds no rows, so there was nothing to hide — the case would be vacuous');
        }
        if (foreign.n !== '0') throw new Error(`3: ${foreign.n} row(s) from outside its own business were visible`);
        if (own.n !== truth.own) {
          throw new Error(`3: it should see all ${truth.own} of its own rows but saw ${own.n}`);
        }

        // And it cannot write a row INTO the business it is not scoped to.
        const ins = await settle(() =>
          c.query(
            `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta)
               VALUES (gen_random_uuid(), $1, $2, $3, 'earn', 99)`,
            [TENANT_A, BUSINESS_A2, CUSTOMER],
          ),
        );
        note(`3: an INSERT naming the SIBLING business while scoped to its own: ${observed(ins)}`);
        if (ins.ok) throw new Error('3: a row was written into a business the session is not scoped to');
        if (ins.code !== '42501') {
          throw new Error(`3: expected 42501 from the policy WITH CHECK, observed ${observed(ins)}`);
        }
        note('3: OUTCOME = the sibling is invisible AND unwritable; the write refusal is 42501 from WITH CHECK');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-4-negative: the RIGHT business id under the WRONG tenant is still invisible',
    /**
     * The case that justifies having two policies instead of one. A reader
     * might think the RESTRICTIVE business policy alone is enough, since a
     * business id is unique. It is not enough as a SECURITY argument: it would
     * make a leaked or guessed business id sufficient on its own. The
     * PERMISSIVE tenant policy is what makes the tenant boundary independent.
     */
    fn: async (admin, note) => {
      const c = await asApp(TENANT_B, BUSINESS_A1);
      try {
        const n = await visibleRows(c);
        note(`4: tenant context = the OTHER tenant, business context = the CORRECT business id, rows visible = ${n}`);
        if (n !== 0) throw new Error(`4: a correct business id under the wrong tenant leaked ${n} rows`);
        note('4: OUTCOME = a correct business id is NOT sufficient; the tenant policy is independently load-bearing');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-5-negative: with NO context at all the role sees nothing (fail-closed), and SET app.bypass_rls does nothing',
    /**
     * Two failures that would be invisible in a test that only ever sets a
     * correct context:
     *
     * 5a A missing context must mean NOTHING is visible, not EVERYTHING. A
     *    policy comparing a column to an empty setting fails closed only if it
     *    is written to; `current_setting(..., true)` returns NULL when unset,
     *    and `column = NULL` is NULL, which is not true — so the row is
     *    filtered. That is the behaviour this asserts, because it is the whole
     *    reason a request that forgot to set its context is safe.
     *
     * 5b The escalation the history actually left open for a while. The FIRST
     *    definition of `app_bypass()` in this project's migration history was
     *    `current_setting('app.bypass_rls', true) = 'true'` — a GUC any
     *    connected role can SET. Under that definition this case would read
     *    every row of every tenant. The live definition is a ROLE check, and
     *    this case measures that the GUC is now inert.
     *
     *    The case also prints the live function's own body from the catalogue,
     *    so it cannot pass vacuously against some other definition.
     */
    fn: async (admin, note) => {
      const def = await one<{ src: string }>(
        admin,
        `SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'p13_rls' AND p.proname = 'app_bypass'`,
      );
      const body = def.src.replace(/\s+/g, ' ').trim();
      note(`5: the live app_bypass() under test: ${body.slice(body.indexOf('RETURN'))}`);
      if (body.includes('bypass_rls')) {
        throw new Error('5: the function under test still reads a client-settable GUC — case 5b would be testing the wrong shape');
      }

      const blind = await asApp(null, null);
      try {
        const n = await visibleRows(blind);
        note(`5a: with NO tenant or business context set, rows visible = ${n}`);
        if (n !== 0) throw new Error(`5a: a context-less session saw ${n} rows — this is fail-OPEN`);
        note('5a: OUTCOME = fail-closed. A request that forgets to set its context reads nothing, not everything');
      } finally {
        await blind.end();
      }

      const attacker = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const before = await visibleRows(attacker);
        const esc = await settle(() => attacker.query(`SELECT set_config('app.bypass_rls', 'true', false)`));
        note(`5b: the role setting app.bypass_rls = true itself: ${observed(esc)}`);
        const after = await visibleRows(attacker);
        note(`5b: rows visible before = ${before}, after setting the GUC = ${after}`);
        if (after !== before) {
          throw new Error(`5b: setting app.bypass_rls CHANGED visibility from ${before} to ${after} — the GUC is live`);
        }
        const total = await one<{ n: string }>(admin, 'SELECT count(*)::text AS n FROM p13_rls.loyalty_point_movements');
        note(`5b: rows that exist in total (read by the superuser, for comparison only) = ${total.n}`);
        if (Number(total.n) <= after) {
          throw new Error('5b: the fixture does not contain rows outside this scope, so there was nothing to leak — vacuous');
        }
        note(`5b: OUTCOME = the GUC is INERT. The role still sees only its own ${after} of ${total.n} rows`);
      } finally {
        await attacker.end();
      }
    },
  },

  {
    name: 'case-6-mutation-control: removing the RESTRICTIVE business policy makes the SIBLING visible',
    /**
     * The directive's own standard: *if a mutation test does not go red when
     * the law is removed, it is not a proof.* Case 3 claims the policy pair is
     * what hides the sibling business. This drops ONE of the two and shows the
     * sibling's rows appear in a session scoped to its own business — then
     * restores the policy and shows they disappear again.
     *
     * What it isolates is precise: the TENANT policy still passes (both
     * businesses belong to the same tenant), so anything that becomes visible
     * here became visible because the BUSINESS policy was the only thing
     * stopping it. Without this case, case 3 could be passing because of a
     * missing grant, an empty table, or a typo that denies everything.
     */
    fn: async (admin, note) => {
      const scoped = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const sibling = async (): Promise<number> => {
          const r = await one<{ n: string }>(scoped, `SELECT count(*)::text AS n FROM p13_rls.loyalty_point_movements WHERE business_id = $1`, [BUSINESS_A2]);
          return Number(r.n);
        };
        const before = await sibling();
        note(`6: with both policies, a session scoped to its own business sees ${before} sibling row(s)`);
        if (before !== 0) throw new Error('6: the fixture is wrong — isolation was already broken before the mutation');

        await admin.query('DROP POLICY business_isolation ON p13_rls.loyalty_point_movements');
        const leaked = await sibling();
        note(`6: with the RESTRICTIVE business policy DROPPED, the same session sees ${leaked} sibling row(s)`);
        if (leaked === 0) {
          throw new Error(
            '6: dropping the business policy changed NOTHING. Case 3 was therefore not measuring that policy, ' +
              'and something else (a grant, an empty table, a deny-all typo) was doing the work',
          );
        }
        note(`6: RED CONFIRMED — ${leaked} sibling row(s) leaked the moment the policy was removed`);

        await admin.query(`
          create policy business_isolation on p13_rls.loyalty_point_movements as restrictive
            using      (p13_rls.app_bypass() or business_id::text = p13_rls.app_business())
            with check (p13_rls.app_bypass() or business_id::text = p13_rls.app_business());
        `);
        const restored = await sibling();
        note(`6: with the policy restored, the same session sees ${restored} sibling row(s)`);
        if (restored !== 0) throw new Error(`6: isolation did not come back: ${restored} sibling row(s) still visible`);
        note('6: OUTCOME = the RESTRICTIVE business policy is what does the work, measured by removal AND restoration');
      } finally {
        await scoped.end();
      }
    },
  },

  {
    name: 'case-7-append-only: UPDATE and DELETE on the ledger are refused by the GRANT, before any row lock',
    /**
     * The loyalty design holds that the ledger is append-only as an ACL fact
     * rather than a convention: the runtime role is granted `SELECT, INSERT`
     * and nothing else. Its own test matrix asserts the PRIVILEGE error and
     * not a trigger refusal, on the grounds that asserting a trigger would be
     * asserting a mechanism that never runs. This measures that the privilege
     * is in fact what answers.
     */
    fn: async (admin, note) => {
      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const upd = await settle(() => c.query(`UPDATE p13_rls.loyalty_point_movements SET points_delta = 0 WHERE tenant_id = $1`, [TENANT_A]));
        const del = await settle(() => c.query(`DELETE FROM p13_rls.loyalty_point_movements WHERE tenant_id = $1`, [TENANT_A]));
        note(`7: UPDATE as the runtime role: ${observed(upd)}`);
        note(`7: DELETE as the runtime role: ${observed(del)}`);
        if (upd.ok || del.ok) throw new Error('7: the ledger is mutable by the runtime role');
        if (upd.code !== '42501' || del.code !== '42501') {
          throw new Error(`7: expected 42501 for both, observed UPDATE=${observed(upd)} DELETE=${observed(del)}`);
        }
        const grants = await admin.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = $1 AND table_schema = 'p13_rls' AND table_name = 'loyalty_point_movements'
            ORDER BY privilege_type`,
          [APP_ROLE],
        );
        const held = grants.rows.map((g) => g.privilege_type);
        note(`7: the grants the role actually holds, read from information_schema: ${held.join(', ') || '(none)'}`);
        if (held.length !== 2 || !held.includes('SELECT') || !held.includes('INSERT')) {
          throw new Error(`7: expected exactly SELECT and INSERT, the catalogue says ${held.join(', ')}`);
        }
        note('7: OUTCOME = append-only is an ACL fact, PROVEN BY DATABASE CATALOGUE and by the refusal itself');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-8-negative: a crafted predicate cannot read across the boundary, and the count is not leaked either',
    /**
     * A boundary that filters rows but answers aggregate questions about them
     * is not a boundary. RLS applies to the rows an aggregate reads, so this
     * should hold — "should" is why it is measured. Also checks the shape an
     * analytics query actually takes: a GROUP BY over business, which must
     * never return a group the session is not scoped to.
     */
    fn: async (admin, note) => {
      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const agg = await one<{ total: string | null; rows: string }>(
          c,
          `SELECT sum(points_delta)::text AS total, count(*)::text AS rows
             FROM p13_rls.loyalty_point_movements WHERE business_id = $1`,
          [BUSINESS_A2],
        );
        note(`8: an aggregate deliberately filtered to the SIBLING business: rows=${agg.rows}, sum=${agg.total ?? 'NULL'}`);
        if (agg.rows !== '0' || agg.total !== null) {
          throw new Error(`8: an aggregate leaked the sibling business: rows=${agg.rows} sum=${agg.total ?? 'NULL'}`);
        }

        const groups = await c.query<{ business_id: string; n: string }>(
          `SELECT business_id::text, count(*)::text AS n FROM p13_rls.loyalty_point_movements
            GROUP BY business_id ORDER BY business_id`,
        );
        note(`8: a GROUP BY over business returned ${groups.rows.length} group(s): ${groups.rows.map((g) => `${g.business_id}=${g.n}`).join(', ')}`);
        if (groups.rows.length !== 1 || groups.rows[0]?.business_id !== BUSINESS_A1) {
          throw new Error('8: a grouped analytics read returned a business the session is not scoped to');
        }
        note('8: OUTCOME = neither the rows nor their count nor their grouping crosses the boundary');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-9-key-shape: two businesses hold the SAME movement id, and each sees only its own',
    /**
     * A cross-phase check found both proofs keyed on a simple `id` while the
     * design declares `PRIMARY KEY (business_id, id)`. That made the fixture
     * NARROWER than the real table: the collision this proof's whole subject
     * requires could not be built in it at all, so the isolation of two rows
     * that share an id had never been measured. The frozen house comment at
     * `0043:139` is explicit that the composite key exists to allow it.
     *
     * This case measures the collision on the declared shape AND shows, on a
     * scratch table keyed the way the fixture used to be, that the same two
     * rows are refused outright — which is the red proof that the key shape is
     * doing the work rather than being decoration.
     */
    fn: async (admin, note) => {
      const shared = await one<{ id: string }>(admin, 'SELECT gen_random_uuid()::text AS id');
      await admin.query(
        `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta)
           VALUES ($1,$2,$3,$4,'earn',11), ($1,$2,$5,$4,'earn',22)`,
        [shared.id, TENANT_A, BUSINESS_A1, CUSTOMER, BUSINESS_A2],
      );
      note(`9: both businesses now hold movement id ${shared.id} — accepted by the declared key`);

      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const seen = await admin.query<{ business_id: string; points_delta: string }>(
          `SELECT business_id::text, points_delta::text FROM p13_rls.loyalty_point_movements WHERE id = $1`,
          [shared.id],
        );
        note(`9: the admin pool (BYPASSRLS off, but the owner) sees ${seen.rows.length} row(s) under that id`);
        const scoped = await c.query<{ business_id: string; points_delta: string }>(
          `SELECT business_id::text, points_delta::text FROM p13_rls.loyalty_point_movements WHERE id = $1`,
          [shared.id],
        );
        note(
          `9: the app role scoped to A1 sees ${scoped.rows.length} row(s): ` +
            `${scoped.rows.map((r) => `${r.business_id}=${r.points_delta}`).join(', ') || '(none)'}`,
        );
        if (scoped.rows.length !== 1) {
          throw new Error(`9: an id shared across businesses leaked: ${scoped.rows.length} row(s) visible to A1`);
        }
        if (scoped.rows[0]?.business_id !== BUSINESS_A1 || scoped.rows[0]?.points_delta !== '11') {
          throw new Error('9: the row visible under the shared id is not this business own row');
        }

        // RED PROOF: the shape the fixture used to have cannot hold these rows.
        await admin.query('create table p13_rls.simple_key_probe (id uuid primary key, business_id uuid not null)');
        const collide = await settle(() =>
          admin.query('insert into p13_rls.simple_key_probe (id, business_id) values ($1,$2),($1,$3)', [shared.id, BUSINESS_A1, BUSINESS_A2]),
        );
        note(`9: the same two rows against a SIMPLE id key: ${observed(collide)}`);
        if (collide.ok || collide.code !== '23505') {
          throw new Error(`9: expected 23505 on the simple key, observed ${observed(collide)}`);
        }
        await admin.query('drop table p13_rls.simple_key_probe');
        note('9: OUTCOME = the declared composite key permits the collision and RLS isolates it; the simple key forbids it');
      } finally {
        await c.end();
      }
    },
  },

  {
    name: 'case-10-corrects-fk: a correction may name a row in its OWN business and no other',
    /**
     * `corrects_id` is the discriminator four challenge rounds have turned on,
     * and the self-referential composite FK `§1.4` rests on had never been
     * exercised at the database level — not even for creatability, because on a
     * table keyed by a simple `id` it cannot be created at all (measured:
     * `42830`). Now that the fixture carries the declared key, the edge exists
     * and both of its directions are measured here.
     *
     * Note what answers, because it is not the policy: a foreign key is checked
     * by the system, not by the session, so a cross-business correction is
     * refused by `23503` rather than by RLS. That is the point — the
     * referential law holds even where the reader cannot see the row it would
     * have pointed at.
     */
    fn: async (admin, note) => {
      const own = await one<{ id: string }>(admin, `SELECT id::text FROM p13_rls.loyalty_point_movements WHERE business_id = $1 ORDER BY id LIMIT 1`, [
        BUSINESS_A1,
      ]);
      // The sibling row must be one whose id does NOT also exist in this
      // business, or the composite key would legitimately resolve and the case
      // would measure nothing. Case 9 deliberately creates such a collision, so
      // this is not hypothetical: the first version of this case selected that
      // very row and reported a boundary crossing that had not happened.
      const sibling = await one<{ id: string }>(
        admin,
        `SELECT m.id::text FROM p13_rls.loyalty_point_movements m
          WHERE m.business_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM p13_rls.loyalty_point_movements o
                WHERE o.business_id = $2 AND o.id = m.id
            )
          ORDER BY m.id LIMIT 1`,
        [BUSINESS_A2, BUSINESS_A1],
      );
      const declared = await one<{ n: string }>(
        admin,
        `SELECT count(*)::text AS n FROM pg_constraint
          WHERE conname = 'corrects_fk' AND contype = 'f'
            AND conrelid = 'p13_rls.loyalty_point_movements'::regclass
            AND confrelid = 'p13_rls.loyalty_point_movements'::regclass`,
      );
      note(`10: the self-referential composite FK is in the catalogue: ${declared.n} constraint(s) named corrects_fk`);
      if (declared.n !== '1') throw new Error('10: corrects_fk is not on the table the proof is measuring');

      const c = await asApp(TENANT_A, BUSINESS_A1);
      try {
        const good = await settle(() =>
          c.query(
            `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta, corrects_id)
               VALUES (gen_random_uuid(), $1, $2, $3, 'adjust', 5, $4)`,
            [TENANT_A, BUSINESS_A1, CUSTOMER, own.id],
          ),
        );
        note(`10: a correction naming a row in its OWN business: ${observed(good)}`);
        if (!good.ok) throw new Error(`10: the permitted capability does not work: ${observed(good)}`);

        const across = await settle(() =>
          c.query(
            `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta, corrects_id)
               VALUES (gen_random_uuid(), $1, $2, $3, 'adjust', 5, $4)`,
            [TENANT_A, BUSINESS_A1, CUSTOMER, sibling.id],
          ),
        );
        note(`10: a correction naming the SIBLING business row: ${observed(across)}`);
        if (across.ok) throw new Error('10: a correction crossed the business boundary');
        if (across.code !== '23503') {
          throw new Error(`10: expected 23503 from the composite FK, observed ${observed(across)}`);
        }
        const unknown = await settle(() =>
          c.query(
            `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta, corrects_id)
               VALUES (gen_random_uuid(), $1, $2, $3, 'adjust', 5, gen_random_uuid())`,
            [TENANT_A, BUSINESS_A1, CUSTOMER],
          ),
        );
        note(`10: a correction naming a row that exists nowhere: ${observed(unknown)}`);
        if (unknown.ok || unknown.code !== '23503') {
          throw new Error(`10: expected 23503 for an unknown target, observed ${observed(unknown)}`);
        }
        note('10: OUTCOME = the correction edge is a real constraint, refusing across the boundary and refusing an absence');
      } finally {
        await c.end();
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * The runner, and the evidence record the directive requires
 * ------------------------------------------------------------------ */

function gitFact(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return '(unavailable)';
  }
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  rmSync(PG_DIR, { recursive: true, force: true });
  const cluster = new Cluster(findBinDir());
  const binaryVersion = cluster.version();

  let pool: Pool | null = null;
  const results: CaseResult[] = [];
  let serverVersion = '(not reached)';
  let collation = '(not reached)';

  try {
    cluster.start();
    const admin = new Pool({ connectionString: superUrl, max: 4 });
    pool = admin;

    serverVersion = (await one<{ v: string }>(admin, 'SELECT version() AS v')).v;
    const loc = await one<{ c: string; t: string; e: string }>(
      admin,
      `SELECT datcollate AS c, datctype AS t, pg_encoding_to_char(encoding) AS e
         FROM pg_database WHERE datname = current_database()`,
    );
    collation = `datcollate=${loc.c} datctype=${loc.t} encoding=${loc.e}`;

    console.log('P13-PROOF-RLS — tenant and business isolation, asserted as a NON-SUPERUSER');
    console.log(`binary:      ${binaryVersion}`);
    console.log(`measured on: ${serverVersion}`);
    console.log(`collation:   ${collation}`);
    if (!/\b16\.\d+\b/.test(binaryVersion)) {
      throw new Error(`the settled deploy line is PostgreSQL 16; this binary is ${binaryVersion}`);
    }
    console.log('');

    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(SCHEMA);

    // The unprivileged role: exactly SELECT, INSERT on the ledger, and nothing else.
    await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`GRANT USAGE ON SCHEMA p13_rls TO ${APP_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT ON p13_rls.loyalty_point_movements TO ${APP_ROLE}`);
    await admin.query(`GRANT SELECT ON p13_rls.businesses TO ${APP_ROLE}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION p13_rls.app_tenant(), p13_rls.app_business(), p13_rls.app_bypass() TO ${APP_ROLE}`);

    // The fixture: two tenants, three businesses, rows in each.
    await admin.query(`INSERT INTO p13_rls.businesses (business_id, tenant_id) VALUES ($1,$2),($3,$2),($4,$5)`, [
      BUSINESS_A1,
      TENANT_A,
      BUSINESS_A2,
      BUSINESS_B1,
      TENANT_B,
    ]);
    for (const [tenant, business, n] of [
      [TENANT_A, BUSINESS_A1, 3],
      [TENANT_A, BUSINESS_A2, 2],
      [TENANT_B, BUSINESS_B1, 4],
    ] as const) {
      for (let i = 0; i < n; i += 1) {
        await admin.query(
          `INSERT INTO p13_rls.loyalty_point_movements (id, tenant_id, business_id, customer_id, movement_kind, points_delta)
             VALUES (gen_random_uuid(), $1, $2, $3, 'earn', 10)`,
          [tenant, business, CUSTOMER],
        );
      }
    }

    for (const c of cases) {
      const notes: string[] = [];
      const outcome = await settle(() => c.fn(admin, (line) => notes.push(line)));
      results.push({ name: c.name, ok: outcome.ok, notes });
      console.log(`${outcome.ok ? 'PASS' : 'FAIL'} ${c.name}`);
      for (const n of notes) console.log(`       - ${n}`);
      if (!outcome.ok) console.log(`       ! ${outcome.message}`);
      console.log('');
    }
  } catch (e) {
    console.log(`FAIL harness: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ name: 'harness', ok: false, notes: [] });
  } finally {
    await pool?.end().catch(() => undefined);
    cluster.stop();
    rmSync(PG_DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  const code = failed.length === 0 ? 0 : 1;
  console.log(`${results.length - failed.length}/${results.length} cases passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);

  // The evidence record. The directive requires command, exact SHA, base SHA,
  // tree status, runtime versions, database version and collation, execution
  // role, fixture identity, UTC start and end, exit code, counts, skips and
  // measurement validity — so the run prints them rather than leaving a reader
  // to reconstruct them from a report someone wrote afterwards.
  console.log('');
  console.log('--- EVIDENCE RECORD -------------------------------------------------');
  console.log(`command            : node packages/analytics/test/rls/tenant-isolation.pgtest.mts`);
  console.log(`exact SHA          : ${gitFact(['rev-parse', 'HEAD'])}`);
  console.log(`branch             : ${gitFact(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
  console.log(`base SHA (main)    : ${gitFact(['rev-parse', 'origin/main'])}`);
  console.log(`merge base vs main : ${gitFact(['merge-base', 'HEAD', 'origin/main'])}`);
  const dirty = gitFact(['status', '--porcelain']);
  console.log(`tree status        : ${dirty === '' ? 'clean' : `${dirty.split('\n').length} changed path(s) — RESULT IS NOT SHA-BOUND`}`);
  // C-5: measured against the MERGE-BASE with `main`, not against `HEAD`.
  // `git diff HEAD -- …` compares the worktree with the last commit, so it
  // cannot see a migration changed in a commit ON this branch -- the figure was
  // 0 lines and the sentence it supported, that the frozen migrations are
  // untouched, was a claim the measurement could not make. The conclusion was
  // true and the coverage was not, which is the class this round is about.
  // R11-05: `main` does not resolve in a clone that holds only `origin/` refs --
  // the F-12 shape, which a challenger reproduced by cloning. There the merge
  // base came back `(unavailable)`, the diff ran against nothing, and the line
  // printed `(unavai` -- a slice of that word -- inside a sentence that reads
  // as though a merge base had been used. The two lines above already read
  // `origin/main`; this one does too, with the local ref only as a fallback,
  // and the unresolvable case now says so in words instead of slicing one.
  const mergeBase = ['origin/main', 'main'].map((ref) => gitFact(['merge-base', 'HEAD', ref])).find((sha) => /^[0-9a-f]{40}$/.test(sha));
  console.log(
    mergeBase === undefined
      ? 'migrations touched : NOT MEASURED \u2014 no merge base with main resolves in this clone (neither origin/main nor main), so no diff was run'
      : `migrations touched : ${gitFact(['diff', '--shortstat', mergeBase, '--', 'infrastructure/database/migrations']) || '0 lines'} (worktree vs merge-base with main ${mergeBase.slice(0, 7)}, so a commit on this branch is included)`,
  );
  console.log(`node               : ${process.version}`);
  console.log(`database           : ${serverVersion}`);
  console.log(`collation          : ${collation}`);
  console.log(
    `execution role     : fixture + catalogue as '${SUPER}'; EVERY isolation assertion as '${APP_ROLE}' (NOSUPERUSER NOBYPASSRLS, verified in case 1)`,
  );
  console.log(`fixture identity   : tenants ${TENANT_A} / ${TENANT_B}; businesses ${BUSINESS_A1}, ${BUSINESS_A2}, ${BUSINESS_B1}; 3/2/4 rows`);
  console.log(`UTC start          : ${startedAt}`);
  console.log(`UTC end            : ${new Date().toISOString()}`);
  console.log(`cases              : ${results.length - failed.length} passed / ${results.length} total`);
  console.log(`skips              : 0 — this proof has no skip path`);
  console.log(`exit code          : ${code}`);
  console.log(`measurement validity: VALID for the policy SHAPE on scratch DDL. NOT evidence about the real`);
  console.log(`                     relations, which have no DDL yet; that is established from the catalogue at`);
  console.log(`                     integration, by the Migration Owner. No timing figure is claimed.`);
  console.log('---------------------------------------------------------------------');
  return code;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.log(`FAIL harness: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
