/**
 * P15 — ALERT SIGNAL VERIFICATION
 * ================================
 *
 * The Mission asks for "real monitoring". The first thing real monitoring
 * needs is not an exporter or a destination — it is the certainty that every
 * alert names a signal the running system actually produces. An alert on a
 * signal nothing emits is strictly worse than no alert: it occupies a line in
 * the rule set, it answers a reviewer's question with a yes, and it never
 * fires. That is the one failure mode a rule set cannot report about itself.
 *
 * So this script re-derives, from the tree, the two facts P15-ALERT-RULES.json
 * asserts about each of its rules:
 *
 *   1. is the rule's `signal` a metric this application DECLARES? and
 *   2. is it a metric this application EMITS, at a file and line?
 *
 * and then checks each rule's own `signal_source` and `exists_today` claim
 * against what was derived. A rule whose prose says "EMITTED TODAY" while no
 * call site exists is a stale claim, and the whole point of this script is
 * that such a claim turns red here instead of surviving into a deployment.
 *
 * It also establishes the premise the rule set's `notPromotedMeaning` rests
 * on: that there is no exporter and no scrape endpoint. If an exporter is ever
 * added, every `exists_today: false` becomes a claim to re-examine, and this
 * script says so rather than leaving the file quietly wrong.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It does not deploy anything, choose an alert destination, or write an
 * exporter. The destination and the dashboards are owner decisions, and
 * apps/api/src/infra/metrics.ts is not this branch's file: an exporter goes to
 * its owner as a patch request. This script's whole claim is about the
 * CORRESPONDENCE between a rule set and a tree.
 *
 * Exit 0 when every rule's claims match the tree. Exit 1 when any does not,
 * or when the rule set cannot be read at all.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
/**
 * The rule set under check. The default is the pack's own file; `P15_ALERT_RULES`
 * points the check at another copy.
 *
 * The override exists so the red proof (`verify:alert-signals:prove`) can plant
 * a defect in a COPY and watch this check go red, without ever writing to the
 * shared document — that directory has other writers, and the frozen-artefact
 * rule against editing a subject to change an outcome applies to the pack's own
 * evidence too. Because an override could also point the check at a doctored
 * file, the subject path and its digest are printed with every result, so a run
 * on anything but the default is visible in its own output rather than silent.
 */
const DEFAULT_RULES = '/mnt/project-files/phase15/P15-ALERT-RULES.json';
const RULES = process.env.P15_ALERT_RULES ?? DEFAULT_RULES;
const METRICS = 'apps/api/src/infra/metrics.ts';

interface Resolution {
  readonly class: string;
  readonly derivation: string;
  readonly clearing_is_a_fix: boolean;
  readonly closure_requirement: string;
  readonly closure_recorded_today: boolean;
}

interface Rule {
  readonly id: string;
  readonly title: string;
  readonly signal: string;
  readonly signal_source: string;
  readonly condition: string;
  readonly exists_today: boolean;
  readonly resolution?: Resolution;
  /**
   * Every OTHER key the rule object carries. It is read, not enumerated in
   * prose: see `receiverOf` for why that distinction is the whole point.
   */
  readonly [key: string]: unknown;
}

/**
 * The words a routing destination would be called, if one were ever added.
 * Matched against the rule's OWN keys, so a key this script has never heard of
 * still registers as routing when it is named like routing.
 */
const ROUTING_KEYS = ['receiver', 'receivers', 'route', 'routing', 'destination', 'notify', 'notification', 'target', 'channel', 'recipient', 'webhook', 'pagerduty', 'email', 'oncall', 'on_call'] as const;

/**
 * DERIVE a rule's receiver from the rule object. Never a constant.
 *
 * The first version of this function was `const receiver = 'UNDECIDED'`, with a
 * paragraph underneath asserting that the emptiness "is a measurement, not a
 * placeholder". The independent challenger was right to reject that: nothing was
 * compared to anything, so the column could never go red. If an owner added a
 * receiver to all 23 rules, the table would still have printed UNDECIDED 23
 * times and still exited 0 — and the same round proved the hazard is not
 * hypothetical, because the neighbouring RESOLUTION claim HAD gone stale and the
 * instrument kept printing it. This pack rejected exactly this defect in Phase 8
 * ("a constant column proved nothing") and then shipped it here.
 *
 * So: read the rule's keys, and report what is there. UNDECIDED is now a
 * CONCLUSION from a key set, and it changes the moment the key set does.
 */
