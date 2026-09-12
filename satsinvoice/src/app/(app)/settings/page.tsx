import { AutoReissueToggle, ProfileForm } from "@/components/SettingsForm";
import { setAutoReissueAction, setPayoutNoteAction } from "@/lib/actions/invoices";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Settings · SatsInvoice" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="hint">{user.email}</p>
      </div>

      <ProfileForm
        action={setPayoutNoteAction}
        displayName={user.displayName}
        payoutNote={user.payoutNote}
      />

      <AutoReissueToggle enabled={user.autoReissue} action={setAutoReissueAction} />

      <div className="card p-6">
        <h2 className="text-sm font-semibold">Payments</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Provider</dt>
            <dd className="font-mono">{env.paymentProvider}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Webhook endpoint</dt>
            <dd className="font-mono text-xs break-all">
              {env.appUrl}/api/webhooks/{env.paymentProvider}
            </dd>
          </div>
        </dl>
        <p className="hint mt-4">
          SatsInvoice runs no Lightning node, holds no keys and custodies nothing. Your provider
          settles straight to you; this app only keeps the books.
        </p>
      </div>
    </div>
  );
}
