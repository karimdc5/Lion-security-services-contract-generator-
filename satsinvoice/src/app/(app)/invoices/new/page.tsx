import Link from "next/link";
import { NewInvoiceForm } from "@/components/NewInvoiceForm";
import { createInvoiceAction } from "@/lib/actions/invoices";
import { DEFAULT_EXPIRY_SECONDS, EXPIRY_OPTIONS } from "@/lib/invoices";
import { requireUser } from "@/lib/session";

export const metadata = { title: "New invoice · SatsInvoice" };

export default async function NewInvoicePage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/invoices" className="text-sm font-medium text-muted hover:text-ink">
        ← Invoices
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">New invoice</h1>
      <p className="hint">Priced in dollars. Settled in Bitcoin.</p>

      <NewInvoiceForm
        action={createInvoiceAction}
        expiryOptions={EXPIRY_OPTIONS.map((o) => ({ label: o.label, seconds: o.seconds }))}
        defaultExpirySeconds={DEFAULT_EXPIRY_SECONDS}
      />
    </div>
  );
}
