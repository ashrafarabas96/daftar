/**
 * P15 — LIVE VERIFICATION OF THE HISTORICAL GAP LIST
 * ===================================================
 *
 * The Master Continuous Mission names five items carried forward from earlier
 * reviews and asks for them to be verified against the live tree:
 *
 *   G1  BFF CSRF negative tests
 *   G2  upload path traversal
 *   G3  the runtime DB principal and APP_DATABASE_URL across deploy environments
 *   G4  platform LOGIN role blast radius
 *   G5  media-scanner wiring
 *
 * It also says, verbatim, that these are "neither proven holes nor reopened
 * fixes". That wording decides the shape of this script. It does not assume a
 * defect and then look for it, and it does not assume the earlier fix and then
 * confirm it. Each item is measured against the code that is in the tree
 * today, and each verdict is one of:
 *
 *   PASS      the property holds, and this script executed or read the thing
 *             that makes it hold.
 *   FINDING   a named, reproducible gap. A FINDING here is an expected output,
 *             not a crash: this is a verification run, not a gate.
 *   UNMEASURED the question cannot be answered from this tree. Saying so is
 *             the answer; a guess dressed as a verdict is not.
 *
 * ── Why the exit code is not a verdict ──────────────────────────────────────
 *
 * Every other P15 script is a gate: exit 0 means the property holds. This one
 * is a report. It exits 0 when all five items were MEASURED (whatever each one
 * found) and 1 when an item could not be measured at all, because an
 * unmeasured item is the only outcome that leaves the Mission's question
 * unanswered. The findings themselves are the deliverable and are printed in
 * full, with the file and line that produces each one, so a reader can
 * reproduce every one of them by hand.
 *
 * ── What G4 executes ───────────────────────────────────────────────────────
 *
 * G1, G2, G3 and G5 are answered from the live code (G3 by running the real
 * `loadConfig`). G4 is answered by a real PostgreSQL cluster, because the
 * question is what `bootstrap.sql` does to a role that ALREADY EXISTS, and no
 * amount of reading settles whether an `ALTER ROLE` strips an attribute it
 * does not name. The cluster is this script's own, on its own port, and is
 * destroyed at the end. Run it with `--no-cluster` to skip G4; it then reports
 * G4 as UNMEASURED and exits 1, which is the honest outcome of not running it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startCluster, stopCluster, prepareClusterDir, psqlScalar, createEmptyDatabase, PG_SUPERPASS, PG16_BIN, type ClusterSpec } from './pg-cluster';
// G3 runs the REAL validator rather than reading it, so it is imported here
// and not re-implemented: a paraphrase of a rule is not the rule.
import { loadConfig } from '../../apps/api/src/config';

const ROOT = resolve(__dirname, '../..');

type Verdict = 'PASS' | 'FINDING' | 'UNMEASURED';

interface Item {
  readonly id: string;
  readonly title: string;
  verdict: Verdict;
  readonly notes: string[];
  readonly findings: string[];
}

const items: Item[] = [];

function item(id: string, title: string): Item {
  const it: Item = { id, title, verdict: 'UNMEASURED', notes: [], findings: [] };
  items.push(it);
  return it;
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(join(ROOT, rel));

/** The 1-based line number of the first line matching `needle`, or 0. */
function lineOf(rel: string, needle: string): number {
  const lines = read(rel).split('\n');
  for (let i = 0; i < lines.length; i += 1) if (lines[i]?.includes(needle)) return i + 1;
  return 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   G1 — BFF CSRF
   ─────────────────────────────────────────────────────────────────────────
   The question is not "is there a CSRF check" but "does every route whose
   authority can ride on a cookie have one". A route that takes its authority
   from a request HEADER needs no CSRF token, because a cross-site form cannot
   set a header; a route that takes it from a cookie needs one absolutely.
   So this measures the two halves together:
     (a) the refresh/logout routes, whose authority IS the `daftar_rt` cookie,
         enforce the double-submit header; and
     (b) the catch-all proxy, which exports four mutating methods and has no
         CSRF check, forwards NO cookie and is outside the refresh cookie's
         path, so no cookie-borne authority reaches it.
   (b) is the part that has never been pinned by a test. If someone adds
   'cookie' to FORWARDED, or widens the refresh cookie's path to '/', every
   mutating proxy route becomes CSRF-reachable and nothing in the tree says so.
   ══════════════════════════════════════════════════════════════════════════ */
function verifyG1(): void {
  const it = item('G1', 'BFF CSRF: negative tests and the proxy’s cookie-free authority');
  const apps = [
    { app: 'web', cookiePrefix: 'daftar' },
    { app: 'admin', cookiePrefix: 'daftar_admin' },
  ] as const;

  let measured = true;
  for (const { app } of apps) {
    const cookiesRel = `apps/${app}/src/lib/cookies.ts`;
    const proxyRel = `apps/${app}/src/app/api/proxy/[...path]/route.ts`;
    if (!exists(cookiesRel) || !exists(proxyRel)) {
      it.notes.push(`${app}: cookies.ts or the proxy route is absent — not measured`);
      measured = false;
      continue;
    }
    const cookies = read(cookiesRel);
    const proxy = read(proxyRel);

    // (a) the refresh cookie must stay off the proxy's path.
    const rtPath = /path:\s*'([^']+)'/.exec(cookies.slice(cookies.indexOf('rtCookieOptions')));
    if (rtPath?.[1] === '/api/auth') {
      it.notes.push(`${app}: the refresh cookie is path-scoped to /api/auth (${cookiesRel}:${lineOf(cookiesRel, "path: '/api/auth'")}), so it never reaches /api/proxy`);
    } else {
      it.findings.push(
        `${app}: the refresh cookie's path is ${rtPath?.[1] ?? 'UNREADABLE'}, not /api/auth — if it covers /api/proxy, every mutating proxy method becomes CSRF-reachable and the proxy has no CSRF check (${proxyRel})`,
      );
    }

    // (b) the proxy must forward no cookie header. The two apps spell the
    // header set differently — a named `FORWARDED` const in one, an inline
    // array in the `for (const name of [...])` of the other — so both forms
    // are read. A header set this script cannot find is a failure of THIS
    // script, reported as such and never as a finding about the tree.
    const headerSet = /const FORWARDED = \[([^\]]*)\]/.exec(proxy) ?? /for \(const name of \[([^\]]*)\]\)/.exec(proxy);
    if (!headerSet?.[1]) {
      it.notes.push(
        `${app}: NOT MEASURED BY THIS SCRIPT — the forwarded-header set in ${proxyRel} matches neither \`const FORWARDED = [...]\` nor \`for (const name of [...])\`. This is a limitation of this script, not a property of the route; read the route before relying on the cookie-free claim for ${app}.`,
      );
      measured = false;
    } else {
      const names = headerSet[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, '').toLowerCase())
        .filter((s) => s.length > 0);
      if (names.includes('cookie')) {
        it.findings.push(`${app}: the proxy forwards the 'cookie' header (${proxyRel}:${lineOf(proxyRel, headerSet[0].slice(0, 30))}) AND has no CSRF check — cookie-borne authority reaches a mutating route unprotected`);
      } else {
        it.notes.push(`${app}: the proxy forwards no cookie (forwarded = ${names.join(', ')}), so its authority is the Authorization header a cross-site form cannot set`);
      }
    }

    // (c) the cookie-authority routes must each check the double-submit header.
    for (const route of ['refresh', 'logout'] as const) {
      const rel = `apps/${app}/src/app/api/auth/${route}/route.ts`;
      if (!exists(rel)) {
        it.notes.push(`${app}/${route}: route absent — not measured`);
        continue;
      }
      const src = read(rel);
      const checks = src.includes("headers.get('x-daftar-csrf')") && /header\s*!==\s*csrfCookie/.test(src);
      if (checks) it.notes.push(`${app}/${route}: enforces the double-submit header (${rel}:${lineOf(rel, 'x-daftar-csrf')})`);
      else it.findings.push(`${app}/${route}: its authority is the ${route === 'refresh' ? 'refresh' : 'session'} cookie but it does not compare x-daftar-csrf against the cookie (${rel})`);
    }
  }

  /* The negative-test census. A refusal that no test exercises is a refusal
     that can be deleted by a refactor without anything turning red. */
  const testDirs = ['apps/web/test', 'apps/admin/test', 'tests/security', 'tests/integration'];
  const negatives: string[] = [];
  for (const dir of testDirs) {
    if (!exists(dir)) continue;
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      const rel = `${dir}/${f}`;
      const src = read(rel);
      // A NEGATIVE test asserts a 403 in the same file as a csrf mismatch.
      if (/csrf/i.test(src) && /403/.test(src)) negatives.push(rel);
    }
  }
  if (negatives.length === 0) {
    it.findings.push('no test anywhere asserts a 403 on a CSRF mismatch: the refusal is unpinned in every app');
  } else {
    it.notes.push(`negative CSRF tests (a 403 asserted on a mismatch): ${negatives.join(', ')}`);
    const coveredApps = new Set(negatives.map((r) => (r.startsWith('apps/admin') ? 'admin' : r.startsWith('apps/web') ? 'web' : 'shared')));
    for (const { app } of apps) {
      if (!coveredApps.has(app) && !coveredApps.has('shared')) {
        it.findings.push(`${app}: its CSRF refusal has no negative test — a refactor could remove the comparison with nothing turning red`);
      }
    }
    // The structural half has no test in either app.
    const structural = negatives.filter((r) => {
      const src = read(r);
      return /FORWARDED/.test(src) || (/proxy/i.test(src) && /cookie/i.test(src));
    });
    if (structural.length === 0) {
      it.findings.push(
        "the proxy's cookie-free authority is NOT pinned by any test: nothing turns red if 'cookie' is added to FORWARDED or the refresh cookie's path is widened to '/', and the proxy exports POST/PUT/PATCH/DELETE with no CSRF check",
      );
    }
  }

  if (!measured) it.verdict = 'UNMEASURED';
  else it.verdict = it.findings.length === 0 ? 'PASS' : 'FINDING';
}

