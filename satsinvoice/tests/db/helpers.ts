import { PrismaClient } from "@prisma/client";
import { publicInvoiceId } from "@/lib/ids";
import { usdCentsToSats } from "@/lib/money";

export const prisma = new PrismaClient();

export const RATE_CENTS = 6_500_000; // $65,000.00 / BTC

/** Wipes every table. Called before each test so cases cannot leak into each other. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "UnmatchedPayment", "PaymentEvent", "Invoice", "User" RESTART IDENTITY CASCADE',
  );
}

export async function makeUser(email = `test-${Date.now()}-${Math.random()}@example.com`) {
  return prisma.user.create({
    data: { email, passwordHash: "not-a-real-hash", displayName: "Test Freelancer" },
  });
}

export interface MakeInvoiceOptions {
  userId: string;
  amountUsdCents?: number;
  expiresAt?: Date | null;
  status?: "unpaid" | "draft" | "canceled" | "paid" | "expired";
  providerInvoiceId?: string;
}

export async function makeInvoice(options: MakeInvoiceOptions) {
  const amountUsdCents = options.amountUsdCents ?? 5_000;
  return prisma.invoice.create({
    data: {
      publicId: publicInvoiceId(),
      userId: options.userId,
      clientName: "Acme Co.",
      clientEmail: "billing@acme.co",
      description: "Landing page build",
      amountUsdCents,
      status: options.status ?? "unpaid",
      provider: "mock",
      providerInvoiceId: options.providerInvoiceId ?? `mock_${publicInvoiceId(20)}`,
      paymentRequest: "lnbc769230n1mockmockmock",
      paymentUrl: "http://localhost:3000/mock-pay/x",
      amountSatsExpected: usdCentsToSats(amountUsdCents, RATE_CENTS),
      btcRateUsdCents: RATE_CENTS,
      expirySeconds: 3_600,
      expiresAt: options.expiresAt === undefined ? new Date(Date.now() + 3_600_000) : options.expiresAt,
    },
  });
}
