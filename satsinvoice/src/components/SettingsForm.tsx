"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/actions/invoices";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

export function ProfileForm({
  action,
  displayName,
  payoutNote,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  displayName: string;
  payoutNote: string;
}) {
  const [state, formAction] = useActionState(action, {});

  return (
    <form action={formAction} className="card p-6">
      <h2 className="text-sm font-semibold">Profile</h2>
      <div className="mt-4 space-y-4">
        <div>
          <label className="label" htmlFor="displayName">
            Name your clients see
          </label>
          <input
            id="displayName"
            name="displayName"
            className="input"
            defaultValue={displayName}
            required
          />
          {state.fieldErrors?.displayName && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.displayName}</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="payoutNote">
            Note on receipts and expired links
          </label>
          <input
            id="payoutNote"
            name="payoutNote"
            className="input"
            defaultValue={payoutNote}
            placeholder="Questions? reply to this email and I'll sort it out."
          />
          <p className="hint">Shown to clients. Keep it human.</p>
        </div>
      </div>
      <div className="mt-5">
        <Submit />
      </div>
    </form>
  );
}

export function AutoReissueToggle({
  enabled,
  action,
}: {
  enabled: boolean;
  action: (enabled: boolean) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(enabled);

  return (
    <div className="card p-6">
      <h2 className="text-sm font-semibold">Expired links</h2>
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-[var(--color-accent)]"
          checked={on}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.checked;
            setOn(next);
            startTransition(() => action(next));
          }}
        />
        <span>
          <span className="block text-sm font-medium">
            Let clients generate a new invoice themselves
          </span>
          <span className="hint block">
            When an invoice expires unpaid, the client sees a “Generate new invoice” button for the
            same amount at today&apos;s rate. Off by default — with it off they see
            “This link expired. Contact you.”
          </span>
        </span>
      </label>
    </div>
  );
}
