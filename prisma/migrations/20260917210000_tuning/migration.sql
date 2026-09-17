-- AlterTable
ALTER TABLE "OfferDraft" ADD COLUMN     "aiText" TEXT;

-- CreateTable
CREATE TABLE "AssessmentFeedback" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "aiScore" INTEGER,
    "aiVerdict" "AiVerdict",
    "correctVerdict" "AiVerdict" NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentFeedback_createdAt_idx" ON "AssessmentFeedback"("createdAt");

-- AddForeignKey
ALTER TABLE "AssessmentFeedback" ADD CONSTRAINT "AssessmentFeedback_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

