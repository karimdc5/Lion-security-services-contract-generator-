/**
 * The invoice state machine.
 *
 * This module is PURE: no Prisma, no I/O, no `new Date()` without it being
 * passed in. Every money decision the app makes lives here so it can be tested
 * exhaustively without a database.
 *
 * The rules it encodes, in the order they are checked:
 *
 *  1. A draft or canceled invoice can never absorb money. It goes to the
 *     Unmatched Payments inbox.
 *  2. An already-settled invoice never gets marked paid twice. A second
 *     payment goes to the inbox.
 *  3. Money that arrives after `expiresAt` is LATE. It is credited to the
 *     invoice so it is visible, the invoice is flagged for review, and it also
 *     lands in the inbox. It is never silently treated as an on-time payment.
 *  4. Otherwise the payment settles: short -> `underpaid`, exact -> `paid`,
 *     over -> `paid` plus a recorded overpay.
 *
 * Note on `overpaid`: the enum keeps the value for forward compatibility, but
 * the machine deliberately marks an overpaid invoice `paid` and records
 * `overpaySats` / `overpayUsdCents`. The invoice IS paid; the surplus is a
 * separate fact the freelancer has to decide about.
 */

import { satsToUsdCents } from "./money";

export const INVOICE_STATUSES = [
  "draft",
  "unpaid",
  "pending",
  "paid",
  "underpaid",
  "overpaid",
  "expired",
  "canceled",
  "refunded",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_EVENT_KINDS = [
  "settled",
  "late",
  "duplicate",
  "unmatched",
  "refund",
  "pending",
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export const UNMATCHED_REASONS = [
  "late_payment",
  "duplicate_invoice_payment",
  "invoice_not_payable",
  "unknown_invoice",
] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

/** Statuses that can still absorb an on-time payment. */
export const OPEN_STATUSES: readonly InvoiceStatus[] = ["unpaid", "pending", "underpaid"];

/** Statuses where the invoice is already considered settled. */
export const SETTLED_STATUSES: readonly InvoiceStatus[] = ["paid", "overpaid", "refunded"];

/** The subset of an invoice the state machine reasons about. */
export interface InvoiceState {
  status: InvoiceStatus;
  expiresAt: Date | null;
  amountUsdCents: number;
  btcRateUsdCents: number;
  amountSatsExpected: number;
  amountSatsReceived: number;
  overpaySats: number;
  overpayUsdCents: number;
  paidAt: Date | null;
  writtenOff: boolean;
  reviewFlag: boolean;
}

export interface IncomingPayment {
  providerPaymentId: string;
  amountSats: number;
  receivedAt: Date;
}

export interface UnmatchedIntent {
  reason: UnmatchedReason;
  amountSats: number;
  note: string;
}

export interface PaymentOutcome {
  /** The kind to record on the PaymentEvent row. */
  kind: PaymentEventKind;
  /** The full next state. The input is never mutated. */
  next: InvoiceState;
  /** True when `next` differs from the state passed in. */
  changed: boolean;
  /** Set when the money must also surface in the Unmatched Payments inbox. */
  unmatched: UnmatchedIntent | null;
  /** Whether the sats counted toward this invoice's received total. */
  creditedToInvoice: boolean;
  /** Human-readable explanation, written to the audit log and the timeline. */
  reason: string;
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

export function isExpiredAt(state: Pick<InvoiceState, "expiresAt">, now: Date): boolean {
  return state.expiresAt !== null && now.getTime() >= state.expiresAt.getTime();
}

/** Sats still owed. Zero once the expected amount has been covered. */
export function remainingSats(state: InvoiceState): number {
  return Math.max(0, state.amountSatsExpected - state.amountSatsReceived);
}

/** USD cents still owed, at the invoice's frozen rate. */
export function remainingUsdCents(state: InvoiceState): number {
  const sats = remainingSats(state);
  if (sats === 0) return 0;
  if (state.btcRateUsdCents <= 0) return state.amountUsdCents;
  return satsToUsdCents(sats, state.btcRateUsdCents);
}

/** True when the freelancer is done with this invoice, one way or another. */
export function isClosed(state: InvoiceState): boolean {
  if (SETTLED_STATUSES.includes(state.status)) return true;
  if (state.status === "canceled") return true;
  if (state.status === "underpaid" && state.writtenOff) return true;
  return false;
}

/** A short label for the UI and the CSV `kind` column. */
export function displayStatus(state: InvoiceState): string {
  if (state.status === "underpaid" && state.writtenOff) return "written off";
  if (state.status === "paid" && state.overpaySats > 0) return "paid (overpaid)";
  if (state.status === "expired" && state.amountSatsReceived > 0) return "expired (late payment)";
  return state.status;
}

// ---------------------------------------------------------------------------
// Time-driven transition
// ---------------------------------------------------------------------------

/**
 * Rule: unpaid + expiry passed + no payment => expired.
 *
 * An invoice that has already received sats is NOT swept: partial money makes
 * it `underpaid`, and underpaid stays underpaid until it is completed or
 * written off.
 */
export function sweepExpiry(state: InvoiceState, now: Date): InvoiceState {
  if (state.status !== "unpaid" && state.status !== "pending") return state;
  if (!isExpiredAt(state, now)) return state;
  if (state.amountSatsReceived > 0) return state;
  return { ...state, status: "expired" };
}

// ---------------------------------------------------------------------------
// Payment-driven transitions
// ---------------------------------------------------------------------------

/**
 * A provider told us a payment is in flight but not final (e.g. an unconfirmed
 * on-chain transaction). No sats are credited — nothing has settled yet.
 */
export function applyPendingNotice(state: InvoiceState, payment: IncomingPayment): PaymentOutcome {
  const base = {
    kind: "pending" as const,
    unmatched: null,
    creditedToInvoice: false,
  };

  if (state.status === "unpaid" && !isExpiredAt(state, payment.receivedAt)) {
    return {
      ...base,
      next: { ...state, status: "pending" },
      changed: true,
      reason: "provider reported an in-flight payment; awaiting settlement",
    };
  }

  return {
    ...base,
    next: state,
    changed: false,
    reason: `in-flight notice ignored for a ${state.status} invoice; nothing settled`,
  };
}

/**
 * Apply a SETTLED payment to an invoice.
 *
 * Callers must guarantee idempotency before calling this — the same
 * `providerPaymentId` must never reach this function twice. See
 * `src/lib/payments/apply.ts`.
 */
export function applyPayment(state: InvoiceState, payment: IncomingPayment): PaymentOutcome {
  if (!Number.isInteger(payment.amountSats) || payment.amountSats <= 0) {
    throw new TransitionError(
      `applyPayment: amountSats must be a positive integer, got ${payment.amountSats}`,
    );
  }

  // 1. This invoice can never absorb money.
  if (state.status === "draft" || state.status === "canceled") {
    return {
      kind: "unmatched",
      next: { ...state, reviewFlag: true },
      changed: true,
      creditedToInvoice: false,
      unmatched: {
        reason: "invoice_not_payable",
        amountSats: payment.amountSats,
        note: `Payment arrived for a ${state.status} invoice.`,
      },
      reason: `invoice is ${state.status}; money parked in the unmatched inbox`,
    };
  }

  // 2. Already settled. Never mark an invoice paid twice — the extra is a
  //    separate decision (apply elsewhere, refund, or ignore).
  if (SETTLED_STATUSES.includes(state.status)) {
    return {
      kind: "unmatched",
      next: { ...state, reviewFlag: true },
      changed: true,
      creditedToInvoice: false,
      unmatched: {
        reason: "duplicate_invoice_payment",
        amountSats: payment.amountSats,
        note: `Second payment for an invoice already marked ${state.status}.`,
      },
      reason: "invoice already settled; extra payment parked in the unmatched inbox",
    };
  }

  // 3. Late money. Credit it so it is visible, flag it, and surface it in the
  //    inbox — but never let it read as an on-time payment.
  const isLate = state.status === "expired" || isExpiredAt(state, payment.receivedAt);
  if (isLate) {
    const amountSatsReceived = state.amountSatsReceived + payment.amountSats;
    const nextStatus: InvoiceStatus =
      state.status === "unpaid" || state.status === "pending" ? "expired" : state.status;
    return {
      kind: "late",
      next: {
        ...state,
        status: nextStatus,
        amountSatsReceived,
        reviewFlag: true,
        // Deliberately NOT paid, and paidAt stays null.
      },
      changed: true,
      creditedToInvoice: true,
      unmatched: {
        reason: "late_payment",
        amountSats: payment.amountSats,
        note: "Payment arrived after the invoice expired.",
      },
      reason: "payment arrived after expiry; recorded as late and flagged for review",
    };
  }

  // 4. On-time settlement.
  const amountSatsReceived = state.amountSatsReceived + payment.amountSats;

  if (amountSatsReceived < state.amountSatsExpected) {
    const next: InvoiceState = { ...state, status: "underpaid", amountSatsReceived };
    return {
      kind: "settled",
      next,
      changed: true,
      creditedToInvoice: true,
      unmatched: null,
      reason: `partial payment; ${remainingSats(next)} sats still owed`,
    };
  }

  const overpaySats = amountSatsReceived - state.amountSatsExpected;
  return {
    kind: "settled",
    next: {
      ...state,
      status: "paid",
      amountSatsReceived,
      paidAt: payment.receivedAt,
      overpaySats,
      overpayUsdCents: overpaySats > 0 ? satsToUsdCents(overpaySats, state.btcRateUsdCents) : 0,
    },
    changed: true,
    creditedToInvoice: true,
    unmatched: null,
    reason: overpaySats > 0 ? `paid with ${overpaySats} sats overpaid` : "paid in full",
  };
}

// ---------------------------------------------------------------------------
// Freelancer-driven transitions
// ---------------------------------------------------------------------------

export function canCancel(state: InvoiceState): boolean {
  return (
    (state.status === "draft" || state.status === "unpaid" || state.status === "pending") &&
    state.amountSatsReceived === 0
  );
}

export function cancelInvoice(state: InvoiceState): InvoiceState {
  if (!canCancel(state)) {
    throw new TransitionError(
      `Cannot cancel an invoice that is ${state.status}${
        state.amountSatsReceived > 0 ? " and has received money" : ""
      }.`,
    );
  }
  return { ...state, status: "canceled" };
}

export function canExpireNow(state: InvoiceState): boolean {
  return state.status === "unpaid" || state.status === "pending";
}

/** "Expire now" pulls the deadline to `now` so later money is treated as late. */
export function expireNow(state: InvoiceState, now: Date): InvoiceState {
  if (!canExpireNow(state)) {
    throw new TransitionError(`Cannot expire an invoice that is ${state.status}.`);
  }
  return { ...state, status: "expired", expiresAt: now };
}

export function canWriteOff(state: InvoiceState): boolean {
  return state.status === "underpaid" && !state.writtenOff;
}

/**
 * The freelancer accepts a short payment and stops chasing it.
 *
 * Status stays `underpaid` on purpose: less money arrived than was invoiced,
 * and the tax export must not claim otherwise. `writtenOff` is what closes it.
 */
export function writeOff(state: InvoiceState): InvoiceState {
  if (!canWriteOff(state)) {
    throw new TransitionError(`Cannot write off an invoice that is ${state.status}.`);
  }
  return { ...state, writtenOff: true };
}

export function canRefund(state: InvoiceState): boolean {
  return state.amountSatsReceived > 0 && state.status !== "refunded";
}

/**
 * Records that a refund was issued. This is bookkeeping only — SatsInvoice
 * never moves coins. The actual send happens in the provider's dashboard (or,
 * later, through `PaymentProvider.refund`).
 */
export function recordRefund(state: InvoiceState, now: Date): InvoiceState {
  if (!canRefund(state)) {
    throw new TransitionError(
      `Cannot refund an invoice that is ${state.status} with ${state.amountSatsReceived} sats received.`,
    );
  }
  return { ...state, status: "refunded", reviewFlag: false, paidAt: state.paidAt ?? now };
}
