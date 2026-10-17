import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Class, ClassEnrollmentStatus, ClassSessionStatus, Prisma, Role, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { GuardianService } from '../guardian/guardian.service';
import { LegalService } from '../legal/legal.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlocksService } from '../safety/blocks.service';
import { ClassRemindersService } from './class-reminders.service';
import { firstName, hashSecret, newInviteToken, newJoinCode, normalizeCode, ScheduleInput, sessionTimes } from './class-rules';

const WEEK_MS = 7 * 86_400_000;

export interface ClassInput {
  title: string;
  subject: string;
  description?: string;
  capacity?: number;
  priceMinor?: number;
  priceModel?: 'PER_SESSION' | 'MONTHLY';
  weekdays?: number[];
  startMinute?: number;
  durationMin?: number;
  timezone?: string;
  startDate?: string;
  endDate?: string;
  oneOffStartAt?: string;
  stageMode?: 'LISTEN_ONLY' | 'HAND_RAISE' | 'OPEN_STAGE';
  chatMode?: 'OPEN' | 'QUESTIONS_ONLY' | 'OFF';
  questionsMode?: 'OPEN' | 'OFF';
  slowModeSeconds?: number;
  handRaiseOn?: boolean;
  allowDownload?: boolean;
  protectContent?: boolean;
  theme?: string;
  requirePaidToJoin?: boolean;
  firstSessionTrial?: boolean;
}

