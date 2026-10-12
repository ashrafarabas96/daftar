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
 * The rule schema's KNOWN-BENIGN keys: every key a rule is expected to carry,
 * none of which routes anything anywhere.
 *
 * This list, and not a routing vocabulary, is what `receiverOf` matches
 * against — because the challenger's round 2 broke the vocabulary version in
 * one move. It planted `alert_sink: "ops-team@example.invalid"`, a key no
 * routing word matches, and the check printed `alert_sink` in the key union,
 * then "keys that name a routing destination: NONE", "UNDECIDED: 23 of 23", and
 * exited 0. The claim it is defending is «no receiver exists anywhere», so a
 * miss is in the UNSAFE direction: a routing key nobody listed reads as no
 * routing at all.
 *
 * Inverted, the failure mode changes sides. An unrecognised key cannot be
 * assumed harmless, so it is reported and it reddens the check until a human
 * classifies it — fail-closed (PART 18). A legitimately new non-routing field
 * therefore costs one edit to this list, deliberately: a schema change that
 * nobody noticed is the thing being prevented.
 */
const SCHEMA_KEYS = [
  'id', 'title', 'signal', 'signal_source', 'condition', 'for', 'severity',
  'slo_id', 'runbook_step', 'false_positive_notes', 'exists_today', 'resolution',
] as const;

/**
 * The accounted keys of each NESTED object, keyed by the path that reaches it.
 *
 * Round 3 of the independent challenge (Z-01) looked one level below the fix:
 * it planted `"receiver": "pagerduty:ops-primary"` INSIDE the accounted
 * `resolution` object and the check exited 0, printing `RECEIVER UNSET` while
 * that destination sat in the rule. The inversion was sound; the walk was one
 * level deep, and the output's own sentence said the key-set check was
 * "exhaustive over the rules" when it was exhaustive over each rule's
 * TOP-LEVEL keys. A sentence that claims more than the code does is the defect
 * this instrument was rewritten to stop, so the sentence was not the thing to
 * fix on its own.
 *
 * So the walk now descends, and the schema is declared per level. A key path
 * with NO declared sub-schema is itself unrecognised rather than skipped: an
 * object nobody has described is exactly where a destination would hide, and
 * failing closed there costs one edit to this map when the schema grows,
 * which is the cost already accepted for `SCHEMA_KEYS`.
 */
const NESTED_SCHEMA_KEYS: Readonly<Record<string, readonly string[]>> = {
  resolution: ['class', 'derivation', 'clearing_is_a_fix', 'closure_requirement', 'closure_recorded_today'],
};

/**
 * THE DOCUMENT'S OWN TOP LEVEL — challenge round 6, H-01.
 *
 * The inversion was applied to a RULE and then to a rule's nested objects, and
 * both times the next round found it one level further out. H-01 is the last
 * level there is: an Alertmanager `route:` / `receivers:` block as a SIBLING of
 * the rules array, in a file called `P15-ALERT-RULES.json`. Every rule-shaped
 * walk misses it by construction, because it never leaves the rules — the
 * per-rule table printed `RECEIVER UNSET` for 23 of 23 and was, as a statement
 * about the rules, correct.
 *
 * The tree-text search does catch that plant (it reads the whole file), so the
 * check reddens. But a table that says UNSET while a receiver sits beside it is
 * reporting the narrow truth and letting the reader take the wide one, and the
 * challenger's standing point is that the claim B-15 makes — «no receiver
 * exists» — is about the file, the document around it, the tracked tree and the
 * SPELLING, all at once. So the document level is declared here and walked in
 * its own right, fail-closed like the others: a top-level key nobody has
 * declared is UNACCOUNTED, and an undeclared sub-object cannot vouch for its
 * own contents.
 */
const DOC_KEYS = [
  'generatedAt', 'status', 'repository', 'designDocument', 'sloCatalogue',
  'notPromotedMeaning', 'bindingRules', 'severityContract', 'labelSafety',
  'rules', 'resolutionContract',
] as const;

