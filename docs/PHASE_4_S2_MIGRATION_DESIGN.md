# P4-S2 — Migration design (Agent E, the single migration owner)

> **Status: DESIGN ONLY. No migration file exists and none may be created yet.**
> Tech Lead ruling `TL-P4-S1-R2` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:1930-1936`) makes the general
> Phase 4 RLS `ENABLE`/`FORCE` discovery guard P4-S2's **first** mandatory protection and states that
> **`0077` may not be created until that guard is integrated and red-proven**. Agent A owns it. Two
> further items are open: Agent B's evidence on `stock_source_bridge_sale`'s tenant carriage (§3), and
> the Tech Lead review points listed in §11.
>
> Every claim below was verified against the code or against a from-zero database built through `0076`
> on an isolated cluster (`PG_PORT=5445`). Where a document and the code disagree, the code is recorded
> and the conflict is reported in §10.

---

## 1. What P4-S2's schema must carry, and where the requirement comes from

| obligation | source |
|---|---|
| `sales`, `sale_items` with `UNIQUE (business_id, sale_id, id)` | plan `docs/PHASE_4_EXECUTION_PLAN.md:299`; lock `P4-AL-08`, `P4-AL-29b` |
| the `sale.*` operation kinds on the existing `invctl/1` assertion | `P4-AL-27`, `P4-AL-28` |
| the `invoice` accounting source type, its operation kinds, both bindings, its deferred completeness validator | `TL-P4-S1-R1` (lock `:1928`) — moved out of P4-S1 |
| the `sale` accounting source type, both bindings, its validator | `P4-AL-20`, `P4-AL-12` |
| the `stock_source_types` row and the whole `stock_source_bridge_sale` apparatus | `P4-AL-29b` (lock `:656-679`) |
| the sale commit routine | `P4-AL-16`, `P4-AL-32` |
| `sales_walkin_no_ar` | `P4-AL-11` (lock `:330-344`) |
| `invoices.sale_id`'s composite FK (seam `S-P4-01`) | `scripts/phase4-s1-gate.ts:1117-1128` |
| the generic reversal guard's list widened in the same migration that registers each type (seam `S-P4-02`) | `P4-AL-47` (lock `:956-974`); `scripts/phase4-s1-gate.ts:1130-1142` |

---

## 2. How many migrations, and why

**Two.** `0077` carries every relation, every guard, both registrations and the end state; `0078` carries
the commands.

The precedent is unambiguous and it is three-fold: `0063`/`0064`, `0065`/`0066` and `0067`/`0068` each
split a Phase 3 slice into one DDL-and-registration file and one command file. `0063` is the exact
analogue of `0077`: in one file it creates the documents and both bridges
(`infrastructure/database/migrations/0063_purchases_suppliers_sources.sql:397-431`), enables and forces
row security with the policy sets (`:443-575`), **replaces** `inventory_stock_source_guard_gaps()`
(`:1247`), registers the stock source types (`:1507-1508`), creates the accounting completeness
validators (`:1557`, `:1608`), replaces the generic reversal guard (`:1522-1550`), registers the
accounting source types and operation kinds (`:1723-1729`) and ends with its own end-state block
(`:1737`). `0064` then carries `purchase_receive` and the bridge writer.

A third file is **not** needed and would be a boundary this slice does not own: nothing in `0078` is
asserted about the catalogue that `0077` has not already asserted, and splitting the registrations from
the relations they oblige would create exactly the dead-registry state `TL-P4-S1-R1` refused.

**Why the accounting side is not its own file.** `P4-AL-29b`'s stock apparatus and `P4-AL-20`'s accounting
apparatus both end in the same place — `0077`'s end-state block asserting that
`inventory_stock_source_guard_gaps()` returns no row and that every registered Phase 4 accounting source
type appears in the reversal guard's `prosrc`. Two files would mean two partial end states, and the first
would commit a registered source type whose reversal guard had not yet been replaced: the `S-P4-02` hole,
opened deliberately for one migration's width.

### `0077` — relations, guards, registries, end state
### `0078` — `sale_commit`, `sale_bridge_commit`, their grants

---

## 3. The one conflict the lock leaves to this slice: `stock_source_bridge_sale`'s tenant carriage

The lock states the conflict at `docs/PHASE_4_ARCHITECTURE_LOCK.md:1961-1969`: `P4-AL-08` requires every
Phase 4 relation to carry `tenant_id` and `business_id` as real columns; the accepted precedent
`stock_source_bridge_purchase` (`0063:397-412`) carries **no** `tenant_id`, which is why its tenant policy
uses the correlated `businesses` subselect (`0063:555-557`); and
`inventory_stock_source_guard_gaps()` pins the bridge primary key "exactly".

**Finding: the two instructions are not in conflict, and the resolution needs no ruling.** The guard pins
the **primary key's column list** and nothing else about the relation's shape. The live body is `0067`'s
(the fifth version — `0059:390`, `0061:308`, `0063:1247`, `0065:1396`, `0067:1438`; the first four are
superseded, and reading `0061`'s is reading a body the database does not hold). Its `bridge_pk` arm is
`infrastructure/database/migrations/0067_payment_methods_supplier_settlement_sources.sql:1523-1529`:

```
IF (SELECT array_agg(a.attname::text ORDER BY k.ord) … WHERE c.conrelid = v_bridge AND c.contype = 'p')
   IS DISTINCT FROM ARRAY['business_id', 'source_id', 'source_line_id', 'movement_kind'] THEN
  source_type := v_type; missing := 'bridge_pk'; RETURN NEXT;
```

A column outside the primary key is invisible to it. **Proved by performing it**, against a from-zero
database through `0076`, in a rolled-back transaction: a `stock_source_bridge_sale` carrying
`tenant_id UUID NOT NULL` and `FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`,
with the primary key still exactly the pinned four, registered as a `stock_source_types` row —
`inventory_stock_source_guard_gaps()` returned **0 rows**. The negative control, the same table with
`tenant_id` moved **into** the primary key, returned exactly `sale | bridge_pk`. So the pin is on the key,
the key is unchanged, and the column is admitted.

Three further pieces of evidence, all from the live catalogue, say the column is the better reading:

1. **`stock_source_bindings` — the relation the bridge's own five-column FK points at, at the same grain —
   carries `tenant_id` with `stock_source_bindings_tenant_fk FOREIGN KEY (tenant_id, business_id)
   REFERENCES businesses(tenant_id, id)`.** Tenant carriage at this grain is the Phase 3 norm; the purchase
   bridge is the exception, not the rule it looks like.
2. **It is what lets the tenant policy take `P4-AL-38`'s direct form.** `0063:555-557` uses the correlated
   subselect only because the column is absent; `0052:305-330` adopted the direct
   `tenant_id = nullif(app_tenant(), '')::uuid` form after measurement, and `0075` carries it on all five
   P4-S1 relations (`0075:401-403` and the `0075-E` assertion at `0075:919-926`). Without `tenant_id` the
   sale bridge would be the one Phase 4 relation that could not.
3. **The writer can supply it.** `purchase_bridge_receipt` already inserts the bridge row by selecting from
   `stock_source_bindings` (`0064:318-321`); `b.tenant_id` is in that row.

**This section is a judgement, not a decision.** Agent B is resolving it with evidence and the bridge is
not written until B's answer is relayed. The evidence above is offered so that answer can be judged.

---

## 4. `0077` — the planned DDL as a specification

Vocabulary is fixed in advance by `P4-AL-15b` as corrected by `TL-P4-S1-C5`: quantities are
`quantity NUMERIC(18,4)`, money is `BIGINT` minor units, there is no floating-point column, and nothing is
named `reserved` or `available`. Every column below was checked against the live
`scripts/guards/no-authoritative-balance.ts` vocabulary: `AP_BALANCE_COLUMN` (`:314`),
`DERIVED_COST_COLUMN` (`:317`), `DERIVED_DEBT_COLUMN` (`:335`), `FORBIDDEN_COLUMN_PATTERNS` (`:205`) and
`NEVER_STORED` (`:426`), with the `INVENTORY_NOT_A_QUANTITY` suffix exemption (`:436`).

### 4.0 Pre-flight (`0075`'s `$pre$` shape, `0075:144-191`)

- none of `sales`, `sale_items`, `stock_source_bridge_sale` already exists;
- the four widened `registered_by` CHECKs are present (the `0074` head) — the same probe `0075:166-176` uses;
- `invoices`, `invoice_items`, `customers` exist and `invoices` holds **zero rows**, which is what makes
  `invoices_sale_fk` validate over an empty table (`0075:1066-1074` asserted it; `0077` re-asserts it
  **today**, because the live catalogue is the policy and `0075`'s assertion was about `0075`);
- `stock_source_types` holds no `sale` row and `stock_movement_kinds` no `sale` row;
- `accounting_source_types` holds neither `sale` nor `invoice`;
- `inventory_stock_source_guard_gaps()` returns **no row before** the file does anything — so a gap this
  file is blamed for is a gap this file made.

### 4.1 `sales`

| column | type | notes |
|---|---|---|
| `tenant_id` | `UUID NOT NULL` | `P4-AL-08` |
| `business_id` | `UUID NOT NULL` | |
| `id` | `UUID NOT NULL` | the caller-supplied document UUID, `P4-AL-30` |
| `customer_id` | `UUID` | nullable: the walk-in sale, `P4-AL-11` |
| `branch_id` | `UUID NOT NULL` | `P4-AL-40` |
| `warehouse_id` | `UUID NOT NULL` | the movement's key; needed by the COGS validator's warehouse dimension |
| `till_session_id` | `UUID` | **omitted in `0077`.** `pos_till_sessions` is P4-S3's relation and `P4-AL-86` refuses a later slice's table here; a bare `*_id` with no FK beside no discriminator is admitted by the schema lint but is a seam, and this slice declares none it was not given. P4-S3 adds the column and its FK. |
| `status` | `TEXT NOT NULL` | `CHECK (status IN ('draft','confirmed','returned_partial','returned_full','void'))` — the five states of `P4-AL-33` |
| `occurred_on` | `DATE NOT NULL` | **caller-supplied**, never `coalesce(p_date, current_date)` (`P4-AL-30`, `[[daftar-a-command-must-not-read-the-clock]]`) |
| `currency_code` | `CHAR(3) NOT NULL` | FK to `currencies (code)` |
| `subtotal_txn_minor` | `BIGINT NOT NULL` | `CHECK (… BETWEEN 0 AND 1000000000000000000)` |
| `discount_txn_minor` | `BIGINT NOT NULL` | |
| `tax_minor` | `BIGINT NOT NULL DEFAULT 0` | `CONSTRAINT sales_tax_policy_absent_ck CHECK (tax_minor = 0)` — `P4-AL-44`, OD-03 open |
| `total_txn_minor` | `BIGINT NOT NULL` | `CHECK (… BETWEEN 1 AND 1000000000000000000)` |
| `total_base_minor` | `BIGINT NOT NULL` | |
| `source_to_base_rate` | `NUMERIC(20,10) NOT NULL CHECK (> 0)` | the `0075:264` shape |
| `rate_source` | `TEXT NOT NULL CHECK (IN ('base','manual','provider'))` | |
| `rate_timestamp` | `TIMESTAMPTZ NOT NULL CHECK (date_trunc('second', …) = …)` | |
| `fx_rate_id` | `UUID` | |
| `customer_name_snapshot` | `TEXT` | `CHECK ((customer_id IS NULL) = (customer_name_snapshot IS NULL))` |
| `commit_intent_sha256` | `TEXT NOT NULL CHECK (~ '^[0-9a-f]{64}$')` | `P4-AL-30` |
| `void_intent_sha256`, `voided_by`, `voided_at` | `TEXT` / `UUID` / `TIMESTAMPTZ` | the void arm of the state CHECK |
| `business_transaction_id` | `UUID NOT NULL` | the repo-wide correlation id, FK-bound nowhere (`TL-P4-S1-C13`) |
| `created_by`, `created_at` | `UUID NOT NULL REFERENCES users (id)` / `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `accounting_source_type` | `TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED` | `P4-AL-16` |
| `binding_source_id` | `UUID` | nullable — `sales` has a `draft` state, so it takes the `purchases` variant of `TL-P4-S1-C6`, not the `NOT NULL` one |

