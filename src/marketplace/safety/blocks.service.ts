import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { GuardianService } from '../guardian/guardian.service';

@Injectable()
export class BlocksService {
  constructor(private prisma: PrismaService, private guardians: GuardianService, private audit: AuditService) {}

  /** Foydalanuvchi + uning faol vasiylari (vasiy bloklasa bola uchun ham amal qiladi). */
  private async side(userId: string): Promise<string[]> {
    return [userId, ...(await this.guardians.guardianIdsOf(userId))];
  }

  /** a va b o'rtasida istalgan yo'nalishda blok bormi (vasiylar hisobga olinadi). */
  async isBlockedBetween(a: string, b: string): Promise<boolean> {
    const [sa, sb] = await Promise.all([this.side(a), this.side(b)]);
    const n = await this.prisma.userBlock.count({
      where: { OR: [{ blockerId: { in: sa }, blockedId: b }, { blockerId: { in: sb }, blockedId: a }] },
    });
    return n > 0;
  }

  async assertNotBlocked(a: string, b: string) {
    if (await this.isBlockedBetween(a, b)) throw new ForbiddenException({ message: 'Blocked', code: 'BLOCKED' });
  }

  /** Qidiruvda yashiriladigan foydalanuvchilar: men (yoki vasiyim) bloklaganlar va meni bloklaganlar. */
  async hiddenUserIds(actorId: string): Promise<string[]> {
    const mine = await this.side(actorId);
    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: { in: mine } }, { blockedId: actorId }] },
      select: { blockerId: true, blockedId: true },
    });
    const ids = new Set<string>();
    for (const r of rows) {
      if (mine.includes(r.blockerId)) ids.add(r.blockedId);
      if (r.blockedId === actorId) ids.add(r.blockerId);
    }
    return [...ids];
  }

  async blockUser(actor: Actor, targetUserId: string, context: string) {
    if (targetUserId === actor.id) throw new ConflictException('Cannot block yourself');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { name: true, role: true } });
    if (!target) throw new NotFoundException('Not found');
    const b = await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: actor.id, blockedId: targetUserId } },
      update: {},
      create: { blockerId: actor.id, blockedId: targetUserId },
    });
    await this.audit.log(actor, { action: 'user.block', targetType: 'User', targetId: targetUserId, metadata: { context } });
    return { id: b.id, name: target.name };
  }

  async unblock(actor: Actor, blockId: string) {
    const r = await this.prisma.userBlock.deleteMany({ where: { id: blockId, blockerId: actor.id } });
    if (r.count === 0) throw new NotFoundException('Not found');
    await this.audit.log(actor, { action: 'user.unblock', targetType: 'UserBlock', targetId: blockId });
    return { ok: true };
  }

  async list(actor: Actor) {
    const rows = await this.prisma.userBlock.findMany({ where: { blockerId: actor.id }, orderBy: { createdAt: 'desc' }, include: { blocked: { select: { name: true } } }, take: 200 });
    return rows.map((r) => ({ id: r.id, name: r.blocked.name, createdAt: r.createdAt }));
  }
}
