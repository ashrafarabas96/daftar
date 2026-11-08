/**
 * THE AUDITED ADMINISTRATIVE WRITE-OFF OF A STRANDED CREDIT BALANCE —
 * `DR-97` item 2.
 *
 * ── The situation this exists for ───────────────────────────────────────
 *
 * A credit ledger is scoped to ONE currency, and this slice holds no rate, no
 * expiry and no reversal. A business granted credit in one currency whose
 * subscription then moved to another holds a balance that can never be spent:
 * it cannot be applied to an invoice in another currency, and it cannot be
 * converted, because no rate here was ever authorized and inventing one would
 * be a second financial truth. The origin was closed — a plan change is
 * refused while such a balance exists — and what is left is the balances that
 * are stranded ALREADY, and the ways in that are not a plan change.
 *
 * The owner's ruling splits the way out into two INDEPENDENT commands. This
 * file is one of them, and the other is deliberately absent:
 *
 *   * a cash return is a command of ANOTHER LAYER. `TL-P5-R3` forbids any
 *     path from credit to cash inside `billing`, and a helper here that
 *     merely COMPUTED such an amount would be the first half of that command
 *     living in the wrong place — the second half arrives later as "we
 *     already have the amount". So no such symbol exists in this package.
 *
 *   * THE WRITE-OFF, which is this file: the balance is cancelled where it
 *     already lives, by an order somebody is named for and for a reason
 *     somebody wrote down. Nothing is paid out, nothing is converted, and no
 *     money crosses a currency.
 *
 * ── Why this is a PURE FUNCTION that returns rows it does not write ─────
 *
 * `packages/billing` is a pure core: it holds no SQL, opens no connection,
 * reads no clock and posts nothing. So this command does not persist
 * anything. It returns THE ROWS the caller must append and THE AUDIT RECORD
 * the caller must store, and whoever calls it is the one who commits them —
 * in one transaction, which is also theirs to guarantee. Stating that here is
 * not a disclaimer: a command that returned rows while also writing some of
 * them would have two half-authorities over the same balance.
 *
 * ── The shape in the ledger: `consumption`, by the ruling's own words ───
 *
 * `DR-97` says the write-off is recorded as a `consumption` IN THE LEDGER
 * ITSELF, append-only, with no edit to any existing row. So this module adds
 * no third kind and invents no new table. It writes ONE consumption per grant
 * that still has a remainder, for exactly that remainder, OLDEST GRANT FIRST
 * — because `foldCreditBalance` requires every consumption to name one
 * earlier grant and to stay within that grant's own remainder, and a single
 * row for the whole balance would satisfy neither.
 *
 * ── WHAT IS NOT PROVEN HERE, AND MUST NOT BE READ AS PROVEN ─────────────
 *
 * The card's fifth criterion — the five audit fields measured on a REAL ROW
 * in CI — is OPEN, and it is open on a sealed-logic conflict rather than on
 * missing work:
 *
 *   `0088_p5_billing_platform_credit_ledger.sql:189`
 *   CONSTRAINT pca_consumption_invoice
 *     CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL))
 *
 * Every `consumption` row must name an invoice. A write-off has none — that
 * is what distinguishes it from an application: nothing was billed, a balance
 * was cancelled. The rows this function returns therefore CANNOT BE INSERTED
 * while that CHECK stands, so the five fields have no real row to be measured
 * on and NO PASS is claimed for that criterion anywhere.
 *
 * The four apparent ways out are each forbidden to this card: relaxing the
 * CHECK, adding a third `kind`, and fabricating a synthetic invoice
 * identifier all weaken sealed logic, and a follow-on migration touches money
 * in production. It is an ACCOUNTING question — what a cancelled balance is,
 * in a ledger whose every consumption is an invoice — and it is the owner's,
 * recorded in `OWNER_QUEUE_AR.md`. `test/credit-write-off.test.ts` pins the
 * constraint in an executed case so the gap stays measured.
 *
 * ── The authority vocabulary is BORROWED, and narrowed in the safe direction
 *
 * This package held no actor, issuer, role or permission type at all. The
 * live platform console already has the vocabulary — `AdminService.require`
 * over a capability map — in which `'billing.manage'` is held by
 * `['platform_owner', 'billing_admin']`. This command adopts that capability
 * rather than coining a word, and authorizes `platform_owner` ONLY: a strict
 * subset of the live holders.
 *
 * THE DIRECTION OF THAT NARROWING IS SIGNED, because it is a money decision.
 * Refusing a `billing_admin`'s write-off can only block a legitimate order,
 * which the owner can then issue themselves — recoverable. Allowing one would
 * let a non-owner cancel a customer's money with no reversal in this slice —
 * unrecoverable. The recoverable direction is the one taken. Whether
 * `billing_admin` SHOULD hold this is the owner's call, not this file's, and
 * it is raised rather than decided.
 *
 * And the check here is a GATE ON A STATED AUTHORITY, not a grant of one: a
 * pure function cannot look up a role. The caller must have verified the role
 * against the live map and must pass what it verified; this module refuses
 * anything that is not the one capability and the one role. That limit is
 * written down because an authority check whose input the caller composes is
 * worth exactly what the caller's own check was worth.
 */
