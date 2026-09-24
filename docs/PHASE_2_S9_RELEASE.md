# PHASE 2 — P2-S9 RELEASE CLOSURE

**Status: RELEASE CANDIDATE — READY FOR TECH LEAD REVIEW**
**Scope: release closure only. Zero migrations.**

This page states the contracts P2-S9 establishes and the mechanism that proves
them. It deliberately carries no workflow run id, no timing, no artefact digest
and no archive digest: those come into existence only when a run happens, and a
document that has to be edited to carry them creates a loop in which the
document changes the head, the new head invalidates the run the document names,
and a new run has to be recorded in the document. Everything a run produces
lives in `release/phase2-s9-release-evidence.json`, assembled by
`scripts/phase2-s9-evidence.ts` from artefacts rather than typed by hand.

---

## 1. What P2-S9 is, and what it is not

P2-S9 is the closure of Phase 2. It **changes no schema**: there is no `0053`,
and `npm run gate:phase2:release` fails if one appears. It adds no accounting
feature, no financial source, no report, no API capability and no UI. Phase 3
does not start here.

What it does:

| | |
|---|---|
| **Freezes** | `0051` and `0052` at the digests the Tech Lead accepted; `frozenThrough` = `0052_accounting_journal_lines_rls_performance.sql`, 53 frozen migrations |
| **Closes RB-P2-01** | the deployment principal can now apply the accepted migration history end to end, with no superuser anywhere in the path |
| **Closes RB-P2-02** | no authoritative document still describes the accepted slice as an open, blocked or unfrozen candidate, and the release gate refuses a tree in which one does |
| **Adds** | one composed release gate, a deployment-authority matrix, a Phase 2 release-candidate archive, and one machine-readable evidence file |

---

## 2. The accepted boundary

| | |
|---|---|
| P2-S8 accepted at | `d4ec6c4f5be838e3c47d40719e44d3213727e566` |
| with | `DAFTAR CI` **35966829333** (five jobs SUCCESS) and `DAFTAR P2-S8 acceptance evidence` **35966820087** (11 pass / 0 fail / 0 skipped, release gate PASS) on that exact SHA |
| `0051_accounting_reconciler_read.sql` | `2086c87564f5f66243ab64753e7c4f5338f896a1e29984ddf8977be8ba7587cc` |
| `0052_accounting_journal_lines_rls_performance.sql` | `0acf165003c678f8d3017797e77033fadf2e9e791be54f98048031108c72ad84` |
| `frozenThrough` | `0052_accounting_journal_lines_rls_performance.sql` (53 frozen migrations) |

Both digests are carried in **two independent places**: the manifest, and
`scripts/phase2-s8-gate.ts` itself. The gate requires each file to hash to its
accepted digest on disk **and** in the manifest, so one commit cannot move a
migration and its recorded hash together and call the result frozen.

`npm run gate:phase2:s8` is a **permanent historical gate** from this point.
The candidate-era rules went with the candidacy: `frozenThrough` changed from
an equality at `0050` to a floor at `0052`, and the "no `0053` may exist"
clause was removed, because an accepted historical gate that forbids its
successor is a gate that stops the project. That prohibition now lives in
P2-S9's own release gate, where it belongs while P2-S9 is the current slice.
`tests/security/phase2-s8-gate-tamper.test.ts` proves the transition in both
directions: the gate refuses an unfrozen `0051`/`0052`, refuses either one
re-frozen at a digest nobody accepted, refuses a boundary that moved back
below `0052` — and **accepts** a tree carrying a later migration.

---

## 3. RB-P2-01 — the deployment principal could not deploy

### 3.1 The defect

Every test in this repository applies the migration history as a PostgreSQL
superuser, because that is what a `postgres:16` service container hands you. A
superuser skips both of the checks that decide whether a real deployment works:
it is never asked whether it may `SET ROLE` to the role a file hands an object
to, and it is never asked whether that role may own something in the schema.

So the suite was green while a deployment as the documented migration
principal, `daftar_migrator`, died at `0032_provisioner_narrow_functions.sql`.
The rollback rehearsal did not see it either, because it restores a Phase 1
backup whose `0032` had already been applied — by a superuser.

Three independent causes, each of which hid the next:

