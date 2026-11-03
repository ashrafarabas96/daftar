# P4-S1 — re-expressing the Phase 3 exact-equality claims (P4-AL-88)

Worktree `/tmp/claude-0/wt/A`, detached at 917bb52. Notes written as the work
proceeds; the report is derived from this file.

## The idiom chosen

The estate already has two *accepted, digest-verified* prefixes and one
predicate per prefix:

- `scripts/phase2-prefix.ts` → `PHASE2_PREFIX` / `PHASE2_PREFIX_END` = `0052`,
  and `isPhase3Relation(t)` = "the accepted Phase 2 prefix did not create `t`".
- `scripts/phase4-prefix.ts` → `PHASE4_INHERITED_PREFIX` (= Phase 2 ∪ Phase 3)
  and `PHASE4_INHERITED_PREFIX_END` = `0073`, and `isPhase4Relation(t)` =
  "the accepted inherited prefix did not create `t`"
  (`scripts/guards/no-authoritative-balance.ts:673-690`).

So the Phase 3 SURFACE is the difference of the two complements:

    phase3 = (head \ 0052)  ∩  (0000–0073)
           = phase3Tables()  \  phase4PlusTables()

`0000–0073` is frozen byte for byte (P4-AL-85) and digest-pinned, so a later
phase CANNOT enter that scope. That is the position predicate the task asks
for. Every re-expression below is
`exact equality over the Phase-3-scoped set` + `the two scopes partition the
old set` (the disjointness half), so "and nothing more" is still said about
Phase 3's own scope.

## Per-site decisions

(filled in as each is verified — see the sections below)

### Sites 1, 2, 3 — `tests/security/phase3-s8-grant-matrix.test.ts` — DONE

New helper exports in `tests/helpers/phase3-surface.ts`:
`phase3PrefixRelations()`, `phase3PrefixColumns()`, `phase3ScopeTables()`,
`beyondPhase3Tables()`, `phase3ScopeColumns()`, `beyondPhase3Columns()`.
Both readers FAIL EMPTY on a bad digest → the scoped equalities go red, never
green. Verified: `phase3PrefixRelations()` is exactly the model's 48 names
(`{}` both ways), and `phase3PrefixColumns()` is exactly the model's four.

- **:178 (was `:179`)** `phase3Tables() toEqual model` → three assertions:
  `phase3ScopeTables() == model` (48); `phase3PrefixRelations() ⊆ live` and
  `== model`; scope ⊎ beyond == surface (disjoint + covering).
- **:190 (was `:191`)** `phase3Columns()` → same three over the column set.
- **`:343` (`cases … toEqual phase3Columns()`)** → `phase3ScopeColumns()`.
- **`deviations()` (`:197`), `forbiddenPrivileges` (`:200`), the by-use DML
  sweep (`:224`) — NOT scoped.** They are laws over whatever exists, and
  Phase 4 wants them applied to its own tables. Justification in the file
  header.
- **OD-03 (`:352`)** → the Phase 3 scope keeps the three pinned by name with
  their types and `purchases_tax_policy_absent_ck`; plus a new law
  `od03Problems(q)` over EVERY tax column in `public`: not pinned ⇒ must be
  `bigint`, `NOT NULL`, and covered by a single-column `CHECK (<col> = 0)`.
  Not an allowlist: nothing is admitted by name, only by structure.

Proof block added in the same file
(`describe('T-04 P4-AL-88 — the re-expressed claims, proved with the Phase 4
relations present')`) over its own scratch DB `daftar_p4s1_t04_reexpr`, using
the new fixture `tests/helpers/phase4-probe-relations.ts`.
`PG_PORT=5432 npx vitest run tests/security/phase3-s8-grant-matrix.test.ts`
→ 27/27 pass.

### Site 4 — `tests/security/phase3-s8-definer-law.test.ts` — NO LAW CHANGE

Both equalities are already forward-safe, and the header now says why:
- `definerLawViolations(…) toEqual SHIPPED` is an equality over the VIOLATOR
  set with an EMPTY right-hand side — a law, not an inventory. It grows to
  cover each new routine automatically.
