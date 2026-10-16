-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'COMMENT';
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "username" TEXT;
-- CreateTable
CREATE TABLE "TeacherComment" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    CONSTRAINT "TeacherComment_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "TeacherComment_teacherId_hidden_createdAt_idx" ON "TeacherComment"("teacherId", "hidden", "createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "TeacherComment_teacherId_authorId_key" ON "TeacherComment"("teacherId", "authorId");
-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
