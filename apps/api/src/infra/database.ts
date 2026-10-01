import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Inject, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { splitAccountingAssertion, type AccountingPostingTransaction } from '@daftar/accounting';
import { splitInventoryAssertion } from '@daftar/inventory';
import type { AppConfig } from '../config';
import { mintProvisioningAssertion, parseProvisioningAssertionKey, type ProvisioningAssertionKey, type ProvisioningKind } from './provisioning-assertion';

/** Merchant business scope — tenant + business context for the app role. */
export interface Scope {
  tenantId?: string;
  businessId?: string;
  /**
   * Server-derived actor (Directive §12): the authenticated principal, set
   * as a TRANSACTION-LOCAL GUC so trusted SQL commands read it themselves
   * (provision_actor()) instead of trusting a caller-supplied user id.
   */
  actorUserId?: string;
  /**
   * Provisioning assertion (Final Release Blocker 1): an HMAC-signed,
   * single-use, kind-bound claim of the actor that the database verifies
   * inside provision_actor(). Set ONLY on provisioner transactions.
   */
  provisioningAssertion?: string;
  /**
   * Accounting command assertion (P2-S3): an HMAC-signed claim of the actor,
   * the tenant, the business, the source and the authorized payload
   * fingerprint, which `accounting_actor()` verifies inside
   * `accounting_post_entry`. Set ONLY on accounting posting transactions.
   */
  accountingAssertion?: string;
  /**
   * Accounting CONTROL assertion (P2-S5): the `acctctl/1` claim
   * `accounting_control_actor()` verifies inside an accounting CONFIGURATION
   * command such as `accounting_fx_rate_enter`.
   *
   * A GUC of its own, not a second value in the posting one. The two formats
   * are cryptographically domain-separated, and keeping the transports
   * separate too means a transaction that set only the posting assertion
   * cannot reach a control command at all — a compromised caller cannot
   * smuggle one into a posting workflow by reusing the connection's setting.
   */
  accountingControlAssertion?: string;
  /**
   * Inventory command assertion (P3-AL-55 §D): the `invctl/1` token an
   * inventory routine verifies and consumes inside
   * `inventory_assertion_consume`. A CARRIER only — whatever it holds is
   * worthless unless its MAC verifies in the database. Set ONLY by the two
   * business seams below.
   */
  inventoryAssertion?: string;
  /**
   * P3-AL-35 business transaction trace: a CARRIER for observability only.
   * The inventory routines copy it into the metadata of the audit row they
   * write; nothing reads it for a decision and it is not part of any signed
   * payload. Set ONLY by the two business seams below.
   */
  businessTransactionId?: string;
}

// ── P3-AL-32 / P3-AL-55 §I: the two business transaction seams ────────────

/**
 * The scope of one business transaction. Every member is required: the seams
 * set all three as transaction-local GUCs for row level security, and a seam
 * that could be opened without a business would be one whose isolation
 * depended on whatever the connection happened to carry last.
 *
 * GUC scope is row isolation, never authorization (P3-AL-55 §A). Authority
 * travels in the signed assertions each seam takes as its own argument.
 */
export interface BusinessScope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly actorUserId: string;
  /**
   * P3-AL-35: generated once per user operation at the API boundary
   * (`newBusinessTransactionId()`), never derived from anything a client
   * sends. Observability, not authority: the routines write it into the audit
   * metadata of the operation and decide nothing by it.
   */
  readonly businessTransactionId: string;
}

const CANONICAL_TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one thing a seam callback may do with its transaction: run statements
 * in it. It is not a `PoolClient` — it has no `release`, no connection events
 * and nothing a posting port would accept — and it stops working the moment
 * the seam's transaction ends.
 */
export interface TransactionSql {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * The handle of `withBusinessInventoryTransaction` (P3-AL-32 seam 1).
 *
 * It carries NO posting capability, and that is a property of the type: there
 * is no member through which one could be reached, and nothing on it is an
 * `AccountingPostingTransaction`, which is the only thing a posting port
 * accepts. A caller that needs to post cannot acquire the capability from
 * here by argument, flag or cast — it must open the other seam and supply the
 * accounting assertion the posting needs.
 */
export interface BusinessInventoryTransaction extends TransactionSql {
  readonly scope: BusinessScope;
}

/**
 * The handle of `withBusinessInventoryAccountingTransaction` (P3-AL-32 seam
 * 2): the same transaction-bound SQL, plus the transaction-bound posting
 * capability the accounting ports accept.
 */
export interface BusinessInventoryAccountingTransaction extends BusinessInventoryTransaction {
  readonly accounting: AccountingPostingTransaction;
}

/** Stable machine codes of the seams' own refusals. Each is a defect, caught before any domain mutation. */
export type TransactionSeamRefusal =
  | 'seam.inventory_assertion_missing'
  | 'seam.inventory_assertion_malformed'
  | 'seam.inventory_assertion_scope_mismatch'
  | 'seam.inventory_assertion_operation_mismatch'
  | 'seam.inventory_assertion_exhausted'
  | 'seam.inventory_assertion_unused'
  | 'seam.accounting_assertion_missing'
  | 'seam.accounting_assertion_malformed'
  | 'seam.accounting_assertion_scope_mismatch'
  | 'seam.accounting_assertion_source_mismatch'
  | 'seam.accounting_assertion_exhausted'
  | 'seam.accounting_assertion_unused'
  | 'seam.accounting_assertion_sequence_required'
  /** A posting attempted on a transaction that DECLARED it posts nothing (`SeamAccountingAuthority`). */
  | 'seam.accounting_assertion_not_authorized'
  | 'seam.nested_transaction'
  | 'seam.not_a_posting_transaction'
  | 'seam.transaction_closed'
  | 'seam.business_transaction_id_malformed';

export class TransactionSeamError extends Error {
  readonly code: TransactionSeamRefusal;

