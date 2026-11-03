/**
 * C1.5 (DR-70 §3(ب)) — THE SCHEMA FLOOR GATE: THE API REFUSES TO START ON A
 * DATABASE BEHIND THIS BUILD.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────
 *
 * A deployment where the code has moved and the database has not is the
 * quietest money defect there is. The code reads a column that is not there
 * and gets an error — that case is loud and fixes itself. The dangerous case
 * is the code reading a routine that IS there in an OLDER form: candidate
 * `0084`'s `invoice_outstanding` appends `currency_code`, `due_date` and
 * `issue_date` to `0083`'s five columns, and a positional reader against the
 * `0083` form does not fail — it reads the WRONG FIELD and reports a number.
 * So the gate's job is not to improve an error message. It is to make sure the
 * first money read never happens at all.
 *
 * ── WHERE IT SITS, AND WHY THAT IS THE ONLY PLACE IT COULD ────────────────
 *
 * `assertSchemaFloor` is wired as a DEPENDENCY of the `Database` provider
 * (`runtime.ts`), so the ordering is structural rather than declarative: Nest
 * will not construct a provider before its dependencies resolve, every money
 * read in this application goes through `Database`, and therefore no money
 * read can precede the check. Not «it is declared first» — the handle a money
 * read needs does not exist until the check has passed.
 *
 * Two measurements back that claim up, and they are in this file because a
 * claim about ordering that nobody measured is an assumption:
 *
 *   — §3 boots the WHOLE application against a database stopped at `0083` and
 *     requires the boot to REJECT. Nothing is served, so nothing is read.
 *   — and `apps/api/src/infra/database.ts` is the only file under
 *     `apps/api/src` carrying an init-time lifecycle hook, and that hook reads
 *     `SELECT current_user` and nothing else — so no money read happens during
 *     `app.init()` at all, and `app.listen()` (`main.ts:93`) is never reached.
 *
 * ── WHY THE GATE HAS TWO HALVES ───────────────────────────────────────────
 *
 * The obvious gate reads `schema_migrations` and compares the greatest applied
 * name with the one this build requires. On this estate that gate CANNOT be
 * the whole story, and §3 measures why: `schema_migrations` is owned by
 * `postgres` and granted to `postgres` alone, no routine exposes it, and
 * `MIGRATION_DATABASE_URL` is deliberately withheld from the API runtime. So
 * `has_table_privilege('daftar_app', 'public.schema_migrations', 'SELECT')` is
 * FALSE, and a gate that only read the ledger would not fail closed — it would
 * fail ALWAYS, with `42501 permission denied`, and no deployment would boot.
 *
 * So the gate reads the ledger WHEN the principal may (scratch databases,
 * migration tests, single-role dev setups) and ALWAYS checks the money-read
 * SURFACE through `pg_catalog`, which every role may read. §2 and §4 exercise
 * the ledger half; §5 exercises the surface half, with the ledger made to
 * agree with the build while the DDL does not — which is the shape a real
 * deployment is in, since there the ledger half cannot run at all.
 *
 * ── THE PLANT, AND WHY IT IS A REAL DATABASE ──────────────────────────────
 *
 * The database stopped at `0083` is a REAL scratch database, built by applying
 * `0000`…`0083` through the real migration runner, and the stop point is read
 * back out of its own `schema_migrations` before the gate is ever called. A
 * cheaper plant — an empty database with a hand-made `schema_migrations` row
 * saying `0083` — would exercise the same `max(name)` and would be a plant
 * about the fixture. §2 keeps the expensive one.
 *
 * ── WHAT WOULD MAKE THIS FILE VACUOUS ─────────────────────────────────────
 *
 * Every refusal case below would pass against a gate that refused
 * EVERYTHING — a typo in the connection string, a gate that threw on any
 * database at all. That is why §2 ends by migrating the SAME scratch database
 * the rest of the way and requiring the gate to then ACCEPT it: the refusal
 * has to be about the version and not about the database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaFloor, SCHEMA_FLOOR_REFUSAL, schemaGateTargets, type SchemaGateConfig, type SchemaGateReport } from '../../apps/api/src/app/runtime';
import { migrationOrdinal, REQUIRED_SCHEMA_MIGRATION, schemaFloor } from '../../apps/api/src/config';
import { createScratchDb, headMigration, migrationFiles, scratchPool, urlOf, type ScratchDb } from '../helpers/scratch-db';
import { createTestApp, ensurePostgres, ownerPool } from '../helpers/test-app';

/**
 * The gate's subject is derived from `PROCESS_MODE` (`schemaGateTargets`), so
 * a caller now has to say which process it speaks for. `merchant-api` holding
 * the app URL and nothing else resolves to EXACTLY ONE target — the app
 * database — which is the subject every case below was already written
 * against. So widening the gate's subject did not widen these cases: each one
 * still asserts about one database, and `§6` is where the widening itself is
 * measured.
 */
