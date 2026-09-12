-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'unpaid', 'pending', 'paid', 'underpaid', 'overpaid', 'expired', 'canceled', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentEventKind" AS ENUM ('settled', 'late', 'duplicate', 'unmatched', 'refund', 'pending');

-- CreateEnum
CREATE TYPE "UnmatchedReason" AS ENUM ('late_payment', 'duplicate_invoice_payment', 'invoice_not_payable', 'unknown_invoice');

-- CreateEnum
CREATE TYPE "UnmatchedResolution" AS ENUM ('open', 'apply_to_invoice', 'refunded', 'ignored');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "payoutNote" TEXT NOT NULL DEFAULT '',
    "autoReissue" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT,
    "description" TEXT NOT NULL,
    "amountUsdCents" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "expiresAt" TIMESTAMP(3),
    "expirySeconds" INTEGER NOT NULL DEFAULT 3600,
    "paidAt" TIMESTAMP(3),
    "btcRateUsdCents" INTEGER NOT NULL DEFAULT 0,
    "amountSatsExpected" INTEGER NOT NULL DEFAULT 0,
    "amountSatsReceived" INTEGER NOT NULL DEFAULT 0,
    "overpaySats" INTEGER NOT NULL DEFAULT 0,
    "overpayUsdCents" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerInvoiceId" TEXT,
    "paymentRequest" TEXT,
    "paymentUrl" TEXT,
    "writtenOff" BOOLEAN NOT NULL DEFAULT false,
    "reviewFlag" BOOLEAN NOT NULL DEFAULT false,
    "refundedAt" TIMESTAMP(3),
    "refundNote" TEXT,
    "reissuedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT,
    "providerPaymentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amountSats" INTEGER NOT NULL,
    "amountUsdCents" INTEGER NOT NULL,
    "kind" "PaymentEventKind" NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amountSats" INTEGER NOT NULL,
    "amountUsdCents" INTEGER NOT NULL,
    "reason" "UnmatchedReason" NOT NULL,
    "invoiceId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "resolution" "UnmatchedResolution" NOT NULL DEFAULT 'open',
    "appliedToInvoiceId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnmatchedPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "invoiceId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_publicId_key" ON "Invoice"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_providerInvoiceId_key" ON "Invoice"("providerInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_userId_status_idx" ON "Invoice"("userId", "status");

-- CreateIndex
CREATE INDEX "Invoice_userId_createdAt_idx" ON "Invoice"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_providerPaymentId_key" ON "PaymentEvent"("providerPaymentId");

-- CreateIndex
CREATE INDEX "PaymentEvent_invoiceId_receivedAt_idx" ON "PaymentEvent"("invoiceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedPayment_providerPaymentId_key" ON "UnmatchedPayment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "UnmatchedPayment_userId_resolution_idx" ON "UnmatchedPayment"("userId", "resolution");

-- CreateIndex
CREATE INDEX "AuditLog_invoiceId_createdAt_idx" ON "AuditLog"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedPayment" ADD CONSTRAINT "UnmatchedPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedPayment" ADD CONSTRAINT "UnmatchedPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