import { foldCreditBalance, type CreditAdjustment, type CreditBalance, type CreditLedgerScope } from './credit';
import { refuse } from './errors';

/**
 * The live platform capability a write-off is authorized under. Borrowed from
 * the platform console's own map, never coined here, and the test reads that
 * map and fails if the two ever drift apart.
 */
export const CREDIT_WRITE_OFF_CAPABILITY = 'billing.manage';

/**
 * The platform roles this command accepts — a STRICT SUBSET of the live
 * holders of the capability above. See the header on why the subset, and in
 * which direction it errs.
 */
export const CREDIT_WRITE_OFF_AUTHORIZED_ROLES: readonly string[] = ['platform_owner'];

/**
 * The longest reason the ledger will hold. It is the ledger column's own
 * bound (`pca_reason_present CHECK (length(reason) BETWEEN 1 AND 500)`),
 * restated so a reason that the database would reject is refused HERE, by the
 * named code, rather than at an INSERT the caller has already committed to.
 */
const REASON_MAX_LENGTH = 500;

/**
 * Who issued the order, as the CALLER VERIFIED THEM. Not a claim this module
 * can check against anything: see the header's last paragraph.
 */
export interface PlatformCreditWriteOffIssuer {
  /** The platform user who issued the order. An order nobody signed is not one. */
  readonly userId: string;
  /** The platform role the caller verified, from the live platform role set. */
  readonly platformRole: string;
  /** The capability the caller verified them against. */
  readonly capability: string;
}

export interface PlatformCreditWriteOffCommand {
  readonly issuer: PlatformCreditWriteOffIssuer;
  /** Whose balance, and in which currency. One business, one currency. */
  readonly scope: CreditLedgerScope;
  /**
   * The business's WHOLE ledger, oldest first — every currency it holds. It is
   * taken whole and sliced here rather than pre-filtered by the caller,
   * because a caller that slices is a caller that decides what this command
   * can see.
   */
  readonly ledger: readonly CreditAdjustment[];
  /** Mandatory, and the one thing a reviewer will read first. */
  readonly reason: string;
  /** The instant of the order, ISO-8601. Supplied; never a machine clock. */
  readonly occurredAt: string;
  /** What produced it: the administrative order's own identifier. */
  readonly ref: string;
  /** One identity per row this command will need, in order. */
  readonly consumptionIds: readonly string[];
}

/** The audit record the card requires, as a VALUE for the caller to store. */
export interface PlatformCreditWriteOffAudit {
  /** (1) Who issued it. */
  readonly issuedByUserId: string;
  /** (2) Why. */
  readonly reason: string;
  /** (3) How much was cancelled, in exact minor units. */
  readonly amountMinor: bigint;
  /** (4) In which currency. */
  readonly currency: string;
  /**
   * (5) Which balance. A balance has no row of its own — it IS the pair
   * (business, currency), and the currency is the field above.
   */
  readonly targetBusinessId: string;
  /**
   * The grants actually cancelled, oldest first. Not one of the five; it is
   * here so the order can be audited AGAINST ROWS and not only against a
   * total.
   */
  readonly targetGrantIds: readonly string[];
}