const gateConfig = (url: string | undefined): SchemaGateConfig => ({
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: url,
  PLATFORM_DATABASE_URL: undefined,
  IDENTITY_DATABASE_URL: undefined,
  RESOLVER_DATABASE_URL: undefined,
  PROVISIONER_DATABASE_URL: undefined,
  WORKER_DATABASE_URL: undefined,
  RECONCILER_DATABASE_URL: undefined,
  isProd: false,
});

/** The migration the plant stops at: the last one BEFORE the floor this build requires. */
const STOP_AT = '0083_phase4_ar_outstanding_set_based.sql';

let stopped: ScratchDb | undefined;
/** The stop point read back out of the plant's OWN `schema_migrations`, never assumed from `STOP_AT`. */
let plantedHead: string | undefined;
let plantedApplied: readonly string[] = [];

beforeAll(async () => {
  await ensurePostgres();
  stopped = await createScratchDb(`daftar_dr71c15_${randomUUID().slice(0, 8)}`, { upTo: STOP_AT, keys: false });
  plantedApplied = stopped.applied;
  const r = await stopped.pool.query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
  plantedHead = r.rows[0]?.head ?? undefined;
}, 600_000);

afterAll(async () => {
  await stopped?.drop();
});

describe('C1.5 §1 — the floor this build requires is the DDL it ships', () => {
  it('REQUIRED_SCHEMA_MIGRATION is the head of the shipped migration set, so the constant cannot fall behind the code', () => {
    // The pin that keeps the constant honest. Without it, a slice that adds
    // `0087` and forgets this line leaves the gate enforcing a floor the code
    // has already moved past — and the gate would then admit exactly the
    // mismatched database it exists to refuse, silently, while still passing
    // every refusal case in §2.
    const files = migrationFiles();
    expect(files.length > 0, 'NO SUBJECT — no migration files on disk, so there is no shipped set to pin the constant against').toBe(true);
    expect(
      REQUIRED_SCHEMA_MIGRATION,
      `REQUIRED_SCHEMA_MIGRATION must name the highest migration this build ships. It says ${REQUIRED_SCHEMA_MIGRATION} and the shipped head is ` +
        `${headMigration()}. If a migration was just added, move the constant with it.`,
    ).toBe(headMigration());
  });

  it('the ordinal is parsed from the name, and an unplaceable name parses to null rather than to zero', () => {
    expect(schemaFloor(), `the floor is the ordinal of ${REQUIRED_SCHEMA_MIGRATION}`).toBe(86);
    expect(migrationOrdinal('0083_phase4_ar_outstanding_set_based.sql'), 'a four-digit prefix').toBe(83);
    expect(migrationOrdinal('10000_far_future.sql'), 'a five-digit prefix is placed by VALUE, not by string order').toBe(10_000);
    // The reason the comparison is numeric rather than lexicographic. While
    // every prefix is four digits the two orders agree, and agreeing by
    // accident is not the same as being right: the moment a fifth digit
    // arrives without the others being re-padded, '10000_…' sorts BELOW
    // '9999_…' as a string while being ABOVE it as a version. A lexicographic
    // gate would then read a NEWER database as older and refuse a correct
    // deployment.
    expect('10000_far_future.sql' < '9999_x.sql', 'as strings, the five-digit name sorts below the four-digit one').toBe(true);
    expect(migrationOrdinal('10000_far_future.sql') ?? 0, 'as versions it is above, which is the order the gate uses').toBeGreaterThan(
      migrationOrdinal('9999_x.sql') ?? 0,
    );
    // Unplaceable names are `null` — never 0, which would compare as «older
    // than everything» and turn an unreadable name into a confident refusal
    // for the wrong reason, and never a large number, which would admit it.
    expect(migrationOrdinal('baseline.sql'), 'a name with no leading ordinal').toBeNull();
    expect(migrationOrdinal(''), 'an empty name').toBeNull();
  });
});

