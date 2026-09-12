/*
  Warnings:

  - You are about to drop the column `passed` on the `ExamSession` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `Streak` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExamSession" DROP COLUMN "passed",
ADD COLUMN     "grade" TEXT;

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "articleLabel" TEXT;

-- AlterTable
ALTER TABLE "Streak" ADD COLUMN     "freezesAvailable" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "freezesUsedTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastMilestoneHit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "longestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "UserProgress_userId_completedAt_idx" ON "UserProgress"("userId", "completedAt");
