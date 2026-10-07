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
- `docs/patch-requests/PATCH-REQ-S5-001.md` … `-008.md` — one per shared-file change S5 needs
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
| 1a | AR has ONE home and ONE algorithm: the credit note's own entry has no `accounts_receivable` line and its input shape cannot be handed an invoice, so every AR reduction is a `credit_note_applications` row produced by the canonical `planCustomerCreditApplication` at the INVOICE's stored snapshot | `planCreditNoteReversal` (no invoice, no AR line, ONE conversion), `planCreditNoteApplication` (delegates; `PATCH-REQ-S5-008` removes the one relabelling) |
| 2 | two nullable `*_id` columns, each with a real composite FK, plus `CHECK (num_nonnulls(...) = 1)`. The kind is DERIVED, never stored | `resolveRefundSource`; DDL spec §4.2, §4.4 |
| 3 | the cap function takes the LOCKED remaining as an argument, so the question cannot be asked without the lock; no column name in the slice can carry a total | `refundCapRefusal`, `consumedSide`; `FORBIDDEN_REFUND_FIELD_NAMES` |
| 4 | the plan layer imports the four accepted primitives and contains no `HALF_EVEN`, no rounding function and no `10n ** 18n`; the COGS input shape has no quantity and no unit cost | `returns-settlement.ts`; `creditNoteCogsReversalBaseMinor` |
| 5 | one spelling of zero, through the SAME predicate the invoice uses; no tax field on the refund at all | `creditNoteTaxRefusal` → `isStructuralZeroTax` |
| 6 | the chain verifier delegates to `verifyCreditChain` and adds nothing; the liability account is decided in ONE function | `verifySourceConsumptionChain`, `refundLiabilityAccount` |
| 7 | the stock port asks the authority and reads back; it has no write method | `ReturnStockPort` |
| 9 | no command reads the clock: the comparison instant is NAMED (`RETURNS_DATE_COMPARISON_INSTANT`) and taken as a parameter, and the module contains no `new Date`, no `Date.now` and no `now()` | `returnsDateRefusal`; `[[daftar-a-command-must-not-read-the-clock]]` |
| 10 | a mistyped or stale RATE cannot reach settlement: the two rates must be within [0.5×, 2×] of each other, inclusive (`TL-P4-S5-R3`, §5.1c). It is a DATA-QUALITY check — it computes nothing, caps no accounting value and creates no amount | `planCustomerRefund`'s `fx_rate_changed` rate comparison, driven to all four boundaries, with eleven required cases and the §16 sign-symmetry property |
| 11 | the shared lock rank's PREMISE is checked, not remembered: no command holds both source relations | `returnsLockTraceOneSource` |
| 8 | the intent is a CLOSED ordered field list with an explicit absence encoding, compared by pre-image — for BOTH commands, since the credit note has an `idempotency_conflict` code and therefore owes a mechanism | `REFUND_INTENT_FIELDS` / `refundIntentPreimage` / `refundReplayVerdict`, and `CREDIT_NOTE_INTENT_FIELDS` / `creditNoteIntentItems` / `creditNoteIntentPreimage` / `creditNoteReplayVerdict`; the absence encoding is ONE function (`intentPreimage`), shared, not a convention written twice; `CreditNotePort.storedIntent` is the seam |

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
| **A-23** | **S6 owns voiding or reversing an ISSUED credit note.** S5 has no void command, no `status` column and no lifecycle (`CREDIT_NOTE_HAS_NO_LIFECYCLE`). A note issued in error is superseded by a NEW note (`P4-AL-46`); unwinding the posted `Dr 4100 / Cr 2200` and `1200/5000` entries is a reversal | `docs/PHASE_4_EXECUTION_PLAN.md`'s `### P4-S6` section owns the reversal mechanism; and, on S5's side, `grep -rn 'status\|lifecycle\|void' ` over S5's own files returns only the comments that record the deletion | **nothing in S5 changes.** This is a SUCCESSION, not a dependency: S5 is complete without it, because the liability a wrong note raised is either discharged by a refund or left standing, and both are representable today. If S6 declines it, the merchant's remedy stays "issue a superseding note", which is the `P4-AL-46` answer anyway |

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
- **A-23** is the one assumption that was ADDED rather than measured, in round 3, and it is
  stated as a succession precisely because it cannot be confirmed: S6 is not designed. What
  makes it safe is that S5 asks nothing of it. The deletion it follows from is checkable today
  — no `status` column in the specification, no void routine, no lifecycle symbol exported, no
  refusal code for either, and the two locale keys removed from all three catalogues — and
  `tests/guards/p4s5-refund-plan-red-proofs.test.ts` §11 reads every one of those sites off
  disk with a red proof over the pre-correction text.
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

### 5.1a `TL-P4-S5-R2` — the project owner's ruling on the AR reduction

Recorded in full because it is binding and because it adds requirements that are not
derivable from the eight laws alone.

