# PHASE 3 — FINAL CORRECTIVE AUDIT

**Status: CORRECTIVE PASS IN PROGRESS. The Tech Lead's verdict on the release candidate `d6f1bc6ecff08694351949d637090139e1ccc8f2` is PHASE 3 — CHANGES REQUIRED (2026-09-28). PR #4 stays a draft and is not merged. No Phase 4 work.**

This page turns every finding of the Tech Lead's corrective directive into an explicit closure requirement. A finding closes only when its requirement is met and the proof named here exists. None of these findings may be closed by moving it to `TECHNICAL_DEBT.md`.

## 1. Baseline

| | |
|---|---|
| repository | `ashrafarabas96/daftar` |
| branch | `phase/3-inventory-purchases-suppliers`, draft PR #4 |
| submitted candidate | `d6f1bc6ecff08694351949d637090139e1ccc8f2` |
| frozen boundary | `0069_inventory_reconciliation_read_and_account_domain.sql`, 70 frozen migrations |
| Phase 3 base | `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f`, the Phase 2 merge into `main` |
| migration rule | `0000`–`0069` stay byte-identical; any database correction is a forward migration from `0070`, named Phase 3 corrective hardening |

Documents read before any change: `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`, `docs/DAFTAR_OPEN_DECISIONS.md`, `docs/PHASE_3_ARCHITECTURE_LOCK.md`, the P3-S1 … P3-S9 acceptance and contract pages, `docs/PHASE_3_S9_RELEASE.md`, the migration manifest, the CI and release workflows, and the release-gate scripts. The repository has no `CLAUDE.md`. The directive names one, so its absence is recorded here rather than assumed.

## 2. Evidence correction (directive §15)

The Phase 3 report of 2026-09-28 called DAFTAR CI run `36359842420` "five CI jobs green on exact `d6f1bc6`". That was wrong. The run is a `pull_request` run. Its job log fetches `refs/remotes/pull/4/merge` = `4abb0acdbb755f006a8916d9e2838d000202deab`, the GitHub merge commit, and tests that commit, not `d6f1bc6`. The API field `head_sha` names `d6f1bc6`, which is why the label was wrong.

The same holds for every per-slice "exact-SHA CI in PR #4" that `PROJECT_STATUS.md` records. `DAFTAR CI` triggers on `pull_request` and on `push` to `main` only, so each of these runs is a `pull_request` run on the PR merge commit:

| slice | recorded run | event | `head_sha` |
|---|---|---|---|
| P3-S1 candidate | 36223470804 | pull_request | `f1cc4c4` |
| P3-S1 closure | 36237436256 | pull_request | `61b89d6` |
| P3-S2 freeze | 36254439784 | pull_request | `57a5a7f` |
| P3-S3 freeze | 36270011235 | pull_request | `032ba74` |
| P3-S4 freeze | 36285769763 | pull_request | `43b8370` |
| P3-S5 freeze | 36294562011 | pull_request | `5ff7b8b` |
| P3-S6 freeze | 36312803112 | pull_request | `01dae04` |
| P3-S7 freeze | 36332472042 | pull_request | `a0aee73` |
| P3-S8 freeze | 36350207605 | pull_request | `5fcab76` |

The P3-S3 freeze commit is `fecbecb`, but the recorded run is on its successor `032ba74`. The 2026-09-28 report's slice table placed that run beside `fecbecb`, which was also wrong.

These runs are **equivalent-tree evidence**. `main` did not move during Phase 3, so the merge commit's tree is the head's tree applied onto an unchanged base. They are not exact-SHA evidence. The exact-SHA evidence of Phase 3 is:
- the release run `36359838083` (a `push` run of `phase3-s9-release.yml`), which checks out `d6f1bc6`, asserts `git rev-parse HEAD`, and runs the release gate in the repository and in the extracted archive;
- the Phase 2 release run `36237451799`, on `61b89d6`.

**Closure requirement E-1.** At the corrected candidate, the report and the PR name one exact-SHA run: a run whose checkout is the literal candidate SHA, with the assertion in its log. Any `pull_request` run is labelled with its merge commit. `DAFTAR CI` also runs on `push` to the phase branch, so an exact-SHA run of the five CI jobs exists as well. `PROJECT_STATUS.md` stops saying "exact-SHA CI in PR #4" for `pull_request` runs.

## 3. Closure requirements

