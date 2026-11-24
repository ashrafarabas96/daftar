/**
 * CARD L4-q9-01 — THE SECRET-SCAN EVIDENCE INVARIANT, AND THE TWO REFUSAL
 * BRANCHES THAT WERE WRITTEN, READ AND NEVER REDDENED.
 *
 * `secretScanEvidenceProblems` is what a release requires of the Phase 3
 * history scan. Before this law it compared `commitsScanned` with
 * `commitsWithPatch` and related NEITHER to `commitsInRange`, so a single
 * hand-written line — `commitsWithPatch: <commitsScanned>` — satisfied the
 * whole check while the range held any number of commits the scan never
 * accounted for. `patchlessCommits` was carried in the artefact, printed by
 * the CLI, and never read by the validator at all.
 *
 * WHY THIS FILE AND NOT `tests/security/p3c-secret-scan.test.ts`, where the
 * validator's other arms live: that file's suite needs the gitleaks binary,
 * and there is no pinned gitleaks for win32/x64 (`SecretScanError: no pinned
 * gitleaks download for win32/x64`), so every arm in it is UNRUNNABLE on this
 * machine — which means a seeded arm cannot be proved red before it is
 * believed. These arms assert on a PURE FUNCTION over a plain record, so they
 * belong in the lane that has neither a database nor a binary, where the proof
 * is available to whoever changes the invariant. Importing the scanner is safe
 * here: its CLI runs under `if (require.main === module)`.
 */
import { describe, expect, it } from 'vitest';
import { GITLEAKS_BINARY_SHA256, GITLEAKS_VERSION, PHASE3_BASE, secretScanEvidenceProblems, type ScanResult } from '../scripts/phase3-secret-scan';

const HEAD = 'b'.repeat(40);

/** A record every other check in the validator accepts, so each arm below changes ONE thing. */
const good: ScanResult = {
  produced: 'scripts/phase3-secret-scan.ts',
  tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256: GITLEAKS_BINARY_SHA256 },
  mode: 'phase3-base',
  base: PHASE3_BASE,
  head: HEAD,
  mainRef: 'origin/main',
  mergeBase: PHASE3_BASE,
  logOpts: `--diff-merges=first-parent ${PHASE3_BASE}..${HEAD}`,
  commitsInRange: 400,
  mergesInRange: 14,
  commitsWithPatch: 400,
  patchlessCommits: [],
  commitsScanned: 400,
  findings: 3,
  allowlisted: [],
  remaining: [],
  filesScanned: null,
  ignoreFile: { present: true, sha256: null, entries: 3, unused: 0 },
  problems: [],
  result: 'PASS',
};

describe('L4-q9-01: a HAND-WRITTEN scan record must account for every commit in the range, not just for the ones it read', () => {
  // «HAND-WRITTEN» IS THE WHOLE SUBJECT, narrowed by review on the previous
  // head. The scanner derives `commitsWithPatch` from `commitsInRange` and the
  // patchless list, so the identity cannot fail for any record IT writes —
  // claiming the invariant over «the scan evidence» read wider than what is
  // checked. What this refuses is a record assembled by hand, which is exactly
  // the hole the card names: a single line that satisfied the validator. It
  // still cannot tell whether the listed shas are real, as the validator's own
  // comment says.
  it('accepts the record every other check accepts, so each arm below changes one thing', () => {
    expect(secretScanEvidenceProblems(good, HEAD)).toEqual([]);
  });

  it('refuses evidence whose two halves do not account for the whole range — the hole one hand-written line satisfied', () => {
    // 400 carry a patch, NONE are recorded as carrying none, and the range
    // holds 401. Every other check passes on this record: `commitsScanned`
    // equals `commitsWithPatch`, and nothing compared either to the range.
    const problems = secretScanEvidenceProblems({ ...good, commitsInRange: 401 }, HEAD);
    expect(problems.join('\n')).toMatch(/accounts for 400 of 401 commits in the range/);
    // THE NAMED CAUSE, not merely that something was refused: a message about
    // the scanned window or a remaining finding would satisfy a length
    // assertion while saying nothing about this identity.
    expect(problems).toHaveLength(1);
  });

  it('refuses a range in which NOTHING carried a patch, because nothing scanned is not evidence of anything', () => {
    // A range whose every commit is empty: the scan reads zero commits and
    // reports PASS with no findings, which is true and worthless. The branch
    // existed; no arm had ever entered it.
    const artefact = { ...good, commitsInRange: 3, commitsWithPatch: 0, commitsScanned: 0, patchlessCommits: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] };
    expect(secretScanEvidenceProblems(artefact, HEAD).join('\n')).toMatch(/does not say how many commits carried a patch \(0\)/);
  });

  it('refuses evidence that omits the patchless list, rather than reading its absence as zero', () => {
    // The dangerous reading of an absent field is `length 0`, which would make
    // the identity above pass for any record that simply left the list out.
    // `Array.isArray` is what refuses it, and this arm is the only thing that
    // distinguishes the two readings.
    const { patchlessCommits: _omitted, ...withoutList } = good;
    expect(secretScanEvidenceProblems(withoutList, HEAD).join('\n')).toMatch(/does not list the commits that carry no patch/);
  });

  it('NEGATIVE CONTROL: a range with REAL patchless commits, counted, is accepted', () => {
    // The identity must not refuse the ordinary case it was written for: a
    // range of 400 in which 14 merges carry no first-parent patch. An identity
    // that only ever passed on `patchlessCommits: []` would be an identity
    // about the empty list, and this control is what makes it an identity
    // about the range.
    const fourteen = Array.from({ length: 14 }, (_, i) => String(i).padStart(40, '0'));
    const artefact = { ...good, commitsWithPatch: 386, commitsScanned: 386, patchlessCommits: fourteen };
    expect(secretScanEvidenceProblems(artefact, HEAD)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the identity does not swallow the window check it sits beside', () => {
    // 386 of 400 accounted for correctly, but only 30 of the 386 were read —
    // the 30-commit window this release already refused. The identity must
    // stay silent here and the window message must still fire, so the two
    // checks are not one check wearing two messages.
    const fourteen = Array.from({ length: 14 }, (_, i) => String(i).padStart(40, '0'));
    const problems = secretScanEvidenceProblems({ ...good, commitsWithPatch: 386, commitsScanned: 30, patchlessCommits: fourteen }, HEAD);
    expect(problems.join('\n')).toMatch(/read 30 of 386 commits that carry a patch/);
    expect(problems.join('\n')).not.toMatch(/accounts for/);
  });
});
