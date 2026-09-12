/**
 * The mock wallet's outbox.
 *
 * It builds a provider payload, signs it the way the mock provider expects,
 * and POSTs it to /api/webhooks/[provider] over real HTTP. It has no database
 * access of its own — if the webhook handler would reject the payload in
 * production, it rejects it here too.
 *
 * Mock-only: returns 404 unless PAYMENT_PROVIDER=mock.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { MOCK_SIGNATURE_HEADER, type MockWebhookPayload, signMockPayload } from "@/lib/payments/mock";
import { isMockProvider } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENARIOS = [
  "exact",
  "underpay",
  "overpay",
  "late",
  "twice",
  "duplicate",
  "pending",
] as const;
type Scenario = (typeof SCENARIOS)[number];

interface SimulateRequest {
  scenario: Scenario;
  providerInvoiceId: string;
  expectedSats: number;
  expiresAt: string | null;
}

function paymentId(): string {
  return `mockpay_${randomBytes(8).toString("hex")}`;
}

/** Builds the sequence of webhook deliveries a scenario should produce. */
function deliveriesFor(input: SimulateRequest): MockWebhookPayload[] {
  const { scenario, providerInvoiceId, expectedSats } = input;
  const now = new Date();

  const base = (overrides: Partial<MockWebhookPayload> = {}): MockWebhookPayload => ({
    type: "payment.settled",
    provider_invoice_id: providerInvoiceId,
    provider_payment_id: paymentId(),
    amount_sats: expectedSats,
    received_at: now.toISOString(),
    ...overrides,
  });

  switch (scenario) {
    case "exact":
      return [base()];

    case "underpay":
      return [base({ amount_sats: Math.max(1, Math.floor(expectedSats * 0.6)) })];

    case "overpay":
      return [base({ amount_sats: Math.ceil(expectedSats * 1.15) })];

    case "late": {
      // A minute past the deadline, or a minute from now if it has not been set.
      const deadline = input.expiresAt ? new Date(input.expiresAt) : now;
      const lateAt = new Date(Math.max(deadline.getTime(), now.getTime()) + 60_000);
      return [base({ received_at: lateAt.toISOString() })];
    }

    case "twice":
      // Two genuinely different payments. The second must not pay the invoice
      // again — it belongs in the unmatched inbox.
      return [base(), base()];

    case "duplicate": {
      // One payment, delivered twice. Identical provider_payment_id is the
      // whole point: the second delivery must change nothing.
      const once = base();
      return [once, { ...once }];
    }

    case "pending":
      return [base({ type: "payment.pending" })];
  }
}

export async function POST(request: Request) {
  if (!isMockProvider(env.paymentProvider)) {
    return NextResponse.json({ error: "Mock simulation is disabled." }, { status: 404 });
  }

  const body = (await request.json()) as Partial<SimulateRequest>;

  if (!body.scenario || !SCENARIOS.includes(body.scenario)) {
    return NextResponse.json(
      { error: `scenario must be one of: ${SCENARIOS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.providerInvoiceId || typeof body.expectedSats !== "number") {
    return NextResponse.json(
      { error: "providerInvoiceId and expectedSats are required" },
      { status: 400 },
    );
  }

  const deliveries = deliveriesFor({
    scenario: body.scenario,
    providerInvoiceId: body.providerInvoiceId,
    expectedSats: body.expectedSats,
    expiresAt: body.expiresAt ?? null,
  });

  const webhookUrl = `${env.appUrl}/api/webhooks/mock`;
  const results = [];

  for (const payload of deliveries) {
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.mockWebhookSecret) {
      headers[MOCK_SIGNATURE_HEADER] = signMockPayload(rawBody, env.mockWebhookSecret);
    }

    const response = await fetch(webhookUrl, { method: "POST", headers, body: rawBody });
    results.push({
      providerPaymentId: payload.provider_payment_id,
      httpStatus: response.status,
      response: await response.json().catch(() => null),
    });
  }

  return NextResponse.json({ scenario: body.scenario, deliveries: results });
}
