"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionState } from "@/lib/actions/invoices";

type Action = () => Promise<ActionState>;

export function InvoiceActions({
  canExpire,
  canCancel,
  canWriteOff,
  canRefund,
  expireNow,
  cancel,
  writeOff,
  refund,
}: {
  canExpire: boolean;
  canCancel: boolean;
  canWriteOff: boolean;
  canRefund: boolean;
  expireNow: Action;
  cancel: Action;
  writeOff: Action;
  refund: (note: string) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundNote, setRefundNote] = useState("");

  function run(action: () => Promise<ActionState>, confirmMessage?: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) setError(result.error);
      else router.refresh();
    });
  }

  if (!canExpire && !canCancel && !canWriteOff && !canRefund) return null;

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold">Actions</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {canExpire && (
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            onClick={() =>
              run(
                expireNow,
                "Expire this invoice now? The payment link stops working, and anything that arrives after this is recorded as a late payment.",
              )
            }
          >
            Expire now
          </button>
        )}

        {canCancel && (
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            onClick={() => run(cancel, "Cancel this invoice? You can only do this before any money arrives.")}
          >
            Cancel invoice
          </button>
        )}

        {canWriteOff && (
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            onClick={() =>
              run(
                writeOff,
                "Write off the unpaid remainder? The invoice closes but stays recorded as underpaid, so your books show what actually arrived.",
              )
            }
          >
            Write off remainder
          </button>
        )}

        {canRefund && !refundOpen && (
          <button type="button" className="btn-danger" disabled={pending} onClick={() => setRefundOpen(true)}>
            Issue refund
          </button>
        )}
      </div>

      {refundOpen && (
        <div className="mt-4 rounded-lg border border-bad/30 bg-bad-soft/50 p-4">
          <p className="text-sm font-semibold text-bad">Record a refund</p>
          <p className="mt-1 text-sm text-muted">
            SatsInvoice holds no keys and sends no coins. This marks the invoice refunded in your
            books and logs the note. Send the actual payment from your provider&apos;s dashboard.
          </p>
          <input
            className="input"
            placeholder="Refund reference, e.g. OpenNode withdrawal id"
            value={refundNote}
            onChange={(event) => setRefundNote(event.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-danger"
              disabled={pending}
              onClick={() => run(() => refund(refundNote))}
            >
              {pending ? "Recording…" : "Record refund"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setRefundOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
    </div>
  );
}
