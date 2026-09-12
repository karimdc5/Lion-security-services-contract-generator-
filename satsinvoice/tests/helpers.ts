import type { InvoiceState } from "@/lib/invoice-state";
import { usdCentsToSats } from "@/lib/money";

export const RATE_CENTS = 6_500_000; // $65,000.00 / BTC

export const T0 = new Date("2026-01-01T12:00:00.000Z");
export const T_BEFORE_EXPIRY = new Date("2026-01-01T12:30:00.000Z");
export const T_EXPIRY = new Date("2026-01-01T13:00:00.000Z");
export const T_AFTER_EXPIRY = new Date("2026-01-01T13:30:00.000Z");

/** A live $50 invoice that expires at T_EXPIRY. */
export function invoice(overrides: Partial<InvoiceState> = {}): InvoiceState {
  const amountUsdCents = overrides.amountUsdCents ?? 5_000;
  const btcRateUsdCents = overrides.btcRateUsdCents ?? RATE_CENTS;
  return {
    status: "unpaid",
    expiresAt: T_EXPIRY,
    amountUsdCents,
    btcRateUsdCents,
    amountSatsExpected: usdCentsToSats(amountUsdCents, btcRateUsdCents),
    amountSatsReceived: 0,
    overpaySats: 0,
    overpayUsdCents: 0,
    paidAt: null,
    writtenOff: false,
    reviewFlag: false,
    ...overrides,
  };
}

let seq = 0;
export function payment(amountSats: number, receivedAt = T_BEFORE_EXPIRY) {
  seq += 1;
  return { providerPaymentId: `pay_${seq}`, amountSats, receivedAt };
}
