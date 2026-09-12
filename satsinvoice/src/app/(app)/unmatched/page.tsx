import Link from "next/link";
import { UnmatchedActions } from "@/components/UnmatchedRow";
import { applyToInvoiceAction, ignoreAction, markRefundedAction } from "@/lib/actions/unmatched";
import { prisma } from "@/lib/db";
import { formatSats, formatUsdCents } from "@/lib/money";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Unmatched payments · SatsInvoice" };
export const dynamic = "force-dynamic";

const stamp = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const REASON_COPY: Record<string, string> = {
  late_payment: "Arrived after the invoice expired",
  duplicate_invoice_payment: "Second payment on an invoice that was already settled",
  invoice_not_payable: "Arrived for an invoice that was canceled or not yet issued",
  unknown_invoice: "No invoice on this account matches it",
};

const RESOLUTION_COPY: Record<string, string> = {
  apply_to_invoice: "Applied to an invoice",
  refunded: "Marked refunded",
  ignored: "Ignored",
};

export default async function UnmatchedPage() {
  const user = await requireUser();
  const scope = { OR: [{ userId: user.id }, { userId: null }] };

  const [open, resolved, openInvoices] = await Promise.all([
    prisma.unmatchedPayment.findMany({
      where: { ...scope, resolution: "open" },
      orderBy: { createdAt: "desc" },
      include: { invoice: { select: { id: true, clientName: true, publicId: true } } },
    }),
    prisma.unmatchedPayment.findMany({
      where: { ...scope, resolution: { not: "open" } },
      orderBy: { resolvedAt: "desc" },
      take: 25,
    }),
    prisma.invoice.findMany({
      where: { userId: user.id, status: { in: ["unpaid", "pending", "underpaid", "expired"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, clientName: true, amountUsdCents: true, status: true },
    }),
  ]);

  const invoiceOptions = openInvoices.map((invoice) => ({
    id: invoice.id,
    label: `${invoice.clientName} — ${formatUsdCents(invoice.amountUsdCents)} (${invoice.status})`,
  }));

  const openTotalUsd = open.reduce((sum, item) => sum + item.amountUsdCents, 0);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Unmatched payments</h1>
      <p className="hint max-w-2xl">
        Money that arrived but could not be applied cleanly — late, duplicated, or for an invoice
        that was not open. Nothing here is lost and nothing was applied silently. You decide what
        happens to each one.
      </p>

      {open.length === 0 ? (
        <div className="card mt-6 px-6 py-14 text-center">
          <p className="font-medium">Nothing needs your attention.</p>
          <p className="hint">Every payment so far landed on an invoice exactly once.</p>
        </div>
      ) : (
        <>
          <p className="mt-6 text-sm font-medium text-warn">
            {open.length} payment{open.length === 1 ? "" : "s"} waiting ·{" "}
            <span className="tnum">{formatUsdCents(openTotalUsd)}</span>
          </p>
          <div className="mt-3 space-y-4">
            {open.map((item) => (
              <div key={item.id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{REASON_COPY[item.reason] ?? item.reason}</p>
                    <p className="hint">{item.note}</p>
                    {item.invoice && (
                      <p className="mt-1 text-sm">
                        <Link
                          href={`/invoices/${item.invoice.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {item.invoice.clientName}&apos;s invoice
                        </Link>
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="tnum text-xl font-semibold">
                      {formatUsdCents(item.amountUsdCents)}
                    </p>
                    <p className="tnum text-xs text-faint">{formatSats(item.amountSats)}</p>
                  </div>
                </div>

                <p className="mt-2 font-mono text-xs text-faint">
                  {item.provider} · {item.providerPaymentId} · {stamp.format(item.createdAt)} UTC
                </p>

                <UnmatchedActions
                  invoiceOptions={invoiceOptions}
                  applyToInvoice={applyToInvoiceAction.bind(null, item.id)}
                  markRefunded={markRefundedAction.bind(null, item.id)}
                  ignore={ignoreAction.bind(null, item.id)}
                />
              </div>
            ))}
          </div>
        </>
      )}

      {resolved.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Resolved</h2>
          <div className="card mt-3 divide-y divide-line">
            {resolved.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {RESOLUTION_COPY[item.resolution] ?? item.resolution}
                  </p>
                  <p className="truncate font-mono text-xs text-faint">{item.providerPaymentId}</p>
                </div>
                <p className="tnum text-sm font-medium">{formatUsdCents(item.amountUsdCents)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