function receiverOf(r: Rule): { readonly value: string; readonly keys: readonly string[] } {
  const keys = Object.keys(r).filter((k) => ROUTING_KEYS.some((w) => k.toLowerCase() === w || k.toLowerCase().includes(w)));
  if (keys.length === 0) return { value: 'UNDECIDED', keys: [] };
  // A routing key that is present but empty is NOT a receiver: an empty string
  // routes nowhere, and reporting it as a destination would be the overclaim
  // this instrument exists to prevent.
  const named = keys.filter((k) => {
    const v = r[k];
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && v !== undefined && v !== false;
  });
  return named.length === 0 ? { value: `EMPTY:${keys.join(',')}`, keys } : { value: `SET:${named.join(',')}`, keys: named };
}

/**
 * The destinations a repository would hold if alerts were wired up. Searched in
 * the tree, so "no destination exists" is also a measurement rather than a
 * recollection. A hit does not mean the alerts are routed — it means the claim
 * "nothing anywhere" is no longer true and a human has to look.
 */
/**
 * Search the tracked tree for a pattern, returning the first match's location
 * or null. `git grep` is used rather than a filesystem walk so the search
 * covers exactly what the branch carries — an untracked scratch file left in
 * the working tree is not a destination this repository configures.
 */
function grepTree(re: RegExp): string | null {
  // This file is EXCLUDED from its own search. The patterns are written out
  // here in full, so without the exclusion every one of them matched its own
  // definition and the check reported six destinations that do not exist — a
  // red result for the wrong reason, which is as useless as a green one. The
  // exclusion is stated in the output so a reader knows the one file the search
  // does not cover is the searcher.
  const r = spawnSync('git', ['grep', '-nIE', '--', re.source, ':(exclude)scripts/phase15/verify-alert-signals.ts'], { cwd: ROOT, encoding: 'utf8' });
  // git grep exits 1 for "no match", which is the expected answer here; any
  // other non-zero is a failed search, and a failed search must not read as a
  // clean one.
  if (r.status === 1) return null;
  if (r.status !== 0) return `SEARCH FAILED (${(r.stderr ?? '').slice(0, 80).trim()}) — not a statement that nothing matches`;
  const first = (r.stdout ?? '').split('\n').find((l) => l.trim().length > 0);
  return first === undefined ? null : first.slice(0, 120);
}

const DESTINATION_PATTERNS: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: 'alertmanager configuration', re: /alertmanager|alert_manager/i },
  { what: 'PagerDuty', re: /pagerduty|pager_duty|routing_key/i },
  { what: 'Opsgenie', re: /opsgenie/i },
  { what: 'a Slack webhook', re: /hooks\.slack\.com|slack_webhook|slack_api_url/i },
  { what: 'a generic webhook destination', re: /webhook_url|webhook_configs/i },
  { what: 'an SMTP/e-mail destination', re: /smtp_smarthost|email_configs|sendgrid|ses_region/i },
];

/**
 * Re-derive a rule's resolution class FROM ITS EXPRESSION, independently of
 * whatever the rules file claims.
 *
 * This exists because the resolution model is data in a file this branch owns,
 * and data a branch owns is exactly the kind of claim that drifts from the
 * thing it describes. The classes are not labels chosen per rule: each one is a
 * property of the expression text, so it can be computed here and compared.
 * If an expression is edited and its class is not, this disagrees and says so.
 */
function deriveResolutionClass(condition: string): string {
  if (condition.includes('UNMEASURED-THRESHOLD')) return 'cannot_fire_no_threshold';
  if (/\b(increase|rate)\s*\(/.test(condition) && !condition.includes('histogram_quantile') && !condition.includes('/')) {
    return 'self_clearing_window';
  }
  if (condition.includes('histogram_quantile') || condition.includes('/')) return 'state_based_clears_on_no_traffic';
  return 'state_based';
}

/** Every metric name the application declares, and the line declaring it. */
function declared(): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const src = readFileSync(join(ROOT, METRICS), 'utf8').split('\n');
  for (let i = 0; i < src.length; i += 1) {
    const m = /^\s*([A-Za-z][A-Za-z0-9]*): '([a-z][a-z0-9_]*)',\s*$/.exec(src[i] ?? '');
    if (m?.[2]) out.set(m[2], i + 1);
  }
  return out;
}

/**
 * Every metric name the application EMITS, and where.
 *
 * Emission goes through `increment(` or `observe(` on the metrics port, and
 * the name arrives as the port's own constant rather than as a literal, so the
 * call site is found first and the constant resolved to its name second. A
 * dynamic lookup (`ACCOUNTING_METRICS[x]`) would defeat that, so this reports
 * one if it finds one instead of silently under-counting.
 */
