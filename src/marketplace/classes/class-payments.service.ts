import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Class, ClassPayment, DirectPaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { localParts } from '../common/time';
import { DirectEvent, nextDirectStatus } from '../direct-payment/direct-payment-rules';
import { toCsv } from '../direct-payment/csv';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';
import { firstName } from './class-rules';

const DAY = 86_400_000;
const WINDOW_BACK_DAYS = 40; // shu muddatgacha o'tgan seanslar uchun qatorlar yaratiladi
const WINDOW_AHEAD_DAYS = 7; // oldindan to'lash mumkin bo'lgan kelgusi seanslar
const MAX_BULK = 100;
const OK_FOR_ENTRY: DirectPaymentStatus[] = ['TEACHER_CONFIRMED', 'WAIVED'];
const OWED: DirectPaymentStatus[] = ['UNPAID', 'NOT_RECEIVED'];

export interface PeriodRef {
  key: string;
  sessionId: string | null;
}

/** Sessiya qaysi to'lov davriga kiradi (o'qituvchi/sinf vaqt zonasida) */
export function periodOf(c: Pick<Class, 'priceModel' | 'timezone'>, s: { id: string; startAt: Date }): PeriodRef {
  if (c.priceModel === 'PER_SESSION') return { key: `S:${s.id}`, sessionId: s.id };
  const p = localParts(s.startAt, c.timezone);
  return { key: `M:${p.year}-${String(p.month).padStart(2, '0')}`, sessionId: null };
}

