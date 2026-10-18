ALTER TYPE "ClassEnrollmentStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "ClassEnrollmentStatus" ADD VALUE IF NOT EXISTS 'DECLINED';
ALTER TABLE "ClassEnrollment" ADD COLUMN "proofFileId" TEXT, ADD COLUMN "note" TEXT, ADD COLUMN "decidedAt" TIMESTAMP(3), ADD COLUMN "decidedById" TEXT;
ALTER TABLE "Class" ADD COLUMN "joinApproval" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "requireProof" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "ClassHelper" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canPayments" BOOLEAN NOT NULL DEFAULT true,
    "canMembers" BOOLEAN NOT NULL DEFAULT true,
    "canChat" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassHelper_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClassHelper_classId_userId_key" ON "ClassHelper"("classId", "userId");
CREATE INDEX "ClassHelper_userId_idx" ON "ClassHelper"("userId");
ALTER TABLE "ClassHelper" ADD CONSTRAINT "ClassHelper_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
