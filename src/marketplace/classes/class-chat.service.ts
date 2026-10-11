import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassMessage, ClassQuestion, ClassSession, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { RealtimeService } from '../messaging/realtime.service';
import { detectContactInfo } from '../safety/contact-info';
import { ClassRoomService } from './class-room.service';
import { firstName } from './class-rules';

// Chegaralar (kod ichida izohli): xabar 1 ta / 2 soniya, savol 3 ta / daqiqa, uzunliklar
export const CHAT_MIN_INTERVAL_MS = 2000;
export const QUESTIONS_PER_MINUTE = 3;
export const CHAT_MAX_CHARS = 500;
export const QUESTION_MAX_CHARS = 500;
const PAGE = 100;

type Ctx = { s: ClassSession; teacher: boolean; classId: string; teacherUserId: string };

@Injectable()
export class ClassChatService {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private realtime: RealtimeService,
    private room: ClassRoomService,
  ) {}

  // ---------- ruxsat ----------
  private async ctx(actor: Actor, sessionId: string): Promise<Ctx> {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s) throw new NotFoundException('Session not found');
    const base = { s: await this.room.refresh(s), classId: s.classId, teacherUserId: s.class.teacher.userId };
    if (s.class.teacher.userId === actor.id) return { ...base, teacher: true };
    if (actor.role === Role.STUDENT) {
      const e = await this.prisma.classEnrollment.findFirst({ where: { classId: s.classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } });
      if (e) return { ...base, teacher: false };
    }
    throw new NotFoundException('Session not found');
  }
  private async teacherCtx(actor: Actor, sessionId: string) {
    const c = await this.ctx(actor, sessionId);
    if (!c.teacher) throw new ForbiddenException('Teacher only');
    return c;
  }
  private open(c: Ctx) {
    if (c.s.status !== 'LOBBY' && c.s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not open', code: 'NOT_OPEN' });
  }
  private async notMuted(sessionId: string, pupilId: string) {
    const m = await this.prisma.classMute.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId } } });
    if (m && m.until > this.clock.now()) throw new ForbiddenException({ message: 'The teacher muted you for a while', code: 'MUTED', until: m.until });
  }
  private async notRemoved(sessionId: string, pupilId: string) {
    const p = await this.prisma.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId } } });
    if (p?.removedAt) throw new ForbiddenException({ message: 'You were removed from this session', code: 'REMOVED_FROM_SESSION' });
  }
  /** Sinfda voyaga yetmagan o'quvchi bo'lsa, aloqa ma'lumotlari ulashilmaydi (xuddi 1:1 chat kabi) */
  private async assertNoContactInfo(classId: string, text: string) {
    const found = detectContactInfo(text);
    if (!found.found) return;
    const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupil: { select: { dateOfBirth: true } } } });
    const now = this.clock.now();
    const minors = pupils.some((p) => !p.pupil.dateOfBirth || ageInYears(p.pupil.dateOfBirth, now) < ADULT_AGE);
    if (minors) throw new BadRequestException({ message: "For safety, contact details can't be shared in a class with pupils under 18", code: 'CONTACT_INFO_NOT_ALLOWED', kinds: found.kinds });
  }
  private async audience(c: Ctx): Promise<string[]> {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId: c.classId, status: 'ACTIVE' }, select: { pupilId: true } });
    return [c.teacherUserId, ...rows.map((r) => r.pupilId)];
  }
  private async push(c: Ctx, event: string, payload: unknown) {
    for (const u of await this.audience(c)) this.realtime.emitToUser(u, event, payload);
  }

  // ---------- chat ----------
  private msgView(m: ClassMessage, names: Map<string, string>, teacherUserId: string) {
    return { id: m.id, seq: m.seq, at: m.createdAt, from: m.authorId === teacherUserId ? 'teacher' : 'pupil', authorId: m.authorId, name: names.get(m.authorId) ?? '', body: m.deletedAt ? null : m.body, deleted: !!m.deletedAt };
  }
  private async names(ids: string[]) {
    const us = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(us.map((u) => [u.id, firstName(u.name)]));
  }

  async messages(actor: Actor, sessionId: string, after?: number) {
    const c = await this.ctx(actor, sessionId);
    const rows = await this.prisma.classMessage.findMany({ where: { sessionId, ...(after ? { seq: { gt: after } } : {}) }, orderBy: { seq: 'asc' }, take: PAGE });
    const names = await this.names(rows.map((r) => r.authorId));
    return rows.map((m) => this.msgView(m, names, c.teacherUserId));
  }

  async send(actor: Actor, sessionId: string, bodyIn: string) {
    const c = await this.ctx(actor, sessionId);
    this.open(c);
    const body = bodyIn.trim();
    if (!body || body.length > CHAT_MAX_CHARS) throw new BadRequestException(`Message must be 1..${CHAT_MAX_CHARS} characters`);
    const now = this.clock.now();
    if (!c.teacher) {
      if (c.s.chatMode === 'OFF') throw new ForbiddenException({ message: 'Chat is off', code: 'CHAT_OFF' });
      if (c.s.chatMode === 'QUESTIONS_ONLY') throw new ForbiddenException({ message: 'Chat is limited to questions', code: 'CHAT_QUESTIONS_ONLY' });
      await this.notRemoved(sessionId, actor.id);
      await this.notMuted(sessionId, actor.id);
      const last = await this.prisma.classMessage.findFirst({ where: { sessionId, authorId: actor.id }, orderBy: { createdAt: 'desc' } });
      const wait = Math.max(CHAT_MIN_INTERVAL_MS, c.s.slowModeSeconds * 1000);
      if (last && now.getTime() - last.createdAt.getTime() < wait) throw new HttpException({ message: 'You are sending messages too fast', code: c.s.slowModeSeconds ? 'SLOW_MODE' : 'RATE_LIMIT', retryAfterMs: wait - (now.getTime() - last.createdAt.getTime()) }, 429);
    }
    await this.assertNoContactInfo(c.classId, body);
    const m = await this.prisma.classMessage.create({ data: { sessionId, authorId: actor.id, body, createdAt: now } });
    const view = this.msgView(m, await this.names([actor.id]), c.teacherUserId);
    await this.push(c, 'class:message', { sessionId, message: view });
    return view;
  }

  async deleteMessage(actor: Actor, sessionId: string, messageId: string) {
    const c = await this.teacherCtx(actor, sessionId);
    const r = await this.prisma.classMessage.updateMany({ where: { id: messageId, sessionId, deletedAt: null }, data: { deletedAt: this.clock.now(), deletedById: actor.id } });
    if (!r.count) throw new NotFoundException('Message not found');
    await this.audit.log(actor, { action: 'class.chat.delete', targetType: 'ClassMessage', targetId: messageId });
    await this.push(c, 'class:message_deleted', { sessionId, messageId });
    return { ok: true };
  }

  async reportMessage(actor: Actor, sessionId: string, messageId: string, reason: string, note?: string) {
    const c = await this.ctx(actor, sessionId);
    const m = await this.prisma.classMessage.findFirst({ where: { id: messageId, sessionId, deletedAt: null } });
    if (!m) throw new NotFoundException('Message not found');
    if (m.authorId === actor.id) throw new ForbiddenException('You cannot report your own message');
    const context = (await this.prisma.classMessage.findMany({ where: { sessionId, seq: { lte: m.seq } }, orderBy: { seq: 'desc' }, take: 6 })).reverse().map((x) => ({ seq: x.seq, from: x.authorId === c.teacherUserId ? 'teacher' : 'pupil', body: x.body, at: x.createdAt }));
    return this.report(actor, 'MESSAGE', m.id, m.authorId, sessionId, reason, note, context);
  }
  async reportPupil(actor: Actor, sessionId: string, pupilId: string, reason: string, note?: string) {
    const c = await this.ctx(actor, sessionId);
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId: c.classId, pupilId, status: 'ACTIVE' } });
    if (!e && pupilId !== c.teacherUserId) throw new NotFoundException('Not found');
    if (pupilId === actor.id) throw new ForbiddenException('You cannot report yourself');
    return this.report(actor, 'USER', pupilId, pupilId, sessionId, reason, note, undefined);
  }
  private async report(actor: Actor, targetType: 'MESSAGE' | 'USER', targetId: string, reportedUserId: string, sessionId: string, reason: string, note: string | undefined, context: unknown) {
    try {
      const r = await this.prisma.report.create({ data: { reporterId: actor.id, targetType, targetId, reason: reason as any, note: (note ?? '').trim().slice(0, 1000), snapshot: { classSessionId: sessionId, reportedUserId, context } as any } });
      await this.audit.log(actor, { action: 'report.create', targetType, targetId, metadata: { reason, classSessionId: sessionId } });
      return { id: r.id, status: r.status };
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already reported this', code: 'ALREADY_REPORTED' });
      throw e;
    }
  }

  // ---------- savollar ----------
  private async qView(q: ClassQuestion, c: Ctx, actor: Actor, voted: Set<string>, names: Map<string, string>) {
    const hide = q.anonymous && !c.teacher && q.authorId !== actor.id;
    return {
      id: q.id, seq: q.seq, text: q.text, status: q.status, pinned: q.pinned, upvotes: q.upvotes, at: q.createdAt,
      author: hide ? null : names.get(q.authorId) ?? '', anonymous: q.anonymous, ...(c.teacher ? { authorId: q.authorId } : {}),
      mine: q.authorId === actor.id, voted: voted.has(q.id), reply: q.replyText ? { text: q.replyText, at: q.repliedAt } : null,
    };
  }

  async questions(actor: Actor, sessionId: string) {
    const c = await this.ctx(actor, sessionId);
    const rows = await this.prisma.classQuestion.findMany({ where: { sessionId, ...(c.teacher ? {} : { status: { not: 'HIDDEN' } }) }, take: 300 });
    rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.upvotes - a.upvotes || a.createdAt.getTime() - b.createdAt.getTime());
    const votes = await this.prisma.classQuestionVote.findMany({ where: { voterId: actor.id, questionId: { in: rows.map((r) => r.id) } } });
    const voted = new Set(votes.map((v) => v.questionId));
    const names = await this.names(rows.map((r) => r.authorId));
    return Promise.all(rows.map((q) => this.qView(q, c, actor, voted, names)));
  }

  async ask(actor: Actor, sessionId: string, textIn: string, anonymous: boolean) {
    const c = await this.ctx(actor, sessionId);
    if (c.teacher) throw new ForbiddenException('Pupils ask questions');
    this.open(c);
    if (c.s.questionsMode === 'OFF') throw new ForbiddenException({ message: 'Questions are off', code: 'QUESTIONS_OFF' });
    await this.notRemoved(sessionId, actor.id);
    await this.notMuted(sessionId, actor.id);
    const text = textIn.trim();
    if (!text || text.length > QUESTION_MAX_CHARS) throw new BadRequestException(`Question must be 1..${QUESTION_MAX_CHARS} characters`);
    const now = this.clock.now();
    const recent = await this.prisma.classQuestion.count({ where: { authorId: actor.id, createdAt: { gt: new Date(now.getTime() - 60_000) } } });
    if (recent >= QUESTIONS_PER_MINUTE) throw new HttpException({ message: 'Too many questions. Wait a minute.', code: 'RATE_LIMIT' }, 429);
    await this.assertNoContactInfo(c.classId, text);
    const q = await this.prisma.classQuestion.create({ data: { sessionId, authorId: actor.id, text, anonymous, createdAt: now } });
    const names = await this.names([actor.id]);
    // Sinfdoshlarga ism bilan yoki anonim ko'rinishda yuboriladi; o'qituvchi uchun alohida to'liq ko'rinish
    await this.push(c, 'class:question', { sessionId, questionId: q.id });
    return this.qView(q, c, actor, new Set(), names);
  }

  async upvote(actor: Actor, sessionId: string, qid: string) {
    const c = await this.ctx(actor, sessionId);
    if (c.teacher) throw new ForbiddenException('Pupils vote');
    this.open(c);
    await this.notRemoved(sessionId, actor.id);
    const q = await this.prisma.classQuestion.findFirst({ where: { id: qid, sessionId, status: { not: 'HIDDEN' } } });
    if (!q) throw new NotFoundException('Question not found');
    try {
      await this.prisma.$transaction([
        this.prisma.classQuestionVote.create({ data: { questionId: qid, voterId: actor.id } }),
        this.prisma.classQuestion.update({ where: { id: qid }, data: { upvotes: { increment: 1 } } }),
      ]);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already voted', code: 'ALREADY_VOTED' });
      throw e;
    }
    await this.push(c, 'class:question', { sessionId, questionId: qid });
    return { ok: true, upvotes: q.upvotes + 1 };
  }

  private async teacherQuestion(actor: Actor, sessionId: string, qid: string) {
    const c = await this.teacherCtx(actor, sessionId);
    const q = await this.prisma.classQuestion.findFirst({ where: { id: qid, sessionId } });
    if (!q) throw new NotFoundException('Question not found');
    return { c, q };
  }
  async answer(actor: Actor, sessionId: string, qid: string, reply?: string) {
    const { c, q } = await this.teacherQuestion(actor, sessionId, qid);
    const text = reply?.trim();
    if (text && text.length > QUESTION_MAX_CHARS * 2) throw new BadRequestException('Reply too long');
    if (text) await this.assertNoContactInfo(c.classId, text);
    await this.prisma.classQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED', ...(text ? { replyText: text, repliedAt: this.clock.now() } : {}) } });
    await this.audit.log(actor, { action: 'class.question.answer', targetType: 'ClassQuestion', targetId: q.id });
    await this.push(c, 'class:question', { sessionId, questionId: q.id });
    return { ok: true };
  }
  async setStatus(actor: Actor, sessionId: string, qid: string, status: 'LATER' | 'HIDDEN' | 'OPEN') {
    const { c, q } = await this.teacherQuestion(actor, sessionId, qid);
    await this.prisma.classQuestion.update({ where: { id: q.id }, data: { status } });
    await this.audit.log(actor, { action: `class.question.${status.toLowerCase()}`, targetType: 'ClassQuestion', targetId: q.id });
    await this.push(c, 'class:question', { sessionId, questionId: q.id });
    return { ok: true };
  }
  async pin(actor: Actor, sessionId: string, qid: string, pinned: boolean) {
    const { c, q } = await this.teacherQuestion(actor, sessionId, qid);
    await this.prisma.classQuestion.update({ where: { id: q.id }, data: { pinned } });
    await this.push(c, 'class:question', { sessionId, questionId: q.id });
    return { ok: true };
  }
  /** "Chaqirish": o'quvchiga ovoz beriladi (R2 grant orqali) va savol javoblangan deb belgilanadi */
  async callOn(actor: Actor, sessionId: string, qid: string) {
    const { q } = await this.teacherQuestion(actor, sessionId, qid);
    await this.room.grant(actor, sessionId, q.authorId, 'VOICE');
    await this.prisma.classQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED' } });
    return { ok: true, pupilId: q.authorId };
  }

  // ---------- cheklovlar ----------
  async settings(actor: Actor, sessionId: string, input: { chatMode?: 'OPEN' | 'QUESTIONS_ONLY' | 'OFF'; questionsMode?: 'OPEN' | 'OFF'; slowModeSeconds?: number; handRaiseOn?: boolean }) {
    const c = await this.teacherCtx(actor, sessionId);
    if (c.s.status === 'ENDED' || c.s.status === 'CANCELLED') throw new ConflictException({ message: 'Session is over', code: 'SESSION_OVER' });
    if (input.slowModeSeconds !== undefined && (!Number.isInteger(input.slowModeSeconds) || input.slowModeSeconds < 0 || input.slowModeSeconds > 600)) throw new BadRequestException('Slow mode must be 0..600 seconds');
    const data: Record<string, unknown> = {};
    for (const k of ['chatMode', 'questionsMode', 'slowModeSeconds', 'handRaiseOn'] as const) if (input[k] !== undefined) data[k] = input[k];
    await this.prisma.classSession.update({ where: { id: sessionId }, data });
    await this.audit.log(actor, { action: 'class.settings', targetType: 'ClassSession', targetId: sessionId, metadata: data });
    await this.push(c, 'class:settings', { sessionId, ...data });
    return { ok: true, ...data };
  }

  async mutePupil(actor: Actor, sessionId: string, pupilId: string, minutes: number) {
    const c = await this.teacherCtx(actor, sessionId);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new BadRequestException('Minutes must be 1..240');
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId: c.classId, pupilId, status: 'ACTIVE' } });
    if (!e) throw new NotFoundException('Pupil not found');
    const until = new Date(this.clock.now().getTime() + minutes * 60_000);
    await this.prisma.classMute.upsert({ where: { sessionId_pupilId: { sessionId, pupilId } }, update: { until }, create: { sessionId, pupilId, until } });
    await this.audit.log(actor, { action: 'class.chat.mute', targetType: 'ClassSession', targetId: sessionId, metadata: { pupilId, minutes } });
    return { ok: true, until };
  }
}
