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
  opts: { dateOfBirth?: string | null; status?: AccountStatus; name?: string; timezone?: string; locale?: string } = {},
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
