# Phase 4 — the internal `SECURITY DEFINER` inventory

**Ruling:** `TL-P4-RLS-INT-01` §14 (the inventory) and §17 (the two reopening
conditions).
**The law that keeps this page true:** `tests/security/p4s4-internal-definer-inventory.test.ts`.
**Measured from:** the live PostgreSQL catalogue of a database built from zero
by applying `infrastructure/database/migrations/` in order — never from a
hand-kept list and never from the prose in `docs/`.

## Why this page exists

`TL-P4-RLS-INT-01` rules that the broad **cross-tenant READ** held by
`daftar_inventory_internal` and `daftar_accounting_internal` is **intentional**.
Accepting that moves the whole security boundary onto one question: *can an
ordinary runtime credential reach that authority?* Every `SECURITY DEFINER`
routine owned by either principal is a door in that boundary, and §17 names the
two ways a door opens:

1. **PUBLIC, or a runtime principal, holds unsafe `EXECUTE` on an internal
   definer.**
2. **A caller reaches a definer without the required authority proof.**

The Tech Lead's standard is that *there must be no undocumented callable
internal authority*. A hand-kept page satisfies that for exactly one commit, so
this page is paired with a **permanent law**: the roster is **discovered** from
the catalogue, the expectation is **written by hand** in the suite, and the two
are compared. A routine the catalogue has and the record does not is
undocumented authority. A recorded routine whose owner, `search_path`, `EXECUTE`
grantees or PUBLIC `EXECUTE` state has moved is a changed door. Both are red,
and the failure message names the §17 condition and the ruling id.

## What was measured

| fact | value |
| ---- | ----- |
| routines owned by the two internal principals | 240 |
| of those, `SECURITY DEFINER` | **221** (163 inventory, 58 accounting) |
| of those, `INVOKER` | 19 — **out of scope**, see "T-05's scope" below |
| definers with an `EXECUTE` grantee other than their owner (**the doors**) | **57** |
| definers with an explicit, empty ACL and therefore no caller at all | **164** (122 trigger functions, 42 helpers) |
| definers executable by `PUBLIC` | **0** |
| definers whose `proacl` is null (default PUBLIC `EXECUTE` never revoked) | **0** |
| definers not pinning `search_path = pg_catalog, public, pg_temp` | **0** |
| doors granted to `daftar_app`, the ordinary runtime credential | **45** |
| of those 45, gated by a signed server decision | **45 — all of them** |
| doors granted to any other login principal | **5** (`daftar_platform` ×4, `daftar_reconciler` ×1) |
| doors granted only to a NOLOGIN internal principal | **7** |

## The rule that decides "safe" (directive §3)

`GRANT EXECUTE` on a definer routine **is new authority**, so each door records
what verifies the caller's right. A **signed server decision is sound; an
app-side check or a GUC is not.** Three shapes are present in the catalogue:

- **`signed server decision`** — the routine's first act is one of four
  verifier gates: `inventory_assertion_consume(op, payload_sha256)`,
  `accounting_actor(scopes)`, `accounting_control_actor(scopes)` or
  `accounting_opening_balance_authority(id)`. Each checks an HMAC the server
  minted over an operation code, a tenant, a business, an actor, a payload
  digest, an expiry and a single-use `jti`, against a key registry no runtime
  role can read. **Sound.** All 45 doors reachable by `daftar_app` have this
  shape, and the law refuses a 46th that does not.
- **`the EXECUTE ACL alone`** — no per-call proof: the ACL *is* the authority.
  **Sound only** while the grantee is a NOLOGIN internal principal, or one of
  the two ops credentials an accepted suite already pins by name. The law names
  any other login grantee of an acl-only door as §17 condition 2.
- **`app.business_id` equality** — three cross-domain *read* routines
  additionally require `p_business_id = current_setting('app.business_id')`.
  **A GUC is not an authority proof and is not recorded as one.** It is a scope
  narrowing *inside already-elevated code*; the authority for all three is
  still the `EXECUTE` ACL, whose only grantee is a NOLOGIN internal principal.
  It is recorded so a future grant of one of them to a login role is a visible
  change, and the law asserts that no GUC-scoped door has a login grantee.

### The five doors a login principal can open with no per-call proof

