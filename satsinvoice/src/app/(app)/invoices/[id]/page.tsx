import Link from "next/link";
import { notFound } from "next/navigation";
import { Countdown } from "@/components/Countdown";
import { CopyButton } from "@/components/CopyButton";
import { InvoiceActions } from "@/components/InvoiceActions";
import { QrCode } from "@/components/QrCode";
import { ReviewFlag, StatusBadge } from "@/components/StatusBadge";
import {
  cancelInvoiceAction,
  expireNowAction,
  refundInvoiceAction,
  writeOffAction,
} from "@/lib/actions/invoices";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toState } from "@/lib/invoice-mapper";
import {
  canCancel,
  canExpireNow,
  canRefund,
  canWriteOff,
  remainingSats,
  remainingUsdCents,
} from "@/lib/invoice-state";
import { withExpirySwept } from "@/lib/invoices";
import { btcRateCentsToUsd, formatSats, formatUsdCents } from "@/lib/money";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const stamp = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const EVENT_LABELS: Record<string, string> = {
  settled: "Payment settled",
  late: "Late payment received",
  unmatched: "Payment could not be applied",
  duplicate: "Duplicate payment",
  refund: "Refund recorded",
  pending: "Payment in flight",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const found = await prisma.invoice.findFirst({ where: { id, userId: user.id } });
  if (!found) notFound();

  const invoice = await withExpirySwept(found);
  const state = toState(invoice);

  const [events, unmatched, logs] = await Promise.all([
    prisma.paymentEvent.findMany({ where: { invoiceId: invoice.id }, orderBy: { receivedAt: "asc" } }),
    prisma.unmatchedPayment.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
  ]);

  const publicUrl = `${env.appUrl}/p/${invoice.publicId}`;
  const isLive = ["unpaid", "pending"].includes(invoice.status);
  const remaining = remainingUsdCents(state);

  return (
    <div>
      <Link href="/invoices" className="text-sm font-medium text-muted hover:text-ink">
        ← Invoices
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{invoice.clientName}</h1>
            <StatusBadge state={state} />
            {invoice.reviewFlag && <ReviewFlag />}
          </div>
          <p className="hint">{invoice.description}</p>
        </div>
        <div className="text-right">
          <div className="tnum text-3xl font-semibold">{formatUsdCents(invoice.amountUsdCents)}</div>
          <div className="tnum text-sm text-faint">{formatSats(invoice.amountSatsExpected)}</div>
        </div>
      </div>

      {invoice.reviewFlag && (
        <div className="mt-5 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
          <strong className="font-semibold">This invoice needs a look.</strong> Money arrived late,
          twice, or for an invoice that was not open. Nothing was applied silently —{" "}
          <Link href="/unmatched" className="underline">
            open the unmatched inbox
          </Link>{" "}
          to decide what happens to it.
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* ---------------- Settlement facts ---------------- */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold">Settlement</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Fact label="Expected" value={formatSats(invoice.amountSatsExpected)} />
              <Fact
                label="Received"
                value={formatSats(invoice.amountSatsReceived)}
                tone={invoice.amountSatsReceived > 0 ? "good" : undefined}
              />
              {remainingSats(state) > 0 && !["canceled", "draft"].includes(invoice.status) && (
                <Fact
                  label="Still owed"
                  value={`${formatUsdCents(remaining)} · ${formatSats(remainingSats(state))}`}
                  tone="warn"
                />
              )}
              {invoice.overpaySats > 0 && (
                <Fact
                  label="Overpaid"
                  value={`${formatUsdCents(invoice.overpayUsdCents)} · ${formatSats(invoice.overpaySats)}`}
                  tone="warn"
                />
              )}
              <Fact
                label="Rate locked in"
                value={
                  invoice.btcRateUsdCents > 0
                    ? `$${btcRateCentsToUsd(invoice.btcRateUsdCents).toLocaleString("en-US")} / BTC`
                    : "—"
                }
              />
              <Fact
                label={invoice.paidAt ? "Paid at" : "Expires"}
                value={
                  invoice.paidAt ? (
                    `${stamp.format(invoice.paidAt)} UTC`
                  ) : invoice.expiresAt ? (
                    isLive ? (
                      <>
                        <Countdown expiresAt={invoice.expiresAt.toISOString()} /> left
                      </>
                    ) : (
                      `${stamp.format(invoice.expiresAt)} UTC`
                    )
                  ) : (
                    "—"
                  )
                }
              />
              <Fact label="Provider" value={invoice.provider ?? "—"} />
              <Fact
                label="Provider invoice id"
                value={<span className="font-mono text-xs">{invoice.providerInvoiceId ?? "—"}</span>}
              />
            </dl>

            {(invoice.status === "paid" || invoice.status === "refunded") && (
              <a href={`/invoices/${invoice.id}/receipt.pdf`} className="btn-secondary mt-5">
                Download receipt (PDF)
              </a>
            )}
          </div>

          {/* ---------------- Timeline ---------------- */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold">Events</h2>
            {events.length === 0 && logs.length === 0 ? (
              <p className="hint mt-2">Nothing has happened yet.</p>
            ) : (
              <ol className="mt-4 space-y-4">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3 text-sm">
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${
                        event.kind === "settled"
                          ? "bg-good"
                          : event.kind === "late" || event.kind === "unmatched"
                            ? "bg-bad"
                            : "bg-faint"
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {EVENT_LABELS[event.kind] ?? event.kind} ·{" "}
                        <span className="tnum">{formatSats(event.amountSats)}</span>{" "}
                        <span className="text-faint">
                          ({formatUsdCents(event.amountUsdCents)})
                        </span>
                      </p>
                      <p className="text-xs text-faint">
                        {stamp.format(event.receivedAt)} UTC · payment{" "}
                        <span className="font-mono">{event.providerPaymentId}</span>
                      </p>
                    </div>
                  </li>
                ))}

                {logs
                  .filter((log) => !log.action.startsWith("payment."))
                  .map((log) => (
                    <li key={log.id} className="flex gap-3 text-sm">
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-line" />
                      <div>
                        <p className="text-muted">{log.action.replace(/[._]/g, " ")}</p>
                        <p className="text-xs text-faint">{stamp.format(log.createdAt)} UTC</p>
                      </div>
                    </li>
                  ))}
              </ol>
            )}

            {unmatched.length > 0 && (
              <p className="mt-5 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                {unmatched.length} payment{unmatched.length === 1 ? "" : "s"} for this invoice{" "}
                {unmatched.length === 1 ? "is" : "are"} waiting in the{" "}
                <Link href="/unmatched" className="underline">
                  unmatched inbox
                </Link>
                .
              </p>
            )}
          </div>

          <InvoiceActions
            canExpire={canExpireNow(state)}
            canCancel={canCancel(state)}
            canWriteOff={canWriteOff(state)}
            canRefund={canRefund(state)}
            expireNow={expireNowAction.bind(null, invoice.id)}
            cancel={cancelInvoiceAction.bind(null, invoice.id)}
            writeOff={writeOffAction.bind(null, invoice.id)}
            refund={refundInvoiceAction.bind(null, invoice.id)}
          />
        </div>

        {/* ---------------- Share panel ---------------- */}
        <aside className="space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold">Payment link</h2>
            <p className="hint">Send this to {invoice.clientName}. No account needed.</p>
            <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs break-all">
              {publicUrl}
            </div>
            <div className="mt-3 flex gap-2">
              <CopyButton value={publicUrl} label="Copy link" className="btn-primary flex-1" />
              <a href={publicUrl} target="_blank" rel="noreferrer" className="btn-secondary">
                Open
              </a>
            </div>
          </div>

          {isLive && invoice.paymentRequest && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold">Invoice QR</h2>
              <div className="mt-3 flex justify-center">
                <QrCode value={invoice.paymentRequest} alt="Bitcoin payment QR code" size={240} />
              </div>
              <div className="mt-3 flex gap-2">
                <CopyButton
                  value={invoice.paymentRequest}
                  label="Copy invoice"
                  className="btn-secondary flex-1"
                />
                {invoice.paymentUrl && (
                  <a href={invoice.paymentUrl} target="_blank" rel="noreferrer" className="btn-secondary">
                    Checkout
                  </a>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "good" | "warn";
}) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-faint uppercase">{label}</dt>
      <dd
        className={`tnum mt-1 font-medium ${
          tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
