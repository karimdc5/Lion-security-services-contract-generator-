/**
 * The webhook path against a real Postgres, so the unique index — not a
 * hand-rolled in-memory guard — is what enforces idempotency.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyProviderEvent, type ApplyOptions } from "@/lib/payments/apply";
import { PrismaPaymentStore } from "@/lib/payments/prisma-store";
import type { ProviderEvent } from "@/lib/payments/provider";
import { RATE_CENTS, makeInvoice, makeUser, prisma, resetDatabase } from "./helpers";

const EXPECTED_SATS = 76_923; // $50 at $65,000/BTC

const options: ApplyOptions = {
  provider: "mock",
  fallbackBtcRateUsdCents: RATE_CENTS,
  store: new PrismaPaymentStore(prisma),
};

function event(
  providerInvoiceId: string,
  overrides: Partial<ProviderEvent> & { providerPaymentId: string },
): ProviderEvent {
  return {
    type: "payment.settled",
    providerInvoiceId,
    amountSats: EXPECTED_SATS,
    receivedAt: new Date(),
    raw: { simulated: true },
    ...overrides,
  };
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("PrismaPaymentStore", () => {
  it("settles an exact payment", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });

    const result = await applyProviderEvent(
      event(invoice.providerInvoiceId!, { providerPaymentId: "pay_1" }),
      options,
    );

    expect(result.status).toBe("applied");
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("paid");
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(after.paidAt).not.toBeNull();
  });

  it("writes exactly one PaymentEvent for a replayed webhook", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });
    const payload = event(invoice.providerInvoiceId!, { providerPaymentId: "pay_1" });

    await applyProviderEvent(payload, options);
    const second = await applyProviderEvent(payload, options);

    expect(second.status).toBe("duplicate");
    expect(await prisma.paymentEvent.count()).toBe(1);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(after.overpaySats).toBe(0);
  });

  it("holds when the same webhook is delivered concurrently", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });
    const payload = event(invoice.providerInvoiceId!, { providerPaymentId: "pay_race" });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => applyProviderEvent(payload, options)),
    );

    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(await prisma.paymentEvent.count()).toBe(1);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("serialises two different concurrent payments without double-crediting", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });

    await Promise.all([
      applyProviderEvent(event(invoice.providerInvoiceId!, { providerPaymentId: "pay_a" }), options),
      applyProviderEvent(event(invoice.providerInvoiceId!, { providerPaymentId: "pay_b" }), options),
    ]);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("paid");
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(await prisma.paymentEvent.count()).toBe(2);
    expect(await prisma.unmatchedPayment.count()).toBe(1);
  });

  it("parks a late payment on the invoice and in the inbox", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await applyProviderEvent(
      event(invoice.providerInvoiceId!, { providerPaymentId: "pay_late" }),
      options,
    );

    expect(result.kind).toBe("late");
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("expired");
    expect(after.paidAt).toBeNull();
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(after.reviewFlag).toBe(true);

    const unmatched = await prisma.unmatchedPayment.findMany();
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].reason).toBe("late_payment");
    expect(unmatched[0].userId).toBe(user.id);
  });

  it("records money for an invoice it has never seen", async () => {
    const result = await applyProviderEvent(
      event("mock_does_not_exist", { providerPaymentId: "pay_ghost" }),
      options,
    );

    expect(result.status).toBe("unknown_invoice");
    const events = await prisma.paymentEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].invoiceId).toBeNull();
    expect(events[0].kind).toBe("unmatched");
    expect((await prisma.unmatchedPayment.findMany())[0].reason).toBe("unknown_invoice");
  });

  it("stores the raw payload verbatim for later forensics", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });
    await applyProviderEvent(
      event(invoice.providerInvoiceId!, {
        providerPaymentId: "pay_1",
        raw: { nested: { id: "abc" }, amount: 1 },
      }),
      options,
    );

    const stored = await prisma.paymentEvent.findUniqueOrThrow({
      where: { providerPaymentId: "pay_1" },
    });
    expect(stored.rawPayload).toEqual({ nested: { id: "abc" }, amount: 1 });
  });

  it("leaves an audit trail for every payment decision", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });
    await applyProviderEvent(
      event(invoice.providerInvoiceId!, { providerPaymentId: "pay_1" }),
      options,
    );

    const logs = await prisma.auditLog.findMany({ where: { invoiceId: invoice.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("payment.settled");
    expect(logs[0].actor).toBe("webhook:mock");
  });
});
