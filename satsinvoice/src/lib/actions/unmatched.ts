"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { btcRateUsdToCents } from "@/lib/money";
import { applyProviderEvent } from "@/lib/payments/apply";
import { PrismaPaymentStore } from "@/lib/payments/prisma-store";
import { requireUser } from "@/lib/session";

export interface ActionState {
  error?: string;
  message?: string;
}

async function openItem(unmatchedId: string) {
  const user = await requireUser();
  const item = await prisma.unmatchedPayment.findFirst({
    where: { id: unmatchedId, OR: [{ userId: user.id }, { userId: null }] },
  });
  if (!item) throw new Error("Unmatched payment not found");
  if (item.resolution !== "open") {
    return { user, item, alreadyResolved: true as const };
  }
  return { user, item, alreadyResolved: false as const };
}

function refresh() {
  revalidatePath("/unmatched");
  revalidatePath("/invoices");
}

/**
 * Apply a parked payment to an invoice the freelancer picks.
 *
 * This runs through the same `applyProviderEvent` path a webhook does, with a
 * synthetic payment id derived from the unmatched row. That means the normal
 * rules still apply (a settled invoice will not be paid twice, an expired one
 * still records the money as late) and applying twice is a no-op.
 */
export async function applyToInvoiceAction(
  unmatchedId: string,
  invoiceId: string,
): Promise<ActionState> {
  const { user, item, alreadyResolved } = await openItem(unmatchedId);
  if (alreadyResolved) return { error: "That payment has already been resolved." };

  const target = await prisma.invoice.findFirst({ where: { id: invoiceId, userId: user.id } });
  if (!target) return { error: "Invoice not found." };
  if (!target.providerInvoiceId) {
    return { error: "That invoice was never registered with the payment provider." };
  }

  const result = await applyProviderEvent(
    {
      type: "payment.settled",
      providerInvoiceId: target.providerInvoiceId,
      // Stable and unique: re-running this action cannot credit twice.
      providerPaymentId: `applied:${item.id}`,
      amountSats: item.amountSats,
      receivedAt: new Date(),
      raw: {
        source: "unmatched_inbox",
        originalProviderPaymentId: item.providerPaymentId,
        resolvedBy: user.id,
      },
    },
    {
      provider: item.provider,
      fallbackBtcRateUsdCents: btcRateUsdToCents(env.mockBtcUsdRate),
      store: new PrismaPaymentStore(prisma),
    },
  );

  await prisma.unmatchedPayment.update({
    where: { id: item.id },
    data: {
      resolution: "apply_to_invoice",
      appliedToInvoiceId: target.id,
      resolvedAt: new Date(),
    },
  });

  await audit({
    actor: `user:${user.id}`,
    action: "unmatched.applied",
    userId: user.id,
    invoiceId: target.id,
    meta: {
      unmatchedId: item.id,
      amountSats: item.amountSats,
      originalProviderPaymentId: item.providerPaymentId,
      outcome: result.status,
      kind: result.kind,
    },
  });

  refresh();
  revalidatePath(`/invoices/${target.id}`);
  return { message: `Applied to ${target.clientName}: ${result.message}` };
}

export async function markRefundedAction(
  unmatchedId: string,
  note: string,
): Promise<ActionState> {
  const { user, item, alreadyResolved } = await openItem(unmatchedId);
  if (alreadyResolved) return { error: "That payment has already been resolved." };

  await prisma.unmatchedPayment.update({
    where: { id: item.id },
    data: {
      resolution: "refunded",
      resolvedAt: new Date(),
      note: note.trim() ? `${item.note} — refunded: ${note.trim()}`.slice(0, 500) : item.note,
    },
  });

  await audit({
    actor: `user:${user.id}`,
    action: "unmatched.refunded",
    userId: user.id,
    invoiceId: item.invoiceId,
    meta: { unmatchedId: item.id, amountSats: item.amountSats, note },
  });

  refresh();
  return { message: "Marked as refunded. Send the coins from your provider's dashboard." };
}

export async function ignoreAction(unmatchedId: string, note: string): Promise<ActionState> {
  const { user, item, alreadyResolved } = await openItem(unmatchedId);
  if (alreadyResolved) return { error: "That payment has already been resolved." };

  await prisma.unmatchedPayment.update({
    where: { id: item.id },
    data: {
      resolution: "ignored",
      resolvedAt: new Date(),
      note: note.trim() ? `${item.note} — ignored: ${note.trim()}`.slice(0, 500) : item.note,
    },
  });

  await audit({
    actor: `user:${user.id}`,
    action: "unmatched.ignored",
    userId: user.id,
    invoiceId: item.invoiceId,
    meta: { unmatchedId: item.id, amountSats: item.amountSats, note },
  });

  refresh();
  return { message: "Ignored. It stays in the record — nothing is deleted." };
}
