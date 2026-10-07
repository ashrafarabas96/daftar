# P4-S5 PREPARATION — refunds and credit notes, measured against the live tree

**Status: DESIGN AND OBLIGATIONS ONLY. No migration, no product code, no test file is
added by this document.** P4-S4 has not sealed. The standing rule — *do not integrate
future-slice product code before its predecessor seals* — is obeyed literally here: the
one deliverable is this page.

Every claim below carries a `file:line` into the tree at
`phase/4-sales-pos-customers-receivables` (`c6909b5`, migrations `0074`–`0086` on disk) or
real output from running the gate's own exported devices over that tree. Where a document
and the code disagree, **the code is the fact** and the disagreement is recorded as its
own line.

---

## 0. HEADLINE — four places where the measurement contradicts the brief that commissioned it

These are stated first because the measurement, not the framing, is the deliverable.

1. **Three routines refuse a refund drawn on a customer credit, not two — and the one that
   refuses FIRST was not among the two.** `customer_credit_guard()`
   (`infrastructure/database/migrations/0081_phase4_customer_payments_credits.sql:1070`) is a
   `BEFORE UPDATE` trigger function that refuses the decrement itself, at statement time,
   before `customer_credit_consume` or `customer_credit_verify` is ever reached. §2 names all
   three in firing order.

2. **S5 must NOT drop the level `UNIQUE`; it must not COPY the supplier one.** `P4-AL-22`
   (`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-537`) requires *both* devices on every consumable
   Phase 4 source — "the payment, **the credit note**, the customer credit" — so a credit
   note arriving without one contradicts an accepted lock. What cannot be replicated is the
   SHAPE: `supplier_refunds_level_uq`
   (`infrastructure/database/migrations/0067_payment_methods_supplier_settlement_sources.sql:491`)
   is `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` over a
   `credit_note_id UUID NOT NULL` (`0067:465`). S5's `refunds` has **two nullable sources**
   (`credit_note` XOR `customer_credit`, `TL-P4-S5-R1`), and in PostgreSQL a `UNIQUE` is
   `NULLS DISTINCT` by default — nothing in this tree ever writes `NULLS NOT DISTINCT`
   (one mention, as a comment, at `infrastructure/database/migrations/0005_catalog.sql:74`).
   So the copied constraint is **vacuous for exactly the half of the refunds drawn on the
   other source**. §4.

3. **The brief's estate-cost model is the pre-`P4-AL-88` one and no longer describes this
   tree.** The "27 → 30 → 32" class of failure — an accepted suite making a claim about the
   phase that follows it — has been *structurally eliminated*:
   `tests/security/phase4-forward-evolution.test.ts:31-40` asserts the property over every
   suite in the permanent estate, discovered from disk, and
   `tests/security/settlement-s6-no-customer-payments.test.ts` — the one file that literally
   names `refunds`, `credit_notes` and `customer_refunds` (`:71-79`) — was re-expressed to be
   scoped to the Phase 3 prefix's own files (`:146-161`), so **it does not go red when S5
   creates `refunds`**. What S5 actually pays is a different, enumerable bill: the
   *discovery-based* laws acquire new subjects the day the migration lands. §5 lists them.

4. **Line numbers in the brief are one off and one enumeration is wrong in a second way.**
   The stale S5 row is `docs/PHASE_4_EXECUTION_PLAN.md:324`, not `:323` (`:323` is the S4
   row). And `P4-AL-20` is not merely mismatched on one name: it enumerates **six** source
   types, three of which are already contradicted by the live registry, and the live registry
   already holds a **seventh** it never enumerated. §3.

---

## 1. The refund device that already exists, and exactly what it refuses

### 1.1 The five exports, read from `scripts/phase4-s1-gate.ts`

| export | `file:line` | what it is |
|---|---|---|
| `REFUND_SUPPLIER_EXCLUSION` | `scripts/phase4-s1-gate.ts:1254` | `/(^\|_)(supplier\|suppliers\|purchase\|purchases\|vendor\|vendors)(_\|$)/i` |
| `REFUND_VOCABULARY` | `:1255` | `/(^\|_)refunds?(_\|$)/i` |
| `isRefundRelation` | `:1258` | `REFUND_VOCABULARY.test(name) && !REFUND_SUPPLIER_EXCLUSION.test(name)` |
| `refundMention` | `:1271` | the FIRST refund relation an arbitrary text mentions, found by scanning `/[A-Za-z_][A-Za-z0-9_]*/g` identifiers, or `null` |
| `mentionsRefundRelation` | `:1274` | `refundMention(text) !== null` |

Two further exports are the law's other half and must be read with them:
`INVOICE_REDUCER_VOCABULARY` (`:1237`) — the anchored set seam `S-P4-03` uses to discover
relations whose existence `invoice_outstanding` must READ — and
`RECEIVABLE_READER_VOCABULARY` (`:1281`), `/(^|_)(outstanding|receivable|aging|settlement_state)($|_)/`,
which discovers the reader family by name.

### 1.2 What it refuses today, measured by running it

