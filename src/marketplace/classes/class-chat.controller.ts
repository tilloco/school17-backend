import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ReportReason } from '@prisma/client';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassChatService } from './class-chat.service';

class MessageDto { @IsString() @MaxLength(600) body!: string; }
class QuestionDto { @IsString() @MaxLength(600) text!: string; @IsOptional() @IsBoolean() anonymous?: boolean; }
class ReplyDto { @IsOptional() @IsString() @MaxLength(1200) reply?: string; }
class PinDto { @IsBoolean() pinned!: boolean; }
class SettingsDto {
  @IsOptional() @IsIn(['OPEN', 'QUESTIONS_ONLY', 'OFF']) chatMode?: 'OPEN' | 'QUESTIONS_ONLY' | 'OFF';
  @IsOptional() @IsIn(['OPEN', 'OFF']) questionsMode?: 'OPEN' | 'OFF';
  @IsOptional() @IsInt() @Min(0) @Max(600) slowModeSeconds?: number;
  @IsOptional() @IsBoolean() handRaiseOn?: boolean;
}
class MuteDto { @IsUUID() pupilId!: string; @IsInt() @Min(1) @Max(240) minutes!: number; }
class ReportDto { @IsEnum(ReportReason) reason!: ReportReason; @IsOptional() @IsString() @MaxLength(1000) note?: string; @IsOptional() @IsUUID() pupilId?: string; }

@Controller('class-sessions/:sid')
@UseGuards(UserActorGuard)
export class ClassChatController {
  constructor(private chat: ClassChatService) {}

  @Get('messages') @RequirePermission('class.read')
  messages(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Query('after') after?: string) { return this.chat.messages(a, sid, Number(after) || undefined); }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('messages') @HttpCode(201) @RequirePermission('class.read')
  send(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: MessageDto) { return this.chat.send(a, sid, dto.body); }

  @Delete('messages/:mid') @RequirePermission('class.manage')
  del(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('mid', ParseUUIDPipe) mid: string) { return this.chat.deleteMessage(a, sid, mid); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('messages/:mid/report') @HttpCode(201) @RequirePermission('report.create')
  reportMessage(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('mid', ParseUUIDPipe) mid: string, @Body() dto: ReportDto) { return this.chat.reportMessage(a, sid, mid, dto.reason, dto.note); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('report-pupil') @HttpCode(201) @RequirePermission('report.create')
  reportPupil(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: ReportDto & { pupilId: string }) { return this.chat.reportPupil(a, sid, dto.pupilId, dto.reason, dto.note); }

  @Get('questions') @RequirePermission('class.read')
  questions(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.chat.questions(a, sid); }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('questions') @HttpCode(201) @RequirePermission('class.join')
  ask(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: QuestionDto) { return this.chat.ask(a, sid, dto.text, !!dto.anonymous); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('questions/:qid/upvote') @HttpCode(200) @RequirePermission('class.join')
  upvote(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string) { return this.chat.upvote(a, sid, qid); }

  @Post('questions/:qid/answer') @HttpCode(200) @RequirePermission('class.manage')
  answer(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string, @Body() dto: ReplyDto) { return this.chat.answer(a, sid, qid, dto.reply); }

  @Post('questions/:qid/later') @HttpCode(200) @RequirePermission('class.manage')
  later(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string) { return this.chat.setStatus(a, sid, qid, 'LATER'); }

  @Post('questions/:qid/hide') @HttpCode(200) @RequirePermission('class.manage')
  hide(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string) { return this.chat.setStatus(a, sid, qid, 'HIDDEN'); }

  @Post('questions/:qid/pin') @HttpCode(200) @RequirePermission('class.manage')
  pin(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string, @Body() dto: PinDto) { return this.chat.pin(a, sid, qid, dto.pinned); }

  @Post('questions/:qid/call') @HttpCode(200) @RequirePermission('class.manage')
  call(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string) { return this.chat.callOn(a, sid, qid); }

  @Post('settings') @HttpCode(200) @RequirePermission('class.manage')
  settings(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: SettingsDto) { return this.chat.settings(a, sid, dto); }

  @Post('mute-chat') @HttpCode(200) @RequirePermission('class.manage')
  muteChat(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: MuteDto) { return this.chat.mutePupil(a, sid, dto.pupilId, dto.minutes); }
}
