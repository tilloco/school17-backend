-- CreateTable
CREATE TABLE "ClassChannelPost" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "classId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "ClassChannelPost_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "ClassChannelPost_seq_key" ON "ClassChannelPost"("seq");
-- CreateIndex
CREATE UNIQUE INDEX "ClassChannelPost_fileId_key" ON "ClassChannelPost"("fileId");
-- CreateIndex
CREATE INDEX "ClassChannelPost_classId_seq_idx" ON "ClassChannelPost"("classId", "seq");
