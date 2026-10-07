# P4-S5 CONTRACT PACK — returns, credit notes and refunds

**Maturity: levels A–E complete. `READY_TO_PROMOTE = NO` (§13).**

| field | value |
|---|---|
| slice | P4-S5 — returns, credit notes, refunds, revenue reversal, COGS reversal, refund liability, caps, FX |
| branch | `p4s5/owner` |
| **base SHA** | **`6587460`** — `phase/4-sales-pos-customers-receivables`, "docs(p4): the live routine count, and the financial core S5 will widen" |
| migrations on disk at base | `0000`–`0086`. `0000`–`0079` immutable byte for byte; `0080`–`0086` are S4 CANDIDATES |
| migration prefix this slice will use | **UNKNOWN, and deliberately not guessed.** S5 owns no migration number. The prefix is unknowable until S4 seals, and no document, test or comment in this slice names one |
| predecessor | P4-S4 (sales / POS / customers / receivables), **in acceptance at base, not sealed.** S4 is the integration authority |
| integration authority for schema and financial truth | S4 until it seals |
| what this pack is | the contract the S5 implementation will be judged against, and the record of every assumption it makes about a tree that does not exist yet |

Companion documents, both written by this slice:

- `docs/PHASE_4_S5_DDL_SPECIFICATION.md` — level E. The DDL **specification**: four relations,
  their FK map, CHECKs, indexes, RLS, triggers, expected catalogue shape and upgrade
  expectations. **No `.sql` file. No number.**
- `docs/patch-requests/PATCH-REQ-S5-001.md` … `-007.md` — one per shared-file change S5 needs
  and may not make itself.

Required prior reading, read in full before anything here was designed:
`docs/PHASE_4_S5_PREPARATION.md` (646 lines, measured against this tree),
`docs/PHASE_4_DECISION_REGISTER.md`, `docs/PHASE_4_ARCHITECTURE_LOCK.md`,
`infrastructure/database/migrations/0081`, `0083`, `0084`, `0045`–`0047`, `0067`. **None of them
was edited.**

---

## 1. The financial laws this slice is built on

These were ruled by the owner and are not S5's to revisit. They are restated here because every
section below is an answer to one of them.

1. **A REFUND DOES NOT REDUCE AR AGAIN.** invoice → the credit-note/return effect reduces AR
   **once** → the refund consumes the liability or the credit → **AR unchanged** → cash/bank
   moves.
2. **A refund's source is EXACTLY ONE OF `credit_note` XOR `customer_credit`.** No `payment_id`
   source. No polymorphic financial foreign key — the source binds through the composite bridge
   pattern.
3. **The refund cap is checked inside the source under `FOR UPDATE`.** Modelled and proved
   against: refund vs refund, refund vs credit consumption, full vs partial, the FX cap, a
   direct-SQL attack. **No stored second truth** such as a `refunded_amount_minor` column.
4. Money is integer minor units only. Rounding is the existing HALF_EVEN contract; no rounding
   account is invented to make arithmetic balance; nothing is recomputed from a rounded average
   where exact stored deltas exist.
