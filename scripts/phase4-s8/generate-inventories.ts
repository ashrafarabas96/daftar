#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 — THE THREE INVENTORY DOCUMENTS, GENERATED
 *
 *   npx tsx scripts/phase4-s8/generate-inventories.ts            # write them
 *   npx tsx scripts/phase4-s8/generate-inventories.ts --check     # refuse a stale one
 *
 * The documents are GENERATED, never hand-written, and `--check` refuses a
 * tree in which a committed document disagrees with the live tree. That is the
 * whole point: a hand-written inventory of a thing four agents are adding to
 * in four worktrees is wrong before it is committed, and the direction it is
 * wrong in is "fewer rows than exist" — the key nobody listed is the key
 * nobody checked.
 *
 * Every document carries the base SHA it was generated against in its header,
 * so a reader can tell whether it describes the tree in front of them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type IdempotencyKey,
  type PermissionRow,
  type SourceRow,
  discoverIdempotencyKeys,
  discoverPermissions,
  discoverSources,
  idempotencyFindings,
  inheritedSensitiveDefaults,
  permissionFindings,
  sourceFindings,
} from './inventories';

export const IDEMPOTENCY_DOC = 'docs/PHASE_4_S8_IDEMPOTENCY_INVENTORY.md';
export const PERMISSION_DOC = 'docs/PHASE_4_S8_PERMISSION_INVENTORY.md';
export const SOURCE_DOC = 'docs/PHASE_4_S8_SOURCE_INVENTORY.md';

const cell = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? '—' : value.replace(/\|/g, '\\|'));
const yesNo = (value: boolean | null): string => (value === null ? 'n/a' : value ? 'yes' : '**NO**');

function header(title: string, root: string, generator: string): string {
  let sha = '(not a git worktree)';
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    sha = '(git rev-parse HEAD failed)';
  }
  return [
    `# ${title}`,
    '',
    `**GENERATED — do not edit by hand.** Regenerate with \`npx tsx ${generator}\`; \`--check\` refuses a tree in which this file disagrees with the live one.`,
    '',
    `| | |`,
    `|---|---|`,
    `| generated from | \`${sha}\` |`,
    `| generator | \`${generator}\` |`,
    `| discovery | the migration files, the permission registry and the workflow, read at generation time — never a hand-written list |`,
    '',
  ].join('\n');
}

export function renderIdempotency(root: string, keys: readonly IdempotencyKey[]): string {
  const findings = idempotencyFindings(keys);
  return [
    header('PHASE 4 — P4-S8 — THE IDEMPOTENCY KEY INVENTORY', root, 'scripts/phase4-s8/generate-inventories.ts'),
    'Every idempotency key in the system. `P4-AL-30`: idempotency is a caller-supplied document UUID plus a stored `intent_sha256`, read before any',
    'other read, under a per-document lock. There is no `idempotency_key` column — except the one on `onboarding_operations` (`0018:7`), which is',
    'Phase 1, is listed here, and is the counter-example the decision was taken against.',
    '',
    '`[[daftar-idempotency-key-is-not-permission]]` — a bare key proves a request was SEEN before and says nothing about WHICH request it was, so a',
    'replay carrying the same key and different content would be answered "success". Hence the **intent hash** column.',
    '',
    '`[[daftar-registry-before-state]]` — the proof is consulted BEFORE any real change, or a stale request replayed after a later transition performs a',
    'second real change. Hence the **registry before change** column, which is MEASURED from the body (the intent read offset against the first',
    'INSERT/UPDATE/DELETE) rather than asserted.',
    '',
    '**THE DISCOVERY RULE**, stated so it can be refuted: a routine is a replay path if and only if its body reads an `*intent_sha256` column into a',
    'variable. That is the mechanism `P4-AL-30` names.',
    '',
    `## The ${keys.length.toString()} keys`,
    '',
    '| routine | migration | identity relation | identity arg | intent hash | identity guard | exact replay returns | changed intent conflicts on | registry before change | locks before intent | backing UNIQUEs |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...keys.map((k) =>
      [
        '',
        `\`${k.routine}\``,
        k.migration,
        `\`${k.identityRelation}\``,
        `\`${k.identityArgument}\``,
        k.intentColumn === null ? '**none**' : `\`${k.intentColumn}\``,
        k.identityGuard,
        cell(k.exactReplay),
        k.changedIntentConflict === null ? '**none found**' : `\`${k.changedIntentConflict}\``,
        yesNo(k.registryBeforeState),
        yesNo(k.locksBeforeIntent),
        k.backingUniques.length === 0 ? '—' : k.backingUniques.map((u) => `\`${u}\``).join(', '),
        '',
      ].join(' | '),
    ),
    '',
    '### The three accepted identity guards',
    '',
    'All three serialise two concurrent replays of one document, and the inventory records WHICH each routine uses rather than reporting the two that',
    'are not the advisory lock as defects:',
    '',
    '| guard | mechanism | example |',
    '|---|---|---|',
    '| `advisory` | the per-document `pg_advisory_xact_lock` `P4-AL-30` names | `customer_collect_payment` under `daftar.payment_id` |',
    '| `row` | `SELECT … FOR UPDATE` on the identity row itself | `pos_till_session_close` (`0079:1003`) |',
    '| `physical` | `INSERT … ON CONFLICT DO NOTHING`, `GET DIAGNOSTICS`, re-read and compare — the UNIQUE itself is the lock | `inventory_transfer_stock` (`0062:325-339`) |',
    '',
    `## Findings — ${findings.length.toString()}`,
    '',
    findings.length === 0
      ? '_None._ Every discovered replay path carries an intent digest, an identity guard, a registry-before-change ordering and a conflict refusal.'
      : '',
    ...findings.map((f) => `- ${f}`),
    '',
    '## What is NOT yet in this inventory, and why',
    '',
    '| key | owed by | why it is absent |',
    '|---|---|---|',
    '| the credit-note / return replay path | `P4-S5` | no `credit_notes` relation exists, so no routine reads a `credit_notes.intent_sha256` |',
    '| the refund replay path | `P4-S5` | no `refunds` relation exists |',
    '| the reversal `provider_reference` partial unique | `P4-S6` | **no column in the whole tree matches `provider_reference`.** `P4-AL-30` requires a replayed payment-provider webhook to be refused PHYSICALLY by a partial unique on `(business_id, provider_source, provider_reference)`. The S8 check for it reports `WAITING_FOR_INTEGRATED_SURFACE`, never PASS |',
    '| the installment-plan replay path | `P4-S7` | no `installment_plans` relation exists |',
    '',
  ].join('\n');
}

