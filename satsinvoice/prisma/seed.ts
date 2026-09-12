/**
 * Seeds a demo freelancer with one invoice in each interesting state, so the
 * UI has something to show on a fresh database.
 *
 * Run with: npm run db:seed
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { publicInvoiceId } from "../src/lib/ids";
import { usdCentsToSats } from "../src/lib/money";

const prisma = new PrismaClient();

const RATE_CENTS = 6_500_000; // $65,000.00 / BTC
const DEMO_EMAIL = "demo@satsinvoice.test";
const DEMO_PASSWORD = "demo-password";

const HOUR = 3_600_000;

async function main() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
      displayName: "Ada Lovelace",
      payoutNote: "Questions about this invoice? Just reply to my email.",
    },
  });

  // Start from a clean slate so re-seeding is predictable.
  await prisma.invoice.deleteMany({ where: { userId: user.id } });
  await prisma.unmatchedPayment.deleteMany({ where: { userId: user.id } });

  const now = Date.now();

  const base = (amountUsdCents: number) => ({
    publicId: publicInvoiceId(),
    userId: user.id,
    amountUsdCents,
    amountSatsExpected: usdCentsToSats(amountUsdCents, RATE_CENTS),
    btcRateUsdCents: RATE_CENTS,
    provider: "mock",
    expirySeconds: 24 * 60 * 60,
    paymentRequest: `lnbc${usdCentsToSats(amountUsdCents, RATE_CENTS) * 10}n1seeded`,
  });

  const awaiting = await prisma.invoice.create({
    data: {
      ...base(5_000),
      clientName: "Acme Co.",
      clientEmail: "billing@acme.co",
      description: "Landing page build — October",
      status: "unpaid",
      providerInvoiceId: `mock_seed_${publicInvoiceId(12)}`,
      expiresAt: new Date(now + 20 * HOUR),
    },
  });
  await prisma.invoice.update({
    where: { id: awaiting.id },
    data: { paymentUrl: `http://localhost:3000/mock-pay/${awaiting.providerInvoiceId}` },
  });

  const paidSats = usdCentsToSats(120_000, RATE_CENTS);
  await prisma.invoice.create({
    data: {
      ...base(120_000),
      clientName: "Northwind Studio",
      clientEmail: "ops@northwind.example",
      description: "Design system audit",
      status: "paid",
      providerInvoiceId: `mock_seed_${publicInvoiceId(12)}`,
      expiresAt: new Date(now - 40 * HOUR),
      paidAt: new Date(now - 42 * HOUR),
      amountSatsReceived: paidSats,
    },
  });

  const shortExpected = usdCentsToSats(30_000, RATE_CENTS);
  await prisma.invoice.create({
    data: {
      ...base(30_000),
      clientName: "Blue Fox Media",
      description: "Email template pack",
      status: "underpaid",
      providerInvoiceId: `mock_seed_${publicInvoiceId(12)}`,
      expiresAt: new Date(now + 4 * HOUR),
      amountSatsReceived: Math.floor(shortExpected * 0.6),
    },
  });

  await prisma.invoice.create({
    data: {
      ...base(7_500),
      clientName: "Corner Cafe",
      description: "Menu photography",
      status: "expired",
      providerInvoiceId: `mock_seed_${publicInvoiceId(12)}`,
      expiresAt: new Date(now - 2 * HOUR),
    },
  });

  console.log(`Seeded ${user.displayName}.`);
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  Open http://localhost:3000/p/${awaiting.publicId} to see the client view.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