5. Sales tax is **structural zero** (`OD-03`, OPEN, the owner's alone).
6. ONE canonical algorithm for AR, journal posting, carrying release, inventory valuation,
   refund liability and the settlement chain.
7. Inventory is written only by the accepted stock-movement authority.
8. Every financial command carrying an idempotency key preserves the same identity and the same
   intent hash, replays exactly, and CONFLICTs on a changed intent.

### 1.1 Where each law is made STRUCTURAL rather than remembered

| law | the structure that enforces it | where |
|---|---|---|
| 1 | a refund's shape has no field that could name an invoice, and its entry's account set excludes `accounts_receivable` by a CLOSED union | `REFUND_NAMES_NO_INVOICE`, `REFUND_ENTRY_ACCOUNTS`, `assertNoReceivableLine` |
| 2 | two nullable `*_id` columns, each with a real composite FK, plus `CHECK (num_nonnulls(...) = 1)`. The kind is DERIVED, never stored | `resolveRefundSource`; DDL spec §4.2, §4.4 |
| 3 | the cap function takes the LOCKED remaining as an argument, so the question cannot be asked without the lock; no column name in the slice can carry a total | `refundCapRefusal`, `consumedSide`; `FORBIDDEN_REFUND_FIELD_NAMES` |
| 4 | the plan layer imports the four accepted primitives and contains no `HALF_EVEN`, no rounding function and no `10n ** 18n`; the COGS input shape has no quantity and no unit cost | `returns-settlement.ts`; `creditNoteCogsReversalBaseMinor` |
| 5 | one spelling of zero, through the SAME predicate the invoice uses; no tax field on the refund at all | `creditNoteTaxRefusal` → `isStructuralZeroTax` |
| 6 | the chain verifier delegates to `verifyCreditChain` and adds nothing; the liability account is decided in ONE function | `verifySourceConsumptionChain`, `refundLiabilityAccount` |
| 7 | the stock port asks the authority and reads back; it has no write method | `ReturnStockPort` |
| 8 | the intent is a CLOSED ordered field list with an explicit absence encoding, compared by pre-image | `REFUND_INTENT_FIELDS`, `refundIntentPreimage`, `refundReplayVerdict` |

---

## 2. Predecessor assumptions — what S5 assumes S4 leaves behind

Each is stated so that a **diff against the sealed tree can CONFIRM or REFUTE it**, with the
exact artefact to look at. A-prefixed ids are referenced from the rest of this pack and from the
DDL specification.

| id | assumption | how to confirm against the sealed tree | if refuted |
|---|---|---|---|
| **A-1** | `customer_credits` exists with the remaining PAIR `(remaining_amount_minor, remaining_carrying_base_amount_minor)` and the originals beside them | `\d customer_credits`; `0081:371`ff | S5's whole second source disappears. Design stops; the owner rules |
| **A-2** | `customer_credit_applications` exists and is the ONLY consumer relation of `customer_credits` at seal | `grep -c 'customer_credit_applications' <sealed 0081>`; the `consumers` CTE of `customer_credit_verify` reads one relation | if a second consumer arrived, `PATCH-REQ-S5-003`'s union has three members, not two |
| **A-3** | `customer_credits_customer_uq` is `UNIQUE (business_id, id, customer_id, currency_code)` — FOUR columns | measured at `0081:403`. Re-measure in the sealed file | the refund's `customer_credits` edge drops to three columns and loses its currency pin; DDL spec §4.4 changes |
| **A-4** | `invoices_customer_uq UNIQUE (business_id, id, customer_id)` exists, non-partial | `0082:187-203`. Re-measure | `credit_note.invoice_walkin` and `customer_mismatch` stop being structural and become routine refusals only |
| **A-5** | `invoice_outstanding` exists in TWO overloads, scalar and `UUID[]`, four definitions across `0081`/`0083`/`0084`, and both are equivalence-tested | `\df invoice_outstanding`; the S4 set-based equivalence suite | `PATCH-REQ-S5-003`(d)(e) changes shape. If a third overload arrived, it must be taught too |
| **A-6** | the AR subtraction inside `invoice_outstanding` is a `UNION ALL` over a SET of reducer relations, so S5 APPENDS one branch | `0081:1326-1333` says so. Read the sealed body | S5 would have to rewrite the reader rather than extend it — a far larger change, and the owner should know before it is attempted |
| **A-7** | `invoice_settlement_state`, `customer_ar_outstanding` and `customer_ar_aging` compose over `invoice_outstanding` and need NO change | `0081:1326-1333`. Read each sealed body for a direct reducer read | each one that reads a reducer directly is one more `CREATE OR REPLACE` S5 owes |
| **A-8** | `customer_credit_guard()`, `customer_credit_consume()` and `customer_credit_verify()` exist with the signatures and refusal texts the preparation page measured | `0081:1070`, `:1224`, `:879`. Re-measure line by line | `PATCH-REQ-S5-003` is rewritten against what is actually there |
| **A-9** | `accounting_source_types` holds exactly five Phase 4 rows at `sort_order` 13–17, the last being `customer_credit` (17), for seventeen types in all (see A-22) | `SELECT source_type, sort_order FROM accounting_source_types ORDER BY sort_order` | S5's 18/19/20 shift. The sort order is not load-bearing, but the spelling convention is |
| **A-10** | `accounting_reversals_20_domain_source_guard()` names THIRTEEN source types | `0081:1412`. Count the sealed list | the number in `PATCH-REQ-S5-002`'s expected diff changes; the obligation does not |
| **A-11** | the chart of accounts holds `sales_returns` (4100), `customer_refund_liability` (2200) and `customer_credit_liability` (2210), and the registry is CLOSED at 21 | `0040:45-66` and the `DO $$` count at `0040:70-78` | S5 cannot post. It would need a chart change, which is a Phase 2 frozen file and therefore an owner decision |
| **A-12** | `0081:1594` DEBITS `customer_credit_liability` when a credit is consumed | re-read the sealed expected-shape builder | the refund-on-a-credit entry's direction is wrong and the whole §5 shape is re-derived |
| **A-13** | `payment_methods (business_id, id, posting_account_id)` is referenceable as a composite | `0067`'s `supplier_refunds_method_fk` uses it | the refund's method edge changes shape |
| **A-14** | the permission registry is a CLOSED SET OF TWELVE and already contains `sales.return`, `refunds.approve` and `receivables.view`; the first two are SENSITIVE and are a DEFAULT of no built-in role | `packages/domain-core/src/permissions.ts:75-89`, `:131-145` | if S4 added a thirteenth key, P4-AL-36 is already broken and that is S4's finding, not S5's |
| **A-15** | `invoice_sequences` allocates a document number as `max + 1` under the sequence row's lock, with no `CREATE SEQUENCE` and no `serial`, and admits a `credit_note` document kind | the `inventory_next_deficit_seq` form at `0060:490-513`; `invoice_sequences_format_ck` | the credit-note number mechanism is re-derived. It is never replaced by a PostgreSQL sequence |
| **A-16** | `inventory_apply_stock_movements` computes a movement's value itself and REFUSES a caller that supplies one | `0060:376-394` | law 7 is at risk and the COGS reversal has no exact source. Design stops |
| **A-17** | `invoice_items` is referenceable as `(business_id, id)` so a credit-note item can name its origin line | `\d invoice_items`; `0075` | `credit_note_items.invoice_item_id` loses its edge and `quantity_exceeds_sold` stops being answerable from the row |
| **A-18** | `frozenThrough` at seal is `>= 0086` and never retreats | `scripts/phase4-s1-gate.ts:1754-1759` refuses any `frozenThrough` equality as a shape | nothing in S5 changes. It is recorded so the floor is not misread |
| **A-19** | `FINANCIAL_CORE` still does NOT name `credit_note_applications` at seal | `scripts/phase4-s1-gate.ts:504-505`. Re-measure | `PATCH-REQ-S5-005` is withdrawn as already done |
| **A-20** | `phase4RoutineBody` still returns the LAST definition by name at seal | `scripts/phase4-s1-gate.ts:1181-1197`. Re-measure | `PATCH-REQ-S5-007` is withdrawn. S5's design is correct either way |
| **A-21** | **S5 needs NOTHING from S6.** No reversal relation, no reversal source type, no `void_invoice`. `payment_reversals` and `allocation_reversals` are S6's, with `void_invoice` and TD-15's supplier twin | `docs/PHASE_4_EXECUTION_PLAN.md`'s `### P4-S6` section assigns them there; S5's scope paragraph (`:187-188`) names only `credit_notes`, `credit_note_items`, `refunds`. And nothing in this slice references a reversal: no edge, no column, no routine | nothing in S5 changes. If a refund were later found to need a reversal, that is a NEW dependency on S6 and an owner decision — S5 does not build one either way |
| **A-22** | `accounting_source_types` holds SEVENTEEN types at seal and **none is a credit note, a customer return, a customer refund or an `allocation_reversal`** | measured over every `INSERT INTO accounting_source_types` in the tree at `6587460` (eight statements, §5.1). Re-run the enumeration on the sealed tree | if a row S5 wants already exists, S5 BINDS to it instead of minting — the `0065:199` pattern — and `PATCH-REQ-S5-002` drops that row |

### 2.1 The assumptions that could NOT be confirmed from the tree at base

Stated plainly, because an unconfirmable assumption presented as a fact is the failure mode this
table exists to prevent.

- **A-2** is confirmed as of `6587460` but is a claim about the SEALED tree, which does not
  exist. A second consumer relation arriving in S4's remaining acceptance work would change
  `PATCH-REQ-S5-003`'s union. It cannot be checked until seal.
- **A-6** and **A-7** rest on `0081:1326-1333`, which is a COMMENT stating an intent. The
  comment is strong evidence and it matches the measured `UNION ALL` shape, but a comment is not
  an assertion and S5 has not executed the sealed bodies.
- **A-18** is a property of a file that is still a candidate.
- **A-21** is a reading of the execution plan, independently reached by the S6 owner from the
  other side and confirmed by the coordinator. What makes it checkable rather than merely agreed
  is the narrower claim beside it: **nothing in this slice references a reversal** — no edge, no
  column, no routine, no source type. That is verifiable by grep over S5's own files today, and
  it is the half that matters, because it means a wrong reading of the plan costs S5 nothing.
- **A-19** and **A-20** are both about files another agent may be editing right now. S5 measured
  them at base and designed so that either outcome is correct.
- The DDL specification's **§4.6** (the dust `CHECK`'s spelling) depends on
  `supplier_convert_base`'s exponent arguments being usable inside a row `CHECK`, which S5 has
  NOT established. It is recorded there as an open point of the specification, with the
  fallback — move the identity to the deferred validator — chosen in advance so that nobody
  invents a rounding function instead.