| | error | cause |
|---|---|---|
| 1 | `must be able to SET ROLE "daftar_platform"` | the accepted history hands ownership to **two** roles and bootstrap carried a membership for only one |
| 2 | `permission denied for schema public` | `public` belonged to `pg_database_owner`, so the migrator held CREATE **without grant option** and could not lend it to the role it was about to make owner — which every accounting migration from `0040` does inside its own transaction |
| 3 | `must be owner of function provision_replay_operation` | `0038` issues `CREATE OR REPLACE FUNCTION` on eight functions `0032` already made `daftar_platform`'s, and replacing a function is an **ownership** check, which reads the INHERIT bit and ignores SET |

### 3.2 The corrections

**No frozen migration was touched. No runtime principal was widened.** The
corrections live exactly where §11 says they may: in bootstrap, in the
deployment role setup, and in the migration runner.

`infrastructure/database/bootstrap.sql`:

- `ALTER SCHEMA public OWNER TO daftar_migrator` — the deployment principal
  owns the schema it migrates. It already held CREATE there, so it could
  already create an object; ownership adds the ability to grant that same
  privilege onward, which is precisely what the frozen history requires of its
  deployer and nothing more. `tests/integration/migration-portability.test.ts`
  has always modelled the managed-PostgreSQL shape this way, so this makes the
  deployment contract say what the portability matrix already proves.
- `GRANT daftar_platform TO daftar_migrator WITH INHERIT TRUE, SET TRUE`.

`apps/api/src/infra/migrate.ts` — for each migration, the roles that file hands
ownership to are read from the file itself, granted `CREATE ON SCHEMA public`
**inside that migration's own transaction**, and revoked before it commits.
This is the same shape `0040` onward already use internally, applied from
outside for the three frozen Phase 1 files that do not. The privilege therefore
never exists in any committed state, and a failed migration rolls it back with
everything else. The targets are read rather than named, so a later authorized
migration that hands ownership to a role this code has never heard of deploys
correctly — and `npm run check:deployment-authority` re-derives the whole set
from the frozen history and fails if bootstrap carries no membership for one,
which makes a missing membership a red gate instead of a production deployment
that dies halfway.

### 3.3 Why the two memberships are not the same shape

`INHERIT FALSE` is the preferred form and the **accounting** membership keeps
it: the financial authority must be assumed deliberately, never held passively,
and `SET TRUE` is enough for `0040`'s handover.

The **platform** membership cannot be that shape, and the reason is a property
of PostgreSQL rather than a preference — cause 3 above. There is no narrower
privilege to grant instead: PostgreSQL has no "may replace this function"
permission, and `0038` mixes those statements with `CREATE TABLE`, so the file
cannot be run under `SET ROLE daftar_platform` either.

What inheriting `daftar_platform` actually adds is the ability to EXECUTE the
eight provisioning functions without assuming the role first. It adds no reach
over data: the deployer owns every table in the schema already. The
alternatives are worse in both directions — a superuser deployment is strictly
more authority, and a second deployment credential holding the same two
memberships removes nothing while adding one more secret to protect.

The direction that WOULD be a widening stays closed, and the matrix asserts it:
no runtime role is a member of anything, `daftar_accounting_internal`'s only
member is still `daftar_migrator`, nothing at all is a member of the deployer,
no membership carries ADMIN OPTION, and the deployment credential appears in no
runtime connection URL.

### 3.4 What is proved, and where

`npm run check:deployment-authority` →
`release/phase2-s9-deployment-authority.json`.

Every migration command below authenticates as `daftar_migrator` and as nothing
else. The only superuser act anywhere is the deployment administrator's own
`bootstrap.sql` step, which is a real and separate trust boundary.

| case | what it proves |
|---|---|
| **A** | an empty database, bootstrap, then all 53 migrations |
| **B** | a database at the Phase 1 boundary (`0039`), upgraded to `0052` |
| **C** | a database at `0050`, upgraded across the P2-S8 freeze — exactly `0051` and `0052` are added |
| **D** | a database already at the latest migration — a re-run is a no-op |
| **E** | an applied migration whose bytes changed afterwards — HARD FAIL on checksum, history untouched |
| **F** | a migration that fails half way — the file rolls back completely, no false history row, the migrations before it stay committed, the retry completes |

Then the question the six cases cannot answer on their own: **is it the same
database a superuser produces?** Section 10 of the script compares both
catalogues — every table's owner, RLS flags and ACL, every function's owner,
SECURITY DEFINER flag, ACL and configuration, every policy's expression and
roles, and every constraint definition — with the applying principal's own name
normalised, because who owns what it created is the one difference a deployment
is allowed to have. Every other owner, including the two delegated ones, is
compared literally, so a handover that silently did not happen shows up here.

