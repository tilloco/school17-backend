import { Controller, Post, Get, Param, Query, Req, UseGuards, Body } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // ← still need you to confirm this path

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(private messagingService: MessagingService) {}

  @Post('dm/:otherUserId')
  startDm(@Req() req: any, @Param('otherUserId') otherUserId: string) {
    return this.messagingService.getOrCreateDm(req.user.userId, otherUserId);
  }
  @Post('group')
  createGroup(@Req() req: any, @Body() body: { name: string; memberIds: string[] }) {
    return this.messagingService.createGroup(req.user.userId, body.name, body.memberIds);
  }

  @Get()
  getMyConversations(@Req() req: any) {
    return this.messagingService.getMyConversations(req.user.userId);
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.messagingService.getMessages(id, cursor);
  }
}