-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'ERROR');

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "chunkSize" INTEGER NOT NULL DEFAULT 1048576,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "finalMime" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "thumbKey" TEXT,
ADD COLUMN     "width" INTEGER;

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "teacherLastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "studentLastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "teacherDeliveredSeq" INTEGER NOT NULL DEFAULT 0,
    "studentDeliveredSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatThread_studentUserId_idx" ON "ChatThread"("studentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatThread_teacherUserId_studentUserId_key" ON "ChatThread"("teacherUserId", "studentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_fileId_key" ON "ChatMessage"("fileId");

-- CreateIndex
CREATE INDEX "ChatMessage_senderId_createdAt_idx" ON "ChatMessage"("senderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_seq_key" ON "ChatMessage"("threadId", "seq");

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_studentUserId_fkey" FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

