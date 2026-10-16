// LOCAL DEV SERVER for trying the app on a phone against the NEW backend code and the throwaway local database.
//   - Refuses to start unless DATABASE_URL points at 127.0.0.1 / localhost (never production).
//   - Never reads backend/.env: run it from backend/.devdb/run (see scripts/dev-tunnel.ps1) so the production .env is not loaded.
//   - Adds POST /dev/login (dev only, lives in this script, NOT in src/) that signs in a seeded pupil / teacher / guardian.
// Usage: from backend/.devdb/run:  node -r ts-node/register/transpile-only ../../scripts/dev-server.ts
import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Body, Controller, Inject, Module, Post, ForbiddenException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsInt, Min, Max } from 'class-validator';
import { randomUUID } from 'crypto';

const url = process.env.DATABASE_URL ?? '';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('REFUSING TO START: DATABASE_URL must point at 127.0.0.1/localhost (the throwaway dev database).');
  process.exit(1);
}
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'development' : process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret-not-for-production-0123456789';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'dev-only-admin-secret-not-for-production-0123456789';
process.env.APP_DATA_KEY = process.env.APP_DATA_KEY || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.FILES_DIR = process.env.FILES_DIR || join(process.cwd(), 'files');
process.env.TRUST_PROXY = process.env.TRUST_PROXY ?? '1';
process.env.CALL_PROVIDER = 'mock';
// Real Telegram codes for local testing: put the Gateway token alone in backend/.devdb/telegram.token (gitignored). Without it, codes are shown on screen.
try {
  const tok = require('fs').readFileSync(join(process.cwd(), '..', 'telegram.token'), 'utf8').trim();
  if (tok && !process.env.TELEGRAM_GATEWAY_TOKEN) process.env.TELEGRAM_GATEWAY_TOKEN = tok;
} catch { /* no token file */ }
process.env.PHONE_DEV_CODES = process.env.TELEGRAM_GATEWAY_TOKEN ? '' : '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../src/app.module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaService } = require('../src/prisma/prisma.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { configureHttpSecurity } = require('../src/marketplace/common/http');

class DevLoginDto {
  @IsIn(['STUDENT', 'TEACHER', 'GUARDIAN']) role!: 'STUDENT' | 'TEACHER' | 'GUARDIAN';
  @IsOptional() @IsInt() @Min(1) @Max(5) slot?: number;
}

@Controller('dev')
class DevLoginController {
  constructor(@Inject(PrismaService) private prisma: any) {}

  @Post('login')
  async login(@Body() dto: DevLoginDto) {
    if (process.env.NODE_ENV === 'production') throw new ForbiddenException();
    const slot = dto.slot ?? 1;
    const email = `dev-${dto.role.toLowerCase()}-${slot}@test.local`;
    let user = await this.prisma.user.findFirst({ where: { email } });
    if (!user) {
      const id = randomUUID();
      user = await this.prisma.user.create({
        data: {
          id, email, name: dto.role === 'TEACHER' ? `Dev Teacher ${slot}` : dto.role === 'GUARDIAN' ? `Dev Guardian ${slot}` : `Dev Pupil ${slot}`,
          referralCode: `R${id.replace(/-/g, '').slice(0, 10)}`, role: dto.role as Role, status: 'ACTIVE', dateOfBirth: new Date('1990-01-01T00:00:00.000Z'), timezone: 'Asia/Tashkent', locale: 'en',
        },
      });
      const kinds = dto.role === 'GUARDIAN' ? ['TERMS', 'PRIVACY', 'GUARDIAN_STATEMENT'] : ['TERMS', 'PRIVACY'];
      for (const kind of kinds) await this.prisma.consent.create({ data: { userId: id, kind, version: '2026-10-draft-1' } }).catch(() => undefined);
    }
    if (dto.role === 'TEACHER') {
      const has = await this.prisma.teacherProfile.findFirst({ where: { userId: user.id } });
      if (!has) {
        await this.prisma.teacherProfile.create({
          data: {
            userId: user.id, headline: 'Dev math tutor', bio: 'Demo teacher for local testing. '.repeat(8), subjects: ['math'], levels: ['grades_10_11'], languages: ['uz', 'ru'],
            priceMinor: 5_000_000, instantBooking: true, verificationStatus: 'VERIFIED', verifiedAt: new Date(), ratingBayes: 4.2,
            availability: { create: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1260 })) },
          },
        });
      }
    }
    const token = new JwtService({ secret: process.env.JWT_SECRET }).sign({ sub: user.id, email: user.email }, { expiresIn: '7d' });
    return { accessToken: token, role: dto.role, name: user.name };
  }

}

