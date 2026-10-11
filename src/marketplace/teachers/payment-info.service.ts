import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { cryptoAvailable, decryptField, encryptField } from '../common/data-crypto';
import { GuardianService } from '../guardian/guardian.service';
import { formatCard, normalizeCardNumber, normalizeHolderName } from './card';

/** Qabul qilingan bron holatlari: o'quvchi to'lashi kerak bo'lgan darslar (so'rov/rad/bekor/muddati o'tgan emas). */
export const REVEAL_BOOKING_STATUSES = ['CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT'] as const;

@Injectable()
export class PaymentInfoService {
  constructor(private prisma: PrismaService, private audit: AuditService, private guardians: GuardianService) {}

  private requireCrypto() {
    if (!cryptoAvailable()) {
      throw new ServiceUnavailableException({ message: 'Card details are switched off: APP_DATA_KEY is not configured on the server', code: 'CARD_FEATURE_DISABLED' });
    }
  }

  private async ownProfileId(actor: Actor): Promise<string> {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
    const p = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id }, select: { id: true } });
    if (!p) throw new NotFoundException('Profile not found');
    return p.id;
  }

  async set(actor: Actor, cardNumber: string, holderName: string) {
    this.requireCrypto();
    const teacherId = await this.ownProfileId(actor);
    const digits = normalizeCardNumber(cardNumber);
    if (!digits) throw new BadRequestException({ message: 'Enter a valid 16-digit card number', code: 'INVALID_CARD_NUMBER' });
    const name = normalizeHolderName(holderName);
    if (!name) throw new BadRequestException({ message: 'Holder name must be 2-40 letters', code: 'INVALID_HOLDER_NAME' });
    const data = { cardNumberEnc: encryptField(digits), cardLast4: digits.slice(-4), holderName: name };
    await this.prisma.teacherPaymentInfo.upsert({ where: { teacherId }, update: data, create: { teacherId, ...data } });
    await this.audit.log(actor, { action: 'payment_info.set', targetType: 'TeacherProfile', targetId: teacherId }); // raqam jurnalga yozilmaydi
    return { set: true, cardLast4: data.cardLast4, holderName: name };
  }

  async getOwn(actor: Actor) {
    const teacherId = await this.ownProfileId(actor);
    const p = await this.prisma.teacherPaymentInfo.findUnique({ where: { teacherId } });
    return p ? { set: true, cardLast4: p.cardLast4, holderName: p.holderName } : { set: false };
  }

  async remove(actor: Actor) {
    const teacherId = await this.ownProfileId(actor);
    await this.prisma.teacherPaymentInfo.deleteMany({ where: { teacherId } });
    await this.audit.log(actor, { action: 'payment_info.remove', targetType: 'TeacherProfile', targetId: teacherId });
    return { set: false };
  }

  /**
   * To'liq raqam FAQAT shu o'qituvchi bilan QABUL QILINGAN, sinov bo'lmagan darsi bor o'quvchiga yoki uning bog'langan vasiysiga ko'rsatiladi.
   * Har ko'rsatish audit jurnaliga yoziladi (raqamsiz).
   */
  async reveal(actor: Actor, profileId: string) {
    this.requireCrypto();
    if (actor.role !== Role.STUDENT && actor.role !== Role.GUARDIAN) throw new ForbiddenException('Forbidden');
    const linked = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : [];
    const eligible = await this.prisma.booking.findFirst({
      where: {
        teacherId: profileId, isTrial: false, status: { in: [...REVEAL_BOOKING_STATUSES] },
        OR: [{ studentId: actor.id }, { bookedById: actor.id }, ...(linked.length ? [{ studentId: { in: linked } }] : [])],
      },
      select: { id: true },
    });
    if (!eligible) throw new ForbiddenException({ message: 'Card details are shown after the teacher accepts your lesson', code: 'NOT_ELIGIBLE' });
    const p = await this.prisma.teacherPaymentInfo.findUnique({ where: { teacherId: profileId } });
    if (!p) throw new NotFoundException({ message: 'The teacher has not added card details', code: 'NO_PAYMENT_INFO' });
    let digits: string;
    try {
      digits = decryptField(p.cardNumberEnc);
    } catch {
      throw new ConflictException({ message: 'Card details cannot be read; ask the teacher to enter them again', code: 'PAYMENT_INFO_UNREADABLE' });
    }
    await this.audit.log(actor, { action: 'payment_info.reveal', targetType: 'TeacherProfile', targetId: profileId, metadata: { bookingId: eligible.id } });
    return { cardNumber: formatCard(digits), holderName: p.holderName };
  }

  async hasInfo(profileId: string): Promise<boolean> {
    return (await this.prisma.teacherPaymentInfo.count({ where: { teacherId: profileId } })) > 0;
  }
}
