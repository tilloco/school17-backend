import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ClassFile, ReportReason, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { FilesService } from '../files/files.service';
import { PDF_RENDERER, PdfRenderer, RenderError } from '../files/pdf-renderer';
import { OBJECT_STORAGE, ObjectStorage } from '../files/storage';
import { GuardianService } from '../guardian/guardian.service';
import { RealtimeService } from '../messaging/realtime.service';

const MAX_RENDER_ATTEMPTS = 3;
const MAX_STROKES = 200;
const MAX_POINTS_PER_STROKE = 500;
const MAX_POINTS_TOTAL = 5000;
export type PageSize = 'full' | 'small' | 'thumb';
const KEY_PREFIX: Record<PageSize, string> = { full: 'p', small: 's', thumb: 't' };
const pageKey = (cfId: string, size: PageSize, n: number) => `classfiles/${cfId}/${KEY_PREFIX[size]}${n}.webp`;

export interface Stroke { c: string; w: number; p: [number, number][] }

/** Annotatsiya (vektor) tekshiruvi: rang, qalinlik, koordinatalar 0..1, hajm chegaralari */
export function validateStrokes(input: unknown, lim = { strokes: MAX_STROKES, perStroke: MAX_POINTS_PER_STROKE, total: MAX_POINTS_TOTAL }): Stroke[] {
  if (!Array.isArray(input) || input.length > lim.strokes) throw new BadRequestException(`At most ${lim.strokes} strokes`);
  let total = 0;
  return input.map((s: any) => {
    if (!s || typeof s !== 'object' || typeof s.c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.c)) throw new BadRequestException('Bad stroke colour');
    if (typeof s.w !== 'number' || !(s.w >= 0.5 && s.w <= 20)) throw new BadRequestException('Bad stroke width');
    if (!Array.isArray(s.p) || s.p.length < 1 || s.p.length > lim.perStroke) throw new BadRequestException('Bad stroke points');
    total += s.p.length;
    if (total > lim.total) throw new BadRequestException('Too many points');
    const p = s.p.map((pt: any) => {
      if (!Array.isArray(pt) || pt.length !== 2 || !pt.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new BadRequestException('Bad point');
      return [Math.round(pt[0] * 10000) / 10000, Math.round(pt[1] * 10000) / 10000] as [number, number];
    });
    return { c: s.c.toLowerCase(), w: s.w, p };
  });
}

