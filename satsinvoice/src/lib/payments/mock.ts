/**
 * MockPaymentProvider — a stand-in for a real Lightning processor.
 *
 * It runs no node and talks to no network. It mints a fake bolt11 string and
 * points the client at an internal checkout page (`/mock-pay/[id]`) whose
 * buttons POST to the SAME webhook endpoint production will use. That is the
 * whole point: the payment path you test is the payment path that ships.
 *
 * The fake bolt11 uses the real bech32 charset and the real `lnbc<amount>n1`
 * prefix so QR rendering and copy/paste behave like production. It will NOT
 * decode in a real wallet — it is a mock, and the mock-pay page is the wallet.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { btcRateUsdToCents, usdCentsToSats } from "@/lib/money";
import {
  type CreateInvoiceInput,
  type CreatedInvoice,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderEventType,
  type ProviderInvoiceStatus,
  ProviderError,
  WebhookVerificationError,
} from "./provider";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32ish(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BECH32_CHARSET[bytes[i] % BECH32_CHARSET.length];
  return out;
}

/** `lnbc769230n1<data>` — amount is in nano-BTC, matching the bolt11 spec. */
export function fakeBolt11(amountSats: number): string {
  const nanoBtc = amountSats * 10; // 1 sat = 10 nano-BTC
  return `lnbc${nanoBtc}n1${bech32ish(100)}`;
}

export function signMockPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** The JSON shape the mock-pay page POSTs to the webhook route. */
export interface MockWebhookPayload {
  type: ProviderEventType;
  provider_invoice_id: string;
  provider_payment_id: string;
  amount_sats: number;
  /** ISO 8601. Lets tests and the "pay after expiry" button move time. */
  received_at?: string;
  memo?: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    if (input.amountUsdCents <= 0) {
      throw new ProviderError("amountUsdCents must be positive");
    }

    const btcRateUsd = env.mockBtcUsdRate;
    if (!Number.isFinite(btcRateUsd) || btcRateUsd <= 0) {
      throw new ProviderError(`MOCK_BTC_USD_RATE is not a usable rate: ${process.env.MOCK_BTC_USD_RATE}`);
    }

    const amountSats = usdCentsToSats(input.amountUsdCents, btcRateUsdToCents(btcRateUsd));

    // Derived from the idempotency key: calling twice with the same key yields
    // the same provider invoice, exactly like a real processor.
    const providerInvoiceId = `mock_${createHmac("sha256", "mock-provider")
      .update(input.idempotencyKey)
      .digest("hex")
      .slice(0, 24)}`;

    return {
      providerInvoiceId,
      paymentRequest: fakeBolt11(amountSats),
      paymentUrl: `${env.appUrl}/mock-pay/${providerInvoiceId}`,
      amountSats,
      btcRateUsd,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  /**
   * The mock has no backing service, so it reports what the webhook handler
   * has already recorded. Real providers answer from their own ledger; this is
   * here so the interface is honest and `getInvoice` is callable in dev.
   */
  async getInvoice(providerInvoiceId: string): Promise<ProviderInvoiceStatus> {
    const { prisma } = await import("@/lib/db");
    const invoice = await prisma.invoice.findUnique({
      where: { providerInvoiceId },
      select: { status: true, amountSatsReceived: true },
    });
    if (!invoice) throw new ProviderError(`Unknown mock invoice: ${providerInvoiceId}`);
    return { status: invoice.status, amountSatsReceived: invoice.amountSatsReceived };
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<ProviderEvent> {
    const secret = env.mockWebhookSecret;
    const provided = headers.get(MOCK_SIGNATURE_HEADER);

    if (env.mockSkipSignature || secret === "") {
      // Explicitly opted out via MOCK_SKIP_SIGNATURE so the endpoint can be
      // driven with plain curl. Never reachable for a real provider.
    } else if (!provided) {
      throw new WebhookVerificationError(`Missing ${MOCK_SIGNATURE_HEADER} header`);
    } else {
      const expected = Buffer.from(signMockPayload(rawBody, secret), "utf8");
      const actual = Buffer.from(provided, "utf8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new WebhookVerificationError("Bad mock webhook signature");
      }
    }

    return parseMockPayload(rawBody);
  }
}

export function parseMockPayload(rawBody: string): ProviderEvent {
  let payload: MockWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MockWebhookPayload;
  } catch {
    throw new WebhookVerificationError("Webhook body is not valid JSON");
  }

  const type = payload.type;
  if (type !== "payment.pending" && type !== "payment.settled" && type !== "payment.refunded") {
    throw new WebhookVerificationError(`Unsupported mock event type: ${String(type)}`);
  }
  if (!payload.provider_invoice_id || !payload.provider_payment_id) {
    throw new WebhookVerificationError(
      "Webhook body needs provider_invoice_id and provider_payment_id",
    );
  }
  const amountSats = Number(payload.amount_sats);
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new WebhookVerificationError(`amount_sats must be a positive integer, got ${payload.amount_sats}`);
  }

  const receivedAt = payload.received_at ? new Date(payload.received_at) : new Date();
  if (Number.isNaN(receivedAt.getTime())) {
    throw new WebhookVerificationError(`received_at is not a valid date: ${payload.received_at}`);
  }

  return {
    type,
    providerInvoiceId: payload.provider_invoice_id,
    providerPaymentId: payload.provider_payment_id,
    amountSats,
    receivedAt,
    raw: payload,
  };
}
