




-- CreateTable
CREATE TABLE "ClassPayment" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "sessionId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "status" "DirectPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "pupilMarkedAt" TIMESTAMP(3),
    "teacherConfirmedAt" TIMESTAMP(3),
    "notReceivedAt" TIMESTAMP(3),
    "waivedAt" TIMESTAMP(3),
    "waivedFrom" "DirectPaymentStatus",
    "waivedReason" TEXT,
    "lastRemindedAt" TIMESTAMP(3),
    "joinOverrideSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassPayment_classId_periodKey_status_idx" ON "ClassPayment"("classId", "periodKey", "status");

-- CreateIndex
CREATE INDEX "ClassPayment_pupilId_status_idx" ON "ClassPayment"("pupilId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPayment_classId_pupilId_periodKey_key" ON "ClassPayment"("classId", "pupilId", "periodKey");

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

