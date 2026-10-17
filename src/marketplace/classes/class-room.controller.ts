import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { Actor } from '../common/actor';
import { CurrentActor, RequirePermission, UserActorGuard } from '../common/actor.guard';
import { ClassRoomService } from './class-room.service';

class HandDto { @IsBoolean() raised!: boolean; }
class GrantDto { @IsUUID() pupilId!: string; @IsIn(['VOICE', 'VOICE_VIDEO']) mode!: 'VOICE' | 'VOICE_VIDEO'; }
class PupilDto { @IsUUID() pupilId!: string; }
class SpotlightDto { @IsOptional() @IsUUID() pupilId?: string | null; }
class LockDto { @IsBoolean() locked!: boolean; }
class StageModeDto { @IsIn(['LISTEN_ONLY', 'HAND_RAISE', 'OPEN_STAGE']) mode!: 'LISTEN_ONLY' | 'HAND_RAISE' | 'OPEN_STAGE'; }

@Controller('class-sessions/:sid')
@UseGuards(UserActorGuard)
export class ClassRoomController {
  constructor(private room: ClassRoomService) {}

  @Get() @RequirePermission('class.read')
  state(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.state(a, sid); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('start') @HttpCode(200) @RequirePermission('class.manage')
  start(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.start(a, sid).then((r) => this.room.notify(sid, r)); }

  @Post('end') @HttpCode(200) @RequirePermission('class.manage')
  end(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.end(a, sid).then((r) => this.room.notify(sid, r)); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('token') @HttpCode(200) @RequirePermission('class.read')
  token(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.token(a, sid); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('hand') @HttpCode(200) @RequirePermission('class.join')
  hand(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: HandDto) { return this.room.hand(a, sid, dto.raised).then((r) => this.room.notify(sid, r)); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('stage/take') @HttpCode(200) @RequirePermission('class.join')
  take(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.takeStage(a, sid).then((r) => this.room.notify(sid, r)); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('stage/leave') @HttpCode(200) @RequirePermission('class.join')
  leave(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.stepDown(a, sid); }

  @Post('stage/grant') @HttpCode(200) @RequirePermission('class.manage')
  grant(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: GrantDto) { return this.room.grant(a, sid, dto.pupilId, dto.mode).then((r) => this.room.notify(sid, r)); }

  @Post('stage/revoke') @HttpCode(200) @RequirePermission('class.manage')
  revoke(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: PupilDto) { return this.room.revoke(a, sid, dto.pupilId).then((r) => this.room.notify(sid, r)); }

  @Post('stage/mode') @HttpCode(200) @RequirePermission('class.manage')
  mode(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: StageModeDto) { return this.room.setStageMode(a, sid, dto.mode); }

  @Post('mute-all') @HttpCode(200) @RequirePermission('class.manage')
  muteAll(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.muteAll(a, sid).then((r) => this.room.notify(sid, r)); }

  @Post('mute') @HttpCode(200) @RequirePermission('class.manage')
  mute(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: PupilDto) { return this.room.mute(a, sid, dto.pupilId).then((r) => this.room.notify(sid, r)); }

  @Post('spotlight') @HttpCode(200) @RequirePermission('class.manage')
  spotlight(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: SpotlightDto) { return this.room.spotlight(a, sid, dto.pupilId ?? null).then((r) => this.room.notify(sid, r)); }

  @Post('remove') @HttpCode(200) @RequirePermission('class.manage')
  remove(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: PupilDto) { return this.room.removePupil(a, sid, dto.pupilId).then((r) => this.room.notify(sid, r)); }

  @Post('lock') @HttpCode(200) @RequirePermission('class.manage')
  lock(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string, @Body() dto: LockDto) { return this.room.lock(a, sid, dto.locked).then((r) => this.room.notify(sid, r)); }

  @Get('audience') @RequirePermission('class.read')
  audience(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.audience(a, sid); }

  @Get('roster') @RequirePermission('class.manage')
  roster(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.roster(a, sid); }

  @Get('attendance') @RequirePermission('class.manage')
  attendance(@CurrentActor() a: Actor, @Param('sid', ParseUUIDPipe) sid: string) { return this.room.attendance(a, sid); }
}