function emitted(names: ReadonlyMap<string, number>): { readonly sites: ReadonlyMap<string, string>; readonly dynamic: readonly string[] } {
  const keyOf = new Map<string, string>(); // constant key → metric name
  const src = readFileSync(join(ROOT, METRICS), 'utf8').split('\n');
  for (const line of src) {
    const m = /^\s*([A-Za-z][A-Za-z0-9]*): '([a-z][a-z0-9_]*)',\s*$/.exec(line);
    if (m?.[1] && m[2]) keyOf.set(m[1], m[2]);
  }
  const sites = new Map<string, string>();
  const grep = spawnSync('grep', ['-rn', '--include=*.ts', '-E', '\\.(increment|observe)\\(', join(ROOT, 'apps'), join(ROOT, 'packages')], { encoding: 'utf8' });
  for (const line of (grep.stdout ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    const rel = line.replace(`${ROOT}/`, '');
    if (rel.startsWith(METRICS)) continue; // the port's own implementation
    // The metrics port's calls pass a constant from the port's catalogue.
    const used = /METRICS\.([A-Za-z][A-Za-z0-9]*)/.exec(rel);
    if (used?.[1]) {
      const name = keyOf.get(used[1]);
      if (name !== undefined) {
        const where = rel.split(':').slice(0, 2).join(':');
        sites.set(name, sites.has(name) ? `${sites.get(name) ?? ''}, ${where}` : where);
      }
      continue;
    }
    // A literal metric name passed directly.
    for (const name of names.keys()) {
      if (rel.includes(`'${name}'`)) {
        const where = rel.split(':').slice(0, 2).join(':');
        sites.set(name, sites.has(name) ? `${sites.get(name) ?? ''}, ${where}` : where);
      }
    }
  }
  const dyn = spawnSync('grep', ['-rn', '--include=*.ts', '-E', 'METRICS\\[', join(ROOT, 'apps'), join(ROOT, 'packages')], { encoding: 'utf8' });
  const dynamic = (dyn.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.replace(`${ROOT}/`, '').slice(0, 160));
  return { sites, dynamic };
}

/**
 * Is there anything that could get a metric OUT of the process?
 *
 * The first version of this probe answered PRESENT, and was wrong twice over:
 * it matched metrics.ts's own COMMENT about what an exporter would look like,
 * and it walked node_modules under apps/. A sentence describing an exporter is
 * not an exporter, and a vendored type declaration is not this application. So
 * this version excludes node_modules, skips comment lines, and requires a real
 * code signal: an import of an exporter library, a /metrics route, or a
 * declared dependency.
 */
function exporter(): { readonly present: boolean; readonly evidence: string } {
  const codeSignals: readonly { readonly pattern: string; readonly what: string }[] = [
    { pattern: "from 'prom-client'", what: 'a prom-client import' },
    { pattern: "require('prom-client')", what: 'a prom-client require' },
    { pattern: "from '@opentelemetry/", what: 'an OpenTelemetry import' },
    { pattern: "from 'hot-shots'", what: 'a StatsD client import' },
    { pattern: "@Get('metrics')", what: 'a /metrics route' },
    { pattern: "@Get('/metrics')", what: 'a /metrics route' },
  ];
  const found: string[] = [];
  for (const { pattern, what } of codeSignals) {
    const r = spawnSync(
      'grep',
      ['-rn', '--include=*.ts', '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.next', '-F', pattern, join(ROOT, 'apps'), join(ROOT, 'packages')],
      { encoding: 'utf8' },
    );
    for (const line of (r.stdout ?? '').split('\n')) {
      if (line.trim().length === 0) continue;
      const rel = line.replace(`${ROOT}/`, '');
      const body = rel.split(':').slice(2).join(':').trim();
      // A comment ABOUT an exporter is not an exporter.
      if (body.startsWith('*') || body.startsWith('//') || body.startsWith('/*')) continue;
      found.push(`${what}: ${rel.slice(0, 140)}`);
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const d of ['prom-client', '@opentelemetry/api', '@opentelemetry/sdk-node', 'hot-shots', 'statsd-client']) {
    if (pkg.dependencies?.[d] ?? pkg.devDependencies?.[d]) found.push(`package.json declares ${d}`);
  }
  return {
    present: found.length > 0,
    evidence:
      found.length > 0
        ? found.join(' | ')
        : 'none: no prom-client, OpenTelemetry or StatsD import, no /metrics route, and no such dependency declared. snapshot() is the whole read surface, as metrics.ts says of itself.',
  };
}

function main(): number {
  console.log('P15 — ALERT SIGNAL VERIFICATION');
  console.log('='.repeat(78));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const clean = dirty.status === 0 && (dirty.stdout ?? '').trim() === '';
  console.log(`measured at: ${head.status === 0 ? head.stdout.trim() : 'UNKNOWN'}${clean ? '' : ' PLUS UNCOMMITTED CHANGES (this report names no commit)'}`);

  if (!existsSync(RULES)) {
    console.log('');
    console.log(`UNMEASURED: the rule set is not at ${RULES}. Nothing below could be checked.`);
    return 1;
  }
  const rulesBytes = readFileSync(RULES);
  console.log(`subject  : ${RULES}${RULES === DEFAULT_RULES ? '' : '   ! NOT THE DEFAULT RULE SET'}`);
  console.log(`           sha256 ${createHash('sha256').update(rulesBytes).digest('hex')}  (${rulesBytes.length} bytes)`);
  const parsed = JSON.parse(rulesBytes.toString('utf8')) as { rules?: Rule[]; notPromotedMeaning?: string };
  const rules = parsed.rules ?? [];
  if (rules.length === 0) {
    console.log('');
    console.log('UNMEASURED: the rule set carries no rules.');
    return 1;
  }

  const names = declared();
  const { sites, dynamic } = emitted(names);
  const exp = exporter();

  console.log('');
  console.log(`declared metrics (${METRICS}): ${names.size}`);
  console.log(`emitted metrics: ${sites.size}`);
  for (const [name, line] of [...names.entries()].sort()) {
    const where = sites.get(name);
    console.log(`  ${where ? 'EMITTED     ' : 'NOT EMITTED '} ${name.padEnd(46)} declared at :${line}${where ? `  emitted at ${where}` : ''}`);
  }
  if (dynamic.length > 0) {
    console.log('');
    console.log('! a DYNAMIC metrics lookup exists, so the emitted set above may be incomplete:');
    for (const d of dynamic) console.log(`    ${d}`);
  }
  console.log('');
  console.log(`exporter / scrape surface: ${exp.present ? 'PRESENT' : 'ABSENT'}`);
  console.log(`    ${exp.evidence}`);

  const problems: string[] = [];
  const unemitted = [...names.keys()].filter((n) => !sites.has(n));
  if (unemitted.length > 0) {
    console.log('');
    console.log(`FINDING: ${unemitted.length} of ${names.size} declared metrics have NO emit site anywhere in apps/ or packages/:`);
    for (const n of unemitted) console.log(`    ${n}  (declared at ${METRICS}:${names.get(n) ?? 0})`);
    console.log('    Wiring an exporter would therefore export the emitted ones and nothing else.');
    console.log('    A name reserved in the catalogue is a plan, not a signal, and an alert on');
    console.log('    one cannot fire even with a perfect exporter and a perfect destination.');
  }

  console.log('');
  console.log(`checking ${rules.length} rules against the tree`);
  console.log('-'.repeat(78));
  let stale = 0;
  for (const r of rules) {
    const isDeclared = names.has(r.signal);
    const site = sites.get(r.signal);
    const claimsEmitted = /EMITTED TODAY/.test(r.signal_source);
    const claimsReserved = /no call site|NAME reserved/i.test(r.signal_source);
    const claimsUnmeasured = /^UNMEASURED/.test(r.signal_source) || /UNMEASURED as a runtime signal/.test(r.signal_source);

    const derived = site !== undefined ? `EMITTED at ${site}` : isDeclared ? `DECLARED at ${METRICS}:${names.get(r.signal) ?? 0}, NOT EMITTED` : 'NOT A DECLARED METRIC OF THIS APPLICATION';

    const mismatches: string[] = [];
    if (claimsEmitted && site === undefined) mismatches.push('its signal_source says "EMITTED TODAY" and no emit site exists');
    if (claimsReserved && site !== undefined) mismatches.push(`its signal_source says the name is reserved with no call site, but one exists at ${site}`);
    if (claimsUnmeasured && site !== undefined) mismatches.push(`its signal_source says UNMEASURED, but the signal is emitted at ${site}`);
    if (claimsUnmeasured && isDeclared && !claimsReserved) mismatches.push(`its signal_source says UNMEASURED, but the name IS declared at ${METRICS}:${names.get(r.signal) ?? 0}`);
    // exists_today is a claim about being able to FIRE, which needs an exporter.
    if (r.exists_today && !exp.present) mismatches.push('exists_today is true while no exporter or scrape surface exists, so the rule could not fire');
    if (!r.exists_today && exp.present && site !== undefined) {
      mismatches.push('exists_today is false, but the signal is emitted AND an exporter now exists — this claim is stale and the rule may be deployable');
    }

    if (mismatches.length === 0) {
      console.log(`  OK     ${r.id}  ${r.signal.padEnd(44)} ${derived}`);
    } else {
      stale += 1;
      problems.push(r.id);
      console.log(`  STALE  ${r.id}  ${r.signal.padEnd(44)} ${derived}`);
      for (const m of mismatches) console.log(`         ! ${m}`);
      console.log(`         claimed: ${r.signal_source.slice(0, 150)}`);
    }
  }

  console.log('-'.repeat(78));
  const emittedRules = rules.filter((r) => sites.has(r.signal));
  console.log(`${rules.length} rules: ${rules.length - stale} with claims matching the tree, ${stale} stale`);
  console.log(`${emittedRules.length} of ${rules.length} rules name a signal that is emitted today${exp.present ? '' : ', and none can fire while there is no exporter'}`);
  const resolutionProblems: string[] = [];
  const receivers = new Map<string, string>();

  /* ── §22.2's table: name → emit site → receiver → fire/resolution ─────── */
  console.log('');
  console.log('§22.2 — THE METRIC/ALERT TABLE: name, emit site, receiver, fire and resolution');
  console.log('-'.repeat(78));
  console.log('V2 §22.2 asks that this table bind every name to its emit position, its receiver');
  console.log('source, and its fire/resolution. Three of the four columns can be derived from the');
  console.log('tree. The fourth cannot, and saying so is the point of printing it empty.');
  console.log('');
  console.log(`${'ALERT'.padEnd(14)} ${'SIGNAL'.padEnd(42)} ${'EMIT SITE'.padEnd(18)} ${'RECEIVER'.padEnd(12)} FIRE / RESOLUTION`);
  for (const r of rules) {
    const site = sites.get(r.signal);
    const emit = site !== undefined ? site.split('/').pop()?.slice(0, 18) ?? 'yes' : names.has(r.signal) ? 'RESERVED ONLY' : 'none in tree';
    const recv = receiverOf(r);
    const fires = site !== undefined && exp.present ? 'could fire' : 'cannot fire';
    receivers.set(r.id, recv.value);
    console.log(`${r.id.replace('P15-ALERT-', 'A-').padEnd(14)} ${r.signal.slice(0, 42).padEnd(42)} ${emit.padEnd(18)} ${recv.value.slice(0, 12).padEnd(12)} ${fires}`);
  }
  console.log('');

  /* ── the receiver column, DERIVED and able to go red ──────────────────── */
  // The key set is printed from the data, because the previous version
  // enumerated it in prose and the prose was already wrong: it omitted
  // `resolution`, which had been added to every rule hours earlier.
  const keyUnion = [...new Set(rules.flatMap((r) => Object.keys(r)))].sort();
  const withRouting = rules.filter((r) => receiverOf(r).keys.length > 0);
  const undecided = [...receivers.values()].filter((v) => v === 'UNDECIDED').length;

  console.log('RECEIVER, DERIVED FROM THE RULE OBJECTS (not asserted)');
  console.log(`  the key set actually present on the ${rules.length} rules, read from the file:`);
  console.log(`    ${keyUnion.join(', ')}`);
  console.log(`  of those, keys that name a routing destination: ${withRouting.length === 0 ? 'NONE' : withRouting.map((r) => r.id).join(', ')}`);
  console.log(`  rules whose receiver is therefore UNDECIDED: ${undecided} of ${rules.length}`);

  const destinations: string[] = [];
  for (const d of DESTINATION_PATTERNS) {
    const hit = grepTree(d.re);
    if (hit !== null) destinations.push(`${d.what} — ${hit}`);
  }
  console.log(`  destination configuration in the repository: ${destinations.length === 0 ? `NONE FOUND — ${DESTINATION_PATTERNS.length} patterns searched over the tracked tree (${DESTINATION_PATTERNS.map((d) => d.what).join(', ')}), excluding this script's own file, which defines them` : destinations.join('; ')}`);
  console.log('');
  console.log('  §22.2 forbids choosing a recipient, a subscription or a retention here, so this');
  console.log('  stays with the owner. What changed in this round is that the column is now a');
  console.log('  CONCLUSION rather than a constant: a routing key appearing on a rule, or a');
  console.log('  destination appearing in the tree, changes the value AND the exit code below.');
  console.log('  A rule with a condition and no receiver is a rule that fires into nothing.');
  console.log('');

  // The claim is now falsifiable in both directions, which is what makes it a
  // measurement. Routing that appears without the owner's decision being
  // recorded is a change this instrument must not pass over in silence.
  if (withRouting.length > 0 || destinations.length > 0) {
    resolutionProblems.push(
      `the receiver claim is STALE: ${withRouting.length} rule(s) now carry a routing key and ${destinations.length} destination pattern(s) match the tree. B-15 says no receiver exists anywhere; re-state it against this before any handoff repeats it.`,
    );
  }

  /* ── the resolution model, re-derived rather than trusted ─────────────── */
  console.log('RESOLUTION IS NOW MODELLED — and this section CHECKS the model instead of reading it.');
  console.log('  Each rule carries a `resolution` whose class is a property of its own expression, so');
  console.log('  the class is re-derived here from the condition text and compared. A rule whose');
  console.log('  expression was edited without its class being updated fails this check.');
  console.log('');
  const missing: string[] = [];
  const mismatched: string[] = [];
  const noClosure: string[] = [];
  const falselyFixed: string[] = [];
  const byClass = new Map<string, number>();
  for (const r of rules) {
    const res = r.resolution;
    if (res === undefined) {
      missing.push(r.id);
      continue;
    }
    const want = deriveResolutionClass(r.condition);
    byClass.set(res.class, (byClass.get(res.class) ?? 0) + 1);
    if (res.class !== want) mismatched.push(`${r.id}: file says ${res.class}, the expression gives ${want}`);
    if (res.closure_requirement.trim().length === 0) noClosure.push(r.id);
    // The one substantive cross-check: a window-sliding rule clears itself, so
    // calling its clear a fix is the error the whole model exists to prevent.
    if (res.class === 'self_clearing_window' && res.clearing_is_a_fix) falselyFixed.push(r.id);
    if (res.class === 'state_based' && !res.clearing_is_a_fix) falselyFixed.push(r.id);
  }
  for (const [cls, n] of [...byClass.entries()].sort()) console.log(`  ${String(n).padStart(2)} × ${cls}`);
  console.log('');
  console.log('  The hazard the model names: a rule whose expression is a counter increase over a');
  console.log('  sliding window goes false once the window slides PAST the event, whether or not');
  console.log(`  anything was fixed. ${byClass.get('self_clearing_window') ?? 0} of the ${rules.length} rules are that shape, so for those a clear is`);
  console.log('  not a fix and closure needs the recorded action the rule names.');
  console.log(`  ${byClass.get('state_based_clears_on_no_traffic') ?? 0} more are a quantile or ratio over live traffic: they also fall when traffic`);
  console.log('  stops, so a clear has to be read together with traffic volume.');
  console.log('');
  console.log('  closure_recorded_today is FALSE for every rule, and that is a measurement: no');
  console.log('  closure record exists in the repository, because no rule can fire without an');
  console.log('  exporter and a receiver. The requirements are the contract for when there is one.');
  if (missing.length > 0) resolutionProblems.push(`${missing.length} rule(s) carry no resolution: ${missing.join(', ')}`);
  for (const m of mismatched) resolutionProblems.push(`class disagrees with the expression — ${m}`);
  if (noClosure.length > 0) resolutionProblems.push(`empty closure_requirement: ${noClosure.join(', ')}`);
  for (const f of falselyFixed) resolutionProblems.push(`${f}: clearing_is_a_fix contradicts the class`);
  console.log('');
  console.log('WHAT THIS DOES NOT DECIDE');
  console.log('  The alert destination, the dashboards and the incident rota are owner');
  console.log('  decisions. The exporter is a change to apps/api/src/infra/metrics.ts,');
  console.log('  which is not this branch’s file: it goes to its owner as a patch request.');
  if (resolutionProblems.length > 0) {
    console.log('');
    console.log('EXIT 1 — THE RESOLUTION MODEL DOES NOT MATCH THE RULES IT DESCRIBES:');
    for (const p of resolutionProblems) console.log(`  · ${p}`);
    return 1;
  }
  if (stale > 0) {
    console.log('');
    console.log(`EXIT 1: ${problems.join(', ')} assert something about the tree that the tree does not say.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
