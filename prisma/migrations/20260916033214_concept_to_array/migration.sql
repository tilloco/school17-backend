/*
  Warnings:

  - You are about to drop the column `concept` on the `Question` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Question" DROP COLUMN "concept",
ADD COLUMN     "concepts" TEXT[] DEFAULT ARRAY[]::TEXT[];
