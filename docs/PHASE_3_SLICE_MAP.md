# DAFTAR — Phase 3 Slice Map / خريطة شرائح المرحلة الثالثة

> **What this is.** The coordinator's working map for completing Phase 3 from the sealed P3-S1 checkpoint `61b89d6511ff06164b511e4f0598806306acd5f4`. It is derived from `docs/PHASE_3_EXECUTION_PLAN.md` (slice definitions and "Must prove"), `docs/PHASE_3_ARCHITECTURE_LOCK.md` (the lock, which wins on any difference), `TECHNICAL_DEBT.md` and `docs/DAFTAR_OPEN_DECISIONS.md`. It adds no scope: it orders the slices, names their dependencies and ownership, and records where parallel work is safe. Each slice's acceptance page records its own rulings and evidence.

## 1. Remaining slices

| Slice | Name | Consumes | Creates (plan §) | Gate |
|---|---|---|---|---|
| P3-S2 | Immutable stock ledger | P3-S1 authority model, verifiers, operation registry, unit columns, `@daftar/inventory` skeleton | `stock_movements`, `stock_levels`, `stock_movement_kinds`, `stock_source_types` (empty), `stock_source_bindings`, deficit entities (no producer), `inventory_operation_movement_kinds` (empty), the assertion-verifying movement primitive, rebuild, `products_20_unit_history_lock`, fixed-point arithmetic and shared vectors (§4) | `gate:phase3:s2` |
| P3-S3 | Transfers, adjustments, damage, stocktake, initialization | S2 primitive and registries; S1 seams | first posting commands, `inventory_adjustment` / `inventory_opening` accounting sources, four stock source types with bridges, predecessor-assertion evolution (§5) | `gate:phase3:s3` |
| P3-S4 | Suppliers, purchases, receiving, landed cost | S3's first accounting-seam use and evolved assertions; S2 deficits | suppliers, purchases, receive posting `Dr Inventory / Cr AP`, landed cost, deficit coverage (header/detail), live AP reads (§6) | `gate:phase3:s4` |
| P3-S5 | Supplier returns, PPV, credit notes, purchase reversal | S4 purchases and AP | returns at current average, `6200` PPV, `1150` supplier credit, reversal preconditions (§7) | `gate:phase3:s5` |
| P3-S6 | Payment methods and supplier settlement | S4 AP, S5 supplier credit | `payment_methods`, supplier payments, allocations with realized FX `4900`/`6900`, credit allocations, refunds (§8) | `gate:phase3:s6` |
| P3-S7 | Reads and merchant web UX | S2–S6 truth | live derived reads, the six merchant screens of P3-AL-48 (web only, P3-AL-47) (§9) | `gate:phase3:s7` |
| P3-S8 | Security, failure injection, reconciliation, concurrency, performance | everything above | premortem scenarios as tests, inventory↔GL reconciliation, rebuild rehearsal, runtime grant matrix, guard extensions (§10) | `gate:phase3:s8` |
| P3-S9 | Release closure | everything above | zero migrations; release evidence, archive, deployment rehearsal (§11) | `gate:phase3:release` |

## 2. Dependency DAG

```
P3-S1 (closed)
   └─► P3-S2 ─► P3-S3 ─► P3-S4 ─► P3-S5 ─► P3-S6 ─► P3-S7 ─► P3-S8 ─► P3-S9
```

The chain is linear by construction, not by choice:

- S3 cannot start before S2: every S3 command writes through the S2 primitive and binds through S2's source registry.
- S4 needs S3: S3 owns the first real use of `withBusinessInventoryAccountingTransaction` and the evolution of the two predecessor assertions that pin `accounting_source_types` (lock F-4); S4 then registers `purchase` against the evolved assertions.
- S5 needs S4's received purchases and their AP; S6 needs S4's AP and S5's supplier credit notes (credit allocation and refund, P3-AL-31).
- S7 reads the truth S2–S6 write; S8 attacks all of it; S9 releases it.

Parallelism therefore lives **inside** a slice, never across slices.

## 3. Safe concurrency per slice

`MAX_ACTIVE_AGENTS = 6` including the coordinator. Exactly one agent writes schema, migrations, RLS, grants, database functions or triggers at any moment. Only one agent at a time runs the embedded-PostgreSQL suites on a given `PG_DIR`/`PG_PORT`; the machine has four CPUs, so timing-sensitive suites (Tier 1 budgets) run with no parallel load.