---

## 3. Tables, columns and constraints expected

Fully specified in `docs/PHASE_4_S5_DDL_SPECIFICATION.md`. The summary, with the four
non-obvious decisions:

| relation | role | consumes | consumed by |
|---|---|---|---|
| `credit_notes` | the document AND the consumable source (remaining pair) | — | `credit_note_applications`, `refunds` |
| `credit_note_items` | the returned lines, each with its EXACT COGS reversal | — | — |
| `credit_note_applications` | **the ONE AR reducer**: one row per (note, invoice), at the invoice's AR level | `credit_notes` | — |
| `refunds` | the cash disbursement. `credit_notes` XOR `customer_credits`. **No invoice. No payment.** | both sources | — |

1. **Four relations, not the plan's three.** `credit_note_applications` is omitted from
   `docs/PHASE_4_EXECUTION_PLAN.md:187-188` and `:324`, and the omission is a recorded staleness:
   `docs/PHASE_4_DECISION_REGISTER.md:280-283` records it as absent and needed, and
   `INVOICE_REDUCER_VOCABULARY` already names it a reducer. Without it an S5 would reduce AR by
   writing to `credit_notes` directly, with no per-invoice application row and therefore no level
   chain.
2. **The level device on `refunds` is TWO PARTIAL UNIQUE INDEXES, one per source** — never one
   constraint over two nullable columns. A `UNIQUE` is `NULLS DISTINCT` by default and this tree
   never writes `NULLS NOT DISTINCT` (sole mention: a comment at `0005:74`), so a copied
   single constraint is green and **vacuous for exactly half its subjects**. Each index gets its
   OWN red proof; one proof for the table would leave the other half as vacuous as the copy.
3. **No column anywhere in the slice stores a consumption total.** The cap is the source's own
   locked remaining, whose agreement with `original − Σ(exact stored consumer rows)` is
   established by the COMMIT-time chain verifier. `refunded_amount_minor` is refused twice over:
   by `FORBIDDEN_REFUND_FIELD_NAMES` here, and independently by G-3's `AP_BALANCE_COLUMN`.
4. **`credit_notes.invoice_id` is the ORIGIN, not the AR reduction.** The origin gives
   `quantity_exceeds_sold` its answer and the COGS reversal its provenance. The AR reduction is a
   `credit_note_applications` row, at a level, and a note may reduce AR by less than its total or
   by nothing at all. A reader who conflates them has read `TL-P4-S5-R1` backwards.

---

## 4. APIs

| method | path | permission | sensitive | business-wide | answers |
|---|---|---|---|---|---|
| POST | `/v1/credit-notes` | `sales.return` | yes | no | `CreditNoteResultDto` |
| POST | `/v1/credit-notes/:creditNoteId/void` | `sales.return` | yes | no | `CreditNoteResultDto` |
| POST | `/v1/refunds` | `refunds.approve` | yes | no | `RefundResultDto` |
| GET | `/v1/credit-notes/:creditNoteId` | `receivables.view` | no | no | `CreditNoteResultDto` |
| GET | `/v1/refunds/:refundId` | `receivables.view` | no | no | `RefundDto` |
| GET | `/v1/customers/:customerId/credit-notes` | `receivables.view` | no | yes | `CreditNotePageDto` |
| GET | `/v1/customers/:customerId/refunds` | `receivables.view` | no | yes | `RefundPageDto` |

Live in `apps/api/src/modules/returns/returns-permissions.ts` as `RETURNS_ROUTE_AUTHORITY`, the
`RECEIVABLES_ROUTE_AUTHORITY` shape, so a reader can compare the two slices side by side.

### 4.1 The read-path obligation, discharged

The recorded lesson, in the tree's own words
(`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:129-136`): the POS slice
*"shipped a server-side basket whose only readers were its own four write commands, so a
reloaded till screen lost the basket while its rows sat in `pos_cart_lines`"*. **State whose
only reader is its own commands' return value has NO read path.**

So: a credit note and a refund each get a real read route AND a collection read; the reader is
the **same gate and the same projection** as the write — not a second permission list, not a
second row shape; its refusal set is **NOT** the write's (absence and authority only, never
`*_inconsistent`, `*_immutable`, `*_changed` or `registry_incomplete`); and an empty collection
is `200 []` and never a refusal.

**Which is why the two collection reads must NOT be driven by a generic ALLOW/DENY loop in the
cross-tenant golden.** *"The generic pair would have been satisfied by a read that returned
nothing for everybody, which proves no isolation at all"*
(`01-cross-tenant.golden.test.ts:192-197`). The isolation claim for an S5 collection read is
about **CONTENTS**: under A's header the array holds A's own credit note and not one of A2's or
B's. S5's routes get their own section in the `RECEIVABLES_ROUTES` manner (`:218-224`), and the
other trap in that file is also respected: a POST driven as a GET is a 404 that looks exactly
like isolation.

### 4.2 Contracts

