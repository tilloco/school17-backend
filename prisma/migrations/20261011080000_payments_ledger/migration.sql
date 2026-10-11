-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'ON_HOLD', 'DISPUTED', 'UNDER_REVIEW', 'RELEASED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('EXTERNAL_PAYMENTS', 'ESCROW', 'TEACHER_PENDING', 'TEACHER_AVAILABLE', 'PAYOUT_PENDING', 'PLATFORM_REVENUE', 'EXTERNAL_PAYOUTS');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "LessonPayment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "commissionBps" INTEGER NOT NULL,
    "state" "PaymentState" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "failureCode" TEXT,
    "earnedMinor" INTEGER NOT NULL DEFAULT 0,
    "commissionMinor" INTEGER NOT NULL DEFAULT 0,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "releaseAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "disputedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "ownerId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "bookingId" TEXT,
    "paymentId" TEXT,
    "payoutId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutRequest" (
    "id" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "destination" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotencyKey" TEXT NOT NULL,
    "providerRef" TEXT,
    "rejectReason" TEXT,
    "reviewedByAdminId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LessonPayment_bookingId_key" ON "LessonPayment"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "LessonPayment_idempotencyKey_key" ON "LessonPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LessonPayment_state_releaseAt_idx" ON "LessonPayment"("state", "releaseAt");

-- CreateIndex
CREATE INDEX "LessonPayment_teacherUserId_createdAt_idx" ON "LessonPayment"("teacherUserId", "createdAt");

-- CreateIndex
CREATE INDEX "LessonPayment_payerId_createdAt_idx" ON "LessonPayment"("payerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_account_ownerId_idx" ON "LedgerEntry"("account", "ownerId");

-- CreateIndex
CREATE INDEX "LedgerEntry_txnId_idx" ON "LedgerEntry"("txnId");

-- CreateIndex
CREATE INDEX "LedgerEntry_bookingId_idx" ON "LedgerEntry"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutRequest_idempotencyKey_key" ON "PayoutRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PayoutRequest_teacherUserId_requestedAt_idx" ON "PayoutRequest"("teacherUserId", "requestedAt");

-- CreateIndex
CREATE INDEX "PayoutRequest_status_requestedAt_idx" ON "PayoutRequest"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "LessonPayment" ADD CONSTRAINT "LessonPayment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Daftar o'zgarmasligi: yozuvlarni yangilash/o'chirishni ma'lumotlar bazasi darajasida taqiqlaymiz.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
ALTER TABLE "LessonPayment" ADD CONSTRAINT "lesson_payment_amounts" CHECK ("amountMinor" > 0 AND "refundedMinor" >= 0 AND "earnedMinor" >= 0 AND "commissionMinor" >= 0 AND "commissionBps" BETWEEN 0 AND 10000);
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "payout_positive" CHECK ("amountMinor" > 0);
