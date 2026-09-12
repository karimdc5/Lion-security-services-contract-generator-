import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { receiptResponse } from "@/lib/pdf/serve";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await requireUser();

  const invoice = await prisma.invoice.findFirst({ where: { id, userId: user.id } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return receiptResponse(invoice);
}
