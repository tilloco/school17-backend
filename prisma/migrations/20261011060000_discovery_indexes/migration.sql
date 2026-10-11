-- Qidiruv indekslari (S6). pg_trgm kengaytmasi kerak (PostgreSQL contrib); productionda mavjudligini tekshiring.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Massiv filtrlari (subjects/levels/languages has/hasSome)
CREATE INDEX "TeacherProfile_subjects_gin" ON "TeacherProfile" USING GIN ("subjects");
CREATE INDEX "TeacherProfile_levels_gin" ON "TeacherProfile" USING GIN ("levels");
CREATE INDEX "TeacherProfile_languages_gin" ON "TeacherProfile" USING GIN ("languages");

-- Ro'yxat: faqat tasdiqlanganlar, reyting bo'yicha tartiblangan sahifalash
CREATE INDEX "TeacherProfile_verified_rating" ON "TeacherProfile" ("ratingBayes" DESC, "id") WHERE "verificationStatus" = 'VERIFIED';
CREATE INDEX "TeacherProfile_verified_price" ON "TeacherProfile" ("priceMinor", "id") WHERE "verificationStatus" = 'VERIFIED';
CREATE INDEX "TeacherProfile_verified_new" ON "TeacherProfile" ("verifiedAt" DESC, "id") WHERE "verificationStatus" = 'VERIFIED';

-- Matn qidiruvi (ILIKE '%...%')
CREATE INDEX "TeacherProfile_headline_trgm" ON "TeacherProfile" USING GIN ("headline" gin_trgm_ops);
CREATE INDEX "User_name_trgm" ON "User" USING GIN ("name" gin_trgm_ops);
