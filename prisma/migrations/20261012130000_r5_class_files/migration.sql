-- CreateEnum
CREATE TYPE "ClassFileRender" AS ENUM ('PREPARING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'COPYRIGHT';

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'CLASS_FILE';

-- AlterEnum
ALTER TYPE "StoredFilePurpose" ADD VALUE 'CLASS_FILE';






-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "presentFileId" TEXT,
ADD COLUMN     "presentPage" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ClassFile" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "renderedPages" INTEGER NOT NULL DEFAULT 0,
    "renderStatus" "ClassFileRender" NOT NULL DEFAULT 'PREPARING',
    "renderError" TEXT,
    "renderAttempts" INTEGER NOT NULL DEFAULT 0,
    "takedownAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassAnnotation" (
    "id" TEXT NOT NULL,
    "classFileId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassFile_fileId_key" ON "ClassFile"("fileId");

-- CreateIndex
CREATE INDEX "ClassFile_classId_deletedAt_idx" ON "ClassFile"("classId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassAnnotation_classFileId_page_key" ON "ClassAnnotation"("classFileId", "page");

