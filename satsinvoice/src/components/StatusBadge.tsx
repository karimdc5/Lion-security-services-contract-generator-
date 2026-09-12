import type { InvoiceState } from "@/lib/invoice-state";
import { displayStatus } from "@/lib/invoice-state";

type Tone = "good" | "warn" | "bad" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-canvas text-muted border border-line",
};

function toneFor(state: InvoiceState): Tone {
  if (state.status === "paid" || state.status === "overpaid") return "good";
  if (state.status === "underpaid") return state.writtenOff ? "neutral" : "warn";
  if (state.status === "expired") return state.amountSatsReceived > 0 ? "bad" : "neutral";
  if (state.status === "canceled" || state.status === "draft") return "neutral";
  if (state.status === "refunded") return "bad";
  if (state.status === "pending") return "accent";
  return "accent"; // unpaid — awaiting the client
}

export function StatusBadge({ state }: { state: InvoiceState }) {
  const tone = toneFor(state);
  return (
    <span className={`badge ${TONES[tone]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {displayStatus(state)}
    </span>
  );
}

export function ReviewFlag() {
  return (
    <span className={`badge ${TONES.bad}`} title="Money arrived in a way that needs a look">
      needs review
    </span>
  );
}
