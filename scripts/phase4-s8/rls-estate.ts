#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE RLS ESTATE CHECKER
 *
 * `P4-AL-38`: every Phase 4 relation carries `ENABLE ROW LEVEL SECURITY` AND
 * `FORCE`; one permissive tenant policy; FOUR `RESTRICTIVE` per-command
 * isolation policies; plus `inventory_internal_read`; and on an
 * ACCOUNTING-SOURCE relation also `accounting_validator`. So the accepted
 * count is SIX policies on an ordinary relation and SEVEN on an
 * accounting-source relation — not five (`TL-P4-S1-C2`).
 *
 * The first draft of that decision said five, and the consequence of the
 * missing seventh is the reason this checker exists at all: omitting
 * `accounting_validator` on an accounting-source relation under `FORCE ROW
 * LEVEL SECURITY` makes the DEFERRED COMPLETENESS VALIDATOR read ZERO ROWS AND
 * PASS VACUOUSLY. That is the worst failure available here — a green gate over
 * an unchecked invariant — and it is invisible to any check that counts
 * policies without knowing which relations are accounting sources.
 *
 * TWO READS, AND THE LIVE ONE IS THE AUTHORITATIVE ONE.
 *
 *   `staticEstate` reads the migration text. It is what the framework can
 *   assert today, and it is enough to decide SUBJECT REALITY.
 *   `liveEstateProblems` takes rows read from `pg_class` and `pg_policy` and
 *   is the semantic evaluation — `[[daftar-the-live-catalogue-is-the-policy]]`.
 *   A migration can say anything; the catalogue is what admits a principal.
 *
 * The red proof plants a REAL relation with RLS enabled, FORCE missing and
 * three policies, reads the CATALOGUE, requires the finding, and drops it.
 */
import { type TreeFacts, readTree } from './tree';

/** The tenant policy's accepted direct form (`0052:305-330`), not the correlated one. */
export const TENANT_POLICY_FORM = "tenant_id = nullif(app_tenant(), '')::uuid";