> **ONE AR REDUCTION / ONE CANONICAL CUSTOMER SETTLEMENT ALGORITHM.** A credit-note flow
> reduces invoice AR exactly once. No second AR effect is allowed.
>
> **Do not implement independent credit-note AR arithmetic.** Reuse the accepted
> customer-settlement arithmetic. The AR side derives from the stored invoice settlement pair
> through the canonical mechanism equivalent to `arSide`, `arLines` and `realizedLines`,
> including correct invoice-rate carrying release, base-value release, dust/residue handling
> and realized FX gain/loss.
>
> **There must be exactly one accounting event** whose economic meaning is "this portion of
> the credit note is applied against invoice AR".
>
> **ONE CONVERSION, NOT TWO.** Do not independently convert the applied amount and the
> remaining amount and then reconcile the difference. Never feed a rounded quotient back as an
> authoritative input.
>
> **The application write shape must be able to persist the facts its own schema requires** —
> carrying base released, realized FX gain/loss, release-before level. *"A relation with
> required financial columns that the legitimate command cannot populate is an invalid
> design."*
>
> **The refund liability must not absorb unrecorded FX.** No realized exchange movement may
> silently change `customer_refund_liability` without its accounting line.

**The required identity**, reconciling exactly in integer minor units with no unexplained
one-minor drift:

```
AR effect + realized FX effect + dust/residue effect + liability effect = 0
```

#### Where each limb is STRUCTURAL

| limb | the structure | where |
|---|---|---|
| one AR reduction | `planCreditNoteReversal` takes no invoice, carries no `accounts_receivable` line, and `assertReturnEntryReducesNoReceivable` refuses one at runtime | `returns-settlement.ts` |
| one canonical algorithm | `planCreditNoteApplication` CALLS `planCustomerCreditApplication`; `assertCanonicalArRelease` recomputes `rel` with `apRelease` from the invoice's stored pair and refuses a disagreement of one minor unit | `returns-settlement.ts`; `PATCH-REQ-S5-008` deletes the one remaining relabelling |
| one accounting event | one source type, `customer_credit_note_application`, with one deferred validator; the `customer_return` validator asserts the ABSENCE of a 1100 line by name | DDL spec §5.2, §5.5 |
| one conversion | `planCreditNoteReversal` contains exactly ONE `convert(` call, asserted over its shipped text; the applied amount is never converted in that function at all | red proof 7 |
| the write shape | `CreditNoteApplicationWrite` carries every `NOT NULL`-no-default column of §3 that the command owns, and `creditNoteApplicationRow` MAPS a plan to a row whose money columns `assertApplicationRowAgreesWithEntry` checks against the entry's lines | `returns-ports.ts`; red proof 6 and the crossed-columns proof |
| no absorbed FX | `assertApplicationEntryComplete` / `assertRefundEntryComplete` assert each TERM against the canonical number, not merely that the entry balances | red proof 5, which plants a defect that BALANCES and is still refused |
| the identity | the four-term sum, over four scenarios including a dusty one and a full consumption | red-proof section 5a |

#### The seven red proofs, as shipped

All seven live in `tests/guards/p4s5-refund-plan-red-proofs.test.ts` §5a, and each plants a
REAL subject — a line this slice's own code once produced, a value the pre-correction code
computed, or a declaration read off disk. None is a lambda written in the test body.

1. AR reduced from both credit-note creation and application → the deleted
   `Cr accounts_receivable 3 633` line, reconstructed, refused by the guard the reversal path
   calls on every entry.
2. An application using its own FX conversion → `convertToBase(3 333, 1.0901) = 3 633` planted
   against `apRelease(10 853, 10 000, 0, 3 333) = 3 617`.
3. A missing realized FX line → the 16-minor `fx_gain` line removed from a plan that genuinely
   realizes it.
4. A missing dust/residue line → a scenario with a genuine second AR line, that line removed.
5. The refund liability changed by an unposted FX difference → the FX line removed and the
   liability widened by the same amount, so the entry **still balances** and is still refused.
6. A write shape unable to populate the mandatory fields → the MANDATORY SET DERIVED from §3
   of the DDL specification (every `NOT NULL` column with no default and no `GENERATED`
   clause, less an explicitly reasoned exemption per column), measured against the shipped
   declaration; the red arm is the seven-field shape of §5.1b(c), read out of this document.
7. Two independent conversions → the shipped text of `planCreditNoteReversal`, one `convert(`;
   the real deleted body of §5.1b(a), read out of this document, two. Plus a structural arm:
   `CreditNoteReversalInput` no longer NAMES an applied amount, so the second conversion has
   no operand to take.

### 5.1b THE DELETED CODE, RECORDED VERBATIM — the subject the red proofs plant

A red proof needs a subject that is REAL. Round 2 shipped two proofs whose "defect" was a
string the test wrote into a template literal, and the challenger was right that this proves
only that a regular expression counts occurrences in a string the test chose. The honest
subject is the text the slice ACTUALLY SHIPPED and had to delete, so it is recorded here,
verbatim from `8e996c5`, and red proofs 6 and 7 read it OUT OF THIS DOCUMENT rather than
restating it.

Recording it here, and not in the test, is the point: this file is reviewed, the defect is
therefore reviewable, and a proof cannot quietly weaken by editing its own subject.

#### (a) The two independent conversions — the body of `planCreditNoteReversal` as it shipped

```ts
  const appliedBaseMinor = input.appliedToInvoiceMinor === 0n ? 0n : convert(input.appliedToInvoiceMinor, input.conversion);
  const liabilityBaseMinor = totalBaseMinor - appliedBaseMinor;
  if (liabilityBaseMinor < 0n) refuse('customer_refund.arithmetic_invalid', 'the split of a credit note total is not a split');
  const liabilityMinor = input.totalMinor - input.appliedToInvoiceMinor;
```