@Injectable()
export class ClassesService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private clock: ClockService,
    private guardians: GuardianService,
    private notifications: NotificationsService,
    private blocks: BlocksService,
    private legal: LegalService,
    private reminders: ClassRemindersService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // R12: bu runner navbatga (job queue) o'tkaziladi. Idempotent, shuning uchun bir nechta nusxada ishlashi zararsiz.
    this.timer = setInterval(() => void this.ensureSessions().catch(() => undefined), 6 * 3_600_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- yordamchilar ----------
  private async myTeacher(actor: Actor) {
    const t = await this.prisma.teacherProfile.findFirst({ where: { userId: actor.id, verificationStatus: VerificationStatus.VERIFIED }, include: { user: { select: { name: true, timezone: true } } } });
    if (!t) throw new ForbiddenException('Verified teachers only');
    return t;
  }
  private async ownClass(actor: Actor, id: string) {
    const t = await this.myTeacher(actor);
    const c = await this.prisma.class.findFirst({ where: { id, teacherId: t.id } });
    if (!c) throw new NotFoundException('Class not found');
    return { c, t };
  }
  private schedule(c: Class): ScheduleInput {
    return { weekdays: c.weekdays, startMinute: c.startMinute, durationMin: c.durationMin, timezone: c.timezone, startDate: c.startDate, endDate: c.endDate, oneOffStartAt: c.oneOffStartAt };
  }
  /** Foydalanuvchi ko'ra oladigan o'quvchi id'lari: o'zi + (vasiy bo'lsa) bog'langan bolalar. */
  private async mySeats(actor: Actor): Promise<string[]> {
    if (actor.role === Role.GUARDIAN) return this.guardians.linkedStudentIds(actor.id);
    return [actor.id];
  }

  // ---------- yaratish / tahrirlash ----------
  private validate(input: ClassInput, partial = false) {
    const cfg = marketConfig();
    const bad = (m: string) => { throw new BadRequestException(m); };
    if (input.capacity !== undefined) if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > cfg.classMaxPupils) bad(`capacity must be 1..${cfg.classMaxPupils}`);
    if (input.priceMinor !== undefined && (!Number.isInteger(input.priceMinor) || input.priceMinor < 0 || input.priceMinor > 1_000_000_000)) bad('Bad price');
    if (input.weekdays && (input.weekdays.length > 7 || input.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(input.weekdays).size !== input.weekdays.length)) bad('Bad weekdays');
    if (input.startMinute !== undefined && (!Number.isInteger(input.startMinute) || input.startMinute < 0 || input.startMinute > 1439)) bad('Bad start time');
    if (input.durationMin !== undefined && (!Number.isInteger(input.durationMin) || input.durationMin < 15 || input.durationMin > 240)) bad('Bad duration');
  }

  async create(actor: Actor, input: ClassInput) {
    this.validate(input);
    const t = await this.myTeacher(actor);
    const now = this.clock.now();
    const oneOff = input.oneOffStartAt ? new Date(input.oneOffStartAt) : null;
    if (oneOff && (isNaN(oneOff.getTime()) || oneOff <= now)) throw new BadRequestException('One-off time must be in the future');
    // Jadval majburiy emas: sinf avval kanal sifatida ochiladi, darslar keyin "Dars qo'shish" bilan qo'yiladi
    if (oneOff && input.weekdays?.length) throw new BadRequestException('Either weekdays or a one-off time, not both');
    const startDate = input.startDate ? new Date(input.startDate) : null;
    const endDate = input.endDate ? new Date(input.endDate) : null;
    if ((startDate && isNaN(startDate.getTime())) || (endDate && isNaN(endDate.getTime())) || (startDate && endDate && endDate < startDate)) throw new BadRequestException('Bad dates');
    const tz = input.timezone || t.user.timezone || 'Asia/Tashkent';
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new BadRequestException('Bad time zone'); }
    if (oneOff && input.startMinute === undefined) input.startMinute = 0;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newJoinCode();
      const invite = newInviteToken();
      try {
        const c = await this.prisma.class.create({
          data: {
            teacherId: t.id, title: input.title.trim(), subject: input.subject.trim(), description: (input.description ?? '').trim(), capacity: input.capacity ?? marketConfig().classMaxPupils,
            priceMinor: input.priceMinor ?? 0, priceModel: input.priceModel ?? 'PER_SESSION', weekdays: oneOff ? [] : input.weekdays ?? [], startMinute: input.startMinute ?? 0,
            durationMin: input.durationMin ?? 60, timezone: tz, startDate, endDate, oneOffStartAt: oneOff,
            stageMode: input.stageMode ?? 'HAND_RAISE', chatMode: input.chatMode ?? 'OPEN', questionsMode: input.questionsMode ?? 'OPEN',
            allowDownload: input.allowDownload ?? true, protectContent: input.protectContent ?? false, requirePaidToJoin: input.requirePaidToJoin ?? false, firstSessionTrial: input.firstSessionTrial ?? false,
            codeHash: hashSecret(code), inviteHash: hashSecret(invite),
          },
        });
        await this.ensureSessions(c.id);
        await this.audit.log(actor, { action: 'class.create', targetType: 'Class', targetId: c.id });
        return { ...(await this.teacherView(c.id)), joinCode: code, inviteToken: invite };
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // kod to'qnashuvi: qayta uriniladi
      }
    }
    throw new ConflictException('Could not allocate a code');
  }

  async update(actor: Actor, id: string, input: Partial<ClassInput>) {
    const { c } = await this.ownClass(actor, id);
    if (c.status === 'CANCELLED') throw new ConflictException('Class is cancelled');
    this.validate(input as ClassInput, true);
    if (input.theme !== undefined && !['ocean', 'sunset', 'forest', 'lavender', 'rose', 'midnight', 'mint', 'gold', 'slate', 'candy'].includes(input.theme)) throw new BadRequestException('Unknown theme');
    if (input.capacity !== undefined && input.capacity < c.enrolledCount) throw new ConflictException({ message: 'Capacity is below the number of enrolled pupils', code: 'CAPACITY_BELOW_ENROLLED' });
    const data: Prisma.ClassUpdateInput = {};
    for (const k of ['title', 'subject', 'description'] as const) if (input[k] !== undefined) data[k] = String(input[k]).trim();
    for (const k of ['capacity', 'priceMinor', 'priceModel', 'stageMode', 'chatMode', 'questionsMode', 'slowModeSeconds', 'handRaiseOn', 'allowDownload', 'protectContent', 'theme', 'requirePaidToJoin', 'firstSessionTrial'] as const) if (input[k] !== undefined) (data as any)[k] = input[k];
    await this.prisma.class.update({ where: { id }, data });
    // Rejim o'zgarsa kelajakdagi (hali boshlanmagan) seanslar ham yangilanadi
    if (input.slowModeSeconds !== undefined && (!Number.isInteger(input.slowModeSeconds) || input.slowModeSeconds < 0 || input.slowModeSeconds > 600)) throw new BadRequestException('Slow mode must be 0..600 seconds');
    if (input.stageMode || input.chatMode || input.questionsMode || input.slowModeSeconds !== undefined || input.handRaiseOn !== undefined) {
      await this.prisma.classSession.updateMany({
        where: { classId: id, status: 'SCHEDULED', startAt: { gt: this.clock.now() } },
        data: { ...(input.stageMode ? { stageMode: input.stageMode } : {}), ...(input.chatMode ? { chatMode: input.chatMode } : {}), ...(input.questionsMode ? { questionsMode: input.questionsMode } : {}), ...(input.slowModeSeconds !== undefined ? { slowModeSeconds: input.slowModeSeconds } : {}), ...(input.handRaiseOn !== undefined ? { handRaiseOn: input.handRaiseOn } : {}) },
      });
    }
    await this.audit.log(actor, { action: 'class.update', targetType: 'Class', targetId: id });
    return this.teacherView(id);
  }

  /** O'qituvchi sinfga bitta dars qo'shadi (istalgan paytda, jadvalsiz ham). */
  async addSession(actor: Actor, id: string, input: { startAt: string; durationMin?: number }) {
    const { c } = await this.ownClass(actor, id);
    if (c.status !== 'ACTIVE') throw new ConflictException('Class is not active');
    const start = new Date(input.startAt);
    if (isNaN(start.getTime()) || start <= this.clock.now()) throw new BadRequestException('The lesson must start in the future');
    const dur = input.durationMin ?? c.durationMin;
    if (!Number.isInteger(dur) || dur < 15 || dur > 240) throw new BadRequestException('Bad duration');
    const hadAny = (await this.prisma.classSession.count({ where: { classId: id } })) > 0;
    const s = await this.prisma.classSession.create({
      data: { classId: id, startAt: start, endAt: new Date(start.getTime() + dur * 60_000), isTrial: c.firstSessionTrial && !hadAny, stageMode: c.stageMode, chatMode: c.chatMode, questionsMode: c.questionsMode, slowModeSeconds: c.slowModeSeconds, handRaiseOn: c.handRaiseOn },
    });
    await this.reminders.sync(id);
    await this.notifyClass(id, (uid) => this.notifications.enqueue(uid, 'class.session_added', { classId: id, sessionId: s.id }));
    await this.audit.log(actor, { action: 'class.session.add', targetType: 'ClassSession', targetId: s.id });
    return { id: s.id, startAt: s.startAt, endAt: s.endAt };
  }

  async cancel(actor: Actor, id: string) {
    const { c } = await this.ownClass(actor, id);
    if (c.status === 'CANCELLED') return this.teacherView(id);
    const now = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.class.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now } }),
      this.prisma.classSession.updateMany({ where: { classId: id, status: { in: ['SCHEDULED', 'LOBBY'] } }, data: { status: 'CANCELLED', cancelledAt: now } }),
    ]);
    await this.reminders.cancelClass(id);
    await this.notifyClass(id, (uid) => this.notifications.enqueue(uid, 'class.cancelled', { classId: id }));
    await this.audit.log(actor, { action: 'class.cancel', targetType: 'Class', targetId: id });
    return this.teacherView(id);
  }

  async cancelSession(actor: Actor, classId: string, sessionId: string) {
    await this.ownClass(actor, classId);
    const s = await this.prisma.classSession.findFirst({ where: { id: sessionId, classId } });
    if (!s) throw new NotFoundException('Session not found');
    if (s.status === 'CANCELLED') return { id: s.id, status: s.status };
    if (s.status !== 'SCHEDULED' && s.status !== 'LOBBY') throw new ConflictException('Session already started or finished');
    await this.prisma.classSession.update({ where: { id: s.id }, data: { status: 'CANCELLED', cancelledAt: this.clock.now() } });
    await this.reminders.cancelSession(sessionId);
    await this.notifyClass(classId, (uid) => this.notifications.enqueue(uid, 'class.session_cancelled', { classId, sessionId }));
    await this.audit.log(actor, { action: 'class.session.cancel', targetType: 'ClassSession', targetId: s.id });
    return { id: s.id, status: 'CANCELLED' };
  }

  async regenerateCode(actor: Actor, id: string) {
    await this.ownClass(actor, id);
    const code = newJoinCode();
    const invite = newInviteToken();
    await this.prisma.class.update({ where: { id }, data: { codeHash: hashSecret(code), inviteHash: hashSecret(invite) } });
    await this.audit.log(actor, { action: 'class.code.regenerate', targetType: 'Class', targetId: id });
    return { joinCode: code, inviteToken: invite };
  }

  // ---------- seanslarni yaratish (idempotent) ----------
  async ensureSessions(classId?: string): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + marketConfig().classHorizonWeeks * WEEK_MS);
    const classes = await this.prisma.class.findMany({ where: { status: 'ACTIVE', ...(classId ? { id: classId } : {}) } });
    let created = 0;
    for (const c of classes) {
      const times = sessionTimes(this.schedule(c), c.oneOffStartAt ? new Date(0) : now, horizon);
      if (!times.length) continue;
      const hadAny = (await this.prisma.classSession.count({ where: { classId: c.id } })) > 0;
      const res = await this.prisma.classSession.createMany({
        data: times.map((at, i) => ({ classId: c.id, startAt: at, endAt: new Date(at.getTime() + c.durationMin * 60_000), isTrial: c.firstSessionTrial && !hadAny && i === 0, stageMode: c.stageMode, chatMode: c.chatMode, questionsMode: c.questionsMode, slowModeSeconds: c.slowModeSeconds, handRaiseOn: c.handRaiseOn })),
        skipDuplicates: true,
      });
      created += res.count;
      await this.reminders.sync(c.id);
    }
    return created;
  }

  // ---------- qo'shilish ----------
  async join(actor: Actor, input: { code?: string; token?: string; studentId?: string }) {
    const cfg = marketConfig();
    const now = this.clock.now();
    const since = new Date(now.getTime() - 3_600_000);
    // Taxmin qilishdan himoya: har bir urinish (to'g'ri yoki noto'g'ri) hisoblanadi, DB'da — bir nechta nusxada ham ishlaydi
    await this.prisma.classJoinAttempt.create({ data: { userId: actor.id, at: now } });
    const attempts = await this.prisma.classJoinAttempt.count({ where: { userId: actor.id, at: { gt: since } } });
    if (attempts > cfg.classJoinAttemptsPerHour) throw new HttpException({ message: 'Too many attempts. Try again later.', code: 'JOIN_LIMIT' }, 429);
    let where: Prisma.ClassWhereInput | null = null;
    if (input.code) {
      const code = normalizeCode(input.code);
      if (code) where = { codeHash: hashSecret(code) };
    } else if (input.token && input.token.length <= 64) where = { inviteHash: hashSecret(input.token) };
    const c = where ? await this.prisma.class.findFirst({ where: { ...where, status: 'ACTIVE' } }) : null;
    if (!c) throw new NotFoundException({ message: 'Class not found', code: 'CLASS_NOT_FOUND' });
    return this.enroll(actor, c, input.studentId);
  }

  private async enroll(actor: Actor, c: Class, studentIdIn?: string) {
    const now = this.clock.now();
    let studentId: string;
    if (actor.role === Role.STUDENT) {
      if (studentIdIn && studentIdIn !== actor.id) throw new ForbiddenException('Forbidden');
      if (!actor.ageKnown) throw new ForbiddenException('Date of birth required');
      studentId = actor.id;
    } else if (actor.role === Role.GUARDIAN) {
      if (!studentIdIn) throw new BadRequestException('studentId required');
      if (!(await this.guardians.isActiveGuardianOf(actor.id, studentIdIn))) throw new NotFoundException('Student not found');
      const st = await this.prisma.user.findUnique({ where: { id: studentIdIn }, select: { dateOfBirth: true, status: true } });
      if (!st || st.status !== 'ACTIVE') throw new NotFoundException('Student not found');
      if (!st.dateOfBirth || ageInYears(st.dateOfBirth, now) >= ADULT_AGE) throw new ForbiddenException('Guardians may enroll only minors');
      studentId = studentIdIn;
    } else throw new ForbiddenException('Forbidden');

    await this.legal.assertTerms(actor);
    const teacher = await this.prisma.teacherProfile.findUnique({ where: { id: c.teacherId }, select: { userId: true } });
    if (!teacher) throw new NotFoundException('Class not found');
    if (teacher.userId === studentId || teacher.userId === actor.id) throw new BadRequestException('Cannot enroll yourself');
    await this.blocks.assertNotBlocked(actor.id, teacher.userId);
    if (studentId !== actor.id) await this.blocks.assertNotBlocked(studentId, teacher.userId);

    const existing = await this.prisma.classEnrollment.findUnique({ where: { classId_pupilId: { classId: c.id, pupilId: studentId } } });
    if (existing?.status === 'ACTIVE') throw new ConflictException({ message: 'Already enrolled', code: 'ALREADY_ENROLLED' });
    if (existing?.status === 'REMOVED') throw new ForbiddenException({ message: 'The teacher removed this pupil from the class', code: 'REMOVED' });

    // Sig'im atomik: shartli UPDATE — parallel so'rovlarda ham aynan `capacity` ta o'rin beriladi
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`UPDATE "Class" SET "enrolledCount" = "enrolledCount" + 1 WHERE id = ${c.id} AND "status" = 'ACTIVE' AND "enrolledCount" < "capacity"`;
      if (n === 0) throw new ConflictException({ message: 'The class is full', code: 'CLASS_FULL' });
      if (existing) await tx.classEnrollment.update({ where: { id: existing.id }, data: { status: 'ACTIVE', endedAt: null, enrolledById: actor.id } });
      else await tx.classEnrollment.create({ data: { classId: c.id, pupilId: studentId, enrolledById: actor.id } });
    });
    await this.audit.log(actor, { action: 'class.enroll', targetType: 'Class', targetId: c.id, metadata: { pupilId: studentId } });
    await this.reminders.sync(c.id);
    return this.participantView(actor, c.id);
  }

  private async endEnrollment(classId: string, pupilId: string, status: ClassEnrollmentStatus) {
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.classEnrollment.updateMany({ where: { classId, pupilId, status: 'ACTIVE' }, data: { status, endedAt: this.clock.now() } });
      if (r.count) await tx.$executeRaw`UPDATE "Class" SET "enrolledCount" = GREATEST("enrolledCount" - 1, 0) WHERE id = ${classId}`;
      return r.count > 0;
    });
    return done;
  }

  async removePupil(actor: Actor, classId: string, pupilId: string) {
    await this.ownClass(actor, classId);
    if (!(await this.endEnrollment(classId, pupilId, 'REMOVED'))) throw new NotFoundException('Pupil not found');
    await this.reminders.cancelForPupil(classId, pupilId);
    await this.notifyPupil(pupilId, (uid) => this.notifications.enqueue(uid, 'class.removed', { classId }));
    await this.audit.log(actor, { action: 'class.pupil.remove', targetType: 'Class', targetId: classId, metadata: { pupilId } });
    return { ok: true };
  }

  async leave(actor: Actor, classId: string, pupilId?: string) {
    const seats = await this.mySeats(actor);
    const target = pupilId ?? actor.id;
    if (!seats.includes(target)) throw new NotFoundException('Class not found');
    if (!(await this.endEnrollment(classId, target, 'LEFT'))) throw new NotFoundException('Class not found');
    await this.reminders.cancelForPupil(classId, target);
    return { ok: true };
  }

  // ---------- ko'rinishlar ----------
  async mine(actor: Actor) {
    const now = this.clock.now();
    const next = { sessions: { where: { startAt: { gt: new Date(now.getTime() - 3_600_000) }, status: { not: 'CANCELLED' as ClassSessionStatus } }, orderBy: { startAt: 'asc' as const }, take: 1, select: { id: true, startAt: true, endAt: true, status: true, isTrial: true } } };
    if (actor.role === Role.TEACHER) {
      const t = await this.myTeacher(actor);
      const rows = await this.prisma.class.findMany({ where: { teacherId: t.id }, orderBy: { createdAt: 'desc' }, take: 100, include: next });
      return rows.map((c) => ({ ...this.baseView(c), enrolled: c.enrolledCount, next: c.sessions[0] ?? null }));
    }
    const seats = await this.mySeats(actor);
    const rows = await this.prisma.classEnrollment.findMany({
      where: { pupilId: { in: seats }, status: 'ACTIVE', class: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { class: { include: { ...next, teacher: { select: { id: true, user: { select: { name: true } } } } } }, pupil: { select: { id: true, name: true } } },
    });
    return rows.map((e) => ({ ...this.baseView(e.class), teacher: { id: e.class.teacher.id, name: e.class.teacher.user.name }, pupil: { id: e.pupil.id, name: firstName(e.pupil.name) }, next: e.class.sessions[0] ?? null }));
  }

  private baseView(c: Class) {
    return {
      id: c.id, title: c.title, subject: c.subject, description: c.description, capacity: c.capacity, priceMinor: c.priceMinor, priceModel: c.priceModel,
      weekdays: c.weekdays, startMinute: c.startMinute, durationMin: c.durationMin, timezone: c.timezone, startDate: c.startDate, endDate: c.endDate, oneOffStartAt: c.oneOffStartAt,
      stageMode: c.stageMode, chatMode: c.chatMode, questionsMode: c.questionsMode, slowModeSeconds: c.slowModeSeconds, handRaiseOn: c.handRaiseOn, protectContent: c.protectContent, theme: c.theme, hasLogo: !!c.logoFileId, allowDownload: c.allowDownload, requirePaidToJoin: c.requirePaidToJoin, firstSessionTrial: c.firstSessionTrial, status: c.status,
    };
  }

  private async teacherView(id: string) {
    const c = await this.prisma.class.findUniqueOrThrow({ where: { id }, include: { enrollments: { where: { status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } } });
    return { ...this.baseView(c), enrolled: c.enrolledCount, pupils: c.enrollments.map((e) => ({ id: e.pupil.id, name: e.pupil.name })), role: 'teacher' as const };
  }

  private async participantView(actor: Actor, id: string) {
    const c = await this.prisma.class.findUniqueOrThrow({ where: { id }, include: { teacher: { select: { id: true, user: { select: { name: true } } } }, enrollments: { where: { status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } } });
    const seats = await this.mySeats(actor);
    return {
      ...this.baseView(c), enrolled: c.enrolledCount, role: 'pupil' as const, teacher: { id: c.teacher.id, name: c.teacher.user.name },
      mySeats: c.enrollments.filter((e) => seats.includes(e.pupilId)).map((e) => e.pupilId),
      // Sinfdoshlar: faqat ism (familiya va id yo'q)
      classmates: c.enrollments.filter((e) => !seats.includes(e.pupilId)).map((e) => ({ name: firstName(e.pupil.name) })),
    };
  }

  async get(actor: Actor, id: string) {
    if (actor.role === Role.TEACHER) {
      const t = await this.prisma.teacherProfile.findFirst({ where: { userId: actor.id } });
      const own = t ? await this.prisma.class.findFirst({ where: { id, teacherId: t.id }, select: { id: true } }) : null;
      if (!own) throw new NotFoundException('Class not found');
      return this.teacherView(id);
    }
    const seats = await this.mySeats(actor);
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId: id, pupilId: { in: seats }, status: 'ACTIVE' }, select: { id: true } });
    if (!e) throw new NotFoundException('Class not found');
    return this.participantView(actor, id);
  }

  async sessions(actor: Actor, id: string, from?: string, to?: string) {
    await this.get(actor, id); // ruxsat: o'qituvchi yoki a'zo, aks holda 404
    const now = this.clock.now();
    const f = from ? new Date(from) : new Date(now.getTime() - 7 * 86_400_000);
    const t = to ? new Date(to) : new Date(now.getTime() + 8 * WEEK_MS);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || t <= f || t.getTime() - f.getTime() > 120 * 86_400_000) throw new BadRequestException('Bad range');
    const rows = await this.prisma.classSession.findMany({ where: { classId: id, startAt: { gte: f, lt: t } }, orderBy: { startAt: 'asc' }, take: 200 });
    return rows.map((s) => ({ id: s.id, startAt: s.startAt, endAt: s.endAt, status: s.status, isTrial: s.isTrial, lobbyOpensAt: new Date(s.startAt.getTime() - 10 * 60_000) }));
  }

  // ---------- bildirishnomalar ----------
  // Bildirishnoma turi har doim enqueue chaqiruvida literal yoziladi (shablon testi shuni qidiradi)
  private async notifyPupil(pupilId: string, send: (userId: string) => Promise<unknown>) {
    const ids = [pupilId, ...(await this.guardians.guardianIdsOf(pupilId))];
    for (const uid of ids) await send(uid);
  }
  private async notifyClass(classId: string, send: (userId: string) => Promise<unknown>) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const r of rows) await this.notifyPupil(r.pupilId, send);
  }
}