  constructor(code: TransactionSeamRefusal, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TransactionSeamError';
    this.code = code;
  }
}

/**
 * Which transaction the current async context is inside, if any.
 *
 * Every boundary of this class records itself here for the duration of its
 * callback. A business seam refuses to open inside ANY of them, and no
 * boundary opens inside a business seam: a second connection there would be
 * an independent commit, which is exactly what P3-AL-32 item 6 forbids.
 * Nesting of the Phase 1/2 boundaries among themselves is left exactly as it
 * was accepted.
 */
type OpenTransactionKind = 'boundary' | 'business-seam';
const openTransaction = new AsyncLocalStorage<OpenTransactionKind>();

/**
 * The posting transactions this process has issued and not yet closed, keyed
 * by their opaque capability. A value that is not a key here was not issued by
 * a posting boundary, and the posting ports refuse it (P3-AL-32 matrix row 4).
 */
const postingTransactions = new WeakMap<object, TransactionSql>();

/**
 * The assertion sequence a multi-assertion posting capability presents
 * (R-B1). Only a capability issued by seam 2 for two or more accounting
 * assertions has one; every other capability is today's single-assertion one.
 */
const assertionSequences = new WeakMap<object, AccountingAssertionSequence>();

/** SQL bound to one open transaction, revoked when the transaction ends. */
function bindTransactionSql(client: PoolClient): { sql: TransactionSql; close: () => void } {
  let open = true;
  const sql: TransactionSql = Object.freeze({
    query: async <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> => {
      if (!open) throw new TransactionSeamError('seam.transaction_closed', 'this transaction has already ended');
      return client.query<R>(text, params);
    },
  });
  return { sql, close: () => (open = false) };
}

/**
 * Issue a posting capability for an open transaction. Only the two posting
 * boundaries of `Database` call this, and only after they have set
 * `app.accounting_assertion` on that transaction.
 */
function issuePostingTransaction(sql: TransactionSql, sequence: AccountingAssertionSequence | null = null): AccountingPostingTransaction {
  // The brand is declared-only (packages/accounting/src/ports.ts), so no
  // object can carry it structurally; this frozen, prototype-less object is
  // one only because it is registered below, which the ports check.
  const tx = Object.freeze(Object.create(null) as object) as AccountingPostingTransaction;
  postingTransactions.set(tx, sql);
  if (sequence !== null) assertionSequences.set(tx, sequence);
  return tx;
}

/**
 * The seams' application-side coherence check (P3-AL-32 item 4). STRUCTURE
 * only: the tenant and business claims are read with the packages' split
 * functions and never verified here — verification is the database's
 * (P3-AL-55 §G), and this check exists so a defect fails before a connection
 * is taken, not instead of the database's step 9.
 */
function assertInventoryAssertionCoheres(scope: BusinessScope, inventoryAssertion: unknown): { assertion: string; operation: string } {
  if (typeof scope.businessTransactionId !== 'string' || !CANONICAL_TRACE_ID.test(scope.businessTransactionId)) {
    throw new TransactionSeamError(
      'seam.business_transaction_id_malformed',
      'a business seam needs the canonical business transaction id of its operation (P3-AL-35)',
    );
  }
  if (typeof inventoryAssertion !== 'string' || inventoryAssertion.length === 0) {
    throw new TransactionSeamError('seam.inventory_assertion_missing', 'a business seam cannot be opened without an inventory assertion');
  }
  let parts: { tenantId: string; businessId: string; wireOperation: string };
  try {
    parts = splitInventoryAssertion(inventoryAssertion);
  } catch {
    // The split's own refusal carries nothing a caller needs beyond this code,
    // and it must not be allowed to echo any part of the assertion.
    throw new TransactionSeamError('seam.inventory_assertion_malformed', 'the inventory assertion is not an invctl/1 assertion');
  }
  if (parts.tenantId !== scope.tenantId || parts.businessId !== scope.businessId) {
    throw new TransactionSeamError('seam.inventory_assertion_scope_mismatch', "the inventory assertion's tenant/business claims differ from the seam's scope");
  }
  // Component 6 carries the operation code with `.` written as `:` (invctl/1).
  return { assertion: inventoryAssertion, operation: parts.wireOperation.replaceAll(':', '.') };
}

/**
 * Seam 2's inventory authority (PHASE_3_S6_CONTRACT A-19): one invctl/1
 * assertion per entry routine the operation calls, in call order. A bare
 * string (or a one-element tuple) is exactly the seam as it was before.
 */
export type InventoryAssertions = string | readonly [string, ...string[]];

/** What `InventoryAssertionSequence.plan` decides for one seam-2 transaction. */
export interface InventoryAssertionPlan {
  /** `app.inventory_assertion` at `BEGIN`: the single assertion, or empty for a sequence. */
  readonly guc: string;
  /** The sequence of two or more assertions, or null for the single-assertion seam. */
  readonly sequence: InventoryAssertionSequence | null;
  /** The operation claim of the single assertion, or null for a sequence. */
  readonly singleOperation: string | null;
}

/**
 * A-19: the ordered inventory assertions of one seam-2 transaction, each
 * presented for exactly one entry routine — the sibling of R-B1's
 * `AccountingAssertionSequence`.
 *
 * Pure state, no I/O, so its rules are testable without a database:
 * - `next` hands out the next assertion only for the routine whose operation
 *   code equals that assertion's operation claim
 *   (`seam.inventory_assertion_operation_mismatch`), and never more
 *   assertions than there are (`seam.inventory_assertion_exhausted`);
 * - `assertComplete` is STRICT: a commit that left any assertion unpresented
 *   is refused `seam.inventory_assertion_unused`. Unlike a posting, every
 *   entry routine consumes its assertion even on replay, so presenting fewer
 *   than all is never legitimate.
 *
 * Why swapping `app.inventory_assertion` inside one transaction is safe: it is
 * read only by `inventory_assertion_current`, which only the helpers INSIDE an
 * entry routine call; no deferred guard reads it (A-19).
 */
export class InventoryAssertionSequence {
  private presented = 0;

