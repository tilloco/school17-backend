// Test yordamchilari: HAQIQIY (lekin vaqtinchalik, lokal) PostgreSQL ga ulanadi.
// XAVFSIZLIK: DATABASE_URL lokal host va "_test" bilan tugaydigan baza bo'lmasa, testlar ishlamaydi.
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { AdminJwtStrategy } from '../../admin-auth/admin-jwt.strategy';
import { PrismaModule } from '../../prisma/prisma.module';
import { configureRawWebhook } from '../common/http';
import { MarketplaceModule } from '../marketplace.module';

export const TEST_JWT_SECRET = 'test-user-secret-not-real';
export const TEST_ADMIN_JWT_SECRET = 'test-admin-secret-not-real';

export function assertSafeTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const m = /^postgres(?:ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)(?::\d+)?\/([^?]+)/.exec(url);
  if (!m || !m[2].endsWith('_test')) {
    throw new Error(
      'Refusing to run: DATABASE_URL must point to a LOCAL database whose name ends with _test. ' +
        'Start one with backend/scripts/dev-db.sh and export DATABASE_URL (see README).',
    );
  }
}

export function loadTestEnv(): void {
  assertSafeTestDatabase();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ADMIN_JWT_SECRET = TEST_ADMIN_JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.FILES_DIR = process.env.FILES_DIR || require('path').join(process.cwd(), 'uploads-test');
}

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  prisma: PrismaClient;
  jwt: JwtService;
  close(): Promise<void>;
}

