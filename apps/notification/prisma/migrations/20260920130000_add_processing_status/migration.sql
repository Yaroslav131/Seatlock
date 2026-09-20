-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN     "claimedAt" TIMESTAMP(3);
