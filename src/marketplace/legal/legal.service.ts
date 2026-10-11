import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConsentKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { CURRENT_VERSIONS, LEGAL_TEXTS, LegalDoc, LegalLocale } from './texts';

export function termsRequired(): boolean {
  return process.env.REQUIRE_TERMS !== 'false';
}

@Injectable()
export class LegalService {
  constructor(private prisma: PrismaService, private audit: AuditService, private clock: ClockService) {}

  document(kind: 'terms' | 'privacy', locale: string): LegalDoc & { version: string } {
    const l: LegalLocale = locale === 'ru' || locale === 'en' ? locale : 'uz';
    const doc = LEGAL_TEXTS[kind][l];
    return { ...doc, version: CURRENT_VERSIONS[kind === 'terms' ? 'TERMS' : 'PRIVACY'] };
  }

  /** Foydalanuvchi joriy shartlar versiyasini qabul qilganmi. */
  async hasAccepted(userId: string, kind: ConsentKind = 'TERMS'): Promise<boolean> {
    const version = CURRENT_VERSIONS[kind as 'TERMS' | 'PRIVACY'];
    if (!version) return false;
    const c = await this.prisma.consent.findFirst({ where: { userId, kind, version, withdrawnAt: null } });
    return !!c;
  }

  /** Muhim amallardan oldin (bron, xabar, o'qituvchi sifatida yuborish) chaqiriladi. */
  async assertTerms(actor: Actor) {
    if (!termsRequired() || actor.kind === 'admin') return;
    if (!(await this.hasAccepted(actor.id, 'TERMS'))) throw new ForbiddenException({ message: 'You must accept the current Terms first', code: 'TERMS_REQUIRED', version: CURRENT_VERSIONS.TERMS });
  }

  async accept(actor: Actor, kind: ConsentKind, version: string, locale: string) {
    const current = CURRENT_VERSIONS[kind as 'TERMS' | 'PRIVACY' | 'GUARDIAN_STATEMENT'];
    if (kind === 'MARKETING') {
      // Marketing roziligi versiyasiz, istalgan paytda qaytarib olinadi
    } else if (!current || version !== current) throw new BadRequestException({ message: 'Unknown or outdated version', code: 'VERSION_MISMATCH', current });
    const c = await this.prisma.consent.upsert({
      where: { userId_kind_version: { userId: actor.id, kind, version } },
      update: { withdrawnAt: null },
      create: { userId: actor.id, kind, version, locale, acceptedAt: this.clock.now() },
    });
    await this.audit.log(actor, { action: 'consent.accept', targetType: 'Consent', targetId: c.id, metadata: { kind, version } });
    return { kind, version, acceptedAt: c.acceptedAt };
  }

  async withdraw(actor: Actor, kind: ConsentKind) {
    if (kind === 'TERMS' || kind === 'PRIVACY') throw new BadRequestException('Terms/privacy cannot be withdrawn; delete your account instead');
    await this.prisma.consent.updateMany({ where: { userId: actor.id, kind, withdrawnAt: null }, data: { withdrawnAt: this.clock.now() } });
    await this.audit.log(actor, { action: 'consent.withdraw', metadata: { kind } });
    return { ok: true };
  }

  async mine(actor: Actor) {
    const rows = await this.prisma.consent.findMany({ where: { userId: actor.id }, orderBy: { acceptedAt: 'desc' } });
    return { current: CURRENT_VERSIONS, items: rows.map((c) => ({ kind: c.kind, version: c.version, acceptedAt: c.acceptedAt, withdrawnAt: c.withdrawnAt })) };
  }
}
