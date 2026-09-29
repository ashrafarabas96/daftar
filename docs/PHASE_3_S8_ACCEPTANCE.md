# DAFTAR — P3-S8 Acceptance / قبول الشريحة الثامنة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S8: security, failure injection, reconciliation, concurrency and performance** (`docs/PHASE_3_EXECUTION_PLAN.md` §10), built to `docs/PHASE_3_S8_CONTRACT.md` as amended by its rulings header and Annex R. It maps each "Must prove" item to its permanent test, records the independent security and data-integrity review, the budgets and the rulings, and lists what stays open. The Phase 3 coordinator accepted and froze P3-S8 under the Tech Lead's 2026-09-26 directive to complete Phase 3. The Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S8، وتشمل:
> - كل سيناريو في سجل ما قبل الفشل (PM-01 … PM-46) صار اختبارًا، ومعه ضابط سلبي يزيل الثابت نفسه فيفشل الاختبار؛
> - مطابقة المخزون مع الأستاذ العام بخمسة فحوص صفرية التسامح (R-INV-01 … R-INV-05)؛
> - قانون الكاتب المخوَّل، ونوع عملية واحد لكل دالة مستهلكة، ومصفوفة صلاحيات وقت التشغيل، وقانون `SECURITY DEFINER`، كلها مكتشفة من الكتالوج؛
> - قرار المالك في B-1 (R-B1a): منع القيد اليدوي والرصيد الافتتاحي على حساب المخزون بعد أول حركة مخزون؛
> - إغلاق TD-12 (فصل مفاتيح التوكيد بالمفتاح الفعلي).
>
> جُمِّدَت هجرتها الوحيدة `0069`.

## 0. Status: ACCEPTED (internal) / FROZEN

- **Candidate head:** `96fb40c0f15106711a95db720a7cac402766bd26`. It is green on all five jobs of `DAFTAR CI` run `36345809905` (attempt 1), on that exact SHA.
- **Freeze:** the freeze commit appends `0069` to `MIGRATION_MANIFEST.json`, with `frozenThrough = 0069_inventory_reconciliation_read_and_account_domain.sql` and 70 migrations frozen, and fills `S8_ACCEPTED` in `scripts/phase3-s8-gate.ts`. (Historical: the S8 freeze. The final Phase 3 boundary is `0073`, `docs/PHASE_3_S9_RELEASE.md` §10.)
- **CI:** runs `gate:phase3:s8`, which composes `gate:phase3:s7` and the chain back to Phase 1.

| migration | SHA-256 | state |
|---|---|---|
| `0069_inventory_reconciliation_read_and_account_domain.sql` | `912299e90a937b684b1829df4be90d5815ee61bcee79d9a01c5e47c4d6fe3084` | FROZEN |

## 1. What P3-S8 delivers

| migration | delivers |
|---|---|
| `0069` | **Reconciler reads (R-90).** Four column-level `SELECT` grants to `daftar_reconciler` on the stock ledger, the stock cache and `accounts.system_key`, each column named in `infrastructure/database/reconciler-privilege-model.json`. No table-level read, no write, no function, no policy.<br><br>**R-B1a (R-91 … R-94), the Tech Lead's B-1 ruling.** An inventory-owned boolean helper `inventory_business_has_stock_movements` (SECURITY DEFINER, EXECUTE only to `daftar_accounting_internal`), an accounting-owned guard and one deferred constraint trigger `journal_entries_inventory_account_domain` on `journal_entries` for `manual_adjustment` and `opening_balance` entries. Once a business has any stock movement, such an entry with a line on the Inventory system account is refused `accounting.inventory_account_domain_owned` (409). Forced early with `SET CONSTRAINTS … IMMEDIATE`, the guard fails closed (R-94, review H-1).<br><br>**0069-E.** The end state against the live catalogues. |

**Application and packages.**
- R-INV-01 … R-INV-05 in `packages/accounting/src/reconciliation.ts` and the P2-S8 reader, zero tolerance; results carry identifiers and counts only. At the S7 head (no 0069) they answer `unavailable`, never `ok`.
- **TD-12 closed.** `effectiveHmacKey` / `hmacKeysEquivalent` in `@daftar/accounting` (RFC 2104 effective key), used at every key-pair site: `config.ts`, both minters and the three install scripts. The P2-S3 gate's key-separation check evolved in the same slice.
- The Phase 3 runtime grant model (`infrastructure/database/phase3-runtime-grant-model.json`) and the rehearsed rebuild swap procedure (`infrastructure/database/procedures/stock-rebuild-swap.sql.template`, **TD-17**).

**Guards.** G-2, G-3, G-4, G-5 and Rule 22 widened to the whole Phase 3 surface (T-14).

## 2. Must-prove → test

