ALTER TABLE "User" ADD COLUMN "phoneHash" TEXT;
ALTER TABLE "User" ADD COLUMN "phoneDiscoverable" BOOLEAN NOT NULL DEFAULT true;
UPDATE "User" SET "phoneHash" = encode(sha256(convert_to("phone", 'UTF8')), 'hex') WHERE "phone" IS NOT NULL;
CREATE UNIQUE INDEX "User_phoneHash_key" ON "User"("phoneHash");
