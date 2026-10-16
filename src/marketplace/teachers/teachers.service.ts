import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { LegalService } from '../legal/legal.service';
import { AuditService } from '../common/audit.service';
import { isLanguage, isLevel, isSubject } from '../catalog';
import { marketConfig } from '../common/config';
import { AvailabilityError, formatHHMM, RuleInput, validateRules } from './availability';
import { isAllowedIntroVideoUrl, missingForSubmission, nextStatus, VerificationEvent } from './verification';

export interface ProfileInput {
  headline?: string;
  bio?: string;
  subjects?: string[];
  levels?: string[];
  languages?: string[];
  priceMinor?: number;
  introVideoUrl?: string | null;
  instantBooking?: boolean;
  paymentTiming?: 'PAY_BEFORE' | 'PAY_AFTER';
}

const uniq = (a: string[]) => Array.from(new Set(a));

@Injectable()
export class TeachersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private legal: LegalService) {}

  // ---------- o'qituvchi (egasi) ----------

  private async ownProfileOrThrow(actor: Actor) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
    const p = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id } });
    if (!p) throw new NotFoundException('Profile not found');
    return p;
  }

  async getOwn(actor: Actor) {
    const p = await this.ownProfileOrThrow(actor);
    return this.ownerView(p.id);
  }

  async upsertProfile(actor: Actor, input: ProfileInput) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
    const cfg = marketConfig();
    const data: Prisma.TeacherProfileUpdateInput = {};
    if (input.headline !== undefined) data.headline = input.headline.trim();
    if (input.bio !== undefined) data.bio = input.bio.trim();
    if (input.subjects !== undefined) {
      const s = uniq(input.subjects);
      if (!s.every(isSubject)) throw new BadRequestException('Unknown subject');
      data.subjects = s;
    }
    if (input.levels !== undefined) {
      const s = uniq(input.levels);
      if (!s.every(isLevel)) throw new BadRequestException('Unknown level');
      data.levels = s;
    }
    if (input.languages !== undefined) {
      const s = uniq(input.languages);
      if (!s.every(isLanguage)) throw new BadRequestException('Unknown language');
      data.languages = s;
    }
    if (input.priceMinor !== undefined) {
      if (input.priceMinor < cfg.minPriceMinor || input.priceMinor > cfg.maxPriceMinor) throw new BadRequestException('Price out of range');
      data.priceMinor = input.priceMinor;
    }
    if (input.introVideoUrl !== undefined) {
      if (input.introVideoUrl !== null && !isAllowedIntroVideoUrl(input.introVideoUrl)) throw new BadRequestException('Intro video URL not allowed');
      data.introVideoUrl = input.introVideoUrl;
    }
    if (input.instantBooking !== undefined) data.instantBooking = input.instantBooking;
    if (input.paymentTiming !== undefined) data.paymentTiming = input.paymentTiming;

    const existing = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id } });
    const profile = existing
      ? await this.prisma.teacherProfile.update({ where: { id: existing.id }, data })
      : await this.prisma.teacherProfile.create({
          data: {
            ...(data as Prisma.TeacherProfileCreateWithoutUserInput),
            subjects: (data.subjects as string[]) ?? [],
            levels: (data.levels as string[]) ?? [],
            languages: (data.languages as string[]) ?? [],
            ratingBayes: cfg.ratingPriorMean,
            user: { connect: { id: actor.id } },
          },
        });
    return this.ownerView(profile.id);
  }

  async setAvailability(actor: Actor, rules: RuleInput[]) {
    const p = await this.ownProfileOrThrow(actor);
    let parsed;
    try {
      parsed = validateRules(rules);
    } catch (e) {
      if (e instanceof AvailabilityError) throw new BadRequestException(e.message);
      throw e;
    }
    await this.prisma.$transaction([
      this.prisma.availabilityRule.deleteMany({ where: { teacherId: p.id } }),
      this.prisma.availabilityRule.createMany({ data: parsed.map((r) => ({ ...r, teacherId: p.id })) }),
    ]);
    return this.getAvailability(actor);
  }

  async getAvailability(actor: Actor) {
    const p = await this.ownProfileOrThrow(actor);
    const rows = await this.prisma.availabilityRule.findMany({
      where: { teacherId: p.id },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
    return rows.map((r) => ({ weekday: r.weekday, start: formatHHMM(r.startMinute), end: formatHHMM(r.endMinute) }));
  }

  async setPhoto(actor: Actor, fileId: string) {
    const p = await this.ownProfileOrThrow(actor);
    const f = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: actor.id, deletedAt: null } });
    if (!f) throw new NotFoundException('File not found'); // boshqa birovning faylini ulab bo'lmaydi
    if (f.purpose !== 'AVATAR') throw new BadRequestException('File has wrong purpose');
    if (f.status !== 'READY' || !f.thumbKey) throw new ConflictException('File is not a ready image');
    await this.prisma.teacherProfile.update({ where: { id: p.id }, data: { photoFileId: f.id } });
    return { hasPhoto: true };
  }

  async removePhoto(actor: Actor) {
    const p = await this.ownProfileOrThrow(actor);
    await this.prisma.teacherProfile.update({ where: { id: p.id }, data: { photoFileId: null } });
    return { hasPhoto: false };
  }

  /** Surat faylini qaytaradi: tasdiqlangan o'qituvchi (hamma ko'radi) yoki o'zi. Aks holda 404. */
  async photoFile(actor: Actor, profileId: string) {
    const p = await this.prisma.teacherProfile.findFirst({
      where: { id: profileId, photoFileId: { not: null }, OR: [{ userId: actor.id }, { verificationStatus: VerificationStatus.VERIFIED, user: { status: 'ACTIVE' } }] },
      select: { photoFileId: true },
    });
    if (!p?.photoFileId) throw new NotFoundException('Not found');
    const f = await this.prisma.storedFile.findFirst({ where: { id: p.photoFileId, deletedAt: null, status: 'READY' } });
    if (!f?.thumbKey) throw new NotFoundException('Not found');
    return f;
  }

  async addTimeOff(actor: Actor, startAt: Date, endAt: Date, reason?: string) {
    const p = await this.ownProfileOrThrow(actor);
    if (!(startAt < endAt)) throw new BadRequestException('Invalid range');
    if (endAt.getTime() - startAt.getTime() > 90 * 86_400_000) throw new BadRequestException('Range too long');
    return this.prisma.teacherTimeOff.create({ data: { teacherId: p.id, startAt, endAt, reason: reason?.slice(0, 200) } });
  }

  async removeTimeOff(actor: Actor, id: string) {
    const p = await this.ownProfileOrThrow(actor);
    const res = await this.prisma.teacherTimeOff.deleteMany({ where: { id, teacherId: p.id } });
    if (res.count === 0) throw new NotFoundException('Not found');
    return { ok: true };
  }

  async addCredential(actor: Actor, input: { kind: any; title: string; fileId: string }) {
    const p = await this.ownProfileOrThrow(actor);
    const file = await this.prisma.storedFile.findFirst({ where: { id: input.fileId, ownerId: actor.id } });
    // Boshqa birovning faylini ulab bo'lmaydi; mavjudligini ham oshkor qilmaymiz (404)
    if (!file) throw new NotFoundException('File not found');
    if (file.purpose !== 'CREDENTIAL') throw new BadRequestException('File has wrong purpose');
    if (file.status !== 'READY') throw new ConflictException('File is not ready (upload not finished or not scanned)');
    const count = await this.prisma.teacherCredential.count({ where: { teacherId: p.id } });
    if (count >= 10) throw new BadRequestException('Too many credentials');
    const cred = await this.prisma.teacherCredential.create({
      data: { teacherId: p.id, kind: input.kind, title: input.title.trim().slice(0, 120), fileId: file.id },
    });
    return this.credentialView(cred);
  }

  async listCredentials(actor: Actor) {
    const p = await this.ownProfileOrThrow(actor);
    const rows = await this.prisma.teacherCredential.findMany({ where: { teacherId: p.id }, orderBy: { createdAt: 'asc' } });
    return rows.map((c) => this.credentialView(c));
  }

  async removeCredential(actor: Actor, id: string) {
    const p = await this.ownProfileOrThrow(actor);
    const res = await this.prisma.teacherCredential.deleteMany({ where: { id, teacherId: p.id } });
    if (res.count === 0) throw new NotFoundException('Not found');
    return { ok: true };
  }

  async submit(actor: Actor) {
    await this.legal.assertTerms(actor);
    const p = await this.ownProfileOrThrow(actor);
    const [rules, creds] = await Promise.all([
      this.prisma.availabilityRule.count({ where: { teacherId: p.id } }),
      this.prisma.teacherCredential.count({ where: { teacherId: p.id } }),
    ]);
    const missing = missingForSubmission({ ...p, availabilityRules: rules, credentialCount: creds });
    if (missing.length) throw new BadRequestException({ message: 'Profile incomplete', missing });
    const next = nextStatus(p.verificationStatus, 'submit');
    if (!next) throw new ConflictException(`Cannot submit from ${p.verificationStatus}`);
    await this.prisma.teacherProfile.update({ where: { id: p.id }, data: { verificationStatus: next, submittedAt: new Date(), rejectionReason: null } });
    await this.audit.log(actor, { action: 'teacher.submit', targetType: 'TeacherProfile', targetId: p.id });
    return this.ownerView(p.id);
  }

  // ---------- ommaviy ko'rinish ----------

  /** Faqat VERIFIED profil ko'rinadi. Email, tug'ilgan sana, hujjat fayllari hech qachon chiqmaydi. */
  async publicProfile(profileId: string) {
    const p = await this.prisma.teacherProfile.findFirst({
      where: { id: profileId, verificationStatus: VerificationStatus.VERIFIED, user: { status: 'ACTIVE' } },
      include: { user: { select: { name: true, username: true, avatarUrl: true, timezone: true } }, credentials: { where: { status: 'APPROVED' } } },
    });
    if (!p) throw new NotFoundException('Not found');
    return {
      id: p.id,
      name: p.user.name,
      username: p.user.username,
      avatarUrl: p.user.avatarUrl,
      timezone: p.user.timezone,
      headline: p.headline,
      bio: p.bio,
      subjects: p.subjects,
      levels: p.levels,
      languages: p.languages,
      priceMinor: p.priceMinor,
      currency: p.currency,
      introVideoUrl: p.introVideoUrl,
      instantBooking: p.instantBooking,
      paymentTiming: p.paymentTiming,
      hasPhoto: !!p.photoFileId,
      // Karta raqami hech qachon ommaviy javobda yo'q; faqat "mavjud" belgisi (raqam dars qabul qilingandan keyin alohida ochiladi)
      paymentInfoAvailable: (await this.prisma.teacherPaymentInfo.count({ where: { teacherId: p.id } })) > 0,
      verified: true,
      rating: { count: p.ratingCount, average: p.ratingCount ? p.ratingSum / p.ratingCount : null, bayesian: p.ratingBayes },
      credentials: p.credentials.map((c) => ({ kind: c.kind, title: c.title })),
    };
  }

  // ---------- admin ----------

  async reviewQueue(status: VerificationStatus = VerificationStatus.PENDING, skip = 0, take = 20) {
    const rows = await this.prisma.teacherProfile.findMany({
      where: { verificationStatus: status },
      orderBy: { submittedAt: 'asc' },
      skip,
      take: Math.min(take, 100),
      include: { user: { select: { name: true } }, _count: { select: { credentials: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.user.name,
      headline: r.headline,
      submittedAt: r.submittedAt,
      status: r.verificationStatus,
      credentialCount: r._count.credentials,
    }));
  }

  async adminGet(profileId: string) {
    const exists = await this.prisma.teacherProfile.findUnique({ where: { id: profileId }, select: { id: true, user: { select: { name: true, email: true } } } });
    if (!exists) throw new NotFoundException('Not found');
    // Administrator hujjat fayl id'larini ham ko'radi (yuklab olish alohida, audit qilinadigan marshrut orqali)
    const files = await this.prisma.teacherCredential.findMany({ where: { teacherId: profileId }, select: { id: true, fileId: true } });
    const view = await this.ownerView(profileId);
    return { ...view, name: exists.user.name, email: exists.user.email, credentials: view.credentials.map((c) => ({ ...c, fileId: files.find((f) => f.id === c.id)?.fileId })) };
  }

  /** Bitta hujjatni alohida tasdiqlash/rad etish (o'qituvchi profilining umumiy holatiga tegmaydi). */
  async adminReviewCredential(actor: Actor, credentialId: string, approve: boolean, reason?: string) {
    if (actor.kind !== 'admin') throw new ForbiddenException('Forbidden');
    if (!approve && !reason?.trim()) throw new BadRequestException('Reason required');
    const c = await this.prisma.teacherCredential.findUnique({ where: { id: credentialId } });
    if (!c) throw new NotFoundException('Not found');
    const r = await this.prisma.teacherCredential.updateMany({
      where: { id: c.id, status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
      data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedAt: new Date(), reviewNote: approve ? null : reason!.trim().slice(0, 500) },
    });
    if (r.count === 0) throw new ConflictException('Cannot review');
    await this.audit.log(actor, { action: approve ? 'credential.approve' : 'credential.reject', targetType: 'TeacherCredential', targetId: c.id, metadata: { reason } });
    return { id: c.id, status: approve ? 'APPROVED' : 'REJECTED' };
  }

  async adminTransition(actor: Actor, profileId: string, event: VerificationEvent, reason?: string) {
    if (actor.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const p = await this.prisma.teacherProfile.findUnique({ where: { id: profileId } });
    if (!p) throw new NotFoundException('Not found');
    const next = nextStatus(p.verificationStatus, event);
    if (!next) throw new ConflictException(`Cannot ${event} from ${p.verificationStatus}`);
    if ((event === 'reject' || event === 'suspend') && !reason?.trim()) throw new BadRequestException('Reason required');
    await this.prisma.$transaction(async (tx) => {
      await tx.teacherProfile.update({
        where: { id: p.id },
        data: {
          verificationStatus: next,
          verifiedAt: next === 'VERIFIED' ? new Date() : p.verifiedAt,
          verifiedByAdminId: next === 'VERIFIED' ? actor.id : p.verifiedByAdminId,
          rejectionReason: event === 'reject' || event === 'suspend' ? reason!.trim().slice(0, 500) : null,
        },
      });
      if (event === 'approve') {
        await tx.teacherCredential.updateMany({ where: { teacherId: p.id, status: 'PENDING' }, data: { status: 'APPROVED', reviewedAt: new Date() } });
      }
      if (event === 'reject') {
        await tx.teacherCredential.updateMany({
          where: { teacherId: p.id, status: 'PENDING' },
          data: { status: 'REJECTED', reviewedAt: new Date(), reviewNote: reason!.trim().slice(0, 500) },
        });
      }
    });
    await this.audit.log(actor, { action: `teacher.${event}`, targetType: 'TeacherProfile', targetId: p.id, metadata: { from: p.verificationStatus, to: next, reason } });
    return this.ownerView(p.id);
  }

  // ---------- ichki ----------

  private credentialView(c: { id: string; kind: any; title: string; status: any; reviewNote: string | null; createdAt: Date }) {
    return { id: c.id, kind: c.kind, title: c.title, status: c.status, reviewNote: c.reviewNote, createdAt: c.createdAt };
  }

  private async ownerView(profileId: string) {
    const p = await this.prisma.teacherProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { credentials: { orderBy: { createdAt: 'asc' } }, availability: true, timeOff: { orderBy: { startAt: 'asc' } } },
    });
    return {
      id: p.id,
      userId: p.userId,
      headline: p.headline,
      bio: p.bio,
      subjects: p.subjects,
      levels: p.levels,
      languages: p.languages,
      priceMinor: p.priceMinor,
      currency: p.currency,
      introVideoUrl: p.introVideoUrl,
      instantBooking: p.instantBooking,
      paymentTiming: p.paymentTiming,
      hasPhoto: !!p.photoFileId,
      verificationStatus: p.verificationStatus,
      verifiedAt: p.verifiedAt,
      rejectionReason: p.rejectionReason,
      submittedAt: p.submittedAt,
      credentials: p.credentials.map((c) => this.credentialView(c)),
      availabilityRuleCount: p.availability.length,
      timeOff: p.timeOff.map((t) => ({ id: t.id, startAt: t.startAt, endAt: t.endAt, reason: t.reason })),
    };
  }
}
