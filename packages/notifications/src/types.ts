/**
 * Phase 8 — notification vocabulary (PREPARED / NOT PROMOTED).
 *
 * This package is PURE: no database, no network, no clock, no environment.
 * Everything that touches the outside world is a port (provider, hydrator,
 * money formatter, clock) supplied by the caller. That is what lets Phase 8 be
 * engineered, tested and challenged before its predecessor phases seal.
 *
 * ONE TRUTH (master directive Part 11): notifications NEVER compute money,
 * receivables, stock or settlement. A notification is a READ of canonical
 * truth, rendered for a human. Every figure it shows arrives through the
 * hydrator port as an already-authoritative value; this package only formats.
 */

/** Delivery channels Phase 8 engineers. `inapp` is terminal-local (no provider). */
export type Channel = 'whatsapp' | 'sms' | 'email' | 'inapp';

export const CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email', 'inapp'];

/** The platform's three product locales (mirrors @daftar/domain-core's Locale). */
export type Locale = 'ar' | 'en' | 'tr';

export const LOCALES: readonly Locale[] = ['ar', 'en', 'tr'];

/**
 * Consent class. The distinction is a policy fact, not a cosmetic label:
 *  - `transactional`: a direct consequence of something the recipient did or
 *    owes (an invoice, a receipt, an overdue instalment). Delivered unless the
 *    recipient hard-blocked the channel.
 *  - `operational`: internal merchant-staff signals (daily report, low stock).
 *    Requires the staff member to keep the channel enabled; never marketing.
 *  - `marketing`: requires EXPLICIT opt-in per channel. Silence is a refusal.
 */
export type ConsentClass = 'transactional' | 'operational' | 'marketing';

/** Who a notification is addressed to, and under which business. */
export interface Recipient {
  readonly businessId: string;
  /** Customer id, or staff user id. Exactly one of the two is set. */
  readonly customerId?: string;
  readonly userId?: string;
  readonly locale: Locale;
  /** E.164, digits only with a leading '+'. Validated at the provider edge. */
  readonly phoneE164?: string;
  readonly email?: string;
}

/**
 * A money value as it travels into a template: ALWAYS integer minor units as a
 * decimal string plus its ISO 4217 code. There is no `number` amount anywhere
 * in this package — a float amount cannot even be expressed.
 */
export interface MoneyRef {
  readonly minor: string;
  readonly currency: string;
}

/** Template variable values. Deliberately narrow: no objects, no arrays, no any. */
export type TemplateValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'money'; readonly money: MoneyRef }
  | { readonly kind: 'date'; readonly iso: string }
  | { readonly kind: 'int'; readonly value: number };

export type TemplateVars = Readonly<Record<string, TemplateValue>>;

/** Formats a canonical money value for display. Supplied by the adapter layer. */
export interface MoneyFormatter {
  format(money: MoneyRef, locale: Locale): string;
}

/** Formats an ISO date (yyyy-mm-dd) for display. Supplied by the adapter layer. */
export interface DateFormatter {
  format(iso: string, locale: Locale): string;
}

/** A rendered, channel-ready message. */
export interface RenderedMessage {
  readonly channel: Channel;
  readonly locale: Locale;
  /** Email subject / WhatsApp template name; empty for sms and inapp. */
  readonly subject: string;
  readonly body: string;
  /**
   * For template-only channels (WhatsApp outside the service window) the
   * provider needs the template identity and its ordered parameters, not prose.
   */
  readonly providerTemplate?: {
    readonly name: string;
    readonly locale: Locale;
    readonly parameters: readonly string[];
  };
}
