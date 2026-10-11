-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClassPriceModel" AS ENUM ('PER_SESSION', 'MONTHLY');

-- CreateEnum
CREATE TYPE "StageMode" AS ENUM ('LISTEN_ONLY', 'HAND_RAISE', 'OPEN_STAGE');

-- CreateEnum
CREATE TYPE "ClassChatMode" AS ENUM ('OPEN', 'QUESTIONS_ONLY', 'OFF');

-- CreateEnum
CREATE TYPE "ClassQuestionsMode" AS ENUM ('OPEN', 'OFF');

-- CreateEnum
CREATE TYPE "ClassSessionStatus" AS ENUM ('SCHEDULED', 'LOBBY', 'LIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClassEnrollmentStatus" AS ENUM ('ACTIVE', 'REMOVED', 'LEFT');






-- CreateTable
CREATE TABLE "Class" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "capacity" INTEGER NOT NULL,
    "enrolledCount" INTEGER NOT NULL DEFAULT 0,
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "priceModel" "ClassPriceModel" NOT NULL DEFAULT 'PER_SESSION',
    "weekdays" INTEGER[],
    "startMinute" INTEGER NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "oneOffStartAt" TIMESTAMP(3),
    "stageMode" "StageMode" NOT NULL DEFAULT 'HAND_RAISE',
    "chatMode" "ClassChatMode" NOT NULL DEFAULT 'OPEN',
    "questionsMode" "ClassQuestionsMode" NOT NULL DEFAULT 'OPEN',
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "requirePaidToJoin" BOOLEAN NOT NULL DEFAULT false,
    "firstSessionTrial" BOOLEAN NOT NULL DEFAULT false,
    "status" "ClassStatus" NOT NULL DEFAULT 'ACTIVE',
    "codeHash" TEXT NOT NULL,
    "inviteHash" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSession" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ClassSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "isTrial" BOOLEAN NOT NULL DEFAULT false,
    "stageMode" "StageMode" NOT NULL,
    "chatMode" "ClassChatMode" NOT NULL,
    "questionsMode" "ClassQuestionsMode" NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassEnrollment" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "enrolledById" TEXT NOT NULL,
    "status" "ClassEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassJoinAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassJoinAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Class_codeHash_key" ON "Class"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Class_inviteHash_key" ON "Class"("inviteHash");

-- CreateIndex
CREATE INDEX "Class_teacherId_status_idx" ON "Class"("teacherId", "status");

-- CreateIndex
CREATE INDEX "ClassSession_startAt_status_idx" ON "ClassSession"("startAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_classId_startAt_key" ON "ClassSession"("classId", "startAt");

-- CreateIndex
CREATE INDEX "ClassEnrollment_pupilId_status_idx" ON "ClassEnrollment"("pupilId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClassEnrollment_classId_pupilId_key" ON "ClassEnrollment"("classId", "pupilId");

-- CreateIndex
CREATE INDEX "ClassJoinAttempt_userId_at_idx" ON "ClassJoinAttempt"("userId", "at");

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassEnrollment" ADD CONSTRAINT "ClassEnrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassEnrollment" ADD CONSTRAINT "ClassEnrollment_pupilId_fkey" FOREIGN KEY ("pupilId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassEnrollment" ADD CONSTRAINT "ClassEnrollment_enrolledById_fkey" FOREIGN KEY ("enrolledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