describe('C1.5 §2 — a database stopped at 0083 is REFUSED, and the same one migrated is ACCEPTED', () => {
  it('the plant is proven applied: a real database whose own schema_migrations tops out at 0083', () => {
    expect(stopped, 'the scratch database was built').toBeDefined();
    // Read back from the plant itself. `STOP_AT` is what was ASKED for;
    // `plantedHead` is what the database actually has, and the gate reads the
    // latter. A plant whose stop point was taken on trust is a plant.
    expect(plantedHead, `the plant's own max(schema_migrations.name) is the stop point, not ${STOP_AT} by assumption`).toBe(STOP_AT);
    expect(migrationOrdinal(plantedHead ?? ''), `and it is strictly BELOW the floor ${schemaFloor()}, or there is nothing for the gate to refuse`).toBeLessThan(
      schemaFloor(),
    );
    // Non-vacuity of the plant: it is a MIGRATED database, not an empty one
    // with a single row. §2's refusal has to be about the version.
    expect(
      plantedApplied.length > 50,
      `NO SUBJECT — the plant applied only ${plantedApplied.length} migrations, so it is not a database stopped at 0083 but an almost-empty one`,
    ).toBe(true);
    expect(plantedApplied[plantedApplied.length - 1], 'the runner applied up to the stop point inclusive').toBe(STOP_AT);
  });

  it('the gate REFUSES it, and names the floor, the name it found, and what starting would do', async () => {
    const db = stopped;
    expect(db, 'the plant').toBeDefined();
    if (db === undefined) return;
    const err = await assertSchemaFloor(gateConfig(db.url('postgres'))).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
    expect(
      err,
      `the gate ACCEPTED a database whose greatest applied migration is ${plantedHead}, three migrations below the ${REQUIRED_SCHEMA_MIGRATION} ` +
        `this build requires. A positional reader of 0083's five-column invoice_outstanding does not fail against 0084's eight-column form — it ` +
        `reads the wrong field and reports a number.`,
    ).not.toBeNull();
    const message = err?.message ?? '';
    expect(message, 'the refusal is the schema floor gate and not an incidental connection error').toContain(SCHEMA_FLOOR_REFUSAL);
    expect(message, 'and it names the migration this build requires, so the operator knows what to run').toContain(REQUIRED_SCHEMA_MIGRATION);
    expect(message, 'and the name it actually found, so the operator knows where the database is').toContain(STOP_AT);
  }, 120_000);

  it('and THE SAME database, migrated the rest of the way, is ACCEPTED — so the refusal was about the VERSION', async () => {
    const db = stopped;
    expect(db, 'the plant').toBeDefined();
    if (db === undefined) return;
    // THE CONTROL THIS WHOLE FILE RESTS ON. Every other case here is a
    // refusal, and a gate that refused every database would pass all of them.
    // Migrating this very database and watching the gate accept it is what
    // separates «the floor is enforced» from «the gate is broken».
    const rest = await db.migrateRest();
    expect(rest.length > 0, `NO SUBJECT — nothing was left to apply, so the plant was never actually behind`).toBe(true);
    const head = await db.pool.query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
    expect(head.rows[0]?.head, 'the database now tops out at the shipped head').toBe(headMigration());
    await expect(
      assertSchemaFloor(gateConfig(db.url('postgres'))),
      `the gate refused a database at the shipped head ${headMigration()}. It is refusing correct deployments, which means every refusal above ` +
        `proved nothing about the version.`,
    ).resolves.toBe(schemaFloor());
  }, 600_000);
});

