/**
 * P3-S9 T-08 — THE DEPLOYMENT MATRIX'S DECISIONS, EACH ABLE TO SAY NO.
 *
 * `scripts/phase2-deployment-authority.ts` (A-09) decides four things from
 * catalogue rows: whether the deployer's memberships are exactly the accepted
 * three (2.11), whether two catalogues differ in any §10 family, whether any
 * role but the deployer — or PUBLIC — holds TEMPORARY or CREATE on `public`
 * (11.9 / 11.10), and which files each Case H upgrade must apply. Each is an
 * exported pure function, so each is proved here red on a planted defect and
 * green on the accepted shape, without a cluster. The live run is
 * `npm run check:deployment-authority` (T-09).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_DEPLOYER_MEMBERSHIPS,
  CATALOGUE_FAMILIES,
  CATALOGUE_QUERIES,
  PUBLIC_GRANTEE,
  appliedExactly,
  catalogueDifferences,
  deployerMembershipProblems,
  namespacePrivilegeProblems,
  normaliseCatalogueRows,
  sliceUpgradePlan,
  type CatalogueSnapshot,
  type MembershipRow,
  type NamespacePrivilegeRow,
} from '../../scripts/phase2-deployment-authority';
import { PHASE2_PREFIX_END } from '../../scripts/phase2-prefix';
import { PHASE3_SLICE_HEADS } from '../../scripts/phase3-prefix';

const REPO = join(__dirname, '../..');

/** The accepted three, written out here rather than imported, so a change to the script's list is a change this file sees. */
const ACCEPTED: readonly MembershipRow[] = [
  { role: 'daftar_accounting_internal', inherit: false, set: true, admin: false },
  { role: 'daftar_inventory_internal', inherit: false, set: true, admin: false },
  { role: 'daftar_platform', inherit: true, set: true, admin: false },
];
const replace = (role: string, patch: Partial<MembershipRow>): MembershipRow[] => ACCEPTED.map((m) => (m.role === role ? { ...m, ...patch } : m));