  private constructor(
    private readonly assertions: readonly string[],
    private readonly operations: readonly string[],
  ) {}

  /**
   * Coherence-check every element against `scope` (before any connection is
   * taken) and build the sequence. A string or a one-element tuple is the
   * single-assertion seam (`sequence: null`, `guc` = the assertion); two or
   * more have a sequence, and the transaction starts with the GUC EMPTY, so a
   * routine that was not presented its assertion is refused by the database
   * (`inventory.assertion_missing` / `inventory.assertion_wrong_operation`).
   * A duplicate element is `seam.inventory_assertion_malformed`; an empty
   * tuple is `seam.inventory_assertion_missing`.
   */
  static plan(scope: BusinessScope, inventoryAssertions: InventoryAssertions): InventoryAssertionPlan {
    const list: readonly unknown[] = Array.isArray(inventoryAssertions) ? inventoryAssertions : [inventoryAssertions];
    if (list.length === 0) {
      throw new TransactionSeamError('seam.inventory_assertion_missing', 'a business seam cannot be opened without an inventory assertion');
    }
    const assertions: string[] = [];
    const operations: string[] = [];
    for (const raw of list) {
      const { assertion, operation } = assertInventoryAssertionCoheres(scope, raw);
      if (assertions.includes(assertion)) {
        throw new TransactionSeamError('seam.inventory_assertion_malformed', 'each inventory assertion authorizes one routine call and may appear only once');
      }
      assertions.push(assertion);
      operations.push(operation);
    }
    const [first, ...rest] = assertions;
    const [firstOperation] = operations;
    if (first !== undefined && firstOperation !== undefined && rest.length === 0) return { guc: first, sequence: null, singleOperation: firstOperation };
    return { guc: '', sequence: new InventoryAssertionSequence(assertions, operations), singleOperation: null };
  }

  /** The assertion for the next routine call, refusing an operation that is not its claim, or a call beyond the last. */
  next(opCode: string): string {
    const i = this.presented;
    const assertion = this.assertions[i];
    const operation = this.operations[i];
    if (assertion === undefined || operation === undefined) {
      throw new TransactionSeamError('seam.inventory_assertion_exhausted', 'every inventory assertion of this transaction has already been presented');
    }
    if (opCode !== operation) {
      throw new TransactionSeamError(
        'seam.inventory_assertion_operation_mismatch',
        "the routine's operation differs from the claim of the next inventory assertion",
      );
    }
    this.presented = i + 1;
    return assertion;
  }