Two `convert(` calls in one function, the second of them the applied part — and the comment
above them claimed the split was "an exact integer SPLIT of the ONE header conversion", which
is exactly the kind of true-sounding sentence a reviewer accepts. `TL-P4-S5-R2`: **"ONE
CONVERSION, NOT TWO. Do not independently convert the applied amount and the remaining amount
and then reconcile the difference."**

#### (b) The second AR reduction — the line the same function pushed

```ts
      account: 'accounts_receivable' as const,
      side: 'C' as const,
      currency: 'invoice' as const,
      txnAmountMinor: input.appliedToInvoiceMinor,
      baseAmountMinor: appliedBaseMinor,
```

A `customer_return` entry crediting `1100` at the NOTE's rate, for the applied part, in
addition to the application's own AR reduction. Two AR effects for one economic event, the
second of them converted at the wrong snapshot.

#### (c) The write shape that could not populate its own relation

```ts
export interface CreditNoteApplicationWrite {
  readonly applicationId: string;
  readonly lineNo: number;
  readonly invoiceId: string;
  readonly arReleasedBeforeTxnMinor: bigint;
  readonly creditAmountConsumedMinor: bigint;
  readonly invoiceAmountAppliedMinor: bigint;
  readonly invoiceCarryingBaseReleasedMinor: bigint;
}
```

Seven fields against the **twenty** columns §3 of the DDL specification declares `NOT NULL`
with no default and no `GENERATED` clause — fifteen of which are the command's to supply and
five of which come from the scope or are pinned to `id`. Round 3's first widening added four of the missing
ones and still left `credit_note_id` out — found only by DERIVING the mandatory set from §3
instead of restating it in the test, which is why red proof 6 now does exactly that.

### 5.1c `TL-P4-S5-R3` — the SYMMETRIC 2× REFUND-FX SANITY BOUND, approved

The project owner's rule, recorded because it is binding and because its FRAMING is part of the
ruling and not decoration:

```
accept   0.5× ≤ current_rate / source_rate ≤ 2×      INCLUSIVE at both ends
refuse   strictly outside that range
```

Exactly 0.5× and exactly 2× are **accepted**. Symmetric, with no loss-only blind side.

#### What the guard IS NOT — the owner's §9, which is why the wording changed

> "does not compute realized FX; does not modify the journal result; **does not cap legitimate
> accounting values**; does not create a gain/loss amount. It only prevents obviously suspicious
> input/rate divergence from reaching settlement."

The implementation was arithmetically correct before this ruling and is unchanged in behaviour.
What changed is that it was written as `|realized| > min(cr_rel, db)`, which READS as a ceiling
on an accounting amount — the one thing §9 says it is not. It is now written as the rate
comparison it actually is, cross-multiplied into bigint so neither a division nor a float
appears:

```ts
if (disbursementBaseMinor > 2n * consumed.carryingReleasedMinor || consumed.carryingReleasedMinor > 2n * disbursementBaseMinor) {
  refuse('customer_refund.fx_rate_changed', 'the disbursement rate and the rate the liability was carried at differ by more than a factor of two');
}
```

`db > 2·cr_rel` is `current/source > 2`; `cr_rel > 2·db` is `source/current > 2`. The strict `>`
puts the boundary exactly where the ruling puts it, which the coordinator verified at all four
boundaries in bigint before approving: `db = 2·cr_rel` accepted, `db = 2·cr_rel + 1` refused,
`cr_rel = 2·db` accepted, `cr_rel = 2·db + 1` refused.

#### The policy, stated rather than apologised for

A genuine long-term currency move beyond a factor of two requires a **rate refresh before a
refund**. That is **intentional under Phase 4 policy**: at this layer a rate more than 2× from
the one the liability was carried at is indistinguishable from a typo, and refusing is the
direction that cannot lose money. `customer_refund.fx_rate_changed` is a **409** the caller
rebinds — never a 500 — and the operator's remedy is to refresh the rate and retry.

#### The eleven required cases, all shipped

`tests/guards/p4s5-refund-plan-red-proofs.test.ts` §10b, each labelled with the ruling's own
wording so a reader can count them against it: same rate → accept (realized exactly zero, and
**no FX line at all**); +99% → accept; exactly 2× → accept; above 2× by the minimum
representable step (one minor unit) → refuse; −49% → accept; exactly 0.5× → accept; below 0.5×
by the minimum representable step → refuse; the gain direction (`C 4900`, nothing on 6900); the
loss direction (`D 6900`, nothing on 4900); base currency = 1, where "a factor of two" is one
minor unit and the integer boundary is at its tightest; and a malformed, zero or negative rate
shown to be refused UPSTREAM — inside `convertToBase`
(`packages/inventory/src/supplier-settlement.ts:80`), which raises an `InventoryError` and not
an S5 refusal, so the code is **not** `fx_rate_changed` and the distinction is the evidence.

Plus one the ruling implies and does not list: **the guard caps nothing**, asserted by walking
the whole admitted range and requiring `realized = cr_rel − db` exactly at every step,
including at both inclusive boundaries where a clamp would be invisible to a test that only
checked the middle.

#### §16 — realized FX is ONE signed difference, and the sign is symmetric

§15 is already satisfied by the implementation: `realizedMinor = carryingReleasedMinor −
disbursementBaseMinor` is one signed difference derived once, with the side chosen afterwards
from its sign. §16's proof is in §10b.1 of the same file and is stated **as a property over
pairs**, not as two examples: for every offset `k` in the admitted range, the gain at `100 − k`
and the loss at `100 + k` are exact negations, with a non-vacuity arm so it is not `0 === −0`
fifty-one times. The eight required points are in ONE suite — exact zero, +1 minor, −1 minor, a
large gain, a large loss, a rounding residue, the final release — and a third test shows
neither branch is dead and that the magnitudes match across the swap, which is only true if one
difference was computed.

