"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { createInvoice } from "@/lib/invoices";

/**
 * "Generate a new invoice" on an expired public page.
 *
 * Only offered when the freelancer turned auto-reissue on. It is a public,
 * unauthenticated action, so it is deliberately narrow: it only ever clones an
 * expired invoice that received nothing, and only once per expired invoice.
 */
export async function reissueInvoiceAction(publicId: string): Promise<void> {
  const original = await prisma.invoice.findUnique({
    where: { publicId },
    include: { user: true },
  });

  if (!original) throw new Error("Invoice not found");
  if (!original.user.autoReissue) throw new Error("Auto-reissue is not enabled for this account");
  if (original.status !== "expired") throw new Error("This invoice has not expired");
  if (original.amountSatsReceived > 0) throw new Error("This invoice already received money");

  const existing = await prisma.invoice.findFirst({
    where: { reissuedFromId: original.id },
    orderBy: { createdAt: "desc" },
  });
  if (existing) redirect(`/p/${existing.publicId}`);

  const replacement = await createInvoice({
    userId: original.userId,
    clientName: original.clientName,
    clientEmail: original.clientEmail,
    description: original.description,
    amountUsdCents: original.amountUsdCents,
    expirySeconds: original.expirySeconds,
    reissuedFromId: original.id,
  });

  await audit({
    actor: "client",
    action: "invoice.reissued",
    userId: original.userId,
    invoiceId: replacement.id,
    meta: { reissuedFrom: original.publicId },
  });

  redirect(`/p/${replacement.publicId}`);
}