export const REQUIRED_RESTRICTIVE_COMMANDS: readonly string[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

export interface RelationEstate {
  readonly relation: string;
  readonly migration: string;
  readonly rowSecurityEnabled: boolean;
  readonly rowSecurityForced: boolean;
  readonly policies: readonly string[];
  /** Is this relation an accounting SOURCE relation, so the seventh policy is owed? */
  readonly accountingSource: boolean;
  readonly expectedPolicyCount: number;
}

/**
 * The Phase 4 relations, DISCOVERED: created by a migration numbered 0074 or
 * above. Scoped BY INTENT (`TL-P4-S1-R2`, ruled and discharged) rather than
 * widened into a tree-wide law, which would fail accepted non-commercial
 * relations that legitimately carry no RLS.
 */
export function phase4Relations(facts: TreeFacts): string[] {
  const out: string[] = [];
  for (const [relation, migration] of facts.relations) {
    const ordinal = Number.parseInt(migration.slice(0, 4), 10);
    if (Number.isNaN(ordinal) || ordinal < 74) continue;
    out.push(relation);
  }
  return out.sort();
}

export function staticEstate(root: string): RelationEstate[] {
  const facts = readTree(root);
  const allText = facts.migrations.map((m) => m.text).join('\n');
  return phase4Relations(facts).map((relation) => {
    const policies = [...facts.policies]
      .filter((p) => p.startsWith(`${relation}.`))
      .map((p) => p.slice(relation.length + 1))
      .sort();
    const enable = new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${relation}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(allText);
    const force = new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${relation}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(allText);
    const accountingSource = policies.includes('accounting_validator') || isAccountingSourceRelation(facts, relation);
    return {
      relation,
      migration: facts.relations.get(relation) ?? 'unknown',
      rowSecurityEnabled: enable,
      rowSecurityForced: force,
      policies,
      accountingSource,
      expectedPolicyCount: accountingSource ? 7 : 6,
    };
  });
}

/**
 * An accounting-source relation is one a registered accounting source type
 * names. Derived from the source-type registry rather than from a list, so a
 * relation added with its own source type in a later slice is covered without
 * anybody editing this file.
 */
function isAccountingSourceRelation(facts: TreeFacts, relation: string): boolean {
  const singular = relation.endsWith('s') ? relation.slice(0, -1) : relation;
  return facts.accountingSourceTypes.has(singular) || facts.accountingSourceTypes.has(relation);
}

/**
 * The static problems. A relation created by a Phase 4 migration that is NOT a
 * tenant-scoped commercial relation is not a finding — some Phase 4
 * migrations create bridge and registry relations whose policy sets differ.
 * So the count rule is applied to relations that have a tenant policy at all,
 * and a relation with NO policy whatsoever is reported separately, with its
 * own words, because that is the more serious shape.
 */
export function staticEstateProblems(root: string): string[] {
  const problems: string[] = [];
  const estate = staticEstate(root);
  if (estate.length === 0) problems.push('no Phase 4 relation was discovered at all — an empty estate is never a protected one');
  for (const relation of estate) {
    if (relation.policies.length === 0) {
      problems.push(`${relation.relation} (${relation.migration}) carries NO policy at all`);
      continue;
    }
    if (!relation.rowSecurityEnabled) problems.push(`${relation.relation}: no ENABLE ROW LEVEL SECURITY — its policies are written and not in force`);
    if (!relation.rowSecurityForced)
      problems.push(`${relation.relation}: no FORCE ROW LEVEL SECURITY — the table owner bypasses every policy, and a definer routine runs AS the owner`);
    if (relation.policies.length < relation.expectedPolicyCount)
      problems.push(
        `${relation.relation}: ${relation.policies.length.toString()} policies (${relation.policies.join(', ')}), expected ${relation.expectedPolicyCount.toString()} ` +
          `(${relation.accountingSource ? 'an ACCOUNTING-SOURCE relation: tenant + four RESTRICTIVE + inventory_internal_read + accounting_validator' : 'tenant + four RESTRICTIVE + inventory_internal_read'})`,
      );
    if (relation.accountingSource && !relation.policies.includes('accounting_validator'))
      problems.push(
        `${relation.relation} is an accounting-source relation with NO accounting_validator policy — under FORCE ROW LEVEL SECURITY ` +
          'the deferred completeness validator reads ZERO rows and passes VACUOUSLY (TL-P4-S1-C2)',
      );
  }
  return problems;
}

// ───────────── THE LIVE CATALOGUE — THE AUTHORITATIVE READ ────────────────

/** One row of `pg_class`, as the estate query returns it. */
export interface LiveRelationRow {
  readonly relname: string;
  readonly relrowsecurity: boolean;
  readonly relforcerowsecurity: boolean;
}

/** One row of `pg_policy`, as the estate query returns it. */
export interface LivePolicyRow {
  readonly relname: string;
  readonly polname: string;
  /** `pg_policy.polpermissive`: false is RESTRICTIVE. */
  readonly permissive: boolean;
  /** `pg_policy.polcmd`: `r`/`a`/`w`/`d`/`*`. */
  readonly command: string;
  /** `pg_get_expr(polqual, polrelid)`, or null. */
  readonly using: string | null;
}

/** The query the checker runs. Exported so the suite runs exactly this text. */
export const LIVE_RELATION_SQL = `
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
 ORDER BY c.relname`;

export const LIVE_POLICY_SQL = `
SELECT c.relname, p.polname, p.polpermissive AS permissive, p.polcmd AS command,
       pg_get_expr(p.polqual, p.polrelid) AS using
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
 ORDER BY c.relname, p.polname`;

/**
 * THE SEMANTIC EVALUATION.
 *
 * `[[daftar-the-live-catalogue-is-the-policy]]`. Everything here is read from
 * `pg_class` and `pg_policy`: whether row security is enabled, whether it is
 * FORCED, how many policies there are, how many are RESTRICTIVE, which
 * commands they cover, and whether the tenant policy takes the accepted DIRECT
 * form rather than the correlated subselect `0052` measured and removed.
 *
 * `expectedCounts` is supplied by the caller rather than recomputed here, so
 * the live read and the static read cannot silently disagree about which
 * relations are accounting sources.
 */
export function liveEstateProblems(
  relations: readonly LiveRelationRow[],
  policies: readonly LivePolicyRow[],
  expectedCounts: ReadonlyMap<string, number>,
  options: { readonly requireTenantDirectForm?: boolean } = {},
): string[] {
  const problems: string[] = [];
  if (relations.length === 0)
    problems.push('the live estate query returned NO relation — an empty result set is never a refusal, and it is certainly not a pass');
  for (const relation of relations) {
    const own = policies.filter((p) => p.relname === relation.relname);
    if (!relation.relrowsecurity) problems.push(`${relation.relname}: pg_class.relrowsecurity is false — row security is OFF in the live catalogue`);
    if (!relation.relforcerowsecurity)
      problems.push(
        `${relation.relname}: pg_class.relforcerowsecurity is false — the table owner bypasses every policy, and every definer routine runs AS an owner`,
      );
    const expected = expectedCounts.get(relation.relname);
    if (expected !== undefined && own.length < expected)
      problems.push(
        `${relation.relname}: ${own.length.toString()} live policies (${own.map((p) => p.polname).join(', ') || 'none'}), expected ${expected.toString()}`,
      );
    const restrictive = own.filter((p) => !p.permissive);
    if (restrictive.length < REQUIRED_RESTRICTIVE_COMMANDS.length)
      problems.push(
        `${relation.relname}: ${restrictive.length.toString()} RESTRICTIVE policies, expected ${REQUIRED_RESTRICTIVE_COMMANDS.length.toString()} ` +
          '(one per command) — a permissive-only set is an OR of grants, so one loose policy admits everything',
      );
    const commands = new Set(restrictive.map((p) => p.command));
    for (const [command, code] of [
      ['SELECT', 'r'],
      ['INSERT', 'a'],
      ['UPDATE', 'w'],
      ['DELETE', 'd'],
    ] as const)
      if (!commands.has(code) && !commands.has('*')) problems.push(`${relation.relname}: no RESTRICTIVE policy covers ${command} (polcmd '${code}')`);
    if (expected !== undefined && expected === 7 && !own.some((p) => p.polname === 'accounting_validator'))
      problems.push(
        `${relation.relname} is an accounting-source relation and the live catalogue holds NO accounting_validator policy — ` +
          'under FORCE the deferred completeness validator reads ZERO rows and passes VACUOUSLY (TL-P4-S1-C2)',
      );
    if (options.requireTenantDirectForm === true) {
      const tenant = own.find((p) => p.polname.includes('tenant'));
      if (tenant === undefined) problems.push(`${relation.relname}: no tenant policy in the live catalogue`);
      else if (tenant.using !== null && /SELECT/i.test(tenant.using) && !tenant.using.includes('app_tenant'))
        problems.push(
          `${relation.relname}: the tenant policy's USING expression is a correlated subselect — ` +
            `0052 measured that shape and replaced it with the direct form \`${TENANT_POLICY_FORM}\`, which is the SECOND per-row cost it removed`,
        );
    }
  }
  return problems;
}

/** The expected policy count per relation, from the static estate: one source of that opinion. */
export function expectedPolicyCounts(root: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const relation of staticEstate(root)) if (relation.policies.length > 0) out.set(relation.relation, relation.expectedPolicyCount);
  return out;
}