export interface PlatformCreditWriteOff {
  /** The consumption rows to APPEND. The caller writes them; this does not. */
  readonly rows: readonly CreditAdjustment[];
  readonly audit: PlatformCreditWriteOffAudit;
  readonly balanceBeforeMinor: bigint;
  /** Zero, by construction, and asserted through the authority before return. */
  readonly balanceAfterMinor: bigint;
  /** The authority's own reading of the resulting ledger slice. */
  readonly balanceAfter: CreditBalance;
}

/**
 * Cancel a stranded credit balance in one currency, by an audited order.
 *
 * Total and deterministic. Refuses rather than doing nothing: a command that
 * is silent about having had nothing to do hides the defect that sent it.
 */
export function writeOffPlatformCreditBalance(command: PlatformCreditWriteOffCommand): PlatformCreditWriteOff {
  if (command === null || typeof command !== 'object') {
    refuse('billing.payload_invalid', 'a credit write-off is a command, and one must be supplied');
  }

  // ── The authority, FIRST ─────────────────────────────────────────────
  // Before the payload, so a malformed command from an unauthorized issuer is
  // reported as the authority failure it is. The reverse order would tell an
  // unauthorized caller which of their fields to fix.
  const issuer = command.issuer;
  if (issuer === null || typeof issuer !== 'object') {
    refuse('billing.credit_write_off_unauthorized', 'a credit write-off must name who issued it');
  }
  if (typeof issuer.userId !== 'string' || issuer.userId.trim().length === 0) {
    refuse('billing.credit_write_off_unauthorized', 'a credit write-off must name the platform user who issued it');
  }
  if (issuer.capability !== CREDIT_WRITE_OFF_CAPABILITY) {
    refuse('billing.credit_write_off_unauthorized', 'a credit write-off is authorized under one platform capability only');
  }
  if (typeof issuer.platformRole !== 'string' || !CREDIT_WRITE_OFF_AUTHORIZED_ROLES.includes(issuer.platformRole)) {
    // Narrower than the capability's live holder set, on purpose, and in the
    // recoverable direction. See the header.
    refuse('billing.credit_write_off_unauthorized', 'this platform role may not cancel a credit balance');
  }

  // ── The reason, and the LIVE code for its absence ────────────────────
  // `billing.credit_reason_required` already exists and already means exactly
  // this, so it is reused. A second code with the same meaning would make the
  // vocabulary say there are two rules where there is one.
  if (typeof command.reason !== 'string' || command.reason.trim().length === 0 || command.reason.trim().length > REASON_MAX_LENGTH) {
    refuse('billing.credit_reason_required', 'a credit write-off must state why the balance is being cancelled');
  }

  // ── The rest of the payload ──────────────────────────────────────────
  const scope = command.scope;
  if (scope === null || typeof scope !== 'object') {
    refuse('billing.payload_invalid', 'a credit write-off must name the balance it cancels');
  }
  const currency = scope.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    refuse('billing.payload_invalid', 'a credit write-off names its currency as a three-letter code');
  }
  if (typeof scope.businessId !== 'string' || scope.businessId.trim().length === 0) {
    refuse('billing.payload_invalid', 'a credit write-off belongs to exactly one business, which must be named');
  }
  if (typeof command.occurredAt !== 'string' || command.occurredAt.trim().length === 0) {
    refuse('billing.payload_invalid', 'a credit write-off must carry the instant it was ordered', { businessId: scope.businessId, currency });
  }
  if (typeof command.ref !== 'string' || command.ref.trim().length === 0) {
    refuse('billing.payload_invalid', 'a credit write-off must say which order produced it', { businessId: scope.businessId, currency });
  }
  if (!Array.isArray(command.ledger as unknown)) {
    refuse('billing.payload_invalid', 'a credit write-off reads a ledger, which must be a list of adjustments', {
      businessId: scope.businessId,
      currency,
    });
  }
  if (!Array.isArray(command.consumptionIds as unknown)) {
    refuse('billing.payload_invalid', 'a credit write-off needs the identities its rows will carry', { businessId: scope.businessId, currency });
  }

  // ── Slicing the ledger to ONE currency ───────────────────────────────
  // The same law `plan-change.ts` had to learn: a row whose currency cannot be
  // read is a defect that REFUSES, never a row to pass over. Reading it as
  // "not my currency" and skipping it is the unsafe direction — it would
  // leave a balance uncancelled and report a zero that looks correct.
  for (const row of command.ledger) {
    const rowCurrency = row?.currency;
    if (typeof rowCurrency !== 'string' || !/^[A-Z]{3}$/.test(rowCurrency)) {
      refuse('billing.payload_invalid', 'a row of the credit ledger carries no readable currency, and such a row may not be passed over', {
        businessId: scope.businessId,
        currency,
      });
    }
  }
  const slice = command.ledger.filter((row) => row.currency === currency);

  // The balance authority is CONSULTED, never re-implemented. Every ledger
  // rule — one business, append-only order, per-grant remainders, replay — is
  // enforced by this call and is not restated here.
  const before = foldCreditBalance(slice, { businessId: scope.businessId, currency });

  if (before.balanceMinor === 0n) {
    // A command with nothing to do REFUSES. Succeeding silently over no
    // balance would hide the defect that sent it — the wrong currency, the
    // wrong business, or a balance somebody already cancelled.
    refuse('billing.credit_write_off_no_balance', 'there is no unspent credit in this currency to cancel', {
      businessId: scope.businessId,
      currency,
    });
  }

  // ── The rows: one per grant with a remainder, OLDEST FIRST ───────────
  // `before.grants` is in ledger order, which the authority has already
  // verified is oldest-first — so there is no sort here, and there could not
  // be: a sort would silently repair an order the authority would refuse.
  const rows: CreditAdjustment[] = [];
  const targetGrantIds: string[] = [];
  let idAt = 0;
  for (const grant of before.grants) {
    if (grant.remainingMinor === 0n) continue; // exhausted; no zero-value row
    const id = command.consumptionIds[idAt];
    if (typeof id !== 'string' || id.trim().length === 0) {
      refuse('billing.credit_application_ids_exhausted', 'the caller supplied too few identities for the rows this write-off needs', {
        businessId: before.businessId,
        currency: before.currency,
      });
    }
    idAt++;
    rows.push({
      id,
      businessId: before.businessId,
      kind: 'consumption',
      amountMinor: grant.remainingMinor,
      currency: before.currency,
      occurredAt: command.occurredAt,
      ref: command.ref,
      reason: command.reason,
      appliesToGrantId: grant.grantId,
    });
    targetGrantIds.push(grant.grantId);
  }

  // ── Conservation, as an ABSOLUTE value ───────────────────────────────
  // The rows must sum to the balance that existed. This is not an identity
  // between two figures computed the same way: `rowSum` comes from the rows
  // themselves and `before.balanceMinor` from the authority's own fold.
  let rowSum = 0n;
  for (const row of rows) {
    if (row.amountMinor <= 0n) {
      refuse('billing.invariant_violated', 'a credit write-off may not write a zero-value row', {
        invariant: 'no_zero_value_rows',
        currency: before.currency,
      });
    }
    rowSum += row.amountMinor;
  }
  if (rowSum !== before.balanceMinor) {
    refuse('billing.invariant_violated', 'the write-off rows do not sum to the balance being cancelled', {
      invariant: 'rows_sum_to_balance',
      currency: before.currency,
    });
  }

  // ── The authority side ───────────────────────────────────────────────
  // The rows are handed back to the authority that will later read them,
  // APPENDED to the slice they were derived from. This is what catches rows
  // that balance but are not valid — an out-of-order instant among them, a
  // replayed identity, a grant drawn past its own remainder.
  const after = foldCreditBalance([...slice, ...rows], { businessId: scope.businessId, currency });
  if (after.balanceMinor !== 0n) {
    refuse('billing.invariant_violated', 'the ledger with these rows appended does not fold to a zero balance', {
      invariant: 'write_off_leaves_zero_balance',
      currency: before.currency,
    });
  }

  return {
    rows,
    audit: {
      issuedByUserId: issuer.userId,
      reason: command.reason,
      amountMinor: rowSum,
      currency: before.currency,
      targetBusinessId: before.businessId,
      targetGrantIds,
    },
    balanceBeforeMinor: before.balanceMinor,
    balanceAfterMinor: after.balanceMinor,
    balanceAfter: after,
  };
}