@Injectable()
export class ClassPaymentsService {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private guardians: GuardianService,
  ) {}

  private async ownClass(actor: Actor, classId: string) {
    const c = await this.prisma.class.findFirst({ where: { id: classId, teacher: { userId: actor.id } } });
    if (!c) throw new NotFoundException('Class not found');
    return c;
  }

  /** Narxi bor sinfda faol o'quvchilar x oynadagi (bekor qilinmagan, sinov bo'lmagan) seanslar uchun to'lov qatorlarini yaratadi. Idempotent. */
  async ensureRows(classId: string): Promise<void> {
    const c = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!c || c.priceMinor <= 0 || c.status !== 'ACTIVE') return;
    const now = this.clock.now();
    const sessions = await this.prisma.classSession.findMany({
      where: { classId, isTrial: false, status: { not: 'CANCELLED' }, startAt: { gte: new Date(now.getTime() - WINDOW_BACK_DAYS * DAY), lt: new Date(now.getTime() + WINDOW_AHEAD_DAYS * DAY) } },
      select: { id: true, startAt: true },
    });
    if (!sessions.length) return;
    const periods = new Map<string, PeriodRef>();
    for (const s of sessions) {
      const p = periodOf(c, s);
      periods.set(p.key, p);
    }
    const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    if (!pupils.length) return;
    await this.prisma.classPayment.createMany({
      data: pupils.flatMap((e) => [...periods.values()].map((p) => ({ classId, pupilId: e.pupilId, periodKey: p.key, sessionId: p.sessionId, amountMinor: BigInt(c.priceMinor) }))),
      skipDuplicates: true,
    });
  }

  private view(p: ClassPayment, name?: string | null) {
    return {
      id: p.id, classId: p.classId, pupilId: p.pupilId, name: name ?? null, periodKey: p.periodKey, sessionId: p.sessionId, amountMinor: Number(p.amountMinor), status: p.status,
      pupilMarkedAt: p.pupilMarkedAt, teacherConfirmedAt: p.teacherConfirmedAt, waivedAt: p.waivedAt, joinOverride: !!p.joinOverrideSessionId,
    };
  }

  /** Joriy davr: PER_SESSION uchun eng yaqin (yoki oxirgi o'tgan) seans, MONTHLY uchun joriy oy */
  private async currentPeriod(c: Class): Promise<PeriodRef> {
    const now = this.clock.now();
    if (c.priceModel === 'MONTHLY') return periodOf(c, { id: '', startAt: now });
    const next = await this.prisma.classSession.findFirst({ where: { classId: c.id, isTrial: false, status: { not: 'CANCELLED' }, startAt: { gte: new Date(now.getTime() - 6 * 3_600_000) } }, orderBy: { startAt: 'asc' } });
    const last = next ?? (await this.prisma.classSession.findFirst({ where: { classId: c.id, isTrial: false, status: { not: 'CANCELLED' } }, orderBy: { startAt: 'desc' } }));
    return last ? periodOf(c, last) : periodOf(c, { id: '', startAt: now });
  }

  private async periodList(c: Class): Promise<{ key: string; label: string }[]> {
    const now = this.clock.now();
    const sessions = await this.prisma.classSession.findMany({ where: { classId: c.id, isTrial: false, status: { not: 'CANCELLED' }, startAt: { lt: new Date(now.getTime() + WINDOW_AHEAD_DAYS * DAY) } }, orderBy: { startAt: 'desc' }, take: 60 });
    const seen = new Map<string, string>();
    for (const s of sessions) {
      const p = periodOf(c, s);
      if (!seen.has(p.key)) seen.set(p.key, p.sessionId ? s.startAt.toISOString() : p.key.slice(2));
      if (seen.size >= 8) break;
    }
    return [...seen].map(([key, label]) => ({ key, label }));
  }

  // ---------- o'qituvchi ----------
  async board(actor: Actor, classId: string, period?: string) {
    const c = await this.ownClass(actor, classId);
    await this.ensureRows(classId);
    const cur = await this.currentPeriod(c);
    const key = period ?? cur.key;
    if (!/^(M:\d{4}-\d{2}|S:[0-9a-f-]{36})$/.test(key)) throw new BadRequestException('Bad period');
    const rows = await this.prisma.classPayment.findMany({ where: { classId, periodKey: key }, take: 100 });
    const enrolled = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, include: { pupil: { select: { id: true, name: true } } } });
    const byPupil = new Map(rows.map((r) => [r.pupilId, r]));
    const out = enrolled
      .filter((e) => byPupil.has(e.pupilId))
      .map((e) => this.view(byPupil.get(e.pupilId)!, e.pupil.name))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return { classId, priceModel: c.priceModel, priceMinor: c.priceMinor, requirePaidToJoin: c.requirePaidToJoin, period: key, currentPeriod: cur.key, periods: await this.periodList(c), rows: out };
  }

  private async mark(actor: Actor, classId: string, ids: string[], event: DirectEvent, reason?: string) {
    await this.ownClass(actor, classId);
    if (!ids.length || ids.length > MAX_BULK) throw new BadRequestException(`Give 1..${MAX_BULK} payment ids`);
    const rows = await this.prisma.classPayment.findMany({ where: { id: { in: ids }, classId } });
    if (rows.length !== new Set(ids).size) throw new NotFoundException('Payment not found'); // boshqa sinfning yoki mavjud bo'lmagan qator: hech narsa o'zgarmaydi
    const now = this.clock.now();
    let changed = 0;
    let skipped = 0;
    for (const r of rows) {
      const to = nextDirectStatus(r.status, event);
      if (!to) {
        skipped++;
        continue;
      }
      // Kutilgan holat bo'yicha shartli yangilash: parallel bosishda ikki marta o'tmaydi
      const res = await this.prisma.classPayment.updateMany({
        where: { id: r.id, status: r.status },
        data: {
          status: to,
          ...(event === 'teacher_received' ? { teacherConfirmedAt: now } : {}),
          ...(event === 'teacher_not_received' ? { notReceivedAt: now } : {}),
          ...(event === 'teacher_waive' || event === 'system_waive' ? { waivedAt: now, waivedFrom: r.status, waivedReason: (reason ?? '').slice(0, 300) || null } : {}),
        },
      });
      if (res.count) changed++;
      else skipped++;
    }
    await this.audit.log(actor, { action: `class.payment.${event}`, targetType: 'Class', targetId: classId, metadata: { count: changed } });
    return { changed, skipped };
  }
  markReceived(actor: Actor, classId: string, ids: string[]) { return this.mark(actor, classId, ids, 'teacher_received'); }
  markNotReceived(actor: Actor, classId: string, ids: string[]) { return this.mark(actor, classId, ids, 'teacher_not_received'); }
  waive(actor: Actor, classId: string, ids: string[]) { return this.mark(actor, classId, ids, 'teacher_waive', 'teacher'); }

  /** Davrdagi to'lamaganlarga eslatma: har bir o'quvchiga sutkasiga 1 ta, xabarda karta raqami yo'q */
  async remind(actor: Actor, classId: string, period?: string) {
    const c = await this.ownClass(actor, classId);
    await this.ensureRows(classId);
    const key = period ?? (await this.currentPeriod(c)).key;
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - DAY);
    const rows = await this.prisma.classPayment.findMany({ where: { classId, periodKey: key, status: { in: OWED } }, take: 100 });
    let reminded = 0;
    let skipped = 0;
    for (const r of rows) {
      const claim = await this.prisma.classPayment.updateMany({ where: { id: r.id, OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cutoff } }] }, data: { lastRemindedAt: now } });
      if (!claim.count) {
        skipped++;
        continue;
      }
      const ids = [r.pupilId, ...(await this.guardians.guardianIdsOf(r.pupilId))];
      for (const uid of ids) await this.notifications.enqueue(uid, 'classpay.reminder', { classId }, { dedupeKey: `classpay:${r.id}:${now.toISOString().slice(0, 10)}:${uid}` });
      reminded++;
    }
    if (rows.length > 0 && reminded === 0) throw new HttpException({ message: 'You can remind a pupil once a day', code: 'REMIND_LIMIT' }, 429);
    await this.audit.log(actor, { action: 'class.payment.remind', targetType: 'Class', targetId: classId, metadata: { reminded } });
    return { reminded, skipped };
  }

  async exportCsv(actor: Actor, classId: string, period?: string) {
    const b = await this.board(actor, classId, period);
    return toCsv(['pupil', 'period', 'amount_uzs', 'status', 'confirmed_at_utc'], b.rows.map((r) => [r.name ?? '', r.periodKey, Math.round(r.amountMinor / 100), r.status, r.teacherConfirmedAt ? new Date(r.teacherConfirmedAt).toISOString() : '']));
  }

  /** O'qituvchi bitta sessiyaga kirishga bir martalik ruxsat beradi (to'lov talab qilinsa ham) */
  async override(actor: Actor, classId: string, sessionId: string, pupilId: string) {
    const c = await this.ownClass(actor, classId);
    const s = await this.prisma.classSession.findFirst({ where: { id: sessionId, classId } });
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId, status: 'ACTIVE' } });
    if (!s || !e) throw new NotFoundException('Not found');
    const p = periodOf(c, s);
    await this.prisma.classPayment.upsert({
      where: { classId_pupilId_periodKey: { classId, pupilId, periodKey: p.key } },
      update: { joinOverrideSessionId: sessionId },
      create: { classId, pupilId, periodKey: p.key, sessionId: p.sessionId, amountMinor: BigInt(c.priceMinor), joinOverrideSessionId: sessionId },
    });
    await this.audit.log(actor, { action: 'class.payment.override', targetType: 'ClassSession', targetId: sessionId, metadata: { pupilId } });
    return { ok: true };
  }

  /** O'qituvchi kelmasa shu seans uchun to'lov belgilari avtomatik "bekor" qilinadi (tasdiqlanganlarga tegilmaydi) */
  async waiveSession(sessionId: string) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: true } });
    if (!s || s.class.priceModel !== 'PER_SESSION') return 0;
    const now = this.clock.now();
    let n = 0;
    for (const status of ['UNPAID', 'PUPIL_MARKED_PAID', 'NOT_RECEIVED'] as DirectPaymentStatus[]) {
      const r = await this.prisma.classPayment.updateMany({ where: { classId: s.classId, periodKey: `S:${sessionId}`, status }, data: { status: 'WAIVED', waivedAt: now, waivedFrom: status, waivedReason: 'teacher_no_show' } });
      n += r.count;
    }
    return n;
  }

  /** Kirish eshigi: requirePaidToJoin yoqilgan bo'lsa */
  async gate(classId: string, pupilId: string, session: { id: string; startAt: Date; isTrial: boolean }) {
    const c = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!c || !c.requirePaidToJoin || c.priceMinor <= 0 || session.isTrial) return { required: false, ok: true as const };
    await this.ensureRows(classId);
    const p = periodOf(c, session);
    const row = await this.prisma.classPayment.findUnique({ where: { classId_pupilId_periodKey: { classId, pupilId, periodKey: p.key } } });
    const ok = !!row && (OK_FOR_ENTRY.includes(row.status) || row.joinOverrideSessionId === session.id);
    return { required: true, ok, teacherId: c.teacherId, paymentId: row?.id ?? null, status: row?.status ?? 'UNPAID', amountMinor: Number(row?.amountMinor ?? c.priceMinor), periodKey: p.key, classId };
  }

  /** "Kim qarz" ro'yxati: o'tgan davrlar bo'yicha to'lanmagan sinf to'lovlari, o'quvchi bo'yicha guruhlangan; ID'lar chiqmaydi */
  async owed(actor: Actor) {
    const t = await this.prisma.teacherProfile.findFirst({ where: { userId: actor.id }, select: { id: true } });
    if (!t) throw new ForbiddenException('Teachers only');
    const rows = await this.prisma.classPayment.findMany({ where: { class: { teacherId: t.id }, status: { in: OWED } }, include: { class: { select: { id: true, title: true } } }, take: 500 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.pupilId))] } }, select: { id: true, name: true, dateOfBirth: true } });
    const now = this.clock.now();
    const minor = (d: Date | null) => !d || (now.getTime() - d.getTime()) / (365.25 * DAY) < 18;
    const groups = new Map<string, { pupilName: string; classTitle: string; classId: string; count: number; totalMinor: number }>();
    for (const r of rows) {
      const u = users.find((x) => x.id === r.pupilId);
      const name = minor(u?.dateOfBirth ?? null) ? firstName(u?.name) : u?.name ?? '';
      const g = groups.get(r.pupilId + r.classId) ?? { pupilName: name, classTitle: r.class.title, classId: r.class.id, count: 0, totalMinor: 0 };
      g.count++;
      g.totalMinor += Number(r.amountMinor);
      groups.set(r.pupilId + r.classId, g);
    }
    return [...groups.values()].sort((a, b) => b.totalMinor - a.totalMinor);
  }

  // ---------- o'quvchi / vasiy ----------
  private async seats(actor: Actor) {
    return actor.role === Role.GUARDIAN ? this.guardians.linkedStudentIds(actor.id) : [actor.id];
  }
  async mine(actor: Actor) {
    const seats = await this.seats(actor);
    const classes = await this.prisma.classEnrollment.findMany({ where: { pupilId: { in: seats }, status: 'ACTIVE', class: { status: 'ACTIVE', priceMinor: { gt: 0 } } }, select: { classId: true } });
    for (const c of classes) await this.ensureRows(c.classId);
    const rows = await this.prisma.classPayment.findMany({
      where: { pupilId: { in: seats }, classId: { in: classes.map((c) => c.classId) } }, orderBy: { createdAt: 'desc' }, take: 100,
      include: { class: { select: { title: true, teacher: { select: { id: true, user: { select: { name: true } } } } } } },
    });
    return rows.map((r) => ({ ...this.view(r), classTitle: r.class.title, teacher: { id: r.class.teacher.id, name: r.class.teacher.user.name } }));
  }
  async pupilPaid(actor: Actor, paymentId: string) {
    const seats = await this.seats(actor);
    const r = await this.prisma.classPayment.findFirst({ where: { id: paymentId, pupilId: { in: seats } } });
    if (!r) throw new NotFoundException('Payment not found');
    const to = nextDirectStatus(r.status, 'pupil_paid');
    if (!to) throw new ConflictException({ message: 'This payment cannot be marked now', code: 'BAD_STATE', status: r.status });
    const res = await this.prisma.classPayment.updateMany({ where: { id: r.id, status: r.status }, data: { status: to, pupilMarkedAt: this.clock.now() } });
    if (!res.count) throw new ConflictException({ message: 'This payment changed meanwhile', code: 'BAD_STATE' });
    await this.audit.log(actor, { action: 'class.payment.pupil_paid', targetType: 'ClassPayment', targetId: r.id });
    return this.view({ ...r, status: to, pupilMarkedAt: this.clock.now() });
  }
}
