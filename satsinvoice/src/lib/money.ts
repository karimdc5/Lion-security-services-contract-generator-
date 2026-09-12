/**
 * All money math in SatsInvoice is integer math.
 *
 *  - USD amounts are integer cents.
 *  - BTC amounts are integer sats.
 *  - The BTC price is integer cents per 1 BTC (e.g. $65,000.00 -> 6_500_000).
 *
 * Floats never touch a stored amount. The only rounding happens at the two
 * conversion boundaries below, and it is half-up and explicit.
 */

export const SATS_PER_BTC = 100_000_000;

export class MoneyError extends Error {}

function assertInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer, got ${value}`);
  }
}

function assertRate(btcRateUsdCents: number): void {
  assertInt(btcRateUsdCents, "btcRateUsdCents");
  if (btcRateUsdCents <= 0) {
    throw new MoneyError(`btcRateUsdCents must be positive, got ${btcRateUsdCents}`);
  }
}

/**
 * How many sats a USD amount is worth at a frozen rate.
 *
 *   sats = usdCents * SATS_PER_BTC / btcRateUsdCents
 *
 * Rounded half-up, so the client is never asked for fewer sats than the
 * invoice is worth by more than half a sat.
 */
export function usdCentsToSats(amountUsdCents: number, btcRateUsdCents: number): number {
  assertInt(amountUsdCents, "amountUsdCents");
  assertRate(btcRateUsdCents);
  if (amountUsdCents < 0) throw new MoneyError("amountUsdCents must not be negative");
  return Math.round((amountUsdCents * SATS_PER_BTC) / btcRateUsdCents);
}

/** How many USD cents a sat amount is worth at a frozen rate. */
export function satsToUsdCents(sats: number, btcRateUsdCents: number): number {
  assertInt(sats, "sats");
  assertRate(btcRateUsdCents);
  return Math.round((sats * btcRateUsdCents) / SATS_PER_BTC);
}

/** "65000.00" or 65000 -> 6_500_000 cents per BTC. */
export function btcRateUsdToCents(rateUsd: number | string): number {
  const parsed = typeof rateUsd === "string" ? Number(rateUsd) : rateUsd;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MoneyError(`Invalid BTC/USD rate: ${rateUsd}`);
  }
  return Math.round(parsed * 100);
}

/** 6_500_000 -> 65000 (dollars, may have cents). */
export function btcRateCentsToUsd(btcRateUsdCents: number): number {
  return btcRateUsdCents / 100;
}

/** "50.00" / "50" / "$50.00" -> 5000. Throws on anything else. */
export function parseUsdToCents(input: string): number {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`Invalid USD amount: ${input}`);
  }
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 5000 -> "$50.00" */
export function formatUsdCents(amountUsdCents: number): string {
  return USD.format(amountUsdCents / 100);
}

/** 5000 -> "50.00" (for CSV, no symbol, no thousands separators). */
export function usdCentsToDecimalString(amountUsdCents: number): string {
  const sign = amountUsdCents < 0 ? "-" : "";
  const abs = Math.abs(amountUsdCents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 76923 -> "76,923 sats" */
export function formatSats(sats: number): string {
  return `${new Intl.NumberFormat("en-US").format(sats)} sats`;
}
