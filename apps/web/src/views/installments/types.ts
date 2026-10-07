/**
 * P4-S7 — THE VIEW MODELS of the schedule and the debts screens.
 *
 * Maturity level D: the surface a merchant sees, written against the API
 * CONTRACT and independent of the schema that does not exist yet. A view below
 * takes a model and renders it; nothing here fetches, and nothing computes a
 * figure.
 *
 * ── WHY THESE MODELS CARRY NO ARITHMETIC ────────────────────────────────
 *
 * Every figure is a string of minor units that came off the API, which got it
 * from the ONE settlement figure. The screen does not add them up, does not
 * subtract one from another and does not decide a status: `status` arrives
 * derived from the `asOf` the screen SENT, which is why `asOf` is on the model
 * as well as on the request. A screen that recomputed a status would be a
 * second derivation at a second grain, disagreeing with the server exactly at
 * a date boundary.
 *
 * ── THE `asOf` IS THE SCREEN'S, AND IT IS EXPLICIT ──────────────────────
 *
 * `asOf` is a REQUIRED field of every model. The screen shows it, so a
 * merchant looking at "3 instalments overdue" can see which day that is true
 * of, and a support engineer can reproduce the screen. A screen that showed a
 * status without its date would be a screen nobody can check — and a screen
 * that defaulted the date from the browser's clock would make two merchants in
 * two time zones disagree about the same debt.
 */

/** A merchant-facing instalment row. Every figure is minor units as text; nothing is a number. */
export interface InstallmentRowModel {
  readonly seqNo: number;
  readonly dueDate: string;
  readonly amountMinor: string;
  readonly settledMinor: string;
  readonly remainingMinor: string;
  readonly status: 'settled' | 'overdue' | 'due_today' | 'upcoming';
  readonly daysPastDue: number;
}

/** One plan as a screen sees it. `outstandingMinor` is the server's one figure, echoed and never recomputed. */
export interface InstallmentPlanModel {
  readonly planId: string;
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly customerName: string;
  readonly currency: string;
  readonly asOf: string;
  readonly startDate: string;
  readonly totalMinor: string;
  readonly downPaymentMinor: string;
  readonly downPaymentSettledMinor: string;
  readonly outstandingMinor: string;
  readonly overdueMinor: string;
  readonly status: 'settled' | 'overdue' | 'on_track';
  readonly nextDueDate: string | null;
  readonly lifecycle: 'active' | 'cancelled';
  readonly installments: readonly InstallmentRowModel[];
}

/** One open debt of a customer, with its plan when it has one. */
export interface DebtRowModel {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly totalMinor: string;
  readonly outstandingMinor: string;
  readonly planId: string | null;
  readonly planStatus: 'settled' | 'overdue' | 'on_track' | null;
  readonly nextDueDate: string | null;
  readonly daysPastDue: number | null;
}