describe('C1.5 §3 — the APPLICATION refuses to boot, so no route is ever mounted', () => {
  it('createTestApp against a database stopped at 0083 REJECTS: the gate is Database’s dependency, not a later step', async () => {
    const db = stopped;
    expect(db, 'the plant').toBeDefined();
    if (db === undefined) return;
    // The plant for THIS case is a second scratch database, because §2's was
    // migrated to the head by the control above and would now boot.
    const behind = await createScratchDb(`daftar_dr71c15boot_${randomUUID().slice(0, 8)}`, { upTo: STOP_AT, keys: false });
    try {
      const head = await behind.pool.query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
      expect(head.rows[0]?.head, 'the boot plant is proven applied, read from its own schema_migrations').toBe(STOP_AT);

      const boot = await createTestApp({ configOverrides: { APP_DATABASE_URL: behind.url('postgres') } }).then(
        (app) => ({ ok: true as const, app }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e : new Error(String(e)) }),
      );
      if (boot.ok) {
        // Close it before failing, or a leaked app keeps pools open for the
        // rest of the run.
        await boot.app.close().catch(() => undefined);
      }
      expect(
        boot.ok,
        `the application BOOTED against a database stopped at ${STOP_AT}. Every money route is mounted and answering, three migrations ahead of ` +
          `the schema underneath them.`,
      ).toBe(false);
      expect(
        boot.ok ? '' : boot.error.message,
        `and the boot failed at the schema floor gate rather than somewhere incidental: ${boot.ok ? '' : boot.error.message}`,
      ).toContain(SCHEMA_FLOOR_REFUSAL);
    } finally {
      await behind.drop();
    }
  }, 600_000);

  it('and the gate does NOT refuse the real database, whose principal CANNOT read the ledger at all', async () => {
    // The measurement that shapes the whole gate. On the real database the
    // API's own role has no SELECT on `schema_migrations` — so a gate that
    // only read the ledger would not fail closed, it would fail ALWAYS with
    // `42501 permission denied` and no deployment would ever boot. That is
    // why the gate has a surface half, and §5 is where the surface half is
    // shown to bite.
    const may = await ownerPool().query<{ app: boolean; owner: string; grantees: string }>(
      `SELECT has_table_privilege('daftar_app', 'public.schema_migrations', 'SELECT') AS app,
              pg_get_userbyid(c.relowner) AS owner,
              coalesce((SELECT string_agg(DISTINCT g.grantee, ',' ORDER BY g.grantee)
                          FROM information_schema.role_table_grants g
                         WHERE g.table_name = 'schema_migrations'), '') AS grantees
         FROM pg_class c WHERE c.oid = 'public.schema_migrations'::regclass`,
    );
    const row = may.rows[0];
    expect(row?.app, `daftar_app can now SELECT schema_migrations (owner ${row?.owner}, grantees ${row?.grantees}).`).toBe(false);
  }, 60_000);

  it('the gate does NOT refuse the real database — the control the whole suite takes continuously', async () => {
    // Every other test file in this repository boots the application through
    // the same `coreProviders`, against the shared database at the shipped
    // head. If this gate refused a correct database, the entire suite would be
    // red rather than this one case. Stated here anyway, so the file carries
    // its own positive control and does not rely on a reader knowing that.
    await expect(assertSchemaFloor(gateConfig(urlOf('daftar', 'daftar_app'))), `the gate refuses the real database`).resolves.toBe(schemaFloor());
  }, 60_000);
});

