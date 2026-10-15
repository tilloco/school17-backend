-- CreateEnum
CREATE TYPE "ClassPollStatus" AS ENUM ('OPEN', 'CLOSED');






-- CreateTable
CREATE TABLE "ClassPoll" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "status" "ClassPollStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ClassPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPollVote" (
    "pollId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassPollVote_pkey" PRIMARY KEY ("pollId","pupilId")
);

-- CreateIndex
CREATE INDEX "ClassPoll_sessionId_openedAt_idx" ON "ClassPoll"("sessionId", "openedAt");

-- AddForeignKey
ALTER TABLE "ClassPollVote" ADD CONSTRAINT "ClassPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ClassPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

