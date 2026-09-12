import { notFound } from "next/navigation";
import { Countdown } from "@/components/Countdown";
import { CopyButton } from "@/components/CopyButton";
import { PayStatusPoller } from "@/components/PayStatusPoller";
import { QrCode } from "@/components/QrCode";
import { prisma } from "@/lib/db";
import { toState } from "@/lib/invoice-mapper";
import { remainingUsdCents } from "@/lib/invoice-state";
import { withExpirySwept } from "@/lib/invoices";
import { formatSats, formatUsdCents } from "@/lib/money";
import { reissueInvoiceAction } from "@/lib/actions/public";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ public_id: string }> }) {
  const { public_id: publicId } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { publicId },
    select: { amountUsdCents: true, user: { select: { displayName: true } } },
  });
  if (!invoice) return { title: "Invoice · SatsInvoice" };
  return {
    title: `${formatUsdCents(invoice.amountUsdCents)} to ${invoice.user.displayName}`,
    robots: { index: false, follow: false },
  };
}

export default async function PublicPayPage({
  params,
}: {
  params: Promise<{ public_id: string }>;
}) {
  const { public_id: publicId } = await params;

  const found = await prisma.invoice.findUnique({
    where: { publicId },
    include: { user: { select: { displayName: true, payoutNote: true, autoReissue: true } } },
  });
  if (!found) notFound();

  // withExpirySwept returns the bare Invoice row, so keep the freelancer aside.
  const freelancer = found.user;
  const invoice = await withExpirySwept(found);
  const state = toState(invoice);
  const remaining = remainingUsdCents(state);
  const payable = invoice.status === "unpaid" || invoice.status === "pending" || invoice.status === "underpaid";

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10 sm:py-16">
      <PayStatusPoller publicId={invoice.publicId} currentStatus={invoice.status} />

      <div className="w-full max-w-md">
        {/* ---------------- Header ---------------- */}
        <div className="text-center">
          <p className="text-sm text-muted">
            {freelancer.displayName} sent you an invoice
          </p>
          <h1 className="tnum mt-3 text-5xl font-semibold tracking-tight sm:text-6xl">
            {formatUsdCents(invoice.amountUsdCents)}
          </h1>
          <p className="tnum mt-2 text-sm text-faint">{formatSats(invoice.amountSatsExpected)}</p>
          <p className="mx-auto mt-4 max-w-xs text-sm text-muted">{invoice.description}</p>
        </div>

        {/* ---------------- Paid ---------------- */}
        {invoice.status === "paid" && (
          <div className="card mt-8 p-6 text-center">
            <div className="mx-auto grid size-11 place-items-center rounded-full bg-good-soft text-good">
              <svg viewBox="0 0 20 20" fill="currentColor" className="size-6" aria-hidden>
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <p className="mt-3 text-lg font-semibold">Paid in full</p>
            <p className="hint">
              Thanks. {freelancer.displayName} has been notified.
              {invoice.overpaySats > 0 && (
                <>
                  {" "}
                  You sent {formatUsdCents(invoice.overpayUsdCents)} more than the invoice —
                  they will be in touch about the difference.
                </>
              )}
            </p>
            <a href={`/p/${invoice.publicId}/receipt.pdf`} className="btn-secondary mt-5">
              Download receipt
            </a>
          </div>
        )}

        {/* ---------------- Awaiting payment ---------------- */}
        {payable && invoice.paymentRequest && (
          <div className="card mt-8 p-6">
            {invoice.status === "underpaid" && (
              <div className="mb-5 rounded-lg bg-warn-soft px-4 py-3 text-center">
                <p className="text-sm font-semibold text-warn">Partly paid</p>
                <p className="tnum mt-1 text-2xl font-semibold text-warn">
                  {formatUsdCents(remaining)}
                </p>
                <p className="text-xs text-warn/80">still to pay</p>
              </div>
            )}

            <div className="flex justify-center">
              <QrCode value={invoice.paymentRequest} alt="Scan to pay this invoice" size={248} />
            </div>

            <p className="mt-4 text-center text-sm text-muted">
              Scan with any Bitcoin wallet, or copy the invoice below.
            </p>

            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2">
              <p className="font-mono text-xs break-all text-muted">{invoice.paymentRequest}</p>
            </div>

            <div className="mt-3 flex gap-2">
              <CopyButton
                value={invoice.paymentRequest}
                label="Copy invoice"
                className="btn-primary flex-1"
              />
              {invoice.paymentUrl && (
                <a href={invoice.paymentUrl} className="btn-secondary">
                  Open wallet
                </a>
              )}
            </div>

            {invoice.expiresAt && (
              <p className="mt-5 text-center text-sm text-muted">
                This invoice expires in{" "}
                <Countdown expiresAt={invoice.expiresAt.toISOString()} />
              </p>
            )}
          </div>
        )}

        {/* ---------------- Expired ---------------- */}
        {invoice.status === "expired" && (
          <div className="card mt-8 p-6 text-center">
            <p className="text-lg font-semibold">This link expired</p>
            {invoice.amountSatsReceived > 0 ? (
              <p className="hint">
                A payment arrived after the invoice expired. {freelancer.displayName} has been
                notified and will sort it out with you — please do not send it again.
              </p>
            ) : freelancer.autoReissue ? (
              <>
                <p className="hint">You can generate a fresh invoice for the same amount.</p>
                <form
                  action={reissueInvoiceAction.bind(null, invoice.publicId)}
                  className="mt-5"
                >
                  <button type="submit" className="btn-primary w-full">
                    Generate new invoice
                  </button>
                </form>
              </>
            ) : (
              <p className="hint">
                Contact {freelancer.displayName} for a new one.
                {freelancer.payoutNote && (
                  <span className="mt-2 block text-muted">{freelancer.payoutNote}</span>
                )}
              </p>
            )}
          </div>
        )}

        {/* ---------------- Closed ---------------- */}
        {(invoice.status === "canceled" || invoice.status === "refunded" || invoice.status === "draft") && (
          <div className="card mt-8 p-6 text-center">
            <p className="text-lg font-semibold">
              {invoice.status === "refunded" ? "This invoice was refunded" : "This invoice is not payable"}
            </p>
            <p className="hint">Contact {freelancer.displayName} if you think that is wrong.</p>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-faint">
          Paid securely in Bitcoin. Amounts are fixed in US dollars at the time this invoice was
          created.
        </p>
      </div>
    </div>
  );
}