  /** Refuse a commit that left any inventory assertion unpresented. */
  assertComplete(): void {
    if (this.presented < this.assertions.length) {
      throw new TransactionSeamError(
        'seam.inventory_assertion_unused',
        `${this.assertions.length - this.presented} inventory assertion(s) of this transaction were never presented`,
      );
    }
  }
}

/**
 * The inventory authority of each seam-2 handle: its transaction-bound SQL,
 * and either the sequence it presents or the operation claim of its single
 * assertion (already set at `BEGIN`).
 */
interface InventoryAuthority {
  readonly sql: TransactionSql;
  readonly plan: InventoryAssertionPlan;
}
const inventoryAuthorities = new WeakMap<object, InventoryAuthority>();

/**
 * A-19: set `app.inventory_assertion`, transaction-locally, to the next
 * assertion of `tx`'s sequence, for ONE call of the entry routine of
 * `opCode`. Call it immediately before that routine.
 *
 * On a single-assertion handle the GUC was set at `BEGIN`, and this only
 * checks that `opCode` is that assertion's claim. It refuses anything that is
 * not a seam-2 handle (`seam.inventory_assertion_missing`); a handle whose
 * transaction has ended cannot set the GUC (`seam.transaction_closed`).
 */
export async function presentInventoryAssertion(tx: BusinessInventoryAccountingTransaction, opCode: string): Promise<void> {
  const authority = typeof tx === 'object' && tx !== null ? inventoryAuthorities.get(tx) : undefined;
  if (authority === undefined) {
    throw new TransactionSeamError(
      'seam.inventory_assertion_missing',
      'only a handle of withBusinessInventoryAccountingTransaction presents inventory assertions',
    );
  }
  const { sequence, singleOperation } = authority.plan;
  if (sequence === null) {
    if (singleOperation !== opCode) {
      throw new TransactionSeamError(
        'seam.inventory_assertion_operation_mismatch',
        "the routine's operation differs from the claim of the inventory assertion",
      );
    }
    return;
  }
  const assertion = sequence.next(opCode);
  await authority.sql.query(`SELECT set_config('app.inventory_assertion', $1, true)`, [assertion]);
}

/** The source claims of one accounting assertion (claims 7 and 8). */
export interface AccountingAssertionSource {
  readonly sourceType: string;
  readonly sourceId: string;
}

function accountingAssertionParts(scope: BusinessScope, accountingAssertion: unknown): readonly string[] {
  if (typeof accountingAssertion !== 'string' || accountingAssertion.length === 0) {
    throw new TransactionSeamError('seam.accounting_assertion_missing', 'the accounting seam cannot be opened without an accounting assertion');
  }
  let parts: readonly string[];
  try {
    parts = splitAccountingAssertion(accountingAssertion);
  } catch {
    throw new TransactionSeamError('seam.accounting_assertion_malformed', 'the accounting assertion is not a posting assertion');
  }
  // v1.<kid>.<actor>.<tenant>.<business>.… (packages/accounting/src/assertion.ts)
  if (parts[3] !== scope.tenantId || parts[4] !== scope.businessId) {
    throw new TransactionSeamError(
      'seam.accounting_assertion_scope_mismatch',
      "the accounting assertion's tenant/business claims differ from the seam's scope",
    );
  }
  return parts;
}

/**
 * Seam 2's accounting authority (P3-AL-32 item 2 as amended by R-B1): one
 * assertion per posting the operation implies, in posting order. A bare
 * string is the single-element form, exactly today's seam.
 */
export type AccountingAssertions = string | readonly [string, ...string[]];

/**
 * Seam 2's accounting authority, DECLARED (P4-S2; docs/PHASE_4_S2_CONTRACT.md
 * A-09).
 *
 * The problem this type solves. `AccountingAssertions` is a non-empty type and
 * `plan` refuses an empty list (`seam.accounting_assertion_missing`), so a
 * command that needs the seam's ATOMICITY but posts NOTHING had only two ways
 * out: mint a signed assertion it never presents and rely for ever on
 * `assertComplete`'s permissive "presented none" branch, or split its commit.
 * The first is a fake authority nothing declares; the second is what the
 * atomic sale law forbids. A draft sale and a draft invoice are exactly this
 * case — `invoices_binding_owed_ck` (`0075:301`) makes a draft owe no binding
 * — and so is any future command whose only writes are inventory's.
 *
 * So the capability is carried in the TYPE: a caller either states the
 * postings it is authorized for, or states that it posts nothing. Under
 * `no_posting` the transaction's `app.accounting_assertion` starts and stays
 * empty and presenting ANY posting is refused, so "posts nothing" is enforced
 * rather than described.
 *
 * It is additive on purpose: a bare string and a tuple remain exactly today's
 * seam, so no existing caller changes. **The permissive "presented none"
 * branch of `assertComplete` is deliberately NOT tightened here** — see A-09
 * of the contract. `tests/integration/purchase-s4-seam.test.ts:207` asserts
 * that behaviour as a LAW ("presenting none commits (the replay case, A-08)"),
 * because a replay is discovered INSIDE the transaction, after the seam was
 * opened by a caller that could not know it would be one. Tightening it needs
 * a way for the callback itself to declare the replay, which changes an
 * accepted P3 contract and is a Tech Lead decision rather than this slice's.
 */
export type SeamAccountingAuthority = { readonly kind: 'postings'; readonly assertions: AccountingAssertions } | { readonly kind: 'no_posting' };

/** True for the declared form, so the seam can keep accepting today's bare assertions. */
function isSeamAccountingAuthority(value: AccountingAssertions | SeamAccountingAuthority): value is SeamAccountingAuthority {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value;
}

/**
 * R-B1: the ordered accounting assertions of one seam-2 transaction, each
 * presented for exactly one posting.
 *
 * Pure state, no I/O, so its rules are testable without a database:
 * - `next` hands out the next assertion only for a posting whose
 *   `(sourceType, sourceId)` equals that assertion's claims, and never more
 *   assertions than there are;
 * - `assertComplete` refuses a commit that presented some but not all of
 *   them. Presenting none is a commit that posted nothing — a replay inside
 *   the routine, whose minted assertions expire unused (contract A-08) — and
 *   is today's behaviour of the single-assertion seam.
 */
export class AccountingAssertionSequence {
  private presented = 0;

  private constructor(
    private readonly assertions: readonly string[],
    private readonly sources: readonly AccountingAssertionSource[],
    /** `no_posting` is a DECLARATION that this transaction posts nothing; see `SeamAccountingAuthority`. */
    private readonly kind: 'postings' | 'no_posting' = 'postings',
  ) {}

  /**
   * Coherence-check every element against `scope` (before any connection is
   * taken) and build the sequence. A string or a one-element tuple is today's
   * seam and has no sequence (`sequence: null`, `guc` = the assertion); two or
   * more assertions have one, and the transaction starts with the GUC empty so
   * nothing can post that was not presented.
   */
  static plan(
    scope: BusinessScope,
    accountingAssertions: AccountingAssertions | SeamAccountingAuthority,
  ): { guc: string; sequence: AccountingAssertionSequence | null } {
    if (isSeamAccountingAuthority(accountingAssertions)) {
      // A declared no-posting transaction: no authority, an empty GUC, and a
      // sequence whose only job is to refuse a posting that is attempted
      // anyway. It is NOT `sequence: null`, because `null` is the
      // single-authority path and would let a posting through.
      if (accountingAssertions.kind === 'no_posting') return { guc: '', sequence: new AccountingAssertionSequence([], [], 'no_posting') };
      return AccountingAssertionSequence.plan(scope, accountingAssertions.assertions);
    }
    const list: readonly unknown[] = Array.isArray(accountingAssertions) ? accountingAssertions : [accountingAssertions];
    if (list.length === 0) {
      throw new TransactionSeamError('seam.accounting_assertion_missing', 'the accounting seam cannot be opened without an accounting assertion');
    }
    const assertions: string[] = [];
    const sources: AccountingAssertionSource[] = [];
    for (const raw of list) {
      const parts = accountingAssertionParts(scope, raw);
      const assertion = parts.join('.');
      if (assertions.includes(assertion)) {
        throw new TransactionSeamError('seam.accounting_assertion_malformed', 'each accounting assertion authorizes one posting and may appear only once');
      }
      assertions.push(assertion);
      sources.push({ sourceType: parts[6] ?? '', sourceId: parts[7] ?? '' });
    }
    const [first, ...rest] = assertions;
    if (first !== undefined && rest.length === 0) return { guc: first, sequence: null };
    return { guc: '', sequence: new AccountingAssertionSequence(assertions, sources) };
  }

