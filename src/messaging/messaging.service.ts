import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MessagingService {
  constructor(private prisma: PrismaService) {}

  async getOrCreateDm(userAId: string, userBId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: 'DM',
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
    });
    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        type: 'DM',
        participants: { create: [{ userId: userAId }, { userId: userBId }] },
      },
    });
  }
  async assertParticipant(conversationId: string, userId: string) {
    const p = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!p) throw new Error('NOT_A_PARTICIPANT');
  }

  createGroup(creatorId: string, name: string, memberIds: string[]) {
    const allIds = [...new Set([creatorId, ...memberIds])];
    return this.prisma.conversation.create({
      data: {
        type: 'GROUP',
        name,
        participants: { create: allIds.map((userId) => ({ userId })) },
      },
    });
  }

  getMyConversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: {
        participants: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  createMessage(data: { conversationId: string; senderId: string; type?: string; content?: string; mediaUrl?: string }) {
    return this.prisma.message.create({
      data: {
        conversationId: data.conversationId,
        senderId: data.senderId,
        type: (data.type as any) ?? 'TEXT',
        content: data.content,
        mediaUrl: data.mediaUrl,
      },
    });
  }

  getMessages(conversationId: string, cursor?: string, take = 30) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}