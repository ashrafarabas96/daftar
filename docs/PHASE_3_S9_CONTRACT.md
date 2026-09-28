# DAFTAR — P3-S9 Contract / عقد الشريحة P3-S9

> **Coordinator rulings on this contract (2026-09-27).** Adopted as the P3-S9 implementation contract; it is committed with the P3-S8 freeze.
>
> - **B-1 is decided.** The Tech Lead chose R-B1a on 2026-09-27, so the 0069 name is `0069_inventory_reconciliation_read_and_account_domain.sql`; its digest in `PHASE3_PREFIX` is copied from the S8 freeze manifest.
> - **P-2 and P-3 hold.** The S8 base carries the S7 freeze `a0aee73` and `f64f399`; the S7 acceptance page has no placeholder.
> - **P-4 is done in S8.** The two S8 tree-copy suites take the `DELIVERY_MANIFEST.json` fallback through `tests/helpers/delivered-files.ts`. Agent C keeps T-11 and the recorded local-extraction proof.
> - **TL-7.** The three streams of §8 run in parallel on disjoint files under the 2026-09-26 multi-agent directive. Only the coordinator runs a composed gate.
> - **Adopted as engineering rulings:** A-01 … A-15 and TL-1 … TL-12. OD-03 stays bounded: every tax element is BLOCKED BY OD-03.

> **Summary (Arabic).** عقد تنفيذ الشريحة P3-S9 (إغلاق إصدار المرحلة الثالثة):
> - **لا هجرة.** لا ملف بعد `0069`، ولا تغيير في `bootstrap.sql`، ولا في أي كود منتج (`apps/**` و`packages/**` و`infrastructure/**` لا تتغيّر). ما يتغيّر هو أدوات الإصدار والاختبارات وسير العمل والوثائق فقط.
> - **ثبات البادئة لا "لا شيء بعد N".** وحدة جديدة `scripts/phase3-prefix.ts` تحمي هجرات المرحلة الثالثة `0053`–`0069` بنسخة حرفية من بصماتها المقبولة، وتسمح بأي هجرة لاحقة. تبقى `scripts/phase2-prefix.ts` تحمي `0000`–`0052` دون تعديل. أي تغيير ولو بايت واحد = فشل قاطع.
> - **بوابة واحدة تُركِّب ولا تكرّر:** `npm run gate:phase3:release` = كناري المشغّل الحقيقي، ثم فحوص الشجرة والبادئة والوثائق، ثم `gate:phase2:release` كما هي (تشمل `gate:phase1:release`)، ثم `gate:phase3:s8` كما هي، ثم تمرين النشر على قاعدة بناها حساب النشر.
> - **الأرشيف والبيئة النظيفة:** الأرشيف من الالتزام بعينه، ويُفك في مجلد خارج المستودع بلا `.git`، ثم `npm ci`، ثم البوابة نفسها مرة ثانية، على عنقود PostgreSQL جديد لم يلمسه أي تشغيل سابق. ويُقارَن الأرشيف بمخرجات `git archive` للالتزام نفسه.
> - **تمرين النشر:** كل الهجرات السبعين تُطبَّق بحساب `daftar_migrator` (ليس superuser ولا BYPASSRLS)، وتُقارَن الفهرسة بقاعدة بناها superuser، و`TEMP` و`CREATE` على `public` صفر لكل دور تشغيلي ولـ`PUBLIC`. ثم تُشغَّل المطابقة صفرية التسامح على نشاط تجاري حقيقي فوق القاعدة التي بناها حساب النشر.
> - **اكتُشفت أربعة عيوب في السابقة نفسها** (لا عيب منتج): خطوة الكناري في بوابة المرحلة الثانية لا تشغّل شيئًا؛ تشغيل الأرشيف في P2-S9 أعاد استعمال قاعدة التشغيل الأول؛ مجموعتا اختبار من P3-S8 تستدعيان `git` وستفشلان داخل الأرشيف تمامًا كما فشلت P2-S9 أول مرة؛ ومصفوفة النشر تسجّل عضويات حساب النشر دون أن تتحقق منها.
> - الضريبة: **BLOCKED BY OD-03**، دون تغيير.
>
> **لا عائق حقيقي.** توجد ملاحظات لقائد الفريق (§9.2)، أهمها أن الشريحة تبدأ فقط بعد تجميد P3-S8 (وقرار B-1 يحدد اسم `0069` وبصمتها).

> **Status.** Candidate contract for P3-S9, written by the S9 contract agent. Analysis only: no repository file was changed, nothing was committed, and PostgreSQL was not started.
>
> **Trees read.**
> - `s7int` = `/home/user/s7int`, branch `s7-int` at `f64f399`, **plus its uncommitted S7 freeze edits** (`scripts/phase3-s7-gate.ts:59` sets `S7_ACCEPTED_MARK = 'P3-S7 accepted'`; `.github/workflows/ci.yml:257-268` runs `gate:phase3:s7`; `docs/PHASE_3_S7_ACCEPTANCE.md` and `docs/PHASE_3_S8_CONTRACT.md` are untracked). Citations without a prefix are to this tree.
> - `s8int` = `/home/user/s8int`, branch `s8-int` at `df63b10`, cited with the prefix `s8:`. It branched from `27b046d` (`git merge-base s7-int s8-int`), i.e. **before** the six S7 web fixes `45d1f36 … f64f399` and before the S7 freeze mark (`s8:scripts/phase3-s7-gate.ts:59` is still `null`).
>
> **Sequencing.** P3-S9 starts only after P3-S8 is accepted and frozen on `phase/3-inventory-purchases-suppliers`, on a head that contains the S7 freeze, the S7 web fixes and the S8 freeze (§A-02, P-1 … P-4). Every S8 name and digest below is stated as the S8 freeze will leave it; the 0069 name depends on the Tech Lead's B-1 ruling (`s8:scripts/phase3-s8-gate.ts:56-60`).
>
> **Sources, in order of authority:** code and migrations; tests; `docs/PHASE_3_ARCHITECTURE_LOCK.md` (L); `docs/PHASE_3_EXECUTION_PLAN.md` (P); `docs/PHASE_3_SLICE_MAP.md` (SM); `docs/PHASE_2_S9_RELEASE.md` (R2); `docs/PHASE_3_S8_CONTRACT.md` (S8C); `docs/PHASE_3_S7_ACCEPTANCE.md` (S7A); the P2-S9 release job logs kept in the coordinator scratchpad (`s9job.log`, `s9job2.log`, `s9job3.log`, `s9last.log`), cited as **JOB**.
>
> **Shape.** §0 conventions · §1 rulings (A-01 … A-15) · §2 the release gate · §3 archive and clean environment · §4 deployment rehearsal · §5 CI and the exact-SHA law · §6 final reviews · §7 test plan · §8 file ownership · §9 real blockers and Tech Lead notes · Annex F, findings from the precedent study.

---

## 0. Conventions

- `path:line` cites `s7int`; `s8:path:line` cites `s8int`; `P:n`, `SM:n`, `R2:n`, `S8C:n`, `S7A:n` cite the documents above by line.
- **"Composes"** means runs the named npm script as a child process and records its exit status; it never means copying its assertions (R2:226-246).
- **Phase 3 prefix** = the 17 migrations `0053`…`0069` at their accepted digests. **Release head** = the final P3-S9 commit. **S8 freeze** = the commit that sets `S8_ACCEPTED` (`s8:scripts/phase3-s8-gate.ts:62-65`).
- A **red proof** is a test or recorded run in which the check answers FAIL on a planted defect, made before the check's PASS is believed.

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

P3-S9 closes Phase 3 on the P2-S9 pattern (P:269-271; SM:16). It changes **no schema, no product code and no deployment contract**: nothing under `apps/**`, `packages/**` or `infrastructure/**` changes (A-15). It adds release tooling, proofs, one workflow and documents.

**New files.**

| File | Why |
|---|---|
| `scripts/phase3-prefix.ts` | The Phase 3 historical invariant: `0053`–`0069` complete, ordered, byte-identical to a literal copy of the accepted pairs; later migrations permitted (A-03). The twin of `scripts/phase2-prefix.ts:1-160`. |
| `scripts/phase3-release-gate.ts` (`npm run gate:phase3:release`) | The composed release gate (§2). Named in P:24 and SM:16. |
| `scripts/phase3-deployed-rehearsal.ts` (`npm run rehearse:phase3:deployed`) | Builds the database as `daftar_migrator` from zero, then runs a pinned list of business and authority suites against **that** database (A-10). |
| `scripts/phase3-s9-evidence.ts` (`npm run evidence:phase3:s9`) | Assembles `release/phase3-s9-release-evidence.json` from artefacts, as `scripts/phase2-s9-evidence.ts:1-37` does, plus the exact-SHA and `git archive` comparisons P2 lacked (A-13). |
| `.github/workflows/phase3-s9-release.yml` | Repository gate → archive → extraction → gate again → evidence, in one job at one SHA (§5). |
| `docs/PHASE_3_S9_RELEASE.md` | The release page, in the form of R2, and inside its own consistency check (A-07). |
| `tests/security/phase3-release-prefix.test.ts` | T-01. |
| `tests/security/phase3-release-scope.test.ts` | T-02: OD-03 and "no role change" over the frozen Phase 3 files. |
| `tests/security/phase3-release-gate.test.ts` | T-03: the gate's own refusals, plan and forward-evolution proof. |
| `tests/security/phase3-release-docs.test.ts` | T-04. |
| `tests/security/release-tree-archive.test.ts` | T-05: end-to-end red proofs of the tree checks on a hard-linked copy that carries a delivery manifest. |
| `tests/security/runner-canary.test.ts` | T-06. |
| `tests/security/phase3-s9-evidence.test.ts` | T-07. |
| `tests/security/deployment-authority-model.test.ts` | T-08: the pure halves of the strengthened deployment matrix. |
| `tests/security/phase3-deployed-rehearsal.test.ts` | T-10: the pure halves of the deployed rehearsal and its pinned suite list. |
| `tests/security/archive-portability.test.ts` | T-11: no test or gate script calls `git` without an archive fallback. |

