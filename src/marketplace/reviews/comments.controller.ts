import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { CommentsService } from './comments.service';

class CommentDto { @IsString() @MaxLength(600) text!: string; }

@Controller('teachers/:id/comments')
@UseGuards(UserActorGuard)
export class CommentsController {
  constructor(private comments: CommentsService) {}

  @Get() @RequirePermission('booking.participate')
  list(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('page') page?: string) { return this.comments.list(a, id, Number(page) || 1); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post() @HttpCode(201) @RequirePermission('booking.participate')
  write(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) { return this.comments.write(a, id, dto.text); }

  @Delete('mine') @RequirePermission('booking.participate')
  removeMine(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.comments.removeMine(a, id); }
}
