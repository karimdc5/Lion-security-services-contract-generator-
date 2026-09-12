import { describe, expect, it } from "vitest";
import {
  MoneyError,
  btcRateUsdToCents,
  formatUsdCents,
  parseUsdToCents,
  satsToUsdCents,
  usdCentsToDecimalString,
  usdCentsToSats,
} from "@/lib/money";

const RATE = 6_500_000; // $65,000.00 / BTC

describe("usdCentsToSats", () => {
  it("converts $50 at $65,000/BTC", () => {
    expect(usdCentsToSats(5_000, RATE)).toBe(76_923);
  });

  it("converts a whole BTC", () => {
    expect(usdCentsToSats(RATE, RATE)).toBe(100_000_000);
  });

  it("rejects a non-positive rate", () => {
    expect(() => usdCentsToSats(5_000, 0)).toThrow(MoneyError);
  });

  it("rejects non-integer cents", () => {
    expect(() => usdCentsToSats(50.5, RATE)).toThrow(MoneyError);
  });
});

describe("satsToUsdCents", () => {
  it("round-trips $50 back to $50", () => {
    expect(satsToUsdCents(usdCentsToSats(5_000, RATE), RATE)).toBe(5_000);
  });

  it("values a whole BTC at the rate", () => {
    expect(satsToUsdCents(100_000_000, RATE)).toBe(RATE);
  });
});

describe("parseUsdToCents", () => {
  it.each([
    ["50", 5_000],
    ["50.00", 5_000],
    ["$50.5", 5_050],
    ["1,250.99", 125_099],
    ["0.01", 1],
  ])("parses %s", (input, expected) => {
    expect(parseUsdToCents(input)).toBe(expected);
  });

  it.each(["", "abc", "50.123", "-5", "5,0.0.0"])("rejects %s", (input) => {
    expect(() => parseUsdToCents(input)).toThrow(MoneyError);
  });
});

describe("formatting", () => {
  it("formats cents as USD", () => {
    expect(formatUsdCents(5_000)).toBe("$50.00");
    expect(formatUsdCents(125_099)).toBe("$1,250.99");
  });

  it("formats cents for CSV without separators", () => {
    expect(usdCentsToDecimalString(125_099)).toBe("1250.99");
    expect(usdCentsToDecimalString(5)).toBe("0.05");
  });

  it("converts a dollar rate to cents", () => {
    expect(btcRateUsdToCents(65_000)).toBe(6_500_000);
    expect(btcRateUsdToCents("65000.49")).toBe(6_500_049);
  });
});
