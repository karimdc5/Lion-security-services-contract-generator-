"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionState } from "@/lib/actions/unmatched";

export interface InvoiceOption {
  id: string;
  label: string;
}

export function UnmatchedActions({
  invoiceOptions,
  applyToInvoice,
  markRefunded,
  ignore,
}: {
  invoiceOptions: InvoiceOption[];
  applyToInvoice: (invoiceId: string) => Promise<ActionState>;
  markRefunded: (note: string) => Promise<ActionState>;
  ignore: (note: string) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<"apply" | "refund" | "ignore" | null>(null);
  const [invoiceId, setInvoiceId] = useState(invoiceOptions[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<ActionState | null>(null);

  function run(action: () => Promise<ActionState>) {
    setFeedback(null);
    startTransition(async () => {
      const result = await action();
      setFeedback(result);
      if (!result.error) {
        setOpen(null);
        setNote("");
        router.refresh();
      }
    });
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || invoiceOptions.length === 0}
          onClick={() => setOpen(open === "apply" ? null : "apply")}
          title={invoiceOptions.length === 0 ? "No open invoices to apply this to" : undefined}
        >
          Apply to invoice
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          onClick={() => setOpen(open === "refund" ? null : "refund")}
        >
          Mark refunded
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          onClick={() => setOpen(open === "ignore" ? null : "ignore")}
        >
          Ignore
        </button>
      </div>

      {open === "apply" && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <label className="label text-sm" htmlFor="target-invoice">
            Apply these sats to
          </label>
          <select
            id="target-invoice"
            className="input"
            value={invoiceId}
            onChange={(event) => setInvoiceId(event.target.value)}
          >
            {invoiceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint">
            The normal rules still apply: a settled invoice will not be paid twice, and an expired
            one records this as a late payment.
          </p>
          <button
            type="button"
            className="btn-primary mt-3"
            disabled={pending || !invoiceId}
            onClick={() => run(() => applyToInvoice(invoiceId))}
          >
            {pending ? "Applying…" : "Apply payment"}
          </button>
        </div>
      )}

      {(open === "refund" || open === "ignore") && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <label className="label text-sm" htmlFor="note">
            Note <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            id="note"
            className="input"
            value={note}
            placeholder={
              open === "refund" ? "Refund reference or tx id" : "Why this is being set aside"
            }
            onChange={(event) => setNote(event.target.value)}
          />
          {open === "refund" && (
            <p className="hint">
              SatsInvoice does not send coins. This records your decision — make the actual refund
              in your provider&apos;s dashboard.
            </p>
          )}
          <button
            type="button"
            className={open === "refund" ? "btn-danger mt-3" : "btn-secondary mt-3"}
            disabled={pending}
            onClick={() => run(() => (open === "refund" ? markRefunded(note) : ignore(note)))}
          >
            {pending ? "Saving…" : open === "refund" ? "Mark refunded" : "Ignore payment"}
          </button>
        </div>
      )}

      {feedback?.error && (
        <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{feedback.error}</p>
      )}
      {feedback?.message && (
        <p className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{feedback.message}</p>
      )}
    </div>
  );
}
