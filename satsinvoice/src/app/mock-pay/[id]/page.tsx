import { notFound } from "next/navigation";
import Link from "next/link";
import { MockPayPanel } from "@/components/MockPayPanel";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { formatSats, formatUsdCents } from "@/lib/money";
import { isMockProvider } from "@/lib/payments";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mock checkout · SatsInvoice", robots: { index: false } };

/**
 * The mock "wallet".
 *
 * Every button here POSTs to /api/webhooks/mock — the exact endpoint a real
 * processor will call. There is no back door into the database from this page.
 */
export default async function MockPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: providerInvoiceId } = await params;

  if (!isMockProvider(env.paymentProvider)) notFound();

  const invoice = await prisma.invoice.findUnique({
    where: { providerInvoiceId },
    include: { user: { select: { displayName: true } } },
  });
  if (!invoice) notFound();

  const settledCount = await prisma.paymentEvent.count({
    where: { invoiceId: invoice.id, kind: { in: ["settled", "late"] } },
  });

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          <strong className="font-semibold">Mock checkout.</strong> No Bitcoin moves. Each button
          sends a signed webhook to <code className="font-mono">/api/webhooks/mock</code>, the same
          endpoint a real processor uses.
        </div>

        <div className="card mt-6 p-6">
          <p className="text-sm text-muted">Paying {invoice.user.displayName}</p>
          <p className="tnum mt-2 text-4xl font-semibold tracking-tight">
            {formatUsdCents(invoice.amountUsdCents)}
          </p>
          <p className="tnum mt-1 text-sm text-faint">
            {formatSats(invoice.amountSatsExpected)} · {invoice.description}
          </p>
          <p className="mt-4 text-xs text-faint">
            Invoice status right now: <strong className="font-semibold">{invoice.status}</strong> ·
            received {formatSats(invoice.amountSatsReceived)}
          </p>
        </div>

        <MockPayPanel
          providerInvoiceId={providerInvoiceId}
          expectedSats={invoice.amountSatsExpected}
          expiresAt={invoice.expiresAt ? invoice.expiresAt.toISOString() : null}
          alreadySettled={settledCount > 0}
        />

        <p className="mt-6 text-center text-sm">
          <Link href={`/p/${invoice.publicId}`} className="text-accent hover:underline">
            ← Back to the client&apos;s payment page
          </Link>
        </p>
      </div>
    </div>
  );
}