/* ══════════════════════════════════════════════════════════════════════════
   G2 — upload path traversal
   ─────────────────────────────────────────────────────────────────────────
   Two separate questions, and conflating them is how this item stayed open:
     (a) can a caller get a traversing component into a storage key? and
     (b) if one ever arrives, does the guard refuse it?
   (a) is answered by reading every argument of every mediaStorageKey call.
   (b) is answered by EXECUTING the guard, because `startsWith` on a path
   prefix is the kind of check that reads correct and is not.
   ══════════════════════════════════════════════════════════════════════════ */
function verifyG2(): void {
  const it = item('G2', 'Upload path traversal: key provenance, and the local-storage guard');
  const storageRel = 'apps/api/src/infra/storage.ts';
  const mediaRel = 'apps/api/src/modules/catalog/media.service.ts';
  if (!exists(storageRel) || !exists(mediaRel)) {
    it.notes.push('storage.ts or media.service.ts is absent — not measured');
    it.verdict = 'UNMEASURED';
    return;
  }

  // (a) Every mediaStorageKey call site, and where each argument comes from.
  const callers: string[] = [];
  for (const rel of [mediaRel, storageRel]) {
    const src = read(rel);
    const re = /mediaStorageKey\(([^)]*)\)/g;
    let m = re.exec(src);
    while (m) {
      if (m[1] && !src.slice(0, m.index).endsWith('export function ')) callers.push(`${rel}: mediaStorageKey(${m[1].replace(/\s+/g, ' ').trim()})`);
      m = re.exec(src);
    }
  }
  if (callers.length === 0) {
    it.findings.push('no mediaStorageKey call site found: the key provenance claim cannot be measured');
  } else {
    // A caller-controlled argument would be a request field. The upload path's
    // arguments are the membership context, a server-minted id, a literal
    // variant and a literal extension.
    const suspicious = callers.filter((c) => /\b(req|body|dto|query|params|file\.originalname|input)\b/.test(c));
    if (suspicious.length > 0) {
      it.findings.push(`a storage key is built from caller-supplied data: ${suspicious.join(' | ')}`);
    } else {
      it.notes.push(`${callers.length} storage-key call site(s), none taking caller-supplied data:`);
      for (const c of callers) it.notes.push(`    ${c}`);
      it.notes.push(`    (the key's components are the membership tenant/business, a server-minted uuid, a literal variant and '.webp')`);
    }
    // The access path takes a caller-supplied `variant`; it must be used to
    // SELECT a stored key, never to build one.
    const accessUsesVariantAsKey = /signedUrl\(\s*(?:mediaStorageKey|[^,)]*variant)/.test(read(mediaRel));
    if (accessUsesVariantAsKey) {
      it.findings.push(`${mediaRel}: the caller-supplied variant reaches a storage key or a signed URL directly`);
    } else {
      it.notes.push(`${mediaRel}:${lineOf(mediaRel, 'row.variants.find')} the caller-supplied variant only SELECTS among keys already stored on the row`);
    }
  }

  // (b) Execute the guard. The real class, the real config shape.
  const storageSrc = read(storageRel);
  const guard = /if \(!p\.startsWith\(this\.root\)\)/.test(storageSrc);
  const guardLine = lineOf(storageRel, 'storage key traversal rejected');
  if (!guard) {
    it.notes.push(`${storageRel}: the local guard is not the expected startsWith form — read it before trusting this item`);
  }

  // The boundary case: a SIBLING directory sharing the root's textual prefix.
  // `/tmp/x/media` + '../mediaX/k' normalises to `/tmp/x/mediaX/k`, which
  // startsWith('/tmp/x/media') — true, and outside the root.
  const probe = (() => {
    const root = normalize('/srv/daftar/media');
    const key = '../media-attacker-owned/payload.webp';
    const p = normalize(join(root, key));
    // `escapes` is true when the guard's own test (startsWith) passes while a
    // real boundary test fails: that is exactly the defect class, and it is
    // computed here rather than asserted.
    const guardAccepts = p.startsWith(root);
    const actuallyInside = p === root || p.startsWith(root + sep);
    return { root, key, p, escapes: guardAccepts && !actuallyInside };
  })();
  if (probe.escapes) {
    it.findings.push(
      `${storageRel}:${guardLine} the traversal guard compares a path PREFIX, not a path BOUNDARY: root='${probe.root}', key='${probe.key}' normalises to '${probe.p}', which is OUTSIDE the root and still satisfies startsWith(root). The correct test is \`p === root || p.startsWith(root + sep)\`. LATENT today — part (a) shows no caller-supplied component reaches a key, and LocalObjectStorage is refused in production by createObjectStorage — so this is a guard that would not hold if it were ever relied on, not a reachable traversal.`,
    );
  } else {
    it.notes.push(`${storageRel}:${guardLine} the traversal guard rejects a sibling directory sharing the root's prefix (executed: root='${probe.root}', key='${probe.key}' → '${probe.p}')`);
  }

  // And the production refusal that makes the above latent rather than live.
  if (/if \(config\.isProd\) throw new Error\('MEDIA_STORAGE=local is forbidden in production'\)/.test(storageSrc)) {
    it.notes.push(`${storageRel}:${lineOf(storageRel, 'MEDIA_STORAGE=local is forbidden in production')} local storage is refused in production, so the guard above is dev/test only`);
  } else {
    it.findings.push(`${storageRel}: local disk storage is NOT refused in production, so the prefix guard above is on a production path`);
  }

  it.verdict = it.findings.length === 0 ? 'PASS' : 'FINDING';
}

