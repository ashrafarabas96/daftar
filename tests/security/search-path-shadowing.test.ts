import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';
import {
  appClient,
  dbPayload,
  fingerprintOf,
  post,
  refusal,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX 6 — SECURITY DEFINER AND THE SCHEMAS A CALLER CAN WRITE (§2-§10, §17, §18, §23).
 *
 * The premise is the same stolen `daftar_app` credential as the authority
 * matrix, but the attack is one level lower. It does not try to forge an
 * assertion. It tries to change what the ELEVATED code means when it says
 * `accounting_assertion_keys`.
 *
 * PostgreSQL makes that plausible by default, for two independent reasons:
 *
 *   1. If `pg_temp` is not named in a function's `search_path`, the session
 *      temporary schema is still searched — FIRST, ahead of every schema that
 *      IS named — for relation and type names. Leaving it out does not
 *      exclude it; it only stops you choosing where it sits.
 *   2. `TEMPORARY` on a database is granted to PUBLIC by default, and has to
 *      be revoked explicitly. So every login role can create relations in
 *      that first-searched schema unless someone took the privilege away.
 *
 * Put together: a caller could create `pg_temp.accounting_assertion_keys`,
 * and the verifier running as `daftar_accounting_internal` would read the
 * caller's table instead of the registry. The signature check would then be
 * performed against a secret the attacker chose.
 *
 * So the question these cases answer is not "does the verifier check the
 * signature" — matrix 3 already proves that — but "is the verifier reading
 * the table it thinks it is reading". They are written against the LIVE
 * catalogue and the LIVE roles, because that is where the answer is; a test
 * that read the migration text would be asking the wrong source.
 */

const RUNTIME_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner'] as const;

const RUNTIME_URLS: Readonly<Record<(typeof RUNTIME_ROLES)[number], string>> = {
  daftar_app: appDbUrl,
  daftar_platform: platformDbUrl,
  daftar_worker: workerDbUrl,
  daftar_identity: identityDbUrl,
  daftar_resolver: resolverDbUrl,
  daftar_provisioner: provisionerDbUrl,
};

/**
 * The relations an elevated accounting routine resolves by bare name. Each one
 * is a place where a caller-created object of the same name would change what
 * the definer believes is trusted state.
 */
const ACCOUNTING_TRUSTED_RELATIONS = [
  'accounting_assertion_keys',
  'accounting_assertion_uses',
  'accounting_posting_scratch',
  'accounts',
  'businesses',
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_source_types',
] as const;

/** The same question for the frozen Phase 1 provisioning boundary (0032, 0033, 0038). */
const PROVISIONING_TRUSTED_RELATIONS = ['provisioning_assertion_keys', 'provisioning_assertion_uses', 'tenants', 'businesses', 'memberships'] as const;

let fx: PostingFixture;
let today: string;

/** A connection as one named runtime role, closed by the caller. */
async function as(role: (typeof RUNTIME_ROLES)[number]): Promise<Client> {
  const client = new Client({ connectionString: RUNTIME_URLS[role] });
  await client.connect();
  return client;
}

/** Run `sql` on a fresh connection for `role` and return the error message, or null if it succeeded. */
async function attempt(role: (typeof RUNTIME_ROLES)[number], sql: string): Promise<string | null> {
  const client = await as(role);
  try {
    await client.query(sql);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await client.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'shadow');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('the database temp policy (§4, §10)', () => {
  it('PUBLIC holds no TEMPORARY on the database — the default grant was taken away', async () => {
    const r = await ownerPool().query<{ t: boolean }>(`SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS t`);
    expect(r.rows[0]?.t, 'PUBLIC still holds TEMPORARY, so every login role inherits it').toBe(false);
  });

  it.each(RUNTIME_ROLES)('%s holds no TEMPORARY on the database', async (role) => {
    const r = await ownerPool().query<{ t: boolean }>(`SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS t`, [role]);
    expect(r.rows[0]?.t, `${role} can create temporary relations, which pg_temp searches first`).toBe(false);
  });

  it.each(RUNTIME_ROLES)('%s cannot CREATE in schema public', async (role) => {
    const r = await ownerPool().query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role]);
    expect(r.rows[0]?.c, `${role} can create objects in a schema that SECURITY DEFINER routines search`).toBe(false);
  });

  it('PUBLIC cannot CREATE in schema public', async () => {
    const r = await ownerPool().query<{ c: boolean }>(`SELECT has_schema_privilege('public', 'public', 'CREATE') AS c`);
    expect(r.rows[0]?.c).toBe(false);
  });

  it('the internal accounting authority holds no TEMPORARY either — the writer needs no session relation', async () => {
    const r = await ownerPool().query<{ t: boolean }>(`SELECT has_database_privilege('daftar_accounting_internal', current_database(), 'TEMPORARY') AS t`);
    expect(r.rows[0]?.t).toBe(false);
  });

  it('the deployment migrator keeps the CREATE its contract names, and it is not a runtime', async () => {
    const r = await ownerPool().query<{ c: boolean; login: boolean }>(
      `SELECT has_schema_privilege('daftar_migrator', 'public', 'CREATE') AS c,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'daftar_migrator') AS login`,
    );
    expect(r.rows[0]?.c, 'the migrator must still be able to apply a migration').toBe(true);
    expect(r.rows[0]?.login).toBe(true);
  });
});

