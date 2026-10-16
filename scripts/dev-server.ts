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

@Module({ imports: [AppModule], controllers: [DevLoginController] })
class DevRootModule {}

async function main() {
  mkdirSync(join(process.cwd(), 'uploads', 'avatars'), { recursive: true });
  const app = await NestFactory.create<NestExpressApplication>(DevRootModule);
  app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY));
  configureHttpSecurity(app);
  const port = Number(process.env.PORT || 3100);
  await app.listen(port, '0.0.0.0');
  console.log(`DEV BACKEND on http://localhost:${port} (local database only). POST /dev/login {role} gives a test token.`);
}
main();