| id | finding (directive §) | closure requirement | proof required | stream |
|---|---|---|---|---|
| A | TD-16, an unclosable sub-unit AP residue (§3) | (1) no Phase 3 path can create a purchase with `0 < outstandingTxn` and `outstandingBase = 0`; (2) a state already created by frozen S5 behaviour has a controlled, auditable, idempotent, permissioned closure path, usable only when the remainder converts to 0 base minor units. `0065`–`0068` untouched | TRY-in-ILS 0.11 reproduction; the historical partial-return residue; safe closure; no base imbalance; ≥ 1 base minor unit refused on the repair path; negative and zero invalid; replay; concurrent repair; same-owner second-business and other-tenant denial; failpoint rollback | DB |
| B | S8 I-1, an allowed reversal turns R-INV-01 red (§4) | after stock history exists, a reversal that would break the inventory-account invariant is refused with a stable error and guidance to the adjustment workflow; no stock movement is created from an accounting reversal | two offsetting pre-stock lines → first movement → reverse one → refusal, R-INV-01 stays ok; lawful pre-stock reversal still lawful; domain-owned entries still refused; unrelated accounts not refused; `SET CONSTRAINTS ALL IMMEDIATE`; same-transaction edge cases; reconciliation zero after every permitted path | DB |
| C | TD-19, BFF client address and refresh 429 (§5) | every BFF path to an IP-sensitive API endpoint preserves the real client address through the existing trusted-proxy model (`clientIp()`, `TRUSTED_PROXIES`), spoofing from an untrusted edge is not possible, and upstream 429 stays 429 without deleting a valid refresh cookie | two clients behind one BFF keep separate allowances; one client still reaches its limit; spoofed XFF does not bypass; 61 refreshes RED before the fix; upstream 429 keeps the cookie; invalid or reused refresh unchanged; login limits effective; direct API unchanged | BFF |
| D | TD-18, SECURITY DEFINER ownership and search path (§6) | the four routines have an explicit least-privileged owner that does not depend on who applies migrations, a `search_path` with `pg_temp` last, PUBLIC EXECUTE revoked, and minimal runtime grants; forward migration only | temp-schema and public-schema shadowing, wrong owner, PUBLIC execute, forbidden app invocation, required platform invocation, catalog create/update, onboarding, second-business onboarding, key install/retire; the deployment-authority matrix and the deployed rehearsal on both builds | DB |
| E | partial secret-history scan (§7) | an explicit range scan from `0f2b09e7…` (validated as the merge base) through the exact candidate, independent of the gitleaks-action PR window; known digest false positives handled only by exact, reasoned fingerprints | a planted credential early in the range fails the scan; the evidence records base, head, commits scanned, findings, result | hygiene |
| F | no permanent real-browser gate, no Turkish (§8) | a reproducible gate on `next build`/`next start`, the real API and a fresh database, in ar/en/tr at 360×640, 768×1024 and 1280×800, over the Phase 3 routes and critical flows, with the §8 invariants; runs in CI | RED on planted overflow, raw key, console error and missing tr string; screenshots kept as artefacts | browser |
| G | Visual North Star (§9) | the Phase 3 merchant screens meet the approved identity; material shortfalls fixed | the screenshots reviewed and the changes, recorded here | browser |
| H | TD-20 (§10) | Starting stock is not offered as an enabled action once the business's opening exists; a new business's default warehouse is named in its locale; existing defaults handled without destroying merchant names | ar/en/tr tests for both | browser + DB |
| I | TD-01, overdue dev-dependency advisory (§11) | the smallest safe Vitest/@vitest/mocker upgrade that clears the advisory, with the whole estate green, or an explicit new repayment decision for the Tech Lead | `npm audit` before and after; full estate | hygiene |
| J | R-B1 and TL-11 confirmation (§12) | the seam suites stay green after every correction | `purchase-s4-seam`, S4 atomicity, `settlement-s6-seam`, S6 atomicity, receive-and-pay concurrency, at the corrected candidate | coordinator |
| K | TD-14 (§13) | decide whether `platform-api` can refuse an unnecessary `APP_DATABASE_URL` now; harden and test if yes; otherwise keep TD-14 with an exact threat boundary | ALLOW/DENY tests, or the recorded boundary | BFF |
| L | stale repayment targets (§14) | TD-02 … TD-05, TD-07, TD-10, TD-14, TD-15, TD-17 and OD-03 keep their proven invariants and carry a current repayment phase; TD-15 is owned no later than the Phase 4 settlement work | `TECHNICAL_DEBT.md` | coordinator |
| M | stale test counts (§16) | an exact census at the corrected candidate, produced by a tool from the runners' own listings | `scripts/test-census.ts` output | index |
| N | PR #4 reviewability (§17) | `docs/PHASE_3_REVIEW_INDEX.md`, generated and checked for stale paths | the check RED on a planted stale row | index |
| O | corrective gate (§19) | `gate:phase3:corrective` proves every corrected blocker and is composed by `gate:phase3:release`; each check is shown RED against its old defect where practical | the red runs, recorded here | coordinator |
| P | full final release proof (§20) | fresh checkout, `npm ci`, fresh database, every gate, the browser matrix, Android, the range scan, audit, deployment matrix and rehearsal, Tier 1, the RC archive gated again on a fresh database | the exact-SHA release run | coordinator |
| Q | final security review (§21) | an independent reviewer attacks every corrected area; no High or Medium remains; any security or data-integrity defect is fixed | the review's findings and their closure | reviewer |

## 4. Items that may remain open (directive §14)

TD-02, TD-03, TD-04, TD-05, TD-07, TD-10, TD-14 (if §13 proves the accepted boundary), TD-15, TD-17 and OD-03 are not Phase 3 blockers while their invariants stay proven. OD-03 stays a hard blocker for any tax implementation. A non-zero purchase tax is refused with `purchase.tax_policy_absent`.

## 5. Results

Filled in as each requirement closes.

## ملخص

حكم قائد الفريق على المرشح `d6f1bc6` هو «تغييرات مطلوبة». تسجّل هذه الصفحة كل ملاحظة في التوجيه التصحيحي كشرط إغلاق صريح، مع الدليل المطلوب لإغلاقه. لا تُغلق أي ملاحظة بنقلها إلى سجل الديون التقنية.

صحّحنا أيضًا الدليل:
- تشغيلات DAFTAR CI على PR #4 كلها من نوع pull_request.
- هذه التشغيلات تختبر commit الدمج الذي يصنعه GitHub، لا رأس الفرع نفسه.
- لذلك هي دليل على شجرة مكافئة، وليست دليلًا على الـ SHA نفسه.
- الدليل على الـ SHA نفسه هو تشغيل الإصدار فقط.