| signature | grantee | what pins it today |
| --------- | ------- | ------------------ |
| `inventory_assertion_key_install(text,bytea)` | `daftar_platform` | `tests/security/inventory-db-authority.test.ts:902-993` (the `invctl/1` key lifecycle through `daftar_platform`, including that the platform cannot read a key back) |
| `inventory_assertion_key_retire(text)` | `daftar_platform` | same |
| `accounting_assertion_key_install(text,bytea)` | `daftar_platform` | `tests/security/accounting-posting-authority.test.ts:414` ("lets only the platform credential install or retire a key, and never read one back") |
| `accounting_assertion_key_retire(text)` | `daftar_platform` | same |
| `accounting_reconcile_businesses(uuid,uuid,integer)` | `daftar_reconciler` | `tests/security/reconciler-authority-matrix.test.ts:209-275`; the page is bounded (`least(greatest(coalesce(p_limit,200),1),1000)`) and returns only `(tenant_id, business_id)` |

These five are the honest residue of the model: a key-lifecycle credential and a
reconciliation enumerator whose *whole purpose* is to act outside one tenant.
The law pins the set to exactly these five, so a sixth is red.

### The four doors whose business id is a bare caller argument

| signature | grantee | effect |
| --------- | ------- | ------ |
| `inventory_business_has_stock_movements(uuid)` | `daftar_accounting_internal` | a boolean over any business's `stock_movements` |
| `inventory_business_stock_value_equals(uuid,numeric)` | `daftar_accounting_internal` | an equality over any business's stock value |
| `inventory_sale_cost_base_minor(uuid,uuid)` | `daftar_accounting_internal` | a sale's cost, for any business |
| `accounting_purchase_entry_id(uuid,uuid)` | `daftar_inventory_internal` | a purchase's journal entry id, for any business |

They are recorded as `UNBOUND — any id of any tenant` because that is what
their bodies do. They are **not** a finding: their only grantee is a NOLOGIN
internal principal that no runtime credential can `SET ROLE` to
(`tests/security/inventory-db-authority.test.ts:202`), and
`TL-P4-RLS-INT-01` rules the cross-tenant read of those principals
intentional. They are recorded so that a grant of any of them to a login role
turns the law red, which is exactly §17 condition 1.

## T-05's scope is respected

`T-05`'s owner / `search_path` / not-the-applier clauses bind **DEFINER
routines only**; an `INVOKER` read function may legitimately be applier-owned,
`purchase_ap_outstanding` being the precedent. This page's roster is
`prosecdef` **only**, so none of the 19 `INVOKER` routines these two principals
own is judged by it — the authority gates themselves
(`accounting_opening_balance_authority`), the canonicalisation and fingerprint
helpers, the advisory-lock key functions, and four column-guard triggers.

## What this page does not re-prove

The §14 attributes an accepted invariant already asserts are cited, not rebuilt
(directive §25):

| §14 attribute | already asserted at |
| ------------- | ------------------- |
| `SECURITY DEFINER` flag | `tests/security/phase3-s8-definer-law.test.ts:153`, `tests/security/search-path-shadowing.test.ts:617` |
| `search_path` pinned, `pg_temp` last | `tests/security/phase3-s8-definer-law.test.ts:153`, `tests/security/search-path-shadowing.test.ts:622`, `tests/security/search-path-shadowing.test.ts:325-360` |
| owner is a NOLOGIN internal principal, never the applier | `tests/security/phase3-s8-definer-law.test.ts:154`, `:159`; `tests/security/p3c-td18-definer-ownership.test.ts:153` |
| PUBLIC `EXECUTE` state | `tests/security/phase3-s8-definer-law.test.ts:155`, `tests/security/search-path-shadowing.test.ts:627` |
| `EXECUTE` grantees — **accepted Phase 3 prefix only** | `tests/security/search-path-shadowing.test.ts:637`, `tests/security/inventory-db-authority.test.ts:566`, `tests/security/p3c-td18-definer-ownership.test.ts:170`, `tests/security/accounting-posting-authority.test.ts:371` |
| trigger functions keep no grantee | `tests/security/phase3-s8-definer-law.test.ts:156`, `tests/security/search-path-shadowing.test.ts:631` |
| no runtime role reaches a routine through a membership | `tests/security/search-path-shadowing.test.ts:693` |
| assertion source, per routine | `tests/security/stock-ledger-authority.test.ts:695-967` (T-16) and `tests/security/accounting-posting-authority.test.ts:87-348` (matrix 3) — behaviourally, routine by routine |
| operation/domain, tenant source, business source, permission source, caller-controlled ids, structural bindings, reads, writes | **nowhere as a property of the set** — recorded here |

The three gaps this page and its law close:

1. **Completeness over BOTH principals at once.** `search-path-shadowing`'s §D
   sweep is `daftar_inventory_internal`-owned only. Nothing swept
   `daftar_accounting_internal`'s 58 definers as a set.
