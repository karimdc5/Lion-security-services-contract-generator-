/**
 * Tiny status endpoint the public pay page polls, so a client watching the
 * screen sees "paid" without refreshing. It exposes only what the client is
 * already looking at — no ids, no provider data, no email.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toState } from "@/lib/invoice-mapper";
import { displayStatus, remainingUsdCents } from "@/lib/invoice-state";
import { withExpirySwept } from "@/lib/invoices";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ public_id: string }> },
) {
  const { public_id: publicId } = await context.params;

  const found = await prisma.invoice.findUnique({ where: { publicId } });
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const invoice = await withExpirySwept(found);
  const state = toState(invoice);

  return NextResponse.json(
    {
      status: invoice.status,
      display: displayStatus(state),
      remainingUsdCents: remainingUsdCents(state),
      paid: invoice.status === "paid",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