**There is no `cogs_minor`, no `cost_total_*` and no per-line cost column.** `P4-AL-05`'s matrix names
`sale_items.cogs_minor` as the forbidden second truth, and `DERIVED_COST_COLUMN`
(`scripts/guards/no-authoritative-balance.ts:317`) refuses it by pattern. A per-line cost needed before
the movement is written is a transient in the routine.

Keys and constraints:

- `PRIMARY KEY (business_id, id)`
- `CONSTRAINT sales_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)` — `0067:303` shape; this is what makes `MATCH SIMPLE` harmless under a null `customer_id` (`P4-AL-09`)
- `CONSTRAINT sales_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT`
- `CONSTRAINT sales_branch_fk FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id)`
- `CONSTRAINT sales_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id)`
- `CONSTRAINT sales_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code)`
- `CONSTRAINT sales_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT`
- `CONSTRAINT sales_total_ck CHECK (total_txn_minor = subtotal_txn_minor - discount_txn_minor + tax_minor)`
- `CONSTRAINT sales_discount_ck CHECK (discount_txn_minor <= subtotal_txn_minor)`
- `CONSTRAINT sales_rate_shape_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND source_to_base_rate = 1))`
- `CONSTRAINT sales_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id)` — `0063:375`
- `CONSTRAINT sales_binding_owed_ck CHECK ((status <> 'draft') = (binding_source_id IS NOT NULL))` — the `purchases_binding_owed_ck` variant (`0063:376`), `TL-P4-S1-C6`
- `CONSTRAINT sales_state_ck CHECK (…)` — one CHECK enumerating each status with every column that must be null or non-null in it (`R-P4-04`, the `0075:303-311` shape): `draft` and `confirmed` carry no void columns; `void` carries all three; `returned_partial`/`returned_full` carry none
- `CONSTRAINT sales_walkin_terms_ck CHECK (customer_id IS NOT NULL OR … )` — the walk-in arm, mirroring `invoices_walkin_terms_ck` (`0075:316`)
- `CONSTRAINT sales_binding_fk FOREIGN KEY (business_id, accounting_source_type, binding_source_id) REFERENCES accounting_source_bindings (business_id, source_type, source_id) DEFERRABLE INITIALLY DEFERRED` — the all-or-nothing mechanism of `P4-AL-16`, `0063:381-384`

Indexes: `sales_customer_idx (business_id, customer_id, occurred_on, id)`,
`sales_occurred_idx (business_id, occurred_on, id)` — the `0075:332-334` keyset shape.

### 4.2 `sale_items`

| column | type |
|---|---|
| `tenant_id`, `business_id`, `sale_id`, `id` | `UUID NOT NULL` |
| `line_no` | `INTEGER NOT NULL CHECK (line_no >= 1)` |
| `product_id` | `UUID NOT NULL` |
| `variant_id` | `UUID NOT NULL` (a movement needs a variant key, unlike `invoice_items`) |
| `name_snapshot` | `TEXT NOT NULL` |
| `quantity` | `NUMERIC(18,4) NOT NULL CHECK (quantity > 0)` — the pin `TL-P4-S1-C5` extended to the word form |
| `unit_price_txn_minor`, `gross_txn_minor`, `discount_txn_minor`, `net_txn_minor`, `base_share_minor` | `BIGINT NOT NULL` |
| `tax_minor` | `BIGINT NOT NULL DEFAULT 0 CONSTRAINT sale_items_tax_policy_absent_ck CHECK (tax_minor = 0)` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

- `PRIMARY KEY (business_id, id)`
- **`CONSTRAINT sale_items_bridge_uq UNIQUE (business_id, sale_id, id)`** — the candidate key `P4-AL-29b`
  requires so the bridge's three-column line FK is expressible. The same shape as
  `negative_deficit_coverages_bridge_uq` (`0063:392`).
- `CONSTRAINT sale_items_line_uq UNIQUE (business_id, sale_id, line_no)` — and it is also what satisfies
  the numbering lint: `line_no` matches `/_(number|no)$/` in `scripts/phase4-s1-gate.ts`'s
  `numberingProblems`, which requires a UNIQUE covering it that includes `business_id`
- `CONSTRAINT sale_items_net_ck CHECK (net_txn_minor = gross_txn_minor - discount_txn_minor + tax_minor)`
- `CONSTRAINT sale_items_discount_ck CHECK (discount_txn_minor <= gross_txn_minor)`
- tenant FK, `sale_items_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE RESTRICT`, product FK, variant FK
- index `sale_items_sale_idx (business_id, sale_id, line_no)`

### 4.3 `invoices.sale_id` — closing seam `S-P4-01`

```
ALTER TABLE invoices ADD CONSTRAINT invoices_sale_fk
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id);
```

`scripts/phase4-s1-gate.ts:1121-1127` tests the Phase 4 SQL for
`FOREIGN KEY ( … sale_id … ) REFERENCES sales`, so the seam is satisfied rather than removed and the
**sealed** gate needs no edit. The `ON DELETE` is left at the default (`NO ACTION`) because `invoices`
already refuses every DELETE at `invoices_no_delete` (`0075:636`) and `sales` will too.

### 4.4 `stock_source_bridge_sale` — the `P4-AL-29b` apparatus

Pending §3. Planned shape, with each item's guard arm cited from the live body
(`0067_payment_methods_supplier_settlement_sources.sql`):

| obligation | guard arm | planned |
|---|---|---|
| a plain table named `stock_source_bridge_sale` | `:1516-1518` | yes |
| RLS enabled **and** forced | `:1519-1521` | `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` |
| PK **exactly** `(business_id, source_id, source_line_id, movement_kind)` | `:1523-1529` | yes; `tenant_id` is a column **outside** the key (§3) |
| `source_type TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED` | `:1530-1535` | yes |
| five-column validated `ON DELETE RESTRICT` binding FK | `:1537-1547` | `FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind) REFERENCES stock_source_bindings (same five) ON DELETE RESTRICT` |
| three-column validated `ON DELETE RESTRICT` line FK | `:1551-1564` | `FOREIGN KEY (business_id, source_id, source_line_id) REFERENCES sale_items (business_id, sale_id, id) ON DELETE RESTRICT` |
| `stock_bridge_immutable_sale`, ROW BEFORE UPDATE OR DELETE, no `WHEN`, no column list, on `stock_ledger_append_only()` | `:1566-1576` | yes |
| `stock_binding_requires_sale` on `stock_source_bindings`: ROW AFTER INSERT deferred constraint trigger, `WHEN (new.source_type = 'sale')`, on a `daftar_inventory_internal`-owned DEFINER function with the pinned path | `:1578-1595` | yes |

Six policies, exactly the ordinary set (`P4-AL-38` as corrected by `TL-P4-S1-C2`) — `tenant_membership`
in the **direct** form, the four `RESTRICTIVE` per-command isolation policies, and
`inventory_internal_read`. The bridge is **not** an accounting-source relation, so it carries no
`accounting_validator`.

Grants: `GRANT SELECT, INSERT ON stock_source_bridge_sale TO daftar_inventory_internal` and nothing to
`daftar_app` — `0063:591-594`. No UPDATE, no DELETE: the append-only trigger refuses them anyway, and a
privilege that only a trigger refuses is a wrapper, not an invariant.

### 4.5 `inventory_stock_source_guard_gaps()` is replaced, with a `sale` arm

**This is a decision, and the evidence is a measurement.** For a type that is none of S3/S4/S5 the live
body leaves the line FK's **target table and key unpinned** (`0067:1551-1564`:
`AND (NOT (v_s3 OR v_s4 OR v_s5) OR c.confrelid = v_line_tbl)`), records no body digest
(`0067:1574`, `0067:1593`) and requires none of `source_complete`, `source_freeze` or `header_immutable`.
Measured on the from-zero database: a `stock_source_bridge_sale` whose line FK points at
**`invoice_items (business_id, invoice_id, id)`** instead of `sale_items` was reported as
**no gap at all**. So without a replacement the sale would be the least-protected source in the registry,
and `P4-AL-29b`'s "exactly the line table and key" and "the SHA-256 of its `prosrc` recorded at
migration time" would be documentation rather than enforcement —
`[[daftar-every-journal-writer-equally-protected]]`.

Replacement is the accepted mechanism, not an edit to a frozen file: the routine has been replaced four
times (`0059:390` → `0061:308` → `0063:1247` → `0065:1396` → `0067:1438`), each time by the migration
that registered new source types. `0077` adds a `v_s6 := v_type IN ('sale')` arm that:

- adds `('sale', 'sale_items', ARRAY['business_id','sale_id','id'])` to the line-table `VALUES` list, so
  `bridge_line_fk` pins the target and key;
- extends the `NOT (v_s3 OR v_s4 OR v_s5)` conditions to include `v_s6`, so `bridge_immutable` and
  `binding_trigger` also check the recorded body digest;
- adds the `sale` per-type set — `source_complete` (deferred, on `sale_items`), `source_freeze`
  (`sale_items`), `header_immutable` (`sales`), `value_complete` (`sales`) — each pinned by table, name,
  `tgtype`, column list, `WHEN`, deferral, enabled state, expected owner and `prosrc` digest, exactly as
  the S4 and S5 blocks do at `0067:1645` and `0067:1703`;
- appends the new functions' digests to `c_digest`, computed from this file's own bodies.

`0077` then asserts, in its end-state block, that `inventory_stock_source_guard_gaps()` returns **no
row** — `P4-AL-29b`'s last line, and the same assertion `0063`, `0065` and `0067` each end with.

### 4.6 The two registries on the stock side

```
INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by)
  VALUES ('sale', 'negative', FALSE, 'P4-S2');
INSERT INTO stock_source_types (source_type, registered_by) VALUES ('sale', 'P4-S2');
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.commit', 'P4-S2');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
  VALUES ('sale.commit', 'sale', 'P4-S2');
```