`packages/shared-contracts/src/returns.ts` — `CreditNoteDto`, `CreditNoteItemDto`,
`CreditNoteApplicationDto`, `CreditNoteResultDto`, `RefundDto`, `RefundResultDto`,
`CreditNotePageDto`, `RefundPageDto`. Every amount an integer STRING of minor units; every
document id a client-chosen canonical lowercase uuid and the idempotency key.

`packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts` reads that file FROM DISK
and judges the SHIPPED field lists, so the absences are a guard and not a comment: add
`invoiceId` to `RefundDto` and it goes red.

---

## 5. Accounting source types, journal shapes and operation kinds

### 5.1 Source types — measured before anything is minted

`customer_return`, `customer_credit_note_application`, `customer_refund`, at `sort_order` 18,
19, 20.

**Checked first, as the coordinator's ruling requires: NO row exists for any of the three.**
`accounting_source_types` is created CLOSED by `0042:65-68` (three natives, with a `DO $$`
asserting exactly three) and widened only by an explicit `INSERT`. All eight such statements in
the tree were read at `6587460`; the live registry holds **seventeen** types:

```
0042  opening_balance, manual_adjustment, reversal                      (1-3)
0061  inventory_adjustment, inventory_opening
0063  purchase, negative_inventory_cost_adjustment
0065  supplier_return
0067  supplier_payment, supplier_credit_allocation, supplier_refund
0072  purchase_residue_write_off
0077  sale (13), invoice (14)
0081  customer_payment_allocation (15), customer_credit_application (16), customer_credit (17)
```

There is no `credit_note`, no `refund`, no `customer_return` and **no `allocation_reversal`**.
So the preferred pattern — bind a derived fact to an existing identity rather than mint a new
one — is **not available here**: there is nothing to bind to. Minting is forced, and the pack
says so explicitly rather than leaving a reader to wonder whether it was checked.

**The precedent does decide the NAMING, and it changed one of S5's three.**
`supplier_credit_notes.accounting_source_type` is
`GENERATED ALWAYS AS ('supplier_return') STORED` (`0065:199`) — the supplier credit note binds
to the `supplier_return` type and **no `supplier_credit_note` type was ever minted**, because a
credit note is the accounting FACE of a return rather than a second event.
`purchase_reversals` does the same one step out, binding to the native `reversal` (`0065:310`).
So S5's first type is `customer_return`, **not** `customer_credit_note`: one identity for the
whole return rather than one per relation, the exact mirror of the supplier side.

**Three types and not one**, because they are three entries at three grains with three
different expected journal shapes, and one type with a branch inside its completeness validator
is how a shape nobody checks arrives (`TL-P4-S1-R1`). The supplier side reached the same answer:
`supplier_return`, `supplier_credit_allocation` and `supplier_refund` are three.

**And no reversal type is minted, because S5 ships no reversal relation** — see prohibited
assumption 23 and predecessor assumption A-21.

The spelling follows the **LIVE REGISTRY** and not `P4-AL-20`. The lock
(`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478`) enumerates six and names `payment_allocation`,
`credit_note`, `refund` — all three wrong against the tree: the live name is
`customer_payment_allocation` and the S4 gate pins that spelling as RULED
(`scripts/phase4-s4-gate.ts:577`, `:865-870`), and `customer_credit` is a live type the lock
never enumerated. The convention the live rows establish — the row's own domain, singular,
`customer_`-prefixed, in a different namespace from the `customer.*` op codes "which is why the
two deliberately differ" (`0081:2460-2465`) — is the authority. **Whichever spelling the Tech
Lead rules, the lock's enumeration is not it.** `PATCH-REQ-S5-002`.

### 5.2 The journal shapes

```
customer_return                        Dr sales_returns (4100)            total, note currency
                                               Cr accounts_receivable (1100)   the APPLIED part — AR falls ONCE
                                               Cr customer_refund_liability (2200)   the rest

the same command's COGS entry                Dr inventory (1200)               Σ EXACT stored value deltas
                                               Cr cogs (5000)

customer_refund, source = credit_note        Dr customer_refund_liability (2200)
customer_refund, source = customer_credit    Dr customer_credit_liability (2210)
                                               ± the source dust, SAME liability account
                                               Cr <posting account>
                                               ± realized FX — Cr 4900 gain / Dr 6900 loss
```

Four decisions, each with its law:

- **the revenue reversal debits 4100, not a negative 4000.**
  `packages/accounting/src/sale-posting.ts:31` records in its own words that "4100 is the RETURN
  account and belongs to P4-S5". A contra-revenue account exists so returns are VISIBLE rather
  than netted away, and a negative line is refused by `balanced` anyway;
- **there is no `accounts_receivable` line on a refund entry, ever**, and the deferred
  completeness validator asserts that ABSENCE by name. That is law 1 enforced in the ledger and
  not only in the application, and it is what makes the slice's central claim checkable from the
  database alone;
- **the dust lands on the liability account, never on 6100.** `0081:1597` already lands the
  credit dust on 2210. P4-AL-19: no rounding account is invented to make arithmetic balance;
- **the COGS reversal has no arithmetic at all.** Its amount is the sum of the stock writer's
  own stored integers. `TL-P4-S0-01` / P4-AL-25: the one official identity is
  `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`, never `Σ(qty × avg)`,
  because an average cost is a rounded quotient
  (`[[daftar-a-rounded-quotient-is-never-an-input]]`) and because recomputation cannot reproduce
  the branch where a movement empties a stock key and takes its stored valuation exactly
  (`0060:376-394`). **The input shape has no quantity and no unit cost**, so the wrong
  computation is unexpressible and not merely forbidden.

### 5.3 Operation kinds

`customer.issue_credit_note`, `customer.void_credit_note`, `customer.refund`.

Forced, not chosen: `inventory_operation_kinds.op_code` is
`CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')` frozen inside `inventory_payload_digest`
(`0054:229`, probed at `0074:62-70`), so the FIRST segment may hold no underscore and
`customer_refund.pay` is **unrepresentable** — asserted, with that exact string planted, in
`tests/guards/p4s5-refund-plan-red-proofs.test.ts` §9. Registration is
`PATCH-REQ-S5-001`.

---

## 6. Permissions

`sales.return` (SENSITIVE) for issue and void; `refunds.approve` (SENSITIVE) for the refund;
`receivables.view` (ordinary) for every read.

