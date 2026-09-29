/**
 * Payment methods — P3-S6 (PHASE_3_S6_CONTRACT A-06, A-18).
 *
 * A payment method names HOW money moves (cash, card, a bank transfer…) and
 * the asset account it moves through. It is shared infrastructure: S6 supplier
 * payments and refunds use it, and later phases will too.
 *
 * - The method id is chosen by the client as a canonical LOWERCASE uuid and is
 *   the idempotency key of the create command.
 * - A revision is a small integer counter and travels as a JSON number.
 * - A method is never deleted. `systemType` is immutable; the posting account
 *   changes only while no payment or refund names the method
 *   (`payment_method.posting_account_locked`, 409).
 * - Names: at least one of `ar`, `en`, `tr`, each 1..100 characters with no
 *   leading or trailing space. A missing locale falls back in the reader,
 *   never in storage.
 * - Refusals carry their stable `payment_method.*` code in `error.details`.
 */

/** The general accounting behaviour of a method (DM §13). Immutable once created. */
export type PaymentMethodSystemTypeDto = 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'cheque' | 'other';

/** The display names of a method; an omitted or null locale has no name. */
export interface PaymentMethodNamesDto {
  ar?: string | null;
  en?: string | null;
  tr?: string | null;
}

/**
 * `POST /v1/payment-methods` — requires `accounting.chart.manage`. 201 on
 * create, 200 on replay.
 */
export interface PaymentMethodCreateRequestDto {
  paymentMethodId: string;
  systemType: PaymentMethodSystemTypeDto;
  /** An active asset account of this business that is a settlement account (A-06). */
  postingAccountId: string;
  requiresReference: boolean;
  /** 0..10000. */
  sortOrder: number;
  names: PaymentMethodNamesDto;
}

/** `PUT /v1/payment-methods/:paymentMethodId` — requires `accounting.chart.manage`. States the whole method. */
export interface PaymentMethodUpdateRequestDto {
  /** The revision the client read; a moved revision is `payment_method.revision_changed` (409). */
  expectedRevision: number;
  postingAccountId: string;
  requiresReference: boolean;
  sortOrder: number;
  names: PaymentMethodNamesDto;
}

/** `POST /v1/payment-methods/:paymentMethodId/deactivate` and `/activate` — require `accounting.chart.manage`. */
export interface PaymentMethodLifecycleRequestDto {
  expectedRevision: number;
}

/**
 * A payment method as stored: `GET /v1/payment-methods` (each item) and
 * `GET /v1/payment-methods/:paymentMethodId`, requiring `suppliers.pay`,
 * `accounting.view` or `accounting.chart.manage`. `postingAccountId` is
 * present only for a reader holding `accounting.view` or
 * `accounting.chart.manage`.
 */
export interface PaymentMethodDto {
  paymentMethodId: string;
  systemType: PaymentMethodSystemTypeDto;
  postingAccountId?: string;
  isActive: boolean;
  requiresReference: boolean;
  sortOrder: number;
  names: { ar: string | null; en: string | null; tr: string | null };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** The answer of every payment-method command — always read from the stored row. */
export interface PaymentMethodCommandResultDto extends PaymentMethodDto {
  /** True when this is the stored result of an earlier identical command. */
  replayed: boolean;
  /** The trace id of the operation that last changed the method. */
  businessTransactionId: string;
}
