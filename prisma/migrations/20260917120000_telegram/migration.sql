-- CreateEnum
CREATE TYPE "ChannelFilterMode" AS ENUM ('KEYWORDS', 'ALL');

-- CreateEnum
CREATE TYPE "KeywordKind" AS ENUM ('INCLUDE', 'EXCLUDE');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "contentHash" TEXT;

-- CreateTable
CREATE TABLE "TelegramChannel" (
    "id" TEXT NOT NULL,
    "peerId" TEXT,
    "username" TEXT,
    "title" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "filterMode" "ChannelFilterMode" NOT NULL DEFAULT 'KEYWORDS',
    "lastMessageId" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "postsSeen" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordRule" (
    "id" TEXT NOT NULL,
    "kind" "KeywordKind" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "KeywordRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "name" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "info" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChannel_peerId_key" ON "TelegramChannel"("peerId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChannel_username_key" ON "TelegramChannel"("username");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordRule_kind_value_key" ON "KeywordRule"("kind", "value");

-- CreateIndex
CREATE INDEX "Lead_contentHash_idx" ON "Lead"("contentHash");