`qty_sign = 'negative'` is read from the live registry: `supplier_return` and `purchase_reversal` are the
accepted negative kinds, and `0060:335-342` is the arm that enforces the sign. `requires_reason` is
`FALSE`: a sale is its own reason. All four `registered_by` values are `'P4-S2'`, which the `0074`
widening admits and which `0074:211-284` proved by performing both halves — `'P4-S1'` admitted,
`'P4'` refused.

`0060:186` reads the admissible op-codes **from** `inventory_operation_movement_kinds`, and `0060:219`
requires the `(op_code, movement_kind)` pair to be registered. So the new kind is consumed by the
existing writer and **`inventory_apply_stock_movements` is not changed** (`P4-AL-29`). `OD-P4-05` stays
NO OVERSELL: nothing here touches the writer's deficit path.

**Only `sale.commit` is registered.** See §11.1 — this is a Tech Lead review point, because the plan's
S2 row says "the `sale.*` operation kinds" in the plural.

### 4.7 The accounting side

```
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('sale',    'none', 'not_after_today', 'The inventory and cost side of a confirmed sale: Dr COGS / Cr Inventory (P4-AL-12).', 13),
  ('invoice', 'none', 'not_after_today', 'The revenue and receivable side of a sale (P4-AL-12).',                               14);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'sale',    'The COGS entry; derived by the sale commit command.'),
  ('post', 'invoice', 'The revenue/AR entry; derived by the sale commit command.');
```

`sort_order` 13 and 14 follow the live maximum, 12 (`purchase_residue_write_off`), read from the
catalogue. `lower_bound_policy`/`upper_bound_policy` follow every document source already registered.

**Two source types, because they are two entries** (`P4-AL-12`): the deferred validator compares a stored
source row against a journal entry as a multiset of line signatures, and one row cannot predict both the
COGS pair and the priced revenue set.

#### `accounting_sale_entry_complete()` — the COGS validator

The `0063:1557` / `0063:1608` shape, attached as

```
CREATE CONSTRAINT TRIGGER journal_entries_sale_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'sale')
  EXECUTE FUNCTION accounting_sale_entry_complete();
```

It reads the `sales` row by `binding_source_id = NEW.source_id` with `status = 'confirmed'`, raising
`accounting.inventory_detail_missing` when absent (the `0063:1570-1575` arm: the entry must be registered
by its own source row in the same transaction). It then requires **exactly two lines**: one on
`system_key = 'cogs'` and one on `system_key = 'inventory'`, netting `+Σ` and `−Σ` where

> **`Σ = −Σ stock_movements.value_delta_base_minor` over the sale's movements**

read from `stock_movements` through the sale's own `stock_source_bindings` rows — never
`quantity × average_cost` (`P4-AL-25`, `TL-P4-S0-01`). The dimensional arm is
`negative_inventory_cost_adjustment`'s (`0063:1633-1636`): the warehouse and branch dimensions, and
`txn_currency = base_currency AND fx_rate_source = 'base'` — a COGS entry is a base-currency fact, so no
per-line FX arithmetic arises and `P4-AL-19`'s no-rounding-line rule is vacuous here.
`NEW.entry_date` must equal `sales.occurred_on`.

#### `accounting_invoice_entry_complete()` — the revenue/AR validator

Reads the `invoices` row by `binding_source_id = NEW.source_id` with `status = 'open'`. The expected line
multiset, from the stored row:

| line | condition |
|---|---|
| `accounts_receivable` debit `total_base_minor` | **iff `invoices.customer_id IS NOT NULL`** |
| `cash`/`bank`/the payment method's posting account debit | **not in P4-S2** — the cash sale's settlement entry is a separate `payment_allocation` entry (`P4-AL-17`), which is P4-S4's |
| `sales_revenue` credit | `subtotal_txn_minor` converted at the row's own rate |
| `discounts` debit | `discount_txn_minor` converted, when non-zero |
| `tax_payable` | **never**: `tax_minor = 0` is a CHECK, so the validator requires **no** tax line and refuses one (`P4-AL-44`) |

