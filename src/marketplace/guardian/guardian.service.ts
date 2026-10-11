import { Injectable } from '@nestjs/common';
import { GuardianLinkStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class GuardianService {
  constructor(private prisma: PrismaService) {}

  async isActiveGuardianOf(guardianId: string, studentId: string): Promise<boolean> {
    const link = await this.prisma.guardianLink.findUnique({ where: { guardianId_studentId: { guardianId, studentId } } });
    return link?.status === GuardianLinkStatus.ACTIVE;
  }

  async linkedStudentIds(guardianId: string): Promise<string[]> {
    const links = await this.prisma.guardianLink.findMany({ where: { guardianId, status: GuardianLinkStatus.ACTIVE }, select: { studentId: true } });
    return links.map((l) => l.studentId);
  }

  async guardianIdsOf(studentId: string): Promise<string[]> {
    const links = await this.prisma.guardianLink.findMany({ where: { studentId, status: GuardianLinkStatus.ACTIVE }, select: { guardianId: true } });
    return links.map((l) => l.guardianId);
  }
}