  /** The assertion for the next posting, refusing a source that is not its claim, or a posting beyond the last. */
  next(source: AccountingAssertionSource): string {
    if (this.kind === 'no_posting') {
      throw new TransactionSeamError(
        'seam.accounting_assertion_not_authorized',
        'this transaction declared that it posts nothing: it carries no accounting authority to present',
      );
    }
    const i = this.presented;
    const assertion = this.assertions[i];
    const claims = this.sources[i];
    if (assertion === undefined || claims === undefined) {
      throw new TransactionSeamError('seam.accounting_assertion_exhausted', 'every accounting assertion of this transaction has already been presented');
    }
    if (source.sourceType !== claims.sourceType || source.sourceId !== claims.sourceId) {
      throw new TransactionSeamError(
        'seam.accounting_assertion_source_mismatch',
        "the posting's source differs from the claims of the next accounting assertion",
      );
    }
    this.presented = i + 1;
    return assertion;
  }

  /** Refuse a commit that left an assertion unpresented after presenting any. */
  assertComplete(): void {
    if (this.kind === 'no_posting') return;
    if (this.presented > 0 && this.presented < this.assertions.length) {
      throw new TransactionSeamError(
        'seam.accounting_assertion_unused',
        `${this.assertions.length - this.presented} accounting assertion(s) of this transaction were never presented`,
      );
    }
  }
}

/**
 * Database access layer (§36). Raw SQL via pg — chosen for correctness over
 * convenience (ADR-011): RLS, composite FKs, partial indexes, SELECT FOR
 * UPDATE and explicit transactions are all first-class.
 *
 * EXPLICIT BOUNDARIES (Final Closure Directive §5–9): there is NO generic
 * `bypass` flag any service can pass. Each boundary is a typed method with
 * its own pool and DB role:
 * - withTransaction / scoped  → daftar_app    (merchant runtime, RLS-enforced)
 * - withResolverTransaction   → daftar_resolver (membership resolution only)
 * - withIdentityTransaction   → daftar_identity (auth/session runtime ONLY — WAVE 2)
 * - withPlatformTransaction   → daftar_platform (provisioning + super-admin ops)
 * - withWorkerTransaction     → daftar_worker  (outbox relay)
 * A merchant service CANNOT accidentally use platform privileges.
 *
 * RLS pool safety (§38): scope is applied with set_config(..., true) —
 * TRANSACTION-LOCAL. A pooled connection returned to the pool carries no
 * stale context; without scope the app role sees zero rows (default-deny).
 */
@Injectable()
export class Database implements OnModuleDestroy, OnModuleInit {
  private readonly pool: Pool | null;
  private readonly platformPool: Pool | null;
  private readonly identityPool: Pool | null;
  private readonly resolverPool: Pool | null;
  private readonly workerPool: Pool | null;
  private readonly provisionerPool: Pool | null;
  private readonly reconcilerPool: Pool | null;

  private readonly expectedPrincipals: [Pool | null, string][] = [];
  private readonly provisioningKey: ProvisioningAssertionKey | null;

  constructor(@Inject('APP_CONFIG') private readonly config: AppConfig) {
    // §XXV–XXXI + Directive §16–18: a process opens pools ONLY for the
    // authority of its PROCESS_MODE. A URL that is present but outside the
    // mode's authority is ignored; a pool that does not exist cannot be
    // reached ("role pool is not configured") — never a silent fallback.
    //   merchant-api: app + identity + resolver + provisioner
    //   platform-api: platform + identity
    //   worker:       worker only
    //   reconciler:   reconciler only (P2-S8 §30)
    //   all:          everything (dev/test; production rejects this mode)
    const mode = config.PROCESS_MODE;
    this.provisioningKey = parseProvisioningAssertionKey(config);
    const owns = {
      app: mode === 'all' || mode === 'merchant-api',
      platform: mode === 'all' || mode === 'platform-api',
      identity: mode !== 'worker' && mode !== 'reconciler',
      resolver: mode === 'all' || mode === 'merchant-api',
      worker: mode === 'all' || mode === 'worker',
      provisioner: mode === 'all' || mode === 'merchant-api',
      reconciler: mode === 'all' || mode === 'reconciler',
    };
    // Dev/test convenience ONLY for the single-process mode: a missing role
    // URL falls back to the app URL. Separated runtimes never fall back.
    const fallback = mode === 'all' && !config.isProd ? config.APP_DATABASE_URL : undefined;
    const open = (owned: boolean, url: string | undefined, max: number): Pool | null => (owned && url ? new Pool({ connectionString: url, max }) : null);
    this.pool = open(owns.app, config.APP_DATABASE_URL, 10);
    this.platformPool = open(owns.platform, config.PLATFORM_DATABASE_URL ?? fallback, 4);
    this.identityPool = open(owns.identity, config.IDENTITY_DATABASE_URL ?? (mode === 'all' ? config.PLATFORM_DATABASE_URL : undefined) ?? fallback, 4);
    this.resolverPool = open(owns.resolver, config.RESOLVER_DATABASE_URL ?? fallback, 4);
    this.workerPool = open(owns.worker, config.WORKER_DATABASE_URL ?? fallback, 2);
    this.provisionerPool = open(owns.provisioner, config.PROVISIONER_DATABASE_URL ?? fallback, 2);
    // P2-S8 §30: NO fallback, in any mode. Reconciliation authority is either
    // configured explicitly as its own principal or it does not exist — a
    // reconciler quietly running as `daftar_app` would read the ledger with a
    // credential that can also write it, which is the whole thing this slice
    // is built to prevent.
    this.reconcilerPool = open(owns.reconciler, config.RECONCILER_DATABASE_URL, 2);
    // §32/§XXX startup verification: every explicitly-configured pool must be
    // authenticated as its intended DB role — per deployment mode, only the
    // pools this process actually owns are verified.
    if (config.isProd && this.pool) this.expectedPrincipals.push([this.pool, 'daftar_app']);
    if (this.platformPool && config.PLATFORM_DATABASE_URL) this.expectedPrincipals.push([this.platformPool, 'daftar_platform']);
    if (this.identityPool && config.IDENTITY_DATABASE_URL) this.expectedPrincipals.push([this.identityPool, 'daftar_identity']);
    if (this.resolverPool && config.RESOLVER_DATABASE_URL) this.expectedPrincipals.push([this.resolverPool, 'daftar_resolver']);
    if (this.workerPool && config.WORKER_DATABASE_URL) this.expectedPrincipals.push([this.workerPool, 'daftar_worker']);
    if (this.provisionerPool && config.PROVISIONER_DATABASE_URL) this.expectedPrincipals.push([this.provisionerPool, 'daftar_provisioner']);
    // Verified in EVERY environment, unlike the app pool: the reconciler's
    // whole safety argument is "this connection is daftar_reconciler, whose
    // grants are read-only", and an unverified pool would make that argument
    // about the intention rather than about the connection.
    if (this.reconcilerPool) this.expectedPrincipals.push([this.reconcilerPool, 'daftar_reconciler']);
  }

