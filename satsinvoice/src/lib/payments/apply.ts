/**
 * Applying a provider webhook to the books.
 *
 * Every payment mutation in SatsInvoice funnels through here, and every one of
 * them is idempotent. The guarantee comes from a single unique index on
 * `PaymentEvent.providerPaymentId`, not from bookkeeping in application code:
 *
 *   1. Lock the invoice row (so concurrent webhooks serialise).
 *   2. Try to insert the PaymentEvent. A conflict means we have already
 *      processed this payment — stop, change nothing, record an audit line.
 *   3. Only then move the invoice.
 *
 * Because the insert is the gate and it shares the invoice's transaction, a
 * replayed webhook cannot move money twice even if it arrives mid-flight.
 */

import {
  type IncomingPayment,
  type InvoiceState,
  type PaymentOutcome,
  applyPayment,
  applyPendingNotice,
  canRefund,
  recordRefund,
} from "@/lib/invoice-state";
import { satsToUsdCents } from "@/lib/money";
import type { ProviderEvent } from "./provider";
import type { PaymentStore, PaymentTxn } from "./store";

export type ApplyStatus = "applied" | "duplicate" | "unknown_invoice";

export interface ApplyResult {
  status: ApplyStatus;
  kind: string | null;
  invoiceId: string | null;
  /** Safe to return in an HTTP body — no secrets, no raw payload. */
  message: string;
}

export interface ApplyOptions {
  provider: string;
  /**
   * Rate used to value money that arrived for an invoice we cannot find, so
   * the Unmatched inbox can still show a USD figure.
   */
  fallbackBtcRateUsdCents: number;
  store: PaymentStore;
}

function refundOutcome(state: InvoiceState, receivedAt: Date): PaymentOutcome {
  if (!canRefund(state)) {
    return {
      kind: "unmatched",
      next: { ...state, reviewFlag: true },
      changed: true,
      creditedToInvoice: false,
      unmatched: {
        reason: "invoice_not_payable",
        amountSats: 0,
        note: `Provider reported a refund for a ${state.status} invoice with nothing received.`,
      },
      reason: `refund reported for a ${state.status} invoice; parked for review`,
    };
  }
  return {
    kind: "refund",
    next: recordRefund(state, receivedAt),
    changed: true,
    creditedToInvoice: false,
    unmatched: null,
    reason: "provider reported a refund",
  };
}

function outcomeFor(event: ProviderEvent, state: InvoiceState): PaymentOutcome {
  const payment: IncomingPayment = {
    providerPaymentId: event.providerPaymentId,
    amountSats: event.amountSats,
    receivedAt: event.receivedAt,
  };

  switch (event.type) {
    case "payment.pending":
      return applyPendingNotice(state, payment);
    case "payment.refunded":
      return refundOutcome(state, event.receivedAt);
    case "payment.settled":
      return applyPayment(state, payment);
  }
}

async function handleUnknownInvoice(
  tx: PaymentTxn,
  event: ProviderEvent,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const amountUsdCents = satsToUsdCents(event.amountSats, options.fallbackBtcRateUsdCents);

  const inserted = await tx.insertPaymentEvent({
    invoiceId: null,
    providerPaymentId: event.providerPaymentId,
    provider: options.provider,
    amountSats: event.amountSats,
    amountUsdCents,
    kind: "unmatched",
    rawPayload: event.raw,
    receivedAt: event.receivedAt,
  });

  if (!inserted) {
    await tx.insertAudit({
      actor: `webhook:${options.provider}`,
      action: "webhook.duplicate_ignored",
      userId: null,
      invoiceId: null,
      meta: { providerPaymentId: event.providerPaymentId, type: event.type },
    });
    return {
      status: "duplicate",
      kind: null,
      invoiceId: null,
      message: "Already processed; nothing changed.",
    };
  }

  await tx.insertUnmatched({
    userId: null,
    provider: options.provider,
    providerPaymentId: event.providerPaymentId,
    amountSats: event.amountSats,
    amountUsdCents,
    reason: "unknown_invoice",
    invoiceId: null,
    note: `No invoice matches provider invoice ${event.providerInvoiceId}.`,
  });

  await tx.insertAudit({
    actor: `webhook:${options.provider}`,
    action: "payment.unmatched",
    userId: null,
    invoiceId: null,
    meta: {
      providerPaymentId: event.providerPaymentId,
      providerInvoiceId: event.providerInvoiceId,
      amountSats: event.amountSats,
      reason: "unknown_invoice",
    },
  });

  return {
    status: "unknown_invoice",
    kind: "unmatched",
    invoiceId: null,
    message: "No matching invoice; payment recorded in the unmatched inbox.",
  };
}

export async function applyProviderEvent(
  event: ProviderEvent,
  options: ApplyOptions,
): Promise<ApplyResult> {
  return options.store.transaction(async (tx) => {
    const invoice = await tx.lockInvoiceByProviderInvoiceId(event.providerInvoiceId);
    if (!invoice) return handleUnknownInvoice(tx, event, options);

    const rateCents =
      invoice.state.btcRateUsdCents > 0
        ? invoice.state.btcRateUsdCents
        : options.fallbackBtcRateUsdCents;
    const amountUsdCents = satsToUsdCents(event.amountSats, rateCents);

    const outcome = outcomeFor(event, invoice.state);

    // The idempotency gate. Everything below this line runs at most once per
    // providerPaymentId, for the lifetime of the database.
    const inserted = await tx.insertPaymentEvent({
      invoiceId: invoice.id,
      providerPaymentId: event.providerPaymentId,
      provider: options.provider,
      amountSats: event.amountSats,
      amountUsdCents,
      kind: outcome.kind,
      rawPayload: event.raw,
      receivedAt: event.receivedAt,
    });

    if (!inserted) {
      await tx.insertAudit({
        actor: `webhook:${options.provider}`,
        action: "webhook.duplicate_ignored",
        userId: invoice.userId,
        invoiceId: invoice.id,
        meta: { providerPaymentId: event.providerPaymentId, type: event.type },
      });
      return {
        status: "duplicate" as const,
        kind: null,
        invoiceId: invoice.id,
        message: "Already processed; nothing changed.",
      };
    }

    if (outcome.changed) {
      await tx.updateInvoiceState(invoice.id, outcome.next);
    }

    if (outcome.unmatched) {
      await tx.insertUnmatched({
        userId: invoice.userId,
        provider: options.provider,
        providerPaymentId: event.providerPaymentId,
        amountSats: outcome.unmatched.amountSats,
        amountUsdCents,
        reason: outcome.unmatched.reason,
        invoiceId: invoice.id,
        note: outcome.unmatched.note,
      });
    }

    await tx.insertAudit({
      actor: `webhook:${options.provider}`,
      action: `payment.${outcome.kind}`,
      userId: invoice.userId,
      invoiceId: invoice.id,
      meta: {
        providerPaymentId: event.providerPaymentId,
        type: event.type,
        amountSats: event.amountSats,
        amountUsdCents,
        from: invoice.state.status,
        to: outcome.next.status,
        reason: outcome.reason,
      },
    });

    return {
      status: "applied" as const,
      kind: outcome.kind,
      invoiceId: invoice.id,
      message: outcome.reason,
    };
  });
}
