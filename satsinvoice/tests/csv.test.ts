import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, type CsvRow, csvCell, toCsv } from "@/lib/csv";

function row(overrides: Partial<CsvRow> = {}): CsvRow {
  const base = Object.fromEntries(CSV_COLUMNS.map((column) => [column, ""])) as CsvRow;
  return { ...base, ...overrides };
}

describe("csvCell", () => {
  it("leaves plain values alone", () => {
    expect(csvCell("Acme Co")).toBe("Acme Co");
  });

  it("quotes values containing a comma", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
  });

  it("doubles embedded quotes", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes values containing newlines", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });
});

describe("toCsv", () => {
  it("writes the documented header", () => {
    expect(toCsv([]).split("\r\n")[0]).toBe(
      "date_utc,invoice_public_id,client,description,status,amount_usd," +
        "amount_sats_expected,amount_sats_received,btc_usd_rate," +
        "payment_hash_or_provider_id,kind",
    );
  });

  it("escapes a description that would otherwise break the row", () => {
    const csv = toCsv([row({ client: "Acme, Inc.", description: 'Logo "v2"', kind: "invoice" })]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"Acme, Inc."');
    expect(line).toContain('"Logo ""v2"""');
    // Header + one row + trailing newline.
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
  });

  it("ends with a newline", () => {
    expect(toCsv([row({ kind: "invoice" })]).endsWith("\r\n")).toBe(true);
  });
});
