




-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "isTrial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TeacherPaymentInfo" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "cardNumberEnc" TEXT NOT NULL,
    "cardLast4" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherPaymentInfo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPaymentInfo_teacherId_key" ON "TeacherPaymentInfo"("teacherId");

-- AddForeignKey
ALTER TABLE "TeacherPaymentInfo" ADD CONSTRAINT "TeacherPaymentInfo_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