export function renderPermissions(root: string, rows: readonly PermissionRow[]): string {
  const findings = permissionFindings(rows);
  const inherited = inheritedSensitiveDefaults(rows);
  const phase4 = rows.filter((r) => r.phase === 'Phase 4');
  return [
    header('PHASE 4 — P4-S8 — THE PERMISSION INVENTORY', root, 'scripts/phase4-s8/generate-inventories.ts'),
    `The closed registry, discovered from \`packages/domain-core/src/permissions.ts\`: **${rows.length.toString()} keys**, of which`,
    `**${rows.filter((r) => r.sensitive).length.toString()} are sensitive** and **${phase4.length.toString()} are Phase 4's** (\`P4-AL-36\`).`,
    '',
    '`P4-AL-37`: "sensitive" means value-moving OUTSIDE the normal operating flow — not "everything except a read". `OD-P4-01` OPTION A: no SENSITIVE',
    'Phase 4 key may be a DEFAULT of any built-in role, the cashier and the manager included.',
    '',
    'The **migration assertion** column is the one-shot migration-time `DO`-block assertion that raises `permission_backfill_overreach`',
    '(`0041:57-65`, `0057:140-151`, and the Phase 4 one `P4-AL-37` requires). There is no `CHECK`, no trigger and no exclusion constraint on',
    '`role_permissions`, so that assertion is the ONLY thing in the database that binds a key — which is why its absence is a finding.',
    '',
    '## Every key',
    '',
    '| key | phase | sensitive | built-in defaults | migration assertion | required by |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) =>
      [
        '',
        `\`${r.key}\``,
        r.phase,
        r.sensitive ? '**yes**' : 'no',
        r.defaultRoles.length === 0 ? '—' : r.defaultRoles.join(', '),
        cell(r.migrationAssertion),
        r.requiredBy.length === 0 ? '—' : `${r.requiredBy.length.toString()} file(s)`,
        '',
      ].join(' | '),
    ),
    '',
    `## Findings — ${findings.length.toString()}`,
    '',
    findings.length === 0 ? '_None._ No sensitive Phase 4 key is a built-in default, and every Phase 4 key is bound by a migration-time assertion.' : '',
    ...findings.map((f) => `- ${f}`),
    '',
    `## Recorded, NOT a finding — inherited sensitive defaults (${inherited.length.toString()})`,
    '',
    '`OD-P4-01` OPTION A is a ruling about PHASE 4 sensitive keys and is not retroactive over Phase 1 and Phase 2 classifications. These keys are',
    'sensitive AND are built-in defaults of a non-owner role; they are accepted surface, reporting them as a Phase 4 finding would be an over-claim',
    'against a sealed decision, and omitting them entirely would make this inventory look like it had not looked.',
    '',
    '| key | phase | default of |',
    '|---|---|---|',
    ...inherited.map((r) => `| \`${r.key}\` | ${r.phase} | ${r.defaultRoles.filter((x) => x !== 'owner').join(', ')} |`),
    '',
  ].join('\n');
}

