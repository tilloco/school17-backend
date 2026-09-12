import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as readline from 'readline/promises';

const prisma = new PrismaClient();

// Ishga tushirish: npx ts-node prisma/create-admin.ts
// Yoki argumentlar bilan (masalan CI/deploy skriptida): npx ts-node prisma/create-admin.ts admin@example.com "MaxfiyParol123"
// ESLATMA: interaktiv rejimda parol terminalga ko'rinadi (soddalik uchun) - shaxsiy
// terminalingizda ishlatganda muammo emas, lekin ekranni boshqa birov ko'rmasin.
async function main() {
  const argEmail = process.argv[2];
  const argPassword = process.argv[3];

  let email = argEmail;
  let password = argPassword;

  if (!email || !password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!email) email = (await rl.question('Admin email: ')).trim();
    if (!password) password = (await rl.question('Admin parol (kamida 8 belgi): ')).trim();
    rl.close();
  }

  if (password.length < 8) {
    console.error("Xato: parol kamida 8 belgidan iborat bo'lishi kerak");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.admin.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash, role: 'SUPERADMIN' },
  });

  console.log(`Admin tayyor: ${admin.email} (${admin.role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
