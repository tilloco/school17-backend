-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ClassFeedKind" ADD VALUE 'NOTE';
ALTER TYPE "ClassFeedKind" ADD VALUE 'HOMEWORK';
ALTER TYPE "ClassFeedKind" ADD VALUE 'RECAP';
ALTER TYPE "ClassFeedKind" ADD VALUE 'ANSWER';

-- AlterEnum
ALTER TYPE "StoredFilePurpose" ADD VALUE 'HOMEWORK';






-- AlterTable
ALTER TABLE "ClassFeedPost" ADD COLUMN     "data" JSONB,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "noteKey" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "presentedFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ClassSessionRecap" (
    "sessionId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassSessionRecap_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "ClassHomework" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "feedPostId" TEXT,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassHomework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassHomeworkSubmission" (
    "id" TEXT NOT NULL,
    "homeworkId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "fileId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER,
    "comment" TEXT,
    "markedAt" TIMESTAMP(3),

    CONSTRAINT "ClassHomeworkSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassHomework_classId_dueAt_idx" ON "ClassHomework"("classId", "dueAt");

-- CreateIndex
CREATE INDEX "ClassHomeworkSubmission_pupilId_idx" ON "ClassHomeworkSubmission"("pupilId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassHomeworkSubmission_homeworkId_pupilId_key" ON "ClassHomeworkSubmission"("homeworkId", "pupilId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassFeedPost_noteKey_key" ON "ClassFeedPost"("noteKey");

-- AddForeignKey
ALTER TABLE "ClassHomeworkSubmission" ADD CONSTRAINT "ClassHomeworkSubmission_homeworkId_fkey" FOREIGN KEY ("homeworkId") REFERENCES "ClassHomework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