Checksum validation is not optional and the runner has no switch that turns it
off; the gate asserts that too.

---

## 4. RB-P2-02 — the documents agree with reality

`npm run gate:phase2:release` reads the authoritative pages and fails on any
line that still presents the pre-acceptance state as the current one: the
slice reported as blocked, the manifest boundary left one migration short of
where it now stands, the two accepted migrations described as absent or
unfrozen, or the reporting budget reported as unmet. The check is deliberately
narrow: it looks for those specific claims, not for any sentence containing the
word "candidate", and a line that says of itself that it is superseded,
withdrawn, historical or refuted is not a finding.

**This page is inside the check, not outside it.** A release document that
exempts itself from the consistency rule it describes is the first page to go
stale, so `docs/PHASE_2_S9_RELEASE.md` is in the same list as the five pages
it is about.
Historical narrative is the point of these pages; a stale claim presented as
current is the defect.

`docs/PHASE_2_ARCHITECTURE_LOCK.md` AL-18 is the example. Its original
decision — P2-S8 is verification only, zero migrations — is left standing
exactly as written, and the evolution is recorded beneath it: why the slice
ended with two migrations, what each was authorized to answer, and that P2-S9
remains zero.

---

## 5. The release gate

`npm run gate:phase2:release` **composes**; it restates nothing.

1. the runner failure canary, outside Vitest, before any test result is
   believed — DAFTAR has shipped a runner that exited 0 over four failing
   tests, and every green number is worth exactly what that proof is worth;
2. what the gated tree IS: no git working tree or credential in an extracted
   archive, the archive matches the inventory it carries, frozen history
   `0000`–`0052` byte-for-byte, P2-S9 creates no migration, no authoritative
   document contradicts the accepted state;
3. `gate:phase1:release` — the whole Phase 1 release command matrix: toolchain,
   manifest, db-from-zero, static guards, localization, format, lint,
   typecheck, unit, integration + security + database contract + upgrade
   matrix, golden accounting regression, API/web/admin builds, Android
   lint + unit + assemble, dependency audit, artefact scan, secret scan, docs;
4. `gate:phase2:s8` — which composes P2-S7 … P2-S1 and the Phase 1 machine gate
   in turn, and adds the Tier 1 budgets, the failure-injection matrix, the
   reconciliation authority and the RLS answer-equivalence contract;
5. `check:deployment-authority` — section 3.4 above;
6. `check:supply-chain`.

**Mandatory checks cannot be skipped.** Any `RELEASE_GATE_SKIP_*` in the
environment fails the gate before it runs anything, and the evidence records
`mandatorySkipped`. A release verdict with a skip in it is not a release
verdict.

**The gate must run from an extracted archive.** Nothing in it shells out to
`git`, reads `.git`, or consults an untracked file. The tree's identity comes
from `DELIVERY_MANIFEST.json` when one is present — which is how an extracted
release candidate says what it is — and from nothing at all when one is not.

### 5.1 Where each closure claim is proved

P2-S9 adds no assertion that already exists somewhere. This table says where
each closure claim is actually checked, so a reviewer can read the check
rather than take this page's word for it.

| claim | proved by |
|---|---|
| no mutable or materialized authoritative balance | guard **G-3** (`scripts/guards/no-authoritative-balance.ts`), which also fails if the source-of-truth table it watches does not exist |
| no float anywhere in the accounting authority | guard **G-2** (`scripts/guards/no-float-rate.ts`) |
| no direct runtime journal DML, no generic public ledger writer | guard **G-1** (`scripts/guards/journal-privilege-model.ts`) and the live role matrix in `check:deployment-authority` §11.3 |
| the writer may not exist without its protections | guard **G-4**, which discovers journal writers from the schema instead of naming one |
| no SECURITY DEFINER routine with a reachable `search_path` | guard **G-5** (`scripts/guards/definer-search-path.ts`) plus `tests/security/search-path-shadowing.test.ts` and `tests/security/policy-helper-inlining.test.ts`, which pin the one exempt shape (SECURITY INVOKER **and** a SQL-standard body) by name |
| the financial read surface is read-only | guard **G-6** (`scripts/guards/read-surface.ts`) |
| no caller-trusted actor identity or posting fingerprint | `tests/security/accounting-posting-authority.test.ts` and the AL-03 spoofing suite |
| no unauthorized accounting HTTP mutation surface | `scripts/guards/posting-surface.ts` and the HTTP contract matrices |
| no unfrozen migration inside the accepted range | this gate's own frozen-history check, and `check:migrations` |
| the runner can report failure | `scripts/runner-canary.ts`, run outside Vitest before anything else |