**No registry edit. The registry is a CLOSED SET OF TWELVE** (P4-AL-36,
`packages/domain-core/src/permissions.ts:75-89`) and all three keys are already among them.
Anyone adding a `credits.*` or `returns.*` key is adding a thirteenth, which is the edit the
ruling forbids — the same resolution S4 reached and recorded
(`receivables-permissions.ts:30-40`).

**Neither sensitive key is a DEFAULT of any built-in role.** `OD-P4-01` is RULED OPTION A and
`permissions.ts:131-145` says so in its own words: none of the six sensitive Phase 4 keys may be
a default of any built-in role, "the cashier and the manager included". So the two write routes
answer nobody until an owner grants the key explicitly. **That is intended behaviour, not a
gap**: a merchant who has not decided who may refund has decided that nobody may.

`payments.reverse` appears nowhere. A refund is not a reversal — a reversal unwinds an entry
that should not have been made, a refund lawfully discharges a liability that was correctly
recorded — and `payments.reverse` is P4-S6's.

---

## 7. Refusal codes

37 codes, closed union, in `@daftar/domain-core`'s `ReturnsRefusalCode`; classified by an
EXPLICIT TABLE in `apps/api/src/modules/returns/returns-errors.ts`; rendered from
`error.credit_note.*` and `error.customer_refund.*` in all three locale catalogues (952 keys ×
3, `npm run check:localization` PASS).

**Both directions are compile errors, not tests.** `satisfies Record<ReturnsRefusalCode, number>`
catches a code with no status; `RETURNS_CODES_ARE_DECLARED` catches a status with no code.
Between them the class of defect S4 paid a round for — "a live raise site whose code no status
table classifies", which turned a merchant's non-positive amount into a 500 blaming OUR
arithmetic — cannot recur. That is strictly stronger than a test: it cannot go stale and cannot
be skipped.

Exactly four codes are 500s, and they are the four that are ours:
`customer_refund.arithmetic_invalid`, `customer_refund.registry_incomplete`,
`credit_note.consumption_inconsistent`, `credit_note.cogs_not_exact`. Every other code is a
4xx, asserted over the whole union.

### 7.1 The asymmetries, which are facts and not omissions

- the **refund** side has no `amount_exceeds_outstanding` and no `settlement_changed`: a refund
  does not read an invoice's outstanding and cannot be invalidated by it moving. It has
  `source_changed` instead, about its own source;
- the **credit-note** side has both, because the credit-note APPLICATION is the one AR reducer;
- `source_absent` and `source_ambiguous` are DIFFERENT codes. "You named no source" and "you
  named two" are different merchant mistakes, and one code would make the client guess;
- `source_exhausted` and `amount_exceeds_source` are different: nothing is left at all, versus
  less is left than you asked for;
- there is exactly ONE tax code, `credit_note.tax_policy_absent`, and it refuses a non-zero tax;
- there is NO reversal code. Reversing an S5 entry is S6's, and a code for a command that does
  not exist is a contract nobody can meet.

---

## 8. Lock order and transaction boundary

```
1. customers           (identity pin; invoice_sequences is taken inside its scope)
2. invoices            (credit-note command ONLY, for the invoice its application names.
                        A REFUND NEVER TAKES THIS — TL-P4-S5-R1)
3. credit_notes | customer_credits   FOR UPDATE   ← THE CAP IS CHECKED HERE
4. payment_methods     (configuration read; nothing downstream locks)
```

`RETURNS_LOCK_ORDER` / `isLawfulLockTrace` in `@daftar/domain-core`. A deadlock between two S5
commands, or between an S5 and an S4 command, is prevented by every command taking the same
locks in the same order — and a relation the order does not NAME is a defect rather than a pass,
because a command that locks something nobody reasoned about has no deadlock analysis.

One transaction per command, with `RETURNS_TRANSACTION_BOUNDARY` naming what must be inside it.
A refund that disbursed cash in one transaction and decremented its source in another is a
refund that can pay twice; a credit note whose revenue reversal committed without its COGS
reversal moved revenue and not cost.

---

## 9. Performance budgets

Budgets are **MEASURED, never estimated** — `npm run check:budget-ratchet` is tighten-only
(`scripts/phase4-budget-ratchet.ts`, law at `tests/guards/p4s4-budget-ratchet-law.test.ts`), and
an estimated budget is a budget that loosens on first contact with a real plan. So this section
states the SHAPE each budget must have and the plan property it must prove, and the numbers are
owed at level F.

| path | the plan property that must hold | the standard it is held to |
|---|---|---|
| `POST /v1/refunds` | **fixed cost in the number of the source's existing consumers.** The cap read is one index lookup on the locked source row; the chain verifier reads the source's consumers through `refunds_note_idx` / `refunds_credit_idx` and `credit_note_applications_note_idx`, never a scan | the S4 fixed-cost law (`0084`) and `tests/performance/receivables-s4-budgets.test.ts`'s shape |
| `POST /v1/credit-notes` | **linear in the note's own line count and in nothing else.** Not in the invoice's history, not in the customer's note count | the sale-commit budget's shape |
| `POST /v1/credit-notes/:id/void` | **fixed cost.** One locked read and one lifecycle write | — |
| `GET /v1/customers/:id/credit-notes` | **keyset, fixed cost per page**, index-only on `credit_notes_customer_idx` which carries the full `ORDER BY`. No sort node, and cost independent of how deep the page is | `customer_open_invoices_page` (`0084:795`) and `tests/performance/receivables-open-page-equivalence.test.ts` |
| `GET /v1/customers/:id/refunds` | the same, on `refunds_customer_idx` | the same |
| the widened `invoice_outstanding` | **the fixed cost per invoice must not regress**, and the two overloads must stay equivalent | the S4 set-based equivalence suite, `tests/performance/receivables-ar-setbased-equivalence.test.ts` |

A plan-evidence claim is committed for each, and `tests/performance/plan-evidence-contract.test.ts:158`
refuses a stale inventory — so the claims and the wiring land together (`PATCH-REQ-S5-006`).

---

## 10. RLS, security and test hooks

### 10.1 RLS assumptions

