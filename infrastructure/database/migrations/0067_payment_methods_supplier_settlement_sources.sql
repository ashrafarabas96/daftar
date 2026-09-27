-- 0067_payment_methods_supplier_settlement_sources.sql
-- P3-S6, part 1 — the SOURCE side of payment methods and supplier
-- settlement: the payment-method foundation, supplier payments with their
-- allocations, supplier credit allocations and supplier refunds; the one
-- candidate key on an S5 table; every inventory-owned arithmetic function,
-- verification helper and guard; the owner replacement of the S5 credit-note
-- guard and the re-recorded S5 source-guard discovery; the two replaced S5
-- extension points; the S6 guard discovery; the accounting-owned objects
-- (the three completeness triggers, the settlement-account eligibility, the
-- owner-replaced reversal guard) and the three accounting registrations, LAST
-- (docs/PHASE_3_S6_CONTRACT.md §2.1-§2.4, §2.7, §2.9, A-01-A-17, A-22).
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- It registers no inventory operation kind, so after it no signed command can
-- write a single new row: the runtime reach is 0068's, and only 0068's. It
-- adds no stock source type, movement kind, op→movement mapping or bridge: no
-- S6 command moves stock. It creates no customer-payment object (MP-7), no
-- reversal of a payment, allocation or refund (TL-2 / TD-15), no supplier
-- advance (TL-3) and no stored balance (AL-26). Nothing here carries or
-- computes an element OD-03 reserves (A-21).
--
-- ── Header rules (§2.1) ─────────────────────────────────────────────────
--
--   R-60 THE GLOBAL LOCK ORDER, extended (never reordered) from 0063 R-15 and
--        0065 R-34. Every S6 path skips the steps it has no use for:
--          1   assertion consume                          (no lock)
--          2   the per-document advisory key              ('daftar.payment_method_id' |
--                                                          'daftar.supplier_payment_id' |
--                                                          'daftar.supplier_credit_allocation_id' |
--                                                          'daftar.supplier_refund_id')
--          2a  purchases FOR UPDATE, in id order          (supplier.pay: every allocated
--                                                          purchase; allocate_credit: the target)
--          2a' supplier_credit_notes FOR UPDATE           (allocate_credit, receive_refund)
--          2b  the supplier FOR SHARE                     (the three settlement commands)
--          2c  the payment method FOR SHARE               (supplier.pay, receive_refund) |
--              FOR UPDATE at step 2's row                 (the four method commands)
--          3-6 (not used by S6)
--          7   accounting_post_entry, one per allocation, credit allocation or refund
--        A receipt, return or reversal takes its own key and then the purchase
--        row; S6 takes its own key and then purchase rows in id order. No S4/S5
--        path locks a credit note or a payment method, so 2a'/2c add no cycle.
--        AL-24 (receive and pay) takes the payment key FIRST, in the seam
--        callback, before the receipt's purchase key (A-11, A-19).
--   R-61 AP CARRYING (A-08), shared with S5. For a purchase T = total_txn,
--        B = total_base, R = its snapshot rate, O = purchase_ap_outstanding,
--        X = T − O. rel = ap_release(B, T, X, a)
--        = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T) (0065 R-35 exactly): never
--        negative, and at X + a = T the remaining B is released exactly.
--        conv_R(x) = HALF_EVEN(x·R·10^max(0,e_b−e_t), 10^max(0,e_t−e_b)) (the
--        0043 law); ap_dust = rel − conv_R(a), a base-only AP line.
--   R-62 THE PURCHASE CHAIN (A-08). Over every AP reducer of a purchase with a
--        positive amount — S5 supplier_returns (ap_txn_minor), S6
--        supplier_payment_allocations and supplier_credit_allocations
--        (purchase_amount_applied_minor) — ordered by X: each row's X is the
--        sum of the amounts before it, each row's release is ap_release of its
--        X, Σ amount ≤ T and Σ rel = HALF_EVEN(B·Σ amount, T).
--        `purchase_settlement_verify` proves it at COMMIT on every S6 reducer:
--        two writers that computed from the same O overlap and are refused
--        (`supplier_payment.settlement_inconsistent`) even if a lock were
--        missing — the physical half of MP-3 / PM-12. It keeps 0065 R-54 true
--        by construction: an S5 return's X counts the S6 reducers before it,
--        so X ≥ Σ other-transaction ap_txn, and Σ ap_txn ≤ Σ amount ≤ T.
--   R-63 CREDIT CONSUMPTION AND ITS CHAIN (A-10, AL-31). For a note
--        OA = original, OB = original carrying, the remaining carrying is
--          g(0) = 0, g(r) = max(1, OB − HALF_EVEN(OB·(OA − r), OA)) for r > 0,
--        and credit_release(OA, OB, rb, c) = g(rb) − g(rb − c): a cumulative
--        proportional share, and at rb = c the entire remaining residue. The
--        stored pair is always (r, g(r)) and reaches (0, 0) together. Over the
--        note's consumers (credit allocations ∪ refunds) ordered by rb
--        descending: each rb = OA − Σ earlier c, the stored remaining is
--        OA − Σ c, the stored carrying is g of it and Σ release = OB − g(r).
--        `supplier_credit_note_verify` proves it at COMMIT (PM-15 as a guard).
--   R-64 REALIZED FX (A-05, A-09). Every allocation, credit allocation and
--        refund stores realized_fx_gain_loss_minor: pb − rel, cr_rel − rel and
--        mb − cr_rel respectively — the difference of two stored integers. Its
--        line goes to `fx_loss` (6900) or `fx_gain` (4900) by table and sign,
--        and the completeness triggers admit no line on any other account:
--        never 6100, never 6200 (AL-28, MP-4).
--   R-65 THE SETTLEMENT-ACCOUNT POLICY (A-06, TL-6). A method's posting
--        account is in the same business (composite FK), active, of type
--        asset, and has system_key NULL or one of cash, bank, card_clearing,
--        wallet_clearing, cheque_clearing — stated once, in
--        `accounting_settlement_account_eligibility`, and checked at create,
--        activate, an account change and every payment or refund.
--   R-66 THE CREDIT-NOTE GUARD, replaced BY ITS OWNER (A-12, S5 TL-13).
--        DELETE and any UPDATE that is not one backed AL-31 decrement of both
--        remaining values are refused `supplier_credit_note.immutable`; the
--        backing consumer row (this transaction's, created now, naming the
--        note, the old remaining and exactly the two decrements) must exist
--        BEFORE the UPDATE. The trigger `supplier_credit_notes_immutable` is
--        unchanged (tgtype 27, no WHEN).
--   R-67 THE EXTENSION POINTS (A-13, S5 A-16, TL-9), replaced by the migrator:
--        `purchase_ap_outstanding` is the S5 body with exactly two more
--        subtraction terms; `purchase_settlement_state` is EXISTS over each
--        allocation table. Both stay migrator-owned INVOKER STABLE pinned
--        with the S5 ACL. The physical twin of S5 A-09(a)(b) is the new
--        deferred `purchase_reversals_unsettled` trigger.
--   R-68 THE REVERSAL GUARD (A-14(c)), replaced BY ITS OWNER: 0065's body with
--        the always-refused IN list extended by supplier_payment,
--        supplier_credit_allocation and supplier_refund; the purchase pairing
--        clause and the R-13 block verbatim. No S6 entry is undone by a
--        generic Phase 2 reversal (PM-16, TL-2).
--
-- ── The 0063 review hardenings, carried forward to every S6 object ──────
--
--   0063 R-34 (guards judge INSERT): every S6 table has a BEFORE INSERT OR
--        UPDATE OR DELETE guard (tgtype 31) that judges the insert as well as
--        refusing change; each deferred value guard is AFTER INSERT (tgtype 5).
--   0063 R-35 (per-command restrictive RLS): business_isolation_read /
--        _insert / _update / _delete are four RESTRICTIVE policies; only
--        _read admits an internal principal by name.
--   0063 R-36 (same-transaction details): an allocation joins only a payment
--        created by this very transaction; a method's names change only with
--        a revision of the method in this transaction; a credit-note
--        decrement is backed only by a consumer of this transaction.
--   0063 R-37 (fail closed): no S6 guard exempts anything on a session GUC.
--   0063 R-38 (the discovery sees every guard): `supplier_settlement_guard_gaps()`
--        reports each of the thirteen S6 triggers and every S6 guard, helper
--        and arithmetic body by digest; the S5 discovery re-records the
--        replaced credit-note guard (0065 R-53).
--   0063 R-40 (probes as a non-superuser): every 0067-E probe reads the
--        catalogue and runs inside a rolled-back block; a probe that replaces
--        an internal body lends CREATE on public inside the block only.
--   0063 R-41 (no unclassified code): every S6 guard raises a code of §3.
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-69 L2 · HOW AN ALLOCATION MEETS A TXN-ONLY AP RESIDUE (coordinator
--        header, S5 TL-3; case (b) rewritten by R-77). Two cases, both
--        decided here and proven by 0067-E arithmetic and the S6 suites:
--        (a) ABSORBED. The remaining AP base B − HALF_EVEN(B·X, T) is 0 while
--            the txn residue O > 0 and conv_R(O) ≥ 1. The final allocation
--            a = O is lawful: rel = 0, its AP line carries conv_R(a) at the
--            purchase snapshot, the base-only dust line carries −conv_R(a),
--            and the whole payment (or credit) base is realized FX. AP txn
--            and AP base both reach exactly 0 — the DM §7ج "the final
--            consumption releases the entire residue" rule, with nothing left.
--        (b) A SUB-UNIT RESIDUE: 0 < O and conv_R(O) = 0, i.e.
--            2·O·R·10^max(0,e_b−e_t) ≤ 10^max(0,e_t−e_b) (HALF_EVEN sends the
--            tie to 0). It IS reachable with the seeded pilot currencies:
--            0001 seeds TRY, LBP and SYP at exponent 2, and in an ILS-base
--            business one kurus at 0.11 converts to 0.11 agora → 0. No
--            allocation can clear it: a = O needs an AP line of base 0,
--            which 0042's journal_lines_money_cap_ck (base > 0) and the 0043
--            per-line law forbid, and a > O is over-allocation (MP-3).
--            S6 NEVER CREATES ONE (R-77): every allocation leaves O − a = 0
--            or conv_R(O − a) ≥ 1, in the routine and at COMMIT. One can
--            still ARISE from a frozen S5 partial return: 0066 releases
--            ap = least(C, O) and leaves O − ap under no such rule (S5 review
--            L2) — e.g. T = 5000 TRY at 0.11, a return carrying C = 4999
--            leaves O = 1 (or S6 leaves O = 10, conv 1, and a return of 9
--            leaves 1). Such a purchase then stays open, and:
--              · supplier.pay / supplier.allocate_credit applying any
--                0 < a ≤ O (conv is monotone, so conv_R(a) = 0) are 422
--                `supplier_payment.amount_below_base_unit` /
--                `supplier_credit_allocation.amount_below_base_unit`; a > O
--                is 422 `…amount_exceeds_outstanding`;
--              · purchase.return of any remaining goods with a carrying
--                amount C > 0 is 422 `supplier_return.amount_below_base_unit`
--                (0066: ap = least(C, O) > 0 converts to 0);
--              · purchase.reverse is 409 `purchase_reversal.returned` (the
--                return that left the residue exists), preceded by
--                `purchase_reversal.payment_allocated` / `…credit_allocated`
--                when an S6 allocation exists (0066 step 6 order).
--            That boundary — reachable only through S5's least(C, O) split —
--            is recorded as debt: the residue stays open until a write-off
--            command (not in Phase 3) exists. A credit note never carries
--            one: it is born with conv_Rn(OA) = OB ≥ 1 (0066 refuses a
--            credit converting to 0), and R-78 keeps every remaining r at
--            0 or conv_Rn(r) ≥ 1.
--   R-70 THE DISCOVERIES. (a) `supplier_settlement_guard_gaps()` records the
--        SHA-256 of prosrc (the 0063/0065 digest, not the contract's md5) of
--        eighteen functions: the thirteen trigger functions, the two verify
--        helpers AND the three arithmetic functions the guards compute with —
--        a neutered arithmetic body would weaken every guard at once, so it
--        is reported too — and, since R-79, the two extension points (twenty
--        here, twenty-one with 0068's writer). (b) Coordinator ruling (overrides §7.1): the owner
--        replacement of `supplier_credit_note_guard()` makes 0065's
--        `inventory_stock_source_guard_gaps()` report its recorded digest, so
--        that function is replaced here by the migrator, same signature,
--        owner, security, path and ACL, with every S3/S4/S5 row and all forty
--        other digests verbatim and only the credit_note_immutable digest
--        re-recorded. Both discoveries therefore see the credit-note guard.
--   R-71 THE METHOD AND NAME GUARDS judge the trace too (0063 R-36): an
--        UPDATE of a method must carry updated_at = now() and this
--        transaction's trace, so a name can only follow a real revision; a
--        method is born at revision 1, active, with both intents equal. Any
--        other shape is `payment_method.field_immutable` (a guard-only code).
--   R-72 0067-E(5)'s "arbitrary non-member probe role" is PUBLIC: a
--        non-superuser migrator holds no CREATEROLE (R-40), so the block reads
--        `has_table_privilege('public', …)` instead of creating a role.
--
-- ── Review rulings (S6 independent review, M1 and I1) ───────────────────
--
--   R-77 NO SUB-UNIT AP RESIDUE (review M1, coordinator ruling; supersedes
--        the contract's TL-9 reading "unreachable for the pilot
--        currencies", which is false: see R-69(b)). An allocation of a to a
--        purchase with outstanding O is lawful only if O − a = 0 or
--        conv_R(O − a) ≥ 1, at the purchase's snapshot R (the conversion
--        the AP line uses). Otherwise it is refused, before any write, by
--        422 `supplier_payment.residue_below_base_unit` (supplier.pay,
--        receive-and-pay) or `supplier_credit_allocation.residue_below_base_unit`
--        (supplier.allocate_credit), judged after `…amount_below_base_unit`.
--        The COMMIT guards `supplier_payment_allocation_value_complete` and
--        `supplier_credit_allocation_value_complete` judge the same on the
--        stored row (O − a = T − X − a), so a forged row cannot create one.
--        Repro closed: T = 5000 TRY, B = 550; paying 4999 is refused, 4995
--        (O − a = 5, conv 1) and 5000 are accepted.
--   R-78 NO SUB-UNIT NOTE RESIDUE (the note-side twin of R-77). A
--        consumption of c from a note at remaining rb is lawful only if
--        rb − c = 0 or conv_Rn(rb − c) ≥ 1 at the note's snapshot Rn (the
--        conversion its receivable line uses); otherwise 422
--        `supplier_credit_allocation.residue_below_base_unit` /
--        `supplier_refund.residue_below_base_unit`, per command as every
--        other S6 amount code, in the routine and in the COMMIT guards
--        `supplier_credit_allocation_value_complete` and
--        `supplier_refund_value_complete`. Without it a note left at a
--        remaining r with conv_Rn(r) = 0 could never be consumed again
--        (every c ≤ r converts to 0: `…amount_below_base_unit`).
--   R-79 THE DISCOVERY SEES THE EXTENSION POINTS AND THE WRITER (review I1).
--        `supplier_settlement_guard_gaps()` also records the prosrc SHA-256
--        of `purchase_ap_outstanding` and `purchase_settlement_state`
--        (migrator-owned INVOKER: reported `function_owner` unless owned
--        by the discovery's own owner, `function_not_invoker` if DEFINER,
--        `function_search_path`, `function_body`), so replacing either is
--        reported. `supplier_credit_note_consume` is created by 0068, so
--        0068 re-creates the discovery (same signature, owner, INVOKER
--        STABLE, pinned path, no grantee) with every row here verbatim and
--        the writer's row added; 0067-E and 0068-E probe the new rows.
--
-- Migrations 0000-0066 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The candidate key on the S5 credit-note table (§2.1(2), A-22). It
--    contains the primary key, so it validates on any data.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE supplier_credit_notes ADD CONSTRAINT supplier_credit_notes_supplier_uq UNIQUE (business_id, id, supplier_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The six tables (§2.2, A-04, A-06, A-07).
--
-- Money is BIGINT minor units bounded by ±10^18, rates NUMERIC(20,10) exact
-- at ten places. No column names a balance, an outstanding, a paid or a due
-- amount (G-3 as extended): every open amount is derived (AL-26).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE payment_methods (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  system_type             TEXT NOT NULL CHECK (system_type IN ('cash', 'card', 'bank_transfer', 'wallet', 'cheque', 'other')),
  posting_account_id      UUID NOT NULL,
  is_active               BOOLEAN NOT NULL,
  requires_reference      BOOLEAN NOT NULL,
  sort_order              INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 10000),
  revision                INTEGER NOT NULL CHECK (revision >= 1),
  create_intent_sha256    TEXT NOT NULL CHECK (create_intent_sha256 ~ '^[0-9a-f]{64}$'),
  last_intent_sha256      TEXT NOT NULL CHECK (last_intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID NOT NULL REFERENCES users (id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT payment_methods_account_uq UNIQUE (business_id, id, posting_account_id),
  CONSTRAINT payment_methods_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT payment_methods_account_fk
    FOREIGN KEY (business_id, posting_account_id) REFERENCES accounts (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON payment_methods FROM PUBLIC;

CREATE INDEX payment_methods_sort_idx ON payment_methods (business_id, sort_order);

CREATE TABLE payment_method_names (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  payment_method_id UUID NOT NULL,
  locale            TEXT NOT NULL CHECK (locale IN ('ar', 'en', 'tr')),
  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)),
  PRIMARY KEY (business_id, payment_method_id, locale),
  CONSTRAINT payment_method_names_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT payment_method_names_method_fk
    FOREIGN KEY (business_id, payment_method_id) REFERENCES payment_methods (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON payment_method_names FROM PUBLIC;

CREATE TABLE supplier_payments (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  supplier_id             UUID NOT NULL,
  payment_method_id       UUID NOT NULL,
  posting_account_id      UUID NOT NULL,
  currency_code           CHAR(3) NOT NULL,
  amount_minor            BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_to_base_rate    NUMERIC(20,10) NOT NULL CHECK (payment_to_base_rate > 0 AND payment_to_base_rate = trunc(payment_to_base_rate, 10)),
  rate_source             TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),
  rate_timestamp          TIMESTAMPTZ NOT NULL CHECK (rate_timestamp = date_trunc('second', rate_timestamp)),
  fx_rate_id              UUID,
  base_amount_minor       BIGINT NOT NULL CHECK (base_amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_date            DATE NOT NULL,
  reference               TEXT CHECK (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 100 AND reference = btrim(reference))),
  allocation_count        INTEGER NOT NULL CHECK (allocation_count BETWEEN 1 AND 50),
  intent_sha256           TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_payments_identity_uq UNIQUE (business_id, id, supplier_id, currency_code),
  CONSTRAINT supplier_payments_rate_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND payment_to_base_rate = 1)),
  CONSTRAINT supplier_payments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_payments_supplier_fk FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payments_method_fk
    FOREIGN KEY (business_id, payment_method_id, posting_account_id)
    REFERENCES payment_methods (business_id, id, posting_account_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payments_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT supplier_payments_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON supplier_payments FROM PUBLIC;

-- A supplier's payments (the A-18 read) and the method-in-use test (A-06).
CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (business_id, supplier_id);
CREATE INDEX supplier_payments_method_idx ON supplier_payments (business_id, payment_method_id);

CREATE TABLE supplier_payment_allocations (
  tenant_id                             UUID NOT NULL,
  business_id                           UUID NOT NULL,
  id                                    UUID NOT NULL,
  payment_id                            UUID NOT NULL,
  supplier_id                           UUID NOT NULL,
  purchase_id                           UUID NOT NULL,
  line_no                               INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  payment_currency                      CHAR(3) NOT NULL,
  payment_amount_minor                  BIGINT NOT NULL CHECK (payment_amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_to_base_rate                  NUMERIC(20,10) NOT NULL CHECK (payment_to_base_rate > 0 AND payment_to_base_rate = trunc(payment_to_base_rate, 10)),
  payment_base_amount_minor             BIGINT NOT NULL CHECK (payment_base_amount_minor BETWEEN 1 AND 1000000000000000000),
  purchase_currency                     CHAR(3) NOT NULL,
  purchase_amount_applied_minor         BIGINT NOT NULL CHECK (purchase_amount_applied_minor BETWEEN 1 AND 1000000000000000000),
  purchase_historical_to_base_rate      NUMERIC(20,10) NOT NULL
    CHECK (purchase_historical_to_base_rate > 0 AND purchase_historical_to_base_rate = trunc(purchase_historical_to_base_rate, 10)),
  ap_released_before_txn_minor          BIGINT NOT NULL CHECK (ap_released_before_txn_minor BETWEEN 0 AND 1000000000000000000),
  purchase_carrying_base_released_minor BIGINT NOT NULL CHECK (purchase_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  ap_dust_base_minor                    BIGINT NOT NULL CHECK (ap_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  realized_fx_gain_loss_minor           BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type                TEXT NOT NULL GENERATED ALWAYS AS ('supplier_payment') STORED,
  binding_source_id                     UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_payment_allocations_line_no_uq UNIQUE (business_id, payment_id, line_no),
  CONSTRAINT supplier_payment_allocations_purchase_uq UNIQUE (business_id, payment_id, purchase_id),
  CONSTRAINT supplier_payment_allocations_realized_ck
    CHECK (realized_fx_gain_loss_minor = payment_base_amount_minor - purchase_carrying_base_released_minor),
  CONSTRAINT supplier_payment_allocations_same_currency_ck
    CHECK (payment_currency <> purchase_currency OR payment_amount_minor = purchase_amount_applied_minor),
  CONSTRAINT supplier_payment_allocations_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT supplier_payment_allocations_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_payment_allocations_payment_fk
    FOREIGN KEY (business_id, payment_id, supplier_id, payment_currency)
    REFERENCES supplier_payments (business_id, id, supplier_id, currency_code) ON DELETE RESTRICT,
  CONSTRAINT supplier_payment_allocations_purchase_fk
    FOREIGN KEY (business_id, purchase_id, supplier_id) REFERENCES purchases (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payment_allocations_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON supplier_payment_allocations FROM PUBLIC;

-- The purchase's reducers (R-62, A-13, A-18).
CREATE INDEX supplier_payment_allocations_purchase_idx ON supplier_payment_allocations (business_id, purchase_id);

CREATE TABLE supplier_credit_allocations (
  tenant_id                             UUID NOT NULL,
  business_id                           UUID NOT NULL,
  id                                    UUID NOT NULL,
  supplier_id                           UUID NOT NULL,
  credit_note_id                        UUID NOT NULL,
  purchase_id                           UUID NOT NULL,
  allocation_date                       DATE NOT NULL,
  credit_currency                       CHAR(3) NOT NULL,
  credit_amount_consumed_minor          BIGINT NOT NULL CHECK (credit_amount_consumed_minor BETWEEN 1 AND 1000000000000000000),
  credit_to_base_rate                   NUMERIC(20,10) NOT NULL CHECK (credit_to_base_rate > 0 AND credit_to_base_rate = trunc(credit_to_base_rate, 10)),
  credit_remaining_before_minor         BIGINT NOT NULL CHECK (credit_remaining_before_minor BETWEEN 1 AND 1000000000000000000),
  credit_carrying_base_released_minor   BIGINT NOT NULL CHECK (credit_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  credit_dust_base_minor                BIGINT NOT NULL CHECK (credit_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  purchase_currency                     CHAR(3) NOT NULL,
  purchase_amount_applied_minor         BIGINT NOT NULL CHECK (purchase_amount_applied_minor BETWEEN 1 AND 1000000000000000000),
  purchase_historical_to_base_rate      NUMERIC(20,10) NOT NULL
    CHECK (purchase_historical_to_base_rate > 0 AND purchase_historical_to_base_rate = trunc(purchase_historical_to_base_rate, 10)),
  ap_released_before_txn_minor          BIGINT NOT NULL CHECK (ap_released_before_txn_minor BETWEEN 0 AND 1000000000000000000),
  purchase_carrying_base_released_minor BIGINT NOT NULL CHECK (purchase_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  ap_dust_base_minor                    BIGINT NOT NULL CHECK (ap_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  realized_fx_gain_loss_minor           BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  intent_sha256                         TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id               UUID NOT NULL,
  created_by                            UUID NOT NULL REFERENCES users (id),
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type                TEXT NOT NULL GENERATED ALWAYS AS ('supplier_credit_allocation') STORED,
  binding_source_id                     UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_credit_allocations_level_uq UNIQUE (business_id, credit_note_id, credit_remaining_before_minor),
  CONSTRAINT supplier_credit_allocations_consumed_ck CHECK (credit_amount_consumed_minor <= credit_remaining_before_minor),
  CONSTRAINT supplier_credit_allocations_realized_ck
    CHECK (realized_fx_gain_loss_minor = credit_carrying_base_released_minor - purchase_carrying_base_released_minor),
  CONSTRAINT supplier_credit_allocations_same_currency_ck
    CHECK (credit_currency <> purchase_currency OR credit_amount_consumed_minor = purchase_amount_applied_minor),
  CONSTRAINT supplier_credit_allocations_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT supplier_credit_allocations_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_credit_allocations_note_fk
    FOREIGN KEY (business_id, credit_note_id, supplier_id) REFERENCES supplier_credit_notes (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_credit_allocations_purchase_fk
    FOREIGN KEY (business_id, purchase_id, supplier_id) REFERENCES purchases (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_credit_allocations_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON supplier_credit_allocations FROM PUBLIC;

CREATE INDEX supplier_credit_allocations_purchase_idx ON supplier_credit_allocations (business_id, purchase_id);
CREATE INDEX supplier_credit_allocations_note_idx ON supplier_credit_allocations (business_id, credit_note_id);

CREATE TABLE supplier_refunds (
  tenant_id                           UUID NOT NULL,
  business_id                         UUID NOT NULL,
  id                                  UUID NOT NULL,
  supplier_id                         UUID NOT NULL,
  credit_note_id                      UUID NOT NULL,
  payment_method_id                   UUID NOT NULL,
  posting_account_id                  UUID NOT NULL,
  refund_date                         DATE NOT NULL,
  reference                           TEXT CHECK (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 100 AND reference = btrim(reference))),
  source_currency                     CHAR(3) NOT NULL,
  source_amount_consumed_minor        BIGINT NOT NULL CHECK (source_amount_consumed_minor BETWEEN 1 AND 1000000000000000000),
  source_to_base_rate                 NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10)),
  credit_remaining_before_minor       BIGINT NOT NULL CHECK (credit_remaining_before_minor BETWEEN 1 AND 1000000000000000000),
  source_carrying_base_released_minor BIGINT NOT NULL CHECK (source_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  source_dust_base_minor              BIGINT NOT NULL CHECK (source_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  receipt_currency                    CHAR(3) NOT NULL,
  receipt_amount_minor                BIGINT NOT NULL CHECK (receipt_amount_minor BETWEEN 1 AND 1000000000000000000),
  receipt_to_base_rate                NUMERIC(20,10) NOT NULL CHECK (receipt_to_base_rate > 0 AND receipt_to_base_rate = trunc(receipt_to_base_rate, 10)),
  receipt_base_amount_minor           BIGINT NOT NULL CHECK (receipt_base_amount_minor BETWEEN 1 AND 1000000000000000000),
  rate_source                         TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),
  rate_timestamp                      TIMESTAMPTZ NOT NULL CHECK (rate_timestamp = date_trunc('second', rate_timestamp)),
  fx_rate_id                          UUID,
  realized_fx_gain_loss_minor         BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  intent_sha256                       TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id             UUID NOT NULL,
  created_by                          UUID NOT NULL REFERENCES users (id),
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type              TEXT NOT NULL GENERATED ALWAYS AS ('supplier_refund') STORED,
  binding_source_id                   UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_refunds_level_uq UNIQUE (business_id, credit_note_id, credit_remaining_before_minor),
  CONSTRAINT supplier_refunds_consumed_ck CHECK (source_amount_consumed_minor <= credit_remaining_before_minor),
  CONSTRAINT supplier_refunds_realized_ck
    CHECK (realized_fx_gain_loss_minor = receipt_base_amount_minor - source_carrying_base_released_minor),
  CONSTRAINT supplier_refunds_same_currency_ck
    CHECK (receipt_currency <> source_currency OR receipt_amount_minor = source_amount_consumed_minor),
  CONSTRAINT supplier_refunds_rate_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND receipt_to_base_rate = 1)),
  CONSTRAINT supplier_refunds_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT supplier_refunds_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_refunds_note_fk
    FOREIGN KEY (business_id, credit_note_id, supplier_id) REFERENCES supplier_credit_notes (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_refunds_method_fk
    FOREIGN KEY (business_id, payment_method_id, posting_account_id)
    REFERENCES payment_methods (business_id, id, posting_account_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_refunds_receipt_currency_fk FOREIGN KEY (receipt_currency) REFERENCES currencies (code),
  CONSTRAINT supplier_refunds_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_refunds_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON supplier_refunds FROM PUBLIC;

CREATE INDEX supplier_refunds_note_idx ON supplier_refunds (business_id, credit_note_id);
CREATE INDEX supplier_refunds_method_idx ON supplier_refunds (business_id, payment_method_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Row security and grants (§2.7, A-14(d), A-17).
--
-- The 0063 R-35 layering: a tenant policy through the businesses subquery;
-- a restrictive business isolation, one policy per command, where only the
-- FOR SELECT one admits the internal principals (the accounting principal
-- on the four settlement tables it judges); permissive FOR SELECT admissions
-- for the principals whose guards read these rows.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_method_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_method_names FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_refunds FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON payment_methods
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = payment_methods.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = payment_methods.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON payment_methods AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON payment_methods AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON payment_methods AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON payment_methods AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON payment_methods
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON payment_method_names
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = payment_method_names.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = payment_method_names.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON payment_method_names AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON payment_method_names AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON payment_method_names AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON payment_method_names AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON payment_method_names
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON supplier_payments
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_payments.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_payments.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_payments AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_payments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_payments AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_payments AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_payments
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON supplier_payments
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON supplier_payment_allocations
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_payment_allocations.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_payment_allocations.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_payment_allocations AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_payment_allocations AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_payment_allocations AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_payment_allocations AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_payment_allocations
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON supplier_payment_allocations
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON supplier_credit_allocations
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_credit_allocations.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_credit_allocations.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_credit_allocations AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_credit_allocations AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_credit_allocations AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_credit_allocations AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_credit_allocations
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON supplier_credit_allocations
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON supplier_refunds
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_refunds.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_refunds.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_refunds AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_refunds AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_refunds AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_refunds AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_refunds
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON supplier_refunds
  FOR SELECT TO daftar_accounting_internal USING (true);

-- A-17. daftar_app reads the six tables (the A-15 bound read, replay and the
-- read models) and holds no DML; the internal principal inserts and reads
-- them and holds exactly the column UPDATEs its guarded writers need; the
-- accounting principal reads the four settlement tables and the credit notes
-- (A-14(d)).
GRANT SELECT ON payment_methods, payment_method_names, supplier_payments, supplier_payment_allocations, supplier_credit_allocations,
                supplier_refunds
  TO daftar_app;
GRANT SELECT, INSERT ON payment_methods, payment_method_names, supplier_payments, supplier_payment_allocations,
                        supplier_credit_allocations, supplier_refunds
  TO daftar_inventory_internal;
GRANT UPDATE (posting_account_id, is_active, requires_reference, sort_order, revision, last_intent_sha256, business_transaction_id,
              updated_by, updated_at)
  ON payment_methods TO daftar_inventory_internal;
GRANT UPDATE (display_name), DELETE ON payment_method_names TO daftar_inventory_internal;
GRANT UPDATE (remaining_amount_minor, remaining_carrying_base_amount_minor) ON supplier_credit_notes TO daftar_inventory_internal;
GRANT SELECT ON supplier_payments, supplier_payment_allocations, supplier_credit_allocations, supplier_refunds, supplier_credit_notes
  TO daftar_accounting_internal;


-- ─────────────────────────────────────────────────────────────────────────
-- 4. The inventory bracket (§2.1(4), §2.3). Every function below is created
--    while the migrator owns it, PUBLIC's EXECUTE revoked and its trigger
--    installed (a non-superuser migrator must still hold EXECUTE to create a
--    trigger on it, so the triggers of §2.1(5) are created here, before the
--    handover: the 0065 section 5 order); then handed to the internal
--    principal; then the S5 credit-note guard is replaced BY ITS OWNER.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (a) Pure arithmetic (R-61, R-63): the inventory_half_even pattern; none
--     reads a table.

-- conv(x) = HALF_EVEN(x·R·10^max(0,e_b−e_t), 10^max(0,e_t−e_b)) — the 0043 law.
CREATE OR REPLACE FUNCTION supplier_convert_base(p_txn BIGINT, p_rate NUMERIC, p_txn_exp INTEGER, p_base_exp INTEGER) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_txn IS NULL OR p_rate IS NULL OR p_txn_exp IS NULL OR p_base_exp IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: a conversion needs an amount, a positive rate and two currency exponents' USING ERRCODE = 'P0001';
  END IF;
  RETURN inventory_half_even(p_txn::numeric * p_rate * power(10::numeric, greatest(0, p_base_exp - p_txn_exp)),
                             power(10::numeric, greatest(0, p_txn_exp - p_base_exp)), 0)::bigint;
END;
$$;

-- rel = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T) — 0065 R-35 exactly.
CREATE OR REPLACE FUNCTION supplier_ap_release(p_total_base BIGINT, p_total_txn BIGINT, p_before BIGINT, p_applied BIGINT) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_total_base IS NULL OR p_total_txn IS NULL OR p_before IS NULL OR p_applied IS NULL
     OR p_total_txn <= 0 OR p_total_base <= 0 OR p_before < 0 OR p_applied < 0 OR p_before + p_applied > p_total_txn THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: an AP release needs a purchase total and a released-before and applied amount within it' USING ERRCODE = 'P0001';
  END IF;
  RETURN (inventory_half_even(p_total_base::numeric * (p_before::numeric + p_applied::numeric), p_total_txn, 0)
          - inventory_half_even(p_total_base::numeric * p_before::numeric, p_total_txn, 0))::bigint;
END;
$$;

-- g(r) = 0 at r = 0, else max(1, OB − HALF_EVEN(OB·(OA − r), OA)) — R-63.
CREATE OR REPLACE FUNCTION supplier_credit_remaining_carrying(p_original BIGINT, p_original_carrying BIGINT, p_remaining BIGINT) RETURNS BIGINT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_original IS NULL OR p_original_carrying IS NULL OR p_remaining IS NULL
     OR p_original <= 0 OR p_original_carrying <= 0 OR p_remaining < 0 OR p_remaining > p_original THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: a remaining carrying value needs a credit note and a remaining amount within it' USING ERRCODE = 'P0001';
  END IF;
  IF p_remaining = 0 THEN
    RETURN 0;
  END IF;
  RETURN greatest(1::numeric, p_original_carrying::numeric
                              - inventory_half_even(p_original_carrying::numeric * (p_original::numeric - p_remaining::numeric), p_original, 0))::bigint;
END;
$$;

-- (b) The two verification helpers (R-62, R-63): no grantee, not triggers,
--     called only by the value guards below.

-- R-62 over every AP reducer of the purchase with a positive amount: each
-- row's X is the sum of the amounts ordered before it, each release is
-- ap_release of its X, Σ amount ≤ T and Σ rel = HALF_EVEN(B·Σ amount, T).
CREATE OR REPLACE FUNCTION purchase_settlement_verify(p_business_id UUID, p_purchase_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_total_txn  BIGINT;
  v_total_base BIGINT;
  v_bad        BIGINT;
  v_sum        NUMERIC;
  v_rel        NUMERIC;
BEGIN
  SELECT p.total_txn_minor, p.total_base_minor INTO v_total_txn, v_total_base
  FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id;
  IF v_total_txn IS NULL OR v_total_base IS NULL OR v_total_txn <= 0 OR v_total_base <= 0 THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: a settled purchase needs its received totals' USING ERRCODE = 'P0001';
  END IF;
  WITH reducers AS (
    SELECT r.ap_released_before_txn_minor AS x, r.ap_txn_minor AS amount, r.ap_base_minor AS rel
    FROM supplier_returns r
    WHERE r.business_id = p_business_id AND r.purchase_id = p_purchase_id AND r.ap_txn_minor > 0
    UNION ALL
    SELECT a.ap_released_before_txn_minor, a.purchase_amount_applied_minor, a.purchase_carrying_base_released_minor
    FROM supplier_payment_allocations a
    WHERE a.business_id = p_business_id AND a.purchase_id = p_purchase_id
    UNION ALL
    SELECT c.ap_released_before_txn_minor, c.purchase_amount_applied_minor, c.purchase_carrying_base_released_minor
    FROM supplier_credit_allocations c
    WHERE c.business_id = p_business_id AND c.purchase_id = p_purchase_id
  ), chained AS (
    SELECT d.x, d.amount, d.rel,
           coalesce(sum(d.amount) OVER (ORDER BY d.x, d.amount ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM reducers d
  )
  SELECT count(*) FILTER (WHERE CASE WHEN h.x <> h.before OR h.x + h.amount > v_total_txn THEN true
                                     ELSE h.rel <> supplier_ap_release(v_total_base, v_total_txn, h.x, h.amount) END),
         coalesce(sum(h.amount), 0), coalesce(sum(h.rel), 0)
    INTO v_bad, v_sum, v_rel
  FROM chained h;
  IF v_bad > 0 OR v_sum > v_total_txn
     OR v_rel <> inventory_half_even(v_total_base::numeric * v_sum, v_total_txn, 0) THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: the purchase''s AP reducers do not chain from zero to at most its total' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- R-63 over every consumer of the note (credit allocations ∪ refunds),
-- ordered by remaining-before descending: each rb is OA − Σ earlier c, each
-- release is g(rb) − g(rb − c), and the stored pair is (OA − Σ c, g of it).
CREATE OR REPLACE FUNCTION supplier_credit_note_verify(p_business_id UUID, p_credit_note_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n   RECORD;
  v_bad BIGINT;
  v_sum NUMERIC;
  v_rel NUMERIC;
BEGIN
  SELECT n.original_amount_minor, n.original_carrying_base_amount_minor, n.remaining_amount_minor, n.remaining_carrying_base_amount_minor
    INTO v_n
  FROM supplier_credit_notes n WHERE n.business_id = p_business_id AND n.id = p_credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: a consumed supplier credit note must exist' USING ERRCODE = 'P0001';
  END IF;
  WITH consumers AS (
    SELECT a.credit_remaining_before_minor AS rb, a.credit_amount_consumed_minor AS amount, a.credit_carrying_base_released_minor AS rel
    FROM supplier_credit_allocations a
    WHERE a.business_id = p_business_id AND a.credit_note_id = p_credit_note_id
    UNION ALL
    SELECT f.credit_remaining_before_minor, f.source_amount_consumed_minor, f.source_carrying_base_released_minor
    FROM supplier_refunds f
    WHERE f.business_id = p_business_id AND f.credit_note_id = p_credit_note_id
  ), chained AS (
    SELECT d.rb, d.amount, d.rel,
           coalesce(sum(d.amount) OVER (ORDER BY d.rb DESC, d.amount ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM consumers d
  )
  SELECT count(*) FILTER (WHERE CASE WHEN h.rb <> v_n.original_amount_minor - h.before OR h.amount > h.rb THEN true
                                     ELSE h.rel <> supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor, h.rb)
                                                   - supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor,
                                                                                        h.rb - h.amount) END),
         coalesce(sum(h.amount), 0), coalesce(sum(h.rel), 0)
    INTO v_bad, v_sum, v_rel
  FROM chained h;
  IF v_bad > 0 OR v_sum > v_n.original_amount_minor
     OR v_n.remaining_amount_minor::numeric <> v_n.original_amount_minor - v_sum
     OR v_n.remaining_carrying_base_amount_minor
        <> supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor, v_n.remaining_amount_minor)
     OR v_rel <> v_n.original_carrying_base_amount_minor::numeric - v_n.remaining_carrying_base_amount_minor THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: the note''s consumers do not chain from its original to its stored remaining values' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- (c) The guard functions (§2.3).

-- payment_methods: born at revision 1, active, both intents equal, now and
-- this transaction's trace, on an eligible account (R-65, R-71); changed
-- only by the next revision in this transaction, never in its identity,
-- type or creation; an account change only while nothing posted through
-- the method, and to an eligible account; never deleted (A-06).
CREATE OR REPLACE FUNCTION payment_method_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_method.not_deletable: a payment method is deactivated, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NOT NEW.is_active OR NEW.last_intent_sha256 <> NEW.create_intent_sha256
       OR NEW.created_at IS DISTINCT FROM now() OR NEW.updated_at IS DISTINCT FROM now()
       OR NEW.updated_by IS DISTINCT FROM NEW.created_by
       OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
      RAISE EXCEPTION 'payment_method.field_immutable: a payment method is created active at revision 1 by its own command''s transaction' USING ERRCODE = 'P0001';
    END IF;
    IF accounting_settlement_account_eligibility(NEW.business_id, NEW.posting_account_id) IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.business_id, NEW.id, NEW.system_type, NEW.create_intent_sha256, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.business_id, OLD.id, OLD.system_type, OLD.create_intent_sha256, OLD.created_by, OLD.created_at)
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1
     OR NEW.updated_at IS DISTINCT FROM now()
     OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'payment_method.field_immutable: a payment method changes only by its next revision, in its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.posting_account_id IS DISTINCT FROM OLD.posting_account_id
     AND (EXISTS (SELECT 1 FROM supplier_payments s WHERE s.business_id = OLD.business_id AND s.payment_method_id = OLD.id)
          OR EXISTS (SELECT 1 FROM supplier_refunds f WHERE f.business_id = OLD.business_id AND f.payment_method_id = OLD.id)) THEN
    RAISE EXCEPTION 'payment_method.posting_account_locked: a payment method that has posted keeps its posting account' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.posting_account_id IS DISTINCT FROM OLD.posting_account_id OR (NEW.is_active AND NOT OLD.is_active))
     AND accounting_settlement_account_eligibility(NEW.business_id, NEW.posting_account_id) IS DISTINCT FROM 'eligible' THEN
    RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT: a method written in this transaction has at least one name.
CREATE OR REPLACE FUNCTION payment_method_named() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_method_names n WHERE n.business_id = NEW.business_id AND n.payment_method_id = NEW.id) THEN
    RAISE EXCEPTION 'payment_method.name_required: a payment method carries at least one name' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- payment_method_names: every write needs a revision of the parent method
-- in this very transaction (0063 R-36); an UPDATE changes display_name only.
CREATE OR REPLACE FUNCTION payment_method_name_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_business UUID;
  v_method   UUID;
  v_updated  TIMESTAMPTZ;
  v_trace    UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_method   := OLD.payment_method_id;
  ELSE
    v_business := NEW.business_id;
    v_method   := NEW.payment_method_id;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.business_id, NEW.payment_method_id, NEW.locale)
         IS DISTINCT FROM (OLD.tenant_id, OLD.business_id, OLD.payment_method_id, OLD.locale) THEN
    RAISE EXCEPTION 'payment_method.field_immutable: a payment method name changes its display name only' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.updated_at, m.business_transaction_id INTO v_updated, v_trace
  FROM payment_methods m WHERE m.business_id = v_business AND m.id = v_method;
  IF NOT FOUND OR v_updated IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'payment_method.field_immutable: a payment method name changes only with a revision of its method in the same transaction' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- supplier_payments: inserted only by its own command's transaction, through
-- an active method whose account it names, for an active supplier, to an
-- eligible account (R-65); never changed or deleted.
CREATE OR REPLACE FUNCTION supplier_payment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_active  BOOLEAN;
  v_account UUID;
  v_status  TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'supplier_payment.immutable: a supplier payment is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'supplier_payment.immutable: a supplier payment is written only by its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.is_active, m.posting_account_id INTO v_active, v_account
  FROM payment_methods m WHERE m.business_id = NEW.business_id AND m.id = NEW.payment_method_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: a supplier payment names a payment method of its business' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'payment_method.inactive: a supplier payment is made through an active payment method' USING ERRCODE = 'P0001';
  END IF;
  IF v_account IS DISTINCT FROM NEW.posting_account_id THEN
    RAISE EXCEPTION 'payment_method.state_invalid: a supplier payment posts to its method''s posting account' USING ERRCODE = 'P0001';
  END IF;
  IF accounting_settlement_account_eligibility(NEW.business_id, NEW.posting_account_id) IS DISTINCT FROM 'eligible' THEN
    RAISE EXCEPTION 'payment_method.posting_account_ineligible: a supplier payment posts to an active settlement asset account' USING ERRCODE = 'P0001';
  END IF;
  SELECT s.status INTO v_status FROM suppliers s WHERE s.business_id = NEW.business_id AND s.id = NEW.supplier_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'supplier_payment.supplier_inactive: a supplier payment is made to an active supplier' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (A-07): the payment is fully allocated — its allocations number
-- exactly allocation_count, are lines 1..n in its currency, rate and
-- supplier, and sum to its amount and its base.
CREATE OR REPLACE FUNCTION supplier_payment_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n    BIGINT;
  v_bad  BIGINT;
  v_max  INTEGER;
  v_sum  NUMERIC;
  v_base NUMERIC;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE a.payment_currency <> NEW.currency_code OR a.payment_to_base_rate <> NEW.payment_to_base_rate
                            OR a.supplier_id <> NEW.supplier_id),
         max(a.line_no), coalesce(sum(a.payment_amount_minor), 0), coalesce(sum(a.payment_base_amount_minor), 0)
    INTO v_n, v_bad, v_max, v_sum, v_base
  FROM supplier_payment_allocations a WHERE a.business_id = NEW.business_id AND a.payment_id = NEW.id;
  IF v_n < 1 OR v_n <> NEW.allocation_count OR v_max IS DISTINCT FROM NEW.allocation_count OR v_bad > 0
     OR v_sum <> NEW.amount_minor::numeric OR v_base <> NEW.base_amount_minor::numeric THEN
    RAISE EXCEPTION 'supplier_payment.allocations_invalid: a supplier payment is exactly the sum of its allocations, in its own currency and rate' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- supplier_payment_allocations: joins only a payment created by this very
-- transaction (0063 R-36); never changed or deleted.
CREATE OR REPLACE FUNCTION supplier_payment_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_created TIMESTAMPTZ;
  v_trace   UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'supplier_payment.immutable: a supplier payment allocation is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  SELECT p.created_at, p.business_transaction_id INTO v_created, v_trace
  FROM supplier_payments p WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id;
  IF NOT FOUND OR v_created IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id()
     OR NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'supplier_payment.immutable: an allocation joins only a payment created by the same transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (A-05(a), A-08, A-09): the purchase is received and not
-- reversed; the allocation carries the purchase and payment snapshots; the
-- release, the dust, the payment base and the realized FX are recomputed;
-- conv_R(a) > 0 (R-69(b)); the residue T − X − a is 0 or converts to at
-- least one base unit (R-77); then the purchase chain (R-62).
CREATE OR REPLACE FUNCTION supplier_payment_allocation_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p        RECORD;
  v_h        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_ep       INTEGER;
  v_eb       INTEGER;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_pb       BIGINT;
BEGIN
  SELECT p.status, p.currency_code, p.total_txn_minor, p.total_base_minor, p.source_to_base_rate INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF v_p.status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'supplier_payment.purchase_state_invalid: only a received purchase is settled' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'supplier_payment.purchase_reversed: a reversed purchase is not settled' USING ERRCODE = 'P0001';
  END IF;
  SELECT h.currency_code, h.payment_to_base_rate INTO v_h
  FROM supplier_payments h WHERE h.business_id = NEW.business_id AND h.id = NEW.payment_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
  SELECT c.minor_units INTO v_ep FROM currencies c WHERE c.code = v_h.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_p.total_txn_minor IS NULL OR v_p.total_base_minor IS NULL OR v_h.currency_code IS NULL
     OR v_et IS NULL OR v_ep IS NULL OR v_eb IS NULL
     OR NEW.ap_released_before_txn_minor + NEW.purchase_amount_applied_minor > v_p.total_txn_minor THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: an allocation settles at most its received purchase''s total' USING ERRCODE = 'P0001';
  END IF;
  v_rel  := supplier_ap_release(v_p.total_base_minor, v_p.total_txn_minor, NEW.ap_released_before_txn_minor, NEW.purchase_amount_applied_minor);
  v_conv := supplier_convert_base(NEW.purchase_amount_applied_minor, v_p.source_to_base_rate, v_et, v_eb);
  v_pb   := supplier_convert_base(NEW.payment_amount_minor, v_h.payment_to_base_rate, v_ep, v_eb);
  IF v_conv = 0 OR v_pb = 0 THEN
    RAISE EXCEPTION 'supplier_payment.amount_below_base_unit: an allocated amount converts to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.ap_released_before_txn_minor + NEW.purchase_amount_applied_minor < v_p.total_txn_minor
     AND supplier_convert_base(v_p.total_txn_minor - NEW.ap_released_before_txn_minor - NEW.purchase_amount_applied_minor,
                               v_p.source_to_base_rate, v_et, v_eb) = 0 THEN
    RAISE EXCEPTION 'supplier_payment.residue_below_base_unit: an allocation leaves its purchase nothing outstanding or an amount converting to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.purchase_currency IS DISTINCT FROM v_p.currency_code
     OR NEW.purchase_historical_to_base_rate IS DISTINCT FROM v_p.source_to_base_rate
     OR NEW.payment_currency IS DISTINCT FROM v_h.currency_code
     OR NEW.payment_to_base_rate IS DISTINCT FROM v_h.payment_to_base_rate
     OR NEW.purchase_carrying_base_released_minor <> v_rel
     OR NEW.ap_dust_base_minor <> v_rel - v_conv
     OR NEW.payment_base_amount_minor <> v_pb
     OR NEW.realized_fx_gain_loss_minor <> v_pb - v_rel THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: an allocation''s amounts are not the A-08 amounts of its purchase and payment' USING ERRCODE = 'P0001';
  END IF;
  PERFORM purchase_settlement_verify(NEW.business_id, NEW.purchase_id);
  RETURN NULL;
END;
$$;

-- supplier_credit_allocations: inserted now by this transaction; never
-- changed or deleted (its "detail" is the note decrement, R-66).
CREATE OR REPLACE FUNCTION supplier_credit_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'supplier_credit_allocation.immutable: a supplier credit allocation is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'supplier_credit_allocation.immutable: a supplier credit allocation is written only by its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (A-05(b), A-08, A-10): the AP side as for a payment; the credit
-- side against the note's snapshot and g; neither residue below one base
-- unit (R-77, R-78); the realized FX cr_rel − rel; then both chains.
CREATE OR REPLACE FUNCTION supplier_credit_allocation_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p        RECORD;
  v_n        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_en       INTEGER;
  v_eb       INTEGER;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_cr_rel   BIGINT;
  v_cr_conv  BIGINT;
BEGIN
  SELECT p.status, p.currency_code, p.total_txn_minor, p.total_base_minor, p.source_to_base_rate INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF v_p.status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'supplier_credit_allocation.purchase_state_invalid: a supplier credit is applied to a received purchase only' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'supplier_credit_allocation.purchase_reversed: a supplier credit is not applied to a reversed purchase' USING ERRCODE = 'P0001';
  END IF;
  SELECT n.currency_code, n.source_to_base_rate, n.original_amount_minor, n.original_carrying_base_amount_minor INTO v_n
  FROM supplier_credit_notes n WHERE n.business_id = NEW.business_id AND n.id = NEW.credit_note_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
  SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_n.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_p.total_txn_minor IS NULL OR v_p.total_base_minor IS NULL OR v_n.currency_code IS NULL
     OR v_et IS NULL OR v_en IS NULL OR v_eb IS NULL
     OR NEW.ap_released_before_txn_minor + NEW.purchase_amount_applied_minor > v_p.total_txn_minor THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: a credit allocation settles at most its received purchase''s total' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.credit_remaining_before_minor > v_n.original_amount_minor THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: a credit allocation consumes within its note''s original amount' USING ERRCODE = 'P0001';
  END IF;
  v_rel     := supplier_ap_release(v_p.total_base_minor, v_p.total_txn_minor, NEW.ap_released_before_txn_minor, NEW.purchase_amount_applied_minor);
  v_conv    := supplier_convert_base(NEW.purchase_amount_applied_minor, v_p.source_to_base_rate, v_et, v_eb);
  v_cr_conv := supplier_convert_base(NEW.credit_amount_consumed_minor, v_n.source_to_base_rate, v_en, v_eb);
  IF v_conv = 0 OR v_cr_conv = 0 THEN
    RAISE EXCEPTION 'supplier_credit_allocation.amount_below_base_unit: an applied or consumed amount converts to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.ap_released_before_txn_minor + NEW.purchase_amount_applied_minor < v_p.total_txn_minor
      AND supplier_convert_base(v_p.total_txn_minor - NEW.ap_released_before_txn_minor - NEW.purchase_amount_applied_minor,
                                v_p.source_to_base_rate, v_et, v_eb) = 0)
     OR (NEW.credit_amount_consumed_minor < NEW.credit_remaining_before_minor
         AND supplier_convert_base(NEW.credit_remaining_before_minor - NEW.credit_amount_consumed_minor, v_n.source_to_base_rate, v_en, v_eb) = 0) THEN
    RAISE EXCEPTION 'supplier_credit_allocation.residue_below_base_unit: an allocation leaves its purchase and its note each nothing outstanding or an amount converting to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.purchase_currency IS DISTINCT FROM v_p.currency_code
     OR NEW.purchase_historical_to_base_rate IS DISTINCT FROM v_p.source_to_base_rate
     OR NEW.purchase_carrying_base_released_minor <> v_rel
     OR NEW.ap_dust_base_minor <> v_rel - v_conv THEN
    RAISE EXCEPTION 'supplier_payment.settlement_inconsistent: a credit allocation''s AP amounts are not the A-08 amounts of its purchase' USING ERRCODE = 'P0001';
  END IF;
  v_cr_rel := supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor, NEW.credit_remaining_before_minor)
              - supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor,
                                                   NEW.credit_remaining_before_minor - NEW.credit_amount_consumed_minor);
  IF NEW.credit_currency IS DISTINCT FROM v_n.currency_code
     OR NEW.credit_to_base_rate IS DISTINCT FROM v_n.source_to_base_rate
     OR NEW.credit_carrying_base_released_minor <> v_cr_rel
     OR NEW.credit_dust_base_minor <> v_cr_rel - v_cr_conv
     OR NEW.realized_fx_gain_loss_minor <> v_cr_rel - v_rel THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: a credit allocation''s credit amounts are not the A-10 amounts of its note' USING ERRCODE = 'P0001';
  END IF;
  PERFORM purchase_settlement_verify(NEW.business_id, NEW.purchase_id);
  PERFORM supplier_credit_note_verify(NEW.business_id, NEW.credit_note_id);
  RETURN NULL;
END;
$$;

-- supplier_refunds: inserted now by this transaction, through an active
-- method whose account it names, to an eligible account (R-65); never
-- changed or deleted.
CREATE OR REPLACE FUNCTION supplier_refund_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_active  BOOLEAN;
  v_account UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'supplier_refund.immutable: a supplier refund is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'supplier_refund.immutable: a supplier refund is written only by its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.is_active, m.posting_account_id INTO v_active, v_account
  FROM payment_methods m WHERE m.business_id = NEW.business_id AND m.id = NEW.payment_method_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: a supplier refund names a payment method of its business' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'payment_method.inactive: a supplier refund is received through an active payment method' USING ERRCODE = 'P0001';
  END IF;
  IF v_account IS DISTINCT FROM NEW.posting_account_id THEN
    RAISE EXCEPTION 'payment_method.state_invalid: a supplier refund posts to its method''s posting account' USING ERRCODE = 'P0001';
  END IF;
  IF accounting_settlement_account_eligibility(NEW.business_id, NEW.posting_account_id) IS DISTINCT FROM 'eligible' THEN
    RAISE EXCEPTION 'payment_method.posting_account_ineligible: a supplier refund posts to an active settlement asset account' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (A-05(c), A-10): the credit side against the note; the receipt
-- base conv(m, Rr); no note residue below one base unit (R-78); the
-- realized FX mb − cr_rel; then the note chain.
CREATE OR REPLACE FUNCTION supplier_refund_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n        RECORD;
  v_base_ccy TEXT;
  v_en       INTEGER;
  v_er       INTEGER;
  v_eb       INTEGER;
  v_cr_rel   BIGINT;
  v_cr_conv  BIGINT;
  v_mb       BIGINT;
BEGIN
  SELECT n.currency_code, n.source_to_base_rate, n.original_amount_minor, n.original_carrying_base_amount_minor INTO v_n
  FROM supplier_credit_notes n WHERE n.business_id = NEW.business_id AND n.id = NEW.credit_note_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_n.currency_code::text;
  SELECT c.minor_units INTO v_er FROM currencies c WHERE c.code = NEW.receipt_currency::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_n.currency_code IS NULL OR v_en IS NULL OR v_er IS NULL OR v_eb IS NULL
     OR NEW.credit_remaining_before_minor > v_n.original_amount_minor THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: a refund consumes an existing credit note' USING ERRCODE = 'P0001';
  END IF;
  v_cr_conv := supplier_convert_base(NEW.source_amount_consumed_minor, v_n.source_to_base_rate, v_en, v_eb);
  v_mb      := supplier_convert_base(NEW.receipt_amount_minor, NEW.receipt_to_base_rate, v_er, v_eb);
  IF v_cr_conv = 0 OR v_mb = 0 THEN
    RAISE EXCEPTION 'supplier_refund.amount_below_base_unit: a consumed or received amount converts to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.source_amount_consumed_minor < NEW.credit_remaining_before_minor
     AND supplier_convert_base(NEW.credit_remaining_before_minor - NEW.source_amount_consumed_minor, v_n.source_to_base_rate, v_en, v_eb) = 0 THEN
    RAISE EXCEPTION 'supplier_refund.residue_below_base_unit: a refund leaves its note nothing or an amount converting to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  v_cr_rel := supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor, NEW.credit_remaining_before_minor)
              - supplier_credit_remaining_carrying(v_n.original_amount_minor, v_n.original_carrying_base_amount_minor,
                                                   NEW.credit_remaining_before_minor - NEW.source_amount_consumed_minor);
  IF NEW.source_currency IS DISTINCT FROM v_n.currency_code
     OR NEW.source_to_base_rate IS DISTINCT FROM v_n.source_to_base_rate
     OR NEW.source_carrying_base_released_minor <> v_cr_rel
     OR NEW.source_dust_base_minor <> v_cr_rel - v_cr_conv
     OR NEW.receipt_base_amount_minor <> v_mb
     OR NEW.realized_fx_gain_loss_minor <> v_mb - v_cr_rel THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: a refund''s amounts are not the A-10 amounts of its note and receipt' USING ERRCODE = 'P0001';
  END IF;
  PERFORM supplier_credit_note_verify(NEW.business_id, NEW.credit_note_id);
  RETURN NULL;
END;
$$;

-- purchase_reversals (S5): at COMMIT, the physical twin of S5 A-09(a)(b) —
-- a reversed purchase carries no allocation of either kind (R-67).
CREATE OR REPLACE FUNCTION purchase_reversal_unsettled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM supplier_payment_allocations a WHERE a.business_id = NEW.business_id AND a.purchase_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'purchase_reversal.payment_allocated: a purchase with a supplier payment allocated is not reversed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_credit_allocations c WHERE c.business_id = NEW.business_id AND c.purchase_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'purchase_reversal.credit_allocated: a purchase with a supplier credit allocated is not reversed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION supplier_convert_base(BIGINT, NUMERIC, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_ap_release(BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_remaining_carrying(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_settlement_verify(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_note_verify(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_named() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_name_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_payment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_payment_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_payment_allocation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_payment_allocation_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_allocation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_allocation_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_refund_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_refund_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_reversal_unsettled() FROM PUBLIC;

-- ── The triggers (§2.1(5), §2.3): R-34 events, no WHEN, no column list ──
CREATE TRIGGER payment_methods_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION payment_method_guard();
CREATE CONSTRAINT TRIGGER payment_methods_named
  AFTER INSERT OR UPDATE ON payment_methods DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_method_named();
CREATE TRIGGER payment_method_names_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payment_method_names
  FOR EACH ROW EXECUTE FUNCTION payment_method_name_guard();
CREATE TRIGGER supplier_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_guard();
CREATE CONSTRAINT TRIGGER supplier_payments_complete
  AFTER INSERT ON supplier_payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_complete();
CREATE TRIGGER supplier_payment_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocation_guard();
CREATE CONSTRAINT TRIGGER supplier_payment_allocations_value_complete
  AFTER INSERT ON supplier_payment_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocation_value_complete();
CREATE TRIGGER supplier_credit_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_credit_allocation_guard();
CREATE CONSTRAINT TRIGGER supplier_credit_allocations_value_complete
  AFTER INSERT ON supplier_credit_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_credit_allocation_value_complete();
CREATE TRIGGER supplier_refunds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_refunds
  FOR EACH ROW EXECUTE FUNCTION supplier_refund_guard();
CREATE CONSTRAINT TRIGGER supplier_refunds_value_complete
  AFTER INSERT ON supplier_refunds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_refund_value_complete();
CREATE CONSTRAINT TRIGGER purchase_reversals_unsettled
  AFTER INSERT ON purchase_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_reversal_unsettled();

-- (d) The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION supplier_convert_base(BIGINT, NUMERIC, INTEGER, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_ap_release(BIGINT, BIGINT, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_remaining_carrying(BIGINT, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_settlement_verify(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_note_verify(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_named() OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_name_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_payment_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_payment_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_payment_allocation_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_payment_allocation_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_allocation_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_allocation_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_refund_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_refund_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_reversal_unsettled() OWNER TO daftar_inventory_internal;

-- (e) R-66 / A-12: the S5 credit-note guard, replaced BY ITS OWNER (§2.4,
--     normative). CREATE OR REPLACE by the owner keeps the signature, the
--     owner and the ACL (no grantee); the trigger `supplier_credit_notes_immutable`
--     (tgtype 27, no WHEN) is untouched. The column tuple is the full S5
--     column list at freeze except the two remaining values (0067-E(8)
--     compares it to pg_attribute).
SET LOCAL ROLE daftar_inventory_internal;
CREATE OR REPLACE FUNCTION supplier_credit_note_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_n INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.business_id, NEW.id, NEW.supplier_id, NEW.supplier_return_id, NEW.currency_code,
          NEW.original_amount_minor, NEW.original_carrying_base_amount_minor, NEW.source_to_base_rate, NEW.rate_source,
          NEW.rate_timestamp, NEW.issued_on, NEW.business_transaction_id, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.business_id, OLD.id, OLD.supplier_id, OLD.supplier_return_id, OLD.currency_code,
          OLD.original_amount_minor, OLD.original_carrying_base_amount_minor, OLD.source_to_base_rate, OLD.rate_source,
          OLD.rate_timestamp, OLD.issued_on, OLD.business_transaction_id, OLD.created_by, OLD.created_at)
     AND NEW.remaining_amount_minor < OLD.remaining_amount_minor
     AND NEW.remaining_carrying_base_amount_minor
         = supplier_credit_remaining_carrying(OLD.original_amount_minor, OLD.original_carrying_base_amount_minor, NEW.remaining_amount_minor)
  THEN
    SELECT count(*) INTO v_n FROM (
      SELECT 1 FROM supplier_credit_allocations a
       WHERE a.business_id = OLD.business_id AND a.credit_note_id = OLD.id
         AND a.credit_remaining_before_minor = OLD.remaining_amount_minor
         AND a.credit_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
         AND a.credit_carrying_base_released_minor = OLD.remaining_carrying_base_amount_minor - NEW.remaining_carrying_base_amount_minor
         AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id()
      UNION ALL
      SELECT 1 FROM supplier_refunds f
       WHERE f.business_id = OLD.business_id AND f.credit_note_id = OLD.id
         AND f.credit_remaining_before_minor = OLD.remaining_amount_minor
         AND f.source_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
         AND f.source_carrying_base_released_minor = OLD.remaining_carrying_base_amount_minor - NEW.remaining_carrying_base_amount_minor
         AND f.created_at = now() AND f.business_transaction_id = inventory_business_transaction_id()) c;
    IF v_n = 1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'supplier_credit_note.immutable: a supplier credit note changes only by one backed consumption of both remaining values' USING ERRCODE = 'P0001';
END;
$$;
RESET ROLE;

-- Hand back the ownership-transfer authority of this section.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The two S5 extension points, replaced by the migrator (R-67, A-13, S5
--    TL-9). Same signature, owner, INVOKER STABLE, pinned path and ACL
--    (EXECUTE to daftar_app and daftar_inventory_internal, kept by CREATE OR
--    REPLACE). `purchase_ap_outstanding` is the 0066 body with exactly two
--    more subtraction terms.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_total    BIGINT;
  v_released NUMERIC;
BEGIN
  SELECT p.status, p.total_txn_minor INTO v_status, v_total
  FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'received'
     OR EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = p_business_id AND r.id = p_purchase_id) THEN
    RETURN 0;
  END IF;
  SELECT coalesce(sum(r.ap_txn_minor), 0) INTO v_released
  FROM supplier_returns r WHERE r.business_id = p_business_id AND r.purchase_id = p_purchase_id;
  RETURN (v_total - v_released
          - coalesce((SELECT sum(a.purchase_amount_applied_minor) FROM supplier_payment_allocations a
                       WHERE a.business_id = p_business_id AND a.purchase_id = p_purchase_id), 0)
          - coalesce((SELECT sum(c.purchase_amount_applied_minor) FROM supplier_credit_allocations c
                       WHERE c.business_id = p_business_id AND c.purchase_id = p_purchase_id), 0))::bigint;
END;
$$;

COMMENT ON FUNCTION purchase_ap_outstanding(UUID, UUID) IS
  'P3-S5 A-16, replaced by P3-S6 (0067, A-13). The purchase''s outstanding AP in its own currency: T - the sum of ap_txn_minor over its supplier returns - the sum of purchase_amount_applied_minor over its supplier payment allocations - the same over its supplier credit allocations; 0 when the purchase is not received or is reversed (R-52); purchase.not_found when the caller cannot see it. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

CREATE OR REPLACE FUNCTION purchase_settlement_state(p_business_id UUID, p_purchase_id UUID,
                                                     OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  payment_allocated := EXISTS (SELECT 1 FROM supplier_payment_allocations a
                                WHERE a.business_id = p_business_id AND a.purchase_id = p_purchase_id);
  credit_allocated  := EXISTS (SELECT 1 FROM supplier_credit_allocations c
                                WHERE c.business_id = p_business_id AND c.purchase_id = p_purchase_id);
END;
$$;

COMMENT ON FUNCTION purchase_settlement_state(UUID, UUID) IS
  'P3-S5 A-16, replaced by P3-S6 (0067, A-13, TL-9). Whether a supplier payment or a supplier credit is allocated to the purchase: EXISTS over supplier_payment_allocations and over supplier_credit_allocations. INVOKER, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The S5 source-guard discovery, re-recorded (R-70(b), 0065 R-53; the
--    coordinator ruling that overrides §7.1). 0065 records the SHA-256 of
--    `supplier_credit_note_guard()`'s prosrc; section 4(e) replaced that
--    body, so the discovery is replaced here by the migrator with the same
--    signature, owner, INVOKER STABLE, pinned path and ACL. It is 0065's
--    text byte for byte — every S3/S4/S5 row and the forty other recorded
--    digests — except the one credit_note_immutable digest, which is now the
--    SHA-256 of section 4(e)'s body.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps()
RETURNS TABLE (source_type TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type     TEXT;
  v_bridge   REGCLASS;
  v_bind     REGCLASS := 'public.stock_source_bindings'::regclass;
  v_fn       REGPROCEDURE;
  v_s3       BOOLEAN;
  v_s4       BOOLEAN;
  v_s5       BOOLEAN;
  v_line_tbl REGCLASS;
  v_line_key TEXT[];
  v_g        RECORD;
  -- SHA-256 (hex) of each S3 guard function's prosrc, recorded at migration time
  -- (0061), then of each S4 guard function's prosrc (0063), then of each S5
  -- guard function's prosrc (0065).
  c_digest   CONSTANT JSONB := '{
    "stock_ledger_append_only()": "2b6be55eba2569a34816d6ad4154ece7138500f58f0f58253c52d2a891e1f01a",
    "stock_binding_requires_inventory_transfer()": "f8a0aaa2ba51e777ff3992750237601ebfb927636a55f1a1816a507ff2d2d430",
    "stock_binding_requires_inventory_adjustment()": "3e54199bec0101135d4ea687c858dc514244a6cbd4f4e2aa7225f293b34dcdba",
    "stock_binding_requires_stocktake()": "4695f38364e51b8f19fb97627b94123e41792fb9e0889b6613b3734e305ad4f9",
    "stock_binding_requires_inventory_opening()": "7a8363f5b004f9853c935eca03339bfabc30c340cfbef93e7d56fe9d19b5b59d",
    "stock_source_complete_inventory_transfer()": "d4ca51a9d61eb6fdba9be52f6c3e9fa2fc4b4f1da67fdc792ed5e889ac13d9bc",
    "stock_source_complete_inventory_adjustment()": "893163f6bcfd133c4e5e270647870dec1c9ce9a017952e66a1c5aa9d767702af",
    "stock_source_complete_stocktake()": "0e192f181e2512b74051c668ccfbaf4549ff2793008a8581ed992e0c65c602d5",
    "stock_source_complete_stocktake_header()": "3bd8424be82ab8aa94707d3f1b2d04ad74abacaea8ae32f860ea16aaa4716c15",
    "stock_source_complete_inventory_opening()": "71b4f35571d748bf76b7a9b2b8bfa407af755dc4420c39e26532f9905659686f",
    "stock_source_freeze_inventory_transfer()": "e70ba4c9c0c87a4b76050f77afb9e36d8bfac7195439d2438871d2822f488d45",
    "stock_source_freeze_inventory_adjustment()": "049e3e439c8d4e33a79bc932c937dc45b824b79718587604e627a1cfa2fb7c4a",
    "stock_source_freeze_stocktake()": "2e29261988cc961a5c9a052709b78a32a6fd49509d263875b97527992b905717",
    "stock_source_freeze_inventory_opening()": "507f40e4d0d472a6e787865b5a779c6f69ecfb651875ba14df57fe8fd8f54cbe",
    "inventory_source_header_guard()": "4d646c5d5db4aa49e544033d02cc24fd007899dab833637cb8020a49611c2828",
    "inventory_source_value_complete()": "908bc14db1094becba6402c0171237a5d91481874a55dd16eef17894cc59d5d4",
    "stock_binding_requires_purchase()": "2f4a78a635df4ea85a0eb9a898752c80860badd64a68ce4038a3c081d9075e3f",
    "stock_binding_requires_negative_inventory_cost_adjustment()": "bf707fa32e584fb9e01f88a4766f8788dc32f2b96b5d59fd50ed9861e8b75cfa",
    "stock_source_complete_purchase()": "7a49c422e4e56c628ac1b4e6e45d8af0c9dcdc049bcc614e0f7829f80a050b58",
    "stock_source_complete_purchase_header()": "28f7f06240e62911f7b68efa3256e753443bf67c4ecf893ab174895a79582154",
    "stock_source_complete_negative_inventory_cost_adjustment()": "6c6522559afc458e9fd9ce230214372b5f95c65938ca869ce435f326dd4fd19f",
    "stock_source_freeze_purchase()": "97adaaaa95a5b2c18e80d34ea26a4eee5e397e1bf25dd727ddfc9a0cf86f31ab",
    "purchase_header_guard()": "09da86dc079e39ef7a60f1625c364b6e4644aad9b795b87245cc6d6749a3db4c",
    "purchase_source_value_complete()": "033535f199feae9d1747772d3cf32cfbe9f07979fa05f48471ac73475b4e7a9e",
    "purchase_landed_cost_freeze()": "3eda69587e6a9a8046ff1d7852e1ac7d0dec0d05ae633d1b78663a091634379a",
    "purchase_allocations_consistent()": "ac783691817646b8ac3528766a3203ec30c3f594a6f997b7f5779504ab625748",
    "negative_deficit_coverage_same_transaction()": "77e09d0b7e15b2368ca2ace6f7de5933964777c5b3e5a1f58fb5723eb156b663",
    "negative_inventory_deficits_coverage_guard()": "a6fb57abb419fea3eb0f75c1c81ee0189226c5354fca7fe6197fb0f1ae76a925",
    "negative_inventory_deficits_coverage_consistent()": "883da444f892ddbb0ad16f5d77c124057f46304e966262b80a63c3bfc1867b6b",
    "stock_binding_requires_supplier_return()": "d9b6af529194f9378353b3d3b4b519f0a2fb39cf9bef9e9223b4a3b4512b626d",
    "stock_binding_requires_purchase_reversal()": "945338f56ba61ec93b980a7053b10478eec00da32a2bdcecb80cac87b3b7b40e",
    "stock_source_complete_supplier_return()": "bfbcfd7696131c5222a277a7cdcffedfa221b1dd69b9036614d5a00ece553679",
    "stock_source_complete_supplier_return_header()": "0257473d6c4e53e3ffb415905cdf499e41bf29bc8fa34b1d1be9a9c18185aea4",
    "supplier_return_value_complete()": "851cbdf05fdacd8ca2277e9b7aedcb76fc9cdb1d6cf6aa62b0100bc3a5776fe2",
    "supplier_return_quantity_bound()": "1ac8224efb6b2f7c036d57207afcbfd08c7e469d745b3657271a0eb2cbadbe26",
    "stock_source_complete_purchase_reversal()": "61d96c8dfe2c30fb6d7689bf771bd677ce03a2541beb33c48b4d1476b1efdcba",
    "stock_source_complete_purchase_reversal_header()": "24b99c06756f9acd5190d12d1f693cb90c9ab023480a4172c382ccd98e6686e1",
    "purchase_reversal_value_complete()": "55d5d4f779fe497263a70445a869aa8f9fc1e235fc350f389c07ceccab72e3e0",
    "supplier_return_detail_same_transaction()": "68a8c04daa668ef1574f6e7109ca1756a33310005d82455118047f328717aa49",
    "purchase_reversal_detail_same_transaction()": "e408924187c911f6b1d61f46ce1ae7e6ff965f2807562c9cfaa176508c5838bf",
    "supplier_credit_note_guard()": "a21031b39170a8cec024de3947b8de6ee70c7def674235fcdbff01f27d99177e"
  }';
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_s3 := v_type IN ('inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake');
    v_s4 := v_type IN ('negative_inventory_cost_adjustment', 'purchase');
    v_s5 := v_type IN ('purchase_reversal', 'supplier_return');
    v_line_tbl := NULL;
    v_line_key := NULL;
    SELECT to_regclass('public.' || e.tbl), e.cols INTO v_line_tbl, v_line_key
    FROM (VALUES ('inventory_transfer',   'inventory_transfer_lines',   ARRAY['business_id', 'transfer_id', 'id']),
                 ('inventory_adjustment', 'inventory_adjustment_lines', ARRAY['business_id', 'adjustment_id', 'id']),
                 ('stocktake',            'stocktake_lines',            ARRAY['business_id', 'stocktake_id', 'id']),
                 ('inventory_opening',    'inventory_opening_lines',    ARRAY['business_id', 'opening_id', 'id']),
                 ('purchase',             'purchase_lines',             ARRAY['business_id', 'purchase_id', 'id']),
                 ('negative_inventory_cost_adjustment', 'negative_deficit_coverages', ARRAY['business_id', 'adjustment_id', 'id']),
                 ('supplier_return',      'supplier_return_lines',      ARRAY['business_id', 'return_id', 'id']),
                 ('purchase_reversal',    'purchase_reversal_lines',    ARRAY['business_id', 'reversal_id', 'id'])) AS e(st, tbl, cols)
    WHERE e.st = v_type;
    v_bridge := to_regclass('public.stock_source_bridge_' || v_type);
    IF v_bridge IS NULL OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relkind = 'r') THEN
      source_type := v_type; missing := 'bridge'; RETURN NEXT;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relrowsecurity AND c.relforcerowsecurity) THEN
        source_type := v_type; missing := 'bridge_rls'; RETURN NEXT;
      END IF;
      IF (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM pg_constraint c
            CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.conrelid = v_bridge AND c.contype = 'p')
         IS DISTINCT FROM ARRAY['business_id', 'source_id', 'source_line_id', 'movement_kind'] THEN
        source_type := v_type; missing := 'bridge_pk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = v_bridge AND a.attname = 'source_type' AND NOT a.attisdropped
                        AND a.attgenerated = 's'
                        AND pg_get_expr(d.adbin, d.adrelid) = quote_literal(v_type) || '::text') THEN
        source_type := v_type; missing := 'bridge_source_type'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid = v_bind AND c.confdeltype = 'r' AND c.convalidated
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']) THEN
        source_type := v_type; missing := 'bridge_binding_fk'; RETURN NEXT;
      END IF;
      -- The line FK: for an S3, S4 or S5 type to exactly its line table and key,
      -- for any other type to some third table (the S2 template).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid <> v_bind
                        AND c.confrelid <> v_bridge AND c.confdeltype = 'r' AND c.convalidated
                        AND (NOT (v_s3 OR v_s4 OR v_s5) OR c.confrelid = v_line_tbl)
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_id', 'source_line_id']
                        AND (NOT (v_s3 OR v_s4 OR v_s5)
                             OR (SELECT array_agg(a.attname::text ORDER BY k.ord)
                                   FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                                = v_line_key)) THEN
        source_type := v_type; missing := 'bridge_line_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                       JOIN pg_proc p ON p.oid = g.tgfoid
                      WHERE g.tgrelid = v_bridge AND NOT g.tgisinternal
                        AND g.tgname = 'stock_bridge_immutable_' || v_type
                        AND g.tgtype = 27                -- ROW | BEFORE | DELETE | UPDATE, nothing else
                        AND g.tgenabled IN ('O', 'A')
                        AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                        AND g.tgfoid = 'public.stock_ledger_append_only()'::regprocedure
                        AND (NOT (v_s3 OR v_s4 OR v_s5) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
                                                   = c_digest ->> 'stock_ledger_append_only()')) THEN
        source_type := v_type; missing := 'bridge_immutable'; RETURN NEXT;
      END IF;
    END IF;
    v_fn := to_regprocedure('public.stock_binding_requires_' || v_type || '()');
    IF v_fn IS NULL OR NOT EXISTS (
         SELECT 1 FROM pg_trigger g
           JOIN pg_proc p ON p.oid = g.tgfoid
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE g.tgrelid = v_bind
            AND g.tgname = 'stock_binding_requires_' || v_type
            AND g.tgtype = 5                              -- ROW | AFTER | INSERT, nothing else
            AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
            AND g.tgenabled IN ('O', 'A')
            AND g.tgfoid = v_fn
            AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
            AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
            AND position('WHEN ((new.source_type = ' || quote_literal(v_type) || '::text))' IN pg_get_triggerdef(g.oid)) > 0
            AND (NOT (v_s3 OR v_s4 OR v_s5) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
                                       = c_digest ->> ('stock_binding_requires_' || v_type || '()'))) THEN
      source_type := v_type; missing := 'binding_trigger'; RETURN NEXT;
    END IF;

    -- The rest of an S3 type's §2.3 set, on its own document tables: each
    -- unconditional, on every column of its events, on its expected
    -- internal DEFINER function with the pinned path and the recorded body.
    IF v_s3 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn
        FROM (VALUES
          ('inventory_transfer',   'source_complete',  'inventory_transfer_lines',   'stock_source_complete_inventory_transfer',   5,  true,  'stock_source_complete_inventory_transfer()'),
          ('inventory_transfer',   'source_freeze',    'inventory_transfer_lines',   'stock_source_freeze_inventory_transfer',     27, false, 'stock_source_freeze_inventory_transfer()'),
          ('inventory_transfer',   'header_immutable', 'inventory_transfers',        'inventory_transfers_immutable',              27, false, 'inventory_source_header_guard()'),
          ('inventory_adjustment', 'source_complete',  'inventory_adjustment_lines', 'stock_source_complete_inventory_adjustment', 5,  true,  'stock_source_complete_inventory_adjustment()'),
          ('inventory_adjustment', 'source_freeze',    'inventory_adjustment_lines', 'stock_source_freeze_inventory_adjustment',   27, false, 'stock_source_freeze_inventory_adjustment()'),
          ('inventory_adjustment', 'header_immutable', 'inventory_adjustments',      'inventory_adjustments_immutable',            27, false, 'inventory_source_header_guard()'),
          ('inventory_adjustment', 'value_complete',   'inventory_adjustments',      'inventory_adjustments_value_complete',       21, true,  'inventory_source_value_complete()'),
          ('stocktake',            'source_complete',  'stocktake_lines',            'stock_source_complete_stocktake',            21, true,  'stock_source_complete_stocktake()'),
          ('stocktake',            'header_complete',  'stocktakes',                 'stocktakes_finalized_complete',              17, true,  'stock_source_complete_stocktake_header()'),
          ('stocktake',            'source_freeze',    'stocktake_lines',            'stock_source_freeze_stocktake',              27, false, 'stock_source_freeze_stocktake()'),
          ('stocktake',            'header_immutable', 'stocktakes',                 'stocktakes_immutable',                       27, false, 'inventory_source_header_guard()'),
          ('stocktake',            'value_complete',   'stocktakes',                 'stocktakes_value_complete',                  21, true,  'inventory_source_value_complete()'),
          ('inventory_opening',    'source_complete',  'inventory_opening_lines',    'stock_source_complete_inventory_opening',    5,  true,  'stock_source_complete_inventory_opening()'),
          ('inventory_opening',    'source_freeze',    'inventory_opening_lines',    'stock_source_freeze_inventory_opening',      27, false, 'stock_source_freeze_inventory_opening()'),
          ('inventory_opening',    'header_immutable', 'inventory_openings',         'inventory_openings_immutable',               27, false, 'inventory_source_header_guard()'),
          ('inventory_opening',    'value_complete',   'inventory_openings',         'inventory_openings_value_complete',          21, true,  'inventory_source_value_complete()')
        ) AS e(st, missing, tbl, tg, typ, deferred, fn)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;

    -- The S4 per-type set (§2.3), the same shape checks; `internal` says
    -- whether the function is an internal DEFINER one or the migrator-owned
    -- INVOKER `stock_ledger_append_only()`.
    IF v_s4 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn, e.internal
        FROM (VALUES
          ('purchase', 'source_complete',  'purchase_lines', 'stock_source_complete_purchase', 21, true,  'stock_source_complete_purchase()',        true),
          ('purchase', 'header_complete',  'purchases',      'purchases_received_complete',    17, true,  'stock_source_complete_purchase_header()', true),
          ('purchase', 'source_freeze',    'purchase_lines', 'stock_source_freeze_purchase',   31, false, 'stock_source_freeze_purchase()',          true),
          ('purchase', 'header_immutable', 'purchases',      'purchases_immutable',            31, false, 'purchase_header_guard()',                 true),
          ('purchase', 'value_complete',   'purchases',      'purchases_value_complete',       17, true,  'purchase_source_value_complete()',        true),
          -- R-38: the landed-cost guards (R-34 events).
          ('purchase', 'landed_cost_freeze',     'purchase_landed_costs',            'purchase_landed_costs_freeze',            31, false,
           'purchase_landed_cost_freeze()', true),
          ('purchase', 'allocation_freeze',      'purchase_landed_cost_allocations', 'purchase_landed_cost_allocations_freeze', 31, false,
           'purchase_landed_cost_freeze()', true),
          ('purchase', 'allocation_consistent',  'purchase_landed_cost_allocations', 'purchase_allocations_consistent',         5,  true,
           'purchase_allocations_consistent()', true),
          ('purchase', 'landed_cost_consistent', 'purchase_landed_costs',            'purchase_landed_costs_consistent',        5,  true,
           'purchase_allocations_consistent()', true),
          ('negative_inventory_cost_adjustment', 'source_complete', 'negative_deficit_coverages',
           'stock_source_complete_negative_inventory_cost_adjustment', 5, true, 'stock_source_complete_negative_inventory_cost_adjustment()', true),
          ('negative_inventory_cost_adjustment', 'source_freeze', 'negative_deficit_coverages',
           'negative_deficit_coverages_append_only', 27, false, 'stock_ledger_append_only()', false),
          ('negative_inventory_cost_adjustment', 'header_immutable', 'negative_inventory_cost_adjustments',
           'negative_inventory_cost_adjustments_immutable', 27, false, 'stock_ledger_append_only()', false),
          ('negative_inventory_cost_adjustment', 'value_complete', 'negative_inventory_cost_adjustments',
           'negative_inventory_cost_adjustments_value_complete', 5, true, 'purchase_source_value_complete()', true),
          -- R-38: the coverage guards (R-36) and the A-16(g) deficit guards.
          ('negative_inventory_cost_adjustment', 'coverage_same_transaction', 'negative_deficit_coverages',
           'negative_deficit_coverages_same_transaction', 7, false, 'negative_deficit_coverage_same_transaction()', true),
          ('negative_inventory_cost_adjustment', 'coverage_value_complete', 'negative_deficit_coverages',
           'negative_deficit_coverages_value_complete', 5, true, 'purchase_source_value_complete()', true),
          ('negative_inventory_cost_adjustment', 'deficit_guard', 'negative_inventory_deficits',
           'negative_inventory_deficits_coverage_guard', 27, false, 'negative_inventory_deficits_coverage_guard()', true),
          ('negative_inventory_cost_adjustment', 'deficit_consistent', 'negative_inventory_deficits',
           'negative_inventory_deficits_coverage_consistent', 17, true, 'negative_inventory_deficits_coverage_consistent()', true)
        ) AS e(st, missing, tbl, tg, typ, deferred, fn, internal)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND CASE WHEN v_g.internal THEN r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                         ELSE r.rolname <> 'daftar_inventory_internal' AND NOT p.prosecdef END
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
    -- The S5 per-type set (§2.3, 0063 R-38 carried forward), the S4 loop's
    -- shape exactly.
    IF v_s5 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn, e.internal
        FROM (VALUES
          ('supplier_return', 'source_complete',  'supplier_return_lines', 'stock_source_complete_supplier_return', 5, true,
           'stock_source_complete_supplier_return()', true),
          ('supplier_return', 'header_complete',  'supplier_returns',      'supplier_returns_complete',             5, true,
           'stock_source_complete_supplier_return_header()', true),
          ('supplier_return', 'source_freeze',    'supplier_return_lines', 'stock_source_freeze_supplier_return',   27, false,
           'stock_ledger_append_only()', false),
          ('supplier_return', 'header_immutable', 'supplier_returns',      'supplier_returns_immutable',            27, false,
           'stock_ledger_append_only()', false),
          ('supplier_return', 'value_complete',   'supplier_returns',      'supplier_returns_value_complete',       5, true,
           'supplier_return_value_complete()', true),
          ('supplier_return', 'quantity_bound',   'supplier_return_lines', 'supplier_return_lines_quantity_bound',  5, true,
           'supplier_return_quantity_bound()', true),
          ('supplier_return', 'line_same_transaction', 'supplier_return_lines', 'supplier_return_lines_same_transaction', 7, false,
           'supplier_return_detail_same_transaction()', true),
          ('supplier_return', 'credit_note_same_transaction', 'supplier_credit_notes', 'supplier_credit_notes_same_transaction', 7, false,
           'supplier_return_detail_same_transaction()', true),
          -- R-53: the A-11(e) credit-note immutability guard.
          ('supplier_return', 'credit_note_immutable', 'supplier_credit_notes', 'supplier_credit_notes_immutable', 27, false,
           'supplier_credit_note_guard()', true),
          ('purchase_reversal', 'source_complete',  'purchase_reversal_lines', 'stock_source_complete_purchase_reversal', 5, true,
           'stock_source_complete_purchase_reversal()', true),
          ('purchase_reversal', 'header_complete',  'purchase_reversals',      'purchase_reversals_complete',             5, true,
           'stock_source_complete_purchase_reversal_header()', true),
          ('purchase_reversal', 'source_freeze',    'purchase_reversal_lines', 'stock_source_freeze_purchase_reversal',   27, false,
           'stock_ledger_append_only()', false),
          ('purchase_reversal', 'header_immutable', 'purchase_reversals',      'purchase_reversals_immutable',            27, false,
           'stock_ledger_append_only()', false),
          ('purchase_reversal', 'value_complete',   'purchase_reversals',      'purchase_reversals_value_complete',       5, true,
           'purchase_reversal_value_complete()', true),
          ('purchase_reversal', 'line_same_transaction', 'purchase_reversal_lines', 'purchase_reversal_lines_same_transaction', 7, false,
           'purchase_reversal_detail_same_transaction()', true)
        ) AS e(st, missing, tbl, tg, typ, deferred, fn, internal)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND CASE WHEN v_g.internal THEN r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                         ELSE r.rolname <> 'daftar_inventory_internal' AND NOT p.prosecdef END
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B, strengthened by P3-S3 (A-16, review F3). Catalogue-only discovery: for every stock_source_types row, reports each missing or mis-shaped guard — bridge (a plain table), bridge_rls (enabled and forced), bridge_pk (exactly business_id, source_id, source_line_id, movement_kind), bridge_source_type (a stored generated constant equal to the type), bridge_binding_fk (validated RESTRICT, five columns in order), bridge_line_fk (validated RESTRICT, business_id, source_id, source_line_id; for an S3 type to exactly its line table and key), bridge_immutable (ROW BEFORE UPDATE OR DELETE on every column, no WHEN, enabled for origin sessions, on stock_ledger_append_only()), binding_trigger (ROW AFTER INSERT deferred constraint trigger on its own internal DEFINER function with the pinned path and the WHEN on the type). For the four S3 types also source_complete, source_freeze, header_immutable, value_complete and (stocktake) header_complete, each by table, name, event, column list, WHEN, deferral, enabled state and expected internal DEFINER pinned function; and every S3 guard function''s body against the SHA-256 of its prosrc recorded at migration time. Replaced by P3-S4 (0063, §2.3): the two S4 types (purchase, negative_inventory_cost_adjustment) get the S3 bridge_line_fk (purchase_lines / negative_deficit_coverages), bridge_immutable and binding_trigger checks, and their own set — source_complete, header_complete (purchase), source_freeze, header_immutable, value_complete — with every S4 guard function''s body recorded the same way (the two stock_ledger_append_only() guards as migrator-owned INVOKER); per the P3-S4 review also landed_cost_freeze, allocation_freeze, allocation_consistent, landed_cost_consistent (purchase) and coverage_same_transaction, coverage_value_complete, deficit_guard, deficit_consistent (negative_inventory_cost_adjustment), the three freeze triggers and the header guard judging INSERT too. Replaced by P3-S5 (0065, §2.3): the two S5 types (supplier_return, purchase_reversal) get the same bridge_line_fk (supplier_return_lines / purchase_reversal_lines), bridge_immutable and binding_trigger checks and their own set — source_complete, header_complete, source_freeze, header_immutable, value_complete, line_same_transaction, and (supplier_return) quantity_bound, credit_note_same_transaction and credit_note_immutable — with every S5 guard function''s body recorded the same way; the S3 and S4 parts are unchanged. Every migration that registers a source type asserts it returns no row. Replaced by P3-S6 (0067, R-70(b)): byte-identical to 0065''s except the recorded digest of supplier_credit_note_guard(), which its owner replaced to admit the AL-31 decrement (R-66). Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The S6 guard discovery (§2.3, 0063 R-38, R-70(a)). Migrator-owned
--    INVOKER STABLE, pinned, no grantee (tests run it as the owner). One row
--    per gap: the thirteen §2.3 triggers by table, name, tgtype, deferral,
--    enabled state ('O'), no WHEN and no column list, and their functions;
--    then the two verification helpers and the three arithmetic functions
--    the guards compute with, and the two replaced S5 extension points
--    (R-79) (table_name '-', trigger_name the function's signature). Every
--    guard, helper and arithmetic function is checked for its owner (the
--    internal principal), DEFINER, the pinned path and the SHA-256 of its
--    prosrc recorded at migration time (0063/0065's digest, R-70(a)); each
--    extension point for the discovery's own (migrator) owner, INVOKER, the
--    pinned path and its digest. 0068 re-creates this function with the
--    R-73 writer's row added (R-79).
--    Codes: trigger_missing, trigger_disabled, trigger_shape, function_owner,
--    function_not_definer, function_not_invoker, function_search_path,
--    function_body.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_settlement_guard_gaps()
RETURNS TABLE (table_name TEXT, trigger_name TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_g   RECORD;
  v_tg  RECORD;
  v_p   RECORD;
  v_fn  REGPROCEDURE;
  v_me  TEXT;
  -- SHA-256 (hex) of each S6 guard, helper and arithmetic function's prosrc,
  -- recorded at migration time (0067), the replaced credit-note guard and
  -- the two replaced extension points included (R-79).
  c_digest CONSTANT JSONB := '{
    "payment_method_guard()": "e1ebd743f99dae8e059d903d8fb73c65858cabb70ffc5dcb2fbd45407dadb162",
    "payment_method_named()": "07cdc55fa3181e6b4de214ff4a34a72674d2802de1c045c51662dcf6c2637390",
    "payment_method_name_guard()": "d0414ced4449ddb1cad3b312aa9674174a4a3df9717e2cdaddca794d050628fa",
    "supplier_payment_guard()": "f373f9ef42dbf417253913300ec96a53523b33ef9282c4fbdd9e6ef44ca62fca",
    "supplier_payment_complete()": "0c409912d2936944253c5f08534a4e8108eed0283ffead0e8f567c6f3dcfad54",
    "supplier_payment_allocation_guard()": "aaf2efe1e56207a406fb4ef956ee427ec26cc26a6d92db8a0a22286425e09b8d",
    "supplier_payment_allocation_value_complete()": "75116b059a15e70a6c34583a4802912eed0f36cdad6b9fe26e62a4790a3054ad",
    "supplier_credit_allocation_guard()": "0120e79f3e7be686632df65199bf46d65742d43094d5ab5d026810d8774c5886",
    "supplier_credit_allocation_value_complete()": "184a467ce6d59945f0c49fcaa16685722fbadb582f0a30f9adea04690aadc054",
    "supplier_refund_guard()": "72cb27729e52a82547bf70cd83f57e9d5abfd104890fe98bd64f339173630f15",
    "supplier_refund_value_complete()": "a82873ddad98bd9946c4d3c2213c998933487a8cc928bb966c724c3e121e4307",
    "supplier_credit_note_guard()": "a21031b39170a8cec024de3947b8de6ee70c7def674235fcdbff01f27d99177e",
    "purchase_reversal_unsettled()": "d84f8b51c5033fb47ceb4c03fccd41a7576faf4ed5529dc4a1c31a64bc9508bf",
    "purchase_settlement_verify(uuid,uuid)": "4fcbb7931c06fbf9cf11fc2ede6e4b97357d24b038ed412329c55a48cbafe8ba",
    "supplier_credit_note_verify(uuid,uuid)": "9d18ee17cfdd5f778ee3a767351506d6bbd2209c15d839ed6a295d601abbf76e",
    "supplier_convert_base(bigint,numeric,integer,integer)": "38d765449e2844c1d84971f09277b5857bbddbf741b62a3d8b4c1d4e532e39cf",
    "supplier_ap_release(bigint,bigint,bigint,bigint)": "47eb15a7fc56e1871b5c521ca189782bfbafb8dca3e7bd0bb3adc417016236a9",
    "supplier_credit_remaining_carrying(bigint,bigint,bigint)": "941082099606f825336b0249a76658e65e592df6bbe06f3081576a5be0205144",
    "purchase_ap_outstanding(uuid,uuid)": "74091f5ea48dd4873664692bb06cf1d9de025d1b98093c3d2b39bbd300d3b036",
    "purchase_settlement_state(uuid,uuid)": "b236cda5fe48a2b00c818e0f88f8e9b8de9a3c5b61d04c5cf677e56960d7037b"
  }';
BEGIN
  -- The extension points' expected owner: the migrator, who owns this discovery.
  SELECT r.rolname::text INTO v_me
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = 'public.supplier_settlement_guard_gaps()'::regprocedure;
  FOR v_g IN
    SELECT e.tbl, e.tg, e.typ, e.deferred, e.fn, (e.ord IN (19, 20)) AS invoker
    FROM (VALUES
      (1,  'payment_methods',              'payment_methods_guard',                       31,   false, 'payment_method_guard()'),
      (2,  'payment_methods',              'payment_methods_named',                       21,   true,  'payment_method_named()'),
      (3,  'payment_method_names',         'payment_method_names_guard',                  31,   false, 'payment_method_name_guard()'),
      (4,  'supplier_payments',            'supplier_payments_guard',                     31,   false, 'supplier_payment_guard()'),
      (5,  'supplier_payments',            'supplier_payments_complete',                  5,    true,  'supplier_payment_complete()'),
      (6,  'supplier_payment_allocations', 'supplier_payment_allocations_guard',          31,   false, 'supplier_payment_allocation_guard()'),
      (7,  'supplier_payment_allocations', 'supplier_payment_allocations_value_complete', 5,    true,  'supplier_payment_allocation_value_complete()'),
      (8,  'supplier_credit_allocations',  'supplier_credit_allocations_guard',           31,   false, 'supplier_credit_allocation_guard()'),
      (9,  'supplier_credit_allocations',  'supplier_credit_allocations_value_complete',  5,    true,  'supplier_credit_allocation_value_complete()'),
      (10, 'supplier_refunds',             'supplier_refunds_guard',                      31,   false, 'supplier_refund_guard()'),
      (11, 'supplier_refunds',             'supplier_refunds_value_complete',             5,    true,  'supplier_refund_value_complete()'),
      (12, 'supplier_credit_notes',        'supplier_credit_notes_immutable',             27,   false, 'supplier_credit_note_guard()'),
      (13, 'purchase_reversals',           'purchase_reversals_unsettled',                5,    true,  'purchase_reversal_unsettled()'),
      (14, '-', 'purchase_settlement_verify(uuid,uuid)',                    NULL, NULL, 'purchase_settlement_verify(uuid,uuid)'),
      (15, '-', 'supplier_credit_note_verify(uuid,uuid)',                   NULL, NULL, 'supplier_credit_note_verify(uuid,uuid)'),
      (16, '-', 'supplier_convert_base(bigint,numeric,integer,integer)',    NULL, NULL, 'supplier_convert_base(bigint,numeric,integer,integer)'),
      (17, '-', 'supplier_ap_release(bigint,bigint,bigint,bigint)',         NULL, NULL, 'supplier_ap_release(bigint,bigint,bigint,bigint)'),
      (18, '-', 'supplier_credit_remaining_carrying(bigint,bigint,bigint)', NULL, NULL, 'supplier_credit_remaining_carrying(bigint,bigint,bigint)'),
      (19, '-', 'purchase_ap_outstanding(uuid,uuid)',                       NULL, NULL, 'purchase_ap_outstanding(uuid,uuid)'),
      (20, '-', 'purchase_settlement_state(uuid,uuid)',                     NULL, NULL, 'purchase_settlement_state(uuid,uuid)')
    ) AS e(ord, tbl, tg, typ, deferred, fn)
    ORDER BY e.ord
  LOOP
    v_fn := to_regprocedure('public.' || v_g.fn);
    IF v_g.tbl <> '-' THEN
      SELECT g.tgenabled::text AS enabled, g.tgtype::integer AS typ, g.tgfoid,
             (g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0) AS plain,
             (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) AS deferred
        INTO v_tg
      FROM pg_trigger g
      WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal;
      IF NOT FOUND THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_missing'; RETURN NEXT;
        CONTINUE;
      END IF;
      IF v_tg.enabled <> 'O' THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_disabled'; RETURN NEXT;
      END IF;
      IF v_tg.typ <> v_g.typ OR v_tg.deferred <> v_g.deferred OR NOT v_tg.plain OR v_fn IS NULL OR v_tg.tgfoid <> v_fn THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_shape'; RETURN NEXT;
      END IF;
    END IF;
    SELECT r.rolname::text AS owner, p.prosecdef, p.proconfig, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS digest
      INTO v_p
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_fn;
    IF NOT FOUND THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_body'; RETURN NEXT;
      CONTINUE;
    END IF;
    IF v_p.owner IS DISTINCT FROM (CASE WHEN v_g.invoker THEN v_me ELSE 'daftar_inventory_internal' END) THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_owner'; RETURN NEXT;
    END IF;
    IF NOT v_g.invoker AND NOT v_p.prosecdef THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_not_definer'; RETURN NEXT;
    END IF;
    IF v_g.invoker AND v_p.prosecdef THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_not_invoker'; RETURN NEXT;
    END IF;
    IF v_p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_search_path'; RETURN NEXT;
    END IF;
    IF v_p.digest IS DISTINCT FROM c_digest ->> v_g.fn THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_body'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION supplier_settlement_guard_gaps() IS
  'P3-S6 §2.3 (0067, R-70(a)). Catalogue-only discovery of the S6 guards: for each of the thirteen §2.3 triggers (payment_methods_guard, payment_methods_named, payment_method_names_guard, supplier_payments_guard, supplier_payments_complete, supplier_payment_allocations_guard, supplier_payment_allocations_value_complete, supplier_credit_allocations_guard, supplier_credit_allocations_value_complete, supplier_refunds_guard, supplier_refunds_value_complete, the S5 supplier_credit_notes_immutable on its replaced function, purchase_reversals_unsettled) reports trigger_missing, trigger_disabled (tgenabled other than O) and trigger_shape (tgtype, deferral, WHEN, column list, function); for each trigger function, the two verification helpers and the three arithmetic functions (table_name -, trigger_name the signature) reports function_owner (not daftar_inventory_internal), function_not_definer, function_search_path and function_body (the SHA-256 of prosrc recorded at migration time); for the two replaced extension points purchase_ap_outstanding and purchase_settlement_state (R-79) reports function_owner (not this discovery''s migrator owner), function_not_invoker, function_search_path and function_body. Migrator-owned INVOKER; no EXECUTE grant. 0068 re-creates it with the credit-note writer''s row (R-79).';

REVOKE ALL ON FUNCTION supplier_settlement_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The accounting side (A-14). Every function is owned by
--    daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked, inside the
--    accounting CREATE bracket (0058:40-71).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- (b) R-65 / A-06: the settlement-account policy, stated once. STABLE; the
--     transaction's business only (the accounting_purchase_fx_rate
--     precedent); checked in order not_found, inactive, not_asset,
--     not_settlement. The inventory principal reaches it and gains no read
--     of `accounts`.
CREATE OR REPLACE FUNCTION accounting_settlement_account_eligibility(p_business_id UUID, p_account_id UUID) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_type   TEXT;
  v_key    TEXT;
  v_active BOOLEAN;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'accounting.scope_mismatch: a settlement account is judged only for the transaction''s business' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.type, a.system_key, a.is_active INTO v_type, v_key, v_active
  FROM accounts a WHERE a.business_id = p_business_id AND a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT v_active THEN
    RETURN 'inactive';
  END IF;
  IF v_type <> 'asset' THEN
    RETURN 'not_asset';
  END IF;
  IF v_key IS NOT NULL AND v_key NOT IN ('cash', 'bank', 'card_clearing', 'wallet_clearing', 'cheque_clearing') THEN
    RETURN 'not_settlement';
  END IF;
  RETURN 'eligible';
END;
$$;

COMMENT ON FUNCTION accounting_settlement_account_eligibility(UUID, UUID) IS
  'P3-S6 A-06, A-14(b), R-65. The settlement-account policy of a payment method''s posting account, for the transaction''s business only (accounting.scope_mismatch otherwise): not_found, inactive, not_asset (accounts.type other than asset), not_settlement (a system key other than cash, bank, card_clearing, wallet_clearing, cheque_clearing), else eligible. STABLE, writes nothing. EXECUTE: daftar_inventory_internal only (the method commands and the S6 guards); the inventory principal gains no SELECT on accounts.';

-- (a) Detail completeness (AL-01 re-proved, A-05): each S6 entry cannot
--     commit without exactly its one source row, on that row's date, in
--     exactly the A-05 lines for the row's stored amounts. Lines are
--     compared as a multiset of signatures: account (the stored posting
--     account as `posting`, else the system key), side, base amount, txn
--     currency and amount, rate, rate source, rate instant, warehouse (none)
--     and branch. A foreign line carries its stored snapshot; a base line is
--     rate 1, source base, at the entry date 00:00 UTC. Realized FX posts
--     only to fx_loss or fx_gain, by table and sign (R-64).
CREATE OR REPLACE FUNCTION accounting_supplier_payment_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_a        RECORD;
  v_h        RECORD;
  v_p        RECORD;
  v_base_ccy TEXT;
  v_branch   UUID;
  v_one      TEXT;
  v_psnap    TEXT;
  v_hsnap    TEXT;
  v_base     TEXT;
  v_conv     BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT a.payment_id, a.purchase_id, a.payment_currency, a.payment_amount_minor, a.payment_base_amount_minor, a.purchase_currency,
         a.purchase_amount_applied_minor, a.purchase_carrying_base_released_minor, a.ap_dust_base_minor, a.realized_fx_gain_loss_minor
    INTO v_a
  FROM supplier_payment_allocations a
  WHERE a.business_id = NEW.business_id AND a.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a supplier payment entry must be registered by its allocation in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT h.payment_date, h.posting_account_id, h.payment_to_base_rate, h.rate_source, h.rate_timestamp INTO v_h
  FROM supplier_payments h WHERE h.business_id = NEW.business_id AND h.id = v_a.payment_id;
  SELECT p.warehouse_id, p.source_to_base_rate, p.rate_source, p.rate_timestamp INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = v_a.purchase_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_p.warehouse_id;
  v_one   := (1::numeric(20,10))::text;
  v_conv  := v_a.purchase_carrying_base_released_minor - v_a.ap_dust_base_minor;
  v_psnap := concat_ws('|', v_p.source_to_base_rate::text, v_p.rate_source, extract(epoch FROM v_p.rate_timestamp)::text);
  v_hsnap := concat_ws('|', v_h.payment_to_base_rate::text, v_h.rate_source, extract(epoch FROM v_h.rate_timestamp)::text);
  v_base  := concat_ws('|', v_one, 'base', extract(epoch FROM (v_h.payment_date::timestamp AT TIME ZONE 'UTC'))::text);

  -- The expected lines (A-05(a)), each present only when its amount ≠ 0.
  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'accounts_payable', 'D', v_conv::text, v_a.purchase_currency::text,
    v_a.purchase_amount_applied_minor::text, v_psnap, '-', coalesce(v_branch::text, '-'));
  IF v_a.ap_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_payable', CASE WHEN v_a.ap_dust_base_minor > 0 THEN 'D' ELSE 'C' END,
      abs(v_a.ap_dust_base_minor)::text, v_base_ccy, abs(v_a.ap_dust_base_minor)::text, v_base, '-', coalesce(v_branch::text, '-'));
  END IF;
  v_expected := v_expected || concat_ws('|', 'posting', 'C', v_a.payment_base_amount_minor::text, v_a.payment_currency::text,
    v_a.payment_amount_minor::text, v_hsnap, '-', coalesce(v_branch::text, '-'));
  IF v_a.realized_fx_gain_loss_minor > 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_loss', 'D', v_a.realized_fx_gain_loss_minor::text, v_base_ccy,
      v_a.realized_fx_gain_loss_minor::text, v_base, '-', coalesce(v_branch::text, '-'));
  ELSIF v_a.realized_fx_gain_loss_minor < 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_gain', 'C', abs(v_a.realized_fx_gain_loss_minor)::text, v_base_ccy,
      abs(v_a.realized_fx_gain_loss_minor)::text, v_base, '-', coalesce(v_branch::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', CASE WHEN l.account_id = v_h.posting_account_id THEN 'posting' ELSE coalesce(a.system_key, '-') END,
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_h.payment_date OR v_base_ccy IS NULL OR v_branch IS NULL
     OR v_p.rate_timestamp IS NULL OR v_h.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a supplier payment entry is not exactly the A-05 lines of its allocation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_supplier_credit_allocation_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_c        RECORD;
  v_p        RECORD;
  v_n        RECORD;
  v_base_ccy TEXT;
  v_tbranch  UUID;
  v_obranch  UUID;
  v_one      TEXT;
  v_psnap    TEXT;
  v_nsnap    TEXT;
  v_base     TEXT;
  v_conv     BIGINT;
  v_cr_conv  BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT c.credit_note_id, c.purchase_id, c.allocation_date, c.credit_currency, c.credit_amount_consumed_minor,
         c.credit_carrying_base_released_minor, c.credit_dust_base_minor, c.purchase_currency, c.purchase_amount_applied_minor,
         c.purchase_carrying_base_released_minor, c.ap_dust_base_minor, c.realized_fx_gain_loss_minor
    INTO v_c
  FROM supplier_credit_allocations c
  WHERE c.business_id = NEW.business_id AND c.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a supplier credit allocation entry must be registered by its allocation in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT p.warehouse_id, p.source_to_base_rate, p.rate_source, p.rate_timestamp INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = v_c.purchase_id;
  SELECT n.source_to_base_rate, n.rate_source, n.rate_timestamp, op.warehouse_id INTO v_n
  FROM supplier_credit_notes n
  JOIN supplier_returns r ON r.business_id = n.business_id AND r.id = n.supplier_return_id
  JOIN purchases op ON op.business_id = r.business_id AND op.id = r.purchase_id
  WHERE n.business_id = NEW.business_id AND n.id = v_c.credit_note_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT w.branch_id INTO v_tbranch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_p.warehouse_id;
  SELECT w.branch_id INTO v_obranch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_n.warehouse_id;
  v_one     := (1::numeric(20,10))::text;
  v_conv    := v_c.purchase_carrying_base_released_minor - v_c.ap_dust_base_minor;
  v_cr_conv := v_c.credit_carrying_base_released_minor - v_c.credit_dust_base_minor;
  v_psnap   := concat_ws('|', v_p.source_to_base_rate::text, v_p.rate_source, extract(epoch FROM v_p.rate_timestamp)::text);
  v_nsnap   := concat_ws('|', v_n.source_to_base_rate::text, v_n.rate_source, extract(epoch FROM v_n.rate_timestamp)::text);
  v_base    := concat_ws('|', v_one, 'base', extract(epoch FROM (v_c.allocation_date::timestamp AT TIME ZONE 'UTC'))::text);

  -- The expected lines (A-05(b)): AP and FX on the target purchase's
  -- branch, the 1150 lines on the note's origin purchase's branch.
  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'accounts_payable', 'D', v_conv::text, v_c.purchase_currency::text,
    v_c.purchase_amount_applied_minor::text, v_psnap, '-', coalesce(v_tbranch::text, '-'));
  IF v_c.ap_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_payable', CASE WHEN v_c.ap_dust_base_minor > 0 THEN 'D' ELSE 'C' END,
      abs(v_c.ap_dust_base_minor)::text, v_base_ccy, abs(v_c.ap_dust_base_minor)::text, v_base, '-', coalesce(v_tbranch::text, '-'));
  END IF;
  v_expected := v_expected || concat_ws('|', 'supplier_receivable', 'C', v_cr_conv::text, v_c.credit_currency::text,
    v_c.credit_amount_consumed_minor::text, v_nsnap, '-', coalesce(v_obranch::text, '-'));
  IF v_c.credit_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'supplier_receivable', CASE WHEN v_c.credit_dust_base_minor > 0 THEN 'C' ELSE 'D' END,
      abs(v_c.credit_dust_base_minor)::text, v_base_ccy, abs(v_c.credit_dust_base_minor)::text, v_base, '-', coalesce(v_obranch::text, '-'));
  END IF;
  IF v_c.realized_fx_gain_loss_minor > 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_loss', 'D', v_c.realized_fx_gain_loss_minor::text, v_base_ccy,
      v_c.realized_fx_gain_loss_minor::text, v_base, '-', coalesce(v_tbranch::text, '-'));
  ELSIF v_c.realized_fx_gain_loss_minor < 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_gain', 'C', abs(v_c.realized_fx_gain_loss_minor)::text, v_base_ccy,
      abs(v_c.realized_fx_gain_loss_minor)::text, v_base, '-', coalesce(v_tbranch::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', coalesce(a.system_key, '-'),
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_c.allocation_date OR v_base_ccy IS NULL OR v_tbranch IS NULL OR v_obranch IS NULL
     OR v_p.rate_timestamp IS NULL OR v_n.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a supplier credit allocation entry is not exactly the A-05 lines of its allocation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_supplier_refund_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_f        RECORD;
  v_n        RECORD;
  v_base_ccy TEXT;
  v_obranch  UUID;
  v_one      TEXT;
  v_rsnap    TEXT;
  v_nsnap    TEXT;
  v_base     TEXT;
  v_cr_conv  BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT f.credit_note_id, f.refund_date, f.posting_account_id, f.source_currency, f.source_amount_consumed_minor,
         f.source_carrying_base_released_minor, f.source_dust_base_minor, f.receipt_currency, f.receipt_amount_minor,
         f.receipt_to_base_rate, f.receipt_base_amount_minor, f.rate_source, f.rate_timestamp, f.realized_fx_gain_loss_minor
    INTO v_f
  FROM supplier_refunds f
  WHERE f.business_id = NEW.business_id AND f.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a supplier refund entry must be registered by its refund in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT n.source_to_base_rate, n.rate_source, n.rate_timestamp, op.warehouse_id INTO v_n
  FROM supplier_credit_notes n
  JOIN supplier_returns r ON r.business_id = n.business_id AND r.id = n.supplier_return_id
  JOIN purchases op ON op.business_id = r.business_id AND op.id = r.purchase_id
  WHERE n.business_id = NEW.business_id AND n.id = v_f.credit_note_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT w.branch_id INTO v_obranch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_n.warehouse_id;
  v_one     := (1::numeric(20,10))::text;
  v_cr_conv := v_f.source_carrying_base_released_minor - v_f.source_dust_base_minor;
  v_rsnap   := concat_ws('|', v_f.receipt_to_base_rate::text, v_f.rate_source, extract(epoch FROM v_f.rate_timestamp)::text);
  v_nsnap   := concat_ws('|', v_n.source_to_base_rate::text, v_n.rate_source, extract(epoch FROM v_n.rate_timestamp)::text);
  v_base    := concat_ws('|', v_one, 'base', extract(epoch FROM (v_f.refund_date::timestamp AT TIME ZONE 'UTC'))::text);

  -- The expected lines (A-05(c)), every one on the note's origin purchase's branch.
  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'posting', 'D', v_f.receipt_base_amount_minor::text, v_f.receipt_currency::text,
    v_f.receipt_amount_minor::text, v_rsnap, '-', coalesce(v_obranch::text, '-'));
  v_expected := v_expected || concat_ws('|', 'supplier_receivable', 'C', v_cr_conv::text, v_f.source_currency::text,
    v_f.source_amount_consumed_minor::text, v_nsnap, '-', coalesce(v_obranch::text, '-'));
  IF v_f.source_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'supplier_receivable', CASE WHEN v_f.source_dust_base_minor > 0 THEN 'C' ELSE 'D' END,
      abs(v_f.source_dust_base_minor)::text, v_base_ccy, abs(v_f.source_dust_base_minor)::text, v_base, '-', coalesce(v_obranch::text, '-'));
  END IF;
  IF v_f.realized_fx_gain_loss_minor > 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_gain', 'C', v_f.realized_fx_gain_loss_minor::text, v_base_ccy,
      v_f.realized_fx_gain_loss_minor::text, v_base, '-', coalesce(v_obranch::text, '-'));
  ELSIF v_f.realized_fx_gain_loss_minor < 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_loss', 'D', abs(v_f.realized_fx_gain_loss_minor)::text, v_base_ccy,
      abs(v_f.realized_fx_gain_loss_minor)::text, v_base, '-', coalesce(v_obranch::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', CASE WHEN l.account_id = v_f.posting_account_id THEN 'posting' ELSE coalesce(a.system_key, '-') END,
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_f.refund_date OR v_base_ccy IS NULL OR v_obranch IS NULL
     OR v_f.rate_timestamp IS NULL OR v_n.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a supplier refund entry is not exactly the A-05 lines of its refund'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION accounting_settlement_account_eligibility(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_supplier_payment_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_supplier_credit_allocation_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_supplier_refund_entry_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_settlement_account_eligibility(UUID, UUID) TO daftar_inventory_internal;

CREATE CONSTRAINT TRIGGER journal_entries_supplier_payment_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'supplier_payment')
  EXECUTE FUNCTION accounting_supplier_payment_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_supplier_credit_allocation_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'supplier_credit_allocation')
  EXECUTE FUNCTION accounting_supplier_credit_allocation_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_supplier_refund_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'supplier_refund')
  EXECUTE FUNCTION accounting_supplier_refund_entry_complete();

ALTER FUNCTION accounting_settlement_account_eligibility(UUID, UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_supplier_payment_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_supplier_credit_allocation_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_supplier_refund_entry_complete() OWNER TO daftar_accounting_internal;

-- (d) A-14(d): the accounting principal reads the S5 credit note (its 1150
--     lines' snapshot and branch). The S6 tables' admissions are in section 3.
ALTER POLICY business_isolation_read ON supplier_credit_notes
  USING (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
         OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY accounting_validator ON supplier_credit_notes
  FOR SELECT TO daftar_accounting_internal USING (true);

-- (c) R-68 / A-14(c): the reversal guard, replaced BY ITS OWNER. 0065's body
--     byte for byte except the always-refused IN list, which gains the three
--     S6 types: no S6 entry is undone by a generic Phase 2 reversal (PM-16,
--     TL-2). The `purchase` pairing clause and the R-13 block are verbatim.
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund')
                     OR (je.source_type = 'purchase'
                         AND NOT EXISTS (SELECT 1 FROM purchase_reversals r
                                          WHERE r.business_id = NEW.business_id AND r.id = je.source_id
                                            AND r.original_entry_id = NEW.original_entry_id)))) THEN
    RAISE EXCEPTION 'accounting.reversal_source_domain_owned: an entry owned by the inventory domain is not reversed by the generic reversal workflow'
      USING ERRCODE = 'P0001';
  END IF;
  -- R-13: the opening balance's ROW, not the workflow key. The frozen
  -- reversal routine already holds `businesses` FOR SHARE here; the advisory
  -- key would invert R-1's key → businesses order.
  SELECT ob.id INTO v_ob FROM accounting_opening_balances ob
   WHERE ob.business_id = NEW.business_id AND ob.journal_entry_id = NEW.original_entry_id
   FOR NO KEY UPDATE;
  IF v_ob IS NOT NULL
     AND EXISTS (SELECT 1 FROM inventory_openings o
                  WHERE o.business_id = NEW.business_id AND o.status = 'posted'
                    AND o.case_kind = 'opening_balance_bound' AND o.opening_balance_id = v_ob) THEN
    RAISE EXCEPTION 'accounting.opening_balance_inventory_bound: the inventory opening is decomposed against this opening position, whose entry therefore cannot be reversed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- (e) The registries (A-05), LAST, with the owning operation kind the 0046
--     rule requires.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('supplier_payment',           'none', 'not_after_today', 'One allocation of a supplier payment: Dr Accounts Payable / Cr the method''s posting account, realized FX to 4900/6900 (P3-AL-28).', 9),
  ('supplier_credit_allocation', 'none', 'not_after_today', 'A supplier credit applied to a purchase: Dr Accounts Payable / Cr Supplier Receivable, realized FX to 4900/6900 (P3-AL-30/31).', 10),
  ('supplier_refund',            'none', 'not_after_today', 'A supplier credit refunded in money: Dr the method''s posting account / Cr Supplier Receivable, realized FX to 4900/6900 (P3-AL-30/31).', 11);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'supplier_payment',           'Supplier payment allocation; derived by the payment command.'),
  ('post', 'supplier_credit_allocation', 'Supplier credit allocation; derived by the allocation command.'),
  ('post', 'supplier_refund',            'Supplier refund; derived by the refund command.');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right (0067-E, §2.9).
--    `has_*_privilege` against the live catalogue. Every probe that
--    replaces a body lends the internal owner CREATE inside the rolled-back
--    block only (0063 R-40), and the non-member probe role is PUBLIC
--    (R-72), so the block runs unchanged as a non-superuser migrator.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role     TEXT;
  v_table    TEXT;
  v_priv     TEXT;
  v_detail   TEXT;
  v_detail2  TEXT;
  v_actual   TEXT[];
  v_expected TEXT[];
  v_def      TEXT;
  v_fn       REGPROCEDURE;
  v_digest   TEXT;
  v_n        BIGINT;
  c_tables   CONSTANT TEXT[] := ARRAY['payment_method_names', 'payment_methods', 'supplier_credit_allocations', 'supplier_payment_allocations',
                                      'supplier_payments', 'supplier_refunds'];
  c_settle   CONSTANT TEXT[] := ARRAY['supplier_credit_allocations', 'supplier_payment_allocations', 'supplier_payments', 'supplier_refunds'];
  c_runtime  CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                      'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_privs    CONSTANT TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_inv_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'supplier_convert_base(bigint,numeric,integer,integer)'::regprocedure,
    'supplier_ap_release(bigint,bigint,bigint,bigint)'::regprocedure,
    'supplier_credit_remaining_carrying(bigint,bigint,bigint)'::regprocedure,
    'purchase_settlement_verify(uuid,uuid)'::regprocedure,
    'supplier_credit_note_verify(uuid,uuid)'::regprocedure,
    'payment_method_guard()'::regprocedure,
    'payment_method_named()'::regprocedure,
    'payment_method_name_guard()'::regprocedure,
    'supplier_payment_guard()'::regprocedure,
    'supplier_payment_complete()'::regprocedure,
    'supplier_payment_allocation_guard()'::regprocedure,
    'supplier_payment_allocation_value_complete()'::regprocedure,
    'supplier_credit_allocation_guard()'::regprocedure,
    'supplier_credit_allocation_value_complete()'::regprocedure,
    'supplier_refund_guard()'::regprocedure,
    'supplier_refund_value_complete()'::regprocedure,
    'purchase_reversal_unsettled()'::regprocedure,
    'supplier_credit_note_guard()'::regprocedure];
  c_acc_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'accounting_settlement_account_eligibility(uuid,uuid)'::regprocedure,
    'accounting_supplier_payment_entry_complete()'::regprocedure,
    'accounting_supplier_credit_allocation_entry_complete()'::regprocedure,
    'accounting_supplier_refund_entry_complete()'::regprocedure,
    'accounting_reversals_20_domain_source_guard()'::regprocedure];
  c_ext_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'purchase_ap_outstanding(uuid,uuid)'::regprocedure,
    'purchase_settlement_state(uuid,uuid)'::regprocedure];
  -- Every digest 0065 records in the S5 discovery except the replaced
  -- credit-note guard's: the twenty-nine of 0063 and the eleven other S5.
  c_kept_digests CONSTANT TEXT[] := ARRAY[
    '2b6be55eba2569a34816d6ad4154ece7138500f58f0f58253c52d2a891e1f01a',
    'f8a0aaa2ba51e777ff3992750237601ebfb927636a55f1a1816a507ff2d2d430',
    '3e54199bec0101135d4ea687c858dc514244a6cbd4f4e2aa7225f293b34dcdba',
    '4695f38364e51b8f19fb97627b94123e41792fb9e0889b6613b3734e305ad4f9',
    '7a8363f5b004f9853c935eca03339bfabc30c340cfbef93e7d56fe9d19b5b59d',
    'd4ca51a9d61eb6fdba9be52f6c3e9fa2fc4b4f1da67fdc792ed5e889ac13d9bc',
    '893163f6bcfd133c4e5e270647870dec1c9ce9a017952e66a1c5aa9d767702af',
    '0e192f181e2512b74051c668ccfbaf4549ff2793008a8581ed992e0c65c602d5',
    '3bd8424be82ab8aa94707d3f1b2d04ad74abacaea8ae32f860ea16aaa4716c15',
    '71b4f35571d748bf76b7a9b2b8bfa407af755dc4420c39e26532f9905659686f',
    'e70ba4c9c0c87a4b76050f77afb9e36d8bfac7195439d2438871d2822f488d45',
    '049e3e439c8d4e33a79bc932c937dc45b824b79718587604e627a1cfa2fb7c4a',
    '2e29261988cc961a5c9a052709b78a32a6fd49509d263875b97527992b905717',
    '507f40e4d0d472a6e787865b5a779c6f69ecfb651875ba14df57fe8fd8f54cbe',
    '4d646c5d5db4aa49e544033d02cc24fd007899dab833637cb8020a49611c2828',
    '908bc14db1094becba6402c0171237a5d91481874a55dd16eef17894cc59d5d4',
    '2f4a78a635df4ea85a0eb9a898752c80860badd64a68ce4038a3c081d9075e3f',
    'bf707fa32e584fb9e01f88a4766f8788dc32f2b96b5d59fd50ed9861e8b75cfa',
    '7a49c422e4e56c628ac1b4e6e45d8af0c9dcdc049bcc614e0f7829f80a050b58',
    '28f7f06240e62911f7b68efa3256e753443bf67c4ecf893ab174895a79582154',
    '6c6522559afc458e9fd9ce230214372b5f95c65938ca869ce435f326dd4fd19f',
    '97adaaaa95a5b2c18e80d34ea26a4eee5e397e1bf25dd727ddfc9a0cf86f31ab',
    '09da86dc079e39ef7a60f1625c364b6e4644aad9b795b87245cc6d6749a3db4c',
    '033535f199feae9d1747772d3cf32cfbe9f07979fa05f48471ac73475b4e7a9e',
    '3eda69587e6a9a8046ff1d7852e1ac7d0dec0d05ae633d1b78663a091634379a',
    'ac783691817646b8ac3528766a3203ec30c3f594a6f997b7f5779504ab625748',
    '77e09d0b7e15b2368ca2ace6f7de5933964777c5b3e5a1f58fb5723eb156b663',
    'a6fb57abb419fea3eb0f75c1c81ee0189226c5354fca7fe6197fb0f1ae76a925',
    '883da444f892ddbb0ad16f5d77c124057f46304e966262b80a63c3bfc1867b6b',
    'd9b6af529194f9378353b3d3b4b519f0a2fb39cf9bef9e9223b4a3b4512b626d',
    '945338f56ba61ec93b980a7053b10478eec00da32a2bdcecb80cac87b3b7b40e',
    'bfbcfd7696131c5222a277a7cdcffedfa221b1dd69b9036614d5a00ece553679',
    '0257473d6c4e53e3ffb415905cdf499e41bf29bc8fa34b1d1be9a9c18185aea4',
    '851cbdf05fdacd8ca2277e9b7aedcb76fc9cdb1d6cf6aa62b0100bc3a5776fe2',
    '1ac8224efb6b2f7c036d57207afcbfd08c7e469d745b3657271a0eb2cbadbe26',
    '61d96c8dfe2c30fb6d7689bf771bd677ce03a2541beb33c48b4d1476b1efdcba',
    '24b99c06756f9acd5190d12d1f693cb90c9ab023480a4172c382ccd98e6686e1',
    '55d5d4f779fe497263a70445a869aa8f9fc1e235fc350f389c07ceccab72e3e0',
    '68a8c04daa668ef1574f6e7109ca1756a33310005d82455118047f328717aa49',
    'e408924187c911f6b1d61f46ce1ae7e6ff965f2807562c9cfaa176508c5838bf'];
BEGIN
  -- (1) The accounting source registry: the eight earlier rows unchanged plus
  --     the three S6 types at 9, 10 and 11, each with exactly one post kind.
  SELECT array_agg(s.source_type || ':' || s.lower_bound_policy || ':' || s.upper_bound_policy || ':' || s.sort_order ORDER BY s.sort_order)
    INTO v_actual FROM accounting_source_types s;
  IF v_actual IS DISTINCT FROM ARRAY['opening_balance:none:not_after_today:1', 'manual_adjustment:none:not_after_today:2',
                                     'reversal:not_before_origin:not_after_today:3',
                                     'inventory_adjustment:none:not_after_today:4', 'inventory_opening:none:not_after_today:5',
                                     'purchase:none:not_after_today:6', 'negative_inventory_cost_adjustment:none:not_after_today:7',
                                     'supplier_return:none:not_after_today:8', 'supplier_payment:none:not_after_today:9',
                                     'supplier_credit_allocation:none:not_after_today:10', 'supplier_refund:none:not_after_today:11'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: accounting_source_types is not exactly the earlier eight plus the P3-S6 three, found %', v_actual;
  END IF;
  SELECT array_agg(k.operation_kind || ':' || k.source_type ORDER BY k.source_type, k.operation_kind) INTO v_actual FROM accounting_operation_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY['post:inventory_adjustment', 'post:inventory_opening', 'post:manual_adjustment',
                                     'post:negative_inventory_cost_adjustment', 'post:opening_balance', 'post:purchase',
                                     'reverse:reversal', 'post:supplier_credit_allocation', 'post:supplier_payment',
                                     'post:supplier_refund', 'post:supplier_return'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: accounting_operation_kinds is not the earlier eight plus the P3-S6 three, found %', v_actual;
  END IF;

  -- (2) The stock registry is unchanged and fully guarded; the re-recorded
  --     S5 discovery kept all forty other digests, dropped the old
  --     credit-note digest, and records the live body of the replaced guard.
  SELECT array_agg(t.source_type || ':' || t.registered_by ORDER BY t.source_type) INTO v_actual FROM stock_source_types t;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:P3-S3', 'inventory_opening:P3-S3', 'inventory_transfer:P3-S3',
                                     'negative_inventory_cost_adjustment:P3-S4', 'purchase:P3-S4', 'purchase_reversal:P3-S5',
                                     'stocktake:P3-S3', 'supplier_return:P3-S5'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: stock_source_types changed, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard: %', v_detail;
  END IF;
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'inventory_stock_source_guard_gaps()'::regprocedure;
  FOREACH v_digest IN ARRAY c_kept_digests LOOP
    IF position(v_digest IN v_def) = 0 THEN
      RAISE EXCEPTION 'inventory.source_guard_missing: the re-recorded discovery lost the recorded digest %', v_digest;
    END IF;
  END LOOP;
  SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_digest FROM pg_proc p WHERE p.oid = 'supplier_credit_note_guard()'::regprocedure;
  IF cardinality(c_kept_digests) <> 40 OR (SELECT count(DISTINCT d) FROM unnest(c_kept_digests) AS d) <> 40
     OR position('525fa8bb231953d84bff524a8eb1a636bdebf7c1ba13d20043d585dbdbee2e78' IN v_def) > 0
     OR position('"supplier_credit_note_guard()": "' || v_digest || '"' IN v_def) = 0 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the S5 discovery does not keep the forty digests and re-record the credit-note guard';
  END IF;

  -- (3) The six tables: RLS enabled and forced; exactly the §2.7 policies;
  --     no restrictive write policy admits a principal by name.
  FOREACH v_table IN ARRAY c_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass
                     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: row security is not enabled and forced on %', v_table;
    END IF;
    SELECT array_agg(p.polname::text || ':' || p.polcmd::text || ':' || p.polpermissive::text
                     || ':' || coalesce(array_to_string(ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END FROM unnest(p.polroles) AS r ORDER BY 1), ','), '')
                     ORDER BY p.polname) INTO v_actual
    FROM pg_policy p WHERE p.polrelid = ('public.' || v_table)::regclass;
    v_expected := ARRAY['business_isolation_delete:d:false:public', 'business_isolation_insert:a:false:public',
                        'business_isolation_read:r:false:public', 'business_isolation_update:w:false:public',
                        'inventory_internal_read:r:true:daftar_inventory_internal', 'tenant_membership:*:true:public'];
    IF v_table = ANY (c_settle) THEN
      v_expected := ARRAY['accounting_validator:r:true:daftar_accounting_internal'] || v_expected;
    END IF;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % policies are not exactly §2.7, found %', v_table, v_actual;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = ('public.' || v_table)::regclass AND NOT p.polpermissive AND p.polcmd <> 'r'
                  AND (position('current_user' IN coalesce(pg_get_expr(p.polqual, p.polrelid), '')) > 0
                       OR position('current_user' IN coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
                       OR coalesce(pg_get_expr(p.polqual, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                          <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))'
                       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                          <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')) THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: a restrictive write policy on % admits more than its own business', v_table;
    END IF;
    SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_def
    FROM pg_policy p WHERE p.polrelid = ('public.' || v_table)::regclass AND p.polname = 'business_isolation_read';
    IF position(CASE WHEN v_table = ANY (c_settle)
                     THEN '(CURRENT_USER = ANY (ARRAY[''daftar_inventory_internal''::name, ''daftar_accounting_internal''::name]))'
                     ELSE '(CURRENT_USER = ''daftar_inventory_internal''::name)' END IN v_def) = 0 THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the read isolation of % does not admit exactly its principals, found %', v_table, v_def;
    END IF;
  END LOOP;
  SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
  FROM pg_policy p WHERE p.polrelid = 'public.supplier_credit_notes'::regclass;
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_def
  FROM pg_policy p WHERE p.polrelid = 'public.supplier_credit_notes'::regclass AND p.polname = 'business_isolation_read';
  IF v_actual IS DISTINCT FROM ARRAY['accounting_validator', 'business_isolation_delete', 'business_isolation_insert', 'business_isolation_read',
                                     'business_isolation_update', 'inventory_internal_read', 'tenant_membership']
     OR position('(CURRENT_USER = ANY (ARRAY[''daftar_inventory_internal''::name, ''daftar_accounting_internal''::name]))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the credit-note policies are not the S5 set plus the A-14(d) admission, found %', v_actual;
  END IF;

  -- (4) The candidate key and every S6 FK validated; every binding FK
  --     DEFERRABLE INITIALLY DEFERRED and no other FK deferrable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'supplier_credit_notes_supplier_uq' AND c.conrelid = 'public.supplier_credit_notes'::regclass
                    AND c.contype = 'u' AND c.convalidated
                    AND pg_get_constraintdef(c.oid) = 'UNIQUE (business_id, id, supplier_id)') THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the P3-S6 candidate key on supplier_credit_notes is missing';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT c.convalidated OR (c.conname LIKE '%\_binding\_fk') <> (c.condeferrable AND c.condeferred))
    INTO v_n, v_detail
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.conrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_tables) AS t));
  IF v_n <> 28 OR v_detail <> '0'
     OR (SELECT count(*) FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conname LIKE '%\_binding\_fk' AND c.condeferrable AND c.condeferred
            AND c.conrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_settle) AS t))) <> 3 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the P3-S6 foreign keys are not exactly the twenty-eight validated ones with three deferred bindings (found %)', v_n;
  END IF;

  -- (5) A-17 exactly, for every runtime role, PUBLIC (the non-member probe,
  --     R-72) and both internal principals.
  FOREACH v_table IN ARRAY c_tables LOOP
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_privs LOOP
        IF has_table_privilege(v_role, v_table, v_priv) AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT') THEN
          RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_table, v_priv) AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT') THEN
          RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % holds column-level % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('daftar_app', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: daftar_app cannot read %', v_table;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_any_column_privilege(v_role, 'supplier_credit_notes', 'UPDATE') OR has_table_privilege(v_role, 'supplier_credit_notes', 'DELETE') THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % may change a supplier credit note', v_role;
    END IF;
  END LOOP;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_tables || ARRAY['supplier_credit_notes']) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_inventory_internal', t, p);
  IF v_actual IS DISTINCT FROM ARRAY['payment_method_names:DELETE', 'payment_method_names:INSERT', 'payment_method_names:SELECT',
                                     'payment_methods:INSERT', 'payment_methods:SELECT',
                                     'supplier_credit_allocations:INSERT', 'supplier_credit_allocations:SELECT',
                                     'supplier_credit_notes:INSERT', 'supplier_credit_notes:SELECT',
                                     'supplier_payment_allocations:INSERT', 'supplier_payment_allocations:SELECT',
                                     'supplier_payments:INSERT', 'supplier_payments:SELECT',
                                     'supplier_refunds:INSERT', 'supplier_refunds:SELECT'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: daftar_inventory_internal table privileges are not exactly A-17, found %', v_actual;
  END IF;
  SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname) INTO v_actual
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.oid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_tables || ARRAY['supplier_credit_notes']) AS t))
    AND (has_column_privilege('daftar_inventory_internal', c.oid, a.attname, 'UPDATE')
         OR has_column_privilege('daftar_inventory_internal', c.oid, a.attname, 'REFERENCES'));
  IF v_actual IS DISTINCT FROM ARRAY['payment_method_names.display_name',
                                     'payment_methods.business_transaction_id', 'payment_methods.is_active', 'payment_methods.last_intent_sha256',
                                     'payment_methods.posting_account_id', 'payment_methods.requires_reference', 'payment_methods.revision',
                                     'payment_methods.sort_order', 'payment_methods.updated_at', 'payment_methods.updated_by',
                                     'supplier_credit_notes.remaining_amount_minor', 'supplier_credit_notes.remaining_carrying_base_amount_minor'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: daftar_inventory_internal column privileges are not exactly A-17, found %', v_actual;
  END IF;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_tables || ARRAY['supplier_credit_notes']) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_accounting_internal', t, p)
     OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege('daftar_accounting_internal', t, p) ELSE false END;
  IF v_actual IS DISTINCT FROM ARRAY['supplier_credit_allocations:SELECT', 'supplier_credit_notes:SELECT', 'supplier_payment_allocations:SELECT',
                                     'supplier_payments:SELECT', 'supplier_refunds:SELECT'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: daftar_accounting_internal holds more than A-14(d), found %', v_actual;
  END IF;

  -- (6) Every §2.3 function: internal owner, DEFINER, pinned, no grantee,
  --     executable by no role; the accounting functions likewise under
  --     their owner, the eligibility by the inventory principal only.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE (p.oid = ANY (c_inv_fns) AND r.rolname <> 'daftar_inventory_internal')
     OR (p.oid = ANY (c_acc_fns) AND r.rolname <> 'daftar_accounting_internal')
     OR ((p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns))
         AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: function(s) with the wrong owner, security or path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns)) <> 23 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: a P3-S6 source-side function is missing';
  END IF;
  FOREACH v_fn IN ARRAY c_inv_fns || c_acc_fns || ARRAY['supplier_settlement_guard_gaps()'::regprocedure,
                                                          'inventory_stock_source_guard_gaps()'::regprocedure] LOOP
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE')
         AND NOT (v_role = 'daftar_accounting_internal' AND v_fn = ANY (c_acc_fns)) THEN
        RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % may run %', v_role, v_fn;
      END IF;
    END LOOP;
    IF v_fn <> 'accounting_settlement_account_eligibility(uuid,uuid)'::regprocedure
       AND (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x
             WHERE p.oid = v_fn AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) > 0 THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % has an EXECUTE grantee', v_fn;
    END IF;
  END LOOP;
  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid = 'accounting_settlement_account_eligibility(uuid,uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_inventory_internal']
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'accounting_settlement_account_eligibility(uuid,uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: accounting_settlement_account_eligibility must be STABLE and reachable by daftar_inventory_internal only, found %', v_actual;
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid = ANY (c_inv_fns[1:3]) AND p.provolatile = 'i') <> 3 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an S6 arithmetic function is not IMMUTABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('supplier_settlement_guard_gaps()'::regprocedure, 'inventory_stock_source_guard_gaps()'::regprocedure)
                AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                     OR p.proowner::regrole::text <> current_user))
     OR pg_get_function_result('supplier_settlement_guard_gaps()'::regprocedure) <> 'TABLE(table_name text, trigger_name text, missing text)'
     OR pg_get_function_result('inventory_stock_source_guard_gaps()'::regprocedure) <> 'TABLE(source_type text, missing text)' THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: a guard discovery is not migrator-owned INVOKER STABLE pinned with its contract';
  END IF;
  -- The six S6 tables carry exactly their eleven §2.3 triggers, none with a
  -- WHEN or a column list; purchase_reversals gained exactly one.
  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_tables) AS t)) AND NOT g.tgisinternal) <> 11
     OR EXISTS (SELECT 1 FROM pg_trigger g
                 WHERE g.tgrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_tables) AS t)) AND NOT g.tgisinternal
                   AND (g.tgqual IS NOT NULL OR cardinality(g.tgattr::int2[]) <> 0))
     OR (SELECT array_agg(g.tgname::text ORDER BY g.tgname) FROM pg_trigger g
          WHERE g.tgrelid = 'public.purchase_reversals'::regclass AND NOT g.tgisinternal)
        IS DISTINCT FROM ARRAY['purchase_reversals_complete', 'purchase_reversals_immutable', 'purchase_reversals_unsettled',
                               'purchase_reversals_value_complete'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an S6 table carries another trigger, a guard gained a WHEN, or purchase_reversals is not the S5 set plus purchase_reversals_unsettled';
  END IF;

  -- (7) The S6 discovery is empty and live: each §2.3 probe, inside a
  --     rolled-back block, is reported.
  IF EXISTS (SELECT 1 FROM supplier_settlement_guard_gaps()) THEN
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ') INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.source_guard_missing: a P3-S6 guard is missing or mis-shaped: %', v_detail;
  END IF;
  BEGIN
    ALTER TABLE supplier_refunds DISABLE TRIGGER supplier_refunds_value_complete;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_refunds:supplier_refunds_value_complete:trigger_disabled' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a disabled refund value guard (%)', v_detail;
  END IF;
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION purchase_settlement_verify(p_business_id UUID, p_purchase_id UUID) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:purchase_settlement_verify(uuid,uuid):function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a neutered settlement chain body (%)', v_detail;
  END IF;
  BEGIN
    ALTER TABLE supplier_payments ENABLE REPLICA TRIGGER supplier_payments_complete;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_payments:supplier_payments_complete:trigger_disabled' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a replica-only payment completeness guard (%)', v_detail;
  END IF;
  -- The coordinator's probe: the replaced credit-note guard, neutered by its
  -- owner, is reported by BOTH discoveries.
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION supplier_credit_note_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN NEW;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing)
      INTO v_detail2 FROM inventory_stock_source_guard_gaps() g;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: % / %', coalesce(v_detail2, ''), coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM
     'inventory.probe_rollback: supplier_return:credit_note_immutable / supplier_credit_notes:supplier_credit_notes_immutable:function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the discoveries did not both report a neutered credit-note guard (%)', v_detail;
  END IF;
  -- R-79: a replaced extension point is reported, by its body and by its
  -- security; the migrator owns them, so no CREATE is lent.
  BEGIN
    CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN 0;
    END;
    $probe$;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:purchase_ap_outstanding(uuid,uuid):function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a replaced purchase_ap_outstanding (%)', v_detail;
  END IF;
  BEGIN
    CREATE OR REPLACE FUNCTION purchase_settlement_state(p_business_id UUID, p_purchase_id UUID,
                                                         OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      payment_allocated := false;
      credit_allocated := false;
    END;
    $probe$;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:purchase_settlement_state(uuid,uuid):function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a replaced purchase_settlement_state (%)', v_detail;
  END IF;
  BEGIN
    ALTER FUNCTION purchase_settlement_state(UUID, UUID) SECURITY DEFINER;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:purchase_settlement_state(uuid,uuid):function_not_invoker' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a DEFINER purchase_settlement_state (%)', v_detail;
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_settlement_guard_gaps()) OR EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps())
     OR has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: a discovery probe did not roll back';
  END IF;

  -- (8) The credit-note guard (A-12, §2.4): internal-owned, no grantee (6),
  --     on its unchanged trigger; its body names g, both consumers, the S5
  --     code and every non-remaining column of the S5 table.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'supplier_credit_note_guard()'::regprocedure;
  IF position('supplier_credit_remaining_carrying' IN v_def) = 0 OR position('supplier_refunds' IN v_def) = 0
     OR position('supplier_credit_allocations' IN v_def) = 0 OR position('supplier_credit_note.immutable:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_credit_note_guard is not the §2.4 guard';
  END IF;
  SELECT string_agg(a.attname::text, ', ' ORDER BY a.attnum) INTO v_detail
  FROM pg_attribute a
  WHERE a.attrelid = 'public.supplier_credit_notes'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname NOT IN ('remaining_amount_minor', 'remaining_carrying_base_amount_minor')
    AND (position('NEW.' || a.attname || ',' IN v_def) = 0 AND position('NEW.' || a.attname || ')' IN v_def) = 0
         OR position('OLD.' || a.attname || ',' IN v_def) = 0 AND position('OLD.' || a.attname || ')' IN v_def) = 0);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_credit_note_guard does not hold column(s) % fixed', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.supplier_credit_notes'::regclass AND g.tgname = 'supplier_credit_notes_immutable'
                    AND g.tgtype = 27 AND g.tgenabled = 'O' AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                    AND g.tgfoid = 'supplier_credit_note_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_credit_notes_immutable is no longer the S5 trigger';
  END IF;

  -- (9) The reversal guard names the seven always-refused domain types, the
  --     paired purchase_reversals row, and keeps its R-13 refusal.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'accounting_reversals_20_domain_source_guard()'::regprocedure;
  IF position('''inventory_adjustment'', ''inventory_opening'', ''negative_inventory_cost_adjustment'', ''supplier_return'', ''supplier_payment'', ''supplier_credit_allocation'', ''supplier_refund''' IN v_def) = 0
     OR position('je.source_type = ''purchase''' IN v_def) = 0 OR position('FROM purchase_reversals r' IN v_def) = 0
     OR position('r.original_entry_id = NEW.original_entry_id' IN v_def) = 0
     OR position('FROM accounting_opening_balances ob' IN v_def) = 0 OR position('FOR NO KEY UPDATE' IN v_def) = 0
     OR position('accounting.opening_balance_inventory_bound:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the reversal guard does not refuse the domain-owned source types as R-68 states';
  END IF;

  -- (10) The two extension points: migrator-owned INVOKER STABLE pinned,
  --      executable by exactly daftar_app and the internal principal, each
  --      reading both allocation tables.
  FOREACH v_fn IN ARRAY c_ext_fns LOOP
    SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO v_actual
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_fn AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = v_fn;
    IF v_actual IS DISTINCT FROM ARRAY['daftar_app', 'daftar_inventory_internal']
       OR has_function_privilege('public', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                    AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                         OR p.proowner::regrole::text <> current_user))
       OR position('supplier_payment_allocations' IN v_def) = 0 OR position('supplier_credit_allocations' IN v_def) = 0 THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the extension point % is not the A-13 replacement, found %', v_fn, v_actual;
    END IF;
  END LOOP;

  -- (11) The three completeness triggers: deferred, filtered by type, on
  --      their accounting-owned functions.
  SELECT array_agg(g.tgname::text ORDER BY g.tgname) INTO v_actual
  FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid JOIN pg_roles r ON r.oid = p.proowner
  WHERE g.tgrelid = 'public.journal_entries'::regclass AND NOT g.tgisinternal AND g.tgenabled = 'O' AND g.tgtype = 5
    AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND r.rolname = 'daftar_accounting_internal'
    AND ((g.tgname = 'journal_entries_supplier_payment_complete' AND g.tgfoid = 'accounting_supplier_payment_entry_complete()'::regprocedure
          AND position('WHEN ((new.source_type = ''supplier_payment''::text))' IN pg_get_triggerdef(g.oid)) > 0)
      OR (g.tgname = 'journal_entries_supplier_credit_allocation_complete'
          AND g.tgfoid = 'accounting_supplier_credit_allocation_entry_complete()'::regprocedure
          AND position('WHEN ((new.source_type = ''supplier_credit_allocation''::text))' IN pg_get_triggerdef(g.oid)) > 0)
      OR (g.tgname = 'journal_entries_supplier_refund_complete' AND g.tgfoid = 'accounting_supplier_refund_entry_complete()'::regprocedure
          AND position('WHEN ((new.source_type = ''supplier_refund''::text))' IN pg_get_triggerdef(g.oid)) > 0));
  IF v_actual IS DISTINCT FROM ARRAY['journal_entries_supplier_credit_allocation_complete', 'journal_entries_supplier_payment_complete',
                                     'journal_entries_supplier_refund_complete'] THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the completeness triggers are not the three A-14(a) ones, found %', v_actual;
  END IF;

  -- The R-61/R-63/R-69 arithmetic, run as its owner: GOLD-84, the exact
  -- release at clearing, and the R-69(b) boundary (a tie goes to 0).
  SET LOCAL ROLE daftar_inventory_internal;
  IF supplier_credit_remaining_carrying(10000, 36000, 4000) <> 14400 OR supplier_credit_remaining_carrying(10000, 36000, 10000) <> 36000
     OR supplier_credit_remaining_carrying(10000, 36000, 0) <> 0 OR supplier_credit_remaining_carrying(1000, 3, 1) <> 1
     OR supplier_ap_release(1001, 3, 0, 1) + supplier_ap_release(1001, 3, 1, 1) + supplier_ap_release(1001, 3, 2, 1) <> 1001
     OR supplier_ap_release(1001, 3, 1, 1) <> 333
     OR supplier_convert_base(1, 0.5000000000, 2, 0) <> 0 OR supplier_convert_base(100, 0.5000000000, 2, 0) <> 0
     OR supplier_convert_base(300, 0.5000000000, 2, 0) <> 2
     OR supplier_convert_base(150, 0.5000000000, 2, 0) <> 1 OR supplier_convert_base(250, 0.5000000000, 2, 0) <> 1
     OR supplier_convert_base(10000, 3.6500000000, 2, 2) <> 36500 OR supplier_convert_base(7, 1.0000000000, 2, 3) <> 70 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the S6 arithmetic is not R-61/R-63 HALF_EVEN';
  END IF;
  RESET ROLE;

  -- (12) Neither internal principal keeps CREATE on public, and no role
  --      gained an attribute; no S6 operation kind exists before 0068.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an internal principal is no longer an unreachable NOLOGIN NOINHERIT role';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.registered_by = 'P3-S6' OR k.op_code LIKE 'payment.%'
               OR k.op_code IN ('supplier.pay', 'supplier.allocate_credit', 'supplier.receive_refund')) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an S6 operation kind exists before its routine (0068)';
  END IF;
