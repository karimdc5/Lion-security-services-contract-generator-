/**
 * The acceptance criteria, end to end against a real database.
 *
 * Each test is one line from the spec. If any of these fail, the app is a
 * failure no matter how good it looks.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildLedgerRows } from "@/lib/csv";
import { toState } from "@/lib/invoice-mapper";
import { displayStatus, remainingUsdCents } from "@/lib/invoice-state";
import { formatUsdCents } from "@/lib/money";
import { applyProviderEvent, type ApplyOptions } from "@/lib/payments/apply";
import { PrismaPaymentStore } from "@/lib/payments/prisma-store";
import type { ProviderEvent } from "@/lib/payments/provider";
import { RATE_CENTS, makeInvoice, makeUser, prisma, resetDatabase } from "./helpers";

const FIFTY_DOLLARS = 5_000;
const EXPECTED_SATS = 76_923; // $50 at $65,000/BTC

const options: ApplyOptions = {
  provider: "mock",
  fallbackBtcRateUsdCents: RATE_CENTS,
  store: new PrismaPaymentStore(prisma),
};

function pay(
  providerInvoiceId: string,
  providerPaymentId: string,
  amountSats: number,
  receivedAt = new Date(),
): ProviderEvent {
  return {
    type: "payment.settled",
    providerInvoiceId,
    providerPaymentId,
    amountSats,
    receivedAt,
    raw: { simulated: true, amount_sats: amountSats },
  };
}

async function reload(id: string) {
  return prisma.invoice.findUniqueOrThrow({ where: { id } });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("acceptance", () => {
  it("1. $50 invoice, exact pay -> paid, receipt shows $50", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id, amountUsdCents: FIFTY_DOLLARS });

    await applyProviderEvent(pay(invoice.providerInvoiceId!, "pay_1", EXPECTED_SATS), options);

    const after = await reload(invoice.id);
    expect(after.status).toBe("paid");
    // The receipt renders amountUsdCents — the client's dollar figure never moves.
    expect(formatUsdCents(after.amountUsdCents)).toBe("$50.00");
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("2. underpay -> underpaid, with the remainder shown", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id, amountUsdCents: FIFTY_DOLLARS });

    await applyProviderEvent(pay(invoice.providerInvoiceId!, "pay_short", 46_154), options);

    const after = await reload(invoice.id);
    expect(after.status).toBe("underpaid");
    expect(after.paidAt).toBeNull();
    // 60% paid, so roughly $20 left.
    expect(remainingUsdCents(toState(after))).toBe(2_000);
  });

  it("3. overpay -> paid, with the overpay recorded", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id, amountUsdCents: FIFTY_DOLLARS });

    await applyProviderEvent(
      pay(invoice.providerInvoiceId!, "pay_over", EXPECTED_SATS + 10_000),
      options,
    );

    const after = await reload(invoice.id);
    expect(after.status).toBe("paid");
    expect(after.overpaySats).toBe(10_000);
    expect(after.overpayUsdCents).toBe(650);
    expect(displayStatus(toState(after))).toBe("paid (overpaid)");
  });

  it("4. expire with no payment -> expired", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const { withExpirySwept } = await import("@/lib/invoices");
    const after = await withExpirySwept(invoice);

    expect(after.status).toBe("expired");
    expect(after.amountSatsReceived).toBe(0);
  });

  it("5. pay after expiry -> money visible and flagged, never silently paid on time", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await applyProviderEvent(
      pay(invoice.providerInvoiceId!, "pay_late", EXPECTED_SATS),
      options,
    );

    expect(result.kind).toBe("late");

    const after = await reload(invoice.id);
    expect(after.status).not.toBe("paid");
    expect(after.paidAt).toBeNull();
    expect(after.reviewFlag).toBe(true);
    // The money is not lost: it is on the invoice AND in the inbox.
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);

    const inbox = await prisma.unmatchedPayment.findMany({ where: { resolution: "open" } });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].reason).toBe("late_payment");
    expect(inbox[0].amountSats).toBe(EXPECTED_SATS);
  });

  it("6. same webhook twice -> one payment event", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });
    const payload = pay(invoice.providerInvoiceId!, "pay_once", EXPECTED_SATS);

    await applyProviderEvent(payload, options);
    const second = await applyProviderEvent(payload, options);

    expect(second.status).toBe("duplicate");
    expect(await prisma.paymentEvent.count()).toBe(1);
    expect((await reload(invoice.id)).amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("7. two payments on one invoice -> the second lands in unmatched", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id });

    await applyProviderEvent(pay(invoice.providerInvoiceId!, "pay_1", EXPECTED_SATS), options);
    await applyProviderEvent(pay(invoice.providerInvoiceId!, "pay_2", EXPECTED_SATS), options);

    const after = await reload(invoice.id);
    expect(after.status).toBe("paid");
    // The invoice is paid once, for the invoiced amount. Not twice.
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(after.overpaySats).toBe(0);

    const inbox = await prisma.unmatchedPayment.findMany();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].reason).toBe("duplicate_invoice_payment");
    expect(inbox[0].providerPaymentId).toBe("pay_2");

    // Both payments are on the record; only one moved the invoice.
    expect(await prisma.paymentEvent.count()).toBe(2);
  });

  it("8. the CSV contains the paid invoice", async () => {
    const user = await makeUser();
    const invoice = await makeInvoice({ userId: user.id, amountUsdCents: FIFTY_DOLLARS });
    await applyProviderEvent(pay(invoice.providerInvoiceId!, "pay_1", EXPECTED_SATS), options);

    const rows = await buildLedgerRows({
      userId: user.id,
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });

    const invoiceRow = rows.find((r) => r.kind === "invoice");
    expect(invoiceRow).toMatchObject({
      invoice_public_id: invoice.publicId,
      client: "Acme Co.",
      status: "paid",
      amount_usd: "50.00",
      amount_sats_expected: String(EXPECTED_SATS),
      amount_sats_received: String(EXPECTED_SATS),
      btc_usd_rate: "65000.00",
    });

    const paymentRow = rows.find((r) => r.kind === "settled");
    expect(paymentRow).toMatchObject({
      payment_hash_or_provider_id: "pay_1",
      amount_usd: "50.00",
    });
  });

  it("9. the client page has a usable payment request on the happy path", async () => {
    // No bolt11 decoding happens anywhere in the client path — the page renders
    // the provider's string straight into a QR and a copy button.
    const { MockPaymentProvider } = await import("@/lib/payments/mock");
    const created = await new MockPaymentProvider().createInvoice({
      idempotencyKey: "invoice:test",
      amountUsdCents: FIFTY_DOLLARS,
      memo: "Landing page build",
      expiresInSeconds: 3_600,
      webhookUrl: "http://localhost:3000/api/webhooks/mock",
    });

    expect(created.paymentRequest).toMatch(/^lnbc\d+n1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
    expect(created.amountSats).toBe(EXPECTED_SATS);
    expect(created.paymentUrl).toContain(`/mock-pay/${created.providerInvoiceId}`);

    const QRCode = (await import("qrcode")).default;
    const dataUrl = await QRCode.toDataURL(created.paymentRequest);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("the unmatched inbox can apply parked money to another invoice, once", async () => {
    const user = await makeUser();
    const paidInvoice = await makeInvoice({ userId: user.id });
    const openInvoice = await makeInvoice({ userId: user.id });

    await applyProviderEvent(pay(paidInvoice.providerInvoiceId!, "pay_1", EXPECTED_SATS), options);
    await applyProviderEvent(pay(paidInvoice.providerInvoiceId!, "pay_2", EXPECTED_SATS), options);

    const parked = await prisma.unmatchedPayment.findFirstOrThrow({ where: { resolution: "open" } });

    // The inbox reuses the webhook path with a synthetic, stable payment id.
    const applyOnce = () =>
      applyProviderEvent(
        pay(openInvoice.providerInvoiceId!, `applied:${parked.id}`, parked.amountSats),
        options,
      );

    expect((await applyOnce()).status).toBe("applied");
    expect((await applyOnce()).status).toBe("duplicate");

    const after = await reload(openInvoice.id);
    expect(after.status).toBe("paid");
    expect(after.amountSatsReceived).toBe(EXPECTED_SATS);
  });
});
