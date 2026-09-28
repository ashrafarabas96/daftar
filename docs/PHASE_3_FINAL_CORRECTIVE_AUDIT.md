# PHASE 3 — FINAL CORRECTIVE AUDIT

**Status: CORRECTIVE PASS — results in §5, final proof in §6. The Tech Lead's verdict on the release candidate `d6f1bc6ecff08694351949d637090139e1ccc8f2` is PHASE 3 — CHANGES REQUIRED (2026-09-28). PR #4 stays a draft and is not merged. No Phase 4 work.**

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

Each row names the change and the proof. The corrective gate entry (`scripts/phase3-corrective-gate.ts`) is the permanent form of the proof; `RP-*` are its red proofs, each run against the old defect.

| id | result | change | proof |
|---|---|---|---|
| A — TD-16 | **CLOSED** | `0072_purchase_sub_unit_residue.sql`: R-95 `supplier_returns_residue_bound` refuses a return that would leave `0 < outstandingTxn` with `outstandingBase = 0` (`supplier_return.residue_below_base_unit`); R-96 `purchase.write_off_residue` (`POST /v1/purchases/:id/residue-write-off`, `suppliers.pay`) closes an existing residue only when it converts to 0 base minor units, idempotently, dated on or after the purchase's last AP release (`purchase_residue.date_before_settlement`) and not in the future; it posts Dr AP / Cr FX gain when a base remainder of the line exists and no entry otherwise; `registered_by` admits only `P3-C`. The purchase screen offers “Close the leftover amount”. `0065`–`0068` unchanged | A-01 `tests/integration/p3c-td16-residue-closure.test.ts` (the TRY-in-ILS 0.11 reproduction, the historical residue, ≥ 1 base unit refused, negative/zero, replay, concurrent repair, second-business and other-tenant denial, failpoint rollback); RP-TD16 red on the old head; `apps/web/test/purchase-leftover.test.tsx` |
| B — S8 I-1 | **CLOSED** | `0071_reversal_inventory_account_domain.sql`: after the business's first stock movement, a reversal that would change the Inventory account's balance away from the stock value is refused with a stable error pointing to the adjustment workflow; no stock movement is created. R-B1c: the reversal guard and `journal_entries_inventory_account_domain_serial` take a business-scoped advisory lock EXCLUSIVE and `stock_movements_account_domain_lock` takes it SHARED, so a reversal cannot race the first movement (the race was reproduced red before the lock, then 26/26 with no deadlock) | B-01 `tests/integration/p3c-reversal-inventory-domain.test.ts` (offsetting pre-stock lines, first movement, reversal refused and R-INV-01 ok; lawful pre-stock reversal; domain-owned entries; unrelated accounts; `SET CONSTRAINTS ALL IMMEDIATE`; same-transaction cases; reconciliation zero); RP-I1 red with the trigger dropped |
| C — TD-19 | **CLOSED** | web and admin start through `server.mts`, which appends the peer to `X-Forwarded-For` and stamps the upstream call with a boot secret; `lib/bff-upstream.ts` (identical in both apps) forwards the chain only with the stamp; `clientIp()`/`TRUSTED_PROXIES` stay the authority; the per-route allowance is keyed by `clientIp()` (IPv6 by /64); production refuses `TRUST_PROXY=true` and the legacy mode takes the rightmost hop. Refresh keeps the cookie on 429/503 and clears it only on 400/401; the client shows a retry notice | C-01 … C-13; RP-TD19 (61 refreshes through one BFF logged the user out before the fix). Independent review: 1 medium (legacy leftmost hop) and 4 low, all fixed; the lost-answer refresh case is TD-21 |
| D — TD-18 | **CLOSED** | `0070_definer_ownership_hardening.sql`: the four routines owned by `daftar_catalog_internal` / `daftar_provisioning_internal` (NOLOGIN), `search_path = pg_catalog, public, pg_temp`, relations schema-qualified, PUBLIC EXECUTE revoked, grants issued before the ownership hand-over; key install write-once; 13 further definers pinned to the same path; `check:deployment-authority` 10b.5/10b.6 assert no applier-owned definer and `pg_temp` last everywhere | D-01, D-02; RP-TD18 red with an owner reverted to the applier; deployment matrix and deployed rehearsal on both builds |
| E — secret scan | **CLOSED** (history decision below) | `npm run scan:secrets:phase3`: gitleaks 8.24.3 pinned by digest, default rules, range `0f2b09e7…..HEAD` over first-parent history, merge base verified; exact fingerprints only, each proved against its content; tree mode for the extracted archive; `phase3-s9-evidence.ts --secret-scan` records base, head, commits scanned, findings and result | E-01 … E-03, E-SCAN; E-03 plants a credential in the 2nd and the 35th commit, in a merged agent branch and in a merge commit alone, and each fails the scan; RP-SCAN: a gate declaring only the action's 30-commit window, or no range scan, fails |
| F — real-browser gate | **CLOSED** | `npm run gate:browser` (`tests/browser/`): `next build`/`next start` through the production entry, the real API, a fresh database; ar/en/tr × 360×640, 768×1024, 1280×800; overflow, raw key, console error, Turkish coverage, touch targets and the Tajawal face asserted; runs in CI with screenshots kept | the red proof (`--plant=all`: overflow, raw key, console error, missing string) caught in all 9 runs; RP-TR: removing tr, a viewport or the missing-string plant fails the gate |
| G — Visual North Star | **CLOSED for the Phase 3 screens** | before: 393 issues over 135 steps (339 touch-target: the header's business switcher and Log out were 36 px; 9 menu: Escape did not close the business menu; 45 flow: Starting stock offered after the opening). Changed (`ac8f2dc`): Tajawal self-hosted and loaded; header buttons at the 44 px `TOUCH_TARGET`; the Dropdown closes on Escape and outside press, focus returns to its trigger. After: 135 steps, 348 screenshots, 0 issues. Recorded, not changed (TD-22): button radius/height tokens, and the Turkish letters ğ, ş, İ outside the Tajawal subsets | screenshots reviewed per locale and width: header, header menus, stock, stock-filtered, move, count list/sheet/confirm/finished, adjust and Starting stock, suppliers (empty, search, owed, detail), purchases (empty, list, received, draft, detail, undo), receive (review, done, receive-and-pay), pay, return, loading and error states |
| H — TD-20 | **CLOSED** | `openingPosted` on `GET /v1/inventory/access`; Starting stock disabled with the per-business rule once the opening exists; `0073_default_warehouse_locale_name.sql` names a new default warehouse in the business's locale and renames an existing default only while it still has the untouched English name | H-01 … H-03; RP-TD20 |
| I — TD-01 | **CLOSED** | vitest and `@vitest/mocker` 4.1.11, vite 7.3.6, `maxWorkers: 1`; `npm audit`: 1 moderate before, 0 after | the full estate on the upgraded runner (§6) |
| J — R-B1, TL-11 | **CONFIRMED** | no code change | the seam, atomicity and concurrency suites green at the corrected candidate (§6) |
| K — TD-14 | **narrowed, stays open with an exact boundary** | production `platform-api` refuses `APP_DATABASE_URL`; key install write-once (`0070`) | K-01; `TECHNICAL_DEBT.md` TD-14 |
| L — repayment targets | **done** | TD-07 and TD-17 → Phase 15; TD-15 owned no later than the Phase 4 settlement work; TD-21, TD-22 added | `TECHNICAL_DEBT.md` |
| M — census | **done** | `npm run census:tests` | §6 |
| N — review index | **done** | `docs/PHASE_3_REVIEW_INDEX.md`, `npm run check:phase3:review-index` | N-01, N-CHECK; red on a planted stale row |
| O — corrective gate | **done** | `gate:phase3:corrective`, composed by `gate:phase3:release` step 7 and run by the CI backend job | O-01 `tests/security/p3c-corrective-gate-tamper.test.ts`; every `RP-*` above |
| P — release proof | §6 | | |
| Q — security review | **no High or Medium open** | two independent reviews: the BFF chain (1 medium, 4 low, all fixed) and migrations `0070`–`0073` (no high or medium; the lows fixed, and one real race in I-1 fixed by R-B1c) | the reviewers' probes and the suites above |

### History scan decision

The first range scan of this pass found four `generic-api-key` findings: fake refresh tokens in two BFF test files, in unpushed commits of this pass (`e259306`, `8abae15`). They are test fixtures, not credentials; `ec8eb3b` replaced them with low-entropy values. The remaining question — rewrite the unpushed history or allowlist the four exact fingerprints — is the Tech Lead's decision and is recorded with the final report.

## 6. Final proof at the corrected candidate

Recorded with the corrected candidate SHA in PR #4 and in the final report: the exact-SHA `DAFTAR CI` push run, the exact-SHA release-evidence run, the `pull_request` run labelled with its merge commit, the test census, Tier 1 and the budgets.

## ملخص

حكم قائد الفريق على المرشح `d6f1bc6` هو «تغييرات مطلوبة». تسجّل هذه الصفحة كل ملاحظة في التوجيه التصحيحي كشرط إغلاق صريح، مع الدليل المطلوب لإغلاقه. لا تُغلق أي ملاحظة بنقلها إلى سجل الديون التقنية.

صحّحنا أيضًا الدليل:
- تشغيلات DAFTAR CI على PR #4 كلها من نوع pull_request.
- هذه التشغيلات تختبر commit الدمج الذي يصنعه GitHub، لا رأس الفرع نفسه.
- لذلك هي دليل على شجرة مكافئة، وليست دليلًا على الـ SHA نفسه.
- الدليل على الـ SHA نفسه هو تشغيل الإصدار فقط.