/** Declared sub-schemas at the document level, by the path that reaches them. */
const DOC_NESTED_SCHEMA_KEYS: Readonly<Record<string, readonly string[]>> = {
  severityContract: ['page', 'ticket'],
  resolutionContract: ['why', 'classes', 'derivedFrom', 'closureRecordedToday', 'counts', 'forbidden', 'redProof'],
};

/**
 * The resolution classes, as `deriveResolutionClass` can return them. Written
 * once and used twice: these are the only legal keys of the two OPEN MAPS below.
 */
const RESOLUTION_CLASSES = ['cannot_fire_no_threshold', 'self_clearing_window', 'state_based_clears_on_no_traffic', 'state_based'] as const;

/**
 * OPEN MAPS, and why they are not an exemption.
 *
 * `resolutionContract.classes` and `.counts` are keyed by resolution CLASS, so
 * their keys are data and cannot be enumerated in a schema. Declaring them as
 * accounted-whatever-they-contain would be the fail-open this instrument exists
 * to prevent, so instead each one declares the SET its keys must come from: a
 * key outside that set is unaccounted exactly as any other undeclared key is.
 * A `route` or a `receiver` planted in either map is therefore still caught —
 * it is not a resolution class.
 */
const DOC_OPEN_MAPS: Readonly<Record<string, readonly string[]>> = {
  'resolutionContract.classes': RESOLUTION_CLASSES,
  'resolutionContract.counts': RESOLUTION_CLASSES,
};

/**
 * The document's key paths, EXCLUDING the rules array, which `keyPaths` covers
 * rule by rule. Everything else in the document is walked with the same
 * fail-closed rule.
 */