END $$;

COMMENT ON TABLE payment_methods IS
  'P3-S6 A-06. A payment method: its system type (immutable), its posting account (an active settlement asset account of the business, R-65; unchangeable once a payment or refund posted through it), active flag, reference requirement and sort order. Never deleted; deactivation changes is_active only. Not seeded (TL-7).';
COMMENT ON TABLE payment_method_names IS
  'P3-S6 A-06. A payment method''s display name per locale (ar, en, tr); at least one per method; changes only with a revision of its method.';
COMMENT ON TABLE supplier_payments IS
  'P3-S6 A-07. A supplier payment: one supplier, one active method and its posting account, one currency and snapshot, fully allocated to 1..50 received purchases of that supplier. Insert-only.';
COMMENT ON TABLE supplier_payment_allocations IS
  'P3-S6 A-05(a), A-08. One allocation of a supplier payment to one purchase: the payment amount and base, the applied purchase amount, the AP released before it (X), the carrying base released, the AP dust and the realized FX (payment base - carrying released). Posts one supplier_payment entry. Insert-only.';
COMMENT ON TABLE supplier_credit_allocations IS
  'P3-S6 A-05(b), A-10. A supplier credit note applied to one purchase: the consumed credit and its carrying release (R-63), the applied purchase amount and its AP release (R-61), the dusts and the realized FX (credit carrying released - AP carrying released). Posts one supplier_credit_allocation entry. Insert-only.';
COMMENT ON TABLE supplier_refunds IS
  'P3-S6 A-05(c), A-10. A supplier credit note refunded in money through an active method: the consumed credit and its carrying release, the receipt amount and base, and the realized FX (receipt base - carrying released). Posts one supplier_refund entry. Insert-only.';
COMMENT ON TABLE supplier_credit_notes IS
  'P3-S5 A-11. The excess of a return over the purchase''s outstanding AP, in the purchase currency and snapshot. P3-S6 (0067, R-66): changed only by one backed AL-31 decrement of both remaining values (supplier_credit_note_guard), never deleted.';
