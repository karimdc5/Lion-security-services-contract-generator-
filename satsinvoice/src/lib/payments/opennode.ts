/**
 * OpenNodeProvider — NOT IMPLEMENTED IN v1.
 *
 * This file is the shape of the work, not the work. Nothing here calls the
 * network, and `PAYMENT_PROVIDER=opennode` deliberately throws at startup
 * rather than silently doing nothing with real money.
 *
 * Env vars it will need (already in .env.example):
 *   OPENNODE_API_KEY          — Invoice API key from the OpenNode dashboard
 *   OPENNODE_WEBHOOK_SECRET   — usually the same API key; OpenNode signs with it
 *
 * When you implement this, the rest of the app should not need to change:
 * everything downstream already speaks ProviderEvent.
 */

import {
  type CreateInvoiceInput,
  type CreatedInvoice,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderInvoiceStatus,
  ProviderError,
} from "./provider";

const API_BASE = "https://api.opennode.com";

export class OpenNodeProvider implements PaymentProvider {
  readonly name = "opennode";

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string,
  ) {
    if (!apiKey) throw new ProviderError("OPENNODE_API_KEY is not set");
    if (!webhookSecret) throw new ProviderError("OPENNODE_WEBHOOK_SECRET is not set");
  }

  async createInvoice(_input: CreateInvoiceInput): Promise<CreatedInvoice> {
    // TODO: POST `${API_BASE}/v1/charges` with:
    //   { amount: _input.amountUsdCents / 100, currency: "USD",
    //     description: _input.memo, callback_url: _input.webhookUrl,
    //     ttl: Math.ceil(_input.expiresInSeconds / 60) /* minutes, max 1440 */,
    //     order_id: _input.idempotencyKey }
    //   Header: Authorization: <apiKey>
    //
    // TODO: OpenNode has no idempotency-key header. Guard against duplicate
    // charges by looking up an existing charge by order_id first, and keep the
    // DB write that stores providerInvoiceId in the same transaction as the
    // invoice row so a crash cannot orphan a charge.
    //
    // TODO: map the response to CreatedInvoice:
    //   providerInvoiceId <- data.id
    //   paymentRequest    <- data.lightning_invoice.payreq  (bolt11)
    //                        fall back to a BIP21 built from data.chain_invoice
    //   paymentUrl        <- data.hosted_checkout_url
    //   amountSats        <- Math.round(data.amount * 1e8)   [data.amount is BTC]
    //   btcRateUsd        <- data.fiat_value / data.amount
    //   expiresAt         <- new Date(data.lightning_invoice.expires_at * 1000)
    //
    // TODO: OpenNode's ttl caps at 24h. Invoices longer than that need
    // re-issue-on-demand rather than one long-lived charge.
    throw new ProviderError(`OpenNodeProvider.createInvoice is not implemented (${API_BASE})`);
  }

  async getInvoice(_providerInvoiceId: string): Promise<ProviderInvoiceStatus> {
    // TODO: GET `${API_BASE}/v1/charge/${_providerInvoiceId}` and map
    //   status            <- data.status ("unpaid" | "processing" | "paid" | "expired")
    //   amountSatsReceived <- Math.round(data.amount * 1e8) when settled, else 0
    throw new ProviderError("OpenNodeProvider.getInvoice is not implemented");
  }

  async verifyWebhook(_headers: Headers, _rawBody: string): Promise<ProviderEvent> {
    // OpenNode posts application/x-www-form-urlencoded, not JSON, and signs
    // the charge id rather than the body:
    //
    // TODO: const form = new URLSearchParams(_rawBody)
    // TODO: const expected = createHmac("sha256", this.webhookSecret)
    //                         .update(form.get("id") ?? "").digest("hex")
    // TODO: timingSafeEqual against form.get("hashed_order"); throw
    //       WebhookVerificationError on mismatch. Do NOT skip this — an
    //       unverified webhook is an attacker marking invoices paid.
    //
    // TODO: map to ProviderEvent:
    //   type              <- "payment.settled" when status === "paid",
    //                        "payment.pending" when "processing",
    //                        "payment.refunded" when "refunded"
    //   providerInvoiceId <- form.get("id")
    //   providerPaymentId <- form.get("id") is NOT unique per payment on
    //                        OpenNode; derive a stable key such as
    //                        `${id}:${status}:${form.get("transaction_id") ?? ""}`
    //                        so a retry collides but a second payment does not.
    //   amountSats        <- Math.round(Number(form.get("amount")) * 1e8)
    //   receivedAt        <- new Date()  (OpenNode does not send a timestamp)
    throw new ProviderError("OpenNodeProvider.verifyWebhook is not implemented");
  }
}
