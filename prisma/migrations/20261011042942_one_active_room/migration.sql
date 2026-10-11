-- Bir bron uchun bir vaqtda faqat BITTA faol xona (poyga holatida ikkita xona yaratilib, ishtirokchilar turli xonaga tushib qolgan edi).
-- Avval mavjud takrorlarni (eng yangisidan tashqari) REVOKED qilamiz.
UPDATE "CallRoom" r SET "status" = 'REVOKED', "revokedAt" = now()
WHERE r."status" = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM "CallRoom" o WHERE o."bookingId" = r."bookingId" AND o."status" = 'ACTIVE' AND (o."createdAt", o."id") > (r."createdAt", r."id")
);
CREATE UNIQUE INDEX "CallRoom_one_active_per_booking" ON "CallRoom"("bookingId") WHERE "status" = 'ACTIVE';