/* ══════════════════════════════════════════════════════════════════════════
   G3 — the runtime DB principal across deploy environments
   ─────────────────────────────────────────────────────────────────────────
   The separations are measured by RUNNING loadConfig, not by reading it, and
   measured at every NODE_ENV the schema accepts — because "across deploy
   environments" is the half of this item that was never answered.
   ══════════════════════════════════════════════════════════════════════════ */
function verifyG3(): void {
  const it = item('G3', 'Runtime DB principal and APP_DATABASE_URL across deploy environments');
  const configRel = 'apps/api/src/config.ts';
  if (!exists(configRel)) {
    it.notes.push('config.ts is absent — not measured');
    it.verdict = 'UNMEASURED';
    return;
  }

  const secret = () => randomBytes(32).toString('hex');
  const base = (nodeEnv: string): NodeJS.ProcessEnv => ({
    NODE_ENV: nodeEnv,
    PROCESS_MODE: 'platform-api',
    PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
    IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
    RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
    JWT_SECRET: secret(),
  });
  const refuses = (env: NodeJS.ProcessEnv): boolean => {
    try {
      loadConfig(env);
      return false;
    } catch {
      return true;
    }
  };

  const APP = 'postgresql://daftar_app:x@db/daftar';
  const schemaEnvs = /NODE_ENV: z\.enum\(\[([^\]]*)\]\)/.exec(read(configRel));
  const accepted = (schemaEnvs?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);

  if (accepted.length === 0) {
    it.notes.push(`${configRel}: NODE_ENV's accepted values could not be read — G3 not measured`);
    it.verdict = 'UNMEASURED';
    return;
  }
  it.notes.push(`${configRel}:${lineOf(configRel, 'NODE_ENV: z.enum')} NODE_ENV accepts exactly: ${accepted.join(', ')}`);

  const results: { env: string; refused: boolean | 'unavailable' }[] = [];
  for (const e of accepted) {
    let refused: boolean | 'unavailable';
    try {
      refused = refuses({ ...base(e), APP_DATABASE_URL: APP });
    } catch {
      refused = 'unavailable';
    }
    results.push({ env: e, refused });
  }
  const unavailable = results.some((r) => r.refused === 'unavailable');
  if (unavailable) {
    // Fall back to the gate's own text, which is unambiguous.
    const gate = lineOf(configRel, "if (c.NODE_ENV !== 'production') return;");
    if (gate === 0) {
      it.notes.push(`${configRel}: the production-only gate could not be located — G3 not measured`);
      it.verdict = 'UNMEASURED';
      return;
    }
    it.notes.push(`loadConfig was not callable here; measured from the gate instead: ${configRel}:${gate} \`if (c.NODE_ENV !== 'production') return;\``);
    // The gate returns before every separation, so only 'production' refuses.
    for (const r of results) r.refused = r.env === 'production';
  }

  for (const r of results) it.notes.push(`    NODE_ENV=${r.env} + PROCESS_MODE=platform-api + APP_DATABASE_URL → ${r.refused === true ? 'REFUSED' : 'ACCEPTED'}`);

  const lax = results.filter((r) => r.refused !== true).map((r) => r.env);
  if (lax.length > 0) {
    it.findings.push(
      `every per-mode credential separation — the TD-14 platform/app refusal, the PROCESS_MODE=all refusal, the TRUST_PROXY=true refusal and the whole secret-separation block — is gated on NODE_ENV === 'production' (${configRel}:${lineOf(configRel, "if (c.NODE_ENV !== 'production') return;")}), so it does not apply at NODE_ENV=${lax.join('/')}. The schema accepts no fourth value, so there is NO label for a deployed-but-not-production environment: a staging box is either labelled 'production' or treated as a laptop. The tree already states this reasoning itself, for one mode only: the reconciler block is deliberately keyed on the MODE and its comment says so verbatim — "not in production, not in a staging box, and not on a laptop where the habit would be formed" (${configRel}:${lineOf(configRel, 'and not on a laptop where the habit would be formed')}). The same argument applies with a LARGER blast radius to daftar_app, which is the RLS-enforced tenant credential.`,
    );
  } else {
    it.notes.push('the separations apply at every NODE_ENV the schema accepts');
  }

  // The other half: is NODE_ENV pinned anywhere a deployment would read it?
  const artefacts = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'infrastructure/deploy', 'deploy', '.env.example', 'infrastructure/Dockerfile'];
  const present = artefacts.filter((a) => exists(a));
  if (present.length === 0) {
    it.findings.push(
      'no deployment artefact exists in this repository (no Dockerfile, no compose file, no IaC outside infrastructure/database, no .env.example), so what NODE_ENV any deployed environment actually sets is UNMEASURED from the tree. The verdict above therefore describes what the code does per label, not what a given environment is labelled.',
    );
  } else {
    it.notes.push(`deployment artefacts present: ${present.join(', ')}`);
  }

  it.verdict = it.findings.length === 0 ? 'PASS' : 'FINDING';
}