All of them run inside `gate:phase1:release` and `gate:phase2:s8`, which this
gate composes. Nothing in the list is restated here.

### 5.2 What running the release gate on a clean runner found

The first run of `.github/workflows/phase2-s9-release.yml` failed, and what it
failed on is worth recording, because it is the same shape as RB-P2-01: a
check that passed everywhere it had ever been run, and failed the first time
it was run somewhere that had nothing lying around.

`gate:phase1:release` deletes every build output first, so that it builds from
source the way a fresh checkout does — and then it rebuilt three packages by
name. `@daftar/accounting` arrived in Phase 2, long after that list was
written, and was in neither the list of outputs to delete nor the list of
packages to rebuild. On any machine that had built the tree before, its `dist`
survived the delete and every type resolved. On a runner that had just cloned
the repository there was nothing to resolve, and typed linting reported **695
`type that cannot be resolved` errors** — none of them a defect in the code
they were reported against.

Neither list is written by hand any more. The set of library packages is
**derived** from the workspaces under `packages/` that have a `build` script,
and the order is a topological sort of their `@daftar/*` dependencies, so the
next package added is deleted and rebuilt in the right place without anybody
remembering to add it. The failure was reproduced locally first — the same 695
errors, from the same clean state — and the same command was then shown green
with the correction in place.

A release gate that only passes in a working directory that had already built
the tree is not a release gate, and nothing but running it somewhere clean
would have said so.

The second run got past that and failed on the step after it, for a reason
that only exists because this gate **composes**. `gate:phase1:release` ends by
building the API, which leaves `apps/api/dist` in the tree; the Phase 1
machine gate — which `gate:phase2:s8` reaches through every predecessor —
refuses by name a source tree that carries a build output. Both rules are
right. What was wrong was asking the second question without restoring the
state the first one was asked in. CI never saw it because it runs the two in
separate jobs on separate checkouts; composing them in one tree is what made
it visible. The composer now puts the tree back between the two, as its own
named step, and the failure was reproduced and the correction confirmed the
same way: `gate:phase1` passes on a clean tree, fails the moment the API is
built, and passes again once the build output is removed.

Both findings are the same shape, and it is the shape RB-P2-01 has: a check
that had only ever been asked in the state that made it pass.

---

## 6. The release candidate archive

`npm run export:release:phase2` → `release/DAFTAR_PHASE_2_RC.zip` and a
**sibling** `.sha256` (never inside the zip — no circular hash).

The inventory is every tracked file, and the export refuses to run on a dirty
working tree, so the archive describes exactly one commit. It carries no `.git`,
no `node_modules`, no build output, no `.env`, no key material, no dump and no
nested archive; the export refuses any of them, and the evidence script asks
the same question again of the delivered ZIP's own entry list.

**The content-tree digest is independent of the ZIP.** `treeHash` is
SHA-256 over `<relative path>:<sha256 of file bytes>` lines, sorted by path,
joined with `\n`, hashed once. Two archives built from the same tree on
different machines, at different times, with different compression or
timestamps carry the **same tree hash** and **different zip hashes** — so a
reader who wants to know whether the content is the same asks `treeHash`, and a
reader who wants to know whether the file is the same asks the sibling
`.sha256`. The algorithm is recorded in the manifest beside the value.

---

## 7. The two gate runs

A release candidate that passes only on the developer's working directory has
proved that the developer's working directory works.

| | |
|---|---|
| **repository run** | `gate:phase2:release` on the checkout → `release/phase2-s9-release-gate.json` |
| **extracted-archive run** | the RC unzipped into a clean directory **outside** the checkout, with no `.git` and none reachable above it, `npm ci`, then the same gate → `release/phase2-s9-release-gate-archive.json` |