function documentKeyPaths(doc: unknown): { readonly path: string; readonly accounted: boolean }[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [{ path: '(the document is not an object)', accounted: false }];
  const out: { path: string; accounted: boolean }[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, `${prefix}[]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const declared: readonly string[] | undefined =
      prefix === ''
        ? DOC_KEYS
        : Object.hasOwn(DOC_OPEN_MAPS, prefix)
          ? DOC_OPEN_MAPS[prefix]
          : Object.hasOwn(DOC_NESTED_SCHEMA_KEYS, prefix)
            ? DOC_NESTED_SCHEMA_KEYS[prefix]
            : undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix === '' ? k : `${prefix}.${k}`;
      if (path === 'rules') continue; // walked rule by rule, with the rule schema
      out.push({ path, accounted: declared !== undefined && declared.includes(k) });
      walk(v, path);
    }
  };
  walk(doc, '');
  return out;
}

/**
 * Every key path in a rule, descending through objects and through objects
 * inside arrays, paired with whether the schema accounts for it. `path` is
 * dotted, with `[]` for an array hop, so a reader can find what was named.
 */
function keyPaths(value: unknown, prefix: string): { readonly path: string; readonly accounted: boolean; readonly value: unknown }[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  // `Object.hasOwn`, not a bare index: a rule carrying a key named
  // `constructor` or `__proto__` would otherwise read Object.prototype's own
  // property as this level's "declared" list and crash on `.includes`
  // (coordinator F-7). A hostile or merely odd key must be UNACCOUNTED, which
  // is what the fail-closed arm already does once the lookup is safe.
  const declared: readonly string[] | undefined =
    prefix === '' ? SCHEMA_KEYS : Object.hasOwn(NESTED_SCHEMA_KEYS, prefix) ? NESTED_SCHEMA_KEYS[prefix] : undefined;
  const out: { path: string; accounted: boolean; value: unknown }[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    // With no declaration for this level, nothing here is accounted for. That
    // is the fail-closed arm: an undeclared sub-object cannot vouch for its
    // own contents.
    out.push({ path, accounted: declared !== undefined && declared.includes(k), value: v });
    out.push(...keyPaths(v, path));
  }
  return out;
}

/**
 * Words a routing destination would be called. No longer the detection
 * mechanism — `SCHEMA_KEYS` is — this only lets an unrecognised key be reported
 * as PROBABLE ROUTING rather than merely unrecognised, which tells a reader
 * whether they are looking at a schema addition or at a receiver appearing.
 */
const ROUTING_WORDS = ['receiver', 'route', 'routing', 'destination', 'notify', 'notification', 'target', 'channel', 'recipient', 'webhook', 'pagerduty', 'opsgenie', 'email', 'mail', 'sink', 'oncall', 'on_call', 'page', 'alert_to', 'escalat', 'slack', 'sms', 'phone', 'subscriber', 'audience'] as const;

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
 * CONCLUSION from a key set, and it changes the moment the key set does —
 * whatever the new key is called.
 */
function receiverOf(r: Rule): { readonly value: string; readonly unrecognised: readonly string[]; readonly probableRouting: readonly string[] } {
  // Every key path, not just the top level — Z-01. A nested destination is the
  // same defect one level down, and it exited 0 before this walk existed.
  const walked = keyPaths(r, '');
  const unrecognised = walked.filter((e) => !e.accounted).map((e) => e.path);
  const probableRouting = unrecognised.filter((k) => ROUTING_WORDS.some((w) => k.toLowerCase().includes(w)));

  if (unrecognised.length === 0) return { value: 'UNSET', unrecognised, probableRouting };

  // A key that is present but empty routes nowhere. Reporting it as a
  // destination would be the overclaim this instrument exists to prevent; it is
  // still reported as unrecognised, because an empty routing field is a
  // half-made decision and not an absent one.
  const valueAt = new Map(walked.map((e) => [e.path, e.value]));
  const named = unrecognised.filter((k) => {
    const v = valueAt.get(k);
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && v !== undefined && v !== false;
  });
  return {
    value: named.length === 0 ? `EMPTY:${unrecognised.join(',')}` : `SET:${named.join(',')}`,
    unrecognised,
    probableRouting,
  };
}

/**
 * The destinations a repository would hold if alerts were wired up. Searched in
 * the tree, so "no destination exists" is also a measurement rather than a
 * recollection. A hit does not mean the alerts are routed — it means the claim
 * "nothing anywhere" is no longer true and a human has to look.
 */
/**
 * A grep whose EXIT CODE was read. 0 = matched, 1 = no match, >=2 = the search
 * failed, and the third is the one that matters: this instrument's whole
 * output is a set of statements about what the tree does and does not contain,
 * so a search that could not run must never contribute an absence. The
 * coordinator swept the pack for this class (F-11 and its siblings) after
 * finding it in `exporter()`.
 */
function searched(r: ReturnType<typeof spawnSync>, what: string): { readonly out: string; readonly failure: string | null } {
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    return {
      out: '',
      failure: `SEARCH FAILED for ${what} — exited ${String(r.status)}${(r.stderr ?? '').toString().trim() === '' ? '' : `: ${(r.stderr ?? '').toString().trim().slice(0, 120)}`}. This is NOT a statement of absence.`,
    };
  return { out: (r.stdout ?? '').toString(), failure: null };
}

/**
 * Failed searches collected across the run. They are reported and they change
 * the exit code: an instrument that could not look has not established the
 * absence its table prints.
 */
const searchFailures: string[] = [];

/**
 * Search the tracked tree for a pattern, returning the first match's location
 * or null. `git grep` is used rather than a filesystem walk so the search
 * covers exactly what the branch carries — an untracked scratch file left in
 * the working tree is not a destination this repository configures.
 */
function grepTree(re: RegExp): string | null {
  // The MEASUREMENT APPARATUS is excluded from the search, and nothing else is.
  //
  // This file has to be: the patterns are written out here in full, so without
  // the exclusion every one of them matched its own definition and the check
  // reported six destinations that do not exist — a red result for the wrong
  // reason, which is as useless as a green one.
  //
  // The red-proof harness had to be added for the same reason, one round later
  // and the hard way. Its Z-01 case plants `pagerduty:ops-primary` inside a
  // rule, as a STRING LITERAL in its source, and the moment that literal
  // existed the search found it and the harness's own BASELINE went red — so
  // every plant below it was invalid. A destination in a file whose only job is
  // to fabricate destinations is a fixture, not a configuration this
  // repository carries.
  //
  // The exclusion is kept to those two files, printed in the output, and it is
  // the only exemption: a destination anywhere else in the tracked tree,
  // including in any other test, still reddens this check. An apparatus
  // exemption that grew would be a way to hide a real destination.
  // SEARCH_ROOT exists so the case-sensitivity law can be PROVED. `-i` was added
  // on the coordinator's F-2 and the comment below says what it costs to omit —
  // but a law with no red proof is a comment, and round 6 (H-02) asked for the
  // proof, not the flag. The search cannot be proved against this repository
  // without committing a fake destination to it, so the proof builds a scratch
  // git repository, commits an UPPER-CASE destination there, and points this
  // search at it. The default is this repository, and the output states which
  // tree was searched whenever it is not.
  const r = spawnSync('git', ['grep', '-nIE', '-i', '--', re.source, ...APPARATUS.map((f) => `:(exclude)${f}`)], { cwd: SEARCH_ROOT, encoding: 'utf8' });
  // `-i` is not cosmetic. Without it the patterns are case-sensitive, and the
  // coordinator's F-2 showed what that costs: `PAGERDUTY_ROUTING_KEY` and
  // `SLACK_WEBHOOK_URL` in a tracked file both gave exit 0 and `NONE FOUND`.
  // Environment-variable names are the most likely spelling of a real
  // destination in a repository, and they are conventionally upper case.
  //
  // git grep exits 1 for "no match", which is the expected answer here; any
  // other non-zero is a failed search, and a failed search must not read as a
  // clean one.
  if (r.status === 1) return null;
  if (r.status !== 0) return `SEARCH FAILED (${(r.stderr ?? '').slice(0, 80).trim()}) — not a statement that nothing matches`;
  const first = (r.stdout ?? '').split('\n').find((l) => l.trim().length > 0);
  if (first === undefined) return null;
  // POSITION, NOT CONTENT. The rule-file search was hardened to print the key
  // and the line numbers and never the value, because a routing value is a
  // credential — a webhook URL with a token in its path, a pager key — and this
  // output goes into a handoff that gets attached and quoted. The tree search
  // was still returning git grep's whole matching line, which is the same leak
  // from the other half of the same conclusion. `file:line` is enough to find
  // it and leaks nothing.
  const m = /^([^:]+):(\d+):/.exec(first);
  return m === null ? `a match whose position could not be parsed from git grep's output (${first.length} bytes, not printed)` : `${m[1]}:${m[2]}`;
}

/**
 * The only files exempt from the destination search: this checker and its red
 * -proof harness. Both contain destination-shaped literals BY NECESSITY — the
 * patterns themselves, and the plants that prove the patterns fire — and a
 * search that counts them is measuring its own apparatus. Printed in the
 * output, and deliberately short.
 */
const APPARATUS = ['scripts/phase15/verify-alert-signals.ts', 'scripts/phase15/alert-signals-proof.ts'] as const;

/** The tree the destination search reads. See `grepTree`. */
const SEARCH_ROOT = process.env['P15_SEARCH_ROOT'] ?? ROOT;

/**
 * THE PAIR-DROP — G-01, and the finding neither check could have caught alone.
 *
 * Two checks jointly support one conclusion, "no destination exists": the key
 * walk, which reads a rule's key PATHS, and the tree grep, which reads TRACKED
 * FILES. The challenger found a shape that defeats both at once — a destination
 * written as the VALUE of an ACCOUNTED key, in the rule file:
 *
 *     "closure_requirement": "… Page pagerduty://daftar-oncall on breach."
 *
 * on all 23 rules. The key walk sees only `resolution.closure_requirement`,
 * which is accounted for, and `git grep` never sees the rule file at all,
 * because it lives outside the repository. Exit 0, `RECEIVER UNSET` 23 times,
 * and the word pagerduty absent from the output. Neither check is defective;
 * the CONCLUSION they jointly support was false, and no single-check mutation
 * can reach it — which is why a fully green red-proof harness and a false claim
 * sat side by side.
 *
 * So the same six patterns are run over the rule file's own text. It is the one
 * subject the tree search structurally cannot reach, and it is the subject this
 * instrument is about.
 *
 * The VALUE IS NEVER PRINTED. A routing value may be a credential — a webhook
 * URL with a token in its path, a pager key — and this check runs in logs that
 * go into a handoff. The rule id, the key path and the pattern that matched are
 * enough for a reader to find it, and they leak nothing.
 */
function destinationsInRuleFile(raw: string): readonly string[] {
  const hits: string[] = [];
  // The WHOLE DOCUMENT, not the rules array. The coordinator's F-1 added a
  // third variant to the challenger's two: an Alertmanager-style
  // `receivers:`/`route:` block sitting BESIDE the rules list, which every
  // rule-shaped walk misses by construction because it never leaves the rules.
  // Searching the file's own text covers the rules, anything beside them, and
  // any shape nobody has thought of — including a key this schema does not
  // know and a value inside an accounted key.
  const grouped = new Map<string, number[]>();
  const lines = raw.split('\n');
  for (const d of DESTINATION_PATTERNS) {
    for (const [n, line] of lines.entries()) {
      if (!d.re.test(line)) continue;
      // Neither the line nor the value is printed: a routing value may be a
      // credential — a webhook URL with a token in its path, a pager key — and
      // this output goes into a handoff. The pattern, the key name and the line
      // numbers are enough to find it and leak nothing. The key is printed only
      // when the line actually names one.
      const key = /"([A-Za-z0-9_.-]{1,60})"\s*:/.exec(line);
      const label = `${d.what} in ${key === null ? 'a line naming no key' : `key \`${key[1] ?? '?'}\``}`;
      grouped.set(label, [...(grouped.get(label) ?? []), n + 1]);
    }
  }
  // GROUPED. A destination planted uniformly across every rule first produced
  // 23 near-identical sentences on one output line and buried its own finding.
  // One row per (pattern, key) with the count and the first line numbers says
  // the same thing and can be read.
  for (const [label, at] of grouped) {
    hits.push(`${label} — ${at.length} line(s): ${at.slice(0, 3).join(', ')}${at.length > 3 ? `, +${at.length - 3} more` : ''}`);
  }
  return hits;
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
  const grep = searched(
    spawnSync('grep', ['-rn', '--include=*.ts', '-E', '\\.(increment|observe)\\(', join(ROOT, 'apps'), join(ROOT, 'packages')], { encoding: 'utf8' }),
    'metric emit sites',
  );
  if (grep.failure !== null) searchFailures.push(grep.failure);
  for (const line of grep.out.split('\n')) {
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
  const dyn = searched(
    spawnSync('grep', ['-rn', '--include=*.ts', '-E', 'METRICS\\[', join(ROOT, 'apps'), join(ROOT, 'packages')], { encoding: 'utf8' }),
    'dynamic metric indexing',
  );
  if (dyn.failure !== null) searchFailures.push(dyn.failure);
  const dynamic = dyn.out
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
    // grep exits 0 for a match, 1 for none, and >=2 for a FAILED SEARCH.
    // Reading stdout without the code (coordinator F-11) means an unreadable
    // directory, a bad option or a killed grep all read as "no exporter
    // exists" — the exact conclusion this function feeds into §22.2. A search
    // that could not run is not a finding of absence.
    if (r.error !== undefined || (r.status !== 0 && r.status !== 1)) {
      found.push(
        `SEARCH FAILED for ${what} — grep exited ${String(r.status)}${(r.stderr ?? '').trim() === '' ? '' : `: ${(r.stderr ?? '').trim().slice(0, 100)}`}. This is NOT a statement that no exporter exists.`,
      );
      continue;
    }
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
  const unexpected = rules.flatMap((r) => {
    const d = receiverOf(r);
    return d.unrecognised.map((key) => ({ rule: r.id, key, routing: d.probableRouting.includes(key) }));
  });
  const unset = [...receivers.values()].filter((v) => v === 'UNSET').length;
  // H-01: the level above the rules. Reported separately, because a key beside
  // the rules is not a key ON a rule and conflating the two is how the previous
  // two rounds' sentences came to claim more than their walk.
  const docUnaccounted = documentKeyPaths(parsed).filter((k) => !k.accounted);

  console.log('RECEIVER, DERIVED FROM THE RULE OBJECTS (not asserted)');
  console.log(`  the key set actually present on the ${rules.length} rules, read from the file:`);
  console.log(`    ${keyUnion.join(', ')}`);
  console.log(`  keys the rule SCHEMA accounts for: ${SCHEMA_KEYS.join(', ')}`);
  console.log(`  keys it does NOT account for: ${unexpected.length === 0 ? 'NONE' : unexpected.map((u) => `${u.key} (on ${u.rule}${u.routing ? ', PROBABLE ROUTING' : ''})`).join('; ')}`);
  console.log(`  rules whose receiver is therefore UNSET: ${unset} of ${rules.length}`);
  console.log('');
  console.log('  THE DOCUMENT AROUND THE RULES (challenge round 6, H-01)');
  console.log(`    top-level keys the DOCUMENT schema accounts for: ${DOC_KEYS.join(', ')}`);
  console.log(
    `    key paths beside the rules that it does NOT account for: ${docUnaccounted.length === 0 ? 'NONE' : docUnaccounted.map((k) => k.path).join(', ')}`,
  );
  console.log('    An Alertmanager `route:`/`receivers:` block as a SIBLING of the rules list is the');
  console.log('    one shape every rule-shaped walk misses by construction, and it is the literal');
  console.log('    structure of an Alertmanager config in a file named for alert rules. The per-rule');
  console.log('    table above would say UNSET for all of them and be right about the rules, which is');
  console.log('    the narrow truth a reader would take for the wide one.');
  console.log('');
  console.log('  This matches against the SCHEMA\u2019s known-benign keys, not against a list of routing');
  console.log('  words. The vocabulary version was broken in one move: a planted `alert_sink` matched');
  console.log('  no routing word, so the check printed it in the key union and still reported NONE and');
  console.log('  exited 0. The claim being defended is that NO receiver exists anywhere, so a miss is');
  console.log('  in the unsafe direction. Inverted, an unrecognised key reddens the check until a human');
  console.log('  classifies it, and a new non-routing field costs one edit to SCHEMA_KEYS \u2014 on purpose.');
  console.log('');

  const destinations: string[] = [];
  for (const d of DESTINATION_PATTERNS) {
    const hit = grepTree(d.re);
    if (hit !== null) destinations.push(`${d.what} — ${hit}`);
  }
  // THE THIRD SUBJECT, and the one the other two structurally cannot reach.
  // `git grep` reads the tracked tree; the key walk reads key PATHS. The rule
  // file is neither: it lives outside the repository, so the grep never sees
  // it, and a destination written as a VALUE — or in a block beside the rules
  // list — carries no unaccounted key, so the walk never sees it either. Two
  // sound checks, one false conclusion, reachable by no single-check mutation.
  const inFile = destinationsInRuleFile(rulesBytes.toString('utf8'));
  destinations.push(...inFile);
  console.log(`  destination configuration in the repository: ${destinations.length === 0 ? `NONE FOUND \u2014 ${DESTINATION_PATTERNS.length} patterns searched over the TRACKED tree (${DESTINATION_PATTERNS.map((d) => d.what).join(', ')}), excluding only the ${APPARATUS.length} apparatus file(s) that contain destination literals by necessity (${APPARATUS.join(', ')})` : destinations.join('; ')}`);
  console.log(`  destination patterns over the RULE FILE'S OWN TEXT (${RULES}): ${inFile.length === 0 ? 'NONE FOUND' : `${inFile.length} match(es) — ${inFile.join('; ')}`}`);
  console.log('    This subject is searched separately because neither other check can reach it: the');
  console.log('    tree grep reads TRACKED files and the rule file is not in Git, and the key walk reads');
  console.log('    key PATHS, so a destination written as the VALUE of an accounted key — or in a block');
  console.log('    beside the rules list — is invisible to both. Two sound checks, one false conclusion,');
  console.log('    and no single-check mutation can reach it. Values and whole lines are never printed:');
  console.log('    a routing value may carry a credential and this output goes into a handoff.');
  console.log('  Bounds on these searches, stated because they are the ways they can be wrong:');
  if (SEARCH_ROOT !== ROOT) console.log(`    ! THE TREE SEARCHED IS NOT THIS REPOSITORY: ${SEARCH_ROOT}`);
  console.log('    \u00b7 `git grep` reads TRACKED files only, so an uncommitted destination is invisible to it;');
  console.log('    \u00b7 the six patterns are a list, and a destination configured some other way is not in it;');
  console.log('    \u00b7 the apparatus exemption above is the only one. It covers this checker, which writes the');
  console.log('      patterns out, and the red-proof harness, which plants destinations to prove they fire —');
  console.log('      the harness\u2019s own baseline went red the moment a plant literal existed. Any OTHER file');
  console.log('      in the tracked tree, tests included, still reddens this check.');
  console.log('  Neither bound affects the key-set check above, which walks EVERY key path in each');
  console.log('  rule — through nested objects and through objects inside arrays — and treats a key');
  console.log('  path with no declared sub-schema as unaccounted. It said "exhaustive over the rules"');
  console.log('  for a round while walking only the top level, which is how a receiver planted inside');
  console.log('  `resolution` exited 0 (Z-01). The sentence and the walk now agree.');
  console.log('');
  console.log('  \u00a722.2 forbids choosing a recipient, a subscription or a retention here, so this stays');
  console.log('  with the owner. A rule with a condition and no receiver is a rule that fires into nothing.');
  console.log('');

  // The claim is now falsifiable in both directions, which is what makes it a
  // measurement. Routing that appears without the owner's decision being
  // recorded is a change this instrument must not pass over in silence.
  // A FAILED SEARCH IS ITS OWN PROBLEM, before any conclusion is drawn from
  // the searches. Reporting absence from a search that did not run is how this
  // instrument would lie most quietly.
  if (searchFailures.length > 0) {
    for (const f of searchFailures) resolutionProblems.push(f);
    console.log('');
    console.log(`  ! ${searchFailures.length} SEARCH(ES) FAILED. Every statement of absence in this run is unestablished:`);
    for (const f of searchFailures) console.log(`    ${f}`);
  }
  if (unexpected.length > 0 || destinations.length > 0 || docUnaccounted.length > 0) {
    const routing = unexpected.filter((u) => u.routing);
    resolutionProblems.push(
      `the receiver claim is STALE or UNVERIFIABLE: ${docUnaccounted.length} key path(s) BESIDE the rules that the document schema does not account for (${docUnaccounted.map((k) => k.path).join(', ') || 'none'}), ${unexpected.length} key(s) the rule schema does not account for (${unexpected.map((u) => `${u.rule}.${u.key}`).join(', ')})${routing.length > 0 ? ` \u2014 ${routing.length} of them named like routing` : ''}, and ${destinations.length} destination pattern(s) match the tree. B-15 says no receiver exists anywhere; an unclassified key cannot be assumed to be nothing, so classify each one in SCHEMA_KEYS or record the receiver before any handoff repeats that claim.`,
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
