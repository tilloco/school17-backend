import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoredFile, StoredFilePurpose } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { GuardianService } from '../guardian/guardian.service';
import { ProcessingError, processImage } from './processors';
import { createScanProvider, ScanProvider, SCAN_PROVIDER } from './scanner';
import { sign, SignedParams, signedQuery, verifySignature } from './signing';
import { checkPdf, detectType, DetectedType, MIME_BY_TYPE } from './sniff';
import { OBJECT_STORAGE, ObjectStorage } from './storage';

const ALLOWED_DECLARED_MIME: Record<string, DetectedType> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const PURPOSES_FOR_USERS: StoredFilePurpose[] = ['CREDENTIAL', 'MESSAGE_ATTACHMENT', 'AVATAR', 'PAYMENT_PROOF', 'CLASS_FILE', 'HOMEWORK'];

/** Ixtiyoriy turdagi fayl uchun e'lon qilingan MIME: faqat oddiy "tur/qism" ko'rinishi, aks holda ikkilik oqim. */
const safeMime = (m: string) => (/^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,100}$/i.test(m) ? m.toLowerCase() : 'application/octet-stream');

const newKey = () => `f_${randomBytes(16).toString('hex')}`;

@Injectable()
export class FilesService {
  private readonly log = new Logger('Files');

  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private guardians: GuardianService,
    private config: ConfigService,
    @Inject(OBJECT_STORAGE) private storage: ObjectStorage,
    @Inject(SCAN_PROVIDER) private scanner: ScanProvider,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('FILE_URL_SECRET') || this.config.get<string>('JWT_SECRET');
    if (!s) throw new Error('FILE_URL_SECRET (or JWT_SECRET) must be set');
    return s;
  }

  // ---------- yuklash ----------

  async init(actor: Actor, input: { purpose: StoredFilePurpose; name: string; size: number; mime: string }) {
    const cfg = marketConfig();
    if (!PURPOSES_FOR_USERS.includes(input.purpose)) throw new BadRequestException('Bad purpose');
    if (input.purpose === 'CREDENTIAL' && actor.role !== 'TEACHER') throw new ForbiddenException('Forbidden');
    const known = ALLOWED_DECLARED_MIME[input.mime];
    // Ixtiyoriy tur (video, arxiv, html, ...) — faqat o'qituvchi sinf materiali, xabar ilovasi va uy vazifasi uchun
    const anyKind = !known && (input.purpose === 'CLASS_FILE' || input.purpose === 'MESSAGE_ATTACHMENT' || input.purpose === 'HOMEWORK');
    const type = known;
    if (!known && !anyKind) throw new BadRequestException({ message: 'File type not allowed', code: 'TYPE_NOT_ALLOWED' });
    if (known && (input.purpose === 'AVATAR' || input.purpose === 'PAYMENT_PROOF') && type === 'pdf') throw new BadRequestException({ message: 'File type not allowed', code: 'TYPE_NOT_ALLOWED' });
    if (input.purpose === 'HOMEWORK' && actor.role !== 'STUDENT' && actor.role !== 'GUARDIAN') throw new ForbiddenException('Forbidden');
    if (input.purpose === 'CLASS_FILE' && actor.role !== 'TEACHER') throw new BadRequestException({ message: 'File type not allowed', code: 'TYPE_NOT_ALLOWED' });
    if (input.purpose === 'CLASS_FILE' && known && type !== 'pdf') throw new BadRequestException({ message: 'File type not allowed', code: 'TYPE_NOT_ALLOWED' });
    const limit = anyKind ? cfg.fileMaxAnyBytes : input.purpose === 'CLASS_FILE' ? cfg.classFileMaxBytes : input.purpose === 'PAYMENT_PROOF' ? cfg.fileMaxProofBytes : type === 'pdf' ? cfg.fileMaxPdfBytes : cfg.fileMaxImageBytes;
    if (!Number.isInteger(input.size) || input.size <= 0) throw new BadRequestException('Bad size');
    if (input.size > limit) throw new PayloadTooLargeException({ message: 'File too large', code: 'FILE_TOO_LARGE', limitBytes: limit });
    const chunkSize = input.size <= 64 * 1024 * 1024 ? cfg.fileChunkBytes : Math.min(16 * 1024 * 1024, Math.max(cfg.fileBigChunkBytes, Math.ceil(input.size / 10000)));

    await this.sweepPending(actor.id);
    // Disk himoyasi: bo'sh joy chegaradan past bo'lsa hech qanday yangi yuklash qabul qilinmaydi
    const disk = await this.storage.diskStats?.();
    if (disk && disk.freeBytes - input.size < cfg.diskMinFreeBytes) throw new HttpException({ message: 'The server is low on disk space. Try again later.', code: 'DISK_LOW' }, 503);
    const used = await this.usedBytes(actor.id);
    let quota = cfg.fileUserQuotaBytes;
    if (input.purpose === 'CLASS_FILE' && actor.role === 'TEACHER') {
      const tp = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id }, select: { storageQuotaMb: true } });
      quota = tp?.storageQuotaMb ? tp.storageQuotaMb * 1024 * 1024 : cfg.teacherStorageQuotaBytes;
    }
    if (used + input.size > quota) {
      throw new HttpException({ message: 'Storage quota exceeded', code: 'QUOTA_EXCEEDED', usedBytes: used, quotaBytes: quota }, 413);
    }
    const file = await this.prisma.storedFile.create({
      data: {
        ownerId: actor.id, purpose: input.purpose, originalName: input.name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file',
        mime: anyKind ? safeMime(input.mime) : input.mime, declaredSize: input.size, storageKey: newKey(), chunkSize,
      },
    });
    return this.uploadInfo(actor, file);
  }

  private uploadInfo(actor: Actor, file: StoredFile) {
    const cfg = marketConfig();
    const exp = Math.floor(this.clock.now().getTime() / 1000) + cfg.uploadUrlTtlSeconds;
    const chunkCount = Math.ceil(file.declaredSize / file.chunkSize);
    const parts = Array.from({ length: chunkCount }, (_, i) => {
      const p: SignedParams = { op: 'put', fileId: file.id, part: String(i), uid: actor.id, exp };
      return { index: i, url: `/files/upload/${file.id}/${i}?${signedQuery(this.secret(), p)}` };
    });
    return { fileId: file.id, chunkSize: file.chunkSize, chunkCount, expiresAt: new Date(exp * 1000), parts };
  }

  /** Qaysi bo'laklar yetib borgani (davom ettirish uchun) + yangi imzolangan URL'lar */
  async resume(actor: Actor, fileId: string) {
    const file = await this.ownFile(actor, fileId);
    if (file.status !== 'PENDING_UPLOAD') throw new ConflictException('Upload is not pending');
    const present = await this.receivedChunks(file);
    const info = this.uploadInfo(actor, file);
    return { ...info, received: present, parts: info.parts.filter((p) => !present.includes(p.index)) };
  }

  private async receivedChunks(file: StoredFile): Promise<number[]> {
    const names = await this.storage.list(`${file.storageKey}/parts`);
    return names.map((n) => Number(n.split('/').pop())).filter(Number.isInteger).sort((a, b) => a - b);
  }

  /** Imzolangan PUT: bitta bo'lak. Autentifikatsiya = imzo (presigned URL kabi). */
  async putChunk(fileId: string, index: number, uid: string, exp: number, sig: string, body: Buffer) {
    const p: SignedParams = { op: 'put', fileId, part: String(index), uid, exp };
    if (!verifySignature(this.secret(), p, sig, this.clock.now().getTime())) throw new ForbiddenException('Bad or expired signature');
    const file = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: uid, status: 'PENDING_UPLOAD' } });
    if (!file) throw new NotFoundException('Not found');
    const chunkCount = Math.ceil(file.declaredSize / file.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) throw new BadRequestException('Bad chunk index');
    const expected = index === chunkCount - 1 ? file.declaredSize - file.chunkSize * (chunkCount - 1) : file.chunkSize;
    if (!Buffer.isBuffer(body) || body.length !== expected) throw new BadRequestException({ message: 'Bad chunk size', expected });
    await this.storage.put(`${file.storageKey}/parts/${index}`, body);
    return { received: index };
  }

  async cancel(actor: Actor, fileId: string) {
    const file = await this.ownFile(actor, fileId);
    if (file.status !== 'PENDING_UPLOAD') throw new ConflictException('Upload is not pending');
    await this.storage.deletePrefix(file.storageKey);
    await this.prisma.storedFile.update({ where: { id: file.id }, data: { status: 'REJECTED', rejectReason: 'cancelled', deletedAt: this.clock.now() } });
    return { ok: true };
  }

  /** Bo'laklarni yig'ib, turini baytlar bo'yicha tekshiradi, skanerlaydi, rasmni qayta kodlaydi (EXIF yo'q), eskiz yaratadi. */
  async complete(actor: Actor, fileId: string) {
    const file = await this.ownFile(actor, fileId);
    if (file.status !== 'PENDING_UPLOAD') throw new ConflictException('Upload is not pending');
    const chunkCount = Math.ceil(file.declaredSize / file.chunkSize);
    const present = await this.receivedChunks(file);
    const missing = Array.from({ length: chunkCount }, (_, i) => i).filter((i) => !present.includes(i));
    if (missing.length) throw new ConflictException({ message: 'Chunks missing', missing });

    if (!ALLOWED_DECLARED_MIME[file.mime ?? '']) return this.completeAny(actor, file, chunkCount);

    const parts: Buffer[] = [];
    for (let i = 0; i < chunkCount; i++) parts.push(await this.storage.get(`${file.storageKey}/parts/${i}`));
    const raw = Buffer.concat(parts);
    if (raw.length !== file.declaredSize) return this.reject(file, 'size_mismatch');

    const type = detectType(raw);
    if (!type) return this.reject(file, 'type_not_allowed');
    if (MIME_BY_TYPE[type] !== file.mime) return this.reject(file, 'mime_mismatch');

    const cfg = marketConfig();
    const scan = await this.scanner.scan(raw).catch(() => ({ status: 'ERROR' as const }));
    if (scan.status === 'INFECTED') return this.reject(file, 'malware_detected', 'INFECTED', 'QUARANTINED');
    if ((scan.status === 'ERROR' || scan.status === 'SKIPPED') && cfg.fileScanRequired) return this.reject(file, 'scan_unavailable', 'ERROR', 'QUARANTINED');

    let finalData: Buffer;
    let finalMime: string;
    let width: number | undefined;
    let height: number | undefined;
    let pageCount: number | undefined;
    let thumbKey: string | undefined;
    try {
      if (type === 'pdf') {
        const chk = checkPdf(raw);
        if (!chk.ok) return this.reject(file, chk.reason!);
        finalData = raw;
        finalMime = MIME_BY_TYPE.pdf;
        pageCount = chk.pageCount;
      } else {
        const img = await processImage(raw, type);
        finalData = img.data;
        finalMime = img.mime;
        width = img.width;
        height = img.height;
        thumbKey = `${file.storageKey}/thumb`;
        await this.storage.put(thumbKey, img.thumb);
      }
    } catch (e) {
      if (e instanceof ProcessingError) return this.reject(file, e.code);
      throw e;
    }
    await this.storage.put(`${file.storageKey}/blob`, finalData);
    await this.storage.deletePrefix(`${file.storageKey}/parts`);
    const updated = await this.prisma.storedFile.update({
      where: { id: file.id },
      data: {
        status: 'READY', sizeBytes: finalData.length, finalMime, sha256: createHash('sha256').update(finalData).digest('hex'),
        width, height, pageCount, thumbKey, completedAt: this.clock.now(),
        scanStatus: scan.status === 'CLEAN' ? 'CLEAN' : scan.status === 'ERROR' ? 'ERROR' : 'NOT_SCANNED',
      },
    });
    await this.audit.log(actor, { action: 'file.ready', targetType: 'StoredFile', targetId: file.id, metadata: { purpose: file.purpose, bytes: finalData.length, scan: scan.status } });
    return this.view(updated);
  }

  /** Ixtiyoriy tur: bo'laklar xotiraga yuklanmasdan diskda ulanadi. Hech qachon inline ko'rsatilmaydi (yuklab olinadi), skaner talab qilinsa — rad etiladi. */
  private async completeAny(actor: Actor, file: StoredFile, chunkCount: number) {
    if (marketConfig().fileScanRequired) return this.reject(file, 'scan_unavailable', 'ERROR', 'QUARANTINED');
    const keys = Array.from({ length: chunkCount }, (_, i) => `${file.storageKey}/parts/${i}`);
    const { size, sha256 } = await this.storage.concat(keys, `${file.storageKey}/blob`);
    await this.storage.deletePrefix(`${file.storageKey}/parts`);
    if (size !== file.declaredSize) { await this.storage.delete(`${file.storageKey}/blob`); return this.reject(file, 'size_mismatch'); }
    const updated = await this.prisma.storedFile.update({
      where: { id: file.id },
      data: { status: 'READY', sizeBytes: size, finalMime: file.mime, sha256, completedAt: this.clock.now(), scanStatus: 'NOT_SCANNED' },
    });
    await this.audit.log(actor, { action: 'file.ready', targetType: 'StoredFile', targetId: file.id, metadata: { purpose: file.purpose, bytes: size, kind: 'any' } });
    return this.view(updated);
  }

  private async reject(file: StoredFile, reason: string, scan: 'INFECTED' | 'ERROR' | null = null, status: 'REJECTED' | 'QUARANTINED' = 'REJECTED'): Promise<never> {
    await this.storage.deletePrefix(file.storageKey);
    await this.prisma.storedFile.update({
      where: { id: file.id },
      data: { status, rejectReason: reason, ...(scan ? { scanStatus: scan } : {}), deletedAt: this.clock.now() },
    });
    await this.audit.log('SYSTEM', { action: 'file.rejected', targetType: 'StoredFile', targetId: file.id, metadata: { reason, status } });
    throw new HttpException({ message: 'File rejected', code: reason.toUpperCase() }, 422);
  }

  // ---------- yuklab olish ----------

  /** Aktorning faylni o'qishga haqqi bormi: egasi; xabar ilovasi bo'lsa — suhbat ishtirokchilari (+ voyaga yetmagan o'quvchining vasiysi). */
  async canRead(actor: Actor, file: StoredFile): Promise<boolean> {
    if (file.deletedAt || file.status !== 'READY') return false;
    if (file.ownerId === actor.id) return true;
    if (file.purpose === 'MESSAGE_ATTACHMENT') {
      const m = await this.prisma.chatMessage.findUnique({ where: { fileId: file.id }, include: { thread: true } });
      if (!m) return this.canReadChannelFile(actor, file);
      if (m.deletedAt) return false;
      if (m.thread.teacherUserId === actor.id || m.thread.studentUserId === actor.id) return true;
      if (actor.role === 'GUARDIAN' && (await this.guardians.isActiveGuardianOf(actor.id, m.thread.studentUserId))) return true;
    }
    if (file.purpose === 'HOMEWORK') {
      // Uy vazifasi fayli: topshirgan (egasi), sinf o'qituvchisi va o'quvchining bog'langan vasiylari
      const sub = await this.prisma.classHomeworkSubmission.findFirst({ where: { fileId: file.id }, include: { homework: { include: { } } } });
      if (!sub) return false;
      const cls = await this.prisma.class.findUnique({ where: { id: sub.homework.classId }, select: { teacher: { select: { userId: true } } } });
      if (cls?.teacher.userId === actor.id) return true;
      return actor.role === 'GUARDIAN' && (await this.guardians.isActiveGuardianOf(actor.id, sub.pupilId));
    }
    if (file.purpose === 'CLASS_FILE') {
      // Sinf PDF'ini asl holida faqat o'qituvchi (egasi) yoki, agar o'qituvchi ruxsat bergan bo'lsa, sinf a'zolari yuklab oladi
      const cf = await this.prisma.classFile.findFirst({ where: { fileId: file.id, deletedAt: null, takedownAt: null, allowDownload: true }, select: { classId: true } });
      if (!cf) return false;
      if ((await this.prisma.class.findUnique({ where: { id: cf.classId }, select: { protectContent: true } }))?.protectContent) return false; // himoyalangan sinf: faqat o'qituvchi (egasi) yuklab oladi
      const seats = actor.role === 'GUARDIAN' ? await this.guardians.linkedStudentIds(actor.id) : [actor.id];
      return !!(await this.prisma.classEnrollment.findFirst({ where: { classId: cf.classId, pupilId: { in: seats }, status: 'ACTIVE' }, select: { id: true } }));
    }
    if (file.purpose === 'PAYMENT_PROOF') {
      // Kvitansiya: faqat to'lov egasi (yuklagan), o'qituvchi, o'quvchi/bronlovchi va o'quvchining vasiysi ko'radi (admin - alohida audit qilinadigan yo'l)
      const dp = await this.prisma.directPayment.findFirst({ where: { proofFileId: file.id }, include: { booking: { include: { teacher: { select: { userId: true } } } } } });
      if (!dp) return false;
      const b = dp.booking;
      if ([b.teacher.userId, b.studentId, b.bookedById].includes(actor.id)) return true;
      if (actor.role === 'GUARDIAN' && (await this.guardians.isActiveGuardianOf(actor.id, b.studentId))) return true;
    }
    return false;
  }

  /** Sinf kanaliga yuborilgan fayl: sinf o'qituvchisi va faol a'zolar ko'radi. */
  private async canReadChannelFile(actor: Actor, file: StoredFile): Promise<boolean> {
    const post = await this.prisma.classChannelPost.findUnique({ where: { fileId: file.id } });
    if (!post || post.deletedAt) return false;
    const c = await this.prisma.class.findUnique({ where: { id: post.classId }, select: { teacher: { select: { userId: true } } } });
    if (c?.teacher.userId === actor.id) return true;
    // Himoyalangan sinfda a'zolar kanaldagi rasmlarni ko'ra oladi, boshqa fayllarni (PDF va h.k.) yuklab ololmaydi
    if ((await this.prisma.class.findUnique({ where: { id: post.classId }, select: { protectContent: true } }))?.protectContent && !(file.finalMime ?? '').startsWith('image/')) return false;
    return !!(await this.prisma.classEnrollment.findFirst({ where: { classId: post.classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } }));
  }

  /** A signed address for a file whose access the CALLER already checked (for example class membership for a recorded lesson). The address lives `ttlSeconds` so a long video can be sought through. */
  async signedGet(actor: Actor, fileId: string, ttlSeconds: number) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt || file.status !== 'READY') throw new NotFoundException('Not found');
    const exp = Math.floor(this.clock.now().getTime() / 1000) + ttlSeconds;
    const p: SignedParams = { op: 'get', fileId, part: 'original', uid: actor.id, exp };
    const base = this.config.get<string>('FILES_PUBLIC_BASE_URL') || '';
    return { url: `${base}/files/blob/${fileId}/original?${signedQuery(this.secret(), p)}`, expiresAt: new Date(exp * 1000) };
  }

  async downloadUrl(actor: Actor, fileId: string, variant: 'original' | 'thumb', adminOverride = false) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    const allowed = file && (adminOverride ? !file.deletedAt && file.status === 'READY' && (file.purpose === 'CREDENTIAL' || file.purpose === 'PAYMENT_PROOF') : await this.canRead(actor, file));
    if (!file || !allowed) throw new NotFoundException('Not found');
    if (variant === 'thumb' && !file.thumbKey) throw new NotFoundException('No thumbnail');
    const exp = Math.floor(this.clock.now().getTime() / 1000) + marketConfig().downloadUrlTtlSeconds;
    const p: SignedParams = { op: 'get', fileId, part: variant, uid: actor.id, exp };
    if (adminOverride) await this.audit.log(actor, { action: 'file.admin_download', targetType: 'StoredFile', targetId: fileId });
    const base = this.config.get<string>('FILES_PUBLIC_BASE_URL') || '';
    return { url: `${base}/files/blob/${fileId}/${variant}?${signedQuery(this.secret(), p)}`, expiresAt: new Date(exp * 1000) };
  }

  /** Fayl oqimi (Range uchun). */
  stream(key: string, range?: { start: number; end: number }) { return this.storage.stream(key, range); }

  /** Imzolangan GET. Javob sarlavhalari: har doim yuklab olish (inline emas), nosniff, sandbox CSP. */
  async serve(fileId: string, variant: string, uid: string, exp: number, sig: string) {
    const p: SignedParams = { op: 'get', fileId, part: variant, uid, exp };
    if (!verifySignature(this.secret(), p, sig, this.clock.now().getTime())) throw new ForbiddenException('Bad or expired signature');
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt || file.status !== 'READY') throw new NotFoundException('Not found');
    const user = await this.prisma.user.findUnique({ where: { id: uid }, select: { status: true } });
    const admin = user ? null : await this.prisma.admin.findUnique({ where: { id: uid }, select: { id: true } });
    if (!(user && user.status === 'ACTIVE') && !admin) throw new ForbiddenException('Forbidden');
    // Saqlashda bayt yo'q bo'lsa (o'chirilgan/yo'qolgan) 500 emas, 404
    const read = (key: string) => this.storage.get(key).catch(() => { throw new NotFoundException('Not found'); });
    if (variant === 'thumb') {
      if (!file.thumbKey) throw new NotFoundException('No thumbnail');
      const data = await read(file.thumbKey);
      return { data, size: data.length, mime: 'image/webp', name: 'thumb.webp' };
    }
    if (variant !== 'original') throw new NotFoundException('Not found');
    const key = `${file.storageKey}/blob`;
    const size = await this.storage.size(key).catch(() => { throw new NotFoundException('Not found'); });
    return { key, size, mime: file.finalMime ?? 'application/octet-stream', name: file.originalName };
  }

  // ---------- boshqaruv ----------

  async get(actor: Actor, fileId: string) {
    return this.view(await this.ownFile(actor, fileId, true));
  }

  async remove(actor: Actor, fileId: string) {
    const file = await this.ownFile(actor, fileId);
    const used = await this.prisma.chatMessage.count({ where: { fileId } }) + (await this.prisma.teacherCredential.count({ where: { fileId } }));
    if (used > 0) throw new ConflictException('File is in use');
    await this.storage.deletePrefix(file.storageKey);
    await this.prisma.storedFile.update({ where: { id: file.id }, data: { deletedAt: this.clock.now() } });
    return { ok: true };
  }

  /** Akkaunt o'chirilganda: egasining barcha fayllari (saqlash joyidan ham) o'chiriladi. */
  async purgeOwnerFiles(ownerId: string): Promise<number> {
    const rows = await this.prisma.storedFile.findMany({ where: { ownerId, deletedAt: null } });
    for (const f of rows) {
      await this.storage.deletePrefix(f.storageKey).catch((e) => this.log.warn(e.message));
      await this.prisma.storedFile.update({ where: { id: f.id }, data: { deletedAt: this.clock.now(), thumbKey: null } });
    }
    return rows.length;
  }

  /** Profil surati eskizi (imzosiz ichki o'qish: chaqiruvchi ruxsatni tekshirgan bo'lishi shart). */
  async readThumb(file: StoredFile): Promise<Buffer> {
    if (!file.thumbKey) throw new NotFoundException('No thumbnail');
    return this.storage.get(file.thumbKey);
  }

  async quota(actor: Actor) {
    return { usedBytes: await this.usedBytes(actor.id), quotaBytes: marketConfig().fileUserQuotaBytes };
  }

  private async usedBytes(userId: string): Promise<number> {
    const rows = await this.prisma.storedFile.findMany({ where: { ownerId: userId, deletedAt: null, status: { in: ['PENDING_UPLOAD', 'READY'] } }, select: { sizeBytes: true, declaredSize: true, status: true } });
    return rows.reduce((n, r) => n + (r.status === 'READY' ? r.sizeBytes : r.declaredSize), 0);
  }

  /** Yarim qolgan yuklashlarni tozalaydi (kvotani band qilib turmasligi uchun). */
  async sweepPending(userId?: string): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - marketConfig().pendingUploadMaxAgeHours * 3_600_000);
    const stale = await this.prisma.storedFile.findMany({ where: { status: 'PENDING_UPLOAD', createdAt: { lt: cutoff }, ...(userId ? { ownerId: userId } : {}) } });
    for (const f of stale) {
      await this.storage.deletePrefix(f.storageKey).catch((e) => this.log.warn(e.message));
      await this.prisma.storedFile.update({ where: { id: f.id }, data: { status: 'REJECTED', rejectReason: 'expired', deletedAt: this.clock.now() } });
    }
    return stale.length;
  }

  private async ownFile(actor: Actor, fileId: string, includeAny = false): Promise<StoredFile> {
    const f = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: actor.id, ...(includeAny ? {} : { deletedAt: null }) } });
    if (!f) throw new NotFoundException('Not found'); // boshqaning faylini ham, yo'q faylni ham bir xil javob
    return f;
  }

  private view(f: StoredFile) {
    return {
      id: f.id, purpose: f.purpose, name: f.originalName, status: f.status, mime: f.finalMime ?? f.mime, sizeBytes: f.sizeBytes || f.declaredSize,
      width: f.width, height: f.height, pageCount: f.pageCount, hasThumb: !!f.thumbKey, scanStatus: f.scanStatus, rejectReason: f.rejectReason,
    };
  }

  /** Xabar ilovasi uchun: faylning ommaviy ko'rinishi (hech qanday storage kaliti yo'q) */
  publicView(f: StoredFile) {
    return this.view(f);
  }
}

export { createScanProvider };
