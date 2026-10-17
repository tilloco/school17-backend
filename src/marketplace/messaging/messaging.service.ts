import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, ChatMessage, ChatThread, Role, StoredFile } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { FilesService } from '../files/files.service';
import { GuardianService } from '../guardian/guardian.service';
import { LegalService } from '../legal/legal.service';
import { BlocksService } from '../safety/blocks.service';
import { detectContactInfo } from '../safety/contact-info';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from './realtime.service';

export const MAX_MESSAGE_LENGTH = 2000;
/** Suhbat ochish uchun bron holatlari (bekor/rad etilgan bron suhbat ochmaydi). */
const RELATIONSHIP_STATUSES: BookingStatus[] = ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'FAILED'];

export type MessageState = 'SENT' | 'DELIVERED' | 'READ';
type Side = 'TEACHER' | 'STUDENT';

type ThreadFull = ChatThread & {
  teacher: { name: string | null; avatarFileId: string | null };
  student: { name: string | null; dateOfBirth: Date | null; status: string; avatarFileId: string | null };
};
type MessageFull = ChatMessage & { file: StoredFile | null };

@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private guardians: GuardianService,
    private files: FilesService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private legal: LegalService,
    private blocks: BlocksService,
  ) {}

  // ---------- suhbat ----------

  /** Suhbat faqat o'qituvchi va o'quvchi o'rtasida, ular o'rtasida bron bor bo'lsagina ochiladi. */
  async openFromBooking(actor: Actor, bookingId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { teacher: { select: { userId: true } } } });
    if (!b || ![b.teacher.userId, b.studentId, b.bookedById].includes(actor.id)) throw new NotFoundException('Not found');
    if (!RELATIONSHIP_STATUSES.includes(b.status)) throw new ConflictException('Booking is not active');
    await this.legal.assertTerms(actor);
    await this.blocks.assertNotBlocked(b.teacher.userId, b.studentId);
    const teacherUserId = b.teacher.userId;
    const thread = await this.prisma.chatThread.upsert({
      where: { teacherUserId_studentUserId: { teacherUserId, studentUserId: b.studentId } },
      update: {},
      create: { teacherUserId, studentUserId: b.studentId },
    });
    return this.threadView(actor, await this.loadThread(thread.id));
  }

  /** So'rovni qabul qilish / rad etish (faqat so'rov yuborilgan odam). */
  async answerRequest(actor: Actor, threadId: string, accept: boolean) {
    const { t } = await this.mustSee(actor, threadId);
    if (t.status !== 'REQUEST' || t.requestedById === actor.id || (t.teacherUserId !== actor.id && t.studentUserId !== actor.id)) throw new ConflictException('Nothing to answer');
    await this.prisma.chatThread.update({ where: { id: t.id }, data: { status: accept ? 'ACTIVE' : 'DECLINED' } });
    return this.threadView(actor, await this.loadThread(t.id));
  }

  private async loadThread(id: string): Promise<ThreadFull> {
    return (await this.prisma.chatThread.findUniqueOrThrow({
      where: { id },
      include: { teacher: { select: { name: true, avatarFileId: true } }, student: { select: { name: true, dateOfBirth: true, status: true, avatarFileId: true } } },
    })) as ThreadFull;
  }

  /** Aktorning bu suhbatdagi o'rni: TEACHER | STUDENT | 'GUARDIAN' (faqat o'qish) | null (begona => 404). */
  private async roleIn(actor: Actor, t: ChatThread): Promise<Side | 'GUARDIAN' | null> {
    if (t.teacherUserId === actor.id) return 'TEACHER';
    if (t.studentUserId === actor.id) return 'STUDENT';
    if (actor.role === Role.GUARDIAN && (await this.guardians.isActiveGuardianOf(actor.id, t.studentUserId))) return 'GUARDIAN';
    return null;
  }

  private async mustSee(actor: Actor, threadId: string) {
    const t = await this.prisma.chatThread.findUnique({ where: { id: threadId } });
    if (!t) throw new NotFoundException('Not found');
    const role = await this.roleIn(actor, t);
    if (!role) throw new NotFoundException('Not found');
    return { t, role };
  }

  async list(actor: Actor) {
    const linked = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : [];
    const rows = (await this.prisma.chatThread.findMany({
      where: { OR: [{ teacherUserId: actor.id }, { studentUserId: actor.id }, ...(linked.length ? [{ studentUserId: { in: linked } }] : [])], NOT: { status: 'DECLINED', requestedById: { not: actor.id } } },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: { teacher: { select: { name: true, avatarFileId: true } }, student: { select: { name: true, dateOfBirth: true, status: true, avatarFileId: true } } },
      take: 200,
    })) as ThreadFull[];
    return Promise.all(rows.map((t) => this.threadView(actor, t)));
  }

  private async threadView(actor: Actor, t: ThreadFull) {
    const role = (await this.roleIn(actor, t)) ?? 'GUARDIAN';
    const minor = t.student.dateOfBirth ? ageInYears(t.student.dateOfBirth, this.clock.now()) < ADULT_AGE : false;
    const last = await this.prisma.chatMessage.findFirst({ where: { threadId: t.id, deletedAt: null }, orderBy: { seq: 'desc' } });
    const lastRead = role === 'TEACHER' ? t.teacherLastReadSeq : role === 'STUDENT' ? t.studentLastReadSeq : t.lastSeq;
    const unread = role === 'GUARDIAN' ? 0 : await this.prisma.chatMessage.count({ where: { threadId: t.id, seq: { gt: lastRead }, senderId: { not: actor.id }, deletedAt: null } });
    return {
      id: t.id,
      myRole: role,
      // O'qituvchi o'quvchining faqat ko'rinadigan ismini ko'radi (voyaga yetmaganlar: "Ism F."); hech qanday kontakt ma'lumoti yo'q
      other: role === 'TEACHER'
        ? (minor ? { name: displayName(t.student.name, minor) } : { id: t.studentUserId, name: displayName(t.student.name, minor), hasPhoto: !!t.student.avatarFileId }) // a minor's id and photo are never sent to the other side
        : { id: t.teacherUserId, name: t.teacher.name, hasPhoto: !!t.teacher.avatarFileId },
      status: t.status,
      requestedByMe: t.requestedById === actor.id,
      pupil: role === 'GUARDIAN' ? { name: t.student.name } : undefined,
      lastMessage: last ? { preview: last.body ? last.body.slice(0, 80) : last.fileId ? '📎' : '', at: last.createdAt, mine: last.senderId === actor.id } : null,
      unread,
      readOnly: role === 'GUARDIAN',
    };
  }

  async unreadTotal(actor: Actor): Promise<number> {
    const views = await this.list(actor);
    return views.reduce((n, v) => n + v.unread, 0);
  }

  // ---------- xabarlar ----------

  async messages(actor: Actor, threadId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number }) {
    const { t, role } = await this.mustSee(actor, threadId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const rows = (await this.prisma.chatMessage.findMany({
      where: { threadId, deletedAt: null, ...(opts.beforeSeq ? { seq: { lt: opts.beforeSeq } } : {}), ...(opts.afterSeq ? { seq: { gt: opts.afterSeq } } : {}) },
      orderBy: { seq: opts.afterSeq ? 'asc' : 'desc' },
      take: limit,
      include: { file: true },
    })) as MessageFull[];
    if (!opts.afterSeq) rows.reverse();
    return rows.map((m) => this.messageView(actor, t, role, m));
  }

  private stateFor(t: ChatThread, m: ChatMessage): MessageState {
    const fromTeacher = m.senderId === t.teacherUserId;
    const readSeq = fromTeacher ? t.studentLastReadSeq : t.teacherLastReadSeq;
    const delivSeq = fromTeacher ? t.studentDeliveredSeq : t.teacherDeliveredSeq;
    return m.seq <= readSeq ? 'READ' : m.seq <= delivSeq ? 'DELIVERED' : 'SENT';
  }

  private messageView(actor: Actor, t: ChatThread, role: Side | 'GUARDIAN', m: MessageFull) {
    return {
      id: m.id,
      threadId: m.threadId,
      seq: m.seq,
      mine: m.senderId === actor.id,
      from: m.senderId === t.teacherUserId ? 'TEACHER' : 'STUDENT',
      body: m.body,
      file: m.file ? this.files.publicView(m.file) : null,
      createdAt: m.createdAt,
      state: m.senderId === actor.id ? this.stateFor(t, m) : undefined,
    };
  }

  async send(actor: Actor, threadId: string, input: { body?: string; fileId?: string }) {
    const { t, role } = await this.mustSee(actor, threadId);
    if (role === 'GUARDIAN') throw new ForbiddenException('Guardians have read-only access');
    // Xabar so'rovi: tanish bo'lmagan odamga javob berilguncha faqat bitta xabar; javob yozish so'rovni qabul qilish hisoblanadi.
    if (t.status === 'DECLINED') throw new ForbiddenException({ message: 'This person did not accept your message request', code: 'DECLINED' });
    if (t.status === 'REQUEST') {
      if (t.requestedById !== actor.id) await this.prisma.chatThread.update({ where: { id: t.id }, data: { status: 'ACTIVE' } });
      else if ((await this.prisma.chatMessage.count({ where: { threadId, senderId: actor.id } })) >= 1) throw new ConflictException({ message: 'Wait until they accept your message request', code: 'REQUEST_PENDING' });
    }
    const body = (input.body ?? '').trim();
    if (!body && !input.fileId) throw new BadRequestException('Empty message');
    if (body.length > MAX_MESSAGE_LENGTH) throw new BadRequestException('Message too long');
    await this.legal.assertTerms(actor);
    const other = role === 'TEACHER' ? t.studentUserId : t.teacherUserId;
    await this.blocks.assertNotBlocked(t.teacherUserId, t.studentUserId);
    // Voyaga yetmagan o'quvchi bilan: faol vasiy bo'lishi shart va aloqa ma'lumotlari almashilmaydi
    const pupil = await this.prisma.user.findUnique({ where: { id: t.studentUserId }, select: { dateOfBirth: true, status: true } });
    if (!pupil || pupil.status !== 'ACTIVE') throw new ConflictException('Recipient unavailable');
    const minor = pupil?.dateOfBirth ? ageInYears(pupil.dateOfBirth, this.clock.now()) < ADULT_AGE : true; // sana noma'lum => ehtiyotkorlik bilan voyaga yetmagan deb hisoblaymiz
    if (minor) {
      // Vasiy MAJBURIY EMAS (egasining qarori): bog'langan bo'lsa u kuzatuvchi bo'ladi; aloqa ma'lumotlari baribir taqiqlanadi
      const found = detectContactInfo(body);
      if (found.found) throw new BadRequestException({ message: "For safety, contact details can't be shared in chats with pupils under 18", code: 'CONTACT_INFO_NOT_ALLOWED', kinds: found.kinds });
    }
    const otherUser = await this.prisma.user.findUnique({ where: { id: other }, select: { status: true } });
    if (!otherUser || otherUser.status !== 'ACTIVE') throw new ConflictException('Recipient unavailable');

    let file: StoredFile | null = null;
    if (input.fileId) {
      file = await this.prisma.storedFile.findFirst({ where: { id: input.fileId, ownerId: actor.id, deletedAt: null } });
      if (!file) throw new NotFoundException('File not found'); // boshqa birovning faylini ulab bo'lmaydi
      if (file.purpose !== 'MESSAGE_ATTACHMENT') throw new BadRequestException('File has wrong purpose');
      if (file.status !== 'READY') throw new ConflictException('File is not ready');
      if (await this.prisma.chatMessage.findUnique({ where: { fileId: file.id } })) throw new ConflictException('File already sent');
    }

    const msg = await this.prisma.$transaction(async (tx) => {
      // lastSeq ni atomik oshirish: bir vaqtdagi xabarlar turli seq oladi
      const updated = await tx.chatThread.update({
        where: { id: threadId },
        data: { lastSeq: { increment: 1 }, lastMessageAt: this.clock.now() },
      });
      const m = await tx.chatMessage.create({ data: { threadId, seq: updated.lastSeq, senderId: actor.id, body, fileId: file?.id }, include: { file: true } });
      // Yuboruvchi o'z xabarigacha hammasini o'qigan deb hisoblanadi
      await tx.chatThread.update({
        where: { id: threadId },
        data: role === 'TEACHER' ? { teacherLastReadSeq: updated.lastSeq, teacherDeliveredSeq: updated.lastSeq } : { studentLastReadSeq: updated.lastSeq, studentDeliveredSeq: updated.lastSeq },
      });
      return m as MessageFull;
    });
    const fresh = await this.prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } });

    // Real vaqtda yetkazish: ikkala ishtirokchi (yuboruvchining boshqa qurilmalari ham) + o'quvchining vasiylari (faqat o'qish)
    const watchers = [t.teacherUserId, t.studentUserId, ...(await this.guardians.guardianIdsOf(t.studentUserId))];
    for (const u of new Set(watchers)) this.realtime.emitToUser(u, 'message', { ...this.messageViewFor(u, fresh, msg) });
    await this.notifications.enqueue(other, 'message.new', { threadId }, { dedupeKey: `msg:${threadId}:${Math.floor(this.clock.now().getTime() / 300_000)}` });
    return this.messageView(actor, fresh, role, msg);
  }

  /** Real vaqt payload'i: oluvchi uchun tayyorlangan ko'rinish (mine/state oluvchiga nisbatan) */
  private messageViewFor(userId: string, t: ChatThread, m: MessageFull) {
    return {
      id: m.id, threadId: m.threadId, seq: m.seq, mine: m.senderId === userId, from: m.senderId === t.teacherUserId ? 'TEACHER' : 'STUDENT',
      body: m.body, file: m.file ? this.files.publicView(m.file) : null, createdAt: m.createdAt, state: m.senderId === userId ? this.stateFor(t, m) : undefined,
    };
  }

  // ---------- yetkazildi / o'qildi ----------

  async markDelivered(actor: Actor, threadId: string, upToSeq: number) {
    return this.mark(actor, threadId, upToSeq, 'delivered');
  }

  async markRead(actor: Actor, threadId: string, upToSeq: number) {
    return this.mark(actor, threadId, upToSeq, 'read');
  }

  private async mark(actor: Actor, threadId: string, upToSeq: number, kind: 'delivered' | 'read') {
    const { t, role } = await this.mustSee(actor, threadId);
    if (role === 'GUARDIAN') throw new ForbiddenException('Guardians have read-only access');
    const seq = Math.min(Math.max(0, Math.trunc(upToSeq)), t.lastSeq);
    const isT = role === 'TEACHER';
    // faqat oldinga siljiydi (kamaytirib bo'lmaydi)
    const data =
      kind === 'read'
        ? isT ? { teacherLastReadSeq: Math.max(seq, t.teacherLastReadSeq), teacherDeliveredSeq: Math.max(seq, t.teacherDeliveredSeq) } : { studentLastReadSeq: Math.max(seq, t.studentLastReadSeq), studentDeliveredSeq: Math.max(seq, t.studentDeliveredSeq) }
        : isT ? { teacherDeliveredSeq: Math.max(seq, t.teacherDeliveredSeq) } : { studentDeliveredSeq: Math.max(seq, t.studentDeliveredSeq) };
    await this.prisma.chatThread.update({ where: { id: threadId }, data });
    const other = isT ? t.studentUserId : t.teacherUserId;
    this.realtime.emitToUser(other, 'receipt', { threadId, kind, upToSeq: seq });
    return { threadId, kind, upToSeq: seq };
  }
}
