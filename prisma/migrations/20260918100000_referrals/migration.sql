-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "referredById" TEXT;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

