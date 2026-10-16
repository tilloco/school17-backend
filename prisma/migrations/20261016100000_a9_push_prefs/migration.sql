




-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "pushAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "disabled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quietStartMin" INTEGER,
    "quietEndMin" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

