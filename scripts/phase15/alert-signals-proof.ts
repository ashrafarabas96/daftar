/**
 * P15 — RED PROOF FOR THE ALERT-SIGNAL CHECK
 * ==========================================
 *
 * The independent challenger rejected this pack for two claims that were
 * printed as measurements and were not measurements: `RECEIVER` came from
 * `const receiver = 'UNDECIDED'`, and the `RESOLUTION` verdict came from a
 * fixed string that was never compared to the field — so it kept printing
 * "resolution is not modelled at all" for hours after every rule had gained a
 * resolution object, and exited 0 while doing it.
 *
 * Both are now derived. That is necessary and not sufficient: a derived claim
 * is only worth what its ability to go RED is worth, and the whole reason the
 * old claims survived is that nobody could tell the difference between a check
 * that passed and a check that could not fail. «لا تعتبر الأخضر دليلًا إن لم
 * يُثبَت أنه قادر على أن يصير أحمر.»
 *
 * So this plants a defect of each class in a COPY of the rule set and requires
 * `verify:alert-signals` to exit non-zero and to NAME it:
 *
 *   R1  a routing key appears on a rule        → the receiver claim is stale
 *   R2  a destination-shaped value appears     → likewise, by value not key
 *   R3  a rule loses its `resolution`          → a rule carries no resolution
 *   R4  a resolution class contradicts its own
 *       expression                             → class disagrees
 *   R5  a `closure_requirement` is emptied     → empty closure_requirement
 *
 * R1 and R2 are the challenger's F-01 made falsifiable: the column now goes red
 * when routing appears, which is exactly what the constant could never do.
 *
 * WHAT THIS DOES NOT TOUCH
 *
 * The shared document is never written. Every mutation is applied to a copy
 * under this process's own scratch directory, the check is pointed at the copy
 * through `P15_ALERT_RULES`, and the copy is deleted at the end. The baseline
 * run (R0) proves the copy is accepted BEFORE anything is planted, so a red
 * result later is attributable to the mutation and not to the copying.
 *
 * A red proof that cannot say WHICH check it reddened is the defect this pack
 * recorded in Phase 6 («قيد يُطلَق أولًا يحجب القيد الذي تختبره»), so each case
 * asserts on the text of its own finding, not merely on a non-zero exit.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const DEFAULT_RULES = '/mnt/project-files/phase15/P15-ALERT-RULES.json';

interface Case {
  readonly id: string;
  readonly what: string;
  /** mutate the parsed rule set in place. */
  readonly plant: (doc: { rules: Record<string, unknown>[] } & Record<string, unknown>) => void;
  /** the finding text the check must produce. */
  readonly expect: RegExp;
}