### 5.1d §13 and §14 — ONE canonical account authority, proved by MUTATION

The owner's §13: one canonical account-id source, and *"do not fix this by making all three
literals equal — remove duplicate authority."* §14: no missing account, no duplicate authority,
no string-literal bypass, no second mapping table, no dead config member.

`S5_ACCOUNT` in `packages/domain-core/src/returns.ts` is that source: the nine S5 account
identifiers are spelled THERE, once, and nowhere else in the slice. `REFUND_ENTRY_ACCOUNTS`,
`CREDIT_NOTE_ENTRY_ACCOUNTS`, `refundLiabilityAccount`, `APPLICATION_LIABILITY_ACCOUNT`, the one
account map, every line builder and every validator in `apps/api/src/modules/returns/` DERIVE
their strings from it. No account literal survives in code in either S5 module.

**Why the source sits in the domain package and not in `returns-settlement.ts`.** An ESM
module's own internal reads do not go through its exports, so an authority declared inside the
settlement module could not be mutated from a test at all — the mutation would reach the ports
and nothing else, which is exactly the half-proof round 3 shipped. Across the module boundary,
`vi.doMock('@daftar/domain-core')` replaces the binding EVERY reader resolves, so the proof
reaches inside the planners.

**Roles stay separate; only the string is shared.** Three S5 laws name 2200 — the credit-note
entry RAISES the liability, the application DISCHARGES it, and a refund discharges whichever of
2200/2210 its source kind carries. Those are three decisions and they keep three named
authorities (`planCreditNoteReversal`'s own line, `APPLICATION_LIABILITY_ACCOUNT`,
`refundLiabilityAccount`). What they may not each own is the IDENTIFIER. Duplicate authority
over the id is removed; duplicate authority over the decision was never there to remove.

The evidence is `tests/guards/p4s5-account-authority-mutation.test.ts`, a separate file because
it rebuilds the module graph and a reset graph is not a per-test concern:

- **the live set is DISCOVERED, not listed**: every exported `plan*` of the settlement module is
  found by reflection, and the suite asserts the covered scenario set EQUALS it, so a planner
  added later fails until it is covered. A law that only passes where it is asked proves
  nothing;
- **the MUTATION MATRIX**: each of the nine canonical members is replaced in turn with a string
  the chart does not register, and every scenario's observable behaviour is recorded as a
  signature (its refusal code, or its accounts in order). Two statements are then asserted over
  the whole matrix — **every member moves at least one planner** (no dead config member) and
  **every planner is moved by some member** (no string-literal bypass: a planner that behaved
  identically under all nine mutations is holding a literal, which is the only way that
  happens). Each row records that the member was really replaced, read back from the module
  graph the planners were loaded from;
- **the pairings, asserted by index and at the strength the lever actually has** — which is less
  than an earlier draft of this section claimed. 2200 moves the application and the return entry:
  two of the three laws that were three equal literals, and the two whose account-id reads cross
  the module boundary. The third, the refund drawn on a credit note, takes its liability from
  `refundLiabilityAccount` INSIDE the declaring module, so this lever cannot move it; the matrix
  covers that planner through `POSTING_ACCOUNT` and `FX_GAIN` instead, which proves it consumes
  the canonical source without pretending to prove it at the liability line;
- **one member is classified DOMAIN-INTERNAL, and the classification is checked both ways.**
  `CUSTOMER_CREDIT_LIABILITY` has exactly one consumer, `refundLiabilityAccount`, inside the
  declaring module, so no mock of that module's exports can move it. The suite asserts it moves
  NOTHING — if it ever moves something, a real cross-module reader has appeared and the
  classification is stale — and proves it instead by value: the live refund on a customer credit
  debits that canonical member and not the other. **That is an agreement check, not an
  independence check, and the suite says so.** Inside one module there is no drift surface, which
  is exactly why the compensating runtime check a previous round shipped here was a tautology;

**What was DELETED, and why it was worse than the defect it claimed to fix.** Round 3 added a
check in `planCustomerRefund` comparing `refundLiabilityAccount`'s answer against the two
`S5_ACCOUNT` members that function itself returns — the same frozen object read twice through one
module-internal binding. The condition was `x !== A && x !== B` for `x` provably in `{A, B}`:
always false in live code, firing only under this suite's own mock. It was justified in the file
as guarding "a chart rename landed in one file and not the other" — there is no other file — and
the paragraph claimed it made `customer_refund.registry_incomplete` REACHABLE. It did not. A dead
declared member with a comment asserting it is alive is strictly worse than a merely dead one,
because the justification names a mechanism that was never there and therefore cannot notice its
absence. The branch and the paragraph are gone; the code is now OWED, by the SQL chart-of-accounts
registry at level G, which is a genuinely independent authority rather than a second read of the
same object. Deriving the membership set from a different TypeScript source was considered and
rejected: it is new architecture to make one 500 reachable, and §14 forbids that;
- **§14, stated structurally**: no account literal in code in either module (over
  comment-stripped source, so prose cannot satisfy it); exactly ONE map takes an account
  vocabulary to S5 accounts; the canonical table declares each id exactly once and both closed
  entry-account lists are subsets of it; and the mutation lever is asserted to be the real
  authority, since a matrix over a table nobody reads would detect a coincidence.

