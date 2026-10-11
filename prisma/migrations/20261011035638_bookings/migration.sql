-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "bookedById" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestExpiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelledByRole" TEXT,
    "cancelReason" TEXT,
    "lateCancel" BOOLEAN NOT NULL DEFAULT false,
    "proposedStartAt" TIMESTAMP(3),
    "proposedById" TEXT,
    "noShowMarkedAt" TIMESTAMP(3),
    "actualDurationSec" INTEGER,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_teacherId_startAt_idx" ON "Booking"("teacherId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_studentId_startAt_idx" ON "Booking"("studentId", "startAt");

-- CreateIndex
CREATE INDEX "Booking_bookedById_idx" ON "Booking"("bookedById");

-- CreateIndex
CREATE INDEX "Booking_status_startAt_idx" ON "Booking"("status", "startAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_sentAt_dueAt_idx" ON "Notification"("sentAt", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Qo'lda qo'shilgan himoya: poyga holatida ham ikki marta bron qilishning oldini oladi.
-- Eslatma: btree_gist kengaytmasi kerak (PostgreSQL contrib). Productionda ruxsat/versiyani tekshiring.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Booking" ADD CONSTRAINT "booking_time_valid" CHECK ("endAt" > "startAt" AND "priceMinor" >= 0);
ALTER TABLE "Booking" ADD CONSTRAINT "booking_no_teacher_overlap"
  EXCLUDE USING gist ("teacherId" WITH =, tsrange("startAt", "endAt") WITH &&)
  WHERE ("status" IN ('REQUESTED', 'CONFIRMED'));
ALTER TABLE "Booking" ADD CONSTRAINT "booking_no_student_overlap"
  EXCLUDE USING gist ("studentId" WITH =, tsrange("startAt", "endAt") WITH &&)
  WHERE ("status" IN ('REQUESTED', 'CONFIRMED'));
