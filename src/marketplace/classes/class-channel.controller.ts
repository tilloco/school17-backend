import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassChannelService } from './class-channel.service';

class PostDto {
  @IsOptional() @IsString() @MaxLength(2500) body?: string;
  @IsOptional() @IsUUID() fileId?: string;
}

@Controller('classes/:id/channel')
@UseGuards(UserActorGuard)
export class ClassChannelController {
  constructor(private channel: ClassChannelService) {}

  @Get() @RequirePermission('class.read')
  list(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('before') before?: string, @Query('after') after?: string) {
    return this.channel.list(a, id, { before: Number(before) || undefined, after: Number(after) || undefined });
  }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post() @HttpCode(201) @RequirePermission('class.read')
  post(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDto) { return this.channel.post(a, id, dto); }

  @Get('pins') @RequirePermission('class.read')
  pins(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.channel.pins(a, id); }

  @Get('info') @RequirePermission('class.read')
  info(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.channel.info(a, id); }

  @Put(':pid/pin') @HttpCode(200) @RequirePermission('class.read')
  pin(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('pid', ParseUUIDPipe) pid: string) { return this.channel.pin(a, id, pid, true); }

  @Delete(':pid/pin') @RequirePermission('class.read')
  unpin(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('pid', ParseUUIDPipe) pid: string) { return this.channel.pin(a, id, pid, false); }

  @Delete(':pid') @RequirePermission('class.read')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('pid', ParseUUIDPipe) pid: string) { return this.channel.remove(a, id, pid); }
}
