import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/** Gateway serverini saqlaydi; servislar socket.io'ni bilmasdan foydalanuvchiga hodisa yuboradi. */
@Injectable()
export class RealtimeService {
  server?: Server;

  emitToUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