Both must report `PASS`, `fail = 0`, `mandatorySkipped = 0`. The evidence
script additionally requires that the archive run reports tree kind
`extracted-archive`, that the repository run reports `source-checkout`, and
that the commit and tree hash the archive gate ran against are the archive's
own — if those disagree, one of the two runs was made against a different tree
and neither number means anything.

`.github/workflows/phase2-s9-release.yml` performs the whole chain in **one
job**, on one commit, in one working directory. Splitting it would mean
shipping the archive between runners and taking on faith that the thing
extracted is the thing built.

---

## 8. Debt that remains open, with its boundary stated

| | why it is open, and what it does NOT permit | target |
|---|---|---|
| **TD-09** | The refusal of a future-dated entry lives in the three posting commands, not in a schema `CHECK`. The only principal that could insert such a row is the schema owner — the DEPLOYMENT credential, which no service loads and which appears in no runtime connection URL, and whose holder can already alter the schema at will. There is **no runtime path** to it, so leaving it open permits no corruption a deployment credential could not cause anyway | the first authorized schema slice of Phase 3 |
| **TD-10** | Assertion signing is a symmetric HMAC whose secret is held by the merchant API process. An attacker must already be executing inside that process, where they can read the key from the environment — and a process that can read the key can already call the posting command with the API's own credential, so this is not a runtime authority escalation. It permits no corruption of what is already written: the journal is append-only and every entry carries its own fingerprint. Rotating the `kid` retires every assertion minted with a stolen key | a Tech Lead decision before the phase that exposes assertion signing to a second process |

**The deployment-authority issue is CLOSED by P2-S9.** It is not carried
forward as debt and there is no third state.

---

## 9. `main` branch protection

`main` is **not** protected. This is not a code defect and not a Phase 2
regression: the sandbox refuses every repository-settings write, and the read
of `GET /repos/.../branches` at the release head reports `"protected": false`.

**`MAIN_PROTECTION_EXTERNAL_BLOCKER`**

The repository owner configures it once in GitHub: Settings → Branches → add a
rule for `main` → require a pull request, require the five checks
(`workspaces`, `backend`, `web-admin`, `android`, `hygiene`), block force
pushes and deletions, and leave admin bypass enabled for emergency recovery.

---

## 10. ملخّص بالعربية

**ما الذي أُنجِز في P2-S9؟** إغلاق الإصدار، وبدون أي هجرة جديدة. تم تجميد
`0051` و`0052` ببصمتيهما المقبولتين، فصار السجل المجمّد 53 هجرة حتى
`0052`، وتحوّلت بوابة P2-S8 إلى بوابة تاريخية دائمة تحمل البصمتين مصدرًا
ثانيًا مستقلًا عن السجل، دون إضعاف أي فحص فيها.

**العائق الحقيقي الذي كُشف وأُغلق (RB-P2-01).** كل اختباراتنا تطبّق الهجرات
بصلاحية المستخدم الخارق، والمستخدم الخارق لا يُسأل أصلًا عن الصلاحيات التي
يسألها PostgreSQL لأي ناشر حقيقي. لذلك كانت الاختبارات خضراء بينما النشر
الحقيقي بحساب `daftar_migrator` يتوقف عند الهجرة `0032`. الأسباب ثلاثة:
عضوية ناقصة في `daftar_platform`، وملكية مخطّط `public` التي كانت تمنع الناشر
من إعارة صلاحية `CREATE` للدور الذي يسلّمه الملكية، و`INHERIT FALSE` التي
تمنع استبدال دالة يملكها دور آخر. أُصلحت الثلاثة في `bootstrap.sql` وفي أداة
الهجرة فقط — **لم تُمسّ أي هجرة مجمّدة، ولم تُوسَّع صلاحية أي دور تشغيلي** —
وصار النشر يطبّق الهجرات الـ53 كاملة بصلاحية النشر وحدها، وأثبتنا بالمقارنة
أن قاعدة البيانات الناتجة مطابقة تمامًا لتلك التي ينتجها المستخدم الخارق.

**ما الذي يحتاج منك يا أشرف؟** حماية الفرع `main` لا يمكن ضبطها من هنا
(`MAIN_PROTECTION_EXTERNAL_BLOCKER`) — تُضبط مرة واحدة من إعدادات GitHub كما
في القسم 9. وطلب المراجعة والقبول للمرحلة P2-S9 قرارك أنت؛ لن يُدمج طلب السحب
رقم 2 ولن تبدأ المرحلة 3 قبل توجيه صريح منك.
