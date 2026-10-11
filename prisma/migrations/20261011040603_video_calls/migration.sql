-- CreateEnum
CREATE TYPE "CallRoomStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "outcomeNote" TEXT;

-- CreateTable
CREATE TABLE "CallRoom" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "CallRoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "teacherKey" TEXT NOT NULL,
    "studentKey" TEXT NOT NULL,
    "recordingConsentTeacher" BOOLEAN,
    "recordingConsentStudent" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CallRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTokenIssue" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CallTokenIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallRoom_roomName_key" ON "CallRoom"("roomName");

-- CreateIndex
CREATE INDEX "CallRoom_bookingId_status_idx" ON "CallRoom"("bookingId", "status");

-- CreateIndex
CREATE INDEX "CallSession_bookingId_side_idx" ON "CallSession"("bookingId", "side");

-- CreateIndex
CREATE INDEX "CallSession_bookingId_userId_idx" ON "CallSession"("bookingId", "userId");

-- CreateIndex
CREATE INDEX "CallTokenIssue_roomId_userId_idx" ON "CallTokenIssue"("roomId", "userId");

-- CreateIndex
CREATE INDEX "CallEvent_bookingId_at_idx" ON "CallEvent"("bookingId", "at");

-- AddForeignKey
ALTER TABLE "CallRoom" ADD CONSTRAINT "CallRoom_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "CallRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTokenIssue" ADD CONSTRAINT "CallTokenIssue_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "CallRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
