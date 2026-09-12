import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/db";
import { renderReceiptPdf } from "./receipt";

/** Builds the PDF response for an invoice, shared by the owner and client routes. */
export async function receiptResponse(invoice: Invoice): Promise<Response> {
  const [user, events] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: invoice.userId } }),
    prisma.paymentEvent.findMany({
      where: { invoiceId: invoice.id, kind: { in: ["settled", "late", "refund"] } },
      orderBy: { receivedAt: "asc" },
      select: { providerPaymentId: true, kind: true },
    }),
  ]);

  const pdf = await renderReceiptPdf({
    invoice,
    freelancerName: user.displayName,
    freelancerEmail: user.email,
    payoutNote: user.payoutNote,
    paymentReferences: events.map((event) => `${event.kind}: ${event.providerPaymentId}`),
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="satsinvoice-${invoice.publicId}.pdf"`,
      "cache-control": "no-store",
    },
  });
}