**Existing files that change.**

| File | Change | Why |
|---|---|---|
| `scripts/runner-canary.ts` | Gains a `require.main === module` block that runs the root fixture (`tests/fixtures/runner-exit-code/vitest.config.ts`) and the web fixture (`apps/web/test/fixtures/runner-exit-code/vitest.config.mts`) through real `vitest` children and exits 1 on any `canaryRefusal` (`:37-45`). The export is unchanged. | Finding F-1: `scripts/phase2-release-gate.ts:378` runs `npx tsx scripts/runner-canary.ts`, a module that only exports a function (`scripts/runner-canary.ts:37-45`), so the P2 release gate's "canary first" step runs no test and passes vacuously. With a main, the P2 gate's step becomes real **without editing** `phase2-release-gate.ts`. |
| `scripts/phase2-deployment-authority.ts` | (a) exact deployer membership set (new 2.11); (b) catalogue families added to §10; (c) TEMP / CREATE-on-`public` asserted on **both** builds and for `PUBLIC`; (d) Case H, the Phase 3 slice boundaries upgraded one at a time; (e) `require.main` guard and exported pure checkers; (f) two stale labels reworded (A-09). | The matrix P2-S9 established is the plan's deployment proof (P:282). F-4, F-7, F-8. |
| `scripts/export-release.ts` | `--phase=3` → `release/DAFTAR_PHASE_3_RC.zip`, `phase: 3`, Phase 3 reproduction commands. `--phase=2` and the default stay byte-for-byte the same in behaviour. | `:37-53` knows phases 1 and 2 only. |
| `tests/security/phase3-s8-gate-tamper.test.ts` (S8 file) | `deliveredFiles()` (`s8:…:172-176`) reads `DELIVERY_MANIFEST.json` when present, exactly as `tests/security/phase2-s8-gate-tamper.test.ts:79-97` does. | F-3: it calls `git ls-files` unconditionally and will fail inside the extracted archive. |
| `tests/integration/phase3-s8-guards.test.ts` (S8 file) | Same fallback for `files()` (`s8:…:416-421`). | F-3. |
| `package.json` | Four script lines: `gate:phase3:release`, `export:release:phase3`, `evidence:phase3:s9`, `rehearse:phase3:deployed`. | New commands. |
| `.github/workflows/ci.yml` | Backend job, after "Migration manifest check" (`:85-86`): two steps, `npx tsx scripts/phase2-prefix.ts` and `npx tsx scripts/phase3-prefix.ts`. Job names unchanged. | F-6: `gate:phase2:release` is not run by `ci.yml` at all, so the Phase 2 prefix invariant has not run on any Phase 3 push. Both checks take seconds and need no database. |
| `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md` | The S9 row and the closure state; TD-06 stays open; no new debt is expected. | Coordinator (SM:56). |

**Not changed, deliberately.** `scripts/phase2-release-gate.ts`, `scripts/phase2-prefix.ts`, `scripts/phase2-s9-evidence.ts`, `.github/workflows/phase2-s9-release.yml`, every `scripts/phase3-s<n>-gate.ts`, `infrastructure/database/bootstrap.sql`, `MIGRATION_MANIFEST.json`, `apps/api/src/infra/migrate.ts`. A predecessor gate is composed, never edited to suit its successor (R2:52-63, R2:325-343).

### A-02 · Zero migrations, and the preconditions (ENG)

- **Zero migrations** (P:46, P:269-271). The migration set at the release head is exactly the 70 files `0000`…`0069` of the S8 freeze. `frozenThrough` stays at the S8 file.
- **P-1.** S8 is accepted and frozen: `S8_ACCEPTED` holds the 0069 digest (`s8:scripts/phase3-s8-gate.ts:62-65`), `frozenThrough` is the S8 file, `ci.yml`'s Phase 3 step is `gate:phase3:s8` (S8C:860).
- **P-2.** The S9 base contains `f64f399` (the last S7 web fix) and the S7 freeze commit. `s8-int` does **not** contain them (`git diff --stat s7-int..s8-int` lists `apps/web/src/lib/csp.ts | 43 -` and `apps/web/test/csp.test.ts | 111 ---`, because `s8-int` predates `45d1f36`). The coordinator verifies `git merge-base --is-ancestor f64f399 <S9 base>` before S9 starts; a release that lost the CSP nonce would ship pages that never hydrate (S7A:108).
- **P-3.** `docs/PHASE_3_S7_ACCEPTANCE.md` and `docs/PHASE_3_S8_ACCEPTANCE.md` carry no unfilled `{{…}}` placeholder (the untracked S7 page carries `{{CANDIDATE}}`, `{{CI_RUN}}`, `{{T2_STOCK}}` … at S7A:14, S7A:70-73, S7A:114). A-07 turns any survivor red.
- **P-4.** The S8 archive-portability fix (A-11) is best landed **in S8 before its freeze**. If it is not, it is S9's first commit.

### A-03 · The Phase 3 frozen-prefix invariant (ENG)

The invariant the release gate protects, stated so that it outlives the slice (R2:325-374):

> Phase 3 migrations `0053` through `0069` remain complete, ordered, immutable and byte-identical to the accepted Phase 3 prefix. Phase 2 migrations `0000` through `0052` remain as `scripts/phase2-prefix.ts` states. Later forward migrations are permitted.

**`scripts/phase3-prefix.ts`**, the form of `scripts/phase2-prefix.ts`:

- `PHASE3_PREFIX: readonly (readonly [name, sha256])[]` — **a literal copy** of manifest entries 53…69 taken at the S8 freeze commit, never read from today's manifest (the reason is `scripts/phase2-prefix.ts:25-27`). At `s7int` the first 16 are (`MIGRATION_MANIFEST.json`, entries 53–68):

  | # | name | sha256 |
  |---|---|---|
  | 0053 | `0053_inventory_units_and_product_configuration.sql` | `63940fbcf2c5a3cd99a20280cd83fe53198a0e2d0e2dc0db7ed80d31c47bd3e6` |
  | 0054 | `0054_inventory_assertion_authority.sql` | `7205dea79f090ecf8ded122557d92b2b9669463ce3e5aefca466a968ef9aa450` |
  | 0055 | `0055_inventory_configure_product.sql` | `6652cd5949ad2d9bdda559e23174b850f3cf6bcc2a54d307c5fb9a0a1f5fa2b7` |
  | 0056 | `0056_inventory_branch_warehouses.sql` | `2de288c370e90df5c304ccf354638d178452798662d83054c6a8df8c6f7195a5` |
  | 0057 | `0057_inventory_permissions.sql` | `f6c7b56f920215cc8ba3e84d24e4f353329edab8dccb8d4e43a66712f7c1941d` |
  | 0058 | `0058_accounting_entry_date_guard.sql` | `455973c26bfdf0a185112a4e20a24676d54b5c4c7d4d1232f3e2dce3046b431a` |
  | 0059 | `0059_inventory_stock_ledger.sql` | `4d613225cf880c653918d7106f7fdcecbbda6adfa64d6c7dc2b991e49eb6494d` |
  | 0060 | `0060_inventory_stock_primitive.sql` | `be240e163a7894dc2de4a384a9a86e47addf0ea10c60fadc0e8c6341c278d66b` |
  | 0061 | `0061_inventory_movement_sources.sql` | `7b785537a866606990ab2cfab2a783eb05fe7fb362a67f9ea127119d569f57ff` |
  | 0062 | `0062_inventory_movement_commands.sql` | `dc47df235cc563606705de2a3a991992e573486bfa8d6a8493eb744129bb4b91` |
  | 0063 | `0063_purchases_suppliers_sources.sql` | `bf505fbad5ac4b32d1de2dba729fcd61f7a0651b3b99c8f38e5c2c4980c0a5fe` |
  | 0064 | `0064_purchase_commands.sql` | `b82e01810568390d21156ae555a7fbd35a990e33d8b280361bc85eaa6c7074ad` |
  | 0065 | `0065_supplier_returns_reversals_sources.sql` | `fbf674d2663854da31024932df428ec9d16ccdbda15d3c83a10dbcf554b95e68` |
  | 0066 | `0066_supplier_return_reversal_commands.sql` | `a9d5e6175a99677db33ebbadfac6ac41310fbc97cbc8390ac669534679eeef9e` |
  | 0067 | `0067_payment_methods_supplier_settlement_sources.sql` | `81363f1adf8a296b94690baee4766bcacfa72520477b26f8044cccda398fe660` |
  | 0068 | `0068_supplier_settlement_commands.sql` | `dafad8c698b8668eef24b38315117b3813ceeeaad7cc84b9089ab66b3be89a04` |
  | 0069 | the name and digest recorded by the S8 freeze | — |

  The 0069 entry is copied from the S8 freeze manifest, not from this contract. For information only: the current S8 candidate is `0069_inventory_reconciliation_read_and_account_domain.sql` (R-B1a, `s8:scripts/phase3-s8-gate.ts:60`), hashing to `29f10007e104ccc3a719b3fadf73876b0cc05bfad88430a6b47b6832a8f9f520` at `df63b10`; it may still change before the freeze.