| plan bullet (§10) | test |
|---|---|
| every premortem scenario has a test that fails when its invariant is removed, PM-44 … PM-46 included, re-run against every operation kind of P3-S1 … S6 | T-18 `security/phase3-s8-premortem-matrix` (the matrix is complete and every row resolves to a real test title); T-12 `integration/phase3-s8-negative-controls`; T-01 `security/phase3-s8-signed-authority-matrix` (PM-44/45/46 × all 26 kinds, with the verifier stubbed as its negative control) |
| no Phase 3 routine that mutates inventory, purchase or supplier truth runs without consuming or re-verifying an `invctl/1` assertion, discovered from the catalogue | T-02 `security/phase3-s8-writer-authority` (the exact exception set is `warehouses_home_branch_maintain`; a scratch writer without the call is caught) |
| every registered operation kind has exactly one consuming routine, and none is generic | T-03 `security/phase3-s8-operation-kinds` (negative controls: a second consumer of `inventory.adjust`; `consume(p_op, …)`) |
| reconciliation is exact with zero tolerance | T-06 `integration/phase3-s8-reconciliation` after the T-08 long mixed sequence; T-07 `security/phase3-s8-reconciliation-planted` (each planted defect fires exactly its check; the ±1 control); T-16 `security/phase3-s8-reconciler-authority` |
| no runtime principal holds DML on any Phase 3 truth table | T-04 `security/phase3-s8-grant-matrix` (model ↔ catalogue both ways, real DML refused; a scratch runtime `INSERT` grant is caught) |
| no Phase 3 routine violates the SECURITY DEFINER law | T-05 `security/phase3-s8-definer-law` (the seven clauses over the catalogue; negative controls: path order, migrator owner, PUBLIC EXECUTE) |
| runtime `TEMP` and runtime `CREATE` on `public` both remain zero | T-04 (all seven runtime principals, the reconciler included) |

**Also covered:** the long mixed sequence (T-08), the rebuild rehearsal at Tier 1 scale (T-09), failure injection at three fault points over every financial kind (T-10), a cross-slice concurrency soak with a reversed-lock-order control (T-11), the guards (T-14), assertion-key separation (T-15a/b/c), the upgrade to 0069 (T-17), the R-B1a guard (T-19), and a `SET CONSTRAINTS … IMMEDIATE` sweep over every Phase 2/3 deferred guard.

In total, 20 P3-S8 functional suites with 434 tests, plus T-13.

**T-13, the S8 budgets** (Tier 1, scale 1, in the gate):

| id | measure | budget | measured |
|---|---|---|---|
| S8-R1 | R-INV-01 … 05, one business, D-GL (13,700 movements, 4,292 journal lines) | 20 s | 0.22 s |
| S8-R2 | R-INV-02/03/05, D-LEDGER (6,000 keys, 60,000 movements) | 30 s | 0.56 s |
| S8-V | fold and verify every key of D-LEDGER | 60 s | 0.87 s (0 mismatched, 0 gaps) |
| S8-B | both datasets built | 240 s | 180 s |
| S8-M | the T-01 matrix | 120 s | 37 s |

Budget A (15 ms) and, under R-B1a, Budget B (60 ms) pass in isolation as the gate's last step. Tier 2 (`P3S8_PERF_TIER=2`: D-GL ×10 and D-LEDGER 1,000,000 movements over 50,001 keys) is local acceptance evidence under TL-7. It was started on the candidate's tree at the freeze, and its actuals are recorded in `docs/PHASE_3_S9_RELEASE.md`.

## 3. Independent security and data-integrity review

The review ran on the integrated candidate with its own probes. It found **one High and three Low**, all closed.

| id | finding | closure |
|---|---|---|
| H-1 (High) | a session could switch R-B1a off with `SET CONSTRAINTS journal_entries_inventory_account_domain IMMEDIATE`: forced to fire at the header insert, the guard saw no lines and passed | **R-94**: the guard fails closed when the business has stock movements and no line of the entry is visible (`44d33d0`). A sweep over every Phase 2/3 deferred guard (`9c474e3`) found 44 that refuse when forced early and 13 that are complete when forced early; none passes a forbidden write |
| L-1 | the gate's "a DO block changes nothing" check was a keyword denylist | an allow-list of the calls a DO block may make (`20e56ba`); T-15c plants a DO block that borrows an internal role and posts, and the gate refuses it |
| L-2 | the gate accepted any `WHEN (…)` on the R-B1a trigger and did not check the guard body | the trigger text and both bodies are pinned by digest (`20e56ba`); T-15c plants `WHEN (false)` |
| L-3 | R-INV-02's gapless test (`max(stock_seq) = count(*)`) missed a duplicate combined with a gap | it also requires `min(stock_seq) = 1` and no duplicate (`ba9015f`) |
| I-1 … I-9 | information | I-1 (after movements, a Phase 2 reversal of one of two offsetting pre-movement Inventory lines opens a gap that R-INV-01 reports) is recorded for the Tech Lead in §4. I-5 confirms TD-12 is closed at every site. I-6 is TD-17's repayment plan. I-8 (a false positive of `scripts/guards/sql-schema.ts` on `NUMERIC(18,4)` in `ADD COLUMN`) predates S8 and fails closed |