All four relations get `ENABLE` **and** `FORCE` row level security — each required and
discovered independently (`scripts/guards/phase4-rls-force.ts:364`, `:386`, `:417`), with a
relation declared on disk but absent from the catalogue, or in the catalogue and not declared,
reported by name (`:457-465`). Every relation carries `tenant_id` and `business_id`.

Policies follow the `0063` R-35 layering: a permissive tenant policy through the `businesses`
subquery; a restrictive business isolation, **one policy per command**, where only the
`FOR SELECT` one admits the internal principals; permissive `FOR SELECT` admissions for the
principals whose guards read the rows. Written in `0086`'s quals-once-per-query shape.

`TL-P4-RLS-INT-01` (`docs/PHASE_4_DECISION_REGISTER.md:777`): the cross-tenant read of
`daftar_inventory_internal` and `daftar_accounting_internal` is **INTENTIONAL**. No migration is
written to narrow it, frozen `0052` is not modified, nothing is recorded as tenant-narrowing
debt — intentional architecture is not technical debt. S5's definers inherit this. The question
that replaces it is whether an ORDINARY RUNTIME CREDENTIAL can reach cross-tenant data or effect
THROUGH that authority, and the four-way matrix at `:824-831` may never be collapsed into one
statement.

### 10.2 Security assumptions

- `daftar_app` holds `SELECT` on the four relations and **nothing else** (the `0081:615` shape).
  `forbiddenPrivileges` (`tests/security/phase3-s8-grant-matrix.test.ts:85`, asserted `:361`) is
  UNSCOPED and judges Phase 4's tables: `DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE`
  must not be reachable by a runtime principal or PUBLIC;
- every grant goes into the REVIEWED matrix in the same change — `deviations()` (`:228`) reports
  an unreviewed grant verbatim;
- the three commands are internal-owned `SECURITY DEFINER` with pinned `search_path` and
  `REVOKE ALL … FROM PUBLIC`, and `REVOKE` is re-issued after every `CREATE OR REPLACE` because
  that resets a function's ACL;
- `od03Problems` (`:174`, catalogue read `:146-160`, asserted `:534`, `:752`) reads **every**
  column matching `(^|_)tax(_|$)` in `public` with **no allowlist**. So a tax-named column must
  be `bigint`, `NOT NULL` and carry a single-column `CHECK (<col> = 0)`, or S5 carries no
  tax-named column at all. There is no third option;
- `refunds` admits **no UPDATE at all**. A refund that happened is a fact; a correction is a new
  document (P4-AL-46);
- a merchant-facing message carries no journal entry id, account code, journal line, routine
  name, GUC, constraint name, amount, or the database's text after the colon (P4-AL-54). The
  database-code recognizer is narrow by construction
  (`/^((?:credit_note|customer_refund)\.[a-z_]+)\b/`): widening it to an internal invariant
  vocabulary is how a broken invariant comes to be rendered as a 403, which `selling-errors.ts`
  records as a real incident.

### 10.3 Test hooks

| hook | what it is for |
|---|---|
| `ReturnsPorts` (`returns-ports.ts`) | the whole port surface in one interface, so a composition root names one thing and an in-memory model implements the same contract the SQL will |
| `RefundSourcePort.lockSource` | there is deliberately **no `readSource` beside it**: an unlocked read of a cap is the one thing the port must not make easy |
| `RefundPort.storedIntent` | returns the INTENT, not a boolean. A port that answered "already seen" would let a different economic command reuse a key |
| `RETURNS_REFUSAL_CODES` / `RETURNS_CODES` | the closed union as a runtime list, for a suite that drives every code instead of trusting the type |
| `isLawfulLockTrace` | the predicate a recorded lock trace is driven through |
| `refundIntentPreimage` | the canonical pre-image, so an intent comparison is reproducible without the hashing authority |
| `ModelSource` (in the concurrency suite) | an in-memory consumable source whose `lock()` IS the barrier, so a written interleaving is enforced and not hoped for |

---

## 11. The slice gate's structure

`scripts/phase4-s5-gate.ts`, requested in `PATCH-REQ-S5-006`, in the shape the four gates before
it share: exported devices, one `ok`/`FAIL` line per check, a `--structural-only` mode, and a
roster of red proofs it REQUIRES to exist (the S4 gate measured 12 laws, 2 goldens, 21 behaviour
files and 55 plant-announcing `describe(` blocks at base — the device, not the numbers, is what
S5 copies).

The checks, each with what makes it non-vacuous:

| check | subject, discovered not listed | the red proof it requires |
|---|---|---|
| `refund-is-not-a-reducer` | every S5 routine body, by NAME and by DEPENDENCY FIXPOINT, run through `refundMention` — the gate's own exported device, reused, never a second copy | a `FROM public.refunds` planted in **each** `invoice_outstanding` overload separately (see `PATCH-REQ-S5-007`) |
| `refund-entry-has-no-ar-line` | the deferred completeness validator's expected shape, read from the migration text | an `accounts_receivable` line planted into the refund's expected shape |
| `cap-under-for-update` | every write path to a source's remaining pair, discovered from the routine bodies | a cap check placed before the lock; a decrement at a fabricated level |
| `level-device-per-source` | both partial unique indexes, with their predicates read from `pg_index.indpred` | **one proof PER SOURCE.** A non-partial replacement, which is vacuous for half the rows, must be refused |
| `no-stored-consumption-total` | every column of the four relations against `AP_BALANCE_COLUMN` and `DERIVED_COST_COLUMN` | `refunded_amount_minor` planted on `credit_notes` |
| `od03-structural-zero` | every `(^\|_)tax(_\|$)` column on the four relations, from the catalogue | a nullable tax column; a tax column with no `CHECK (= 0)` |
| `source-type-registration` | every registered S5 type, checked for a writer, a binding, an expected shape, a deferred validator, and a row in the reversal guard's list | a type registered without its reversal-guard row |
| `cogs-reversal-is-exact` | the COGS entry's amount against `Σ stock_movements.value_delta_base_minor` | a reversal computed from `qty × average` |
| `read-path-exists` | every S5 write, checked for a reader with the same gate and the same projection | a command whose only reader is its own return value |
| `cross-tenant` | every S5 route from `discoverPhase4Routes`, each needing a real ALLOW/DENY pair in the golden | a collection read that answers `200 []` for everybody — which satisfies a generic loop and proves no isolation |
| `closure-and-tense` | the gate under its own law: no permanent module bounds the future, the gate names no migration past the last accepted one, and its candidate-tense block is fenced for the acceptance commit to delete | — |

