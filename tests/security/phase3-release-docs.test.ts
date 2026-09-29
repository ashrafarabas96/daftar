/**
 * T-04 — THE PHASE 3 DOCUMENTS AGREE WITH REALITY (docs/PHASE_3_S9_CONTRACT.md
 * A-07, §7 T-04).
 *
 * Step 4 of `gate:phase3:release` reads the authoritative Phase 3 pages for
 * the specific stale claims that would describe the accepted state as open,
 * for unfilled `{{…}}` placeholders in them and in every Phase 3 acceptance
 * page, and for the statements the release must make. Each case below plants
 * exactly one thing in a temporary tree of release-state pages and asks the
 * gate's own check about it.
 *
 *   - each claim, in each page → a finding naming the file and line;
 *   - the same line marked historical → no finding;
 *   - a placeholder in an acceptance page → a finding, even marked historical;
 *   - the required OD-03 and MAIN_PROTECTION_EXTERNAL_BLOCKER texts removed →
 *     a finding; a page missing → a finding.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE3_AUTHORITATIVE_DOCS, documentFindings } from '../../scripts/phase3-release-gate';

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const STATUS = 'PROJECT_STATUS.md';
const RELEASE = 'docs/PHASE_3_S9_RELEASE.md';
const ACCEPTANCE = 'docs/PHASE_3_S7_ACCEPTANCE.md';

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

/** A tree of release-state pages: every required statement made, no stale claim. */
function pages(): string {
  const root = mkdtempSync(join(tmpdir(), 'daftar-p3-docs-'));
  temporaries.push(root);
  for (const rel of PHASE3_AUTHORITATIVE_DOCS) write(root, rel, `# ${rel}\n\nP3-S8 is accepted and frozen through 0069.\n`);
  write(root, STATUS, `# Status\n\n- **OD-03 — purchase tax: OPEN.** A non-zero purchase tax is refused.\n`);
  write(root, RELEASE, `# P3-S9 release\n\nPurchase tax stays BLOCKED BY OD-03.\nBranch protection: MAIN_PROTECTION_EXTERNAL_BLOCKER.\n`);
  write(root, ACCEPTANCE, `# P3-S7 acceptance\n\nCandidate f64f399.\n`);
  return root;
}

/** Append one line to a page and answer its 1-based line number. */
function plant(root: string, rel: string, line: string): number {
  const before = readFileSync(join(root, rel), 'utf8');
  writeFileSync(join(root, rel), `${before}${line}\n`);
  return before.split('\n').length;
}

const CLAIMS: readonly (readonly [line: string, why: string])[] = [
  ['P3-S8 is in progress.', 'still calls P3-S8 open'],
  ['P3-S8 remains a candidate for now.', 'still calls P3-S8 open'],
  ['The P3-S8 migration is not yet frozen.', 'still calls P3-S8 open'],
  ['| P3-S8 — security, reconciliation | **in progress** | contract |', 'still lists P3-S8 as open in a status table'],
  ['- Migrations: `frozenThrough = 0068_supplier_settlement_commands.sql`', 'still states the pre-S8 boundary frozenThrough = 0068'],
  ['- Migrations: 69 migrations frozen.', 'still states the pre-S8 count of 69 frozen migrations'],
  ['The next allowed step is P3-S8.', 'still names P3-S8 as the next step'],
  ['OD-03 (purchase tax) is resolved.', 'describes OD-03 as settled'],
  ['OD-03 is implemented by the Country Pack.', 'describes OD-03 as settled'],
  [
    '- Migrations: `frozenThrough = 0069_inventory_reconciliation_read_and_account_domain.sql`',
    'still states the pre-corrective boundary frozenThrough = 0069',
  ],
  ['- Migrations: 70 frozen, through the S8 file.', 'still states the pre-corrective count of 70 frozen migrations'],
  ['The boundary is 70 frozen migrations.', 'still states the pre-corrective count of 70 frozen migrations'],
  ['`gate:phase3:release` protects the Phase 3 prefix `0053`–`0069`.', 'still states the pre-seal Phase 3 prefix 0053–0069'],
  ['- **B-1 (open).** Superseding a posted opening is refused.', 'still calls S3 B-1 open'],
  ['One open owner decision: B-1, superseding a posted inventory opening.', 'still calls S3 B-1 open'],
];

