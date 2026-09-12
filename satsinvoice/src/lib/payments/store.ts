/**
 * The persistence seam for payment application.
 *
 * `applyProviderEvent` is written against this interface rather than against
 * Prisma so the money logic can be exercised in-memory, and so the real
 * implementation stays a thin, auditable mapping. Both implementations must
 * enforce the same invariant: `providerPaymentId` is unique, forever.
 */

import type { InvoiceState, PaymentEventKind, UnmatchedReason } from "@/lib/invoice-state";

export interface StoredInvoice {
  id: string;
  userId: string;
  publicId: string;
  provider: string | null;
  state: InvoiceState;
}

export interface PaymentEventRow {
  invoiceId: string | null;
  providerPaymentId: string;
  provider: string;
  amountSats: number;
  amountUsdCents: number;
  kind: PaymentEventKind;
  rawPayload: unknown;
  receivedAt: Date;
}

export interface UnmatchedRow {
  userId: string | null;
  provider: string;
  providerPaymentId: string;
  amountSats: number;
  amountUsdCents: number;
  reason: UnmatchedReason;
  invoiceId: string | null;
  note: string;
}

export interface AuditRow {
  actor: string;
  action: string;
  userId: string | null;
  invoiceId: string | null;
  meta: Record<string, unknown>;
}

export interface PaymentTxn {
  /**
   * Load the invoice and hold a row lock for the rest of the transaction, so
   * two webhooks racing on one invoice cannot both read the same pre-state.
   */
  lockInvoiceByProviderInvoiceId(providerInvoiceId: string): Promise<StoredInvoice | null>;
  /** Returns false when `providerPaymentId` already exists. Never throws on conflict. */
  insertPaymentEvent(row: PaymentEventRow): Promise<boolean>;
  updateInvoiceState(invoiceId: string, state: InvoiceState): Promise<void>;
  insertUnmatched(row: UnmatchedRow): Promise<void>;
  insertAudit(row: AuditRow): Promise<void>;
}

export interface PaymentStore {
  transaction<T>(fn: (tx: PaymentTxn) => Promise<T>): Promise<T>;
}
