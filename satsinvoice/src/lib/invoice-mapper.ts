import type { Invoice } from "@prisma/client";
import type { InvoiceState } from "@/lib/invoice-state";

/** The state-machine view of a stored invoice. */
export function toState(invoice: Invoice): InvoiceState {
  return {
    status: invoice.status,
    expiresAt: invoice.expiresAt,
    amountUsdCents: invoice.amountUsdCents,
    btcRateUsdCents: invoice.btcRateUsdCents,
    amountSatsExpected: invoice.amountSatsExpected,
    amountSatsReceived: invoice.amountSatsReceived,
    overpaySats: invoice.overpaySats,
    overpayUsdCents: invoice.overpayUsdCents,
    paidAt: invoice.paidAt,
    writtenOff: invoice.writtenOff,
    reviewFlag: invoice.reviewFlag,
  };
}

/** The columns a state transition is allowed to write. */
export function toUpdateData(state: InvoiceState) {
  return {
    status: state.status,
    expiresAt: state.expiresAt,
    amountSatsReceived: state.amountSatsReceived,
    overpaySats: state.overpaySats,
    overpayUsdCents: state.overpayUsdCents,
    paidAt: state.paidAt,
    writtenOff: state.writtenOff,
    reviewFlag: state.reviewFlag,
  };
}

export function sameState(a: InvoiceState, b: InvoiceState): boolean {
  return (
    a.status === b.status &&
    a.amountSatsReceived === b.amountSatsReceived &&
    a.overpaySats === b.overpaySats &&
    a.overpayUsdCents === b.overpayUsdCents &&
    a.writtenOff === b.writtenOff &&
    a.reviewFlag === b.reviewFlag &&
    a.paidAt?.getTime() === b.paidAt?.getTime() &&
    a.expiresAt?.getTime() === b.expiresAt?.getTime()
  );
}
