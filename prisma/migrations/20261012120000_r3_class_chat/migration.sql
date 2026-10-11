-- CreateEnum
CREATE TYPE "ClassQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'LATER', 'HIDDEN');






-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "handRaiseOn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "slowModeSeconds" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ClassMessage" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "ClassMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassQuestion" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "status" "ClassQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "replyText" TEXT,
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassQuestionVote" (
    "questionId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,

    CONSTRAINT "ClassQuestionVote_pkey" PRIMARY KEY ("questionId","voterId")
);

-- CreateTable
CREATE TABLE "ClassMute" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassMute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassMessage_seq_key" ON "ClassMessage"("seq");

-- CreateIndex
CREATE INDEX "ClassMessage_sessionId_seq_idx" ON "ClassMessage"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "ClassMessage_authorId_createdAt_idx" ON "ClassMessage"("authorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassQuestion_seq_key" ON "ClassQuestion"("seq");

-- CreateIndex
CREATE INDEX "ClassQuestion_sessionId_seq_idx" ON "ClassQuestion"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "ClassQuestion_authorId_createdAt_idx" ON "ClassQuestion"("authorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassMute_sessionId_pupilId_key" ON "ClassMute"("sessionId", "pupilId");

-- AddForeignKey
ALTER TABLE "ClassMessage" ADD CONSTRAINT "ClassMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassQuestion" ADD CONSTRAINT "ClassQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassQuestionVote" ADD CONSTRAINT "ClassQuestionVote_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ClassQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