describe('C1.5 §4 — an unidentifiable schema is refused, never assumed adequate', () => {
  it('a database with NO schema_migrations table is refused, and says the migrations never ran', async () => {
    const bare = await createScratchDb(`daftar_dr71c15bare_${randomUUID().slice(0, 8)}`, { upTo: migrationFiles()[0] ?? STOP_AT, keys: false });
    try {
      // Drop the table to reach the «never migrated» shape. The plant is
      // proven applied by reading the catalogue back before the gate is asked.
      await bare.pool.query(`DROP TABLE IF EXISTS public.schema_migrations`);
      const gone = await bare.pool.query<{ present: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
      expect(gone.rows[0]?.present, 'the plant is proven applied: the table is gone').toBe(false);
      const err = await assertSchemaFloor(gateConfig(bare.url('postgres'))).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(err, `a database with no schema_migrations was accepted, so an unmigrated database can start the API`).not.toBeNull();
      expect(err?.message ?? '', 'the refusal is the gate').toContain(SCHEMA_FLOOR_REFUSAL);
      expect(err?.message ?? '', 'and it says what is actually wrong rather than leaking relation does not exist').toContain('no schema_migrations table');
    } finally {
      await bare.drop();
    }
  }, 300_000);

  it('an EMPTY schema_migrations is refused, and an UNPLACEABLE name is refused rather than read as adequate', async () => {
    const odd = await createScratchDb(`daftar_dr71c15odd_${randomUUID().slice(0, 8)}`, { upTo: migrationFiles()[0] ?? STOP_AT, keys: false });
    const pool = scratchPool(odd.url('postgres'));
    try {
      await pool.query(`DELETE FROM public.schema_migrations`);
      const empty = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.schema_migrations`);
      expect(empty.rows[0]?.n, 'the plant is proven applied: the table is empty').toBe('0');
      const e1 = await assertSchemaFloor(gateConfig(odd.url('postgres'))).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(e1, `an empty schema_migrations was accepted`).not.toBeNull();
      expect(e1?.message ?? '', 'the empty case names itself').toContain('schema_migrations is empty');

      // A name the gate cannot place. `max(name)` picks it because 'z…' sorts
      // above every ordinal, which is exactly the shape that would defeat a
      // string comparison against the floor.
      await pool.query(`INSERT INTO public.schema_migrations (name, sha256) VALUES ('zzz_hand_rolled.sql', repeat('0', 64))`);
      const planted = await pool.query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
      expect(planted.rows[0]?.head, 'the plant is proven applied: the unplaceable name is what max(name) returns').toBe('zzz_hand_rolled.sql');
      const e2 = await assertSchemaFloor(gateConfig(odd.url('postgres'))).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(
        e2,
        `a database whose greatest applied migration is 'zzz_hand_rolled.sql' was ACCEPTED. As a STRING that name is above ` +
          `'${REQUIRED_SCHEMA_MIGRATION}', so a lexicographic gate would read it as newer than the floor and start the API on a schema nobody ` +
          `can place.`,
      ).not.toBeNull();
      expect(e2?.message ?? '', 'and the refusal says the name carries no ordinal').toContain('no leading ordinal');
    } finally {
      await pool.end().catch(() => undefined);
      await odd.drop();
    }
  }, 300_000);
});

describe('C1.5 §5 — the SURFACE half bites where the ledger cannot be read, or lies', () => {
  it('a database at 0083 whose ledger CLAIMS 0086 is still refused, named on the five-column invoice_outstanding', async () => {
    // This is the case that protects a real deployment. On the live database
    // the API's principal cannot read `schema_migrations` at all (§3), so the
    // ordinal half never runs there and the surface half is the ONLY thing
    // standing between the build and a schema it was not written for.
    //
    // The plant makes the ledger agree with the build while the DDL does not:
    // migrate to 0083, then insert a row naming the required migration. The
    // ordinal half is then satisfied — and the refusal that follows can only
    // have come from the surface half, which is exactly what this case is
    // for. A test that simply pointed at an old database would have been
    // refused by the ordinal half and proved nothing about the surface.
    const lying = await createScratchDb(`daftar_dr71c15lie_${randomUUID().slice(0, 8)}`, { upTo: STOP_AT, keys: false });
    try {
      const before = await lying.pool.query<{ head: string | null; result: string | null }>(
        `SELECT (SELECT max(name) FROM public.schema_migrations) AS head,
                CASE WHEN to_regprocedure('public.invoice_outstanding(uuid,uuid[])') IS NULL THEN NULL
                     ELSE pg_get_function_result(to_regprocedure('public.invoice_outstanding(uuid,uuid[])')) END AS result`,
      );
      expect(before.rows[0]?.head, 'the plant starts at the stop point').toBe(STOP_AT);
      // The hazard, measured rather than described: at 0083 the routine EXISTS
      // and returns FIVE columns. It is present-but-older, which is the shape
      // that does not fail and reports a wrong number instead.
      const oldShape = before.rows[0]?.result ?? '';
      expect(
        oldShape.length > 0,
        `NO SUBJECT — invoice_outstanding(uuid,uuid[]) is absent at ${STOP_AT}, so this is the ABSENT case, not the ` +
          `present-but-older one the surface half is for`,
      ).toBe(true);
      expect(oldShape, 'and it does not yet carry the three columns 0084 appends').not.toContain('issue_date');

      await lying.pool.query(`INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, repeat('0', 64))`, [REQUIRED_SCHEMA_MIGRATION]);
      const after = await lying.pool.query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
      // The plant is proven applied: the ledger now names the required
      // migration, so the ordinal half will pass and cannot be the refuser.
      expect(after.rows[0]?.head, 'the plant is proven applied: the ledger now claims the required migration').toBe(REQUIRED_SCHEMA_MIGRATION);
      expect(migrationOrdinal(after.rows[0]?.head ?? ''), 'and its ordinal is at the floor, so the ordinal half is satisfied').toBe(schemaFloor());

      const err = await assertSchemaFloor(gateConfig(lying.url('postgres'))).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(
        err,
        `the gate ACCEPTED a database whose ledger claims ${REQUIRED_SCHEMA_MIGRATION} while invoice_outstanding is still 0083's five-column ` +
          `form. On a real deployment the ordinal half cannot run at all, so this is the only half there is — and a positional reader of the ` +
          `five-column form against the eight-column code reads the wrong field and reports a number.`,
      ).not.toBeNull();
      const message = err?.message ?? '';
      expect(message, 'the refusal is the gate').toContain(SCHEMA_FLOOR_REFUSAL);
      expect(message, 'and it names the routine whose shape is wrong').toContain('invoice_outstanding(uuid,uuid[])');
      expect(message, 'and it quotes the shape this build reads, so the operator can see the difference').toContain('issue_date');
    } finally {
      await lying.drop();
    }
  }, 600_000);

  it('and a database missing a required routine ENTIRELY is refused by name, not by a later NULL', async () => {
    const early = await createScratchDb(`daftar_dr71c15early_${randomUUID().slice(0, 8)}`, { upTo: migrationFiles()[0] ?? STOP_AT, keys: false });
    try {
      // Satisfy the ordinal half so the surface half is reached, as above.
      await early.pool.query(`INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, repeat('0', 64))`, [REQUIRED_SCHEMA_MIGRATION]);
      const absent = await early.pool.query<{ present: boolean }>(`SELECT to_regprocedure('public.invoice_outstanding(uuid,uuid[])') IS NOT NULL AS present`);
      expect(absent.rows[0]?.present, 'the plant is proven applied: the routine is absent entirely').toBe(false);
      const err = await assertSchemaFloor(gateConfig(early.url('postgres'))).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      expect(err, `a database with no invoice_outstanding at all was accepted`).not.toBeNull();
      // Three assertions where this used to be one. The refusal must name the
      // ROUTINE (not fail later on a null result), say the routine is absent
      // from the CATALOGUE rather than merely wrong, and name WHICH database —
      // which it can now do, because the gate's subject is a set and a reader
      // who is told «some database» cannot act on it.
      const absentMsg = err?.message ?? '';
      expect(absentMsg, 'the refusal names the absent routine rather than failing later on a null result').toContain('invoice_outstanding(uuid,uuid[])');
      expect(absentMsg, 'and says it is absent from the catalogue, not merely of the wrong shape').toContain('catalogue');
      expect(absentMsg, 'and names which of this process’s databases is missing it').toContain('is not in the app database');
    } finally {
      await early.drop();
    }
  }, 300_000);
});

