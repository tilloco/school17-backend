CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "titles" JSONB NOT NULL,
    "summaries" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");
CREATE INDEX "Topic_subject_level_idx" ON "Topic"("subject", "level");

CREATE TABLE "TopicVideo" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "videoId" TEXT,
    "title" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopicVideo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TopicVideo_topicId_hidden_score_idx" ON "TopicVideo"("topicId", "hidden", "score");
CREATE INDEX "TopicVideo_addedById_idx" ON "TopicVideo"("addedById");

CREATE TABLE "TopicVideoVote" (
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopicVideoVote_pkey" PRIMARY KEY ("videoId", "userId")
);

CREATE TABLE "TopicQuestion" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "texts" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "correct" INTEGER NOT NULL,
    CONSTRAINT "TopicQuestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TopicQuestion_topicId_idx" ON "TopicQuestion"("topicId");

CREATE TABLE "TopicAttempt" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TopicAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TopicAttempt_topicId_score_idx" ON "TopicAttempt"("topicId", "score");
CREATE INDEX "TopicAttempt_userId_createdAt_idx" ON "TopicAttempt"("userId", "createdAt");

ALTER TABLE "TopicVideo" ADD CONSTRAINT "TopicVideo_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TopicVideoVote" ADD CONSTRAINT "TopicVideoVote_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "TopicVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TopicQuestion" ADD CONSTRAINT "TopicQuestion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TopicAttempt" ADD CONSTRAINT "TopicAttempt_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