- `PHASE3_PREFIX_START`, `PHASE3_PREFIX_END` (derived from the literal), and `PHASE3_SLICE_HEADS` = `{ 'P3-S1': 0058, 'P3-S2': 0060, 'P3-S3': 0062, 'P3-S4': 0064, 'P3-S5': 0066, 'P3-S6': 0068, 'P3-S7': 0068, 'P3-S8': 0069 }` by full name (used by Case H, A-09).
- `checkPhase3Prefix(migrationsDir, manifestPath): string[]` proves:
  1. each pair's file exists under its name and hashes to its digest;
  2. the `.sql` files numbered `0053`–`0069` (or sorting between `START` and `END`) are exactly the names, in order — a rename, deletion or insertion is refused;
  3. `manifest.migrations[53 + i]` is pair `i` exactly, and no later entry sorts into the range;
  4. `frozenThrough >= PHASE3_PREFIX_END`.
  It does **not** examine entries 0…52 (that is `checkPhase2Prefix`, `scripts/phase2-prefix.ts:112-149`) nor anything after 0069.
- Standalone: `npx tsx scripts/phase3-prefix.ts --root=<dir>`, exit 0/1 (the form of `scripts/phase2-prefix.ts:151-160`).

**Forbidden.** No file this slice writes asserts "no migration after 0069". That was the P2-S9 defect (`phase2s9AddsNoMigration`, R2:331-343). S9's zero-migration claim is a statement about **one** release and lives only in the S9 evidence (A-13), never in a gate.

**Three guarantees, kept separate** (R2:370-374): `phase2-prefix` protects `0000`–`0052`; `phase3-prefix` protects `0053`–`0069`; the full current chain is protected by `check:migrations` (`scripts/check-migration-manifest.ts:31-60`), by `verify:history` against a live database (`scripts/verify-migration-history.ts:49-81`), and by the runner's own checksum refusal (`apps/api/src/infra/migrate.ts:97-101`).

### A-04 · Composition, and what runs twice (ENG)

What each gate already composes:

- `gate:phase2:release` runs the canary, five in-process checks, `gate:phase1:release`, removes `apps/api/dist`, then `gate:phase2:s8`, `check:deployment-authority` and `check:supply-chain`, stopping at the first failure (`scripts/phase2-release-gate.ts:376-440`).
- `gate:phase1:release` includes `check:db-from-zero -- --release`, which refuses any migration newer than `frozenThrough` (`scripts/phase1-release-gate.ts:501-511`; `scripts/db-from-zero.ts:104-106`), and `test:integration`, which runs **every** suite under `tests/integration` and `tests/security`, the Phase 3 ones included (`package.json:20`; `scripts/phase1-release-gate.ts:531`).
- `gate:phase3:s8` composes `gate:phase3:s7` (`s8:scripts/phase3-s8-gate.ts:828-834`), which composes `s6` (`scripts/phase3-s7-gate.ts:376`) and so on to `gate:phase3:s1`, which composes `check:deployment-authority` and `gate:phase2:s8` (`scripts/phase3-s1-gate.ts:330-331`).

**Ruling.** `gate:phase3:release` composes `gate:phase2:release` and `gate:phase3:s8` **verbatim** (§2). As a result `gate:phase2:s8` and `check:deployment-authority` each run twice per gate run. That duplicate is **not avoidable** without giving a predecessor gate a switch that skips its own steps, and a predecessor gate with a skip switch is a weakened gate (R2:248-251). Everything S9 adds (the Phase 3 prefix, the documents check, the deployed rehearsal) runs once. `check:supply-chain` is not repeated: `gate:phase2:release` already runs it (`scripts/phase2-release-gate.ts:431`). The tree checks (no `.git`, no credential, the archive matches its inventory) are not re-implemented: `gate:phase2:release` asks them of the same root (`:381-382`), and T-05 proves them red.

**Why `gate:phase2:release` must run here at all.** P:291 and SM:79 require it at the Phase 3 release. `ci.yml` never runs it, and `.github/workflows/phase2-s9-release.yml:52-53` triggers only on `phase/2-accounting-core`. At the release head it runs only inside S9's workflow (F-6).

**Cost.** The P2-S9 release job took about 25 minutes for two gate runs: `gate:phase1:release` ≈ 575 s and `gate:phase2:s8` ≈ 250 s per run (JOB `s9last.log`, 15:04:33 → 15:29:27). The Phase 3 chain and the Phase 3 suites inside `test:integration` make S9's run several times longer. The first local run measures it, and the release doc records the per-step durations from the gate artefact (`durationMs`, `scripts/phase2-release-gate.ts:101-110`).

### A-05 · The runner canary becomes real (ENG)

`scripts/runner-canary.ts` gains a main that runs both fixtures (the pair `scripts/phase3-s7-gate.ts:370-373` runs) and applies `canaryRefusal` (`:37-45`) to each. Importing the module still runs nothing (`tests/security/phase2-s8-gate-tamper.test.ts:48` imports it). `gate:phase3:release` runs it as step 1; `gate:phase2:release:378` then runs a real canary too, with no edit to that file. T-06 proves it red.

### A-06 · OD-03 and "no role change", over the frozen Phase 3 files (ENG, **BLOCKED BY OD-03**)

Once the Phase 3 prefix is pinned by digest, any property of those 17 files is fixed forever. It is therefore proved **once, by a permanent test**, not by a gate step that would restate the S4–S6 gates or forbid a later, authorized tax migration. `tests/security/phase3-release-scope.test.ts` (T-02), over exactly `PHASE3_PREFIX`, comments stripped with `stripComments` (`scripts/guards/sql-schema.ts:20`):