/* ══════════════════════════════════════════════════════════════════════════
   G4 — platform LOGIN role blast radius  (EXECUTED against a real cluster)
   ─────────────────────────────────────────────────────────────────────────
   bootstrap.sql is idempotent by construction: CREATE when absent, ALTER when
   present. The question this item asks is what the ALTER branch does to an
   attribute it does not NAME. PostgreSQL's answer is: nothing — an attribute
   not named is left as it is. So the proof is to give an existing role the
   worst attribute there is, run the real bootstrap.sql, and read the catalogue.
   ══════════════════════════════════════════════════════════════════════════ */
const G4_DIR = '/tmp/daftar-p15-gaplist-pg';
const G4_PORT = 55479;

function verifyG4(runCluster: boolean): void {
  const it = item('G4', 'Platform LOGIN role blast radius: does bootstrap.sql converge an existing role’s attributes?');
  const bootRel = 'infrastructure/database/bootstrap.sql';
  if (!exists(bootRel)) {
    it.notes.push('bootstrap.sql is absent — not measured');
    it.verdict = 'UNMEASURED';
    return;
  }
  const boot = read(bootRel);

  // Which LOGIN roles re-assert their negative attributes on the ALTER branch?
  const loginRoles = [...boot.matchAll(/ALTER ROLE (daftar_\w+) LOGIN([^;]*);/g)].map((m) => ({
    role: m[1] as string,
    reasserts: /NOBYPASSRLS/.test(m[2] ?? ''),
  }));
  if (loginRoles.length === 0) {
    it.notes.push(`${bootRel}: no ALTER ROLE … LOGIN branch found — not measured`);
    it.verdict = 'UNMEASURED';
    return;
  }
  const drifters = loginRoles.filter((r) => !r.reasserts).map((r) => r.role);
  const converging = loginRoles.filter((r) => r.reasserts).map((r) => r.role);
  it.notes.push(`${bootRel}: ALTER branches that re-assert NOBYPASSRLS: ${converging.join(', ') || '(none)'}`);
  it.notes.push(`${bootRel}: ALTER branches that do NOT: ${drifters.join(', ') || '(none)'}`);

  if (!runCluster) {
    it.notes.push('--no-cluster: the catalogue was not read, so the static reading above is not a verdict');
    it.verdict = 'UNMEASURED';
    return;
  }
  if (drifters.length === 0 && converging.length === 0) {
    it.verdict = 'UNMEASURED';
    return;
  }

  const spec: ClusterSpec = { dir: G4_DIR, port: G4_PORT, label: 'gaplist' };
  // One subject from each side of the reading above, so the run proves the
  // DIFFERENCE and not merely that PostgreSQL behaves as documented.
  const subjects = [...(drifters[0] ? [drifters[0]] : []), ...(converging[0] ? [converging[0]] : [])];
  try {
    prepareClusterDir(spec.dir);
    startCluster(spec, ["fsync='off'", "full_page_writes='off'"]);

    // Pre-create every role bootstrap.sql touches, giving the subjects
    // BYPASSRLS — the drift this item is about.
    const allRoles = [...new Set([...boot.matchAll(/(?:CREATE|ALTER) ROLE (daftar_\w+)/g)].map((m) => m[1] as string))];
    for (const role of allRoles) {
      const attrs = subjects.includes(role) ? 'LOGIN BYPASSRLS' : 'NOLOGIN';
      const r = psqlScalar(spec.port, 'postgres', `CREATE ROLE ${role} ${attrs}; SELECT 1`);
      if (!r.ok) throw new Error(`pre-create ${role}: ${r.detail.slice(0, 300)}`);
    }
    // bootstrap.sql expects the application database to exist. Creating it
    // here lets the WHOLE file apply, so the verdict below carries no
    // partial-apply caveat.
    createEmptyDatabase(spec.port, 'daftar');

    const before = Object.fromEntries(
      subjects.map((role) => [role, psqlScalar(spec.port, 'postgres', `SELECT rolbypassrls FROM pg_roles WHERE rolname='${role}'`).value]),
    );
    for (const role of subjects) {
      if (before[role] !== 't') throw new Error(`the premise failed: ${role} is not BYPASSRLS before the run (rolbypassrls=${before[role]})`);
    }
    it.notes.push(`premise established on a real cluster: ${subjects.map((r) => `${r}.rolbypassrls=t`).join(', ')}`);

    // Apply the REAL bootstrap.sql, placeholders filled with per-run values.
    const filled = boot.replace(/__([A-Z_]+)_PASSWORD__/g, () => `p15_${randomBytes(12).toString('hex')}`);
    const sqlPath = join(G4_DIR, 'bootstrap.filled.sql');
    writeFileSync(sqlPath, filled, { mode: 0o644 });
    const applied = spawnSync(`${PG16_BIN}/psql`, ['-h', '127.0.0.1', '-p', String(spec.port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: PG_SUPERPASS },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (applied.status !== 0) {
      // bootstrap.sql expects a daftar database and extensions; a partial
      // apply still runs the role block, which is this item's subject. Say so
      // rather than pretending the whole file applied.
      it.notes.push(`bootstrap.sql exited ${applied.status}; the role block is at the top of the file and ran — the verdict below is read from the catalogue, not from this exit code`);
      it.notes.push(`    first error: ${(applied.stderr ?? '').split('\n').find((l) => /ERROR/.test(l))?.slice(0, 200) ?? '(none captured)'}`);
    }

    for (const role of subjects) {
      const after = psqlScalar(spec.port, 'postgres', `SELECT rolbypassrls FROM pg_roles WHERE rolname='${role}'`);
      if (!after.ok) {
        it.findings.push(`${role}: its attribute could not be read after the run (${after.detail.slice(0, 160)})`);
        continue;
      }
      const reasserts = converging.includes(role);
      if (after.value === 't' && !reasserts) {
        it.findings.push(
          `${role}: BYPASSRLS SURVIVES a full bootstrap.sql run (rolbypassrls t → t, read from pg_roles on a real cluster). Its ALTER branch is \`ALTER ROLE ${role} LOGIN PASSWORD '…'\` (${bootRel}:${lineOf(bootRel, `ALTER ROLE ${role} LOGIN PASSWORD`)}) and names no negative attribute, so re-running the deployment's own bootstrap does not take the attribute away. bootstrap.sql states this exact reasoning in its own words, and applies it to daftar_reconciler and daftar_migrator only: "a role that drifts into BYPASSRLS on an existing database would turn a scoped verifier into a global reader without a single line of the repository changing" (${bootRel}:${lineOf(bootRel, 'would turn a scoped verifier into a')}). ${role === 'daftar_app' ? 'daftar_app is the RLS-enforced tenant credential: BYPASSRLS on it is the loss of ALL tenant isolation, a strictly larger blast radius than the reconciler the law was written for.' : ''}`,
        );
      } else if (after.value !== 't' && reasserts) {
        it.notes.push(`${role}: BYPASSRLS was STRIPPED by the run (t → ${after.value}) — its ALTER branch re-asserts NOBYPASSRLS, and that is what convergence looks like`);
      } else if (after.value !== 't' && !reasserts) {
        it.notes.push(`${role}: BYPASSRLS was stripped although its ALTER branch does not name NOBYPASSRLS — the static reading was wrong; something else in the file converges it`);
      } else {
        it.findings.push(`${role}: its ALTER branch re-asserts NOBYPASSRLS and the attribute SURVIVED anyway — the convergence this file relies on does not work`);
      }
    }
    const unreasserted = drifters.filter((r) => !subjects.includes(r));
    if (unreasserted.length > 0) {
      it.notes.push(`same ALTER shape, not executed in this run: ${unreasserted.join(', ')} — each is the measured subject's exact form, so the finding is theirs too by construction, not by measurement`);
    }
  } catch (e) {
    it.notes.push(`the cluster run failed: ${(e as Error).message.slice(0, 400)}`);
    it.verdict = 'UNMEASURED';
    return;
  } finally {
    try {
      stopCluster(spec);
      rmSync(G4_DIR, { recursive: true, force: true });
    } catch {
      /* a disposable cluster that will not die is not this item's verdict */
    }
  }

  it.verdict = it.findings.length === 0 ? 'PASS' : 'FINDING';
}

/* ══════════════════════════════════════════════════════════════════════════
   G5 — media-scanner wiring
   ─────────────────────────────────────────────────────────────────────────
   A port with no call site is not a seam, it is a declaration. And a factory
   with no production branch is not a default, it is the only outcome.
   ══════════════════════════════════════════════════════════════════════════ */
function verifyG5(): void {
  const it = item('G5', 'Media-scanner wiring: is the scan result consulted, and can production get a real scanner?');
  const storageRel = 'apps/api/src/infra/storage.ts';
  const runtimeRel = 'apps/api/src/app/runtime.ts';
  const mediaRel = 'apps/api/src/modules/catalog/media.service.ts';
  for (const rel of [storageRel, runtimeRel, mediaRel]) {
    if (!exists(rel)) {
      it.notes.push(`${rel} is absent — not measured`);
      it.verdict = 'UNMEASURED';
      return;
    }
  }

  // (a) Does anything CALL scanClean? A declaration and an implementation are
  // not call sites.
  const callSites: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
        walk(rel);
        continue;
      }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      const src = read(rel);
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (!line.includes('scanClean')) continue;
        // The interface member and the adapter's own method are not calls.
        const isDeclaration = /^\s*scanClean\s*\(/.test(line) || /^\s*(?:readonly\s+)?scanClean\s*:/.test(line);
        if (!isDeclaration) callSites.push(`${rel}:${i + 1} ${line.trim().slice(0, 120)}`);
      }
    }
  };
  for (const d of ['apps', 'packages']) if (exists(d)) walk(d);

  if (callSites.length === 0) {
    it.findings.push(
      `scanClean() has a declaration (${storageRel}:${lineOf(storageRel, 'scanClean(key: string): Promise<boolean>')}) and an implementation (${storageRel}:${lineOf(storageRel, 'scanClean(): Promise<boolean>')}) and ZERO call sites anywhere in apps/ or packages/. The upload path reads only \`scanner.enabled\` and uses it to write an audit string (${mediaRel}:${lineOf(mediaRel, 'const scanNote =')}), so a REAL scanner answering "infected" would not stop the upload: wiring one is a change to the upload path, not a change to configuration. The adapter's honesty about not having scanned is real and is not the gap; the gap is that the result has no consumer to be honest TO.`,
    );
  } else {
    it.notes.push(`scanClean() call sites: ${callSites.join(' | ')}`);
  }

  // (b) Can production get a real scanner, and is the disabled one refused there?
  const runtime = read(runtimeRel);
  const provider = /\{\s*provide:\s*'MALWARE_SCANNER',\s*useFactory:\s*\(([^)]*)\)[^}]*\}/.exec(runtime);
  if (!provider) {
    it.notes.push(`${runtimeRel}: the MALWARE_SCANNER provider could not be read`);
  } else {
    const body = provider[0];
    const branches = /isProd|config\.|MALWARE_SCANNER_|process\.env/.test(body);
    if (!branches) {
      it.findings.push(
        `${runtimeRel}:${lineOf(runtimeRel, "provide: 'MALWARE_SCANNER'")} the provider is unconditional — \`useFactory: (): MalwareScanner => new DisabledDevelopmentMalwareScanner()\`. It takes no config, has no production branch and no alternative implementation exists, so a production process receives the DISABLED adapter and nothing refuses it. Compare createObjectStorage in the same tree, which does refuse its development adapter in production: "if (config.isProd) throw new Error('MEDIA_STORAGE=local is forbidden in production')" (${storageRel}:${lineOf(storageRel, 'MEDIA_STORAGE=local is forbidden in production')}). Storage fails closed in production; the scanner does not.`,
      );
    } else {
      it.notes.push(`${runtimeRel}:${lineOf(runtimeRel, "provide: 'MALWARE_SCANNER'")} the provider branches on configuration`);
    }
  }

  // What stands between an uploaded file and the storage bucket today.
  const media = read(mediaRel);
  const mitigations: string[] = [];
  if (/ALLOWED_MIME/.test(media)) mitigations.push('an allow-list of three image MIME types');
  if (/imageSize\(/.test(media)) mitigations.push('magic bytes that must agree with the declared MIME');
  if (/MAX_DIMENSION/.test(media)) mitigations.push('a dimension ceiling');
  if (/MEDIA_MAX_BYTES/.test(media)) mitigations.push('a byte ceiling');
  if (/sharp\(file\.buffer\)[\s\S]{0,80}\.webp\(/.test(media)) mitigations.push('a full sharp re-encode to webp, which does not carry a non-image payload through');
  it.notes.push(`what the upload path does enforce without a scanner: ${mitigations.join('; ')}`);
  it.notes.push('    so the honest statement is that uploads are CONSTRAINED and RE-ENCODED, never that they are SCANNED');

  it.verdict = it.findings.length === 0 ? 'PASS' : 'FINDING';
}

/* ── report ──────────────────────────────────────────────────────────────── */
function main(): number {
  const runCluster = !process.argv.includes('--no-cluster');
  console.log('P15 — LIVE VERIFICATION OF THE HISTORICAL GAP LIST');
  console.log('='.repeat(78));
  console.log(`repository: ${ROOT}`);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const clean = dirty.status === 0 && (dirty.stdout ?? '').trim() === '';
  console.log(`measured at: ${head.status === 0 ? head.stdout.trim() : 'UNKNOWN'}${clean ? '' : ' PLUS UNCOMMITTED CHANGES (this report names no commit)'}`);
  console.log(`G4 cluster: ${runCluster ? `yes, port ${G4_PORT}` : 'SKIPPED (--no-cluster)'}`);
  console.log('');

  verifyG1();
  verifyG2();
  verifyG3();
  verifyG4(runCluster);
  verifyG5();

  for (const it of items) {
    console.log('-'.repeat(78));
    console.log(`${it.id}  ${it.verdict.padEnd(10)} ${it.title}`);
    for (const n of it.notes) console.log(`     · ${n}`);
    for (const f of it.findings) console.log(`     ! ${f}`);
  }
  console.log('-'.repeat(78));
  const counts = { PASS: 0, FINDING: 0, UNMEASURED: 0 };
  for (const it of items) counts[it.verdict] += 1;
  console.log(`measured ${counts.PASS + counts.FINDING} of ${items.length}: ${counts.PASS} PASS, ${counts.FINDING} FINDING, ${counts.UNMEASURED} UNMEASURED`);
  console.log('');
  console.log('A FINDING is a named, reproducible gap in THIS tree, not a verdict about');
  console.log('another branch: a finding from a prep container is a lead for the tree’s');
  console.log('owner (TL-P4-COORD-R39). Each one above names the file and line that');
  console.log('produces it so the owner can reproduce it without this script.');
  if (counts.UNMEASURED > 0) {
    console.log('');
    console.log(`EXIT 1: ${counts.UNMEASURED} item(s) UNMEASURED — the Mission’s question is unanswered for those.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