**The composed gate and the first candidate's CI run found three test defects**, fixed; none was a product defect:

- The S5 and S6 upgrade matrices pinned the literal list of files after their checkpoint. They gained `0069`, as S6 extended S5's (`af27025`).
- T-13's dataset sent a 500-line stocktake count in one request, against the 200-line request bound (`fccfdb3`).
- On the first candidate `fccfdb3`, `DAFTAR CI` run `36340997979` failed the backend job. Four P3-S3 … P3-S5 atomicity and seam suites counted `accounting_assertion_uses` rows before and after a case. The frozen consumers prune uses older than one hour (`0061`), so in a composed run longer than an hour the difference went negative (−11, −3, −26). The suites now count the jtis a case added, by set difference (`96fb40c`). Every assertion keeps its expected count.

## 4. Rulings and deviations for the Tech Lead

- **B-1 is decided: R-B1a** (the Tech Lead's decision card, 2026-09-27). Manual and opening-balance lines on the Inventory account are refused once the business has any stock movement.
- **I-1, the residue of B-1.** Before the first movement a business may hold offsetting manual lines on the Inventory account (+x and −x). After it, reversing only one of them is a merchant act that R-INV-01 then reports as a difference. The reversal path itself is sound (derived lines, reversal of a reversal refused, domain-owned originals refused). This is the one merchant-initiated red after movements, recorded for the Tech Lead.
- **Fail-closed, same transaction.** Under `SET CONSTRAINTS … IMMEDIATE`, a manual entry written in the same transaction before the business's first movement is judged at that moment, when the business has no movement yet; it is accepted, as it is under the deferred default.
- **TL-3 exception set** for the definer law is `{provision_actor}` for clauses 1, 2 and 7; `accounting_actor` is internal-owned and passes.
- **TD-17** (new): no stored rebuild swap; the swap is a rehearsed incident migration.
- **TD-12 closed.** **OD-03 stays bounded**: tax rates and tax posting are **BLOCKED BY OD-03**.

## 5. Regression

The candidate `96fb40c` was checked locally on a fresh embedded PostgreSQL.

- **`npm run gate:phase3:s8`.** Every step passed: `gate:phase3:s7` and the whole chain back to Phase 1, the S8 structural checks, the package suites, the 20 functional suites, T-13 Tier 1, and Budget A and B in isolation. One step of the composed chain, `check:deployment-authority`, could not start its cluster because an orphaned PostgreSQL from an earlier run held its port; with that process stopped, `check:deployment-authority` alone passed. The full gate is proven on GitHub by the freeze CI run, which runs `gate:phase3:s8`.
- **Static checks:** format, typecheck, lint, the static guards (23 rules) and the migration manifest check are all clean.

**The accepted tense.** It was proven red on two plantings, each refused before the regression matrix: a wrong digest in `S8_ACCEPTED` (2 boundary violations), and one line appended to `0069` (the file hashes to `be2632e7…`, not `912299e9…`). T-15c (`tests/security/phase3-s8-gate-tamper.test.ts`) passes 19/19 in the accepted tense, and `npm run check:migrations` verified 70 frozen migrations at the time (historical: the final Phase 3 boundary is `0073`, 74 migrations).

## ملخص

اكتمل الفحص العدائي للمرحلة الثالثة. كل سيناريو فشل متوقَّع صار اختبارًا يفشل إذا أُزيل الثابت الذي يحميه. كل دالة تغيّر المخزون أو المشتريات أو الموردين لا تعمل إلا بتوكيد موقَّع، وهذا يُكتشف من قاعدة البيانات نفسها لا من قائمة مكتوبة. لا يملك أي حساب تشغيل صلاحية كتابة مباشرة على جداول المرحلة الثالثة.

مطابقة المخزون مع الأستاذ العام دقيقة بلا أي تسامح، وتعرض معرّفات وأعدادًا فقط بلا مبالغ. وبقرارك في B-1، لا يمكن بعد أول حركة مخزون قيد يدوي أو رصيد افتتاحي على حساب المخزون.

المراجع المستقل وجد خللًا عاليًا واحدًا: كان يمكن تعطيل هذا المنع بأمر `SET CONSTRAINTS`. أُغلق، وفُحصت كل القيود المؤجلة الأخرى بالطريقة نفسها. وأُغلقت ثلاث ملاحظات منخفضة.