describe('hostile pg_temp — the accounting boundary (§3, §17)', () => {
  it.each(ACCOUNTING_TRUSTED_RELATIONS)('daftar_app cannot create a temporary relation named %s', async (relation) => {
    const message = await attempt('daftar_app', `CREATE TEMP TABLE ${relation} (shadow TEXT)`);
    expect(message, `daftar_app created pg_temp.${relation}, which elevated accounting code would then read`).not.toBeNull();
    expect(message).toMatch(/permission denied/i);
  });

  it('daftar_app cannot create a temporary relation under any name at all', async () => {
    const message = await attempt('daftar_app', `CREATE TEMP TABLE anything_at_all (x INTEGER)`);
    expect(message).toMatch(/permission denied/i);
  });

  it('daftar_app cannot create a schema, so it cannot build one to be searched', async () => {
    const message = await attempt('daftar_app', `CREATE SCHEMA attacker_owned`);
    expect(message).toMatch(/permission denied/i);
  });

  it('daftar_app cannot create a table in public to shadow anything there', async () => {
    const message = await attempt('daftar_app', `CREATE TABLE public.accounting_assertion_keys_shadow (x INTEGER)`);
    expect(message).toMatch(/permission denied/i);
  });

  /**
   * THE WHOLE ATTACK, END TO END.
   *
   * This exact sequence forged journal entry efe2f790-8968-4f7d-a081-9b14044e2716
   * out of the `daftar_app` credential alone, with no accounting secret, before
   * TEMPORARY was revoked. It is kept here in full, run in full, and required
   * to be refused — a matrix that only checked privileges would go green again
   * the moment someone granted TEMPORARY back for an unrelated reason and then
   * never noticed that the forgery worked.
   */
  it('a stolen daftar_app credential cannot redirect the verifier to a key it chose (§17)', async () => {
    const c = simpleCommand(fx, randomUUID(), today);
    const attackerSecret = Buffer.alloc(32, 0xab);
    const claims = [
      'v1',
      'attacker',
      fx.userId,
      fx.tenantId,
      fx.businessId,
      'post',
      c.sourceType,
      c.sourceId,
      fingerprintOf(c),
      String(Math.floor(Date.now() / 1000) + 60),
      randomUUID(),
    ];
    const forged = [...claims, createHmac('sha256', attackerSecret).update(claims.join('.'), 'utf8').digest('hex')].join('.');

    const conn = await appClient();
    let posted: string | null = null;
    let refused: string | null = null;
    try {
      await conn.query('BEGIN');
      // Step 1: become the author of what `accounting_assertion_keys` means.
      await conn.query(`CREATE TEMP TABLE accounting_assertion_keys (kid TEXT, secret BYTEA, status TEXT)`);
      await conn.query(`INSERT INTO pg_temp.accounting_assertion_keys VALUES ('attacker', $1, 'active')`, [attackerSecret]);
      // Step 2: the attacker OWNS that relation, so it can hand the elevated
      // principal the access the definer's own ACL check would otherwise deny.
      await conn.query(`GRANT SELECT ON pg_temp.accounting_assertion_keys TO daftar_accounting_internal`);
      await conn.query(`CREATE TEMP TABLE accounting_assertion_uses (jti UUID PRIMARY KEY, xact XID8, used_at TIMESTAMPTZ DEFAULT now())`);
      await conn.query(`GRANT SELECT, INSERT, DELETE ON pg_temp.accounting_assertion_uses TO daftar_accounting_internal`);
      // Step 3: post under a signature the attacker made with its own key.
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [forged]);
      const r = await conn.query<{ entry_id: string }>(`SELECT entry_id FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
        c.entryDate,
        'forged by a stolen credential',
        null,
        JSON.stringify(dbPayload(c.lines)),
      ]);
      await conn.query('COMMIT');
      posted = r.rows[0]?.entry_id ?? 'unknown';
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
      await conn.query('ROLLBACK').catch(() => undefined);
    } finally {
      await conn.end().catch(() => undefined);
    }

    expect(posted, 'a forged posting was accepted — the shadowing attack works').toBeNull();
    expect(refused).toMatch(/permission denied to create temporary tables/i);

    const written = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [
      fx.businessId,
      c.sourceId,
    ]);
    expect(written.rows[0]?.n, 'the attack left a journal entry behind').toBe('0');
  });

  it('a normal posting still works — the policy closed the attack, not the feature', async () => {
    const outcome = await post(simpleCommand(fx, randomUUID(), today), fx.userId);
    expect(outcome.created).toBe(true);
  });

  it('and the credential still cannot authorize a payload it did not have signed, the way it never could', async () => {
    const c = simpleCommand(fx, randomUUID(), today);
    const message = await refusal(() => post(c, fx.userId, { postingFingerprint: 'f'.repeat(64) }));
    expect(message).toMatch(/assertion_payload_mismatch/);
  });
});

describe('hostile pg_temp — the frozen provisioning boundary (§8, §18)', () => {
  it.each(PROVISIONING_TRUSTED_RELATIONS)('daftar_provisioner cannot create a temporary relation named %s', async (relation) => {
    const message = await attempt('daftar_provisioner', `CREATE TEMP TABLE ${relation} (shadow TEXT)`);
    expect(message, `daftar_provisioner created pg_temp.${relation}, which the frozen 0038 verifier would then read`).not.toBeNull();
    expect(message).toMatch(/permission denied/i);
  });

  it('daftar_platform cannot create a temporary key registry either', async () => {
    const message = await attempt('daftar_platform', `CREATE TEMP TABLE provisioning_assertion_keys (kid TEXT, secret BYTEA, status TEXT)`);
    expect(message).toMatch(/permission denied/i);
  });

  it('a stolen provisioner credential still cannot forge an actor', async () => {
    const client = await as('daftar_provisioner');
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.provisioning_assertion', $1, true)`, ['v1.v1.forged']);
      await expect(client.query(`SELECT provision_actor(ARRAY['onboarding'])`)).rejects.toThrow(/provisioning\.assertion|permission denied/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  });
});

describe('the effective-state SECURITY DEFINER audit (§7, §9, §23)', () => {
  interface Routine {
    name: string;
    owner: string;
    config: string | null;
  }

  /** Every SECURITY DEFINER routine in the effective schema, frozen or not. */
  async function definers(): Promise<Routine[]> {
    const r = await ownerPool().query<Routine>(
      `SELECT p.oid::regprocedure::text AS name,
              o.rolname                 AS owner,
              (SELECT c FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c LIKE 'search\\_path=%') AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles o     ON o.oid = p.proowner
       WHERE n.nspname = 'public' AND p.prosecdef
       ORDER BY 1`,
    );
    return r.rows;
  }

  it('there are SECURITY DEFINER routines to audit, so a pass here means something', async () => {
    expect((await definers()).length).toBeGreaterThan(10);
  });

  it('every SECURITY DEFINER routine pins an explicit search_path', async () => {
    const naked = (await definers()).filter((d) => d.config === null).map((d) => d.name);
    expect(naked, 'a SECURITY DEFINER routine with no search_path takes the caller’s').toEqual([]);
  });

  /**
   * The scope here is deliberate, and it is NOT "every SECURITY DEFINER
   * function in the database".
   *
   * Phase 1's provisioning routines are owned by `daftar_platform`, and the
   * non-superuser deployment migrator is not a member of that role — nor
   * should it become one, because a deployment credential that can assume
   * platform authority is a worse problem than the one being fixed. Their
   * bytes are frozen and their owner is out of reach, so `ALTER FUNCTION`
   * cannot reach them in every environment.
   *
   * What protects them is the case above: with TEMPORARY revoked, there is no
   * relation for `pg_temp` to be searched for, wherever it sits in the path.
   * That revocation is the boundary. Pinning `pg_temp` last is defence in
   * depth on the set the slice can actually own — which the next case proves
   * is not an empty set.
   */
  it('every accounting routine names pg_temp explicitly, and LAST', async () => {
    const accounting = (await definers()).filter((d) => d.owner === 'daftar_accounting_internal');
    expect(accounting.length, 'the accounting routines were not found, so this case proves nothing').toBeGreaterThan(5);

    const offenders = accounting
      .map((d) => ({ name: d.name, path: (d.config ?? '').replace(/^search_path=/, '') }))
      .filter((d) => {
        const parts = d.path.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        return parts[parts.length - 1] !== 'pg_temp';
      })
      .map((d) => `${d.name} → ${d.path}`);
    expect(offenders, 'pg_temp is searched first when it is not listed, so it must be listed last').toEqual([]);
  });

  it('the frozen routines were hardened in place, without touching a frozen byte', async () => {
    // Three shapes, one from each frozen file that has one: a routine that
    // already pinned a path, an immutability trigger that pinned none, and a
    // constraint function from long before Phase 2 existed.
    const frozen = [
      'accounting_seed_chart(uuid)',
      'accounting_assert_entry_valid(uuid,uuid)',
      'journal_entries_immutable()',
      'accounts_protect_system()',
      'is_valid_iana_timezone(text)',
    ];
    for (const sig of frozen) {
      const r = await ownerPool().query<{ cfg: string | null }>(
        `SELECT (SELECT c FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE strpos(c, 'search_path=') = 1) AS cfg
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [sig],
      );
      expect(r.rows[0]?.cfg, `${sig} still resolves relation names through pg_temp first`).toMatch(/,\s*pg_temp$/);
    }
  });

  /**
   * The honest edge of the hardening, asserted rather than described.
   *
   * Phase 1's provisioning commands are owned by `daftar_platform`. The
   * non-superuser deployment migrator is not a member of that role and must
   * not become one, so `ALTER FUNCTION` cannot reach them on a managed
   * PostgreSQL. Hardening them only where a superuser happens to run the
   * migration would make CI's schema differ from production's, which is worse
   * than a boundary that is identical everywhere.
   *
   * This case pins that exception down: it must be exactly the
   * daftar_platform-owned set, it must not grow, and the TEMPORARY revocation
   * proven above is what covers it.
   *
   * ── The second exception, and why it is not a weakening ────────────────
   *
   * A routine with a SQL-standard body (`prosqlbody IS NOT NULL`) is excluded
   * too, and for the opposite reason to the first exception: not because it
   * cannot be hardened, but because there is nothing left in it to harden.
   * PostgreSQL parses such a body WHEN THE FUNCTION IS CREATED and stores the
   * resulting parse tree, recording every object it touches in `pg_depend`.
   * A string body (`AS $$ … $$`) is kept as text and parsed at CALL time,
   * which is the moment `search_path` decides what each unqualified name
   * means; a parse tree has no such moment. Pinning a path on one would
   * protect nothing and would cost something real — `inline_function()`
   * refuses to inline any function carrying a SET clause, which is what P2-S8
   * measured costing 1.56 µs per row per call inside an RLS expression.
   *
   * The exclusion is not taken on trust: `policy-helper-inlining.test.ts`
   * asserts the whole set against the live catalogue — who is in it, that
   * each body is fully schema-qualified, and that none of them is SECURITY
   * DEFINER — and fails if a routine joins it without meeting all of that.
   */
  it('the only routines left unhardened are the ones no migrator may own', async () => {
    const r = await ownerPool().query<{ sig: string; owner: string }>(
      `SELECT p.oid::regprocedure::text AS sig, o.rolname AS owner
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles     o ON o.oid = p.proowner
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.prosqlbody IS NULL
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                         WHERE c ~ $re$^search_path=.*,\\s*pg_temp$$re$)
       ORDER BY 1`,
    );
    const owners = [...new Set(r.rows.map((x) => x.owner))];
    expect(owners, `routines were left unhardened by owners other than daftar_platform: ${r.rows.map((x) => x.sig).join(', ')}`).toEqual(
      r.rows.length === 0 ? [] : ['daftar_platform'],
    );
  });

  it('no schema a SECURITY DEFINER routine searches is writable by a runtime role', async () => {
    const schemas = new Set<string>();
    for (const d of await definers()) {
      for (const part of (d.config ?? '').replace(/^search_path=/, '').split(',')) {
        const s = part.trim().replace(/^"|"$/g, '');
        if (s !== '' && s !== 'pg_temp' && s !== '$user') schemas.add(s);
      }
    }
    expect(schemas.size).toBeGreaterThan(0);

    const writable: string[] = [];
    for (const schema of schemas) {
      for (const role of RUNTIME_ROLES) {
        const r = await ownerPool().query<{ c: boolean }>(`SELECT has_schema_privilege($1, $2, 'CREATE') AS c`, [role, schema]);
        if (r.rows[0]?.c === true) writable.push(`${role} → ${schema}`);
      }
    }
    expect(writable, 'a runtime role can create objects in a schema elevated code searches').toEqual([]);
  });

  it('the posting primitive depends on no session-created relation', async () => {
    const r = await ownerPool().query<{ def: string }>(`SELECT pg_get_functiondef('accounting_post_entry(date,text,text,jsonb)'::regprocedure) AS def`);
    const def = r.rows[0]?.def ?? '';
    expect(def).not.toMatch(/CREATE\s+TEMP/i);
    expect(def).not.toMatch(/accounting_posting_scratch/i);
  });

  it('no temporary relation is left behind in the session that posted', async () => {
    const r = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'pg\\_temp%'`,
    );
    expect(r.rows[0]?.n).toBe('0');
  });
});