// Sample people for local testing (idempotent). Same e-mail scheme as /dev/login, so "Teacher" / "Pupil" buttons log into the first of each.
const DEMO_TEACHERS = [
  { name: 'Dilnoza Karimova', headline: 'IELTS and General English, 8 years', subjects: ['english'], levels: ['adult', 'grades_10_11'], price: 8_000_000, count: 41, avg: 4.9 },
  { name: 'Jasur Aliyev', headline: 'Math for exams: grades 9-11 and university entry', subjects: ['math'], levels: ['grades_10_11', 'grades_5_9'], price: 6_000_000, count: 27, avg: 4.8 },
  { name: 'Malika Yusupova', headline: 'Russian language for school and for adults', subjects: ['russian'], levels: ['grades_5_9', 'adult'], price: 5_000_000, count: 12, avg: 4.7 },
  { name: 'Bekzod Rahimov', headline: 'Physics made simple, with experiments', subjects: ['physics'], levels: ['grades_5_9', 'grades_10_11'], price: 7_000_000, count: 9, avg: 4.6 },
  { name: 'Nigora Saidova', headline: 'Chemistry and biology for medical entry', subjects: ['chemistry', 'biology'], levels: ['grades_10_11'], price: 9_000_000, count: 18, avg: 4.9 },
];
const DEMO_PUPILS = ['Aziz Tursunov', 'Madina Ergasheva', 'Sardor Nazarov', 'Zilola Qodirova'];

async function seedDemo(prisma: any) {
  const kinds = ['TERMS', 'PRIVACY'];
  const make = async (role: 'TEACHER' | 'STUDENT', slot: number, name: string, dob: string) => {
    const email = `dev-${role.toLowerCase()}-${slot}@test.local`;
    let user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      const id = randomUUID();
      user = await prisma.user.create({ data: { id, email, name, referralCode: `R${id.replace(/-/g, '').slice(0, 10)}`, role, status: 'ACTIVE', dateOfBirth: new Date(`${dob}T00:00:00.000Z`), timezone: 'Asia/Tashkent', locale: 'en' } });
      for (const kind of kinds) await prisma.consent.create({ data: { userId: id, kind, version: '2026-10-draft-1' } }).catch(() => undefined);
    } else if (user.name !== name) user = await prisma.user.update({ where: { id: user.id }, data: { name } });
    // a @username and a short "about me" so the profile cards have something to show
    if (!user.username || !user.bio) {
      const slug = name.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '').slice(0, 18);
      const bio = role === 'TEACHER' ? 'Online teacher. Clear explanations, homework after every lesson.' : "O'qiyman, matematika va shaxmatni yaxshi ko'raman.";
      user = await prisma.user.update({ where: { id: user.id }, data: { username: user.username ?? slug, bio: user.bio ?? bio } }).catch(() => user);
    }
    return user;
  };
  for (let i = 0; i < DEMO_TEACHERS.length; i++) {
    const d = DEMO_TEACHERS[i];
    const user = await make('TEACHER', i + 1, d.name, '1990-01-01');
    const data = { headline: d.headline, bio: `${d.headline}. I teach online in Uzbek, Russian and English. Lessons are 60 minutes; the first one can be a short trial so we can see if we fit. Homework after every lesson, and I write a short note to the parent or pupil about progress.`, subjects: d.subjects, levels: d.levels, languages: ['uz', 'ru', 'en'], priceMinor: d.price, instantBooking: i % 2 === 0, verificationStatus: 'VERIFIED', verifiedAt: new Date(), ratingCount: d.count, ratingSum: Math.round(d.count * d.avg), ratingBayes: d.avg - 0.2 };
    const has = await prisma.teacherProfile.findFirst({ where: { userId: user.id } });
    if (has) await prisma.teacherProfile.update({ where: { id: has.id }, data });
    else await prisma.teacherProfile.create({ data: { userId: user.id, ...data, availability: { create: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 600, endMinute: 1200 })) } } });
  }
  for (let i = 0; i < DEMO_PUPILS.length; i++) await make('STUDENT', i + 1, DEMO_PUPILS[i], '2000-05-05');
}