describe('C1.5 §6 — the gate’s subject is the database THIS PROCESS reads, and it says which half ran', () => {
  /**
   * The defect this section exists for. `coreProviders` is composed by five
   * modules, and the gate used to open `APP_DATABASE_URL` in all five. In
   * `PROCESS_MODE=reconciler` that variable is not merely absent, it is
   * FORBIDDEN — `config.ts` fails validation if it is set, in every
   * environment — and `new Client({ connectionString: undefined })` does not
   * refuse: `pg` falls back to `PGUSER`/`PGDATABASE`/`PGHOST`. So the gate
   * either could not connect (and the reconciler could not boot) or it
   * validated whatever the ambient environment pointed at.
   *
   * Both arms are needed and neither alone proves anything. The first could
   * pass against a gate that ignored its argument entirely; the second could
   * pass against a gate that refused everything. Together they say the
   * subject is the reconciler URL and nothing else.
   */
  it('in reconciler mode the subject is the reconciler URL, and the app URL is ignored even when present', async () => {
    const unusable = 'postgresql://nobody:nobody@127.0.0.1:1/does-not-exist';
    const good = urlOf('daftar', 'daftar_app');

    expect(
      schemaGateTargets({ ...gateConfig(unusable), PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: good }),
      `reconciler mode resolved to something other than the reconciler URL alone`,
    ).toEqual([{ role: 'reconciler', url: good }]);

    // ARM 1 — reconciler URL good, app URL unusable: ACCEPTS, because the app
    // URL is not this process's subject. Under the old gate this threw.
    await expect(
      assertSchemaFloor({ ...gateConfig(unusable), PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: good }),
      `the gate still reaches for the app URL in reconciler mode`,
    ).resolves.toBe(schemaFloor());

    // ARM 2 — the converse, which is what stops arm 1 being vacuous: when the
    // RECONCILER URL is the unusable one, the gate must NOT pass just because
    // a good app URL happens to be lying around.
    await expect(
      assertSchemaFloor({ ...gateConfig(good), PROCESS_MODE: 'reconciler', RECONCILER_DATABASE_URL: unusable }),
      `the gate passed on a good app URL while its own subject was unreachable`,
    ).rejects.toThrow();
  }, 120_000);

  /**
   * The other half of the same defect: `pg`'s ambient fallback must never be
   * reached. A mode whose URL is absent has to be REFUSED by name, not
   * silently connected to whatever `PGHOST` says.
   */
  it('a process with no database URL is refused explicitly, naming the ambient fallback it declined', async () => {
    const err = await assertSchemaFloor({ ...gateConfig(undefined), PROCESS_MODE: 'worker' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message, `an absent URL did not produce an explicit refusal`).toContain(SCHEMA_FLOOR_REFUSAL);
    expect(err?.message).toContain('identifies no database this process is allowed to read');
    // Named, so that the next reader cannot mistake this for a connection
    // failure: the gate declined to connect at all.
    expect(err?.message).toContain('PGUSER');
    expect(err?.message).toContain('PGHOST');
  }, 60_000);

  /**
   * The operator signal. The ordinal half runs only where this principal may
   * read the ledger, and on the real database `daftar_app` may not — so a
   * pass there is the SURFACE guarantee, which is strictly weaker. The gate
   * used to return its number and say nothing, so the two passes were
   * indistinguishable.
   *
   * The owner arm is the positive control: same gate, same database, a
   * principal that CAN read the ledger — and the report flips to `enforced`
   * and carries the head it actually read. Without it, `unreadable` could be
   * a constant.
   */
  it('reports WHICH HALF spoke: unreadable for the app principal, enforced for one that can read the ledger', async () => {
    const head = await ownerPool().query<{ head: string | null }>(`SELECT max(name) AS head FROM public.schema_migrations`);
    const live = head.rows[0]?.head ?? null;
    expect(live, `the shared database has no applied migrations, so this control cannot speak`).not.toBeNull();

    const asApp: SchemaGateReport[] = [];
    await expect(assertSchemaFloor(gateConfig(urlOf('daftar', 'daftar_app')), (r) => asApp.push(r))).resolves.toBe(schemaFloor());
    expect(
      asApp.map((r) => r.role),
      `the merchant subject is not the app database alone`,
    ).toEqual(['app']);
    expect(asApp[0]?.ordinal, `the app principal reported the ordinal half as enforced, but it cannot read the ledger`).toBe('unreadable');
    expect(asApp[0]?.applied, `a skipped ordinal half still reported a version`).toBeNull();
    expect(asApp[0]?.surfaces, `the surface half checked nothing, so neither half ran`).toBeGreaterThan(0);

    const asOwner: SchemaGateReport[] = [];
    await expect(assertSchemaFloor(gateConfig(urlOf('daftar')), (r) => asOwner.push(r))).resolves.toBe(schemaFloor());
    expect(asOwner[0]?.ordinal, `the owner principal CAN read the ledger, so the ordinal half must have run`).toBe('enforced');
    expect(asOwner[0]?.applied, `the enforced half did not name the version it compared`).toBe(live);
  }, 120_000);
});
