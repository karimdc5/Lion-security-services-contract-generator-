import Link from "next/link";
import { StatusBadge, ReviewFlag } from "@/components/StatusBadge";
import { prisma } from "@/lib/db";
import { toState } from "@/lib/invoice-mapper";
import { remainingUsdCents } from "@/lib/invoice-state";
import { sweepAll } from "@/lib/invoices";
import { formatSats, formatUsdCents } from "@/lib/money";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Invoices · SatsInvoice" };
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export default async function InvoicesPage() {
  const user = await requireUser();
  const rows = await prisma.invoice.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const invoices = await sweepAll(rows);

  const outstanding = invoices
    .filter((i) => ["unpaid", "pending", "underpaid"].includes(i.status) && !i.writtenOff)
    .reduce((sum, i) => sum + remainingUsdCents(toState(i)), 0);
  const paid = invoices
    .filter((i) => i.status === "paid")
    .reduce((sum, i) => sum + i.amountUsdCents, 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="hint">
            {formatUsdCents(paid)} collected · {formatUsdCents(outstanding)} outstanding
          </p>
        </div>
        <Link href="/invoices/new" className="btn-primary">
          New invoice
        </Link>
      </div>

      {invoices.length === 0 ? (
        <div className="card mt-6 px-6 py-16 text-center">
          <p className="font-medium">No invoices yet.</p>
          <p className="hint mx-auto mt-1 max-w-sm">
            Create one in dollars, send the link, and get paid in Bitcoin. Your client never has to
            think about sats.
          </p>
          <Link href="/invoices/new" className="btn-primary mt-6">
            Create your first invoice
          </Link>
        </div>
      ) : (
        <div className="card mt-6 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead className="border-b border-line bg-canvas">
                <tr>
                  <th className="th">Client</th>
                  <th className="th">Description</th>
                  <th className="th text-right">Amount</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const state = toState(invoice);
                  return (
                    <tr key={invoice.id} className="border-b border-line last:border-0 hover:bg-canvas">
                      <td className="td">
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="font-medium hover:text-accent hover:underline"
                        >
                          {invoice.clientName}
                        </Link>
                        {invoice.clientEmail && (
                          <div className="text-xs text-faint">{invoice.clientEmail}</div>
                        )}
                      </td>
                      <td className="td max-w-xs truncate text-muted">{invoice.description}</td>
                      <td className="td text-right">
                        <div className="tnum font-semibold">
                          {formatUsdCents(invoice.amountUsdCents)}
                        </div>
                        <div className="tnum text-xs text-faint">
                          {formatSats(invoice.amountSatsExpected)}
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          <StatusBadge state={state} />
                          {invoice.reviewFlag && <ReviewFlag />}
                        </div>
                      </td>
                      <td className="td whitespace-nowrap text-muted">
                        {dateFmt.format(invoice.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
