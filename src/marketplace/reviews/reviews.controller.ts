import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor } from '../common/actor';
import { AdminActorGuard, CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { AccountService } from '../account/account.service';
import { ReportsService } from '../moderation/reports.service';
import { ReviewsService } from './reviews.service';

class CreateReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
}
class UpdateReviewDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
}
class ReplyDto {
  @IsString() @MaxLength(1000) text!: string;
}
class ReportDto {
  @IsEnum(ReportReason) reason!: ReportReason;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class ResolveDto {
  @IsIn(['ACTION', 'DISMISS']) action!: 'ACTION' | 'DISMISS';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class HideDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller()
@UseGuards(UserActorGuard)
export class ReviewsController {
  constructor(private reviews: ReviewsService, private reports: ReportsService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bookings/:bookingId/review') @RequirePermission('review.create')
  create(@CurrentActor() a: Actor, @Param('bookingId', ParseUUIDPipe) id: string, @Body() dto: CreateReviewDto) { return this.reviews.create(a, id, dto); }

  @Get('classes/:classId/review') @RequirePermission('review.create')
  classReview(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) classId: string) { return this.reviews.classReviewState(a, classId); }

  @Post('classes/:classId/review') @RequirePermission('review.create')
  createClassReview(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) classId: string, @Body() dto: CreateReviewDto) { return this.reviews.createForClass(a, classId, dto); }

  @Put('reviews/:id') @RequirePermission('review.create')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReviewDto) { return this.reviews.update(a, id, dto); }

  @Put('reviews/:id/reply') @RequirePermission('review.reply')
  reply(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto) { return this.reviews.reply(a, id, dto.text); }

  @Get('reviews/mine') @RequirePermission('review.create')
  mine(@CurrentActor() a: Actor) { return this.reviews.mine(a); }

  @Get('reviews/pending') @RequirePermission('review.create')
  pending(@CurrentActor() a: Actor) { return this.reviews.pending(a); }

  @Get('teachers/:id/reviews') @RequirePermission('booking.participate')
  list(@Param('id', ParseUUIDPipe) id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.reviews.listForTeacher(id, Number(page) || 1, Number(pageSize) || 20);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reviews/:id/report') @HttpCode(201) @RequirePermission('report.create')
  report(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto) {
    return this.reports.create(a, { targetType: ReportTargetType.REVIEW, targetId: id, reason: dto.reason, note: dto.note });
  }
}

@Controller('admin/market')
@UseGuards(AdminActorGuard)
export class ModerationAdminController {
  constructor(private reports: ReportsService, private reviews: ReviewsService, private account: AccountService) {}

  @Get('users') @RequirePermission('moderation.review')
  users(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string, @Query('skip') skip = '0', @Query('take') take = '20') {
    return this.account.adminSearchUsers({ text: q, role, status, skip: Number(skip) || 0, take: Number(take) || 20 });
  }

  @Get('reports') @RequirePermission('moderation.review')
  queue(@Query('status') status?: string, @Query('targetType') type?: string, @Query('skip') skip = '0', @Query('take') take = '30') {
    return this.reports.queue(
      status && status in ReportStatus ? (status as ReportStatus) : 'OPEN',
      type && type in ReportTargetType ? (type as ReportTargetType) : undefined,
      Math.max(0, Number(skip) || 0), Number(take) || 30,
    );
  }

  @Post('reports/:id/resolve') @HttpCode(200) @RequirePermission('moderation.review')
  resolve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDto) { return this.reports.resolve(a, id, dto.action, dto.note); }

  @Post('users/:id/suspend') @HttpCode(200) @RequirePermission('moderation.review')
  suspend(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HideDto) { return this.reports.setUserSuspended(a, id, true, dto.reason ?? 'admin'); }

  @Post('users/:id/reinstate') @HttpCode(200) @RequirePermission('moderation.review')
  reinstate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.setUserSuspended(a, id, false, 'reinstated'); }

  @Post('reviews/:id/hide') @HttpCode(200) @RequirePermission('moderation.review')
  async hide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HideDto) { await this.reviews.setHidden(a, id, true, dto.reason); return { ok: true }; }

  @Post('reviews/:id/restore') @HttpCode(200) @RequirePermission('moderation.review')
  async restore(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { await this.reviews.setHidden(a, id, false); return { ok: true }; }
}