Run over this tree (`npx tsx` against the module's own exports):

```
refunds                      isRefundRelation=true   reducer=false  financialCore=true
refund                       isRefundRelation=true   reducer=false  financialCore=false
customer_refunds             isRefundRelation=true   reducer=false  financialCore=false
pos_refunds                  isRefundRelation=true   reducer=false  financialCore=false
refund_lines                 isRefundRelation=true   reducer=false  financialCore=false
credit_note_refunds          isRefundRelation=true   reducer=false  financialCore=false
customer_refund_allocations  isRefundRelation=true   reducer=false  financialCore=false
supplier_refunds             isRefundRelation=false  reducer=false  financialCore=false
purchase_refunds             isRefundRelation=false  reducer=false  financialCore=false
refunded_amount_minor        isRefundRelation=false  reducer=false  financialCore=false
credit_notes                 isRefundRelation=false  reducer=true   financialCore=true
credit_note_items            isRefundRelation=false  reducer=false  financialCore=true
credit_note_applications     isRefundRelation=false  reducer=true   financialCore=false
customer_credit_notes        isRefundRelation=false  reducer=true   financialCore=false
mentionsRefundRelation('FROM public.refunds r')  = true
refundMention('JOIN credit_note_refunds')        = 'credit_note_refunds'
/\brefunds\b/.test('customer_refunds')           = false
```

**Refuses:** any relation whose name carries `refund` or `refunds` as a token, in any
position, singular or plural, named anywhere in the *executable* body of any routine that
reads the derived receivable — including inside a string literal, because
`EXECUTE 'SELECT … FROM public.refunds'` is a read (`:1437-1452`).

**Deliberately allows:** the supplier chain (`supplier_refunds`, `purchase_refunds`,
`vendor_*`) — that is Phase 3's and belongs to the supplier ledger, and the exclusion is
named with its own red proof rather than being an accident of the pattern
(`:1246-1253`, proofs at `tests/guards/phase4-refund-not-a-reducer-guard.test.ts:253-268`).
It also allows a *comment* mentioning a refund: every body arrives through `phase4Sql`
(`:574`), which strips comments first, and the law **asserts that precondition** instead of
assuming it (`:1413-1424`) — so a comment can neither satisfy nor fail the law.

### 1.3 The two traps, confirmed in the code's own words

- **`_` is a word character, so no `\b` pattern can match a relation name by one token.**
  `/\brefunds\b/` does not match `customer_refunds` (measured above). The gate records the
  same finding at `:1222-1235` and `:1263-1270`: the earlier prefix-list regex missed
  `pos_refunds`, `refund_lines`, `customer_refund_allocations` and every singular, and
  `customer_refunds` — "the exact mirror of the existing `supplier_refunds`" — left the
  permanent negative proof **vacuous against the likeliest name**.
- **A token rule cannot match inside free text.** `public.refunds` is only found because the
  device scans IDENTIFIERS and `.` terminates one (`:1265-1270`). This is why **names and
  bodies share one scanner**: `refundMention` is the single device, so a name and a body are
  judged by the same rule, and there is no second copy to drift.

### 1.4 S5 is the first tree this law will ever have a true subject in

`invoiceReducerProblems` (`:1304`) is non-vacuous by construction and its subject set is
discovered twice over — by NAME (the family) and by DEPENDENCY to a FIXPOINT (`:1380-1392`).
Measured over this tree:

```
phase 4 routines defined (distinct names): 49
family by name (4): customer_ar_aging, customer_ar_outstanding, invoice_outstanding, invoice_settlement_state
dependent by fixpoint (3): customer_apply_credit, customer_collect_payment, customer_open_invoices_page
total subjects of TL-P4-S5-R1 today: 7 of 49
unreadable bodies: 0
invoiceReducerProblems(root) = []    deferredSeamProblems(root) = []
```

Two corrections to the register while doing so:

- `docs/PHASE_4_DECISION_REGISTER.md:648-649` and the gate's own comment at
  `scripts/phase4-s1-gate.ts:1324-1325` both say **48** routines. The live count is **49**.
  The count is prose in both places, not an assertion, so nothing is red — but S5 must not
  quote 48.
- §11 (`docs/PHASE_4_DECISION_REGISTER.md:653-655`) predicted that "`0084`'s page reader of a
  customer's open invoices **would have joined** them". It has: `customer_open_invoices_page`
  (`infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql:795`)
  is in the dependent set today, by dependency, carrying none of the four name tokens.

**The trap S5 will meet, which no document records yet.** `phase4RoutineBody`
(`scripts/phase4-s1-gate.ts:1181-1197`) returns the **LAST** definition matching the NAME,
**ignoring the signature**. `invoice_outstanding` has two overloads and four definitions
across `0081`/`0083`/`0084`; the body actually read is therefore the **`UUID[]` set-based
overload** at `0084:593` — measured, the returned text begins
`CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])`. Consequence,
in both directions:

- Seam `S-P4-03` (`:1497-1518`) will stay **RED** if S5 teaches only the scalar overload
  (`0084:526`) to read `credit_note_applications` / `credit_notes`. The array overload must
  read them too.
- The refund law inspects only that one overload for `invoice_outstanding`. A refund
  subtraction planted into the scalar overload alone would be **missed**. S5 should state
  this in its own acceptance and, if it wants the hole closed, close it by reading every
  definition rather than the last — which is a change to a permanent module and therefore a
  Tech Lead item, not a silent edit.

---

## 2. The S4 routines that refuse a refund drawn on a customer credit

All three live in `infrastructure/database/migrations/0081_phase4_customer_payments_credits.sql`,
which is an S4 CANDIDATE file today and becomes frozen on acceptance. **A `CREATE OR REPLACE`
of a routine shipped by a frozen migration is done in a NEW migration, never by editing the
frozen file.** S5 owns no migration number; it states the obligation and the single migration
owner writes it.

In the order a refund would actually meet them:

### 2.1 `customer_credit_guard()` — `0081:1070` — refuses first

The `BEFORE INSERT OR UPDATE OR DELETE` trigger function on `customer_credits`
(trigger at `0081:1285-1287`; the function's own owner line is `0081:1303`). An `UPDATE` survives only through the one accepted shape at
`0081:1090-1117`: every column identical, `remaining_amount_minor` strictly decreasing,
`remaining_carrying_base_amount_minor` equal to `supplier_credit_remaining_carrying(...)` of
the new remaining — **and then a backing row must already exist**:

```
1107:     SELECT count(*) INTO v_n
1108:     FROM customer_credit_applications a
1109:      WHERE a.business_id = OLD.business_id AND a.credit_id = OLD.id
1110:        AND a.credit_remaining_before_minor = OLD.remaining_amount_minor
1111:        AND a.credit_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
...
1114:     IF v_n = 1 THEN RETURN NEW; END IF;
1118:   RAISE EXCEPTION 'customer_credit.immutable: a customer credit changes only by one backed consumption of both remaining values'
```

A refund drawn on a customer credit writes **no `customer_credit_applications` row** — by
`TL-P4-S5-R1` it names no invoice and is not an invoice reducer — so `v_n = 0` and `0081:1118`
refuses. This is the first refusal, and it fires at statement time.

**What the replacement must preserve:** DELETE still impossible (`:1074-1076`); INSERT still
only from the command's own transaction and born whole (`:1077-1088`); the UPDATE still
column-for-column immutable except the remaining PAIR; the remaining pair still moving only
DOWN and only to the exact `supplier_credit_remaining_carrying` value; and the decrement
still **backed by exactly ONE row, never two**. The replacement widens the backing set from
one relation to the union `{customer_credit_applications, <the S5 refund relation>}`, keeping
`count(*) = 1` over the union — not `>= 1`, and not one count per relation, because two
backing rows for one decrement is the double-consumption this guard exists to refuse.

### 2.2 `customer_credit_consume(UUID, BIGINT, BIGINT)` — `0081:1224` — refuses twice

```
1230:   v_actor := inventory_assertion_current(ARRAY['customer.apply_credit']);
1231:   IF … OR NOT EXISTS (SELECT 1 FROM customer_credit_applications a
1233:                        WHERE a.business_id = v_actor.business_id AND a.credit_id = p_credit_id
1234:                          AND a.credit_remaining_before_minor = p_remaining_before AND a.credit_amount_consumed_minor = p_consumed
1235:                          AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id()) THEN
1236:     RAISE EXCEPTION 'inventory.source_type_not_authorized: a customer credit is decremented only for its own application stored by this transaction'
```

Two independent refusals of a refund: the **operation assertion** at `:1230` admits only
`customer.apply_credit`, so a `customer.refund`-asserted transaction is refused there; and the
**backing-row existence** at `:1232-1235` is again over `customer_credit_applications` alone.

**What the replacement must preserve:** it is the R-90 ONE writer of the remaining pair —
internal-owned `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC` (`0081:1263`), owner
`daftar_inventory_internal` (`0081:1306`), pinned `search_path` (`:1225`); its **first
statement** is the assertion re-read whose arguments call nothing (`:1230`); the optimistic
`UPDATE … WHERE c.remaining_amount_minor = p_remaining_before` with `GET DIAGNOSTICS` and the
`v_rows <> 1` refusal (`:1239-1250`); and the new remaining carrying computed by
`supplier_credit_remaining_carrying` from the ORIGINAL pair, never from an already-rounded
value. The replacement adds `customer.refund` (or whatever `0054:229`-legal op code S5
registers) to the asserted array and widens the backing-row existence to the same union as
§2.1. It must not relax the single-row and single-level conditions.

### 2.3 `customer_credit_verify(UUID, UUID)` — `0081:879` — refuses at COMMIT

Its consumers CTE reads **one relation**:

```
893:   WITH consumers AS (
894:     SELECT a.credit_remaining_before_minor AS rb, a.credit_amount_consumed_minor AS amount,
895:            a.credit_carrying_base_released_minor AS rel
896:     FROM customer_credit_applications a
897:     WHERE a.business_id = p_business_id AND a.credit_id = p_credit_id
```

and refuses when the chain does not reconcile to the stored pair:

```
912:   IF v_bad > 0 OR v_sum > v_c.original_amount_minor
913:      OR v_c.remaining_amount_minor::numeric <> v_c.original_amount_minor - v_sum
...
918:     RAISE EXCEPTION 'customer_credit.consumption_inconsistent: the credit''s consumers do not chain from its original to its stored remaining values'
```

A refund that consumed credit would leave `remaining = original − Σ(applications) − refund`
while `v_sum` counts applications only, so `:913` is false and `:918` raises. `0081:877-878`
already says so in its own comment: *"with S4's one consumer relation; S5's refund adds one
UNION ALL branch."*

**What the replacement must preserve:** every element of the chain law, unchanged — consumers
ordered by `rb DESC, amount` with the `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`
window (`:900`); `rb = original − Σ earlier`; `amount <= rb`; each `rel` equal to the
difference of two `supplier_credit_remaining_carrying` calls (`:903-908`); `Σ amount <=
original`; the stored remaining `= original − Σ amount`; the stored carrying `= g(stored
remaining)` and never `g` of a previous rounded step; and `Σ rel = original_carrying −
remaining_carrying`. The replacement is the `UNION ALL` branch inside `consumers` and nothing
else, with the refund's own three columns mapped onto `rb`/`amount`/`rel`. It is still
`SECURITY DEFINER`, still internal-owned (`0081:1298`), still `REVOKE ALL … FROM PUBLIC`
(`0081:1255`).

### 2.4 Two more `CREATE OR REPLACE`s S5 owes, found in the same read

- **`accounting_reversals_20_domain_source_guard()` — `0081:1405`.** Its `source_type IN (…)`
  list at `0081:1412` names thirteen types. `P4-AL-47` and seam `S-P4-02`
  (`scripts/phase4-s1-gate.ts:1483-1495`) require a registration and this list to move
  together. The moment S5 registers its source types, this routine must be replaced to name
  them, or `daftar_app` can reverse an S5 entry through the generic path. `0081:1398-1402`
  states the handover explicitly. Note the surrounding `SET LOCAL ROLE
  daftar_accounting_internal` / `RESET ROLE` (`0081:1403`, `:1437`) — the replacement runs in
  the same authority.
- **`invoice_outstanding` — both overloads, `0084:526` and `0084:593`.** `credit_notes`,
  `credit_note_applications`, `customer_credit_notes`,
  `customer_credit_note_applications`, `credit_note_allocations` and
  `customer_credit_note_allocations` are all in `INVOICE_REDUCER_VOCABULARY`
  (`scripts/phase4-s1-gate.ts:1237`), so creating any of them turns seam `S-P4-03` RED until
  the reader reads it BY NAME. `0081:1326-1333` records that the subtraction is a `UNION ALL`
  over a SET of reducer relations precisely so that "P4-S5 appends one branch rather than
  rewriting it", and that `invoice_settlement_state`, `customer_ar_outstanding` and
  `customer_ar_aging` need **no change at all** because they compose over this one. Read
  §1.4 before writing it: the law reads the LAST definition by name.

---

## 3. Three documents that are already stale, with what the code actually holds

### 3.1 `docs/PHASE_4_EXECUTION_PLAN.md:324` — the S5 migration row omits `credit_note_applications`

Live text (`:324`): `| S5 | `credit_notes`, `credit_note_items`, `refunds` with the
one-non-null-source `CHECK`; the `credit_note` and `refund` source types |`.

**The brief cited `:323`; that is the S4 row. The S5 row is `:324`.**

The omission is load-bearing, not cosmetic. `docs/PHASE_4_DECISION_REGISTER.md:280-283`
records **three** relations as absent and needed by the owed financial test — `refunds`,
`credit_notes` **and `credit_note_applications`** — and `INVOICE_REDUCER_VOCABULARY`
(`scripts/phase4-s1-gate.ts:1237`) names `credit_note_applications` as a REDUCER. A plan that
does not list it invites an S5 that reduces AR by writing to `credit_notes` directly, with no
per-invoice application row and therefore no level chain. Verified absent across the whole
tree: the only `CREATE TABLE` matches for the family are `supplier_credit_notes`
(`0065:255`), `supplier_refunds` (`0067:460`), `customer_credits` (`0081:371`) and
`customer_credit_applications` (`0081:438`). **`refunds`, `credit_notes`,
`credit_note_items` and `credit_note_applications` do not exist at any prefix `0000`–`0086`.**
(The register says "`0000`–`0082`" at `:280-283` because it was written at that head; the
statement still holds at `0086`.)

### 3.2 `docs/PHASE_4_EXECUTION_PLAN.md:187-188` — the S5 scope paragraph, same omission

Live text (`:187-188`): *"**Scope.** `credit_notes`, `credit_note_items`, `refunds`; revenue
reversed exactly once; the cap check inside the source's `FOR UPDATE`; `refunds` with exactly
one non-null source and no column that could name a payment."*

Same correction: the application relation is missing. The rest of the sentence is consistent
with the ruling and should be kept — in particular *"no column that could name a payment"* is
the structural half of `TL-P4-S5-R1` ("it carries no `payment_id`"), and *"exactly one
non-null source"* is the `credit_note` XOR `customer_credit` half.

Two further corrections to the same file, so S5 does not build from them either:

- `:330` still says *"`0000–0073` stay immutable byte for byte"*, and `:19` records
  *"migrations | 74, `frozenThrough = 0073_…`, no `0074`"*. Both are the P4-S0 state. The
  accepted floor has moved: `:144` itself records `frozenThrough =
  0078_phase4_sale_commit.sql`, and `0074`–`0086` are on disk. `frozenThrough` is a FLOOR and
  never retreats (`scripts/phase4-s1-gate.ts:1754-1759` refuses any `frozenThrough` equality
  as a shape). **S5 treats `0000`–`0079` as immutable and `0080`–`0086` as S4's candidates
  that are not S5's to touch.**
- `:324`'s own neighbours still describe S5 as "Blocked by. Nothing" (`:191`). That was true
  of the plan's dependency graph, not of the integration rule; S5 remains blocked on S4
  sealing for anything but this page.

### 3.3 `P4-AL-20`'s six-source-type enumeration — `docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478`

Live text: *"**P4-AL-20 — Phase 4 registers six new accounting source types …** `sale`,
`invoice`, `payment_allocation`, `credit_note`, `refund`, `allocation_reversal`."*

What the live registry holds, read from the `INSERT INTO accounting_source_types` statements
in the Phase 4 migrations (the only two are `0077:1701` and `0081:2467`):

| registered | `file:line` | `sort_order` |
|---|---|---|
| `sale` | `0077:1702` | 13 |
| `invoice` | `0077:1703` | 14 |
| `customer_payment_allocation` | `0081:2468` | 15 |
| `customer_credit_application` | `0081:2470` | 16 |
| `customer_credit` | `0081:2472` | 17 |

So the enumeration is wrong in three ways:

1. `payment_allocation` is **not** the live name. It is `customer_payment_allocation` — and
   the S4 gate pins that spelling as RULED:
   `scripts/phase4-s4-gate.ts:577` is
   `['customer_payment_allocation', 'customer_credit_application', 'customer_credit']`, and
   `:865-870` refuses a settlement text that does not register each of the three.
2. **`customer_credit` is a live source type `P4-AL-20` never enumerated** — "the surplus is a
   source in its own right, not a tail on an allocation entry" (`0081:2456-2458`). Phase 4
   will therefore register at least **seven**, not six.
3. The naming convention the live rows establish is explicit and S5 must follow it rather than
   the lock's words: the op codes are `customer.*` because `inventory_payload_digest` forbids
   an underscore in the first segment (`0054:229`, probed at `0074:62-70`), while the SOURCE
   TYPES are the row's own domain, singular, in a different namespace — "which is why the two
   deliberately differ" (`0081:2460-2465`). S5's types are therefore to be read as
   `customer_credit_note`-shaped, not the lock's bare `credit_note`/`refund`, and whichever
   spelling the Tech Lead rules, **the lock's enumeration is not the authority**.

A fourth staleness, found in the gate rather than a document, which S5 must close:
`FINANCIAL_CORE` (`scripts/phase4-s1-gate.ts:504-505`) already names `refunds`, `credit_notes`
and `credit_note_items` — but **not** `credit_note_applications` (measured in §1.2). The
GOLD-74 polymorphic-reference check (`:1565-1577`) applies only inside `FINANCIAL_CORE`, so
the application relation would arrive uncovered while `INVOICE_REDUCER_VOCABULARY` already
treats it as a reducer. Adding the name is a one-token edit to a permanent module and belongs
in S5's own change, with its red proof.

---

## 4. What S5 must NOT replicate — the level `UNIQUE`, read from the code

### 4.1 What the code actually requires

`P4-AL-22` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-537`) is titled *"Level-uniqueness is
necessary and not sufficient. The sufficient mechanism is a COMMIT-time chain verifier, and
Phase 4 must build both"*, and `:528-530` names the sources: *"each consumable Phase 4 source
— the payment, **the credit note**, the customer credit — carries **both**"*. So **"S5 should
not replicate the level `UNIQUE`" is not what the tree says.** Dropping it would contradict an
accepted lock.

S4 built exactly that pair: `payment_allocations_level_uq` (`0081:334`),
`customer_credit_applications_level_uq` (`0081:470`),
`customer_credit_applications_invoice_level_uq` (`0081:474`), each explicitly documented as
*"a FAST PER-RELATION BACKSTOP and not the invariant"* (`0081:327-333`), with the
cross-relation guarantee resting on `invoice_settlement_verify` and `customer_credit_verify`;
and `0081:2661-2673` asserts all three exist from the live catalogue.

### 4.2 What must NOT be replicated, and why, from the two recorded lessons

**Lesson one — a `UNIQUE` identity proves no duplicates and nothing about EXISTENCE.**
`[[daftar-a-unique-tuple-is-not-a-source-proof]]`, stated at `0077:510-513`: *"A binding row
that names no bridge row is a movement with no source line, which is the one thing a unique
tuple cannot refuse."* And at the lock, `:522-525`: *"A `UNIQUE` over a declared remaining
level forbids two rows claiming the same level; it does not cap total consumption, because a
direct SQL attacker simply declares a different level."*

**Lesson two — it silently caps an operation that legitimately needs several rows at one
level.** `docs/PHASE_4_ARCHITECTURE_LOCK.md:533-537`: *"Its known cost is recorded honestly …
a future operation that needs several rows at one level must change the mechanism, not drop
the constraint."*

Put together with the shape of S5's `refunds`, three things must not be replicated:

1. **Not the single-source column shape.** `supplier_refunds_level_uq` (`0067:491`) works
   because `supplier_refunds.credit_note_id` is `UUID NOT NULL` (`0067:465`) — one mandatory
   source. S5's `refunds` has two nullable sources by ruling. A `UNIQUE (business_id,
   credit_note_id, credit_remaining_before_minor)` over a nullable `credit_note_id` is
   `NULLS DISTINCT` (this tree never writes `NULLS NOT DISTINCT`; the sole mention is a
   comment at `0005:74`), so **every customer-credit refund has a NULL in the key and no two
   of them ever collide.** The constraint would be green, vacuous for half its subjects, and
   that is the false green `[[daftar-a-green-gate-must-prove-it-can-be-red]]` exists for. The
   level constraint must therefore be expressed so that each source is covered — and whichever
   way it is expressed, the per-source coverage must be asserted with a red proof per source,
   not once for the table.
2. **Not the invoice-side level `UNIQUE`.** `customer_credit_applications_invoice_level_uq`
   (`0081:474`) is `(business_id, invoice_id, ar_released_before_txn_minor)`. A refund **names
   no invoice** (`TL-P4-S5-R1`), so there is no invoice level to be unique in; a column added
   to carry one would be the second AR reduction the ruling forbids, expressed as a key.
3. **Not the constraint as the bound.** The COMMIT-time chain verifier is the sufficient
   mechanism, and for the refund that verifier is the widened `customer_credit_verify` of §2.3
   plus its credit-note twin. `gate:phase4:s4` already asserts the verifier **against direct
   SQL bypassing the routine** with a red proof that inserts at a fabricated level
   (`docs/PHASE_4_ARCHITECTURE_LOCK.md:530-532`); S5 owes the same against its own relations.

---

## 5. The estate cost of S5's first relation — what will actually go red

The brief's model (a large number of accepted assertions going red across permanent files)
describes the pre-`P4-AL-88` estate. Measured: that class has been removed. The forward-
evolution suite (`tests/security/phase4-forward-evolution.test.ts`) asserts, over every suite
in the permanent estate discovered from disk, that four claim shapes are future claims and
are absent — an absolute `to_regclass … toBeNull` for a Phase 4 relation, a "no relation
whatever matches" catalogue query, a 404 for a Phase 4 route, and an exact-equality over a
catalogue set selected by a Phase 4 vocabulary filter (`:30-40`). The one file that names S5's
relations by hand is already re-expressed and will NOT go red (§0 item 3, verified at
`tests/security/settlement-s6-no-customer-payments.test.ts:146-161` and `:208-215`).

What WILL speak the day the migration lands is the set of laws whose subject is *defined* as
"every Phase 4 relation" or "whatever exists". The budget is this list, and — exactly as the
brief says of counts — **it is a floor**, because a full-estate run reveals only the FIRST
failing assertion per test body.

### 5.1 Tree-wide relation sweeps that acquire S5's relations as new subjects

| law | `file:line` | what it will demand of each new relation |
|---|---|---|
| RLS/FORCE discovery, declared + live halves | `scripts/guards/phase4-rls-force.ts:364`, `:386`, `:417` | `tenant_id`, `business_id`, `ENABLE` **and** `FORCE` are EACH required; a relation declared on disk but not in the catalogue, or in the catalogue and not declared, is reported by name (`:457-465`) |
| the same, text half, over every candidate migration | `scripts/phase4-s4-gate.ts:910` (`newRelationCoverageProblems`), `:244` | S4's gate reads `candidateMigrations`, which after S4 seals names **S5's file** — so S5's first migration is judged by S4's gate on landing |
| the same, live half | `tests/guards/phase4-rls-force-guard.test.ts` | the catalogue reading, which sees a relation that reached a database by a route the text parser cannot read |
| G-3 third arm, relation NAMES | `scripts/guards/no-authoritative-balance.ts:690` (`discoverSalesTables`), `:695` (`isForbiddenSalesTable`), driven at `scripts/static-guards.ts:423-440` | no new relation may be a stored balance/summary/snapshot/rollup/cache by name |
| G-3 third arm, COLUMN names | `scripts/guards/no-authoritative-balance.ts:703` (`isAuthoritativeSalesColumn`), `:314` (`AP_BALANCE_COLUMN`), `:258` (`DERIVED_SETTLEMENT_INSTANT`) | `refunded_*`, `*_refunded`, `settled_at`, `paid_*`, `collected_*`, `allocated_*`, `outstanding_*`, `available`, `reserved` are all refused on an S5 relation. Measured: `refunded_amount_minor` is NOT a refund RELATION to §1's device but IS an authoritative-balance COLUMN here — two different laws, and S5 needs both greens |
| GOLD-74 schema lint | `scripts/phase4-s1-gate.ts:1527` (`schemaLintProblems`) | every `CHECK`/`UNIQUE`/`PK`/`FK` must name real columns, FK arities must match, and inside `FINANCIAL_CORE` a `*_id` beside a `*_type`/`*_kind` with no FK is refused as polymorphic (`:1565-1577`) |
| G-07 document numbering | `scripts/phase4-s1-gate.ts:1627`, `:1636` | a `credit_notes.credit_note_number` needs `business_id` and a TOTAL (or soft-delete-partial) `UNIQUE` including `business_id`; no `CREATE SEQUENCE`, no `serial` (`:1640-1648`) |
| seam `S-P4-03` | `scripts/phase4-s1-gate.ts:1497` | RED on the creation of any `INVOICE_REDUCER_VOCABULARY` relation until `invoice_outstanding` reads it by name — see §1.4 on which overload is read |
| `TL-P4-S5-R1` itself | `scripts/phase4-s1-gate.ts:1304` | every new routine joins the subject set by name or by dependency fixpoint; any refund relation named in any of their executable bodies is RED, string literals included (`:1437-1452`) |
| vocabulary live arm | `tests/guards/p4s4-vocabulary-live-arm.test.ts` | the same vocabulary against the live catalogue rather than the text |
| derived-truth guard | `tests/guards/phase4-derived-truth-guard.test.ts` | `isDerivedTruthRelation` (`scripts/guards/no-authoritative-balance.ts:476`) over the new names |

### 5.2 The three UNSCOPED Phase 3 laws that were deliberately left to judge Phase 4

`docs/PHASE_4_S1_ESTATE_REEXPRESSION.md:47-57` records the decision: `deviations()`,
`forbiddenPrivileges` and the by-use DML sweep were **NOT scoped**, "because they are laws
over whatever exists, and Phase 4 wants them applied to its own tables", and a new structural
law `od03Problems` was added over EVERY tax column in `public`.

| law | `file:line` | what it demands of S5 |
|---|---|---|
| `deviations()` | `tests/security/phase3-s8-grant-matrix.test.ts:228` | every live ACL grant must be a reviewed one; an UNREVIEWED grant on an S5 relation is reported verbatim |
| `forbiddenPrivileges` | `:85`, asserted `:361` | `DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE` must not be reachable by a runtime principal or PUBLIC. S5's relations need the `0081:615` shape: `daftar_app` holds `SELECT` and nothing else |
| the beyond-Phase-3 sweep | `:662`, `:674`, `:734-744` | discovered via `beyondPhase3Tables()` (`tests/helpers/phase3-surface.ts`) — S5's relations enter this set automatically |
| `od03Problems` | `:174`, catalogue read at `:146-160`, asserted `:534`, `:752` | **every column matching `(^\|_)tax(_\|$)` in `public`**, on any relation of any phase, must be `bigint`, `NOT NULL`, and carry a single-column `CHECK (<col> = 0)` unless it is one of the three pinned at `:100`. See §7 |

### 5.3 Costs that are not relation sweeps but land in the same change

- **CI chain composition.** `tests/guards/required-ci-chain-composition.test.ts:118-124`
  holds `CHAIN` as a table of four rows and states that "adding a slice to this table is the
  whole edit". The job step `name` is part of the claim. S5 adds its row, its `ci.yml` step,
  and keeps the pairwise ordering.
- **Plan-evidence contract.** `tests/performance/plan-evidence-contract.test.ts:247` requires
  every plan-gate file to be reachable from a step of the required backend job, and `:158`
  refuses a stale committed inventory. Declaring `gate:phase4:s5` in `package.json` without
  the wiring makes this red.
- **Budget ratchet.** `npm run check:budget-ratchet` (`scripts/phase4-budget-ratchet.ts`,
  law at `tests/guards/p4s4-budget-ratchet-law.test.ts`) — a new command path needs its
  measured budget, tighten-only.
- **Command refusal audit.** `tests/guards/p4s4-command-refusal-audit-law.test.ts` and
  `docs/PHASE_4_DECISION_REGISTER.md:489-583` — every refusal on an S5 command path must be
  audited by the one mechanism, not a second copy. Note `:613-638`: the audit's operation
  attribution is **for reading, not for judging**.
- **Cross-tenant golden.** `scripts/phase4-s1-gate.ts:1729` (`crossTenantProblems`, G-02)
  enumerates the suite from `discoverPhase4Routes` (`:1692`), so every S5 route must appear in
  `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts` with a real ALLOW/DENY pair.
  Read `:110-155` and `:175-220` of that file first: a POST driven as a GET is a 404 that
  looks exactly like isolation, and a read that answers `200 []` for everybody satisfies the
  generic loop while proving no isolation at all. S5's routes will need their own section, in
  the `RECEIVABLES_ROUTES` manner (`:218-224`).

### 5.4 What will NOT go red, so S5 does not budget for it

- `tests/security/settlement-s6-no-customer-payments.test.ts` — §A is scoped to
  `PHASE3_FILES` (`:146-161`) and §B's predicate requires `^(supplier_|payment_method)`
  (`:215`), so neither `refunds` nor `credit_notes` enters.
- `tests/security/phase3-s8-set-constraints-sweep.test.ts` — the catalogue equality is scoped
  by POSITION to triggers on relations the inherited prefix created (`:32-48`), explicitly so
  that a later phase's deferred guard cannot turn it red.
- `scripts/guards/read-surface.ts:121` `MERCHANT_READ_TABLES` — a list for NAMING the
  perimeter, not the rule. The rule is the `ANY_DML` statement shape (`:164-167`), which
  refuses a write to any relation whatever it is called. S4 did not add its four relations to
  the list and is green; S5 need not either.

---

## 6. The read-path obligation

The recorded lesson, in the tree's own words at
`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:129-136`: the POS slice
*"shipped a server-side basket whose only readers were its own four write commands, so a
reloaded till screen lost the basket while its rows sat in `pos_cart_lines`"*. **State whose
only reader is its own commands' return value has NO read path.**

Therefore, for S5:

1. **A credit note and a refund each get a real read route.** A merchant who issues a credit
   note and reloads must see it. `0084:795`'s `customer_open_invoices_page` is the shape the
   estate accepts for a paged read; a derived figure read through a FUNCTION in a `FROM` is
   the CORRECT read path (`tests/guards/phase4-read-surface-guard.test.ts:162`, `P4-AL-07`).
2. **The reader is the SAME GATE and the SAME PROJECTION as the write.** Not a second
   permission list and not a second shape of the row: a reader behind a weaker gate is a
   leak, and a reader behind a different projection is a second truth about the same
   document. The authority table shape to follow is `RECEIVABLES_ROUTE_AUTHORITY`
   (`receivables-permissions.ts:81-118`, cited at
   `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:175`).
3. **Its refusal set is NOT the write's.** A read refuses on absence and on authority; it does
   not inherit the write's `*_inconsistent`, `*_immutable` or `registry_incomplete` refusals,
   and it must not be documented as if it did.
4. **An empty collection is NEVER a refusal.** `200 []` is a correct answer for a customer
   with no credit note — and it is also why such a route must not be driven by a generic
   ALLOW/DENY loop: *"the generic pair would have been satisfied by a read that returned
   nothing for everybody, which proves no isolation at all"*
   (`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:192-197`). The isolation
   claim for an S5 collection read is about **CONTENTS**: under A's header the array holds A's
   own credit note and not one of A2's or B's.
5. **No read module writes anything.** `scripts/guards/read-surface.ts:166-167` refuses any
   DML statement shape in a `*-reads.ts` module, whatever the relation is called, and
   `:174-175` refuses a module-level result cache.

---

## 7. The open items S5 inherits and must not silently close

**`OD-03` — sales tax. OPEN, and the owner's alone.** `docs/PHASE_4_DECISION_REGISTER.md:21`
records it as *"the only genuinely open item in Phase 4"*, not blocking, because **structural
zero is the current contract**. `docs/PHASE_4_ARCHITECTURE_LOCK.md:941-943` (`P4-AL-45`) and
`:1654`, `:2251`, `:2369-2372` repeat it: no country's tax law is researched, guessed or
encoded; no VAT rate, inclusive/exclusive rule, threshold, exemption or legal invoice field is
inferred; sales tax is structurally zero and a non-zero sales tax is refused.

**S5 does not touch `OD-03`.** It does not research a rate, does not add a jurisdiction field,
does not add a tax line to a credit-note journal shape, and does not close the decision.

What S5 does owe is the structural zero, because it is a live, catalogue-enforced law and not
a sentence. The pattern to mirror is `invoices.tax_minor BIGINT NOT NULL DEFAULT 0 CONSTRAINT
invoices_tax_policy_absent_ck CHECK (tax_minor = 0)` (`0075:261`). And the enforcement is
tree-wide: `od03Problems` (`tests/security/phase3-s8-grant-matrix.test.ts:174`) reads **every
column matching `(^|_)tax(_|$)` on every relation in `public`** (`:146-160`) and reports a
non-`bigint`, a nullable, or one with no single-column `CHECK (<col> = 0)`, with only three
columns pinned by name (`:100`). So if S5's credit note mirrors the invoice's tax element at
all, it must mirror it as a structural zero, and if it carries no tax element it must carry no
tax-named column. There is no third option and no allowlist — "nothing is permitted by being
named, only by being structurally zero" (`:131-133`).

**The other two closed rulings, recorded here so they are not reopened.**

- **`TL-P4-RLS-INT-01`** (`docs/PHASE_4_DECISION_REGISTER.md:777`): the cross-tenant read of
  `daftar_inventory_internal` and `daftar_accounting_internal` is **INTENTIONAL**. No
  migration is written to narrow it, frozen `0052` is not modified, nothing is recorded as
  tenant-narrowing debt — intentional architecture is not technical debt. S5's internal-owned
  definers inherit this. The question that replaces it is whether an ORDINARY RUNTIME
  CREDENTIAL can reach cross-tenant data or effect THROUGH that authority, and the four-way
  matrix at `:824-831` may never be collapsed into one statement.
- **`{SEQ:6}`**: `INV-{YYYY}-{SEQ:6}` stays (`docs/PHASE_4_ARCHITECTURE_LOCK.md:2068`,
  `TL-P4-S2-R4`). The literal `{SEQ:06}` is unstorable because the frozen
  `invoice_sequences_format_ck` admits no leading zero in the width. A credit-note series, if
  S5 ships one, follows the same `invoice_sequences` mechanism — a per-business counter row
  under a lock, never a cluster-wide sequence (G-07, `scripts/phase4-s1-gate.ts:1640-1643`) —
  and is a DAFTAR identifier, not a fiscal or tax compliance claim.

---

## 8. The owed test, restated so it is not re-derived

`docs/PHASE_4_DECISION_REGISTER.md:267-285` already states it, and it is the one test S5 owes
on account of `TL-P4-S5-R1`:

> Open a credit invoice; make the accepted return/credit-note effect; verify AR falls
> **exactly once**; refund the resulting liability; verify the invoice outstanding does
> **not** fall again; verify that cash and the liability **do** move.

It is recorded as owed and not stubbed because the three relations it needs do not exist
(§3.1) and "a test written against relations the test itself created would prove the fixture
and not the system". **This document adds no test file.** S5's implementation writes it,
driving every write through the product's own commands — no `refunds`, `credit_notes` or
`credit_note_applications` row inserted by hand, on the terms
`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:198-206` sets for S4's four.

And the five ways of making the gate green that are **explicitly refused**
(`docs/PHASE_4_DECISION_REGISTER.md:287-293`): adding a comment to `invoice_outstanding`;
adding a dead SQL reference; renaming `refunds` to escape the vocabulary; making
`invoice_outstanding` read refunds; special-casing a test to green. The first three are
planted against and refused in direction C of
`tests/guards/phase4-refund-not-a-reducer-guard.test.ts`.
