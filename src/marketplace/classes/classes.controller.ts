import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassesService } from './classes.service';

class ClassDto {
  @IsString() @MinLength(2) @MaxLength(100) title!: string;
  @IsString() @MinLength(2) @MaxLength(60) subject!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsInt() capacity!: number;
  @IsOptional() @IsInt() priceMinor?: number;
  @IsOptional() @IsIn(['PER_SESSION', 'MONTHLY']) priceModel?: 'PER_SESSION' | 'MONTHLY';
  @IsOptional() @IsArray() @IsInt({ each: true }) weekdays?: number[];
  @IsOptional() @IsInt() startMinute?: number;
  @IsOptional() @IsInt() durationMin?: number;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsISO8601() startDate?: string;
  @IsOptional() @IsISO8601() endDate?: string;
  @IsOptional() @IsISO8601() oneOffStartAt?: string;
  @IsOptional() @IsIn(['LISTEN_ONLY', 'HAND_RAISE', 'OPEN_STAGE']) stageMode?: 'LISTEN_ONLY' | 'HAND_RAISE' | 'OPEN_STAGE';
  @IsOptional() @IsIn(['OPEN', 'QUESTIONS_ONLY', 'OFF']) chatMode?: 'OPEN' | 'QUESTIONS_ONLY' | 'OFF';
  @IsOptional() @IsIn(['OPEN', 'OFF']) questionsMode?: 'OPEN' | 'OFF';
  @IsOptional() @IsBoolean() allowDownload?: boolean;
  @IsOptional() @IsBoolean() requirePaidToJoin?: boolean;
  @IsOptional() @IsBoolean() firstSessionTrial?: boolean;
}
class UpdateClassDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) title?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) subject?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
  @IsOptional() @IsInt() priceMinor?: number;
  @IsOptional() @IsIn(['PER_SESSION', 'MONTHLY']) priceModel?: 'PER_SESSION' | 'MONTHLY';
  @IsOptional() @IsIn(['LISTEN_ONLY', 'HAND_RAISE', 'OPEN_STAGE']) stageMode?: 'LISTEN_ONLY' | 'HAND_RAISE' | 'OPEN_STAGE';
  @IsOptional() @IsIn(['OPEN', 'QUESTIONS_ONLY', 'OFF']) chatMode?: 'OPEN' | 'QUESTIONS_ONLY' | 'OFF';
  @IsOptional() @IsIn(['OPEN', 'OFF']) questionsMode?: 'OPEN' | 'OFF';
  @IsOptional() @IsInt() @Min(0) @Max(600) slowModeSeconds?: number;
  @IsOptional() @IsBoolean() handRaiseOn?: boolean;
  @IsOptional() @IsBoolean() allowDownload?: boolean;
  @IsOptional() @IsBoolean() requirePaidToJoin?: boolean;
  @IsOptional() @IsBoolean() firstSessionTrial?: boolean;
}
class JoinDto {
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  @IsOptional() @IsString() @MaxLength(64) token?: string;
  @IsOptional() @IsUUID() studentId?: string;
}
class LeaveDto {
  @IsOptional() @IsUUID() studentId?: string;
}

@Controller('classes')
@UseGuards(UserActorGuard)
export class ClassesController {
  constructor(private classes: ClassesService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post() @RequirePermission('class.manage')
  create(@CurrentActor() a: Actor, @Body() dto: ClassDto) { return this.classes.create(a, dto); }

  @Get('mine') @RequirePermission('class.read')
  mine(@CurrentActor() a: Actor) { return this.classes.mine(a); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('join') @HttpCode(200) @RequirePermission('class.join')
  join(@CurrentActor() a: Actor, @Body() dto: JoinDto) { return this.classes.join(a, dto); }

  @Get(':id') @RequirePermission('class.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.classes.get(a, id); }

  @Patch(':id') @RequirePermission('class.manage')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClassDto) { return this.classes.update(a, id, dto); }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission('class.manage')
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.classes.cancel(a, id); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/regenerate-code') @HttpCode(200) @RequirePermission('class.manage')
  regenerate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.classes.regenerateCode(a, id); }

  @Get(':id/sessions') @RequirePermission('class.read')
  sessions(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.classes.sessions(a, id, from, to); }

  @Post(':id/sessions/:sessionId/cancel') @HttpCode(200) @RequirePermission('class.manage')
  cancelSession(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('sessionId', ParseUUIDPipe) sid: string) { return this.classes.cancelSession(a, id, sid); }

  @Delete(':id/pupils/:pupilId') @RequirePermission('class.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('pupilId', ParseUUIDPipe) pid: string) { return this.classes.removePupil(a, id, pid); }

  @Post(':id/leave') @HttpCode(200) @RequirePermission('class.join')
  leave(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveDto) { return this.classes.leave(a, id, dto.studentId); }
}
