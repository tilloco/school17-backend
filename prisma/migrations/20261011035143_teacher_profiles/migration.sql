-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('DRAFT', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('DEGREE', 'CERTIFICATE', 'ID_DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StoredFilePurpose" AS ENUM ('CREDENTIAL', 'MESSAGE_ATTACHMENT', 'AVATAR');

-- CreateEnum
CREATE TYPE "StoredFileStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'QUARANTINED', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "originalName" TEXT NOT NULL,
    "mime" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "declaredSize" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT,
    "status" "StoredFileStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headline" TEXT NOT NULL DEFAULT '',
    "bio" TEXT NOT NULL DEFAULT '',
    "subjects" TEXT[],
    "levels" TEXT[],
    "languages" TEXT[],
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "introVideoUrl" TEXT,
    "instantBooking" BOOLEAN NOT NULL DEFAULT false,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "verifiedAt" TIMESTAMP(3),
    "verifiedByAdminId" TEXT,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingBayes" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "TeacherProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityRule" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "AvailabilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherTimeOff" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "TeacherTimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherCredential" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "title" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_storageKey_key" ON "StoredFile"("storageKey");

-- CreateIndex
CREATE INDEX "StoredFile_ownerId_createdAt_idx" ON "StoredFile"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_userId_key" ON "TeacherProfile"("userId");

-- CreateIndex
CREATE INDEX "TeacherProfile_verificationStatus_idx" ON "TeacherProfile"("verificationStatus");

-- CreateIndex
CREATE INDEX "TeacherProfile_priceMinor_idx" ON "TeacherProfile"("priceMinor");

-- CreateIndex
CREATE INDEX "AvailabilityRule_teacherId_weekday_idx" ON "AvailabilityRule"("teacherId", "weekday");

-- CreateIndex
CREATE INDEX "TeacherTimeOff_teacherId_startAt_idx" ON "TeacherTimeOff"("teacherId", "startAt");

-- CreateIndex
CREATE INDEX "TeacherCredential_teacherId_idx" ON "TeacherCredential"("teacherId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherProfile" ADD CONSTRAINT "TeacherProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherTimeOff" ADD CONSTRAINT "TeacherTimeOff_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherCredential" ADD CONSTRAINT "TeacherCredential_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherCredential" ADD CONSTRAINT "TeacherCredential_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