describe('2.11 — the deployer holds exactly the accepted three memberships', () => {
  it('the script accepts exactly the three bootstrap.sql grants', () => {
    expect(ACCEPTED_DEPLOYER_MEMBERSHIPS).toEqual(ACCEPTED);
    const bootstrap = readFileSync(join(REPO, 'infrastructure/database/bootstrap.sql'), 'utf8');
    const grants = [...bootstrap.matchAll(/^GRANT\s+(daftar_[a-z_]+)\s+TO\s+daftar_migrator\s+WITH\s+INHERIT\s+(TRUE|FALSE),\s*SET\s+(TRUE|FALSE)\s*;/gim)]
      .map((m) => ({ role: m[1] ?? '', inherit: m[2]?.toUpperCase() === 'TRUE', set: m[3]?.toUpperCase() === 'TRUE', admin: false }))
      .sort((a, b) => a.role.localeCompare(b.role));
    expect(grants).toEqual(ACCEPTED);
  });

  it('passes on the accepted rows, in any order', () => {
    expect(deployerMembershipProblems(ACCEPTED)).toEqual([]);
    expect(deployerMembershipProblems([...ACCEPTED].reverse())).toEqual([]);
  });

  it('fails on INHERIT TRUE for the accounting authority', () => {
    expect(deployerMembershipProblems(replace('daftar_accounting_internal', { inherit: true }))).toEqual([
      'daftar_accounting_internal has INHERIT TRUE; accepted is FALSE',
    ]);
  });

  it('fails on INHERIT TRUE for the inventory authority', () => {
    expect(deployerMembershipProblems(replace('daftar_inventory_internal', { inherit: true }))).toEqual([
      'daftar_inventory_internal has INHERIT TRUE; accepted is FALSE',
    ]);
  });

  it('fails on INHERIT FALSE for the platform membership, and on SET FALSE for an internal one', () => {
    expect(deployerMembershipProblems(replace('daftar_platform', { inherit: false }))).toEqual(['daftar_platform has INHERIT FALSE; accepted is TRUE']);
    expect(deployerMembershipProblems(replace('daftar_inventory_internal', { set: false }))).toEqual([
      'daftar_inventory_internal has SET FALSE; accepted is TRUE',
    ]);
  });

  it('fails on ADMIN OPTION', () => {
    expect(deployerMembershipProblems(replace('daftar_platform', { admin: true }))).toEqual(['daftar_platform carries ADMIN OPTION']);
  });

  it('fails on a fourth membership', () => {
    const problems = deployerMembershipProblems([...ACCEPTED, { role: 'daftar_app', inherit: false, set: true, admin: false }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^daftar_app is a membership the accepted deployer does not hold/);
  });

  it('fails on a missing membership', () => {
    const problems = deployerMembershipProblems(ACCEPTED.filter((m) => m.role !== 'daftar_inventory_internal'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^daftar_inventory_internal is missing/);
    expect(deployerMembershipProblems([])).toHaveLength(3);
  });

  it('fails on the same membership granted twice, even with identical options', () => {
    const problems = deployerMembershipProblems([...ACCEPTED, { role: 'daftar_platform', inherit: true, set: true, admin: false }]);
    expect(problems).toEqual(['daftar_platform is granted 2 times; its effective options are the union of all of them']);
  });
});

/** A small but realistically shaped catalogue: one row per family, in the form the §10 queries produce. */
function catalogue(): Record<string, string[]> {
  return {
    tables: ['accounts | <applier> | true | true | {<applier>=arwdDxtm/<applier>,daftar_app=r/<applier>}'],
    functions: [
      'supplier_pay(p uuid) | daftar_inventory_internal | true | {daftar_inventory_internal=X/daftar_inventory_internal} | {search_path=pg_catalog} | 5f0c1d',
    ],
    policies: ['accounts.tenant_isolation | * | true | (business_id = app_business_id()) |  | daftar_app'],
    triggers: ['journal_lines.journal_lines_guard | 23 | O | false | false | journal_lines_guard'],
    columnAcls: ['users.password_hash | {daftar_identity=r/<applier>}'],
    constraints: ['purchases.purchases_tax_policy_absent_ck | c | CHECK ((tax_minor = 0))'],
    sequences: ['stock_seq | <applier> | {<applier>=rwU/<applier>,daftar_inventory_internal=U/<applier>}'],
    indexes: ['journal_lines.journal_lines_entry_idx | CREATE INDEX journal_lines_entry_idx ON public.journal_lines USING btree (entry_id)'],
    columns: ['purchases.tax_minor | bigint | true | 0 |  | '],
    schema: ['public | daftar_migrator | {daftar_migrator=UC/daftar_migrator,daftar_app=U/daftar_migrator}'],
    defaultAcls: ['<applier> | public | r | {daftar_app=r/<applier>}'],
    extensions: ['btree_gist | 1.7', 'citext | 1.6', 'pgcrypto | 1.3'],
  };
}
const changeOne = (family: string, from: string, to: string): CatalogueSnapshot => {
  const c = catalogue();
  c[family] = (c[family] ?? []).map((r) => r.replace(from, to));
  return c;
};

describe('§10 — two catalogues that differ in any family are told apart', () => {
  it('the §10 families include every family A-09 2 adds, and the added queries read what they claim', () => {
    for (const f of ['tables', 'functions', 'policies', 'triggers', 'columnAcls', 'constraints']) expect(CATALOGUE_FAMILIES).toContain(f);
    expect(CATALOGUE_FAMILIES.slice(6)).toEqual(['sequences', 'indexes', 'columns', 'schema', 'defaultAcls', 'extensions']);
    expect(CATALOGUE_QUERIES['functions']).toMatch(/md5\(p\.prosrc\)/);
    expect(CATALOGUE_QUERIES['sequences']).toMatch(/relkind = 'S'/);
    expect(CATALOGUE_QUERIES['sequences']).toMatch(/relacl/);
    expect(CATALOGUE_QUERIES['indexes']).toMatch(/indexdef/);
    expect(CATALOGUE_QUERIES['columns']).toMatch(/format_type\(a\.atttypid, a\.atttypmod\)[\s\S]*attnotnull[\s\S]*pg_get_expr\(d\.adbin, d\.adrelid\)/);
    expect(CATALOGUE_QUERIES['schema']).toMatch(/nspowner[\s\S]*nspacl/);
    expect(CATALOGUE_QUERIES['defaultAcls']).toMatch(/pg_default_acl/);
    expect(CATALOGUE_QUERIES['extensions']).toMatch(/extversion/);
  });

  it('identical catalogues have no difference', () => {
    expect(catalogueDifferences(catalogue(), catalogue(), CATALOGUE_FAMILIES)).toEqual([]);
  });

  const planted: readonly (readonly [what: string, family: string, from: string, to: string])[] = [
    ['a single differing index', 'indexes', 'btree (entry_id)', 'btree (entry_id, id)'],
    ['a sequence ACL', 'sequences', 'daftar_inventory_internal=U', 'daftar_app=U'],
    ['a column default', 'columns', '| 0 |', '| 1 |'],
    ['a default-ACL row', 'defaultAcls', 'daftar_app=r', 'daftar_app=arwd'],
    ['a schema ACL', 'schema', 'daftar_app=U/', 'daftar_app=UC/'],
    ['an extension version', 'extensions', 'pgcrypto | 1.3', 'pgcrypto | 1.2'],
    ['a function body digest', 'functions', '| 5f0c1d', '| 9a7e2b'],
    ['a table owner', 'tables', 'accounts | <applier>', 'accounts | daftar_platform'],
  ];
  for (const [what, family, from, to] of planted) {
    it(`flags ${what}, and only its family`, () => {
      const d = catalogueDifferences(catalogue(), changeOne(family, from, to), CATALOGUE_FAMILIES);
      expect(d.map((x) => x.family)).toEqual([family]);
      expect(d[0]?.onlyFirst).toHaveLength(1);
      expect(d[0]?.onlySecond).toHaveLength(1);
    });
  }

  it('flags a row present in one catalogue only, a duplicated row, and a family one catalogue lacks', () => {
    const extra = catalogue();
    extra['indexes'] = [...(extra['indexes'] ?? []), 'x.x_idx | CREATE INDEX x_idx ON public.x USING btree (a)'];
    expect(catalogueDifferences(catalogue(), extra, CATALOGUE_FAMILIES).map((d) => d.family)).toEqual(['indexes']);
    const twice = catalogue();
    twice['extensions'] = [...(twice['extensions'] ?? []), 'citext | 1.6'];
    expect(catalogueDifferences(catalogue(), twice, CATALOGUE_FAMILIES).map((d) => d.family)).toEqual(['extensions']);
    const lacking = catalogue();
    delete lacking['sequences'];
    expect(catalogueDifferences(catalogue(), lacking, CATALOGUE_FAMILIES).map((d) => d.family)).toEqual(['sequences']);
    expect(catalogueDifferences(lacking, lacking, CATALOGUE_FAMILIES).map((d) => d.family)).toEqual(['sequences']);
  });

  it("normalises only the applier's own name, and never in the bootstrap-made families", () => {
    expect(normaliseCatalogueRows('tables', ['t | daftar_migrator | {daftar_app=r/daftar_migrator}'], 'daftar_migrator')).toEqual([
      't | <applier> | {daftar_app=r/<applier>}',
    ]);
    expect(normaliseCatalogueRows('tables', ['t | daftar_platform'], 'daftar_migrator')).toEqual(['t | daftar_platform']);
    const schema = ['public | daftar_migrator | {daftar_migrator=UC/daftar_migrator}'];
    expect(normaliseCatalogueRows('schema', schema, 'daftar_migrator')).toEqual(schema);
    expect(normaliseCatalogueRows('extensions', ['citext | 1.6'], 'postgres')).toEqual(['citext | 1.6']);
  });
});

const ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
  'daftar_accounting_internal',
  'daftar_inventory_internal',
];
function privileges(patch: Record<string, Partial<NamespacePrivilegeRow>> = {}): NamespacePrivilegeRow[] {
  return [...ROLES, 'daftar_migrator', PUBLIC_GRANTEE].map((role) => ({
    role,
    temporaryOnDatabase: role === 'daftar_migrator',
    createOnPublic: role === 'daftar_migrator',
    ...patch[role],
  }));
}

describe('11.9 / 11.10 — TEMPORARY and CREATE on public, for every role and PUBLIC', () => {
  it('passes when only the deployer holds either', () => {
    expect(namespacePrivilegeProblems(privileges(), 'deployer build')).toEqual([]);
  });

  it('flags a runtime role holding TEMPORARY', () => {
    expect(namespacePrivilegeProblems(privileges({ daftar_app: { temporaryOnDatabase: true } }), 'deployer build')).toEqual([
      'deployer build: daftar_app holds TEMPORARY on the database',
    ]);
  });

  it('flags a runtime role holding CREATE on public', () => {
    expect(namespacePrivilegeProblems(privileges({ daftar_reconciler: { createOnPublic: true } }), 'superuser control')).toEqual([
      'superuser control: daftar_reconciler holds CREATE on schema public',
    ]);
  });

  it('flags an internal authority holding CREATE on public in a committed state', () => {
    expect(namespacePrivilegeProblems(privileges({ daftar_inventory_internal: { createOnPublic: true } }), 'b')).toEqual([
      'b: daftar_inventory_internal holds CREATE on schema public',
    ]);
  });

  it('flags PUBLIC holding TEMPORARY or CREATE', () => {
    expect(namespacePrivilegeProblems(privileges({ [PUBLIC_GRANTEE]: { temporaryOnDatabase: true } }), 'b')).toEqual([
      'b: PUBLIC holds TEMPORARY on the database',
    ]);
    expect(namespacePrivilegeProblems(privileges({ [PUBLIC_GRANTEE]: { createOnPublic: true } }), 'b')).toEqual(['b: PUBLIC holds CREATE on schema public']);
  });

  it('refuses a set of rows that never asked PUBLIC', () => {
    expect(
      namespacePrivilegeProblems(
        privileges().filter((r) => r.role !== PUBLIC_GRANTEE),
        'b',
      ),
    ).toEqual(['b: PUBLIC was not asked']);
  });
});

describe('Case H — the Phase 3 slice heads, one upgrade at a time', () => {
  const files = readdirSync(join(REPO, 'infrastructure/database/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('on the real tree: the Phase 2 prefix, one step per accepted slice, then every later file, covering each file exactly once', () => {
    const plan = sliceUpgradePlan(files, PHASE2_PREFIX_END, PHASE3_SLICE_HEADS);
    expect(plan.problems).toEqual([]);
    expect(plan.base.at(-1)).toBe(PHASE2_PREFIX_END);
    expect(plan.steps.map((s) => s.label)).toEqual([
      ...Object.keys(PHASE3_SLICE_HEADS).map((k) => `${k} (${PHASE3_SLICE_HEADS[k as keyof typeof PHASE3_SLICE_HEADS].slice(0, 4)})`),
      'every later migration',
    ]);
    expect([...plan.base, ...plan.steps.flatMap((s) => s.expected)]).toEqual(files);
    const byLabel = new Map(plan.steps.map((s) => [s.label.slice(0, 5), s.expected] as const));
    expect(byLabel.get('P3-S1')?.[0]).toBe('0053_inventory_units_and_product_configuration.sql');
    expect(byLabel.get('P3-S1')?.at(-1)).toBe(PHASE3_SLICE_HEADS['P3-S1']);
    expect(byLabel.get('P3-S7')).toEqual([]); // P3-S7 shipped no migration: the step must apply none
    expect(byLabel.get('P3-S8')).toEqual([PHASE3_SLICE_HEADS['P3-S8']]);
  });

  it('a later forward migration lands in the last step, never in a slice step', () => {
    const plan = sliceUpgradePlan([...files, '0070_a_later_forward_migration.sql'], PHASE2_PREFIX_END, PHASE3_SLICE_HEADS);
    expect(plan.problems).toEqual([]);
    expect(plan.steps.at(-1)?.expected).toEqual(['0070_a_later_forward_migration.sql']);
  });

  it('refuses a head that is not on disk, one that goes backwards, and one at or before the base', () => {
    const missing = sliceUpgradePlan(
      files.filter((f) => f !== PHASE3_SLICE_HEADS['P3-S4']),
      PHASE2_PREFIX_END,
      PHASE3_SLICE_HEADS,
    );
    expect(missing.problems).toEqual([`P3-S4's head ${PHASE3_SLICE_HEADS['P3-S4']} is not on disk`]);
    const backwards = sliceUpgradePlan(files, PHASE2_PREFIX_END, { a: PHASE3_SLICE_HEADS['P3-S3'], b: PHASE3_SLICE_HEADS['P3-S2'] });
    expect(backwards.problems).toEqual([`b's head ${PHASE3_SLICE_HEADS['P3-S2']} sorts before the previous boundary ${PHASE3_SLICE_HEADS['P3-S3']}`]);
    const early = sliceUpgradePlan(files, PHASE2_PREFIX_END, { a: '0050_accounting_report_indexes.sql' });
    expect(early.problems).toContain(`a's head 0050_accounting_report_indexes.sql is not after the base ${PHASE2_PREFIX_END}`);
  });

  it('a step passes only when the runner applied exactly its files, in order', () => {
    expect(appliedExactly(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(appliedExactly([], [])).toBe(true);
    expect(appliedExactly(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(appliedExactly(['a', 'b'], ['a'])).toBe(false);
    expect(appliedExactly(['a'], ['a', 'b'])).toBe(false);
    expect(appliedExactly([], ['a'])).toBe(false);
  });
});

describe('the module is importable', () => {
  it('importing it starts no cluster and runs no section', () => {
    const tsx = join(REPO, 'node_modules/.bin/tsx');
    const child = spawnSync(
      tsx,
      ['-e', "const m = require('./scripts/phase2-deployment-authority.ts'); console.log('IMPORTED', typeof m.deployerMembershipProblems);"],
      {
        cwd: REPO,
        encoding: 'utf8',
        // A cluster that tried to start would fail on these binaries at once, not hang.
        env: { ...process.env, DEPLOY_PG_BIN: '/nonexistent/daftar-deploy-pg-bin', DEPLOY_PG_PORT: '1' },
      },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('IMPORTED function');
    expect(`${child.stdout}${child.stderr}`).not.toMatch(/DEPLOYMENT AUTHORITY/);
  });
});
