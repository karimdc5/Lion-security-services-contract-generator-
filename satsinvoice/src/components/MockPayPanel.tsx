"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Scenario {
  key: string;
  label: string;
  description: string;
  tone?: "primary" | "warn";
}

const SCENARIOS: Scenario[] = [
  { key: "exact", label: "Pay exact", description: "Settles the full amount before expiry.", tone: "primary" },
  { key: "underpay", label: "Underpay", description: "Sends 60% of the invoice." },
  { key: "overpay", label: "Overpay", description: "Sends 115% of the invoice." },
  { key: "late", label: "Pay after expiry", description: "Settles in full, timestamped after the deadline.", tone: "warn" },
  { key: "twice", label: "Pay twice", description: "Two separate payments, two payment ids.", tone: "warn" },
  { key: "duplicate", label: "Replay same webhook", description: "Fires one payment id twice. Must apply once.", tone: "warn" },
  { key: "pending", label: "Mark in-flight", description: "An unconfirmed payment notice. Nothing settles." },
];

interface Line {
  scenario: string;
  status: number;
  body: string;
}

export function MockPayPanel({
  providerInvoiceId,
  expectedSats,
  expiresAt,
  alreadySettled,
}: {
  providerInvoiceId: string;
  expectedSats: number;
  expiresAt: string | null;
  alreadySettled: boolean;
}) {
  const router = useRouter();
  const [log, setLog] = useState<Line[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function fire(scenario: string) {
    setBusy(scenario);
    try {
      const response = await fetch("/api/mock/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, providerInvoiceId, expectedSats, expiresAt }),
      });
      const body = await response.text();
      setLog((prev) => [{ scenario, status: response.status, body }, ...prev].slice(0, 8));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card mt-6 p-6">
      <h2 className="text-sm font-semibold">Simulate a payment</h2>
      {alreadySettled && (
        <p className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
          This invoice already has a settled payment. Anything more should land in the unmatched
          inbox rather than paying it twice.
        </p>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.key}
            type="button"
            disabled={busy !== null}
            onClick={() => fire(scenario.key)}
            className={`rounded-lg border p-3 text-left transition disabled:opacity-50 ${
              scenario.tone === "primary"
                ? "border-accent bg-accent-soft hover:bg-accent/10"
                : scenario.tone === "warn"
                  ? "border-warn/30 bg-warn-soft/60 hover:bg-warn-soft"
                  : "border-line bg-surface hover:bg-canvas"
            }`}
          >
            <span className="block text-sm font-semibold">
              {busy === scenario.key ? "Sending…" : scenario.label}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{scenario.description}</span>
          </button>
        ))}
      </div>

      {log.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">
            Webhook responses
          </h3>
          <ul className="mt-2 space-y-1.5">
            {log.map((line, index) => (
              <li
                key={index}
                className="rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs break-all"
              >
                <span className={line.status < 300 ? "text-good" : "text-bad"}>
                  {line.status}
                </span>{" "}
                <span className="text-faint">{line.scenario}</span> · {line.body}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