### 5.1e §15 — the refusal vocabulary has no dead member either

A neighbouring module has just been bitten by the inverse: `customer.aging_buckets_invalid` is
declared in a status registry, thrown NOWHERE in the tree, and a docstring cited it as the check
that justified a 500. S5 then reproduced it in a worse form — see the deletion recorded in §5.1d.

The honest claim about S5's vocabulary is not that every code is live — the route handler and the
SQL routines are owed at levels F and G. It is that the vocabulary PARTITIONS **three ways**, and
the suite asserts the partition is exhaustive and PAIRWISE DISJOINT (every code in exactly one
category, so an owed entry cannot outlive its reason):

1. **RAISED (24 codes)** — a RAISE-SHAPED site in code: thrown through `refuse(` or
   `new ReturnsPlanError(`, or RETURNED as a value by a domain refusal function (`return 'x'`,
   `=> 'x'`, either arm of a conditional, a value after a colon). The domain layer does not throw;
   it answers with a code and the caller refuses with it, so a scanner that knew only `refuse(`
   would call most of this vocabulary dead. A negative lookahead keeps a KEY from counting: the
   status table, the owed table and the type union all put the code to the LEFT of a colon and
   none of them raises anything.
2. **COMPOSED AND PROVED (4 codes)** — `returnsDateRefusal` returns `` `${domain}.date_invalid` ``
   and `` `${domain}.date_in_future` ``, so the only text in the tree is the suffix. A regex that
   accepted the suffix would accept a comment; one that demanded the whole code would call four
   live refusals dead. These are classified by CALLING the live function over a documented input
   matrix and collecting what it returns — a stronger statement than any shape, because it proves
   the code is PRODUCED and not merely written.
3. **OWED (13 codes)** — listed in `RETURNS_CODES_OWED_BY` with the authority NAMED and its level
   given.

**The classifier measures a raise SHAPE and not presence**, which closes the hole the challenger
found: the previous version scanned RAW source, so a code named only in a COMMENT counted as
raised — and that is precisely how `customer_refund.registry_incomplete` came to be reported as
closed. Both views of a source file (comments blanked keeping strings, and prose blanked) are the
gate engineer's own `stripCommentsKeepStrings` / `stripProse` pair, reimplemented locally because
that module is not on this branch, and §14.0 exercises the blanker on a fixture whose answer is
known by inspection — a mis-copied blanker is the one failure that would make every scan in the
file pass for every input.

What the classifier still cannot see is whether a raise-shaped site's condition is REACHABLE. That
is a semantic question, and the one place it mattered is settled by deleting the tautology rather
than by teaching a scanner to find it.

### 5.2 The journal shapes

```
customer_return                              Dr sales_returns (4100)               the WHOLE total, note currency
                                               Cr customer_refund_liability (2200) the same total, ONE conversion
                                             — and NO accounts_receivable line —

the same command's COGS entry                Dr inventory (1200)                   Σ EXACT stored value deltas
                                               Cr cogs (5000)

customer_credit_note_application             Dr customer_refund_liability (2200)   c, at conv_Rn(c)
   — the ONE AR reducer —                      ± the note dust, SAME liability account
                                               Cr accounts_receivable (1100)       a, at conv_R(a) — the INVOICE's snapshot
                                               ± the AR dust, on 1100 itself
                                               ± realized FX = cr_rel − rel — Cr 4900 gain / Dr 6900 loss

customer_refund, source = credit_note        Dr customer_refund_liability (2200)
customer_refund, source = customer_credit    Dr customer_credit_liability (2210)
                                               ± the source dust, SAME liability account
                                               Cr <posting account>
                                               ± realized FX — Cr 4900 gain / Dr 6900 loss
```

Five decisions, each with its law:

- **AR falls in ONE relation, and the amount is the INVOICE's, not the note's.** The note's own
  entry raises the liability for its whole total and carries no `accounts_receivable` line at
  all; every reduction of AR is a `credit_note_applications` row, and every amount on that row
  comes out of the canonical AR arithmetic
  (`planCustomerCreditApplication`, `packages/inventory/src/customer-settlement.ts:593`) reached
  through `planCreditNoteApplication`, which substitutes 2210 for 2200 and changes no number.
  The reason this matters is arithmetic and not stylistic: a note issued at 1.0901 against an
  invoice born at 1.0853 gives `cr_rel = 3 633` and `rel = 3 617` on the same 3 333 applied, and
  only the invoice's own stored `(total, carrying)` pair may say how far ITS receivable falls.
  The 16-minor difference is REALIZED FX on its own line, which is exactly the fact a second AR
  home would have silently booked as revenue. One canonical algorithm for AR, and the AR dust
  line and the realized-FX line that come with it, are therefore present on the application
  entry and unexpressible on the note's;
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

`customer.issue_credit_note`, `customer.refund`. **TWO, not three:** `customer.void_credit_note` is
withdrawn — see the DDL specification §1.5a and `CREDIT_NOTE_HAS_NO_LIFECYCLE`. Voiding an issued
note is a reversal, and reversals are S6 (`A-23`).

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

