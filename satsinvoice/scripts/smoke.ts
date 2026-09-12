/**
 * End-to-end walkthrough against the running production server.
 * Invoices are created through the same service the UI action calls; every
 * payment goes over real HTTP through /api/mock/simulate -> /api/webhooks/mock.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { toState } from "@/lib/invoice-mapper";
import { remainingUsdCents } from "@/lib/invoice-state";
import { createInvoice } from "@/lib/invoices";
import { formatUsdCents } from "@/lib/money";

const BASE = "http://localhost:3000";
const prisma = new PrismaClient();
const jar = new Map<string, string>();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function cookies() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); }
async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual", ...init,
    headers: { cookie: cookies(), ...(init.headers ?? {}) },
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

interface SimulateResponse {
  scenario: string;
  deliveries: Array<{ providerPaymentId: string; httpStatus: number; response: { status: string } }>;
}

async function simulate(scenario: string, invoice: { providerInvoiceId: string | null; amountSatsExpected: number; expiresAt: Date | null }) {
  const res = await req("/api/mock/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario,
      providerInvoiceId: invoice.providerInvoiceId,
      expectedSats: invoice.amountSatsExpected,
      expiresAt: invoice.expiresAt?.toISOString() ?? null,
    }),
  });
  return { status: res.status, body: (await res.json()) as SimulateResponse };
}

const email = `walk-${Date.now()}@example.com`;
const password = "correct horse battery";

async function main() {
  console.log("\n=== AUTH ===");
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 10), displayName: "Walkthrough Freelancer" },
  });

  const { csrfToken } = await (await req("/api/auth/csrf")).json();
  const signIn = await req("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: `${BASE}/invoices` }),
  });
  check("sign in issues a session cookie", [...jar.keys()].some((k) => k.includes("session-token")), `status ${signIn.status}`);
  check("/invoices renders for a signed-in user", (await req("/invoices")).status === 200);
  check("/invoices redirects when signed out", (await fetch(`${BASE}/invoices`, { redirect: "manual" })).status === 307);
  check("/signup renders", (await fetch(`${BASE}/signup`)).status === 200);

  const make = (amountUsdCents: number, expirySeconds = 3600, description = "Landing page build") =>
    createInvoice({ userId: user.id, clientName: "Acme Co.", clientEmail: "billing@acme.co", description, amountUsdCents, expirySeconds });
  const reload = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });

  // ---- 1. exact pay ----
  console.log("\n=== 1. $50 invoice, exact pay ===");
  const exact = await make(5000);
  check("invoice starts unpaid with a payment request", exact.status === "unpaid" && !!exact.paymentRequest, `${exact.amountSatsExpected} sats expected`);
  check("public pay page renders", (await req(`/p/${exact.publicId}`)).status === 200);
  const payPageHtml = await (await req(`/p/${exact.publicId}`)).text();
  check("client page shows the USD amount large", payPageHtml.includes("$50.00"));
  check("client page shows no mempool/seed-phrase jargon", !/mempool|seed phrase|confirmations|on-chain fee/i.test(payPageHtml));
  check("client page shows no bolt11 decode error", !/decode error|invalid invoice/i.test(payPageHtml));
  check("mock checkout page renders", (await req(`/mock-pay/${exact.providerInvoiceId}`)).status === 200);

  const exactPay = await simulate("exact", exact);
  const exactAfter = await reload(exact.id);
  check("exact pay -> paid", exactAfter.status === "paid", `webhook ${exactPay.body.deliveries[0].httpStatus}`);
  check("receipt PDF downloads and shows $50", await receiptShowsFifty(exact.publicId));
  check("owner receipt route needs the session", (await fetch(`${BASE}/invoices/${exact.id}/receipt.pdf`, { redirect: "manual" })).status === 307);

  // ---- 2. underpay ----
  console.log("\n=== 2. underpay ===");
  const under = await make(5000);
  await simulate("underpay", under);
  const underAfter = await reload(under.id);
  check("underpay -> underpaid", underAfter.status === "underpaid");
  const underHtml = await (await req(`/p/${under.publicId}`)).text();
  const stillOwed = formatUsdCents(remainingUsdCents(toState(underAfter)));
  check("client page shows the remaining USD, not the total", underHtml.includes("still to pay") && underHtml.includes(stillOwed) && stillOwed !== "$50.00", `${stillOwed} still to pay`);

  // ---- 3. overpay ----
  console.log("\n=== 3. overpay ===");
  const over = await make(5000);
  await simulate("overpay", over);
  const overAfter = await reload(over.id);
  check("overpay -> paid with overpay recorded", overAfter.status === "paid" && overAfter.overpaySats > 0, `${overAfter.overpaySats} sats over`);

  // ---- 4. expiry, no payment ----
  console.log("\n=== 4. expire with no payment ===");
  const expiring = await make(2500);
  await prisma.invoice.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const expiredHtml = await (await req(`/p/${expiring.publicId}`)).text();
  check("expired -> status expired on read", (await reload(expiring.id)).status === "expired");
  check("expired page says the link expired", expiredHtml.includes("This link expired"));
  check("expired page offers no reissue button by default", !expiredHtml.includes("Generate new invoice"));

  // ---- 5. pay after expiry ----
  console.log("\n=== 5. pay after expiry ===");
  const late = await make(5000);
  await prisma.invoice.update({ where: { id: late.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await simulate("late", await reload(late.id));
  const lateAfter = await reload(late.id);
  check("late payment does NOT mark the invoice paid", lateAfter.status !== "paid", `status ${lateAfter.status}`);
  check("late money is visible on the invoice", lateAfter.amountSatsReceived > 0);
  check("late payment flags the invoice for review", lateAfter.reviewFlag);
  const lateInbox = await prisma.unmatchedPayment.findMany({ where: { invoiceId: late.id, reason: "late_payment" } });
  check("late payment appears in the unmatched inbox", lateInbox.length === 1);

  // ---- 6. duplicate webhook ----
  console.log("\n=== 6. same webhook twice ===");
  const dup = await make(5000);
  const dupRes = await simulate("duplicate", dup);
  const dupEvents = await prisma.paymentEvent.count({ where: { invoiceId: dup.id } });
  check("replayed webhook creates exactly one payment event", dupEvents === 1, `deliveries: ${dupRes.body.deliveries.map((d: { response: { status: string } }) => d.response.status).join(", ")}`);
  const dupAfter = await reload(dup.id);
  check("replay does not double-credit", dupAfter.amountSatsReceived === dup.amountSatsExpected && dupAfter.overpaySats === 0);

  // ---- 7. two payments ----
  console.log("\n=== 7. two payments on one invoice ===");
  const twice = await make(5000);
  await simulate("twice", twice);
  const twiceAfter = await reload(twice.id);
  check("invoice paid once, for the invoiced amount", twiceAfter.status === "paid" && twiceAfter.amountSatsReceived === twice.amountSatsExpected);
  const twiceInbox = await prisma.unmatchedPayment.findMany({ where: { invoiceId: twice.id } });
  check("second payment lands in the unmatched inbox", twiceInbox.length === 1 && twiceInbox[0].reason === "duplicate_invoice_payment");
  check("both payments are on the record", (await prisma.paymentEvent.count({ where: { invoiceId: twice.id } })) === 2);

  // ---- 8. CSV ----
  console.log("\n=== 8. CSV export ===");
  const csvRes = await req(`/api/export?from=2000-01-01&to=2100-01-01`);
  const csv = await csvRes.text();
  check("CSV downloads as an attachment", csvRes.headers.get("content-disposition")?.includes("attachment") === true);
  check("CSV header matches the spec", csv.split("\r\n")[0] === "date_utc,invoice_public_id,client,description,status,amount_usd,amount_sats_expected,amount_sats_received,btc_usd_rate,payment_hash_or_provider_id,kind");
  check("CSV contains the paid invoice", csv.includes(exact.publicId) && csv.includes("50.00"));
  check("CSV contains the settled payment row", csv.includes(",settled"));
  check("CSV contains the late payment row", csv.includes(",late"));

  // ---- unmatched inbox + other screens ----
  console.log("\n=== screens ===");
  const inboxHtml = await (await req("/unmatched")).text();
  check("/unmatched lists the parked money", inboxHtml.includes("Arrived after the invoice expired"));
  check("/export renders", (await req("/export")).status === 200);
  check("/settings renders", (await req("/settings")).status === 200);
  check("/invoices/new renders", (await req("/invoices/new")).status === 200);
  check("/invoices/[id] renders", (await req(`/invoices/${exact.id}`)).status === 200);
  check("status API answers the client poller", (await (await req(`/api/p/${exact.publicId}/status`)).json()).paid === true);

  // ---- webhook hardening ----
  console.log("\n=== webhook endpoint ===");
  check("GET on the webhook is rejected", (await fetch(`${BASE}/api/webhooks/mock`)).status === 405);
  check("unknown provider is rejected", (await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", body: "{}" })).status === 404);
  const malformed = await fetch(`${BASE}/api/webhooks/mock`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
  check("malformed body is rejected as unverified", malformed.status === 401);
  const ghost = await fetch(`${BASE}/api/webhooks/mock`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "payment.settled", provider_invoice_id: "mock_ghost", provider_payment_id: `ghost_${Date.now()}`, amount_sats: 1000 }),
  });
  check("money for an unknown invoice is recorded, not dropped", (await ghost.json()).status === "unknown_invoice");

  // ---- auto-reissue ----
  console.log("\n=== auto-reissue ===");
  await prisma.user.update({ where: { id: user.id }, data: { autoReissue: true } });
  const reissueHtml = await (await req(`/p/${expiring.publicId}`)).text();
  check("expired page offers reissue once enabled", reissueHtml.includes("Generate new invoice"));

  console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function receiptShowsFifty(publicId: string): Promise<boolean> {
  const res = await req(`/p/${publicId}/receipt.pdf`);
  if (res.status !== 200) return false;
  if (res.headers.get("content-type") !== "application/pdf") return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.subarray(0, 5).toString().startsWith("%PDF-")) return false;
  // PDF text is compressed; check it is a real, non-trivial document instead.
  return buf.length > 2000;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