---

## 12. PROHIBITED ASSUMPTIONS — things a reader might assume that are FALSE

1. **S5 may allocate a migration number.** It may not. There is one migration owner in this
   phase and it is not S5. `0087` is not reserved, not implied and appears nowhere in this slice.
2. **`refunds`, `credit_notes`, `credit_note_items` or `credit_note_applications` exist.** None
   exists at any prefix `0000`–`0086`. Verified over the whole tree.
3. **`P4-AL-20`'s six source types are the authority.** They are not. The enumeration is wrong
   in three ways (§5.1) and the live registry holds a seventh it never named.
4. **The execution plan's three S5 relations are the whole set.** They are not.
   `credit_note_applications` is a recorded omission, and it is load-bearing (§3).
5. **`supplier_refunds_level_uq` can be copied.** It cannot. It works over a NOT NULL source;
   over two nullable ones it is `NULLS DISTINCT` and **vacuous for half its subjects** (§3.2).
6. **"S5 should not replicate the level `UNIQUE`."** The tree says the opposite. `P4-AL-22`
   requires BOTH devices on every consumable Phase 4 source — "the payment, **the credit note**,
   the customer credit" (`:528-530`) — so dropping it contradicts an accepted lock. What must not
   be replicated is the SHAPE.
7. **A large number of accepted assertions will go red when S5's relations land.** That model is
   pre-`P4-AL-88` and no longer describes this tree. `tests/security/phase4-forward-evolution.test.ts:30-40`
   structurally eliminated the class, and `tests/security/settlement-s6-no-customer-payments.test.ts`
   — the one file naming `refunds`, `credit_notes` and `customer_refunds` by hand — was
   re-expressed and will NOT go red (`:146-161`, `:208-215`). What WILL speak is the
   discovery-based set, enumerated in the preparation page §5.
8. **A credit note's `invoice_id` is an AR reduction.** It is the ORIGIN. The reduction is an
   application row, at a level (§3, item 4).
9. **`invoice_outstanding` has one body.** It has four definitions across two overloads, and the
   gate's reader returns the LAST by name. Teaching one overload leaves `S-P4-03` red and the
   refund law blind (§5 of the DDL spec, `PATCH-REQ-S5-007`).
10. **`payments.reverse` is the refund's permission.** It is P4-S6's. A refund is not a reversal
    (§6).
11. **The refund's sensitive keys will work out of the box.** They are a DEFAULT of no built-in
    role, by ruling. The write routes answer nobody until an owner grants explicitly, and that is
    correct (§6).
12. **The cap may be read before the lock and re-checked after.** It may not. The law is about
    WHERE the check happens, and `tests/guards/p4s5-refund-cap-concurrency-models.test.ts` shows
    the before-the-lock protocol refunding 10000 twice out of a source of 10000.
13. **The level `UNIQUE` is the cap.** It is a fast per-relation BACKSTOP (`0081:327-333`). The
    sufficient mechanism is the COMMIT-time chain verifier, and race 5's red proof shows the
    UNIQUE green on a source that has given up 1500 of 2000 while its row says 500 remain.
14. **The chain verifier checks the TOTAL.** It checks the LEVELS. Race 5's red proof is
    constructed so the total reconciles exactly and the chain still does not — which is why a
    total-only verifier would be green on an attacked source.
15. **S5 decides `OD-03`.** It does not. No rate, no jurisdiction, no exemption, no threshold, no
    legal invoice field, no non-zero tax path. Only the structural zero.
16. **`TL-P4-RLS-INT-01` is debt to be paid down.** It is INTENTIONAL architecture. No migration
    narrows it and nothing is recorded as debt.
17. **`{SEQ:06}` is storable.** It is not: the frozen `invoice_sequences_format_ck` admits no
    leading zero in the width. `INV-{YYYY}-{SEQ:6}` stays, and a credit-note series follows the
    same per-business counter under a lock — never a cluster-wide `CREATE SEQUENCE` (G-07).
18. **48 Phase 4 routines.** The live count is **49**. Two documents say 48 as prose
    (`docs/PHASE_4_DECISION_REGISTER.md:648-649`, `scripts/phase4-s1-gate.ts:1324-1325`); nothing
    is red, but S5 does not quote 48.
19. **The plan layer's home is `apps/api`.** It is a staging position, recorded as such in
    `PATCH-REQ-S5-004`. Its home is `packages/inventory`, at promotion.
20. **An empty collection read is a refusal.** `200 []` is the correct answer, and a generic
    ALLOW/DENY loop over such a route proves nothing (§4.1).
21. **S5 may make `invoice_outstanding` read `refunds` to turn the seam green.** That is one of
    five explicitly refused ways (`docs/PHASE_4_DECISION_REGISTER.md:287-293`), along with adding
    a comment, adding a dead SQL reference, renaming `refunds` to escape the vocabulary, and
    special-casing a test. The first three are already planted against and refused in direction C
    of `tests/guards/phase4-refund-not-a-reducer-guard.test.ts`.
22. **S5 ships a reversal relation.** It does not. `payment_reversals` and
    `allocation_reversals` belong to P4-S6, with `void_invoice` and TD-15's supplier twin, and
    neither name appears in this slice as a relation to create. A refund is not a reversal: it
    lawfully discharges a liability that was correctly recorded, where a reversal unwinds an
    entry that should not have been made. The refund path therefore needs nothing from S6
    (A-21), and `FINANCIAL_CORE` already reserving both names while the registry holds no
    `allocation_reversal` row is exactly the state of a slice not yet built.
23. **A source type for a credit note or a refund already exists somewhere.** None does. All
    eight `INSERT INTO accounting_source_types` statements in the tree were read; the registry
    holds seventeen types and none is a credit note, a customer return, a customer refund or an
    `allocation_reversal` (§5.1).
24. **This slice is at level F or beyond.** It is at A–E. There is no service, no controller, no
    module registration, no SQL and no integration test, and their absence is the operating model
    being obeyed, not an oversight.

---

## 13. `READY_TO_PROMOTE = NO`

### What is DONE