  /** §32: fail startup on principal mismatch — SELECT current_user per pool. */
  async onModuleInit(): Promise<void> {
    for (const [pool, expected] of this.expectedPrincipals) {
      if (!pool) throw new Error(`database pool for role ${expected} is not configured`);
      const { rows } = await pool.query<{ current_user: string }>('SELECT current_user');
      const actual = rows[0]?.current_user;
      if (actual !== expected) {
        throw new Error(
          `DB principal mismatch: expected role "${expected}", connected as "${actual}". ` +
            'Refusing to start — each runtime boundary must use its own database role (§30–32).',
        );
      }
    }
  }

  private async applyScope(client: PoolClient, scope: Scope, bypass: boolean): Promise<void> {
    await client.query(
      `SELECT
      set_config('app.tenant_id', $1, true),
      set_config('app.business_id', $2, true),
      set_config('app.bypass_rls', $3, true),
      set_config('app.actor_user_id', $4, true),
      set_config('app.provisioning_assertion', $5, true),
      set_config('app.accounting_assertion', $6, true),
      set_config('app.accounting_control_assertion', $7, true),
      set_config('app.inventory_assertion', $8, true),
      set_config('app.business_transaction_id', $9, true)`,
      [
        scope.tenantId ?? '',
        scope.businessId ?? '',
        bypass ? 'true' : 'false',
        scope.actorUserId ?? '',
        scope.provisioningAssertion ?? '',
        scope.accountingAssertion ?? '',
        scope.accountingControlAssertion ?? '',
        scope.inventoryAssertion ?? '',
        scope.businessTransactionId ?? '',
      ],
    );
  }

  private async run<T>(pool: Pool | null, scope: Scope, bypass: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transact(pool, scope, bypass, 'boundary', fn);
  }