const CASES: readonly Case[] = [
  {
    id: 'R1',
    what: 'a routing KEY appears on one rule (the exact change the old constant could not notice)',
    plant: (doc) => {
      const r = doc.rules[0];
      if (r !== undefined) r['receiver'] = 'oncall-placeholder';
    },
    expect: /receiver claim is STALE or UNVERIFIABLE/i,
  },
  {
    id: 'R2',
    what: 'a differently-named routing key appears (`notification_channel`), to prove the match is not a hard-coded key list of one',
    plant: (doc) => {
      const r = doc.rules[3];
      if (r !== undefined) r['notification_channel'] = 'ops-room';
    },
    expect: /receiver claim is STALE or UNVERIFIABLE/i,
  },
  {
    id: 'R2b',
    what: "a routing key OUTSIDE any routing vocabulary (`alert_sink`) — the challenger's round-2 N-03, which the vocabulary version missed and exited 0 on",
    plant: (doc) => {
      const r = doc.rules[7];
      if (r !== undefined) r['alert_sink'] = 'ops-team@example.invalid';
    },
    expect: /STALE or UNVERIFIABLE/i,
  },
  {
    id: 'R2c',
    what: 'a key that is neither routing-shaped nor in the schema (`owner_notes`) — it must ALSO redden, because an unclassified key cannot be assumed harmless',
    plant: (doc) => {
      const r = doc.rules[9];
      if (r !== undefined) r['owner_notes'] = 'a schema addition nobody classified';
    },
    expect: /schema does not account for/i,
  },
  {
    id: 'R2d',
    what:
      "the independent challenger's own Z-01: a destination planted INSIDE the accounted `resolution` object. " +
      'This exited 0 for a whole round, with `RECEIVER UNSET` printed while the destination sat in the rule, ' +
      'because the key walk stopped at the top level while the output claimed to be exhaustive over the rules',
    plant: (doc) => {
      const r = doc.rules[0];
      const res = r?.['resolution'];
      if (res === null || typeof res !== 'object' || Array.isArray(res))
        throw new Error('no resolution object on the first rule: the Z-01 proof cannot be run as written, and a proof that cannot run says nothing');
      (res as Record<string, unknown>)['receiver'] = 'pagerduty:ops-primary';
    },
    expect: /resolution\.receiver/i,
  },
  {
    id: 'R2f',
    what:
      'the challenger\u2019s round-4 plant: a nested receiver in ALL 23 rules, not one. It graded the single-rule ' +
      'version P3 and then found that the set-wide version made the checker print "no receiver" 23 times while ' +
      'pagerduty sat in every rule. The proof is the SET, because a per-rule plant can pass a check that a ' +
      'uniform one defeats',
    plant: (doc) => {
      let planted = 0;
      for (const r of doc.rules) {
        const res = r['resolution'];
        if (res === null || typeof res !== 'object' || Array.isArray(res)) continue;
        (res as Record<string, unknown>)['receiver'] = 'pagerduty:ops-primary';
        planted += 1;
      }
      if (planted !== doc.rules.length)
        throw new Error(`planted into ${planted} of ${doc.rules.length} rules: a set-wide proof that is not set-wide proves something else`);
    },
    expect: /rules whose receiver is therefore UNSET: 0 of \d+/,
  },
  {
    id: 'R2e',
    what:
      'a NEW nested object whose sub-schema nobody declared (`notification_policy: { receiver: … }`). The walk ' +
      'has no declaration for that level, and the fail-closed arm must treat everything inside it as unaccounted ' +
      'rather than skipping a level it cannot describe',
    plant: (doc) => {
      const r = doc.rules[3];
      if (r !== undefined) r['notification_policy'] = { receiver: 'slack:#ops', escalate_after: '15m' };
    },
    expect: /notification_policy/i,
  },
  {
    id: 'R2g',
    what:
      'the PAIR-DROP (challenger G-01, coordinator F-1): a destination as the VALUE of an ACCOUNTED key, on ' +
      'all 23 rules. No unaccounted key, so the key walk sees nothing; the rule file is not in Git, so the tree ' +
      'grep never reads it. Two sound checks, one false conclusion, reachable by no single-check mutation',
    plant: (doc) => {
      let n = 0;
      for (const r of doc.rules) {
        const res = r['resolution'];
        if (res === null || typeof res !== 'object' || Array.isArray(res)) continue;
        const o = res as Record<string, unknown>;
        if (typeof o['closure_requirement'] !== 'string') continue;
        o['closure_requirement'] = `${o['closure_requirement'] as string} Page pagerduty://daftar-oncall on breach.`;
        n += 1;
      }
      if (n !== doc.rules.length) throw new Error(`planted into ${n} of ${doc.rules.length} rules; a set-wide proof that is not set-wide proves something else`);
    },
    expect: /PagerDuty in key `closure_requirement`/,
  },
  {
    id: 'R2h',
    what: 'the same shape with a Slack webhook URL as the value, because one pattern passing is not six passing',
    plant: (doc) => {
      for (const r of doc.rules) r['false_positive_notes'] = `${String(r['false_positive_notes'] ?? '')} See https://hooks.slack.com/services/T000/B000/xxxx`.trim();
    },
    expect: /a Slack webhook in key `false_positive_notes`/,
  },
  {
    id: 'R2i',
    what:
      "coordinator F-1's third variant: an Alertmanager-style `receivers`/`route` block BESIDE the rules list. " +
      'Every rule-shaped walk misses it by construction, because it never leaves the rules',
    plant: (doc) => {
      const d = doc as unknown as Record<string, unknown>;
      d['receivers'] = [{ name: 'ops-primary', pagerduty_configs: [{ routing_key: 'REDACTED' }] }];
      d['route'] = { receiver: 'ops-primary', group_by: ['alertname'] };
    },
    expect: /PagerDuty in key `(pagerduty_configs|routing_key)`/,
  },
  {
    id: 'R2j',
    what:
      'a key named `constructor` (coordinator F-7). The level lookup used a bare index, so this read ' +
      "Object.prototype's own property as the declared list and crashed on `.includes` — a check that throws " +
      'is not a check that passes, but it is not a check that reds for its own reason either',
    plant: (doc) => {
      const r = doc.rules[5];
      if (r !== undefined) r['constructor'] = 'a key that is also a prototype property';
    },
    expect: /constructor/,
  },
  {
    id: 'R2k',
    what:
      'challenge round 6, H-01: an Alertmanager `route:` / `receivers:` block as a SIBLING of the rules ' +
      'list — the literal structure of an Alertmanager config, in a file named for alert rules. Every ' +
      'rule-shaped walk misses it by construction. The expectation is deliberately the DOCUMENT-LEVEL ' +
      'line and not a bare non-zero exit: the tree-text search also reddens on this plant, and a case ' +
      'that accepted that red would pass while the level it exists to cover stayed unwalked',
    plant: (doc) => {
      doc['route'] = { receiver: 'daftar-oncall', group_by: ['alertname'] };
      doc['receivers'] = [{ name: 'daftar-oncall', pagerduty_configs: [{ routing_key: 'abc' }] }];
    },
    expect: /does NOT account for:[^\n]*\broute\b[^\n]*receivers/,
  },
  {
    id: 'R2l',
    what:
      'a receiver hidden in an OPEN MAP — `resolutionContract.counts`, whose keys are resolution class ' +
      'names and so cannot be enumerated in a schema. Declaring such a map accounted-whatever-it-holds ' +
      'is the fail-open this instrument exists to prevent, so its keys are checked against the class set',
    plant: (doc) => {
      const rc = doc['resolutionContract'];
      if (rc === null || typeof rc !== 'object') throw new Error('R2l cannot plant: the document has no resolutionContract object');
      const counts = (rc as Record<string, unknown>)['counts'];
      if (counts === null || typeof counts !== 'object') throw new Error('R2l cannot plant: resolutionContract.counts is not an object');
      (counts as Record<string, unknown>)['receiver'] = 'pagerduty:daftar-oncall';
    },
    expect: /does NOT account for:[^\n]*resolutionContract\.counts\.receiver/,
  },
  {
    id: 'R3',
    what: 'one rule loses its `resolution` object entirely',
    plant: (doc) => {
      const r = doc.rules[5];
      if (r !== undefined) delete r['resolution'];
    },
    expect: /carry no resolution/i,
  },
  {
    id: 'R4',
    what: 'a resolution class is changed to one its own expression contradicts',
    plant: (doc) => {
      for (const r of doc.rules) {
        const res = r['resolution'] as Record<string, unknown> | undefined;
        if (res !== undefined && res['class'] === 'self_clearing_window') {
          res['class'] = 'state_based';
          return;
        }
      }
      throw new Error('no self_clearing_window rule to mutate: the proof cannot be run as written');
    },
    expect: /class disagrees with the expression/i,
  },
  {
    id: 'R5',
    what: 'a `closure_requirement` is emptied, which would let a rule clear with nothing recorded',
    plant: (doc) => {
      for (const r of doc.rules) {
        const res = r['resolution'] as Record<string, unknown> | undefined;
        if (res !== undefined) {
          res['closure_requirement'] = '   ';
          return;
        }
      }
      throw new Error('no resolution object to mutate: the proof cannot be run as written');
    },
    expect: /empty closure_requirement/i,
  },
];

