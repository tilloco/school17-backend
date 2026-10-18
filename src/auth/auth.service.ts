import { BadRequestException, ConflictException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { CURRENT_VERSIONS } from '../marketplace/legal/texts';
import { EmailLoginDto, EmailRegisterDto } from './dto/email-auth.dto';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OAuth2Client } from 'google-auth-library';
import { createHash, randomInt } from 'crypto';
import { CodeSender, makeSender, normalizePhone } from './telegram-gateway';
import { PhoneVerifyDto } from './dto/phone-auth.dto';
import { normalizeUsername, usernameProblem } from '../marketplace/account/username';
import { GateState, gateStep, HOUR } from './code-gate';

@Injectable()
export class AuthService {
  private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  /** testlarda almashtiriladi */
  sender: CodeSender = makeSender();

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async loginWithGoogle(idToken: string): Promise<{ accessToken: string; isNewUser: boolean }> {
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new BadRequestException("Google tokeni noto'g'ri");
    }

    const email = payload.email.toLowerCase();
    const name = payload.name;

    let user = await this.prisma.user.findUnique({ where: { email } });
    let isNewUser = false;
    // Google e-pochtani tasdiqlaydi. Agar kimdir shu e-pochta bilan parol qo'yib oldindan ro'yxatdan o'tgan bo'lsa (e-pochta tasdiqlanmagan),
    // parol o'chiriladi: egasi Google orqali kirgach hisobni begona kishi parol bilan ocholmaydi.
    if (user && !user.emailVerifiedAt) user = await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), passwordHash: null, loginFailCount: 0, lockedUntil: null } });

    if (!user) {
      isNewUser = true;
      user = await this.prisma.user.create({
        data: {
          email,
          name,
          referralCode: this.generateReferralCode(),
          emailVerifiedAt: new Date(),
          streak: { create: { currentCount: 0 } },
        },
      });
    }

    const accessToken = this.jwt.sign({ sub: user.id, email: user.email });
    return { accessToken, isNewUser };
  }

  /** Ixtiyoriy @nom: noto'g'ri yoki band bo'lsa ro'yxatdan o'tish to'xtatiladi (foydalanuvchi boshqa nom tanlaydi). */
  private async checkedUsername(raw?: string): Promise<string | undefined> {
    if (!raw || !raw.trim()) return undefined;
    const problem = usernameProblem(raw);
    if (problem) throw new BadRequestException({ message: problem === 'RESERVED_USERNAME' ? 'This username is not available' : 'Use 3-20 letters, digits or _, starting with a letter', code: problem });
    const un = normalizeUsername(raw);
    if (await this.prisma.user.findUnique({ where: { username: un }, select: { id: true } })) throw new ConflictException({ message: 'This username is taken', code: 'USERNAME_TAKEN' });
    return un;
  }

  private generateReferralCode(): string {
    return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  }

  // ---------- e-pochta + parol ----------
  // HOLAT: e-pochta egaligi tasdiqlanmaydi (xat yuborish xizmati yo'q). Himoya: Google bilan kirish parolni bekor qiladi; parolni tiklash hozircha yo'q.
  private static readonly MIN_AGE: Record<string, number> = { STUDENT: 10, TEACHER: 18, GUARDIAN: 18 };
  private static readonly WEAK = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123', 'qwertyui', '11111111', '00000000', 'iloveyou', 'school17']);
  private static readonly DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 11);
  private static readonly MAX_FAILS = 5;
  private static readonly LOCK_MS = 15 * 60_000;

  async registerEmail(dto: EmailRegisterDto): Promise<{ accessToken: string }> {
    const email = dto.email.trim().toLowerCase();
    if (!dto.acceptTerms) throw new BadRequestException({ message: 'You must accept the terms and the privacy policy', code: 'TERMS_REQUIRED' });
    const pw = dto.password;
    if (AuthService.WEAK.has(pw.toLowerCase()) || pw.toLowerCase() === email || /^(.)\1+$/.test(pw)) throw new BadRequestException({ message: 'This password is too easy to guess', code: 'WEAK_PASSWORD' });
    const dob = new Date(`${dto.dateOfBirth}T00:00:00.000Z`);
    const now = new Date();
    if (isNaN(dob.getTime()) || dob > now || dob.getUTCFullYear() < 1900) throw new BadRequestException({ message: 'Invalid date of birth', code: 'BAD_DOB' });
    const age = (now.getTime() - dob.getTime()) / (365.25 * 86_400_000);
    if (age < AuthService.MIN_AGE[dto.role]) throw new BadRequestException({ message: dto.role === 'STUDENT' ? 'The minimum age is 10' : 'Teachers and guardians must be at least 18', code: 'TOO_YOUNG' });
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException({ message: 'This email is already registered. Sign in instead.', code: 'EMAIL_TAKEN' });
    const username = await this.checkedUsername(dto.username);
    const passwordHash = await bcrypt.hash(pw, 11);
    const kinds = dto.role === 'GUARDIAN' ? (['TERMS', 'PRIVACY', 'GUARDIAN_STATEMENT'] as const) : (['TERMS', 'PRIVACY'] as const);
    const user = await this.prisma.user.create({
      data: {
        email, username, name: dto.name.trim(), role: dto.role, dateOfBirth: dob, locale: dto.locale ?? 'uz', passwordHash, referralCode: this.generateReferralCode() + randomBytes(2).toString('hex').toUpperCase(),
        consents: { create: kinds.map((kind) => ({ kind, version: CURRENT_VERSIONS[kind], locale: dto.locale ?? 'uz' })) },
      },
    });
    return { accessToken: this.jwt.sign({ sub: user.id, email: user.email }) };
  }

  async loginEmail(dto: EmailLoginDto): Promise<{ accessToken: string }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const invalid = new UnauthorizedException({ message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    if (!user || !user.passwordHash) {
      await bcrypt.compare(dto.password, AuthService.DUMMY_HASH); // vaqt farqi orqali e-pochta mavjudligini bildirmaslik
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpException({ message: 'Too many wrong attempts. Try again in 15 minutes.', code: 'ACCOUNT_LOCKED' }, 429);
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      const fails = user.loginFailCount + 1;
      const lock = fails >= AuthService.MAX_FAILS;
      await this.prisma.user.update({ where: { id: user.id }, data: lock ? { loginFailCount: 0, lockedUntil: new Date(Date.now() + AuthService.LOCK_MS) } : { loginFailCount: fails } });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') throw invalid;
    if (user.loginFailCount || user.lockedUntil) await this.prisma.user.update({ where: { id: user.id }, data: { loginFailCount: 0, lockedUntil: null } });
    return { accessToken: this.jwt.sign({ sub: user.id, email: user.email }) };
  }

  // ---------- telefon raqami + Telegram kodi ----------
  private static readonly CODE_TTL_S = 300;
  private static readonly MAX_CODE_TRIES = 5;
  private codeHash = (phone: string, code: string) => createHash('sha256').update(`${phone}:${code}`).digest('hex');

  private toGate = (r: { windowStart: Date; count: number; lastAt: Date; blockedUntil: Date | null; strictUntil: Date | null }): GateState => ({ windowStart: r.windowStart, count: r.count, lastAt: r.lastAt, blockedUntil: r.blockedUntil, strictUntil: r.strictUntil });

  /** Takes one request from this person's allowance (see code-gate.ts) or refuses with how long to wait. Returns what to put back if the code could not be sent through our fault. */
  private async takeGate(key: string, now: Date): Promise<GateState | null> {
    for (let i = 0; i < 4; i++) {
      const row = await this.prisma.phoneRequestGate.findUnique({ where: { key } });
      const prev = row ? this.toGate(row) : null;
      const r = gateStep(prev, now);
      if (!r.ok) {
        const retryAfterSeconds = Math.ceil(r.retryAfterMs / 1000);
        throw new HttpException({ message: 'You can ask for a new code again later', code: 'CODE_LOCKED', retryAfterSeconds }, 429);
      }
      try {
        if (!row) await this.prisma.phoneRequestGate.create({ data: { key, ...r.next } });
        else if ((await this.prisma.phoneRequestGate.updateMany({ where: { key, lastAt: row.lastAt, count: row.count }, data: r.next })).count === 0) continue; // someone else moved it first: look again
        return prev;
      } catch (e: any) {
        if (e?.code === 'P2002') continue;
        throw e;
      }
    }
    throw new HttpException({ message: 'Try again in a moment', code: 'CODE_RATE' }, 429);
  }

  private async giveBackGate(key: string, prev: GateState | null) {
    if (!prev) await this.prisma.phoneRequestGate.deleteMany({ where: { key } });
    else await this.prisma.phoneRequestGate.updateMany({ where: { key }, data: prev });
  }

  /** A shared school or mobile address must not lock everybody out, so the address itself only has a generous hourly cap. */
  private async addressCap(ip: string, now: Date) {
    const key = `iph:${ip}`;
    const row = await this.prisma.phoneRequestGate.findUnique({ where: { key } });
    if (!row || now.getTime() - row.windowStart.getTime() >= HOUR) {
      await this.prisma.phoneRequestGate.upsert({ where: { key }, create: { key, windowStart: now, count: 1, lastAt: now }, update: { windowStart: now, count: 1, lastAt: now, blockedUntil: null, strictUntil: null } });
      return;
    }
    if (row.count >= 40) throw new HttpException({ message: 'Too many requests from this network. Try again later.', code: 'CODE_RATE', retryAfterSeconds: Math.ceil((row.windowStart.getTime() + HOUR - now.getTime()) / 1000) }, 429);
    await this.prisma.phoneRequestGate.update({ where: { key }, data: { count: { increment: 1 }, lastAt: now } });
  }

  async requestPhoneCode(rawPhone: string, who: { deviceId?: string | null; ip?: string | null } = {}): Promise<{ sent: boolean; ttlSeconds: number; devCode?: string }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new BadRequestException({ message: 'Enter the phone number with the country code, for example +998901234567', code: 'BAD_PHONE' });
    const now = new Date();
    // One person (the phone they hold, found by its device id; without one: the address) may ask 2 times in 2 hours, then waits 2 hours, then 1 per hour.
    // Every request counts, also to a number that has no Telegram.
    const ip = (who.ip ?? 'unknown').slice(0, 64);
    await this.addressCap(ip, now);
    const key = who.deviceId && /^[A-Za-z0-9_-]{16,64}$/.test(who.deviceId) ? `dev:${who.deviceId}` : `ip:${ip}`;
    const prevGate = await this.takeGate(key, now);
    if (Math.random() < 0.02) void this.prisma.phoneRequestGate.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 48 * HOUR) } } }).catch(() => undefined);
    // har raqamga: soatiga 5 ta kod, 30 soniyada 1 ta (kod yuborish pullik, suiiste'moldan himoya)
    const recent = await this.prisma.phoneLoginCode.findMany({ where: { phone, createdAt: { gt: new Date(now.getTime() - 3_600_000) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (recent.length >= 5 || (recent[0] && now.getTime() - recent[0].createdAt.getTime() < 30_000)) throw new HttpException({ message: 'Too many code requests. Try again in a few minutes.', code: 'CODE_RATE' }, 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const res = await this.sender.send(phone, code, AuthService.CODE_TTL_S);
    if (!res.ok && res.reason === 'FAILED') await this.giveBackGate(key, prevGate); // our or Telegram's fault: it must not cost the person a try
    if (!res.ok) throw new BadRequestException({ message: res.reason === 'NO_TELEGRAM' ? 'This number has no Telegram account. Use email instead.' : 'Could not send the code. Try again or use email.', code: res.reason === 'NO_TELEGRAM' ? 'NO_TELEGRAM' : 'SEND_FAILED' });
    await this.prisma.phoneLoginCode.create({ data: { phone, codeHash: this.codeHash(phone, code), expiresAt: new Date(now.getTime() + AuthService.CODE_TTL_S * 1000) } });
    const dev = this.sender.kind === 'dev' && process.env.NODE_ENV !== 'production' && process.env.PHONE_DEV_CODES === '1';
    return { sent: true, ttlSeconds: AuthService.CODE_TTL_S, ...(dev ? { devCode: code } : {}) };
  }

  /** Eski foydalanuvchi: kirish. Yangi: profil (ism, rol, tug'ilgan sana, shartlar) kelmaguncha kod sarflanmaydi -> { needsProfile: true }. */
  async verifyPhoneCode(dto: PhoneVerifyDto): Promise<{ accessToken?: string; needsProfile?: boolean }> {
    const phone = normalizePhone(dto.phone);
    const bad = new UnauthorizedException({ message: 'Wrong or expired code', code: 'BAD_CODE' });
    if (!phone) throw bad;
    const row = await this.prisma.phoneLoginCode.findFirst({ where: { phone, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!row || row.attempts >= AuthService.MAX_CODE_TRIES) throw bad;
    if (row.codeHash !== this.codeHash(phone, dto.code)) {
      await this.prisma.phoneLoginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw bad;
    }
    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (user) {
      if (user.status !== 'ACTIVE') throw bad;
    } else {
      if (!dto.name || !dto.role || !dto.dateOfBirth) return { needsProfile: true };
      if (!dto.acceptTerms) throw new BadRequestException({ message: 'You must accept the terms and the privacy policy', code: 'TERMS_REQUIRED' });
      const dob = new Date(`${dto.dateOfBirth}T00:00:00.000Z`);
      const now = new Date();
      if (isNaN(dob.getTime()) || dob > now || dob.getUTCFullYear() < 1900) throw new BadRequestException({ message: 'Invalid date of birth', code: 'BAD_DOB' });
      const age = (now.getTime() - dob.getTime()) / (365.25 * 86_400_000);
      if (age < AuthService.MIN_AGE[dto.role]) throw new BadRequestException({ message: dto.role === 'STUDENT' ? 'The minimum age is 10' : 'Teachers and guardians must be at least 18', code: 'TOO_YOUNG' });
      const username = await this.checkedUsername(dto.username);
      const kinds = dto.role === 'GUARDIAN' ? (['TERMS', 'PRIVACY', 'GUARDIAN_STATEMENT'] as const) : (['TERMS', 'PRIVACY'] as const);
      // User.email majburiy va noyob: telefon bilan kirganlarga ichki, hech qachon yetkazilmaydigan manzil beriladi
      user = await this.prisma.user.create({
        data: {
          email: `tg${phone.slice(1)}@phone.school17.invalid`, phone, phoneHash: createHash('sha256').update(phone).digest('hex'), username, name: dto.name.trim(), role: dto.role, dateOfBirth: dob, locale: dto.locale ?? 'uz',
          referralCode: this.generateReferralCode() + randomBytes(2).toString('hex').toUpperCase(),
          consents: { create: kinds.map((kind) => ({ kind, version: CURRENT_VERSIONS[kind], locale: dto.locale ?? 'uz' })) },
        },
      });
    }
    await this.prisma.phoneLoginCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return { accessToken: this.jwt.sign({ sub: user.id, email: user.email }) };
  }
}
