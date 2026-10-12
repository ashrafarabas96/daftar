/**
 * P15 — RUNTIME ROLE ATTRIBUTES: A READ-ONLY CHECK, FOR THE SECURITY AUTHORITY
 * ============================================================================
 *
 * Mission V3 §10.0 / `TL-P4-COORD-R58` and HIGH-VELOCITY PART 9.3 both ask for
 * the same thing, and it is the one thing nobody has: a **read of the actual
 * role attributes on an authorised candidate or staging runtime**. Everything
 * measured so far — by R58 and by this phase — was measured on a FIXTURE, and
 * both rulings say in terms that a fixture result must not be attributed to a
 * real database:
 *
 *   «لم تُقَس سمات قاعدة Phase 4 الفعلية أو staging أو الإنتاج؛ فلا تنسب السمة
 *    الخطرة إليها.»
 *
 * So this is the instrument for that read, and it is deliberately the smallest
 * thing that can answer the question:
 *
 *   · It issues exactly ONE statement, a SELECT over `pg_roles`.
 *   · It opens the connection READ-ONLY (`default_transaction_read_only=on`)
 *     and inside a `BEGIN ... READ ONLY` transaction, so the server itself
 *     refuses a write even if this code were changed to attempt one.
 *   · It writes nothing, creates nothing, drops nothing, and touches no
 *     production object. There is no `--fix`, and there is no code path that
 *     could grow one without deleting the read-only guards above it.
 *   · It prints no secret: the connection string is never echoed, the host is
 *     shown without credentials, and `rolpassword` is not in the projection
 *     (it is unreadable to a non-superuser anyway, and this must run as a
 *     non-superuser).
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT
 *
 * It decides one question of fact: do any `daftar_%` roles on THIS database
 * hold elevated attributes they are not authorised to hold? R58 names the five:
 * `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, `REPLICATION`.
 *
 * It does NOT decide what that means for a seal. R58 reserves that: an
 * unauthorised elevated attribute on a REAL role is an immediate blocker for
 * the affected candidate, and the remedy goes to the Security and
 * bootstrap/Database owners. This script reports; it does not rule, and it does
 * not touch the roles it reads.
 *
 * THE AUTHORISATION MODEL, AND WHY `daftar_reconciler` IS NOT AN EXCEPTION HERE
 *
 * `bootstrap.sql` deliberately grants `BYPASSRLS` to the reconciler, and says
 * why in its own comment: a scoped verifier that must read across tenants to
 * verify them. That is an AUTHORISED holding, so this script carries it as the
 * one entry in an explicit allow-list — by role AND by attribute, never by
 * role alone. Anything else is reported as UNAUTHORISED, including a second
 * attribute on the reconciler itself.
 *
 * The allow-list is in this file, visible, rather than read from the database
 * or from a flag. A check whose expectations can be supplied by its subject is
 * not a check, and «changing the EXPECTED value to match the actual one» is
 * exactly the move the alert-rule contract forbids for `P15-ALERT-012`.
 *
 * FAIL-CLOSED (PART 18)
 *
 * Every outcome other than "connected, read, and nothing unauthorised" exits
 * non-zero. No connection string, no connection, a connection that cannot be
 * made read-only, no `daftar_%` role found, or an unreadable catalogue all exit
 * non-zero — because "I could not look" and "I looked and it is clean" must
 * never print the same way. An absent result is not a clean result.
 *
 * Usage, by the Security Authority, with their own authorised credentials:
 *
 *   P15_ROLE_READ_URL='postgresql://…' npm run verify:role-attributes
 *   npm run verify:role-attributes -- --expect-env P15_CANDIDATE_URL
 *
 * The environment identity is printed with the result, because R58 requires the
 * finding to be recorded WITH the environment it came from: a read whose
 * subject is unnamed is not evidence about any database.
 */

import { Client } from 'pg';

/** The five attributes R58 names, in the order its ruling lists them. */
const ELEVATED = ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'] as const;
type Elevated = (typeof ELEVATED)[number];

const LABEL: Record<Elevated, string> = {
  rolsuper: 'SUPERUSER',
  rolbypassrls: 'BYPASSRLS',
  rolcreatedb: 'CREATEDB',
  rolcreaterole: 'CREATEROLE',
  rolreplication: 'REPLICATION',
};

/**
 * AUTHORISED holdings, by role AND attribute. One entry, and it has a reason
 * in the tree rather than in this file's opinion.
 */
const AUTHORISED: readonly { readonly role: string; readonly attribute: Elevated; readonly why: string }[] = [
  {
    role: 'daftar_reconciler',
    attribute: 'rolbypassrls',
    why: 'infrastructure/database/bootstrap.sql grants it deliberately and states the reason in its own comment: the reconciler is a scoped verifier that must read across tenants in order to verify them. Authorised BY THE BOOTSTRAP OWNER, not by this script.',
  },
];

interface RoleRow {
  readonly rolname: string;
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
}

interface Finding {
  readonly role: string;
  readonly attribute: Elevated;
}

/** The host and database, with any credentials removed. Never the full URL. */
function safeIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port === '' ? '5432' : u.port}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(a connection string this script will not print)';
  }
}

