/**
 * THE TARGET-PLAN EVIDENCE HARNESS (option B of the directive).
 *
 * WHY NOT OPTION A. The directive's first preference is to make the existing
 * harness start the target major and collation. It cannot:
 * `tests/helpers/embedded-cluster.ts` is built on the `embedded-postgres`
 * package, whose bundled distribution is PostgreSQL 18.4, and it initdb's
 * with the bare `C` locale. Neither is the deployment target, and changing
 * either would re-point every existing suite at a different server — the
 * opposite of "without compromising existing tests".
 *
 * SO: OPTION B. A dedicated cluster, initialised the way the deployment
 * target is, used only for plan-evidence suites. The existing embedded PG18
 * cluster keeps every correctness, RLS, concurrency and SQL-validity suite it
 * has today; this one carries the plan claims.
 *
 * AND OPTION C IS NOT OPTIONAL EITHER. This script is a local convenience.
 * The authoritative side is required CI, whose `postgres:16` service already
 * IS the target, and `tests/performance/plan-evidence-contract.test.ts`
 * asserts structurally that every discovered plan-gate file is executed
 * against it. A harness a developer may forget to run is not a gate.
 *
 * USAGE
 *   npx tsx scripts/plan-evidence/target-cluster.ts --up        start + migrate
 *   npx tsx scripts/plan-evidence/target-cluster.ts --measure   print contract
 *   npx tsx scripts/plan-evidence/target-cluster.ts --down      stop
 *
 * It REUSES a server already listening on the port, exactly as
 * `startOrReuse()` does — so in CI, where `PG_PORT=5432` is the `postgres:16`
 * service, `--measure` measures the real target and starts nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { Client } from 'pg';
import { readPlanEvidenceEnvironment, classifyPlanEvidence, planEvidenceBanner, isByteOrderCollation } from '../../tests/helpers/plan-evidence-env';

export const TARGET_PG_PORT = Number(process.env['PLAN_EVIDENCE_PG_PORT'] ?? 55301);
export const TARGET_PG_DIR = process.env['PLAN_EVIDENCE_PG_DIR'] ?? '/tmp/daftar-pg-target16';
const BIN = process.env['PLAN_EVIDENCE_PG16_BIN'] ?? '/usr/lib/postgresql/16/bin';

/**
 * The locale to initdb with, best first.
 *
 * `en_US.utf8` is what the `postgres:16` image reports. A container that has
 * not generated it can still produce VALID target evidence with `C.utf8`:
 * measured on 16.13, both are non-byte-order and both refuse to derive a
 * prefix range from `^@` over a default-collation index, which is the
 * property every plan claim here depends on. What is NOT acceptable is
 * falling back to `C` — that is the bug, not a fallback.
 */
const LOCALE_PREFERENCE = ['en_US.UTF-8', 'en_US.utf8', 'C.UTF-8', 'C.utf8'];

const asPostgres = (argv: string[]): string => {
  // initdb and pg_ctl refuse to run as root. `setpriv` drops to the `postgres`
  // account without a login shell, which `su` would need.
  const root = process.getuid?.() === 0;
  const [cmd, ...rest] = root ? ['setpriv', `--reuid=postgres`, `--regid=postgres`, '--clear-groups', ...argv] : argv;
  if (cmd === undefined) throw new Error('empty command');
  return execFileSync(cmd, rest, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};

function availableLocales(): Set<string> {
  try {
    return new Set(
      execFileSync('locale', ['-a'], { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}

export function chooseLocale(): string {
  const have = availableLocales();
  const forced = process.env['PLAN_EVIDENCE_LOCALE'];
  if (forced !== undefined && forced !== '') {
    if (isByteOrderCollation(forced)) {
      throw new Error(`PLAN_EVIDENCE_LOCALE=${forced} is a BYTE ORDER locale. That is the defect this harness exists to catch, not a configuration of it.`);
    }
    return forced;
  }
  // Case-insensitively, since `locale -a` reports the normalised spelling.
  const lower = new Map([...have].map((l) => [l.toLowerCase(), l]));
  for (const want of LOCALE_PREFERENCE) {
    const hit = lower.get(want.toLowerCase());
    if (hit !== undefined) return hit;
  }
  throw new Error(
    `no non-byte-order locale is generated in this environment (looked for ${LOCALE_PREFERENCE.join(', ')}). ` +
      `Generate one with: localedef -i en_US -f UTF-8 en_US.UTF-8`,
  );
}

async function serverAnswers(port: number): Promise<boolean> {
  const c = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    connectionTimeoutMillis: 1500,
  });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

export async function up(): Promise<void> {
  if (await serverAnswers(TARGET_PG_PORT)) {
    console.info(`[target-cluster] reusing the server already listening on ${TARGET_PG_PORT}`);
    return;
  }
  if (!existsSync(`${BIN}/initdb`)) {
    throw new Error(`no PostgreSQL ${TARGET_PLAN_EVIDENCE_MAJOR} binaries at ${BIN}. Set PLAN_EVIDENCE_PG16_BIN.`);
  }
  const locale = chooseLocale();
  console.info(`[target-cluster] initdb at locale ${locale} in ${TARGET_PG_DIR}`);
  mkdirSync(TARGET_PG_DIR, { recursive: true });
  execFileSync('chown', ['postgres:postgres', TARGET_PG_DIR]);
  asPostgres([`${BIN}/initdb`, '-D', TARGET_PG_DIR, '--encoding=UTF8', `--locale=${locale}`, '-U', 'postgres', '--auth=trust']);
  asPostgres([
    `${BIN}/pg_ctl`,
    '-D',
    TARGET_PG_DIR,
    '-o',
    `-p ${TARGET_PG_PORT} -c listen_addresses=127.0.0.1 -c password_encryption=md5`,
    '-l',
    `${TARGET_PG_DIR}/log`,
    'start',
    '-w',
  ]);
  const c = new Client({
    host: '127.0.0.1',
    port: TARGET_PG_PORT,
    user: 'postgres',
    database: 'postgres',
  });
  await c.connect();
  await c.query(`ALTER USER postgres PASSWORD 'postgres'`);
  await c.end();
  console.info(`[target-cluster] up on ${TARGET_PG_PORT}`);
}

export function down(): void {
  if (!existsSync(`${TARGET_PG_DIR}/postmaster.pid`)) return;
  asPostgres([`${BIN}/pg_ctl`, '-D', TARGET_PG_DIR, '-m', 'fast', 'stop']);
  console.info('[target-cluster] stopped');
}

const TARGET_PLAN_EVIDENCE_MAJOR = 16;

export async function measure(database = 'postgres'): Promise<void> {
  const c = new Client({
    host: '127.0.0.1',
    port: TARGET_PG_PORT,
    user: 'postgres',
    password: 'postgres',
    database,
  });
  await c.connect();
  try {
    const env = await readPlanEvidenceEnvironment(async <R>(sql: string) => ({
      rows: (await c.query(sql)).rows as R[],
    }));
    console.info(planEvidenceBanner(env));
    console.info(JSON.stringify({ environment: env, verdict: classifyPlanEvidence(env) }, null, 2));
    if (!classifyPlanEvidence(env).authoritative) process.exitCode = 1;
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--down')) return down();
  if (args.includes('--up')) await up();
  if (args.includes('--measure') || args.length === 0) {
    const dbArg = args.find((a) => a.startsWith('--database='))?.slice('--database='.length);
    await measure(dbArg ?? 'postgres');
  }
}

if (process.argv[1]?.endsWith('target-cluster.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
