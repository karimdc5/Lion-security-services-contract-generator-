"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/actions/invoices";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Creating invoice…" : "Create invoice"}
    </button>
  );
}

export function NewInvoiceForm({
  action,
  expiryOptions,
  defaultExpirySeconds,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  expiryOptions: ReadonlyArray<{ label: string; seconds: number }>;
  defaultExpirySeconds: number;
}) {
  const [state, formAction] = useActionState(action, {});
  const [expiry, setExpiry] = useState(defaultExpirySeconds);

  return (
    <form action={formAction} className="card mt-6 space-y-5 p-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="clientName">
            Client name
          </label>
          <input id="clientName" name="clientName" className="input" placeholder="Acme Co." required />
          {state.fieldErrors?.clientName && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.clientName}</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="clientEmail">
            Client email <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            id="clientEmail"
            name="clientEmail"
            type="email"
            className="input"
            placeholder="billing@acme.co"
          />
          {state.fieldErrors?.clientEmail && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.clientEmail}</p>
          )}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="description">
          Description
        </label>
        <input
          id="description"
          name="description"
          className="input"
          placeholder="Landing page build — October"
          required
        />
        <p className="hint">Your client sees this. Keep it to what they are paying for.</p>
        {state.fieldErrors?.description && (
          <p className="mt-1 text-sm text-bad">{state.fieldErrors.description}</p>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="amountUsd">
            Amount (USD)
          </label>
          <div className="relative">
            <span className="absolute top-1/2 left-3 -translate-y-1/2 pt-0.5 text-muted">$</span>
            <input
              id="amountUsd"
              name="amountUsd"
              className="input tnum pl-7 text-lg font-semibold"
              placeholder="50.00"
              inputMode="decimal"
              required
            />
          </div>
          <p className="hint">The sats amount is locked in at today&apos;s rate when you create it.</p>
          {state.fieldErrors?.amountUsd && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.amountUsd}</p>
          )}
        </div>

        <div>
          <span className="label">Expires in</span>
          <input type="hidden" name="expirySeconds" value={expiry} />
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {expiryOptions.map((option) => (
              <button
                key={option.seconds}
                type="button"
                onClick={() => setExpiry(option.seconds)}
                aria-pressed={expiry === option.seconds}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  expiry === option.seconds
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface text-muted hover:bg-canvas"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {state.fieldErrors?.expirySeconds && (
            <p className="mt-1 text-sm text-bad">{state.fieldErrors.expirySeconds}</p>
          )}
        </div>
      </div>

      {state.error && (
        <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{state.error}</p>
      )}

      <div className="flex items-center gap-3 border-t border-line pt-5">
        <Submit />
        <p className="text-sm text-muted">You will get a link to send.</p>
      </div>
    </form>
  );
}
