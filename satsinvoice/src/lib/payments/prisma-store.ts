/**
 * The real PaymentStore. Deliberately thin: it maps rows to the domain shape
 * and back, and does nothing clever. All the decisions live in
 * `invoice-state.ts` and `apply.ts`.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { InvoiceState } from "@/lib/invoice-state";
import type {
  AuditRow,
  PaymentEventRow,
  PaymentStore,
  PaymentTxn,
  StoredInvoice,
  UnmatchedRow,
} from "./store";

type Tx = Prisma.TransactionClient;

class PrismaPaymentTxn implements PaymentTxn {
  constructor(private readonly tx: Tx) {}

  async lockInvoiceByProviderInvoiceId(providerInvoiceId: string): Promise<StoredInvoice | null> {
    // SELECT ... FOR UPDATE. Prisma has no first-class row lock, so this is
    // raw on purpose: without it, two webhooks for one invoice can both read
    // the pre-payment state and the second write wins.
    const locked = await this.tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Invoice" WHERE "providerInvoiceId" = ${providerInvoiceId} FOR UPDATE
    `;
    if (locked.length === 0) return null;

    const invoice = await this.tx.invoice.findUnique({ where: { id: locked[0].id } });
    if (!invoice) return null;

    return {
      id: invoice.id,
      userId: invoice.userId,
      publicId: invoice.publicId,
      provider: invoice.provider,
      state: {
        status: invoice.status,
        expiresAt: invoice.expiresAt,
        amountUsdCents: invoice.amountUsdCents,
        btcRateUsdCents: invoice.btcRateUsdCents,
        amountSatsExpected: invoice.amountSatsExpected,
        amountSatsReceived: invoice.amountSatsReceived,
        overpaySats: invoice.overpaySats,
        overpayUsdCents: invoice.overpayUsdCents,
        paidAt: invoice.paidAt,
        writtenOff: invoice.writtenOff,
        reviewFlag: invoice.reviewFlag,
      },
    };
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING, deliberately raw.
   *
   * A plain `create()` that hits the unique index raises, and in Postgres a
   * raised statement poisons the whole transaction: every later write fails
   * with 25P02 "current transaction is aborted". Catching the Prisma error is
   * not enough, because the damage is on the connection, not in JavaScript.
   * Letting the database absorb the conflict keeps the transaction usable, so
   * the duplicate can still be written to the audit log.
   */
  async insertPaymentEvent(row: PaymentEventRow): Promise<boolean> {
    const inserted = await this.tx.$executeRaw`
      INSERT INTO "PaymentEvent" (
        "id", "invoiceId", "providerPaymentId", "provider",
        "amountSats", "amountUsdCents", "kind", "rawPayload", "receivedAt", "createdAt"
      )
      VALUES (
        ${randomUUID()},
        ${row.invoiceId},
        ${row.providerPaymentId},
        ${row.provider},
        ${row.amountSats},
        ${row.amountUsdCents},
        ${row.kind}::"PaymentEventKind",
        ${JSON.stringify(row.rawPayload ?? {})}::jsonb,
        ${row.receivedAt},
        NOW()
      )
      ON CONFLICT ("providerPaymentId") DO NOTHING
    `;
    return inserted > 0;
  }

  async updateInvoiceState(invoiceId: string, state: InvoiceState): Promise<void> {
    await this.tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: state.status,
        expiresAt: state.expiresAt,
        amountSatsReceived: state.amountSatsReceived,
        overpaySats: state.overpaySats,
        overpayUsdCents: state.overpayUsdCents,
        paidAt: state.paidAt,
        writtenOff: state.writtenOff,
        reviewFlag: state.reviewFlag,
      },
    });
  }

  async insertUnmatched(row: UnmatchedRow): Promise<void> {
    await this.tx.unmatchedPayment.create({
      data: {
        userId: row.userId,
        provider: row.provider,
        providerPaymentId: row.providerPaymentId,
        amountSats: row.amountSats,
        amountUsdCents: row.amountUsdCents,
        reason: row.reason,
        invoiceId: row.invoiceId,
        note: row.note,
      },
    });
  }

  async insertAudit(row: AuditRow): Promise<void> {
    await this.tx.auditLog.create({
      data: {
        actor: row.actor,
        action: row.action,
        userId: row.userId,
        invoiceId: row.invoiceId,
        meta: row.meta as Prisma.InputJsonValue,
      },
    });
  }
}

export class PrismaPaymentStore implements PaymentStore {
  constructor(private readonly prisma: PrismaClient) {}

  transaction<T>(fn: (tx: PaymentTxn) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaPaymentTxn(tx)), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15_000,
    });
  }
}