@Module({ imports: [AppModule], controllers: [DevLoginController] })
class DevRootModule {}

/** A ready class for the demo teacher (Dilnoza) with the four demo pupils, a few lessons and some channel messages, so the screens have something to show. */
async function seedDemoClass(port: number) {
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, token: string | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const login = async (role: string, slot: number) => (await call('/dev/login', null, { role, slot })).body.accessToken as string;
  const teacher = await login('TEACHER', 1);
  const mine = (await call('/classes/mine', teacher)).body as { title: string }[];
  const existing = Array.isArray(mine) ? (mine as any[]).find((c) => c.title === 'Matematika, 9-sinf') : null;
  if (existing) {
    // the shared test database may have been used by the test suite (it moves the clock), so make sure there are lessons ahead
    const sess = (await call(`/classes/${existing.id}/sessions`, teacher)).body as { status: string; startAt: string }[];
    if (!Array.isArray(sess) || !sess.some((x) => x.status === 'SCHEDULED' && new Date(x.startAt) > new Date()))
      for (const days of [1, 3, 5]) await call(`/classes/${existing.id}/sessions`, teacher, { startAt: new Date(Date.now() + days * 86_400_000).toISOString(), durationMin: 60 });
    return;
  }
  for (const c of Array.isArray(mine) ? (mine as any[]) : []) if (/^Math( 00\.1)?$/.test(c.title)) await call(`/classes/${c.id}/cancel`, teacher, {});
  const made = (await call('/classes', teacher, { title: 'Matematika, 9-sinf', subject: 'Matematika', description: 'Haftada 3 marta, imtihonga tayyorlov.' })).body;
  if (!made.id) return;
  const pupils: string[] = [];
  for (let i = 1; i <= 4; i++) { const tk = await login('STUDENT', i); pupils.push(tk); await call('/classes/join', tk, { code: made.joinCode }); }
  for (const days of [1, 3, 5]) await call(`/classes/${made.id}/sessions`, teacher, { startAt: new Date(Date.now() + days * 86_400_000).toISOString(), durationMin: 60 });
  await call(`/classes/${made.id}/channel`, teacher, { body: "Salom, hammaga! Bu sinfning kanali. Savollaringizni shu yerga yozing, uy vazifasini ham shu yerga yuboring." });
  await call(`/classes/${made.id}/channel`, pupils[0], { body: "Assalomu alaykum, ustoz! Birinchi dars soat nechada?" });
  await call(`/classes/${made.id}/channel`, teacher, { body: "Dushanba kuni 18:00 da. Daftar va kalkulyatorni olib keling." });
  await call(`/classes/${made.id}/channel`, pupils[1], { body: "Rahmat, ustoz!" });
}

async function main() {
  mkdirSync(join(process.cwd(), 'uploads', 'avatars'), { recursive: true });
  const app = await NestFactory.create<NestExpressApplication>(DevRootModule);
  app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY));
  configureHttpSecurity(app);
  await seedDemo(app.get(PrismaService)).catch((e: unknown) => console.log('demo seed skipped:', (e as Error).message));
  const port = Number(process.env.PORT || 3100);
  await app.listen(port, '0.0.0.0');
  await seedDemoClass(port).catch((e: unknown) => console.log('demo class skipped:', (e as Error).message));
  console.log(`DEV BACKEND on http://localhost:${port} (local database only). POST /dev/login {role} gives a test token.`);
}
main();
