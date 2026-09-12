/**
 * The one webhook endpoint.
 *
 * The mock pay page posts here. OpenNode will post here. There is no separate
 * "test" path, because a test path that diverges from production is how money
 * bugs ship.
 *
 * Contract:
 *  - Verify the signature with the provider, or reject with 401.
 *  - Apply the event idempotently.
 *  - Always answer 2xx once the event is verified and recorded, so providers
 *    stop retrying. Retries are safe regardless — see apply.ts.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { btcRateUsdToCents } from "@/lib/money";
import { applyProviderEvent } from "@/lib/payments/apply";
import { PrismaPaymentStore } from "@/lib/payments/prisma-store";
import { ProviderError, WebhookVerificationError, getProvider } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: providerName } = await context.params;

  let provider;
  try {
    provider = getProvider(providerName);
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }

  // Read the body exactly once, as text: signature schemes sign bytes, not
  // a re-serialised object.
  const rawBody = await request.text();

  let event;
  try {
    event = await provider.verifyWebhook(request.headers, rawBody);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  const result = await applyProviderEvent(event, {
    provider: provider.name,
    fallbackBtcRateUsdCents: btcRateUsdToCents(env.mockBtcUsdRate),
    store: new PrismaPaymentStore(prisma),
  });

  return NextResponse.json(
    {
      status: result.status,
      kind: result.kind,
      message: result.message,
      providerPaymentId: event.providerPaymentId,
    },
    { status: 200 },
  );
}

export async function GET() {
  return NextResponse.json(
    { error: "This endpoint accepts POST webhooks only." },
    { status: 405 },
  );
}