- the `replaced` equality (`:157`) enumerates pre-`0052` routines whose body a
  later migration changed. A merely NEW Phase 4 routine cannot enter it
  (`replaced` is true only when the routine existed at `0052`), so the list is
  closed by construction. A Phase 4 migration REPLACING a frozen routine would
  enter it — which is the P4-AL-27/29 red the estate wants.

Proof block added (`describe('T-05 P4-AL-88 …')`, scratch `daftar_p4s1_t05_reexpr`):
(a) the four probe routines are in `phase3Routines()` and none is `replaced`;
(b) green with the pinned path + internal owner + no PUBLIC grant;
(c) red, named by clause, on: path reversed (c1), path RESET (c1), owner
    `daftar_migrator` (c2+c7), owner a NOLOGIN role OUTSIDE the law's internal
    set (c2 only), `GRANT EXECUTE … TO PUBLIC` (c3).
`PG_PORT=5432 npx vitest run tests/security/phase3-s8-definer-law.test.ts`
→ 12/12 pass.

**FINDING for the coordinator:** clause 2's trusted-owner set is the literal
four `*_INTERNAL` constants in `tests/helpers/phase3-surface.ts:52-56`. A new
`daftar_sales_internal` owner is RED although it is NOLOGIN — proved above.

### Site 6 — `tests/integration/phase3-s8-guards.test.ts` — NO CHANGE

G-3's partition is satisfied by construction:
`discoverInventoryTables = INVENTORY_TABLE_NAME ∪ (complement \ SUPPLIER_TABLE_NAME)`
and `discoverSupplierTables = SUPPLIER_TABLE_NAME`
(`scripts/guards/no-authoritative-balance.ts:408-409, 555-556`), so a relation
in the Phase-2-prefix complement is in the supplier arm iff its name matches
`SUPPLIER_TABLE_NAME` and in the inventory arm iff it does not — exactly one,
always. The two name vocabularies are disjoint, so nothing lands in both. The
third arm (`discoverSalesTables`, anchored on `0000`–`0073`) is a set beside
the partition. Added a permanent proof over planted Phase 4 relations rather
than changing the site. 34/34 pass.

### Site 5 — `tests/integration/migration-upgrade.test.ts` — DONE

`:2831-2846` (was) — the P3-S8 compatibility matrix. Split at the accepted
Phase 3 head (`PHASE4_INHERITED_PREFIX_END`):

- Step A: `runMigrations(scratch.url(), migrationsUpTo(PHASE4_INHERITED_PREFIX_END))`.
  `expect(applied)` now filters `migrationsAfter(S8M)` to `<= head`. The three
  original assertions (`changedTables`, `rowCounts`, `registries()`) stand
  WORD FOR WORD at that point — identical force, permanently in tense.
- Step B: `scratch.migrateRest()`, `expect(beyond).toEqual(migrationsAfter(head))`,
  then the disjointness half:
  (i) `changedTables(corrected, after)` restricted to inherited-prefix
      relations that are not one of the six registries == `[]`;
  (ii) every registry row standing at the head still stands byte for byte,
      and the rows with a `P3-Sn`/`P3-C` registrant are exactly those that
      were there.
  Guarded by `expect(prefixRelations.size).toBeGreaterThan(0)` and
  `expect(phase3Registrants(...).length).toBeGreaterThan(0)` so neither claim
  can go vacuous.

Proof suite: `tests/integration/phase4-s1-forward-scope.test.ts` (new,
permanent) — scratch `daftar_p4s1_forward_scope` built to `0073`, the probe
fixture applied, GREEN; then RED on (a) a rewritten Phase 3 registry row,
(b) a row written to a non-registry prefix relation (`tenants`), (c) a deleted
Phase 3 registry row. 4/4 pass.

Verification that the modified matrix test actually executes the new code:
planted `toBe(-1)` on the registrant count → `expected 45 to be -1`, then
reverted. `-t "P3-S8"` → 1 passed.

`tests/security/phase4-forward-evolution.test.ts` → 10/10 pass (the detector
accepts every file touched).

## UPDATE — migration 0075 landed in the shared `daftar` (not in worktree A)

