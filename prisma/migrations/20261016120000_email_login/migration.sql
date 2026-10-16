




-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "loginFailCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passwordHash" TEXT;

