-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('ACTIVE', 'REQUEST', 'DECLINED');
-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "status" "ThreadStatus" NOT NULL DEFAULT 'ACTIVE';
-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "classId" TEXT,
ADD COLUMN     "textHidden" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "bookingId" DROP NOT NULL;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarFileId" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "Review_classId_authorId_key" ON "Review"("classId", "authorId");