The coordinator applied `0075` to the shared database. Its FILE is not in
worktree A (and I may not create a file under `infrastructure/database/migrations/`),
so: the shared `daftar` has the five relations, my scratch databases (built
from this tree's files) do not. Live shape read from the catalogue:

- `customers`, `customer_contacts`, `invoices`, `invoice_items`,
  `invoice_sequences`: owner `postgres`, RLS enabled AND forced, ACL =
  SELECT to `daftar_app` + `daftar_inventory_internal` (+
  `daftar_accounting_internal` on `invoices`), NO DML to anyone, no column ACLs.
- `invoices.tax_minor`, `invoice_items.tax_minor`: `bigint`, NOT NULL,
  `CHECK ((tax_minor = 0))` — which is exactly the shape my re-expressed
  OD-03 law admits, so it is GREEN on the real relations.
- the four read routines: SECURITY **INVOKER**, STABLE, pinned path,
  owned by the applier, EXECUTE to `daftar_app` + `daftar_inventory_internal`,
  none to PUBLIC → T-05 clauses 1/2/7 do not apply to them, clause 3 is green.
- seven non-internal triggers; their functions are SECURITY DEFINER, pinned
  path, owned by `daftar_inventory_internal` (six) and
  `daftar_accounting_internal` (`invoices_walkin_no_ar`), EXECUTE to the
  owner only → clauses 1–4 green.
- `invoices_walkin_no_ar` is DEFERRABLE INITIALLY DEFERRED → it broke a site
  I had flagged but not yet fixed: `tests/security/phase3-s8-set-constraints-sweep.test.ts`.

### What changed as a result

1. Re-ran everything: sites 1, 2a, 3 and 4 were already GREEN against the
   real 0075 — the re-expressions work on the real relations, not just the
   fixture.
2. `deviations()` reported exactly the 19 entries predicted (SELECT on the
   five relations + EXECUTE on the four routines, for `daftar_app`), which is
   the evidence that NOT scoping that law was right.
   → updated `infrastructure/database/phase3-runtime-grant-model.json`.
3. Replaced the fixture-based proof blocks in the grant-matrix and
   definer-law suites with proofs on the REAL 0075 objects, discovered
   (`beyondPhase3Tables()`, `beyondPhase3Routines()`) not named, planted
   inside `BEGIN … ROLLBACK` on a dedicated owner connection.
4. New site found and re-expressed: the set-constraints sweep catalogue.

### New site found — `tests/security/phase3-s8-set-constraints-sweep.test.ts` — DONE

`:248` was `expect([...early, ...complete].sort()).toEqual(live)` where `live`
was EVERY deferrable non-internal constraint trigger in the database minus the
four Phase 1 ones. `0075`'s `invoices_walkin_no_ar` (DEFERRABLE INITIALLY
DEFERRED, on `invoices`) turned it red.

Re-expressed: the catalogue is read once into `deferredGuards(q)` and split by
POSITION — the relation the trigger sits on, against
`phase4InheritedPrefixRelations()`:
- the exact equality now runs over `inScope` (the triggers on the relations
  `0000`–`0073` created): unchanged force, and a later phase that adds a
  deferred guard to a Phase 3 relation is still red until classified;
- the partition is asserted (disjoint, covering, and the prefix reader is
  non-empty);
- and the beyond-scope half is NOT "these exist and that is fine": every one
  must be INITIALLY DEFERRED, `tgenabled = 'O'`, SECURITY DEFINER, owned by a
  NOLOGIN internal principal, with `search_path=pg_catalog, public, pg_temp`.

What is deliberately NOT claimed of a beyond-scope guard is that it refuses
when forced IMMEDIATE — that needs the phase's own command surface. Recorded
in the file header as a HAND-OFF to the Phase 4 slice that adds deferred
guards, not hidden.

Red proofs added in the same file (rolled-back transactions on the real
catalogue): an unclassified deferred guard planted on `purchases` is named by
the scoped equality; and the beyond-scope guard with its path RESET, handed to
`daftar_migrator`, or DISABLEd is named by the structural claim. 22/22 pass.

### Two more sites found — the op-kind registry — DONE (not yet red, but next)

`0074` widened `inventory_operation_kinds.registered_by` so a later phase can
register a kind. Two accepted claims would break on the first such row:

- `tests/security/phase3-s8-signed-authority-matrix.test.ts:196`
  `expect(KINDS).toEqual(await registeredOpKinds())`
- `tests/security/phase3-s8-operation-kinds.test.ts:151`
  `expect(Object.keys(law.consumers)).toHaveLength(26 + P3C…)`

