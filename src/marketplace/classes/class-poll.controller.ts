import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassPollService } from './class-poll.service';

class OpenDto {
  @IsString() @MaxLength(300) question!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(150, { each: true }) options!: string[];
}
class VoteDto { @IsInt() @Min(0) @Max(5) option!: number; }

@Controller('class-sessions/:sid/polls')
@UseGuards(UserActorGuard)
export class ClassPollController {
  constructor(private polls: ClassPollService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post() @HttpCode(201) @RequirePermission('class.manage')
  open(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: OpenDto) { return this.polls.open(a, sid, dto.question, dto.options); }

  @Get('current') @RequirePermission('class.read')
  current(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.polls.current(a, sid); }

  @Get() @RequirePermission('class.read')
  list(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.polls.list(a, sid); }

  @Post(':pid/close') @HttpCode(200) @RequirePermission('class.manage')
  close(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('pid', ParseUUIDPipe) pid: string) { return this.polls.close(a, sid, pid); }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post(':pid/vote') @HttpCode(200) @RequirePermission('class.join')
  vote(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Param('pid', ParseUUIDPipe) pid: string, @Body() dto: VoteDto) { return this.polls.vote(a, sid, pid, dto.option); }
}
