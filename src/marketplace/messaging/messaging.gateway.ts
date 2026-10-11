import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * Real vaqt kanali (socket.io). Faqat server -> mijoz hodisalari ('message', 'receipt').
 * Ulanish tokenni (handshake.auth.token) tekshiradi va foydalanuvchini FAQAT o'z xonasiga ("user:<id>") qo'shadi;
 * mijoz xohlagan xonaga qo'shila olmaydi. Yuborish REST orqali (rate limit, tekshiruvlar bir joyda).
 */
@WebSocketGateway({ cors: { origin: origins.length ? origins : false }, path: '/socket.io' })
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server!: Server;

  constructor(private jwt: JwtService, private prisma: PrismaService, private realtime: RealtimeService) {}

  afterInit(server: Server) {
    this.realtime.server = server;
  }

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth as any)?.token;
      if (typeof token !== 'string') throw new Error('no token');
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') throw new Error('inactive');
      await client.join(`user:${payload.sub}`);
      client.data.userId = payload.sub;
    } catch {
      client.disconnect(true);
    }
  }
}
