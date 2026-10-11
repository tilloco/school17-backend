-- CreateEnum
CREATE TYPE "PaymentTiming" AS ENUM ('PAY_BEFORE', 'PAY_AFTER');

-- CreateEnum
CREATE TYPE "DirectPaymentStatus" AS ENUM ('UNPAID', 'PUPIL_MARKED_PAID', 'TEACHER_CONFIRMED', 'NOT_RECEIVED', 'WAIVED');

-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'PAYMENT_PROBLEM';

-- AlterEnum
ALTER TYPE "StoredFilePurpose" ADD VALUE 'PAYMENT_PROOF';






-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "paymentTiming" "PaymentTiming" NOT NULL DEFAULT 'PAY_AFTER';

-- CreateTable
CREATE TABLE "DirectPayment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "DirectPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "pupilMarkedAt" TIMESTAMP(3),
    "teacherConfirmedAt" TIMESTAMP(3),
    "notReceivedAt" TIMESTAMP(3),
    "waivedAt" TIMESTAMP(3),
    "waivedFrom" "DirectPaymentStatus",
    "waivedReason" TEXT,
    "proofFileId" TEXT,
    "lastRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DirectPayment_bookingId_key" ON "DirectPayment"("bookingId");

-- CreateIndex
CREATE INDEX "DirectPayment_status_createdAt_idx" ON "DirectPayment"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DirectPayment" ADD CONSTRAINT "DirectPayment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectPayment" ADD CONSTRAINT "DirectPayment_proofFileId_fkey" FOREIGN KEY ("proofFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