export async function createTestApp(extraModules: any[] = []): Promise<TestApp> {
  loadTestEnv();
  @Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100_000 }]),
      PassportModule,
      JwtModule.register({ secret: TEST_JWT_SECRET }),
      PrismaModule,
      MarketplaceModule,
      ...extraModules,
    ],
    providers: [JwtStrategy, AdminJwtStrategy],
  })
  class TestAppModule {}

  const app = await NestFactory.create(TestAppModule, { logger: false });
  configureRawWebhook(app);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const prisma = new PrismaClient();
  return {
    app,
    baseUrl,
    prisma,
    jwt: new JwtService({ secret: TEST_JWT_SECRET }),
    close: async () => {
      await prisma.$disconnect();
      await app.close();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  token: string;
}

let counter = 0;

export async function makeUser(
  t: TestApp,
  role: Role = Role.STUDENT,
  opts: { consent?: boolean; dateOfBirth?: string | null; status?: AccountStatus; name?: string; timezone?: string; locale?: string } = {},
): Promise<TestUser> {
  counter++;
  const id = randomUUID();
  const dob = opts.dateOfBirth === undefined ? '1990-01-01' : opts.dateOfBirth;
  const user = await t.prisma.user.create({
    data: {
      id,
      email: `u${counter}-${id.slice(0, 8)}@test.local`,
      name: opts.name ?? `User ${counter}`,
      referralCode: `R${id.replace(/-/g, '').slice(0, 10)}`,
      role,
      status: opts.status ?? AccountStatus.ACTIVE,
      dateOfBirth: dob ? new Date(`${dob}T00:00:00.000Z`) : null,
      timezone: opts.timezone ?? 'Asia/Tashkent',
      locale: opts.locale ?? 'uz',
    },
  });
  if (opts.consent !== false) {
    for (const kind of ['TERMS', 'PRIVACY'] as const) await t.prisma.consent.create({ data: { userId: user.id, kind, version: '2026-10-draft-1' } });
  }
  const token = new JwtService({ secret: TEST_JWT_SECRET }).sign({ sub: user.id, email: user.email }, { expiresIn: '1h' });
  return { id: user.id, email: user.email, role, token };
}

export async function makeAdmin(t: TestApp): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const admin = await t.prisma.admin.create({
    data: { id, email: `admin-${id.slice(0, 8)}@test.local`, passwordHash: 'x', role: 'SUPERADMIN' } as any,
  });
  const token = new JwtService({ secret: TEST_ADMIN_JWT_SECRET }).sign(
    { sub: admin.id, email: admin.email, role: 'SUPERADMIN' },
    { expiresIn: '1h' },
  );
  return { id: admin.id, token };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function api(t: TestApp, token?: string) {
  const call = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
    const res = await fetch(`${t.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* matn */
    }
    return { status: res.status, body: parsed };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b ?? {}),
    patch: (p: string, b?: unknown) => call('PATCH', p, b ?? {}),
    put: (p: string, b?: unknown) => call('PUT', p, b ?? {}),
    del: (p: string) => call('DELETE', p),
  };
}

/** IDOR qoidasi: boshqa foydalanuvchining resursi uchun 403 yoki 404 (mavjudligini oshkor qilmaslik uchun 404 afzal). */
export function isDenied(status: number): boolean {
  return status === 403 || status === 404;
}

export async function makeFile(
  t: TestApp,
  ownerId: string,
  opts: { purpose?: 'CREDENTIAL' | 'MESSAGE_ATTACHMENT' | 'AVATAR'; status?: 'PENDING_UPLOAD' | 'UPLOADED' | 'QUARANTINED' | 'READY' | 'REJECTED' } = {},
) {
  const id = randomUUID();
  return t.prisma.storedFile.create({
    data: {
      id,
      ownerId,
      purpose: opts.purpose ?? 'CREDENTIAL',
      originalName: 'diploma.pdf',
      mime: 'application/pdf',
      sizeBytes: 1000,
      storageKey: `test/${id}`,
      status: opts.status ?? 'READY',
    },
  });
}

export const GOOD_PROFILE = {
  headline: 'Experienced math tutor',
  bio: 'I teach mathematics to school pupils and applicants for ten years. '.repeat(2),
  subjects: ['math'],
  levels: ['grades_10_11'],
  languages: ['uz', 'ru'],
  priceMinor: 5_000_000,
};

/** To'liq to'ldirilgan, tekshiruvga tayyor (yoki tasdiqlangan) o'qituvchi yaratadi. */
export async function makeTeacher(t: TestApp, opts: { submit?: boolean; approve?: { adminToken: string } } = {}) {
  const user = await makeUser(t, Role.TEACHER);
  const c = api(t, user.token);
  const prof = await c.put('/teachers/me/profile', GOOD_PROFILE);
  if (prof.status !== 200) throw new Error(`profile failed ${prof.status} ${JSON.stringify(prof.body)}`);
  await c.put('/teachers/me/availability', { rules: [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start: '09:00', end: '18:00' })) });
  const file = await makeFile(t, user.id);
  await c.post('/teachers/me/credentials', { kind: 'DEGREE', title: 'BSc Mathematics', fileId: file.id });
  if (opts.submit || opts.approve) await c.post('/teachers/me/submit');
  if (opts.approve) await api(t, opts.approve.adminToken).post(`/admin/market/teachers/${prof.body.id}/approve`);
  return { user, profileId: prof.body.id as string };
}

/** Minimal haqiqiy PDF (sahifasi bor, faol kontentsiz); `padTo` bayt gacha izoh bilan to'ldiriladi. */
export function makePdf(opts: { padTo?: number; extra?: string } = {}): Buffer {
  const head = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' + (opts.extra ?? '');
  const tail = 'trailer<</Root 1 0 R>>\n%%EOF\n';
  let body = head;
  if (opts.padTo && opts.padTo > head.length + tail.length) body += '%' + 'x'.repeat(opts.padTo - head.length - tail.length - 2) + '\n';
  return Buffer.from(body + tail, 'latin1');
}

export async function makeJpeg(width = 64, height = 32, withExif = true): Promise<Buffer> {
  const sharp = require('sharp');
  let p = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });
  if (withExif) p = p.withMetadata({ orientation: 6 }).withExif({ IFD0: { Copyright: 'SECRET-OWNER-NAME' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 18/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '69/1 16/1 0/1' } });
  return p.jpeg().toBuffer();
}

export const CHUNK = 1024 * 1024;

/** To'liq yuklash oqimi: init -> bo'laklar (PUT, imzolangan URL) -> complete. `skip` — yuborilmaydigan bo'laklar. */
export async function uploadFile(
  t: TestApp,
  user: TestUser,
  f: { name?: string; mime: string; bytes: Buffer; purpose?: string; skip?: number[]; noComplete?: boolean },
) {
  const c = api(t, user.token);
  const init = await c.post('/files/init', { purpose: f.purpose ?? 'MESSAGE_ATTACHMENT', name: f.name ?? 'file', size: f.bytes.length, mime: f.mime });
  if (init.status !== 201) return { init, complete: undefined as any, fileId: undefined as any };
  const { fileId, parts } = init.body;
  for (const p of parts) {
    if (f.skip?.includes(p.index)) continue;
    const r = await fetch(t.baseUrl + p.url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: f.bytes.subarray(p.index * CHUNK, (p.index + 1) * CHUNK) as any });
    if (r.status !== 200) throw new Error('chunk upload failed ' + r.status + ' ' + (await r.text()));
  }
  const complete = f.noComplete ? undefined : await c.post(`/files/${fileId}/complete`);
  return { init, complete, fileId: fileId as string };
}

export async function makeThread(t: TestApp, teacher: { user: TestUser; profileId: string }, student: TestUser, startAt = '2026-11-03T05:00:00.000Z') {
  const b = await api(t, student.token).post('/bookings', { teacherId: teacher.profileId, startAt, durationMin: 60 });
  if (b.status !== 201) throw new Error('booking failed ' + b.status + JSON.stringify(b.body));
  const th = await api(t, student.token).post('/threads', { bookingId: b.body.id });
  if (th.status !== 200) throw new Error('thread failed ' + th.status + JSON.stringify(th.body));
  return { threadId: th.body.id as string, bookingId: b.body.id as string };
}

/** To'g'ridan-to'g'ri DB ga tasdiqlangan o'qituvchi yozadi (ommaviy testlar uchun tez). */
export async function seedVerifiedTeacher(
  t: TestApp,
  o: { tag: string; subjects?: string[]; levels?: string[]; languages?: string[]; priceMinor?: number; ratingSum?: number; ratingCount?: number; instant?: boolean; status?: 'VERIFIED' | 'PENDING' | 'SUSPENDED' | 'REJECTED'; userStatus?: 'ACTIVE' | 'SUSPENDED'; verifiedAt?: Date; rules?: { weekday: number; startMinute: number; endMinute: number }[] },
) {
  const user = await makeUser(t, Role.TEACHER, { name: `T ${o.tag} ${counter}`, status: o.userStatus as any });
  const count = o.ratingCount ?? 0;
  const sum = o.ratingSum ?? 0;
  const prior = 4.2, weight = 5;
  const p = await t.prisma.teacherProfile.create({
    data: {
      userId: user.id, headline: `Tutor ${o.tag}`, bio: `Bio ${o.tag} `.repeat(10), subjects: o.subjects ?? ['math'], levels: o.levels ?? ['grades_10_11'], languages: o.languages ?? ['uz'],
      priceMinor: o.priceMinor ?? 5_000_000, instantBooking: o.instant ?? false, verificationStatus: o.status ?? 'VERIFIED', verifiedAt: o.verifiedAt ?? new Date(),
      ratingCount: count, ratingSum: sum, ratingBayes: (prior * weight + sum) / (weight + count),
      availability: { create: (o.rules ?? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 }))) },
    },
  });
  return { user, profileId: p.id };
}

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** 'admin' route'lar admin tokeni bilan, 'user' route'lar foydalanuvchi tokeni bilan ochiladi */
  scope?: 'user' | 'admin';
  /** Ruxsat berilgan rollar. Ular 401/403 OLMASLIGI kerak (400/404 ruxsat: body noto'g'ri yoki resurs yo'q). */
  allowed: Role[];
}

export interface MatrixActors {
  STUDENT: TestUser;
  GUARDIAN: TestUser;
  TEACHER: TestUser;
  adminToken: string;
}

function call(c: ReturnType<typeof api>, r: RouteSpec): Promise<ApiResult> {
  const m = r.method;
  if (m === 'GET') return c.get(r.path);
  if (m === 'DELETE') return c.del(r.path);
  if (m === 'POST') return c.post(r.path, r.body);
  if (m === 'PATCH') return c.patch(r.path, r.body);
  return c.put(r.path, r.body);
}

/**
 * Har bir route uchun: tokensiz => 401; noto'g'ri turdagi token => 401;
 * ruxsati yo'q rol => 403; ruxsati bor rol => 401/403 emas. Muvaffaqiyatsizliklar ro'yxatini qaytaradi.
 */
export async function checkRouteMatrix(t: TestApp, actors: MatrixActors, routes: RouteSpec[]): Promise<string[]> {
  const failures: string[] = [];
  for (const r of routes) {
    const scope = r.scope ?? 'user';
    const anon = await call(api(t), r);
    if (anon.status !== 401) failures.push(`${r.method} ${r.path} anonymous expected 401, got ${anon.status}`);
    if (scope === 'admin') {
      const asUser = await call(api(t, actors.STUDENT.token), r);
      if (asUser.status !== 401) failures.push(`${r.method} ${r.path} user token on admin route expected 401, got ${asUser.status}`);
      const asAdmin = await call(api(t, actors.adminToken), r);
      if (r.allowed.includes('ADMIN') && (asAdmin.status === 401 || asAdmin.status === 403)) {
        failures.push(`${r.method} ${r.path} admin should be allowed, got ${asAdmin.status}`);
      }
      continue;
    }
    const asAdmin = await call(api(t, actors.adminToken), r);
    if (asAdmin.status !== 401) failures.push(`${r.method} ${r.path} admin token on user route expected 401, got ${asAdmin.status}`);
    for (const role of ['STUDENT', 'GUARDIAN', 'TEACHER'] as const) {
      const res = await call(api(t, actors[role].token), r);
      const allowed = r.allowed.includes(role);
      if (allowed && (res.status === 401 || res.status === 403)) failures.push(`${r.method} ${r.path} ${role} should be allowed, got ${res.status}`);
      if (!allowed && res.status !== 403) failures.push(`${r.method} ${r.path} ${role} should get 403, got ${res.status}`);
    }
  }
  return failures;
}
