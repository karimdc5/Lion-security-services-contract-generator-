/**
 * The seam between SatsInvoice and whoever actually moves the money.
 *
 * SatsInvoice runs no node, holds no keys and custodies nothing. Everything
 * Bitcoin-shaped happens behind this interface. v1 ships MockPaymentProvider;
 * OpenNode / Strike / BTCPay Greenfield slot in behind the same three methods.
 */

export interface CreateInvoiceInput {
  /** Stable per logical invoice. Retries must not create a second charge. */
  idempotencyKey: string;
  amountUsdCents: number;
  memo: string;
  expiresInSeconds: number;
  webhookUrl: string;
}

export interface CreatedInvoice {
  providerInvoiceId: string;
  /** bolt11, or a unified BIP21 string when on-chain fallback is offered. */
  paymentRequest: string;
  /** Hosted checkout page the client can open. */
  paymentUrl: string;
  amountSats: number;
  /** USD per 1 BTC, as dollars. Stored as integer cents at the DB boundary. */
  btcRateUsd: number;
  expiresAt: Date;
}

export interface ProviderInvoiceStatus {
  status: string;
  amountSatsReceived: number;
}

export type ProviderEventType = "payment.pending" | "payment.settled" | "payment.refunded";

/** A provider webhook, normalised. This is the only shape the app reacts to. */
export interface ProviderEvent {
  type: ProviderEventType;
  providerInvoiceId: string;
  /**
   * The idempotency key for this money movement. Must be stable across
   * retries of the same webhook, and unique across different payments.
   */
  providerPaymentId: string;
  amountSats: number;
  receivedAt: Date;
  /** Verbatim provider payload, stored on the PaymentEvent row. */
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice>;
  getInvoice(providerInvoiceId: string): Promise<ProviderInvoiceStatus>;
  /** Throws WebhookVerificationError if the payload is not authentic. */
  verifyWebhook(headers: Headers, rawBody: string): Promise<ProviderEvent>;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