function runCheck(subject: string, searchRoot?: string): { readonly code: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', 'scripts/phase15/verify-alert-signals.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P15_ALERT_RULES: subject, ...(searchRoot === undefined ? {} : { P15_SEARCH_ROOT: searchRoot }) },
    maxBuffer: 32 * 1024 * 1024,
  });
  // The gate's own codes are 0 and 1. Anything else — a crash, a missing
  // runner, a signal — is NOT a verdict, and a case that compared it with 1
  // would read "the check went red" from a check that never ran.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    return { code: null, out: `${out}\n[harness] the gate did not run: exit ${String(r.status)}${r.error === undefined ? '' : ` (${String(r.error)})`}` };
  return { code: r.status, out };
}

/**
 * THE SPELLING — challenge round 6, H-02.
 *
 * The destination search is case-insensitive, and the flag that makes it so was
 * added on the coordinator's F-2 with a comment saying what omitting it costs.
 * A law defended by a comment is not defended: round 6 asked for the proof.
 *
 * It cannot be planted in THIS repository — committing a real-looking
 * destination to it to prove a search would be a fixture nobody could tell from
 * a configuration later. So the proof builds a scratch git repository, commits
 * an UPPER-CASE destination there, and points the search at it with
 * `P15_SEARCH_ROOT`. Both directions are measured: upper case must be found
 * (the law), and a tree with nothing in it must come back clean (the control,
 * so a red cannot be an artefact of the scratch repository itself).
 */