export function renderSources(root: string, rows: readonly SourceRow[]): string {
  const findings = sourceFindings(rows);
  const by = (kind: SourceRow['kind']): readonly SourceRow[] => rows.filter((r) => r.kind === kind);
  return [
    header('PHASE 4 — P4-S8 — THE ACCOUNTING SOURCE, STOCK SOURCE AND OPERATION-KIND INVENTORY', root, 'scripts/phase4-s8/generate-inventories.ts'),
    `Discovered from the \`INSERT INTO\` statements of the migration estate: **${by('accounting-source-type').length.toString()} accounting source types**,`,
    `**${by('stock-source-type').length.toString()} stock source types**, **${by('operation-kind').length.toString()} operation kinds**.`,
    '',
    '`TL-P4-S1-R1` and `TL-P4-S2-K1`: an accounting source type may not exist as a dead registry concept, and an `inventory_operation_kinds` row is a',
    'registration of AUTHORITY — registering one with no writer creates live authority with no command. The **writer** column is therefore measured as',
    '"the name appears somewhere other than its own registration INSERT", and `no` is a finding.',
    '',
    '## Accounting source types',
    '',
    '| source type | registered by | binds its entry | deferred completeness validator | writer |',
    '|---|---|---|---|---|',
    ...by('accounting-source-type').map(
      (r) =>
        `| \`${r.name}\` | ${r.migration} | ${r.hasBinding ? 'yes' : '**no**'} | ${r.hasCompletenessValidator ? 'yes' : 'no'} | ${r.hasWriter ? 'yes' : '**no**'} |`,
    ),
    '',
    '## Stock source types',
    '',
    '| source type | registered by | writer |',
    '|---|---|---|',
    ...by('stock-source-type').map((r) => `| \`${r.name}\` | ${r.migration} | ${r.hasWriter ? 'yes' : '**no**'} |`),
    '',
    '## Operation kinds',
    '',
    '| op code | registered by | writer |',
    '|---|---|---|',
    ...by('operation-kind').map((r) => `| \`${r.name}\` | ${r.migration} | ${r.hasWriter ? 'yes' : '**no**'} |`),
    '',
    `## Findings — ${findings.length.toString()}`,
    '',
    findings.length === 0 ? '_None._ Every registry row has a writer, and every accounting source type binds its entry.' : '',
    ...findings.map((f) => `- ${f}`),
    '',
    '## The two rows deliberately exempt',
    '',
    '`probe_0074` (a `stock_source_types` row) and `sale.probe` (an `inventory_operation_kinds` row) exist in `0074`'.concat(
      "'s own `DO` block only to PROVE the widened `registered_by` CHECK accepts a Phase 4 registrant, and are rolled back inside it. They are named here so the writer finding is not reported for them, rather than being filtered silently.",
    ),
    '',
    '## What is NOT yet registered, and why',
    '',
    '| source type | owed by | why |',
    '|---|---|---|',
    '| `credit_note` | `P4-S5` | the relation does not exist; registering the type first would be the dead registry concept `TL-P4-S1-R1` refused |',
    '| `refund` | `P4-S5` | the same |',
    '| `allocation_reversal` | `P4-S6` | the same |',
    '| `sale.void` (operation kind) | `P4-S6` | `TL-P4-S2-K1`: registering it in S2 would have created live authority with no writer |',
    '| `sale.return` (operation kind) | `P4-S5` | the same |',
    '',
  ].join('\n');
}

export function generate(root: string): ReadonlyMap<string, string> {
  return new Map([
    [IDEMPOTENCY_DOC, renderIdempotency(root, discoverIdempotencyKeys(root))],
    [PERMISSION_DOC, renderPermissions(root, discoverPermissions(root))],
    [SOURCE_DOC, renderSources(root, discoverSources(root))],
  ]);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg === undefined ? join(__dirname, '..', '..') : rootArg.slice('--root='.length);
  const check = args.includes('--check');
  const documents = generate(root);
  let stale = 0;
  for (const [relative, content] of documents) {
    const path = join(root, relative);
    if (check) {
      // The generated-from SHA line necessarily differs between a generation
      // and a later check, so it is excluded from the comparison: a document
      // is stale when its CONTENT disagrees, not when the commit moved.
      const live = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (withoutShaLine(live) !== withoutShaLine(content)) {
        stale += 1;
        console.error(`STALE ${relative} — the committed document disagrees with the live tree; regenerate it`);
      } else console.log(`ok    ${relative}`);
    } else {
      writeFileSync(path, content, 'utf8');
      console.log(`wrote ${relative} (${content.split('\n').length.toString()} lines)`);
    }
  }
  if (check) {
    console.log(
      stale === 0
        ? `PASS: all ${documents.size.toString()} inventory documents agree with the live tree`
        : `FAIL: ${stale.toString()} stale inventory document(s)`,
    );
    process.exit(stale === 0 ? 0 : 1);
  }
}

function withoutShaLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('| generated from |'))
    .join('\n');
}
