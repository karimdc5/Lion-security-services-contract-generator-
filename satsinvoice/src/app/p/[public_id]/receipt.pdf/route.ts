import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { receiptResponse } from "@/lib/pdf/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The client's copy. Only issued once money has actually arrived — an unpaid
 * invoice has no receipt to give.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ public_id: string }> },
) {
  const { public_id: publicId } = await context.params;

  const invoice = await prisma.invoice.findUnique({ where: { publicId } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (invoice.amountSatsReceived === 0) {
    return NextResponse.json({ error: "This invoice has not been paid." }, { status: 404 });
  }

  return receiptResponse(invoice);
}
