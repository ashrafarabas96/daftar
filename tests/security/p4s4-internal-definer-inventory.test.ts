/**
 * P4-S4 — THE INTERNAL SECURITY DEFINER INVENTORY, AND THE LAW THAT IT IS
 * COMPLETE (Tech Lead directive TL-P4-RLS-INT-01 §14, §17).
 *
 * TL-P4-RLS-INT-01 rules that the broad CROSS-TENANT READ held by
 * `daftar_inventory_internal` and `daftar_accounting_internal` is
 * INTENTIONAL. Accepting that moves the whole boundary onto one question:
 * can an ordinary runtime credential REACH that authority? Every SECURITY
 * DEFINER routine owned by either principal is a door in that boundary, and
 * §17 names the two ways a door opens:
 *
 *   condition 1 — PUBLIC, or a runtime principal, holds unsafe EXECUTE on an
 *                 internal definer;
 *   condition 2 — a caller reaches a definer without the required authority
 *                 proof.
 *
 * §14 asks for an inventory of every such routine, recording fourteen
 * attributes each, and the Tech Lead's standard is that "there must be no
 * undocumented callable internal authority". A hand-kept list satisfies that
 * for exactly one commit, so the inventory is paired with THIS LAW: the
 * roster is DISCOVERED from the live catalogue of a database built from zero
 * by applying the migrations, the expectation below is WRITTEN BY HAND, and
 * the two are compared. A routine the catalogue has and the record does not
 * is undocumented authority; a recorded routine whose owner, `search_path`,
 * EXECUTE grantees or PUBLIC EXECUTE state has moved is a changed door.
 *
 * ── WHAT THIS SUITE DOES *NOT* RE-PROVE ────────────────────────────────────
 *
 * The §14 attributes that an accepted invariant already asserts are NOT
 * rebuilt here (directive §25). Cited, not copied:
 *
 *   - `prosecdef`, the pinned `search_path` and the applier-owner refusal
 *     over every routine after `0052`:
 *     `tests/security/phase3-s8-definer-law.test.ts:153-159` (clauses 1, 2,
 *     7) with the P4-AL-88 red proofs at `:371-432`;
 *   - PUBLIC EXECUTE on any such routine: same file, clause 3 at `:155`;
 *   - a trigger function keeps no grantee: same file, clause 4 at `:156`;
 *   - the inventory principal's own sweep — schema, DEFINER-or-named-INVOKER,
 *     pinned path, no PUBLIC, trigger functions ungranted, and the §H
 *     EXECUTE matrix over the ACCEPTED PREFIX:
 *     `tests/security/search-path-shadowing.test.ts:613-693`;
 *   - the four TD-18 routines' owners and grantees:
 *     `tests/security/p3c-td18-definer-ownership.test.ts:170-184`;
 *   - the inventory routine EXECUTE grants:
 *     `tests/security/inventory-db-authority.test.ts:566`;
 *   - the accounting posting primitive's grantee, and that the verifier is
 *     exposed to no runtime role:
 *     `tests/security/accounting-posting-authority.test.ts:371-392`;
 *   - the reconciler's single cross-tenant pager:
 *     `tests/security/reconciler-authority-matrix.test.ts:209-275`.
 *
 * The gap those leave, and the only thing built here, is:
 *
 *   (i)  COMPLETENESS of a recorded inventory over BOTH internal principals
 *        at once — `search-path-shadowing`'s sweep is inventory-owned only,
 *        and nothing sweeps `daftar_accounting_internal`'s 58 definers;
 *   (ii) EXACT EXECUTE grantees for routines BEYOND the accepted Phase 3
 *        prefix. `search-path-shadowing.test.ts:637-688` deliberately
 *        weakened that half to "a grantee is `daftar_app` or a NOLOGIN
 *        internal principal" so a later phase's design grant would not
 *        redden an accepted contract. That is §17 condition 1 left to a
 *        shape test: a Phase 4 migration could grant `daftar_app` EXECUTE on
 *        a cross-tenant reader and nothing would say so. This suite restores
 *        the equality, per signature, over the whole set;
 *  (iii) the AUTHORITY PROOF each door uses — §17 condition 2 — which no
 *        suite states as a property of the SET. `accounting-posting-authority`
 *        proves `accounting_post_entry` needs its assertion; nothing says
 *        that EVERY door a login credential can open needs one.
 *
 * ── THE RULE THAT DECIDES "SAFE" (directive §3) ───────────────────────────
 *
 * GRANT EXECUTE on a definer routine is new authority, so each door records
 * what verifies the caller's right. A SIGNED SERVER DECISION is sound; an
 * app-side check or a GUC is not. Measured over the live catalogue, the three
 * shapes present are:
 *
 *   `signed-op`   — the routine's first act is one of the four verifier
 *                   gates, which checks an HMAC the server minted, over an
 *                   operation code, a tenant, a business, an actor, a
 *                   payload digest, an expiry and a single-use jti. SOUND.
 *                   Every one of the 45 doors granted to `daftar_app` has
 *                   this shape, and the law refuses a 46th that does not.
 *   `execute-acl` — no per-call proof: the EXECUTE ACL *is* the authority.
 *                   SOUND ONLY while the grantee is a NOLOGIN internal
 *                   principal, or one of the two ops credentials whose
 *                   accepted suites already pin them by name
 *                   (`daftar_platform` on the four key-lifecycle routines,
 *                   `daftar_reconciler` on the one bounded business pager).
 *                   The law names any OTHER login grantee of an acl-only
 *                   door as §17 condition 2.
 *   `guc`         — three cross-domain READ routines additionally require
 *                   `p_business_id = current_setting('app.business_id')`.
 *                   A GUC is NOT an authority proof and is NOT recorded as
 *                   one: it is a scope narrowing INSIDE already-elevated
 *                   code, and the authority for all three is still the
 *                   EXECUTE ACL, whose only grantee is a NOLOGIN internal
 *                   principal. Recorded as `guc` so that a future grant of
 *                   one of them to a login role is a visible change.
 *
 * ── T-05's SCOPE IS RESPECTED ─────────────────────────────────────────────
 *
 * T-05's owner / `search_path` / not-the-applier clauses bind DEFINER
 * routines only; an INVOKER read function may legitimately be applier-owned,
 * `purchase_ap_outstanding` being the precedent. This suite's roster is
 * `prosecdef` ONLY, so no INVOKER function is judged by it — including the
 * nineteen INVOKER routines these two principals own (the authority gates
 * themselves, the fingerprint helpers and four column-guard triggers).
 */
import { randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const RULING = 'TL-P4-RLS-INT-01';
const COND_1 = `${RULING} §17 reopening condition 1 — PUBLIC or a runtime principal holds unsafe EXECUTE on an internal SECURITY DEFINER routine`;
const COND_2 = `${RULING} §17 reopening condition 2 — a caller reaches an internal SECURITY DEFINER routine without the required authority proof`;
const UNDOCUMENTED = `${RULING} §14 — undocumented callable internal authority: the catalogue has a SECURITY DEFINER routine owned by an internal principal that docs/PHASE_4_INTERNAL_DEFINER_INVENTORY.md does not record`;
const CHANGED = `${RULING} §14 — a recorded internal SECURITY DEFINER routine no longer matches the catalogue`;

const INVENTORY = 'daftar_inventory_internal';
const ACCOUNTING = 'daftar_accounting_internal';
const OWNER_ROLE = { inventory: INVENTORY, accounting: ACCOUNTING } as const;
/** T-05 / PM-43's pinned path, as `proconfig` stores it. */
const PINNED = 'search_path=pg_catalog, public, pg_temp';
const INVENTORY_DOC = 'docs/PHASE_4_INTERNAL_DEFINER_INVENTORY.md';

/** The four verifier gates. A door whose proof is `signed-op` calls exactly one of them. */
const GATES = ['inventory_assertion_consume', 'accounting_actor', 'accounting_control_actor', 'accounting_opening_balance_authority'] as const;

/**
 * The ops credentials whose acl-only reach is ALREADY pinned by name by an
 * accepted suite, cited in the header. No other login role may hold EXECUTE
 * on an acl-only door.
 */
const ACL_ONLY_LOGIN_GRANTEES = ['daftar_platform', 'daftar_reconciler'] as const;

type Owner = 'inventory' | 'accounting';
type Kind = 'command' | 'read' | 'key-lifecycle';
type Source = 'signed' | 'guc' | 'caller-argument' | 'none';
type Permission = 'signed-op' | 'execute-acl';
type CallerIds = 'payload-digest' | 'payload-fingerprint' | 'guc-equality' | 'unbound' | 'none';

/** One door: §14's fourteen attributes, less the two this suite asserts as set-wide clauses (`search_path` and PUBLIC EXECUTE). */
interface Door {
  /** signature */
  readonly sig: string;
  /** owner */
  readonly owner: Owner;
  /** EXECUTE grantees, exactly — nobody else, PUBLIC included */
  readonly grantees: readonly string[];
  /** operation */
  readonly kind: Kind;
  /** domain */
  readonly domain: string;
  /** tenant source */
  readonly tenant: Source;
  /** business source */
  readonly business: Source;
  /** assertion source — the gate call, or `none` */
  readonly assertion: string;
  /** permission source */
  readonly permission: Permission;
  /** caller-controlled ids — what binds them */
  readonly callerIds: CallerIds;
  /** structural bindings written */
  readonly bindings: string;
  /** whether it reads */
  readonly reads: boolean;
  /** whether it writes */
  readonly writes: boolean;
}

/**
 * ── THE DOORS: every SECURITY DEFINER routine of either internal principal
 *    that ANY principal but its owner may EXECUTE. Written by hand from the
 *    bodies and the ACLs, never read out of the query that judges it.
 */
const DOORS: readonly Door[] = [
  {
    sig: 'accounting_assertion_key_install(text,bytea)',
    owner: 'accounting',
    grantees: ['daftar_platform'],
    kind: 'key-lifecycle',
    domain: 'accounting',
    tenant: 'none',
    business: 'none',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'none',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_assertion_key_retire(text)',
    owner: 'accounting',
    grantees: ['daftar_platform'],
    kind: 'key-lifecycle',
    domain: 'accounting',
    tenant: 'none',
    business: 'none',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'none',
    bindings: 'none',
    reads: false,
    writes: true,
  },
  {
    sig: 'accounting_fx_rate_enter(text,text,text,timestamp with time zone,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_control_actor(ARRAY['fx_rate_enter'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_inventory_opening_position(uuid)',
    owner: 'accounting',
    grantees: ['daftar_inventory_internal'],
    kind: 'read',
    domain: 'accounting',
    tenant: 'guc',
    business: 'guc',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'guc-equality',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'accounting_open_balance_discard(uuid)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: 'accounting_opening_balance_authority()',
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_open_balance_draft(date,jsonb)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: 'accounting_opening_balance_authority()',
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_open_balance_edit(uuid,date,jsonb)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: 'accounting_opening_balance_authority()',
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_open_balance_post(uuid,text,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: 'accounting_opening_balance_authority()',
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_period_close(uuid,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_control_actor(ARRAY['period_close'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_period_create(uuid,date,date,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_control_actor(ARRAY['period_create'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_period_reopen(uuid,text,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_control_actor(ARRAY['period_reopen'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_post_entry(date,text,text,jsonb)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_actor(ARRAY['post'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'accounting_source_bindings',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_post_manual_adjustment(date,text,text,text,jsonb)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_actor(ARRAY['post'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_post_reversal(uuid,date,text,text)',
    owner: 'accounting',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'accounting',
    tenant: 'signed',
    business: 'signed',
    assertion: "accounting_actor(ARRAY['reverse'])",
    permission: 'signed-op',
    callerIds: 'payload-fingerprint',
    bindings: 'accounting_source_bindings',
    reads: true,
    writes: true,
  },
  {
    sig: 'accounting_purchase_entry_id(uuid,uuid)',
    owner: 'accounting',
    grantees: ['daftar_inventory_internal'],
    kind: 'read',
    domain: 'accounting',
    tenant: 'caller-argument',
    business: 'caller-argument',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'unbound',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'accounting_purchase_fx_rate(uuid,character,timestamp with time zone)',
    owner: 'accounting',
    grantees: ['daftar_inventory_internal'],
    kind: 'read',
    domain: 'accounting',
    tenant: 'guc',
    business: 'guc',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'guc-equality',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'accounting_reconcile_businesses(uuid,uuid,integer)',
    owner: 'accounting',
    grantees: ['daftar_reconciler'],
    kind: 'read',
    domain: 'accounting',
    tenant: 'none',
    business: 'none',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'none',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'accounting_settlement_account_eligibility(uuid,uuid)',
    owner: 'accounting',
    grantees: ['daftar_inventory_internal'],
    kind: 'read',
    domain: 'accounting',
    tenant: 'guc',
    business: 'guc',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'guc-equality',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'customer_apply_credit(uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'receivables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('customer.apply_credit')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'customer_collect_payment(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid,bigint,bigint,uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'receivables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('customer.collect_payment')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_adjust_stock(uuid,uuid,date,text,uuid[],numeric[],numeric[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.adjust')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_assertion_key_install(text,bytea)',
    owner: 'inventory',
    grantees: ['daftar_platform'],
    kind: 'key-lifecycle',
    domain: 'inventory',
    tenant: 'none',
    business: 'none',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'none',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_assertion_key_retire(text)',
    owner: 'inventory',
    grantees: ['daftar_platform'],
    kind: 'key-lifecycle',
    domain: 'inventory',
    tenant: 'none',
    business: 'none',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'none',
    bindings: 'none',
    reads: false,
    writes: true,
  },
  {
    sig: 'inventory_business_has_stock_movements(uuid)',
    owner: 'inventory',
    grantees: ['daftar_accounting_internal'],
    kind: 'read',
    domain: 'inventory',
    tenant: 'caller-argument',
    business: 'caller-argument',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'unbound',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'inventory_business_stock_value_equals(uuid,numeric)',
    owner: 'inventory',
    grantees: ['daftar_accounting_internal'],
    kind: 'read',
    domain: 'inventory',
    tenant: 'caller-argument',
    business: 'caller-argument',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'unbound',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'inventory_configure_product(uuid,boolean,text,smallint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.configure_product')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_record_damage(uuid,uuid,date,text,uuid[],numeric[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.damage')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.opening')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_sale_cost_base_minor(uuid,uuid)',
    owner: 'inventory',
    grantees: ['daftar_accounting_internal'],
    kind: 'read',
    domain: 'inventory',
    tenant: 'caller-argument',
    business: 'caller-argument',
    assertion: 'none',
    permission: 'execute-acl',
    callerIds: 'unbound',
    bindings: 'none',
    reads: true,
    writes: false,
  },
  {
    sig: 'inventory_stocktake_count(uuid,uuid,uuid[],numeric[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.stocktake_count')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_stocktake_finalize(uuid,uuid,text,date,uuid[],numeric[],numeric[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.stocktake_finalize')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_stocktake_open(uuid,uuid)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.stocktake_open')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'inventory_transfer_stock(uuid,uuid,uuid,uuid[],numeric[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'inventory',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('inventory.transfer')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'payment_method_activate(uuid,integer)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payments',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('payment.activate_method')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'payment_method_create(uuid,text,uuid,boolean,integer,text,text,text)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payments',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('payment.create_method')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'payment_method_deactivate(uuid,integer)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payments',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('payment.deactivate_method')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'payment_method_update(uuid,integer,uuid,boolean,integer,text,text,text)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payments',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('payment.update_method')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'pos_cart_remove_line(uuid,uuid)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'pos',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('pos.cart_remove_line')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: false,
    writes: true,
  },
  {
    sig: 'pos_cart_set_line(uuid,uuid,integer,uuid,uuid,numeric,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'pos',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('pos.cart_set_line')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'pos_till_session_close(uuid,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'pos',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('pos.session_close')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'pos_till_session_open(uuid,uuid,uuid,text,text,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'pos',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('pos.session_open')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_cancel(uuid,uuid,integer)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.cancel')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_receive(uuid,uuid,integer,uuid,integer,date,character,uuid,numeric,text,timestamp with time zone,bigint,bigint,uuid,uuid[],uuid[],numeric[],bigint[],numeric[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.receive')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_return(uuid,uuid,uuid,date,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,bigint,uuid[],uuid[],uuid[],numeric[],bigint[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.return')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_reverse(uuid,uuid,date,text,uuid,bigint,uuid[],uuid[],numeric[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.reverse')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_save_draft(uuid,integer,uuid,uuid,uuid,character,date,text,text,bigint,uuid[],uuid[],numeric[],numeric[],bigint[],uuid[],text[],bigint[],text[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.draft')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'purchase_write_off_residue(uuid,date,text,bigint,bigint,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'purchasing',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('purchase.write_off_residue')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'sale_commit(uuid,uuid,text,uuid,uuid,uuid,date,date,character,uuid,numeric,text,timestamp with time zone,bigint,bigint,bigint,bigint,text,uuid[],uuid[],uuid[],uuid[],text[],numeric[],bigint[],bigint[],bigint[],bigint[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'sales',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('sale.commit')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'stock_source_bindings (via inventory_apply_stock_movements)',
    reads: true,
    writes: true,
  },
  {
    sig: 'structure_associate_warehouse_branch(uuid,uuid)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'structure',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('structure.associate_warehouse_branch')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'structure_dissociate_warehouse_branch(uuid,uuid)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'structure',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('structure.dissociate_warehouse_branch')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_allocate_credit(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.allocate_credit')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_archive(uuid,integer)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.archive')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_create(uuid,text,text,text,text,text)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.create')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_pay(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid[],uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.pay')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_reactivate(uuid,integer)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.reactivate')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_receive_refund(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,bigint,text)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.receive_refund')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
  {
    sig: 'supplier_update(uuid,integer,text,text,text,text,text)',
    owner: 'inventory',
    grantees: ['daftar_app'],
    kind: 'command',
    domain: 'payables',
    tenant: 'signed',
    business: 'signed',
    assertion: "inventory_assertion_consume('supplier.update')",
    permission: 'signed-op',
    callerIds: 'payload-digest',
    bindings: 'none',
    reads: true,
    writes: true,
  },
];

/**
 * ── THE SEALED SET: every other SECURITY DEFINER routine of either
 *    principal. Each has an EXPLICIT, EMPTY ACL — `proacl` is not null, so
 *    the default PUBLIC EXECUTE was revoked — and therefore no caller at all
 *    besides its owner: the trigger manager runs the `trigger` ones and the
 *    owner's own elevated code calls the `helper` ones. With no caller there
 *    is no tenant, business, assertion or permission source to record and no
 *    caller-controlled id to bind; what IS recorded is the owner, the kind,
 *    and whether it reads (`r`) and writes (`w`).
 */
const SEALED: readonly (readonly [string, Owner, 'trigger' | 'helper', 'r' | 'w' | 'rw' | '-'])[] = [
  ['accounting_actor(text[])', 'accounting', 'helper', 'rw'],
  ['accounting_assert_entry_valid(uuid,uuid)', 'accounting', 'helper', 'r'],
  ['accounting_control_actor(text[])', 'accounting', 'helper', 'rw'],
  ['accounting_customer_credit_application_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_customer_credit_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_customer_payment_allocation_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_entry_date_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_inventory_account_domain_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_inventory_account_domain_serial_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_inventory_adjustment_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_inventory_opening_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_inventory_reversal_domain_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_invoice_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_manual_adjustment_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_negative_inventory_cost_adjustment_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_open_balance_supersede(uuid,text)', 'accounting', 'helper', 'rw'],
  ['accounting_opening_balance_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_opening_balance_lines_state()', 'accounting', 'trigger', 'r'],
  ['accounting_opening_balances_30_inventory_opening_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_opening_balances_state()', 'accounting', 'trigger', 'r'],
  ['accounting_period_guard_posting()', 'accounting', 'trigger', 'r'],
  ['accounting_period_topology_check()', 'accounting', 'trigger', 'r'],
  ['accounting_purchase_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_purchase_residue_write_off_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_reversal_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_reversals_20_domain_source_guard()', 'accounting', 'trigger', 'r'],
  ['accounting_sale_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_seed_chart_trg()', 'accounting', 'trigger', '-'],
  ['accounting_seed_chart(uuid)', 'accounting', 'helper', 'rw'],
  ['accounting_supplier_credit_allocation_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_supplier_payment_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_supplier_refund_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_supplier_return_entry_complete()', 'accounting', 'trigger', 'r'],
  ['accounting_validate_entry_of_line()', 'accounting', 'trigger', '-'],
  ['accounting_validate_entry()', 'accounting', 'trigger', '-'],
  ['accounts_posting_stability()', 'accounting', 'trigger', '-'],
  ['businesses_base_currency_lock()', 'accounting', 'trigger', 'r'],
  ['invoices_walkin_no_ar()', 'accounting', 'trigger', 'r'],
  ['sales_cogs_owed()', 'accounting', 'trigger', 'r'],
  ['sales_walkin_no_ar()', 'accounting', 'trigger', 'r'],
  ['branch_warehouses_keep_home()', 'inventory', 'trigger', 'r'],
  ['customer_credit_application_guard()', 'inventory', 'trigger', '-'],
  ['customer_credit_application_value_complete()', 'inventory', 'trigger', 'r'],
  ['customer_credit_consume(uuid,bigint,bigint)', 'inventory', 'helper', 'rw'],
  ['customer_credit_guard()', 'inventory', 'trigger', 'r'],
  ['customer_credit_verify(uuid,uuid)', 'inventory', 'helper', 'r'],
  ['customers_no_delete()', 'inventory', 'trigger', '-'],
  ['customers_revision_guard()', 'inventory', 'trigger', '-'],
  ['inventory_apply_stock_movements(inventory_movement_request[])', 'inventory', 'helper', 'rw'],
  ['inventory_assertion_consume(text,text)', 'inventory', 'helper', 'rw'],
  ['inventory_assertion_current(text[])', 'inventory', 'helper', 'r'],
  ['inventory_bridge_source_lines(text,uuid)', 'inventory', 'helper', 'rw'],
  ['inventory_business_transaction_id()', 'inventory', 'helper', '-'],
  ['inventory_claimed_payload_digest(text,text[],text[])', 'inventory', 'helper', '-'],
  ['inventory_fixed_text(numeric,integer)', 'inventory', 'helper', '-'],
  ['inventory_half_even(numeric,numeric,integer)', 'inventory', 'helper', '-'],
  ['inventory_largest_remainder(numeric[],bigint)', 'inventory', 'helper', 'r'],
  ['inventory_lock_stock_targets(uuid[],uuid[])', 'inventory', 'helper', 'r'],
  ['inventory_next_deficit_seq(uuid,uuid,uuid)', 'inventory', 'helper', 'r'],
  ['inventory_payload_digest(text,uuid,uuid,text[],text[])', 'inventory', 'helper', '-'],
  ['inventory_payload_field_is_canonical(text,text)', 'inventory', 'helper', 'r'],
  ['inventory_quantity_is_representable(numeric,smallint)', 'inventory', 'helper', '-'],
  ['inventory_reason_words(text)', 'inventory', 'helper', '-'],
  ['inventory_source_header_guard()', 'inventory', 'trigger', '-'],
  ['inventory_source_value_complete()', 'inventory', 'trigger', 'r'],
  ['inventory_stock_fold(uuid,uuid,uuid)', 'inventory', 'helper', 'r'],
  ['inventory_stock_verify(uuid,uuid,uuid)', 'inventory', 'helper', 'r'],
  ['invoice_items_no_mutation()', 'inventory', 'trigger', '-'],
  ['invoice_sequences_key_guard()', 'inventory', 'trigger', '-'],
  ['invoice_settlement_verify(uuid,uuid)', 'inventory', 'helper', 'r'],
  ['invoices_lifecycle_guard()', 'inventory', 'trigger', '-'],
  ['invoices_no_delete()', 'inventory', 'trigger', '-'],
  ['negative_deficit_coverage_same_transaction()', 'inventory', 'trigger', 'r'],
  ['negative_inventory_deficits_coverage_consistent()', 'inventory', 'trigger', 'r'],
  ['negative_inventory_deficits_coverage_guard()', 'inventory', 'trigger', '-'],
  ['payment_allocation_guard()', 'inventory', 'trigger', 'r'],
  ['payment_allocation_value_complete()', 'inventory', 'trigger', 'r'],
  ['payment_closure_verify(uuid,uuid)', 'inventory', 'helper', 'r'],
  ['payment_complete()', 'inventory', 'trigger', '-'],
  ['payment_guard()', 'inventory', 'trigger', 'r'],
  ['payment_method_guard()', 'inventory', 'trigger', 'r'],
  ['payment_method_name_guard()', 'inventory', 'trigger', 'r'],
  ['payment_method_named()', 'inventory', 'trigger', 'r'],
  ['pos_cart_line_guard()', 'inventory', 'trigger', 'r'],
  ['pos_till_session_guard()', 'inventory', 'trigger', '-'],
  ['product_variants_20_stock_identity_lock()', 'inventory', 'trigger', 'r'],
  ['product_variants_30_archive_requires_zero_stock()', 'inventory', 'trigger', 'r'],
  ['products_20_unit_history_lock()', 'inventory', 'trigger', 'r'],
  ['products_30_archive_requires_zero_stock()', 'inventory', 'trigger', 'r'],
  ['purchase_allocations_consistent()', 'inventory', 'trigger', 'r'],
  ['purchase_bridge_credit_note(uuid)', 'inventory', 'helper', 'rw'],
  ['purchase_bridge_receipt(uuid,uuid)', 'inventory', 'helper', 'rw'],
  ['purchase_bridge_return(uuid)', 'inventory', 'helper', 'rw'],
  ['purchase_bridge_reversal(uuid)', 'inventory', 'helper', 'rw'],
  ['purchase_cover_deficits(uuid,uuid)', 'inventory', 'helper', 'rw'],
  ['purchase_header_guard()', 'inventory', 'trigger', '-'],
  ['purchase_landed_cost_freeze()', 'inventory', 'trigger', 'r'],
  ['purchase_lock_receipt_targets(uuid,uuid[])', 'inventory', 'helper', 'r'],
  ['purchase_lock_stock_keys(uuid,uuid[])', 'inventory', 'helper', 'r'],
  ['purchase_residue_write_off_guard()', 'inventory', 'trigger', '-'],
  ['purchase_residue_write_off_value_complete()', 'inventory', 'trigger', 'r'],
  ['purchase_reversal_detail_same_transaction()', 'inventory', 'trigger', 'r'],
  ['purchase_reversal_unsettled()', 'inventory', 'trigger', 'r'],
  ['purchase_reversal_value_complete()', 'inventory', 'trigger', 'r'],
  ['purchase_settlement_verify(uuid,uuid)', 'inventory', 'helper', 'r'],
  ['purchase_source_value_complete()', 'inventory', 'trigger', 'r'],
  ['sale_bridge_commit(uuid)', 'inventory', 'helper', 'rw'],
  ['sale_document_number(text,text,bigint)', 'inventory', 'helper', '-'],
  ['sale_header_guard()', 'inventory', 'trigger', '-'],
  ['sale_lock_commit_targets(uuid,uuid[])', 'inventory', 'helper', 'r'],
  ['stock_binding_requires_inventory_adjustment()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_inventory_opening()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_inventory_transfer()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_negative_inventory_cost_adjustment()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_purchase_reversal()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_purchase()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_sale()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_stocktake()', 'inventory', 'trigger', 'r'],
  ['stock_binding_requires_supplier_return()', 'inventory', 'trigger', 'r'],
  ['stock_levels_zero_on_hand_zero_value()', 'inventory', 'trigger', 'r'],
  ['stock_movements_account_domain_lock()', 'inventory', 'trigger', '-'],
  ['stock_source_complete_inventory_adjustment()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_inventory_opening()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_inventory_transfer()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_negative_inventory_cost_adjustment()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_purchase_header()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_purchase_reversal_header()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_purchase_reversal()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_purchase()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_sale_header()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_sale()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_stocktake_header()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_stocktake()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_supplier_return_header()', 'inventory', 'trigger', 'r'],
  ['stock_source_complete_supplier_return()', 'inventory', 'trigger', 'r'],
  ['stock_source_freeze_inventory_adjustment()', 'inventory', 'trigger', '-'],
  ['stock_source_freeze_inventory_opening()', 'inventory', 'trigger', '-'],
  ['stock_source_freeze_inventory_transfer()', 'inventory', 'trigger', '-'],
  ['stock_source_freeze_purchase()', 'inventory', 'trigger', 'r'],
  ['stock_source_freeze_stocktake()', 'inventory', 'trigger', 'r'],
  ['supplier_ap_release(bigint,bigint,bigint,bigint)', 'inventory', 'helper', '-'],
  ['supplier_convert_base(bigint,numeric,integer,integer)', 'inventory', 'helper', '-'],
  ['supplier_credit_allocation_guard()', 'inventory', 'trigger', '-'],
  ['supplier_credit_allocation_value_complete()', 'inventory', 'trigger', 'r'],
  ['supplier_credit_note_consume(uuid,bigint,bigint)', 'inventory', 'helper', 'rw'],
  ['supplier_credit_note_guard()', 'inventory', 'trigger', 'r'],
  ['supplier_credit_note_verify(uuid,uuid)', 'inventory', 'helper', 'r'],
  ['supplier_credit_remaining_carrying(bigint,bigint,bigint)', 'inventory', 'helper', '-'],
  ['supplier_payment_allocation_guard()', 'inventory', 'trigger', 'r'],
  ['supplier_payment_allocation_value_complete()', 'inventory', 'trigger', 'r'],
  ['supplier_payment_complete()', 'inventory', 'trigger', 'r'],
  ['supplier_payment_guard()', 'inventory', 'trigger', 'r'],
  ['supplier_refund_guard()', 'inventory', 'trigger', 'r'],
  ['supplier_refund_value_complete()', 'inventory', 'trigger', 'r'],
  ['supplier_return_detail_same_transaction()', 'inventory', 'trigger', 'r'],
  ['supplier_return_quantity_bound()', 'inventory', 'trigger', 'r'],
  ['supplier_return_residue_bound()', 'inventory', 'trigger', 'r'],
  ['supplier_return_value_complete()', 'inventory', 'trigger', 'r'],
  ['supplier_return_value_settled()', 'inventory', 'trigger', 'r'],
  ['suppliers_no_delete()', 'inventory', 'trigger', '-'],
  ['suppliers_revision_guard()', 'inventory', 'trigger', '-'],
  ['warehouses_30_archive_requires_zero_stock()', 'inventory', 'trigger', 'r'],
  ['warehouses_home_branch_maintain()', 'inventory', 'trigger', 'w'],
  ['warehouses_require_home_branch()', 'inventory', 'trigger', 'r'],
];

interface Row {
  sig: string;
  owner: string;
  config: string[] | null;
  public_exec: boolean;
  grantees: string[];
  acl_null: boolean;
  trigger: boolean;
  code: string;
}

/**
 * Every SECURITY DEFINER routine either internal principal owns, as the LIVE
 * catalogue has it. `code` is the body with `--`/`/* *\/` comments, quoted
 * literals and dollar-quoted blocks replaced, so a routine that merely NAMES
 * a gate or a DML verb in its prose is not credited with calling one.
 */
async function liveDefiners(q: Pick<PoolClient, 'query'>): Promise<Row[]> {
  const r = await q.query<Row>(
    `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
            o.rolname::text                                            AS owner,
            p.proconfig                                                AS config,
            has_function_privilege('public', p.oid, 'EXECUTE')         AS public_exec,
            coalesce((SELECT array_agg(z.g ORDER BY z.g)
                        FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g
                                FROM aclexplode(p.proacl) a
                               WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) z)::text[], ARRAY[]::text[]) AS grantees,
            p.proacl IS NULL                                           AS acl_null,
            p.prorettype = 'trigger'::regtype                          AS trigger,
            p.prosrc                                                   AS code
       FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
      WHERE p.prosecdef AND o.rolname IN ($1, $2)
      ORDER BY 1`,
    [INVENTORY, ACCOUNTING],
  );
  return r.rows.map((x) => ({ ...x, code: strip(x.code) }));
}

/** `--` and `/* *\/` comments, `'…'` literals and `$tag$…$tag$` blocks removed. */
export function strip(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('--', i)) {
      const n = src.indexOf('\n', i);
      i = n < 0 ? src.length : n;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const n = src.indexOf('*/', i + 2);
      i = n < 0 ? src.length : n + 2;
      out += ' ';
      continue;
    }
    if (src[i] === "'") {
      i += 1;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " '' ";
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
    if (dollar !== null) {
      const tag = dollar[0];
      const n = src.indexOf(tag, i + tag.length);
      i = n < 0 ? src.length : n + tag.length;
      out += ' $$ ';
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

const writesIn = (code: string): boolean => /\b(?:INSERT\s+INTO|UPDATE\s+(?!SET\b)[a-z_"]|DELETE\s+FROM)/i.test(code);
const readsIn = (code: string): boolean => /\bSELECT\b/i.test(code);
const gatesIn = (code: string): string[] => GATES.filter((g) => new RegExp(`\\b${g}\\s*\\(`).test(code));

/** Which `pg_roles` entries can log in — a login grantee is a RUNTIME principal, read, never remembered. */
async function loginRoles(q: Pick<PoolClient, 'query'>): Promise<Set<string>> {
  const r = await q.query<{ r: string }>(`SELECT rolname::text AS r FROM pg_roles WHERE rolcanlogin`);
  return new Set(r.rows.map((x) => x.r));
}

/**
 * THE LAW, as a list of findings. Empty is green. Each finding opens with the
 * §17 condition or the §14 standard it trips, so a red test names the ruling.
 */
export async function inventoryFindings(q: Pick<PoolClient, 'query'>, logins: Set<string>): Promise<string[]> {
  const findings: string[] = [];
  const live = await liveDefiners(q);
  const doors = new Map(DOORS.map((d) => [d.sig, d]));
  const sealed = new Map(SEALED.map((s) => [s[0], s]));
  const seen = new Set<string>();

  for (const row of live) {
    seen.add(row.sig);
    const door = doors.get(row.sig);
    const seal = sealed.get(row.sig);
    // §17 condition 1 is judged over EVERY definer of an internal principal,
    // recorded or not. A routine the record does not know about is the LEAST
    // trustworthy place to skip the PUBLIC check, so this runs first.
    if (row.public_exec) findings.push(`${COND_1}: ${row.sig} is executable by PUBLIC`);
    if (row.acl_null) findings.push(`${COND_1}: ${row.sig} has a NULL proacl, so the default PUBLIC EXECUTE was never revoked`);
    if (door === undefined && seal === undefined) {
      findings.push(`${UNDOCUMENTED}: ${row.sig} (owner ${row.owner}, EXECUTE ${row.grantees.join(',') || 'nobody'}${row.public_exec ? ', PUBLIC' : ''})`);
      continue;
    }
    // Set-wide clause: the pinned path on every recorded entry.
    if (JSON.stringify(row.config) !== JSON.stringify([PINNED]))
      findings.push(`${CHANGED}: ${row.sig} search_path is ${JSON.stringify(row.config)}, recorded ${PINNED}`);

    if (seal !== undefined) {
      if (row.owner !== OWNER_ROLE[seal[1]]) findings.push(`${CHANGED}: ${row.sig} is owned by ${row.owner}, recorded ${OWNER_ROLE[seal[1]]}`);
      if (row.grantees.length > 0) findings.push(`${COND_1}: ${row.sig} is recorded as having NO caller but now grants EXECUTE to ${row.grantees.join(',')}`);
      if (row.trigger !== (seal[2] === 'trigger'))
        findings.push(`${CHANGED}: ${row.sig} is ${row.trigger ? 'a trigger function' : 'not a trigger function'}, recorded ${seal[2]}`);
      const rw = `${readsIn(row.code) ? 'r' : ''}${writesIn(row.code) ? 'w' : ''}` || '-';
      if (rw !== seal[3]) findings.push(`${CHANGED}: ${row.sig} reads/writes ${rw}, recorded ${seal[3]}`);
      continue;
    }
    if (door === undefined) continue;

    if (row.owner !== OWNER_ROLE[door.owner]) findings.push(`${CHANGED}: ${row.sig} is owned by ${row.owner}, recorded ${OWNER_ROLE[door.owner]}`);
    if (JSON.stringify(row.grantees) !== JSON.stringify([...door.grantees]))
      findings.push(`${COND_1}: ${row.sig} grants EXECUTE to ${row.grantees.join(',') || 'nobody'}, recorded exactly ${door.grantees.join(',')}`);
    if (row.trigger) findings.push(`${CHANGED}: ${row.sig} is a trigger function, and a trigger function has no caller to record a door for`);
    if (readsIn(row.code) !== door.reads)
      findings.push(`${CHANGED}: ${row.sig} ${readsIn(row.code) ? 'reads' : 'does not read'}, recorded reads=${door.reads}`);
    if (writesIn(row.code) !== door.writes)
      findings.push(`${CHANGED}: ${row.sig} ${writesIn(row.code) ? 'writes' : 'does not write'}, recorded writes=${door.writes}`);

    // §17 condition 2 — the recorded authority proof is the one the body performs.
    const gates = gatesIn(row.code);
    if (door.permission === 'signed-op') {
      if (door.tenant !== 'signed' || door.business !== 'signed')
        findings.push(`${COND_2}: ${row.sig} records a signed decision but takes its tenant from ${door.tenant} and its business from ${door.business}`);
      const recorded = GATES.find((g) => door.assertion.startsWith(`${g}(`));
      if (recorded === undefined)
        findings.push(`${COND_2}: ${row.sig} records permission=signed-op but its assertion source ${JSON.stringify(door.assertion)} names no verifier gate`);
      else if (!gates.includes(recorded))
        findings.push(`${COND_2}: ${row.sig} records the gate ${recorded} but its body calls ${gates.join(',') || 'no gate at all'}`);
    } else {
      if (gates.length > 0) findings.push(`${CHANGED}: ${row.sig} is recorded as acl-only but its body calls ${gates.join(',')} — record the gate`);
      for (const g of row.grantees) {
        if (!logins.has(g)) continue;
        if (!(ACL_ONLY_LOGIN_GRANTEES as readonly string[]).includes(g))
          findings.push(`${COND_2}: ${row.sig} has no per-call authority proof and grants EXECUTE to the login principal ${g}`);
      }
    }
    // §17 condition 1 — who a door may be opened by at all.
    for (const g of row.grantees) {
      if (g === 'PUBLIC') findings.push(`${COND_1}: ${row.sig} grants EXECUTE to PUBLIC`);
      else if (logins.has(g) && g !== 'daftar_app' && !(ACL_ONLY_LOGIN_GRANTEES as readonly string[]).includes(g))
        findings.push(`${COND_1}: ${row.sig} grants EXECUTE to the login principal ${g}, which the inventory does not admit as a caller of internal authority`);
    }
    // A GUC is not an authority proof, and must never be recorded as one.
    if (door.permission === 'signed-op' && (door.callerIds === 'guc-equality' || door.tenant === 'guc' || door.business === 'guc'))
      findings.push(`${COND_2}: ${row.sig} rests a signed-decision claim on a GUC`);
  }

  for (const sig of [...doors.keys(), ...sealed.keys()])
    if (!seen.has(sig))
      findings.push(`${CHANGED}: ${sig} is recorded but the catalogue has no SECURITY DEFINER routine of that signature owned by an internal principal`);
  return findings;
}

let logins: Set<string>;

beforeAll(async () => {
  await ensurePostgres();
  logins = await loginRoles(ownerPool());
}, 600_000);

describe('TL-P4-RLS-INT-01 §14 — the internal SECURITY DEFINER inventory is COMPLETE and matches the catalogue', () => {
  it('the roster is real: both principals own SECURITY DEFINER routines, so a pass here means something', async () => {
    const live = await liveDefiners(ownerPool());
    const byOwner = new Map<string, number>();
    for (const r of live) byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0) + 1);
    expect(byOwner.get(INVENTORY) ?? 0, 'the inventory principal owns no definer, so this suite has no subject').toBeGreaterThan(100);
    expect(byOwner.get(ACCOUNTING) ?? 0, 'the accounting principal owns no definer, so this suite has no subject').toBeGreaterThan(10);
    expect(live.length).toBe(DOORS.length + SEALED.length);
  });

  it('the recorded set is EXACTLY the catalogue’s set — no undocumented callable internal authority', async () => {
    const live = (await liveDefiners(ownerPool())).map((x) => x.sig).sort();
    const recorded = [...DOORS.map((d) => d.sig), ...SEALED.map((s) => s[0])].sort();
    expect(new Set(recorded).size, 'a signature is recorded twice').toBe(recorded.length);
    expect(live, UNDOCUMENTED).toEqual(recorded);
  });

  it('every recorded attribute still matches the catalogue, and no §17 condition is tripped', async () => {
    expect(await inventoryFindings(ownerPool(), logins)).toEqual([]);
  });

  it('every door granted to the one ordinary runtime credential (daftar_app) is gated by a signed server decision — §17 condition 2', async () => {
    const app = DOORS.filter((d) => d.grantees.includes('daftar_app'));
    expect(app.length, 'no door is reachable by daftar_app, so this clause has no subject').toBeGreaterThan(40);
    expect(
      app.filter((d) => d.permission !== 'signed-op' || d.tenant !== 'signed' || d.business !== 'signed').map((d) => d.sig),
      COND_2,
    ).toEqual([]);
    // And the body really performs it — the record is not taken on trust.
    const live = new Map((await liveDefiners(ownerPool())).map((x) => [x.sig, x]));
    for (const d of app) {
      const code = live.get(d.sig)?.code ?? '';
      expect(gatesIn(code), `${COND_2}: ${d.sig}`).toHaveLength(1);
    }
  });

  it('a GUC is recorded as a scope narrowing and never as an authority proof — and no GUC-scoped door is reachable by a login principal', async () => {
    const guc = DOORS.filter((d) => d.tenant === 'guc' || d.business === 'guc' || d.callerIds === 'guc-equality');
    expect(guc.length, 'the GUC-scoped cross-domain readers are gone, so this clause has no subject').toBeGreaterThan(0);
    for (const d of guc) {
      expect(d.permission, `${COND_2}: ${d.sig} records a GUC as its permission source`).toBe('execute-acl');
      expect(
        d.grantees.filter((g) => logins.has(g)),
        `${COND_1}: ${d.sig}`,
      ).toEqual([]);
    }
  });

  it('the acl-only doors a LOGIN principal can open are exactly the ops credentials an accepted suite already pins', async () => {
    const aclOnlyLogin = DOORS.filter((d) => d.permission === 'execute-acl' && d.grantees.some((g) => logins.has(g)));
    expect(aclOnlyLogin.map((d) => `${d.sig} → ${d.grantees.filter((g) => logins.has(g)).join(',')}`).sort(), COND_2).toEqual([
      'accounting_assertion_key_install(text,bytea) → daftar_platform',
      'accounting_assertion_key_retire(text) → daftar_platform',
      'accounting_reconcile_businesses(uuid,uuid,integer) → daftar_reconciler',
      'inventory_assertion_key_install(text,bytea) → daftar_platform',
      'inventory_assertion_key_retire(text) → daftar_platform',
    ]);
  });

  it('the inventory document records every signature the law does, so the page cannot drift from it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const page = readFileSync(join(__dirname, '..', '..', INVENTORY_DOC), 'utf8');
    const missing = [...DOORS.map((d) => d.sig), ...SEALED.map((s) => s[0])].filter((sig) => !page.includes(sig));
    expect(missing, `${UNDOCUMENTED}: ${INVENTORY_DOC} does not name these recorded routines`).toEqual([]);
  });
});

/**
 * ── RED PROOF ─────────────────────────────────────────────────────────────
 *
 * Every plant is a REAL object of the REAL catalogue, created and dropped (or
 * rolled back) inside this suite. No fictional subject is pinned anywhere: a
 * law that reports "no finding" about a function the catalogue does not have
 * pins nothing.
 */
describe('TL-P4-RLS-INT-01 §14 RED PROOF — the completeness law can fail, and names the condition', () => {
  let owner: PoolClient;
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const planted = `p4s4_definer_probe_${tag}`;

  beforeAll(async () => {
    owner = await ownerPool().connect();
    // A previous run that died mid-plant would otherwise leave its throwaway
    // behind and make every case below report it as undocumented authority.
    const stale = await owner.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname LIKE 'p4s4\\_definer\\_probe\\_%'`,
    );
    for (const row of stale.rows) await owner.query(`DROP FUNCTION ${row.sig}`);
  });

  afterAll(async () => {
    await owner.query(`DROP FUNCTION IF EXISTS ${planted}(uuid)`).catch(() => undefined);
    owner.release();
  });

  /** Run `body` with `plant` applied, always rolled back. */
  const rolledBack = async (plant: readonly string[], body: () => Promise<void>): Promise<void> => {
    await owner.query('BEGIN');
    try {
      for (const sql of plant) await owner.query(sql);
      await body();
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  };

  it('as shipped, the live catalogue produces no finding at all', async () => {
    expect(await inventoryFindings(owner, logins)).toEqual([]);
  });

  it('RED: a NEW SECURITY DEFINER function owned by an internal principal is reported as UNDOCUMENTED, and dropping it clears the finding', async () => {
    await owner.query(
      `CREATE FUNCTION ${planted}(p_business_id uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER
         SET search_path = pg_catalog, public, pg_temp
         AS 'SELECT count(*)::bigint FROM public.stock_movements m WHERE m.business_id = p_business_id'`,
    );
    await owner.query(`REVOKE ALL ON FUNCTION ${planted}(uuid) FROM PUBLIC`);
    await owner.query(`ALTER FUNCTION ${planted}(uuid) OWNER TO ${INVENTORY}`);

    const found = await inventoryFindings(owner, logins);
    expect(found.filter((f) => f.includes(planted))).toEqual([`${UNDOCUMENTED}: ${planted}(uuid) (owner ${INVENTORY}, EXECUTE nobody)`]);
    expect(found.filter((f) => f.includes(planted))[0]).toContain(RULING);

    // And the completeness equality itself goes red, not merely the finder.
    const live = (await liveDefiners(owner)).map((x) => x.sig);
    expect(live).toContain(`${planted}(uuid)`);
    expect([...DOORS.map((d) => d.sig), ...SEALED.map((s) => s[0])]).not.toContain(`${planted}(uuid)`);

    // §17 condition 1 on the SAME real throwaway: EXECUTE widened to PUBLIC.
    await rolledBack([`GRANT EXECUTE ON FUNCTION ${planted}(uuid) TO PUBLIC`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(`${COND_1}: ${planted}(uuid) is executable by PUBLIC`);
      expect(f).toContain(`${UNDOCUMENTED}: ${planted}(uuid) (owner ${INVENTORY}, EXECUTE PUBLIC, PUBLIC)`);
    });

    // And to an ordinary runtime login credential with no gate in the body.
    await rolledBack([`GRANT EXECUTE ON FUNCTION ${planted}(uuid) TO daftar_app`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f.filter((x) => x.includes(planted))).toContain(`${UNDOCUMENTED}: ${planted}(uuid) (owner ${INVENTORY}, EXECUTE daftar_app)`);
    });

    await owner.query(`DROP FUNCTION ${planted}(uuid)`);
    expect(await inventoryFindings(owner, logins)).toEqual([]);
  }, 180_000);

  it('RED: PUBLIC EXECUTE widened on a REAL recorded door is reported as §17 condition 1', async () => {
    const door = DOORS[0];
    if (door === undefined) throw new Error('the inventory records no door, so there is nothing to widen');
    await rolledBack([`GRANT EXECUTE ON FUNCTION ${door.sig} TO PUBLIC`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(`${COND_1}: ${door.sig} is executable by PUBLIC`);
      expect(f).toContain(`${COND_1}: ${door.sig} grants EXECUTE to PUBLIC`);
    });
    expect(await inventoryFindings(owner, logins)).toEqual([]);
  });

  it('RED: a runtime principal added to a REAL recorded door is reported as §17 condition 1 and as a changed grantee set', async () => {
    const door = DOORS.find((d) => d.grantees.length === 1 && d.grantees[0] === 'daftar_app');
    if (door === undefined) throw new Error('no door is granted to daftar_app alone, so there is nothing to widen');
    await rolledBack([`GRANT EXECUTE ON FUNCTION ${door.sig} TO daftar_worker`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(
        `${COND_1}: ${door.sig} grants EXECUTE to the login principal daftar_worker, which the inventory does not admit as a caller of internal authority`,
      );
      expect(f).toContain(`${COND_1}: ${door.sig} grants EXECUTE to daftar_app,daftar_worker, recorded exactly daftar_app`);
    });
  });

  it('RED: a SEALED routine handed a grantee is reported, and so is an owner change and a removed recorded routine', async () => {
    const seal = SEALED.find((s) => s[2] === 'helper');
    if (seal === undefined) throw new Error('the inventory records no sealed helper');
    await rolledBack([`GRANT EXECUTE ON FUNCTION ${seal[0]} TO daftar_app`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(`${COND_1}: ${seal[0]} is recorded as having NO caller but now grants EXECUTE to daftar_app`);
    });
    const other = seal[1] === 'inventory' ? ACCOUNTING : INVENTORY;
    await rolledBack([`ALTER FUNCTION ${seal[0]} OWNER TO ${other}`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(`${CHANGED}: ${seal[0]} is owned by ${other}, recorded ${OWNER_ROLE[seal[1]]}`);
    });
    await rolledBack([`ALTER FUNCTION ${seal[0]} OWNER TO daftar_migrator`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f, `${CHANGED}: a recorded routine that leaves both internal principals is reported`).toContain(
        `${CHANGED}: ${seal[0]} is recorded but the catalogue has no SECURITY DEFINER routine of that signature owned by an internal principal`,
      );
    });
    expect(await inventoryFindings(owner, logins)).toEqual([]);
  }, 120_000);

  it('RED: the pinned search_path dropped from a REAL recorded door is reported as a changed door', async () => {
    const door = DOORS[0];
    if (door === undefined) throw new Error('the inventory records no door');
    await rolledBack([`ALTER FUNCTION ${door.sig} RESET search_path`], async () => {
      const f = await inventoryFindings(owner, logins);
      expect(f).toContain(`${CHANGED}: ${door.sig} search_path is null, recorded ${PINNED}`);
    });
  });

  it('RED: a REAL door whose verifier gate is removed from the body is reported as §17 condition 2 — the gate is not taken on trust', async () => {
    const door = DOORS.find((d) => d.permission === 'signed-op');
    if (door === undefined) throw new Error('no door records a signed decision');
    const name = door.sig.slice(0, door.sig.indexOf('('));
    const args = (
      await owner.query<{ a: string; ret: string }>(
        `SELECT pg_get_function_identity_arguments(p.oid) AS a, pg_get_function_result(p.oid) AS ret FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [door.sig],
      )
    ).rows[0];
    if (args === undefined) throw new Error(`${door.sig} is not in the catalogue`);
    await rolledBack(
      [
        `CREATE OR REPLACE FUNCTION ${name}(${args.a}) RETURNS ${args.ret} LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, public, pg_temp
           AS $probe$ BEGIN RAISE EXCEPTION 'gate removed'; END $probe$`,
        `ALTER FUNCTION ${door.sig} OWNER TO ${OWNER_ROLE[door.owner]}`,
      ],
      async () => {
        const f = await inventoryFindings(owner, logins);
        expect(f).toContain(
          `${COND_2}: ${door.sig} records the gate ${GATES.find((g) => door.assertion.startsWith(`${g}(`)) ?? '?'} but its body calls no gate at all`,
        );
      },
    );
    expect(await inventoryFindings(owner, logins)).toEqual([]);
  }, 120_000);

  it('the body reader is not vacuous: it sees a real gate call and a real DML verb, and not one inside a comment or a literal', () => {
    expect(gatesIn(strip(`BEGIN v := inventory_assertion_consume('x','y'); END`))).toEqual(['inventory_assertion_consume']);
    expect(gatesIn(strip(`BEGIN -- inventory_assertion_consume('x','y')\n NULL; END`))).toEqual([]);
    expect(gatesIn(strip(`BEGIN RAISE EXCEPTION 'call accounting_actor(x) first'; END`))).toEqual([]);
    expect(writesIn(strip(`BEGIN UPDATE inventory_assertion_keys SET status = 'retired'; END`))).toBe(true);
    expect(writesIn(strip(`BEGIN SELECT 1 FROM t FOR UPDATE; END`))).toBe(false);
    expect(writesIn(strip(`BEGIN -- INSERT INTO t\n NULL; END`))).toBe(false);
    expect(readsIn(strip(`BEGIN PERFORM 1; END`))).toBe(false);
  });
});