| level | deliverable | where |
|---|---|---|
| **A** | the pure returns domain: credit-note lifecycle, the refund source algebra, the closed 37-code refusal vocabulary, the op-code and source-type spellings with the frozen-CHECK validator, the lock order, the transaction boundary, the intent model, the cap, the structural zero, the exact-COGS rule | `packages/domain-core/src/returns.ts` |
| **A** | the plan layer: `planCustomerRefund`, `planCreditNoteReversal`, `consumedSide`, `verifySourceConsumptionChain`, `assertNoReceivableLine`. **No arithmetic of its own** — the four accepted primitives and the chain verifier, imported | `apps/api/src/modules/returns/returns-settlement.ts` |
| **B** | the contracts (8 DTOs) | `packages/shared-contracts/src/returns.ts` |
| **B** | the repository ports, the refusal status table with its two compile-time totality checks, the route authority table | `apps/api/src/modules/returns/returns-ports.ts`, `-errors.ts`, `-permissions.ts` |
| **C** | 49 unit tests and red proofs across 13 sections, every guard shown able to FAIL on a REAL planted subject | `tests/guards/p4s5-refund-plan-red-proofs.test.ts`, `packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts` |
| **C** | the five cap-race concurrency MODELS — deterministic, barrier-based, **no sleep, no timer** — each with a red proof that the broken protocol overdraws | `tests/guards/p4s5-refund-cap-concurrency-models.test.ts` |
| **D** | the API surface (7 routes), and localization in ar/en/tr (37 keys × 3; `check:localization` PASS at 952 × 3) | `-permissions.ts`; `apps/web/src/messages/{ar,en,tr}.json` |
| **E** | the DDL **specification**: 4 relations, the full FK map, CHECKs, indexes, RLS policies, triggers, expected catalogue shape, upgrade expectations. **No `.sql`. No number.** | `docs/PHASE_4_S5_DDL_SPECIFICATION.md` |
| — | 7 patch requests | `docs/patch-requests/PATCH-REQ-S5-001…007.md` |

### The checklist that would make it YES

Nothing on it can be done before S4 seals and this slice is promoted.

**Gate 0 — the predecessor**
- [ ] S4 SEALED. Its migration prefix is final and `frozenThrough` has advanced.
- [ ] **Every A-1…A-20 assumption of §2 diffed against the sealed tree**, each marked CONFIRMED
      or REFUTED, and every refutation's consequence worked through before any SQL is written.
      The five of §2.1 are the ones most likely to move.
- [ ] S5 promoted, and a migration prefix ASSIGNED by the single migration owner.

**Gate 1 — the patch requests**
- [ ] `PATCH-REQ-S5-001` landed (the three op codes in the inventory vocabulary).
- [ ] `PATCH-REQ-S5-002` landed (three source types + the reversal guard, in ONE change).
- [ ] `PATCH-REQ-S5-003` landed (the five `CREATE OR REPLACE`s, in a NEW migration).
- [ ] `PATCH-REQ-S5-005` landed (`credit_note_applications` in `FINANCIAL_CORE`) **in the same
      change that creates the relation**, with its red proof.
- [ ] `PATCH-REQ-S5-006` landed (CI chain row + workflow step + `package.json` + the gate
      script + measured budgets) — (b) and (c) together or neither.
- [ ] `PATCH-REQ-S5-007` landed or formally withdrawn as already fixed.
- [ ] `PATCH-REQ-S5-004` applied (the plan layer relocated, with its vectors file).

**Gate 2 — level F, the real DB binding**
- [ ] the migration written by the single migration owner, from the §E specification, under the
      assigned prefix, ending with the §7 catalogue block.
- [ ] §4.6 of the specification RESOLVED by measurement: the dust identity either expressible in
      a row `CHECK` through `supplier_convert_base`, or moved to the deferred validator.
      **Not by a new rounding function.**
- [ ] `cogs_reversal_base_minor` re-measured against `DERIVED_COST_COLUMN`. If it matches, the
      COLUMN is renamed; the guard is not relaxed.
- [ ] the three commands, the two reads and the two deferred completeness validators written,
      each internal-owned, `search_path`-pinned, `REVOKE ALL … FROM PUBLIC`.
- [ ] the services, the controller and the module registration, every refusal path reaching the
      ONE `auditThenRethrow…` composer (P4-AL-48 — never a second copy).
- [ ] `npm run check:db-from-zero` PASS.

**Gate 3 — level G, the integrated gate**
- [ ] **the owed financial test** (`docs/PHASE_4_DECISION_REGISTER.md:267-285`): open a credit
      invoice; make the credit-note effect; verify AR falls **exactly once**; refund the
      liability; verify the invoice outstanding does **not** fall again; verify cash and the
      liability **do** move. **Every write through the product's own commands — no `refunds`,
      `credit_notes` or `credit_note_applications` row inserted by hand.**
- [ ] the five cap races re-run **against a real database**, barrier-based and never timed, and
      each shown red without its guard.
- [ ] the direct-SQL attack run against the real relations, at a fabricated level, refused by the
      chain verifier — the device `gate:phase4:s4` already asserts for S4's sources.
- [ ] a red proof **per source** for the two partial level indexes.
- [ ] `S-P4-03` GREEN with BOTH `invoice_outstanding` overloads taught and equivalent.
- [ ] the cross-tenant golden's S5 section, with CONTENT-level isolation on both collection
      reads — never a generic ALLOW/DENY loop.
- [ ] `od03Problems`, `deviations()`, `forbiddenPrivileges`, the beyond-Phase-3 DML sweep, the
      RLS/FORCE discovery (both halves), G-3's relation and column arms, GOLD-74's schema lint,
      G-07's numbering, the derived-truth guard and the vocabulary live arm — all GREEN over the
      new relations.
- [ ] `npm run check:budget-ratchet` PASS with five MEASURED budgets and no loosening.
- [ ] `gate:phase4:s4 --structural-only` still PASS, and the full S4 gate still PASS.
- [ ] `gate:phase4:s5` PASS, with its red-proof roster non-empty and every plant-announcing
      block shown to execute a refusal.
- [ ] `npm run format`, `npm run lint`, `npm run typecheck` — whole tree, exit 0.

**Gate 4 — level H, the seal**
- [ ] the acceptance report, the decision-register entries, and the candidate-tense block of the
      S5 gate deleted by the acceptance commit.
- [ ] `OD-03` still OPEN and untouched.
