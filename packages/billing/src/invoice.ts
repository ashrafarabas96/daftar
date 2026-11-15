/**
 * Subscription invoice composition — the platform's own invoice, assembled
 * from lines whose amounts other modules computed.
 *
 * ── What this is not ────────────────────────────────────────────────────
 *
 * This is NOT a sales invoice. `invoices` / `invoice_items` (`0075`) are the
 * merchant's documents to the merchant's customers, and Phase 4 owns their
 * numbering, their settlement and their accounting. The platform charging a
 * merchant for a plan is a different document with a different debtor, and
 * conflating the two would put platform revenue inside a tenant's AR.
 *
 * ── The three laws ──────────────────────────────────────────────────────
 *
 * 1. The total is the EXACT sum of the lines. Not a figure a caller may
 *    supply, not a figure recomputed by a second rule. A client-supplied
 *    total is never authoritative anywhere in this project, and the surest
 *    way to keep that true is for the type to have no field for one.
 *
 * 2. Tax is a STRUCTURAL ZERO and a non-zero tax is REFUSED. `OD-03` settled
 *    this for the merchant's sales tax in Phase 4. Nothing has settled tax on
 *    the PLATFORM's invoices — a different jurisdiction question with a
 *    different answer — so this slice refuses rather than guessing a rate,
 *    normalizing a non-zero value to zero, or accepting one and ignoring it.
 *    Refusing is the only one of those three a reviewer can detect.
 *
 * 3. A negative total is REFUSED. Net credit is a real outcome of a
 *    downgrade, and the document that expresses it is a credit note, not an
 *    invoice with a minus sign. Which of the two a downgrade produces is a
 *    commercial policy nobody has set, so this module refuses the shape
 *    instead of inventing the document. `proratePlanChange` still returns the
 *    negative net, so the information is not lost — only the pretence that an
 *    invoice can carry it.
 */
import { refuse } from './errors';
import { MAX_BILLING_MINOR } from './types';

export const SUBSCRIPTION_LINE_KINDS = ['plan', 'addon', 'proration_charge', 'proration_credit', 'adjustment'] as const;
export type SubscriptionLineKind = (typeof SUBSCRIPTION_LINE_KINDS)[number];

/**
 * The kinds whose amount is a CREDIT — a reduction of what is owed. Their
 * `amountMinor` is supplied positive, like every other line's, and this module
 * applies the sign. A caller that had to pass `-1200n` for a credit would be
 * one missing minus sign away from charging for it.
 */
const CREDIT_KINDS: ReadonlySet<SubscriptionLineKind> = new Set<SubscriptionLineKind>(['proration_credit']);

export interface SubscriptionInvoiceLine {
  readonly kind: SubscriptionLineKind;
  /** What the line is about: a plan key, an add-on key. An identifier. */
  readonly ref: string;
  /** Always POSITIVE. The kind decides the sign. */
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Human text for the merchant. Never a place for a machine decision. */
  readonly memo?: string;
}

export interface SubscriptionInvoiceInput {
  readonly lines: readonly SubscriptionInvoiceLine[];
  /**
   * Present only so a caller that computed a tax can be REFUSED rather than
   * have it silently dropped. Omitted and `0n` are the supported values.
   */
  readonly taxMinor?: bigint;
}

export interface ComposedSubscriptionInvoice {
  readonly currency: string;
  readonly chargeMinor: bigint;
  readonly creditMinor: bigint;
  readonly subtotalMinor: bigint;
  /** Always `0n`. Structural, not a default a caller can change. */
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly lines: readonly SubscriptionInvoiceLine[];
}

export function composeSubscriptionInvoice(input: SubscriptionInvoiceInput): ComposedSubscriptionInvoice {
  // Typed before it is validated, deliberately: `Array.isArray` widens its
  // argument to `any[]`, and a validated-but-untyped list is how every field
  // below would become an unchecked `any` access.
  const lines: readonly SubscriptionInvoiceLine[] = input?.lines ?? [];
  if (!Array.isArray(input?.lines) || lines.length === 0) {
    refuse('billing.invoice_empty', 'a subscription invoice with no lines is not a document');
  }
  if (input.taxMinor !== undefined && input.taxMinor !== 0n) {
    refuse('billing.subscription_tax_unsupported', 'tax on a platform subscription invoice is an unsettled policy and is refused, not normalized');
  }

  const currency = lines[0]?.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    refuse('billing.invoice_currency_mismatch', 'a subscription invoice must state a three-letter currency', { lineNo: 1 });
  }

  let chargeMinor = 0n;
  let creditMinor = 0n;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (!line) refuse('billing.payload_invalid', 'a subscription invoice line may not be absent', { lineNo });
    if (!(SUBSCRIPTION_LINE_KINDS as readonly string[]).includes(line.kind)) {
      refuse('billing.payload_invalid', 'a subscription invoice line must carry a known kind', { lineNo });
    }
    if (typeof line.ref !== 'string' || line.ref.trim().length === 0) {
      refuse('billing.payload_invalid', 'a subscription invoice line must say what it is about', { lineNo });
    }
    if (line.currency !== currency) {
      refuse('billing.invoice_currency_mismatch', 'every line of one subscription invoice carries one currency', { lineNo, currency });
    }
    if (typeof line.amountMinor !== 'bigint') {
      refuse('billing.payload_invalid', 'a subscription invoice amount must be an exact integer of minor units', { lineNo });
    }
    if (line.amountMinor < 0n) {
      // A negative amount on a line would be a second way to express a
      // credit, and two ways to express one fact is how a sign gets lost.
      refuse('billing.payload_invalid', 'a line amount is positive; the line kind carries the direction', { lineNo });
    }
    if (line.amountMinor === 0n) {
      refuse('billing.invoice_line_zero', 'a zero line bills nothing and explains nothing; omit it', { lineNo });
    }
    if (line.amountMinor > MAX_BILLING_MINOR) {
      refuse('billing.payload_invalid', 'a line amount exceeds the money cap', { lineNo, currency });
    }
    if (CREDIT_KINDS.has(line.kind)) creditMinor += line.amountMinor;
    else chargeMinor += line.amountMinor;
  }

  const subtotalMinor = chargeMinor - creditMinor;
  if (subtotalMinor < 0n) {
    refuse('billing.invoice_total_negative', 'net credit is a credit note, not an invoice with a minus sign', { currency });
  }
  const totalMinor = subtotalMinor;
  if (totalMinor > MAX_BILLING_MINOR) {
    refuse('billing.payload_invalid', 'the invoice total exceeds the money cap', { currency });
  }

  // The law of this module, asserted rather than trusted: the total is the
  // exact sum of the lines, recomputed independently of the accumulation
  // above. An accumulator and its own result are not two witnesses, so the
  // check walks the lines again.
  let witness = 0n;
  for (const line of lines) {
    witness += CREDIT_KINDS.has(line.kind) ? -line.amountMinor : line.amountMinor;
  }
  if (witness !== totalMinor) {
    refuse('billing.invariant_violated', 'the composed total is not the exact sum of its lines', { invariant: 'total_is_sum_of_lines', currency });
  }

  return { currency, chargeMinor, creditMinor, subtotalMinor, taxMinor: 0n, totalMinor, lines: [...lines] };
}
