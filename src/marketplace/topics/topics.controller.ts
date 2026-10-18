import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { TopicsService } from './topics.service';

class VideoDto {
  @IsString() @MaxLength(300) url!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(5) lang!: string;
}
class AnswerDto {
  @IsString() @MaxLength(80) id!: string;
  @IsInt() @Min(-1) @Max(10) choice!: number;
}
class SubmitDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[];
}
class ListQuery {
  @IsOptional() @IsString() @MaxLength(40) subject?: string;
  @IsOptional() @IsString() @MaxLength(40) level?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

@Controller('topics')
@UseGuards(UserActorGuard)
export class TopicsController {
  constructor(private topics: TopicsService) {}

  @Get() @RequirePermission('booking.participate')
  list(@CurrentActor() a: Actor, @Query() q: ListQuery) { return this.topics.list(a, q); }

  // fixed paths first, so ":slug" never swallows them
  @Delete('videos/:id') @RequirePermission('teacher.profile.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.topics.removeVideo(a, id); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('videos/:id/vote') @HttpCode(200) @RequirePermission('booking.participate')
  vote(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.topics.vote(a, id); }

  @Get(':slug') @RequirePermission('booking.participate')
  detail(@CurrentActor() a: Actor, @Param('slug') slug: string) { return this.topics.detail(a, slug); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':slug/videos') @HttpCode(201) @RequirePermission('teacher.profile.manage')
  add(@CurrentActor() a: Actor, @Param('slug') slug: string, @Body() dto: VideoDto) { return this.topics.addVideo(a, slug, dto); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':slug/quiz') @RequirePermission('booking.participate')
  quiz(@CurrentActor() a: Actor, @Param('slug') slug: string) { return this.topics.quiz(a, slug); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':slug/quiz') @HttpCode(200) @RequirePermission('booking.participate')
  submit(@CurrentActor() a: Actor, @Param('slug') slug: string, @Body() dto: SubmitDto) { return this.topics.submit(a, slug, dto.answers); }
}

@Controller('admin/market/topics')
@UseGuards(AdminActorGuard)
export class TopicsAdminController {
  constructor(private topics: TopicsService) {}

  @Post('videos/:id/hide') @HttpCode(200) @RequirePermission('moderation.review')
  hide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.topics.setHidden(a, id, true); }

  @Post('videos/:id/restore') @HttpCode(200) @RequirePermission('moderation.review')
  restore(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.topics.setHidden(a, id, false); }
}
