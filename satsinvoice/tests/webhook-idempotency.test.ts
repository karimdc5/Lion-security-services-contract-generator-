import { beforeEach, describe, expect, it } from "vitest";
import { applyProviderEvent, type ApplyOptions } from "@/lib/payments/apply";
import type { ProviderEvent, ProviderEventType } from "@/lib/payments/provider";
import { FakePaymentStore } from "./fake-store";
import { RATE_CENTS, T_AFTER_EXPIRY, T_BEFORE_EXPIRY, invoice } from "./helpers";

const EXPECTED_SATS = 76_923;
const PROVIDER_INVOICE_ID = "mock_abc123";

let store: FakePaymentStore;
let options: ApplyOptions;

function seedInvoice(state = invoice()) {
  const stored = store.addInvoice({
    id: "inv_1",
    userId: "user_1",
    publicId: "pub_1",
    provider: "mock",
    state,
  });
  stored.providerInvoiceIdForTest = PROVIDER_INVOICE_ID;
  return stored;
}

function event(
  overrides: Partial<ProviderEvent> & { providerPaymentId: string },
): ProviderEvent {
  return {
    type: "payment.settled" as ProviderEventType,
    providerInvoiceId: PROVIDER_INVOICE_ID,
    amountSats: EXPECTED_SATS,
    receivedAt: T_BEFORE_EXPIRY,
    raw: { note: "mock payload" },
    ...overrides,
  };
}

beforeEach(() => {
  store = new FakePaymentStore();
  options = { provider: "mock", fallbackBtcRateUsdCents: RATE_CENTS, store };
});

describe("idempotency", () => {
  it("applies the same webhook exactly once", async () => {
    seedInvoice();
    const payload = event({ providerPaymentId: "pay_1" });

    const first = await applyProviderEvent(payload, options);
    const second = await applyProviderEvent(payload, options);

    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");

    expect(store.events).toHaveLength(1);
    expect(store.eventsFor("pay_1")).toHaveLength(1);
    expect(store.invoices.get("inv_1")!.state.status).toBe("paid");
    expect(store.invoices.get("inv_1")!.state.amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("leaves an audit trail for the ignored replay", async () => {
    seedInvoice();
    const payload = event({ providerPaymentId: "pay_1" });
    await applyProviderEvent(payload, options);
    await applyProviderEvent(payload, options);

    expect(store.audits.map((a) => a.action)).toEqual([
      "payment.settled",
      "webhook.duplicate_ignored",
    ]);
  });

  it("survives ten replays without moving money again", async () => {
    seedInvoice();
    const payload = event({ providerPaymentId: "pay_1" });
    for (let i = 0; i < 10; i += 1) await applyProviderEvent(payload, options);

    expect(store.events).toHaveLength(1);
    expect(store.invoices.get("inv_1")!.state.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(store.invoices.get("inv_1")!.state.overpaySats).toBe(0);
  });

  it("holds under concurrent delivery of the same webhook", async () => {
    seedInvoice();
    const payload = event({ providerPaymentId: "pay_1" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyProviderEvent(payload, options)),
    );

    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    expect(store.events).toHaveLength(1);
    expect(store.invoices.get("inv_1")!.state.amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("does not double-credit two concurrent DIFFERENT payments", async () => {
    seedInvoice();

    await Promise.all([
      applyProviderEvent(event({ providerPaymentId: "pay_1" }), options),
      applyProviderEvent(event({ providerPaymentId: "pay_2" }), options),
    ]);

    const state = store.invoices.get("inv_1")!.state;
    expect(state.status).toBe("paid");
    // The second payment must not inflate the invoice; it goes to the inbox.
    expect(state.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(store.events).toHaveLength(2);
    expect(store.unmatched).toHaveLength(1);
    expect(store.unmatched[0].reason).toBe("duplicate_invoice_payment");
  });
});

describe("routing", () => {
  it("sends a second distinct payment to the unmatched inbox", async () => {
    seedInvoice();
    await applyProviderEvent(event({ providerPaymentId: "pay_1" }), options);
    const second = await applyProviderEvent(event({ providerPaymentId: "pay_2" }), options);

    expect(second.status).toBe("applied");
    expect(second.kind).toBe("unmatched");
    expect(store.unmatched).toHaveLength(1);
    expect(store.unmatched[0]).toMatchObject({
      providerPaymentId: "pay_2",
      userId: "user_1",
      invoiceId: "inv_1",
      reason: "duplicate_invoice_payment",
      amountSats: EXPECTED_SATS,
    });
    expect(store.invoices.get("inv_1")!.state.reviewFlag).toBe(true);
  });

  it("records a late payment against the invoice and in the inbox", async () => {
    seedInvoice();
    const result = await applyProviderEvent(
      event({ providerPaymentId: "pay_late", receivedAt: T_AFTER_EXPIRY }),
      options,
    );

    expect(result.kind).toBe("late");
    const state = store.invoices.get("inv_1")!.state;
    expect(state.status).toBe("expired");
    expect(state.paidAt).toBeNull();
    expect(state.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(state.reviewFlag).toBe(true);
    expect(store.unmatched[0].reason).toBe("late_payment");
    expect(store.events[0].kind).toBe("late");
  });

  it("records money for an invoice it cannot find", async () => {
    const result = await applyProviderEvent(
      event({ providerPaymentId: "pay_ghost", providerInvoiceId: "mock_nobody" }),
      options,
    );

    expect(result.status).toBe("unknown_invoice");
    expect(store.events).toHaveLength(1);
    expect(store.events[0].invoiceId).toBeNull();
    expect(store.unmatched[0].reason).toBe("unknown_invoice");
    // Valued at the fallback rate so the inbox can show USD.
    expect(store.unmatched[0].amountUsdCents).toBe(5_000);
  });

  it("ignores a replay of an unknown-invoice payment too", async () => {
    const payload = event({ providerPaymentId: "pay_ghost", providerInvoiceId: "mock_nobody" });
    await applyProviderEvent(payload, options);
    const second = await applyProviderEvent(payload, options);

    expect(second.status).toBe("duplicate");
    expect(store.events).toHaveLength(1);
    expect(store.unmatched).toHaveLength(1);
  });

  it("values the payment event in USD at the invoice's frozen rate", async () => {
    seedInvoice();
    await applyProviderEvent(event({ providerPaymentId: "pay_1" }), options);
    expect(store.events[0].amountUsdCents).toBe(5_000);
  });

  it("moves an unpaid invoice to pending without crediting sats", async () => {
    seedInvoice();
    const result = await applyProviderEvent(
      event({ providerPaymentId: "pay_pending", type: "payment.pending" }),
      options,
    );

    expect(result.kind).toBe("pending");
    const state = store.invoices.get("inv_1")!.state;
    expect(state.status).toBe("pending");
    expect(state.amountSatsReceived).toBe(0);
  });

  it("records a provider-reported refund", async () => {
    seedInvoice();
    await applyProviderEvent(event({ providerPaymentId: "pay_1" }), options);
    const result = await applyProviderEvent(
      event({ providerPaymentId: "refund_1", type: "payment.refunded" }),
      options,
    );

    expect(result.kind).toBe("refund");
    expect(store.invoices.get("inv_1")!.state.status).toBe("refunded");
  });

  it("stores the raw provider payload on the event", async () => {
    seedInvoice();
    await applyProviderEvent(
      event({ providerPaymentId: "pay_1", raw: { hello: "world" } }),
      options,
    );
    expect(store.events[0].rawPayload).toEqual({ hello: "world" });
  });
});
