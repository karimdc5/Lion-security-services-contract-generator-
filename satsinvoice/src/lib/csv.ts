/**
 * The tax export.
 *
 * One row per money fact, not one row per invoice, so nothing is invisible:
 *
 *   kind=invoice   the invoice itself — what you billed, in USD
 *   kind=settled   a payment that landed on time
 *   kind=late      a payment that landed after expiry
 *   kind=unmatched money that could not be applied to an invoice
 *   kind=refund    a refund you recorded
 *   kind=pending   a provider notice that a payment was in flight
 *
 * Summing `amount_usd` over kind=settled gives revenue received. Summing over
 * kind=invoice gives revenue billed. They differ when something went wrong,
 * and that difference is the point of the export.
 */

import { prisma } from "@/lib/db";
import { toState } from "@/lib/invoice-mapper";
import { displayStatus } from "@/lib/invoice-state";
import { btcRateCentsToUsd, usdCentsToDecimalString } from "@/lib/money";

export const CSV_COLUMNS = [
  "date_utc",
  "invoice_public_id",
  "client",
  "description",
  "status",
  "amount_usd",
  "amount_sats_expected",
  "amount_sats_received",
  "btc_usd_rate",
  "payment_hash_or_provider_id",
  "kind",
] as const;

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

/** RFC 4180: quote anything containing a comma, quote, CR or LF. */
export function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column] ?? "")).join(","));
  }
  // Trailing newline so `wc -l` and shell pipelines behave.
  return `${lines.join("\r\n")}\r\n`;
}

function isoDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface LedgerQuery {
  userId: string;
  from: Date;
  to: Date;
}

export async function buildLedgerRows({ userId, from, to }: LedgerQuery): Promise<CsvRow[]> {
  const [invoices, events, orphans] = await Promise.all([
    prisma.invoice.findMany({
      where: { userId, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.paymentEvent.findMany({
      where: { receivedAt: { gte: from, lte: to }, invoice: { userId } },
      orderBy: { receivedAt: "asc" },
      include: { invoice: true },
    }),
    // Money that never reached an invoice at all.
    prisma.unmatchedPayment.findMany({
      where: { userId, invoiceId: null, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const rows: CsvRow[] = [];

  for (const invoice of invoices) {
    const state = toState(invoice);
    rows.push({
      date_utc: isoDate(invoice.createdAt),
      invoice_public_id: invoice.publicId,
      client: invoice.clientName,
      description: invoice.description,
      status: displayStatus(state),
      amount_usd: usdCentsToDecimalString(invoice.amountUsdCents),
      amount_sats_expected: String(invoice.amountSatsExpected),
      amount_sats_received: String(invoice.amountSatsReceived),
      btc_usd_rate:
        invoice.btcRateUsdCents > 0 ? btcRateCentsToUsd(invoice.btcRateUsdCents).toFixed(2) : "",
      payment_hash_or_provider_id: invoice.providerInvoiceId ?? "",
      kind: "invoice",
    });
  }

  for (const event of events) {
    const invoice = event.invoice;
    rows.push({
      date_utc: isoDate(event.receivedAt),
      invoice_public_id: invoice?.publicId ?? "",
      client: invoice?.clientName ?? "",
      description: invoice?.description ?? "",
      status: invoice ? displayStatus(toState(invoice)) : "unmatched",
      amount_usd: usdCentsToDecimalString(event.amountUsdCents),
      amount_sats_expected: invoice ? String(invoice.amountSatsExpected) : "",
      amount_sats_received: String(event.amountSats),
      btc_usd_rate:
        invoice && invoice.btcRateUsdCents > 0
          ? btcRateCentsToUsd(invoice.btcRateUsdCents).toFixed(2)
          : "",
      payment_hash_or_provider_id: event.providerPaymentId,
      kind: event.kind,
    });
  }

  for (const orphan of orphans) {
    rows.push({
      date_utc: isoDate(orphan.createdAt),
      invoice_public_id: "",
      client: "",
      description: orphan.note,
      status: `unmatched (${orphan.resolution})`,
      amount_usd: usdCentsToDecimalString(orphan.amountUsdCents),
      amount_sats_expected: "",
      amount_sats_received: String(orphan.amountSats),
      btc_usd_rate: "",
      payment_hash_or_provider_id: orphan.providerPaymentId,
      kind: "unmatched",
    });
  }

  rows.sort((a, b) => a.date_utc.localeCompare(b.date_utc));
  return rows;
}

export async function buildLedgerCsv(query: LedgerQuery): Promise<string> {
  return toCsv(await buildLedgerRows(query));
}
