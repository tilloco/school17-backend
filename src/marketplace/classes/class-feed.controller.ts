import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassFeedService } from './class-feed.service';

class NoteDto {
  @IsOptional() @IsString() @MaxLength(300) topic?: string;
  @IsOptional() @IsString() @MaxLength(1200) homework?: string;
  @IsOptional() @IsString() @MaxLength(600) nextStep?: string;
}
class LateAnswerDto { @IsString() @MaxLength(1600) text!: string; }
class HomeworkDto {
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(4200) text?: string;
  @IsISO8601() dueAt!: string;
}
class SubmitDto {
  @IsOptional() @IsString() @MaxLength(4200) text?: string;
  @IsOptional() @IsUUID() fileId?: string;
  @IsOptional() @IsUUID() studentId?: string;
}
class MarkDto {
  @IsInt() @Min(0) @Max(100) score!: number;
  @IsOptional() @IsString() @MaxLength(1200) comment?: string;
}

@Controller()
@UseGuards(UserActorGuard)
export class ClassFeedController {
  constructor(private feed: ClassFeedService) {}

  @Get('classes/:id/feed') @RequirePermission('class.read')
  list(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('before') before?: string) { return this.feed.feed(a, id, before); }

  @Get('class-sessions/:sid/recap') @RequirePermission('class.read')
  recap(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.feed.recap(a, sid); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('class-sessions/:sid/note') @RequirePermission('class.manage')
  note(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: NoteDto) { return this.feed.putNote(a, sid, dto); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('class-sessions/:sid/questions/:qid/late-answer') @HttpCode(201) @RequirePermission('class.manage')
  lateAnswer(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('qid', ParseUUIDPipe) qid: string, @Body() dto: LateAnswerDto) { return this.feed.lateAnswer(a, sid, qid, dto.text); }

  @Get('classes/:id/attendance/mine') @RequirePermission('class.read')
  attendance(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('take') take?: string) { return this.feed.attendanceMine(a, id, Number(take) || 30); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('classes/:id/homework') @HttpCode(201) @RequirePermission('class.manage')
  create(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HomeworkDto) { return this.feed.createHomework(a, id, dto); }

  @Get('classes/:id/homework') @RequirePermission('class.read')
  homeworkList(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.feed.listHomework(a, id); }

  @Get('classes/:id/homework/:hid') @RequirePermission('class.read')
  homework(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('hid', ParseUUIDPipe) hid: string) { return this.feed.homework(a, id, hid); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('classes/:id/homework/:hid/submit') @HttpCode(200) @RequirePermission('class.join')
  submit(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('hid', ParseUUIDPipe) hid: string, @Body() dto: SubmitDto) { return this.feed.submit(a, id, hid, dto); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('classes/:id/homework/:hid/submissions/:pid/mark') @HttpCode(200) @RequirePermission('class.manage')
  mark(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('hid', ParseUUIDPipe) hid: string, @Param('pid', ParseUUIDPipe) pid: string, @Body() dto: MarkDto) { return this.feed.mark(a, id, hid, pid, dto); }
}