  /**
   * The one place a transaction begins and ends: one `BEGIN`, the scope, the
   * callback, one `COMMIT` — or one `ROLLBACK`.
   */
  private async transact<T>(pool: Pool | null, scope: Scope, bypass: boolean, kind: OpenTransactionKind, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (openTransaction.getStore() === 'business-seam') {
      throw new TransactionSeamError('seam.nested_transaction', 'no transaction may be opened inside a business seam (it would commit independently)');
    }
    if (!pool) throw new Error('database role pool is not configured');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyScope(client, scope, bypass);
      const result = await openTransaction.run(kind, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The body shared by both business seams: refuse nesting, open ONE
   * transaction on the app pool with the scope GUCs and the carriers, hand the
   * callback a handle built for it, and revoke that handle when the
   * transaction ends, whichever way it ends.
   */
  private async businessSeam<H, T>(
    scope: BusinessScope,
    carriers: Pick<Scope, 'inventoryAssertion' | 'accountingAssertion'>,
    handleFor: (sql: TransactionSql, scope: BusinessScope) => H,
    fn: (handle: H) => Promise<T>,
    beforeCommit: () => void = () => undefined,
  ): Promise<T> {
    const gucs: Scope = {
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      actorUserId: scope.actorUserId,
      businessTransactionId: scope.businessTransactionId,
      ...carriers,
    };
    const frozenScope: BusinessScope = Object.freeze({
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      actorUserId: scope.actorUserId,
      businessTransactionId: scope.businessTransactionId,
    });
    return this.transact(this.pool, gucs, false, 'business-seam', async (client) => {
      const bound = bindTransactionSql(client);
      try {
        const result = await fn(Object.freeze(handleFor(bound.sql, frozenScope)));
        beforeCommit();
        return result;
      } finally {
        bound.close();
      }
    });
  }

  private refuseNestedSeam(): void {
    if (openTransaction.getStore() !== undefined) {
      throw new TransactionSeamError('seam.nested_transaction', 'a business seam cannot be opened inside another transaction (P3-AL-32 item 6)');
    }
  }

  /**
   * P3-AL-32 seam 1 — an inventory mutation that posts NO journal (a
   * same-business transfer; the three P3-S1 commands).
   *
   * `BEGIN`s once on the app pool as `daftar_app`, sets `app.tenant_id`,
   * `app.business_id`, `app.actor_user_id` and the carrier
   * `app.inventory_assertion`, leaves `app.accounting_assertion` empty, runs
   * `fn`, `COMMIT`s once. Before any connection is taken it refuses a missing
   * or structurally impossible inventory assertion, one whose tenant/business
   * claims differ from `scope`, and an attempt to open it inside any other
   * transaction.
   *
   * The handle carries no posting capability (see `BusinessInventoryTransaction`).
   */
  async withBusinessInventoryTransaction<T>(
    scope: BusinessScope,
    inventoryAssertion: string,
    fn: (tx: BusinessInventoryTransaction) => Promise<T>,
  ): Promise<T> {
    this.refuseNestedSeam();
    assertInventoryAssertionCoheres(scope, inventoryAssertion);
    return this.businessSeam(scope, { inventoryAssertion }, (sql, bound): BusinessInventoryTransaction => ({ scope: bound, query: sql.query }), fn);
  }

  /**
   * P3-AL-32 seam 2 — a financial inventory operation: the domain mutation
   * AND the posting its success implies, in one transaction.
   *
   * Everything seam 1 does, plus `app.accounting_assertion`, and the handle
   * exposes the transaction-bound posting capability the accounting ports'
   * `…InTransaction` variants accept. The inventory assertion authorizes the
   * domain command, the accounting assertion authorizes the posting (P3-AL-33);
   * neither stands in for the other, and both must cohere with `scope` before
   * a connection is taken.
   *
   * R-B1: `accountingAssertions` is one assertion per posting the operation
   * implies, in posting order. A string (or a one-element tuple) is exactly
   * today's seam: `app.accounting_assertion` is set at `BEGIN`. With two or
   * more, EVERY element is coherence-checked here, the GUC starts empty, and
   * the posting capability presents them one per posting through
   * `presentAccountingAssertion` (the posting adapter does this before each
   * `postEntryInTransaction`); a commit that presented some but not all is
   * refused `seam.accounting_assertion_unused` and rolls back.
   *
   * A-19 (PHASE_3_S6_CONTRACT): `inventoryAssertions` is likewise one
   * assertion per entry routine the operation calls, in call order. A string
   * (or a one-element tuple) is exactly the seam as before. With two or more,
   * every element is coherence-checked here, `app.inventory_assertion` starts
   * EMPTY, the callback presents each through `presentInventoryAssertion`
   * immediately before its routine, and a commit that left any unpresented is
   * refused `seam.inventory_assertion_unused` and rolls back.
   */
  async withBusinessInventoryAccountingTransaction<T>(
    scope: BusinessScope,
    inventoryAssertions: InventoryAssertions,
    accountingAssertions: AccountingAssertions | SeamAccountingAuthority,
    fn: (tx: BusinessInventoryAccountingTransaction) => Promise<T>,
  ): Promise<T> {
    this.refuseNestedSeam();
    const inventory = InventoryAssertionSequence.plan(scope, inventoryAssertions);
    const { guc, sequence } = AccountingAssertionSequence.plan(scope, accountingAssertions);
    return this.businessSeam(
      scope,
      { inventoryAssertion: inventory.guc, accountingAssertion: guc },
      (sql, bound): BusinessInventoryAccountingTransaction => {
        const handle: BusinessInventoryAccountingTransaction = { scope: bound, query: sql.query, accounting: issuePostingTransaction(sql, sequence) };
        inventoryAuthorities.set(handle, { sql, plan: inventory });
        return handle;
      },
      fn,
      () => {
        inventory.sequence?.assertComplete();
        sequence?.assertComplete();
      },
    );
  }

  /**
   * The accounting ports' only way into a posting transaction.
   *
   * Refuses — at runtime, in addition to the type — any value this process
   * did not issue from a posting boundary: a raw client, the non-posting
   * seam's handle, a look-alike object. And it refuses a capability whose
   * transaction has ended, so a handle that escaped its callback is inert.
   */
  postingTransactionSql(tx: AccountingPostingTransaction): TransactionSql {
    const sql = this.issuedPostingSql(tx);
    if (assertionSequences.has(tx)) {
      // A multi-assertion capability has no single authority to post under:
      // each posting must present its own assertion (R-B1).
      throw new TransactionSeamError(
        'seam.accounting_assertion_sequence_required',
        'a transaction carrying several accounting assertions posts only through presentAccountingAssertion',
      );
    }
    return sql;
  }

  /**
   * R-B1: the posting adapter's way into a posting transaction, for ONE
   * posting of `source`.
   *
   * On today's single-assertion capability it is exactly
   * `postingTransactionSql`. On a multi-assertion capability it takes the
   * next assertion — refusing a source that differs from its claims
   * (`seam.accounting_assertion_source_mismatch`) or a posting beyond the last
   * (`seam.accounting_assertion_exhausted`) — and sets it as
   * `app.accounting_assertion`, transaction-locally, for this posting.
   */
  async presentAccountingAssertion(tx: AccountingPostingTransaction, source: AccountingAssertionSource): Promise<TransactionSql> {
    const sql = this.issuedPostingSql(tx);
    const sequence = assertionSequences.get(tx);
    if (sequence === undefined) return sql;
    const assertion = sequence.next(source);
    await sql.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    return sql;
  }

  private issuedPostingSql(tx: AccountingPostingTransaction): TransactionSql {
    const sql = typeof tx === 'object' && tx !== null ? postingTransactions.get(tx) : undefined;
    if (!sql) {
      throw new TransactionSeamError('seam.not_a_posting_transaction', 'the accounting posting port accepts only a transaction opened by a posting boundary');
    }
    return sql;
  }

  /** Merchant runtime: RLS-enforced business/tenant scope, daftar_app role. */
  async withTransaction<T>(scope: Scope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.pool, scope, false, fn);
  }

  /** Scoped single query (auto transaction for RLS locality). */
  async scoped<T extends QueryResultRow>(scope: Scope, text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.withTransaction(scope, (c) => c.query<T>(text, params));
  }

  /** Membership resolution boundary: daftar_resolver — narrow read-only role. */
  async withResolverTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.resolverPool, {}, false, fn);
  }

