/**
 * Invoice lifecycle: creating one against a provider, and keeping stored
 * invoices honest about expiry.
 */

import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { publicInvoiceId } from "@/lib/ids";
import { sameState, toState, toUpdateData } from "@/lib/invoice-mapper";
import { sweepExpiry } from "@/lib/invoice-state";
import { btcRateUsdToCents } from "@/lib/money";
import { getProvider } from "@/lib/payments";

export const EXPIRY_OPTIONS = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const;

export const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;

export function isValidExpiry(seconds: number): boolean {
  return EXPIRY_OPTIONS.some((o) => o.seconds === seconds);
}

export interface CreateInvoiceInput {
  userId: string;
  clientName: string;
  clientEmail: string | null;
  description: string;
  amountUsdCents: number;
  expirySeconds: number;
  reissuedFromId?: string | null;
}

/**
 * Create an invoice and register it with the payment provider.
 *
 * The row is written first, in `draft`, so the provider call has a stable
 * idempotency key to quote. If the provider call fails the invoice stays
 * `draft` — visible, unpayable, and safe to retry — rather than leaving a
 * charge with nothing pointing at it.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const provider = getProvider();

  const draft = await prisma.invoice.create({
    data: {
      publicId: publicInvoiceId(),
      userId: input.userId,
      clientName: input.clientName,
      clientEmail: input.clientEmail,
      description: input.description,
      amountUsdCents: input.amountUsdCents,
      expirySeconds: input.expirySeconds,
      status: "draft",
      provider: provider.name,
      reissuedFromId: input.reissuedFromId ?? null,
    },
  });

  const created = await provider.createInvoice({
    idempotencyKey: `invoice:${draft.id}`,
    amountUsdCents: input.amountUsdCents,
    memo: `${input.description} — ${input.clientName}`.slice(0, 180),
    expiresInSeconds: input.expirySeconds,
    webhookUrl: `${env.appUrl}/api/webhooks/${provider.name}`,
  });

  const invoice = await prisma.invoice.update({
    where: { id: draft.id },
    data: {
      status: "unpaid",
      providerInvoiceId: created.providerInvoiceId,
      paymentRequest: created.paymentRequest,
      paymentUrl: created.paymentUrl,
      amountSatsExpected: created.amountSats,
      btcRateUsdCents: btcRateUsdToCents(created.btcRateUsd),
      expiresAt: created.expiresAt,
    },
  });

  await audit({
    actor: `user:${input.userId}`,
    action: "invoice.created",
    userId: input.userId,
    invoiceId: invoice.id,
    meta: {
      amountUsdCents: input.amountUsdCents,
      amountSatsExpected: created.amountSats,
      btcRateUsd: created.btcRateUsd,
      provider: provider.name,
      expiresAt: created.expiresAt.toISOString(),
    },
  });

  return invoice;
}

/**
 * Apply the expiry rule on read.
 *
 * v1 has no scheduler. Every path that displays an invoice runs this first, so
 * an expired invoice is never shown as still payable. It is a no-op unless the
 * status actually changes.
 */
export async function withExpirySwept(invoice: Invoice, now = new Date()): Promise<Invoice> {
  const state = toState(invoice);
  const next = sweepExpiry(state, now);
  if (sameState(state, next)) return invoice;

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: toUpdateData(next),
  });

  await audit({
    actor: "system",
    action: "invoice.expired",
    userId: invoice.userId,
    invoiceId: invoice.id,
    meta: { expiresAt: invoice.expiresAt?.toISOString() ?? null },
  });

  return updated;
}

export async function sweepAll(invoices: Invoice[], now = new Date()): Promise<Invoice[]> {
  return Promise.all(invoices.map((invoice) => withExpirySwept(invoice, now)));
}