Both re-expressed by PROVENANCE, the registry's own column — new helpers
`phase3RegisteredOpKinds()` (`registered_by ~ '^P3-'`, which covers `P3-Sn`
and `P3-C`) and `opKindRegistrants()` in `tests/helpers/phase3-surface.ts`:
- the builders equal the PHASE-3-registered kinds, both ways, and still count
  `26 + P3C`;
- the two scopes are disjoint and cover the whole registry;
- a kind beyond the scope must record a registrant matching
  `^P[0-9]+-S[0-9]+$` that is not a Phase 3 one — not an allowlist;
- the T-03 LAW (exactly one consuming routine per kind) stays UNSCOPED and its
  surface is asserted to be the whole registry, both ways.

Proofs added (rolled-back transactions, registering a real `P4-S2` kind —
which is only possible because `0074` landed): scoped claims green, the old
unscoped equality demonstrably red, the law reaching the new kind and refusing
it for having no consumer, a `P3-S9`-registered kind with no builder still
named, and a malformed registrant refused by the `0074` CHECK itself. 10/10 pass.

## UPDATE 2 — 0076 landed; the coordinator's authoritative breakage list

Verified on the pristine clusters the coordinator built (`PG_PORT=5433` for
security, `PG_PORT=5434` for integration; both from zero with all 77
migrations).

### The 67-failure clusters were an artifact of MY port-5432 run, not my diff

Proof, two independent kinds:
1. None of `stock-ledger-structure`, `stock-ledger-authority`,
   `inventory-signed-authority`, `p3c-td18-definer-ownership`,
   `p3c-corrective-gate-tamper` imports ANY file in my diff
   (`grep phase3-surface|phase4-probe-relations|phase3-runtime-grant-model`
   over each → no hits). My diff cannot reach them.
2. `PG_PORT=5433 npx vitest run tests/security/stock-ledger-structure.test.ts`
   with my worktree diff → **34 passed, 0 failed.**
Cause: my whole-directory run was against the shared 5432 `daftar` while
another process was using it — direct evidence in the first attempt's output,
`XX000 tuple concurrently updated` inside `applyBootstrap` /
`ensurePostgres()`, which only happens with two concurrent bootstraps. Those
suites `TRUNCATE` and re-seed shared tables in `resetData()`, so a concurrent
process poisons every later file. `vitest.config.ts` sets `maxWorkers: 1`, so
this is cross-PROCESS, not cross-file, and it pre-dates Phase 4.

### journal-privilege-matrix.test.ts:342 — DONE (80/80 on 5433)
### inventory-db-authority.test.ts — DONE (49/49 on 5433)
### phase3-s8-guards.test.ts — DONE (35/35 on 5434)

Diagnosis for the guards one, reproduced locally with a synthetic successor in
the in-memory migration map (nothing written to disk): the complement is 50
where the literal `47 + P3C_RELATIONS.length` says 48.

### NOT diagnosable from worktree A
`tests/integration/migration-upgrade.test.ts` (3 rows) and
`tests/integration/inventory-db-guard.test.ts` (1) both require the `0075`
and `0076` migration FILES, which are not in this worktree and which I am
forbidden to create. Ruled out by direct catalogue reads on 5433 and 5434:
`has_schema_privilege('daftar_*_internal','public','CREATE')` is `false` on
both, so the shared "ownership-transfer authority" assertion (five rows carry
it) is not the cause.
## Round 2 — the four files the coordinator handed back (0075/0076 now on disk)

### `tests/integration/purchase-s5-upgrade.test.ts` and `tests/integration/settlement-s6-upgrade.test.ts`
Same shape, same fix as the P3-S8 row of `migration-upgrade.test.ts`: the upgrade
is run to `PHASE4_INHERITED_PREFIX_END` first, every original assertion stands
there word for word (the inline file list is only MOVED to a module constant
`PHASE3_APPLIED`), then the rest of the tree is applied in a second step which
carries the disjointness half. The rerun no-op is re-expressed as identity with
the state the scoped assertions pinned — stricter about the rerun, because a
rerun that adds ANY row is now red.

