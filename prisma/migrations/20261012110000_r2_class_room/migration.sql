-- CreateEnum
CREATE TYPE "StageState" AS ENUM ('NONE', 'VOICE', 'VOICE_VIDEO');






-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "endReason" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "locked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spotlightPupilId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "teacherAbsentSince" TIMESTAMP(3),
ADD COLUMN     "teacherNoShow" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClassParticipant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "handRaisedAt" TIMESTAMP(3),
    "stage" "StageState" NOT NULL DEFAULT 'NONE',
    "stageAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassAttendance" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "firstJoinedAt" TIMESTAMP(3) NOT NULL,
    "lastJoinAt" TIMESTAMP(3),
    "lastLeftAt" TIMESTAMP(3),
    "presentNow" BOOLEAN NOT NULL DEFAULT false,
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,
    "joinCount" INTEGER NOT NULL DEFAULT 0,
    "joinedLate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClassAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassRoomEvent" (
    "eventKey" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassRoomEvent_pkey" PRIMARY KEY ("eventKey")
);

-- CreateIndex
CREATE INDEX "ClassParticipant_sessionId_stage_idx" ON "ClassParticipant"("sessionId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ClassParticipant_sessionId_pupilId_key" ON "ClassParticipant"("sessionId", "pupilId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassAttendance_sessionId_pupilId_key" ON "ClassAttendance"("sessionId", "pupilId");

-- AddForeignKey
ALTER TABLE "ClassParticipant" ADD CONSTRAINT "ClassParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassAttendance" ADD CONSTRAINT "ClassAttendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

