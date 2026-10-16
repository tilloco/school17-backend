-- CreateTable
CREATE TABLE "ClassBonus" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "pupilId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassBonus_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ClassChannelRead" (
    "classId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ClassChannelRead_pkey" PRIMARY KEY ("classId","userId")
);
-- CreateIndex
CREATE INDEX "ClassBonus_classId_pupilId_idx" ON "ClassBonus"("classId", "pupilId");
-- CreateIndex
CREATE INDEX "ClassChannelRead_userId_idx" ON "ClassChannelRead"("userId");
