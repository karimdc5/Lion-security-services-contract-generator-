import { NextResponse } from "next/server";
import { buildLedgerCsv } from "@/lib/csv";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function GET(request: Request) {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;

  const now = new Date();
  const from = parseDate(params.get("from"), new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
  // `to` is a date, so include the whole day.
  const to = parseDate(params.get("to"), now);
  to.setUTCHours(23, 59, 59, 999);

  if (from > to) {
    return NextResponse.json({ error: "The start date is after the end date." }, { status: 400 });
  }

  const csv = await buildLedgerCsv({ userId: user.id, from, to });
  const filename = `satsinvoice-${from.toISOString().slice(0, 10)}-to-${to
    .toISOString()
    .slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