@Injectable()
export class ClassFilesService implements OnModuleInit {
  private readonly log = new Logger('ClassFiles');
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private files: FilesService,
    private guardians: GuardianService,
    private realtime: RealtimeService,
    @Inject(OBJECT_STORAGE) private storage: ObjectStorage,
    @Inject(PDF_RENDERER) private renderer: PdfRenderer,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // Qayta ishga tushganda tugallanmagan renderlar davom ettiriladi. R12: navbatga o'tkaziladi.
    void this.prisma.classFile.findMany({ where: { renderStatus: 'PREPARING', deletedAt: null, renderAttempts: { lt: MAX_RENDER_ATTEMPTS } }, select: { id: true }, take: 100 })
      .then((rows) => rows.forEach((r) => this.kick(r.id))).catch(() => undefined);
  }

  // ---------- ruxsat ----------
  private async teacherOf(actor: Actor, classId: string) {
    const c = await this.prisma.class.findFirst({ where: { id: classId, teacher: { userId: actor.id } } });
    if (!c) throw new NotFoundException('Class not found');
    return c;
  }
  private async memberOf(actor: Actor, classId: string): Promise<{ teacher: boolean }> {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, include: { teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId === actor.id) return { teacher: true };
    const seats = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : actor.role === Role.STUDENT ? [actor.id] : [];
    const e = seats.length ? await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId: { in: seats }, status: 'ACTIVE' }, select: { id: true } }) : null;
    if (!e) throw new NotFoundException('Class not found');
    return { teacher: false };
  }
  private async fileIn(classId: string, id: string, opts: { allowTakedown?: boolean } = {}) {
    const f = await this.prisma.classFile.findFirst({ where: { id, classId, deletedAt: null, ...(opts.allowTakedown ? {} : { takedownAt: null }) } });
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  private view(f: ClassFile, sizeBytes?: number) {
    return { id: f.id, name: f.name, pageCount: f.pageCount, renderedPages: f.renderedPages, renderStatus: f.renderStatus, renderError: f.renderError, allowDownload: f.allowDownload, sizeBytes: sizeBytes ?? null, createdAt: f.createdAt, fileId: f.fileId };
  }

  // ---------- kutubxona ----------
  async add(actor: Actor, classId: string, fileId: string, allowDownload?: boolean) {
    const c = await this.teacherOf(actor, classId);
    const sf = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: actor.id, purpose: 'CLASS_FILE', status: 'READY', deletedAt: null } });
    if (!sf || sf.finalMime !== 'application/pdf') throw new NotFoundException('File not found');
    try {
      const f = await this.prisma.classFile.create({ data: { classId, fileId, uploaderId: actor.id, name: sf.originalName, allowDownload: allowDownload ?? c.allowDownload } });
      await this.audit.log(actor, { action: 'class.file.add', targetType: 'ClassFile', targetId: f.id });
      this.kick(f.id);
      return this.view(f, sf.sizeBytes);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'File already added', code: 'ALREADY_ADDED' });
      throw e;
    }
  }

  async list(actor: Actor, classId: string, q?: string) {
    await this.memberOf(actor, classId);
    const term = q?.trim().slice(0, 100);
    const rows = await this.prisma.classFile.findMany({ where: { classId, deletedAt: null, takedownAt: null, ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const sizes = new Map((await this.prisma.storedFile.findMany({ where: { id: { in: rows.map((r) => r.fileId) } }, select: { id: true, sizeBytes: true } })).map((s) => [s.id, s.sizeBytes]));
    return rows.map((r) => this.view(r, sizes.get(r.fileId)));
  }

  async setDownload(actor: Actor, classId: string, id: string, allowDownload: boolean) {
    await this.teacherOf(actor, classId);
    const f = await this.fileIn(classId, id);
    const u = await this.prisma.classFile.update({ where: { id: f.id }, data: { allowDownload } });
    return this.view(u);
  }

  async remove(actor: Actor, classId: string, id: string) {
    await this.teacherOf(actor, classId);
    const f = await this.fileIn(classId, id, { allowTakedown: true });
    await this.prisma.classFile.update({ where: { id: f.id }, data: { deletedAt: this.clock.now() } });
    await this.prisma.classSession.updateMany({ where: { presentFileId: f.id }, data: { presentFileId: null, presentPage: 1 } });
    await this.storage.deletePrefix(`classfiles/${f.id}`);
    await this.files.remove(actor, f.fileId).catch(() => undefined);
    await this.audit.log(actor, { action: 'class.file.delete', targetType: 'ClassFile', targetId: f.id });
    return { ok: true };
  }

  async downloadUrl(actor: Actor, classId: string, id: string) {
    const { teacher } = await this.memberOf(actor, classId);
    const f = await this.fileIn(classId, id);
    if (!teacher && !f.allowDownload) throw new ForbiddenException({ message: 'The teacher did not allow downloads', code: 'DOWNLOAD_OFF' });
    return this.files.downloadUrl(actor, f.fileId, 'original');
  }

  // ---------- sahifa rasmlari ----------
  async page(actor: Actor, classId: string, id: string, n: number, size: PageSize) {
    await this.memberOf(actor, classId);
    const f = await this.fileIn(classId, id);
    if (!Number.isInteger(n) || n < 1 || n > f.renderedPages) throw new NotFoundException('Page not ready');
    try {
      return await this.storage.get(pageKey(f.id, size, n));
    } catch {
      throw new NotFoundException('Page not ready');
    }
  }

  // ---------- annotatsiyalar ----------
  async getAnnotations(actor: Actor, classId: string, id: string, n: number) {
    await this.memberOf(actor, classId);
    const f = await this.fileIn(classId, id);
    const a = await this.prisma.classAnnotation.findUnique({ where: { classFileId_page: { classFileId: f.id, page: n } } });
    return { strokes: ((a?.data as any)?.strokes ?? []) as Stroke[] };
  }
  async putAnnotations(actor: Actor, classId: string, id: string, n: number, strokes: unknown) {
    await this.teacherOf(actor, classId);
    const f = await this.fileIn(classId, id);
    if (!Number.isInteger(n) || n < 1 || (f.pageCount && n > f.pageCount)) throw new BadRequestException('Bad page');
    const clean = validateStrokes(strokes);
    await this.prisma.classAnnotation.upsert({
      where: { classFileId_page: { classFileId: f.id, page: n } },
      update: { data: { strokes: clean } as any, updatedAt: this.clock.now() },
      create: { classFileId: f.id, page: n, data: { strokes: clean } as any, updatedAt: this.clock.now() },
    });
    return { strokes: clean };
  }

  // ---------- shikoyat ----------
  async report(actor: Actor, classId: string, id: string, reason: ReportReason, note?: string) {
    const { teacher } = await this.memberOf(actor, classId);
    if (teacher) throw new ForbiddenException('You cannot report your own file');
    const f = await this.fileIn(classId, id);
    try {
      const r = await this.prisma.report.create({
        data: { reporterId: actor.id, targetType: 'CLASS_FILE', targetId: f.id, reason, note: (note ?? '').trim().slice(0, 1000), snapshot: { classId, name: f.name, uploaderId: f.uploaderId } as any },
      });
      await this.audit.log(actor, { action: 'report.create', targetType: 'CLASS_FILE', targetId: f.id, metadata: { reason } });
      return { id: r.id, status: r.status };
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already reported this', code: 'ALREADY_REPORTED' });
      throw e;
    }
  }

  // ---------- taqdimot (sessiya holati) ----------
  private async liveSession(actor: Actor, sessionId: string) {
    const s = await this.prisma.classSession.findUnique({ where: { id: sessionId }, include: { class: { include: { teacher: { select: { userId: true } } } } } });
    if (!s || s.class.teacher.userId !== actor.id) throw new NotFoundException('Session not found');
    if (s.status !== 'LIVE') throw new ConflictException({ message: 'The class is not live', code: 'NOT_LIVE' });
    return s;
  }
  private async audience(classId: string, teacherUserId: string) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    return [teacherUserId, ...rows.map((r) => r.pupilId)];
  }

  async present(actor: Actor, sessionId: string, fileId: string | null, page: number) {
    const s = await this.liveSession(actor, sessionId);
    if (fileId) {
      const f = await this.fileIn(s.classId, fileId);
      if (f.renderStatus === 'FAILED') throw new ConflictException({ message: 'This file could not be prepared', code: 'RENDER_FAILED' });
      if (!Number.isInteger(page) || page < 1 || page > Math.max(f.renderedPages, 1) || (f.renderedPages === 0)) throw new ConflictException({ message: 'That page is not ready yet', code: 'PAGE_NOT_READY' });
    }
    await this.prisma.classSession.update({ where: { id: sessionId }, data: { presentFileId: fileId, presentPage: fileId ? page : 1, ...(fileId && !s.presentedFileIds.includes(fileId) ? { presentedFileIds: { push: fileId } } : {}) } });
    for (const u of await this.audience(s.classId, s.class.teacher.userId)) this.realtime.emitToUser(u, 'class:present', { sessionId, fileId, page: fileId ? page : null });
    return { fileId, page: fileId ? page : null };
  }

  /** Sessiya holati uchun: hozir ko'rsatilayotgan fayl */
  async presentationFor(s: { presentFileId: string | null; presentPage: number }) {
    if (!s.presentFileId) return null;
    const f = await this.prisma.classFile.findFirst({ where: { id: s.presentFileId, deletedAt: null, takedownAt: null } });
    if (!f) return null;
    return { fileId: f.id, name: f.name, page: s.presentPage, pageCount: f.pageCount, renderedPages: f.renderedPages, renderStatus: f.renderStatus };
  }

  // ---------- render ishchisi ----------
  /** Navbatga qo'yadi (bir nusxada ketma-ket). Testlarda drain() kutiladi. */
  kick(classFileId: string) {
    this.chain = this.chain.then(() => this.renderFile(classFileId)).catch((e) => this.log.error(`render ${classFileId}: ${e.message}`));
  }
  /** Navbat bo'shaguncha kutadi (qayta urinishlar ham kiradi) */
  async drain() {
    let c: Promise<unknown>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  async renderFile(id: string): Promise<void> {
    const cfg = marketConfig();
    const claim = await this.prisma.classFile.updateMany({ where: { id, renderStatus: 'PREPARING', deletedAt: null, renderAttempts: { lt: MAX_RENDER_ATTEMPTS } }, data: { renderAttempts: { increment: 1 } } });
    if (!claim.count) return;
    const f = await this.prisma.classFile.findUniqueOrThrow({ where: { id } });
    const sf = await this.prisma.storedFile.findUnique({ where: { id: f.fileId } });
    if (!sf || sf.status !== 'READY') return this.fail(f.id, 'file_missing');
    let pdf: Buffer;
    try {
      pdf = await this.storage.get(`${sf.storageKey}/blob`);
    } catch {
      return this.fail(f.id, 'file_missing');
    }
    try {
      await this.renderer.render(
        pdf,
        { maxPages: cfg.pdfMaxPages, fullWidth: cfg.pdfFullWidth, smallWidth: cfg.pdfSmallWidth, thumbWidth: cfg.pdfThumbWidth, deadlineMs: Date.now() + cfg.pdfRenderTimeoutSec * 1000 },
        async (p) => {
          await this.storage.put(pageKey(f.id, 'full', p.page), p.full);
          await this.storage.put(pageKey(f.id, 'small', p.page), p.small);
          await this.storage.put(pageKey(f.id, 'thumb', p.page), p.thumb);
          await this.prisma.classFile.update({ where: { id: f.id }, data: { renderedPages: p.page } }); // progressiv: sahifa tayyor bo'lishi bilan ko'rinadi
        },
        async (n) => {
          await this.prisma.classFile.update({ where: { id: f.id }, data: { pageCount: n } });
        },
      );
      await this.prisma.classFile.update({ where: { id: f.id }, data: { renderStatus: 'READY', renderError: null } });
    } catch (e) {
      const code = e instanceof RenderError ? e.code : 'render_failed';
      this.log.warn(`render ${f.id} failed: ${code}`);
      await this.storage.deletePrefix(`classfiles/${f.id}`).catch(() => undefined);
      await this.prisma.classFile.update({ where: { id: f.id }, data: { renderedPages: 0 } });
      // vaqtinchalik xato bo'lsa qayta uriniladi; aniq rad etilganlar (sahifa ko'p, parol) darhol FAILED
      if (code === 'too_many_pages' || code === 'encrypted') return this.fail(f.id, code);
      const fresh = await this.prisma.classFile.findUniqueOrThrow({ where: { id: f.id } });
      if (fresh.renderAttempts >= MAX_RENDER_ATTEMPTS) return this.fail(f.id, code);
      this.kick(f.id);
    }
  }
  private async fail(id: string, code: string) {
    await this.prisma.classFile.update({ where: { id }, data: { renderStatus: 'FAILED', renderError: code } });
  }

  // ---------- admin ----------
  async takedown(admin: Actor, id: string, reason?: string) {
    const f = await this.prisma.classFile.findFirst({ where: { id, deletedAt: null } });
    if (!f) throw new NotFoundException('File not found');
    await this.prisma.classFile.update({ where: { id }, data: { takedownAt: this.clock.now() } });
    await this.prisma.classSession.updateMany({ where: { presentFileId: id }, data: { presentFileId: null, presentPage: 1 } });
    await this.audit.log(admin, { action: 'class.file.takedown', targetType: 'ClassFile', targetId: id, metadata: { reason: (reason ?? '').slice(0, 300) } });
    return { ok: true };
  }
  async restore(admin: Actor, id: string) {
    const r = await this.prisma.classFile.updateMany({ where: { id, deletedAt: null, takedownAt: { not: null } }, data: { takedownAt: null } });
    if (!r.count) throw new NotFoundException('File not found');
    await this.audit.log(admin, { action: 'class.file.restore', targetType: 'ClassFile', targetId: id });
    return { ok: true };
  }
  async storage_(): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number; minFreeBytes: number; classFilesBytes: number } | { unavailable: true }> {
    const d = await this.storage.diskStats?.();
    if (!d) return { unavailable: true };
    const agg = await this.prisma.storedFile.aggregate({ _sum: { sizeBytes: true }, where: { purpose: 'CLASS_FILE', status: 'READY', deletedAt: null } });
    return { totalBytes: d.totalBytes, freeBytes: d.freeBytes, usedBytes: d.totalBytes - d.freeBytes, minFreeBytes: marketConfig().diskMinFreeBytes, classFilesBytes: agg._sum.sizeBytes ?? 0 };
  }
  async setTeacherQuota(admin: Actor, teacherProfileId: string, mb: number | null) {
    if (mb !== null && (!Number.isInteger(mb) || mb < 0 || mb > 10_000_000)) throw new BadRequestException('Bad quota');
    const r = await this.prisma.teacherProfile.updateMany({ where: { id: teacherProfileId }, data: { storageQuotaMb: mb } });
    if (!r.count) throw new NotFoundException('Teacher not found');
    await this.audit.log(admin, { action: 'teacher.storage_quota', targetType: 'TeacherProfile', targetId: teacherProfileId, metadata: { mb } });
    return { ok: true, storageQuotaMb: mb };
  }
}