describe('the release-state pages carry no finding', () => {
  it('baseline', () => {
    expect(documentFindings(pages())).toEqual([]);
  });

  it('the release page is itself one of the pages it checks', () => {
    expect(PHASE3_AUTHORITATIVE_DOCS).toContain(RELEASE);
    expect([...PHASE3_AUTHORITATIVE_DOCS]).toEqual([
      'PROJECT_STATUS.md',
      'TECHNICAL_DEBT.md',
      'docs/PHASE_3_SLICE_MAP.md',
      'docs/PHASE_3_S8_ACCEPTANCE.md',
      'docs/DAFTAR_OPEN_DECISIONS.md',
      RELEASE,
    ]);
  });
});

describe('each stale claim, planted in each page, is a finding with file and line', () => {
  for (const rel of PHASE3_AUTHORITATIVE_DOCS) {
    for (const [line, why] of CLAIMS) {
      it(`${rel}: ${line}`, () => {
        const root = pages();
        const at = plant(root, rel, line);
        expect(documentFindings(root).join('\n')).toContain(`${rel}:${at} ${why}`);
      });
    }
  }
});

describe('a line that marks itself historical is not a finding', () => {
  for (const [line] of CLAIMS) {
    it(`historical: ${line}`, () => {
      const root = pages();
      plant(root, STATUS, `${line} (historical — superseded by the S8 freeze)`);
      expect(documentFindings(root)).toEqual([]);
    });
  }
});

describe('placeholders are unfinished evidence, never history', () => {
  it('{{CANDIDATE}} in an acceptance page is a finding, even marked historical', () => {
    const root = pages();
    const at = plant(root, ACCEPTANCE, 'Candidate: {{CANDIDATE}} (historical)');
    expect(documentFindings(root).join('\n')).toContain(`${ACCEPTANCE}:${at} carries an unfilled placeholder`);
  });

  it('a placeholder in the release page is a finding', () => {
    const root = pages();
    const at = plant(root, RELEASE, 'CI run: {{CI_RUN}}');
    expect(documentFindings(root).join('\n')).toContain(`${RELEASE}:${at} carries an unfilled placeholder`);
  });

  it('a stale claim in an acceptance page is history, not a finding (only placeholders are asked of it)', () => {
    const root = pages();
    plant(root, ACCEPTANCE, 'The next step is P3-S8.');
    expect(documentFindings(root)).toEqual([]);
  });
});

describe('the required statements, and the pages themselves', () => {
  it('OD-03 not named OPEN in PROJECT_STATUS.md', () => {
    const root = pages();
    write(root, STATUS, '# Status\n\nNothing about purchase tax.\n');
    expect(documentFindings(root)).toContain(`${STATUS} does not name OD-03 as OPEN`);
  });

  it('BLOCKED BY OD-03 removed from the release page', () => {
    const root = pages();
    write(root, RELEASE, '# P3-S9 release\n\nBranch protection: MAIN_PROTECTION_EXTERNAL_BLOCKER.\n');
    expect(documentFindings(root)).toContain(`${RELEASE} does not carry "BLOCKED BY OD-03"`);
  });

  it('MAIN_PROTECTION_EXTERNAL_BLOCKER removed from the release page', () => {
    const root = pages();
    write(root, RELEASE, '# P3-S9 release\n\nPurchase tax stays BLOCKED BY OD-03.\n');
    expect(documentFindings(root)).toContain(`${RELEASE} does not record MAIN_PROTECTION_EXTERNAL_BLOCKER`);
  });

  it('an authoritative page missing', () => {
    const root = pages();
    rmSync(join(root, 'docs/PHASE_3_S8_ACCEPTANCE.md'));
    expect(documentFindings(root)).toContain('docs/PHASE_3_S8_ACCEPTANCE.md is missing — it is an authoritative document');
  });
});
