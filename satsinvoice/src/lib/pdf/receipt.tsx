import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { Invoice } from "@prisma/client";
import { toState } from "@/lib/invoice-mapper";
import { displayStatus, remainingUsdCents } from "@/lib/invoice-state";
import { btcRateCentsToUsd, formatSats, formatUsdCents } from "@/lib/money";

const stamp = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, color: "#0b1220", fontFamily: "Helvetica" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  muted: { color: "#5b6577" },
  faint: { color: "#8b95a7", fontSize: 9 },
  amount: { fontSize: 32, fontFamily: "Helvetica-Bold", marginTop: 4 },
  statusPill: {
    marginTop: 6,
    alignSelf: "flex-start",
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: "#e6f5ec",
    color: "#0f7b44",
  },
  statusPillWarn: { backgroundColor: "#fdf2e0", color: "#9a5b00" },
  rule: { borderBottomWidth: 1, borderBottomColor: "#e3e8ef", marginVertical: 20 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 7 },
  sectionTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    color: "#8b95a7",
    marginBottom: 8,
  },
  columns: { flexDirection: "row", gap: 36 },
  column: { flex: 1 },
  footer: { position: "absolute", bottom: 40, left: 48, right: 48 },
  mono: { fontFamily: "Courier", fontSize: 8, color: "#5b6577" },
});

export interface ReceiptData {
  invoice: Invoice;
  freelancerName: string;
  freelancerEmail: string;
  payoutNote: string;
  paymentReferences: string[];
}

function Receipt({ invoice, freelancerName, freelancerEmail, payoutNote, paymentReferences }: ReceiptData) {
  const state = toState(invoice);
  const status = displayStatus(state);
  const isPaid = invoice.status === "paid";
  const remaining = remainingUsdCents(state);

  return (
    <Document title={`Receipt ${invoice.publicId}`} author={freelancerName}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{freelancerName}</Text>
            <Text style={[styles.muted, { marginTop: 3 }]}>{freelancerEmail}</Text>
          </View>
          <View>
            <Text style={[styles.faint, { textAlign: "right" }]}>
              {isPaid ? "RECEIPT" : "INVOICE"}
            </Text>
            <Text style={[styles.mono, { textAlign: "right", marginTop: 3 }]}>
              {invoice.publicId}
            </Text>
          </View>
        </View>

        <View style={styles.rule} />

        <Text style={styles.faint}>{isPaid ? "AMOUNT PAID" : "AMOUNT DUE"}</Text>
        <Text style={styles.amount}>{formatUsdCents(invoice.amountUsdCents)}</Text>
        <Text style={[styles.statusPill, isPaid ? {} : styles.statusPillWarn]}>
          {status.toUpperCase()}
        </Text>

        <View style={styles.rule} />

        <View style={styles.columns}>
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>BILLED TO</Text>
            <Text>{invoice.clientName}</Text>
            {invoice.clientEmail ? (
              <Text style={[styles.muted, { marginTop: 2 }]}>{invoice.clientEmail}</Text>
            ) : null}
          </View>
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>DETAILS</Text>
            <View style={styles.row}>
              <Text style={styles.muted}>Issued</Text>
              <Text>{stamp.format(invoice.createdAt)} UTC</Text>
            </View>
            {invoice.paidAt ? (
              <View style={styles.row}>
                <Text style={styles.muted}>Paid</Text>
                <Text>{stamp.format(invoice.paidAt)} UTC</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.rule} />

        <Text style={styles.sectionTitle}>WORK</Text>
        <View style={styles.row}>
          <Text style={{ flex: 1, paddingRight: 16 }}>{invoice.description}</Text>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>
            {formatUsdCents(invoice.amountUsdCents)}
          </Text>
        </View>

        <View style={styles.rule} />

        <Text style={styles.sectionTitle}>SETTLEMENT</Text>
        <View style={styles.row}>
          <Text style={styles.muted}>Invoice total</Text>
          <Text>{formatUsdCents(invoice.amountUsdCents)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.muted}>Bitcoin expected</Text>
          <Text>{formatSats(invoice.amountSatsExpected)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.muted}>Bitcoin received</Text>
          <Text>{formatSats(invoice.amountSatsReceived)}</Text>
        </View>
        {invoice.overpaySats > 0 ? (
          <View style={styles.row}>
            <Text style={styles.muted}>Overpaid</Text>
            <Text>
              {formatUsdCents(invoice.overpayUsdCents)} ({formatSats(invoice.overpaySats)})
            </Text>
          </View>
        ) : null}
        {remaining > 0 ? (
          <View style={styles.row}>
            <Text style={styles.muted}>Still outstanding</Text>
            <Text>{formatUsdCents(remaining)}</Text>
          </View>
        ) : null}
        <View style={styles.row}>
          <Text style={styles.muted}>Rate applied</Text>
          <Text>
            {invoice.btcRateUsdCents > 0
              ? `$${btcRateCentsToUsd(invoice.btcRateUsdCents).toLocaleString("en-US")} per BTC`
              : "—"}
          </Text>
        </View>

        {paymentReferences.length > 0 ? (
          <>
            <View style={styles.rule} />
            <Text style={styles.sectionTitle}>PAYMENT REFERENCES</Text>
            {paymentReferences.map((reference) => (
              <Text key={reference} style={styles.mono}>
                {reference}
              </Text>
            ))}
          </>
        ) : null}

        <View style={styles.footer}>
          {payoutNote ? <Text style={styles.faint}>{payoutNote}</Text> : null}
          <Text style={[styles.faint, { marginTop: 6 }]}>
            Invoiced and recorded in US dollars. Bitcoin amounts are settlement facts at the rate
            fixed when this invoice was issued.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return renderToBuffer(<Receipt {...data} />);
}
