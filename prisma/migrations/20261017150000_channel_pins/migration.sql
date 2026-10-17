ALTER TABLE "ClassChannelPost" ADD COLUMN "pinnedAt" TIMESTAMP(3);
CREATE INDEX "ClassChannelPost_classId_pinnedAt_idx" ON "ClassChannelPost"("classId", "pinnedAt");
