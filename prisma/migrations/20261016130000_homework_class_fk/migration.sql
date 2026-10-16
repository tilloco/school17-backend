




-- AddForeignKey
ALTER TABLE "ClassHomework" ADD CONSTRAINT "ClassHomework_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