2. **Exact `EXECUTE` grantees beyond the accepted Phase 3 prefix.**
   `tests/security/search-path-shadowing.test.ts:637-688` deliberately weakened
   that half to *"a grantee is `daftar_app` or a NOLOGIN internal principal"* so
   that a later phase's design grant would not redden an accepted contract.
   That leaves §17 condition 1 to a shape test: a Phase 4 migration could grant
   `daftar_app` `EXECUTE` on a cross-tenant reader and nothing would say so.
   This page restores the equality, per signature, over all 221.
3. **The authority proof as a property of the set** — §17 condition 2.
   `accounting-posting-authority` proves `accounting_post_entry` needs its
   assertion. Nothing said that *every* door a login credential can open needs
   one.

## Part A — the 57 doors

Every `SECURITY DEFINER` routine of either internal principal that any
principal other than its owner may `EXECUTE`. `DEFINER`, `search_path` and
PUBLIC `EXECUTE` are uniform across all 221 and are asserted as set-wide
clauses by the law, so a row that drifts is red even though the column reads
the same everywhere.

| # | signature | owner | DEFINER | `search_path` | EXECUTE grantees | PUBLIC EXECUTE | operation / domain | tenant source | business source | assertion source | permission source | caller-controlled ids | structural bindings | reads | writes |
| - | --------- | ----- | ------- | ------------- | ---------------- | -------------- | ------------------ | ------------- | --------------- | ---------------- | ----------------- | --------------------- | ------------------- | ----- | ------ |
| 1 | `accounting_assertion_key_install(text,bytea)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_platform` | none | key-lifecycle / accounting | none | none | none | the EXECUTE ACL alone | none | none | yes | yes |
| 2 | `accounting_assertion_key_retire(text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_platform` | none | key-lifecycle / accounting | none | none | none | the EXECUTE ACL alone | none | none | no | yes |
| 3 | `accounting_fx_rate_enter(text,text,text,timestamp with time zone,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_control_actor(ARRAY['fx_rate_enter'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 4 | `accounting_inventory_opening_position(uuid)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_inventory_internal` | none | read / accounting | `app.business_id` equality (scope narrowing, not authority) | `app.business_id` equality (scope narrowing, not authority) | none | the EXECUTE ACL alone | business id must equal `app.business_id` | none | yes | no |
| 5 | `accounting_open_balance_discard(uuid)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_opening_balance_authority()` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 6 | `accounting_open_balance_draft(date,jsonb)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_opening_balance_authority()` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 7 | `accounting_open_balance_edit(uuid,date,jsonb)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_opening_balance_authority()` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 8 | `accounting_open_balance_post(uuid,text,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_opening_balance_authority()` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 9 | `accounting_period_close(uuid,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_control_actor(ARRAY['period_close'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 10 | `accounting_period_create(uuid,date,date,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_control_actor(ARRAY['period_create'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 11 | `accounting_period_reopen(uuid,text,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_control_actor(ARRAY['period_reopen'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 12 | `accounting_post_entry(date,text,text,jsonb)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_actor(ARRAY['post'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | `accounting_source_bindings` | yes | yes |
| 13 | `accounting_post_manual_adjustment(date,text,text,text,jsonb)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_actor(ARRAY['post'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | none | yes | yes |
| 14 | `accounting_post_reversal(uuid,date,text,text)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / accounting | signed claim | signed claim | `accounting_actor(ARRAY['reverse'])` | signed server decision (the assertion’s operation claim) | bound by the signed payload fingerprint | `accounting_source_bindings` | yes | yes |
| 15 | `accounting_purchase_entry_id(uuid,uuid)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_inventory_internal` | none | read / accounting | caller argument, unchecked | caller argument, unchecked | none | the EXECUTE ACL alone | UNBOUND — any id of any tenant | none | yes | no |
| 16 | `accounting_purchase_fx_rate(uuid,character,timestamp with time zone)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_inventory_internal` | none | read / accounting | `app.business_id` equality (scope narrowing, not authority) | `app.business_id` equality (scope narrowing, not authority) | none | the EXECUTE ACL alone | business id must equal `app.business_id` | none | yes | no |
| 17 | `accounting_reconcile_businesses(uuid,uuid,integer)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_reconciler` | none | read / accounting | none | none | none | the EXECUTE ACL alone | none | none | yes | no |
| 18 | `accounting_settlement_account_eligibility(uuid,uuid)` | `daftar_accounting_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_inventory_internal` | none | read / accounting | `app.business_id` equality (scope narrowing, not authority) | `app.business_id` equality (scope narrowing, not authority) | none | the EXECUTE ACL alone | business id must equal `app.business_id` | none | yes | no |
| 19 | `customer_apply_credit(uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / receivables | signed claim | signed claim | `inventory_assertion_consume('customer.apply_credit')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 20 | `customer_collect_payment(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid,bigint,bigint,uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / receivables | signed claim | signed claim | `inventory_assertion_consume('customer.collect_payment')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 21 | `inventory_adjust_stock(uuid,uuid,date,text,uuid[],numeric[],numeric[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.adjust')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 22 | `inventory_assertion_key_install(text,bytea)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_platform` | none | key-lifecycle / inventory | none | none | none | the EXECUTE ACL alone | none | none | yes | yes |
| 23 | `inventory_assertion_key_retire(text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_platform` | none | key-lifecycle / inventory | none | none | none | the EXECUTE ACL alone | none | none | no | yes |
| 24 | `inventory_business_has_stock_movements(uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_accounting_internal` | none | read / inventory | caller argument, unchecked | caller argument, unchecked | none | the EXECUTE ACL alone | UNBOUND — any id of any tenant | none | yes | no |
| 25 | `inventory_business_stock_value_equals(uuid,numeric)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_accounting_internal` | none | read / inventory | caller argument, unchecked | caller argument, unchecked | none | the EXECUTE ACL alone | UNBOUND — any id of any tenant | none | yes | no |
| 26 | `inventory_configure_product(uuid,boolean,text,smallint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.configure_product')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 27 | `inventory_record_damage(uuid,uuid,date,text,uuid[],numeric[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.damage')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 28 | `inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.opening')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 29 | `inventory_sale_cost_base_minor(uuid,uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_accounting_internal` | none | read / inventory | caller argument, unchecked | caller argument, unchecked | none | the EXECUTE ACL alone | UNBOUND — any id of any tenant | none | yes | no |
| 30 | `inventory_stocktake_count(uuid,uuid,uuid[],numeric[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.stocktake_count')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 31 | `inventory_stocktake_finalize(uuid,uuid,text,date,uuid[],numeric[],numeric[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.stocktake_finalize')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 32 | `inventory_stocktake_open(uuid,uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.stocktake_open')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 33 | `inventory_transfer_stock(uuid,uuid,uuid,uuid[],numeric[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / inventory | signed claim | signed claim | `inventory_assertion_consume('inventory.transfer')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 34 | `payment_method_activate(uuid,integer)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payments | signed claim | signed claim | `inventory_assertion_consume('payment.activate_method')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 35 | `payment_method_create(uuid,text,uuid,boolean,integer,text,text,text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payments | signed claim | signed claim | `inventory_assertion_consume('payment.create_method')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 36 | `payment_method_deactivate(uuid,integer)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payments | signed claim | signed claim | `inventory_assertion_consume('payment.deactivate_method')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 37 | `payment_method_update(uuid,integer,uuid,boolean,integer,text,text,text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payments | signed claim | signed claim | `inventory_assertion_consume('payment.update_method')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 38 | `pos_cart_remove_line(uuid,uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / pos | signed claim | signed claim | `inventory_assertion_consume('pos.cart_remove_line')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | no | yes |
| 39 | `pos_cart_set_line(uuid,uuid,integer,uuid,uuid,numeric,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / pos | signed claim | signed claim | `inventory_assertion_consume('pos.cart_set_line')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 40 | `pos_till_session_close(uuid,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / pos | signed claim | signed claim | `inventory_assertion_consume('pos.session_close')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 41 | `pos_till_session_open(uuid,uuid,uuid,text,text,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / pos | signed claim | signed claim | `inventory_assertion_consume('pos.session_open')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 42 | `purchase_cancel(uuid,uuid,integer)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.cancel')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 43 | `purchase_receive(uuid,uuid,integer,uuid,integer,date,character,uuid,numeric,text,timestamp with time zone,bigint,bigint,uuid,uuid[],uuid[],numeric[],bigint[],numeric[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.receive')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 44 | `purchase_return(uuid,uuid,uuid,date,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,bigint,uuid[],uuid[],uuid[],numeric[],bigint[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.return')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 45 | `purchase_reverse(uuid,uuid,date,text,uuid,bigint,uuid[],uuid[],numeric[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.reverse')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 46 | `purchase_save_draft(uuid,integer,uuid,uuid,uuid,character,date,text,text,bigint,uuid[],uuid[],numeric[],numeric[],bigint[],uuid[],text[],bigint[],text[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.draft')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 47 | `purchase_write_off_residue(uuid,date,text,bigint,bigint,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / purchasing | signed claim | signed claim | `inventory_assertion_consume('purchase.write_off_residue')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 48 | `sale_commit(uuid,uuid,text,uuid,uuid,uuid,date,date,character,uuid,numeric,text,timestamp with time zone,bigint,bigint,bigint,bigint,text,uuid[],uuid[],uuid[],uuid[],text[],numeric[],bigint[],bigint[],bigint[],bigint[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / sales | signed claim | signed claim | `inventory_assertion_consume('sale.commit')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | `stock_source_bindings (via inventory_apply_stock_movements)` | yes | yes |
| 49 | `structure_associate_warehouse_branch(uuid,uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / structure | signed claim | signed claim | `inventory_assertion_consume('structure.associate_warehouse_branch')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 50 | `structure_dissociate_warehouse_branch(uuid,uuid)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / structure | signed claim | signed claim | `inventory_assertion_consume('structure.dissociate_warehouse_branch')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 51 | `supplier_allocate_credit(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.allocate_credit')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 52 | `supplier_archive(uuid,integer)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.archive')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 53 | `supplier_create(uuid,text,text,text,text,text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.create')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 54 | `supplier_pay(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid[],uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.pay')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 55 | `supplier_reactivate(uuid,integer)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.reactivate')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 56 | `supplier_receive_refund(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,bigint,text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.receive_refund')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |
| 57 | `supplier_update(uuid,integer,text,text,text,text,text)` | `daftar_inventory_internal` | yes | `pg_catalog, public, pg_temp` | `daftar_app` | none | command / payables | signed claim | signed claim | `inventory_assertion_consume('supplier.update')` | signed server decision (the assertion’s operation claim) | bound by the signed payload digest (component 7) | none | yes | yes |

## Part B — the 164 sealed definers

Every other `SECURITY DEFINER` routine of either principal. Each has an
**explicit, empty ACL** — `proacl` is not null, so the default PUBLIC `EXECUTE`
was revoked — and therefore no caller at all besides its owner: the trigger
manager runs the `trigger` ones and the owner's own elevated code calls the
`helper` ones. With no caller there is no tenant, business, assertion or
permission source to record, and no caller-controlled id to bind. What is
recorded is the owner, the kind, and whether it reads and writes. The law
asserts, for every row, that the grantee set is still **empty** — a grant to
anybody is reported as §17 condition 1.

| # | signature | owner | kind | reads | writes |
| - | --------- | ----- | ---- | ----- | ------ |
| 1 | `accounting_actor(text[])` | `daftar_accounting_internal` | helper | yes | yes |
| 2 | `accounting_assert_entry_valid(uuid,uuid)` | `daftar_accounting_internal` | helper | yes | no |
| 3 | `accounting_control_actor(text[])` | `daftar_accounting_internal` | helper | yes | yes |
| 4 | `accounting_customer_credit_application_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 5 | `accounting_customer_credit_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 6 | `accounting_customer_payment_allocation_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 7 | `accounting_entry_date_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 8 | `accounting_inventory_account_domain_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 9 | `accounting_inventory_account_domain_serial_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 10 | `accounting_inventory_adjustment_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 11 | `accounting_inventory_opening_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 12 | `accounting_inventory_reversal_domain_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 13 | `accounting_invoice_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 14 | `accounting_manual_adjustment_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 15 | `accounting_negative_inventory_cost_adjustment_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 16 | `accounting_open_balance_supersede(uuid,text)` | `daftar_accounting_internal` | helper | yes | yes |
| 17 | `accounting_opening_balance_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 18 | `accounting_opening_balance_lines_state()` | `daftar_accounting_internal` | trigger | yes | no |
| 19 | `accounting_opening_balances_30_inventory_opening_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 20 | `accounting_opening_balances_state()` | `daftar_accounting_internal` | trigger | yes | no |
| 21 | `accounting_period_guard_posting()` | `daftar_accounting_internal` | trigger | yes | no |
| 22 | `accounting_period_topology_check()` | `daftar_accounting_internal` | trigger | yes | no |
| 23 | `accounting_purchase_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 24 | `accounting_purchase_residue_write_off_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 25 | `accounting_reversal_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 26 | `accounting_reversals_20_domain_source_guard()` | `daftar_accounting_internal` | trigger | yes | no |
| 27 | `accounting_sale_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 28 | `accounting_seed_chart_trg()` | `daftar_accounting_internal` | trigger | no | no |
| 29 | `accounting_seed_chart(uuid)` | `daftar_accounting_internal` | helper | yes | yes |
| 30 | `accounting_supplier_credit_allocation_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 31 | `accounting_supplier_payment_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 32 | `accounting_supplier_refund_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 33 | `accounting_supplier_return_entry_complete()` | `daftar_accounting_internal` | trigger | yes | no |
| 34 | `accounting_validate_entry_of_line()` | `daftar_accounting_internal` | trigger | no | no |
| 35 | `accounting_validate_entry()` | `daftar_accounting_internal` | trigger | no | no |
| 36 | `accounts_posting_stability()` | `daftar_accounting_internal` | trigger | no | no |
| 37 | `businesses_base_currency_lock()` | `daftar_accounting_internal` | trigger | yes | no |
| 38 | `invoices_walkin_no_ar()` | `daftar_accounting_internal` | trigger | yes | no |
| 39 | `sales_cogs_owed()` | `daftar_accounting_internal` | trigger | yes | no |
| 40 | `sales_walkin_no_ar()` | `daftar_accounting_internal` | trigger | yes | no |
| 41 | `branch_warehouses_keep_home()` | `daftar_inventory_internal` | trigger | yes | no |
| 42 | `customer_credit_application_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 43 | `customer_credit_application_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 44 | `customer_credit_consume(uuid,bigint,bigint)` | `daftar_inventory_internal` | helper | yes | yes |
| 45 | `customer_credit_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 46 | `customer_credit_verify(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 47 | `customers_no_delete()` | `daftar_inventory_internal` | trigger | no | no |
| 48 | `customers_revision_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 49 | `inventory_apply_stock_movements(inventory_movement_request[])` | `daftar_inventory_internal` | helper | yes | yes |
| 50 | `inventory_assertion_consume(text,text)` | `daftar_inventory_internal` | helper | yes | yes |
| 51 | `inventory_assertion_current(text[])` | `daftar_inventory_internal` | helper | yes | no |
| 52 | `inventory_bridge_source_lines(text,uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 53 | `inventory_business_transaction_id()` | `daftar_inventory_internal` | helper | no | no |
| 54 | `inventory_claimed_payload_digest(text,text[],text[])` | `daftar_inventory_internal` | helper | no | no |
| 55 | `inventory_fixed_text(numeric,integer)` | `daftar_inventory_internal` | helper | no | no |
| 56 | `inventory_half_even(numeric,numeric,integer)` | `daftar_inventory_internal` | helper | no | no |
| 57 | `inventory_largest_remainder(numeric[],bigint)` | `daftar_inventory_internal` | helper | yes | no |
| 58 | `inventory_lock_stock_targets(uuid[],uuid[])` | `daftar_inventory_internal` | helper | yes | no |
| 59 | `inventory_next_deficit_seq(uuid,uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 60 | `inventory_payload_digest(text,uuid,uuid,text[],text[])` | `daftar_inventory_internal` | helper | no | no |
| 61 | `inventory_payload_field_is_canonical(text,text)` | `daftar_inventory_internal` | helper | yes | no |
| 62 | `inventory_quantity_is_representable(numeric,smallint)` | `daftar_inventory_internal` | helper | no | no |
| 63 | `inventory_reason_words(text)` | `daftar_inventory_internal` | helper | no | no |
| 64 | `inventory_source_header_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 65 | `inventory_source_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 66 | `inventory_stock_fold(uuid,uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 67 | `inventory_stock_verify(uuid,uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 68 | `invoice_items_no_mutation()` | `daftar_inventory_internal` | trigger | no | no |
| 69 | `invoice_sequences_key_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 70 | `invoice_settlement_verify(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 71 | `invoices_lifecycle_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 72 | `invoices_no_delete()` | `daftar_inventory_internal` | trigger | no | no |
| 73 | `negative_deficit_coverage_same_transaction()` | `daftar_inventory_internal` | trigger | yes | no |
| 74 | `negative_inventory_deficits_coverage_consistent()` | `daftar_inventory_internal` | trigger | yes | no |
| 75 | `negative_inventory_deficits_coverage_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 76 | `payment_allocation_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 77 | `payment_allocation_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 78 | `payment_closure_verify(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 79 | `payment_complete()` | `daftar_inventory_internal` | trigger | no | no |
| 80 | `payment_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 81 | `payment_method_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 82 | `payment_method_name_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 83 | `payment_method_named()` | `daftar_inventory_internal` | trigger | yes | no |
| 84 | `pos_cart_line_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 85 | `pos_till_session_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 86 | `product_variants_20_stock_identity_lock()` | `daftar_inventory_internal` | trigger | yes | no |
| 87 | `product_variants_30_archive_requires_zero_stock()` | `daftar_inventory_internal` | trigger | yes | no |
| 88 | `products_20_unit_history_lock()` | `daftar_inventory_internal` | trigger | yes | no |
| 89 | `products_30_archive_requires_zero_stock()` | `daftar_inventory_internal` | trigger | yes | no |
| 90 | `purchase_allocations_consistent()` | `daftar_inventory_internal` | trigger | yes | no |
| 91 | `purchase_bridge_credit_note(uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 92 | `purchase_bridge_receipt(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 93 | `purchase_bridge_return(uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 94 | `purchase_bridge_reversal(uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 95 | `purchase_cover_deficits(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 96 | `purchase_header_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 97 | `purchase_landed_cost_freeze()` | `daftar_inventory_internal` | trigger | yes | no |
| 98 | `purchase_lock_receipt_targets(uuid,uuid[])` | `daftar_inventory_internal` | helper | yes | no |
| 99 | `purchase_lock_stock_keys(uuid,uuid[])` | `daftar_inventory_internal` | helper | yes | no |
| 100 | `purchase_residue_write_off_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 101 | `purchase_residue_write_off_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 102 | `purchase_reversal_detail_same_transaction()` | `daftar_inventory_internal` | trigger | yes | no |
| 103 | `purchase_reversal_unsettled()` | `daftar_inventory_internal` | trigger | yes | no |
| 104 | `purchase_reversal_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 105 | `purchase_settlement_verify(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 106 | `purchase_source_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 107 | `sale_bridge_commit(uuid)` | `daftar_inventory_internal` | helper | yes | yes |
| 108 | `sale_document_number(text,text,bigint)` | `daftar_inventory_internal` | helper | no | no |
| 109 | `sale_header_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 110 | `sale_lock_commit_targets(uuid,uuid[])` | `daftar_inventory_internal` | helper | yes | no |
| 111 | `stock_binding_requires_inventory_adjustment()` | `daftar_inventory_internal` | trigger | yes | no |
| 112 | `stock_binding_requires_inventory_opening()` | `daftar_inventory_internal` | trigger | yes | no |
| 113 | `stock_binding_requires_inventory_transfer()` | `daftar_inventory_internal` | trigger | yes | no |
| 114 | `stock_binding_requires_negative_inventory_cost_adjustment()` | `daftar_inventory_internal` | trigger | yes | no |
| 115 | `stock_binding_requires_purchase_reversal()` | `daftar_inventory_internal` | trigger | yes | no |
| 116 | `stock_binding_requires_purchase()` | `daftar_inventory_internal` | trigger | yes | no |
| 117 | `stock_binding_requires_sale()` | `daftar_inventory_internal` | trigger | yes | no |
| 118 | `stock_binding_requires_stocktake()` | `daftar_inventory_internal` | trigger | yes | no |
| 119 | `stock_binding_requires_supplier_return()` | `daftar_inventory_internal` | trigger | yes | no |
| 120 | `stock_levels_zero_on_hand_zero_value()` | `daftar_inventory_internal` | trigger | yes | no |
| 121 | `stock_movements_account_domain_lock()` | `daftar_inventory_internal` | trigger | no | no |
| 122 | `stock_source_complete_inventory_adjustment()` | `daftar_inventory_internal` | trigger | yes | no |
| 123 | `stock_source_complete_inventory_opening()` | `daftar_inventory_internal` | trigger | yes | no |
| 124 | `stock_source_complete_inventory_transfer()` | `daftar_inventory_internal` | trigger | yes | no |
| 125 | `stock_source_complete_negative_inventory_cost_adjustment()` | `daftar_inventory_internal` | trigger | yes | no |
| 126 | `stock_source_complete_purchase_header()` | `daftar_inventory_internal` | trigger | yes | no |
| 127 | `stock_source_complete_purchase_reversal_header()` | `daftar_inventory_internal` | trigger | yes | no |
| 128 | `stock_source_complete_purchase_reversal()` | `daftar_inventory_internal` | trigger | yes | no |
| 129 | `stock_source_complete_purchase()` | `daftar_inventory_internal` | trigger | yes | no |
| 130 | `stock_source_complete_sale_header()` | `daftar_inventory_internal` | trigger | yes | no |
| 131 | `stock_source_complete_sale()` | `daftar_inventory_internal` | trigger | yes | no |
| 132 | `stock_source_complete_stocktake_header()` | `daftar_inventory_internal` | trigger | yes | no |
| 133 | `stock_source_complete_stocktake()` | `daftar_inventory_internal` | trigger | yes | no |
| 134 | `stock_source_complete_supplier_return_header()` | `daftar_inventory_internal` | trigger | yes | no |
| 135 | `stock_source_complete_supplier_return()` | `daftar_inventory_internal` | trigger | yes | no |
| 136 | `stock_source_freeze_inventory_adjustment()` | `daftar_inventory_internal` | trigger | no | no |
| 137 | `stock_source_freeze_inventory_opening()` | `daftar_inventory_internal` | trigger | no | no |
| 138 | `stock_source_freeze_inventory_transfer()` | `daftar_inventory_internal` | trigger | no | no |
| 139 | `stock_source_freeze_purchase()` | `daftar_inventory_internal` | trigger | yes | no |
| 140 | `stock_source_freeze_stocktake()` | `daftar_inventory_internal` | trigger | yes | no |
| 141 | `supplier_ap_release(bigint,bigint,bigint,bigint)` | `daftar_inventory_internal` | helper | no | no |
| 142 | `supplier_convert_base(bigint,numeric,integer,integer)` | `daftar_inventory_internal` | helper | no | no |
| 143 | `supplier_credit_allocation_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 144 | `supplier_credit_allocation_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 145 | `supplier_credit_note_consume(uuid,bigint,bigint)` | `daftar_inventory_internal` | helper | yes | yes |
| 146 | `supplier_credit_note_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 147 | `supplier_credit_note_verify(uuid,uuid)` | `daftar_inventory_internal` | helper | yes | no |
| 148 | `supplier_credit_remaining_carrying(bigint,bigint,bigint)` | `daftar_inventory_internal` | helper | no | no |
| 149 | `supplier_payment_allocation_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 150 | `supplier_payment_allocation_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 151 | `supplier_payment_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 152 | `supplier_payment_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 153 | `supplier_refund_guard()` | `daftar_inventory_internal` | trigger | yes | no |
| 154 | `supplier_refund_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 155 | `supplier_return_detail_same_transaction()` | `daftar_inventory_internal` | trigger | yes | no |
| 156 | `supplier_return_quantity_bound()` | `daftar_inventory_internal` | trigger | yes | no |
| 157 | `supplier_return_residue_bound()` | `daftar_inventory_internal` | trigger | yes | no |
| 158 | `supplier_return_value_complete()` | `daftar_inventory_internal` | trigger | yes | no |
| 159 | `supplier_return_value_settled()` | `daftar_inventory_internal` | trigger | yes | no |
| 160 | `suppliers_no_delete()` | `daftar_inventory_internal` | trigger | no | no |
| 161 | `suppliers_revision_guard()` | `daftar_inventory_internal` | trigger | no | no |
| 162 | `warehouses_30_archive_requires_zero_stock()` | `daftar_inventory_internal` | trigger | yes | no |
| 163 | `warehouses_home_branch_maintain()` | `daftar_inventory_internal` | trigger | no | yes |
| 164 | `warehouses_require_home_branch()` | `daftar_inventory_internal` | trigger | yes | no |

## The red proof

A law with no demonstrated failure is a decoration. The suite's
`RED PROOF` block, all of it against real objects of the real catalogue:

- creates a real `SECURITY DEFINER` function owned by `daftar_inventory_internal`,
  asserts the law reports it as **undocumented callable internal authority**,
  then drops it and asserts the finding clears;
- widens `EXECUTE` on that same throwaway to **PUBLIC** and asserts §17
  condition 1 is named;
- widens PUBLIC `EXECUTE` on a **real recorded door** (rolled back) and asserts
  both the PUBLIC clause and the grantee-set equality go red;
- grants `daftar_worker` `EXECUTE` on a real door (rolled back) and asserts §17
  condition 1 names the login principal;
- grants `daftar_app` `EXECUTE` on a **sealed** routine (rolled back) and
  asserts the no-caller clause goes red;
- re-owns a sealed routine to the other internal principal, and to
  `daftar_migrator`, and asserts the owner change and the *recorded-but-absent*
  clause are each named;
- `RESET search_path` on a real door (rolled back) and asserts the pinned-path
  clause goes red;
- replaces a real door's body with one that **calls no verifier gate** (rolled
  back) and asserts §17 condition 2 is named — so the recorded gate is never
  taken on trust;
- asserts the body reader is not vacuous: it sees a real gate call and a real
  DML verb, and does **not** see one written inside a comment or a string
  literal.

No fictional subject is pinned anywhere. A law that reports "no finding" about a
function the catalogue does not have pins nothing.
