import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ReportReason, Role, StoredFile } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { RealtimeService } from '../messaging/realtime.service';
import { detectContactInfo } from '../safety/contact-info';

export const CHANNEL_MAX_CHARS = 2000;
const MAX_PINS = 100;
const PAGE = 50;

/**
 * Sinf kanali: Telegram guruhi kabi — o'qituvchi va sinfga yozilgan o'quvchilar matn, rasm va fayl yozadi.
 * Ruxsat: sinf o'qituvchisi yoki faol a'zo; begona uchun "topilmadi" (404). O'quvchi o'z xabarini, o'qituvchi istalganini o'chiradi.
 */
@Injectable()
export class ClassChannelService {
  constructor(private prisma: PrismaService, private clock: ClockService, private realtime: RealtimeService) {}

  private async ctx(actor: Actor, classId: string) {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, select: { id: true, status: true, teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId === actor.id) return { classId, teacher: true, staff: false, teacherUserId: c.teacher.userId, status: c.status };
    const helper = await this.prisma.classHelper.findUnique({ where: { classId_userId: { classId, userId: actor.id } }, select: { canChat: true } });
    if (helper?.canChat) return { classId, teacher: false, staff: true, teacherUserId: c.teacher.userId, status: c.status }; // a helper answers and moderates
    if (actor.role === Role.STUDENT) {
      const e = await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } });
      if (e) return { classId, teacher: false, staff: false, teacherUserId: c.teacher.userId, status: c.status };
    }
    throw new NotFoundException('Class not found');
  }

  private async view(actor: Actor, teacherUserId: string, classId: string, rows: { id: string; seq: number; authorId: string; body: string; fileId: string | null; createdAt: Date; pinnedAt?: Date | null; replyToId?: string | null; hiddenAt?: Date | null }[]) {
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId))] } }, select: { id: true, name: true, username: true, dateOfBirth: true, avatarFileId: true } });
    const names = new Map(authors.map((a) => [a.id, a.name]));
    const info = new Map(authors.map((a) => [a.id, a]));
    const now = this.clock.now();
    const fileIds = rows.map((r) => r.fileId).filter((x): x is string => !!x);
    const files = fileIds.length ? await this.prisma.storedFile.findMany({ where: { id: { in: fileIds } } }) : [];
    const byId = new Map(files.map((f) => [f.id, f]));
    const reportRows = rows.length ? await this.prisma.report.findMany({ where: { targetType: 'CHANNEL_POST', targetId: { in: rows.map((r) => r.id) }, status: 'OPEN' }, select: { targetId: true, reporterId: true } }) : [];
    const helperRows = await this.prisma.classHelper.findMany({ where: { classId }, select: { userId: true, canChat: true } });
    const helperIds = new Set(helperRows.map((h) => h.userId));
    const teacherSeesAll = actor.id === teacherUserId || helperRows.some((h) => h.userId === actor.id && h.canChat); // helpers who moderate see hidden posts too
    const reportCount = new Map<string, number>();
    const reportedByMe = new Set<string>();
    for (const rp of reportRows) { reportCount.set(rp.targetId, (reportCount.get(rp.targetId) ?? 0) + 1); if (rp.reporterId === actor.id) reportedByMe.add(rp.targetId); }
    const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((x): x is string => !!x))];
    const replied = replyIds.length ? await this.prisma.classChannelPost.findMany({ where: { id: { in: replyIds } }, select: { id: true, body: true, authorId: true, fileId: true, deletedAt: true, hiddenAt: true } }) : [];
    const repliedAuthors = replied.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(replied.map((p) => p.authorId))] } }, select: { id: true, name: true } }) : [];
    const authorName = new Map(repliedAuthors.map((a) => [a.id, a.name]));
    const repliedBy = new Map(replied.map((p) => [p.id, p]));
    return rows.map((r) => {
      const item = (() => {
      const f: StoredFile | undefined = r.fileId ? byId.get(r.fileId) : undefined;
      const mime = f?.finalMime ?? f?.mime ?? '';
      return {
        id: r.id, seq: r.seq, at: r.createdAt, body: r.body, mine: r.authorId === actor.id, pinned: !!r.pinnedAt,
        replyTo: (() => {
          const o = r.replyToId ? repliedBy.get(r.replyToId) : undefined;
          if (!o) return null;
          return o.deletedAt || (o.hiddenAt && !teacherSeesAll) ? { id: o.id, deleted: true, body: '', author: null, hasFile: false } : { id: o.id, deleted: false, body: o.body.slice(0, 140), author: authorName.get(o.authorId) ?? null, hasFile: !!o.fileId };
        })(),
        // a minor's @username, photo and id are shown only to the class teacher (and to the minor); classmates see the name only
        author: (() => {
          const a = info.get(r.authorId);
          const minor = !a?.dateOfBirth || ageInYears(a.dateOfBirth, now) < ADULT_AGE;
          const show = !minor || r.authorId === teacherUserId || actor.id === teacherUserId || r.authorId === actor.id;
          return { id: show ? r.authorId : null, name: names.get(r.authorId) ?? null, teacher: r.authorId === teacherUserId, assistant: helperIds.has(r.authorId), username: show ? a?.username ?? null : null, hasPhoto: show && !!a?.avatarFileId };
        })(),
        file: f && !f.deletedAt ? { id: f.id, name: f.originalName, size: f.sizeBytes, mime, image: mime.startsWith('image/') } : null,
      };
      })();
      const mine = reportedByMe.has(r.id);
      const hide = !teacherSeesAll && !item.mine && (mine || !!r.hiddenAt);
      if (hide) return { ...item, body: '', file: null, replyTo: null, hidden: mine ? 'reported' : 'review', reports: 0 };
      return { ...item, hidden: null as 'reported' | 'review' | null, reports: teacherSeesAll ? reportCount.get(r.id) ?? 0 : 0 };
    });
  }

  async list(actor: Actor, classId: string, opts: { before?: number; after?: number }) {
    const c = await this.ctx(actor, classId);
    const where = { classId, deletedAt: null, ...(opts.before ? { seq: { lt: opts.before } } : {}), ...(opts.after ? { seq: { gt: opts.after } } : {}) };
    const rows = await this.prisma.classChannelPost.findMany({ where, orderBy: { seq: opts.after ? 'asc' : 'desc' }, take: PAGE });
    if (!opts.after) rows.reverse();
    const top = rows.length ? Math.max(...rows.map((x) => x.seq)) : 0;
    if (top) await this.prisma.classChannelRead.upsert({ where: { classId_userId: { classId, userId: actor.id } }, create: { classId, userId: actor.id, lastSeq: top }, update: { lastSeq: top } }).catch(() => undefined);
    return { items: await this.view(actor, c.teacherUserId, c.classId, rows), more: rows.length === PAGE };
  }

  /** Har bir sinf kanalidagi o'qilmagan xabarlar soni (o'zingiznikidan tashqari). */
  async unreadByClass(actor: Actor): Promise<Record<string, number>> {
    const teaching = actor.role === Role.TEACHER ? await this.prisma.class.findMany({ where: { teacher: { userId: actor.id }, status: 'ACTIVE' }, select: { id: true } }) : [];
    const joined = await this.prisma.classEnrollment.findMany({ where: { pupilId: actor.id, status: 'ACTIVE', class: { status: 'ACTIVE' } }, select: { classId: true } });
    const ids = [...new Set([...teaching.map((x) => x.id), ...joined.map((x) => x.classId)])];
    if (!ids.length) return {};
    const reads = await this.prisma.classChannelRead.findMany({ where: { userId: actor.id, classId: { in: ids } } });
    const last = new Map(reads.map((x) => [x.classId, x.lastSeq]));
    const out: Record<string, number> = {};
    for (const id of ids) {
      const n = await this.prisma.classChannelPost.count({ where: { classId: id, deletedAt: null, authorId: { not: actor.id }, seq: { gt: last.get(id) ?? 0 } } });
      if (n) out[id] = n;
    }
    return out;
  }

  async post(actor: Actor, classId: string, input: { body?: string; fileId?: string; replyToId?: string }) {
    const c = await this.ctx(actor, classId);
    if (c.status !== 'ACTIVE') throw new ConflictException({ message: 'This class is closed', code: 'CLASS_CLOSED' });
    const body = (input.body ?? '').trim();
    if (!body && !input.fileId) throw new BadRequestException('Empty message');
    if (body.length > CHANNEL_MAX_CHARS) throw new BadRequestException('Message too long');
    if (body && detectContactInfo(body).found) {
      const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupil: { select: { dateOfBirth: true } } } });
      const now = this.clock.now();
      if (pupils.some((p) => !p.pupil.dateOfBirth || ageInYears(p.pupil.dateOfBirth, now) < ADULT_AGE)) throw new BadRequestException({ message: "For safety, contact details can't be shared in a class with pupils under 18", code: 'CONTACT_INFO_NOT_ALLOWED' });
    }
    if (input.fileId) {
      const f = await this.prisma.storedFile.findFirst({ where: { id: input.fileId, ownerId: actor.id, deletedAt: null } });
      if (!f) throw new NotFoundException('File not found');
      if (f.purpose !== 'MESSAGE_ATTACHMENT') throw new BadRequestException('File has wrong purpose');
      if (f.status !== 'READY') throw new ConflictException('File is not ready');
      if (await this.prisma.classChannelPost.findUnique({ where: { fileId: f.id } })) throw new ConflictException('File already sent');
    }
    if (input.replyToId) {
      const target = await this.prisma.classChannelPost.findFirst({ where: { id: input.replyToId, classId, deletedAt: null }, select: { id: true } });
      if (!target) throw new NotFoundException('The message you reply to was not found');
    }
    const row = await this.prisma.classChannelPost.create({ data: { classId, authorId: actor.id, body, fileId: input.fileId ?? null, replyToId: input.replyToId ?? null, createdAt: this.clock.now() } });
    await this.prisma.classChannelRead.upsert({ where: { classId_userId: { classId, userId: actor.id } }, create: { classId, userId: actor.id, lastSeq: row.seq }, update: { lastSeq: row.seq } }).catch(() => undefined);
    const [item] = await this.view(actor, c.teacherUserId, c.classId, [row]);
    const members = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const u of [c.teacherUserId, ...members.map((m) => m.pupilId)]) if (u !== actor.id) this.realtime.emitToUser(u, 'class.channel', { classId, seq: row.seq });
    return item;
  }

  /** Mahkamlangan xabarlar (yangisi birinchi). Bir sinfda 100 tagacha: chegara ilovada ko'rsatilmaydi. */
  async pins(actor: Actor, classId: string) {
    const c = await this.ctx(actor, classId);
    const rows = await this.prisma.classChannelPost.findMany({ where: { classId, deletedAt: null, pinnedAt: { not: null } }, orderBy: { pinnedAt: 'desc' }, take: MAX_PINS });
    return { items: await this.view(actor, c.teacherUserId, c.classId, rows) };
  }

  async pin(actor: Actor, classId: string, postId: string, on: boolean) {
    const c = await this.ctx(actor, classId);
    if (!c.teacher && !c.staff) throw new ForbiddenException('Only the teacher or a helper can pin messages');
    const p = await this.prisma.classChannelPost.findFirst({ where: { id: postId, classId, deletedAt: null } });
    if (!p) throw new NotFoundException('Message not found');
    if (on && !p.pinnedAt) {
      const n = await this.prisma.classChannelPost.count({ where: { classId, deletedAt: null, pinnedAt: { not: null } } });
      if (n >= MAX_PINS) throw new ConflictException({ message: 'Unpin an older message first', code: 'PIN_LIMIT' });
    }
    await this.prisma.classChannelPost.update({ where: { id: p.id }, data: { pinnedAt: on ? this.clock.now() : null } });
    const members = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const u of members) this.realtime.emitToUser(u.pupilId, 'class.channel', { classId, seq: p.seq, pin: true });
    return { ok: true, pinned: on };
  }

  /** Kanal haqida: nom, o'qituvchi (logo = uning rasmi), tavsif, darslar, fayllar, himoya holati. */
  async info(actor: Actor, classId: string) {
    const c = await this.ctx(actor, classId);
    const cls = await this.prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { id: true, title: true, subject: true, description: true, priceMinor: true, capacity: true, enrolledCount: true, protectContent: true, theme: true, logoFileId: true, startDate: true, endDate: true, weekdays: true, startMinute: true, durationMin: true, timezone: true, createdAt: true, teacher: { select: { userId: true, headline: true, subjects: true, user: { select: { name: true, username: true, bio: true, avatarFileId: true } } } } },
    });
    const now = this.clock.now();
    const [upcoming, files, pins] = await Promise.all([
      this.prisma.classSession.findMany({ where: { classId, startAt: { gte: now }, status: { notIn: ['CANCELLED'] } }, orderBy: { startAt: 'asc' }, take: 5, select: { id: true, startAt: true, endAt: true, status: true } }),
      this.prisma.classFile.count({ where: { classId, deletedAt: null, takedownAt: null } }),
      this.prisma.classChannelPost.count({ where: { classId, deletedAt: null, pinnedAt: { not: null } } }),
    ]);
    const t = cls.teacher;
    return {
      id: cls.id, title: cls.title, subject: cls.subject, description: cls.description, priceMinor: cls.priceMinor, members: cls.enrolledCount + 1, createdAt: cls.createdAt,
      protectContent: cls.protectContent, theme: cls.theme, hasLogo: !!cls.logoFileId, role: c.teacher ? 'teacher' : c.staff ? 'assistant' : 'pupil', startDate: cls.startDate, endDate: cls.endDate, weekdays: cls.weekdays, startMinute: cls.startMinute, durationMin: cls.durationMin, timezone: cls.timezone,
      teacher: { id: t.userId, name: t.user.name, username: t.user.username, bio: t.user.bio ?? t.headline ?? null, subjects: t.subjects, hasPhoto: !!t.user.avatarFileId },
      upcoming, filesCount: files, pinsCount: pins,
    };
  }

  /** Xabar yoki rasm ustidan shikoyat (spam, nomaqbul kontent...). Shikoyat qilgan odamga xabar darrov yashiriladi; 3 ta turli odam shikoyat qilsa hamma uchun vaqtincha yashiriladi. */
  async report(actor: Actor, classId: string, postId: string, input: { reason: ReportReason; note?: string }) {
    const c = await this.ctx(actor, classId);
    const p = await this.prisma.classChannelPost.findFirst({ where: { id: postId, classId, deletedAt: null } });
    if (!p) throw new NotFoundException('Message not found');
    if (p.authorId === actor.id) throw new ForbiddenException('You cannot report your own message');
    try {
      await this.prisma.report.create({
        data: {
          reporterId: actor.id, targetType: 'CHANNEL_POST', targetId: p.id, reason: input.reason, note: (input.note ?? '').trim().slice(0, 500),
          snapshot: { classId, authorId: p.authorId, body: p.body.slice(0, 1000), hasFile: !!p.fileId, fileId: p.fileId, at: p.createdAt } as any,
        },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // allaqachon shikoyat qilgan: jim muvaffaqiyat
    }
    const distinct = await this.prisma.report.count({ where: { targetType: 'CHANNEL_POST', targetId: p.id, status: 'OPEN' } });
    if (distinct >= 3 && !p.hiddenAt) await this.prisma.classChannelPost.update({ where: { id: p.id }, data: { hiddenAt: this.clock.now() } });
    if (!c.teacher) this.realtime.emitToUser(c.teacherUserId, 'class.channel', { classId, seq: p.seq, report: true });
    return { ok: true, hiddenForYou: true };
  }

  /** O'qituvchi: "xabar yaxshi" — shikoyatlarni yopadi va yashirishni olib tashlaydi. */
  async clearReports(actor: Actor, classId: string, postId: string) {
    const c = await this.ctx(actor, classId);
    if (!c.teacher && !c.staff) throw new ForbiddenException('Only the teacher or a helper can do this');
    const p = await this.prisma.classChannelPost.findFirst({ where: { id: postId, classId } });
    if (!p) throw new NotFoundException('Message not found');
    await this.prisma.report.updateMany({ where: { targetType: 'CHANNEL_POST', targetId: p.id, status: 'OPEN' }, data: { status: 'DISMISSED', resolvedAt: this.clock.now(), resolutionNote: 'teacher: message is fine' } });
    await this.prisma.classChannelPost.update({ where: { id: p.id }, data: { hiddenAt: null } });
    return { ok: true };
  }

  /** Kanal a'zolari (o'qituvchi + faol o'quvchilar). 18 yoshgacha bo'lganlarning id/@nom/rasmi faqat o'qituvchiga va o'ziga ko'rinadi. */
  async members(actor: Actor, classId: string) {
    const c = await this.ctx(actor, classId);
    const now = this.clock.now();
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, take: 1000, select: { pupil: { select: { id: true, name: true, username: true, dateOfBirth: true, avatarFileId: true } } } });
    const teacher = await this.prisma.user.findUniqueOrThrow({ where: { id: c.teacherUserId }, select: { id: true, name: true, username: true, avatarFileId: true } });
    const mapPupil = (u: { id: string; name: string | null; username: string | null; dateOfBirth: Date | null; avatarFileId: string | null }) => {
      const minor = !u.dateOfBirth || ageInYears(u.dateOfBirth, now) < ADULT_AGE;
      const show = !minor || c.teacher || u.id === actor.id;
      return { id: show ? u.id : null, name: u.name, username: show ? u.username : null, hasPhoto: show && !!u.avatarFileId, teacher: false, me: u.id === actor.id };
    };
    return { items: [{ id: teacher.id, name: teacher.name, username: teacher.username, hasPhoto: !!teacher.avatarFileId, teacher: true, me: teacher.id === actor.id }, ...rows.map((r) => mapPupil(r.pupil))] };
  }

  /** Kanal logosini o'rnatish (faqat o'qituvchi; rasm AVATAR maqsadida yuklangan bo'lishi kerak). */
  async setLogo(actor: Actor, classId: string, fileId: string) {
    const c = await this.ctx(actor, classId);
    if (!c.teacher) throw new ForbiddenException('Only the teacher can change the logo');
    const f = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: actor.id, deletedAt: null } });
    if (!f) throw new NotFoundException('File not found');
    if (f.purpose !== 'AVATAR') throw new BadRequestException('File has wrong purpose');
    if (f.status !== 'READY' || !f.thumbKey) throw new ConflictException('File is not a ready image');
    await this.prisma.class.update({ where: { id: classId }, data: { logoFileId: f.id } });
    return { hasLogo: true };
  }

  async logoFile(actor: Actor, classId: string) {
    await this.ctx(actor, classId);
    const cls = await this.prisma.class.findUnique({ where: { id: classId }, select: { logoFileId: true } });
    if (!cls?.logoFileId) throw new NotFoundException('No logo');
    const f = await this.prisma.storedFile.findFirst({ where: { id: cls.logoFileId, deletedAt: null, status: 'READY' } });
    if (!f?.thumbKey) throw new NotFoundException('No logo');
    return f;
  }

  async remove(actor: Actor, classId: string, postId: string) {
    const c = await this.ctx(actor, classId);
    const p = await this.prisma.classChannelPost.findFirst({ where: { id: postId, classId, deletedAt: null } });
    if (!p) throw new NotFoundException('Message not found');
    if (!c.teacher && !c.staff && p.authorId !== actor.id) throw new ForbiddenException('Forbidden');
    await this.prisma.classChannelPost.update({ where: { id: p.id }, data: { deletedAt: this.clock.now() } });
    return { ok: true };
  }
}
