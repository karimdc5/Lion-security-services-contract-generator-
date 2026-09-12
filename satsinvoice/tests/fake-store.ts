/**
 * An in-memory PaymentStore that enforces the same invariants as Postgres:
 * one row per providerPaymentId, and transactions that serialise.
 *
 * It exists so the webhook logic can be tested without a database. The
 * Postgres-backed suite in tests/db/ covers PrismaPaymentStore itself.
 */

import type { InvoiceState } from "@/lib/invoice-state";
import type {
  AuditRow,
  PaymentEventRow,
  PaymentStore,
  PaymentTxn,
  StoredInvoice,
  UnmatchedRow,
} from "@/lib/payments/store";

export class FakePaymentStore implements PaymentStore {
  readonly invoices = new Map<string, StoredInvoice>();
  readonly events: PaymentEventRow[] = [];
  readonly unmatched: UnmatchedRow[] = [];
  readonly audits: AuditRow[] = [];

  private readonly seenPaymentIds = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  addInvoice(invoice: StoredInvoice): StoredInvoice {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  byProviderInvoiceId(providerInvoiceId: string): StoredInvoice | undefined {
    return [...this.invoices.values()].find(
      (i) => i.providerInvoiceIdForTest === providerInvoiceId,
    );
  }

  eventsFor(providerPaymentId: string): PaymentEventRow[] {
    return this.events.filter((e) => e.providerPaymentId === providerPaymentId);
  }

  /** Serialises callers, the way `SELECT ... FOR UPDATE` does in Postgres. */
  transaction<T>(fn: (tx: PaymentTxn) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(new FakeTxn(this)));
    // Keep the chain alive even if this transaction rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @internal */
  claimPaymentId(providerPaymentId: string): boolean {
    if (this.seenPaymentIds.has(providerPaymentId)) return false;
    this.seenPaymentIds.add(providerPaymentId);
    return true;
  }
}

// Test-only marker so the fake can resolve provider invoice ids.
declare module "@/lib/payments/store" {
  interface StoredInvoice {
    providerInvoiceIdForTest?: string;
  }
}

class FakeTxn implements PaymentTxn {
  constructor(private readonly store: FakePaymentStore) {}

  async lockInvoiceByProviderInvoiceId(providerInvoiceId: string): Promise<StoredInvoice | null> {
    return this.store.byProviderInvoiceId(providerInvoiceId) ?? null;
  }

  async insertPaymentEvent(row: PaymentEventRow): Promise<boolean> {
    if (!this.store.claimPaymentId(row.providerPaymentId)) return false;
    this.store.events.push(row);
    return true;
  }

  async updateInvoiceState(invoiceId: string, state: InvoiceState): Promise<void> {
    const invoice = this.store.invoices.get(invoiceId);
    if (!invoice) throw new Error(`No such invoice: ${invoiceId}`);
    invoice.state = { ...state };
  }

  async insertUnmatched(row: UnmatchedRow): Promise<void> {
    if (this.store.unmatched.some((u) => u.providerPaymentId === row.providerPaymentId)) {
      throw new Error(`Duplicate unmatched payment: ${row.providerPaymentId}`);
    }
    this.store.unmatched.push(row);
  }

  async insertAudit(row: AuditRow): Promise<void> {
    this.store.audits.push(row);
  }
}