interface TreeCase {
  readonly id: string;
  readonly what: string;
  readonly file: string | null; // null = plant nothing: the control
  readonly contents: string;
  readonly mustFind: boolean;
}

const TREE_CASES: readonly TreeCase[] = [
  { id: 'T0', what: 'a scratch repository with no destination in it — the control', file: null, contents: '', mustFind: false },
  {
    id: 'T1',
    what: 'an UPPER-CASE PagerDuty routing key, the spelling a deployment actually uses for an environment variable',
    file: 'deploy/alerts.env',
    contents: 'PAGERDUTY_ROUTING_KEY=abc123\n',
    mustFind: true,
  },
  { id: 'T2', what: 'an UPPER-CASE Alertmanager URL', file: 'deploy/alerts.env', contents: 'ALERTMANAGER_URL=https://am.internal/api/v2/alerts\n', mustFind: true },
  { id: 'T3', what: 'an UPPER-CASE Opsgenie key', file: 'deploy/alerts.env', contents: 'OPSGENIE_API_KEY=xxxx\n', mustFind: true },
  { id: 'T4', what: 'the same key in lower case — the control for the control', file: 'deploy/alerts.env', contents: 'pagerduty_routing_key=abc123\n', mustFind: true },
];

function scratchRepo(file: string | null, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'p15-tree-'));
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0] ?? ''} in the scratch repository exited ${String(r.status)}: ${(r.stderr ?? '').trim().slice(0, 160)}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'proof@localhost');
  git('config', 'user.name', 'p15 proof');
  writeFileSync(join(dir, 'README'), 'a scratch tree, built by the Phase 15 alert red proofs\n');
  if (file !== null) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), contents);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'scratch');
  return dir;
}

