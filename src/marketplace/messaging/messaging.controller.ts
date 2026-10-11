import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { MessagingService } from './messaging.service';

class OpenDto {
  @IsUUID() bookingId!: string;
}
class SendDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsUUID() fileId?: string;
}
class SeqDto {
  @IsInt() @Min(0) @Max(2_000_000_000) upToSeq!: number;
}

@Controller('threads')
@UseGuards(UserActorGuard)
export class MessagingController {
  constructor(private messaging: MessagingService) {}

  @Post() @HttpCode(200) @RequirePermission('message.send')
  open(@CurrentActor() a: Actor, @Body() dto: OpenDto) { return this.messaging.openFromBooking(a, dto.bookingId); }

  @Get() @RequirePermission('message.send')
  list(@CurrentActor() a: Actor) { return this.messaging.list(a); }

  @Get('unread-count') @RequirePermission('message.send')
  async unread(@CurrentActor() a: Actor) { return { unread: await this.messaging.unreadTotal(a) }; }

  @Get(':id/messages') @RequirePermission('message.send')
  messages(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('beforeSeq') before?: string, @Query('afterSeq') after?: string, @Query('limit') limit?: string) {
    return this.messaging.messages(a, id, { beforeSeq: before ? Number(before) : undefined, afterSeq: after ? Number(after) : undefined, limit: limit ? Number(limit) : undefined });
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/messages') @RequirePermission('message.send')
  send(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendDto) { return this.messaging.send(a, id, dto); }

  @Post(':id/delivered') @HttpCode(200) @RequirePermission('message.send')
  delivered(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SeqDto) { return this.messaging.markDelivered(a, id, dto.upToSeq); }

  @Post(':id/read') @HttpCode(200) @RequirePermission('message.send')
  read(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SeqDto) { return this.messaging.markRead(a, id, dto.upToSeq); }
}
