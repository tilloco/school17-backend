import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from './actor';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /token|secret|password|authorization|key/i;

/** Metadata ichidagi maxfiy ko'rinishdagi kalitlarni jurnalga yozmaslik uchun tozalaydi. */
export function scrubMetadata(meta: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : (v as Prisma.InputJsonValue);
  }
  return out;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  log(actor: Actor | 'SYSTEM', entry: AuditEntry) {
    const system = actor === 'SYSTEM';
    return this.prisma.auditLog.create({
      data: {
        actorType: system ? AuditActorType.SYSTEM : actor.kind === 'admin' ? AuditActorType.ADMIN : AuditActorType.USER,
        actorId: system ? null : actor.id,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: scrubMetadata(entry.metadata),
      },
    });
  }
}