async function main(): Promise<number> {
  console.log('P15 — RUNTIME ROLE ATTRIBUTES (READ-ONLY)');
  console.log('='.repeat(78));

  const envName = ((): string => {
    const i = process.argv.indexOf('--expect-env');
    return i >= 0 ? (process.argv[i + 1] ?? 'P15_ROLE_READ_URL') : 'P15_ROLE_READ_URL';
  })();
  const url = process.env[envName];

  if (url === undefined || url.trim().length === 0) {
    console.log(`subject   : NONE — ${envName} is not set`);
    console.log('');
    console.log('EXIT 2 — NOT MEASURED, which is NOT a clean result.');
    console.log('  This script reads role attributes on a database someone authorised it to read.');
    console.log('  Without a connection string there is no subject, and an absent read must never');
    console.log(`  print like a clean one. Set ${envName} to an authorised candidate or staging`);
    console.log('  database and run it again. Everything measured in this pack so far was measured');
    console.log('  on a FIXTURE, and R58 forbids attributing a fixture result to a real database.');
    return 2;
  }

  console.log(`subject   : ${safeIdentity(url)}   (from ${envName}; the credentials are not printed)`);
  console.log(`read at   : ${new Date().toISOString()}`);

  // Read-only at the connection level AND at the transaction level. Two
  // independent guards, because this script may be pointed at a database whose
  // loss would matter, and one guard is a guard that can be removed by accident.
  const client = new Client({ connectionString: url, options: '-c default_transaction_read_only=on', application_name: 'p15-role-attribute-read' });

  try {
    await client.connect();
  } catch (e) {
    console.log('');
    console.log(`EXIT 2 — NOT MEASURED: the connection failed (${(e as Error).message.slice(0, 160)}).`);
    console.log('  A failed connection is not a clean bill of health.');
    return 2;
  }

  try {
    const who = await client.query<{ user: string; superuser: string; version: string; collate: string }>(
      `SELECT current_user AS user,
              current_setting('is_superuser') AS superuser,
              current_setting('server_version') AS version,
              (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collate`,
    );
    const w = who.rows[0];
    console.log(`read as   : ${w?.user ?? '?'}  (is_superuser=${w?.superuser ?? '?'})`);
    console.log(`server    : PostgreSQL ${w?.version ?? '?'}, collation ${w?.collate ?? '?'}`);
    if (w?.superuser === 'on') {
      console.log('');
      console.log('  ! READ AS A SUPERUSER. The read itself is still valid — pg_roles is the same');
      console.log('    catalogue either way — but record it: a superuser read says nothing about');
      console.log('    what a runtime role can see, and this script is not an RLS check.');
    }

    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query<RoleRow>(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_roles
        WHERE rolname LIKE 'daftar\\_%'
        ORDER BY rolname`,
    );
    await client.query('COMMIT');

    if (rows.length === 0) {
      console.log('');
      console.log("EXIT 2 — NOT MEASURED: no role matching 'daftar\\_%' exists on this database.");
      console.log('  Either this is not a DAFTAR database, or the roles are named otherwise here.');
      console.log('  Both make the read inapplicable rather than clean.');
      return 2;
    }

    console.log('');
    console.log(`${'ROLE'.padEnd(24)} ${'LOGIN'.padEnd(6)} ${ELEVATED.map((a) => LABEL[a].slice(0, 11).padEnd(11)).join(' ')}`);
    const findings: Finding[] = [];
    const authorisedSeen: Finding[] = [];
    for (const r of rows) {
      const cells = ELEVATED.map((a) => (r[a] ? 'YES' : '-').padEnd(11));
      console.log(`${r.rolname.padEnd(24)} ${(r.rolcanlogin ? 'yes' : 'no').padEnd(6)} ${cells.join(' ')}`);
      for (const a of ELEVATED) {
        if (!r[a]) continue;
        const ok = AUTHORISED.some((x) => x.role === r.rolname && x.attribute === a);
        (ok ? authorisedSeen : findings).push({ role: r.rolname, attribute: a });
      }
    }

    console.log('');
    console.log(`${rows.length} daftar role(s) read. ${rows.filter((r) => r.rolcanlogin).length} can log in.`);

    for (const a of authorisedSeen) {
      const why = AUTHORISED.find((x) => x.role === a.role && x.attribute === a.attribute)?.why ?? '';
      console.log('');
      console.log(`AUTHORISED : ${a.role} holds ${LABEL[a.attribute]}`);
      console.log(`             ${why}`);
    }

    if (findings.length === 0) {
      console.log('');
      console.log('RESULT: no UNAUTHORISED elevated attribute on any daftar role of this database.');
      console.log('  Record this WITH the environment identity printed above — R58 requires the');
      console.log('  result to name its subject, and this result is about this database only.');
      console.log('  It does NOT close the convergence defect: re-running bootstrap still does not');
      console.log('  strip a drifted attribute, so a role that drifts LATER is caught by neither');
      console.log('  bootstrap nor the migration train. That repair stays with its owner.');
      return 0;
    }

    console.log('');
    console.log('EXIT 1 — UNAUTHORISED ELEVATED ATTRIBUTE(S) ON A REAL ROLE OF THIS DATABASE:');
    for (const f of findings) console.log(`  · ${f.role} holds ${LABEL[f.attribute]}`);
    console.log('');
    console.log('  Under R58 this is an IMMEDIATE BLOCKER for the affected candidate, and it is');
    console.log('  not this script’s to remedy. Hand it to the Security Authority and the');
    console.log('  bootstrap/Database owner together. Do NOT alter a production role, and do not');
    console.log('  “fix” it by adding the attribute to this script’s allow-list: that would be');
    console.log('  changing the expectation to match the finding.');
    return 1;
  } catch (e) {
    console.log('');
    console.log(`EXIT 2 — NOT MEASURED: the catalogue read failed (${(e as Error).message.slice(0, 160)}).`);
    return 2;
  } finally {
    await client.end().catch(() => {
      /* a disposable connection that will not close is not a verdict */
    });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`EXIT 2 — NOT MEASURED: ${(e as Error).message}`);
    process.exitCode = 2;
  },
);