41 codes, closed union, in `@daftar/domain-core`'s `ReturnsRefusalCode`; classified by an
EXPLICIT TABLE in `apps/api/src/modules/returns/returns-errors.ts`; rendered from
`error.credit_note.*` and `error.customer_refund.*` in all three locale catalogues (956 keys ×
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
- the TWO commands are internal-owned `SECURITY DEFINER` with pinned `search_path` and
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
10a. **A credit note can be VOIDED, or has a status.** It cannot, and it has none. There is no
    `status` column, no `'draft' | 'issued' | 'void'` anywhere, no `customer.void_credit_note`
    operation code, no `setLifecycle` port and no `credit_note.lifecycle_invalid` or
    `credit_note.already_consumed` refusal code. A note is BORN ISSUED by the only command that
    creates one and is thereafter only consumed. Three reasons, each sufficient: the specified
    guard permits exactly one `UPDATE` on `credit_notes` (the remaining pair moving down by one
    backed consumption), so the void command's only action was forbidden by the guard protecting
    the relation it acted on, and so was `draft → issued`; `P4-AL-46` already corrects a
    commercial mistake with a NEW document; and unwinding the posted `4100/2200` and `1200/5000`
    entries is a REVERSAL, which is S6's (`A-23`). A reader who assumes a void exists will look
    for a command, a code and a column that are all deliberately absent — DDL specification
    §1.5a records the deletion.
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

**Read this table as WRITTEN, not as VERIFIED.** Round 3 was carried out under an explicit
instruction to run nothing while the integration estate held the box, so no row below has been
re-confirmed by a runner since the round-2 commit. Every row is design and code in the tree;
the proof is owed at Gate 0-pre.

And this slice IS exposed to the hazard Gate 0-pre names — not hypothetically. Round 3 changed
`packages/domain-core/src/returns.ts` and `packages/shared-contracts/src/returns.ts`, so the
`grep '^packages/.*/src/'` self-check over this branch's own diff is NOT empty here, and a
local typecheck run before the two builds would judge `apps/api` against a domain that still
has a credit-note lifecycle in it.


| level | deliverable | where |
|---|---|---|
| **A** | the pure returns domain: **no** credit-note lifecycle and the record of why (`CREDIT_NOTE_HAS_NO_LIFECYCLE`), the refund source algebra, the closed 41-code refusal vocabulary, the op-code and source-type spellings with the frozen-CHECK validator, the lock order, the transaction boundary, the intent model, the cap, the structural zero, the exact-COGS rule | `packages/domain-core/src/returns.ts` |
| **A** | the plan layer: `planCustomerRefund`, `planCreditNoteReversal`, `consumedSide`, `verifySourceConsumptionChain`, `assertNoReceivableLine`. **No arithmetic of its own** — the four accepted primitives and the chain verifier, imported | `apps/api/src/modules/returns/returns-settlement.ts` |
| **B** | the contracts (8 DTOs) | `packages/shared-contracts/src/returns.ts` |
| **B** | the repository ports, the refusal status table with its two compile-time totality checks, the route authority table | `apps/api/src/modules/returns/returns-ports.ts`, `-errors.ts`, `-permissions.ts` |
| **C** | the unit tests and red proofs across 13 sections, every guard shown able to FAIL on a REAL planted subject read off disk or recorded verbatim in §5.1b — never a value the test wrote into a template literal | `tests/guards/p4s5-refund-plan-red-proofs.test.ts`, `packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts` |
| **C** | the ONE canonical account-id source (`S5_ACCOUNT`), proved by a MUTATION MATRIX over all nine members and the DISCOVERED live planner set — every member moves a planner, every planner is moved — plus the refusal vocabulary's dead-member partition | `tests/guards/p4s5-account-authority-mutation.test.ts` |
| **C** | the FOUR cap-race concurrency MODELS and one CAP PROPERTY (which is not a race, and no longer claims to be) — deterministic, barrier-based, **no sleep, no timer** — each with a red proof that the broken protocol overdraws | `tests/guards/p4s5-refund-cap-concurrency-models.test.ts` |
| **D** | the API surface (7 routes), and localization in ar/en/tr (41 keys × 3; `check:localization` PASS at 956 × 3) | `-permissions.ts`; `apps/web/src/messages/{ar,en,tr}.json` |
| **E** | the DDL **specification**: 4 relations, the full FK map, CHECKs, indexes, RLS policies, triggers, expected catalogue shape, upgrade expectations. **No `.sql`. No number.** | `docs/PHASE_4_S5_DDL_SPECIFICATION.md` |
| — | 8 patch requests | `docs/patch-requests/PATCH-REQ-S5-001…008.md` |

### The checklist that would make it YES

Nothing on it can be done before S4 seals and this slice is promoted.

**Gate 0 — the predecessor**
- [ ] S4 SEALED. Its migration prefix is final and `frozenThrough` has advanced.
- [ ] **Every A-1…A-23 assumption of §2 diffed against the sealed tree**, each marked CONFIRMED
      or REFUTED, and every refutation's consequence worked through before any SQL is written.
      The five of §2.1 are the ones most likely to move.
- [ ] S5 promoted, and a migration prefix ASSIGNED by the single migration owner.

**Gate 0a — `TL-P4-S5-R2`'s own preconditions, which are not mine to waive**
- [x] the second AR reducer REMOVED from the design (commit on `p4s5/owner`, F1).
- [x] the AR side derived through the canonical arithmetic by CALLING it.
- [x] the application write shape able to persist EVERY `NOT NULL`-no-default column of §3 the command owns — fifteen, derived from the specification rather than listed, which is how `credit_note_id` was found still missing after round 3's first widening — and a MAPPER, `creditNoteApplicationRow`, that produces a row whose money columns are checked against the entry's own lines.
- [x] the seven red proofs written, each on a real planted subject, all green-and-provably-red.
- [x] `TL-P4-S5-R3` implemented as the RATE comparison it is, with all eleven required cases
      and the §16 sign-symmetry property (§5.1c).
- [x] `TL-P4-S5-R2` §13/§14: ONE canonical account-id source (`S5_ACCOUNT` in the domain
      package), proved by a mutation matrix over every member and the discovered live planner
      set, plus the refusal vocabulary's dead-member partition (§5.1d, §5.1e).
- [ ] the LIVE golden (Gate 3) — owed at level F, specified in Gate 3 above.
- [ ] S4 SEALS.
- [ ] the independent challenger SIGNS.
- [ ] the coordinator has READ the actual diff.
- [ ] the CONTRACT_DIFF against the sealed S4 is COMPLETE.
- [x] the REGISTRATION TRIANGLE counted against itself: 3 source types × 4 duties of
      `TL-P4-S1-R1` = **12 cells**, all 12 filled by a named object in the DDL specification,
      plus the trigger column that the first draft left EMPTY for all three. §5.6.1 of the
      specification holds the table; §7 items 9 and 10 check it against `pg_proc` and
      `pg_trigger` rather than against the table, and state that **item 9 without item 10 is
      the defect §5.6.1 records** — a validator function that no trigger fires is the dead
      concept `TL-P4-S1-R1` named, one level down from where it was first ruled against.
**No migration number is reserved, requested or illustrated until every line above is ticked.**

**Gate 0-pre — THE BUILD ORDER, because a stale `dist/` makes a typecheck LIE**

This is not a database item and it is not optional. It is the first thing to run when the box
is released, before any typecheck, and it is recorded here because the measurement that proves
it is a fact about this repository's module resolution and not a precaution.

- `packages/domain-core/package.json` declares `"types": "dist/index.d.ts"`;
- `tsconfig.base.json`, which `apps/api/tsconfig.json` extends, has **no `paths` block**;
- so `apps/api` resolves `@daftar/domain-core` and `@daftar/shared-contracts` through
  `node_modules/@daftar/*` → the package root → **`dist/`**;
- while the ROOT `tsconfig.json` — the one that covers `tests/**` and `scripts/**` — DOES map
  both to `./packages/*/src`.

**The API typecheck and the test typecheck therefore read DIFFERENT COPIES of the domain.** The
workspace half of `npm run typecheck` judges `apps/api` against the last BUILD; the root half
judges `tests/**` and `scripts/**` against the new SOURCE. An untracked
`packages/domain-core/dist/returns.d.ts` left over from before round 3 still declares
`CreditNoteLifecycleState`, `isCreditNoteLifecycleTransitionAllowed`, `creditNoteVoidRefusal`
and a THREE-member `S5_OPERATION_CODES` including `customer.void_credit_note`. Against that
copy the API typechecks GREEN over an API that no longer exists — and, worse in the other
direction, it does not yet know `credit_note.date_invalid` or `customer_refund.date_invalid`,
so `returns-errors.ts`'s compile-time totality check over `ReturnsRefusalCode` would be judged
against the OLD union and would report either nothing or the wrong thing. A green typecheck
read off a stale `dist/` is worse than a red one, because it is believed. `dist/` is
gitignored, so there is no version of it to inspect after the fact.

#### THE HAZARD IS LOCAL ONLY, AND THAT IS WORSE RATHER THAN BETTER

Stated because the paragraph above, left alone, would read as a defect in the pipeline, and it
is not one. **CI does not have this defect.** `.github/workflows/ci.yml:91-93` builds
`domain-core`, `shared-contracts` and `design-system`, then `accounting`, then `inventory`, and
only reaches `npm run typecheck` at `:124` — so CI always typechecks against a fresh build.

The hazard is entirely in the LOCAL run, which is worse, because the local run is the one a
worker reports upward as proof and the one a coordinator would sign. CI would have caught this
slice's stale-`dist/` green at the merge; a hand-reported local green would have carried it
past a human first.

Two corrections to the record, both of which narrow my own claim rather than widening it:

- the stale `void_credit_note` declaration is **this worktree's own build output**, not the
  main checkout's. The main tree has a `packages/domain-core/dist/` directory built
  2026-10-07 15:40Z and no `returns.d.ts` in it at all, because that build predates the module
  split this worktree carries. A reader must not conclude that the main checkout is sitting on
  a stale domain;
- the rule cuts both ways and is cheap to apply to oneself: a worker whose commits touched no
  `packages/*/src/` file was NOT exposed, and `git diff --name-only <base>..<head> | grep
  '^packages/.*/src/'` returning nothing is the one-line way to prove it. A clean local run is
  trustworthy exactly when that grep is empty.

So the order is fixed, and it is a STANDING ORDER for every DAFTAR worker rather than an S5
note — with the other built packages added whenever a change reaches them (`accounting` and
`inventory` after `domain-core`, in CI's own order):

1. `npm run build -w @daftar/domain-core`
2. `npm run build -w @daftar/shared-contracts`
3. then `format`, `lint`, `typecheck` over the WHOLE tree, `$?` read each time
4. then the S5 suites, `check:localization`, `gate:phase4:s4 --structural-only`

**H3's sweep is recorded as DESIGN ONLY, not PROVEN BY TEST, until step 1 has happened** — and
so is the claim that the widened identity type and the `satisfies Record<…>` surface the errors
this slice expects. The sweep's assertions read the SOURCE through the root `tsconfig`'s
`paths`, so they are a statement about the design that is true today; what they cannot yet
state is that the API compiles against the same domain the tests read.

**Gate 0b — the TWO confirmations owed to the DATABASE, with their exact commands**

Both findings behind them stand on the specification and the type as written, which are the
artefacts under review and are self-contained. These are the DEMONSTRATIONS, owed at level F,
and neither may be run before the box is released and a cluster exists.

- [ ] **H1, against a built cluster.** `\dft journal_entries`, plus

      ```sql
      SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
       WHERE tgrelid = 'journal_entries'::regclass AND tgconstraint <> 0;
      SELECT proname FROM pg_proc WHERE proname LIKE 'accounting_customer_%entry_complete';
      ```

      The first must return THREE new rows naming the three S5 source types in their `WHEN`
      clauses; the second must return the three functions. Three functions and two triggers is
      a FAIL, not a rounding.
- [ ] **H2, the insert itself.** An `INSERT INTO credit_note_applications (…)` naming only the
      SEVEN fields of the pre-correction write shape (recorded verbatim in §5.1b(c)) must fail
      with `null value in column "credit_currency" violates not-null constraint` — and the same
      insert naming the fifteen fields `creditNoteApplicationRow` produces must succeed.

**Gate 1 — the patch requests**
- [ ] `PATCH-REQ-S5-001` landed (the **TWO** op codes in the inventory vocabulary; `customer.void_credit_note` withdrawn in round 3).
- [ ] `PATCH-REQ-S5-002` landed (three source types + the reversal guard, in ONE change).
- [ ] `PATCH-REQ-S5-003` landed (the five `CREATE OR REPLACE`s, in a NEW migration).
- [ ] `PATCH-REQ-S5-005` landed (`credit_note_applications` in `FINANCIAL_CORE`) **in the same
      change that creates the relation**, with its red proof.
- [ ] `PATCH-REQ-S5-006` landed (CI chain row + workflow step + `package.json` + the gate
      script + measured budgets) — (b) and (c) together or neither.
- [ ] `PATCH-REQ-S5-007` landed or formally withdrawn as already fixed.
- [ ] `PATCH-REQ-S5-004` applied (the plan layer relocated, with its vectors file).
- [ ] `PATCH-REQ-S5-008` applied (the liability account parameterized in `creditLines`), after
      which `planCreditNoteApplication`'s relabelling of 2210 to 2200 is deleted and its
      delegation to the canonical AR arithmetic is total.

**Gate 2 — level F, the real DB binding**
- [ ] the migration written by the single migration owner, from the §E specification, under the
      assigned prefix, ending with the §7 catalogue block.
- [ ] §4.6 of the specification RESOLVED by measurement: the dust identity either expressible in
      a row `CHECK` through `supplier_convert_base`, or moved to the deferred validator.
      **Not by a new rounding function.**
- [ ] `cogs_reversal_base_minor` re-measured against `DERIVED_COST_COLUMN`. If it matches, the
      COLUMN is renamed; the guard is not relaxed.
- [ ] the TWO commands, the two reads, the THREE deferred completeness validators AND THE THREE `journal_entries` CONSTRAINT TRIGGERS THAT FIRE THEM written,
      each internal-owned, `search_path`-pinned, `REVOKE ALL … FROM PUBLIC`.
- [ ] the services, the controller and the module registration, every refusal path reaching the
      ONE `auditThenRethrow…` composer (P4-AL-48 — never a second copy).
- [ ] `npm run check:db-from-zero` PASS.

**Gate 3 — level G, the integrated gate**
- [ ] **the owed financial test / the `TL-P4-S5-R2` LIVE GOLDEN**
      (`docs/PHASE_4_DECISION_REGISTER.md:267-285`, and the owner's ruling). "Live" means
      against a real database, so it is owed HERE and specified — never faked at A–E. The
      sequence is the ruling's, in order, each step asserted and not merely performed:
      1. open a CREDIT invoice for a named customer, in a non-base currency so the FX terms
         are non-zero and the dust is reachable;
      2. make the credit-note effect — the `customer.issue_credit_note` command, which raises
         `customer_refund_liability` for the note's whole total and posts the COGS reversal;
      3. **verify AR falls EXACTLY ONCE**: `invoice_outstanding` before and after the
         application, the single `credit_note_applications` row, and the single
         `accounting_entry_lines` row on 1100 for that economic amount — counted, not sampled;
      4. verify the AR amount is the INVOICE's canonical release and not the note's
         conversion, by recomputing it from the invoice's stored `(total, carrying)` pair;
      5. refund the resulting liability through `customer.refund`;
      6. **verify the invoice outstanding does NOT fall again** — the same
         `invoice_outstanding` reading as after step 3, to the minor unit;
      7. verify CASH moves: the posting account's net movement equals the disbursement base;
      8. verify the LIABILITY moves: `customer_refund_liability`'s net movement equals the
         carrying the source released, dust line included;
      9. verify the GL BALANCES and that `invoice_outstanding` AGREES WITH THE JOURNAL — the
         AR account's net movement over the whole sequence equals the fall in outstanding,
         converted through the invoice's own snapshot, with no one-minor drift.
      **Every write through the product's own commands — no `refunds`, `credit_notes` or
      `credit_note_applications` row inserted by hand**, and the seven red proofs of §5.1a
      re-run against the real relations so each is shown able to go red with a database
      underneath it.
- [ ] the FOUR cap races re-run **against a real database**, barrier-based and never timed, and
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
