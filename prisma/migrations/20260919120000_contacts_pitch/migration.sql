-- AlterEnum
ALTER TYPE "AiJobType" ADD VALUE 'FIND_CONTACTS';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "contacts" JSONB,
ADD COLUMN     "contactsSearchedAt" TIMESTAMP(3),
ADD COLUMN     "pitch" JSONB;

