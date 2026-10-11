-- CreateEnum
CREATE TYPE "ClassFeedKind" AS ENUM ('WHITEBOARD');






-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "whiteboardRev" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ClassWhiteboard" (
    "sessionId" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassWhiteboard_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "ClassFeedPost" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" "ClassFeedKind" NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT,
    "imageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassFeedPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassFeedPost_classId_createdAt_idx" ON "ClassFeedPost"("classId", "createdAt");

