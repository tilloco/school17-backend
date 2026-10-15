import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClassPoll, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { RealtimeService } from '../messaging/realtime.service';
import { ClassFeedService } from './class-feed.service';
import { ClassRoomService } from './class-room.service';

export const POLL_LIMITS = { question: 200, option: 100, minOptions: 2, maxOptions: 6 };

@Injectable()
export class ClassPollService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private realtime: RealtimeService, private room: ClassRoomService, private feed: ClassFeedService) {}

  private async ctx(actor: Actor, sessionId: string) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s) throw new NotFoundException('Session not found');
    const teacher = s.class.teacher.userId === actor.id;
    if (!teacher) {
      const e = actor.role === Role.STUDENT ? await this.prisma.classEnrollment.findFirst({ where: { classId: s.classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } }) : null;
      if (!e) throw new NotFoundException('Session not found');
    }
    return { s: await this.room.refresh(s), teacher, teacherUserId: s.class.teacher.userId };
  }
  private async push(classId: string, teacherUserId: string, payload: object) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const u of [teacherUserId, ...rows.map((r) => r.pupilId)]) this.realtime.emitToUser(u, 'class:poll', payload);
  }

  private async counts(pollId: string, n: number) {
    const g = await this.prisma.classPollVote.groupBy({ by: ['optionIndex'], where: { pollId }, _count: { _all: true } });
    const out = Array.from({ length: n }, () => 0);
    for (const r of g) if (r.optionIndex < n) out[r.optionIndex] = r._count._all;
    return out;
  }

  /** Natijalar faqat sonlar: kim nima tanlagani chiqmaydi. O'quvchilar uchun faqat yopilgandan keyin. */
  private async view(p: ClassPoll, who: { teacher: boolean; pupilId?: string }) {
    const options = p.options as unknown as string[];
    const showCounts = who.teacher || p.status === 'CLOSED';
    const counts = showCounts ? await this.counts(p.id, options.length) : null;
    const mine = who.pupilId ? await this.prisma.classPollVote.findUnique({ where: { pollId_pupilId: { pollId: p.id, pupilId: who.pupilId } } }) : null;
    return {
      id: p.id, question: p.question, status: p.status, openedAt: p.openedAt, closedAt: p.closedAt,
      options: options.map((text, i) => ({ text, ...(counts ? { votes: counts[i] } : {}) })),
      total: counts ? counts.reduce((a, b) => a + b, 0) : undefined,
      myVote: mine ? mine.optionIndex : null,
    };
  }

  async open(actor: Actor, sessionId: string, questionIn: string, optionsIn: string[]) {
    const { s, teacher, teacherUserId } = await this.ctx(actor, sessionId);
    if (!teacher) throw new ForbiddenException('Teacher only');
    if (s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE' });
    const question = questionIn.trim();
    const options = (optionsIn ?? []).map((o) => String(o).trim());
    if (!question || question.length > POLL_LIMITS.question) throw new BadRequestException(`Question must be 1..${POLL_LIMITS.question} characters`);
    if (options.length < POLL_LIMITS.minOptions || options.length > POLL_LIMITS.maxOptions || options.some((o) => !o || o.length > POLL_LIMITS.option)) throw new BadRequestException(`Give ${POLL_LIMITS.minOptions}-${POLL_LIMITS.maxOptions} options of 1..${POLL_LIMITS.option} characters`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new BadRequestException('Options must differ');
    await this.feed.noContact(s.classId, `${question} ${options.join(' ')}`);
    const poll = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${sessionId} FOR UPDATE`; // bitta ochiq so'rovnoma: parallel ochishda ham
      if (await tx.classPoll.findFirst({ where: { sessionId, status: 'OPEN' } })) throw new ConflictException({ message: 'Close the open poll first', code: 'POLL_OPEN' });
      return tx.classPoll.create({ data: { sessionId, question, options: options as any, openedAt: this.clock.now() } });
    });
    await this.audit.log(actor, { action: 'class.poll.open', targetType: 'ClassPoll', targetId: poll.id });
    await this.push(s.classId, teacherUserId, { sessionId, pollId: poll.id, status: 'OPEN' });
    return this.view(poll, { teacher: true });
  }

  async close(actor: Actor, sessionId: string, pollId: string) {
    const { s, teacher, teacherUserId } = await this.ctx(actor, sessionId);
    if (!teacher) throw new ForbiddenException('Teacher only');
    const p = await this.prisma.classPoll.findFirst({ where: { id: pollId, sessionId } });
    if (!p) throw new NotFoundException('Poll not found');
    if (p.status === 'OPEN') await this.prisma.classPoll.updateMany({ where: { id: p.id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: this.clock.now() } });
    await this.audit.log(actor, { action: 'class.poll.close', targetType: 'ClassPoll', targetId: p.id });
    await this.push(s.classId, teacherUserId, { sessionId, pollId: p.id, status: 'CLOSED' });
    return this.view(await this.prisma.classPoll.findUniqueOrThrow({ where: { id: p.id } }), { teacher: true });
  }

  /** Ovoz: faqat backend orqali (xonadagi ma'lumot kanali orqali emas), har o'quvchi bir marta */
  async vote(actor: Actor, sessionId: string, pollId: string, option: number) {
    const { s, teacher } = await this.ctx(actor, sessionId);
    if (teacher) throw new ForbiddenException('Pupils vote');
    if (s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE' });
    const removed = await this.prisma.classParticipant.findUnique({ where: { sessionId_pupilId: { sessionId, pupilId: actor.id } } });
    if (removed?.removedAt) throw new ForbiddenException({ message: 'You were removed from this session', code: 'REMOVED_FROM_SESSION' });
    const p = await this.prisma.classPoll.findFirst({ where: { id: pollId, sessionId } });
    if (!p) throw new NotFoundException('Poll not found');
    if (p.status !== 'OPEN') throw new ConflictException({ message: 'The poll is closed', code: 'POLL_CLOSED' });
    const n = (p.options as unknown as string[]).length;
    if (!Number.isInteger(option) || option < 0 || option >= n) throw new BadRequestException('Bad option');
    try {
      await this.prisma.classPollVote.create({ data: { pollId, pupilId: actor.id, optionIndex: option, at: this.clock.now() } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already voted', code: 'ALREADY_VOTED' });
      throw e;
    }
    return { ok: true };
  }

  /** Hozirgi (ochiq yoki oxirgi yopilgan) so'rovnoma */
  async current(actor: Actor, sessionId: string) {
    const { teacher } = await this.ctx(actor, sessionId);
    const p = await this.prisma.classPoll.findFirst({ where: { sessionId }, orderBy: [{ status: 'asc' }, { openedAt: 'desc' }] }); // OPEN birinchi (enum tartibi)
    return p ? this.view(p, { teacher, pupilId: teacher ? undefined : actor.id }) : null;
  }

  async list(actor: Actor, sessionId: string) {
    const { teacher } = await this.ctx(actor, sessionId);
    const rows = await this.prisma.classPoll.findMany({ where: { sessionId, ...(teacher ? {} : { status: 'CLOSED' }) }, orderBy: { openedAt: 'asc' }, take: 50 });
    return Promise.all(rows.map((p) => this.view(p, { teacher, pupilId: teacher ? undefined : actor.id })));
  }

  /** Sessiya tugaganda ochiq so'rovnoma yopiladi va natijalar xulosaga qo'shiladi (class-feed.service buildRecap chaqiradi) */
  async closeAllAndSummarize(sessionId: string) {
    await this.prisma.classPoll.updateMany({ where: { sessionId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: this.clock.now() } });
    const rows = await this.prisma.classPoll.findMany({ where: { sessionId }, orderBy: { openedAt: 'asc' }, take: 50 });
    const out = [];
    for (const p of rows) {
      const options = p.options as unknown as string[];
      const counts = await this.counts(p.id, options.length);
      out.push({ question: p.question, options: options.map((text, i) => ({ text, votes: counts[i] })), total: counts.reduce((a, b) => a + b, 0) });
    }
    return out;
  }
}