| Slice | Independent work streams after the contract is fixed | SAFE_CONCURRENCY (agents incl. coordinator) |
|---|---|---|
| P3-S2 | migration writer · package arithmetic + vectors · tests (after migration) · guards and gate | 4 |
| P3-S3 | migration writer · domain/application commands · API routes · tests | 5 |
| P3-S4 | migration writer · domain/application · API · tests | 5 |
| P3-S5 | migration writer · domain/application + API · tests | 4 |
| P3-S6 | migration writer · domain/application + API · tests | 4 |
| P3-S7 | read API · web screens · tests | 4 |
| P3-S8 | security adversary · reconciliation/rebuild · performance · guards | 5 |
| P3-S9 | coordinator only (release evidence) | 1 |

An independent security reviewer is added at the end of each slice that changes an authority boundary; it reads the diff, contracts, policies and tests itself rather than a summary.

## 4. Ownership pattern (every slice)

| Area | Owner |
|---|---|
| `infrastructure/database/migrations/<new>.sql` | the single migration writer |
| `infrastructure/database/MIGRATION_MANIFEST.json`, `bootstrap.sql`, predecessor-gate and predecessor-test evolution, `PROJECT_STATUS.md`, slice acceptance page, freeze commits | coordinator |
| `packages/inventory/src/**`, `packages/inventory/vectors/**` (new modules only) | package agent |
| `apps/api/src/domains/inventory/**`, `apps/api/src/domains/purchasing/**` (per slice) | domain/application agent |
| controllers, DTOs, `packages/shared-contracts/**` additions | API agent |
| `apps/web/**` screens (P3-S7) | web agent |
| `tests/security/inventory-*`, `tests/integration/inventory-*` (new files) | test agent |
| `scripts/guards/**`, `scripts/static-guards.ts`, `scripts/phase3-s<n>-gate.ts`, `package.json` script line | guards/gate agent |

A file owned by another stream is changed only through the coordinator. Work lands in merge order: contracts, schema, domain, application, infrastructure, API, UI, adversarial tests, docs.

## 5. Open decisions and debt, by slice

| Item | State | Slice that owns it | Effect |
|---|---|---|---|
| OD-03 — purchase tax | open, **bounded** by P3-AL-23 | P3-S4 | A non-zero purchase tax is refused with `purchase.tax_policy_absent`. No rate, inclusive/exclusive rule or tax posting is implemented. Phase 3 is not blocked: the lock scopes Phase 3 purchases to zero tax. |
| TD-13 — plain `DELETE` prune in the frozen accounting and provisioning consumers | open | **P3-S3**, the first Phase 3 consumer of accounting assertions at volume | replaced by the advisory-lock prune already proven in `0054`, in a new migration, with the same non-blocking test |
| TD-12 — key separation by bytes, not effective HMAC key, for the accounting/provisioning pair | open | **P3-S8** (hardening) | `hmacKeysEquivalent` applied to every key pair, with the P2-S3 gate's shape check evolved in the same commit |
| TD-14 — platform credential may install a key; `kid`-conflict oracle | open (decision) | outside Phase 3 unless P3-S8 absorbs it without changing the accepted key-install model | recorded; not a Phase 3 closure requirement |
| TD-08 — `main` unprotected | external | none | `MAIN_PROTECTION_EXTERNAL_BLOCKER`; does not block Phase 3 |
| TD-10 — symmetric assertion signing | open, bounded to `merchant-api` | none in Phase 3 | unchanged |

## 6. Gates kept at every slice

`gate:phase1`, `gate:phase2:s1` … `s8`, `gate:phase3:s1` and every accepted Phase 3 slice gate stay green after each slice. `gate:phase2:release` runs at integration checkpoints and at the Phase 3 release; it protects the Phase 2 prefix `0000`–`0052` and permits later migrations (`docs/PHASE_2_S9_RELEASE.md` §5.3). Each new slice gate composes its predecessor. Budget A stays at 15 ms.

## ملخص

بقي من المرحلة الثالثة ثماني شرائح بترتيب خطّي لا يمكن تجاوزه: دفتر المخزون (S2)، ثم التحويلات والتسويات والجرد والرصيد الافتتاحي (S3)، ثم الموردون والمشتريات والاستلام (S4)، ثم المرتجعات وفروق السعر (S5)، ثم طرق الدفع وتسوية الموردين (S6)، ثم القراءات وواجهات التاجر (S7)، ثم الأمن والمطابقة والأداء (S8)، ثم إغلاق الإصدار (S9). العمل المتوازي داخل الشريحة فقط، بوكيل واحد يكتب الهجرات في أي وقت. القرار OD-03 لا يمنع المرحلة لأن ضريبة الشراء غير الصفرية تُرفض صراحةً.
