-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "siteCheck" JSONB,
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Lead_contactPhone_idx" ON "Lead"("contactPhone");

