import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MessagingService } from './messaging.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/messaging' })
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private messagingService: MessagingService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      const payload = this.jwtService.verify(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect() {}
   @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; type?: string; content?: string; mediaUrl?: string },
  ) {
    try {
      await this.messagingService.assertParticipant(data.conversationId, client.data.userId);
    } catch {
      client.emit('error', 'NOT_A_PARTICIPANT');
      return;
    }

    const message = await this.messagingService.createMessage({
      conversationId: data.conversationId,
      senderId: client.data.userId,
      type: data.type,
      content: data.content,
      mediaUrl: data.mediaUrl,
    });

    this.server.to(`conversation:${data.conversationId}`).emit('message:new', message);
    return message;
  }
}