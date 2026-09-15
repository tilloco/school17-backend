"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const mod = await prisma.module.create({
        data: { title: 'Konstitutsiyaviy huquq', order: 1 },
    });
    const week = await prisma.week.create({
        data: { moduleId: mod.id, title: '1-hafta', order: 1 },
    });
    const lesson = await prisma.lesson.create({
        data: {
            weekId: week.id,
            title: "1-modda: Davlat hokimiyati manbai",
            content: "O'zbekiston Respublikasi Konstitutsiyasining 1-moddasi davlat hokimiyati manbai xalq ekanligini belgilaydi. (Bu yerga to'liq dars matni admin panel orqali qo'shiladi.)",
            order: 1,
        },
    });
    await prisma.question.create({
        data: {
            lessonId: lesson.id,
            text: "Konstitutsiyaga ko'ra, davlat hokimiyatining manbai kim/nima?",
            options: ['Prezident', 'Xalq', 'Parlament', "Konstitutsiyaviy sud"],
            correctIndex: 1,
            explanation: "1-moddaga ko'ra, O'zbekiston Respublikasida davlat hokimiyatining yagona manbai xalqdir.",
        },
    });
    console.log('Sinov ma\'lumotlari muvaffaqiyatli qo\'shildi:', { moduleId: mod.id, lessonId: lesson.id });
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map