- no `tax_payable`; no column matching `/^\s*\w*(tax_rate|tax_percent\w*|\w*inclusive\w*)\s+[A-Z]/im` (the S4 gate's form, `scripts/phase3-s4-gate.ts:318-321`);
- `CONSTRAINT purchases_tax_policy_absent_ck CHECK (tax_minor = 0)` is present in `0063` (`0063_purchases_suppliers_sources.sql:233`);
- no `CREATE ROLE`, `ALTER ROLE`, `GRANT daftar_<x> TO`, or `ALTER DEFAULT PRIVILEGES` statement. (A bare `BYPASSRLS` token is **not** used as the test: `0069` legitimately contains it inside a `RAISE` message, `s8:infrastructure/database/migrations/0069_…:126`.) A scan of all 70 files at `s8int` finds none of the four statements.

Runtime proof of OD-03 is unchanged and composed: `tests/security/purchase-s4-tax.test.ts`, `tests/security/settlement-s6-tax.test.ts`, `apps/web/test/od03.test.ts` (S7 T-12). Tax rates, inclusive/exclusive rules and tax posting stay **BLOCKED BY OD-03** (`docs/DAFTAR_OPEN_DECISIONS.md:11`).

### A-07 · The documents agree with reality — Phase 3 (ENG)

The RB-P2-02 check (`scripts/phase2-release-gate.ts:196-259`), for the Phase 3 pages, in-process in `gate:phase3:release`. Narrow, like its predecessor: specific claims, and a line that marks itself historical is not a finding. The `HISTORICAL` pattern is the P2 one (`:238-239`), copied because that module runs its gate at load (`:480`) and cannot be imported.

- **Pages:** `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`, `docs/PHASE_3_SLICE_MAP.md`, `docs/PHASE_3_S8_ACCEPTANCE.md`, `docs/DAFTAR_OPEN_DECISIONS.md`, and `docs/PHASE_3_S9_RELEASE.md` itself (R2:209-214).
- **Stale claims:**
  1. `/P3-S8[^\n|]{0,60}\b(in progress|candidate|not (yet )?frozen)\b/i` — still calls P3-S8 open (today at `PROJECT_STATUS.md:24`);
  2. `/frozenThrough[^\n|]{0,20}=\s*`?0068/i` — the pre-S8 boundary stated as current (today at `PROJECT_STATUS.md:26`);
  3. `/\b69 (migrations )?frozen\b/i` — the pre-S8 count;
  4. `/next (allowed )?step is P3-S8/i` (today at `PROJECT_STATUS.md:47`);
  5. `/OD-03[^\n|]{0,80}\b(closed|resolved|implemented)\b/i` — OD-03 described as settled.
- **Placeholders:** `/\{\{[A-Z0-9_]+\}\}/` in any page above **or** in any `docs/PHASE_3_S*_ACCEPTANCE.md`. A placeholder is unfinished evidence, never history, so `HISTORICAL` does not excuse it.
- **Required:** `PROJECT_STATUS.md` names OD-03 as `OPEN`; `docs/PHASE_3_S9_RELEASE.md` contains `BLOCKED BY OD-03` and `MAIN_PROTECTION_EXTERNAL_BLOCKER`.

Generated evidence is never edited to make this check pass (P:317); the pages are corrected truthfully.

### A-08 · Tree identity (ENG)

`gate:phase3:release` records the tree like `treeIdentity()` (`scripts/phase2-release-gate.ts:268-285`) and adds one refusal: when `DELIVERY_MANIFEST.json` is present, its `phase` must be `3`. An extracted Phase 2 candidate gated by the Phase 3 gate is not a Phase 3 release. Nothing in the gate shells out to `git` or reads `.git` (R2:253-256); T-03 checks that statically.

### A-09 · The deployment matrix, strengthened (ENG; predecessor-script evolution, SM:56)

`check:deployment-authority` already derives everything from the files on disk (`scripts/phase2-deployment-authority.ts:243-247, 269-305`), so Case A already applies all 70 migrations as `daftar_migrator` (`:482-490`), and §10 already compares the deployer's catalogue with a superuser's (`:788-808`, control built at `:966-971`). S9 closes four gaps in it. None removes or loosens an existing record.

1. **2.11 — the deployer's memberships are exactly the accepted three.** Today 2.8 records them and always passes (`:446-450`). New assertion over `pg_auth_members` for member `daftar_migrator`: exactly `daftar_platform (inherit=true, set=true)`, `daftar_accounting_internal (inherit=false, set=true)`, `daftar_inventory_internal (inherit=false, set=true)`, none with ADMIN, matching `infrastructure/database/bootstrap.sql:260-261, 267` and R2:120-143. A fourth membership, or `INHERIT TRUE` on an internal authority, is a widened migration principal and is red.
2. **§10 — catalogue families added.** Today §10 compares tables, views and matviews (`relkind IN ('r','v','m','p')`), functions, policies, triggers, column ACLs and constraints (`:750-773`). It does not compare sequences, indexes, column definitions, the schema's own owner and ACL, default privileges or extensions. Added queries, normalised the same way (`:775-786`):
   - `sequences`: name, owner, ACL (`relkind = 'S'`);
   - `indexes`: `pg_indexes.indexdef` in `public`;
   - `columns`: table, column, `format_type`, `attnotnull`, default expression;
   - `schema`: owner and `nspacl` of `public`;
   - `defaultAcls`: `pg_default_acl` rows;
   - `extensions`: `extname`, `extversion`;
   - `functions` gains `md5(prosrc)`, so a `CREATE OR REPLACE` that silently did not take effect shows up.
3. **11.4 / 11.5 on both builds and for `PUBLIC`.** Today they run on the deployer's database only (`:918-921`). They also run on `daftar_deploy_superuser_control`, and the matrix adds `has_database_privilege('public', current_database(), 'TEMPORARY')` and `has_schema_privilege('public', 'public', 'CREATE')`, both required `false` (bootstrap's revokes, `bootstrap.sql:271-316`).
4. **Case H — the Phase 3 slice boundaries, one upgrade at a time, as the deployer.** One fresh database (`freshDatabase`, `:230-234`) is taken to `0052`, then to each `PHASE3_SLICE_HEADS` value in order through `migrationsUpTo` (`:237-241`), then to every file on disk. Each step must apply exactly the files between the two boundaries. The final catalogue must equal Case A's under the §10 queries. Case G (`:549-633`) proves 0052 → head in one step with a business; Case H proves that each accepted slice head was itself deployable forward by the deployer.
5. **Wording only.** `FROZEN_THROUGH` (`:124-125`, "the last frozen migration") becomes `PHASE2_PREFIX_END` imported from `scripts/phase2-prefix.ts` (same value). Labels 5.1 (`:528`) and 8b.1 (`:595`) say "then every later migration" instead of "the unfrozen candidates", because at S9 nothing after 0052 is a candidate. The assertions are unchanged.
6. **Importable.** A `require.main === module` guard replaces the load-time call (`:1013-1017`). The membership, catalogue-difference and TEMP/CREATE decisions become exported pure functions, and T-08 proves each red.

The artefact keeps its name, `release/phase2-s9-deployment-authority.json` (`:1002`), because `scripts/phase2-s9-evidence.ts:50` reads it.

### A-10 · The deployed-database rehearsal (ENG)

**The question the matrix cannot answer.** §10 proves that the deployer's catalogue equals a superuser's. It does not prove that the runtime principals can **run the business** on the deployer's database. Every functional suite applies the history as a superuser (`tests/helpers/test-app.ts:152-160`, `runMigrations(dbUrl)` with `dbUrl` the `postgres` URL, `:111`), and so does `db-from-zero` (`scripts/db-from-zero.ts:61, 71`). A suite that applies migrations as superuser never asks the deployer's questions.

**`scripts/phase3-deployed-rehearsal.ts`:**

1. Starts its **own** embedded cluster: `PG_DIR` a fresh `mkdtemp`, `PG_PORT = 55471` (the harness reads both from the environment, `tests/helpers/embedded-cluster.ts:19-20`).
2. Creates `daftar`, applies `bootstrap.sql` as the administrator (`applyBootstrap`, `embedded-cluster.ts:152-169`).
3. Opens a connection as `daftar_migrator` and **refuses** unless `SELECT current_user, session_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user` answers `daftar_migrator, daftar_migrator, false, false`.
4. `runMigrations(<migrator url>)` must apply every `.sql` file on disk, and a second call must apply none. The applied set must contain `PHASE2_PREFIX` and `PHASE3_PREFIX` in order. It must **not** be compared with the number 70: a permanent script that counts files forbids evolution.
5. Snapshots `schema_migrations` (name, sha256, applied_at).
6. Spawns `npx vitest run <DEPLOYED_SUITES>` with the same `PG_DIR`/`PG_PORT`. The global setup's `ensurePostgres` then reuses the server, finds nothing to apply and installs the three keys (`test-app.ts:152-160`; `embedded-cluster.ts:110-139, 171-186`).
7. After the suites: `schema_migrations` must be identical to the snapshot. That proves no migration was applied by any other principal and the suites ran on the deployer's schema. Runtime TEMP and CREATE on `public` must still be `false` for every login role and `PUBLIC`.
8. Writes `release/phase3-s9-deployed-rehearsal.json` (principal row, applied list, history digest before and after, the suite list, vitest's exit status and counts, verdict) and stops the cluster.

**`DEPLOYED_SUITES`**, pinned as a literal:

| Suite | What it proves on the deployer's database |
|---|---|
| `tests/integration/phase3-s8-reconciliation.test.ts` (S8 T-06) | R-INV-01…05 answer `ok` for a business carried through every Phase 3 value source, as `daftar_reconciler`; results carry no amounts |
| `tests/integration/accounting-reconciliation.test.ts` | the nine Phase 2 checks, on the same credential |
| `tests/integration/phase3-s8-mixed-sequence.test.ts` (S8 T-08) | the long mixed command sequence commits through the runtime principals |
| `tests/security/phase3-s8-grant-matrix.test.ts` (S8 T-04) | no runtime DML on a Phase 3 truth table, with grants as the deployer handed them over |
| `tests/security/phase3-s8-definer-law.test.ts` (S8 T-05) | the SECURITY DEFINER law, including owners, on a database whose applier is `daftar_migrator` rather than `postgres` |
| `tests/integration/web-s7-client-contract.test.ts` (S7 T-14) | every Android-callable call, over HTTP, as the runtime principals |
| `tests/integration/read-s7-freshness.test.ts` (S7 T-03) | each command is visible to the next read |

A failure here that the same suite does not show on the superuser-built CI database is a **deployment finding**, not a flaky test. It is triaged, never excluded from the list. If the fix needs a migration, it is outside S9 (§9.1).

### A-11 · Archive portability of the S8 suites (ENG; finding F-3)

The third P2-S9 release run failed inside the extracted archive on `fatal: not a git repository` in `tests/security/phase2-s8-gate-tamper.test.ts` (21 tests, JOB `s9job3.log:1439-1469`). The fix was a `DELIVERY_MANIFEST.json` branch (`tests/security/phase2-s8-gate-tamper.test.ts:79-97`; `.github/workflows/phase2-s9-release.yml:60-64`). P3-S8 reintroduced the same call without the fallback in two suites that `gate:phase3:s8` and `test:integration` both run:

- `s8:tests/security/phase3-s8-gate-tamper.test.ts:172-176`;
- `s8:tests/integration/phase3-s8-guards.test.ts:416-421`.

Both take the P2 fallback. **Order of work (R2:301-303):** reproduce the failure first in a local extraction with no `.git`, then show it green with the fix. T-11 makes the class permanent.

### A-12 · CI wiring and the exact-SHA law — see §5.

### A-13 · The evidence assembler (ENG)

`scripts/phase3-s9-evidence.ts` keeps every P2 check (`scripts/phase2-s9-evidence.ts:105-181`: sidecar digest, manifest read out of the zip, forbidden entries, tree kinds, commit and tree-hash agreement, both verdicts PASS with 0 fail and 0 mandatory skips) and adds:

1. **Exact SHA.** `--expected-sha` is required, and `delivery.sourceCommit` must equal it. P2 only records `GITHUB_SHA` (`:226-230`) and never compares it; under `workflow_dispatch` with `inputs.sha`, `GITHUB_SHA` is the branch head and not the commit under release (`scripts/phase2-s8-binding.ts:41-52`).
2. **A second, independent path to the content.** `--git-archive=<tar>` is `git archive --format=tar --prefix=DAFTAR/ <sha>`. The tree hash is recomputed from its files with the export's algorithm (`scripts/export-release.ts:190-191`), and it must equal `delivery.treeHash`, with the same path set as `delivery.inventory`. The repository has no `.gitattributes` and no symlinks, so git blobs and checkout bytes are identical.
3. `delivery.phase === 3`.
4. **The S9 zero-migration claim, for this release only.** `delivery.migrationHashes` must equal `PHASE2_PREFIX` followed by `PHASE3_PREFIX`, exactly, and `frozenThrough` must be `PHASE3_PREFIX_END`. This is legitimate here and nowhere else: the file describes one run of one SHA and is named for the slice. *Corrective pass amendment:* the corrective freeze accepted 0070–0073, so the list the Phase 3 release ships is `PHASE2_PREFIX`, `PHASE3_PREFIX`, then `CORRECTIVE_ACCEPTED` in `CORRECTIVE_MIGRATIONS` order at the accepted digests, and `frozenThrough` is the last of them (`PHASE3_PREFIX_END` while none is accepted). P3-S9 itself still adds none; an unaccepted or re-digested migration is still refused (`tests/security/phase3-s9-evidence.test.ts`).
5. The deployment-authority artefact is `PASS`, and its `roleMatrix` shows `temporaryOnDatabase` and `createOnPublic` false for every role but the deployer. The deployed-rehearsal artefact is `PASS`.
6. The nested `gate:phase2:release` artefact, which the Phase 3 gate writes into its log directory, is `PASS` in both runs, with the same tree kind as its parent.

### A-14 · Final reviews — see §6.

### A-15 · What S9 does not change (ENG)

- No migration, no manifest entry and no bootstrap edit; the migration principal is not widened (A-09 2.11 makes a widening red).
- No file under `apps/**`, `packages/**` or `infrastructure/**`. The coordinator checks that `git diff --stat <S8 freeze>..<release head> -- apps packages infrastructure` is empty before acceptance. This is also what keeps the S7 T-17 and S8 T-13 Tier 2 evidence valid for the release head: both measured product code S9 does not touch.
- No test is weakened, skipped or narrowed. The two S8 suite edits (A-11) change **where** the file list comes from, never what is asserted. No `it.skip`, `.only`, `RELEASE_GATE_SKIP_*` or budget change.
- No Phase 4 work and no merge of PR #4 (`PROJECT_STATUS.md:47`).

---

## 2. The release gate — `scripts/phase3-release-gate.ts`

**Usage:** `npm run gate:phase3:release [-- --evidence=<file>] [--log-dir=<dir>] [--archive-sha256=<hex>] [--list] [--root=<dir> --structural-only]`. Defaults: `release/phase3-s9-release-gate.json` and `release/phase3-gate-logs-<stamp>/`.

**Harness.** The same `runStep` / `inProcess` / artefact shape as `scripts/phase2-release-gate.ts:60-143, 442-467` (copied, because that module runs at load, `:480`): mandatory steps, per-step log, `summary`, `durationMs`, stop at the first failure (`:434-440`), a `RELEASE_GATE_SKIP_*` refusal **before anything runs** that still writes a FAIL artefact with `mandatorySkipped` (`:358-371`). `--root` and `--structural-only` follow `s8:scripts/phase3-s8-gate.ts:29-33, 915-917`: they change **where** the gate looks, never **what** it demands, and a structural-only run reports no release verdict.

**Plan (all mandatory, in order):**

| # | Step | Kind | Source |
|---|---|---|---|
| 1 | runner canaries, root and web, outside Vitest | `npx tsx scripts/runner-canary.ts` | A-05 |
| 2 | tree identity; a delivery manifest, if present, says `phase: 3` | in process | A-08 |
| 3 | Phase 3 migration prefix `0053`–`0069` intact; later migrations permitted | in process, `checkPhase3Prefix` | A-03 |
| 4 | no authoritative Phase 3 document contradicts the accepted state | in process | A-07 |
| 5 | **`gate:phase2:release`** — the predecessor release gate, verbatim, with `--evidence=<log-dir>/phase2-release-gate.json --log-dir=<log-dir>/phase2 --archive-sha256=<forwarded>` | `npm run -s gate:phase2:release -- …` | A-04 |
| 6 | the source tree is a source tree again: `apps/api/dist` removed and checked absent | in process (the step at `scripts/phase2-release-gate.ts:415-419`, repeated because this is a new composition boundary) | R2:309-320 |
| 7 | **`gate:phase3:s8`** — composes S7 … S1, P2-S8 … P2-S1 and Phase 1 | `npm run -s gate:phase3:s8` | A-04 |
| 8 | the deployed-database rehearsal | `npm run -s rehearse:phase3:deployed` | A-10 |

What steps 5 and 7 bring, so nothing is restated: toolchain, manifest, `db-from-zero --release`, guards, localization, format, lint, typecheck, unit, integration + security (every Phase 3 suite), golden, API/web/admin builds, Android, audit, artefact and secret scans, docs (`scripts/phase1-release-gate.ts:436-586`); the Phase 2 prefix and the tree checks (`scripts/phase2-release-gate.ts:381-385`); the deployment matrix (A-09) and supply chain; every Phase 3 slice gate's structural checks, suites and Tier 1 budgets.

**Where each Phase 3 closure claim is proved** (the R2 §5.1 table, for Phase 3):

| Claim | Proved by |
|---|---|
| `0000`–`0052` unchanged | `scripts/phase2-prefix.ts` (step 5; `ci.yml` step) |
| `0053`–`0069` unchanged | `scripts/phase3-prefix.ts` (step 3; `ci.yml` step); each slice gate's accepted digests (step 7) |
| no unfrozen migration ships | `db-from-zero --release` (step 5) |
| a changed applied migration is a hard fail | runner checksum, Case E (`scripts/phase2-deployment-authority.ts:643-663`); `verify:history` (`ci.yml:129-132`, `:269-280`) |
| deployable by the non-superuser principal, same catalogue as superuser | A-09 (steps 5 and 7) |
| the business runs on the deployer's database; reconciliation is exact | A-10 (step 8) |
| runtime TEMP / CREATE on `public` = 0 | A-09 §3; A-10 step 7 |
| no runtime DML on Phase 3 truth; SECURITY DEFINER law; one consumer per kind | S8 T-04, T-05, T-03 (step 7; again on the deployer's database in step 8) |
| OD-03 bounded | T-02 (inside step 5's `test:integration`); the S4/S6 tax suites; S7 T-12 |
| the runner can report failure | step 1, then every composed gate's own canary |

---

## 3. Archive and clean environment

### 3.1 The archive

`npm run export:release:phase3` → `release/DAFTAR_PHASE_3_RC.zip` plus a sibling `.sha256` (R2:391-409). The mechanics are P2's, unchanged:

- the inventory is `git ls-files` (`scripts/export-release.ts:113-118`);
- it refuses a dirty tree, so the archive describes exactly one commit (`:119-124`);
- it refuses untracked reproduction inputs (`:126-132`), forbidden names (`:134-140`, pattern `:55-56`), credential content (`:155-158`) and any migration newer than `frozenThrough` (`:166-171`);
- `DELIVERY_MANIFEST.json` carries the tree hash and its algorithm, the inventory, the migration hashes, `frozenThrough` and `sourceCommit` (`:174-205`);
- `zip -qrX`, the entry-count check against the inventory, then the sidecar digest (`:214-223`).

**Phase 3 reproduction commands** (the `REPRODUCTION` list, `:39-53`): `npm ci`; `npm run gate:phase3:release -- --evidence=release/phase3-s9-release-gate.json`; `npm run check:deployment-authority`; `npm run rehearse:phase3:deployed`; the three key installs (`bootstrap:provisioning-key`, `bootstrap:accounting-key`, `bootstrap:inventory-key`, `package.json:36-38`).

**The exact SHA, twice.** The workflow checks out `EXPECTED_SHA` and asserts `git rev-parse HEAD` equals it before exporting. The evidence then requires `delivery.sourceCommit` to equal it (A-13 1), and the `git archive` of that SHA to have the same tree hash (A-13 2). The content is therefore proven to be the commit's by two independent routes: the working tree (`git ls-files` plus file bytes) and the object store.

A check of the tracked tree at `s8int` against `FORBIDDEN_NAME` and `FORBIDDEN_CONTENT` (`:55-59`) finds no hit, so the S2–S8 additions do not break the export.

### 3.2 The two gate runs, and what "clean" means

| Run | Where | Database | Evidence |
|---|---|---|---|
| repository | the checkout at `EXPECTED_SHA`, `npm ci` | the job's `postgres:16` service (`PG_PORT=5432`) | `release/phase3-s9-release-gate.json`, tree kind `source-checkout` |
| extracted archive | `$RUNNER_TEMP/rc/DAFTAR`, outside the checkout, with no `.git` and none reachable above it (`phase2-s9-release.yml:153-169`), then `npm ci` | a **new embedded cluster**: `PG_DIR=$RUNNER_TEMP/pg-archive`, `PG_PORT=55432`, both set at step level so they override the job's `PG_PORT` | `release/phase3-s9-release-gate-archive.json`, tree kind `extracted-archive` |

**Why a new cluster (finding F-2).** In P2-S9 the job-level `PG_PORT: '5432'` (`.github/workflows/phase2-s9-release.yml:100-101`) applied to the extraction step too. The harness reuses a listening server and treats `CREATE DATABASE daftar` as "already exists" (`tests/helpers/embedded-cluster.ts:171-186`), and its migrations only apply what is pending (`test-app.ts:155-157`). The archive run therefore tested on the **repository run's already-migrated database**, and never migrated the history from zero through the harness. Its from-zero proofs came only from `db-from-zero` and the deployment matrix, which use clusters of their own. S9's archive run starts a cluster no earlier step touched: no roles, no databases, no data. This is also a PostgreSQL-major difference (the service is 16; embedded is 18, the version every local gate run and the S7/S8 Tier 2 evidence used). The evidence records both server versions.

The other clusters are already per-process and throw-away: `db-from-zero` on 55461 (`scripts/db-from-zero.ts:32, 46-48`), the deployment matrix on 55434 with PG 16 binaries (`scripts/phase2-deployment-authority.ts:82-83, 191-214`), the deployed rehearsal on 55471 (A-10).

**Clean runner.** A GitHub-hosted runner starts with no build output and no `node_modules`; `setup-node`'s `cache: npm` caches `~/.npm` only. `gate:phase1:release` deletes every build output first and rebuilds the library packages in derived topological order (`scripts/phase1-release-gate.ts:30-44, 473-488`), the P2-S9 correction (R2:287-303).

**Local reproduction** (supporting evidence, never a CI claim): `git archive` or `export:release:phase3` at a clean commit, `unzip` into `/tmp/<new dir>` with `GIT_CEILING_DIRECTORIES=/tmp`, `npm ci`, then `PG_DIR=$(mktemp -d) PG_PORT=55432 npm run gate:phase3:release`. Locally the Android step needs the Android SDK and so passes only on GitHub (`PROJECT_STATUS.md:27`). This is where every archive-only failure is reproduced **before** it is fixed (A-11).

---

## 4. The deployment rehearsal, in one place

| Question | Answered by | As whom |
|---|---|---|
| 70 migrations from an empty database | Case A (`scripts/phase2-deployment-authority.ts:482-490`) | `daftar_migrator` |
| `SUPERUSER = FALSE`, `BYPASSRLS = FALSE`, no CREATEDB / CREATEROLE / REPLICATION | 2.3–2.7 (`:433-437`); A-10 step 3 in the applying session itself | live catalogue |
| the principal is not widened | 2.9, 2.10 (`:451-468`); **2.11 exact memberships** (A-09 1) | live catalogue |
| Phase 1 → head, 0050 → head, 0052 → head with a business | Cases B, C, G (`:492-535, 549-633`) | deployer |
| each accepted Phase 3 slice head → head | **Case H** (A-09 4) | deployer |
| re-run is a no-op | Case D (`:635-641`) | deployer |
| a changed applied file is a hard fail, history untouched | Case E (`:643-663`) | deployer |
| a mid-history failure rolls back completely | Case F (`:665-718`) | deployer |
| the history table belongs to the deployer; checksum validation cannot be switched off | §9 (`:724-744`) | — |
| same catalogue as a superuser build | §10 plus the A-09 2 families | both builds |
| runtime TEMP / CREATE on `public` = 0 | 11.4 / 11.5 (`:918-921`) on **both** builds plus `PUBLIC` (A-09 3); again after the suites (A-10 step 7) | every login role, `PUBLIC` |
| no runtime member of an internal authority; the internal authorities have no login | 11.6–11.8 (`:922-937`) | — |
| the business runs, and reconciles exactly, on the deployer's database | A-10 | runtime principals, `daftar_reconciler` |
| the deployment credential is not read by runtime code | 2.1 (`:374-411`) | static |

The only superuser act anywhere is the deployment administrator's own `bootstrap.sql` step (R2:150-152).

---

## 5. CI wiring and the exact-SHA law

### 5.1 `ci.yml` (DAFTAR CI; the five required jobs stay required, P:291)

- **backend:** unchanged apart from the two prefix steps (A-01). The Phase 3 step is `gate:phase3:s8`, as S8's freeze leaves it (S8C:860). The per-slice Phase 2 steps (`ci.yml:141-256`) stay.
- **workspaces, web-admin, android, hygiene:** unchanged.
- `gate:phase3:release` is **not** added to `ci.yml`. It is a release property with a multi-hour cost, and it lives in its own workflow, exactly as P2 did (`phase2-s9-release.yml:29-30`: "It does NOT stand in for `ci.yml`, and `ci.yml` does not stand in for this").

### 5.2 `.github/workflows/phase3-s9-release.yml` — "DAFTAR P3-S9 release evidence"

**Triggers — yes, it triggers on push.**
- `workflow_dispatch` with inputs `sha` and `ci_run` (the form of `phase2-s9-release.yml:35-44`).
- `push` to `phase/3-inventory-purchases-suppliers`, with `paths`: `apps/**`, `packages/**`, `infrastructure/**`, `scripts/**`, `tests/**`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.github/workflows/phase3-s9-release.yml`, `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`, `docs/PHASE_3_*.md`, `docs/PHASE_2_*.md`, `docs/PHASE_1_MIGRATION_HISTORY_DECISION.md`, `docs/DAFTAR_OPEN_DECISIONS.md`. The documents are included because the gate reads them, and because "a head this workflow never ran on is a head no hand-off can honestly name" (`phase2-s9-release.yml:69-71`).
- `phase2-s9-release.yml` is left as it is. It is Phase 2 history, still dispatchable, and `gate:phase2:release` now runs inside the Phase 3 job.

**Job** (one job, one working directory, one commit, R2:430-433): `runs-on: ubuntu-latest`, `timeout-minutes: 350` (the GitHub-hosted ceiling is 360), a `postgres:16` service, `concurrency: p3s9-release-<sha>` with `cancel-in-progress: false`. Steps:

1. Resolve `EXPECTED_SHA = inputs.sha || github.sha`; checkout that ref with `fetch-depth: 0`; **assert** `git rev-parse HEAD` = `EXPECTED_SHA`.
2. `setup-node` 24.12.x; Java 17; `setup-android` with the explicit package list (`phase2-s9-release.yml:118-128`); PostgreSQL 16 server binaries and `zip`/`unzip` (`:130-140`).
3. `npm ci`.
4. Repository run: `npm run gate:phase3:release -- --evidence=release/phase3-s9-release-gate.json`.
5. `npm run export:release:phase3`; `git archive --format=tar --prefix=DAFTAR/ "$EXPECTED_SHA" > "$RUNNER_TEMP/git-archive.tar"`.
6. Extract into `$RUNNER_TEMP/rc`; `test ! -e .git`; the `git rev-parse --is-inside-work-tree` refusal (`:166-169`); `npm ci`; then, with step-level `PG_DIR=$RUNNER_TEMP/pg-archive` and `PG_PORT=55432`, run `npm run gate:phase3:release -- --evidence=… --archive-sha256=<sidecar>`; copy the artefact back.
7. `npm run evidence:phase3:s9 -- --repo-gate=… --archive-gate=… --archive=release/DAFTAR_PHASE_3_RC.zip --git-archive="$RUNNER_TEMP/git-archive.tar" --expected-sha="$EXPECTED_SHA" --ci-run='<input>'`.
8. Summary (`if: always()`); upload the evidence JSONs, the deployment and deployed-rehearsal JSONs and the sidecar (`if: always()`, `if-no-files-found: error`); the RC zip (`ignore`); logs on failure (the upload discipline of `:199-232`).

### 5.3 The exact-SHA evidence law

1. **No CI-success claim for a commit unless a workflow run exists whose head SHA is exactly that commit** (P:323). For the release head this means **both** of these exist and succeeded:
   - a `DAFTAR CI` run with all five jobs `success`, found by `head_sha`;
   - a `DAFTAR P3-S9 release evidence` run whose evidence file says `source.commit == <release head>`, verdict `PASS`, and both gate runs `PASS` with 0 fail and 0 mandatory skips.
2. A pull-request run tests the merge ref. The coordinator records that `origin/main` is an ancestor of the release head (the branch was cut from `0f2b09e7`, P:5), so the merge tree is the candidate tree.
3. A run on an **earlier** commit is never carried forward. A documentation-only commit after the evidence run needs its own runs; the workflow's `paths` make that automatic.
4. Run ids, durations and digests live in `release/phase3-s9-release-evidence.json` and in the hand-off message, **never** in `docs/PHASE_3_S9_RELEASE.md` (the loop R2:6-13 describes).
5. A local run is supporting evidence, and is labelled so wherever it is quoted.
6. `MAIN_PROTECTION_EXTERNAL_BLOCKER` (TD-08, P:325) is recorded, never described as configured.

---

## 6. Final reviews

Each review is independent: the reviewer reads the S9 diff, the contracts, the artefacts and the tests themselves, not a summary (SM:49). Findings are closed before acceptance, and never by weakening a test.

### 6.1 Security (T-15)

| # | Check | Evidence |
|---|---|---|
| S-1 | No principal is superuser or BYPASSRLS; the deployer is not widened (exact memberships, no ADMIN, no member of the deployer); internal authorities have no login and no runtime member | deployment artefact 2.3–2.11, 11.1–11.8 |
| S-2 | Runtime TEMP and CREATE on `public` are zero for every login role and `PUBLIC`, on both builds and after the business ran | A-09 3; A-10 step 7 |
| S-3 | No runtime DML on any Phase 3 truth table | S8 T-04, on the CI database and on the deployer's |
| S-4 | SECURITY DEFINER law: safe `search_path` with `pg_temp` last, PUBLIC EXECUTE revoked, NOLOGIN owner, no temporary relation | S8 T-05, on both databases |
| S-5 | Every `invctl/1`-mutating routine consumes or re-verifies an assertion; one consumer per operation kind, none generic | S8 T-01, T-03 |
| S-6 | Assertion keys are separated by effective HMAC key (TD-12 closed) | S8 T-15a/b |
| S-7 | The reconciler is read-only, with exactly its column grants and its must-not-read list | S8 T-16; `reconciler-privilege-model.json` |
| S-8 | `MIGRATION_DATABASE_URL` is read by the migration command only | 2.1 |
| S-9 | Web: the per-request CSP nonce, proxy path refusal and `no-store` are **present at the release head** (P-2) | `apps/web/test/csp.test.ts`, `platform.test.ts`; S7 L-1 |
| S-10 | Supply chain: `npm audit --audit-level=high` = 0, gitleaks, raw-credential scan, no forbidden archive entry | composed steps; evidence `forbiddenEntries = []` |
| S-11 | OD-03 bounded | T-02; the S4/S6 tax suites; S7 T-12 |
| S-12 | The S9 diff adds no runtime surface: every changed file is under `scripts/`, `tests/`, `.github/`, `docs/`, the root `package.json`, `PROJECT_STATUS.md` or `TECHNICAL_DEBT.md` | `git diff --stat` |

### 6.2 Data integrity (T-16)

| # | Check | Evidence |
|---|---|---|
| D-1 | Zero tolerance on a seeded business: R-INV-01…05 and the nine Phase 2 checks answer `ok`, with `offendingCount = 0` and no `unavailable`, for every business the reader enumerates | S8 T-06 in step 7 (CI database) **and** step 8 (deployer's database) |
| D-2 | The checks cannot pass by reading nothing: at the S7 head (0068) the five answer `unavailable` | S8 T-06's own clause |
| D-3 | Each R-INV check goes red on its planted discrepancy | S8 T-07 |
| D-4 | The rebuild rehearsal, fold and verify are exact | S8 T-09 |
| D-5 | No authoritative or cached balance, no float, no rounding in the reader | guards G-2/G-3; the S8 gate's lossy-operation check (`s8:scripts/phase3-s8-gate.ts:705-709`) |
| D-6 | Frozen history: both prefixes, `verify:history`, Case E, the `db-from-zero` tamper proof (`scripts/db-from-zero.ts:117-132`) | §2 table |
| D-7 | Tier 2 evidence (S7 T-17, S8 T-13) still describes the release head, because S9 changed no product code | A-15 diff check |
| D-8 | Results carry identifiers, counts and timings only | S8 T-06 `SAFE_KEYS` |

### 6.3 UX — a T-18-style real-browser pass (T-17)

- **What.** The S7 screens (`scripts/phase3-s7-gate.ts:87-100`, twelve routes) and the header, in **ar and en**, at **360×640 and 1280×800**, in headless Chromium, through `next build && next start` of the release head against the real API and a business seeded through the API. The flows are those of S7A:106: Move; Count (list and sheet); Adjust, including Starting stock; Receive; Receive and pay; Return; Pay; the supplier and purchase pages, including Undo receipt visibility.
- **Pass criteria** (S7A:106-108): every run completes; no page is wider than its viewport; no clipped or over-wide element; no raw catalog key; no U+FFFD; no API error; no CSP violation in the console; the page hydrates (on phones the menu button toggles the header); `dir="rtl"` in ar; list rows are reachable and operable by keyboard (`100eb67`); no tax field or option; no accounting word.
- **Red proof first.** The harness is run once against a build with a planted 400-px-wide element on `/stock` and a planted missing key, and must report both before its clean result is believed.
- **Evidence.** Counts and findings go into `docs/PHASE_3_S9_RELEASE.md`. Screenshots and the results JSON stay with the coordinator, and the repository holds no binary evidence (the S7 rule, S7A:106). The S7 harness and results (`t18/`, `t18b-results.json`) are in the coordinator scratchpad.
- **TD-06 stays open**: CI still has no browser job (`TECHNICAL_DEBT.md:15`; S7 TL-2).

---

## 7. Test plan

Every red proof is made before the corresponding PASS is quoted. T-01 … T-11 are automated and fast. Each lives under `tests/security` and so also runs inside `test:integration`, i.e. inside every release gate run. None of them spawns a heavy gate: a composed gate is only run on a copy where it fails early, or with `--list` / `--structural-only`.

| # | File | Proves |
|---|---|---|
| T-01 | `tests/security/phase3-release-prefix.test.ts` | `PHASE3_PREFIX` is 17 entries, `0053`…`0069`, equal to manifest entries 53–69 and to `S8_ACCEPTED` (importable: `s8:scripts/phase3-s8-gate.ts:29-35`). On throwaway copies (the method of `tests/security/phase2-release-prefix.test.ts:35-50`): **PASS** on the intact tree and on the tree plus a synthetic `0070` in the copy only (forward evolution). **FAIL** on one byte changed; on one byte changed with the manifest digest updated to match; on a deleted, renamed, or moved-out file; on a file inserted into the range; on a reordered manifest; on a changed or removed entry; on `frozenThrough` moved below `0069`. The standalone check exits 0 and 1 respectively. |
| T-02 | `tests/security/phase3-release-scope.test.ts` | A-06 over exactly `PHASE3_PREFIX`: no `tax_payable`, no tax rate / percent / inclusive column, `purchases_tax_policy_absent_ck` present in `0063`, no role DDL, membership grant or default-privilege change. **Red:** each predicate flags a planted fixture string, and a `RAISE '… BYPASSRLS'` string is **not** flagged. |
| T-03 | `tests/security/phase3-release-gate.test.ts` | (a) `RELEASE_GATE_SKIP_X=1` → exit 1 before any step, and the artefact says `FAIL`, `mandatorySkipped: 1`, `steps: []`. (b) `--list` shows exactly the eight steps of §2 in order, all mandatory, canary first, `gate:phase2:release` before `gate:phase3:s8`, the restore step between them. (c) Static: the gate's source spawns no `git` and reads no `.git`, and names no migration after `PHASE3_PREFIX_END`. (d) `--root <copy> --structural-only`: **FAIL** on a tampered Phase 3 file, on a planted stale claim, on a delivery manifest with `phase: 2`; **PASS** on the intact copy and on the copy plus a synthetic frozen `0070` with its manifest entry. That last case is the lesson of R2:325-343, proven. |
| T-04 | `tests/security/phase3-release-docs.test.ts` | Each A-07 claim planted in a copy of each page → a finding with file and line. The same line with a historical marker → no finding. A `{{CANDIDATE}}` in an acceptance page → a finding, even when marked historical. The required OD-03 and `MAIN_PROTECTION_EXTERNAL_BLOCKER` texts removed → a finding. `docs/PHASE_3_S9_RELEASE.md` is in the list. |
| T-05 | `tests/security/release-tree-archive.test.ts` | End to end, on a hard-linked copy (the method of `tests/security/phase2-s8-gate-tamper.test.ts:99-134`) with `node_modules` symlinked in and a `DELIVERY_MANIFEST.json` built with the export's algorithm. `gate:phase3:release` run **in the copy** must stop red on: a planted `.git/` ("the gated tree contains .git", via step 5's composed check `scripts/phase2-release-gate.ts:328-354`); a planted `.env`; one inventoried file changed by one byte (`:288-311`); a manifest `treeHash` that does not recompute; `phase: 2` (A-08). Each case stops before `gate:phase1:release`, so the file stays fast. |
| T-06 | `tests/security/runner-canary.test.ts` | `npx tsx scripts/runner-canary.ts` exits 0 on the real tree and reports both canaries. On a copy where either fixture's failing test is replaced by its passing twin (`tests/fixtures/runner-exit-code/passing.fixture.ts`, `apps/web/test/fixtures/runner-exit-code/passing.fixture.tsx`) it exits 1 with "did not run its failing test", naming which runner. Importing the module runs nothing. |
| T-07 | `tests/security/phase3-s9-evidence.test.ts` | The assembler on synthetic artefacts in a temporary release directory (a real small zip built with `zip -X`). **PASS** on a consistent set. **FAIL**, each with its named problem, on: a sidecar mismatch; a forbidden entry (`DAFTAR/.env`); an archive gate with kind `source-checkout`; a tree hash or commit that disagrees; `sourceCommit ≠ --expected-sha`; a `git archive` tar whose tree hash or path set differs; `phase: 2`; a migration list with an extra `0070` or a changed digest; a deployment or rehearsal verdict `FAIL`; a role with `temporaryOnDatabase: true`; a gate with `mandatorySkipped: 1`; a nested `gate:phase2:release` artefact not `PASS`. |
| T-08 | `tests/security/deployment-authority-model.test.ts` | The exported pure checkers of A-09. Membership: pass on the three accepted rows; fail on `INHERIT TRUE` for either internal authority, on ADMIN OPTION, on a fourth membership, on a missing one. Catalogue difference: flags a single differing index, sequence ACL, column default, default-ACL row, schema ACL, extension version or function body digest. TEMP/CREATE: flags a runtime role or `PUBLIC` holding either. Importing the module starts no cluster. |
| T-09 | `npm run check:deployment-authority` (live; composed twice per gate run) | Cases A–H over every file on disk (70 at release), §10 with the added families, 2.11, 11.1–11.8 on both builds plus `PUBLIC`. Its built-in red cases stay: Case E (tamper → checksum refusal) and Case F (mid-history failure → full rollback). |
| T-10 | `tests/security/phase3-deployed-rehearsal.test.ts` + `npm run rehearse:phase3:deployed` (live, step 8) | Pure: the principal check refuses `rolsuper = true`, `rolbypassrls = true` or `current_user ≠ daftar_migrator`; the history comparison flags an added row, a changed digest or a removed row; `DEPLOYED_SUITES` equals the A-10 list and every file exists; the script contains no numeric migration count. Live: A-10 steps 1–8 green, with the artefact `PASS`. |
| T-11 | `tests/security/archive-portability.test.ts` + the two S8 edits (A-11) | Every `git` invocation (`execFileSync('git'`, `spawnSync('git'`, `execSync('git`) in `tests/**` and `scripts/**` sits in a file that also carries a `DELIVERY_MANIFEST.json` branch or a `try`/`catch` fallback (`tests/performance/accounting-budgets.test.ts:294-300`). The only exceptions are an allowlist of tools that legitimately need a repository: `scripts/export-release.ts`, `scripts/phase1-release-gate.ts` (guarded by `IS_GIT`, `:348`), `scripts/phase2-s8-binding.ts`, `scripts/phase2-s8-evidence.ts`, `scripts/phase2-rollback-rehearsal.ts`. **Red:** a planted fixture with a bare call is flagged. **Recorded red:** before the A-11 fix, the two S8 suites fail in a local extraction with `fatal: not a git repository`; after it they pass. |
| T-12 | `ci.yml` prefix steps | Both standalone checks pass on the release head. Their red is T-01's standalone case and `tests/security/phase2-release-prefix.test.ts:187-198`. |
| T-13 | The release workflow at the exact SHA | Repository run and archive run `PASS` (0 fail, 0 mandatory skipped), tree kinds correct, evidence `PASS` with `source.commit` = the release head. |
| T-14 | Predecessor gates at the exact SHA | `DAFTAR CI`, all five jobs: `gate:phase1`, `gate:phase2:s1` … `s8`, `gate:phase3:s8` (which composes S7 … S1). The release workflow: `gate:phase2:release` and `gate:phase1:release`. Together these cover P:291's list. `gate:phase2:s8:release` (Level B, bound to the P2-S8 commit, `scripts/phase2-s8-release-gate.ts:1-40`) is not in that list and is not run. |
| T-15 | Security review (manual, independent) | §6.1 |
| T-16 | Data-integrity review (manual, over T-09/T-10 artefacts and step 7) | §6.2 |
| T-17 | UX real-browser pass (manual, T-18 style), harness proven red first | §6.3 |

**Red proofs of the release gate, summarised:** T-03 (skip, plan, structural, forward evolution), T-04 (documents), T-05 (tree and archive, end to end), T-06 (canary), T-07 (evidence), T-08 and T-10 (deployment decisions). The gate's whole-run red on GitHub is **not** manufactured by pushing a tampered branch: P:323 allows pushes only to the phase branch. The first real GitHub run, like P2-S9's, is expected to find clean-runner or archive-only failures, and each is recorded in the release doc the way R2 §5.2 records P2's (A-11 is the one already predicted).

---

## 8. File ownership (at most 3 implementation agents)

SM:47 sets P3-S9's SAFE_CONCURRENCY to **1** ("coordinator only"). Three agents are admissible only because the streams below touch disjoint files and none writes schema. Two rules keep that true: only the coordinator runs a composed gate, and only one agent at a time runs any embedded-PostgreSQL work (SM:37). If the Tech Lead holds SM:47, the same three streams run one after another (§9.2 TL-7).

| Agent | Owns | Needs a database | Starts |
|---|---|---|---|
| **A — Release gate, evidence, workflow** | `scripts/phase3-prefix.ts`, `scripts/phase3-release-gate.ts`, `scripts/phase3-s9-evidence.ts`, `scripts/runner-canary.ts` (main), `scripts/export-release.ts` (`--phase=3`), root `package.json` (all four lines, B's included), `.github/workflows/phase3-s9-release.yml`, `.github/workflows/ci.yml` (two prefix steps); T-01 … T-07, T-12 | no | after P-1 (it needs the 0069 pair) |
| **B — Deployment rehearsal** | `scripts/phase2-deployment-authority.ts` (A-09, predecessor-script evolution delegated by the coordinator, SM:56), `scripts/phase3-deployed-rehearsal.ts`; T-08, T-09, T-10 | yes (its own clusters: 55434, 55471) | at once; imports `PHASE3_SLICE_HEADS` from A's module (A lands `phase3-prefix.ts` first, day 1) |
| **C — Archive portability and the clean-environment reproduction** | `tests/security/phase3-s8-gate-tamper.test.ts`, `tests/integration/phase3-s8-guards.test.ts` (A-11; predecessor-test evolution delegated by the coordinator), `tests/security/archive-portability.test.ts`; T-11; the local extraction reproduction (§3.2); the UX harness red proof and pass (T-17, harness outside the repository) | yes, for the local extraction run (one `PG_DIR`) | at once (or in S8 before its freeze, P-4) |
| **Coordinator** | `docs/PHASE_3_S9_RELEASE.md`, `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`; every composed gate run; workflow dispatch; the exact-SHA checks (§5.3); the A-15 diff check; dispatching the security and data-integrity reviewers | — | lands last |

**Merge order:** C (portability first, or the first archive run fails exactly as P2-S9's third did), then B, then A, then the coordinator's documents.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**None.** Each candidate was checked against the six classes:

- **Product-constitution ambiguity:** none. P:269-271 and SM:16 fix the scope.
- **Legal/tax:** OD-03 stays bounded (A-06). Nothing in S9 needs a tax rule.
- **Paid provider:** none added. The release job runs on GitHub-hosted runners, as P2-S9's did. If the account's Actions minutes cannot cover a job of several hours, that is an account limit for the owner, not a design decision.
- **Destructive data decision:** none. Zero migrations; the only databases created are throwaway.
- **External credential:** none needed. `MAIN_PROTECTION_EXTERNAL_BLOCKER` (TD-08) is external, recorded, and does not block Phase 3 (P:325).
- **Architectural contradiction:** none in S9. B-1 belongs to S8 (S8C:915-933) and is a **precondition** (P-1), not an S9 blocker.

**Conditional.** If A-09's strengthened catalogue diff or A-10's deployed rehearsal finds a real deployment defect whose fix needs a migration (for example, a Phase 3 SECURITY DEFINER routine left owned by the applier, visible only when the applier is `daftar_migrator`), S9 cannot fix it: S9 has zero migrations and frozen files never change. That would become an architectural blocker for the Tech Lead, to be answered by an authorized forward migration. It is not pre-judged here.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · Sequencing.** S9 starts after the S8 freeze, on a head containing the S7 freeze and the S7 web fixes (P-1, P-2). The 0069 name and digest in `PHASE3_PREFIX` come from the S8 freeze and therefore from the B-1 ruling (R-B1a is the working default, `s8:scripts/phase3-s8-gate.ts:52-60`).
- **TL-2 · The duplicate is accepted** (A-04). `gate:phase2:s8` and `check:deployment-authority` run twice per gate run, and four times per workflow run. The alternative, a "composed-elsewhere" switch on `gate:phase2:release` or `gate:phase3:s1`, is a skip switch on a predecessor gate and is rejected.
- **TL-3 · Finding F-1, fixed without touching the P2 gate.** `gate:phase2:release`'s step 1 has never run a test (`scripts/phase2-release-gate.ts:378` → `scripts/runner-canary.ts:1-45`, no main). The verdict was still safe, because `gate:phase2:s8`'s real canary (`scripts/phase2-s8-gate.ts:1159-1171`) runs later and would fail the gate. But the step's description (R2:228-230) is false. The fix is a main in `runner-canary.ts` (A-05). R2 gets a dated correction line, in the manner of R2 §5.3, recorded by the coordinator.
- **TL-4 · Finding F-2, the archive run's database** (§3.2). S9's archive run uses a new embedded cluster (PostgreSQL 18) while the repository run uses the `postgres:16` service. Both majors are exercised; the evidence records both versions. The alternative is dropping and recreating `daftar` and every `daftar_*` role on the service between the runs; it is rejected as less clean, because roles are cluster-wide.
- **TL-5 · The deployment matrix is strengthened, not rewritten** (A-09). A predecessor script gains assertions it lacked (F-4, F-8). If the stronger catalogue diff turns `gate:phase3:s1` or `gate:phase2:release` red on a real difference, that is the point; see §9.1 "Conditional".
- **TL-6 · The deployed rehearsal's suite list** (A-10) is pinned and short on purpose: reconciliation, grants, the definer law, the Android-callable surface and freshness. Widening it to all of `test:integration` would double the gate's longest step for little added deployment signal.
- **TL-7 · SM:47 says one agent.** §8 proposes three on disjoint files, with the coordinator alone running composed gates. If SM:47 is held, the same streams run in the order C → B → A.
- **TL-8 · S8 TL-9 (scheduling the reconciler) is already answered by the product.** The reconciler process ticks every 60 s and runs one daily pass (`s8:apps/api/src/main.ts:47-59`; `s8:apps/api/src/modules/accounting/accounting-reconciliation.worker.ts:12-31`), and the pass includes R-INV-01…05 (`s8:apps/api/src/modules/accounting/accounting-reconciliation.service.ts:79-82`). S9 adds no scheduling. Alerting and deployment of that process belong to the production pass.
- **TL-9 · Browser job (TD-06).** The UX pass stays manual evidence with an out-of-repo harness (§6.3), as in S7 (S7 TL-2). Adding `@playwright/test` is a new dev dependency and a CI browser download. It is recommended for the first UI-heavy later phase, not for a closure slice.
- **TL-10 · Timeout.** The one-job workflow is set to 350 minutes. If the first measured run approaches that, the fallback is two jobs, with the second downloading the archive and refusing it unless its digest equals the first job's sidecar. Because the evidence already cross-checks tree hash and commit (A-13), the split would not take the archive on faith. It departs from R2:430-433 only on measured need.
- **TL-11 · Two routes to the content** (A-13 2). `git archive <sha>` is added beside the `git ls-files` export. It is a check on the export, not a replacement, so the P2 export mechanics stay byte-compatible.
- **TL-12 · `gate:phase2:s8:release` is not run.** It is Level B evidence bound to the P2-S8 commit (`scripts/phase2-s8-release-gate.ts:1-40`) and is not in P:291's predecessor list.

---

## Annex F. Findings from the precedent study

None of these is a product defect. Each is a check that had only ever been asked in the state that made it pass (R2:322-323).

| # | Finding | Evidence | Where S9 answers it |
|---|---|---|---|
| F-1 | The P2 release gate's "runner canary first" step runs no test | `scripts/phase2-release-gate.ts:378`; `scripts/runner-canary.ts:1-45` (exports only) | A-05, T-06 |
| F-2 | P2-S9's archive run reused the repository run's migrated service database | `.github/workflows/phase2-s9-release.yml:100-101, 158-174`; `tests/helpers/embedded-cluster.ts:171-186`; `tests/helpers/test-app.ts:155-157` | §3.2 |
| F-3 | Two S8 suites call `git ls-files` with no archive fallback, the exact cause of P2-S9's third failed run | `s8:tests/security/phase3-s8-gate-tamper.test.ts:172-176`; `s8:tests/integration/phase3-s8-guards.test.ts:416-421`; JOB `s9job3.log:1439-1469` | A-11, T-11 |
| F-4 | Deployment matrix 2.8 records the deployer's memberships and always passes | `scripts/phase2-deployment-authority.ts:446-450` | A-09 1, T-08 |
| F-5 | P2 evidence records `GITHUB_SHA` but never compares the archive's commit with the commit under release | `scripts/phase2-s9-evidence.ts:223-231` | A-13 1, T-07 |
| F-6 | `gate:phase2:release` (and so the Phase 2 prefix invariant) runs in no workflow on the Phase 3 branch | `.github/workflows/ci.yml` (no such step); `.github/workflows/phase2-s9-release.yml:52-53` | A-04, §5, `ci.yml` prefix steps |
| F-7 | Stale labels: `FROZEN_THROUGH` called "the last frozen migration"; "unfrozen candidates" at a tree where every file is frozen | `scripts/phase2-deployment-authority.ts:124-125, 528, 595` | A-09 5 |
| F-8 | The superuser/deployer catalogue diff omits sequences, indexes, column definitions, schema ACL, default ACLs, extensions and function bodies | `scripts/phase2-deployment-authority.ts:750-773` | A-09 2, T-08 |
| F-9 | Unfilled `{{…}}` placeholders in the (uncommitted) S7 acceptance page | S7A:14, 70-73, 114 | A-07, P-3 |
