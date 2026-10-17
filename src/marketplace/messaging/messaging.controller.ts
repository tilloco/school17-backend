import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, IsArray, IsInt, Matches, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ReportReason } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { ReportsService } from '../moderation/reports.service';
import { MessagingService } from './messaging.service';
import { DirectService } from './direct.service';

class ThreadReportDto {
  @IsEnum(ReportReason) reason!: ReportReason;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class OpenDto {
  @IsUUID() bookingId!: string;
}
class DirectDto {
  @IsUUID() userId!: string;
}
class SendDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsUUID() fileId?: string;
}
class SeqDto {
  @IsInt() @Min(0) @Max(2_000_000_000) upToSeq!: number;
}

class ContactHashesDto {
  @IsArray() @ArrayMaxSize(3000) @IsString({ each: true }) @Matches(/^[0-9a-f]{64}$/, { each: true }) hashes!: string[];
}

@Controller('threads')
@UseGuards(UserActorGuard)
export class MessagingController {
  constructor(private messaging: MessagingService, private reports: ReportsService, private direct: DirectService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/report') @HttpCode(201) @RequirePermission('report.create')
  reportUser(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ThreadReportDto) { return this.reports.createFromThread(a, id, dto); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/messages/:messageId/report') @HttpCode(201) @RequirePermission('report.create')
  reportMessage(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('messageId', ParseUUIDPipe) mid: string, @Body() dto: ThreadReportDto) { return this.reports.createFromThread(a, id, { ...dto, messageId: mid }); }

  @Post() @HttpCode(200) @RequirePermission('message.send')
  open(@CurrentActor() a: Actor, @Body() dto: OpenDto) { return this.messaging.openFromBooking(a, dto.bookingId); }

  /** Bron bo'lmasa ham: sinfdosh / o'qituvchi (darrov) yoki @nom bilan topilgan kattalar (so'rov). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('direct') @HttpCode(200) @RequirePermission('message.send')
  openDirect(@CurrentActor() a: Actor, @Body() dto: DirectDto) { return this.direct.open(a, dto.userId); }

  @Get('people') @RequirePermission('message.send')
  people(@CurrentActor() a: Actor, @Query('q') q?: string) { return this.direct.search(a, q ?? ''); }

  /** Telefon kontaktlaridagi tanishlar: mijoz raqamlarning SHA-256 xeshlarini yuboradi; server hech narsani saqlamaydi. */
  @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  @Post('people-from-contacts') @HttpCode(200) @RequirePermission('message.send')
  fromContacts(@CurrentActor() a: Actor, @Body() dto: ContactHashesDto) { return this.direct.fromContacts(a, dto.hashes); }

  @Get('contacts') @RequirePermission('message.send')
  contacts(@CurrentActor() a: Actor) { return this.direct.contacts(a); }

  @Post(':id/accept') @HttpCode(200) @RequirePermission('message.send')
  accept(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.messaging.answerRequest(a, id, true); }

  @Post(':id/decline') @HttpCode(200) @RequirePermission('message.send')
  decline(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.messaging.answerRequest(a, id, false); }

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
