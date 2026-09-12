import { describe, expect, it } from "vitest";
import {
  TransitionError,
  applyPayment,
  applyPendingNotice,
  canCancel,
  cancelInvoice,
  displayStatus,
  expireNow,
  isClosed,
  recordRefund,
  remainingSats,
  remainingUsdCents,
  sweepExpiry,
  writeOff,
} from "@/lib/invoice-state";
import { T_AFTER_EXPIRY, T_BEFORE_EXPIRY, T_EXPIRY, invoice, payment } from "./helpers";

const EXPECTED_SATS = 76_923; // $50 at $65,000/BTC

describe("exact payment", () => {
  it("marks the invoice paid with no overpay", () => {
    const out = applyPayment(invoice(), payment(EXPECTED_SATS));

    expect(out.kind).toBe("settled");
    expect(out.next.status).toBe("paid");
    expect(out.next.paidAt).toEqual(T_BEFORE_EXPIRY);
    expect(out.next.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(out.next.overpaySats).toBe(0);
    expect(out.unmatched).toBeNull();
    expect(remainingUsdCents(out.next)).toBe(0);
  });

  it("does not mutate the input state", () => {
    const before = invoice();
    applyPayment(before, payment(EXPECTED_SATS));
    expect(before.status).toBe("unpaid");
    expect(before.amountSatsReceived).toBe(0);
  });
});

describe("underpayment", () => {
  it("stays underpaid and reports the remainder", () => {
    const out = applyPayment(invoice(), payment(40_000));

    expect(out.kind).toBe("settled");
    expect(out.next.status).toBe("underpaid");
    expect(out.next.paidAt).toBeNull();
    expect(remainingSats(out.next)).toBe(EXPECTED_SATS - 40_000);
    // ~$24 still owed on a $50 invoice.
    expect(remainingUsdCents(out.next)).toBe(2_400);
  });

  it("becomes paid once the remainder arrives", () => {
    const first = applyPayment(invoice(), payment(40_000));
    const second = applyPayment(first.next, payment(EXPECTED_SATS - 40_000));

    expect(second.next.status).toBe("paid");
    expect(second.next.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(second.next.overpaySats).toBe(0);
    expect(remainingSats(second.next)).toBe(0);
  });

  it("survives expiry rather than being swept away — the money is real", () => {
    const underpaid = applyPayment(invoice(), payment(40_000)).next;
    expect(sweepExpiry(underpaid, T_AFTER_EXPIRY).status).toBe("underpaid");
  });

  it("closes only when written off", () => {
    const underpaid = applyPayment(invoice(), payment(40_000)).next;
    expect(isClosed(underpaid)).toBe(false);

    const closed = writeOff(underpaid);
    expect(closed.status).toBe("underpaid"); // the books still say short
    expect(closed.writtenOff).toBe(true);
    expect(isClosed(closed)).toBe(true);
    expect(displayStatus(closed)).toBe("written off");
  });

  it("refuses a second write-off", () => {
    const closed = writeOff(applyPayment(invoice(), payment(40_000)).next);
    expect(() => writeOff(closed)).toThrow(TransitionError);
  });
});

describe("overpayment", () => {
  it("marks paid and records the surplus in sats and USD", () => {
    const out = applyPayment(invoice(), payment(EXPECTED_SATS + 10_000));

    expect(out.next.status).toBe("paid");
    expect(out.next.overpaySats).toBe(10_000);
    expect(out.next.overpayUsdCents).toBe(650); // 10k sats at $65k/BTC = $6.50
    expect(displayStatus(out.next)).toBe("paid (overpaid)");
  });
});

describe("expiry with no payment", () => {
  it("expires once the deadline passes", () => {
    expect(sweepExpiry(invoice(), T_BEFORE_EXPIRY).status).toBe("unpaid");
    expect(sweepExpiry(invoice(), T_EXPIRY).status).toBe("expired");
    expect(sweepExpiry(invoice(), T_AFTER_EXPIRY).status).toBe("expired");
  });

  it("never expires an invoice without a deadline", () => {
    expect(sweepExpiry(invoice({ expiresAt: null }), T_AFTER_EXPIRY).status).toBe("unpaid");
  });

  it("expire-now pulls the deadline forward so later money reads as late", () => {
    const expired = expireNow(invoice(), T_BEFORE_EXPIRY);
    expect(expired.status).toBe("expired");
    expect(expired.expiresAt).toEqual(T_BEFORE_EXPIRY);
  });
});

describe("payment after expiry", () => {
  it("is late: credited and flagged, never silently paid on time", () => {
    const out = applyPayment(invoice(), payment(EXPECTED_SATS, T_AFTER_EXPIRY));

    expect(out.kind).toBe("late");
    expect(out.next.status).toBe("expired");
    expect(out.next.status).not.toBe("paid");
    expect(out.next.paidAt).toBeNull();
    // The money is visible on the invoice...
    expect(out.creditedToInvoice).toBe(true);
    expect(out.next.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(out.next.reviewFlag).toBe(true);
    // ...and in the inbox, so it cannot be missed.
    expect(out.unmatched).toEqual({
      reason: "late_payment",
      amountSats: EXPECTED_SATS,
      note: "Payment arrived after the invoice expired.",
    });
  });

  it("is late even when the invoice was already swept to expired", () => {
    const expired = sweepExpiry(invoice(), T_AFTER_EXPIRY);
    const out = applyPayment(expired, payment(EXPECTED_SATS, T_AFTER_EXPIRY));

    expect(out.kind).toBe("late");
    expect(out.next.status).toBe("expired");
  });

  it("leaves an underpaid invoice underpaid rather than expiring it", () => {
    const underpaid = applyPayment(invoice(), payment(40_000)).next;
    const out = applyPayment(underpaid, payment(36_923, T_AFTER_EXPIRY));

    expect(out.kind).toBe("late");
    expect(out.next.status).toBe("underpaid");
    expect(out.next.paidAt).toBeNull();
    expect(out.next.amountSatsReceived).toBe(EXPECTED_SATS);
    expect(out.next.reviewFlag).toBe(true);
  });

  it("treats a payment exactly at the deadline as late", () => {
    const out = applyPayment(invoice(), payment(EXPECTED_SATS, T_EXPIRY));
    expect(out.kind).toBe("late");
  });
});

describe("second payment on a settled invoice", () => {
  it("does not mark the invoice paid twice", () => {
    const paid = applyPayment(invoice(), payment(EXPECTED_SATS)).next;
    const out = applyPayment(paid, payment(EXPECTED_SATS));

    expect(out.kind).toBe("unmatched");
    expect(out.next.status).toBe("paid");
    expect(out.next.amountSatsReceived).toBe(EXPECTED_SATS); // unchanged
    expect(out.next.paidAt).toEqual(paid.paidAt); // unchanged
    expect(out.creditedToInvoice).toBe(false);
    expect(out.next.reviewFlag).toBe(true);
    expect(out.unmatched?.reason).toBe("duplicate_invoice_payment");
    expect(out.unmatched?.amountSats).toBe(EXPECTED_SATS);
  });

  it("parks money sent to a canceled invoice", () => {
    const canceled = cancelInvoice(invoice());
    const out = applyPayment(canceled, payment(EXPECTED_SATS));

    expect(out.kind).toBe("unmatched");
    expect(out.next.status).toBe("canceled");
    expect(out.creditedToInvoice).toBe(false);
    expect(out.unmatched?.reason).toBe("invoice_not_payable");
  });

  it("parks money sent to a draft invoice", () => {
    const out = applyPayment(invoice({ status: "draft" }), payment(EXPECTED_SATS));
    expect(out.unmatched?.reason).toBe("invoice_not_payable");
  });
});

describe("in-flight (pending) notices", () => {
  it("moves an unpaid invoice to pending without crediting sats", () => {
    const out = applyPendingNotice(invoice(), payment(EXPECTED_SATS));

    expect(out.kind).toBe("pending");
    expect(out.next.status).toBe("pending");
    expect(out.next.amountSatsReceived).toBe(0);
    expect(out.creditedToInvoice).toBe(false);
  });

  it("settles normally from pending", () => {
    const pending = applyPendingNotice(invoice(), payment(EXPECTED_SATS)).next;
    const out = applyPayment(pending, payment(EXPECTED_SATS));
    expect(out.next.status).toBe("paid");
  });

  it("does nothing to an already paid invoice", () => {
    const paid = applyPayment(invoice(), payment(EXPECTED_SATS)).next;
    const out = applyPendingNotice(paid, payment(EXPECTED_SATS));
    expect(out.changed).toBe(false);
    expect(out.next.status).toBe("paid");
  });
});

describe("cancel and refund", () => {
  it("cancels only while nothing has been received", () => {
    expect(canCancel(invoice())).toBe(true);
    const underpaid = applyPayment(invoice(), payment(40_000)).next;
    expect(canCancel(underpaid)).toBe(false);
    expect(() => cancelInvoice(underpaid)).toThrow(TransitionError);
  });

  it("records a refund on a paid invoice", () => {
    const paid = applyPayment(invoice(), payment(EXPECTED_SATS)).next;
    const refunded = recordRefund(paid, T_AFTER_EXPIRY);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountSatsReceived).toBe(EXPECTED_SATS);
  });

  it("refuses to refund an invoice that never received money", () => {
    expect(() => recordRefund(invoice(), T_AFTER_EXPIRY)).toThrow(TransitionError);
  });

  it("treats a payment to a refunded invoice as unmatched", () => {
    const refunded = recordRefund(applyPayment(invoice(), payment(EXPECTED_SATS)).next, T_AFTER_EXPIRY);
    expect(applyPayment(refunded, payment(1_000)).kind).toBe("unmatched");
  });
});

describe("input validation", () => {
  it.each([0, -1, 1.5])("rejects an amount of %s sats", (amount) => {
    expect(() => applyPayment(invoice(), payment(amount))).toThrow(TransitionError);
  });
});
