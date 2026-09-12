import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { CSV_COLUMNS } from "@/lib/csv";

export const metadata = { title: "Export · SatsInvoice" };
export const dynamic = "force-dynamic";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function ExportPage() {
  const user = await requireUser();
  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

  const [invoiceCount, eventCount] = await Promise.all([
    prisma.invoice.count({ where: { userId: user.id } }),
    prisma.paymentEvent.count({ where: { invoice: { userId: user.id } } }),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Export</h1>
      <p className="hint">
        A CSV of every money fact in the range: what you billed, what arrived, what arrived late,
        and what could not be applied.
      </p>

      <form action="/api/export" method="get" className="card mt-6 p-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="from">
              From (UTC)
            </label>
            <input
              id="from"
              name="from"
              type="date"
              className="input"
              defaultValue={isoDay(yearStart)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="to">
              To (UTC)
            </label>
            <input
              id="to"
              name="to"
              type="date"
              className="input"
              defaultValue={isoDay(now)}
              required
            />
          </div>
        </div>

        <button type="submit" className="btn-primary mt-5">
          Download CSV
        </button>
        <p className="hint">
          {invoiceCount} invoice{invoiceCount === 1 ? "" : "s"} and {eventCount} payment event
          {eventCount === 1 ? "" : "s"} on this account.
        </p>
      </form>

      <div className="card mt-6 p-6">
        <h2 className="text-sm font-semibold">What is in the file</h2>
        <div className="mt-3 overflow-x-auto">
          <code className="font-mono text-xs whitespace-nowrap text-muted">
            {CSV_COLUMNS.join(", ")}
          </code>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          {[
            ["invoice", "the invoice itself — what you billed"],
            ["settled", "a payment that landed on time"],
            ["late", "a payment that landed after expiry"],
            ["unmatched", "money that could not be applied to an invoice"],
            ["refund", "a refund you recorded"],
            ["pending", "a provider notice that a payment was in flight"],
          ].map(([kind, meaning]) => (
            <div key={kind} className="flex gap-3">
              <dt className="w-24 shrink-0 font-mono text-xs text-accent">{kind}</dt>
              <dd className="text-muted">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="hint mt-4">
          Sum <code className="font-mono">amount_usd</code> over{" "}
          <code className="font-mono">kind=settled</code> for revenue actually received. Sum over{" "}
          <code className="font-mono">kind=invoice</code> for revenue billed. When those differ,
          something needed a human — that is what the unmatched inbox is for.
        </p>
      </div>
    </div>
  );
}