function main(): number {
  console.log('P15 — RED PROOF: CAN THE ALERT-SIGNAL CHECK GO RED?');
  console.log('='.repeat(78));

  const dir = mkdtempSync(join(tmpdir(), 'p15-alert-proof-'));
  const subject = join(dir, 'P15-ALERT-RULES.json');
  let failures = 0;

  try {
    const pristine = readFileSync(DEFAULT_RULES, 'utf8');
    writeFileSync(subject, pristine);
    console.log(`subject copy : ${subject}`);
    console.log(`the shared document at ${DEFAULT_RULES} is READ and never written.`);
    console.log('');

    // R0: the copy must be ACCEPTED before anything is planted. Without this,
    // a red result below could be an artefact of copying rather than of the
    // defect, and the proof would prove nothing.
    const base = runCheck(subject);
    const baseOk = base.code === 0;
    console.log(`R0 BASELINE   the untouched copy is accepted: ${baseOk ? 'PASS' : 'FAIL'} (exit ${String(base.code)})`);
    if (!baseOk) {
      console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a');
      console.log('  later red to a planted defect. First lines of the run:');
      for (const l of base.out.split('\n').slice(-12)) console.log(`    ${l}`);
      return 1;
    }
    console.log('');

    for (const c of CASES) {
      const doc = JSON.parse(pristine) as { rules: Record<string, unknown>[] } & Record<string, unknown>;
      c.plant(doc);
      writeFileSync(subject, JSON.stringify(doc, null, 2));
      const got = runCheck(subject);
      const red = got.code !== 0;
      const named = c.expect.test(got.out);
      const ok = red && named;
      console.log(`${c.id} ${ok ? 'RED AS REQUIRED' : 'FAILED'}  exit ${String(got.code)}`);
      console.log(`   planted : ${c.what}`);
      console.log(`   expected: the check names it — /${c.expect.source}/`);
      if (!ok) {
        failures += 1;
        console.log(`   ! ${red ? 'it went red but did NOT name this defect, so it may have reddened on something else' : 'IT STAYED GREEN — the check cannot detect this class at all'}`);
        const tail = got.out.split('\n').filter((l) => /EXIT 1|·/.test(l)).slice(0, 6);
        for (const l of tail) console.log(`     ${l}`);
      } else {
        const line = got.out.split('\n').find((l) => c.expect.test(l));
        if (line !== undefined) console.log(`   it said : ${line.trim().slice(0, 150)}`);
      }
      console.log('');
    }

    // THE SPELLING (H-02). Each case gets its own scratch repository, and the
    // SUBJECT is the pristine copy throughout: the only thing that varies is
    // the tree the destination search reads.
    writeFileSync(subject, pristine);
    console.log('THE TREE SEARCH AND THE SPELLING (H-02) — a scratch repository per case, this one untouched');
    for (const t of TREE_CASES) {
      let repo: string | null = null;
      try {
        repo = scratchRepo(t.file, t.contents);
        const got = runCheck(subject, repo);
        const found = /destination configuration in the repository: (?!NONE FOUND)/.test(got.out);
        const ok = found === t.mustFind;
        if (!ok) failures += 1;
        console.log(`${t.id} ${ok ? (t.mustFind ? 'FOUND AS REQUIRED' : 'CLEAN AS REQUIRED') : 'FAILED'}  exit ${String(got.code)}`);
        console.log(`   planted : ${t.what}`);
        if (!ok)
          console.log(
            `   ! ${t.mustFind ? 'the destination was NOT found — the search is defeated by this spelling, and its NONE FOUND is a statement about what it can read, not about the tree' : 'a tree with no destination in it reported one, so every FOUND above may be an artefact of the scratch repository'}`,
          );
        else if (t.mustFind) {
          const line = got.out.split('\n').find((l) => l.includes('destination configuration in the repository:'));
          if (line !== undefined) console.log(`   it said : ${line.trim().slice(0, 150)}`);
        }
        console.log('');
      } catch (e) {
        failures += 1;
        console.log(`${t.id} FAILED    ${t.what}`);
        console.log(`   ! the scratch repository could not be built, so this law is UNPROVED here: ${(e as Error).message}`);
        console.log('');
      } finally {
        if (repo !== null) rmSync(repo, { recursive: true, force: true });
      }
    }

    // The copy is restored and re-checked, so the proof ends by showing the
    // subject green again: a mutation left behind would make every later run a
    // measurement of this proof's leftovers.
    writeFileSync(subject, pristine);
    const after = runCheck(subject);
    const restored = after.code === 0;
    console.log(`RESTORE       the copy is accepted again after every mutation: ${restored ? 'PASS' : 'FAIL'} (exit ${String(after.code)})`);
    if (!restored) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('='.repeat(78));
  if (failures === 0) {
    console.log(`ALL ${CASES.length} RED PROOFS TURNED THE CHECK RED, EACH NAMING ITS OWN DEFECT, AND ALL ${TREE_CASES.length} TREE CASES BEHAVED.`);
    console.log('  So the receiver and resolution claims are measurements: they can fail, and what');
    console.log('  makes them fail is known. UNDECIDED is now a conclusion from the rule set’s key');
    console.log('  set — if a receiver is ever recorded, R1 and R2 are what will notice.');
    return 0;
  }
  console.log(`${failures} RED PROOF(S) DID NOT REDDEN THE CHECK. The check is weaker than it claims.`);
  return 1;
}

process.exitCode = main();