  /**
   * Identity boundary (WAVE 2): auth runtime ONLY — users, sessions, refresh
   * lineage, password reset tokens — as the daftar_identity principal. It has
   * NO grants on plans/flags/overrides/catalog/businesses and does NOT bypass
   * RLS (its access comes from dedicated identity_access policies).
   */
  async withIdentityTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.identityPool, {}, false, fn);
  }

  /** Platform admin boundary: plans/flags/overrides/platform roles (daftar_platform). */
  async withPlatformTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.platformPool, {}, true, fn);
  }

  /** Worker boundary: outbox relay (daftar_worker — own policy, no bypass). */
  async withWorkerTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.workerPool, {}, false, fn);
  }

  /**
   * Reconciliation ENUMERATION boundary (P2-S8 §11, §30): `daftar_reconciler`,
   * with NO business scope and NO bypass.
   *
   * There is nothing this connection can read without a scope except the one
   * SECURITY DEFINER enumerator `0051` grants it, which returns two identifier
   * columns and nothing else. `daftar_reconciler` is not exempt from row level
   * security — since `0032` the only principal that is, is `daftar_platform` —
   * so a statement that tried to read the journal here would come back empty,
   * and the caller is written to treat "cannot enumerate" as an outcome of its
   * own rather than as a clean book.
   */
  async withReconcilerTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.reconcilerPool, {}, false, fn);
  }

  /**
   * Reconciliation READ boundary (P2-S8 §11, §20): `daftar_reconciler`, scoped
   * to one business, with NO bypass.
   *
   * The role holds column-level SELECT on six tables and holds no DML anywhere,
   * so a reconciliation pass physically cannot write financial truth however it
   * is called (§18). Scoping each business separately adds the second property:
   * a check that forgot its `business_id` predicate still cannot read across
   * the boundary, because row level security refuses the rows. The scope is set
   * TRANSACTION-LOCAL, so a pooled connection carries none of it to the next
   * business.
   */
  async withReconcilerBusinessTransaction<T>(tenantId: string, businessId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.reconcilerPool, { tenantId, businessId }, false, fn);
  }

  /**
   * Provisioning boundary (Stabilization §13–14): daftar_provisioner — the
   * ONLY authority for initial onboarding, additional business creation and
   * invitation acceptance. NO bypass and NO table CRUD (0032): its only
   * authority is EXECUTE on narrow SECURITY DEFINER commands that verify the
   * server-derived actor's authority INSIDE the same command (0033).
   */
  async withProvisionerTransaction<T>(actorUserId: string | null, kind: ProvisioningKind | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    // Blocker 1: the actor travels as a server-MINTED assertion (HMAC over
    // actor + operation kind + expiry + jti) that provision_actor() verifies
    // against a key no runtime role can read. A caller-settable GUC is never
    // trusted. `null` = no actor: only actor-independent lookups (invitation
    // peek / expire) may run; every mutating command raises PROV:FORBIDDEN.
    if (actorUserId === null || kind === null) return this.run(this.provisionerPool, {}, true, fn);
    if (!this.provisioningKey) {
      throw new Error('PROVISIONING_ASSERTION_KEY is not configured — provisioning requires a server-minted actor assertion');
    }
    const provisioningAssertion = mintProvisioningAssertion(this.provisioningKey, actorUserId, kind);
    return this.run(this.provisionerPool, { provisioningAssertion }, true, fn);
  }

  /**
   * Accounting posting boundary (P2-S3): the merchant runtime role, carrying a
   * server-minted accounting command assertion.
   *
   * It runs on the APP pool because `daftar_app` is the one runtime role that
   * may execute `accounting_post_entry` — and the role holds no journal DML of
   * its own, so this boundary can call the primitive and nothing else. The
   * isolation GUCs are left empty on purpose: every identity the primitive
   * uses comes from the verified assertion, and setting them here would
   * suggest they are load-bearing when they are not.
   */
  async withAccountingTransaction<T>(accountingAssertion: string, fn: (tx: AccountingPostingTransaction) => Promise<T>): Promise<T> {
    // P3-AL-32 item 5: the callback receives the same opaque posting
    // capability the accounting-aware seam issues, so the accepted
    // single-operation methods run through exactly the code path the Phase 3
    // composition uses.
    return this.run(this.pool, { accountingAssertion }, false, async (client) => {
      const bound = bindTransactionSql(client);
      try {
        return await fn(issuePostingTransaction(bound.sql));
      } finally {
        bound.close();
      }
    });
  }

  /**
   * Accounting CONFIGURATION boundary (P2-S5): the same merchant runtime
   * role, carrying a server-minted `acctctl/1` CONTROL assertion.
   *
   * Separate from the posting boundary on purpose. The posting assertion is
   * not set here and the control assertion is not set there, so neither
   * command can be driven by the other's authority even if the two formats
   * were somehow confusable — which §30 requires them not to be anyway.
   */
  async withAccountingControlTransaction<T>(accountingControlAssertion: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run(this.pool, { accountingControlAssertion }, false, fn);
  }

  /** Names of the pools this process actually opened (boot-test evidence, §20). */
  ownedPools(): string[] {
    return (
      [
        ['app', this.pool],
        ['platform', this.platformPool],
        ['identity', this.identityPool],
        ['resolver', this.resolverPool],
        ['worker', this.workerPool],
        ['provisioner', this.provisionerPool],
      ] as const
    )
      .filter(([, p]) => p !== null)
      .map(([n]) => n);
  }

  async healthCheck(): Promise<boolean> {
    // Per-mode: check every pool this process actually owns.
    const pools = [this.pool, this.platformPool, this.identityPool, this.resolverPool, this.workerPool, this.provisionerPool].filter(
      (x): x is Pool => x !== null,
    );
    if (pools.length === 0) return false;
    try {
      for (const p of pools) await p.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    await Promise.all([
      this.platformPool?.end(),
      this.identityPool?.end(),
      this.resolverPool?.end(),
      this.workerPool?.end(),
      this.provisionerPool?.end(),
      this.reconcilerPool?.end(),
    ]);
  }

  /** Nest lifecycle: pools die with the app — no connection leaks across tests/reloads. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