and `total_txn_minor`, `currency_code`, `source_to_base_rate`, `rate_source`, `rate_timestamp` are
required on every line, the `0063:1597-1602` arm. **The walk-in invariant is carried here too**
(`P4-AL-11`'s last sentence): a null `customer_id` means the expected set contains no AR line, so the
validator refuses one — and that is a second, independent refusal beside `invoices_walkin_no_ar`.

> **Open: whether a credit sale in P4-S2 has a cash counterpart at all.** With no payment relation until
> P4-S4, a `customer_id IS NULL` walk-in sale posts a revenue entry with no AR line and therefore no
> balancing debit the stored row can predict. This must be settled with Agents B and C before the
> validator is written — see §11.2.

#### `accounting_reversals_20_domain_source_guard()` is replaced

`P4-AL-47` and seam `S-P4-02` bind the widening to the same migration that registers the type. The live
body's list (read from `pg_proc.prosrc` on the from-zero database) is

```
'inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return',
'supplier_payment', 'supplier_credit_allocation', 'supplier_refund', 'purchase_residue_write_off'
```

plus the conditional `purchase` arm. `0077` replaces the body **by its owner** (`SET LOCAL ROLE
daftar_accounting_internal`, the `0063:1521` shape) adding `'sale'` and `'invoice'`, and leaves the
`purchase` arm byte-identical. Were it omitted, `daftar_app` — which holds EXECUTE on
`accounting_post_reversal` (`0046:765`) — could reverse an invoice entry through the generic path,
consuming the single reversal slot `accounting_reversals.id = original_entry_id` allows and leaving the
books un-correctable by any product path.

`scripts/phase4-s1-gate.ts:1134-1141` requires `'invoice'` to appear within 4000 characters of a match of
`accounting_reversal` in the Phase 4 SQL, so the replacement also satisfies the sealed seam check.

### 4.8 `sales_walkin_no_ar` — `P4-AL-11`

Byte-for-byte the `invoices_walkin_no_ar` shape (`0075:655-695`), with `sales` in place of `invoices`:
`SECURITY DEFINER`, owner **`daftar_accounting_internal`** (`TL-P4-S1-C17`: the guard that refuses an AR
posting is the accounting authority's), pinned `search_path`, `PUBLIC` revoked, its only EXECUTE grantee
its owner, attached as

```
CREATE CONSTRAINT TRIGGER sales_walkin_no_ar
  AFTER INSERT OR UPDATE ON sales DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_walkin_no_ar();
```

inside its own `GRANT CREATE ON SCHEMA public TO daftar_accounting_internal` … `REVOKE` bracket. It
returns early when `customer_id IS NOT NULL OR binding_source_id IS NULL`, then raises
`sale.walkin_receivable_forbidden` if the bound entry carries a line on the `accounts_receivable`
account.

**`sale.*`, `invoice.*` and the third walk-in trigger.** `P4-AL-11` names three — `sales_walkin_no_ar`,
`invoices_walkin_no_ar`, `payments_walkin_no_ar`. The first is `0077`'s, the second already exists
(`0075:690`), the third belongs to the slice that creates `payments` (P4-S4).

### 4.9 The lifecycle guards on `sales` and `sale_items` (`P4-AL-46`)

Each `SECURITY DEFINER`, owner `daftar_inventory_internal` (not `daftar_sales_internal` —
`TL-P4-S1-C17`), pinned path, `PUBLIC` revoked, no EXECUTE grantee but the owner, created under the
GRANT-before-owner bracket of `R-P4-05` (`0075:505`, `0075:625-641`): the ACL and the triggers first,
ownership last, because a `GRANT` without grant option warns and commits.

| function | trigger | what it refuses |
|---|---|---|
| `sales_no_delete()` | `BEFORE DELETE ON sales` | every delete — a sale is voided or returned |
| `sales_lifecycle_guard()` | `BEFORE UPDATE ON sales` | identity changes; any money change once `status <> 'draft'`; moving or withdrawing a `binding_source_id`; any transition not in the `P4-AL-33` table |
| `sale_items_no_mutation()` | `BEFORE UPDATE OR DELETE ON sale_items` | every update and delete once the parent is confirmed — the `0075:593` shape, relaxed only for the draft replace, exactly as `purchase_lines` is (`0063` grants `DELETE` on `purchase_lines` to the internal principal and the freeze trigger refuses it unless the parent is a draft) |

**None of them authorizes by `current_user`** (`R-P4-06`), which is why definer is correct here; the one
guard class that must be `SECURITY INVOKER` is a guard that asks *who* is writing, and
`[[daftar-a-guard-that-asks-who-must-run-as-the-writer]]` applies to none of these.

### 4.10 Row security and privileges

`ENABLE` + `FORCE` on `sales`, `sale_items` and `stock_source_bridge_sale`.

| relation | policies |
|---|---|
| `sales` | **seven** — accounting-source relation: `tenant_membership` (direct form), `business_isolation_read` admitting `current_user IN ('daftar_inventory_internal','daftar_accounting_internal')`, `business_isolation_insert`, `business_isolation_update`, `business_isolation_delete`, `inventory_internal_read`, `accounting_validator` |
| `sale_items` | **six** — ordinary; the restrictive read admits `daftar_inventory_internal` only |
| `stock_source_bridge_sale` | **six** — ordinary |

**`sales` carries the seventh policy because its validator reads it.** Omitting `accounting_validator`
under `FORCE ROW LEVEL SECURITY` makes `accounting_sale_entry_complete()` — owned by
`daftar_accounting_internal` — read **zero rows and pass vacuously**: a green gate over an unchecked
invariant (`TL-P4-S1-C2`; `0075:437-471` is the worked example on `invoices`).

**`sale_items` is the case to get right and it is not obvious.** `accounting_sale_entry_complete()` reads
the `sales` header and `stock_movements`, not the lines, so it needs no policy on `sale_items`. But
`stock_source_complete_sale()` — the `source_complete` guard of §4.5, owned by
`daftar_inventory_internal` — does read `sale_items`, and `inventory_internal_read` admits it. Before
writing, each guard's actual reads are re-derived from the body and the policy set asserted to admit
exactly those principals; an assumed read is how the vacuous pass gets in.

Grants (`P4-AL-38`: `daftar_app` holds `SELECT` and `EXECUTE` and nothing else):

```
GRANT SELECT ON sales, sale_items TO daftar_app;
GRANT SELECT ON sales, sale_items TO daftar_inventory_internal;
GRANT SELECT ON sales TO daftar_accounting_internal;
GRANT SELECT, INSERT ON sales, sale_items, stock_source_bridge_sale TO daftar_inventory_internal;
GRANT UPDATE (<the enumerated confirm/void column list>) ON sales TO daftar_inventory_internal;
```

Column-level `UPDATE`, never table-level: `0063`'s supplier grant (`0063:597`) is the precedent, and a
table-level `UPDATE` would let the trusted generic primitive write a column the lifecycle guard happens
not to name.

### 4.11 `0077-E` — the end state, asserted against the live catalogues

The `0075-E` block (`0075:835-1076`) is the template. `0077-E` asserts:

1. the three new relations exist, `relrowsecurity AND relforcerowsecurity` on each, `tenant_id` and
   `business_id` `NOT NULL` on each, no floating-point column, and no column of the P4-AL-06 vocabulary —
   the `0075:875-903` arms, re-run over the new set;
2. the policy inventory from `pg_policy`: seven on `sales`, six on `sale_items`, six on the bridge, by
   exact name array; and the `tenant_membership` expression naming `tenant_id` and **not** `businesses`
   on all three;
3. privileges: `daftar_app` reads and holds no DML at either grain; no other runtime principal and not
   `public` holds anything — `0075:929-949`;
4. every FK from the three to a business-scoped parent names `business_id` on **both** sides and is
   validated — `0075:952-974`; `invoices_sale_fk` explicitly among them;
5. no sequence backs any of them — `0075:977-986`;
6. every new guard function: definer or invoker as designed, the expected internal `NOLOGIN` owner, the
   pinned path, and no EXECUTE grantee but its owner — `0075:988-1014`;
7. every new trigger by exact `pg_get_triggerdef`, with the deferred constraint triggers asserted
   `tgconstraint <> 0 AND tgdeferrable AND tginitdeferred` — `0075:1016-1033`;
8. **`inventory_stock_source_guard_gaps()` returns no row** (`P4-AL-29b`; the assertion `0063`, `0065`
   and `0067` each end with);
9. **every registered Phase 4 accounting source type appears in
   `accounting_reversals_20_domain_source_guard`'s `prosrc`** — discovered from
   `accounting_source_types`, not from a literal list, so a type registered later without the widening is
   named rather than missed;
10. the registry contents **captured, not written down** (`0074:188-193`): the four stock-side registries
    and the two accounting-side ones hold exactly their pre-image plus this file's rows, each scoped by
    `registered_by`/`sort_order` rather than by an absolute equality that a later phase would turn red —
    `[[daftar-a-closure-rule-is-not-an-invariant]]`;
11. `CREATE ON SCHEMA public` was handed back at the end of every bracket — `0075:1059-1063`;
12. `sales`, `sale_items` and the bridge hold **zero rows**, because `0077` ships no writer.

**And the before/after pair on the one thing `0077` reshapes.** `0077` adds a constraint to `invoices`
and replaces two routine bodies; it reshapes **no policy and no existing constraint**, so the `0074`
three-block pattern (before, after, and the claim PERFORMED in a subtransaction with each handler
checking `CONSTRAINT_NAME`) applies to:

- **before**: `invoices` holds zero rows and carries no FK on `sale_id` — read from `pg_constraint` today;
- **after**: `invoices_sale_fk` exists, is `convalidated`, and names `business_id` on both sides;
- **performed**: an `INSERT INTO invoices` naming a `sale_id` that is not a `sales` row is attempted in a
  subtransaction and must be refused **by `invoices_sale_fk`** — `GET STACKED DIAGNOSTICS v_con =
  CONSTRAINT_NAME`, and a refusal by any other constraint is reported as a defective probe and not as a
  proof (`0074:232-241`). The same three-block pattern proves the two replaced routine bodies: the live
  `prosrc` before, the new `prosrc` after, and the claim performed — a generic reversal of a planted
  `invoice`-source entry must be refused by `accounting.reversal_source_domain_owned`.

---

## 5. `0078` — the sale commit routine

`purchase_receive` (`0064:1084-1470`) is the precedent in every structural particular, and the order of
operations is `P4-AL-32`'s, which is the order the static lock-order check compares against:

> `sales` → movements → `stock_levels` → COGS entry → **`invoice_sequences`** → `invoices` + items →
> revenue/AR entry → (cash sale) payment, allocation, settlement entry

with the last leg absent until P4-S4.

| step | shape | citation |
|---|---|---|
| 1 | `v_actor := inventory_assertion_consume('sale.commit', inventory_claimed_payload_digest(…))` — the `invctl/1` protocol, no new signing key, no new consume routine | `P4-AL-27`; `0064:1172` |
| 2 | refuse any isolation but `READ COMMITTED` | `0064:1193-1195` |
| 3 | `inventory_business_transaction_id()`, refusing a missing trace | `0064:1198-1202` |
| 4 | `pg_advisory_xact_lock(hashtext('daftar.sale_id'), hashtext(p_sale_id::text))` — the per-document key, **before any other read** | `P4-AL-30` `[[daftar-registry-before-state]]`; `0064:1205` |
| 5 | the intent digest, then the `sales` row `FOR UPDATE`, then the replay test `status = 'confirmed' AND commit_intent_sha256 = v_intent` | `0064:1206-1217` |
| 6 | **no clock.** `occurred_on` is a parameter and part of the fingerprint; there is no `coalesce(p_occurred_on, current_date)` in the routine, the DTO, the schema, the service or the engine | `P4-AL-30`; `[[daftar-a-command-must-not-read-the-clock]]` |
| 7 | the customer `FOR SHARE` at the bound revision, when not a walk-in | `0064:1250-1258` |
| 8 | the FX snapshot derived, never read from the client | `0064:1267-1283` |
| 9 | the target locks, in `(warehouse, variant)` order | `0064:1321` |
| 10 | `inventory_apply_stock_movements(v_reqs)` with **negative** quantities, `movement_kind = 'sale'`, `source_type = 'sale'`, `source_id = p_sale_id`, `source_line_id = <sale_items.id>`, `unit_cost_base_minor = NULL` and `value_delta_base_minor = NULL` — the average-cost path the routine already implements computes both | `P4-AL-29`; `0064:1325-1334` |
| 11 | the lines, then the header: `status = 'confirmed'`, `binding_source_id = p_sale_id` | `0064:1369-1385` |
| 12 | `PERFORM sale_bridge_commit(p_sale_id)` | `0064:1388` |
| 13 | the sequence row's lock and the invoice number as `max + 1`, **last** of the domain locks | `P4-AL-31`, `P4-AL-32` |
| 14 | audit and outbox rows: ids, never amounts | `P4-AL-48`; `0064:1390-1398` |

`sale_bridge_commit(p_sale_id UUID)` is `purchase_bridge_receipt`'s twin (`0064:301-334`): internal-owned
DEFINER, **no grant to anyone**, re-verifying the transaction's consumed assertion with
`inventory_assertion_current(ARRAY['sale.commit'])`, and inserting one bridge row per
`stock_source_bindings` row of the sale — including `b.tenant_id`, which that table carries.

**`EXECUTE` is reachability, not authority** (`P4-AL-39`). `sale_commit` is granted to `daftar_app` and
is therefore reachable by anything holding an app connection, so its authority is the **signed**
`invctl/1` assertion it consumes at step 1 — never an application-side check and never a GUC.
`sale_bridge_commit` is granted to no one.

**What `0078` does NOT do: it does not post the journal entry.** Verified against the accepted tree:
`purchase_receive` posts no entry; the service does, through the one generic primitive
`accounting_post_entry` (`apps/api/src/modules/purchasing/purchase-posting.ts:12`), in the same
transaction. The database's hold on the result is the pair of mechanisms `0077` installs — the deferred
binding FK, which fails the COMMIT when a source row has no entry, and the deferred completeness
validator, which fails it when the entry is not exactly the one the stored row implies. That is why
`AccountingAssertionSequence.assertComplete()` is not the guarantee: presenting **none** is deliberately
allowed (`apps/api/src/infra/database.ts:484-490`), so a transaction that minted assertions and posted
zero entries commits with that seam silent (`P4-AL-16`).

---

## 6. What I cannot settle yet

| open | blocked on |
|---|---|
| `stock_source_bridge_sale`'s tenant carriage | **Agent B's evidence.** §3 is my judgement and the measurements behind it; the bridge is not written until B's answer is relayed. |
| `0077` existing at all | **Agent A's guard.** `TL-P4-S1-R2`: no migration file until the RLS `ENABLE`/`FORCE` discovery guard is integrated and red-proven. |
| the exact expected line multiset of `accounting_invoice_entry_complete()` | **Agents B and C.** §11.2: whether a P4-S2 sale posts a balancing debit at all, before `payments` exists. |
| whether `sale_items` keeps a `DELETE` grant for the draft replace | Agent B's cart/draft design (P4-S3 owns the server-side cart; whether a `draft` sale is editable in P4-S2 at all). |
| the `R-INV-*` question the plan's S2 row requires answered in writing before any movement is written | not yet done — `docs/PHASE_4_EXECUTION_PLAN.md:144` (risk `R-P4-09`): whether any Phase 3 `R-INV-*` check was written assuming purchase-only movement sources. |

---

## 7. Forward-evolution breakage this slice will cause

`TL-P4-S1-C18` measured this defect class at "at least 32 assertions across 22 permanent files" for
`0075`/`0076` and recorded the count as a **floor**, because a failing assertion masks the ones after it
in the same test body. The same shape applies here. Found by reading, on the from-zero database:

| assertion | what breaks |
|---|---|
| `tests/integration/migration-upgrade.test.ts:1324` | `stock_movement_kinds: 10` → 11; `stock_source_types: 8` → 9; `inventory_operation_movement_kinds: 10` → 11 |
| `tests/integration/migration-upgrade.test.ts:524-541` | the ordered `accounting_source_types` list, by `sort_order` — `sale` and `invoice` appended |
| `tests/integration/migration-upgrade.test.ts:821`, `:1428`, `:1507-1513`, `:1758`, `:1822`, `:2095`, `:2170`, `:2516`, `:2604`, `:2866-2867` | registry fingerprint unions over `accounting_operation_kinds`, `accounting_source_types` and `stock_movement_kinds`, each absolute |
| `tests/integration/settlement-s6-upgrade.test.ts:175`, `:187` | the same two unions |
| `tests/integration/phase4-s1-forward-scope.test.ts:46` | names `accounting_operation_kinds` |

`tests/helpers/stock-ledger.ts:693`'s `assertMigrationState()` and
`tests/helpers/purchase-deficits.ts:275`'s `assertS4MigrationState()` are **already safe**: P4-S1
re-expressed them per phase, scoping each read by `registered_by ~ '^P3-'`
(`tests/helpers/stock-ledger.ts:661-692`), so a `P4-S2` row is out of scope by construction. That is the
re-expression shape the rows above need.

**This list is a floor, not a total.** `TL-P4-S1-C18`'s rule applies: budget a full-estate run on a
pristine cluster and re-run the whole estate after every round of re-expression until a round finds
nothing. Ownership of these files has not been assigned to me and I have not touched them.

---

## 8. Test-file naming, verified

`scripts/phase4-s1-gate.ts:749-753` fails the **sealed** `gate:phase4:s1` for any file matching
`/^(?:p4|phase4)-.*\.test\.ts$/` in `tests/integration`, `tests/security` or `tests/performance` that no
`S1_SUITES` entry lists — and `S1_SUITES` is in the sealed file. `tests/guards/` has no such rule:
`guardSuiteProblems` (`:707-726`) requires only that the directory exist, hold at least one suite, and
that every file there end in `.test.ts`. So my own migration-facing tests go in `tests/guards/` under a
name that is not `phase4-rls-*` (Agent A's), or in `tests/integration` under the existing
`purchase-s4-*` / `inventory-s3-*` style. Note the consequence: the sealed gate **runs** the whole of
`tests/guards`, so anything I add there must pass.

---

## 9. How the deployment will be proved

A suite that applies migrations as a superuser is never asked the two questions that decide whether a
deployment works — whether the migration principal may create the object, and whether the ownership
handover is permitted. `0077` hands ownership to two internal roles, so it will be applied **as
`daftar_migrator`** on a cluster of its own (`PG_PORT=5445`) and the resulting catalogue diffed against a
superuser build: `pg_class` (including `relrowsecurity`/`relforcerowsecurity`), `pg_policy`,
`pg_constraint`, `pg_proc` (owner, `prosecdef`, `proconfig`, `proacl`) and `pg_trigger`
(`pg_get_triggerdef`). `scripts/db-from-zero.ts` and `npm run check:deployment-authority` are the
accepted tools; the second re-derives every ownership target from the frozen history and fails if
`bootstrap.sql` carries no membership for one.

---

## 10. Conflicts found between the documents and the code (the code wins)

1. **`docs/PHASE_4_EXECUTION_PLAN.md:299` says the sale bridge takes "RLS enable+force plus five
   policies".** The accepted bridge carries **six**: `tenant_membership`,
   `business_isolation_read/insert/update/delete` and `inventory_internal_read`
   (`0063:555-568`, read back from `pg_policy` on the from-zero database). `TL-P4-S1-C2` already
   corrected the count to six ordinary / seven accounting-source, and the plan's S2 row was not updated
   with it. The plan is wrong; `0077` carries six on the bridge.
2. **`P4-AL-29b`'s object table (lock `:666-676`) cites `0061:307-481` as the guard's enumeration.** That
   body has been replaced four times and the live one is `0067:1438`. The table's content is right; its
   citation points at a body the database does not hold, and the S5 arm and the `purchase_reversal` /
   `supplier_return` line-table rows exist only in the live version. Reading `0061`'s body — which is
   what the citation invites — gives a `v_s3`-only guard and a materially different answer about what
   `sale` must provide.
3. **`P4-AL-29b` lists `source_complete`, `source_freeze`, `header_immutable` and `value_complete` as
   obligations of the `sale` source.** The live guard requires them only for S3/S4/S5 types; for a new
   type it requires none of them and does not pin the line FK's target. So the lock's obligation is real
   but **unenforced until the guard is replaced** — which is §4.5's decision, and the measurement in §4.5
   is the proof that the gap is reachable.
4. **`P4-AL-20` (lock `:508`) says the `registered_by` pattern is widened "to `^P[0-9]+-S[0-9]+$`" in four
   constraints.** `TL-P4-S1-C3` already corrected this: the live `inventory_operation_kinds` CHECK is
   `registered_by ~ '^P[0-9]+-S[0-9]+$' OR registered_by = 'P3-C'`, confirmed from `pg_constraint`. No
   action for P4-S2; recorded so the next reader of `P4-AL-20` is not misled.

---

## 11. Tech Lead review points

### 11.1 Only `sale.commit`, or all of `sale.*`?

`docs/PHASE_4_EXECUTION_PLAN.md:299` and the lock's S2 row say "the `sale.*` operation kinds", and
`P4-AL-28` names `sale.commit`, `sale.void` and `sale.return`. But `sale.void` is P4-S6's command and
`sale.return` is P4-S5's, and an `inventory_operation_kinds` row is a registration of **authority**: once
it exists, `inventory_assertion_consume` will accept an assertion carrying that op-code. Registering
either now is a live authority with no writer — which is the reasoning `TL-P4-S1-R1` used to refuse the
`invoice` accounting source type in P4-S1 ("an accounting source type must not exist as a dead registry
concept without a real writer"). **Recommendation: `0077` registers `sale.commit` alone**, and the two
others are registered by the slices that implement them. This needs a ruling because it narrows a plan
row.

### 11.2 What balances a P4-S2 revenue entry?

`P4-AL-16` lists the cash sale's payment, allocation and settlement entry as part of the atomic sale, and
`P4-AL-17` requires one journal entry per **allocation** — but `payments` and `payment_allocations` are
P4-S4's relations and `P4-AL-86` refuses a later slice's table here. So in P4-S2 a **credit** sale's
revenue entry balances against AR, and a **walk-in cash** sale's has nothing on the stored row to balance
against. Three readings are available and only one is this slice's to pick: P4-S2 commits credit sales
only; or it posts a provisional cash debit the validator predicts from `sales`; or the slice boundary
moves. **This is not a migration decision and I will not pick it.** It blocks
`accounting_invoice_entry_complete()`'s expected line multiset, which is the whole substance of the
`invoice` source type `TL-P4-S1-R1` moved here.

### 11.3 No `daftar_sales_internal`

Recorded for completeness: a fifth internal owner role is **new authority** needing its own bootstrap
entry and its own reviewed commit, and `TL-P4-S1-C17` refused one in P4-S1. `0077` therefore owns its
stock-side guards with `daftar_inventory_internal` and `sales_walkin_no_ar` with
`daftar_accounting_internal` — which is also the correct reading on the merits.

---

## 12. What I could not verify

- **The RLS discovery guard's interface.** Agent A's guard does not exist yet, so I could not check that
  `0077`'s three new relations satisfy it, only that they will be `ENABLE`d and `FORCE`d.
- **Agent C's engine and Agent B's service**, so the claim in §5 that `0078` posts no journal entry is
  verified against the accepted purchase path and not against P4-S2's own, which is not written.
- **The full-estate failure list of §7.** I read the assertions; I did not run the estate, which
  `TL-P4-S1-C18` says is the only way to bound this defect, and a single run would not bound it either.
- **`tsc` over my own diff.** This branch adds one document and no TypeScript, so there is nothing of
  mine for `tsc` to judge; a green `tsc` in this worktree would be about the main checkout's files, since
  the worktree carries no `node_modules` of its own.

---

## 13. `0077` as built, and what building it changed (added after the release to write it)

`0077_phase4_sales_sale_items_sources.sql` exists on this branch. It **applies from
zero as `daftar_migrator`**, **re-applies as a no-op**, and the deployment it
produces was diffed against a superuser-built catalogue: the two schema dumps are
byte-identical apart from `pg_dump`'s own nonce, the 213 `OWNER TO
daftar_*_internal` lines are identical, and every `GRANT`/`REVOKE` line is
identical. The only difference is which role owns the objects the applier keeps,
which is `daftar_migrator` in one build and `postgres` in the other — correct, and
the reason the deployment is proved by performing it rather than by a superuser
suite.

Agent A's law is **green over all three new relations**: zero problems, both halves
agreeing, 8 declared and 8 live Phase 4 relations, all 8 in `tenantAndBusiness`,
nothing in `oneDimension` or `noDimension`, 109 inherited and one applier relation
subtracted. The sealed S1 gate's **sixteen** structural check functions each return
`[]`, the three deferred seams included — so `S-P4-01` is closed by
`invoices_sale_fk` and `S-P4-02` by the reversal guard naming `'invoice'`.
`inventory_stock_source_guard_gaps()` returns **no row**. `check:migrations` is
green with 0077 present and **no manifest entry**, per `TL-P4-S1-C8`.

### 13.1 Things the design document did not have, found by building it

**(a) The vacuous-pass trap was live on `invoice_items`, not hypothetical.**
`invoice_items` carries exactly six policies (`0075:460-473`) and its RESTRICTIVE
read admits `daftar_inventory_internal` alone. The deferred invoice validator is a
DEFINER owned by `daftar_accounting_internal`, so under `FORCE ROW LEVEL SECURITY`
it read **zero lines and passed** — not failed, passed. `0077` therefore makes
`invoice_items` an accounting-source-reading relation: `ALTER POLICY
business_isolation_read` to the same two principals `0075` already names on
`invoices`, a seventh `accounting_validator` policy, and `GRANT SELECT ... TO
daftar_accounting_internal`. All three are needed; a policy without the grant and a
grant without the policy each read zero rows and pass. Never an edit to `0075`.

**(b) `P4-AL-29b`'s `value_complete` arm has no lawful subject for `sale`.** Its
subject would have to be a stored cost total on `sales`, which `P4-AL-05` forbids
and which the no-authoritative-balance guard's `DERIVED_COST_COLUMN`
(`scripts/guards/no-authoritative-balance.ts:317`) refuses by name. The `sale` arm
therefore carries `source_complete`, `header_complete`, `source_freeze` and
`header_immutable` — four, not five. Recorded as a Tech Lead review point.

**(c) The sale's cost had to cross a domain boundary, and does so as a function.**
The `sale` entry is the COGS/Inventory pair (`PHASE_4_ARCHITECTURE_LOCK.md:341`) and
its amount is the sum of `stock_movements.value_delta_base_minor`. There is no
stored total to read, by (b). The accounting validator therefore needs a number the
inventory domain owns. Granting `daftar_accounting_internal` `SELECT` on
`stock_movements` would buy a table-wide read **and** require adding it a policy on
a FROZEN Phase 3 relation to get one number. `0077` instead adds
`inventory_sale_cost_base_minor(UUID, UUID)` — `STABLE SECURITY DEFINER`, owned by
`daftar_inventory_internal`, pinned, `PUBLIC` revoked, `EXECUTE` to
`daftar_accounting_internal` **alone**. The precedent is
`inventory_business_has_stock_movements(UUID)` at `0069:212`, granted to this very
principal for this very reason. It returns **NULL, never 0**, on an empty movement
set, so the caller cannot read "no movements" as "a cost of nothing".

**(d) A header twin was required and the design document did not name one.** A
draft that becomes `confirmed` by an `UPDATE` touches no line, so without
`stock_source_complete_sale_header()` on `sales` a sale could be confirmed carrying
movements for none of its lines — the hole `purchases_received_complete`
(`0063:1132`) exists to close. Five new inventory-owned routines, not four.

**(e) RLS is evaluated before CHECK constraints, and `app_bypass()` is not what
`0006` defined.** The performed tax probe tripped `new row violates row-level
security policy` and reported itself DEFECTIVE, which is what a defective-probe
handler is for. `SET LOCAL app.bypass_rls` does not help: the **live**
`app_bypass()` is `current_user = 'daftar_platform'`, not `0006:11`'s setting read —
one more instance of `[[daftar-the-live-catalogue-is-the-policy]]`. The probe now
STATES a tenant and a business context and inserts a row in it, which widens
nothing and is reset afterwards.

**(f) The bridge carries two RESTRICT edges, not three.** The tenant edge to
`businesses (tenant_id, id)` is a plain composite FK, as everywhere else; it is
asserted by name and column list separately.

### 13.2 The two recommended-option decisions, marked in the file itself

- **D-1 (the balancing side).** `accounting_invoice_entry_complete()` takes the
  settlement account from `sales.settlement_kind`: `cash` debits the `cash` system
  account **directly**, with no payment document and no P4-S4 relation; `credit`
  debits `accounts_receivable`. `settlement_kind` is a stored **input** — a fact the
  merchant states — so `[[daftar-no-stored-derived-truth]]` is untouched. Marked in
  the file as the recommended option pending the Tech Lead's card. **If the ruling
  goes the other way this function is the only thing in `0077` that changes, and it
  changes by replacement in a later migration.**
- **D-2 (net revenue).** Revenue is recognised net. Requiring **exactly two** lines
  is what refuses a separate `discounts` contra line and a `tax_payable` line: a
  third line of any kind fails, so a gross-plus-contra shape cannot be posted behind
  the validator's back. `tax_minor = 0` is a row CHECK, and a non-zero tax is
  REFUSED, not computed — `OD-03` stays open and no jurisdiction's rule is encoded.

### 13.3 The non-vacuity canaries

Every validator fails when it has no subject rather than passing:

| validator | canary |
| --- | --- |
| `accounting_sale_entry_complete()` | the sale row was found and is not a draft; `inventory_sale_cost_base_minor()` is **not NULL** and is positive; the entry has exactly two lines |
| `accounting_invoice_entry_complete()` | the invoice row was found and is not a draft; its sale was found; the line **count** is asserted separately and the base-share **sum is refused when NULL**; the entry has exactly two lines |
| `stock_source_complete_sale()` / `_header()` | a non-draft sale with **zero** lines is refused, so an empty document cannot satisfy "every line is right" |
| `inventory_stock_source_guard_gaps()` | `0077-E` reads it and prints every gap it found, rather than asserting a count |

### 13.4 The name Agent D's canary needs

The commit routine `0078` creates is **`sale_commit`**. `0077` creates no writer at
all, and `0077-E` asserts that physically: no routine it creates is executable by
any runtime principal.

---

## 14. The forward-evolution breakage, MEASURED (this supersedes §7's prediction)

§7 was a prediction read off the source. This is what a full estate run actually
reported with `0077` applied. **It is a FLOOR and not a total** (`TL-P4-S1-C18`):
a failing assertion hides every assertion after it in the same body, so each
round of fixes surfaces more. One round has already proved that — fixing
`settlement-s6-upgrade.test.ts:248` surfaced a second failure at `:292` in the
same body that the first had been hiding.

### 14.1 Round 1, measured

| file:line | claim | why `0077` breaks it |
| --- | --- | --- |
| `tests/integration/migration-upgrade.test.ts:524` | exact `toEqual` over `accounting_source_types ORDER BY sort_order` | `sale` at 13, `invoice` at 14 |
| `…:848` | `protectedDigest()` exact, with `src:<type>:<order>` rows | the same two |
| `…:1299` | `registries()` exact, `type:`/`map:` rows | `type:sale:P4-S2`, `map:sale.commit:sale:P4-S2` |
| `…:1548` | `protectedRows()` exact, `src:`/`kind:` rows | the two source types and `kind:sale:negative:f:P4-S2` |
| `…:1862` | `protectedRows()` exact over `PROTECTED` + `src:` | the same, plus the `stock_movement_kinds` row |
| `…:2274`, `…:2713` | the **already two-step** disjointness half, `nonAudit(afterBeyond)` **equal to** `nonAudit(after)` | it compares EVERY non-audit row exactly, and the declarative registries are relations a later phase legitimately appends to |
| `tests/integration/settlement-s6-upgrade.test.ts:248` | `nonAudit(afterRows)` exact | the two source types |
| `…:292` (**hidden behind `:248`**) | `registries()` exact, `acct:`/`map:`/`op:`/`type:` rows | `acct:post:sale`, `acct:post:invoice`, `op:sale.commit:P4-S2`, `map:…`, `type:…` |
| `tests/security/phase3-s8-signed-authority-matrix.test.ts:253` | `toHaveLength(9)` on the types added after `0052`, taken against the WHOLE tree | 11 |
| `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:624` | exact `toEqual` over the twelve source types | the same two — **Agent D's file, not mine to edit** |

`tests/integration/phase4-s1-forward-scope.test.ts` **passes**: it builds its
scratch database `{ upTo: PHASE4_INHERITED_PREFIX_END }` and only its probe
fixture runs past that, so no real Phase 4 migration ever reaches its claims. My
§6 flag on its line 46 was a false positive and C's prediction of `:47,61` does
not reproduce. `tests/guards/phase4-rls-force-guard.test.ts` passes.

### 14.2 The method, beside the floor

Three narrowings, in order of preference, and **never a loosening**:

1. **Scope by the registry's own provenance column**, `registered_by ~ '^P3-'` —
   the idiom of `tests/helpers/stock-ledger.ts:661-692`. Exact equality survives
   on the scoped subset, so a missing Phase 3 row is still red and so is an extra
   row claiming Phase 3 provenance: the scope cannot be dodged by mislabelling a
   Phase 4 row as `P3-S7`. **Which relations carry that column is discovered**
   from the catalogue (`PROVENANCE_RELATION_SQL`), never listed.
2. **Stop the upgrade at the accepted Phase 3 head** and keep every assertion
   word for word there, then apply the migrations beyond it in a step of their
   own that carries the disjointness half. This is the only option when the
   registry has **no provenance column** — `accounting_source_types` and
   `accounting_operation_kinds` do not — and it is the shape P4-S1 already used.
3. **Take the registries out of a whole-estate row equality** and claim them
   separately: nothing a Phase 3 row was promised stops being promised (no
   removal, no rewrite, no Phase-3-labelled arrival), and a row a later phase
   registers is out of scope, which is the point. The registries are
   **discovered** as the relations with no business dimension that carry a
   registration column (`REGISTRY_RELATION_SQL`) — on the Phase 4 head exactly
   six, none of them named in the helper.

Where a registry has no provenance and a second database is too expensive, the
claim is kept as a **PREFIX** claim instead: the types the accepted head holds
are still the first *n* in `sort_order`, in the same order, and whatever a
successor registered sits entirely after them and repeats none of them. That is
`0046`'s append rule stated positively, and it is strictly stronger than the
count it replaces.

### 14.3 What Agent D is owed

`tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:623-640` reads
the LIVE catalogue and asserts the twelve source types exactly. It is Agent D's
file and I have not touched it. The narrowing that fits it is option 3's prefix
form, which needs no second database and no new helper:

- keep the twelve-name literal exactly as it is;
- compare it against `types.slice(0, 12)` rather than `types`;
- add, positively, that `types.slice(12)` contains none of the twelve — so a
  successor cannot register one of them a second time or displace the order.

---

## 15. `0077` amended for the four late rulings, and the naming the landed code settles

This section supersedes every earlier section of this document wherever they disagree, because it was
written against the code at `7902b7a` rather than against a contract draft.

### 15.1 The column names are the landed code's, not either contract's

`docs/PHASE_4_S2_ACCOUNTING_CONTRACT.md` §6.5 still says `settlement_kind` and `sold_on`;
`docs/PHASE_4_S2_CONTRACT.md` C-01 says `settlement_mode` and `document_date`. The **code wins**, and the
code is unambiguous: `packages/inventory/src/sale-payloads.ts:115,120` declare `settlementMode` and
`documentDate`, and the 29-argument call the service already makes
(`apps/api/src/modules/selling/sale-commit.service.ts:376,380`) passes them in that order. The accounting
package's `soldOn` (`packages/accounting/src/sale-posting.ts:221`) is a **fact-struct field name**, not a
column name, and the service binds it from `input.documentDate` (`:351`). So `0077` carries
`sales.settlement_mode` and `sales.document_date`, and `accounting_sale_entry_complete()` dates the COGS
entry on `document_date` while `accounting_invoice_entry_complete()` dates the revenue entry on the
invoice's own `issue_date` — which the service sets from the same `documentDate` (`:328`).

### 15.2 The cash sale debits the `cash` SYSTEM ACCOUNT, and the landed code agrees

The accounting contract's §6.5 asks for `payment_method_id` / `posting_account_id` on `sales` with the
three-column FK to `payment_methods`, and for the cash arm to be compared by
`l.account_id = sales.posting_account_id`. The landed service does not do that:
`apps/api/src/modules/selling/sale-commit.service.ts:336` passes
`settlementAccount: input.settlementMode === 'cash' ? { kind: 'system', systemKey: 'cash' } : null`,
and `saleInvoiceDebitAccount()` (`packages/accounting/src/sale-posting.ts:396-397`) resolves it from
there. That is exactly the recommended option this document designed against (D-1), now landed. `0077`
therefore adds **no** `payment_method_id` and **no** `posting_account_id` to `sales`, and
`accounting_invoice_entry_complete()` compares the debit against the `cash` system account key for a cash
sale and `accounts_receivable` for a credit sale. A payment-method posting account is P4-S4's, and adding
the column now would be a live column with no writer.

### 15.3 `sales` carries no `cogs_base_minor`, so `P4-AL-29b`'s `value_complete` arm has no subject

The accounting contract's §6.4 table still asks for a `value_complete` arm asserting
`Σ stock_movements.value_delta_base_minor = -sales.cogs_base_minor`, and §6.5 still lists
`cogs_base_minor BIGINT` among `sales`' columns. Both are refused by a law that is already landed:
`scripts/guards/no-authoritative-balance.ts:317`'s `DERIVED_COST_COLUMN` and `P4-AL-05`. The landed
accounting code settles it in the same direction — `deriveSaleCogsEntryLines()`
(`packages/accounting/src/sale-posting.ts:632`) computes the cost from the bridged movement values and
reads no column on `sales`. So `0077` creates no such column and the `value_complete` arm of the sale's
guard row is deliberately absent; what replaces it is `sales_cogs_owed` (§15.4), which re-derives the sum
instead of comparing against a stored copy.

### 15.4 `sales_cogs_owed` — the deferred rule that makes the conditional COGS arm safe

The conditional arm has landed: `deriveSaleCogsEntryLines()` returns `null` for a sale that released no
stock value, `deriveSaleCommitPostings()` carries `cogs: null`
(`packages/accounting/src/sale-posting.ts:713,745-746`), and `mintSaleCommitAssertions()` mints one
assertion instead of two (`:820-825`). Nothing in the application layer can refuse the case where the skip
was **not** owed, because the seam never sees a COGS total. The database rule is therefore not an
alternative to the seam, it is what the seam's permission rests on, and the two land together:

```sql
CREATE CONSTRAINT TRIGGER sales_cogs_owed AFTER INSERT OR UPDATE ON sales
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_cogs_owed();
```

owned by `daftar_accounting_internal`, `SECURITY DEFINER`, pinned path. It re-derives
`Σ value_delta_base_minor` over the **bridged** movements through
`inventory_sale_cost_base_minor(business_id, id)` and requires a `sale`-source accounting binding **iff**
that sum is non-zero. A NULL sum — a committed sale with no bridged movement at all — is refused outright
rather than treated as zero, because NULL is the absence of a subject and not a value (the same reasoning
as the validators' non-vacuity canaries). Draft rows return early.

`sales_binding_owed_ck` is consequently **weakened on purpose** to
`CHECK (status <> 'draft' OR binding_source_id IS NULL)`, not the accounting contract §6.5 /
`docs/PHASE_4_S2_CONTRACT.md` C-01 biconditional `(status IN ('confirmed','void')) = (binding_source_id IS
NOT NULL)`. A CHECK constraint cannot read the ledger, so the strict form would refuse the lawful
zero-cost sale outright. The obligation moved to the deferred trigger, which can read it; the CHECK keeps
only the half that is unconditional (a draft owes nothing). End-state item (9b) pins
`pg_get_constraintdef` of that constraint exactly, so a later migration cannot quietly restore the strict
form and re-close the lawful case.

### 15.5 The reversal guard is rebased on `0072`, verified mechanically

`0077`'s `accounting_reversals_20_domain_source_guard` body is `0072`'s body **byte for byte** with
`'sale', 'invoice'` appended to the always-refused `IN` list after `'purchase_residue_write_off'`. Appended
rather than inserted, because `0067:2790` and `0072:903` each assert a **substring** of that list. Verified
by extracting both bodies between their `AS $$` markers and comparing after substituting the one list — the
comparison is exact, so nothing of `0072`'s sixth version is dropped, the `purchase` carve-out is
unchanged, and `purchase_residue_write_off` is retained. `0077:1934` additionally asserts
`position('''purchase_residue_write_off''' IN v_def) <> 0` over the live definition, so the drop this
correction warned about cannot recur unnoticed.

### 15.6 The bridge carries `tenant_id`, measured against the live guard

`stock_source_bridge_sale` carries `tenant_id UUID NOT NULL` with
`stock_source_bridge_sale_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id,
id)`, absent from the primary key — which stays exactly `(business_id, source_id, source_line_id,
movement_kind)` — and absent from the three-column line FK. Its `tenant_membership` policy takes the
direct `tenant_id = nullif(app_tenant(), '')::uuid` form. Verified live:
`inventory_stock_source_guard_gaps()` returns **no row**, and Agent A's law partitions all eight declared
Phase 4 relations into `tenantAndBusiness` with `oneDimension` and `noDimension` both empty.

### 15.7 `invoice_sequences` holds NO counter, which changes what C-09 step 10 can lock

Confirmed for the sale contract owner, who read `0075:375` (`period`) and flagged the rest. The full shape
(`0075:371-384`) is `tenant_id`, `business_id`, `document_kind` (CHECK `= 'invoice'`), `period` (CHECK
`~ '^[0-9]{4}$'`), `number_format` (8–64 chars, trimmed, matching
`^[A-Za-z0-9/-]*\{YYYY\}[A-Za-z0-9/-]*\{SEQ:[1-9][0-9]?\}[A-Za-z0-9/-]*$`), `created_at`, `updated_at`,
`PRIMARY KEY (business_id, document_kind, period)` and `invoice_sequences_tenant_fk (tenant_id,
business_id) → businesses (tenant_id, id)`. RLS enable + force with five policies (`0075:398-399,475-492`),
`SELECT` to `daftar_app` and `daftar_inventory_internal` (`:494-495`), and
`invoice_sequences_key_guard BEFORE UPDATE OR DELETE` refusing a key change (`:639`).

**There is no `next_seq`, `last_seq` or counter column of any name.** The counter is
`invoices.number_seq BIGINT NOT NULL CHECK (number_seq >= 1)` (`0075:252`) under
`invoices_number_uq UNIQUE (business_id, document_kind, period, number_seq)` (`:286`), and `0075:131`
states the credit-note precedent reads `max(number_seq)` from `invoices` rather than from a counter. So
C-09 step 10 cannot lock and bump a counter: it must take a **row lock on the `invoice_sequences` row** for
`(business_id, 'invoice', period)` — `FOR NO KEY UPDATE`, which the `BEFORE UPDATE` key guard does not
obstruct because no update is performed — and then read `coalesce(max(number_seq), 0) + 1` from `invoices`
under that lock. `invoices_number_uq` is the backstop that makes a missed lock a refusal rather than a
duplicate number. The lock order must stay `businesses → invoice_sequences`, matching R-1.

---

## 16. `0078` — `sale_commit`, as built

### 16.1 What it creates

`sale_commit` to C-09's 29-argument signature (18 scalars, 11 parallel arrays,
`RETURNS TABLE (replayed BOOLEAN, cogs_base_minor BIGINT)`, no `p_tax_minor`, no `DEFAULT`), plus three
internal helpers with no `EXECUTE` grant at all: `sale_lock_commit_targets` (the `sale.commit` twin of
`purchase_lock_receipt_targets`, `0064:80`), `sale_document_number` (the renderer of
`invoice_sequences.number_format` — the FIRST in the tree, because P4-S1 created no writer of `invoices`)
and `sale_bridge_commit` (the one writer of `stock_source_bridge_sale`, on the `purchase_bridge_receipt`
pattern at `0064:301`, copying `tenant_id` from the binding it bridges). `EXECUTE` on the entry routine is
`daftar_app`'s and nobody else's; all four are `SECURITY DEFINER` with the pinned path, owned by
`daftar_inventory_internal`.

### 16.2 The two digests, verified by measurement rather than by reading

The highest-risk part of this file is the two `invpl/1` streams it re-derives: get a field's type, order or
fixed-point scale wrong and the routine refuses every lawful sale with
`inventory.assertion_payload_mismatch`, which reads like an authority problem and is an arithmetic one. So
it was measured, not reasoned about: the two array expressions were extracted from the migration's own
text, bound to the same values through a CTE whose columns carry the routine's parameter names, and
compared against `saleCommitPayload()` and `saleCommitIntentSha256()` from
`packages/inventory/src/sale-payloads.ts`. Both digests match byte for byte, on two cases chosen for their
different NULL paths:

| case | payload | intent |
|---|---|---|
| credit sale, named customer, due date, notes, foreign rate, one line with a merchant variant and one without | MATCH | MATCH |
| walk-in cash sale, no customer, no due date, no notes, domestic rate | MATCH | MATCH |

Two fields of the argument list are deliberately ABSENT from the payload stream — `p_gross` and
`p_name_snapshots` — because both are derivable, and a derivable field inside a fingerprint is a second
truth. They are recomputed at step 6 instead and a disagreement is `sale.state_changed`.

### 16.3 Three things the live catalogue decided, against a document or a reading

**`products.translations` does not exist.** `0036` normalized the catalogue's translations into
`product_translations (business_id, product_id, locale, name)` and DROPPED the JSONB column. The name
snapshot is therefore read from that relation, ordered by `array_position(ARRAY['ar','en','tr'], locale)`,
and `0078` grants `SELECT ON product_translations TO daftar_inventory_internal` — `0053:253` had not,
because no inventory routine needed a product NAME before.

**Every PostgreSQL locking clause needs `UPDATE`.** `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and
`FOR KEY SHARE` alike require `UPDATE` on the relation, at relation level or on any one column. So
`businesses` and `customers` are READ rather than row-locked: locking the tenancy root would mean granting
the inventory writer the right to WRITE `businesses`, which is a far larger authority than the lock is
worth, and `purchase_receive` reads the same two business columns unlocked (`0064:1248`). The customer
takes a SHARED ADVISORY lock on its own id instead, which PUBLIC may execute and which therefore adds no
privilege, so two concurrent sales of one customer still serialise. The two locks the slice's laws DO rest
on are taken and paid for: `stock_levels` `FOR UPDATE` inside the writer (OD-P4-05, the last-item race) and
`invoice_sequences` `FOR NO KEY UPDATE` at step 10, for which the file grants exactly one `UPDATE` — with
0078-E(5) asserting from `prosrc` that the routine contains no `UPDATE`, `INSERT` or `DELETE` of that
relation, so the privilege is the lock's and nothing else's.

**`lpad` TRUNCATES.** `lpad('1234', 2, '0')` is `'12'`, so a naive renderer would turn an ordinal wider
than its `{SEQ:n}` field into an earlier document's number and collide under
`invoices_document_number_uq`. The width is a minimum in `sale_document_number`, and a performed proof
pins both directions.

### 16.4 The one correction to `0077`, as a replacement and not an edit

`0077`'s `accounting_sale_entry_complete()` required the COGS line to carry a NULL `warehouse_id`, on the
purchase entry's precedent (`0063:1584-1585`, whose counter-account is Accounts Payable — a supplier fact
with no warehouse). That is wrong for a sale, and the landed accounting code says so with the better
citation: `deriveSaleCogsEntryLines` (`packages/accounting/src/sale-posting.ts:632-650`) puts the sale's
warehouse on BOTH lines, because the one accepted Inventory/COGS PAIR in the tree —
`accounting_negative_inventory_cost_adjustment_entry_complete` (`0063:1640-1643`) — requires
`warehouse_id IS NOT DISTINCT FROM v_wh` on every line of the entry, its COGS line included. Measured, not
reasoned: with `0077`'s arm in force the first end-to-end sale is refused
`accounting.selling_entry_mismatch` at COMMIT and the whole P4-AL-16 path is unreachable.

`0077` is **not edited**. It is merged at `1b5a606` and other agents have applied it, so an edit would
change its checksum and fail each of their databases with `Migration tampered after apply`. `0078`
replaces the body with `CREATE OR REPLACE`, by its owner under a lent `CREATE ON SCHEMA public`, keeping
`0077`'s text byte for byte except the one `warehouse_id` comparison — the mechanism `0063`, `0065`,
`0067` and `0072` each used on this estate.

### 16.5 The forward-evolution break `0078` causes, and the one narrowing it needed

`tests/integration/read-s7-no-cache.test.ts` pins `daftar_app`'s privilege matrix at 174 lines and a
digest. P4-S2 adds three grants and the file already carries the accepted shape for exactly this: a named
constant per phase, subtracted before the digest is taken. So a `P4_S2_APP_GRANTS` of
`relation public.sale_items SELECT`, `relation public.sales SELECT` and the `sale_commit` `EXECUTE` line
was added beside `P3C_APP_GRANTS` and `P4_S1_APP_GRANTS`, and `S6_END_STATE` keeps its original 174 and
its original digest WORD FOR WORD. Recomputing that digest to today's value would have let a fourth grant
in silently, which is the failure mode the shape exists to refuse. The discovered no-DML law above it
covers `sales` and `sale_items` without naming either.

### 16.6 What `0078` deliberately does not do

It writes no journal line. It adds no refusal for the zero-valued sale — the landed conditional arm is
what the caller uses and `sales_cogs_owed` is what makes it safe, so a second refusal here would refuse
the lawful case. It does not touch `inventory_apply_stock_movements`: both cost columns of every request
are NULL, so the writer values the movement under the stock key's own lock, which is also where
`inventory.insufficient_stock` is raised (OD-P4-05), and 0078-E(6) reads that refusal back out of the live
`prosrc`. And it creates no `invoice_sequences` row: nothing in `0000`–`0077` does, so a business with no
stated series is refused `sale.issue_invoice` rather than given a default `number_format`, which would be
a product decision about what every document of that business is called forever.

---

## 17. The zero-cost sale, made reachable — the `0077` amendment

### 17.1 What was unreachable, and why it was not visible

`0077:564` and `0077:618` both required `m.value_delta_base_minor < 0` on every line of a non-draft sale —
a STRICTLY negative value. The zero-valued movement `0060:388-390` produces does not satisfy it, so
`stock_source_complete_sale` and `stock_source_complete_sale_header` refused the zero-cost sale outright
with `inventory.source_movement_set_incomplete`. Three things in this slice therefore rested on a state
nothing could reach: `sales_cogs_owed()`'s `v_cost = 0` branch, the seam's conditional COGS arm, and the
weakening of `sales_binding_owed_ck` away from C-01's strict biconditional.

The amendment, on the recommended option: both predicates read `<= 0`, and the quantity — which is what
actually establishes completeness — is pinned exactly AND explicitly strictly outbound
(`m.qty_delta = -quantity AND m.qty_delta < 0`). The value predicate was asserting "value must have moved",
which is not a completeness property, and relaxing it while keeping the quantity exact loses no protection.
The recorded `prosrc` digests of both guards were recomputed and `inventory_stock_source_guard_gaps()`
returns no row.

### 17.2 The premise the coordinator asked me to verify: an inbound at cost 0 IS accepted

Read from `0060`'s inbound branch rather than from a document. The only gate on the cost is
`IF v_snapshot < 0 OR v_snapshot <> trunc(v_snapshot, 10) OR v_snapshot >= c_value_limit`
(`0060:403-405`), so **exactly 0 passes**; the value is then
`v_value := inventory_half_even(v_qty * v_snapshot, 1, 0)` (`0060:412`), which is 0. The resulting key has
`value = 0` and a derived average of 0, and the outbound branch then values a sale of it at
`-inventory_half_even(abs(qty) * 0, 1, 0) = 0`, or at `-v_level_value = 0` when it empties the key
(`0060:388-390`). So a zero-valued stock key is reachable by an ordinary adjustment and the zero-cost sale
has a real premise. Confirmed end to end as well: with the amendment in place the ZERO ARM's inbound is
accepted and the sale COMMITS, where before the amendment it was refused.

### 17.3 A consequence the amendment forced on `0078`, and a second amendment to `0077`

C-09 step 7 says the header is inserted `with binding_source_id = id`. **That cannot be unconditional once
the zero arm is real.** A zero-cost sale owes no `sale` entry, so a `binding_source_id` written at insert
time leaves the deferred `sales_binding_fk` pointing at a binding nobody posts, and the COMMIT fails with
`23503` — measured: it refused the lawful sale, not an unlawful one.

The obligation is conditional on a number no row holds, and the movements that carry it cannot exist before
the header, because `sale_items_sale_fk` and the bridge's line FK are both immediate. So:

- `0078` inserts the header with **no** binding, learns the cost at a new step 9b from the movements it has
  just written, and sets the binding **exactly when that cost is non-zero**;
- `0077`'s `sale_header_guard()` is amended to admit that one transition and no other — a confirmed sale's
  `binding_source_id` is **SET ONCE**, from NULL to the sale's own id. It may not change to another value,
  may not return to NULL, and may not be set on a row that already carries one, so the binding of a posted
  sale is still final (`P4-AL-10`). `sales_binding_identity_ck` pins the value independently and the
  deferred `sales_cogs_owed` decides at COMMIT, against the ledger, whether the final state was the owed
  one.

This is the part of the fork that was not visible from either direction until the arm was actually
reachable, and it is why the weakened `sales_binding_owed_ck` is now justified by something: a committed
sale with a NULL binding is a real, lawful row.

## 18. The deferred validators judge the row at COMMIT, not their own `NEW`

### 18.1 The defect, as a mechanism rather than a symptom

A `DEFERRABLE INITIALLY DEFERRED` constraint trigger's `NEW` is the tuple of **its own event**, captured
when that statement ran — **not** the row as it stands at COMMIT. One row INSERTed and then UPDATEd in one
transaction queues **two** deferred events whose `NEW` tuples disagree. The coordinator measured it on a
two-column scratch table with the same trigger shape: one transaction, `INSERT (1, NULL)` then
`UPDATE SET b = 7`, each event recording both what it saw and what the row then held, giving
`INSERT NEW.b=NULL current=7` / `UPDATE NEW.b=7 current=7`.

§17.3's step 9b is exactly that shape: `0078` inserts a confirmed header with no binding and sets the
binding afterwards. So `sales_cogs_owed()`, reading `NEW.binding_source_id`, refused a **lawful** non-zero
sale on the INSERT event while the row by then carried its binding. The 403 that surfaced was
`apps/api/src/common/error.filter.ts:112` rendering an unparsed `P0001` as FORBIDDEN; the real message was
`selling.sale_cogs_owed: a committed sale whose goods carry value owes a COGS entry, and this one has none`.

### 18.2 The fix: `NEW` for the KEY alone

Both `sales_cogs_owed()` and `sales_walkin_no_ar()` now use `NEW` only to name the row and re-read the
judged state from `sales` by `(business_id, id)`, with `IF NOT FOUND THEN RETURN NULL` for the row deleted
in the same transaction. That makes the two events **idempotent** — both reach the same verdict about the
same row — which is what a deferred validator is supposed to be.

It closes a second hole in the same move. The `draft` early exit is now taken from the re-read as well: a
sale inserted as a draft and confirmed in one transaction was judged by the INSERT event on
`NEW.status = 'draft'` and walked out of the law entirely.

`sales_walkin_no_ar()` was **lenient**-stale rather than wrongly-refusing, because its early exit is
`binding_source_id IS NULL`: the INSERT event walked out and the UPDATE event happened to reach the right
answer. That is luck, not construction, and luck changes when the writer changes.

### 18.3 What is NOT the fix

Narrowing either trigger to `AFTER UPDATE` only. An INSERT that lands a confirmed sale in one statement
must still be judged, and `0078`'s replay and zero-cost paths are exactly that.

The two `journal_entries_*` validators need no change and now say so in a comment: they are `AFTER INSERT`
only on `journal_entries`, which is append-only, so no second deferred event for the same row can exist and
their `NEW` cannot be a stale snapshot. What they read **through** that key is read by query at COMMIT, as
the staleness problem requires.

### 18.4 The law that pins the construction: `0077-E(9c)`

For each of the two triggers the migration strips `--` comments from `prosrc` — *a law that reads its own
prose is a law about its prose*, which is how the first attempt failed, on the explanatory comment quoting
`NEW.b` — then asserts the body contains `FROM public.sales s` and
`WHERE s.business_id = NEW.business_id AND s.id = NEW.id`, and that **no** `NEW.<column>` other than
`business_id` and `id` appears anywhere in it. The contrast half asserts
`journal_entries_sale_complete` and `journal_entries_invoice_complete` are still `tgtype = 5`
(ROW|AFTER|INSERT), so the comment above cannot quietly stop being true.

The ledger-backed performed proof is `tests/integration/sale-s2-cogs-owed.test.ts`'s NON-ZERO ARM, which
commits a real sale through the real routine — demonstrably red before this amendment, green after. A
migration-time performed proof of the same thing is not available: it would have to COMMIT a sale without
the ledger that `sales_cogs_owed` consults, and any surviving `sales` row would trip the deferred
validators at the migration's own COMMIT. `0077-E(9c)` is the strongest claim a migration can make here.

### 18.5 The series lock is a LOCK privilege, narrowed to one column

Every PostgreSQL locking clause needs `UPDATE` — `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and
`FOR KEY SHARE` alike — but the privilege is satisfied by `UPDATE` on **any one column**, which is why
`0045:399` lets `daftar_accounting_internal` lock `businesses` through `UPDATE (financial_started_at)`
alone. `0078` first took a table-level `UPDATE ON invoice_sequences`, and Agent F's re-expressed
`tests/security/inventory-db-authority.test.ts` was right to call it: beyond the accepted prefix this
principal must hold no table-level `UPDATE`, because a lifecycle change belongs to columns somebody granted
**by name**. A table-level grant also hands this writer the authority to rewrite a merchant's
`number_format`, which no law here rests on.

It is now `GRANT UPDATE (updated_at) ON invoice_sequences`. `updated_at` is the lifecycle column — the one a
legitimate rewrite of the series would touch — and the narrowest grant that still carries the lock. The
series row is **locked and never written** (`R-P4-S2-78-03`: `invoice_sequences` holds no counter, so there
is nothing on it to advance), and `0078-E(5)` already proves the routine's body writes it nowhere.
`0078-E(7)` now proves the privilege itself cannot be used for more: it requires the column privilege,
**refuses** a table-level `UPDATE`, and refuses a column grant naming anything but `updated_at`.

The one failure that survived Agent F's work was then the in-scope half of the same map:
`0078` grants `SELECT ON product_translations`, a read on a relation already inside the accepted prefix,
needed because `0036` normalized product names out of `products.translations` and no inventory routine had
wanted a product NAME before. That map is a measurement of the LIVE privileges over the frozen prefix
rather than a frozen literal, so the new read belongs in it, named — which is exactly what makes an unnamed
one visible.

### 18.6 Two more `P4-AL-88` re-expressions `0078` forced, in suites Agent F had already touched

Both survived Agent F's pass, so by the coordinator's rule they are mine. Both are the same mistake in
different clothes: a sentence about the accepted prefix written as a sentence about the live catalogue.

**`tests/security/phase3-s8-operation-kinds.test.ts` — "the consumers are 26 distinct routines."**
`0078`'s `sale_commit` is the first consumer of `inventory_assertion_consume` a later phase owns, so the
count became 27. The sibling case above it had already been scoped by the **kinds'** provenance; this one
had not. Re-expressed in the accepted shape: the `26` kept word for word over the consumers of the
Phase 3-registered kinds (discovered from `registered_by ~ '^P3-'`, not a name list); the later phases'
half asserted positively — every kind beyond that scope still has its **one** consumer, and no routine
consumes kinds from both scopes, so the two consumer sets are provably disjoint rather than overlapping
uncounted; and a closure assertion that the two scopes together are every consumer the law accounts for.
The second half — that the law accounts for every routine which calls `inventory_assertion_consume` at all
— stays **unscoped**, because that is the security claim and it was never a closure rule.

**`tests/security/search-path-shadowing.test.ts` — two cases, both naming `sale_commit`.**

1. *"no runtime role holds EXECUTE through a membership either"* compared each runtime role's **effective**
   privilege against `EXECUTE_MATRIX`, a frozen declaration of the prefix's routines. So `0078`'s direct
   `GRANT EXECUTE … TO daftar_app` — exactly what C-09 and the `purchase_receive` precedent require — was
   reported as a leak. The §H case above it even asserts this case is "UNSCOPED, so it reaches these
   routines as laws already", which is true of the PUBLIC case and **false** of this one. Re-expressed: the
   matrix comparison kept word for word in scope, and beyond the prefix the case asserts what its own name
   says — a runtime role may hold `EXECUTE` only when it is itself a **named grantee**, so an effective
   privilege with no direct grant behind it came through a role membership and is named. The §H case
   independently confines who a beyond-prefix grantee may be, so nothing is lost.

2. *"no body builds SQL at run time or creates a session relation"* scanned raw `prosrc` for
   `\bEXECUTE\b`, and `sale_commit`'s body explains in a comment that its customer advisory lock is one
   "PUBLIC may execute". The law convicted a routine of dynamic SQL for a word in its prose — the same
   defect `0077-E(9c)` hit, and the estate already has the answer: `lexBody`, the recogniser
   `phase3-s8-operation-kinds` uses for exactly this, which strips `--` comments and string literals
   first. The filter now reads the lexed **code**, and two planted assertions keep the lexer honest: it
   must still see a real `EXECUTE` and must not see one in a comment — because a recogniser that returned
   the empty string for every body would pass this law in silence, which is the vacuous-pass failure mode
   the estate refuses.
