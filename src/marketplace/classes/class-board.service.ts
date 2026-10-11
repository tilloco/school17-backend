import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { OBJECT_STORAGE, ObjectStorage } from '../files/storage';
import { GuardianService } from '../guardian/guardian.service';
import { RealtimeService } from '../messaging/realtime.service';
import { ClassRoomService } from './class-room.service';
import { Stroke, validateStrokes } from './class-files.service';

// Doska chegaralari (so'rov tanasi ~100 KB dan oshmasligi uchun): 800 chiziq, jami 5000 nuqta
export const BOARD_LIMITS = { strokes: 800, perStroke: 1000, total: 5000 };
const BOARD_W = 1280;
const BOARD_H = 720;
const MAX_PNG_BYTES = 3 * 1024 * 1024;

@Injectable()
export class ClassBoardService {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private realtime: RealtimeService,
    private room: ClassRoomService,
    private guardians: GuardianService,
    @Inject(OBJECT_STORAGE) private storage: ObjectStorage,
  ) {}

  private async session(actor: Actor, sessionId: string, teacherOnly: boolean) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s) throw new NotFoundException('Session not found');
    const isTeacher = s.class.teacher.userId === actor.id;
    if (!isTeacher) {
      const seats = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : actor.role === Role.STUDENT ? [actor.id] : [];
      const e = seats.length && !teacherOnly ? await this.prisma.classEnrollment.findFirst({ where: { classId: s.classId, pupilId: { in: seats }, status: 'ACTIVE' }, select: { id: true } }) : null;
      if (!e) throw new NotFoundException('Session not found');
    }
    return { s: await this.room.refresh(s), isTeacher, teacherUserId: s.class.teacher.userId };
  }
  private async push(sessionId: string, classId: string, teacherUserId: string, payload: object) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    for (const u of [teacherUserId, ...rows.map((r) => r.pupilId)]) this.realtime.emitToUser(u, 'class:whiteboard', { sessionId, ...payload });
  }

  async get(actor: Actor, sessionId: string) {
    const { s } = await this.session(actor, sessionId, false);
    const b = await this.prisma.classWhiteboard.findUnique({ where: { sessionId } });
    return { rev: s.whiteboardRev, strokes: ((b?.data as any)?.strokes ?? []) as Stroke[], updatedAt: b?.updatedAt ?? null };
  }

  /** Faqat o'qituvchi, sessiya ochiq (kutish xonasi yoki jonli) bo'lganda. rev server tomonidan oshiriladi. */
  async put(actor: Actor, sessionId: string, strokesIn: unknown) {
    const { s, teacherUserId } = await this.session(actor, sessionId, true);
    if (s.status !== 'LIVE' && s.status !== 'LOBBY') throw new ConflictException({ message: 'The class is not open', code: 'NOT_OPEN' });
    const strokes = validateStrokes(strokesIn, BOARD_LIMITS);
    const now = this.clock.now();
    await this.prisma.classWhiteboard.upsert({ where: { sessionId }, update: { data: { strokes } as any, updatedAt: now, rev: { increment: 1 } }, create: { sessionId, data: { strokes } as any, updatedAt: now, rev: 1 } });
    const up = await this.prisma.classSession.update({ where: { id: sessionId }, data: { whiteboardRev: { increment: 1 } } });
    await this.push(sessionId, s.classId, teacherUserId, { rev: up.whiteboardRev });
    return { rev: up.whiteboardRev, strokes: strokes.length };
  }

  /** Saqlangan chiziqlardan serverda PNG chizadi va sinf lentasiga qo'yadi (mijozdan fayl qabul qilinmaydi: tur va hajm server tomonidan aniq). */
  async save(actor: Actor, sessionId: string, clear: boolean) {
    const { s, teacherUserId } = await this.session(actor, sessionId, true);
    const b = await this.prisma.classWhiteboard.findUnique({ where: { sessionId } });
    const strokes = ((b?.data as any)?.strokes ?? []) as Stroke[];
    if (!strokes.length) throw new BadRequestException({ message: 'The board is empty', code: 'BOARD_EMPTY' });
    const png = await renderBoardPng(strokes);
    if (png.length > MAX_PNG_BYTES || png.subarray(1, 4).toString('latin1') !== 'PNG') throw new BadRequestException('Bad image');
    const post = await this.prisma.classFeedPost.create({ data: { classId: s.classId, sessionId, kind: 'WHITEBOARD', authorId: actor.id, createdAt: this.clock.now() } });
    const key = `classfeed/${post.id}.png`;
    await this.storage.put(key, png);
    await this.prisma.classFeedPost.update({ where: { id: post.id }, data: { imageKey: key } });
    if (clear && (s.status === 'LIVE' || s.status === 'LOBBY')) await this.put(actor, sessionId, []);
    await this.audit.log(actor, { action: 'class.board.save', targetType: 'ClassFeedPost', targetId: post.id });
    await this.push(sessionId, s.classId, teacherUserId, { feed: true });
    return { id: post.id, bytes: png.length };
  }

  // ---------- lenta (R8 kengaytiradi) ----------
  private async member(actor: Actor, classId: string) {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, include: { teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId === actor.id) return;
    const seats = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : actor.role === Role.STUDENT ? [actor.id] : [];
    const e = seats.length ? await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId: { in: seats }, status: 'ACTIVE' }, select: { id: true } }) : null;
    if (!e) throw new NotFoundException('Class not found');
  }
  async feed(actor: Actor, classId: string, before?: string) {
    await this.member(actor, classId);
    const b = before ? new Date(before) : null;
    const rows = await this.prisma.classFeedPost.findMany({ where: { classId, ...(b && !isNaN(b.getTime()) ? { createdAt: { lt: b } } : {}) }, orderBy: { createdAt: 'desc' }, take: 30 });
    return rows.map((r) => ({ id: r.id, kind: r.kind, sessionId: r.sessionId, text: r.text, hasImage: !!r.imageKey, at: r.createdAt }));
  }
  async feedImage(actor: Actor, classId: string, postId: string): Promise<Buffer> {
    await this.member(actor, classId);
    const p = await this.prisma.classFeedPost.findFirst({ where: { id: postId, classId, imageKey: { not: null } } });
    if (!p?.imageKey) throw new NotFoundException('Not found');
    try {
      return await this.storage.get(p.imageKey);
    } catch {
      throw new NotFoundException('Not found');
    }
  }
}

/** Chiziqlarni oq fonli 1280x720 PNG ga chizadi (koordinatalar 0..1) */
export async function renderBoardPng(strokes: Stroke[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(BOARD_W, BOARD_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of strokes) {
    ctx.strokeStyle = st.c;
    ctx.lineWidth = st.w;
    ctx.beginPath();
    st.p.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * BOARD_W, y * BOARD_H) : ctx.lineTo(x * BOARD_W, y * BOARD_H)));
    if (st.p.length === 1) ctx.lineTo(st.p[0][0] * BOARD_W + 0.01, st.p[0][1] * BOARD_H);
    ctx.stroke();
  }
  return canvas.toBuffer('image/png');
}