New shared helper `tests/helpers/phase3-scope-drift.ts`:
`phase3ScopeViolations(atHead, afterBeyond)` (nothing removed or rewritten; an
added row must be a registry row or an audited `structure.*` record) and
`phase3RegistryViolations` / `phase3Registrants` (`registered_by ~ '^P3-'`).
Proved both directions, permanently and without a database, in
`tests/guards/phase3-scope-drift.test.ts` (11 tests): green on a faithful
successor, red on a deleted Phase 3 row, a rewritten row, a business row written
by a migration, a non-structure audit row, a deleted registry row, a
re-registration under another registrant, and a successor forging `P3-Sn`/`P3-C`.
Each upgrade file also carries a pure proof that its scoped file list is exactly
the Phase 3 files it names, admits no later phase's file, and is red if any one
Phase 3 file goes missing.

### `tests/integration/purchase-s4-upgrade.test.ts`
**As handed back this file does NOT carry the design described above.** The
worker's handback report described the stop-at-head split with
`backfillAuditViolations`; the file it actually left carries the coordinator's
simpler `nonAudit` / `auditIn` partition verbatim, comments included, because a
message telling it to reuse that shape arrived mid-round. The report describes
the design it replaced. **Being restored to the stop-at-head split, so all four
sibling matrices carry one design and not two** — the partition was a stopgap
for a red pushed head, and it is weaker in one respect that matters: it admits
ANY actorless audit row, where the correspondence admits a row only where the
permissions it records were really added.

### `tests/integration/inventory-db-guard.test.ts:78`
`checkInventoryDefinerContract` now also returns `handovers` (routine → the
files that hand it over, in apply order) — additive, no behaviour change. The
test scopes the inventory by the FIRST handover file: `inScope` keeps the 131
names verbatim, the partition is asserted (disjoint AND covering), and the
`beyond` half is judged positively (defined, every definition DEFINER with the
pinned path, none claiming an INVOKER exception). Red-proved with the file's own
`mutate()` idiom: a Phase 3 handover removed, a handover smuggled into a prefix
file, a successor handover removed (Phase 3 half indifferent), partition intact
in all four trees.

### `tests/integration/migration-upgrade.test.ts` P3-S8 row — follow-up
My own disjointness clause (i) went red on `role_permissions` + `audit_events`:
`0076` really does backfill in that scratch. Fixed by the same R-P4-12
correspondence (`backfillAuditViolations`), not by widening: the pair may change
only where the audit record and the permissions that were added correspond.

### STILL RED (new finding, not yet fixed)
`tests/integration/migration-upgrade.test.ts` rows P3-S5 (`:2180`
`expect(await protectedRows()).toEqual(after)`) and P3-S6 — one extra
`audit_events` row, `structure.permission_backfilled` from `0076`. Same cause,
same fix: stop each row's upgrade at `PHASE4_INHERITED_PREFIX_END`, keep the
exact equality there, then apply the rest with `phase3ScopeViolations` /
`backfillAuditViolations`.

### `probeStatementsMissingFrom` — REMOVED
The worker's argument was accepted and the coordinator removed it: the helper,
both call sites, and the import. Its only reason to exist was a split worktree
in which one agent held `0075`, which ended when `0075` entered the tree; what
remained was only its risk, that in a tree whose migrations failed to build a
relation the grant model records it creates the relation and `deviations()`
then reports no MISSING entry — the one failure a two-directional comparison
exists to catch. Both call sites in `tests/security/phase3-s8-grant-matrix.test.ts`
now state the requirement positively and refuse a tree that does not satisfy
it. 28 tests pass with the fixture gone. Recorded as `TL-P4-S1-C20`.

### `backfillAuditViolations` — a size is not a set (coordinator's correction)
The helper's first form took role id → the NUMBER of keys the role holds. A
successor that removes one inherited key and adds another leaves that number
unchanged, so neither `permission-lost` nor `grew` fired, no audit row was
required, and a permission swapped on a Phase 3 role passed with the clause
green. It now takes the KEYS and judges by set difference: any key that
disappears is named and red whatever arrived in its place, and red even when
the swap is audited, because an audited backfill is permission to ADD and never
to take away. The migration-upgrade reader became
`array_agg(permission ORDER BY permission)`. The guard suite's swap case
asserts first that the swap really is size-preserving, so it proves the gap and
not merely the fix. Recorded as `TL-P4-S1-C19`.
